(function () {
  "use strict";
  const logger = globalThis.__webhid.import("logger");
  const fetchResource = globalThis.__webhid.import("fetchResource");
  const http = globalThis.__webhid.import("http");
  const guessDeviceType = globalThis.__webhid.import("guessDeviceType");
  const applyFilters = globalThis.__webhid.import("applyFilters");
  const groupDevices = globalThis.__webhid.import("groupDevices");
  const fetchDeviceIcon = globalThis.__webhid.import("fetchDeviceIcon");
  logger.initLogger("picker");

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
      const html = await fetchResource("html/picker.fragment.html");
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const child of doc.body.children) {
        this.#shadow.appendChild(child);
      }

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

      const filteredDevices = applyFilters(this.#devices, this.#filters);
      if (filteredDevices.length === 0) {
        deviceList.innerHTML =
          '<div class="webhid-no-devices">No devices match the specified filters</div>';
        return;
      }

      const groups = groupDevices(filteredDevices);

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

        const groupId = devices.length === 1 ? devices[0].deviceId : "group:" + devices[0].deviceId;
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
        fetchDeviceIcon(type).then((svg) => {
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

  __webhid.export("WebHidDevicePicker", WebHidDevicePicker);
})();
