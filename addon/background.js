const NativeMessaging = {
  port: null,

  connect() {
    try {
      this.port = browser.runtime.connectNative("webhid_server");

      this.port.onMessage.addListener((message) => {
        this.onMessage(message);
      });

      this.port.onDisconnect.addListener(() => {
        console.log("Native messaging disconnected");
        this.port = null;
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

      const onResponse = (message) => {
        // Skip push events – they are handled separately by onMessage().
        if (message.event_type) return;
        this.port.onMessage.removeListener(onResponse);
        resolve(message);
      };

      this.port.onMessage.addListener(onResponse);
      this.port.postMessage(request);
    });
  },

  async enumerateDevices() {
    return await this.sendRequest({ action: "enumerate" });
  },

  async openDevice(vendorId, productId) {
    return await this.sendRequest({
      action: "open",
      vendor_id: vendorId,
      product_id: productId,
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

  // device_id and data are kept as separate fields so the native-messaging
  // process can distinguish the path from the report payload without guessing.
  async writeDevice(deviceId, data) {
    return await this.sendRequest({
      action: "write",
      device_id: deviceId.split("").map((c) => c.charCodeAt(0)),
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
      NativeMessaging.openDevice(request.vendor_id, request.product_id)
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
      // device_id and data arrive as separate arrays from the content script.
      NativeMessaging.writeDevice(
        String.fromCharCode(...request.device_id),
        request.data
      )
        .then(sendResponse)
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "show-device-picker":
      // The device picker is rendered directly by the content script;
      // background just acknowledges the notification.
      return false;

    default:
      return false;
  }
});
