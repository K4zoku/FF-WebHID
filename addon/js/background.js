let _deviceCache = [];

const _deviceTabMap = new Map();

function registerDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  let tabs = _deviceTabMap.get(deviceId);
  if (!tabs) { tabs = new Set(); _deviceTabMap.set(deviceId, tabs); }
  tabs.add(tabId);
  __webhid.logger.debug('[bg] register device ' + deviceId + ' tab ' + tabId);
}

function unregisterDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  const tabs = _deviceTabMap.get(deviceId);
  if (!tabs) return;
  tabs.delete(tabId);
  if (tabs.size === 0) _deviceTabMap.delete(deviceId);
}

function purgeTab(tabId) {
  if (tabId == null) return;
  for (const [deviceId, tabs] of _deviceTabMap) {
    if (tabs.delete(tabId) && tabs.size === 0) _deviceTabMap.delete(deviceId);
  }
}

// NM event codes (must match Rust constants)
const EVT_HANDSHAKE = 1;
const EVT_CONNECT = 2;
const EVT_DISCONNECT = 3;

// NM action codes (must match Rust constants)
const ACT = { enum: 1, open: 2, close: 3, sr: 4, rfr: 5, sfr: 6, sdp: 7, hs: 8 };

// Packed binary message type
const PKG_INPUT_REPORT = 0x01;
const PKG_SEND_REPORT = 0x02;

function tabsForEvent(message) {
  const eventType = message.e;
  if (eventType === EVT_HANDSHAKE || !message.i) return null;
  const tabs = _deviceTabMap.get(message.i);
  return tabs && tabs.size > 0 ? [...tabs] : null;
}

const NM_HOST_FORWARDER = "webhid.forwarder_nm_host";
const NM_HOST_DAEMON = "webhid.daemon_nm_host";

let _daemonAsNmHost = globalThis.__webhid.GLOBAL_DEFAULTS.daemonAsNmHost;
let _nmHostName = NM_HOST_FORWARDER;

async function loadNmHostSetting() {
  const global = await browser.storage.local.get({ daemonAsNmHost: globalThis.__webhid.GLOBAL_DEFAULTS.daemonAsNmHost });
  _daemonAsNmHost = global.daemonAsNmHost;
  _nmHostName = _daemonAsNmHost ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
  __webhid.logger.info('[bg] NM host:', _nmHostName);
}

function buildPackedSendReport(deviceId, reportId, data) {
  // deviceId: u32 number, 4 bytes LE
  const buf = new Uint8Array(9 + data.length);
  let o = 0;
  buf[o++] = PKG_SEND_REPORT;
  buf[o++] = 4;  // devIdLen = 4 (u32)
  buf[o++] = deviceId & 0xFF;
  buf[o++] = (deviceId >> 8) & 0xFF;
  buf[o++] = (deviceId >> 16) & 0xFF;
  buf[o++] = (deviceId >> 24) & 0xFF;
  buf[o++] = reportId;
  buf[o++] = data.length & 0xFF;
  buf[o++] = (data.length >> 8) & 0xFF;
  buf.set(data, o);
  return buf;
}

const NativeMessaging = {
  port: null,
  _nextId: 1,
  _pending: new Map(),
  _reconnectTimer: null,
  _reconnectDelay: 1000,

  connect() {
    if (this.port) return Promise.resolve();
    __webhid.logger.debug('[nm] connecting to ' + _nmHostName + '...');
    try {
      this.port = browser.runtime.connectNative(_nmHostName);
      this._reconnectDelay = 1000;
      __webhid.logger.debug('[nm] connected');

      this.port.onMessage.addListener((message) => {
        // Packed data message: {"d":"<b64>"} with no n/e
        if (message.d !== undefined && message.n === undefined && message.e === undefined) {
          this.onPackedData(message.d);
          return;
        }
        // Control event (has "e" field)
        if (message.e !== undefined) {
          this.onControlEvent(message);
          return;
        }
        // Control response (has "n" field)
        if (message.n !== undefined) {
          const p = this._pending.get(message.n);
          if (p) { this._pending.delete(message.n); p.resolve(message); return; }
        }
        __webhid.logger.warn('[nm] unmatched:', message);
      });

      this.port.onDisconnect.addListener(() => {
        __webhid.logger.warn('[nm] disconnected; will retry in', this._reconnectDelay, 'ms');
        this.port = null;
        for (const [id, p] of this._pending) p.resolve({ s: 503 });
        this._pending.clear();
        this._scheduleReconnect();
      });

      return Promise.resolve();
    } catch (error) {
      __webhid.logger.error('[nm] connect failed:', error);
      this._scheduleReconnect();
      return Promise.reject(error);
    }
  },

  reconnectWithNewHost() {
    if (this.port) { try { this.port.disconnect(); } catch {} this.port = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectDelay = 1000;
    this.connect().catch(() => {});
  },

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      __webhid.logger.debug('[nm] reconnecting...');
      this.connect().catch(() => {});
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
  },

  sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        this.connect().catch(() => {});
        reject(new Error('NM disconnected, reconnecting; please retry'));
        return;
      }
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      __webhid.logger.debug('[nm] sendRequest a=' + request.a + ' n=' + id);
      try {
        this.port.postMessage({ ...request, n: id });
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  },

  async enumerateDevices() {
    return await this.sendRequest({ a: ACT.enum });
  },
  async openDevice(deviceId) {
    return await this.sendRequest({ a: ACT.open, i: deviceId });
  },
  async closeDevice(deviceId) {
    return await this.sendRequest({ a: ACT.close, i: deviceId });
  },
  async handshake() {
    return await this.sendRequest({ a: ACT.hs });
  },
  async sendReport(deviceId, reportId, data) {
    const packed = buildPackedSendReport(deviceId, reportId, data);
    return await this.sendRequest({ a: ACT.sr, d: packed.toBase64() });
  },
  async receiveFeatureReport(deviceId, reportId) {
    return await this.sendRequest({ a: ACT.rfr, i: deviceId, r: reportId });
  },
  async sendFeatureReport(deviceId, reportId, data) {
    return await this.sendRequest({ a: ACT.sfr, i: deviceId, r: reportId, d: data.toBase64() });
  },

  onPackedData(b64) {
    // TLV: [msgType=0x01][devIdLen=4][devId u32 LE][reportId][payloadLen u16 LE][payload]
    const bin = Uint8Array.fromBase64(b64);
    if (bin.length < 9 || bin[0] !== PKG_INPUT_REPORT) return;
    if (bin[1] !== 4) return;  // devIdLen must be 4
    const deviceId = bin[2] | (bin[3] << 8) | (bin[4] << 16) | (bin[5] << 24) >>> 0;
    const reportId = bin[6];
    const payloadLen = bin[7] | (bin[8] << 8);
    const payloadEnd = 9 + payloadLen;
    if (payloadEnd > bin.length) return;
    const payloadB64 = bin.subarray(9, payloadEnd).toBase64();

    const event = { eventType: 'input_report', deviceId, reportId, data: payloadB64 };
    const targets = tabsForEvent({ i: deviceId });
    const send = (tabId) => browser.tabs
      .sendMessage(tabId, { action: 'webhid-device-event', event })
      .catch(() => {});
    if (targets) {
      for (const tabId of targets) send(tabId);
    } else {
      browser.tabs.query({}).then((tabs) => {
        for (const tab of tabs) send(tab.id);
      });
    }
  },

  onControlEvent(message) {
    if (message.e === undefined) return;
    const targets = tabsForEvent(message);
    const send = (tabId) => browser.tabs
      .sendMessage(tabId, { action: 'webhid-device-event', event: message })
      .catch(() => {});
    if (targets) {
      for (const tabId of targets) send(tabId);
    } else {
      browser.tabs.query({}).then((tabs) => {
        for (const tab of tabs) send(tab.id);
      });
    }
  },
};

browser.runtime.onStartup.addListener(() => {
  loadNmHostSetting().then(() => NativeMessaging.connect());
});
browser.runtime.onInstalled.addListener(() => {
  loadNmHostSetting().then(() => NativeMessaging.connect());
});
loadNmHostSetting().then(() => NativeMessaging.connect());
browser.tabs.onRemoved.addListener((tabId) => purgeTab(tabId));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.daemonAsNmHost) {
      const newName = changes.daemonAsNmHost.newValue ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
      if (newName !== _nmHostName) {
        _daemonAsNmHost = changes.daemonAsNmHost.newValue;
        _nmHostName = newName;
        __webhid.logger.info('[bg] NM host changed:', _nmHostName);
        NativeMessaging.reconnectWithNewHost();
      }
    }
  }
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'enumerate':
      NativeMessaging.enumerateDevices()
        .then((response) => {
          if (__webhid.http.isOk(response.s) && response.D) _deviceCache = response.D;
          sendResponse(response);
        })
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'handshake':
      NativeMessaging.handshake()
        .then(sendResponse)
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'open': {
      const tabId = sender.tab?.id;
      NativeMessaging.openDevice(request.deviceId)
        .then((response) => {
          if (__webhid.http.isOk(response.s) && response.i) registerDeviceTab(response.i, tabId);
          sendResponse(response);
        })
        .catch((e) => sendResponse({ s: 500 }));
      return true;
    }

    case 'close': {
      const tabId = sender.tab?.id;
      NativeMessaging.closeDevice(request.deviceId)
        .then((response) => {
          if (__webhid.http.isOk(response.s)) unregisterDeviceTab(request.deviceId, tabId);
          sendResponse(response);
        })
        .catch((e) => sendResponse({ s: 500 }));
      return true;
    }

    case 'setdataplane':
      NativeMessaging.sendRequest({ a: ACT.sdp, i: request.deviceId, m: request.mode })
        .then(sendResponse)
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'sendreport':
      NativeMessaging.sendReport(request.deviceId, request.reportId || 0, request.data)
        .then(sendResponse)
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'receivefeaturereport':
      NativeMessaging.receiveFeatureReport(request.deviceId, request.reportId)
        .then(sendResponse)
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'sendfeaturereport':
      NativeMessaging.sendFeatureReport(request.deviceId, request.reportId || 0, request.data)
        .then(sendResponse)
        .catch((e) => sendResponse({ s: 500 }));
      return true;

    case 'getSavedDevices':
      (async () => {
        try {
          const key = encodeURIComponent(request.origin);
          const result = await browser.storage.local.get(key);
          // Migration: old format stored string device_ids; new format is u32 numbers.
          // Drop any non-number entries and persist the cleaned list.
          const raw = result[key] || [];
          const hashes = raw.filter(h => typeof h === 'number');
          if (raw.length !== hashes.length) {
            await browser.storage.local.set({ [key]: hashes });
            __webhid.logger.info('[bg] migrated saved devices: ' + raw.length + ' → ' + hashes.length + ' (dropped non-numeric)');
          }
          sendResponse({ success: true, hashes });
        } catch (e) {
          sendResponse({ success: false, error: e.message, hashes: [] });
        }
      })();
      return true;

    case 'saveDevice':
      (async () => {
        try {
          const key = encodeURIComponent(request.origin);
          const result = await browser.storage.local.get(key);
          const hashes = result[key] || [];
          if (!hashes.includes(request.device.deviceId)) {
            hashes.push(request.device.deviceId);
            await browser.storage.local.set({ [key]: hashes });
          }
          sendResponse({ success: true, hashes });
        } catch (e) {
          sendResponse({ success: false, error: e.message, hashes: [] });
        }
      })();
      return true;

    case 'forgetDevice':
      (async () => {
        try {
          const origin = new URL(sender.tab?.url || 'http://localhost').origin;
          const storageKey = encodeURIComponent(origin);
          const result = await browser.storage.local.get(storageKey);
          let hashes = result[storageKey] || [];
          if (request.deviceId) {
            hashes = hashes.filter(h => h !== request.deviceId);
            await browser.storage.local.set({ [storageKey]: hashes });
          }
          sendResponse({ success: true, hashes });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'device-count-changed':
      browser.action.setBadgeText({
        text: request.count > 0 ? String(request.count) : '',
        tabId: sender.tab?.id,
      });
      return false;

    case 'getDeviceCache':
      sendResponse({ devices: _deviceCache });
      return false;

    default:
      return false;
  }
});
