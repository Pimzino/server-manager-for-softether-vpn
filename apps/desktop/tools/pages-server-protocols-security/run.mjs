// E2E for the ported server pages OpenVPN & SSTP, IPsec, WireGuard, Certificate & TLS, Admin Password,
// License & VLAN and Capabilities. Builds the real app (main + preload like scripts/build.mjs, the real Vite
// renderer) into a scratch dir, starts a throwaway SoftEther VPN Server (port 15912, run dir
// ~/se-desk-pages-server-protocols-security), launches Electron with Playwright and a fresh SEM_DATA_DIR, adds the
// server through window.sem.api, creates fixtures, and drives every page through the UI, checking each write on
// the server with a direct JSON-RPC call. Writes report.json here and light/dark screenshots into
// apps/desktop/design-screenshots/pages/server-protocols-security/. Always kills the server's process group.
//   node apps/desktop/tools/pages-server-protocols-security/run.mjs [--no-build] [--keep]
// Env: SEM_PAGES_PORT, SEM_PAGES_RUN (server port / run dir, see se.mjs), SEM_PAGES_BUILD (scratch build dir).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORT, RUN, seRpc as rawRpc, startServer, stopServer } from "./se.mjs";

const HERE = import.meta.dirname;
const DESK = path.resolve(HERE, "../..");
const REPO = path.resolve(DESK, "../..");
const BUILD = process.env.SEM_PAGES_BUILD ?? path.join(os.tmpdir(), "sem-pages-server-protocols-security-build");
const SHOTS = path.join(DESK, "design-screenshots/pages/server-protocols-security");
const WORK = mkdtempSync(path.join(os.tmpdir(), "sem-sps-work-"));
const SAVED = path.join(WORK, "saved");
mkdirSync(SAVED, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

let ADMIN_PW = "adminpw";
const seRpc = (m, p = {}) => rawRpc(m, p, ADMIN_PW);
const results = [];
const check = (page, step, ok, detail = "") => {
  results.push({ page, step, ok: !!ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "  ok  " : "  FAIL"} [${page}] ${step}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, step = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(step);
  }
  return last instanceof Error ? false : last;
}
const b64 = (buf) => Buffer.from(buf).toString("base64");
const optVal = (r, name) => { const i = r.Name_str.indexOf(name); return i < 0 ? undefined : Buffer.from(r.Value_bin[i], "base64"); };
const optStr = (r, name) => optVal(r, name)?.toString("utf8").replace(/\0+$/, "");

// ---------------------------------------------------------------- build
if (!process.argv.includes("--no-build")) {
  const t0 = Date.now();
  execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), BUILD], { stdio: "inherit" });
  execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(BUILD, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
  console.log(`build: ${Date.now() - t0} ms into ${BUILD}`);
}

let app;
let stoppedEarly = false;
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-sps-data-"));
process.on("exit", () => stopServer());
try {
  // ---------------------------------------------------------------- server + fixtures
  const srv = await startServer();
  await rawRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  for (const hub of ["DEFAULT", "SALES"]) await seRpc("CreateHub", { HubName_str: hub, Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
  for (const [hub, user] of [["DEFAULT", "alice"], ["DEFAULT", "bob"], ["SALES", "carol"]]) {
    await seRpc("CreateUser", { HubName_str: hub, Name_str: user, Realname_utf: user, Note_utf: "", AuthType_u32: 1, Auth_Password_str: `${user}-pw` });
  }
  await seRpc("SetPortsUDP", { Ports_u32: [PORT] });
  const info = await seRpc("GetServerInfo");
  check("setup", "SoftEther VPN Server started with fixtures", true, `${info.ServerVersionString_str} ${info.ServerBuildInfoString_str ?? ""} pid ${srv.pid}, port ${PORT}, run dir ${RUN}; hubs DEFAULT/SALES, users alice/bob/carol, UDP ${PORT}`);

  // ---------------------------------------------------------------- app
  app = await electron.launch({
    executablePath: require("electron"), args: [BUILD],
    env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = "light"; BrowserWindow.getAllWindows()[0]?.setSize(1360, 900); });
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");
  // Native dialogs → files in WORK (Open: the path set with openNext; Save: SAVED/<suggested name>).
  await app.evaluate(({ dialog }, saved) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__semOpenNext] });
    dialog.showSaveDialog = async (a, b) => { const o = b ?? a; const name = String(o.defaultPath ?? "file").split(/[\\/]/).pop(); return { canceled: false, filePath: `${saved}/${name}` }; };
  }, SAVED);
  const openNext = (p) => app.evaluate((_e, f) => { globalThis.__semOpenNext = f; }, p);

  const created = await page.evaluate(async ({ port, pw }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    return window.sem.api({ method: "POST", path: "/api/servers", body: {
      name: "SPS Lab", host: "127.0.0.1", port, password: pw, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint } });
  }, { port: PORT, pw: ADMIN_PW });
  const sid = created.body.id;
  await page.reload();
  await page.waitForLoadState("load");
  check("setup", "connection added (native transport, pinned certificate, saved password)", created.status === 201 && created.body.state?.ok, `id ${sid}, ok ${created.body.state?.ok}`);
  // Fresh (ephemeral) connection with the password this app has stored: pooled sessions survive password changes.
  const storedPwWorks = () => page.evaluate(({ id, port }) => window.sem.api({ method: "POST", path: "/api/servers/test", body: { id, host: "127.0.0.1", port, transport: "native", tlsMode: "insecure" } }).then((r) => r.body.ok === true), { id: sid, port: PORT });
  const serverRec = () => page.evaluate((id) => window.sem.api({ method: "GET", path: `/api/servers/${id}` }).then((r) => r.body), sid);

  const tid = (id) => page.getByTestId(id);
  async function goto(sub, title) {
    await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/${sub}`);
    await page.locator("h1.sem-page-title", { hasText: title }).first().waitFor({ timeout: 20_000 });
    await sleep(600);
  }
  async function scrollContent(to) {
    await page.evaluate((t) => {
      let el = document.querySelector(".sem-page");
      while (el && !(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (el) el.scrollTop = t === "bottom" ? el.scrollHeight : t === "top" ? 0 : Number(t);
    }, to);
    await sleep(250);
  }
  async function shot(name, { scroll } = {}) {
    // Toasts from earlier steps would cover the page: hide them while capturing.
    // page.screenshot() can't see the macOS vibrancy behind the transparent sidebar (it comes out black or white),
    // so paint the sidebar with its non-vibrancy token while capturing.
    await page.evaluate(() => {
      document.querySelectorAll(".mantine-Notifications-root").forEach((n) => { n.style.visibility = "hidden"; });
      document.querySelectorAll(".sem-sidebar").forEach((n) => { n.style.background = "var(--sem-bg-sidebar)"; });
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    for (const scheme of ["light", "dark"]) {
      // Playwright pins prefers-color-scheme to light unless told otherwise; the window material follows nativeTheme.
      await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(900);
      if (scroll !== undefined) await scrollContent(scroll);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
    }
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => {
      document.querySelectorAll(".mantine-Notifications-root").forEach((n) => { n.style.visibility = ""; });
      document.querySelectorAll(".sem-sidebar").forEach((n) => { n.style.background = ""; });
    });
    await sleep(300);
  }
  async function selectOption(testId, text) {
    await tid(testId).click();
    await tid(testId).fill(text);
    await page.getByRole("option", { name: text, exact: true }).first().click();
  }
  const rowCount = (testId) => page.getByTestId(testId).locator("tbody tr").count();

  // ================================================================= OpenVPN & SSTP
  {
    const P = "Protocols";
    await goto("protocols", "OpenVPN & SSTP");
    const cfg = await seRpc("GetOpenVpnSstpConfig");
    const uiOvpn = await tid("enable-openvpn").isChecked();
    const uiSstp = await tid("enable-sstp").isChecked();
    check(P, "read: switches show GetOpenVpnSstpConfig", uiOvpn === cfg.EnableOpenVPN_bool && uiSstp === cfg.EnableSSTP_bool, `OpenVPN ${uiOvpn}, SSTP ${uiSstp}`);
    const ports = await tid("openvpn-udp-ports").innerText();
    check(P, "read: SoftEther 5 shows the server-wide UDP ports instead of a port list", ports.includes(String(PORT)), ports.replace(/\s+/g, " "));
    await shot("protocols");

    await tid("enable-sstp").click({ force: true });
    await tid("save-openvpn-sstp").click();
    const after = await until(async () => { const r = await seRpc("GetOpenVpnSstpConfig"); return r.EnableSSTP_bool === !cfg.EnableSSTP_bool ? r : null; });
    check(P, "write: turning SSTP off and Save → SetOpenVpnSstpConfig", !!after && after.EnableOpenVPN_bool === cfg.EnableOpenVPN_bool, JSON.stringify(after));

    await tid("download-openvpn-config").click();
    const zip = path.join(SAVED, "SPS_Lab-openvpn-config.zip");
    const zipOk = await until(() => existsSync(zip) && readFileSync(zip).subarray(0, 2).toString() === "PK");
    check(P, "Save OpenVPN Sample Config… writes the ZIP from MakeOpenVpnConfigFile", zipOk, `${zip} ${existsSync(zip) ? readFileSync(zip).length : 0} bytes`);

    await tid("proto-tab-SSTP").click();
    await tid("proto-SSTP-Enabled").waitFor({ timeout: 10_000 });
    const sstpOptChecked = await tid("proto-SSTP-Enabled").isChecked();
    check(P, "read: SSTP protocol options follow the saved clone-server switch", sstpOptChecked === !cfg.EnableSSTP_bool, `SSTP Enabled option ${sstpOptChecked}`);
    await tid("proto-tab-OpenVPN").click();
    const before = await seRpc("GetProtoOptions", { Protocol_str: "OpenVPN" });
    const ping = tid("proto-OpenVPN-PingSendInterval");
    await ping.waitFor({ timeout: 10_000 });
    await ping.fill("4321");
    await scrollContent("bottom");
    await tid("save-proto-OpenVPN").click();
    await tid("save-proto-OpenVPN-dialog").waitFor({ timeout: 5000 });
    await shot("protocols-options-confirm");
    const dlgText = await tid("save-proto-OpenVPN-dialog").innerText();
    await tid("save-proto-OpenVPN-confirm").click();
    const po = await until(async () => { const r = await seRpc("GetProtoOptions", { Protocol_str: "OpenVPN" }); return optVal(r, "PingSendInterval")?.readUInt32LE(0) === 4321 ? r : null; });
    const othersSame = !!po && po.Name_str.every((n, i) => n === "PingSendInterval" || po.Value_bin[i] === before.Value_bin[before.Name_str.indexOf(n)]);
    check(P, "write: protocol option saved through the change-list confirmation (SetProtoOptions)", !!po && othersSame && /Ping send interval/i.test(dlgText), dlgText.replace(/\s+/g, " ").slice(0, 160));
    await sleep(500);
    await shot("protocols-options", { scroll: "bottom" });
  }

  // ================================================================= IPsec
  {
    const P = "Ipsec";
    await goto("ipsec", "IPsec, L2TP & EtherIP");
    const svc = await seRpc("GetIPsecServices");
    const psk = await tid("ipsec-psk").inputValue();
    check(P, "read: pre-shared key and switches show GetIPsecServices", psk === svc.IPsec_Secret_str && (await tid("ipsec-l2tp").isChecked()) === svc.L2TP_IPsec_bool, `psk “${psk}”`);
    const empty = await tid("etherip-table").innerText();
    check(P, "read: empty device table explains what to do", /No devices/.test(empty), empty.replace(/\s+/g, " ").slice(0, 120));
    await tid("ipsec-l2tp").click({ force: true });
    const unsaved = await tid("ipsec-unsaved").isVisible();
    check(P, "a changed service switch shows the unsaved-changes cue next to Save", unsaved);
    await tid("ipsec-etherip").click({ force: true });
    await tid("ipsec-psk").fill("");
    const pskErr = await page.getByText("Enter a pre-shared key while an IPsec function is on.").isVisible();
    const saveDisabled = await tid("save-ipsec").isDisabled();
    check(P, "validation: empty PSK with IPsec on blocks Save", pskErr && saveDisabled, `error ${pskErr}, save disabled ${saveDisabled}`);
    await tid("ipsec-psk").fill("longsecret12");
    const warn = await page.getByText("12 characters. Some Android versions fail with 10 or more.").isVisible();
    await selectOption("ipsec-default-hub", "DEFAULT");
    const hint = await tid("ipsec-login-hint").innerText();
    await tid("save-ipsec").click();
    const s2 = await until(async () => { const r = await seRpc("GetIPsecServices"); return r.L2TP_IPsec_bool && r.EtherIP_IPsec_bool && r.IPsec_Secret_str === "longsecret12" && r.L2TP_DefaultHub_str === "DEFAULT" ? r : null; });
    check(P, "write: L2TP + EtherIP on, PSK and default hub saved (SetIPsecServices)", !!s2 && warn && /user@DEFAULT/.test(hint), `${JSON.stringify(s2)} · android warning ${warn} · hint “${hint}”`);

    // EtherIP devices
    for (const [id, hub, user] of [["router1.example.com", "DEFAULT", "alice"], ["*", "SALES", "carol"]]) {
      await tid("add-etherip").click();
      await tid("etherip-id").waitFor();
      await tid("etherip-id").fill(id);
      await selectOption("etherip-hub", hub);
      await tid("etherip-user").fill(user);
      await page.keyboard.press("Escape").catch(() => {});
      await tid("etherip-password").fill(`${user}-pw`);
      if (id === "*") await shot("ipsec-add-device");
      await tid("etherip-submit").click();
      await tid("etherip-sheet").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    }
    const devs = await until(async () => { const r = await seRpc("EnumEtherIpId"); return r.Settings?.length === 2 ? r.Settings : null; });
    check(P, "write: two devices added through the sheet (AddEtherIpId)", !!devs, JSON.stringify(devs?.map((d) => `${d.Id_str}→${d.UserName_str}@${d.HubName_str}`)));
    await tid("add-etherip").click();
    await tid("etherip-id").fill("ROUTER1.example.com");
    const dupErr = await page.getByText("A device with this ID already exists.").isVisible();
    await page.keyboard.press("Escape");
    check(P, "validation: duplicate Phase 1 ID (case-insensitive) is flagged", dupErr);
    await tid("etherip-sheet").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

    await tid("etherip-row-router1.example.com").dblclick();
    await tid("etherip-detail").waitFor({ timeout: 10_000 });
    await tid("etherip-detail-password-reveal").click();
    const detail = await tid("etherip-detail").innerText();
    check(P, "double-click opens the Inspector (GetEtherIpId) with the password revealable", /alice/.test(detail) && /alice-pw/.test(detail), detail.replace(/\s+/g, " "));
    await shot("ipsec", { scroll: "bottom" });
    await tid("inspector-close").click();

    await tid("etherip-row-router1.example.com").click({ button: "right" });
    await tid("edit-etherip-router1.example.com").click();
    await tid("etherip-user").fill("bob");
    await page.keyboard.press("Escape").catch(() => {});
    await tid("etherip-password").fill("bob-pw");
    await tid("etherip-submit").click();
    const edited = await until(async () => { const r = await seRpc("GetEtherIpId", { Id_str: "router1.example.com" }); return r.UserName_str === "bob" ? r : null; });
    check(P, "write: context menu Edit… changes the user", !!edited, JSON.stringify(edited));
    await tid("etherip-row-*").click({ button: "right" });
    await tid("delete-etherip-*").click();
    await tid("delete-etherip-dialog").waitFor({ timeout: 5000 });
    await tid("delete-etherip-confirm").click();
    const afterDel = await until(async () => { const r = await seRpc("EnumEtherIpId"); return r.Settings?.length === 1 ? r.Settings : null; });
    check(P, "write: context menu Delete… is confirmed, then DeleteEtherIpId", !!afterDel && afterDel[0].Id_str === "router1.example.com", JSON.stringify(afterDel?.map((d) => d.Id_str)));
    await scrollContent("top");
    await shot("ipsec-top", { scroll: "top" });
  }

  // ================================================================= WireGuard
  {
    const P = "WireGuard";
    await goto("wireguard", "WireGuard");
    const opts = await seRpc("GetProtoOptions", { Protocol_str: "WireGuard" });
    const priv = optStr(opts, "PrivateKey");
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(priv, "base64")]);
    const expectedPub = crypto.createPublicKey({ key: crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }), format: "pem" })
      .export({ format: "jwk" }).x.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const shownPub = await until(async () => (await tid("wg-public-key").innerText()).trim(), 10_000);
    check(P, "read: server public key computed in the renderer equals X25519(private key) from Node", shownPub === expectedPub, `${shownPub} vs ${expectedPub}`);
    const state = await tid("wg-enabled-state").innerText();
    check(P, "read: WireGuard state and UDP port from GetProtoOptions / GetPortsUDP", /On/.test(state) === (optVal(opts, "Enabled")[0] === 1) && (await tid("wg-udp-ports").innerText()).includes(String(PORT)), state);
    const tpl = await tid("wg-template").innerText();
    check(P, "client template is filled with the public key and endpoint", tpl.includes(expectedPub) && tpl.includes(`127.0.0.1:${PORT}`), tpl.split("\n").filter((l) => /PublicKey|Endpoint/.test(l)).join(" | "));

    const mk = () => crypto.generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const [k1, k2, k3] = [mk(), mk(), mk()];
    await tid("add-wgk").click();
    await tid("wgk-key").fill("not-a-key");
    const keyErr = await page.getByText("This isn’t a WireGuard public key (44 base64 characters).").isVisible();
    await tid("wgk-key").fill(k1);
    await selectOption("wgk-hub", "DEFAULT");
    await tid("wgk-user").fill("alice");
    await page.keyboard.press("Escape").catch(() => {});
    await tid("wgk-submit").click();
    const one = await until(async () => { const r = await seRpc("EnumWgk"); return r.Key_str?.includes(k1) ? r : null; });
    check(P, "write: one key registered through the sheet (AddWgk)", !!one && keyErr && one.User_str[one.Key_str.indexOf(k1)] === "alice", `invalid-key message ${keyErr}`);

    const csv = path.join(WORK, "wg-keys.csv");
    writeFileSync(csv, `# publicKey,hub,user\n${k3},SALES,carol\n`);
    await tid("add-wgk").click();
    await page.getByText("Import List", { exact: true }).click();
    await tid("wgk-bulk").fill(`${k2},DEFAULT,bob\n${k1},DEFAULT,alice\nbroken line`);
    await openNext(csv);
    await tid("wgk-bulk-file").click();
    await until(async () => (await tid("wgk-bulk").inputValue()).includes(k3), 5000);
    const errs = await tid("wgk-bulk-errors").innerText();
    await shot("wireguard-import");
    check(P, "bulk import: file import appended, duplicate and malformed lines rejected", /duplicate key/.test(errs) && /expected/.test(errs) && (await tid("wgk-bulk-submit").isDisabled()), errs.replace(/\s+/g, " ").slice(0, 160));
    await tid("wgk-bulk").fill(`${k2},DEFAULT,bob\n# comment\n${k3},SALES,carol`);
    await tid("wgk-bulk-submit").click();
    const three = await until(async () => { const r = await seRpc("EnumWgk"); return r.Key_str?.length === 3 ? r : null; });
    check(P, "write: bulk import of 2 keys (AddWgk with arrays)", !!three, JSON.stringify(three?.User_str));

    await tid("wgk-row-carol").dblclick();
    await tid("wgk-inspector-template").waitFor({ timeout: 5000 });
    const itpl = await tid("wgk-inspector-template").innerText();
    await shot("wireguard");
    check(P, "double-click opens the client Inspector with a per-client template", itpl.includes("# carol@SALES") && itpl.includes(expectedPub));
    await tid("wgk-save-conf").click();
    const conf = path.join(SAVED, "carol-SPS_Lab.conf");
    check(P, "Save Template… writes the .conf through the Save dialog", await until(() => existsSync(conf) && readFileSync(conf, "utf8").includes(expectedPub), 5000), conf);
    await tid("inspector-close").click();

    await tid("wgk-row-alice").click();
    await tid("wgk-row-bob").click({ modifiers: ["Meta"] });
    await tid("wgk-remove-selected").click();
    await tid("wgk-remove-dialog").waitFor({ timeout: 5000 });
    await tid("wgk-remove-confirm").click();
    const left = await until(async () => { const r = await seRpc("EnumWgk"); return r.Key_str?.length === 1 ? r : null; });
    check(P, "write: multi-select → Remove 2 Keys… (DeleteWgk with an array)", !!left && left.User_str[0] === "carol", JSON.stringify(left?.User_str));

    await tid("wg-toggle-enabled").click();
    await tid("wg-toggle-dialog").waitFor({ timeout: 5000 });
    await tid("wg-toggle-confirm").click();
    const off = await until(async () => { const r = await seRpc("GetProtoOptions", { Protocol_str: "WireGuard" }); return optVal(r, "Enabled")[0] === 0 ? r : null; });
    const keysKept = !!off && optStr(off, "PrivateKey") === priv;
    await until(async () => /Off/.test(await tid("wg-enabled-state").innerText()), 5000);
    await shot("wireguard-off");
    await tid("wg-toggle-enabled").click();
    await tid("wg-toggle-confirm").click();
    const on = await until(async () => { const r = await seRpc("GetProtoOptions", { Protocol_str: "WireGuard" }); return optVal(r, "Enabled")[0] === 1; });
    check(P, "write: Turn Off / Turn On WireGuard (SetProtoOptions keeps the keys)", !!off && keysKept && on, `off ${!!off}, keys kept ${keysKept}, back on ${on}`);
    await tid("wg-rotate-link").click();
    const onProtocols = await page.locator("h1.sem-page-title", { hasText: "OpenVPN & SSTP" }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check(P, "key-rotation link opens OpenVPN & SSTP (as the web page’s link did)", onProtocols);
  }

  // ================================================================= Certificate & TLS
  {
    const P = "Certificate";
    await goto("certificate", "Certificate & TLS");
    const cur = await seRpc("GetServerCert");
    const x = new crypto.X509Certificate(Buffer.from(cur.Cert_bin, "base64"));
    const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
    await tid("cert-cn").waitFor({ timeout: 15_000 });
    const uiCn = await tid("cert-cn").innerText();
    const match = await tid("cert-fp-match").innerText();
    check(P, "read: certificate details parsed from GetServerCert, fingerprint trusted", uiCn === cn && /Trusted by this app/.test(match), `CN ${uiCn} / ${cn}; ${match}`);
    await shot("certificate");
    await tid("cert-export").click();
    await tid("download-pem").click();
    const pemFile = path.join(SAVED, `SPS_Lab-${cn.replace(/[^\w.-]/g, "_")}.pem`);
    const pemOk = await until(() => existsSync(pemFile) && new crypto.X509Certificate(readFileSync(pemFile)).fingerprint256 === x.fingerprint256, 5000);
    check(P, "Export → Certificate (PEM)… saves the same certificate", pemOk, pemFile);
    await tid("cert-export").click();
    await tid("export-key").click();
    await tid("export-key-confirm").click();
    const keyFile = path.join(SAVED, `SPS_Lab-${cn.replace(/[^\w.-]/g, "_")}.key`);
    const keyOk = await until(() => existsSync(keyFile) && crypto.createPublicKey(crypto.createPrivateKey(readFileSync(keyFile))).export({ format: "der", type: "spki" }).equals(x.publicKey.export({ format: "der", type: "spki" })), 5000);
    check(P, "Export → Private Key… (confirmed) saves the key matching the certificate", keyOk, keyFile);

    // TLS cipher
    await scrollContent("bottom");
    await selectOption("cipher-select", "ECDHE-RSA-AES256-GCM-SHA384");
    await tid("save-cipher-apply").click();
    await tid("save-cipher-dialog").waitFor({ timeout: 5000 });
    await tid("save-cipher-confirm").click();
    const c1 = await until(async () => (await seRpc("GetServerCipher")).String_str === "ECDHE-RSA-AES256-GCM-SHA384");
    await shot("certificate-cipher", { scroll: "bottom" });
    await selectOption("cipher-select", "Automatic (negotiated by the TLS library)");
    await tid("save-cipher-apply").click();
    await tid("save-cipher-confirm").click();
    const c2 = await until(async () => (await seRpc("GetServerCipher")).String_str === "~DEFAULT~");
    check(P, "write: TLS cipher changed and restored through the confirmation (SetServerCipher)", c1 && c2, `set ${c1}, restored ${c2}`);
    await scrollContent("top");

    // New self-signed certificate, then trust it
    await tid("open-regen").click();
    await tid("regen-cn").fill("bad name!");
    const cnErr = await tid("regen-cert").isDisabled();
    await tid("regen-cn").fill("vpn.sps.test");
    await tid("regen-cert").click();
    await tid("regen-cert-dialog").waitFor({ timeout: 5000 });
    await tid("confirm-type").fill("SPS Lab");
    await tid("regen-cert-confirm").click();
    await tid("probe-result").waitFor({ timeout: 20_000 });
    const newCert = await seRpc("GetServerCert");
    const nx = new crypto.X509Certificate(Buffer.from(newCert.Cert_bin, "base64"));
    const probeText = await tid("probe-result").innerText();
    await shot("certificate-trust-new");
    await tid("repin-confirm").click();
    await tid("repin-confirm-confirm").click();
    const rec = await until(async () => { const s = await serverRec(); return s.fingerprint?.replace(/:/g, "").toUpperCase() === nx.fingerprint256.replace(/:/g, "") && s.state?.ok ? s : null; }, 20_000);
    check(P, "write: New Self-Signed… (typed confirmation) → RegenerateServerCert, then Trust This Certificate… re-pins", cnErr && /CN=vpn\.sps\.test/.test(nx.subject) && !!rec && /different certificate/.test(probeText),
      `CN ${nx.subject.replace(/\n/g, " ")}, pinned ${rec?.fingerprint?.slice(0, 20)}…, state ok ${rec?.state?.ok}`);
    await tid("cert-regen-done").click();

    // Install your own certificate from files
    const certPem = path.join(WORK, "import-cert.pem");
    const keyPem = path.join(WORK, "import-key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPem, "-out", certPem, "-days", "90", "-subj", "/CN=import.sps.test/O=SPS Lab"], { stdio: "ignore" });
    const ix = new crypto.X509Certificate(readFileSync(certPem));
    await tid("open-import").click();
    await openNext(certPem);
    await tid("cert-file").click();
    await openNext(keyPem);
    await tid("key-file").click();
    await tid("cert-preview").waitFor({ timeout: 10_000 });
    const prev = await tid("cert-preview").innerText();
    await shot("certificate-install");
    await tid("set-server-cert").click();
    await tid("set-server-cert-dialog").waitFor({ timeout: 5000 });
    await tid("confirm-type").fill("SPS Lab");
    await tid("set-server-cert-confirm").click();
    await tid("probe-result").waitFor({ timeout: 20_000 });
    const installed = await seRpc("GetServerCert");
    const iy = new crypto.X509Certificate(Buffer.from(installed.Cert_bin, "base64"));
    const probe2 = await tid("probe-result").innerText();
    await tid("repin-confirm").click();
    await tid("repin-confirm-confirm").click();
    const rec2 = await until(async () => { const s = await serverRec(); return s.fingerprint?.replace(/:/g, "").toUpperCase() === ix.fingerprint256.replace(/:/g, "") && s.state?.ok ? s : null; }, 20_000);
    check(P, "write: Install Certificate… from files (preview, typed confirmation) → SetServerCert, then re-pin",
      /import\.sps\.test/.test(prev) && /Serial number/.test(prev) && /Signature/.test(prev) && /Valid from/.test(prev) && iy.fingerprint256 === ix.fingerprint256 && /you just installed/.test(probe2) && !!rec2, `server CN ${iy.subject.replace(/\n/g, " ")}; state ok ${rec2?.state?.ok}`);
    await tid("cert-import-done").click();
    await until(async () => (await tid("cert-cn").innerText()) === "import.sps.test", 10_000);
    await shot("certificate-installed");

    // Replaced outside this app (vpncmd, Server Manager): the pinned connection now fails with a TLS mismatch. The
    // Certificate page must still offer "Trust in this app" (it needs no RPC), so the user can re-pin from here.
    await seRpc("RegenerateServerCert", { StrValue_str: "outside.sps.test" });
    const ox = new crypto.X509Certificate(Buffer.from((await seRpc("GetServerCert")).Cert_bin, "base64"));
    // Pooled admin sessions outlive the change; any new session (app restart, editing the connection) sees the new
    // certificate. Editing the connection's notes closes the pooled sessions, like a restart would.
    const mism = await page.evaluate((id) => window.sem.api({ method: "PUT", path: `/api/servers/${id}`, body: { notes: "certificate replaced elsewhere" } }).then((r) => r.body.state), sid);
    await page.reload();
    await page.waitForLoadState("load");
    await goto("certificate", "Certificate & TLS");
    const unreach = await until(() => tid("page-unreachable").isVisible(), 10_000);
    const trustShown = await tid("cert-trust").isVisible();
    const errsM = await page.locator("[data-testid=error-state]").count();
    await tid("probe-cert").click();
    await tid("probe-result").waitFor({ timeout: 20_000 });
    await shot("certificate-mismatch");
    await tid("repin-confirm").click();
    await tid("repin-confirm-confirm").click();
    const rec3 = await until(async () => { const s = await serverRec(); return s.fingerprint?.replace(/:/g, "").toUpperCase() === ox.fingerprint256.replace(/:/g, "") && s.state?.ok ? s : null; }, 20_000);
    const back = await until(async () => (await tid("cert-cn").innerText().catch(() => "")) === "outside.sps.test", 15_000);
    check(P, "certificate replaced elsewhere: page shows “Can’t reach” plus Trust in this app, re-pin restores the connection",
      mism?.ok === false && unreach && trustShown && errsM === 0 && !!rec3 && back,
      `state ${mism?.ok} (${String(mism?.error ?? "").slice(0, 60)}), unreachable ${unreach}, trust section ${trustShown}, errors ${errsM}, re-pinned ${!!rec3}, page back ${back}`);
  }

  // ================================================================= Admin Password
  {
    const P = "Security";
    await goto("security", "Admin Password");
    await tid("new-password").fill("short");
    const tooShort = await page.getByText("Use at least 8 characters.").isVisible();
    await tid("generate-password").click();
    const gen = await tid("new-password").inputValue();
    const same = gen === await tid("confirm-password").inputValue();
    check(P, "validation + Generate fills both fields with a strong password", tooShort && gen.length === 20 && same && /Strong|Good/.test(await tid("password-strength").innerText()), `generated ${gen.length} chars`);
    const NEW = "Sps-New#2026pass";
    await tid("new-password").fill(NEW);
    await tid("confirm-password").fill(NEW);
    await tid("ack-password").check({ force: true });
    await shot("security");
    await tid("change-password").click();
    await tid("change-password-dialog").waitFor({ timeout: 5000 });
    await shot("security-confirm");
    await tid("confirm-type").fill("SPS Lab");
    await tid("change-password-confirm").click();
    const done = await until(async () => (await tid("step-verify").getAttribute("data-step")) === "ok", 30_000);
    await shot("security-done");
    let oldRefused = false;
    try { await rawRpc("GetServerInfo", {}, "adminpw"); } catch (e) { oldRefused = e.code === 9 || /HTTP 401|\b9\b/.test(e.message); }
    ADMIN_PW = NEW;
    const newWorks = !!(await seRpc("GetServerInfo")).ServerProductName_str;
    const stored = await storedPwWorks();
    check(P, "write: Change Password… (typed confirmation) → SetServerPassword, app password updated and verified", done && oldRefused && newWorks && stored, `verify ${done}, old refused ${oldRefused}, new works ${newWorks}, app’s stored password works on a fresh connection ${stored}`);
    await tid("password-done").click();

    // Changed elsewhere (vpncmd): this app loses access until its password is updated here
    const THIRD = "Sps-Third#2026";
    await seRpc("SetServerPassword", { PlainTextPassword_str: THIRD });
    ADMIN_PW = THIRD;
    const broken = await storedPwWorks();
    await tid("stored-password").fill(THIRD);
    await tid("save-stored-password").click();
    const fixed = await until(async () => (await storedPwWorks()) && (await serverRec()).state?.ok === true, 15_000);
    check(P, "write: Password used by this app → PUT /api/servers/:id, connection restored", broken === false && fixed, `before ${broken}, after ${fixed}`);
  }

  // ================================================================= Hub admin mode (server-wide pages refuse the hub password)
  {
    const P = "HubMode";
    await seRpc("CreateHub", { HubName_str: "HUBADM", Online_bool: true, AdminPasswordPlainText_str: "hubpw", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false });
    const hubConn = await page.evaluate(async ({ port }) => {
      const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
      return window.sem.api({ method: "POST", path: "/api/servers", body: {
        name: "SPS Hub Admin", host: "127.0.0.1", port, hub: "HUBADM", password: "hubpw", savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint } });
    }, { port: PORT });
    const hid = hubConn.body.id;
    await page.reload(); // the sidebar list is cached: show the new connection like a user would see it
    await page.waitForLoadState("load");
    check(P, "hub-admin connection added", hubConn.status === 201 && hubConn.body.state?.ok, `id ${hid}, ok ${hubConn.body.state?.ok}`);
    // Hub-admin connections only offer the hubAdminOk pages (design/scope.ts), so these routes aren't reachable from the
    // navigation; opened directly (bookmark, history) they must show the hub-admin notice or nothing, never failing RPCs.
    const results2 = [];
    for (const [sub, title] of [["protocols", "OpenVPN & SSTP"], ["ipsec", "IPsec, L2TP & EtherIP"], ["wireguard", "WireGuard"], ["certificate", "Certificate & TLS"], ["security", "Admin Password"], ["license", "License & VLAN"]]) {
      await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/${sub}`);
      await sleep(1500);
      const notice = await tid("hub-mode-notice").isVisible();
      const titled = await page.locator("h1.sem-page-title", { hasText: title }).count();
      const errs = await page.locator("[data-testid=error-state]").count();
      results2.push(`${sub}: ${titled ? (notice ? "notice" : "PAGE WITHOUT NOTICE") : "not offered"}, errors ${errs}`);
    }
    await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/certificate`);
    await sleep(1500);
    const hubTrust = (await page.locator("h1.sem-page-title", { hasText: "Certificate & TLS" }).count()) ? await tid("cert-trust").isVisible() : "not offered";
    await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/security`);
    await sleep(1500);
    const hubPw = (await page.locator("h1.sem-page-title", { hasText: "Admin Password" }).count()) ? await page.getByText("Current hub password").isVisible() : "not offered";
    check(P, "hub admin mode: Certificate keeps Trust in this app, Admin Password offers updating the hub password this app uses", hubTrust !== false && hubPw !== false, `trust ${hubTrust}, hub password row ${hubPw}`);
    const navOffers = await page.locator("nav.sem-scope").allInnerTexts().then((t) => t.join(" "));
    results2.push(`scope nav: ${navOffers.replace(/\s+/g, " ").slice(0, 80)}`);
    check(P, "server-wide pages aren’t offered in hub admin mode; opened directly they show the notice, never failing RPCs",
      results2.slice(0, -1).every((r) => /(notice|not offered), errors 0/.test(r)) && !/IPsec, L2TP|Admin Password|License & VLAN/.test(navOffers), results2.join("; "));
    await page.evaluate((h) => { location.hash = h; }, `#/servers/${hid}/caps`);
    await page.locator("h1.sem-page-title", { hasText: "Capabilities" }).first().waitFor({ timeout: 20_000 });
    const capsRows = await until(async () => (await rowCount("caps-table")) > 10, 10_000);
    check(P, "Capabilities (hubAdminOk) still works with the hub password", !!capsRows);
    await shot("hubmode-caps");
    await page.evaluate((id) => window.sem.api({ method: "DELETE", path: `/api/servers/${id}` }), hid);
  }

  // ================================================================= License & VLAN
  {
    const P = "License";
    await goto("license", "License & VLAN");
    let code = null;
    try { await seRpc("GetLicenseStatus"); } catch (e) { code = e.code; }
    await tid("license-not-applicable").waitFor({ timeout: 10_000 });
    const la = await tid("license-not-applicable").innerText();
    const vl = await tid("vlan-not-applicable").innerText();
    check(P, "read: open-source edition explained once for licensing and VLAN (error 33), no red errors", code === 33 && /error 33/.test(la) && /Windows/.test(vl) && (await page.locator("[data-testid=error-state]").count()) === 0,
      `${la.replace(/\s+/g, " ").slice(0, 100)} | ${vl.replace(/\s+/g, " ").slice(0, 80)}`);
    const addBtn = await tid("open-add-license").count();
    check(P, "no license write offered where the server can’t store keys", addBtn === 0, "AddLicenseKey/DelLicenseKey/SetEnableEthVLan return 33 on this build");
    await shot("license");
  }

  // ================================================================= Capabilities
  {
    const P = "Caps";
    await goto("caps", "Capabilities");
    const caps = (await seRpc("GetCaps")).CapsList;
    const unique = new Set(caps.map((c) => c.CapsName_str)).size;
    await tid("caps-table").locator("tbody tr").first().waitFor({ timeout: 10_000 });
    const footer = await tid("caps-table").locator(".sem-table-footer").innerText();
    const hubsRow = await tid("caps-row-i_max_hubs").innerText();
    check(P, "read: every capability listed (duplicates merged), values formatted", footer.startsWith(`${unique} item`) && /100,000/.test(hubsRow), `${footer}; ${hubsRow.replace(/\s+/g, " ")}`);
    await page.getByText(/^Not Supported \(\d+\)$/).click();
    const noCount = caps.filter((c, i, a) => c.CapsName_str.startsWith("b_") && !c.CapsValue_u32 && a.findIndex((y) => y.CapsName_str === c.CapsName_str) === i).length;
    const shownNo = await rowCount("caps-table");
    check(P, "filter: Not Supported shows only false flags", shownNo === noCount, `${shownNo} rows, expected ${noCount}`);
    await page.getByText(/^All \(\d+\)$/).click();
    await scrollContent("top");
    await shot("caps");
    await tid("caps-row-i_max_hubs").dblclick();
    await tid("caps-inspector").getByText("i_max_hubs").first().waitFor({ timeout: 5000 });
    await shot("caps-inspector");
    await tid("inspector-close").click();
    await tid("caps-export").click();
    const csvFile = path.join(SAVED, "caps-SPS_Lab.csv");
    const lines = await until(() => existsSync(csvFile) && readFileSync(csvFile, "utf8").trim().split(/\r?\n/).length, 5000);
    check(P, "Export CSV… saves one line per capability", lines === unique + 1, `${csvFile}: ${lines} lines`);
  }

  check("all", "no console errors, CSP violations or page errors", problems.length === 0, problems.slice(0, 5).join(" | ") || "none");

  // ================================================================= Server down: one explanation per page, no RPC per section
  {
    const P = "Unreachable";
    stoppedEarly = stopServer();
    await sleep(800);
    const down = await page.evaluate((id) => window.sem.api({ method: "POST", path: `/api/servers/${id}/refresh` }).then((r) => r.body.state?.ok), sid);
    await page.reload();
    await page.waitForLoadState("load");
    const res = [`refresh ok=${down}`];
    for (const [sub, title] of [["protocols", "OpenVPN & SSTP"], ["ipsec", "IPsec, L2TP & EtherIP"], ["wireguard", "WireGuard"], ["certificate", "Certificate & TLS"], ["security", "Admin Password"], ["license", "License & VLAN"], ["caps", "Capabilities"]]) {
      await page.evaluate((h) => { location.hash = h; }, `#/servers/${sid}/${sub}`);
      await page.locator("h1.sem-page-title", { hasText: title }).first().waitFor({ timeout: 20_000 });
      const shown = await until(() => tid("page-unreachable").isVisible(), 10_000);
      await sleep(500);
      const errs = await page.locator("[data-testid=error-state]").count();
      res.push(`${sub}: unreachable ${!!shown}, errors ${errs}${sub === "certificate" ? `, trust ${await tid("cert-trust").isVisible()}` : ""}`);
    }
    check(P, "with the server down every page shows “Can’t reach …” with Try Again and no per-section errors", down === false && res.slice(1).every((r) => /unreachable true, errors 0/.test(r)) && res.some((r) => /^certificate: .*trust true/.test(r)), res.join("; "));
    await shot("unreachable-caps");
  }
} catch (e) {
  check("run", "unexpected failure", false, e.stack ?? String(e));
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  const stopped = stopServer() || stoppedEarly;
  await sleep(500);
  let alive = false;
  try { alive = execFileSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"]).toString().trim() !== ""; } catch { alive = false; }
  check("teardown", "vpnserver process group killed", stopped && !alive, `stopped ${stopped}, still running ${alive}`);
  rmSync(DATA, { recursive: true, force: true });
  // Saved files include an exported private key and OpenVPN configs: don't leave them in $TMPDIR (use --keep to inspect).
  if (!process.argv.includes("--keep")) rmSync(WORK, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(path.join(HERE, "report.json"), JSON.stringify({ at: new Date().toISOString(), port: PORT, passed: results.length - failed, failed, results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${SHOTS}. Saved files: ${SAVED}`);
  process.exit(failed ? 1 : 0);
}
