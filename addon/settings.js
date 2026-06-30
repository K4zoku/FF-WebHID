(async () => {
  const DEFAULTS = { perfLogging: false, fireAndForget: true };
  const current = await browser.storage.local.get(DEFAULTS);

  for (const [key, val] of Object.entries(current)) {
    document.getElementById(key).checked = val;
  }

  function showStatus(msg) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 1500);
  }

  for (const id of Object.keys(DEFAULTS)) {
    document.getElementById(id).addEventListener('change', async (e) => {
      await browser.storage.local.set({ [id]: e.target.checked });
      showStatus(`${id} = ${e.target.checked}`);
    });
  }
})();
