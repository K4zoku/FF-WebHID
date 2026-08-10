;(function () {
  const webhid = globalThis.webhid
  const WS_CLOSE_UNKNOWN_TOKEN = 4401
  const WS_CLOSE_BAD_TOKEN = 4402
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')

  /**
   * @param {import("../types.js").WsTransportOpts} opts
   * @returns {import("../types.js").WsTransport}
   */
  function createWsTransport(opts) {
    const _tag = opts.tag || 'ws'
    const log = (level, msg) => logger[level](msg)
    /** @type {WebSocket|null} */
    let ws = null
    /** @type {{wsPort: number, token: string, logLevel?: number}|null} */
    let connectMsg = null
    /** @type {ReturnType<typeof setTimeout>|null} */
    let reconnectTimer = null
    /** @type {number} */
    let reconnectDelay = 500

    /** @returns {void} */
    function doConnect() {
      if (!connectMsg) return
      log('debug', 'WS connecting to ws://127.0.0.1:' + connectMsg.wsPort)
      try {
        ws = new WebSocket('ws://127.0.0.1:' + connectMsg.wsPort, ['webhid.' + connectMsg.token])
      } catch (e) {
        log('error', 'WS constructor threw: ' + (e.message || e))
        scheduleReconnect()
        return
      }
      if (opts.onBinary) ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        reconnectDelay = 500
        log('debug', 'WS connected')
        opts.onReady && opts.onReady()
      }
      ws.onerror = (e) => log('error', 'WS ERROR: ' + (e.message || e))
      ws.onclose = (event) => {
        ws = null
        log('debug', 'WS closed code=' + event.code)
        if (event.code === WS_CLOSE_UNKNOWN_TOKEN || event.code === WS_CLOSE_BAD_TOKEN) {
          log(
            'warn',
            'WS closed with auth-failure code ' + event.code + '; requesting token refresh'
          )
          connectMsg = null
          opts.onAuthFailed && opts.onAuthFailed(event.code)
          return
        }
        opts.onClosed && opts.onClosed()
        scheduleReconnect()
      }
      ws.onmessage = ({ data }) => {
        if (typeof data === 'string') {
          opts.onText && opts.onText(data)
        } else {
          opts.onBinary && opts.onBinary(new Uint8Array(data))
        }
      }
    }

    /** @returns {void} */
    function scheduleReconnect() {
      if (!connectMsg || reconnectTimer) return
      log('debug', 'scheduling reconnect in ' + reconnectDelay + 'ms')
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        doConnect()
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 5000)
    }

    return {
      /**
       * @param {{wsPort: number, token: string, logLevel?: number}} msg
       * @returns {void}
       */
      connect(msg) {
        connectMsg = msg
        if (msg.logLevel !== undefined) logger.applyLevel(msg.logLevel)
        doConnect()
      },
      /**
       * @param {Uint8Array | string} frame
       * @returns {boolean}
       */
      send(frame) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false
        ws.send(frame)
        return true
      },
      /** @returns {boolean} */
      isOpen() {
        return ws && ws.readyState === WebSocket.OPEN
      },
      /** @returns {void} */
      disconnect() {
        if (ws) {
          ws.onclose = null
          ws.close()
          ws = null
        }
        connectMsg = null
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        log('debug', 'disconnected by caller')
      }
    }
  }

  webhid.export('createWsTransport', createWsTransport)
})()
