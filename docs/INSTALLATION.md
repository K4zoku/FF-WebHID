# Installation

WebHID requires two components:
1. **System daemon** (`webhid-daemon` + `webhid-native-messaging`): runs in the background, talks to HID hardware
2. **Browser extension**: installed in Firefox, bridges web pages to the daemon

Install the browser extension from AMO: **[WebHID](https://addons.mozilla.org/en-US/firefox/addon/webhid/)**

Choose your platform below for daemon installation.

---

## Linux

### Arch Linux (AUR)

```sh
# Daemon + native messaging host
paru -S webhid           # or: yay -S webhid

# Browser extension (system-wide, optional; alternatively install from AMO)
paru -S webhid-addon
```

The AUR packages install the daemon as a systemd system service (runs as root). Enable it:

```sh
sudo systemctl enable --now webhid-daemon
```

Root daemon has access to all hidraw devices; no udev rule needed.

**Non-root daemon (optional):** If you prefer the daemon to run as your user:

```sh
sudo cp manifests/99-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

# Disable root service, enable user service
sudo systemctl disable --now webhid-daemon
systemctl --user enable --now webhid-daemon
```

### Debian/Ubuntu (.deb)

Download the `.deb` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), then:

```sh
sudo dpkg -i webhid_<version>_<arch>.deb
sudo apt-get install -f    # fix any missing dependencies
```

The package installs and auto-starts the daemon as a systemd system service (root). No manual setup needed.

**Non-root daemon (optional):**

```sh
sudo cp manifests/99-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

sudo systemctl disable --now webhid-daemon
systemctl --user enable --now webhid-daemon
```

### Fedora/RHEL (.rpm)

Download the `.rpm` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), then:

```sh
sudo dnf install webhid-<version>.<arch>.rpm
```

The package installs and auto-starts the daemon as a systemd system service (root). No manual setup needed.

**Non-root daemon (optional):**

```sh
sudo cp manifests/99-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

sudo systemctl disable --now webhid-daemon
systemctl --user enable --now webhid-daemon
```

### Manual (any distro)

Build from source:

```sh
git clone https://github.com/K4zoku/FF-WebHID.git
cd FF-WebHID
make build
```

**System-wide install (root daemon):**

```sh
sudo make install-system
sudo systemctl daemon-reload
sudo systemctl enable --now webhid-daemon
```

**User-local install (non-root daemon):**

```sh
make install-user
sudo make install-udev-rule    # one-time: grants hidraw access to your user
systemctl --user daemon-reload
systemctl --user enable --now webhid-daemon
```

Install paths are configurable: `make install-system PREFIX=/usr` or `make install-user USER_PREFIX=$HOME/.local`.

> **udev rule**: The `99-webhid.rules` file grants console users access to `hidraw*` devices via `uaccess`. This is only needed for non-root daemons. Root daemons already have full access.

### Daemon-as-NM-host mode (Linux/macOS, advanced)

Eliminates the separate NM host binary and IPC socket — the daemon speaks native-messaging protocol directly on stdin/stdout. This reduces latency by ~100μs per frame (1 fewer IPC hop, 2 fewer allocations).

**Requires:** udev rules installed (daemon runs as your user, not root).

The daemon auto-detects NM-host mode by inspecting the two positional args Firefox passes to every native-messaging host on startup (manifest path + add-on ID, per the [Mozilla spec](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)). No `--nm-host` flag is needed; the NM manifest's `path` field points at the `webhid-daemon` binary directly.

#### System-wide install

```sh
# 1. Install udev rule (one-time)
sudo make install-udev-rule

# 2. Install daemon binary + daemon-as-NM-host manifest
sudo make install-daemon-nm-host-system

# 3. Stop root daemon if running
sudo systemctl disable --now webhid-daemon

# 4. Enable "Daemon as NM host" in the addon settings
#    (about:addons → WebHID → Options → Daemon as NM host)
```

#### User-local install (no root)

```sh
# 1. Install udev rule (one-time, needs root)
sudo make install-udev-rule

# 2. Install daemon + NM manifest into ~/.local
make install-daemon-nm-host-user

# 3. Stop root daemon if running
sudo systemctl disable --now webhid-daemon

# 4. Enable "Daemon as NM host" in the addon settings
```

The daemon uses a random WebSocket port in this mode (avoids conflicts with any root daemon instance). The port is announced via the `handshake` event.

The installed NM manifest (`webhid-daemon-nm-host.json`) uses the `"name": "webhid-daemon-nm-host"` identifier, distinct from the thin-forwarder manifest (`webhid-native-messaging-host`). The addon picks the correct name based on the "Daemon as NM host" toggle in its settings page.

> **Note:** This mode is not available on Windows — Firefox NM host requires an `.exe` in the `path` field and doesn't support arguments. Use the NM host thin forwarder on Windows.

---

## Windows

### MSI Installer

Download the `.msi` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases) and double-click to install.

The installer:
- Installs binaries to `C:\Program Files\WebHID\`
- Registers the native messaging host in the Windows registry (Firefox auto-detects)
- Creates a Scheduled Task ("WebHID Daemon") that auto-starts the daemon at logon

No manual setup needed; install and restart Firefox.

### Portable/Manual

Download the Windows zip from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), extract, then:

1. **Install binaries**: copy `webhid-daemon.exe` and `webhid-native-messaging.exe` to a permanent location (e.g. `C:\Program Files\WebHID\`)

2. **Register native messaging host**: create a registry key pointing to the NM manifest:

   ```powershell
   # Create webhid-native-messaging-host.json with the correct path:
   $installDir = "C:\Program Files\WebHID"
   $json = @"
   {
     "name": "webhid-native-messaging-host",
     "description": "WebHID native messaging host",
     "path": "$installDir\webhid-native-messaging.exe",
     "type": "stdio",
     "allowed_extensions": ["webhid@k4zoku.dev"]
   }
   "@
   $json | Out-File "$installDir\webhid-native-messaging-host.json" -Encoding ASCII

   # Register in registry:
   reg add "HKLM\SOFTWARE\Mozilla\NativeMessagingHosts\webhid-native-messaging-host" /ve /t REG_SZ /d "$installDir\webhid-native-messaging-host.json" /f
   ```

3. **Auto-start daemon**: create a Scheduled Task:

   ```powershell
   $action = New-ScheduledTaskAction -Execute "$installDir\webhid-daemon.exe"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName "WebHID Daemon" -Action $action -Trigger $trigger -Settings $settings -Force
   ```

   Or for the current session only: just run `webhid-daemon.exe` manually.

---

## macOS

### Homebrew

```sh
brew tap K4zoku/FF-WebHID https://github.com/K4zoku/FF-WebHID
brew install webhid
brew services start webhid
```

Homebrew installs the daemon as a background service (via `brew services`). The NM manifest is installed to `/usr/local/lib/mozilla/native-messaging-hosts/` (Homebrew prefix).

### Manual

Download the macOS zip from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), extract, then:

```sh
# Install binaries
sudo cp webhid-daemon /usr/local/bin/
sudo cp webhid-native-messaging /usr/local/bin/

# Install NM manifest
sudo mkdir -p /usr/local/lib/mozilla/native-messaging-hosts
sudo cp webhid-native-messaging-host.json /usr/local/lib/mozilla/native-messaging-hosts/

# Create launchd plist for auto-start
cat > ~/Library/LaunchAgents/dev.k4zoku.webhid-daemon.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.k4zoku.webhid-daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/webhid-daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/dev.k4zoku.webhid-daemon.plist
```

The NM manifest `webhid-native-messaging-host.json` should contain:

```json
{
  "name": "webhid-native-messaging-host",
  "description": "WebHID native messaging host",
  "path": "/usr/local/bin/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
```

> **Note**: On Apple Silicon Macs, the universal binary runs natively. No Rosetta needed.

---

## Verifying Installation

After installing the daemon, verify it's running:

```sh
# Linux
systemctl status webhid-daemon

# macOS
brew services info webhid
# or
launchctl list | grep webhid

# Windows
schtasks /query /tn "WebHID Daemon"
```

Then install the [browser extension](https://addons.mozilla.org/en-US/firefox/addon/webhid/) and visit a WebHID-enabled site. Open `about:debugging → Inspect → Console` to see connection logs.

## Troubleshooting

- **"Cannot connect to the WebHID daemon"**: daemon not running. Start it with the commands above.
- **"Permission denied"** (Linux non-root): udev rule not installed. Run `sudo make install-udev-rule` or copy `99-webhid.rules` manually.
- **Device picker shows "No HID devices found"**: daemon running but no HID devices detected. Check `hidapi` can enumerate: `ls /dev/hidraw*` (Linux).
- **Site breaks after enabling SAB**: COOP/COEP conflict. Disable SAB Data Plane in the addon popup settings.
