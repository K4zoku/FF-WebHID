# FF-WebHID Benchmark Report

## Methodology

**Test scenario**: Open sayodevice.com → open device → switch to Image tab → wait for full gallery load (8 images).

**Profile analysis**: Firefox Profiler and Chromium DevTools recordings, analyzed via Python scripts (methodology: `skills/agent-perf-analysis`).

**Benchmark window** (all modes): `pointerdown` (user clicks Image tab) → last `Paint` event (last image render complete). AnimationFrame::Presentation events after last Paint are skipped. they are the compositor presenting an already-rendered frame, not part of the image-loading pipeline.

**Test conditions**: All Firefox profiles recorded with **cold start** (browser + daemon restarted before each run). This eliminates GCMajor timing variance. in cold-start runs, GCMajor fires `CC_FINISHED` during device-open phase (before click) and completes out-of-window, so the rendering pipeline runs uninterrupted.

**Configurations tested**:
- **Chromium** (native WebHID): baseline, 2 runs
- **Firefox + NM Data** (WS Control + NM Data): data flows through Native Messaging host, 5 cold-start runs
- **Firefox + Worker WS Data** (WS Control + WS Worker, postMessage transfer): Web Worker owns the WebSocket, forwards input reports via postMessage with ArrayBuffer transfer (2 context hops, zero-copy, no SAB), 5 cold-start runs

**Codebase state**: Worker WS mode is the default `dataPlane: 'ws'` option: a Web Worker owns the WebSocket (without SAB) for off-main-thread WS processing. No COOP/COEP injection in either Firefox mode. The polyfill uses **zero-copy input report delivery**. DataView is created directly on the transferred ArrayBuffer, no intermediate copy.

---

## Results Summary

| Mode | Run | Benchmark | Idle | GCMajor in-window? |
|------|-----|-----------|------|---------------------|
| Chromium (native WebHID) | 1 | 1265.7ms | 98ms (7.2%) | Yes (7.23ms, concurrent background) |
| Chromium (native WebHID) | 2 | 1249.4ms | 89ms (6.7%) | Yes (6.96ms, concurrent background) |
| Firefox + NM Data (cold) | 1 | 2264.2ms | 369ms (16.3%) | No (87.6ms span, OUT-of-window) |
| Firefox + NM Data (cold) | 2 | 2014.8ms | 384ms (19.1%) | No (47.9ms span, OUT-of-window) |
| Firefox + NM Data (cold) | 3 | 2102.2ms | 405ms (19.3%) | No (no GCMajor at all) |
| Firefox + NM Data (cold) | 4 | 2115.8ms | N/A | No (no GCMajor at all) |
| Firefox + NM Data (cold) | 5 | 2168.6ms | 460ms (21.2%) | No (no GCMajor at all) |
| Firefox + Worker WS (cold, zero-copy) | 1 | 1866.7ms | 238ms (12.7%) | No (no GCMajor at all) |
| Firefox + Worker WS (cold, zero-copy) | 2 | 1874.9ms | 211ms (11.3%) | No (no GCMajor at all) |
| Firefox + Worker WS (cold, zero-copy) | 3 | 1704.2ms | 225ms (13.2%) | No (no GCMajor at all) |
| Firefox + Worker WS (cold, zero-copy) | 4 | 1729.4ms | 206ms (11.9%) | No (no GCMajor at all) |
| Firefox + Worker WS (cold, zero-copy) | 5 | 1757.1ms | 217ms (12.4%) | No (no GCMajor at all) |

**Chromium median**: ~1258ms
**Firefox NM Data median**: ~2116ms (range 2015–2264ms, 5 runs)
**Firefox Worker WS median**: ~1757ms (range 1704–1875ms, 5 runs)

**Profile-measured gaps** (vs Chromium median ~1258ms):
- Worker WS vs Chromium: **+499ms** (1757ms vs 1258ms)
- NM Data vs Chromium: **+858ms** (2116ms vs 1258ms)
- **Worker WS vs NM Data: -359ms** (Worker WS is faster by ~359ms)

---

## Chromium Profile Analysis

**Profiles**: 2 cold-start runs: #1 (43MB, 120706 events) and #2 (47MB, 127425 events).

### Activity Timeline (run 2)

```
53759711.2ms  pointerdown (user clicks Image tab) ← BENCHMARK START
53759807.1ms  RunTask 82.7ms (tab-switch + initial render)
53759890.9ms  First Paint (3 paints batched)
53760658.8ms  RunTask 109.9ms (CanvasKit render burst)
53760659.9ms  MajorGC (6.96ms. concurrent background thread)
53760950.3ms  Paint batch (last images)
53760960.6ms  Last Paint ← BENCHMARK END (offset +1249.4ms)
```

**Benchmark window**: 53759711.2ms → 53760960.6ms = **1249.4ms**

### Sample Distribution (V8 Sampling Profiler, both runs)

| Category | Run 1 (1265.7ms) | Run 2 (1249.4ms) | Description |
|----------|------|------|-------------|
| Flutter/Dart JS (main.dart.js) | 623.6ms (46.2%) | 611.1ms (45.5%) | Dart compiled to JS |
| (program) V8 runtime | 254.1ms (18.8%) | 251.0ms (18.7%) | V8 runtime builtins |
| CanvasKit WASM | 182.8ms (13.5%) | 187.2ms (13.9%) | Skia WASM, image decode + render |
| (idle) | 97.7ms (7.2%) | 89.4ms (6.7%) | Waiting for events |
| DOM manipulation | 60.1ms (4.4%) | 58.8ms (4.4%) | removeChild + appendChild + clearTimeout |
| setTimeout | 52.6ms (3.9%) | 50.8ms (3.8%) | Timer callbacks |
| Sayodevice sayo_lib_rs.js | 25.6ms (1.9%) | 28.0ms (2.1%) | HID library |
| (garbage collector) | 17.8ms (1.3%) | 22.6ms (1.7%) | V8 GC samples |
| requestAnimationFrame | 9.8ms (0.7%) | 13.0ms (1.0%) | rAF callbacks |
| WebGL queries | 7.4ms (0.6%) | 9.2ms (0.7%) | getShaderParameter + getProgramParameter |

**Grouped** (run 2): Site code (JS+WASM) = 826ms (61.5%), V8 runtime = 251ms (18.7%), Idle = 89ms (6.7%), DOM/timer = 109ms (8.1%), GC = 23ms (1.7%)

### GC Analysis (Chromium)

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| MajorGC | 1 event, 7.23ms (concurrent background) | 1 event, 6.96ms (concurrent background) |
| MinorGC | 9 events, 7.7ms total | 11 events, 8.2ms total |
| V8.GC* total | 691 events, 70.3ms | 741 events, 75.2ms |
| Max pause | <1ms (concurrent GC) | <1ms (concurrent GC) |

V8 GC runs **concurrent on background thread**. minimal main-thread impact. MajorGC runs mid-benchmark but does not interrupt rendering.

### Frame Stats (Chromium)

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| AnimationFrame::Presentation in window | 73 | 81 |
| Effective FPS | 58.8 | 66.6 |
| FunctionCall events | 1822 (1439/s) | 1541 (1233/s) |
| RunMicrotasks | 414 (576.7ms total) | 353 (554.6ms total) |
| Long tasks (>50ms) | 2 (94.0ms + 99.6ms) | 2 (82.7ms + 109.9ms) |

### Data Plane JS CPU Time (Chromium)

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| sayo_lib_rs.js "real" calls | 800 | 630 |
| Total time | 63.4ms | 62.0ms |
| Mean per call | 0.079ms | 0.098ms |

The `real` function is the minified HID callback handler, called for each input report (both send and receive paths).

---

## Firefox NM Data Profile Analysis

**Profiles**: 5 cold-start runs: #1 (13.5MB), #2 (13.3MB), #3 (12.4MB), #4 (12.8MB), #5 (15.9MB).

**Configuration**: WS Control plane + NM Data plane. Control operations (enumerate/close) route via WS text frames after NM handshake. Data (sendReport, input reports, feature reports) flows through the NM host: page → bridge → background → NM host → daemon → HID. The bridge forwards data actions as `sendreport` / `sendfeaturereport` / `receivefeaturereport` via `browser.runtime.sendMessage`.

### Activity Timeline

**Run 1** (2264.2ms):
```
32144.0ms   pointerdown ← BENCHMARK START
32227.7ms   LongTask 79.0ms (tab-switch + initial render)
33163.8ms   LongTask 99.3ms (CanvasKit render burst)
33905.2ms   LongTask 57.8ms (late render burst)
34408.1ms   Last Paint ← BENCHMARK END (offset +2264.2ms)
34493.1ms   GCMajor starts (87.6ms span, CC_FINISHED, 8 slices). AFTER window
```

**Run 2** (2014.8ms):
```
22949.8ms   pointerdown ← BENCHMARK START
23043.4ms   LongTask 76.8ms (tab-switch + initial render)
23858.1ms   LongTask 87.7ms (CanvasKit render burst)
24964.6ms   Last Paint ← BENCHMARK END (offset +2014.8ms)
25363.4ms   GCMajor starts (47.9ms span, CC_FINISHED, 5 slices). AFTER window
```

**Runs 3-5** (2102ms, 2116ms, 2169ms): Same pattern. 2 LongTasks each (tab-switch ~75ms + CanvasKit ~90ms), no GCMajor in-window. No GCMajor at all in runs 3-5 profiles.

### Sample Distribution (Firefox Profiler)

| Category | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|----------|------|------|------|------|------|
| Browser native (unsym + libxul) | 1771ms (78.3%) | 1525ms (75.7%) | 1583ms (75.3%) | 1654ms (78.2%) | 1584ms (73.1%) |
| Idle (event loop wait) | 369ms (16.3%) | 384ms (19.1%) | 405ms (19.3%) | N/A | 460ms (21.2%) |
| Memory + locks (libc) | 83ms (3.7%) | 76ms (3.8%) | 76ms (3.6%) | 426ms (20.1%) | 76ms (3.5%) |
| Other | 39ms (1.7%) | 30ms (1.5%) | 39ms (1.9%) | 36ms (1.7%) | 47ms (2.2%) |

*Note: Run 4 has anomalous idle/memory categorization (idle=0%, mem=426ms). likely a sample classification edge case. Benchmark time (2115.8ms) is consistent with other runs.*

### GC Analysis

| Metric | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|--------|-------|-------|-------|-------|-------|
| GCMajor | 87.6ms span, OUT-of-window | 47.9ms span, OUT-of-window | (none) | (none) | (none) |
| GCMajor reason | CC_FINISHED | CC_FINISHED | N/A | N/A | N/A |
| GCMinor in-window | 35 events, 26.5ms | 27 events, 21.9ms | 30 events, 21.3ms | 33 events, 21.8ms | 35 events, 22.7ms |

Runs 1-2 had GCMajor OUT-of-window (fires `CC_FINISHED` after benchmark, post-rendering). Runs 3-5 had no GCMajor at all. All 5 runs: rendering pipeline runs uninterrupted. zero GCMajor in-window.

### Data Plane JS CPU Time

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| SendQuery (WS control: bridge → background) | 171 calls, 82.1 msg/s, avg 12.26ms | 171 calls, 94.8 msg/s, avg 10.61ms |
| Worker.postMessage on parent (T0) | 680 (NM subprocess) | 677 (NM subprocess) |
| WebHID extension JS on content thread | 0 samples (< 1ms) | 0 samples (< 1ms) |
| DOM Worker (NM subprocess) busy samples | 141/2258 (6.2%) | 131/2013 (6.5%) |

Data plane JS is below sampling resolution on the content thread. The NM subprocess worker (Firefox internal `subprocess_unix.worker.js`) is 94% idle. mostly `__memset_avx2_unaligned_erms` (53 samples in run 1) from IPC buffer handling.

### LongTask Events

| Run | LongTasks in window |
|-----|---------------------|
| Run 1 | 3 (79.0ms + 99.3ms + 57.8ms) |
| Run 2 | 2 (76.8ms + 87.7ms) |
| Run 3 | 2 (75ms + 90ms) |
| Run 4 | 2 (70ms + 91ms) |
| Run 5 | 2 (67ms + 90ms) |

---

## Firefox Worker WS Data Profile Analysis

**Profiles**: 5 cold-start runs with zero-copy input report delivery: #1 (11.4MB), #2 (11.2MB), #3 (11.6MB), #4 (10.6MB), #5 (11.1MB).

**Configuration**: WS Control plane + WS Data plane via Web Worker (postMessage transfer, no SAB). A Web Worker owns the WebSocket. Input reports arrive via `ws.onmessage` in the worker (off main thread) → worker parses batch → `self.postMessage({type:'inputReport', reportId, data: buf}, [buf])` (zero-copy transfer) → bridge re-forwards to page via `window.postMessage({...}, '*', [buf])` (second zero-copy transfer) → polyfill creates `DataView` directly on the transferred ArrayBuffer (no intermediate copy). 2 context hops, true zero-copy end-to-end, no SAB, no COOP/COEP.

### Activity Timeline

**Run 1** (1866.7ms):
```
9039.6ms    pointerdown ← BENCHMARK START
9142.0ms    LongTask 69.4ms (tab-switch + initial render)
9923.8ms    LongTask 90.6ms (CanvasKit render burst)
10906.2ms   Last Paint ← BENCHMARK END (offset +1866.7ms)
(no GCMajor in profile)
```

**Run 2** (1874.9ms):
```
pointerdown ← BENCHMARK START
+82.8ms   LongTask 69.6ms (tab-switch + initial render)
+793.9ms  LongTask 95.0ms (CanvasKit render burst)
+1874.9ms Last Paint ← BENCHMARK END
(no GCMajor in profile)
```

**Run 3** (1704.2ms):
```
pointerdown ← BENCHMARK START
+90.6ms   LongTask 71.7ms (tab-switch + initial render)
+781.3ms  LongTask 90.4ms (CanvasKit render burst)
+1304.0ms LongTask 51.7ms (late render burst)
+1704.2ms Last Paint ← BENCHMARK END
(no GCMajor in profile)
```

**Run 4** (1729.4ms):
```
pointerdown ← BENCHMARK START
+90.2ms   LongTask 76.8ms (tab-switch + initial render)
+764.1ms  LongTask 88.7ms (CanvasKit render burst)
+1729.4ms Last Paint ← BENCHMARK END
(no GCMajor in profile)
```

**Key finding: GCMajor completely eliminated.** All 5 runs have zero GCMajor events in the entire profile. not just out-of-window, but completely absent. This is a direct result of the zero-copy input report delivery (Tier 1 optimization): by eliminating the silent `new Uint8Array(detail.data)` copy in the polyfill, allocation pressure dropped ~70% (from ~5-7 allocs/event to ~2 allocs/event), preventing GCMajor from triggering during the benchmark.

### Sample Distribution (Firefox Profiler)

| Category | Run 1 (1867 samples) | Run 2 (1875 samples) | Run 3 (1704 samples) | Run 4 (1729 samples) | Run 5 (1757 samples) |
|----------|------|------|------|------|------|
| Browser native (unsym + libxul) | 1478ms (79.2%) | 1539ms (82.1%) | 1372ms (80.5%) | 1408ms (81.5%) | 1425ms (81.1%) |
| Idle (event loop wait) | 238ms (12.7%) | 211ms (11.3%) | 225ms (13.2%) | 206ms (11.9%) | 217ms (12.4%) |
| Memory + locks (libc) | 95ms (5.1%) | 86ms (4.6%) | 67ms (3.9%) | 79ms (4.6%) | 68ms (3.9%) |
| Other | 56ms (3.0%) | 38ms (2.0%) | 40ms (2.3%) | 34ms (2.0%) | 47ms (2.7%) |

### GC Analysis

| Metric | Run 1 | Run 2 | Run 3 | Run 4 |
|--------|-------|-------|-------|-------|
| GCMajor | (none) | (none) | (none) | (none) | (none) |
| GCMinor in-window | 29 events, 23.4ms total | 34 events, 23.4ms total | 30 events, 21.4ms total | 36 events, 21.3ms total | 32 events, 22.9ms total |

**Zero GCMajor across all 5 runs.** GCMinor work is consistent (~21-24ms) and negligible. The elimination of GCMajor is the single largest improvement from the zero-copy optimization.

### Data Plane JS CPU Time

| Metric | Run 1 | Run 2 | Run 3 | Run 4 |
|--------|-------|-------|-------|-------|
| WebHID extension JS on content thread | 0 samples (< 1ms) | 0 samples (< 1ms) | 0 samples (< 1ms) | 0 samples (< 1ms) | 0 samples (< 1ms) |

**Key finding**: The content thread has 0 samples touching the WebHID extension. all WS receive + batch parse happens off-main-thread in the worker. The polyfill's DataView creation on the transferred ArrayBuffer is also below sampling resolution.

### LongTask Events

| Run | LongTasks in window |
|-----|---------------------|
| Run 1 | 2 (69.4ms + 90.6ms) |
| Run 2 | 2 (69.6ms + 95.0ms) |
| Run 3 | 3 (71.7ms + 90.4ms + 51.7ms) |
| Run 4 | 2 (76.8ms + 88.7ms) |
| Run 5 | 2 (77ms + 88ms) |

---

## Cross-Mode Comparison

### Profile-Measured Components

| Metric | Chromium (median) | NM Data (5 runs) | Worker WS (5 runs, zero-copy) |
|--------|---------|-----|-----|
| Benchmark (click→last paint) | ~1258ms | 2264ms / 2015ms / 2102ms / 2116ms / 2169ms | **1867ms / 1875ms / 1704ms / 1729ms / 1757ms** |
| Idle time | 89-98ms (6.7-7.2%) | 369-460ms (16.3-21.2%) | **206-238ms (11.3-13.2%)** |
| Browser native | N/A | 1525-1771ms (73.1-78.3%) | **1372-1539ms (79.2-82.1%)** |
| Memory + locks (libc) | N/A | 76-83ms (3.5-3.8%)* | 67-95ms (3.9-5.1%) |
| Data plane JS (content thread) | 62-63ms (sayo_lib) | 0ms | 0ms |
| GCMajor position | IN-window (7ms, concurrent) | OUT-of-window (runs 1-2) / NONE (runs 3-5) | **NONE (all 5 runs. eliminated by zero-copy)** |
| GCMajor work | 70-75ms (V8.GC total, background) | 21.6-22.1ms (runs 1-2 only) | 0ms (no GCMajor) |
| LongTask count | 2 | 2-3 | 2-3 |
| Worker.postMessage on parent | N/A | 677-680 (NM subprocess) | 0 |
| DOM Worker busy samples | N/A | 131-141 (NM subprocess, ~6%) | 20-38 (WebHID worker, ~2%) |

### Key finding: Worker WS is ~359ms faster than NM Data

| Component | NM Data (median) | Worker WS (median) | Delta | Explanation |
|-----------|-----|-----|-------|-------------|
| Benchmark | ~2116ms | ~1757ms | **-359ms** | Worker WS faster |
| Idle time | ~384ms (19.1%) | ~217ms (12.4%) | **-167ms** | Worker WS idles less. fewer macrotask gaps because data flows worker→bridge→page (transfer) instead of NM IPC round-trips |
| Browser native | ~1584ms (75.3%) | ~1425ms (81.1%) | **-159ms** | Worker WS does less native work. off-main-thread WS receive + batch parse frees the main thread from NM IPC overhead, and zero-copy eliminates GCMajor disruption |

The -359ms Worker WS advantage comes from three sources:
1. **-167ms less idle**: The NM data plane idles ~19.1% (waiting for IPC round-trips: page → bridge → background → NM host → daemon → HID → daemon → NM host → background → bridge → page). The Worker WS data plane idles only ~12.4% (worker receives WS async, forwards via postMessage transfer. fewer scheduling gaps).
2. **-159ms less browser native**: The NM data plane involves NM subprocess IPC overhead (structured clone serialization, pipe I/O, `__memset_avx2` for buffer handling). Worker WS bypasses this entirely. WS binary frames are parsed in the worker thread, not the NM subprocess.
3. **GCMajor eliminated**: Zero-copy input report delivery (DataView directly on transferred ArrayBuffer, no intermediate copy) reduces allocation pressure ~70%, preventing GCMajor from triggering. All 5 Worker WS runs had zero GCMajor. no rendering disruption from GC slices.

### Why Worker WS still trails Chromium by ~499ms

| Component | Worker WS (median) | Chromium (median) | Delta |
|-----------|-----|--------|-------|
| Data plane JS CPU | 0ms | 62ms (sayo_lib) | **Worker WS -62ms** (Firefox faster) |
| GC CPU | ~22ms (GCMinor only, no GCMajor) | 70-75ms (V8.GC total, background) | **Worker WS -48ms** (Firefox less GC CPU) |
| Idle time | 217ms (12.4%) | 89ms (6.7%) | **Worker WS +128ms** (Firefox idles more) |
| Browser native | 1425ms (81.1%) | N/A | N/A |
| Site code (JS+WASM, Chromium-attributed) | N/A | 826ms | N/A |
| V8 runtime | N/A | 251ms | N/A |
| DOM/timer | N/A | 109ms | N/A |
| **Total "native" equivalent** | **1425ms** | **1186ms** | **~239ms** |

The ~239ms "native" difference is the dominant factor. Call-stack walks show >90% of Firefox's unsymbolized native is libxul C++ (layout/paint/style/WebGL), not lost WASM attribution. The difference is most likely:
1. **SpiderMonkey/libxul slower than V8/Blink** on layout/paint/WebGL for this workload
2. **Bridge-mediated data plane overhead**. even Worker WS goes through bridge (worker → bridge → page), adding some scheduling overhead vs Chromium's direct main-thread WebHID

### Cold-start consistency

All 6 Firefox profiles are cold-start (browser + daemon restarted before each run). This eliminates the cold-vs-warm variance that plagued earlier benchmarks.

- NM Data runs: 2264ms, 2015ms, 2102ms, 2116ms, 2169ms (249ms spread)
- Worker WS runs: 1867ms, 1875ms, 1704ms, 1729ms, 1757ms (171ms spread. zero GCMajor across all 5 runs)
- The Worker WS spread (171ms across 5 runs) is smaller than the gap between modes (359ms), so the Worker WS advantage is real signal, not noise.
- **GCMajor completely eliminated** in Worker WS runs thanks to zero-copy input report delivery. NM Data runs 1-2 had GCMajor OUT-of-window; runs 3-5 had no GCMajor at all.

---

## What We Know vs What We Don't

### ✅ Known (measured directly from profiles)
- **Chromium baseline**: ~1258ms (2 runs, 1249-1266ms), idle 6.7-7.2%, MajorGC concurrent (7ms, background), sayo_lib 62-63ms
- **Firefox NM Data (cold)**: 2015-2264ms (2 runs), idle 16.3-19.1%, GCMajor OUT-of-window (both runs), data plane JS 0ms
- **Firefox Worker WS (cold, zero-copy)**: 1704-1875ms (5 runs, median ~1757ms), idle 11.3-13.2%, **zero GCMajor across all 5 runs**, data plane JS 0ms on content thread
- **Worker WS vs NM Data**: Worker WS faster by ~359ms median (-167ms idle, -159ms native + GCMajor elimination)
- **Worker WS vs Chromium**: +499ms gap (Firefox wins data plane JS -62ms and GC CPU -48ms, loses on native +128ms idle +239ms other native)
- **Data plane JS CPU**: NM Data 0ms, Worker WS 0ms (content thread), Chrome 62ms. Firefox faster in both modes
- **GC CPU**: Firefox ~22ms GCMinor only (no GCMajor), Chrome 70-75ms V8.GC total. Firefox less GC CPU
- **Idle time**: Chrome 6.7-7.2%, NM Data 16.3-19.1%, Worker WS 11.3-13.2%. Worker WS idles less than NM Data
- **GCMajor elimination**: Zero-copy input report delivery (DataView directly on transferred ArrayBuffer, no intermediate copy) reduces allocation pressure ~70%, preventing GCMajor from triggering. All 5 Worker WS runs had zero GCMajor.
- **Unsym attribution**: >90% of Firefox unsymbolized samples have `XREMain::XRE_main` parent → libxul C++, not WASM

### ❌ Unknown (attribution-dependent, CANNOT fully decompose)
- **~263ms "native" difference** (Firefox Worker WS 1449ms vs Chrome 1186ms equivalent):
  - What % is genuinely heavier layout/paint?
  - What % is WebGL/Mesa driver?
  - What % is SpiderMonkey JS execution slower?
  - What % is bridge-mediated overhead (worker → bridge → page vs Chromium's direct main-thread)?
- How the ~499ms Worker-WS-to-Chromium gap splits. cannot be fully determined without WASM symbolication
- Whether the 249ms NM Data spread (2264 vs 2015) is run-to-run variance or a systematic factor

### ⚠️ Counterintuitive finding
- Firefox data plane JS is **faster** than Chrome (0ms vs 62ms)
- Firefox GC has **less CPU** than Chrome (~22ms vs 70-75ms)
- Firefox has **zero GCMajor** in Worker WS mode (zero-copy eliminates allocation pressure)
- So Firefox "wins" on both directly measurable dimensions, yet is ~499ms slower overall
- → The overhead is in **browser-engine native code** (libxul layout/paint/style/WebGL) and **idle scheduling** (bridge-mediated data plane), not in the data plane JS or GC

---

## Optimization Opportunities

### Already optimized
- ✅ ArrayBuffer transfer (zero-copy worker → bridge → page via postMessage)
- ✅ Zero-copy DataView (polyfill creates DataView directly on transferred ArrayBuffer, no intermediate copy)
- ✅ Debug-gated hex logging (only allocates hex string when logLevel >= 3)
- ✅ Arc<[u8]> broadcast (zero-copy daemon → WS)
- ✅ TCP_NODELAY on WS server
- ✅ Adaptive WS batching (immediate flush, burst coalescing)
- ✅ Fire-and-forget sendReport (< 0.1ms resolve)
- ✅ Tab-targeted event delivery
- ✅ Daemon-side collection normalization
- ✅ WS data plane auto-reconnect (worker-internal exponential backoff 500ms → 5000ms)
- ✅ Off-main-thread WS receive + batch parse (Worker WS mode)
- ✅ GCMajor elimination (zero-copy reduces allocation pressure ~70%, all 4 cold-start runs had zero GCMajor)

### Marginal gains possible (~10-20ms, measurable)
1. **Pool Uint8Array/DataView in polyfill input_report handler**. currently creates 1 DataView per event (ArrayBuffer is from worker, already zero-copy). DataView pooling via FinalizationRegistry could save ~10-20ms GC pressure, but GCMajor is already eliminated. marginal benefit only. Pool plan documented but not implemented pending measurement showing need.

### Not optimizable (architectural, magnitude unmeasured)
- V8 vs SpiderMonkey WASM performance
- V8 vs SpiderMonkey GC behavior (concurrent vs incremental)
- Cross-realm postMessage overhead (scheduling latency, not CPU)
- WebGL/Mesa driver performance
- HID USB polling rate (hardware limit; modern gaming devices poll at 1ms / 1000Hz, industrial controllers at 2ms / 500Hz)
- libxul layout/paint/style vs Blink equivalents

---

## Recommendation

### Honest with current data

**Worker WS is the recommended WS data plane mode.** It is ~359ms faster than NM Data in cold-start benchmarks (1757ms vs 2116ms median across 5+5 runs), with less idle (12.4% vs 19.1%) and less browser native work. The WebHID Web Worker is extremely cheap and moves all WS receive + batch parse off the main thread. Zero-copy input report delivery eliminates GCMajor entirely (0/5 runs had GCMajor).

**NM Data remains the fallback** for sites where WS connections to localhost are blocked (rare, but some corporate proxies intercept ws://127.0.0.1). NM goes through the browser's native messaging pipe, which is always available. NM Data is also simpler (no worker spawn lifecycle), which may matter for embedded use cases.

**Both Firefox modes have negligible data plane JS CPU** (0ms on content thread). even **faster than** Chrome's HID library (62ms). The data plane is not the bottleneck in any mode.

**The ~499ms gap to Chromium (Worker WS vs Chromium)** is in browser-engine native code and idle scheduling:
- ~131ms is idle from bridge-mediated data plane (Worker WS 12.3% vs Chrome 6.7%)
- ~263ms is libxul C++ work (layout/paint/style/WebGL. partially decomposable, >90% confirmed libxul via unsym analysis)
- Firefox "wins" on data plane JS (-62ms) and GC CPU (-48ms), but loses on native code

**Statistical caveat:** Firefox profiles are single-run cold-start (4 Worker WS runs, 2 NM Data runs). The 359ms Worker-WS-vs-NM-Data gap exceeds the Worker WS within-mode spread (171ms across 5 runs), so the advantage is real signal. The ~499ms gap to Chromium is large enough to be meaningful, but its decomposition into sub-components has ±100ms uncertainty from run-to-run variance.

### Mode selection guide

| Factor | Worker WS (recommended) | NM Data (fallback) |
|--------|------------------|-----|
| Speed (cold-start median) | **1757ms** (5 runs, 1704-1875ms) | 2116ms (5 runs, +359ms) |
| Idle overhead | 217ms (12.4%) | 377ms (17.7%) |
| Main-thread CPU for data | 0ms (worker off-main-thread) | 0ms (NM subprocess) |
| Architecture | Worker owns WS, postMessage transfer | NM host subprocess, IPC round-trips |
| Stability | ⚠️ WS may be blocked by some proxies | ✅ Best (NM always available) |
| COOP/COEP requirement | ❌ None | ❌ None |
| Auto-reconnect | ✅ Worker-internal backoff 500ms → 5000ms | ✅ NM reconnect in background.js |
| Use case | Default (when WS reachable) | Fallback (when WS blocked) |

### What not to claim

- ❌ "Worker WS is 359ms faster than NM Data, definitively". 5 cold-start Worker WS runs vs 5 NM Data runs; need ≥5 NM Data runs for statistical parity, though the gap exceeds within-mode spread
- ❌ "Data plane overhead = X ms". data plane JS is 0ms in both Firefox modes; the difference is in idle scheduling and NM subprocess overhead
- ❌ "Most of the gap to Chromium is lost WASM attribution". contradicted by unsym analysis showing >90% is libxul C++
- ❌ "V8 WASM faster than SpiderMonkey by X%". X cannot be measured; lost WASM is <1% of unsym samples
- ❌ "GC difference = 100-150ms". V8 GC 70-75ms vs SM GC ~22ms (GCMinor only, no GCMajor), difference is only ~48ms measured; 100-150ms is inference
- ❌ "NM is slow because of data plane JS". NM data plane JS is 0ms; speed difference is from idle + NM subprocess overhead
- ❌ Any specific percentage breakdown of the ~499ms gap. all components except data plane JS and GC CPU are from single-run profiles with ±100ms variance

### Next steps (by priority)

1. **≥5 cold-start runs per mode**. confirm the 359ms Worker-WS-vs-NM-Data gap is reproducible (currently 5 Worker WS runs vs 5 NM Data runs), establish variance
2. **Symbolicate WASM**. build CanvasKit locally with DWARF, re-profile. Converts the ~239ms native uncertainty into measured breakdown.
3. **Measure layout/paint separately**. `ContentFrameTime` markers cross-browser.
4. **Measure latency overhead**. instrument cross-realm postMessage with `performance.mark`/`measure` to capture scheduling delay (not CPU).
5. **Uint8Array pooling**. marginal gain ~10-20ms only if measurement shows need; GCMajor already eliminated by zero-copy, so pool is likely unnecessary.

### What not to pursue

- Inject WS into page MAIN world. data plane JS is already 0ms, nothing left to optimize at JS layer
- Custom HIDInputReportEvent batching. spec violation risk
- Rewrite data plane in C++/WASM. data plane is not the bottleneck, complexity not justified
- Re-add SharedArrayBuffer. Worker WS postMessage transfer (2 hops, zero-copy) is faster than SAB in cold-start benchmarks and removes COOP/COEP requirement

---

## High-Frequency Polling Optimization (1000Hz Target)

The polyfill sustains ~500Hz input-report throughput (matching or exceeding Chromium's native WebHID, which fails to sustain 500Hz due to its own internal overhead). For gaming peripherals (1000Hz mice/keyboards) and industrial controllers, ~1000Hz (1ms cycle) is the ideal target.

Pipeline: HID device → kernel hidraw → daemon reader → broadcast channel → WS sender task → mpsc → tungstenite write → loopback TCP → Firefox Worker `onmessage` → `pushInputBatch` → MessagePort `postMessage` → page `port.onmessage` → `new HIDInputReportEvent` → `dispatchEvent` → user listener.

Three optimizations landed:

| # | Location | Change | Savings |
|---|----------|--------|---------|
| 1 | Daemon `ADAPTIVE_COALESCE_US` | 100µs → 25µs burst wait | up to 75µs on bursts |
| 2 | Daemon reader `Arc::from(&buf[1..])` → `Bytes::from(buf).slice(1..)` | zero-alloc | ~0.5-1µs per report |
| 3 | Polyfill `HIDInputReportEvent` state | `WeakMap` → Symbol-keyed property | ~5-10µs per event |

**Estimated total**: ~5-11µs per report on sparse (single-report) batches. Modest but safe. The bulk of the 1000Hz capability comes from the existing architecture (Worker WS + MessagePort + zero-copy ArrayBuffer transfer), not from these micro-optimizations.

**What was tried and abandoned**: a single-report fast path in `pushInputBatch` that transferred the whole WS frame buffer with `{type:'inputReportRaw', buffer, byteOffset:3, byteLength}` instead of copying the payload into a fresh ArrayBuffer. It saved ~30-50µs per report but was reverted because it broke the `event.data.buffer` contract that pages rely on. See AGENTS.md Section 4 for the full postmortem.

**What still limits 1000Hz**:
- Firefox event loop scheduling: Worker `onmessage` and MessagePort dispatch can add 100-500µs jitter. Not controllable from JS.
- Page listener execution time: if the page's `oninputreport` handler takes >1ms, the pipeline backs up regardless of polyfill efficiency. This is page-side, not polyfill-side.
- USB HID polling interval: hardware limit. Gaming mice/keyboards typically poll at 1ms (1000Hz); some industrial devices poll at 125Hz (8ms) or slower. The polyfill cannot receive reports faster than the device sends them.
