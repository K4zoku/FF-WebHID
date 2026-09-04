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
| Native Messaging Port, G↔host              | Background connection lifetime   | Daemon-backed control and NM report traffic                       |
| WS or WT, W↔D                              | Worker/device transport lifetime | Production worker data plane                                   |

Background registers runtime Ports from `runtime.onConnect` with `registerContentPort`. Normal bridge control traffic is not a series of `runtime.sendMessage` calls. The persistent Native Messaging Port comes from `connectNative`; sending another message on it does not start another host process.

### Native Messaging deployment profiles

| Profile                          | Browser to daemon path                                                   | Extra forwarder socket/pipe hop? |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Daemon as Native Messaging host  | `G → Native Messaging stdio → D`                                         | No                               |
| Persistent daemon plus forwarder | `G → Native Messaging stdio → F → Unix socket or Windows named pipe → D` | Yes                              |

The tables below show both profiles where that extra hop changes accounting. Do not read `F` as part of daemon-as-host mode.

## Production path inventory

| Path | Operation                       | Current route                                                                                                                                         |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Browser-local control          | `P ⇄ B ⇄ webhid-control runtime Port ⇄ G` for `getPolicy`, `getPairedDevices`, page-action state, and picker bookkeeping; some settings resolve in `B` or an extension page |
| B    | Daemon-backed control          | `P → B → webhid-control runtime Port → G → Native Messaging Port → D`, or `→ F → D`, for `navigator.hid.getDevices()`/`enumeratePaired`, `open`, `close`, `handshake`, `setDataPlane`, and physical device information |
| C    | WS output or feature           | `P ⇄ W ⇄ WS ⇄ D ⇄ persistent IoCommand worker ⇄ HID`                                                                                                  |
| D    | WT output or feature           | `P ⇄ W ⇄ WT ⇄ D ⇄ persistent IoCommand worker ⇄ HID`                                                                                                  |
| E    | NM output or feature           | `P → B → webhid-data:<deviceId> Port → G → Native Messaging Port → D → persistent IoCommand worker → HID`, with `F → D` added in forwarder mode      |
| F    | WS input                       | `HID → reader → event-broadcast queue → D/batching → WS → W → transferred page MessagePort → P`                                                          |
| G    | WT input                       | `HID → reader → event-broadcast queue → D/batching → WT → W → transferred page MessagePort → P`                                                          |
| H    | NM input, primary              | `HID → reader → nm_hot sink queue → Native Messaging → G → webhid-data:<deviceId> Port → B → page data MessagePort → P`                                |
| I    | NM input, fallback delivery    | Same as H until G. `G → tabs.sendMessage → B → page data MessagePort → P` only for target tabs not reached through the persistent data Port.          |
| J    | First open                    | Daemon-backed control → `OpenReservation` → physical HID open → publish Entry → register Session → release reader-start gate → optional worker setup |
| K    | Additional open               | Daemon-backed control → register another Session on an existing Entry → optional worker setup                                                        |
| L    | Close                         | Daemon-backed control → revoke one Session's authority; physical Entry teardown only after the final Session or a force-close/failure condition       |

`sendReport`, `sendFeatureReport`, and `receiveFeatureReport` use Path E in NM mode. They do not use one-shot bridge `runtime.sendMessage` requests.

## Direct worker paths

### Output and feature requests

For WS and WT, page and worker communicate over the transferred per-device data MessagePort. The bridge transferred the port during setup, but does not relay normal report traffic afterward.

```text
P data MessagePort → W → WS or WT → D → IoCommand queue → persistent HID handle
D → WS or WT → W → P data MessagePort
```

The worker owns request ids and transport acknowledgement handling. It builds the binary transport frame, and the daemon queues an authority-validated `IoCommand`. The I/O worker serializes output, feature write, and feature read against the persistent HID handle, then returns completion through a oneshot reply to the daemon task.

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

Counts below are application-level handoffs at the canonical component boundaries shown in the routes. Each directional crossing of a named MessagePort, runtime Port, Native Messaging, transport, queue, or HID boundary counts once. Included queues are the reader-to-event-broadcast queue, reader-to-`nm_hot` sink queue, and daemon-task-to-persistent-I/O-worker queue, with the I/O oneshot reply counted in the reverse direction. Internal transport task queues and browser-internal channel scheduling are excluded because they are implementation details inside the endpoint boundary. Browser-internal, TLS, TCP, UDP, kernel, and allocator copies are also excluded. The named transformations identify known application payload work instead of presenting unsupported total-copy estimates.

| Path                                      | Handoffs, daemon-as-host | Handoffs, forwarder | Known application payload transformations                                                                                                                                           |
| ----------------------------------------- | -----------------------: | ------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-local control request and response |                        4 |                   4 | Runtime-Port messages; policy/storage/picker state resolution.                                                                                                                      |
| Daemon-backed control request and response |                        6 |                   8 | Runtime-Port messages and Native Messaging JSON framing; control payloads are not hot-path report data.                                                                             |
| WS or WT output plus acknowledgement      |                        8 |                   8 | Page payload transfer to worker; worker frame creation; daemon payload extraction; HID write-buffer construction; transport framing; oneshot completion reply.                     |
| NM output or feature plus acknowledgement |                       10 |                  12 | Page to bridge transfer; runtime-Port structured clone; packed TLV/base64 encode and decode; daemon payload extraction; HID write-buffer construction; JSON/native-message framing; oneshot completion reply. |
| WS input                                  |                        4 |                   4 | Reader event-broadcast queue and daemon batch framing; worker parse and report-buffer creation; worker to page buffer transfer.                                                     |
| WT input                                  |                        4 |                   4 | Reader event-broadcast queue and daemon batch framing; worker parse and report-buffer creation; worker to page buffer transfer.                                                     |
| NM input, Port-first                      |                        5 |                   6 | Packed input construction and base64 encode/decode; reader-to-`nm_hot` queue; background report payload allocation; runtime-Port structured clone.                                                            |
| NM input, tab fallback                    |                        5 |                   6 | Same as Port-first, except background uses `tabs.sendMessage` for the G→B leg.                                                                                                      |

The concrete derivations are:

- Direct WS/WT output has eight handoffs: `P→W`, `W→D`, `D→I/O worker`, `I/O worker→HID`, `HID→I/O worker`, `I/O worker→D` (oneshot completion), `D→W`, and `W→P`. The bridge is absent from this steady-state path.
- Direct NM output has ten: `P→B`, `B→G`, `G→D`, `D→I/O worker`, `I/O worker→HID`, `HID→I/O worker`, `I/O worker→D`, `D→G`, `G→B`, and `B→P`. The forwarder route is twelve because `G↔F` and `F↔D` replace the single `G↔D` Native Messaging boundary on both request and response directions.
- WS/WT input has four: `HID→reader`, `reader→event-broadcast queue`, `D→W` through the transport boundary, and `W→P`. The daemon's batching consumes the explicit event queue before sending the transport frame.
- NM input Port-first has five direct handoffs: `HID→reader`, `reader→nm_hot sink queue`, `D→G` through the Native Messaging writer, `G→B` through the matching data Port, and `B→P`. Forwarder mode has six because `D→F` and `F→G` replace the direct `D→G` boundary. The `tabs.sendMessage` fallback replaces only the `G→B` delivery surface, so it has the same 5/6 counts.
- Daemon-backed control has six direct handoffs: `P→B`, `B→G`, `G→D`, `D→G`, `G→B`, and `B→P`. Forwarder mode has eight because the request and response each add the forwarder/socket route.

## Benchmark-only WT in-page variant

The benchmark harness can write `dataPlane: 'wt'` and `useWorker: false`. In that variant the MAIN-world page receives the derived transport authentication value needed to establish WT, not the daemon Session bearer token. It is retained as a benchmark/control configuration to measure the cost of moving transport handling and parsing back onto the page main thread. It is intentionally hidden from normal settings because it is not the preferred production architecture and performs worse under page CPU and render load. It is excluded from the production path inventory and accounting above.

`BENCHMARK.md` retains the `wt-inpage` datasets because they describe code that the benchmark exercises. Those results must be interpreted as benchmark-only, not as production-mode guidance.

## Current implementation references

- `addon/js/content/isolated/bridge.js`: `webhid-control`, `webhid-data:<deviceId>`, worker setup, NM report forwarding.
- `addon/js/background/messages.js` and `content-ports.js`: `runtime.onConnect` dispatch and Port registration.
- `addon/js/background/nm.js`: persistent Native Messaging connection and Port-first NM input delivery with tab fallback.
- `crates/webhid-daemon/src/device_mgr.rs`: Sessions, Entries, reservations, `nm_hot`, authority, reader, and persistent I/O worker.
- `crates/webhid-daemon/src/client.rs`: persistent NM client writer and report dispatch.
- `crates/webhid-daemon/src/batching.rs`, `websocket.rs`, and `webtransport.rs`: transport framing and batched delivery.
