(async () => {
  /** @type {import("../types.js").Logger} */
  const logger = webhid.import("logger");
  const guessDeviceType = webhid.import("guessDeviceType");
  const t = webhid.import("t");
  const localizeHTML = webhid.import("localizeHTML");
  const loadGlobalSettings = webhid.import("loadGlobalSettings");
  const loadSiteSettings = webhid.import("loadSiteSettings");
  const saveSiteSetting = webhid.import("saveSiteSetting");
  const syncBrowserTheme = webhid.import("syncBrowserTheme");
  logger.initLogger("popup");

  syncBrowserTheme();
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme);

  localizeHTML(document);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  /** @type {string} */
  let origin = "";
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        origin = url.origin;
      }
    } catch (e) {
      logger.debug("URL parse failed", e);
    }
  }

  /** @type {HTMLElement} */
  const siteLabel = document.getElementById("site-name");
  siteLabel.textContent = origin || t("popupNoSite");

  /**
   * Loads global and site settings, merging site overrides on top of global defaults.
   * @returns {Promise<object>}
   */
  async function loadSettings() {
    const global = await loadGlobalSettings();
    if (!origin) return global;
    const site = await loadSiteSettings(origin);
    return { ...global, ...site };
  }

  /**
   * Saves a single site-level setting.
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async function saveSetting(key, value) {
    if (!origin) return;
    await saveSiteSetting(origin, key, value);
  }

  const settings = await loadSettings();

  /** @type {HTMLSelectElement} */
  const dataPlaneSelect = document.getElementById("dataPlane");
  dataPlaneSelect.value = settings.dataPlane;
  /** @type {HTMLInputElement} */
  document.getElementById("workerPolyfillEnabled").checked =
    settings.workerPolyfillEnabled || false;

  /** @type {HTMLSelectElement} */
  const logLevelSelect = document.getElementById("logLevel");
  logLevelSelect.value = String(settings.logLevel);

  dataPlaneSelect.addEventListener("change", (e) => {
    saveSetting("dataPlane", e.target.value);
  });
  document
    .getElementById("workerPolyfillEnabled")
    .addEventListener("change", (e) => {
      saveSetting("workerPolyfillEnabled", e.target.checked);
    });
  logLevelSelect.addEventListener("change", (e) => {
    saveSetting("logLevel", parseInt(e.target.value, 10));
  });

  /** @returns {Promise<string[]>} */
  async function loadDevices() {
    if (!origin) return [];
    try {
      const resp = await browser.runtime.sendMessage({
        action: "getPairedDevices",
        origin,
      });
      return resp && resp.success ? resp.hashes : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} hash
   * @returns {Promise<void>}
   */
  async function removeDevice(hash) {
    if (!origin) return;
    try {
      await browser.runtime.sendMessage({
        action: "revokeDevice",
        deviceId: hash,
        origin,
      });
    } catch (e) {
      logger.debug("revokeDevice failed", e);
    }
    renderDevices();
  }

  /** @type {number} */
  let renderToken = 0;
  /** @returns {Promise<void>} */
  async function renderDevices() {
    const token = ++renderToken;
    /** @type {HTMLElement} */
    const list = document.getElementById("device-list");
    /** @type {HTMLElement} */
    const noDevices = document.getElementById("no-devices");
    const hashes = await loadDevices();

    if (token !== renderToken) return;

    list.innerHTML = "";
    if (hashes.length === 0) {
      noDevices.style.display = "block";
      return;
    }
    noDevices.style.display = "none";

    const response = await browser.runtime.sendMessage({
      action: "getDeviceCache",
    });
    if (token !== renderToken) return;
    /** @type {import("../types.js").HIDDeviceInfo[]} */
    const cache = (response && response.devices) || [];

    /** @type {Set<string>} */
    let openIds = new Set();
    try {
      const r = await browser.tabs.sendMessage(tab.id, {
        action: "getOpenDeviceIds",
      });
      var rIds = r != null ? r.ids : undefined;
      if (rIds) openIds = new Set(rIds);
    } catch (e) {
      logger.debug("getOpenDeviceIds failed", e);
    }

    if (token !== renderToken) return;

    let openCount = 0;
    for (const hash of hashes) {
      /** @type {import("../types.js").HIDDeviceInfo|undefined} */
      let device = cache.find((d) => d.deviceId === hash);
      if (!device) {
        try {
          const r = await browser.runtime.sendMessage({
            action: "getDeviceInfo",
            deviceId: hash,
          });
          device = r != null ? (r.device != null ? r.device : null) : null;
        } catch (e) {
          logger.debug("getDeviceInfo failed", e);
        }
      }
      if (token !== renderToken) return;

      const isDisconnected = !cache.some((d) => d.deviceId === hash);
      const name = device
        ? device.productName || t("popupUnknown")
        : t("popupPairedDevice");
      const type = guessDeviceType(device || { productName: name });
      const vid = device ? device.vendorId || 0 : 0;
      const pid = device ? device.productId || 0 : 0;
      const manufacturer = device ? device.manufacturer || "" : "";

      const card = document.createElement("div");
      card.className = "device-card";
      card.setAttribute("role", "listitem");
      if (isDisconnected) card.classList.add("disconnected");
      if (device && !isDisconnected && openIds.has(device.deviceId))
        card.classList.add("open");

      const icon = document.createElement("img");
      icon.className = "device-icon";
      icon.src = browser.runtime.getURL(`res/${type}.svg`);
      icon.alt = type;
      card.appendChild(icon);

      const info = document.createElement("div");
      info.className = "device-info";

      const nameEl = document.createElement("div");
      nameEl.className = "device-name";
      nameEl.textContent = name;
      info.appendChild(nameEl);

      if (manufacturer) {
        const vendorEl = document.createElement("div");
        vendorEl.className = "device-vendor";
        vendorEl.textContent = manufacturer;
        info.appendChild(vendorEl);
      }

      const vidEl = document.createElement("div");
      vidEl.className = "device-vid";
      vidEl.textContent = `${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;
      info.appendChild(vidEl);

      card.appendChild(info);

      const btn = document.createElement("button");
      btn.className = "btn-revoke";
      btn.textContent = t("popupRevoke");
      btn.setAttribute("aria-label", t("popupRevoke") + ": " + name);
      btn.onclick = () => removeDevice(hash);
      card.appendChild(btn);

      list.appendChild(card);
      if (device && !isDisconnected && openIds.has(device.deviceId))
        openCount++;
    }
    document.getElementById("device-count").textContent = t(
      "popupDeviceCount",
      [String(openCount), String(hashes.length)],
    );
  }

  await renderDevices();

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhidDeviceEvent" && message.event) {
      const messageEvent = message.event;
      if (
        messageEvent.eventType === "connect" ||
        messageEvent.eventType === "disconnect"
      ) {
        renderDevices();
      }
    }
  });

  document.getElementById("open-settings").onclick = () => {
    browser.runtime.openOptionsPage();
  };
})();
