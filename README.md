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
- **Fast and smooth**: built for demanding devices that send thousands of updates per second, without slowing down the page you are using.
- **Cross-platform**: works on Linux, macOS, and Windows.
- **Self-healing**: if the daemon restarts or a connection drops, everything reconnects automatically.
- **Hot-plug**: plug devices in or unplug them any time; no page reload needed.
- **Per-site control**: set up each website the way you want and change it any time, without reloading the page.
- **Device chooser your way**: pick devices from a clean overlay, a popup in the address bar, or a separate window.
- **Private and secure**: websites can only reach devices you explicitly choose, security keys and the system mouse and keyboard are always blocked, and all data stays on your machine.

## Install

The addon needs two parts:

1. The Firefox addon: [![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=flat&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)
2. A small background daemon for your operating system, from [GitHub Releases](https://github.com/K4zoku/FF-WebHID/releases).

Step-by-step instructions for Linux, macOS, and Windows: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## How to use

1. Install the addon and the daemon (see [Install](#install)).
2. Open a website that uses WebHID and click its device or connect button.
3. Pick your device in the chooser and connect.

The gamepad icon in the address bar shows which devices a site can access and lets you revoke access. Per-site settings live behind the gear icon in the same popup.

## Settings

Everything works out of the box. Most settings exist for edge cases, so change them only when a site misbehaves.

**Recommended setup**: enable **Daemon as NM host** and keep the default **WebTransport** data plane in a worker. This is the most secure and fastest combination, but it needs a correct install: the daemon then runs as your user instead of a system service, which on Linux needs the udev rules and on macOS needs Input Monitoring permission. Step-by-step setup per platform: [docs/INSTALLATION.md](docs/INSTALLATION.md).

### Per-site settings

Click the gamepad icon in the address bar, then the gear icon. Changes here apply to the current site only and override the global defaults:

- **Data Plane**: how the addon moves data between the site and the daemon.
  - **WebTransport** (default): the fastest option; runs in a background worker so pages stay smooth. Keep it unless a site has problems.
  - **WebTransport (in-page)**: connects directly in the page; fine at normal report rates, uses a bit more of the page's CPU. Use it when a site blocks background workers (CSP) but still allows the connection. The first time a site connects this way, Firefox asks for permission: "example.com wants to access other apps and services on this device." Tick **Remember my choice for this site**, then click **Allow**, otherwise you will be asked again on every page load. Reload the page after changing this setting.
  - **WebSocket**: fallback when WebTransport is not available, for example on older Firefox.
  - **Native Messaging**: the slowest but most compatible option; use it when a site's security policy blocks the other three.
- **Worker Spawn Mode**: how the addon creates the worker in the page. Only shown when a worker is actually used (Data Plane is WebTransport or WebSocket). If the site's security policy (CSP) blocks worker creation, the addon falls back to Native Messaging instead.
  - **Shadow URL** (default): uses the page's own URL for the worker, so it respects the page's security settings and changes (almost) nothing about the page.
  - **Blob + CSP rewrite**: creates the worker from a blob URL and relaxes the page's worker policy. Works fully on the MV2 build; on the MV3 build only a CSP set in a meta tag can be rewritten, so header-based policies still block it.
- **Device Picker Mode**: how the chooser appears.
  - **Modal** (default): an overlay on the page. Use unless the site's own design conflicts with it.
  - **Page Action**: a popup from the address bar; use if the overlay gets in the way.
  - **Window**: a separate popup window; use on heavy pages that slow the overlay down.
- **Worker Polyfill**: support for sites that use WebHID from inside web workers.
  - **Off** (default): most sites do not need it.
  - **On**: injects the full WebHID API into worker scripts, matching the spec (requestDevice stays available only in the page, as the spec requires). Reload the page after changing.
- **Allow activation-less requestDevice()**: workaround for the few sites that request devices outside of a click.
  - **Off** (default): normal behavior; sites request devices from a click.
  - **On**: lets the site request devices without a click (the chooser still asks you to pick one). Reload the page after changing.
- **Log Level**: how much detail the addon writes to the browser console.
  - **Error**: errors only.
  - **Warn** (default): warnings and errors.
  - **Info**: normal events too.
  - **Debug**: everything, including timings. Use when reporting a problem.

### Global settings

Open `about:addons → WebHID → Options`. Every setting above is available per site; sites that have not set their own value use the global default. One setting is global only:

- **Daemon as NM host**: how the daemon is launched.
  - **On** (recommended): Firefox spawns the daemon on demand, so no system service is needed; requires the setup described in the Recommended setup note above.
  - **Off** (default; on by default on Windows): the daemon runs as a system service.

## Privacy and security

- Websites can only access devices you pick in the chooser. You can revoke access per site at any time.
- Security keys (FIDO/U2F) and system mouse, keyboard, and keypad devices are always blocked from websites.
- The daemon only listens on your machine (localhost), and each connection is protected with its own access token. Device data never leaves your computer.

## For developers

The technical side of this project lives in the docs:

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Spec Compliance](docs/SPECIFICATION.md): WebHID spec compliance report with item-level evidence
- [Data Path Analysis](docs/DATA_PATH.md): per-path copy/hop/latency breakdown, cost model, optimization inventory
- [Benchmark Report](docs/BENCHMARK.md): automated image-pipeline and 8000Hz loss benchmarks (ws/nm/wt/wt-inpage, Chromium native), per-report latency + walltime results, RDP profiling
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging
- [Installation Guide](docs/INSTALLATION.md): platform-specific install instructions and recommended settings
