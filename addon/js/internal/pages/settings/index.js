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
    'useWorker',
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).checked = current[key]
  }

  /**
   * Checks the radio with the given name/value.
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  function setRadioValue(name, value) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`)
    if (radio) radio.checked = true
  }

  /**
   * Returns the value of the checked radio in the group.
   * @param {string} name
   * @returns {string}
   */
  function currentRadioValue(name) {
    const radio = document.querySelector(`input[name="${name}"]:checked`)
    return radio ? radio.value : ''
  }

  setRadioValue('dataPlane', current.dataPlane)
  setRadioValue('devicePickerMode', current.devicePickerMode || GLOBAL_DEFAULTS.devicePickerMode)
  setRadioValue('workerSpawnMode', current.workerSpawnMode || GLOBAL_DEFAULTS.workerSpawnMode)
  setRadioValue('logLevel', String(current.logLevel))
  const useWorkerCheckbox = document.getElementById('useWorker')
  useWorkerCheckbox.checked = current.useWorker !== false

  /**
   * Shows only the options that apply to the current data plane:
   * useWorker only matters for WT (WS always needs the worker, NM needs
   * neither); workerSpawnMode matters only when a worker will actually spawn.
   * @returns {void}
   */
  function updatePlaneVisibility() {
    const dp = currentRadioValue('dataPlane')
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

  /**
   * @param {string} name
   * @param {(value: string) => any} [transform]
   * @returns {void}
   */
  function bindRadioGroup(name, transform) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return
        await saveGlobalSetting(name, transform ? transform(radio.value) : radio.value)
        if (name === 'dataPlane') updatePlaneVisibility()
        showStatus(`${name} = ${radio.value}`)
      })
    })
  }
  bindRadioGroup('dataPlane')
  bindRadioGroup('devicePickerMode')
  bindRadioGroup('workerSpawnMode')
  bindRadioGroup('logLevel', (v) => parseInt(v, 10))
})()
