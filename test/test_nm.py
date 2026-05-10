#!/usr/bin/env python3
"""
test_nm.py – Test the webhid-native-messaging bridge end-to-end.

Spawns the binary, sends Firefox-style native-messaging requests, and
checks the responses.  The daemon must be running.

Usage:
    # Installed package:
    python3 test/test_nm.py

    # From repo (daemon on custom socket):
    WEBHID_SOCKET=/tmp/webhid.sock \\
    WEBHID_NM=./crates/target/release/webhid-native-messaging \\
        python3 test/test_nm.py
"""

import json
import os
import select
import struct
import subprocess
import sys

NM_BIN  = os.environ.get("WEBHID_NM",     "webhid-native-messaging")
SOCKET  = os.environ.get("WEBHID_SOCKET", "/run/webhid/webhid.sock")

# ──────────────────────────────────────────────────────────────────────────────
# Native-messaging client (mirrors what Firefox does on stdin/stdout)
# ──────────────────────────────────────────────────────────────────────────────

class NmClient:
    def __init__(self, binary: str, socket_path: str):
        env = {**os.environ, "WEBHID_SOCKET": socket_path, "RUST_LOG": "warn"}
        self.proc = subprocess.Popen(
            [binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,      # show daemon/NM process logs inline
            env=env,
        )

    def send(self, obj: dict):
        data = json.dumps(obj).encode()
        self.proc.stdin.write(struct.pack("<I", len(data)))
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def recv(self, timeout: float = 5.0) -> dict:
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError(
                f"No response after {timeout:.0f}s – "
                "is the daemon running?  →  systemctl status webhid-daemon"
            )
        raw_len = self.proc.stdout.read(4)
        if len(raw_len) < 4:
            raise EOFError("native-messaging process exited unexpectedly")
        length = struct.unpack("<I", raw_len)[0]
        data = self.proc.stdout.read(length)
        return json.loads(data)

    def request(self, obj: dict, timeout: float = 5.0) -> dict:
        self.send(obj)
        # Drain any unsolicited events (event_type != None) and return
        # the first proper response (has 'success' key).
        while True:
            resp = self.recv(timeout=timeout)
            if "event_type" in resp:
                info(f"(event received while waiting: {resp['event_type']})")
                continue
            return resp

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=3)


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
    print(f"\n\033[1mWebHID Native-Messaging Bridge Test\033[0m")
    print(f"Binary : {NM_BIN}")
    print(f"Socket : {SOCKET}")
    print("─" * 52)

    # 1. Spawn -----------------------------------------------------------------
    head("1 · Spawn native-messaging process")
    try:
        client = NmClient(NM_BIN, SOCKET)
        ok("Process started")
    except FileNotFoundError:
        fail(
            f"Binary not found: {NM_BIN}\n"
            "  Install:  sudo pacman -S webhid\n"
            "  Or set:   WEBHID_NM=crates/target/release/webhid-native-messaging"
        )

    # 2. Enumerate -------------------------------------------------------------
    head("2 · Enumerate  (action=enumerate)")
    try:
        resp = client.request({"action": "enumerate"})
    except TimeoutError as e:
        fail(str(e))

    if not resp.get("success"):
        fail(f"Enumerate failed: {resp.get('error')}")

    devices = resp.get("devices", [])
    ok(f"{len(devices)} device(s)")

    for d in devices:
        vid, pid = d["vendor_id"], d["product_id"]
        name = d.get("product_name") or "?"
        path = d["path"]
        info(f"{vid:04x}:{pid:04x}  {name:<30s}  {path}")

    if not devices:
        info("No HID devices found.  Plug one in and re-run.")
        client.close()
        return

    # 3. Open ------------------------------------------------------------------
    dev = devices[0]
    head(f"3 · Open  (vendor={dev['vendor_id']:04x} product={dev['product_id']:04x})")
    resp = client.request({
        "action":     "open",
        "vendor_id":  dev["vendor_id"],
        "product_id": dev["product_id"],
    })

    if not resp.get("success"):
        fail(
            f"Open failed: {resp.get('error')}\n"
            "  Check daemon has permission to open the hidraw device.\n"
            "  Add udev rule or run daemon as root."
        )

    # The addon encodes the device path as char codes in 'data'.
    device_id = bytes(resp["data"]).decode()
    ok(f"Opened  →  device_id = {device_id!r}")

    # 4. Read ------------------------------------------------------------------
    head("4 · Read  (timeout=500 ms)")
    resp = client.request({
        "action":  "read",
        "data":    list(device_id.encode()),
        "timeout": 500,
    }, timeout=3.0)

    if resp.get("success"):
        data = resp["data"]
        hex_str = " ".join(f"{b:02x}" for b in data[:16])
        suffix  = "…" if len(data) > 16 else ""
        ok(f"Read {len(data)} byte(s):  {hex_str}{suffix}")
    else:
        err = resp.get("error", "")
        if "timed out" in err.lower():
            info("Timed out – device was idle (normal)")
        else:
            info(f"Read error: {err}")

    # 5. Write -----------------------------------------------------------------
    head("5 · Write  (0x00 report byte)")
    resp = client.request({
        "action":    "write",
        "device_id": list(device_id.encode()),
        "data":      [0x00],
    })

    if resp.get("success"):
        ok("Write acknowledged")
    else:
        info(f"Write error: {resp.get('error')}  (device may be read-only)")

    # 6. Close -----------------------------------------------------------------
    head("6 · Close")
    resp = client.request({
        "action": "close",
        "data":   list(device_id.encode()),
    })

    if resp.get("success"):
        ok("Closed")
    else:
        fail(f"Close failed: {resp.get('error')}")

    client.close()
    print(f"\n  \033[32;1mAll tests passed.\033[0m\n")


if __name__ == "__main__":
    main()
