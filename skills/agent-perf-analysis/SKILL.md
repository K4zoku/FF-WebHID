---
name: agent-perf-analysis
slug: perf-analysis
version: 1.0.0
description: "Performance analysis methodology + Python helper for web-extension / browser-feature latency benchmarking. Captures click-to-paint measurement, multi-run median comparison, GCMajor detection across Firefox Profiler and Chromium DevTools exports."
changelog: Initial release. Distilled from FF-WebHID benchmark cycle.
metadata: {"clawdbot":{"emoji":"📊","requires":{"bins":["python3"]},"os":["linux","darwin","win32"]}}
---

# Agent Performance Analysis

End-to-end latency measurement for browser features (WebHID polyfill,
content-script IPC, worker data planes, etc.). Reusable methodology
plus a Python helper that parses both Firefox Profiler and Chromium
DevTools exports.

## When to Use

- **Click-to-paint latency** for a browser feature (not FPS).
- **Mode comparison** — e.g. WebSocket vs Native Messaging data plane,
  worker vs page, SAB vs postMessage transfer.
- **GC pressure investigation** — count `GCMajor` events per run when
  medians look suspicious.
- **Firefox-only features** that need a Chromium baseline on the same
  workload.

## Do NOT Use For

- FPS / animation benchmarks → use `requestAnimationFrame` histograms.
- Unit-test microbenchmarks → use `cargo bench` / `vitest bench`.
- Memory leak detection → use `--js-flags=--expose-gc` heap snapshots.

## Methodology (mandatory)

### 1. Cold-start controlled

Every run starts from a **cold browser state**:

1. Close the browser completely (kill all child processes).
2. Clear profile cache (Firefox: `rm -rf ~/.mozilla/firefox/*/cache2/*`;
   Chromium: launch with `--disk-cache-dir=/tmp/empty`).
3. Launch browser fresh.
4. Wait 3s for the addon/background to settle.
5. Navigate to test page, wait for `load` event.

Without cold-start the first run pays JIT + cache-miss tax that biases
the median by 200–500ms.

### 2. Click → last Paint as latency

The metric is **pointerdown → last Paint** in the click handler chain:

- `pointerdown` is the earliest user-intent timestamp (use
  `event.timeStamp` relative to `performance.timeOrigin`).
- "Last Paint" = the final `Paint` event in the trace whose timestamp
  is within 5000ms of `pointerdown` and is causally linked (same frame
  chain). For most interactive workloads this is the rendered result
  of the click.
- Do NOT use `click` event — it fires 50–100ms after `pointerdown` due
  to platform gesture detection.

### 3. Five runs per mode

5 is the sweet spot:

- 3 runs: noise dominates (a single GC pause shifts median by 15%).
- 5 runs: median is stable; one outlier is rejected by IQR.
- 10+ runs: diminishing returns; cold-start overhead makes the cycle
  expensive.

Always report **median**, not mean. HID/GC latency has a long right
tail that pulls the mean up by 10–20%.

### 4. Profile collection

| Browser | Tool | Export format |
|---------|------|---------------|
| Firefox | `about:performance` → "Record" → "Capture" → Save | `.json` (Firefox Profiler schema) |
| Chromium | DevTools → Performance → Record → Stop → Right-click → Save | `.json` (DevTools Timeline schema) |

Save exports as `<mode>/run-1.json` … `run-5.json` under a single
benchmark directory (the Python helper auto-detects format).

### 5. GCMajor detection

`GCMajor` events in Firefox Profiler show up as `Phase="MajorGC"` in
the `gc` marker stream. Each one blocks the main thread for 50–300ms
and will inflate your median. Count them per run; if mode A has 0/5
runs with GCMajor and mode B has 5/5, that's the smoking gun.

Common causes (FF-WebHID case study):

- **Silent copy in polyfill**: `new Uint8Array(receivedArrayBuffer)`
  creates a fresh allocation per input report → 60 allocs/sec → Major
  GC every ~3s. Fix: `new DataView(buffer, byteOffset, byteLength)`
  (zero-copy view, no allocation).
- **Xray unwrap overhead**: each `Cu.waiveXrays` + structured-clone
  across compartment boundary doubles alloc count. Fix: MessageChannel
  + `postMessage(.., [transfer])` to skip the clone.

## Python Helper

The standalone script `scripts/perf_analysis.py` parses both Firefox
Profiler and Chromium DevTools exports, then prints a per-mode summary
table (median, min, max, p90, GC count) plus deltas vs baseline.

### Usage

```bash
python3 scripts/perf_analysis.py <bench_dir>
```

### Directory layout (mandatory)

```
<bench_dir>/
    chromium/run-1.json ... run-5.json   # DevTools Performance exports
    <modeA>/run-1.json ... run-5.json    # Firefox Profiler exports
    <modeB>/run-1.json ... run-5.json    # Firefox Profiler exports
```

The first mode (alphabetical order) is treated as baseline for delta
calculations — name it `chromium` so it sorts first.

### Output

Stdout table:

```
mode            n   median      min     max     p90    gc
----------------------------------------------------------
chromium        5    1258.0ms  1249.4ms 1265.7ms 1264.5ms     2
nm-data         5    2116.0ms  2014.8ms 2264.2ms 2168.6ms     0
worker-ws       5    1757.0ms  1704.2ms 1874.9ms 1866.7ms     0

  chromium: gc_per_run = [1, 1, 0, 0, 0]
  nm-data:  gc_per_run = [0, 0, 0, 0, 0]
  worker-ws: gc_per_run = [0, 0, 0, 0, 0]

Δ vs chromium (median 1258.0ms):
  nm-data    +858.0ms (+68.2%)
  worker-ws  +499.0ms (+39.7%)
```

## Workflow

1. **Set up the bench directory** before recording:
   ```
   bench-2026-07-11/
     chromium/
     worker-ws/
     nm-data/
   ```
2. **Record 5 cold-start runs per mode** using the methodology above.
   Save each export as `run-1.json` … `run-5.json` under the mode dir.
3. **Run the helper**:
   ```bash
   python3 scripts/perf_analysis.py ./bench-2026-07-11
   ```
4. **Interpret the output**:
   - If `gc_total` differs across modes by ≥ 3 events, GC pressure is
     the dominant factor — profile allocations before claiming the
     transport itself is slow.
   - If `min_ms` is similar across modes but `median_ms` diverges, the
     tail is the problem (batching, coalescing, GC). Optimise the tail.
   - If `min_ms` itself diverges, the transport has a fixed per-call
     overhead (Xray unwrap, structured clone, IPC hop). Optimise the
     hot path.
5. **Document findings** in `docs/BENCHMARK.md` with:
   - Methodology section (cold-start, 5 runs, click-to-paint).
   - Results table (median, p90, GC count).
   - Per-mode delta vs baseline.
   - Root-cause analysis of any ≥ 100ms delta.
   - Reference this skill by name (`agent-perf-analysis`) instead of
     linking to profile files — exports are too large to keep in the
     repo.

## Anti-Patterns

- **Warm-start runs** — keeps the JS engine warm, hides JIT cost.
  Always cold-start.
- **Mean instead of median** — a single GC pause (200ms) in 5 runs
  shifts the mean by 40ms. Use median.
- **Click event instead of pointerdown** — adds 50–100ms of platform
  gesture detection to every measurement.
- **Recording too short** — 5s window is the minimum to catch the
  full paint chain after a click. Shorter windows drop the last paint.
- **Counting GCScavenger as GCMajor** — scavenger (minor GC) is
  5–10ms; only MajorGC blocks the main thread long enough to bias
  medians.
- **Comparing modes recorded on different days** — hardware clock
  drift, OS update, browser update all shift baselines by 5–15%.
  Record all modes in the same session.
- **Committing profile exports to the repo** — they are 10–50MB each
  and contain personal browsing data. Reference runs by number
  (`#1`, `#2`, …) in docs, keep the actual `.json` files local only.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | This file (methodology + workflow). |
| `scripts/perf_analysis.py` | Parser + summary table generator. |

## See Also

- Firefox Profiler schema: https://profiler.firefox.com/docs/
- Chromium DevTools Timeline model: https://developer.chrome.com/docs/devtools/performance/reference
