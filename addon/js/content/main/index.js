(function () {
  const isWorker = typeof window === 'undefined' || !(window instanceof Window)
  if (!isWorker && !window.isSecureContext) {
    console.debug('NO POLYFILL')
    return
  }

  /** @type {import("./types.js").Logger} */
  const webhid = globalThis.webhid

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const http = webhid.import('http')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const createSettingsStore = webhid.import('createSettingsStore')
  const isValidFilter = webhid.import('isValidFilter')
  const createWtTransport = webhid.import('createWtTransport')
  delete globalThis.webhid

  logger.initLogger('polyfill')

  /** @type {Function|null} */
  let ttFactory = null
  /** @type {object|null} */
  let hidInstance = null

  /** @type {Map<string, object>} */
  const inPagePlanes = new Map()

  const MSG_SEND_REPORT = 0x01
  const MSG_SEND_FEATURE_REPORT = 0x02
  const MSG_RECEIVE_FEATURE_REPORT = 0x03
  const RESP_RECEIVE_FEATURE_REPORT = 0x83
  /** @type {Map<number, {deviceId: string, resolve: Function, reject: Function}>} */
  const inPagePending = new Map()

  /**
   * @param {object} req
   * @returns {void}
   */
  function handleDataPlaneConnect(req) {
    const deviceId = req.deviceId
    const wt = createWtTransport({
      tag: 'page',
      onReady: () => {
        bridgePort.postMessage({ type: 'dataPlaneResponse', id: req.id, result: { ok: true } })
      },
      onClosed: () => {
        inPagePlanes.delete(deviceId)
        rejectInPagePending(deviceId, new Error('data plane closed'))
        bridgePort.postMessage({ type: 'dataPlaneEvent', deviceId, event: { type: 'closed' } })
      },
      onAuthFailed: (code) => {
        inPagePlanes.delete(deviceId)
        rejectInPagePending(deviceId, new Error('auth failed'))
        bridgePort.postMessage({
          type: 'dataPlaneEvent',
          deviceId,
          event: { type: 'auth-failed', code },
        })
      },
      onBinary: (batch) => {
        if (batch.length > 0 && batch[0] >= 0x81) return handleInPageControlResponse(batch)
        const offset = batch.length > 0 && batch[0] === 0x00 ? 1 : 0
        pushInPageBatch(deviceId, batch, offset)
      },
    })
    inPagePlanes.set(deviceId, { wt, deviceId })
    wt.connect(req.payload || {})
  }

  /**
   * @param {string} deviceId
   * @param {Uint8Array} batch
   * @param {number} offset
   * @returns {void}
   */
  function pushInPageBatch(deviceId, batch, offset) {
    while (offset + 1 < batch.length) {
      const len = batch[offset] | (batch[offset + 1] << 8)
      offset += 2
      if (len === 0 || offset + len > batch.length) break
      const reportId = batch[offset]
      const payloadLen = len - 1
      if (payloadLen > 0) {
        const buffer = new ArrayBuffer(payloadLen)
        new Uint8Array(buffer).set(batch.subarray(offset + 1, offset + len))
        dispatchDeviceEvent({ eventType: 'input_report', deviceId, reportId, data: buffer })
      } else {
        dispatchDeviceEvent({ eventType: 'input_report', deviceId, reportId, data: null })
      }
      offset += len
    }
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleDataPlaneDisconnect(data) {
    const plane = inPagePlanes.get(data.deviceId)
    if (plane) {
      if (plane.wt) plane.wt.disconnect()
      inPagePlanes.delete(data.deviceId)
    }
    rejectInPagePending(data.deviceId, new Error('data plane closed'))
  }

  /**
   * Rejects every in-flight in-page plane request for a device.
   * @param {string} deviceId
   * @param {Error} error
   * @returns {void}
   */
  function rejectInPagePending(deviceId, error) {
    for (const [reqId, entry] of inPagePending) {
      if (entry.deviceId === deviceId) {
        inPagePending.delete(reqId)
        entry.reject(error)
      }
    }
  }

  /**
   * Routes a control response frame (0x81/0x82/0x83) from the in-page WT
   * stream to its pending request. Mirrors the data worker's
   * handleControlResponse; the daemon uses the same wire format on WS and WT.
   * @param {Uint8Array} batch
   * @returns {void}
   */
  function handleInPageControlResponse(batch) {
    if (batch.length < 6) return
    const respType = batch[0]
    const dataView = new DataView(batch.buffer, batch.byteOffset, batch.byteLength)
    const reqId = dataView.getUint32(1, true)
    const status = batch[5]
    const entry = inPagePending.get(reqId)
    if (!entry) return
    inPagePending.delete(reqId)
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

  /**
   * Sends a request frame over an in-page plane and resolves on the daemon
   * ack. Returns null when the plane is not usable, so the caller falls back
   * to the data port (NM) path.
   * @param {object} plane
   * @param {number} msgType
   * @param {number} reportId
   * @param {Uint8Array|null} payload
   * @param {(data?: Uint8Array) => unknown} mapResolve
   * @returns {Promise<unknown>|null}
   */
  function inPageRequest(plane, msgType, reportId, payload, mapResolve) {
    if (!plane || !plane.wt || !plane.wt.isOpen()) return null
    const reqId = ++nextReqId
    const frame = new Uint8Array(6 + (payload ? payload.length : 0))
    frame[0] = msgType
    new DataView(frame.buffer).setUint32(1, reqId, true)
    frame[5] = reportId
    if (payload) frame.set(payload, 6)
    return new Promise((resolve, reject) => {
      inPagePending.set(reqId, {
        deviceId: plane.deviceId,
        resolve: (data) => resolve(mapResolve(data)),
        reject: (e) => {
          if (e && e.blocked) {
            reject(new DOMException('Report is blocked', 'NotAllowedError'))
          } else {
            reject(new DOMException((e && e.message) || e || 'request failed', 'NetworkError'))
          }
        },
      })
      if (!plane.wt.send(frame)) {
        inPagePending.delete(reqId)
        reject(new DOMException('wt not open', 'NetworkError'))
      }
    })
  }

  /** @type {Map<string, Worker>} */
  const mainWorldWorkers = new Map()

  /**
   * @param {object} req
   * @returns {Promise<{result: object, transfer: object|null}>}
   */
  async function handleSpawnWorkerRequest(req) {
    const payload = req.payload || {}
    if (payload.mode === 'terminate') {
      const existing = mainWorldWorkers.get(payload.deviceId)
      if (existing) existing.terminate()
      if (mainWorldWorkers.get(payload.deviceId) === existing) {
        mainWorldWorkers.delete(payload.deviceId)
      }
      return { result: { ok: true }, transfer: null }
    }
    const makeUrl = ttFactory || ((s) => s)
    let worker
    try {
      if (payload.mode === 'blob') {
        const blobUrl = URL.createObjectURL(
          new Blob([payload.bundleText || ''], { type: 'application/javascript' })
        )
        worker = new NativeWorker(makeUrl(blobUrl))
      } else {
        worker = new NativeWorker(makeUrl(location.href))
      }
    } catch (e) {
      return { result: { ok: false, error: String(e && e.message) }, transfer: null }
    }
    const previous = mainWorldWorkers.get(payload.deviceId)
    if (previous && previous !== worker) previous.terminate()
    mainWorldWorkers.set(payload.deviceId, worker)
    worker.onclose = () => {
      if (mainWorldWorkers.get(payload.deviceId) === worker) {
        mainWorldWorkers.delete(payload.deviceId)
      }
    }
    worker.onerror = (event) => {
      logger.debug('worker error:', event && event.message)
      if (mainWorldWorkers.get(payload.deviceId) === worker) {
        mainWorldWorkers.delete(payload.deviceId)
      }
      if (bridgePort) {
        bridgePort.postMessage({
          type: 'workerError',
          deviceId: payload.deviceId,
          message: (event && event.message) || 'unknown',
        })
      }
    }
    return { result: { ok: true }, transfer: null }
  }

  /**
   * Wires the data and control channels for an open device to its (possibly
   * freshly spawned) worker. Called both from the polyfill's open() and from
   * the bridge's wireWorkerPort message, which the bridge sends after spawning
   * a replacement worker on a data-plane switch (the device is already open,
   * so open() will not run again). Closes a stale data port before replacing it.
   * @param {object} state
   * @returns {void}
   */
  function wireDevicePort(state) {
    if (state.dataPort) {
      try {
        state.dataPort.onmessage = null
        state.dataPort.close()
      } catch (e) {
        logger.debug('close stale dataPort failed', e)
      }
    }
    const dataChannel = new MessageChannel()
    state.dataPort = dataChannel.port1
    state.dataPort.onmessage = (event) => onDataPortMessage(state, event.data)
    const worker = mainWorldWorkers.get(state.deviceId)
    if (worker) {
      const controlChannel = new MessageChannel()
      worker.postMessage(
        { type: 'setPorts', controlPort: controlChannel.port2, dataPort: dataChannel.port2 },
        [controlChannel.port2, dataChannel.port2]
      )
      bridgePort.postMessage(
        { id: 0, action: 'dataPort', payload: { deviceId: state.deviceId } },
        [controlChannel.port1]
      )
    } else {
      bridgePort.postMessage(
        { id: 0, action: 'dataPort', payload: { deviceId: state.deviceId } },
        [dataChannel.port2]
      )
    }
  }

  /**
   * @param {{deviceId?: string}} data
   * @returns {void}
   */
  function handleWireWorkerPort(data) {
    const device = data.deviceId ? deviceRegistry.get(data.deviceId) : null
    const state = device ? devState.get(device) : null
    if (!state || !state.opened) return
    wireDevicePort(state)
  }


  if (!isWorker) {
    setupTrustedTypesSharing()
  }

  /** @returns {void} */
  function setupTrustedTypesSharing() {
    if (typeof trustedTypes === 'undefined' || trustedTypes === null) return
    const nativeCreatePolicy = trustedTypes.createPolicy.bind(trustedTypes)
    const claim = (name) => {
      try {
        return nativeCreatePolicy(name, { createScriptURL: (s) => s })
      } catch {
        return null
      }
    }
    let policy = claim('webhid-worker')
    if (policy) {
      installTtSharing('webhid-worker', policy, nativeCreatePolicy)
      return
    }
    sendRequest('getCspInfo')
      .then((info) => {
        const names = (info && info.trustedTypesNames) || []
        for (const name of ['default', ...names]) {
          if (name === 'webhid-worker') continue
          const p = claim(name)
          if (p) {
            installTtSharing(name, p, nativeCreatePolicy)
            return
          }
        }
      })
      .catch(() => {})
  }

  /**
   * @param {object} policy
   * @param {string} name
   * @param {object} [pageRules]
   * @returns {object}
   */
  function makeWrappedPolicy(policy, name, pageRules) {
    const proto = typeof TrustedTypePolicy !== 'undefined' ? TrustedTypePolicy.prototype : Object.prototype
    const wrapper = Object.create(proto)
    const rules = pageRules || {}
    const define = (prop, value) => {
      Object.defineProperty(wrapper, prop, {
        value,
        writable: false,
        enumerable: false,
        configurable: false,
      })
    }
    define('name', name)
    const origScriptURL = policy.createScriptURL.bind(policy)
    if (typeof rules.createScriptURL === 'function') {
      const pageFn = rules.createScriptURL
      define('createScriptURL', (s) => origScriptURL(pageFn(s)))
    } else {
      define('createScriptURL', origScriptURL)
    }
    for (const m of ['createHTML', 'createScript']) {
      if (typeof rules[m] === 'function') {
        const pageFn = rules[m]
        const orig = policy[m].bind(policy)
        define(m, (s) => orig(pageFn(s)))
      }
    }
    return wrapper
  }

  /**
   * @param {string} name
   * @param {object} policy
   * @param {Function} nativeCreatePolicy
   * @returns {void}
   */
  function installTtSharing(name, policy, nativeCreatePolicy) {
    let usedOnce = false
    trustedTypes.createPolicy = function (claimedName, pageRules) {
      if (claimedName === name && !usedOnce) {
        usedOnce = true
        return makeWrappedPolicy(policy, name, pageRules)
      }
      return nativeCreatePolicy(claimedName, pageRules)
    }
    ttFactory = (url) => policy.createScriptURL(url)
  }

  let OriginalError
  let stackDescriptor
  let getOriginalStack
  if (!isWorker) {
    OriginalError = window.Error
    stackDescriptor = Object.getOwnPropertyDescriptor(OriginalError.prototype, 'stack')
    getOriginalStack = stackDescriptor && stackDescriptor.get
  }

  /** @returns {boolean} */
  function isCalledFromConsole() {
    if (isWorker) return false
    try {
      throw new OriginalError()
    } catch (e) {
      const stack = getOriginalStack ? getOriginalStack.call(e) : e.stack
      if (typeof stack !== 'string') return false
      const lines = stack.split('\n')
      const callerFrame = lines.at(2) || ''
      return callerFrame.includes('debugger eval code')
    }
  }

  /** @returns {string} */
  function getCallerFrameUrl() {
    if (isWorker) return ''
    try {
      const stack = new Error().stack
      if (!stack) return location.href
      const lines = stack.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/@(.*?):\d+:\d+/)
        if (m && m[1].startsWith('http')) {
          return m[1]
        }
      }
    } catch (e) {
      console.debug('stack trace extraction failed', e)
    }
    return location.href
  }

  /** @type {number} */
  let nextReqId = 0
  /** @type {{[key: string]: Function}} */
  const pending = {}
  /** @type {string} */
  const frameNonce = crypto.randomUUID()

  /** @type {MessagePort|null} */
  let bridgePort = null
  /** @type {Promise<void>} */
  const bridgeReady = isWorker
    ? new Promise((resolve) => {
        self.addEventListener('message', function onInit(e) {
          if (e.data === null && e.ports[0]) {
            self.removeEventListener('message', onInit)
            bridgePort = e.ports[0]
            setupBridgePort()
            resolve()
          }
        })
      })
    : new Promise((resolve) => {
        const channel = new MessageChannel()
        bridgePort = channel.port1
        const target = window === window.top ? window : window.top
        target.postMessage(null, '*', [channel.port2])
        setupBridgePort()
        resolve()
      })

  /** @returns {void} */
  function setupBridgePort() {
    if (!bridgePort) return
    bridgePort.onmessage = (event) => {
      if (!event.data) return
      if (event.data.type === 'dataPlaneConnect') {
        handleDataPlaneConnect(event.data)
        return
      }
      if (event.data.type === 'dataPlaneDisconnect') {
        handleDataPlaneDisconnect(event.data)
        return
      }
      if (event.data.type === 'spawnWorkerRequest') {
        handleSpawnWorkerRequest(event.data).then((r) => {
          if (r.transfer) {
            bridgePort.postMessage(
              { type: 'spawnWorkerResponse', id: event.data.id, result: r.result },
              [r.transfer]
            )
          } else {
            bridgePort.postMessage({
              type: 'spawnWorkerResponse',
              id: event.data.id,
              result: r.result,
            })
          }
        })
        return
      }
      if (event.data.type === 'wireWorkerPort') {
        handleWireWorkerPort(event.data)
        return
      }
      if (event.data.type === 'response') {
        const handler = pending[event.data.id]
        if (handler) {
          delete pending[event.data.id]
          handler(event.data.result)
        }
        return
      }
      if (event.data.type === 'settings') {
        settings.set(event.data.settings || {})
        return
      }
      if (event.data.type === 'event') {
        dispatchDeviceEvent(event.data.event)
      }
    }
  }

  /**
   * @param {string} action
   * @param {object} [payload]
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<object>}
   */
  async function sendRequest(action, payload, opts = {}) {
    await bridgeReady
    if (!bridgePort) return { s: 0 }
    return new Promise((resolve) => {
      const id = frameNonce + ':' + ++nextReqId
      const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000
      let settled = false
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          delete pending[id]
          logger.warn('sendRequest timeout: ' + action + ' (id=' + id + ')')
          resolve({ s: 504 })
        }, timeoutMs)
      }
      pending[id] = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        delete pending[id]
        resolve(result)
      }
      const msg = { id, action, payload: payload || {} }
      const transfers = []
      if (payload && payload.data instanceof Uint8Array) {
        transfers.push(payload.data.buffer)
      }
      bridgePort.postMessage(msg, transfers.length ? transfers : undefined)
    })
  }

  /** @type {string[]|null} */
  let pairedDevices = null
  /** @type {Map<string, object> | null} */
  let deviceInfoCache = null

  /** @returns {Promise<string[]>} */
  async function getPairedDevices() {
    if (pairedDevices !== null) return pairedDevices
    try {
      const result = await sendRequest('getPairedDevices')
      pairedDevices = result.hashes || []
      deviceInfoCache = null
      return pairedDevices
    } catch {
      return []
    }
  }

  /** @returns {Promise<Map<string, object>>} */
  async function getDeviceCache() {
    if (deviceInfoCache !== null) return deviceInfoCache
    try {
      const response = await sendRequest('enumerate')
      const devices = http.isOk(response.s) && Array.isArray(response.D) ? response.D : []
      deviceInfoCache = new Map()
      for (const device of devices) deviceInfoCache.set(device.deviceId, device)
      return deviceInfoCache
    } catch {
      deviceInfoCache = new Map()
      return deviceInfoCache
    }
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {Promise<void>}
   */
  async function pairDevice(deviceInfo) {
    try {
      pairedDevices = null
      const result = await sendRequest('pairDevice', {
        device: { deviceId: deviceInfo.deviceId }
      })
      if (result && result.success) {
        pairedDevices = result.hashes || []
        deviceInfoCache = null
      } else {
        logger.warn(
          'pairDevice returned non-success for deviceId=' +
            deviceInfo.deviceId +
            ': ' +
            http.name(result != null ? result.s : 0)
        )
      }
    } catch (e) {
      logger.warn('pairDevice error:', e != null ? (e.message != null ? e.message : e) : e)
    }
  }

  const defs = GLOBAL_DEFAULTS
  const settings = createSettingsStore(defs)

  settings.on('dataPlane', (v) => logger.info('data plane changed: ' + v))
  logger.bindSettings(settings)

  bridgeReady.then(() => {
    sendRequest('getSettings', {}).then((result) => {
      if (!result) return
      settings.set(result)
      logger.info('data plane: ' + settings.dataPlane)
    })
  })

  /** @returns {{isCrossOrigin: boolean, frameUrl: string}} */
  function getPolicyContext() {
    if (isWorker) return { isCrossOrigin: false, frameUrl: '' }
    const url = getCallerFrameUrl()
    let isCrossOrigin = false
    if (window !== window.top) {
      try {
        window.parent.location.origin
      } catch {
        isCrossOrigin = true
      }
    }
    return { isCrossOrigin, frameUrl: url }
  }

  /** @returns {Promise<object>} */
  function getPolicy() {
    return sendRequest('getPolicy', getPolicyContext())
  }

  if (!isWorker) {
    const originalQuery = navigator.permissions?.query?.bind(navigator.permissions)
    if (originalQuery) {
      navigator.permissions.query = async (desc) => {
        if (desc && desc.name === 'hid') {
          const policy = await getPolicy()
          return {
            state: policy && policy.hid === 'none' ? 'denied' : 'granted',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
          }
        }
        return originalQuery(desc)
      }
    }
  }

  /** @type {WeakMap<object, object>} */
  const devState = new WeakMap()
  /** @type {WeakMap<object, object>} */
  const hidState = new WeakMap()
  /** @type {WeakMap<object, object>} */
  const evtState = new WeakMap()
  /** @type {symbol} */
  const irState = Symbol('webhid_ir')
  /** @type {Map<string, object>} */
  const deviceRegistry = new Map()

  /**
   * @constructor
   * @throws {TypeError}
   */
  function HIDDevice() {
    throw new TypeError('Illegal constructor')
  }
  HIDDevice.prototype = Object.create(EventTarget.prototype)
  HIDDevice.prototype.constructor = HIDDevice
  Object.defineProperty(HIDDevice.prototype, Symbol.toStringTag, {
    value: 'HIDDevice',
    configurable: true
  })

  Object.defineProperties(HIDDevice.prototype, {
    opened: {
      get() {
        return devState.get(this) == null
          ? void 0
          : devState.get(this).opened != null
            ? devState.get(this).opened
            : false
      },
      enumerable: false,
      configurable: true
    },
    vendorId: {
      get() {
        var dev = devState.get(this)
        return dev != null ? dev.vendorId : undefined
      },
      enumerable: false,
      configurable: true
    },
    productId: {
      get() {
        var dev = devState.get(this)
        return dev != null ? dev.productId : undefined
      },
      enumerable: false,
      configurable: true
    },
    productName: {
      get() {
        var dev = devState.get(this)
        return dev != null ? dev.productName : undefined
      },
      enumerable: false,
      configurable: true
    },
    collections: {
      get() {
        var dev = devState.get(this)
        return dev != null ? dev.collections : undefined
      },
      enumerable: false,
      configurable: true
    },
    oninputreport: {
      get() {
        return devState.get(this) == null
          ? void 0
          : devState.get(this).oninputreport != null
            ? devState.get(this).oninputreport
            : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = devState.get(this)
        if (!state) return
        if (state.oninputreport)
          state.eventTarget.removeEventListener('inputreport', state.oninputreport)
        state.oninputreport = v
        if (v) this.addEventListener('inputreport', v)
      },
      enumerable: false,
      configurable: true
    },
    open: {
      /** @returns {Promise<void>} */
      value: async function () {
        const state = devState.get(this)
        if (!state) throw new DOMException('Invalid state', 'InvalidStateError')
        if (state.forgotten)
          throw new DOMException('Device has been forgotten', 'InvalidStateError')
        if (state.opened) throw new DOMException('Device is already open', 'InvalidStateError')
        if (state.opening) throw new DOMException('Device is already open', 'InvalidStateError')
        state.opening = true
        try {
          const response = await sendRequest('open', {
            deviceId: state.deviceId,
            reportSize: state.maxInputReportSize + 3
          })
          if (http.isOk(response.s)) {
            await bridgeReady
            wireDevicePort(state)
            state.opened = true
            logger.info('open deviceId=' + state.deviceId)
            this.dispatchEvent(new Event('open'))
          } else {
            throw new Error('Open failed: ' + http.name(response.s || 0))
          }
        } catch (error) {
          throw new DOMException(error.message, 'NetworkError')
        } finally {
          state.opening = false
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    close: {
      /** @returns {Promise<void>} */
      value: async function () {
        const state = devState.get(this)
        if (!state) return
        if (state.forgotten)
          throw new DOMException('Device has been forgotten', 'InvalidStateError')
        if (!state.opened) return
        logger.debug('close deviceId=' + state.deviceId)
        try {
          const response = await sendRequest('close', {
            deviceId: state.deviceId
          })
          if (http.isOk(response.s)) {
            state.opened = false
            rejectPendingReports(state, new DOMException('Device closed', 'AbortError'))
            if (state.dataPort) {
              state.dataPort.onmessage = null
              state.dataPort.close()
              state.dataPort = null
            }
            this.dispatchEvent(new Event('close'))
          } else {
            throw new Error('Failed to close device')
          }
        } catch (error) {
          throw new DOMException(error.message, 'InvalidStateError')
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    sendReport: {
      /**
       * @param {number} reportId
       * @param {ArrayBuffer|DataView|TypedArray} data
       * @returns {Promise<void>}
       */
      value: async function (reportId, data) {
        const state = devState.get(this)
        if (!state) throw new DOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new DOMException('Device is not open', 'InvalidStateError')
        validateReportId(reportId, state.collections)
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        const buffer = view.slice()
        try {
          logger.debug('sendReport reportId=' + reportId + ' len=' + buffer.length)
          const inPage = inPageRequest(
            inPagePlanes.get(state.deviceId),
            MSG_SEND_REPORT,
            reportId,
            buffer,
            () => undefined
          )
          if (inPage) return inPage
          if (!state.dataPort) throw new Error('data port not connected')
          const reqId = ++nextReqId
          const msg = { type: 'send', reqId, reportId, data: buffer }
          return new Promise((resolve, reject) => {
            state.dataPending = state.dataPending || new Map()
            state.dataPending.set(reqId, {
              resolve: () => resolve(),
              reject: (e) => {
                if (e && e.blocked) {
                  reject(new DOMException('Report is blocked', 'NotAllowedError'))
                } else {
                  reject(new DOMException((e && e.message) || e || 'send failed', 'NetworkError'))
                }
              }
            })
            state.dataPort.postMessage(msg, [buffer.buffer])
          })
        } catch (error) {
          throw new DOMException(error.message, 'NetworkError')
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    receiveFeatureReport: {
      /**
       * @param {number} reportId
       * @returns {Promise<DataView>}
       */
      value: async function (reportId) {
        const state = devState.get(this)
        if (!state) throw new DOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new DOMException('Device is not open', 'InvalidStateError')
        validateReportId(reportId, state.collections)
        try {
          const inPage = inPageRequest(
            inPagePlanes.get(state.deviceId),
            MSG_RECEIVE_FEATURE_REPORT,
            reportId,
            null,
            (data) => {
              if (!data) return new DataView(new ArrayBuffer(0))
              const b = data instanceof Uint8Array ? data : new Uint8Array(data)
              return new DataView(b.buffer, b.byteOffset, b.byteLength)
            }
          )
          if (inPage) return inPage
          if (!state.dataPort) throw new Error('data port not connected')
          const reqId = ++nextReqId
          return new Promise((resolve, reject) => {
            state.dataPending = state.dataPending || new Map()
            state.dataPending.set(reqId, {
              resolve: (data) => {
                if (!data) return resolve(new DataView(new ArrayBuffer(0)))
                const buffer = data instanceof Uint8Array ? data : new Uint8Array(data)
                resolve(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength))
              },
              reject: (e) => {
                if (e && e.blocked) {
                  reject(new DOMException('Report is blocked', 'NotAllowedError'))
                } else {
                  reject(
                    new DOMException((e && e.message) || e || 'receive failed', 'NetworkError')
                  )
                }
              }
            })
            state.dataPort.postMessage({
              type: 'receiveFeature',
              reqId,
              reportId
            })
          })
        } catch (error) {
          throw new DOMException(error.message, 'NetworkError')
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    sendFeatureReport: {
      /**
       * @param {number} reportId
       * @param {ArrayBuffer|DataView|TypedArray} data
       * @returns {Promise<void>}
       */
      value: async function (reportId, data) {
        const state = devState.get(this)
        if (!state) throw new DOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new DOMException('Device is not open', 'InvalidStateError')
        validateReportId(reportId, state.collections)
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        const buffer = view.slice()
        logger.debug('sendFeatureReport reportId=' + reportId + ' len=' + buffer.length)
        try {
          const inPage = inPageRequest(
            inPagePlanes.get(state.deviceId),
            MSG_SEND_FEATURE_REPORT,
            reportId,
            buffer,
            () => undefined
          )
          if (inPage) return inPage
          if (!state.dataPort) throw new Error('data port not connected')
          const reqId = ++nextReqId
          const msg = { type: 'sendFeature', reqId, reportId, data: buffer }
          return new Promise((resolve, reject) => {
            state.dataPending = state.dataPending || new Map()
            state.dataPending.set(reqId, {
              resolve: () => resolve(undefined),
              reject: (e) => {
                if (e && e.blocked) {
                  reject(new DOMException('Report is blocked', 'NotAllowedError'))
                } else {
                  reject(new DOMException((e && e.message) || e || 'send failed', 'NetworkError'))
                }
              }
            })
            state.dataPort.postMessage(msg, [buffer.buffer])
          })
        } catch (error) {
          throw new DOMException(error.message, 'NetworkError')
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    forget: {
      /** @returns {Promise<void>} */
      value: async function () {
        const state = devState.get(this)
        if (!state) return
        if (state.forgotten) return
        await teardownForgottenDevice(this, state)
        await sendRequest('unpairDevice', { deviceId: state.deviceId })
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    addEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @returns {void}
       */
      value: function (type, listener) {
        const state = devState.get(this)
        if (state) state.eventTarget.addEventListener(type, listener)
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    removeEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @returns {void}
       */
      value: function (type, listener) {
        const state = devState.get(this)
        if (state) state.eventTarget.removeEventListener(type, listener)
      },
      enumerable: false,
      configurable: true,
      writable: true
    }
  })

  /**
   * @param {string} deviceId
   * @returns {Promise<object | null>}
   */
  async function resolvePairedDevice(deviceId) {
    deviceInfoCache = null
    const [hashes, cache] = await Promise.all([getPairedDevices(), getDeviceCache()])
    if (!hashes.includes(deviceId)) return null
    const info = cache.get(deviceId)
    return info ? getOrCreateDevice(info) : null
  }

  /**
   * @param {object} detail
   * @returns {Promise<void>}
   */
  async function dispatchDeviceEvent(detail) {
    if (!detail) return
    if (detail.eventType === 'revoked') {
      if (detail.deviceId) await forceForgetDevice(detail.deviceId)
      return
    }
    if (detail.eventType === 'connect' || detail.eventType === 'disconnect') {
      let device = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null
      if (!device && detail.eventType === 'connect' && detail.deviceId) {
        try {
          device = await resolvePairedDevice(detail.deviceId)
        } catch (e) {
          logger.warn(
            'connect event lookup failed:',
            e != null ? (e.message != null ? e.message : e) : e
          )
        }
      }
      if (hidInstance && device) {
        if (detail.eventType === 'disconnect') deviceInfoCache = null
        hidInstance.dispatchEvent(new HIDConnectionEvent(detail.eventType, { device: device }))
        if (detail.eventType === 'disconnect') {
          deviceRegistry.delete(detail.deviceId)
        }
      }
      return
    }
    if (detail.eventType === 'input_report') {
      const device = detail.deviceId ? deviceRegistry.get(detail.deviceId) : null
      if (device) {
        const dataView = detail.data
          ? new DataView(
              detail.data.buffer || detail.data,
              detail.data.byteOffset || 0,
              detail.data.byteLength
            )
          : new DataView(new ArrayBuffer(0))
        device.dispatchEvent(
          new HIDInputReportEvent('inputreport', {
            device: device,
            reportId: detail.reportId,
            data: dataView
          })
        )
      }
      return
    }
  }

  /**
   * @param {object} state
   * @param {Error} error
   * @returns {void}
   */
  function rejectPendingReports(state, error) {
    if (!state.dataPending || !state.dataPending.size) return
    for (const [, entry] of state.dataPending) {
      try {
        entry.reject(error)
      } catch (e) {
        logger.debug('reject pending report failed', e)
      }
    }
    state.dataPending.clear()
  }

  /**
   * @param {object} collection
   * @returns {boolean}
   */
  function collectionUsesReportIds(collection) {
    const reports = [
      ...(collection.inputReports || []),
      ...(collection.outputReports || []),
      ...(collection.featureReports || [])
    ]
    if (reports.some((r) => r.reportId !== 0)) return true
    return (collection.children || []).some(collectionUsesReportIds)
  }

  /**
   * @param {object[]} collections
   * @returns {boolean}
   */
  function deviceUsesReportIds(collections) {
    return (collections || []).some(collectionUsesReportIds)
  }

  /**
   * @param {number} reportId
   * @param {object[]} collections
   * @returns {void}
   * @throws {TypeError}
   */
  function validateReportId(reportId, collections) {
    if (
      typeof reportId !== 'number' ||
      !Number.isInteger(reportId) ||
      reportId < 0 ||
      reportId > 255
    ) {
      throw new TypeError('reportId must be an integer in the range 0-255')
    }
    const usesReportIds = deviceUsesReportIds(collections)
    if (reportId === 0 && usesReportIds) {
      throw new TypeError('reportId must not be 0 for a device that uses report IDs')
    }
    if (reportId !== 0 && !usesReportIds) {
      throw new TypeError('reportId must be 0 for a device that does not use report IDs')
    }
  }

  /**
   * @param {object} device
   * @param {object} state
   * @returns {Promise<void>}
   */
  async function teardownForgottenDevice(device, state) {
    state.forgotten = true
    rejectPendingReports(state, new DOMException('Device forgotten', 'AbortError'))
    if (state.opened) {
      state.opened = false
      try {
        await sendRequest('close', { deviceId: state.deviceId })
      } catch (error) {
        logger.warn(
          'teardownForgottenDevice: close failed:',
          error != null ? (error.message != null ? error.message : error) : error
        )
      }
      if (state.dataPort) {
        state.dataPort.onmessage = null
        state.dataPort.close()
        state.dataPort = null
      }
      device.dispatchEvent(new Event('close'))
    }
    pairedDevices = null
    deviceInfoCache = null
    deviceRegistry.delete(state.deviceId)
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async function forceForgetDevice(deviceId) {
    const device = deviceRegistry.get(deviceId)
    if (!device) {
      pairedDevices = null
      deviceInfoCache = null
      return
    }
    const state = devState.get(device)
    if (!state || state.forgotten) return
    await teardownForgottenDevice(device, state)
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function onDataPortMessage(state, data) {
    if (!data) return
    if (data.type === 'sendResult' || data.type === 'featureResult') {
      const entry = state.dataPending != null ? state.dataPending.get(data.reqId) : undefined
      if (!entry) return
      state.dataPending.delete(data.reqId)
      if (data.error) entry.reject(new Error(data.error))
      else if (data.type === 'featureResult') entry.resolve(data.data)
      else entry.resolve()
      return
    }
    if (data.type === 'inputReportBatch') {
      const device = state.self
      if (device && Array.isArray(data.reports)) {
        for (const r of data.reports) {
          if (r == null) continue
          const dataView = r.data ? new DataView(r.data) : new DataView(new ArrayBuffer(0))
          device.dispatchEvent(
            new HIDInputReportEvent('inputreport', {
              device: device,
              reportId: r.reportId,
              data: dataView
            })
          )
        }
      }
      return
    }
    if (data.type === 'inputReport') {
      const dataView = data.data ? new DataView(data.data) : new DataView(new ArrayBuffer(0))
      const device = state.self
      if (device)
        device.dispatchEvent(
          new HIDInputReportEvent('inputreport', {
            device: device,
            reportId: data.reportId,
            data: dataView
          })
        )
      return
    }
    if (data.type === 'disconnect') {
      deviceInfoCache = null
      const device = state.self
      if (device) device.dispatchEvent(new HIDConnectionEvent('disconnect', { device: device }))
      return
    }
  }

  /**
   * @param {object} object
   * @returns {object}
   */
  function deepFreeze(object) {
    const propNames = Reflect.ownKeys(object)

    for (const name of propNames) {
      const value = object[name]

      if ((value && typeof value === 'object') || typeof value === 'function') {
        deepFreeze(value)
      }
    }

    return Object.freeze(object)
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {object}
   */
  function createHIDDevice(deviceInfo) {
    const obj = Object.create(HIDDevice.prototype)
    const eventTarget = new EventTarget()
    obj.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget)
    const state = {
      eventTarget: eventTarget,
      self: obj,
      deviceId: deviceInfo.deviceId,
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
      productName: deviceInfo.productName,
      collections: deepFreeze(deviceInfo.collections || []),
      opened: false,
      opening: false,
      dataPort: null,
      dataPending: null,
      maxInputReportSize: deviceInfo.maxInputReportSize || 64,
      oninputreport: null
    }
    devState.set(obj, state)
    return obj
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {object}
   */
  function getOrCreateDevice(deviceInfo) {
    const id = deviceInfo.deviceId
    if (id && deviceRegistry.has(id)) return deviceRegistry.get(id)
    const device = createHIDDevice(deviceInfo)
    if (id) deviceRegistry.set(id, device)
    return device
  }

  /**
   * @constructor
   * @param {string} type
   * @param {object} init
   * @returns {Event}
   */
  function HIDInputReportEvent(type, init) {
    const obj = Reflect.construct(Event, [type, init], new.target || HIDInputReportEvent)
    obj[irState] = {
      device: init != null ? init.device : undefined,
      reportId: init != null ? init.reportId : undefined,
      data: init != null ? init.data : undefined
    }
    return obj
  }
  HIDInputReportEvent.prototype = Object.create(Event.prototype)
  HIDInputReportEvent.prototype.constructor = HIDInputReportEvent
  Object.defineProperty(HIDInputReportEvent.prototype, Symbol.toStringTag, {
    value: 'HIDInputReportEvent',
    configurable: true
  })
  Object.defineProperties(HIDInputReportEvent.prototype, {
    device: {
      get() {
        var st = this[irState]
        return st != null ? st.device : undefined
      },
      enumerable: false,
      configurable: true
    },
    reportId: {
      get() {
        var st = this[irState]
        return st != null ? st.reportId : undefined
      },
      enumerable: false,
      configurable: true
    },
    data: {
      get() {
        var st = this[irState]
        return st != null ? st.data : undefined
      },
      enumerable: false,
      configurable: true
    }
  })

  /**
   * @constructor
   * @param {string} type
   * @param {object} init
   * @returns {Event}
   */
  function HIDConnectionEvent(type, init) {
    const obj = Reflect.construct(Event, [type], new.target || HIDConnectionEvent)
    evtState.set(obj, {
      device: init == null ? void 0 : init.device != null ? init.device : init
    })
    return obj
  }
  HIDConnectionEvent.prototype = Object.create(Event.prototype)
  HIDConnectionEvent.prototype.constructor = HIDConnectionEvent
  Object.defineProperty(HIDConnectionEvent.prototype, Symbol.toStringTag, {
    value: 'HIDConnectionEvent',
    configurable: true
  })
  Object.defineProperty(HIDConnectionEvent.prototype, 'device', {
    get() {
      var st = evtState.get(this)
      return st != null ? st.device : undefined
    },
    enumerable: false,
    configurable: true
  })

  /**
   * @constructor
   * @throws {TypeError}
   */
  function HID() {
    throw new TypeError('Illegal constructor')
  }
  HID.prototype = Object.create(EventTarget.prototype)
  HID.prototype.constructor = HID
  Object.defineProperty(HID.prototype, Symbol.toStringTag, {
    value: 'HID',
    configurable: true
  })

  Object.defineProperties(HID.prototype, {
    getDevices: {
      /** @returns {Promise<object[]>} */
      value: async function () {
        const policy = await getPolicy()
        if (policy && policy.hid === 'none') {
          throw new DOMException('Access to HID is blocked by Permissions Policy', 'SecurityError')
        }
        try {
          const pairedHashes = await getPairedDevices()
          const deviceCache = await getDeviceCache()
          const granted = []
          for (const hash of pairedHashes) {
            const device = deviceCache.get(hash)
            if (device) granted.push(getOrCreateDevice(device))
          }
          logger.debug('getDevices returned ' + granted.length + ' device(s)')
          return granted
        } catch (error) {
          logger.warn('getDevices error:', error)
          return []
        }
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    requestDevice: {
      /**
       * @param {object} [options]
       * @param {object[]} [options.filters]
       * @param {object[]} [options.exclusionFilters]
       * @returns {Promise<object[]>}
       */
      value: async function (options = {}) {
        if (isWorker) {
          throw new DOMException('Not allowed in worker context', 'NotSupportedError')
        }
        const policy = await getPolicy()
        if (policy && policy.hid === 'none') {
          throw new DOMException('Access to HID is blocked by Permissions Policy', 'SecurityError')
        }
        if (
          !isCalledFromConsole() &&
          !settings.allowActivationlessRequestDevice &&
          navigator.userActivation &&
          !navigator.userActivation.isActive
        ) {
          throw new DOMException(
            'Must be handling a user gesture to perform a hid.requestDevice() call.',
            'SecurityError'
          )
        }
        const filters = Array.isArray(options.filters) ? options.filters : []
        for (const filter of filters) {
          if (!isValidFilter(filter)) {
            throw new TypeError('Invalid filter in HIDDeviceRequestOptions.filters')
          }
        }

        let exclusionFilters = []
        if (options.exclusionFilters !== undefined) {
          exclusionFilters = Array.isArray(options.exclusionFilters) ? options.exclusionFilters : []
          if (exclusionFilters.length === 0) {
            throw new TypeError(
              'HIDDeviceRequestOptions.exclusionFilters must not be empty when present'
            )
          }
          for (const filter of exclusionFilters) {
            if (!isValidFilter(filter)) {
              throw new TypeError('Invalid filter in HIDDeviceRequestOptions.exclusionFilters')
            }
          }
        }

        logger.debug(
          'requestDevice filters=' +
            JSON.stringify(filters) +
            ' exclusionFilters=' +
            JSON.stringify(exclusionFilters)
        )
        return new Promise((resolve, reject) => {
          const id = frameNonce + ':' + ++nextReqId
          pending[id] = async (result) => {
            try {
              if (result.cancelled) {
                resolve([])
                return
              }
              const devices = result.devices
              if (!devices || devices.length === 0) {
                resolve([])
                return
              }
              await Promise.all(devices.map((device) => pairDevice(device)))
              // Devices granted together share one grant event. The group
              // relationship is only knowable here, at grant time; persist it
              // so forget can revoke the whole group (multi-interface devices).
              if (devices.length > 1) {
                sendRequest('recordGrantGroup', {
                  deviceIds: devices.map((device) => device.deviceId)
                }).catch(() => {})
              }
              resolve(devices.map((device) => getOrCreateDevice(device)))
            } catch (e) {
              reject(
                new DOMException(e != null ? e.message : 'requestDevice failed', 'NetworkError')
              )
            }
          }
          bridgePort.postMessage({
            id,
            action: 'requestDevice',
            payload: { filters, exclusionFilters }
          })
        })
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    addEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @returns {void}
       */
      value: function (type, listener) {
        const state = hidState.get(this)
        if (state) state.eventTarget.addEventListener(type, listener)
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    removeEventListener: {
      /**
       * @param {string} type
       * @param {EventListenerOrEventListenerObject} listener
       * @returns {void}
       */
      value: function (type, listener) {
        const state = hidState.get(this)
        if (state) state.eventTarget.removeEventListener(type, listener)
      },
      enumerable: false,
      configurable: true,
      writable: true
    },
    onconnect: {
      get() {
        return hidState.get(this) == null
          ? void 0
          : hidState.get(this).onconnect != null
            ? hidState.get(this).onconnect
            : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = hidState.get(this)
        if (!state) return
        if (state.onconnect) state.eventTarget.removeEventListener('connect', state.onconnect)
        state.onconnect = v
        if (v) state.eventTarget.addEventListener('connect', v)
      },
      enumerable: false,
      configurable: true
    },
    ondisconnect: {
      get() {
        return hidState.get(this) == null
          ? void 0
          : hidState.get(this).ondisconnect != null
            ? hidState.get(this).ondisconnect
            : null
      },
      /** @param {Function|null} v */
      set(v) {
        const state = hidState.get(this)
        if (!state) return
        if (state.ondisconnect)
          state.eventTarget.removeEventListener('disconnect', state.ondisconnect)
        state.ondisconnect = v
        if (v) state.eventTarget.addEventListener('disconnect', v)
      },
      enumerable: false,
      configurable: true
    }
  })

  /** @returns {object} */
  function createHID() {
    const obj = Object.create(HID.prototype)
    const eventTarget = new EventTarget()
    obj.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget)
    hidState.set(obj, {
      eventTarget: eventTarget,
      onconnect: null,
      ondisconnect: null
    })
    return obj
  }

  if (!isWorker) {
    Object.defineProperty(globalThis, 'HID', {
      value: HID,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(globalThis, 'HIDDevice', {
      value: HIDDevice,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(globalThis, 'HIDInputReportEvent', {
      value: HIDInputReportEvent,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(globalThis, 'HIDConnectionEvent', {
      value: HIDConnectionEvent,
      writable: false,
      configurable: true,
      enumerable: false
    })
  } else {
    Object.defineProperty(self, 'HID', {
      value: HID,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(self, 'HIDDevice', {
      value: HIDDevice,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(self, 'HIDInputReportEvent', {
      value: HIDInputReportEvent,
      writable: false,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(self, 'HIDConnectionEvent', {
      value: HIDConnectionEvent,
      writable: false,
      configurable: true,
      enumerable: false
    })
  }

  hidInstance = createHID()
  if (!isWorker) {
    Object.defineProperty(Navigator.prototype, 'hid', {
      get() {
        return hidInstance
      },
      configurable: true,
      enumerable: true
    })
  } else {
    const navProto = Object.getPrototypeOf(self.navigator)
    Object.defineProperty(navProto, 'hid', {
      get() {
        return hidInstance
      },
      configurable: true,
      enumerable: true
    })
  }

  const NativeWorker = globalThis.Worker
  /**
   * @param {string|URL} url
   * @param {object} [opts]
   * @returns {Worker}
   */
  function PatchedWorker(url, opts) {
    const instance = new NativeWorker(url, opts)
    const ch = new MessageChannel()
    instance.postMessage(null, [ch.port1])
    bridgeReady.then(() => {
      if (!bridgePort) return
      bridgePort.postMessage(
        {
          id: frameNonce + ':' + ++nextReqId,
          action: 'workerPort',
          payload: {}
        },
        [ch.port2]
      )
    })
    return instance
  }
  if (NativeWorker) {
    PatchedWorker.prototype = NativeWorker.prototype
    Object.setPrototypeOf(PatchedWorker, NativeWorker)
    globalThis.Worker = PatchedWorker
  }
})()
