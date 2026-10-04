# SoftEther Manager

A desktop app for macOS and Windows that manages **SoftEther VPN Servers**. It works like SoftEther's own Server
Manager (`vpnsmgr`), but it runs natively on a Mac as well as on Windows. It keeps many servers open side by side and
covers the whole admin API: listeners, Virtual Hubs, users, groups, policies, access lists, cascades, SecureNAT,
bridges, L3 switches, protocols, certificates, clustering, logs and configuration backups. It also builds client
deployment files: `.vpn` connection profiles and silent-install **MSI** packages for Windows.

Built with Electron 44, React 19 and Mantine 9. Version 1.0.0.

![Fleet overview](apps/desktop/design-screenshots/final/01-fleet-light.png)

| | |
|---|---|
| ![New connection](apps/desktop/design-screenshots/final/07-sheet-add-connection-light.png) | ![Users of a Virtual Hub](apps/desktop/design-screenshots/final/03-hub-05-users-dark.png) |
| ![Server overview](apps/desktop/design-screenshots/final/02-server-01-1-dark.png) | ![Client installers](apps/desktop/design-screenshots/final/04-deploy-05-installers-light.png) |

More screenshots, in light and dark mode, are in [`apps/desktop/design-screenshots/final/`](apps/desktop/design-screenshots/final).

## How it works

### Connections, like vpnsmgr

There are no accounts to sign in to. Whoever runs the app is the administrator, as with SoftEther's Server Manager.
You add a **connection setting** with:

* a name, the host, and a listener port (443 by default; 992, 1194 and 5555 also work);
* the administrator password, or, in **hub-admin mode**, a Virtual Hub name and that hub's password;
* **Save password** on or off. A saved password is encrypted on disk. An unsaved one is asked for on connect and kept
  in memory only; the connection shows as *Locked* after a restart until you unlock it.

The sidebar lists every connection with its live status. The fleet overview totals them. **Cmd/Ctrl+K** opens a
quick switcher for servers and hubs.

### Two transports: Native and JSON-RPC

Each connection picks a transport under *Advanced*. Both take and return the same data, so every page works with
either.

| Transport | What it is | When to use it |
|---|---|---|
| **Native** (default) | SoftEther's binary PACK admin RPC over TLS: the same protocol `vpnsmgr` and `vpncmd /SERVER` use. Implemented in TypeScript in the app (`src/main/softether/pack.ts`, `native.ts`). | Always works, including when the server's JSON-RPC API is turned off (`DisableJsonRpcWebApi true`). |
| **JSON-RPC** | The server's `https://<host>:<port>/api/` JSON-RPC 2.0 endpoint. | When you prefer the documented web API. It must be enabled on the server (it is by default). If it is off, the app says so and points you to Native. |

Both transports reach all 148 admin RPCs in SoftEther's `Admin.c` (the list is in
`packages/api-catalog/catalog.json`).

## Features

| Area | What you get |
|---|---|
| Fleet | Many servers side by side, live status in the sidebar, fleet overview, bulk RPC across servers (with confirmation), quick switcher |
| Server | Status, TCP listeners, UDP ports, connections, keep-alive, syslog, DDNS, capabilities, license |
| Security | Server certificate (view, upload, regenerate) with re-pinning, cipher selection, admin password change |
| Virtual Hubs | Create and delete, properties, admin and extended options, client message, RADIUS, trusted CAs, CRLs, source-IP ACL, logging |
| Identity | Users (password, certificate, root certificate, RADIUS, NT), groups, every security-policy field, CSV import and export |
| Traffic | Sessions (details, disconnect), MAC and IP tables, access lists (IPv4/IPv6, ports, MAC, TCP state, delay/jitter/loss) |
| Networking | Cascade (site-to-site) links, SecureNAT (NAT and DHCP), local bridges and TAP, Layer 3 switches |
| Protocols | OpenVPN and SSTP (with OpenVPN config download), IPsec/L2TP/EtherIP, WireGuard keys, per-protocol options |
| Cluster | Farm settings, members, controller status |
| Config | Live configuration viewer, scheduled and on-demand versioned backups, diff (backup to backup, backup to live), restore |
| API console | Every admin RPC with a generated form, risk badges and history |
| Deployment | Client packages (ZIP of the SoftEther client files), templates and branding, per-hub and per-user `.vpn` profiles, **MSI builder** |
| App | Native menus and Save/Open dialogs, light and dark mode (follows the system, or set in Preferences), keyboard navigation, dangerous actions behind confirmation dialogs |

The design system and the rules for pages are in [`docs/desktop-design.md`](docs/desktop-design.md). The process
model, the IPC bridge and the transport contract are in [`docs/desktop-architecture.md`](docs/desktop-architecture.md).

## Install

Download the file for your platform from `apps/desktop/release/` (or from wherever you publish the build).

### macOS (13 Ventura or later)

| File | For |
|---|---|
| `SoftEther-Manager-1.0.0-mac-arm64.dmg` / `.zip` | Apple silicon (M1 and later) |
| `SoftEther-Manager-1.0.0-mac-x64.dmg` / `.zip` | Intel Macs |

Open the `.dmg` and drag **SoftEther Manager** to **Applications**.

The build is **ad-hoc signed, not signed with an Apple Developer ID, and not notarized**. Gatekeeper therefore
blocks a copy that was downloaded. To open it the first time, do one of the following:

* In Finder, right-click (or Control-click) the app, choose **Open**, then **Open** again. On macOS 15 and later,
  if there is no Open button, go to *System Settings > Privacy & Security* and click **Open Anyway**.
* Or remove the quarantine flag in Terminal:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/SoftEther Manager.app"
  ```

The first time the app connects to a server on your local network, macOS 15 and later asks for **Local Network**
access. Allow it.

### Windows 10 and 11 (x64 and arm64)

| File | What it is |
|---|---|
| `SoftEther-Manager-1.0.0-win-x64.msi` | Per-machine MSI for managed deployment (Intune, GPO, SCCM). x64; also runs on Windows on Arm under emulation. |
| `SoftEther-Manager-1.0.0-win-x64-setup.exe` / `-win-arm64-setup.exe` | NSIS installer: per-user or all-users, choice of folder, Start-menu and desktop shortcuts |
| `SoftEther-Manager-1.0.0-win-x64.zip` / `-win-arm64.zip` | Portable build, no installer |

The Windows files are **unsigned**, so SmartScreen warns on first run (*More info > Run anyway*).

Silent MSI install, upgrade and uninstall (from an elevated prompt):

```bat
msiexec /i SoftEther-Manager-1.0.0-win-x64.msi /qn
msiexec /i SoftEther-Manager-1.0.0-win-x64.msi /qn DESKTOPSHORTCUT=0 INSTALLDIR="D:\Apps\SoftEther Manager\"
msiexec /i SoftEther-Manager-1.1.0-win-x64.msi /qn        :: a newer MSI upgrades in place
msiexec /x SoftEther-Manager-1.0.0-win-x64.msi /qn        :: uninstall
msiexec /i SoftEther-Manager-1.0.0-win-x64.msi /qn /l*v install.log
```

The MSI installs to `C:\Program Files\SoftEther Manager\` and keeps a fixed UpgradeCode, so every newer MSI
replaces the installed one. It has no wizard; for an interactive install, use the NSIS setup. Install either the
MSI or the NSIS setup, not both: they are separate products. Both keep your data on uninstall.

### Where your data is

| | |
|---|---|
| macOS | `~/Library/Application Support/SoftEther Manager/` |
| Windows | `%APPDATA%\SoftEther Manager\` |

It holds `sem.db` (connections, settings, backups index), `files/` (client packages and built installers) and
`master.key.sealed`.

## Security

* **Passwords at rest.** Saved server passwords and deployment credentials are encrypted with AES-256-GCM. The key
  is stored in `master.key.sealed`, which is itself encrypted with Electron **`safeStorage`**: the macOS Keychain
  or Windows DPAPI. Without a usable `safeStorage` (for example Linux without a keyring, or tests with
  `SEM_INSECURE_KEYSTORE=1`), the key is stored in plain hex with file mode 600.
* **TLS pinning.** SoftEther servers ship self-signed certificates. On first connect, the app shows the
  certificate's SHA-256 fingerprint for you to confirm (trust on first use), pins it, and then refuses any other
  certificate. After you regenerate or replace a server certificate, you confirm the new fingerprint on the
  Certificate page or in the connection settings. Two other modes exist under *Advanced*: verify against a CA you
  provide, or do not verify (this needs an explicit acknowledgement).
* **Renderer isolation.** The UI runs with `contextIsolation`, `sandbox` and no Node integration, under a strict
  Content Security Policy. It talks to the main process through a small IPC bridge. The app API runs in the
  main process and never listens on a network port. Navigation away from the app is blocked, and only
  `https:`, `http:` and `mailto:` links open externally.
* **Hardened packaging.** Electron fuses: `RunAsNode`, `NODE_OPTIONS` and `--inspect` are off; asar integrity
  validation is on; the app loads only from its asar archive; cookie encryption is on.
* **Dangerous actions** (deleting a hub, restoring a configuration, changing certificates, bulk runs, rebooting)
  need a confirmation. Deleting asks you to type the name.

## Build the installers (on a Mac)

Every installer, for macOS and for Windows, is built on a Mac. You do not need Windows, Wine or a virtual machine.

```sh
brew install msitools          # wixl and msiinfo, used for the MSI
pnpm install --frozen-lockfile                         # from the repository root, once
cd apps/desktop
pnpm run dist                   # all installers: mac arm64 + x64 (dmg, zip), win x64 + arm64 (NSIS, zip), win x64 MSI
pnpm run dist:mac               # macOS only
pnpm run dist:win               # Windows only, with the MSI
pnpm run smoke:packaged         # start the packaged arm64 app against a real vpnserver and add connections through the UI
```

The output goes to `apps/desktop/release/`. `BUILD-REPORT.md` lists every file with its size and SHA-256, and every
check that ran. `SHA256SUMS` can be checked with `shasum -a 256 -c SHA256SUMS`. The checks cover code signatures,
Electron fuses, the asar contents, the DMG and ZIP layout, PE headers and version resources of the Windows files,
every MSI table, and a byte-for-byte comparison of the MSI and ZIP contents with the unpacked app. They also start
the packaged Mac apps (x64 under Rosetta 2) and take screenshots.

The build runs in `$TMPDIR/sem-desktop-dist` because the `.app` bundles need symlinks and this repository can live on
an exFAT volume. Signing with an Apple Developer ID and notarization, or with a Windows code-signing certificate,
are switched on by environment variables only. See [`docs/desktop-packaging.md`](docs/desktop-packaging.md).

Development:

```sh
cd apps/desktop
pnpm run dev                    # watch main/preload, Vite dev server, start Electron against it
pnpm run build && pnpm start     # production build of dist/, then start it
pnpm run typecheck              # main + renderer
```

## Tests

The tests are end-to-end only. `pnpm run e2e:desktop` (from the repository root) runs the Playwright suite in
[`e2e-desktop/`](e2e-desktop). It builds the real app and drives it with Playwright's `_electron`, against:

* two real SoftEther VPN Servers built from source: **A** with the JSON-RPC API turned off (reached over the Native
  transport and checked with `vpncmd`), and **B** with an admin password (reached over JSON-RPC);
* a real SoftEther VPN Client, which must accept the `.vpn` files the app generates.

It needs the SoftEther binaries in `SE_BUILD_DIR` (default `~/se-build/src/build`) and msitools. The 34 tests cover the
first run and certificate trust, both transports, wrong passwords, a disabled JSON-RPC API, locked connections
after a restart, hubs, users, groups, policies, access lists, SecureNAT, a real cascade VPN session between the two
servers, listeners, the API console, bulk runs, backup/diff/restore, a password change, certificate re-pinning,
every server and hub page, `.vpn` import into the real client, and an MSI checked with `msiinfo` and `msiextract`.
Every result is checked against the servers directly, not only in the UI.

Each run writes `e2e-desktop/artifacts/SUMMARY.md` (every test with its status and notes, and the SHA-256 of every
generated file), an HTML report, the screenshots, and the generated `.vpn` and `.msi` files.

`pnpm run smoke:packaged` (in `apps/desktop`) does the same kind of check on the **packaged** app: it unzips the
release `.zip`, starts a real vpnserver on port 16201, adds a Native and a JSON-RPC connection through the UI, and
saves screenshots and `result.json` to `apps/desktop/release/verification/packaged-smoke/`.

## Limitations

Not verified on the build machine:

* **Installing on Windows.** The MSI, the NSIS setup and the zip are checked structurally (PE headers, resources,
  MSI tables, file-by-file contents) but have not been installed, upgraded or uninstalled on a real Windows machine.
  Before a rollout, run `msiexec /i … /qn /l*v install.log` on a clean Windows 11 VM, start the app from the Start
  menu, upgrade with a newer MSI, and uninstall.
* **Apple Developer ID signing and notarization.** No Apple Developer account was available. The ad-hoc path is
  verified; the Developer ID path is electron-builder's standard flow.
* **Windows code signing** with a CA-issued certificate. The pipeline was run with a self-signed certificate only.
* **Client deployment from the official SoftEther installer.** Extracting the client files from the official
  `vpnclient` self-extracting installer (SFX), importing it from GitHub, and wrapping an MSI in a branded
  `setup.exe` were **not verified on this machine**. The endpoint antivirus on the build Mac quarantines such
  executables, so the tests use a ZIP of non-executable placeholder files plus the real `hamcore.se2`.
* There is no native arm64 MSI (`wixl` cannot build one). Use the arm64 NSIS setup or zip on Windows on Arm.

## Repository layout

```
apps/desktop          the desktop app (Electron main, preload, React renderer, packaging, installers)
e2e-desktop           the desktop E2E suite
packages/api-catalog  the SoftEther admin RPC catalog (methods, types, enums, errors, risk classification)
docs/                 desktop-architecture.md, desktop-design.md, desktop-packaging.md, research/
tools/                catalog generator, setup-stub source, development helpers
apps/server, apps/web the legacy web edition (see below)
```

### Legacy web edition

`apps/server` (Node + Fastify) and `apps/web` (React) are the earlier **multi-user web edition**: a server you host,
with local accounts, roles, MFA, API tokens and an audit log, reached over JSON-RPC only. The desktop app was ported
from it and replaces it. It is kept in the repository **for reference only** and is not developed further. Its
own E2E suite is `pnpm run e2e` ([`e2e/`](e2e)), and its hosting notes are in [`docs/operations.md`](docs/operations.md)
(with `Dockerfile` and `deploy/`). The research on how SoftEther clients can be deployed silently, which both
editions use, is in [`docs/research/client-deployment.md`](docs/research/client-deployment.md).
