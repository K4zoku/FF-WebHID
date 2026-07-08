Name:           webhid
Version:        1.6.5
Release:        1%{?dist}
Summary:        WebHID implementation for Firefox via native-messaging bridge and hidraw daemon

License:        MIT
URL:            https://github.com/K4zoku/FF-WebHID
Source0:        %{url}/archive/refs/tags/v%{version}.tar.gz

BuildRequires:  rust-packaging >= 1.70
BuildRequires:  pkgconfig(libudev)
BuildRequires:  make
Requires:       systemd-libs
Requires(post): systemd
Requires(preun): systemd

%description
WebHID implements the navigator.hid WebHID API in Firefox, enabling websites
to interact with HID hardware (game controllers, stream decks, and other
specialized input devices) that Firefox does not natively support.

Requires the webhid-addon Firefox extension.

%prep
%autosetup -n FF-WebHID-%{version}

%build
make build CARGO_ARGS=--frozen

%install
make install-system \
  DESTDIR=%{buildroot} \
  PREFIX=%{_prefix} \
  SYSTEMD_DIR=%{_unitdir} \
  SYSTEM_NM_DIR=%{_libdir}/mozilla/native-messaging-hosts

# Copy NM manifest to LibreWolf and Waterfox paths
for browser in librewolf waterfox; do
  install -Dm644 \
    %{buildroot}%{_libdir}/mozilla/native-messaging-hosts/webhid-native-messaging-host.json \
    %{buildroot}%{_libdir}/$browser/native-messaging-hosts/webhid-native-messaging-host.json
done

install -Dm644 LICENSE %{buildroot}%{_datadir}/licenses/%{name}/LICENSE

%post
%systemd_post webhid-daemon.service

%preun
%systemd_preun webhid-daemon.service

%postun
%systemd_postun webhid-daemon.service

%files
%license LICENSE
%{_bindir}/webhid-daemon
%{_bindir}/webhid-native-messaging
%{_unitdir}/webhid-daemon.service
%{_libdir}/mozilla/native-messaging-hosts/webhid-native-messaging-host.json
%{_libdir}/librewolf/native-messaging-hosts/webhid-native-messaging-host.json
%{_libdir}/waterfox/native-messaging-hosts/webhid-native-messaging-host.json

%changelog
* Fri Jul 11 2026 K4zoku <k4zoku@pm.me> - 1.6.5-1
- Initial RPM package
