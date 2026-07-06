# Architecture

## Overview

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

The project is split into a **Control Plane** for low-frequency management tasks and a **Data Plane** for high-frequency HID data.

## Components

| Component | What it does |
|---|---|
| `addon/webhid-polyfill.js` | Polyfills `navigator.hid` in every page (MAIN world); shows the device-picker modal; drains input reports from `SharedArrayBuffer` |
| `addon/webhid-bridge.js` | Content script (isolated world); handles device picker UI; forwards messages between page and background.js; spawns per-device Web Worker |
| `addon/background.js` | Background script; owns the native-messaging port; auto-reconnect on disconnect; injects COOP/COEP headers for SharedArrayBuffer |
| `addon/hid-worker.js` | Web Worker; maintains WebSocket connection to daemon; writes input reports into SAB ring buffer; sends output/feature reports via WS binary frames (fire-and-forget) |
| `addon/settings.html` | Settings page for toggling performance logging, fire-and-forget mode, and SAB data plane |
| `webhid-native-messaging` | Spawned by Firefox per-profile; translates between native-messaging protocol and daemon IPC; auto-reconnect to daemon on disconnect |
| `webhid-daemon` | Long-running system service; owns HID device handles via hidapi; provides WebSocket server for data plane; udev hot-plug monitor |
| `crates/webhid` | Shared Rust library: message types, protocol framing |

## Control plane (JSON)

Low-frequency operations: `enumerate`, `open`, `close`. Uses length-prefixed JSON over Unix socket (daemon ↔ NM host) and native messaging stdio (NM host ↔ Firefox).

## Data plane (binary WebSocket)

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

## Security

### COOP/COEP headers

The addon injects `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on all HTTP/HTTPS responses to enable `SharedArrayBuffer`. This may break pages with cross-origin resources lacking CORP headers. Can be disabled in settings (falls back to slower postMessage path).

### HID blocklist

FIDO/U2F security keys (YubiKey, Feitian, OnlyKey, Nitrokey, Google Titan, etc.) are blocked from WebHID access, matching Chromium's `hid_blocklist.cc`.

### WebSocket origin check

The daemon rejects WebSocket connections from non-localhost hosts.

### Token authentication

Each `open()` generates a 128-bit session token. The WebSocket connection must present this token as a query parameter during the HTTP upgrade. The daemon maps token → device_id.

## Device IDs

Device identifiers are stable, platform-independent hashes:
```
device_id = djb2_hash("vid:pid:serial:interface:usage_page:usage:raw_path")
```

Composite USB devices (multiple HID interfaces) are grouped by (vid, pid, serial) and the "primary" interface (vendor-defined usage_page ≥ 0xFF00, or first non-boot) is selected for enumeration. When serial is empty, devices are keyed by `device_id` to avoid merging distinct physical devices of the same model.

## Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry Unix socket connect (100ms → 2s, up to 30s)
- **background.js → NM host:** retry `connectNative` (1s → 10s)
- **Worker → daemon WS:** retry WebSocket (500ms → 5s)
- **Daemon:** detects NM host disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event

## Message flow example: `navigator.hid.getDevices()`

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
