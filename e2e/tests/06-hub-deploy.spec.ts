// Live per-hub / per-user deployment with templates and branding, verified against the real
// SoftEther server, the real SoftEther client (for .vpn files) and msitools / PE parsing (packages).
import { test, expect } from "@playwright/test";
import { uiLogin } from "../helpers.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Api, adminApi, eventually, seRpc, sh, vpncmdClient } from "../helpers.ts";
import { ARTIFACTS, BASE_URL, CLIENT_DIR, ROOT, RUN_DIR, SERVERS, SE_BUILD } from "../env.ts";

test.describe.configure({ mode: "serial" });
const [ALPHA] = SERVERS;
const OUT = path.join(ARTIFACTS, "hub-deploy");
let alpha = 0;
let templateId = 0;
let packageId = 0;

async function download(api: Api, id: number) {
  const r = await fetch(`${BASE_URL}/api/deploy/installers/${id}/download`, { headers: { cookie: api.cookie } });
  expect(r.status).toBe(200);
  return { data: Buffer.from(await r.arrayBuffer()), name: /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "" };
}

test("every hub and every user has a live profile — new users appear with no action", async () => {
  mkdirSync(OUT, { recursive: true });
  const api = await adminApi();
  alpha = (await api.get("/api/servers")).find((s: any) => s.name === ALPHA.name).id;
  const hubs = await api.get("/api/deploy/hubs");
  const live = (await seRpc(ALPHA.port, "", "EnumHub")).HubList.map((h: any) => h.HubName_str).sort();
  expect(hubs.filter((h: any) => h.serverId === alpha).map((h: any) => h.hub).sort()).toEqual(live);
  const dep = hubs.find((h: any) => h.serverId === alpha && h.hub === "DEPLOY");
  expect(dep.template.name).toBe("Default");
  expect(dep.accountName).toBe("DEPLOY VPN");

  await api.rpc(alpha, "CreateUser", { HubName_str: "DEPLOY", Name_str: "newstarter", AuthType_u32: 1, Auth_Password_str: "Starter-Passw0rd!" });
  await api.rpc(alpha, "CreateUser", { HubName_str: "DEPLOY", Name_str: "certuser", AuthType_u32: 3, CommonName_utf: "certuser" });
  const detail = await api.get(`/api/deploy/hubs/${alpha}/DEPLOY`);
  const names = detail.users.map((u: any) => u.name);
  expect(names).toEqual(expect.arrayContaining(["laptop01", "newstarter", "certuser"]));
  expect(detail.users.find((u: any) => u.name === "newstarter")).toMatchObject({ deployable: true, credential: "embed-hash" });
  expect(detail.users.find((u: any) => u.name === "certuser")).toMatchObject({ deployable: false });
});

test("default template: per-user .vpn embeds the user's hash and the real client imports it", async () => {
  const api = await adminApi();
  const built = await api.post(`/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "newstarter", kind: "vpn" }, 201);
  expect(built.credential).toBe("embed-hash");
  const { data, name } = await download(api, built.id);
  expect(name).toBe("DEPLOY_VPN-newstarter.vpn");
  const hash = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "newstarter" })).HashedKey_bin;
  expect(data.toString()).toContain(`byte HashedPassword ${hash}`);
  writeFileSync(path.join(CLIENT_DIR, "newstarter.vpn"), data);
  await vpncmdClient("AccountDelete", "DEPLOY VPN");
  expect((await vpncmdClient("AccountImport", "newstarter.vpn")).code).toBe(0);
  const acct = await vpncmdClient("AccountGet", "DEPLOY VPN");
  expect(acct.out).toMatch(/User Name\s*\|newstarter/);
  // Certificate users are refused with an explanation
  const cert = await api.call("POST", `/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "certuser", kind: "vpn" });
  expect(cert.status).toBe(422);
});

test("templates: branded template with rotate policy; hub override for the public endpoint", async () => {
  const api = await adminApi();
  // Package with a real hamcore.se2 and real PE binaries so branding can be exercised end to end
  const sfx = path.join(RUN_DIR, "branded-client.exe");
  await sh("python3", [path.join(ROOT, "e2e/fixtures/make-fake-sfx.py"), sfx, "--hamcore", path.join(SE_BUILD, "hamcore.se2"), "--pe", path.join(ROOT, "apps/server/assets/setup-stub-x64.exe")]);
  const fd = new FormData();
  fd.append("arch", "x64");
  fd.append("file", new Blob([readFileSync(sfx)]), "softether-vpnclient-5.02.5188.x64.exe");
  const up = await fetch(`${BASE_URL}/api/deploy/packages`, { method: "POST", body: fd, headers: { cookie: api.cookie, "x-sem-csrf": "1" } });
  expect(up.status).toBe(201);
  packageId = (await up.json()).id;

  const icon = readFileSync(path.join(ROOT, "tools/setup-stub/default.ico")).toString("base64");
  const t = await api.post("/api/deploy/templates", {
    name: "Contoso", description: "Branded", settings: {
      connection: { accountNamePattern: "Contoso {hub}", maxConnection: 2 },
      credentials: { passwordUsers: "rotate", rotateLength: 24 },
      installer: { productName: "Contoso VPN", manufacturer: "Contoso Ltd", baseVersion: "3.1", installFolder: "Contoso VPN", packageId, clientConfigPassword: "lock-it" },
      branding: {
        iconIco: icon, arpHelpLink: "https://help.contoso.test", arpUrlInfoAbout: "https://contoso.test", arpContact: "IT Service Desk",
        arpHelpTelephone: "+44 20 7946 0000", arpComments: "Managed by Contoso IT", startMenuFolder: "Contoso", shortcutName: "Contoso VPN",
        serviceDisplayName: "Contoso VPN Service", serviceDescription: "Contoso secure connectivity",
      },
      setupExe: { companyName: "Contoso Ltd", productName: "Contoso VPN", fileDescription: "Contoso VPN Setup", copyright: "(c) Contoso", fileNamePattern: "contoso-{user}" },
      client: { brandBinaries: true, displayName: "Contoso VPN", managerName: "Contoso VPN Manager", stringOverrides: { CM_PRODUCT_NAME: "Contoso VPN Build %u" } },
    },
  }, 201);
  templateId = t.id;
  expect(t.settings.installer.clientConfigPassword).toBe("********");
  const hp = await api.put(`/api/deploy/hubs/${alpha}/DEPLOY`, { templateId, publicHost: "vpn.contoso.test", publicPort: 443, accountName: null });
  expect(hp).toMatchObject({ host: "vpn.contoso.test", port: 443, accountName: "Contoso DEPLOY", template: { name: "Contoso" } });
  const preview = await api.get(`/api/deploy/hubs/${alpha}/DEPLOY/preview?user=laptop01`);
  expect(preview.credential).toBe("rotate (on build)");
  expect(preview.content).toContain("string Hostname vpn.contoso.test");
  // Preview never rotates
  const before = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  expect((await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin).toBe(before);
});

test("rotate policy: new password set on the server, embedded, shown once", async () => {
  const api = await adminApi();
  const before = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  const built = await api.post(`/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "laptop01", kind: "vpn" }, 201);
  expect(built.issuedPassword).toHaveLength(24);
  const after = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  expect(after).not.toBe(before);
  const { softEtherPasswordHash } = await import("../../apps/server/src/deploy/vpnfile.ts");
  expect(after).toBe(softEtherPasswordHash("laptop01", built.issuedPassword).toString("base64"));
  const { data } = await download(api, built.id);
  expect(data.toString()).toContain(`byte HashedPassword ${after}`);
  // The password is never stored or listed again
  const hub = await api.get(`/api/deploy/hubs/${alpha}/DEPLOY`);
  expect(JSON.stringify(hub)).not.toContain(built.issuedPassword);
  const audit = await api.get("/api/audit?action=deploy.rotate_password");
  expect(audit.total).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(audit.rows)).not.toContain(built.issuedPassword);
});

test("branded MSI: ARP details, icon, shortcut, service and client branding inside", async () => {
  const api = await adminApi();
  const built = await api.post(`/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "newstarter", kind: "msi" }, 201);
  expect(built.productVersion).toMatch(/^3\.1\.\d+$/);
  const { data, name } = await download(api, built.id);
  expect(name).toBe(`contoso-newstarter-${built.productVersion}.msi`);
  const msi = path.join(OUT, name);
  writeFileSync(msi, data);
  const props = await sh("msiinfo", ["export", msi, "Property"]);
  for (const [k, v] of [["ARPHELPLINK", "https://help.contoso.test"], ["ARPURLINFOABOUT", "https://contoso.test"], ["ARPCONTACT", "IT Service Desk"],
    ["ARPHELPTELEPHONE", "+44 20 7946 0000"], ["ARPCOMMENTS", "Managed by Contoso IT"], ["ARPPRODUCTICON", "ProductIcon.ico"], ["ProductName", "Contoso VPN"], ["Manufacturer", "Contoso Ltd"]]) {
    expect(props).toContain(`${k}\t${v}`);
  }
  expect(await sh("msiinfo", ["export", msi, "Icon"])).toContain("ProductIcon.ico");
  expect(await sh("msiinfo", ["export", msi, "ServiceInstall"])).toContain("Contoso VPN Service");
  const sc = await sh("msiinfo", ["export", msi, "Shortcut"]);
  expect(sc).toMatch(/Contoso VPN\tC_Shortcut\t\[INSTALLDIR\]vpncmgr\.exe/);
  expect(await sh("msiinfo", ["export", msi, "Directory"])).toMatch(/ProgramMenuDir\tProgramMenuFolder\tContoso/);

  const dir = path.join(OUT, "msi-extract");
  mkdirSync(dir, { recursive: true });
  await sh("msiextract", ["-C", dir, msi]);
  const find = async (n: string) => (await sh("find", [dir, "-name", n, "!", "-name", "._*"])).trim().split("\n")[0];
  const { readPeInfo, hamcoreString } = await import("../../apps/server/src/deploy/branding.ts");
  const client = readPeInfo(readFileSync(await find("vpnclient.exe")));
  expect(client.strings).toMatchObject({ CompanyName: "Contoso Ltd", ProductName: "Contoso VPN", FileDescription: "Contoso VPN" });
  expect(readPeInfo(readFileSync(await find("vpncmgr.exe"))).strings.FileDescription).toBe("Contoso VPN Manager");
  const ham = readFileSync(await find("hamcore.se2"));
  expect(hamcoreString(ham, "PRODUCT_NAME_VPN_CLI")).toBe("Contoso VPN");
  expect(hamcoreString(ham, "CM_TITLE")).toBe("Contoso VPN Manager");
  expect(hamcoreString(ham, "CM_PRODUCT_NAME")).toBe("Contoso VPN Build %u");
  // The real SoftEther tools still load the rewritten hamcore.se2 (vpncmd reads its strings from it)
  const probe = path.join(RUN_DIR, "hamcore-probe");
  mkdirSync(probe, { recursive: true });
  for (const f of ["vpncmd", "libcedar.dylib", "libmayaqua.dylib", "libcedar.so", "libmayaqua.so"]) {
    try { writeFileSync(path.join(probe, f), readFileSync(path.join(SE_BUILD, f)), { mode: 0o755 }); } catch { /* not on this OS */ }
  }
  writeFileSync(path.join(probe, "hamcore.se2"), ham);
  const about = await sh("sh", ["-c", `cd "${probe}" && DYLD_LIBRARY_PATH=. LD_LIBRARY_PATH=. ./vpncmd localhost /TOOLS /CMD about`]);
  expect(about).toContain("SoftEther VPN Command Line Management Utility (vpncmd command)");
  // Rotate policy + MSI: the new credential is embedded
  const prof = readFileSync(await find("profile1.vpn"), "utf8");
  const hash = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "newstarter" })).HashedKey_bin;
  expect(prof).toContain(`byte HashedPassword ${hash}`);
  expect(prof).toContain("string Hostname vpn.contoso.test");
  expect(built.issuedPassword).toBeTruthy();
  writeFileSync(path.join(OUT, "msi-build-log.txt"), built.log);
});

test("branded setup.exe wraps the MSI with icon, version info and uninstall support", async () => {
  const api = await adminApi();
  const first = (await api.get(`/api/deploy/hubs/${alpha}/DEPLOY`)).builds.find((b: any) => b.kind === "msi");
  const built = await api.post(`/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "newstarter", kind: "exe" }, 201);
  expect(Number(built.productVersion.split(".")[2])).toBeGreaterThan(Number(first.productVersion.split(".")[2]));
  const { data, name } = await download(api, built.id);
  expect(name).toBe(`contoso-newstarter-${built.productVersion}.exe`);
  writeFileSync(path.join(OUT, name), data);
  expect(await sh("file", [path.join(OUT, name)])).toContain("PE32+ executable (GUI) x86-64");
  const { readPeInfo, readRcdata } = await import("../../apps/server/src/deploy/branding.ts");
  const info = readPeInfo(data);
  expect(info.strings).toMatchObject({ CompanyName: "Contoso Ltd", ProductName: "Contoso VPN", FileDescription: "Contoso VPN Setup", LegalCopyright: "(c) Contoso" });
  expect(info.fileVersion).toBe(`${built.productVersion}.0`);
  expect(info.iconGroups).toBe(1);
  const payload = readRcdata(data, "PAYLOAD")!;
  expect(payload.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
  const msi = path.join(OUT, "from-exe.msi");
  writeFileSync(msi, payload);
  const props = await sh("msiinfo", ["export", msi, "Property"]);
  const productCode = /ProductCode\t(\{[0-9A-F-]+\})/.exec(props)![1];
  const cfg = readRcdata(data, "CONFIG")!.toString();
  expect(cfg).toContain(`productCode=${productCode}`);
  expect(cfg).toContain("title=Contoso VPN");
  expect(cfg).toContain("ui=basic");
});

test("hub package permissions follow hub grants", async () => {
  const api = await adminApi();
  const viewer = await new Api().login("zz_viewer", "Viewer-Passw0rd!");
  expect((await viewer.call("POST", `/api/deploy/hubs/${alpha}/DEPLOY/packages`, { user: "newstarter", kind: "vpn" })).status).toBe(403);
  const hd = await new Api().login("zz_helpdesk", "Helpdesk-Passw0rd!");
  expect((await hd.call("GET", `/api/deploy/hubs/${alpha}/DEPLOY`)).status).toBe(404);
  // Helpdesk operator on RBAC_A: default template embeds hashes, which needs server admin -> clear error
  const denied = await hd.call("POST", `/api/deploy/hubs/${alpha}/RBAC_A/packages`, { user: "hd_user", kind: "vpn" });
  expect(denied.status).toBe(403);
  expect(denied.body.error).toMatch(/admin role/);
  // Switch that hub to a prompt-policy template: helpdesk can now issue packages
  const prompt = await api.post("/api/deploy/templates", { name: "Prompt", settings: { credentials: { passwordUsers: "prompt" } } }, 201);
  await api.put(`/api/deploy/hubs/${alpha}/RBAC_A`, { templateId: prompt.id, publicHost: null, publicPort: null, accountName: null });
  const ok = await hd.post(`/api/deploy/hubs/${alpha}/RBAC_A/packages`, { user: "hd_user", kind: "vpn" }, 201);
  const { data } = await download(hd, ok.id);
  expect(data.toString()).toContain("byte HashedPassword $");
  // ...but cannot download another hub's packages
  const other = (await api.get(`/api/deploy/hubs/${alpha}/DEPLOY`)).builds[0];
  expect((await fetch(`${BASE_URL}/api/deploy/installers/${other.id}/download`, { headers: { cookie: hd.cookie } })).status).toBe(403);
  await eventually(async () => true);
});

test("UI: hub deployment page builds a user package, shows the new password once, downloads", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await uiLogin(page);
  await page.goto("/deploy/hubs");
  await expect(page.getByTestId("hub-profiles-table")).toContainText("vpn.contoso.test:443");
  await page.screenshot({ path: path.join(ARTIFACTS, "screenshots", "07-hub-profiles.png"), fullPage: true });
  await page.goto(`/servers/${alpha}/hubs/DEPLOY/deploy`);
  await expect(page.getByTestId("deploy-users-table")).toContainText("newstarter");
  // "Last package" shows when it was built
  await expect(page.getByTestId("deploy-users-table")).toContainText(/setup\.exe · (a few seconds|a minute|\d+ minutes) ago/);
  await page.screenshot({ path: path.join(ARTIFACTS, "screenshots", "08-hub-deploy.png"), fullPage: true });
  const before = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "newstarter" })).HashedKey_bin;
  await page.getByTestId("build-newstarter").click();
  await page.getByTestId("build-vpn-newstarter").click();
  await expect(page.getByTestId("issued-password")).toBeVisible();
  const shown = (await page.getByTestId("issued-password").locator("code").textContent())!.trim();
  const { softEtherPasswordHash } = await import("../../apps/server/src/deploy/vpnfile.ts");
  const after = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "newstarter" })).HashedKey_bin;
  expect(after).not.toBe(before);
  expect(after).toBe(softEtherPasswordHash("newstarter", shown).toString("base64"));
  await page.getByTestId("build-result").screenshot({ path: path.join(ARTIFACTS, "screenshots", "09-issued-password.png") });
  const dl = page.waitForEvent("download");
  await page.getByTestId("build-result-download").click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^Contoso_DEPLOY-newstarter\.vpn$/);
  await page.goto("/deploy/templates");
  await expect(page.getByTestId("templates-table")).toContainText("Contoso");
  await page.getByText("Contoso", { exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: /Edit template: Contoso/ })).toBeVisible();
  await page.getByRole("tab", { name: "Client branding" }).click();
  await expect(page.getByTestId("tpl-client-name")).toHaveValue("Contoso VPN");
  await page.screenshot({ path: path.join(ARTIFACTS, "screenshots", "10-template-editor.png") });
  expect(errors).toEqual([]);
});
