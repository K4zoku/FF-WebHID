#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADDON_DIR="$ROOT/addon"
OUT="$ROOT/dist"

mkdir -p "$OUT"
cd "$ADDON_DIR"

if [ ! -f manifest.json ]; then
  echo "manifest.json not found in $ADDON_DIR" >&2
  exit 1
fi

echo "Building addon XPI into $OUT/webhid-addon.xpi..."
# Create a zip of the addon directory contents. Run from inside the addon dir so paths in the XPI are relative.
zip -r -X "$OUT/webhid-addon.xpi" . -x "*.DS_Store" "*/.git/*" >/dev/null

echo "Created $OUT/webhid-addon.xpi"
