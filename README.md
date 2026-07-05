# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox on Linux. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

**Install the addon:** [addons.mozilla.org/en-US/firefox/addon/ff-webhid](https://addons.mozilla.org/en-US/firefox/addon/ff-webhid/)

## Features

- **Full WebHID polyfill** — implements `navigator.hid` API in Firefox
- **High performance** — WebSocket + SharedArrayBuffer data plane with fire-and-forget `sendReport` (~3ms avg latency)
- **Cross-platform HID** — uses [hidapi](https://github.com/libusb/hidapi) (Linux hidraw, Windows/macOS ready)
- **Stable device IDs** — platform-independent hash, survives reboots
- **Auto-reconnect** — daemon restart, addon reload, WS disconnect — all handled automatically
- **Hot-plug** — udev-based device connect/disconnect events (Linux), polling (Windows/macOS)
- **Security** — FIDO/U2F blocklist, localhost-only WebSocket, token authentication

## Install

### 1. System daemon

```sh
cargo build --release --manifest-path crates/Cargo.toml
sudo ./scripts/install.sh
systemctl status webhid-daemon
```

Or on Arch Linux:
```sh
cd packaging/webhid && makepkg -si
```

### 2. Hardware permissions

```sh
echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-webhid.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

The packaged systemd unit runs the daemon as root (no udev rule needed).

### 3. Browser extension

Install from AMO: [FF-WebHID](https://addons.mozilla.org/en-US/firefox/addon/ff-webhid/)

Or load manually via `about:debugging → Load Temporary Add-on → addon/manifest.json`.

## Settings

Open `about:addons → FF WebHID → Options`:
- **Performance logging** — timing messages in console
- **Fire-and-forget sendReport** — resolve Promise immediately, no daemon ack wait (default ON)
- **SharedArrayBuffer data plane** — WS + SAB hot path for high-performance I/O (default ON; disable if a site breaks due to COOP/COEP)

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, data plane, security, reconnect
- [Development Guide](docs/DEVELOPMENT.md) — building, testing, debugging, packaging

## License

MIT
