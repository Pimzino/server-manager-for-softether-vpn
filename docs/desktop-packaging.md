# Server Manager for SoftEther VPN desktop: packaging and installers

Every installer, for macOS and for Windows, is built **on a Mac**. You do not need a Windows machine, Wine, or a
virtual machine. One command builds the app, packages it, builds the MSI, checks every artifact, and writes a
report.

```sh
brew install msitools          # wixl, msiinfo, msiextract, msibuild (used for the MSI)
cd apps/desktop
pnpm run dist                   # everything
pnpm run dist:mac               # macOS only
pnpm run dist:win               # Windows only (with the MSI)
```

The result is in `apps/desktop/release/`. `release/BUILD-REPORT.md` lists every artifact with its size and SHA-256,
and every check that ran with its result. `release/SHA256SUMS` can be checked with `shasum -a 256 -c SHA256SUMS`.

## Outputs

| File | What it is |
|---|---|
| `Server-Manager-for-SoftEther-VPN-<v>-mac-arm64.dmg` / `-mac-x64.dmg` | Disk image with a styled window (HiDPI background, volume icon) and an `Applications` link |
| `Server-Manager-for-SoftEther-VPN-<v>-mac-arm64.zip` / `-mac-x64.zip` | The `.app` bundle, zipped with symlinks preserved |
| `Server-Manager-for-SoftEther-VPN-<v>-win-x64-setup.exe` / `-win-arm64-setup.exe` | NSIS installer (assisted: per-user or all-users, directory choice, Start-menu and desktop shortcuts) |
| `Server-Manager-for-SoftEther-VPN-<v>-win-x64.zip` / `-win-arm64.zip` | Portable build (no installer) |
| `Server-Manager-for-SoftEther-VPN-<v>-win-x64.msi` | Per-machine MSI for managed deployment (Intune, GPO, SCCM) |
| `win-unpacked/`, `win-arm64-unpacked/` | electron-builder `dir` output (the app folder the zip, NSIS and MSI are made from) |
| `verification/` | Screenshots of the packaged app, the generated WiX source, MSI table dumps, PE resource dumps, per-platform JSON results, logs |

The `.app` bundles themselves are not copied to `release/`. The repository volume is exFAT, and exFAT cannot store
the symlinks that macOS frameworks need. The bundles are in the staging directory (see below), and the `.dmg` and
`.zip` contain them intact.

### Why separate arm64 and x64 macOS builds instead of a universal one

electron-builder 26.15.3 can build a universal app by merging the two with `@electron/universal`. That merge is
the most fragile step in the chain: every file that differs between the two builds has to be a Mach-O it can
`lipo` together, or be listed in `x64ArchFiles`, and the asar integrity hashes have to line up. Two
single-architecture builds need none of this. Each download is also about half the size of a universal one. Users
pick "Apple silicon" or "Intel". The x64 build is also tested on Apple silicon under Rosetta 2.

## Options

`node scripts/dist.mjs [--mac] [--win] [options]`

| Option | Effect |
|---|---|
| `--no-build` | Package the existing `dist/` instead of running `scripts/build.mjs` first (`pnpm run dist:nobuild`) |
| `--mac-arch=arm64,x64` / `--win-arch=x64,arm64` | Limit the architectures |
| `--no-msi` | Skip the MSI |
| `--no-verify` / `--no-launch` | Skip all checks / skip only starting the packaged app |
| `--reuse` | Skip electron-builder and reuse its last output from the staging directory. Use it to rerun the MSI step or the checks. |

Environment: `SEM_DIST_STAGING` sets the staging directory (default `$TMPDIR/sem-desktop-dist`). It must be on
APFS or HFS+, and inside `$TMPDIR` or your home directory. electron-builder 26 refuses to pack files whose real
path is under `/private`, `/tmp` or `/var` unless they are inside one of those two, and `dist.mjs` checks this
up front. `WIXL` is the path to wixl (default: `/opt/homebrew/bin/wixl`, or `wixl` on `PATH`).

A run removes only the artifacts it rebuilds. For example, `dist:mac` keeps the Windows files already in
`release/`, and the report includes both.

## How it works

1. **Build.** `scripts/build.mjs` bundles main, preload and renderer into `dist/`.
2. **Stage.** A clean copy of the app goes to `<staging>/app`. It holds only `dist/**` (no source maps, no `._*`
   AppleDouble files) and a minimal `package.json` with no dependencies. electron-builder reads this copy (a
   two-package.json layout) and writes to `<staging>/out` on APFS, so nothing from `node_modules` is shipped.
   `apps/desktop/resources/` is added as `extraResources` and ends up in `resources/resources/` in the installed
   app (`process.resourcesPath + "/resources"`).
3. **electron-builder 26.15.3** (`apps/desktop/electron-builder.config.mjs`):
   * asar packaging, with Electron fuses set: `RunAsNode` off, `NODE_OPTIONS` off, `--inspect` off, asar integrity
     validation on, load the app only from asar, cookie encryption on. Because `RunAsNode` is off,
     `child_process.fork(process.execPath)` does not work in the packaged app. Use `utilityProcess` instead.
   * macOS: `dmg` and `zip` per architecture. The `Info.plist` gets `NSLocalNetworkUsageDescription`, which the
     macOS 15+ local network privacy prompt needs when a server is on the LAN. The minimum macOS version (13.0)
     comes from Electron 44.
   * Windows: `zip` and `nsis` per architecture, built on macOS without Wine. electron-builder 26 writes the
     version and icon resources with `resedit` (a TypeScript PE resource editor that replaced rcedit). On macOS
     Catalina or later, it extracts the NSIS uninstaller from the built installer with its own PE reader instead
     of running it under Wine. The makensis, 7-Zip and dmgbuild binaries are downloaded once into
     `~/Library/Caches/electron-builder`. Electron itself is cached in `~/Library/Caches/electron`.
4. **MSI.** `apps/desktop/installer/msi.mjs` generates the WiX source from `win-unpacked` (see below), builds it
   with `wixl`, and post-processes it with `msibuild`.
5. **Verify.** See [What the checks prove](#what-the-checks-prove).
6. **Report.** `SHA256SUMS`, `BUILD-REPORT.md`, `verification/`.

### The MSI

`wixl` supports a subset of WiX 3 and has no `heat` (`wixl-heat` is a minimal filter that assigns random GUIDs).
So `installer/msi.mjs` walks `win-unpacked` and writes one component per file. Component GUIDs are derived from the
UpgradeCode and the file's relative path, so they stay the same across builds.

* Installs per machine to `C:\Program Files\Server Manager for SoftEther VPN\` (`INSTALLDIR`), 64-bit (`Template x64;1033`,
  schema 500).
* Adds a Start-menu shortcut, and a desktop shortcut unless `DESKTOPSHORTCUT=0`. Both shortcuts carry
  `System.AppUserModel.ID = com.softethermanager.desktop` (the `MsiShortcutProperty` table, added with
  `msibuild`), so Windows notifications and taskbar grouping work if the app calls
  `app.setAppUserModelId("com.softethermanager.desktop")`.
* Registers in Add/Remove Programs with the app icon (`ARPPRODUCTICON`) and no Modify button.
* Uses the fixed **UpgradeCode `CACB4190-26D2-438C-B7C6-EBEB624B0B54`** (never change it) with `MajorUpgrade`
  (`AllowSameVersionUpgrades`). A newer MSI, or a rebuild with the same version, replaces the installed one in
  place: `RemoveExistingProducts` runs right after `InstallValidate`. Installing an older MSI is refused.
  ProductCode is new on every build.
* The version comes from `package.json` (`major.minor.patch`, with MSI limits of 255.255.65535; a pre-release
  suffix is dropped).
* Omits `resources/elevate.exe`. electron-builder adds it to `win-unpacked` for NSIS only, and it is not in the
  zip either.
* The MSI has no wizard UI (wixl has no WixUI). Double-clicking it shows the standard Windows Installer progress
  dialog and UAC prompt. For an interactive install, use the NSIS setup.

Silent install, upgrade and uninstall:

```bat
msiexec /i Server-Manager-for-SoftEther-VPN-1.0.0-win-x64.msi /qn
msiexec /i Server-Manager-for-SoftEther-VPN-1.0.0-win-x64.msi /qn DESKTOPSHORTCUT=0 INSTALLDIR="D:\Apps\Server Manager for SoftEther VPN\"
msiexec /i Server-Manager-for-SoftEther-VPN-1.1.0-win-x64.msi /qn          :: upgrades in place
msiexec /x Server-Manager-for-SoftEther-VPN-1.1.0-win-x64.msi /qn          :: or /x {ProductCode} (see BUILD-REPORT / msiinfo)
msiexec /i ... /qn /l*v install.log                          :: verbose log
```

User data (`%APPDATA%\Server Manager for SoftEther VPN`) is kept on uninstall by both the MSI and the NSIS installer. The NSIS
installer and the MSI are separate products. Install one or the other, not both.

## Signing and notarization

### macOS (the default is ad-hoc)

No Apple Developer ID is available here, so the default build is **ad-hoc signed** (`identity: "-"`).
`codesign --verify --deep --strict` passes, and the app runs on Apple silicon, where all code must be signed.
The hardened runtime is **off** for ad-hoc builds. Ad-hoc code has no Team ID, so library validation under the
hardened runtime would reject Electron's own frameworks. Gatekeeper rejects ad-hoc apps that are downloaded
(quarantined). Users must right-click the app and choose Open, or run
`xattr -dr com.apple.quarantine "/Applications/Server Manager for SoftEther VPN.app"`. A copy built on the same Mac is not
quarantined.

To ship properly, add a Developer ID. No code changes are needed, only environment variables:

```sh
# Signing identity: either a .p12 exported from Keychain ...
export CSC_LINK=/path/DeveloperID_Application.p12   # or base64 of it
export CSC_KEY_PASSWORD=...
# ... or an identity already in the login keychain:
export CSC_NAME="Developer ID Application: Example Ltd (TEAMID1234)"

# Notarization (any one of these three sets):
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop APPLE_TEAM_ID=TEAMID1234
# export APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<issuer uuid>
# export APPLE_KEYCHAIN_PROFILE=notary-profile            # from `xcrun notarytool store-credentials`

pnpm run dist:mac
```

When `CSC_LINK` or `CSC_NAME` is set, the config switches to the hardened runtime with
`build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` (`allow-jit`). When the notarization
variables are also set, it notarizes and staples through `notarytool`. With notarization enabled, the Gatekeeper
check in the report becomes a hard requirement (`spctl --assess` must accept the app).

### Windows

Without a certificate, the Windows files are unsigned, and SmartScreen warns on first run. To sign, set:

```sh
export WIN_CSC_LINK=/path/codesign.pfx     # or base64 of it (CSC_LINK is used if WIN_CSC_LINK is unset)
export WIN_CSC_KEY_PASSWORD=...
export SEM_WIN_TIMESTAMP_URL=http://timestamp.digicert.com   # default; set it empty to skip timestamping
pnpm run dist:win
```

On macOS, electron-builder signs `Server Manager for SoftEther VPN.exe`, the NSIS installer, its uninstaller, and every other `.exe`
in the app with `osslsigncode`. The config pins `toolsets.winCodeSign: "1.1.0"` so the downloaded osslsigncode (2.11)
runs natively on Apple silicon. `dist.mjs` then signs the MSI with the same osslsigncode and certificate.

**Workaround applied:** electron-builder 26.15.3 starts osslsigncode with `execFile`, which gives it a stdin pipe.
With a stdin pipe, osslsigncode 2.11 cannot open a password-protected `.pfx` ("Failed to read certificate from:
(null)" / "passphrase callback error"). The same command succeeds with stdin redirected from `/dev/null`. So when a
certificate is set, `dist.mjs` sets `ELECTRON_BUILDER_OSSL_SIGNCODE_PATH` to `build/win/osslsigncode-wrapper.sh`,
which runs the real binary with `</dev/null`. If you call electron-builder directly with a certificate, use the same
wrapper.

When a certificate is set, the checks require every file to be signed: they run `osslsigncode verify` on
`Server Manager for SoftEther VPN.exe`, the setup and the MSI, record the signer, and require the digest to match. When no
certificate is set, the checks require the files to be unsigned. The whole path was run on this Mac with a
self-signed test certificate: the exe, setup and MSI were all signed and verified. Notes:

* EV and cloud HSM certificates (DigiCert KeyLocker, Azure Trusted Signing, and similar) cannot be exported as
  `.pfx`. Use electron-builder's `win.azureSignOptions`, or a custom `win.signtoolOptions.sign` hook, and sign the
  MSI with the vendor's tool.
* The setup-stub `.exe` files in `apps/desktop/resources/` are signed too when a certificate is set. If the app
  later modifies those stubs (appends a payload or edits resources), their signature becomes invalid, and they
  have to be re-signed at that point.

### The project's self-signed certificate (release workflow)

Releases built by `.github/workflows/release.yml` sign the Windows files with a self-signed code-signing
certificate (`CN=SoftEther Manager (self-signed)`, RSA 4096, valid until October 2036). The private key is held
only in the repository secrets `WIN_CSC_LINK` (base64 `.p12`) and `WIN_CSC_KEY_PASSWORD`; the public certificate is
`apps/desktop/build/codesign/SoftEther-Manager-codesign.cer` and is attached to every release.

SHA-256 fingerprint: `78:50:7A:2C:60:D3:81:46:DD:1D:3B:EB:6F:AD:72:69:49:6B:42:1B:6A:3B:BE:4F:3E:4B:A4:99:23:E5:B3:39`

A self-signed certificate is not trusted by Windows by default: until it is imported, the files show an unknown
publisher and SmartScreen still warns. What it gives is tamper detection and one stable publisher that an
administrator can trust once (Group Policy, Intune or by hand) for all current and future releases:

```powershell
# elevated PowerShell; check the fingerprint above first
Import-Certificate -FilePath SoftEther-Manager-codesign.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath SoftEther-Manager-codesign.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

macOS builds stay ad-hoc signed: a self-signed certificate does not satisfy Gatekeeper, which only accepts a
notarized Developer ID.

## What the checks prove

Every check runs on every build unless you pass `--no-verify`. The results are in `BUILD-REPORT.md`.

* **macOS, per architecture**
  * `lipo -archs` of the main executable.
  * `codesign --verify --deep --strict`, and `Signature=adhoc`, or a Developer ID authority when signed.
  * `Info.plist` bundle id, version, and local-network string.
  * `app.asar` holds only `dist/**` and `package.json`.
  * Fuse states (`@electron/fuses`).
  * DMG: `hdiutil verify`, then mounted with `hdiutil attach -nobrowse`. The volume contains the app, the
    `Applications` → `/Applications` symlink, a two-resolution `.background.tiff` and `.VolumeIcon.icns`, and the
    signature is still valid on the mounted copy.
  * ZIP: extracted with `ditto`. Framework symlinks are preserved and the signature is still valid.
  * Launch: the unzipped app is started with `open` (LaunchServices), and the process is checked. `dist.mjs`
    connects over the Chromium remote-debugging port, waits for the `file://…/app.asar/dist/renderer/index.html`
    page, and saves a renderer screenshot to `verification/mac/`. It also reads the native window from the
    window server (`build/verify/window-of-pid.swift`, which needs no permission). If the terminal has the Screen
    Recording permission, it also captures the real window, title bar included (`screencapture -l`, saved as
    `mac-<arch>-native-window.png`). Without the permission, that capture is skipped and the report says so. The x64 build
    is launched under Rosetta 2. Playwright's `_electron.launch` cannot drive the packaged app because the
    `--inspect` fuse is off, which is why the check attaches over CDP instead.
  * `spctl` (informational for ad-hoc builds).
* **Windows, per architecture**
  * `Server Manager for SoftEther VPN.exe` is parsed with `resedit`:
    * PE machine type (`0x8664` for x64, `0xAA64` for arm64);
    * version strings (`ProductName`, `FileVersion`, `ProductVersion`, `CompanyName`, `LegalCopyright`) and the
      fixed version;
    * every icon image is byte-identical to `build/icon.ico` (16 to 256 px);
    * the `ELECTRONASAR` integrity resource.
  * Fuse states.
  * `app.asar` contents, and `extraResources` present.
  * The zip is byte-identical to `win-unpacked` (SHA-256 of every file).
  * The NSIS setup is an x86 PE with the `NullsoftInst` header, version resources, and the icon.
  * Authenticode signature present or absent, as expected.
* **MSI**
  * `msiinfo suminfo`: `x64;1033` template, schema 500.
  * The table list.
  * `Property`: name, version, manufacturer, UpgradeCode, `ALLUSERS=1`, ARP icon, secure `DESKTOPSHORTCUT`.
  * The `File` table row count and total size match `win-unpacked`.
  * `Upgrade` rows, with `RemoveExistingProducts` scheduled after `InstallValidate`.
  * Shortcut targets, directories, the desktop condition, and the AppUserModelID.
  * `Registry` and `Icon`.
  * Authenticode.
  * `msiextract` into a temp directory, then a byte-for-byte comparison of every file against `win-unpacked`.

### What cannot be verified on this Mac

* Actually running the Windows builds: installing, upgrading and uninstalling with `msiexec` or NSIS, shortcut
  creation, Add/Remove Programs display, SmartScreen, and first launch on Windows x64 or arm64. The checks above
  prove the files are well formed and contain the right bits. Only a Windows machine or VM proves they install.
  A minimal manual test on Windows:
  `msiexec /i … /qn /l*v i.log` → launch from the Start menu → `msiexec /i <newer>.msi /qn` (upgrade in place,
  one entry in Add/Remove Programs) → `msiexec /x … /qn`.
* Developer ID signing and notarization (no Apple Developer account here). The ad-hoc path is verified. The
  Developer ID path is electron-builder's standard flow, switched on by the environment variables above.
* Windows code signing with a CA-issued certificate, and SmartScreen reputation. The pipeline was run with a
  self-signed certificate only, which proves the mechanics, not the trust.
* An MSI for Windows on Arm: wixl has no arm64 target (`-a` accepts x86/x64/ia64). The x64 MSI installs on Windows
  11 on Arm and runs under x64 emulation. For native arm64, use the arm64 NSIS setup or zip.

## End-to-end check of the packaged app

`pnpm run smoke:packaged` (`scripts/smoke-packaged.mjs [--arch=arm64|x64] [--port=16201]`) runs after `pnpm run dist`.
The launch check in `dist.mjs` only proves the window loads. This one proves the packaged app works against a real
server:

1. Extracts `release/Server-Manager-for-SoftEther-VPN-<v>-mac-<arch>.zip` with `ditto` (the shipped file, not the staging copy)
   and runs `codesign --verify --deep --strict` on it.
2. Starts a throwaway `vpnserver` from `SE_BUILD_DIR` (default `~/se-build/src/build`) in `~/se-desk-release`, in its
   own process group, with one listener on port 16201, and sets an administrator password over JSON-RPC.
3. Starts the app with `open -n` on an empty data directory (`SEM_DATA_DIR`, `SEM_INSECURE_KEYSTORE=1` so no Keychain
   prompt appears) and a Chromium remote-debugging port, and attaches Playwright over CDP. Playwright's
   `_electron.launch` cannot drive the packaged app, because the `RunAsNode` and `--inspect` fuses are off.
4. Through the UI: Welcome > Add Connection over the Native transport, then a second connection over JSON-RPC.
   For each, it checks the fingerprint the app shows against an independent TLS handshake, trusts it, waits for
   *Online*, and checks that the overview shows the product name the server reports over JSON-RPC. Finally the
   sidebar must read "2 of 2 online".
5. Writes screenshots (renderer via CDP; the real window with `screencapture -l` when the terminal has the Screen
   Recording permission) and `result.json` to `release/verification/packaged-smoke/`. `dist.mjs` does not delete
   that folder.
6. Always stops the app and kills the vpnserver process group, and records in `result.json` that neither is still
   running.

## Icons

`build/icons/generate.mjs` (`pnpm run icons`) draws everything in code with `build/icons/raster.mjs`, a small
dependency-free renderer (distance-field shapes, OKLab gradients, TrueType outlines, PNG encoder). There are no
vector sources and no browser is involved. It needs macOS (`iconutil`, and Avenir Next for the DMG text) and writes:

* `build/icon.png`: 1024 px, macOS Big Sur grid (an 824 px squircle plate with a drop shadow).
* `build/icon.icns`: 16 to 1024 px, made with `iconutil`.
* `build/icon.ico`: 16, 20, 24, 32, 40, 48, 64, 96 and 128 px as 32-bit BMP, and 256 px as PNG. The Windows
  variant has no outer shadow and a plate that nearly fills the canvas.
* `build/background.png` and `background@2x.png`: the DMG window.
* `src/renderer/assets/app-icon.png`: the 256 px icon shown inside the app.

The mark is a hub: a hexagonal frame with three links meeting at a centre node, amber on charcoal. Each icon is
drawn once at 1024 px and area-averaged down in linear light for the smaller sizes.

## Files

| Path | Purpose |
|---|---|
| `apps/desktop/electron-builder.config.mjs` | electron-builder configuration: `createConfig({ appDir, outDir })`, signing switches |
| `apps/desktop/scripts/dist.mjs` | The pipeline: build, stage, package, MSI, verify, report |
| `apps/desktop/scripts/smoke-packaged.mjs` | `pnpm run smoke:packaged`: end-to-end check of the packaged macOS app (see below) |
| `apps/desktop/installer/msi.mjs` | WiX generator and MSI build: UpgradeCode, `renderWxs`, `buildAppMsi` |
| `apps/desktop/build/` | `icon.*`, DMG background, entitlements, `icons/generate.mjs`, `verify/window-of-pid.swift`, `win/osslsigncode-wrapper.sh` |
| `apps/desktop/resources/` | Extra files shipped in `resources/resources/` (owned by the app core) |
| `apps/desktop/release/` | Output (git-ignored) |
