(function () {
  "use strict";
  const { logger, fetchResource, http, guessDeviceType } = globalThis.__webhid;
  logger.initLogger("picker");

  const _svgCache = {};

  async function _getSvg(type) {
    if (_svgCache[type]) return _svgCache[type];
    try {
      const svg = await fetchResource(`res/${type}.svg`);
      _svgCache[type] = svg;
      return svg;
    } catch {
      return null;
    }
  }

  class WebHidDevicePicker {
    #shadow = null;
    #host = null;
    #dialog = null;
    #devices = [];
    #filters = [];
    #deviceGroups = {};
    #pairedDevices = null;
    #fragmentReady = null;

    constructor() {
      this.#host = document.createElement("div");
      this.#host.id = "webhid-shadow-host";
      this.#shadow = this.#host.attachShadow({ mode: "closed" });
      this.#fragmentReady = this.#loadFragment();
    }

    get host() {
      return this.#host;
    }

    async #loadFragment() {
      const html = await fetchResource("html/device-picker.fragment.html");
      const doc = new DOMParser().parseFromString(html, "text/html");

      const pickerTpl = doc.querySelector("#webhid-picker-template");
      this.#shadow.appendChild(pickerTpl.content.cloneNode(true));

      const deviceTpl = doc.querySelector("#webhid-device-template");
      this.#shadow.appendChild(deviceTpl);

      this.#dialog = this.#shadow.querySelector(".webhid-modal");

      this.#dialog.addEventListener("close", () => {
        const returnValue = this.#dialog.returnValue;
        const checked = this.#dialog.querySelector(
          ".webhid-device-radio:checked",
        );
        const deviceId = checked?.value;
        if (returnValue === "selected" && deviceId) {
          this.#onDeviceSelected(this.#deviceGroups[deviceId] || []);
        } else {
          this.#onDeviceCancelled();
        }

        const hide = () => {
          this.#dialog.style.display = "none";
        };
        this.#dialog.addEventListener("transitionend", hide, { once: true });
        setTimeout(hide, 300);
      });

      this.#dialog.addEventListener("change", (e) => {
        if (!e.target.matches(".webhid-device-radio")) return;
        this.#dialog
          .querySelectorAll(".webhid-device-item")
          .forEach((el) => el.classList.remove("selected"));
        e.target.closest(".webhid-device-item").classList.add("selected");
        this.#dialog.querySelector("#webhidConnectBtn").disabled = false;
      });

      this.#dialog.addEventListener("click", (e) => {
        if (e.target === this.#dialog) this.#dialog.close();
      });
    }

    async show(filters = []) {
      await this.#fragmentReady;
      this.#filters = filters;

      if (typeof this.#dialog.showModal === "function") {
        if (this.#dialog.open) this.#dialog.close();
        this.#dialog.style.display = "";
        await new Promise((r) => requestAnimationFrame(r));
        this.#dialog.showModal();
      } else {
        this.#dialog.setAttribute("open", "");
      }

      this.#loadDevices();
    }

    async refreshDevices() {
      if (!this.#dialog || !this.#dialog.open) return;
      this.#pairedDevices = null;
      await this.#loadDevices();
    }

    get isOpen() {
      return this.#dialog?.open ?? false;
    }

    async #loadDevices() {
      try {
        const response = await browser.runtime.sendMessage({
          action: "enumerate",
        });
        if (response && http.isOk(response.s)) {
          this.#devices = response.D || [];
        } else {
          this.#devices = [];
          const code = response?.s || 0;
          if (code === 500) {
            logger.warn("enumerate returned 500, treating as empty list");
          } else {
            logger.warn("enumerate returned status", code);
          }
        }
        this.#renderDevices();
      } catch (error) {
        this.#devices = [];
        logger.warn("enumerate exception:", error?.message || error);
        this.#renderDevices();
      }
    }

    #classifyError(errMsg) {
      const e = (errMsg || "").toLowerCase();
      if (e.includes("nm disconnected") || e.includes("reconnecting"))
        return "Native messaging host is not responding. Please ensure the WebHID daemon is installed and running.";
      if (e.includes("permission denied") || e.includes("access denied"))
        return "Permission denied. The daemon may lack access to HID devices (check udev rules on Linux, or run daemon as admin on Windows).";
      if (
        e.includes("no such file") ||
        e.includes("not found") ||
        e.includes("connection refused")
      )
        return "Cannot connect to the WebHID daemon. Please install it and ensure the service is running.";
      if (e.includes("timeout") || e.includes("timed out"))
        return "Connection to the WebHID daemon timed out. Please check if the daemon is running.";
      return "Failed to load devices: " + errMsg;
    }

    #showMessage(message, isError = false) {
      if (!this.#dialog) return;
      const deviceList = this.#dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      deviceList.innerHTML = "";
      const div = document.createElement("div");
      div.className = isError ? "webhid-error" : "webhid-no-devices";
      div.textContent = message;
      deviceList.appendChild(div);
    }

    async #getPairedDevices() {
      if (this.#pairedDevices !== null) return this.#pairedDevices;
      try {
        const result = await browser.runtime.sendMessage({
          action: "getPairedDevices",
          origin: window.location.origin,
        });
        this.#pairedDevices = result.hashes || [];
        return this.#pairedDevices;
      } catch {
        return [];
      }
    }

    async #deviceMatchesSaved(device) {
      const pairedIds = await this.#getPairedDevices();
      return pairedIds.includes(device.deviceId);
    }

    async #renderDevices() {
      if (!this.#dialog) return;
      const deviceList = this.#dialog.querySelector("#webhidDeviceList");
      if (!deviceList) return;
      deviceList.innerHTML = "";

      if (this.#devices.length === 0) {
        deviceList.innerHTML =
          '<div class="webhid-no-devices">No HID devices found</div>';
        return;
      }

      const filteredDevices = this.#applyFilters(this.#devices, this.#filters);
      if (filteredDevices.length === 0) {
        deviceList.innerHTML =
          '<div class="webhid-no-devices">No devices match the specified filters</div>';
        return;
      }

      const groups = new Map();
      for (const device of filteredDevices) {
        const name = device.productName || "Unknown Device";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(device);
      }

      const pairedStatuses = await Promise.all(
        filteredDevices.map((device) => this.#deviceMatchesSaved(device)),
      );

      this.#deviceGroups = {};

      const tpl = this.#shadow.getElementById("webhid-device-template");

      for (const [name, devices] of groups.entries()) {
        let isPaired = false;
        const deviceIds = [];
        for (const d of devices) {
          const idx = filteredDevices.indexOf(d);
          if (idx >= 0 && pairedStatuses[idx]) isPaired = true;
          deviceIds.push(d.deviceId);
        }

        const groupId =
          devices.length === 1
            ? devices[0].deviceId
            : `group:${devices[0].deviceId}`;
        this.#deviceGroups[groupId] = devices.slice();

        const device = devices[0];
        const type = guessDeviceType(device);

        const clone = tpl.content.cloneNode(true);
        const item = clone.querySelector(".webhid-device-item");
        const radio = clone.querySelector(".webhid-device-radio");

        radio.value = groupId;
        item.classList.toggle("webhid-device-paired", isPaired);
        item.dataset.deviceId = groupId;

        const iconSpan = clone.querySelector(".webhid-device-icon");
        _getSvg(type).then((svg) => {
          if (svg) {
            const svgDoc = new DOMParser().parseFromString(
              svg,
              "image/svg+xml",
            );
            const svgEl = svgDoc.documentElement;
            if (svgEl) iconSpan.replaceChildren(svgEl.cloneNode(true));
          }
        });

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
      if (!Array.isArray(filters) || filters.length === 0) return devices;
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
          const paired = await this.#getPairedDevices();
          for (const d of devicesArr) {
            if (!paired.includes(d.deviceId)) paired.push(d.deviceId);
          }
          this.#pairedDevices = paired;
        } catch {}
      })();
      window.dispatchEvent(event);
    }

    #onDeviceCancelled() {
      window.dispatchEvent(
        new CustomEvent("webhid-device-cancelled", { detail: {} }),
      );
    }
  }

  globalThis.__webhid = globalThis.__webhid || {};
  globalThis.__webhid.WebHidDevicePicker = WebHidDevicePicker;
})();
