# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox on Linux, macOS, and Windows. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

[![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=for-the-badge&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)

## Features

- **Full WebHID polyfill**: implements `navigator.hid` API in Firefox
- **Three data planes**: WebSocket worker with MessageChannel for max performance, WebTransport over QUIC (worker or in-page), or Native Messaging for simplicity. Switchable per-site. Control ops (enumerate/open/close) are always NM.
- **Off-main-thread WS**: the data WS connection lives in a dedicated per-device Web Worker. Main thread has zero WS activity.
- **CSP-aware worker spawn**: data worker is spawned via the shadow-URL trick (`new Worker(location.href)` served by webRequest interception, MV3 default) or from a blob URL with CSP rewrite (MV2 default). Background pre-flights the page CSP and fails fast to NM when neither mode can work (e.g. MV3 header CSP).
- **MessageChannel direct delivery**: input reports flow directly from data worker to page via MessageChannel, bypassing the bridge entirely. One batched port message per frame, zero-copy, no Xray unwrap.
- **Zero-copy polyfill**: DataView created directly on transferred ArrayBuffer, no intermediate copy. Eliminates GCMajor during benchmarks.
- **Ack-wait sendReport**: `sendReport` resolves on daemon ack (WS or NM)
- **Rate-gated batching**: 0us added latency for sparse reports, <=25us coalescing for bursts, 8ms coalescing once polling exceeds ~12 reports/4ms (kills render-load report loss at 8kHz)
- **Cross-platform HID**: Linux (hidraw + udev), macOS (IOHIDManager), Windows (native HID API)
- **Daemon-as-NM-host**: daemon speaks NM protocol directly (skip forwarder + Unix socket)
- **Report descriptor parser**: daemon-side (hidreport crate), produces Chromium-shaped collections
- **Stable device IDs**: FNV-1a 32-bit hash of platform device path, survives reboots
- **Auto-reconnect with token refresh**: daemon restart, addon reload, WS disconnect all handled automatically. WS auth-failure close codes (4401/4402) trigger re-open instead of blind retry.
- **Hot-plug**: event-driven on all platforms
- **Security**: FIDO/U2F + mouse/keyboard blocklist, localhost-only WebSocket, per-device token authentication (SHA-256 hash subprotocol), group-based IPC socket permissions (SO_PEERCRED on Linux)
- **Per-device event routing**: daemon sends events only to the requested channel (NM or WS)
- **SettingsStore observer**: Proxy-based settings propagation: changes take effect immediately, no reload needed. Per-site overrides for every setting except `daemonAsNmHost`, including log level.
- **NM error propagation**: NM host writes `{"s":503,"E":"..."}` error frame to stdout on connect failure, addon logs the reason instead of silent paralysis
- **Packed TLV wire format**: hot-path NM messages (sendReport, sendFeatureReport, inputReport) use binary TLVs inside `{"d":"<b64>"}` with reqId inside the TLV: saves 7-14 bytes vs JSON fields
- **HTTP status codes**: responses use `s` field with HTTP semantics (200/201/204/4xx/5xx) instead of separate ok/err fields
- **Worker polyfill (opt-in)**: injects the full `navigator.hid` implementation into page-created Web Workers for spec-compliance coverage

## Install

For detailed installation instructions and platform-specific recommendations, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Addon Settings

### Global settings

Open `about:addons -> WebHID -> Options`:

- **Daemon as NM host**: daemon speaks NM directly (skip forwarder + Unix socket). Requires `webhid.daemon_nm_host` NM manifest (default OFF; default ON on Windows)
- **Data Plane**: WebSocket worker (default), WebTransport over QUIC, or Native Messaging. WS mode spawns a per-device worker with binary WS + MessageChannel direct-to-page input reports. WT runs in a worker too, or in-page on the main thread when Use Worker is off. NM mode routes all data through the NM host.
- **Use Worker**: WT only. Run the data plane in a dedicated worker (default) or in-page on the main thread. Hidden unless Data Plane is WebTransport.
- **Device Picker Mode**: modal (default), pageAction, or window. How the device chooser is presented.
- **Worker Spawn Mode**: shadow URL (default on MV3) or blob + CSP rewrite (default on MV2). How the data worker is created in the page context.
- **Worker Polyfill**: inject the full `navigator.hid` implementation into page-created Web Workers (default OFF)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)

### Per-site settings (override globals for the current site)

Click on the WebHID addon icon:

- **Data Plane**: WebSocket, WebTransport, or Native Messaging
- **Device Picker Mode**: modal, pageAction, or window
- **Worker Polyfill**: enable per-site
- **Worker Spawn Mode**: shadow URL or blob + CSP rewrite
- **Use Worker**: WT only; off runs WT in-page instead of in a worker
- **Log Level**: per-site verbosity override

`daemonAsNmHost` is the only global-only setting: it configures the
native-messaging host and cannot be overridden per site.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Spec Compliance](docs/SPECIFICATION.md): WebHID spec compliance report with item-level evidence
- [Data Path Analysis](docs/DATA_PATH.md): per-path copy/hop/latency breakdown, cost model, optimization inventory
- [Benchmark Report](docs/BENCHMARK.md): cold-start benchmark results (5 runs per mode), GCMajor analysis, cross-mode comparison
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging
- [Installation Guide](docs/INSTALLATION.md): platform-specific install instructions and recommended settings

## License

MIT
