(function () {
  const webhid = globalThis.webhid
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import('logger')

  /**
   * @param {string} hex
   * @returns {Uint8Array}
   */
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return bytes
  }

  /**
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {Uint8Array}
   */
  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  /**
   * @param {import("../types.js").WsTransportOpts} opts
   * @returns {import("../types.js").WtTransport}
   */
  function createWtTransport(opts) {
    const _tag = opts.tag || 'wt'
    const log = (level, msg) => logger[level](msg)
    /** @type {WebTransport|null} */
    let wt = null
    /** @type {{wtPort: number, wtCertHash?: string, token: string, logLevel?: number}|null} */
    let connectMsg = null
    /** @type {WritableStreamDefaultWriter|null} */
    let streamWriter = null
    /** @type {ReadableStreamDefaultReader|null} */
    let streamReader = null
    /** @type {ReturnType<typeof setTimeout>|null} */
    let authTimer = null
    /** @type {boolean} */
    let open = false
    /** @type {boolean} */
    let closedHandled = true

    /**
     * @param {string|undefined} reason
     * @returns {void}
     */
    function handleClosed(reason) {
      if (closedHandled || !wt) return
      closedHandled = true
      const authPending = authTimer !== null
      if (authTimer) {
        clearTimeout(authTimer)
        authTimer = null
      }
      const wasReady = open
      open = false
      wt = null
      streamWriter = null
      streamReader = null
      if (!wasReady || authPending) {
        log(
          'warn',
          'WT closed before any stream (reason=' + (reason || 'unknown') + '); auth-failed'
        )
        opts.onAuthFailed && opts.onAuthFailed(0)
      } else {
        log('debug', 'WT closed (reason=' + (reason || 'unknown') + ')')
        opts.onClosed && opts.onClosed()
      }
    }

    /**
     * @param {ReadableStream} stream
     * @returns {Promise<void>}
     */
    async function readFrames(stream) {
      try {
        const reader = stream.readable.getReader()
        streamReader = reader
        let buf = new Uint8Array(0)
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          buf = concatBytes(buf, value instanceof Uint8Array ? value : new Uint8Array(value))
          while (buf.length >= 4) {
            const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
            const len = dataView.getUint32(0, true)
            if (buf.length < 4 + len) break
            const frame = buf.subarray(4, 4 + len)
            buf = buf.subarray(4 + len)
            if (opts.onBinary) opts.onBinary(frame)
          }
        }
      } catch (e) {
        log('debug', 'WT stream read error: ' + (e.message || e))
      } finally {
        streamReader = null
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function attachStream() {
      if (!wt) return
      try {
        const stream = await wt.createBidirectionalStream()
        if (!wt) return
        if (authTimer) {
          clearTimeout(authTimer)
          authTimer = null
        }
        streamWriter = stream.writable.getWriter()
        log('debug', 'WT persistent stream attached')
        readFrames(stream)
        opts.onReady && opts.onReady()
      } catch (e) {
        log('warn', 'WT stream attach failed: ' + (e.message || e))
      }
    }

    /** @returns {void} */
    function doConnect() {
      if (!connectMsg) return
      const url = 'https://127.0.0.1:' + connectMsg.wtPort + '/' + connectMsg.token
      log('debug', 'WT connecting to ' + url)
      const wtOpts = {}
      if (connectMsg.wtCertHash) {
        wtOpts.serverCertificateHashes = [
          { algorithm: 'sha-256', value: hexToBytes(connectMsg.wtCertHash) }
        ]
      }
      closedHandled = false
      try {
        wt = new WebTransport(url, wtOpts)
      } catch (e) {
        log('error', 'WT constructor threw: ' + (e.message || e))
        wt = null
        closedHandled = true
        opts.onClosed && opts.onClosed()
        return
      }
      wt.ready
        .then(() => {
          if (!wt) return
          open = true
          log('debug', 'WT connected')
          authTimer = setTimeout(() => {
            authTimer = null
          }, 1000)
          attachStream()
        })
        .catch((e) => {
          log('warn', 'WT ready rejected: ' + (e.message || e))
          closedHandled = true
          open = false
          wt = null
          streamWriter = null
          streamReader = null
          opts.onAuthFailed && opts.onAuthFailed(0)
        })
      wt.closed.then((info) => handleClosed(info && info.reason)).catch((e) => handleClosed(e && e.message))
    }

    return {
      /**
       * @param {{wtPort: number, wtCertHash?: string, token: string, logLevel?: number}} msg
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
        if (!wt || !open || !streamWriter) return false
        const data = frame instanceof Uint8Array ? frame : new TextEncoder().encode(frame)
        const header = new Uint8Array(4)
        new DataView(header.buffer).setUint32(0, data.length, true)
        streamWriter.write(header).catch((e) => log('debug', 'WT send failed: ' + (e.message || e)))
        streamWriter.write(data).catch((e) => log('debug', 'WT send failed: ' + (e.message || e)))
        return true
      },
      /** @returns {boolean} */
      isOpen() {
        return open && streamWriter != null
      },
      /** @returns {void} */
      disconnect() {
        if (streamReader) {
          try {
            streamReader.cancel()
          } catch (e) {
            log('debug', 'WT stream reader cancel failed', e)
          }
          streamReader = null
        }
        if (streamWriter) {
          try {
            streamWriter.close()
          } catch (e) {
            log('debug', 'WT stream writer close failed', e)
          }
          streamWriter = null
        }
        if (authTimer) {
          clearTimeout(authTimer)
          authTimer = null
        }
        if (wt) {
          wt.close()
          wt = null
        }
        open = false
        closedHandled = true
        connectMsg = null
        log('debug', 'disconnected by caller')
      }
    }
  }

  webhid.export('createWtTransport', createWtTransport)
})()
