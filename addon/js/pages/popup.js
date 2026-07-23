(async () => {
  const logger = webhid.import("logger");
  const guessDeviceType = webhid.import("guessDeviceType");
  const GLOBAL_DEFAULTS = webhid.import("GLOBAL_DEFAULTS");
  logger.initLogger("popup");
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let origin = "";
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        origin = url.origin;
      }
    } catch {}
  }

  const siteLabel = document.getElementById("site-name");
  siteLabel.textContent = origin || "(no site)";

  const siteKey = origin ? `site:${origin}` : null;
  const siteDevicesKey = origin ? encodeURIComponent(origin) : null;

  async function loadSettings() {
    const global = await browser.storage.local.get(GLOBAL_DEFAULTS);
    if (!siteKey) return global;
    const site = await browser.storage.local.get(siteKey);
    return { ...global, ...site[siteKey] };
  }

  async function saveSetting(key, value) {
    if (!siteKey) return;
    const result = await browser.storage.local.get(siteKey);
    const siteSettings = result[siteKey] || {};
    siteSettings[key] = value;
    await browser.storage.local.set({ [siteKey]: siteSettings });
  }

  const settings = await loadSettings();

  const dataPlaneSelect = document.getElementById("dataPlane");
  dataPlaneSelect.value = settings.dataPlane;
  document.getElementById("fireAndForget").checked = settings.fireAndForget;

  const logLevelSelect = document.getElementById("logLevel");
  logLevelSelect.value = String(settings.logLevel);

  dataPlaneSelect.addEventListener("change", (e) => {
    saveSetting("dataPlane", e.target.value);
  });
  document.getElementById("fireAndForget").addEventListener("change", (e) => {
    saveSetting("fireAndForget", e.target.checked);
  });
  logLevelSelect.addEventListener("change", (e) => {
    saveSetting("logLevel", parseInt(e.target.value, 10));
  });

  async function loadDevices() {
    if (!siteDevicesKey) return [];
    const result = await browser.storage.local.get(siteDevicesKey);
    return result[siteDevicesKey] || [];
  }

  async function removeDevice(hash) {
    if (!siteDevicesKey || !origin) return;
    try {
      await browser.runtime.sendMessage({
        action: "revokeDevice",
        deviceId: hash,
        origin,
      });
    } catch {}
    renderDevices();
  }

  let renderToken = 0;
  async function renderDevices() {
    const token = ++renderToken;
    const list = document.getElementById("device-list");
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
    const cache = (response && response.devices) || [];

    let openIds = new Set();
    try {
      const r = await browser.tabs.sendMessage(tab.id, {
        action: "getOpenDeviceIds",
      });
      if (r?.ids) openIds = new Set(r.ids);
    } catch {}

    if (token !== renderToken) return;

    let openCount = 0;
    for (const hash of hashes) {
      let device = cache.find((d) => d.deviceId === hash);
      if (!device) {
        try {
          const r = await browser.runtime.sendMessage({
            action: "getDeviceInfo",
            deviceId: hash,
          });
          device = r?.device || null;
        } catch {}
      }
      if (token !== renderToken) return;

      const isDisconnected = !cache.some((d) => d.deviceId === hash);
      const name = device ? device.productName || "Unknown" : "Paired device";
      const type = guessDeviceType(device || { productName: name });
      const vid = device ? device.vendorId || 0 : 0;
      const pid = device ? device.productId || 0 : 0;
      const manufacturer = device ? device.manufacturer || "" : "";

      const card = document.createElement("div");
      card.className = "device-card";
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
      btn.textContent = "Revoke";
      btn.onclick = () => removeDevice(hash);
      card.appendChild(btn);

      list.appendChild(card);
      if (device && !isDisconnected && openIds.has(device.deviceId)) openCount++;
    }
    document.getElementById("device-count").textContent =
      `(${openCount}/${hashes.length})`;
  }

  await renderDevices();

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "webhidDeviceEvent" && message.event) {
      const messageEvent = message.event;
      if (messageEvent.eventType === "connect" || messageEvent.eventType === "disconnect") {
        renderDevices();
      }
    }
  });

  document.getElementById("open-settings").onclick = () => {
    browser.runtime.openOptionsPage();
  };
})();
