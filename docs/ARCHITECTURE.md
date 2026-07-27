# Architecture

## Overview

```
 Web page (MAIN world)
   │  navigator.hid  (polyfilled by polyfill.js)
   │  sendReport / sendFeatureReport / receiveFeatureReport / input reports
   │  MessageChannel port (port1) for control; separate data MessageChannel per device
   ▼
 addon/bridge.js (content script, isolated world)
   │  ├── Control Plane: NM only (runtime.sendMessage → background → NM host → daemon)
   │  │     enumerate / open / close / handshake / getPolicy / requestDevice / forget
   │  ├── Data Plane: WS (data worker → binary WS → daemon → MessagePort direct to page)
   │  │                or NM (runtime.sendMessage → background → NM host → daemon)
   │  └── Handshake: NM (one-time, gets wsPort + wsNonce)
   │
   ├──► addon/worker.js (Web Worker, per-device data plane, spawned on open)
   │      │ binary WebSocket (127.0.0.1:<port>, authenticated via SHA-256(sessionToken+wsNonce) subprotocol)
   │      │ input reports forwarded via transferred MessagePort (direct worker → page, zero-copy)
   │      │ sendReport / sendFeatureReport / receiveFeatureReport sent as binary WS frames
   │      ▼
   │    webhid-daemon (Rust)
   │      │ hidapi → hidraw / IOHIDManager / Windows HID
   │      ▼
   │    HID device
   │
   ├──► addon/background.js (Extension background)
   │      │ nativeMessaging (stdio, JSON + base64, packed binary TLVs)
   │      │ worker bundle served via webRequest filterResponseData (shadow-URL redirect trick)
   │      │ worker-polyfill bundle prefixed into page-created worker scripts (opt-in)
   │      ▼
   │    webhid.forwarder_nm_host or webhid.daemon_nm_host (Rust)
   │      │ Unix socket / named pipe (forwarder mode), vectored I/O on all platforms
   │      ▼
   │    webhid-daemon (if forwarder mode)
   │
```

The project has a single switchable plane:

- **Data Plane** (`sendReport`, input reports, feature reports): WS binary via per-device data worker (default) or NM. Controlled by the `dataPlane` setting (`ws` or `nm`).

Control operations (`enumerate`, `open`, `close`, `handshake`) always go via NM.

## Components

| Component | What it does |
|---|---|
| `polyfill.js` | Polyfills `navigator.hid` in MAIN world; communicates with bridge via a MessageChannel port (port1); per-device data channel is a separate MessageChannel created on `open()` (port1 kept, port2 transferred to bridge then to worker); receives input reports via the data port (direct from worker, zero-copy); sendReport/sendFeatureReport resolve on ack from worker; zero-copy DataView on transferred ArrayBuffer for input reports |
| `bridge.js` | Content script (ISOLATED world); routes control/data actions; spawns per-device data worker via `new Worker(location.href)` (redirect-interception trick served by background.js webRequest filtering); relays data MessagePort page↔worker; sends NM handshake on init to get wsPort + wsNonce; `SettingsStore` observer for live settings propagation; tracks open devices via `openDevices` Set |
| `worker.js` | Web Worker (per-device, WS data plane); binary WS to daemon via `createWsTransport`; input reports forwarded via transferred MessagePort (direct to page, zero-copy, no Xray); sendReport/sendFeatureReport sent as binary WS frames, resolved on WS ack (`handleControlResponse`); receiveFeatureReport via WS; auto-reconnect with exponential backoff; detects WS auth-failure close code 4401/4402 and triggers token refresh via bridge |
| `worker-polyfill.js` | Not a worker. Stub WebHID API polyfill (HID, HIDDevice, HIDInputReportEvent, HIDConnectionEvent constructors) injected as a prefix into page-created Web Worker scripts by background.js webRequest filtering when `workerPolyfillEnabled` is true (global or per-site). All methods throw `NotSupportedError`. Exposes `navigator.hid` in worker scope. |
| `background.js` | Extension background; owns NM port; handles `handshake` (returns wsPort + wsNonce); tab-targeted event delivery; `daemonAsNmHost` via `SettingsStore` (Windows defaults to true); NM error frame logging; packed TLV encode/decode for sendReport/sendFeatureReport/inputReport; serves worker bundle via webRequest `filterResponseData` on shadow-URL; injects worker-polyfill bundle into page worker scripts |
| `picker.js` | `WebHidDevicePicker` class (ISOLATED world); closed-mode Shadow DOM (`attachShadow({mode:'closed'})`); three modes via `devicePickerMode` setting: `modal` (default, inline dialog), `pageAction` (url-bar popup), `window` (separate popup window) |
| `settings.html` / `popup.html` | Settings UI: data plane (WS/NM), log level (global + per-site), daemon-as-NM-host, device picker mode, worker polyfill toggle |
| `inject-main.js` | MV2-only MAIN-world injector. Fetches scripts via `runtime.sendMessage` `fetchResource`, injects as one `<script>`. Referenced only in `manifest.v2.json`. Not used in MV3 (content scripts use `"world": "MAIN"`). |
| `utils/base64.js` | Polyfills `Uint8Array.fromBase64` + `Uint8Array.prototype.toBase64` if absent. Used by background.js for NM packed TLV base64. |
| `utils/bootstrap.js` | Module registry: `globalThis.webhid` with `export(name, value)` / `import(name)` backed by a Map. Polyfills `globalThis` if absent. |
| `utils/websocket.js` | `createWsTransport` factory: WS connect/reconnect/backoff/auth-failure-handling. Reconnect 500ms→5s exponential backoff. Close codes 4401/4402 → `onAuthFailed` (halts reconnect). Subprotocol `webhid.<token>` where token is the SHA-256 auth hash. |
| `webhid.forwarder_nm_host` | Thin byte-pipe NM host (forwarder mode): stdin ↔ Unix socket/named pipe via vectored I/O (`write_vectored`) on all platforms |
| `webhid.daemon_nm_host` | Daemon-as-NM-host mode: daemon speaks NM directly on stdin/stdout (auto-detected via Firefox's 2 positional args) |
| `webhid-daemon` | Long-running service; hidapi device handles; WS server (data only, loopback-only); adaptive batching (25µs coalesce); Arc<[u8]> broadcast; per-device dataplane_mode; udev hot-plug; FIDO/U2F + mouse/keyboard/keypad blocklist |
| `crates/webhid` | Shared Rust library: message types (NmRequest, NmResponse, IpcRequest, IpcResponse), protocol framing, base64 serde, FNV-1a device ID hash. NM wire uses single-char field names + HTTP status codes; packed binary TLVs for hot-path messages. |

## Control plane (NM only)

All control operations use length-prefixed JSON over NM stdio (Firefox ↔ NM host) and Unix socket/named pipe (NM host ↔ daemon):

- `enumerate`, `open`, `close`, `handshake`, `setDataPlane`, `requestDevice` (picker), `forget`/`unpairDevice`, `getPolicy`, `getPairedDevices`/`pairDevice`
- `open()` returns sessionToken + wsPort (and the daemon's wsNonce is obtained via handshake)
- `handshake` returns wsPort + wsNonce (one-time, on bridge init)


## Data plane

### WS mode (default, worker + MessagePort)

High-frequency operations via binary WebSocket frames in a per-device Web Worker:

**sendReport (page → daemon):** polyfill posts to its data MessagePort (port1) with transfer; worker receives, builds a binary WS frame, sends it. Worker awaits WS ack (`handleControlResponse`), then posts `sendResult` back to the data port; polyfill resolves the Promise on receipt. Wire format:
```
[type:u8][reqId:u32 LE][reportId:u8][...payload]
```
Types: `0x01` sendReport, `0x02` sendFeatureReport, `0x03` receiveFeatureReport, `0x83` feature-report response. 6-byte header (no device ID; the WS connection is per-device).

**Input reports (daemon → page):** adaptive batching. Daemon flushes immediately for sparse reports (1 report = 0µs added latency), coalesces with 25µs window for bursts. Worker receives batch, parses into individual reports, forwards each via the transferred MessagePort (direct to page, zero-copy, no Xray unwrap). Wire format:
```
[len:u16 LE][reportId:u8][...payload][len:u16 LE][reportId:u8][...payload]...
```

**MessagePort direct delivery:** on `open()`, polyfill creates a `MessageChannel`, keeps port1 as `dataPort`, and transfers port2 to bridge via the control port. Bridge transfers port2 to the worker (`setPort` message). Worker sends input reports via `dataPort.postMessage(transfer)` which arrives directly at page's port1 `onmessage`. This bypasses the bridge entirely for input reports, eliminating Xray unwrap allocations and reducing context hops. If the port transfer fails, bridge falls back to forwarding via `onDataPortMessage` (NM path).

**Zero-copy polyfill:** Polyfill creates `DataView` directly on the transferred `ArrayBuffer`, with no intermediate `new Uint8Array` copy. This eliminates ~70% of per-event allocations and prevents GCMajor from triggering during benchmarks.

### NM mode (optional)

All data routes via NM: `sendReport` → bridge → background → NM host → daemon. NM wire is JSON + base64 (Firefox spec requires UTF-8 JSON, binary framing is not allowed). Hot-path messages use packed binary TLVs encoded as base64 inside a single JSON field `{"d":"<b64>"}` to minimize wire overhead.

**Packed TLV formats** (all multi-byte integers little-endian):

| msgType | Direction | Layout | Used for |
|---------|-----------|--------|----------|
| 0x01 | daemon → addon | `[0x01][devId u32]([reportId u8][payloadLen u16][payload])*` | input_report (multi-report batch) |
| 0x02 | addon → daemon | `[0x02][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendReport |
| 0x04 | addon → daemon | `[0x04][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendFeatureReport |

The NM sendReport/sendFeatureReport TLV includes a device ID (12-byte header) because the NM connection is shared across all devices, unlike the per-device WS connection. `receiveFeatureReport` uses JSON (not packed) with action code 5.

For packed messages, `reqId` lives inside the TLV (not the JSON `n` field), so the JSON wrapper is just `{"d":"<b64>"}` with no `a`/`n`/`i`/`r` fields. Non-packed messages (enumerate, open, close, receiveFeatureReport, setDataPlane, handshake) use JSON with numeric action codes (`"a":1..8`) and single-char field names.

**Responses** use HTTP status codes in the `s` field (200/201/204/4xx/5xx) instead of separate `ok`/`err` fields. Error responses contain only `{"n":N,"s":<code>}`: no error message string on the wire (the daemon logs it).

**bg→tab IPC:** background.js decodes the base64 TLV and sends the payload as a `Uint8Array` to the tab via `tabs.sendMessage` (structured clone, not zero-copy: `tabs.sendMessage` has no transfer list). Polyfill receives `Uint8Array` directly, no re-decode needed.

sendReport/sendFeatureReport via NM resolve on the NM ack. Input reports come via NM events → `tabs.sendMessage` → bridge → page (or directly via the data port if a worker is present).

## Daemon optimizations

| Optimization | Effect |
|---|---|
| `Arc<[u8]>` for broadcast data | Zero-clone broadcast (refcount bump, not memcpy) |
| `Arc::from(&frame[6..])` in WS binary handler | Zero-copy slice for spawn_blocking |
| Batch Vec stores `(u8, Arc<[u8]>)` | No per-report `full_report` alloc; reportId prepended in `create_batch_frame` |
| Adaptive flush (25µs coalescing) | 0 latency for sparse, ≤25µs for bursts |
| Per-device `dataplane_mode` | Events sent only to requested channel (NM or WS), no duplicate delivery |
| Thread-local `WRITE_BUF` / `READ_BUF` | Avoids per-call allocation in hot path |
| NM packed TLVs (0x01/0x02/0x04) | Hot-path messages use `{"d":"<b64>"}` wrapper, reqId inside TLV: saves 7-14 bytes vs JSON fields |
| NM bg→tab Uint8Array transfer | Background decodes base64 once, sends Uint8Array to tab (structured clone): saves 1 encode + 1 decode per input report |
| WS close code 4401/4402 | Auth-failure close codes let workers distinguish stale token from network error, trigger token refresh instead of blind retry |
| Abstract socket `@webhid` (Linux root) | No filesystem entry, no symlink attack surface |
| SO_PEERCRED + webhid group check | Verifies connecting process is in the `webhid` group (Linux, non-abstract sockets) |

## Security

### HID blocklist

Two independent mechanisms:

1. **Per-product blocklist** (`hid.rs` `BLOCKED_DEVICES`): FIDO/U2F security keys (YubiKey, Feitian, OnlyKey, Nitrokey, Google Titan, HID Global, U2F Zero, Mooltipass, VASCO, Keydo, Thetis, JaCarta, Happlink, Bluink) blocked by (vendorId, productId) tuple. Also blocks any device with `usage_page == 0xF1D0` (FIDO usage page). Matches Chromium's `hid_blocklist.cc`.

2. **Collection/report blocklist** (`blocklist.rs`): rule-based blocking by usage_page/usage and report-level rules. Blocks Generic Desktop Mouse (0x0001/0x0002), Keyboard (0x0001/0x0006), Keypad (0x0001/0x0007), System Control (0x0001/0x0080), Jabra (0x0b0e/0xff00, reportId 0x05, output), OnlyKey (0x1d50/0x60fc). Mouse/keyboard/keypad access is gated by the OS layer (udev on Linux, HID API on Windows, Input Monitoring/TCC on macOS), not by the daemon alone.

### WebSocket security

- Daemon binds WS server to `127.0.0.1` only; rejects non-localhost `Host`/`Origin` headers (403)
- Every WS connection is authenticated via a per-device auth hash: `SHA-256(sessionToken || wsNonce)` presented as WS subprotocol `webhid.<hash>`
- No separate control token; the daemon has no text-frame or control-connection path

### Token authentication

- **Device session token**: generated per `open()`, 128-bit hex. The bridge computes `SHA-256(sessionToken + wsNonce)` and the worker presents it as the WS subprotocol.
- **wsNonce**: generated once per daemon instance (128-bit hex), returned in the `handshake` NM response. Combined with the session token to produce the WS auth hash so the raw token never leaves the NM channel.

### IPC socket permissions (Linux)

- **Root daemon** (systemd system service): abstract socket `@webhid` (no filesystem entry). SO_PEERCRED is checked on every accepted Unix stream: the connecting process's GID must match the `webhid` group, with a fallback to `/proc/<pid>/status` supplementary groups. Users must be in the `webhid` group to connect via the thin forwarder:

```sh
sudo usermod -aG webhid $USER
# log out + log back in for group change to take effect
```

- **User daemon**: filesystem socket under `$XDG_RUNTIME_DIR/webhid/webhid.sock` or `/run/user/<uid>/webhid/webhid.sock` with mode `0o600`. No peer-cred check needed (abstract-socket-only check; user socket is protected by directory permissions).

Alternatively, users with direct hidraw access (via udev `uaccess` rule) can skip the forwarder entirely by enabling **Daemon as NM host** in addon settings: the daemon speaks NM directly on stdin/stdout, no socket needed.

## Device IDs

Stable, platform-independent hashes (FNV-1a 32-bit):
```
deviceId = fnv1a_32(path_bytes)
```

- **Linux**: the `path` is the resolved syspath (canonicalized `/sys/class/hidraw/<name>/device` parent directory), not the raw `/dev/hidrawN` path.
- **Windows**: device interface path. **macOS**: IOService path.

Same physical device in same USB port produces the same hash across reboots. Two devices with identical vid/pid/serial but different physical ports have different paths → different hashes.

The hash is sent as a JSON number in wire fields and as a 4-byte little-endian u32 in packed binary TLVs. On the JS side, the unsigned right shift `>>> 0` is mandatory when decoding to avoid signed int32 wraparound for hashes ≥ 0x80000000.

## Reconnect

All layers auto-reconnect with exponential backoff:
- **NM host → daemon:** retry socket connect (100ms → 2s cap, 5s total timeout). On timeout, writes `{"s":503,"E":"..."}` error frame to stdout before exiting so the addon logs the reason.
- **background.js → NM host:** retry `connectNative` (1s → 10s). On disconnect, resolves all pending with `{s:503}` and broadcasts `globalReset` to all tabs.
- **Data worker → daemon WS:** retry WebSocket (500ms → 5s). On auth-failure close code (4401 unknown token / 4402 bad token), halts auto-reconnect and asks bridge for a fresh token via `auth-failed` message; bridge re-opens the device and respawns the worker.
- **Daemon:** detects NM disconnect, closes devices; page receives `disconnect` event, re-opens on `connect` event.

## Settings

Settings are stored in `browser.storage.local`. Global defaults + the `SettingsStore` factory live in `js/utils/settings.js`. Per-site overrides are stored under the key `site:<origin>`.

| Setting | Values | Default | Description |
|---|---|---|---|
| `dataPlane` | `ws` / `nm` | `ws` | Data plane: WS worker (MessagePort direct to page) or NM via bridge |
| `daemonAsNmHost` | bool | `false` (`true` on Windows) | Use daemon-as-NM-host (skip forwarder + socket) |
| `logLevel` | 0 to 3 | `1` | 0=error, 1=warn, 2=info, 3=debug |
| `devicePickerMode` | `modal` / `pageAction` / `window` | `modal` | Device picker UI mode |
| `workerPolyfillEnabled` | bool | `false` | Inject WebHID polyfill into page-created Web Workers |

Each consumer (background, bridge, polyfill, worker) creates its own `SettingsStore` instance: a Proxy-backed observer that fires listeners only when a value actually changes. Reads are direct property access (`settings.dataPlane`); writes are either assignment (`settings.logLevel = 2`) or bulk (`settings.set({...})`). Subscriptions via `settings.on('key', cb)` or `settings.on(['k1','k2'], cb)`.

The bridge's `storage.onChanged` listener extracts `changes[k].newValue` from Firefox storage events and calls `settings.set(patch)`: the store handles the diffing internally. The daemon-as-NM-host setting defaults to `true` on Windows (auto-detected in `loadNmHostSetting`).

## Worker spawn (redirect-interception trick)

Firefox MV3 content scripts cannot spawn Web Workers from extension URLs in page context. The data worker is spawned via `new Worker(location.href)` (the page's own URL). Background.js `webRequest.onBeforeRequest` detects requests where `details.url === details.documentUrl` (the shadow-URL self-request) and serves the worker bundle (bootstrap + logger + settings + websocket + worker.js concatenated) via `filterResponseData`. `onHeadersReceived` rewrites the response `Content-Type` to `application/javascript` and strips CSP/length headers. This makes the page's self-request resolve to the worker script instead of re-fetching the page.

## Worker polyfill injection (opt-in)

When `workerPolyfillEnabled` is true (globally or per-site), background.js prefixes the worker-polyfill bundle (bootstrap + logger + worker-polyfill.js) into page-created worker scripts via `webRequest.filterResponseData`. The bundle is injected after any leading `"use strict"` directive so the polyfill's `globalThis.webhid` registry is available before the page's worker script runs. This exposes `navigator.hid` (stub, methods throw `NotSupportedError`) in worker scope for spec-compliance coverage.

## Message flow examples

### `navigator.hid.getDevices()`

```
page                  bridge.js         background.js     NM host      daemon
 │──port.postMessage(enumerate)►│            │              │           │
 │                              │──sendMessage►│              │           │
 │                              │              │──NM write────►│           │
 │                              │              │              │──socket──►│
 │                              │              │              │           │ hidapi
 │                              │              │              │◄──socket──│
 │                              │              │◄──NM read────│           │
 │                              │◄──sendResponse│              │           │
 │◄──port.postMessage(res)──────│              │              │           │
```

### `sendReport()` WS (ack-wait)

```
page                  bridge.js         worker.js          daemon
 │──dataPort.postMsg(send)──►│            │                   │
 │  (pending in dataPending) │──postMsg──►│                   │
 │                           │  (transfer) │──ws.send(binary)►│
 │                           │             │                  │ hidraw write
 │                           │             │◄──ws ack──────────│
 │                           │◄──sendResult─│                   │
 │◄──dataPort.onmessage(res)─│            │                   │
 │  (Promise resolves)       │             │                   │
```

### Input report via MessagePort (WS data plane)

```
daemon                worker.js              page (port1)
 │──WS binary batch────►│                     │
 │                       │ parse batch         │
 │                       │──port.postMessage──►│ (zero-copy transfer, no Xray)
 │                       │  (per report)       │ DataView on transferred ArrayBuffer
 │                       │                     │ HIDInputReportEvent dispatched
```

### `sendReport()` NM (ack-wait)

```
page                  bridge.js         background.js     NM host      daemon
 │──port.postMessage────►│                │                │           │
 │  (pending in polyfill) │──sendMessage──►│                │           │
 │                        │                │──NM write─────►│           │
 │                        │                │                │──socket──►│
 │                        │                │                │           │ hidraw write
 │                        │                │                │◄──socket──│
 │                        │                │◄──NM read──────│           │
 │                        │◄──sendResponse─│                │           │
 │◄──port.postMessage(res)│                │                │           │
```
