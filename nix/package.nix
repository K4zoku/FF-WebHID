{ lib, fetchFromGitHub, rustPlatform, pkg-config, linux-headers-unstable }:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "webhid";
  version = "3.1.0";

  src = fetchFromGitHub {
    owner = "K4zoku";
    repo = "FF-WebHID";
    tag = "v${finalAttrs.version}";
    # Replace with real hash after first build:
    # hash = "sha256-REPLACE_ME";
  };

  cargoLock = {
    lockFile = ../crates/Cargo.lock;
  };

  nativeBuildInputs = [ pkg-config ];

  # hidraw/ioctl requires kernel headers
  buildInputs = [ linux-headers-unstable ];

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

    # systemd service
    install -Dm644 manifests/webhid-daemon.service \
      $out/lib/systemd/system/webhid-daemon.service

    # NM manifests for all Gecko browsers
    for d in mozilla librewolf waterfox; do
      local nm_dir=$out/lib/$d/native-messaging-hosts
      mkdir -p "$nm_dir"

      sed 's|{{NM_BIN}}|/usr/bin/webhid-native-messaging|g' \
        manifests/webhid.forwarder_nm_host.json \
        > "$nm_dir/webhid.forwarder_nm_host.json"

      sed 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' \
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
    maintainers = with lib.maintainers; [ k4zoku ];
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
})
