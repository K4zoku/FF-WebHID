// Control plane worker — owns WS control connection for enumerate/close.
// Communicates with bridge via MessageChannel port.
'use strict';
const { logger } = self.__webhid;
let ws = null, _port = null, _connectMsg = null;
let _reconnectTimer = null, _reconnectDelay = 500;

self.onmessage = ({ data: msg, ports }) => {
  if (msg.type === 'connect') {
    _connectMsg = msg;
    if (msg.logLevel !== undefined) logger.applyLevel(msg.logLevel);
    if (ports && ports[0]) {
      _port = ports[0];
      _port.onmessage = ({ data: pmsg }) => {
        if (pmsg.type === 'command') {
          _sendCommand(pmsg.id, pmsg.action, pmsg.payload);
        } else if (pmsg.type === 'settings') {
          if (pmsg.logLevel !== undefined) logger.applyLevel(pmsg.logLevel);
        } else if (pmsg.type === 'disconnect') {
          if (ws) { ws.onclose = null; ws.close(); ws = null; }
          _connectMsg = null;
          if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
          logger.debug('[control] disconnected by bridge');
        }
      };
    }
    _doConnect();
    return;
  }
  // Fallback for messages sent via worker.postMessage (not port)
  if (msg.type === 'settings') {
    if (msg.logLevel !== undefined) logger.applyLevel(msg.logLevel);
    return;
  }
};

function _doConnect() {
  if (!_connectMsg) return;
  logger.debug('[control] WS connecting to ws://127.0.0.1:' + _connectMsg.wsPort);
  try {
    ws = new WebSocket('ws://127.0.0.1:' + _connectMsg.wsPort, ['webhid.' + _connectMsg.token]);
  } catch (e) {
    logger.error('[control] WS constructor threw:', e.message || e);
    _scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    _reconnectDelay = 500;
    logger.debug('[control] WS connected');
    if (_port) _port.postMessage({ type: 'ready' });
  };
  ws.onerror = (e) => logger.error('[control] WS ERROR:', e.message || e);
  ws.onclose = () => {
    logger.debug('[control] WS closed');
    ws = null;
    if (_port) _port.postMessage({ type: 'closed' });
    _scheduleReconnect();
  };
  ws.onmessage = ({ data }) => {
    if (typeof data !== 'string') return;
    try {
      const msg = JSON.parse(data);
      if (_port) _port.postMessage({ type: 'response', id: msg.id, result: msg });
    } catch {}
  };
}

function _scheduleReconnect() {
  if (!_connectMsg) return;
  if (_reconnectTimer) return;
  logger.debug('[control] scheduling reconnect in ' + _reconnectDelay + 'ms');
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _doConnect();
  }, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, 5000);
}

function _sendCommand(id, action, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (_port) _port.postMessage({ type: 'response', id, result: { ok: false, err: 'ws not open' } });
    return;
  }
  ws.send(JSON.stringify({ id, action, ...(payload || {}) }));
}
