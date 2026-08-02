# Architecture

## Overview

```mermaid
graph TB
    subgraph "Firefox tab"
        Page["Web page (MAIN world)<br/>content/main/index.js<br/>navigator.hid"]
        Bridge["content/isolated/bridge.js<br/>(content script, isolated world)"]
        Worker["content/isolated/worker/index.js<br/>(Web Worker, per-device)"]
    end

    subgraph "Firefox background"
        BG["background/index.js<br/>(extension background)"]
    end

    subgraph "OS processes"
        NM["NM host<br/>(forwarder or daemon-as-NM-host)"]
        Daemon["webhid-daemon (Rust)"]
        HID["HID device<br/>(hidraw / IOHIDManager / HidD_*)"]
    end

    Page -- "control: MessageChannel port" --> Bridge
    Page -- "data: MessageChannel port (transferred)" --> Worker
    Bridge -- "runtime.sendMessage" --> BG
    BG -- "nativeMessaging (stdio)" --> NM
    NM -- "Unix socket / named pipe" --> Daemon
    Worker -- "binary WebSocket / WebTransport (loopback)" --> Daemon
    Daemon -- "hidapi" --> HID

    linkStyle 0 stroke:#4a90d9
    linkStyle 1 stroke:#d94a4a
    linkStyle 5 stroke:#d94a4a
```

The project has a single switchable plane:

- **Data Plane** (`sendReport`, input reports, feature reports): WS binary via per-device data worker (default), WT over QUIC (same worker architecture, self-signed cert pinned via `serverCertificateHashes`), or NM. Controlled by the `dataPlane` setting (`ws`, `wt`, or `nm`).

Control operations (`enumerate`, `open`, `close`, `handshake`, `getPolicy`, `requestDevice`, `forget`) always go via NM.

## Components

| Component                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|                                    | `content/main/index.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Polyfills `navigator.hid` in MAIN world; guards on `isSecureContext`; communicates with bridge via a MessageChannel port (port1) using a per-frame `frameNonce` for request origin tracking; per-device data channel is a separate MessageChannel created on `open()` (port1 kept, port2 transferred to bridge then to worker); receives input reports via the data port (direct from worker, zero-copy); sendReport/sendFeatureReport resolve on ack from worker; zero-copy DataView on transferred ArrayBuffer for input reports; `requestDevice` checks `navigator.userActivation.isActive` unless called from devtools console (`isCalledFromConsole`); wraps `navigator.permissions.query` for `hid` descriptor via `getPolicy`. Also runs inside page-created workers when `workerPolyfillEnabled` (see Worker polyfill injection below): in worker context it exposes the same constructors + `navigator.hid` on `self`, `requestDevice` throws `NotSupportedError`, `getDevices()` resolves with an empty list via the relayed bridge port (patched `Worker` constructor, see below) |
| `content/isolated/bridge.js`       | Content script (ISOLATED world); routes control/data actions; spawns per-device data worker in `shadow`, `blob`, or `nm` mode; caches `wtPort`/`wtCertHash` from the handshake; picks `createWsTransport` vs `createWtTransport` via the `dataPlane` setting (`ws`/`wt`) (see Worker spawn below); relays data MessagePort page↔worker; sends NM handshake on init to get wsPort + wsNonce; computes WS auth hash via `crypto.subtle.digest("SHA-256", token + wsNonce)`; in-memory `allowedDeviceIds` Set (synced via `getAllowedDevices` message + `allowedDevicesChanged` broadcast); `dataPort` auth check is sync (`Set.has`) not async; `SettingsStore` observer for live settings propagation; tracks open devices via `openDevices` Set; per-port origin tracking via `portOrigin` map (populated from browser-verified `MessageEvent.origin`); `getPolicy` checks iframe `allow="hid"` attribute for cross-origin frames; `globalReset` handler clears state on NM disconnect |
| `content/isolated/worker/index.js` | Web Worker (per-device, WS or WT data plane); binary frames to daemon via `createWsTransport` (WS) or `createWtTransport` (WT, persistent QUIC stream); input reports forwarded via transferred MessagePort (direct to page, zero-copy, no Xray); sendReport/sendFeatureReport sent as binary WS frames, resolved on WS ack (`handleControlResponse`); receiveFeatureReport via WS; auto-reconnect with exponential backoff; detects WS auth-failure close code 4401/4402 and triggers token refresh via bridge                                                                                                                                                                                                                                                                                                                                                                                                |
|                                    | `worker-polyfill.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Removed. The worker polyfill is now `content/main/index.js` itself (dual-context): when `workerPolyfillEnabled` is true (global or per-site), background serves the same polyfill bundle into page-created Web Worker scripts (see Worker polyfill injection below), where it exposes HID, HIDDevice, HIDInputReportEvent, HIDConnectionEvent + `navigator.hid` on the worker scope. `requestDevice` throws `NotSupportedError`; `getDevices()` resolves with an empty list via the bridge port relayed into the worker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `background/index.js`              | Extension background entry; owns NM port; handles `handshake` (returns wsPort + wsNonce); tab-targeted event delivery; `daemonAsNmHost` via `SettingsStore` (Windows defaults to true); packed TLV encode/decode for sendReport/sendFeatureReport/inputReport; serves worker bundle via webRequest `filterResponseData` on shadow-URL; injects worker-polyfill bundle into page worker scripts; `getPolicy` resolves Permissions-Policy (`hid` directive) from response headers + cross-origin iframe `allow` attr; broadcasts `globalReset` to all tabs on NM disconnect; `ensureStorageSchemaVersion()` runs before any settings read; pair/unpair/revoke use IndexedDB + broadcast `allowedDevicesChanged`; `decodeDeviceCollections` decodes TLV base64 at cache time                                                                   |
| `background/state.js`              | Shared mutable state: `deviceCache`, `deviceTabMap`, `permissionsPolicy`, `allowedCrossOrigin`, `pendingPicker`, `workerPolyfillSites`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `background/storage.js`            | IndexedDB `webhid-store`: `deviceInfo` store (keyPath: `deviceId`) + `origins` store (compound key `[origin, deviceId]`); `getAllowedDevices`/`addAllowedDevice`/`removeAllowedDevice` use per-record atomic ops (no read-modify-write)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `background/nm.js`                 | `NativeMessaging` singleton: connect/reconnect/sendRequest/sendPacked; packed TLV event decode; `onPackedData`/`onControlEvent` handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `background/bundle.js`             | `ensureWorkerBundle` + `ensureWorkerPolyfillBundle`: fetch + concatenate JS files into a single string for StreamFilter injection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `background/packed.js`             | NM constants (ACT, EVT, PKG) + `buildPackedSend` binary TLV builder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `background/state_ops.js`          | Tab tracking: `registerDeviceTab`/`unregisterDeviceTab`/`isTabAuthorizedForDevice`/`purgeTab`; `broadcastGlobalReset`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `content/isolated/picker/index.js` | `WebHidDevicePicker` class (ISOLATED world); closed-mode Shadow DOM (`attachShadow({mode:'closed'})`); three modes via `devicePickerMode` setting: `modal` (default, inline dialog), `pageAction` (url-bar popup), `window` (separate popup window)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                                    | `internal/pages/settings/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Settings UI (colocated HTML+CSS+JS): data plane (WS/NM), worker spawn mode (shadow/blob), log level, daemon-as-NM-host, device picker mode, worker polyfill toggle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `internal/pages/popup/`            | Popup UI (colocated HTML+CSS+JS): per-site device list + settings overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `content/isolated/inject.js`       | MV2-only MAIN-world injector. Fetches scripts via `runtime.sendMessage` `fetchResource`, injects as one `<script>`. Referenced only in `manifest.v2.json`. Not used in MV3 (content scripts use `"world": "MAIN"`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `utils/base64.js`                  | Polyfills `Uint8Array.fromBase64` + `Uint8Array.prototype.toBase64` if absent. Used by background for NM packed TLV base64.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `utils/bootstrap.js`               | Module registry: `globalThis.webhid` with `export(name, value)` / `import(name)` backed by a Map. Polyfills `globalThis` if absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `utils/websocket.js`               | `createWsTransport` factory: WS connect/reconnect/backoff/auth-failure-handling. Reconnect 500ms→5s exponential backoff. Close codes 4401/4402 → `onAuthFailed` (halts reconnect). Subprotocol `webhid.<hash>` where hash is `SHA-256(sessionToken + wsNonce)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `utils/webtransport.js`           | `createWtTransport` factory: WT connect over `serverCertificateHashes`-pinned QUIC; one persistent bidirectional stream, every frame length-prefixed, one `onBinary` per frame; auth-failure detection via ready rejection or early close; no auto-reconnect (v1) |
| `utils/descriptor-tlv.js`          | `decodeCollectionsTlv(base64)`: decodes TLV binary + base64 wire format for `DeviceInfo.collections` into JS `HIDCollectionInfo[]` objects. Called once at cache time in background.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `utils/i18n.js`                    | `t(key, subs)` wrapper around `browser.i18n.getMessage` + `localizeHTML(root)` for `data-i18n` attribute scanning. Works on document + shadow DOM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `webhid.forwarder_nm_host`         | Thin byte-pipe NM host (forwarder mode): stdin ↔ Unix socket/named pipe via vectored I/O (`write_vectored`) on all platforms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `webhid.daemon_nm_host`            | Daemon-as-NM-host mode: daemon speaks NM directly on stdin/stdout (auto-detected via Firefox's 2 positional args)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `webhid-daemon`                    | Long-running service; hidapi device handles; WS server (data only, loopback-only, port 0 by default); adaptive batching (25µs coalesce); Arc<[u8]> broadcast; per-session `dataplane_modes` (HashMap<session_token, mode>); `has_nm_session` check for NM event forwarding; udev hot-plug; FIDO/U2F per-product blocklist (`hid.rs`) + collection/report-level blocklist (`blocklist.rs`: mouse/keyboard/keypad/System Control/Jabra/OnlyKey); report-level blocking via `is_report_blocked` on send/feature paths; abstract socket `@webhid` (Linux root); SO_PEERCRED + webhid group check; seccomp BPF + prctl hardening (Linux, release-only); constant-time WS auth hash comparison via `subtle::ConstantTimeEq`                                                                                                                       |
| `crates/webhid`                    | Shared Rust library: message types (NmRequest, NmResponse, IpcRequest, IpcResponse), protocol framing, base64 serde, FNV-1a device ID hash, `collections_tlv` module (TLV binary + base64 serde for `DeviceInfo.collections`). NM wire uses single-char field names + HTTP status codes; packed binary TLVs for hot-path messages + collections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

| msgType | Direction      | Layout                                                               | Used for                          |
| ------- | -------------- | -------------------------------------------------------------------- | --------------------------------- |
| 0x01    | daemon → addon | `[0x01][devId u32]([reportId u8][payloadLen u16][payload])*`         | input_report (multi-report batch) |
| 0x02    | addon → daemon | `[0x02][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendReport                        |
| 0x04    | addon → daemon | `[0x04][reqId u32][devId u32][reportId u8][payloadLen u16][payload]` | sendFeatureReport                 |

The NM sendReport/sendFeatureReport TLV includes a device ID (12-byte header) because the NM connection is shared across all devices, unlike the per-device WS connection. `receiveFeatureReport` uses JSON (not packed) with action code 5.

For packed messages, `reqId` lives inside the TLV (not the JSON `n` field), so the JSON wrapper is just `{"d":"<b64>"}` with no `a`/`n`/`i`/`r` fields. Non-packed messages (enumerate, open, close, receiveFeatureReport, setDataPlane, handshake) use JSON with numeric action codes (`"a":1..8`) and single-char field names.

**Responses** use HTTP status codes in the `s` field (200/201/204/4xx/5xx) instead of separate `ok`/`err` fields. Error responses contain only `{"n":N,"s":<code>}`: no error message string on the wire (the daemon logs it).

**bg→tab IPC:** background.js decodes the base64 TLV and sends the payload as a `Uint8Array` to the tab via `tabs.sendMessage` (structured clone, not zero-copy: `tabs.sendMessage` has no transfer list). Polyfill receives `Uint8Array` directly, no re-decode needed.

sendReport/sendFeatureReport via NM resolve on the NM ack. Input reports come via NM events → `tabs.sendMessage` → bridge → page (or directly via the data port if a worker is present).

## Daemon optimizations

| Optimization                                  | Effect                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Arc<[u8]>` for broadcast data                | Zero-clone broadcast (refcount bump, not memcpy)                                                                                                        |
| `Arc::from(&frame[6..])` in WS binary handler | Zero-copy slice for spawn_blocking                                                                                                                      |
| Batch Vec stores `(u8, Arc<[u8]>)`            | No per-report `full_report` alloc; reportId prepended in `create_batch_frame`                                                                           |
| Adaptive flush (25µs coalescing)              | 0 latency for sparse, ≤25µs for bursts                                                                                                                  |
| Per-session `dataplane_modes`                 | Events sent only to sessions with matching mode; `has_nm_session` checks if any session on a device is in NM mode before forwarding InputReports via NM |
| Thread-local `WRITE_BUF` / `READ_BUF`         | Avoids per-call allocation in hot path                                                                                                                  |
| NM packed TLVs (0x01/0x02/0x04)               | Hot-path messages use `{"d":"<b64>"}` wrapper, reqId inside TLV: saves 7-14 bytes vs JSON fields                                                        |
| NM bg→tab Uint8Array transfer                 | Background decodes base64 once, sends Uint8Array to tab (structured clone): saves 1 encode + 1 decode per input report                                  |
| WS close code 4401/4402                       | Auth-failure close codes let workers distinguish stale token from network error, trigger token refresh instead of blind retry                           |
| Abstract socket `@webhid` (Linux root)        | No filesystem entry, no symlink attack surface                                                                                                          |
| SO_PEERCRED + webhid group check              | Verifies connecting process is in the `webhid` group (Linux, non-abstract sockets)                                                                      |

## Security

### HID blocklist

Two independent mechanisms:

1. **Per-product blocklist** (`hid.rs` `BLOCKED_DEVICES`): FIDO/U2F security keys (YubiKey, Feitian, OnlyKey, Nitrokey, Google Titan, HID Global, U2F Zero, Mooltipass, VASCO, Keydo, Thetis, JaCarta, Happlink, Bluink) blocked by (vendorId, productId) tuple. Also blocks any device with `usage_page == 0xF1D0` (FIDO usage page). Matches Chromium's `hid_blocklist.cc`.

2. **Collection/report blocklist** (`blocklist.rs`): rule-based blocking by usage_page/usage and report-level rules. Blocks Generic Desktop Mouse (0x0001/0x0002), Keyboard (0x0001/0x0006), Keypad (0x0001/0x0007), System Control (0x0001/0x0080), Jabra (0x0b0e/0xff00, reportId 0x05, output), OnlyKey (0x1d50/0x60fc). Mouse/keyboard/keypad access is gated by the OS layer (udev on Linux, HID API on Windows, Input Monitoring/TCC on macOS), not by the daemon alone.

### WebSocket security

- Daemon binds WS server to `127.0.0.1` only; rejects non-localhost `Host`/`Origin` headers (403)
- Every WS connection is authenticated via a per-device auth hash: `SHA-256(sessionToken || wsNonce)` presented as WS subprotocol `webhid.<hash>`
- No separate control token; the daemon has no text-frame or control-connection path

### WebTransport data plane

- WT server binds `127.0.0.1:0` at daemon startup (like the WS server); the certificate is a self-signed ECDSA P-256 cert with SAN `127.0.0.1` and a validity of at most 14 days, generated once at boot (or on renewal). The bridge pins it via `serverCertificateHashes` (SHA-256 of the DER), which is why the handshake returns `wt_port` (`W`) + `wt_cert_hash` (`H`) alongside the WS info.
- Auth reuses the WS scheme: the same `SHA-256(sessionToken || wsNonce)` hash is placed in the WT URL path (`https://127.0.0.1:<port>/<hash>`), and the daemon resolves it against the same `ws_auth_hashes` map (WebTransport has no subprotocol).
- One persistent bidirectional stream per session: every frame (batch flush or control response) is written with an explicit `[len_u32 LE]` prefix so message boundaries are unambiguous on the continuous stream (the batch format itself is not self-delimiting: a report id of 0 is legal). The JS transport buffers and reassembles, delivering one `onBinary` per frame; the same framing carries page-to-daemon messages on the other half of the stream. Benchmark results are in docs/BENCHMARK.md.
- Renewal (only reachable when a daemon runs past 14 days): on `handshake`, `ensure_current` checks the current generation's expiry; expired certs trigger a new generation on a new UDP port with a fresh cert. The old generation keeps serving existing connections (drain) and rejects new ones (`404`), then releases its port once active sessions reach zero. Pages holding a stale port fall back to NM via the bridge's ready-timeout path.
- The daemon-side mode guard (`has_nm_session` / `MODE_WT`) prevents NM double-delivery while a WT session is active, mirroring the WS mode lifecycle.
- CPU cost on loopback is higher than WS/NM (TLS/QUIC encryption); this is the cost being measured in the benchmark, not a gain (see AGENTS.md).

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

Settings are stored in `browser.storage.local` with per-key format: global settings use key `settings :: <name>`, site overrides use `settings :: <origin> :: <name>` (separator `" :: "` with spaces to avoid collision with IPv6 origin literals). The `SettingsStore` factory + key helpers (`globalSettingKey`, `siteSettingKey`, `parseSettingsKey`, `loadGlobalSettings`, `loadSiteSettings`, `saveGlobalSetting`, `saveSiteSetting`) live in `js/utils/settings.js`. A schema version key `meta :: storage :: version` prevents re-migration.

Device info cache and origin device allowlists are stored in IndexedDB (`webhid-store`), not `storage.local`. Object stores: `deviceInfo` (keyPath: `deviceId`) and `origins` (compound key `[origin, deviceId]`). Content scripts maintain an in-memory `allowedDeviceIds` Set synced via `getAllowedDevices` message + `allowedDevicesChanged` broadcast from background.

| Setting                 | Values                            | Default                       | Description                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlane`             | `ws` / `wt` / `nm`               | `ws`                          | Data plane: WS worker, WT worker (QUIC, pinned self-signed cert), or NM via bridge                                                                                                                                                                                        |
| `workerSpawnMode`       | `shadow` / `blob`                 | `shadow` (MV3) / `blob` (MV2) | Data worker spawn strategy (see Worker spawn below). `shadow` = `new Worker(location.href)` served by webRequest interception; `blob` = blob URL from the worker bundle, requires page CSP rewrite. Falls back to the other mode, then to NM, based on CSP pre-flight. |
| `daemonAsNmHost`        | bool                              | `false` (`true` on Windows)   | Use daemon-as-NM-host (skip forwarder + socket)                                                                                                                                                                                                                        |
| `logLevel`              | 0 to 3                            | `1`                           | 0=error, 1=warn, 2=info, 3=debug                                                                                                                                                                                                                                       |
| `devicePickerMode`      | `modal` / `pageAction` / `window` | `modal`                       | Device picker UI mode                                                                                                                                                                                                                                                  |
| `workerPolyfillEnabled` | bool                              | `false`                       | Inject WebHID polyfill into page-created Web Workers                                                                                                                                                                                                                   |

Each consumer (background, bridge, polyfill, worker) creates its own `SettingsStore` instance: a Proxy-backed observer that fires listeners only when a value actually changes. Reads are direct property access (`settings.dataPlane`); writes are either assignment (`settings.logLevel = 2`) or bulk (`settings.set({...})`). Subscriptions via `settings.on('key', cb)` or `settings.on(['k1','k2'], cb)`.

The bridge's `storage.onChanged` listener extracts `changes[k].newValue` from Firefox storage events and calls `settings.set(patch)`: the store handles the diffing internally. The daemon-as-NM-host setting defaults to `true` on Windows (auto-detected in `loadNmHostSetting`).

`daemonAsNmHost` is the only global-only setting: `loadSiteSettings` (and the `SITE_SETTING_NAMES` list it iterates) excludes it, so a site override can never shadow the global NM-host choice. Every other setting (`dataPlane`, `workerSpawnMode`, `logLevel`, `devicePickerMode`, `workerPolyfillEnabled`) is per-site overridable from the popup. Changes propagate live through the `storage.onChanged` → `settings.set` path: the bridge re-routes open devices when `dataPlane` changes, resets the spawn-mode cache when `workerSpawnMode` changes, re-levels its logger when `logLevel` changes, and `devicePickerMode` is re-read at the next `requestDevice()` call. `workerPolyfillEnabled` is the exception: it applies at worker-creation time, so per-site toggles need a page reload (the background refreshes `workerPolyfillSites` immediately).

## Worker spawn (shadow URL / blob / NM)

Firefox MV3 content scripts cannot spawn Web Workers from extension URLs in page context, and pages may have CSPs that block worker sources. The data worker is spawned in page context using one of two modes, chosen per site by the `workerSpawnMode` setting (shadow is the MV3 default, blob the MV2 default):

- **Shadow URL** (default on MV3): `new Worker(location.href)`. Background's `webRequest.onBeforeRequest` detects the synthetic self-request (`details.url === details.documentUrl` modulo fragment) and serves the worker bundle (bootstrap + logger + settings + websocket + worker) via `filterResponseData`; `onHeadersReceived` rewrites the `Content-Type` to `application/javascript` and strips CSP/length headers. Touches nothing about the page except one synthetic request. Fails if the server rejects that request or under `require-trusted-types-for 'script'` with a restrictive allow-list.
- **Blob + CSP rewrite** (default on MV2): the bridge fetches the worker bundle (`getWorkerBundle`), creates `URL.createObjectURL(new Blob([text]))`, and spawns from the blob URL through a `trustedTypes` policy (`webhid-worker`). Background rewrites `<meta http-equiv="content-security-policy">` and (MV2 only) header CSP to add `blob:` to `worker-src` and `ws://127.0.0.1:*` to `connect-src`, plus the `trusted-types` allow-list entry when `require-trusted-types-for` is active.

**CSP pre-flight**: background parses the page's header + meta CSP at navigation time (`parseCspForWorkerSpawn`) and stores the verdict in `storage.session` under `csp:<tabId>:<frameId>` (`workerSrc`, `connectSrc`, `shadowBlocked`, `needsBlobFallback`, `headerShadowBlocked`, ...). The bridge queries it via the `getCspInfo` message and picks the mode:

1. setting says `blob` → blob
2. shadow blocked but blob viable → blob (`needsBlobFallback`)
3. MV3 + header CSP blocks shadow and blob rewrite is impossible (MV3 is strengthen-only, header CSP cannot be relaxed) → **NM** (`workerSpawnMode` effectively `nm`; the worker is never spawned and the data plane uses NM)
4. otherwise → shadow

If the shadow spawn itself throws at runtime (e.g. the server rejected the self-request), the bridge retries once with blob, then falls back to NM.

## Worker polyfill injection (opt-in)

When `workerPolyfillEnabled` is true (globally or per-site), background.js prefixes the worker-polyfill bundle (bootstrap + logger + http + settings + device + content/main/index.js) into page-created worker scripts via `webRequest.filterResponseData`. The bundle is injected after any leading `"use strict"` directive so the polyfill's `globalThis.webhid` registry is available before the page's worker script runs.

Inside the worker, `content/main/index.js` detects the worker context (`isWorker`) and exposes `HID`, `HIDDevice`, `HIDInputReportEvent`, `HIDConnectionEvent` on `self` plus `navigator.hid` on the worker navigator. `requestDevice()` throws `NotSupportedError` (spec: `[Exposed=Window]` only), `new HID()`/`new HIDDevice()` throw `TypeError` (illegal constructor). `getDevices()` resolves with an empty list: the polyfill patches the page's `Worker` constructor to relay a bridge MessagePort into each worker it spawns, so the worker's requests reach the background (and return no paired devices for a worker origin).

This gives spec-compliance coverage of the worker exposure surface (constructors exist, SameObject holds, requestDevice correctly refuses) without a functional worker data plane.

## Message flow examples

### `navigator.hid.getDevices()`

```mermaid
sequenceDiagram
    participant P as page
    participant B as bridge.js
    participant G as background.js
    participant N as NM host
    participant D as daemon

    P->>B: port.postMessage(enumerate)
    B->>G: runtime.sendMessage
    G->>N: NM write
    N->>D: socket
    D->>D: hidapi enumerate
    D-->>N: socket response
    N-->>G: NM read
    G-->>B: sendResponse
    B-->>P: port.postMessage(res)
```

### `sendReport()` WS (ack-wait)

```mermaid
sequenceDiagram
    participant P as page
    participant B as bridge.js
    participant W as worker.js
    participant D as daemon

    P->>P: dataPending.set(reqId, promise)
    P->>B: dataPort.postMessage(send, [buffer])
    B->>W: postMessage (transfer)
    W->>D: ws.send(binary frame)
    D->>D: hidraw write
    D-->>W: ws ack
    W-->>B: sendResult
    B-->>P: dataPort.onmessage(res)
    P->>P: Promise resolves
```

### Input report via MessagePort (WS data plane)

```mermaid
sequenceDiagram
    participant D as daemon
    participant W as worker.js
    participant P as page (port1)

    D->>W: WS binary batch
    W->>W: parse batch into reports
    W->>P: port.postMessage(inputReport, [buffer])
    Note over W,P: zero-copy transfer, no Xray unwrap
    P->>P: DataView on transferred ArrayBuffer
    P->>P: dispatch HIDInputReportEvent
```

### `sendReport()` NM (ack-wait)

```mermaid
sequenceDiagram
    participant P as page
    participant B as bridge.js
    participant G as background.js
    participant N as NM host
    participant D as daemon

    P->>P: pending in polyfill
    P->>B: port.postMessage
    B->>G: runtime.sendMessage
    G->>N: NM write (packed TLV)
    N->>D: socket
    D->>D: hidraw write
    D-->>N: socket response
    N-->>G: NM read
    G-->>B: sendResponse
    B-->>P: port.postMessage(res)
```

### `open()` (NM control + WS data plane setup)

```mermaid
sequenceDiagram
    participant P as page
    participant B as bridge.js
    participant G as background.js
    participant N as NM host
    participant D as daemon
    participant W as worker.js

    P->>B: port.postMessage(open)
    B->>G: runtime.sendMessage
    G->>N: NM write
    N->>D: socket
    D->>D: hidapi open + reader thread
    D-->>N: socket response (sessionToken + wsPort)
    N-->>G: NM read
    G-->>B: sendResponse
    B->>B: computeWsAuthHash(SHA-256(token + wsNonce))
    B->>W: spawn worker (shadow URL or blob mode)
    P->>B: dataPort transfer (MessageChannel port2)
    B->>W: setPort (transfer port to worker)
    W->>D: WS connect (subprotocol: webhid.<hash>)
    D-->>W: WS open
    B-->>P: port.postMessage(res)
    Note over P,W: data port now direct W→P for input reports
```

### `requestDevice()` (picker UI + pairing)

```mermaid
sequenceDiagram
    participant P as page
    participant B as bridge.js
    participant Picker as picker.js
    participant G as background.js
    participant N as NM host
    participant D as daemon

    P->>B: port.postMessage(requestDevice)
    B->>Picker: devicePicker.show(filters)
    Picker->>G: runtime.sendMessage(enumerate)
    G->>N: NM write
    N->>D: socket
    D-->>N: device list
    N-->>G: NM read
    G-->>Picker: sendResponse(devices)
    Picker->>Picker: applyFilters + render list
    Note over Picker: user selects device, clicks Connect
    Picker-->>B: webhid-device-selected event
    B-->>P: port.postMessage(res, devices)
    P->>B: pairDevice (async)
    B->>G: runtime.sendMessage(pairDevice)
    G->>G: storage.local.set(origin → deviceId)
```

### `handshake()` (NM, one-time on bridge init)

```mermaid
sequenceDiagram
    participant B as bridge.js
    participant G as background.js
    participant N as NM host
    participant D as daemon

    B->>G: runtime.sendMessage(handshake)
    G->>N: NM write
    N->>D: socket
    D->>D: generate wsNonce (once per instance)
    D-->>N: socket response (wsPort + wsNonce)
    N-->>G: NM read
    G-->>B: sendResponse
    B->>B: store wsPort + wsNonce for WS auth hash derivation
```

### NM disconnect → global reset

```mermaid
sequenceDiagram
    participant G as background.js
    participant B as bridge.js
    participant P as page

    G->>G: NM port disconnect detected
    G->>G: resolve all pending with {s:503}
    G->>B: broadcast globalReset (tabs.sendMessage)
    B->>B: clear openDevices + sessionTokens
    B->>B: despawn all data workers
    B-->>P: event: disconnect (per device)
    P->>P: dispatch HIDConnectionEvent("disconnect")
```
