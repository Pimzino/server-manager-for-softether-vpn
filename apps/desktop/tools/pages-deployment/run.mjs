// E2E for the Client Deployment pages of the desktop app (deploy/Hubs, deploy/Profiles, deploy/Templates,
// deploy/Packages, deploy/Installers, hub/Deploy).
//
// Builds the real app (main + preload exactly like scripts/build.mjs, renderer with the real Vite config) into a
// scratch folder, starts a throwaway SoftEther VPN Server, launches Electron with Playwright `_electron`, and drives
// every page through the UI: at least one read and one write per page, each write checked against the app's API
// and/or the VPN Server with a direct JSON-RPC call. Native Open/Save dialogs are replaced with fakes in the main
// process so file flows run unattended. Writes light + dark screenshots to
// apps/desktop/design-screenshots/pages/deployment/ and report.json next to this file (artifacts/).
//
//   node apps/desktop/tools/pages-deployment/run.mjs
//
// Env: SEM_WORK (scratch dir, default ~/se-desk-pages-deployment), SE_PORT (default 15917),
//      SKIP_BUILD=1 (reuse the last build).
//
// ENDPOINT-SECURITY RULES (company AV quarantined earlier test files and raised a trojan alert):
//  * No official SoftEther client installer is ever downloaded: the GitHub releases listing and the import
//    endpoint are stubbed in the main process (no network), and the import is only exercised up to its error.
//  * No PE/"MZ" content is ever written. The client package fixture is a ZIP of plain-text placeholders
//    named vpnclient.exe / vpncmd.exe / vpncmgr.exe plus hamcore.se2 (a data file). No fake SFX is built.
//  * setup.exe is never built: the app runs with a resources dir WITHOUT the setup-stub launchers, and the
//    "exe" build kind is additionally blocked at the IPC boundary. Only .vpn and MSI builds run.
//  * At the end every file under the work dir and the app data dir is scanned; any "MZ" header fails the run.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const DESK = path.join(REPO, "apps/desktop");
const HERE = import.meta.dirname;
const WORK = process.env.SEM_WORK ?? path.join(os.homedir(), "se-desk-pages-deployment");
const OUT = path.join(WORK, "build");
const RUN = path.join(WORK, "run");
const FILES = path.join(WORK, "files");
const ART = path.join(HERE, "artifacts");
const SHOTS = path.join(DESK, "design-screenshots/pages/deployment");
const SE = path.join(os.homedir(), "se-build/src/build");
const PORT = Number(process.env.SE_PORT ?? 15917);
const ADMIN_PW = "deploy-lab-pw";
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

mkdirSync(ART, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FILES, { recursive: true });
const results = [];
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- build
if (!process.env.SKIP_BUILD) {
  const t0 = Date.now();
  execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), OUT], { stdio: "inherit" });
  execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(OUT, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
  console.log(`build: ${Date.now() - t0} ms`);
}

// ---------------------------------------------------------------- fixtures on disk
// Remove anything an older (non-compliant) version of this script may have left behind.
for (const f of readdirSync(FILES)) if (/\.exe$/i.test(f)) rmSync(path.join(FILES, f), { force: true });
// Client package: a ZIP (store method) of NON-executable placeholders + the real hamcore.se2 (data, not code).
function makeZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = []; let off = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8"), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(10, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const placeholder = (name) => {
  const b = Buffer.from(`SEM E2E PLACEHOLDER — ${name} — plain text, NOT an executable. Developer Edition.\n${randomBytes(2048).toString("hex")}\n`, "utf8");
  if (b[0] === 0x4d && b[1] === 0x5a) throw new Error("placeholder must not start with MZ");
  return b;
};
const pkgZip = path.join(FILES, "sem-test-client-placeholders-x64.zip");
writeFileSync(pkgZip, makeZip([
  ...["vpnclient.exe", "vpncmd.exe", "vpncmgr.exe"].map((n) => ({ name: n, data: placeholder(n) })),
  { name: "hamcore.se2", data: readFileSync(path.join(SE, "hamcore.se2")) },
]));
// Resources for the app WITHOUT the setup.exe launcher stubs: setup.exe builds are structurally impossible.
const RES = path.join(WORK, "resources");
rmSync(RES, { recursive: true, force: true });
mkdirSync(RES, { recursive: true });
copyFileSync(path.join(DESK, "resources/default.ico"), path.join(RES, "default.ico"));
const ICO = path.join(RES, "default.ico");

// ---------------------------------------------------------------- SoftEther VPN Server
function seRpc(method, params = {}, password = ADMIN_PW) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false,
      headers: { authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); j.error ? reject(new Error(`${method}: ${j.error.code} ${j.error.message}`)) : resolve(j.result); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.end(body);
  });
}
const pidFile = path.join(WORK, "vpnserver.pid");
if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } }
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE, f), path.join(RUN, f));
writeFileSync(path.join(RUN, "vpn_server.config"), [
  "# Software Configuration File", "declare root", "{",
  "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
  "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
  "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
].join("\n"));
const log = openSync(path.join(RUN, "vpnserver.log"), "a");
const se = spawn("./vpnserver", ["execsvc"], { cwd: RUN, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
writeFileSync(pidFile, String(se.pid));
const killServer = () => { try { process.kill(-se.pid, "SIGKILL"); } catch { /* gone */ } rmSync(pidFile, { force: true }); };
process.on("exit", killServer);
process.on("SIGINT", () => { killServer(); process.exit(130); });

let app;
const DATA = path.join(WORK, `data-${Date.now()}`);
mkdirSync(DATA, { recursive: true });
try {
  for (let i = 0; ; i++) {
    try { await seRpc("Test", { IntValue_u32: 1 }, ""); break; } catch (e) { if (i > 100) throw e; await sleep(300); }
  }
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  const mkHub = (n, online = true) => seRpc("CreateHub", { HubName_str: n, Online_bool: online, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await mkHub("DEPLOY"); await mkHub("SALES"); await mkHub("LAB", false);
  await seRpc("CreateGroup", { HubName_str: "DEPLOY", Name_str: "staff", Realname_utf: "Staff", Note_utf: "" });
  const mkUser = (hub, name, extra) => seRpc("CreateUser", { HubName_str: hub, Name_str: name, Realname_utf: "", Note_utf: "", GroupName_str: "", ...extra });
  await mkUser("DEPLOY", "alice", { Realname_utf: "Alice Smith", GroupName_str: "staff", AuthType_u32: 1, Auth_Password_str: "Alice-Passw0rd!" });
  await mkUser("DEPLOY", "bob", { Realname_utf: "Bob Jones", AuthType_u32: 1, Auth_Password_str: "Bob-Passw0rd!" });
  await mkUser("DEPLOY", "carol", { Realname_utf: "Carol (RADIUS)", AuthType_u32: 4, RadiusUsername_utf: "carol" });
  await mkUser("DEPLOY", "dave", { Realname_utf: "Dave (certificate)", AuthType_u32: 3, CommonName_utf: "dave" });
  await mkUser("SALES", "erin", { Realname_utf: "Erin", AuthType_u32: 1, Auth_Password_str: "Erin-Passw0rd!" });
  const ver = await seRpc("GetServerInfo");
  check("SoftEther VPN Server started with fixtures", true, `${ver.ServerVersionString_str} on ${PORT}: hubs DEPLOY, SALES, LAB (offline); users alice, bob, carol (RADIUS), dave (cert), erin`);

  // ---------------------------------------------------------------- app
  app = await electron.launch({
    executablePath: require("electron"), args: [OUT],
    env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1", SEM_RESOURCES_DIR: RES }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1360, 880); });
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");
  // Fake native dialogs: the next Open/Save returns whatever the test set (null = cancelled).
  await app.evaluate(({ dialog }) => {
    globalThis.__open = null; globalThis.__save = null;
    dialog.showOpenDialog = async () => (globalThis.__open ? { canceled: false, filePaths: [globalThis.__open] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (globalThis.__save ? { canceled: false, filePath: globalThis.__save } : { canceled: true });
  });
  // Safety guard at the IPC boundary (see header): no GitHub traffic, no setup.exe builds. Optional
  // capabilities override to show the "msitools missing" state. The run aborts if the guard can't be installed.
  const guarded = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const orig = handlers?.get?.("sem:api");
    if (!orig) return false;
    globalThis.__capsMissing = false;
    handlers.set("sem:api", async (e, req) => {
      const p = String(req?.path ?? "");
      if (p.startsWith("/api/deploy/releases")) {
        return { status: 200, body: [{ tag: "v5.02.5187", name: "SoftEther VPN 5.02 Build 5187 (stub)", publishedAt: "2026-09-01T00:00:00Z", assets: ["x64", "x86", "arm64"].map((a) => ({
          name: `softether-vpnclient-5.02.5187.${a}.exe`, url: `https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.02.5187/softether-vpnclient-5.02.5187.${a}.exe`, size: 52_000_000 })) }] };
      }
      if (p.startsWith("/api/deploy/packages/import")) return { status: 403, body: { error: "Blocked by the E2E harness: GitHub downloads are disabled on this machine." } };
      if (/^\/api\/deploy\/hubs\/[^/]+\/[^/]+\/packages/.test(p) && req?.body?.kind === "exe") return { status: 403, body: { error: "Blocked by the E2E harness: setup.exe builds are disabled on this machine." } };
      if (globalThis.__capsMissing && p.startsWith("/api/deploy/capabilities")) {
        return { status: 200, body: { platform: "darwin", vpn: { available: true },
          msi: { available: false, tool: null, version: null, path: null, hint: "MSI building needs msitools. Install it with Homebrew: brew install msitools — then try again (no restart needed)." },
          setupExe: { available: false, arch: [], hint: "MSI building needs msitools." } } };
      }
      return orig(e, req);
    });
    return true;
  });
  if (!guarded) throw new Error("Could not install the IPC safety guard (ipcMain._invokeHandlers missing): aborting before any deploy step");
  const nextOpen = (p) => app.evaluate((_, v) => { globalThis.__open = v; }, p);
  const nextSave = (p) => app.evaluate((_, v) => { globalThis.__save = v; }, p);
  const api = (method, p, body) => page.evaluate(({ method, p, body }) => window.sem.api({ method, path: p, body }), { method, p, body });
  const go = async (hash, title) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.locator("h1.sem-page-title", { hasText: title }).first().waitFor({ timeout: 20_000 });
    await sleep(500);
  };
  const shot = async (name, { dark = true } = {}) => {
    await page.mouse.move(1350, 870);
    // Toasts from earlier steps would cover the content: close them first.
    await page.evaluate(() => document.querySelectorAll(".mantine-Notification-root .mantine-CloseButton-root").forEach((b) => b.click()));
    for (const scheme of dark ? ["light", "dark"] : ["light"]) {
      await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
    }
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
    await page.emulateMedia({ colorScheme: "light" });
    await sleep(200);
  };
  const scrollTo = (testId) => page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: "center" }));
  const pickOption = async (testId, name) => {
    await page.getByTestId(testId).click();
    await page.getByRole("option", { name }).first().click();
    await sleep(200);
  };
  const ctx = async (rowTestId, itemTestId) => {
    await page.getByTestId(rowTestId).click({ button: "right" });
    await page.getByTestId(itemTestId).click();
  };
  const sheetOpen = (id) => page.getByTestId(id).locator(".sem-sheet-body").first().waitFor({ timeout: 15_000 });
  const closeSheet = async (label = "Close") => { await page.locator(".sem-sheet").last().getByRole("button", { name: label, exact: true }).click(); await sleep(400); };

  const probe = await api("POST", "/api/servers/probe", { host: "127.0.0.1", port: PORT });
  const created = await api("POST", "/api/servers", {
    name: "Deploy Lab", host: "127.0.0.1", port: PORT, password: ADMIN_PW, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
  });
  const sid = created.body.id;
  check("connection added (native transport, pinned certificate)", created.status === 201 && created.body.state?.ok, `id ${sid}`);

  // ================================================================ Hub Profiles
  await go("#/deploy/hubs", "Hub Profiles");
  await page.getByTestId(`hub-profile-${sid}-DEPLOY`).waitFor({ timeout: 20_000 });
  const hubRows = await page.getByTestId("hub-profiles-table").locator("tbody tr").count();
  const deployRow = await page.getByTestId(`hub-profile-${sid}-DEPLOY`).innerText();
  check("Hub Profiles: lists every hub of the server with its live profile", hubRows === 3 && /DEPLOY VPN/.test(deployRow) && deployRow.includes(`127.0.0.1:${PORT}`) && /Default/.test(deployRow),
    `${hubRows} rows; DEPLOY row: ${deployRow.replace(/\s+/g, " ")}`);
  await ctx(`hub-profile-${sid}-LAB`, "ctx-disable");
  await sleep(900);
  const hubsAfter = (await api("GET", "/api/deploy/hubs")).body;
  const labRow = await page.getByTestId(`hub-profile-${sid}-LAB`).innerText();
  check("Hub Profiles: context menu Disable Deployment is saved", hubsAfter.find((h) => h.hub === "LAB")?.enabled === false && /Disabled/.test(labRow), `LAB enabled=${hubsAfter.find((h) => h.hub === "LAB")?.enabled}`);
  await shot("01-hub-profiles");
  await page.getByTestId(`hub-profile-${sid}-DEPLOY`).dblclick();
  await page.locator("h1.sem-page-title", { hasText: "Client Deployment" }).waitFor({ timeout: 15_000 });
  check("Hub Profiles: double-click opens the hub’s Client Deployment page", page.url().includes(`/servers/${sid}/hubs/DEPLOY/deploy`), new URL(page.url()).hash);

  // ================================================================ Templates & Branding
  await go("#/deploy/templates", "Templates & Branding");
  await page.getByTestId("template-Default").waitFor({ timeout: 15_000 });
  check("Templates: the default template is listed", /Default/.test(await page.getByTestId("template-Default").innerText()), "Default template row present");
  await page.getByTestId("create-template").click();
  await sheetOpen("template-editor");
  // Validation: empty name + bad base version are reported, and the sheet stays open
  await page.getByTestId("template-tabs").getByText("Installer", { exact: true }).click();
  await page.getByTestId("tpl-base-version").fill("1.x");
  await page.getByTestId("template-save").click();
  await sleep(300);
  const errText = await page.getByTestId("template-errors").innerText().catch(() => "");
  const nameTabActive = await page.getByTestId("template-name").isVisible().catch(() => false);
  check("Templates: validation blocks saving and jumps to the first bad tab", /Fix 2 fields/.test(errText) && nameTabActive, errText);
  await page.getByTestId("template-name").fill("Contoso");
  await page.getByTestId("template-tabs").getByText("Credentials").click();
  await page.getByTestId("tpl-policy-rotate").check({ force: true });
  await page.getByTestId("template-tabs").getByText("Installer").click();
  await page.getByTestId("tpl-base-version").fill("3.1");
  await page.getByTestId("tpl-product-name").fill("Contoso VPN");
  await page.getByTestId("template-tabs").getByText("MSI Branding").click();
  await nextOpen(ICO);
  await page.getByTestId("tpl-icon-upload").click();
  await page.getByTestId("tpl-icon-preview").waitFor({ timeout: 5000 });
  await page.getByTestId("template-tabs").getByText("Client").click();
  await page.getByTestId("tpl-client-name").fill("Contoso VPN");
  await page.getByTestId("tpl-overrides").fill('{ "CM_PRODUCT_NAME": "Contoso VPN" }');
  await shot("02b-template-editor");
  await page.getByTestId("template-save").click();
  await page.getByTestId("template-Contoso").waitFor({ timeout: 10_000 });
  const tpls = (await api("GET", "/api/deploy/templates")).body;
  const contoso = tpls.find((t) => t.name === "Contoso");
  check("Templates: New Template… sheet creates the template with every tab’s settings", contoso && contoso.settings.credentials.passwordUsers === "rotate" && contoso.settings.installer.baseVersion === "3.1"
    && contoso.settings.installer.productName === "Contoso VPN" && contoso.settings.branding.iconIco === readFileSync(ICO).toString("base64") && contoso.settings.client.stringOverrides.CM_PRODUCT_NAME === "Contoso VPN",
    `rotate=${contoso?.settings.credentials.passwordUsers}, base ${contoso?.settings.installer.baseVersion}, icon ${contoso?.settings.branding.iconIco?.length} b64 chars`);
  // Duplicate, then delete the copy through the context menu + confirmation
  await ctx("template-Contoso", "ctx-duplicate");
  await sheetOpen("template-editor");
  await page.getByTestId("template-save").click();
  await page.getByTestId("template-Contoso (copy)").waitFor({ timeout: 10_000 });
  await ctx("template-Contoso (copy)", "ctx-delete");
  await page.getByTestId("delete-template-confirm").click();
  await sleep(900);
  const tplNames = (await api("GET", "/api/deploy/templates")).body.map((t) => t.name);
  check("Templates: Duplicate… then Delete… (confirmed)", !tplNames.includes("Contoso (copy)") && tplNames.includes("Contoso"), tplNames.join(", "));
  await shot("02-templates");

  // ================================================================ Client Packages
  await go("#/deploy/packages", "Client Packages");
  await shot("03a-packages-empty", { dark: false });
  await page.getByTestId("upload-package").click();
  await sheetOpen("package-upload");
  await shot("03c-package-add-sheet", { dark: false });
  await nextOpen(pkgZip);
  await page.getByTestId("package-upload-submit").click();
  await page.locator('[data-testid^="package-"]').filter({ hasText: "sem-test-client-placeholders" }).first().waitFor({ timeout: 30_000 });
  const pkgs = (await api("GET", "/api/deploy/packages")).body;
  const fakePkg = pkgs[0];
  check("Packages: Add Package… uploads a ZIP through the native Open dialog and extracts the files", pkgs.length === 1 && fakePkg.files.some((f) => f.name === "hamcore.se2") && fakePkg.files.some((f) => f.name === "vpnclient.exe") && fakePkg.arch === "x64",
    `${fakePkg?.filename}: ${fakePkg?.files.map((f) => f.name).join(", ")} (${fakePkg?.version || "no version"}, ${fakePkg?.edition})`);
  await page.getByTestId(`package-${fakePkg.id}`).dblclick();
  await page.getByTestId("package-files").waitFor();
  const filesShown = await page.getByTestId("package-files").locator("tbody tr").count();
  check("Packages: double-click opens the inspector with the extracted files", filesShown === fakePkg.files.length, `${filesShown} files`);
  await shot("03d-package-inspector");
  await page.getByTestId("inspector-close").click();
  // GitHub import: listing is stubbed in the main process; the import itself is blocked (never downloads).
  const blocked = await api("POST", "/api/deploy/packages/import", { url: "https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/x/y.exe", arch: "x64" });
  if (blocked.status !== 403 || !/Blocked by the E2E harness/.test(JSON.stringify(blocked.body))) throw new Error("GitHub import guard not active: aborting");
  await page.getByTestId("import-github").click();
  await sheetOpen("github-import");
  const assetsTable = page.getByTestId("github-assets");
  const gotAssets = await assetsTable.locator("tbody tr").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const nAssets = gotAssets ? await assetsTable.locator("tbody tr").count() : 0;
  check("Packages: Import from GitHub lists release assets (listing stubbed, no network)", nAssets === 3, `${nAssets} installers`);
  if (gotAssets) {
    await assetsTable.locator("tbody tr").filter({ hasText: /x64/ }).first().click();
    await shot("03e-github-import", { dark: false });
    await page.getByTestId("github-import-submit").click();
    await sleep(1200);
    const sheetText = await page.getByTestId("github-import").innerText().catch(() => "");
    const stillOpen = await page.getByTestId("github-import").locator(".sem-sheet-body").isVisible().catch(() => false);
    const noGh = !(await api("GET", "/api/deploy/packages")).body.some((p) => p.source === "github");
    check("Packages: a failed import keeps the sheet open and reports the error (download blocked)", stillOpen && noGh && /Blocked by the E2E harness|disabled/i.test(sheetText + (await page.locator(".mantine-Notification-root").allInnerTexts()).join(" ")),
      sheetText.replace(/\s+/g, " ").slice(-160));
  }
  await closeSheet("Cancel");
  await sleep(500);
  await shot("03-packages");

  // ================================================================ Custom Profiles
  await go("#/deploy/profiles", "Custom Profiles");
  await page.getByTestId("create-profile").click();
  await sheetOpen("profile-editor");
  await page.getByTestId("profile-save").click();
  await sleep(300);
  check("Profiles: saving an empty profile shows field errors", /Fix \d+ fields/.test(await page.getByTestId("profile-errors").innerText().catch(() => "")), await page.getByTestId("profile-errors").innerText().catch(() => "none"));
  await page.getByTestId("fill-from-server").click();
  await sheetOpen("fill-sheet");
  await pickOption("fill-server", /Deploy Lab/);
  await pickOption("fill-hub", /^DEPLOY$/);
  await pickOption("fill-user", /^alice/);
  await page.getByTestId("fill-include-hash").check({ force: true });
  await sleep(200);
  await shot("04c-fill-from-server", { dark: false });
  await page.getByTestId("fill-apply").click();
  await page.getByTestId("profile-notice").waitFor({ timeout: 15_000 });
  await page.getByTestId("profile-name").fill("alice-laptop");
  await page.getByTestId("profile-preview").waitFor({ timeout: 10_000 });
  await sleep(600);
  const previewText = await page.getByTestId("profile-preview").innerText();
  const aliceHash = (await seRpc("GetUser", { HubName_str: "DEPLOY", Name_str: "alice" })).HashedKey_bin;
  check("Profiles: Fill from Server… imports endpoint, pinned certificate and alice’s hash; live preview renders", previewText.includes(`byte HashedPassword ${aliceHash}`) && /string Hostname 127\.0\.0\.1/.test(previewText) && /byte ServerCert/.test(previewText),
    `hash ${aliceHash}`);
  await shot("04b-profile-editor");
  await page.getByTestId("profile-save").click();
  await page.getByTestId("profile-alice-laptop").waitFor({ timeout: 10_000 });
  const profs = (await api("GET", "/api/deploy/profiles")).body;
  const aliceRowText = await page.getByTestId("profile-alice-laptop").innerText();
  check("Profiles: the list shows the Startup column (Auto for an always-on profile)", /\bAuto\b/.test(aliceRowText), aliceRowText.replace(/\s+/g, " "));
  check("Profiles: Create Profile saves it (secrets redacted in the list)", profs.length === 1 && profs[0].settings.hashedPassword === "********" && profs[0].settings.hasPassword && profs[0].settings.serverCertPem,
    `${profs[0]?.name}: ${profs[0]?.settings.host}:${profs[0]?.settings.port}/${profs[0]?.settings.hub} user ${profs[0]?.settings.username}`);
  const vpnOut = path.join(FILES, "alice-laptop.vpn");
  rmSync(vpnOut, { force: true });
  await nextSave(vpnOut);
  await ctx("profile-alice-laptop", "ctx-save-vpn");
  await sleep(1200);
  const vpnText = existsSync(vpnOut) ? readFileSync(vpnOut, "utf8") : "";
  check("Profiles: Save .vpn File… writes the real hash (matches GetUser on the server)", vpnText.includes(`byte HashedPassword ${aliceHash}`) && /string Username alice/.test(vpnText), `${vpnText.length} bytes`);
  // Edit: change TCP connections, verify
  await page.getByTestId("profile-alice-laptop").dblclick();
  await sheetOpen("profile-editor");
  await page.getByTestId("profile-max-connection").fill("4");
  await page.getByTestId("profile-save").click();
  await sleep(1200);
  const edited = (await api("GET", "/api/deploy/profiles")).body[0];
  check("Profiles: editing keeps the stored hash and saves the change", edited.settings.maxConnection === 4 && edited.settings.hasPassword, `maxConnection ${edited.settings.maxConnection}`);
  await shot("04-profiles");

  // ================================================================ MSI Installers
  await go("#/deploy/installers", "MSI Installers");
  await page.getByTestId("msi-tool-badge").waitFor({ timeout: 15_000 });
  const badge = await page.getByTestId("msi-tool-badge").innerText();
  const caps = (await api("GET", "/api/deploy/capabilities")).body;
  check("Installers: header shows the MSI toolchain from /api/deploy/capabilities", caps.msi.available && badge.includes(caps.msi.version ?? "~"), `${badge} (${caps.msi.path})`);
  await page.getByTestId("create-installer").click();
  await sheetOpen("installer-wizard");
  await page.getByTestId("wizard-next").click();
  await sleep(200);
  check("Installers: the assistant won’t continue without a name", /installer name/i.test(await page.getByTestId("wizard-errors").innerText().catch(() => "")), await page.getByTestId("wizard-errors").innerText().catch(() => ""));
  await page.getByTestId("installer-name").fill("Contoso Laptops");
  await pickOption("installer-package", new RegExp(fakePkg.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await page.getByTestId("wizard-next").click();
  await page.getByTestId(`wizard-profile-${profs[0].id}`).locator("td.sem-td-check").click();
  await shot("05c-installer-profiles", { dark: false });
  await page.getByTestId("wizard-next").click();
  await shot("05d-installer-options", { dark: false });
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-review").waitFor();
  await shot("05e-installer-review");
  await page.getByTestId("wizard-build").click();
  await page.getByTestId("wizard-result").waitFor({ timeout: 120_000 });
  const builds1 = (await api("GET", "/api/deploy/installers")).body;
  const msi = builds1.find((b) => b.name === "Contoso Laptops");
  check("Installers: Build MSI produces a ready installer", msi?.status === "ready" && msi.size > 100_000, `${msi?.status} ${msi?.size} bytes, version ${msi?.productVersion}`);
  const msiOut = path.join(FILES, "Contoso_Laptops-1.0.0.msi");
  rmSync(msiOut, { force: true });
  await nextSave(msiOut);
  await page.getByTestId("wizard-download").click();
  await sleep(1500);
  let suminfo = "";
  try { suminfo = execFileSync("msiinfo", ["suminfo", msiOut], { encoding: "utf8" }); } catch (e) { suminfo = String(e); }
  check("Installers: Save MSI… writes a valid MSI (msiinfo)", existsSync(msiOut) && /Title|Subject|Author/i.test(suminfo), suminfo.split("\n").filter(Boolean).slice(0, 3).join(" | "));
  await closeSheet("Close");
  await ctx(`installer-${msi.id}`, "ctx-instructions");
  await sheetOpen("deploy-instructions");
  const install = await page.getByTestId("cmd-install").innerText();
  check("Installers: Deployment Instructions show the silent install command", /msiexec \/i "Contoso_Laptops-1\.0\.0\.msi" \/qn/.test(install), install);
  await shot("05f-installer-instructions", { dark: false });
  await closeSheet("Done");
  await ctx(`installer-${msi.id}`, "ctx-log");
  await sheetOpen("build-log");
  await pickOption("build-log-tabs", /^Property$/).catch(() => undefined);
  await sleep(400);
  const hasPropTable = await page.getByTestId("msi-table").isVisible().catch(() => false);
  check("Installers: Build Log… shows the build output and MSI tables", hasPropTable, hasPropTable ? "Property table rendered" : "no table");
  await shot("05g-installer-log", { dark: false });
  await closeSheet("Done");
  // setup.exe: the app runs without launcher stubs, so the real capabilities report it unavailable.
  const exeMissing = await page.getByTestId("exe-missing").innerText().catch(() => "");
  check("Installers: setup.exe capability comes from /api/deploy/capabilities (stubs absent here, so it is unavailable)", caps.setupExe.available === false && /setup\.exe/.test(exeMissing), exeMissing.replace(/\s+/g, " ").slice(0, 140));
  // Simulate a computer without msitools (capabilities override in the IPC guard).
  await app.evaluate(() => { globalThis.__capsMissing = true; });
  await page.evaluate(() => { location.hash = "#/deploy/hubs"; });
  await sleep(300);
  await page.reload();
  await go("#/deploy/installers", "MSI Installers");
  await page.getByTestId("msi-missing").waitFor({ timeout: 10_000 });
  const missing = await page.getByTestId("msi-missing").innerText();
  const disabled = await page.getByTestId("create-installer").isDisabled();
  check("Installers: without msitools the page shows the capabilities hint and disables New Installer…", /brew install msitools/.test(missing) && disabled, missing.replace(/\s+/g, " ").slice(0, 140));
  await shot("05b-installers-msitools-missing");
  await app.evaluate(() => { globalThis.__capsMissing = false; });
  await page.getByTestId("msi-recheck").click();
  await page.getByTestId("msi-missing").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  check("Installers: Check Again re-detects the toolchain (?refresh=1)", !(await page.getByTestId("msi-missing").isVisible().catch(() => false)) && !(await page.getByTestId("create-installer").isDisabled()), "callout gone, button enabled");

  // Pin the Contoso template to the placeholder client package. This is also the Templates edit check.
  await go("#/deploy/templates", "Templates & Branding");
  await page.getByTestId("template-Contoso").dblclick();
  await sheetOpen("template-editor");
  await page.getByTestId("template-tabs").getByText("Installer").click();
  await pickOption("tpl-package", new RegExp(`^${fakePkg.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await page.getByTestId("template-save").click();
  await sleep(1200);
  const pinned = (await api("GET", "/api/deploy/templates")).body.find((t) => t.name === "Contoso");
  check("Templates: editing an existing template (client package) is saved", pinned?.settings.installer.packageId === fakePkg.id, `packageId ${pinned?.settings.installer.packageId}`);

  // ================================================================ Hub › Client Deployment
  await go(`#/servers/${sid}/hubs/DEPLOY/deploy`, "Client Deployment");
  await page.getByTestId("deploy-users-table").waitFor({ timeout: 20_000 });
  const usersText = await page.getByTestId("deploy-users-table").innerText();
  check("Hub deploy: users with their package credential (RADIUS / certificate explained)", /alice/.test(usersText) && /Embedded hash/.test(usersText) && /User enters|Not supported/.test(usersText) && /Not supported/.test(usersText),
    usersText.split("\n").slice(0, 12).join(" | "));
  await shot("06a-hub-deploy-default");
  await pickOption("hub-template", /^Contoso/);
  await page.getByTestId("hub-public-host").fill("vpn.contoso.test");
  await page.getByTestId("hub-public-port").fill("443");
  await page.getByTestId("hub-profile-save").click();
  await sleep(1200);
  const detail = (await api("GET", `/api/deploy/hubs/${sid}/DEPLOY`)).body;
  check("Hub deploy: Save stores template and public endpoint", detail.profile.template.name === "Contoso" && detail.profile.host === "vpn.contoso.test" && detail.profile.port === 443 && detail.credentialPolicy === "rotate",
    `${detail.profile.accountName} → ${detail.profile.host}:${detail.profile.port}, ${detail.profile.template.name}, ${detail.credentialPolicy}`);
  // Preview (hub-wide)
  await page.getByTestId("preview-hub").click();
  await page.getByTestId("preview-content").waitFor({ timeout: 10_000 });
  const pv = await page.getByTestId("preview-content").innerText();
  check("Hub deploy: Preview… renders the hub-wide profile with the public endpoint", /string Hostname vpn\.contoso\.test/.test(pv) && /uint Port 443/.test(pv), pv.split("\n").find((l) => /AccountName/.test(l)) ?? "");
  await shot("06c-hub-preview", { dark: false });
  await closeSheet("Done");
  // Per-user .vpn with the "rotate" policy: the server password changes and the new hash is embedded
  const before = (await seRpc("GetUser", { HubName_str: "DEPLOY", Name_str: "bob" })).HashedKey_bin;
  await page.getByTestId("build-bob").click();
  await page.getByTestId("build-vpn-bob").click();
  await page.getByTestId("build-result").waitFor({ timeout: 30_000 });
  const issued = await page.getByTestId("issued-password").innerText().catch(() => "");
  const afterHash = (await seRpc("GetUser", { HubName_str: "DEPLOY", Name_str: "bob" })).HashedKey_bin;
  await shot("06d-build-result");
  const bobVpn = path.join(FILES, "bob.vpn");
  rmSync(bobVpn, { force: true });
  await nextSave(bobVpn);
  await page.getByTestId("build-result-download").click();
  await page.getByTestId("build-result-saved").waitFor({ timeout: 10_000 });
  const bobText = existsSync(bobVpn) ? readFileSync(bobVpn, "utf8") : "";
  check("Hub deploy: Build › .vpn for bob rotates his password on the server and embeds the new hash", before !== afterHash && bobText.includes(`byte HashedPassword ${afterHash}`) && /New password issued/.test(issued),
    `hash ${before} → ${afterHash}`);
  await closeSheet("Done");
  // Users table: the Last package cell has its own Save button (web parity: per-user download of the last package)
  const bobLast = path.join(FILES, "bob-last.vpn");
  rmSync(bobLast, { force: true });
  await nextSave(bobLast);
  await page.getByTestId("save-last-bob").click();
  await sleep(1200);
  check("Hub deploy: Last package › Save button writes bob’s latest package", existsSync(bobLast) && readFileSync(bobLast, "utf8").includes(`byte HashedPassword ${afterHash}`), existsSync(bobLast) ? `${statSync(bobLast).size} bytes` : "not written");
  // Per-user MSI for alice, via the row's context menu is .vpn only; use the Build menu
  await page.getByTestId("build-alice").click();
  await page.getByTestId("build-msi-alice").click();
  await page.getByTestId("build-result").waitFor({ timeout: 120_000 });
  const msiRes = await page.getByTestId("build-result").innerText();
  await closeSheet("Close");
  // Hub-wide MSI from the header menu. setup.exe stays disabled (no launcher stubs; also blocked at IPC).
  await page.getByTestId("build-hub").click();
  const exeItem = page.getByTestId("build-exe-hub");
  const exeDisabled = (await exeItem.count()) === 0 || await exeItem.isDisabled().catch(() => false) || (await exeItem.getAttribute("data-disabled").catch(() => null)) === "true";
  check("Hub deploy: Build › setup.exe is disabled when the capability is missing", exeDisabled, "menu item disabled");
  await page.getByTestId("build-msi-hub").click();
  await page.getByTestId("build-result").waitFor({ timeout: 120_000 });
  await closeSheet("Close");
  await sleep(1000);
  const builds = (await api("GET", `/api/deploy/hubs/${sid}/DEPLOY`)).body.builds;
  check("Hub deploy: per-user MSI and hub-wide MSI build and appear under Recent packages",
    builds.some((b) => b.kind === "msi" && b.username === "alice") && builds.some((b) => b.kind === "msi" && b.username === null) && !builds.some((b) => b.kind === "exe"),
    `${builds.map((b) => `${b.kind}:${b.username ?? "hub"}`).join(", ")} | ${msiRes.split("\n")[0]}`);
  const rowsShown = await page.getByTestId("deploy-builds-table").locator("tbody tr").count();
  check("Hub deploy: Recent packages table lists them", rowsShown === builds.length, `${rowsShown} rows`);
  await scrollTo("deploy-users-table");
  await shot("06-hub-deploy");
  await scrollTo("deploy-builds-table");
  await shot("06b-hub-deploy-packages");

  // Installers page again: hub packages are listed too, and the filter works
  await go("#/deploy/installers", "MSI Installers");
  await page.getByTestId(`installer-${msi.id}`).waitFor({ timeout: 10_000 });
  const allRows = await page.getByTestId("installers-table").locator("tbody tr").count();
  await page.getByTestId("installers-filter").getByText("Hub Packages").click();
  await sleep(300);
  const hubOnly = await page.getByTestId("installers-table").locator("tbody tr").count();
  await page.getByTestId("installers-filter").getByText("All", { exact: true }).click();
  check("Installers: custom MSIs and hub packages in one table, filterable", allRows === builds.length + 1 && hubOnly === builds.length, `${allRows} all, ${hubOnly} hub`);
  await shot("05-installers");
  // Delete the hub-wide MSI build through the context menu
  const hubBuild = (await api("GET", "/api/deploy/installers")).body.find((b) => b.kind === "msi" && b.hub === "DEPLOY" && !b.username);
  if (hubBuild) {
    await ctx(`installer-${hubBuild.id}`, "ctx-delete");
    await page.getByTestId("delete-installer-confirm").click();
    await sleep(900);
    const gone = !(await api("GET", "/api/deploy/installers")).body.some((b) => b.id === hubBuild.id);
    check("Installers: Delete… (confirmed) removes a build", gone, `build ${hubBuild.id}`);
  } else check("Installers: Delete… (confirmed) removes a build", false, "hub-wide MSI build not found in /api/deploy/installers");

  // Hub Profiles again (after the hub was configured)
  await go("#/deploy/hubs", "Hub Profiles");
  await sleep(500);
  await shot("01b-hub-profiles-configured", { dark: false });

  const filtered = problems.filter((p) => !/Failed to load resource/.test(p));
  check("no console errors, page errors or CSP violations", filtered.length === 0, filtered.slice(0, 4).join(" | ") || "none");
} catch (e) {
  check("run completed", false, e?.stack ?? e);
  try { await (await app?.firstWindow())?.screenshot({ path: path.join(ART, "failure.png") }); } catch { /* no window */ }
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  killServer();
  // Safety scan: nothing this run wrote may carry a PE ("MZ") header.
  const mz = [];
  const walk = (d) => {
    for (const n of (() => { try { return readdirSync(d); } catch { return []; } })()) {
      if (n.startsWith("._")) continue;
      const f = path.join(d, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) { if (f !== OUT) walk(f); continue; }
      try { const fd = openSync(f, "r"); const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); if (b[0] === 0x4d && b[1] === 0x5a) mz.push(f); } catch { /* unreadable */ }
    }
  };
  walk(WORK); walk(DATA);
  for (const n of readdirSync(os.tmpdir())) if (/^sem-(msi|pkg)-/.test(n)) walk(path.join(os.tmpdir(), n));
  check("safety: no PE/MZ file written under the work dir, the app data dir or build temp dirs", mz.length === 0, mz.join(", ") || "none");
  if (process.env.KEEP_DATA || results.some((r) => !r.ok)) console.log(`data dir kept: ${DATA}`); else rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
writeFileSync(path.join(ART, "report.json"), JSON.stringify({
  at: new Date().toISOString(), port: PORT, passed: results.length - failed, failed, results,
  screenshots: readdirSync(SHOTS).filter((f) => f.endsWith(".png") && !f.startsWith("._")).sort(),
}, null, 2));
console.log(`${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
