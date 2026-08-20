{ lib, fetchurl, rustPlatform, pkg-config, udev }:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "webhid";
  version = "3.1.0";

  # Release tarball pinned by its SHA-256; refresh with
  # `npm run refresh:pins` after each release.
  src = fetchurl {
    url = "https://github.com/K4zoku/FF-WebHID/archive/refs/tags/v${finalAttrs.version}.tar.gz";
    hash = "sha256-ZQmUtw9FKVyqIeDhrZGpUQsNBdY4REd+cwDIu7OLjvs=";
  };

  cargoLock = {
    lockFile = ../crates/Cargo.lock;
  };

  nativeBuildInputs = [ pkg-config ];

  # hidapi's linux-native backend links libudev
  buildInputs = [ udev ];

  # Install binaries, udev rules, systemd service, and NM manifests
  installPhase = ''
    # Binaries
    install -Dm755 crates/target/release/webhid-daemon \
      $out/bin/webhid-daemon
    install -Dm755 crates/target/release/webhid-native-messaging \
      $out/bin/webhid-native-messaging

    # udev rules
    install -Dm644 manifests/72-webhid.rules \
      $out/lib/udev/rules.d/72-webhid.rules

    # systemd service (substituted so the packaged unit is executable)
    sed "s|{{DAEMON_BIN}}|${placeholder "out"}/bin/webhid-daemon|g" \
      manifests/webhid-daemon.service \
      | install -Dm644 /dev/stdin $out/lib/systemd/system/webhid-daemon.service

    # NM manifests for all Gecko browsers, pointing at the store paths
    for d in mozilla librewolf waterfox; do
      nm_dir="$out/lib/$d/native-messaging-hosts"
      mkdir -p "$nm_dir"

      sed "s|{{NM_BIN}}|$out/bin/webhid-native-messaging|g" \
        manifests/webhid.forwarder_nm_host.json \
        > "$nm_dir/webhid.forwarder_nm_host.json"

      sed "s|{{DAEMON_BIN}}|$out/bin/webhid-daemon|g" \
        manifests/webhid.daemon_nm_host.json \
        > "$nm_dir/webhid.daemon_nm_host.json"
    done

    # License
    install -Dm644 LICENSE \
      $out/share/licenses/webhid/LICENSE
  '';

  meta = {
    description = "WebHID implementation for Firefox via native-messaging bridge and hidraw daemon";
    homepage = "https://github.com/K4zoku/FF-WebHID";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
})
