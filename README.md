# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox-based browsers and native applications on Linux, enabling seamless communication between web applications and HID devices (such as keyboards, gamepads, and more) via a native-messaging bridge and a background daemon.

## Project Structure

- **crates/**: Rust workspace containing the core libraries and binaries:
  - `webhid`: Core library for HID communication.
  - `webhid-daemon`: Background service for device access.
  - `webhid-native-messaging`: Native messaging host for browser integration.
- **addon/**: Browser extension for Firefox, enabling WebHID API support.
- **packaging/**: Distribution packaging (AUR/PKGBUILD scripts).
- **test/**: Test utilities and scripts.
- **manifests/**: Additional manifest files for integration.

## Packaging (AUR)

AUR packaging is provided for both the daemon and browser extension:
- `packaging/webhid/PKGBUILD`: For the daemon and native messaging host.
- `packaging/webhid-addon/PKGBUILD`: For the browser extension.

## Development

- See [DEVELOPMENT.md](DEVELOPMENT.md) for contribution and build instructions.
