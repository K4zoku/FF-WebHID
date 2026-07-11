# Agent Guidelines for FF-WebHID

These are the design principles this project has converged on. Follow them by default; deviating requires a good reason, not just convenience.

## 1. Daemon output is a contract, not a promise

The daemon is the single source of truth for data shape (collections, reports, device info). Its output must be correct by construction (e.g. normalize at the serde/serialize layer), not "mostly right, fixed up by the consumer."

The addon (polyfill, background, worker) should **not** add defensive fallbacks (`?? []`, shape-guessing, silent recovery) for data coming from the daemon. If the daemon's output is ever wrong, that's a daemon bug to fix at the source, not something to paper over downstream. Silently tolerating bad shape hides bugs instead of surfacing them.

This is intentionally the "conservative in what you send" half of Postel's Law, without the "liberal in what you accept" half, since blind leniency on the receiving end tends to hide bugs and lets aberrant behavior become a de facto standard.

## 2. Single source of truth for protocol logic

Only the daemon understands the wire format / protocol semantics. Other components (NM host, addon layers) should be as "dumb" as possible:

- The NM host is a thin forwarder: it moves bytes (via `splice()` on Linux, vectored I/O elsewhere) between stdio and the Unix socket. It does not parse, deserialize, or reason about message content.
- Don't duplicate parsing/serialization logic across crates or across JS contexts. If two places need to understand the same structure, that's a signal the structure should be produced/consumed in one place and passed through as opaque bytes everywhere else.

## 3. Zero-copy by default on hot paths, but know which paths are hot

- Report data (`sendReport`, `oninputreport`) is the hot path: use SharedArrayBuffer + Atomics where available, and `Transferable` objects (`postMessage(data, [buffer])`) where SAB isn't (e.g. SAB disabled by user, or context boundaries that don't support SAB).
- Control-plane / setup paths (device enumeration, collections fetch, settings) are not hot paths. Don't over-optimize them at the cost of readability; a plain copy once per `open()` call is fine.
- Know the difference before reaching for zero-copy tricks. Measure or reason about frequency before optimizing.
- "Zero-copy" is not a single property to compare path-to-path. Count the copies for the *whole* journey (network to consumer), not just the first hop. A path with one big zero-copy hop plus one hidden copy later can lose to a simpler path with a single transfer and no copies at all. Benchmark end-to-end before assuming the theoretically-fancier mechanism wins.
- Case study: profiler analysis (paint-by-paint delta) found WS running on the content-script main thread ("bridge-direct") loses late-phase throughput to NM, because WS receive/parse has to share CPU with page rendering (CanvasKit/WASM), while NM's subprocess is CPU-isolated. This is a genuine architectural tradeoff, confirmed by data, not a bug. Moving WS onto a dedicated Worker fixes it. Note this is a *different* reason than the old (mistaken) "worker needed to avoid blocking main thread for Atomics" belief below; that one was never real, while this CPU-contention one is profiler-confirmed.

## 4. Respect hard architectural ceilings, but verify they're real first

Some limits are real and not worth fighting:
- Native Messaging must go through `background.js` (MAIN world to isolated world bridge to background), a fixed 3-hop JS context chain enforced by the WebExtension model. No amount of serialization optimization removes this; it's an architectural ceiling.
- `MessagePort` cannot be transferred across background <-> content script boundary in Firefox (tested, does not work).
- `Codepage 1252` issues in WiX/dotnet, Apple notarization requiring a paid developer account, etc. are real, external constraints.

But **don't accept "this is the ceiling" from an agent (including yourself) without verifying**. This project has repeatedly mistaken a bug for an architectural ceiling:
- Worker + SharedArrayBuffer was reported as "already at the performance ceiling" by an earlier agent, when it turned out Worker+SAB was never actually engaging, and everything was silently falling back to Native Messaging. Full log + source review (not just a described architecture) found the real bug.
- "SAB push must run on a Worker to avoid blocking main thread via `Atomics.wait`" was carried as fact from a code comment, never re-verified after the drain path moved to `Atomics.waitAsync` (non-blocking). That specific mechanism (blocking wait) was never actually in the flow, so that particular rationale didn't apply. But the *general* concern, that running WS receive/parse on main thread contends for CPU with rendering, turned out to be real, and was confirmed later by profiler data (see the CPU-contention case study in Section 3): bridge-direct doesn't crash or visibly jank, but it does lose real throughput (510 vs 681 msg/s late-phase) under a render-heavy scenario. So the instinct to keep WS off the main thread was right, even though the specific justification given for it (blocking Atomics) was wrong. Two different claims; don't conflate them when reading this history.
- "SAB is zero-copy, so it must be the fastest data-plane option" turned out false by half. SAB write is zero-copy (network to SAB), but drain still requires one copy out to a fresh buffer, because `HIDInputReportEvent` needs exclusive ownership and the SAB slot gets overwritten by the next report. The no-SAB path (bridge to page via `postMessage` + Transferable) has zero copies end to end, since transfer grants exclusive ownership in one step.
- Before concluding something is a hard limit, check actual logs/behavior, not just a plausible-sounding architectural explanation.

## SAB removed entirely (2026-07)

After the SAB ring-buffer alloc-size bug was fixed (see below), SAB was benchmarked against a simpler no-SAB path and lost, while also carrying real ongoing costs (cross-origin isolation requirement, COOP/COEP injection risk, Atomics/ring-buffer complexity). Decision: remove SAB entirely rather than keep it as an "opt-in performance mode." This was not SAB being wrong from the start. NM's real burst/latency problems were the original justification for trying SAB, and pursuing SAB is what forced the investigation that uncovered the alloc bug and the CPU-contention finding above. SAB was a necessary rung on the ladder, not wasted effort; the decision to remove it is evidence-based (post-benchmark), not assumed upfront.

**Final WS data-plane architecture:**
`daemon <-WS-> Worker (no SAB) <-MessageChannel port, transferred once at setup-> page (main thread)`
- Worker owns the WS connection, allocates the buffer, and posts each report directly to the page through a `MessagePort` transferred once during setup: one hop per report, zero copies, and CPU-isolated from rendering.
- Bridge (content script) only does three things: (1) spawns the worker, (2) creates and relays the MessagePort to page once at setup, (3) despawns/respawns workers when the user changes settings. It does not sit on any per-message hot path anymore, for either control or data plane.
- Two independent worker types, with no shared state or dependency between them:
  - **Control Worker**: owns the WS control connection (enumerate/open/close). Spawned as soon as settings are available (before page load), lives for the tab's lifetime, killed on tab close or when the user changes the control-plane setting.
  - **Data Worker**: per-device, spawned on `open()`, killed on device close.
- A 2-hop relay (worker to bridge to page, both via Transferable `postMessage`) is the fallback path if direct `MessagePort` transfer ever fails; direct port is primary.
- Data-plane transport can be switched mid-session (WS <-> NM) via a single control-plane command telling the daemon to re-route that device's reports, with no ack/handshake. A report being duplicated or dropped during the switch instant is accepted as a user-caused edge case, not engineered around.

## 5. Don't keep backwards-compatibility shims for users that don't exist

Don't add backwards-compatibility shims, migration paths, or defensive fallbacks for a project with no external users depending on old behavior unless explicitly asked. This is a fresh project without legacy constraints, so prefer deleting old code paths outright over keeping them "just in case."

## 6. Defense in depth for security, not a single layer

Device permission and isolation are layered independently:
- udev rules (or platform equivalent) gate which devices a non-root process can even open.
- The HID blocklist (keyboard/mouse standard collections, FIDO/U2F) is enforced in the daemon regardless of OS-level permissions.
- The device picker UI runs in closed-mode Shadow DOM, isolated from page script.
- WebSocket auth uses a per-session token, checked independently of the above.

Don't remove a layer because another layer "already covers it"; they're independent, not redundant.

## 7. Before deleting code, confirm it's actually dead

A parser that looks unused after a refactor (e.g. the pre-hidapi Linux-only report descriptor parser) may still be load-bearing for a specific device or code path. Verify by testing against real hardware after removal, not just by grepping for callers. If removing something breaks a real device, that's a signal to understand *why* it was needed before re-adding it, not just to revert blindly.

## 8. Prefer the narrowest permission that works

Example: a udev rule scoped to a specific vendor/product ID is preferred over a blanket `SUBSYSTEM=="hidraw", TAG+="uaccess"` rule that grants access to every HID device on the system, even though the blanket rule is simpler to write.

## 9. When a tradeoff has no universally correct answer, expose it as a setting

Some decisions genuinely depend on the user's workload and can't be resolved by more analysis: fire-and-forget vs. ack-wait, WS vs. NM for data/control plane, adaptive batching on/off. When two approaches are each better under different conditions (e.g. batching helps small sparse bursts but can hurt large-data bursts by delaying flush), don't guess a single hardcoded answer. Add a toggle and let the user pick for their actual use case. This project has consistently done this rather than debating which option is "correct" in the abstract.

- Control-plane and data-plane transport (WS/NM) are a single basic toggle by default, keeping both in sync as WS+WS or NM+NM, reduced from 6 historical combinations (which included SAB variants) down to a clean 4 (WS/NM x WS/NM). An "Advanced" section exposes control-plane and data-plane as independent toggles for the rare case someone wants a mixed combination. This exists as a safety valve for an unverified need, not a confirmed use case, so don't be surprised if nobody ever uses mixed mode.

## Project-specific facts worth remembering

- The daemon has two deployment modes: (1) persistent root daemon + thin NM-host forwarder over Unix socket, for setups without udev rules configured; (2) daemon-as-NM-host, spawned directly by Firefox, running as the user, requiring udev rules to be set up. These aren't redundant; they serve different permission setups and should both keep working.
- macOS requires Input Monitoring (TCC) permission for `IOHIDManager` access. There's no way to prompt for it programmatically, so the user must grant it manually in System Settings.
- Windows requires no special permission for standard HID access via `HidD_*` APIs.
- Linux permission model varies by distro: most use `udev`/`eudev` (rule-compatible), but Alpine defaults to `mdev` (different config syntax, see `packaging/linux/mdev.conf`).
- SAB ring buffer defaulted to 8192 slots, sized by an *estimated* max report size from collection calculations. This produced a 16MB allocation at worker init, adding real native-runtime cost that erased SAB's round-trip advantage over NM in early benchmarks, making them look "equivalent" when they weren't. Fixed by (1) computing exact per-report size from the descriptor at parse time in the daemon instead of estimating, and (2) defaulting slot count to 64, exposed as a user setting (this setting was later removed entirely along with SAB, see above). Debug logs on real devices (SayoDevice) showed drain never lags behind push enough to need more than 1 occupied slot at a time in practice; the multi-slot ring buffer's core justification (absorbing burst when consumer is slower than producer) was not actually observed to trigger, even at 8000Hz polling rate.
- NM messages moved from verbose per-field JSON to a binary packed format for both hot-path input reports and cold-path collections/enumerate/open responses, including offset/pointer-based addressing for nested collection structures (a plain `{"d": "base64(...)"}` wrapper and then short-keyed JSON were both intermediate steps, superseded by full binary packing). Compression was considered and explicitly rejected: for messages this small, compress/decompress CPU and allocation cost outweighs the bandwidth savings. Note that the collections/enumerate/open work is cold-path (runs once per `open()`), and this specific optimization was pursued for its own sake / out of curiosity rather than because benchmarking showed a need; flag this if evaluating whether to maintain or simplify it later. NM has a real 1MB message size ceiling (app to browser direction) enforced by the browser. This isn't a practical concern at current report/collection sizes, but it's worth a daemon-side sanity check/log if a message ever approaches it, guarding against a batching bug silently building an oversized message, similar in spirit to the SAB alloc bug above.
- Cold-start benchmark methodology matured: a local clone of the test site (sayodevice.com) with URLs patched to load locally removed network-load timing variance, which had been causing GCMajor to intrude into benchmark windows unpredictably (a slow network load could push GC to trigger right as the person clicked, corrupting the "cold start" assumption). Planned next step: Playwright automation to remove the last variance source, human click timing.
- Exploratory branches, explicitly curiosity-driven rather than requirement-driven (don't assume these were benchmark-justified):
  - **WebTransport/QUIC data-plane**: self-signed cert with `serverCertificateHashes`, rotated at most every 14 days (daemon tracks expiry and re-sends the new hash over the NM control channel each rotation). Firefox added proper `serverCertificateHashes` support after previously not supporting it at all; implementation is still young, so expect rough edges (opaque `ready` promise rejections, limited DevTools observability for datagram payloads). Plan to debug via `console.debug` logging rather than Network tab, consistent with how WS/NM are already debugged in this project. Expected latency gain on a localhost daemon connection is near-zero, since QUIC's real advantages (0-RTT resume, no head-of-line blocking, resilience to packet loss) don't apply to a lossless loopback connection. Pursued for architectural cleanliness (a legitimate, spec-sanctioned way to avoid the faketls/wildcard-cert trick Sainan's project used) and general interest, not for speed.
  - **Chromium testbed**: overriding `navigator.hid` via `Object.defineProperty` on Chromium (confirmed technically works) to compare the polyfill against Chromium's native WebHID on the same browser engine, isolating "polyfill tax" from Gecko-vs-Blink engine differences. Not yet benchmarked as of this writing (still at the "about to start measuring" stage). Do not assume or repeat any claim that the polyfill beats native Chromium until real numbers exist.

## Not every change needs a benchmark-driven justification

Some architecture changes in this project were made because they were interesting to try, not because a benchmark demanded them (e.g. binary-packed collections, WebTransport exploration). That's a legitimate reason on its own. When reviewing history here, don't retroactively invent a performance rationale for a change that was actually curiosity-driven; note it as such instead.

## 10. Writing style: no em-dashes

Don't use em-dashes ("—") anywhere in this document or in any writing produced for this project. Rewrite with smoother sentence flow (subordinate clauses, "since"/"so"/"which", or splitting into two sentences), or fall back to a comma, colon, semicolon, or parentheses when a harder break is actually needed. Em-dash is a style tic to actively avoid, not just deprioritize.

## 11. Code should carry no explanatory comments beyond docstrings

Aside from docstrings/doc-comments describing what a function, type, or module does, code should not carry inline comments explaining *why* something is done a certain way, especially for special cases, workarounds, or non-obvious decisions. That rationale belongs in a dedicated Markdown file (this one, or a linked design-notes doc), not scattered through the source.

Reasoning: comments embedded in code are exactly how this project's worst mistaken assumptions calcified into "known ceilings" that nobody re-verified (see Section 4). A comment like `// must run on worker to avoid blocking main thread` reads as settled fact to the next person (or agent) who touches the file, and gets copied into architecture docs without anyone checking if it's still true. Keeping the "why" in one reviewable, editable place (this file) instead of buried across dozens of source files makes it easier to revisit and correct when it turns out to be wrong, and keeps code itself lean and focused on *what* it does.
