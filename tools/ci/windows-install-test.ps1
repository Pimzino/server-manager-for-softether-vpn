# End-to-end install test of the generated client packages on a real Windows x64 machine (GitHub runner).
#
#   1. Runs the OFFICIAL SoftEther VPN Server locally as a Windows service, with a hub, a user and SecureNAT.
#   2. Installs the branded MSI silently (msiexec /qn) and checks: service, files, virtual network adapter,
#      imported account, a live VPN session (client and server side), DHCP address from the hub, branding.
#   3. Upgrades in place with the branded setup.exe (/quiet) and checks the connection survives.
#   4. Uninstalls (setup.exe /uninstall /quiet) and checks that service, adapter, files and registry are gone.
#
# Everything is recorded in <OutDir>\results.json and <OutDir>\SUMMARY.md; logs are kept next to them.
param(
  [Parameter(Mandatory = $true)][string]$PackagesDir,   # output of tools/ci/build-client-packages.ts
  [Parameter(Mandatory = $true)][string]$ServerSfx,     # official softether-vpnserver_vpnbridge-*.x64.exe
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Password = "Ci-User-Passw0rd!"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$manifest = Get-Content (Join-Path $PackagesDir "manifest.json") -Raw | ConvertFrom-Json
$brand = $manifest.brand
$conn = $manifest.connection
$results = [System.Collections.Generic.List[object]]::new()
$failed = $false

function Check([string]$name, [scriptblock]$test, [string]$phase = "") {
  $detail = ""
  $ok = $false
  try {
    $r = & $test
    if ($r -is [array] -and $r.Count -eq 2 -and $r[0] -is [bool]) { $ok = $r[0]; $detail = [string]$r[1] } else { $ok = [bool]$r; $detail = [string]$r }
  } catch { $ok = $false; $detail = "exception: $($_.Exception.Message)" }
  if (-not $ok) { $script:failed = $true }
  $script:results.Add([pscustomobject]@{ phase = $phase; name = $name; ok = $ok; detail = $detail })
  Write-Host ("[{0}] {1} {2}" -f ($(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail))
}

function WaitUntil([scriptblock]$cond, [int]$timeoutSec = 60, [int]$everySec = 2) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $v = & $cond; if ($v) { return $v } } catch { }
    Start-Sleep -Seconds $everySec
  }
  return $null
}

# --- SoftEther JSON-RPC (server admin, empty password) ---
function Rpc([string]$method, $params = @{}) {
  $body = @{ jsonrpc = "2.0"; id = "1"; method = $method; params = $params } | ConvertTo-Json -Depth 8
  $auth = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("administrator:"))
  $r = Invoke-RestMethod -Uri "https://127.0.0.1:$($conn.port)/api/" -Method Post -Body $body -ContentType "application/json" -Headers @{ Authorization = $auth } -SkipCertificateCheck -TimeoutSec 15
  if ($r.error) { throw "SoftEther $method error $($r.error.code): $($r.error.message)" }
  return $r.result
}

# ============================================================ 1. SoftEther VPN Server
$serverDir = "C:\se-server"
node (Join-Path $PSScriptRoot "extract-sfx.ts") $ServerSfx $serverDir | Tee-Object (Join-Path $OutDir "server-extract.txt")
Check "official server installer extracted (vpnserver.exe, vpncmd.exe, hamcore.se2)" {
  (Test-Path "$serverDir\vpnserver.exe") -and (Test-Path "$serverDir\vpncmd.exe") -and (Test-Path "$serverDir\hamcore.se2")
} "server"
@"
# Software Configuration File
declare root
{
	declare ListenerList
	{
		declare Listener0
		{
			bool DisableDos false
			bool Enabled true
			uint Port $($conn.port)
		}
	}
	declare ServerConfiguration
	{
		string PortsUDP `$
	}
}
"@ | Set-Content -Path "$serverDir\vpn_server.config" -Encoding ascii
$serverSvc = "SEVPNSERVERDEV"
& sc.exe create $serverSvc binPath= "`"$serverDir\vpnserver.exe`" /service" start= demand DisplayName= "SoftEther VPN Server (CI)" | Out-Host
& sc.exe start $serverSvc | Out-Host
Check "SoftEther VPN Server answers JSON-RPC" {
  $info = WaitUntil { Rpc "GetServerInfo" } 90
  @([bool]$info, "$($info.ServerProductName_str) build $($info.ServerBuildInt_u32)")
} "server"
Rpc "CreateHub" @{ HubName_str = $conn.hub; Online_bool = $true } | Out-Null
Rpc "CreateUser" @{ HubName_str = $conn.hub; Name_str = $conn.user; AuthType_u32 = 1; Auth_Password_str = $Password } | Out-Null
Rpc "EnableSecureNAT" @{ HubName_str = $conn.hub } | Out-Null
$nat = Rpc "GetSecureNATOption" @{ RpcHubName_str = $conn.hub }
Write-Host "SecureNAT DHCP range: $($nat.DhcpLeaseIPStart_ip) - $($nat.DhcpLeaseIPEnd_ip)"

# ============================================================ helpers for the client side
$installDir = Join-Path $env:ProgramFiles $brand.installFolder
$vpncmd = Join-Path $installDir "vpncmd.exe"
function ClientCmd([string[]]$cmd) {
  $out = & $vpncmd localhost /CLIENT /CMD @cmd 2>&1 | Out-String
  return [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}
function Adapter { Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like "VPN Client Adapter*" } }
function ArpEntries {
  Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $brand.productName }
}
function ServerSession { (Rpc "EnumSession" @{ HubName_str = $conn.hub }).SessionList | Where-Object { $_.Username_str -eq $conn.user } }
function CollectLogs([string]$tag) {
  $src = Join-Path $env:ProgramData "SoftEtherManager"
  if (Test-Path $src) { Copy-Item "$src\*" -Destination $OutDir -Force -ErrorAction SilentlyContinue; Get-ChildItem $src | ForEach-Object { Copy-Item $_.FullName (Join-Path $OutDir "$tag-$($_.Name)") -Force } }
}

function VerifyInstalled([string]$phase, [string]$version) {
  Check "client service '$($manifest.service)' is running" { $s = Get-Service $manifest.service -ErrorAction Stop; @(($s.Status -eq "Running"), "$($s.Status), display name '$($s.DisplayName)'") } $phase
  Check "service display name is branded" { (Get-Service $manifest.service).DisplayName -eq $brand.serviceDisplayName } $phase
  Check "client files installed in '$installDir'" { @("vpnclient.exe", "vpncmd.exe", "vpncmgr.exe", "hamcore.se2") | ForEach-Object { if (-not (Test-Path (Join-Path $installDir $_))) { throw "$_ missing" } }; $true } $phase
  Check "virtual network adapter exists" { $a = Adapter; @([bool]$a, ($a | ForEach-Object { "$($_.Name) [$($_.InterfaceDescription)] $($_.Status)" }) -join "; ") } $phase
  Check "account '$($conn.accountName)' imported and set to connect at startup" {
    $l = ClientCmd @("AccountList")
    @(($l.code -eq 0 -and $l.out -match [regex]::Escape($conn.accountName)), ($l.out -split "`n" | Select-String "Setting Name|Status|Server Host" | Out-String).Trim())
  } $phase
  Check "VPN session established (client side)" {
    $st = WaitUntil { $s = ClientCmd @("AccountStatusGet", $conn.accountName); if ($s.out -match "Session Status\s*\|.*(Established|Connection Completed)") { $s } } 120 3
    if (-not $st) { $s = ClientCmd @("AccountStatusGet", $conn.accountName); return @($false, $s.out) }
    @($true, (($st.out -split "`n" | Select-String "Session Status|Server Name|Encryption|Number of TCP") | Out-String).Trim())
  } $phase
  Check "VPN session visible on the server for user '$($conn.user)'" { $s = WaitUntil { ServerSession } 60; @([bool]$s, "$($s.Name_str) from $($s.Hostname_str)") } $phase
  Check "adapter received an address from the hub's SecureNAT DHCP" {
    $ip = WaitUntil { Adapter | Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "192.168.30.*" } } 90 3
    @([bool]$ip, "$($ip.IPAddress)/$($ip.PrefixLength)")
  } $phase
  Check "profile file removed after import (credential not left on disk)" { -not (Test-Path (Join-Path $installDir "profile1.vpn")) } $phase
  Check "Add/Remove Programs entry: one, version $version, branded" {
    $e = @(ArpEntries)
    @(($e.Count -eq 1 -and $e[0].DisplayVersion -eq $version -and $e[0].Publisher -eq $brand.manufacturer -and $e[0].HelpLink -eq $brand.helpLink),
      "count=$($e.Count) version=$($e.DisplayVersion) publisher=$($e.Publisher) help=$($e.HelpLink) icon=$($e.DisplayIcon)")
  } $phase
  Check "client executables carry the brand" {
    $vi = (Get-Item (Join-Path $installDir "vpnclient.exe")).VersionInfo
    @(($vi.ProductName -eq $brand.clientDisplayName -and $vi.CompanyName -eq $brand.manufacturer), "ProductName='$($vi.ProductName)' CompanyName='$($vi.CompanyName)'")
  } $phase
  Check "Start-menu shortcut created" { Test-Path (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\Contoso\$($brand.shortcutName).lnk") } $phase
}

# ============================================================ 2. Silent MSI install
$msi = Join-Path $PackagesDir $manifest.msi.file
$log = Join-Path $OutDir "msi-install.log"
$t0 = Get-Date
$p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
Check "msiexec /i /qn exits 0" { @(($p.ExitCode -eq 0), "exit code $($p.ExitCode) after $([int]((Get-Date) - $t0).TotalSeconds) s") } "install"
CollectLogs "install"
VerifyInstalled "install" $manifest.msi.version
ClientCmd @("AccountStatusGet", $conn.accountName) | ForEach-Object { $_.out } | Set-Content (Join-Path $OutDir "install-account-status.txt")
Adapter | Format-List Name, InterfaceDescription, Status, MacAddress, DriverVersion, DriverProvider | Out-String | Set-Content (Join-Path $OutDir "install-adapter.txt")

# ============================================================ 3. In-place upgrade with the branded setup.exe
$setup = Join-Path $PackagesDir $manifest.setupExe.file
Check "setup.exe is branded (version info)" {
  $vi = (Get-Item $setup).VersionInfo
  @(($vi.ProductName -eq $brand.productName -and $vi.CompanyName -eq $brand.manufacturer -and $vi.FileVersion -eq "1.0.2.0"), "ProductName='$($vi.ProductName)' FileVersion='$($vi.FileVersion)'")
} "upgrade"
$upLog = Join-Path $OutDir "setup-upgrade.log"
$p = Start-Process $setup -ArgumentList "/quiet /log `"$upLog`"" -Wait -PassThru
Check "setup.exe /quiet exits 0" { @(($p.ExitCode -eq 0), "exit code $($p.ExitCode)") } "upgrade"
CollectLogs "upgrade"
VerifyInstalled "upgrade" $manifest.setupExe.version

# ============================================================ 4. Uninstall
$p = Start-Process $setup -ArgumentList "/uninstall /quiet /log `"$(Join-Path $OutDir 'setup-uninstall.log')`"" -Wait -PassThru
Check "setup.exe /uninstall /quiet exits 0" { @(($p.ExitCode -eq 0), "exit code $($p.ExitCode)") } "uninstall"
CollectLogs "uninstall"
Check "client service removed" { -not (Get-Service $manifest.service -ErrorAction SilentlyContinue) } "uninstall"
Check "virtual network adapter removed" { $a = WaitUntil { if (-not (Adapter)) { $true } } 30; @([bool]$a, ((Adapter | ForEach-Object { $_.Name }) -join ",")) } "uninstall"
Check "install folder removed" { $left = Get-ChildItem $installDir -Recurse -ErrorAction SilentlyContinue; @((-not (Test-Path $installDir)), ($left.Name -join ", ")) } "uninstall"
Check "Add/Remove Programs entry removed" { @(ArpEntries).Count -eq 0 } "uninstall"
Check "no session left on the server" { $gone = WaitUntil { if (-not (ServerSession)) { $true } } 60; [bool]$gone } "uninstall"
Check "no credential left in the registry" { -not (Test-Path "HKLM:\SOFTWARE\SoftEtherManager\PendingCredential") } "uninstall"

# ============================================================ results
& sc.exe stop $serverSvc | Out-Null
$os = Get-CimInstance Win32_OperatingSystem
$passed = @($results | Where-Object ok).Count
$summary = @(
  "# Windows client install test",
  "",
  "- OS: $($os.Caption) $($os.Version) ($env:PROCESSOR_ARCHITECTURE)",
  "- SoftEther client: $($manifest.softetherClient.file) ($($manifest.softetherClient.edition) $($manifest.softetherClient.version))",
  "- Result: **$passed passed, $($results.Count - $passed) failed**",
  "",
  "| | Phase | Check | Detail |",
  "|---|---|---|---|"
) + ($results | ForEach-Object { "| $(if ($_.ok) { '✅' } else { '❌' }) | $($_.phase) | $($_.name) | $((($_.detail -replace '\r?\n', ' ') -replace '\|', '/')) |" })
$summary | Set-Content (Join-Path $OutDir "SUMMARY.md") -Encoding utf8
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutDir "results.json") -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content $env:GITHUB_STEP_SUMMARY -Encoding utf8 }
if ($failed) { Write-Error "Windows install test failed: see SUMMARY.md"; exit 1 }
Write-Host "All $passed checks passed."
