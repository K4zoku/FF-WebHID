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
| `bridge.js` | Content script; routes control/data actions; spawns per-device data worker (WS mode); spawns control worker (control=WS); sends NM handshake on init to get controlToken + wsPort; tracks open devices via `_openDevices` Set; `SettingsStore` observer for live settings propagation |
| `worker.js` | Web Worker (per-device, WS data plane); binary WS to daemon; input reports forwarded via MessageChannel (direct to page, zero-copy, no Xray); fire-and-forget `sendReport`; auto-reconnect with exponential backoff; detects WS auth-failure close code 4401 and triggers token refresh via bridge |
| `control.js` | Web Worker (early spawn, control plane); WS text frames to daemon; enumerate/close commands; auto-reconnect with exponential backoff; communicates with bridge via MessageChannel port; same 4401 auth-failure handling as data worker |
| `background.js` | Extension background; owns NM port; handles `handshake` (returns controlToken + wsPort); tab-targeted event delivery; daemonAsNmHost via `SettingsStore`; NM error frame logging; packed TLV encode/decode for sendReport/sendFeatureReport/inputReport |
| `settings.html` / `popup.html` | Settings UI: control plane (NM/WS), data plane (WS/NM), fire-and-forget, log level (global + per-site), daemon-as-NM-host |
| `webhid.forwarder_nm_host` | Thin byte-pipe NM host (forwarder mode): stdin ↔ Unix socket/named pipe |
| `webhid.daemon_nm_host` | Daemon-as-NM-host mode: daemon speaks NM directly on stdin/stdout (auto-detected via Firefox's 2 positional args) |
| `webhid-daemon` | Long-running service; hidapi device handles; WS server (data + control); adaptive batching; Arc<[u8]> broadcast; per-device dataplane mode; udev hot-plug |
| `crates/webhid` | Shared Rust library: message types (NmRequest, NmResponse, IpcRequest, IpcResponse), protocol framing, base64 serde, FNV-1a device ID hash. NM wire uses single-char field names + HTTP status codes; packed binary TLVs for hot-path messages. |

## Control plane

### NM mode (default)

Low-frequency operations: `enumerate`, `open`, `close`, `handshake`. Uses length-prefixed JSON over NM stdio (Firefox ↔ NM host) and Unix socket/named pipe (NM host ↔ daemon).

- `open()` always goes via NM (needs sessionToken + wsPort from daemon response)
- `handshake` returns controlToken + wsPort (one-time, on bridge init)

### WS mode (optional)

After NM handshake, bridge spawns a control worker that connects a control-only WS (authenticated via controlToken). `enumerate` and `close` route via WS text frames (JSON) through the control worker:

```
Bridge -> control worker (MessageChannel) -> WS text: {"n":1,"action":"enumerate"}
Daemon -> WS text: {"n":1,"s":200,"D":[...]} -> control worker -> bridge (MessageChannel)
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

All data routes via NM: `sendReport` → bridge → background → NM host → daemon. NM wire is JSON + base64 (Firefox spec requires UTF-8 JSON, binary framing is not allowed). Hot-path messages use packed binary TLVs encoded as base64 inside a single JSON field `{"d":"<b64>"}` to minimize wire overhead.

**Packed TLV formats** (all multi-byte integers little-endian):

| msgType | Direction | Layout | Used for |
|---------|-----------|--------|----------|
| 0x01 | daemon → addon | `[0x01][devId u32]([reportId u8][payloadLen u16][payload])*` | input_report (multi-report batch) |
| 0x02 | addon → daemon | `[0x02][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendReport |
| 0x04 | addon → daemon | `[0x04][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendFeatureReport |

For packed messages, `reqId` lives inside the TLV (not the JSON `n` field), so the JSON wrapper is just `{"d":"<b64>"}` with no `a`/`n`/`i`/`r` fields. Non-packed messages (enumerate, open, close, receiveFeatureReport, setDataPlane, handshake) use JSON with numeric action codes (`"a":1..8`) and single-char field names.

**Responses** use HTTP status codes in the `s` field (200/201/204/4xx/5xx) instead of separate `ok`/`err` fields. Error responses contain only `{"n":N,"s":<code>}`: no error message string on the wire (the daemon logs it).

**bg→tab IPC:** background.js decodes the base64 TLV and sends the payload as a `Uint8Array` to the tab via `tabs.sendMessage` (structured clone, not zero-copy: `tabs.sendMessage` has no transfer list). Polyfill receives `Uint8Array` directly, no re-decode needed.

Early fire-and-forget resolves after `window.postMessage` (<0.1ms). Input reports come via NM events → `tabs.sendMessage` → bridge → page.

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
| NM packed TLVs (0x01/0x02/0x04) | Hot-path messages use `{"d":"<b64>"}` wrapper, reqId inside TLV: saves 7-14 bytes vs JSON fields |
| NM bg→tab Uint8Array transfer | Background decodes base64 once, sends Uint8Array to tab (structured clone): saves 1 encode + 1 decode per input report |
| WS close code 4401/4402 | Auth-failure close codes let workers distinguish stale token from network error, trigger token refresh instead of blind retry |

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

### IPC socket permissions (Linux)

When the daemon runs as root (systemd system service), the Unix socket is created at `/run/webhid/webhid.sock` with mode `0o660` (group `webhid`, set by systemd's `Group=webhid`). For user-service mode, the socket under `/run/user/<uid>/webhid/` uses mode `0o600`. Users must be in the `webhid` group to connect via the thin forwarder (`webhid.forwarder_nm_host`) when using root daemon:

```sh
sudo usermod -aG webhid $USER
# log out + log back in for group change to take effect
```

Alternatively, users with direct hidraw access (via udev `uaccess` rule) can skip the forwarder entirely by enabling **Daemon as NM host** in addon settings: the daemon speaks NM directly on stdin/stdout, no socket needed.

SO_PEERCRED is not checked because it would be redundant: group membership already enforces that only authorized users can connect. Adding a UID check on top would not increase security, only complexity.

## Device IDs

Stable, platform-independent hashes (FNV-1a 32-bit):
```
deviceId = fnv1a_32(raw_path_bytes)
```

`raw_path` is the platform-specific device path (Linux: `/dev/hidraw0`, Windows: device interface path, macOS: IOService path). Same physical device in same USB port produces the same hash across reboots. Two devices with identical vid/pid/serial but different physical ports have different paths → different hashes.

The hash is sent as a JSON number in wire fields (`i`, `n`-less packed TLVs) and as a 4-byte little-endian u32 in packed binary TLVs. On the JS side, the unsigned right shift `>>> 0` is mandatory when decoding to avoid signed int32 wraparound for hashes ≥ 0x80000000.

## Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry socket connect (100ms → 2s, up to 5s). On timeout, writes `{"s":503,"E":"..."}` error frame to stdout before exiting so the addon logs the reason.
- **background.js → NM host:** retry `connectNative` (1s → 10s)
- **Data worker → daemon WS:** retry WebSocket (500ms → 5s). On auth-failure close code (4401 unknown token / 4402 bad token), halts auto-reconnect and asks bridge for a fresh token via `auth-failed` message.
- **Control worker → daemon WS:** retry WebSocket (500ms → 5s). Same auth-failure handling as data worker.
- **Daemon:** detects NM disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event

## Settings

Settings are stored in `browser.storage.local`. Global defaults + the `SettingsStore` factory live in `js/utils/settings.js`. Per-site overrides are stored under the key `site:<origin>`.

Each consumer (background, bridge, polyfill, worker, control) creates its own `SettingsStore` instance: a Proxy-backed observer that fires listeners only when a value actually changes. Reads are direct property access (`settings.dataPlane`); writes are either assignment (`settings.fireAndForget = false`) or bulk (`settings.set({...})`). Subscriptions via `settings.on('key', cb)` or `settings.on(['k1','k2'], cb)`.

The bridge's `storage.onChanged` listener extracts `changes[k].newValue` from Firefox storage events and calls `settings.set(patch)`: the store handles the diff internally. This replaced an earlier `get()`-based before/after diff that broke when the change was already committed to storage before the listener ran (making before === after for all keys).

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
