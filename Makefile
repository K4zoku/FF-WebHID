SHELL := /usr/bin/env sh

ROOT        := $(CURDIR)
CRATES_DIR  := $(ROOT)/crates
ADDON_DIR   := $(ROOT)/addon
DIST_DIR    := $(ROOT)/dist
MANIFEST_DIR:= $(ROOT)/manifests
WASM_CRATE  := $(CRATES_DIR)/webhid-descriptor-wasm

RELEASE_DIR := $(CRATES_DIR)/target/release
DAEMON_BIN  := $(RELEASE_DIR)/webhid-daemon
NM_BIN      := $(RELEASE_DIR)/webhid-native-messaging

PREFIX      ?= /usr/local
USER_PREFIX ?= $(HOME)/.local
CARGO_ARGS  ?=

NM_MANIFEST := $(MANIFEST_DIR)/webhid-native-messaging-host.json
NM_NAME     := webhid-native-messaging-host.json

SYSTEM_NM_DIR      ?= /usr/lib/mozilla/native-messaging-hosts
SYSTEMD_DIR        ?= /etc/systemd/system
UDEV_DIR           ?= /etc/udev/rules.d

USER_NM_DIR       ?= $(HOME)/.mozilla/native-messaging-hosts
USER_SYSTEMD_DIR  ?= $(HOME)/.config/systemd/user

.PHONY: all build build-wasm build-addon package \
        install install-system install-user install-udev-rule \
        uninstall uninstall-system uninstall-user \
        windows-msi \
        clean help \
        bump bump-patch

all: build build-wasm build-addon

bump:
        npx commit-and-tag-version

bump-patch:
        npx commit-and-tag-version --release-as patch

## ---- Build ----

build:
        @echo "==> Building Rust crates (release)…"
        cargo build --release $(CARGO_ARGS) --manifest-path "$(CRATES_DIR)/Cargo.toml"

build-wasm:
        @echo "==> Building WASM descriptor parser…"
        @command -v wasm-pack >/dev/null 2>&1 || cargo install wasm-pack
        wasm-pack build "$(WASM_CRATE)" --target no-modules --release
        cp "$(WASM_CRATE)/pkg/webhid_descriptor_wasm.js" "$(ADDON_DIR)/js/utils/report-descriptor-parser.js"
        cp "$(WASM_CRATE)/pkg/webhid_descriptor_wasm_bg.wasm" "$(ADDON_DIR)/js/utils/report-descriptor-parser.wasm"
        @echo "Done: addon/js/utils/report-descriptor-parser.js + .wasm"

build-addon: build-wasm
        @mkdir -p "$(DIST_DIR)"
        @test -f "$(ADDON_DIR)/manifest.json" || { echo "manifest.json not found in $(ADDON_DIR)" >&2; exit 1; }
        @rm -f "$(DIST_DIR)/webhid-addon.xpi"
        @echo "==> Packaging addon XPI…"
        cd "$(ADDON_DIR)" && zip -r -X "$(DIST_DIR)/webhid-addon.xpi" . -x "*.DS_Store" "*/.git/*" >/dev/null
        @echo "Created $(DIST_DIR)/webhid-addon.xpi"

package: build build-addon

## ---- Windows MSI ----
## Requires: WiX v5 (`dotnet tool install --global wix`) on Windows host.
## Cross-build is not supported; run on a Windows machine or CI runner.

windows-msi:
        @echo "==> Building Windows MSI (run on Windows)…"
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(ROOT)/packaging/windows/build-msi.ps1"

## ---- Install ----
## System-wide: requires root, binaries+NM manifest shared for all users
## User-only:   no root needed, installs into $HOME

install: install-system

install-system: build
        @echo "==> Installing binaries to $(PREFIX)/bin/"
        install -Dm755 "$(DAEMON_BIN)" "$(DESTDIR)$(PREFIX)/bin/webhid-daemon"
        install -Dm755 "$(NM_BIN)"     "$(DESTDIR)$(PREFIX)/bin/webhid-native-messaging"
        @echo "==> Installing native-messaging manifest to $(SYSTEM_NM_DIR)"
        sed 's|{{NM_BIN}}|$(PREFIX)/bin/webhid-native-messaging|g' \
          "$(NM_MANIFEST)" | install -Dm644 /dev/stdin "$(DESTDIR)$(SYSTEM_NM_DIR)/$(NM_NAME)"
        @echo "==> Installing systemd service"
        sed 's|{{DAEMON_BIN}}|$(PREFIX)/bin/webhid-daemon|g' \
          "$(MANIFEST_DIR)/webhid-daemon.service" | install -Dm644 /dev/stdin "$(DESTDIR)$(SYSTEMD_DIR)/webhid-daemon.service"
        @echo "Run: systemctl daemon-reload && systemctl enable --now webhid-daemon.service"
        @echo "Done. Load the addon in Firefox (about:debugging → Load Temporary Add-on)."

install-user: build
        @echo "==> Installing binaries to $(USER_PREFIX)/bin/"
        install -Dm755 "$(DAEMON_BIN)" "$(USER_PREFIX)/bin/webhid-daemon"
        install -Dm755 "$(NM_BIN)"     "$(USER_PREFIX)/bin/webhid-native-messaging"
        @echo "==> Installing native-messaging manifest to $(USER_NM_DIR)"
        @mkdir -p "$(USER_NM_DIR)"
        sed 's|{{NM_BIN}}|$(USER_PREFIX)/bin/webhid-native-messaging|g' \
          "$(NM_MANIFEST)" > "$(USER_NM_DIR)/$(NM_NAME)"
        chmod 644 "$(USER_NM_DIR)/$(NM_NAME)"
        @echo "==> Installing systemd user service to $(USER_SYSTEMD_DIR)"
        @mkdir -p "$(USER_SYSTEMD_DIR)"
        sed 's|{{DAEMON_BIN}}|$(USER_PREFIX)/bin/webhid-daemon|g' \
          "$(MANIFEST_DIR)/webhid-daemon.user.service" > "$(USER_SYSTEMD_DIR)/webhid-daemon.service"
        chmod 644 "$(USER_SYSTEMD_DIR)/webhid-daemon.service"
        @echo "Run: systemctl --user daemon-reload && systemctl --user enable --now webhid-daemon.service"
        @echo "Done. Load the addon in Firefox (about:debugging → Load Temporary Add-on)."

install-udev-rule:
        @echo "==> Installing udev rule to $(UDEV_DIR)/"
        install -Dm644 "$(MANIFEST_DIR)/99-webhid.rules" "$(DESTDIR)$(UDEV_DIR)/99-webhid.rules"
        udevadm control --reload-rules && udevadm trigger
        @echo "Done."

uninstall: uninstall-system

uninstall-system:
        rm -f "$(DESTDIR)$(PREFIX)/bin/webhid-daemon"
        rm -f "$(DESTDIR)$(PREFIX)/bin/webhid-native-messaging"
        rm -f "$(DESTDIR)$(SYSTEM_NM_DIR)/$(NM_NAME)"
        rm -f "$(DESTDIR)$(SYSTEMD_DIR)/webhid-daemon.service"

uninstall-user:
        rm -f "$(USER_PREFIX)/bin/webhid-daemon"
        rm -f "$(USER_PREFIX)/bin/webhid-native-messaging"
        rm -f "$(USER_NM_DIR)/$(NM_NAME)"
        rm -f "$(USER_SYSTEMD_DIR)/webhid-daemon.service"

## ---- Misc ----

clean:
        cargo clean --manifest-path "$(CRATES_DIR)/Cargo.toml"
        rm -rf "$(DIST_DIR)"
        rm -f "$(ADDON_DIR)/js/utils/report-descriptor-parser.js" "$(ADDON_DIR)/js/utils/report-descriptor-parser.wasm"

help:
        @echo "Targets:"
        @echo "  build              - cargo build --release (daemon + nm host)"
        @echo "  build-wasm         - build wasm descriptor parser into addon/"
        @echo "  build-addon        - package addon/ into dist/webhid-addon.xpi"
        @echo "  package            - build + build-addon"
        @echo "  windows-msi        - build Windows MSI installer (run on Windows)"
        @echo "  install-system     - install binaries + NM manifest + systemd service (needs root)"
        @echo "  install-user       - install binaries + NM manifest + systemd user service (no root)"
        @echo "  install-udev-rule  - install udev rule for hidraw access (needs root)"
        @echo "  uninstall-system / uninstall-user"
        @echo "  clean              - remove build artifacts"
