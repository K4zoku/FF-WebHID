#!/usr/bin/env bash
# Build .deb package for webhid (daemon + NM host).
# Usage: ./build-deb.sh [version] [arch] [rust_target]
#   arch: amd64 (default) or arm64
#   rust_target: empty (native) or aarch64-unknown-linux-gnu
# Binaries must already be built — this script only packages them.
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-amd64}"
RUST_TARGET="${3:-}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if [ -z "$VERSION" ]; then
  VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$REPO_ROOT/package.json")
fi

# Locate pre-built binaries
if [ -n "$RUST_TARGET" ]; then
  BIN_DIR="$REPO_ROOT/crates/target/$RUST_TARGET/release"
else
  BIN_DIR="$REPO_ROOT/crates/target/release"
fi

if [ ! -f "$BIN_DIR/webhid-daemon" ]; then
  echo "ERROR: webhid-daemon not found in $BIN_DIR — build first with cargo build --release"
  exit 1
fi

echo "==> Packaging webhid $VERSION for $ARCH (binaries from $BIN_DIR)"

PKGDIR=$(mktemp -d)
trap 'rm -rf "$PKGDIR"' EXIT

DEBROOT="$PKGDIR/webhid"
mkdir -p "$DEBROOT/DEBIAN" \
         "$DEBROOT/usr/bin" \
         "$DEBROOT/usr/lib/systemd/system" \
         "$DEBROOT/usr/lib/mozilla/native-messaging-hosts" \
         "$DEBROOT/usr/lib/librewolf/native-messaging-hosts" \
         "$DEBROOT/usr/lib/waterfox/native-messaging-hosts" \
         "$DEBROOT/usr/share/licenses/webhid"

cp "$BIN_DIR/webhid-daemon" "$DEBROOT/usr/bin/"
cp "$BIN_DIR/webhid-native-messaging" "$DEBROOT/usr/bin/"

sed "s|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g" \
  "$REPO_ROOT/manifests/webhid-daemon.service" > \
  "$DEBROOT/usr/lib/systemd/system/webhid-daemon.service"

sed "s|{{NM_BIN}}|/usr/bin/webhid-native-messaging|g" \
  "$REPO_ROOT/manifests/webhid-native-messaging-host.json" > \
  "$DEBROOT/usr/lib/mozilla/native-messaging-hosts/webhid-native-messaging-host.json"
cp "$DEBROOT/usr/lib/mozilla/native-messaging-hosts/webhid-native-messaging-host.json" \
   "$DEBROOT/usr/lib/librewolf/native-messaging-hosts/"
cp "$DEBROOT/usr/lib/mozilla/native-messaging-hosts/webhid-native-messaging-host.json" \
   "$DEBROOT/usr/lib/waterfox/native-messaging-hosts/"

cp "$REPO_ROOT/LICENSE" "$DEBROOT/usr/share/licenses/webhid/"

cat > "$DEBROOT/DEBIAN/control" << EOF
Package: webhid
Version: $VERSION
Architecture: $ARCH
Maintainer: K4zoku <k4zoku@pm.me>
Description: WebHID implementation for Firefox via native-messaging bridge and hidraw daemon
 Depends: libudev1
Section: utils
Priority: optional
Homepage: https://github.com/K4zoku/FF-WebHID
EOF

cat > "$DEBROOT/DEBIAN/postinst" << 'EOF'
#!/bin/sh
systemctl daemon-reload 2>/dev/null || true
systemctl enable --now webhid-daemon.service 2>/dev/null || true
EOF
chmod 755 "$DEBROOT/DEBIAN/postinst"

cat > "$DEBROOT/DEBIAN/prerm" << 'EOF'
#!/bin/sh
systemctl stop webhid-daemon.service 2>/dev/null || true
systemctl disable webhid-daemon.service 2>/dev/null || true
EOF
chmod 755 "$DEBROOT/DEBIAN/prerm"

mkdir -p "$REPO_ROOT/dist"
OUT="$REPO_ROOT/dist/webhid-${VERSION}-${ARCH}.deb"
dpkg-deb --build --root-owner-group "$DEBROOT" "$OUT"

echo "Done: $OUT"
