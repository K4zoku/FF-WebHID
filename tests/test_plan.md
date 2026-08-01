# E2E Test Matrix: daemonAsNmHost Parity + Full API Surface + Settings + Documentation

## Context

The E2E suite (`tests/e2e/e2e.spec.ts`) only exercises the forwarder NM host path (daemon as separate process + `webhid-native-messaging` forwarder over Unix socket). Two gaps: (1) `daemonAsNmHost` mode (Firefox spawns the daemon binary directly as NM host, no forwarder, no Unix socket, WS on random port) has zero E2E coverage; (2) the suite covers a narrow API slice (requestDevice, open/close, sendReport, input report) and none of the 5 addon settings. This plan adds daemonAsNmHost E2E parity by running the same scenarios through both NM transport modes, extends the matrix to cover the full WebHID API surface and all settings set from background, and writes a `docs/TESTING.md` documenting the matrix.

## Approach

### Step 1: Feature-report descriptor fixture

No existing descriptor fixture has feature reports (0xB1 item). Add one to `scripts/gen-descriptors.mjs`:

- Add `featureData()` helper mirroring `inputData()`/`outputData()` but using item tag `0xB1` (Feature, Data, Variable, Absolute).
- Define a new descriptor builder `buildFeatureDevice()` that emits: Usage Page (0x05, Generic Desktop), Usage (0x09, 0x04 Joystick), Collection Application (0xA1), report ID 0x03, an input report (0x81), an output report (0x91), and a feature report (0xB1), then close collection.
- Add a CLI case `"feature-device"` that writes `tests/fixtures/descriptors/feature-device.bin`.
- Run `node scripts/gen-descriptors.mjs feature-device` to generate the bin.

`validateReportId` (`addon/js/content/main/index.js`) validates reportId is 0-255 and checks `deviceUsesReportIds` but does NOT validate against feature report existence in collections, so sendFeatureReport/receiveFeatureReport won't throw on validation alone. The descriptor is needed so the daemon parses and reports feature collections, making the test realistic.

### Step 2: Extend test-page.html `__webhidTest` API

`tests/test-page.html` exposes `window.__webhidTest` with methods the e2e specs call via `page.evaluate`. Add these methods to the `__webhidTest` object:

- `forget(deviceIndex)` — calls `devices[deviceIndex].forget()`, returns result.
- `sendFeatureReport(deviceIndex, reportId, data)` — calls `devices[deviceIndex].sendFeatureReport(reportId, new Uint8Array(data))`, returns `{ ok: true }` or `{ ok: false, error: e.name }`.
- `receiveFeatureReport(deviceIndex, reportId)` — calls `devices[deviceIndex].receiveFeatureReport(reportId)`, returns `{ ok: true, data: [...new Uint8Array(view)] }` or `{ ok: false, error: e.name }`.
- `getDeviceProperties(deviceIndex)` — returns `{ opened, vendorId, productId, productName, collections }` (collections serialized via `JSON.parse(JSON.stringify(collections))` to strip FrozenArray).
- `addEventListenerInputReport(deviceIndex)` — sets up `devices[deviceIndex].addEventListener('inputreport', handler)` that stores the last event; returns a function to retrieve stored events.
- `getOnInputReport(deviceIndex)` — returns last `oninputreport` event data `{ reportId, data: [...] }` or null.
- `addEventListenerConnect()` / `addEventListenerDisconnect()` — attaches `navigator.hid.addEventListener('connect'/'disconnect', ...)` storing events; returns retrieval function.
- `getOnConnect()` / `getOnDisconnect()` — returns last onconnect/ondisconnect event device info or null.
- `requestDeviceWithFilters(filters, exclusionFilters)` — calls `navigator.hid.requestDevice({ filters, exclusionFilters })`, returns device count or error.
- `getSettings()` — calls the bridge `getSettings` request via `postMessage` and returns the settings object. Reuse the existing `sendRequest` pattern in the test page.

Pattern to copy: the existing `__webhidTest` methods (requestDevice, getDevices, open, close, sendReport, receiveInputReport) in `test-page.html`. Each method wraps the polyfill call in try/catch and returns a serializable result object.

### Step 3: Extend e2e type helpers

In `tests/helpers/e2e-types.ts`, extend the `WebHidTestAPI` interface with the new method signatures matching Step 2. Each method takes parameters and returns a typed result object. The interface is what `createTestApi` in `e2e.ts` implements.

In `tests/helpers/e2e.ts`, extend `createTestApi` to expose each new method as a `page.evaluate` call to `window.__webhidTest.<method>(...)`. Copy the existing pattern: `async forget(i: number) { return page.evaluate((i) => window.__webhidTest.forget(i), i); }`.

### Step 4: daemonAsNmHost E2E infrastructure

**Goal**: run the same e2e scenarios through daemonAsNmHost mode (daemon spawned by Firefox as NM host, no forwarder, no separate daemon process, WS on random port).

**4a. Add daemon NM manifest installer to `tests/helpers/e2e-process.ts`**

Add two functions mirroring `installNmManifest`/`uninstallNmManifest` (lines 140-156):

```ts
export function installDaemonNmManifest(): void {
  const nmDir = join(homedir(), '.mozilla', 'native-messaging-hosts');
  mkdirSync(nmDir, { recursive: true });
  const manifest = {
    name: 'webhid.daemon_nm_host',
    description: 'WebHID daemon as NM host (e2e: debug daemon)',
    path: join(projectRoot, 'crates', 'target', 'debug', 'webhid-daemon'),
    type: 'stdio',
    allowed_extensions: ['webhid@k4zoku.dev'],
  };
  writeFileSync(join(nmDir, 'webhid.daemon_nm_host.json'), JSON.stringify(manifest, null, 2));
}

export function uninstallDaemonNmManifest(): void {
  const manifestPath = join(homedir(), '.mozilla', 'native-messaging-hosts', 'webhid.daemon_nm_host.json');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}
```

**4b. Refactor `tests/helpers/e2e.ts` to accept a `daemonAsNmHost` option**

Export a `createE2ETest(opts: { daemonAsNmHost?: boolean })` function that returns the extended `test` object. The existing `export const test = base.extend(...)` becomes `createE2ETest({})`. The fixtures gate on `opts.daemonAsNmHost`:

- `daemon` fixture (worker, auto): if `daemonAsNmHost`, skip `startDaemon()` (Firefox spawns the daemon via NM). Still call `stopDaemon()` in cleanup (it should be a no-op if the process was never started; verify `stopDaemon` handles this gracefully, if not add a guard).
- `nmManifest` fixture (worker, auto): if `daemonAsNmHost`, call `installDaemonNmManifest()` instead of `installNmManifest(DEFAULT_SOCKET)`. In cleanup, call `uninstallDaemonNmManifest()`.
- New `daemonAsNmHostSetting` fixture (worker, auto, depends on `backgroundPage`): if `daemonAsNmHost`, call `backgroundPage.evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))` before tests. The background `settings.on("daemonAsNmHost")` listener triggers NM host reconnection. This fixture must run before `sharedPage` navigates.

`e2e.spec.ts` uses `createE2ETest({})`. New `daemon-nm.spec.ts` uses `createE2ETest({ daemonAsNmHost: true })`.

**4c. Extract shared scenarios into `tests/e2e/scenarios.ts`**

Export `function runScenarios(test, expect)` that defines all test cases (the existing e2e.spec.ts tests + the new matrix from Step 5). Both `e2e.spec.ts` and `daemon-nm.spec.ts` call `runScenarios(test, expect)` with their respective fixture instances. This avoids duplicating test logic across the two NM modes.

**4d. Add Playwright project `firefox-e2e-daemon-nm`**

In `tests/playwright.config.ts`, add:

```ts
{
  name: 'firefox-e2e-daemon-nm',
  testDir: './e2e',
  testMatch: /daemon-nm\.spec\.ts/,
  use: { ...firefoxE2eUse },
}
```

Update the existing `firefox-e2e` project to exclude daemon-nm specs: add `testIgnore: /daemon-nm\.spec\.ts/`.

### Step 5: E2E test specs

All specs are defined in `scenarios.ts` and run in both forwarder and daemonAsNmHost modes via Step 4c.

**5a. API surface tests** (extend existing e2e.spec.ts coverage)

- `getDevices()` returns empty array before any requestDevice.
- `requestDevice({ filters: [{ vendorId: 0x16C0 }] })` returns 1 device with correct VID/PID.
- `requestDevice` with `exclusionFilters` that match the mock device returns 0 devices (user sees empty picker, cancels).
- `requestDevice` with invalid filter `{}` throws TypeError.
- `requestDevice` with `productId` without `vendorId` throws TypeError.
- `requestDevice` with `usage` without `usagePage` throws TypeError.
- `requestDevice` with empty `exclusionFilters` throws TypeError.
- Device properties: `opened === false` before open, `vendorId === 0x16C0`, `productId === 0x0001`, `productName` is a non-empty string, `collections` is a frozen array with `inputReports`/`outputReports` (and `featureReports` for feature-device fixture).
- `open()` twice throws InvalidStateError.
- `close()` returns undefined, sets `opened === false`.
- `sendReport()` before open throws InvalidStateError.
- `sendReport(0x01, new Uint8Array([1,2,3]))` after open resolves undefined; verify mock received output report via `waitForOutputReport`.
- `sendFeatureReport(0x03, new Uint8Array([1,2,3]))` after open resolves undefined (uses feature-device fixture).
- `receiveFeatureReport(0x03)` after open resolves with a DataView (mock returns empty data, so `byteLength === 0`).
- `forget()` after open resolves undefined; subsequent `sendReport` throws InvalidStateError.
- `HIDInputReportEvent` constructor: `new HIDInputReportEvent('inputreport', { device, reportId: 1, data: new DataView(new ArrayBuffer(2)) })` has correct `device`, `reportId`, `data`.
- `HIDConnectionEvent` constructor: `new HIDConnectionEvent('connect', { device })` has correct `device` and `type`.

**5b. Event tests**

- Input report via `oninputreport`: open device, `sendInput` to mock, verify `oninputreport` fires with correct `reportId` and `data` bytes.
- Input report via `addEventListener('inputreport', ...)`: same, verify addEventListener path works independently of `oninputreport`.
- Both `oninputreport` and `addEventListener` fire for the same report (not mutually exclusive).
- Connect event via hot-plug: with device already paired, `stopWebhidMock()` triggers `disconnect` event, `startWebhidMock()` triggers `connect` event. Verify via both `onconnect`/`ondisconnect` and `addEventListener`.
- `inputreport` event `data` does NOT contain report ID byte when device uses report IDs (B29 compliance).

Hot-plug lifecycle: the `webhidMock` fixture is worker-scoped auto. For hot-plug tests, call `stopWebhidMock()` (exported from `e2e-process.ts`) then `startWebhidMock()` within the test body. These are the same functions the fixture uses. Verify the mock descriptor path matches what was paired.

**5c. Settings tests** (forwarder mode only; daemonAsNmHost mode skips these since the transport is already daemon-as-NM)

Set settings via `backgroundPage.evaluate(() => browser.storage.local.set({...}))` using key format `settings :: ${name}` (global) or `settings :: ${origin} :: ${name}` (site-specific). The origin for the test page is `http://localhost:${httpPort}`.

- `dataPlane`: set to `"nm"` mid-session, verify `sendReport` still works (data plane switches from WS to NM). Set back to `"ws"`, verify still works. Assert no errors in either direction. A report may be duplicated or dropped during the switch instant; assert only that the switch completes and subsequent reports work.
- `logLevel`: set to `0`, `1`, `2`, `3`. Verify `getSettings()` returns the correct value. No observable behavior change beyond the setting value (log level affects console output which is not asserted in e2e).
- `daemonAsNmHost`: config-level only in forwarder mode. Set to `true`, verify `getSettings()` returns `true`. Do NOT verify full NM host switch (that would require manifest swap mid-session, out of scope). The daemonAsNmHost E2E project (Step 4) provides the real end-to-end coverage.
- `devicePickerMode`: set to `"modal"`, `"pageAction"`, `"window"`. For each, call `requestDevice` and verify the picker UI appears (keyboard-navigate via `grantDevicePermission` helper from `e2e-devices.ts`). The picker mode affects UI but the permission grant flow is the same Tab/Space/Enter sequence.
- `workerPolyfillEnabled`: set to `true` as a site-specific setting (`settings :: ${origin} :: workerPolyfillEnabled`). Verify a page-created Worker can access `navigator.hid`. Use the test page to create a Worker that accesses `navigator.hid` and reports back. Copy the pattern from `tests/browser/worker.spec.ts`. Also verify page scripts are left unmodified: navigate `sharedPage` to `http://localhost:${httpPort}/tests/pages/sri-check.html` and assert `window.sriTestRan === true` (the script executed). The page loads `./sri-test.js` with an SRI `integrity` attribute, so any modification of the response (the polyfill prefix) makes Firefox block the script and the assertion fails. On the pre-gating addon this assertion fails; with the Sec-Fetch-Dest gating it passes.

### Step 6: Documentation

Write `docs/TESTING.md` documenting:

- **Test layers**: (1) daemon unit tests (`cargo test`), (2) browser specs (Playwright, no daemon, tests class shapes/permissions-policy/worker-polyfill), (3) E2E specs (Playwright + daemon + webhid-mock, tests full API surface).
- **E2E modes**: forwarder mode (default, `firefox-e2e` project) and daemonAsNmHost mode (`firefox-e2e-daemon-nm` project). Explain the architectural difference: forwarder = daemon as separate process + forwarder NM host over Unix socket; daemonAsNmHost = Firefox spawns daemon binary directly as NM host, no socket, WS on random port.
- **How to run**: `cd tests && npm run test:e2e` (forwarder only), `npx playwright test --project=firefox-e2e-daemon-nm` (daemonAsNmHost only), `npx playwright test` (both). Prerequisites: debug binaries built, udev rule installed (Linux).
- **Test matrix table**: rows = API surface areas (getDevices, requestDevice+filters, open/close, sendReport, sendFeatureReport, receiveFeatureReport, forget, inputreport events, connect/disconnect events, device properties), columns = forwarder mode + daemonAsNmHost mode. Mark each cell with the spec file that covers it.
- **Settings test table**: each of the 5 settings, what's tested, and how it's set from background.
- **webhid-mock**: what it is, how it creates virtual HID devices, its commands (`input`, `destroy`, `ping`), and its limitations (GET_REPORT returns empty data, no feature report data generation).

Update `docs/DEVELOPMENT.md` Testing section (lines 118-159): add a reference to `docs/TESTING.md` and mention the `firefox-e2e-daemon-nm` project.

## Critical files & anchors

- `tests/helpers/e2e.ts` — `createTestApi` + fixture definitions (`daemon`, `nmManifest`, `webhidMock`, `sharedPage`, `testApi`). Refactor to `createE2ETest(opts)` for daemonAsNmHost gating.
- `tests/helpers/e2e-process.ts` — `installNmManifest`/`uninstallNmManifest` (lines 140-156) to mirror for `installDaemonNmManifest`/`uninstallDaemonNmManifest`. Also exports `startDaemon`/`stopDaemon`/`startWebhidMock`/`stopWebhidMock`/`sendInput`/`waitForOutputReport`.
- `tests/test-page.html` — `window.__webhidTest` object. Extend with new API methods (Step 2).
- `scripts/gen-descriptors.mjs` — `inputData()`/`outputData()` helpers to mirror for `featureData()`. Add `buildFeatureDevice()` + CLI case.
- `tests/playwright.config.ts` — two existing projects (`firefox-browser`, `firefox-e2e`). Add `firefox-e2e-daemon-nm`, update `firefox-e2e` to exclude daemon-nm specs.

## Verification

1. **Build**: `cargo build --manifest-path crates/Cargo.toml` (produces `webhid-daemon`, `webhid-native-messaging`, `webhid-mock`).
2. **Generate fixtures**: `node scripts/gen-descriptors.mjs feature-device` (creates `tests/fixtures/descriptors/feature-device.bin`).
3. **Forwarder E2E**: `cd tests && npm run test:e2e` — all forwarder-mode specs pass (existing + new matrix).
4. **daemonAsNmHost E2E**: `cd tests && npx playwright test --project=firefox-e2e-daemon-nm` — same scenarios pass through daemon-as-NM-host mode.
5. **Both modes**: `cd tests && npx playwright test` — all three projects pass.
6. **Specific new-behavior checks**:
   - Feature report: `sendFeatureReport(0x03, [1,2,3])` resolves undefined; `receiveFeatureReport(0x03)` resolves DataView.
   - daemonAsNmHost: `requestDevice` succeeds, `open` succeeds, `sendReport` succeeds, input report received. This proves the daemon-as-NM-host transport works end-to-end (Firefox spawns daemon, NM handshake, WS on random port, data plane functional).
   - Settings: `dataPlane` switch ws→nm mid-session, `sendReport` still works after switch.
   - Hot-plug: `stopWebhidMock` → disconnect event fires; `startWebhidMock` → connect event fires.
7. **Documentation**: `docs/TESTING.md` exists and documents the full matrix.

Prerequisites: Linux udev rule installed (`sudo make install-e2e-udev-rule`), user in `webhid` group (`newgrp webhid`), debug binaries built. macOS needs no setup.

## Assumptions & contingencies

- **daemonAsNmHost setting timing**: The `settings.on("daemonAsNmHost")` listener in the background script triggers NM host reconnection when the setting changes. If setting it via `backgroundPage.evaluate()` before page load doesn't take effect in time (addon already connected via forwarder), fallback: install ONLY the daemon NM manifest (not the forwarder manifest) and set `daemonAsNmHost: true` before the browser launches. The harness loads the addon fresh per worker, so the setting should be read on first NM connection.
- **`stopDaemon` when not started**: If `stopDaemon()` throws when the daemon was never started (daemonAsNmHost mode), add a guard: track whether `startDaemon()` was called and skip `stopDaemon()` if not. Check `e2e-process.ts` `stopDaemon` implementation; if it already handles missing process gracefully, no change needed.
- **Feature report mock returns empty data**: `webhid-mock` replies to UHID_GET_REPORT with empty data (err=0). `receiveFeatureReport` will return a DataView with `byteLength === 0`. This is sufficient for API surface coverage. If the mock is later extended to return actual data, the test should assert the returned bytes match.
- **Hot-plug test flakiness**: `stopWebhidMock`/`startWebhidMock` within a test may race with the daemon's udev hot-plug detection. If connect/disconnect events are flaky, add a `waitFor` poll (up to 5s) checking for the event. The daemon's udev monitor should detect the device within ~100ms.
- **`devicePickerMode` test**: All three modes use the same keyboard permission grant flow (`grantDevicePermission` from `e2e-devices.ts`). If `pageAction` or `window` mode requires different keyboard sequences, adjust the helper. The `modal` mode is the proven path.
- **daemonAsNmHost on macOS**: The daemon-as-NM-host mode works on macOS (no udev rule needed, `IOHIDUserDevice` works from regular user). The e2e-daemon-nm project should pass on macOS without additional setup. Windows is not tested in E2E (webhid-mock has no Windows implementation).
