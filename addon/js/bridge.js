// WebHID Standard implementation with injected modal

(function () {
  "use strict";

  // Device Picker Modal Class
  class WebHIDDevicePicker {
    constructor() {
      this.devices = [];
      this.filters = [];
      this.dialog = null;

      this._savedDevices = null;
      this._deviceGroups = {};

      this.shadowHost = null;
      this.shadowRoot = null;
      this._cssReady = null;

      this.init();
    }

    init() {
      this.injectShadowDOM();
      this.setupEventListeners();
    }

    injectShadowDOM() {
      // Defer until document.body is available. Bridge may run during
      // document parsing (readyState === 'loading') when body is null.
      const doInject = () => {
        if (document.getElementById("webhid-shadow-host")) return;
        if (!document.body) {
          // Body not ready yet; retry on next tick.
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

        this._cssReady = this._loadCSS();
        this._createTemplates();
      };
      doInject();
    }

    async _loadCSS() {
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

    _createTemplates() {
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

    setupEventListeners() {
      browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "show-device-picker") {
          this.show(request.filters || []);
          sendResponse({ success: true });
          return true;
        }
        if (request.action === "device-selected") {
          this.hide();
          this.onDeviceSelected(request.device);
          sendResponse({ success: true });
          return true;
        }
        if (request.action === "device-cancelled") {
          this.hide();
          this.onDeviceCancelled();
          sendResponse({ success: true });
          return true;
        }
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

      // Wait for shadowRoot to be injected (deferred until body ready).
      let tries = 0;
      while (!this.shadowRoot && tries < 100) {
        await new Promise(r => requestAnimationFrame(r));
        tries++;
      }
      if (!this.shadowRoot) {
        __webhid.logger.error('[WebHID] shadowRoot not initialized; cannot show device picker');
        this.onDeviceCancelled();
        return;
      }

      await this._cssReady;

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
          const devices = this._deviceGroups[deviceId] || [];
          this.onDeviceSelected(devices);
        } else {
          this.onDeviceCancelled();
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

      await this.loadDevices();
    }

    hide() {
      if (this.dialog?.open) {
        this.dialog.close();
      }
    }

    async loadDevices() {
      try {
        const response = await browser.runtime.sendMessage({
          action: "enumerate",
        });
        if (response && response.success) {
          this.devices = response.devices || [];
          await this.renderDevices();
        } else {
          // Daemon/NM returned an error; classify it for the user.
          this.devices = [];
          const errMsg = response?.error || "Unknown error";
          const userMsg = this._classifyError(errMsg);
          __webhid.logger.error('[WebHID] enumerate failed:', errMsg);
          this._showMessage(userMsg, true);
        }
      } catch (error) {
        // NM host unreachable or crashed.
        this.devices = [];
        const errMsg = error?.message || String(error);
        const userMsg = this._classifyError(errMsg);
        __webhid.logger.error('[WebHID] enumerate exception:', errMsg);
        this._showMessage(userMsg, true);
      }
    }

    // Map low-level error strings to human-readable messages so the user
    // knows what to fix (install daemon, start service, fix udev rules, …).
    _classifyError(errMsg) {
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

    // Replace the device list content with a single message (info or error).
    _showMessage(message, isError = false) {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      deviceList.innerHTML = "";
      const div = document.createElement("div");
      div.className = isError ? "webhid-error" : "webhid-no-devices";
      div.textContent = message;
      deviceList.appendChild(div);
    }

    async getSavedDevices() {
      // Return cached hashes if available
      if (this._savedDevices !== null) {
        return this._savedDevices;
      }

      try {
        const result = await browser.runtime.sendMessage({
          action: "getSavedDevices",
          origin: window.location.origin,
        });
        this._savedDevices = result.hashes || [];
        return this._savedDevices;
      } catch (error) {
        return [];
      }
    }

    async deviceMatchesSaved(device) {
      const savedHashes = await this.getSavedDevices();
      const deviceHash = __webhid.createDeviceHash(device);
      return savedHashes.includes(deviceHash);
    }

    async renderDevices() {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      // Clear loading text (or any previous content) before rendering.
      deviceList.innerHTML = "";

      if (this.devices.length === 0) {
        deviceList.innerHTML =
          '<div class="webhid-no-devices">No HID devices found</div>';
        return;
      }

      const filteredDevices = this.applyFilters(this.devices, this.filters);
      if (filteredDevices.length === 0) {
        deviceList.innerHTML =
          '<div class="webhid-no-devices">No devices match the specified filters</div>';
        return;
      }

      // Group devices by display name so ambiguous (same-name) devices are
      // shown as a single picker item but selecting that item returns all
      // underlying HID interfaces as an array.
      const groups = new Map();
      for (const device of filteredDevices) {
        const name = device.product_name || "Unknown Device";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(device);
      }

      // Use Promise.all to properly await all paired status checks in parallel
      const pairedStatuses = await Promise.all(
        filteredDevices.map((device) => this.deviceMatchesSaved(device))
      );

      // Build device groups mapping for selection lookup
      this._deviceGroups = {};

      const tpl = this.shadowRoot.getElementById("webhid-device-item-template");

      for (const [name, devices] of groups.entries()) {
        // Determine if any device in this group is paired (saved)
        let isPaired = false;
        const deviceIds = [];
        for (const d of devices) {
          // Find index of this device in filteredDevices to read pairedStatuses
          const idx = filteredDevices.indexOf(d);
          if (idx >= 0 && pairedStatuses[idx]) isPaired = true;
          deviceIds.push(d.device_id);
        }

        // Create a stable group id. For single-device groups use the path so
        // external code relying on unique paths continues to work; for multi-
        // interface groups use a generated id prefixed with 'group:'.
        const groupId = devices.length === 1 ? devices[0].device_id : `group:${__webhid.createDeviceHash(devices[0])}`;
        this._deviceGroups[groupId] = devices.slice(); // store copy

        // Use the first device to determine icon/type/manufacturer
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

    applyFilters(devices, filters) {
      if (!Array.isArray(filters) || filters.length === 0) {
        return devices;
      }
      return devices.filter((device) => {
        return filters.some((filter) => {
          if (filter.vendorId && device.vendor_id !== filter.vendorId)
            return false;
          if (filter.productId && device.product_id !== filter.productId)
            return false;
          if (filter.usagePage && device.usage_page !== filter.usagePage)
            return false;
          if (filter.usage && device.usage !== filter.usage) return false;
          return true;
        });
      });
    }

    selectDevice(item) {
      const radio = item.querySelector(".webhid-device-radio");
      if (!radio) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }

    onDeviceSelected(devices) {
          // Normalize to an array so consumers always receive an array of devices
          const devicesArr = Array.isArray(devices) ? devices : [devices];

          // Dispatch event with the devices array and update local saved-hashes cache asynchronously.
          const event = new CustomEvent("webhid-device-selected", {
            detail: { devices: devicesArr },
          });

          // Update local saved devices cache so the UI reflects pairing state
          (async () => {
            try {
              const saved = await this.getSavedDevices();
              for (const d of devicesArr) {
                const h = __webhid.createDeviceHash(d);
                if (!saved.includes(h)) saved.push(h);
              }
              this._savedDevices = saved;
            } catch (e) {
              // ignore
            }
          })();

          window.dispatchEvent(event);
        }

    onDeviceCancelled() {
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
  const _workers = new Map();
  const _workerCallbacks = new Map();
  const _openDevices = new Set();
  const _sessionTokens = new Map();
  const _workerReady = new Set();
  let _wsPort = null;
  let _controlPlane = 'nm';
  let _controlWs = null;
  const _controlPending = new Map();
  let _controlReqId = 1;

  function _connectControlWs(token, wsPort) {
    if (_controlWs) return;
    try {
      _controlWs = new WebSocket(`ws://127.0.0.1:${wsPort}`, [`webhid.${token}`]);
      _controlWs.binaryType = 'arraybuffer';
      _controlWs.onmessage = ({ data }) => {
        if (typeof data !== 'string') return;
        try {
          const msg = JSON.parse(data);
          if (msg.id && _controlPending.has(msg.id)) {
            const { resolve } = _controlPending.get(msg.id);
            _controlPending.delete(msg.id);
            resolve(msg);
          }
        } catch {}
      };
      _controlWs.onclose = () => {
        _controlWs = null;
        for (const [, { resolve }] of _controlPending) resolve({ success: false, error: 'WS control closed' });
        _controlPending.clear();
      };
      _controlWs.onerror = () => {};
      __webhid.logger.info('[bridge] control WS connected to ws://127.0.0.1:' + wsPort);
    } catch (e) {
      __webhid.logger.warn('[bridge] control WS connect failed:', e.message);
      _controlWs = null;
    }
  }

  async function _spawnWorker(deviceId, session_token, opts = {}) {
    const wsPort = opts.wsPort || _wsPort;
    const reportSize = opts.reportSize || 2048;
    const sabCapacity = opts.sabCapacity || 8192;
    const logLevel = opts.logLevel || 1;

    let worker;
    try {
      const [loggerResp, workerResp] = await Promise.all([
        fetch(browser.runtime.getURL('js/utils/logger.js')),
        fetch(browser.runtime.getURL('js/worker.js')),
      ]);
      const [loggerCode, workerCode] = await Promise.all([
        loggerResp.text(),
        workerResp.text(),
      ]);
      const blob = new Blob([loggerCode + '\n' + workerCode], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      __webhid.logger.error('[bridge] worker spawn failed:', e);
      return null;
    }

    _workers.set(deviceId, worker);

    worker.onerror = (e) => {
      __webhid.logger.error('[bridge] worker.onerror:', e.message || '(no msg)', 'file=', e.filename, 'line=', e.lineno);
    };

    const wid = deviceId;
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        _workerReady.add(wid);
        __webhid.logger.info('[bridge] worker ready for', wid, data.sab ? '(SAB)' : '(postMessage fallback)');
        if (data.sab) {
          window.postMessage({
            __webhid_bridge: 'evt',
            event: {
              event_type: 'webhid-sab',
              device_id: wid,
              sab: data.sab,
              reportSize,
            }
          }, '*');
        } else {
          window.postMessage({
            __webhid_bridge: 'evt',
            event: {
              event_type: 'webhid-sab-disabled',
              device_id: wid,
            }
          }, '*');
        }
        return;
      }
      if (data.type === 'inputReport') {
        const transfer = data.data instanceof ArrayBuffer ? [data.data] : [];
        window.postMessage({
          __webhid_bridge: 'evt',
          event: {
            event_type: 'input_report',
            device_id: wid,
            report_id: data.reportId,
            data: data.data,
          }
        }, '*', transfer);
        return;
      }
      if (data.type === 'error') {
        __webhid.logger.error('[bridge] worker error:', data.error);
        return;
      }
      if (data.type === 'closed') {
        _workerReady.delete(wid);
        __webhid.logger.warn('[bridge] worker WS closed for', wid, '; worker will auto-reconnect');
        const cbMap = _workerCallbacks.get(worker);
        if (cbMap) {
          for (const [reqId, cb] of cbMap) cb({ type: 'sendResult', reqId, error: 'ws closed' });
          cbMap.clear();
        }
        window.postMessage({
          __webhid_bridge: 'evt',
          event: { event_type: 'disconnect', device_id: wid }
        }, '*');
        return;
      }
      if (data.type === 'sendResult' || data.type === 'featureResult') {
        const cbMap = _workerCallbacks.get(worker);
        if (cbMap) {
          const cb = cbMap.get(data.reqId);
          if (cb) { cbMap.delete(data.reqId); cb(data); }
          else __webhid.logger.warn('[bridge] worker response for unknown reqId=', data.reqId, 'cbMap size=', cbMap.size);
        }
      }
    };

    worker.postMessage({
      type: 'connect',
      token: session_token,
      wsPort,
      reportSize,
      capacity: sabCapacity,
      logLevel,
    });

    const s = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
    worker.postMessage({ type: 'settings', fireAndForget: s.fireAndForget, perfLogging: s.perfLogging, logLevel: s.logLevel });

    return worker;
  }

  function _sendControlWs(action, payload) {
    return new Promise((resolve) => {
      if (!_controlWs || _controlWs.readyState !== WebSocket.OPEN) {
        resolve({ success: false, error: 'WS control not connected' });
        return;
      }
      const id = _controlReqId++;
      _controlPending.set(id, { resolve });
      _controlWs.send(JSON.stringify({ id, action, ...payload }));
    });
  }

  // Init: send handshake to get control_token + ws_port, connect control WS.
  (async () => {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'handshake' });
      if (resp.success && resp.control_token && resp.ws_port) {
        _wsPort = resp.ws_port;
        _connectControlWs(resp.control_token, resp.ws_port);
      }
    } catch (e) {
      __webhid.logger.warn('[bridge] handshake failed:', e.message);
    }
  })();

  window.addEventListener("message", async (event) => {
    if (!event.data || event.data.__webhid_bridge !== "req") return;

    const { id, action, payload } = event.data;
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
          if (ss.dataPlane !== undefined) global.dataPlane = ss.dataPlane;
          if (ss.controlPlane !== undefined) global.controlPlane = ss.controlPlane;
          if (ss.fireAndForget !== undefined) global.fireAndForget = ss.fireAndForget;
        }
        _controlPlane = global.controlPlane;
        window.postMessage({ __webhid_bridge: "res", id, result: global }, "*");
      } catch (e) {
        window.postMessage({ __webhid_bridge: "res", id, result: {} }, "*");
      }
      return;
    }

    // Hot-path actions: forward to the Worker (WebSocket) when available.
    // Falls back to NM path if no worker exists (device not opened or WS died).
    if (action === "worker-send" || action === "worker-sendFeature" || action === "worker-receiveFeature") {
      const deviceId = payload.device_id;
      const worker = _workers.get(deviceId);
      if (worker && _workerReady.has(deviceId)) {
        const wType =
          action === "worker-send" ? "send" :
          action === "worker-sendFeature" ? "sendFeature" :
          "receiveFeature";
        const wMsg = { type: wType, reqId: id, reportId: payload.report_id };
        if (action === "worker-send" || action === "worker-sendFeature") wMsg.data = payload.data;
        const wTransfer = (wMsg.data instanceof Uint8Array) ? [wMsg.data.buffer] : [];

        if (!isFireAndForget || action === "worker-receiveFeature") {
          let cbMap = _workerCallbacks.get(worker);
          if (!cbMap) { cbMap = new Map(); _workerCallbacks.set(worker, cbMap); }
          cbMap.set(id, (data) => {
            let result;
            if (data.type === 'featureResult') {
              result = data.error ? { success: false, error: data.error } : { success: true, data: data.data };
            } else {
              result = data.error ? { success: false, error: data.error } : { success: true };
            }
            const transfer = (result.data instanceof Uint8Array) ? [result.data.buffer] : [];
            window.postMessage({ __webhid_bridge: "res", id, result }, "*", transfer);
          });
        }
        worker.postMessage(wMsg, wTransfer);
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
    // to the background script via the native-messaging port, or via WS
    // control plane if enabled and connected.
    try {
      // WS control plane: route enumerate/close via WS text frames.
      // open always goes via NM (needs session_token per device).
      if (_controlPlane === 'ws' && _controlWs && _controlWs.readyState === WebSocket.OPEN
          && (action === 'enumerate' || action === 'close')) {
        const response = await _sendControlWs(action, payload || {});
        window.postMessage({ __webhid_bridge: "res", id, result: response }, "*");
        return;
      }

      const msg = Object.assign({ action }, payload || {});
      const response = await browser.runtime.sendMessage(msg);

      if (action === "open" && response.success && response.session_token) {
        const deviceId = response.device_id;
        _openDevices.add(deviceId);
        _sessionTokens.set(deviceId, response.session_token);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        __webhid.logger.debug('[bridge] open ok deviceId=' + deviceId + ' wsPort=' + response.ws_port);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;

        const globalDefaults = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
        let dataPlane = globalDefaults.dataPlane;
        let sabCapacity = globalDefaults.sabCapacity;
        let logLevel = globalDefaults.logLevel;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          if (ss.dataPlane !== undefined) dataPlane = ss.dataPlane;
          if (ss.sabCapacity !== undefined) sabCapacity = ss.sabCapacity;
        }

        browser.runtime.sendMessage({
          action: "setdataplane",
          device_id: deviceId,
          mode: dataPlane,
        }).catch(() => {});

        if (dataPlane === 'ws') {
          _spawnWorker(deviceId, response.session_token, {
            wsPort: response.ws_port || _wsPort,
            reportSize: payload.reportSize || 2048,
            sabCapacity,
            logLevel,
          });
        }
      }

      if (action === "close") {
        const deviceId = payload.device_id;
        __webhid.logger.debug('[bridge] close deviceId=' + deviceId);
        _openDevices.delete(deviceId);
        _sessionTokens.delete(deviceId);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        const worker = _workers.get(deviceId);
        if (worker) {
          worker.terminate();
          _workers.delete(deviceId);
          _workerReady.delete(deviceId);
        }
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
      if (evt.event_type === "handshake") {
        _wsPort = evt.ws_port;
        __webhid.logger.info('[bridge] handshake: ws_port=' + _wsPort);
        return;
      }
      window.postMessage({ __webhid_bridge: "evt", event: evt }, "*");
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    let ff = changes.fireAndForget?.newValue;
    let pl = changes.perfLogging?.newValue;
    let ll = changes.logLevel?.newValue;
    let dp = changes.dataPlane?.newValue;
    let cp = changes.controlPlane?.newValue;
    const ddv = changes.dispatchDataView?.newValue;

    // Check per-site settings changes (popup saves to `site:${origin}` key)
    const origin = window.location.origin;
    const siteKey = origin ? `site:${origin}` : null;
    if (siteKey && changes[siteKey]) {
      const ss = changes[siteKey].newValue || {};
      if (ss.dataPlane !== undefined) dp = ss.dataPlane;
      if (ss.controlPlane !== undefined) cp = ss.controlPlane;
      if (ss.fireAndForget !== undefined) ff = ss.fireAndForget;
    }

    if (cp !== undefined) {
      _controlPlane = cp;
      __webhid.logger.info('[bridge] control plane changed:', cp);
    }

    if (ff !== undefined || pl !== undefined || ll !== undefined) {
      for (const worker of _workers.values()) {
        worker.postMessage({ type: 'settings', fireAndForget: ff, perfLogging: pl, logLevel: ll });
      }
    }

    // Data plane switch: despawn/spawn workers, setdataplane on daemon.
    // No close/reopen — device stays open on daemon, just the transport changes.
    if (dp !== undefined) {
      for (const [id, worker] of _workers) {
        worker.terminate();
      }
      _workers.clear();
      _workerCallbacks.clear();
      _workerReady.clear();

      if (dp === 'ws') {
        for (const id of _openDevices) {
          const token = _sessionTokens.get(id);
          if (token) _spawnWorker(id, token).catch(() => {});
        }
      }
      for (const id of _openDevices) {
        browser.runtime.sendMessage({
          action: "setdataplane",
          device_id: id,
          mode: dp,
        }).catch(() => {});
      }
      __webhid.logger.info('[bridge] data plane changed:', dp, 'open devices:', _openDevices.size);
    }

    if (dp !== undefined || cp !== undefined || ddv !== undefined || ff !== undefined || pl !== undefined || ll !== undefined) {
      const settings = {};
      if (dp !== undefined) settings.dataPlane = dp;
      if (cp !== undefined) settings.controlPlane = cp;
      if (ddv !== undefined) settings.dispatchDataView = ddv;
      if (ff !== undefined) settings.fireAndForget = ff;
      if (ll !== undefined) settings.logLevel = ll;
      if (pl !== undefined) settings.perfLogging = pl;
      window.postMessage({ __webhid_bridge: "settings", settings }, "*");
    }
  });
})();
