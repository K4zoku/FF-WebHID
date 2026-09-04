# Agent Guidelines for FF-WebHID

Before you act, read `CONTRIBUTING.md` for the project's design principles. They apply to you too.

## Terminology

- **FF**: Firefox, the project's target browser.
- **HID**: Human Interface Device (USB/Bluetooth input devices).
- **WS / WT / NM**: WebSocket / WebTransport / Native Messaging, the three data-plane transports of the `dataPlane` setting.
- **SAB**: SharedArrayBuffer (removed from the data plane in 2026-07, see below).
- **TLV**: Type-Length-Value, the binary wire format for packed NM messages and collections.
- **VID / PID**: Vendor ID / Product ID (USB device identifiers).
- **COOP / COEP**: Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy.
- **IPC**: Inter-Process Communication. **GC**: Garbage Collection.

## Architecture decisions

### Verify "ceilings" before accepting them

Bugs have repeatedly been mistaken for architectural ceilings. Check logs/behavior first. Past false ceilings (each cost a debug cycle):

- "Worker + SAB at the performance ceiling": Worker+SAB never engaged; everything silently fell back to NM.
- "SAB push must run on a Worker to avoid blocking via `Atomics.wait`": false after the drain moved to non-blocking `Atomics.waitAsync`; that mechanism was never in the flow.
- "SAB is zero-copy, so it must be fastest": false by half. SAB write is zero-copy but drain still copies once (`HIDInputReportEvent` needs exclusive ownership). The no-SAB path uses Transferable buffers for the worker-to-page handoff, but the worker parser first copies each report payload into an owned buffer.
- "Transfer the whole WS frame buffer instead of copying the payload" broke Chromium WebHID semantics: pages do `new Uint8Array(event.data.buffer)`, so `event.data.buffer.byteLength` must equal `event.data.byteLength` (`byteOffset === 0`). Reverted (saved ~30-50µs/report). Lesson: count copies and shape changes to the consumer; the `.buffer` contract is part of the journey.

### WS data plane runs in a dedicated Worker

Profiler-confirmed: WS receive/parse on the content main thread competes with page rendering (510 vs 681 msg/s late-phase under render load); NM is CPU-isolated (subprocess).

**Final WS architecture**: `daemon <-WS-> Worker (no SAB) <-MessageChannel port, transferred once at setup-> page`.

The worker owns the WS connection and posts each report directly to the page through the transferred port. The worker parser allocates an owned buffer for each report before that transfer, so "zero-copy" applies only to the worker-to-page handoff. The bridge is not on the steady-state report path. It creates and tears down the worker and handles setup, mode changes, and NM fallback.

There is no implemented worker-to-bridge-to-page relay fallback. A worker spawn or transport failure selects the NM path instead.

- Data plane switches mid-session (WS ↔ NM) via one control-plane command; a duplicated/dropped report in the switch instant is accepted as user-caused.

### SAB removed entirely (2026-07)

After the ring-buffer alloc bug was fixed, SAB lost to the simpler no-SAB path while carrying ongoing costs (COOP/COEP, Atomics/ring-buffer complexity). It was a necessary rung: it found the alloc bug and the CPU contention. Ring buffer detail: 8192 slots sized by an _estimated_ max report size was a 16MB init allocation; exact per-report size at parse time + 64 slots fixed it (later removed with SAB). Drain never needed >1 occupied slot, even at 8000Hz.

### Rate-gated WS batching (2026-08)

Under a render-saturated main thread, an earlier loss benchmark recorded WS losses of about 1.6-4.3% at high rates. The current rate-gated `run_sender` path in `crates/webhid-daemon/src/batching.rs` tracks reports flushed per 4ms window; at 12 reports per window it uses an 8ms coalesce window. Sparse traffic keeps the 25µs coalesce path. These are benchmark observations, not guarantees for every browser or workload. Knobs: `WEBHID_WS_HIGH_RATE_MS` (8), `WEBHID_WS_RATE_WINDOW_MS` (4), `WEBHID_WS_HIGH_RATE_COUNT` (12); fixed `WEBHID_WS_BATCH_MS` path also exists. Do not remove the rate gate without rerunning the dedicated 8000Hz render-saturated workload.

### Tradeoffs without a universally correct answer become settings

The `dataPlane` setting selects `wt`, `ws`, or `nm`. Daemon-backed control requests use the persistent Native Messaging Port, while browser-local and extension-page operations terminate in addon state. Native Messaging trust differs by deployment: direct daemon-as-host mode relies on the browser's Native Messaging host authorization and OS process boundary; the forwarder profile adds platform IPC checks. On Linux, the daemon checks a Unix-socket peer's `webhid` group and the forwarder accepts a root or same-UID daemon peer. These checks do not apply universally, and handshake/open are pre-session operations that do not carry a Session token. WS and WT report transports use a per-session derived authentication hash plus live Session authority. `wt` is preferred where the handshake offers it, `ws` is the alternate worker network path, and a missing WT port uses WS; failed worker setup or transport setup falls back to NM.

## Project facts

### Benchmarks

- The `open` metric of 38-58ms is a historical benchmark artifact, not a daemon-wide latency guarantee. That benchmark decomposed `open()` and a one-time first-WS-message cost; see [docs/BENCHMARK.md](docs/BENCHMARK.md) for the preserved dataset and methodology.
- Cold-start methodology: local sayodevice.com clone removes network variance; Playwright-driven runs remove click timing; Chromium grants are supplied by policy.
- Image-pipeline benchmark (`tests/benchmark/`, see [docs/BENCHMARK.md](docs/BENCHMARK.md)) uses a separate mock relay and retries invalidated runs. Do not extrapolate its burst behavior to normal device traffic.
- Benchmark chunking protocols differ per harness on purpose: the image pipeline chunks a 62-byte payload + 2-byte sequence (tests/pages/benchmark-image.html + benchmark-utils PAYLOAD), the loss harness uses a 63-byte payload + 3-byte sequence (loss-utils). The page-side decoders match their own harness; keep them in sync pairwise, not across harnesses.

- Hung-ack fix (2026-08): the data worker never settled in-flight send promises when WS dropped. `onClosed` rejects and clears `pending`; the page gets a fast `'ws closed'` rejection. Benchmark pitfalls: prime with an awaited 96-report burst, time-boxed per send (fire-and-forget inflates ws total ~2s; a single global gate falsely fails slow primes).

### Test harness traps

- e2e devices (`tests/helpers/e2e-devices.ts`, VID 0x16c0): vendor=0x0001 (report ID 1, 64-byte in/out; primary chain + feature reports; send-side rejects report types the descriptor does not declare, matching Chromium's `max_*_report_size() == 0` gates), gamepad=0x0002 (no report ID, 5-byte input; WS-data-plane-with-URL-fragment + fresh-pairing gates), mouse=0x0003, keyboard=0x0004. Lazy spawn, reused across the serial chain.
- `hidreport` rejects "Missing Usages for main item" when reportCount exceeds declared usages on a Data/Variable item; const items sidestep the check.
- Concurrent-run WS drop: running the e2e and forwarder configs concurrently occasionally drops a vendor input report because of WS CPU contention. Each config runs the E2E directory with `workers: 1` baked in; do not rely on a hardcoded test count.
- Firefox 154 applies LNA enforcement to WebSocket and WebTransport connections created in a worker. Worker-context networking is not categorically exempt. A WebSocket worker attempt can show the LNA permission UI, while WebTransport retries without showing an LNA prompt until permission has been granted. Granting LNA after a WS worker attempt can allow worker WT afterward. This is observed Firefox 154 behavior, not a stable browser contract. The test harness forces `network.lna.enabled: false`, so automated tests do not exercise that permission flow. Page-context WT remains unsuitable for normal use and cannot survive Juggler interception (`context.route('**/*')` → `SetupReplacementChannel` → `NS_ERROR_NOT_AVAILABLE`), so the bridge falls back to NM after 10s. Do not add a catch-all route in `tests/helpers/e2e.ts`.
- Browser-harness limitations: each Playwright page runs in its own Firefox window (a popup opened via `newPage()` never sees another page's tab as active in its window); visually hidden toggle inputs need `check({ force: true })`; `storage.local.get(null)` throws `EmptyDatabaseError` (keyed `get` works). These blocked a Playwright spec for the popup origin picker; it was verified manually.
- OS permissions: macOS needs Input Monitoring (TCC) granted manually; Windows none (`HidD_*`); Linux `udev`/`eudev` (Alpine `mdev`).

### Daemon deployment

Two deployment profiles must keep working: (1) a persistent daemon plus a thin NM-host forwarder over platform IPC, commonly a Unix socket or Windows named pipe, and (2) the daemon itself as the Native Messaging host, spawned by Firefox. A persistent daemon may be root or a user service; the required HID and IPC permissions depend on the platform and service account.

### Blocklist (verified 1:1 vs Chromium/WICG, 2026-08-03)

Two layers, always-on like Chromium:

1. Device-level (`hid.rs`): FIDO usage page 0xF1D0 + per-product security-key list (Chromium `kStaticEntries`); hidden from enumeration.
2. Report-level (`blocklist.rs`/`report_blocking.rs`): WICG `blocklist.txt` entry-for-entry (FIDO, GD Mouse/Keyboard/Keypad/SystemControl, Jabra, OnlyKey). Any-match per (report_id, type) over a report→collection map where each report carries every ancestor collection's usage (a Mouse report in a Physical child IS blocked); plus hardcoded always-protected usages (page 0x07; GD Pointer/Mouse/Keyboard/Keypad; GD SystemControl 0x80-0x8f, 0xa0-0xb6); plus an undocumented-report-ID fallback (blocks when the device has an always-protected top-level). Unparseable/empty descriptors fail closed: the device is hidden from enumeration and `open()` refuses it, since there is no collection tree to classify reports against (2026-08-20 audit fix; the `dump` subcommand still lists it with the parse error). Input dropped at the reader; output/feature rejected; sends pre-checked like Chromium's `HidConnection::Write` / `GetFeatureReport` / `SendFeatureReport` gates (a report type the descriptor does not declare, `max_*_report_size() == 0`, is rejected). Blocked reports pruned from page-visible `collections` (`prune_device_info`); all-empty devices hidden. SayoDevice config uses distinct report IDs, so only its keyboard report 1 is blocked. Keep fixtures off Mouse/Keyboard/Keypad usages if they must receive reports.

### Consent model (2026-08-06)

A page cannot grant itself a device or see the full inventory. `pairDevice`/`recordGrantGroup`/`getGrantGroups`/`getAllPairedDevices`/`revokeDevice`/`getDeviceCache`/`getDeviceInfo`/`showPicker`/`pickerResult` are blocked from page ports (`PAGE_BLOCKED_ACTIONS`, 403). Page `enumerate` is rewritten to `enumeratePaired`; the background filters the daemon inventory by the requesting origin's stored grants. Chooser and extension pages call unmodified `enumerate` for chooser data. Pairing runs in the bridge after chooser selection (`grantSelectedDevices`); `pickerResult` is accepted only from the extension picker page. Devices granted together form a grant group (IndexedDB `grantGroups`); revoking any member cascades to the group and closes that origin's daemon sessions.

### Permissions Policy trust (2026-08-09)

`hasAllowAttr` comes from the requesting port's source `Window` (engine-set `event.source`) matched against `iframe[allow*="hid"]`, cross-checked with the port's `event.origin`; the forwarded URL is that port origin, never a MAIN-world document URL. The MAIN-world `getCallerFrameUrl()` (stack parsing) was removed: `window.Error`/`location` are page-overridable in the MAIN world, letting a cross-origin iframe forge a sibling's `allow="hid"`. Regression: forge test in `tests/browser/permissions-policy.spec.ts`.

### Worker polyfill init (2026-08-09)

The worker polyfill creates its own bridge port; no page-side init decision. On load, the injected bundle (webRequest gate: global `workerPolyfillEnabled` or the per-site key for the WORKER SCRIPT's origin) snapshots `MessageChannel` (before page code can patch it), keeps one end as its bridge port, posts `null` + the other end to the page; `PatchedWorker`'s instance listener swallows that message and forwards the port via `workerPort`. Plain/blob/data workers never post, so never receive a spurious init message. It also wraps `navigator.permissions.query({name:'hid'})`. Shadow-URL interception: the MAIN world requests `armShadowSpawn` (tab+document keyed, one-shot, 3s TTL backstop, fail-open after 2s) before spawning the data worker from `new Worker(location.href)`; the webRequest handler serves the worker bundle only when armed, consumed on the real worker fetch. `shadowRedirectTargets` tracks redirect hops without the arm. The data bundle's `null`+port `'ready'` reply branch was removed; production workers spawn via `NativeWorker` in `handleSpawnWorkerRequest`, driven by `setPorts`, ready via `onReady`. Cross-origin worker scripts can't be exercised in the browser harness (network bridge re-serves without CORS headers). Regression: `tests/browser/worker.spec.ts`.

### Polyfill realm and MessagePort gotchas

The polyfill runs in the MAIN world and pre-claims pristine `MessagePort`/`MessageChannel`/`Worker.prototype.postMessage`/`window.postMessage` at document_start. Gotchas: (1) `addEventListener` does not implicitly start a `MessagePort`; call `start()` or responses never dispatch (30s sendRequest timeouts). (2) `window.postMessage` targets `this`; never bind it when an iframe polyfill posts to `window.top` (cross-origin iframe tests catch this). Regression: `tests/e2e/picker-bypass.spec.ts`.

Polyfill-polyfill port race (2026-07): same-origin iframes each run a polyfill; request IDs start at 0 and collide in the bridge's numeric `requestPortMap` (wrong-frame delivery). Fix: prefix with a per-polyfill `crypto.randomUUID()` nonce (`frameNonce + ':' + ++nextReqId`).

### NM wire format

Hot-path reports: packed binary TLVs (`PKG_SEND_REPORT` 0x02, `PKG_SEND_FEATURE_REPORT` 0x04, `PKG_INPUT_REPORT` 0x01) as base64 in one JSON field `{"d":"<b64>"}`. Collections: TLV module (`crates/webhid/src/collections_tlv.rs`, `[tag:u8][len:varint][value]`, unknown-tag skip; JS decoder `addon/js/utils/descriptor-tlv.js`). Compression rejected (CPU/alloc > savings at this size). NM has a real 1MB message ceiling (app→browser).

### CSP relaxation and MV3

MV2 may fully replace/strip a page's CSP ([bug 1635781](https://bugzilla.mozilla.org/show_bug.cgi?id=1635781)); MV3 is "strengthen only", always cumulative ([bug 1785821](https://bugzilla.mozilla.org/show_bug.cgi?id=1785821), header merging [bug 1462989](https://bugzilla.mozilla.org/show_bug.cgi?id=1462989)); no MV3 full-override permission exists ([bug 1787155](https://bugzilla.mozilla.org/show_bug.cgi?id=1787155), open). Default manifest is MV3: blob-URL workers + CSP rewriting cannot work there (only `manifest.v2.json`). Content scripts cannot spawn workers from `moz-extension://` URLs. When page CSP blocks the shadow worker, the only MV3 fallback is NM. The background does CSP pre-flight (`getCspInfo`) so the bridge skips doomed spawns.

### Popup origin picker (2026-08)

The popup's site label is a custom dropdown (no `<select>`) listing the active tab's top-level origin first, then distinct http(s) origins of frames running the polyfill. Origins come from the top-frame bridge's `portOrigin` map (engine-set `event.origin` per page port) via a `getFrameOrigins` message; frames that never run the polyfill (sandboxed without scripts, blob/data frames, CSP-blocked contexts) are absent. Selecting an origin re-runs settings load/save against that origin's `siteSettingKey` keys and re-renders devices/status. The popup re-resolves the active tab on `tabs.onActivated`; when it is itself open as a tab whose window's active tab is itself (dev/testing), it falls back to the active http(s) tab of any window (never in production: the action popup is not a tab).

### Exploratory branches (curiosity-driven, not benchmark-justified)

- **WT/QUIC data plane** (`dataPlane: "wt"`): the daemon WT server starts at boot, uses a self-signed certificate with SAN 127.0.0.1 and a default validity of 14 days, pins the certificate with `serverCertificateHashes`, authenticates with the URL path, and uses one persistent bidirectional stream with a `[len_u32 LE]` frame prefix. Certificate expiry rotates to a new port while existing sessions drain. In the current benchmark dataset, Firefox worker WT has a per-report p50 of 0.74ms versus WS at 0.94ms; this is a recorded benchmark result, not a universal performance guarantee. Covered by `tests/e2e/wt.spec.ts` and `tests/benchmark/benchmark-wt.spec.ts`.
- **Chromium native-WebHID benchmark** (`chromium-benchmark`, headless): mock pre-granted via `WebHidAllowDevicesForUrls` policy; fixed port 8123 (policy matches origins including port); `channel: 'chromium'` required (chrome-headless-shell has no udev/HID layer); never `--no-sandbox` (breaks udev). Finding: `vendor.bin`'s report ID 1 sat between two top-level collections, which Chromium's HID parser does not carry across; the ID now lives inside the vendor collection. Chromium p50 ~0.3-0.4ms; its `performance.now()` is clamped to 100µs, benchmark page uses COOP/COEP for 5µs precision.
- **Chromium testbed** (`chromium-testbed` branch): runs the addon itself on Chromium via `TARGET=chromium npm run build:addon` (unpacked `dist/chromium/`) to measure addon overhead vs native WebHID in the same runtime. Conventions:
  - Daemon `detect_nm_host_mode` also accepts Chrome's launch convention: one arg, the caller origin (`chrome-extension://<id>/`), instead of Firefox's manifest path + id. The tuple's first slot is only for logging.
  - Chrome for Testing (Playwright's `channel: 'chromium'`, v151, strace-verified) reads native messaging manifests from `<userDataDir>/NativeMessagingHosts/`, not `~/.config/*`. `tests/helpers/chromium-addon.ts` installs the daemon manifest there per test.
  - Chromium MV3 cannot share `globalThis` across multi-file script arrays (one SW file, content-script arrays), so the build bundles each world (background, MAIN, ISOLATED) into one file from the `addon/manifest.json` lists, prepending `js/utils/browser-shim.js` (`browser = chrome`) only where the chrome API exists (background SW and ISOLATED world, derived from each content script's `world` field; the MAIN world has no extension API (`browser.*` / `chrome.runtime`), so the alias would be useless there and is skipped). The shim is also injected into extension page HTMLs (they call `browser.*` and Chromium page realms have no `browser`). Firefox is unaffected (shim is a no-op; the chromium target skips web-ext).
  - `registerWebRequestHandlers` early-returns on the shared `isChromium` flag (exported from `js/utils/bootstrap.js`, post-alias URL-scheme check): MV3 webRequest is observational only. The gate disables the shadow-URL spawn, so blob is the only functional spawn mode on Chromium: `GLOBAL_DEFAULTS.workerSpawnMode` defaults to `'blob'` there, `resolveSpawnMode` forces blob, and the Worker Spawn Mode setting is hidden from the popup/settings UI. The pageAction picker mode is likewise not offered (no pageAction API; a saved `'pageAction'` value is coerced to modal at the bridge, and the background's `openPickerPageAction`, including its inactive-tab notification, is gated to Firefox). The benchmark page has no CSP, so ws/wt spawn their worker via the blob path. Without the gate the blocking listener registration throws and breaks boot.
  - The testbed exercises three production data planes, nm, ws, and worker wt, plus benchmark-only wt-inpage (`useWorker: false`). The in-page variant exists to compare page-main-thread transport handling and parsing against worker isolation; it is not a security downgrade and does not expose the daemon Session bearer token. Run it on its own: one early wt execution ran alongside other benchmarks and showed ~4.7ms p50, while sequential runs are stable at ~0.6ms.
  - Chromium does not render SVG extension icons; `addon/icons/*.png` are rasterized from the SVGs.
  - Chromium extension messaging uses structured clone via `"message_serialization": "structured_clone"` in `manifest.chromium.json` (Chrome 148+ per `minimum_chrome_version`); Firefox's extension messaging is always structured clone, so TypedArrays survive every extension-messaging hop on both engines with no boundary rebuild. Native messaging is always JSON regardless of the key; report payloads cross it as base64 strings, decoded/encoded at the daemon edge, so no TypedArray ever touches NM.
  - On Chromium, `dialog.showModal()` inside the closed picker shadow root does not move focus into it. Pairing focuses the dialog with a header click, waits for the item to render (the modal opens before the enumerate round trip finishes), then drives Tab/Enter (tab stops: item, item's radio, Cancel, Connect).

## Not every change needs a benchmark-driven justification

Some changes were made because they were interesting to try (binary-packed collections, WebTransport exploration). Don't retroactively invent a performance rationale; note it as such.

## Writing style: no em-dashes

Don't use em-dashes ("—") anywhere in this document or in any writing produced for this project. Rewrite with smoother sentence flow (subordinate clauses, "since"/"so"/"which", or splitting into two sentences), or fall back to a comma, colon, semicolon, or parentheses when a harder break is actually needed. Em-dash is a style tic to actively avoid, not just deprioritize.
