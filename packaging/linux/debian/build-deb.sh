#!/usr/bin/env bash
# Build .deb packages for webhid (daemon + NM host) and webhid-addon.
# Usage: ./build-deb.sh [version] [arch]
# Requires: cargo, dpkg-deb
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-$(dpkg --print-architecture)}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -z "$VERSION" ]; then
  VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$REPO_ROOT/package.json")
fi

echo "==> Building webhid $VERSION for $ARCH"

# Build Rust binaries
echo "==> cargo build --release"
cargo build --release --manifest-path "$REPO_ROOT/crates/Cargo.toml"

PKGDIR=$(mktemp -d)
trap 'rm -rf "$PKGDIR"' EXIT

# --- webhid (daemon + NM host) ---
DEBROOT="$PKGDIR/webhid"
mkdir -p "$DEBROOT/DEBIAN" \
         "$DEBROOT/usr/bin" \
         "$DEBROOT/usr/lib/systemd/system" \
         "$DEBROOT/usr/lib/mozilla/native-messaging-hosts" \
         "$DEBROOT/usr/lib/librewolf/native-messaging-hosts" \
         "$DEBROOT/usr/lib/waterfox/native-messaging-hosts" \
         "$DEBROOT/usr/share/licenses/webhid"

cp "$REPO_ROOT/crates/target/release/webhid-daemon" "$DEBROOT/usr/bin/"
cp "$REPO_ROOT/crates/target/release/webhid-native-messaging" "$DEBROOT/usr/bin/"

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

dpkg-deb --build --root-owner-group "$DEBROOT" \
  "$REPO_ROOT/dist/webhid-${VERSION}-${ARCH}.deb"

echo "Done: dist/webhid-${VERSION}-${ARCH}.deb"
