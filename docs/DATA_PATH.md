# Data Path Analysis

> Codebase: latest main (post-camelCase refactor, post-MessageChannel, post-control-worker)

---

## 1. Execution Contexts

| # | Context | Process | Realm | Files |
|---|---------|---------|-------|-------|
| P | Page MAIN world | Firefox content (tab) | Isolated (page) | `polyfill.js` |
| B | Content script | Firefox content (tab) | Isolated (addon) | `bridge.js` |
| W | Web Worker (data) | Firefox content (worker thread) | Worker | `worker.js` |
| C | Web Worker (control) | Firefox content (worker thread) | Worker | `control.js` |
| G | Background script | Firefox background | Extension | `background.js` |
| N | NM host process | OS process | -- | `webhid.forwarder_nm_host` or daemon NM-host mode |
| D | Daemon process | OS process | -- | `webhid-daemon` |

---

## 2. Cost Model

| Operation | Copy cost | Hop cost | Est. latency |
|-----------|-----------|----------|--------------|
| `postMessage` same-process (P↔B, B↔W) | 1 structured clone (~5 to 15 μs for typed array) | 1 realm switch | 5 to 15 μs |
| `postMessage` with transfer list | 0 (buffer ownership moved) | 1 realm switch | 3 to 8 μs |
| MessageChannel `port.postMessage` with transfer | 0 (buffer ownership moved) | 1 realm switch (direct W→P, no bridge) | 3 to 8 μs |
| `runtime.sendMessage` (B↔G) | 1 clone + IPC marshal | 1 process boundary | 50 to 200 μs |
| `connectNative.postMessage` (G→N) | 1 JSON serialize + pipe write | 1 process spawn/pipe | 30 to 100 μs |
| Unix socket write+read (N↔D, loopback) | 2 kernel copies | 1 process boundary | 5 to 15 μs |
| WebSocket send+recv (W↔D or C↔D, TCP loopback) | 1 WS encode + 2 kernel copies | 1 process boundary | 10 to 30 μs |
| WS text frame (JSON control) | 1 JSON serialize/parse | 1 process boundary | 10 to 30 μs |
| `JSON.stringify`/`parse` (small obj) | 1 alloc | -- | 1 to 5 μs |
| base64 encode/decode (64 B) | 1 alloc (+33% size) | -- | 0.5 to 2 μs |
| `spawn_blocking` thread switch | 0 (Arc move) | 1 thread pool dispatch | 5 to 20 μs |
| `broadcast::send`/`recv` (tokio, Arc<[u8]>) | 0 (Arc refcount bump) | 1 task wake | 1 to 3 μs |
| hidraw `write(2)`/`read(2)` syscall | 1 user→kernel (or reverse) | 1 kernel→driver | 5 to 30 μs |
| `tabs.sendMessage` (G→B, tab-targeted) | 1 clone + IPC | 1 process boundary | 50 to 200 μs |

---

## 3. Path Inventory

| Path | Message | Mode | Sub-path |
|------|---------|------|----------|
| A | `sendReport` | WS, fire-and-forget | P→B→W→WS→D→hidraw |
| B | `sendReport` | WS, ack-wait | P→B→W→WS→D→hidraw→WS→W→B→P |
| C | `sendReport` | NM, fire-and-forget | P→B→G→NM→D→hidraw |
| D | `sendReport` | NM, ack-wait | P→B→G→NM→D→NM→G→B→P |
| E | `sendFeatureReport` | WS, fire-and-forget | Same as A |
| F | `sendFeatureReport` | NM, fire-and-forget | Same as C |
| G | `receiveFeatureReport` | WS | P→B→W→WS→D→hidraw→WS→W→B→P |
| H | `receiveFeatureReport` | NM | P→B→G→NM→D→hidraw→NM→G→B→P |
| I | Input report | WS + MessageChannel | hidraw→D→WS→W→MessageChannel→P (direct, bypass bridge) |
| J | Input report | WS, postMessage fallback | hidraw→D→WS→W→postMessage→B→P |
| K | Input report | NM | hidraw→D→NM→G→B→P |
| L | `enumerate` | Control=NM | P→B→G→NM→D→hidapi→NM→G→B→P |
| L2 | `enumerate` | Control=WS | P→B→C(MessageChannel)→WS(text)→D→hidapi→WS(text)→C→B→P |
| M | `open` | Always NM | P→B→G→NM→D→hidapi→NM→G→B→P + data worker setup |
| N | `close` | Control=NM | P→B→G→NM→D→NM→G→B→P + data worker terminate |
| N2 | `close` | Control=WS | P→B→C(MessageChannel)→WS(text)→D→WS(text)→C→B→P + data worker terminate |
| O | `requestDevice` | -- | P→B (picker UI) → enumerate → user select → B→P |
| P | `getDevices` | -- | P→B→G→storage + enumerate (or cache hit) |
| Q | `handshake` (NM) | -- | B→G→NM→D→NM→G→B (returns controlToken + wsPort) |
| R | `connect`/`disconnect` event | -- | D→NM→G→B→P (tab-targeted) |

---

## 4. Detailed Path Analysis

### Path A - `sendReport` WS fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `worker.postMessage(wMsg, transfer)` → B→W | 0 (transfer) | 1 |
| 4 | `worker.js` | `frame = new Uint8Array(6+len); frame.set(payload,6)` | 1 (alloc+copy) | 0 |
| 5 | `worker.js` | `ws.send(frame)` → W→D | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `websocket.rs` | `Arc::from(&frame[6..])` → `spawn_blocking` | 0 (Arc) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend_from_slice(&payload)` | 1 (copy) | 0 |
| 8 | `hid.rs` | `dev.write(&buf)` → hidraw | 1 (kernel) | 1 |
| **Total** | | | **6** | **5** |

**Page-side latency**: **<0.1ms**. Resolves immediately after `window.postMessage`, no callback wait.

**End-to-end latency**: **3 to 8ms**.

---

### Path C - `sendReport` NM fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `browser.runtime.sendMessage(msg)` → B→G (async, not awaited) | 1 (clone+IPC) | 1 |
| 4 | `background.js` | `base64Encode(data)` → `port.postMessage` → G→N | 1 (b64) + 1 (JSON) | 1 |
| 5 | NM host | `read_frame` → `write_vectored` → socket → D | 2 (kernel) | 1 |
| 6 | `client.rs` | `read_message` → JSON parse → base64 decode → `spawn_blocking` | 1 (JSON) + 1 (b64) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend` → `dev.write` | 1 (copy) + 1 (kernel) | 1 |
| **Total** | | | **11** | **6** |

**Page-side latency**: **<0.1ms**.

**End-to-end latency**: **8 to 20ms**.

---

### Path I - Input report WS + MessageChannel (adaptive batching)

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `device_mgr.rs` | `dev.read_timeout` → `Arc::from(&buf[1..])` | 1 (kernel) + 0 (Arc) | 1 |
| 2 | `device_mgr.rs` | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast | 0 (Arc move) | 1 |
| 3 | `websocket.rs` | `event_rx.recv()` → `batch.push((reportId, data))` | 0 (Arc clone) | 0 |
| 4 | `websocket.rs` | `create_batch_frame` prepend reportId + extend data | 1 (alloc+N×copy) | 0 |
| 5 | `websocket.rs` | `ws_sender.send` → D→W | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `worker.js` | `new Uint8Array(frame)` → parse batch → per-report `new ArrayBuffer(payloadLen)` + copy | 1 (kernel→JS) + 1 (alloc+copy per report) | 0 |
| 7 | `worker.js` | `port.postMessage({type:'inputReport', reportId, data: buf}, [buf])` → W→P direct | 0 (transfer) | 1 (direct, no bridge) |
| 8 | `polyfill.js` | `port.onmessage` → `new DataView(d.data)` (zero-copy, no intermediate Uint8Array) | 0 (DataView wraps transferred ArrayBuffer) | 0 |
| **Total (1 report)** | | | **6** | **4** |

| Polling rate | Est. latency | Added latency |
|-------------|-------------|---------------|
| 1 kHz (sparse) | 1 to 5 ms | 0 μs (immediate flush) |
| 8 kHz (burst) | 1.1 to 5.1 ms | ≤100 μs (coalescing) |

**Key improvement vs old SAB path**: MessageChannel eliminates bridge re-forward (1 fewer hop, 1 fewer structured clone, 0 Xray unwrap alloc). Polyfill zero-copy DataView eliminates 1 ArrayBuffer + 1 byte copy per report. Total allocs per report: ~2 (worker ArrayBuffer + DataView) vs ~5 to 7 in the old SAB path.

---

### Path K - Input report NM

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 to 2 | daemon | Same as I steps 1 to 2 | 1 (kernel) + 0 (Arc) | 2 |
| 3 | `client.rs` | `ipc_event_to_nm` → `data.to_vec()` | 1 (clone) | 0 |
| 4 | `client.rs` | `write_message` → JSON + base64 | 1 (JSON) + 1 (b64) | 0 |
| 5 to 6 | NM host + Firefox NM | socket → stdout → JSON parse → clone → G | 2 (kernel) + 1 (parse) + 1 (clone) | 2 |
| 7 | `background.js` | `tabs.sendMessage` → G→B | 1 (clone+IPC) | 1 |
| 8 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| 9 | `polyfill.js` | `new DataView(detail.data.buffer, ...)` (zero-copy) | 0 (DataView wraps existing buffer) | 0 |
| **Total** | | | **10** | **7** |

**Latency**: **8 to 18 ms**.

---

### Path L2 - `enumerate` via WS control plane (control worker)

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `sendRequest("enumerate")` → P→B | 1 (clone, small obj) | 1 |
| 2 | `bridge.js` | `_controlPort.postMessage({type:'command'})` → B→C via MessageChannel | 0 (port, same-process) | 1 |
| 3 | `control.js` | `ws.send(JSON)` → C→D | 1 (JSON serialize) | 1 |
| 4 | `websocket.rs` | `handle_client_text` → `device_mgr.enumerate()` | 0 | 1 (hidapi) |
| 5 | `websocket.rs` | `ws_sender.send(Text(json))` → D→C | 1 (JSON serialize) + 1 (kernel) | 1 |
| 6 | `control.js` | `port.postMessage({type:'response'})` → C→B via MessageChannel | 0 (port) | 1 |
| 7 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| **Total** | | | **5** | **6** |

**Latency**: **5 to 15 ms** (WS roundtrip + hidapi scan, no NM pipe).

---

### Path M - `open` (always via NM)

| Phase | Copies | Hops | Est. latency |
|-------|--------|------|-------------|
| Request P→D (NM) | 5 | 4 | 2 to 5 ms |
| Daemon: hidapi open + reader thread | 0 | 1 | 5 to 15 ms |
| Response D→P (NM) | 6 | 4 | 2 to 5 ms |
| Data worker spawn + WS connect + MessageChannel setup | 1 | 2 | 5 to 15 ms |
| `setdataplane` → daemon | 2 | 2 | 1 to 3 ms |
| **Total** | **14** | **13** | **15 to 45 ms** |

---

### Path Q - `handshake` (NM, returns control token + WS port)

| Direction | Copies | Hops | Est. latency |
|-----------|--------|------|-------------|
| B→G→NM→D | 3 | 3 | 2 to 5 ms |
| D generates controlToken | 0 | 0 | <0.1 ms |
| D→NM→G→B | 4 | 3 | 2 to 5 ms |
| **Total** | **7** | **6** | **5 to 10 ms** |

Bridge sends `handshake` on init, spawns control worker immediately after (if controlPlane=WS).

---

## 5. Summary Table - Latency per Message Type

| Message | WS fire-and-forget | WS ack-wait | NM fire-and-forget | NM ack-wait |
|---------|-------------------|-------------|--------------------|----|
| `sendReport` (page-side) | **<0.1 ms** | **5 to 10 ms** | **<0.1 ms** | **8 to 20 ms** |
| `sendReport` (end-to-end) | 3 to 8 ms | 3 to 8 ms | 8 to 20 ms | 8 to 20 ms |
| `sendFeatureReport` (page-side) | **<0.1 ms** | **5 to 10 ms** | **<0.1 ms** | **8 to 20 ms** |
| `receiveFeatureReport` | -- | **6 to 12 ms** | -- | **15 to 30 ms** |
| Input report (delivery) | **1 to 5 ms** (MessageChannel) / **2 to 6 ms** (postMessage fallback) | -- | **8 to 18 ms** (NM) | -- |
| `enumerate` (Control=NM) | -- | -- | -- | **15 to 40 ms** |
| `enumerate` (Control=WS) | -- | **5 to 15 ms** | -- | -- |
| `close` (Control=NM) | -- | -- | -- | **10 to 20 ms** |
| `close` (Control=WS) | -- | **3 to 8 ms** | -- | -- |
| `open` (always NM) | -- | -- | -- | **15 to 45 ms** |
| `handshake` (NM) | -- | -- | -- | **5 to 10 ms** |
| `getDevices` (cache hit) | **<0.1 ms** | -- | **<0.1 ms** | -- |
| `getDevices` (cache miss) | -- | -- | -- | **15 to 40 ms** |

---

## 6. Copy + Hop Summary

| Path | Copies | Hops | Bottleneck |
|------|--------|------|------------|
| A: sendReport WS faf | 6 | 5 | TCP loopback + hidraw syscall |
| B: sendReport WS ack | 11 | 8 | WS roundtrip + worker→bridge→page |
| C: sendReport NM faf | 11 | 6 | runtime.sendMessage + JSON/base64 + NM pipe |
| D: sendReport NM ack | 19 | 10 | Full NM roundtrip + JSON + base64 |
| I: Input MessageChannel | 6 | 4 | WS recv + per-report alloc |
| J: Input postMessage fallback | 7 | 6 | Transfer eliminates 2 clones |
| K: Input NM | 10 | 7 | JSON + base64 + tabs.sendMessage |
| L: enumerate (NM) | 11 | 9 | hidapi scan |
| L2: enumerate (WS, control worker) | 5 | 6 | hidapi scan (no NM pipe) |
| M: open | 14 | 13 | hidapi open + worker spawn + WS + setdataplane |
| N: close (NM) | 10 | 10 | NM roundtrip |
| N2: close (WS, control worker) | 4 | 5 | WS text roundtrip |
| Q: handshake | 7 | 6 | NM roundtrip (one-time, on init) |

---

## 7. Key Findings

1. **Fire-and-forget page latency is <0.1ms for both WS and NM.** Polyfill resolves immediately after `window.postMessage`, no callback or ack wait.

2. **Control plane WS reduces enumerate/close latency** from 15 to 40ms (NM) to 5 to 15ms (WS text frame roundtrip via control worker, no NM pipe).

3. **Control worker offloads WS control from main thread.** Control WS connection lives in a dedicated Web Worker, same pattern as data worker. Bridge communicates via MessageChannel.

4. **MessageChannel eliminates bridge re-forward for input reports.** Worker sends input reports directly to page via port, bypassing bridge entirely. This eliminates 1 context hop, 1 structured clone, and 1 Xray unwrap allocation per report.

5. **Zero-copy polyfill eliminates GCMajor.** DataView created directly on transferred ArrayBuffer (no intermediate `new Uint8Array` copy) reduces allocation pressure by ~70%, preventing GCMajor from triggering during benchmarks.

6. **WS data plane is faster end-to-end** for sendReport (3 to 8ms vs 8 to 20ms) and input reports (1 to 5ms vs 8 to 18ms).

7. **Adaptive batching** keeps latency low for sparse reports (0μs) while amortizing syscalls during bursts (≤100μs).

8. **Daemon does not broadcast to both channels.** `dataplane_mode` per device ensures events go only to the requested channel.
