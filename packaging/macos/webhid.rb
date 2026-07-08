class Webhid < Formula
  desc "WebHID implementation for Firefox via native-messaging bridge and HID daemon"
  homepage "https://github.com/K4zoku/FF-WebHID"
  url "https://github.com/K4zoku/FF-WebHID.git",
      tag:      "v1.6.5",
      revision: "HEAD"
  version "1.6.5"
  license "MIT"
  head "https://github.com/K4zoku/FF-WebHID.git", branch: "main"

  depends_on "rust" => :build
  depends_on "pkg-config" => :build

  def install
    system "make", "build"

    # Install binaries
    bin.install "crates/target/release/webhid-daemon"
    bin.install "crates/target/release/webhid-native-messaging"

    # Install NM manifest (macOS uses /usr/local/lib/mozilla/native-messaging-hosts)
    nm_dir = lib/"mozilla/native-messaging-hosts"
    nm_dir.mkpath
    nm_json = nm_dir/"webhid-native-messaging-host.json"
    nm_json.write <<~JSON
      {
        "name": "webhid-native-messaging-host",
        "description": "WebHID native messaging host",
        "path": "#{bin}/webhid-native-messaging",
        "type": "stdio",
        "allowed_extensions": ["webhid@k4zoku.dev"]
      }
    JSON

    # Copy to LibreWolf and Waterfox paths
    (lib/"librewolf/native-messaging-hosts").mkpath
    (lib/"waterfox/native-messaging-hosts").mkpath
    cp nm_json, lib/"librewolf/native-messaging-hosts/webhid-native-messaging-host.json"
    cp nm_json, lib/"waterfox/native-messaging-hosts/webhid-native-messaging-host.json"
  end

  def caveats
    <<~EOS
      WebHID daemon installed! To start it:

        brew services start webhid

      Or run manually:
        webhid-daemon

      Install the Firefox addon from AMO:
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
    assert_match "webhid-daemon", shell_output("#{bin}/webhid-daemon --version", 2)
  end
end
