<div align="center">

# Firefox WebHID

[![Mozilla Add-on](https://img.shields.io/amo/v/webhid?style=flat)](https://addons.mozilla.org/en-US/firefox/addon/webhid/) [![Users](https://img.shields.io/amo/users/webhid?style=flat)](https://addons.mozilla.org/en-US/firefox/addon/webhid/) [![Codacy grade](https://img.shields.io/codacy/grade/ee1ff63757e3419493edcb002adb6d6e?style=flat)](https://app.codacy.com/gh/K4zoku/FF-WebHID/dashboard) [![License](https://img.shields.io/github/license/K4zoku/FF-WebHID?style=flat)](LICENSE)

</div>

## What is this?

WebHID is a web standard that lets websites communicate directly with supported USB devices. Sites use it for game controllers, drawing tablets, stream decks, MIDI devices, and specialized input gear. Firefox does not support WebHID out of the box[^1][^2], so this addon fills the gap. Install the addon plus a small background daemon, and WebHID websites work as if Firefox supported them natively.

[^1]: [MDN: WebHID API](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API): browser compatibility shows no Firefox support.

[^2]: [Mozilla standards position on WebHID](https://github.com/mozilla/standards-positions/issues/459): negative.

## Features

- **WebHID for Firefox**: websites that already support WebHID work without changes.
- **Worker-based data planes**: WebTransport and WebSocket keep transport handling in a per-device worker, so page rendering does not share that work directly. Actual throughput and latency depend on the browser, device, and workload.
- **Cross-platform**: works on Linux, macOS, and Windows.
- **Connection recovery**: Native Messaging and worker transports retry connections where their session remains valid. A daemon restart resets the affected sessions and reports a disconnect to the page.
- **Hot-plug**: plug devices in or unplug them any time; no page reload needed.
- **Per-site control**: set up each website the way you want and change it any time, without reloading the page.
- **Device chooser your way**: pick devices from a clean overlay, a popup in the address bar, or a separate window.
- **Private and secure**: websites can only reach devices you explicitly choose, security keys and protected mouse, keyboard, and keypad reports are blocked by the daemon, and data remains on the local machine during normal operation.

## Install

The addon needs two parts:

1. The Firefox addon: [![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=flat&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)
2. A small background daemon for your operating system, from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases).

Step-by-step instructions for Linux, macOS, and Windows: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## How to use

1. Install the addon and the daemon (see [Install](#install)).
2. Open a website that uses WebHID and click its device or connect button.
3. Pick your device in the chooser and connect.

**Firefox 154 Local Network Access**: in the observed Firefox 154 behavior, worker WebSocket and WebTransport connections are subject to local-network permission. A WebSocket attempt can surface the LNA prompt, while WebTransport may retry without showing one until permission has been granted. This is version-specific behavior, not a stable browser contract.

If you want to use **WebTransport**, there are two observed workarounds:

- Switch **Data Plane** to **WebSocket**, reconnect, choose **Remember my choice for this site** and **Allow**, then switch back to **WebTransport**.
- **about:config workaround**: set `network.lna.blocking` to `false`. As a broader workaround, set `network.lna.enabled` to `false`. These preference names and effects are Firefox-version dependent.

When a site actually uses WebHID, its gamepad page-action icon appears in the address bar and shows which devices the site can access; it also lets you revoke access. The browser action opens the device view even when the page action is hidden. Per-site settings live behind the gear icon in the same popup.

## Settings

Everything works out of the box. Most settings exist for edge cases, so change them only when a site misbehaves.

**Recommended setup**: enable **Daemon as NM host** and keep the default **WebTransport** data plane in a worker. This keeps page rendering isolated while retaining the preferred network path, but it needs a correct install: the daemon then runs as your user instead of a system service, which on Linux needs the udev rules and on macOS needs Input Monitoring permission. Step-by-step setup per platform: [docs/INSTALLATION.md](docs/INSTALLATION.md).

### Per-site settings

Click the gamepad icon in the address bar, then the gear icon. Changes here apply to the current site only and override the global defaults:

- **Data Plane**: how the addon moves data between the site and the daemon.
  - **WebTransport** (default where available): the preferred worker network path when the daemon handshake offers WT.
  - **WebSocket**: the alternate worker network path. A selected WebTransport mode uses WebSocket when no WT endpoint is available.
  - **Native Messaging**: the compatibility path. It is selected directly when configured, and worker setup or transport failure can move a device to it.
- **Worker Spawn Mode**: how the addon creates the worker in the page. Only shown when a worker is actually used (Data Plane is WebTransport or WebSocket). The bridge pre-flights CSP for shadow spawning; CSP, worker-spawn, or transport failure can result in Native Messaging. Shadow and blob are not a worker-to-worker fallback chain.
  - **Shadow URL** (default): uses the page's own URL for the worker and webRequest interception to serve the data worker.
  - **Blob + CSP rewrite**: creates the worker from a blob URL and asks the extension's CSP path to allow the worker and daemon connections. It works fully on the MV2 build; MV3 header policies may still prevent the spawn, after which Native Messaging is used.
- **Device Picker Mode**: how the chooser appears.
  - **Modal** (default): an overlay on the page. Use unless the site's own design conflicts with it.
  - **Page Action**: a popup from the address bar; use if the overlay gets in the way.
  - **Window**: a separate popup window; use on heavy pages that slow the overlay down.
- **Worker Polyfill**: support for sites that use WebHID inside Dedicated Workers.
  - **Off** (default): most sites do not need it.
  - **On**: injects the WebHID API into Dedicated Worker scripts. `requestDevice()` remains available only on the page as required by the WebHID model. Service Worker WebHID is not provided by the polyfill. Reload the page after changing.
- **Allow activation-less requestDevice()**: workaround for the few sites that request devices outside of a click.
  - **Off** (default): normal behavior; sites request devices from a click.
  - **On**: lets the site request devices without a click (the chooser still asks you to pick one). Reload the page after changing.
- **Log Level**: how much detail the addon writes to the browser console.
  - **Error**: errors only.
  - **Warn** (default): warnings and errors.
  - **Info**: normal events too.
  - **Debug**: everything, including timings. Use when reporting a problem.

### Global settings

Open `about:addons → WebHID → Options`. Site settings are overridden from the popup; the global-only settings are:

- **Hide Page Action**: keep the Firefox page-action icon hidden even after a page uses WebHID. The browser action still opens the device view.
- **Daemon as NM host**: how the daemon is launched.

  - **On** (recommended): Firefox spawns the daemon on demand, so no system service is needed; requires the setup described in the Recommended setup note above.
  - **Off** (default on Linux; on by default on macOS and Windows): the daemon runs as a system service.

## Privacy and security

- Websites can only access devices you pick in the chooser. You can revoke access per site at any time.
- Security keys (FIDO/U2F) and protected mouse, keyboard, and keypad reports are blocked by the daemon.
- WS and WT listeners bind to loopback and authenticate their transport with a per-session derived value. Native Messaging host authorization and daemon IPC peer checks depend on the selected deployment profile and platform. Device data stays on the local machine during normal operation.

## For developers

The technical side of this project lives in the docs:

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Spec Compliance](docs/SPECIFICATION.md): WebHID spec compliance report with item-level evidence
- [Data Path Analysis](docs/DATA_PATH.md): concrete runtime paths and application-level handoff accounting
- [Benchmark Report](docs/BENCHMARK.md): automated image-pipeline and 8000Hz loss benchmarks for the supported data planes and Chromium native WebHID, with per-report latency, walltime results, and RDP profiling
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging
- [Installation Guide](docs/INSTALLATION.md): platform-specific install instructions and recommended settings
