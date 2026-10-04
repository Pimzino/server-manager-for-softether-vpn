// Real administration through the UI, each result checked directly on the SoftEther servers: vpncmd for server A
// (native admin protocol; its JSON-RPC API is off) and JSON-RPC for server B.
import { test, expect, type Page } from "@playwright/test";
import {
  closeApp, confirmDialog, csv, csvMap, eventually, launchApp, openSection, openServer, patchState, readState, route, segment,
  selectOption, serverId, setToggle, sheet, shot, seRpc, vpncmd, type App,
} from "../helpers.ts";
import { B_NEW_PASSWORD, SERVER_A, SERVER_B, TENANT } from "../env.ts";

// Not serial: a failure must not skip the remaining checks (the worker restarts and beforeAll relaunches the app).
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;
let A: number, B: number;
const LINK_PW = "Link-Passw0rd!";

const va = (hub: string, ...cmd: string[]) => vpncmd(SERVER_A.port, SERVER_A.password, hub, cmd);
const bRpc = (method: string, params: Record<string, unknown> = {}) => seRpc(SERVER_B.port, readState().bPassword, method, params);
const hubsOnA = async () => csv((await va("", "HubList")).out).slice(1).map((r) => r[0]);

test.beforeAll(async () => {
  A = serverId("A"); B = serverId("B");
  a = await launchApp(); page = a.page;
  // The hub-admin connection is locked again after this restart; it is not used here.
});
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });
test.afterEach(async ({}, ti) => { if (ti.status !== ti.expectedStatus) await shot(page, `FAILED-${ti.title}`, ti).catch(() => undefined); });

async function createHub(serverIdN: number, name: string, openAfter = true) {
  await openServer(page, serverIdN);
  await openSection(page, "hubs");
  await page.getByTestId("hub-create").click();
  const s = sheet(page, "hub-create-sheet");
  await expect(s).toBeVisible();
  await s.getByTestId("hub-name").fill(name);
  if (!openAfter) await setToggle(s.getByRole("checkbox", { name: "Open the hub after creating it" }), false);
  await s.getByTestId("hub-create-submit").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
}

async function openHub(serverIdN: number, hub: string, section = "") {
  await openServer(page, serverIdN);
  await openSection(page, "hubs");
  await page.getByTestId(`hub-row-${hub}`).dblclick();
  await expect.poll(() => route(page)).toBe(`/servers/${serverIdN}/hubs/${hub}`);
  if (section) await openSection(page, section);
}

test("create a Virtual Hub on server A (native)", async ({}, ti) => {
  await createHub(A, "HQ");
  await expect.poll(() => route(page)).toBe(`/servers/${A}/hubs/HQ`);
  expect(await hubsOnA()).toContain("HQ");
  await shot(page, "hub-HQ-created", ti);
});

test("group with a security policy, then a policy edit", async ({}, ti) => {
  await openHub(A, "HQ", "groups");
  await page.getByTestId("create-group").click();
  const s = sheet(page, "group-sheet");
  await expect(s).toBeVisible();
  await s.getByTestId("group-name").fill("engineers");
  await s.getByTestId("group-realname").fill("Engineering");
  await segment(s.getByTestId("group-panes"), "Security Policy");
  await setToggle(s.getByTestId("group-use-policy"), true);
  await s.getByTestId("policy-policy:MaxConnection_u32").fill("4");
  await s.getByTestId("policy-policy:TimeOut_u32").fill("30");
  await shot(page, "group-policy", ti);
  await s.getByTestId("group-save").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("groups-table")).toContainText("engineers");
  let g = csvMap((await va("HQ", "GroupGet", "engineers")).out);
  expect(g["Full Name"]).toBe("Engineering");
  expect(g.MaxConnection).toMatch(/,4\s*$/);
  expect(g.TimeOut).toMatch(/,30 seconds/);
  // Edit the policy
  await page.getByTestId("groups-table").getByText("engineers", { exact: true }).dblclick();
  await expect(s).toBeVisible();
  await segment(s.getByTestId("group-panes"), "Security Policy");
  await expect(s.getByTestId("policy-policy:MaxConnection_u32")).toHaveValue("4");
  await s.getByTestId("policy-policy:MaxConnection_u32").fill("6");
  await s.getByTestId("group-save").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  g = csvMap((await va("HQ", "GroupGet", "engineers")).out);
  expect(g.MaxConnection).toMatch(/,6\s*$/);
  expect(g.TimeOut).toMatch(/,30 seconds/);
});

test("password users (one in the group) are created and can be edited without losing the password", async ({}, ti) => {
  await openHub(A, "HQ", "users");
  for (const u of [{ name: "site-link", group: true, pw: LINK_PW, real: "Site link" }, { name: "bob", group: false, pw: "Bob-Passw0rd!", real: "Bob" }]) {
    await page.getByTestId("create-user").click();
    const s = sheet(page, "user-sheet");
    await expect(s).toBeVisible();
    await s.getByTestId("user-name").fill(u.name);
    await s.getByTestId("user-realname").fill(u.real);
    if (u.group) await selectOption(page, s.getByTestId("user-group"), /^engineers/);
    await segment(s.getByTestId("user-panes"), "Authentication");
    await s.getByTestId("user-password").fill(u.pw);
    await s.getByTestId("user-password2").fill(u.pw);
    await s.getByTestId("user-save").click();
    await expect(s).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("users-table")).toContainText(u.name);
  }
  const link = csvMap((await va("HQ", "UserGet", "site-link")).out);
  expect(link["Group Name"]).toBe("engineers");
  expect(link["Auth Type"]).toBe("Password Authentication");
  // Edit bob's full name only
  await page.getByTestId("users-table").getByText("bob", { exact: true }).dblclick();
  const s = sheet(page, "user-sheet");
  await expect(s.getByTestId("user-realname")).toHaveValue("Bob");
  await s.getByTestId("user-realname").fill("Bob Builder");
  await s.getByTestId("user-save").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  expect(csvMap((await va("HQ", "UserGet", "bob")).out)["Full Name"]).toBe("Bob Builder");
  await shot(page, "users", ti);
});

test("access list rule (discard telnet to 10.0.0.0/8)", async ({}, ti) => {
  await openHub(A, "HQ", "access");
  await page.getByTestId("create-access").click();
  const s = sheet(page, "access-rule-sheet");
  await expect(s).toBeVisible();
  await segment(s.getByTestId("rule-action"), "Discard");
  await s.getByTestId("rule-priority").fill("100");
  await s.getByTestId("rule-note").fill("block telnet");
  await selectOption(page, s.getByTestId("rule-protocol"), "TCP");
  await s.getByTestId("rule-dst-ip").fill("10.0.0.0");
  await s.getByTestId("rule-dst-mask").fill("255.0.0.0");
  await s.getByTestId("rule-dst-port-start").fill("23");
  await s.getByTestId("rule-dst-port-end").fill("23");
  await shot(page, "access-rule", ti);
  await s.getByTestId("rule-save").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("access-table")).toContainText("block telnet");
  const rows = csv((await va("HQ", "AccessList")).out);
  const rule = rows.find((r) => r[6] === "block telnet");
  expect(rule, JSON.stringify(rows)).toBeTruthy();
  expect(rule![1]).toBe("Discard");
  expect(rule![3]).toBe("100");
  expect(rule![5]).toContain("DstIPv4=10.0.0.0/8");
  expect(rule![5]).toContain("Protocol=TCP");
  expect(rule![5]).toContain("DstPort=23");
});

test("SecureNAT is turned on", async ({}, ti) => {
  await openHub(A, "HQ", "securenat");
  await expect(page.getByTestId("securenat-state")).toHaveText("Off");
  await page.getByTestId("securenat-enable").click();
  await confirmDialog(page, /Turn on SecureNAT/);
  await expect(page.getByTestId("securenat-state")).toHaveText("On", { timeout: 30_000 });
  await expect(page.getByTestId("securenat-status")).toBeVisible({ timeout: 30_000 });
  const st = await va("HQ", "SecureNatStatusGet");
  expect(st.code, st.out).toBe(0);
  expect(csvMap(st.out)["Virtual Hub Name"]).toBe("HQ");
  await eventually(async () => (await va("HQ", "SessionList")).out.includes("SecureNAT"), 15_000);
  await shot(page, "securenat-on", ti);
});

test("cascade connection from a new hub on B to HQ on A goes online (real VPN session)", async ({}, ti) => {
  await createHub(B, "BRANCH");
  await expect.poll(() => route(page)).toBe(`/servers/${B}/hubs/BRANCH`);
  expect((await bRpc("EnumHub")).HubList.map((h: any) => h.HubName_str)).toContain("BRANCH");
  await openSection(page, "cascades");
  await page.getByTestId("create-link").click();
  const s = sheet(page, "link-sheet");
  await expect(s).toBeVisible();
  await s.getByTestId("link-name").fill("to-hq");
  await s.getByTestId("link-host").fill("127.0.0.1");
  await s.getByTestId("link-port").fill(String(SERVER_A.port));
  await s.getByTestId("link-target-hub").fill("HQ");
  await expect(s.getByTestId("link-online-new")).toBeChecked();
  await s.getByTestId("link-tab-auth").click();
  await s.getByTestId("link-username").fill("site-link");
  await s.getByTestId("link-password").fill(LINK_PW);
  await shot(page, "cascade-form", ti);
  await s.getByTestId("link-save").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  // Oracle: the link on B is connected...
  const status = await eventually(async () => {
    const r = await bRpc("GetLinkStatus", { HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq" });
    return r.Connected_bool ? r : null;
  }, 45_000, 1000, "cascade connected").catch(async (e) => {
    const links = await bRpc("EnumLink", { HubName_str: "BRANCH" });
    throw new Error(`${e.message}; EnumLink=${JSON.stringify(links.LinkList)}`);
  });
  expect(status.ServerName_str).toBe("127.0.0.1");
  // ...and A has the session, authenticated as site-link
  await eventually(async () => csv((await va("HQ", "SessionList")).out).some((r) => r[3] === "site-link"), 20_000, 1000, "session on A");
  // The UI shows it online, and A's hub sessions page lists it
  await expect(page.getByTestId("link-status-to-hq")).toContainText(/Online|Connected|Established/i, { timeout: 30_000 });
  await shot(page, "cascade-online", ti);
  await openHub(A, "HQ", "sessions");
  await expect(page.locator(".sem-content")).toContainText("site-link", { timeout: 30_000 });
  await shot(page, "hq-sessions-with-cascade", ti);
  // Take it offline again from the UI
  await openHub(B, "BRANCH", "cascades");
  await setToggle(page.getByTestId("link-online-to-hq"), false);
  await eventually(async () => !(await bRpc("GetLinkStatus", { HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq" }).catch(() => ({ Connected_bool: false }))).Connected_bool, 20_000, 1000, "link offline");
  expect((await bRpc("EnumLink", { HubName_str: "BRANCH" })).LinkList.find((l: any) => l.AccountName_utf === "to-hq").Online_bool).toBe(false);
});

test("listener add and remove on server B", async ({}, ti) => {
  await openServer(page, B);
  await openSection(page, "listeners");
  await page.getByTestId("create-listener").click();
  const s = sheet(page, "listener-create-sheet");
  await expect(s).toBeVisible();
  await s.getByTestId("listener-port").fill("16199");
  await s.getByTestId("listener-create-submit").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("listener-row-16199")).toBeVisible();
  expect((await bRpc("EnumListener")).ListenerList.some((l: any) => l.Ports_u32 === 16199)).toBe(true);
  await shot(page, "listener-added", ti);
  await page.getByTestId("listener-row-16199").click();
  await page.getByTestId("listener-delete").click();
  await confirmDialog(page);
  await expect(page.getByTestId("listener-row-16199")).toBeHidden({ timeout: 30_000 });
  expect((await bRpc("EnumListener")).ListenerList.some((l: any) => l.Ports_u32 === 16199)).toBe(false);
});

test("API console: a read call returns live data, a failing call shows the SoftEther error", async ({}, ti) => {
  await openServer(page, A);
  await openSection(page, "console");
  await page.getByTestId("console-method-search").fill("GetHub");
  await page.getByTestId("console-method-GetHub").click();
  await expect(page.getByTestId("console-method-name")).toHaveText("GetHub");
  await page.getByTestId("console-hub").fill("HQ");
  await page.getByTestId("console-execute").click();
  await expect(page.getByTestId("console-result-status")).toHaveText("Success", { timeout: 30_000 });
  await expect(page.getByTestId("console-result")).toContainText("HQ");
  await shot(page, "console-success", ti);
  await page.getByTestId("console-hub").fill("NO_SUCH_HUB");
  await page.getByTestId("console-execute").click();
  await expect(page.getByTestId("console-result-status")).toHaveText("Error", { timeout: 30_000 });
  await expect(page.getByTestId("console-result")).toContainText(/8|not exist|not found/i);
  await shot(page, "console-error", ti);
});

test("bulk run across both servers with confirmation (CreateHub)", async ({}, ti) => {
  await page.getByTestId("sidebar-overview").click();
  await page.getByTestId("fleet-bulk").click();
  const s = sheet(page, "bulk-sheet");
  await expect(s).toBeVisible();
  const list = s.getByTestId("bulk-servers");
  // Only the two server-admin connections: the hub-admin one is locked (disabled) after the restart
  await setToggle(list.locator(".sem-check-row").filter({ hasText: SERVER_A.name }).getByRole("checkbox"), true);
  await setToggle(list.locator(".sem-check-row").filter({ hasText: SERVER_B.name }).getByRole("checkbox"), true);
  const t = list.locator(".sem-check-row").filter({ hasText: TENANT.name }).getByRole("checkbox");
  if (await t.count() && await t.isEnabled()) await setToggle(t, false);
  await s.getByTestId("bulk-method").fill("CreateHub");
  await page.getByRole("option", { name: "CreateHub", exact: true }).click();
  await s.getByTestId("bulk-params").fill(JSON.stringify({ HubName_str: "BULKHUB", AdminPasswordPlainText_str: "", Online_bool: true, MaxSession_u32: 0, NoEnum_bool: false, HubType_u32: 0 }, null, 2));
  await expect(s.getByTestId("bulk-run")).toHaveText("Run on 2 Servers");
  await s.getByTestId("bulk-run").click();
  const title = await confirmDialog(page, /Run CreateHub on 2 servers/);
  ti.annotations.push({ type: "confirmation", description: title });
  await expect(s.getByTestId("bulk-results")).toContainText("Succeeded", { timeout: 30_000 });
  await expect(s).toContainText("2 of 2 succeeded");
  await shot(page, "bulk-results", ti);
  expect(await hubsOnA()).toContain("BULKHUB");
  expect((await bRpc("EnumHub")).HubList.map((h: any) => h.HubName_str)).toContain("BULKHUB");
  await s.getByRole("button", { name: "Done" }).click();
});

test("delete a Virtual Hub with the typed-name confirmation", async ({}, ti) => {
  await openServer(page, A);
  await openSection(page, "hubs");
  await page.getByTestId("hub-row-BULKHUB").click();
  await page.getByTestId("hub-delete").click();
  const dlg = page.locator(".sem-alert form").last();
  await expect(dlg.getByTestId("confirm-type")).toBeVisible();
  await expect(dlg.locator("button[type=submit]")).toBeDisabled();
  await shot(page, "delete-hub-confirm", ti);
  await confirmDialog(page, /Delete Virtual Hub .BULKHUB./);
  await expect(page.getByTestId("hub-row-BULKHUB")).toBeHidden({ timeout: 30_000 });
  expect(await hubsOnA()).not.toContain("BULKHUB");
});

test("configuration backup: take, diff against live, restore", async ({}, ti) => {
  await openServer(page, A);
  await openSection(page, "config");
  await page.getByTestId("backup-new").click();
  const s = sheet(page, "backup-new-sheet");
  await s.getByTestId("backup-note").fill("e2e before TEMPRESTORE");
  await s.getByTestId("create-backup").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  const row = page.locator("[data-testid^=backup-row-]").filter({ hasText: "e2e before TEMPRESTORE" });
  await expect(row).toBeVisible();
  // Change the live configuration
  await createHub(A, "TEMPRESTORE", false);
  expect(await hubsOnA()).toContain("TEMPRESTORE");
  // Diff: the new hub shows as added lines
  await openSection(page, "config");
  await row.click();
  await page.getByTestId("backups-compare").click();
  const d = sheet(page, "diff-sheet");
  await expect(d.getByTestId("diff-view")).toBeVisible({ timeout: 30_000 });
  await expect(d.getByTestId("diff-view").locator("tr[data-difftype=add]").filter({ hasText: "TEMPRESTORE" }).first()).toBeVisible();
  await expect(d.getByTestId("diff-adds")).not.toHaveText("+0");
  await shot(page, "backup-diff", ti);
  await d.getByRole("button", { name: "Done" }).click();
  await expect(d).toBeHidden();
  // Restore
  await row.click();
  await page.getByTestId("backups-restore").click();
  await confirmDialog(page, /Restore backup/);
  await test.step("server A runs the restored configuration (vpncmd)", () =>
    eventually(async () => !(await hubsOnA()).includes("TEMPRESTORE") && (await hubsOnA()).includes("HQ"), 90_000, 1000, "restored config on A"));
  // The app reconnects to the restarted server over the native protocol
  await test.step("the app reconnects to A", async () => {
    await page.getByTestId(`sidebar-server-${A}`).click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Refresh Status").click();
    await expect(page.getByTestId(`sidebar-server-${A}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 60_000 });
  });
  await openSection(page, "hubs");
  await expect(page.getByTestId("hub-row-HQ")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("hub-row-TEMPRESTORE")).toBeHidden();
  await shot(page, "backup-restored", ti);
});

test("admin password change on server B, then the app reconnects with the new password", async ({}, ti) => {
  const old = readState().bPassword;
  await openServer(page, B);
  await openSection(page, "security");
  await page.getByTestId("new-password").fill(B_NEW_PASSWORD);
  await page.getByTestId("confirm-password").fill(B_NEW_PASSWORD);
  await setToggle(page.getByTestId("ack-password"), true);
  await page.getByTestId("change-password").click();
  await confirmDialog(page);
  const s = sheet(page, "password-sheet");
  await expect(s.getByTestId("step-verify")).toHaveAttribute("data-step", "ok", { timeout: 60_000 });
  await expect(s.getByTestId("password-success")).toBeVisible();
  await shot(page, "password-changed", ti);
  patchState({ bPassword: B_NEW_PASSWORD });
  await s.getByTestId("password-done").click();
  // Oracle: the new password works on B, the old one doesn't
  await expect(seRpc(SERVER_B.port, old, "GetServerInfo")).rejects.toThrow();
  expect((await seRpc(SERVER_B.port, B_NEW_PASSWORD, "GetServerInfo")).ServerHostName_str).toBeTruthy();
  // Reconnect: a fresh status check with the stored new password
  await page.getByTestId(`sidebar-server-${B}`).click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Refresh Status").click();
  await expect(page.getByTestId(`sidebar-server-${B}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  await openSection(page, "");
  await expect(page.getByTestId("overview-status")).toHaveText(/Online/);
  await expect(page.getByTestId("overview-info")).toContainText(/SoftEther/i);
});
