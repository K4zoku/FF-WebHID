{ config, lib, pkgs, ... }:

let
  cfg = config.services.webhid;
in
{
  options.services.webhid = {
    enable = lib.mkEnableOption "WebHID daemon";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../package.nix { };
      defaultText = literalExpression "pkgs.callPackage ../package.nix {}";
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

    settingsDir = lib.mkOption {
      type = lib.types.path;
      default = "/etc/webhid";
      description = "Configuration directory for the daemon.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Install udev rules from the package
    services.udev.packages = [ cfg.package ];

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
        PrivateDevices = true;
      };

      # Create settings directory
      preStart = ''
        mkdir -p ${cfg.settingsDir}
      '';
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
