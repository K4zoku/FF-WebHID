# Data Path Analysis

> Codebase: `6cec6bd` - control plane WS + data plane switcher + early fire-and-forget

---

## 1. Execution Contexts

| # | Context | Process | Realm | Files |
|---|---------|---------|-------|-------|
| P | Page MAIN world | Firefox content (tab) | Isolated (page) | `polyfill.js` |
| B | Content script | Firefox content (tab) | Isolated (addon) | `bridge.js` |
| W | Web Worker | Firefox content (worker thread) | Worker | `worker.js` |
| G | Background script | Firefox background | Extension | `background.js` |
| N | NM host process | OS process | -- | `webhid.forwarder_nm_host` or daemon NM-host mode |
| D | Daemon process | OS process | -- | `webhid-daemon` |

---

## 2. Cost Model

| Operation | Copy cost | Hop cost | Est. latency |
|-----------|-----------|----------|--------------|
| `postMessage` same-process (P↔B, B↔W) | 1 structured clone (~5–15 μs for typed array) | 1 realm switch | 5–15 μs |
| `postMessage` with transfer list | 0 (buffer ownership moved) | 1 realm switch | 3–8 μs |
| `runtime.sendMessage` (B↔G) | 1 clone + IPC marshal | 1 process boundary | 50–200 μs |
| `connectNative.postMessage` (G→N) | 1 JSON serialize + pipe write | 1 process spawn/pipe | 30–100 μs |
| Unix socket write+read (N↔D, loopback) | 2 kernel copies | 1 process boundary | 5–15 μs |
| WebSocket send+recv (W↔D or B↔D, TCP loopback) | 1 WS encode + 2 kernel copies | 1 process boundary | 10–30 μs |
| WS text frame (JSON control) | 1 JSON serialize/parse | 1 process boundary | 10–30 μs |
| `JSON.stringify`/`parse` (small obj) | 1 alloc | -- | 1–5 μs |
| base64 encode/decode (64 B) | 1 alloc (+33% size) | -- | 0.5–2 μs |
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
| L | `enumerate` | Control=NM | P→B→G→NM→D→hidapi→NM→G→B→P |
| L2 | `enumerate` | Control=WS | P→B→WS(text)→D→hidapi→WS(text)→B→P |
| M | `open` | Always NM | P→B→G→NM→D→hidapi→NM→G→B→P + worker/WS setup |
| N | `close` | Control=NM | P→B→G→NM→D→NM→G→B→P + worker terminate |
| N2 | `close` | Control=WS | P→B→WS(text)→D→WS(text)→B→P + worker terminate |
| O | `requestDevice` | -- | P→B (picker UI) → enumerate → user select → B→P |
| P | `getDevices` | -- | P→B→G→storage + enumerate (or cache hit) |
| Q | `handshake` (NM) | -- | B→G→NM→D→NM→G→B (returns control_token + ws_port) |
| R | `connect`/`disconnect` event | -- | D→NM→G→B→P (tab-targeted) |

---

## 4. Detailed Path Analysis

### Path A - `sendReport` WS fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` -- own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `worker.postMessage(wMsg, transfer)` → B→W | 0 (transfer) | 1 |
| 4 | `worker.js` | `frame = new Uint8Array(6+len); frame.set(payload,6)` | 1 (alloc+copy) | 0 |
| 5 | `worker.js` | `ws.send(frame)` → W→D | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `websocket.rs` | `Arc::from(&frame[6..])` → `spawn_blocking` | 0 (Arc) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend_from_slice(&payload)` | 1 (copy) | 0 |
| 8 | `hid.rs` | `dev.write(&buf)` → hidraw | 1 (kernel) | 1 |
| **Total** | | | **6** | **5** |

**Page-side latency**: **<0.1ms** -- resolves immediately after `window.postMessage`, no callback wait.

**End-to-end latency**: **3–8ms**.

---

### Path C - `sendReport` NM fire-and-forget

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `view.slice()` -- own-buffer copy | 1 | 0 |
| 2 | `polyfill.js` | `sendFireAndForget()` → `window.postMessage(transfer)` → P→B | 0 (transfer) | 1 |
| 3 | `bridge.js` | `browser.runtime.sendMessage(msg)` → B→G (async, not awaited) | 1 (clone+IPC) | 1 |
| 4 | `background.js` | `base64Encode(data)` → `port.postMessage` → G→N | 1 (b64) + 1 (JSON) | 1 |
| 5 | NM host | `read_frame` → `write_vectored` → socket → D | 2 (kernel) | 1 |
| 6 | `client.rs` | `read_message` → JSON parse → base64 decode → `spawn_blocking` | 1 (JSON) + 1 (b64) | 1 |
| 7 | `hid.rs` | `WRITE_BUF.extend` → `dev.write` | 1 (copy) + 1 (kernel) | 1 |
| **Total** | | | **11** | **6** |

**Page-side latency**: **<0.1ms**.

**End-to-end latency**: **8–20ms**.

---

### Path I - Input report WS + SAB (adaptive batching)

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `device_mgr.rs` | `dev.read_timeout` → `Arc::from(&buf[1..])` | 1 (kernel) + 0 (Arc) | 1 |
| 2 | `device_mgr.rs` | `tx.send(IpcResponse::InputReport{data: Arc})` → broadcast | 0 (Arc move) | 1 |
| 3 | `websocket.rs` | `event_rx.recv()` → `batch.push((report_id, data))` | 0 (Arc clone) | 0 |
| 4 | `websocket.rs` | `create_batch_frame` -- prepend report_id + extend data | 1 (alloc+N×copy) | 0 |
| 5 | `websocket.rs` | `ws_sender.send` → D→W | 1 (WS encode) + 1 (kernel TCP) | 1 |
| 6 | `worker.js` | `new Uint8Array(frame)` → SAB slot write | 1 (kernel→JS) + 1 (copy) | 0 |
| 7 | `worker.js` | `Atomics.store + Atomics.notify` | 0 | 1 (wake) |
| 8 | `polyfill.js` | `Atomics.waitAsync` resolves → drain → copy | 1 (alloc+copy per report) | 1 (wake) |
| **Total (1 report)** | | | **8** | **5** |

| Polling rate | Est. latency | Added latency |
|-------------|-------------|---------------|
| 1 kHz (sparse) | 1–5 ms | 0 μs (immediate flush) |
| 8 kHz (burst) | 1.1–5.1 ms | ≤100 μs (coalescing) |

---

### Path K - Input report NM

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1–2 | daemon | Same as I steps 1–2 | 1 (kernel) + 0 (Arc) | 2 |
| 3 | `client.rs` | `ipc_event_to_nm` → `data.to_vec()` | 1 (clone) | 0 |
| 4 | `client.rs` | `write_message` → JSON + base64 | 1 (JSON) + 1 (b64) | 0 |
| 5–6 | NM host + Firefox NM | socket → stdout → JSON parse → clone → G | 2 (kernel) + 1 (parse) + 1 (clone) | 2 |
| 7 | `background.js` | `tabs.sendMessage` → G→B | 1 (clone+IPC) | 1 |
| 8 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| 9 | `polyfill.js` | `base64Decode(detail.data)` | 1 (decode) | 0 |
| **Total** | | | **12** | **7** |

**Latency**: **8–18 ms**.

---

### Path L2 - `enumerate` via WS control plane

| Step | Location | Operation | Copies | Hops |
|------|----------|-----------|--------|------|
| 1 | `polyfill.js` | `sendRequest("enumerate")` → P→B | 1 (clone, small obj) | 1 |
| 2 | `bridge.js` | `_sendControlWs("enumerate")` → WS text frame → B→D | 1 (JSON serialize) | 1 |
| 3 | `websocket.rs` | `handle_client_text` → `device_mgr.enumerate()` | 0 | 1 (hidapi) |
| 4 | `websocket.rs` | `ws_sender.send(Text(json))` → D→B | 1 (JSON serialize) + 1 (kernel) | 1 |
| 5 | `bridge.js` | `window.postMessage` → B→P | 1 (clone) | 1 |
| **Total** | | | **5** | **5** |

**Latency**: **5–15 ms** (WS roundtrip + hidapi scan, no NM pipe).

---

### Path M - `open` (always via NM)

| Phase | Copies | Hops | Est. latency |
|-------|--------|------|-------------|
| Request P→D (NM) | 5 | 4 | 2–5 ms |
| Daemon: hidapi open + reader thread | 0 | 1 | 5–15 ms |
| Response D→P (NM) | 6 | 4 | 2–5 ms |
| Worker spawn + WS connect + SAB (if WS data plane) | 1 | 2 | 5–15 ms |
| `setdataplane` → daemon | 2 | 2 | 1–3 ms |
| **Total** | **14** | **13** | **15–45 ms** |

---

### Path Q - `handshake` (NM, returns control token + WS port)

| Direction | Copies | Hops | Est. latency |
|-----------|--------|------|-------------|
| B→G→NM→D | 3 | 3 | 2–5 ms |
| D generates control_token | 0 | 0 | <0.1 ms |
| D→NM→G→B | 4 | 3 | 2–5 ms |
| **Total** | **7** | **6** | **5–10 ms** |

Bridge sends `handshake` on init, connects control WS immediately after.

---

## 5. Summary Table - Latency per Message Type

| Message | WS fire-and-forget | WS ack-wait | NM fire-and-forget | NM ack-wait |
|---------|-------------------|-------------|--------------------|----|
| `sendReport` (page-side) | **<0.1 ms** | **5–10 ms** | **<0.1 ms** | **8–20 ms** |
| `sendReport` (end-to-end) | 3–8 ms | 3–8 ms | 8–20 ms | 8–20 ms |
| `sendFeatureReport` (page-side) | **<0.1 ms** | **5–10 ms** | **<0.1 ms** | **8–20 ms** |
| `receiveFeatureReport` | -- | **6–12 ms** | -- | **15–30 ms** |
| Input report (delivery) | **1–5 ms** (SAB) / **2–6 ms** (postMessage) | -- | **8–18 ms** (NM) | -- |
| `enumerate` (Control=NM) | -- | -- | -- | **15–40 ms** |
| `enumerate` (Control=WS) | -- | **5–15 ms** | -- | -- |
| `close` (Control=NM) | -- | -- | -- | **10–20 ms** |
| `close` (Control=WS) | -- | **3–8 ms** | -- | -- |
| `open` (always NM) | -- | -- | -- | **15–45 ms** |
| `handshake` (NM) | -- | -- | -- | **5–10 ms** |
| `getDevices` (cache hit) | **<0.1 ms** | -- | **<0.1 ms** | -- |
| `getDevices` (cache miss) | -- | -- | -- | **15–40 ms** |

---

## 6. Copy + Hop Summary

| Path | Copies | Hops | Bottleneck |
|------|--------|------|------------|
| A: sendReport WS faf | 6 | 5 | TCP loopback + hidraw syscall |
| B: sendReport WS ack | 11 | 8 | WS roundtrip + worker→bridge→page |
| C: sendReport NM faf | 11 | 6 | runtime.sendMessage + JSON/base64 + NM pipe |
| D: sendReport NM ack | 19 | 10 | Full NM roundtrip + JSON + base64 |
| I: Input SAB | 8 | 5 | SAB drain alloc + broadcast |
| J: Input postMessage | 7 | 6 | Transfer eliminates 2 clones |
| K: Input NM | 12 | 7 | JSON + base64 + tabs.sendMessage |
| L: enumerate (NM) | 11 | 9 | hidapi scan |
| L2: enumerate (WS) | 5 | 5 | hidapi scan (no NM pipe) |
| M: open | 14 | 13 | hidapi open + worker spawn + WS + setdataplane |
| N: close (NM) | 10 | 10 | NM roundtrip |
| N2: close (WS) | 4 | 5 | WS text roundtrip |
| Q: handshake | 7 | 6 | NM roundtrip (one-time, on init) |

---

## 7. Key Findings

1. **Fire-and-forget page latency is <0.1ms for both WS and NM** -- polyfill resolves immediately after `window.postMessage`, no callback/ack wait.

2. **Control plane WS reduces enumerate/close latency** from 15–40ms (NM) to 5–15ms (WS text frame roundtrip, no NM pipe).

3. **Control token enables early WS connection** -- bridge sends `handshake` on init, gets control_token + ws_port, connects control WS before any device is opened.

4. **Open device tracking is independent of workers** -- `_openDevices` Set tracks all open devices regardless of data plane mode, fixing badge counter in NM mode.

5. **WS data plane is faster end-to-end** for sendReport (3–8ms vs 8–20ms) and input reports (1–5ms vs 8–18ms).

6. **Adaptive batching** keeps latency low for sparse reports (0μs) while amortizing syscalls during bursts (≤100μs).

7. **Daemon no longer broadcasts to both channels** -- `dataplane_mode` per device ensures events go only to the requested channel.
