// Every page of the route registry (apps/desktop/src/renderer/sections.tsx) for both servers, reached by clicking
// the scope navigation like a user: no error state may show (unsupported-feature notices, grey, are recorded but
// allowed), and each page is captured as a screenshot.
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { closeApp, launchApp, openServer, route, serverId, settled, shot, type App } from "../helpers.ts";

// Mirror of sections.tsx (paths + labels). The test also asserts the navigation offers exactly these entries,
// so a page added to the registry without being listed here fails loudly.
const SERVER_SECTIONS: [string, string][] = [
  ["", "Overview"], ["hubs", "Virtual Hubs"], ["connections", "Connections"], ["listeners", "Listeners & Ports"],
  ["bridges", "Local Bridges"], ["l3", "Layer 3 Switches"], ["ddns", "DDNS & VPN Azure"], ["protocols", "OpenVPN & SSTP"],
  ["ipsec", "IPsec, L2TP & EtherIP"], ["wireguard", "WireGuard"], ["certificate", "Certificate & TLS"], ["security", "Admin Password"],
  ["cluster", "Clustering"], ["settings", "Server Settings"], ["logs", "Logs & Syslog"], ["config", "Configuration & Backups"],
  ["license", "License & VLAN"], ["caps", "Capabilities"], ["console", "API Console"],
];
const HUB_SECTIONS: [string, string][] = [
  ["", "Status"], ["settings", "Properties"], ["options", "Admin & Extended Options"], ["message", "Client Message"],
  ["users", "Users"], ["groups", "Groups"], ["radius", "RADIUS"], ["certs", "Trusted CAs & CRL"], ["sessions", "Sessions"],
  ["tables", "MAC & IP Tables"], ["access", "Access Lists"], ["acl", "Source IP Control"], ["cascades", "Cascade Connections"],
  ["securenat", "SecureNAT"], ["logging", "Logging"], ["deploy", "Client Deployment"],
];
const DEPLOY_SECTIONS: [string, string][] = [
  ["hubs", "Hub Profiles"], ["profiles", "Custom Profiles"], ["templates", "Templates & Branding"], ["packages", "Client Packages"], ["installers", "MSI Installers"],
];

// Not serial: a page failing on one server must not hide the results of the others.
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;

test.beforeAll(async () => { a = await launchApp(); page = a.page; });
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });

interface Finding { route: string; label: string; errors: string[]; notices: string[]; stillLoading: boolean }

/** Visit every section of the current scope through its navigation and collect error states. */
async function visitAll(scope: string, base: string, sections: [string, string][], ti: TestInfo): Promise<Finding[]> {
  const nav = page.getByTestId("scope-nav");
  await expect(nav).toBeVisible();
  // (the previous scope's navigation can still be on screen for a moment after the route changed)
  await expect.poll(() => nav.locator("[data-testid^=nav-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(4))),
    { message: `${scope}: navigation entries` }).toEqual(sections.map(([p]) => p || "index"));
  const out: Finding[] = [];
  for (const [p, label] of sections) {
    await nav.getByTestId(`nav-${p || "index"}`).click();
    const want = p ? `${base}/${p}` : base;
    await expect.poll(() => route(page)).toBe(want);
    await expect(nav.getByTestId(`nav-${p || "index"}`)).toHaveAttribute("aria-current", "page");
    let stillLoading = false;
    try { await settled(page, 15_000); } catch { stillLoading = true; }
    await page.waitForTimeout(400); // late error toasts / queries
    const states = await page.locator(".sem-content .sem-error").evaluateAll((els) => els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ tone: e.getAttribute("data-tone") ?? "", text: (e as HTMLElement).innerText.replace(/\s+/g, " ").trim() })));
    const unreachable = await page.locator(".sem-content [data-testid=page-unreachable], .sem-content [data-testid=overview-unreachable]").count();
    const f: Finding = {
      route: want, label,
      errors: [...states.filter((s) => s.tone !== "gray").map((s) => s.text), ...(unreachable ? ["server shown as unreachable"] : [])],
      notices: states.filter((s) => s.tone === "gray").map((s) => s.text),
      stillLoading,
    };
    await expect(page.locator(".sem-content")).not.toBeEmpty();
    await shot(page, `${scope}-${p || "index"}`, ti);
    out.push(f);
  }
  return out;
}

function report(ti: TestInfo, findings: Finding[]) {
  for (const f of findings) {
    if (f.notices.length) ti.annotations.push({ type: "notice", description: `${f.route} (${f.label}): ${f.notices.join(" | ")}` });
    if (f.stillLoading) ti.annotations.push({ type: "still-loading-after-15s", description: `${f.route} (${f.label})` });
  }
  const bad = findings.filter((f) => f.errors.length);
  for (const f of bad) ti.annotations.push({ type: "error-state", description: `${f.route} (${f.label}): ${f.errors.join(" | ")}` });
  expect(bad.map((f) => `${f.route} (${f.label}): ${f.errors.join(" | ")}`), "pages showing an error state").toEqual([]);
}

async function openHubFromTable(id: number, hub: string) {
  await openServer(page, id);
  await page.getByTestId("scope-nav").getByTestId("nav-hubs").click();
  await page.getByTestId(`hub-row-${hub}`).dblclick();
  await expect.poll(() => route(page)).toBe(`/servers/${id}/hubs/${hub}`);
}

for (const [key, hub] of [["A", "HQ"], ["B", "BRANCH"]] as const) {
  test(`server ${key}: every server section renders without an error state`, async ({}, ti) => {
    const id = serverId(key);
    await openServer(page, id);
    await expect(page.getByTestId(`sidebar-server-${id}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
    report(ti, await visitAll(`server${key}`, `/servers/${id}`, SERVER_SECTIONS, ti));
  });

  test(`server ${key}: every hub section of ${hub} renders without an error state`, async ({}, ti) => {
    const id = serverId(key);
    await openHubFromTable(id, hub);
    report(ti, await visitAll(`server${key}-hub-${hub}`, `/servers/${id}/hubs/${hub}`, HUB_SECTIONS, ti));
  });
}

test("client deployment: every section renders without an error state", async ({}, ti) => {
  await page.getByTestId("sidebar-deploy").click();
  await expect.poll(() => route(page)).toBe("/deploy/hubs");
  report(ti, await visitAll("deploy", "/deploy", DEPLOY_SECTIONS, ti));
});

test("global pages: overview and preferences", async ({}, ti) => {
  await page.getByTestId("sidebar-overview").click();
  await settled(page);
  await expect(page.locator(".sem-content .sem-error")).toHaveCount(0);
  await shot(page, "global-overview", ti);
  await page.getByTestId("sidebar-preferences").click();
  await settled(page);
  await expect(page.locator(".sem-content .sem-error")).toHaveCount(0);
  await shot(page, "global-preferences", ti);
});
