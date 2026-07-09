# Architecture

## Overview

```
 Web page (MAIN world)
   │  navigator.hid  (polyfilled by polyfill.js)
   │  sendReport / sendFeatureReport / receiveFeatureReport / input reports
   ▼
 addon/bridge.js (content script, isolated world)
   │  ├── Control Plane: NM (runtime.sendMessage → background → NM host → daemon)
   │  │                   or WS (text frames → daemon WS control connection)
   │  ├── Data Plane: WS (worker → binary WS → daemon)
   │  │                or NM (runtime.sendMessage → background → NM host → daemon)
   │  └── Handshake: NM (one-time, gets control_token + ws_port)
   │
   ├──► addon/worker.js (Web Worker, WS data plane only)
   │      │ binary WebSocket (127.0.0.1:<port>)
   │      │ SharedArrayBuffer ring buffer + Atomics.waitAsync
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
   └──► WebSocket control connection (text frames, JSON)
          ▼
        webhid-daemon (Rust)
```

The project has two independently switchable planes:

- **Control Plane** (`enumerate`, `open`, `close`): NM (default) or WS text frames
- **Data Plane** (`sendReport`, input reports, feature reports): WS binary + SAB (default) or NM

## Components

| Component | What it does |
|---|---|
| `polyfill.js` | Polyfills `navigator.hid` in MAIN world; sends data via `window.postMessage` to bridge; drains SAB input reports via `Atomics.waitAsync`; early fire-and-forget resolves after `window.postMessage` (<0.1ms) |
| `bridge.js` | Content script; routes control/data actions; spawns per-device worker (WS mode); maintains WS control connection (control=WS); sends NM handshake on init to get control_token + ws_port; tracks open devices via `_openDevices` Set |
| `worker.js` | Web Worker (WS data plane only); binary WS to daemon; SAB ring buffer for input reports; fire-and-forget `sendReport` |
| `background.js` | Extension background; owns NM port; handles `handshake` (returns control_token + ws_port); tab-targeted event delivery; COOP/COEP header injection |
| `settings.html` / `popup.html` | Settings UI: control plane (NM/WS), data plane (WS/NM), SAB toggle, SAB capacity, fire-and-forget, log level, perf timing |
| `webhid.forwarder_nm_host` | Thin byte-pipe NM host (forwarder mode): stdin ↔ Unix socket/named pipe |
| `webhid.daemon_nm_host` | Daemon-as-NM-host mode: daemon speaks NM directly on stdin/stdout (auto-detected via Firefox's 2 positional args) |
| `webhid-daemon` | Long-running service; hidapi device handles; WS server (data + control); adaptive batching; Arc<[u8]> broadcast; per-device dataplane mode; udev hot-plug |
| `crates/webhid` | Shared Rust library: message types (NmRequest, NmResponse, IpcRequest, IpcResponse), protocol framing, base64 serde |

## Control plane

### NM mode (default)

Low-frequency operations: `enumerate`, `open`, `close`, `handshake`. Uses length-prefixed JSON over NM stdio (Firefox ↔ NM host) and Unix socket/named pipe (NM host ↔ daemon).

- `open()` always goes via NM (needs session_token + ws_port from daemon response)
- `handshake` returns control_token + ws_port (one-time, on bridge init)

### WS mode (optional)

After NM handshake, bridge connects a control-only WS (authenticated via control_token). `enumerate` and `close` route via WS text frames (JSON):

```
Bridge → WS text: {"id":1,"action":"enumerate"}
Daemon → WS text: {"id":1,"success":true,"devices":[...]}
```

Control-only WS connections are accepted by the daemon when the token matches `control_token` (separate from per-device session tokens). Binary frames are rejected on control connections.

## Data plane

### WS mode (default, worker + SAB)

High-frequency operations via binary WebSocket frames:

**sendReport (page → daemon):** early fire-and-forget. Polyfill resolves Promise immediately after `window.postMessage` to bridge (<0.1ms). Bridge forwards to worker (transfer), worker sends binary WS frame. Wire format:
```
[type:u8][req_id:u32 LE][report_id:u8][...payload]
```

**Input reports (daemon → page):** adaptive batching. Daemon flushes immediately for sparse reports (1 report = 0μs added latency), coalesces with 100μs window for bursts. Wire format:
```
[len:u16 LE][report_id:u8][...payload][len:u16 LE][report_id:u8][...payload]...
```

**SAB ring buffer:** each slot is `[len:u16 LE][report_id:u8][...payload]`. Worker writes, page drains via `Atomics.waitAsync`. Zero-copy W→P signal via `Atomics.notify`.

**postMessage fallback:** if SAB unavailable (COOP/COEP blocked), worker sends input reports via `postMessage` with ArrayBuffer transfer (zero-copy W→B→P).

### NM mode (optional)

All data routes via NM: `sendReport` → bridge → background → NM host → daemon (JSON + base64). Early fire-and-forget resolves after `window.postMessage` (<0.1ms). Input reports come via NM events → `tabs.sendMessage` → bridge → page.

## Daemon optimizations

| Optimization | Effect |
|---|---|
| `Arc<[u8]>` for broadcast data | Zero-clone broadcast (refcount bump, not memcpy) |
| `Arc::from(&frame[6..])` in WS binary handler | Zero-copy slice for spawn_blocking |
| Batch Vec stores `(u8, Arc<[u8]>)` | No per-report `full_report` alloc; report_id prepended in `create_batch_frame` |
| Adaptive flush (100μs coalescing) | 0 latency for sparse, ≤100μs for bursts |
| Per-device `dataplane_mode` | Events sent only to requested channel (NM or WS), no duplicate delivery |
| Thread-local `WRITE_BUF` / `READ_BUF` | Avoids per-call allocation in hot path |
| Control token (global, not per-device) | Control WS connects without device open |

## Security

### COOP/COEP headers

The addon injects `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on main-frame responses to enable `SharedArrayBuffer`. Can be disabled per-site (falls back to postMessage with ArrayBuffer transfer).

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
device_id = djb2_hash("vid:pid:serial:interface:usage_page:usage:raw_path")
```

Composite USB devices grouped by (vid, pid, serial); primary interface selected (vendor usage_page ≥ 0xFF00, or first non-boot).

## Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry socket connect (100ms → 2s, up to 30s)
- **background.js → NM host:** retry `connectNative` (1s → 10s)
- **Worker → daemon WS:** retry WebSocket (500ms → 5s)
- **Bridge → control WS:** reconnect on close (control token reused)
- **Daemon:** detects NM disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event

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
page                  bridge.js                              daemon
 │──postMessage(enumerate)►│                                    │
 │                         │──WS text: {"action":"enumerate"}──►│
 │                         │                                    │ hidapi
 │                         │◄───WS text: {"devices":[...]}──────│
 │◄──postMessage(res)──────│                                    │
```

### `sendReport()` WS fire-and-forget

```
page                  bridge.js         worker.js          daemon
 │──postMessage(faf)─────►│                │                  │
 │  (resolve <0.1ms)      │──postMessage──►│                  │
 │                        │  (transfer)    │──ws.send(binary)►│
 │                        │                │                  │ hidraw write
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
