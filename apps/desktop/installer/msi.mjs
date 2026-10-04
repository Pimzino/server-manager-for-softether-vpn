// Windows MSI of SoftEther Manager itself, built on macOS/Linux with msitools' `wixl` (WiX 3 schema subset).
//
// Input is electron-builder's win-unpacked directory. `heat` does not exist for wixl (wixl-heat is a minimal
// stdin filter with random GUIDs), so the Directory/Component/File tree is generated here, with component GUIDs
// derived from the UpgradeCode and the file's relative path. They stay stable between builds, which keeps the
// component rules intact across versions.
//
// Product layout:
//   * per-machine install to  [ProgramFiles64Folder]SoftEther Manager\   (INSTALLDIR, can be overridden on the command line)
//   * Start-menu shortcut "SoftEther Manager" (always) and a desktop shortcut (DESKTOPSHORTCUT=1 by default, 0 to skip)
//   * Add/Remove Programs entry with the app icon (ARPPRODUCTICON), no Modify button
//   * MajorUpgrade with a fixed UpgradeCode: installing a newer (or rebuilt same-version) MSI replaces the old one
//     in place; installing an older one is refused
//   * silent:   msiexec /i SoftEther-Manager-<v>-win-x64.msi /qn [DESKTOPSHORTCUT=0] [INSTALLDIR="D:\Apps\SEM\"]
//               msiexec /x SoftEther-Manager-<v>-win-x64.msi /qn        (or /x {ProductCode})
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Never change: MajorUpgrade finds earlier installs through it. */
export const UPGRADE_CODE = "CACB4190-26D2-438C-B7C6-EBEB624B0B54";
export const MANUFACTURER = "SoftEther Manager";
export const MAIN_EXE = "SoftEther Manager.exe";
export const INSTALL_FOLDER = "SoftEther Manager";

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Deterministic RFC 4122-shaped GUID from a seed (stable component GUIDs). */
export function seededGuid(seed) {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex").toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const shortId = (prefix, rel) => `${prefix}_${createHash("sha1").update(rel.toLowerCase()).digest("hex").slice(0, 20)}`;

/** MSI ProductVersion is major.minor.build (major, minor <= 255, build <= 65535); pre-release tags are dropped. */
export function msiVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`Cannot derive an MSI version from "${version}"`);
  const [maj, min, build] = m.slice(1).map(Number);
  if (maj > 255 || min > 255 || build > 65535) throw new Error(`Version ${version} exceeds MSI limits (255.255.65535)`);
  return `${maj}.${min}.${build}`;
}

const ignored = (name) => name.startsWith("._") || name === ".DS_Store";

/**
 * Files electron-builder adds to win-unpacked for its NSIS target only (elevate.exe is the NSIS/electron-updater
 * elevation helper). They are not part of the zip and are not installed by the MSI.
 */
export const NSIS_ONLY_FILES = ["resources/elevate.exe"];
/** The files the MSI installs: win-unpacked minus NSIS-only helpers. */
export const msiPayload = (dir) => listTree(dir).filter((f) => !NSIS_ONLY_FILES.includes(f.rel));

/** Recursively list files under dir → [{ rel (posix), abs, size }] sorted by rel. */
export function listTree(dir) {
  const out = [];
  const walk = (d, relBase) => {
    for (const name of readdirSync(d).sort()) {
      if (ignored(name)) continue;
      const abs = path.join(d, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) out.push({ rel, abs, size: st.size });
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Render the .wxs for the given win-unpacked directory.
 * @param {{ sourceDir: string, version: string, productName: string, description: string, iconFile: string, arch: "x64" }} o
 */
export function renderWxs(o) {
  const files = msiPayload(o.sourceDir);
  if (!files.some((f) => f.rel === MAIN_EXE)) throw new Error(`${MAIN_EXE} not found in ${o.sourceDir}`);
  const g = (k) => seededGuid(`${UPGRADE_CODE}:${k}`);
  const win64 = o.arch === "x86" ? "no" : "yes";
  const pf = o.arch === "x86" ? "ProgramFilesFolder" : "ProgramFiles64Folder";

  // Build the directory tree
  const root = { name: "", rel: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const rel = parts.slice(0, i + 1).join("/");
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], rel, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  const componentIds = [];
  const fileId = (f) => (f.rel === MAIN_EXE ? "MainExe" : shortId("F", f.rel));
  const renderNode = (node, indent) => {
    const pad = " ".repeat(indent);
    let s = "";
    for (const f of node.files) {
      const cid = f.rel === MAIN_EXE ? "C_MainExe" : shortId("C", f.rel);
      componentIds.push(cid);
      s += `${pad}<Component Id="${cid}" Guid="${g(`file:${f.rel.toLowerCase()}`)}" Win64="${win64}">\n`;
      s += `${pad}  <File Id="${fileId(f)}" Name="${xml(path.posix.basename(f.rel))}" Source="${xml(f.abs)}" KeyPath="yes"/>\n`;
      s += `${pad}</Component>\n`;
    }
    for (const d of node.dirs.values()) {
      s += `${pad}<Directory Id="${shortId("D", d.rel)}" Name="${xml(d.name)}">\n${renderNode(d, indent + 2)}${pad}</Directory>\n`;
    }
    return s;
  };
  const tree = renderNode(root, 10);
  const regKey = `SOFTWARE\\${MANUFACTURER}\\${o.productName}`;
  const aumid = "com.softethermanager.desktop";

  const wxs = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/desktop/installer/msi.mjs from ${xml(path.basename(o.sourceDir))} (${files.length} files). Do not edit. -->
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${xml(o.productName)}" Language="1033" Version="${msiVersion(o.version)}"
           Manufacturer="${xml(MANUFACTURER)}" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"
             Description="${xml(o.productName)} ${xml(o.version)}" Comments="${xml(o.description)}" Manufacturer="${xml(MANUFACTURER)}"/>
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of [ProductName] is already installed."/>
    <Media Id="1" Cabinet="app.cab" EmbedCab="yes"/>

    <Icon Id="ProductIcon.ico" SourceFile="${xml(o.iconFile)}"/>
    <Property Id="ARPPRODUCTICON" Value="ProductIcon.ico"/>
    <Property Id="ARPNOMODIFY" Value="1"/>
    <Property Id="ARPCOMMENTS" Value="${xml(o.description)}"/>
    <Property Id="DESKTOPSHORTCUT" Value="1"/>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="${pf}">
        <Directory Id="INSTALLDIR" Name="${xml(INSTALL_FOLDER)}">
${tree}        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder"/>
      <Directory Id="DesktopFolder"/>
    </Directory>

    <DirectoryRef Id="ProgramMenuFolder">
      <Component Id="C_StartMenuShortcut" Guid="${g("shortcut:startmenu")}" Win64="${win64}">
        <Shortcut Id="StartMenuShortcut" Name="${xml(o.productName)}" Description="${xml(o.description)}"
                  Target="[#MainExe]" WorkingDirectory="INSTALLDIR"/>
        <RegistryValue Root="HKLM" Key="${xml(regKey)}" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="DesktopFolder">
      <Component Id="C_DesktopShortcut" Guid="${g("shortcut:desktop")}" Win64="${win64}">
        <Condition>DESKTOPSHORTCUT = "1"</Condition>
        <Shortcut Id="DesktopShortcut" Name="${xml(o.productName)}" Description="${xml(o.description)}"
                  Target="[#MainExe]" WorkingDirectory="INSTALLDIR"/>
        <RegistryValue Root="HKLM" Key="${xml(regKey)}" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="INSTALLDIR">
      <Component Id="C_InstallInfo" Guid="${g("registry:installinfo")}" Win64="${win64}">
        <RegistryValue Root="HKLM" Key="${xml(regKey)}" Name="InstallDir" Type="string" Value="[INSTALLDIR]" KeyPath="yes"/>
        <RegistryValue Root="HKLM" Key="${xml(regKey)}" Name="Version" Type="string" Value="${xml(o.version)}"/>
      </Component>
    </DirectoryRef>

    <Feature Id="Main" Title="${xml(o.productName)}" Level="1" Absent="disallow">
${componentIds.map((c) => `      <ComponentRef Id="${c}"/>`).join("\n")}
      <ComponentRef Id="C_StartMenuShortcut"/>
      <ComponentRef Id="C_DesktopShortcut"/>
      <ComponentRef Id="C_InstallInfo"/>
    </Feature>
  </Product>
</Wix>
`;
  return { wxs, files, aumid };
}

async function tool(bin, args, opts = {}) {
  const r = await run(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  return (r.stdout + r.stderr).trim();
}

/**
 * Build the MSI. Steps are logged to `log` (array of strings).
 * @param {{ sourceDir: string, outFile: string, workDir: string, version: string, productName: string,
 *           description: string, iconFile: string, arch?: "x64", wixl?: string, log?: string[] }} o
 */
export async function buildAppMsi(o) {
  const log = o.log ?? [];
  const wixl = o.wixl ?? process.env.WIXL ?? "wixl";
  const bindir = wixl.includes("/") ? path.dirname(wixl) : "";
  const msitool = (n) => (bindir ? path.join(bindir, n) : n);
  const arch = o.arch ?? "x64";
  mkdirSync(o.workDir, { recursive: true });
  copyFileSync(o.iconFile, path.join(o.workDir, "product.ico"));
  const { wxs, files, aumid } = renderWxs({ ...o, arch, iconFile: path.join(o.workDir, "product.ico") });
  const wxsFile = path.join(o.workDir, "SoftEtherManager.wxs");
  writeFileSync(wxsFile, wxs, "utf8");
  const msi = path.join(o.workDir, "app.msi");
  log.push(`$ wixl -a ${arch} -o app.msi SoftEtherManager.wxs   (wixl ${await tool(wixl, ["--version"])})`);
  const out = await tool(wixl, ["-a", arch, "-o", msi, wxsFile], { cwd: o.workDir });
  if (out) log.push(out);

  // Post-processing with msibuild (part of msitools):
  // 1. wixl leaves shortcuts without an AppUserModelID. Electron's notifications and taskbar grouping on Windows need
  //    the shortcut's System.AppUserModel.ID to match app.setAppUserModelId() (electron-builder's NSIS does the same).
  const idt = [
    "MsiShortcutProperty\tShortcut_\tPropertyKey\tPropVariantValue",
    "s72\ts72\ts0\ts0",
    "MsiShortcutProperty\tMsiShortcutProperty",
    `SP_StartMenuAumid\tStartMenuShortcut\t{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5\t${aumid}`,
    `SP_DesktopAumid\tDesktopShortcut\t{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5\t${aumid}`,
  ].join("\r\n") + "\r\n";
  const idtFile = path.join(o.workDir, "MsiShortcutProperty.idt");
  writeFileSync(idtFile, idt, "latin1");
  await tool(msitool("msibuild"), [msi, "-i", idtFile]);
  log.push("$ msibuild app.msi -i MsiShortcutProperty.idt   (System.AppUserModel.ID = " + aumid + " on both shortcuts)");
  // 2. DESKTOPSHORTCUT must be a secure public property so the value given on the msiexec command line reaches the
  //    elevated server-side install (wixl does not add Secure properties to SecureCustomProperties).
  const secure = (await tool(msitool("msiinfo"), ["export", msi, "Property"]))
    .split(/\r?\n/).find((l) => l.startsWith("SecureCustomProperties\t"));
  const current = secure ? secure.split("\t")[1] : "";
  const merged = [...new Set([...current.split(";").filter(Boolean), "DESKTOPSHORTCUT", "INSTALLDIR"])].join(";");
  const sql = secure
    ? `UPDATE \`Property\` SET \`Value\` = '${merged}' WHERE \`Property\` = 'SecureCustomProperties'`
    : `INSERT INTO \`Property\` (\`Property\`, \`Value\`) VALUES ('SecureCustomProperties', '${merged}')`;
  await tool(msitool("msibuild"), [msi, "-q", sql]);
  log.push(`$ msibuild app.msi -q "SecureCustomProperties = ${merged}"`);

  // (wixl already stores the cabinet MSZIP-compressed, so no recompression step is needed.)

  mkdirSync(path.dirname(o.outFile), { recursive: true });
  copyFileSync(msi, o.outFile);
  return { msi: o.outFile, wxsFile, fileCount: files.length, files, log };
}

/** Read an MSI table as rows of tab-separated columns (msiinfo export). */
export async function exportTable(msi, table, msiinfo = "msiinfo") {
  const text = await tool(msiinfo, ["export", msi, table]);
  const lines = text.split(/\r?\n/);
  return { text, columns: lines[0].split("\t"), rows: lines.slice(3).filter(Boolean).map((l) => l.split("\t")) };
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
