# FF-WebHID — Data Path Analysis

> Codebase: `84329e0`

---

## 1. Execution Contexts

| # | Context | Process | Realm | Files |
|---|---------|---------|-------|-------|
| P | Page MAIN world | Firefox content (tab) | Isolated (page) | `polyfill.js` |
| B | Content script | Firefox content (tab) | Isolated (addon) | `bridge.js` |
| W | Web Worker | Firefox content (worker thread) | Worker | `worker.js` |
| G | Background script | Firefox background | Extension | `background.js` |
| N | NM host process | OS process | — | `webhid.forwarder_nm_host` or daemon NM-host mode |
| D | Daemon process | OS process | — | `webhid-daemon` |

---

## 2. Cost Model

| Operation | Copy cost | Hop cost | Est. latency |
|-----------|-----------|----------|--------------|
| `postMessage` same-process (P↔B, B↔W) | 1 structured clone (~5–15 μs for typed array) | 1 realm switch | 5–15 μs |
| `postMessage` with transfer list | 0 (buffer ownership moved) | 1 realm switch | 3–8 μs |
| `runtime.sendMessage` (B↔G) | 1 clone + IPC marshal | 1 process boundary | 50–200 μs |
| `connectNative.postMessage` (G→N) | 1 JSON serialize + pipe write | 1 process spawn/pipe | 30–100 μs |
| Unix socket write+read (N↔D, loopback) | 2 kernel copies | 1 process boundary | 5–15 μs |
| WebSocket send+recv (W↔D, TCP loopback) | 1 WS encode + 2 kernel copies | 1 process boundary | 10–30 μs |
| `JSON.stringify`/`parse` (small obj) | 1 alloc | — | 1–5 μs |
| base64 encode/decode (64 B) | 1 alloc (+33% size) | — | 0.5–2 μs |
| `spawn_blocking` thread switch | 0 (Arc move) | 1 thread pool dispatch | 5–20 μs |
| `Atomics.notify` + `waitAsync` wake | 0 (SAB shared) | 1 realm wake | 5–15 μs |
| `broadcast::send`/`recv` (tokio, Arc<[u8]>) | 0 (Arc refcount bump) | 1 task wake | 1–3 μs |
| hidraw `write(2)`/`read(2)` syscall | 1 user→kernel (or reverse) | 1 kernel→driver | 5–30 μs |
| `tabs.sendMessage` (G→B, tab-targeted) | 1 clone + IPC | 1 process boundary | 50–200 μs |

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
| I | Input report | WS + SAB | hidraw→D→WS→W→SAB→P |
| J | Input report | WS, postMessage fallback | hidraw→D→WS→W→postMessage→B→P |
| K | Input report | NM | hidraw→D→NM→G→B→P |
| L | `enumerate` | — | P→B→G→NM→D→hidapi→NM→G→B→P |
| M | `open` | — | P→B→G→NM→D→hidapi→NM→G→B→P + worker spawn + WS connect |
| N | `close` | — | P→B→G→NM→D→NM→G→B→P + worker terminate |
| O | `requestDevice` | — | P→B (picker UI) → enumerate → user select → B→P |
| P | `getDevices` | — | P→B→G→storage + enumerate (or cache hit) |
| Q | `connect`/`disconnect` event | — | D→NM→G→B→P (tab-targeted) |
| R | `handshake` event | — | D→NM→G→B (stores ws_port, broadcast) |

---

## 4. Detailed Path Analysis

### Path A — `sendReport` WS fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` — own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `worker.postMessage(wMsg, transfer)` → B→W | 0 (transfer) | 1 |
| 4 | `worker.js` | `frame = new Uint8Array(6+len); frame.set(payload,6)` | 1 (alloc+copy) | 0 |
| 5 | `worker.js` | `ws.send(frame)` → W→D | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `websocket.rs` | `Arc::from(&frame[6..])` → `spawn_blocking` | 0 (Arc) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend_from_slice(&payload)` | 1 (copy) | 0 |
| 8 | `hid.rs` | `dev.write(&buf)` → hidraw | 1 (kernel) | 1 |
| **Total** | | | **6** | **5** |

**Page-side latency** (perf.begin → perf.end): **<0.1ms** — resolves immediately after `window.postMessage`, no callback wait.

**End-to-end latency** (page → hidraw): **3–8ms** (WS encode + TCP + spawn_blocking + hidraw).

---

### Path B — `sendReport` WS ack-wait

Same as A steps 1–8, plus response:

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 9 | `websocket.rs` | `make_status_resp` → `ws_sender.send` → D→W | 1 (alloc) + 1 (WS encode) + 1 (kernel) | 1 |
| 10 | `worker.js` | `handleControlResponse` → `self.postMessage` → W→B | 1 (clone) | 1 |
| 11 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| **Total** | | | **6 + 5 = 11** | **5 + 3 = 8** |

**Page-side latency**: **5–10ms** (full WS roundtrip).

---

### Path C — `sendReport` NM fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` — own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `browser.runtime.sendMessage(msg)` → B→G (async, not awaited) | 1 (clone+IPC) | 1 |
| 4 | `background.js` | `base64Encode(data)` → `port.postMessage` → G→N | 1 (b64) + 1 (JSON) | 1 |
| 5 | NM host | `read_frame` → `write_vectored` → socket → D | 2 (kernel) | 1 |
| 6 | `client.rs` | `read_message` → JSON parse → base64 decode → `spawn_blocking` | 1 (JSON) + 1 (b64) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend` → `dev.write` | 1 (copy) + 1 (kernel) | 1 |
| **Total** | | | **11** | **6** |

**Page-side latency**: **<0.1ms** — resolves immediately after `window.postMessage`.

**End-to-end latency**: **8–20ms** (NM pipe + JSON + base64 + hidraw).

---

### Path D — `sendReport` NM ack-wait

Same as C steps 1–7, plus response:

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 8 | `client.rs` | `write_message` → JSON + base64 → socket → N | 1 (JSON) + 1 (b64) + 1 (kernel) | 1 |
| 9 | NM host | `read_frame` → `write_vectored` → stdout → G | 2 (kernel) | 1 |
| 10 | Firefox NM | JSON parse → clone → G | 1 (parse) + 1 (clone) | 1 |
| 11 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| **Total** | | | **11 + 8 = 19** | **6 + 4 = 10** |

**Page-side latency**: **8–20ms** (full NM roundtrip).

---

### Path E — `sendFeatureReport` WS fire-and-forget

Identical to Path A.

| Copies | Hops | Page latency | E2E latency |
|--------|------|-------------|-------------|
| 6 | 5 | <0.1ms | 3–8ms |

---

### Path F — `sendFeatureReport` NM fire-and-forget

Identical to Path C.

| Copies | Hops | Page latency | E2E latency |
|--------|------|-------------|-------------|
| 11 | 6 | <0.1ms | 8–20ms |

---

### Path G — `receiveFeatureReport` WS (roundtrip)

#### Request (P → D)

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `sendRequest("worker-receiveFeature")` → P→B | 1 (clone, small obj) | 1 |
| 2 | `bridge.js` | `worker.postMessage(wMsg)` → B→W | 1 (clone) | 1 |
| 3 | `worker.js` | `frame = new Uint8Array(6); ws.send(frame)` → W→D | 1 (WS encode) + 1 (kernel) | 1 |
| 4 | `websocket.rs` | `spawn_blocking` → `hid::read_feature_report` | 1 (kernel read) | 1 |
| 5 | `hid.rs` | `dev.get_feature_report` → `buf[..n].to_vec()` | 1 (copy) | 0 |

#### Response (D → P)

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 6 | `websocket.rs` | `make_feature_read_resp` → frame | 1 (alloc+copy) | 0 |
| 7 | `websocket.rs` | `ws_sender.send` → D→W | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 8 | `worker.js` | `new Uint8Array(frame)` → `handleControlResponse` | 1 (kernel→JS) | 0 |
| 9 | `worker.js` | `out = new Uint8Array(len); out.set(subarray)` | 1 (alloc+copy) | 0 |
| 10 | `worker.js` | `self.postMessage(data, [data.buffer])` → W→B | 0 (transfer) | 1 |
| 11 | `bridge.js` | `window.postMessage(result, [data.buffer])` → B→P | 0 (transfer) | 1 |
| 12 | `polyfill.js` | `buf = response.data` (already transferred) | 0 | 0 |
| **Total** | | | **10** | **7** |

**Page-side latency**: **6–12ms** (full roundtrip).

---

### Path H — `receiveFeatureReport` NM (roundtrip)

| Direction | Copies | Hops | Key ops |
|-----------|--------|------|---------|
| Request P→D | 6 | 4 | clone×2, JSON serialize, kernel pipe+socket, JSON parse |
| Daemon read | 2 | 1 | kernel read, to_vec |
| Response D→P | 8 | 4 | JSON+base64, kernel socket+pipe, JSON parse, clone×3, base64 decode |
| **Total** | **16** | **9** | |

**Page-side latency**: **15–30ms**.

---

### Path I — Input report WS + SAB (adaptive batching)

The daemon's WS sender uses adaptive flushing: block on `recv()` for first report, drain available via `try_recv()`, flush immediately if 1 report (sparse) or coalesce with 100μs window if burst.

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `device_mgr.rs` | `dev.read_timeout` → `Arc::from(&buf[1..])` | 1 (kernel) + 0 (Arc) | 1 (device→thread) |
| 2 | `device_mgr.rs` | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast | 0 (Arc move) | 1 (broadcast) |
| 3 | `websocket.rs` | `event_rx.recv()` → `batch.push((report_id, data))` | 0 (Arc clone = refcount) | 0 |
| 4 | `websocket.rs` | `create_batch_frame` — prepend report_id + extend data | 1 (alloc+N×copy) | 0 |
| 5 | `websocket.rs` | `ws_sender.send` → D→W | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `worker.js` | `new Uint8Array(frame)` | 1 (kernel→JS) | 0 |
| 7 | `worker.js` | `data.set(subarray, slotStart+2)` → SAB slot | 1 (copy per report) | 0 |
| 8 | `worker.js` | `Atomics.store + Atomics.notify` | 0 | 1 (wake) |
| 9 | `polyfill.js` | `Atomics.waitAsync` resolves → drain | 0 | 1 (wake) |
| 10 | `polyfill.js` | `new Uint8Array(reports.subarray(...))` → copy | 1 (alloc+copy per report) | 0 |
| **Total (1 report)** | | | **8** | **5** |
| **Total (N reports, burst)** | | | **6 + 2N** (amortized) | **5** |

| Polling rate | Est. page latency | Frame rate | Added latency |
|-------------|-------------------|------------|---------------|
| 1 kHz (sparse) | 1–5 ms | ~1000/s | 0 μs (immediate flush) |
| 8 kHz (burst) | 1.1–5.1 ms | ~2000–4000/s | ≤100 μs (coalescing) |

---

### Path J — Input report WS postMessage fallback (SAB unavailable at runtime)

Same as Path I steps 1–6, then:

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 7 | `worker.js` | `buf = new ArrayBuffer(len); .set(subarray)` | 1 (alloc+copy) | 0 |
| 8 | `worker.js` | `self.postMessage({data:buf}, [buf])` → W→B | 0 (transfer) | 1 |
| 9 | `bridge.js` | `window.postMessage({data:buf}, '*', [buf])` → B→P | 0 (transfer) | 1 |
| 10 | `polyfill.js` | `new Uint8Array(detail.data)` — view on transferred buffer | 0 (view) | 0 |
| **Total** | | | **7** | **6** |

**Page-side latency**: **2–6 ms**.

---

### Path K — Input report NM

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1–2 | daemon | Same as I steps 1–2 | 1 (kernel) + 0 (Arc) | 2 |
| 3 | `client.rs` | `ipc_event_to_nm` → `data.to_vec()` (Arc → Vec for NM JSON) | 1 (clone) | 0 |
| 4 | `client.rs` | `write_message` → JSON serialize + base64 encode | 1 (JSON) + 1 (b64) | 0 |
| 5 | `client.rs` | `writer.write_all` → socket → N | 1 (kernel) | 1 |
| 6 | NM host | `read_frame` → `write_vectored` → stdout → G | 2 (kernel) | 1 |
| 7 | Firefox NM | JSON parse → clone → G | 1 (parse) + 1 (clone) | 1 |
| 8 | `background.js` | `tabs.sendMessage` → G→B (tab-targeted) | 1 (clone+IPC) | 1 |
| 9 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| 10 | `polyfill.js` | `base64Decode(detail.data)` | 1 (decode) | 0 |
| **Total** | | | **12** | **7** |

**Page-side latency**: **8–18 ms**.

---

### Path L — `enumerate` (control plane roundtrip)

| Direction | Copies | Hops | Key ops |
|-----------|--------|------|---------|
| Request P→D | 5 | 4 | clone×2, JSON serialize, kernel pipe+socket |
| Daemon enumerate | 0 | 1 | hidapi scan (opens every device for descriptor) |
| Response D→P | 6 | 4 | JSON serialize, kernel socket+pipe, JSON parse, clone×2 |
| **Total** | **11** | **9** | |

**Latency**: **15–40 ms**.

---

### Path M — `open`

| Phase | Copies | Hops | Est. latency |
|-------|--------|------|-------------|
| Request P→D | 5 | 4 | 2–5 ms |
| Daemon: hidapi open + reader thread spawn | 0 | 1 | 5–15 ms |
| Response D→P | 6 | 4 | 2–5 ms |
| Worker spawn + WS connect + SAB creation | 1 | 2 | 5–15 ms |
| `setdataplane` → daemon | 2 | 2 | 1–3 ms |
| **Total** | **14** | **13** | **15–45 ms** |

---

### Path N — `close`

| Phase | Copies | Hops | Est. latency |
|-------|--------|------|-------------|
| Request P→D | 5 | 4 | 2–5 ms |
| Daemon: close + stop reader | 0 | 1 | 1–3 ms |
| Response D→P | 5 | 4 | 2–5 ms |
| Worker terminate | 0 | 1 | 1–2 ms |
| **Total** | **10** | **10** | **10–20 ms** |

---

## 5. Summary Table — Latency per Message Type

| Message | WS fire-and-forget | WS ack-wait | NM fire-and-forget | NM ack-wait |
|---------|-------------------|-------------|--------------------|----|
| `sendReport` (page-side) | **<0.1 ms** | **5–10 ms** | **<0.1 ms** | **8–20 ms** |
| `sendReport` (end-to-end) | 3–8 ms | 3–8 ms | 8–20 ms | 8–20 ms |
| `sendFeatureReport` (page-side) | **<0.1 ms** | **5–10 ms** | **<0.1 ms** | **8–20 ms** |
| `receiveFeatureReport` | — | **6–12 ms** | — | **15–30 ms** |
| Input report (delivery) | **1–5 ms** (SAB) / **2–6 ms** (postMessage) | — | **8–18 ms** (NM) | — |
| `enumerate` | — | — | — | **15–40 ms** |
| `open` | — | — | — | **15–45 ms** |
| `close` | — | — | — | **10–20 ms** |
| `requestDevice` | — | — | — | **15–40 ms** (+ user) |
| `getDevices` (cache hit) | **<0.1 ms** | — | **<0.1 ms** | — |
| `getDevices` (cache miss) | — | — | — | **15–40 ms** |
| `connect`/`disconnect` event | — | — | — | **8–18 ms** |
| `handshake` event | — | — | — | **5–15 ms** |

---

## 6. Copy + Hop Summary

| Path | Copies | Hops | Bottleneck |
|------|--------|------|------------|
| A: sendReport WS faf | 6 | 5 | TCP loopback + hidraw syscall |
| B: sendReport WS ack | 11 | 8 | WS roundtrip + worker→bridge→page |
| C: sendReport NM faf | 11 | 6 | runtime.sendMessage + JSON/base64 + NM pipe |
| D: sendReport NM ack | 19 | 10 | Full NM roundtrip + JSON + base64 |
| E: sendFeature WS faf | 6 | 5 | Same as A |
| F: sendFeature NM faf | 11 | 6 | Same as C |
| G: receiveFeature WS | 10 | 7 | Roundtrip + 4 response copies |
| H: receiveFeature NM | 16 | 9 | Roundtrip + JSON + base64 |
| I: Input SAB | 8 (1 report) / ~2N+6 (burst) | 5 | SAB drain alloc + broadcast |
| J: Input postMessage | 7 | 6 | Transfer eliminates 2 clones |
| K: Input NM | 12 | 7 | JSON + base64 + tabs.sendMessage |
| L: enumerate | 11 | 9 | hidapi scan (opens every device) |
| M: open | 14 | 13 | hidapi open + worker spawn + WS + setdataplane |
| N: close | 10 | 10 | NM roundtrip |

---

## 7. Daemon Optimizations in Place

| Optimization | Location | Effect |
|-------------|----------|--------|
| `Arc<[u8]>` for broadcast data | `types.rs`, `device_mgr.rs` | Zero-clone broadcast (refcount bump) |
| `Arc::from(&frame[6..])` in `handle_client_binary` | `websocket.rs` | Zero-copy slice to Arc for spawn_blocking |
| Batch Vec stores `(u8, Arc<[u8]>)` — no `full_report` alloc | `websocket.rs` | report_id prepended in `create_batch_frame` |
| Adaptive WS flush (100μs coalescing) | `websocket.rs` | 0 latency for sparse, ≤100μs for bursts |
| Binary WS protocol (not JSON) | `websocket.rs` + `worker.js` | No JSON overhead on data plane |
| SAB ring buffer for input reports | `worker.js` + `polyfill.js` | Zero-copy W→P via `Atomics.notify` |
| Fire-and-forget resolves after `window.postMessage` (not worker ack) | `polyfill.js` | Page latency <0.1ms for both WS and NM |
| Thread-local buffers in daemon | `hid.rs` (`WRITE_BUF`, `READ_BUF`) | Avoids per-call allocation |
| DataPlane mode per device | `device_mgr.rs` | Events only sent to requested channel (NM or WS) |
| Tab-targeted event delivery | `background.js` | Eliminates N× `tabs.sendMessage` |
| ArrayBuffer transfer (P→B, B→W, W→B, B→P) | `polyfill.js`, `bridge.js`, `worker.js` | Zero-copy realm hops for binary data |
| Base64 for NM binary data | `types.rs` (`base64_serde`) | ~40–55% smaller than number-array |

---

## 8. Key Findings

1. **Fire-and-forget page latency is now <0.1ms for both WS and NM** — polyfill resolves immediately after `window.postMessage`, no callback/ack wait. End-to-end latency (page → hidraw) differs: WS 3–8ms, NM 8–20ms.

2. **WS data plane is faster end-to-end** for sendReport (3–8ms vs 8–20ms) and input reports (1–5ms vs 8–18ms) due to binary WS + SAB vs JSON+base64+NM pipe.

3. **NM data plane has fewer hops from page perspective** (no worker spawn, no SAB setup) — lower setup latency, simpler plumbing.

4. **`receiveFeatureReport` is the most expensive hot-path operation**: 10 copies (WS) / 16 copies (NM) due to full roundtrip + response-side serialization.

5. **SAB drain allocates per report** (`polyfill.js`): `new Uint8Array(subarray)` per input report at 8kHz = 8000 allocs/s. Dispatch DataView optimization (zero-copy) is possible but requires careful lifecycle management.

6. **Control plane (enumerate/open/close) is inherently slow** (~15–40ms) due to `runtime.sendMessage` overhead × 2 + NM JSON roundtrip.

7. **Adaptive batching keeps latency low for sparse reports** while amortizing syscalls during bursts — 1kHz devices see 0μs added, 8kHz bursts coalesce 2–4 reports per frame with ≤100μs.

8. **Daemon no longer broadcasts to both channels** — `dataplane_mode` per device ensures events go only to the requested channel (NM or WS), eliminating duplicate delivery.
