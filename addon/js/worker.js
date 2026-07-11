'use strict';
const { logger } = self.__webhid;
__webhid.logger.initLogger('worker');
const MSG_SEND_REPORT = 0x01;
const MSG_SEND_FEATURE_REPORT = 0x02;
const MSG_RECEIVE_FEATURE_REPORT = 0x03;
const RESP_RECEIVE_FEATURE_REPORT = 0x83;
const settings = __webhid.createSettingsStore(self.__webhid.GLOBAL_DEFAULTS);
settings.on('logLevel', (v) => logger.applyLevel(v));
let _nextReqId = 1;
const _pending = new Map();
let _port = null;
let _transport = null;

self.onmessage = ({ data: msg, ports }) => {
  if (msg.type === 'connect') {
    _transport = __webhid.createWsTransport({
      tag: 'worker',
      onReady: () => self.postMessage({ type: 'ready' }),
      onClosed: () => self.postMessage({ type: 'closed' }),
      onAuthFailed: (code) => self.postMessage({ type: 'auth-failed', code }),
      onBinary: (batch) => {
        if (batch.length > 0 && batch[0] >= 0x80) return handleControlResponse(batch);
        pushInputBatch(batch);
      },
    });
    _transport.connect(msg);
    return;
  }
  if (msg.type === 'setPort') {
    _port = ports[0];
    logger.debug('received MessagePort for direct input reports');
    return;
  }
  if (msg.type === 'settings') {
    settings.set(msg);
    return;
  }
  if (msg.type === 'send') return handleSend(msg, MSG_SEND_REPORT);
  if (msg.type === 'sendFeature') return handleSend(msg, MSG_SEND_FEATURE_REPORT);
  if (msg.type === 'receiveFeature') return handleReceiveFeature(msg);
};

function pushInputBatch(batch) {
  let offset = 0, count = 0;
  while (offset + 1 < batch.length) {
    const len = batch[offset] | (batch[offset + 1] << 8);
    offset += 2;
    if (len === 0 || offset + len > batch.length) break;
    const reportId = batch[offset];
    const payloadLen = len - 1;
    if (payloadLen > 0) {
      const buf = new ArrayBuffer(payloadLen);
      const view = new Uint8Array(buf);
      view.set(batch.subarray(offset + 1, offset + len));
      if (logger._level >= 3) {
        let hex = '';
        for (let i = 0; i < Math.min(8, view.length); i++) hex += view[i].toString(16).padStart(2, '0') + ' ';
        logger.debug('inputReport reportId=' + reportId + ' len=' + payloadLen + ' first8=' + hex);
      }
      if (_port) {
        _port.postMessage({ type: 'inputReport', reportId, data: buf }, [buf]);
      } else {
        self.postMessage({ type: 'inputReport', reportId, data: buf }, [buf]);
      }
    } else {
      if (_port) {
        _port.postMessage({ type: 'inputReport', reportId, data: null });
      } else {
        self.postMessage({ type: 'inputReport', reportId, data: null });
      }
    }
    offset += len;
    count++;
  }
  if (count > 0) logger.debug('forwarded ' + count + ' reports via ' + (_port ? 'MessagePort' : 'postMessage'));
}

function handleSend(msg, msgType) {
  if (!_transport || !_transport.isOpen()) {
    logger.warn('send: WS not open');
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: 'ws not open' });
    return;
  }
  const payload = msg.data;
  if (!(payload instanceof Uint8Array)) {
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: 'bad payload' });
    return;
  }
  const reqId = _nextReqId++;
  const frame = new Uint8Array(6 + payload.length);
  const dv = new DataView(frame.buffer);
  frame[0] = msgType;
  dv.setUint32(1, reqId, true);
  frame[5] = msg.reportId;
  frame.set(payload, 6);
  if (settings.fireAndForget) {
    _transport.send(frame);
    self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true });
    return;
  }
  _pending.set(reqId, {
    resolve: () => self.postMessage({ type: 'sendResult', reqId: msg.reqId, success: true }),
    reject: (e) => self.postMessage({ type: 'sendResult', reqId: msg.reqId, error: String(e.message || e) }),
  });
  _transport.send(frame);
}

function handleReceiveFeature(msg) {
  if (!_transport || !_transport.isOpen()) {
    self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: 'ws not open' });
    return;
  }
  const reqId = _nextReqId++;
  const frame = new Uint8Array(6);
  const dv = new DataView(frame.buffer);
  frame[0] = MSG_RECEIVE_FEATURE_REPORT;
  dv.setUint32(1, reqId, true);
  frame[5] = msg.reportId;
  _pending.set(reqId, {
    resolve: (data) => {
      const transfer = (data instanceof Uint8Array) ? [data.buffer] : [];
      self.postMessage({ type: 'featureResult', reqId: msg.reqId, data }, transfer);
    },
    reject: (e) => self.postMessage({ type: 'featureResult', reqId: msg.reqId, error: String(e.message || e) }),
  });
  _transport.send(frame);
}

function handleControlResponse(batch) {
  if (batch.length < 6) return;
  const respType = batch[0];
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const reqId = dv.getUint32(1, true);
  const status = batch[5];
  const p = _pending.get(reqId);
  if (!p) return;
  _pending.delete(reqId);
  if (respType === RESP_RECEIVE_FEATURE_REPORT) {
    if (status !== 0) return p.reject(new Error('feature read failed'));
    if (batch.length < 8) return p.reject(new Error('short feature resp'));
    const len = dv.getUint16(6, true);
    const out = new Uint8Array(len);
    if (len > 0 && batch.length >= 8 + len) out.set(batch.subarray(8, 8 + len));
    return p.resolve(out);
  }
  if (status === 0) p.resolve();
  else p.reject(new Error('write failed status=' + status));
}
