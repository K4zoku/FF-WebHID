#!/usr/bin/env bash
# Build .rpm package for webhid (daemon + NM host).
# Usage: ./build-rpm.sh [version] [arch] [rust_target]
#   arch: x86_64 (default) or aarch64
#   rust_target: empty (native) or aarch64-unknown-linux-gnu
# Binaries must already be built — this script only packages them.
set -euo pipefail

VERSION="${1:-}"
ARCH="${2:-x86_64}"
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

# Build the RPM. On Ubuntu, rpmbuild only knows x86_64 and noarch targets.
# For aarch64, we build as x86_64 (host) and rename the output file.
# We disable brp-strip/brp-elfperms because x86_64's strip can't handle
# aarch64 ELF binaries, and Rust release builds are already optimized.
RPM_DEFS=(
  --define "_topdir $RPMROOT"
  --define "_binaries_in_noarch_packages_terminate_build 0"
  --define "_unpackaged_files_terminate_build 0"
  --define "__strip /bin/true"
  --define "__objdump /bin/true"
  --define "__brp_strip /bin/true"
  --define "__brp_strip_static_archive /bin/true"
  --define "__brp_strip_comment_note /bin/true"
  --define "__brp_elfperms /bin/true"
  --define "__brp_compress /bin/true"
)

if [ "$ARCH" = "aarch64" ]; then
  RPM_DEFS+=(--target x86_64)
else
  RPM_DEFS+=(--target "$ARCH")
fi

rpmbuild -bb "${RPM_DEFS[@]}" "$RPMROOT/SPECS/webhid.spec"

mkdir -p "$REPO_ROOT/dist"
# Find the built RPM and rename if needed (x86_64 host building aarch64 package)
find "$RPMROOT/RPMS" -name "*.rpm" | while read -r rpm; do
  base=$(basename "$rpm")
  if [ "$ARCH" = "aarch64" ]; then
    newname="${base/x86_64/aarch64}"
  else
    newname="$base"
  fi
  cp "$rpm" "$REPO_ROOT/dist/$newname"
done

echo "Done: $(ls "$REPO_ROOT"/dist/webhid-*.rpm)"
