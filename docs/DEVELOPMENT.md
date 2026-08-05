# Development Guide

## Prerequisites

### Runtime

| Dependency   | Package (Arch)             | Why                     |
| ------------ | -------------------------- | ----------------------- |
| `libudev.so` | `systemd`                  | Daemon hot-plug (Linux) |
| `hidapi`     | built from source by cargo | HID device access       |

### Build

| Dependency        | Package (Arch)     | Why                                         |
| ----------------- | ------------------ | ------------------------------------------- |
| Rust ≥ 1.85       | `rustup` or `rust` | edition 2024                                |
| `libudev` headers | `systemd`          | `udev` crate links at build time            |
| `pkg-config`      | `pkgconf`          | hidapi build                                |
| `zip`             | `zip`              | Building addon XPI                          |
| Node.js ≥ 18      | `nodejs`           | Running Playwright tests, linter, formatter |

```sh
sudo pacman -S rust systemd pkgconf zip nodejs
```

## Building

```sh
# Debug
cargo build --manifest-path crates/Cargo.toml

# Release
make build                # or: make build CARGO_ARGS=--frozen

# Addon XPI (zips addon/, default MV3; use MV=2 for MV2)
npm run build:addon          # or: MV=2 npm run build:addon
```

`npm run build:addon` runs `scripts/build-addon.mjs`, which validates the manifest, copies it into `dist/addon/`, minifies each JS/CSS/HTML file per-file (terser, no bundling: files keep their own identity), and zips the XPI.

Binaries: `crates/target/{debug,release}/webhid-daemon`, `webhid-native-messaging`, and `webhid-mock` (Linux + macOS, test helper).

## Running for development

Two terminals:

### Terminal 1: daemon

```sh
# Option A: root (simplest)
sudo RUST_LOG=debug crates/target/debug/webhid-daemon

# Option B: udev rule (recommended)
sudo make install-udev-rule
RUST_LOG=debug crates/target/debug/webhid-daemon
```

Override socket path: `WEBHID_SOCKET=/tmp/webhid-dev.sock RUST_LOG=debug crates/target/debug/webhid-daemon`

### Terminal 2: browser

1. Load addon via `about:debugging → Load Temporary Add-on → addon/manifest.json`
2. Per-user NM manifest (if not installed system-wide):

```sh
mkdir -p ~/.mozilla/native-messaging-hosts
cat > ~/.mozilla/native-messaging-hosts/webhid.forwarder_nm_host.json << EOF
{
  "name": "webhid.forwarder_nm_host",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

For daemon-as-NM-host mode, point `path` to the daemon binary directly:

```sh
cat > ~/.mozilla/native-messaging-hosts/webhid.daemon_nm_host.json << EOF
{
  "name": "webhid.daemon_nm_host",
  "description": "WebHID daemon as native-messaging host",
  "path": "$(pwd)/crates/target/debug/webhid-daemon",
  "type": "stdio",
  "allowed_extensions": ["webhid@k4zoku.dev"]
}
EOF
```

Restart browser after writing these files. Paths must be absolute.

### Environment variables

| Variable                    | Default                                                                                                                                                    | Description                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBHID_SOCKET`             | `@webhid` (Linux root, abstract) / `$XDG_RUNTIME_DIR/webhid/webhid.sock` or `/run/user/<uid>/webhid/webhid.sock` (Linux user) / `/tmp/webhid.sock` (macOS) | IPC socket path                                                                                                                                                                                       |
| `WEBHID_PIPE`               | `\\.\pipe\webhid` (Windows)                                                                                                                                | Named pipe path                                                                                                                                                                                       |
| `WEBHID_WS_PORT`            | `0` (OS-assigned random)                                                                                                                                   | WebSocket server port (forced to 0 in NM-host mode)                                                                                                                                                   |
| `WEBHID_WS_BATCH_MS`        | `0`                                                                                                                                                        | Input report flush policy. `0` = rate-gated (immediate flush for a single report, 25µs coalescing for sparse bursts, 8ms coalescing once ~12+ reports land in a 4ms window). `1`+ = fixed N ms timer. |
| `WEBHID_WS_HIGH_RATE_MS`    | `8`                                                                                                                                                        | Coalesce window (ms) used when the high-rate threshold is met                                                                                                                                         |
| `WEBHID_WS_RATE_WINDOW_MS`  | `4`                                                                                                                                                        | Sliding window (ms) over which the flushed-report count is measured                                                                                                                                   |
| `WEBHID_WS_HIGH_RATE_COUNT` | `12`                                                                                                                                                       | Flushed reports within the rate window that trigger the high-rate (8ms) coalesce window                                                                                                               |
| `RUST_LOG`                  | `info`                                                                                                                                                     | Log level                                                                                                                                                                                             |

Note: the user systemd unit (`manifests/webhid-daemon.user.service`) hardcodes `WEBHID_WS_PORT=31337` for backwards compatibility. The system unit and daemon default use port 0 (random, OS-assigned).

### Addon settings

| Setting                 | Values                            | Default                       | Description                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlane`             | `ws` / `wt` / `nm`                | `ws`                          | Data plane: WS worker, WT worker (QUIC, pinned self-signed cert), or NM via bridge. Control ops are always NM.                                                                                                                                                                                                                                                                                                    |
| `workerSpawnMode`       | `shadow` / `blob`                 | `shadow` (MV3) / `blob` (MV2) | How the data worker is spawned in page context. `shadow` = `new Worker(location.href)` with webRequest interception (Shadow URL). `blob` = blob URL from the extension's worker bundle, requires CSP rewrite. Background pre-flights the page CSP (`getCspInfo`) and falls back: shadow blocked → blob, blob blocked on MV3 → NM. Hidden in the UI unless a worker will actually spawn (data plane `wt` or `ws`). |
| `useWorker`             | bool                              | `true`                        | WT only: run the data plane in a dedicated worker (default) or in-page on the main thread. WS always uses the worker; NM never does. No longer a UI toggle: WebTransport (in-page) in the Data Plane picker maps to `useWorker=false`.                                                                                                                                                                            |
| `daemonAsNmHost`        | bool                              | `false` (`true` on Windows)   | Use daemon-as-NM-host (skip forwarder + socket)                                                                                                                                                                                                                                                                                                                                                                   |
| `logLevel`              | 0 to 3                            | `1`                           | 0=error, 1=warn, 2=info, 3=debug                                                                                                                                                                                                                                                                                                                                                                                  |
| `devicePickerMode`      | `modal` / `pageAction` / `window` | `modal`                       | Device picker UI mode                                                                                                                                                                                                                                                                                                                                                                                             |
| `workerPolyfillEnabled` | bool                              | `false`                       | Inject WebHID polyfill into page-created Web Workers                                                                                                                                                                                                                                                                                                                                                              |

All settings except `daemonAsNmHost` can be overridden per-site via the popup (`daemonAsNmHost` is global-only: it selects the NM host and cannot be scoped to a site). Settings use per-key format in `browser.storage.local`: global keys are `settings :: <name>`, site overrides are `settings :: <origin> :: <name>`. Device info + origin allowlists are stored in IndexedDB (`webhid-store`).

The bridge uses a `SettingsStore` Proxy-based observer. `storage.onChanged` extracts `changes[k].newValue` and calls `settings.set(patch)`. The store handles diffing internally and fires listeners only when a value actually changes.

## Testing

### Layer 1: daemon unit tests

```sh
cargo test --manifest-path crates/Cargo.toml
```

### Layer 2: browser specs (Playwright)

Automated browser tests under `tests/browser/` using Playwright + `firefox-webext-playwright-harness` (loads the addon into Firefox via RDP). These test the polyfill surface without real hardware: Permissions-Policy gating, worker polyfill injection, HID class/event shapes, worker spawn modes, self-script/self-worker injection, dest-rewrite.

```sh
npm ci
npx playwright install firefox
npm run test:browser          # builds dist/addon first, runs the browser project against it
npm run test:browser:src      # runs the browser project against addon/ directly
npm run test:headed           # browser + e2e projects, headed
```

All Playwright deps live in the root `package.json` (there is no `tests/package.json`). The browser project is named `firefox-browser` in `tests/playwright.config.ts`.

Spec files: `dest-rewrite`, `hid-class`, `hid-device-class`, `hid-event-classes`, `permissions-policy`, `self-script`, `self-worker`, `worker-spawn` (24 tests, the full CSP matrix), `worker` (worker polyfill behavior).

### Layer 3: E2E specs (Playwright + webhid-mock)

End-to-end tests spawn the debug daemon + `webhid-mock` (a virtual HID device creator: `/dev/uhid` on Linux, `IOHIDUserDevice` on macOS) as subprocesses and drive `navigator.hid` through a test page. They run as serial chains (`test.describe.serial`) against a worker-scoped page and Firefox profile, so pairing and opening happen once and every later test reuses the same device. No per-test reset.

Three spec files share the same fixtures:

- `tests/e2e/e2e.spec.ts` (19 tests): the core chain (polyfill surface, grant, open/close, input/send/feature reports, disconnect, forget)
- `tests/e2e/wt.spec.ts` (10 tests): WebTransport data plane (WT spawn on open, input/send/feature over WT, no NM double-delivery while in WT mode, live ws→wt switch on an open device, in-page WT with `useWorker` off, cert-generation rotation + drain)
- `tests/e2e/picker-bypass.spec.ts` (3 tests): consent-bypass regression (page prototype patching cannot capture the bridge port, page enumerate is paired-only, and the chooser flow still grants, opens and drives reports)

Two projects run them, one per daemon deployment mode (both force `workers: 1`, see the concurrency note below):

- `firefox-e2e-daemon` (`tests/playwright.config.ts`): daemon spawned as the NM host directly (`daemonMode: 'daemon-nm'`)
- `firefox-e2e-forwarder` (`tests/playwright.forwarder.config.ts`): daemon runs normally, NM host is the thin forwarder (`daemonMode: 'forwarder'`)

```sh
npm run test:e2e            # both projects, serialized (daemon-nm, then forwarder)
npm run test:e2e:daemon     # daemon-as-NM-host project only
npm run test:e2e:forwarder  # forwarder project only
```

The harness (`tests/helpers/e2e.ts`) builds worker-scoped fixtures (`daemon`, `nmManifest`, `harnessCtx`, `sharedPage`) so all tests in a chain share one Firefox profile, one page, and one paired+opened device. Each generated descriptor is its own mock device (all at VID 0x16C0, unique PIDs from `DEVICES` in `tests/helpers/e2e-devices.ts`): `vendor` (0x0001, report ID 1, 64-byte input/output) drives the primary chain and the feature-report path, `gamepad` (0x0002, no report ID, 5-byte input) drives the WS-data-plane-with-URL-fragment and fresh-pairing gates, `mouse` (0x0003) and `keyboard` (0x0004) are available for multi-device scenarios. Devices spawn lazily on first use and are torn down when the worker ends.

> E2E tests require the debug binaries (`cargo build --manifest-path crates/Cargo.toml`, produces `webhid-daemon` and `webhid-mock`). One-time Linux setup (root): `sudo make install-e2e-udev-rule` installs `manifests/99-webhid-e2e.rules` (group `webhid` gets `/dev/uhid` write access plus read/write on hidraw nodes with VID 0x16C0, matched via the kernel name `<bus>:<VID>:<PID>.<n>` since uhid devices have no USB parent), creates the `webhid` group, and adds `$SUDO_USER` to it. Log out/in (or `newgrp webhid`) once, then the E2E suite runs as a normal user, no root needed. macOS needs no setup (`IOHIDUserDevice` works from a regular user session).

**Two gotchas baked into the fixtures** (see `AGENTS.md` for the full story):

- Report-level blocking drops input reports, rejects output/feature writes, and prunes blocked reports from the page-visible `collections` tree (`prune_device_info` at enumerate + hotplug connect events) for report IDs declared by any collection matching `crates/webhid-daemon/src/blocklist.rs` (Generic Desktop Mouse/Keyboard/Keypad/System Control, FIDO 0xF1D0), plus Chromium's hardcoded always-protected usages and the parse-failure interface fallback (see the AGENTS.md blocklist bullet for the full model). A device whose collections all become empty is hidden entirely, matching Chromium. The `vendor.bin` fixture (Joystick 0x01/0x04 + vendor 0xFF1C report 1) and `gamepad.bin` (Joystick 0x01/0x04, unnumbered) carry no protected usages, so they are unaffected in default builds; `mouse.bin` and `keyboard.bin` are consumer-input fixtures whose reports ARE dropped and whose devices are hidden (the mouse reports propagate to their Mouse Application ancestor, matching Chromium's ancestor propagation). `mouse.bin`/`keyboard.bin` are regenerated from `scripts/gen-descriptors.mjs`, which emits Constant padding / Array items to satisfy hidreport's usage-count check. Verify a fixture's usages against this blocklist before giving it a primary role in a default-features build.
- Usages must cover a non-constant main item's report count: `hidreport` rejects "Missing Usages for main item" when reportCount exceeds the number of declared usages on a Data/Variable item.

Both e2e configs force `workers: 1`: two heavy Firefox + daemon stacks in parallel occasionally drop a vendor input report under WS data-plane CPU contention (each project passes its chain alone; 58/58 serialized). `npm run test:e2e` serializes the projects by running them as two sequential npm scripts.

### Watching logs

```sh
# Daemon (systemd)
journalctl -u webhid-daemon -f

# Addon background
# about:debugging → FF WebHID → Inspect → Console

# Page (polyfill)
# F12 Web Console on the page you're testing
```

## Repository layout

```
FF-WebHID/
├── addon/                   Firefox extension (MV2 + MV3)
│   ├── manifest.json        Active MV3 manifest (source of truth; manifest.v2.json is the MV2 variant)
│   ├── manifest.v2.json     MV2 manifest (uses js/content/isolated/inject.js for MAIN-world injection)
│   ├── js/
│   │   ├── background/      Extension background context
│   │   │   ├── index.js     NM bridge, handshake, tab-targeted events, CSP pre-flight + rewrite, Permissions-Policy tracking, worker bundle serving, worker-polyfill injection
│   │   │   ├── state.js     Shared mutable state (deviceCache, deviceTabMap, permissionsPolicy, pendingPicker, workerPolyfillSites)
│   │   │   ├── storage.js   IndexedDB webhid-store (deviceInfo + origins)
│   │   │   ├── packed.js    NM constants + packed TLV builder
│   │   │   ├── state_ops.js Tab tracking + globalReset broadcast
│   │   │   ├── bundle.js    Fetches + concatenates worker bundles for StreamFilter injection
│   │   │   └── nm.js        NativeMessaging singleton (connect/reconnect/sendRequest/sendPacked)
│   │   ├── content/
│   │   │   ├── main/        MAIN world: navigator.hid polyfill (also runs inside page-created workers when workerPolyfillEnabled)
│   │   │   │   ├── index.js
│   │   │   │   └── types.js
│   │   │   └── isolated/    Isolated world content scripts
│   │   │       ├── bridge.js    Control/data routing, data worker spawn (shadow/blob/NM), MessagePort relay, getPolicy
│   │   │       ├── inject.js    MV2-only MAIN-world injector
│   │   │       ├── picker/      WebHidDevicePicker (closed Shadow DOM)
│   │   │       ├── worker/      Data Web Worker (binary WS, MessagePort input reports, ack-wait sendReport)
│   │   │       └── types.js
│   │   ├── internal/pages/  Extension UI (colocated HTML+CSS+JS)
│   │   │   ├── picker/      Popup picker window
│   │   │   ├── popup/       Per-site settings + device list
│   │   │   └── settings/    Global settings page
│   │   └── utils/
│   │       ├── bootstrap.js     Module registry (export/import via globalThis.webhid Map)
│   │       ├── bundle-files.js  Central list of files per runtime bundle (worker, workerPolyfill, mv2MainWorld)
│   │       ├── resource.js      fetchResource helper
│   │       ├── http.js          HTTP status helpers (isOk, name)
│   │       ├── logger.js        Level-based logger (storage-driven)
│   │       ├── settings.js      GLOBAL_DEFAULTS + SettingsStore Proxy factory
│   │       ├── base64.js        Uint8Array.fromBase64/toBase64 polyfill
│   │       ├── websocket.js     createWsTransport (WS reconnect/backoff/auth-failure)
│   │       ├── device.js        guessDeviceType, applyFilters (incl. exclusionFilters), isValidFilter, groupDevices
│   │       ├── descriptor-tlv.js  NM collections TLV binary + base64 decoder (runs once at cache time)
│   │       ├── i18n.js          browser.i18n wrapper + data-i18n localization
│   │       └── theme-sync.js    Theme synchronization for UI pages
│   ├── css/                 theme.css, shared.css, picker.css
│   ├── icons/ res/          Icons + device type icons
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared types (NmRequest, NmResponse, IpcRequest, IpcResponse) + FNV-1a hash + packed TLV parsers + collections TLV serde (collections_tlv.rs) + base64 serde
| `webhid-daemon/`       System daemon (hidapi, WS server, rate-gated batching, udev hot-plug, blocklist, seccomp hardening)
│   ├── webhid-native-messaging/  Firefox ↔ daemon thin forwarder (vectored I/O on all platforms, writes error frame on connect failure)
│   └── webhid-mock/         Virtual HID device mocker for E2E tests (Linux /dev/uhid, macOS IOHIDUserDevice; Windows stub)
│
├── manifests/               NM manifests + systemd units + udev rules
│   ├── webhid.forwarder_nm_host.json   Forwarder NM manifest ({{NM_BIN}})
│   ├── webhid.daemon_nm_host.json      Daemon-as-NM-host manifest ({{DAEMON_BIN}})
│   ├── webhid-daemon.service           System systemd unit (root, {{DAEMON_BIN}}, Group=webhid)
│   ├── webhid-daemon.user.service      User systemd unit (hardcodes WEBHID_WS_PORT=31337 for backwards compat)
│   ├── 99-webhid.rules                 udev rule (uaccess + FIDO blocklist exclusions)
│   └── 99-webhid-e2e.rules             E2E rule (webhid group gets /dev/uhid + VID 0x16C0 hidraw)
├── packaging/               Platform packaging
│   ├── linux/archlinux/     Arch PKGBUILDs (webhid daemon + webhid-addon)
│   ├── windows/             WiX v6 MSI (.wxs)
│   └── macos/               Homebrew formula
├── tests/                   Playwright test suite
│   ├── playwright.config.ts (firefox-browser, firefox-e2e-daemon projects)
│   ├── playwright.forwarder.config.ts (firefox-e2e-forwarder project)
│   ├── playwright.benchmark.config.ts (firefox-benchmark, firefox-benchmark-loss, chromium-benchmark projects)
│   ├── browser/             Browser specs (permissions-policy, worker-spawn, hid-classes, self-script/worker, dest-rewrite)
│   ├── e2e/                 E2E serial chains (e2e.spec.ts 19 tests, wt.spec.ts 10 tests, webhid-mock + daemon subprocess)
│   ├── benchmark/           Image-pipeline round-trip benchmark (benchmark-{ws,wt,nm,wt-inpage}.spec.ts, benchmark-utils.ts) + chromium/ + loss/ (loss-{nm,ws,wt,wt-inpage}.spec.ts @8000Hz, loss-utils.ts)
│   ├── helpers/             Test harness (e2e.ts, e2e-devices.ts, e2e-process.ts, e2e-types.ts, browser.ts, browser-utils.ts)
│   ├── pages/               Static test pages (policy-check, worker-spawn-csp, self-script, dest-gated, iframe-parent/child, ...)
│   ├── fixtures/descriptors/ Binary HID report descriptors (generated by scripts/gen-descriptors.mjs: vendor.bin, gamepad.bin, mouse.bin, keyboard.bin, edge/)
│   ├── serve.ts             Test HTTP servers (policy headers + static files)
│   └── test-page.html       Test page exposing window.__webhidTest API
├── scripts/
│   ├── gen-descriptors.mjs  Generates HID report descriptors for webhid-mock tests
│   ├── build-addon.mjs      Builds dist/addon + XPI (minify-only pipeline)
│   └── build-package.mjs    Builds .deb/.rpm/.msi packages
├── .github/workflows/       CI: check (audit), test (cargo + playwright browser), build (matrix), build-addon, sign-addon, release
├── docs/
│   ├── ARCHITECTURE.md      System architecture
│   ├── SPECIFICATION.md     WebHID spec compliance report
│   ├── DATA_PATH.md         Per-path copy/hop/latency analysis
│   ├── DEVELOPMENT.md       This file
│   ├── INSTALLATION.md      Install guide + platform recommendations
│   ├── BENCHMARK.md         Benchmark report
```

## Packaging (Arch Linux)

```sh
# Daemon + NM host + systemd service
cd packaging/linux/archlinux/webhid && makepkg -si

# Browser extension (system-wide XPI, downloads from AMO)
cd packaging/linux/archlinux/webhid-addon && makepkg -si
```

## Versioning

Versioning uses [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) (configured in `.versionrc.json`). Current version: 2.2.0.

```sh
npm run release
npm run release:minor
npm run release:patch
```

Bumps `.version.json`, `package.json`, `addon/manifest.json`, the three `Cargo.toml` files, and `Cargo.lock` (via `.versionrc.cargo-updater.cjs`).

## Cross-platform

CI builds on Linux, Windows, and macOS. Platform-specific code is gated with `#[cfg]`:

| Platform | IPC                                       | Hot-plug                   | hidapi feature        | Daemon-as-NM-host     |
| -------- | ----------------------------------------- | -------------------------- | --------------------- | --------------------- |
| Linux    | Unix socket (abstract `@webhid` for root) | udev monitor               | `linux-static-hidraw` | Yes (needs udev rule) |
| macOS    | Unix socket (`/tmp/webhid.sock`)          | IOHIDManager callbacks     | `macos-shared-device` | Yes                   |
| Windows  | Named pipe (`\\.\pipe\webhid`)            | RegisterDeviceNotification | `windows-native`      | Yes                   |

Daemon-as-NM-host works on all platforms. The daemon auto-detects NM mode via the 2 positional args Firefox passes (manifest path + addon ID). On Windows, `daemonAsNmHost` defaults to `true` (auto-detected in `loadNmHostSetting`).

The NM forwarder uses vectored I/O (`write_vectored`) on all platforms (no `splice()`).

## Makefile

Most build/package/bump workflows live in `package.json` (they were pure npm/node wrappers). The Makefile keeps the install/uninstall targets that need root or system integration:

| Target                                                   | Effect                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `make build`                                             | Release build of daemon + NM host                                        |
| `make install-system`                                    | System-wide install: binaries + NM manifest + systemd unit, `/usr/local` |
| `make install-user`                                      | User-local install into `~/.local` (no root)                             |
| `make install-udev-rule`                                 | Install `99-webhid.rules` (uaccess + FIDO exclusions)                    |
| `make install-e2e-udev-rule`                             | Install `99-webhid-e2e.rules` + create `webhid` group + add `$SUDO_USER` |
| `make install-webhid-group`                              | Create the `webhid` group and add `$SUDO_USER`                           |
| `make install-daemon-nm-host-system` / `-user`           | Install daemon binary + `webhid.daemon_nm_host` manifest                 |
| `make uninstall` / `uninstall-system` / `uninstall-user` | Remove the above                                                         |
| `make test` / `make clean` / `make help`                 | Misc                                                                     |

Overridable variables: `PREFIX`, `USER_PREFIX`, `CARGO_ARGS`, `WEBHID_GROUP`, `SYSTEM_NM_DIR`, `SYSTEMD_DIR`, `UDEV_DIR`, `USER_NM_DIR`, `USER_SYSTEMD_DIR`.
