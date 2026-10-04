// E2E for the "server-advanced" pages of the desktop app: Clustering, Server Settings, Logs & Syslog,
// Configuration & Backups and API Console. Builds the real app (main + preload like scripts/build.mjs, real Vite
// renderer) into a scratch directory, starts a throwaway SoftEther VPN Server, launches Electron with Playwright
// `_electron` (fresh SEM_DATA_DIR, SEM_INSECURE_KEYSTORE=1), drives every page through the UI and checks each
// write on the server with a direct JSON-RPC call. Native Open/Save dialogs are replaced by fakes.
//
//   node apps/desktop/tools/pages-server-advanced/run.mjs            (SKIP_BUILD=1 reuses the last build)
//
// Output: apps/desktop/tools/pages-server-advanced/artifacts/report.json (+ log) and light/dark screenshots in
// apps/desktop/design-screenshots/pages/server-advanced/. The vpnserver process group is always killed.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const DESK = path.join(REPO, "apps/desktop");
const HERE = import.meta.dirname;
const ART = path.join(HERE, "artifacts");
const SHOTS = path.join(DESK, "design-screenshots/pages/server-advanced");
const OUT = process.env.SA_BUILD_DIR ?? path.join(os.tmpdir(), "sem-pages-server-advanced", "build");
const RUN = process.env.SA_RUN_DIR ?? path.join(os.homedir(), "se-desk-pages-server-advanced");
const SE = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const PORT = Number(process.env.SA_PORT ?? 15913);
let ADMIN_PW = "advpass";
const CONN = "Advanced Lab";
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- build
if (!process.env.SKIP_BUILD) {
  const t0 = Date.now();
  execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), OUT], { stdio: "inherit" });
  execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(OUT, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
  console.log(`build: ${Date.now() - t0} ms → ${OUT}`);
}

// ---------------------------------------------------------------- SoftEther VPN Server
function seRpc(method, params = {}, password = ADMIN_PW, user = "administrator") {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false, timeout: 15_000,
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); j.error ? reject(new Error(`${method}: ${j.error.code} ${j.error.message}`)) : resolve(j.result); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end(body);
  });
}
async function waitRpc(method, params = {}, until = () => true, timeoutMs = 60_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await seRpc(method, params); if (until(r)) return r; last = r; } catch (e) { last = e; }
    await sleep(700);
  }
  throw new Error(`timed out waiting for ${method}: ${last instanceof Error ? last.message : JSON.stringify(last).slice(0, 200)}`);
}

const pidFile = path.join(RUN, "vpnserver.pid");
if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } await sleep(800); }
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE, f), path.join(RUN, f));
writeFileSync(path.join(RUN, "vpn_server.config"), [
  "# Software Configuration File", "declare root", "{",
  "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
  "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
  "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
].join("\n"));
const seLog = openSync(path.join(RUN, "vpnserver.log"), "a");
const se = spawn("./vpnserver", ["execsvc"], { cwd: RUN, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, stdio: ["ignore", seLog, seLog], detached: true });
writeFileSync(pidFile, String(se.pid));
let killed = false;
const killServer = () => {
  if (killed) return;
  killed = true;
  try { process.kill(-se.pid, "SIGTERM"); } catch { /* gone */ }
  try { execFileSync("sleep", ["1"]); } catch { /* ignore */ }
  try { process.kill(-se.pid, "SIGKILL"); } catch { /* gone */ }
  rmSync(pidFile, { force: true });
};
process.on("exit", killServer);
process.on("SIGINT", () => { killServer(); process.exit(130); });

let app;
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-pages-sa-"));
const OPEN_FILE = path.join(ART, "upload.config");
let SAVE_FILE = path.join(ART, "saved.bin");
let page;
const problems = [];

async function goto(hash, ready) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  if (ready) await page.getByTestId(ready).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
}
async function theme(scheme) {
  await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction((s) => document.documentElement.getAttribute("data-mantine-color-scheme") === s, scheme, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function clearToasts() {
  await page.evaluate(() => document.querySelectorAll(".mantine-Notification-root .mantine-CloseButton-root, .mantine-Notification-closeButton").forEach((b) => b.click()));
  await page.waitForTimeout(350);
}
async function scrollTop() {
  await page.evaluate(() => document.querySelectorAll("*").forEach((el) => { if (el.scrollTop > 0 && !el.classList.contains("sa-text") && !el.classList.contains("sa-picker-list")) el.scrollTop = 0; }));
  await page.waitForTimeout(200);
}
async function shots(name, opts = {}) {
  // page.screenshot() captures web contents only: the macOS vibrancy behind the transparent sidebar isn't in the
  // image, so paint the sidebar with the design system's no-vibrancy fallback (as in browser mode) for captures.
  await page.evaluate(() => {
    if (document.getElementById("sa-shot-style")) return;
    const st = document.createElement("style");
    st.id = "sa-shot-style";
    st.textContent = ".sem-sidebar{background:var(--sem-bg-sidebar)!important}.sem-sb-status{background:var(--sem-bg-sidebar)}";
    document.head.appendChild(st);
  });
  await clearToasts();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  if (opts.top) await scrollTop();
  for (const scheme of ["light", "dark"]) {
    await theme(scheme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
  await theme("light");
}
async function setSave(p) {
  SAVE_FILE = p;
  rmSync(p, { force: true });
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, p);
}
/** Wait until a file written by the app exists and its size stopped changing. */
async function waitFile(p, timeoutMs = 15_000) {
  let last = -1;
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(250)) {
    if (!existsSync(p)) continue;
    const n = statSync(p).size;
    if (n > 0 && n === last) return readFileSync(p);
    last = n;
  }
  return existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
}
async function typeConfirm(prefix, text) {
  await page.getByTestId(`${prefix}-dialog`).waitFor({ timeout: 10_000 });
  if (text !== undefined) await page.getByTestId(`${prefix}-dialog`).getByTestId("confirm-type").fill(text);
  await page.getByTestId(`${prefix}-confirm`).click();
}
async function pickSelect(testId, option) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function step(name, fn) {
  try { await fn(); } catch (e) {
    check(`${name} (threw)`, false, e.stack ?? e.message);
    await page?.screenshot({ path: path.join(ART, `error-${name.replace(/\W+/g, "_")}.png`) }).catch(() => {});
  }
}

try {
  for (let i = 0; ; i++) {
    try { await seRpc("Test", { IntValue_u32: 1 }, ""); break; } catch (e) { if (i > 120) throw e; await sleep(300); }
  }
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  await seRpc("CreateHub", { HubName_str: "DEFAULT", Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await seRpc("CreateHub", { HubName_str: "SALES", Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await seRpc("CreateUser", { HubName_str: "DEFAULT", Name_str: "alice", Realname_utf: "Alice", Note_utf: "", AuthType_u32: 1, Auth_Password_str: "alicepw" });
  await seRpc("EnableSecureNAT", { HubName_str: "DEFAULT" });
  const info = await seRpc("GetServerInfo");
  check("SoftEther VPN Server started", true, `${info.ServerVersionString_str} ${info.ServerBuildInfoString_str} on port ${PORT}`);

  // ---------------------------------------------------------------- app
  app = await electron.launch({
    executablePath: require("electron"), args: [OUT],
    env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000,
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1360, 880); });
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p.open] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p.save });
  }, { open: OPEN_FILE, save: SAVE_FILE });

  const created = await page.evaluate(async ({ port, pw, name }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name, host: "127.0.0.1", port, password: pw, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint } });
  }, { port: PORT, pw: ADMIN_PW, name: CONN });
  check("connection added (native transport, pinned certificate)", created.status === 201 && created.body.state?.ok, `id ${created.body.id}, ok ${created.body.state?.ok}`);
  const sid = created.body.id;
  await page.reload();
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
  const pinned = created.body.fingerprint;
  const base = `#/servers/${sid}`;
  const appApi = (method, p, body) => page.evaluate((a) => window.sem.api(a), { method, path: p, body });

  // ================================================================ Server Settings
  await step("settings", async () => {
    await goto(`${base}/settings`, "keep-section");
    await page.getByTestId("keep-host").waitFor();
    const keep = await seRpc("GetKeep");
    const shownHost = await page.getByTestId("keep-host").inputValue();
    const optRows = await page.getByTestId("default-admin-options-table").locator("tbody tr").count();
    const opts = await seRpc("GetDefaultHubAdminOptions", { HubName_str: "DEFAULT" });
    check("Settings: reads keep-alive (GetKeep) and default hub admin options", shownHost === keep.KeepConnectHost_str && optRows === opts.AdminOptionList.length,
      `host "${shownHost}" = "${keep.KeepConnectHost_str}"; ${optRows} rows = ${opts.AdminOptionList.length} options`);
    await shots("settings", { top: true });
    // write: keep-alive
    if (!(await page.getByTestId("keep-enable").isChecked())) await page.getByTestId("keep-enable").click({ force: true });
    await page.getByTestId("keep-host").fill("keepalive.example.net");
    await page.getByTestId("keep-interval").fill("77");
    await page.getByTestId("keep-protocol").getByText("TCP", { exact: true }).click();
    await page.getByTestId("save-keep").click();
    const k2 = await waitRpc("GetKeep", {}, (r) => r.KeepConnectInterval_u32 === 77, 10_000);
    check("Settings: Save keep-alive writes SetKeep", k2.UseKeepConnect_bool === true && k2.KeepConnectHost_str === "keepalive.example.net" && k2.KeepConnectProtocol_u32 === 0,
      JSON.stringify(k2));
    // validation
    await page.getByTestId("keep-interval").fill("2");
    const invalidShown = await page.getByText("Enter 5 to 600 seconds.").isVisible();
    const saveDisabled = await page.getByTestId("save-keep").isDisabled();
    await page.getByTestId("save-keep-reset").click();
    check("Settings: invalid interval is flagged and blocks Save", invalidShown && saveDisabled, `message ${invalidShown}, save disabled ${saveDisabled}`);
    // write: syslog
    await pickSelect("syslog-type", "Server log");
    await page.getByTestId("syslog-host").fill("127.0.0.1");
    await page.getByTestId("syslog-port").fill("5514");
    await page.getByTestId("save-syslog").click();
    const sl = await waitRpc("GetSysLog", {}, (r) => r.Port_u32 === 5514, 10_000);
    check("Settings: Save syslog writes SetSysLog", sl.SaveType_u32 === 1 && sl.Hostname_str === "127.0.0.1", JSON.stringify(sl));
    await page.getByTestId("keep-section").scrollIntoViewIfNeeded();
  });

  // ================================================================ Logs & Syslog
  await step("logs", async () => {
    await goto(`${base}/logs`, "log-files-table");
    await page.getByTestId("log-files-table").locator("tbody tr").first().waitFor();
    const files = (await seRpc("EnumLogFile")).LogFiles;
    const rows = await page.getByTestId("log-files-table").locator("tbody tr").count();
    const summary = await page.getByTestId("syslog-summary").innerText();
    check("Logs: lists every log file (EnumLogFile) and the syslog state", rows === files.length && /Server log to 127\.0\.0\.1:5514/.test(summary), `${rows} rows / ${files.length} files; "${summary}"`);
    await shots("logs", { top: true });
    // filter by type
    await page.getByTestId("log-category").getByText(/^Security/).click();
    const secRows = await page.getByTestId("log-files-table").locator("tbody tr").count();
    const secFiles = files.filter((f) => f.FilePath_str.startsWith("security_log")).length;
    check("Logs: type filter", secRows === secFiles, `${secRows} rows = ${secFiles} security logs`);
    await page.getByTestId("log-category").getByText(/^All/).click();
    // open the newest server log
    const srv = files.filter((f) => f.FilePath_str.startsWith("server_log")).sort((a, b) => b.FilePath_str.localeCompare(a.FilePath_str))[0];
    const rowId = `log-row-${srv.FilePath_str.replace(/[\\/]/g, "_")}`;
    await page.getByTestId(rowId).dblclick();
    await page.getByTestId("log-content").waitFor({ timeout: 20_000 });
    const disk = readFileSync(path.join(RUN, srv.FilePath_str), "utf8");
    const diskLines = disk.split(/\r?\n/).filter(Boolean);
    const firstLine = diskLines[Math.min(3, diskLines.length - 1)];
    const viewerText = await page.getByTestId("log-content").innerText();
    check("Logs: viewer shows the file’s content (ReadLogFile)", viewerText.includes(firstLine.slice(0, 60)), `looked for "${firstLine.slice(0, 60)}"`);
    await page.getByTestId("log-search").fill("JSON-API");
    await page.waitForTimeout(300);
    const hits = await page.getByTestId("log-matches").innerText().catch(() => "none");
    check("Logs: find highlights matching lines", /[1-9]\d* matching/.test(hits), hits);
    await shots("logs-viewer");
    // Save As… the whole file
    await setSave(path.join(ART, "saved-server.log"));
    await page.getByTestId("log-download").click();
    const saved = await waitFile(SAVE_FILE);
    const diskNow = readFileSync(path.join(RUN, srv.FilePath_str));
    check("Logs: Save As… writes the whole file (byte-identical prefix of the file on disk)", saved.length > 0 && diskNow.subarray(0, saved.length).equals(saved) && saved.length >= disk.length * 0.9,
      `saved ${saved.length} B, disk ${diskNow.length} B`);
    await page.getByTestId("log-close").click();
    // Syslog sheet (write)
    await page.getByTestId("open-syslog").click();
    await page.getByTestId("syslog-port").waitFor();
    await page.getByTestId("syslog-port").fill("5515");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, "logs-syslog-sheet-light.png") });
    await page.getByTestId("save-syslog").click();
    const sl = await waitRpc("GetSysLog", {}, (r) => r.Port_u32 === 5515, 10_000);
    check("Logs: Syslog… sheet writes SetSysLog", sl.Port_u32 === 5515 && sl.SaveType_u32 === 1, JSON.stringify(sl));
  });

  // ================================================================ API Console
  await step("console", async () => {
    await goto(`${base}/console`, "console-method-picker");
    await shots("console-empty", { top: true });
    await page.getByTestId("console-method-search").fill("GetServerInfo");
    await page.getByTestId("console-method-GetServerInfo").click();
    await page.getByTestId("console-execute").click();
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const status = await page.getByTestId("console-result-status").innerText();
    await page.getByTestId("console-result").getByText("Text", { exact: true }).click();
    const txt = await page.getByTestId("console-result-text").innerText();
    const r = JSON.parse(txt);
    check("Console: read method (GetServerInfo) returns the server’s data", status === "Success" && r.ServerBuildInt_u32 === info.ServerBuildInt_u32, `${status}, build ${r.ServerBuildInt_u32}`);
    // write: CreateHub through the generated form
    await page.getByTestId("console-method-search").fill("CreateHub");
    await page.getByTestId("console-method-CreateHub").click();
    await page.getByTestId("rpc-field-HubName_str").fill("CONSOLEHUB");
    await page.getByTestId("rpc-field-Online_bool").check({ force: true });
    await page.getByTestId("console-execute").click();
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const hubs = (await seRpc("EnumHub")).HubList.map((h) => h.HubName_str);
    check("Console: write method (CreateHub) through the generated form", hubs.includes("CONSOLEHUB"), hubs.join(", "));
    await page.getByTestId("console-method-search").fill("");
    await page.getByTestId("console-result").scrollIntoViewIfNeeded();
    await shots("console-result");
    // Load current values: SetKeep ← GetKeep
    await page.getByTestId("console-method-search").fill("SetKeep");
    await page.getByTestId("console-method-SetKeep").click();
    await page.getByTestId("console-load-current").click();
    await page.waitForTimeout(800);
    const host = await page.getByTestId("rpc-field-KeepConnectHost_str").inputValue();
    check("Console: Load Current Values fills the form from the Get counterpart", host === "keepalive.example.net", host);
    // danger: Flush needs the method name typed
    await page.getByTestId("console-method-search").fill("Flush");
    await page.getByTestId("console-method-Flush").click();
    const danger = await page.getByTestId("console-danger").waitFor({ timeout: 5000 }).then(() => true, () => false);
    await page.getByTestId("console-execute").click();
    await page.getByTestId("confirm-dialog").waitFor();
    const ftitle = await page.getByTestId("confirm-dialog").innerText();
    await typeConfirm("confirm");
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const fstatus = await page.getByTestId("console-result-status").innerText();
    check("Console: danger method (Flush) is confirmed first, then runs", danger && /Write the configuration to disk now/.test(ftitle) && fstatus === "Success", `callout ${danger}, "${ftitle.split("\n")[0]}", ${fstatus}`);
    // irreversible danger: DeleteHub needs the hub name typed
    await page.getByTestId("console-method-search").fill("DeleteHub");
    await page.getByTestId("console-method-DeleteHub").click();
    await page.getByTestId("console-hub").fill("CONSOLEHUB");
    await page.keyboard.press("Escape");
    await page.getByTestId("console-execute").click();
    await page.getByTestId("confirm-dialog").waitFor();
    const blocked = await page.getByTestId("confirm-confirm").isDisabled();
    // ⌘↩ while the confirmation is open must not stack a second dialog (parity review fix).
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(500);
    const stacked = await page.getByTestId("confirm-dialog").count();
    check("Console: ⌘↩ while a confirmation is open doesn’t open a second one", stacked === 1, `${stacked} dialog(s)`);
    await page.getByTestId("confirm-dialog").getByTestId("confirm-type").focus();
    await page.screenshot({ path: path.join(SHOTS, "console-danger-confirm-light.png") });
    await typeConfirm("confirm", "CONSOLEHUB");
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const hubsDel = (await waitRpc("EnumHub", {}, (x) => !(x.HubList ?? []).some((h) => h.HubName_str === "CONSOLEHUB"), 10_000)).HubList.map((h) => h.HubName_str);
    check("Console: DeleteHub needs the hub name typed, then deletes it", blocked && !hubsDel.includes("CONSOLEHUB"), `blocked until typed ${blocked}; hubs ${hubsDel.join(", ")}`);
    // error path
    await page.getByTestId("console-method-search").fill("GetHub");
    await page.getByTestId("console-method-GetHub").click();
    await page.getByTestId("console-hub").fill("NOPE");
    await page.keyboard.press("Escape");
    await page.getByTestId("console-execute").click();
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const est = await page.getByTestId("console-result-status").innerText();
    const etext = await page.getByTestId("console-result").innerText();
    check("Console: SoftEther errors show the code", est === "Error" && /SoftEther error \d+/.test(etext), etext.replace(/\s+/g, " ").slice(0, 160));
    // history
    const hrows = await page.getByTestId("console-history").getByTestId("console-history-row").count();
    await page.getByTestId("console-history").getByTestId("console-history-row").last().dblclick();
    await page.waitForTimeout(600);
    const restored = await page.getByTestId("console-method-name").innerText();
    check("Console: history lists calls; double-click restores one", hrows >= 5 && restored === "GetServerInfo", `${hrows} rows, restored ${restored}`);
    // keyboard: arrow down in the method list
    await page.getByTestId("console-method-search").fill("");
    await page.getByTestId("console-method-GetServerInfo").click();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    const next = await page.getByTestId("console-method-name").innerText();
    check("Console: ↓ in the method list selects the next method", next !== "GetServerInfo", next);
  });

  // ================================================================ API Console in hub admin mode (review)
  await step("console-hubadmin", async () => {
    const h = await seRpc("GetHub", { HubName_str: "SALES" });
    await seRpc("SetHub", { ...h, HubName_str: "SALES", AdminPasswordPlainText_str: "salespw" });
    const c2 = await appApi("POST", "/api/servers", {
      name: "Sales Hub Admin", host: "127.0.0.1", port: PORT, hub: "SALES", password: "salespw", savePassword: true, transport: "native", tlsMode: "pin", fingerprint: pinned });
    check("Hub admin: connection added in hub admin mode (SALES)", c2.status === 201 && c2.body.state?.ok, `status ${c2.status}, ok ${c2.body.state?.ok} ${c2.body.state?.error ?? ""}`);
    const sid2 = c2.body.id;
    await goto(`#/servers/${sid2}/console`, "console-method-picker");
    const foot = await page.locator(".sa-picker-foot").innerText();
    const n = Number((foot.match(/(\d+)/) ?? [])[1]);
    const hasDelete = await page.getByTestId("console-method-SetKeep").count() + await page.getByTestId("console-method-EnumListener").count();
    await page.getByTestId("console-method-search").fill("SetHub");
    await page.getByTestId("console-method-SetHub").click();
    const hubVal = await page.getByTestId("console-hub").inputValue();
    const ro = (await page.getByTestId("console-hub").getAttribute("readonly")) !== null;
    check("Hub admin: the console lists only hub-scoped methods and pins the hub", n > 0 && n < 148 && hasDelete === 0 && hubVal === "SALES" && ro, `${foot}; server-only methods (SetKeep, EnumListener) listed ${hasDelete}; hub "${hubVal}" read-only ${ro}`);
    await shots("console-hubadmin", { top: true });
    await page.getByTestId("console-load-current").click();
    await page.waitForTimeout(800);
    await page.getByTestId("rpc-field-AdminPasswordPlainText_str").fill("salespw2");
    await page.getByTestId("console-execute").click();
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const st = await page.getByTestId("console-result-status").innerText();
    let conn;
    for (let i = 0; i < 20; i++) { conn = (await appApi("POST", `/api/servers/${sid2}/refresh`)).body; if (conn?.state?.ok) break; await sleep(500); }
    const newOk = await seRpc("GetHubStatus", { HubName_str: "SALES" }, "salespw2", "SALES").then(() => true, () => false);
    check("Hub admin: SetHub with a new hub password keeps this connection working (saved password updated)", st === "Success" && conn?.state?.ok && newOk,
      `${st}; connection ok ${conn?.state?.ok} ${conn?.state?.error ?? ""}; new password accepted by the server ${newOk}`);
  });

  // ================================================================ Clustering
  await step("cluster", async () => {
    await goto(`${base}/cluster`, "farm-type");
    const cur = await page.getByTestId("farm-current-type").innerText();
    check("Cluster: shows the role (GetFarmSetting)", cur === "Standalone server", cur);
    await shots("cluster-standalone", { top: true });
    // member form validation (not applied)
    await page.getByTestId("farm-type").getByText("Member", { exact: true }).click();
    await page.getByTestId("farm-controller-name").waitFor();
    const pwErr = await page.getByText("Enter the controller’s administrator password.").isVisible();
    const nameErr = await page.getByText("Enter the controller’s host name or IP address.").isVisible();
    const applyDisabled = await page.getByTestId("save-farm").isDisabled();
    check("Cluster: member form validates before Apply", pwErr && nameErr && applyDisabled, `password ${pwErr}, name ${nameErr}, apply disabled ${applyDisabled}`);
    await page.getByTestId("farm-controller-name").fill("controller.example.com");
    await shots("cluster-member-form", { top: true });
    // A bad public port typed on the member form must not block applying another role (review fix).
    await page.getByTestId("farm-ports").fill("99999");
    await page.keyboard.press("Enter");
    const portErr = await page.getByText("Not a port number: 99999").isVisible();
    await page.getByTestId("farm-type").getByText("Standalone", { exact: true }).click();
    await page.getByTestId("farm-weight").fill("120");
    const applyOk = await page.getByTestId("save-farm").isEnabled();
    check("Cluster: a bad member port is flagged, and ignored once the role is no longer Member", portErr && applyOk, `port error ${portErr}, Apply enabled after switching to Standalone ${applyOk}`);
    await page.getByTestId("save-farm-reset").click();
    // write: become a controller with weight 150
    await page.getByTestId("farm-type").getByText("Controller", { exact: true }).click();
    await page.getByTestId("farm-weight").fill("150");
    await page.getByTestId("save-farm").click();
    await page.getByTestId("confirm-dialog").waitFor();
    await page.screenshot({ path: path.join(SHOTS, "cluster-confirm-light.png") });
    await typeConfirm("confirm", CONN);
    const farm = await waitRpc("GetFarmSetting", {}, (x) => x.ServerType_u32 === 1, 60_000);
    check("Cluster: Apply writes SetFarmSetting (controller, weight 150)", farm.ServerType_u32 === 1 && farm.Weight_u32 === 150, JSON.stringify({ type: farm.ServerType_u32, weight: farm.Weight_u32 }));
    // members table: wait until the page shows the controller row
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      ok = await page.getByTestId("farm-members-table").locator("tbody tr").first().isVisible().catch(() => false);
      if (!ok) { await sleep(1500); if (i % 5 === 4) await goto(`${base}/logs`).then(() => goto(`${base}/cluster`)); }
    }
    const members = (await waitRpc("EnumFarmMember", {}, (x) => (x.FarmMemberList ?? []).length > 0, 30_000)).FarmMemberList;
    const mrows = await page.getByTestId("farm-members-table").locator("tbody tr").count();
    check("Cluster: members table (EnumFarmMember) shows the controller", ok && mrows === members.length, `${mrows} rows, ${members.length} members`);
    await page.getByTestId(`farm-member-${members[0].Id_u32}`).dblclick();
    await page.getByTestId("farm-member-fp").waitFor({ timeout: 15_000 });
    const fpMatch = await page.getByTestId("farm-member-fp").getAttribute("aria-label").catch(() => null);
    const fpText = (await page.getByTestId("farm-member-fp").innerText()).replace(/[^0-9A-F]/gi, "").toUpperCase();
    const inspText = await page.getByTestId("farm-member-inspector").innerText().catch(() => "");
    const headers = await page.getByTestId("farm-members-table").locator("thead th").allInnerTexts();
    check("Cluster: point is labelled as free capacity (highest score gets new sessions, Server.c)", /Free capacity/.test(inspText) && headers.some((h) => /^Score/.test(h.trim())) && !headers.some((h) => /^Load/.test(h.trim())),
      `inspector ${/Free capacity/.test(inspText)}; headers ${headers.map((h) => h.trim()).join(" | ")}`);
    check("Cluster: member inspector (GetFarmInfo) shows the certificate fingerprint = pinned one", fpText.includes(pinned.replace(/[^0-9A-F]/gi, "").toUpperCase()), `${fpText.slice(0, 20)}… vs pinned ${pinned.slice(0, 20)}… ${fpMatch ?? ""}`);
    await shots("cluster-controller", { top: true });
    await page.getByTestId("inspector-close").click();
    // back to standalone
    await page.getByTestId("farm-type").getByText("Standalone", { exact: true }).click();
    await page.getByTestId("save-farm").click();
    await typeConfirm("confirm", CONN);
    const back = await waitRpc("GetFarmSetting", {}, (x) => x.ServerType_u32 === 0, 60_000);
    check("Cluster: back to standalone", back.ServerType_u32 === 0, `type ${back.ServerType_u32}`);
    await waitRpc("EnumHub", {}, (x) => (x.HubList ?? []).some((h) => h.HubName_str === "DEFAULT"), 60_000);
  });

  // ================================================================ Configuration & Backups
  await step("config", async () => {
    // make sure the app sees the server again after the cluster restarts
    for (let i = 0; i < 30; i++) {
      const s = await appApi("POST", `/api/servers/${sid}/refresh`).catch(() => null);
      if (s?.body?.state?.ok || s?.body?.ok) break;
      await sleep(1000);
    }
    await goto(`${base}/config`, "backup-new");
    await shots("config-empty", { top: true });
    // on-demand backup
    await page.getByTestId("backup-new").click();
    await page.getByTestId("backup-note").fill("e2e manual one");
    await page.getByTestId("create-backup").click();
    await page.getByTestId("backups-table").locator("tbody tr").first().waitFor({ timeout: 20_000 });
    const liveA = Buffer.from((await seRpc("GetConfig")).FileData_bin, "base64").toString("utf8");
    const list1 = (await appApi("GET", `/api/servers/${sid}/backups`)).body;
    const b1 = list1.find((b) => b.note === "e2e manual one");
    check("Config: Back Up Now stores a snapshot equal to GetConfig", !!b1 && b1.sha256 === sha(liveA), b1 ? `#${b1.id} ${b1.sha256.slice(0, 12)} vs live ${sha(liveA).slice(0, 12)}` : "no backup");
    // change the server, second backup
    await seRpc("CreateHub", { HubName_str: "CFGTEMP", Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
    await page.getByTestId("backup-new").click();
    await page.getByTestId("backup-note").fill("after CFGTEMP");
    await page.getByTestId("create-backup").click();
    await page.waitForTimeout(1500);
    const list2 = (await appApi("GET", `/api/servers/${sid}/backups`)).body;
    const b2 = list2.find((b) => b.note === "after CFGTEMP");
    const rows = await page.getByTestId("backups-table").locator("tbody tr").count();
    check("Config: backups table lists every snapshot", !!b2 && rows === list2.length, `${rows} rows / ${list2.length} backups`);
    // compare the two selected snapshots
    await page.getByTestId(`backup-row-${b1.id}`).click();
    await page.getByTestId(`backup-row-${b2.id}`).click({ modifiers: ["Meta"] });
    await shots("config-backups", { top: true });
    await page.getByTestId("backups-compare").click();
    await page.getByTestId("diff-view").waitFor({ timeout: 15_000 });
    const addLines = await page.getByTestId("diff-view").locator('tr[data-difftype="add"]').allInnerTexts();
    check("Config: comparing two snapshots shows the new hub as added lines", addLines.some((l) => l.includes("CFGTEMP")), `${addLines.length} added lines`);
    await shots("config-diff");
    await page.getByRole("button", { name: "Done" }).last().click();
    // compare with live (context menu)
    await page.getByTestId(`backup-row-${b1.id}`).click({ button: "right" });
    await page.getByTestId(`diff-backup-${b1.id}`).click();
    await page.getByTestId("diff-view").waitFor({ timeout: 15_000 });
    const liveAdds = await page.getByTestId("diff-view").locator('tr[data-difftype="add"]').allInnerTexts();
    check("Config: compare a snapshot with the live configuration", liveAdds.some((l) => l.includes("CFGTEMP")), `${liveAdds.length} added lines`);
    await page.getByRole("button", { name: "Done" }).last().click();
    // view + save a snapshot
    await page.getByTestId(`backup-row-${b1.id}`).dblclick();
    await page.getByTestId("backup-content").waitFor({ timeout: 15_000 });
    await page.getByTestId("backup-content-search").fill("declare root");
    const vhits = await page.getByTestId("backup-content-hits").innerText();
    await shots("config-view");
    await page.getByRole("button", { name: "Done" }).last().click();
    await page.getByTestId("backup-sheet").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    await setSave(path.join(ART, "saved-backup.config"));
    await page.getByTestId(`backup-row-${b1.id}`).click({ button: "right" });
    await page.getByTestId(`download-backup-${b1.id}`).click();
    const savedCfg = (await waitFile(SAVE_FILE)).toString("utf8");
    const toast = await page.locator(".mantine-Notification-root").filter({ hasText: "Saved to" }).first().innerText({ timeout: 5000 }).catch(() => "");
    check("Config: Save As… confirms where the snapshot was saved", /Saved to saved-backup\.config/.test(toast), toast || "no toast");
    check("Config: view a snapshot and Save As… writes it byte for byte", /1 matching line/.test(vhits) && sha(savedCfg) === b1.sha256, `${vhits}; saved sha ${sha(savedCfg).slice(0, 12)}`);
    // live configuration
    await page.getByTestId("tab-live").click();
    await page.getByTestId("show-live-config").click();
    await page.getByTestId("live-config").waitFor({ timeout: 20_000 });
    await page.getByTestId("live-config-search").fill("CFGTEMP");
    await page.waitForTimeout(300);
    const lhits = await page.getByTestId("live-config-hits").innerText();
    check("Config: live configuration (GetConfig) is searchable", /[1-9]\d* matching/.test(lhits), lhits);
    await shots("config-live", { top: true });
    await page.getByTestId("tab-backups").click();
    // restore snapshot #1 → CFGTEMP disappears
    await page.getByTestId(`backup-row-${b1.id}`).click({ button: "right" });
    await page.getByTestId(`restore-backup-${b1.id}`).click();
    await page.getByTestId(`restore-backup-${b1.id}-dialog`).waitFor();
    await page.screenshot({ path: path.join(SHOTS, "config-restore-confirm-light.png") });
    await typeConfirm(`restore-backup-${b1.id}`, CONN);
    await sleep(3000);
    const hubsAfter = await waitRpc("EnumHub", {}, (x) => (x.HubList ?? []).length > 0 && !(x.HubList ?? []).some((h) => h.HubName_str === "CFGTEMP"), 60_000);
    const list3 = (await appApi("GET", `/api/servers/${sid}/backups`)).body;
    const safety = list3.find((b) => /before restoring backup #/.test(b.note));
    check("Config: Restore… (typed connection name) brings the snapshot back; a safety snapshot is taken first",
      !hubsAfter.HubList.some((h) => h.HubName_str === "CFGTEMP") && !!safety, `hubs ${hubsAfter.HubList.map((h) => h.HubName_str).join(", ")}; safety #${safety?.id}`);
    // upload a modified configuration
    const live = Buffer.from((await seRpc("GetConfig")).FileData_bin, "base64").toString("utf8");
    const modified = live.replace(/(uint KeepConnectPort )\d+/, "$18123");
    writeFileSync(OPEN_FILE, modified);
    await page.getByTestId("tab-upload").click();
    await page.getByTestId("config-file").click();
    await page.waitForTimeout(500);
    const loaded = await page.getByTestId("config-text").inputValue();
    await shots("config-upload");
    await page.getByTestId("upload-config").click();
    await typeConfirm("upload-config", CONN);
    await sleep(3000);
    const keep = await waitRpc("GetKeep", {}, (x) => x.KeepConnectPort_u32 === 8123, 60_000);
    const norm = (x) => x.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    check("Config: Upload Configuration… applies the file (SetConfig)", norm(loaded) === norm(modified) && modified !== live && keep.KeepConnectPort_u32 === 8123, `loaded ${loaded.length} chars; port ${keep.KeepConnectPort_u32}`);
  });

  // ================================================================ SetServerPassword in the console (review)
  await step("console-password", async () => {
    for (let i = 0; i < 30; i++) {
      const s = await appApi("POST", `/api/servers/${sid}/refresh`).catch(() => null);
      if (s?.body?.state?.ok) break;
      await sleep(1000);
    }
    await goto(`${base}/console`, "console-method-picker");
    await page.getByTestId("console-method-search").fill("SetServerPassword");
    await page.getByTestId("console-method-SetServerPassword").click();
    await page.getByTestId("rpc-field-PlainTextPassword_str").fill("advpass2");
    await page.getByTestId("console-execute").click();
    await page.getByTestId("confirm-dialog").waitFor();
    const text = await page.getByTestId("confirm-dialog").innerText();
    const blocked = await page.getByTestId("confirm-confirm").isDisabled();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, "console-password-confirm-light.png") });
    await typeConfirm("confirm", CONN);
    await page.getByTestId("console-result-status").waitFor({ timeout: 15_000 });
    const st = await page.getByTestId("console-result-status").innerText();
    const newOk = await seRpc("GetServerInfo", {}, "advpass2").then(() => true, () => false);
    if (newOk) ADMIN_PW = "advpass2";
    let conn;
    for (let i = 0; i < 20; i++) { conn = (await appApi("POST", `/api/servers/${sid}/refresh`)).body; if (conn?.state?.ok) break; await sleep(500); }
    check("Console: SetServerPassword asks for the connection name, then this connection keeps working with the new password",
      /saves the new password/.test(text) && blocked && st === "Success" && newOk && conn?.state?.ok,
      `copy ok ${/saves the new password/.test(text)}, blocked until typed ${blocked}, ${st}, server accepts new ${newOk}, connection ok ${conn?.state?.ok} ${conn?.state?.error ?? ""}`);
  });

  check("no console errors or CSP violations", problems.length === 0, problems.slice(0, 5).join(" | ") || "none");
} catch (e) {
  check("run aborted", false, e.stack ?? e.message);
  await page?.screenshot({ path: path.join(ART, "aborted.png") }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  killServer();
  rmSync(DATA, { recursive: true, force: true });
  let stopped = true;
  try { process.kill(-se.pid, 0); stopped = false; } catch { /* gone */ }
  check("vpnserver process group stopped", stopped, `pgid ${se.pid}`);
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(path.join(ART, "report.json"), JSON.stringify({ at: new Date().toISOString(), port: PORT, build: OUT, passed: results.length - failed, failed, results, problems }, null, 2));
  console.log(`${results.length - failed}/${results.length} checks passed · screenshots: ${path.relative(REPO, SHOTS)} (${readdirSync(SHOTS).filter((f) => f.endsWith(".png") && !f.startsWith("._")).length} files)`);
  process.exit(failed ? 1 : 0);
}
