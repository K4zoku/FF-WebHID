const TEST_WS_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const WS_URL = 'ws://127.0.0.1:31337';

export function generateMockBridgeScript(): string {
  return `
(function() {
  try {
    Object.defineProperty(Navigator.prototype, 'userActivation', {
      get: function() { return { isActive: true, hasBeenActive: true }; },
      configurable: true,
    });
  } catch(e) {}

  var _ws = null;
  var _wsConnected = false;
  var _wsQueue = [];
  var _reqId = 0;
  var _pending = {};

  function wsConnect() {
    if (_ws && _ws.readyState === 1) return;
    if (_ws && _ws.readyState === 0) return;
    try {
      _ws = new WebSocket('${WS_URL}', ['webhid.${TEST_WS_TOKEN}']);
      _ws.onopen = function() {
        _wsConnected = true;
        for (var i = 0; i < _wsQueue.length; i++) _wsQueue[i]();
        _wsQueue = [];
      };
      _ws.onclose = function() { _wsConnected = false; _ws = null; };
      _ws.onerror = function() {};
      _ws.onmessage = function(ev) {
        try {
          var msg = JSON.parse(ev.data);
          var handler = _pending[msg.n];
          if (handler) { delete _pending[msg.n]; handler(msg); }
        } catch(e) {}
      };
    } catch(e) {}
  }

  function wsRequest(action, payload) {
    return new Promise(function(resolve) {
      var id = ++_reqId;
      _pending[id] = resolve;
      function send() {
        var req = { n: id, action: action };
        if (payload) for (var k in payload) req[k] = payload[k];
        _ws.send(JSON.stringify(req));
      }
      if (_wsConnected) { send(); }
      else { _wsQueue.push(send); wsConnect(); }
    });
  }

  var HIDDevice = function(info) {
    this._info = info;
    this._opened = false;
  };

  HIDDevice.prototype.open = function() {
    var self = this;
    return wsRequest('open', { deviceId: this._info.deviceId }).then(function(r) {
      if (r.s >= 200 && r.s < 300) { self._opened = true; return; }
      throw new Error('open failed: ' + r.s);
    });
  };

  HIDDevice.prototype.close = function() {
    var self = this;
    return wsRequest('close', { deviceId: this._info.deviceId }).then(function(r) {
      if (r.s >= 200 && r.s < 300) { self._opened = false; return; }
      throw new Error('close failed: ' + r.s);
    });
  };

  Object.defineProperties(HIDDevice.prototype, {
    opened: { get: function() { return this._opened; } },
    vendorId: { get: function() { return this._info.vendorId; } },
    productId: { get: function() { return this._info.productId; } },
    productName: { get: function() { return this._info.productName || ''; } },
    collections: { get: function() { return this._info.collections || []; } },
  });

  var _hid = {};

  _hid.getDevices = function() {
    return wsRequest('enumerate').then(function(r) {
      return (r.D || []).map(function(d) { return new HIDDevice(d); });
    });
  };

  _hid.requestDevice = function(options) {
    return wsRequest('enumerate').then(function(r) {
      return (r.D || []).map(function(d) { return new HIDDevice(d); });
    });
  };

  try {
    Object.defineProperty(navigator, 'hid', {
      value: _hid, writable: false, configurable: true, enumerable: false,
    });
  } catch(e) {}

})();
`;
}
