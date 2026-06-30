# WebHID for Firefox — Development Guide

WebHID is not supported in Firefox. This project adds it through a Firefox addon
that polyfills `navigator.hid`, a native-messaging bridge process, and a
privileged daemon that accesses HID devices via [hidapi](https://github.com/libusb/hidapi).

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
10. [Troubleshooting](#troubleshooting)

---

## Architecture

The project is split into a **Control Plane** for low-frequency management tasks and a **Data Plane** for high-frequency HID data.

```
 Web page
   │  navigator.hid  (polyfilled by webhid-polyfill.js, MAIN world)
   ▼
 addon/webhid-bridge.js ────────────────┐  (Data plane: binary WebSocket)
   │  runtime.sendMessage               │
   ▼                                    ▼
 addon/hid-worker.js (Web Worker)
   │ SharedArrayBuffer ring buffer      │
   │ + Atomics.waitAsync                │
   ▼                                    ▼
 addon/background.js              WebSocket (127.0.0.1:31337)
   │ nativeMessaging (stdio, JSON)      │
   ▼                                    ▼
 webhid-native-messaging (Rust)    webhid-daemon (Rust, root)
   │ Unix socket                        │ hidapi → hidraw
   ▼                                    ▼
 webhid-daemon ───────────────────► HID device
```

### Component responsibilities

| Component | What it does |
|---|---|
| `addon/webhid-polyfill.js` | Polyfills `navigator.hid` in every page (MAIN world); shows the device-picker modal; drains input reports from `SharedArrayBuffer` |
| `addon/webhid-bridge.js` | Content script (isolated world); handles device picker UI; forwards messages between page and background.js; spawns per-device Web Worker |
| `addon/background.js` | Background script; owns the native-messaging port; auto-reconnect on disconnect; injects COOP/COEP headers for SharedArrayBuffer |
| `addon/hid-worker.js` | Web Worker; maintains WebSocket connection to daemon; writes input reports into SAB ring buffer; sends output/feature reports via WS binary frames (fire-and-forget) |
| `addon/settings.html` | Settings page for toggling performance logging and fire-and-forget mode |
| `webhid-native-messaging` | Spawned by Firefox per-profile; translates between native-messaging protocol and daemon IPC; auto-reconnect to daemon on disconnect |
| `webhid-daemon` | Long-running system service; owns HID device handles via hidapi; provides WebSocket server for data plane; udev hot-plug monitor |
| `crates/webhid` | Shared Rust library: message types, protocol framing |

### Control plane (JSON)

Low-frequency operations: `enumerate`, `open`, `close`. Uses length-prefixed JSON over Unix socket (daemon ↔ NM host) and native messaging stdio (NM host ↔ Firefox).

### Data plane (binary WebSocket)

High-frequency operations: `sendReport`, `sendFeatureReport`, `receiveFeatureReport`, input reports. Uses binary WebSocket frames on `127.0.0.1:31337`.

**sendReport (page → daemon):** fire-and-forget. Worker resolves Promise immediately after `ws.send()`, no round-trip wait. Wire format:
```
[type:u8][req_id:u32 LE][report_id:u8][...payload]
```

**Input reports (daemon → page):** batched, 1ms flush interval. Wire format:
```
[len:u16 LE][report_id:u8][...payload][len:u16 LE][report_id:u8][...payload]...
```

**SAB ring buffer:** each slot is `[len:u16 LE][report_id:u8][...payload]`. Worker writes, page drains via `Atomics.waitAsync`.

### Security headers (COOP/COEP)

The addon injects `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on all HTTP/HTTPS responses to enable `SharedArrayBuffer`. This may break pages with cross-origin resources lacking CORP headers.

### Device IDs

Device identifiers are stable, platform-independent hashes:
```
device_id = djb2_hash("vid:pid:serial:interface:usage_page:usage:raw_path")
```

Composite USB devices (multiple HID interfaces) are grouped by (vid, pid, serial) and the "primary" interface (vendor-defined usage_page ≥ 0xFF00, or first non-boot) is selected for enumeration. This matches what most WebHID-consuming pages expect.

### Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry Unix socket connect (100ms → 2s, up to 30s)
- **background.js → NM host:** retry `connectNative` (1s → 10s)
- **Worker → daemon WS:** retry WebSocket (500ms → 5s)
- **Daemon:** detects NM host disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event

### Message flow example — `navigator.hid.getDevices()`

```
page                  background.js       native-messaging    daemon
 │                         │                     │                │
 │──sendMessage(enumerate)►│                     │                │
 │                         │──NM write──────────►│                │
 │                         │                     │──IPC write────►│
 │                         │                     │                │ hidapi enum
 │                         │                     │◄──IPC Devices──│
 │                         │◄──NM read───────────│                │
 │◄──sendResponse(devices)─│                     │                │
```

---

## Repository layout

```
WebHID/
├── addon/                   Firefox extension (manifest v3)
│   ├── manifest.json
│   ├── background.js        Background script — NM bridge, auto-reconnect, COOP/COEP
│   ├── webhid-polyfill.js   Content script (MAIN world) — navigator.hid polyfill
│   ├── webhid-bridge.js     Content script (isolated world) — device picker, worker spawn
│   ├── hid-worker.js        Web Worker — WebSocket client, SAB ring buffer, fire-and-forget
│   ├── settings.html/js     Settings page — perf logging, fire-and-forget toggle
│   ├── webhid.css           Styles for the device picker
│   ├── icons/               Extension icons
│   └── res/                 Device-type icons (SVG)
│
├── crates/                  Rust workspace
│   ├── Cargo.toml           Workspace manifest
│   ├── webhid/              Common library (types, protocol framing)
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs     IpcRequest, IpcResponse, NmRequest, NmResponse, DeviceInfo
│   │       └── protocol.rs  Length-prefixed JSON framing
│   ├── webhid-daemon/       System daemon
│   │   └── src/
│   │       ├── main.rs      Unix socket + WebSocket server entry point
│   │       ├── hid.rs       hidapi enumeration, I/O, device_id generation
│   │       ├── device_mgr.rs  Per-client device ownership, dual-handle (reader+writer)
│   │       ├── udev_monitor.rs  Hot-plug event thread (udev, cached DeviceInfo)
│   │       ├── client.rs    IPC handler, Hello event, ws_active flag
│   │       └── websocket.rs WS data plane, binary frame dispatch, ws_active
│   └── webhid-native-messaging/
│       └── src/
│           └── main.rs      Firefox ↔ daemon bridge, auto-reconnect, Hello forwarding
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
│   ├── test_nm.py           Native-messaging bridge test (no browser)
│   └── index.html           In-browser test UI
│
└── scripts/                 Build helpers
    ├── install.sh           One-shot install
    └── build-addon.sh       Build XPI from addon/
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
| `WEBHID_WS_PORT` | `31337` | WebSocket server port for high-frequency data |
| `WEBHID_WS_BATCH_MS` | `1` | Batch flush interval in milliseconds |
| `RUST_LOG` | `info` | Log level: `error`, `warn`, `info`, `debug`, `trace` |

---

## Loading the addon in Firefox

The content script only injects into `http://` and `https://` pages, not `file://`.
You must serve the test page over HTTP (see [Testing](#testing)).

### Firefox

1. Navigate to `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `addon/manifest.json`
5. The addon persists until you close Firefox or click **Remove**

### Per-user native-messaging manifest (without packaging)

If you want Firefox to find the native-messaging host without installing
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
  · 046d:c08b  Example_Device                 ExampleManufacturer   /dev/hidraw1
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

# Addon (content script / webhid-polyfill.js)
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
