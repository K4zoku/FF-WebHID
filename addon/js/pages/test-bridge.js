"use strict";
const logger = globalThis.webhid.import("logger");
const http = globalThis.webhid.import("http");
const GLOBAL_DEFAULTS = globalThis.webhid.import("GLOBAL_DEFAULTS");
logger.initLogger("test-bridge");

let pagePort = null;
let devicePicker = null;
const dataPorts = new Map();

function replyToPage(msg, transfer) {
  if (!pagePort) return;
  pagePort.postMessage(msg, transfer);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const port = event.ports != null ? event.ports[0] : undefined;
  if (!port) return;
  if (pagePort) return;
  pagePort = port;
  pagePort.onmessage = (event) => {
    handleRequest(event.data, event.ports);
  };
  logger.debug("[test-bridge] page port established");
});

async function handleRequest(data, ports) {
  if (!data || data.id === undefined) return;

  const { id, action, payload } = data;

  try {
    if (action === "requestDevice") {
      const filters = (payload && payload.filters) || [];
      if (!devicePicker) {
        devicePicker = new (globalThis.webhid.import(
          "WebHidDevicePicker",
        ))();
        document.documentElement.appendChild(devicePicker.host);
      }
      const result = await devicePicker.show(filters);
      replyToPage({
        type: "response",
        id,
        result: result.devices.length
          ? { devices: result.devices }
          : { cancelled: true },
      });
      return;
    }

    if (action === "dataPort") {
      const deviceId = payload && payload.deviceId;
      const port = ports && ports[0];
      if (port && deviceId) {
        dataPorts.set(deviceId, port);
        port.onmessage = (event) => {
          onDataPortMessage(deviceId, event.data);
        };
      }
      replyToPage({ type: "response", id, result: { s: 204 } });
      return;
    }

    const msg = Object.assign({ action }, payload || {});
    const response = await browser.runtime.sendMessage(msg);
    const transfers =
      response && response.d instanceof Uint8Array ? [response.d.buffer] : [];
    replyToPage({ type: "response", id, result: response }, transfers);
  } catch (error) {
    replyToPage({ type: "response", id, result: { s: 500 } });
  }
}

async function onDataPortMessage(deviceId, msg) {
  if (!msg) return;
  if (
    msg.type === "send" ||
    msg.type === "sendFeature" ||
    msg.type === "receiveFeature"
  ) {
    const action =
      msg.type === "send"
        ? "sendReport"
        : msg.type === "sendFeature"
          ? "sendFeatureReport"
          : "receiveFeatureReport";
    const payload = { deviceId, reportId: msg.reportId };
    if (msg.type === "send" || msg.type === "sendFeature")
      payload.data = msg.data;
    const port = dataPorts.get(deviceId);
    try {
      const response = await browser.runtime.sendMessage(
        Object.assign({ action }, payload),
      );
      if (msg.type === "receiveFeature") {
        const data =
          response && http.isOk(response.s) && response.d ? response.d : null;
        if (port)
          port.postMessage({
            type: "featureResult",
            reqId: msg.reqId,
            data: data || null,
          });
      } else {
        const error = response && !http.isOk(response.s) ? "send failed" : null;
        if (port)
          port.postMessage({
            type: msg.type === "send" ? "sendResult" : "featureResult",
            reqId: msg.reqId,
            error: error,
          });
      }
    } catch {
      if (port)
        port.postMessage({
          type: msg.type === "send" ? "sendResult" : "featureResult",
          reqId: msg.reqId,
          error: "runtime error",
        });
    }
    return;
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "webhidDeviceEvent" && message.event) {
    const event = message.event;
    if (event.eventType === "input_report") {
      const port = dataPorts.get(event.deviceId);
      if (port) {
        const view = event.data;
        const buffer = view ? view.buffer || view : null;
        try {
          port.postMessage(
            { type: "inputReport", reportId: event.reportId, data: buffer },
            buffer ? [buffer] : [],
          );
        } catch {}
        return;
      }
    }
    if (event.eventType === "disconnect") {
      const port = dataPorts.get(event.deviceId);
      if (port) {
        try {
          port.postMessage({ type: "disconnect" });
        } catch {}
      }
    }
    replyToPage({ type: "event", event: event });
  }
});

(async () => {
  try {
    const resp = await browser.runtime.sendMessage({ action: "handshake" });
    if (resp && http.isOk(resp.s)) {
      const global = await browser.storage.local.get(GLOBAL_DEFAULTS);
      replyToPage({ type: "settings", settings: global });
    }
  } catch {}
})();
