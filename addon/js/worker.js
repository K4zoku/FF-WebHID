// Inline logger: same level scheme as logger.js (0=error,1=warn,2=info,3=debug).
// Worker is spawned from a blob URL so it can't importScripts the addon's
// logger.js directly. The bridge sends the current logLevel in the `connect`
// message; default to warn until that arrives.
const logger = {
  _level: 1,
  error: (...a) => { if (logger._level >= 0) console.error(...a); },
  warn: (...a) => { if (logger._level >= 1) console.warn(...a); },
  info: (...a) => { if (logger._level >= 2) console.info(...a); },
  debug: (...a) => { if (logger._level >= 3) console.debug(...a); },
};

// Detect SharedArrayBuffer availability. Some sites (e.g. usevia.app) block
// COOP/COEP injection or set conflicting headers, making SAB unavailable.
// When that happens we fall back to postMessage for input report delivery.
const SAB_AVAILABLE = typeof SharedArrayBuffer !== 'undefined';

let CAPACITY = 8192;
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
  if (msg.type === 'settings') {
    if (msg.fireAndForget !== undefined) _fireAndForget = msg.fireAndForget !== false;
    if (msg.perfLogging !== undefined) _perfLogging = msg.perfLogging === true;
    if (msg.logLevel !== undefined) logger._level = msg.logLevel;
    logger.debug('[worker] settings updated fireAndForget=' + _fireAndForget + ' perfLogging=' + _perfLogging + ' logLevel=' + logger._level);
    return;
  }
  if (msg.type === 'send') return handleSend(msg, MSG_SEND_REPORT);
  if (msg.type === 'sendFeature') return handleSend(msg, MSG_SEND_FEATURE_REPORT);
  if (msg.type === 'receiveFeature') return handleReceiveFeature(msg);
};

let _connectMsg = null;
let _reconnectTimer = null;
let _reconnectDelay = 500;

function connect(msg) {
  _connectMsg = msg;
  reportSize = msg.reportSize || 64;
  CAPACITY = msg.capacity || 8192;
  if (msg.logLevel !== undefined) logger._level = msg.logLevel;
  logger.debug('[worker] connect capacity=' + CAPACITY + ' reportSize=' + reportSize + ' SAB=' + SAB_AVAILABLE);

  if (SAB_AVAILABLE) {
    sab = new SharedArrayBuffer(12 + CAPACITY * reportSize);
    meta = new Int32Array(sab, 0, 3);
    data = new Uint8Array(sab, 12);
  } else {
    logger.warn('[worker] SharedArrayBuffer unavailable — using postMessage fallback for input reports');
  }
  _doConnect();
}

function _doConnect() {
  logger.debug('[worker] WS connecting to ws://127.0.0.1:' + _connectMsg.wsPort);
  try {
    ws = new WebSocket(`ws://127.0.0.1:${_connectMsg.wsPort}`, [`webhid.${_connectMsg.token}`]);
  } catch (e) {
    logger.error('[worker] WS constructor threw:', e.message || e);
    _scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    _reconnectDelay = 500;
    logger.debug('[worker] WS connected');
    self.postMessage({ type: 'ready', sab: SAB_AVAILABLE ? sab : null });
  };
  ws.onerror = (e) => logger.error('[worker] WS ERROR:', e.message || e);
  ws.onclose = (e) => {
    logger.debug('[worker] WS closed code=' + e.code + ' clean=' + e.wasClean);
    for (const [, p] of _pending) p.reject(new Error('ws closed'));
    _pending.clear();
    self.postMessage({ type: 'closed' });
    _scheduleReconnect();
  };
  ws.onmessage = ({ data: frame }) => {
    const batch = new Uint8Array(frame);
    if (batch.length > 0 && batch[0] >= 0x80 && batch.length <= 10) return handleControlResponse(batch);
    if (SAB_AVAILABLE) {
      pushInputBatch(batch);
    } else {
      pushInputBatchPostMessage(batch);
    }
  };
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  logger.debug('[worker] scheduling reconnect in ' + _reconnectDelay + 'ms');
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
    if (next === Atomics.load(meta, 1)) {
      Atomics.add(meta, 2, 1);
      logger.warn('[worker] SAB ring buffer full — dropping report');
      offset += len;
      continue;
    }
    const slotStart = head * reportSize;
    data.fill(0, slotStart, slotStart + reportSize);
    const storedLen = Math.min(len, reportSize - 2);
    if (len > reportSize - 2) logger.warn('[worker] TRUNCATING report len=' + len + ' to ' + (reportSize - 2));
    data[slotStart] = storedLen & 0xFF;
    data[slotStart + 1] = (storedLen >> 8) & 0xFF;
    data.set(batch.subarray(offset, offset + storedLen), slotStart + 2);
    Atomics.store(meta, 0, next);
    offset += len;
    count++;
  }
  if (count > 0) {
    if (_perfLogging) logger.debug('[worker] pushed ' + count + ' reports to SAB');
    Atomics.notify(meta, 0);
  }
}

function pushInputBatchPostMessage(batch) {
  let offset = 0, count = 0;
  while (offset + 1 < batch.length) {
    const len = batch[offset] | (batch[offset + 1] << 8);
    offset += 2;
    if (len === 0 || offset + len > batch.length) break;
    const report = batch.subarray(offset, offset + len);
    self.postMessage({ type: 'inputReport', report: report.slice() });
    offset += len;
    count++;
  }
  if (_perfLogging && count > 0) logger.debug('[worker] forwarded ' + count + ' reports via postMessage');
}

function handleSend(msg, msgType) {
  const t0 = _perfLogging ? performance.now() : 0;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logger.warn('[worker] send: WS not open');
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
  if (_fireAndForget) {
    ws.send(frame);
    if (_perfLogging) logger.debug('[worker] send reportId=' + msg.reportId + ' len=' + payload.length + ' fire-and-forget ' + (performance.now() - t0).toFixed(2) + 'ms');
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true });
    return;
  }
  _pending.set(reqId, {
    resolve: () => {
      if (_perfLogging) logger.debug('[worker] send reportId=' + msg.reportId + ' len=' + payload.length + ' acked ' + (performance.now() - t0).toFixed(2) + 'ms');
      self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true });
    },
    reject: (e) => self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: String(e.message || e) }),
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
  _pending.set(reqId, {
    resolve: (data) => self.postMessage({ type: 'featureResult', reqId: msg.reqId, data }),
    reject: (e) => self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: String(e.message || e) }),
  });
  ws.send(frame);
}

function handleControlResponse(batch) {
  if (batch.length < 6) return;
  const respType = batch[0];
  const reqId = batch[1] | (batch[2] << 8) | (batch[3] << 16) | (batch[4] << 24);
  const status = batch[5];
  const p = _pending.get(reqId);
  if (!p) return;
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
