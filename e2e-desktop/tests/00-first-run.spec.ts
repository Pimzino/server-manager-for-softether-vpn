// First run on an empty data directory, adding connections like SoftEther's Server Manager, the native transport
// against a server whose JSON-RPC API is disabled, JSON-RPC against the other, the sidebar/fleet/quick switcher,
// switching the transport, a hub-admin connection with an unsaved password, and native menu actions.
import { test, expect, type Page } from "@playwright/test";
import {
  closeApp, clickMenu, csv, sheet, launchApp, normFp, patchState, route, seRpc, segment, serverId, setToggle, shot, tlsFingerprint, vpncmd,
  type App,
} from "../helpers.ts";
import { SERVER_A, SERVER_B, TENANT } from "../env.ts";

// Not serial: tests share state through the data directory and state.json, and a failure must not skip the rest
// (a failed test restarts the worker; beforeAll relaunches the app on the same data directory).
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;

test.beforeAll(async () => { a = await launchApp(); page = a.page; });
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });
test.afterEach(async ({}, ti) => { if (ti.status !== ti.expectedStatus) await shot(page, `FAILED-${ti.title}`, ti).catch(() => undefined); });

interface ConnForm { name: string; port: number; password: string; save?: boolean; transport?: "Native" | "JSON-RPC"; hub?: string }

/** Fill the New Connection sheet (vpnsmgr-style) and press Connect. */
async function fillConnection(f: ConnForm) {
  const connSheet = sheet(page, "connection-sheet");
  await expect(connSheet).toBeVisible();
  await page.getByTestId("conn-name").fill(f.name);
  await page.getByTestId("conn-host").fill("127.0.0.1");
  await page.getByTestId("conn-port").fill(String(f.port));
  if (f.hub) {
    await setToggle(page.getByTestId("conn-hubmode"), true);
    await page.getByTestId("conn-hub").fill(f.hub);
  }
  await page.getByTestId("conn-password").fill(f.password);
  await setToggle(page.getByTestId("conn-save-password"), f.save ?? true);
  if (f.transport) {
    const adv = page.getByTestId("conn-advanced");
    if ((await adv.getAttribute("aria-expanded")) !== "true") await adv.click();
    await segment(page.getByTestId("conn-transport"), f.transport);
  }
  await page.getByTestId("conn-continue").click();
}

/** Certificate trust step: checks the shown fingerprint against an independent TLS handshake, then trusts it. */
async function trustCertificate(port: number) {
  const trust = page.getByTestId("connection-trust");
  await expect(trust).toBeVisible();
  const shown = await trust.locator(".sem-fp-grid").getAttribute("aria-label");
  expect(normFp((shown ?? "").replace(/^Fingerprint\s*/, ""))).toBe(await tlsFingerprint(port));
  await shot(page, `trust-${port}`, test.info());
  await page.getByTestId("connection-trust-confirm").click();
}

async function expectOnline(id: number) {
  await expect(page.getByTestId(`sidebar-server-${id}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
}

async function landedOnServer(): Promise<number> {
  await expect(sheet(page, "connection-sheet")).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => route(page)).toMatch(/^\/servers\/\d+$/);
  return Number((await route(page)).split("/")[2]);
}

test("first run: welcome screen, Add Connection sheet, certificate trust, connected over the native protocol (server A, JSON-RPC off)", async ({}, ti) => {
  await expect(page.getByTestId("welcome")).toBeVisible();
  await shot(page, "welcome", ti);
  await page.getByTestId("welcome-add").click();
  await expect(sheet(page, "connection-sheet")).toContainText("New Connection");
  await fillConnection({ name: SERVER_A.name, port: SERVER_A.port, password: SERVER_A.password });
  await trustCertificate(SERVER_A.port);
  patchState({ server: ["A", await landedOnServer()] });
  await expectOnline(serverId("A"));
  await expect(page.getByTestId("overview-status")).toHaveText(/Online/);
  await expect(page.getByTestId("overview-poll")).toContainText("Native admin protocol");
  // Data really comes from server A: the server info matches vpncmd's view of it.
  const info = await vpncmd(SERVER_A.port, "", "", ["ServerInfoGet"]);
  const product = csv(info.out).find((r) => r[0] === "Product Name")?.[1];
  expect(product).toBeTruthy();
  await expect(page.getByTestId("overview-info")).toContainText(product!);
  await shot(page, "server-a-connected-native", ti);
});

test("the JSON-RPC transport cannot reach server A (API disabled), which proves the native transport is required", async ({}, ti) => {
  // Independent proof: A refuses JSON-RPC
  await expect(seRpc(SERVER_A.port, "", "Test", { IntValue_u32: 1 })).rejects.toThrow();
  await page.getByTestId("sidebar-add").click();
  await fillConnection({ name: "Alpha via JSON-RPC", port: SERVER_A.port, password: "", transport: "JSON-RPC" });
  await trustCertificate(SERVER_A.port);
  const err = page.getByTestId("connection-error");
  await expect(err).toBeVisible({ timeout: 30_000 });
  const text = (await err.innerText()).replace(/\s+/g, " ");
  ti.annotations.push({ type: "jsonrpc-to-A error", description: text });
  await shot(page, "jsonrpc-to-a-refused", ti);
  // The message must point at the real cause (the JSON-RPC API is off), not at the password: A has no password
  // at all, and the same empty password works over the native transport.
  expect.soft(text, "error shown for JSON-RPC to a server whose API is disabled").not.toMatch(/password was rejected|wrong administrator password/i);
  expect.soft(text, "error shown for JSON-RPC to a server whose API is disabled").toMatch(/JSON-RPC|native/i);
  await sheet(page, "connection-sheet").getByRole("button", { name: "Cancel" }).click();
  await expect(sheet(page, "connection-sheet")).toBeHidden();
  // Nothing was saved
  await expect(page.locator("[data-testid^=sidebar-server-]")).toHaveCount(1);
});

test("File > New Server Connection (native menu), wrong password gives a clear error, then JSON-RPC connection to server B", async ({}, ti) => {
  await clickMenu(a.app, ["File", "New Server Connection…"]);
  await expect(sheet(page, "connection-sheet")).toBeVisible();
  await fillConnection({ name: SERVER_B.name, port: SERVER_B.port, password: "definitely-wrong", transport: "JSON-RPC" });
  await trustCertificate(SERVER_B.port);
  const err = page.getByTestId("connection-error");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toContainText(/password was rejected|Authentication failed/i);
  await expect(page.getByTestId("conn-save-anyway")).toBeVisible();
  await shot(page, "wrong-password", ti);
  // Correct the password and connect
  await page.getByTestId("conn-password").fill(SERVER_B.password);
  await page.getByTestId("conn-continue").click();
  // The form asks to confirm the certificate again (a new connection is always probed first)
  await expect(page.getByTestId("connection-trust").or(page.getByTestId("connection-error"))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("connection-error")).toBeHidden();
  await page.getByTestId("connection-trust-confirm").click();
  patchState({ server: ["B", await landedOnServer()] });
  await expectOnline(serverId("B"));
  await expect(page.getByTestId("overview-poll")).toContainText("JSON-RPC API");
  const info = await seRpc(SERVER_B.port, SERVER_B.password, "GetServerInfo");
  await expect(page.getByTestId("overview-info")).toContainText(info.ServerHostName_str);
  await shot(page, "server-b-connected-jsonrpc", ti);
});

test("sidebar lists both servers with live status; fleet overview totals match the servers", async ({}, ti) => {
  // Give both servers some content through the independent channels
  await seRpc(SERVER_B.port, SERVER_B.password, "CreateHub", { HubName_str: TENANT.hub, AdminPasswordPlainText_str: TENANT.password, Online_bool: true });
  await seRpc(SERVER_B.port, SERVER_B.password, "CreateHub", { HubName_str: "OTHER", Online_bool: true });
  await seRpc(SERVER_B.port, SERVER_B.password, "CreateUser", { HubName_str: TENANT.hub, Name_str: "tenant-user", AuthType_u32: 1, Auth_Password_str: "Tenant-User-1" });
  expect((await vpncmd(SERVER_A.port, "", "", ["HubCreate", "FLEET", "/PASSWORD:"])).code).toBe(0);
  const aHubs = csv((await vpncmd(SERVER_A.port, "", "", ["HubList"])).out).length - 1;
  const bHubs = (await seRpc(SERVER_B.port, SERVER_B.password, "EnumHub")).HubList.length;
  const bStatus = await seRpc(SERVER_B.port, SERVER_B.password, "GetServerStatus");

  await page.getByTestId("sidebar-overview").click();
  await expect.poll(() => route(page)).toBe("/");
  await expect(page.getByTestId("kpi-online")).toContainText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("kpi-hubs")).toContainText(String(aHubs + bHubs), { timeout: 30_000 });
  await expect(page.getByTestId("kpi-users")).toContainText(String(bStatus.NumUsers_u32), { timeout: 30_000 });
  await expect(page.getByTestId(`fleet-row-${serverId("A")}`)).toContainText("Online");
  await expect(page.getByTestId(`fleet-row-${serverId("B")}`)).toContainText("Online");
  await expect(page.locator(".sem-sidebar-summary")).toHaveText("2 of 2 online");
  for (const id of [serverId("A"), serverId("B")]) await expectOnline(id);
  // Sidebar expands a server into its hubs
  await page.getByTestId(`sidebar-server-${serverId("B")}`).getByRole("button", { name: /Expand/ }).click();
  await expect(page.getByTestId(`sidebar-hub-${serverId("B")}-${TENANT.hub}`)).toBeVisible();
  await expect(page.getByTestId(`sidebar-hub-${serverId("B")}-OTHER`)).toBeVisible();
  await shot(page, "fleet-overview", ti);
});

test("quick switcher (Cmd/Ctrl+K) jumps to a server and to a Virtual Hub", async ({}, ti) => {
  await page.keyboard.press("ControlOrMeta+K");
  const input = page.getByTestId("quick-input");
  await expect(input).toBeVisible();
  await input.fill("Beta");
  await shot(page, "quick-switcher", ti);
  await input.press("Enter");
  await expect(input).toBeHidden();
  await expect.poll(() => route(page)).toBe(`/servers/${serverId("B")}`);
  // AppShell drops a repeat of the same action within 300 ms (native accelerator + renderer hotkey dedupe)
  await page.waitForTimeout(500);
  await page.keyboard.press("ControlOrMeta+K");
  await input.fill(TENANT.hub);
  await expect(page.locator(".sem-qs-item").first()).toContainText(TENANT.hub);
  await input.press("Enter");
  await expect.poll(() => route(page)).toBe(`/servers/${serverId("B")}/hubs/${TENANT.hub}`);
});

test("transport switch in Advanced: server B moves to the native protocol and back to JSON-RPC", async ({}, ti) => {
  for (const [label, expected] of [["Native", "Native admin protocol"], ["JSON-RPC", "JSON-RPC API"]] as const) {
    await page.getByTestId(`sidebar-server-${serverId("B")}`).click();
    await expect.poll(() => route(page)).toBe(`/servers/${serverId("B")}`);
    await page.getByTestId("overview-edit").click();
    const connSheet = sheet(page, "connection-sheet");
    await expect(connSheet).toBeVisible();
    await expect(page.getByTestId("conn-name")).toHaveValue(SERVER_B.name);
    const adv = page.getByTestId("conn-advanced");
    if ((await adv.getAttribute("aria-expanded")) !== "true") await adv.click();
    await segment(page.getByTestId("conn-transport"), label);
    await shot(page, `transport-${label}`, ti);
    await page.getByTestId("conn-continue").click();
    await expect(connSheet).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("overview-poll")).toContainText(expected);
    // A fresh status check over the new transport succeeds and the RPC data loads
    await page.getByTestId(`sidebar-server-${serverId("B")}`).click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Refresh Status").click();
    await expectOnline(serverId("B"));
    await expect(page.getByTestId("overview-info")).toContainText(/SoftEther/i);
  }
});

test("hub-admin connection (hub password, not saved) sees only its own hub", async ({}, ti) => {
  await page.getByTestId("sidebar-add").click();
  await fillConnection({ name: TENANT.name, port: SERVER_B.port, password: TENANT.password, save: false, hub: TENANT.hub });
  await trustCertificate(SERVER_B.port);
  patchState({ server: ["T", await landedOnServer()] });
  await expectOnline(serverId("T"));
  await expect(page.locator(".sem-content")).toContainText(`Hub admin: ${TENANT.hub}`);
  // Only hub-admin pages are offered
  const nav = page.getByTestId("scope-nav");
  await expect(nav.getByTestId("nav-listeners")).toHaveCount(0);
  await expect(nav.getByTestId("nav-hubs")).toBeVisible();
  // Oracle: the server has more hubs than the one this connection may see
  const all = (await seRpc(SERVER_B.port, SERVER_B.password, "EnumHub")).HubList.map((h: any) => h.HubName_str);
  expect(all.length).toBeGreaterThan(1);
  await nav.getByTestId("nav-hubs").click();
  const table = page.getByTestId("hubs-table");
  await expect(table.locator(`[data-testid=hub-row-${TENANT.hub}]`)).toBeVisible();
  await expect(table.locator("[data-testid^=hub-row-]")).toHaveCount(1);
  // Sidebar: expanding the connection shows only that hub; the password is unsaved (unlocked for this session)
  const row = page.getByTestId(`sidebar-server-${serverId("T")}`);
  await expect(row.locator(".sem-sb-badge")).toHaveText("HUB");
  await expect(row.locator(".sem-sb-lock")).toHaveAttribute("aria-label", "Unlocked for this session");
  await row.getByRole("button", { name: /Expand/ }).click();
  await expect(page.locator(`[data-testid^=sidebar-hub-${serverId("T")}-]`)).toHaveCount(1);
  await expect(page.getByTestId(`sidebar-hub-${serverId("T")}-${TENANT.hub}`)).toBeVisible();
  // It can manage its hub: users of TENANT are listed
  await page.getByTestId(`sidebar-hub-${serverId("T")}-${TENANT.hub}`).click();
  await page.getByTestId("scope-nav").getByTestId("nav-users").click();
  await expect(page.getByTestId("users-table")).toContainText("tenant-user");
  await shot(page, "hub-admin-connection", ti);
});

test("Settings/Preferences through the native menu, and a preference change applies", async ({}, ti) => {
  if (process.platform === "darwin") await clickMenu(a.app, ["Server Manager for SoftEther VPN", /^Settings/]);
  else await clickMenu(a.app, ["File", /^Settings/]);
  await expect.poll(() => route(page)).toBe("/preferences");
  await expect(page.getByTestId("prefs-save-state")).toBeVisible();
  const toggle = page.getByTestId("pref-backup-enabled");
  const before = await toggle.isChecked();
  await setToggle(toggle, !before);
  await expect(page.getByTestId("prefs-save-state")).toHaveText(/All changes saved/);
  await setToggle(toggle, before);
  await expect(page.getByTestId("prefs-save-state")).toHaveText(/All changes saved/);
  // View menu navigation too
  await clickMenu(a.app, ["View", "Client Deployment"]);
  await expect.poll(() => route(page)).toMatch(/^\/deploy/);
  await shot(page, "menu-navigation", ti);
});
