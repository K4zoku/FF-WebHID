// WebHID Standard implementation with injected modal

(function () {
  "use strict";
  __webhid.logger.initLogger('bridge');

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
        __webhid.logger.warn("Failed to load shadow styles", e);
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
        __webhid.logger.error('shadowRoot not initialized; cannot show device picker');
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
        if (response && __webhid.http.isOk(response.s)) {
          this.devices = response.D || [];
        } else {
          this.devices = [];
          const code = response?.s || 0;
          if (code === 500) {
            __webhid.logger.warn('enumerate returned 500, treating as empty list');
          } else {
            __webhid.logger.warn('enumerate returned status', code);
          }
        }
        await this.#renderDevices();
      } catch (error) {
        this.devices = [];
        __webhid.logger.warn('enumerate exception:', error?.message || error);
        await this.#renderDevices();
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
      const savedIds = await this.#getSavedDevices();
      return savedIds.includes(device.deviceId);
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
          : `group:${devices[0].deviceId}`;
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
            if (!saved.includes(d.deviceId)) saved.push(d.deviceId);
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
  // Page  →  content script:  port.postMessage({ __webhid_bridge: 'req', id, action, payload })
  // Content script  →  page:  port.postMessage({ __webhid_bridge: 'res', id, result })
  //                           port.postMessage({ __webhid_bridge: 'evt', event })
  // ---------------------------------------------------------------------------
  const _openDevices = new Set();
  const _sessionTokens = new Map();
  const _workers = new Map();
  const _workerCallbacks = new Map();
  const _workerReady = new Set();
  const _workerQueues = new Map();
  const _dataPorts = new Map();
  let _wsPort = null;
  const settings = __webhid.createSettingsStore(__webhid.GLOBAL_DEFAULTS);
  let _controlWorker = null;
  let _controlPort = null;
  let _pagePort = null;
  const _controlPending = new Map();
  let _controlReqId = 1;
  const _spawnGen = new Map();

  const _workerBlobUrls = { worker: null, control: null };

  async function _getWorkerBlobUrl(kind) {
    if (_workerBlobUrls[kind]) return _workerBlobUrls[kind];
    const baseUrls = [
      'js/utils/browser-compat.js',
      'js/utils/logger.js',
      'js/utils/settings.js',
      'js/utils/ws-transport.js',
    ];
    const workerUrl = kind === 'control' ? 'js/control.js' : 'js/worker.js';
    const fetches = await Promise.all(
      [...baseUrls, workerUrl].map(u => fetch(browser.runtime.getURL(u)))
    );
    const texts = await Promise.all(fetches.map(r => r.text()));
    const blob = new Blob([texts.join('\n')], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    _workerBlobUrls[kind] = url;
    return url;
  }

  async function _spawnControlWorker(token, wsPort) {
    if (_controlWorker) return;
    let cspBlocked = false;
    try {
      const check = await browser.runtime.sendMessage({ action: 'checkWorkerCsp' });
      cspBlocked = !!check?.blocked;
    } catch {}
    if (cspBlocked) {
      __webhid.logger.warn('control worker skipped: CSP worker-src blocks blob:; control plane uses NM');
      return;
    }
    let worker;
    try {
      const url = await _getWorkerBlobUrl('control');
      worker = new Worker(url);
    } catch (e) {
      __webhid.logger.error('control worker spawn failed:', e);
      return;
    }

    const { port1, port2 } = new MessageChannel();
    _controlPort = port1;
    _controlWorker = worker;

    let resolved = false;
    let readyTimer = null;

    const fail = (reason) => {
      if (resolved) return;
      resolved = true;
      if (readyTimer) clearTimeout(readyTimer);
      _terminateControlWorker();
      __webhid.logger.warn('control worker failed:', reason, '; control plane falls back to NM');
    };

    worker.onerror = (e) => fail('onerror: ' + (e.message || 'unknown'));
    readyTimer = setTimeout(() => fail('ready timeout'), 3000);

    _controlPort.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        if (resolved) return;
        resolved = true;
        if (readyTimer) clearTimeout(readyTimer);
        __webhid.logger.info('control worker ready');
      } else if (data.type === 'closed') {
        __webhid.logger.warn('control worker WS closed; will auto-reconnect');
        for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
        _controlPending.clear();
      } else if (data.type === 'auth-failed') {
        __webhid.logger.warn('control worker auth-failed code=' + data.code + '; re-handshaking');
        for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
        _controlPending.clear();
        _terminateControlWorker();
        _refreshControlToken();
      } else if (data.type === 'response' && data.id && _controlPending.has(data.id)) {
        const { resolve } = _controlPending.get(data.id);
        _controlPending.delete(data.id);
        resolve(data.result);
      }
    };

    _controlWorker.postMessage({ type: 'connect', token, wsPort, logLevel: __webhid.logger._level }, [port2]);
    __webhid.logger.info('control worker spawned');
  }

  function _terminateControlWorker() {
    if (_controlPort) { _controlPort.onmessage = null; _controlPort.close(); _controlPort = null; }
    if (_controlWorker) { _controlWorker.postMessage({ type: 'disconnect' }); _controlWorker.terminate(); _controlWorker = null; }
    for (const [, { resolve }] of _controlPending) resolve({ s: 503 });
    _controlPending.clear();
  }

  async function _refreshControlToken() {
    if (_controlWorker) return;
    try {
      const resp = await browser.runtime.sendMessage({ action: 'handshake' });
      if (__webhid.http.isOk(resp.s) && resp.c && resp.w) {
        _wsPort = resp.w;
        _spawnControlWorker(resp.c, resp.w);
      } else {
        __webhid.logger.error('token refresh failed: s=' + (resp?.s || 0));
      }
    } catch (e) {
      __webhid.logger.error('token refresh error:', e.message);
    }
  }

  function _sendControlCommand(action, payload) {
    return new Promise((resolve) => {
      if (!_controlPort) {
        resolve({ s: 503 });
        return;
      }
      const id = _controlReqId++;
      _controlPending.set(id, { resolve });
      _controlPort.postMessage({ type: 'command', id, action, payload });
    });
  }

  async function _despawnDataPlane(deviceId, { keepPort = false } = {}) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    const worker = _workers.get(deviceId);
    if (worker) {
      const port = _dataPorts.get(deviceId);
      if (port && keepPort) {
        try { worker.postMessage({ type: 'unset-port' }); } catch {}
        const returned = await new Promise((resolve) => {
          let done = false;
          const onMsg = (ev) => {
            if (done) return;
            if (ev.data && ev.data.type === 'return-port') {
              done = true;
              worker.onmessage = null;
              resolve(ev.ports && ev.ports[0] || null);
            }
          };
          worker.onmessage = onMsg;
          setTimeout(() => { if (!done) { done = true; worker.onmessage = null; resolve(null); } }, 500);
        });
        if (returned) {
          _dataPorts.set(deviceId, returned);
          returned.onmessage = (e) => _onDataPortMessage(deviceId, e.data);
        }
      } else if (port) {
        _dataPorts.delete(deviceId);
        try { worker.postMessage({ type: 'unset-port' }); } catch {}
        try { port.onmessage = null; port.close(); } catch {}
      }
      worker.terminate();
      _workers.delete(deviceId);
    } else if (!keepPort) {
      const port = _dataPorts.get(deviceId);
      if (port) { try { port.onmessage = null; port.close(); } catch {} _dataPorts.delete(deviceId); }
    }
    _workerCallbacks.delete(deviceId);
    _workerReady.delete(deviceId);
    _workerQueues.delete(deviceId);
  }

  async function _refreshDataPlaneToken(deviceId) {
    if (_workers.has(deviceId)) return;
    try {
      const resp = await browser.runtime.sendMessage({ action: 'open', deviceId });
      if (__webhid.http.isOk(resp.s) && resp.t) {
        _sessionTokens.set(deviceId, resp.t);
        _spawnDataPlane(deviceId, resp.t, resp.w || _wsPort);
      } else {
        __webhid.logger.error('data plane token refresh failed for', deviceId, 's=' + (resp?.s || 0));
      }
    } catch (e) {
      __webhid.logger.error('data plane token refresh error:', e.message);
    }
  }

  async function _spawnWorker(deviceId, sessionToken, wsPort, opts = {}, gen) {
    if (_workers.has(deviceId)) return true;
    let cspBlocked = false;
    try {
      const check = await browser.runtime.sendMessage({ action: 'checkWorkerCsp' });
      cspBlocked = !!check?.blocked;
    } catch {}
    if (cspBlocked) {
      __webhid.logger.warn('worker skipped for', deviceId, ': CSP worker-src blocks blob:');
      return false;
    }
    let worker;
    try {
      const url = await _getWorkerBlobUrl('worker');
      worker = new Worker(url);
    } catch (e) {
      __webhid.logger.error('worker fetch/spawn failed:', e);
      return false;
    }

    if (_spawnGen.get(deviceId) !== gen) {
      __webhid.logger.info('worker spawn stale, discarding for', deviceId);
      worker.terminate();
      return false;
    }
    _workers.set(deviceId, worker);

    return new Promise((resolveSpawn) => {
      let resolved = false;
      let readyTimer = null;

      const fail = (reason) => {
        if (resolved) return;
        resolved = true;
        if (readyTimer) clearTimeout(readyTimer);
        worker.onerror = null;
        worker.onmessage = null;
        worker.terminate();
        _workers.delete(deviceId);
        _workerReady.delete(deviceId);
        _dataPorts.delete(deviceId);
        const queue = _workerQueues.get(deviceId);
        if (queue) {
          const cbMap = _workerCallbacks.get(deviceId);
          for (const wMsg of queue) {
            if (cbMap && cbMap.has(wMsg.reqId)) {
              cbMap.get(wMsg.reqId)({ error: 'worker spawn failed' });
              cbMap.delete(wMsg.reqId);
            }
          }
          _workerQueues.delete(deviceId);
        }
        __webhid.logger.warn('worker spawn failed for', deviceId, ':', reason);
        resolveSpawn(false);
      };

      worker.onerror = (e) => fail('onerror: ' + (e.message || 'unknown'));
      readyTimer = setTimeout(() => fail('ready timeout'), 3000);

      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          if (resolved) return;
          resolved = true;
          if (readyTimer) clearTimeout(readyTimer);
          __webhid.logger.info('worker ready for', deviceId);
          _workerReady.add(deviceId);
          const queue = _workerQueues.get(deviceId);
          if (queue) {
            for (const wMsg of queue) {
              worker.postMessage(wMsg, wMsg.data ? [wMsg.data.buffer] : []);
            }
            _workerQueues.delete(deviceId);
          }
          const port = _dataPorts.get(deviceId);
          if (port) {
            port.onmessage = null;
            try { worker.postMessage({ type: 'set-port' }, [port]); } catch (e) {
              __webhid.logger.warn('set-port transfer failed for', deviceId, ':', e.message);
              port.onmessage = (e2) => _onDataPortMessage(deviceId, e2.data);
            }
          }
          resolveSpawn(true);
          return;
        }
        if (data.type === 'auth-failed') {
          __webhid.logger.warn('worker auth-failed for', deviceId, 'code=' + data.code + '; re-opening');
          _workers.delete(deviceId);
          _workerReady.delete(deviceId);
          _dataPorts.delete(deviceId);
          _refreshDataPlaneToken(deviceId);
          return;
        }
        if (data.type === 'closed') {
          __webhid.logger.warn('worker closed for', deviceId);
          _workers.delete(deviceId);
          _workerReady.delete(deviceId);
          _dataPorts.delete(deviceId);
          _replyToPage({
            __webhid_bridge: 'evt',
            event: { eventType: 'disconnect', deviceId: deviceId }
          });
          return;
        }
        if (data.type === 'inputReport') {
          return;
          const view = data.data ? new Uint8Array(data.data) : null;
          if (view && __webhid.logger._level >= 3 && data.reportId !== 33) {
            let hex = '';
            for (let i = 0; i < Math.min(8, view.length); i++) hex += view[i].toString(16).padStart(2, '0') + ' ';
            __webhid.logger.debug('worker→page inputReport device=' + deviceId + ' reportId=' + data.reportId + ' len=' + view.length + ' first8=' + hex);
          }
          _replyToPage({
            __webhid_bridge: 'evt',
            event: {
              eventType: 'input_report',
              deviceId: deviceId,
              reportId: data.reportId,
              data: view,
            }
          }, view ? [view.buffer] : []);
          return;
        }
        if (data.type === 'sendResult' || data.type === 'featureResult') {
          const cbMap = _workerCallbacks.get(deviceId);
          if (cbMap && cbMap.has(data.reqId)) {
            const cb = cbMap.get(data.reqId);
            cbMap.delete(data.reqId);
            if (data.error) cb({ s: 500 });
            else if (data.data) cb({ s: 200, d: data.data });
            else cb({ s: 204 });
          }
        }
      };

      worker.postMessage({ type: 'connect', wsPort, token: sessionToken, reportSize: opts.reportSize || 64 });
    });
  }

  async function _spawnDataPlane(deviceId, sessionToken, wsPort, opts = {}) {
    const gen = (_spawnGen.get(deviceId) || 0) + 1;
    _spawnGen.set(deviceId, gen);
    const ok = await _spawnWorker(deviceId, sessionToken, wsPort, opts, gen);
    if (!ok && _spawnGen.get(deviceId) === gen) {
      __webhid.logger.warn('worker spawn failed for', deviceId, '; falling back to NM');
      browser.runtime.sendMessage({
        action: 'setdataplane', deviceId: deviceId, mode: 'nm'
      }).catch(() => {});
    }
  }

  (async () => {
    try {
      const resp = await browser.runtime.sendMessage({ action: 'handshake' });
      if (__webhid.http.isOk(resp.s) && resp.w) {
        _wsPort = resp.w;
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
        settings.set(global);
        if (settings.controlPlane === 'ws' && resp.c) {
          _spawnControlWorker(resp.c, resp.w);
        }
      }
    } catch (e) {
      __webhid.logger.warn('handshake failed:', e.message);
    }
  })();

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
    _pagePort.onmessage = (ev) => { handleRequest(ev.data, ev.ports); };
    __webhid.logger.debug('[bridge] page port established');
  });

  async function handleRequest(data, ports) {
    if (!data || data.__webhid_bridge !== "req") return;

    const { id, action: reqAction, payload } = data;
    let action = reqAction;
    const isFireAndForget = data.fireAndForget === true;
    __webhid.logger.debug('req action=' + action + ' id=' + id + (isFireAndForget ? ' (faf)' : ''));

    if (action === "data-port") {
      const deviceId = payload.deviceId;
      const port = ports && ports[0];
      if (!deviceId || !port) {
        __webhid.logger.warn('data-port: missing deviceId or port');
        return;
      }
      _dataPorts.set(deviceId, port);
      __webhid.logger.debug('data port received for device', deviceId);
      const worker = _workers.get(deviceId);
      if (worker && _workerReady.has(deviceId)) {
        try { worker.postMessage({ type: 'set-port' }, [port]); } catch (e) {
          __webhid.logger.warn('set-port transfer failed for', deviceId, ':', e.message);
          port.onmessage = (ev) => _onDataPortMessage(deviceId, ev.data);
        }
      } else {
        port.onmessage = (ev) => _onDataPortMessage(deviceId, ev.data);
      }
      return;
    }

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
        settings.set(global);
        _replyToPage({ __webhid_bridge: "res", id, result: global });
      } catch (e) {
        _replyToPage({ __webhid_bridge: "res", id, result: {} });
      }
      return;
    }

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
            const result = data.error ? { s: 500 }
                        : data.data ? { s: 200, d: data.data }
                        : { s: 204 };
            const xfers = result.d instanceof Uint8Array ? [result.d.buffer] : [];
            _replyToPage({ __webhid_bridge: "res", id, result }, xfers.length ? xfers : undefined);
          });
        }
        worker.postMessage(wMsg);
        return;
      }

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
            const result = data.error ? { s: 500 }
                        : data.data ? { s: 200, d: data.data }
                        : { s: 204 };
            const xfers = result.d instanceof Uint8Array ? [result.d.buffer] : [];
            _replyToPage({ __webhid_bridge: "res", id, result }, xfers.length ? xfers : undefined);
          });
        }

        if (!_workerQueues.has(deviceId)) _workerQueues.set(deviceId, []);
        _workerQueues.get(deviceId).push(wMsg);
        return;
      }

      __webhid.logger.warn('no worker for', deviceId, '; falling back to NM');
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
        const _xfers = (response && response.d instanceof Uint8Array) ? [response.d.buffer] : [];
        _replyToPage({ __webhid_bridge: "res", id, result: response }, _xfers.length ? _xfers : undefined);
      } catch (error) {
        _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
      }
      return;
    }

    if (action === "requestDevice") {
      let onSelected, onCancelled;

      const cleanup = () => {
        window.removeEventListener("webhid-device-selected", onSelected);
        window.removeEventListener("webhid-device-cancelled", onCancelled);
      };

      onSelected = (e) => {
        cleanup();
        _replyToPage({ __webhid_bridge: "res", id, result: { devices: e.detail.devices } });
      };

      onCancelled = () => {
        cleanup();
        _replyToPage({ __webhid_bridge: "res", id, result: { cancelled: true } });
      };

      window.addEventListener("webhid-device-selected", onSelected);
      window.addEventListener("webhid-device-cancelled", onCancelled);
      devicePicker.show((payload && payload.filters) || []);
      return;
    }

    try {
      let response;
      let viaControlWs = false;
      if (settings.controlPlane === 'ws' && _controlPort
          && (action === 'enumerate' || action === 'close' || action === 'open')) {
        response = await _sendControlCommand(action, payload || {});
        viaControlWs = true;
      } else {
        const msg = Object.assign({ action }, payload || {});
        response = await browser.runtime.sendMessage(msg);
      }

      if (action === "open" && __webhid.http.isOk(response.s) && response.t) {
        const deviceId = response.i;
        _openDevices.add(deviceId);
        _sessionTokens.set(deviceId, response.t);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        __webhid.logger.debug('open ok deviceId=' + deviceId + ' wsPort=' + response.w);

        const dataPlane = settings.dataPlane;
        if (viaControlWs) {
          browser.runtime.sendMessage({
            action: "registerDevice",
            deviceId: deviceId,
          }).catch(() => {});
        }

        browser.runtime.sendMessage({
          action: "setdataplane",
          deviceId: deviceId,
          mode: dataPlane,
        }).catch(() => {});

        if (dataPlane === 'ws') {
          _spawnDataPlane(deviceId, response.t, response.w || _wsPort);
        }
      }

      if (action === "close") {
        const deviceId = payload.deviceId;
        __webhid.logger.debug('close deviceId=' + deviceId);
        _openDevices.delete(deviceId);
        _sessionTokens.delete(deviceId);
        browser.runtime.sendMessage({ action: "device-count-changed", count: _openDevices.size }).catch(() => {});
        if (viaControlWs) {
          browser.runtime.sendMessage({
            action: "unregisterDevice",
            deviceId: deviceId,
          }).catch(() => {});
        }
        _despawnDataPlane(deviceId);
      }

      const _xfers = (response && response.d instanceof Uint8Array) ? [response.d.buffer] : [];
      _replyToPage({ __webhid_bridge: "res", id, result: response }, _xfers.length ? _xfers : undefined);
    } catch (error) {
      _replyToPage({ __webhid_bridge: "res", id, result: { s: 500 } });
    }
  }

  // Forward events pushed by background.js into the page world.
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhid-device-event" && message.event) {
      const ev = message.event;
      if (ev.eventType === 'input_report') {
        const port = _dataPorts.get(ev.deviceId);
        if (port) {
          const view = ev.data;
          const buf = view ? (view.buffer || view) : null;
          try { port.postMessage({ type: 'inputReport', reportId: ev.reportId, data: buf }, buf ? [buf] : []); } catch {}
          return;
        }
      }
      if (ev.eventType === 'disconnect') {
        const port = _dataPorts.get(ev.deviceId);
        if (port) {
          try { port.postMessage({ type: 'disconnect' }); } catch {}
        }
      }
      _replyToPage({ __webhid_bridge: "evt", event: ev });
    }
  });

  function _onDataPortMessage(deviceId, msg) {
    if (!msg) return;
    if (msg.type === 'send' || msg.type === 'sendFeature' || msg.type === 'receiveFeature') {
      const action = msg.type === 'send' ? 'sendreport'
                   : msg.type === 'sendFeature' ? 'sendfeaturereport'
                   : 'receivefeaturereport';
      const payload = { deviceId, reportId: msg.reportId };
      if (msg.type === 'send' || msg.type === 'sendFeature') payload.data = msg.data;
      const port = _dataPorts.get(deviceId);
      const cb = (response) => {
        if (!port) return;
        if (msg.type === 'receiveFeature') {
          const data = (response && __webhid.http.isOk(response.s) && response.d) ? response.d : null;
          try { port.postMessage({ type: 'featureResult', reqId: msg.reqId, data: data || null }); } catch {}
        } else {
          const err = (response && !__webhid.http.isOk(response.s)) ? 'send failed' : null;
          try { port.postMessage({ type: msg.type === 'send' ? 'sendResult' : 'featureResult', reqId: msg.reqId, error: err }); } catch {}
        }
      };
      const m = Object.assign({ action }, payload);
      browser.runtime.sendMessage(m).then(cb).catch(() => cb({ s: 500 }));
      return;
    }
  }

  // ── Settings observer ─────────────────────────────────────────────

  function _applyControlPlane(cp) {
    __webhid.logger.info('control plane changed:', cp);
    if (cp === 'ws' && _wsPort && !_controlWorker) {
      browser.runtime.sendMessage({ action: 'handshake' }).then((resp) => {
        if (__webhid.http.isOk(resp.s) && resp.c && resp.w) {
          _wsPort = resp.w;
          _spawnControlWorker(resp.c, resp.w);
        }
      }).catch(() => {});
    } else if (cp === 'nm' && _controlWorker) {
      _terminateControlWorker();
    }
  }

  async function _applyDataPlane(dp) {
    for (const id of _openDevices) { await _despawnDataPlane(id, { keepPort: true }); }
    if (dp === 'ws') {
      for (const id of _openDevices) {
        const token = _sessionTokens.get(id);
        if (token) _spawnDataPlane(id, token, _wsPort);
      }
    } else {
      for (const id of _openDevices) {
        const port = _dataPorts.get(id);
        if (port && !port.onmessage) {
          port.onmessage = (ev) => _onDataPortMessage(id, ev.data);
        }
      }
    }
    for (const id of _openDevices) {
      browser.runtime.sendMessage({
        action: "setdataplane",
        deviceId: id,
        mode: dp,
      }).catch(() => {});
    }
    __webhid.logger.info('data plane changed:', dp, 'open devices:', _openDevices.size);
  }

  settings.on('controlPlane', (cp) => _applyControlPlane(cp));
  settings.on('dataPlane', (dp) => _applyDataPlane(dp));

  // Push any settings change to page + workers.
  settings.on(['dataPlane', 'controlPlane', 'fireAndForget', 'logLevel'], () => {
    const all = settings.getAll();
    const patch = {};
    for (const k of ['dataPlane', 'controlPlane', 'fireAndForget', 'logLevel']) {
      patch[k] = all[k];
    }
    _replyToPage({ __webhid_bridge: "settings", settings: patch });
    const workerMsg = { type: 'settings', ...patch };
    for (const worker of _workers.values()) worker.postMessage(workerMsg);
    if (_controlWorker) _controlWorker.postMessage(workerMsg);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const origin = window.location.origin;
    const siteKey = origin ? `site:${origin}` : null;
    const patch = {};
    for (const k of Object.keys(__webhid.GLOBAL_DEFAULTS)) {
      if (changes[k]) patch[k] = changes[k].newValue;
    }
    if (siteKey && changes[siteKey]) {
      const ss = changes[siteKey].newValue || {};
      for (const k of Object.keys(ss)) patch[k] = ss[k];
    }
    if (Object.keys(patch).length === 0) return;
    settings.set(patch);
  });
})();
