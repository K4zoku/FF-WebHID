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

### 1. System daemon

The daemon ships as a systemd service that runs as root, so it already has
access to all hidraw devices, so no udev rule is needed.

```sh
sudo make install-system
systemctl daemon-reload && systemctl enable --now webhid-daemon
```

Or on Arch Linux:
```sh
cd packaging/webhid && makepkg -si
```

### 1b. User-local install (no root)

Run the daemon as your own user instead of root. This needs a one-time udev
rule so your user can open hidraw devices.

```sh
make install-user
sudo make install-udev-rule    # one-time, grants hidraw access to your user
systemctl --user daemon-reload
systemctl --user enable --now webhid-daemon
```

Install paths are configurable: `make install-system PREFIX=/usr` or
`make install-user USER_PREFIX=$HOME/.local`.

### 2. Browser extension

Install from AMO: [WebHID](https://addons.mozilla.org/en-US/firefox/addon/webhid/)

Or load manually via `about:debugging → Load Temporary Add-on → addon/manifest.json`.

## Settings

Open `about:addons → FF WebHID → Options`:
- **Performance logging**: timing messages in console
- **Fire-and-forget sendReport**: resolve Promise immediately, no daemon ack wait (default ON)
- **SharedArrayBuffer data plane**: WS + SAB hot path for high-performance I/O (default ON; disable if a site breaks due to COOP/COEP)
- **SAB Buffer Capacity**: ring-buffer slots (2048–32768, default 8192)
- **Log Level**: console output verbosity (Error/Warn/Info/Debug)

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design, data plane, security, reconnect
- [Development Guide](docs/DEVELOPMENT.md): building, testing, debugging, packaging

## License

MIT
