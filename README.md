# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox on Linux, macOS, and Windows. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

[![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=for-the-badge&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)

## Features

- **Full WebHID polyfill**: implements `navigator.hid` API in Firefox
- **Dual data plane**: WebSocket (worker + SAB) for max performance, or Native Messaging for simplicity -- switchable per-site
- **Dual control plane**: NM (default) or WS text frames (after NM handshake) -- switchable independently from data plane
- **Early fire-and-forget**: `sendReport` resolves in <0.1ms (both WS and NM modes), no ack wait
- **Adaptive batching**: 0μs added latency for sparse reports, ≤100μs coalescing for 8kHz bursts
- **Cross-platform HID**: Linux (hidraw + udev), macOS (IOHIDManager), Windows (native HID API)
- **Daemon-as-NM-host**: daemon speaks NM protocol directly (skip forwarder + Unix socket)
- **Report descriptor parser**: daemon-side (hidreport crate), produces Chromium-shaped collections
- **Stable device IDs**: platform-independent hash, survives reboots
- **Auto-reconnect**: daemon restart, addon reload, WS disconnect, all handled automatically
- **Hot-plug**: event-driven on all platforms
- **Security**: FIDO/U2F blocklist, localhost-only WebSocket, token authentication, control token for WS control plane
- **Per-device event routing**: daemon sends events only to the requested channel (NM or WS)

## Install

For detailed installation instructions and platform-specific recommendations, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Addon Settings

### Global settings

Open `about:addons → WebHID → Options`:
- **Daemon as NM host**: daemon speaks NM directly (skip forwarder + Unix socket). Requires `webhid.daemon_nm_host` NM manifest (default OFF)
- **Control Plane**: Native Messaging (default) or WebSocket. WS mode connects a control-only WS after NM handshake, routing enumerate/close via WS text frames
- **Data Plane**: WebSocket (worker + SAB, default) or Native Messaging. WS mode spawns a worker per device with binary WS + SharedArrayBuffer. NM mode routes all data through the NM host
- **SharedArrayBuffer**: zero-copy input reports via SAB ring buffer (default ON; visible when Data Plane = WS)
- **SAB Buffer Capacity**: ring-buffer slots (2048–32768, default 8192)
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)
- **Performance timing**: timing messages in console

### Per-site settings (override globals for the current site)

Click on the WebHID addon icon:
- **Control Plane**: NM or WS
- **Data Plane**: WS or NM
- **SAB Data Plane**: toggle SAB (visible when Data Plane = WS)
- **SAB Buffer Capacity**: ring-buffer slots
- **Fire-and-forget sendReport**: resolve immediately

## Documentation

- [Data Path Analysis](docs/DATA_PATH.md): per-path copy/hop/latency breakdown, cost model, optimization inventory
- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging

## License

MIT
