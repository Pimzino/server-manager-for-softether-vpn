// Packages SoftEther Manager for macOS and Windows, entirely on a Mac, and verifies every artifact.
//
//   node scripts/dist.mjs                 build + mac (dmg, zip: arm64 + x64) + win (unpacked, zip, NSIS: x64 + arm64) + MSI (x64)
//   node scripts/dist.mjs --mac           macOS only           (pnpm run dist:mac)
//   node scripts/dist.mjs --win           Windows only + MSI   (pnpm run dist:win)
//   options: --no-build (package the existing dist/), --no-msi, --no-verify, --no-launch (skip starting the packaged app),
//            --reuse (skip electron-builder, re-use the previous output in the staging dir),
//            --mac-arch=arm64,x64   --win-arch=x64,arm64
//   env:     SEM_DIST_STAGING  staging directory on an APFS/HFS+ volume (default: $TMPDIR/sem-desktop-dist)
//            WIXL              path to wixl (default: wixl on PATH; brew install msitools)
//            signing: see electron-builder.config.mjs and docs/desktop-packaging.md
//
// Outputs in apps/desktop/release/:
//   SoftEther-Manager-<v>-mac-<arch>.dmg / .zip, SoftEther-Manager-<v>-win-<arch>.zip,
//   SoftEther-Manager-<v>-win-<arch>-setup.exe, SoftEther-Manager-<v>-win-x64.msi, win-unpacked/, win-arm64-unpacked/,
//   SHA256SUMS, BUILD-REPORT.md, verification/ (screenshots, MSI tables, generated .wxs, per-platform JSON, logs)
import { build as builderBuild, Platform, Arch } from "electron-builder";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync, readlinkSync,
  createReadStream, realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfig, APP_ID, PRODUCT_NAME, ARTIFACT_STEM, electronVersion, macSigningMode } from "../electron-builder.config.mjs";
import { buildAppMsi, exportTable, listTree, msiPayload, msiVersion, NSIS_ONLY_FILES, UPGRADE_CODE, MAIN_EXE } from "../installer/msi.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(root, "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(",").filter(Boolean) : dflt;
};
let doMac = flag("--mac"), doWin = flag("--win");
if (!doMac && !doWin) doMac = doWin = true;
const doBuild = !flag("--no-build");
const doMsi = doWin && !flag("--no-msi");
const doVerify = !flag("--no-verify");
const doLaunch = !flag("--no-launch");
// --reuse: skip electron-builder and re-use its previous output in the staging dir (for re-running the MSI/verification)
const reuse = flag("--reuse");
const macArchs = opt("mac-arch", ["arm64", "x64"]);
const winArchs = opt("win-arch", ["x64", "arm64"]);
for (const a of [...macArchs, ...winArchs]) if (!["arm64", "x64"].includes(a)) throw new Error(`Unsupported arch ${a}`);

const staging = path.resolve(process.env.SEM_DIST_STAGING ?? path.join(os.tmpdir(), "sem-desktop-dist"));
// electron-builder 26 refuses to pack files that resolve into /private, /tmp or /var unless they are under os.tmpdir()
// or the home directory, and exFAT cannot hold .app bundles: keep the staging dir under one of those, on APFS.
{
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const okRoots = [real(os.tmpdir()), real(os.homedir())];
  mkdirSync(staging, { recursive: true });
  if (!okRoots.some((r) => real(staging) === r || real(staging).startsWith(r + path.sep))) {
    throw new Error(`SEM_DIST_STAGING (${staging}) must be inside ${okRoots.join(" or ")} (electron-builder's asar safety check)`);
  }
}
const appStage = path.join(staging, "app");
const outDir = path.join(staging, "out");
const releaseDir = path.join(root, "release");
const verifyDir = path.join(releaseDir, "verification");
const wixl = process.env.WIXL ?? (existsSync("/opt/homebrew/bin/wixl") ? "/opt/homebrew/bin/wixl" : "wixl");
const msiTools = path.dirname(wixl) === "." ? "" : path.dirname(wixl);
const msitool = (n) => (msiTools ? path.join(msiTools, n) : n);

// ---------------------------------------------------------------- helpers
const t0 = Date.now();
const logLines = [];
function log(msg) {
  const line = `[dist ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
}
function mustSh(cmd, args, opts) {
  const r = sh(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.out || r.error?.message}`);
  return r;
}
async function sha256(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
const human = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const ignored = (name) => name.startsWith("._") || name === ".DS_Store";
/** Copy without extended attributes / resource forks, so nothing sprouts "._*" files on the exFAT project volume. */
function dittoCopy(src, dst) {
  mkdirSync(path.dirname(dst), { recursive: true });
  mustSh("ditto", ["--norsrc", "--noextattr", "--noqtn", "--noacl", src, dst]);
}
function removeAppleDouble(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (ignored(e.name)) rmSync(p, { recursive: true, force: true });
    else if (e.isDirectory()) removeAppleDouble(p);
  }
}
async function hashTree(dir, files = listTree(dir)) {
  const map = new Map();
  for (const f of files) map.set(f.rel, { size: f.size, sha256: await sha256(f.abs) });
  return map;
}
function compareTrees(a, b) {
  const problems = [];
  for (const [rel, x] of a) {
    const y = b.get(rel);
    if (!y) problems.push(`missing ${rel}`);
    else if (x.sha256 !== y.sha256) problems.push(`differs ${rel}`);
  }
  for (const rel of b.keys()) if (!a.has(rel)) problems.push(`extra ${rel}`);
  return problems;
}

/** WIN_CSC_LINK (or CSC_LINK) as a local .pfx/.p12 file: a path, file:// URL or base64 content. */
function resolveWinCert() {
  const link = process.env.WIN_CSC_LINK ?? process.env.CSC_LINK;
  if (!link) return null;
  const password = process.env.WIN_CSC_KEY_PASSWORD ?? process.env.CSC_KEY_PASSWORD ?? "";
  const p = link.startsWith("file://") ? new URL(link).pathname : link.replace(/^~(?=\/)/, os.homedir());
  if (existsSync(p)) return { file: p, password };
  if (/^[A-Za-z0-9+/=\s]+$/.test(link) && link.length > 100) {
    const f = path.join(staging, "win-cert.p12");
    writeFileSync(f, Buffer.from(link, "base64"), { mode: 0o600 });
    return { file: f, password };
  }
  throw new Error("WIN_CSC_LINK/CSC_LINK must be a local .pfx path or base64 content to sign the MSI");
}
/**
 * osslsigncode: $OSSLSIGNCODE, else the native build electron-builder downloads for toolsets.winCodeSign 1.1.0
 * (resolved through electron-builder's own resolver, which downloads it on first use).
 */
let osslPath;
async function resolveOsslsigncode() {
  if (osslPath) return osslPath;
  if (process.env.OSSLSIGNCODE) return (osslPath = process.env.OSSLSIGNCODE);
  const { createRequire } = await import("node:module");
  const { getSignToolPath } = createRequire(import.meta.url)("app-builder-lib/out/toolsets/windows.js");
  return (osslPath = (await getSignToolPath("1.1.0", false)).path);
}
const findOsslsigncode = () => { if (!osslPath) throw new Error("osslsigncode not resolved"); return osslPath; };
/** osslsigncode must never see a stdin pipe (see build/win/osslsigncode-wrapper.sh). */
const ossl = (args) => sh(findOsslsigncode(), args, { stdio: ["ignore", "pipe", "pipe"] });
const signerOf = (verifyOut) => (/Signer's certificate:[\s\S]*?Subject: ([^\n]*)/.exec(verifyOut)?.[1] ?? "?").trim();
/** Size of the PE certificate table (Authenticode signature), 0 when unsigned. */
function authenticodeSize(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  const magic = b.readUInt16LE(pe + 24);
  const dd = pe + 24 + (magic === 0x20b ? 112 : 96);
  return b.readUInt32LE(dd + 4 * 8 + 4);
}

class Checks {
  constructor(platform) { this.platform = platform; this.list = []; this.artifacts = []; this.notes = []; }
  async run(name, fn) {
    try {
      const detail = await fn();
      this.list.push({ name, ok: true, detail: detail ?? "" });
      log(`  PASS ${name}${detail ? ` — ${String(detail).split("\n")[0]}` : ""}`);
    } catch (e) {
      this.list.push({ name, ok: false, detail: e.message });
      log(`  FAIL ${name} — ${e.message}`);
    }
  }
  get ok() { return this.list.every((c) => c.ok); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- 1. build
if (doBuild) {
  log("building the app (node scripts/build.mjs)");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error("scripts/build.mjs failed");
}
for (const f of ["dist/main/main.mjs", "dist/preload/preload.cjs", "dist/renderer/index.html"]) {
  if (!existsSync(path.join(root, f))) throw new Error(`${f} is missing: run "pnpm run build" first (or drop --no-build)`);
}
if (pkg.main !== "dist/main/main.mjs") throw new Error(`package.json "main" must be dist/main/main.mjs (is ${pkg.main})`);

// ---------------------------------------------------------------- 2. stage the app on APFS
log(`staging in ${staging}`);
rmSync(appStage, { recursive: true, force: true });
mkdirSync(appStage, { recursive: true });
const stagedPkg = {
  name: "softether-manager",
  productName: pkg.productName,
  version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license ?? "UNLICENSED",
  type: pkg.type,
  main: pkg.main,
};
writeFileSync(path.join(appStage, "package.json"), JSON.stringify(stagedPkg, null, 2) + "\n");
cpSync(path.join(root, "dist"), path.join(appStage, "dist"), {
  recursive: true,
  filter: (src) => !ignored(path.basename(src)) && !src.endsWith(".map"),
});
const resourcesDir = path.join(root, "resources");
if (!existsSync(resourcesDir)) {
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(path.join(resourcesDir, ".gitkeep"), "");
}
mkdirSync(releaseDir, { recursive: true });
mkdirSync(verifyDir, { recursive: true });

// electron-builder mutates the configuration object it is given, so every build() call gets a fresh one.
const freshConfig = () => createConfig({ appDir: appStage, outDir });
const toolVersions = {
  node: process.versions.node,
  electron: electronVersion(),
  "electron-builder": JSON.parse(readFileSync(path.join(repoRoot, "node_modules/electron-builder/package.json"), "utf8")).version,
  wixl: doMsi ? sh(wixl, ["--version"]).out : undefined,
  macOS: sh("sw_vers", ["-productVersion"]).out,
  host: `${os.hostname()} (${process.arch})`,
};

// Remove stale artifacts of the platforms built in this run (the other platform's artifacts are kept).
// Remove stale artifacts of the platform/arch combinations built in this run (everything else is kept).
const stale = (name) =>
  (doMac && macArchs.some((a) => name.includes(`-mac-${a}.`))) ||
  (doWin && winArchs.some((a) => name.includes(`-win-${a}.`) || name.includes(`-win-${a}-setup.`) || name === (a === "x64" ? "win-unpacked" : `win-${a}-unpacked`))) ||
  (doMsi && name.endsWith("-win-x64.msi"));
for (const name of readdirSync(releaseDir)) if (stale(name)) rmSync(path.join(releaseDir, name), { recursive: true, force: true });
for (const p of [doMac && "mac", doWin && "win"].filter(Boolean)) {
  rmSync(path.join(verifyDir, p), { recursive: true, force: true });
  rmSync(path.join(verifyDir, `${p}.json`), { force: true });
}

const summaries = [];

// ---------------------------------------------------------------- 3. macOS
if (doMac) {
  const checks = new Checks("mac");
  const vdir = path.join(verifyDir, "mac");
  mkdirSync(vdir, { recursive: true });
  const signing = macSigningMode();
  log(`${reuse ? "re-using" : "electron-builder:"} macOS ${macArchs.join(", ")} (dmg, zip), signing: ${signing.developerId ? "Developer ID" : "ad-hoc"}${signing.notarize ? " + notarization" : ""}`);
  let macArtifacts;
  if (reuse) {
    macArtifacts = macArchs.flatMap((a) => ["dmg", "zip"].map((e) => path.join(outDir, `${ARTIFACT_STEM}-${version}-mac-${a}.${e}`)));
  } else {
    for (const a of macArchs) rmSync(path.join(outDir, a === "x64" ? "mac" : `mac-${a}`), { recursive: true, force: true });
    macArtifacts = await builderBuild({
      projectDir: root,
      config: freshConfig(),
      targets: Platform.MAC.createTarget(["dmg", "zip"], ...macArchs.map((a) => Arch[a])),
    });
  }
  const copied = [];
  for (const a of macArtifacts.filter((f) => /\.(dmg|zip)$/.test(f))) {
    const dst = path.join(releaseDir, path.basename(a));
    dittoCopy(a, dst);
    copied.push(dst);
  }
  if (doVerify) {
    for (const arch of macArchs) {
      log(`verifying macOS ${arch}`);
      const appPath = path.join(outDir, arch === "x64" ? "mac" : `mac-${arch}`, `${PRODUCT_NAME}.app`);
      const exe = path.join(appPath, "Contents/MacOS", PRODUCT_NAME);
      const dmg = path.join(releaseDir, `${ARTIFACT_STEM}-${version}-mac-${arch}.dmg`);
      const zip = path.join(releaseDir, `${ARTIFACT_STEM}-${version}-mac-${arch}.zip`);
      await checks.run(`[${arch}] .app built, main executable is ${arch}`, () => {
        const archs = mustSh("lipo", ["-archs", exe]).out;
        assert(archs === (arch === "x64" ? "x86_64" : "arm64"), `lipo -archs: ${archs}`);
        return `lipo -archs "${path.basename(exe)}" = ${archs}`;
      });
      await checks.run(`[${arch}] codesign --verify --deep --strict`, () => {
        const r = sh("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
        assert(r.code === 0, r.out);
        const d = sh("codesign", ["-dv", "--verbose=4", appPath]).out;
        const sig = /Signature=(\S+)/.exec(d)?.[1] ?? (/Authority=(.+)/.exec(d)?.[1] ?? "?");
        const flags = /CodeDirectory v=\S+ size=\S+ flags=(\S+)/.exec(d)?.[1] ?? "?";
        if (!signing.developerId) assert(sig === "adhoc", `expected an ad-hoc signature, got ${sig}`);
        writeFileSync(path.join(vdir, `codesign-${arch}.txt`), `${r.out}\n\n${d}\n`);
        return `valid on disk, satisfies its Designated Requirement; Signature=${sig}, flags=${flags}`;
      });
      await checks.run(`[${arch}] Info.plist (bundle id, version, local-network usage string)`, () => {
        const plist = path.join(appPath, "Contents/Info.plist");
        const get = (k) => sh("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, plist]).out;
        assert(get("CFBundleIdentifier") === APP_ID, `CFBundleIdentifier=${get("CFBundleIdentifier")}`);
        assert(get("CFBundleShortVersionString") === version, `CFBundleShortVersionString=${get("CFBundleShortVersionString")}`);
        assert(get("NSLocalNetworkUsageDescription").length > 10, "NSLocalNetworkUsageDescription missing");
        assert(get("CFBundleIconFile").startsWith("icon"), `CFBundleIconFile=${get("CFBundleIconFile")}`);
        return `${get("CFBundleIdentifier")} ${get("CFBundleShortVersionString")}, LSMinimumSystemVersion ${get("LSMinimumSystemVersion")}, icon ${get("CFBundleIconFile")}`;
      });
      await checks.run(`[${arch}] app.asar holds only dist/** and package.json (no node_modules, maps, ._ files)`, async () => {
        const { listPackage } = await import("@electron/asar");
        const entries = listPackage(path.join(appPath, "Contents/Resources/app.asar"), { isPack: false });
        const bad = entries.filter((e) => !(e === "/package.json" || e === "/dist" || e.startsWith("/dist/")) || /node_modules|\.map$|\/\._/.test(e));
        assert(bad.length === 0, `unexpected entries: ${bad.slice(0, 5).join(", ")}`);
        return `${entries.length} entries`;
      });
      await checks.run(`[${arch}] Electron fuses flipped`, async () => {
        const { getCurrentFuseWire, FuseV1Options } = await import("@electron/fuses");
        const wire = await getCurrentFuseWire(exe);
        const want = { RunAsNode: "0", EnableNodeOptionsEnvironmentVariable: "0", EnableNodeCliInspectArguments: "0", EnableEmbeddedAsarIntegrityValidation: "1", OnlyLoadAppFromAsar: "1", EnableCookieEncryption: "1" };
        const got = Object.fromEntries(Object.keys(want).map((k) => [k, String.fromCharCode(wire[FuseV1Options[k]])]));
        for (const k of Object.keys(want)) assert(got[k] === want[k], `${k}=${got[k]}`);
        return Object.entries(got).map(([k, v]) => `${k}=${v === "1" ? "on" : "off"}`).join(", ");
      });
      await checks.run(`[${arch}] DMG: hdiutil verify, mounts, has the app + /Applications link + background, app signature intact`, () => {
        mustSh("hdiutil", ["verify", dmg]);
        const mnt = mkdtempSync(path.join(os.tmpdir(), "sem-dmg-"));
        mustSh("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg]);
        try {
          const items = readdirSync(mnt);
          assert(items.includes(`${PRODUCT_NAME}.app`), `volume contains: ${items.join(", ")}`);
          const link = path.join(mnt, "Applications");
          assert(lstatSync(link).isSymbolicLink() && readlinkSync(link) === "/Applications", "Applications symlink missing");
          assert(existsSync(path.join(mnt, ".background.tiff")), ".background.tiff missing");
          const tiff = sh("tiffutil", ["-info", path.join(mnt, ".background.tiff")]).out;
          const dirs = (tiff.match(/Directory at/g) ?? []).length;
          assert(dirs >= 2, `background is not HiDPI (${dirs} image(s))`);
          assert(existsSync(path.join(mnt, ".VolumeIcon.icns")), ".VolumeIcon.icns missing");
          const v = sh("codesign", ["--verify", "--deep", "--strict", path.join(mnt, `${PRODUCT_NAME}.app`)]);
          assert(v.code === 0, v.out);
          return `volume: ${items.filter((i) => !i.startsWith(".")).join(", ")} (+ ${items.filter((i) => i.startsWith(".")).join(", ")}; background has ${dirs} resolutions)`;
        } finally {
          sh("hdiutil", ["detach", mnt, "-force"]);
          rmSync(mnt, { recursive: true, force: true });
        }
      });
      let unzipped;
      await checks.run(`[${arch}] ZIP: extracts with ditto, symlinks preserved, signature intact`, () => {
        unzipped = mkdtempSync(path.join(os.tmpdir(), "sem-zip-"));
        mustSh("ditto", ["-x", "-k", zip, unzipped]);
        const app = path.join(unzipped, `${PRODUCT_NAME}.app`);
        const cur = path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/Current");
        assert(lstatSync(cur).isSymbolicLink(), "framework symlink lost");
        const v = sh("codesign", ["--verify", "--deep", "--strict", app]);
        assert(v.code === 0, v.out);
        return "Electron Framework.framework/Versions/Current is a symlink; codesign --verify passes on the extracted copy";
      });
      if (doLaunch) {
        const rosetta = arch === "arm64" || process.arch === "x64" || sh("arch", ["-x86_64", "/usr/bin/true"]).code === 0;
        if (!rosetta) {
          checks.notes.push(`[${arch}] launch not tested: Rosetta 2 is not installed on this Mac`);
        } else {
          await checks.run(`[${arch}] launches from the unzipped copy via LaunchServices (open), window renders`, async () =>
            launchMac(path.join(unzipped, `${PRODUCT_NAME}.app`), arch, vdir));
        }
      }
      if (unzipped) rmSync(unzipped, { recursive: true, force: true });
    }
    await checks.run("Gatekeeper assessment (informational)", () => {
      const appPath = path.join(outDir, macArchs[0] === "x64" ? "mac" : `mac-${macArchs[0]}`, `${PRODUCT_NAME}.app`);
      const r = sh("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
      return signing.notarize
        ? (assert(r.code === 0, r.out), r.out)
        : `spctl: ${r.out.replace(/\n/g, " ")} (expected for ad-hoc builds: a downloaded copy needs right-click > Open or xattr -dr com.apple.quarantine)`;
    });
  }
  for (const f of copied) checks.artifacts.push({ file: path.basename(f), kind: /\.dmg$/.test(f) ? "macOS disk image" : "macOS zip (app bundle)" });
  checks.notes.push(`.app bundles (not copyable to the exFAT project volume, which has no symlinks): ${macArchs.map((a) => path.join(outDir, a === "x64" ? "mac" : `mac-${a}`, `${PRODUCT_NAME}.app`)).join(", ")}`);
  summaries.push(checks);
  writeFileSync(path.join(verifyDir, "mac.json"), JSON.stringify(serialise(checks), null, 2));
}

/** Launch the packaged app like a user would (`open`), then attach over CDP to prove the window loaded and grab a screenshot. */
async function launchMac(app, arch, vdir) {
  // First launch of an x64 build on Apple silicon includes Rosetta translation of the whole framework: allow longer.
  const slow = arch !== (process.arch === "arm64" ? "arm64" : "x64") ? 4 : 1;
  const port = 19200 + Math.floor(Math.random() * 500);
  const ud = mkdtempSync(path.join(os.tmpdir(), "sem-launch-"));
  const exe = path.join(app, "Contents/MacOS", PRODUCT_NAME);
  const r = sh("open", ["-n", "--env", `SEM_DATA_DIR=${path.join(ud, "data")}`, "--env", "SEM_INSECURE_KEYSTORE=1", app, "--args",
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(ud, "chromium")}`]);
  assert(r.code === 0, `open failed: ${r.out}`);
  let pid;
  const { chromium } = await import("@playwright/test");
  let browser;
  try {
    for (let i = 0; i < 60 && !pid; i++) {
      const p = sh("pgrep", ["-f", "-n", `${exe} --remote-debugging-port=${port}`]).out;
      if (p) pid = Number(p.split("\n")[0]);
      else await new Promise((res) => setTimeout(res, 500));
    }
    assert(pid, "process did not start");
    for (let i = 0; i < 40 * slow && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); }
      catch { await new Promise((res) => setTimeout(res, 500)); }
    }
    assert(browser, "remote debugging endpoint did not come up");
    let page;
    for (let i = 0; i < 40 * slow && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:"));
      if (!page) await new Promise((res) => setTimeout(res, 500));
    }
    assert(page, "no window with the app page appeared");
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
    const title = await page.title();
    const bounds = await page.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
    const kind = sh("file", [exe]).out.split(": ").pop();
    const shot = path.join(vdir, `mac-${arch}-window.png`);
    await page.screenshot({ path: shot });
    const running = sh("ps", ["-p", String(pid)]).code === 0;
    assert(running, "process exited");
    // The native window as the window server sees it (no permission needed) and, if this terminal has the Screen
    // Recording permission, a capture of the real window including its title bar.
    const win = sh("swift", [path.join(root, "build/verify/window-of-pid.swift"), String(pid)]).out;
    let native = "native window: not found in CGWindowList";
    if (win.startsWith("{")) {
      const w = JSON.parse(win);
      native = `native window #${w.id} "${w.owner}" on screen at ${w.x},${w.y} ${w.width}x${w.height}`;
      const cap = path.join(vdir, `mac-${arch}-native-window.png`);
      const c = sh("screencapture", ["-x", "-o", `-l${w.id}`, cap]);
      native += c.code === 0 && existsSync(cap) ? `; captured verification/mac/${path.basename(cap)}` : " (screencapture -l needs the Screen Recording permission for this terminal: skipped)";
    }
    return `pid ${pid} (${kind}) running; window "${title}" ${bounds.width}x${bounds.height}; url ${page.url().replace(/^.*\/app\.asar/, "…/app.asar")}; renderer screenshot verification/mac/${path.basename(shot)}; ${native}`;
  } finally {
    await browser?.close().catch(() => {});
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 20 && sh("ps", ["-p", String(pid)]).code === 0; i++) await new Promise((res) => setTimeout(res, 250));
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    sh("pkill", ["-f", app]);
    rmSync(ud, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 4. Windows
if (doWin) {
  const checks = new Checks("win");
  const vdir = path.join(verifyDir, "win");
  mkdirSync(vdir, { recursive: true });
  const ResEdit = await import("resedit");
  const icoBuf = readFileSync(path.join(root, "build/icon.ico"));
  const icoFile = ResEdit.Data.IconFile.from(icoBuf);
  const icoSizes = icoFile.icons.map((i) => i.width || 256);
  const unpackedName = (a) => (a === "x64" ? "win-unpacked" : `win-${a}-unpacked`);

  if (resolveWinCert()) {
    // Route electron-builder's Windows signing through the stdin-safe wrapper (see the wrapper for the why).
    process.env.SEM_REAL_OSSLSIGNCODE = await resolveOsslsigncode();
    process.env.ELECTRON_BUILDER_OSSL_SIGNCODE_PATH = path.join(root, "build/win/osslsigncode-wrapper.sh");
    log(`Windows signing: ${resolveWinCert().file} via ${process.env.SEM_REAL_OSSLSIGNCODE}`);
  }
  for (const arch of winArchs) {
    log(`${reuse ? "re-using" : "electron-builder:"} Windows ${arch} (unpacked, zip, nsis)`);
    let arts;
    if (reuse) {
      arts = [`${ARTIFACT_STEM}-${version}-win-${arch}.zip`, `${ARTIFACT_STEM}-${version}-win-${arch}-setup.exe`].map((n) => path.join(outDir, n));
    } else {
      rmSync(path.join(outDir, unpackedName(arch)), { recursive: true, force: true });
      arts = await builderBuild({
        projectDir: root,
        config: freshConfig(),
        targets: Platform.WINDOWS.createTarget(["zip", "nsis"], Arch[arch]),
      });
    }
    for (const a of arts.filter((f) => /\.(zip|exe)$/.test(f) && !f.includes("__uninstaller"))) {
      dittoCopy(a, path.join(releaseDir, path.basename(a)));
      checks.artifacts.push({ file: path.basename(a), kind: a.endsWith(".exe") ? `Windows ${arch} NSIS installer` : `Windows ${arch} zip (portable)` });
    }
    dittoCopy(path.join(outDir, unpackedName(arch)), path.join(releaseDir, unpackedName(arch)));
    removeAppleDouble(path.join(releaseDir, unpackedName(arch)));
    checks.notes.push(`${unpackedName(arch)}/ copied to release/ (electron-builder "dir" output)`);
  }

  let msiPath;
  if (doMsi) {
    if (!winArchs.includes("x64")) throw new Error("the MSI is built from the x64 win-unpacked: include x64 in --win-arch or pass --no-msi");
    log("wixl: building the x64 MSI from win-unpacked");
    const msiLog = [];
    msiPath = path.join(releaseDir, `${ARTIFACT_STEM}-${version}-win-x64.msi`);
    const workDir = path.join(staging, "msi");
    rmSync(workDir, { recursive: true, force: true });
    const res = await buildAppMsi({
      sourceDir: path.join(outDir, "win-unpacked"), outFile: path.join(workDir, "out.msi"), workDir, version,
      productName: PRODUCT_NAME, description: pkg.description, iconFile: path.join(root, "build/icon.ico"), arch: "x64", wixl, log: msiLog,
    });
    const winCert = resolveWinCert();
    if (winCert) {
      const signed = path.join(workDir, "signed.msi");
      const args = ["sign", "-pkcs12", winCert.file, ...(winCert.password ? ["-pass", winCert.password] : []),
        "-n", PRODUCT_NAME, "-h", "sha256", ...(process.env.SEM_WIN_TIMESTAMP_URL !== "" ? ["-ts", process.env.SEM_WIN_TIMESTAMP_URL ?? "http://timestamp.digicert.com"] : []),
        "-in", res.msi, "-out", signed];
      const r = ossl(args);
      if (r.code !== 0) throw new Error(`osslsigncode sign failed: ${r.out}`);
      dittoCopy(signed, res.msi);
      msiLog.push(`$ osslsigncode sign -pkcs12 <WIN_CSC_LINK> -h sha256 -ts ${process.env.SEM_WIN_TIMESTAMP_URL ?? "http://timestamp.digicert.com"} -in app.msi   (Authenticode)`);
    }
    dittoCopy(res.msi, msiPath);
    dittoCopy(res.wxsFile, path.join(vdir, "SoftEtherManager.wxs"));
    writeFileSync(path.join(vdir, "msi-build.log"), msiLog.join("\n") + "\n");
    for (const l of msiLog) log(`  ${l.split("\n")[0]}`);
    checks.artifacts.push({ file: path.basename(msiPath), kind: "Windows x64 MSI (per-machine)" });
  }

  if (doVerify) {
    for (const arch of winArchs) {
      log(`verifying Windows ${arch}`);
      const unpacked = path.join(outDir, unpackedName(arch));
      const exePath = path.join(unpacked, MAIN_EXE);
      const machine = { x64: 0x8664, arm64: 0xaa64 }[arch];
      const readPe = (file) => {
        const exe = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
        const res = ResEdit.NtExecutableResource.from(exe);
        const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
        const lang = vi.getAllLanguagesForStringValues()[0];
        const strings = vi.getStringValues(lang);
        const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
        return { exe, res, vi, strings, groups, machine: exe.newHeader.fileHeader.machine };
      };
      const iconMatches = (pe) => {
        const grp = pe.groups[0];
        assert(grp, "no RT_GROUP_ICON");
        const sizes = grp.icons.map((i) => i.width || 256);
        assert(JSON.stringify(sizes) === JSON.stringify(icoSizes), `icon sizes ${sizes} != build/icon.ico ${icoSizes}`);
        grp.icons.forEach((ic, i) => {
          const entry = pe.res.entries.find((e) => e.type === 3 && e.id === ic.iconID);
          const want = icoFile.icons[i].data;
          const wantBuf = Buffer.from(want.isRaw() ? want.bin : want.generate());
          assert(entry && Buffer.from(entry.bin).equals(wantBuf), `icon image ${sizes[i]}px differs from build/icon.ico`);
        });
        return sizes;
      };
      const peInfo = {};
      await checks.run(`[${arch}] ${MAIN_EXE}: PE machine, version resources, icon = build/icon.ico, asar integrity resource`, () => {
        const pe = readPe(exePath);
        assert(pe.machine === machine, `machine 0x${pe.machine.toString(16)}`);
        const s = pe.strings;
        assert(s.ProductName === PRODUCT_NAME, `ProductName=${s.ProductName}`);
        // electron-builder writes FileVersion verbatim; resedit normalises ProductVersion to four parts (1.0.0 → 1.0.0.0)
        assert(s.FileVersion === version && (s.ProductVersion === version || s.ProductVersion === `${version}.0`), `FileVersion=${s.FileVersion} ProductVersion=${s.ProductVersion}`);
        assert(s.CompanyName === pkg.author, `CompanyName=${s.CompanyName}`);
        const fv = pe.vi.fixedInfo;
        const bin = `${fv.fileVersionMS >>> 16}.${fv.fileVersionMS & 0xffff}.${fv.fileVersionLS >>> 16}.${fv.fileVersionLS & 0xffff}`;
        const sizes = iconMatches(pe);
        assert(pe.res.entries.some((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR"), "ELECTRONASAR integrity resource missing");
        peInfo.exe = { strings: s, fixedFileVersion: bin, iconSizes: sizes, machine: `0x${pe.machine.toString(16)}` };
        return `machine 0x${pe.machine.toString(16)}; ${s.ProductName} ${s.ProductVersion} (fixed ${bin}), "${s.FileDescription}", ${s.CompanyName}, ${s.LegalCopyright}; icons ${sizes.join("/")} byte-identical`;
      });
      await checks.run(`[${arch}] Electron fuses flipped in ${MAIN_EXE}`, async () => {
        const { getCurrentFuseWire, FuseV1Options } = await import("@electron/fuses");
        const wire = await getCurrentFuseWire(exePath);
        const f = (k) => String.fromCharCode(wire[FuseV1Options[k]]);
        assert(f("RunAsNode") === "0" && f("OnlyLoadAppFromAsar") === "1" && f("EnableEmbeddedAsarIntegrityValidation") === "1", "fuses not set");
        return "RunAsNode=off, OnlyLoadAppFromAsar=on, EnableEmbeddedAsarIntegrityValidation=on, EnableNodeCliInspectArguments=" + (f("EnableNodeCliInspectArguments") === "0" ? "off" : "on");
      });
      await checks.run(`[${arch}] resources/app.asar holds only dist/** and package.json; extraResources present`, async () => {
        const { listPackage } = await import("@electron/asar");
        const entries = listPackage(path.join(unpacked, "resources/app.asar"), { isPack: false });
        const bad = entries.filter((e) => !(e === "/package.json" || e === "/dist" || e.startsWith("/dist/")) || /node_modules|\.map$|\/\._/.test(e));
        assert(bad.length === 0, `unexpected: ${bad.slice(0, 5).join(", ")}`);
        const extra = listTree(path.join(root, "resources")).filter((f) => !f.rel.endsWith(".gitkeep"));
        for (const f of extra) assert(existsSync(path.join(unpacked, "resources/resources", f.rel)), `extraResource ${f.rel} missing`);
        return `${entries.length} asar entries; ${extra.length} file(s) from apps/desktop/resources under resources/resources/`;
      });
      await checks.run(`[${arch}] zip is byte-identical to ${unpackedName(arch)} (minus the NSIS-only ${NSIS_ONLY_FILES.join(", ")})`, async () => {
        const zip = path.join(releaseDir, `${ARTIFACT_STEM}-${version}-win-${arch}.zip`);
        const tmp = mkdtempSync(path.join(os.tmpdir(), "sem-wzip-"));
        try {
          mustSh("ditto", ["-x", "-k", zip, tmp]);
          const problems = compareTrees(await hashTree(unpacked, msiPayload(unpacked)), await hashTree(tmp));
          assert(problems.length === 0, problems.slice(0, 5).join("; "));
          return `${listTree(tmp).length} files, all SHA-256 equal`;
        } finally { rmSync(tmp, { recursive: true, force: true }); }
      });
      await checks.run(`[${arch}] NSIS setup.exe is a valid PE with version resources and the app icon`, () => {
        const setup = path.join(releaseDir, `${ARTIFACT_STEM}-${version}-win-${arch}-setup.exe`);
        const pe = readPe(setup);
        assert(pe.machine === 0x14c, `NSIS stub machine 0x${pe.machine.toString(16)} (expected x86 0x14c)`);
        assert(pe.strings.ProductName === PRODUCT_NAME && pe.strings.ProductVersion === version, `ProductName/Version ${pe.strings.ProductName} ${pe.strings.ProductVersion}`);
        const grp = pe.groups[0];
        assert(grp && grp.icons.length > 0, "no installer icon");
        const size = statSync(setup).size;
        assert(size > 50 * 1024 * 1024, `suspiciously small: ${human(size)}`);
        const hasNsis = readFileSync(setup).includes(Buffer.from("NullsoftInst"));
        assert(hasNsis, "no NSIS header (NullsoftInst) found");
        return `x86 NSIS stub (machine 0x14c), NullsoftInst header, ${pe.strings.ProductName} ${pe.strings.ProductVersion}, icon ${grp.icons.map((i) => i.width || 256).join("/")}, ${human(size)}`;
      });
      await checks.run(`[${arch}] Authenticode signatures (${resolveWinCert() ? "WIN_CSC_LINK set: must be signed" : "no WIN_CSC_LINK: unsigned by design"})`, () => {
        const files = [exePath, path.join(releaseDir, `${ARTIFACT_STEM}-${version}-win-${arch}-setup.exe`)];
        const sizes = files.map(authenticodeSize);
        if (resolveWinCert()) assert(sizes.every((n) => n > 0), `unsigned: ${files.filter((_, i) => !sizes[i]).map((f) => path.basename(f)).join(", ")}`);
        else assert(sizes.every((n) => n === 0), "unexpected signature");
        const detail = files.map((f, i) => {
          if (!sizes[i]) return `${path.basename(f)}: unsigned`;
          const v = ossl(["verify", "-in", f]).out;
          writeFileSync(path.join(vdir, `signature-${path.basename(f)}.txt`), v + "\n");
          assert(!/MISMATCH/i.test(v), `${path.basename(f)}: digest mismatch`);
          return `${path.basename(f)}: signed by "${signerOf(v)}", digest matches`;
        });
        return detail.join("; ");
      });
      writeFileSync(path.join(vdir, `pe-${arch}.json`), JSON.stringify(peInfo, null, 2));
    }

    if (msiPath) {
      log("verifying the MSI");
      const unpacked = path.join(outDir, "win-unpacked");
      const src = msiPayload(unpacked);
      const t = async (name) => exportTable(msiPath, name, msitool("msiinfo"));
      const tables = mustSh(msitool("msiinfo"), ["tables", msiPath]).out.split("\n").map((s) => s.trim()).filter(Boolean);
      const dumps = {};
      for (const name of ["Property", "File", "Component", "Directory", "Shortcut", "MsiShortcutProperty", "Registry", "Upgrade", "Icon", "Media", "Feature", "InstallExecuteSequence"]) {
        if (tables.includes(name)) dumps[name] = (await t(name)).text;
      }
      writeFileSync(path.join(vdir, "msi-tables.txt"), Object.entries(dumps).map(([k, v]) => `==== ${k}\n${v}\n`).join("\n"));
      await checks.run("MSI summary information: x64 template, schema 500", () => {
        const s = mustSh(msitool("msiinfo"), ["suminfo", msiPath]).out;
        writeFileSync(path.join(vdir, "msi-suminfo.txt"), s + "\n");
        assert(/Template:\s*x64;1033/.test(s), "template is not x64;1033");
        assert(/Version:\s*500/.test(s), "page count (schema) is not 500");
        return s.split("\n").filter((l) => /Template|Version|Title|Subject/.test(l)).map((l) => l.trim()).join("; ");
      });
      await checks.run(`MSI Authenticode (${resolveWinCert() ? "must be signed" : "unsigned by design: no WIN_CSC_LINK"})`, () => {
        const streams = mustSh(msitool("msiinfo"), ["streams", msiPath]).out;
        const signed = streams.includes("DigitalSignature");
        assert(signed === Boolean(resolveWinCert()), signed ? "unexpected signature" : "MSI is not signed");
        if (!signed) return "no \\005DigitalSignature stream";
        const v = ossl(["verify", "-in", msiPath]).out;
        writeFileSync(path.join(vdir, "msi-signature.txt"), v + "\n");
        assert(!/MISMATCH/i.test(v), "MSI digest mismatch");
        return `\\005DigitalSignature present, signed by "${signerOf(v)}", digest matches`;
      });
      await checks.run("MSI tables present", () => {
        for (const need of ["File", "Component", "Directory", "Feature", "FeatureComponents", "Shortcut", "MsiShortcutProperty", "Registry", "Upgrade", "Icon", "Property", "Media", "InstallExecuteSequence"]) {
          assert(tables.includes(need), `table ${need} missing`);
        }
        return tables.join(", ");
      });
      await checks.run("MSI Property: name, version, manufacturer, UpgradeCode, per-machine, ARP icon, secure DESKTOPSHORTCUT", async () => {
        const p = Object.fromEntries((await t("Property")).rows.map((r) => [r[0], r[1]]));
        assert(p.ProductName === PRODUCT_NAME, `ProductName=${p.ProductName}`);
        assert(p.ProductVersion === msiVersion(version), `ProductVersion=${p.ProductVersion}`);
        assert(p.UpgradeCode === `{${UPGRADE_CODE}}` || p.UpgradeCode === UPGRADE_CODE, `UpgradeCode=${p.UpgradeCode}`);
        assert(p.ALLUSERS === "1", `ALLUSERS=${p.ALLUSERS}`);
        assert(p.ARPPRODUCTICON === "ProductIcon.ico", `ARPPRODUCTICON=${p.ARPPRODUCTICON}`);
        assert(p.DESKTOPSHORTCUT === "1", "DESKTOPSHORTCUT default");
        assert((p.SecureCustomProperties ?? "").split(";").includes("DESKTOPSHORTCUT"), `SecureCustomProperties=${p.SecureCustomProperties}`);
        return `ProductName=${p.ProductName}, ProductVersion=${p.ProductVersion}, Manufacturer=${p.Manufacturer}, UpgradeCode=${p.UpgradeCode}, ALLUSERS=${p.ALLUSERS}, ProductCode=${p.ProductCode}`;
      });
      await checks.run("MSI File table matches win-unpacked (count and total size)", async () => {
        const rows = (await t("File")).rows;
        const total = rows.reduce((n, r) => n + Number(r[3]), 0);
        const srcTotal = src.reduce((n, f) => n + f.size, 0);
        assert(rows.length === src.length, `File rows ${rows.length} != ${src.length} files`);
        assert(total === srcTotal, `size ${total} != ${srcTotal}`);
        return `${rows.length} files, ${human(total)}`;
      });
      await checks.run("MSI MajorUpgrade: Upgrade table rows + RemoveExistingProducts scheduled", async () => {
        const up = (await t("Upgrade")).rows;
        assert(up.length >= 2 && up.every((r) => r[0].replace(/[{}]/g, "") === UPGRADE_CODE), `Upgrade rows: ${JSON.stringify(up)}`);
        const seq = (await t("InstallExecuteSequence")).rows;
        const rep = seq.find((r) => r[0] === "RemoveExistingProducts");
        const iv = seq.find((r) => r[0] === "InstallValidate");
        assert(rep && iv && Number(rep[2]) > Number(iv[2]), "RemoveExistingProducts not after InstallValidate");
        return `${up.length} Upgrade rows; RemoveExistingProducts at ${rep[2]} (after InstallValidate ${iv[2]})`;
      });
      await checks.run("MSI shortcuts: Start menu + optional desktop (component condition), AppUserModelID", async () => {
        const sc = (await t("Shortcut")).rows;
        const dirs = sc.map((r) => r[1]).sort();
        assert(JSON.stringify(dirs) === JSON.stringify(["DesktopFolder", "ProgramMenuFolder"]), `shortcut dirs ${dirs}`);
        assert(sc.every((r) => r[4] === "[#MainExe]"), `targets ${sc.map((r) => r[4])}`);
        const comp = (await t("Component")).rows.find((r) => r[0] === "C_DesktopShortcut");
        assert(comp && /DESKTOPSHORTCUT/.test(comp[4]), "desktop shortcut condition missing");
        const sp = (await t("MsiShortcutProperty")).rows;
        assert(sp.length === 2 && sp.every((r) => r[3] === APP_ID), "AppUserModelID rows");
        return `${sc.map((r) => `${r[1]}\\${r[2].split("|").pop()}.lnk → ${r[4]}`).join(", ")}; desktop condition: ${comp[4]}; AUMID ${APP_ID}`;
      });
      await checks.run("MSI Registry + Icon", async () => {
        const reg = (await t("Registry")).rows;
        const icon = (await t("Icon")).rows;
        assert(reg.length >= 4, `${reg.length} registry rows`);
        assert(icon.some((r) => r[0] === "ProductIcon.ico"), "ProductIcon.ico missing");
        assert(reg.every((r) => r[1] === "2"), "expected HKLM (root 2) values only");
        return `${reg.length} HKLM values (${[...new Set(reg.map((r) => r[2]))].join(", ")}): ${reg.map((r) => r[3]).join(", ")}; Icon: ${icon.map((r) => r[0]).join(", ")}`;
      });
      await checks.run(`msiextract output is byte-identical to win-unpacked (minus the NSIS-only ${NSIS_ONLY_FILES.join(", ")})`, async () => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), "sem-msix-"));
        try {
          mustSh(msitool("msiextract"), ["-C", tmp, msiPath]);
          const exe = listTree(tmp).find((f) => path.posix.basename(f.rel) === MAIN_EXE);
          assert(exe, "main exe not extracted");
          const base = path.join(tmp, path.dirname(exe.rel));
          const problems = compareTrees(await hashTree(unpacked, src), await hashTree(base));
          assert(problems.length === 0, problems.slice(0, 5).join("; "));
          return `${listTree(base).length} files under "${path.dirname(exe.rel)}", all SHA-256 equal`;
        } finally { rmSync(tmp, { recursive: true, force: true }); }
      });
    }
  }
  checks.notes.push("Not verifiable on this Mac: actually installing/uninstalling/upgrading on Windows (msiexec, NSIS), SmartScreen, and Windows code signing (no certificate).");
  summaries.push(checks);
  writeFileSync(path.join(verifyDir, "win.json"), JSON.stringify(serialise(checks), null, 2));
}

function serialise(c) {
  return { platform: c.platform, builtAt: new Date().toISOString(), version, toolVersions, artifacts: c.artifacts, checks: c.list, notes: c.notes, ok: c.ok };
}

// ---------------------------------------------------------------- 5. checksums + report
log("writing SHA256SUMS and BUILD-REPORT.md");
const topFiles = readdirSync(releaseDir).filter((n) => !ignored(n) && statSync(path.join(releaseDir, n)).isFile() && !["SHA256SUMS", "BUILD-REPORT.md"].includes(n)).sort();
const sums = [];
const fileInfo = {};
for (const n of topFiles) {
  const h = await sha256(path.join(releaseDir, n));
  fileInfo[n] = { size: statSync(path.join(releaseDir, n)).size, sha256: h };
  sums.push(`${h}  ${n}`);
}
writeFileSync(path.join(releaseDir, "SHA256SUMS"), sums.join("\n") + "\n");
const shaCheck = sh("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: releaseDir });

const platforms = ["mac", "win"].map((p) => {
  const f = path.join(verifyDir, `${p}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}).filter(Boolean);
const md = [];
md.push(`# SoftEther Manager ${version}: build report`, "");
md.push(`Generated by \`apps/desktop/scripts/dist.mjs\` on ${new Date().toISOString()} (${toolVersions.host}, macOS ${toolVersions.macOS}).`);
md.push(`Tools: Node ${toolVersions.node}, Electron ${toolVersions.electron}, electron-builder ${toolVersions["electron-builder"]}${toolVersions.wixl ? `, wixl ${toolVersions.wixl}` : ""}.`, "");
md.push("## Artifacts", "", "| File | Kind | Size | SHA-256 |", "|---|---|---|---|");
const kinds = Object.fromEntries(platforms.flatMap((p) => p.artifacts.map((a) => [a.file, a.kind])));
for (const n of topFiles) md.push(`| \`${n}\` | ${kinds[n] ?? ""} | ${human(fileInfo[n].size)} | \`${fileInfo[n].sha256}\` |`);
md.push("", `\`shasum -a 256 -c SHA256SUMS\`: ${shaCheck.code === 0 ? "all OK" : "FAILED"}.`, "");
for (const p of platforms) {
  md.push(`## ${p.platform === "mac" ? "macOS" : "Windows"} verification (${p.builtAt}): ${p.ok ? "PASS" : "FAIL"}`, "");
  md.push("| Check | Result | Detail |", "|---|---|---|");
  for (const c of p.checks) md.push(`| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"} | ${String(c.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  md.push("");
  for (const n of p.notes) md.push(`* ${n}`);
  md.push("");
}
const shots = existsSync(path.join(verifyDir, "mac")) ? readdirSync(path.join(verifyDir, "mac")).filter((n) => n.endsWith(".png") && !ignored(n)) : [];
if (shots.length) {
  md.push("## Screenshots of the packaged app", "");
  for (const s of shots) md.push(`![${s}](verification/mac/${s})`, "");
}
md.push("## How to reproduce", "", "```sh", "cd apps/desktop", "pnpm run dist        # or dist:mac / dist:win", "shasum -a 256 -c release/SHA256SUMS", "```", "");
md.push("Details of each check: `verification/*.json`; MSI tables: `verification/win/msi-tables.txt`; generated WiX source: `verification/win/SoftEtherManager.wxs`.", "");
writeFileSync(path.join(releaseDir, "BUILD-REPORT.md"), md.join("\n"));
writeFileSync(path.join(verifyDir, `dist-${doMac && doWin ? "all" : doMac ? "mac" : "win"}.log`), logLines.join("\n") + "\n");
removeAppleDouble(releaseDir);

const failed = summaries.flatMap((s) => s.list.filter((c) => !c.ok));
log(`done: ${topFiles.length} artifacts in ${releaseDir}; ${summaries.reduce((n, s) => n + s.list.length, 0)} checks, ${failed.length} failed`);
if (failed.length || shaCheck.code !== 0) process.exit(1);
