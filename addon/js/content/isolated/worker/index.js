'use strict'
/** @type {import("./types.js").Logger} */
const logger = webhid.import('logger')
const createSettingsStore = webhid.import('createSettingsStore')
const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
const createWsTransport = webhid.import('createWsTransport')
const createWtTransport = webhid.import('createWtTransport')
logger.initLogger('worker')
const MSG_SEND_REPORT = 0x01
const MSG_SEND_FEATURE_REPORT = 0x02
const MSG_RECEIVE_FEATURE_REPORT = 0x03
const RESP_RECEIVE_FEATURE_REPORT = 0x83
const MSG_INPUT_BATCH = 0x00
/** @type {import("./types.js").SettingsStore} */
const settings = createSettingsStore(GLOBAL_DEFAULTS)
logger.bindSettings(settings)
/** @type {number} */
let nextReqId = 1
/** @type {Map<number, {resolve: Function, reject: Function}>} */
const pending = new Map()
/** @type {import("./types.js").WsTransport | import("./types.js").WtTransport | null} */
let transport = null
/** @type {MessagePort|null} */
let controlPort = null
/** @type {MessagePort|null} */
let dataPort = null
/** @type {Array<object>} */
let preOpen = []

self.onmessage = ({ data: msg }) => {
  if (msg && msg.type === 'setPorts') {
    controlPort = msg.controlPort || null
    dataPort = msg.dataPort || null
    if (dataPort) dataPort.onmessage = (event) => handleDataPortMessage(event.data)
    if (controlPort) controlPort.onmessage = (event) => handleControlMessage(event.data)
  }
}

/**
 * @param {object} msg
 * @returns {void}
 */
function handleControlMessage(msg) {
  if (!msg) return
  if (msg.type === 'connect') {
    const factory = msg.transport === 'wt' ? createWtTransport : createWsTransport
    transport = factory({
      tag: 'worker',
      onReady: () => {
        if (controlPort) controlPort.postMessage({ type: 'ready' })
        const queued = preOpen
        preOpen = []
        for (const item of queued) handleDataPortMessage(item)
      },
      onClosed: (info) => {
        if (!(info && info.willReconnect) && controlPort) {
          controlPort.postMessage({ type: 'closed' })
        }
        for (const [, entry] of pending) entry.reject(new Error('ws closed'))
        pending.clear()
        const queued = preOpen
        preOpen = []
        for (const item of queued) {
          replyData({
            type: item.type === 'receiveFeature' ? 'featureResult' : 'sendResult',
            reqId: item.reqId,
            error: 'ws closed'
          })
        }
      },
      onAuthFailed: (code) => {
        if (controlPort) controlPort.postMessage({ type: 'auth-failed', code })
      },
      onBinary: (batch) => {
        if (batch.length > 0 && batch[0] === MSG_INPUT_BATCH) return pushInputBatch(batch, 1)
        if (batch.length > 0 && batch[0] >= 0x81) return handleControlResponse(batch)
        pushInputBatch(batch, 0)
      }
    })
    transport.connect(msg)
    return
  }
  if (msg.type === 'settings') {
    settings.set(msg)
    return
  }
  if (msg.type === 'terminate') {
    if (transport && transport.close) transport.close()
    self.close()
    return
  }
  if (msg.type === 'send' || msg.type === 'sendFeature' || msg.type === 'receiveFeature') {
    return handleDataPortMessage(msg)
  }
}

/**
 * @param {object} msg
 * @returns {void}
 */
function handleDataPortMessage(msg) {
  if (!msg) return
  if (!transport || !transport.isOpen()) {
    preOpen.push(msg)
    return
  }
  if (msg.type === 'send') return handleSend(msg, MSG_SEND_REPORT)
  if (msg.type === 'sendFeature') return handleSend(msg, MSG_SEND_FEATURE_REPORT)
  if (msg.type === 'receiveFeature') return handleReceiveFeature(msg)
}

/**
 * @param {Uint8Array} batch
 * @param {number} [offset=0]
 * @returns {void}
 */
function pushInputBatch(batch, offset = 0) {
  let count = 0
  const reports = []
  const transfers = []
  while (offset + 1 < batch.length) {
    const len = batch[offset] | (batch[offset + 1] << 8)
    offset += 2
    if (len === 0 || offset + len > batch.length) break
    const reportId = batch[offset]
    const payloadLen = len - 1
    if (payloadLen > 0) {
      const buffer = new ArrayBuffer(payloadLen)
      const view = new Uint8Array(buffer)
      view.set(batch.subarray(offset + 1, offset + len))
      if (logger.level >= 3) {
        let hex = ''
        for (let i = 0; i < Math.min(8, view.length); i++)
          hex += view[i].toString(16).padStart(2, '0') + ' '
        logger.debug('inputReport reportId=' + reportId + ' len=' + payloadLen + ' first8=' + hex)
      }
      reports.push({ reportId, data: buffer })
      transfers.push(buffer)
    } else {
      reports.push({ reportId, data: null })
    }
    offset += len
    count++
  }
  if (count > 0) {
    if (dataPort) {
      try {
        dataPort.postMessage({ type: 'inputReportBatch', reports }, transfers)
      } catch (e) {
        logger.warn('inputReportBatch postMessage failed', e)
      }
    }
    logger.debug('forwarded ' + count + ' reports via data port')
  }
}

/**
 * @param {{reqId: number, data: Uint8Array, reportId: number}} msg
 * @param {number} msgType
 * @returns {void}
 */
function handleSend(msg, msgType) {
  if (!transport || !transport.isOpen()) {
    logger.warn('send: WS not open')
    replyData({
      type: msgType === MSG_SEND_REPORT ? 'sendResult' : 'featureResult',
      reqId: msg.reqId,
      error: 'ws not open'
    })
    return
  }
  const payload = msg.data
  if (!(payload instanceof Uint8Array)) {
    replyData({
      type: msgType === MSG_SEND_REPORT ? 'sendResult' : 'featureResult',
      reqId: msg.reqId,
      error: 'bad payload'
    })
    return
  }
  const reqId = nextReqId++
  const frame = new Uint8Array(6 + payload.length)
  const dataView = new DataView(frame.buffer)
  frame[0] = msgType
  dataView.setUint32(1, reqId, true)
  frame[5] = msg.reportId
  frame.set(payload, 6)
  const isFeature = msgType !== MSG_SEND_REPORT
  pending.set(reqId, {
    resolve: () =>
      replyData({
        type: isFeature ? 'featureResult' : 'sendResult',
        reqId: msg.reqId
      }),
    reject: (e) =>
      replyData({
        type: isFeature ? 'featureResult' : 'sendResult',
        reqId: msg.reqId,
        error: String(e.message || e)
      })
  })
  if (!transport.send(frame)) {
    const entry = pending.get(reqId)
    if (entry) {
      pending.delete(reqId)
      entry.reject(new Error('ws closed'))
    }
  }
}

/** @param {{reqId: number, reportId: number}} msg @returns {void} */
function handleReceiveFeature(msg) {
  if (!transport || !transport.isOpen()) {
    replyData({
      type: 'featureResult',
      reqId: msg.reqId,
      error: 'ws not open'
    })
    return
  }
  const reqId = nextReqId++
  const frame = new Uint8Array(6)
  const dataView = new DataView(frame.buffer)
  frame[0] = MSG_RECEIVE_FEATURE_REPORT
  dataView.setUint32(1, reqId, true)
  frame[5] = msg.reportId
  pending.set(reqId, {
    resolve: (data) => {
      const transfer = data instanceof Uint8Array && data.buffer ? [data.buffer] : []
      replyData({ type: 'featureResult', reqId: msg.reqId, data }, transfer)
    },
    reject: (e) =>
      replyData({
        type: 'featureResult',
        reqId: msg.reqId,
        error: String(e.message || e)
      })
  })
  if (!transport.send(frame)) {
    const entry = pending.get(reqId)
    if (entry) {
      pending.delete(reqId)
      entry.reject(new Error('ws closed'))
    }
  }
}

/**
 * @param {object} msg
 * @param {Array} [transfer]
 * @returns {void}
 */
function replyData(msg, transfer) {
  if (dataPort) dataPort.postMessage(msg, transfer || [])
}

/**
 * @param {Uint8Array} batch
 * @returns {void}
 */
function handleControlResponse(batch) {
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
