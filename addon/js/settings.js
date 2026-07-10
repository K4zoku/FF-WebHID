(async () => {
  const current = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);

  for (const key of ['perfLogging', 'fireAndForget', 'daemonAsNmHost']) {
    document.getElementById(key).checked = current[key];
  }

  const logLevelSelect = document.getElementById('logLevel');
  const perfRow = document.getElementById('perfLogging-row');
  logLevelSelect.value = String(current.logLevel);
  updatePerfRowVisibility();

  const dataPlaneSelect = document.getElementById('dataPlane');
  dataPlaneSelect.value = current.dataPlane;
  const controlPlaneSelect = document.getElementById('controlPlane');
  controlPlaneSelect.value = current.controlPlane;

  function updatePerfRowVisibility() {
    const isDebug = parseInt(logLevelSelect.value, 10) >= 3;
    perfRow.style.display = isDebug ? '' : 'none';
    if (!isDebug) {
      const cb = document.getElementById('perfLogging');
      if (cb.checked) {
        cb.checked = false;
        browser.storage.local.set({ perfLogging: false });
      }
    }
  }

  function showStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 1500);
  }

  for (const key of ['perfLogging', 'fireAndForget', 'daemonAsNmHost']) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await browser.storage.local.set({ [key]: e.target.checked });
      showStatus(`${key} = ${e.target.checked}`);
    });
  }
  logLevelSelect.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    await browser.storage.local.set({ logLevel: val });
    updatePerfRowVisibility();
    showStatus(`logLevel = ${e.target.value}`);
  });
  dataPlaneSelect.addEventListener('change', async (e) => {
    await browser.storage.local.set({ dataPlane: e.target.value });
    showStatus(`dataPlane = ${e.target.value}`);
  });
  controlPlaneSelect.addEventListener('change', async (e) => {
    await browser.storage.local.set({ controlPlane: e.target.value });
    showStatus(`controlPlane = ${e.target.value}`);
  });
})();
