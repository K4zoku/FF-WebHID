;(function () {
  const webhid = globalThis.webhid
  const pristine = webhid.import('pristine')
  const { types, host } = pristine
  const logger = webhid.import('logger')
  const NativeUint8Array = types.Uint8Array.constructor
  const NativeDataView = types.DataView.constructor
  const NativeTextEncoder = types.TextEncoder ? types.TextEncoder.constructor : null
  const NativeWebTransport = types.WebTransport ? types.WebTransport.constructor : null
  const Uint8Array = NativeUint8Array
  const DataView = NativeDataView
  const TextEncoder = NativeTextEncoder
  const WebTransport = NativeWebTransport
  const u8Ops = types.Uint8Array.proto.methods
  const dataViewOps = types.DataView.proto.methods
  const promiseOps = types.Promise.proto.methods
  const webTransportOps = types.WebTransport ? types.WebTransport.proto.methods : null
  const webTransportGetters = types.WebTransport ? types.WebTransport.proto.getters : null
  const readableStreamOps = types.ReadableStream ? types.ReadableStream.proto.methods : null
  const readerOps = types.ReadableStreamDefaultReader
    ? types.ReadableStreamDefaultReader.proto.methods
    : null
  const writerOps = types.WritableStreamDefaultWriter
    ? types.WritableStreamDefaultWriter.proto.methods
    : null
  const writableStreamOps = types.WritableStream ? types.WritableStream.proto.methods : null
  const setTimeout = host.timers.setTimeout
  const clearTimeout = host.timers.clearTimeout
  const stringOps = types.String.proto.methods
  const nativeParseInt = host.parseInt
  const nativeMathMin = host.mathMin

  /**
   * @param {string} hex
   * @returns {Uint8Array}
   */
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = nativeParseInt(stringOps.substr(hex, i * 2, 2), 16)
    return bytes
  }

  /**
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {Uint8Array}
   */
  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length)
    u8Ops.set(out, a, 0)
    u8Ops.set(out, b, a.length)
    return out
  }

  /**
   * @param {import("../types.js").WsTransportOpts} opts
   * @returns {import("../types.js").WtTransport}
   */
  function createWtTransport(opts) {
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
    /** @type {ReturnType<typeof setTimeout>|null} */
    let reconnectTimer = null
    /** @type {number} */
    let reconnectDelay = 500
    /** @type {boolean} */
    let open = false
    /** @type {boolean} */
    let closedHandled = true
    /** @type {boolean} */
    let failed = false

    /**
     * Marks the transport failed (write/attach error), tears it down, and
     * forces a clean reconnect. The worker's onClosed handler rejects all
     * pending requests, so a send that already reported success cannot
     * leave the page hanging.
     * @param {string} reason
     * @returns {void}
     */
    function failTransport(reason) {
      if (failed || !connectMsg) return
      failed = true
      log('warn', 'WT transport failed: ' + reason)
      if (wt) {
        try {
          webTransportOps.close(wt)
        } catch (e) {
          log('debug', 'WT close after failure failed', e)
        }
        wt = null
      }
      open = false
      streamWriter = null
      streamReader = null
      closedHandled = true
      if (opts.onClosed) opts.onClosed({ willReconnect: true })
      scheduleReconnect()
    }

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
        opts.onClosed && opts.onClosed({ willReconnect: true })
        scheduleReconnect()
      }
    }

    /** @returns {void} */
    function scheduleReconnect() {
      if (!connectMsg || reconnectTimer) return
      log('debug', 'scheduling WT reconnect in ' + reconnectDelay + 'ms')
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        doConnect()
      }, reconnectDelay)
      reconnectDelay = nativeMathMin(reconnectDelay * 2, 5000)
    }

    /**
     * @param {ReadableStream} stream
     * @returns {Promise<void>}
     */
    async function readFrames(stream) {
      try {
        const reader = readableStreamOps.getReader(stream.readable)
        streamReader = reader
        let buf = new Uint8Array(0)
        while (true) {
          const { value, done } = await readerOps.read(reader)
          if (done) break
          if (!value) continue
          buf = concatBytes(buf, value instanceof Uint8Array ? value : new Uint8Array(value))
          while (buf.length >= 4) {
            const dataView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
            const len = dataViewOps.getUint32(dataView, 0, true)
            if (buf.length < 4 + len) break
            const frame = u8Ops.subarray(buf, 4, 4 + len)
            buf = u8Ops.subarray(buf, 4 + len)
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
        const stream = await webTransportOps.createBidirectionalStream(wt)
        if (!wt) return
        if (authTimer) {
          clearTimeout(authTimer)
          authTimer = null
        }
        streamWriter = writableStreamOps.getWriter(stream.writable)
        log('debug', 'WT persistent stream attached')
        readFrames(stream)
        opts.onReady && opts.onReady()
      } catch (e) {
        failTransport('stream attach failed: ' + (e.message || e))
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
      failed = false
      try {
        wt = new WebTransport(url, wtOpts)
      } catch (e) {
        log('error', 'WT constructor threw: ' + (e.message || e))
        wt = null
        closedHandled = true
        opts.onClosed && opts.onClosed()
        return
      }
      const ready = webTransportGetters.ready(wt)
      const readyHandled = promiseOps.then(ready, () => {
        if (!wt) return
        open = true
        reconnectDelay = 500
        log('debug', 'WT connected')
        authTimer = setTimeout(() => {
          authTimer = null
        }, 1000)
        attachStream()
      })
      promiseOps.catch(readyHandled, (e) => {
        log('warn', 'WT ready rejected: ' + (e.message || e))
        closedHandled = true
        open = false
        wt = null
        streamWriter = null
        streamReader = null
        opts.onAuthFailed && opts.onAuthFailed(0)
      })
      const closed = webTransportGetters.closed(wt)
      promiseOps.catch(
        promiseOps.then(closed, (info) => handleClosed(info && info.reason)),
        (e) => handleClosed(e && e.message)
      )
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
        dataViewOps.setUint32(new DataView(header.buffer), 0, data.length, true)
        const onWriteError = (e) =>
          failTransport('send failed: ' + (e && e.message ? e.message : e))
        promiseOps.catch(writerOps.write(streamWriter, header), onWriteError)
        promiseOps.catch(writerOps.write(streamWriter, data), onWriteError)
        return true
      },
      /** @returns {boolean} */
      isOpen() {
        return open && streamWriter != null
      },
      /** @returns {void} */
      disconnect() {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        if (streamReader) {
          try {
            readerOps.cancel(streamReader)
          } catch (e) {
            log('debug', 'WT stream reader cancel failed', e)
          }
          streamReader = null
        }
        if (streamWriter) {
          try {
            writerOps.close(streamWriter)
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
          webTransportOps.close(wt)
          wt = null
        }
        open = false
        closedHandled = true
        failed = true
        connectMsg = null
        log('debug', 'disconnected by caller')
      }
    }
  }

  webhid.export('createWtTransport', createWtTransport)
})()
