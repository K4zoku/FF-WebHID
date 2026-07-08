let _deviceCache = [];

const NativeMessaging = {
  port: null,
  _nextId: 1,
  _pending: new Map(),
  _reconnectTimer: null,
  _reconnectDelay: 1000,

  connect() {
    if (this.port) return Promise.resolve();
    logger.debug('[nm] connecting to webhid_server...');
    try {
      this.port = browser.runtime.connectNative("webhid_server");
      this._reconnectDelay = 1000;
      logger.debug('[nm] connected');

      this.port.onMessage.addListener((message) => {
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

  // The hidraw path uniquely identifies one HID interface; a composite
  // USB device exposes several of them, so we must open each one we want
  // to read from explicitly (vid/pid alone would be ambiguous and would
  // only open the first matching node).
  async openDevice(deviceId) {
    return await this.sendRequest({
      action: "open",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
    });
  },

  async closeDevice(deviceId) {
    return await this.sendRequest({
      action: "close",
      data: deviceId.split("").map((c) => c.charCodeAt(0)),
    });
  },

  // device_id, report_id, and data are kept as separate fields so the
  // native-messaging process can distinguish the path, report ID, and
  // payload without guessing.  The daemon is responsible for prepending
  // `report_id` to the buffer before calling `write(2)`.
  async sendReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendreport",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
      report_id: reportId,
      data: Array.from(data),
    });
  },

  async receiveFeatureReport(deviceId, reportId) {
    return await this.sendRequest({
      action: "receivefeaturereport",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
      report_id: reportId,
    });
  },

  // Same convention as sendReport: the daemon prepends `report_id`
  // before issuing HIDIOCSFEATURE, so `data` is the payload only.
  async sendFeatureReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "sendfeaturereport",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
      report_id: reportId,
      data: Array.from(data),
    });
  },

  onMessage(message) {
    if (message.event_type) {
      if (message.event_type === "input_report") return;
      browser.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          browser.tabs
            .sendMessage(tab.id, {
              action: "webhid-device-event",
              event: message,
            })
            .catch(() => {});
        }
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

browser.runtime.onStartup.addListener(() => {
  NativeMessaging.connect();
});

browser.runtime.onInstalled.addListener(() => {
  NativeMessaging.connect();
});

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

    case "open":
      NativeMessaging.openDevice(String.fromCharCode(...request.device_id))
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "close":
      NativeMessaging.closeDevice(String.fromCharCode(...request.data))
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "sendreport":
      // device_id, report_id and data arrive as separate fields from the
      // content script (see HIDDevice.sendReport).
      NativeMessaging.sendReport(
        String.fromCharCode(...request.device_id),
        request.report_id || 0,
        request.data,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "receivefeaturereport":
      NativeMessaging.receiveFeatureReport(
        String.fromCharCode(...request.device_id),
        request.report_id,
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "sendfeaturereport":
      NativeMessaging.sendFeatureReport(
        String.fromCharCode(...request.device_id),
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
            const devIdStr = String.fromCharCode(...request.device_id);
            hashes = hashes.filter(h => h !== devIdStr);
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
