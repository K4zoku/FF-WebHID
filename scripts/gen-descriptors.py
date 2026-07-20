#!/usr/bin/env python3
"""Generate sample HID report descriptors for uhid-mock tests.

Each descriptor is a minimal but valid HID report descriptor that hidapi
+ the daemon can parse. Output files are raw binary, written to
tests/fixtures/descriptors/.
"""

from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "descriptors"
EDGE_DIR = OUT_DIR / "edge"


# HID item helpers
def usage_page(p):
    if p > 0xFF:
        return bytes([0x06, p & 0xFF, (p >> 8) & 0xFF])
    return bytes([0x05, p])

def usage(u):
    if u > 0xFF:
        return bytes([0x0A, u & 0xFF, (u >> 8) & 0xFF])
    return bytes([0x09, u])

def collection(t=1):        return bytes([0xA1, t])  # 1=Application, 0=Physical
def end_collection():        return bytes([0xC0])
def report_id(r):            return bytes([0x85, r])
def report_size(s):          return bytes([0x75, s])
def report_count(c):         return bytes([0x95, c])
def input_data(flags=0x02):  return bytes([0x81, flags])  # Data,Var,Abs
def output_data(flags=0x02): return bytes([0x91, flags])
def logical_min(v):          
    if -128 <= v <= 127:     return bytes([0x15, v & 0xFF])
    elif -32768 <= v <= 32767: return bytes([0x16, v & 0xFF, (v >> 8) & 0xFF])
    else:                     return bytes([0x17, v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF])
def logical_max(v):
    if 0 <= v <= 255:        return bytes([0x25, v & 0xFF])
    elif 0 <= v <= 65535:    return bytes([0x26, v & 0xFF, (v >> 8) & 0xFF])
    else:                     return bytes([0x27, v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF])
def unit_exponent(e):        return bytes([0x55, e & 0xFF])
def unit_bytes(b):           return bytes([0x65, len(b), *b])
def usage_minimum(u):        return bytes([0x18, u]) if u <= 0xFF else bytes([0x19, u & 0xFF, (u >> 8) & 0xFF])
def usage_maximum(u):        return bytes([0x28, u]) if u <= 0xFF else bytes([0x29, u & 0xFF, (u >> 8) & 0xFF])


def mouse_descriptor():
    """Minimal HID mouse: 3 buttons + X/Y (8-bit each)."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + usage(0x01) + collection(0)
        + report_size(1) + report_count(3)
        + usage_page(0x09)
        + usage(1) + usage(2) + usage(3)
        + input_data()
        + report_size(1) + report_count(5)
        + input_data()
        + report_size(8) + report_count(2)
        + usage_page(0x01)
        + usage(0x30) + usage(0x31)
        + input_data()
        + end_collection() + end_collection()
    )


def keyboard_descriptor():
    """Minimal HID keyboard: 8-byte input report."""
    return (
        usage_page(0x01) + usage(0x06) + collection()
        + report_size(1) + report_count(8)
        + usage_page(0x07)
        + usage(0xE0) + usage(0xE1) + usage(0xE2) + usage(0xE3)
        + usage(0xE4) + usage(0xE5) + usage(0xE6) + usage(0xE7)
        + input_data()
        + report_size(8) + report_count(1) + input_data()
        + report_size(8) + report_count(6)
        + usage(0x00) + input_data()
        + end_collection()
    )


def vendor_descriptor():
    """Vendor-specific device with multiple top-level collections."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + usage(0x01) + collection(0)
        + report_size(8) + report_count(3)
        + usage_page(0x01)
        + usage(0x30) + usage(0x31) + usage(0x38)
        + input_data()
        + end_collection() + end_collection()
        + report_id(1)
        + usage_page(0xff1c) + usage(0x92)
        + collection()
        + report_size(8) + report_count(64)
        + usage(0x01)
        + input_data() + output_data()
        + end_collection()
    )


def gamepad_descriptor():
    """Standard HID gamepad (Generic Desktop / Joystick)."""
    return (
        usage_page(0x01) + usage(0x04) + collection()
        + report_size(8) + report_count(4)
        + usage(0x01) + usage(0x30) + usage(0x31) + usage(0x32) + usage(0x35)
        + input_data()
        + report_size(1) + report_count(8)
        + usage_page(0x09)
        + usage(1) + usage(2) + usage(3) + usage(4) + usage(5) + usage(6) + usage(7) + usage(8)
        + input_data()
        + end_collection()
    )


DESCRIPTORS = {
    "mouse.bin":    mouse_descriptor(),
    "keyboard.bin": keyboard_descriptor(),
    "vendor.bin":   vendor_descriptor(),
    "gamepad.bin":  gamepad_descriptor(),
}


# ── Edge case / malformed descriptors ───────────────────────────────────
# Each must NOT crash or panic the daemon.  Some are intentionally invalid
# HID descriptors — they should produce empty collections or non-crashing
# output.  Others are valid but extreme.

# HID item tag helpers for manual byte construction
SHORT_INPUT = 0x81       # Input item, size=1
SHORT_OUTPUT = 0x91      # Output item, size=1
SHORT_COLLECTION = 0xA1  # Collection, size=1
END_COLL = 0xC0           # End Collection, size=0
LONG_ITEM = 0xFE          # Long item tag


def edge_empty():
    return b""


def edge_single_byte():
    return bytes([0xFF])


def edge_truncated_input():
    """Input item tag 0x81 requires 1 data byte — missing."""
    return bytes([0x81])


def edge_truncated_long_item():
    """Long item (0xFE) with length=255 but no data follows."""
    return bytes([LONG_ITEM, 0xFF])


def edge_unclosed_collection():
    """Application collection with an input report, but no End Collection."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(8) + report_count(1)
        + usage_page(0x09) + usage(1)
        + input_data()
        # missing end_collection()
    )


def edge_extra_end_collection():
    """End Collection without a matching open collection."""
    return bytes([END_COLL])


def edge_deep_nesting():
    """32 levels of nested Application collections — stress recursive walk.

    Only the innermost level has a real input report.
    """
    desc = bytearray()
    for _ in range(32):
        desc.extend(usage_page(0x01))
        desc.extend(usage(0x02))
        desc.extend(collection())
    # Innermost: 1-byte input
    desc.extend(report_size(8))
    desc.extend(report_count(1))
    desc.extend(usage_page(0x09))
    desc.extend(usage(1))
    desc.extend(input_data())
    # Close all
    for _ in range(32):
        desc.extend(end_collection())
    return bytes(desc)


def edge_report_size_zero():
    """Report Size = 0 → saturating_mul gives 0, div_ceil gives 0."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(0) + report_count(64)
        + usage_page(0x09) + usage(1)
        + logical_min(0) + logical_max(1)
        + input_data()
        + end_collection()
    )


def edge_report_count_zero():
    """Report Count = 0 → no bytes consumed."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(8) + report_count(0)
        + usage_page(0x09) + usage(1)
        + logical_min(0) + logical_max(1)
        + input_data()
        + end_collection()
    )


def edge_logical_max_ffffffff():
    """Logical Maximum = 0xFFFFFFFF (32-bit max, valid for uint32)."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(8) + report_count(1)
        + usage_page(0x09) + usage(1)
        + logical_min(0)
        + bytes([0x27, 0xFF, 0xFF, 0xFF, 0xFF])  # Logical Maximum (32-bit)
        + input_data()
        + end_collection()
    )


def edge_multiple_report_ids():
    """Three input reports with Report IDs 1, 2, 3."""
    report = (
        usage_page(0x01) + usage(0x02) + collection()
        + usage(0x01) + collection(0)
    )
    for rid in [1, 2, 3]:
        report += (
            report_id(rid)
            + report_size(8) + report_count(4)
            + usage_page(0x01) + usage(0x30) + usage(0x31) + usage(0x32) + usage(0x35)
            + input_data()
        )
    report += end_collection() + end_collection()
    return report


def edge_usage_page_ffff():
    """Usage Page = 0xFFFF — edge case for pack_usage()."""
    return (
        usage_page(0xFFFF) + usage(0xFFFF)
        + collection()
        + report_size(8) + report_count(1)
        + usage_page(0xFFFF)
        + usage(0x01)
        + logical_min(0) + logical_max(255)
        + input_data()
        + end_collection()
    )


def edge_report_size_max():
    """Report Size = 32, Report Count = 65535 → huge but saturating math."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(32) + report_count(0xFF)  # 32-bit items use size=2+extended
        + usage_page(0x09) + usage(1)
        + logical_min(0) + logical_max(0xFFFFFFFF)
        + input_data()
        + end_collection()
    )


def edge_collection_only():
    """Valid descriptor with only a collection header, no reports.
    Tests the fallback-collection injection in build()."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + end_collection()
    )


def edge_unit_exponent_overflow():
    """Unit exponent = 15 (max nibble value)."""
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(8) + report_count(1)
        + usage_page(0x09) + usage(1)
        + logical_min(0) + logical_max(255)
        + unit_exponent(0x0F)  # exponent = 15
        + input_data()
        + end_collection()
    )


def edge_vendor_extended_usage():
    """Vendor page with array-type input report (uses usage_minimum/maximum)."""
    return (
        usage_page(0xFF00) + usage(0x01)
        + collection()
        + report_size(8) + report_count(16)
        + usage_minimum(0x01) + usage_maximum(0x10)
        + logical_min(0) + logical_max(255)
        + input_data(0x00)  # Data,Array,Abs
        + end_collection()
    )


def edge_valid_has_output_but_no_input():
    """Valid descriptor with only Output reports — no Input reports.
    max_input_report_size should return 0.
    """
    return (
        usage_page(0x01) + usage(0x06) + collection()
        + report_size(8) + report_count(8)
        + usage_page(0x07)
        + usage(0xE0) + usage(0xE1) + usage(0xE2) + usage(0xE3)
        + usage(0xE4) + usage(0xE5) + usage(0xE6) + usage(0xE7)
        + output_data()   # ← Output, not Input!
        + end_collection()
    )


def edge_variable_after_array():
    """Array field followed by Variable field in same report — tests
    field-aggregation switching between types.
    """
    return (
        usage_page(0x01) + usage(0x02) + collection()
        + report_size(8) + report_count(4)
        + usage_page(0x07)
        + usage_minimum(0x00) + usage_maximum(0x03)
        + logical_min(0) + logical_max(255)
        + input_data(0x00)  # Data,Array,Abs
        + report_size(8) + report_count(2)
        + usage_page(0x01)
        + usage(0x30) + usage(0x31)
        + input_data(0x02)  # Data,Var,Abs
        + end_collection()
    )


EDGE_DESCRIPTORS = {
    "empty.bin":                     edge_empty(),
    "single-byte.bin":               edge_single_byte(),
    "truncated-input.bin":           edge_truncated_input(),
    "truncated-long-item.bin":       edge_truncated_long_item(),
    "unclosed-collection.bin":       edge_unclosed_collection(),
    "extra-end-collection.bin":      edge_extra_end_collection(),
    "deep-nesting.bin":              edge_deep_nesting(),
    "report-size-zero.bin":          edge_report_size_zero(),
    "report-count-zero.bin":         edge_report_count_zero(),
    "logical-max-ffffffff.bin":       edge_logical_max_ffffffff(),
    "multiple-report-ids.bin":       edge_multiple_report_ids(),
    "usage-page-ffff.bin":           edge_usage_page_ffff(),
    "report-size-max.bin":           edge_report_size_max(),
    "collection-only.bin":           edge_collection_only(),
    "unit-exponent-overflow.bin":    edge_unit_exponent_overflow(),
    "vendor-extended-usage.bin":     edge_vendor_extended_usage(),
    "valid-no-input-reports.bin":    edge_valid_has_output_but_no_input(),
    "variable-after-array.bin":      edge_variable_after_array(),
}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, desc in DESCRIPTORS.items():
        path = OUT_DIR / name
        path.write_bytes(desc)
        print(f"wrote {path} ({len(desc)} bytes)")

    EDGE_DIR.mkdir(parents=True, exist_ok=True)
    for name, desc in EDGE_DESCRIPTORS.items():
        path = EDGE_DIR / name
        path.write_bytes(desc)
        print(f"wrote {path} ({len(desc)} bytes)")


if __name__ == "__main__":
    main()
