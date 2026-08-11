'use strict'
/** @type {import("./types.js").Logger} */
const logger = webhid.import('logger')
const createSettingsStore = webhid.import('createSettingsStore')
const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
const createWsTransport = webhid.import('createWsTransport')
const createWtTransport = webhid.import('createWtTransport')
const {
  MSG_SEND_REPORT,
  MSG_SEND_FEATURE_REPORT,
  MSG_RECEIVE_FEATURE_REPORT,
  MSG_INPUT_BATCH,
  parseInputReports,
  handleControlResponse: handleControlResponseShared
} = webhid.import('wireFormat')
logger.initLogger('worker')
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
  const reports = parseInputReports(batch, offset)
  if (reports.length === 0) return
  const transfers = []
  for (const r of reports) {
    if (r.data) transfers.push(r.data)
  }
  if (logger.level >= 3) {
    for (const r of reports) {
      const view = r.data ? new Uint8Array(r.data) : null
      let hex = ''
      if (view) {
        for (let i = 0; i < Math.min(8, view.length); i++)
          hex += view[i].toString(16).padStart(2, '0') + ' '
      }
      logger.debug(
        'inputReport reportId=' + r.reportId + ' len=' + (view ? view.length : 0) + ' first8=' + hex
      )
    }
  }
  if (dataPort) {
    try {
      dataPort.postMessage({ type: 'inputReportBatch', reports }, transfers)
    } catch (e) {
      logger.warn('inputReportBatch postMessage failed', e)
    }
  }
  logger.debug('forwarded ' + reports.length + ' reports via data port')
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
  handleControlResponseShared(batch, pending)
}
