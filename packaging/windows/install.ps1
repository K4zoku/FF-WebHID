# Registers the FF-WebHID native-messaging hosts for Firefox (per-user, no admin).
# Run from the extracted portable bundle; re-run after moving the folder.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $root 'bin'
$manifestDir = Join-Path $root 'manifests'
$targetDir = Join-Path $env:APPDATA 'Mozilla\NativeMessagingHosts'

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

function Write-RegisteredManifest {
    param(
        [string]$Template,
        [string]$Name,
        [string]$Placeholder,
        [string]$Value
    )
    $content = Get-Content -Raw -Encoding UTF8 (Join-Path $manifestDir $Template)
    $content = $content.Replace($Placeholder, $Value)
    [System.IO.File]::WriteAllText(
        (Join-Path $targetDir $Name),
        $content,
        [System.Text.UTF8Encoding]::new($false)
    )
}

Write-RegisteredManifest 'webhid.forwarder_nm_host.json' 'webhid.forwarder_nm_host.json' '{{NM_BIN}}' (Join-Path $binDir 'webhid-native-messaging.exe')
Write-RegisteredManifest 'webhid.daemon_nm_host.json' 'webhid.daemon_nm_host.json' '{{DAEMON_BIN}}' (Join-Path $binDir 'webhid-daemon.exe')

# Firefox native-messaging registry registration (per-user).
$keys = @(
    'HKCU:\Software\Mozilla\NativeMessagingHosts\webhid.forwarder_nm_host',
    'HKCU:\Software\Mozilla\NativeMessagingHosts\webhid.daemon_nm_host'
)
foreach ($key in $keys) {
    if (-not (Test-Path $key)) {
        New-Item -Path $key | Out-Null
    }
}
Set-ItemProperty -Path $keys[0] -Name '(default)' -Value (Join-Path $targetDir 'webhid.forwarder_nm_host.json')
Set-ItemProperty -Path $keys[1] -Name '(default)' -Value (Join-Path $targetDir 'webhid.daemon_nm_host.json')

Write-Host 'Registered FF-WebHID native-messaging hosts for Firefox:'
Write-Host "  $targetDir"
Write-Host 'Install the addon from https://addons.mozilla.org/firefox/addon/webhid/'
Write-Host 'and enable "Daemon as NM host" in its options (recommended).'
