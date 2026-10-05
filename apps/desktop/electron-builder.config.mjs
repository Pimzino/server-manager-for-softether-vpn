// electron-builder 26.15.3 configuration for Server Manager for SoftEther VPN (macOS + Windows, all built on macOS).
//
// Normally driven by scripts/dist.mjs, which stages the app (package.json + dist/**) on the system temp volume and
// passes { appDir, outDir } here. It also works with the CLI, e.g.
//   pnpm exec electron-builder --config electron-builder.config.mjs --mac dir
// in which case the app is taken from this directory (files: dist/** + package.json only).
//
// Why a staging directory: this repository lives on an exFAT volume. exFAT has no symlinks (macOS .app bundles and
// Electron's frameworks need them, and codesign rejects bundles without them) and macOS litters it with "._*"
// AppleDouble files. So electron-builder reads a clean copy and writes to APFS; dist.mjs copies the finished
// artifacts to apps/desktop/release/.
//
// Signing:
//  * macOS: ad-hoc ("-") unless a Developer ID is supplied through CSC_LINK/CSC_KEY_PASSWORD (a .p12) or CSC_NAME
//    (a keychain identity). With a Developer ID the hardened runtime is on and the app is notarised when
//    APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or
//    APPLE_KEYCHAIN_PROFILE are set.
//  * Windows: unsigned unless WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD (a .pfx) is set; on macOS electron-builder then
//    signs with its bundled osslsigncode. See docs/desktop-packaging.md.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectDir = import.meta.dirname;
const repoRoot = path.resolve(projectDir, "../..");

export const APP_ID = "com.softethermanager.desktop";
export const PRODUCT_NAME = "Server Manager for SoftEther VPN";
/** File-name stem for artifacts (no spaces, so the names are safe in URLs and shell commands). */
export const ARTIFACT_STEM = "Server-Manager-for-SoftEther-VPN";

export function electronVersion() {
  return JSON.parse(readFileSync(path.join(repoRoot, "node_modules/electron/package.json"), "utf8")).version;
}

export function macSigningMode(env = process.env) {
  const developerId = Boolean(env.CSC_LINK || env.CSC_NAME);
  const notarize = developerId && Boolean(
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    env.APPLE_KEYCHAIN_PROFILE);
  return { developerId, notarize };
}

/**
 * @param {{ appDir?: string, outDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {import("electron-builder").Configuration}
 */
export function createConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const { developerId, notarize } = macSigningMode(env);
  const outDir = opts.outDir ?? path.join(os.tmpdir(), "sem-desktop-dist", "out");
  const year = new Date().getFullYear();

  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: `Copyright © ${year} Server Manager for SoftEther VPN contributors`,
    electronVersion: electronVersion(),
    directories: {
      ...(opts.appDir ? { app: opts.appDir } : {}),
      output: outDir,
      buildResources: path.join(projectDir, "build"),
    },
    // Only the bundled JS and the manifest. package.json has no runtime "dependencies", so nothing from
    // node_modules is shipped. Source maps and exFAT AppleDouble files are excluded.
    files: ["dist/**/*", "package.json", "!**/*.map", "!**/._*", "!**/.DS_Store"],
    extraResources: [
      { from: path.join(projectDir, "resources"), to: "resources", filter: ["**/*", "!**/._*", "!**/.DS_Store", "!**/.gitkeep"] },
    ],
    asar: true,
    compression: "normal",
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    publish: null,
    // Native arm64/x86_64 osslsigncode for Windows signing on macOS (the legacy "0.0.0" bundle is an old x86_64 build).
    toolsets: { winCodeSign: "1.1.0" },
    // Electron fuses (https://www.electronjs.org/docs/latest/tutorial/fuses). grantFileProtocolExtraPrivileges stays
    // on because the renderer is loaded from file:// (hash router). runAsNode is off: use utilityProcess, not
    // child_process.fork(process.execPath).
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },

    mac: {
      category: "public.app-category.utilities",
      icon: path.join(projectDir, "build/icon.icns"),
      target: [
        { target: "dmg", arch: ["arm64", "x64"] },
        { target: "zip", arch: ["arm64", "x64"] },
      ],
      artifactName: `${ARTIFACT_STEM}-\${version}-mac-\${arch}.\${ext}`,
      darkModeSupport: true,
      // Ad-hoc signature unless a Developer ID is configured. Ad-hoc code has no Team ID, so the hardened runtime's
      // library validation would reject Electron's own frameworks: keep it off for ad-hoc builds.
      identity: developerId ? (env.CSC_NAME || undefined) : "-",
      hardenedRuntime: developerId,
      gatekeeperAssess: false,
      entitlements: path.join(projectDir, "build/entitlements.mac.plist"),
      entitlementsInherit: path.join(projectDir, "build/entitlements.mac.inherit.plist"),
      notarize,
      extendInfo: {
        // macOS 15+ local network privacy: SoftEther servers are often on the LAN.
        NSLocalNetworkUsageDescription: "Server Manager connects to SoftEther VPN Servers on your local network to manage them.",
      },
    },
    dmg: {
      title: `${PRODUCT_NAME} \${version}`,
      icon: path.join(projectDir, "build/icon.icns"),
      background: path.join(projectDir, "build/background.png"), // + background@2x.png → HiDPI tiff
      iconSize: 96,
      window: { width: 540, height: 380 },
      contents: [
        { x: 140, y: 190, type: "file" },
        { x: 400, y: 190, type: "link", path: "/Applications" },
      ],
      format: "UDZO",
      writeUpdateInfo: false,
    },

    win: {
      icon: path.join(projectDir, "build/icon.ico"),
      target: ["dir", "zip", "nsis"],
      artifactName: `${ARTIFACT_STEM}-\${version}-win-\${arch}.\${ext}`,
      legalTrademarks: "SoftEther is a trademark of SoftEther Corporation. This product is an independent project, not affiliated with or endorsed by it.",
      requestedExecutionLevel: "asInvoker",
      signAndEditExecutable: true,
    },
    nsis: {
      artifactName: `${ARTIFACT_STEM}-\${version}-win-\${arch}-setup.\${ext}`,
      oneClick: false,
      perMachine: false, // lets the user choose "only for me" or "all users" (elevates for the latter)
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      uninstallDisplayName: PRODUCT_NAME,
      installerIcon: path.join(projectDir, "build/icon.ico"),
      uninstallerIcon: path.join(projectDir, "build/icon.ico"),
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      runAfterFinish: true,
    },
  };
}

export default createConfig({
  appDir: process.env.SEM_BUILDER_APP_DIR || undefined,
  outDir: process.env.SEM_BUILDER_OUT_DIR || undefined,
});
