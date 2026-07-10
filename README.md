# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox on Linux, macOS, and Windows. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

[![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=for-the-badge&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)

## Features

- **Full WebHID polyfill**: implements `navigator.hid` API in Firefox
- **Dual data plane**: WebSocket worker with MessageChannel for max performance, or Native Messaging for simplicity. Switchable per-site.
- **Dual control plane**: NM (default) or WS text frames via control worker (after NM handshake). Switchable independently from data plane.
- **Off-main-thread WS**: both control and data WS connections live in dedicated Web Workers. Main thread has zero WS activity.
- **MessageChannel direct delivery**: input reports flow directly from data worker to page via MessageChannel, bypassing the bridge entirely. Zero-copy, no Xray unwrap.
- **Zero-copy polyfill**: DataView created directly on transferred ArrayBuffer, no intermediate copy. Eliminates GCMajor during benchmarks.
- **Early fire-and-forget**: `sendReport` resolves in <0.1ms (both WS and NM modes), no ack wait
- **Adaptive batching**: 0μs added latency for sparse reports, ≤100μs coalescing for 8kHz bursts
- **Cross-platform HID**: Linux (hidraw + udev), macOS (IOHIDManager), Windows (native HID API)
- **Daemon-as-NM-host**: daemon speaks NM protocol directly (skip forwarder + Unix socket)
- **Report descriptor parser**: daemon-side (hidreport crate), produces Chromium-shaped collections
- **Stable device IDs**: platform-independent hash, survives reboots
- **Auto-reconnect**: daemon restart, addon reload, WS disconnect, all handled automatically with exponential backoff
- **Hot-plug**: event-driven on all platforms
- **Security**: FIDO/U2F blocklist, localhost-only WebSocket, token authentication, control token for WS control plane
- **Per-device event routing**: daemon sends events only to the requested channel (NM or WS)
- **Effective-settings-aware**: global setting changes only trigger worker respawn when the effective value for the current site actually changes

## Install

For detailed installation instructions and platform-specific recommendations, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Addon Settings

### Global settings

Open `about:addons → WebHID → Options`:
- **Daemon as NM host**: daemon speaks NM directly (skip forwarder + Unix socket). Requires `webhid.daemon_nm_host` NM manifest (default OFF)
- **Control Plane**: Native Messaging (default) or WebSocket. WS mode spawns a control worker that connects a control-only WS after NM handshake, routing enumerate/close via WS text frames
- **Data Plane**: WebSocket worker (default) or Native Messaging. WS mode spawns a per-device worker with binary WS + MessageChannel direct-to-page input reports. NM mode routes all data through the NM host.
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)
- **Performance timing**: timing messages in console

### Per-site settings (override globals for the current site)

Click on the WebHID addon icon:
- **Control Plane**: NM or WS
- **Data Plane**: WS or NM
- **Fire-and-forget sendReport**: resolve immediately

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, control plane, security, reconnect
- [Data Path Analysis](docs/DATA_PATH.md): per-path copy/hop/latency breakdown, cost model, optimization inventory
- [Benchmark Report](docs/BENCHMARK.md): cold-start benchmark results (5 runs per mode), GCMajor analysis, cross-mode comparison
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging
- [Installation Guide](docs/INSTALLATION.md): platform-specific install instructions and recommended settings

## License

MIT
