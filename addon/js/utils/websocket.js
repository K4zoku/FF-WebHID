// Shared WebSocket transport for worker.js and control.js.
// Provides connect/reconnect/backoff/auth-failure-handling logic so both
// workers don't duplicate ~50 lines of boilerplate.
//
// Usage:
//   const transport = __webhid.import('createWsTransport')({
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
  const webhid = globalThis.webhid;
  const WS_CLOSE_UNKNOWN_TOKEN = 4401;
  const WS_CLOSE_BAD_TOKEN = 4402;
  const logger = webhid.import("logger");

  function createWsTransport(opts) {
    const tag = opts.tag || "ws";
    const log = (level, msg) => logger[level](msg);
    let ws = null;
    let connectMsg = null;
    let reconnectTimer = null;
    let reconnectDelay = 500;

    function doConnect() {
      if (!connectMsg) return;
      log("debug", "WS connecting to ws://127.0.0.1:" + connectMsg.wsPort);
      try {
        ws = new WebSocket("ws://127.0.0.1:" + connectMsg.wsPort, [
          "webhid." + connectMsg.token,
        ]);
      } catch (e) {
        log("error", "WS constructor threw: " + (e.message || e));
        scheduleReconnect();
        return;
      }
      if (opts.onBinary) ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        reconnectDelay = 500;
        log("debug", "WS connected");
        opts.onReady && opts.onReady();
      };
      ws.onerror = (e) => log("error", "WS ERROR: " + (e.message || e));
      ws.onclose = (event) => {
        ws = null;
        log("debug", "WS closed code=" + event.code);
        if (
          event.code === WS_CLOSE_UNKNOWN_TOKEN ||
          event.code === WS_CLOSE_BAD_TOKEN
        ) {
          log(
            "warn",
            "WS closed with auth-failure code " +
              event.code +
              "; requesting token refresh",
          );
          connectMsg = null;
          opts.onAuthFailed && opts.onAuthFailed(event.code);
          return;
        }
        opts.onClosed && opts.onClosed();
        scheduleReconnect();
      };
      ws.onmessage = ({ data }) => {
        if (typeof data === "string") {
          opts.onText && opts.onText(data);
        } else {
          opts.onBinary && opts.onBinary(new Uint8Array(data));
        }
      };
    }

    function scheduleReconnect() {
      if (!connectMsg || reconnectTimer) return;
      log("debug", "scheduling reconnect in " + reconnectDelay + "ms");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        doConnect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    }

    return {
      connect(msg) {
        connectMsg = msg;
        if (msg.logLevel !== undefined)
          logger.applyLevel(msg.logLevel);
        doConnect();
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
        if (ws) {
          ws.onclose = null;
          ws.close();
          ws = null;
        }
        connectMsg = null;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        log("debug", "disconnected by caller");
      },
    };
  }


  webhid.export("createWsTransport", createWsTransport);
})();
