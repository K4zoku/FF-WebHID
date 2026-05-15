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

    injectStyles() {
      if (document.getElementById("webhid-modal-styles")) return;
      const style = document.createElement("style");
      style.id = "webhid-modal-styles";
      const cssUrl = browser.runtime.getURL('webhid-modal.css');
      style.innerHTML = `
        @import url('${cssUrl}');
      `;
      document.head.appendChild(style);
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
                <div class="webhid-loading">Loading devices...</div>
              </div>
            </div>
            <div class="webhid-modal-footer">
              <button class="webhid-cancel-button" id="webhidCancelBtn" value="cancel">Cancel</button>
            </div>
          </form>
        </dialog>
      `;
      document.body.appendChild(tpl);
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
      const path = String(device.path || "");
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

      // Render one item per group
      const itemsHtml = [];
      let pairedIndex = 0; // index into pairedStatuses for devices in filteredDevices
      for (const [name, devices] of groups.entries()) {
        // Determine if any device in this group is paired (saved)
        let isPaired = false;
        const deviceIds = [];
        for (const d of devices) {
          // Find index of this device in filteredDevices to read pairedStatuses
          const idx = filteredDevices.indexOf(d);
          if (idx >= 0 && pairedStatuses[idx]) isPaired = true;
          deviceIds.push(d.path);
        }

        // Create a stable group id. For single-device groups use the path so
        // external code relying on unique paths continues to work; for multi-
        // interface groups use a generated id prefixed with 'group:'.
        const groupId = devices.length === 1 ? devices[0].path : `group:${this.createDeviceHash(devices[0])}`;
        this._deviceGroups[groupId] = devices.slice(); // store copy

        // Use the first device to determine icon/type/manufacturer
        const primary = devices[0];
        const deviceId = groupId;
        const type = this._guessDeviceType(primary);
        const iconUrl = browser.runtime.getURL(`res/${type}.svg`);

        const iface = devices.length > 1
          ? `<div class="webhid-device-iface">${this.escapeHtml(devices.length + " interfaces")}</div>`
          : "";

        itemsHtml.push(`
          <div class="webhid-device-item${isPaired ? " webhid-device-paired" : ""}" data-device-id="${this.escapeHtml(deviceId)}" tabindex="0" role="button" aria-label="Select device ${this.escapeHtml(primary.product_name || "Unknown Device")}">
            <img class="webhid-device-icon" src="${iconUrl}" alt="${type}" draggable="false">
            <div class="webhid-device-body">
              <div class="webhid-device-name">${this.escapeHtml(name)}</div>
              ${primary.manufacturer ? `<div class="webhid-device-vendor">${this.escapeHtml(primary.manufacturer)}</div>` : ""}
              ${iface}
            </div>
          </div>
        `);
      }

      deviceList.innerHTML = itemsHtml.join("");
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
      return device.path;
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
          ambiguous.add(d.path);
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
      deviceList.innerHTML = `<div class="webhid-error">${this.escapeHtml(message)}</div>`;
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
  // Firefox Xray Vision isolates content script JS from the page's JS world, so
  // `window.navigator.hid = ...` written here is invisible to the page.  The
  // fix (same approach as Sainan/WebHID-for-Firefox) is to inject the API code
  // as a <script> element so it executes in the page's own world.  We then
  // proxy every call back here via window.postMessage, because browser.*
  // extension APIs are only available in the content script context.
  //
  // Page  →  content script:  postMessage({ __webhid_bridge: 'req', id, action, payload })
  // Content script  →  page:  postMessage({ __webhid_bridge: 'res', id, result })
  //                           postMessage({ __webhid_bridge: 'evt', event })
  // ---------------------------------------------------------------------------
  window.addEventListener("message", async (event) => {
    if (!event.data || event.data.__webhid_bridge !== "req") return;

    const { id, action, payload } = event.data;

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

  // Forward InputReport / connect / disconnect events pushed by background.js
  // into the page world as postMessage so the page-side HIDDevice can fire them.
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhid-device-event" && message.event) {
      window.postMessage(
        { __webhid_bridge: "evt", event: message.event },
        "*",
      );
    } else {
      console.debug("[content] skipping non-event message or missing event", message);
    }
  });

  // ---------------------------------------------------------------------------
  // Page-side API  (injected into the page's own JavaScript world)
  //
  // This function is stringified and injected as a <script> element so it runs
  // in the page context — not in the content script sandbox.  It must be
  // entirely self-contained: no references to outer content-script variables.
  // ---------------------------------------------------------------------------
  function pageAPI() {
    if (navigator.hid) return; // already installed

    let _reqId = 0;
    const _pending = {};

    // ── Device persistence helpers ────────────────────────────────────────────
    // Store and retrieve device permissions from addon storage (browser.storage.local)
    // Device permissions are stored per site origin on the addon side
    // Communication happens via sendRequest
    //
    // Device identification hash includes:
    // - vendor_id & product_id (USB IDs)
    // - serial_number (device serial, may be empty)
    // - path (device path, may be empty)
    // Hash is created from these fields to uniquely identify physical devices

    let _savedDevices = null; // Cache for granted device hashes
    let _deviceInfoCache = null; // Cache for device info (hash -> device) mapping

    /**
     * Creates a hash from device identifiers for effective unique device identification.
     * Uses vendor_id, product_id, serial_number, and path to create a stable identifier.
     * @param {Object} device - Device object with vendor_id, product_id, serial_number, path
     * @returns {string} Hex string hash
     */
    function createDeviceHash(device) {
      const vendorId = String(device.vendor_id || 0);
      const productId = String(device.product_id || 0);
      const serialNumber = String(device.serial_number || "");
      const path = String(device.path || "");
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

    async function getSavedDevices() {
      // Return cached hashes if available
      if (_savedDevices !== null) {
        return _savedDevices;
      }

      try {
        const result = await sendRequest(
          "getSavedDevices",
          { origin: window.location.origin },
        );
        _savedDevices = result.hashes || [];
        // Clear device cache so next getDevices() refreshes
        _deviceInfoCache = null;
        return _savedDevices;
      } catch (error) {
        return [];
      }
    }

    async function getDeviceCache() {
      if (_deviceInfoCache !== null) {
        return _deviceInfoCache;
      }

      try {
        const response = await sendRequest("enumerate");
        const devices = response.success && Array.isArray(response.devices) ? response.devices : [];
        _deviceInfoCache = new Map();
        for (const device of devices) {
          const hash = createDeviceHash(device);
          _deviceInfoCache.set(hash, device);
        }
        return _deviceInfoCache;
      } catch (error) {
        _deviceInfoCache = new Map();
        return _deviceInfoCache;
      }
    }

    async function getDeviceByHash(hash) {
      const cache = await getDeviceCache();
      return cache.get(hash) || null;
    }

    async function saveDevice(deviceInfo) {
      try {
        // Clear cache to force refresh
        _savedDevices = null;
        const deviceHash = createDeviceHash(deviceInfo);

        const result = await sendRequest(
          "saveDevice",
          {
            origin: window.location.origin,
            device: {
              hash: deviceHash,
            },
          }
        );

        if (result.success) {
          // Update cache with just the hashes array
          _savedDevices = result.hashes || [];
          // Clear device cache so next getDevices() refreshes
          _deviceInfoCache = null;
        }
      } catch (error) {

      }
    }

    async function deviceMatchesSaved(device) {
      const savedHashes = await getSavedDevices();
      const deviceHash = createDeviceHash(device);
      return savedHashes.includes(deviceHash);
    }

    // Listen for responses and events from the content script bridge.
    window.addEventListener("message", (event) => {
      if (!event.data) return;
      if (event.data.__webhid_bridge === "res") {
        const handler = _pending[event.data.id];
        if (handler) {
          delete _pending[event.data.id];
          handler(event.data.result);
        }
      }
    });

    function sendRequest(action, payload) {
      return new Promise((resolve) => {
        const id = ++_reqId;
        _pending[id] = resolve;
        window.postMessage(
          { __webhid_bridge: "req", id, action, payload: payload || {} },
          "*",
        );
      });
    }

    // ── Event classes ────────────────────────────────────────────────────────

    class HIDInputReportEvent extends Event {
      constructor(type, init) {
        super(type, init);
        this.device = init.device;
        this.reportId = init.reportId;
        this.data = init.data;
      }
    }

    class HIDConnectionEvent extends Event {
      constructor(type, device) {
        super(type);
        this.device = device;
      }
    }

    class HIDDeviceEvent extends Event {
      constructor(type, device) {
        super(type);
        this.device = device;
      }
    }

    // Very small, forgiving HID report-descriptor parser that extracts a
    // shallow collection tree (usage page / usage per Collection). This is
    // intentionally minimal: it looks for common opcodes (Usage Page = 0x05,
    // Usage = 0x09, Collection = 0xA1, End Collection = 0xC0) and associates
    // the most-recent usage/page with the following Collection. This will
    // cover many USB HID descriptors and provides immediate `collections`
    // data for pages; it is not a fully-compliant HID parser.
    function parseReportDescriptor(bytes) {
      const collections = [];
      const stack = [];
      let i = 0;
      let currentUsagePage = null;
      let currentUsage = null;

      const readData = (size) => {
        if (i + size > bytes.length) return null;
        let val = 0;
        for (let k = 0; k < size; k++) {
          val |= bytes[i + k] << (8 * k);
        }
        i += size;
        return val;
      };

      while (i < bytes.length) {
        const b = bytes[i++];
        if (b === 0x05) {
          // Usage Page (1 byte or 2)
          const v = readData(1);
          if (v !== null) currentUsagePage = v;
        } else if (b === 0x06) {
          // Usage Page (16-bit)
          const v = readData(2);
          if (v !== null) currentUsagePage = v;
        } else if (b === 0x09) {
          // Usage (1 byte)
          const v = readData(1);
          if (v !== null) currentUsage = v;
        } else if (b === 0x29) {
          // Usage (1 byte) (usage minimum/maximum - ignore)
          const v = readData(1);
        } else if (b === 0xA1) {
          // Collection, next byte is collection type
          const colType = readData(1);
          const col = { type: colType, usagePage: currentUsagePage, usage: currentUsage, children: [] };
          if (stack.length === 0) {
            collections.push(col);
          } else {
            stack[stack.length - 1].children.push(col);
          }
          stack.push(col);
          // After creating a collection, reset currentUsage to avoid leaking to subsequent siblings
          currentUsage = null;
        } else if (b === 0xC0) {
          // End Collection
          stack.pop();
        } else {
          // For other items interpret the short-item size encoded in low 2 bits
          const sizeCode = b & 0x03;
          let size = 0;
          if (sizeCode === 0) size = 0;
          else if (sizeCode === 1) size = 1;
          else if (sizeCode === 2) size = 2;
          else if (sizeCode === 3) size = 4;
          // consume that many bytes
          i += size;
        }
      }

      return collections;
    }

    // ── HIDDevice ─────────────────────────────────────────────────────────────

    class HIDDevice extends EventTarget {
          // Private fields for internal bookkeeping
          #inputReportListeners = new Map();  // Maps wrapper -> original listener
          #inputReportEventWrappers = new Map();  // Maps wrapper -> event wrapper function
          #oninputreportListener = null;  // The current oninputreport listener
          #parsedCollections = null;
          // Backing store for the read-only `opened` attribute.  The WebHID
          // spec mandates that `HIDDevice.opened` is a read-only boolean;
          // page code must not be able to flip it directly.
          #opened = false;

          constructor(deviceInfo) {
            super();
            this.vendorId = deviceInfo.vendor_id;
            this.productId = deviceInfo.product_id;
            this.productName = deviceInfo.product_name;
            this.manufacturer = deviceInfo.manufacturer;
            this.serialNumber = deviceInfo.serial_number;
            this.usbVendorId = deviceInfo.vendor_id;
        this.usbProductId = deviceInfo.product_id;
        // HID usage information (may be null/undefined if daemon didn't provide it)
        this.usagePage = deviceInfo.usage_page !== undefined ? deviceInfo.usage_page : null;
        this.usage = deviceInfo.usage !== undefined ? deviceInfo.usage : null;
        this.deviceId = null;
        // The hidraw path uniquely identifies this HID interface and is
        // what the daemon expects on `open`.  A composite USB device
        // exposes several interfaces — each gets its own HIDDevice
        // instance with a distinct path, even when vid/pid are identical.
        this.path = deviceInfo.path || null;

        // If the daemon provided parsed `collections`, prefer them. The
        // daemon-side collection objects may use snake_case field names; we
        // normalise them to the page API shape (camelCase + `type` instead
        // of `collection_type`).
        this.reportDescriptor = null;

        function normalizeCollection(c) {
          const out = {
            type: c.type !== undefined ? c.type : (c.collection_type !== undefined ? c.collection_type : null),
            usagePage: c.usagePage !== undefined ? c.usagePage : (c.usage_page !== undefined ? c.usage_page : null),
            usage: c.usage !== undefined ? c.usage : (c.usage !== undefined ? c.usage : null),
            children: [],
            // Always initialize report arrays to prevent "items is undefined" errors
            // when iterating over collections - WebHID spec expects these arrays
            // to always be present (even if empty).
            inputReports: [],
            outputReports: [],
            featureReports: [],
          };

          // Normalize children recursively
          if (Array.isArray(c.children) && c.children.length > 0) {
            out.children = c.children.map(normalizeCollection);
          }

          // If the daemon provided richer report metadata, populate the report arrays
          // Each report contains `reportId` and an `items` array with field-level metadata.
          if (Array.isArray(c.reports) && c.reports.length > 0) {
            c.reports.forEach((r) => {
              const rep = {
                reportId: r.id !== undefined && r.id !== null ? r.id : 0,
                items: Array.isArray(r.fields)
                  ? r.fields.map((f) => ({
                      reportId: f.report_id !== undefined && f.report_id !== null ? f.report_id : (r.id !== undefined && r.id !== null ? r.id : 0),
                      reportType: f.report_type !== undefined ? f.report_type : (r.report_type !== undefined ? r.report_type : null),
                      reportSize: f.size !== undefined ? f.size : (r.size_bits !== undefined ? r.size_bits : null),
                      reportCount: f.count !== undefined ? f.count : null,
                      usagePage: f.usage_page !== undefined ? f.usage_page : (f.usagePage !== undefined ? f.usagePage : null),
                      usage: f.usage !== undefined ? f.usage : null,
                      // Accept either legacy small `usages` (u16) or packed `packed_usages` (u32)
                      usages: Array.isArray(f.usages) ? f.usages : (Array.isArray(f.packed_usages) ? f.packed_usages : null),
                      // Forward additional optional attributes if present so pages can
                      // inspect them when available (preserve both snake_case and
                      // camelCase names from daemon-side serialization).
                      isArray: f.is_array !== undefined ? f.is_array : f.isArray !== undefined ? f.isArray : undefined,
                      isRange: f.is_range !== undefined ? f.is_range : f.isRange !== undefined ? f.isRange : undefined,
                      isAbsolute: f.is_absolute !== undefined ? f.is_absolute : f.isAbsolute !== undefined ? f.isAbsolute : undefined,
                      hasNull: f.has_null !== undefined ? f.has_null : f.hasNull !== undefined ? f.hasNull : undefined,
                      logicalMinimum: f.logical_minimum !== undefined ? f.logical_minimum : f.logicalMinimum !== undefined ? f.logicalMinimum : undefined,
                      logicalMaximum: f.logical_maximum !== undefined ? f.logical_maximum : f.logicalMaximum !== undefined ? f.logicalMaximum : undefined,
                      physicalMinimum: f.physical_minimum !== undefined ? f.physical_minimum : f.physicalMinimum !== undefined ? f.physicalMinimum : undefined,
                      physicalMaximum: f.physical_maximum !== undefined ? f.physical_maximum : f.physicalMaximum !== undefined ? f.physicalMaximum : undefined,
                      unitExponent: f.unit_exponent !== undefined ? f.unit_exponent : f.unitExponent !== undefined ? f.unitExponent : undefined,
                      unitSystem: f.unit_system !== undefined ? f.unit_system : f.unitSystem !== undefined ? f.unitSystem : undefined,
                      usageMinimum: f.usage_minimum !== undefined ? f.usage_minimum : f.usageMinimum !== undefined ? f.usageMinimum : undefined,
                      usageMaximum: f.usage_maximum !== undefined ? f.usage_maximum : f.usageMaximum !== undefined ? f.usageMaximum : undefined,
                      bitOffset: f.bit_offset !== undefined ? f.bit_offset : f.bitOffset !== undefined ? f.bitOffset : undefined,
                    }))
                  : [],
              };

              if (r.report_type === "input") out.inputReports.push(rep);
              else if (r.report_type === "output") out.outputReports.push(rep);
              else if (r.report_type === "feature") out.featureReports.push(rep);
            });
          }

          return out;
        }

        if (deviceInfo.collections && Array.isArray(deviceInfo.collections)) {
          try {
            this.#parsedCollections = deviceInfo.collections.map(normalizeCollection);
          } catch (e) {
            this.#parsedCollections = null;
          }
        } else if (deviceInfo.report_descriptor && Array.isArray(deviceInfo.report_descriptor)) {
          try {
            const arr = new Uint8Array(deviceInfo.report_descriptor);
            this.reportDescriptor = arr;
            this.#parsedCollections = parseReportDescriptor(arr);
          } catch (e) {
            this.reportDescriptor = null;
            this.#parsedCollections = null;
          }
        }
      }



      // Read-only `opened` attribute (WebHID spec compliant).  Page code
      // cannot assign to this; only `open()` / `close()` flip the
      // underlying private field.
      get opened() {
        return this.#opened;
      }

      // Return parsed collections (if available) or fallback to usage info.
      get collections() {
        if (this.#parsedCollections) return this.#parsedCollections;
        // Return a properly structured collection with empty report arrays
        // to match the WebHID spec and prevent "items is undefined" errors
        return [{
          usagePage: this.usagePage,
          usage: this.usage,
          inputReports: [],
          outputReports: [],
          featureReports: [],
          children: []
        }];
      }

      async open() {
        if (this.opened) {
          throw new DOMException("InvalidStateError");
        }
        if (!this.path) {
          throw new DOMException(
            "HIDDevice has no underlying hidraw path",
            "InvalidStateError",
          );
        }
        try {
          // Address the specific hidraw interface by path — sending only
          // vid/pid would let the daemon pick any one of several matching
          // interfaces and silently ignore the rest.
          const response = await sendRequest("open", {
            device_id: this.path.split("").map((c) => c.charCodeAt(0)),
          });
          if (response.success) {
            this.#opened = true;
            this.deviceId = String.fromCharCode(...response.data);
            this.dispatchEvent(new Event("open"));
            return true;
          }
          throw new Error(response.error || "Failed to open device");
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        }
      }

      async close() {
        if (!this.opened || !this.deviceId) return;
        try {
          const response = await sendRequest("close", {
            data: this.deviceId.split("").map((c) => c.charCodeAt(0)),
          });
          if (response.success) {
            this.#opened = false;
            this.deviceId = null;
            this.dispatchEvent(new Event("close"));
          } else {
            throw new Error("Failed to close device");
          }
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        }
      }

      async sendReport(reportId, data) {
        // console.debug("[WebHID]", `sendReport(${reportId}, new Uint8Array([${data}]).buffer)`);
        if (!this.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const buffer =
          data instanceof DataView
            ? new Uint8Array(data.buffer)
            : new Uint8Array(data);
        try {
          // The daemon prepends `report_id` to `data` before calling
          // `write(2)`; we must NOT include it in the data buffer
          // ourselves or the device will receive a corrupted report.
          const response = await sendRequest("write", {
            device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
            report_id: reportId,
            data: Array.from(buffer),
          });
          if (response.success) return;
          throw new Error("sendReport failed");
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      }

      async receiveFeatureReport(reportId) {
        if (!this.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        try {
          const response = await sendRequest("readFeatureReport", {
            device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
            report_id: reportId,
          });
          if (response.success && response.data) {
            return new DataView(new Uint8Array(response.data).buffer);
          }
          throw new Error("receiveFeatureReport failed");
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      }

      async sendFeatureReport(reportId, data) {
        if (!this.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const buffer =
          data instanceof DataView
            ? new Uint8Array(data.buffer)
            : new Uint8Array(data);
        try {
          const response = await sendRequest("writeFeatureReport", {
            device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
            report_id: reportId,
            data: Array.from(buffer),
          });
          if (response.success) {
            return undefined;
          }
          throw new Error("sendFeatureReport failed");
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      }

      addEventListener(type, listener) {
        super.addEventListener(type, listener);
        if (type === "inputreport") {
          const wrapper = (event) => {
            if (!event.data || event.data.__webhid_bridge !== "evt") return;
            const detail = event.data.event;

            if (!detail) {
              console.debug("[WebHID] wrapper: no detail, skipping");
              return;
            }

            const event_type = detail.event_type;

            // Decode device_id from the event for comparison
            const evDeviceId = detail.device_id
              ? String.fromCharCode(...detail.device_id)
              : null;

            // For input_report events, verify device ID matches
            if (event_type === "input_report") {
              if (evDeviceId && this.deviceId && evDeviceId !== this.deviceId) {
                return;
              }
              this.dispatchEvent(
                new HIDInputReportEvent("inputreport", {
                  device: this,
                  reportId: detail.report_id ?? 0,
                  data: new DataView(
                    new Uint8Array(detail.data ?? []).buffer,
                  ),
                }),
              );
              return;
            }

            // Handle connection events
            if (event_type === "connected") {
              this.dispatchEvent(new HIDConnectionEvent("connected", this));
              return;
            }

            // Handle disconnection events
            if (event_type === "disconnected") {
              this.dispatchEvent(new HIDConnectionEvent("disconnected", this));
              return;
            }

            console.debug("[WebHID] wrapper: unknown event_type:", event_type);
          };

          // Register this wrapper for the original listener
          // Use the listener's unique identity as key (listener.toString())
          const listenerKey = listener.toString();
          this.#inputReportListeners.set(listenerKey, listener);
          this.#inputReportEventWrappers.set(wrapper, (event) => {
            // Call the registered listener
            listener(event);
          });

          window.addEventListener("message", wrapper);

        }
      }

      removeEventListener(type, listener) {
        super.removeEventListener(type, listener);
        if (type === "inputreport") {
          // For removeEventListener called from oninputreport setter (with null),
          // the listener passed is the current one stored in #oninputreportListener
          if (!listener || !listener.toString()) {
            // Clear all listeners when removing oninputreport
            this.#inputReportListeners.clear();
            this.#inputReportEventWrappers.forEach((fn, wrapperKey) => {
              window.removeEventListener("message", fn);
            });
            this.#inputReportEventWrappers.clear();
          } else {
            // Remove specific listener
            const listenerKey = listener.toString();
            this.#inputReportListeners.delete(listenerKey);

            // Remove window message listener if no wrappers left
            if (this.#inputReportListeners.size === 0) {
              this.#inputReportEventWrappers.forEach((fn, wrapperKey) => {
                window.removeEventListener("message", fn);
              });
              this.#inputReportEventWrappers.clear();
              this.#inputReportListeners.clear();
            }
          }
        }
      }

      get oninputreport() {
        return this.#oninputreportListener;
      }

      set oninputreport(listener) {
        // Always pass the current listener to removeEventListener
        const currentListener = this.#oninputreportListener;
        this.removeEventListener("inputreport", currentListener);

        // Set the new listener
        if (listener !== null) {
          this.addEventListener("inputreport", listener);
        } else {
          this.#oninputreportListener = null;
        }
      }
    }

    // ── HID (navigator.hid) ───────────────────────────────────────────────────

    class HID extends EventTarget {
      async getDevices() {
        // Returns a Promise that resolves with an array of connected HID devices
        // that the user has previously been granted access to in response to a
        // requestDevice() call.
        try {
          const savedHashes = await getSavedDevices();
          const deviceCache = await getDeviceCache();
          const grantedDevices = [];
          for (const hash of savedHashes) {
            const device = deviceCache.get(hash);
            if (device) {
              grantedDevices.push(new HIDDevice(device));
            }
          }
          return grantedDevices;
        } catch (error) {
          return [];
        }
      }

      // Per the WebHID spec the argument is an options object: { filters: [] }
      async requestDevice(options = {}) {
        const filters = Array.isArray(options.filters) ? options.filters : [];
        return new Promise((resolve, reject) => {
          const id = ++_reqId;
          _pending[id] = (result) => {
            if (result.cancelled) {
              reject(new DOMException("No device selected", "NotFoundError"));
            } else {
              // result may contain 'devices' (array) or legacy 'device' (single)
              const devices = result.devices || (result.device ? [result.device] : []);
              if (devices.length === 0) {
                reject(new DOMException("No device selected", "NotFoundError"));
                return;
              }

              // Save each selected device permission for future getDevices() calls
              for (const d of devices) {
                saveDevice(d);
              }

              // Resolve with an array of HIDDevice instances per spec
              resolve(devices.map((d) => new HIDDevice(d)));
            }
          };
          window.postMessage(
            {
              __webhid_bridge: "req",
              id,
              action: "requestDevice",
              payload: { filters }, // always an array
            },
            "*",
          );
        });
      }
    }

    // ── Expose ────────────────────────────────────────────────────────────────

    navigator.hid = new HID();
    window.HIDDevice = HIDDevice;
    window.HIDInputReportEvent = HIDInputReportEvent;
    window.HIDConnectionEvent = HIDConnectionEvent;
    window.HIDDeviceEvent = HIDDeviceEvent;
  }

  // Inject the page-side API into the page's own JavaScript world.
  // Using a <script> element (same pattern as Sainan/WebHID-for-Firefox) is the
  // standard way to escape Firefox's content-script Xray Vision sandbox.
  const _script = document.createElement("script");
  _script.textContent = "(" + pageAPI.toString() + ")()";
  document.documentElement.appendChild(_script);
  _script.remove();

})();
