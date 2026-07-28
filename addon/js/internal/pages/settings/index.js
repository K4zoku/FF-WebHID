(async () => {
  const { logger } = webhid;
  const t = webhid.import("t");
  const localizeHTML = webhid.import("localizeHTML");
  const loadGlobalSettings = webhid.import("loadGlobalSettings");
  const saveGlobalSetting = webhid.import("saveGlobalSetting");
  const syncBrowserTheme = webhid.import("syncBrowserTheme");
  logger.initLogger("settings");

  syncBrowserTheme();
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme);

  localizeHTML(document);

  const current = await loadGlobalSettings();

  for (const key of ["daemonAsNmHost", "workerPolyfillEnabled"]) {
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

  for (const key of ["daemonAsNmHost", "workerPolyfillEnabled"]) {
    document.getElementById(key).addEventListener("change", async (e) => {
      await saveGlobalSetting(key, e.target.checked);
      showStatus(`${key} = ${e.target.checked}`);
    });
  }
  logLevelSelect.addEventListener("change", async (e) => {
    const val = parseInt(e.target.value, 10);
    await saveGlobalSetting("logLevel", val);
    showStatus(`logLevel = ${e.target.value}`);
  });
  dataPlaneSelect.addEventListener("change", async (e) => {
    await saveGlobalSetting("dataPlane", e.target.value);
    showStatus(`dataPlane = ${e.target.value}`);
  });
  devicePickerModeSelect.addEventListener("change", async (e) => {
    await saveGlobalSetting("devicePickerMode", e.target.value);
    showStatus(`devicePickerMode = ${e.target.value}`);
  });
})();
