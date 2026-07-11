// WebHID Standard implementation with injected modal

(function () {
  "use strict";

  // Device Picker Modal Class
  class WebHIDDevicePicker {
    #savedDevices = null;
    #deviceGroups = {};
    #cssReady = null;

    constructor() {
      this.devices = [];
      this.filters = [];
      this.dialog = null;
      this.shadowHost = null;
      this.shadowRoot = null;

      this.#init();
    }

    #init() {
      this.#injectShadowDOM();
      this.#setupEventListeners();
    }

    #injectShadowDOM() {
      const doInject = () => {
        if (document.getElementById("webhid-shadow-host")) return;
        if (!document.body) {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', doInject, { once: true });
          } else {
            requestAnimationFrame(doInject);
          }
          return;
        }

        this.shadowHost = document.createElement("div");
        this.shadowHost.id = "webhid-shadow-host";
        document.body.appendChild(this.shadowHost);

        this.shadowRoot = this.shadowHost.attachShadow({ mode: "closed" });

        this.#cssReady = this.#loadCSS();
        this.#createTemplates();
      };
      doInject();
    }

    async #loadCSS() {
      try {
        const [themeResp, cssResp] = await Promise.all([
          fetch(browser.runtime.getURL("css/theme.css")),
          fetch(browser.runtime.getURL("css/device-picker.css")),
        ]);
        const theme = await themeResp.text();
        const css   = await cssResp.text();
        const style = document.createElement("style");
        style.textContent = theme + "\n" + css;
        this.shadowRoot.appendChild(style);
      } catch (e) {
        __webhid.logger.warn("[WebHID] Failed to load shadow styles", e);
      }
    }

    #createTemplates() {
      if (this.shadowRoot.getElementById("webhid-modal-template")) return;

      const tpl = document.createElement("template");
      tpl.id = "webhid-modal-template";
      tpl.innerHTML = `
        <dialog class="webhid-modal">
          <form method="dialog" class="webhid-modal-form">
            <div class="webhid-modal-header">
              <h2>Select a HID Device</h2>
            </div>
            <div class="webhid-modal-content">
              <div class="webhid-device-list" id="webhidDeviceList">
                <div class="webhid-loading" id="webhidLoading">Loading devices...</div>
              </div>
            </div>
            <div class="webhid-modal-footer">
              <button type="submit" class="webhid-cancel-button" id="webhidCancelBtn" value="cancel">Cancel</button>
              <button type="submit" class="webhid-connect-button" id="webhidConnectBtn" value="selected" disabled>Connect</button>
            </div>
          </form>
        </dialog>
      `;
      const itemTpl = document.createElement("template");
      itemTpl.id = "webhid-device-item-template";
      itemTpl.innerHTML = `
        <label class="webhid-device-item" tabindex="0">
          <input type="radio" name="webhid-device" class="webhid-device-radio">
          <img class="webhid-device-icon" draggable="false">
          <div class="webhid-device-body">
            <div class="webhid-device-name"></div>
            <div class="webhid-device-vendor"></div>
            <div class="webhid-device-iface"></div>
          </div>
        </label>
      `;
      this.shadowRoot.appendChild(tpl);
      this.shadowRoot.appendChild(itemTpl);
    }

    #setupEventListeners() {
      browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "getOpenDeviceIds") {
          sendResponse({ ids: Array.from(_openDevices) });
          return true;
        }
      });
    }

    async show(filters = []) {
      if (this.dialog?.open) {
        this.dialog.close();
      }

      this.filters = filters;

      let tries = 0;
      while (!this.shadowRoot && tries < 100) {
        await new Promise(r => requestAnimationFrame(r));
        tries++;
      }
      if (!this.shadowRoot) {
        __webhid.logger.error('[WebHID] shadowRoot not initialized; cannot show device picker');
        this.#onDeviceCancelled();
        return;
      }

      await this.#cssReady;

      const tpl = this.shadowRoot.getElementById("webhid-modal-template");
      this.dialog = tpl.content.firstElementChild.cloneNode(true);
      this.shadowRoot.appendChild(this.dialog);

      this.dialog.addEventListener("close", () => {
        const returnValue = this.dialog.returnValue;
        const checked = this.dialog.querySelector(".webhid-device-radio:checked");
        const deviceId = checked?.value;
        this.dialog.remove();
        this.dialog = null;
        if (returnValue === "selected" && deviceId) {
          const devices = this.#deviceGroups[deviceId] || [];
          this.#onDeviceSelected(devices);
        } else {
          this.#onDeviceCancelled();
        }
      });

      this.dialog.addEventListener("change", (e) => {
        if (!e.target.matches(".webhid-device-radio")) return;
        this.dialog.querySelectorAll(".webhid-device-item")
          .forEach((el) => el.classList.remove("selected"));
        e.target.closest(".webhid-device-item").classList.add("selected");
        this.dialog.querySelector("#webhidConnectBtn").disabled = false;
      });

      this.dialog.addEventListener("click", (e) => {
        if (e.target === this.dialog) this.dialog.close();
      });

      if (typeof this.dialog.showModal === "function") {
        this.dialog.showModal();
      } else {
        this.dialog.setAttribute("open", "");
      }

      await this.#loadDevices();
    }

    async #loadDevices() {
      try {
        const response = await browser.runtime.sendMessage({ action: "enumerate" });
        if (response && response.success) {
          this.devices = response.devices || [];
          await this.#renderDevices();
        } else {
          this.devices = [];
          const errMsg = response?.error || "Unknown error";
          const userMsg = this.#classifyError(errMsg);
          __webhid.logger.error('[WebHID] enumerate failed:', errMsg);
          this.#showMessage(userMsg, true);
        }
      } catch (error) {
        this.devices = [];
        const errMsg = error?.message || String(error);
        const userMsg = this.#classifyError(errMsg);
        __webhid.logger.error('[WebHID] enumerate exception:', errMsg);
        this.#showMessage(userMsg, true);
      }
    }

    #classifyError(errMsg) {
      const e = (errMsg || "").toLowerCase();
      if (e.includes("nm disconnected") || e.includes("reconnecting"))
        return "Native messaging host is not responding. Please ensure the WebHID daemon is installed and running.";
      if (e.includes("permission denied") || e.includes("access denied"))
        return "Permission denied. The daemon may lack access to HID devices (check udev rules on Linux, or run daemon as admin on Windows).";
      if (e.includes("no such file") || e.includes("not found") || e.includes("connection refused"))
        return "Cannot connect to the WebHID daemon. Please install it and ensure the service is running.";
      if (e.includes("timeout") || e.includes("timed out"))
        return "Connection to the WebHID daemon timed out. Please check if the daemon is running.";
      return "Failed to load devices: " + errMsg;
    }

    #showMessage(message, isError = false) {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      deviceList.innerHTML = "";
      const div = document.createElement("div");
      div.className = isError ? "webhid-error" : "webhid-no-devices";
      div.textContent = message;
      deviceList.appendChild(div);
    }

    async #getSavedDevices() {
      if (this.#savedDevices !== null) {
        return this.#savedDevices;
      }
      try {
        const result = await browser.runtime.sendMessage({
          action: "getSavedDevices",
          origin: window.location.origin,
        });
        this.#savedDevices = result.hashes || [];
        return this.#savedDevices;
      } catch (error) {
        return [];
      }
    }

    async #deviceMatchesSaved(device) {
      const savedHashes = await this.#getSavedDevices();
      const deviceHash = __webhid.createDeviceHash(device);
      return savedHashes.includes(deviceHash);
    }

    async #renderDevices() {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      deviceList.innerHTML = "";

      if (this.devices.length === 0) {
        deviceList.innerHTML = '<div class="webhid-no-devices">No HID devices found</div>';
        return;
      }

      const filteredDevices = this.#applyFilters(this.devices, this.filters);
      if (filteredDevices.length === 0) {
        deviceList.innerHTML = '<div class="webhid-no-devices">No devices match the specified filters</div>';
        return;
      }

      const groups = new Map();
      for (const device of filteredDevices) {
        const name = device.productName || "Unknown Device";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(device);
      }

      const pairedStatuses = await Promise.all(
        filteredDevices.map((device) => this.#deviceMatchesSaved(device))
      );

      this.#deviceGroups = {};

      const tpl = this.shadowRoot.getElementById("webhid-device-item-template");

      for (const [name, devices] of groups.entries()) {
        let isPaired = false;
        const deviceIds = [];
        for (const d of devices) {
          const idx = filteredDevices.indexOf(d);
          if (idx >= 0 && pairedStatuses[idx]) isPaired = true;
          deviceIds.push(d.deviceId);
        }

        const groupId = devices.length === 1
          ? devices[0].deviceId
          : `group:${__webhid.createDeviceHash(devices[0])}`;
        this.#deviceGroups[groupId] = devices.slice();

        const device = devices[0];
        const deviceId = groupId;
        const type = __webhid.guessDeviceType(device);
        const iconUrl = browser.runtime.getURL(`res/${type}.svg`);

        const clone = tpl.content.cloneNode(true);
        const item  = clone.querySelector(".webhid-device-item");
        const radio = clone.querySelector(".webhid-device-radio");

        radio.value = deviceId;
        item.classList.toggle("webhid-device-paired", isPaired);
        item.dataset.deviceId = deviceId;

        const icon = clone.querySelector(".webhid-device-icon");
        icon.src = iconUrl;
        icon.alt = type;

        clone.querySelector(".webhid-device-name").textContent = name;

        const vendor = clone.querySelector(".webhid-device-vendor");
        device.manufacturer
          ? (vendor.textContent = device.manufacturer)
          : vendor.remove();

        const iface = clone.querySelector(".webhid-device-iface");
        devices.length > 1
          ? (iface.textContent = `${devices.length} interfaces`)
          : iface.remove();

        deviceList.appendChild(clone);
      }
    }

    #applyFilters(devices, filters) {
      if (!Array.isArray(filters) || filters.length === 0) {
        return devices;
      }
      return devices.filter((device) => {
        return filters.some((filter) => {
          if (filter.vendorId && device.vendorId !== filter.vendorId)
            return false;
          if (filter.productId && device.productId !== filter.productId)
            return false;
          if (filter.usagePage && device.usagePage !== filter.usagePage)
            return false;
          if (filter.usage && device.usage !== filter.usage) return false;
          return true;
        });
      });
    }

    #onDeviceSelected(devices) {
      const devicesArr = Array.isArray(devices) ? devices : [devices];

      const event = new CustomEvent("webhid-device-selected", {
        detail: { devices: devicesArr },
      });

      (async () => {
        try {
          const saved = await this.#getSavedDevices();
          for (const d of devicesArr) {
            const h = __webhid.createDeviceHash(d);
            if (!saved.includes(h)) saved.push(h);
          }
          this.#savedDevices = saved;
        } catch (e) { /* ignore */ }
      })();

      window.dispatchEvent(event);
    }

    #onDeviceCancelled() {
      const event = new CustomEvent("webhid-device-cancelled", { detail: {} });
      window.dispatchEvent(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Initialize device picker (runs in content script world; needs browser.* APIs
  // and DOM access for the modal).
  // ---------------------------------------------------------------------------
  const devicePicker = new WebHIDDevicePicker();

  // ---------------------------------------------------------------------------
  // Content script ↔ Page bridge
  //
  // Page  →  content script:  postMessage({ __webhid_bridge: 'req', id, action, payload })
  // Content script  →  page:  postMessage({ __webhid_bridge: 'res', id, result })
  //                           postMessage({ __webhid_bridge: 'evt', event })
  // ---------------------------------------------------------------------------
  const _openDevices = new Set();
  const _sessionTokens = new Map();
  const _workers = new Map();
  const _workerCallbacks = new Map();
  const _workerReady = new Set();
  const _workerQueues = new Map();
  const _workerPorts = new Map(); // deviceId → true (port active, skip bridge re-forward)
  let _wsPort = null;
  let _controlPlane = 'nm';
  let _controlWorker = null;
  let _controlPort = null;
  const _controlPending = new Map();
  let _controlReqId = 1;
  const _spawnGen = new Map();

  async function _spawnControlWorker(token, wsPort) {
    if (_controlWorker) return;
    try {
      const [loggerResp, defaultsResp, controlResp] = await Promise.all([
        fetch(browser.runtime.getURL('js/utils/logger.js')),
        fetch(browser.runtime.getURL('js/utils/settings-defaults.js')),
        fetch(browser.runtime.getURL('js/control.js')),
      ]);
      const [loggerCode, defaultsCode, controlCode] = await Promise.all([
        loggerResp.text(),
        defaultsResp.text(),
        controlResp.text(),
      ]);
      const blob = new Blob([loggerCode + '\n' + defaultsCode + '\n' + controlCode], { type: 'application/javascript' });
      _controlWorker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      __webhid.logger.error('[bridge] control worker spawn failed:', e);
      _controlWorker = null;
      return;
    }

    const { port1, port2 } = new MessageChannel();
    _controlPort = port1;

    _controlPort.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        __webhid.logger.info('[bridge] control worker ready');
      } else if (data.type === 'closed') {
        __webhid.logger.warn('[bridge] control worker WS closed; will auto-reconnect');
        for (const [, { resolve }] of _controlPending) resolve({ success: false, error: 'WS control closed' });
        _controlPending.clear();
      } else if (data.type === 'response' && data.id && _controlPending.has(data.id)) {
        const { resolve } = _controlPending.get(data.id);
        _controlPending.delete(data.id);
        resolve(data.result);
      }
    };

    _controlWorker.postMessage({ type: 'connect', token, wsPort, logLevel: __webhid.logger._level }, [port2]);
    __webhid.logger.info('[bridge] control worker spawned');
  }

  function _terminateControlWorker() {
    if (_controlPort) { _controlPort.onmessage = null; _controlPort.close(); _controlPort = null; }
    if (_controlWorker) { _controlWorker.postMessage({ type: 'disconnect' }); _controlWorker.terminate(); _controlWorker = null; }
    for (const [, { resolve }] of _controlPending) resolve({ success: false, error: 'WS control closed' });
    _controlPending.clear();
  }

  function _sendControlCommand(action, payload) {
    return new Promise((resolve) => {
      if (!_controlPort) {
        resolve({ success: false, error: 'WS control not connected' });
        return;
      }
      const id = _controlReqId++;
      _controlPending.set(id, { resolve });
      _controlPort.postMessage({ type: 'command', id, action, payload });
    });
  }

  // Tear down the data-plane worker for a device. Increments spawn generation
  // so that any async _spawnWorker fetch in flight knows it's stale.
  function _despawnDataPlane(deviceId) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    const worker = _workers.get(deviceId);
    if (worker) { worker.terminate(); _workers.delete(deviceId); }
    _workerCallbacks.delete(deviceId);
    _workerReady.delete(deviceId);
    _workerQueues.delete(deviceId);
    _workerPorts.delete(deviceId);
  }

  async function _spawnWorker(deviceId, sessionToken, wsPort, opts = {}, gen) {
    if (_workers.has(deviceId)) return;
    let worker;
    try {
      const [loggerResp, defaultsResp, workerResp] = await Promise.all([
        fetch(browser.runtime.getURL('js/utils/logger.js')),
        fetch(browser.runtime.getURL('js/utils/settings-defaults.js')),
        fetch(browser.runtime.getURL('js/worker.js')),
      ]);
      const [loggerCode, defaultsCode, workerCode] = await Promise.all([
        loggerResp.text(),
        defaultsResp.text(),
        workerResp.text(),
      ]);
      const blob = new Blob([loggerCode + '\n' + defaultsCode + '\n' + workerCode], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      __webhid.logger.error('[bridge] worker fetch/spawn failed:', e);
      return;
    }

    // Stale check: a newer spawn or despawn happened while we were fetching.
    if (_spawnGen.get(deviceId) !== gen) {
      __webhid.logger.info('[bridge] worker spawn stale, discarding for', deviceId);
      worker.terminate();
      _workers.delete(deviceId);
      return;
    }
    _workers.set(deviceId, worker);

    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        __webhid.logger.info('[bridge] worker ready for', deviceId);
        _workerReady.add(deviceId);
        const queue = _workerQueues.get(deviceId);
        if (queue) {
          for (const wMsg of queue) {
            worker.postMessage(wMsg, wMsg.data ? [wMsg.data.buffer] : []);
          }
          _workerQueues.delete(deviceId);
        }
        // Create MessageChannel: port1 → worker (direct input reports),
        // port2 → page (bypass bridge for input reports).
        const { port1, port2 } = new MessageChannel();
        worker.postMessage({ type: 'setPort' }, [port1]);
        _workerPorts.set(deviceId, true);
        __webhid.logger.info('[bridge] MessageChannel created for', deviceId, '— input reports bypass bridge');
        window.postMessage({
          __webhid_bridge: 'evt',
          event: { eventType: 'webhid-data-ready', deviceId: deviceId, port: port2 }
        }, '*', [port2]);
      } else if (data.type === 'closed') {
        __webhid.logger.warn('[bridge] worker closed for', deviceId);
        _workers.delete(deviceId);
        _workerReady.delete(deviceId);
        _workerPorts.delete(deviceId);
        window.postMessage({
          __webhid_bridge: 'evt',
          event: { eventType: 'disconnect', deviceId: deviceId }
        }, '*');
      } else if (data.type === 'inputReport') {
        // Only reaches here if port not active (fallback path).
        if (_workerPorts.has(deviceId)) return;
        const view = data.data ? new Uint8Array(data.data) : null;
        if (view && __webhid.logger._level >= 3 && data.reportId !== 33) {
          let hex = '';
          for (let i = 0; i < Math.min(8, view.length); i++) hex += view[i].toString(16).padStart(2, '0') + ' ';
          __webhid.logger.debug('[bridge] worker→page inputReport device=' + deviceId + ' reportId=' + data.reportId + ' len=' + view.length + ' first8=' + hex);
        }
        window.postMessage({
          __webhid_bridge: 'evt',
          event: {
            eventType: 'input_report',
            deviceId: deviceId,
            reportId: data.reportId,
            data: view,
          }
        }, '*', view ? [view.buffer] : []);
      } else if (data.type === 'sendResult' || data.type === 'featureResult') {
        const cbMap = _workerCallbacks.get(deviceId);
        if (cbMap && cbMap.has(data.reqId)) {
          const cb = cbMap.get(data.reqId);
          cbMap.delete(data.reqId);
          if (data.error) cb({ success: false, error: data.error });
          else if (data.data) cb({ success: true, data: data.data });
          else cb({ success: true });
        }
      }
    };
    worker.postMessage({ type: 'connect', wsPort, token: sessionToken, reportSize: opts.reportSize || 64 });
  }

  // Spawn the WS data plane for a device. Always uses a Web Worker (off
  // main thread). If worker spawn fails, falls back to NM by telling the
  // daemon to use NM mode for this device — data then flows through the
  // normal NM path (page → bridge → background → NM host → daemon).
  async function _spawnDataPlane(deviceId, sessionToken, wsPort, opts = {}) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    await _spawnWorker(deviceId, sessionToken, wsPort, opts, gen);
    // If worker spawn failed (worker not in map), fall back to NM.
    if (!_workers.has(deviceId) && _spawnGen.get(deviceId) === gen) {
      __webhid.logger.warn('[bridge] worker spawn failed for', deviceId, '; falling back to NM');
      browser.runtime.sendMessage({
        action: 'setdataplane', deviceId: deviceId, mode: 'nm'
      }).catch(() => {});
    }
  }

  // Init: send handshake to get wsPort. Only spawn control worker if
  // control plane setting is 'ws'. If 'nm', just store wsPort for
  // data plane use (open() sends WS data plane via _spawnDataPlane).
  (async () => {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'handshake' });
      if (resp.success && resp.wsPort) {
        _wsPort = resp.wsPort;
        const global = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
        let cp = global.controlPlane;
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          if (ss.controlPlane !== undefined) cp = ss.controlPlane;
        }
        _controlPlane = cp;
        if (cp === 'ws' && resp.controlToken) {
          _spawnControlWorker(resp.controlToken, resp.wsPort);
        }
      }
    } catch (e) {
      __webhid.logger.warn('[bridge] handshake failed:', e.message);
    }
  })();

  window.addEventListener("message", async (event) => {
    if (!event.data || event.data.__webhid_bridge !== "req") return;

    const { id, action: reqAction, payload } = event.data;
    let action = reqAction;
    const isFireAndForget = event.data.fireAndForget === true;
    __webhid.logger.debug('[bridge] req action=' + action + ' id=' + id + (isFireAndForget ? ' (faf)' : ''));

    // Settings fetch — page (MAIN world) has no browser.* APIs.
    // Merge per-site overrides on top of global defaults.
    if (action === "getSettings") {
      try {
        const global = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          for (const k of Object.keys(__webhid.GLOBAL_DEFAULTS)) {
            if (ss[k] !== undefined) global[k] = ss[k];
          }
        }
        _controlPlane = global.controlPlane;
        window.postMessage({ __webhid_bridge: "res", id, result: global }, "*");
      } catch (e) {
        window.postMessage({ __webhid_bridge: "res", id, result: {} }, "*");
      }
      return;
    }

    // Normalize NM actions → worker actions when device has a worker data
    // plane (happens when polyfill hasn't received dataPlane push yet).
    if ((action === "sendreport" || action === "sendfeaturereport" || action === "receivefeaturereport")
        && payload && payload.deviceId
        && _workers.has(payload.deviceId)) {
      action = action === "sendreport" ? "worker-send"
             : action === "sendfeaturereport" ? "worker-sendFeature"
             : "worker-receiveFeature";
    }

    // Hot-path actions: use worker WS → NM (priority order).
    if (action === "worker-send" || action === "worker-sendFeature" || action === "worker-receiveFeature") {
      const deviceId = payload.deviceId;

      // Worker WS data plane.
      const worker = _workers.get(deviceId);
      if (worker && _workerReady.has(deviceId)) {
        const wType =
          action === "worker-send" ? "send" :
          action === "worker-sendFeature" ? "sendFeature" :
          "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "worker-send" || action === "worker-sendFeature") wMsg.data = payload.data;

        if (!isFireAndForget || action === "worker-receiveFeature") {
          let cbMap = _workerCallbacks.get(deviceId);
          if (!cbMap) { cbMap = new Map(); _workerCallbacks.set(deviceId, cbMap); }
          cbMap.set(id, (data) => {
            const result = data.error ? { success: false, error: data.error }
                        : data.data ? { success: true, data: data.data }
                        : { success: data.success !== false };
            const xfers = result.data instanceof Uint8Array ? [result.data.buffer] : [];
            window.postMessage({ __webhid_bridge: "res", id, result }, "*", xfers.length ? xfers : undefined);
          });
        }
        worker.postMessage(wMsg);
        return;
      }

      // Worker exists but not ready yet → queue for replay on ready.
      if (worker) {
        const wType =
          action === "worker-send" ? "send" :
          action === "worker-sendFeature" ? "sendFeature" :
          "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.reportId };
        if (action === "worker-send" || action === "worker-sendFeature") wMsg.data = payload.data;

        if (!isFireAndForget || action === "worker-receiveFeature") {
          let cbMap = _workerCallbacks.get(deviceId);
          if (!cbMap) { cbMap = new Map(); _workerCallbacks.set(deviceId, cbMap); }
          cbMap.set(id, (data) => {
            const result = data.error ? { success: false, error: data.error }
                        : data.data ? { success: true, data: data.data }
                        : { success: data.success !== false };
            const xfers = result.data instanceof Uint8Array ? [result.data.buffer] : [];
            window.postMessage({ __webhid_bridge: "res", id, result }, "*", xfers.length ? xfers : undefined);
          });
        }

        if (!_workerQueues.has(deviceId)) _workerQueues.set(deviceId, []);
        _workerQueues.get(deviceId).push(wMsg);
        return;
      }

      __webhid.logger.warn('[bridge] no worker for', deviceId, '; falling back to NM');
      const fallbackAction =
        action === "worker-send" ? "sendreport" :
        action === "worker-sendFeature" ? "sendfeaturereport" :
        "receivefeaturereport";
      try {
        const msg = Object.assign({ action: fallbackAction }, payload || {});
        if (isFireAndForget && action !== "worker-receiveFeature") {
          browser.runtime.sendMessage(msg).catch(() => {});
          return;
        }
        const response = await browser.runtime.sendMessage(msg);
        window.postMessage({ __webhid_bridge: "res", id, result: response }, "*");
      } catch (error) {
        window.postMessage({ __webhid_bridge: "res", id, result: { success: false, error: error.message } }, "*");
      }
      return;
    }

    // requestDevice is special: we show the content-script-side picker modal
    // and resolve via the webhid-device-selected / webhid-device-cancelled
    // custom events it dispatches.
    if (action === "requestDevice") {
      let onSelected, onCancelled;

      const cleanup = () => {
        window.removeEventListener("webhid-device-selected", onSelected);
        window.removeEventListener("webhid-device-cancelled", onCancelled);
      };

      onSelected = (e) => {
        cleanup();
        // result contains an array of devices under `devices`
        window.postMessage(
          { __webhid_bridge: "res", id, result: { devices: e.detail.devices } },
          "*",
        );
      };

      onCancelled = () => {
        cleanup();
        window.postMessage(
          { __webhid_bridge: "res", id, result: { cancelled: true } },
          "*",
        );
      };

      window.addEventListener("webhid-device-selected", onSelected);
      window.addEventListener("webhid-device-cancelled", onCancelled);
      devicePicker.show((payload && payload.filters) || []);
      return;
    }

    // All other actions (enumerate / open / close / read / write) are forwarded
    // to the background script via the native-messaging port, or via control
    // worker if WS control plane is enabled and connected.
    try {
      // WS control plane: route enumerate/close via control worker.
      // open always goes via NM (needs sessionToken per device).
      if (_controlPlane === 'ws' && _controlPort
          && (action === 'enumerate' || action === 'close')) {
        const response = await _sendControlCommand(action, payload || {});
        window.postMessage({ __webhid_bridge: "res", id, result: response }, "*");
        return;
      }

      const msg = Object.assign({ action }, payload || {});
      const response = await browser.runtime.sendMessage(msg);

      if (action === "open" && response.success && response.sessionToken) {
        const deviceId = response.deviceId;
        _openDevices.add(deviceId);
        _sessionTokens.set(deviceId, response.sessionToken);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        __webhid.logger.debug('[bridge] open ok deviceId=' + deviceId + ' wsPort=' + response.wsPort);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;

        const globalDefaults = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
        let dataPlane = globalDefaults.dataPlane;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          if (ss.dataPlane !== undefined) dataPlane = ss.dataPlane;
        }

        browser.runtime.sendMessage({
          action: "setdataplane",
          deviceId: deviceId,
          mode: dataPlane,
        }).catch(() => {});

        if (dataPlane === 'ws') {
          _spawnDataPlane(deviceId, response.sessionToken, response.wsPort || _wsPort);
        }
      }

      if (action === "close") {
        const deviceId = payload.deviceId;
        __webhid.logger.debug('[bridge] close deviceId=' + deviceId);
        _openDevices.delete(deviceId);
        _sessionTokens.delete(deviceId);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        _despawnDataPlane(deviceId);
      }

      window.postMessage({ __webhid_bridge: "res", id, result: response }, "*");
    } catch (error) {
      window.postMessage(
        {
          __webhid_bridge: "res",
          id,
          result: { success: false, error: error.message },
        },
        "*",
      );
    }
  });



  // Forward events pushed by background.js into the page world.
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhid-device-event" && message.event) {
      const evt = message.event;
      if (evt.eventType === "handshake") {
        _wsPort = evt.wsPort;
        __webhid.logger.info('[bridge] handshake: wsPort=' + _wsPort);
        return;
      }
      window.postMessage({ __webhid_bridge: "evt", event: evt }, "*");
    }
  });

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;

    const origin = window.location.origin;
    const siteKey = origin ? `site:${origin}` : null;

    // Compute effective settings BEFORE the change (what we currently have).
    const before = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
    if (siteKey) {
      const siteResult = await browser.storage.local.get(siteKey);
      const ss = siteResult[siteKey] || {};
      for (const k of Object.keys(__webhid.GLOBAL_DEFAULTS)) {
        if (ss[k] !== undefined) before[k] = ss[k];
      }
    }

    // Determine which keys changed (global or site-level).
    const changed = {};
    for (const k of ['dataPlane', 'controlPlane', 'fireAndForget', 'logLevel', 'perfLogging']) {
      if (changes[k]) changed[k] = changes[k].newValue;
      if (siteKey && changes[siteKey]) {
        const ss = changes[siteKey].newValue || {};
        if (ss[k] !== undefined) changed[k] = ss[k];
      }
    }

    // Compute effective settings AFTER the change.
    const after = { ...before };
    for (const [k, v] of Object.entries(changed)) {
      after[k] = v;
    }

    // Only act on settings whose EFFECTIVE value actually changed.
    const effective = {};
    for (const k of Object.keys(changed)) {
      if (before[k] !== after[k]) {
        effective[k] = after[k];
      }
    }

    if (Object.keys(effective).length === 0) return;

    // Push changed settings to the page.
    {
      const settings = {};
      for (const k of Object.keys(effective)) {
        settings[k] = effective[k];
      }
      window.postMessage({ __webhid_bridge: "settings", settings }, "*");
    }

    // Forward fire-and-forget / logLevel / perfLogging to workers (only if changed).
    const workerMsg = { type: 'settings' };
    let hasWorkerSettings = false;
    if (effective.fireAndForget !== undefined) { workerMsg.fireAndForget = effective.fireAndForget; hasWorkerSettings = true; }
    if (effective.logLevel !== undefined) { workerMsg.logLevel = effective.logLevel; hasWorkerSettings = true; }
    if (effective.perfLogging !== undefined) { workerMsg.perfLogging = effective.perfLogging; hasWorkerSettings = true; }
    if (hasWorkerSettings) {
      for (const worker of _workers.values()) worker.postMessage(workerMsg);
      if (_controlWorker) _controlWorker.postMessage(workerMsg);
    }

    // Control plane change: only act if effective value changed.
    if (effective.controlPlane !== undefined) {
      const cp = effective.controlPlane;
      _controlPlane = cp;
      __webhid.logger.info('[bridge] control plane changed:', cp);
      if (cp === 'ws' && _wsPort && !_controlWorker) {
        const resp = await browser.runtime.sendMessage({ action: 'handshake' });
        if (resp.success && resp.controlToken && resp.wsPort) {
          _wsPort = resp.wsPort;
          _spawnControlWorker(resp.controlToken, resp.wsPort);
        }
      } else if (cp === 'nm' && _controlWorker) {
        _terminateControlWorker();
      }
    }

    // Data plane change: only act if effective value changed.
    if (effective.dataPlane !== undefined) {
      const dp = effective.dataPlane;
      for (const id of _openDevices) { _despawnDataPlane(id); }

      if (dp === 'ws') {
        for (const id of _openDevices) {
          const token = _sessionTokens.get(id);
          if (token) _spawnDataPlane(id, token, _wsPort);
        }
      }
      for (const id of _openDevices) {
        browser.runtime.sendMessage({
          action: "setdataplane",
          deviceId: id,
          mode: dp,
        }).catch(() => {});
      }
      __webhid.logger.info('[bridge] data plane changed:', dp, 'open devices:', _openDevices.size);
    }
  });
})();
