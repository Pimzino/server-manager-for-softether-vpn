// E2E for the hub-core pages of the desktop app (hub/Status, Settings, Options, Message, Radius, Certs, Logging).
//
// Builds the real app into a scratch dir (esbuild main + preload like scripts/build.mjs, Vite renderer), starts a
// throwaway SoftEther VPN Server, launches Electron with Playwright `_electron` (fresh SEM_DATA_DIR,
// SEM_INSECURE_KEYSTORE=1), adds the server, creates fixtures over JSON-RPC, then drives every page through the UI:
// at least one read and one write per page, each write checked on the server with a direct RPC. Native Open/Save
// dialogs are replaced by stubs so file flows run unattended. Light and dark screenshots of every page go to
// apps/desktop/design-screenshots/pages/hub-core/; results to ./artifacts/report.json.
//
//   node "apps/desktop/tools/pages-hub-core/run.mjs"              (from the repo root)
//   HUBCORE_PORT=15914 HUBCORE_RUN=~/se-desk-pages-hub-core      (defaults)
//   HUBCORE_SKIP_BUILD=1                                         reuse the last build
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const DESK = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(DESK, "../..");
const HERE = import.meta.dirname;
const RUN_ROOT = process.env.HUBCORE_RUN ?? path.join(os.homedir(), "se-desk-pages-hub-core");
const BUILD = path.join(RUN_ROOT, "build");
const SRV = path.join(RUN_ROOT, "server");
const FIX = path.join(RUN_ROOT, "fixtures");
const ART = path.join(HERE, "artifacts");
const SHOTS = path.join(DESK, "design-screenshots/pages/hub-core");
const SE = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const PORT = Number(process.env.HUBCORE_PORT ?? 15914);
const ADMIN_PW = "hubcore-admin";
const HUB = "HUBCORE";
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

for (const d of [ART, SHOTS, FIX]) mkdirSync(d, { recursive: true });
const results = [];
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
};

// ---------------------------------------------------------------- build (scratch dir, never apps/desktop/dist)
if (!process.env.HUBCORE_SKIP_BUILD) {
  const t0 = Date.now();
  execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), BUILD], { stdio: "inherit" });
  execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(BUILD, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
  console.log(`build: ${Date.now() - t0} ms`);
}

// ---------------------------------------------------------------- fixtures: a CA and a client certificate (openssl)
const CA_PEM = path.join(FIX, "hubcore-ca.pem");
const CLIENT_PEM = path.join(FIX, "hubcore-client.pem");
if (!existsSync(CA_PEM) || !existsSync(CLIENT_PEM)) {
  const o = (args) => execFileSync("openssl", args, { cwd: FIX, stdio: "pipe" });
  o(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", CA_PEM, "-days", "3650", "-subj", "/C=GB/O=Hub Core Lab/CN=Hub Core Test CA"]);
  o(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/C=GB/O=Hub Core Lab/OU=Staff/CN=revoked.user"]);
  o(["x509", "-req", "-in", "client.csr", "-CA", CA_PEM, "-CAkey", "ca.key", "-set_serial", "0x1A2B3C", "-out", CLIENT_PEM, "-days", "365"]);
}
const derOf = (pemFile) => Buffer.from(readFileSync(pemFile, "utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
const sha1Hex = (buf) => execFileSync("openssl", ["dgst", "-sha1", "-hex"], { input: buf }).toString().trim().split(/\s+/).pop().toUpperCase();

// ---------------------------------------------------------------- SoftEther VPN Server
function seRpc(method, params = {}, auth = { user: "administrator", pw: ADMIN_PW }) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false,
      headers: { authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pw}`).toString("base64")}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); j.error ? reject(new Error(`${method}: ${j.error.code} ${j.error.message}`)) : resolve(j.result); } catch (e) { reject(new Error(`${method}: HTTP ${res.statusCode} ${d.slice(0, 80)}`)); }
      });
    });
    req.on("error", reject); req.end(body);
  });
}
const pidFile = path.join(RUN_ROOT, "vpnserver.pid");
if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 1000)); }
rmSync(SRV, { recursive: true, force: true });
mkdirSync(SRV, { recursive: true });
for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE, f), path.join(SRV, f));
writeFileSync(path.join(SRV, "vpn_server.config"), [
  "# Software Configuration File", "declare root", "{",
  "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
  "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
  "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
].join("\n"));
const log = openSync(path.join(SRV, "vpnserver.log"), "a");
const se = spawn("./vpnserver", ["execsvc"], { cwd: SRV, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
writeFileSync(pidFile, String(se.pid));
const killServer = () => { try { process.kill(-se.pid, "SIGKILL"); } catch { /* gone */ } rmSync(pidFile, { force: true }); };
process.on("exit", killServer);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll `fn` until it returns a truthy value (or time out and return the last value). */
async function until(fn, ms = 8000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < ms) { try { v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); }
  return v;
}

let app;
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-hubcore-"));
try {
  await until(() => seRpc("Test", { IntValue_u32: 1 }, { user: "administrator", pw: "" }).then(() => true), 30_000);
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, { user: "administrator", pw: "" });
  await seRpc("CreateHub", { HubName_str: HUB, Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await seRpc("CreateHub", { HubName_str: "TODELETE", Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await seRpc("CreateUser", { HubName_str: HUB, Name_str: "alice", Realname_utf: "Alice", Note_utf: "", AuthType_u32: 1, Auth_Password_str: "alicepass" });
  await seRpc("CreateGroup", { HubName_str: HUB, Name_str: "staff", Realname_utf: "Staff", Note_utf: "" });
  await seRpc("EnableSecureNAT", { HubName_str: HUB });
  await seRpc("SetHubMsg", { HubName_str: HUB, Msg_bin: Buffer.from("Welcome to the Hub Core lab.\nAuthorised use only.").toString("base64") });
  const ver = await seRpc("GetServerInfo");
  check("SoftEther VPN Server started with fixtures", true, `${ver.ServerVersionString_str} build ${ver.ServerBuildInt_u32} on port ${PORT}`);

  // ---------------------------------------------------------------- app
  app = await electron.launch({
    executablePath: require("electron"), args: [BUILD],
    env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1360, 900); });
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");
  // Native dialogs → stubs driven by globals set per step.
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => (globalThis.__openPath ? { canceled: false, filePaths: [globalThis.__openPath] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (globalThis.__savePath ? { canceled: false, filePath: globalThis.__savePath } : { canceled: true });
  });
  const setOpen = (p) => app.evaluate((_e, v) => { globalThis.__openPath = v; }, p);
  const setSave = (p) => app.evaluate((_e, v) => { globalThis.__savePath = v; }, p);

  // Add the connection like the Connection sheet does (probe, then save with the pinned fingerprint).
  const created = await page.evaluate(async ({ port, pw }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name: "Hub Core Lab", host: "127.0.0.1", port, password: pw, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
    } });
  }, { port: PORT, pw: ADMIN_PW });
  check("connection added (native transport, pinned certificate)", created.status === 201 && created.body.state?.ok, `id ${created.body.id}, ok ${created.body.state?.ok}`);
  const sid = created.body.id;
  // Reload so the sidebar lists the new connection at once (instead of after its 15 s poll).
  await page.reload();
  await page.waitForLoadState("load");
  // Page captures can't include macOS vibrancy (the transparent sidebar comes out black): paint the sidebar with
  // its non-vibrancy token for screenshots only.
  await page.addStyleTag({ content: ".sem-sidebar { background: var(--sem-bg-sidebar) !important; }" });
  const base = `#/servers/${sid}/hubs/${HUB}`;
  const go = async (p, ready) => {
    await page.evaluate((h) => { location.hash = h; }, `${base}${p}`);
    await page.getByTestId(ready).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
  };
  const toastGone = async () => { await until(async () => (await page.locator(".mantine-Notification-root").count()) === 0, 12_000); };
  // Dark mode: nativeTheme drives the window chrome, emulateMedia drives prefers-color-scheme for the renderer.
  const scheme = async (s) => {
    await app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, s === "system" ? "system" : s);
    await page.emulateMedia({ colorScheme: s === "system" ? null : s });
    await page.waitForTimeout(450);
  };
  const shots = [];
  const shoot = async (name) => {
    for (const sc of ["light", "dark"]) {
      await scheme(sc);
      const file = path.join(SHOTS, `${name}-${sc}.png`);
      await page.screenshot({ path: file });
      shots.push(path.relative(DESK, file));
    }
    await scheme("light");
  };
  const scrollTop = () => page.evaluate(() => document.querySelectorAll(".sem-content, .sem-main-body, main").forEach((el) => { el.scrollTop = 0; }));

  // ============================================================ Status
  await go("", "hub-status-stats");
  const statsText = await page.getByTestId("hub-status-stats").innerText();
  const st0 = await seRpc("GetHubStatus", { HubName_str: HUB });
  check("Status: reads GetHubStatus (users, sessions)", statsText.includes(String(st0.NumUsers_u32)) && /Sessions/.test(statsText) && (await page.getByTestId("hub-traffic-table").innerText()).includes("Received"),
    statsText.replace(/\s+/g, " ").slice(0, 160));
  check("Status: a hub nobody has logged in to shows no last login (SoftEther reports the creation time)",
    st0.NumLogin_u32 !== 0 || (/None yet/.test(statsText) && (await page.getByTestId("hub-status-summary").innerText()).includes("Never")), statsText.replace(/\s+/g, " ").slice(0, 120));
  await page.getByTestId("status-refresh-interval").click();
  await page.getByTestId("status-interval-15000").click();
  const intervalLabel = await page.getByTestId("status-refresh-interval").innerText();
  check("Status: update frequency menu", /15/.test(intervalLabel), intervalLabel);
  const links = await Promise.all(["groups", "access", "securenat"].map((k) => page.getByTestId(`status-link-${k}`).getAttribute("href")));
  check("Status: Groups, Access list entries and SecureNAT link to their pages (web quick actions)",
    links[0]?.endsWith(`/hubs/${HUB}/groups`) && links[1]?.endsWith(`/hubs/${HUB}/access`) && links[2]?.endsWith(`/hubs/${HUB}/securenat`), links.join(" "));
  await toastGone();
  await shoot("status");
  await page.getByTestId("hub-offline").click();
  await page.getByTestId("hub-offline-dialog").waitFor();
  await page.screenshot({ path: path.join(SHOTS, "status-take-offline-confirm-light.png") });
  await page.getByTestId("hub-offline-confirm").click();
  const off = await until(async () => (await seRpc("GetHubStatus", { HubName_str: HUB })).Online_bool === false);
  await page.getByTestId("hub-online").waitFor({ timeout: 8000 });
  check("Status: Take Offline… (confirmed) → server hub offline", off === true);
  await page.getByTestId("hub-online").click();
  const on = await until(async () => (await seRpc("GetHubStatus", { HubName_str: HUB })).Online_bool === true);
  check("Status: Bring Online → server hub online", on === true);

  // ============================================================ Properties
  await go("/settings", "hub-settings-form");
  const maxVal = await page.getByTestId("hub-max-sessions").inputValue();
  check("Properties: reads GetHub", maxVal === "0" && (await page.getByTestId("hub-type").innerText()) === "Standalone", `max ${maxVal}`);
  await page.getByTestId("hub-max-sessions").fill("250");
  await page.getByTestId("hub-noenum-switch").click({ force: true });
  await page.getByTestId("hub-settings-save").click();
  const hubCfg = await until(async () => { const h = await seRpc("GetHub", { HubName_str: HUB }); return h.MaxSession_u32 === 250 && h.NoEnum_bool === true ? h : null; });
  check("Properties: Save → SetHub (MaxSession 250, NoEnum on)", !!hubCfg, JSON.stringify({ MaxSession: hubCfg?.MaxSession_u32, NoEnum: hubCfg?.NoEnum_bool }));
  await page.getByTestId("hub-admin-password").fill("short");
  const shortErr = await page.getByText("Use at least 8 characters.").isVisible();
  await page.getByTestId("hub-admin-password").fill("hub-admin-pass-1");
  await page.getByTestId("hub-admin-password-confirm").fill("hub-admin-pass-2");
  const mismatch = await page.getByText("The passwords don’t match.").isVisible();
  const disabled = await page.getByTestId("hub-admin-password-save").isDisabled();
  await page.getByTestId("hub-admin-password-confirm").fill("hub-admin-pass-1");
  await page.getByTestId("hub-admin-password-save").click();
  const hubLogin = await until(() => seRpc("GetHubStatus", { HubName_str: HUB }, { user: HUB, pw: "hub-admin-pass-1" }).then(() => true), 8000);
  const cfgAfterPw = await seRpc("GetHub", { HubName_str: HUB });
  check("Properties: hub admin password validated, set, and accepted by the server (hub-admin login)", shortErr && mismatch && disabled && hubLogin === true && cfgAfterPw.MaxSession_u32 === 250,
    `short ${shortErr}, mismatch ${mismatch}, disabled ${disabled}, login ${hubLogin}, settings kept ${cfgAfterPw.MaxSession_u32 === 250}`);
  // Going offline through the form asks first.
  await page.getByTestId("hub-online-switch").click({ force: true });
  await page.getByTestId("hub-settings-save").click();
  await page.getByTestId("hub-offline-confirm-dialog").waitFor();
  await page.getByTestId("hub-offline-confirm-cancel").click();
  await page.getByTestId("hub-settings-save-reset").click();
  const stillOnline = (await seRpc("GetHubStatus", { HubName_str: HUB })).Online_bool;
  check("Properties: turning the hub off asks first; Cancel keeps it online", stillOnline === true);
  await toastGone();
  await scrollTop();
  await shoot("properties");
  // Delete Hub on the throwaway hub (typed confirmation).
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/hubs/TODELETE/settings`);
  await page.getByTestId("delete-hub").waitFor({ timeout: 15000 });
  await page.getByTestId("delete-hub").click();
  await page.getByTestId("confirm-dialog").waitFor();
  const delBlocked = await page.getByTestId("confirm-confirm").isDisabled();
  await page.getByTestId("confirm-type").fill("TODELETE");
  await page.screenshot({ path: path.join(SHOTS, "properties-delete-confirm-light.png") });
  await page.getByTestId("confirm-confirm").click();
  const gone = await until(async () => !(await seRpc("EnumHub")).HubList.some((h) => h.HubName_str === "TODELETE"));
  const landed = await until(async () => (await page.evaluate(() => location.hash)).endsWith(`/servers/${sid}/hubs`), 5000);
  check("Properties: Delete Hub… needs the typed name, deletes the hub and returns to the hub list", delBlocked && gone === true && landed === true, `blocked ${delBlocked}, deleted ${gone}, navigated ${landed}`);

  // ============================================================ Admin & Extended Options
  await go("/options", "admin-options-table");
  await page.getByTestId("opt-max_users").waitFor({ timeout: 10000 });
  const adm0 = await seRpc("GetHubAdminOptions", { HubName_str: HUB });
  const rowsShown = await page.getByTestId("admin-options-table").locator("tbody tr").count();
  check("Options: reads GetHubAdminOptions (every option listed)", rowsShown === adm0.AdminOptionList.length, `${rowsShown} rows, server ${adm0.AdminOptionList.length}`);
  await page.getByTestId("opt-max_users").fill("7");
  await page.getByTestId("opt-max_groups").fill("3");
  await page.getByTestId("admin-options-table-filter").getByText(/Unsaved/).click();
  const unsavedRows = await page.getByTestId("admin-options-table").locator("tbody tr").count();
  await page.getByTestId("admin-options-table-save").click();
  await page.getByTestId("admin-options-table-confirm-dialog").waitFor();
  const changeList = await page.getByTestId("admin-options-table-changes").innerText();
  await page.screenshot({ path: path.join(SHOTS, "options-save-confirm-light.png") });
  await page.getByTestId("admin-options-table-confirm-confirm").click();
  const adm1 = await until(async () => {
    const r = await seRpc("GetHubAdminOptions", { HubName_str: HUB });
    const v = (n) => r.AdminOptionList.find((o) => o.Name_str === n)?.Value_u32;
    return v("max_users") === 7 && v("max_groups") === 3 ? r : null;
  });
  const othersSame = adm1 && adm1.AdminOptionList.every((o) => ["max_users", "max_groups"].includes(o.Name_str) || o.Value_u32 === adm0.AdminOptionList.find((x) => x.Name_str === o.Name_str)?.Value_u32);
  check("Options: admin options saved after a change-list confirmation; other options unchanged",
    !!adm1 && othersSame && unsavedRows === 2 && /max_users: 0 → 7/.test(changeList), `unsaved rows ${unsavedRows}; ${changeList.replace(/\s+/g, " ")}`);
  await page.getByTestId("admin-options-table-filter").getByText("All", { exact: true }).click();
  await toastGone();
  await scrollTop();
  await shoot("options-admin");
  await page.getByTestId("opt-max_sessions").fill("11");
  await page.getByTestId("tab-ext-options").click();
  await page.getByTestId("opt-AdjustTcpMssValue").waitFor({ timeout: 10000 });
  const unsavedDot = await page.getByTestId("tab-admin-unsaved").isVisible();
  await page.getByTestId("tab-admin-options").click();
  const keptEdit = await page.getByTestId("opt-max_sessions").inputValue();
  await page.getByTestId("admin-options-table-save-reset").click();
  const admAfterSwitch = await seRpc("GetHubAdminOptions", { HubName_str: HUB });
  check("Options: unsaved edits survive switching lists (marked on the switch), and aren’t sent",
    unsavedDot && keptEdit === "11" && admAfterSwitch.AdminOptionList.find((o) => o.Name_str === "max_sessions")?.Value_u32 === 0, `dot ${unsavedDot}, kept ${keptEdit}`);
  await page.getByTestId("tab-ext-options").click();
  await page.getByTestId("opt-AdjustTcpMssValue").fill("1300");
  // Context menu: reset NoMacAddressLog (default 1) after changing it
  await page.getByTestId("opt-NoMacAddressLog").fill("0");
  await page.getByTestId("opt-row-NoMacAddressLog").click({ button: "right", position: { x: 20, y: 8 } });
  await page.getByTestId("opt-reset-NoMacAddressLog").click();
  const resetVal = await page.getByTestId("opt-NoMacAddressLog").inputValue();
  await page.getByTestId("ext-options-table-save").click();
  await page.getByTestId("ext-options-table-confirm-confirm").click();
  const ext1 = await until(async () => {
    const r = await seRpc("GetHubExtOptions", { HubName_str: HUB });
    return r.AdminOptionList.find((o) => o.Name_str === "AdjustTcpMssValue")?.Value_u32 === 1300 ? r : null;
  });
  check("Options: extended option saved (AdjustTcpMssValue 1300); context-menu Reset to Default works",
    !!ext1 && resetVal === "1" && ext1.AdminOptionList.find((o) => o.Name_str === "NoMacAddressLog")?.Value_u32 === 1, `reset → ${resetVal}`);
  await toastGone();
  await scrollTop();
  await shoot("options-extended");

  // ============================================================ Client Message
  await go("/message", "hub-msg-text");
  const msgShown = await page.getByTestId("hub-msg-text").inputValue();
  check("Client Message: reads GetHubMsg", msgShown.startsWith("Welcome to the Hub Core lab."), msgShown.slice(0, 60));
  const newMsg = "Welcome to Hub Core.\nUse of this VPN is logged. Café ✓";
  await page.getByTestId("hub-msg-text").fill(newMsg);
  const previewText = await page.getByTestId("hub-msg-preview").innerText();
  await page.getByTestId("hub-msg-save").click();
  const msgSaved = await until(async () => Buffer.from((await seRpc("GetHubMsg", { HubName_str: HUB })).Msg_bin, "base64").toString("utf8") === newMsg);
  check("Client Message: preview follows the text; Save → SetHubMsg (UTF-8 round trip)", msgSaved === true && previewText.includes("Use of this VPN is logged"), `saved ${msgSaved}`);
  await page.getByTestId("hub-msg-text").fill("Party 🎉");
  const nonBmp = await page.getByTestId("hub-msg-nonbmp").isVisible();
  await page.getByTestId("hub-msg-save-reset").click();
  check("Client Message: warns about emoji (non-BMP) before saving", nonBmp);
  await toastGone();
  await shoot("message");
  await page.getByTestId("hub-msg-clear").click();
  await page.getByTestId("hub-msg-clear-confirm").click();
  const cleared = await until(async () => !(await seRpc("GetHubMsg", { HubName_str: HUB })).Msg_bin);
  check("Client Message: Remove Message… (confirmed) clears it on the server", cleared === true);

  // ============================================================ RADIUS
  await go("/radius", "radius-form");
  const r0 = await seRpc("GetHubRadius", { HubName_str: HUB });
  check("RADIUS: reads GetHubRadius (not configured, port shown)", (await page.getByTestId("radius-state").innerText()) === "Not configured" && (await page.getByTestId("radius-port").inputValue()) === String(r0.RadiusPort_u32 || 1812),
    JSON.stringify(r0));
  await page.getByTestId("radius-servers").fill("radius1.example.com");
  await page.keyboard.press("Enter");
  await page.getByTestId("radius-servers").fill("10.0.0.5");
  await page.keyboard.press("Enter");
  const needSecret = await page.getByText("Enter the shared secret the RADIUS server expects.").isVisible();
  await page.getByTestId("radius-secret").fill("s3cret-radius");
  await page.getByTestId("radius-timeout").fill("20000");
  await page.getByTestId("radius-interval").fill("2000");
  await page.getByTestId("radius-save").click();
  const r1 = await until(async () => { const r = await seRpc("GetHubRadius", { HubName_str: HUB }); return r.RadiusServerName_str ? r : null; });
  check("RADIUS: validation, then Save → SetHubRadius (servers, secret, interval, timeout)",
    needSecret && r1?.RadiusServerName_str === "radius1.example.com,10.0.0.5" && r1?.RadiusSecret_str === "s3cret-radius" && r1?.RadiusRetryInterval_u32 === 2000,
    `${JSON.stringify(r1)}; secret error shown ${needSecret}`);
  check("RADIUS: retry timeout round-trips (RadiusRetryTimeout_u32)", r1?.RadiusRetryTimeout_u32 === 20000, `timeout ${r1?.RadiusRetryTimeout_u32}`);
  await toastGone();
  await scrollTop();
  await shoot("radius");
  await page.getByTestId("radius-disable").click();
  await page.getByTestId("radius-disable-confirm").click();
  const rOff = await until(async () => !(await seRpc("GetHubRadius", { HubName_str: HUB })).RadiusServerName_str);
  check("RADIUS: Turn Off RADIUS… clears the server setting", rOff === true);

  // ============================================================ Trusted CAs & CRL
  await go("/certs", "ca-table");
  const emptyCa = await page.getByText("No Trusted CA Certificates").isVisible();
  await scrollTop();
  await page.getByTestId("add-ca").click();
  await setOpen(CA_PEM);
  await page.getByTestId("ca-file").click();
  await page.getByTestId("ca-preview-0").waitFor({ timeout: 5000 });
  const preview = await page.getByTestId("ca-preview-0").innerText();
  await page.screenshot({ path: path.join(SHOTS, "certs-add-ca-sheet-light.png") });
  await page.getByTestId("ca-add-submit").click();
  const cas = await until(async () => { const r = await seRpc("EnumCa", { HubName_str: HUB }); return r.CAList?.length ? r.CAList : null; });
  check("Certs: empty state, then Add Certificate… from a PEM file (native Open dialog) → AddCa",
    emptyCa && cas?.length === 1 && /Hub Core Test CA/.test(cas[0].SubjectName_utf) && /Hub Core Test CA/.test(preview), `${cas?.[0]?.SubjectName_utf}`);
  const key = cas[0].Key_u32;
  await page.getByTestId(`ca-row-${key}`).dblclick();
  await page.getByTestId("ca-details").waitFor({ timeout: 8000 });
  const details = await page.getByTestId("ca-inspector").innerText();
  const caSha1 = sha1Hex(derOf(CA_PEM));
  const sha1Shown = details.replace(/:/g, "").toUpperCase().includes(caSha1);
  const savePemPath = path.join(FIX, "saved-ca.pem");
  rmSync(savePemPath, { force: true });
  await setSave(savePemPath);
  await page.getByTestId("ca-download-pem").click();
  const savedPem = await until(() => existsSync(savePemPath) && readFileSync(savePemPath, "utf8"), 5000);
  check("Certs: double-click opens the Inspector with details + fingerprints; Save PEM… writes the certificate",
    sha1Shown && typeof savedPem === "string" && derOf(savePemPath).equals(derOf(CA_PEM)), `sha1 ${caSha1.slice(0, 16)}… shown ${sha1Shown}`);
  await toastGone();
  await shoot("certs-ca-inspector");
  await page.getByTestId("inspector-close").click();
  await page.waitForTimeout(300);
  const derPath = path.join(FIX, "saved-ca.cer");
  rmSync(derPath, { force: true });
  await setSave(derPath);
  await page.getByTestId(`ca-row-${key}`).click({ button: "right" });
  await page.getByTestId("ca-menu-der").click();
  const savedDer = await until(() => existsSync(derPath) && readFileSync(derPath), 5000);
  await page.getByTestId(`ca-row-${key}`).click({ button: "right" });
  await page.getByTestId("ca-menu-copy").click();
  const clip = await until(() => app.evaluate(({ clipboard }) => clipboard.readText()), 3000);
  const caDesc = await page.getByTestId("certs-tab-description").innerText();
  check("Certs: context menu Save as DER… writes the DER bytes; Copy Subject copies it; the list is explained",
    Buffer.isBuffer(savedDer) && savedDer.equals(derOf(CA_PEM)) && clip === cas[0].SubjectName_utf && /signed-certificate/.test(caDesc), `clipboard ${clip}`);
  await shoot("certs-ca");

  // CRL
  await page.getByTestId("tab-crl").click();
  await page.getByTestId("crl-table").waitFor();
  await page.getByTestId("add-crl").click();
  await setOpen(CLIENT_PEM);
  await page.getByTestId("crl-from-cert").click();
  await page.getByTestId("crl-source").waitFor({ timeout: 5000 });
  const filledCn = await page.getByTestId("crl-cn").inputValue();
  const filledSerial = await page.getByTestId("crl-serial").inputValue();
  await page.getByTestId("crl-sha1").fill("ZZ");
  const badHex = await page.getByText("20 bytes (40 hex digits).").isVisible();
  const cliSha1 = sha1Hex(derOf(CLIENT_PEM));
  await page.getByTestId("crl-sha1").fill(cliSha1.match(/../g).join(" "));
  await page.screenshot({ path: path.join(SHOTS, "certs-crl-sheet-light.png") });
  await scheme("dark");
  await page.screenshot({ path: path.join(SHOTS, "certs-crl-sheet-dark.png") });
  await scheme("light");
  await page.getByTestId("crl-submit").click();
  const crls = await until(async () => { const r = await seRpc("EnumCrl", { HubName_str: HUB }); return r.CRLList?.length ? r.CRLList : null; });
  const crlKey = crls?.[0]?.Key_u32;
  const crl = crlKey !== undefined ? await seRpc("GetCrl", { HubName_str: HUB, Key_u32: crlKey }) : null;
  check("Certs: Add Revoked Certificate… filled from a certificate file → AddCrl (CN, serial, SHA-1)",
    filledCn === "revoked.user" && /1A 2B 3C/i.test(filledSerial) && badHex && crl?.CommonName_utf === "revoked.user"
      && Buffer.from(crl.DigestSHA1_bin, "base64").toString("hex").toUpperCase() === cliSha1 && Buffer.from(crl.Serial_bin, "base64").toString("hex").toUpperCase() === "1A2B3C",
    `cn ${filledCn}, serial ${filledSerial}, info ${crls?.[0]?.CrlInfo_utf}`);
  await page.getByTestId(`crl-row-${crlKey}`).waitFor({ timeout: 8000 });
  const crlRowText = await page.getByTestId(`crl-row-${crlKey}`).innerText();
  check("Certs: CRL row shows the parsed subject and digest", /revoked\.user/.test(crlRowText) && /SHA-1/.test(crlRowText), crlRowText.replace(/\s+/g, " "));
  // Edit through the context menu
  await page.getByTestId(`crl-row-${crlKey}`).click({ button: "right" });
  await page.getByTestId("crl-menu-edit").click();
  await page.getByTestId("crl-cn").waitFor();
  await until(async () => (await page.getByTestId("crl-cn").inputValue()) === "revoked.user", 5000);
  await page.getByTestId("crl-o").fill("Hub Core Lab Edited");
  await page.getByTestId("crl-submit").click();
  const edited = await until(async () => {
    const r = await seRpc("EnumCrl", { HubName_str: HUB });
    for (const it of r.CRLList ?? []) { const g = await seRpc("GetCrl", { HubName_str: HUB, Key_u32: it.Key_u32 }); if (g.Organization_utf === "Hub Core Lab Edited") return g; }
    return null;
  });
  check("Certs: Edit… (context menu) → SetCrl", edited?.CommonName_utf === "revoked.user", JSON.stringify({ O: edited?.Organization_utf, n: (await seRpc("EnumCrl", { HubName_str: HUB })).CRLList?.length }));
  await toastGone();
  await shoot("certs-crl");
  const crlNow = (await seRpc("EnumCrl", { HubName_str: HUB })).CRLList[0].Key_u32;
  await page.getByTestId(`crl-row-${crlNow}`).click({ button: "right" });
  await page.getByTestId("crl-menu-delete").click();
  await page.getByTestId("crl-delete-confirm").click();
  const crlGone = await until(async () => !(await seRpc("EnumCrl", { HubName_str: HUB })).CRLList?.length);
  check("Certs: Delete… (context menu, confirmed) → DelCrl", crlGone === true);
  await page.getByTestId("add-crl").click();
  await page.getByTestId("crl-sha1").waitFor();
  const emptyBlocked = await page.getByTestId("crl-submit").isDisabled();
  await page.getByTestId("crl-sha1").fill(cliSha1.toLowerCase());
  await page.getByTestId("crl-submit").click();
  const onlyDigest = await until(async () => {
    const r = await seRpc("EnumCrl", { HubName_str: HUB });
    return r.CRLList?.length ? seRpc("GetCrl", { HubName_str: HUB, Key_u32: r.CRLList[0].Key_u32 }) : null;
  });
  await page.getByTestId(`crl-row-${onlyDigest?.Key_u32}`).waitFor({ timeout: 8000 }).catch(() => undefined);
  const anyRow = onlyDigest ? await page.getByTestId(`crl-row-${onlyDigest.Key_u32}`).innerText().catch(() => "") : "";
  check("Certs: a digest-only entry is sent without subject or serial (empty form is refused)",
    emptyBlocked && !!onlyDigest && !onlyDigest.CommonName_utf && !onlyDigest.Serial_bin && Buffer.from(onlyDigest.DigestSHA1_bin, "base64").toString("hex").toUpperCase() === cliSha1 && /Any subject/.test(anyRow),
    JSON.stringify({ cn: onlyDigest?.CommonName_utf, serial: onlyDigest?.Serial_bin, row: anyRow.replace(/\s+/g, " ") }));
  if (onlyDigest) await seRpc("DelCrl", { HubName_str: HUB, Key_u32: onlyDigest.Key_u32 });
  await page.getByTestId("tab-ca").click();
  await page.getByTestId(`ca-row-${key}`).click({ button: "right" });
  await page.getByTestId("ca-menu-delete").click();
  const caDlg = await page.getByTestId("ca-delete-dialog").innerText();
  await page.getByTestId("ca-delete-confirm").click();
  const caGone = await until(async () => !(await seRpc("EnumCa", { HubName_str: HUB })).CAList?.length);
  check("Certs: Delete… on a trusted CA names it and deletes it (DeleteCa)", caGone === true && /Hub Core Test CA/.test(caDlg), caDlg.replace(/\s+/g, " ").slice(0, 120));
  // Re-add the CA so the final screenshot shows a populated table
  await seRpc("AddCa", { HubName_str: HUB, Cert_bin: derOf(CA_PEM).toString("base64") });

  // ============================================================ Logging
  await go("/logging", "packet-log-table");
  const l0 = await seRpc("GetHubLog", { HubName_str: HUB });
  const secChecked = await page.getByTestId("log-security-save").isChecked();
  check("Logging: reads GetHubLog", secChecked === l0.SaveSecurityLog_bool, JSON.stringify({ sec: l0.SaveSecurityLog_bool, pkt: l0.SavePacketLog_bool, cfg: l0.PacketLogConfig_u32?.slice(0, 8) }));
  if (!(await page.getByTestId("log-packet-save").isChecked())) await page.getByTestId("log-packet-save").click({ force: true });
  await page.getByTestId("packet-log-TcpAll").getByText("Header").click();
  await page.getByTestId("packet-log-Icmp").getByText("All").click();
  const heavy = await page.getByTestId("packet-log-heavy").isVisible();
  await page.getByTestId("log-security-switch").click();
  await page.getByRole("option", { name: "Every hour" }).click();
  await page.getByTestId("log-save").click();
  const l1 = await until(async () => { const r = await seRpc("GetHubLog", { HubName_str: HUB }); return r.SavePacketLog_bool && r.PacketLogConfig_u32[1] === 1 && r.PacketLogConfig_u32[4] === 2 ? r : null; });
  check("Logging: Save → SetHubLog (packet log on, TCP packets Header, ICMP All, security log hourly); heavy-log warning shown",
    !!l1 && l1.SecurityLogSwitchType_u32 === 3 && heavy, JSON.stringify({ cfg: l1?.PacketLogConfig_u32?.slice(0, 8), sw: l1?.SecurityLogSwitchType_u32, heavy }));
  await page.getByTestId("log-preset-default").click();
  const presetDirty = await page.getByTestId("log-save").isEnabled();
  await page.getByTestId("log-save-reset").click();
  check("Logging: Factory Default preset edits the form (Revert restores)", presetDirty);
  await toastGone();
  await scrollTop();
  await shoot("logging");

  // ============================================================ Hub admin mode (a connection made with the hub password)
  const hubConn = await page.evaluate(async ({ port, hub }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name: "Hub Core Hub Admin", host: "127.0.0.1", port, hub, password: "hub-admin-pass-1", savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
    } });
  }, { port: PORT, hub: HUB });
  check("hub-admin connection added with the hub password", hubConn.status === 201 && hubConn.body.state?.ok, `id ${hubConn.body.id}, ok ${hubConn.body.state?.ok} ${hubConn.body.state?.error ?? ""}`);
  const hid = hubConn.body.id;
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/hubs/${HUB}/settings`);
  await page.getByTestId("hub-settings-form").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
  const noDelete = (await page.getByTestId("delete-hub").count()) === 0;
  await page.getByTestId("hub-admin-password").fill("hub-admin-pass-9");
  await page.getByTestId("hub-admin-password-confirm").fill("hub-admin-pass-9");
  await page.getByTestId("hub-admin-password-save").click();
  await page.getByTestId("hub-admin-password-confirm-change-dialog").waitFor();
  await page.screenshot({ path: path.join(SHOTS, "properties-hub-admin-password-confirm-light.png") });
  await page.getByTestId("hub-admin-password-confirm-change-confirm").click();
  const newPwOk = await until(() => seRpc("GetHubStatus", { HubName_str: HUB }, { user: HUB, pw: "hub-admin-pass-9" }).then(() => true), 8000);
  const connOk = await until(async () => {
    const r = await page.evaluate((id) => window.sem.api({ method: "POST", path: `/api/servers/${id}/refresh` }), hid);
    return r.body?.state?.ok ? r.body : null;
  }, 10_000);
  const hubRpcOk = await page.evaluate((id) => window.sem.api({ method: "POST", path: `/api/servers/${id}/rpc/GetHub`, body: { HubName_str: "HUBCORE" } }), hid);
  check("Hub admin mode: Properties hides Delete Hub; changing the hub password asks, then this app keeps working with the new one",
    noDelete && newPwOk === true && !!connOk && hubRpcOk.status === 200, `no delete ${noDelete}, server ${newPwOk}, connection ok ${!!connOk}, GetHub ${hubRpcOk.status}`);
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/hubs/${HUB}/logging`);
  await page.getByTestId("packet-log-table").waitFor({ timeout: 20_000 });
  const logsLink = await page.getByRole("link", { name: "Logs & Syslog" }).count();
  check("Hub admin mode: Logging has no link to the server-only Logs page", logsLink === 0);

  // ============================================================ Server down: one explanation instead of failing RPCs
  const downConn = await page.evaluate(async ({ port }) => window.sem.api({ method: "POST", path: "/api/servers", body: {
    name: "Hub Core Down", host: "127.0.0.1", port, password: "x", savePassword: true, transport: "native", tlsMode: "insecure",
  } }), { port: PORT + 37 });
  const did = downConn.body.id;
  const unreachable = {};
  for (const p of ["", "/settings", "/options", "/message", "/radius", "/certs", "/logging"]) {
    await page.evaluate((h) => { location.hash = h; }, `#/servers/${did}/hubs/${HUB}${p}`);
    unreachable[p || "/"] = await page.getByTestId("hub-unreachable").waitFor({ timeout: 10_000 }).then(() => true, () => false);
  }
  await page.screenshot({ path: path.join(SHOTS, "hub-unreachable-light.png") });
  check("Server down: every hub-core page shows the “Can’t reach …” state", Object.values(unreachable).every(Boolean) && downConn.body.state?.ok === false, JSON.stringify(unreachable));

  // Final pass: every page again for clean screenshots after the writes
  await go("", "hub-status-stats");
  await go("/certs", "ca-table");
  await shoot("certs-ca");

  // Keyboard: the CA table is reachable and Enter opens the Inspector
  await page.getByTestId("ca-table").locator(".sem-table-scroll").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const kbdInspector = await page.getByTestId("ca-details").isVisible().catch(() => false) || await until(() => page.getByTestId("ca-details").isVisible(), 4000);
  check("Certs: keyboard — arrow selects, Enter opens the Inspector", kbdInspector === true);
  await page.keyboard.press("Escape");

  const filtered = problems.filter((p) => !/Failed to load resource/.test(p));
  check("no console errors, page errors or CSP violations", filtered.length === 0, filtered.slice(0, 4).join(" | ") || "none");
  writeFileSync(path.join(ART, "screenshots.json"), JSON.stringify(shots, null, 2));
} catch (e) {
  check("run completed", false, e?.stack ?? e);
  try { const p = app && (await app.firstWindow()); if (p) await p.screenshot({ path: path.join(ART, "failure.png") }); } catch { /* ignore */ }
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  killServer();
  rmSync(DATA, { recursive: true, force: true });
}
await sleep(500);
let serverStopped = true;
try { process.kill(-se.pid, 0); serverStopped = false; } catch { /* gone */ }
check("vpnserver process group stopped", serverStopped);
const failed = results.filter((r) => !r.ok).length;
writeFileSync(path.join(ART, "report.json"), JSON.stringify({ at: new Date().toISOString(), port: PORT, passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} checks passed; report in ${path.relative(REPO, ART)}, screenshots in ${path.relative(REPO, SHOTS)}`);
process.exit(failed ? 1 : 0);
