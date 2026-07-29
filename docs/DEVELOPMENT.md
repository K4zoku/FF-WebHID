# Development Guide

## Prerequisites

### Runtime

| Dependency | Package (Arch) | Why |
|---|---|---|
| `libudev.so` | `systemd` | Daemon hot-plug (Linux) |
| `hidapi` | built from source by cargo | HID device access |

### Build

| Dependency | Package (Arch) | Why |
|---|---|---|
| Rust ≥ 1.85 | `rustup` or `rust` | edition 2024 |
| `libudev` headers | `systemd` | `udev` crate links at build time |
| `pkg-config` | `pkgconf` | hidapi build |
| `zip` | `zip` | Building addon XPI |
| Node.js ≥ 18 | `nodejs` | Running Playwright tests, linter, formatter |

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

Binaries: `crates/target/{debug,release}/webhid-daemon`, `webhid-native-messaging`, and `uhid-mock` (Linux only, test helper).

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

| Variable | Default | Description |
|---|---|---|
| `WEBHID_SOCKET` | `@webhid` (Linux root, abstract) / `$XDG_RUNTIME_DIR/webhid/webhid.sock` (Linux user) / `/tmp/webhid.sock` (macOS) | IPC socket path |
| `WEBHID_PIPE` | `\\.\pipe\webhid` (Windows) | Named pipe path |
| `WEBHID_WS_PORT` | `0` (OS-assigned random) | WebSocket server port (forced to 0 in NM-host mode) |
| `WEBHID_WS_BATCH_MS` | `0` | Input report flush policy. `0` = adaptive (drain + burst coalescing with 25µs window). `1`+ = fixed N ms timer. |
| `RUST_LOG` | `info` | Log level |

Note: the user systemd unit (`manifests/webhid-daemon.user.service`) hardcodes `WEBHID_WS_PORT=31337` for backwards compatibility. The system unit and daemon default use port 0 (random, OS-assigned).

### Addon settings

| Setting | Values | Default | Description |
|---|---|---|---|
| `dataPlane` | `ws` / `nm` | `ws` | Data plane: WS worker (MessagePort direct to page) or NM via bridge |
| `daemonAsNmHost` | bool | `false` (`true` on Windows) | Use daemon-as-NM-host (skip forwarder + socket) |
| `logLevel` | 0 to 3 | `1` | 0=error, 1=warn, 2=info, 3=debug |
| `devicePickerMode` | `modal` / `pageAction` / `window` | `modal` | Device picker UI mode |
| `workerPolyfillEnabled` | bool | `false` | Inject WebHID polyfill into page-created Web Workers |

All settings can be overridden per-site via the popup. Settings use per-key format in `browser.storage.local`: global keys are `settings :: <name>`, site overrides are `settings :: <origin> :: <name>`. Device info + origin allowlists are stored in IndexedDB (`webhid-store`).

The bridge uses a `SettingsStore` Proxy-based observer. `storage.onChanged` extracts `changes[k].newValue` and calls `settings.set(patch)`. The store handles diffing internally and fires listeners only when a value actually changes.

## Testing

### Layer 1: daemon unit tests

```sh
cargo test --manifest-path crates/Cargo.toml
```

### Layer 2: browser specs (Playwright)

Automated browser tests under `tests/` using Playwright + `firefox-webext-playwright-harness` (loads `addon/` into Firefox via RDP). Browser specs test Permissions-Policy gating, worker polyfill injection, HID class/event shapes.

```sh
cd tests
npm ci
npx playwright install firefox
npm run test:browser          # or: npm run test:headed
```

### Layer 3: E2E specs (Playwright + uhid-mock)

End-to-end tests spawn the debug daemon + `uhid-mock` (a `/dev/uhid` virtual device creator, Linux only) as subprocesses and drive `navigator.hid` through a test page. Uses a Switch Pro gamepad descriptor fixture.

```sh
cd tests
npm run test:e2e
```

> E2E tests require `uhid-mock` (build: `cargo build -p uhid-mock`) and udev access to `/dev/uhid`. The E2E CI job is currently disabled (needs udev + uhid); see `.github/workflows/test.yml`.

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
│   ├── manifest.json        Active manifest (copied from manifest.v3.json by build-addon)
│   ├── manifest.v2.json     MV2 source (uses inject-main.js for MAIN-world)
│   ├── manifest.v3.json     MV3 source (content scripts with "world": "MAIN")
│   ├── js/
│   │   ├── background.js    NM bridge, handshake, tab-targeted events, worker bundle serving, worker-polyfill injection, daemonAsNmHost
│   │   ├── polyfill.js      MAIN world: navigator.hid, MessageChannel data ports, ack-wait sendReport
│   │   ├── bridge.js        Isolated world: control/data routing, data worker spawn (redirect-interception), data port relay, effective-settings handler
│   │   ├── worker.js        Data Web Worker: binary WS, MessagePort input reports, ack-wait sendReport
│   │   ├── worker-polyfill.js  Stub WebHID polyfill injected into page-created workers (opt-in)
│   │   ├── picker.js        WebHidDevicePicker class (ISOLATED world, closed Shadow DOM)
│   │   ├── inject-main.js   MV2-only MAIN-world injector (fetchResource → <script>)
│   │   ├── pages/
│   │   │   ├── picker.js    Popup picker window logic
│   │   │   ├── settings.js  Settings page logic
│   │   │   ├── popup.js     Popup logic (per-site settings, device list)
│   │   └── utils/
│   │       ├── bootstrap.js Module registry (export/import via globalThis.webhid Map)
│   │       ├── resource.js  fetchResource helper
│   │       ├── http.js      HTTP status helpers (isOk, name)
│   │       ├── logger.js    Level-based logger (storage-driven)
│   │       ├── settings.js  GLOBAL_DEFAULTS + SettingsStore Proxy factory
│   │       ├── base64.js    Uint8Array.fromBase64/toBase64 polyfill
│   │       ├── websocket.js createWsTransport (WS reconnect/backoff/auth-failure)
│   │       └── device.js    guessDeviceType, applyFilters, groupDevices, fetchDeviceIcon
│   ├── html/
│   │   ├── picker.html      Popup picker
│   │   ├── settings.html
│   │   └── popup.html
│   ├── css/
│   │   ├── theme.css
│   │   ├── shared.css
│   │   └── picker.css
│   ├── icons/ res/          Icons + device type icons
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared types (NmRequest, NmResponse, IpcRequest, IpcResponse) + FNV-1a hash + packed TLV parsers + base64 serde. NM wire: single-char fields + HTTP status + packed binary TLVs.
│   ├── webhid-daemon/       System daemon (hidapi, WS server, adaptive batching, udev hot-plug, blocklist)
│   ├── webhid-native-messaging/  Firefox ↔ daemon thin forwarder (vectored I/O on all platforms, writes error frame on connect failure)
│   └── uhid-mock/           Linux-only /dev/uhid virtual device mocker for E2E tests
│
├── manifests/               NM manifests + systemd units + udev rule
│   ├── webhid.forwarder_nm_host.json   Forwarder NM manifest ({{NM_BIN}})
│   ├── webhid.daemon_nm_host.json      Daemon-as-NM-host manifest ({{DAEMON_BIN}})
│   ├── webhid-daemon.service           System systemd unit (root, {{DAEMON_BIN}}, Group=webhid)
│   ├── webhid-daemon.user.service      User systemd unit (hardcodes WEBHID_WS_PORT=31337 for backwards compat)
│   └── 99-webhid.rules                 udev rule (uaccess + FIDO blocklist exclusions)
├── packaging/               Platform packaging
│   ├── linux/archlinux/     Arch PKGBUILDs (webhid daemon + webhid-addon)
│   ├── linux/debian/        Debian .deb build script
│   ├── linux/rpm/           RPM .spec + build script
│   ├── windows/             WiX v6 MSI (.wxs + build-msi.ps1)
│   └── macos/               Homebrew formula
├── tests/                   Playwright test suite
│   ├── playwright.config.ts (firefox-browser + firefox-e2e projects)
│   ├── tests/browser/       Browser specs (permissions-policy, worker-polyfill, hid-classes)
│   ├── tests/e2e/           E2E specs (uhid-mock + daemon subprocess)
│   ├── helpers/             Test harness (e2e.ts, browser.ts, e2e-process.ts)
│   ├── fixtures/descriptors/ Binary HID report descriptors (generated by scripts/gen-descriptors.mjs)
│   ├── types/               TS type stubs
│   ├── serve-static.mjs     Static file server for test pages
│   ├── serve-policy.mjs     Permissions-Policy header server for browser specs
│   └── test-page.html       Test page exposing window.__webhidTest API
├── scripts/
│   └── gen-descriptors.mjs  Generates sample HID report descriptors for uhid-mock tests
├── .github/workflows/       CI: check (audit), test (cargo + playwright browser), build (matrix), build-addon, sign-addon, release
├── docs/
│   ├── ARCHITECTURE.md      System architecture
│   ├── DATA_PATH.md         Per-path copy/hop/latency analysis
│   ├── DEVELOPMENT.md       This file
│   ├── INSTALLATION.md      Install guide + platform recommendations
│   ├── BENCHMARK.md         Benchmark report
│   └── SPECIFICATION.md     WebHID spec compliance report
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

| Platform | IPC | Hot-plug | hidapi feature | Daemon-as-NM-host |
|---|---|---|---|---|
| Linux | Unix socket (abstract `@webhid` for root) | udev monitor | `linux-static-hidraw` | Yes (needs udev rule) |
| macOS | Unix socket (`/tmp/webhid.sock`) | IOHIDManager callbacks | `macos-shared-device` | Yes |
| Windows | Named pipe | RegisterDeviceNotification | `windows-native` | Yes |

Daemon-as-NM-host works on all platforms. The daemon auto-detects NM mode via the 2 positional args Firefox passes (manifest path + addon ID). On Windows, `daemonAsNmHost` defaults to `true` (auto-detected in `loadNmHostSetting`).

The NM forwarder uses vectored I/O (`write_vectored`) on all platforms (no `splice()`).
