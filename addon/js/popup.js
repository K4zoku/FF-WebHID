(async () => {
  const DEFAULTS = { fireAndForget: true, sabEnabled: true, sabCapacity: 8192 };

  // Get current tab URL
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let origin = '';
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        origin = url.origin;
      }
    } catch {}
  }

  const siteLabel = document.getElementById('site-name');
  siteLabel.textContent = origin || '(no site)';

  // Storage keys
  const siteKey = origin ? `site:${origin}` : null;
  const siteDevicesKey = origin ? encodeURIComponent(origin) : null;

  // Load settings: site-specific overrides global defaults
  async function loadSettings() {
    const global = await browser.storage.local.get(DEFAULTS);
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
  document.getElementById('fireAndForget').checked = settings.fireAndForget;
  document.getElementById('sabEnabled').checked = settings.sabEnabled;
  document.getElementById('sabCapacity').value = String(settings.sabCapacity);

  const sabCapacityRow = document.getElementById('sab-capacity-row');
  sabCapacityRow.style.display = settings.sabEnabled ? 'flex' : 'none';

  document.getElementById('fireAndForget').addEventListener('change', (e) => {
    saveSetting('fireAndForget', e.target.checked);
  });
  document.getElementById('sabEnabled').addEventListener('change', (e) => {
    saveSetting('sabEnabled', e.target.checked);
    sabCapacityRow.style.display = e.target.checked ? 'flex' : 'none';
  });
  document.getElementById('sabCapacity').addEventListener('change', (e) => {
    saveSetting('sabCapacity', parseInt(e.target.value, 10));
  });

  // Load saved devices for this site
  async function loadDevices() {
    if (!siteDevicesKey) return [];
    const result = await browser.storage.local.get(siteDevicesKey);
    return result[siteDevicesKey] || [];
  }

  async function removeDevice(hash) {
    if (!siteDevicesKey) return;
    const result = await browser.storage.local.get(siteDevicesKey);
    let hashes = result[siteDevicesKey] || [];
    hashes = hashes.filter(h => h !== hash);
    await browser.storage.local.set({ [siteDevicesKey]: hashes });
    renderDevices();
  }

  async function renderDevices() {
    const list = document.getElementById('device-list');
    const noDevices = document.getElementById('no-devices');
    const hashes = await loadDevices();

    list.innerHTML = '';
    if (hashes.length === 0) {
      noDevices.style.display = 'block';
      return;
    }
    noDevices.style.display = 'none';

    // Get device cache from background
    const response = await browser.runtime.sendMessage({ action: 'getDeviceCache' });
    const cache = (response && response.devices) || [];

    for (const hash of hashes) {
      const dev = cache.find(d => {
        const vid = String(d.vendor_id || d.vendorId || 0);
        const pid = String(d.product_id || d.productId || 0);
        const serial = String(d.serial_number || d.serialNumber || '');
        const id = String(d.device_id || d.path || '');
        const ident = vid + ':' + pid + ':' + serial + ':' + id;
        let h = 5381;
        for (let i = 0; i < ident.length; i++) {
          h = ((h << 5) + h) + ident.charCodeAt(i);
          h = h & 0xFFFFFFFF;
        }
        return Math.abs(h).toString(16) === hash;
      });

      const card = document.createElement('div');
      card.className = 'device-card';
      const name = dev ? (dev.product_name || dev.productName || 'Unknown') : 'Saved device';
      const vid = dev ? (dev.vendor_id || dev.vendorId || 0) : 0;
      const pid = dev ? (dev.product_id || dev.productId || 0) : 0;
      const info = document.createElement('div');
      info.className = 'device-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'device-name';
      nameEl.textContent = name;
      const vidEl = document.createElement('div');
      vidEl.className = 'device-vid';
      vidEl.textContent = `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;
      info.appendChild(nameEl);
      info.appendChild(vidEl);
      card.appendChild(info);
      const btn = document.createElement('button');
      btn.className = 'btn-revoke';
      btn.textContent = 'Revoke';
      btn.onclick = () => removeDevice(hash);
      card.appendChild(btn);
      list.appendChild(card);
    }
  }

  await renderDevices();

  document.getElementById('open-settings').onclick = () => {
    browser.runtime.openOptionsPage();
  };
})();
