# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox on Linux, macOS, and Windows. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

[![Firefox](https://img.shields.io/badge/Firefox-Get%20the%20Addon-0060E0?style=for-the-badge&logo=firefox&logoColor=FFBD4F)](https://addons.mozilla.org/en-US/firefox/addon/webhid/)

## Features

- **Full WebHID polyfill**: implements `navigator.hid` API in Firefox
- **High performance**: WebSocket + SharedArrayBuffer data plane with fire-and-forget `sendReport` (~3ms avg latency)
- **Cross-platform HID**: Linux (hidraw + udev), macOS (IOHIDManager), Windows (native HID API + RegisterDeviceNotification)
- **Report descriptor parser**: WASM-based (hidreport crate) with JS fallback, produces Chromium-shaped collections
- **Stable device IDs**: platform-independent hash, survives reboots
- **Auto-reconnect**: daemon restart, addon reload, WS disconnect, all handled automatically
- **Hot-plug**: event-driven on Linux (udev), macOS (IOHIDManager), and Windows (RegisterDeviceNotification + WM_DEVICECHANGE)
- **Security**: FIDO/U2F blocklist, localhost-only WebSocket, token authentication

## Install

For detailed installation instructions (system daemon, user-local setup, and browser extension), see [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Addon Settings

### Global settings

Open `about:addons → WebHID → Options`:
- **Daemon as NM host**: talk to the daemon directly over native messaging (skip the `webhid-native-messaging` forwarder and Unix socket). Requires the `webhid.daemon_nm_host` NM manifest to be installed and the daemon to run as your user with the udev rule (default OFF)
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **SharedArrayBuffer data plane**: WS + SAB hot path for high-performance I/O (default ON; disable if a site breaks due to COOP/COEP)
- **SAB Buffer Capacity**: ring-buffer slots (2048–32768, default 8192)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)
- **Performance timing**: timing messages in console

### Per-site settings (Will override global settings for the site you're currently on)

Click on the WebHID addon icon:
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **SharedArrayBuffer data plane**: WS + SAB hot path for high-performance I/O (default ON; disable if a site breaks due to COOP/COEP)
- **SAB Buffer Capacity**: ring-buffer slots (2048–32768, default 8192)

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging

## License

MIT
