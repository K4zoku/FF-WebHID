# WebHID for Firefox — Development Guide

WebHID is not supported in Firefox. This project adds it through a Firefox addon
that polyfills `navigator.hid`, a native-messaging bridge process, and a
privileged daemon that reads and writes `/dev/hidraw*` nodes on behalf of the
browser.

---

## Table of contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Building](#building)
5. [Running for development](#running-for-development)
6. [Loading the addon in Zen / Firefox](#loading-the-addon-in-zen--firefox)
7. [Testing](#testing)
8. [HID device access and udev rules](#hid-device-access-and-udev-rules)
9. [Packaging (Arch Linux)](#packaging-arch-linux)
10. [Protocol reference](#protocol-reference)
11. [Troubleshooting](#troubleshooting)

---

## Architecture

```
 Web page
   │  window.navigator.hid  (WebHID API, polyfilled by content script)
   ▼
 addon/webhid.js              ← content script, injected into every page
   │  browser.runtime.sendMessage
   ▼
 addon/background.js          ← service worker / background script
   │  Firefox native-messaging  (stdin/stdout, 4-byte LE length + JSON)
   ▼
 webhid-native-messaging      ← Rust binary, spawned by Firefox on demand
   │  Unix socket  /run/webhid/webhid.sock  (same framing as NM protocol)
   ▼
 webhid-daemon                ← Rust binary, persistent system daemon (root)
   │  /dev/hidraw*            ← Linux kernel hidraw interface
   ▼
 HID device
```

### Component responsibilities

| Component | What it does |
|---|---|
| `addon/webhid.js` | Polyfills `navigator.hid` in every page; shows the device-picker modal; forwards inputreport events from background to page |
| `addon/background.js` | Persistent bridge between content scripts and native messaging; serialises requests one at a time |
| `webhid-native-messaging` | Spawned by Firefox per-profile; translates between the native-messaging protocol and the IPC protocol; forwards unsolicited events (device connect/disconnect, input reports) to Firefox |
| `webhid-daemon` | Long-running system service; owns all open hidraw file descriptors; broadcasts udev hot-plug events to every connected native-messaging process |
| `crates/webhid` | Shared Rust library: all message types, protocol framing helpers |

### Message flow example — `navigator.hid.getDevices()`

```
page                  background.js       native-messaging    daemon
 │                        │                    │               │
 │──sendMessage(enumerate)►│                   │               │
 │                        │──NM write──────────►│               │
 │                        │                    │──IPC write────►│
 │                        │                    │                │ udev enum
 │                        │                    │◄──IPC Devices──│
 │                        │◄──NM read──────────│               │
 │◄──sendResponse(devices)─│                   │               │
```

---

## Repository layout

```
WebHID/
├── addon/                   Firefox extension (manifest v3)
│   ├── manifest.json
│   ├── background.js        Background service worker
│   ├── webhid.js            Content script — WebHID polyfill + device picker
│   └── icons/
│
├── crates/                  Rust workspace
│   ├── Cargo.toml           Workspace manifest
│   ├── webhid/              Common library (types, protocol framing)
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs     IpcRequest, IpcResponse, NmRequest, NmResponse, DeviceInfo
│   │       └── protocol.rs  read_message / write_message (async, length-prefixed JSON)
│   ├── webhid-daemon/       System daemon
│   │   └── src/
│   │       ├── main.rs      Unix socket server, event broadcast setup
│   │       ├── hid.rs       udev enumeration, hidraw open/read/write
│   │       ├── device_mgr.rs  Per-client device ownership tracking
│   │       ├── udev_monitor.rs  Hot-plug event thread
│   │       └── client.rs    Per-connection IPC handler
│   └── webhid-native-messaging/
│       └── src/
│           └── main.rs      Firefox ↔ daemon bridge
│
├── manifests/               Installation helpers
│   ├── webhid_server.json   Native-messaging host manifest template
│   ├── webhid-daemon.service  systemd unit template
│   └── install.sh           One-shot install script (non-package installs)
│
├── packaging/               Arch Linux packages
│   ├── webhid/PKGBUILD      daemon + native messaging + systemd + NM manifests
│   └── webhid-addon/PKGBUILD  browser extension XPI (system-wide)
│
├── test/                    Test suite
│   ├── test_daemon.py       IPC socket test (no browser)
│   ├── test_nm.py           Native-messaging bridge test (no browser)
│   └── index.html           In-browser test UI
│
└── server/                  Reference C++ implementation (read-only, do not edit)
```

---

## Prerequisites

### Runtime

| Dependency | Package (Arch) | Why |
|---|---|---|
| `libudev.so` | `systemd` | Daemon links against libudev for hot-plug |
| `zip` | `zip` | `webhid-addon` PKGBUILD only |

### Build

| Dependency | Package (Arch) | Why |
|---|---|---|
| Rust ≥ 1.85 | `rustup` or `rust` | edition 2024 |
| `cargo` | bundled with Rust | Build tool |
| `libudev` headers | `systemd` (headers included) | `udev` crate links at build time |

```sh
# Arch Linux
sudo pacman -S rust systemd
```

---

## Building

The three crates share a single Cargo workspace rooted at `crates/`.

```sh
# Debug build (fast, includes debug symbols)
cargo build --manifest-path crates/Cargo.toml

# Release build (optimised, used for packaging)
cargo build --release --manifest-path crates/Cargo.toml
```

Binaries land in `crates/target/{debug,release}/`:

```
crates/target/release/webhid-daemon
crates/target/release/webhid-native-messaging
```

---

## Running for development

You need two terminals — one for the daemon and one for everything else.

### Terminal 1 — daemon

The daemon needs permission to open `/dev/hidraw*`.  
The two options are:

**Option A — run as root (simplest):**
```sh
sudo RUST_LOG=debug crates/target/debug/webhid-daemon
```

**Option B — udev rule (recommended, lets you run as your normal user):**
```sh
# Grant the active seat user access to all hidraw nodes
echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/99-webhid.rules
sudo udevadm control --reload-rules
sudo udevadm trigger   # re-trigger for already-connected devices

# Now run without sudo
RUST_LOG=debug crates/target/debug/webhid-daemon
```

The daemon listens on `/run/webhid/webhid.sock` by default.  
Override with the `WEBHID_SOCKET` environment variable:

```sh
WEBHID_SOCKET=/tmp/webhid-dev.sock RUST_LOG=debug \
  crates/target/debug/webhid-daemon
```

### Terminal 2 — native messaging (optional, for manual testing)

Firefox spawns the native-messaging binary automatically when the addon connects.
You can also run it manually to poke the daemon without a browser:

```sh
# See test/test_nm.py for an automated version of this
WEBHID_NM=crates/target/debug/webhid-native-messaging \
  python3 test/test_nm.py
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHID_SOCKET` | `/run/webhid/webhid.sock` | IPC socket path, respected by both binaries |
| `RUST_LOG` | `info` | Log level: `error`, `warn`, `info`, `debug`, `trace` |

---

## Loading the addon in Zen / Firefox

The content script only injects into `http://` and `https://` pages, not `file://`.
You must serve the test page over HTTP (see [Testing](#testing)).

### Zen Browser

1. Navigate to `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `addon/manifest.json`
5. The addon persists until you close Zen or click **Remove**

> **Why does Zen not pick up the system-wide XPI automatically?**  
> Zen currently reads the per-user native-messaging manifest from
> `~/.mozilla/native-messaging-hosts/` instead of the Zen-specific path
> `~/.zen/native-messaging-hosts/` ([upstream bug #10622][zen-nm-bug]).
> The `webhid-addon` package installs the XPI to
> `/usr/lib/mozilla/extensions/{ec8030f7-…}/` which uses the same shared path,
> so it *should* be picked up — but if it isn't, load it temporarily as above.
> The native-messaging manifest at `/usr/lib/mozilla/native-messaging-hosts/`
> works correctly for both Firefox and Zen.

[zen-nm-bug]: https://github.com/zen-browser/desktop/issues/10622

### Per-user native-messaging manifest (without packaging)

If you want Firefox / Zen to find the native-messaging host without installing
the package, copy the manifest manually and point it at the debug binary:

```sh
mkdir -p ~/.mozilla/native-messaging-hosts
cat > ~/.mozilla/native-messaging-hosts/webhid_server.json << EOF
{
  "name": "webhid_server",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@firefox.org"]
}
EOF
```

Restart the browser after writing this file.  
The `"path"` must be **absolute** — relative paths are rejected.

---

## Testing

There are three independent test layers. Always start from layer 1 and work up
— a failure at layer N tells you the problem is in that layer, not higher up.

### Layer 1 — daemon IPC (no browser required)

Tests the daemon socket directly using raw JSON over a Unix socket.

```sh
python3 test/test_daemon.py
```

Custom socket path:
```sh
WEBHID_SOCKET=/tmp/webhid-dev.sock python3 test/test_daemon.py
```

Expected output (with a device connected):
```
WebHID Daemon IPC Test
Socket : /run/webhid/webhid.sock
────────────────────────────────────────────────────

[1 · Connect]
  ✓ Connected to daemon

[2 · Enumerate devices]
  ✓ 3 device(s) found
  · 046d:c08b  G502_HERO_Gaming_Mouse        Logitech   /dev/hidraw1
  ...

[3 · Open  /dev/hidraw1]
  ✓ Opened  →  device_id = '/dev/hidraw1'

[4 · Read  (500 ms timeout)]
  · Timed out – device sent no data in 500 ms (normal for idle devices)

[5 · Write  (single 0x00 byte)]
  · Write returned error: Invalid argument (os error 22)  (device may not support writes)

[6 · Close]
  ✓ Closed

  All tests passed.
```

> A read timeout on step 4 is **normal** for idle devices — it means the hidraw
> node opened successfully and is waiting for input. Move a mouse or press a key
> on your device to produce data.

### Layer 2 — native-messaging bridge (no browser required)

Spawns `webhid-native-messaging` as a subprocess and speaks the Firefox
native-messaging protocol over its stdin/stdout — exactly what Firefox does.

```sh
# Installed package:
python3 test/test_nm.py

# From the repository:
WEBHID_NM=crates/target/debug/webhid-native-messaging \
  python3 test/test_nm.py
```

### Layer 3 — browser UI

Serve the test page over HTTP so the content script can inject into it:

```sh
cd test && python3 -m http.server 8080
```

Open `http://localhost:8080` in Zen Browser **with the addon loaded**.

The test UI has four sections:

| Section | What it tests |
|---|---|
| **API badge** (top) | Green = content script injected `navigator.hid` correctly |
| **NM badge** (top) | Green after a successful enumerate = native-messaging channel works |
| **Devices panel** (left) | Enumerate, Request Device picker, Open, Close |
| **I/O panel** (right) | Read (single / loop), Write (hex bytes), inputreport event listener |
| **Log panel** (right) | Timestamped trace of every operation |

**Recommended test sequence:**

1. Click **Enumerate** → devices appear in the list
2. Click a device card to select it → **Open** becomes enabled
3. Click **Open**
4. Click **Read** with timeout 1000 ms → should return data or "timed out" for idle device
5. Click **Start listening** → interact physically with the device → events appear in the log
6. Click **Close**

### Watching logs while testing

```sh
# Daemon (systemd)
journalctl -u webhid-daemon -f

# Daemon (manual, already set RUST_LOG)
# logs appear in the terminal where you ran it

# Native-messaging bridge
# logs go to stderr, which Firefox captures; view in about:debugging
# or set RUST_LOG=debug before launching the browser

# Addon (background.js)
# open about:debugging → This Firefox → webhid → Inspect → Console

# Addon (content script / webhid.js)
# open the browser's Web Console on the page you're testing (F12)
```

---

## HID device access and udev rules

By default only root can open `/dev/hidraw*`. There are two ways to grant access:

### Option A — grant all hidraw nodes to the session user (development)

```sh
# /etc/udev/rules.d/99-webhid.rules
SUBSYSTEM=="hidraw", TAG+="uaccess"
```

`TAG+="uaccess"` makes logind grant access to the device to whoever is logged
in at the physical seat. Replug the device after reloading rules:

```sh
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### Option B — restrict to specific vendor/product IDs (production)

```sh
# /etc/udev/rules.d/99-webhid.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c08b", TAG+="uaccess"
```

Find your IDs with `lsusb` or from the daemon's enumerate output.

### Option C — run the daemon as root via systemd

The systemd unit installed by the `webhid` package runs the daemon as root
automatically, so no udev rule is needed when using the package.

---

## Packaging (Arch Linux)

Two separate PKGBUILDs live under `packaging/`.

### `webhid` — daemon + native-messaging + systemd + NM manifests

```sh
cd packaging/webhid
makepkg -si
```

Installs:
- `/usr/bin/webhid-daemon`
- `/usr/bin/webhid-native-messaging`
- `/usr/lib/systemd/system/webhid-daemon.service`
- `/usr/lib/mozilla/native-messaging-hosts/webhid_server.json`
- `/usr/lib/librewolf/native-messaging-hosts/webhid_server.json`
- `/usr/lib/waterfox/native-messaging-hosts/webhid_server.json`

After installing, enable the daemon:
```sh
sudo systemctl enable --now webhid-daemon.service
```

### `webhid-addon` — system-wide browser extension XPI

```sh
cd packaging/webhid-addon
makepkg -si
```

Installs an XPI to:
- `/usr/lib/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}/webhid@firefox.org.xpi`
- `/usr/lib/librewolf/extensions/webhid@firefox.org.xpi`
- `/usr/lib/waterfox/extensions/webhid@firefox.org.xpi`

Extensions in these directories bypass AMO signature verification by design.
Restart the browser after installing to pick up the XPI.

### Bumping the version

Update `pkgver` in both `PKGBUILD` files and the `version` field in
`crates/webhid/Cargo.toml` (the workspace inherits it from there).

---

## Protocol reference

All messages are framed identically in both channels:

```
┌────────────────────┬─────────────────────────────┐
│  length : u32 LE   │  JSON payload : [u8; length] │
└────────────────────┴─────────────────────────────┘
```

### IPC protocol (native-messaging process → daemon)

**Requests** — discriminated by `"type"`:

| `type` | Extra fields | Description |
|---|---|---|
| `Enumerate` | `id` | List all connected hidraw devices |
| `Open` | `id`, `vendor_id`, `product_id` | Open first matching device |
| `Close` | `id`, `device_id` | Release an open device |
| `Read` | `id`, `device_id`, `timeout_ms` | Block until report arrives or timeout |
| `Write` | `id`, `device_id`, `data` | Send output report bytes |

**Responses / events** — also discriminated by `"type"`; `id` matches the request, or `0` for unsolicited events:

| `type` | `id` | Extra fields |
|---|---|---|
| `Devices` | req | `devices: [DeviceInfo]` |
| `Opened` | req | `device_id: String` (hidraw path) |
| `Ok` | req | — |
| `Data` | req | `data: [u8]` |
| `Error` | req | `message: String` |
| `DeviceConnected` | `0` | `device: DeviceInfo` |
| `DeviceDisconnected` | `0` | `device: DeviceInfo` |
| `InputReport` | `0` | `device_id`, `report_id: u8`, `data: [u8]` |

**`DeviceInfo`** object:

```json
{
  "vendor_id":    32909,
  "product_id":   49291,
  "product_name": "G502 HERO Gaming Mouse",
  "manufacturer": "Logitech",
  "serial_number": "...",
  "path":         "/dev/hidraw1"
}
```

### Native-messaging protocol (Firefox addon → native-messaging process)

**Requests** (from Firefox) — discriminated by `"action"`:

| `action` | Extra fields | Notes |
|---|---|---|
| `enumerate` | — | Returns all devices |
| `open` | `vendor_id`, `product_id` | Returns device path as byte array in `data` |
| `close` | `data: [u8]` | `data` = device path encoded as char codes |
| `read` | `data: [u8]`, `timeout: ms` | `data` = device path as char codes |
| `write` | `device_id: [u8]`, `data: [u8]` | Separate arrays for path and report |

**Responses** (to Firefox):

```json
{ "success": true, "devices": [ ... ] }      // enumerate
{ "success": true, "data": [47, 100, ...] }   // open — device path as bytes
{ "success": true }                            // close / write
{ "success": true, "data": [0, 1, 2, ...] }   // read — report bytes
{ "success": false, "error": "..." }           // any failure
```

**Push events** (daemon → native-messaging → Firefox, no `success` key):

```json
{ "event_type": "connect",      "device": { ... } }
{ "event_type": "disconnect",   "device": { ... } }
{ "event_type": "input_report", "device_id": [47,...], "report_id": 0, "data": [...] }
```

> **Why are device IDs byte arrays?**  
> Firefox native-messaging serialises binary data as JSON arrays of integers.
> The device path (e.g. `/dev/hidraw0`) is encoded as `[47, 100, 101, ...]`
> so it round-trips through `String.fromCharCode(...data)` /
> `str.split('').map(c => c.charCodeAt(0))` in the addon without a binary
> transport layer.

---

## Troubleshooting

### `navigator.hid` is undefined

- The addon is not loaded. Go to `about:debugging → This Firefox → Load Temporary Add-on`.
- The page is on a `file://` URL. Serve it via `python3 -m http.server` instead.
- Check the Web Console for errors in `webhid.js`.

### Native-messaging times out / fails to connect

```sh
# 1. Is the daemon running?
systemctl status webhid-daemon

# 2. Does the socket exist?
ls -la /run/webhid/webhid.sock

# 3. Can the native-messaging binary reach the socket?
WEBHID_NM=crates/target/debug/webhid-native-messaging python3 test/test_nm.py

# 4. Check the NM manifest is installed and path is absolute
cat ~/.mozilla/native-messaging-hosts/webhid_server.json
```

### Enumerate returns 0 devices

```sh
# Check udev can see hidraw nodes
ls /dev/hidraw*

# Check daemon logs for enumeration errors
journalctl -u webhid-daemon -n 50

# Run the IPC test directly
python3 test/test_daemon.py
```

### Open returns "Permission denied"

The daemon cannot open the hidraw device. Add a udev rule:

```sh
echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/99-webhid.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Or run the daemon as root: `sudo systemctl restart webhid-daemon`.

### Open returns "already open"

Another process (or a previous test run) has the device open. Close it:

```sh
# Find what has the hidraw node open
lsof /dev/hidraw0

# Or just restart the daemon (it closes all tracked devices)
sudo systemctl restart webhid-daemon
```

### Read always times out even when I interact with the device

Some devices (keyboards, mice) have their input captured by the kernel input
subsystem via the `hid-generic` driver. The kernel consumes the events before
hidraw sees them for most report types.

Use a custom HID device, a USB gamepad, or a device that exposes a vendor-
specific HID interface (e.g. a mechanical keyboard's configuration interface,
a gaming mouse's RGB control endpoint) — these are not grabbed by the kernel.

Check which driver has the device:
```sh
cat /sys/class/hidraw/hidraw0/device/driver/module/drivers/*/uevent 2>/dev/null
# or
udevadm info /dev/hidraw0 | grep DRIVER
```

### inputreport events never fire in the browser

1. Confirm **Start listening** is active (button disabled, counter shows).
2. Confirm the device is actually sending data — use **Read (loop)** first.
3. Check background.js console in `about:debugging` for forwarding errors.
4. The daemon pushes `InputReport` events only when a device is *opened* by
   the native-messaging process. The polyfill's `addEventListener('inputreport')`
   passive listener does not automatically open the device — you must call
   `device.open()` first.
