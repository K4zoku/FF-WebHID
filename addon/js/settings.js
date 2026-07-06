(async () => {
  const DEFAULTS = { perfLogging: false, fireAndForget: true, sabEnabled: true, sabCapacity: 8192, logLevel: 1 };
  const current = await browser.storage.local.get(DEFAULTS);

  for (const key of ['perfLogging', 'fireAndForget', 'sabEnabled']) {
    document.getElementById(key).checked = current[key];
  }
  document.getElementById('sabCapacity').value = String(current.sabCapacity);
  document.getElementById('logLevel').value = String(current.logLevel);

  function showStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 1500);
  }

  for (const key of ['perfLogging', 'fireAndForget', 'sabEnabled']) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await browser.storage.local.set({ [key]: e.target.checked });
      showStatus(`${key} = ${e.target.checked}`);
    });
  }
  document.getElementById('sabCapacity').addEventListener('change', async (e) => {
    await browser.storage.local.set({ sabCapacity: parseInt(e.target.value, 10) });
    showStatus(`sabCapacity = ${e.target.value}`);
  });
  document.getElementById('logLevel').addEventListener('change', async (e) => {
    await browser.storage.local.set({ logLevel: parseInt(e.target.value, 10) });
    showStatus(`logLevel = ${e.target.value}`);
  });
})();
