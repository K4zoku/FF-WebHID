(async () => {
  const { logger } = webhid
  const localizeHTML = webhid.import('localizeHTML')
  const loadGlobalSettings = webhid.import('loadGlobalSettings')
  const saveGlobalSetting = webhid.import('saveGlobalSetting')
  const GLOBAL_DEFAULTS = webhid.import('GLOBAL_DEFAULTS')
  const syncBrowserTheme = webhid.import('syncBrowserTheme')
  logger.initLogger('settings')

  syncBrowserTheme()
  if (browser.theme) browser.theme.onUpdated.addListener(syncBrowserTheme)

  localizeHTML(document)

  const current = await loadGlobalSettings()

  for (const key of [
    'daemonAsNmHost',
    'workerPolyfillEnabled',
    'useWorker',
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).checked = current[key]
  }

  const logLevelSelect = document.getElementById('logLevel')
  logLevelSelect.value = String(current.logLevel)

  const dataPlaneSelect = document.getElementById('dataPlane')
  dataPlaneSelect.value = current.dataPlane
  const devicePickerModeSelect = document.getElementById('devicePickerMode')
  devicePickerModeSelect.value = current.devicePickerMode || GLOBAL_DEFAULTS.devicePickerMode
  const workerSpawnModeSelect = document.getElementById('workerSpawnMode')
  workerSpawnModeSelect.value = current.workerSpawnMode || GLOBAL_DEFAULTS.workerSpawnMode
  const useWorkerCheckbox = document.getElementById('useWorker')
  useWorkerCheckbox.checked = current.useWorker !== false

  /**
   * Shows only the options that apply to the current data plane:
   * useWorker only matters for WT (WS always needs the worker, NM needs
   * neither); workerSpawnMode matters only when a worker will actually spawn.
   * @returns {void}
   */
  function updatePlaneVisibility() {
    const dp = dataPlaneSelect.value
    const useWorker = useWorkerCheckbox.checked
    document.getElementById('useWorker-setting').style.display = dp === 'wt' ? '' : 'none'
    document.getElementById('workerSpawnMode-setting').style.display =
      dp !== 'nm' && useWorker ? '' : 'none'
  }
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
    'useWorker',
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await saveGlobalSetting(key, e.target.checked)
      if (key === 'useWorker') updatePlaneVisibility()
      showStatus(`${key} = ${e.target.checked}`)
    })
  }
  logLevelSelect.addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10)
    await saveGlobalSetting('logLevel', val)
    showStatus(`logLevel = ${e.target.value}`)
  })
  dataPlaneSelect.addEventListener('change', async (e) => {
    await saveGlobalSetting('dataPlane', e.target.value)
    updatePlaneVisibility()
    showStatus(`dataPlane = ${e.target.value}`)
  })
  devicePickerModeSelect.addEventListener('change', async (e) => {
    await saveGlobalSetting('devicePickerMode', e.target.value)
    showStatus(`devicePickerMode = ${e.target.value}`)
  })
  workerSpawnModeSelect.addEventListener('change', async (e) => {
    await saveGlobalSetting('workerSpawnMode', e.target.value)
    showStatus(`workerSpawnMode = ${e.target.value}`)
  })
})()
