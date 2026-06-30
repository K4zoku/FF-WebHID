const NativeMessaging = {
  port: null,
  _nextId: 1,
  _pending: new Map(),
  _reconnectTimer: null,
  _reconnectDelay: 1000,

  connect() {
    if (this.port) return Promise.resolve();
    try {
      this.port = browser.runtime.connectNative("webhid_server");
      this._reconnectDelay = 1000;

      this.port.onMessage.addListener((message) => {
        if (message.event_type) { this.onMessage(message); return; }
        if (message.id) {
          const p = this._pending.get(message.id);
          if (p) { this._pending.delete(message.id); p.resolve(message); return; }
        }
        console.warn("webhid: NM response no matching pending:", message);
      });

      this.port.onDisconnect.addListener(() => {
        console.warn("[nm] disconnected — will retry in", this._reconnectDelay, "ms");
        this.port = null;
        for (const [id, p] of this._pending) p.resolve({ success: false, error: "NM disconnected" });
        this._pending.clear();
        this._scheduleReconnect();
      });

      return Promise.resolve();
    } catch (error) {
      console.error("[nm] connect failed:", error);
      this._scheduleReconnect();
      return Promise.reject(error);
    }
  },

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      console.log("[nm] reconnecting...");
      this.connect().catch(() => {});
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
  },

  sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        this.connect().catch(() => {});
        reject(new Error("NM disconnected, reconnecting — please retry"));
        return;
      }

      const id = this._nextId++;
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
      // Forward device events to every content script so HIDDevice instances
      // can fire inputreport / connect / disconnect events.
      browser.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          browser.tabs
            .sendMessage(tab.id, {
              action: "webhid-device-event",
              event: message,
            })
            .catch(() => {
              // Tab may not have the content script injected – ignore.
            });
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
// Security Headers (COOP/COEP)
// ---------------------------------------------------------------------------

// To enable SharedArrayBuffer support in the browser, the addon injects
// security headers into all http:// and https:// responses.
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders.filter(h =>
      !['cross-origin-opener-policy',
        'cross-origin-embedder-policy'].includes(h.name.toLowerCase())
    );
    headers.push(
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { name: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
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
    case "injectCSS":
      browser.scripting.insertCSS({
        target: { tabId: sender.tab.id },
        files: ['webhid.css']
      });
      return true;
    case "enumerate":
      NativeMessaging.enumerateDevices()
        .then(sendResponse)
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

    default:
      return false;
  }
});
