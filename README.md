# FF-WebHID

WebHID brings Human Interface Device (HID) support to Firefox-based browsers and native applications on Linux. The project consists of:

- a Firefox addon that polyfills `navigator.hid` (`addon/`)
- a native-messaging host that bridges the browser to a local daemon (`crates/webhid-native-messaging`)
- a long-running system daemon that owns `/dev/hidraw*` access (`crates/webhid-daemon`)
- shared Rust library code (`crates/webhid`)

This README explains how to build the components, run them for development, load the addon into Firefox, and install the components for long-term use.

## Requirements

- Rust (cargo) — tested with Rust >= 1.85
- `zip` (to build the addon XPI)

On Arch Linux you can install the essentials with:

```/home/kazoku/Repositories/WebHID/README.md#L1-4
sudo pacman -S rust zip
```

## Building

1. Build the Rust workspace (debug or release):

```/home/kazoku/Repositories/WebHID/README.md#L1-4
# Debug build (fast)
cargo build --manifest-path crates/Cargo.toml

# Release build (optimized)
cargo build --release --manifest-path crates/Cargo.toml
```

2. Build the Firefox addon XPI:

```/home/kazoku/Repositories/WebHID/README.md#L1-5
# from the repository root
scripts/build-addon.sh
```

The addon XPI will be created at `dist/webhid-addon.xpi`.

## Running for development

You normally run the daemon and then either let Firefox spawn the native-messaging host, or run the native-messaging host manually for testing.

Terminal 1 — daemon

The daemon requires access to `/dev/hidraw*`. During development the easiest options are:

- Run as root:

```/home/kazoku/Repositories/WebHID/README.md#L1-2
sudo RUST_LOG=debug crates/target/debug/webhid-daemon
```

- Grant device access via udev (recommended): create the rule `/etc/udev/rules.d/99-webhid.rules` with:

```/home/kazoku/Repositories/WebHID/README.md#L1-3
# /etc/udev/rules.d/99-webhid.rules
SUBSYSTEM=="hidraw", TAG+="uaccess"
```

Then reload rules and run the daemon normally:

```/home/kazoku/Repositories/WebHID/README.md#L1-2
sudo udevadm control --reload-rules
sudo udevadm trigger

# run without sudo
RUST_LOG=debug crates/target/debug/webhid-daemon
```

Terminal 2 — (optional) native messaging host for manual testing

Firefox will spawn the native messaging host automatically when the addon connects. To test the host without Firefox you can run:

```/home/kazoku/Repositories/WebHID/README.md#L1-3
WEBHID_NM=crates/target/debug/webhid-native-messaging \
  python3 test/test_nm.py
```

## Load the addon in Firefox (temporary)

1. Build the addon using `scripts/build-addon.sh` (see above).
2. Open `about:debugging` in Firefox.
3. Click **This Firefox** → **Load Temporary Add-on…**.
4. Select `dist/webhid-addon.xpi`.

The addon will remain loaded until you close Firefox or remove it from `about:debugging`.

## Install for long-term usage (recommended for end-users)

For persistent, system-wide use you should install the daemon and native-messaging host, register the native-messaging manifest system-wide, and install the addon via your distribution packaging or the provided packaging helpers.

Quick install (single-command, requires root):

```/home/kazoku/Repositories/WebHID/manifests/install.sh#L1-40
sudo ./manifests/install.sh
```

What `manifests/install.sh` does:

- Builds the release binaries and installs them to `/usr/local/bin`
- Installs the native-messaging manifest to `/usr/lib/mozilla/native-messaging-hosts` and the current user's `~/.mozilla/native-messaging-hosts`
- Installs and enables the `webhid-daemon` systemd service

After running the install script:

- The daemon will be running under systemd (viewable with `systemctl status webhid-daemon`)
- Firefox should find the native-messaging host automatically (restart Firefox if needed)

Udev rules

To allow non-root access to `/dev/hidraw*` for logged-in session users, install a udev rule. Create `/etc/udev/rules.d/99-webhid.rules` with:

```/home/kazoku/Repositories/WebHID/README.md#L1-2
SUBSYSTEM=="hidraw", TAG+="uaccess"
```

Reload rules and trigger:

```/home/kazoku/Repositories/WebHID/README.md#L1-2
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Installing the browser addon permanently

- On Arch Linux the provided `packaging/webhid-addon/PKGBUILD` builds and installs a system-wide XPI that is placed into the browser's system extensions directory. To build and install the package:

```/home/kazoku/Repositories/WebHID/packaging/webhid-addon/PKGBUILD#L1-4
cd packaging/webhid-addon
makepkg -si
```

- Alternatively, you can deploy the XPI to your distribution's supported system extension directory for Firefox (path varies per distro/browser). Packaging is recommended so the extension is tracked by the package manager.

Notes

- System-wide addon installation bypasses temporary loading and survives browser restarts. It typically requires placing an XPI in the browser's system extension directory or using your distribution's package manager.
- If you prefer to keep the addon in your profile but persistent across restarts, installing an XPI into your profile's extensions directory may work, but using packaging or the system extension path is more reliable.

## Per-user native-messaging manifest (manual alternative)

If you prefer not to run the install script, you can copy the native-messaging manifest manually for the current user. Create `~/.mozilla/native-messaging-hosts/webhid_server.json` with the following contents (note the `path` must be absolute and point at the installed or built binary):

```/home/kazoku/Repositories/WebHID/README.md#L1-8
{
  "name": "webhid_server",
  "description": "WebHID native messaging host",
  "path": "$(pwd)/crates/target/release/webhid-native-messaging",
  "type": "stdio",
  "allowed_extensions": ["webhid@firefox.org"]
}
```

Then restart Firefox.

## Testing

See `test/` for automated checks. The tests exercise three layers:

1. Daemon IPC: `python3 test/test_daemon.py`
2. Native-messaging bridge: `python3 test/test_nm.py` (or run with `WEBHID_NM` env pointing to the debug or release binary)
3. Browser UI: serve `test/index.html` and use the addon-loaded Firefox to exercise the WebHID API.

## Packaging

Packaging scripts for Arch Linux are in `packaging/`.

- To build and install the daemon package (Arch):

```/home/kazoku/Repositories/WebHID/packaging/webhid/PKGBUILD#L1-3
cd packaging/webhid
makepkg -si
```

- For the system-wide addon package (Arch):

```/home/kazoku/Repositories/WebHID/packaging/webhid-addon/PKGBUILD#L1-3
cd packaging/webhid-addon
makepkg -si
```

## Further reading

See `DEVELOPMENT.md` for a more detailed development guide and architecture notes.
