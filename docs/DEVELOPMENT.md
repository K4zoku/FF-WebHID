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
| `controlPlane` | `nm` / `ws` | `nm` | Control plane: NM or WS text frames via control worker |
| `dataPlane` | `ws` / `nm` | `nm` | Data plane: WS worker (postMessage + MessageChannel) or NM via bridge |
| `fireAndForget` | bool | `true` | Resolve sendReport after `window.postMessage` (<0.1ms) |
| `daemonAsNmHost` | bool | `false` | Use daemon-as-NM-host (skip forwarder + socket) |
| `logLevel` | 0 to 3 | `1` | 0=error, 1=warn, 2=info, 3=debug |
| `perfLogging` | bool | `false` | Timing logs (only effective at debug level) |

All settings can be overridden per-site via the popup (saved to `site:<origin>` key in `browser.storage.local`).

The bridge's `storage.onChanged` listener computes effective settings (global merged with site override) before and after each change, and only acts when the effective value actually changes. This prevents unnecessary worker respawns when a global setting change does not affect the current site's effective value.

## Testing

### Layer 1: daemon IPC (no browser)

No automated test exists. The previous `test/test_nm.py` was removed (stale, pre-camelCase). Manual testing via the browser UI is the primary method.

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
│   │   ├── background.js    NM bridge, handshake, tab-targeted events, daemonAsNmHost
│   │   ├── polyfill.js      MAIN world: navigator.hid, early fire-and-forget, MessageChannel input reports
│   │   ├── bridge.js        Isolated world: control/data routing, control worker, data worker spawn, effective-settings handler
│   │   ├── worker.js        Data Web Worker: binary WS, MessageChannel input reports, fire-and-forget
│   │   ├── control.js       Control Web Worker: WS text frames, enumerate/close, auto-reconnect
│   │   ├── settings.js      Settings page logic (global settings UI)
│   │   ├── popup.js         Popup logic (per-site settings, device list)
│   │   └── utils/
│   │       ├── logger.js         Level-based logger (storage-driven)
│   │       ├── settings.js       GLOBAL_DEFAULTS + SettingsStore Proxy factory
│   │       ├── http-status.js    HTTP status code helper (isOk, name)
│   │       └── device-utils.js   Device type guessing for popup icons
│   ├── html/                Settings + popup HTML
│   ├── css/                 Styles
│   ├── icons/ res/          Icons + device type icons
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared types (NmRequest, NmResponse, IpcRequest, IpcResponse) + FNV-1a hash + packed TLV parsers. NM wire: single-char fields + HTTP status + packed binary TLVs.
│   ├── webhid-daemon/       System daemon (hidapi, WS server, adaptive batching, control WS)
│   └── webhid-native-messaging/  Firefox ↔ daemon thin forwarder (writes error frame on connect failure)
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
│   ├── INSTALLATION.md      Install guide + platform recommendations
│   └── BENCHMARK.md         Benchmark report (cold-start, 5 runs per mode)
└── test/                    Browser test UI (test_nm.py removed)
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
