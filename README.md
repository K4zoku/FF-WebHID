# WebHID Project

WebHID brings Human Interface Device (HID) support to browsers and native applications on Linux, enabling seamless communication between web applications and HID devices (such as keyboards, gamepads, and more) via a native-messaging bridge and a background daemon.

## Project Structure

- **crates/**: Rust workspace containing the core libraries and binaries:
  - `webhid`: Core library for HID communication.
  - `webhid-daemon`: Background service for device access.
  - `webhid-native-messaging`: Native messaging host for browser integration.
- **addon/**: Browser extension for Firefox/Zen, enabling WebHID API support.
- **packaging/**: Distribution packaging (AUR/PKGBUILD scripts).
- **test/**: Test utilities and scripts.
- **manifests/**: Additional manifest files for integration.

## Packaging (AUR)

AUR packaging is provided for both the daemon and browser extension:
- `packaging/webhid/PKGBUILD`: For the daemon and native messaging host.
- `packaging/webhid-addon/PKGBUILD`: For the browser extension.

**Note:** Only the `PKGBUILD` files are tracked in version control; all other build artifacts and install scripts are ignored.

## Development

- Rust crates use the standard [GitHub Rust .gitignore](https://github.com/github/gitignore/blob/main/Rust.gitignore).
- Each directory contains its own `.gitignore` as appropriate.
- See `DEVELOPMENT.md` for contribution and build instructions.

## Maintainers

- K4zoku <k4zoku@pm.me>

## License

This project is licensed under the MIT License. See `LICENSE` for details.
