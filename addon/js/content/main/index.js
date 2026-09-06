;(function () {
  /** @type {import("./types.js").Logger} */
  const webhid = globalThis.webhid

  /** @type {import("./types.js").Logger} */
  const logger = webhid.import('logger')
  const pristine = webhid.import('pristine')
  const { object, reflect, types, host } = pristine
  const NativeWindow = types.Window && types.Window.constructor
  const windowObject = host.window
  const isWorker = typeof windowObject === 'undefined' || !NativeWindow || !(windowObject instanceof NativeWindow)
  if (!isWorker && !windowObject.isSecureContext) {
    webhid.import('logger').warn('NO POLYFILL')
    return
  }

  const http = webhid.import('http')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const createSettingsStore = webhid.import('createSettingsStore')
  const isValidFilter = webhid.import('isValidFilter')
  const createWtTransport = webhid.import('createWtTransport')
  const NativeMap = types.Map.constructor
  const NativeWeakMap = types.WeakMap.constructor
  const NativeArrayBuffer = types.ArrayBuffer.constructor
  const NativeDataView = types.DataView.constructor
  const NativeUint8Array = types.Uint8Array.constructor
  const NativeEventTarget = types.EventTarget.constructor
  const NativeMessageChannel = types.MessageChannel.constructor
  const NativeWorker = types.Worker ? types.Worker.constructor : null
  const NativeBlob = types.Blob ? types.Blob.constructor : null
  const NativeEvent = types.Event ? types.Event.constructor : null
  const NativeDOMException = types.DOMException ? types.DOMException.constructor : null
  const NativeError = types.Error.constructor
  const NativeTypeError = types.TypeError.constructor
  const TypeError = NativeTypeError
  const NativeObject = types.Object.constructor
  const NativePromise = types.Promise.constructor
  const Promise = NativePromise
  const mapOps = types.Map.proto.methods
  const weakMapOps = types.WeakMap.proto.methods
  const eventTargetOps = types.EventTarget.proto.methods
  const nativeMessagePortPostMessage = types.MessagePort.getDescriptor('postMessage').value
  const nativeMessagePortAddEventListener =
    types.MessagePort.getDescriptor('addEventListener').value
  const nativeMessagePortRemoveEventListener =
    types.MessagePort.getDescriptor('removeEventListener').value
  const nativeMessagePortClose = types.MessagePort.getDescriptor('close').value
  const nativeMessagePortStart = types.MessagePort.getDescriptor('start').value
  const nativeWorkerPostMessage = types.Worker
    ? types.Worker.getDescriptor('postMessage').value
    : null
  const nativeWorkerAddEventListener = types.Worker
    ? types.Worker.getDescriptor('addEventListener').value
    : null
  const nativeWindowPostMessage = !isWorker ? host.windowPostMessageMethod : null
  const nativeWorkerTerminate = types.Worker
    ? types.Worker.getDescriptor('terminate').value
    : null
  const nativeWindowAddEventListener = host.windowAddEventListener
  const nativeWindowRemoveEventListener = host.windowRemoveEventListener
  const nativeCreateObjectURL = host.url.createObjectURL
  const nativeRevokeObjectURL = host.url.revokeObjectURL
  const nativeCryptoRandomUUID = host.cryptoRandomUUID
  const nativeSetTimeout = host.timers.setTimeout
  const nativeSelfPostMessage = host.postMessage
  const ArrayBuffer = NativeArrayBuffer
  const DataView = NativeDataView
  const Uint8Array = NativeUint8Array
  const EventTarget = NativeEventTarget
  const Event = NativeEvent
  const Object = NativeObject
  const arrayIsArray = types.Array.getStaticDescriptor('isArray').value
  const arrayOps = types.Array.proto.methods
  const stringOps = types.String.proto.methods
  const nativeClearTimeout = host.timers.clearTimeout
  const nativeCreateTrustedTypePolicy = host.trustedTypesCreatePolicy
  const nativeUserActivation = host.userActivation
  const nativeIsActiveGetter = host.userActivationIsActive
  const callNative = (fn, receiver, ...args) => reflect.apply(fn, receiver, args)
  const nativeBind = types.Function.proto.methods.bind
  const permissionsObject = host.permissions
  const executionGlobal = isWorker ? host.self : windowObject
  const trustedTypes = host.trustedTypes
  const Navigator = types.Navigator ? types.Navigator.constructor : null
  const TrustedTypePolicy = types.TrustedTypePolicy
    ? types.TrustedTypePolicy.constructor
    : null
  const nativePermissionsQuery =
    host.permissionsQuery ||
    (permissionsObject && typeof permissionsObject.query === 'function'
      ? nativeBind(permissionsObject.query, permissionsObject)
      : null)
  const promiseOps = types.Promise.proto.methods
  const promiseAll = types.Promise.getStaticDescriptor('all').value
  const stringConstructor = types.String.constructor
  const uint8Ops = types.Uint8Array.proto.methods
  const nativeNumberIsFinite = host.numberIsFinite
  const nativeMathTrunc = host.mathTrunc
  const nativeJsonStringify = host.jsonStringify
  /**
   * Replaces Map instance methods with captured intrinsic operations.
   * @param {Map} value
   * @returns {Map}
   */
  function hardenMap(value) {
    object.defineProperties(value, {
      get: { value: (key) => mapOps.get(value, key) },
      set: { value: (key, item) => mapOps.set(value, key, item) },
      delete: { value: (key) => mapOps.delete(value, key) },
      has: { value: (key) => mapOps.has(value, key) },
      forEach: { value: (callback, receiver) => mapOps.forEach(value, callback, receiver) },
      entries: { value: () => mapOps.entries(value) },
      values: { value: () => mapOps.values(value) },
      keys: { value: () => mapOps.keys(value) },
      size: { get: () => types.Map.proto.getters.size(value) }
    })
    return value
  }

  /**
   * Replaces WeakMap instance methods with captured intrinsic operations.
   * @param {WeakMap} value
   * @returns {WeakMap}
   */
  function hardenWeakMap(value) {
    object.defineProperties(value, {
      get: { value: (key) => weakMapOps.get(value, key) },
      set: { value: (key, item) => weakMapOps.set(value, key, item) },
      delete: { value: (key) => weakMapOps.delete(value, key) },
      has: { value: (key) => weakMapOps.has(value, key) }
    })
    return value
  }
  /**
   * Replaces EventTarget methods with captured intrinsic operations.
   * @param {EventTarget} value
   * @returns {EventTarget}
   */
  function hardenEventTarget(value) {
    object.defineProperties(value, {
      addEventListener: {
        value: (type, listener, options) =>
          eventTargetOps.addEventListener(value, type, listener, options)
      },
      removeEventListener: {
        value: (type, listener, options) =>
          eventTargetOps.removeEventListener(value, type, listener, options)
      },
      dispatchEvent: {
        value: (event) => eventTargetOps.dispatchEvent(value, event)
      }
    })
    return value
  }

  reflect.deleteProperty(globalThis, 'webhid')

  /**
   * Reports whether the captured user activation is currently active.
   * @returns {boolean}
   */
  function hasTransientActivation() {
    return nativeIsActiveGetter && nativeUserActivation ? nativeIsActiveGetter() : false
  }

  logger.initLogger('polyfill')

  /** @type {Function|null} */
  let ttFactory = null
  /** @type {Promise<boolean>} */
  let ttReady = Promise.resolve(true)
  /** @type {object|null} */
  let hidInstance = null

  /** @type {Map<string, object>} */
  const inPagePlanes = hardenMap(new NativeMap())

  const {
    MSG_SEND_REPORT,
    MSG_SEND_FEATURE_REPORT,
    MSG_RECEIVE_FEATURE_REPORT,
    MSG_INPUT_BATCH,
    parseInputReports,
    buildSendFrame,
    handleControlResponse: handleControlResponseShared
  } = webhid.import('wireFormat')
  /** @type {Map<number, {deviceId: string, resolve: Function, reject: Function}>} */
  const inPagePending = hardenMap(new NativeMap())

  /**
   * @param {object} req
   * @returns {void}
   */
  function handleDataPlaneConnect(req) {
    const deviceId = req.deviceId
    let readyNotified = false
    const wt = createWtTransport({
      onReady: () => {
        if (readyNotified) return
        readyNotified = true
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneResponse',
          id: req.id,
          result: { ok: true }
        })
      },
      onClosed: (info) => {
        rejectInPagePending(deviceId, new NativeError('data plane closed'))
        if (info && info.willReconnect) return
        inPagePlanes.delete(deviceId)
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneEvent',
          deviceId,
          event: { type: 'closed' }
        })
      },
      onAuthFailed: (code) => {
        inPagePlanes.delete(deviceId)
        rejectInPagePending(deviceId, new NativeError('auth failed'))
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'dataPlaneEvent',
          deviceId,
          event: { type: 'auth-failed', code }
        })
      },
      onBinary: (batch) => {
        if (batch.length > 0 && batch[0] >= 0x81) return handleControlResponseShared(batch, inPagePending)
        const offset = batch.length > 0 && batch[0] === MSG_INPUT_BATCH ? 1 : 0
        pushInPageBatch(deviceId, batch, offset)
      }
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
    for (const r of parseInputReports(batch, offset)) {
      dispatchDeviceEvent({ eventType: 'input_report', deviceId, reportId: r.reportId, data: r.data })
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
    rejectInPagePending(data.deviceId, new NativeError('data plane closed'))
  }

  /**
   * Rejects every in-flight in-page plane request for a device.
   * @param {string} deviceId
   * @param {Error} error
   * @returns {void}
   */
  function rejectInPagePending(deviceId, error) {
    inPagePending.forEach((entry, reqId) => {
      if (entry.deviceId === deviceId) {
        inPagePending.delete(reqId)
        entry.reject(error)
      }
    })
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
    const frame = buildSendFrame(msgType, reqId, reportId, payload)
    return new Promise((resolve, reject) => {
      inPagePending.set(reqId, {
        deviceId: plane.deviceId,
        resolve: (data) => resolve(mapResolve(data)),
        reject: (e) => {
          if (e && e.blocked) {
            reject(new NativeDOMException('Report is blocked', 'NotAllowedError'))
          } else {
            reject(new NativeDOMException((e && e.message) || e || 'request failed', 'NetworkError'))
          }
        }
      })
      if (!plane.wt.send(frame)) {
        inPagePending.delete(reqId)
        reject(new NativeDOMException('wt not open', 'NetworkError'))
      }
    })
  }

  /** @type {Map<string, Worker>} */
  const mainWorldWorkers = hardenMap(new NativeMap())

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
    if (!(await ttReady)) {
      return { result: { ok: false, error: 'Trusted Types policy unavailable' }, transfer: null }
    }
    const makeUrl = ttFactory || ((s) => s)
    let worker
    try {
      if (payload.mode === 'blob') {
        if (!NativeBlob || !nativeCreateObjectURL) {
          return { result: { ok: false, error: 'Blob URL creation unavailable' }, transfer: null }
        }
        const blobUrl = nativeCreateObjectURL(
          new NativeBlob([payload.bundleText || ''], { type: 'application/javascript' })
        )
        try {
          worker = new NativeWorker(makeUrl(blobUrl))
        } catch (e) {
          nativeRevokeObjectURL(blobUrl)
          throw e
        }
      } else {
        await sendRequest('armShadowSpawn', { url: executionGlobal.location.href }, { timeoutMs: 2000 })
        worker = new NativeWorker(makeUrl(executionGlobal.location.href))
      }
    } catch (e) {
      sendRequest('unarmShadowSpawn', { url: executionGlobal.location.href }, { timeoutMs: 500 })
      return { result: { ok: false, error: stringConstructor(e && e.message) }, transfer: null }
    }
    const previous = mainWorldWorkers.get(payload.deviceId)
    if (previous && previous !== worker) previous.terminate()
    mainWorldWorkers.set(payload.deviceId, worker)
    worker.onerror = (event) => {
      logger.debug('worker error:', event && event.message)
      if (mainWorldWorkers.get(payload.deviceId) === worker) {
        mainWorldWorkers.delete(payload.deviceId)
      }
      sendRequest('unarmShadowSpawn', { url: executionGlobal.location.href }, { timeoutMs: 500 })
      if (bridgePort) {
        callNative(nativeMessagePortPostMessage, bridgePort, {
          type: 'workerError',
          deviceId: payload.deviceId,
          message: (event && event.message) || 'unknown'
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
        if (state.dataPortHandler) {
          callNative(nativeMessagePortRemoveEventListener, state.dataPort,
          'message',
          state.dataPortHandler)
          state.dataPortHandler = null
        }
        callNative(nativeMessagePortClose, state.dataPort)
      } catch (e) {
        logger.debug('close stale dataPort failed', e)
      }
    }
    const dataChannel = new NativeMessageChannel()
    state.dataPort = dataChannel.port1
    state.dataPortHandler = (event) => onDataPortMessage(state, event.data)
    callNative(nativeMessagePortAddEventListener, state.dataPort, 'message', state.dataPortHandler)
    callNative(nativeMessagePortStart, state.dataPort)
    const worker = mainWorldWorkers.get(state.deviceId)
    if (worker) {
      const controlChannel = new NativeMessageChannel()
      callNative(nativeWorkerPostMessage, worker,
      { type: 'setPorts', controlPort: controlChannel.port2, dataPort: dataChannel.port2 },
      [controlChannel.port2, dataChannel.port2])
      callNative(nativeMessagePortPostMessage, bridgePort,
      { id: 0, action: 'dataPort', payload: { deviceId: state.deviceId } },
      [controlChannel.port1])
    } else {
      callNative(nativeMessagePortPostMessage, bridgePort,
      { id: 0, action: 'dataPort', payload: { deviceId: state.deviceId } },
      [dataChannel.port2])
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

  /** @returns {void} */
  function setupTrustedTypesSharing() {
    if (typeof trustedTypes === 'undefined' || trustedTypes === null) return
    if (!nativeCreateTrustedTypePolicy) return
    let captured = false
    let resolveReady
    ttReady = new Promise((resolve) => {
      resolveReady = resolve
    })
    const markCaptured = (policy) => {
      if (captured) return
      captured = true
      const createScriptURL = nativeBind(policy.createScriptURL, policy)
      ttFactory = (url) => createScriptURL(url)
      resolveReady(true)
    }
    const baseRules = {
      createScriptURL: (s) => s,
      createHTML: (s) => s,
      createScript: (s) => s
    }
    const claim = (name) => {
      try {
        return nativeCreateTrustedTypePolicy(name, baseRules)
      } catch {
        return null
      }
    }

    trustedTypes.createPolicy = function (claimedName, pageRules) {
      if (captured) return nativeCreateTrustedTypePolicy(claimedName, pageRules)
      const policy = nativeCreateTrustedTypePolicy(claimedName, baseRules)
      markCaptured(policy)
      return makeWrappedPolicy(policy, claimedName, pageRules)
    }

    const cspRequest = promiseOps.then(sendRequest('getCspInfo'), (info) => {
      if (captured) return
      const names = arrayIsArray(info && info.trustedTypesNames) ? info.trustedTypesNames : []
      const candidates = names.length ? names : ['webhid-worker']
      for (const name of candidates) {
        if (typeof name !== 'string' || name === "'none'" || name === "'allow-duplicates'")
          continue
        const policy = claim(name)
        if (policy) {
          markCaptured(policy)
          installTtSharing(name, policy, nativeCreateTrustedTypePolicy)
          return
        }
      }
      resolveReady(!(info && info.hasTrustedTypesRequire))
    })
    promiseOps.catch(cspRequest, () => resolveReady(true))
  }

  /**
   * @param {object} policy
   * @param {string} name
   * @param {object} [pageRules]
   * @returns {object}
   */
  function makeWrappedPolicy(policy, name, pageRules) {
    const proto = TrustedTypePolicy
      ? types.TrustedTypePolicy.prototype
      : types.Object.prototype
    const wrapperProto = object.create(proto)
    const wrapper = object.create(wrapperProto)
    const rules = pageRules || {}
    const define = (target, prop, value) => {
      object.defineProperty(target, prop, {
        value,
        writable: false,
        enumerable: false,
        configurable: false
      })
    }
    const defineMissing = (method) => {
      define(wrapperProto, method, () => {
        throw new TypeError('TrustedTypePolicy.' + method + ': Function missing.')
      })
    }
    define(wrapper, 'name', name)
    if (
      typeof rules.createScriptURL === 'function' &&
      typeof policy.createScriptURL === 'function'
    ) {
      const pageFn = rules.createScriptURL
      const origScriptURL = nativeBind(policy.createScriptURL, policy)
      define(wrapper, 'createScriptURL', (s) => origScriptURL(pageFn(s)))
    } else {
      defineMissing('createScriptURL')
    }
    for (const m of ['createHTML', 'createScript']) {
      if (typeof rules[m] === 'function' && typeof policy[m] === 'function') {
        const pageFn = rules[m]
        const orig = nativeBind(policy[m], policy)
        define(wrapper, m, (s) => orig(pageFn(s)))
      } else if (typeof rules[m] !== 'function') {
        defineMissing(m)
      }
    }
    return wrapper
  }

  /**
   * @param {string} name
   * @param {object} policy
   * @param {Function} nativeCreateTrustedTypePolicy
   * @returns {void}
   */
  function installTtSharing(name, policy, nativeCreateTrustedTypePolicy) {
    let usedOnce = false
    trustedTypes.createPolicy = function (claimedName, pageRules) {
      if (claimedName === name && !usedOnce) {
        usedOnce = true
        return makeWrappedPolicy(policy, name, pageRules)
      }
      return nativeCreateTrustedTypePolicy(claimedName, pageRules)
    }
    ttFactory = (url) => policy.createScriptURL(url)
  }

  let getOriginalStack
  if (!isWorker) {
    const stackDescriptor = types.Error.getDescriptor('stack')
    getOriginalStack = stackDescriptor && stackDescriptor.get
  }

  /** @returns {boolean} */
  function isCalledFromConsole() {
    if (isWorker) return false
    try {
      throw new NativeError()
    } catch (e) {
      const stack = getOriginalStack ? callNative(getOriginalStack, e) : ''
      if (typeof stack !== 'string') return false
      const lines = stringOps.split(stack, '\n')
      const callerFrame = arrayOps.at(lines, 2) || ''
      return stringOps.includes(callerFrame, 'debugger eval code')
    }
  }

  /** @type {number} */
  let nextReqId = 0
  /** @type {{object}} */
  const pending = {}
  if (!nativeCryptoRandomUUID) {
    throw new NativeError('WebHID polyfill requires crypto.randomUUID (secure context)')
  }
  /** @type {string} */
  const frameNonce = nativeCryptoRandomUUID()

  /** @type {MessagePort|null} */
  let bridgePort = null
  const bridgeReady = isWorker
    ? (() => {
        const ch = new NativeMessageChannel()
        bridgePort = ch.port1
        setupBridgePort()
        if (nativeSelfPostMessage) nativeSelfPostMessage(null, [ch.port2])
        return Promise.resolve()
      })()
    : new Promise((resolve) => {
        const target = windowObject === windowObject.top ? windowObject : windowObject.top
        const onReady = (event) => {
          if (
            !event.data ||
            event.data.type !== 'webhidBridgeReady' ||
            event.source !== target
          )
            return
          callNative(nativeWindowRemoveEventListener, windowObject, 'message', onReady)
          const channel = new NativeMessageChannel()
          bridgePort = channel.port1
          callNative(nativeWindowPostMessage, target, null, '*', [channel.port2])
          setupBridgePort()
          resolve()
        }
        callNative(nativeWindowAddEventListener, windowObject, 'message', onReady)
        callNative(nativeWindowPostMessage, target, { type: 'webhidBridgeRequest' }, '*')
      })
  if (!isWorker) setupTrustedTypesSharing()

  /** @returns {void} */
  function setupBridgePort() {
    if (!bridgePort) return
    callNative(nativeMessagePortAddEventListener, bridgePort, 'message', (event) => {
      if (!event.data) return
      const handler = BRIDGE_MESSAGE_HANDLERS[event.data.type]
      if (handler) handler(event.data)
    })
    callNative(nativeMessagePortStart, bridgePort)
  }

  if (!isWorker) {
    let lifecycleNotified = false
    const notifyFrameDestroyed = () => {
      if (lifecycleNotified || !bridgePort) return
      lifecycleNotified = true
      callNative(nativeMessagePortPostMessage, bridgePort, { type: 'frameDestroyed' })
    }
    callNative(nativeWindowAddEventListener, windowObject, 'pagehide', notifyFrameDestroyed)
    callNative(nativeWindowAddEventListener, windowObject, 'unload', notifyFrameDestroyed)
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleSpawnWorkerMessage(data) {
    promiseOps.then(handleSpawnWorkerRequest(data), (r) => {
      const msg = { type: 'spawnWorkerResponse', id: data.id, result: r.result }
      if (r.transfer) {
        callNative(nativeMessagePortPostMessage, bridgePort, msg, [r.transfer])
      } else {
        callNative(nativeMessagePortPostMessage, bridgePort, msg)
      }
    })
  }

  /**
   * @param {object} data
   * @returns {void}
   */
  function handleResponseMessage(data) {
    const handler = pending[data.id]
    if (handler) {
      delete pending[data.id]
      handler(data.result)
    }
  }

  /** @type {object} */
  const BRIDGE_MESSAGE_HANDLERS = {
    dataPlaneConnect: handleDataPlaneConnect,
    dataPlaneDisconnect: handleDataPlaneDisconnect,
    spawnWorkerRequest: handleSpawnWorkerMessage,
    wireWorkerPort: handleWireWorkerPort,
    response: handleResponseMessage,
    settings: (data) => {
      settings.set(data.settings || {})
    },
    event: (data) => {
      dispatchDeviceEvent(data.event)
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
        timer = nativeSetTimeout(() => {
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
        if (timer) nativeClearTimeout(timer)
        delete pending[id]
        resolve(result)
      }
      const msg = { id, action, payload: payload || {} }
      const transfers = []
      if (payload && payload.data instanceof Uint8Array) {
        transfers.push(payload.data.buffer)
      }
      callNative(nativeMessagePortPostMessage, bridgePort, msg, transfers.length ? transfers : undefined)
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
      const devices = http.isOk(response.s) && arrayIsArray(response.D) ? response.D : []
      deviceInfoCache = hardenMap(new NativeMap())
      for (const device of devices) deviceInfoCache.set(device.deviceId, device)
      return deviceInfoCache
    } catch {
      deviceInfoCache = hardenMap(new NativeMap())
      return deviceInfoCache
    }
  }

  const defs = GLOBAL_DEFAULTS
  const settings = createSettingsStore(defs)

  settings.on('dataPlane', (v) => logger.info('data plane changed: ' + v))
  logger.bindSettings(settings)

  promiseOps.then(bridgeReady, () => {
    promiseOps.then(sendRequest('getSettings', {}), (result) => {
      if (!result) return
      settings.set(result)
      logger.info('data plane: ' + settings.dataPlane)
    })
  })
  /** @returns {{isCrossOrigin: boolean}} */
  function getPolicyContext() {
    if (isWorker) return { isCrossOrigin: false }
    let isCrossOrigin = false
    if (windowObject !== windowObject.top) {
      try {
        windowObject.parent.location.origin
      } catch {
        isCrossOrigin = true
      }
    }
    return { isCrossOrigin }
  }

  /** @returns {Promise<object>} */
  function getPolicy() {
    return sendRequest('getPolicy', getPolicyContext())
  }

  const originalQuery = nativePermissionsQuery
  if (originalQuery && permissionsObject) {
    permissionsObject.query = async (desc) => {
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

  /** @type {WeakMap<object, object>} */
  const devState = hardenWeakMap(new NativeWeakMap())
  /** @type {WeakMap<object, object>} */
  const hidState = hardenWeakMap(new NativeWeakMap())
  /** @type {WeakMap<object, object>} */
  const evtState = hardenWeakMap(new NativeWeakMap())
  /** @type {symbol} */
  const irState = Symbol('webhid_ir')
  /** @type {Map<string, object>} */
  const deviceRegistry = hardenMap(new NativeMap())

  /**
   * Sends a report request over the in-page plane when one is open, else the
   * device's data port, resolving with the daemon ack.
   * @param {object} state
   * @param {object} opts
   * @param {number} opts.inPageType
   * @param {string} opts.portType
   * @param {number} opts.reportId
   * @param {Uint8Array|null} opts.payload
   * @param {(data?: Uint8Array) => unknown} opts.mapResolve
   * @param {string} opts.failMessage
   * @returns {Promise<unknown>}
   */
  function sendDeviceRequest(state, opts) {
    const inPage = inPageRequest(
      inPagePlanes.get(state.deviceId),
      opts.inPageType,
      opts.reportId,
      opts.payload,
      opts.mapResolve
    )
    if (inPage) return inPage
    if (!state.dataPort) throw new NativeError('data port not connected')
    const reqId = ++nextReqId
    const msg = { type: opts.portType, reqId, reportId: opts.reportId }
    const transfers = []
    if (opts.payload) {
      msg.data = opts.payload
      transfers.push(opts.payload.buffer)
    }
    return new Promise((resolve, reject) => {
      state.dataPending = state.dataPending || hardenMap(new NativeMap())
      state.dataPending.set(reqId, {
        resolve: (data) => resolve(opts.mapResolve(data)),
        reject: (e) => {
          if (e && e.blocked) {
            reject(new NativeDOMException('Report is blocked', 'NotAllowedError'))
          } else {
            reject(new NativeDOMException((e && e.message) || e || opts.failMessage, 'NetworkError'))
          }
        }
      })
      callNative(nativeMessagePortPostMessage, state.dataPort,
      msg,
      transfers.length ? transfers : undefined)
    })
  }

  /**
   * @constructor
   * @throws {TypeError}
   */
  function HIDDevice() {
    throw new TypeError('Illegal constructor')
  }
  HIDDevice.prototype = object.create(EventTarget.prototype)
  HIDDevice.prototype.constructor = HIDDevice
  object.defineProperty(HIDDevice.prototype, Symbol.toStringTag, {
    value: 'HIDDevice',
    configurable: true
  })

  object.defineProperties(HIDDevice.prototype, {
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
        if (!state) throw new NativeDOMException('Invalid state', 'InvalidStateError')
        if (state.forgotten)
          throw new NativeDOMException('Device has been forgotten', 'InvalidStateError')
        if (state.opened) throw new NativeDOMException('Device is already open', 'InvalidStateError')
        if (state.opening) throw new NativeDOMException('Device is already open', 'InvalidStateError')
        state.opening = true
        try {
          const response = await sendRequest('open', {
            deviceId: state.deviceId,
            reportSize: state.maxInputReportSize + 3
          })
          if (state.forgotten) {
            promiseOps.catch(sendRequest('close', { deviceId: state.deviceId }), () => {})
            throw new NativeDOMException('Device has been forgotten', 'InvalidStateError')
          }
          if (http.isOk(response.s)) {
            await bridgeReady
            if (state.forgotten) {
              promiseOps.catch(sendRequest('close', { deviceId: state.deviceId }), () => {})
              throw new NativeDOMException('Device has been forgotten', 'InvalidStateError')
            }
            wireDevicePort(state)
            state.opened = true
            logger.info('open deviceId=' + state.deviceId)
            this.dispatchEvent(new NativeEvent('open'))
          } else {
            throw new NativeError('Open failed: ' + http.name(response.s || 0))
          }
        } catch (error) {
          throw error instanceof NativeDOMException
            ? error
            : new NativeDOMException(error.message, 'NetworkError')
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
          throw new NativeDOMException('Device has been forgotten', 'InvalidStateError')
        if (!state.opened) return
        logger.debug('close deviceId=' + state.deviceId)
        try {
          const response = await sendRequest('close', {
            deviceId: state.deviceId
          })
          if (http.isOk(response.s)) {
            state.opened = false
            rejectPendingReports(state, new NativeDOMException('Device closed', 'AbortError'))
            if (state.dataPort) {
              if (state.dataPortHandler) {
                callNative(nativeMessagePortRemoveEventListener, state.dataPort,
                'message',
                state.dataPortHandler)
                state.dataPortHandler = null
              }
              callNative(nativeMessagePortClose, state.dataPort)
              state.dataPort = null
            }
            this.dispatchEvent(new NativeEvent('close'))
          } else {
            throw new NativeError('Failed to close device')
          }
        } catch (error) {
          throw new NativeDOMException(error.message, 'InvalidStateError')
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
        const convertedReportId = convertEnforcedOctet(reportId)
        const state = devState.get(this)
        if (!state) throw new NativeDOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new NativeDOMException('Device is not open', 'InvalidStateError')
        const normalizedReportId = validateReportId(convertedReportId, state.collections)
        const view =
          data instanceof ArrayBuffer
            ? new NativeUint8Array(data)
            : new NativeUint8Array(data.buffer, data.byteOffset, data.byteLength)
        const buffer = uint8Ops.slice(view)
        try {
          logger.debug('sendReport reportId=' + normalizedReportId + ' len=' + buffer.length)
          return sendDeviceRequest(state, {
            inPageType: MSG_SEND_REPORT,
            portType: 'send',
            reportId: normalizedReportId,
            payload: buffer,
            mapResolve: () => undefined,
            failMessage: 'send failed'
          })
        } catch (error) {
          throw new NativeDOMException(error.message, 'NetworkError')
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
        const convertedReportId = convertEnforcedOctet(reportId)
        const state = devState.get(this)
        if (!state) throw new NativeDOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new NativeDOMException('Device is not open', 'InvalidStateError')
        const normalizedReportId = validateReportId(convertedReportId, state.collections)
        try {
          return sendDeviceRequest(state, {
            inPageType: MSG_RECEIVE_FEATURE_REPORT,
            portType: 'receiveFeature',
            reportId: normalizedReportId,
            payload: null,
            mapResolve: (data) => {
              if (!data) return new NativeDataView(new NativeArrayBuffer(0))
              const b = data instanceof Uint8Array ? data : new NativeUint8Array(data)
              return new NativeDataView(b.buffer, b.byteOffset, b.byteLength)
            },
            failMessage: 'receive failed'
          })
        } catch (error) {
          throw new NativeDOMException(error.message, 'NetworkError')
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
        const convertedReportId = convertEnforcedOctet(reportId)
        const state = devState.get(this)
        if (!state) throw new NativeDOMException('Invalid state', 'InvalidStateError')
        if (!state.opened) throw new NativeDOMException('Device is not open', 'InvalidStateError')
        const normalizedReportId = validateReportId(convertedReportId, state.collections)
        const view =
          data instanceof ArrayBuffer
            ? new NativeUint8Array(data)
            : new NativeUint8Array(data.buffer, data.byteOffset, data.byteLength)
        const buffer = uint8Ops.slice(view)
        logger.debug('sendFeatureReport reportId=' + normalizedReportId + ' len=' + buffer.length)
        try {
          return sendDeviceRequest(state, {
            inPageType: MSG_SEND_FEATURE_REPORT,
            portType: 'sendFeature',
            reportId: normalizedReportId,
            payload: buffer,
            mapResolve: () => undefined,
            failMessage: 'send failed'
          })
        } catch (error) {
          throw new NativeDOMException(error.message, 'NetworkError')
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
    const [hashes, cache] = await promiseAll([getPairedDevices(), getDeviceCache()])
    if (!arrayOps.includes(hashes, deviceId)) return null
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
      if (detail.eventType === 'disconnect' && device) {
        const state = devState.get(device)
        reconcileAuthoritativeLifetime(state)
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
          : new NativeDataView(new NativeArrayBuffer(0))
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
    state.dataPending.forEach((entry) => {
      try {
        entry.reject(error)
      } catch (e) {
        logger.debug('reject pending report failed', e)
      }
    })
    state.dataPending.clear()
  }

  /**
   * Reconciles an opened device after an authoritative lifetime loss.
   * @param {object} state
   * @param {{forgotten?: boolean}} [options]
   * @returns {void}
   */
  function reconcileAuthoritativeLifetime(state, { forgotten = false } = {}) {
    if (!state) return
    state.opening = false
    if (forgotten) state.forgotten = true
    state.opened = false
    rejectPendingReports(
      state,
      new NativeDOMException(
        forgotten ? 'Device forgotten' : 'Device disconnected',
        'AbortError'
      )
    )
    if (state.dataPort) {
      if (state.dataPortHandler) {
        callNative(
          nativeMessagePortRemoveEventListener,
          state.dataPort,
          'message',
          state.dataPortHandler
        )
        state.dataPortHandler = null
      }
      callNative(nativeMessagePortClose, state.dataPort)
      state.dataPort = null
    }
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
   * Converts a WebIDL [EnforceRange] octet argument.
   *
   * @param {*} value
   * @returns {number}
   * @throws {TypeError}
   */
  function convertEnforcedOctet(value) {
    let number
    try {
      number = +value
    } catch {
      throw new TypeError('reportId must be a number in the range 0-255')
    }
    if (!nativeNumberIsFinite(number) || number < 0 || number > 255) {
      throw new TypeError('reportId must be a number in the range 0-255')
    }
    return nativeMathTrunc(number) || 0
  }

  /**
   * @param {*} reportId
   * @param {object[]} collections
   * @returns {number}
   * @throws {TypeError}
   */
  function validateReportId(reportId, collections) {
    const usesReportIds = deviceUsesReportIds(collections)
    if (reportId === 0 && usesReportIds) {
      throw new TypeError('reportId must not be 0 for a device that uses report IDs')
    }
    if (reportId !== 0 && !usesReportIds) {
      throw new TypeError('reportId must be 0 for a device that does not use report IDs')
    }
    return reportId
  }

  /**
   * @param {object} device
   * @param {object} state
   * @returns {Promise<void>}
   */
  async function teardownForgottenDevice(device, state) {
    const wasOpened = !!state.opened
    if (wasOpened) {
      try {
        await sendRequest('close', { deviceId: state.deviceId })
      } catch (error) {
        logger.warn(
          'teardownForgottenDevice: close failed:',
          error != null ? (error.message != null ? error.message : error) : error
        )
      }
    }
    reconcileAuthoritativeLifetime(state, { forgotten: true })
    if (wasOpened) device.dispatchEvent(new NativeEvent('close'))
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
  function handleReportResult(state, data) {
    const entry = state.dataPending != null ? state.dataPending.get(data.reqId) : undefined
    if (!entry) return
    state.dataPending.delete(data.reqId)
    if (data.error) entry.reject(new NativeError(data.error))
    else if (data.type === 'featureResult') entry.resolve(data.data)
    else entry.resolve()
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function handleInputReportBatch(state, data) {
    const device = state.self
    if (device && arrayIsArray(data.reports)) {
      for (const r of data.reports) {
        if (r == null) continue
        const dataView = r.data ? new NativeDataView(r.data) : new NativeDataView(new NativeArrayBuffer(0))
        device.dispatchEvent(
          new HIDInputReportEvent('inputreport', {
            device: device,
            reportId: r.reportId,
            data: dataView
          })
        )
      }
    }
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function handleInputReport(state, data) {
    const dataView = data.data ? new NativeDataView(data.data) : new NativeDataView(new NativeArrayBuffer(0))
    const device = state.self
    if (device)
      device.dispatchEvent(
        new HIDInputReportEvent('inputreport', {
          device: device,
          reportId: data.reportId,
          data: dataView
        })
      )
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  function handleDataPortDisconnectEvent(state) {
    deviceInfoCache = null
    reconcileAuthoritativeLifetime(state)
    const device = state.self
    if (device) device.dispatchEvent(new HIDConnectionEvent('disconnect', { device: device }))
  }

  /** @type {object} */
  const DATA_PORT_MESSAGE_HANDLERS = {
    sendResult: handleReportResult,
    featureResult: handleReportResult,
    inputReportBatch: handleInputReportBatch,
    inputReport: handleInputReport,
    disconnect: handleDataPortDisconnectEvent
  }

  /**
   * @param {object} state
   * @param {object} data
   * @returns {void}
   */
  function onDataPortMessage(state, data) {
    if (!data) return
    const handler = DATA_PORT_MESSAGE_HANDLERS[data.type]
    if (handler) handler(state, data)
  }

  /**
   * @param {object} target
   * @returns {object}
   */
  function deepFreeze(target) {
    const propNames = reflect.ownKeys(target)

    for (const name of propNames) {
      const value = target[name]

      if ((value && typeof value === 'object') || typeof value === 'function') {
        deepFreeze(value)
      }
    }

    return object.freeze(target)
  }

  /**
   * @param {import("./types.js").HIDDeviceInfo} deviceInfo
   * @returns {object}
   */
  function createHIDDevice(deviceInfo) {
    const obj = object.create(HIDDevice.prototype)
    const eventTarget = hardenEventTarget(new NativeEventTarget())
    obj.dispatchEvent = (event) => eventTarget.dispatchEvent(event)
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
    const dictionary = init == null ? null : Object(init)
    if (dictionary == null || !('device' in dictionary)) {
      throw new TypeError('HIDInputReportEventInit.device is required')
    }
    if (!('reportId' in dictionary)) {
      throw new TypeError('HIDInputReportEventInit.reportId is required')
    }
    if (!('data' in dictionary)) {
      throw new TypeError('HIDInputReportEventInit.data is required')
    }
    const device = dictionary.device
    const data = dictionary.data
    if (device == null) throw new TypeError('HIDInputReportEventInit.device is required')
    if (data == null) throw new TypeError('HIDInputReportEventInit.data is required')
    const obj = types.Event.construct([type, dictionary], new.target || HIDInputReportEvent)
    obj[irState] = {
      device,
      reportId: convertEnforcedOctet(dictionary.reportId),
      data
    }
    return obj
  }
  HIDInputReportEvent.prototype = object.create(Event.prototype)
  HIDInputReportEvent.prototype.constructor = HIDInputReportEvent
  object.defineProperty(HIDInputReportEvent.prototype, Symbol.toStringTag, {
    value: 'HIDInputReportEvent',
    configurable: true
  })
  object.defineProperties(HIDInputReportEvent.prototype, {
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
    const dictionary = init == null ? null : Object(init)
    if (dictionary == null || !('device' in dictionary)) {
      throw new TypeError('HIDConnectionEventInit.device is required')
    }
    const device = dictionary.device
    if (device == null) throw new TypeError('HIDConnectionEventInit.device is required')
    const obj = types.Event.construct([type, dictionary], new.target || HIDConnectionEvent)
    evtState.set(obj, { device })
    return obj
  }
  HIDConnectionEvent.prototype = object.create(Event.prototype)
  HIDConnectionEvent.prototype.constructor = HIDConnectionEvent
  object.defineProperty(HIDConnectionEvent.prototype, Symbol.toStringTag, {
    value: 'HIDConnectionEvent',
    configurable: true
  })
  object.defineProperty(HIDConnectionEvent.prototype, 'device', {
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
  HID.prototype = object.create(EventTarget.prototype)
  HID.prototype.constructor = HID
  object.defineProperty(HID.prototype, Symbol.toStringTag, {
    value: 'HID',
    configurable: true
  })

  /**
   * Validates and normalizes requestDevice options.
   *
   * @param {*} options
   * @returns {{filters: object[], exclusionFilters: object[]}}
   * @throws {TypeError}
   */
  function normalizeRequestOptions(options) {
    const dictionary = options == null ? null : Object(options)
    if (dictionary == null || !('filters' in dictionary)) {
      throw new TypeError('HIDDeviceRequestOptions.filters is required')
    }
    const toSequence = (value, name) => {
      if (value == null) throw new TypeError(name + ' must be a sequence')
      const values = []
      try {
        for (const item of value) values.push(item)
      } catch {
        throw new TypeError(name + ' must be a sequence')
      }
      return values
    }
    const filters = toSequence(dictionary.filters, 'HIDDeviceRequestOptions.filters')
    for (const filter of filters) {
      if (!isValidFilter(filter)) {
        throw new TypeError('Invalid filter in HIDDeviceRequestOptions.filters')
      }
    }

    let exclusionFilters = []
    if (dictionary.exclusionFilters !== undefined) {
      exclusionFilters = toSequence(
        dictionary.exclusionFilters,
        'HIDDeviceRequestOptions.exclusionFilters'
      )
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
    return { filters, exclusionFilters }
  }

  /**
   * @param {{cancelled: boolean, devices?: Array<object>}} result
   * @returns {Promise<Array<object>>}
   */
  async function grantRequestedDevices(result) {
    if (result.cancelled) return []
    const devices = result.devices
    if (!devices || devices.length === 0) return []
    pairedDevices = null
    deviceInfoCache = null
    return arrayOps.map(devices, (device) => getOrCreateDevice(device))
  }

  /**
   * @param {object} options
   * @param {object[]} options.filters
   * @param {object[]} [options.exclusionFilters]
   * @returns {Promise<object[]>}
   */
  async function requestDeviceImpl(options) {
    const { filters, exclusionFilters } = normalizeRequestOptions(options)

    logger.debug(
      'requestDevice filters=' +
        nativeJsonStringify(filters) +
        ' exclusionFilters=' +
        nativeJsonStringify(exclusionFilters)
    )
    if (isWorker) {
      throw new NativeDOMException('Not allowed in worker context', 'NotSupportedError')
    }
    const policy = await getPolicy()
    if (policy && policy.hid === 'none') {
      throw new NativeDOMException(
        'Access to HID is blocked by Permissions Policy',
        'SecurityError'
      )
    }
    if (
      !isCalledFromConsole() &&
      !settings.allowActivationlessRequestDevice &&
      !hasTransientActivation()
    ) {
      throw new NativeDOMException(
        'Must be handling a user gesture to perform a hid.requestDevice() call.',
        'SecurityError'
      )
    }
    return new Promise((resolve, reject) => {
      const id = frameNonce + ':' + ++nextReqId
      pending[id] = (result) => {
        promiseOps.then(grantRequestedDevices(result), resolve, (e) =>
          reject(new NativeDOMException(e != null ? e.message : 'requestDevice failed', 'NetworkError'))
        )
      }
      callNative(nativeMessagePortPostMessage, bridgePort, {
        id,
        action: 'requestDevice',
        payload: { filters, exclusionFilters }
      })
    })
  }

  object.defineProperties(HID.prototype, {
    getDevices: {
      /** @returns {Promise<object[]>} */
      value: async function () {
        const policy = await getPolicy()
        if (policy && policy.hid === 'none') {
          throw new NativeDOMException('Access to HID is blocked by Permissions Policy', 'SecurityError')
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
       * @param {object} options
       * @param {object[]} options.filters
       * @param {object[]} [options.exclusionFilters]
       * @returns {Promise<object[]>}
       */
      value: requestDeviceImpl,
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
    const obj = object.create(HID.prototype)
    const eventTarget = hardenEventTarget(new NativeEventTarget())
    obj.dispatchEvent = (event) => eventTarget.dispatchEvent(event)
    hidState.set(obj, {
      eventTarget: eventTarget,
      onconnect: null,
      ondisconnect: null
    })
    return obj
  }

  /**
   * Exposes a polyfill global on the current realm (window or worker).
   * @param {string} name
   * @param {object} value
   * @returns {void}
   */
  function defineWebhidGlobal(name, value) {
    object.defineProperty(isWorker ? self : globalThis, name, {
      value,
      writable: false,
      configurable: true,
      enumerable: false
    })
  }

  defineWebhidGlobal('HID', HID)
  defineWebhidGlobal('HIDDevice', HIDDevice)
  defineWebhidGlobal('HIDInputReportEvent', HIDInputReportEvent)
  defineWebhidGlobal('HIDConnectionEvent', HIDConnectionEvent)

  hidInstance = createHID()

  /** @returns {void} */
  function installNavigatorHid() {
    const target = isWorker ? object.getPrototypeOf(executionGlobal.navigator) : Navigator.prototype
    object.defineProperty(target, 'hid', {
      get() {
        return hidInstance
      },
      configurable: true,
      enumerable: true
    })
  }
  installNavigatorHid()

  /**
   * @param {{clientKey: string|null, terminated: boolean, sent: boolean}} state
   * @returns {void}
   */
  function destroyWorkerClient(state) {
    if (state.sent || !state.clientKey) return
    state.sent = true
    sendRequest('workerClientDestroyed', { clientKey: state.clientKey }, { timeoutMs: 500 }).catch(
      () => {}
    )
  }
  /**
   * @param {string|URL} url
   * @param {object} [opts]
   * @returns {Worker}
   */
  function PatchedWorker(url, opts) {
    const instance = new NativeWorker(url, opts)
    const state = { clientKey: null, terminated: false, sent: false }
    object.defineProperty(instance, 'terminate', {
      value: () => {
        state.terminated = true
        destroyWorkerClient(state)
        callNative(nativeWorkerTerminate, instance)
      }
    })
    if (nativeWorkerAddEventListener) {
      callNative(nativeWorkerAddEventListener, instance, 'message', (e) => {
        if (e.data === null && e.ports && e.ports[0]) {
          e.stopImmediatePropagation()
          promiseOps.then(bridgeReady, () => {
            if (!bridgePort) return
            const id = frameNonce + ':' + ++nextReqId
            pending[id] = (result) => {
              if (!result || typeof result.clientKey !== 'string') return
              state.clientKey = result.clientKey
              if (state.terminated) destroyWorkerClient(state)
            }
            callNative(
              nativeMessagePortPostMessage,
              bridgePort,
              { id, action: 'workerPort', payload: {} },
              [e.ports[0]]
            )
          })
        }
      })
    }
    return instance
  }
  if (NativeWorker) {
    PatchedWorker.prototype = NativeWorker.prototype
    reflect.setPrototypeOf(PatchedWorker, NativeWorker)
    globalThis.Worker = PatchedWorker
  }
})()
