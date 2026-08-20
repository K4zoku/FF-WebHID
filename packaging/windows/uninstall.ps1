# Removes the FF-WebHID native-messaging host registration created by install.ps1.
$ErrorActionPreference = 'Stop'

$targetDir = Join-Path $env:APPDATA 'Mozilla\NativeMessagingHosts'
Remove-Item -Force -ErrorAction SilentlyContinue `
    (Join-Path $targetDir 'webhid.forwarder_nm_host.json'),
    (Join-Path $targetDir 'webhid.daemon_nm_host.json')

$keys = @(
    'HKCU:\Software\Mozilla\NativeMessagingHosts\webhid.forwarder_nm_host',
    'HKCU:\Software\Mozilla\NativeMessagingHosts\webhid.daemon_nm_host'
)
foreach ($key in $keys) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $key
}

Write-Host 'Removed FF-WebHID native-messaging host registration.'
