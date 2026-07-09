(async () => {
  const DEFAULTS = { dataPlane: 'ws', sabEnabled: true, sabCapacity: 8192, fireAndForget: true };

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

  const dataPlaneSelect = document.getElementById('dataPlane');
  dataPlaneSelect.value = settings.dataPlane;

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
    sabInput.style.setProperty('--fill', ((val - 2048) / (32768 - 2048)) * 100 + '%');
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

  function guessDeviceType(name, usagePage, usage) {
    if (usagePage === 0x01) {
      if (usage === 0x01 || usage === 0x02) return 'mouse';
      if (usage === 0x06 || usage === 0x07) return 'keyboard';
      if (usage === 0x04 || usage === 0x08) return 'joystick';
      if (usage === 0x05) return 'controller';
    }
    const n = (name || '').toLowerCase();
    if (/mouse|trackball|trackpad|touchpad/i.test(n)) return 'mouse';
    if (/keyboard|kbd/i.test(n)) return 'keyboard';
    if (/joystick|flight.?stick|yoke|rudder|throttle/i.test(n)) return 'joystick';
    if (/gamepad|controller|xbox|playstation|dualshock|dualsense|joycon|joy.con/i.test(n)) return 'controller';
    if (/headset|headphone|earphone|\bmic(rophone)?\b|earbuds?/i.test(n)) return 'headset';
    if (/speaker|soundbar|audio|\bdac\b|amplifier/i.test(n)) return 'speaker';
    if (/webcam|camera|\bcam\b/i.test(n)) return 'camera';
    return 'unknown';
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

      const name = dev ? (dev.product_name || dev.productName || 'Unknown') : 'Saved device';
      const type = guessDeviceType(name, dev?.usage_page, dev?.usage);
      const vid = dev ? (dev.vendor_id || d.vendorId || 0) : 0;
      const pid = dev ? (dev.product_id || d.productId || 0) : 0;
      const manufacturer = dev ? (dev.manufacturer || d.manufacturerName || '') : '';

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
