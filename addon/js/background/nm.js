;(function () {
  const logger = webhid.import('logger')
  const decodeCollectionsTlv = webhid.import('decodeCollectionsTlv')
  const {
    ACT,
    PKG_INPUT_REPORT,
    PKG_SEND_REPORT,
    PKG_SEND_FEATURE_REPORT,
    EVT_CONNECT,
    EVT_DISCONNECT,
    buildPackedSend
  } = webhid.import('bgPacked')
  const {
    deviceTabMap: _deviceTabMap,
    deviceCache,
    pendingPicker: _pendingPicker
  } = webhid.import('bgState')
  const { saveDeviceInfo } = webhid.import('bgStorage')
  const { tabsForEvent, _registerDeviceTab, _unregisterDeviceTab, broadcastGlobalReset } =
    webhid.import('bgStateOps')
  const http = webhid.import('http')

  const NM_HOST_FORWARDER = 'webhid.forwarder_nm_host'
  const NM_HOST_DAEMON = 'webhid.daemon_nm_host'

  /**
   * Returns the list of tab IDs authorized for the device in the given control event.
   * @param {object} message
   * @returns {number[]|null}
   */
  function tabsForEventLocal(message) {
    return tabsForEvent(message)
  }

  const NativeMessaging = {
    port: null,
    nextId: 1,
    pending: new Map(),
    reconnectTimer: null,
    reconnectDelay: 1000,
    nmHostName: 'webhid.forwarder_nm_host',
    lastError: null,

    /**
     * @param {object} message
     * @returns {boolean}
     */
    tryHostError(message) {
      if (message.E === undefined || message.s === undefined || message.n !== undefined) {
        return false
      }
      logger.error('host error: ' + message.E)
      this.lastError = String(message.E)
      for (const [, p] of this.pending) p.resolve(message)
      this.pending.clear()
      return true
    },

    /**
     * @param {object} message
     * @returns {boolean}
     */
    tryPackedData(message) {
      if (message.d === undefined || message.n !== undefined || message.e !== undefined) {
        return false
      }
      this.onPackedData(message.d)
      return true
    },

    /**
     * @param {object} message
     * @returns {boolean}
     */
    tryControlEvent(message) {
      if (message.e === undefined) return false
      this.onControlEvent(message)
      return true
    },

    /**
     * @param {object} message
     * @returns {boolean}
     */
    tryPendingResponse(message) {
      if (message.n === undefined) return false
      const p = this.pending.get(message.n)
      if (!p) return false
      this.pending.delete(message.n)
      p.resolve(message)
      return true
    },

    /**
     * @param {object} message
     * @returns {boolean}
     */
    tryUnmatchedDaemonError(message) {
      if (message.s === undefined || message.n !== undefined || message.E !== undefined) {
        return false
      }
      logger.warn('daemon error (no req id): status=' + message.s)
      return true
    },

    /**
     * Routes one native message to its handler.
     * @param {object} message
     * @returns {void}
     */
    handleNativeMessage(message) {
      if (this.tryHostError(message)) return
      if (this.tryPackedData(message)) return
      if (this.tryControlEvent(message)) return
      if (this.tryPendingResponse(message)) return
      if (this.tryUnmatchedDaemonError(message)) return
      logger.warn('unmatched:', message)
    },

    connect() {
      if (this.port) return Promise.resolve()
      logger.debug('connecting to ' + this.nmHostName + '...')
      try {
        this.port = browser.runtime.connectNative(this.nmHostName)
        this.reconnectDelay = 1000
        this.lastError = null
        logger.debug('connected')

        this.port.onMessage.addListener((message) => {
          this.handleNativeMessage(message)
        })

        this.port.onDisconnect.addListener(() => {
          logger.warn(
            'disconnected; will retry in ' +
              this.reconnectDelay +
              'ms. ' +
              'If persistent: check daemon status (systemctl status webhid-daemon), ' +
              'group membership (groups), and NM host manifest.'
          )
          this.port = null
          for (const [, p] of this.pending) p.resolve({ s: 503 })
          this.pending.clear()
          broadcastGlobalReset()
          this.scheduleReconnect()
        })

        return Promise.resolve()
      } catch (error) {
        logger.error('connect failed:', error)
        this.scheduleReconnect()
        return Promise.reject(error)
      }
    },

    reconnectWithNewHost() {
      if (this.port) {
        try {
          this.port.disconnect()
        } catch (e) {
          logger.debug('port disconnect failed', e)
        }
        this.port = null
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.reconnectDelay = 1000
      this.connect().catch((e) => logger.debug('speculative reconnect failed', e))
    },

    scheduleReconnect() {
      if (this.reconnectTimer) return
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        logger.debug('reconnecting...')
        this.connect().catch((e) => logger.debug('speculative reconnect failed', e))
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000)
    },

    sendRequest(request) {
      return new Promise((resolve, reject) => {
        if (!this.port) {
          this.connect().catch((e) => logger.debug('speculative reconnect failed', e))
          reject(new Error('NM disconnected, reconnecting; please retry'))
          return
        }
        const id = this.nextId++
        this.pending.set(id, { resolve, reject })
        logger.debug('sendRequest a=' + (request.a || 'packed') + ' n=' + id)
        try {
          this.port.postMessage({ ...request, n: id })
        } catch (e) {
          this.pending.delete(id)
          reject(e)
        }
      })
    },

    sendPacked(buildPackedFn) {
      return new Promise((resolve, reject) => {
        if (!this.port) {
          this.connect().catch((e) => logger.debug('speculative reconnect failed', e))
          reject(new Error('NM disconnected, reconnecting; please retry'))
          return
        }
        const id = this.nextId++
        this.pending.set(id, { resolve, reject })
        const packedBuf = buildPackedFn(id)
        logger.debug('sendPacked msgType=0x' + packedBuf[0].toString(16) + ' n=' + id)
        try {
          this.port.postMessage({ d: packedBuf.toBase64() })
        } catch (e) {
          this.pending.delete(id)
          reject(e)
        }
      })
    },

    async enumerateDevices() {
      return await this.sendRequest({ a: ACT.enum })
    },
    async openDevice(deviceId) {
      return await this.sendRequest({ a: ACT.open, i: deviceId })
    },
    async closeDevice(deviceId, sessionToken) {
      const req = { a: ACT.close, i: deviceId }
      if (sessionToken) req.T = sessionToken
      return await this.sendRequest(req)
    },
    async handshake() {
      return await this.sendRequest({ a: ACT.hs })
    },
    async sendReport(deviceId, reportId, data) {
      return await this.sendPacked((reqId) =>
        buildPackedSend(PKG_SEND_REPORT, reqId, deviceId, reportId, data)
      )
    },
    async receiveFeatureReport(deviceId, reportId) {
      const resp = await this.sendRequest({
        a: ACT.rfr,
        i: deviceId,
        r: reportId
      })
      if (resp && typeof resp.d === 'string') resp.d = Uint8Array.fromBase64(resp.d)
      return resp
    },
    async sendFeatureReport(deviceId, reportId, data) {
      return await this.sendPacked((reqId) =>
        buildPackedSend(PKG_SEND_FEATURE_REPORT, reqId, deviceId, reportId, data)
      )
    },

    onPackedData(b64) {
      let bin
      try {
        bin = Uint8Array.fromBase64(b64)
      } catch (e) {
        logger.warn('onPackedData: bad base64 frame dropped:', e.message)
        return
      }
      try {
        if (bin.length < 8 || bin[0] !== PKG_INPUT_REPORT) return
        const deviceId = (bin[1] | (bin[2] << 8) | (bin[3] << 16) | (bin[4] << 24)) >>> 0
        const targets = tabsForEventLocal({ i: deviceId })
        if (!targets) return
        let offset = 5
        while (offset + 3 <= bin.length) {
          const reportId = bin[offset]
          const payloadLen = bin[offset + 1] | (bin[offset + 2] << 8)
          offset += 3
          if (offset + payloadLen > bin.length) break
          const payload = new Uint8Array(payloadLen)
          if (payloadLen > 0) payload.set(bin.subarray(offset, offset + payloadLen))
          offset += payloadLen
          const event = {
            eventType: 'input_report',
            deviceId,
            reportId,
            data: payload
          }
          for (const tabId of targets) {
            browser.tabs
              .sendMessage(tabId, { action: 'webhidDeviceEvent', event })
              .catch((e) => logger.debug('event forward to tab failed', e))
          }
        }
      } catch (e) {
        logger.warn('onPackedData: malformed frame dropped:', e.message)
      }
    },

    handleDeviceConnectionEvent(message) {
      if (message.v) {
        if (message.e === EVT_CONNECT) {
          if (!deviceCache.some((d) => d.deviceId === message.v.deviceId)) {
            const dev = message.v
            if (dev && typeof dev.collections === 'string') {
              try {
                dev.collections = decodeCollectionsTlv(dev.collections)
              } catch {
                dev.collections = []
              }
            }
            deviceCache.push(dev)
          }
          saveDeviceInfo(message.v)
        } else {
          const idx = deviceCache.findIndex((d) => d.deviceId === message.i)
          if (idx >= 0) deviceCache.splice(idx, 1)
        }
      } else {
        this.enumerateDevices()
          .then((resp) => {
            if (http.isOk(resp.s) && resp.D) ((deviceCache.length = 0), deviceCache.push(...resp.D))
          })
          .catch((e) => logger.debug('enumerateDevices failed', e))
      }
      const normalized = {
        eventType: message.e === EVT_CONNECT ? 'connect' : 'disconnect',
        deviceId: message.i,
        device: message.v || null
      }
      browser.runtime
        .sendMessage({ action: 'webhidDeviceEvent', event: normalized })
        .catch((e) => logger.debug('event forward to runtime failed', e))
      browser.tabs
        .query({})
        .then((tabs) => {
          for (const tab of tabs) {
            if (!tab.url) continue
            try {
              new URL(tab.url)
            } catch {
              continue
            }
            browser.tabs
              .sendMessage(tab.id, {
                action: 'webhidDeviceEvent',
                event: normalized
              })
              .catch((e) => logger.debug('event forward to all tabs failed', e))
          }
        })
        .catch((e) => logger.debug('tabs.query failed', e))
    },

    onControlEvent(message) {
      if (message.e === undefined) return
      if (message.e === EVT_CONNECT || message.e === EVT_DISCONNECT) {
        this.handleDeviceConnectionEvent(message)
        return
      }
      const targets = tabsForEventLocal(message)
      if (targets) {
        for (const tabId of targets) {
          browser.tabs
            .sendMessage(tabId, { action: 'webhidDeviceEvent', event: message })
            .catch((e) => logger.debug('event forward to target tab failed', e))
        }
      }
    }
  }

  webhid.export('NativeMessaging', NativeMessaging)
  webhid.export('NM_HOST_NAMES', { NM_HOST_FORWARDER, NM_HOST_DAEMON })
})()
