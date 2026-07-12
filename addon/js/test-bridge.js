"use strict";
globalThis.__webhid.logger.initLogger("test-bridge");

let _pagePort = null;

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
  _pagePort.onmessage = (ev) => { handleRequest(ev.data); };
  globalThis.__webhid.logger.debug("[test-bridge] page port established");
});

async function handleRequest(data) {
  if (!data || data.__webhid_bridge !== "req") return;

  const { id, action, payload } = data;
  const msg = Object.assign({ action }, payload || {});

  try {
    if (action === "requestDevice") {
      browser.runtime.sendMessage({ action: "requestDevice", payload: { filters: payload.filters || [] } })
        .then((result) => {
          _replyToPage({ __webhid_bridge: "res", id, result });
        })
        .catch(() => {
          _replyToPage({ __webhid_bridge: "res", id, result: { cancelled: true } });
        });
      return;
    }

    const response = await browser.runtime.sendMessage(msg);
    const xfers = response && response.d instanceof Uint8Array ? [response.d.buffer] : [];
    _replyToPage({ __webhid_bridge: "res", id, result: response }, xfers);
  } catch (error) {
    _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "webhid-device-event" && message.event) {
    _replyToPage({ __webhid_bridge: "evt", event: message.event });
  }
});

(async () => {
  try {
    const resp = await browser.runtime.sendMessage({ action: "handshake" });
    if (resp && globalThis.__webhid.http.isOk(resp.s)) {
      const global = await browser.storage.local.get(globalThis.__webhid.GLOBAL_DEFAULTS);
      _replyToPage({ __webhid_bridge: "settings", settings: global });
    }
  } catch {}
})();
