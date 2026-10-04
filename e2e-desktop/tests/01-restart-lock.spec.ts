// Restart the app on the same data directory: saved connections come back and connect by themselves, the
// connection whose password was not saved is locked again and asks for it (wrong password first).
import { test, expect, type Page } from "@playwright/test";
import { closeApp, launchApp, route, serverId, sheet, shot, type App } from "../helpers.ts";
import { TENANT } from "../env.ts";

// Not serial: a failure must not skip the remaining checks (the worker restarts and beforeAll relaunches the app).
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;

test.beforeAll(async () => { a = await launchApp(); page = a.page; });
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });
test.afterEach(async ({}, ti) => { if (ti.status !== ti.expectedStatus) await shot(page, `FAILED-${ti.title}`, ti).catch(() => undefined); });

test("after a restart the saved servers persist and reconnect; the unsaved one is locked", async ({}, ti) => {
  const [A, B, T] = [serverId("A"), serverId("B"), serverId("T")];
  await expect(page.locator("[data-testid^=sidebar-server-]")).toHaveCount(3);
  for (const id of [A, B]) {
    await expect(page.getByTestId(`sidebar-server-${id}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  }
  const t = page.getByTestId(`sidebar-server-${T}`);
  await expect(t.locator(".sem-dot[data-status=locked]")).toBeVisible();
  await expect(t.locator(".sem-sb-lock")).toHaveAttribute("aria-label", "Locked");
  await expect(page.getByTestId("fleet-problems")).toContainText(`${TENANT.name} is locked`);
  // A locked connection is not "online": the sidebar summary and the fleet tile must not count it (soft: the
  // remaining checks still run when this fails).
  await expect.soft(page.locator(".sem-sidebar-summary"), "sidebar online count with one locked connection").toHaveText("2 of 3 online", { timeout: 5_000 });
  await expect.soft(page.getByTestId("kpi-online"), "fleet 'Servers online' with one locked connection").toContainText("2/3", { timeout: 5_000 });
  await shot(page, "restart-locked", ti);
});

test("the locked connection prompts for its password: a wrong one is refused, the right one unlocks", async ({}, ti) => {
  const T = serverId("T");
  await page.getByTestId(`sidebar-server-${T}`).click();
  const dlg = sheet(page, "unlock-dialog");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("unlock-password").fill("not-the-hub-password");
  await dlg.getByTestId("unlock-submit").click();
  await expect(dlg.getByTestId("error-state")).toBeVisible({ timeout: 30_000 });
  await expect(dlg.getByTestId("error-state")).toContainText(/password|Authentication/i);
  await shot(page, "unlock-wrong-password", ti);
  await dlg.getByTestId("unlock-password").fill(TENANT.password);
  await dlg.getByTestId("unlock-submit").click();
  await expect(dlg).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId(`sidebar-server-${T}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`sidebar-server-${T}`).locator(".sem-sb-lock")).toHaveAttribute("aria-label", "Unlocked for this session");
  await expect.poll(() => route(page)).toBe(`/servers/${T}`);
  await expect(page.locator(".sem-content")).toContainText(`Hub admin: ${TENANT.hub}`);
  // Lock it again from the context menu: the page asks for the password inline
  await page.getByTestId(`sidebar-server-${T}`).click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Lock (Forget Password)").click();
  await expect(page.getByTestId(`sidebar-server-${T}`).locator(".sem-dot[data-status=locked]")).toBeVisible();
  await expect(page.locator(".sem-unlock-page")).toBeVisible();
  await page.locator(".sem-unlock-page").getByTestId("unlock-password").fill(TENANT.password);
  await page.locator(".sem-unlock-page").getByTestId("unlock-submit").click();
  await expect(page.getByTestId(`sidebar-server-${T}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
  await shot(page, "unlocked", ti);
});
