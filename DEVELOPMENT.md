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
cargo build --release --manifest-path crates/Cargo.toml

# Addon XPI
./scripts/build-addon.sh
```

Binaries: `crates/target/{debug,release}/webhid-daemon` and `webhid-native-messaging`.

## Running for development

Two terminals:

### Terminal 1 — daemon

```sh
# Option A: root (simplest)
sudo RUST_LOG=debug crates/target/debug/webhid-daemon

# Option B: udev rule (recommended)
echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-webhid.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
RUST_LOG=debug crates/target/debug/webhid-daemon
```

Override socket path: `WEBHID_SOCKET=/tmp/webhid-dev.sock RUST_LOG=debug crates/target/debug/webhid-daemon`

### Terminal 2 — browser

1. Load addon via `about:debugging → Load Temporary Add-on → addon/manifest.json`
2. Per-user NM manifest (if not installed system-wide):

```sh
mkdir -p ~/.mozilla/native-messaging-hosts
cat > ~/.mozilla/native-messaging-hosts/webhid_server.json << EOF
{
  "name": "webhid_server",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

Restart browser after writing this file. Path must be absolute.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHID_SOCKET` | `/run/webhid/webhid.sock` (Linux) / `/tmp/webhid.sock` (macOS) | IPC socket path |
| `WEBHID_WS_PORT` | `31337` | WebSocket server port |
| `WEBHID_WS_BATCH_MS` | `1` | Input report batch flush interval (ms) |
| `WEBHID_IPC_PORT` | `31338` | TCP IPC port (Windows only, replaces Unix socket) |
| `RUST_LOG` | `info` | Log level |

## Testing

### Layer 1 — daemon IPC (no browser)

```sh
python3 test/test_nm.py
```

### Layer 2 — browser UI

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
│   ├── background.js        NM bridge, auto-reconnect, COOP/COEP
│   ├── webhid-polyfill.js   Content script (MAIN world) — navigator.hid polyfill
│   ├── webhid-bridge.js     Content script (isolated world) — device picker, worker spawn
│   ├── hid-worker.js        Web Worker — WebSocket, SAB ring buffer, fire-and-forget
│   ├── settings.html/js     Settings page
│   ├── webhid.css           Device picker styles
│   ├── icons/ res/          Icons
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared types + protocol
│   ├── webhid-daemon/       System daemon (hidapi, WS server, hot-plug)
│   └── webhid-native-messaging/  Firefox ↔ daemon bridge
│
├── manifests/               NM manifest + systemd unit + install script
├── packaging/               Arch Linux PKGBUILDs
├── docs/
│   └── ARCHITECTURE.md      System architecture
├── test/                    test_nm.py + browser test UI
└── scripts/                 build-addon.sh, install.sh
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

| Platform | IPC | Hot-plug | hidapi feature |
|---|---|---|---|
| Linux | Unix socket | udev monitor | `linux-static-hidraw` |
| macOS | Unix socket | hidapi poll (2s) | `macos-shared-device` |
| Windows | TCP localhost | hidapi poll (2s) | `windows-native` |

No autostart — run daemon manually or set up a service/agent.
