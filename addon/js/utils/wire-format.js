;(function () {
  const webhid = globalThis.webhid
  const pristine = webhid.import('pristine')
  const { types } = pristine
  const NativeUint8Array = types.Uint8Array.constructor
  const NativeArrayBuffer = types.ArrayBuffer.constructor
  const NativeDataView = types.DataView.constructor
  const NativeError = types.Error.constructor
  const Uint8Array = NativeUint8Array
  const ArrayBuffer = NativeArrayBuffer
  const DataView = NativeDataView
  const u8Ops = types.Uint8Array.proto.methods
  const dataViewOps = types.DataView.proto.methods
  const mapOps = types.Map.proto.methods

  const MSG_SEND_REPORT = 0x01
  const MSG_SEND_FEATURE_REPORT = 0x02
  const MSG_RECEIVE_FEATURE_REPORT = 0x03
  const RESP_RECEIVE_FEATURE_REPORT = 0x83
  const MSG_INPUT_BATCH = 0x00

  /**
   * Parses input-report frames [len u16 LE][reportId][payload]*, copying each
   * payload into a fresh ArrayBuffer so the consumer owns its buffer.
   * @param {Uint8Array} batch
   * @param {number} [offset=0]
   * @returns {Array<{reportId: number, data: ArrayBuffer|null}>}
   */
  function parseInputReports(batch, offset = 0) {
    const reports = []
    while (offset + 1 < batch.length) {
      const len = batch[offset] | (batch[offset + 1] << 8)
      offset += 2
      if (len === 0 || offset + len > batch.length) break
      const reportId = batch[offset]
      const payloadLen = len - 1
      if (payloadLen > 0) {
        const buffer = new ArrayBuffer(payloadLen)
        u8Ops.set(new Uint8Array(buffer), u8Ops.subarray(batch, offset + 1, offset + len))
        reports.push({ reportId, data: buffer })
      } else {
        reports.push({ reportId, data: null })
      }
      offset += len
    }
    return reports
  }

  /**
   * Routes one control response frame (0x81/0x82/0x83) to its pending
   * request. The daemon uses the same wire format on WS and WT.
   * @param {Uint8Array} batch
   * @param {Map<number, {resolve: Function, reject: Function}>} pending
   * @returns {void}
   */
  function handleControlResponse(batch, pending) {
    if (batch.length < 6) return
    const respType = batch[0]
    const dataView = new DataView(batch.buffer, batch.byteOffset, batch.byteLength)
    const reqId = dataViewOps.getUint32(dataView, 1, true)
    const status = batch[5]
    const entry = mapOps.get(pending, reqId)
    if (!entry) return
    mapOps.delete(pending, reqId)
    if (respType === RESP_RECEIVE_FEATURE_REPORT) {
      if (status === 2) return entry.reject({ blocked: true })
      if (status !== 0) return entry.reject(new NativeError('feature read failed'))
      if (batch.length < 8) return entry.reject(new NativeError('short feature resp'))
      const len = dataViewOps.getUint16(dataView, 6, true)
      const out = new Uint8Array(len)
      if (len > 0 && batch.length >= 8 + len)
        u8Ops.set(out, u8Ops.subarray(batch, 8, 8 + len))
      return entry.resolve(out)
    }
    if (status === 0) entry.resolve()
    else if (status === 2) entry.reject({ blocked: true })
    else entry.reject(new NativeError('write failed status=' + status))
  }

  /**
   * @param {number} msgType
   * @param {number} reqId
   * @param {number} reportId
   * @param {Uint8Array|null} [payload]
   * @returns {Uint8Array}
   */
  function buildSendFrame(msgType, reqId, reportId, payload) {
    const frame = new Uint8Array(6 + (payload ? payload.length : 0))
    frame[0] = msgType
    dataViewOps.setUint32(new DataView(frame.buffer), 1, reqId, true)
    frame[5] = reportId
    if (payload) u8Ops.set(frame, payload, 6)
    return frame
  }

  webhid.export('wireFormat', {
    MSG_SEND_REPORT,
    MSG_SEND_FEATURE_REPORT,
    MSG_RECEIVE_FEATURE_REPORT,
    MSG_INPUT_BATCH,
    parseInputReports,
    buildSendFrame,
    handleControlResponse
  })
})()
