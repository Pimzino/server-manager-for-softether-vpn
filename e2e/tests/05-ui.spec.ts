// Browser flows through the real UI, verified against the SoftEther servers directly,
// plus a crawl of every page (server + hub sections) failing on runtime errors.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { adminApi, eventually, seRpc, uiLogin } from "../helpers.ts";
import { ARTIFACTS, SERVERS } from "../env.ts";

test.describe.configure({ mode: "serial" });
const [ALPHA] = SERVERS;
const SHOTS = path.join(ARTIFACTS, "screenshots");

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|status of 4\d\d|status of 5\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function alphaId() {
  const api = await adminApi();
  return (await api.get("/api/servers")).find((s: any) => s.name === ALPHA.name).id as number;
}

test("dashboard shows the fleet", async ({ page }) => {
  const errors = trackErrors(page);
  await uiLogin(page);
  await expect(page.getByTestId("dashboard-kpis")).toBeVisible();
  await expect(page.getByText(ALPHA.name).first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "01-dashboard.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("add-server wizard: probe certificate, confirm fingerprint, test, save", async ({ page }) => {
  const errors = trackErrors(page);
  await uiLogin(page);
  await page.goto("/servers");
  await page.getByTestId("add-server").click();
  await page.getByTestId("wizard-host").fill("127.0.0.1");
  await page.getByTestId("wizard-port").fill(String(ALPHA.port));
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-step-tls")).toBeVisible();
  const fp = (await seRpc(ALPHA.port, "", "GetServerCert")).Cert_bin as string;
  expect(fp).toBeTruthy();
  await page.getByTestId("wizard-fp-confirm").check();
  await page.screenshot({ path: path.join(SHOTS, "02-wizard-tls.png") });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-test-ok")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-name").fill("ui-added-alpha");
  await page.getByTestId("wizard-create").click();
  const api = await adminApi();
  await eventually(async () => (await api.get("/api/servers")).some((s: any) => s.name === "ui-added-alpha" && s.state?.ok));
  const s = (await api.get("/api/servers")).find((x: any) => x.name === "ui-added-alpha");
  expect(s.tlsMode).toBe("pin");
  expect(s.tlsFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  await api.del(`/api/servers/${s.id}`);
  expect(errors).toEqual([]);
});

test("create a Virtual Hub and a user through the UI", async ({ page }) => {
  const errors = trackErrors(page);
  const id = await alphaId();
  await uiLogin(page);
  await page.goto(`/servers/${id}/hubs`);
  await page.getByRole("button", { name: "Create hub" }).click();
  await page.getByLabel("Hub name").fill("UIHUB");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/servers/${id}/hubs/UIHUB`));
  await eventually(async () => (await seRpc(ALPHA.port, "", "EnumHub")).HubList.some((h: any) => h.HubName_str === "UIHUB"));

  await page.goto(`/servers/${id}/hubs/UIHUB/users`);
  await page.getByTestId("create-user").click();
  await page.getByTestId("user-name").fill("ui-user");
  await page.getByTestId("user-realname").fill("UI Created");
  await page.getByRole("tab", { name: /Authentication/ }).click();
  await page.getByTestId("user-password").fill("Ui-User-Passw0rd!");
  await page.getByTestId("user-password2").fill("Ui-User-Passw0rd!");
  await page.getByTestId("user-save").click();
  const u = await eventually(async () => seRpc(ALPHA.port, "", "GetUser", { HubName_str: "UIHUB", Name_str: "ui-user" }).catch(() => null));
  expect(u.Realname_utf).toBe("UI Created");
  const { softEtherPasswordHash } = await import("../../apps/server/src/deploy/vpnfile.ts");
  expect(u.HashedKey_bin).toBe(softEtherPasswordHash("ui-user", "Ui-User-Passw0rd!").toString("base64"));
  await expect(page.getByTestId("users-table")).toContainText("ui-user");
  await page.screenshot({ path: path.join(SHOTS, "03-hub-users.png"), fullPage: true });

  await page.goto(`/servers/${id}/hubs/UIHUB/securenat`);
  await page.getByTestId("securenat-enable").click();
  await page.getByRole("dialog").getByRole("button", { name: "Enable" }).click();
  await eventually(async () => (await seRpc(ALPHA.port, "", "GetHubStatus", { HubName_str: "UIHUB" })).SecureNATEnabled_bool);
  await page.screenshot({ path: path.join(SHOTS, "04-securenat.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("API console runs any method", async ({ page }) => {
  const errors = trackErrors(page);
  const id = await alphaId();
  await uiLogin(page);
  await page.goto(`/servers/${id}/console?method=GetServerInfo`);
  await page.getByTestId("console-execute").click();
  await expect(page.getByTestId("console-result")).toContainText("SoftEther VPN Server");
  await page.screenshot({ path: path.join(SHOTS, "05-console.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("audit log shows UI actions", async ({ page }) => {
  await uiLogin(page);
  await page.goto("/admin/audit");
  await expect(page.getByTestId("audit-table")).toContainText("rpc.CreateUser");
  await page.screenshot({ path: path.join(SHOTS, "06-audit.png"), fullPage: true });
});

test("every page renders without runtime errors", async ({ page }) => {
  test.setTimeout(240_000);
  const id = await alphaId();
  await uiLogin(page);
  const serverSections = ["", "hubs", "connections", "listeners", "bridges", "l3", "ddns", "protocols", "ipsec", "wireguard",
    "certificate", "security", "cluster", "settings", "logs", "config", "license", "caps", "console"];
  const hubSections = ["", "settings", "options", "message", "users", "groups", "radius", "certs", "sessions", "tables",
    "access", "acl", "cascades", "securenat", "logging", "deploy"];
  const top = ["/", "/servers", "/deploy/hubs", "/deploy/templates", "/deploy/profiles", "/deploy/packages", "/deploy/installers", "/admin/users", "/admin/audit", "/admin/settings", "/account"];
  const routes = [
    ...top,
    ...serverSections.map((s) => `/servers/${id}${s ? "/" + s : ""}`),
    ...hubSections.map((s) => `/servers/${id}/hubs/HQ${s ? "/" + s : ""}`),
  ];
  const failures: string[] = [];
  for (const r of routes) {
    const errors = trackErrors(page);
    await page.goto(r);
    await page.waitForLoadState("networkidle");
    // An unhandled React error unmounts the tree; check that the app shell is still there
    const shell = await page.getByTestId("user-menu").isVisible();
    const name = r.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
    await page.screenshot({ path: path.join(SHOTS, "pages", `${name}.png`), fullPage: true });
    if (!shell || errors.length) failures.push(`${r}: ${shell ? "" : "app shell missing; "}${errors.join(" | ")}`);
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
  }
  expect(failures).toEqual([]);
});
