// Shared WebSocket transport for worker.js and control.js.
// Provides connect/reconnect/backoff/auth-failure-handling logic so both
// workers don't duplicate ~50 lines of boilerplate.
//
// Usage:
//   const transport = __webhid.createWsTransport({
//     tag: 'worker',                  // for log prefix
//     onReady: () => {...},           // WS connected
//     onClosed: () => {...},          // WS closed (non-auth, will reconnect)
//     onAuthFailed: (code) => {...},  // WS closed with 4401/4402
//     onBinary: (frame) => {...},     // binary frame received
//     onText: (text) => {...},        // text frame received
//   });
//   transport.connect({ wsPort, token, logLevel });
//   transport.send(frame);            // Uint8Array or string
//   transport.isOpen();               // readyState === OPEN
//   transport.disconnect();           // halt + close

(function () {
  const WS_CLOSE_UNKNOWN_TOKEN = 4401;
  const WS_CLOSE_BAD_TOKEN = 4402;

  function createWsTransport(opts) {
    const tag = opts.tag || 'ws';
    const log = (level, msg) => __webhid.logger[level](msg);
    let ws = null;
    let connectMsg = null;
    let reconnectTimer = null;
    let reconnectDelay = 500;

    function _doConnect() {
      if (!connectMsg) return;
      log('debug', 'WS connecting to ws://127.0.0.1:' + connectMsg.wsPort);
      try {
        ws = new WebSocket('ws://127.0.0.1:' + connectMsg.wsPort, ['webhid.' + connectMsg.token]);
      } catch (e) {
        log('error', 'WS constructor threw: ' + (e.message || e));
        _scheduleReconnect();
        return;
      }
      if (opts.onBinary) ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        reconnectDelay = 500;
        log('debug', 'WS connected');
        opts.onReady && opts.onReady();
      };
      ws.onerror = (e) => log('error', 'WS ERROR: ' + (e.message || e));
      ws.onclose = (ev) => {
        ws = null;
        log('debug', 'WS closed code=' + ev.code);
        if (ev.code === WS_CLOSE_UNKNOWN_TOKEN || ev.code === WS_CLOSE_BAD_TOKEN) {
          log('warn', 'WS closed with auth-failure code ' + ev.code + '; requesting token refresh');
          connectMsg = null;
          opts.onAuthFailed && opts.onAuthFailed(ev.code);
          return;
        }
        opts.onClosed && opts.onClosed();
        _scheduleReconnect();
      };
      ws.onmessage = ({ data }) => {
        if (typeof data === 'string') {
          opts.onText && opts.onText(data);
        } else {
          opts.onBinary && opts.onBinary(new Uint8Array(data));
        }
      };
    }

    function _scheduleReconnect() {
      if (!connectMsg || reconnectTimer) return;
      log('debug', 'scheduling reconnect in ' + reconnectDelay + 'ms');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        _doConnect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    }

    return {
      connect(msg) {
        connectMsg = msg;
        if (msg.logLevel !== undefined) __webhid.logger.applyLevel(msg.logLevel);
        _doConnect();
      },
      send(frame) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(frame);
        return true;
      },
      isOpen() {
        return ws && ws.readyState === WebSocket.OPEN;
      },
      disconnect() {
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
        connectMsg = null;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        log('debug', 'disconnected by caller');
      },
    };
  }

  globalThis.__webhid = globalThis.__webhid || {};
  globalThis.__webhid.createWsTransport = createWsTransport;
  globalThis.__webhid.WS_CLOSE_UNKNOWN_TOKEN = WS_CLOSE_UNKNOWN_TOKEN;
  globalThis.__webhid.WS_CLOSE_BAD_TOKEN = WS_CLOSE_BAD_TOKEN;
})();
