// Helpers: independent oracles (JSON-RPC for server B, vpncmd for server A and the VPN Client), launching the
// real Electron app, native-dialog stubs, and UI conveniences shared by the specs.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Agent, request } from "undici";
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";
import { BUILD_DIR, CLIENT_DIR, DATA_DIR, ROOT, RUN_DIR, SCREENSHOTS, STATE_FILE, WIN } from "./env.ts";

const run = promisify(execFile);
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

// ------------------------------------------------------------------------------------------ oracles

/** JSON-RPC straight to a SoftEther server (bypasses the app). Throws with the SoftEther error. */
export async function seRpc(port: number, password: string, method: string, params: Record<string, unknown> = {}, hub = "") {
  const res = await request(`https://127.0.0.1:${port}/api/`, {
    method: "POST",
    dispatcher: insecure,
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
    headers: { authorization: `Basic ${Buffer.from(`${hub || "administrator"}:${password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  const text = await res.body.text();
  let json: { result?: Record<string, any>; error?: { code: number; message: string } };
  try { json = JSON.parse(text); } catch { throw new Error(`SoftEther ${method}: HTTP ${res.statusCode}, not JSON: ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(`SoftEther ${method} error ${json.error.code}: ${json.error.message}`);
  return json.result!;
}

const libEnv = { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." };

/** Runs vpncmd in CLIENT_DIR with stdin closed (a password prompt fails fast instead of hanging). */
function runVpncmd(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(WIN ? path.join(CLIENT_DIR, "vpncmd.exe") : "./vpncmd", args, { cwd: CLIENT_DIR, env: libEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    const t = setTimeout(() => p.kill("SIGKILL"), 30_000);
    // stdout only on success: callers parse it as CSV, and platform warnings on stderr (seen on macOS
    // runners) would otherwise count as rows. On failure stderr is appended for diagnostics.
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, out: code === 0 ? out : out + err }); });
  });
}

/**
 * vpncmd against a SoftEther VPN Server (native admin protocol: works when JSON-RPC is disabled).
 * vpncmd on macOS treats every argument that starts with "/" as a switch: pass file paths relative to CLIENT_DIR.
 */
export function vpncmd(port: number, password: string, hub: string, cmd: string[]) {
  // /ADMINHUB selects the hub after logging in as server administrator (/HUB would be a hub-admin login).
  return runVpncmd([`127.0.0.1:${port}`, "/SERVER", ...(hub ? [`/ADMINHUB:${hub}`] : []), `/PASSWORD:${password}`, "/CSV", "/CMD", ...cmd]);
}

/** vpncmd against the local SoftEther VPN Client (localhost:9931). */
export function vpncmdClient(...cmd: string[]) {
  return runVpncmd(["localhost", "/CLIENT", "/CSV", "/CMD", ...cmd]);
}

/** Parse vpncmd /CSV output into rows of cells (header row first). */
export function csv(out: string): string[][] {
  const rows: string[][] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/** "Item,Value" style vpncmd CSV output as a map. */
export function csvMap(out: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of csv(out)) if (r.length >= 2) m[r[0]] = r.slice(1).join(",");
  return m;
}

export async function sh(cmd: string, args: string[], cwd?: string) {
  const r = await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}

export interface MsiInfo { tables: string[]; properties: Record<string, string>; files: string[]; summary: string }

/**
 * Read an MSI's tables, Property table and file names. Linux/macOS: msitools (msiinfo, msiextract).
 * Windows: the Windows Installer COM object, since msitools is not available there.
 */
export async function inspectMsi(msi: string): Promise<MsiInfo> {
  if (!WIN) {
    const tables = (await sh("msiinfo", ["tables", msi])).split(/\s+/).filter(Boolean);
    const summary = await sh("msiinfo", ["suminfo", msi]);
    const props = await sh("msiinfo", ["export", msi, "Property"]);
    const properties = Object.fromEntries(props.split(/\r?\n/).slice(3).filter((l) => l.includes("\t")).map((l) => l.split("\t") as [string, string]));
    const files = (await sh("msiextract", ["--list", msi])).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\\/]/).pop()!);
    return { tables, properties, files, summary };
  }
  const script = path.join(RUN_DIR, "inspect-msi.ps1");
  writeFileSync(script, `param([string]$Path)
$ErrorActionPreference = 'Stop'
$i = New-Object -ComObject WindowsInstaller.Installer
$db = $i.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $i, @($Path, 0))
function Rows([string]$sql, [int]$cols) {
  $v = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
  $v.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $v, $null) | Out-Null
  $out = @()
  while ($true) {
    $r = $v.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $v, $null)
    if (-not $r) { break }
    $row = @(); for ($c = 1; $c -le $cols; $c++) { $row += [string]$r.GetType().InvokeMember('StringData', 'GetProperty', $null, $r, @($c)) }
    $out += ,$row
  }
  return ,$out
}
$props = @{}; foreach ($r in (Rows 'SELECT \`Property\`, \`Value\` FROM \`Property\`' 2)) { $props[$r[0]] = $r[1] }
[pscustomobject]@{
  tables = @((Rows 'SELECT \`Name\` FROM \`_Tables\`' 1) | ForEach-Object { $_[0] })
  properties = $props
  files = @((Rows 'SELECT \`FileName\` FROM \`File\`' 1) | ForEach-Object { ($_[0] -split '\\|')[-1] })
} | ConvertTo-Json -Depth 4 -Compress
`);
  const out = await sh("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", msi]);
  const j = JSON.parse(out) as { tables: string[]; properties: Record<string, string>; files: string[] };
  return { ...j, summary: `Subject: ${j.properties.ProductName} (read with the Windows Installer COM API)` };
}

export function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Poll until fn returns truthy. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 20_000, intervalMs = 500, what = ""): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`eventually(${what}) timed out${last ? `: ${(last as Error).message}` : ""}`);
}

// ------------------------------------------------------------------------------------------ run state

export interface RunState { bPassword: string; servers: Record<string, number> }
export function readState(): RunState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
}
export function writeState(s: RunState) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
export function patchState(p: Partial<RunState> & { server?: [string, number] }) {
  const s = readState();
  if (p.bPassword !== undefined) s.bPassword = p.bPassword;
  if (p.server) s.servers[p.server[0]] = p.server[1];
  writeState(s);
}
export function serverId(key: string): number {
  const id = readState().servers[key];
  if (!id) throw new Error(`No connection id recorded for ${key} (did the first-run spec pass?)`);
  return id;
}

// ------------------------------------------------------------------------------------------ the app

export interface App { app: ElectronApplication; page: Page; log: string[] }

/** Launch the real desktop app (e2e-desktop/.build) on the suite's data directory. */
export async function launchApp(): Promise<App> {
  if (!existsSync(path.join(BUILD_DIR, "main/main.mjs"))) throw new Error("App not built: run node e2e-desktop/build.mjs");
  const app = await electron.launch({
    // GitHub's Linux runners restrict unprivileged user namespaces, so Chromium's sandbox cannot start there.
    args: [BUILD_DIR, ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [])],
    cwd: ROOT,
    env: {
      ...process.env,
      SEM_DATA_DIR: DATA_DIR,
      SEM_INSECURE_KEYSTORE: "1",
      SEM_RESOURCES_DIR: path.join(ROOT, "apps/desktop/resources"),
      SEM_POLL_INTERVAL_SEC: "5",
      SEM_LOG_LEVEL: "warn",
    },
    timeout: 60_000,
  });
  const log: string[] = [];
  app.process().stdout?.on("data", (d) => log.push(String(d)));
  app.process().stderr?.on("data", (d) => log.push(String(d)));
  const page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error") log.push(`[renderer] ${m.text()}`); });
  page.on("pageerror", (e) => log.push(`[renderer pageerror] ${e.message}`));
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".sem-shell")).toBeVisible({ timeout: 30_000 });
  return { app, page, log };
}

export async function closeApp(a: App | undefined, testInfo?: TestInfo) {
  if (!a) return;
  if (testInfo && a.log.length) await testInfo.attach("app-log.txt", { body: a.log.join(""), contentType: "text/plain" });
  await a.app.close().catch(() => undefined);
}

/** Make the next native Save dialog(s) return `filePath` (no OS UI). */
export async function stubSaveDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, fp) => {
    const r = { canceled: false, filePath: fp };
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async () => r;
    (dialog as unknown as Record<string, unknown>).showSaveDialogSync = () => fp;
  }, filePath);
}

/** Make the next native Open dialog(s) return `filePath`. */
export async function stubOpenDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, fp) => {
    const r = { canceled: false, filePaths: [fp] };
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => r;
    (dialog as unknown as Record<string, unknown>).showOpenDialogSync = () => [fp];
  }, filePath);
}

/** Click a native application-menu item by its path of labels (e.g. ["File", "New Server Connection…"]). */
export async function clickMenu(app: ElectronApplication, labels: (string | RegExp)[]) {
  const spec = labels.map((l) => (typeof l === "string" ? { s: l } : { r: l.source }));
  const found = await app.evaluate(({ Menu }, spec) => {
    const match = (label: string, m: { s?: string; r?: string }) => (m.s !== undefined ? label === m.s : new RegExp(m.r!).test(label));
    let items = Menu.getApplicationMenu()?.items ?? [];
    let item: Electron.MenuItem | undefined;
    for (const m of spec) {
      item = items.find((i) => match(i.label, m));
      if (!item) return `missing ${m.s ?? m.r} among [${items.map((i) => i.label).join(", ")}]`;
      items = item.submenu?.items ?? [];
    }
    item!.click();
    return "ok";
  }, spec);
  if (found !== "ok") throw new Error(`Menu item not found: ${found}`);
}

// ------------------------------------------------------------------------------------------ UI conveniences

/** Screenshot into artifacts/screenshots (also attached to the HTML report). Numbered in run order. */
export async function shot(page: Page, name: string, testInfo?: TestInfo) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  // Count existing files (not a module counter): a failed test restarts the worker and would reset a counter.
  const seq = readdirSync(SCREENSHOTS).filter((f) => f.endsWith(".png") && !f.startsWith("._")).length + 1;
  const file = path.join(SCREENSHOTS, `${String(seq).padStart(3, "0")}-${name.replace(/[^\w.-]+/g, "_").slice(0, 120)}.png`);
  await page.screenshot({ path: file });
  if (testInfo) await testInfo.attach(name, { path: file, contentType: "image/png" });
  return file;
}

/** Wait until the content area shows no spinner or skeleton. */
export async function settled(page: Page, timeout = 20_000) {
  await expect.poll(async () => page.locator(".sem-content .sem-loading, .sem-content [aria-busy='true'], .sem-content .mantine-Skeleton-root").count(), { timeout })
    .toBe(0);
}

/**
 * Confirm the open confirmation dialog (design/ConfirmDialog.tsx): types the requested text when a typed
 * confirmation is required, then presses the confirm button. Returns the dialog title.
 */
export async function confirmDialog(page: Page, expectTitle?: RegExp): Promise<string> {
  const dlg = page.locator(".sem-alert form").last();
  await expect(dlg).toBeVisible();
  const title = (await dlg.locator(".sem-alert-title").innerText()).trim();
  if (expectTitle) expect(title).toMatch(expectTitle);
  const type = dlg.getByTestId("confirm-type");
  if (await type.count()) {
    const code = (await dlg.locator("label .sem-code-inline, label code").first().innerText()).trim();
    await type.fill(code);
  }
  await dlg.locator("button[type=submit]").click();
  await expect(dlg).toBeHidden();
  return title;
}

/** Pick an option of a Mantine Select/Autocomplete. */
export async function selectOption(page: Page, input: Locator, option: string | RegExp) {
  await input.click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Click a segment of a Mantine SegmentedControl. */
export async function segment(control: Locator, label: string) {
  await control.locator("label").filter({ hasText: label }).first().click();
}

/** Current hash route of the renderer (e.g. "/servers/1/hubs"). */
export async function route(page: Page) {
  return page.evaluate(() => decodeURIComponent(location.hash.replace(/^#/, "")));
}

/** Navigate through the sidebar and the scope navigation, like a user. */
export async function openServer(page: Page, id: number) {
  await page.getByTestId(`sidebar-server-${id}`).click();
  await expect.poll(() => route(page)).toMatch(new RegExp(`^/servers/${id}(/|$)`));
}

/** Click a page in the scope navigation (server, hub or deploy sections) by its path ("" = index). */
export async function openSection(page: Page, sectionPath: string) {
  await page.getByTestId("scope-nav").getByTestId(`nav-${sectionPath || "index"}`).click();
}

export const modKey = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Set a Mantine Switch/Checkbox (whose <input> may be visually hidden) to `on`, the way a click on it would:
 * a click event on the input toggles it natively and React's onChange fires.
 */
export async function setToggle(input: Locator, on: boolean) {
  if ((await input.isChecked()) !== on) await input.dispatchEvent("click");
  await expect(input).toBeChecked({ checked: on });
}

/** SHA-256 fingerprint (lowercase hex, no separators) of the certificate a TLS server presents: independent of the app. */
export async function tlsFingerprint(port: number): Promise<string> {
  const tls = await import("node:tls");
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const fp = s.getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
      s.end();
      resolve(fp);
    });
    s.on("error", reject);
  });
}

export const normFp = (s: string) => s.replace(/[^0-9a-f]/gi, "").toLowerCase();

/**
 * A Sheet/Modal by its test id. Mantine keeps a closed Modal's root mounted (and the test id sits on that
 * root), so visibility is judged on its content element, which only exists while it is open.
 */
export const sheet = (page: Page, testId: string) => page.getByTestId(testId).locator(".mantine-Modal-content");

/**
 * Minimal ZIP writer (stored entries), built in memory. Used for the client-package fixture: NON-executable
 * placeholder files (plain text, no "MZ" header) plus the real hamcore.se2. No PE file is ever produced.
 */
export function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { crc32 } = process.getBuiltinModule("node:zlib") as typeof import("node:zlib");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.data.subarray(0, 2).toString("latin1") === "MZ") throw new Error(`refusing to zip PE content for ${e.name}`);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, e.data);
    centrals.push(ch, name);
    offset += lh.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
