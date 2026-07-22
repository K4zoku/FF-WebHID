"use strict";
const _logger = globalThis.webhid.import("logger");
const _http = globalThis.webhid.import("http");
const _GLOBAL_DEFAULTS = globalThis.webhid.import("GLOBAL_DEFAULTS");
_logger.initLogger("test-bridge");

let _pagePort = null;
let _devicePicker = null;
const _dataPorts = new Map();

function _replyToPage(msg, transfer) {
  if (!_pagePort) return;
  _pagePort.postMessage(msg, transfer);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.__webhid_bridge !== "init") return;
  if (_pagePort) return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  _pagePort = port;
  _pagePort.onmessage = (ev) => {
    handleRequest(ev.data, ev.ports);
  };
  _logger.debug("[test-bridge] page port established");
});

async function handleRequest(data, ports) {
  if (!data || data.__webhid_bridge !== "req") return;

  const { id, action, payload } = data;

  try {
    if (action === "requestDevice") {
      const filters = (payload && payload.filters) || [];
      if (!_devicePicker) {
        _devicePicker = new (globalThis.webhid.import(
          "WebHidDevicePicker",
        ))();
        document.documentElement.appendChild(_devicePicker.host);
      }
      let onSelected, onCancelled;
      onSelected = (e) => {
        window.removeEventListener("webhid-device-selected", onSelected);
        window.removeEventListener("webhid-device-cancelled", onCancelled);
        _replyToPage({
          __webhid_bridge: "res",
          id,
          result: { devices: e.detail.devices },
        });
      };
      onCancelled = () => {
        window.removeEventListener("webhid-device-selected", onSelected);
        window.removeEventListener("webhid-device-cancelled", onCancelled);
        _replyToPage({
          __webhid_bridge: "res",
          id,
          result: { cancelled: true },
        });
      };
      window.addEventListener("webhid-device-selected", onSelected);
      window.addEventListener("webhid-device-cancelled", onCancelled);
      _devicePicker.show(filters);
      return;
    }

    if (action === "data-port") {
      const deviceId = payload && payload.deviceId;
      const port = ports && ports[0];
      if (port && deviceId) {
        _dataPorts.set(deviceId, port);
        port.onmessage = (ev) => {
          _onDataPortMessage(deviceId, ev.data);
        };
      }
      _replyToPage({ __webhid_bridge: "res", id, result: { s: 204 } });
      return;
    }

    const msg = Object.assign({ action }, payload || {});
    const response = await browser.runtime.sendMessage(msg);
    const xfers =
      response && response.d instanceof Uint8Array ? [response.d.buffer] : [];
    _replyToPage({ __webhid_bridge: "res", id, result: response }, xfers);
  } catch (error) {
    _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
  }
}

async function _onDataPortMessage(deviceId, msg) {
  if (!msg) return;
  if (
    msg.type === "send" ||
    msg.type === "sendFeature" ||
    msg.type === "receiveFeature"
  ) {
    const action =
      msg.type === "send"
        ? "sendreport"
        : msg.type === "sendFeature"
          ? "sendfeaturereport"
          : "receivefeaturereport";
    const payload = { deviceId, reportId: msg.reportId };
    if (msg.type === "send" || msg.type === "sendFeature")
      payload.data = msg.data;
    const port = _dataPorts.get(deviceId);
    try {
      const response = await browser.runtime.sendMessage(
        Object.assign({ action }, payload),
      );
      if (msg.type === "receiveFeature") {
        const data =
          response && _http.isOk(response.s) && response.d ? response.d : null;
        if (port)
          port.postMessage({
            type: "featureResult",
            reqId: msg.reqId,
            data: data || null,
          });
      } else {
        const err = response && !_http.isOk(response.s) ? "send failed" : null;
        if (port)
          port.postMessage({
            type: msg.type === "send" ? "sendResult" : "featureResult",
            reqId: msg.reqId,
            error: err,
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
  if (message.action === "webhid-device-event" && message.event) {
    const ev = message.event;
    if (ev.eventType === "input_report") {
      const port = _dataPorts.get(ev.deviceId);
      if (port) {
        const view = ev.data;
        const buf = view ? view.buffer || view : null;
        try {
          port.postMessage(
            { type: "inputReport", reportId: ev.reportId, data: buf },
            buf ? [buf] : [],
          );
        } catch {}
        return;
      }
    }
    if (ev.eventType === "disconnect") {
      const port = _dataPorts.get(ev.deviceId);
      if (port) {
        try {
          port.postMessage({ type: "disconnect" });
        } catch {}
      }
    }
    _replyToPage({ __webhid_bridge: "evt", event: ev });
  }
});

(async () => {
  try {
    const resp = await browser.runtime.sendMessage({ action: "handshake" });
    if (resp && _http.isOk(resp.s)) {
      const global = await browser.storage.local.get(_GLOBAL_DEFAULTS);
      _replyToPage({ __webhid_bridge: "settings", settings: global });
    }
  } catch {}
})();
