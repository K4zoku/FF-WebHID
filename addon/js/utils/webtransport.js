;(function () {
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
     * @param {WebTransportBidirectionalStream} stream
     * @returns {Promise<void>}
     */
    async function handleIncomingStream(stream) {
      if (authTimer) {
        clearTimeout(authTimer)
        authTimer = null
      }
      try {
        const reader = stream.readable.getReader()
        const chunks = []
        let total = 0
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) {
            const view = value instanceof Uint8Array ? value : new Uint8Array(value)
            chunks.push(view)
            total += view.length
          }
        }
        try {
          reader.releaseLock()
        } catch (e) {
          log('debug', 'WT stream releaseLock failed', e)
        }
        if (total === 0) return
        let msg
        if (chunks.length === 1) {
          msg = chunks[0]
        } else {
          msg = new Uint8Array(total)
          let off = 0
          for (const chunk of chunks) {
            msg.set(chunk, off)
            off += chunk.length
          }
        }
        if (opts.onBinary) opts.onBinary(msg)
      } catch (e) {
        log('debug', 'WT stream read error: ' + (e.message || e))
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function readStreams() {
      if (!wt) return
      try {
        const reader = wt.incomingBidirectionalStreams.getReader()
        streamReader = reader
        while (true) {
          const { value: stream, done } = await reader.read()
          if (done) break
          handleIncomingStream(stream)
        }
      } catch (e) {
        log('debug', 'WT incoming streams reader ended: ' + (e.message || e))
      } finally {
        streamReader = null
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
          opts.onReady && opts.onReady()
          readStreams()
        })
        .catch((e) => {
          log('warn', 'WT ready rejected: ' + (e.message || e))
          closedHandled = true
          open = false
          wt = null
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
        if (!wt || !open) return false
        const data = frame instanceof Uint8Array ? frame : new TextEncoder().encode(frame)
        wt
          .createBidirectionalStream()
          .then((stream) => {
            const writer = stream.writable.getWriter()
            return writer.write(data).then(() => writer.close())
          })
          .catch((e) => log('debug', 'WT send failed: ' + (e.message || e)))
        return true
      },
      /** @returns {boolean} */
      isOpen() {
        return open
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
