# SoftEther VPN Client: silent Windows deployment with a preconfigured profile

Research date: 2026-09-27. Source tree: `vendor/SoftEtherVPN` (Developer Edition master, last commit 2026-09-22, CMake `BUILD_NUMBER` 5187, version `5.02.<build>`).
Every path below is relative to `vendor/SoftEtherVPN/` unless it is a URL. "Stable" means github.com/SoftEtherVPN/SoftEtherVPN_Stable (master), which I fetched raw for comparison.

---

## TL;DR

* **Neither installer can install silently.** No `.msi` and no Windows `.zip` of the client exist for either edition. `vpnsetup` is a wizard that always shows its GUI. It has no `/S`, `/SILENT` or `/QUIET` flag. The only flags are internal ones (listed in §2). Upstream issue #195 ("no silent install", opened 2015) is still open.
* The **Easy Installer** (a setup exe with the connection settings built in) is **not silent either**. It runs the same wizard and then starts the GUI `vpncmgr.exe` as the user to import the `.vpn` file.
* **What works is repackaging.** Put the four payload files (`vpnclient.exe`, `vpncmd.exe`, `vpncmgr.exe`, `hamcore.se2`) straight into your own MSI. Register the service with `ServiceInstall`. Then run a deferred custom action (running as SYSTEM) that uses `vpncmd` to do `NicCreate`, `AccountImport`, `AccountStartupSet` and `AccountConnect`.
  * **Catch:** on Windows, `NicCreate` does not install the driver inside the service. The service forwards the request over TCP port 9984 to a "UI Helper" process (`vpnclient.exe /uihelp`), and that process runs `vpndrvinst.exe`. The helper must be running before you call `NicCreate`. Otherwise you get error 31. See §4.3.
* The Developer Edition's Win10 NIC drivers (`Neo6_Win10`) are **attestation-signed by Microsoft** ("Microsoft Windows Hardware Compatibility Publisher"). That means no "trust this publisher" prompt on Windows 10/11.
* `HashedPassword` in a `.vpn` file is `Base64( SHA-0( password_bytes || ASCII_UPPER(username_bytes) ) )`. SHA-0 is not SHA-1 (§5.3). `EncryptedPassword` (RADIUS/NT auth) is RC4 with a key whose length depends on the pointer size (§5.4). Do not generate it offline. Use `AccountPasswordSet` instead.
* wixl 0.106 supports the custom-action types this plan needs (18 and 50, deferred, no-impersonate). Two differences from real WiX: it does **not** support `BinaryKey`+`ExeCommand`, `Directory`+`ExeCommand` or `HideTarget`, and **deferred actions default to Impersonate=no** (the opposite of WiX). See §6.

---

## 1. Windows installers that exist today

### 1.1 Developer Edition 5.x (github.com/SoftEtherVPN/SoftEtherVPN/releases)

`gh api repos/SoftEtherVPN/SoftEtherVPN/releases/latest` returns **`5.2.5188`**, published 2025-07-18. It is the newest release; the ones before it are 5.02.5187 and 5.02.5186 (both 2024-09-09).

Assets of 5.2.5188. The file names still say `5.02.5187`, because the CI `BUILD_NUMBER` was not bumped.

```
https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.2.5188/softether-vpnclient-5.02.5187.x64.exe
https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.2.5188/softether-vpnclient-5.02.5187.x86.exe
https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.2.5188/softether-vpnserver_vpnbridge-5.02.5187.x64.exe
https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.2.5188/softether-vpnserver_vpnbridge-5.02.5187.x86.exe
https://github.com/SoftEtherVPN/SoftEtherVPN/releases/download/5.2.5188/SoftEtherVPN-5.2.5188.tar.xz
```

The pattern is `.../releases/download/<tag>/softether-vpnclient-<VERSION>.<BUILD_NUMBER>.<x64|x86>.exe`.
* There is **no `.msi` and no `.zip`**. There is also no arm64 asset, even though `.github/workflows/windows_release.yml:35-37` builds arm64.
* These exes are produced by `vpnsetup /SFXMODE:vpnclient /SFXOUT:"installers\softether-vpnclient-%VERSION%.%BUILD_NUMBER%.%ARCHITECTURE%.exe"` (`.github/workflows/windows_release.yml`, "cmake --build" step).
* That workflow has no code-signing step, so assume the 5.x release binaries are **not Authenticode-signed**. This is an inference from the workflow. I did not check an actual binary.

### 1.2 Stable 4.x (softether-download.com and github.com/SoftEtherVPN/SoftEtherVPN_Stable/releases)

The latest is **v4.44-9807-rtm (2025-04-16)**. It is the last entry in https://www.softether-download.com/files/softether/, and the newest release/tag in SoftEtherVPN_Stable (published there 2025-05-07).

* Client: `https://www.softether-download.com/files/softether/v4.44-9807-rtm-2025.04.16-tree/Windows/SoftEther_VPN_Client/softether-vpnclient-v4.44-9807-rtm-2025.04.16-windows-x86_x64-intel.exe`
* The same file on GitHub: `https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/releases/download/v4.44-9807-rtm/softether-vpnclient-v4.44-9807-rtm-2025.04.16-windows-x86_x64-intel.exe`
* URL pattern: `https://www.softether-download.com/files/softether/v<ver>-<build>-<rtm|beta>-<yyyy.mm.dd>-tree/Windows/SoftEther_VPN_Client/softether-vpnclient-v<ver>-<build>-<rtm|beta>-<yyyy.mm.dd>-windows-x86_x64-intel.exe`
* The only Windows `.zip` is **admin tools only** (vpnsmgr + vpncmd, no client service or driver): `.../Windows/Admin_Tools/VPN_Server_Manager_and_Command-line_Utility_Package/softether-vpn_admin_tools-v4.44-9807-rtm-2025.04.16-win32.zip`. `files.txt` in the tree describes it as "Windows (.zip package without installers)".
* There is no `.msi`.

### 1.3 Edition differences that matter for automation

| | Dev 5.x | Stable 4.x |
|---|---|---|
| Service name | `SEVPNCLIENTDEV` (`src/GlobalConst.h:43`) | `SEVPNCLIENT` (Stable `src/GlobalConst.h:141`) |
| Default install dir | `%ProgramFiles%\SoftEther VPN Client Developer Edition` (`SW.c:4464-4465`, DefaultDirName = `SW_LONG_VPNCLIENT` `SW.c:5826`, string `strtable_en.stb:7369`) | `%ProgramFiles%\SoftEther VPN Client` (Stable `strtable_en.stb:7126`) |
| Binaries | `vpnclient.exe`, `vpncmd.exe`, `vpncmgr.exe` (one arch per installer; `SW.c:2488-2490`) | x64: `vpnclient_x64.exe`, `vpncmd_x64.exe`, `vpncmgr_x64.exe`. The x86 copies are also installed ("gomi"). Stable `SW.c:2675-2690` |
| Uninstall key | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\softether_sedevvpnclient` (`SW.c:3624-3625` + `GC_SW_SOFTETHER_PREFIX "sedev"` `GlobalConst.h:58`) | `...\softether_sevpnclient` (prefix `"se"`, Stable `GlobalConst.h:156`) |
| UI Helper Run value | `HKLM\...\Run\SoftEther VPN Client UI Helper Developer Edition` (`GlobalConst.h:57`, `SW.c:3499-3512`) | `...\Run\SoftEther VPN Client UI Helper` (Stable `GlobalConst.h:155`) |
| Company reg root | `HKLM|HKCU\Software\SoftEther VPN Developer Edition` (`GlobalConst.h:50`) | `Software\SoftEther Project` |

---

## 2. Does vpnsetup support silent install? **No.**

**Two stages.** The downloaded exe is an SFX stub, `vpnsetup.exe` with `DATAFILE` resources attached.
* `SWExec()` checks for `DATAFILE` resources (`src/Cedar/SW.c:647-683`). If they are present, it runs `SwSfxModeMain()` (`SW.c:610`). That shows an extraction dialog and extracts each resource to `%TEMP%\VPN_xxxx` (`SwSfxExtractProcess`, `SW.c:355-520`).
* It then starts the extracted `vpnsetup.exe`. It passes along the original command line plus `/CALLERSFXPATH:"<copy of itself>"` and `/ISEASYINSTALLER:<0|1>` (`SW.c:474-495`), and waits for the child (`SW.c:621-625`).

**The full command-line grammar** is `SwParseCommandLine`, `SW.c:6139-6214`. Stable is identical (Stable `SW.c` ~6504-6575). Flags use SoftEther's `/NAME:value` syntax, and `GetParamYes` accepts `yes`, `true` or `1`.

| Flag | Meaning |
|---|---|
| `/UAC:yes` | Internal. Marks the re-exec after UAC elevation. It jumps the wizard to the Components page (install) or Perform page (uninstall/lang), but the GUI still shows (`SW.c:5594-5720`). |
| `/LANGUAGE:yes` `/LANGID:n` `/LANGNOW:yes` `/SETLANGANDREBOOT:yes` | Language-change mode. |
| `/EASY:yes` | Opens the **Easy Installer creation** wizard (`D_SW_EASY1`). This is GUI and not silent. Shortcut: `SW.c:2578`. |
| `/WEB:yes` | Opens the Web installer creation wizard (GUI). |
| `/SFXMODE:vpnclient` + `/SFXOUT:<path>` | **Headless build step, not an install.** It packs `vpnsetup.exe`, `vpnclient.exe`, `vpncmgr.exe`, `vpncmd.exe` and `hamcore.se2` from the exe's own directory into a new SFX (`SW.c:75-97`, `SW.c:231-275`, file list `SW.c:57-66`). Used by CI. |
| `/HIDESTARTCOMMAND:yes` | Hides the "start the program now" checkbox on the finish page (`SW.c:1556`, `1587`). |
| `/CALLERSFXPATH:<path>` | Internal. The SFX path, which gets cached as `installer.cache` in the install dir (`SW.c:2498-2510`). |
| `/ISEASYINSTALLER:yes`, `/ISWEBINSTALLER:yes` | Internal. Prevents choosing the "tools only" component (`SW.c:5998-6006`). |
| `/DISABLEAUTOIMPORT:yes` | Skips importing `auto_connect.vpn` after install (`SW.c:3568`). |
| `/SUINSTMODE:yes` | Installs only the SeLow driver and exits (`SW.c:6259-6266`). This is the only mode with no UI, and it is irrelevant to the client (`SW.c:2929-2945` skips SeLow for the client). |

**Install mode always calls `SwUiMain()` → `ShowWizard()`** (`SW.c:6268-6309`, `SW.c:5548-5720`). The pages are Welcome, Mode, Components, EULA, Warning, Dir, Ready, Perform and Finish. There is no code path that skips them.
* Errors while installing are shown with `SwPerformMsgBox` Retry/Cancel dialogs (for example `SW.c:3373-3445`).
* Run from a SYSTEM/session-0 context (such as an MSI deferred CA), the wizard is **invisible and waits forever**.

**Uninstall** is the same exe. When `setuplog.dat` is next to it and no special mode is set, it switches to uninstall mode (`SW.c:6281-6300`). This is also a wizard (`D_SW_UNINST1`, `SW.c:5579-5600`). The `UninstallString` is just `"<dir>\vpnsetup.exe"` (`SW.c:3659-3661`).

**Community confirmation.**
* https://github.com/SoftEtherVPN/SoftEtherVPN/issues/195 (open, 34 comments, last activity 2024-12). The workarounds people post all bypass vpnsetup: unzip the binaries, run `New-Service sevpnclient "... /service"`, then run `vpncmd` (https://gist.github.com/checkin247/df20b55f55529b70d141b4db2cf5061a).
* https://github.com/spanishdexter/SoftEther-VPN-Client-Silent-Installer-Script starts vpnsetup, copies the files the SFX extracted to `%TEMP%`, runs `vpnclient_x64.exe /install`, and kills the wizard.

---

## 3. "Easy installer" / installer with built-in connection settings

### How it is created
It is created in the GUI only: `vpnsetup.exe /easy:true`, which is the Start-menu entry "Create Easy Installer" (`SW.c:2578`). `SwEasyMain` (`SW.c:2842-2895`) does the following:
1. Takes the chosen `.vpn` file.
2. Optionally strips the password and username with `CiEraseSensitiveInAccount` (`Client.c:1881-1927`).
3. Adds it to the SFX resource list as **`auto_connect.vpn`** (`SWInner.h:63-64`).
4. Optionally adds **`easy_mode.flag`** (`SWInner.h:70`) to make the Connection Manager start in "simple mode".
5. Calls `SwCompileSfx`, which uses `BeginUpdateResource`/`UpdateResourceA`.
   * The resource type is `DATAFILE` (`SWInner.h:95`).
   * Resource names are UPPERCASED file names.
   * Every file except `hamcore.se2` is stored compressed as `[4-byte big-endian original size][zlib stream]` (`SW.c:101-205`, `Mayaqua/Memory.c:878-937`, `ReadBufInt` = big-endian, `Memory.c:3059-3073`).
   * `hamcore.se2` is stored raw under the name `RAW_HAMCORE.SE2` (`SW.c:147-153`, `SW.c:390-399`).
   * The presence of any `.vpn` resource sets `is_easy_installer` (`SW.c:385-388`).

### How it is consumed
* `SwDetectComponents` looks for `auto_connect.vpn` **in the same directory as the running vpnsetup.exe** (`SW.c:5956-5968`). For an SFX, that is the `%TEMP%` extraction dir.
* **You can also use it without building an SFX.** Put `auto_connect.vpn` next to an extracted, non-SFX `vpnsetup.exe` (plus the payload files) and it is picked up.
* After files and service are installed, `SW.c:3561-3595` copies it to `%TEMP%\vpn_auto_connect.vpn` and runs **`vpncmgr.exe /normal "<file>"`** (or `/easy "<file>"` when the `@easy_mode.flag` exists) **as the logged-on user** (`MsRunAsUserExW`).
* vpncmgr then imports it through the GUI (`CM.c:12355-12390` for the arg parsing, `CM.c:11353-11356` for the import message, `CmImportAccountMainEx` `CM.c:6077`). It can show dialogs, for example on parse failure (`CM_ACCOUNT_PARSE_FAILED`) or overwrite confirmation.
* If a newer build is already installed, the wizard offers to apply only the settings (`SW.c:4753-4766`, `OnlyAutoSettingMode` `SW.c:4809`, `SW.c:2929`).

**Verdict:** the Easy Installer is still the interactive wizard, and it imports through a GUI running in the user's session. It cannot be driven silently.

---

## 4. Configure the client from the command line after install

### 4.1 Paths, service and ports
* `vpncmd`:
  * Dev 5.x: `C:\Program Files\SoftEther VPN Client Developer Edition\vpncmd.exe`.
  * Stable x64: `C:\Program Files\SoftEther VPN Client\vpncmd_x64.exe` (x86 `vpncmd.exe` is also present).
  * The first time vpncmd runs as admin, it copies a bootstrap `vpncmd.exe` (from `|vpncmdsys.exe`) to `%SystemRoot%\System32` and writes `HKLM\Software\<company>\VPN Command Line Utility` (`Command.c:939-990`, `Command.h:30-33`). The installer runs `vpncmd /?` on purpose to trigger this (`SW.c:3515-3524`).
* Service:
  * The service is `SEVPNCLIENTDEV` (Dev) or `SEVPNCLIENT` (Stable), binary path `"<dir>\vpnclient.exe" /service` (`SW.c:3395-3399`, `Microsoft.h:73`).
  * `vpnclient.exe` also understands the following (`Mayaqua/Microsoft.h:33-51`, `Microsoft.c:4150-4250`):
    * `/install`, `/uninstall`, `/start`, `/stop`, each with an optional **second token `/silent`** that suppresses the message boxes (`Microsoft.c:4162-4168`, `4338-4470`).
    * `/setup_install` and `/setup_uninstall` (silent; `Microsoft.c:4278-4312`).
    * `/uihelp` (the UI Helper, `Microsoft.c:4646-4649`).
  * All service modes need admin (`Microsoft.c:4262-4268`).
* Ports: the client RPC on localhost is **9931** (`GlobalConst.h:36`, used by `vpncmd localhost /CLIENT`). The notify / UI Helper listener is **9984** (`GlobalConst.h:37`).
* Config file: `<install dir>\vpn_client.config` (`Client.h:20`, "$" = DB dir = exe dir). The installer seeds it from `hamcore|empty.config` (`SW.c:2525-2528`).

### 4.2 vpncmd syntax
Top level is `vpncmd [host:port] [/CLIENT|/SERVER|/TOOLS] [/HUB:hub] [/ADMINHUB:x] [/PASSWORD:pw] [/IN:file] [/OUT:file] [/CSV] [/PROGRAMMING] [/CMD command args...]` (`Command.c:24737-24751`, `strtable_en.stb:4487`).
* `/CMD` runs exactly one command and exits. The exit code is the SoftEther error code of the last command, `0` = OK (`strtable_en.stb:4486`).
* `/IN` runs a batch file, but only the **last** command's code is returned. Use one `/CMD` per step if you need to check each one.
* Parameters that are left out are **prompted for** (`CmdPrompt`). Always pass them all.

```bat
set VPNCMD="C:\Program Files\SoftEther VPN Client Developer Edition\vpncmd.exe"

%VPNCMD% localhost /CLIENT /CMD VersionGet
%VPNCMD% localhost /CLIENT /CMD NicCreate VPN
%VPNCMD% localhost /CLIENT /CMD AccountImport "C:\Program Files\...\profile.vpn"
%VPNCMD% localhost /CLIENT /CMD AccountPasswordSet "Company VPN" /PASSWORD:secret /TYPE:standard
%VPNCMD% localhost /CLIENT /CMD AccountCertSet "Company VPN" /LOADCERT:c:\x\user.cer /LOADKEY:c:\x\user.key
%VPNCMD% localhost /CLIENT /CMD AccountServerCertSet "Company VPN" /LOADCERT:c:\x\server.cer
%VPNCMD% localhost /CLIENT /CMD AccountServerCertEnable "Company VPN"
%VPNCMD% localhost /CLIENT /CMD AccountRetrySet "Company VPN" /NUM:4294967295 /INTERVAL:15
%VPNCMD% localhost /CLIENT /CMD AccountStartupSet "Company VPN"
%VPNCMD% localhost /CLIENT /CMD AccountConnect "Company VPN"
%VPNCMD% localhost /CLIENT /CMD AccountStatusGet "Company VPN"
```

Argument definitions in `src/Cedar/Command.c`:

| Command | Parameters | Code |
|---|---|---|
| `NicCreate` | `[name]` | 3701 |
| `NicDelete` | `[name]` | 3744 |
| `AccountCreate` | `[name] /SERVER:host:port /HUB: /USERNAME: /NICNAME:` | 4231 |
| `AccountDelete` | `[name]` | 4570 |
| `AccountPasswordSet` | `[name] /PASSWORD: /TYPE:standard\|radius\|ntdomain` | 4724-4799 |
| `AccountCertSet` | `[name] /LOADCERT: /LOADKEY:` | 4801 |
| `AccountServerCertEnable` | `[name]` | 5602 |
| `AccountServerCertSet` | `[name] /LOADCERT:` | 5914 |
| `AccountConnect` | `[name]` | 6220 |
| `AccountDisconnect` | `[name]` | 6263 |
| `AccountRetrySet` | `[name] /NUM: /INTERVAL:` | 6645 |
| `AccountStartupSet` | `[name]` | 6710 |
| `AccountStartupRemove` | `[name]` | 6762 |
| `AccountExport` | `[name] /SAVEPATH:` | 6814 |
| `AccountImport` | `[path]` | 6961 |
| `RemoteEnable` | (no parameters) | 7037 |
| `KeepEnable` | (no parameters) | 7123 |

Notes from the code:
* **`AccountPasswordSet /TYPE:`**
  * `standard` → `AuthType=1`, and `HashedPassword` is computed from the **account's current Username** (`Command.c:4757-4761`). The username must already be right.
  * `radius` or `ntdomain` → `AuthType=2` with the plain password stored (`Command.c:4763-4768`). The type is prefix-matched with `StartWith`.
* **`AccountImport`**
  * It keeps the `AccountName` from the file. If an account with that name already exists, the new one is renamed to `Name (2)`, `Name (3)`, and so on (`CmdGenerateImportName` `Command.c:6931-6958`, strings `CM_IMPORT_NAME_1/2` `strtable_en.stb:921-922`). On reinstall or upgrade, **`AccountDelete` first** so you stay idempotent.
  * The file's `StartupAccount` flag is kept (`Client.c:1960`, `Client.c:7312`), so `AccountStartupSet` is optional if the file has `bool StartupAccount true`.
  * Import does not start a connection. Startup accounts auto-connect only when the service starts (`Client.c:10647`). So call `AccountConnect` once as well.
* **NIC names (Win8+)** must be `VPN`, `VPN2` … `VPN127` (`CiIsValidVLanRegulatedName`/`CiGenerateVLanRegulatedName`, `Client.c:2846-2887`, enforced in `Client.c:8257-8264`). Otherwise you get error 32. Spaces give `ERR_INVALID_PARAMETER` (`Client.c:8167-8172`).
  * If the account's `DeviceName` does not exist, `CiNormalizeAccountVLan` rewrites it to the first NIC (`Client.c:8838-8885`).
  * When the first NIC is created, all accounts are pointed at it (`Client.c:8286-8307`).
* **Error codes** (`Cedar.h:760-765`):

  | Code | Name |
  |---|---|
  | 30 | `ERR_VLAN_ALREADY_EXISTS` (treat as success on reinstall) |
  | 31 | `ERR_VLAN_INSTALL_ERROR` |
  | 32 | `ERR_VLAN_INVALID_NAME` |
  | 34 | `ERR_ACCOUNT_ALREADY_EXISTS` |
  | 35 | `ERR_ACCOUNT_ACTIVE` |

### 4.3 The `NicCreate` gotcha (important for MSI/SYSTEM contexts)
On Windows, `CtCreateVLan` inside the service does **not** install the driver itself. It calls `CncExecDriverInstaller("instvlan VPN")` (`Client.c:8276-8284`). That function connects to **`localhost:9984`** (`CncConnect`, `Client.c:1033-1042`, `948-981`) and asks whatever process is listening there to run the driver installer.
* The listener is the **UI Helper**, `vpnclient.exe /uihelp` → `CnStart()` (`Microsoft.c:4646-4649`, `Client.c:1686-1799`). The Connection Manager (vpncmgr) also provides it.
* The helper handles `exec_driver_installer` (`Client.c:1596-1599`) → `Win32CnExecDriverInstaller` (`Client.c:1392-1420`) → `MsExecDriverInstaller` (`Microsoft.c:1878-1960`).
* `MsExecDriverInstaller` copies `|vpndrvinst.exe` and `hamcore.se2` to the temp dir and `ShellExecuteEx`s `vpndrvinst.exe instvlan VPN`.
  * `vpndrvinst.exe` is built into hamcore (`src/vpndrvinst/CMakeLists.txt:37-42`) and has a `requireAdministrator` manifest (`:30-33`).
  * It reads the INF/CAT/SYS from `hamcore:DriverPackages/Neo6_Win10/<arch>/` (`vpndrvinst/Driver.c:52-67`).
* **If nothing is listening on 9984, NicCreate fails with error 31.** This matches https://github.com/SoftEtherVPN/SoftEtherVPN/issues/444 ("Unable to create virtual adapter from CMD", 2021 comment: "needs vpncmgr … to start first before running the vpncmd commands").
* The vpnsetup wizard avoids this by writing the Run key and starting `vpnclient.exe /uihelp` itself, then sleeping 3 s (`SW.c:3495-3513`).
* The helper **never exits** (an infinite loop, `Client.c:1729-1799`). Start it asynchronously and kill it by PID afterwards.
* If vpndrvinst fails, it shows a `MessageBox` (`vpndrvinst/Dialog.c:11-35`). In session 0 that box is invisible and blocks, so put a timeout around the whole configure step.
* The same path is used by `NicDelete` ("uninstvlan").
* **Other dialogs the service routes through the helper:**
  * The server-certificate confirmation (`CnCheckCert`, `Client.c:1438`) when `CheckServerCert` is true and the cert is unknown.
  * Password prompts.

  For unattended use, either pin `ServerCert` in the `.vpn` file, or set `CheckServerCert false` (or, on 5.x, `AddDefaultCA true` with a publicly trusted server certificate).

### 4.4 Driver signing
`src/bin/hamcore/DriverPackages/Neo6_Win10/x64/Neo6_x64_VPN.cat` has the signer chain *Microsoft Windows Hardware Compatibility Publisher ← Microsoft Windows Third Party Component CA 2012 ← Microsoft Root Certificate Authority 2010*. I checked this with `openssl pkcs7 -print_certs`. The INF has `DriverVer = 02/04/2018, 4.25.0.9658`.
* It is attestation-signed, so it installs on Windows 10/11 x64 with no "Would you like to install this device software?" prompt and no need to pre-seed `TrustedPublisher`.
* **Caveat:** Microsoft does not accept attestation signing for Windows Server editions. The Neo6 NIC may be refused or prompt on Server 2016+. Test there if you need it.
* There are 127 instance-named packages (`Neo6_x64_VPN.inf` … `VPN127`), one per allowed NIC name.
* Other Win8 packages (`Neo6_Win8`) are used below Win10 (`vpndrvinst/Driver.c:52-60`).

---

## 5. The `.vpn` account file format

### 5.1 Code that reads and writes it
* Export: `PcAccountExport` (`Command.c:6814-6887`) writes a UTF-8 BOM, then the `CM_ACCOUNT_FILE_BANNER` comment lines (`strtable_en.stb:958`), then `CiAccountToCfg` (`Client.c:1971-2001`) → `CiWriteAccountData` (`Client.c:10021-10070`), which calls `CiWriteClientOption` (`Client.c:9855-9920`) and `CiWriteClientAuth` (`Client.c:9797-9852`). It is serialised by `CfgFolderToBufEx(root, textmode=true, no_banner=true)`.
* Import: `PcAccountImport` (`Command.c:6961-7034`) → `CiCfgToAccount` (`Client.c:1929-1968`) → `CfgBufTextToFolder` (`Mayaqua/Cfg.c:777-812`) → `CiLoadClientAccount` (`Client.c:9367-9430`), `CiLoadClientOption` (`Client.c:9297-9364`), `CiLoadClientAuth` (`Client.c:9222-9294`).

### 5.2 Text grammar (Mayaqua/Cfg.c)
* A folder is `declare <name>` on its own line, then `{`, the contents, and `}` (`Cfg.c:1297-1318`, `1284-1293`).
* An item is `<type> <name> <value>`, one per line, separated by tab or space (`Cfg.c:1212-1261`, parser `Cfg.c:640-775`).
  * Types: `string`, `uint`, `uint64`, `bool`, `byte` (`Cfg.h:19-28`).
  * `bool` accepts `true`/`false` or non-zero.
  * `byte` values are **Base64** (`Cfg.c:1171-1173`, `749-765`).
* **Escaping** (`CfgEscape`, `Cfg.c:1411-1455`): names and values can't contain spaces or tabs.
  * Bytes 0x00-0x1F, space, tab and `$` become `$XX` (uppercase hex).
  * An empty string is written as a single `$`.
  * So `Company VPN` is written `Company$20VPN`. Strings are UTF-8.
* Lines that are not `declare`, not `}` and don't have 3 tokens are ignored, so `#` comment lines work. **But a UTF-8 BOM glued directly to `declare root` breaks parsing**, because the first token becomes `\xEF\xBB\xBFdeclare`. Exports avoid this by putting the BOM on the banner comment line. Keep a comment line first, or write the file without a BOM.
* The writer emits items sorted by name and then sub-folders (`Cfg.c:1106-1139`). The reader doesn't care about order.
* The top-level folder **must** be `root` (`Cfg.c:799-806`). It must contain both `ClientOption` and `ClientAuth` folders, or import fails with "parse failed" (`Client.c:9384-9387`).

### 5.3 Password hashing (AuthType 1)
`HashPassword(dst, username, password)`, `src/Cedar/Account.c:556-575`:
```
HashedPassword = SHA0( password_bytes || StrUpper(username_bytes) )   // 20 bytes, then Base64 in the .vpn file
```
* `Sha0` is SoftEther's internal **SHA-0** (`Mayaqua/Encrypt.c:251-260`, `Internal_Sha0` at `Encrypt.c:4932`). Stable uses `Hash(..., true)`, which is also SHA-0.
* `StrUpper` is ASCII-only.
* The password comes first, then the uppercased username. There is no separator and no salt.
* Python's hashlib has no SHA-0, but a pure-Python version is short. The one below passes the SHA-0("abc") = `0164b8a914cd2a5e74c4f7ff082c4d97f1edf880` test vector (I ran it). I have **not** checked it against a hash produced by a real SoftEther client.

```python
import struct, base64
def sha0(data: bytes) -> bytes:
    h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
    ml = len(data) * 8
    data += b'\x80' + b'\x00' * ((55 - len(data)) % 64) + struct.pack('>Q', ml)
    rol = lambda x, n: ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF
    for i in range(0, len(data), 64):
        w = list(struct.unpack('>16I', data[i:i+64]))
        for t in range(16, 80):
            w.append(w[t-3] ^ w[t-8] ^ w[t-14] ^ w[t-16])      # SHA-0: no rotate-left-1 here
        a, b, c, d, e = h
        for t in range(80):
            if t < 20:   f, k = (b & c) | (~b & d), 0x5A827999
            elif t < 40: f, k = b ^ c ^ d, 0x6ED9EBA1
            elif t < 60: f, k = (b & c) | (b & d) | (c & d), 0x8F1BBCDC
            else:        f, k = b ^ c ^ d, 0xCA62C1D6
            a, b, c, d, e = (rol(a, 5) + f + e + k + w[t]) & 0xFFFFFFFF, a, rol(b, 30), c, d
        h = [(x + y) & 0xFFFFFFFF for x, y in zip(h, [a, b, c, d, e])]
    return b''.join(struct.pack('>I', x) for x in h)

def softether_hashed_password(username: str, password: str) -> str:
    return base64.b64encode(sha0(password.encode('utf-8') + username.encode('utf-8').upper())).decode()
```

**Security note:** SoftEther's password authentication is a challenge-response over this hash (`SecurePassword` = SHA0(hash || random), `Sam.c:354-369`). So **the hash is equivalent to the password**. Anyone who can read the MSI or the `.vpn` file can log in as that user. Prefer per-user credentials entered later, certificate auth, or at least a dedicated low-privilege account.

### 5.4 `EncryptedPassword` (AuthType 2) and `ProxyPassword`
`EncryptPassword`/`DecryptPassword` (`Client.c:9923-9990`) is RC4 with `key = "EncryptPassword"`, but the key length is `sizeof(key)` (**the pointer size**). The code comment says "This is not a bug! Do not try to fix it!!" (`Client.c:9934`, `9977`).
* 64-bit builds therefore use the RC4 key `"EncryptP"` (8 bytes); 32-bit builds use `"Encr"` (4 bytes).
* The ciphertext has the same length as the plaintext and no NUL terminator.
* Don't pre-compute it. Import with an empty value, then run `AccountPasswordSet <name> /PASSWORD:... /TYPE:radius`.
* `ProxyPassword` uses the same scheme. An empty proxy password is `byte ProxyPassword $` (zero-length).

### 5.5 Auth types and proxy types
* `AuthType` (`Cedar.h:375-380`):

  | Value | Meaning | Fields |
  |---|---|---|
  | 0 | Anonymous | — |
  | 1 | Password | `HashedPassword` |
  | 2 | Plain password (RADIUS / NT domain) | `EncryptedPassword` |
  | 3 | Certificate | `ClientCert` = X.509 DER, `ClientKey` = private key DER, both Base64 (`Client.c:9824-9835`, `9253-9266`) |
  | 4 | Smart card | `SecurePublicCertName`, `SecurePrivateKeyName` |
  | 5 | OpenSSL engine (5.x only) | `ClientCert`, `OpensslEnginePrivateKeyName`, `OpensslEngineName` |

* `ProxyType` (`Cedar.h:285-288`): 0 = direct, 1 = HTTP, 2 = SOCKS4, 3 = SOCKS5.

### 5.6 Complete annotated template (Dev 5.x field set; Stable 4.x ignores the 5.x-only fields and adds `bool NoTls1`)

```
# VPN Client VPN Connection Setting File
# (keep at least one comment/blank line before "declare root" if you add a UTF-8 BOM)

declare root
{
	bool AddDefaultCA false                 # 5.x only: also trust the system/default CA store for the server cert
	bool CheckServerCert true               # verify server cert; if true and ServerCert absent/mismatch -> UI prompt via helper
	uint64 CreateDateTime 0                 # ms since epoch; 0 is fine
	uint64 LastConnectDateTime 0
	bool RetryOnServerCert false            # 5.x only: keep retrying when server cert check fails
	byte ServerCert <BASE64-DER>            # optional: pinned server certificate (X.509 DER, Base64)
	string ShortcutKey <40 hex chars>       # optional; random if absent (Client.c:9412-9425)
	bool StartupAccount true                # connect automatically when the service starts
	uint64 UpdateDateTime 0

	declare ClientAuth
	{
		uint AuthType 1                     # 0 anon, 1 password, 2 radius/nt, 3 cert, 4 smartcard, 5 openssl engine
		string Username alice               # always written (Client.c:9806)

		# --- AuthType 1 (standard password): ---
		byte HashedPassword JocVh682OLw0ykn24y2Y+Pnw7is=     # Base64(SHA0(password||UPPER(username))); example = alice / S3cret!

		# --- AuthType 2 (RADIUS / NT domain) instead: ---
		# byte EncryptedPassword <RC4 bytes, Base64>     # set later with AccountPasswordSet /TYPE:radius

		# --- AuthType 3 (client certificate) instead: ---
		# byte ClientCert <Base64 of X.509 DER>
		# byte ClientKey  <Base64 of private key DER>

		# --- AuthType 4 (smart card) instead: ---
		# string SecurePublicCertName <object name>
		# string SecurePrivateKeyName <object name>
	}
	declare ClientOption
	{
		string AccountName Company$20VPN    # display name; spaces escaped as $20
		uint AdditionalConnectionInterval 1 # seconds between additional TCP connections
		string BindLocalIP 0.0.0.0          # 5.x: source IP for outgoing connection (CfgAddIp writes a string)
		uint BindLocalPort 0                # 5.x
		uint ConnectionDisconnectSpan 0     # 0 = never recycle TCP connections
		string CustomHttpHeader $           # 5.x: extra HTTP headers for proxy ($ = empty)
		string DeviceName VPN               # virtual NIC name (must be VPN, VPN2..VPN127 on Win8+)
		bool DisableQoS false
		bool HalfConnection false
		bool HideNicInfoWindow false
		bool HideStatusWindow false
		string Hostname vpn.example.com     # 5.x: may be "host/hint" (hint split off, Client.c:9311-9317)
		string HubName VPN                  # virtual hub
		uint MaxConnection 1                # 1..32 TCP connections
		bool NoRoutingTracking false
		bool NoUdpAcceleration false
		uint NumRetry 4294967295            # 0xFFFFFFFF = retry forever
		uint Port 443
		uint PortUDP 0                      # 0 = TCP only
		string ProxyName $
		byte ProxyPassword $                # empty (see 5.4)
		uint ProxyPort 0
		uint ProxyType 0                    # 0 direct, 1 HTTP, 2 SOCKS4, 3 SOCKS5
		string ProxyUsername $
		bool RequireBridgeRoutingMode false
		bool RequireMonitorMode false
		uint RetryInterval 15               # seconds
		bool UseCompress false
		bool UseEncrypt true
		# bool FromAdminPack true           # only written when set
		# byte HostUniqueKey <20 bytes Base64>   # optional
	}
}
```

`CiEraseSensitiveInAccount` (`Client.c:1881-1927`) is what the Easy Installer's "erase sensitive info" option runs. It zeroes `HashedPassword`/`PlainPassword` **and clears `Username`**, only for AuthType 1 and 2.

---

## 6. MSI design (built with msitools `wixl` 0.106 on macOS/Linux)

### 6.1 Why not "MSI that runs vpnsetup.exe"
It is technically possible (install the exe as a `File`, run it with a type 18 or type 50 CA). It is useless for silent deployment, for three reasons:
1. There is no silent flag (§2). In a deferred, no-impersonate CA the wizard opens in session 0 where nobody can see it, and msiexec hangs.
2. If you impersonate, the wizard pops up on the user's desktop, so the install is not silent.
3. The result is not MSI-managed. vpnsetup writes its own ARP entry and `setuplog.dat`, and uninstall is another wizard.

**wixl limitation:** you can't run an EXE embedded in the `Binary` table (`BinaryKey`+`ExeCommand` = type 2). wixl throws "Unsupported CustomAction" (`tools/wixl/builder.vala:1360-1389` in msitools v0.106). The exe would have to be installed as a file first.

### 6.2 Recommended: repackage the payload as an MSI-owned install

**Payload.**
* Take `vpnclient.exe`, `vpncmd.exe`, `vpncmgr.exe`, `hamcore.se2`, and optionally `lang.config` (containing `en`).
* `hamcore.se2` holds the drivers, `vpndrvinst.exe`, `vpncmdsys.exe` and the string tables.
* Nothing else is required: 5.x is statically linked (`x64-windows-static`, `.github/workflows/windows_release.yml:36`).
* Where to get them:
  * **(a)** Build from `vendor/SoftEtherVPN` on a Windows CI runner. This is the most reproducible, and you can Authenticode-sign the binaries yourself.
  * **(b)** Extract them from the official SFX: read the PE `DATAFILE` resources `VPNCLIENT.EXE`, `VPNCMD.EXE`, `VPNCMGR.EXE` (4-byte big-endian size + zlib) and `RAW_HAMCORE.SE2` (raw).
    * With Python `pefile`: iterate `DIRECTORY_ENTRY_RESOURCE` → type name `DATAFILE` → for each name: if it starts with `RAW_`, write the bytes as-is, else `zlib.decompress(data[4:])`.
    * Untested against a real release binary. Verify with an E2E run.

**Licence.** Apache-2.0 (`LICENSE`) allows redistribution.

**MSI contents (per-machine, `wixl -a x64`):**
* Files into `ProgramFiles64Folder\<your folder>`.
* `ServiceInstall`:
  * `Name="SEVPNCLIENTDEV"` (Dev) or `SEVPNCLIENT` (Stable, with the `_x64` exe names).
  * `Arguments="/service"`, `Start="auto"`, `Type="ownProcess"`.
* `ServiceControl` with `Start="install" Stop="both" Remove="uninstall" Wait="yes"`.
* `RegistryValue` for the UI Helper Run key, mirroring `SW.c:3499-3508`: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, value `SoftEther VPN Client UI Helper Developer Edition` = `"[INSTALLDIR]vpnclient.exe" /uihelp`. Users who log in later then get the helper, which later NIC operations and cert dialogs need.
* Optionally, the `.vpn` file association (`SW.c:3530-3552`) and a Start-menu shortcut to `vpncmgr.exe`.
* **Deferred, no-impersonate CA after `StartServices`**. It runs a script that:
  1. Starts `vpnclient.exe /uihelp` in the background and keeps its PID.
  2. Polls `vpncmd localhost /CLIENT /CMD VersionGet` until it returns 0.
  3. Runs `NicCreate VPN` (accept 0 or 30).
  4. Runs `AccountDelete "<name>"` (ignore the error), then `AccountImport <file>`, `AccountStartupSet`, `AccountConnect`.
  5. Kills the helper PID.
* **Deferred CA before `StopServices` on `REMOVE="ALL"`**:
  * Start the helper.
  * `AccountDisconnect`, `AccountDelete`, `NicDelete VPN`.
  * Kill the helper.
  * Delete the runtime files: `vpn_client.config`, `backup.vpn_client.config\`, `client_log\` and friends. wixl has **no `RemoveFile` element**, only `RemoveFolder`.
  * Delete the bootstrap `%SystemRoot%\System32\vpncmd.exe` and `HKLM\Software\SoftEther VPN Developer Edition\VPN Command Line Utility`, because the configure step's vpncmd run as SYSTEM creates them (§4.1).

**wixl 0.106 facts** (source: `https://gitlab.gnome.org/GNOME/msitools/-/archive/v0.106/msitools-v0.106.tar.gz`, `tools/wixl/wix.vala` and `builder.vala`):
* `<CustomAction>` attributes: `Property Execute FileKey ExeCommand Impersonate Return BinaryKey DllEntry HideTarget JScriptCall Value` (`wix.vala:976-996`). Supported combinations (`builder.vala:1365-1389`):

  | Attributes | CA type |
  |---|---|
  | `BinaryKey`+`DllEntry` | 1 |
  | `BinaryKey`+`JScriptCall` | 5 |
  | **`FileKey`+`ExeCommand`** | 18 |
  | **`Property`+`ExeCommand`** | 50, the property holds the exe path |
  | `Property`+`Value` | 51, set property |

  Not supported: `Directory`+`ExeCommand` (type 34), `BinaryKey`+`ExeCommand` (type 2), `VBScriptCall`, inline `Script`. Anything else raises "Unsupported CustomAction".
* `Execute`: `deferred` → +0x400, and `rollback`/`commit`/`firstSequence`/`oncePerProcess`/`clientRepeat` are also mapped. `Return`: `ignore` → +0x40, `asyncWait` → +0x80, `asyncNoWait` → +0xC0. `check` is the default.
* **Impersonation default differs from WiX.** For deferred CAs, wixl adds `msidbCustomActionTypeNoImpersonate` (0x800) **unless `Impersonate="yes"`** (`builder.vala:1413-1414`, `parse_yesno(null)` = false, `util.vala:111-116`). Deferred means SYSTEM by default. Set `Impersonate="no"` explicitly anyway, for clarity and WiX compatibility.
* **`HideTarget` is parsed but ignored** (no 0x2000 flag), so command lines appear in verbose logs. Don't put secrets in `ExeCommand`.
* `<Custom Action=".." After|Before|Sequence="..">condition</Custom>` works. The condition can be inner text or a `Condition` attribute (`builder.vala:1039-1084`). `StartServices`, `StopServices`, `InstallFiles` etc. are known anchors (`wix.vala:758-838`).
* `ServiceInstall` (`Name DisplayName Type Interactive Start ErrorControl Vital LoadOrderGroup Account Password Arguments Description EraseDescription`), `ServiceControl` (`Name Start Stop Remove Wait`), `RegistryValue`, `Shortcut`, `MajorUpgrade`, `Upgrade`, `Binary`, `Component Win64` are all supported. `<Package Platform="x64">` is **not** (wixl warns "no property named 'Platform'"). Use `wixl -a x64`, which sets the Template to `x64;1033` and marks components 64-bit.
* Deferred EXE CAs get their `ExeCommand` formatted when the script is generated, so `[#fileId]` and `[INSTALLDIR]` work inside it.

**Checked locally.** The skeleton below compiles with `wixl -a x64`. `msiinfo export` shows the configure CA as type `3122` (50 + 0x400 + 0x800), the uninstall CA as `3186` (+0x40 ignore), the configure CA sequenced at 5901 right after `StartServices` (5900), and the unconfigure CA at 1801 before `StopServices` (1900), and the `SetPSEXE` type-51 CA at 1001. The payload files were dummies, so this checks the MSI structure only, not a real install.

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="SoftEther VPN Client (Managed)" Language="1033" Version="5.2.5188"
           Manufacturer="Example" UpgradeCode="7D3C1A52-3E6B-4C55-9A0E-2A1A5E0C1B11">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version is already installed."/>
    <Media Id="1" Cabinet="payload.cab" EmbedCab="yes"/>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="SoftEther VPN Client Managed">
          <Component Id="CClient" Guid="3F0B5B1E-0C1D-4C0E-9E1B-9D6D8B0F0001" Win64="yes">
            <File Id="vpnclient.exe" Source="payload/vpnclient.exe" KeyPath="yes"/>
            <ServiceInstall Id="SvcInst" Name="SEVPNCLIENTDEV" DisplayName="SoftEther VPN Client Developer Edition"
                            Type="ownProcess" Start="auto" ErrorControl="normal" Arguments="/service"/>
            <ServiceControl Id="SvcCtl" Name="SEVPNCLIENTDEV" Start="install" Stop="both" Remove="uninstall" Wait="yes"/>
            <RegistryValue Root="HKLM" Key="SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
                           Name="SoftEther VPN Client UI Helper Developer Edition" Type="string"
                           Value="&quot;[INSTALLDIR]vpnclient.exe&quot; /uihelp"/>
          </Component>
          <Component Id="CCmd" Guid="3F0B5B1E-0C1D-4C0E-9E1B-9D6D8B0F0002" Win64="yes">
            <File Id="vpncmd.exe" Source="payload/vpncmd.exe" KeyPath="yes"/>
          </Component>
          <Component Id="CCmgr" Guid="3F0B5B1E-0C1D-4C0E-9E1B-9D6D8B0F0003" Win64="yes">
            <File Id="vpncmgr.exe" Source="payload/vpncmgr.exe" KeyPath="yes"/>
          </Component>
          <Component Id="CHamcore" Guid="3F0B5B1E-0C1D-4C0E-9E1B-9D6D8B0F0004" Win64="yes">
            <File Id="hamcore.se2" Source="payload/hamcore.se2" KeyPath="yes"/>
          </Component>
          <Component Id="CProfile" Guid="3F0B5B1E-0C1D-4C0E-9E1B-9D6D8B0F0005" Win64="yes">
            <File Id="profile.vpn" Source="payload/profile.vpn" KeyPath="yes"/>
            <File Id="configure.ps1" Source="payload/configure.ps1"/>
            <File Id="unconfigure.ps1" Source="payload/unconfigure.ps1"/>
          </Component>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Main" Level="1">
      <ComponentRef Id="CClient"/><ComponentRef Id="CCmd"/><ComponentRef Id="CCmgr"/>
      <ComponentRef Id="CHamcore"/><ComponentRef Id="CProfile"/>
    </Feature>

    <!-- type 51: put the full 64-bit powershell path in a property (Property table values are not formatted) -->
    <CustomAction Id="SetPSEXE" Property="PSEXE" Value="[System64Folder]WindowsPowerShell\v1.0\powershell.exe"/>
    <!-- type 50 + deferred + no-impersonate = 3122 -->
    <CustomAction Id="ConfigureVpn" Property="PSEXE" Execute="deferred" Impersonate="no" Return="check"
                  ExeCommand="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;[#configure.ps1]&quot; -Dir &quot;[INSTALLDIR]&quot;"/>
    <CustomAction Id="UnconfigureVpn" Property="PSEXE" Execute="deferred" Impersonate="no" Return="ignore"
                  ExeCommand="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;[#unconfigure.ps1]&quot; -Dir &quot;[INSTALLDIR]&quot;"/>

    <InstallExecuteSequence>
      <Custom Action="SetPSEXE" After="CostFinalize"/>
      <Custom Action="ConfigureVpn" After="StartServices">NOT REMOVE="ALL"</Custom>
      <Custom Action="UnconfigureVpn" Before="StopServices">REMOVE="ALL"</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
```

Sketch of `configure.ps1`. It is untested on Windows; see §6.4.

```powershell
param([string]$Dir)
$ErrorActionPreference = 'Stop'
$vpncmd = Join-Path $Dir 'vpncmd.exe'
$acct   = 'Company VPN'                      # must equal AccountName in profile.vpn
$nic    = 'VPN'
function Vc([string]$cmdline) {             # returns SoftEther error code (0 = OK)
  $p = Start-Process -FilePath $vpncmd -ArgumentList "localhost /CLIENT /CMD $cmdline" -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}
# 1) UI Helper = listener on TCP 9984 that performs driver installs for NicCreate (Client.c:8276, 1596)
$helper = Start-Process -FilePath (Join-Path $Dir 'vpnclient.exe') -ArgumentList '/uihelp' -PassThru -WindowStyle Hidden
try {
  # 2) wait for the service RPC (9931)
  $ok = $false; for ($i=0; $i -lt 60 -and -not $ok; $i++) { if ((Vc 'VersionGet') -eq 0) { $ok = $true } else { Start-Sleep 1 } }
  if (-not $ok) { exit 1 }
  Start-Sleep 3                                               # SW.c:3513 does the same after starting the helper
  $rc = Vc "NicCreate $nic";           if ($rc -ne 0 -and $rc -ne 30) { exit $rc }   # 30 = already exists
  Vc "AccountDisconnect `"$acct`"" | Out-Null
  Vc "AccountDelete `"$acct`""     | Out-Null                # keep AccountImport from creating "Name (2)"
  $rc = Vc "AccountImport `"$(Join-Path $Dir 'profile.vpn')`""; if ($rc -ne 0) { exit $rc }
  $rc = Vc "AccountStartupSet `"$acct`"";                     if ($rc -ne 0) { exit $rc }
  Vc "AccountConnect `"$acct`"" | Out-Null                   # may fail if offline; startup flag retries at boot
  exit 0
} finally {
  if ($helper -and -not $helper.HasExited) { Stop-Process -Id $helper.Id -Force }
}
```

**Also:**
* Wrap the whole script in a timeout (for example a job with `Wait-Job -Timeout 180`). A vpndrvinst failure shows an invisible `MessageBox` (§4.3) and would otherwise hang the install.
* The profile file stays in the install dir after import. Delete it at the end if it holds a `HashedPassword`.

### 6.3 Elevation, silent switches, uninstall
* Install with `msiexec /i softether-client.msi /qn /l*v install.log`. Per-machine MSIs with deferred no-impersonate CAs, `ServiceInstall` and `HKLM` writes need elevation. Under `/qn` from a non-elevated user they fail with 1603/1925. Deploy through Intune, SCCM or GPO (these run as SYSTEM), or from an elevated shell.
* Uninstall with `msiexec /x {ProductCode} /qn` or `msiexec /x softether-client.msi /qn`. The unconfigure CA runs before `StopServices`, then `ServiceControl Remove="uninstall"` deletes the service, and MSI removes the files and the Run value.
* **Removing a vpnsetup-installed client silently** (for migrating existing machines):
  1. `"<dir>\vpnclient.exe" /uninstall /silent`. It stops and deletes the service with no message boxes (`Microsoft.c:4425-4470`).
  2. Remove the NIC first with `vpncmd NicDelete VPN` while the helper runs, or with `pnputil /remove-device`.
  3. Delete the install dir, the `Run` value, `HKLM\...\Uninstall\softether_sedevvpnclient` (or `softether_sevpnclient`) and the `.vpn`/`vpnfile` classes.

  `vpnsetup.exe` uninstall itself is a GUI wizard.
* Upgrades: with `MajorUpgrade`, the old product's unconfigure CA runs during `RemoveExistingProducts`. That deletes the NIC and account, and the new product recreates them. This is simple, but it causes a short outage and a new NIC instance. Alternatively, condition the unconfigure CA on `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`.

### 6.4 What must be verified by an E2E run (not verifiable from source alone)
Run these on a clean Windows 11 x64 VM: `msiexec /qn` as SYSTEM (for example `psexec -s`), then reboot. Capture `install.log`, the `vpncmd AccountStatusGet` output and `Get-NetAdapter` as the repeatable artifact.
1. `vpnclient.exe /uihelp` started as SYSTEM in session 0 takes TCP 9984, and NicCreate succeeds through it. `CnStart`'s listener arbitration uses cursor and session-activity heuristics (`Client.c:1741-1792`).
2. `vpndrvinst.exe` (with its `requireAdministrator` manifest) launched via `ShellExecuteEx` from SYSTEM installs the attestation-signed Neo6 driver with no prompt.
3. The SFX resource extraction recipe in §6.2(b), if you use official binaries instead of building them.
4. The Python `HashedPassword` produces a hash the server accepts (or just use `AccountPasswordSet /TYPE:standard` after import and skip offline hashing).
5. Behaviour on Windows Server, if in scope (attestation-signing caveat, §4.4).

---

## Sources
* Source tree: `vendor/SoftEtherVPN/src/Cedar/SW.c`, `SWInner.h`, `SW.h`, `Client.c`, `Client.h`, `Command.c`, `Command.h`, `Account.c`, `Sam.c`, `Cedar.h`, `CM.c`; `src/Mayaqua/Cfg.c`, `Cfg.h`, `Encrypt.c`, `Memory.c`, `Microsoft.c`, `Microsoft.h`, `FileIO.c`; `src/GlobalConst.h`; `src/vpndrvinst/*`; `src/CMakeLists.txt`; `.github/workflows/windows_release.yml`; `src/bin/hamcore/DriverPackages/Neo6_Win10/x64/*`; `src/bin/hamcore/strtable_en.stb`.
* Stable: https://raw.githubusercontent.com/SoftEtherVPN/SoftEtherVPN_Stable/master/src/GlobalConst.h, `.../src/Cedar/SW.c`, `.../src/Cedar/Client.c`, `.../src/Cedar/Account.c`, `.../src/Mayaqua/Microsoft.h`
* Releases: https://github.com/SoftEtherVPN/SoftEtherVPN/releases (API `releases/latest` = 5.2.5188), https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/releases, https://www.softether-download.com/files/softether/ (and `v4.44-9807-rtm-2025.04.16-tree/files.txt`)
* Issues and workarounds: https://github.com/SoftEtherVPN/SoftEtherVPN/issues/195, https://github.com/SoftEtherVPN/SoftEtherVPN/issues/444, https://gist.github.com/checkin247/df20b55f55529b70d141b4db2cf5061a, https://github.com/spanishdexter/SoftEther-VPN-Client-Silent-Installer-Script
* msitools wixl v0.106 source: https://gitlab.gnome.org/GNOME/msitools/-/archive/v0.106/msitools-v0.106.tar.gz (`tools/wixl/wix.vala`, `builder.vala`, `util.vala`); local `wixl 0.106` / `msiinfo` used to compile and inspect the skeleton.
