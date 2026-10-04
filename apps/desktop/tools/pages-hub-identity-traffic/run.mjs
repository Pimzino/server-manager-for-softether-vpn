// E2E for the hub Users, Groups, Sessions and MAC & IP Tables pages of the desktop app, against a REAL
// SoftEther VPN Server and the REAL Electron app (Playwright _electron).
//
//   node "apps/desktop/tools/pages-hub-identity-traffic/run.mjs"
//   HIT_PORT=16015 HIT_WORK=~/se-desk-parity-hub-identity-traffic node …   (own port / run dir; SKIP_BUILD=1 reuses the build)
//
// 1. Builds main + preload (tools/smoke-core/build.mjs options) and the real renderer (vite) into
//    ~/se-desk-pages-hub-identity-traffic/build — never into apps/desktop/dist.
// 2. Starts a throwaway vpnserver on port 15915 in ~/se-desk-pages-hub-identity-traffic/server (like
//    e2e/global-setup.ts) and creates fixtures over JSON-RPC: hubs, groups, users of every auth type,
//    SecureNAT and a cascade connection (BRANCH -> DEFAULT) so there are real sessions and MAC/IP entries.
// 3. Launches Electron with a fresh SEM_DATA_DIR, replaces the native Open/Save dialogs with fakes, adds the
//    server through window.sem.api and drives every page through the UI, checking each write with a direct RPC.
// 4. Saves light + dark screenshots to apps/desktop/design-screenshots/pages/hub-identity-traffic/ and
//    artifacts/report.json + artifacts/REPORT.md next to this script. The vpnserver process group is always
//    killed at the end.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const DESK = path.join(REPO, "apps/desktop");
const HERE = import.meta.dirname;
const ART = path.join(HERE, "artifacts");
const SHOTS = path.join(DESK, "design-screenshots/pages/hub-identity-traffic");
const WORK = process.env.HIT_WORK ? path.resolve(process.env.HIT_WORK.replace(/^~(?=\/|$)/, os.homedir())) : path.join(os.homedir(), "se-desk-pages-hub-identity-traffic");
const OUT = path.join(WORK, "build");
const RUN = path.join(WORK, "server");
const FILES = path.join(WORK, "files");
const SE = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const PORT = Number(process.env.HIT_PORT ?? 15915);
const ADMIN_PW = "hitpass";
const SKIP_BUILD = process.env.SKIP_BUILD === "1";
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
rmSync(FILES, { recursive: true, force: true });
mkdirSync(FILES, { recursive: true });
const results = [];
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- build
if (!SKIP_BUILD) {
  const t0 = Date.now();
  execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), OUT], { stdio: "inherit" });
  execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(OUT, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
  console.log(`build: ${Date.now() - t0} ms`);
}

// ---------------------------------------------------------------- SoftEther VPN Server
function seRpc(method, params = {}, password = ADMIN_PW) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false,
      headers: { authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); j.error ? reject(new Error(`${method}: ${j.error.code} ${j.error.message}`)) : resolve(j.result); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.end(body);
  });
}
async function until(fn, what, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

const pidFile = path.join(WORK, "vpnserver.pid");
if (existsSync(pidFile)) { try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } await sleep(800); }
rmSync(RUN, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib", "libcedar.so", "libmayaqua.so"]) {
  if (existsSync(path.join(SE, f))) copyFileSync(path.join(SE, f), path.join(RUN, f));
}
writeFileSync(path.join(RUN, "vpn_server.config"), [
  "# Software Configuration File", "declare root", "{",
  "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
  "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
  "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
].join("\n"));
const log = openSync(path.join(RUN, "vpnserver.log"), "a");
const se = spawn("./vpnserver", ["execsvc"], { cwd: RUN, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
writeFileSync(pidFile, String(se.pid));
const killServer = () => { try { process.kill(-se.pid, "SIGKILL"); } catch { /* gone */ } rmSync(pidFile, { force: true }); };
process.on("exit", killServer);
process.on("SIGINT", () => process.exit(130));

let app, page;
const DATA = path.join(WORK, `data-${Date.now()}`);
mkdirSync(DATA, { recursive: true });
const problems = [];
const info = [];

async function fixtures() {
  await until(() => seRpc("Test", { IntValue_u32: 1 }, ""), "vpnserver JSON-RPC", 30_000);
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  const hub = (name) => seRpc("CreateHub", { HubName_str: name, Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  await hub("DEFAULT");
  await hub("BRANCH");
  const H = { HubName_str: "DEFAULT" };
  await seRpc("CreateGroup", { ...H, Name_str: "staff", Realname_utf: "Staff", Note_utf: "Office employees" });
  await seRpc("CreateGroup", { ...H, Name_str: "contractors", Realname_utf: "Contractors", Note_utf: "Access suspended", UsePolicy_bool: true, "policy:Access_bool": false, "policy:Ver3_bool": true, "policy:MaxConnection_u32": 32, "policy:TimeOut_u32": 20 });
  const cert = await seRpc("GetServerCert");
  const user = (p) => seRpc("CreateUser", { ...H, GroupName_str: "", Realname_utf: "", Note_utf: "", ExpireTime_dt: "1970-01-01T00:00:00.000Z", ...p });
  await user({ Name_str: "alice", Realname_utf: "Alice Martin", Note_utf: "MacBook", GroupName_str: "staff", AuthType_u32: 1, Auth_Password_str: "Alice#Pass1" });
  await user({ Name_str: "bob", Realname_utf: "Bob Stone", GroupName_str: "staff", AuthType_u32: 2, UserX_bin: cert.Cert_bin });
  await user({ Name_str: "carol", Realname_utf: "Carol Diaz", AuthType_u32: 3, CommonName_utf: "carol.example", Serial_bin: Buffer.from([1, 2, 3]).toString("base64") });
  await user({ Name_str: "dave", Realname_utf: "Dave Kim", AuthType_u32: 4, RadiusUsername_utf: "dave@corp" });
  await user({ Name_str: "erin", Realname_utf: "Erin Walsh", AuthType_u32: 5, NtUsername_utf: "CORP\\erin" });
  await user({ Name_str: "frank", Realname_utf: "Frank (guest)", AuthType_u32: 0, ExpireTime_dt: new Date(Date.now() - 3 * 86400_000).toISOString() });
  await user({ Name_str: "gina", Realname_utf: "Gina Rossi", GroupName_str: "contractors", AuthType_u32: 1, Auth_Password_str: "Gina#Pass1" });
  await user({ Name_str: "henry", Realname_utf: "Henry Ford", AuthType_u32: 1, Auth_Password_str: "Henry#Pass1", UsePolicy_bool: true, "policy:Access_bool": false, "policy:Ver3_bool": true, "policy:MaxConnection_u32": 32, "policy:TimeOut_u32": 20 });
  // The cascade signs in anonymously: JSON-RPC CreateLink with PlainPassword_str fails with error 9 on this build.
  await user({ Name_str: "linkuser", Realname_utf: "Cascade from BRANCH", AuthType_u32: 0 });
  await seRpc("EnableSecureNAT", H);
  await seRpc("CreateLink", {
    HubName_Ex_str: "BRANCH", AccountName_utf: "to-default", Hostname_str: "127.0.0.1", Port_u32: PORT, HubName_str: "DEFAULT",
    AuthType_u32: 0, Username_str: "linkuser", CheckServerCert_bool: false, MaxConnection_u32: 1, UseEncrypt_bool: true,
    Online_bool: false, ProxyType_u32: 0,
  });
  await seRpc("SetLinkOnline", { HubName_str: "BRANCH", AccountName_utf: "to-default" });
  await until(async () => (await seRpc("EnumSession", H)).SessionList?.some((s) => s.Username_str === "linkuser"), "cascade session on DEFAULT", 30_000);
  await until(async () => (await seRpc("EnumIpTable", H)).IpTable?.length, "an IP table entry", 20_000);
  const ver = await seRpc("GetServerInfo");
  const sessions = (await seRpc("EnumSession", H)).SessionList.map((s) => s.Name_str);
  check("fixtures: server, hubs, 9 users of all auth types, groups, SecureNAT, cascade", true, `${ver.ServerVersionString_str}; sessions ${sessions.join(", ")}`);
  return { cert };
}

async function setTheme(scheme) {
  await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
  // nativeTheme drives the window material; emulateMedia makes Mantine's "auto" scheme follow reliably.
  await page.emulateMedia({ colorScheme: scheme });
  await sleep(450);
}
/** Light and dark screenshot of the current window state. */
async function shoot(name) {
  // page.screenshot() only captures web contents: the sidebar is transparent there (the real window paints it
  // with vibrancy), so give it the design system's non-vibrancy background for the captures.
  await page.addStyleTag({ content: ".sem-sidebar { background: var(--sem-bg-sidebar) !important; }" }).catch(() => undefined);
  for (const scheme of ["light", "dark"]) {
    await setTheme(scheme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
  await setTheme("light");
}
const setDialogs = (o) => app.evaluate((_e, o) => { Object.assign(globalThis.__dlg, o); }, o);
const go = async (sid, sub) => {
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/hubs/DEFAULT/${sub}`);
  await sleep(600);
};
const confirmDialog = async (tid, typed) => {
  await page.getByTestId(`${tid}-dialog`).waitFor({ timeout: 5000 });
  if (typed) await page.getByTestId("confirm-type").fill(typed);
  await page.getByTestId(`${tid}-confirm`).click();
};
const rightClick = async (testId) => { await page.getByTestId(testId).click({ button: "right" }); await sleep(200); };
const pane = async (group, label) => { await page.getByTestId(group).getByText(label).click(); await sleep(250); };
const pickOption = async (inputTestId, name) => {
  await page.getByTestId(inputTestId).click();
  await page.getByRole("option", { name }).first().click();
  await sleep(150);
};
// Sheets slide in (200 ms): wait for the transition before touching controls.
const sheetOpen = async (formTestId) => { await page.getByTestId(formTestId).waitFor({ timeout: 10_000 }); await sleep(400); };
const sheetClosed = (formTestId) => page.getByTestId(formTestId).waitFor({ state: "detached", timeout: 10_000 });
const getUser = (n) => seRpc("GetUser", { HubName_str: "DEFAULT", Name_str: n });

try {
  const { cert } = await fixtures();

  // ---------------------------------------------------------------- app
  app = await electron.launch({
    executablePath: require("electron"), args: [OUT],
    env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000,
  });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1360, 880); });
  await app.evaluate(({ dialog }) => {
    globalThis.__dlg = { open: null, save: null };
    dialog.showOpenDialog = async () => (globalThis.__dlg.open ? { canceled: false, filePaths: [globalThis.__dlg.open] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (globalThis.__dlg.save ? { canceled: false, filePath: globalThis.__dlg.save } : { canceled: true });
  });
  const created = await page.evaluate(async ({ port, pw }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name: "Identity Lab", host: "127.0.0.1", port, password: pw, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
    } });
  }, { port: PORT, pw: ADMIN_PW });
  check("connection added through window.sem.api (native transport, pinned)", created.status === 201 && created.body.state?.ok, `id ${created.body.id}, ok ${created.body.state?.ok}`);
  const sid = created.body.id;
  await page.reload();   // the sidebar lists the new connection
  await page.waitForLoadState("load");

  // ================================================================ USERS
  await go(sid, "users");
  await page.getByTestId("user-row-alice").waitFor({ timeout: 20_000 });
  const enumUsers = (await seRpc("EnumUser", { HubName_str: "DEFAULT" })).UserList;
  const rowCount = await page.getByTestId("users-table").locator("tbody tr").count();
  const bobText = await page.getByTestId("user-row-bob").innerText();
  const frankText = await page.getByTestId("user-row-frank").innerText();
  const henryText = await page.getByTestId("user-row-henry").innerText();
  const aliceCell = await page.getByTestId("user-realname-alice").innerText().catch(() => "");
  check("Users: the list shows the note next to the full name (web had a Note column)", /Alice Martin/.test(aliceCell) && /MacBook/.test(aliceCell), aliceCell);
  check("Users: table lists every user with auth type and status", rowCount === enumUsers.length && /User cert/.test(bobText) && /Expired/.test(frankText) && /Denied/.test(henryText),
    `${rowCount} rows / ${enumUsers.length} users; bob "${bobText.replace(/\s+/g, " ")}"; frank Expired ${/Expired/.test(frankText)}; henry Denied ${/Denied/.test(henryText)}`);
  await shoot("users");

  await pickOption("users-auth-filter", "RADIUS");
  const radiusRows = await page.getByTestId("users-table").locator("tbody tr").allInnerTexts();
  await page.getByTestId("users-auth-filter").locator("..").locator("button, [data-combobox-clear]").first().click().catch(() => undefined);
  await page.keyboard.press("Escape");
  check("Users: authentication filter", radiusRows.length === 1 && /dave/.test(radiusRows[0]), radiusRows.map((r) => r.split("\t")[0]).join(", "));
  // Reset the filter by reloading the page state
  await go(sid, "groups"); await go(sid, "users");
  await page.getByTestId("user-row-alice").waitFor();

  // Keyboard: focus the table, arrow to a row, Enter opens the edit sheet
  await page.getByTestId("user-row-alice").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await sheetOpen("user-form");
  const kbTitle = await page.locator(".sem-sheet-title").innerText();
  check("Users: ↓ then Enter opens the edit sheet of the next row", /bob/.test(kbTitle), kbTitle);
  await pane("user-panes", "Authentication");
  await shoot("user-sheet-auth-cert");
  await page.keyboard.press("Escape");
  await sheetClosed("user-form");

  // Create a user with password, group and a policy
  await page.getByTestId("create-user").click();
  await sheetOpen("user-form");
  await page.getByTestId("user-name").fill("ivan");
  await page.getByTestId("user-realname").fill("Ivan Petrov");
  await page.getByTestId("user-note").fill("Created by the desktop E2E");
  await pickOption("user-group", /^staff/);
  await shoot("user-sheet-new-general");
  await pane("user-panes", "Authentication");
  await page.getByTestId("user-password").fill("Ivan#Pass1");
  await page.getByTestId("user-password2").fill("Ivan#Pass2");
  const mismatch = await page.getByText("The passwords don’t match.").first().isVisible();
  const disabledOnMismatch = await page.getByTestId("user-save").isDisabled();
  await page.getByTestId("user-password2").fill("Ivan#Pass1");
  await pane("user-panes", /^Security Policy/);
  await page.getByTestId("user-use-policy").check({ force: true });
  await page.getByTestId("policy-policy:MaxUpload_u32").fill("2000000");
  await page.getByTestId("policy-policy:PrivacyFilter_bool").check({ force: true });
  await shoot("user-sheet-policy");
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const ivan = await getUser("ivan");
  check("Users: Add User… creates the user (password, group, note, policy)",
    ivan.GroupName_str === "staff" && ivan.AuthType_u32 === 1 && ivan.Note_utf === "Created by the desktop E2E" && ivan.UsePolicy_bool && ivan["policy:MaxUpload_u32"] === 2000000 && ivan["policy:PrivacyFilter_bool"] && mismatch && disabledOnMismatch,
    `group ${ivan.GroupName_str}, auth ${ivan.AuthType_u32}, policy ${ivan.UsePolicy_bool} up ${ivan["policy:MaxUpload_u32"]}, mismatch msg ${mismatch}, save disabled ${disabledOnMismatch}`);

  // Edit alice without touching the password: the hash must survive
  const alice0 = await getUser("alice");
  await page.getByTestId("user-row-alice").dblclick();
  await sheetOpen("user-form");
  await page.getByTestId("user-realname").fill("Alice Martin-Lee");
  await shoot("user-sheet-edit-general");
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const alice1 = await getUser("alice");
  // Parity review regression: a user changed elsewhere (another admin, the Groups page, an import) while its
  // GetUser result is still cached must open with the server's current values, not the cached copy.
  const ext = { ...(await getUser("alice")), HubName_str: "DEFAULT", Realname_utf: "Alice (changed elsewhere)" };
  delete ext.Auth_Password_str;
  await seRpc("SetUser", ext);
  await page.getByTestId("user-row-alice").dblclick();
  await sheetOpen("user-form");
  await sleep(600);
  const reopened = await page.getByTestId("user-realname").inputValue();
  await page.keyboard.press("Escape");
  await sheetClosed("user-form");
  await seRpc("SetUser", { ...ext, Realname_utf: "Alice Martin-Lee" });
  const aliceExt = await getUser("alice");
  check("Users: reopening a user changed elsewhere shows the server’s values (no stale cached form)", reopened === "Alice (changed elsewhere)" && aliceExt.HashedKey_bin === alice0.HashedKey_bin,
    `form showed "${reopened}"; hash kept by the external edit ${aliceExt.HashedKey_bin === alice0.HashedKey_bin}`);
  check("Users: editing without a new password keeps the password hash", alice1.Realname_utf === "Alice Martin-Lee" && alice1.HashedKey_bin === alice0.HashedKey_bin && !!alice0.HashedKey_bin,
    `realname "${alice1.Realname_utf}", hash kept ${alice1.HashedKey_bin === alice0.HashedKey_bin}`);

  // Generate a new password for alice: the hash changes, the password is shown once
  await rightClick("user-row-alice");
  await page.getByText("Authentication…").click();
  await sheetOpen("user-form");
  await page.getByTestId("user-generate-password").click();
  const shown = await page.getByTestId("user-generated-password").innerText();
  await shoot("user-sheet-generated-password");
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const alice2 = await getUser("alice");
  check("Users: Generate sets a new password (hash changes) and shows it once", alice2.HashedKey_bin !== alice1.HashedKey_bin && /Copy the generated password/.test(shown), `hash changed ${alice2.HashedKey_bin !== alice1.HashedKey_bin}`);

  // Signed-certificate limits for carol
  await page.getByTestId("user-row-carol").dblclick();
  await sheetOpen("user-form");
  await pane("user-panes", "Authentication");
  const serialShown = await page.getByTestId("user-serial").inputValue();
  await page.getByTestId("user-cn").fill("carol2.example");
  await page.getByTestId("user-serial").fill("zz");
  const serialErr = await page.getByText("Not valid hexadecimal bytes.").isVisible();
  await page.getByTestId("user-serial").fill("0A:0B:0C");
  await shoot("user-sheet-auth-signed");
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const carol = await getUser("carol");
  check("Users: signed-certificate CN and serial limits", carol.CommonName_utf === "carol2.example" && Buffer.from(carol.Serial_bin, "base64").toString("hex") === "0a0b0c" && serialShown === "01:02:03" && serialErr,
    `CN ${carol.CommonName_utf}, serial ${Buffer.from(carol.Serial_bin, "base64").toString("hex")} (was shown as ${serialShown}), invalid hex flagged ${serialErr}`);

  // RADIUS / NT names round-trip
  await page.getByTestId("user-row-dave").dblclick();
  await sheetOpen("user-form");
  await pane("user-panes", "Authentication");
  const radiusShown = await page.getByTestId("user-radius-name").inputValue();
  await page.getByTestId("user-authtype-5").check({ force: true });
  await page.getByTestId("user-nt-name").fill("CORP\\dave");
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const dave = await getUser("dave");
  check("Users: RADIUS name shown, switching to NT domain auth saves the NT name", radiusShown === "dave@corp" && dave.AuthType_u32 === 5 && dave.NtUsername_utf === "CORP\\dave", `radius shown ${radiusShown}; now auth ${dave.AuthType_u32} nt ${dave.NtUsername_utf}`);

  // New certificate user: certificate loaded through the native Open dialog
  const pemPath = path.join(FILES, "jane.pem");
  writeFileSync(pemPath, `-----BEGIN CERTIFICATE-----\n${cert.Cert_bin.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`);
  await setDialogs({ open: pemPath });
  await page.getByTestId("create-user").click();
  await sheetOpen("user-form");
  await page.getByTestId("user-name").fill("jane");
  await pane("user-panes", "Authentication");
  await page.getByTestId("user-authtype-2").check({ force: true });
  const certBlocked = await page.getByTestId("user-save").isDisabled();
  // Parity review: the web page accepted DER (.cer) as well as PEM. Load a DER file first, then replace it with the PEM.
  const derPath = path.join(FILES, "jane.cer");
  writeFileSync(derPath, Buffer.from(cert.Cert_bin, "base64"));
  await setDialogs({ open: derPath });
  await page.getByTestId("user-cert-upload").click();
  await page.getByTestId("user-cert-info").waitFor({ timeout: 5000 });
  const derInfo = await page.getByTestId("user-cert-info").innerText();
  check("Users: a DER (.cer) certificate is accepted too", /Issuer/.test(derInfo) && !(await page.getByTestId("user-save").isDisabled()), derInfo.replace(/\s+/g, " ").slice(0, 80));
  await setDialogs({ open: pemPath });
  await page.getByTestId("user-cert-upload").click();
  await sleep(400);
  await page.getByTestId("user-cert-info").waitFor({ timeout: 5000 });
  const certInfo = await page.getByTestId("user-cert-info").innerText();
  await shoot("user-sheet-new-cert");
  const savePem = path.join(FILES, "jane-saved.pem");
  await setDialogs({ save: savePem });
  await page.getByTestId("user-cert-save").click();
  await sleep(500);
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const jane = await getUser("jane");
  const savedPem = existsSync(savePem) ? readFileSync(savePem, "utf8") : "";
  check("Users: certificate auth — Choose Certificate… (native dialog) and Save PEM…",
    jane.AuthType_u32 === 2 && jane.UserX_bin === cert.Cert_bin && certBlocked && /Issuer/.test(certInfo) && savedPem.replace(/\s+/g, "").includes(cert.Cert_bin.slice(0, 60)),
    `auth ${jane.AuthType_u32}, cert equal ${jane.UserX_bin === cert.Cert_bin}, blocked before ${certBlocked}, info "${certInfo.replace(/\s+/g, " ").slice(0, 80)}", PEM saved ${savedPem.length} B`);

  // Expiration: frank never expires
  await page.getByTestId("user-row-frank").dblclick();
  await sheetOpen("user-form");
  const hadExpiry = await page.getByTestId("user-expiry").isVisible();
  await page.getByTestId("user-never-expires").check({ force: true });
  await page.getByTestId("user-save").click();
  await sheetClosed("user-form");
  const frank = await getUser("frank");
  check("Users: expiration date shown and cleared (Never expires)", hadExpiry && new Date(frank.ExpireTime_dt).getUTCFullYear() <= 1970, `had expiry field ${hadExpiry}; now ${frank.ExpireTime_dt}`);

  // Statistics pane
  await page.getByTestId("user-row-linkuser").dblclick();
  await sheetOpen("user-form");
  await pane("user-panes", "Statistics");
  const stats = await page.getByTestId("user-stats").innerText();
  await shoot("user-sheet-stats");
  await page.keyboard.press("Escape");
  await sheetClosed("user-form");
  check("Users: statistics pane (sign-ins, traffic)", /Number of sign-ins/.test(stats) && /Unicast received/.test(stats), stats.replace(/\s+/g, " ").slice(0, 120));

  // Export CSV through the native Save dialog
  const csvOut = path.join(FILES, "export.csv");
  await setDialogs({ save: csvOut });
  await page.getByTestId("export-users").click();
  await until(() => existsSync(csvOut), "export file", 5000);
  const csv = readFileSync(csvOut, "utf8");
  const csvLines = csv.trim().split(/\r?\n/);
  const nUsers = (await seRpc("EnumUser", { HubName_str: "DEFAULT" })).UserList.length;
  check("Users: Export… writes a CSV through the Save dialog", csvLines[0].startsWith("name,password,group,realname,note,auth_type") && csvLines.length === nUsers + 1 && csv.includes("ivan,,staff,Ivan Petrov"),
    `${csvLines.length - 1} rows for ${nUsers} users; header ${csvLines[0].slice(0, 60)}`);

  // Import CSV: file via the Open dialog, preview, create missing group, generated password saved
  const csvIn = path.join(FILES, "import.csv");
  writeFileSync(csvIn, "name,password,group,realname,note\nkim,,newgroup,Kim Lee,imported\nleo,Leo#Pass9,staff,Leo Park,\nalice,,,Alice Updated,\nbad user,x,,,\n");
  await setDialogs({ open: csvIn });
  await page.getByTestId("import-users").click();
  await page.getByTestId("import-file").click();
  await page.getByTestId("import-preview").waitFor({ timeout: 5000 });
  const preview = await page.getByTestId("import-preview").innerText();
  const runLabel = await page.getByTestId("import-run").innerText();
  await shoot("users-import-preview");
  await page.getByTestId("import-run").click();
  await page.getByTestId("import-results").waitFor({ timeout: 15_000 });
  await shoot("users-import-results");
  const pwOut = path.join(FILES, "passwords.csv");
  await setDialogs({ save: pwOut });
  await page.getByTestId("import-download-passwords").click();
  await until(() => existsSync(pwOut), "passwords file", 5000);
  const pwCsv = readFileSync(pwOut, "utf8");
  await page.getByTestId("import-done").click();
  const kim = await getUser("kim");
  const leo = await getUser("leo");
  const aliceAfterImport = await getUser("alice");
  const groupsAfter = (await seRpc("EnumGroup", { HubName_str: "DEFAULT" })).GroupList.map((g) => g.Name_str);
  check("Users: Import… (Open dialog → preview → import → Save Passwords…)",
    /Exists · skip/.test(preview) && /spaces/.test(preview) && /Import 2 Users/.test(runLabel) && kim.GroupName_str === "newgroup" && leo.GroupName_str === "staff"
      && groupsAfter.includes("newgroup") && /^name,password\r?\nkim,/.test(pwCsv) && aliceAfterImport.Realname_utf === "Alice Martin-Lee",
    `run "${runLabel}", kim→${kim.GroupName_str}, leo→${leo.GroupName_str}, groups ${groupsAfter.join("/")}, pw file ${pwCsv.split(/\r?\n/).length - 2} rows, alice untouched ${aliceAfterImport.Realname_utf}`);

  // Delete one user from the context menu
  await page.getByTestId("user-row-jane").waitFor();
  await rightClick("user-row-jane");
  await shoot("users-context-menu");
  await page.getByTestId("delete-user-jane").click();
  await confirmDialog("delete-user");
  await sleep(800);
  const afterDel = (await seRpc("EnumUser", { HubName_str: "DEFAULT" })).UserList.map((u) => u.Name_str);
  check("Users: Delete User… (context menu + confirmation)", !afterDel.includes("jane"), afterDel.join(", "));

  // Bulk delete kim + leo (⌘-click, toolbar, typed confirmation)
  await page.getByTestId("user-row-kim").click();
  await page.getByTestId("user-row-leo").click({ modifiers: ["Meta"] });
  await page.getByTestId("bulk-delete-users-button").click();
  await page.getByTestId("bulk-delete-users-dialog").waitFor();
  await shoot("users-bulk-delete-confirm");
  await confirmDialog("bulk-delete-users", "delete 2 users");
  await sleep(1200);
  const afterBulk = (await seRpc("EnumUser", { HubName_str: "DEFAULT" })).UserList.map((u) => u.Name_str);
  check("Users: multi-select Delete 2… with typed confirmation", !afterBulk.includes("kim") && !afterBulk.includes("leo") && afterBulk.includes("alice"), afterBulk.join(", "));

  // ================================================================ GROUPS
  await go(sid, "groups");
  await page.getByTestId("group-row-staff").waitFor({ timeout: 15_000 });
  const staffRow = await page.getByTestId("group-row-staff").innerText();
  const contractorsRow = await page.getByTestId("group-row-contractors").innerText();
  const staffMembers = (await seRpc("EnumUser", { HubName_str: "DEFAULT" })).UserList.filter((u) => u.GroupName_str === "staff").length;
  check("Groups: table lists groups with member counts and access", staffRow.includes(String(staffMembers)) && /Denied by policy/.test(contractorsRow) && /Allowed/.test(staffRow),
    `staff "${staffRow.replace(/\s+/g, " ")}" (${staffMembers} members); contractors denied ${/Denied/.test(contractorsRow)}`);
  await shoot("groups");

  await page.getByTestId("create-group").click();
  await sheetOpen("group-form");
  await page.getByTestId("group-name").fill("engineering");
  await page.getByTestId("group-realname").fill("Engineering");
  await page.getByTestId("group-note").fill("Build and lab machines");
  await shoot("group-sheet-new");
  await pane("group-panes", /^Security Policy/);
  await page.getByTestId("group-use-policy").check({ force: true });
  await page.getByTestId("policy-policy:MaxDownload_u32").fill("5000000");
  await page.getByTestId("policy-policy:NoBridge_bool").check({ force: true });
  await page.getByTestId("group-save").click();
  await sheetClosed("group-form");
  const eng = await seRpc("GetGroup", { HubName_str: "DEFAULT", Name_str: "engineering" });
  check("Groups: Add Group… with a security policy", eng.Realname_utf === "Engineering" && eng.Note_utf === "Build and lab machines" && eng.UsePolicy_bool && eng["policy:MaxDownload_u32"] === 5000000 && eng["policy:NoBridge_bool"],
    `realname ${eng.Realname_utf}, policy ${eng.UsePolicy_bool}, down ${eng["policy:MaxDownload_u32"]}, NoBridge ${eng["policy:NoBridge_bool"]}`);

  // Members: add dave, remove alice (password hashes must survive the SetUser round trip)
  const daveHash = (await getUser("dave")).HashedKey_bin;
  const aliceHash = (await getUser("alice")).HashedKey_bin;
  await rightClick("group-row-staff");
  await page.getByTestId("members-group-staff").click();
  await page.getByTestId("group-members-table").waitFor();
  await pickOption("group-add-member-select", /^dave/);
  await page.getByTestId("group-add-member").click();
  await until(async () => (await getUser("dave")).GroupName_str === "staff", "dave in staff", 8000);
  await page.getByTestId("group-members-table").getByText("dave", { exact: true }).waitFor();
  await shoot("group-sheet-members");
  await page.getByTestId("group-remove-alice").click();
  await until(async () => (await getUser("alice")).GroupName_str === "", "alice out of staff", 8000);
  const aliceNow = await getUser("alice");
  const daveNow = await getUser("dave");
  check("Groups: Members pane adds and removes users (GetUser + SetUser keeps the rest)", daveNow.GroupName_str === "staff" && aliceNow.GroupName_str === "" && aliceNow.HashedKey_bin === aliceHash && daveNow.HashedKey_bin === daveHash && daveNow.NtUsername_utf === "CORP\\dave",
    `dave→${daveNow.GroupName_str}, alice→"${aliceNow.GroupName_str}", hashes kept ${aliceNow.HashedKey_bin === aliceHash}`);
  await pane("group-panes", /^Security Policy/);
  await shoot("group-sheet-policy");
  await page.keyboard.press("Escape");
  await sheetClosed("group-form");

  await rightClick("group-row-newgroup");
  await page.getByTestId("delete-group-newgroup").click();
  await confirmDialog("delete-group");
  await sleep(800);
  const groupsNow = (await seRpc("EnumGroup", { HubName_str: "DEFAULT" })).GroupList.map((g) => g.Name_str);
  check("Groups: Delete Group… (context menu + confirmation)", !groupsNow.includes("newgroup") && groupsNow.includes("engineering"), groupsNow.join(", "));

  // ================================================================ SESSIONS
  await go(sid, "sessions");
  const srvSessions = (await seRpc("EnumSession", { HubName_str: "DEFAULT" })).SessionList;
  const nat = srvSessions.find((s) => s.SecureNATMode_bool);
  const link = srvSessions.find((s) => s.Username_str === "linkuser");
  await page.getByTestId(`session-row-${nat.Name_str}`).waitFor({ timeout: 15_000 });
  const natRow = await page.getByTestId(`session-row-${nat.Name_str}`).innerText();
  const linkRow = await page.getByTestId(`session-row-${link.Name_str}`).innerText();
  check("Sessions: table lists SecureNAT and the cascade session", /SecureNAT/.test(natRow) && /linkuser/.test(linkRow), `${nat.Name_str}: ${natRow.replace(/\s+/g, " ").slice(0, 80)} | ${link.Name_str}`);
  await shoot("sessions");
  await page.getByTestId(`session-row-${link.Name_str}`).dblclick();
  await page.getByTestId("session-status").waitFor({ timeout: 10_000 });
  const insp = await page.getByTestId("session-inspector").innerText();
  await shoot("sessions-inspector");
  check("Sessions: double-click opens the details Inspector (GetSessionStatus)", /Session status/.test(insp) && /linkuser/.test(insp) && /Traffic/.test(insp), insp.replace(/\s+/g, " ").slice(0, 140));
  await page.getByTestId("inspector-close").click();
  {
    const viaApp = await page.evaluate(async ({ sid, n }) => (await window.sem.api({ method: "POST", path: `/api/servers/${sid}/rpc/GetSessionStatus`, body: { HubName_str: "DEFAULT", Name_str: n } })).body, { sid, n: link.Name_str });
    const viaJson = await seRpc("GetSessionStatus", { HubName_str: "DEFAULT", Name_str: link.Name_str });
    const keys = ["ClientPort_u32", "ClientProductVer_u32", "ClientProductBuild_u32", "ClientIpAddress_ip", "Username_str"];
    const diff = keys.filter((k) => JSON.stringify(viaApp?.[k]) !== JSON.stringify(viaJson[k]));
    info.push(`cascade GetSessionStatus native vs JSON-RPC: ${diff.length ? `differs in ${diff.map((k) => `${k} ${JSON.stringify(viaApp?.[k])}≠${JSON.stringify(viaJson[k])}`).join(", ")}` : `identical (${keys.map((k) => `${k}=${JSON.stringify(viaJson[k])}`).join(", ")})`}`);
  }

  await rightClick(`session-row-${link.Name_str}`);
  await page.getByTestId(`disconnect-${link.Name_str}`).click();
  await page.getByTestId("disconnect-session-dialog").waitFor();
  await shoot("sessions-disconnect-confirm");
  await confirmDialog("disconnect-session");
  await sleep(700);
  const after = (await seRpc("EnumSession", { HubName_str: "DEFAULT" })).SessionList.map((s) => s.Name_str);
  check("Sessions: Disconnect… ends the session on the server", !after.includes(link.Name_str), `${link.Name_str} gone; now ${after.join(", ")}`);

  // Parity review regression: the cascade re-connects under a new session name; open it, end it behind the
  // app's back and the Inspector must say so instead of showing the last status as if it were live.
  const relinked = await until(async () => (await seRpc("EnumSession", { HubName_str: "DEFAULT" })).SessionList.find((s) => s.Username_str === "linkuser" && s.Name_str !== link.Name_str), "cascade reconnect", 60_000);
  await page.getByTestId(`session-row-${relinked.Name_str}`).waitFor({ timeout: 15_000 });
  await page.getByTestId(`session-row-${relinked.Name_str}`).dblclick();
  await page.getByTestId("session-status").waitFor({ timeout: 10_000 });
  await seRpc("DeleteSession", { HubName_str: "DEFAULT", Name_str: relinked.Name_str });
  await page.getByTestId("session-error").waitFor({ timeout: 15_000 }).catch(() => undefined);
  const endedText = await page.getByTestId("session-inspector").innerText();
  const endedShown = await page.getByTestId("session-error").isVisible().catch(() => false);
  const endedNoDisconnect = await page.getByTestId("session-disconnect").isDisabled().catch(() => false);
  await shoot("sessions-inspector-ended");
  await page.getByTestId("inspector-close").click();
  check("Sessions: Inspector reports a session that ended elsewhere (and Disconnect… is disabled)", endedShown && endedNoDisconnect && /This session has ended/.test(endedText) && /Ended/.test(endedText),
    `disconnect disabled ${endedNoDisconnect}; ${endedText.replace(/\s+/g, " ").slice(0, 160)}`);

  await rightClick(`session-row-${nat.Name_str}`);
  await page.getByTestId(`session-tables-${nat.Name_str}`).click();
  await page.getByTestId("mac-table").waitFor({ timeout: 10_000 });
  const url = page.url();
  check("Sessions: “Show MAC & IP Entries” opens the tables filtered to the session", url.includes(`/tables?session=${encodeURIComponent(nat.Name_str)}`), url.split("#")[1]);

  // ================================================================ MAC & IP TABLES
  await sleep(800);
  const macSrv = (await seRpc("EnumMacTable", { HubName_str: "DEFAULT" })).MacTable;
  const ipSrv = (await seRpc("EnumIpTable", { HubName_str: "DEFAULT" })).IpTable;
  const macRows = await page.getByTestId("mac-table").locator("tbody tr").count();
  const ipRows = await page.getByTestId("ip-table").locator("tbody tr").count();
  const natMac = macSrv.filter((r) => r.SessionName_str === nat.Name_str).length;
  const natIp = ipSrv.filter((r) => r.SessionName_str === nat.Name_str).length;
  check("Tables: session-filtered MAC and IP tables match the server", macRows === natMac && ipRows === natIp && natIp > 0, `MAC ${macRows}/${natMac}, IP ${ipRows}/${natIp} for ${nat.Name_str}`);
  await shoot("tables-filtered");
  await page.getByTestId("tables-session-filter").locator("..").locator("button").first().click().catch(() => undefined);
  await go(sid, "tables");
  await page.getByTestId("mac-table").locator("tbody tr").first().waitFor({ timeout: 10_000 });
  const allMac = await page.getByTestId("mac-table").locator("tbody tr").count();
  check("Tables: unfiltered MAC table", allMac === (await seRpc("EnumMacTable", { HubName_str: "DEFAULT" })).MacTable.length, `${allMac} rows`);
  await shoot("tables");

  const target = (await seRpc("EnumIpTable", { HubName_str: "DEFAULT" })).IpTable[0];
  await rightClick(`ip-row-${target.IpAddress_ip}`);
  await page.getByTestId(`delete-ip-${target.IpAddress_ip}`).click();
  await page.getByTestId("delete-ip-dialog").waitFor({ timeout: 5000 });
  const ipDlg = await page.getByTestId("delete-ip-dialog").innerText();
  check("Tables: the delete confirmation names the IP address", ipDlg.includes(target.IpAddress_ip), ipDlg.replace(/\s+/g, " ").slice(0, 100));
  await confirmDialog("delete-ip");
  await sleep(800);
  const ipAfter = (await seRpc("EnumIpTable", { HubName_str: "DEFAULT" })).IpTable;
  // SecureNAT re-learns its own addresses within seconds, under the same key: an entry that is back must be a new one.
  const same = (a, b) => a.Key_u32 === b.Key_u32 && a.CreatedTime_dt === b.CreatedTime_dt;
  check("Tables: Delete Entry… removes the IP table entry", !ipAfter.some((r) => same(r, target)), `key ${target.Key_u32} (${target.IpAddress_ip}, created ${target.CreatedTime_dt}) removed; now ${ipAfter.map((r) => `${r.Key_u32}@${r.CreatedTime_dt}`).join(", ") || "none"}`);

  const macs = (await seRpc("EnumMacTable", { HubName_str: "DEFAULT" })).MacTable;
  const macLabel = (r) => Buffer.from(r.MacAddress_bin, "base64").toString("hex").toUpperCase().match(/../g).join("-");
  await page.getByTestId(`mac-row-${macLabel(macs[0])}`).click();
  if (macs[1]) await page.getByTestId(`mac-row-${macLabel(macs[1])}`).click({ modifiers: ["Meta"] });
  await page.getByTestId("mac-delete-selected").click();
  await confirmDialog("bulk-DeleteMacTable");
  await sleep(900);
  const macAfter = (await seRpc("EnumMacTable", { HubName_str: "DEFAULT" })).MacTable;
  const gone = macs.slice(0, 2).every((m) => !macAfter.some((r) => same(r, m)));
  check("Tables: multi-select Delete… removes MAC entries", gone, `deleted ${macs.slice(0, 2).map((m) => `${m.Key_u32}@${m.CreatedTime_dt}`).join(",")}; now ${macAfter.map((m) => `${m.Key_u32}@${m.CreatedTime_dt}`).join(",") || "none"}`);

  // Empty state of a filtered table
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/hubs/DEFAULT/tables?session=SID-NOBODY-1`);
  await sleep(700);
  const emptyText = await page.getByTestId("mac-table").innerText();
  check("Tables: empty state for a session without entries", /No MAC Addresses for This Session/.test(emptyText), emptyText.replace(/\s+/g, " ").slice(0, 80));
  await shoot("tables-empty");

  const filtered = problems.filter((p) => !/Failed to load resource/.test(p));
  check("no console errors, page errors or CSP violations", filtered.length === 0, filtered.slice(0, 4).join(" | ") || "none");

  // Parity review: server down → one "Can’t reach …" state instead of a failing RPC per table.
  killServer();
  await sleep(800);
  await page.evaluate(async (sid) => { await window.sem.api({ method: "POST", path: `/api/servers/${sid}/refresh` }); }, sid);
  await go(sid, "users");
  const down = await page.getByTestId("hub-unreachable").waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const downText = down ? await page.getByTestId("hub-unreachable").innerText() : "";
  await go(sid, "sessions");
  const downSessions = await page.getByTestId("hub-unreachable").isVisible().catch(() => false);
  const tableGone = !(await page.getByTestId("sessions-table").isVisible().catch(() => false));
  const staleMeta = await page.getByTestId("sessions-count").isVisible().catch(() => false);
  await shoot("users-unreachable");
  check("Server down: Users and Sessions show one “Can’t reach …” state (no per-table errors)", down && downSessions && tableGone && !staleMeta && /Can’t reach Identity Lab/.test(downText), `stale session count shown ${staleMeta}; ${downText}`.replace(/\s+/g, " ").slice(0, 120));

} catch (e) {
  check("run completed", false, e?.stack ?? e);
  try { await page?.screenshot({ path: path.join(ART, "failure.png") }); } catch { /* no window */ }
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  killServer();
  await sleep(500);
  let alive = false;
  try { process.kill(-se.pid, 0); alive = true; } catch { /* gone */ }
  check("vpnserver process group stopped", !alive, `pgid ${se.pid}`);
  rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
const at = new Date().toISOString();
writeFileSync(path.join(ART, "report.json"), JSON.stringify({ at, port: PORT, work: WORK, passed: results.length - failed, failed, results, problems, info }, null, 2));
const cell = (t) => String(t).replace(/\|/g, "\\|").replace(/\s+/g, " ");
writeFileSync(path.join(ART, "REPORT.md"), [
  "# Hub identity & traffic pages: E2E report",
  "",
  `Generated by \`run.mjs\` at ${at}. Real vpnserver on port ${PORT} (run dir \`${WORK}\`), real Electron app via Playwright.`,
  "",
  `**${results.length - failed} of ${results.length} checks passed.** Screenshots: \`apps/desktop/design-screenshots/pages/hub-identity-traffic/\`.`,
  "",
  "| | Check | Detail |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.ok ? "ok" : "**FAIL**"} | ${cell(r.step)} | ${cell(r.detail)} |`),
  "",
  ...(info.length ? ["Notes:", "", ...info.map((i) => `* ${i}`), ""] : []),
].join("\n"));
console.log(`${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
