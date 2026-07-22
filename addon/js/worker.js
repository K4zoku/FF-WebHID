"use strict";
const logger = webhid.import("logger");
const createSettingsStore = webhid.import("createSettingsStore");
const GLOBAL_DEFAULTS = webhid.import("GLOBAL_DEFAULTS");
const createWsTransport = webhid.import("createWsTransport");
logger.initLogger("worker");
const MSG_SEND_REPORT = 0x01;
const MSG_SEND_FEATURE_REPORT = 0x02;
const MSG_RECEIVE_FEATURE_REPORT = 0x03;
const RESP_RECEIVE_FEATURE_REPORT = 0x83;
const settings = createSettingsStore(GLOBAL_DEFAULTS);
settings.on("logLevel", (v) => logger.applyLevel(v));
let nextReqId = 1;
const pending = new Map();
let transport = null;
let dataPort = null;

self.onmessage = ({ data: msg, ports }) => {
  if (msg.type === "connect") {
    transport = createWsTransport({
      tag: "worker",
      onReady: () => self.postMessage({ type: "ready" }),
      onClosed: () => self.postMessage({ type: "closed" }),
      onAuthFailed: (code) => self.postMessage({ type: "auth-failed", code }),
      onBinary: (batch) => {
        if (batch.length > 0 && batch[0] >= 0x81)
          return handleControlResponse(batch);
        pushInputBatch(batch);
      },
    });
    transport.connect(msg);
    return;
  }
  if (msg.type === "setPort") {
    dataPort = ports[0];
    dataPort.onmessage = (ev) => handleDataPortMessage(ev.data);
    logger.debug("data port received from bridge");
    return;
  }
  if (msg.type === "unsetPort") {
    if (dataPort) {
      const port = dataPort;
      dataPort.onmessage = null;
      dataPort = null;
      self.postMessage({ type: "returnPort" }, [port]);
    } else {
      self.postMessage({ type: "returnPort" });
    }
    return;
  }
  if (msg.type === "settings") {
    settings.set(msg);
    return;
  }
};

function handleDataPortMessage(msg) {
  if (!msg) return;
  if (msg.type === "send") return handleSend(msg, MSG_SEND_REPORT);
  if (msg.type === "sendFeature")
    return handleSend(msg, MSG_SEND_FEATURE_REPORT);
  if (msg.type === "receiveFeature") return handleReceiveFeature(msg);
}

function pushInputBatch(batch) {
  let offset = 0,
    count = 0;
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
      if (logger.level >= 3) {
        let hex = "";
        for (let i = 0; i < Math.min(8, view.length); i++)
          hex += view[i].toString(16).padStart(2, "0") + " ";
        logger.debug(
          "inputReport reportId=" +
            reportId +
            " len=" +
            payloadLen +
            " first8=" +
            hex,
        );
      }
      if (dataPort) {
        dataPort.postMessage({ type: "inputReport", reportId, data: buf }, [
          buf,
        ]);
      }
    } else {
      if (dataPort) {
        dataPort.postMessage({ type: "inputReport", reportId, data: null });
      }
    }
    offset += len;
    count++;
  }
  if (count > 0 && dataPort)
    logger.debug("forwarded " + count + " reports via data port");
}

function handleSend(msg, msgType) {
  if (!transport || !transport.isOpen()) {
    logger.warn("send: WS not open");
    replyData({
      type: msgType === MSG_SEND_REPORT ? "sendResult" : "featureResult",
      reqId: msg.reqId,
      error: "ws not open",
    });
    return;
  }
  const payload = msg.data;
  if (!(payload instanceof Uint8Array)) {
    replyData({
      type: msgType === MSG_SEND_REPORT ? "sendResult" : "featureResult",
      reqId: msg.reqId,
      error: "bad payload",
    });
    return;
  }
  const reqId = nextReqId++;
  const frame = new Uint8Array(6 + payload.length);
  const dv = new DataView(frame.buffer);
  frame[0] = msgType;
  dv.setUint32(1, reqId, true);
  frame[5] = msg.reportId;
  frame.set(payload, 6);
  const isFeature = msgType !== MSG_SEND_REPORT;
  if (settings.fireAndForget) {
    transport.send(frame);
    replyData({
      type: isFeature ? "featureResult" : "sendResult",
      reqId: msg.reqId,
    });
    return;
  }
  pending.set(reqId, {
    resolve: () =>
      replyData({
        type: isFeature ? "featureResult" : "sendResult",
        reqId: msg.reqId,
      }),
    reject: (e) =>
      replyData({
        type: isFeature ? "featureResult" : "sendResult",
        reqId: msg.reqId,
        error: String(e.message || e),
      }),
  });
  // E2: If the WS dropped between the isOpen() check above and send(),
  // reject the pending entry immediately so the caller's Promise resolves
  // instead of hanging until the worker is torn down.
  if (!transport.send(frame)) {
    const p = pending.get(reqId);
    if (p) {
      pending.delete(reqId);
      p.reject(new Error("ws closed"));
    }
  }
}

function handleReceiveFeature(msg) {
  if (!transport || !transport.isOpen()) {
    replyData({
      type: "featureResult",
      reqId: msg.reqId,
      error: "ws not open",
    });
    return;
  }
  const reqId = nextReqId++;
  const frame = new Uint8Array(6);
  const dv = new DataView(frame.buffer);
  frame[0] = MSG_RECEIVE_FEATURE_REPORT;
  dv.setUint32(1, reqId, true);
  frame[5] = msg.reportId;
  pending.set(reqId, {
    resolve: (data) => {
      const transfer =
        data instanceof Uint8Array && data.buffer ? [data.buffer] : [];
      replyData({ type: "featureResult", reqId: msg.reqId, data }, transfer);
    },
    reject: (e) =>
      replyData({
        type: "featureResult",
        reqId: msg.reqId,
        error: String(e.message || e),
      }),
  });
  // E2: Same race protection as handleSend — reject immediately if the WS
  // transport refused the frame, otherwise the feature-read Promise hangs.
  if (!transport.send(frame)) {
    const p = pending.get(reqId);
    if (p) {
      pending.delete(reqId);
      p.reject(new Error("ws closed"));
    }
  }
}

function replyData(msg, transfer) {
  if (dataPort) dataPort.postMessage(msg, transfer || []);
}

function handleControlResponse(batch) {
  if (batch.length < 6) return;
  const respType = batch[0];
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const reqId = dv.getUint32(1, true);
  const status = batch[5];
  const p = pending.get(reqId);
  if (!p) return;
  pending.delete(reqId);
  if (respType === RESP_RECEIVE_FEATURE_REPORT) {
    if (status !== 0) return p.reject(new Error("feature read failed"));
    if (batch.length < 8) return p.reject(new Error("short feature resp"));
    const len = dv.getUint16(6, true);
    const out = new Uint8Array(len);
    if (len > 0 && batch.length >= 8 + len) out.set(batch.subarray(8, 8 + len));
    return p.resolve(out);
  }
  if (status === 0) p.resolve();
  else p.reject(new Error("write failed status=" + status));
}
