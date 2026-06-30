#!/usr/bin/env sh
# install.sh – build and install webhid-daemon + webhid-native-messaging
#
# Usage:
#   sudo ./manifests/install.sh
#
# What this script does
# ---------------------
#  1. Builds both Rust binaries in release mode.
#  2. Copies them to /usr/local/bin/.
#  3. Installs the Firefox native-messaging manifest for every user, and
#     system-wide as a fallback.
#  4. Installs and starts the systemd daemon service.
#
# Prerequisites
#   - Rust toolchain (cargo)
#   - libudev-dev  (Debian/Ubuntu) or  systemd-devel  (Fedora/RHEL)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATES_DIR="$SCRIPT_DIR/../crates"
MANIFEST_DIR="$SCRIPT_DIR/../manifests"

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------
echo "==> Building Rust crates…"
cargo build --release --manifest-path "$CRATES_DIR/Cargo.toml"

RELEASE="$CRATES_DIR/target/release"

# ---------------------------------------------------------------------------
# 2. Install binaries
# ---------------------------------------------------------------------------
echo "==> Installing binaries to /usr/local/bin/"
install -m 0755 "$RELEASE/webhid-daemon"              /usr/local/bin/webhid-daemon
install -m 0755 "$RELEASE/webhid-native-messaging"    /usr/local/bin/webhid-native-messaging

# ---------------------------------------------------------------------------
# 3. Install native-messaging manifest
# ---------------------------------------------------------------------------
NM_MANIFEST="$MANIFEST_DIR/webhid_server.json"

# System-wide location (requires Firefox >= 85 with system-wide NM hosts)
SYSTEM_NM_DIR="/usr/lib/mozilla/native-messaging-hosts"
mkdir -p "$SYSTEM_NM_DIR"
install -m 0644 "$NM_MANIFEST" "$SYSTEM_NM_DIR/webhid_server.json"
echo "==> Native-messaging manifest installed to $SYSTEM_NM_DIR"

# Per-user location for the current user (works with older Firefox too)
if [ -n "$SUDO_USER" ]; then
    USER_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    USER_NM_DIR="$USER_HOME/.mozilla/native-messaging-hosts"
    mkdir -p "$USER_NM_DIR"
    install -m 0644 "$NM_MANIFEST" "$USER_NM_DIR/webhid_server.json"
    echo "==> Native-messaging manifest installed to $USER_NM_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Systemd service
# ---------------------------------------------------------------------------
# SERVICE_FILE="$SCRIPT_DIR/webhid-daemon.service"
# install -m 0644 "$SERVICE_FILE" /etc/systemd/system/webhid-daemon.service

# systemctl daemon-reload
# systemctl enable --now webhid-daemon.service
# echo "==> webhid-daemon service enabled and started"

echo ""
echo "Done.  Load the addon in Firefox (about:debugging → Load Temporary Add-on)"
echo "and make sure the daemon is running:  systemctl status webhid-daemon"
