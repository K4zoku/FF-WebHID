(async () => {
  const DEFAULTS = {
    perfLogging: false,
    fireAndForget: true,
    dataPlane: 'ws',
    controlPlane: 'nm',
    sabEnabled: true,
    sabCapacity: 8192,
    dispatchDataView: false,
    logLevel: 1,
    daemonAsNmHost: false,
  };
  const current = await browser.storage.local.get(DEFAULTS);

  for (const key of ['perfLogging', 'fireAndForget', 'sabEnabled', 'dispatchDataView', 'daemonAsNmHost']) {
    document.getElementById(key).checked = current[key];
  }
  const sabInput = document.getElementById('sabCapacity');
  const sabOutput = document.getElementById('sabCapacityOutput');
  sabInput.value = String(current.sabCapacity);
  sabOutput.textContent = String(current.sabCapacity);
  updateSabFill();

  const logLevelSelect = document.getElementById('logLevel');
  const perfRow = document.getElementById('perfLogging-row');
  logLevelSelect.value = String(current.logLevel);
  updatePerfRowVisibility();

  const dataPlaneSelect = document.getElementById('dataPlane');
  dataPlaneSelect.value = current.dataPlane;
  const controlPlaneSelect = document.getElementById('controlPlane');
  controlPlaneSelect.value = current.controlPlane;
  updateCascadingVisibility();

  function updateSabOutput() {
    sabOutput.textContent = sabInput.value;
  }

  function updateSabFill() {
    const val = parseInt(sabInput.value, 10);
    sabInput.style.setProperty('--fill', ((val - 2048) / (32768 - 2048)) * 100 + '%');
  }

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

  function updateCascadingVisibility() {
    const plane = dataPlaneSelect.value;
    const sabOn = document.getElementById('sabEnabled').checked;
    const isWs = plane === 'ws';
    document.getElementById('sabEnabled-row').style.display = isWs ? '' : 'none';
    document.getElementById('sabCapacity-row').style.display = (isWs && sabOn) ? '' : 'none';
    document.getElementById('dispatchDataView-row').style.display = (isWs && sabOn) ? '' : 'none';
    if (isWs && sabOn) {
      const sabCapacityRow = document.getElementById('sabCapacity-row');
      if (sabCapacityRow.classList.contains('sab-setting')) {
        sabCapacityRow.style.display = '';
      }
    } else {
      document.getElementById('sabCapacity-row').style.display = 'none';
    }
  }

  function showStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 1500);
  }

  for (const key of ['perfLogging', 'fireAndForget', 'sabEnabled', 'dispatchDataView', 'daemonAsNmHost']) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await browser.storage.local.set({ [key]: e.target.checked });
      showStatus(`${key} = ${e.target.checked}`);
      updateCascadingVisibility();
    });
  }
  sabInput.addEventListener('input', () => { updateSabOutput(); updateSabFill(); });
  sabInput.addEventListener('change', async (e) => {
    await browser.storage.local.set({ sabCapacity: parseInt(e.target.value, 10) });
    showStatus(`sabCapacity = ${e.target.value}`);
  });
  logLevelSelect.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10);
    await browser.storage.local.set({ logLevel: val });
    updatePerfRowVisibility();
    showStatus(`logLevel = ${e.target.value}`);
  });
  dataPlaneSelect.addEventListener('change', async (e) => {
    await browser.storage.local.set({ dataPlane: e.target.value });
    updateCascadingVisibility();
    showStatus(`dataPlane = ${e.target.value}`);
  });
  controlPlaneSelect.addEventListener('change', async (e) => {
    await browser.storage.local.set({ controlPlane: e.target.value });
    showStatus(`controlPlane = ${e.target.value}`);
  });
})();
