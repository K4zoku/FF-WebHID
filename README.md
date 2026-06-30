# WebHID for Firefox

WebHID brings Human Interface Device (HID) support to Firefox and other Gecko-based browsers on Linux. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

## Features

- **Full WebHID polyfill:** implements `navigator.hid` API in Firefox
- **High performance:** WebSocket + SharedArrayBuffer data plane with fire-and-forget `sendReport` (~3ms avg latency)
- **Cross-platform HID access:** uses [hidapi](https://github.com/libusb/hidapi) for device access (Linux hidraw, ready for Windows/macOS)
- **Stable device IDs:** platform-independent `device_id` hash, survives reboots
- **Auto-reconnect:** daemon restart, addon reload, WS disconnect — all handled automatically
- **Hot-plug:** udev-based device connect/disconnect events
- **System integration:** runs as a systemd daemon managing hardware access

## Getting Started

### 1. Build & install system components

```sh
# Build Rust binaries + addon XPI
cargo build --release --manifest-path crates/Cargo.toml
./scripts/build-addon.sh

# Install (daemon + NM manifest + systemd service)
sudo ./scripts/install.sh

# Verify daemon is running
systemctl status webhid-daemon
```

### 2. Configure hardware permissions

```sh
echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-webhid.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Alternatively, the packaged systemd unit runs the daemon as root (no udev rule needed).

### 3. Install the browser extension

- **Arch Linux:** `cd packaging/webhid-addon && makepkg -si`
- **Manual:** Load `dist/webhid-addon.xpi` as a temporary add-on via `about:debugging`
- **Temporary:** Load `addon/manifest.json` directly via `about:debugging → Load Temporary Add-on`

## Usage

Once installed, compatible websites will detect and interact with your HID devices. A device picker appears when a website requests access.

### Settings

Open the addon's options page (`about:addons → FF WebHID → Options`) to toggle:
- **Performance logging** — log `[worker]` timing messages to addon console
- **Fire-and-forget sendReport** — resolve Promise immediately without waiting for daemon ack (faster, default ON)

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture details, build instructions, and testing.

## License

MIT
