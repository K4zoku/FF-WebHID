# uhid-mock

Virtual HID device mocker for FF-WebHID end-to-end tests. **Linux-only** — uses
the kernel's `/dev/uhid` interface to instantiate HID devices that real
clients (`webhid-daemon`, hidapi, Firefox) see as if they were physical
hardware.

## Why

Testing WebHID behavior end-to-end used to require plugging in real devices.
`uhid-mock` lets us:

- Spawn a virtual mouse / keyboard / gamepad / vendor-specific device with a
  known report descriptor.
- Inject input reports on demand from a script.
- Assert that the picker dialog, the daemon, and the polyfill all behave per
  spec — without hardware.
- Test hot-plug (udev add/remove) by spawning / killing the mock process.
- Reproduce issue #2 (filter against vendor-specific collection on a
  multi-collection device) without the actual hardware.

## Build

```sh
cargo build --manifest-path crates/Cargo.toml -p uhid-mock
# → crates/target/debug/uhid-mock
```

The binary is Linux-only. On macOS/Windows it compiles to a no-op that
prints an error and exits 1 — this lets it stay in the workspace without
breaking cross-platform CI.

## Running

`/dev/uhid` requires write permission. Either run as root, or add a udev
rule granting your user/group access:

```sh
# /etc/udev/rules.d/99-uhid-mock.rules
KERNEL=="uhid", SUBSYSTEM=="misc", GROUP="webhid", MODE="0660"
```

Then reload: `sudo udevadm control --reload && sudo udevadm trigger`.

### Basic usage

```sh
uhid-mock spawn \
  --vid 0x3554 --pid 0xf58c \
  --name "VXE R1 PRO Mock" \
  --descriptor tests/fixtures/descriptors/vendor.bin \
  --usage-page 0xff1c \
  --usage 0x92
```

The binary:

1. Opens `/dev/uhid`.
2. Sends `UHID_CREATE2` to instantiate the virtual device.
3. Prints a `{"event":"ready", ...}` JSON line on stdout.
4. Reads JSON commands from stdin, one per line.
5. On stdin EOF, sends `UHID_DESTROY` and exits.

### Stdin commands

```jsonc
// Numbered report (report ID 1, payload [171,187,204]):
{"cmd":"input","reportId":1,"data":[171,187,204]}
// → binary prepends the ID, sends [1, 171, 187, 204] as UHID_INPUT2.

// Non-numbered report (payload [171,187,204] sent as-is):
{"cmd":"input","data":[171,187,204]}

// Report ID only (1-byte report):
{"cmd":"input","reportId":1}

{"cmd":"ping"}
// → responds with {"event":"pong"} on stdout. Useful for handshake tests.

{"cmd":"destroy"}
// → sends UHID_DESTROY and exits.
```

`reportId` is optional. If present, it's prepended to `data`. If absent,
`data` is sent as-is (for non-numbered-report devices). At least one of
`reportId` / `data` must be present.

### Stdout events (kernel → userspace)

The binary echoes every kernel event as JSON on stdout, one per line:

```jsonc
{"event":"ready","vid":13652,"pid":62860,"name":"VXE R1 PRO Mock","usagePage":65308,"usage":146}
{"event":"uhid_start"}
{"event":"uhid_open"}              // daemon opened the hidraw device
{"event":"uhid_close"}             // daemon closed it
{"event":"output_report","data":[1,2,3]}  // host → device output report
{"event":"get_report"}             // host queried a feature report (we don't reply)
{"event":"set_report"}             // host wrote a feature report
{"event":"input_sent","reportId":1,"size":4}  // ack for our input command
{"event":"pong"}                   // ack for ping
{"event":"error","error":"..."}    // command parse / write failure
{"event":"uhid_stop"}              // kernel signalled stop (usually our destroy)
```

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

Regenerate with `python3 scripts/gen-descriptors.py`.

## Example: spawn + inject input report

```sh
mkfifo /tmp/uhid-mock-cmd
uhid-mock spawn -v 0x3554 -p 0xf58c -d tests/fixtures/descriptors/vendor.bin \
  < /tmp/uhid-mock-cmd > /tmp/uhid-mock-events.jsonl &
exec 3>/tmp/uhid-mock-cmd

# Wait for ready
head -1 /tmp/uhid-mock-events.jsonl   # → {"event":"ready",...}

# Inject a 4-byte input report (report ID 1 + 3 payload bytes)
echo '{"cmd":"input","reportId":1,"data":[1,2,3]}' >&3

# Tear down
echo '{"cmd":"destroy"}' >&3
exec 3>&-
```

In Playwright tests (Phase B), the same flow is driven from Node.js via a
child process spawned with `stdin`/`stdout` pipes — no named FIFO needed.

## What's NOT implemented (intentionally)

- **Feature report replies** (`UHID_GET_REPORT_REPLY`): we log the query but
  don't reply. Tests that need feature reports can extend the binary.
- **Output-ev events** (force feedback): out of scope for HID input testing.
- **Windows / macOS support**: no equivalent kernel interface. E2E tests
  for those platforms would need a different mocking strategy (e.g. virtual
  driver on Windows, IOHIDDevice shim on macOS) — left for a future phase.

## Security

`/dev/uhid` is a powerful kernel interface — anyone with write access can
create arbitrary HID devices and capture output reports the host sends to
them. The recommended udev rule above restricts access to a dedicated group
(`webhid`), matching the same group the daemon uses for `/dev/hidraw*`.

Do **not** run `uhid-mock` as root in production-like environments. It is a
test tool, intended for CI and developer machines only.
