#!/usr/bin/env python3
"""
test_daemon.py – Test the webhid-daemon IPC socket directly.

The daemon must be running before you run this script.
Usage:
    # If installed as a package:
    python3 test/test_daemon.py

    # If running the daemon manually from the repo:
    WEBHID_SOCKET=/tmp/webhid.sock RUST_LOG=debug \\
        ./crates/target/release/webhid-daemon &
    WEBHID_SOCKET=/tmp/webhid.sock python3 test/test_daemon.py
"""

import json
import os
import socket
import struct
import sys

SOCKET_PATH = os.environ.get("WEBHID_SOCKET", "/run/webhid/webhid.sock")

# ──────────────────────────────────────────────────────────────────────────────
# IPC helpers
# ──────────────────────────────────────────────────────────────────────────────

class IpcClient:
    def __init__(self, path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)

    def send(self, obj: dict):
        data = json.dumps(obj).encode()
        self.sock.sendall(struct.pack("<I", len(data)) + data)

    def recv(self) -> dict:
        def read_exact(n):
            buf = b""
            while len(buf) < n:
                chunk = self.sock.recv(n - len(buf))
                if not chunk:
                    raise EOFError("daemon closed the connection")
                buf += chunk
            return buf

        length = struct.unpack("<I", read_exact(4))[0]
        return json.loads(read_exact(length))

    def request(self, obj: dict) -> dict:
        self.send(obj)
        return self.recv()

    def close(self):
        self.sock.close()


# ──────────────────────────────────────────────────────────────────────────────
# Pretty output helpers
# ──────────────────────────────────────────────────────────────────────────────

def ok(msg):   print(f"  \033[32m✓\033[0m {msg}")
def fail(msg): print(f"  \033[31m✗\033[0m {msg}"); sys.exit(1)
def info(msg): print(f"  \033[34m·\033[0m {msg}")
def head(msg): print(f"\n\033[1m[{msg}]\033[0m")


# ──────────────────────────────────────────────────────────────────────────────
# Test suite
# ──────────────────────────────────────────────────────────────────────────────

def main():
    print(f"\n\033[1mWebHID Daemon IPC Test\033[0m")
    print(f"Socket : {SOCKET_PATH}")
    print("─" * 52)

    # 1. Connect ---------------------------------------------------------------
    head("1 · Connect")
    try:
        client = IpcClient(SOCKET_PATH)
        ok("Connected to daemon")
    except FileNotFoundError:
        fail(
            f"Socket not found: {SOCKET_PATH}\n"
            "  Is the daemon running?  →  systemctl status webhid-daemon\n"
            "  Or start manually:      →  sudo webhid-daemon"
        )
    except PermissionError:
        fail(
            f"Permission denied: {SOCKET_PATH}\n"
            "  The socket has mode 0666 when the daemon creates it.\n"
            "  Check:  ls -la $(dirname {SOCKET_PATH})"
        )
    except Exception as e:
        fail(str(e))

    # 2. Enumerate -------------------------------------------------------------
    head("2 · Enumerate devices")
    try:
        resp = client.request({"type": "Enumerate", "id": 1})
    except Exception as e:
        fail(f"Request failed: {e}")

    if resp.get("type") != "Devices":
        fail(f"Unexpected response: {resp}")

    devices = resp.get("devices", [])
    ok(f"{len(devices)} device(s) found")

    for d in devices:
        vid, pid = d["vendor_id"], d["product_id"]
        name = d.get("product_name") or "?"
        mfr  = d.get("manufacturer")  or ""
        path = d["path"]
        info(f"{vid:04x}:{pid:04x}  {name:<28s}  {mfr:<20s}  {path}")

    if not devices:
        info("No HID devices detected.")
        info("Plug in a device and re-run, or check udev rules.")
        info("Daemon logs:  journalctl -u webhid-daemon -f")
        client.close()
        return

    # 3. Open ------------------------------------------------------------------
    dev = devices[0]
    head(f"3 · Open  {dev['path']}")
    resp = client.request({
        "type":       "Open",
        "id":         2,
        "vendor_id":  dev["vendor_id"],
        "product_id": dev["product_id"],
    })

    if resp.get("type") == "Error":
        fail(
            f"Open failed: {resp['message']}\n"
            "  Possible causes:\n"
            "  • No udev rule → add SUBSYSTEM==\"hidraw\", TAG+=\"uaccess\"\n"
            "  • Daemon not running as root → sudo webhid-daemon\n"
            "  • Device already open by another process"
        )
    elif resp.get("type") != "Opened":
        fail(f"Unexpected response: {resp}")

    device_id = resp["device_id"]
    ok(f"Opened  →  device_id = {device_id!r}")

    # 4. Read (short timeout) --------------------------------------------------
    head("4 · Read  (500 ms timeout)")
    resp = client.request({
        "type":       "Read",
        "id":         3,
        "device_id":  device_id,
        "timeout_ms": 500,
    })

    if resp.get("type") == "Data":
        data = resp["data"]
        hex_str = " ".join(f"{b:02x}" for b in data[:16])
        suffix  = "…" if len(data) > 16 else ""
        ok(f"Read {len(data)} byte(s):  {hex_str}{suffix}")
    elif resp.get("type") == "Error":
        msg = resp.get("message", "")
        if "timed out" in msg.lower():
            info("Timed out – device sent no data in 500 ms (normal for idle devices)")
        else:
            fail(f"Read error: {msg}")
    else:
        info(f"Response: {resp}")

    # 5. Write (no-op byte) ----------------------------------------------------
    head("5 · Write  (single 0x00 byte)")
    resp = client.request({
        "type":      "Write",
        "id":        4,
        "device_id": device_id,
        "report_id": 0,
        "data":      [0x00],
    })

    if resp.get("type") == "Ok":
        ok("Write acknowledged")
    elif resp.get("type") == "Error":
        info(f"Write returned error: {resp['message']}  (device may not support writes)")
    else:
        info(f"Response: {resp}")

    # 6. Close -----------------------------------------------------------------
    head("6 · Close")
    resp = client.request({
        "type":      "Close",
        "id":        5,
        "device_id": device_id,
    })

    if resp.get("type") != "Ok":
        fail(f"Close failed: {resp}")
    ok("Closed")

    client.close()
    print(f"\n  \033[32;1mAll tests passed.\033[0m\n")


if __name__ == "__main__":
    main()
