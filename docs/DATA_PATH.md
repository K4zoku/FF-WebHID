# Data Path Analysis

This document describes the current production topology and its application-level boundary accounting. It does not publish latency estimates. Measured benchmark datasets, including their hardware and harness caveats, are in [BENCHMARK.md](BENCHMARK.md).

Production paths are NM, worker WS, and worker WT. `wt-inpage` remains implemented only for benchmark and test runs, and is described in the benchmark-only section below.

## Execution contexts

| Symbol | Context                             | Role                                                                         |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------- |
| P      | Page MAIN world                     | WebHID polyfill and page-facing MessagePorts                                 |
| B      | Isolated bridge                     | Persistent bridge runtime Ports, worker setup, fallback, and consent control |
| W      | Per-device data worker              | Production WS or WT transport and direct page data port                      |
| G      | Extension background                | Runtime-Port dispatch, NM connection, input fanout                           |
| D      | `webhid-daemon`                     | Sessions, physical Entries, HID reader, I/O worker, WS/WT server             |
| F      | `webhid-native-messaging` forwarder | Stdio to daemon socket/pipe relay, only in forwarder deployment              |

## Persistent connections and deployment profiles

### Browser connections

| Surface                                    | Lifetime                         | Used for                                                       |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------------------- |
| Page control MessagePort, P↔B              | Page/bridge lifetime             | Ordinary page API control traffic                              |
| `webhid-control` runtime Port, B↔G         | Bridge lifetime                  | Queued normal bridge control requests                          |
| Page data MessagePort, P↔B or P↔W          | Device open lifetime             | Report and feature operations, input reports, acknowledgements |
| `webhid-data:<deviceId>` runtime Port, B↔G | Device NM lifetime               | NM report/feature traffic and Port-first NM input delivery     |
| Native Messaging Port, G↔host              | Background connection lifetime   | All daemon control and NM report traffic                       |
| WS or WT, W↔D                              | Worker/device transport lifetime | Production worker data plane                                   |

Background registers runtime Ports from `runtime.onConnect` with `registerContentPort`. Normal bridge control traffic is not a series of `runtime.sendMessage` calls. The persistent Native Messaging Port comes from `connectNative`; sending another message on it does not start another host process.

### Native Messaging deployment profiles

| Profile                          | Browser to daemon path                                                   | Extra forwarder socket/pipe hop? |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Daemon as Native Messaging host  | `G → Native Messaging stdio → D`                                         | No                               |
| Persistent daemon plus forwarder | `G → Native Messaging stdio → F → Unix socket or Windows named pipe → D` | Yes                              |

The tables below show both profiles where that extra hop changes accounting. Do not read `F` as part of daemon-as-host mode.

## Production path inventory

| Path | Operation                   | Current route                                                                                                                                   |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Control request             | `P → B → webhid-control Port → G → Native Messaging Port → D`, or `→ F → D`                                                                     |
| B    | WS output or feature        | `P ⇄ W ⇄ WS ⇄ D ⇄ persistent IoCommand worker ⇄ HID`                                                                                            |
| C    | WT output or feature        | `P ⇄ W ⇄ WT ⇄ D ⇄ persistent IoCommand worker ⇄ HID`                                                                                            |
| D    | NM output or feature        | `P → B → webhid-data:<deviceId> Port → G → Native Messaging Port → D → persistent IoCommand worker → HID`, with `F → D` added in forwarder mode |
| E    | WS input                    | `HID → D → WS → W → transferred page MessagePort → P`                                                                                           |
| F    | WT input                    | `HID → D → WT → W → transferred page MessagePort → P`                                                                                           |
| G    | NM input, primary           | `HID reader → active nm_hot sink → Native Messaging → G → webhid-data:<deviceId> Port → B → page data MessagePort → P`                          |
| H    | NM input, fallback delivery | Same as G until G. `G → tabs.sendMessage → B → page data MessagePort → P` only for target tabs not reached through the persistent data Port.    |
| I    | First open                  | Control path → `OpenReservation` → physical HID open → publish Entry → register Session → release reader-start gate → optional worker setup     |
| J    | Additional open             | Control path → register another Session on an existing Entry → optional worker setup                                                            |
| K    | Close                       | Control path → revoke one Session's authority; physical Entry teardown only after the final Session or a force-close/failure condition          |

`sendReport`, `sendFeatureReport`, and `receiveFeatureReport` use Path D in NM mode. They do not use one-shot bridge `runtime.sendMessage` requests.

## Direct worker paths

### Output and feature requests

For WS and WT, page and worker communicate over the transferred per-device data MessagePort. The bridge transferred the port during setup, but does not relay normal report traffic afterward.

```text
P data MessagePort → W → WS or WT → D → IoCommand queue → persistent HID handle
D → WS or WT → W → P data MessagePort
```

The worker owns request ids and transport acknowledgement handling. It builds the binary transport frame, and the daemon queues an authority-validated `IoCommand`. The I/O worker serializes output, feature write, and feature read against the persistent HID handle.

### Input reports

The daemon batches WS and WT input independently of the page MessagePort. The worker parses each received transport frame and transfers report buffers directly to the page. The normal direct route is:

```text
HID → daemon → WS or WT → worker → transferred MessagePort → page
```

Bridge involvement is limited to setup, spawn/despawn, data-plane change, transport failure, and the explicit fallback path when a page-to-worker port cannot be transferred.

## Native Messaging paths

### Output and feature requests

The page transfers its report payload to bridge through its data MessagePort. Bridge assigns a runtime-Port request id and posts through the persistent per-device `webhid-data:<deviceId>` Port. Background packs output and feature-write requests as base64 TLV data on the persistent Native Messaging connection. `receiveFeatureReport` is a JSON action on that same connection.

On the daemon, the active client and device must have a valid `nm_hot` binding. Its `IoCommand` captures the binding validity and current Entry `io_epoch`; the persistent I/O worker checks both before the HID operation. The acknowledgement returns on the same Native Messaging connection, then the same per-device runtime Port, then the page data MessagePort.

### Input reports

The input reader calls `route_nm_input` before considering the generic broadcast channel. It creates a packed NM input message for each valid, active client-bound `nm_hot` sink. The client writer sends it through the already-connected Native Messaging stream.

Background decodes the packed message, identifies authorized target tabs, and tries `postToContentPorts(targets, message, 'webhid-data:<deviceId>')` first. The return value identifies reached tabs. Only the remaining targets receive `tabs.sendMessage`, then their bridge forwards to its page data MessagePort.

The generic broadcast event path supports non-NM sessions and lifecycle events. It is not the primary NM input-report path.

## Logical Sessions and physical Entries

A Session is a unit of ownership and transport authority. An Entry is the shared physical device lifetime.

### First open

1. The daemon creates an `OpenReservation` while serializing lifecycle changes.
2. It opens the physical HID device.
3. It creates the Entry's reader-start gate, reader, persistent I/O queue and worker, epoch, and report-blocking state.
4. It publishes the Entry.
5. It registers the first logical Session and refreshes its NM hot binding if NM is active.
6. It releases the reader-start gate only after publication.

### Additional open

A later or concurrent open registers another logical Session against the already-published Entry. It shares the physical HID handle, reader, and I/O worker. It does not inherently reopen hidapi or start another reader or worker.

### Close and failure

Closing one Session removes its `ws_auth_hash` mapping, revokes its transport capability, signals cancellation, and refreshes NM authority for the relevant client. The Entry remains live while another active Session references the device. The last close, reader error, or force-close removes the Entry, advances `io_epoch`, wakes the reader-start gate, stops the I/O worker, and joins the physical lifetime.

## Authority relevant to the data path

| Mechanism                                     | Role                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ws_auth_hashes`                              | Maps `ws_auth_hash → session_token`, not the reverse.                                    |
| `TransportGrant` and `TransportCapability`    | Bind WS or WT transport work to one Session generation and support immediate revocation. |
| Session cancellation                          | Stops work derived from a closed or revoked logical Session.                             |
| `nm_hot`                                      | Client and device binding for NM input sink and persistent I/O authority.                |
| `io_epoch`                                    | Invalidates queued commands from a physical Entry being torn down or replaced.           |
| `OpenReservation` and lifecycle serialization | Serialize first-open, concurrent-open, close, and force-close transitions.               |
| Reader-start gate                             | Prevents the reader from observing an unpublished or invalidated Entry.                  |

## Copy and hop accounting

Counts below are application-level handoffs. They count a MessagePort/runtime Port/Native Messaging/transport/queue/HID boundary once in each direction. They do not guess browser-internal, TLS, TCP, UDP, kernel, or allocator copies. The named transformations identify known application payload work instead of presenting unsupported total-copy estimates.

| Path                                      | Handoffs, daemon-as-host | Handoffs, forwarder | Known application payload transformations                                                                                                                                           |
| ----------------------------------------- | -----------------------: | ------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS or WT output plus acknowledgement      |                        6 |                   6 | Page payload transfer to worker; worker frame creation; daemon payload extraction; HID write-buffer construction; transport framing.                                                |
| NM output or feature plus acknowledgement |                        8 |                  10 | Page to bridge transfer; runtime-Port structured clone; packed TLV/base64 encode and decode; daemon payload extraction; HID write-buffer construction; JSON/native-message framing. |
| WS or WT input                            |                        4 |                   4 | Daemon batch framing; worker parse and report-buffer creation; worker to page buffer transfer.                                                                                      |
| NM input, Port-first                      |                        4 |                   5 | Packed input construction and base64 encode/decode; background report payload allocation; runtime-Port structured clone.                                                            |
| NM input, tab fallback                    |                        4 |                   5 | Same as Port-first, except background uses `tabs.sendMessage` for the G→B leg.                                                                                                      |
| Control request and response              |                        6 |                   8 | Runtime-Port messages and Native Messaging JSON framing; control payloads are not hot-path report data.                                                                             |

For example, the six direct WS/WT output handoffs are `P→W`, `W→D`, `D→I/O worker`, `I/O worker→HID`, `D→W`, and `W→P`. The bridge is absent from this steady-state path. The NM count includes `P→B`, `B→G`, Native Messaging to and from the daemon, the I/O worker, HID, and the return Port path. The forwarder deployment adds one socket/pipe handoff in each direction.

## Benchmark-only WT in-page variant

The benchmark harness can write `dataPlane: 'wt'` and `useWorker: false`. In that variant the MAIN-world page owns the WT transport. It is intentionally hidden from normal settings because it exposes daemon bearer credentials to hostile page code. It is not a supported user-facing data-plane choice and is excluded from the production path inventory and accounting above.

`BENCHMARK.md` retains the `wt-inpage` datasets because they describe code that the benchmark exercises. Those results must be interpreted as benchmark-only, not as production-mode guidance.

## Current implementation references

- `addon/js/content/isolated/bridge.js`: `webhid-control`, `webhid-data:<deviceId>`, worker setup, NM report forwarding.
- `addon/js/background/messages.js` and `content-ports.js`: `runtime.onConnect` dispatch and Port registration.
- `addon/js/background/nm.js`: persistent Native Messaging connection and Port-first NM input delivery with tab fallback.
- `crates/webhid-daemon/src/device_mgr.rs`: Sessions, Entries, reservations, `nm_hot`, authority, reader, and persistent I/O worker.
- `crates/webhid-daemon/src/client.rs`: persistent NM client writer and report dispatch.
- `crates/webhid-daemon/src/batching.rs`, `websocket.rs`, and `webtransport.rs`: transport framing and batched delivery.
