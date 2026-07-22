(async () => {
  const logger = webhid.import("logger");
  const http = webhid.import("http");
  const guessDeviceType = webhid.import("guessDeviceType");
  const GLOBAL_DEFAULTS = webhid.import("GLOBAL_DEFAULTS");
  const applyFilters = webhid.import("applyFilters");
  const groupDevices = webhid.import("groupDevices");
  const fetchDeviceIcon = webhid.import("fetchDeviceIcon");
  logger.initLogger("picker-popup");

  const listEl = document.getElementById("picker-list");
  const cancelBtn = document.getElementById("picker-cancel");
  const connectBtn = document.getElementById("picker-connect");

  let selectedDeviceId = null;
  let deviceGroups = {};
  let pendingRequest = null;

  async function loadPending() {
    const resp = await browser.runtime.sendMessage({
      action: "getPendingPicker",
    });
    pendingRequest = resp;
    if (!pendingRequest) {
      listEl.innerHTML =
        '<div class="webhid-no-devices">No pending device request</div>';
      return;
    }
    await loadDevices();
  }

  async function loadDevices() {
    listEl.innerHTML = '<div class="webhid-loading">Loading devices...</div>';
    const response = await browser.runtime.sendMessage({ action: "enumerate" });
    const devices =
      http.isOk(response.s) && Array.isArray(response.D) ? response.D : [];

    const filtered = applyFilters(devices, pendingRequest.filters || []);
    if (filtered.length === 0) {
      logger.warn(
        "picker: 0/" +
          devices.length +
          " devices matched filters=" +
          JSON.stringify(pendingRequest.filters || []),
      );
      for (const d of devices) {
        const vidHex = "0x" + (d.vendorId || 0).toString(16).padStart(4, "0");
        const pidHex = "0x" + (d.productId || 0).toString(16).padStart(4, "0");
        const upHex = "0x" + (d.usagePage || 0).toString(16).padStart(4, "0");
        logger.warn(
          "  excluded: " +
            (d.productName || "(unnamed)") +
            " VID=" +
            vidHex +
            " PID=" +
            pidHex +
            " usagePage=" +
            upHex +
            " usage=" +
            (d.usage || 0),
        );
      }
      listEl.innerHTML =
        '<div class="webhid-no-devices">No devices match the specified filters</div>';
      return;
    }
    logger.debug(
      "picker: " + filtered.length + "/" + devices.length + " devices matched",
    );

    const groups = groupDevices(filtered);

    deviceGroups = {};
    listEl.innerHTML = "";

    for (const [name, devs] of groups.entries()) {
      const groupId =
        devs.length === 1 ? devs[0].deviceId : "group:" + devs[0].deviceId;
      deviceGroups[groupId] = devs.slice();

      const device = devs[0];
      const type = guessDeviceType(device);

      const item = document.createElement("label");
      item.className = "webhid-device-item";
      item.tabIndex = 0;
      item.dataset.deviceId = groupId;

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "webhid-device";
      radio.className = "webhid-device-radio";
      radio.value = groupId;

      const iconSpan = document.createElement("span");
      iconSpan.className = "webhid-device-icon";

      const body = document.createElement("div");
      body.className = "webhid-device-body";

      const nameEl = document.createElement("div");
      nameEl.className = "webhid-device-name";
      nameEl.textContent = name;
      body.appendChild(nameEl);

      if (device.manufacturer) {
        const vendorEl = document.createElement("div");
        vendorEl.className = "webhid-device-vendor";
        vendorEl.textContent = device.manufacturer;
        body.appendChild(vendorEl);
      }

      if (devs.length > 1) {
        const ifaceEl = document.createElement("div");
        ifaceEl.className = "webhid-device-iface";
        ifaceEl.textContent = `${devs.length} interfaces`;
        body.appendChild(ifaceEl);
      }

      item.appendChild(radio);
      item.appendChild(iconSpan);
      item.appendChild(body);
      fetchDeviceIcon(type).then((svg) => {
        if (svg) {
          const svgDoc = new DOMParser().parseFromString(svg, "image/svg+xml");
          const svgEl = svgDoc.documentElement;
          if (svgEl) iconSpan.replaceChildren(svgEl.cloneNode(true));
        }
      });
      radio.addEventListener("change", () => {
        selectedDeviceId = groupId;
        connectBtn.disabled = false;
        listEl
          .querySelectorAll(".webhid-device-item")
          .forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");
      });

      listEl.appendChild(item);
    }
  }

  connectBtn.addEventListener("click", async () => {
    if (!selectedDeviceId || !pendingRequest) return;
    const devices = deviceGroups[selectedDeviceId] || [];
    await browser.runtime.sendMessage({
      action: "picker-result",
      requestId: pendingRequest.requestId,
      tabId: pendingRequest.tabId,
      windowId: browser.windows?.getCurrent
        ? (await browser.windows.getCurrent()).id
        : undefined,
      selected: true,
      devices,
    });
    pendingRequest = null;
    window.close();
  });

  cancelBtn.addEventListener("click", async () => {
    if (pendingRequest) {
      await browser.runtime.sendMessage({
        action: "picker-result",
        requestId: pendingRequest.requestId,
        tabId: pendingRequest.tabId,
        windowId: browser.windows?.getCurrent
          ? (await browser.windows.getCurrent()).id
          : undefined,
        selected: false,
      });
      pendingRequest = null;
    }
    window.close();
  });

  window.addEventListener("unload", () => {
    if (pendingRequest) {
      browser.runtime.sendMessage({
        action: "picker-result",
        requestId: pendingRequest.requestId,
        tabId: pendingRequest.tabId,
        windowId: browser.windows?.getCurrent ? undefined : undefined,
        selected: false,
      });
    }
  });

  await loadPending();
})();
