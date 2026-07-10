# Architecture

## Overview

```
 Web page (MAIN world)
   │  navigator.hid  (polyfilled by polyfill.js)
   │  sendReport / sendFeatureReport / receiveFeatureReport / input reports
   ▼
 addon/bridge.js (content script, isolated world)
   │  ├── Control Plane: NM (runtime.sendMessage → background → NM host → daemon)
   │  │                   or WS (control worker → text frames → daemon WS control connection)
   │  ├── Data Plane: WS (data worker → binary WS → daemon → MessageChannel direct to page)
   │  │                or NM (runtime.sendMessage → background → NM host → daemon)
   │  └── Handshake: NM (one-time, gets controlToken + wsPort)
   │
   ├──► addon/control.js (Web Worker, control plane, early spawn)
   │      │ WebSocket text frames (JSON, 127.0.0.1:<port>)
   │      │ enumerate / close commands
   │      ▼
   │    webhid-daemon (Rust)
   │      │ hidapi → hidraw / IOHIDManager / Windows HID
   │      ▼
   │    HID device
   │
   ├──► addon/worker.js (Web Worker, per-device data plane, spawned on open)
   │      │ binary WebSocket (127.0.0.1:<port>)
   │      │ input reports via MessageChannel (direct worker → page, zero-copy)
   │      │ sendReport via worker.postMessage from bridge
   │      ▼
   │    webhid-daemon (Rust)
   │      │ hidapi → hidraw / IOHIDManager / Windows HID
   │      ▼
   │    HID device
   │
   ├──► addon/background.js (Extension background)
   │      │ nativeMessaging (stdio, JSON + base64)
   │      ▼
   │    webhid.forwarder_nm_host or webhid.daemon_nm_host (Rust)
   │      │ Unix socket / named pipe (forwarder mode)
   │      ▼
   │    webhid-daemon (if forwarder mode)
   │
   └──► (control worker also connects to daemon via WS text frames)
          ▼
        webhid-daemon (Rust)
```

The project has two independently switchable planes:

- **Control Plane** (`enumerate`, `open`, `close`): NM (default) or WS text frames via control worker
- **Data Plane** (`sendReport`, input reports, feature reports): WS binary via data worker (default) or NM

## Components

| Component | What it does |
|---|---|
| `polyfill.js` | Polyfills `navigator.hid` in MAIN world; sends data via `window.postMessage` to bridge; receives input reports via MessageChannel (direct from worker) or bridge forwarding; early fire-and-forget resolves after `window.postMessage` (<0.1ms) |
| `bridge.js` | Content script; routes control/data actions; spawns per-device data worker (WS mode); spawns control worker (control=WS); sends NM handshake on init to get controlToken + wsPort; tracks open devices via `_openDevices` Set; effective-settings-aware storage change handler |
| `worker.js` | Web Worker (per-device, WS data plane); binary WS to daemon; input reports forwarded via MessageChannel (direct to page, zero-copy, no Xray); fire-and-forget `sendReport`; auto-reconnect with exponential backoff |
| `control.js` | Web Worker (early spawn, control plane); WS text frames to daemon; enumerate/close commands; auto-reconnect with exponential backoff; communicates with bridge via MessageChannel port |
| `background.js` | Extension background; owns NM port; handles `handshake` (returns controlToken + wsPort); tab-targeted event delivery; daemonAsNmHost switching |
| `settings.html` / `popup.html` | Settings UI: control plane (NM/WS), data plane (WS/NM), fire-and-forget, log level, perf timing, daemon-as-NM-host |
| `webhid.forwarder_nm_host` | Thin byte-pipe NM host (forwarder mode): stdin ↔ Unix socket/named pipe |
| `webhid.daemon_nm_host` | Daemon-as-NM-host mode: daemon speaks NM directly on stdin/stdout (auto-detected via Firefox's 2 positional args) |
| `webhid-daemon` | Long-running service; hidapi device handles; WS server (data + control); adaptive batching; Arc<[u8]> broadcast; per-device dataplane mode; udev hot-plug |
| `crates/webhid` | Shared Rust library: message types (NmRequest, NmResponse, IpcRequest, IpcResponse), protocol framing, base64 serde. All JSON field names use camelCase. |

## Control plane

### NM mode (default)

Low-frequency operations: `enumerate`, `open`, `close`, `handshake`. Uses length-prefixed JSON over NM stdio (Firefox ↔ NM host) and Unix socket/named pipe (NM host ↔ daemon).

- `open()` always goes via NM (needs sessionToken + wsPort from daemon response)
- `handshake` returns controlToken + wsPort (one-time, on bridge init)

### WS mode (optional)

After NM handshake, bridge spawns a control worker that connects a control-only WS (authenticated via controlToken). `enumerate` and `close` route via WS text frames (JSON) through the control worker:

```
Bridge → control worker (MessageChannel) → WS text: {"id":1,"action":"enumerate"}
Daemon → WS text: {"id":1,"success":true,"devices":[...]} → control worker → bridge (MessageChannel)
```

Control-only WS connections are accepted by the daemon when the token matches `controlToken` (separate from per-device session tokens). Binary frames are rejected on control connections.

## Data plane

### WS mode (default, worker + MessageChannel)

High-frequency operations via binary WebSocket frames in a per-device Web Worker:

**sendReport (page → daemon):** early fire-and-forget. Polyfill resolves Promise immediately after `window.postMessage` to bridge (<0.1ms). Bridge forwards to worker (transfer), worker sends binary WS frame. Wire format:
```
[type:u8][reqId:u32 LE][reportId:u8][...payload]
```

**Input reports (daemon → page):** adaptive batching. Daemon flushes immediately for sparse reports (1 report = 0μs added latency), coalesces with 100μs window for bursts. Worker receives batch, parses into individual reports, forwards each via MessageChannel (direct to page, zero-copy, no Xray unwrap). Wire format:
```
[len:u16 LE][reportId:u8][...payload][len:u16 LE][reportId:u8][...payload]...
```

**MessageChannel direct delivery:** When a data worker connects, bridge creates a MessageChannel and transfers port1 to worker, port2 to page. Worker sends input reports via `port1.postMessage(transfer)` which arrives directly at page's `port2.onmessage`. This bypasses the bridge entirely, eliminating Xray unwrap allocations and reducing context hops from 2 to 1. If MessagePort transfer fails, worker falls back to `self.postMessage(transfer)` and bridge re-forwards.

**Zero-copy polyfill:** Polyfill creates `DataView` directly on the transferred `ArrayBuffer`, with no intermediate `new Uint8Array` copy. This eliminates ~70% of per-event allocations and prevents GCMajor from triggering during benchmarks.

### NM mode (optional)

All data routes via NM: `sendReport` → bridge → background → NM host → daemon (JSON + base64). Early fire-and-forget resolves after `window.postMessage` (<0.1ms). Input reports come via NM events → `tabs.sendMessage` → bridge → page.

## Daemon optimizations

| Optimization | Effect |
|---|---|
| `Arc<[u8]>` for broadcast data | Zero-clone broadcast (refcount bump, not memcpy) |
| `Arc::from(&frame[6..])` in WS binary handler | Zero-copy slice for spawn_blocking |
| Batch Vec stores `(u8, Arc<[u8]>)` | No per-report `full_report` alloc; reportId prepended in `create_batch_frame` |
| Adaptive flush (100μs coalescing) | 0 latency for sparse, ≤100μs for bursts |
| Per-device `dataplane_mode` | Events sent only to requested channel (NM or WS), no duplicate delivery |
| Thread-local `WRITE_BUF` / `READ_BUF` | Avoids per-call allocation in hot path |
| Control token (global, not per-device) | Control WS connects without device open |

## Security

### HID blocklist

FIDO/U2F security keys (YubiKey, Feitian, OnlyKey, Nitrokey, Google Titan, etc.) are blocked from WebHID access, matching Chromium's `hid_blocklist.cc`.

### WebSocket security

- Daemon rejects WS connections from non-localhost hosts
- Device WS: authenticated via per-device session token (128-bit, presented as WS subprotocol `webhid.<token>`)
- Control WS: authenticated via global control token (separate from device tokens)

### Token authentication

- **Device session token**: generated per `open()`, 128-bit hex. WS data connection must present it as subprotocol.
- **Control token**: generated on first `handshake` request, 128-bit hex. WS control connection must present it as subprotocol. Allows enumerate/close without device open.

## Device IDs

Stable, platform-independent hashes:
```
deviceId = djb2_hash("vid:pid:serial:interface:usagePage:usage:rawPath")
```

Composite USB devices grouped by (vid, pid, serial); primary interface selected (vendor usagePage ≥ 0xFF00, or first non-boot).

## Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry socket connect (100ms → 2s, up to 30s)
- **background.js → NM host:** retry `connectNative` (1s → 10s)
- **Data worker → daemon WS:** retry WebSocket (500ms → 5s)
- **Control worker → daemon WS:** retry WebSocket (500ms → 5s)
- **Daemon:** detects NM disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event

## Settings

Settings are stored in `browser.storage.local`. Global defaults are in `settings-defaults.js`. Per-site overrides are stored under the key `site:<origin>`.

The bridge's `storage.onChanged` listener computes effective settings (global merged with site override) before and after each change, and only acts when the effective value actually changes. This prevents unnecessary worker respawns when a global setting change does not affect the current site's effective value.

## Message flow examples

### `navigator.hid.getDevices()` Control=NM

```
page                  bridge.js         background.js     NM host      daemon
 │──postMessage(enumerate)►│                │                │           │
 │                         │──sendMessage──►│                │           │
 │                         │                │──NM write─────►│           │
 │                         │                │                │──socket──►│
 │                         │                │                │           │ hidapi
 │                         │                │                │◄──socket──│
 │                         │                │◄──NM read──────│           │
 │                         │◄──sendResponse─│                │           │
 │◄──postMessage(res)──────│                │                │           │
```

### `navigator.hid.getDevices()` Control=WS

```
page                  bridge.js         control.js          daemon
 │──postMessage(enumerate)►│                │                  │
 │                         │──port.postMsg─►│                  │
 │                         │  (command)     │──WS text: {"action":"enumerate"}──►│
 │                         │                │                  │ hidapi
 │                         │                │◄───WS text: {"devices":[...]}──────│
 │                         │◄──port.postMsg─│                  │
 │                         │  (response)    │                  │
 │◄──postMessage(res)──────│                │                  │
```

### `sendReport()` WS fire-and-forget

```
page                  bridge.js         worker.js          daemon
 │──postMessage(faf)─────►│                │                  │
 │  (resolve <0.1ms)      │──postMessage──►│                  │
 │                        │  (transfer)    │──ws.send(binary)►│
 │                        │                │                  │ hidraw write
```

### Input report via MessageChannel (WS data plane)

```
daemon                worker.js              page (port2)
 │──WS binary batch────►│                     │
 │                       │ parse batch         │
 │                       │──port.postMessage──►│ (zero-copy transfer, no Xray)
 │                       │  (per report)       │ DataView on transferred ArrayBuffer
 │                       │                     │ HIDInputReportEvent dispatched
```

### `sendReport()` NM fire-and-forget

```
page                  bridge.js         background.js     NM host      daemon
 │──postMessage(faf)─────►│                │                │           │
 │  (resolve <0.1ms)      │──sendMessage──►│                │           │
 │                        │                │──NM write─────►│           │
 │                        │                │                │──socket──►│
 │                        │                │                │           │ hidraw write
```
