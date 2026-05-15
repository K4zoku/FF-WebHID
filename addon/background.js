const NativeMessaging = {
  port: null,
  // FIFO queue of resolvers waiting for the next non-event response.
  //
  // The native-messaging process handles requests serially and emits
  // responses to stdout in the same order they were sent, so popping the
  // queue head on each non-event message correctly correlates each
  // response with the request that produced it.
  //
  // The previous implementation registered an ad-hoc `onMessage` listener
  // per call which made concurrent calls race: every listener fired on
  // every incoming message, so two simultaneous `open()` requests would
  // both resolve with the *first* response (and the second response would
  // be dropped because both listeners had already detached).
  _pending: [],

  connect() {
    try {
      this.port = browser.runtime.connectNative("webhid_server");

      this.port.onMessage.addListener((message) => {
        // Events are pushed by the daemon (id=0) and identified by an
        // `event_type` field.  They are routed to `onMessage` regardless
        // of any in-flight request.
        if (message.event_type) {
          this.onMessage(message);
          return;
        }
        // Otherwise it's a response: hand it to the request that has
        // been waiting the longest.
        const resolver = this._pending.shift();
        if (resolver) {
          resolver(message);
        } else {
          console.warn(
            "webhid: received NM response with no pending request:",
            message,
          );
        }
      });

      this.port.onDisconnect.addListener(() => {
        console.log("Native messaging disconnected");
        // Fail every still-pending request so callers don't hang forever.
        const pending = this._pending.splice(0);
        this.port = null;
        for (const resolver of pending) {
          resolver({ success: false, error: "Native messaging disconnected" });
        }
      });

      return Promise.resolve();
    } catch (error) {
      console.error("Failed to connect to native messaging:", error);
      return Promise.reject(error);
    }
  },

  sendRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error("Not connected to native messaging"));
        return;
      }
      // Enqueue BEFORE posting so a very fast response can never find an
      // empty queue.
      this._pending.push(resolve);
      try {
        this.port.postMessage(request);
      } catch (e) {
        // Roll back the queued resolver so subsequent responses still
        // line up with their requests.
        const idx = this._pending.indexOf(resolve);
        if (idx !== -1) this._pending.splice(idx, 1);
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

  async readDevice(deviceId, timeout) {
    return await this.sendRequest({
      action: "read",
      data: deviceId.split("").map((c) => c.charCodeAt(0)),
      timeout,
    });
  },

  // device_id, report_id, and data are kept as separate fields so the
  // native-messaging process can distinguish the path, report ID, and
  // payload without guessing.  The daemon is responsible for prepending
  // `report_id` to the buffer before calling `write(2)`.
  async writeDevice(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "write",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
      report_id: reportId,
      data: Array.from(data),
    });
  },

  async readFeatureReport(deviceId, reportId) {
    return await this.sendRequest({
      action: "readFeatureReport",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
      report_id: reportId,
    });
  },

  // Same convention as writeDevice: the daemon prepends `report_id`
  // before issuing HIDIOCSFEATURE, so `data` is the payload only.
  async writeFeatureReport(deviceId, reportId, data) {
    return await this.sendRequest({
      action: "writeFeatureReport",
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
            .sendMessage(tab.id, { action: "webhid-device-event", event: message })
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
// Message handler for content-script requests
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  switch (request.action) {
    case "enumerate":
      NativeMessaging.enumerateDevices().then(sendResponse).catch((e) => {
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

    case "read":
      NativeMessaging.readDevice(
        String.fromCharCode(...request.data),
        request.timeout
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "write":
      // device_id, report_id and data arrive as separate fields from the
      // content script (see HIDDevice.sendReport / HIDDevice.write).
      NativeMessaging.writeDevice(
        String.fromCharCode(...request.device_id),
        request.report_id || 0,
        request.data
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "readFeatureReport":
      NativeMessaging.readFeatureReport(
        String.fromCharCode(...request.device_id),
        request.report_id
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "writeFeatureReport":
      NativeMessaging.writeFeatureReport(
        String.fromCharCode(...request.device_id),
        request.report_id || 0,
        request.data
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
