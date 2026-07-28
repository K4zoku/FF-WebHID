(async () => {
  /** @type {import("../types.js").Logger} */
  const { logger } = webhid;
  const GLOBAL_DEFAULTS = webhid.GLOBAL_DEFAULTS;
  const t = webhid.import("t");
  const localizeHTML = webhid.import("localizeHTML");
  logger.initLogger("settings");

  localizeHTML(document);

  const current = await browser.storage.local.get(GLOBAL_DEFAULTS);

  for (const key of ["daemonAsNmHost", "workerPolyfillEnabled"]) {
    /** @type {HTMLInputElement} */
    document.getElementById(key).checked = current[key];
  }

  /** @type {HTMLSelectElement} */
  const logLevelSelect = document.getElementById("logLevel");
  logLevelSelect.value = String(current.logLevel);

  /** @type {HTMLSelectElement} */
  const dataPlaneSelect = document.getElementById("dataPlane");
  dataPlaneSelect.value = current.dataPlane;
  /** @type {HTMLSelectElement} */
  const devicePickerModeSelect = document.getElementById("devicePickerMode");
  devicePickerModeSelect.value = current.devicePickerMode || "modal";

  /** @param {string} msg @returns {void} */
  function showStatus(msg) {
    /** @type {HTMLElement} */
    const el = document.getElementById("status");
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(() => {
      el.style.display = "none";
    }, 1500);
  }

  for (const key of ["daemonAsNmHost", "workerPolyfillEnabled"]) {
    document.getElementById(key).addEventListener("change", async (e) => {
      await browser.storage.local.set({ [key]: e.target.checked });
      showStatus(`${key} = ${e.target.checked}`);
    });
  }
  logLevelSelect.addEventListener("change", async (e) => {
    const val = parseInt(e.target.value, 10);
    await browser.storage.local.set({ logLevel: val });
    showStatus(`logLevel = ${e.target.value}`);
  });
  dataPlaneSelect.addEventListener("change", async (e) => {
    await browser.storage.local.set({ dataPlane: e.target.value });
    showStatus(`dataPlane = ${e.target.value}`);
  });
  devicePickerModeSelect.addEventListener("change", async (e) => {
    await browser.storage.local.set({ devicePickerMode: e.target.value });
    showStatus(`devicePickerMode = ${e.target.value}`);
  });
})();
