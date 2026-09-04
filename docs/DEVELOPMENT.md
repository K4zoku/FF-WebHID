# Development Guide

## Prerequisites

### Runtime

| Dependency   | Package (Arch)             | Why                     |
| ------------ | -------------------------- | ----------------------- |
| `libudev.so` | `systemd`                  | Daemon hot-plug (Linux) |
| `hidapi`     | built from source by cargo | HID device access       |

### Build

| Dependency        | Package (Arch)     | Why                                             |
| ----------------- | ------------------ | ----------------------------------------------- |
| Rust ≥ 1.85       | `rustup` or `rust` | edition 2024                                    |
| `libudev` headers | `systemd`          | `udev` crate links at build time                |
| `pkg-config`      | `pkgconf`          | hidapi build                                    |
| `zip`             | `zip`              | Building addon XPI                              |
| Node.js ≥ 20      | `nodejs`           | Running Playwright tests, linter, and formatter |

```sh
sudo pacman -S rust systemd pkgconf zip nodejs
```

## Dev Container

The repository includes a lightweight Debian `node:22-bookworm-slim` devcontainer, which works with Zed's Dev Container support. Open the repository in Zed and choose the devcontainer environment. Creation runs `npm ci --ignore-scripts`; it does not run a build or test suite.

The configuration keeps the shell as the non-root `node` user and uses the container runtime's `keep-id` user namespace mapping so mounted files remain writable with rootless Podman, as used by the Zed setup. Use the equivalent host-UID mapping when using another runtime.

The image includes Rust stable with `rustfmt` and `clippy`, Node/npm, the native Linux build dependencies, and Firefox installed through the repository's Playwright dependency. These workflows are supported inside the container:

```sh
npm run build:rs:debug
npm run build:addon
npm run test:rs
npm run lint
npm run lint:js
npm run lint:rs
npm run test:browser:src
```

The existing `.cargo/config.toml` rustc wrapper remains active. Check Linux E2E device access from inside the container with:

```sh
.devcontainer/check-uhid.sh
```

Linux E2E additionally requires the host kernel's `/dev/uhid`, permission to open it, and access to the `hidraw` nodes created by `webhid-mock`. The image does not load kernel modules, pass devices by default, or request `--privileged`. If the check reports `UHID unavailable` or `UHID present but not writable`, normal development and browser tests remain usable.

The standard devcontainer intentionally does not advertise E2E support. Docker and Podman device flags can expose `/dev/uhid`, but they do not mount the dynamically created `/dev/hidraw*` nodes into the container. A device-cgroup rule alone is not sufficient, and a broad `/dev` bind mount or `--privileged` would unnecessarily weaken isolation. Do not add either to the normal Zed configuration.

For the supported Linux E2E path, run the suite on the host after applying the existing rule and joining the `webhid` group:

```sh
sudo make install-e2e-udev-rule
newgrp webhid
npm run test:e2e:daemon
npm run test:e2e:forwarder
```

If a separate container runtime integration can explicitly pass each newly created VID `0x16C0` `hidraw` node, it must also preserve the `webhid` group permissions and the host-assigned device major/minor values. Do not guess those values. This is intentionally outside the default devcontainer because dynamic device passthrough is runtime-specific.

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

| Variable                    | Default                                                                                                                                                                                        | Description                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBHID_SOCKET`             | `@webhid` (Linux root, abstract) / `$XDG_RUNTIME_DIR/webhid/webhid.sock` or `/run/user/<uid>/webhid/webhid.sock` (Linux user) / `$HOME/Library/Application Support/webhid/webhid.sock` (macOS) | Unix socket path used by the persistent-daemon forwarder profile; not used by daemon-as-NM-host.                                                                                                      |
| `WEBHID_PIPE`               | `\\.\pipe\webhid` (Windows)                                                                                                                                                                    | Named pipe path used by the persistent-daemon forwarder profile.                                                                                                                                      |
| `WEBHID_WS_PORT`            | `0` (OS-assigned random)                                                                                                                                                                       | WebSocket server port, forced to 0 in Native Messaging host mode.                                                                                                                                     |
| `WEBHID_WS_BATCH_MS`        | `0`                                                                                                                                                                                            | Input report flush policy. `0` = rate-gated (immediate flush for a single report, 25µs coalescing for sparse bursts, 8ms coalescing once ~12+ reports land in a 4ms window). `1`+ = fixed N ms timer. |
| `WEBHID_WS_HIGH_RATE_MS`    | `8`                                                                                                                                                                                            | Coalesce window (ms) used when the high-rate threshold is met.                                                                                                                                        |
| `WEBHID_WS_RATE_WINDOW_MS`  | `4`                                                                                                                                                                                            | Window (ms) over which the flushed-report count is measured.                                                                                                                                          |
| `WEBHID_WS_HIGH_RATE_COUNT` | `12`                                                                                                                                                                                           | Flushed reports within the rate window that trigger the high-rate coalesce window.                                                                                                                    |
| `RUST_LOG`                  | `info`                                                                                                                                                                                         | Log level.                                                                                                                                                                                            |

Note: the user systemd unit (`manifests/webhid-daemon.user.service`) hardcodes `WEBHID_WS_PORT=31337` for backwards compatibility. The system unit and daemon default use port 0 (random, OS-assigned).

### Addon settings

| Setting                            | Values                            | Default                                          | Description                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlane`                        | `ws` / `wt` / `nm`                | `wt` when available, otherwise `ws`              | Report data plane. WT uses worker WebTransport when the handshake offers it; selected WT uses worker WS when no WT endpoint is offered; worker setup or transport failure can move the device to NM. Daemon-backed control still uses Native Messaging, while browser-local control does not.            |
| `workerSpawnMode`                  | `shadow` / `blob`                 | `shadow` (MV3) / `blob` (MV2)                    | How the data worker is spawned in page context. Shadow uses `new Worker(location.href)` with webRequest interception. Blob uses the extension worker bundle and CSP path. CSP preflight can select NM for shadow; a failed blob spawn also falls back to NM. Hidden unless a worker will actually spawn. |
| `daemonAsNmHost`                   | bool                              | `false` (`true` on macOS and Windows when unset) | Use daemon-as-NM-host, rather than the persistent-daemon forwarder profile.                                                                                                                                                                                                                              |
| `hidePageAction`                   | bool                              | `false`                                          | Keep the Firefox page-action icon hidden even after a page uses WebHID; the browser action still opens the device view.                                                                                                                                                                                  |
| `logLevel`                         | 0 to 3                            | `1`                                              | 0=error, 1=warn, 2=info, 3=debug.                                                                                                                                                                                                                                                                        |
| `devicePickerMode`                 | `modal` / `pageAction` / `window` | `modal`                                          | Device picker UI mode.                                                                                                                                                                                                                                                                                   |
| `workerPolyfillEnabled`            | bool                              | `false`                                          | Inject the WebHID polyfill into page-created Web Workers.                                                                                                                                                                                                                                                |
| `allowActivationlessRequestDevice` | bool                              | `false`                                          | Skip the user-activation check in `requestDevice()` for sites that request devices after asynchronous work. This is a spec deviation; explicit chooser selection and Permissions Policy still apply.                                                                                                     |

`daemonAsNmHost` and `hidePageAction` are global-only. Every other user-facing setting can be overridden per-site via the popup. `useWorker` is an internal benchmark setting, not a user-facing settings option. Settings use per-key format in `browser.storage.local`: global keys are `settings :: <name>`, site overrides are `settings :: <origin> :: <name>`. Device info, origin allowlists, and grant groups are stored in IndexedDB (`webhid-store`).

The bridge uses a `SettingsStore` Proxy-based observer. `storage.onChanged` extracts `changes[k].newValue` and calls `settings.set(patch)`. The store handles diffing internally and fires listeners only when a value actually changes.

## Testing

### Layer 1: daemon unit tests

```sh
cargo test --manifest-path crates/Cargo.toml
```

### Layer 2: browser specs (Playwright)

Automated browser tests under `tests/browser/` use Playwright + `firefox-webext-playwright-harness` to load the addon through RDP without real hardware. The harness forces Firefox preference `network.lna.enabled: false`, so these tests do not exercise the real Firefox 154 LNA permission flow. The suite covers WebHID class and event shapes, Permissions Policy, activation, page-action behavior, MAIN-world race resistance, worker polyfill injection, worker spawn and shadow redirects, CSP and Trusted Types behavior, self-script/self-worker injection, and destination rewriting.

```sh
npm ci
npx playwright install firefox
npm run test:browser          # builds dist/addon first, runs the browser project against it
npm run test:browser:src      # runs the browser project against addon/ directly
npm run test:headed           # browser + e2e projects, headed
```

All Playwright dependencies live in the root `package.json`. The browser project is `firefox-browser` in `tests/playwright.config.ts`. See `tests/browser/` for the current spec inventory rather than relying on a hardcoded count.

### Layer 3: E2E specs (Playwright + webhid-mock)

End-to-end tests spawn the debug daemon + `webhid-mock` (a virtual HID device creator: `/dev/uhid` on Linux, `IOHIDUserDevice` on macOS) as subprocesses and drive `navigator.hid` through a test page. They run as serial chains (`test.describe.serial`) against a worker-scoped page and Firefox profile, so pairing and opening happen once and every later test reuses the same device. No per-test reset.

The serial E2E chains currently cover:

- `e2e.spec.ts`: core polyfill, grant, open/close, input, output, feature, disconnect, and forget behavior.
- `input-report-fanout.spec.ts`: input delivery to authorized consumers.
- `nm-report-reqid.spec.ts`: NM report request-id correlation.
- `picker-bypass.spec.ts`: consent and bridge-channel bypass regression coverage.
- `transport-revoke.spec.ts`: session and transport authority revocation.
- `wt.spec.ts`: worker WebTransport setup, reports, mode switching, and certificate-generation lifecycle.

All share the same worker-scoped fixture model. The suite deliberately avoids a hardcoded test total because serial-chain coverage changes with regression cases.

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

Both E2E configs force `workers: 1`: two heavy Firefox plus daemon stacks in parallel can occasionally drop a vendor input report under WS data-plane CPU contention. `npm run test:e2e` runs the daemon-host and forwarder projects sequentially.

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
│   ├── manifest.json        Active MV3 manifest; `manifest.v2.json` is the MV2 variant
│   ├── js/
│   │   ├── background/      Startup, message handlers, persistent NM, storage, state, CSP, and webRequest code
│   │   ├── content/main/    MAIN-world WebHID polyfill, including page-created worker context
│   │   ├── content/isolated/ Bridge, picker, and production data worker
│   │   ├── internal/pages/  Picker, popup, settings, and devices extension pages
│   │   └── utils/           Shared settings, transport, wire-format, resource, and UI helpers
│   ├── css/                 Shared and theme CSS
│   ├── icons/               Extension icons
│   └── res/                 Device-type resources
│
├── crates/                  Rust workspace
│   ├── webhid/              Shared protocol/types, device identity, packed formats, and collection TLV serialization
│   ├── webhid-daemon/      HID daemon, WS/WT servers, batching, hot-plug, blocklist, and persistent device I/O
│   ├── webhid-native-messaging/ Thin NM stdio-to-platform-IPC forwarder
│   └── webhid-mock/         Virtual HID device mocker for E2E tests
│
├── manifests/               Native Messaging manifests, service units, and udev rules
├── packaging/               Platform packaging
├── tests/                   Playwright browser, E2E, benchmark, fixture, and helper code
├── scripts/                 Build and descriptor-generation scripts
└── docs/                    Architecture, specification, data path, development, installation, and benchmark docs
```

The tree above is intentionally a map of responsibilities, not an exhaustive file listing. The test helper and fixture directories contain the current browser and daemon harness details.

## Packaging (Arch Linux)

```sh
# Daemon + NM host + systemd service
cd packaging/linux/archlinux/webhid && makepkg -si

# Browser extension (system-wide XPI, downloads from AMO)
cd packaging/linux/archlinux/webhid-addon && makepkg -si
```

## Versioning

Versioning uses [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) (configured in `.versionrc.json`). Current version: 3.2.0.

```sh
npm run release
npm run release:minor
npm run release:patch
```

Bumps `.version.json`, `package.json`, `addon/manifest.json`, the three `Cargo.toml` files, and `Cargo.lock` (via `.versionrc.cargo-updater.cjs`).

## Cross-platform

CI builds on Linux, Windows, and macOS. Platform-specific code is gated with `#[cfg]`:

| Platform | Persistent-daemon IPC                                 | Hot-plug                   | hidapi feature        | Daemon-as-NM-host                      |
| -------- | ----------------------------------------------------- | -------------------------- | --------------------- | -------------------------------------- |
| Linux    | Unix socket, including abstract `@webhid` for root    | udev monitor               | `linux-static-hidraw` | Yes, with user HID permissions         |
| macOS    | Unix socket under the user's Application Support path | IOHIDManager callbacks     | `macos-shared-device` | Yes, with Input Monitoring as required |
| Windows  | Named pipe (`\\.\pipe\webhid`)                        | RegisterDeviceNotification | `windows-native`      | Yes                                    |

Daemon-as-NM-host works on all listed platforms. Firefox supplies the manifest path and addon ID as two positional arguments; Chromium supplies one extension-origin argument. The addon selects the host name from `daemonAsNmHost`. On macOS and Windows, that setting defaults to `true` when no value is stored.

The NM forwarder uses vectored I/O (`write_vectored`) on all platforms (no `splice()`).

## Makefile

Most build/package/bump workflows live in `package.json` (they were pure npm/node wrappers). The Makefile keeps the install/uninstall targets that need root or system integration:

| Target                                                   | Effect                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `make build`                                             | Release build of daemon + NM host                                        |
| `make install-system`                                    | System-wide install: binaries + NM manifest + systemd unit, `/usr/local` |
| `make install-user`                                      | User-local install into `~/.local` (no root)                             |
| `make install-udev-rule`                                 | Install `72-webhid.rules` (uaccess + FIDO exclusions)                    |
| `make install-e2e-udev-rule`                             | Install `99-webhid-e2e.rules` + create `webhid` group + add `$SUDO_USER` |
| `make install-webhid-group`                              | Create the `webhid` group and add `$SUDO_USER`                           |
| `make install-daemon-nm-host-system` / `-user`           | Install daemon binary + `webhid.daemon_nm_host` manifest                 |
| `make uninstall` / `uninstall-system` / `uninstall-user` | Remove the above                                                         |
| `make test` / `make clean` / `make help`                 | Misc                                                                     |

Overridable variables: `PREFIX`, `USER_PREFIX`, `CARGO_ARGS`, `WEBHID_GROUP`, `SYSTEM_NM_DIR`, `SYSTEMD_DIR`, `UDEV_DIR`, `USER_NM_DIR`, `USER_SYSTEMD_DIR`.
