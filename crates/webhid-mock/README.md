# webhid-mock

Virtual HID device mocker for FF-WebHID end-to-end tests. Uses the OS's
userspace HID interface to instantiate HID devices that real clients
(`webhid-daemon`, hidapi, Firefox) see as if they were physical hardware.

Platform backends:

| Platform | Backend | Notes |
|----------|---------|-------|
| Linux    | `/dev/uhid` kernel interface | needs write permission (udev rule below) |
| macOS    | `IOHIDUserDevice` (IOKit)    | no root, no entitlement needed |
| Windows  | —                            | unsupported, see "Why not Windows" |

## Why

Testing WebHID behavior end-to-end used to require plugging in real devices.
`webhid-mock` lets us:

- Spawn a virtual mouse / keyboard / gamepad / vendor-specific device with a
  known report descriptor.
- Inject input reports on demand from a script.
- Assert that the picker dialog, the daemon, and the polyfill all behave per
  spec — without hardware.
- Test hot-plug (device add/remove) by spawning / killing the mock process.
- Reproduce issue #2 (filter against vendor-specific collection on a
  multi-collection device) without the actual hardware.

## Build

```sh
cargo build --manifest-path crates/Cargo.toml -p webhid-mock
# → crates/target/debug/webhid-mock
```

On Windows the crate compiles to a stub that prints an explanation and
exits 1 — this lets it stay in the workspace without breaking
cross-platform CI.

## Running

### Linux

`/dev/uhid` requires write permission. The repo ships
`manifests/99-webhid-e2e.rules`, which grants the `webhid` group write
access to `/dev/uhid` plus read/write on hidraw nodes of devices with VID
0x16C0 (the e2e mock VID), so both `webhid-mock` and the daemon run as a
normal user. One-time setup (root):

```sh
sudo make install-e2e-udev-rule   # installs the rule, creates the
                                  # 'webhid' group, adds $SUDO_USER to it
# log out/in (or 'newgrp webhid') once for group membership to take effect
```

### macOS

No setup needed: `IOHIDUserDevice` works from a regular user session
without root or entitlements. (The newer CoreHID `HIDVirtualDevice` API
would require Apple's `com.apple.developer.hid.virtual.device` entitlement;
the deprecated-but-working IOKit API is used instead.)

### Basic usage

```sh
webhid-mock spawn \
  --vid 0x3554 --pid 0xf58c \
  --name "VXE R1 PRO Mock" \
  --descriptor tests/fixtures/descriptors/vendor.bin \
  --usage-page 0xff1c \
  --usage 0x92
```

The binary:

1. Creates the virtual device (`UHID_CREATE2` on Linux,
   `IOHIDUserDeviceCreate` on macOS).
2. Prints a `{"event":"ready", ...}` JSON line on stdout.
3. Reads JSON commands from stdin, one per line.
4. On stdin EOF, destroys the device and exits.

### Stdin commands

```jsonc
// Numbered report (report ID 1, payload [171,187,204]):
{"cmd":"input","reportId":1,"data":[171,187,204]}
// → binary prepends the ID, sends [1, 171, 187, 204] as the input report.

// Non-numbered report (payload [171,187,204] sent as-is):
{"cmd":"input","data":[171,187,204]}

// Report ID only (1-byte report):
{"cmd":"input","reportId":1}

{"cmd":"ping"}
// → responds with {"event":"pong"} on stdout. Useful for handshake tests.

{"cmd":"destroy"}
// → destroys the device and exits.
```

`reportId` is optional. If present, it's prepended to `data`. If absent,
`data` is sent as-is (for non-numbered-report devices). At least one of
`reportId` / `data` must be present.

### Stdout events (OS → userspace)

The binary echoes OS events as JSON on stdout, one per line. Common subset
(emitted on both platforms):

```jsonc
{"event":"ready","vid":13652,"pid":62860,"name":"VXE R1 PRO Mock","usagePage":65308,"usage":146}
{"event":"output_report","data":[1,2,3]}  // host → device output report
{"event":"get_report","id":...}           // host queried a report
{"event":"set_report","id":...}           // host wrote a feature report
{"event":"input_sent","reportId":1,"size":4}  // ack for our input command
{"event":"pong"}                          // ack for ping
{"event":"error","error":"..."}           // command parse / write failure
```

For numbered reports, `output_report.data[0]` is the report ID on both
platforms (tests rely on this).

Linux additionally emits uhid lifecycle events: `uhid_start`, `uhid_open`,
`uhid_close`, `uhid_stop`, `uhid_error`. These have no macOS equivalent
(IOHIDUserDevice has no open/close callbacks); tests must not depend on
them if they are meant to run cross-platform.

Tests consume these with a simple line-buffered stdout parser.

## Fixtures

`tests/fixtures/descriptors/` ships pre-built report descriptors for the most
common test scenarios:

| File | Top-level collection(s) | Use case |
|------|-------------------------|----------|
| `mouse.bin`    | Generic Desktop / Mouse                          | Basic filter `{usagePage:1, usage:2}` test |
| `keyboard.bin` | Generic Desktop / Keyboard                       | Basic filter `{usagePage:1, usage:6}` test |
| `gamepad.bin`  | Generic Desktop / Joystick                       | `guessDeviceType() == "controller"` test |
| `vendor.bin`   | Mouse **+** Vendor-defined 0xff1c/0x92 (2 collections) | Issue #2 regression: filter must iterate `device.collections` |

Regenerate with `node scripts/gen-descriptors.mjs`.

## Example: spawn + inject input report

```sh
mkfifo /tmp/webhid-mock-cmd
webhid-mock spawn -v 0x3554 -p 0xf58c -d tests/fixtures/descriptors/vendor.bin \
  < /tmp/webhid-mock-cmd > /tmp/webhid-mock-events.jsonl &
exec 3>/tmp/webhid-mock-cmd

# Wait for ready
head -1 /tmp/webhid-mock-events.jsonl   # → {"event":"ready",...}

# Inject a 4-byte input report (report ID 1 + 3 payload bytes)
echo '{"cmd":"input","reportId":1,"data":[1,2,3]}' >&3

# Tear down
echo '{"cmd":"destroy"}' >&3
exec 3>&-
```

In Playwright tests, the same flow is driven from Node.js via a child
process spawned with `stdin`/`stdout` pipes — no named FIFO needed
(see `tests/helpers/e2e-process.ts`).

## Why not Windows

Windows has no userspace virtual-HID interface. Creating a virtual HID
device requires a kernel-mode driver (Virtual HID Framework / KMDF) or a
signed third-party driver package (vJoy, ViGEm — the latter archived).
Shipping/signing a driver is out of scope for a test tool, so the Windows
binary is a stub that explains this and exits 1. Run E2E tests on Linux or
macOS, or against real hardware.

## What's NOT implemented (intentionally)

- **Meaningful feature report data**: get-report queries are acknowledged
  with an empty/zero payload (Linux: `UHID_GET_REPORT_REPLY` with err=0;
  macOS: success return from the get-report callback). Tests that need real
  feature report data can extend the binary.
- **Output-ev / force feedback**: out of scope for HID input testing.

## Security

`/dev/uhid` is a powerful kernel interface: anyone with write access can
create arbitrary HID devices and capture output reports the host sends to
them. The e2e udev rule (`manifests/99-webhid-e2e.rules`) restricts access
to a dedicated group (`webhid`), matching the same group the daemon uses
for `/dev/hidraw*`. `IOHIDUserDevice` on macOS is similarly privileged in
effect (arbitrary virtual input devices), though it needs no special
permission.

Do **not** run `webhid-mock` as root in production-like environments. It is
a test tool, intended for CI and developer machines only.
