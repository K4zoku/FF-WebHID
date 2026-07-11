# Contributing to FF-WebHID

Thanks for your interest in contributing! Here's how to get started.

## Project Structure

- `addon/`: Firefox WebExtension (background/worker/page scripts)
- `crates/`: Rust daemon, native messaging host, and HID report descriptor parser (hidreport crate)
- `packaging/`: platform-specific packaging (Arch PKGBUILD, Windows MSI/WiX, Debian, RPM, Homebrew)
- `docs/`: architecture documentation

See [DEVELOPMENT.md](DEVELOPMENT.md) for build instructions and architecture details.

## Reporting Bugs

Please [open a bug report](../../issues/new?template=bug_report.yml) using the provided issue form, it'll ask for the details needed to debug (OS, versions, logs, steps to reproduce). Reports without this info are much harder to act on.

For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Submitting Changes

1. Fork the repo and create a branch off `main`.
2. Make your changes. Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) style messages (`feat:`, `fix:`, `chore:`, etc.) where possible, since changelogs are generated from commit history.
3. Make sure `cargo build --release` and `cargo clippy` pass cleanly for any Rust changes.
4. Test your changes against a real HID device if possible, especially for changes touching the report descriptor parser, data plane, or hotplug detection.
5. Open a pull request against `main` describing what changed and why.

## Code Style

- Rust: standard `rustfmt` formatting, no `#[allow(...)]` without a comment explaining why.
- JS: keep to the existing style in `addon/js/`, avoid introducing new dependencies unless necessary.

## Questions

Feel free to open a [Discussion](../../discussions) or an issue if you're not sure where something belongs.
