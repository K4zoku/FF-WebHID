(async () => {
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

  const siteKey = origin ? `site:${origin}` : null;
  const siteDevicesKey = origin ? encodeURIComponent(origin) : null;

  async function loadSettings() {
    const global = await browser.storage.local.get(__webhid.GLOBAL_DEFAULTS);
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

  const dataPlaneSelect = document.getElementById('dataPlane');
  dataPlaneSelect.value = settings.dataPlane;
  const controlPlaneSelect = document.getElementById('controlPlane');
  controlPlaneSelect.value = settings.controlPlane;

  document.getElementById('fireAndForget').checked = settings.fireAndForget;
  document.getElementById('sabEnabled').checked = settings.sabEnabled;
  const sabInput = document.getElementById('sabCapacity');
  const sabOutput = document.getElementById('sabCapacityOutput');
  sabInput.value = String(settings.sabCapacity);
  sabOutput.textContent = String(settings.sabCapacity);
  updateSabFill();

  function updateSabOutput() {
    sabOutput.textContent = sabInput.value;
  }

  function updateSabFill() {
    const val = parseInt(sabInput.value, 10);
    sabInput.style.setProperty('--fill', ((val - 64) / (4096 - 64)) * 100 + '%');
  }

  function updateCascadingVisibility() {
    const isWs = dataPlaneSelect.value === 'ws';
    const sabOn = document.getElementById('sabEnabled').checked;
    document.getElementById('sabEnabled-row').style.display = isWs ? '' : 'none';
    document.getElementById('sab-capacity-row').style.display = (isWs && sabOn) ? '' : 'none';
  }

  updateCascadingVisibility();

  dataPlaneSelect.addEventListener('change', (e) => {
    saveSetting('dataPlane', e.target.value);
    updateCascadingVisibility();
  });
  controlPlaneSelect.addEventListener('change', (e) => {
    saveSetting('controlPlane', e.target.value);
  });
  document.getElementById('fireAndForget').addEventListener('change', (e) => {
    saveSetting('fireAndForget', e.target.checked);
  });
  document.getElementById('sabEnabled').addEventListener('change', (e) => {
    saveSetting('sabEnabled', e.target.checked);
    updateCascadingVisibility();
  });
  sabInput.addEventListener('input', () => { updateSabOutput(); updateSabFill(); });
  sabInput.addEventListener('change', (e) => {
    saveSetting('sabCapacity', parseInt(e.target.value, 10));
  });

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

    const response = await browser.runtime.sendMessage({ action: 'getDeviceCache' });
    const cache = (response && response.devices) || [];

    let openIds = new Set();
    try {
      const r = await browser.tabs.sendMessage(tab.id, { action: 'getOpenDeviceIds' });
      if (r?.ids) openIds = new Set(r.ids);
    } catch {}

    let openCount = 0;
    for (const hash of hashes) {
      const dev = cache.find(d => __webhid.createDeviceHash(d) === hash);

      const name = dev ? (dev.product_name || dev.productName || 'Unknown') : 'Saved device';
      const type = __webhid.guessDeviceType(dev || { product_name: name });
      const vid = dev ? (dev.vendor_id || dev.vendorId || 0) : 0;
      const pid = dev ? (dev.product_id || dev.productId || 0) : 0;
      const manufacturer = dev ? (dev.manufacturer || dev.manufacturerName || '') : '';

      const card = document.createElement('div');
      card.className = 'device-card';
      if (dev && openIds.has(dev.device_id)) card.classList.add('open');

      const icon = document.createElement('img');
      icon.className = 'device-icon';
      icon.src = browser.runtime.getURL(`res/${type}.svg`);
      icon.alt = type;
      card.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'device-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'device-name';
      nameEl.textContent = name;
      info.appendChild(nameEl);

      if (manufacturer) {
        const vendorEl = document.createElement('div');
        vendorEl.className = 'device-vendor';
        vendorEl.textContent = manufacturer;
        info.appendChild(vendorEl);
      }

      const vidEl = document.createElement('div');
      vidEl.className = 'device-vid';
      vidEl.textContent = `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;
      info.appendChild(vidEl);

      card.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'btn-revoke';
      btn.textContent = 'Revoke';
      btn.onclick = () => removeDevice(hash);
      card.appendChild(btn);

      list.appendChild(card);
      if (dev && openIds.has(dev.device_id)) openCount++;
    }
    document.getElementById('device-count').textContent = `(${openCount}/${hashes.length})`;
  }

  await renderDevices();

  document.getElementById('open-settings').onclick = () => {
    browser.runtime.openOptionsPage();
  };
})();
