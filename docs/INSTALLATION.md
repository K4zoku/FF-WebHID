# Installation

WebHID requires two components:

1. **System daemon** (`webhid-daemon` + `webhid-native-messaging`): runs in the background, talks to HID hardware
2. **Browser extension**: installed in Firefox, bridges web pages to the daemon

Install the browser extension from AMO: **[WebHID](https://addons.mozilla.org/en-US/firefox/addon/webhid/)**

Choose your platform below for daemon installation.

---

## Choosing a daemon mode

The daemon has two deployment modes:

- **Daemon-as-NM-host (recommended on all platforms)**: the daemon speaks the
  native-messaging protocol directly on stdin/stdout. No separate forwarder
  process, no Unix socket, no IPC hop. The daemon runs as **your user** (not
  root), so it can only touch devices the OS grants your user (udev `uaccess`
  on Linux, TCC Input Monitoring on macOS, no special setup on Windows).
  Firefox spawns it on demand per session.
- **Persistent daemon + thin forwarder**: the daemon runs as a system service
  (root on Linux, `brew services` on macOS, Scheduled Task on Windows) and a
  tiny `webhid-native-messaging` forwarder bridges stdio to the Unix socket.
  This survives browser restarts and shares one daemon across the system.

Why Daemon-as-NM-host is recommended: one fewer process and IPC hop per
message (lower latency), and the daemon never runs as root. The forwarder
mode's only real advantage is persistence (daemon stays up across browser
restarts); its latency cost is a few microseconds per report, so pick it if
you want the daemon always-on. Both modes are switchable at any time from the
addon settings (`about:addons → WebHID → Options → Daemon as NM host`); all
packages ship both NM manifests.

## Packaging profiles per platform

Each distro package supports one or both daemon modes; the supported profile
is stated here so a package is only expected to make its own profile work.

```text
Profile A (on-demand daemon-as-NM-host):
  daemon binary + daemon NM manifest + device permission mechanism,
  no persistent service.

Profile B (persistent daemon + forwarder):
  daemon + forwarder binaries, forwarder NM manifest, platform-native
  service integration, IPC authorization (webhid group / socket perms).
```

| Package       | Profile | Notes                                                                           |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| Arch (AUR)    | A+B     | Root systemd service (B) plus both manifests on Firefox/LibreWolf/Waterfox (A). |
| Debian/Ubuntu | A+B     | systemd service, udev rule, `webhid` group created by postinst.                 |
| Fedora/RHEL   | A+B     | systemd service, udev rule, `webhid` group created by `%pre`.                   |
| Alpine        | B       | OpenRC + mdev; group created by pre-install hook.                               |
| Void          | B       | runit service shipped; systemd unit kept as reference.                          |
| NixOS         | B       | systemd service as `webhid` user, udev group rule for hidraw.                   |
| Homebrew      | A+B     | `webhid-register-firefox` (A) plus `brew services` (B).                         |
| Windows MSI   | A+B     | Registers both NM hosts; no persistent service (use Scheduled Task manually).   |
| Windows ZIP   | A       | `install.ps1` registers daemon-as-NM-host; MSI for all-users/B mode.            |
| macOS ZIP     | A       | `install.sh` registers daemon-as-NM-host; Homebrew for B mode.                  |

---

## Linux

### Arch Linux (AUR)

```sh
# Daemon + native messaging host
paru -S webhid           # or: yay -S webhid

# Browser extension (system-wide, optional; alternatively install from AMO)
paru -S webhid-addon
```

The AUR packages install the daemon as a systemd system service (root) with both
NM manifests. Recommended setup (daemon-as-NM-host, runs as your user):

```sh
# 1. Grant your user direct hidraw access (one-time)
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

# 2. Stop the root service (it would shadow the user daemon)
sudo systemctl disable --now webhid-daemon

# 3. Enable "Daemon as NM host" in the addon settings
```

> Note: A `uaccess` rule only takes effect when it is processed before `/usr/lib/udev/rules.d/73-seat-late.rules` applies the ACL. The shipped `72-webhid.rules` name already precedes it on systemd-based distributions, so no manual renaming is needed.

**Prefer a persistent root daemon?** Keep the service enabled instead:

```sh
sudo systemctl enable --now webhid-daemon
sudo usermod -aG webhid $USER
# log out + log back in for group change to take effect
```

Root daemon has access to all hidraw devices; no udev rule needed. Users must
be in the `webhid` group to connect via the thin forwarder. The latency cost
of the forwarder vs. daemon-as-NM-host is a few microseconds per report.

**User daemon (systemd user service, optional):**

```sh
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

# Disable root service, enable user service
sudo systemctl disable --now webhid-daemon
systemctl --user enable --now webhid-daemon
```

### Debian/Ubuntu (.deb)

Download the `.deb` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), then:

```sh
sudo dpkg -i webhid-<version>-<arch>.deb
sudo apt-get install -f    # fix any missing dependencies
```

The package installs and auto-starts the daemon as a systemd system service (root).
Both NM manifests are installed. For the recommended daemon-as-NM-host mode:

```sh
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl disable --now webhid-daemon
# Enable "Daemon as NM host" in the addon settings
```

**Prefer a persistent root daemon?** Leave the service enabled; add your user
to the `webhid` group (`sudo usermod -aG webhid $USER`) and connect via the
thin forwarder. The latency cost vs. daemon-as-NM-host is a few microseconds
per report.

**Non-root daemon (optional):**

```sh
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger

sudo systemctl disable --now webhid-daemon
systemctl --user enable --now webhid-daemon
```

### Fedora/RHEL (.rpm)

Download the `.rpm` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), then:

```sh
sudo dnf install webhid-<version>.<arch>.rpm
```

The package installs and auto-starts the daemon as a systemd system service (root).
Both NM manifests are installed. For the recommended daemon-as-NM-host mode:

```sh
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl disable --now webhid-daemon
# Enable "Daemon as NM host" in the addon settings
```

**Prefer a persistent root daemon?** Leave the service enabled; add your user
to the `webhid` group (`sudo usermod -aG webhid $USER`) and connect via the
thin forwarder. The latency cost vs. daemon-as-NM-host is a few microseconds
per report.

**Non-root daemon (optional):**

```sh
sudo cp manifests/72-webhid.rules /etc/udev/rules.d/
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

**Daemon-as-NM-host (recommended, runs as your user):**

```sh
sudo make install-udev-rule    # one-time: grants hidraw access to your user
sudo make install-daemon-nm-host-system
# Enable "Daemon as NM host" in the addon settings
```

Or user-local, no root needed after the udev rule:

```sh
sudo make install-udev-rule    # one-time: grants hidraw access to your user
make install-daemon-nm-host-user
```

**Persistent root daemon (optional, forwarder mode):**

```sh
sudo make install-system
sudo systemctl daemon-reload
sudo systemctl enable --now webhid-daemon
```

**User-local install (non-root daemon, optional):**

```sh
make install-user
sudo make install-udev-rule    # one-time: grants hidraw access to your user
systemctl --user daemon-reload
systemctl --user enable --now webhid-daemon
```

The install targets substitute the `{{NM_BIN}}` / `{{DAEMON_BIN}}` placeholders in `manifests/webhid.forwarder_nm_host.json` and `manifests/webhid.daemon_nm_host.json` with the actual binary paths, then place the resolved manifests into the system or per-user native-messaging directory. If you install manually instead of via `make`, you must do that substitution yourself (see the JSON snippets in the browser setup section of `docs/DEVELOPMENT.md`).

Install paths are configurable: `make install-system PREFIX=/usr` or `make install-user USER_PREFIX=$HOME/.local`.

> **udev rule**: The `72-webhid.rules` file grants console users access to `hidraw*` devices via `uaccess`, with explicit exclusions for known FIDO/U2F security keys (matching Chromium's `hid_blocklist.cc`). It is named before `73-seat-late.rules` so the `uaccess` tag is applied in time. This is only needed for non-root daemons. Root daemons already have full access.

### Daemon-as-NM-host mode (details)

Eliminates the separate NM host binary and IPC socket; the daemon speaks native-messaging protocol directly on stdin/stdout, saving one IPC hop per message (a few microseconds of latency vs. the forwarder).

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

The installed NM manifest (`webhid.daemon_nm_host.json`) uses the `"name": "webhid.daemon_nm_host"` identifier, distinct from the thin-forwarder manifest (`webhid.forwarder_nm_host`). The addon picks the correct name based on the "Daemon as NM host" toggle in its settings page.

> **Note:** On Windows, the NM manifest `path` field can be the bare executable name (`webhid-daemon.exe`). Firefox resolves relative paths against the manifest's own directory, so the JSON must live next to the binary. The daemon auto-detects NM-host mode via the 2 positional args Firefox passes (manifest path + addon ID). No wrapper script or `--nm-host` flag needed.

---

## Windows

### MSI Installer

Download the `.msi` from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases) and double-click to install.

The installer:

- Installs binaries to `C:\Program Files\WebHID\`
- Registers the native messaging host in the Windows registry (Firefox auto-detects)
- Registers both `webhid.forwarder_nm_host` and `webhid.daemon_nm_host` manifests

Install and restart Firefox. On Windows, `daemonAsNmHost` defaults to `true` (the recommended mode: the daemon speaks NM directly, no forwarder process needed) and Windows has no special HID permission setup. The installer already registers both manifests, so you can switch to the persistent forwarder mode from the addon settings anytime (see "Choosing a daemon mode" above).

### Portable/Manual

Download the Windows zip from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), extract, then run:

```powershell
.\install.ps1
```

The zip contains `bin/` (both executables), `manifests/` (manifest templates), `install.ps1`, and `uninstall.ps1`. `install.ps1` writes both manifests into `%APPDATA%\Mozilla\NativeMessagingHosts` with absolute paths pointing at the extracted `bin/`, and registers the per-user Firefox `NativeMessagingHosts` registry keys, so the folder can live anywhere; re-run it after moving it. `uninstall.ps1` removes the registration. No admin rights are needed.

For a system-wide install (all users) or auto-start of the persistent daemon, use the MSI instead; the portable zip targets daemon-as-NM-host mode.

---

## macOS

### Homebrew

```sh
brew tap K4zoku/FF-WebHID https://github.com/K4zoku/FF-WebHID
brew install webhid
brew services start webhid
```

Homebrew installs the daemon as a background service via `brew services` (persistent forwarder mode; the NM manifests are installed to `/usr/local/lib/mozilla/native-messaging-hosts/`). For the recommended daemon-as-NM-host mode, stop the service and enable the toggle in the addon settings instead:

```sh
brew services stop webhid
# Enable "Daemon as NM host" in the addon settings
```

> **Note:** macOS requires Input Monitoring (TCC) permission for `IOHIDManager` access. There is no way to prompt for it programmatically; grant it manually in System Settings → Privacy & Security → Input Monitoring.

### Manual

Download the macOS zip from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases), extract, then register the native-messaging hosts for Firefox (per-user, no root):

```sh
./install.sh
```

The zip contains:

```text
bin/webhid-daemon
bin/webhid-native-messaging
manifests/webhid.forwarder_nm_host.json
manifests/webhid.daemon_nm_host.json
install.sh
uninstall.sh
```

`install.sh` writes both manifests into `~/Library/Application Support/Mozilla/NativeMessagingHosts` with absolute paths pointing at the extracted `bin/`, so the bundle can live anywhere; re-run it after moving the folder. `uninstall.sh` removes the registration. For the persistent forwarder mode, use Homebrew instead (`brew install K4zoku/FF-WebHID/webhid && brew services start webhid`); the zip targets daemon-as-NM-host mode.

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
- **"Permission denied (os error 13)"** (Linux root daemon, thin forwarder mode): your user is not in the `webhid` group. Fix with `sudo usermod -aG webhid $USER`, then log out and back in. The NM host logs this with diagnostic hints before exiting.
- **"Permission denied"** (Linux non-root daemon): udev rule not installed. Run `sudo make install-udev-rule` or copy `72-webhid.rules` manually.
- **NM host silent failure** (addon paralyzed, no logs): the NM host writes `{"s":503,"E":"..."}` error frame to stdout before exiting, addon logs `[nm] host error: <reason>`.
- **Device picker shows "No HID devices found"**: daemon running but no HID devices detected. Check `hidapi` can enumerate: `ls /dev/hidraw*` (Linux).
- **Badge counter not showing**: ensure the device is opened via `navigator.hid.requestDevice()`, the counter tracks open devices, not paired ones.
- **NM data plane is slow**: switch Data Plane to WebTransport when available (the default), or WebSocket otherwise. Use NM when the site's security policy blocks both worker transports.
- **WebTransport or worker WebSocket retries on Firefox 154**: Local Network Access can affect both worker WebSocket and page-context WebTransport. WebSocket is the practical path that can surface the browser permission UI; after granting it, WebTransport may work. If the network data plane still cannot start, FF-WebHID falls back to Native Messaging. `network.lna.blocking=false` is the narrower workaround; `network.lna.enabled=false` disables LNA more broadly.
- **Daemon restart causes input report freeze**: workers detect WS close code 4401 (unknown token); the bridge refreshes the data plane by reusing a live session token when possible instead of opening a new HID session solely for transport refresh.
- **Settings change doesn't take effect**: `SettingsStore` Proxy observer fires listeners only on actual value change.

## Recommended Settings per Platform

### Linux

| Setting            | Recommended      | Reason                                                                                                                                                                  |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon as NM host  | ON (recommended) | Runs daemon as your user, no forwarder process / Unix socket, one less IPC hop. Needs udev `uaccess` rule. OFF only if you prefer a persistent root daemon + forwarder. |
| Data Plane         | WT (default)     | WebTransport in a worker keeps page rendering isolated; use WebSocket when WT is unavailable, or NM when site policy blocks both worker transports.                     |
| Device Picker Mode | modal (default)  | Inline dialog, least friction. pageAction/window available for single-device sites.                                                                                     |

**Setup**: Install daemon (system package or `make install-system`). Recommended: install the udev rule (`sudo make install-udev-rule` or copy `72-webhid.rules`) and enable "Daemon as NM host" in the addon settings; no group membership needed. Alternative: keep the root daemon + thin forwarder and add your user to the `webhid` group (`sudo usermod -aG webhid $USER`, log out + back in).

### Windows

| Setting           | Recommended  | Reason                                                                                                                                              |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon as NM host | ON (default) | Recommended mode: daemon speaks NM directly, no forwarder. Windows has no permission setup; daemon auto-detects via Firefox's 2 positional args.    |
| Data Plane        | WT (default) | WebTransport in a worker keeps page rendering isolated; use WebSocket when WT is unavailable, or NM when site policy blocks both worker transports. |

**Setup**: Install MSI or portable zip. `daemonAsNmHost` defaults to `true` on Windows (auto-detected). For forwarder mode, register `webhid.forwarder_nm_host.json` with `path` pointing to `webhid-native-messaging.exe`.

### macOS

| Setting           | Recommended  | Reason                                                                                                                                              |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon as NM host | ON           | Recommended mode: no forwarder / Unix socket, one less hop                                                                                          |
| Data Plane        | WT (default) | WebTransport in a worker keeps page rendering isolated; use WebSocket when WT is unavailable, or NM when site policy blocks both worker transports. |

**Setup**: Install via Homebrew (`brew install webhid`) or manual. Recommended: stop the `brew services` daemon and enable "Daemon as NM host" in the addon settings. Grant HID permissions in System Settings → Privacy & Security → Input Monitoring if prompted.

### Benchmarking / Debugging

| Setting    | Recommended | Reason                                               |
| ---------- | ----------- | ---------------------------------------------------- |
| Data Plane | NM          | Isolates NM path performance (no worker/WS overhead) |
| Log Level  | Debug       | See all message timings + settings change logs       |
