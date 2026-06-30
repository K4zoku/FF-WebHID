const CAPACITY = 2048;

let sab = null, meta = null, data = null, reportSize = 64, ws = null;
const _pending = new Map();
let _nextReqId = 1;
let _fireAndForget = true;
let _perfLogging = false;

const MSG_SEND_REPORT = 0x01;
const MSG_SEND_FEATURE_REPORT = 0x02;
const MSG_RECEIVE_FEATURE_REPORT = 0x03;
const RESP_RECEIVE_FEATURE_REPORT = 0x83;

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'connect') return connect(msg);
  if (msg.type === 'settings') { _fireAndForget = msg.fireAndForget !== false; _perfLogging = msg.perfLogging === true; return; }
  if (msg.type === 'send') return handleSend(msg, MSG_SEND_REPORT);
  if (msg.type === 'sendFeature') return handleSend(msg, MSG_SEND_FEATURE_REPORT);
  if (msg.type === 'receiveFeature') return handleReceiveFeature(msg);
  console.warn('[worker] unknown msg type:', msg.type);
};

let _connectMsg = null;
let _reconnectTimer = null;
let _reconnectDelay = 500;

function connect(msg) {
  console.log('[worker] connect wsPort=' + msg.wsPort + ' reportSize=' + (msg.reportSize || 64));
  _connectMsg = msg;
  reportSize = msg.reportSize || 64;
  if (!sab) {
    sab = new SharedArrayBuffer(12 + CAPACITY * reportSize);
    meta = new Int32Array(sab, 0, 3);
    data = new Uint8Array(sab, 12);
  }
  _doConnect();
}

function _doConnect() {
  try {
    ws = new WebSocket(`ws://127.0.0.1:${_connectMsg.wsPort}?token=${_connectMsg.token}`);
  } catch (e) {
    console.error('[worker] WebSocket() threw:', e);
    _scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    console.log('[worker] WS OPEN');
    _reconnectDelay = 500;
    self.postMessage({ type: 'ready', sab });
  };
  ws.onerror = (e) => {
    console.error('[worker] WS ERROR:', e.message || e, 'state=' + (ws ? ws.readyState : 'null'));
  };
  ws.onclose = (e) => {
    console.warn('[worker] WS CLOSED code=' + e.code + ' clean=' + e.wasClean + ' pending=' + _pending.size);
    for (const [, p] of _pending) p.reject(new Error('ws closed'));
    _pending.clear();
    self.postMessage({ type: 'closed' });
    _scheduleReconnect();
  };
  ws.onmessage = ({ data: frame }) => {
    const batch = new Uint8Array(frame);
    if (batch.length > 0 && batch[0] >= 0x80) return handleControlResponse(batch);
    pushInputBatch(batch);
  };
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  console.log('[worker] reconnect in', _reconnectDelay, 'ms');
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!_connectMsg) return;
    _doConnect();
  }, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, 5000);
}

function pushInputBatch(batch) {
  let offset = 0, count = 0;
  while (offset + 1 < batch.length) {
    const len = batch[offset] | (batch[offset + 1] << 8);
    offset += 2;
    if (len === 0 || offset + len > batch.length) break;
    const head = Atomics.load(meta, 0);
    const next = (head + 1) % CAPACITY;
    if (next === Atomics.load(meta, 1)) { Atomics.add(meta, 2, 1); offset += len; continue; }
    const slotStart = head * reportSize;
    data.fill(0, slotStart, slotStart + reportSize);
    const storedLen = Math.min(len, reportSize - 2);
    if (len > reportSize - 2) console.warn('[worker] TRUNCATING report len=' + len + ' to ' + (reportSize - 2));
    data[slotStart] = storedLen & 0xFF;
    data[slotStart + 1] = (storedLen >> 8) & 0xFF;
    data.set(batch.subarray(offset, offset + storedLen), slotStart + 2);
    Atomics.store(meta, 0, next);
    offset += len;
    count++;
  }
  if (count > 0) Atomics.notify(meta, 0);
}

function handleSend(msg, msgType) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[worker] send: WS not open (state=' + (ws ? ws.readyState : 'null') + ')');
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: 'ws not open' });
    return;
  }
  const reqId = _nextReqId++;
  const payload = new Uint8Array(msg.data);
  const frame = new Uint8Array(6 + payload.length);
  frame[0] = msgType;
  frame[1] = reqId & 0xFF; frame[2] = (reqId >> 8) & 0xFF; frame[3] = (reqId >> 16) & 0xFF; frame[4] = (reqId >> 24) & 0xFF;
  frame[5] = msg.reportId;
  frame.set(payload, 6);
  const t0 = performance.now();
  if (_fireAndForget) {
    ws.send(frame);
    if (_perfLogging) console.log('[worker] send reqId=' + reqId + ' ff ' + (performance.now() - t0).toFixed(1) + 'ms');
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true });
    return;
  }
  _pending.set(reqId, {
    resolve: () => { if (_perfLogging) console.log('[worker] send reqId=' + reqId + ' ok ' + (performance.now() - t0).toFixed(1) + 'ms'); self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true }); },
    reject: (e) => { console.warn('[worker] send reqId=' + reqId + ' FAIL:', e.message); self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: String(e.message || e) }); },
  });
  ws.send(frame);
}

function handleReceiveFeature(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: 'ws not open' });
    return;
  }
  const reqId = _nextReqId++;
  const frame = new Uint8Array(6);
  frame[0] = MSG_RECEIVE_FEATURE_REPORT;
  frame[1] = reqId & 0xFF; frame[2] = (reqId >> 8) & 0xFF; frame[3] = (reqId >> 16) & 0xFF; frame[4] = (reqId >> 24) & 0xFF;
  frame[5] = msg.reportId;
  const t0 = performance.now();
  _pending.set(reqId, {
    resolve: (data) => { console.log('[worker] recvFeature reqId=' + reqId + ' ok ' + (performance.now() - t0).toFixed(1) + 'ms len=' + data.length); self.postMessage({ type: 'featureResult', reqId: msg.reqId, data }); },
    reject: (e) => { console.warn('[worker] recvFeature reqId=' + reqId + ' FAIL:', e.message); self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: String(e.message || e) }); },
  });
  ws.send(frame);
}

function handleControlResponse(batch) {
  if (batch.length < 6) return;
  const respType = batch[0];
  const reqId = batch[1] | (batch[2] << 8) | (batch[3] << 16) | (batch[4] << 24);
  const status = batch[5];
  const p = _pending.get(reqId);
  if (!p) return; // fire-and-forget: send/sendFeature responses are silently dropped
  _pending.delete(reqId);
  if (respType === RESP_RECEIVE_FEATURE_REPORT) {
    if (status !== 0) return p.reject(new Error('feature read failed'));
    if (batch.length < 8) return p.reject(new Error('short feature resp'));
    const len = batch[6] | (batch[7] << 8);
    const out = new Uint8Array(len);
    if (len > 0 && batch.length >= 8 + len) out.set(batch.subarray(8, 8 + len));
    return p.resolve(out);
  }
  if (status === 0) p.resolve();
  else p.reject(new Error('write failed status=' + status));
}
