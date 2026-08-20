{ config, lib, pkgs, ... }:

let
  cfg = config.services.webhid;
in
{
  options.services.webhid = {
    enable = lib.mkEnableOption "WebHID daemon";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix {}";
      description = ''
        WebHID daemon package. Override to use a custom build or version.
      '';
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "webhid";
      description = "Service user account.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "webhid";
      description = "Service group.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Install the packaged udev rules (uaccess for seat users).
    services.udev.packages = [ cfg.package ];

    # The packaged rule grants `uaccess`, which only applies to the active
    # logged-in seat user, so the service account needs explicit device
    # permissions. The daemon enforces the FIDO/blocklist exclusions at
    # runtime (fail-closed), so a dedicated service group that only ever runs
    # the daemon does not broaden usable access to protected devices.
    services.udev.extraRules = ''
      KERNEL=="hidraw*", GROUP="${cfg.group}", MODE="0660"
    '';

    # Systemd service
    systemd.services.webhid-daemon = {
      description = "WebHID daemon";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-udev-settle.service" ];
      requires = [ "systemd-udev-settle.service" ];

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/webhid-daemon";
        User = cfg.user;
        Group = cfg.group;
        Restart = "on-failure";
        RestartSec = "5s";

        # The non-root daemon binds its socket under $XDG_RUNTIME_DIR
        # (crates/webhid/src/socket_path.rs::user_socket). Point it at the
        # systemd-managed runtime directory so the socket lands on the
        # forwarder's ROOT_FS_SOCKET fallback (/run/webhid/webhid.sock).
        RuntimeDirectory = "webhid";
        RuntimeDirectoryMode = "0750";
        Environment = "XDG_RUNTIME_DIR=/run";

        # Hardening
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        MemoryDenyWriteExecute = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        ReadOnlyPaths = [ "/etc" ];
      };
    };

    # Create user/group
    users.groups.${cfg.group} = {};
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      description = "WebHID daemon user";
      home = "/var/lib/webhid";
      createHome = true;
      homeMode = "0750";
    };
  };
}
