"use strict";
const { logger } = self.__webhid;
self.__webhid.logger.initLogger("control");
const settings = self.__webhid.createSettingsStore(self.__webhid.GLOBAL_DEFAULTS);
settings.on("logLevel", (v) => logger.applyLevel(v));
let _port = null;
let _transport = null;

self.onmessage = ({ data: msg, ports }) => {
  if (msg.type === "connect") {
    if (ports && ports[0]) {
      _port = ports[0];
      _port.onmessage = ({ data: pmsg }) => {
        if (pmsg.type === "command") {
          _sendCommand(pmsg.id, pmsg.action, pmsg.payload);
        } else if (pmsg.type === "settings") {
          settings.set(pmsg);
        } else if (pmsg.type === "disconnect") {
          if (_transport) _transport.disconnect();
        }
      };
    }
    _transport = self.__webhid.createWsTransport({
      tag: "control",
      onReady: () => {
        if (_port) _port.postMessage({ type: "ready" });
      },
      onClosed: () => {
        if (_port) _port.postMessage({ type: "closed" });
      },
      onAuthFailed: (code) => {
        if (_port) _port.postMessage({ type: "auth-failed", code });
      },
      onText: (text) => {
        try {
          const m = JSON.parse(text);
          if (_port)
            _port.postMessage({ type: "response", id: m.n, result: m });
        } catch (e) {
          logger.error("failed to parse WS text frame: " + e.message);
          if (_port)
            _port.postMessage({ type: "response", id: 0, result: { s: 500 } });
        }
      },
    });
    _transport.connect(msg);
    return;
  }
  if (msg.type === "settings") {
    settings.set(msg);
    return;
  }
};

function _sendCommand(id, action, payload) {
  if (!_transport || !_transport.isOpen()) {
    if (_port) _port.postMessage({ type: "response", id, result: { s: 503 } });
    return;
  }
  _transport.send(JSON.stringify({ n: id, action, ...(payload || {}) }));
}
