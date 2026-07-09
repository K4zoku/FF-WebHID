#requires -Version 5.1
<#
.SYNOPSIS
  Build the WebHID Windows MSI installer.

.DESCRIPTION
  Packages pre-built binaries + NM manifests into an MSI via WiX v6.
  Binaries must already be built with:
    cargo build --release --target x86_64-pc-windows-msvc
    cargo build --release --target aarch64-pc-windows-msvc

.PARAMETER Version
  MSI ProductVersion. Pulled from package.json if omitted.

.PARAMETER Arch
  Target architecture: x86_64 (default) or aarch64.

.PARAMETER BinDir
  Directory containing pre-built binaries. Defaults to the cargo target dir for the given arch.

.PARAMETER OutputDir
  Where to put the MSI. Default: dist\
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Arch = "x86_64",
  [string]$BinDir,
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\..\dist')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Manifests = Join-Path $RepoRoot 'manifests'
$WixSrc   = Join-Path $PSScriptRoot 'webhid.wxs'

if (-not $Version) {
  $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}

$rustTarget = if ($Arch -eq "aarch64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
if (-not $BinDir) {
  $BinDir = Join-Path $RepoRoot "crates\target\$rustTarget\release"
}

Write-Host "==> WebHID MSI build, version $Version arch $Arch (binaries from $BinDir)"

if (-not (Test-Path (Join-Path $BinDir 'webhid-daemon.exe'))) {
  throw "webhid-daemon.exe not found in $BinDir; build first with: cargo build --release --target $rustTarget"
}

$Stage = Join-Path $RepoRoot 'packaging\windows\stage'
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Copy-Item (Join-Path $BinDir 'webhid-daemon.exe')           $Stage
Copy-Item (Join-Path $BinDir 'webhid-native-messaging.exe') $Stage

$installExe = 'C:\\Program Files\\WebHID\\webhid-native-messaging.exe'
$daemonExe  = 'C:\\Program Files\\WebHID\\webhid-daemon.exe'

$nmTemplate = Get-Content (Join-Path $Manifests 'webhid.forwarder_nm_host.json') -Raw
$nmJson = $nmTemplate -replace '\{\{NM_BIN\}\}', $installExe
Set-Content -Path (Join-Path $Stage 'webhid.forwarder_nm_host.json') -Value $nmJson -Encoding ascii

$daemonNmTemplate = Get-Content (Join-Path $Manifests 'webhid.daemon_nm_host.json') -Raw
$daemonNmJson = $daemonNmTemplate -replace '\{\{DAEMON_BIN\}\}', $daemonExe
Set-Content -Path (Join-Path $Stage 'webhid.daemon_nm_host.json') -Value $daemonNmJson -Encoding ascii

$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
  $toolsDir = Join-Path $RepoRoot 'tools'
  $wixExe = Join-Path $toolsDir 'wix.exe'
  if (Test-Path $wixExe) { $wix = $wixExe }
  else { throw "wix.exe not found. Install WiX v6.0.2: dotnet tool install --global wix --version 6.0.2" }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$msiName = "webhid-windows-${Arch}-v${Version}.msi"
$msiPath = Join-Path $OutputDir $msiName

$wixArch = if ($Arch -eq "aarch64") { "arm64" } else { "x64" }
Write-Host "==> wix build -> $msiPath"
& $wix build `
  -arch $wixArch `
  -d "Version=$Version" `
  -d "BuildDir=$Stage" `
  -o $msiPath `
  $WixSrc
if ($LASTEXITCODE -ne 0) { throw "wix build failed (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host "Done: $msiPath"
