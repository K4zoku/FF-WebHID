#!/usr/bin/env bash
# Build .rpm package for webhid (daemon + NM host).
# Usage: ./build-rpm.sh [version] [arch] [rust_target]
#   arch: x86_64 (default) or aarch64
#   rust_target: empty (native) or aarch64-unknown-linux-gnu
# Requires: cargo, rpm-build (rpmbuild)
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-x86_64}"
RUST_TARGET="${3:-}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -z "$VERSION" ]; then
  VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$REPO_ROOT/package.json")
fi

echo "==> Building webhid $VERSION for $ARCH (target: ${RUST_TARGET:-native})"

# Build Rust binaries
echo "==> cargo build --release"
if [ -n "$RUST_TARGET" ]; then
  cargo build --release --target "$RUST_TARGET" --manifest-path "$REPO_ROOT/crates/Cargo.toml"
  BIN_DIR="$REPO_ROOT/crates/target/$RUST_TARGET/release"
else
  cargo build --release --manifest-path "$REPO_ROOT/crates/Cargo.toml"
  BIN_DIR="$REPO_ROOT/crates/target/release"
fi

# Set up rpmbuild tree
RPMROOT=$(mktemp -d)
trap 'rm -rf "$RPMROOT"' EXIT
mkdir -p "$RPMROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Create the spec file
cat > "$RPMROOT/SPECS/webhid.spec" << EOF
Name:           webhid
Version:        $VERSION
Release:        1
Summary:        WebHID implementation for Firefox via native-messaging bridge and hidraw daemon
License:        MIT
URL:            https://github.com/K4zoku/FF-WebHID
BuildArch:      $ARCH
Requires:       systemd-libs
Requires(post): systemd
Requires(preun): systemd

%description
WebHID implements the navigator.hid WebHID API in Firefox, enabling websites
to interact with HID hardware via a native-messaging bridge and hidraw daemon.

%install
# Binaries
install -Dm755 "$BIN_DIR/webhid-daemon" \\
  %{buildroot}/usr/bin/webhid-daemon
install -Dm755 "$BIN_DIR/webhid-native-messaging" \\
  %{buildroot}/usr/bin/webhid-native-messaging

# Systemd service
sed 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' \\
  "$REPO_ROOT/manifests/webhid-daemon.service" > /tmp/webhid-daemon.service
install -Dm644 /tmp/webhid-daemon.service \\
  %{buildroot}/usr/lib/systemd/system/webhid-daemon.service

# NM manifest (Firefox, LibreWolf, Waterfox)
sed 's|{{NM_BIN}}|/usr/bin/webhid-native-messaging|g' \\
  "$REPO_ROOT/manifests/webhid-native-messaging-host.json" > /tmp/webhid-nm.json
install -Dm644 /tmp/webhid-nm.json \\
  %{buildroot}/usr/lib/mozilla/native-messaging-hosts/webhid-native-messaging-host.json
install -Dm644 /tmp/webhid-nm.json \\
  %{buildroot}/usr/lib/librewolf/native-messaging-hosts/webhid-native-messaging-host.json
install -Dm644 /tmp/webhid-nm.json \\
  %{buildroot}/usr/lib/waterfox/native-messaging-hosts/webhid-native-messaging-host.json

# License
install -Dm644 "$REPO_ROOT/LICENSE" \\
  %{buildroot}/usr/share/licenses/webhid/LICENSE

%post
%systemd_post webhid-daemon.service

%preun
%systemd_preun webhid-daemon.service

%postun
%systemd_postun webhid-daemon.service

%files
%license /usr/share/licenses/webhid/LICENSE
/usr/bin/webhid-daemon
/usr/bin/webhid-native-messaging
/usr/lib/systemd/system/webhid-daemon.service
/usr/lib/mozilla/native-messaging-hosts/webhid-native-messaging-host.json
/usr/lib/librewolf/native-messaging-hosts/webhid-native-messaging-host.json
/usr/lib/waterfox/native-messaging-hosts/webhid-native-messaging-host.json
EOF

rpmbuild -bb \
  --define "_topdir $RPMROOT" \
  --target "$ARCH" \
  "$RPMROOT/SPECS/webhid.spec"

mkdir -p "$REPO_ROOT/dist"
find "$RPMROOT/RPMS" -name "*.rpm" -exec cp {} "$REPO_ROOT/dist/" \;

echo "Done: $(ls "$REPO_ROOT"/dist/webhid-*.rpm)"
