#!/bin/sh
# Registers the FF-WebHID native-messaging hosts for Firefox (per-user).
#
# The manifests are written with absolute paths pointing at THIS extracted
# bundle, so the folder may live anywhere; re-run this script after moving it.
set -eu

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
NM_TARGET="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"

# Escape a path for use as a sed replacement (delimiter '|').
esc_sed() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

NM_BIN="$(esc_sed "$APP_DIR/bin/webhid-native-messaging")"
DAEMON_BIN="$(esc_sed "$APP_DIR/bin/webhid-daemon")"

mkdir -p "$NM_TARGET"

sed "s|{{NM_BIN}}|$NM_BIN|g" \
  "$APP_DIR/manifests/webhid.forwarder_nm_host.json" \
  > "$NM_TARGET/webhid.forwarder_nm_host.json"
sed "s|{{DAEMON_BIN}}|$DAEMON_BIN|g" \
  "$APP_DIR/manifests/webhid.daemon_nm_host.json" \
  > "$NM_TARGET/webhid.daemon_nm_host.json"

echo "Registered FF-WebHID native-messaging hosts for Firefox:"
echo "  $NM_TARGET"
echo ""
echo "Install the addon from https://addons.mozilla.org/firefox/addon/webhid/"
echo "and enable \"Daemon as NM host\" in its options (recommended)."
echo ""
echo "For the persistent forwarder mode instead, use Homebrew:"
echo "  brew install K4zoku/FF-WebHID/webhid && brew services start webhid"
