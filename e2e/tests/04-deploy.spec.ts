// Client deployment: package ingestion (SFX extraction), .vpn profile generation verified by the
// real SoftEther VPN Client, and MSI build verified structurally with msitools.
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { adminApi, seRpc, sh, vpncmdClient } from "../helpers.ts";
import { ARTIFACTS, BASE_URL, CLIENT_DIR, ROOT, RUN_DIR, SERVERS } from "../env.ts";

test.describe.configure({ mode: "serial" });
const OUT = path.join(ARTIFACTS, "deploy");
const [ALPHA] = SERVERS;
let packageId = 0;
let profileId = 0;

test("upload official-format SFX installer: payload extracted and normalised", async () => {
  mkdirSync(OUT, { recursive: true });
  const sfx = path.join(RUN_DIR, "softether-vpnclient-5.02.5188.x64.exe");
  await sh("python3", [path.join(ROOT, "e2e/fixtures/make-fake-sfx.py"), sfx, "5.2.5188.0"]);
  const api = await adminApi();
  const fd = new FormData();
  fd.append("arch", "x64");
  fd.append("file", new Blob([readFileSync(sfx)]), path.basename(sfx));
  const res = await fetch(`${BASE_URL}/api/deploy/packages`, { method: "POST", body: fd, headers: { cookie: api.cookie, "x-sem-csrf": "1" } });
  const pkg = await res.json();
  expect(res.status, JSON.stringify(pkg)).toBe(201);
  expect(pkg.edition).toBe("dev");
  expect(pkg.version).toBe("5.2.5188.0");
  expect(pkg.files.map((f: any) => f.name).sort()).toEqual(["hamcore.se2", "vpnclient.exe", "vpncmd.exe", "vpncmgr.exe"]);
  packageId = pkg.id;

  // A random file is rejected with a helpful error
  const fd2 = new FormData();
  fd2.append("file", new Blob([Buffer.from("not an installer")]), "junk.bin");
  const bad = await fetch(`${BASE_URL}/api/deploy/packages`, { method: "POST", body: fd2, headers: { cookie: api.cookie, "x-sem-csrf": "1" } });
  expect(bad.status).toBe(400);
});

test("profile from managed server: pinned cert + user's stored hash; real client imports it", async () => {
  const api = await adminApi();
  const alpha = (await api.get("/api/servers")).find((s: any) => s.name === ALPHA.name).id;
  await api.rpc(alpha, "CreateHub", { HubName_str: "DEPLOY", Online_bool: true }).catch(() => undefined);
  await api.rpc(alpha, "CreateUser", { HubName_str: "DEPLOY", Name_str: "laptop01", AuthType_u32: 1, Auth_Password_str: "Laptop-Passw0rd!" });
  const pre = await api.post("/api/deploy/from-server", { serverId: alpha, hub: "DEPLOY", username: "laptop01", pinCertificate: true, includeUserHash: true });
  expect(pre.serverCertPem).toContain("BEGIN CERTIFICATE");
  expect(pre.authType).toBe("password");
  const serverHash = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  expect(pre.hashedPassword).toBe(serverHash);

  const settings = {
    accountName: "Corp VPN", host: pre.host, port: pre.port, hub: pre.hub, authType: "password", username: "laptop01",
    hashedPassword: pre.hashedPassword, serverCertPem: pre.serverCertPem, checkServerCert: true, startup: true, maxConnection: 4,
  };
  const created = await api.post("/api/deploy/profiles", { name: "e2e-corp", description: "E2E", settings }, 201);
  profileId = created.id;
  const listed = (await api.get("/api/deploy/profiles")).find((p: any) => p.id === profileId);
  expect(listed.settings.hashedPassword).toBe("********"); // secrets never returned

  const vpn = await api.call("GET", `/api/deploy/profiles/${profileId}/vpn`);
  expect(vpn.status).toBe(200);
  writeFileSync(path.join(OUT, "Corp_VPN.vpn"), vpn.text);
  // vpncmd treats arguments starting with "/" as switches: use a path relative to the client dir
  writeFileSync(path.join(CLIENT_DIR, "Corp_VPN.vpn"), vpn.text);
  const file = "Corp_VPN.vpn";
  expect(vpn.text).toContain(`byte HashedPassword ${serverHash}`);
  expect(vpn.text).toContain("string AccountName Corp$20VPN");

  // Ground truth: the real SoftEther VPN Client accepts the file
  await vpncmdClient("AccountDelete", "Corp VPN");
  const imp = await vpncmdClient("AccountImport", file);
  expect(imp.code, imp.out).toBe(0);
  const acct = await vpncmdClient("AccountGet", "Corp VPN");
  expect(acct.code).toBe(0);
  expect(acct.out).toMatch(/Destination VPN Server Port Number\s*\|15601/);
  expect(acct.out).toMatch(/Destination VPN Server Virtual Hub Name\s*\|DEPLOY/);
  expect(acct.out).toMatch(/Verify Server Certificate\s*\|Enable/);
  expect(acct.out).toMatch(/User Name\s*\|laptop01/);
  expect(acct.out).toMatch(/Number of TCP Connections to Use in VPN Communication\|4/);
  // Round-trip: client's own export keeps the same hash and pinned certificate
  const ex = await vpncmdClient("AccountExport", "Corp VPN", "/SAVEPATH:Corp_VPN.client-export.vpn");
  expect(ex.code, ex.out).toBe(0);
  const exText = readFileSync(path.join(CLIENT_DIR, "Corp_VPN.client-export.vpn"), "utf8");
  expect(exText).toContain(`byte HashedPassword ${serverHash}`);
  expect(exText).toMatch(/byte ServerCert \S{100,}/);
  writeFileSync(path.join(OUT, "Corp_VPN.client-export.vpn"), exText);
  writeFileSync(path.join(OUT, "client-accountget.txt"), acct.out);
});

test("MSI build: embedded credentials, verified tables and payload", async () => {
  const api = await adminApi();
  const build = await api.post("/api/deploy/installers", {
    name: "e2e-corp-vpn", packageId, profileIds: [profileId],
    options: {
      productName: "Corp VPN Client", manufacturer: "E2E Corp", productVersion: "1.2.3", credentialMode: "embedded",
      installFolder: "Corp VPN", clientConfigPassword: "lock-it-down",
    },
  }, 201);
  expect(build.status, build.log).toBe("ready");
  expect(build.options.clientConfigPassword).toBeUndefined();
  const dl = await fetch(`${BASE_URL}/api/deploy/installers/${build.id}/download`, { headers: { cookie: api.cookie } });
  expect(dl.status).toBe(200);
  const msi = path.join(OUT, "Corp_VPN_Client-1.2.3.msi");
  writeFileSync(msi, Buffer.from(await dl.arrayBuffer()));
  expect(readFileSync(msi).subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1"); // OLE compound file

  const custom = await sh("msiinfo", ["export", msi, "CustomAction"]);
  expect(custom).toMatch(/ConfigureVpn\t3122\tPSEXE/);
  expect(custom).toMatch(/UnconfigureVpn\t3186\tPSEXE/);
  const seq = await sh("msiinfo", ["export", msi, "InstallExecuteSequence"]);
  const seqOf = (a: string) => Number(seq.split("\n").find((l) => l.startsWith(a + "\t"))!.split("\t").pop());
  expect(seqOf("ConfigureVpn")).toBeGreaterThan(seqOf("StartServices"));
  expect(seqOf("ConfigureVpn")).toBeLessThan(seqOf("InstallFinalize"));
  expect(seqOf("UnconfigureVpn")).toBeGreaterThan(seqOf("InstallInitialize"));
  expect(seqOf("UnconfigureVpn")).toBeLessThan(seqOf("StopServices"));
  const svc = await sh("msiinfo", ["export", msi, "ServiceInstall"]);
  expect(svc).toMatch(/SEVPNCLIENTDEV\tSoftEther VPN Client Developer Edition\t16\t2/);
  const props = await sh("msiinfo", ["export", msi, "Property"]);
  expect(props).toMatch(/ProductVersion\t1\.2\.3/);
  expect(props).toMatch(/SecureCustomProperties\t.*VPNUSERNAME;VPNPASSWORD/);
  const summary = await sh("msiinfo", ["suminfo", msi]);
  expect(summary).toContain("Template: x64;1033");

  const extractDir = path.join(OUT, "msi-extract");
  mkdirSync(extractDir, { recursive: true });
  await sh("msiextract", ["-C", extractDir, msi]);
  const files = (await sh("find", [extractDir, "-type", "f"])).trim().split("\n").map((f) => path.basename(f)).filter((f) => !f.startsWith("._")).sort();
  expect(files).toEqual(["client-admin.txt", "configure.ps1", "hamcore.se2", "profile1.vpn", "unconfigure.ps1", "vpnclient.exe", "vpncmd.exe", "vpncmgr.exe"].sort());
  const found = (await sh("find", [extractDir, "-name", "configure.ps1"])).trim();
  const ps1 = readFileSync(found, "utf8");
  expect(ps1).toContain("'Corp VPN'");
  expect(ps1).toContain("NicCreate");
  expect(ps1).toContain("/uihelp");
  const prof = readFileSync((await sh("find", [extractDir, "-name", "profile1.vpn"])).trim(), "utf8");
  expect(prof).toContain("string DeviceName VPN");
  writeFileSync(path.join(OUT, "build-log.txt"), build.log);

  // Parse the generated PowerShell with the real PowerShell language parser (tools/ps-lint, .NET)
  const dotnet = [process.env.DOTNET ?? "", path.join(homedir(), ".dotnet/dotnet"), "/usr/local/share/dotnet/dotnet", "/usr/bin/dotnet"].find((d) => d && existsSync(d));
  test.skip(!dotnet, "dotnet SDK not available for the PowerShell syntax check");
  const toolDir = path.join(RUN_DIR, "pslint");
  await sh(dotnet!, ["build", path.join(ROOT, "tools/ps-lint/pslint.csproj"), "-c", "Release", "-o", toolDir, "-v", "q"]);
  const scripts = (await sh("find", [extractDir, "-name", "*.ps1", "!", "-name", "._*"])).trim().split("\n");
  const lint = await sh(dotnet!, [path.join(toolDir, "pslint.dll"), ...scripts]);
  writeFileSync(path.join(OUT, "powershell-parse.txt"), lint);
  expect(lint).not.toContain("FAIL");
  expect(lint.match(/^OK /gm)?.length).toBe(2);
});

test("MSI build: install-time credentials leave no secret in the package", async () => {
  const api = await adminApi();
  const build = await api.post("/api/deploy/installers", {
    name: "e2e-install-time", packageId, profileIds: [profileId],
    options: { productVersion: "2.0.0", credentialMode: "install-time" },
  }, 201);
  expect(build.status, build.log).toBe("ready");
  const dl = await fetch(`${BASE_URL}/api/deploy/installers/${build.id}/download`, { headers: { cookie: api.cookie } });
  const msi = path.join(OUT, "install-time-2.0.0.msi");
  writeFileSync(msi, Buffer.from(await dl.arrayBuffer()));
  const reg = await sh("msiinfo", ["export", msi, "Registry"]);
  expect(reg).toContain("SOFTWARE\\SoftEtherManager\\PendingCredential\tPassword\t[VPNPASSWORD]");
  const dir = path.join(OUT, "msi-extract-install-time");
  mkdirSync(dir, { recursive: true });
  await sh("msiextract", ["-C", dir, msi]);
  const prof = readFileSync((await sh("find", [dir, "-name", "profile1.vpn"])).trim(), "utf8");
  const serverHash0 = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  expect(prof).not.toContain(serverHash0);
  const none = await api.post("/api/deploy/installers", { name: "e2e-none", packageId, profileIds: [profileId], options: { productVersion: "3.0.0", credentialMode: "none" } }, 201);
  const dl2 = await fetch(`${BASE_URL}/api/deploy/installers/${none.id}/download`, { headers: { cookie: api.cookie } });
  const msi2 = path.join(OUT, "none-3.0.0.msi");
  writeFileSync(msi2, Buffer.from(await dl2.arrayBuffer()));
  const dir2 = path.join(OUT, "msi-extract-none");
  mkdirSync(dir2, { recursive: true });
  await sh("msiextract", ["-C", dir2, msi2]);
  const prof2 = readFileSync((await sh("find", [dir2, "-name", "profile1.vpn"])).trim(), "utf8");
  const serverHash = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "DEPLOY", Name_str: "laptop01" })).HashedKey_bin;
  expect(prof2).not.toContain(serverHash);
  // Upgrade code is reused for rebuilds of the same installer name
  const again = await api.post("/api/deploy/installers", { name: "e2e-corp-vpn", packageId, profileIds: [profileId], options: { productVersion: "1.2.4" } }, 201);
  const first = (await api.get("/api/deploy/installers")).find((b: any) => b.name === "e2e-corp-vpn" && b.productVersion === "1.2.3");
  expect(again.upgradeCode).toBe(first.upgradeCode);
  expect(existsSync(OUT)).toBe(true);
});

test("review regressions: unsafe account names, versions and passwords are rejected", async () => {
  const api = await adminApi();
  for (const accountName of ["x\u2019; Start-Process cmd; \u2019", 'bad"name', "/slash", "tab\tname"]) {
    const r = await api.call("POST", "/api/deploy/render", { accountName, host: "h", hub: "H", username: "u", password: "p" });
    expect(r.status, accountName).toBe(400);
  }
  const { ps } = await import("../../apps/server/src/deploy/msi.ts");
  expect(ps("a\u2019b'c")).toBe("'a\u2019\u2019b''c'");
  const base = { name: "e2e-corp-vpn", packageId, profileIds: [profileId] };
  expect((await api.call("POST", "/api/deploy/installers", { ...base, options: { productVersion: "1.2.3" } })).status).toBe(409);
  expect((await api.call("POST", "/api/deploy/installers", { ...base, options: { productVersion: "256.0.0" } })).status).toBe(400);
  expect((await api.call("POST", "/api/deploy/installers", { ...base, options: { productVersion: "9.0.0", clientConfigPassword: ' has"quote' } })).status).toBe(400);
  // Install-time credential key gets a restricted ACL
  const build = (await api.get("/api/deploy/installers")).find((b: any) => b.name === "e2e-install-time");
  expect(build.log).toContain("LockPermissions");
  expect(build.log).toMatch(/RegCredPassword\tRegistry\t\tSYSTEM\t268435456/);
});
