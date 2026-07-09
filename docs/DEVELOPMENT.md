# Development Guide

## Prerequisites

### Runtime

| Dependency | Package (Arch) | Why |
|---|---|---|
| `libudev.so` | `systemd` | Daemon hot-plug (Linux) |
| `hidapi` | built from source by cargo | HID device access |

### Build

| Dependency | Package (Arch) | Why |
|---|---|---|
| Rust ≥ 1.85 | `rustup` or `rust` | edition 2024 |
| `libudev` headers | `systemd` | `udev` crate links at build time |
| `pkg-config` | `pkgconf` | hidapi build |
| `zip` | `zip` | Building addon XPI |

```sh
sudo pacman -S rust systemd pkgconf zip
```

## Building

```sh
# Debug
cargo build --manifest-path crates/Cargo.toml

# Release
make build                # or: make build CARGO_ARGS=--frozen

# Addon XPI (zips addon/)
make build-addon
```

Binaries: `crates/target/{debug,release}/webhid-daemon` and `webhid-native-messaging`.

## Running for development

Two terminals:

### Terminal 1: daemon

```sh
# Option A: root (simplest)
sudo RUST_LOG=debug crates/target/debug/webhid-daemon

# Option B: udev rule (recommended)
sudo make install-udev-rule
RUST_LOG=debug crates/target/debug/webhid-daemon
```

Override socket path: `WEBHID_SOCKET=/tmp/webhid-dev.sock RUST_LOG=debug crates/target/debug/webhid-daemon`

### Terminal 2: browser

1. Load addon via `about:debugging → Load Temporary Add-on → addon/manifest.json`
2. Per-user NM manifest (if not installed system-wide):

```sh
mkdir -p ~/.mozilla/native-messaging-hosts
cat > ~/.mozilla/native-messaging-hosts/webhid.forwarder_nm_host.json << EOF
{
  "name": "webhid.forwarder_nm_host",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

For daemon-as-NM-host mode, point `path` to the daemon binary directly:

```sh
cat > ~/.mozilla/native-messaging-hosts/webhid.daemon_nm_host.json << EOF
{
  "name": "webhid.daemon_nm_host",
  "description": "WebHID daemon as native-messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-daemon",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

Restart browser after writing these files. Paths must be absolute.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHID_SOCKET` | `/run/webhid/webhid.sock` (Linux) / `/tmp/webhid.sock` (macOS) | IPC socket path |
| `WEBHID_WS_PORT` | `31337` | WebSocket server port |
| `WEBHID_WS_BATCH_MS` | `0` | Input report flush policy. `0` = adaptive (drain + burst coalescing with 100μs window). `1`+ = fixed N ms timer. |
| `WEBHID_IPC_PORT` | `31338` | TCP IPC port (Windows only, replaces Unix socket) |
| `RUST_LOG` | `info` | Log level |

### Addon settings (development)

| Setting | Values | Default | Description |
|---|---|---|---|
| `controlPlane` | `nm` / `ws` | `nm` | Control plane: NM or WS text frames |
| `dataPlane` | `ws` / `nm` | `ws` | Data plane: WS worker+SAB or NM via bridge |
| `sabEnabled` | bool | `true` | SharedArrayBuffer for zero-copy input reports |
| `sabCapacity` | 2048–32768 | `8192` | SAB ring buffer slots |
| `fireAndForget` | bool | `true` | Resolve sendReport after `window.postMessage` (<0.1ms) |
| `daemonAsNmHost` | bool | `false` | Use daemon-as-NM-host (skip forwarder + socket) |
| `logLevel` | 0–3 | `1` | 0=error, 1=warn, 2=info, 3=debug |
| `perfLogging` | bool | `false` | Timing logs (only effective at debug level) |

All settings can be overridden per-site via the popup (saved to `site:<origin>` key in `browser.storage.local`).

## Testing

### Layer 1: daemon IPC (no browser)

```sh
python3 test/test_nm.py
```

### Layer 2: browser UI

```sh
cd test && python3 -m http.server 8080
```

Open `http://localhost:8080` in Firefox with the addon loaded.

### Watching logs

```sh
# Daemon (systemd)
journalctl -u webhid-daemon -f

# Addon background
# about:debugging → FF WebHID → Inspect → Console

# Page (polyfill)
# F12 Web Console on the page you're testing
```

## Repository layout

```
FF-WebHID/
├── addon/                   Firefox extension (MV3)
│   ├── manifest.json
│   ├── js/
│   │   ├── background.js    NM bridge, handshake, tab-targeted events, COOP/COEP
│   │   ├── polyfill.js      MAIN world: navigator.hid, early fire-and-forget, SAB drain
│   │   ├── bridge.js        Isolated world: control/data routing, WS control, worker spawn
│   │   ├── worker.js        Web Worker: binary WS, SAB ring buffer, fire-and-forget
│   │   ├── settings.js      Settings page logic
│   │   ├── popup.js         Popup logic (per-site settings, device list)
│   │   └── utils/logger.js  Level-based logger + perf timing
│   ├── html/                Settings + popup HTML
│   ├── css/                 Styles
│   ├── icons/ res/          Icons + device type icons
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared types (NmRequest, NmResponse, IpcRequest, IpcResponse)
│   ├── webhid-daemon/       System daemon (hidapi, WS server, adaptive batching, control WS)
│   └── webhid-native-messaging/  Firefox ↔ daemon thin forwarder
│
├── manifests/               NM manifests + systemd units + udev rule
│   ├── webhid.forwarder_nm_host.json   Forwarder NM manifest ({{NM_BIN}})
│   ├── webhid.daemon_nm_host.json      Daemon-as-NM-host manifest ({{DAEMON_BIN}})
│   └── ...
├── packaging/               Arch/Debian/RPM/Windows/macOS packaging
├── docs/
│   ├── ARCHITECTURE.md      System architecture
│   ├── DATA_PATH.md         Per-path copy/hop/latency analysis
│   ├── DEVELOPMENT.md       This file
│   └── INSTALLATION.md      Install guide + platform recommendations
└── test/                    test_nm.py + browser test UI
```

## Packaging (Arch Linux)

```sh
# Daemon + NM host + systemd service
cd packaging/webhid && makepkg -si

# Browser extension (system-wide XPI)
cd packaging/webhid-addon && makepkg -si
```

## Cross-platform

CI builds on Linux, Windows, and macOS. Platform-specific code is gated with `#[cfg]`:

| Platform | IPC | Hot-plug | hidapi feature | Daemon-as-NM-host |
|---|---|---|---|---|
| Linux | Unix socket | udev monitor | `linux-static-hidraw` | Yes (needs udev rule) |
| macOS | Unix socket | hidapi poll (2s) | `macos-shared-device` | Yes |
| Windows | Named pipe | hidapi poll (2s) | `windows-native` | Yes |

Daemon-as-NM-host works on all platforms. The daemon auto-detects NM mode via the 2 positional args Firefox passes (manifest path + addon ID).
