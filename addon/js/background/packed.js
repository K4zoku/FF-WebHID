(function () {
  const EVT_HANDSHAKE = 1;
  const EVT_CONNECT = 2;
  const EVT_DISCONNECT = 3;

  const ACT = {
    enum: 1,
    open: 2,
    close: 3,
    sr: 4,
    rfr: 5,
    sfr: 6,
    sdp: 7,
    hs: 8,
  };

  const PKG_INPUT_REPORT = 0x01;
  const PKG_SEND_REPORT = 0x02;
  const PKG_SEND_FEATURE_REPORT = 0x04;

  function buildPackedSend(msgType, reqId, deviceId, reportId, data) {
    const buf = new Uint8Array(12 + data.length);
    const dv = new DataView(buf.buffer);
    buf[0] = msgType;
    dv.setUint32(1, reqId, true);
    dv.setUint32(5, deviceId, true);
    buf[9] = reportId;
    dv.setUint16(10, data.length, true);
    buf.set(data, 12);
    return buf;
  }

  webhid.export("bgPacked", { EVT_HANDSHAKE, EVT_CONNECT, EVT_DISCONNECT, ACT, PKG_INPUT_REPORT, PKG_SEND_REPORT, PKG_SEND_FEATURE_REPORT, buildPackedSend });
})();
