// WebHID Standard implementation with injected modal

(function () {
  "use strict";

  // Modal styles (injected into page)
  const modalStyles = `
    /* The <dialog> fills the viewport so clicks on the dark area
       (e.target === dialog) can be detected to close the picker. */
    .webhid-modal {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      padding: 0;
      margin: 0;
      border: none;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
      padding: 8px 0 0 10px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .webhid-modal::backdrop {
      display: none;
    }

    /* The <form> is the speech-bubble card anchored to the top-left.
       drop-shadow (unlike box-shadow) follows the shape including the
       ::before arrow, so the shadow wraps the whole bubble correctly. */
    .webhid-modal-form {
      background: white;
      border-radius: 12px;
      width: min(400px, calc(100vw - 20px));
      max-width: calc(100vw - 20px);
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      position: relative;
      filter: drop-shadow(0 6px 20px rgba(0, 0, 0, 0.35));
      animation: webhidModalSlideIn 0.2s ease-out;
    }

    /* Upward-pointing arrow that makes the card look like a speech bubble
       coming from the browser toolbar area */
    .webhid-modal-form::before {
      content: '';
      position: absolute;
      top: -9px;
      left: 16px;
      border: 9px solid transparent;
      border-top: none;
      border-bottom-color: white;
    }

    @keyframes webhidModalSlideIn {
      from {
        transform: translateY(-8px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .webhid-modal-header {
      padding: 24px 24px 16px;
      border-bottom: 1px solid #eee;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .webhid-modal-header h2 {
      font-size: 18px;
      font-weight: 600;
      color: #1a1a1a;
      margin: 0;
    }

    .webhid-close-button {
      background: none;
      border: none;
      font-size: 24px;
      color: #999;
      cursor: pointer;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background-color 0.2s;
    }

    .webhid-close-button:hover {
      background-color: #f5f5f5;
      color: #666;
    }

    .webhid-modal-content {
      padding: 16px 24px;
      overflow-y: auto;
      flex: 1;
    }

    .webhid-device-list {
      max-height: 300px;
      overflow-y: auto;
      padding: 6px 8px;
    }

    .webhid-device-item {
      padding: 12px 16px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: all 0.2s;
      background: #fafafa;
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .webhid-device-icon {
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      opacity: 0.55;
    }

    .webhid-device-body {
      flex: 1;
      min-width: 0;
    }

    .webhid-device-item:hover {
      border-color: #4a90e2;
      background: #f0f7ff;
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(74, 144, 226, 0.2);
    }

    .webhid-device-item.selected {
      border-color: #4a90e2;
      background: #e3f2fd;
    }

    .webhid-device-name {
      font-size: 16px;
      font-weight: 500;
      color: #1a1a1a;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .webhid-device-name.webhid-name-overflow {
      cursor: default;
    }

    .webhid-device-item:hover .webhid-device-name.webhid-name-overflow {
      text-overflow: clip;
      animation: webhid-marquee 3s 0.4s ease-in-out infinite alternate;
    }

    @keyframes webhid-marquee {
      from { transform: translateX(0); }
      to   { transform: translateX(calc(-1px * var(--webhid-overflow))); }
    }

    .webhid-device-info {
      font-size: 14px;
      color: #666;
      margin-bottom: 2px;
    }

    .webhid-device-vendor {
      font-size: 12px;
      color: #999;
    }

    .webhid-loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }

    .webhid-no-devices {
      text-align: center;
      padding: 40px;
      color: #999;
      font-style: italic;
    }

    .webhid-device-iface {
      font-size: 11px;
      color: #aaa;
      font-family: monospace;
      margin-top: 2px;
    }

    .webhid-modal-footer {
      padding: 16px 24px 24px;
      border-top: 1px solid #eee;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }

    .webhid-cancel-button {
      padding: 12px 24px;
      border: 1px solid #ddd;
      border-radius: 6px;
      background: white;
      color: #666;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .webhid-cancel-button:hover {
      background: #f5f5f5;
      border-color: #ccc;
    }
  `;

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

      this.init();
    }

    init() {
      this.injectStyles();
      this.injectTemplate();
      this.setupEventListeners();
    }

    injectStyles() {
      if (!document.getElementById("webhid-modal-styles")) {
        const style = document.createElement("style");
        style.id = "webhid-modal-styles";
        style.textContent = modalStyles; // assumes modalStyles is defined in scope
        document.head.appendChild(style);
      }
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
      this.dialog = tpl.content.firstElementChild.cloneNode(true);

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
          this.renderDevices();
        } else {
          this.showError("Failed to load devices");
        }
      } catch (error) {
        console.error("Failed to load devices:", error);
        this.showError("Failed to connect to server");
      }
    }

    renderDevices() {
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

      const ambiguous = this._ambiguousPaths(filteredDevices);

      deviceList.innerHTML = filteredDevices
        .map((device) => {
          const deviceId = this.getDeviceId(device);
          const type    = this._guessDeviceType(device);
          const iconUrl = browser.runtime.getURL(`res/${type}.svg`);
          // When multiple interfaces share the same display name, append the
          // hidraw node (e.g. "hidraw3") so the user can tell them apart.
          const iface = ambiguous.has(device.path)
            ? `<div class="webhid-device-iface">${this.escapeHtml(device.path.split("/").pop())}</div>`
            : "";
          return `
            <div class="webhid-device-item" data-device-id="${this.escapeHtml(deviceId)}" tabindex="0" role="button" aria-label="Select device ${this.escapeHtml(device.product_name || "Unknown Device")}">
              <img class="webhid-device-icon" src="${iconUrl}" alt="${type}" draggable="false">
              <div class="webhid-device-body">
                <div class="webhid-device-name">${this.escapeHtml(device.product_name || "Unknown Device")}</div>
                <div class="webhid-device-info">Vendor: ${this.hex(device.vendor_id)} Product: ${this.hex(device.product_id)}</div>
                ${device.manufacturer ? `<div class="webhid-device-vendor">${this.escapeHtml(device.manufacturer)}</div>` : ""}
                ${iface}
              </div>
            </div>
          `;
        })
        .join("");

      // Measure each name element after it's in the DOM.
      // If the text overflows its container, tag it and set the exact
      // scroll distance as a CSS variable so the animation never over-scrolls.
      deviceList.querySelectorAll(".webhid-device-name").forEach((el) => {
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 0) {
          el.classList.add("webhid-name-overflow");
          el.style.setProperty("--webhid-overflow", overflow);
        }
      });
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
      this.selectedDevice = this.devices.find(
        (d) => this.getDeviceId(d) === deviceId,
      );

      // Close the dialog with returnValue "selected".
      // _onDialogClose reads this value before cleanup and calls onDeviceSelected.
      if (this.dialog?.open) {
        this.dialog.close("selected");
      }
    }

    getDeviceId(device) {
      // Use the hidraw path as the stable, per-interface unique ID.
      // A physical device with multiple HID interfaces has multiple paths
      // (e.g. /dev/hidraw3 and /dev/hidraw4) that must remain distinct.
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
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    onDeviceSelected(device) {
      const event = new CustomEvent("webhid-device-selected", {
        detail: { device },
      });
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
        window.postMessage(
          { __webhid_bridge: "res", id, result: { device: e.detail.device } },
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

    // ── HIDDevice ─────────────────────────────────────────────────────────────

    class HIDDevice extends EventTarget {
      constructor(deviceInfo) {
        super();
        this.vendorId = deviceInfo.vendor_id;
        this.productId = deviceInfo.product_id;
        this.productName = deviceInfo.product_name;
        this.manufacturer = deviceInfo.manufacturer;
        this.serialNumber = deviceInfo.serial_number;
        this.usbVendorId = deviceInfo.vendor_id;
        this.usbProductId = deviceInfo.product_id;
        this.opened = false;
        this.deviceId = null;
        this._inputReportListener = null;
      }

      async open() {
        try {
          const response = await sendRequest("open", {
            vendor_id: this.vendorId,
            product_id: this.productId,
          });
          if (response.success) {
            this.opened = true;
            this.deviceId = String.fromCharCode(...response.data);
            this.dispatchEvent(new Event("open"));
            return true;
          }
          throw new Error("Failed to open device");
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
            this.opened = false;
            this.deviceId = null;
            this.dispatchEvent(new Event("close"));
          } else {
            throw new Error("Failed to close device");
          }
        } catch (error) {
          throw new DOMException(error.message, "InvalidStateError");
        }
      }

      async read(expectedLength, timeout = null) {
        if (!this.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        try {
          const response = await sendRequest("read", {
            data: this.deviceId.split("").map((c) => c.charCodeAt(0)),
            timeout: timeout || 1000,
          });
          if (response.success) {
            return new DataView(new Uint8Array(response.data).buffer);
          }
          throw new Error("Read failed");
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      }

      async write(data) {
        if (!this.opened)
          throw new DOMException("Device is not open", "InvalidStateError");
        const buffer =
          data instanceof DataView
            ? new Uint8Array(data.buffer)
            : new Uint8Array(data);
        try {
          const response = await sendRequest("write", {
            device_id: this.deviceId.split("").map((c) => c.charCodeAt(0)),
            data: Array.from(buffer),
          });
          if (response.success) return buffer.length;
          throw new Error("Write failed");
        } catch (error) {
          throw new DOMException(error.message, "NetworkError");
        }
      }

      addEventListener(type, listener) {
        super.addEventListener(type, listener);
        if (type === "inputreport" && !this._inputReportListener) {
          this._inputReportListener = (event) => {
            if (!event.data || event.data.__webhid_bridge !== "evt") return;
            const detail = event.data.event;
            if (!detail || detail.event_type !== "input_report") return;
            const evDeviceId = detail.device_id
              ? String.fromCharCode(...detail.device_id)
              : null;
            if (evDeviceId !== this.deviceId) return;
            this.dispatchEvent(
              new HIDInputReportEvent("inputreport", {
                device: this,
                reportId: detail.report_id ?? 0,
                data: new DataView(
                  new Uint8Array(detail.data ?? []).buffer,
                ),
              }),
            );
          };
          window.addEventListener("message", this._inputReportListener);
        }
      }

      removeEventListener(type, listener) {
        super.removeEventListener(type, listener);
        if (type === "inputreport" && this._inputReportListener) {
          window.removeEventListener("message", this._inputReportListener);
          this._inputReportListener = null;
        }
      }
    }

    // ── HID (navigator.hid) ───────────────────────────────────────────────────

    class HID extends EventTarget {
      async getDevices() {
        try {
          const response = await sendRequest("enumerate");
          if (response.success) {
            return response.devices.map((d) => new HIDDevice(d));
          }
          return [];
        } catch {
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
              resolve(new HIDDevice(result.device));
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
