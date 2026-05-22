# WebHID for Firefox

WebHID brings Human Interface Device (HID) support to Firefox and other Gecko-based browsers on Linux. This allows websites to interact directly with hardware like game controllers, stream decks, and specialized input devices that are not natively supported by Firefox.

## Features

- **Full Polyfill:** Implements the standard `navigator.hid` API in the browser.
- **High Performance:** Designed to support high-polling rate devices (up to 8000 Hz) with minimal latency.
- **System Integration:** Runs as a secure system daemon to manage hardware access on behalf of the browser.

## Getting Started

To use WebHID in your browser, you need to install the system components and the browser extension.

### 1. Install System Components

The project includes an automated installation script that sets up the background daemon and the communication bridge.

1. Open a terminal in the project directory.
2. Run the installation script:
   ```sh
   sudo ./manifests/install.sh
   ```
3. Ensure the service is running:
   ```sh
   systemctl status webhid-daemon
   ```

### 2. Configure Hardware Permissions

Linux requires explicit permission to access raw HID devices. You can grant access to the currently logged-in user by adding a udev rule:

1. Create the rule file:
   ```sh
   echo 'SUBSYSTEM=="hidraw", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/99-webhid.rules
   ```
2. Apply the new rules:
   ```sh
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```

### 3. Install the Browser Extension

Install the WebHID extension to enable the API in your browser.

- **Arch Linux:** Build and install the package from `packaging/webhid-addon/PKGBUILD`.
- **Manual:** Load the extension from the `dist/` directory or follow your distribution's specific guide for installing Firefox system extensions.

## How to Use

Once installed, compatible websites will be able to detect and interact with your HID devices. When a website requests access, a device picker will appear allowing you to select which hardware to share with the site.

---

**For Developers:** If you want to build from source, contribute, or understand the architecture, please refer to the [Development Guide (DEVELOPMENT.md)](DEVELOPMENT.md).
