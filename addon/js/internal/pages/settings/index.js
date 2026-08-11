;(async () => {
  const { logger } = webhid
  const localizeHTML = webhid.import('localizeHTML')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const saveGlobalSetting = webhid.import('saveGlobalSetting')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  const initInfoPopovers = webhid.import('initInfoPopovers')
  logger.initLogger('settings')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)
  initInfoPopovers(document)

  const current = await loadGlobalSettings()

  for (const key of [
    'daemonAsNmHost',
    'workerPolyfillEnabled',
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).checked = current[key]
  }

  const { applyPlaneRadios, updatePlaneVisibility, saveDataPlane, bindRadioGroup } =
    webhid.import('settingsUi').createSettingsUi(saveGlobalSetting, (name, value) => {
      showStatus(`${name} = ${value}`)
    })

  applyPlaneRadios(current, GLOBAL_DEFAULTS)
  updatePlaneVisibility()

  /**
   * Displays a temporary status message in the settings page.
   * @param {string} msg
   * @returns {void}
   */
  function showStatus(msg) {
    const el = document.getElementById('status')
    el.textContent = msg
    el.style.display = 'block'
    setTimeout(() => {
      el.style.display = 'none'
    }, 1500)
  }

  for (const key of [
    'daemonAsNmHost',
    'workerPolyfillEnabled',
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await saveGlobalSetting(key, e.target.checked)
      showStatus(`${key} = ${e.target.checked}`)
    })
  }

  document.querySelectorAll('input[name="dataPlane"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return
      await saveDataPlane(radio.value)
      updatePlaneVisibility()
      showStatus(`dataPlane = ${radio.value}`)
    })
  })

  bindRadioGroup('devicePickerMode')
  bindRadioGroup('workerSpawnMode')
  bindRadioGroup('logLevel', (v) => parseInt(v, 10))
})()
