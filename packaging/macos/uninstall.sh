#!/bin/sh
# Removes the FF-WebHID native-messaging host registration created by
# install.sh.
set -eu

NM_TARGET="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
rm -f "$NM_TARGET/webhid.forwarder_nm_host.json" \
      "$NM_TARGET/webhid.daemon_nm_host.json"

echo "Removed FF-WebHID native-messaging host registration."
