// WebHID Standard implementation with injected modal

(function () {
  "use strict";

  // Device Picker Modal Class
  class WebHIDDevicePicker {
    constructor() {
      this.devices = [];
      this.selectedDevice = null;
      this.filters = [];
      this.dialog = null;

      // Event handlers (kept so we can clean up on hide)
      this._onDialogClose = null;
      this._onDeviceClick = null;
      this._onDialogCancel = null;

      this._savedDevices = null;
      // Map from rendered deviceId -> array of device objects (1 or more)
      this._deviceGroups = {};

      this.init();
    }

    init() {
      this.injectStyles();
      this.injectTemplate();
      this.setupEventListeners();
    }

    async injectStyles() {
      await browser.runtime.sendMessage({
        action: "injectCSS",
      });
    }

    injectTemplate() {
      if (document.getElementById("webhid-modal-template")) return;

      const tpl = document.createElement("template");
      tpl.id = "webhid-modal-template";
      tpl.innerHTML = `
        <dialog class="webhid-modal" aria-labelledby="webhid-modal-title">
          <form method="dialog" class="webhid-modal-form">
            <div class="webhid-modal-header">
              <h2 id="webhid-modal-title">Select a HID Device</h2>
            </div>
            <div class="webhid-modal-content">
              <div class="webhid-device-list" id="webhidDeviceList">
                <div class="webhid-loading" id="webhidLoading">Loading devices...</div>
              </div>
            </div>
            <div class="webhid-modal-footer">
              <button class="webhid-cancel-button" id="webhidCancelBtn" value="cancel">Cancel</button>
            </div>
          </form>
        </dialog>
      `;
      const itemTpl = document.createElement("template");
      itemTpl.id = "webhid-device-item-template";
      itemTpl.innerHTML = `
        <div class="webhid-device-item" tabindex="0" role="button">
          <img class="webhid-device-icon" draggable="false">
          <div class="webhid-device-body">
            <div class="webhid-device-name"></div>
            <div class="webhid-device-vendor"></div>
            <div class="webhid-device-iface"></div>
          </div>
        </div>
      `;
      document.body.appendChild(tpl);
      document.body.appendChild(itemTpl);
    }

    setupEventListeners() {
      // Listen for device picker requests from background script
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
      });
    }

    async show(filters = []) {
      // Prevent multiple instances
      if (this.dialog?.open) {
        this.dialog.close("replace");
      }

      this.filters = filters;

      // Clone template content into a new <dialog>
      const tpl = document.getElementById("webhid-modal-template");
      this.dialog = tpl.content.lastElementChild.cloneNode(true);

      // Append to DOM
      document.body.appendChild(this.dialog);

      // Set up dialog event handlers
      this._onDialogClose = (e) => {
        // Read returnValue and selectedDevice BEFORE nullifying this.dialog.
        // If we read this.dialog?.returnValue after setting this.dialog = null,
        // it is always undefined and onDeviceCancelled fires on every close.
        const returnValue = this.dialog.returnValue;
        const selectedDevice = this.selectedDevice;

        this._detachDialogEventListeners();
        this.dialog.remove();
        this.dialog = null;

        if (returnValue === "selected" && selectedDevice) {
          this.onDeviceSelected(selectedDevice);
        } else {
          // Cancelled: ESC key, X button, or any close without a selection
          this.onDeviceCancelled();
        }
      };
      this._onDialogCancel = (e) => {
        // Allow default <dialog> cancel (ESC) to set returnValue = 'cancel'
        // Nothing else needed here
      };
      this._onDeviceClick = (e) => {
        // Overlay click — user clicked the dark backdrop area outside the card
        if (e.target === this.dialog) {
          this.dialog.close();
          return;
        }
        const item = e.target.closest(".webhid-device-item");
        if (!item || !this.dialog?.open) return;
        this.selectDevice(item);
      };

      this._attachDialogEventListeners();

      // Show the dialog (with fallback)
      if (typeof this.dialog.showModal === "function") {
        this.dialog.showModal();
      } else {
        // Fallback if <dialog> showModal is not supported
        this.dialog.setAttribute("open", "");
      }

      // Load devices
      await this.loadDevices();
    }

    _attachDialogEventListeners() {
      if (!this.dialog) return;
      this.dialog.addEventListener("close", this._onDialogClose);
      this.dialog.addEventListener("cancel", this._onDialogCancel);
      this.dialog.addEventListener("click", this._onDeviceClick);
    }

    _detachDialogEventListeners() {
      if (!this.dialog) return;
      this.dialog.removeEventListener("close", this._onDialogClose);
      this.dialog.removeEventListener("cancel", this._onDialogCancel);
      this.dialog.removeEventListener("click", this._onDeviceClick);
    }

    hide() {
      if (this.dialog?.open) {
        // Let the 'close' handler do cleanup; this ensures cancel/selected semantics are preserved
        this.dialog.close("user-hide");
      } else if (this.dialog) {
        // If not open, clean up immediately
        this._detachDialogEventListeners();
        this.dialog.remove();
        this.dialog = null;
      }
    }

    async loadDevices() {
      try {
        const response = await browser.runtime.sendMessage({
          action: "enumerate",
        });
        if (response.success) {
          this.devices = response.devices || [];
          await this.renderDevices();
        } else {
          this.showError("Failed to load devices");
        }
      } catch (error) {
        this.showError("Failed to connect to server");
        console.debug("[WebHID]", "Failed to connect to server", error);
      }
    }

    createDeviceHash(device) {
      const vendorId = String(device.vendor_id || 0);
      const productId = String(device.product_id || 0);
      const serialNumber = String(device.serial_number || "");
      const path = String(device.device_id || "");
      const identifier = vendorId + ":" + productId + ":" + serialNumber + ":" + path;

      // Simple DJB2 hash algorithm
      let hash = 5381;
      for (let i = 0; i < identifier.length; i++) {
        hash = ((hash << 5) + hash) + identifier.charCodeAt(i);
        hash = hash & 0xFFFFFFFF; // Convert to 32-bit integer
      }

      // Convert to positive hex string
      return Math.abs(hash).toString(16);
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
      const deviceHash = this.createDeviceHash(device);
      return savedHashes.includes(deviceHash);
    }

    async renderDevices() {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      const loading = deviceList.querySelector("#webhidLoading");
      loading.remove();
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

      const tpl = document.getElementById("webhid-device-item-template");

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
        const groupId = devices.length === 1 ? devices[0].device_id : `group:${this.createDeviceHash(devices[0])}`;
        this._deviceGroups[groupId] = devices.slice(); // store copy

        // Use the first device to determine icon/type/manufacturer
        const device = devices[0];
        const deviceId = groupId;
        const type = this._guessDeviceType(device);
        const iconUrl = browser.runtime.getURL(`res/${type}.svg`);

        const clone = tpl.content.cloneNode(true);
        const item  = clone.querySelector(".webhid-device-item");

        item.classList.toggle("webhid-device-paired", isPaired);
        item.dataset.deviceId = deviceId;
        item.setAttribute("aria-label", `Select device ${device.product_name || "Unknown Device"}`);

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
      // Remove previous selection
      this.dialog
        .querySelectorAll(".webhid-device-item")
        .forEach((el) => el.classList.remove("selected"));
      // Add selection to clicked item
      item.classList.add("selected");

      // Get device info
      const deviceId = item.dataset.deviceId;
      const devices = this._deviceGroups[deviceId] || [];

      // Set selectedDevice to the array of devices (1 or more)
      this.selectedDevice = devices;

      // Close the dialog with returnValue "selected".
      // _onDialogClose reads this value before cleanup and calls onDeviceSelected.
      if (this.dialog?.open) {
        this.dialog.close("selected");
      }
    }

    getDeviceId(device) {
      // Use the hidraw path as the stable, per-interface unique ID for
      // single-interface items. For grouped items the id is generated during
      // render and stored in _deviceGroups.
      return device.device_id;
    }

    // Guess a generic device category from HID usage page (when the daemon
    // provides it) and from the product name as a fallback.
    // Returns one of: mouse | keyboard | controller | joystick | headset | speaker | camera | unknown
    _guessDeviceType(device) {
      // HID Usage Page 0x01 — Generic Desktop Controls (most reliable)
      if (device.usage_page === 0x01) {
        const u = device.usage;
        if (u === 0x01 || u === 0x02) return "mouse";      // Pointer, Mouse
        if (u === 0x06 || u === 0x07) return "keyboard";   // Keyboard, Keypad
        if (u === 0x04 || u === 0x08) return "joystick";   // Joystick, Multi-axis
        if (u === 0x05) return "controller";               // Gamepad
      }

      // Name-based heuristics — order matters (joystick before controller)
      const name = (device.product_name || "").toLowerCase();
      if (/mouse|trackball|trackpad|touchpad/i.test(name))                         return "mouse";
      if (/keyboard|kbd/i.test(name))                                              return "keyboard";
      if (/joystick|flight.?stick|yoke|rudder|throttle/i.test(name))              return "joystick";
      if (/gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i.test(name)) return "controller";
      if (/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i.test(name))    return "headset";
      if (/speaker|soundbar|audio|\bdac\b|amplifier/i.test(name))                 return "speaker";
      if (/webcam|camera|\bcam\b/i.test(name))                                    return "camera";

      return "unknown";
    }

    // Returns a Set of path values that share a display name with at least
    // one other device in the list — used to trigger disambiguation labels.
    _ambiguousPaths(devices) {
      const nameCount = {};
      for (const d of devices) {
        const name = d.product_name || "Unknown Device";
        nameCount[name] = (nameCount[name] || 0) + 1;
      }
      const ambiguous = new Set();
      for (const d of devices) {
        if (nameCount[d.product_name || "Unknown Device"] > 1) {
          ambiguous.add(d.device_id);
        }
      }
      return ambiguous;
    }

    hex(value) {
      return "0x" + value.toString(16).toUpperCase().padStart(4, "0");
    }

    escapeHtml(text) {
      const span = document.createElement("span");
      span.textContent = text;
      return span.innerHTML;
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
                const h = this.createDeviceHash(d);
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

    showError(message) {
      if (!this.dialog) return;
      const deviceList = this.dialog.querySelector("#webhidDeviceList");
      const span = document.createElement("span");
      span.className = "webhid-error";
      span.textContent = message;
      deviceList.appendChild(span);
    }
  }

  // ---------------------------------------------------------------------------
  // Initialize device picker (runs in content script world — needs browser.* APIs
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
  let _wsPort = null;

  window.addEventListener("message", async (event) => {
    if (!event.data || event.data.__webhid_bridge !== "req") return;

    const { id, action, payload } = event.data;

    // Hot-path actions: forward to the Worker (WebSocket) when one is
    // available for this device.  The polyfill only sends these after the
    // SAB/Worker has been established via `open`.  If no Worker exists we
    // fall through to the regular NM path so behavior is preserved on
    // devices that haven't been opened yet (or if the WS connection died).
    if (action === "worker-send" || action === "worker-sendFeature" || action === "worker-receiveFeature") {
      const deviceId = String.fromCharCode(...(payload.device_id || []));
      const worker = _workers.get(deviceId);
      if (worker) {
        const wType =
          action === "worker-send" ? "send" :
          action === "worker-sendFeature" ? "sendFeature" :
          "receiveFeature";
        let cbMap = _workerCallbacks.get(worker);
        if (!cbMap) { cbMap = new Map(); _workerCallbacks.set(worker, cbMap); }
        cbMap.set(id, (data) => {
          let result;
          if (data.type === 'featureResult') {
            result = data.error ? { success: false, error: data.error } : { success: true, data: Array.from(data.data) };
          } else {
            result = data.error ? { success: false, error: data.error } : { success: true };
          }
          window.postMessage({ __webhid_bridge: "res", id, result }, "*");
        });
        const wMsg = { type: wType, reqId: id, reportId: payload.report_id };
        if (action === "worker-send" || action === "worker-sendFeature") wMsg.data = payload.data;
        worker.postMessage(wMsg);
        return;
      }
      console.warn('[bridge] no worker for', deviceId, '— falling back to NM');
      const fallbackAction =
        action === "worker-send" ? "sendreport" :
        action === "worker-sendFeature" ? "sendfeaturereport" :
        "receivefeaturereport";
      try {
        const msg = Object.assign({ action: fallbackAction }, payload || {});
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
    // to the background script via the native-messaging port.
    try {
      const msg = Object.assign({ action }, payload || {});
      const response = await browser.runtime.sendMessage(msg);

      if (action === "open" && response.success && response.session_token) {
        const deviceId = String.fromCharCode(...response.data);
        const origin = window.location.origin;
        const siteKey = origin ? `site:${origin}` : null;

        let sabEnabled = true;
        let sabCapacity = 8192;
        const globalDefaults = await browser.storage.local.get({ sabEnabled: true, sabCapacity: 8192 });
        sabEnabled = globalDefaults.sabEnabled;
        sabCapacity = globalDefaults.sabCapacity;
        if (siteKey) {
          const siteResult = await browser.storage.local.get(siteKey);
          const ss = siteResult[siteKey] || {};
          if (ss.sabEnabled !== undefined) sabEnabled = ss.sabEnabled;
          if (ss.sabCapacity !== undefined) sabCapacity = ss.sabCapacity;
        }

        if (!sabEnabled) {
          console.log('[bridge] SAB disabled for', deviceId);
        } else
        {
        let worker;
        try {
          const workerUrl = browser.runtime.getURL('hid-worker.js');
          const resp = await fetch(workerUrl);
          const code = await resp.text();
          const blob = new Blob([code], { type: 'application/javascript' });
          worker = new Worker(URL.createObjectURL(blob));
        } catch (e) {
          console.error('[bridge] worker spawn failed:', e);
          throw e;
        }
        _workers.set(deviceId, worker);

        worker.onerror = (e) => {
          console.error('[bridge] worker.onerror:', e.message || '(no msg)', 'file=', e.filename, 'line=', e.lineno);
        };

        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            console.log('[bridge] worker ready for', deviceId);
            window.postMessage({
              __webhid_bridge: 'evt',
              event: {
                event_type: 'webhid-sab',
                device_id: response.data,
                sab: data.sab,
                reportSize: payload.reportSize || 2048
              }
            }, '*');
            return;
          }
          if (data.type === 'error') {
            console.error('[bridge] worker error:', data.error);
            return;
          }
          if (data.type === 'closed') {
            console.warn('[bridge] worker WS closed for', deviceId, '— worker will auto-reconnect');
            const cbMap = _workerCallbacks.get(worker);
            if (cbMap) {
              for (const [reqId, cb] of cbMap) cb({ type: 'sendResult', reqId, error: 'ws closed' });
              cbMap.clear();
            }
            window.postMessage({
              __webhid_bridge: 'evt',
              event: { event_type: 'disconnect', device_id: response.data }
            }, '*');
            return;
          }
          if (data.type === 'ready' && _workers.has(deviceId)) {
            console.log('[bridge] worker reconnected for', deviceId);
            window.postMessage({
              __webhid_bridge: 'evt',
              event: { event_type: 'connect', device_id: response.data }
            }, '*');
            return;
          }
          if (data.type === 'sendResult' || data.type === 'featureResult') {
            const cbMap = _workerCallbacks.get(worker);
            if (cbMap) {
              const cb = cbMap.get(data.reqId);
              if (cb) { cbMap.delete(data.reqId); cb(data); }
              else console.warn('[bridge] worker response for unknown reqId=', data.reqId, 'cbMap size=', cbMap.size);
            }
          }
        };

        worker.postMessage({
          type: 'connect',
          token: response.session_token,
          wsPort: response.ws_port || _wsPort,
          reportSize: payload.reportSize || 2048,
          capacity: sabCapacity,
        });

        (async () => {
          const s = await browser.storage.local.get({ fireAndForget: true, perfLogging: false });
          worker.postMessage({ type: 'settings', fireAndForget: s.fireAndForget, perfLogging: s.perfLogging });
        })();
        }
      }

      if (action === "close") {
        const deviceId = String.fromCharCode(...(payload.data || []));
        const worker = _workers.get(deviceId);
        if (worker) {
          worker.terminate();
          _workers.delete(deviceId);
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

  // WASM descriptor parser — runs in isolated world (CSP-free)
  let _wasmReady = false;
  let _wasmParser = null;

  async function initWasm() {
    if (_wasmReady) return;
    _wasmReady = true;
    try {
      const jsUrl = browser.runtime.getURL('wasm-parser.js');
      const wasmUrl = browser.runtime.getURL('wasm-parser.wasm');
      const mod = await import(jsUrl);
      await mod.default(wasmUrl);
      _wasmParser = mod.parse_descriptor;
      console.log('[bridge] WASM descriptor parser ready');
    } catch (e) {
      console.warn('[bridge] WASM init failed, JS fallback:', e);
    }
  }

  initWasm();

  window.addEventListener("message", async (event) => {
    if (!event.data || event.data.__webhid_bridge !== "parse-descriptor") return;
    const { id, bytes } = event.data;
    await initWasm();
    let collections = null;
    if (_wasmParser) {
      try { collections = _wasmParser(new Uint8Array(bytes)); } catch (e) {}
    }
    window.postMessage({ __webhid_bridge: "parse-descriptor-result", id, collections }, "*");
  });

  // Forward events pushed by background.js into the page world.
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhid-device-event" && message.event) {
      const evt = message.event;
      if (evt.event_type === "hello") {
        _wsPort = evt.ws_port;
        console.log('[bridge] hello: ws_port=' + _wsPort);
        return;
      }
      window.postMessage({ __webhid_bridge: "evt", event: evt }, "*");
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const ff = changes.fireAndForget?.newValue;
    const pl = changes.perfLogging?.newValue;
    if (ff === undefined && pl === undefined) return;
    for (const worker of _workers.values()) {
      worker.postMessage({ type: 'settings', fireAndForget: ff, perfLogging: pl });
    }
  });
})();