// Builds the client packages that the Windows install test (tools/ci/windows-install-test.ps1) installs on
// a real Windows runner, from the OFFICIAL SoftEther VPN Client installer:
//   client-1.0.1.msi          branded MSI with an embedded credential
//   client-setup-1.0.2.exe    branded setup.exe wrapping the next version (same UpgradeCode: in-place upgrade)
//   manifest.json             what the test must assert (names, versions, product codes, branding)
//
// usage: node tools/ci/build-client-packages.ts <softether-vpnclient-x64.exe> <out dir>
// env:   CI_VPN_HOST (127.0.0.1) CI_VPN_PORT (5555) CI_VPN_HUB (CI) CI_VPN_USER (ci-user) CI_VPN_PASSWORD
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [sfxPath, outDir] = process.argv.slice(2);
if (!sfxPath || !outDir) {
  console.error("usage: build-client-packages.ts <softether-vpnclient-x64.exe> <out dir>");
  process.exit(2);
}
// The deploy modules read their settings (data dir, master key) at import time
process.env.SEM_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), "sem-ci-data-"));

const root = path.resolve(import.meta.dirname, "../..");
const { extractPayload } = await import(path.join(root, "apps/server/src/deploy/payload.ts"));
const { profileSchema, renderVpnFile } = await import(path.join(root, "apps/server/src/deploy/vpnfile.ts"));
const { buildMsi, msiOptionsSchema } = await import(path.join(root, "apps/server/src/deploy/msi.ts"));
const { applyStringOverrides, brandPe, readPeInfo, hamcoreString, CLIENT_NAME_KEYS, MANAGER_NAME_KEYS } =
  await import(path.join(root, "apps/server/src/deploy/branding.ts"));

const env = (k: string, d: string) => process.env[k] || d;
const host = env("CI_VPN_HOST", "127.0.0.1");
const port = Number(env("CI_VPN_PORT", "5555"));
const hub = env("CI_VPN_HUB", "CI");
const user = env("CI_VPN_USER", "ci-user");
const password = env("CI_VPN_PASSWORD", "Ci-User-Passw0rd!");

const BRAND = {
  productName: "Contoso VPN",
  manufacturer: "Contoso Ltd",
  installFolder: "Contoso VPN",
  accountName: "Contoso CI",
  clientDisplayName: "Contoso VPN",
  managerName: "Contoso VPN Manager",
  serviceDisplayName: "Contoso VPN Service",
  helpLink: "https://help.contoso.test",
  contact: "IT Service Desk",
  shortcutName: "Contoso VPN",
  upgradeCode: "6F3A2B10-5D7C-4E21-9B8A-0C1D2E3F4A5B",
};

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(path.join(os.tmpdir(), "sem-ci-pkg-"));

// 1. Official installer -> client payload (this is the first place the SFX extraction meets a real release binary)
const payload = extractPayload(readFileSync(sfxPath), "x64");
console.log(`payload: edition=${payload.edition} version=${payload.version} files=${payload.files.map((f: { name: string; data: Buffer }) => `${f.name}:${f.data.length}`).join(", ")}`);

// 2. Brand it the way a template would: string tables + executable icon/version details
const icon = readFileSync(path.join(root, "apps/server/assets/default.ico"));
const overrides: Record<string, string> = {};
for (const k of CLIENT_NAME_KEYS) overrides[k] = BRAND.clientDisplayName;
for (const k of MANAGER_NAME_KEYS) overrides[k] = BRAND.managerName;
const brandNotes: string[] = [];
const files: { name: string; path: string }[] = [];
const original: Record<string, unknown> = {};
for (const f of payload.files as { name: string; data: Buffer }[]) {
  let data = f.data;
  if (f.name === "hamcore.se2") {
    original.hamcoreClientName = hamcoreString(data, "PRODUCT_NAME_VPN_CLI");
    const r = applyStringOverrides(data, overrides);
    data = r.hamcore;
    brandNotes.push(`hamcore strings applied: ${r.applied.join(", ")}; missing: ${r.missing.join(", ") || "none"}`);
  }
  if (f.name === "vpnclient.exe" || f.name === "vpncmgr.exe") {
    original[f.name] = readPeInfo(data);
    data = brandPe(data, {
      icon,
      strings: {
        CompanyName: BRAND.manufacturer, ProductName: BRAND.clientDisplayName,
        FileDescription: f.name === "vpncmgr.exe" ? BRAND.managerName : BRAND.clientDisplayName,
      },
    });
    brandNotes.push(`${f.name}: branded (${data.length} bytes)`);
  }
  const p = path.join(work, f.name);
  writeFileSync(p, data);
  files.push({ name: f.name, path: p });
}
console.log(brandNotes.join("\n"));

// 3. Connection profile with the user's credential embedded (SHA-0 hash, as the hub page does)
const profile = profileSchema.parse({
  accountName: BRAND.accountName, host, port, hub, authType: "password", username: user, password,
  checkServerCert: false, startup: true, maxConnection: 2, deviceName: "VPN",
});
const vpn = renderVpnFile(profile);
writeFileSync(path.join(outDir, "profile.vpn"), vpn);

async function msi(version: string) {
  const options = msiOptionsSchema.parse({
    productName: BRAND.productName, manufacturer: BRAND.manufacturer, productVersion: version, upgradeCode: BRAND.upgradeCode,
    installFolder: BRAND.installFolder, credentialMode: "embedded", connectAfterInstall: true, startMenuShortcut: true,
    arpHelpLink: BRAND.helpLink, arpContact: BRAND.contact, arpComments: "Managed by Contoso IT", startMenuFolder: "Contoso",
    shortcutName: BRAND.shortcutName, serviceDisplayName: BRAND.serviceDisplayName, serviceDescription: "Contoso secure connectivity",
  });
  return buildMsi({
    options, icon, edition: payload.edition, arch: "x64", payload: files,
    profiles: [{ accountName: profile.accountName, fileName: "profile1.vpn", content: vpn, startup: true, authType: "standard" }],
  }, outDir, `client-${version}.msi`);
}

const v1 = await msi("1.0.1");
console.log(`MSI 1.0.1: ${v1.size} bytes, ProductCode ${v1.productCode}`);
writeFileSync(path.join(outDir, "msi-build-log.txt"), `${v1.log}\n\n${Object.entries(v1.tables).map(([t, v]) => `== ${t}\n${v}`).join("\n")}`);

// 4. setup.exe carrying version 1.0.2 (same UpgradeCode), built like the hub deployment page does
const v2 = await msi("1.0.2");
const stub = readFileSync(path.join(root, "apps/server/assets/setup-stub-x64.exe"));
const cfg = `title=${BRAND.productName}\nui=basic\nmsiName=client-1.0.2.msi\nproductCode=${v2.productCode}\n`;
const exe = brandPe(stub, {
  icon, version: "1.0.2.0",
  strings: { CompanyName: BRAND.manufacturer, ProductName: BRAND.productName, FileDescription: `${BRAND.productName} Setup`, OriginalFilename: "client-setup-1.0.2.exe", InternalName: "client-setup" },
  rcdata: { PAYLOAD: readFileSync(v2.msiPath), CONFIG: Buffer.from(cfg, "utf8") },
});
writeFileSync(path.join(outDir, "client-setup-1.0.2.exe"), exe);
console.log(`setup.exe 1.0.2: ${exe.length} bytes, ProductCode ${v2.productCode}`);

writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
  softetherClient: { file: path.basename(sfxPath), edition: payload.edition, version: payload.version },
  service: payload.edition === "dev" ? "SEVPNCLIENTDEV" : "SEVPNCLIENT",
  connection: { host, port, hub, user, accountName: BRAND.accountName, nic: "VPN" },
  brand: BRAND,
  msi: { file: "client-1.0.1.msi", version: "1.0.1", productCode: v1.productCode, sha256: v1.sha256 },
  setupExe: { file: "client-setup-1.0.2.exe", version: "1.0.2", productCode: v2.productCode },
  original,
  brandNotes,
}, null, 2));
console.log("wrote", outDir);
