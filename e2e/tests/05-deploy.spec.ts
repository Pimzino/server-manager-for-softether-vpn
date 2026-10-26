// Client deployment: a hub profile .vpn saved through the (stubbed) native Save dialog and imported into the real
// SoftEther VPN Client, a client package added from a placeholder ZIP through the (stubbed) Open dialog, and an MSI
// built from it and inspected with msitools.
//
// SAFETY: the client package fixture is a ZIP of NON-executable placeholder files (plain text, no "MZ" header)
// plus the real hamcore.se2. No official installer is downloaded, no Windows binary is extracted, no setup.exe
// is built. SFX extraction and the setup.exe wrapper are therefore not verified on this machine.
import { test, expect, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildZip, closeApp, csv, csvMap, inspectMsi, launchApp, openSection, openServer, route, serverId, sh, sha256, sheet, shot, stubOpenDialog,
  stubSaveDialog, vpncmdClient, type App,
} from "../helpers.ts";
import { CLIENT_DIR, OUTPUTS, RUN_DIR, SE_BUILD, SERVER_A } from "../env.ts";

// Not serial: a failure must not skip the remaining checks (the worker restarts and beforeAll relaunches the app).
test.describe.configure({ mode: "default" });
let a: App;
let page: Page;

test.beforeAll(async () => { a = await launchApp(); page = a.page; });
test.afterAll(async ({}, ti) => { await closeApp(a, ti); });
test.afterEach(async ({}, ti) => { if (ti.status !== ti.expectedStatus) await shot(page, `FAILED-${ti.title}`, ti).catch(() => undefined); });

async function openHubDeploy() {
  const A = serverId("A");
  await openServer(page, A);
  await openSection(page, "hubs");
  await page.getByTestId("hub-row-HQ").dblclick();
  await expect.poll(() => route(page)).toBe(`/servers/${A}/hubs/HQ`);
  await openSection(page, "deploy");
  await expect(page.getByTestId("deploy-users-table")).toBeVisible({ timeout: 30_000 });
}

/** Build from the hub deploy page (per-user or hub-wide menu), then save through the stubbed Save dialog. */
async function buildAndSave(user: string | null, kind: "vpn" | "msi", dest: string) {
  const id = user ?? "hub";
  if (user) await page.getByTestId(`deploy-user-${user}`).getByTestId(`build-${id}`).click();
  else await page.getByTestId(`build-${id}`).click();
  await page.getByTestId(`build-${kind}-${id}`).click();
  const s = sheet(page, "build-result-sheet");
  await expect(s).toBeVisible({ timeout: 120_000 });
  rmSync(dest, { force: true });
  await stubSaveDialog(a.app, dest);
  // A click that lands while the sheet is still sliding in can be lost: click again until the save is confirmed
  const saved = s.getByTestId("build-result-saved");
  await expect(async () => {
    if (!(await saved.isVisible())) await s.getByTestId("build-result-download").click({ timeout: 5_000 });
    await expect(saved).toContainText(path.basename(dest), { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  expect(existsSync(dest)).toBe(true);
  return s;
}

/** Import a .vpn into the real SoftEther VPN Client and return AccountGet (CSV map). */
async function importIntoClient(vpnFile: string, localName: string) {
  const text = readFileSync(vpnFile, "utf8");
  const account = /string AccountName (\S+)/.exec(text)![1].replace(/\$([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // vpncmd on macOS treats arguments starting with "/" as switches: copy next to vpncmd and pass a relative path.
  copyFileSync(vpnFile, path.join(CLIENT_DIR, localName));
  await vpncmdClient("AccountDelete", account);
  const imp = await vpncmdClient("AccountImport", localName);
  expect(imp.code, imp.out).toBe(0);
  const list = csv((await vpncmdClient("AccountList")).out);
  expect(list.some((r) => r[0] === account), JSON.stringify(list)).toBe(true);
  const get = await vpncmdClient("AccountGet", account);
  expect(get.code, get.out).toBe(0);
  writeFileSync(path.join(OUTPUTS, `${localName}.client-accountget.txt`), get.out);
  return { account, props: csvMap(get.out) };
}

test("per-user and hub-wide .vpn profiles are saved and accepted by the real SoftEther VPN Client", async ({}, ti) => {
  mkdirSync(OUTPUTS, { recursive: true });
  await openHubDeploy();
  await shot(page, "hub-deploy", ti);
  // Per-user: bob, password hash embedded (template default "embed-hash")
  const bobFile = path.join(OUTPUTS, "HQ-bob.vpn");
  let s = await buildAndSave("bob", "vpn", bobFile);
  await shot(page, "vpn-built-bob", ti);
  await s.getByRole("button", { name: "Done" }).click();
  const bobText = readFileSync(bobFile, "utf8");
  expect(bobText).toMatch(/string Username bob/);
  expect(bobText).toMatch(/byte HashedPassword \S{20,}/);
  const bob = await importIntoClient(bobFile, "HQ-bob.vpn");
  expect(bob.props["Destination VPN Server Host Name"]).toBe("127.0.0.1");
  expect(bob.props["Destination VPN Server Port Number"]).toBe(String(SERVER_A.port));
  expect(bob.props["Destination VPN Server Virtual Hub Name"]).toBe("HQ");
  expect(bob.props["User Name"]).toBe("bob");
  expect(bob.props["User Authentication Type"] ?? bob.props["Authentication Type"] ?? "").toMatch(/Password/i);
  await vpncmdClient("AccountDelete", bob.account);
  // Hub-wide profile (the user types name and password in the client)
  const hubFile = path.join(OUTPUTS, "HQ-hub.vpn");
  s = await buildAndSave(null, "vpn", hubFile);
  await s.getByRole("button", { name: "Done" }).click();
  const hub = await importIntoClient(hubFile, "HQ-hub.vpn");
  expect(hub.props["Destination VPN Server Virtual Hub Name"]).toBe("HQ");
  await vpncmdClient("AccountDelete", hub.account);
});

test("client package from a placeholder ZIP (stubbed Open dialog)", async ({}, ti) => {
  const hamcore = readFileSync(path.join(SE_BUILD, "hamcore.se2"));
  const placeholder = (n: string) => Buffer.from(`PLACEHOLDER for ${n} - Server Manager for SoftEther VPN E2E fixture, not an executable\n`, "utf8");
  const zip = buildZip([
    { name: "vpnclient.exe", data: placeholder("vpnclient.exe") },
    { name: "vpncmd.exe", data: placeholder("vpncmd.exe") },
    { name: "vpncmgr.exe", data: placeholder("vpncmgr.exe") },
    { name: "hamcore.se2", data: hamcore },
  ]);
  const fixture = path.join(RUN_DIR, "client-package-placeholder.zip");
  writeFileSync(fixture, zip);
  writeFileSync(path.join(OUTPUTS, "client-package-fixture.txt"),
    `client-package-placeholder.zip sha256=${sha256(fixture)} bytes=${zip.length}\n` +
    "entries: vpnclient.exe, vpncmd.exe, vpncmgr.exe (plain-text placeholders, no MZ header), hamcore.se2 (real, " +
    `sha256=${sha256(path.join(SE_BUILD, "hamcore.se2"))})\n`);
  await page.getByTestId("sidebar-deploy").click();
  await openSection(page, "packages");
  await page.getByTestId("upload-package").click();
  const s = sheet(page, "package-upload");
  await expect(s).toBeVisible();
  await stubOpenDialog(a.app, fixture);
  await s.getByTestId("package-upload-submit").click();
  await expect(s).toBeHidden({ timeout: 60_000 });
  const row = page.locator("[data-testid^=package-]").filter({ hasText: "client-package-placeholder.zip" }).first();
  await expect(row).toBeVisible();
  await row.dblclick();
  const files = page.getByTestId("package-files");
  await expect(files).toContainText("vpnclient.exe");
  await expect(files).toContainText("vpncmd.exe");
  await expect(files).toContainText("hamcore.se2");
  await shot(page, "client-package", ti);
});

test("MSI built from the placeholder package: msiinfo tables and msiextract file list", async ({}, ti) => {
  await openHubDeploy();
  await expect(page.getByTestId("deploy-no-msi")).toHaveCount(0);
  const msi = path.join(OUTPUTS, "HQ-bob.msi");
  const s = await buildAndSave("bob", "msi", msi);
  await shot(page, "msi-built", ti);
  await s.getByRole("button", { name: "Done" }).click();
  expect(readFileSync(msi).subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1"); // OLE compound file
  const info = await inspectMsi(msi);
  writeFileSync(path.join(OUTPUTS, "HQ-bob.msi.tables.txt"), info.tables.join("\n"));
  for (const t of ["File", "Component", "Directory", "Feature", "CustomAction", "InstallExecuteSequence", "Property"]) expect(info.tables).toContain(t);
  writeFileSync(path.join(OUTPUTS, "HQ-bob.msi.suminfo.txt"), `${info.summary}\n\n${Object.entries(info.properties).map(([k, v]) => `${k}\t${v}`).join("\n")}`);
  expect(info.properties.ProductName).toBe("HQ VPN");
  expect(info.properties.ProductVersion).toMatch(/^1\.0\.\d+$/);
  writeFileSync(path.join(OUTPUTS, "HQ-bob.msi.files.txt"), info.files.join("\n"));
  for (const f of ["vpnclient.exe", "vpncmd.exe", "hamcore.se2", "configure.ps1"]) expect(info.files, info.files.join("\n")).toContain(f);
  expect(info.files.some((n) => n.endsWith(".vpn")), info.files.join("\n")).toBe(true);
  // The MSI is listed on the MSI Installers page
  await page.getByTestId("sidebar-deploy").click();
  await openSection(page, "installers");
  await expect(page.getByTestId("installers-table")).toContainText(/HQ\/bob\s*MSI\s*1\.0\.\d+/);
  await shot(page, "installers-page", ti);
});
