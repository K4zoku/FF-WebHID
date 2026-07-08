# Security Policy

## Supported Versions

Only the latest released version of FF-WebHID (addon and daemon) receives security fixes. Please make sure you're running the latest release before reporting an issue.

## Reporting a Vulnerability

If you discover a security vulnerability in FF-WebHID (addon, daemon, or the native messaging bridge), please **do not open a public issue**. Publicly disclosing a vulnerability before a fix is available could put existing users at risk.

Instead, please report it privately using [GitHub Security Advisories](https://github.com/K4zoku/FF-WebHID/security/advisories/new).

When reporting, please include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected component (addon, daemon, or native messaging host) and platform (Linux/Windows/macOS)
- Any relevant logs (with sensitive data redacted)

## What's in Scope

- The Firefox addon (background/worker/page scripts, WASM descriptor parser)
- The Rust daemon and native messaging host
- The WebSocket data plane and its authentication mechanism
- The HID device blocklist (keyboard/mouse/FIDO-U2F protections)

## Response

I'll try to acknowledge new reports within a few days and keep you updated as the issue is investigated and fixed. Once a fix is released, I'll credit you in the release notes unless you'd prefer to stay anonymous.

Thank you for helping keep FF-WebHID and its users safe.
