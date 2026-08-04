#!/bin/bash

set -eu

# --- Non-Linux guard: the hidapi patches are linux-native-only; on macOS and
# Windows the daemon uses the C hidapi backend and needs no patching. Skip the
# wrapper entirely there. Must run BEFORE the log redirect below so the
# exec'd command's stdout (e.g. `rustc -vV`) reaches cargo, not the log file. ---
if [ "$(uname -s)" != "Linux" ]; then
  exec "$@"
fi

# --- Redirect all output to log file except for the final exec'd command ---
LOG_FILE="/tmp/fixup-log.txt"
exec 3>&1 4>&2
exec >>"$LOG_FILE" 2>&1

# --- Constants and Paths ---
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../" && pwd)
PATCHES_DIR="$SCRIPT_DIR/patches"
TARGET_PATCHED_DIR="$SCRIPT_DIR/target/patched-crates"

# --- No patching needed - run original args ---
if [ -z "${CARGO_PKG_NAME:-}" ] || [ -z "${CARGO_MANIFEST_DIR:-}" ]; then
  exec 1>&3 2>&4
  exec "$@"
fi

ORIGINAL_DIR_NAME=$(basename "$CARGO_MANIFEST_DIR")
PATCH_DIR="$PATCHES_DIR/$ORIGINAL_DIR_NAME"

# --- Check for matching patch directory ---
if [ -d "$PATCH_DIR" ]; then
  PATCHED_SRC="$TARGET_PATCHED_DIR/$ORIGINAL_DIR_NAME"

  echo "Applying patches to $CARGO_PKG_NAME..."

  mkdir -p "$TARGET_PATCHED_DIR"
  rm -rf -- "$PATCHED_SRC"
  cp -RL -- "$CARGO_MANIFEST_DIR" "$PATCHED_SRC"

  for PATCH_FILE in "$PATCH_DIR"/*; do
    [ -f "$PATCH_FILE" ] || continue
    if [ -x "$PATCH_FILE" ]; then
      echo "Executing: $PATCH_FILE"
      (cd "$PATCHED_SRC" && "$PATCH_FILE")
    elif [ "${PATCH_FILE##*.}" = "patch" ]; then
      echo "Applying patch: $PATCH_FILE"
      patch -s -p1 -d "$PATCHED_SRC" < "$PATCH_FILE"
    else
      echo "Not executable nor patch file: $PATCH_FILE"
    fi
  done

  new_args=()
  for arg in "$@"; do
    new_args+=("${arg//$CARGO_MANIFEST_DIR/$PATCHED_SRC}")
  done

  exec 1>&3 2>&4
  exec "${new_args[@]}"
else
  exec 1>&3 2>&4
  exec "$@"
fi
