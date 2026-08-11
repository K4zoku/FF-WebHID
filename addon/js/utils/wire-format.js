;(function () {
  const webhid = globalThis.webhid

  const MSG_SEND_REPORT = 0x01
  const MSG_SEND_FEATURE_REPORT = 0x02
  const MSG_RECEIVE_FEATURE_REPORT = 0x03
  const RESP_SEND_REPORT = 0x81
  const RESP_SEND_FEATURE_REPORT = 0x82
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
        new Uint8Array(buffer).set(batch.subarray(offset + 1, offset + len))
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
    const reqId = dataView.getUint32(1, true)
    const status = batch[5]
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    if (respType === RESP_RECEIVE_FEATURE_REPORT) {
      if (status === 2) return entry.reject({ blocked: true })
      if (status !== 0) return entry.reject(new Error('feature read failed'))
      if (batch.length < 8) return entry.reject(new Error('short feature resp'))
      const len = dataView.getUint16(6, true)
      const out = new Uint8Array(len)
      if (len > 0 && batch.length >= 8 + len) out.set(batch.subarray(8, 8 + len))
      return entry.resolve(out)
    }
    if (status === 0) entry.resolve()
    else if (status === 2) entry.reject({ blocked: true })
    else entry.reject(new Error('write failed status=' + status))
  }

  webhid.export('wireFormat', {
    MSG_SEND_REPORT,
    MSG_SEND_FEATURE_REPORT,
    MSG_RECEIVE_FEATURE_REPORT,
    RESP_SEND_REPORT,
    RESP_SEND_FEATURE_REPORT,
    RESP_RECEIVE_FEATURE_REPORT,
    MSG_INPUT_BATCH,
    parseInputReports,
    handleControlResponse
  })
})()
