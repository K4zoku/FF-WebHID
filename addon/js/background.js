let _deviceCache = [];

/** deviceId → Set<tabId> */
const _deviceTabMap = new Map();

function registerDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  let tabs = _deviceTabMap.get(deviceId);
  if (!tabs) { tabs = new Set(); _deviceTabMap.set(deviceId, tabs); }
  tabs.add(tabId);
  __webhid.logger.debug(`[bg] register device ${deviceId} → tab ${tabId} (owners: ${tabs.size})`);
}

function unregisterDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  const tabs = _deviceTabMap.get(deviceId);
  if (!tabs) return;
  tabs.delete(tabId);
  if (tabs.size === 0) _deviceTabMap.delete(deviceId);
  else _deviceTabMap.set(deviceId, tabs);
  __webhid.logger.debug(`[bg] unregister device ${deviceId} ← tab ${tabId} (remaining: ${tabs.size})`);
}

/** Drop every device→tab entry that points at `tabId` (called on tab close). */
function purgeTab(tabId) {
  if (tabId == null) return;
  for (const [deviceId, tabs] of _deviceTabMap) {
    if (tabs.delete(tabId) && tabs.size === 0) _deviceTabMap.delete(deviceId);
  }
}

/** Resolve the set of tabIds that should receive an event for `deviceId`. */
function tabsForEvent(message) {
  // Handshake and other non-device-scoped events go to every tab.
  const eventType = message.eventType;
  if (eventType === 'handshake' || !message.deviceId) return null; // null = broadcast
  const tabs = _deviceTabMap.get(message.deviceId);
  return tabs && tabs.size > 0 ? [...tabs] : null;
}

// NM host names registered by the installer:
// - webhid.forwarder_nm_host: thin forwarder → daemon Unix socket / pipe
// - webhid.daemon_nm_host:     daemon speaks NM directly on stdin/stdout
const NM_HOST_FORWARDER = "webhid.forwarder_nm_host";
const NM_HOST_DAEMON    = "webhid.daemon_nm_host";

let _daemonAsNmHost = globalThis.__webhid.GLOBAL_DEFAULTS.daemonAsNmHost;
let _nmHostName = NM_HOST_FORWARDER;

// Load the daemon-as-NM-host setting before connecting. The first connect
// must use the correct name or the user has to manually reload the addon
// after toggling the setting.
async function loadNmHostSetting() {
  const global = await browser.storage.local.get({ daemonAsNmHost: globalThis.__webhid.GLOBAL_DEFAULTS.daemonAsNmHost });
  _daemonAsNmHost = global.daemonAsNmHost;
  _nmHostName = _daemonAsNmHost ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
  __webhid.logger.info('[bg] NM host:', _nmHostName);
}

const NativeMessaging = {
  port: null,
  _nextId: 1,
  _pending: new Map(),
  _reconnectTimer: null,
  _reconnectDelay: 1000,

  connect() {
    if (this.port) return Promise.resolve();
    __webhid.logger.debug(`[nm] connecting to ${_nmHostName}...`);
    try {
      this.port = browser.runtime.connectNative(_nmHostName);
      this._reconnectDelay = 1000;
      __webhid.logger.debug('[nm] connected');

      this.port.onMessage.addListener((message) => {
        // `data` arrives as a base64 string and is forwarded as-is;
        // decoding happens at the final consumer (polyfill) to avoid
        // structured-clone copies of typed arrays.
        if (message.eventType) { this.onMessage(message); return; }
        if (message.id) {
          const p = this._pending.get(message.id);
          if (p) { this._pending.delete(message.id); p.resolve(message); return; }
        }
        __webhid.logger.warn("webhid: NM response no matching pending:", message);
      });

      this.port.onDisconnect.addListener(() => {
        __webhid.logger.warn("[nm] disconnected; will retry in", this._reconnectDelay, "ms");
        this.port = null;
        for (const [id, p] of this._pending) p.resolve({ success: false, error: "NM disconnected" });
        this._pending.clear();
        this._scheduleReconnect();
      });

      return Promise.resolve();
    } catch (error) {
      __webhid.logger.error("[nm] connect failed:", error);
      this._scheduleReconnect();
      return Promise.reject(error);
    }
  },

  // Tear down the current port so the next connect() picks up the new
  // NM host name. Called when the `daemonAsNmHost` setting changes.
  reconnectWithNewHost() {
    if (this.port) {
      try { this.port.disconnect(); } catch {}
      this.port = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectDelay = 1000;
    this.connect().catch(() => {});
  },

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      __webhid.logger.debug("[nm] reconnecting...");
      this.connect().catch(() => {});
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
  },

  sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        this.connect().catch(() => {});
        reject(new Error("NM disconnected, reconnecting; please retry"));
        return;
      }

      const id = this._nextId++;
      __webhid.logger.debug('[nm] sendRequest action=' + request.action + ' id=' + id);
      this._pending.set(id, { resolve, reject });

      try {
        this.port.postMessage({ ...request, id });
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  },

  async enumerateDevices() {
    return await this.sendRequest({ action: "enumerate" });
  },

  async openDevice(deviceId) {
    return await this.sendRequest({
      action: "open",
      deviceId: deviceId,
    });
  },

  async closeDevice(deviceId) {
    return await this.sendRequest({
      action: "close",
      deviceId: deviceId,
    });
  },

  async handshake() {
    return await this.sendRequest({ action: "handshake" });
  },

  async sendReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendreport",
      deviceId: deviceId,
      reportId: reportId,
      data: data.toBase64(),
    });
  },

  async receiveFeatureReport(deviceId, reportId) {
    return await this.sendRequest({
      action: "receivefeaturereport",
      deviceId: deviceId,
      reportId: reportId,
    });
  },

  async sendFeatureReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendfeaturereport",
      deviceId: deviceId,
      reportId: reportId,
      data: data.toBase64(),
    });
  },

  onMessage(message) {
    if (!message.eventType) return;

    const targets = tabsForEvent(message);
    const send = (tabId) => browser.tabs
      .sendMessage(tabId, { action: "webhid-device-event", event: message })
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

browser.runtime.onStartup.addListener(() => {
  loadNmHostSetting().then(() => NativeMessaging.connect());
});

browser.runtime.onInstalled.addListener(() => {
  loadNmHostSetting().then(() => NativeMessaging.connect());
});

// On first load of the background page (which fires neither onStartup nor
// onInstalled in some Firefox versions during temporary load), pull the
// setting and connect.
loadNmHostSetting().then(() => NativeMessaging.connect());

// Clean up device→tab mappings when a tab closes so we don't leak entries
// (and so a re-opened tab doesn't keep receiving events for a device it no
// longer owns).
browser.tabs.onRemoved.addListener((tabId) => purgeTab(tabId));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.daemonAsNmHost) {
      const newName = changes.daemonAsNmHost.newValue ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
      if (newName !== _nmHostName) {
        _daemonAsNmHost = changes.daemonAsNmHost.newValue;
        _nmHostName = newName;
        __webhid.logger.info('[bg] NM host changed →', _nmHostName, '(reconnecting)');
        NativeMessaging.reconnectWithNewHost();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Message handler for content-script requests
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "enumerate":
      NativeMessaging.enumerateDevices()
        .then((response) => {
          if (response.success && response.devices) {
            _deviceCache = response.devices;
          }
          sendResponse(response);
        })
        .catch((e) => {
          sendResponse({ success: false, error: e.message });
        });
      return true; // keep channel open for async response

    case "handshake":
      NativeMessaging.handshake()
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "open": {
      const tabId = sender.tab?.id;
      NativeMessaging.openDevice(request.deviceId)
        .then((response) => {
          if (response.success && response.deviceId) {
            registerDeviceTab(response.deviceId, tabId);
          }
          sendResponse(response);
        })
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case "close": {
      const tabId = sender.tab?.id;
      NativeMessaging.closeDevice(request.deviceId)
        .then((response) => {
          if (response.success) unregisterDeviceTab(request.deviceId, tabId);
          sendResponse(response);
        })
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case "setdataplane":
      NativeMessaging.sendRequest({
        action: "setdataplane",
        deviceId: request.deviceId,
        mode: request.mode,
      })
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "sendreport":
      NativeMessaging.sendReport(
        request.deviceId,
        request.reportId || 0,
        request.data,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "receivefeaturereport":
      NativeMessaging.receiveFeatureReport(
        request.deviceId,
        request.reportId,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "sendfeaturereport":
      NativeMessaging.sendFeatureReport(
        request.deviceId,
        request.reportId || 0,
        request.data,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "show-device-picker":
      // The device picker is rendered directly by the content script;
      // background just acknowledges the notification.
      return false;

    case "getSavedDevices":
      (async () => {
        try {
          const key = encodeURIComponent(request.origin);
          const result = await browser.storage.local.get(key);
          const hashes = result[key] || [];
          sendResponse({ success: true, hashes });
        } catch (e) {
          sendResponse({ success: false, error: e.message, hashes: [] });
        }
      })();
      return true;

    case "saveDevice":
      (async () => {
        try {
          const key = encodeURIComponent(request.origin);
          const result = await browser.storage.local.get(key);
          const hashes = result[key] || [];
          const deviceHash = request.device.hash;
          if (!hashes.includes(deviceHash)) {
            hashes.push(deviceHash);
            await browser.storage.local.set({ [key]: hashes });
          }
          sendResponse({ success: true, hashes });
        } catch (e) {
          sendResponse({ success: false, error: e.message, hashes: [] });
        }
      })();
      return true;

    case "forgetDevice":
      (async () => {
        try {
          const key = encodeURIComponent(request.origin || sender.tab?.url || "");
          const origin = new URL(sender.tab?.url || "http://localhost").origin;
          const storageKey = encodeURIComponent(origin);
          const result = await browser.storage.local.get(storageKey);
          let hashes = result[storageKey] || [];
          // Remove matching hash
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

    case "device-count-changed":
      browser.action.setBadgeText({
        text: request.count > 0 ? String(request.count) : "",
        tabId: sender.tab?.id,
      });
      return false;

    case "getDeviceCache":
      sendResponse({ devices: _deviceCache });
      return false;

    default:
      return false;
  }
});
