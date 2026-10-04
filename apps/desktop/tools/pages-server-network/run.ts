// E2E check of the desktop pages of the "server-network" group (Virtual Hubs, Connections, Listeners & Ports,
// Local Bridges, Layer 3 Switches, DDNS & VPN Azure) against a REAL SoftEther VPN Server.
//
//   node apps/desktop/tools/pages-server-network/run.ts            (from the repo root)
//   SEM_NET_PORT=16011 SEM_NET_RUN_DIR=~/se-desk-parity-server-network node apps/desktop/tools/pages-server-network/run.ts
//
// 1. builds main + preload (production esbuild options, tools/smoke-core/build.mjs) and the real Vite renderer
//    into a temp dir (never apps/desktop/dist)
// 2. starts a throwaway vpnserver on 127.0.0.1:15911 (run dir ~/se-desk-pages-server-network) and creates fixtures
//    over JSON-RPC (hubs, a Layer 3 switch with an interface and a route, a local bridge, a vpncmd admin session).
//    The server runs OFFLINE: its DDNS client (and with it VPN Azure) and NAT traversal are disabled in its config,
//    bridges use a device name that doesn't exist, and VPN over ICMP/DNS is never applied, so nothing reaches
//    SoftEther's cloud or tries to open raw sockets / packet capture. Only the macOS binaries built from source are
//    used (no Windows .exe is ever copied). SEM_NET_CLOUD=1 runs the old DDNS / VPN Azure write checks instead.
// 3. launches the built app with Playwright _electron (fresh SEM_DATA_DIR, SEM_INSECURE_KEYSTORE=1), adds the
//    server through window.sem.api, and drives every page through the UI: one or more reads and writes per page,
//    each write verified with a direct JSON-RPC call to the server
// 4. saves light + dark screenshots to apps/desktop/design-screenshots/pages/server-network/ and writes
//    REPORT.md + results.json next to this script; always kills the server's process group
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ADMIN_PW, CLOUD, PORT, RUN_DIR, SE_BUILD, killServer, remoteSockets, seRpc, startServer } from "./se.ts";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const DESKTOP = path.resolve(HERE, "../..");
const SHOTS = path.join(DESKTOP, "design-screenshots/pages/server-network");
const TMP = mkdtempSync(path.join(os.tmpdir(), "sem-pages-net-"));
const BUILD = path.join(TMP, "build");
const DATA = path.join(TMP, "data");
const HUB_PW = "Hub-Adm1n-Pw!";
/** A 120-character hub name (SoftEther allows 255): the tables must truncate it instead of scrolling sideways. */
const LONG_HUB = `ZZ-${"Very-Long-Hub-Name-".repeat(6)}`.slice(0, 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Bridge fixtures use a device name that can't exist on the host, so the (unprivileged) server never tries to open a
 * real adapter for packet capture: the bridge just shows its Error state.
 */
const NIC = "semnic9";

type Check = { page: string; name: string; ok: boolean; detail: string; ms: number };
const checks: Check[] = [];
const problems: string[] = [];
const shots: string[] = [];
let section = "setup";

async function step(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    checks.push({ page: section, name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  ok   [${section}] ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    const detail = (e as Error).message.split("\n").slice(0, 4).join(" | ");
    checks.push({ page: section, name, ok: false, detail, ms: Date.now() - t0 });
    console.log(`  FAIL [${section}] ${name} — ${detail}`);
    await page?.screenshot({ path: path.join(TMP, `fail-${checks.length}.png`) }).catch(() => undefined);
  }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
/** Poll the server until `fn` returns a truthy value (writes are async in the UI). */
async function until<T>(what: string, fn: () => Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v as NonNullable<T>; last = v; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- app driver

let app: ElectronApplication;
let page: Page;
let serverId = 0;
let hubAdminId = 0;
let vpncmd: ChildProcess | null = null;

const tid = (id: string) => page.getByTestId(id);
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(([m, pp, b]) => (window as any).sem.api({ method: m, path: pp, body: b }), [method, p, body] as const);
}
async function go(sub: string, title: string, id = serverId) {
  await page.evaluate((h) => { location.hash = h; }, `#/servers/${id}${sub ? `/${sub}` : ""}`);
  await page.locator("h1.sem-page-title", { hasText: title }).first().waitFor({ timeout: 10_000 });
  await sleep(300);
}
async function confirm(testId: string, typed?: string) {
  const dlg = tid(`${testId}-dialog`);
  await dlg.waitFor({ timeout: 5000 });
  if (typed !== undefined) await dlg.getByTestId("confirm-type").fill(typed);
  await tid(`${testId}-confirm`).click();
  await dlg.waitFor({ state: "detached", timeout: 5000 });
}
async function menu(row: Locator, itemTestId: string) {
  await row.click({ button: "right" });
  await tid(itemTestId).click();
}
/** Mantine switches/checkboxes hide the real input under the track: toggle it the way a click on the track does. */
async function toggle(id: string) {
  await tid(id).evaluate((el) => (el as HTMLInputElement).click());
}
async function pickOption(name: string | RegExp) {
  await page.getByRole("option", { name }).first().click();
}
async function theme(t: "light" | "dark") {
  // The window chrome follows nativeTheme; the renderer's "auto" colour scheme follows prefers-color-scheme,
  // which Playwright emulates (a themeSource change doesn't reach an already-open page reliably).
  await app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, t);
  await page.emulateMedia({ colorScheme: t });
  await page.waitForFunction((v) => document.documentElement.getAttribute("data-mantine-color-scheme") === v, t, { timeout: 5000 });
  await sleep(350);
}
/** Light and dark screenshots of the current window state. */
async function shoot(name: string) {
  // Let success toasts expire so they don't cover the page (errors stay: they are part of the state shown).
  await page.waitForFunction(() => ![...document.querySelectorAll(".mantine-Notification-root")].some((n) => !/failed/i.test(n.textContent ?? "")), null, { timeout: 6000 }).catch(() => undefined);
  for (const t of ["light", "dark"] as const) {
    await theme(t);
    const file = path.join(SHOTS, `${name}-${t}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(DESKTOP, file));
  }
  await theme("light");
}
async function closeSheet() {
  await page.keyboard.press("Escape");
  await page.locator(".sem-sheet").waitFor({ state: "detached", timeout: 5000 }).catch(() => undefined);
}

// ---------------------------------------------------------------- run

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`pages-server-network: temp ${TMP}`);
  const started = Date.now();

  await step("build main + preload (esbuild) and the renderer (Vite) into a temp dir", async () => {
    execFileSync("node", [path.join(DESKTOP, "tools/smoke-core/build.mjs"), BUILD], { stdio: "pipe" });
    const vite = await import("vite");
    await vite.build({ configFile: path.join(DESKTOP, "vite.config.ts"), mode: "production", logLevel: "warn",
      build: { outDir: path.join(BUILD, "renderer"), emptyOutDir: true, sourcemap: false } });
    return BUILD;
  });

  await step(`start vpnserver on 127.0.0.1:${PORT} and create fixtures over JSON-RPC`, async () => {
    await startServer();
    await seRpc("CreateHub", { HubName_str: "NET", AdminPasswordPlainText_str: HUB_PW, Online_bool: true, HubType_u32: 0 });
    await seRpc("CreateHub", { HubName_str: "SALES", Online_bool: true, HubType_u32: 0 });
    await seRpc("CreateHub", { HubName_str: "LAB", Online_bool: true, HubType_u32: 0 });
    await seRpc("SetHubOnline", { HubName_str: "LAB", Online_bool: false });
    await seRpc("CreateHub", { HubName_str: LONG_HUB, Online_bool: true, HubType_u32: 0 });
    await seRpc("AddL3Switch", { Name_str: "edge" });
    await seRpc("AddL3If", { Name_str: "edge", HubName_str: "NET", IpAddress_ip: "192.168.30.1", SubnetMask_ip: "255.255.255.0" });
    await seRpc("AddL3Table", { Name_str: "edge", NetworkAddress_ip: "10.99.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "192.168.30.254", Metric_u32: 10 });
    await seRpc("AddLocalBridge", { HubNameLB_str: "LAB", DeviceName_str: NIC, TapMode_bool: false });
    const info = await seRpc("GetServerInfo");
    return `${info.ServerProductName_str} build ${info.ServerBuildInt_u32}; hubs NET SALES LAB(offline); switch edge; bridge LAB↔${NIC}; ${CLOUD ? "cloud services ON (SEM_NET_CLOUD=1)" : "DDNS client and NAT traversal disabled (offline)"}`;
  });

  await step("launch the built app (Playwright _electron, fresh SEM_DATA_DIR) and add the server through window.sem.api", async () => {
    app = await electron.launch({
      executablePath: require("electron") as string, args: [BUILD],
      env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1", SEM_POLL_INTERVAL_SEC: "5" } as Record<string, string>,
      timeout: 60_000,
    });
    page = await app.firstWindow();
    page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await page.waitForLoadState("load");
    await page.waitForFunction(() => typeof (window as any).sem?.api === "function");
    const probe = await api("POST", "/api/servers/probe", { host: "127.0.0.1", port: PORT });
    assert(probe.status === 200, `probe ${probe.status}`);
    const add = await api("POST", "/api/servers", {
      name: "Network Lab", host: "127.0.0.1", port: PORT, password: ADMIN_PW, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
    });
    assert(add.status === 201, `add server ${add.status} ${JSON.stringify(add.body)}`);
    serverId = add.body.id;
    const hubAdmin = await api("POST", "/api/servers", {
      name: "NET hub admin", host: "127.0.0.1", port: PORT, hub: "NET", password: HUB_PW, savePassword: true, transport: "native", tlsMode: "pin", fingerprint: probe.body.fingerprint,
    });
    assert(hubAdmin.status === 201, `add hub-admin connection ${hubAdmin.status} ${JSON.stringify(hubAdmin.body)}`);
    hubAdminId = hubAdmin.body.id;
    // The sidebar polls the connection list every 15 s: reload so it shows the new connections straight away.
    await page.reload();
    await page.waitForFunction(() => typeof (window as any).sem?.api === "function");
    // page.screenshot() can't see the native vibrancy behind the transparent sidebar (it renders as white), so
    // paint the sidebar with its non-vibrancy token (--sem-bg-sidebar, what browsers/Linux use) for screenshots.
    await page.addStyleTag({ content: ".sem-sidebar { background: var(--sem-bg-sidebar) !important; }" });
    await theme("light");
    return `server #${serverId} (native, pinned ${String(probe.body.fingerprint).slice(0, 11)}…), hub-admin connection #${hubAdminId}`;
  });

  // ------------------------------------------------------------ Virtual Hubs
  section = "Virtual Hubs";
  await step("read: table lists the server's hubs with status (LAB offline)", async () => {
    await go("hubs", "Virtual Hubs");
    for (const h of ["NET", "SALES", "LAB"]) await tid(`hub-row-${h}`).waitFor();
    const lab = await tid("hub-row-LAB").innerText();
    const sales = await tid("hub-row-SALES").innerText();
    assert(/Offline/.test(lab) && /Online/.test(sales), `LAB: ${lab} / SALES: ${sales}`);
    const meta = await page.locator(".sem-page-meta").innerText();
    // Parity review: a 255-character hub name is legal; the Name column truncates it (ellipsis + tooltip).
    await tid(`hub-row-${LONG_HUB}`).waitFor();
    const overflow = await tid("hubs-table").evaluate((el) => {
      const sc = (el.querySelector(".sem-table")?.parentElement ?? el) as HTMLElement;
      return { sw: sc.scrollWidth, cw: sc.clientWidth };
    });
    assert(overflow.sw <= overflow.cw + 1, `hubs table scrolls sideways with a ${LONG_HUB.length}-character name (${overflow.sw} > ${overflow.cw})`);
    return `rows NET, SALES, LAB + a ${LONG_HUB.length}-char name (truncated, no sideways scroll ${overflow.sw}/${overflow.cw}); meta “${meta}”`;
  });
  await shoot("hubs");

  await step("write: New Virtual Hub sheet validates, then CreateHub (password, max sessions, hidden)", async () => {
    await tid("hub-create").click();
    await tid("hub-name").fill("sales");
    await page.getByText("There’s already a hub named “sales”.").waitFor();
    assert(await tid("hub-create-submit").isDisabled(), "submit enabled for a duplicate name");
    // Parity review: SoftEther's CreateHub only accepts IsSafeStr names (letters, digits, space, ( ) - _ # % & .).
    const serverSays = await seRpc("CreateHub", { HubName_str: "bad@hub", Online_bool: true, HubType_u32: 0 }).then(() => "accepted", (e: Error) => e.message);
    assert(/error 38\b/.test(serverSays), `server on “bad@hub”: ${serverSays}`);
    await tid("hub-name").fill("bad@hub");
    await page.getByText("Use only letters, digits, spaces and ( ) - _ # % & . characters.").waitFor();
    assert(await tid("hub-create-submit").isDisabled(), "submit enabled for a name the server refuses");
    await tid("hub-name").fill("UIHUB");
    await tid("hub-password").fill("pw-1");
    await tid("hub-password-confirm").fill("pw-2");
    await page.getByText("The passwords don’t match.").waitFor();
    assert(await tid("hub-create-submit").isDisabled(), "submit enabled with mismatched passwords");
    await tid("hub-password-confirm").fill("pw-1");
    await tid("hub-max-sessions").fill("5");
    await toggle("hub-noenum");
    assert(await tid("hub-noenum").isChecked(), "Hide from hub list not on");
    await page.getByLabel("Open the hub after creating it").uncheck();
    await shoot("hubs-new-sheet");
    await tid("hub-create-submit").click();
    const hub = await until("UIHUB on the server", () => seRpc("GetHub", { HubName_str: "UIHUB" }).catch(() => null));
    // MaxSession needs a SetHub after CreateHub (SoftEther resets it): wait for the page's follow-up call.
    const hub2 = await until("MaxSession 5", async () => { const x = await seRpc("GetHub", { HubName_str: "UIHUB" }); return x.MaxSession_u32 === 5 ? x : null; });
    assert(hub2.Online_bool === true && hub2.NoEnum_bool === true, `GetHub ${JSON.stringify(hub2)}`);
    await tid("hub-row-UIHUB").waitFor();
    // The follow-up SetHub (for MaxSession) must not have cleared the hub admin password: log in as hub admin.
    const hubLogin = await (async () => { const { request, Agent } = await import("undici");
      const res = await request(`https://127.0.0.1:${PORT}/api/`, { method: "POST", dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
        headers: { authorization: `Basic ${Buffer.from("UIHUB:pw-1").toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "GetHubStatus", params: { HubName_str: "UIHUB" } }) });
      const j = (await res.body.json()) as any; return j.error ? `error ${j.error.code}` : "ok"; })();
    assert(hubLogin === "ok", `hub admin login to UIHUB after SetHub: ${hubLogin}`);
    return `server refuses “bad@hub” (error 38, invalid parameter) and the sheet blocks it; GetHub UIHUB → Online ${hub2.Online_bool}, NoEnum ${hub2.NoEnum_bool}, MaxSession ${hub2.MaxSession_u32} (created ${!!hub}); hub admin password still works`;
  });

  await step("write: Take Offline (toolbar, confirmed) and Bring Online (context menu)", async () => {
    await tid("hub-row-SALES").click();
    await tid("hub-toggle-online").click();
    await confirm("hub-offline");
    await until("SALES offline", async () => (await seRpc("GetHubStatus", { HubName_str: "SALES" })).Online_bool === false);
    await page.waitForFunction(() => /Offline/.test(document.querySelector('[data-testid="hub-row-SALES"]')?.textContent ?? ""));
    await menu(tid("hub-row-SALES"), "hub-menu-online");
    await until("SALES online", async () => (await seRpc("GetHubStatus", { HubName_str: "SALES" })).Online_bool === true);
    return "GetHubStatus SALES → offline, then online";
  });

  await step("write: Delete Hub… from the context menu needs the typed name", async () => {
    await menu(tid("hub-row-UIHUB"), "hub-menu-delete");
    const dlg = tid("confirm-dialog");
    await dlg.waitFor();
    assert(await tid("confirm-confirm").isDisabled(), "delete enabled before typing the name");
    await shoot("hubs-delete-confirm");
    await confirm("confirm", "UIHUB");
    await until("UIHUB deleted", async () => !(await seRpc("EnumHub")).HubList.some((h: any) => h.HubName_str === "UIHUB"));
    await tid("hub-row-UIHUB").waitFor({ state: "detached" });
    return "EnumHub no longer lists UIHUB";
  });

  await step("read: hub admin mode lists only its hub, without New/Delete", async () => {
    await go("hubs", "Virtual Hubs", hubAdminId);
    await tid("hub-row-NET").waitFor();
    const rows = await page.locator('[data-testid^="hub-row-"]').count();
    assert(rows === 1, `${rows} rows`);
    assert(await tid("hub-create").count() === 0 && await tid("hub-delete").count() === 0, "create/delete visible in hub admin mode");
    await shoot("hubs-hub-admin");
    return "1 row (NET), purple hub-admin callout, no New/Delete";
  });

  // ------------------------------------------------------------ Connections
  section = "Connections";
  let vpncmdCid = "";
  await step("fixture: a vpncmd admin session held open (a second Admin RPC connection)", async () => {
    const before = new Set(((await seRpc("EnumConnection")).ConnectionList ?? []).map((c: any) => c.Name_str));
    for (const f of ["vpncmd"]) copyFileSync(path.join(SE_BUILD, f), path.join(RUN_DIR, f));
    vpncmd = spawn("./vpncmd", [`127.0.0.1:${PORT}`, "/SERVER", `/PASSWORD:${ADMIN_PW}`], {
      cwd: RUN_DIR, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["pipe", "ignore", "ignore"],
    });
    // JSON-RPC calls are listed as Admin RPC connections too: identify vpncmd's by its local TCP port.
    const localPort = await until("vpncmd's TCP socket", async () => {
      const out = execFileSync("lsof", ["-a", "-p", String(vpncmd!.pid), "-i", "TCP", "-n", "-P"], { encoding: "utf8" }).toString();
      return Number(out.match(/127\.0\.0\.1:(\d+)->127\.0\.0\.1:\d+ \(ESTABLISHED\)/)?.[1] ?? 0);
    }, 15_000);
    const c = await until("the vpncmd connection", async () => ((await seRpc("EnumConnection")).ConnectionList ?? []).find((x: any) => !before.has(x.Name_str) && x.Port_u32 === localPort), 15_000);
    vpncmdCid = c.Name_str;
    return `${vpncmdCid} from 127.0.0.1:${c.Port_u32}`;
  });

  await step("read: table lists TCP connections; type filter; Get Info opens the Inspector (GetConnectionInfo)", async () => {
    await go("connections", "Connections");
    await tid(`connection-row-${vpncmdCid}`).waitFor();
    const n = await page.locator('[data-testid^="connection-row-"]').count();
    await tid("connections-type-filter").getByText(/^VPN \(/).click();
    await sleep(200);
    const vpnRows = await page.locator('[data-testid^="connection-row-"]').count();
    await tid("connections-type-filter").getByText(/^All \(/).click();
    await tid(`connection-row-${vpncmdCid}`).dblclick();
    await tid("connection-props").waitFor();
    const props = await tid("connection-props").innerText();
    assert(props.includes(vpncmdCid) && /Admin RPC/.test(props), props);
    assert(/\d{4}/.test(props) && /ago|now/i.test(props), `Connected shows no absolute date: ${props}`);
    await shoot("connections-inspector");
    await page.keyboard.press("Escape");
    await sleep(400);
    const escClosed = await page.locator(".sem-inspector[data-open]").count() === 0;
    const modalRoots = `${await page.locator(".mantine-Modal-root").count()} roots, ${await page.locator(".mantine-Modal-content").count()} open`;
    if (!escClosed) await tid("inspector-close").click();
    await page.locator(".sem-inspector[data-open]").waitFor({ state: "detached" }).catch(() => undefined);
    assert(escClosed, `Esc didn't close the Inspector (modals in DOM: ${modalRoots})`);
    return `${n} connections, ${vpnRows} in the VPN filter; Inspector shows ${vpncmdCid} (Admin RPC); Esc closes it (modals in DOM: ${modalRoots})`;
  });
  await shoot("connections");

  await step("write: Disconnect… from the context menu closes the vpncmd connection on the server", async () => {
    await menu(tid(`connection-row-${vpncmdCid}`), "connection-menu-disconnect");
    await confirm("connection-disconnect");
    await until(`${vpncmdCid} gone`, async () => !((await seRpc("EnumConnection")).ConnectionList ?? []).some((c: any) => c.Name_str === vpncmdCid));
    return `EnumConnection no longer lists ${vpncmdCid}`;
  });

  // ------------------------------------------------------------ Listeners
  section = "Listeners & Ports";
  await step("read: TCP listener table marks the port this connection uses", async () => {
    await go("listeners", "Listeners & Ports");
    const row = await tid(`listener-row-${PORT}`).innerText();
    assert(/This connection/.test(row) && /Listening/.test(row), row);
    return row.replace(/\s+/g, " ");
  });
  await step("write: Add Listener… (validation, CreateListener) then Stop (confirmed) and Delete", async () => {
    await tid("create-listener").click();
    await tid("listener-port").fill(String(PORT));
    await page.getByText(`There’s already a listener on port ${PORT}.`).waitFor();
    await tid("listener-port").fill(String(PORT + 1));
    await tid("listener-create-submit").click();
    await until("listener created", async () => (await seRpc("EnumListener")).ListenerList.some((l: any) => l.Ports_u32 === PORT + 1 && l.Enables_bool));
    await tid(`listener-row-${PORT + 1}`).waitFor();
    await menu(tid(`listener-row-${PORT + 1}`), "listener-menu-stop");
    await confirm("listener-stop");
    await until("listener stopped", async () => (await seRpc("EnumListener")).ListenerList.some((l: any) => l.Ports_u32 === PORT + 1 && !l.Enables_bool));
    await page.waitForFunction((p) => /Stopped/.test(document.querySelector(`[data-testid="listener-row-${p}"]`)?.textContent ?? ""), PORT + 1);
    await shoot("listeners");
    await menu(tid(`listener-row-${PORT + 1}`), "listener-menu-delete");
    await confirm("listener-delete");
    await until("listener deleted", async () => !(await seRpc("EnumListener")).ListenerList.some((l: any) => l.Ports_u32 === PORT + 1));
    return `EnumListener: ${PORT + 1} created → stopped → deleted`;
  });
  await step("write: UDP ports via the tags field, Apply (confirmed SetPortsUDP)", async () => {
    const input = tid("udp-ports-input");
    await input.fill("99999");
    await input.press("Enter");
    await page.getByText("Not a valid port: 99999").waitFor();
    assert(await tid("udp-save").isDisabled(), "apply enabled with an invalid port");
    await input.press("Backspace");
    await input.fill(String(PORT + 2));
    await input.press("Enter");
    await tid("udp-save").click();
    await confirm("udp-save");
    const r = await until("UDP port saved", async () => { const x = await seRpc("GetPortsUDP"); return (x.Ports_u32 ?? []).includes(PORT + 2) ? x : null; });
    return `GetPortsUDP → ${JSON.stringify(r.Ports_u32)}`;
  });
  await step("VPN over ICMP switch → Apply asks first (SetSpecialListener wording); cancelled, then Revert", async () => {
    // Deliberately not applied: VPN over ICMP / DNS are tunnelling listeners (raw ICMP socket, UDP 53), which is the
    // kind of traffic endpoint security flags, and an unprivileged server can't open them anyway (error 140).
    await toggle("special-icmp");
    assert(await tid("special-save").isEnabled(), "Apply disabled after a change");
    await tid("special-save").click();
    const dlg = tid("special-save-dialog");
    await dlg.waitFor({ timeout: 5000 });
    const text = (await dlg.innerText()).replace(/\s+/g, " ");
    assert(/VPN over ICMP will be on/.test(text) && /VPN over DNS off/.test(text), text);
    await tid("special-save-cancel").click();
    await dlg.waitFor({ state: "detached", timeout: 5000 });
    assert(await tid("special-save").isEnabled(), "the change was lost after Cancel");
    assert(!(await tid("special-save-error").count()), "an error was shown after Cancel");
    const r = await seRpc("GetSpecialListener");
    assert(!r.VpnOverIcmpListener_bool && !r.VpnOverDnsListener_bool, JSON.stringify(r));
    await tid("special-save-reset").click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="special-icmp"]') as HTMLInputElement | null)?.checked === false);
    assert(await tid("special-save").isDisabled(), "Apply still enabled after Revert");
    return `confirmation “${text.slice(0, 90)}…”; Cancel keeps the edit and calls nothing (GetSpecialListener ICMP ${r.VpnOverIcmpListener_bool}, DNS ${r.VpnOverDnsListener_bool}); Revert clears it`;
  });

  // ------------------------------------------------------------ Local Bridges
  section = "Local Bridges";
  await step("read: bridges table, host support and (empty) adapter list", async () => {
    await go("bridges", "Local Bridges");
    const row = await tid(`bridge-row-LAB-${NIC}`).innerText();
    const support = await tid("bridge-support").innerText();
    assert(row.includes(NIC) && /Network adapter/.test(row), row);
    assert(/Supported/.test(support), support);
    return `${row.replace(/\s+/g, " ")}; host: ${support.replace(/\s+/g, " ")}`;
  });
  await shoot("bridges");
  await step("write: New Local Bridge… (hub + typed device) then Delete… (confirmed)", async () => {
    await tid("create-bridge").click();
    await tid("bridge-hub").fill("NET");
    await tid("bridge-hub").press("Tab");
    await tid("bridge-device-name").fill(NIC);
    await shoot("bridges-new-sheet");
    await tid("bridge-create-submit").click();
    await until(`bridge NET↔${NIC}`, async () => (await seRpc("EnumLocalBridge")).LocalBridgeList.some((b: any) => b.HubNameLB_str === "NET" && b.DeviceName_str === NIC));
    await tid(`bridge-row-NET-${NIC}`).waitFor();
    await tid(`bridge-row-NET-${NIC}`).click();
    await tid("bridge-delete").click();
    await confirm("bridge-delete");
    await until("bridge removed", async () => !(await seRpc("EnumLocalBridge")).LocalBridgeList.some((b: any) => b.HubNameLB_str === "NET"));
    return `EnumLocalBridge: NET↔${NIC} added, then removed`;
  });

  // ------------------------------------------------------------ Layer 3 Switches
  section = "Layer 3 Switches";
  await step("read: switch list and the detail of “edge” (interface + route)", async () => {
    await go("l3", "Layer 3 Switches");
    await tid("l3-row-edge").waitFor();
    await tid("l3-detail").waitFor();
    const ifs = await tid("l3-interfaces-table").innerText();
    const routes = await tid("l3-routes-table").innerText();
    assert(/NET/.test(ifs) && /192\.168\.30\.1/.test(ifs), ifs);
    assert(/10\.99\.0\.0\/16/.test(routes) && /192\.168\.30\.254/.test(routes), routes);
    return "edge: NET 192.168.30.1/24; route 10.99.0.0/16 via 192.168.30.254";
  });
  await shoot("l3switches");
  await step("write: New Switch → Add Interface → Add Route (validated) → Start → Stop → Delete", async () => {
    await tid("create-l3switch").click();
    const swSays = await seRpc("AddL3Switch", { Name_str: "bad@sw" }).then(() => "accepted", (e: Error) => e.message);
    assert(/error 38\b/.test(swSays), `server on “bad@sw”: ${swSays}`);
    await tid("l3-name").fill("bad@sw");
    await page.getByText("Use only letters, digits, spaces and ( ) - _ # % & . characters.").waitFor();
    assert(await tid("l3-create-submit").isDisabled(), "Create Switch enabled for a name the server refuses");
    await tid("l3-name").fill("core");
    await tid("l3-create-submit").click();
    await until("switch core", async () => (await seRpc("EnumL3Switch")).L3SWList.some((x: any) => x.Name_str === "core"));
    await page.waitForFunction(() => /Interfaces of “core”/.test(document.querySelector('[data-testid="l3-detail"]')?.textContent ?? ""));
    await tid("l3-add-if").click();
    await tid("l3if-hub").fill("SALES");
    await tid("l3if-hub").press("Tab");
    await tid("l3if-ip").fill("192.168.40.0");
    await page.getByText("That’s the network address of the subnet.").waitFor();
    await tid("l3if-ip").fill("192.168.40.255");
    await page.getByText("That’s the broadcast address of the subnet.").waitFor();
    // Parity review: the server refuses a host part of all zeros for every mask, so a /32 interface can't exist.
    const ifSays = await seRpc("AddL3If", { Name_str: "core", HubName_str: "SALES", IpAddress_ip: "192.168.40.1", SubnetMask_ip: "255.255.255.255" }).then(() => "accepted", (e: Error) => e.message);
    assert(/error 38\b/.test(ifSays), `server on a /32 interface: ${ifSays}`);
    await tid("l3if-ip").fill("192.168.40.1");
    await tid("l3if-mask").click();
    await pickOption("255.255.255.255 (/32)");
    await page.getByText("A /32 mask leaves no host addresses. Choose a shorter mask.").waitFor();
    assert(await tid("l3if-submit").isDisabled(), "Add Interface enabled for a /32 interface");
    await tid("l3if-mask").click();
    await pickOption("255.255.255.0 (/24)");
    await tid("l3if-submit").click();
    await until("interface", async () => ((await seRpc("EnumL3If", { Name_str: "core" })).L3IFList ?? []).some((i: any) => i.HubName_str === "SALES" && i.IpAddress_ip === "192.168.40.1"));
    await tid("l3-add-route").click();
    await tid("l3route-net").fill("10.40.1.0");
    await tid("l3route-mask").click();
    await pickOption("255.255.0.0 (/16)");
    await page.getByText("Host bits are set. The network address is 10.40.0.0.").waitFor();
    await tid("l3route-net").fill("10.40.0.0");
    const gwSays = await seRpc("AddL3Table", { Name_str: "edge", NetworkAddress_ip: "10.98.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "0.0.0.0", Metric_u32: 1 }).then(() => "accepted", (e: Error) => e.message);
    assert(/error 38\b/.test(gwSays), `server on gateway 0.0.0.0: ${gwSays}`);
    await tid("l3route-gw").fill("0.0.0.0");
    await page.getByText("0.0.0.0 and 255.255.255.255 can’t be a gateway.").waitFor();
    assert(await tid("l3route-submit").isDisabled(), "Add Route enabled for gateway 0.0.0.0");
    await tid("l3route-gw").fill("172.16.0.1");
    await tid("l3route-unreachable").waitFor();
    await tid("l3route-gw").fill("192.168.40.254");
    await tid("l3route-metric").fill("5");
    await shoot("l3switches-add-route");
    await tid("l3route-submit").click();
    const route = await until("route", async () => ((await seRpc("EnumL3Table", { Name_str: "core" })).L3Table ?? []).find((r: any) => r.NetworkAddress_ip === "10.40.0.0"));
    assert(route.SubnetMask_ip === "255.255.0.0" && route.GatewayAddress_ip === "192.168.40.254" && route.Metric_u32 === 5, JSON.stringify(route));
    await tid("l3-start-core").click();
    await until("core started", async () => (await seRpc("EnumL3Switch")).L3SWList.find((x: any) => x.Name_str === "core")?.Online_bool === true);
    await tid("l3-locked").waitFor();
    assert(await tid("l3-add-if").isDisabled(), "Add Interface enabled while running");
    await shoot("l3switches-running");
    await tid("l3-stop-to-edit").click();
    await confirm("l3-stop");
    await until("core stopped", async () => (await seRpc("EnumL3Switch")).L3SWList.find((x: any) => x.Name_str === "core")?.Online_bool === false);
    await menu(tid("l3-row-core"), "l3-menu-delete");
    await confirm("l3-delete", "core");
    await until("core deleted", async () => !(await seRpc("EnumL3Switch")).L3SWList.some((x: any) => x.Name_str === "core"));
    // The detail must follow: after deleting the selected switch, the remaining one ("edge") is selected again.
    await page.waitForFunction(() => /Interfaces of “edge”/.test(document.querySelector('[data-testid="l3-detail"]')?.textContent ?? ""));
    return "server refuses “bad@sw”, a /32 interface and gateway 0.0.0.0 (error 38, invalid parameter), and the sheets block them; core, SALES 192.168.40.1/24, 10.40.0.0/16 via 192.168.40.254 metric 5; started, stopped, deleted; detail falls back to “edge”";
  });

  // ------------------------------------------------------------ DDNS & VPN Azure
  section = "DDNS & VPN Azure";
  if (!CLOUD) {
    await step("read: the server's DDNS client is turned off → one explanation, and no DDNS / VPN Azure calls fail", async () => {
      const caps = new Map<string, number>(((await seRpc("GetCaps")).CapsList ?? []).map((c: any) => [c.CapsName_str, c.CapsValue_u32]));
      assert(!caps.get("b_support_ddns") && !caps.get("b_support_azure"), `caps b_support_ddns ${caps.get("b_support_ddns")} b_support_azure ${caps.get("b_support_azure")}`);
      let refused = "";
      try { await seRpc("GetDDnsClientStatus"); } catch (e) { refused = (e as Error).message; }
      assert(/error 33/.test(refused), `GetDDnsClientStatus: ${refused || "answered"}`);
      const before = problems.length;
      await go("ddns", "DDNS & VPN Azure");
      const box = tid("ddns-disabled");
      await box.waitFor();
      const text = (await box.innerText()).replace(/\s+/g, " ");
      assert(/Dynamic DNS is turned off/.test(text) && /bool Disabled true/.test(text), text);
      await sleep(1500); // give any stray query time to fail
      assert(!(await tid("ddns-status").count()) && !(await tid("azure-status").count()) && !(await tid("ddns-proxy-type").count()), "DDNS / Azure / proxy sections rendered");
      assert(!(await page.locator(".sem-main .sem-error, .sem-main [role=alert]").count()), "an error state is shown");
      assert(!(await page.locator(".mantine-Notification-root", { hasText: /failed/i }).count()), "an error toast is shown");
      assert(problems.length === before, problems.slice(before).join(" | "));
      return `caps b_support_ddns 0, b_support_azure 0; GetDDnsClientStatus → ${refused.replace(/^SoftEther /, "")}; page: “${text.slice(0, 120)}…”`;
    });
    await shoot("ddns-disabled");
  } else {
    await step("read: Dynamic DNS status, VPN Azure state and the Internet connection setting", async () => {
      await go("ddns", "DDNS & VPN Azure");
      await tid("ddns-ipv4").waitFor();
      const st = await tid("ddns-status").innerText();
      const az = await tid("azure-status").innerText();
      const d = await seRpc("GetDDnsClientStatus");
      // The status can change between the page's poll and this call (registration completes), so accept either.
      const ui = (await tid("ddns-ipv4").innerText()).trim();
      assert(ui === (d.ErrStr_IPv4_utf || "Registered") || /Registered|Trying to connect/.test(ui), `UI “${ui}” vs server “${d.ErrStr_IPv4_utf}”`);
      assert(!d.CurrentHostName_str || st.includes(d.CurrentHostName_str), `hostname ${d.CurrentHostName_str} missing`);
      assert(!d.DnsSuffix_str || (st.includes("DNS suffix") && st.includes(d.DnsSuffix_str)), `DNS suffix ${d.DnsSuffix_str} missing`);
      return `IPv4 status “${ui}” (server: code ${d.Err_IPv4_u32} ${d.ErrStr_IPv4_utf || "registered"}); hostname ${d.CurrentHostName_str || "none yet"}; Azure ${/\bOn\b/.test(az) ? "on" : "off"}`;
    });
    await shoot("ddns");
    await step("hostname sheet validates the name (not submitted: it would register a public DNS name)", async () => {
      await tid("ddns-change-hostname").click();
      await tid("ddns-hostname").fill("-bad");
      await page.getByText("Use 3–31 letters, digits and hyphens, not starting or ending with a hyphen.").waitFor();
      assert(await tid("ddns-hostname-submit").isDisabled(), "submit enabled for an invalid name");
      await tid("ddns-hostname").fill("sem-e2e-test-host");
      assert(!(await tid("ddns-hostname-submit").isDisabled()), "submit disabled for a valid name");
      await closeSheet();
      return "invalid name blocked, valid name enabled; closed without saving";
    });
    await step("write: HTTP proxy for the cloud services (confirmed SetDDnsInternetSetting), then back to Direct", async () => {
      await tid("ddns-proxy-type").getByText("HTTP Proxy").click();
      await tid("ddns-proxy-host").fill("proxy.example.test");
      await tid("ddns-proxy-port").fill("3128");
      await tid("ddns-proxy-user").fill("svc-vpn");
      await shoot("ddns-proxy");
      await tid("ddns-proxy-save").click();
      await confirm("ddns-proxy-save");
      const r = await until("proxy saved", async () => { const x = await seRpc("GetDDnsInternetSetting"); return x.ProxyType_u32 === 1 ? x : null; });
      assert(r.ProxyHostName_str === "proxy.example.test" && r.ProxyPort_u32 === 3128 && r.ProxyUsername_str === "svc-vpn", JSON.stringify(r));
      await tid("ddns-proxy-type").getByText("Direct").click();
      await tid("ddns-proxy-save").click();
      await confirm("ddns-proxy-save");
      await until("direct", async () => (await seRpc("GetDDnsInternetSetting")).ProxyType_u32 === 0);
      return "GetDDnsInternetSetting → HTTP proxy.example.test:3128 user svc-vpn, then Direct";
    });
    await step("write: VPN Azure switch on and off (confirmed SetAzureStatus)", async () => {
      await toggle("azure-toggle");
      await confirm("azure-toggle");
      await until("Azure on", async () => (await seRpc("GetAzureStatus")).IsEnabled_bool === true);
      await page.waitForFunction(() => (document.querySelector('[data-testid="azure-toggle"]') as HTMLInputElement | null)?.checked === true);
      await toggle("azure-toggle");
      await confirm("azure-toggle");
      await until("Azure off", async () => (await seRpc("GetAzureStatus")).IsEnabled_bool === false);
      return "GetAzureStatus IsEnabled → true, then false";
    });
  }

  section = "all pages";
  if (!CLOUD) {
    await step("the throwaway server has no sockets to anything outside this machine (lsof on its process group)", async () => {
      const remote = remoteSockets();
      assert(remote.length === 0, remote.slice(0, 4).join(" | "));
      return "none (DDNS, VPN Azure and NAT traversal are off; bridges use a device that doesn't exist)";
    });
  }
  await step("no console errors, page errors or CSP violations", async () => {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(p));
    assert(real.length === 0, real.slice(0, 5).join(" | "));
    return "none";
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  writeReport(secs);
}

function writeReport(secs: string) {
  const passed = checks.filter((c) => c.ok).length;
  const rows = checks.map((c, i) => `| ${i + 1} | ${c.page} | ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`).join("\n");
  const md = `# Server network pages: E2E against a real SoftEther VPN Server

Generated by \`node apps/desktop/tools/pages-server-network/run.ts\` (from the repo root) on ${new Date().toISOString()}:
**${passed}/${checks.length} checks passed** in ${secs} s.

Pages: Virtual Hubs, Connections, Listeners & Ports, Local Bridges, Layer 3 Switches, DDNS & VPN Azure
(\`apps/desktop/src/renderer/pages/server/{Hubs,Connections,Listeners,Bridges,L3Switches,Ddns}.tsx\`).

How: main + preload are built with the production esbuild options and the renderer with Vite into a temp dir; the
app is launched with Playwright \`_electron\` (fresh \`SEM_DATA_DIR\`, \`SEM_INSECURE_KEYSTORE=1\`) against a throwaway
\`vpnserver\` built from source (\`${SE_BUILD}\`, port ${PORT}, run dir \`${RUN_DIR}\`). The server connection is added
through \`window.sem.api\` (native transport, pinned certificate) plus a hub-admin connection to \`NET\`. Every write is
made through the UI (sheets, toolbar buttons, context menus, confirmation dialogs) and then verified with a direct
JSON-RPC call to the server. The server's process group is killed at the end.

${CLOUD ? "Cloud mode (\`SEM_NET_CLOUD=1\`): the server kept SoftEther's defaults, so it registered a public Dynamic DNS name and VPN Azure was switched on and off." : "Offline mode (default): the server's config disables its DDNS client (so VPN Azure too) and NAT traversal, bridge fixtures use a device that doesn't exist, and VPN over ICMP/DNS is never applied. The last checks confirm the DDNS page's \"turned off\" state and that the server had no sockets to anything outside this machine. No Windows binaries are involved."}

| # | Page | Check | Result | Detail |
|---|---|---|---|---|
${rows}

## Screenshots (light and dark)

${shots.filter((s) => s.endsWith("-light.png")).map((s) => `- \`${s}\` / \`${s.replace("-light.png", "-dark.png")}\``).join("\n")}

${problems.length ? `## Console output\n\n${problems.map((p) => `- ${p}`).join("\n")}\n` : ""}`;
  writeFileSync(path.join(HERE, "REPORT.md"), md);
  writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ at: new Date().toISOString(), checks, problems, shots }, null, 2));
  console.log(`${passed}/${checks.length} checks passed → ${path.relative(process.cwd(), path.join(HERE, "REPORT.md"))}`);
}

let code = 1;
try {
  await main();
  code = checks.every((c) => c.ok) ? 0 : 1;
} catch (e) {
  console.error(e);
} finally {
  try { vpncmd?.kill("SIGKILL"); } catch { /* gone */ }
  await app?.close().catch(() => undefined);
  console.log(killServer() ? `killed vpnserver process group (${RUN_DIR})` : "vpnserver was not running");
  if (code === 0) rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP} for inspection (failure screenshots: fail-*.png)`);
}
process.exit(code);
