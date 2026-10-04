// Certificate pinning: server B's certificate is regenerated behind the app's back (independent JSON-RPC), the app
// refuses the new certificate, and the user trusts it again: on the Certificate page (server connection) and from
// the connection sheet's "Trust New Certificate…" (hub-admin connection).
import { test, expect, type Page } from "@playwright/test";
import {
  closeApp, confirmDialog, launchApp, normFp, openSection, openServer, readState, seRpc, serverId, sheet, shot, tlsFingerprint, type App,
} from "../helpers.ts";
import { SERVER_B, TENANT } from "../env.ts";

// Not serial: a failure must not skip the remaining checks (the worker restarts and beforeAll relaunches the app).
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;
let oldFp = "";
let newFp = "";

test.beforeAll(async () => { a = await launchApp(); page = a.page; });
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });
test.afterEach(async ({}, ti) => { if (ti.status !== ti.expectedStatus) await shot(page, `FAILED-${ti.title}`, ti).catch(() => undefined); });

test("regenerating B's certificate makes the app refuse it (pin mismatch)", async ({}, ti) => {
  const B = serverId("B");
  await expect(page.getByTestId(`sidebar-server-${B}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  oldFp = await tlsFingerprint(SERVER_B.port);
  await seRpc(SERVER_B.port, readState().bPassword, "RegenerateServerCert", { StrValue_str: "desk-beta-regenerated" });
  newFp = await tlsFingerprint(SERVER_B.port);
  expect(newFp).not.toBe(oldFp);
  await openServer(page, B);
  await page.getByTestId(`sidebar-server-${B}`).click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Refresh Status").click();
  await expect(page.getByTestId(`sidebar-server-${B}`).locator(".sem-dot[data-status=error]")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("overview-unreachable")).toBeVisible();
  await expect(page.getByTestId("overview-unreachable")).toContainText(/certificate|fingerprint/i);
  await shot(page, "pin-mismatch", ti);
});

test("trust the new certificate on the Certificate page: probe, compare, confirm, back online", async ({}, ti) => {
  const B = serverId("B");
  await openSection(page, "certificate");
  const panel = page.getByTestId("repin-panel");
  await expect(panel).toBeVisible();
  expect(normFp((await panel.getByTestId("pinned-fp").locator(".sem-fp-grid").getAttribute("aria-label"))!.replace(/^Fingerprint\s*/, ""))).toBe(oldFp);
  await panel.getByTestId("probe-cert").click();
  const result = panel.getByTestId("probe-result");
  await expect(result).toContainText("different certificate", { timeout: 30_000 });
  const presented = await result.getByTestId("presented-fp").locator(".sem-fp-grid").getAttribute("aria-label");
  expect(normFp(presented!.replace(/^Fingerprint\s*/, ""))).toBe(newFp);
  await shot(page, "repin-probe", ti);
  await result.getByTestId("repin-confirm").click();
  await confirmDialog(page, /Trust this certificate/);
  await page.getByTestId(`sidebar-server-${B}`).click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Refresh Status").click();
  await expect(page.getByTestId(`sidebar-server-${B}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  await openSection(page, "certificate");
  await expect(page.getByTestId("cert-fp-match")).toHaveText("Trusted by this app", { timeout: 30_000 });
  await shot(page, "repinned", ti);
});

test("connection sheet: the hub-admin connection's test fails with the new certificate and offers to trust it", async ({}, ti) => {
  const T = serverId("T");
  await page.getByTestId(`sidebar-server-${T}`).click({ button: "right" });
  await page.getByTestId("context-menu").getByTestId("ctx-edit").click();
  const s = sheet(page, "connection-sheet");
  await expect(s).toBeVisible();
  await s.getByTestId("conn-password").fill(TENANT.password);
  await s.getByTestId("conn-continue").click();
  const err = s.getByTestId("connection-error");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toContainText("The server’s certificate changed");
  await shot(page, "sheet-tls-mismatch", ti);
  await err.getByTestId("trust-presented").click();
  const trust = s.getByTestId("connection-trust");
  await expect(trust).toBeVisible();
  expect(normFp((await trust.locator(".sem-fp-grid").first().getAttribute("aria-label"))!.replace(/^Fingerprint\s*/, ""))).toBe(newFp);
  await s.getByTestId("connection-trust-confirm").click();
  await expect(s).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId(`sidebar-server-${T}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
});
