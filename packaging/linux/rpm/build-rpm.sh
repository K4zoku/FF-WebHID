#!/usr/bin/env bash
# Build .rpm package for webhid (daemon + NM host).
# Usage: ./build-rpm.sh [version] [arch]
#   arch: x86_64 (default) or aarch64
# Binaries must already be built; this script only packages them.
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-x86_64}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if [ -z "$VERSION" ]; then
  VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$REPO_ROOT/package.json")
fi

BIN_DIR="$REPO_ROOT/crates/target/release"

if [ ! -f "$BIN_DIR/webhid-daemon" ]; then
  echo "ERROR: webhid-daemon not found in $BIN_DIR; build first with cargo build --release"
  exit 1
fi

echo "==> Packaging webhid $VERSION for $ARCH (binaries from $BIN_DIR)"

RPMROOT=$(mktemp -d)
trap 'rm -rf "$RPMROOT"' EXIT
mkdir -p "$RPMROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

cat > "$RPMROOT/SPECS/webhid.spec" << EOF
Name:           webhid
Version:        $VERSION
Release:        1
Summary:        WebHID implementation for Firefox via native-messaging bridge and hidraw daemon
License:        MIT
URL:            https://github.com/K4zoku/FF-WebHID
Requires:       systemd-libs
Requires(post): systemd
Requires(preun): systemd

%description
WebHID implements the navigator.hid WebHID API in Firefox, enabling websites
to interact with HID hardware via a native-messaging bridge and hidraw daemon.

%install
install -Dm755 "$BIN_DIR/webhid-daemon" \\
  %{buildroot}/usr/bin/webhid-daemon
install -Dm755 "$BIN_DIR/webhid-native-messaging" \\
  %{buildroot}/usr/bin/webhid-native-messaging

sed 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' \\
  "$REPO_ROOT/manifests/webhid-daemon.service" > /tmp/webhid-daemon.service
install -Dm644 /tmp/webhid-daemon.service \\
  %{buildroot}/usr/lib/systemd/system/webhid-daemon.service

sed 's|{{NM_BIN}}|/usr/bin/webhid-native-messaging|g' \\
  "$REPO_ROOT/manifests/webhid.forwarder_nm_host.json" > /tmp/webhid-nm.json
sed 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' \\
  "$REPO_ROOT/manifests/webhid.daemon_nm_host.json" > /tmp/webhid-daemon-nm.json

for dir in mozilla librewolf waterfox; do
  install -Dm644 /tmp/webhid-nm.json \\
    %{buildroot}/usr/lib/\$dir/native-messaging-hosts/webhid.forwarder_nm_host.json
  install -Dm644 /tmp/webhid-daemon-nm.json \\
    %{buildroot}/usr/lib/\$dir/native-messaging-hosts/webhid.daemon_nm_host.json
done

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
/usr/lib/mozilla/native-messaging-hosts/webhid.forwarder_nm_host.json
/usr/lib/mozilla/native-messaging-hosts/webhid.daemon_nm_host.json
/usr/lib/librewolf/native-messaging-hosts/webhid.forwarder_nm_host.json
/usr/lib/librewolf/native-messaging-hosts/webhid.daemon_nm_host.json
/usr/lib/waterfox/native-messaging-hosts/webhid.forwarder_nm_host.json
/usr/lib/waterfox/native-messaging-hosts/webhid.daemon_nm_host.json
EOF

rpmbuild -bb \
  --define "_topdir $RPMROOT" \
  --define "_binaries_in_noarch_packages_terminate_build 0" \
  --define "_unpackaged_files_terminate_build 0" \
  --target "$ARCH" \
  "$RPMROOT/SPECS/webhid.spec"

mkdir -p "$REPO_ROOT/dist"
find "$RPMROOT/RPMS" -name "*.rpm" -exec cp {} "$REPO_ROOT/dist/" \;

echo "Done: $(ls "$REPO_ROOT"/dist/webhid-*.rpm)"
