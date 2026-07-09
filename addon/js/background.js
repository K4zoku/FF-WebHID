let _deviceCache = [];

/** device_id → Set<tabId> */
const _deviceTabMap = new Map();

function registerDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  let tabs = _deviceTabMap.get(deviceId);
  if (!tabs) { tabs = new Set(); _deviceTabMap.set(deviceId, tabs); }
  tabs.add(tabId);
  logger.debug(`[bg] register device ${deviceId} → tab ${tabId} (owners: ${tabs.size})`);
}

function unregisterDeviceTab(deviceId, tabId) {
  if (!deviceId || tabId == null) return;
  const tabs = _deviceTabMap.get(deviceId);
  if (!tabs) return;
  tabs.delete(tabId);
  if (tabs.size === 0) _deviceTabMap.delete(deviceId);
  else _deviceTabMap.set(deviceId, tabs);
  logger.debug(`[bg] unregister device ${deviceId} ← tab ${tabId} (remaining: ${tabs.size})`);
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
  const eventType = message.event_type;
  if (eventType === 'handshake' || !message.device_id) return null; // null = broadcast
  const tabs = _deviceTabMap.get(message.device_id);
  return tabs && tabs.size > 0 ? [...tabs] : null;
}

// ---------------------------------------------------------------------------
// Base64 encode helper  (Uint8Array → base64 string — for NM requests only)
// Decode happens at the final consumer (polyfill) to avoid structured-clone
// copies of typed arrays across context boundaries.
// Uses Uint8Array.fromBase64 / setFromBase64 (Firefox 133+, addon requires 142+).
// ---------------------------------------------------------------------------

function base64Encode(bytes) {
  return Uint8Array.prototype.toBase64
    ? bytes.toBase64()
    : btoa(String.fromCharCode(...bytes));
}

// NM host names registered by the installer:
// - webhid.forwarder_nm_host: thin forwarder → daemon Unix socket / pipe
// - webhid.daemon_nm_host:     daemon speaks NM directly on stdin/stdout
const NM_HOST_FORWARDER = "webhid.forwarder_nm_host";
const NM_HOST_DAEMON    = "webhid.daemon_nm_host";

let _daemonAsNmHost = false;
let _nmHostName = NM_HOST_FORWARDER;

// Load the daemon-as-NM-host setting before connecting. The first connect
// must use the correct name or the user has to manually reload the addon
// after toggling the setting.
async function loadNmHostSetting() {
  const global = await browser.storage.local.get({ daemonAsNmHost: false });
  _daemonAsNmHost = global.daemonAsNmHost;
  _nmHostName = _daemonAsNmHost ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
  logger.info('[bg] NM host:', _nmHostName);
}

const NativeMessaging = {
  port: null,
  _nextId: 1,
  _pending: new Map(),
  _reconnectTimer: null,
  _reconnectDelay: 1000,

  connect() {
    if (this.port) return Promise.resolve();
    logger.debug(`[nm] connecting to ${_nmHostName}...`);
    try {
      this.port = browser.runtime.connectNative(_nmHostName);
      this._reconnectDelay = 1000;
      logger.debug('[nm] connected');

      this.port.onMessage.addListener((message) => {
        // `data` arrives as a base64 string and is forwarded as-is;
        // decoding happens at the final consumer (polyfill) to avoid
        // structured-clone copies of typed arrays.
        if (message.event_type) { this.onMessage(message); return; }
        if (message.id) {
          const p = this._pending.get(message.id);
          if (p) { this._pending.delete(message.id); p.resolve(message); return; }
        }
        logger.warn("webhid: NM response no matching pending:", message);
      });

      this.port.onDisconnect.addListener(() => {
        logger.warn("[nm] disconnected; will retry in", this._reconnectDelay, "ms");
        this.port = null;
        for (const [id, p] of this._pending) p.resolve({ success: false, error: "NM disconnected" });
        this._pending.clear();
        this._scheduleReconnect();
      });

      return Promise.resolve();
    } catch (error) {
      logger.error("[nm] connect failed:", error);
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
      logger.debug("[nm] reconnecting...");
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
      logger.debug('[nm] sendRequest action=' + request.action + ' id=' + id);
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
      device_id: deviceId,
    });
  },

  async closeDevice(deviceId) {
    return await this.sendRequest({
      action: "close",
      device_id: deviceId,
    });
  },

  async sendReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendreport",
      device_id: deviceId,
      report_id: reportId,
      data: base64Encode(data),
    });
  },

  async receiveFeatureReport(deviceId, reportId) {
    return await this.sendRequest({
      action: "receivefeaturereport",
      device_id: deviceId,
      report_id: reportId,
    });
  },

  async sendFeatureReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendfeaturereport",
      device_id: deviceId,
      report_id: reportId,
      data: base64Encode(data),
    });
  },

  onMessage(message) {
    if (!message.event_type) return;
    if (message.event_type === "input_report") return;

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

// ---------------------------------------------------------------------------
// Security Headers (COOP/COEP): only when SAB data plane is enabled
// ---------------------------------------------------------------------------

let _sabEnabled = true;
async function loadSabSetting() {
  const global = await browser.storage.local.get({ sabEnabled: true });
  _sabEnabled = global.sabEnabled;
}
loadSabSetting();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.sabEnabled) {
      _sabEnabled = changes.sabEnabled.newValue;
    }
    if (changes.daemonAsNmHost) {
      const newName = changes.daemonAsNmHost.newValue ? NM_HOST_DAEMON : NM_HOST_FORWARDER;
      if (newName !== _nmHostName) {
        _daemonAsNmHost = changes.daemonAsNmHost.newValue;
        _nmHostName = newName;
        logger.info('[bg] NM host changed →', _nmHostName, '(reconnecting)');
        NativeMessaging.reconnectWithNewHost();
      }
    }
    // Reload from storage to pick up per-site overrides
    loadSabSetting();
    logger.info('[bg] SAB data plane:', _sabEnabled);
  }
});

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!_sabEnabled) return {};

    // Only inject COOP/COEP on main-frame document requests. Injecting on
    // sub-resources (scripts, images, fonts) breaks cross-origin loads on
    // sites like usevia.app that pull from CDNs without CORP headers.
    const isMainFrame = details.type === 'main_frame';
    if (!isMainFrame) return {};

    const headers = details.responseHeaders.filter(h =>
      !['cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy'].includes(h.name.toLowerCase())
    );
    headers.push(
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      // credentialless is more permissive than require-corp: cross-origin
      // resources without CORP headers are still allowed (loaded without
      // credentials). This avoids breaking sites that load from CDNs.
      { name: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    );
    return { responseHeaders: headers };
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['blocking', 'responseHeaders']
);

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

    case "open": {
      const tabId = sender.tab?.id;
      NativeMessaging.openDevice(request.device_id)
        .then((response) => {
          if (response.success && response.device_id) {
            registerDeviceTab(response.device_id, tabId);
          }
          sendResponse(response);
        })
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case "close": {
      const tabId = sender.tab?.id;
      NativeMessaging.closeDevice(request.device_id)
        .then((response) => {
          if (response.success) unregisterDeviceTab(request.device_id, tabId);
          sendResponse(response);
        })
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case "sendreport":
      NativeMessaging.sendReport(
        request.device_id,
        request.report_id || 0,
        request.data,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "receivefeaturereport":
      NativeMessaging.receiveFeatureReport(
        request.device_id,
        request.report_id,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "sendfeaturereport":
      NativeMessaging.sendFeatureReport(
        request.device_id,
        request.report_id || 0,
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
          if (request.device_id) {
            hashes = hashes.filter(h => h !== request.device_id);
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
