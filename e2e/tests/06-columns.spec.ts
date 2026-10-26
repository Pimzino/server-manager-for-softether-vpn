// Resizable table columns (design/DataTable.tsx), on server A's Virtual Hubs table: dragging a header edge resizes
// that column only, does not sort, survives an app restart, and a double-click on an edge restores the automatic layout.
// Measurements are written to outputs/column-resize.json next to the screenshots.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeApp, launchApp, openSection, openServer, serverId, settled, shot, type App } from "../helpers.ts";
import { OUTPUTS } from "../env.ts";

test.describe.configure({ mode: "serial" });
let a: App;
let page: Page;
const report: Record<string, unknown> = {};

test.afterAll(async ({}, ti) => {
  await closeApp(a, ti);
  mkdirSync(OUTPUTS, { recursive: true });
  writeFileSync(path.join(OUTPUTS, "column-resize.json"), JSON.stringify(report, null, 2));
});

const table = () => page.getByTestId("hubs-table");
const th = (key: string) => table().locator(`thead th[data-col="${key}"]`);
const width = async (key: string) => (await th(key).boundingBox())!.width;
const widths = () => table().locator("thead th[data-col]").evaluateAll((els) =>
  Object.fromEntries(els.map((e) => [e.getAttribute("data-col")!, Math.round(e.getBoundingClientRect().width)])));

async function openHubs() {
  await openServer(page, serverId("A"));
  await openSection(page, "hubs");
  await expect(table().locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
  await settled(page);
}

/** Drag the right edge of a column header by dx pixels with the real mouse. */
async function drag(key: string, dx: number) {
  const box = (await table().getByTestId(`hubs-table-resize-${key}`).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}

test("dragging a header edge resizes only that column and does not sort", async ({}, ti) => {
  a = await launchApp();
  page = a.page;
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("sem-col-widths:")) localStorage.removeItem(k); });
  await openHubs();
  await expect(table().locator("table")).not.toHaveAttribute("data-resized");
  const before = await widths();
  const sortBefore = await th("NumSessions_u32").getAttribute("aria-sort");
  report.auto = before;

  await drag("NumSessions_u32", 120);
  await expect(table().locator("table")).toHaveAttribute("data-resized", "true");
  const after = await widths();
  report.afterWiden = after;
  expect(Math.abs(after.NumSessions_u32 - (before.NumSessions_u32 + 120))).toBeLessThanOrEqual(2);
  // Every other column but the last (which fills the rest) keeps its width.
  for (const k of Object.keys(before).slice(0, -1).filter((k) => k !== "NumSessions_u32")) {
    expect(Math.abs(after[k] - before[k]), `${k} should keep its width`).toBeLessThanOrEqual(1);
  }
  expect(await th("NumSessions_u32").getAttribute("aria-sort")).toBe(sortBefore);

  // Shrinking stops at the minimum width.
  await drag("Online_bool", -500);
  expect(Math.round(await width("Online_bool"))).toBe(40);
  report.afterShrink = await widths();
  await shot(page, "columns-resized", ti);
});

test("resized widths survive a restart, and a double-click restores the automatic layout", async ({}, ti) => {
  const resized = report.afterShrink as Record<string, number>;
  await closeApp(a);
  a = await launchApp();
  page = a.page;
  await openHubs();
  const restored = await widths();
  report.afterRestart = restored;
  expect(Math.abs(restored.NumSessions_u32 - resized.NumSessions_u32)).toBeLessThanOrEqual(1);
  expect(restored.Online_bool).toBe(40);

  await table().getByTestId("hubs-table-resize-NumUsers_u32").dblclick();
  await expect(table().locator("table")).not.toHaveAttribute("data-resized");
  const reset = await widths();
  report.afterReset = reset;
  const auto = report.auto as Record<string, number>;
  for (const k of Object.keys(auto)) expect(Math.abs(reset[k] - auto[k]), `${k} back to auto`).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sem-col-widths:")))).toEqual([]);
  await shot(page, "columns-reset", ti);
});
