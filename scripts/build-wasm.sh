#!/usr/bin/env sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_CRATE="$ROOT/crates/webhid-descriptor-wasm"
ADDON_DIR="$ROOT/addon"

echo "Building WASM descriptor parser..."
if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "wasm-pack not found. Installing..."
    cargo install wasm-pack
fi
wasm-pack build "$WASM_CRATE" --target no-modules --release
cp "$WASM_CRATE/pkg/webhid_descriptor_wasm.js" "$ADDON_DIR/wasm-parser.js"
cp "$WASM_CRATE/pkg/webhid_descriptor_wasm_bg.wasm" "$ADDON_DIR/wasm-parser.wasm"
echo "Done: addon/wasm-parser.js + addon/wasm-parser.wasm"
