// MSI builder for silent SoftEther VPN Client deployment (msitools `wixl`, WiX v3 schema subset).
//
// Design (see docs/research/client-deployment.md §6):
//  * The MSI owns the client files (vpnsetup.exe has no silent mode), installs the client service,
//    and the UI-helper Run key the service uses to install the virtual NIC driver.
//  * A deferred, no-impersonate (SYSTEM) custom action runs configure.ps1 after StartServices:
//    start the UI helper, wait for the client RPC, NicCreate, import the .vpn profile(s), set
//    startup, connect, stop the helper. Wrapped in a timeout so a hidden driver dialog can't hang msiexec.
//  * Uninstall runs unconfigure.ps1 before StopServices (remove accounts + NIC, runtime files).
//  * Optional install-time credentials: public properties VPNUSERNAME / VPNPASSWORD (hidden from logs
//    via MsiHiddenProperties), handed to the script through a short-lived HKLM value it deletes.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { peVersion } from "./payload.ts";
import { config } from "../config.ts";

const run = promisify(execFile);

export const msiOptionsSchema = z.object({
  productName: z.string().trim().min(1).max(100).default("SoftEther VPN Client (Managed)"),
  manufacturer: z.string().trim().min(1).max(100).default("IT Department"),
  productVersion: z.string()
    .regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(\d{1,5})(\.\d{1,5})?$/, "Version must be major.minor.build (major/minor 0-255)")
    .refine((v) => Number(v.split(".")[2]) <= 65535, "Build number must be at most 65535")
    .default("1.0.0"),
  /** Keep constant across versions of the same installer so upgrades replace older builds. */
  upgradeCode: z.string().uuid().optional(),
  installFolder: z.string().trim().min(1).max(100).regex(/^[^\\/:*?"<>|]+$/).default("SoftEther VPN Client Managed"),
  connectAfterInstall: z.boolean().default(true),
  deleteProfileAfterImport: z.boolean().default(true),
  startMenuShortcut: z.boolean().default(true),
  /** Register the UI helper to run at logon (needed for later NIC changes and cert prompts). */
  uiHelperAtLogon: z.boolean().default(true),
  /** How the user credential gets onto the machine. */
  credentialMode: z.enum(["embedded", "install-time", "none"]).default("embedded"),
  /** Protect the local client configuration with a password so users can't alter/remove the profile. */
  clientConfigPassword: z.string().max(255)
    .refine((v) => v === v.trim() && !/["\x00-\x1f]/.test(v) && !v.startsWith("/") && !v.endsWith("\\"),
      "Must not contain double quotes or control characters, start with '/', end with '\\', or have leading/trailing spaces")
    .optional(),
  /** Keep the account on product upgrades (skip unconfigure when UPGRADINGPRODUCTCODE is set). */
  preserveOnUpgrade: z.boolean().default(true),
  configureTimeoutSec: z.number().int().min(30).max(1800).default(300),
  nicName: z.string().regex(/^VPN([1-9]|[1-9]\d|1[01]\d|12[0-7])?$/).default("VPN"),
  // ---- branding (Add/Remove Programs, Start menu, service) ----
  arpHelpLink: z.string().max(500).default(""),
  arpUrlInfoAbout: z.string().max(500).default(""),
  arpContact: z.string().max(200).default(""),
  arpHelpTelephone: z.string().max(50).default(""),
  arpComments: z.string().max(500).default(""),
  startMenuFolder: z.string().max(100).default(""),
  shortcutName: z.string().max(100).default("SoftEther VPN Client Manager"),
  serviceDisplayName: z.string().max(200).default(""),
  serviceDescription: z.string().max(500).default(""),
});
export type MsiOptions = z.infer<typeof msiOptionsSchema>;

export interface MsiProfile {
  accountName: string;
  fileName: string;     // e.g. "profile1.vpn"
  content: string;      // .vpn text
  startup: boolean;
  authType: string;     // for install-time credentials: standard|radius
}

export interface MsiBuildInput {
  options: MsiOptions;
  /** .ico contents for Add/Remove Programs and the Start-menu shortcut */
  icon?: Buffer | null;
  edition: "dev" | "stable";
  arch: "x64" | "x86" | "arm64";
  payload: { name: string; path: string }[];
  profiles: MsiProfile[];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/**
 * PowerShell single-quoted literal. PowerShell treats U+2018..U+201B as single quotes too, so every
 * one of them must be doubled, or a crafted account name could close the string and inject code.
 */
export const ps = (s: string) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

/** Deterministic GUID from a seed so component GUIDs stay stable between builds of one product. */
function seededGuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex").toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function editionInfo(edition: "dev" | "stable") {
  return edition === "dev"
    ? { service: "SEVPNCLIENTDEV", serviceDisplay: "SoftEther VPN Client Developer Edition", helperRun: "SoftEther VPN Client UI Helper Developer Edition", regCompany: "SoftEther VPN Developer Edition" }
    : { service: "SEVPNCLIENT", serviceDisplay: "SoftEther VPN Client", helperRun: "SoftEther VPN Client UI Helper", regCompany: "SoftEther Project" };
}

export function renderConfigureScript(input: MsiBuildInput): string {
  const o = input.options;
  const accounts = input.profiles.map((p) => `@{ Name = ${ps(p.accountName)}; File = ${ps(p.fileName)}; Startup = $${p.startup}; Auth = ${ps(p.authType)} }`).join(",\n  ");
  return `# Generated by SoftEther Manager. Runs as SYSTEM from a deferred MSI custom action.
param([Parameter(Mandatory=$true)][string]$Dir)
$ErrorActionPreference = 'Stop'
$LogDir = Join-Path $env:ProgramData 'SoftEtherManager'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'configure.log'
function Log([string]$m) { Add-Content -Path $Log -Value ("{0:u} {1}" -f (Get-Date), $m) }

$Accounts = @(
  ${accounts}
)
$Nic = ${ps(o.nicName)}
$Connect = $${o.connectAfterInstall}
$DeleteProfiles = $${o.deleteProfileAfterImport}
$CredKey = 'HKLM:\\SOFTWARE\\SoftEtherManager\\PendingCredential'
$TimeoutSec = ${o.configureTimeoutSec}

$job = Start-Job -ArgumentList $Dir, $Accounts, $Nic, $Connect, $DeleteProfiles, $CredKey, $Log -ScriptBlock {
  param($Dir, $Accounts, $Nic, $Connect, $DeleteProfiles, $CredKey, $Log)
  function Log([string]$m) { Add-Content -Path $Log -Value ("{0:u} {1}" -f (Get-Date), $m) }
  $vpncmd = Join-Path $Dir 'vpncmd.exe'
  foreach ($f in @('vpncmd.exe', 'vpnclient.exe', 'hamcore.se2')) {
    if (-not (Test-Path (Join-Path $Dir $f))) { Log "$f is missing from $Dir"; return 2 }
  }
  function Vc([string[]]$argv, [switch]$Quiet) {
    $all = @('localhost', '/CLIENT', '/CMD') + $argv
    $out = & $vpncmd @all 2>&1 | Out-String
    $rc = $LASTEXITCODE
    if (-not $Quiet) { Log ("vpncmd {0} -> {1}" -f $argv[0], $rc) }
    return $rc
  }
  # The client service delegates virtual NIC driver installation to the UI helper on TCP 9984.
  $helper = Start-Process -FilePath (Join-Path $Dir 'vpnclient.exe') -ArgumentList '/uihelp' -PassThru -WindowStyle Hidden
  try {
    $ready = $false
    for ($i = 0; $i -lt 90 -and -not $ready; $i++) { if ((Vc @('VersionGet') -Quiet) -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 } }
    if (-not $ready) { Log 'Client service did not answer on localhost:9931'; return 1 }
    Start-Sleep -Seconds 3
    $rc = Vc @('NicCreate', $Nic)
    if ($rc -ne 0 -and $rc -ne 30) { Log "NicCreate failed ($rc)"; return $rc }
    $cred = $null
    if (Test-Path $CredKey) {
      $cred = Get-ItemProperty -Path $CredKey
      Remove-Item -Path $CredKey -Recurse -Force
      # vpncmd re-parses its command line: double quotes, a leading '/' or a trailing backslash cannot be passed safely
      foreach ($v in @($cred.Username, $cred.Password)) {
        if ($v -and ($v.Contains('"') -or $v.StartsWith('/') -or $v.EndsWith('\'))) { Log 'VPNUSERNAME/VPNPASSWORD contain characters that cannot be passed to vpncmd (" or leading / or trailing \)'; return 87 }
      }
    }
    foreach ($a in $Accounts) {
      Vc @('AccountDisconnect', $a.Name) -Quiet | Out-Null
      Vc @('AccountDelete', $a.Name) -Quiet | Out-Null
      $file = Join-Path $Dir $a.File
      $rc = Vc @('AccountImport', $file)
      if ($rc -ne 0) { Log "AccountImport failed for $($a.Name) ($rc)"; return $rc }
      if ($cred -and $cred.Username) {
        Vc @('AccountUsernameSet', $a.Name, "/USERNAME:$($cred.Username)") | Out-Null
      }
      if ($cred -and $cred.Password) {
        $type = if ($a.Auth -eq 'radius') { 'radius' } else { 'standard' }
        $rc = Vc @('AccountPasswordSet', $a.Name, "/PASSWORD:$($cred.Password)", "/TYPE:$type")
        if ($rc -ne 0) { Log "AccountPasswordSet failed for $($a.Name) ($rc)" }
      }
      if ($a.Startup) { Vc @('AccountStartupSet', $a.Name) | Out-Null }
      if ($DeleteProfiles) { Remove-Item -Path $file -Force -ErrorAction SilentlyContinue }
    }
    if ($Connect) {
      foreach ($a in $Accounts) { if ($a.Startup) { Vc @('AccountConnect', $a.Name) | Out-Null } }
    }
${o.clientConfigPassword ? "    $cfgPw = (Get-Content -Raw -Path (Join-Path $Dir 'client-admin.txt')).TrimEnd([char]13, [char]10)\n    Remove-Item -Path (Join-Path $Dir 'client-admin.txt') -Force -ErrorAction SilentlyContinue\n    Vc @('PasswordSet', $cfgPw, '/REMOTEONLY:no') | Out-Null\n" : ""}    return 0
  } finally {
    if ($helper -and -not $helper.HasExited) { Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue }
  }
}
if (Wait-Job -Job $job -Timeout $TimeoutSec) {
  $jobErrors = @()
  $rc = Receive-Job -Job $job -ErrorAction SilentlyContinue -ErrorVariable jobErrors | Select-Object -Last 1
  foreach ($e in $jobErrors) { Log "error: $e" }
  if ($jobErrors.Count -gt 0 -and -not ($rc -is [int])) { $rc = 1 }
  Log "configure finished rc=$rc"
  if ($rc -is [int] -and $rc -ne 0) { exit $rc }
  exit 0
} else {
  Stop-Job -Job $job
  Get-Process -Name vpndrvinst -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='vpnclient.exe'" | Where-Object { $_.CommandLine -like '*/uihelp*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Log "configure timed out after $TimeoutSec s"
  exit 1460
}
`;
}

export function renderUnconfigureScript(input: MsiBuildInput): string {
  const e = editionInfo(input.edition);
  const names = input.profiles.map((p) => ps(p.accountName)).join(", ");
  return `# Generated by SoftEther Manager. Runs as SYSTEM before StopServices on uninstall.
param([Parameter(Mandatory=$true)][string]$Dir)
$ErrorActionPreference = 'Continue'
$LogDir = Join-Path $env:ProgramData 'SoftEtherManager'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'unconfigure.log'
function Log([string]$m) { Add-Content -Path $Log -Value ("{0:u} {1}" -f (Get-Date), $m) }
$vpncmd = Join-Path $Dir 'vpncmd.exe'
$job = Start-Job -ArgumentList $vpncmd, $Dir -ScriptBlock {
  param($vpncmd, $Dir)
  $helper = Start-Process -FilePath (Join-Path $Dir 'vpnclient.exe') -ArgumentList '/uihelp' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  foreach ($n in @(${names})) {
    & $vpncmd localhost /CLIENT /CMD AccountDisconnect $n | Out-Null
    & $vpncmd localhost /CLIENT /CMD AccountDelete $n | Out-Null
  }
  & $vpncmd localhost /CLIENT /CMD NicDelete ${ps(input.options.nicName)} | Out-Null
  if ($helper -and -not $helper.HasExited) { Stop-Process -Id $helper.Id -Force }
}
if (-not (Wait-Job -Job $job -Timeout 120)) { Stop-Job -Job $job; Log 'unconfigure timed out' }
# Runtime files created by the client service (not owned by the MSI)
foreach ($f in @('vpn_client.config', 'lang.config', 'client-admin.txt')) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Dir $f) }
foreach ($d in @('backup.vpn_client.config', 'client_log', 'packet_log', 'security_log')) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Dir $d) }
# vpncmd copies itself to System32 on first elevated run (Command.c)
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:SystemRoot 'System32\\vpncmd.exe')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${ps(`HKLM:\\SOFTWARE\\${e.regCompany}\\VPN Command Line Utility`)}
Log 'unconfigure finished'
exit 0
`;
}

export function renderWxs(input: MsiBuildInput, upgradeCode: string): string {
  const o = input.options;
  const e = editionInfo(input.edition);
  const win64 = input.arch === "x86" ? "no" : "yes";
  const pf = input.arch === "x86" ? "ProgramFilesFolder" : "ProgramFiles64Folder";
  const g = (k: string) => seededGuid(`${upgradeCode}:${k}`);
  const fileId = (n: string) => n.replace(/[^A-Za-z0-9_.]/g, "_");
  const payloadComponents = input.payload.filter((f) => f.name !== "vpnclient.exe").map((f) => `
          <Component Id="C_${fileId(f.name)}" Guid="${g(f.name)}" Win64="${win64}">
            <File Id="${fileId(f.name)}" Name="${xml(f.name)}" Source="${xml(f.path)}" KeyPath="yes"/>
          </Component>`).join("");
  const client = input.payload.find((f) => f.name === "vpnclient.exe")!;
  const profileFiles = input.profiles.map((p) => `
            <File Id="${fileId(p.fileName)}" Name="${xml(p.fileName)}" Source="${xml(p.fileName)}"/>`).join("");
  const unconfigureCond = o.preserveOnUpgrade ? `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE` : `REMOVE="ALL"`;
  const credComponent = o.credentialMode === "install-time" ? `
          <Component Id="C_Cred" Guid="${g("cred")}" Win64="${win64}">
            <RegistryValue Id="RegCredUser" Root="HKLM" Key="SOFTWARE\\SoftEtherManager\\PendingCredential" Name="Username" Type="string" Value="[VPNUSERNAME]" KeyPath="yes"/>
            <RegistryValue Id="RegCredPassword" Root="HKLM" Key="SOFTWARE\\SoftEtherManager\\PendingCredential" Name="Password" Type="string" Value="[VPNPASSWORD]"/>
          </Component>` : "";
  const shortcut = o.startMenuShortcut && input.payload.some((f) => f.name === "vpncmgr.exe") ? `
    <DirectoryRef Id="ProgramMenuDir">
      <Component Id="C_Shortcut" Guid="${g("shortcut")}" Win64="${win64}">
        <Shortcut Id="CmgrShortcut" Name="${xml(o.shortcutName || "SoftEther VPN Client Manager")}" Target="[INSTALLDIR]vpncmgr.exe" WorkingDirectory="INSTALLDIR"${input.icon ? ` Icon="ProductIcon.ico"` : ""}/>
        <RemoveFolder Id="ProgramMenuDir" On="uninstall"/>
        <RegistryValue Root="HKLM" Key="SOFTWARE\\SoftEtherManager\\${xml(o.installFolder)}" Name="shortcut" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>` : "";
  const arpProps: [string, string][] = [
    ["ARPHELPLINK", o.arpHelpLink], ["ARPURLINFOABOUT", o.arpUrlInfoAbout], ["ARPCONTACT", o.arpContact],
    ["ARPHELPTELEPHONE", o.arpHelpTelephone], ["ARPCOMMENTS", o.arpComments],
  ];
  const arp = arpProps.filter(([, v]) => v).map(([k, v]) => `
    <Property Id="${k}" Value="${xml(v)}"/>`).join("");
  const iconXml = input.icon ? `
    <Icon Id="ProductIcon.ico" SourceFile="product.ico"/>
    <Property Id="ARPPRODUCTICON" Value="ProductIcon.ico"/>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by SoftEther Manager -->
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${xml(o.productName)}" Language="1033" Version="${o.productVersion}"
           Manufacturer="${xml(o.manufacturer)}" UpgradeCode="${upgradeCode}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"
             Description="${xml(o.productName)}" Comments="SoftEther VPN Client ${input.edition === "dev" ? "Developer Edition" : "Stable"} with preconfigured connection settings"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed."/>
    <Media Id="1" Cabinet="payload.cab" EmbedCab="yes"/>

    <Property Id="ARPNOMODIFY" Value="1"/>
    <Property Id="ARPNOREPAIR" Value="1"/>${arp}${iconXml}
    <Property Id="MsiHiddenProperties" Value="VPNPASSWORD"/>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="${pf}">
        <Directory Id="INSTALLDIR" Name="${xml(o.installFolder)}">
          <Component Id="C_Client" Guid="${g("vpnclient")}" Win64="${win64}">
            <File Id="vpnclient.exe" Name="vpnclient.exe" Source="${xml(client.path)}" KeyPath="yes"/>
            <ServiceInstall Id="SvcInstall" Name="${e.service}" DisplayName="${xml(o.serviceDisplayName || e.serviceDisplay)}"
                            Description="${xml(o.serviceDescription || "SoftEther VPN Client service (managed installation)")}"
                            Type="ownProcess" Start="auto" ErrorControl="normal" Arguments="/service"/>
            <ServiceControl Id="SvcControl" Name="${e.service}" Start="install" Stop="both" Remove="uninstall" Wait="yes"/>${o.uiHelperAtLogon ? `
            <RegistryValue Root="HKLM" Key="SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" Name="${xml(e.helperRun)}"
                           Type="string" Value="&quot;[INSTALLDIR]vpnclient.exe&quot; /uihelp"/>` : ""}
          </Component>${payloadComponents}
          <Component Id="C_Config" Guid="${g("config")}" Win64="${win64}">
            <File Id="configure.ps1" Name="configure.ps1" Source="configure.ps1" KeyPath="yes"/>
            <File Id="unconfigure.ps1" Name="unconfigure.ps1" Source="unconfigure.ps1"/>${profileFiles}${o.clientConfigPassword ? `
            <File Id="client_admin.txt" Name="client-admin.txt" Source="client-admin.txt"/>` : ""}
          </Component>${credComponent}
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ProgramMenuDir" Name="${xml(o.startMenuFolder || o.productName)}"/>
      </Directory>
    </Directory>${shortcut}

    <Feature Id="Main" Title="VPN Client" Level="1">
      <ComponentRef Id="C_Client"/>${input.payload.filter((f) => f.name !== "vpnclient.exe").map((f) => `
      <ComponentRef Id="C_${fileId(f.name)}"/>`).join("")}
      <ComponentRef Id="C_Config"/>${credComponent ? `
      <ComponentRef Id="C_Cred"/>` : ""}${shortcut ? `
      <ComponentRef Id="C_Shortcut"/>` : ""}
    </Feature>

    <CustomAction Id="SetPSEXE" Property="PSEXE" Value="[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe"/>
    <CustomAction Id="ConfigureVpn" Property="PSEXE" Execute="deferred" Impersonate="no" Return="check"
                  ExeCommand="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;[#configure.ps1]&quot; -Dir &quot;[INSTALLDIR].&quot;"/>
    <CustomAction Id="UnconfigureVpn" Property="PSEXE" Execute="deferred" Impersonate="no" Return="ignore"
                  ExeCommand="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;[#unconfigure.ps1]&quot; -Dir &quot;[INSTALLDIR].&quot;"/>

    <InstallExecuteSequence>
      <Custom Action="SetPSEXE" After="CostFinalize"/>
      <!-- explicit sequence: wixl mis-resolves Before="StopServices" to a slot before InstallInitialize -->
      <Custom Action="UnconfigureVpn" Sequence="1850">${xml(unconfigureCond)}</Custom>
      <Custom Action="ConfigureVpn" After="StartServices">NOT REMOVE="ALL"</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
`;
}

export interface MsiBuildResult {
  msiPath: string;
  size: number;
  sha256: string;
  log: string;
  wxs: string;
  tables: Record<string, string>;
  productCode: string | null;
}

/** msiinfo / msibuild live next to wixl (all part of msitools). */
function siblingTool(name: string) {
  return config.wixlPath.includes("/") ? path.join(path.dirname(config.wixlPath), name) : name;
}

async function wixlVersion(): Promise<string> {
  const r = await run(config.wixlPath, ["--version"]);
  return r.stdout.trim();
}

export async function msitoolsAvailable(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    return { ok: true, version: await wixlVersion() };
  } catch (e) {
    return { ok: false, error: `wixl not found (${(e as Error).message}). Install msitools: brew install msitools / apt install wixl` };
  }
}

/** Build the MSI in a temp dir and return the finished file (moved into outDir). */
export async function buildMsi(input: MsiBuildInput, outDir: string, outName: string): Promise<MsiBuildResult> {
  const upgradeCode = (input.options.upgradeCode ?? randomUUID()).toUpperCase();
  const work = await mkdtemp(path.join(os.tmpdir(), "sem-msi-"));
  const logLines: string[] = [];
  try {
    for (const p of input.profiles) await writeFile(path.join(work, p.fileName), p.content, "utf8");
    await writeFile(path.join(work, "configure.ps1"), "﻿" + renderConfigureScript(input), "utf8");
    await writeFile(path.join(work, "unconfigure.ps1"), "﻿" + renderUnconfigureScript(input), "utf8");
    if (input.options.clientConfigPassword) await writeFile(path.join(work, "client-admin.txt"), input.options.clientConfigPassword, "utf8");
    if (input.icon) await writeFile(path.join(work, "product.ico"), input.icon);
    const payloadLocal: { name: string; path: string }[] = [];
    await mkdir(path.join(work, "payload"));
    for (const f of input.payload) {
      const dst = path.join(work, "payload", f.name);
      await copyFile(f.path, dst);
      payloadLocal.push({ name: f.name, path: path.join("payload", f.name) });
    }
    const wxs = renderWxs({ ...input, payload: payloadLocal }, upgradeCode);
    await writeFile(path.join(work, "product.wxs"), wxs, "utf8");
    const archArg = input.arch === "x86" ? "x86" : "x64";
    logLines.push(`$ wixl -a ${archArg} -o product.msi product.wxs   (${await wixlVersion()})`);
    const r = await run(config.wixlPath, ["-a", archArg, "-o", "product.msi", "product.wxs"], { cwd: work, maxBuffer: 16 * 1024 * 1024 });
    if (r.stdout.trim()) logLines.push(r.stdout.trim());
    if (r.stderr.trim()) logLines.push(r.stderr.trim());
    const msi = path.join(work, "product.msi");
    // wixl ignores Property/@Secure; mark the install-time credential properties secure so they are
    // passed to the elevated (server-side) install when set on the msiexec command line.
    const msibuild = siblingTool("msibuild");
    await run(msibuild, [msi, "-q",
      "UPDATE `Property` SET `Value` = 'WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED;VPNUSERNAME;VPNPASSWORD' WHERE `Property` = 'SecureCustomProperties'"]);
    logLines.push("$ msibuild product.msi -q UPDATE Property SecureCustomProperties += VPNUSERNAME;VPNPASSWORD");
    // wixl leaves File.Version empty. Windows Installer then treats the already-installed executables as
    // "higher versioned" during a major upgrade, skips them, and RemoveExistingProducts deletes them with the
    // old product: the upgrade ends with no client files. Record the real PE file versions.
    for (const f of input.payload) {
      const version = peVersion(await readFile(f.path));
      if (!version) continue;
      const id = f.name.replace(/[^A-Za-z0-9_.]/g, "_");
      await run(msibuild, [msi, "-q", `UPDATE \`File\` SET \`Version\` = '${version}', \`Language\` = '0' WHERE \`File\` = '${id}'`]);
      logLines.push(`$ msibuild product.msi -q UPDATE File SET Version = ${version} WHERE File = ${id}`);
    }
    if (input.options.credentialMode === "install-time") {
      // The pending-credential key would inherit HKLM\SOFTWARE's ACL (Users: read). LockPermissions
      // replaces it with SYSTEM + Administrators only, before the value is written.
      const GENERIC_ALL = 268435456;
      const rows = ["RegCredUser", "RegCredPassword"].flatMap((id) => [
        `${id}\tRegistry\t\tSYSTEM\t${GENERIC_ALL}`, `${id}\tRegistry\t\tAdministrators\t${GENERIC_ALL}`,
      ]);
      const idt = ["LockObject\tTable\tDomain\tUser\tPermission", "s72\ts32\tS255\ts255\tI4", "LockPermissions\tLockObject\tTable\tDomain\tUser", ...rows].join("\r\n") + "\r\n";
      await writeFile(path.join(work, "LockPermissions.idt"), idt, "latin1");
      await run(msibuild, [msi, "-i", path.join(work, "LockPermissions.idt")]);
      logLines.push("$ msibuild product.msi -i LockPermissions.idt   (credential registry key: SYSTEM + Administrators only)");
    }
    // Verify the result with msiinfo (part of msitools)
    const tables: Record<string, string> = {};
    const msiinfoBin = siblingTool("msiinfo");
    for (const t of ["File", "Component", "ServiceInstall", "ServiceControl", "CustomAction", "InstallExecuteSequence", "Registry", "LockPermissions", "Shortcut", "Icon", "Property"]) {
      try {
        tables[t] = (await run(msiinfoBin, ["export", msi, t], { maxBuffer: 16 * 1024 * 1024 })).stdout;
      } catch (e) {
        tables[t] = `(not present: ${(e as Error).message.split("\n")[0]})`;
      }
    }
    const summary = await run(msiinfoBin, ["suminfo", msi]).then((x) => x.stdout).catch(() => "");
    logLines.push("", "Summary information:", summary.trim());
    await mkdir(outDir, { recursive: true });
    const dest = path.join(outDir, outName);
    await copyFile(msi, dest);
    const data = await readFile(dest);
    const productCode = /^ProductCode\t(\{[0-9A-F-]+\})/m.exec(tables.Property ?? "")?.[1] ?? null;
    return {
      msiPath: dest, size: (await stat(dest)).size, sha256: createHash("sha256").update(data).digest("hex"),
      log: logLines.join("\n"), wxs, tables, productCode,
    };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`MSI build failed: ${err.stderr?.trim() || err.message}\n${logLines.join("\n")}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
