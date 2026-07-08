#requires -Version 5.1
<#
.SYNOPSIS
  Build the WebHID Windows MSI installer.

.DESCRIPTION
  - cargo build --release (daemon + native-messaging host)
  - Resolves the NM manifest template ([INSTALLDIR] placeholder)
  - Compiles the WiX source to webhid-windows-<arch>-v<version>.msi

.PARAMETER Version
  MSI ProductVersion. Pulled from package.json if omitted.

.PARAMETER Arch
  Target architecture: x86_64 (default) or aarch64.

.PARAMETER OutputDir
  Where to put the MSI. Default: dist\

.EXAMPLE
  .\build-msi.ps1
  .\build-msi.ps1 -Arch aarch64
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Arch = "x86_64",
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\..\dist')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Crates   = Join-Path $RepoRoot 'crates'
$Manifests = Join-Path $RepoRoot 'manifests'
$WixSrc   = Join-Path $PSScriptRoot 'webhid.wxs'

if (-not $Version) {
  $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
Write-Host "==> WebHID MSI build, version $Version arch $Arch"

# Stage binaries + manifest into a build dir that WiX references as $(var.BuildDir)
$Stage = Join-Path $RepoRoot 'packaging\windows\stage'
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Write-Host '==> cargo build --release'
$rustTarget = if ($Arch -eq "aarch64") { "aarch64-pc-windows-msvc" } else { "" }
if ($rustTarget) {
  & cargo build --release --target $rustTarget --manifest-path (Join-Path $Crates 'Cargo.toml')
  $Target = Join-Path $Crates "target\$rustTarget\release"
} else {
  & cargo build --release --manifest-path (Join-Path $Crates 'Cargo.toml')
  $Target = Join-Path $Crates 'target\release'
}
if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }

Copy-Item (Join-Path $Target 'webhid-daemon.exe')           $Stage
Copy-Item (Join-Path $Target 'webhid-native-messaging.exe') $Stage

# Resolve NM manifest placeholder. WiX cannot do variable substitution
# inside JSON file contents, so we replace it here.
$nmTemplate = Get-Content (Join-Path $Manifests 'webhid-native-messaging-host.json') -Raw
$nmJson = $nmTemplate -replace '\{\{NM_BIN\}\}', 'C:\\Program Files\\WebHID\\webhid-native-messaging.exe'
Set-Content -Path (Join-Path $Stage 'webhid-native-messaging-host.json') -Value $nmJson -Encoding ascii

# Locate wix.exe (WiX v6). Try PATH first, then a tools/ folder.
# WiX v7+ requires accepting the OSMF EULA — we pin to v6 to avoid that.
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
