// End-to-end smoke test of the desktop MAIN PROCESS core against a real SoftEther VPN Server.
//
//   node apps/desktop/tools/smoke-core/run.ts
//
// 1. builds main + preload (production esbuild options) into a temp dir, with a placeholder renderer
// 2. starts a throwaway vpnserver (port 15801, run dir ~/se-desk-core) and sets its admin password
// 3. launches the built app with Playwright's _electron (SEM_DATA_DIR = temp, SEM_INSECURE_KEYSTORE=1)
//    and drives window.sem (the real preload bridge → IPC → in-process Fastify) from the page
// 4. restarts the app on the same data dir to check persistence and password sealing
// 5. writes tools/smoke-core/REPORT.md and artifacts/ (results.json, downloaded files, screenshot)
// Environment: SE_BUILD_DIR (default ~/se-build/src/build), SMOKE_KEYCHAIN=1 also exercises the
// real safeStorage (macOS Keychain) key sealing in a third launch.
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { Agent, request } from "undici";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const DESKTOP = path.resolve(HERE, "../..");
const ROOT = path.resolve(DESKTOP, "../..");
const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const RUN_DIR = path.join(os.homedir(), "se-desk-core");
const PORT = 15801;
const ADMIN_PW = "Smoke-Adm1n-Pw!";
const ART = path.join(HERE, "artifacts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "sem-smoke-core-"));
const BUILD = path.join(TMP, "build");
const DATA = path.join(TMP, "data");
const COMMAND = "node apps/desktop/tools/smoke-core/run.ts";

type Check = { name: string; ok: boolean; detail: string; ms: number };
const checks: Check[] = [];
const notes: string[] = [];
let current = "";

async function step(name: string, fn: () => Promise<string | void>) {
  current = name;
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    checks.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    const detail = (e as Error).message.split("\n").slice(0, 6).join(" | ");
    checks.push({ name, ok: false, detail, ms: Date.now() - t0 });
    console.log(`  FAIL ${name} — ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- SoftEther server

let server: ChildProcess | null = null;
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function seRpc(password: string, method: string, params: Record<string, unknown> = {}) {
  const res = await request(`https://127.0.0.1:${PORT}/api/`, {
    method: "POST", dispatcher: insecure,
    headers: { authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  const json = (await res.body.json()) as { result?: Record<string, any>; error?: { code: number; message: string } };
  if (json.error) throw new Error(`SoftEther ${method} error ${json.error.code}: ${json.error.message}`);
  return json.result!;
}

function killServer() {
  if (server?.pid) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } }
  server = null;
}

async function startServer() {
  const pidFile = path.join(RUN_DIR, "pid");
  if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } await sleep(1000); }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE_BUILD, f), path.join(RUN_DIR, f));
  writeFileSync(path.join(RUN_DIR, "vpn_server.config"), [
    "# Software Configuration File", "declare root", "{",
    "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
    "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
  ].join("\n"));
  const log = openSync(path.join(RUN_DIR, "vpnserver.log"), "a");
  server = spawn("./vpnserver", ["execsvc"], {
    cwd: RUN_DIR, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true,
  });
  writeFileSync(pidFile, String(server.pid));
  const t0 = Date.now();
  for (;;) {
    try { await seRpc("", "Test", { IntValue_u32: 1 }); break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) throw new Error("vpnserver did not answer JSON-RPC within 30 s");
    await sleep(300);
  }
  await seRpc("", "SetServerPassword", { PlainTextPassword_str: ADMIN_PW });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- app driver

let app: ElectronApplication | null = null;
let page: Page;

async function launch(extraEnv: Record<string, string> = {}, dataDir = DATA) {
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [BUILD],
    env: {
      ...process.env,
      SEM_DATA_DIR: dataDir,
      SEM_INSECURE_KEYSTORE: "1",
      SEM_POLL_INTERVAL_SEC: "5",
      // The smoke build lives outside apps/desktop, so point it at the deploy assets explicitly
      SEM_RESOURCES_DIR: path.join(DESKTOP, "resources"),
      ...extraEnv,
    } as Record<string, string>,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.waitForFunction(() => typeof (window as any).sem?.api === "function");
}

async function close() {
  if (!app) return;
  await app.close().catch(() => undefined);
  app = null;
}

type Res = { status: number; body: any };
async function api(method: string, p: string, body?: unknown): Promise<Res> {
  return page.evaluate(([m, pp, b]) => (window as any).sem.api({ method: m, path: pp, body: b }), [method, p, body] as const);
}
async function ok(method: string, p: string, body?: unknown, status = 200): Promise<any> {
  const r = await api(method, p, body);
  if (r.status !== status) throw new Error(`${method} ${p} → ${r.status} (expected ${status}): ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}
/** Make the next native Save/Open dialog return `file` (dialogs cannot be clicked by automation). */
async function mockSaveDialog(file: string) {
  await app!.evaluate(({ dialog }, f) => { (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file);
}
async function mockOpenDialog(file: string) {
  await app!.evaluate(({ dialog }, f) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
}

function sh(cmd: string, args: string[], cwd?: string) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------- the run

async function main() {
  rmSync(ART, { recursive: true, force: true });
  mkdirSync(ART, { recursive: true });
  console.log(`smoke-core: temp ${TMP}`);
  let fp = "";
  let jr = 0, nat = 0, uns = 0;
  const started = Date.now();

  await step("build main+preload with esbuild (production options)", async () => {
    const out = sh("node", [path.join(HERE, "build.mjs"), BUILD]);
    const size = statSync(path.join(BUILD, "main/main.mjs")).size;
    const meta = JSON.parse(readFileSync(path.join(BUILD, "main-meta.json"), "utf8"));
    const inputs = Object.keys(meta.inputs);
    const bundled = ["fastify", "undici", "zod", "resedit", "@fastify/multipart", "pino"].filter((m) => inputs.some((i) => i.includes(`node_modules/${m}/`)));
    return `${out.trim().split("\n").pop()}; main.mjs ${(size / 1024 / 1024).toFixed(1)} MB; bundled: ${bundled.join(", ")}; catalog.json bundled: ${inputs.some((i) => i.endsWith("catalog.json"))}`;
  });

  await step(`start throwaway vpnserver on 127.0.0.1:${PORT} and set its admin password`, async () => {
    await startServer();
    const info = await seRpc(ADMIN_PW, "GetServerInfo");
    return `${info.ServerProductName_str} build ${info.ServerBuildInt_u32}`;
  });

  await step("launch the built app (Playwright _electron, SEM_DATA_DIR temp, insecure keystore)", async () => {
    await launch();
    const info = await page.evaluate(() => (window as any).sem.info());
    const win = await app!.evaluate(({ BrowserWindow, app: a }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { name: a.getName(), size: w.getSize(), min: w.getMinimumSize(), title: w.getTitle(), userData: a.getPath("userData") };
    });
    assert(win.name === "Server Manager for SoftEther VPN", `app name ${win.name}`);
    assert(win.min[0] === 1024 && win.min[1] === 680, `min size ${win.min}`);
    assert(win.size[0] === 1360 && win.size[1] === 880, `size ${win.size}`);
    assert(info.dataDir === DATA && win.userData === DATA, `dataDir ${info.dataDir} userData ${win.userData}`);
    return `electron ${info.electron}, node ${info.node}, ${info.platform}/${info.arch}; window ${win.size.join("x")} (min ${win.min.join("x")})`;
  });

  await step("renderer hardening: CSP blocks inline script + eval, sandboxed preload exposes only window.sem", async () => {
    const r = await page.evaluate(() => {
      const w = window as any;
      const evalBlocked = w.__evalAllowed === false;
      return { external: !!w.__externalRan, inline: !!w.__inlineRan, evalBlocked, require: typeof w.require, process: typeof w.process, keys: Object.keys(w.sem).sort() };
    });
    assert(r.external, "external script did not run");
    assert(!r.inline, "inline script ran: CSP not applied");
    assert(r.evalBlocked, "eval allowed: CSP not applied");
    assert(r.require === "undefined" && r.process === "undefined", "Node globals leaked into the renderer");
    return `inline blocked, eval blocked, bridge = {${r.keys.join(", ")}}`;
  });

  await step("navigation away and window.open are blocked; http(s) links go to the OS browser", async () => {
    await app!.evaluate(({ shell }) => { (globalThis as any).__opened = []; (shell as any).openExternal = async (u: string) => { (globalThis as any).__opened.push(u); }; });
    const before = page.url();
    const opened = await page.evaluate(() => window.open("https://example.com/popup") === null);
    await page.evaluate(() => { location.href = "https://example.com/navigate"; });
    await sleep(500);
    const after = page.url();
    const ext = await app!.evaluate(() => (globalThis as any).__opened as string[]);
    assert(opened, "window.open returned a window");
    assert(after === before, `navigated to ${after}`);
    assert(ext.includes("https://example.com/popup") && ext.includes("https://example.com/navigate"), `openExternal calls: ${ext}`);
    return `stayed on ${path.basename(new URL(after).pathname)}; external: ${ext.join(", ")}`;
  });

  await step("IPC rejects calls from a foreign document (data: URL window with our preload)", async () => {
    const r = await app!.evaluate(async ({ BrowserWindow }, preload) => {
      const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
      await w.loadURL("data:text/html,<p>foreign</p>");
      const out = await w.webContents.executeJavaScript("window.sem.api({method:'GET',path:'/api/servers'}).then(() => 'allowed', (e) => String(e))");
      w.destroy();
      return out as string;
    }, path.join(BUILD, "preload/preload.cjs"));
    assert(/untrusted sender/.test(r), `foreign call was ${r}`);
    return r.slice(0, 120);
  });

  await step("openExternal only allows http/https/mailto", async () => {
    const bad = await page.evaluate(() => (window as any).sem.openExternal("file:///etc/passwd").then(() => "allowed", (e: Error) => e.message));
    await page.evaluate(() => (window as any).sem.openExternal("mailto:it@example.com"));
    const ext = await app!.evaluate(() => (globalThis as any).__opened as string[]);
    assert(/Refusing/.test(bad), `file: URL was ${bad}`);
    assert(ext.includes("mailto:it@example.com"), "mailto not opened");
    return "file: refused, mailto: opened";
  });

  await step("native menu: roles/accelerators present, Refresh is sent to the renderer (no reload)", async () => {
    await page.evaluate(() => { (window as any).__menu = []; (window as any).sem.onMenu((a: string) => (window as any).__menu.push(a)); });
    const menu = await app!.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu()!;
      const find = (label: string) => m.items.flatMap((i) => i.submenu?.items ?? []).find((x) => x.label === label);
      find("Refresh")!.click();
      find("New Server Connection…")!.click();
      return m.items.map((i) => `${i.label}: ${(i.submenu?.items ?? []).filter((x) => x.type !== "separator").map((x) => x.label + (x.accelerator ? ` (${x.accelerator})` : "")).join(", ")}`);
    });
    await sleep(300);
    const got = await page.evaluate(() => (window as any).__menu as string[]);
    assert(got.includes("refresh") && got.includes("new-server"), `renderer got ${got}`);
    const loadedMarker = await page.evaluate(() => (window as any).__externalRan && (window as any).__menu.length);
    assert(loadedMarker, "page reloaded");
    writeFileSync(path.join(ART, "menu.txt"), menu.join("\n") + "\n");
    return `renderer received ${got.join(", ")}; menu → artifacts/menu.txt`;
  });

  await step("GET /api/catalog (bundled catalog JSON)", async () => {
    const c = await ok("GET", "/api/catalog");
    const n = Object.keys(c.methods).length;
    assert(n > 100, `only ${n} methods`);
    return `${n} methods, ${Object.keys(c.types).length} types`;
  });

  await step("POST /api/servers/probe → certificate for TOFU pinning", async () => {
    const p = await ok("POST", "/api/servers/probe", { host: "127.0.0.1", port: PORT });
    fp = p.fingerprint;
    assert(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp), `fingerprint ${fp}`);
    return `${fp.slice(0, 23)}… selfSigned=${p.selfSigned}`;
  });

  await step("POST /api/servers/test honours transport (jsonrpc ok, wrong password, wrong pin, native)", async () => {
    const base = { host: "127.0.0.1", port: PORT, tlsMode: "pin", fingerprint: fp };
    const good = await ok("POST", "/api/servers/test", { ...base, password: ADMIN_PW, transport: "jsonrpc" });
    assert(good.ok === true && good.info?.ServerProductName_str, `good: ${JSON.stringify(good).slice(0, 200)}`);
    const badPw = await ok("POST", "/api/servers/test", { ...base, password: "nope", transport: "jsonrpc" });
    assert(badPw.ok === false && (badPw.kind === "auth" || badPw.softEtherCode === 9), `bad password: ${JSON.stringify(badPw)}`);
    const badPin = await ok("POST", "/api/servers/test", { ...base, fingerprint: "00".repeat(32), password: ADMIN_PW, transport: "jsonrpc" });
    assert(badPin.ok === false && badPin.kind === "tls-mismatch", `bad pin: ${JSON.stringify(badPin)}`);
    const native = await ok("POST", "/api/servers/test", { ...base, password: ADMIN_PW, transport: "native" });
    notes.push(`native transport test: ${native.ok ? "ok (native agent landed)" : `not ok: ${native.error}`}`);
    return `jsonrpc ok (${good.latencyMs} ms); wrong password → ${badPw.kind}; wrong pin → ${badPin.kind}; native → ${native.ok ? "ok" : native.error}`;
  });

  await step("add server (jsonrpc, pinned, saved password) → 201 with live state", async () => {
    const s = await ok("POST", "/api/servers", {
      name: "smoke-jsonrpc", host: "127.0.0.1", port: PORT, password: ADMIN_PW, savePassword: true,
      transport: "jsonrpc", tlsMode: "pin", fingerprint: fp, tags: ["smoke"],
    }, 201);
    jr = s.id;
    assert(s.transport === "jsonrpc" && s.passwordSaved === true && s.unlocked === true, JSON.stringify(s).slice(0, 300));
    assert(s.state?.ok === true && s.state.hubs?.HubList, `state ${JSON.stringify(s.state).slice(0, 300)}`);
    assert(!JSON.stringify(s).includes(ADMIN_PW), "password leaked in the record");
    return `id ${s.id}, state ok, ${s.state.latencyMs} ms, hubs: ${s.state.hubs.HubList.map((h: any) => h.HubName_str).join(",")}`;
  });

  await step("add server with the default transport (native) → created; state reflects native status", async () => {
    const s = await ok("POST", "/api/servers", { name: "smoke-native", host: "127.0.0.1", port: PORT, password: ADMIN_PW, tlsMode: "pin", fingerprint: fp }, 201);
    nat = s.id;
    assert(s.transport === "native" && s.port === PORT, JSON.stringify(s).slice(0, 200));
    notes.push(`native server state after add: ${s.state?.ok ? "ok" : `error: ${s.state?.error}`}`);
    return s.state?.ok ? "native state ok" : `native not available yet (accepted): ${s.state?.error}`;
  });

  await step("default port 443 and duplicate names", async () => {
    const d = await api("POST", "/api/servers", { name: "SMOKE-JSONRPC", host: "127.0.0.1", password: "x", tlsMode: "insecure" });
    assert(d.status === 409, `duplicate → ${d.status}`);
    const v = await api("POST", "/api/servers", { name: "x", host: "h", tlsMode: "pin" });
    assert(v.status === 400, `pin without fingerprint → ${v.status}`);
    return "case-insensitive duplicate → 409; pin without fingerprint → 400";
  });

  await step("GET /api/servers lists records with transport/passwordSaved/unlocked/state", async () => {
    const list = await ok("GET", "/api/servers");
    const keys = Object.keys(list[0]).sort();
    for (const k of ["id", "name", "host", "port", "hub", "transport", "tlsMode", "fingerprint", "passwordSaved", "unlocked", "tags", "notes", "enabled", "state"]) {
      assert(keys.includes(k), `missing ${k}`);
    }
    assert(!keys.some((k) => /password$|sealed/i.test(k) && k !== "passwordSaved"), `secret field in ${keys}`);
    return list.map((s: any) => `${s.name}[${s.transport}] ok=${s.state?.ok}`).join("; ");
  });

  await step("RPC gateway: EnumHub / CreateHub / DeleteHub (jsonrpc) + canonical-key guard", async () => {
    await ok("POST", `/api/servers/${jr}/rpc/CreateHub`, { HubName_str: "SMOKEHUB", Online_bool: true, HubType_u32: 0 });
    let hubs = (await ok("POST", `/api/servers/${jr}/rpc/EnumHub`, {})).HubList.map((h: any) => h.HubName_str);
    assert(hubs.includes("SMOKEHUB"), `after create: ${hubs}`);
    await ok("POST", `/api/servers/${jr}/rpc/DeleteHub`, { HubName_str: "SMOKEHUB" });
    hubs = (await ok("POST", `/api/servers/${jr}/rpc/EnumHub`, {})).HubList.map((h: any) => h.HubName_str);
    assert(!hubs.includes("SMOKEHUB"), `after delete: ${hubs}`);
    const alias = await api("POST", `/api/servers/${jr}/rpc/GetHub`, { HubName_str: "DEFAULT", hubname_str: "OTHER" });
    assert(alias.status === 400, `alias → ${alias.status}`);
    const se = await api("POST", `/api/servers/${jr}/rpc/GetHub`, { HubName_str: "NO_SUCH_HUB" });
    assert(se.status === 422 && typeof se.body.softEtherCode === "number", `SoftEther error → ${se.status} ${JSON.stringify(se.body)}`);
    const unknown = await api("POST", `/api/servers/${jr}/rpc/NoSuchMethod`, {});
    assert(unknown.status === 404, `unknown method → ${unknown.status}`);
    const nat1 = await api("POST", `/api/servers/${nat}/rpc/EnumHub`, {});
    notes.push(`native RPC EnumHub: ${nat1.status} ${JSON.stringify(nat1.body).slice(0, 160)}`);
    return `create/list/delete ok; alias → 400; missing hub → 422 (code ${se.body.softEtherCode}); unknown → 404; native EnumHub → ${nat1.status}`;
  });

  await step("lock/unlock with savePassword=false", async () => {
    const s = await ok("POST", "/api/servers", {
      name: "smoke-unsaved", host: "127.0.0.1", port: PORT, password: ADMIN_PW, savePassword: false, transport: "jsonrpc", tlsMode: "pin", fingerprint: fp,
    }, 201);
    uns = s.id;
    assert(s.passwordSaved === false && s.unlocked === true && s.state?.ok === true, `after add: ${JSON.stringify(s).slice(0, 200)}`);
    await ok("POST", `/api/servers/${uns}/rpc/EnumHub`, {});
    const locked = await ok("POST", `/api/servers/${uns}/lock`);
    assert(locked.unlocked === false, "still unlocked");
    const r423 = await api("POST", `/api/servers/${uns}/rpc/EnumHub`, {});
    assert(r423.status === 423 && r423.body.locked === true, `locked rpc → ${r423.status} ${JSON.stringify(r423.body)}`);
    const wrong = await api("POST", `/api/servers/${uns}/unlock`, { password: "wrong" });
    assert(wrong.status === 403, `wrong password → ${wrong.status}`);
    const still = await api("POST", `/api/servers/${uns}/rpc/EnumHub`, {});
    assert(still.status === 423, "wrong password unlocked it");
    const un = await ok("POST", `/api/servers/${uns}/unlock`, { password: ADMIN_PW });
    assert(un.ok && un.verified && un.server.unlocked === true, JSON.stringify(un).slice(0, 200));
    await ok("POST", `/api/servers/${uns}/rpc/EnumHub`, {});
    return "unsaved → unlocked; lock → 423 {locked:true}; wrong password → 403 (still locked); unlock → verified, RPC ok";
  });

  await step("test with a saved/session password (id) only reaches the saved host; locked → no blind attempt", async () => {
    const same = await ok("POST", "/api/servers/test", { id: jr, host: "127.0.0.1", port: PORT, transport: "jsonrpc", tlsMode: "pin", fingerprint: fp });
    assert(same.ok === true, `same host with id: ${JSON.stringify(same).slice(0, 200)}`);
    const other = await ok("POST", "/api/servers/test", { id: jr, host: "localhost", port: PORT, transport: "jsonrpc", tlsMode: "pin", fingerprint: fp });
    assert(other.ok === false && other.kind === "password-required", `other host with id: ${JSON.stringify(other).slice(0, 200)}`);
    await ok("POST", `/api/servers/${uns}/lock`);
    const lockedTest = await ok("POST", "/api/servers/test", { id: uns, host: "127.0.0.1", port: PORT, transport: "jsonrpc", tlsMode: "pin", fingerprint: fp });
    assert(lockedTest.ok === false && lockedTest.kind === "locked", `locked id: ${JSON.stringify(lockedTest).slice(0, 200)}`);
    const sum = await ok("GET", "/api/fleet/summary");
    const t = sum.totals;
    assert(t.locked === 1 && t.online + t.offline + t.locked === t.servers, `totals ${JSON.stringify(t)}`);
    await ok("POST", `/api/servers/${uns}/unlock`, { password: ADMIN_PW });
    return `same host → ok; other host → password-required; locked → kind locked; fleet totals partition (locked ${t.locked})`;
  });

  let b1 = 0, b2 = 0;
  await step("backups: take, list, diff (backup↔live, backup↔backup), download via native Save dialog", async () => {
    const r1 = await ok("POST", `/api/servers/${jr}/backups`, { note: "smoke 1" }, 201);
    b1 = r1.id;
    await ok("POST", `/api/servers/${jr}/rpc/CreateHub`, { HubName_str: "DIFFHUB", Online_bool: true, HubType_u32: 0 });
    const live = await ok("GET", `/api/servers/${jr}/backups/${b1}/diff?other=live`);
    assert(live.changed > 0 && JSON.stringify(live.lines).includes("DIFFHUB"), `diff vs live: ${live.changed}`);
    const r2 = await ok("POST", `/api/servers/${jr}/backups`, { note: "smoke 2" }, 201);
    b2 = r2.id;
    const list = await ok("GET", `/api/servers/${jr}/backups`);
    assert(list.length === 2 && list.every((b: any) => b.createdBy === os.userInfo().username), `list ${JSON.stringify(list)}`);
    const diff = await ok("GET", `/api/servers/${jr}/backups/${b1}/diff?other=${b2}`);
    assert(diff.changed > 0, "no diff between backups");
    const target = path.join(ART, "backup-download.config");
    await mockSaveDialog(target);
    const d = await page.evaluate((p) => (window as any).sem.download(p), `/api/servers/${jr}/backups/${b1}?download=1`);
    assert(d.saved && d.filePath === target, JSON.stringify(d));
    const saved = readFileSync(target);
    const meta = list.find((b: any) => b.id === b1);
    const sha = createHash("sha256").update(saved).digest("hex");
    assert(saved.includes(Buffer.from("declare root")) && saved.length === meta.size && sha === meta.sha256, `downloaded ${saved.length} bytes sha ${sha.slice(0, 12)} vs ${meta.size} ${meta.sha256.slice(0, 12)}`);
    const text = saved.toString("utf8");
    await ok("POST", `/api/servers/${jr}/rpc/DeleteHub`, { HubName_str: "DIFFHUB" });
    return `2 backups by ${list[0].createdBy}; live diff ${live.changed} changed lines; b1↔b2 ${diff.changed}; download ${text.length} bytes`;
  });

  await step("GET /api/deploy/capabilities", async () => {
    const c = await ok("GET", "/api/deploy/capabilities");
    writeFileSync(path.join(ART, "capabilities.json"), JSON.stringify(c, null, 2));
    assert(c.msi.available === true && c.msi.tool === "wixl", JSON.stringify(c.msi));
    assert(c.setupExe.available === true, JSON.stringify(c.setupExe));
    return `msi: ${c.msi.tool} ${c.msi.version} (${c.msi.path}); setup.exe stubs: ${c.setupExe.arch.join(",")}`;
  });

  let userHash = "";
  await step(".vpn for a hub user (embed-hash policy) downloaded through the bridge", async () => {
    await ok("POST", `/api/servers/${jr}/rpc/CreateHub`, { HubName_str: "DEPLOY", Online_bool: true, HubType_u32: 0 });
    await ok("POST", `/api/servers/${jr}/rpc/CreateUser`, { HubName_str: "DEPLOY", Name_str: "alice", Realname_utf: "Alice", AuthType_u32: 1, Auth_Password_str: "Alice-Pw-123" });
    userHash = (await seRpc(ADMIN_PW, "GetUser", { HubName_str: "DEPLOY", Name_str: "alice" })).HashedKey_bin;
    const built = await ok("POST", `/api/deploy/hubs/${jr}/DEPLOY/packages`, { user: "alice", kind: "vpn" }, 201);
    const target = path.join(ART, built.fileName);
    await mockSaveDialog(target);
    const d = await page.evaluate((id) => (window as any).sem.download(`/api/deploy/installers/${id}/download`), built.id);
    assert(d.saved, "not saved");
    const text = readFileSync(target, "utf8");
    assert(text.includes("string Username alice") && text.includes("string HubName DEPLOY") && text.includes(`byte HashedPassword ${userHash}`), "vpn content");
    assert(text.includes(`uint Port ${PORT}`) && text.includes("byte ServerCert "), "host/port/cert");
    return `${built.fileName} (${built.size} bytes, credential ${built.credential}); hash matches the server's HashedKey`;
  });

  await step("client package upload through the native Open dialog (multipart built in main)", async () => {
    // SAFETY: never write PE executables named vpnclient/vpncmd on this machine (corporate EDR quarantines them).
    // The package is a ZIP of NON-executable placeholder files; SFX extraction is not exercised here.
    const dir = path.join(TMP, "placeholder-client");
    mkdirSync(dir, { recursive: true });
    for (const n of ["vpnclient.exe", "vpncmd.exe", "vpncmgr.exe"]) writeFileSync(path.join(dir, n), `placeholder ${n} (not an executable)\n`);
    copyFileSync(path.join(SE_BUILD, "hamcore.se2"), path.join(dir, "hamcore.se2"));
    const zip = path.join(TMP, "client-placeholder.zip");
    sh("zip", ["-j", "-q", zip, ...["vpnclient.exe", "vpncmd.exe", "vpncmgr.exe", "hamcore.se2"].map((n) => path.join(dir, n))]);
    await mockOpenDialog(zip);
    const r = await page.evaluate(() => (window as any).sem.upload("/api/deploy/packages", { fields: { arch: "x64" }, filters: [{ name: "Package", extensions: ["exe", "zip"] }] }));
    assert(r && r.status === 201, `upload → ${JSON.stringify(r).slice(0, 300)}`);
    assert(r.body.arch === "x64" && r.body.files.some((f: any) => f.name === "vpnclient.exe"), JSON.stringify(r.body).slice(0, 300));
    return `package #${r.body.id}: ${r.body.filename}, ${r.body.files.length} placeholder files`;
  });

  await step("MSI build for the hub user (wixl)", async () => {
    const built = await ok("POST", `/api/deploy/hubs/${jr}/DEPLOY/packages`, { user: "alice", kind: "msi" }, 201);
    const target = path.join(ART, built.fileName);
    await mockSaveDialog(target);
    const d = await page.evaluate((id) => (window as any).sem.download(`/api/deploy/installers/${id}/download`), built.id);
    assert(d.saved, "not saved");
    const bytes = readFileSync(target);
    assert(bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1", "not an OLE/MSI file");
    const props = sh("msiinfo", ["export", target, "Property"]);
    const files = sh("msiinfo", ["export", target, "File"]);
    writeFileSync(path.join(ART, "msi-Property.txt"), props);
    writeFileSync(path.join(ART, "msi-File.txt"), files);
    writeFileSync(path.join(ART, "msi-build-log.txt"), built.log);
    assert(/ProductCode\t\{[0-9A-F-]+\}/.test(props) && props.includes("SecureCustomProperties\tWIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED;VPNUSERNAME;VPNPASSWORD"), "Property table");
    assert(files.includes("vpnclient.exe") && files.includes("profile1.vpn"), "File table");
    // setup.exe wrapper (PE) deliberately not built in tests on this machine.
    return `${built.fileName} ${bytes.length} bytes v${built.productVersion}`;
  });

  await step("settings: GET/PUT /api/settings", async () => {
    const s0 = await ok("GET", "/api/settings");
    assert(s0.keystore === "plain", `keystore ${s0.keystore}`);
    await ok("PUT", "/api/settings", { poll: { intervalSec: 15 }, backup: { enabled: true, intervalHours: 12, retention: 5 } });
    const s1 = await ok("GET", "/api/settings");
    assert(s1.poll.intervalSec === 15 && s1.backup.retention === 5, JSON.stringify(s1));
    const bad = await api("PUT", "/api/settings", { poll: { intervalSec: 1 } });
    assert(bad.status === 400 && Array.isArray(bad.body.issues), `validation → ${bad.status}`);
    return "poll 15 s, backup every 12 h keep 5; invalid → 400 with issues";
  });

  await step("fleet summary + bulk RPC across transports", async () => {
    const f = await ok("GET", "/api/fleet/summary");
    assert(f.totals.servers === 3, JSON.stringify(f.totals));
    const bulk = await ok("POST", "/api/fleet/rpc", { method: "GetServerInfo", params: {}, serverIds: [jr, nat, uns] });
    const byId = Object.fromEntries(bulk.results.map((r: any) => [r.serverId, r]));
    assert(byId[jr].ok && byId[uns].ok, JSON.stringify(bulk).slice(0, 300));
    return `totals ${JSON.stringify(f.totals)}; bulk: jsonrpc ok ×2, native ${byId[nat].ok ? "ok" : byId[nat].error}`;
  });

  await step("scheduler polls in the background (state checkedAt advances)", async () => {
    const t0 = (await ok("GET", `/api/servers/${jr}`)).state.checkedAt;
    const deadline = Date.now() + 25_000;
    let t1 = t0;
    while (Date.now() < deadline && t1 === t0) { await sleep(1000); t1 = (await ok("GET", `/api/servers/${jr}`)).state.checkedAt; }
    assert(t1 > t0, "no background poll within 25 s");
    return `checkedAt advanced by ${((t1 - t0) / 1000).toFixed(1)} s`;
  });

  await step("screenshot of the running window", async () => {
    await page.screenshot({ path: path.join(ART, "window.png") });
    return "artifacts/window.png";
  });

  await step("quit cleanly, restart on the same data dir: servers persist, saved password sealed, unsaved one locked", async () => {
    await close();
    const db = new DatabaseSync(path.join(DATA, "sem.db"), { readOnly: true });
    const rows = db.prepare("SELECT id, name, transport, password_saved, password_sealed FROM servers ORDER BY id").all() as any[];
    db.close();
    const saved = rows.find((r) => r.id === jr);
    const unsaved = rows.find((r) => r.id === uns);
    assert(saved.password_sealed?.startsWith("v1:") && !saved.password_sealed.includes(ADMIN_PW), "saved password not sealed");
    assert(unsaved.password_saved === 0 && unsaved.password_sealed === null, "unsaved password was written to disk");
    const raw = readFileSync(path.join(DATA, "sem.db"));
    assert(!raw.includes(Buffer.from(ADMIN_PW)), "plaintext password found in sem.db");
    const keyMode = (statSync(path.join(DATA, "master.key")).mode & 0o777).toString(8);
    await launch();
    const list = await ok("GET", "/api/servers");
    assert(list.length === 3, `after restart: ${list.length}`);
    const j = list.find((s: any) => s.id === jr), u = list.find((s: any) => s.id === uns);
    assert(j.unlocked && j.passwordSaved && u.unlocked === false && u.passwordSaved === false, JSON.stringify(list.map((s: any) => [s.name, s.unlocked])));
    await ok("POST", `/api/servers/${jr}/rpc/EnumHub`, {});
    const r = await api("POST", `/api/servers/${uns}/rpc/EnumHub`, {});
    assert(r.status === 423, `unsaved after restart → ${r.status}`);
    const backups = await ok("GET", `/api/servers/${jr}/backups`);
    assert(backups.length === 2, "backups lost");
    return `3 servers + 2 backups persisted; sealed v1:… in sem.db, no plaintext in the file; master.key mode ${keyMode}; unsaved → 423 after restart`;
  });

  if (process.env.SMOKE_KEYCHAIN === "1") {
    await step("safeStorage keystore (real OS keychain): master.key.sealed created and reused", async () => {
      await close();
      const d2 = path.join(TMP, "data-keychain");
      await launch({ SEM_INSECURE_KEYSTORE: "" }, d2);
      const s = await ok("GET", "/api/settings");
      await close();
      assert(s.keystore === "safeStorage", `keystore ${s.keystore}`);
      assert(existsSync(path.join(d2, "master.key.sealed")) && !existsSync(path.join(d2, "master.key")), "sealed key file missing");
      await launch({ SEM_INSECURE_KEYSTORE: "" }, d2);
      const s2 = await ok("GET", "/api/settings");
      return `keystore ${s2.keystore}; master.key.sealed ${statSync(path.join(d2, "master.key.sealed")).size} bytes, reopened OK`;
    });
  }

  await close();
  killServer();
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(path.join(ART, "results.json"), JSON.stringify({ at: new Date().toISOString(), durationMs: Date.now() - started, checks, notes }, null, 2));
  writeReport(Date.now() - started);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; report: ${path.join(HERE, "REPORT.md")}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failed.length ? 1 : 0;
}

function writeReport(ms: number) {
  const v = (cmd: string, args: string[]) => { try { return sh(cmd, args).trim().split("\n")[0]; } catch { return "n/a"; } };
  const failed = checks.filter((c) => !c.ok).length;
  const lines = [
    "# Desktop core smoke test (main process)",
    "",
    `Generated by \`${COMMAND}\` (from the repo root) on ${new Date().toISOString()} — ${checks.length - failed}/${checks.length} checks passed in ${(ms / 1000).toFixed(1)} s.`,
    "",
    "What it exercises: the production esbuild bundle of `src/main` + `src/preload`, launched as a real Electron app through",
    "Playwright `_electron`, driven only through `window.sem` (preload bridge → IPC → in-process Fastify `inject`), against a",
    `real SoftEther VPN Server built from source (\`${SE_BUILD}\`, port ${PORT}, run dir \`${RUN_DIR}\`). Native Save/Open dialogs are`,
    "replaced in the main process (automation cannot click them); everything else is the shipping code path.",
    "",
    `Environment: ${os.platform()} ${os.arch()}, Node ${process.version}, wixl ${v("wixl", ["--version"])}.`,
    "",
    "| # | Check | Result | Detail |",
    "|---|---|---|---|",
    ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? "PASS" : "**FAIL**"} | ${c.detail.replace(/\|/g, "\\|")} (${c.ms} ms) |`),
    "",
    "## Notes",
    "",
    ...notes.map((n) => `- ${n}`),
    "",
    "## Artifacts (tools/smoke-core/artifacts/)",
    "",
    "- `results.json` — machine-readable results of this run",
    "- `menu.txt` — the native application menu as built",
    "- `capabilities.json` — `GET /api/deploy/capabilities`",
    "- `backup-download.config` — a configuration backup saved through `sem.download`",
    "- `*.vpn`, `*.msi`, `*.exe` — hub-user packages built and saved through the bridge; `msi-Property.txt`, `msi-File.txt`, `msi-build-log.txt`",
    "- `window.png` — screenshot of the running window (placeholder renderer)",
    "",
    "Re-run: `node apps/desktop/tools/smoke-core/run.ts` (add `SMOKE_KEYCHAIN=1` to also exercise the macOS Keychain-sealed master key).",
    "",
  ];
  writeFileSync(path.join(HERE, "REPORT.md"), lines.join("\n"));
}

process.on("SIGINT", () => { killServer(); process.exit(130); });
main().catch(async (e) => {
  console.error(`smoke-core crashed during "${current}":`, e);
  await close();
  killServer();
  checks.push({ name: `crash during: ${current}`, ok: false, detail: String((e as Error)?.message ?? e), ms: 0 });
  writeReport(0);
  process.exitCode = 1;
});
