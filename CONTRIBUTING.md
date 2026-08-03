# Contributing to FF-WebHID

## Design principles

These are the design principles this project has converged on. Follow them by default; deviating requires a good reason, not just convenience.

### 1. Daemon output is a contract, not a promise

The daemon is the single source of truth for data shape (collections, reports, device info). Its output must be correct by construction (normalize at the serde/serialize layer), not "mostly right, fixed up by the consumer."

The addon (polyfill, background, worker) should not add defensive fallbacks (`?? []`, shape-guessing, silent recovery) for data coming from the daemon. If the daemon's output is ever wrong, that's a daemon bug to fix at the source, not something to paper over downstream. Silently tolerating bad shape hides bugs instead of surfacing them.

This is intentionally the "conservative in what you send" half of Postel's Law, without the "liberal in what you accept" half, since blind leniency on the receiving end tends to hide bugs and lets aberrant behavior become a de facto standard.

### 2. Single source of truth for protocol logic

Only the daemon understands the wire format and protocol semantics. Other components (NM host, addon layers) should be as dumb as possible:

- The NM host is a thin forwarder: it moves bytes between stdio and the Unix socket. It does not parse, deserialize, or reason about message content.
- Don't duplicate parsing or serialization logic across crates or across JS contexts. If two places need to understand the same structure, that's a signal the structure should be produced or consumed in one place and passed through as opaque bytes everywhere else.

### 3. Zero-copy by default on hot paths, but know which paths are hot

Report data (`sendReport`, `oninputreport`) is the hot path. Use `Transferable` objects (`postMessage(data, [buffer])`) where possible. Control-plane and setup paths (device enumeration, collections fetch, settings) are not hot paths. Don't over-optimize them at the cost of readability; a plain copy once per `open()` call is fine.

"Zero-copy" is not a single property to compare path to path. Count the copies for the whole journey (network to consumer), not just the first hop. A path with one big zero-copy hop plus one hidden copy later can lose to a simpler path with a single transfer and no copies at all. Benchmark end-to-end before assuming the theoretically-fancier mechanism wins.

Know the difference before reaching for zero-copy tricks. Measure or reason about frequency before optimizing.

### 4. Respect hard architectural ceilings, but verify they're real first

Some limits are real and not worth fighting:

- Native Messaging must go through `background.js` (MAIN world to isolated world bridge to background), a fixed 3-hop JS context chain enforced by the WebExtension model. No amount of serialization optimization removes this; it's an architectural ceiling.
- `MessagePort` cannot be transferred across background to content script boundary in Firefox (tested, does not work).
- Codepage 1252 issues in WiX/dotnet, Apple notarization requiring a paid developer account, etc. are real, external constraints.

But don't accept "this is the ceiling" without verifying. This project has repeatedly mistaken a bug for an architectural ceiling (e.g. claiming Worker+SharedArrayBuffer was at a performance ceiling when it was silently falling back to Native Messaging; or claiming SAB was zero-copy without counting the drain copy). Before concluding something is a hard limit, check actual logs and behavior, not just a plausible-sounding explanation.

### 5. Defense in depth for security, not a single layer

Device permission and isolation are layered independently:

- udev rules (or platform equivalent) gate which devices a non-root process can even open.
- The HID blocklist (FIDO/U2F security keys) is enforced in the daemon regardless of OS-level permissions, matching Chromium's blocklist. Keyboard and mouse device access (enumerability) is gated by the OS layer (udev rules on Linux, HID API on Windows, Input Monitoring/TCC on macOS); the daemon additionally blocks their input/output/feature reports by default (the `report-blocking` cargo feature, on by default), so consumer-input devices stay enumerable but never deliver data to pages.
- The device picker UI runs in closed-mode Shadow DOM, isolated from page script.
- WebSocket auth uses a per-session token, checked independently of the above.

Don't remove a layer because another layer "already covers it"; they are independent, not redundant.

### 6. Before deleting code, confirm it's actually dead

A parser that looks unused after a refactor may still be load-bearing for a specific device or code path. Verify by testing against real hardware after removal, not just by grepping for callers. If removing something breaks a real device, that's a signal to understand why it was needed before re-adding it, not just to revert blindly.

### 7. Prefer the narrowest permission that works

Example: a udev rule scoped to a specific vendor/product ID is preferred over a blanket `SUBSYSTEM=="hidraw", TAG+="uaccess"` rule that grants access to every HID device on the system, even though the blanket rule is simpler to write.

### 8. When a tradeoff has no universally correct answer, expose it as a setting

Some decisions genuinely depend on the user's workload and can't be resolved by more analysis: WS vs. NM for data plane, device picker mode, adaptive batching on/off. When two approaches are each better under different conditions, don't guess a single hardcoded answer. Add a toggle and let the user pick for their actual use case.

### 9. Code should carry no explanatory comments beyond docstrings

Aside from docstrings or doc-comments describing what a function, type, or module does, code should not carry inline comments explaining why something is done a certain way, especially for special cases, workarounds, or non-obvious decisions. That rationale belongs in a dedicated Markdown file (`AGENTS.md`, `CONTRIBUTING.md`, or a linked design-notes doc), not scattered through the source.

Reasoning: comments embedded in code are exactly how this project's worst mistaken assumptions calcified into "known ceilings" that nobody re-verified. A comment like `// must run on worker to avoid blocking main thread` reads as settled fact to the next person who touches the file, and gets copied into architecture docs without anyone checking if it is still true. Keeping the "why" in one reviewable, editable place instead of buried across dozens of source files makes it easier to revisit and correct when it turns out to be wrong, and keeps code itself lean and focused on what it does.
