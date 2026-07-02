#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADDON_DIR="$ROOT/addon"
OUT="$ROOT/dist"
TARGET="$OUT/webhid-addon.xpi"

# Build WASM first
if [ -f "$ROOT/scripts/build-wasm.sh" ]; then
    "$ROOT/scripts/build-wasm.sh"
fi

mkdir -p "$OUT"
cd "$ADDON_DIR"

if [ ! -f manifest.json ]; then
  echo "manifest.json not found in $ADDON_DIR" >&2
  exit 1
fi

if [ -f "$TARGET" ]; then
    echo "Cleaning old target..."
    rm "$TARGET"
fi

echo "Building addon XPI into $OUT/webhid-addon.xpi..."
zip -r -X "$TARGET" . -x "*.DS_Store" "*/.git/*" >/dev/null

echo "Created $TARGET"
