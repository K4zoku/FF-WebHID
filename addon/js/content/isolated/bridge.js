;(function () {
  'use strict'

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const isChromium = webhid.import('isChromium')
  const http = webhid.import('http')
  const createSettingsStore = webhid.import('createSettingsStore')
  const loadEffectiveSettings = webhid.import('loadEffectiveSettings')
  const loadSiteSettings = webhid.import('loadSiteSettings')
  const parseSettingsKey = webhid.import('parseSettingsKey')
  const WebHidDevicePicker = webhid.import('WebHidDevicePicker')
  logger.initLogger('bridge')
  const controlPort = browser.runtime.connect({ name: 'webhid-control' })
  const controlQueue = []
  let controlPending = null
  const handshakePending = new Map()
  let nextHandshakeReqId = 0
  /** @returns {void} */
  function pumpControlQueue() {
    if (controlPending || controlQueue.length === 0) return
    controlPending = controlQueue.shift()
    try {
      controlPort.postMessage(controlPending.request)
    } catch (error) {
      controlPending.reject(error)
      controlPending = null
      pumpControlQueue()
    }
  }
  /**
   * @param {object} request
   * @returns {Promise<object>}
   */
  function sendBackgroundRequest(request) {
    return new Promise((resolve, reject) => {
      controlQueue.push({ request, resolve, reject })
      pumpControlQueue()
    })
  }
  /**
   * Sends the startup daemon handshake over the persistent control port without
   * occupying the serialized request slot used by page operations.
   * @returns {Promise<object>}
   */
  function sendHandshakeRequest() {
    return new Promise((resolve, reject) => {
      const reqId = 'handshake:' + ++nextHandshakeReqId
      handshakePending.set(reqId, { resolve, reject })
      try {
        controlPort.postMessage({ action: 'handshake', reqId })
      } catch (error) {
        handshakePending.delete(reqId)
        reject(error)
      }
    })
  }
  controlPort.onMessage.addListener((message) => {
    if (message && message.action === 'globalReset') {
      handleGlobalReset()
      return
    }
    if (message && message.action === 'allowedDevicesChanged') {
      const origin = message.origin || window.location.origin
      allowedByOrigin.set(origin, new Set(message.deviceIds || []))
      loadedOrigins.add(origin)
      flushAllowedDeviceIdsQueue(origin)
      return
    }
    if (message && message.action === 'webhidDeviceEvent' && message.event) {
      handleBackgroundEvent(message)
      return
    }
    if (message && message.reqId != null) {
      const pending = handshakePending.get(message.reqId)
      if (pending) {
        handshakePending.delete(message.reqId)
        pending.resolve(message)
        return
      }
    }
    if (controlPending) {
      const pending = controlPending
      controlPending = null
      pending.resolve(message)
      pumpControlQueue()
    }
  })
  controlPort.onDisconnect.addListener(() => {
    const error = new Error('background port disconnected')
    for (const pending of handshakePending.values()) pending.reject(error)
    handshakePending.clear()
    if (controlPending) {
      controlPending.reject(error)
      controlPending = null
    }
    for (const pending of controlQueue) pending.reject(error)
    controlQueue.length = 0
    handleGlobalReset()
  })
  const devicePicker = new WebHidDevicePicker()
  document.documentElement.appendChild(devicePicker.host)

  const PAGE_BLOCKED_ACTIONS = new Set([
    'pairDevice',
    'recordGrantGroup',
    'getGrantGroups',
    'getAllPairedDevices',
    'revokeDevice',
    'getDeviceCache',
    'getDeviceInfo',
    'showPicker',
    'pickerResult'
  ])

  const PAGE_ACTION_API_ACTIONS = new Set([
    'getPolicy',
    'getPairedDevices',
    'enumerate',
    'requestDevice',
    'open',
    'close',
    'sendReport',
    'receiveFeatureReport',
    'sendFeatureReport',
    'unpairDevice'
  ])
  let pageActionMarked = false

  /**
   * Marks the current tab as using WebHID so its page action becomes visible.
   * @returns {void}
   */
  function markPageActionUsed() {
    if (pageActionMarked || settings.hidePageAction) return
    pageActionMarked = true
    sendBackgroundRequest({ action: 'showPageAction' }).catch(() => {
      pageActionMarked = false
    })
  }

  /**
   * A trusted browser document lifetime owned by this tab bridge.
   * @typedef {object} FrameContext
   * @property {string} key
   * @property {number} generation
   * @property {MessagePort} port
   * @property {Window|null} source
   * @property {string} origin
   * @property {boolean} destroyed
   * @property {Map<string, string>} sessions
   */
  /** @type {Map<string, FrameContext>} */
  const frameContexts = new Map()
  /** @type {Map<MessagePort, FrameContext>} */
  const frameContextByPort = new Map()
  /** @type {Map<Window, FrameContext>} */
  const frameContextBySource = new Map()
  let nextFrameGeneration = 0

  /**
   * @param {MessagePort} port
   * @param {Window|null} source
   * @param {string} origin
   * @returns {FrameContext}
   */
  function createFrameContext(port, source, origin) {
    const context = {
      key: 'frame-' + ++nextFrameGeneration,
      generation: nextFrameGeneration,
      port,
      source,
      origin,
      destroyed: false,
      sessions: new Map()
    }
    frameContexts.set(context.key, context)
    frameContextByPort.set(port, context)
    if (source) frameContextBySource.set(source, context)
    return context
  }

  /**
   * @param {MessagePort} port
   * @returns {FrameContext|null}
   */
  function frameContextForPort(port) {
    return (port && frameContextByPort.get(port)) || null
  }


  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {string}
   */
  function planeKey(context, deviceId) {
    return context.key + '\u0000' + deviceId
  }

  /** @returns {Set<string>} */
  function getOpenDeviceIds() {
    const ids = new Set()
    for (const context of frameContexts.values()) {
      for (const deviceId of context.sessions.keys()) ids.add(deviceId)
    }
    return ids
  }


  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {void}
   */
  function clearFrameDevice(context, deviceId) {
    if (context) context.sessions.delete(deviceId)
  }

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getOpenDeviceIds') {
      sendResponse({ ids: Array.from(getOpenDeviceIds()) })
      return true
    }
    if (request.action === 'getFrameOrigins') {
      sendResponse({ origins: collectFrameOrigins() })
      return true
    }
    if (request.action === 'getDataPlaneStatus') {
      const planes = []
      for (const [key, transport] of deviceTransports) {
        const separator = key.indexOf('\u0000')
        const deviceId = key.slice(separator + 1)
        if (workers.has(key)) planes.push({ deviceId, plane: transport, mode: 'worker' })
      }
      for (const key of inPageDevices) {
        const separator = key.indexOf('\u0000')
        planes.push({ deviceId: key.slice(separator + 1), plane: 'wt', mode: 'inpage' })
      }
      for (const key of nmPlanes) {
        const separator = key.indexOf('\u0000')
        planes.push({ deviceId: key.slice(separator + 1), plane: 'nm', mode: null })
      }
      sendResponse({ planes, defaultPlane: settings.dataPlane })
      return true
    }
  })
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {object}
   */
  function ensureRuntimeDataPort(context, deviceId) {
    const key = planeKey(context, deviceId)
    const existing = runtimeDataPorts.get(key)
    if (existing) return existing
    const port = browser.runtime.connect({ name: `webhid-data:${deviceId}` })
    runtimeDataPorts.set(key, port)
    port.onMessage.addListener((message) => {
      if (message && message.reqId != null) {
        const pending = dataPending.get(message.reqId)
        if (!pending || pending.key !== key) return
        dataPending.delete(message.reqId)
        handleWorkerReportResponse(pending.msg, pending.port, message)
        return
      }
      if (message && message.event) handleBackgroundEvent(message)
    })
    port.onDisconnect.addListener(() => {
      if (runtimeDataPorts.get(key) !== port) return
      runtimeDataPorts.delete(key)
      for (const [reqId, pending] of dataPending) {
        if (pending.key !== key) continue
        dataPending.delete(reqId)
        handleWorkerReportResponse(pending.msg, pending.port, { s: 503 })
      }
    })
    return port
  }

  /**
   * @typedef {object} WorkerEntry
   * @property {'spawning'|'ready'|'closing'} state
   * @property {object|null} worker proxy, null while the control port has
   * not arrived yet. Never overload the map value to mean both "exists but
   * not ready" and "does not exist".
   */
  /** @type {Map<string, WorkerEntry>} */
  const workers = new Map()

  /**
   * Returns the ready worker proxy for a frame/device plane, or null while
   * the worker is still spawning (or absent).
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {object|null}
   */
  function getWorker(context, deviceId) {
    const entry = workers.get(planeKey(context, deviceId))
    return entry ? entry.worker : null
  }
  /** @type {Set<string>} */
  const workerReadyDevices = new Set()
  /** @type {Map<string, object>} */
  const connectParams = new Map()
  /** @type {Map<string, string>} */
  const deviceTransports = new Map()
  /** @type {Set<string>} */
  const nmPlanes = new Set()
  /** @type {Map<string, Set<MessagePort>>} */
  const dataPorts = new Map()
  /** @type {Map<FrameContext, Set<MessagePort>>} */
  const workerPagePorts = new Map()
  /** @type {Map<string, object>} */
  const runtimeDataPorts = new Map()
  /** @type {Map<number, {msg: object, port: MessagePort, key: string}>} */
  const dataPending = new Map()
  let dataReqSeq = 0
  /** @returns {number} */
  function allocateDataReqId() {
    do {
      dataReqSeq = dataReqSeq >= Number.MAX_SAFE_INTEGER ? 1 : dataReqSeq + 1
    } while (dataPending.has(dataReqSeq))
    return dataReqSeq
  }
  /** @type {Map<string, number>} */
  const nmOpenAttempts = new Map()
  /** @param {string} key @returns {void} */
  function retainNmOpenAttempt(key) {
    nmOpenAttempts.set(key, (nmOpenAttempts.get(key) || 0) + 1)
  }
  /** @param {string} key @returns {void} */
  function releaseNmOpenAttempt(key) {
    const remaining = (nmOpenAttempts.get(key) || 0) - 1
    if (remaining > 0) nmOpenAttempts.set(key, remaining)
    else nmOpenAttempts.delete(key)
  }
  /**
   * Disconnects a data Port created for an open that did not succeed.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {void}
   */
  function discardFailedOpenDataPort(context, deviceId) {
    const key = planeKey(context, deviceId)
    if (context.sessions.has(deviceId) || nmOpenAttempts.has(key)) return
    const port = runtimeDataPorts.get(key)
    if (!port) return
    runtimeDataPorts.delete(key)
    try {
      port.disconnect()
    } catch (e) {
      logger.debug('failed-open runtime data port cleanup failed', e)
    }
  }
  /** @type {number|null} */
  let wsPort = null
  /** @type {string|null} */
  let wsNonce = null
  /** @type {number|null} */
  let wtPort = null
  /** @type {string|null} */
  let wtCertHash = null
  /** @type {import("./types.js").SettingsStore} */
  const settings = createSettingsStore(webhid.import('GLOBAL_DEFAULTS'))
  logger.bindSettings(settings)
  settings.on('hidePageAction', (hidden) => {
    if (!hidden) pageActionMarked = false
  })
  /** @type {Map<Window, MessagePort>} */
  const pagePorts = new Map()
  /** @type {Map<MessagePort, Window>} */
  const pageSourceByPort = new Map()
  /** @type {Map<string, MessagePort>} */
  const requestPortMap = new Map()
  /** @type {Map<MessagePort, string>} */
  const portOrigin = new Map()
  /** @type {Map<string, number>} */
  const spawnGen = new Map()

  /** @type {Map<string, Set<string>>} origin -> allowed device ids. The
   * bridge serves ports from several frame origins; a single top-origin set
   * would reject delegated children and disagree with background state. */
  const allowedByOrigin = new Map()
  /** @type {Set<string>} origins whose allowed set is loaded. */
  const loadedOrigins = new Set()
  const allowedDeviceIdsQueue = []

  /**
   * Resolves all queued isDeviceAllowed promises for `origin`.
   * @param {string} origin
   * @returns {void}
   */
  function flushAllowedDeviceIdsQueue(origin) {
    const allowed = allowedByOrigin.get(origin) || new Set()
    for (let i = allowedDeviceIdsQueue.length - 1; i >= 0; i--) {
      if (allowedDeviceIdsQueue[i].origin === origin) {
        const { deviceId, resolve } = allowedDeviceIdsQueue[i]
        allowedDeviceIdsQueue.splice(i, 1)
        resolve(allowed.has(deviceId))
      }
    }
  }

  /**
   * Checks whether a device is in the allowed set for `origin`, queuing if
   * that origin's set is not yet loaded.
   * @param {string} deviceId
   * @param {string} origin
   * @returns {Promise<boolean>}
   */
  function isDeviceAllowed(deviceId, origin) {
    if (loadedOrigins.has(origin)) {
      return Promise.resolve((allowedByOrigin.get(origin) || new Set()).has(deviceId))
    }
    return new Promise((resolve) => {
      allowedDeviceIdsQueue.push({ origin, deviceId, resolve })
    })
  }

  /**
   * Loads the allowed device IDs for `origin` from the background.
   * @param {string} origin
   * @returns {Promise<void>}
   */
  async function loadAllowedDeviceIds(origin) {
    try {
      const resp = await sendBackgroundRequest({
        action: 'getAllowedDevices',
        origin
      })
      if (resp && Array.isArray(resp.deviceIds)) {
        allowedByOrigin.set(origin, new Set(resp.deviceIds))
      } else {
        allowedByOrigin.set(origin, new Set())
      }
    } catch (e) {
      logger.warn('loadAllowedDeviceIds failed for', origin, ':', e.message)
      allowedByOrigin.set(origin, new Set())
    }
    loadedOrigins.add(origin)
    flushAllowedDeviceIdsQueue(origin)
  }

  /**
   * @param {string} sessionToken
   * @returns {Promise<string|null>}
   */
  async function computeWsAuthHash(sessionToken) {
    if (!wsNonce || !sessionToken) return null
    const data = new TextEncoder().encode(sessionToken + wsNonce)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {{keepPort?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async function despawnDataPlane(context, deviceId, { keepPort = false } = {}) {
    const key = planeKey(context, deviceId)
    const gen = (spawnGen.get(key) || 0) + 1
    spawnGen.set(key, gen)
    if (inPageDevices.has(key)) {
      inPageDevices.delete(key)
      if (context.port) context.port.postMessage({ type: 'dataPlaneDisconnect', deviceId })
    }
    const entry = workers.get(key)
    if (entry && entry.worker) {
      const ports = dataPorts.get(key)
      if (ports && !keepPort) {
        dataPorts.delete(key)
        for (const port of ports) {
          try {
            port.onmessage = null
            port.close()
          } catch (e) {
            logger.debug('port cleanup failed (port path)', e)
          }
        }
      }
      entry.worker.terminate()
      workers.delete(key)
      workerReadyDevices.delete(key)
    } else if (!keepPort) {
      const ports = dataPorts.get(key)
      if (ports) {
        for (const port of ports) {
          try {
            port.onmessage = null
            port.close()
          } catch (e) {
            logger.debug('port cleanup failed (no worker)', e)
          }
        }
      }
      dataPorts.delete(key)
    }
    const runtimePort = runtimeDataPorts.get(key)
    if (runtimePort) {
      runtimeDataPorts.delete(key)
      try {
        runtimePort.disconnect()
      } catch (e) {
        logger.debug('runtime data port cleanup failed', e)
      }
    }
    for (const [reqId, pending] of dataPending) {
      if (pending.key !== key) continue
      dataPending.delete(reqId)
      handleWorkerReportResponse(pending.msg, pending.port, { s: 503 })
    }
    connectParams.delete(key)
    deviceTransports.delete(key)
    nmPlanes.delete(key)
    spawnGen.delete(key)
  }

  /**
   * Re-attaches the frame/device data plane after an auth failure using the
   * same frame-owned daemon Session token. No sibling session can be reused.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async function refreshDataPlaneToken(context, deviceId) {
    const key = planeKey(context, deviceId)
    if (workers.has(key)) return
    const token = context.sessions.get(deviceId)
    if (!token) {
      logger.warn('data plane refresh: no open session for', deviceId, '; plane stays down')
      return
    }
    logger.info('data plane refresh for', deviceId, 'using its frame session')
    if (wtPort != null && settings.dataPlane === 'wt') {
      await spawnDataPlane(context, deviceId, token, null, { wtPort, wtCertHash, rewire: true })
    } else {
      await spawnDataPlane(context, deviceId, token, wsPort, { rewire: true })
    }
  }

  let cachedSpawnMode = null

  /**
   * @returns {Promise<string>}
   */
  async function resolveSpawnMode() {
    if (cachedSpawnMode) return cachedSpawnMode
    if (isChromium) {
      cachedSpawnMode = 'blob'
      return 'blob'
    }
    const origin = window.location.origin
    let mode = settings.workerSpawnMode
    if (origin) {
      const site = await loadSiteSettings(origin)
      if (site.workerSpawnMode !== undefined) mode = site.workerSpawnMode
    }
    if (mode === 'blob') {
      cachedSpawnMode = 'blob'
      return 'blob'
    }
    try {
      const info = await sendBackgroundRequest({
        action: 'getCspInfo',
        origin: window.location.origin
      })
      if (info && info.needsBlobFallback) {
        if (mode === 'shadow') {
          cachedSpawnMode = 'nm'
          return 'nm'
        }
        const mv2 = browser.runtime.getManifest().manifest_version === 2
        if (!mv2 && info.headerShadowBlocked) {
          cachedSpawnMode = 'nm'
          return 'nm'
        }
        cachedSpawnMode = 'blob'
        return 'blob'
      }
    } catch (e) {
      logger.debug('getCspInfo failed', e)
    }
    cachedSpawnMode = 'shadow'
    return 'shadow'
  }

  /**
   * @returns {Promise<string>}
   */
  async function fetchWorkerBundle() {
    const resp = await sendBackgroundRequest({ action: 'getWorkerBundle' })
    if (!resp || !resp.text) throw new Error('worker bundle fetch failed')
    return resp.text
  }

  /** @type {Map<string, object>} */
  const pendingSpawns = new Map()
  let spawnReqSeq = 0
  /** @type {Set<string>} */
  const inPageDevices = new Set()
  /** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>, key: string}>} */
  const pendingPlaneSpawns = new Map()
  let planeReqSeq = 0

  /**
   * @param {FrameContext} context
   * @param {object} payload
   * @returns {Promise<object>}
   */
  function requestMainWorldSpawn(context, payload) {
    const port = context.port
    if (!port) return Promise.reject(new Error('no page port for worker spawn'))
    return new Promise((resolve, reject) => {
      const id = 'spawn:' + ++spawnReqSeq
      const timer = setTimeout(() => {
        pendingSpawns.delete(id)
        reject(new Error('worker spawn request timeout'))
      }, 10000)
      pendingSpawns.set(id, { resolve, reject, timer, context })
      port.postMessage({ type: 'spawnWorkerRequest', id, payload })
    })
  }

  /**
   * @param {object} port
   * @returns {object}
   */
  function makeWorkerProxy(port) {
    const proxy = {}
    let onerrorHandler = null
    proxy.postMessage = (msg, transfer) => port.postMessage(msg, transfer)
    proxy.terminate = () => port.postMessage({ type: 'terminate' })
    Object.defineProperty(proxy, 'onmessage', {
      set(fn) {
        port.onmessage = (event) => {
          if (event.data && event.data.type === 'worker-error') {
            if (onerrorHandler) onerrorHandler({ message: event.data.message })
          } else if (fn) {
            fn(event)
          }
        }
      },
      configurable: true
    })
    Object.defineProperty(proxy, 'onerror', {
      set(fn) {
        onerrorHandler = fn
      },
      configurable: true
    })
    return proxy
  }

  /**
   * Asks the page to spawn a main-world worker in the given mode.
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} mode
   * @returns {Promise<object>}
   */
  async function attemptWorkerSpawn(context, deviceId, mode) {
    if (mode === 'blob') {
      return requestMainWorldSpawn(context, {
        mode: 'blob',
        bundleText: await fetchWorkerBundle(),
        deviceId
      })
    }
    return requestMainWorldSpawn(context, { mode: 'shadow', deviceId })
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @param {number} [opts.reportSize]
   * @param {number} gen
   * @returns {Promise<boolean>}
   */
  async function spawnWorker(context, deviceId, sessionToken, wsPort, opts = {}, gen) {
    const key = planeKey(context, deviceId)
    if (workers.has(key)) return true
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash) {
      logger.warn(
        'cannot derive WS auth hash for',
        deviceId,
        '; wsNonce missing, falling back to NM'
      )
      return false
    }
    let spawnResult = null
    const spawnMode = await resolveSpawnMode()
    if (spawnMode === 'nm') {
      logger.info('page CSP blocks all worker spawn modes for', deviceId, '; using NM data plane')
      return false
    }
    try {
      spawnResult = await attemptWorkerSpawn(context, deviceId, spawnMode)
    } catch (e) {
      logger.warn('worker spawn failed for', deviceId, '(', spawnMode, '):', e.message)
    }
    if (!spawnResult || !spawnResult.ok) return false

    if (spawnGen.get(key) !== gen) {
      logger.info('worker spawn stale, discarding for', deviceId)
      requestMainWorldSpawn(context, { mode: 'terminate', deviceId }).catch(() => {})
      return false
    }
    workers.set(key, { state: 'spawning', worker: null })
    deviceTransports.set(key, opts.wtPort != null ? 'wt' : 'ws')
    connectParams.set(key, {
      transport: opts.wtPort != null ? 'wt' : 'ws',
      wsPort: opts.wtPort != null ? undefined : wsPort,
      wtPort: opts.wtPort != null ? opts.wtPort : undefined,
      wtCertHash: opts.wtPort != null ? opts.wtCertHash : undefined,
      token: wsAuthHash,
      reportSize: opts.reportSize || 64,
      logLevel: logger.level
    })
    return true
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {object} opts
   * @returns {Promise<boolean>}
   */
  async function spawnInPageDataPlane(context, deviceId, sessionToken, opts) {
    const wsAuthHash = await computeWsAuthHash(sessionToken)
    if (!wsAuthHash) return false
    const port = context.port
    if (!port) return false
    const key = planeKey(context, deviceId)
    return new Promise((resolve) => {
      const id = 'plane:' + ++planeReqSeq
      const timer = setTimeout(() => {
        pendingPlaneSpawns.delete(id)
        inPageDevices.delete(key)
        resolve(false)
      }, 10000)
      pendingPlaneSpawns.set(id, { resolve, timer, key })
      inPageDevices.add(key)
      port.postMessage({
        type: 'dataPlaneConnect',
        id,
        deviceId,
        payload: {
          transport: 'wt',
          wtPort: opts.wtPort,
          wtCertHash: opts.wtCertHash,
          token: wsAuthHash,
          reportSize: opts.reportSize || 64,
          logLevel: logger.level
        }
      })
    })
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {string} sessionToken
   * @param {number} wsPort
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  async function spawnDataPlane(context, deviceId, sessionToken, wsPort, opts = {}) {
    const key = planeKey(context, deviceId)
    const gen = (spawnGen.get(key) || 0) + 1
    spawnGen.set(key, gen)
    let ok
    if (settings.useWorker === false && opts.wtPort != null) {
      ok = await spawnInPageDataPlane(context, deviceId, sessionToken, opts)
    } else {
      ok = await spawnWorker(context, deviceId, sessionToken, wsPort, opts, gen)
      if (ok && opts.rewire) context.port.postMessage({ type: 'wireWorkerPort', deviceId })
    }
    if (!ok && spawnGen.get(key) === gen) {
      logger.warn('data plane spawn failed for', deviceId, '; falling back to NM')
      ensureRuntimeDataPort(context, deviceId)
      nmPlanes.add(key)
      deviceTransports.delete(key)
      sendBackgroundRequest({
        action: 'setDataPlane',
        deviceId,
        mode: 'nm',
        sessionToken,
        frameKey: context.key,
        origin: context.origin
      }).catch((e) => logger.debug('setDataPlane NM fallback failed', e))
    }
  }

  ;(async () => {
    try {
      const resp = await sendHandshakeRequest()
      if (http.isOk(resp.s) && resp.w) {
        wsPort = resp.w
        wsNonce = resp.N || null
        wtPort = resp.W || null
        wtCertHash = resp.H || null
        if (!wsNonce) {
          logger.warn(
            'handshake: daemon did not send ws_nonce (old version?); ' +
              'WS data plane will fall back to NM'
          )
        }
        settings.set(await loadEffectiveSettings(window.location.origin))
        loadAllowedDeviceIds(window.location.origin)
      }
    } catch (e) {
      logger.warn('handshake failed:', e.message)
    }
  })()

  /**
   * Reports iframe src URLs with allow="hid" to the background so cross-origin
   * permissions can be tracked.
   * @returns {void}
   */
  function reportIframes() {
    const iframes = document.querySelectorAll('iframe[allow*="hid" i]')
    for (const iframe of iframes) {
      const src = iframe.src || iframe.getAttribute('src') || ''
      if (!src) continue
      sendBackgroundRequest({
        action: 'setFrameAllow',
        url: src,
        frameId: -1
      })
        .catch((e) => logger.debug('setFrameAllow failed', e))
    }
  }
  if (window === window.top) {
    reportIframes()
    const observer = new MutationObserver(() => reportIframes())
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
  }

  /**
   * @param {object} msg
   * @param {ArrayBuffer[]} [transfer]
   * @returns {void}
   */
  function replyToPage(msg, transfer) {
    if (msg != null && msg.id != null) {
      const port = requestPortMap.get(msg.id)
      if (port) {
        requestPortMap.delete(msg.id)
        port.postMessage(msg, transfer)
        return
      }
    }
    if (msg != null && (msg.type === 'event' || msg.type === 'settings')) {
      for (const port of pagePorts.values()) port.postMessage(msg, transfer)
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleSpawnWorkerResponse(data) {
    const pending = pendingSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingSpawns.delete(data.id)
      pending.resolve(data.result || {})
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handlePlaneResponse(data) {
    const pending = pendingPlaneSpawns.get(data.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingPlaneSpawns.delete(data.id)
      pending.resolve(!!(data.result && data.result.ok))
    }
  }

  /**
   * @param {object} data
   * @param {MessagePort} port
   * @returns {void}
   */
  function handleDataPlaneEvent(data, port) {
    const context = frameContextForPort(port)
    if (!context) return
    const deviceId = data.deviceId
    const key = planeKey(context, deviceId)
    const ev = data.event || {}
    if (ev.type === 'closed') {
      inPageDevices.delete(key)
      handleWorkerErrorEvent({ deviceId, message: 'in-page transport closed' }, port)
    } else if (ev.type === 'auth-failed') {
      inPageDevices.delete(key)
      refreshDataPlaneToken(context, deviceId)
    }
  }

  /**
   * @param {object} data
   * @param {MessagePort} port
   * @returns {Promise<void>}
   */
  async function handleWorkerErrorEvent(data, port) {
    const context = frameContextForPort(port)
    if (!context) return
    const deviceId = data.deviceId
    const key = planeKey(context, deviceId)
    logger.warn('worker errored for', deviceId, ':', data.message)
    workers.delete(key)
    workerReadyDevices.delete(key)
    connectParams.delete(key)
    if (!context.sessions.has(deviceId)) return
    ensureRuntimeDataPort(context, deviceId)
    nmPlanes.add(key)
    deviceTransports.delete(key)
    const token = context.sessions.get(deviceId) || null
    sendBackgroundRequest({
      action: 'setDataPlane',
      deviceId,
      mode: 'nm',
      sessionToken: token,
      frameKey: context.key,
      origin: context.origin
    }).catch((e) => logger.debug('setDataPlane NM fallback failed', e))
    context.port.postMessage({ type: 'wireWorkerPort', deviceId })
  }

  /**
   * Handles a lifecycle signal authenticated by the receiving page port.
   * @param {object} data
   * @param {MessagePort} port
   * @returns {void}
   */
  function handleFrameDestroyedMessage(data, port) {
    const context = frameContextForPort(port)
    if (context) destroyFrameContext(context).catch((e) => logger.debug('frame cleanup failed', e))
  }

  /** @type {object} */
  const PAGE_PORT_HANDLERS = {
    spawnWorkerResponse: handleSpawnWorkerResponse,
    dataPlaneResponse: handlePlaneResponse,
    dataPlaneEvent: handleDataPlaneEvent,
    workerError: handleWorkerErrorEvent,
    frameDestroyed: handleFrameDestroyedMessage
  }
  /**
   * Signals that the isolated bridge can receive the MAIN bootstrap port.
   * @param {MessageEvent} event
   * @returns {void}
   */
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'webhidBridgeRequest' || !event.source) return
    event.source.postMessage({ type: 'webhidBridgeReady' }, event.origin)
  })
  window.addEventListener('message', (event) => {
    const port = event.ports != null ? event.ports[0] : undefined
    if (!port) return
    const source = event.source
    const previous = source ? frameContextBySource.get(source) : null
    if (previous) destroyFrameContext(previous).catch(() => {})
    const context = createFrameContext(port, source, event.origin)
    pagePorts.set(source, port)
    pageSourceByPort.set(port, source)
    portOrigin.set(port, event.origin)
    port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      const handler = PAGE_PORT_HANDLERS[data.type]
      if (handler) {
        handler(data, port)
        return
      }
      dispatchPortMessage(port, event, source)
    }
    logger.debug(
      '[bridge] page port established for',
      source === window ? 'window' : 'child',
      context.key
    )
  })

  /**
   * @param {object} data
   * @returns {string}
   */
  function getRequestOrigin(data) {
    const port = requestPortMap.get(data.id)
    return port ? portOrigin.get(port) : window.location.origin
  }

  /**
   * Distinct http(s) origins of every frame running the polyfill in this tab,
   * top-level first. Origins come from the engine-set `event.origin` of each
   * page port, never from page-visible state.
   * @returns {string[]}
   */
  function collectFrameOrigins() {
    const seen = new Set()
    const origins = []
    const topOrigin = window.location.origin
    if (topOrigin && (topOrigin.startsWith('http:') || topOrigin.startsWith('https:'))) {
      seen.add(topOrigin)
      origins.push(topOrigin)
    }
    for (const o of portOrigin.values()) {
      if (!o || seen.has(o)) continue
      if (!(o.startsWith('http:') || o.startsWith('https:'))) continue
      seen.add(o)
      origins.push(o)
    }
    return origins
  }

  /**
   * Dispatches one message arriving on a request port: maps its request id to
   * the port and routes it to the request handler.
   * @param {MessagePort} port
   * @param {MessageEvent} event
   * @param {Window|null} source
   * @returns {void}
   */
  function dispatchPortMessage(port, event, source) {
    const data = event.data
    if (data && data.id != null) requestPortMap.set(data.id, port)
    handleRequest(data, event.ports, source, port)
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleWorkerPortRequest(data, ports, requestPort) {
    const p = ports && ports[0]
    const context = frameContextForPort(requestPort)
    if (!p || !context) return
    frameContextByPort.set(p, context)
    let workerPorts = workerPagePorts.get(context)
    if (!workerPorts) {
      workerPorts = new Set()
      workerPagePorts.set(context, workerPorts)
    }
    workerPorts.add(p)
    portOrigin.set(p, context.origin)
    p.onmessage = (event) => dispatchPortMessage(p, event, null)
    if (typeof p.start === 'function') p.start()
    requestPort.postMessage({ type: 'response', id: data.id, result: { ok: true } })
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleDataPortRequest(data, ports, requestPort) {
    const deviceId = data.payload.deviceId
    const port = ports && ports[0]
    const context = frameContextForPort(requestPort)
    if (!deviceId || !port || !context) {
      logger.warn('data-port: missing deviceId, port, or frame')
      return
    }
    const allowed = await isDeviceAllowed(deviceId, context.origin)
    if (!allowed) {
      logger.warn('data-port: not authorized for device', deviceId)
      try {
        port.close()
      } catch (e) {
        logger.debug('unauthorized port close failed', e)
      }
      return
    }
    const key = planeKey(context, deviceId)
    if (workers.has(key)) {
      const proxy = makeWorkerProxy(port)
      workers.set(key, { state: 'ready', worker: proxy })
      proxy.onmessage = (event) => {
        const data = event.data
        if (!data || !data.type) return
        if (data.type === 'ready') {
          logger.info('worker ready for', deviceId)
          workerReadyDevices.add(key)
          proxy.postMessage({
            type: 'settings',
            dataPlane: settings.dataPlane,
            logLevel: settings.logLevel
          })
          return
        }
        if (data.type === 'auth-failed') {
          logger.warn('worker auth-failed for', deviceId, 'code=' + data.code + '; re-opening')
          if (getWorker(context, deviceId) === proxy) {
            workers.delete(key)
            workerReadyDevices.delete(key)
            refreshDataPlaneToken(context, deviceId)
          }
          return
        }
        if (data.type === 'closed') {
          logger.warn('worker closed for', deviceId)
          if (getWorker(context, deviceId) === proxy) {
            workers.delete(key)
            workerReadyDevices.delete(key)
            handleWorkerErrorEvent({ deviceId, message: 'transport closed' }, requestPort)
          }
        }
      }
      const params = connectParams.get(key)
      if (params) {
        connectParams.delete(key)
        proxy.postMessage(Object.assign({ type: 'connect' }, params))
      }
      logger.debug('worker control port received for device', deviceId, context.key)
      return
    }
    let devicePorts = dataPorts.get(key)
    if (!devicePorts) {
      devicePorts = new Set()
      dataPorts.set(key, devicePorts)
    }
    devicePorts.add(port)
    logger.debug('data port received for device', deviceId, context.key)
    port.onmessage = (event) => onDataPortMessage(context, deviceId, event.data, port)
  }
  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetCspInfoRequest(data) {
    try {
      const resp = await sendBackgroundRequest({ action: 'getCspInfo' })
      replyToPage({ type: 'response', id: data.id, result: resp || {} })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetPolicyRequest(data) {
    try {
      const payload = data.payload || {}
      const isCrossOrigin = payload.isCrossOrigin ? true : false
      const url = getRequestOrigin(data) || location.href
      let hasAllowAttr = false
      if (window === window.top) {
        const port = requestPortMap.get(data.id)
        const source = port ? pageSourceByPort.get(port) : null
        if (source) {
          for (const iframe of document.querySelectorAll('iframe[allow*="hid" i]')) {
            if (iframe.contentWindow !== source) continue
            try {
              hasAllowAttr = new URL(iframe.src).origin === new URL(url).origin
            } catch {
              hasAllowAttr = false
            }
            break
          }
        }
      }
      const resp = await sendBackgroundRequest({
        action: 'getPolicy',
        isCrossOrigin,
        url,
        hasAllowAttr
      })
      const result = resp ? resp.policy || { hid: 'allowed' } : { hid: 'allowed' }
      replyToPage({ type: 'response', id: data.id, result })
    } catch (e) {
      replyToPage({
        type: 'response',
        id: data.id,
        result: { hid: 'allowed', _err: String(e) }
      })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleGetSettingsRequest(data) {
    try {
      const global = await loadEffectiveSettings(window.location.origin)
      settings.set(global)
      replyToPage({ type: 'response', id: data.id, result: global })
    } catch {
      replyToPage({ type: 'response', id: data.id, result: {} })
    }
  }

  /**
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function handleRequestDeviceRequest(data) {
    const payload = data.payload || {}
    const filters = payload.filters || []
    const exclusionFilters = payload.exclusionFilters || []
    const pickerMode =
      isChromium && settings.devicePickerMode === 'pageAction' ? 'modal' : settings.devicePickerMode

    if (pickerMode === 'pageAction' || pickerMode === 'window') {
      sendBackgroundRequest({
        action: 'showPicker',
        requestId: data.id,
        filters,
        exclusionFilters,
        origin: getRequestOrigin(data),
        mode: pickerMode
      })
        .catch((e) => logger.debug('showPicker send failed', e))
      const pickerTimeout = setTimeout(() => {
        browser.runtime.onMessage.removeListener(onPickerResult)
        sendBackgroundRequest({
          action: 'cancelPicker',
          requestId: data.id
        }).catch((e) => logger.debug('cancelPicker send failed', e))
        replyToPage({
          type: 'response',
          id: data.id,
          result: { cancelled: true }
        })
      }, 30000)
      const onPickerResult = async (msg) => {
        if (msg.action !== 'pickerResult' || msg.requestId !== data.id) return
        clearTimeout(pickerTimeout)
        browser.runtime.onMessage.removeListener(onPickerResult)
        if (msg.selected && msg.devices) {
          await grantSelectedDevices(getRequestOrigin(data), msg.devices)
          replyToPage({
            type: 'response',
            id: data.id,
            result: { devices: msg.devices }
          })
        } else {
          replyToPage({
            type: 'response',
            id: data.id,
            result: { cancelled: true }
          })
        }
      }
      browser.runtime.onMessage.addListener(onPickerResult)
      return
    }

    const result = await devicePicker.show(filters, exclusionFilters)
    if (result.devices && result.devices.length) {
      await grantSelectedDevices(getRequestOrigin(data), result.devices)
    }
    replyToPage({
      type: 'response',
      id: data.id,
      result: result.devices.length ? { devices: result.devices } : { cancelled: true }
    })
  }

  /**
   * Runs the post-open data-plane spawn for a device.
   * @param {object} response
   * @param {FrameContext} context
   * @returns {Promise<boolean>}
   */
  async function handleOpenSuccess(response, context) {
    const deviceId = response.i
    if (!context || context.destroyed || !frameContexts.has(context.key)) return false
    const key = planeKey(context, deviceId)
    context.sessions.set(deviceId, response.t)
    sendBackgroundRequest({
      action: 'deviceCountChanged',
      count: getOpenDeviceIds().size
    })
      .catch((e) => logger.debug('deviceCountChanged (open) failed', e))
    logger.debug('open ok deviceId=' + deviceId + ' wsPort=' + response.w)

    const dataPlane = settings.dataPlane
    if (dataPlane === 'nm' || nmPlanes.has(key)) {
      nmPlanes.add(key)
      ensureRuntimeDataPort(context, deviceId)
    } else if (dataPlane === 'ws') {
      await spawnDataPlane(context, deviceId, response.t, response.w || wsPort)
    } else if (dataPlane === 'wt') {
      if (wtPort != null) {
        await spawnDataPlane(context, deviceId, response.t, null, { wtPort, wtCertHash })
      } else {
        await spawnDataPlane(context, deviceId, response.t, response.w || wsPort)
      }
    }
    return true
  }

  /**
   * Tears down the data plane after a device close.
   * @param {object} payload
   * @param {FrameContext} context
   * @returns {void}
   */
  function handleCloseSuccess(payload, context) {
    const deviceId = payload.deviceId
    logger.debug('close deviceId=' + deviceId)
    clearFrameDevice(context, deviceId)
    sendBackgroundRequest({
      action: 'deviceCountChanged',
      count: getOpenDeviceIds().size
    })
      .catch((e) => logger.debug('deviceCountChanged (close) failed', e))
    despawnDataPlane(context, deviceId)
  }

  /**
   *
   * @param {string} origin
   * @param {Array<{deviceId: number}>} devices
   */
  async function grantSelectedDevices(origin, devices) {
    await Promise.all(
      devices.map((device) =>
        sendBackgroundRequest({
          action: 'pairDevice',
          origin,
          device: { deviceId: device.deviceId }
        })
          .catch(() => {})
      )
    )
    if (devices.length > 1) {
      sendBackgroundRequest({
        action: 'recordGrantGroup',
        origin,
        deviceIds: devices.map((device) => device.deviceId)
      })
        .catch(() => {})
    }
  }

  /**
   * Routes open/close and other pass-through device actions to the background.
   * @param {object} data
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleGenericRequest(data, requestPort) {
    const { id, action, payload } = data
    const context = frameContextForPort(requestPort)
    const origin = context ? context.origin : getRequestOrigin(data)
    let nmOpenAttempt = false
    try {
      if (PAGE_BLOCKED_ACTIONS.has(action)) {
        replyToPage({ type: 'response', id, result: { s: 403 } })
        return
      }
      if ((action === 'open' || action === 'close') && !context) {
        replyToPage({ type: 'response', id, result: { s: 403 } })
        return
      }
      let response
      const deviceId = payload && payload.deviceId
      const key = context && deviceId ? planeKey(context, deviceId) : null
      if (action === 'open') {
        const allowed = await isDeviceAllowed(deviceId, origin)
        if (!allowed) {
          replyToPage({ type: 'response', id, result: { s: 403 } })
          return
        }
        if (context.destroyed || !frameContexts.has(context.key)) {
          replyToPage({ type: 'response', id, result: { s: 503 } })
          return
        }
        if (settings.dataPlane === 'nm' || nmPlanes.has(key)) {
          ensureRuntimeDataPort(context, deviceId)
          retainNmOpenAttempt(key)
          nmOpenAttempt = true
        }
      }
      const effectiveAction = action === 'enumerate' ? 'enumeratePaired' : action
      const msg = Object.assign(
        { action: effectiveAction, origin, frameKey: context ? context.key : undefined },
        payload || {}
      )
      let reservedToken = null
      if (action === 'close') {
        reservedToken = context.sessions.get(deviceId) || null
        if (reservedToken) msg.T = reservedToken
      }
      response = await sendBackgroundRequest(msg)

      if (action === 'open' && http.isOk(response.s) && response.t) {
        const accepted = await handleOpenSuccess(response, context)
        if (!accepted) {
          sendBackgroundRequest({
            action: 'cleanupSession',
            deviceId: response.i,
            sessionToken: response.t
          }).catch((e) => logger.debug('late-open cleanup failed', e))
          response = { s: 503 }
        }
        if (nmOpenAttempt) {
          releaseNmOpenAttempt(key)
          nmOpenAttempt = false
        }
      } else if (action === 'open') {
        if (nmOpenAttempt) {
          releaseNmOpenAttempt(key)
          nmOpenAttempt = false
        }
        discardFailedOpenDataPort(context, deviceId)
      }

      if (action === 'close') {
        if (http.isOk(response.s)) {
          handleCloseSuccess(payload, context)
        } else if (reservedToken) {
          context.sessions.set(deviceId, reservedToken)
        }
      }

      const transfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : []
      replyToPage(
        { type: 'response', id, result: response },
        transfers.length ? transfers : undefined
      )
    } catch {
      if (action === 'open' && nmOpenAttempt) {
        releaseNmOpenAttempt(planeKey(context, payload.deviceId))
        discardFailedOpenDataPort(context, payload.deviceId)
      }
      replyToPage({ type: 'response', id, result: { s: 500 } })
    }
  }

  /** @type {object} */
  const REQUEST_HANDLERS = {
    workerPort: handleWorkerPortRequest,
    dataPort: handleDataPortRequest,
    getCspInfo: handleGetCspInfoRequest,
    getPolicy: handleGetPolicyRequest,
    getSettings: handleGetSettingsRequest,
    requestDevice: handleRequestDeviceRequest
  }

  /**
   * @param {object} data
   * @param {MessagePort[]} ports
   * @param {Window|null} _source
   * @param {MessagePort} requestPort
   * @returns {Promise<void>}
   */
  async function handleRequest(data, ports, _source, requestPort) {
    if (!data || data.id === undefined) return

    logger.debug('req action=' + data.action + ' id=' + data.id)
    if (PAGE_ACTION_API_ACTIONS.has(data.action)) markPageActionUsed()

    const handler = REQUEST_HANDLERS[data.action]
    if (handler) {
      await handler(data, ports, requestPort)
      return
    }
    await handleGenericRequest(data, requestPort)
  }

  /**
   * @param {FrameContext} context
   * @param {{close?: boolean, notify?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async function destroyFrameContext(context, { close = true, notify = false } = {}) {
    if (!context || context.destroyed || !frameContexts.has(context.key)) return
    context.destroyed = true
    const sessions = [...context.sessions.entries()]
    const planePrefix = context.key + '\u0000'
    const planeDeviceIds = new Set(sessions.map(([deviceId]) => deviceId))
    const planeKeys = [
      workers.keys(),
      workerReadyDevices,
      connectParams.keys(),
      deviceTransports.keys(),
      nmPlanes,
      dataPorts.keys(),
      runtimeDataPorts.keys(),
      spawnGen.keys()
    ]
    for (const keys of planeKeys) {
      for (const key of keys) {
        if (typeof key === 'string' && key.startsWith(planePrefix)) {
          planeDeviceIds.add(key.slice(planePrefix.length))
        }
      }
    }
    for (const pending of pendingPlaneSpawns.values()) {
      if (pending.key.startsWith(planePrefix)) {
        planeDeviceIds.add(pending.key.slice(planePrefix.length))
      }
    }
    frameContexts.delete(context.key)
    frameContextByPort.delete(context.port)
    if (frameContextBySource.get(context.source) === context) {
      frameContextBySource.delete(context.source)
      pagePorts.delete(context.source)
    }
    pageSourceByPort.delete(context.port)
    portOrigin.delete(context.port)
    const workerPorts = workerPagePorts.get(context)
    if (workerPorts) {
      for (const port of workerPorts) {
        frameContextByPort.delete(port)
        portOrigin.delete(port)
        try {
          port.onmessage = null
          port.close()
        } catch (e) {
          logger.debug('worker page port cleanup failed', e)
        }
      }
      workerPagePorts.delete(context)
    }
    if (close) {
      await sendBackgroundRequest({ action: 'frameDestroyed', frameKey: context.key }).catch((e) =>
        logger.debug('frame session cleanup request failed', e)
      )
    }
    for (const deviceId of planeDeviceIds) {
      const hadSession = context.sessions.has(deviceId)
      await despawnDataPlane(context, deviceId)
      if (notify && hadSession) {
        try {
          context.port.postMessage({
            type: 'event',
            event: { eventType: 'disconnect', deviceId }
          })
        } catch (e) {
          logger.debug('frame reset notification failed', e)
        }
      }
    }
    context.sessions.clear()
  }

  /** @returns {void} */
  function handleGlobalReset() {
    logger.warn('global reset: clearing bridge frame state')
    const contexts = [...frameContexts.values()]
    for (const context of contexts) destroyFrameContext(context, { close: false, notify: true })
    sendBackgroundRequest({ action: 'deviceCountChanged', count: 0 })
      .catch((e) => logger.debug('deviceCountChanged (reset) failed', e))
  }

  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {object} messageEvent
   * @returns {Promise<void>}
   */
  async function reconcileFrameDevice(context, deviceId, messageEvent) {
    if (!context.sessions.has(deviceId)) return
    clearFrameDevice(context, deviceId)
    await despawnDataPlane(context, deviceId)
    try {
      context.port.postMessage({ type: 'event', event: messageEvent })
    } catch (e) {
      logger.debug('frame device reconciliation failed', e)
    }
  }
  /**
   * Forwards an NM input report to every frame that owns the device.
   * @param {object} messageEvent
   * @returns {boolean} true when a port handled the report
   */
  function forwardInputReportToPage(messageEvent) {
    let handled = false
    for (const context of frameContexts.values()) {
      const key = planeKey(context, messageEvent.deviceId)
      if (workers.has(key) || inPageDevices.has(key) || !nmPlanes.has(key)) continue
      const post = (port) => {
        try {
          const data = messageEvent.data
          const copy =
            data != null && ArrayBuffer.isView(data) ? new Uint8Array(data) : data
          port.postMessage({
            type: 'event',
            event: { ...messageEvent, data: copy }
          })
          handled = true
        } catch (e) {
          logger.debug('forward inputReport to NM frame failed', e)
        }
      }
      post(context.port)
      for (const port of workerPagePorts.get(context) || []) post(port)
    }
    return handled
  }


  /**
   * @param {object} message
   * @returns {void}
   */
  function handleBackgroundEvent(message) {
    const messageEvent = message.event
    if (messageEvent.eventType === 'input_report') {
      forwardInputReportToPage(messageEvent)
      return
    }
    if (messageEvent.eventType === 'disconnect') {
      const contexts = [...frameContexts.values()]
      for (const context of contexts) {
        reconcileFrameDevice(context, messageEvent.deviceId, messageEvent).catch((e) =>
          logger.debug('disconnect reconciliation failed', e)
        )
      }
    } else if (messageEvent.eventType === 'revoked') {
      const contexts = [...frameContexts.values()].filter(
        (context) => context.origin === messageEvent.origin
      )
      for (const context of contexts) {
        reconcileFrameDevice(context, messageEvent.deviceId, messageEvent).catch((e) =>
          logger.debug('revoke reconciliation failed', e)
        )
      }
    } else {
      replyToPage({ type: 'event', event: messageEvent })
    }
    if (
      devicePicker &&
      devicePicker.isOpen &&
      (messageEvent.eventType === 'connect' || messageEvent.eventType === 'disconnect')
    ) {
      devicePicker.refreshDevices()
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'globalReset') {
      handleGlobalReset()
      return
    }
    if (message.action === 'webhidDeviceEvent' && message.event) {
      handleBackgroundEvent(message)
    }
  })

  /**
   * Sends the report result back over the device's data port.
   * @param {object} msg
   * @param {MessagePort|null} port
   * @param {object|null} response
   * @returns {void}
   */
  function handleWorkerReportResponse(msg, port, response) {
    if (!port) return
    const status = response ? response.s : 500
    if (msg.type === 'receiveFeature') {
      if (status === 403) {
        try {
          port.postMessage({
            type: 'featureResult',
            reqId: msg.reqId,
            error: 'blocked'
          })
        } catch (e) {
          logger.debug('postMessage featureResult blocked failed', e)
        }
        return
      }
      const data = http.isOk(status) && response.d ? response.d : null
      try {
        port.postMessage({
          type: 'featureResult',
          reqId: msg.reqId,
          data: data || null
        })
      } catch (e) {
        logger.debug('postMessage featureResult data failed', e)
      }
      return
    }
    let error = null
    if (status === 403) error = 'blocked'
    else if (!http.isOk(status)) error = 'send failed'
    try {
      port.postMessage({
        type: msg.type === 'send' ? 'sendResult' : 'featureResult',
        reqId: msg.reqId,
        error
      })
    } catch (e) {
      logger.debug('postMessage sendResult failed', e)
    }
  }
  /**
   * @param {FrameContext} context
   * @param {string} deviceId
   * @param {object} msg
   * @param {MessagePort} port
   * @returns {void}
   */
  function onDataPortMessage(context, deviceId, msg, port) {
    if (!msg) return
    if (msg.type === 'send' || msg.type === 'sendFeature' || msg.type === 'receiveFeature') {
      const action =
        msg.type === 'send'
          ? 'sendReport'
          : msg.type === 'sendFeature'
            ? 'sendFeatureReport'
            : 'receiveFeatureReport'
      markPageActionUsed()
      const payload = { deviceId, reportId: msg.reportId }
      if (msg.type === 'send' || msg.type === 'sendFeature') payload.data = msg.data
      const reqId = allocateDataReqId()
      const request = Object.assign({ action, reqId }, payload)
      const dataPort = ensureRuntimeDataPort(context, deviceId)
      const key = planeKey(context, deviceId)
      dataPending.set(reqId, { msg, port, key })
      try {
        dataPort.postMessage(request)
      } catch {
        dataPending.delete(reqId)
        handleWorkerReportResponse(msg, port, { s: 500 })
      }
    }
  }

  /**
   * Respawns every active frame/device plane for the requested mode.
   * @param {string} dp
   * @returns {void}
   */
  function respawnPlanesForMode(dp) {
    if (dp !== 'ws' && dp !== 'wt') return
    for (const context of frameContexts.values()) {
      for (const [deviceId, token] of context.sessions) {
        if (dp === 'wt' && wtPort != null) {
          spawnDataPlane(context, deviceId, token, null, {
            wtPort,
            wtCertHash,
            rewire: true
          })
        } else {
          spawnDataPlane(context, deviceId, token, wsPort, { rewire: true })
        }
      }
    }
  }

  /**
   * @param {string} dp
   * @returns {Promise<void>}
   */
  async function applyDataPlane(dp) {
    const active = []
    for (const context of frameContexts.values()) {
      for (const [deviceId, token] of context.sessions) active.push({ context, deviceId, token })
    }
    for (const { context, deviceId } of active) {
      await despawnDataPlane(context, deviceId, { keepPort: true })
    }
    if (dp === 'nm') {
      for (const { context, deviceId } of active) {
        const key = planeKey(context, deviceId)
        ensureRuntimeDataPort(context, deviceId)
        nmPlanes.add(key)
      }
    }
    respawnPlanesForMode(dp)
    for (const { context, deviceId, token } of active) {
      sendBackgroundRequest({
        action: 'setDataPlane',
        deviceId,
        mode: dp,
        sessionToken: token,
        frameKey: context.key,
        origin: context.origin
      }).catch((e) => logger.debug('applyDataPlane failed for device', deviceId, e))
    }
    logger.info('data plane changed:', dp, 'open devices:', active.length)
  }

  settings.on('dataPlane', (dp) => applyDataPlane(dp))

  settings.on('workerSpawnMode', () => {
    cachedSpawnMode = null
    applyDataPlane(settings.dataPlane)
  })

  settings.on('useWorker', () => applyDataPlane(settings.dataPlane))

  settings.on(['dataPlane', 'logLevel'], () => {
    const all = settings.getAll()
    const patch = {}
    for (const k of ['dataPlane', 'logLevel']) {
      patch[k] = all[k]
    }
    replyToPage({ type: 'settings', settings: patch })
    const workerMsg = { type: 'settings', ...patch }
    for (const entry of workers.values()) {
      if (entry.worker) entry.worker.postMessage(workerMsg)
    }
  })

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const origin = window.location.origin
    const patch = {}
    for (const [key, change] of Object.entries(changes)) {
      const parsed = parseSettingsKey(key)
      if (!parsed) continue
      if (parsed.scope === 'global') {
        patch[parsed.name] = change.newValue
      } else if (parsed.scope === 'site' && parsed.origin === origin) {
        patch[parsed.name] = change.newValue
      }
    }
    if (Object.keys(patch).length === 0) return
    settings.set(patch)
  })

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'allowedDevicesChanged' && Array.isArray(message.deviceIds)) {
      const origin = message.origin || window.location.origin
      allowedByOrigin.set(origin, new Set(message.deviceIds))
      loadedOrigins.add(origin)
      flushAllowedDeviceIdsQueue(origin)
    }
  })
})()
