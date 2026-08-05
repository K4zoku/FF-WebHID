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

  /**
   * Maps stored settings (dataPlane + useWorker) to the Data Plane radio value.
   * @param {object} s
   * @returns {string}
   */
  function effectiveDataPlaneValue(s) {
    return s.dataPlane === 'wt' && s.useWorker === false ? 'wt-inpage' : s.dataPlane
  }

  setRadioValue('dataPlane', effectiveDataPlaneValue(current))
  setRadioValue('devicePickerMode', current.devicePickerMode || GLOBAL_DEFAULTS.devicePickerMode)
  setRadioValue('workerSpawnMode', current.workerSpawnMode || GLOBAL_DEFAULTS.workerSpawnMode)
  setRadioValue('logLevel', String(current.logLevel))

  /**
   * Shows only the options that apply to the current data plane:
   * workerSpawnMode matters only when a worker will actually spawn (WT
   * worker or WS).
   * @returns {void}
   */
  function updatePlaneVisibility() {
    const dp = currentRadioValue('dataPlane')
    document.getElementById('workerSpawnMode-setting').style.display =
      dp === 'wt' || dp === 'ws' ? '' : 'none'
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
    'allowActivationlessRequestDevice'
  ]) {
    document.getElementById(key).addEventListener('change', async (e) => {
      await saveGlobalSetting(key, e.target.checked)
      showStatus(`${key} = ${e.target.checked}`)
    })
  }

  /**
   * Saves the Data Plane radio selection. WebTransport (in-page) is stored as
   * dataPlane=wt + useWorker=false, WebTransport (worker) as dataPlane=wt +
   * useWorker=true; the backend keeps reading the useWorker flag.
   * @param {string} value
   * @returns {Promise<void>}
   */
  async function saveDataPlane(value) {
    if (value === 'wt-inpage') {
      await saveGlobalSetting('dataPlane', 'wt')
      await saveGlobalSetting('useWorker', false)
    } else if (value === 'wt') {
      await saveGlobalSetting('dataPlane', 'wt')
      await saveGlobalSetting('useWorker', true)
    } else {
      await saveGlobalSetting('dataPlane', value)
    }
  }
  document.querySelectorAll('input[name="dataPlane"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return
      await saveDataPlane(radio.value)
      updatePlaneVisibility()
      showStatus(`dataPlane = ${radio.value}`)
    })
  })

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
        showStatus(`${name} = ${radio.value}`)
      })
    })
  }
  bindRadioGroup('devicePickerMode')
  bindRadioGroup('workerSpawnMode')
  bindRadioGroup('logLevel', (v) => parseInt(v, 10))
})()
