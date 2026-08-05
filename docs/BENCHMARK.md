# FF-WebHID Benchmark Report

## Automated image-pipeline benchmark (2026-08)

A Playwright-driven end-to-end benchmark measuring the full data-plane
round-trip automatically across three modes: Firefox ws, Firefox nm and
Chromium native WebHID.

**Scenario**: a benchmark page fetches a small PNG fixture
(`tests/fixtures/images/sample.png`, the project icon, ~32KB), chunks it into
62-byte
payloads behind a 2-byte sequence header (64-byte `sendReport(1, chunk)` per
chunk, the vendor report size), and sends every chunk with ack-wait. A
**streaming relay** injects every output report the `uhid-mock` echoes
straight back through the mock's `input` command, so input reports flow to
the page while it is still sending instead of arriving in one burst at the
end. The image decode
(`createImageBitmap`) runs inside the measured window, and incoming chunks
trigger **batched row-slice repaints** (a few
pixel rows per paint, so the image fills in progressively), keeping rendering
a real part of
the measured window instead of a single ~6ms final decode. That makes CPU
contention between the data plane and page rendering (the ws-vs-nm gap)
visible in the numbers: if WS receive/parse on a dedicated
worker really stays off the main thread, the render-heavy load should not
slow ws as much as nm. The measured window is
`performance.measure('roundtrip', 'send-start', 'image-painted')`,
5 runs per mode, printed with open (open call through data-plane ready),
warm-up (total wall time from warm-up start until a retry succeeds, so
failed attempts are included) and total (page load through run #1's
send-start) durations. Then a per-run table where each run's ~520 reports
are summarized as min/p50/p90/p95/max of per-report round-trip latency
(send to the report arriving back) plus the run's walltime (whole-run
roundtrip), followed by a min/p50/p90/p95/max summary of the whole-run
round-trip durations.

**What the numbers mean**: the round-trip includes an artificial relay hop
(mock stdout → test script → mock stdin), because a real HID device does not
echo output reports as input reports. The relay adds a roughly constant term
to every run, so it does not skew the ws-vs-nm comparison, but the absolute
values are not comparable to hardware latency. The measured window also
includes the page's own send phase (sendReport is ack-wait, so the burst is
serialized) and image decode/render, so it is an end-to-end pipeline number,
not a transport-only number.

**Run**:

```
npm run test:benchmark
```

Standalone project, `daemonMode: 'daemon-nm'`, Firefox only. The ws, wt and nm
modes are separate specs (`benchmark-ws.spec.ts` / `benchmark-wt.spec.ts` /
`benchmark-nm.spec.ts`),
each running in its own worker, so each gets an identical cold start (fresh
Firefox, profile, daemon, grant) with no mid-session toggle. The project
disables `privacy.reduceTimerPrecision` (the harness Firefox otherwise
quantizes `performance.now()` to 1ms), so per-report latency timestamps are
true floats. The data plane is selected by writing `settings :: dataPlane`
(global + site-scoped) to storage before the benchmark page loads, so the
bridge handshakes with the target mode from the start instead of racing a
mid-session `storage.onChanged` update.

A separate **Chromium project** (`chromium-benchmark`) benchmarks native
WebHID (no addon, no daemon; the mock talks straight to `/dev/hidraw`). It
runs fully automated and headless: `npm run test:benchmark:chromium`. WebHID
cannot be granted via CDP (`Browser.grantPermissions` rejects `hid`;
`DeviceAccess` does not cover the WebHID chooser), so the mock is pre-granted
with the `WebHidAllowDevicesForUrls` policy and the benchmark page's own
`open()` (`getDevices()`-based) finds it without ever touching
`requestDevice`/the chooser. The policy matches origins including the port, so
the benchmark serves on the fixed port 8123 and the policy file must contain
exactly `http://localhost:8123` (see the spec header for the JSON and the
install path). Chromium coarsens
`performance.now()` to 100us with no flag to disable that clamp, so the
benchmark page is served cross-origin-isolated (COOP/COEP, `tests/serve.ts`)
to get 5us timestamps instead.

All modes run
one unmeasured warm-up (no painting; the page shows "Warming up..."), an
awaited 128-report priming burst so run #1 starts with a clear path,
then the measured runs (the
count is the `BENCHMARK_RUNS` env var, falling back to the project's
`benchmarkRuns` use option, default 5) with run-level retries (a dropped or
late report invalidates the run, it does not produce a bogus number). The
summary row reports min/p50/p90/p95/max (nearest-rank percentiles; with the
default 5 runs p90 and p95 collapse onto max).

## Input-report loss benchmark (8000Hz, render-saturated page)

The plain image-pipeline benchmark never drops reports (idle pages do not
exercise the loss path), so a dedicated suite (`tests/benchmark/loss/`,
project `firefox-benchmark-loss`, `npm run test:benchmark:loss`) measures
delivery loss at 8000Hz: 6000 reports per run
(`BENCHMARK_LOSS_RATE` / `BENCHMARK_LOSS_COUNT` overridable), across all four
data-plane variants (nm, ws, wt, wt-inpage), on a page whose main thread is
busy with a fixed per-frame compute + canvas load. Each run prints
received/lost/loss%/gaps/maxGap/firstGap. The rate-gated WS batching
(12 reports per 4ms window widens the coalesce to 8ms) exists because of this
measurement: before it, render-load loss ran 1.6-4.3% at 8000Hz; after, the
worst run is ~0.6%. See AGENTS.md for the design record.

---

## Automated benchmark results (2026-08-05, 10 runs per mode)

Fresh page per spec (a new tab is created and closed around each spec, so no
mode measures on a page carrying JIT/GC/canvas state from earlier ones; the
harness's default tab stays untouched). `BENCHMARK_RUNS=10`, all four Firefox
modes in one worker. Each mode opens the mock device cold, runs one warm-up
burst, then 10 measured runs; a dropped or late report invalidates a run and
it is retried. Chromium native numbers are from the 2026-08-02 dataset: the
addon code does not affect the native benchmark, so that baseline is
unchanged.

Init time per mode (open = device open through data-plane ready; warmup =
wall time of the warm-up; total = page load through run #1's send-start):

```mermaid
xychart
    title "Init time per mode (ms)"
    x-axis [nm, ws, wt-inpage, wt, native]
    y-axis "ms" 0 --> 350
    bar "open" [15.9, 25.6, 13.2, 34.5, 5.2]
    bar "warmup" [248.0, 132.0, 106.0, 134.0, 21.0]
    bar "total" [330.7, 208.1, 184.6, 211.5, 62.4]
```

Bar order in each group: open, warmup, total.

Per-run round-trip latency (p50) and whole-run walltime, for all 10 runs of
each mode, are charted below. Per-run percentiles, whole-run aggregates, and
the delta vs the native baseline are in the collapsible dataset section at
the end.

### Per-run charts

p50 round-trip latency per run, all modes:

```mermaid
---
config:
  themeVariables:
    xyChart:
      plotColorPalette: '#4d78dd, #ff9200, #00b359, #c7366c, #888888'
---
xychart
    title "Per-run p50 round-trip latency (ms)"
    x-axis "run" [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    y-axis "ms" 0 --> 2.6
    line "nm" [2.30, 2.12, 1.98, 1.86, 1.88, 2.02, 1.88, 1.86, 1.84, 1.66]
    line "ws" [1.16, 1.12, 1.14, 1.08, 1.08, 1.08, 1.08, 1.06, 1.04, 1.02]
    line "wt-inpage" [1.18, 1.10, 1.12, 1.08, 1.04, 1.04, 1.06, 1.04, 0.98, 1.02]
    line "wt" [1.06, 1.00, 0.96, 0.96, 0.96, 0.94, 0.92, 0.94, 0.96, 0.96]
    line "native" [0.36, 0.27, 0.24, 0.30, 0.27, 0.23, 0.23, 0.23, 0.25, 0.50]
```

Whole-run walltime per run, all modes:

```mermaid
---
config:
  themeVariables:
    xyChart:
      plotColorPalette: '#4d78dd, #ff9200, #00b359, #c7366c, #888888'
---
xychart
    title "Whole-run walltime (ms)"
    x-axis "run" [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    y-axis "ms" 0 --> 1200
    line "nm" [1059.5, 1005.4, 932.5, 868.0, 900.1, 1134.0, 897.9, 951.9, 882.2, 800.0]
    line "ws" [536.9, 516.5, 535.8, 499.8, 493.2, 535.9, 495.3, 498.2, 484.1, 481.1]
    line "wt-inpage" [486.2, 461.8, 467.9, 518.3, 436.6, 416.7, 446.3, 417.8, 402.0, 440.0]
    line "wt" [490.0, 452.9, 432.4, 453.0, 434.7, 421.3, 417.9, 433.3, 434.0, 448.5]
    line "native" [184.9, 108.2, 113.9, 114.1, 112.7, 116.0, 112.5, 114.3, 106.6, 168.0]
```

Line colors (both charts, in series order):

```mermaid
flowchart LR
    nm["nm"]:::m1 ~~~ ws["ws"]:::m2 ~~~ wtip["wt-inpage"]:::m3 ~~~ wt["wt"]:::m4 ~~~ nat["native"]:::m5
    classDef m1 fill:#4d78dd,stroke:#4d78dd,color:#fff
    classDef m2 fill:#ff9200,stroke:#ff9200,color:#fff
    classDef m3 fill:#00b359,stroke:#00b359,color:#fff
    classDef m4 fill:#c7366c,stroke:#c7366c,color:#fff
    classDef m5 fill:#888888,stroke:#888888,color:#fff
```

Per-report round-trip latency (ms):

```mermaid
radar-beta
  title Per-report latency by mode
  axis p50["p50"], p90["p90"], p95["p95"], mx["max"]
  curve nm["nm"]{1.88, 2.47, 2.73, 9.29}
  curve ws["ws"]{1.08, 1.52, 1.77, 5.74}
  curve wtip["wt-inpage"]{1.06, 1.39, 1.56, 5.38}
  curve wt["wt"]{0.96, 1.20, 1.36, 4.97}
  curve nat["native"]{0.26, 0.87, 1.56, 4.27}
  graticule polygon
  max 10
  min 0
```

Whole-run walltime (ms):

```mermaid
radar-beta
  title Whole-run walltime by mode
  axis p50["p50"], p90["p90"], p95["p95"], mx["max"]
  curve nm["nm"]{932.5, 1134.0, 1134.0, 1134.0}
  curve ws["ws"]{499.8, 536.9, 536.9, 536.9}
  curve wtip["wt-inpage"]{446.3, 518.3, 518.3, 518.3}
  curve wt["wt"]{434.7, 490.0, 490.0, 490.0}
  curve nat["native"]{113.8, 167.9, 184.8, 184.8}
  graticule polygon
  max 1200
  min 0
```

<details>
<summary>Dataset (init time, per-run min/p50/p90/p95/max latency + walltime, aggregates, delta vs native)</summary>

**Init time** (open/warmup/total, ms)

| mode      | open (ms) | warmup (ms) | total (ms) |
| --------- | --------- | ----------- | ---------- |
| nm        | 15.9      | 248.0       | 330.7      |
| ws        | 25.6      | 132.0       | 208.1      |
| wt-inpage | 13.2      | 106.0       | 184.6      |
| wt        | 34.5      | 134.0       | 211.5      |
| native    | 5.2       | 21.0        | 62.4       |

**nm** (Firefox, daemon-nm deployment)

| run | min  | p50  | p90  | p95  | max   | walltime |
| --- | ---- | ---- | ---- | ---- | ----- | -------- |
| #1  | 1.50 | 2.30 | 2.78 | 2.96 | 15.72 | 1059.5   |
| #2  | 1.42 | 2.12 | 2.72 | 3.08 | 11.32 | 1005.4   |
| #3  | 1.06 | 1.98 | 2.48 | 2.74 | 9.38  | 932.5    |
| #4  | 1.22 | 1.86 | 2.28 | 2.58 | 6.86  | 868.0    |
| #5  | 1.26 | 1.88 | 2.40 | 2.60 | 9.20  | 900.1    |
| #6  | 1.16 | 2.02 | 3.76 | 4.38 | 15.56 | 1134.0   |
| #7  | 1.20 | 1.88 | 2.46 | 2.72 | 8.06  | 897.9    |
| #8  | 1.18 | 1.86 | 2.80 | 3.46 | 11.16 | 951.9    |
| #9  | 1.10 | 1.84 | 2.36 | 2.64 | 8.76  | 882.2    |
| #10 | 1.02 | 1.66 | 2.12 | 2.36 | 9.08  | 800.0    |

**ws** (Firefox, daemon-nm deployment)

| run | min  | p50  | p90  | p95  | max   | walltime |
| --- | ---- | ---- | ---- | ---- | ----- | -------- |
| #1  | 0.68 | 1.16 | 1.54 | 1.78 | 6.46  | 536.9    |
| #2  | 0.64 | 1.12 | 1.54 | 1.76 | 4.76  | 516.5    |
| #3  | 0.74 | 1.14 | 1.62 | 1.94 | 6.32  | 535.8    |
| #4  | 0.68 | 1.08 | 1.52 | 1.80 | 4.56  | 499.8    |
| #5  | 0.68 | 1.08 | 1.52 | 1.86 | 4.40  | 493.2    |
| #6  | 0.64 | 1.08 | 1.58 | 1.84 | 14.08 | 535.9    |
| #7  | 0.62 | 1.08 | 1.40 | 1.64 | 7.38  | 495.3    |
| #8  | 0.70 | 1.06 | 1.46 | 1.60 | 4.28  | 498.2    |
| #9  | 0.64 | 1.04 | 1.36 | 1.62 | 5.50  | 484.1    |
| #10 | 0.68 | 1.02 | 1.34 | 1.60 | 5.98  | 481.1    |

**wt-inpage** (Firefox, daemon-nm deployment, WebTransport in-page)

| run | min  | p50  | p90  | p95  | max  | walltime |
| --- | ---- | ---- | ---- | ---- | ---- | -------- |
| #1  | 0.64 | 1.18 | 1.48 | 1.64 | 6.52 | 486.2    |
| #2  | 0.70 | 1.10 | 1.40 | 1.52 | 4.52 | 461.8    |
| #3  | 0.74 | 1.12 | 1.48 | 1.80 | 4.46 | 467.9    |
| #4  | 0.68 | 1.08 | 2.18 | 2.82 | 6.50 | 518.3    |
| #5  | 0.68 | 1.04 | 1.40 | 1.60 | 5.04 | 436.6    |
| #6  | 0.66 | 1.04 | 1.36 | 1.50 | 4.82 | 416.7    |
| #7  | 0.70 | 1.06 | 1.38 | 1.64 | 5.46 | 446.3    |
| #8  | 0.54 | 1.04 | 1.26 | 1.40 | 5.56 | 417.8    |
| #9  | 0.60 | 0.98 | 1.24 | 1.38 | 5.30 | 402.0    |
| #10 | 0.60 | 1.02 | 1.26 | 1.36 | 6.44 | 440.0    |

**wt** (Firefox, daemon-nm deployment, WebTransport over QUIC)

| run | min  | p50  | p90  | p95  | max  | walltime |
| --- | ---- | ---- | ---- | ---- | ---- | -------- |
| #1  | 0.72 | 1.06 | 1.40 | 1.68 | 4.30 | 490.0    |
| #2  | 0.70 | 1.00 | 1.22 | 1.44 | 4.08 | 452.9    |
| #3  | 0.66 | 0.96 | 1.18 | 1.28 | 4.28 | 432.4    |
| #4  | 0.64 | 0.96 | 1.24 | 1.40 | 5.26 | 453.0    |
| #5  | 0.66 | 0.96 | 1.24 | 1.40 | 6.22 | 434.7    |
| #6  | 0.60 | 0.94 | 1.18 | 1.30 | 4.24 | 421.3    |
| #7  | 0.58 | 0.92 | 1.16 | 1.28 | 4.68 | 417.9    |
| #8  | 0.64 | 0.94 | 1.18 | 1.32 | 5.54 | 433.3    |
| #9  | 0.60 | 0.96 | 1.18 | 1.32 | 6.32 | 434.0    |
| #10 | 0.58 | 0.96 | 1.24 | 1.40 | 6.28 | 448.5    |

**native** (Chromium, no addon, policy grant; 2026-08-02 dataset, unchanged)

| run | min  | p50  | p90  | p95  | max  | walltime |
| --- | ---- | ---- | ---- | ---- | ---- | -------- |
| #1  | 0.09 | 0.36 | 2.32 | 2.93 | 7.73 | 184.9    |
| #2  | 0.09 | 0.27 | 0.83 | 1.52 | 4.33 | 108.2    |
| #3  | 0.09 | 0.24 | 0.89 | 1.43 | 4.39 | 113.9    |
| #4  | 0.09 | 0.30 | 1.12 | 1.87 | 4.54 | 114.1    |
| #5  | 0.09 | 0.27 | 0.80 | 1.93 | 3.45 | 112.7    |
| #6  | 0.08 | 0.23 | 0.87 | 1.59 | 4.03 | 116.0    |
| #7  | 0.09 | 0.23 | 0.68 | 1.09 | 4.20 | 112.5    |
| #8  | 0.08 | 0.23 | 0.87 | 1.13 | 3.16 | 114.3    |
| #9  | 0.08 | 0.25 | 0.86 | 1.28 | 3.14 | 106.6    |
| #10 | 0.10 | 0.50 | 1.97 | 2.22 | 4.59 | 168.0    |

**Whole-run walltime summary** (10 runs each; native from 2026-08-02)

| mode      | runs | min   | p50   | p90    | p95    | max    | total  |
| --------- | ---- | ----- | ----- | ------ | ------ | ------ | ------ |
| nm        | 10   | 800.0 | 932.5 | 1134.0 | 1134.0 | 1134.0 | 9431.5 |
| ws        | 10   | 481.1 | 499.8 | 536.9  | 536.9  | 536.9  | 5076.8 |
| wt-inpage | 10   | 402.0 | 446.3 | 518.3  | 518.3  | 518.3  | 4493.6 |
| wt        | 10   | 417.9 | 434.7 | 490.0  | 490.0  | 490.0  | 4418.0 |
| native    | 10   | 106.6 | 113.8 | 167.9  | 184.8  | 184.8  | 1251.2 |

**Delta vs the native baseline** (per-report p50 is the median of the 10
per-run p50 values; walltime p50 and total as in the summary table; total is
the sum of the 10 whole-run walltimes)

| mode         | per-report p50 | vs native    | walltime p50 | vs native     | total  | vs native      |
| ------------ | -------------- | ------------ | ------------ | ------------- | ------ | -------------- |
| native       | 0.26           | —            | 113.8        | —             | 1251.2 | —              |
| wt (Firefox) | 0.96           | +0.70 (3.7x) | 434.7        | +320.9 (3.8x) | 4418.0 | +3166.8 (3.5x) |
| wt-inpage    | 1.06           | +0.80 (4.1x) | 446.3        | +332.5 (3.9x) | 4493.6 | +3242.4 (3.6x) |
| ws (Firefox) | 1.08           | +0.82 (4.2x) | 499.8        | +386.0 (4.4x) | 5076.8 | +3825.6 (4.1x) |
| nm (Firefox) | 1.88           | +1.62 (7.2x) | 932.5        | +818.7 (8.2x) | 9431.5 | +8180.3 (7.5x) |

</details>

Reading the numbers:

- **Per-report round-trip latency p50** (send to the report arriving back):
  native Chromium ~0.23-0.50ms, wt ~0.92-1.06ms, wt-inpage ~0.98-1.18ms, ws
  ~1.02-1.16ms, nm ~1.66-2.30ms.
- **Whole-run walltime p50**: native 114ms, wt 435ms, wt-inpage 446ms, ws
  500ms, nm 933ms. wt is now the fastest Firefox mode, ~13% under ws.
- **Total (sum of 10 runs)**: native 1.25s, wt 4.42s, wt-inpage 4.49s, ws
  5.08s, nm 9.43s. The total gap vs native (3.5x wt, 3.6x wt-inpage, 4.1x
  ws, 7.5x nm) mirrors the p50 gap, so the overhead is uniform across runs
  rather than concentrated in outliers.
- **Init time**: warm-up is unmeasured by design and ~100-250ms across
  modes; total (load to run #1 send-start) is 185-331ms. No first-burst
  retry anomaly this dataset (the 2026-08-02 wt run hit one: warmup 2.1s).
- These are not a polyfill-vs-native comparison: Firefox runs the polyfill
  over the daemon (daemon-nm deployment), Chromium runs native WebHID on the
  same mock; the engine, transport and grant path all differ. The
  polyfill-vs-native question still needs a same-engine testbed.

### What the wt numbers buy (and cost)

wt runs over one persistent bidirectional QUIC stream per session, with an
explicit `[len_u32 LE]` prefix on every frame (the batch format itself is not
self-delimiting, so a continuous stream needs the length header). WS is
untouched; the batch and control-response frame formats are the same in both
transports.

- Per-report round-trip p50 is **0.96ms vs ws 1.08ms and nm 1.88ms**: wt is
  ~11% faster than ws, not slower. The old +0.07ms TLS/QUIC cost measured on
  2026-08-02 is gone; the delivery-path difference now dominates.
- Whole-run walltime p50 is 435ms vs ws 500ms and nm 933ms; total (10 runs)
  4.42s vs ws 5.08s and nm 9.43s.
- Why wt beats ws: WS input reports cross the content main thread on their
  way to the worker (PWebSocket IPC into `RecvOnBinaryMessageAvailable`,
  then ChannelEventQueue into the worker), which contends with page
  rendering; wt reads reports from a DataPipe shared-memory buffer on the
  worker with zero WebSocket IPC. Profiler-verified 2026-08: the ws
  content-process main thread carries ~10.8k `OnBinaryMessageAvailable` and
  ~10.8k `FrameReceived` IPC markers per 3.5s spec plus 8k
  `ChannelEventQueue` enqueues, and 3.8x the main-thread IPC of wt; measured
  main-thread CPU ws 75% vs wt 57% in a full-suite run. wt-inpage sits
  between wt and ws: no delivery hops, but the DataPipe read happens on the
  main thread. The earlier "wt ≈ ws within noise" conclusion (2026-08-02)
  was measured on a suite that reused one page across specs; with a fresh
  page per spec the wt advantage is consistent.
- Open cost is unchanged (34.5ms vs ws 25.6ms; the QUIC+TLS handshake is
  inside the open window but does not add visible time at this scale).

What that buys, per the threat model in AGENTS.md: loopback TLS does not
stop a network MITM (there is no real network between daemon and browser);
it stops another local process from impersonating the daemon at
`127.0.0.1:<port>` without the private key (the `serverCertificateHashes`
pin is unforgeable without it), and does not stop an attacker with
admin/root. Measured against that, WT is a free security option on loopback
that is also the fastest Firefox data plane. The default `dataPlane`
flipped from ws to wt on 2026-08-05 (ws on Firefox < 114, where
WebTransport does not exist).

---

## Profiling benchmark runs (Gecko profiler via RDP)

Each benchmark spec can capture a Gecko profile of the run around the
measured window, driven over the harness's existing Remote Debugging Protocol
connection (the same `-start-debugger-server` port the harness uses to drive
the extension background). No browser flags are needed; the capture connects
a second RDP client to the perf actor and starts/stops the profiler around
`runBenchmark`.

```
BENCHMARK_PROFILE_DIR=/tmp/profiles npm run test:benchmark
```

With `BENCHMARK_PROFILE_DIR` set, each spec writes
`<dir>/profile-<mode>[-inpage].json` (plain JSON, Firefox Profiler schema;
also `loss-<mode>.json` for the loss project) and prints a `[profiler] saved
...` line with the sampled thread list. The capture adds ~1-4s per spec
(server-side gzip of the profile).

Tunables (all optional):

| Env                          | Default                                      | Meaning                           |
| ---------------------------- | -------------------------------------------- | --------------------------------- |
| `BENCHMARK_PROFILE_FEATURES` | `js,stackwalk,ipcmessages,cpu,cpuallthreads` | Comma-separated profiler features |
| `BENCHMARK_PROFILE_THREADS`  | `GeckoMain,Worker`                           | Comma-separated thread filters    |
| `BENCHMARK_PROFILE_ENTRIES`  | `268435456`                                  | Per-process buffer size in bytes  |
| `BENCHMARK_PROFILE_INTERVAL` | `1`                                          | Sampling interval in ms           |

Notes:

- The profile nests child processes under the top-level `processes` array
  (Firefox Profiler schema); the top-level `threads` are the parent only.
  The benchmark page's content process is the one whose `GeckoMain` shows
  `benchmark-image.html` frames, and it carries the data worker as a
  `DOM Worker`.
- Native frames are unsymbolicated in the Playwright Firefox build (raw
  addresses); JS and WASM frames carry names, and `threadCPUDelta`
  (feature `cpu`/`cpuallthreads`) plus the `eventDelay` sample column give
  per-thread busy ratios and event-loop queueing without symbols.
- The profiler adds sampling overhead, so profiled runs are for mechanism
  analysis, not for mode comparison numbers.
- 2026-08 finding (ws vs wt): the ws content-process main thread carries
  `Msg_OnBinaryMessageAvailable` / `Msg_FrameReceived` IPC markers
  (~10.8k each in a 3.5s spec) plus `ChannelEventQueue::Enqueue` markers,
  and 3.8x the main-thread IPC of wt; wt mode shows zero WebSocket IPC (the
  data arrives through a DataPipe shared-memory read on the worker). Measured
  main-thread CPU: ws 75% vs wt 57% in a full-suite run, matching the
  AGENTS.md delivery-gate mechanism.
