(async () => {
  const { logger, GLOBAL_DEFAULTS } = webhid;
  logger.initLogger("settings");
  const current = await browser.storage.local.get(GLOBAL_DEFAULTS);

  for (const key of ["fireAndForget", "daemonAsNmHost"]) {
    document.getElementById(key).checked = current[key];
  }

  const logLevelSelect = document.getElementById("logLevel");
  logLevelSelect.value = String(current.logLevel);

  const dataPlaneSelect = document.getElementById("dataPlane");
  dataPlaneSelect.value = current.dataPlane;
  const devicePickerModeSelect = document.getElementById("devicePickerMode");
  devicePickerModeSelect.value = current.devicePickerMode || "modal";

  function showStatus(msg) {
    const el = document.getElementById("status");
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(() => {
      el.style.display = "none";
    }, 1500);
  }

  for (const key of ["fireAndForget", "daemonAsNmHost"]) {
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
