class Webhid < Formula
  desc "WebHID implementation for Firefox via native-messaging bridge and HID daemon"
  homepage "https://github.com/K4zoku/FF-WebHID"
  url "https://github.com/K4zoku/FF-WebHID.git",
      tag: "v3.2.0",
      revision: "0d0c4a649c4bef9bf577c4cef6eedc28bcb72e32"
  version "3.2.0"
  license "MIT"
  head "https://github.com/K4zoku/FF-WebHID.git", branch: "main"

  depends_on "pkg-config" => :build
  depends_on "rust" => :build

  def install
    system "cargo", "build", "--release", "--manifest-path", "crates/Cargo.toml",
           "-p", "webhid-daemon", "-p", "webhid-native-messaging"

    bin.install "crates/target/release/webhid-daemon"
    bin.install "crates/target/release/webhid-native-messaging"

    nm_dir = libexec/"native-messaging-hosts"
    nm_dir.mkpath

    forwarder_manifest = (buildpath/"manifests/webhid.forwarder_nm_host.json").read
      .sub("{{NM_BIN}}", (opt_bin/"webhid-native-messaging").to_s)
    (nm_dir/"webhid.forwarder_nm_host.json").write forwarder_manifest

    daemon_manifest = (buildpath/"manifests/webhid.daemon_nm_host.json").read
      .sub("{{DAEMON_BIN}}", (opt_bin/"webhid-daemon").to_s)
    (nm_dir/"webhid.daemon_nm_host.json").write daemon_manifest

    register = bin/"webhid-register-firefox"
    register.write <<~SH
      #!/bin/sh
      set -eu
      target="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
      source_dir="#{opt_libexec}/native-messaging-hosts"
      mkdir -p "$target"
      ln -sf "$source_dir/webhid.forwarder_nm_host.json" "$target/webhid.forwarder_nm_host.json"
      ln -sf "$source_dir/webhid.daemon_nm_host.json" "$target/webhid.daemon_nm_host.json"
      printf '%s\n' "Registered FF-WebHID native-messaging hosts for Firefox."
    SH
    chmod 0755, register
  end

  def caveats
    <<~EOS
      Register the native-messaging hosts with Firefox for your user:
        webhid-register-firefox

      Recommended setup: leave the background service stopped and enable
      "Daemon as NM host" in about:addons -> WebHID -> Options.

      For the persistent forwarder mode instead:
        brew services start webhid

      Input-class devices (keyboard, mouse, trackpad) may require Input
      Monitoring permission (System Settings -> Privacy & Security -> Input
      Monitoring); other HID device classes generally do not. Grant it if
      the daemon reports permission errors.

      Install the Firefox addon from:
        https://addons.mozilla.org/firefox/addon/webhid/
    EOS
  end

  service do
    run [opt_bin/"webhid-daemon"]
    keep_alive true
    log_path var/"log/webhid-daemon.log"
    error_log_path var/"log/webhid-daemon.err.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/webhid-daemon --version")

    ENV["HOME"] = testpath
    system bin/"webhid-register-firefox"
    nm_dir = testpath/"Library/Application Support/Mozilla/NativeMessagingHosts"
    assert_predicate nm_dir/"webhid.forwarder_nm_host.json", :symlink?
    assert_predicate nm_dir/"webhid.daemon_nm_host.json", :symlink?
  end
end
