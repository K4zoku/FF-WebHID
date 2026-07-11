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
- **Adaptive batching**: 0us added latency for sparse reports, <=100us coalescing for 8kHz bursts
- **Cross-platform HID**: Linux (hidraw + udev), macOS (IOHIDManager), Windows (native HID API)
- **Daemon-as-NM-host**: daemon speaks NM protocol directly (skip forwarder + Unix socket)
- **Report descriptor parser**: daemon-side (hidreport crate), produces Chromium-shaped collections
- **Stable device IDs**: FNV-1a 32-bit hash of platform device path, survives reboots
- **Auto-reconnect with token refresh**: daemon restart, addon reload, WS disconnect all handled automatically. WS auth-failure close codes (4401/4402) trigger handshake re-fetch instead of blind retry.
- **Hot-plug**: event-driven on all platforms
- **Security**: FIDO/U2F blocklist, localhost-only WebSocket, token authentication, control token for WS control plane, group-based IPC socket permissions
- **Per-device event routing**: daemon sends events only to the requested channel (NM or WS)
- **SettingsStore observer**: Proxy-based settings propagation: changes take effect immediately, no reload needed. Per-site overrides for all settings including log level.
- **NM error propagation**: NM host writes `{"s":503,"E":"..."}` error frame to stdout on connect failure, addon logs the reason instead of silent paralysis
- **Packed TLV wire format**: hot-path NM messages (sendReport, sendFeatureReport, inputReport) use binary TLVs inside `{"d":"<b64>"}` with reqId inside the TLV: saves 7-14 bytes vs JSON fields
- **HTTP status codes**: responses use `s` field with HTTP semantics (200/201/204/4xx/5xx) instead of separate ok/err fields

## Install

For detailed installation instructions and platform-specific recommendations, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Addon Settings

### Global settings

Open `about:addons -> WebHID -> Options`:
- **Daemon as NM host**: daemon speaks NM directly (skip forwarder + Unix socket). Requires `webhid.daemon_nm_host` NM manifest (default OFF)
- **Control Plane**: Native Messaging (default) or WebSocket. WS mode spawns a control worker that connects a control-only WS after NM handshake, routing enumerate/close via WS text frames
- **Data Plane**: WebSocket worker (default) or Native Messaging. WS mode spawns a per-device worker with binary WS + MessageChannel direct-to-page input reports. NM mode routes all data through the NM host.
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)

### Per-site settings (override globals for the current site)

Click on the WebHID addon icon:
- **Control Plane**: NM or WS
- **Data Plane**: WS or NM
- **Fire-and-forget sendReport**: resolve immediately
- **Log Level**: per-site verbosity override

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, control plane, security, reconnect
- [Data Path Analysis](docs/DATA_PATH.md): per-path copy/hop/latency breakdown, cost model, optimization inventory
- [Benchmark Report](docs/BENCHMARK.md): cold-start benchmark results (5 runs per mode), GCMajor analysis, cross-mode comparison
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging
- [Installation Guide](docs/INSTALLATION.md): platform-specific install instructions and recommended settings

## License

MIT
