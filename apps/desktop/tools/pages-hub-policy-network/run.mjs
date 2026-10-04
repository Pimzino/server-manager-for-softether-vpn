// E2E for the hub pages Access Lists, Source IP Control, Cascade Connections and SecureNAT
// (apps/desktop/src/renderer/pages/hub/{Access,AcList,Cascades,SecureNat}.tsx).
//
// 1. Builds the real app into a scratch dir (main + preload with the production esbuild options, renderer with Vite).
// 2. Starts a throwaway SoftEther VPN Server (se.mjs: port 15916, run dir ~/se-desk-pages-hub-policy-network).
// 3. Creates fixtures by JSON-RPC, launches Electron with Playwright (_electron, fresh SEM_DATA_DIR,
//    SEM_INSECURE_KEYSTORE=1), adds the connection and drives every page through the UI.
// 4. Checks each UI write on the server with a direct RPC, saves light + dark screenshots to
//    apps/desktop/design-screenshots/pages/hub-policy-network/ and report.json next to this script.
// 5. Kills the vpnserver process group.
//
//   node "apps/desktop/tools/pages-hub-policy-network/run.mjs"          (HPN_BUILD=<dir> to change the build dir,
//   SE_PORT / SE_RUN to change the vpnserver port and run dir; the parity review ran SE_PORT=16016
//   SE_RUN=~/se-desk-parity-hub-policy-network)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADMIN_PW, PORT, RUN, seRpc, startServer, stopServer } from "./se.mjs";

const HERE = import.meta.dirname;
const DESK = path.resolve(HERE, "../..");
const REPO = path.resolve(DESK, "../..");
const OUT = process.env.HPN_BUILD ?? path.join(os.tmpdir(), "sem-hpn-build");
const SHOTS = path.join(DESK, "design-screenshots/pages/hub-policy-network");
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, step = 250) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}

// ---------------------------------------------------------------- build
const t0 = Date.now();
execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), OUT], { stdio: "inherit" });
execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(OUT, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
console.log(`build: ${Date.now() - t0} ms → ${OUT}`);

// ---------------------------------------------------------------- server + fixtures
process.on("exit", () => stopServer());
process.on("SIGINT", () => { stopServer(); process.exit(130); });
await startServer();
const info = await seRpc("GetServerInfo");
check("SoftEther VPN Server started", true, `${info.ServerVersionString_str} on ${PORT}, run dir ${RUN}`);

const HUB = "HQ";
const mkHub = (n) => seRpc("CreateHub", { HubName_str: n, Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
await mkHub(HUB);
await mkHub("BRANCH");
await seRpc("CreateUser", { HubName_str: "BRANCH", Name_str: "linkuser", Realname_utf: "Cascade from HQ", Note_utf: "", AuthType_u32: 1, Auth_Password_str: "lpass" });
const mac = (s) => Buffer.from(s.split("-").map((h) => parseInt(h, 16))).toString("base64");
const v6 = (hexBytes) => Buffer.from(hexBytes).toString("base64");
const rules = [
  { Note_utf: "Block SSH from guests", Priority_u32: 10, Discard_bool: true, Protocol_u32: 6, SrcIpAddress_ip: "10.8.0.0", SrcSubnetMask_ip: "255.255.0.0", DestPortStart_u32: 22, DestPortEnd_u32: 22 },
  { Note_utf: "Allow DNS", Priority_u32: 20, Discard_bool: false, Protocol_u32: 17, DestIpAddress_ip: "192.168.30.1", DestSubnetMask_ip: "255.255.255.255", DestPortStart_u32: 53, DestPortEnd_u32: 53 },
  { Note_utf: "Captive portal", Priority_u32: 30, Discard_bool: false, Protocol_u32: 6, DestPortStart_u32: 80, DestPortEnd_u32: 80, RedirectUrl_str: "https://portal.example.com/", Delay_u32: 50, Jitter_u32: 10, Loss_u32: 1 },
  { Note_utf: "Drop ULA", Priority_u32: 40, Discard_bool: true, Active_bool: false, IsIPv6_bool: true, Protocol_u32: 0,
    SrcIpAddress6_bin: v6([0xfd, ...Array(15).fill(0)]), SrcSubnetMask6_bin: v6([0xff, ...Array(15).fill(0)]) },
  { Note_utf: "Lab MAC", Priority_u32: 50, Discard_bool: false, Protocol_u32: 0, SrcUsername_str: "alice", CheckSrcMac_bool: true, SrcMacAddress_bin: mac("00-AC-01-23-45-67"), SrcMacMask_bin: mac("FF-FF-FF-FF-FF-FF") },
];
for (const r of rules) {
  await seRpc("AddAccess", { HubName_str: HUB, AccessListSingle: [{ Active_bool: true, IsIPv6_bool: false, DestIpAddress_ip: "0.0.0.0", DestSubnetMask_ip: "0.0.0.0", SrcIpAddress_ip: "0.0.0.0", SrcSubnetMask_ip: "0.0.0.0", ...r }] });
}
await seRpc("SetAcList", { HubName_str: HUB, ACList: [
  { Id_u32: 0, Priority_u32: 10, Deny_bool: false, Masked_bool: true, IpAddress_ip: "192.168.1.0", SubnetMask_ip: "255.255.255.0" },
  { Id_u32: 0, Priority_u32: 20, Deny_bool: true, Masked_bool: false, IpAddress_ip: "203.0.113.5", SubnetMask_ip: "0.0.0.0" },
] });
// A cascade that can never connect (nothing listens on port 1), for the error column.
await seRpc("CreateLink", { HubName_Ex_str: HUB, AccountName_utf: "old-datacenter", Hostname_str: "127.0.0.1", Port_u32: 1, HubName_str: "DC", Online_bool: true,
  AuthType_u32: 2, Username_str: "x", PlainPassword_str: "y", MaxConnection_u32: 1, UseEncrypt_bool: true, "policy:Ver3_bool": true });
await seRpc("SetLinkOnline", { HubName_str: HUB, AccountName_utf: "old-datacenter" }); // CreateLink always leaves it offline
check("fixtures created", true, "hubs HQ + BRANCH, 5 access rules, 2 source IP rules, cascade old-datacenter");

// ---------------------------------------------------------------- app
let app;
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-hpn-"));
const problems = [];
try {
  app = await electron.launch({ executablePath: require("electron"), args: [OUT], env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = "light"; BrowserWindow.getAllWindows()[0]?.setSize(1360, 900); });
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");

  const created = await page.evaluate(async ({ port, pw }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name: "HPN Lab", host: "127.0.0.1", port, password: pw, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint } });
  }, { port: PORT, pw: ADMIN_PW });
  check("connection added (native transport, pinned certificate)", created.status === 201 && created.body.state?.ok, `id ${created.body.id}, status ${created.status}`);
  const sid = created.body.id;
  await page.reload(); // the sidebar lists the connection added through the API
  await page.waitForLoadState("load");
  // page.screenshot can't capture the window's vibrancy material behind the transparent sidebar: paint the
  // non-vibrancy sidebar colour (the browser/Linux fallback token) so the screenshots show the sidebar legibly.
  await page.addStyleTag({ content: ".sem-sidebar { background: var(--sem-bg-sidebar) !important; }" });
  const go = async (sub) => { await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/hubs/${HUB}/${sub}`); await sleep(400); };
  // Mantine follows prefers-color-scheme ("auto"); switch the window material and the media query together.
  const theme = async (t) => {
    await app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, t);
    await page.emulateMedia({ colorScheme: t });
    await sleep(450);
  };
  const dismissToasts = async () => {
    await page.evaluate(() => document.querySelectorAll(".mantine-Notification-closeButton").forEach((b) => b.click()));
    await sleep(250);
  };
  const shot = async (name, opts = {}) => {
    await dismissToasts();
    await page.mouse.move(5, 890);
    await sleep(250);
    await page.screenshot({ path: path.join(SHOTS, `${name}-light.png`), ...opts });
    await theme("dark");
    await page.screenshot({ path: path.join(SHOTS, `${name}-dark.png`), ...opts });
    await theme("light");
  };
  const header = (t) => page.locator(".sem-page-title", { hasText: t }).first();

  // ============================================================== Access Lists
  await go("access");
  await header("Access Lists").waitFor({ timeout: 20_000 });
  const accessRows = page.locator('[data-testid^="access-row-"]');
  await until(async () => (await accessRows.count()) === 5);
  const firstRow = await accessRows.first().innerText();
  check("Access: table lists the server's rules in priority order", (await accessRows.count()) === 5 && /10\.8\.0\.0\/16/.test(firstRow) && /TCP 22/.test(firstRow), firstRow.replace(/\s+/g, " "));
  const ula = await accessRows.nth(3).innerText();
  check("Access: IPv6 rule rendered with prefix, disabled rule dimmed", /fd00::\/8/.test(ula) && (await accessRows.nth(3).getAttribute("data-tone")) === "dim", ula.replace(/\s+/g, " "));
  await shot("access");

  // create through the sheet, with a validation round trip
  await page.getByTestId("create-access").click();
  const sheet = page.getByTestId("access-rule-form");
  await sheet.waitFor();
  await page.getByTestId("rule-note").fill("E2E block HTTPS");
  await page.getByTestId("rule-action").getByText("Discard").click();
  await page.getByTestId("rule-priority").fill("25");
  await page.getByTestId("rule-protocol").click();
  await page.getByRole("option", { name: "TCP", exact: true }).click();
  await page.getByTestId("rule-dst-ip").fill("300.1.1.1");
  await page.getByTestId("rule-save").click();
  await sleep(300);
  const noteErr = await page.locator(".hpn-footer-note[data-error]").innerText().catch(() => "");
  check("Access: invalid address is reported and blocks saving", /IPv4 address/.test(noteErr) && await sheet.isVisible(), noteErr);
  await page.getByTestId("rule-dst-ip").fill("192.168.99.0");
  await page.getByTestId("rule-dst-mask").fill("24");
  await page.getByTestId("rule-dst-port-start").fill("443");
  await page.getByTestId("rule-dst-port-end").fill("443");
  await page.getByTestId("rule-tcpstate").check({ force: true });
  await page.waitForTimeout(150);
  await dismissToasts();
  await page.mouse.move(5, 890);
  await page.screenshot({ path: path.join(SHOTS, "access-sheet-light.png") });
  await dismissToasts(); await theme("dark"); await page.screenshot({ path: path.join(SHOTS, "access-sheet-dark.png") }); await theme("light");
  await page.getByTestId("rule-save").click();
  const added = await until(async () => (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.find((a) => a.Note_utf === "E2E block HTTPS"));
  check("Access: Add Rule… creates the rule on the server (AddAccess)",
    added && added.Discard_bool && added.Protocol_u32 === 6 && added.DestIpAddress_ip === "192.168.99.0" && added.DestSubnetMask_ip === "255.255.255.0" && added.DestPortStart_u32 === 443 && added.Priority_u32 === 25 && added.CheckTcpState_bool && added.Established_bool,
    JSON.stringify(added && { d: added.Discard_bool, p: added.Protocol_u32, ip: added.DestIpAddress_ip, m: added.DestSubnetMask_ip, port: added.DestPortStart_u32, prio: added.Priority_u32, tcp: added.CheckTcpState_bool }));

  // edit by double-click
  await until(async () => (await accessRows.count()) === 6);
  const dnsId = (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.find((a) => a.Note_utf === "Allow DNS").Id_u32;
  await page.getByTestId(`access-row-${dnsId}`).dblclick();
  await page.getByTestId("rule-note").waitFor();
  const loadedNote = await page.getByTestId("rule-note").inputValue();
  await page.getByTestId("rule-note").fill("Allow DNS to SecureNAT");
  await page.getByTestId("rule-save").click();
  const edited = await until(async () => (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.find((a) => a.Note_utf === "Allow DNS to SecureNAT"));
  check("Access: double-click opens the rule, Save updates it (SetAccessList)", loadedNote === "Allow DNS" && edited && edited.DestPortStart_u32 === 53 && edited.Protocol_u32 === 17,
    `loaded “${loadedNote}”, server: ${edited && `${edited.Note_utf} udp/${edited.DestPortStart_u32}`}`);

  // toggle with the inline switch
  await sleep(600);
  let list = (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList;
  const ssh = list.find((a) => a.Note_utf === "Block SSH from guests");
  await page.getByTestId(`toggle-access-${ssh.Id_u32}`).click({ force: true });
  const toggled = await until(async () => (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.find((a) => a.Note_utf === "Block SSH from guests" && a.Active_bool === false));
  check("Access: inline switch disables a rule", !!toggled, `Active_bool ${toggled?.Active_bool}`);

  // move down with the toolbar
  await sleep(600);
  list = (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList;
  const sshNow = list.find((a) => a.Note_utf === "Block SSH from guests");
  await page.getByTestId(`access-row-${sshNow.Id_u32}`).click();
  await page.getByTestId("access-move-down").click();
  const moved = await until(async () => {
    const l = (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList;
    const a = l.find((x) => x.Note_utf === "Block SSH from guests"), b = l.find((x) => x.Note_utf === "Allow DNS to SecureNAT");
    return a.Priority_u32 === 20 && b.Priority_u32 === 10 ? `${a.Priority_u32}/${b.Priority_u32}` : null;
  });
  check("Access: Move Down swaps priorities with the next rule", !!moved, moved ?? "not swapped");

  // delete via the context menu
  await sleep(600);
  list = (await seRpc("EnumAccess", { HubName_str: HUB })).AccessList;
  const lab = list.find((a) => a.Note_utf === "Lab MAC");
  await page.getByTestId(`access-row-${lab.Id_u32}`).click({ button: "right" });
  await page.getByTestId("context-menu").waitFor();
  await page.mouse.move(5, 890);
  await shot("access-context-menu");
  await page.getByTestId(`delete-access-${lab.Id_u32}`).click();
  await page.getByTestId("delete-access-dialog").waitFor();
  const delDlg = await page.getByTestId("delete-access-dialog").innerText();
  check("Parity: the delete confirmation names the rule's note and action, like the web page", /Lab MAC/.test(delDlg) && /Pass rule/.test(delDlg), delDlg.replace(/\s+/g, " ").slice(0, 160));
  await page.getByTestId("delete-access-confirm").click();
  const gone = await until(async () => !(await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.some((a) => a.Note_utf === "Lab MAC"));
  check("Access: context menu Delete Rule… confirms, then deletes (DeleteAccess)", !!gone, `${(await seRpc("EnumAccess", { HubName_str: HUB })).AccessList.length} rules left`);

  // ============================================================== Source IP Control
  await go("acl");
  await header("Source IP Control").waitFor({ timeout: 20_000 });
  const aclRows = page.getByTestId("acl-row");
  await until(async () => (await aclRows.count()) === 2);
  const aclText = await page.getByTestId("acl-table").innerText();
  check("Source IP: rules listed with prefix and single-host rows", /192\.168\.1\.0\/24/.test(aclText) && /203\.0\.113\.5/.test(aclText) && /Single host/.test(aclText), aclText.replace(/\s+/g, " ").slice(0, 200));
  await shot("acl");
  await page.getByTestId("acl-add").click();
  await page.getByTestId("acl-ip").waitFor();
  await page.getByTestId("acl-ip").fill("10.0.0.0");
  await page.getByTestId("acl-mask").fill("33");
  const maskErr = await page.getByTestId("acl-rule-submit").isDisabled();
  await page.getByTestId("acl-mask").fill("8");
  await dismissToasts();
  await page.mouse.move(5, 890);
  await page.screenshot({ path: path.join(SHOTS, "acl-sheet-light.png") });
  await dismissToasts(); await theme("dark"); await page.screenshot({ path: path.join(SHOTS, "acl-sheet-dark.png") }); await theme("light");
  await page.getByTestId("acl-rule-submit").click();
  await until(async () => (await aclRows.count()) === 3);
  const dirtyShown = await page.getByText("Saving replaces the hub’s whole list.").isVisible();
  await shot("acl-unsaved");
  await page.getByTestId("acl-save").click();
  const acl = await until(async () => { const l = (await seRpc("GetAcList", { HubName_str: HUB })).ACList; return l.length === 3 ? l : null; });
  const tenNet = acl?.find((r) => r.IpAddress_ip === "10.0.0.0");
  check("Source IP: staged rule + Save Rules writes the list (SetAcList)", maskErr && dirtyShown && tenNet?.Deny_bool === true && tenNet?.Masked_bool && tenNet?.SubnetMask_ip === "255.0.0.0",
    `mask 33 rejected ${maskErr}, save bar ${dirtyShown}, server ${JSON.stringify(tenNet)}`);
  // remove + revert
  await sleep(500);
  await aclRows.first().click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Remove Rule").click();
  const after = await aclRows.count();
  await page.getByTestId("acl-save-reset").click();
  await sleep(300);
  check("Source IP: Remove is staged locally and Revert restores it", after === 2 && (await aclRows.count()) === 3 && (await seRpc("GetAcList", { HubName_str: HUB })).ACList.length === 3, `after remove ${after}, after revert ${await aclRows.count()}`);

  // ============================================================== Cascade Connections
  await go("cascades");
  await header("Cascade Connections").waitFor({ timeout: 20_000 });
  await page.getByTestId("link-row-old-datacenter").waitFor({ timeout: 15_000 });
  const errShown = await until(async () => /Retrying/.test(await page.getByTestId("link-row-old-datacenter").innerText()), 20_000);
  check("Cascades: existing link listed with its state and last error", !!errShown, (await page.getByTestId("link-row-old-datacenter").innerText()).replace(/\s+/g, " "));
  // validation on an empty form
  await page.getByTestId("create-link").click();
  await page.getByTestId("link-form").waitFor();
  await page.getByTestId("link-save").click();
  await sleep(250);
  const formErr = await page.getByTestId("link-form-error").innerText();
  check("Cascades: empty form shows what's missing and doesn't save", /name/i.test(formErr) && (await page.locator(".hpn-seg-alert").count()) >= 2, `${formErr}; tabs flagged ${await page.locator(".hpn-seg-alert").count()}`);
  await page.getByTestId("link-name").fill("OLD-DATACENTER");
  await page.getByTestId("link-save").click();
  await sleep(250);
  const dupErr = await page.getByTestId("link-form-error").innerText();
  check("Parity: a new cascade can't reuse an existing name (case-insensitive)", /already has this name/.test(dupErr), dupErr);
  await page.getByTestId("link-name").fill("to-branch");
  await page.getByTestId("link-host").fill("127.0.0.1");
  await page.getByTestId("link-port").fill(String(PORT));
  await page.getByTestId("link-target-hub").fill("BRANCH");
  await dismissToasts();
  await page.mouse.move(5, 890);
  await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-light.png") });
  await dismissToasts(); await theme("dark"); await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-dark.png") }); await theme("light");
  await page.getByTestId("link-tab-auth").click();
  await page.getByTestId("link-username").fill("linkuser");
  await page.getByTestId("link-password").fill("lpass");
  await dismissToasts();
  await page.mouse.move(5, 890);
  await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-auth-light.png") });
  await dismissToasts(); await theme("dark"); await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-auth-dark.png") }); await theme("light");
  await page.getByTestId("link-save").click();
  const link = await until(async () => seRpc("GetLink", { HubName_Ex_str: HUB, AccountName_utf: "to-branch" }));
  check("Cascades: New Cascade Connection… creates it (CreateLink)", link && link.Hostname_str === "127.0.0.1" && link.Port_u32 === PORT && link.HubName_str === "BRANCH" && link.Username_str === "linkuser" && link.AuthType_u32 === 2,
    JSON.stringify(link && { h: link.Hostname_str, p: link.Port_u32, hub: link.HubName_str, u: link.Username_str, a: link.AuthType_u32 }));
  const connected = await until(async () => (await seRpc("EnumLink", { HubName_str: HUB })).LinkList.find((l) => l.AccountName_utf === "to-branch" && l.Connected_bool), 30_000, 500);
  const uiConnected = await until(async () => /Connected/.test(await page.getByTestId("link-status-to-branch").innerText()), 20_000);
  check("Cascades: the new link connects and the table shows it", !!connected && !!uiConnected, `server connected ${!!connected}, UI ${!!uiConnected}`);
  const newSel = await page.getByTestId("link-row-to-branch").getAttribute("aria-selected");
  check("Parity: the new cascade is selected after Create Connection", newSel === "true", `aria-selected ${newSel}`);
  await sleep(500);
  await shot("cascades");

  // live status in the inspector
  await page.getByTestId("link-row-to-branch").click({ button: "right" });
  await page.getByTestId("link-status-open-to-branch").click();
  const badge = await until(async () => page.getByTestId("link-status-badge").innerText(), 15_000);
  const groupsText = await page.getByTestId("link-status-groups").innerText().catch(() => "");
  check("Cascades: Show Status opens the live status inspector (GetLinkStatus)", /Established/.test(badge ?? "") && /Encryption/.test(groupsText), `badge ${badge}`);
  await shot("cascades-status");
  await page.getByTestId("inspector-close").click();

  // edit: Advanced tab, 2 TCP connections
  await page.getByTestId("link-row-to-branch").dblclick();
  await page.getByTestId("link-form").waitFor();
  await until(async () => (await page.getByTestId("link-host").inputValue()) === "127.0.0.1");
  await page.getByTestId("link-tab-advanced").click();
  await page.getByTestId("link-maxconn").fill("2");
  await dismissToasts();
  await page.mouse.move(5, 890);
  await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-advanced-light.png") });
  await dismissToasts(); await theme("dark"); await page.screenshot({ path: path.join(SHOTS, "cascade-sheet-advanced-dark.png") }); await theme("light");
  await page.getByTestId("link-save").click();
  const l2 = await until(async () => { const l = await seRpc("GetLink", { HubName_Ex_str: HUB, AccountName_utf: "to-branch" }); return l.MaxConnection_u32 === 2 ? l : null; });
  check("Cascades: editing saves through SetLink (password kept)", l2 && l2.Username_str === "linkuser" && l2.HubName_str === "BRANCH", JSON.stringify(l2 && { max: l2.MaxConnection_u32, auth: l2.AuthType_u32 }));

  // offline switch
  await sleep(800);
  await page.getByTestId("link-online-to-branch").click({ force: true });
  const off = await until(async () => (await seRpc("EnumLink", { HubName_str: HUB })).LinkList.find((l) => l.AccountName_utf === "to-branch" && !l.Online_bool));
  check("Cascades: inline switch takes the link offline (SetLinkOffline)", !!off);
  await page.getByTestId("link-row-to-branch").click({ button: "right" });
  await page.getByTestId("link-status-open-to-branch").click();
  const offNote = await until(async () => page.getByTestId("link-status-offline").isVisible(), 5000);
  const statusErr = await page.getByTestId("link-status-error").count();
  check("Parity: status of an offline cascade explains it instead of polling GetLinkStatus", !!offNote && statusErr === 0, `offline note ${!!offNote}, errors ${statusErr}`);
  await page.getByTestId("inspector-close").click();

  // rename
  await page.getByTestId("link-row-to-branch").click({ button: "right" });
  await page.getByTestId("link-rename-to-branch").click();
  await page.getByTestId("link-rename-input").fill("hq-to-branch");
  await page.getByTestId("link-rename-save").click();
  const renamed = await until(async () => (await seRpc("EnumLink", { HubName_str: HUB })).LinkList.find((l) => l.AccountName_utf === "hq-to-branch"));
  check("Cascades: Rename… renames it (RenameLink)", !!renamed);

  // delete with typed confirmation
  await page.getByTestId("link-row-old-datacenter").click({ button: "right" });
  await page.getByTestId("link-delete-old-datacenter").click();
  await page.getByTestId("delete-link-dialog").waitFor();
  const blocked = await page.getByTestId("delete-link-confirm").isDisabled();
  await page.getByTestId("confirm-type").fill("old-datacenter");
  await page.mouse.move(5, 890);
  await shot("cascades-delete-confirm");
  await page.getByTestId("delete-link-confirm").click();
  const deleted = await until(async () => !(await seRpc("EnumLink", { HubName_str: HUB })).LinkList.some((l) => l.AccountName_utf === "old-datacenter"));
  check("Cascades: Delete… needs the typed name, then deletes (DeleteLink)", blocked && !!deleted, `button blocked before typing ${blocked}`);

  // ============================================================== SecureNAT
  await go("securenat");
  await header("SecureNAT").waitFor({ timeout: 20_000 });
  await page.getByTestId("securenat-form").waitFor({ timeout: 15_000 });
  const opt = await seRpc("GetSecureNATOption", { RpcHubName_str: HUB });
  const ipShown = await page.getByTestId("snat-Ip_ip").inputValue();
  const state0 = await page.getByTestId("securenat-state").innerText();
  check("SecureNAT: shows state and the server's settings (GetSecureNATOption)", ipShown === opt.Ip_ip && /Off/.test(state0), `ip ${ipShown}, state ${state0}`);
  await shot("securenat-off", { fullPage: false });
  // validation
  await page.getByTestId("snat-mtu").fill("20");
  await sleep(150);
  const saveBlocked = await page.getByTestId("snat-save").isDisabled();
  await page.getByTestId("snat-mtu").fill("1400");
  await page.getByTestId("snat-DhcpDnsServerAddress2_ip").fill("1.1.1.1");
  await page.getByTestId("snat-domain").fill("corp.example");
  await page.getByTestId("dhcp-route-add").click();
  await page.getByTestId("dhcp-route-net-0").fill("10.50.0.0");
  await page.getByTestId("dhcp-route-mask-0").fill("16");
  await page.getByTestId("dhcp-route-gw-0").fill("192.168.30.254");
  await page.getByTestId("dhcp-route-row").scrollIntoViewIfNeeded();
  await page.mouse.move(5, 890);
  await shot("securenat-settings-edit");
  await page.getByTestId("snat-save").click();
  const opt2 = await until(async () => { const o = await seRpc("GetSecureNATOption", { RpcHubName_str: HUB }); return o.Mtu_u32 === 1400 ? o : null; });
  check("SecureNAT: Save Settings writes the options (SetSecureNATOption)",
    saveBlocked && opt2 && opt2.DhcpDnsServerAddress2_ip === "1.1.1.1" && opt2.DhcpDomainName_str === "corp.example" && opt2.DhcpPushRoutes_str === "10.50.0.0/255.255.0.0/192.168.30.254" && opt2.Ip_ip === opt.Ip_ip,
    `MTU 20 blocked ${saveBlocked}; server ${JSON.stringify(opt2 && { mtu: opt2.Mtu_u32, dns2: opt2.DhcpDnsServerAddress2_ip, dom: opt2.DhcpDomainName_str, routes: opt2.DhcpPushRoutes_str })}`);

  // turn on
  await page.evaluate(() => document.querySelector("#main")?.scrollTo({ top: 0 }));
  await page.getByTestId("securenat-enable").click();
  await page.getByTestId("securenat-enable-dialog").waitFor();
  await page.getByTestId("securenat-enable-confirm").click();
  const on = await until(async () => (await seRpc("GetHubStatus", { HubName_str: HUB })).SecureNATEnabled_bool);
  await page.getByTestId("securenat-status").waitFor({ timeout: 15_000 });
  const stateOn = await page.getByTestId("securenat-state").innerText();
  check("SecureNAT: Turn On SecureNAT confirms and enables it (EnableSecureNAT)", !!on && /On/.test(stateOn), `server ${!!on}, badge ${stateOn}`);
  await sleep(400);
  await shot("securenat-on");
  // unsaved settings survive a look at the other views (the web tabs kept their panels mounted)
  await page.getByTestId("snat-mtu").fill("1300");
  await page.getByTestId("snat-tab-nat").click();
  await page.getByTestId("nat-table").waitFor();
  await page.getByTestId("snat-tab-settings").click();
  const keptMtu = await page.getByTestId("snat-mtu").inputValue();
  const stillDirty = await page.getByTestId("snat-save").isEnabled();
  await page.getByTestId("snat-save-reset").click();
  const reverted = await page.getByTestId("snat-mtu").inputValue();
  check("Parity: SecureNAT edits survive switching to NAT Sessions and back; Revert restores", keptMtu === "1300" && stillDirty && reverted === "1400", `after switch ${keptMtu}, dirty ${stillDirty}, after revert ${reverted}`);
  await page.getByTestId("snat-tab-nat").click();
  await page.getByTestId("nat-table").waitFor();
  await until(async () => /No NAT sessions|items?/.test(await page.getByTestId("nat-table").innerText()));
  await shot("securenat-nat");
  await page.getByTestId("snat-tab-dhcp").click();
  await page.getByTestId("dhcp-table").waitFor();
  await until(async () => /No DHCP leases|items?/.test(await page.getByTestId("dhcp-table").innerText()));
  const dhcpText = await page.getByTestId("dhcp-table").innerText();
  check("SecureNAT: NAT Sessions and DHCP Leases views load (EnumNAT / EnumDHCP)", /No DHCP leases|items?/.test(dhcpText), dhcpText.replace(/\s+/g, " ").slice(0, 120));
  await shot("securenat-dhcp");
  // turn off
  await page.getByTestId("securenat-disable").click();
  await page.getByTestId("securenat-disable-dialog").waitFor();
  await page.getByTestId("securenat-disable-confirm").click();
  const offNat = await until(async () => !(await seRpc("GetHubStatus", { HubName_str: HUB })).SecureNATEnabled_bool);
  await until(async () => /Off/.test(await page.getByTestId("securenat-state").innerText()));
  check("SecureNAT: Turn Off SecureNAT disables it (DisableSecureNAT) and returns to Settings", !!offNat && await page.getByTestId("securenat-form").isVisible());

  // ============================================================== empty states
  await mkHub("EMPTY");
  const goEmpty = async (sub) => { await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/hubs/EMPTY/${sub}`); await sleep(900); };
  await goEmpty("access");
  const emptyAccess = await until(async () => page.getByText("No access rules").isVisible());
  await shot("access-empty");
  await goEmpty("acl");
  const emptyAcl = await until(async () => page.getByText("No source IP rules").isVisible());
  await goEmpty("cascades");
  const emptyLinks = await until(async () => page.getByText("No cascade connections").isVisible());
  await shot("cascades-empty");
  check("Empty states on a new hub", emptyAccess && emptyAcl && emptyLinks, `access ${emptyAccess}, acl ${emptyAcl}, cascades ${emptyLinks}`);

  check("No console errors, page errors or CSP violations", problems.length === 0, problems.slice(0, 4).join(" | ") || "none");
} catch (e) {
  check("run completed", false, e?.stack ?? String(e));
} finally {
  await app?.close().catch(() => undefined);
  const stopped = stopServer();
  check("vpnserver process group killed", stopped);
  rmSync(DATA, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(path.join(HERE, "report.json"), JSON.stringify({ at: new Date().toISOString(), server: info.ServerVersionString_str, port: PORT, screenshots: path.relative(REPO, SHOTS), results, problems }, null, 2));
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
