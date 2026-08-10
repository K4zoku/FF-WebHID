# Data Path Analysis

## 1. Execution Contexts

| #   | Context           | Process                         | Realm            | Files                                             |
| --- | ----------------- | ------------------------------- | ---------------- | ------------------------------------------------- |
| P   | Page MAIN world   | Firefox content (tab)           | Isolated (page)  | `content/main/index.js`                           |
| B   | Content script    | Firefox content (tab)           | Isolated (addon) | `content/isolated/bridge.js`                      |
| W   | Web Worker (data) | Firefox content (worker thread) | Worker           | `content/isolated/worker/index.js`                |
| G   | Background script | Firefox background              | Extension        | `background/index.js`                             |
| N   | NM host process   | OS process                      | --               | `webhid.forwarder_nm_host` or daemon NM-host mode |
| D   | Daemon process    | OS process                      | --               | `webhid-daemon`                                   |

Control ops (enumerate/open/close/handshake) are NM-only, handled by bridge→background→NM host→daemon.

---

## 2. Cost Model

| Operation                                       | Copy cost                                        | Hop cost                               | Est. latency |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------ |
| `postMessage` same-process (P↔B, B↔W)           | 1 structured clone (~5 to 15 µs for typed array) | 1 realm switch                         | 5 to 15 µs   |
| `postMessage` with transfer list                | 0 (buffer ownership moved)                       | 1 realm switch                         | 3 to 8 µs    |
| MessageChannel `port.postMessage` with transfer | 0 (buffer ownership moved)                       | 1 realm switch (direct W→P, no bridge) | 3 to 8 µs    |
| `runtime.sendMessage` (B↔G)                     | 1 clone + IPC marshal                            | 1 process boundary                     | 50 to 200 µs |
| `connectNative.postMessage` (G→N)               | 1 JSON serialize + pipe write                    | 1 process spawn/pipe                   | 30 to 100 µs |
| Unix socket write+read (N↔D, loopback)          | 2 kernel copies                                  | 1 process boundary                     | 5 to 15 µs   |
| WebSocket send+recv (W↔D, TCP loopback)         | 1 WS encode + 2 kernel copies                    | 1 process boundary                     | 10 to 30 µs  |
| `JSON.stringify`/`parse` (small obj)            | 1 alloc                                          | --                                     | 1 to 5 µs    |
| base64 encode/decode (64 B)                     | 1 alloc (+33% size)                              | --                                     | 0.5 to 2 µs  |
| `spawn_blocking` thread switch                  | 0 (Arc move)                                     | 1 thread pool dispatch                 | 5 to 20 µs   |
| `broadcast::send`/`recv` (tokio, Arc<[u8]>)     | 0 (Arc refcount bump)                            | 1 task wake                            | 1 to 3 µs    |
| hidraw `write(2)`/`read(2)` syscall             | 1 user→kernel (or reverse)                       | 1 kernel→driver                        | 5 to 30 µs   |
| `tabs.sendMessage` (G→B, tab-targeted)          | 1 clone + IPC                                    | 1 process boundary                     | 50 to 200 µs |

---

## 3. Path Inventory

| Path | Message                      | Mode                | Sub-path                                                                               |
| ---- | ---------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| A    | `sendReport`                 | WS                  | P→B→W→WS→D→hidraw→WS→W→B→P (ack-wait)                                                  |
| C    | `sendReport`                 | NM                  | P→B→G→NM→D→hidraw→NM→G→B→P (ack-wait)                                                  |
| U    | `sendReport`                 | WT worker           | P→B→W→WT stream→D→hidraw→WT→W→B→P (ack-wait, same frame as WS)                         |
| V    | `sendReport` (in-page)       | WT, `useWorker` off | P (in-page plane) → WT stream→D→hidraw→WT→P (ack-wait; full hot path in-page)          |
| E    | `sendFeatureReport`          | WS                  | Same as A (WS frame type 0x02)                                                         |
| F    | `sendFeatureReport`          | NM                  | Same as C (NM packed TLV 0x04)                                                         |
| G    | `receiveFeatureReport`       | WS                  | P→B→W→WS→D→hidraw→WS→W→B→P                                                             |
| H    | `receiveFeatureReport`       | NM                  | P→B→G→NM→D→hidraw→NM→G→B→P (JSON, action 5)                                            |
| I    | Input report                 | WS + MessagePort    | hidraw→D→WS→W→MessagePort→P (direct, bypass bridge)                                    |
| J    | Input report                 | WS, port fallback   | hidraw→D→WS→W→postMessage→B→control port→P                                             |
| K    | Input report                 | NM                  | hidraw→D→NM→G→B→P (tab-targeted, or via data port)                                     |
| W    | Input report                 | WT worker           | hidraw→D→WT→W→MessagePort→P (direct, bypass bridge)                                    |
| X    | Input report                 | WT in-page          | hidraw→D→WT→P (main-thread parse, no worker; `useWorker` off)                          |
| L    | `enumerate`                  | NM                  | P→B→G→NM→D→hidapi→NM→G→B→P                                                             |
| M    | `open`                       | NM                  | P→B→G→NM→D→hidapi→NM→G→B→P + data worker setup + MessagePort transfer                  |
| N    | `close`                      | NM                  | P→B→G→NM→D→NM→G→B→P + data worker terminate + port return                              |
| O    | `requestDevice`              | NM                  | P→B (picker UI) → enumerate → user select → B pairs (bridge-side) → B→P                |
| P    | `getDevices`                 | NM                  | P→B→G→storage + enumeratePaired (or cache hit)                                         |
| Q    | `handshake` (NM)             | NM                  | B→G→NM→D→NM→G→B (returns wsPort + wsNonce)                                             |
| R    | `connect`/`disconnect` event | NM                  | D→NM→G→B→P (tab-targeted)                                                              |
| S    | `getPolicy`                  | NM                  | P→B→G (Permissions-Policy header cache + iframe `allow` attr check)                    |
| T    | `globalReset`                | NM→G→B              | G broadcasts to all tabs on NM disconnect: B clears state, emits disconnect per device |

All send/sendFeature paths are ack-wait (resolve on daemon response).

---

## 4. Detailed Path Analysis

### Path A - `sendReport` WS (ack-wait)

| Step      | Location                           | Operation                                                                       | Copies                         | Hops  |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ | ----- |
| 1         | `content/main/index.js`            | `view.slice()` own-buffer copy                                                  | 1                              | 0     |
| 2         | `content/main/index.js`            | `dataPort.postMessage({type:'send',...}, [buffer])` → P→W via MessagePort       | 0 (transfer)                   | 1     |
| 3         | `content/isolated/worker/index.js` | `frame = new Uint8Array(6+len); frame.set(payload,6)`                           | 1 (alloc+copy)                 | 0     |
| 4         | `content/isolated/worker/index.js` | `ws.send(frame)` → W→D                                                          | 1 (WS encode) + 1 (kernel TCP) | 1     |
| 5         | `batching.rs`                      | `Arc::from(&frame[6..])` → `spawn_blocking`                                     | 0 (Arc)                        | 1     |
| 6         | `hid.rs`                           | `WRITE_BUF.extend_from_slice(&payload)`                                         | 1 (copy)                       | 0     |
| 7         | `hid.rs`                           | `dev.write(&buf)` → hidraw                                                      | 1 (kernel)                     | 1     |
| 8         | `websocket.rs`                     | WS ack frame → D→W                                                              | 1 (WS encode) + 1 (kernel)     | 1     |
| 9         | `content/isolated/worker/index.js` | `handleControlResponse` → `dataPort.postMessage({type:'sendResult',...})` → W→P | 0 (small obj)                  | 1     |
| 10        | `content/main/index.js`            | `dataPort.onmessage` → resolve Promise                                          | 0                              | 0     |
| **Total** |                                    |                                                                                 | **7**                          | **6** |

**Page-side latency**: **5 to 10 ms** (resolves on WS ack, not early).

**End-to-end latency**: **3 to 8 ms** (daemon-side write; ack returns after hidraw write completes).

---

### Path C - `sendReport` NM (ack-wait)

| Step      | Location                     | Operation                                                      | Copies                | Hops  |
| --------- | ---------------------------- | -------------------------------------------------------------- | --------------------- | ----- |
| 1         | `content/main/index.js`      | `view.slice()` own-buffer copy                                 | 1                     | 0     |
| 2         | `content/main/index.js`      | `bridgePort.postMessage` → P→B                                 | 1 (clone)             | 1     |
| 3         | `content/isolated/bridge.js` | `browser.runtime.sendMessage(msg)` → B→G                       | 1 (clone+IPC)         | 1     |
| 4         | `background/index.js`        | `buildPackedSend` → `port.postMessage({d:base64})` → G→N       | 1 (b64) + 1 (JSON)    | 1     |
| 5         | NM host                      | `read_frame` → `write_vectored` → socket → D                   | 2 (kernel)            | 1     |
| 6         | `client.rs`                  | `read_message` → JSON parse → base64 decode → `spawn_blocking` | 1 (JSON) + 1 (b64)    | 1     |
| 7         | `hid.rs`                     | `WRITE_BUF.extend` → `dev.write`                               | 1 (copy) + 1 (kernel) | 1     |
| 8         | `client.rs`                  | NM response → N→G                                              | 1 (JSON) + 2 (kernel) | 1     |
| 9         | `background/index.js`        | sendResponse → G→B                                             | 1 (clone+IPC)         | 1     |
| 10        | `content/isolated/bridge.js` | `replyToPage` → B→P                                            | 1 (clone)             | 1     |
| 11        | `content/main/index.js`      | resolve Promise                                                | 0                     | 0     |
| **Total** |                              |                                                                | **15**                | **9** |

**Page-side latency**: **8 to 20 ms** (full NM roundtrip).

**End-to-end latency**: **8 to 20 ms**.

---

### Path U - `sendReport` WT worker (ack-wait)

Identical to Path A with the transport leg swapped: the worker writes the same
`[0x01][reqId:u32 LE][reportId][payload]` frame over the persistent WT
bidirectional stream (each frame length-prefixed `[len:u32 LE]`; QUIC/TLS
encode + kernel UDP instead of WS encode + TCP). Same totals: **7 copies,
6 hops**. Latency **3 to 8 ms** (benchmark per-report round-trip p50 ≈ 0.85ms
vs ws 0.78ms: QUIC/TLS loopback costs ~+0.07ms per report).

---

### Path V - `sendReport` WT in-page (`useWorker` off)

The in-page WT plane carries the full hot path: `sendReport`/
`sendFeatureReport`/`receiveFeatureReport` build the same binary frames as the
worker (`[0x01|0x02|0x03][reqId:u32 LE][reportId][payload]`) and write them
over the in-page plane's persistent WT stream (`plane.wt.send`, length-prefixed
like every stream frame); acks (0x81/0x82/0x83) return on the same stream and
resolve the promise (`handleInPageControlResponse`). The bridge data-port (NM)
path remains only as the fallback while the plane is not open.

| Step      | Location                | Operation                                                       | Copies                               | Hops  |
| --------- | ----------------------- | --------------------------------------------------------------- | ------------------------------------ | ----- |
| 1         | `content/main/index.js` | `view.slice()` own-buffer copy                                  | 1                                    | 0     |
| 2         | `content/main/index.js` | `inPageRequest` builds `[0x01][reqId][reportId][payload]` frame | 1 (alloc+copy)                       | 0     |
| 3         | `content/main/index.js` | `plane.wt.send(frame)` → P→D over WT stream                     | 1 (QUIC/TLS encode) + 1 (kernel UDP) | 1     |
| 4         | `batching.rs`           | `Arc::from(&frame[6..])` → `spawn_blocking`                     | 0 (Arc)                              | 1     |
| 5         | `hid.rs`                | `WRITE_BUF.extend_from_slice(&payload)`                         | 1 (copy)                             | 0     |
| 6         | `hid.rs`                | `dev.write(&buf)` → hidraw                                      | 1 (kernel)                           | 1     |
| 7         | `webtransport.rs`       | ack frame → D→P over WT stream                                  | 1 (QUIC/TLS encode) + 1 (kernel UDP) | 1     |
| 8         | `content/main/index.js` | `handleInPageControlResponse` → resolve                         | 0                                    | 0     |
| **Total** |                         |                                                                 | **8**                                | **4** |

Copy count matches the worker send path (Path A: the two MessagePort hops are zero-copy transfers); the hop count is 4. Latency **3 to 8 ms**
(ack-wait over WT; benchmark per-report round-trip p50 ≈ 0.85ms vs ws 0.78ms).

---

### Path I - Input report WS + MessagePort (rate-gated batching)

| Step                 | Location                           | Operation                                                                                                 | Copies                                     | Hops                  |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| 1                    | `device_mgr.rs`                    | `dev.read_timeout` → `Arc::from(&buf[1..])`                                                               | 1 (kernel) + 0 (Arc)                       | 1                     |
| 2                    | `device_mgr.rs`                    | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast                                                | 0 (Arc move)                               | 1                     |
| 3                    | `batching.rs`                      | `event_rx.recv()` → `batch.push((reportId, data))`                                                        | 0 (Arc clone)                              | 0                     |
| 4                    | `batching.rs`                      | `write_batch_frame` prepend reportId + extend data                                                        | 1 (alloc+N×copy)                           | 0                     |
| 5                    | `websocket.rs`                     | `ws_sender.send` → D→W                                                                                    | 1 (WS encode) + 1 (kernel TCP)             | 1                     |
| 6                    | `content/isolated/worker/index.js` | `new Uint8Array(frame)` → parse batch → per-report `new ArrayBuffer(payloadLen)` + copy                   | 1 (kernel→JS) + 1 (alloc+copy per report)  | 0                     |
| 7                    | `content/isolated/worker/index.js` | `dataPort.postMessage({type:'inputReportBatch', reports}, transfers)` → W→P direct, one message per frame | 0 (transfers)                              | 1 (direct, no bridge) |
| 8                    | `content/main/index.js`            | `dataPort.onmessage` → `new DataView(d.data)` (zero-copy, no intermediate Uint8Array)                     | 0 (DataView wraps transferred ArrayBuffer) | 0                     |
| **Total (1 report)** |                                    |                                                                                                           | **6**                                      | **4**                 |

| Polling rate   | Est. latency | Added latency                |
| -------------- | ------------ | ---------------------------- |
| 1 kHz (sparse) | 1 to 5 ms    | 0 µs (immediate flush)       |
| 8 kHz (burst)  | 1 to 13 ms   | ≤8 ms (high-rate coalescing) |

**Key improvement vs old SAB path**: MessagePort eliminates bridge re-forward (1 fewer hop, 1 fewer structured clone, 0 Xray unwrap alloc). Polyfill zero-copy DataView eliminates 1 ArrayBuffer + 1 byte copy per report. Total allocs per report: ~2 (worker ArrayBuffer + DataView) vs ~5 to 7 in the old SAB path.

---

### Path W - Input report WT worker (rate-gated batching)

Same shape as Path I with the transport leg swapped: `batching.rs` runs the
same `batching::run_sender` and `write_batch_frame`; the frame crosses as a
length-prefixed message on the persistent WT stream (QUIC/TLS encode + kernel
UDP instead of WS encode + TCP).

| Step                 | Location                           | Operation                                                                          | Copies                                     | Hops                  |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| 1                    | `device_mgr.rs`                    | `dev.read_timeout` → `Arc::from(&buf[1..])`                                        | 1 (kernel) + 0 (Arc)                       | 1                     |
| 2                    | `device_mgr.rs`                    | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast                         | 0 (Arc move)                               | 1                     |
| 3                    | `batching.rs`                      | `event_rx.recv()` → `batch.push((reportId, data))`                                 | 0 (Arc clone)                              | 0                     |
| 4                    | `batching.rs`                      | `write_batch_frame` prepend reportId + extend data                                 | 1 (alloc+N×copy)                           | 0                     |
| 5                    | `webtransport.rs`                  | `frame_tx.send` → D→W over WT stream                                               | 1 (QUIC/TLS encode) + 1 (kernel UDP)       | 1                     |
| 6                    | `content/isolated/worker/index.js` | parse batch → per-report `new ArrayBuffer(payloadLen)` + copy                      | 1 (kernel→JS) + 1 (alloc+copy per report)  | 0                     |
| 7                    | `content/isolated/worker/index.js` | `dataPort.postMessage({type:'inputReportBatch', reports}, transfers)` → W→P direct | 0 (transfers)                              | 1 (direct, no bridge) |
| 8                    | `content/main/index.js`            | `dataPort.onmessage` → `new DataView(d.data)` (zero-copy)                          | 0 (DataView wraps transferred ArrayBuffer) | 0                     |
| **Total (1 report)** |                                    |                                                                                    | **6**                                      | **4**                 |

Latency: **1 to 5 ms** (same as Path I; +~0.07ms per report QUIC/TLS loopback cost, benchmark-measured).

---

### Path X - Input report WT in-page (`useWorker` off)

No worker and no MessagePort: the daemon writes the same type-prefixed batch
frame to the persistent WT stream, and the polyfill's `createWtTransport`
`onBinary` parses it in-page (`pushInPageBatch`) and dispatches
`HIDInputReportEvent` directly. One hop fewer than Path I/W (no worker, no
MessagePort), but the parse runs on the page's main thread, sharing CPU with
rendering: the exact contention the data worker exists to avoid (see the
profiler-confirmed loss numbers in AGENTS.md Section 3).

| Step                 | Location                | Operation                                                                                     | Copies                                    | Hops  |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- | ----- |
| 1                    | `device_mgr.rs`         | `dev.read_timeout` → `Arc::from(&buf[1..])`                                                   | 1 (kernel) + 0 (Arc)                      | 1     |
| 2                    | `device_mgr.rs`         | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast                                    | 0 (Arc move)                              | 1     |
| 3                    | `batching.rs`           | `event_rx.recv()` → `batch.push((reportId, data))`                                            | 0 (Arc clone)                             | 0     |
| 4                    | `batching.rs`           | `write_batch_frame` prepend reportId + extend data                                            | 1 (alloc+N×copy)                          | 0     |
| 5                    | `webtransport.rs`       | `frame_tx.send` → D→P over WT stream                                                          | 1 (QUIC/TLS encode) + 1 (kernel UDP)      | 1     |
| 6                    | `content/main/index.js` | `onBinary` → `pushInPageBatch`: parse batch → per-report `new ArrayBuffer(payloadLen)` + copy | 1 (kernel→JS) + 1 (alloc+copy per report) | 0     |
| 7                    | `content/main/index.js` | `new DataView` + dispatch `HIDInputReportEvent`                                               | 0                                         | 0     |
| **Total (1 report)** |                         |                                                                                               | **6**                                     | **3** |

Latency: **1 to 6 ms** (same frame path as W, one hop less; main-thread parse adds render-contention risk at high polling rates, not per-report latency).

---

### Path K - Input report NM

| Step      | Location                     | Operation                                           | Copies                             | Hops  |
| --------- | ---------------------------- | --------------------------------------------------- | ---------------------------------- | ----- |
| 1 to 2    | daemon                       | Same as I steps 1 to 2                              | 1 (kernel) + 0 (Arc)               | 2     |
| 3         | `client.rs`                  | `ipc_event_to_nm` → `data.to_vec()`                 | 1 (clone)                          | 0     |
| 4         | `client.rs`                  | `write_message` → JSON + base64                     | 1 (JSON) + 1 (b64)                 | 0     |
| 5 to 6    | NM host + Firefox NM         | socket → stdout → JSON parse → clone → G            | 2 (kernel) + 1 (parse) + 1 (clone) | 2     |
| 7         | `background/index.js`        | `tabs.sendMessage` → G→B                            | 1 (clone+IPC)                      | 1     |
| 8         | `content/isolated/bridge.js` | `replyToPage` or data port → B→P                    | 1 (clone)                          | 1     |
| 9         | `content/main/index.js`      | `new DataView(detail.data.buffer, ...)` (zero-copy) | 0 (DataView wraps existing buffer) | 0     |
| **Total** |                              |                                                     | **10**                             | **7** |

**Latency**: **8 to 18 ms**.

---

### Path L - `enumerate` (NM)

| Step      | Location                     | Operation                                              | Copies                             | Hops       |
| --------- | ---------------------------- | ------------------------------------------------------ | ---------------------------------- | ---------- |
| 1         | `content/main/index.js`      | `sendRequest("enumerate")` → P→B                       | 1 (clone, small obj)               | 1          |
| 2         | `content/isolated/bridge.js` | `browser.runtime.sendMessage` → B→G                    | 1 (clone+IPC)                      | 1          |
| 3         | `background/index.js`        | `port.postMessage({a:1})` → G→N                        | 1 (JSON)                           | 1          |
| 4         | NM host                      | `write_vectored` → socket → D                          | 2 (kernel)                         | 1          |
| 5         | `client.rs`                  | `read_message` → JSON parse → `device_mgr.enumerate()` | 1 (parse)                          | 1 (hidapi) |
| 6         | `client.rs`                  | `write_message` → JSON + devices                       | 1 (JSON) + 1 (kernel)              | 1          |
| 7 to 8    | NM host + Firefox NM         | socket → stdout → JSON parse → clone → G               | 2 (kernel) + 1 (parse) + 1 (clone) | 2          |
| 9         | `background/index.js`        | sendResponse → G→B                                     | 1 (clone+IPC)                      | 1          |
| 10        | `content/isolated/bridge.js` | `replyToPage` → B→P                                    | 1 (clone)                          | 1          |
| **Total** |                              |                                                        | **14**                             | **10**     |

**Latency**: **15 to 40 ms** (NM roundtrip + hidapi scan).

---

### Path M - `open` (always via NM)

| Phase                                                                                   | Copies | Hops   | Est. latency    |
| --------------------------------------------------------------------------------------- | ------ | ------ | --------------- |
| Request P→D (NM)                                                                        | 5      | 4      | 2 to 5 ms       |
| Daemon: hidapi open + reader thread                                                     | 0      | 1      | 5 to 15 ms      |
| Response D→P (NM, returns sessionToken + wsPort)                                        | 6      | 4      | 2 to 5 ms       |
| Data worker spawn (shadow URL or blob mode) + WS connect + MessagePort transfer (P→B→W) | 1      | 2      | 5 to 15 ms      |
| `setDataPlane` → daemon (NM)                                                            | 2      | 2      | 1 to 3 ms       |
| **Total**                                                                               | **14** | **13** | **15 to 45 ms** |

On `open()`, polyfill creates a `MessageChannel`, keeps port1 (`dataPort`), and transfers port2 to bridge via the control port. Bridge transfers port2 to the worker (`setPort` message). This establishes the direct W→P input-report channel.

---

### Path Q - `handshake` (NM, returns wsPort + wsNonce)

| Direction                                      | Copies | Hops  | Est. latency   |
| ---------------------------------------------- | ------ | ----- | -------------- |
| B→G→NM→D                                       | 3      | 3     | 2 to 5 ms      |
| D generates wsNonce (once per daemon instance) | 0      | 0     | <0.1 ms        |
| D→NM→G→B                                       | 4      | 3     | 2 to 5 ms      |
| **Total**                                      | **7**  | **6** | **5 to 10 ms** |

Bridge sends `handshake` on init. The response contains `wsPort` (the daemon's WS port) and `wsNonce` (per-daemon-instance nonce used to compute WS auth hashes). If wsNonce is absent, the WS data plane falls back to NM.

---

## 5. Summary Table - Latency per Message Type

| Message                         | WS (ack-wait)                                               | WT                                                                  | NM (ack-wait)       |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- | ------------------- |
| `sendReport` (page-side)        | **5 to 10 ms**                                              | **5 to 10 ms** (worker / in-page)                                   | **8 to 20 ms**      |
| `sendReport` (end-to-end)       | 3 to 8 ms                                                   | 3 to 8 ms (worker / in-page)                                        | 8 to 20 ms          |
| `sendFeatureReport` (page-side) | **5 to 10 ms**                                              | **5 to 10 ms** (worker / in-page)                                   | **8 to 20 ms**      |
| `receiveFeatureReport`          | **6 to 12 ms**                                              | **6 to 12 ms** (worker / in-page)                                   | **15 to 30 ms**     |
| Input report (delivery)         | **1 to 5 ms** (MessagePort) / **2 to 6 ms** (port fallback) | **1 to 5 ms** (worker) / **1 to 6 ms** (in-page, main-thread parse) | **8 to 18 ms** (NM) |
| `enumerate` (NM)                | --                                                          | --                                                                  | **15 to 40 ms**     |
| `close` (NM)                    | --                                                          | --                                                                  | **10 to 20 ms**     |
| `open` (always NM)              | --                                                          | --                                                                  | **15 to 45 ms**     |
| `handshake` (NM)                | --                                                          | --                                                                  | **5 to 10 ms**      |
| `getDevices` (cache hit)        | **<0.1 ms**                                                 | **<0.1 ms**                                                         | **<0.1 ms**         |
| `getDevices` (cache miss)       | --                                                          | --                                                                  | **15 to 40 ms**     |

---

## 6. Copy + Hop Summary

| Path                   | Copies | Hops | Bottleneck                                             |
| ---------------------- | ------ | ---- | ------------------------------------------------------ |
| A: sendReport WS       | 7      | 6    | TCP loopback + hidraw syscall                          |
| C: sendReport NM       | 15     | 9    | runtime.sendMessage + JSON/base64 + NM pipe            |
| I: Input MessagePort   | 6      | 4    | WS recv + per-report alloc                             |
| J: Input port fallback | 7      | 6    | Transfer eliminates 2 clones                           |
| K: Input NM            | 10     | 7    | JSON + base64 + tabs.sendMessage                       |
| U: sendReport WT       | 7      | 6    | QUIC/TLS encode + hidraw syscall                       |
| V: sendReport in-page  | 8      | 4    | QUIC/TLS encode + hidraw syscall (no MessagePort hops) |
| W: Input WT worker     | 6      | 4    | QUIC/TLS encode + per-report alloc                     |
| X: Input WT in-page    | 6      | 3    | No worker hop, but main-thread parse (CPU contention)  |
| L: enumerate (NM)      | 14     | 10   | hidapi scan                                            |
| M: open                | 14     | 13   | hidapi open + worker spawn + WS + setdataplane         |
| N: close (NM)          | 10     | 10   | NM roundtrip                                           |
| Q: handshake           | 7      | 6    | NM roundtrip (one-time, on init)                       |

---

## 7. Key Findings

1. **All sendReport/sendFeatureReport paths are ack-wait.** Polyfill resolves the Promise only on receipt of the daemon ack.

2. **MessagePort eliminates bridge re-forward for input reports.** Worker sends input reports directly to page via the transferred data port, bypassing bridge entirely. This eliminates 1 context hop, 1 structured clone, and 1 Xray unwrap allocation per report.

3. **Zero-copy polyfill eliminates GCMajor.** DataView created directly on transferred ArrayBuffer (no intermediate `new Uint8Array` copy) reduces allocation pressure by ~70%, preventing GCMajor from triggering during benchmarks.

4. **WS data plane is faster end-to-end** for sendReport (3 to 8ms vs 8 to 20ms) and input reports (1 to 5ms vs 8 to 18ms).

5. **Rate-gated batching** keeps latency low for sparse reports (0µs), coalesces bursts within 25µs, and widens to an 8ms window once the flush rate exceeds ~12 reports per 4ms, so 8kHz polling amortizes per-frame overhead without hurting low-rate latency.

6. **Daemon does not broadcast to both channels.** `has_nm_session` per device checks if any session on that device is in NM mode before forwarding InputReports via NM. Per-session `dataplane_modes` (HashMap<session_token, mode>) ensures each session's mode is tracked independently.

7. **WS data frame header is 6 bytes** (no device ID): `[type:u8][reqId:u32 LE][reportId:u8][payload]`. The WS connection is per-device, so the device ID is implicit. NM packed TLVs include a device ID (12-byte header) because the NM connection is shared across all devices.

8. **Control ops are NM-only.** enumerate/open/close/handshake always go via NM.

9. **WT is a full data plane in both shapes.** The WT worker path (W) is Path I with the QUIC/TLS stream in place of the TCP/WS leg (benchmark-measured ~+0.07ms per report on loopback). The WT in-page path (X, `useWorker` off) drops the worker + MessagePort hop (3 vs 4) but parses batches on the page's main thread, the exact CPU contention the worker exists to avoid. Sends are in-page too: `sendReport`/`sendFeatureReport`/`receiveFeatureReport` write the same frames over the same in-page stream (Path V, 4 hops vs 6), so in-page WT is a complete data plane, not an input-only hybrid.

---

## 8. Mermaid Sequence Diagrams

### Path A: `sendReport` WS (ack-wait)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant W as Worker (W)
    participant D as Daemon (D)

    P->>P: view.slice() own-buffer copy
    P->>B: dataPort.postMessage(send, [buffer])
    B->>W: postMessage (transfer)
    W->>W: frame = new Uint8Array(6+len)
    W->>D: ws.send(binary frame)
    D->>D: Arc::from(&frame[6..]) spawn_blocking
    D->>D: hidraw write
    D-->>W: ws ack frame
    W-->>B: sendResult
    B-->>P: dataPort.onmessage(res)
    P->>P: Promise resolves
```

### Path C: `sendReport` NM (ack-wait)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant G as Background (G)
    participant N as NM host (N)
    participant D as Daemon (D)

    P->>P: view.slice() own-buffer copy
    P->>B: bridgePort.postMessage
    B->>G: runtime.sendMessage
    G->>G: buildPackedSend (base64 TLV)
    G->>N: port.postMessage({d:b64})
    N->>D: socket write
    D->>D: JSON parse + b64 decode
    D->>D: hidraw write
    D-->>N: socket response
    N-->>G: NM read
    G-->>B: sendResponse
    B-->>P: port.postMessage(res)
    P->>P: Promise resolves
```

### Path I: Input report WS + MessagePort (rate-gated batching)

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant W as Worker (W)
    participant P as Page (P)

    D->>D: dev.read_timeout → Arc::from(&buf[1..])
    D->>D: tx.send(InputReport) broadcast
    D->>D: batch.push (25µs coalesce, 8ms at high rate)
    D->>W: ws.send(batch frame)
    W->>W: parse batch into reports
    W->>P: dataPort.postMessage(inputReportBatch, [buffers])
    Note over W,P: one message per frame, zero-copy transfers, direct W→P
    loop per report
        P->>P: DataView on transferred ArrayBuffer
        P->>P: dispatch HIDInputReportEvent
    end
```

### Path W: Input report WT worker (rate-gated batching)

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant W as Worker (W)
    participant P as Page (P)

    D->>D: dev.read_timeout → Arc::from(&buf[1..])
    D->>D: tx.send(InputReport) broadcast
    D->>D: batch.push (25µs coalesce, 8ms at high rate)
    D->>W: WT stream frame ([len u32 LE][type 0x00][reports...])
    W->>W: parse batch into reports
    W->>P: dataPort.postMessage(inputReportBatch, [buffers])
    Note over W,P: one message per frame, zero-copy transfers, direct W→P
    loop per report
        P->>P: DataView on transferred ArrayBuffer
        P->>P: dispatch HIDInputReportEvent
    end
```

### Path X: Input report WT in-page (`useWorker` off)

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant P as Page (P)

    D->>D: dev.read_timeout → Arc::from(&buf[1..])
    D->>D: tx.send(InputReport) broadcast
    D->>D: batch.push (25µs coalesce, 8ms at high rate)
    D->>P: WT stream frame ([len u32 LE][type 0x00][reports...])
    P->>P: onBinary → pushInPageBatch parse → per-report ArrayBuffer
    P->>P: DataView + dispatch HIDInputReportEvent
    Note over P: main-thread parse, no worker (render CPU contention risk)
```

### Path V: `sendReport` WT in-page (`useWorker` off)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant D as Daemon (D)

    P->>P: view.slice() own-buffer copy
    P->>P: inPageRequest builds frame ([0x01][reqId][reportId][payload])
    P->>D: plane.wt.send(frame) over WT stream
    D->>D: Arc::from(&frame[6..]) spawn_blocking
    D->>D: hidraw write
    D-->>P: ack frame over WT stream (0x81/0x82/0x83)
    P->>P: handleInPageControlResponse → resolve
```

### Path J: Input report WS port fallback

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant W as Worker (W)
    participant B as Bridge (B)
    participant P as Page (P)

    D->>W: ws.send(batch frame)
    W->>B: postMessage (port transfer failed)
    B->>B: onDataPortMessage
    B->>P: replyToPage or data port forward
    P->>P: dispatch HIDInputReportEvent
```

### Path K: Input report NM

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant N as NM host (N)
    participant G as Background (G)
    participant B as Bridge (B)
    participant P as Page (P)

    D->>D: dev.read_timeout → Arc
    D->>D: ipc_event_to_nm → data.to_vec()
    D->>N: socket write (JSON + base64)
    N-->>G: NM read (JSON parse + b64 decode)
    G->>B: tabs.sendMessage (Uint8Array)
    B->>P: port.postMessage or data port
    P->>P: DataView on buffer
    P->>P: dispatch HIDInputReportEvent
```

### Path L: `enumerate` (NM)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant G as Background (G)
    participant N as NM host (N)
    participant D as Daemon (D)

    P->>B: sendRequest("enumerate")
    B->>G: runtime.sendMessage
    G->>N: port.postMessage({a:1})
    N->>D: socket write
    D->>D: hidapi enumerate
    D-->>N: socket response (device list)
    N-->>G: NM read
    G-->>B: sendResponse
    B-->>P: port.postMessage(res)
```

### Path M: `open` (NM + WS data plane setup)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant G as Background (G)
    participant N as NM host (N)
    participant D as Daemon (D)
    participant W as Worker (W)

    P->>B: sendRequest("open")
    B->>G: runtime.sendMessage
    G->>N: port.postMessage({a:2})
    N->>D: socket write
    D->>D: hidapi open + reader thread
    D-->>N: socket response (sessionToken + wsPort)
    N-->>G: NM read
    G-->>B: sendResponse
    B->>B: computeWsAuthHash(SHA-256(token + wsNonce))
    B->>W: spawn worker (shadow URL or blob mode)
    P->>B: dataPort transfer (port2)
    B->>W: setPort (transfer port to worker)
    W->>D: WS connect (subprotocol: webhid.<hash>)
    D-->>W: WS open
    B-->>P: port.postMessage(res)
```

### Path N: `close` (NM + worker terminate)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant G as Background (G)
    participant N as NM host (N)
    participant D as Daemon (D)
    participant W as Worker (W)

    P->>B: sendRequest("close")
    B->>G: runtime.sendMessage
    G->>N: port.postMessage({a:3})
    N->>D: socket write
    D->>D: close hidraw + stop reader
    D-->>N: socket response
    N-->>G: NM read
    G-->>B: sendResponse
    B->>W: terminate worker
    B->>P: port.postMessage(res)
    P->>P: dispatch "close" event
```

### Path O: `requestDevice` (picker UI + pairing)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant Picker as Picker (B)
    participant G as Background (G)
    participant D as Daemon (D)

    P->>B: sendRequest("requestDevice")
    B->>Picker: devicePicker.show(filters)
    Picker->>G: runtime.sendMessage(enumerate)
    G->>D: NM → socket
    D-->>G: device list
    G-->>Picker: sendResponse
    Picker->>Picker: applyFilters + render
    Note over Picker: user selects, clicks Connect
    Picker-->>B: webhid-device-selected
    B->>G: runtime.sendMessage(pairDevice, per device)
    B->>G: runtime.sendMessage(recordGrantGroup, when more than one)
    G->>G: IndexedDB origins store + grantGroups
    B-->>P: port.postMessage(devices)
```

### Path Q: `handshake` (NM, one-time)

```mermaid
sequenceDiagram
    participant B as Bridge (B)
    participant G as Background (G)
    participant N as NM host (N)
    participant D as Daemon (D)

    B->>G: runtime.sendMessage(handshake)
    G->>N: port.postMessage({a:8})
    N->>D: socket write
    D->>D: generate wsNonce (once per instance)
    D-->>N: socket response (wsPort + wsNonce)
    N-->>G: NM read
    G-->>B: sendResponse
    B->>B: store wsPort + wsNonce
```

### Path R: `connect`/`disconnect` event (NM, tab-targeted)

```mermaid
sequenceDiagram
    participant D as Daemon (D)
    participant N as NM host (N)
    participant G as Background (G)
    participant B as Bridge (B)
    participant P as Page (P)

    D->>D: hotplug detect (udev/IOHID/WM_DEVICECHANGE)
    D-->>N: socket event
    N-->>G: NM read (event frame)
    G->>B: tabs.sendMessage (tab-targeted)
    B->>P: port.postMessage(event)
    P->>P: dispatch HIDConnectionEvent
```

### Path S: `getPolicy` (Permissions-Policy check)

```mermaid
sequenceDiagram
    participant P as Page (P)
    participant B as Bridge (B)
    participant G as Background (G)

    P->>B: sendRequest("getPolicy")
    B->>B: check iframe allow="hid" attr
    B->>G: runtime.sendMessage(getPolicy)
    G->>G: lookup Permissions-Policy cache
    alt policy = "none"
        G-->>B: {policy: {hid: "none"}}
    else allowed
        G-->>B: {policy: {hid: "allowed"}}
    end
    B-->>P: port.postMessage(result)
```

### Path T: `globalReset` (NM disconnect recovery)

```mermaid
sequenceDiagram
    participant G as Background (G)
    participant B as Bridge (B)
    participant P as Page (P)

    G->>G: NM port disconnect detected
    G->>G: resolve all pending with {s:503}
    G->>B: broadcast globalReset (tabs.sendMessage)
    B->>B: clear openDevices + sessionTokens
    B->>B: despawn all data workers
    loop per open device
        B-->>P: event: disconnect
        P->>P: dispatch HIDConnectionEvent("disconnect")
    end
```
