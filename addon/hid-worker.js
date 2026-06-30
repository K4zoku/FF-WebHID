const CAPACITY   = 512;   // max buffered reports (power of 2)
// Layout of sab:
//   bytes 0-3   : head index  (Int32, written by worker)
//   bytes 4-7   : tail index  (Int32, written by page)
//   bytes 8-11  : dropped count (Int32)
//   bytes 12+   : report data (CAPACITY * REPORT_SIZE)
//
// Each ring slot stores `[len_u8][report_id_u8][...payload]` (len includes
// the report_id byte). This matches the WebSocket batch frame format so
// variable-length reports can be passed through verbatim. Slots are
// REPORT_SIZE bytes wide; any report larger than REPORT_SIZE-1 is truncated,
// which is a bug the caller must avoid by passing a sufficiently large
// reportSize when the worker is started.
//
// In addition to receiving input reports, this worker also acts as the
// hot-path sender for output / feature reports.  The page postMessages
// `send` / `sendFeature` / `receiveFeature` commands and the worker
// serializes them as binary WebSocket frames and awaits the matching
// response (matched by a u32 LE request id embedded in the frame).

let sab = null;
let meta = null;
let data = null;
let reportSize = 64;
let ws = null;

// Pending send-report requests: req_id → { resolve, reject }
const _pending = new Map();
let _nextReqId = 1;

// Wire format constants — must match websocket.rs
const MSG_SEND_REPORT = 0x01;
const MSG_SEND_FEATURE_REPORT = 0x02;
const MSG_RECEIVE_FEATURE_REPORT = 0x03;

const RESP_SEND_REPORT = 0x81;
const RESP_SEND_FEATURE_REPORT = 0x82;
const RESP_RECEIVE_FEATURE_REPORT = 0x83;

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'connect') {
    connect(msg);
    return;
  }

  if (msg.type === 'send') {
    handleSend(msg, MSG_SEND_REPORT);
    return;
  }

  if (msg.type === 'sendFeature') {
    handleSend(msg, MSG_SEND_FEATURE_REPORT);
    return;
  }

  if (msg.type === 'receiveFeature') {
    handleReceiveFeature(msg);
    return;
  }
};

function connect(msg) {
  reportSize = msg.reportSize || 64;
  sab = new SharedArrayBuffer(12 + CAPACITY * reportSize);
  meta = new Int32Array(sab, 0, 3);   // [head, tail, dropped]
  data = new Uint8Array(sab, 12);

  ws = new WebSocket(
    `ws://127.0.0.1:${msg.wsPort}?token=${msg.token}`
  );
  ws.binaryType = 'arraybuffer';

  ws.onopen  = () => self.postMessage({ type: 'ready', sab });
  ws.onerror = (e) => self.postMessage({ type: 'error', error: e.message });
  ws.onclose = ()  => {
    // Reject any in-flight requests so the page doesn't hang forever.
    for (const [, p] of _pending) p.reject(new Error('WebSocket closed'));
    _pending.clear();
    self.postMessage({ type: 'closed' });
  };

  ws.onmessage = ({ data: frame }) => {
    const batch = new Uint8Array(frame);

    // First byte determines whether this is a control response (≥ 0x80)
    // or an input-report batch (the original `[len][report]...` format).
    if (batch.length > 0 && batch[0] >= 0x80) {
      handleControlResponse(batch);
      return;
    }

    // Input-report batch — push into the SAB ring buffer.
    pushInputBatch(batch);
  };
}

function pushInputBatch(batch) {
  let offset = 0;
  while (offset < batch.length) {
    const len  = batch[offset++];           // total report length (incl. report_id)
    if (len === 0 || offset + len > batch.length) break;

    const head = Atomics.load(meta, 0);
    const next = (head + 1) % CAPACITY;

    if (next === Atomics.load(meta, 1)) {
      Atomics.add(meta, 2, 1); // ring full — drop
      offset += len;
      continue;
    }

    const slotStart = head * reportSize;
    const slotEnd   = slotStart + reportSize;
    data.fill(0, slotStart, slotEnd);
    const storedLen = Math.min(len, reportSize - 1);
    data[slotStart] = storedLen;
    data.set(
      batch.subarray(offset, offset + storedLen),
      slotStart + 1
    );

    Atomics.store(meta, 0, next);
    offset += len;
  }
  Atomics.notify(meta, 0);
}

function handleSend(msg, msgType) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Worker not ready yet — fall back to error so caller can retry via NM.
    self.postMessage({
      type: 'sendResult',
      reqId: msg.reqId,
      error: 'WebSocket not open',
    });
    return;
  }

  const reqId = _nextReqId++;
  const payload = new Uint8Array(msg.data);  // page already stripped report_id
  // Frame: [type][req_id_u32 LE][report_id_u8][...payload]
  const frame = new Uint8Array(6 + payload.length);
  frame[0] = msgType;
  frame[1] = reqId & 0xFF;
  frame[2] = (reqId >> 8) & 0xFF;
  frame[3] = (reqId >> 16) & 0xFF;
  frame[4] = (reqId >> 24) & 0xFF;
  frame[5] = msg.reportId;
  frame.set(payload, 6);

  _pending.set(reqId, {
    resolve: () => self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true }),
    reject:  (e) => self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: String(e.message || e) }),
  });

  ws.send(frame);
}

function handleReceiveFeature(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    self.postMessage({
      type: 'featureResult',
      reqId: msg.reqId,
      error: 'WebSocket not open',
    });
    return;
  }

  const reqId = _nextReqId++;
  // Frame: [type][req_id_u32 LE][report_id_u8]
  const frame = new Uint8Array(6);
  frame[0] = MSG_RECEIVE_FEATURE_REPORT;
  frame[1] = reqId & 0xFF;
  frame[2] = (reqId >> 8) & 0xFF;
  frame[3] = (reqId >> 16) & 0xFF;
  frame[4] = (reqId >> 24) & 0xFF;
  frame[5] = msg.reportId;

  _pending.set(reqId, {
    resolve: (data) => self.postMessage({ type: 'featureResult', reqId: msg.reqId, data }),
    reject:  (e) => self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: String(e.message || e) }),
  });

  ws.send(frame);
}

function handleControlResponse(batch) {
  // batch[0] = resp type (≥ 0x80)
  // batch[1..5] = req_id u32 LE
  // For RESP_SEND_REPORT / RESP_SEND_FEATURE_REPORT:
  //   batch[5] = status (0=ok, 1=err)
  // For RESP_RECEIVE_FEATURE_REPORT:
  //   batch[5] = status
  //   batch[6..8] = len u16 LE
  //   batch[8..8+len] = data
  if (batch.length < 6) return;
  const respType = batch[0];
  const reqId = batch[1] | (batch[2] << 8) | (batch[3] << 16) | (batch[4] << 24);
  const status = batch[5];

  const p = _pending.get(reqId);
  if (!p) return;
  _pending.delete(reqId);

  if (respType === RESP_RECEIVE_FEATURE_REPORT) {
    if (status !== 0) {
      p.reject(new Error('feature report read failed'));
      return;
    }
    if (batch.length < 8) {
      p.reject(new Error('short feature response'));
      return;
    }
    const len = batch[6] | (batch[7] << 8);
    const data = new Uint8Array(len);
    if (len > 0 && batch.length >= 8 + len) {
      data.set(batch.subarray(8, 8 + len));
    }
    p.resolve(data);
    return;
  }

  // send / sendFeature
  if (status === 0) {
    p.resolve();
  } else {
    p.reject(new Error('write failed'));
  }
}
