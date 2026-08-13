;(function () {
  const webhid = globalThis.webhid
  const isChromium = webhid.import('isChromium')

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

  /**
   * Applies a settings object to the shared radio groups. `defaults` feeds
   * the fallbacks for settings that may be unset.
   * @param {object} s
   * @param {object} defaults
   * @returns {void}
   */
  function applyPlaneRadios(s, defaults) {
    setRadioValue('dataPlane', effectiveDataPlaneValue(s))
    let pickerMode = s.devicePickerMode || defaults.devicePickerMode
    if (isChromium && pickerMode === 'pageAction') pickerMode = 'modal'
    setRadioValue('devicePickerMode', pickerMode)
    setRadioValue('workerSpawnMode', s.workerSpawnMode || defaults.workerSpawnMode)
    setRadioValue('logLevel', String(s.logLevel))
  }

  /**
   * Shows only the options that apply to the current data plane:
   * workerSpawnMode matters only when a worker will actually spawn (WT
   * worker or WS).
   * @returns {void}
   */
  function updatePlaneVisibility() {
    const dp = currentRadioValue('dataPlane')
    document.getElementById('workerSpawnMode-setting').style.display =
      !isChromium && (dp === 'wt' || dp === 'ws') ? '' : 'none'
  }

  /**
   * Hides options that are unavailable on Chromium.
   * No-op on Firefox.
   * @returns {void}
   */
  function hideChromiumOptions() {
    if (!isChromium) return
    const pageAction = document.querySelector('input[name="devicePickerMode"][value="pageAction"]')
    const label = pageAction ? pageAction.closest('label') : null
    if (label) label.style.display = 'none'
    const polyfill = document.getElementById('workerPolyfillEnabled')
    const polyfillSetting = polyfill ? polyfill.closest('.setting') : null
    if (polyfillSetting) polyfillSetting.style.display = 'none'
  }

  /**
   * Binds the shared radio behavior for a settings page. `save(name, value)`
   * persists one setting; `afterSave(name, value)` runs after each save.
   * @param {(name: string, value: any) => any} save
   * @param {(name: string, value: any) => void} [afterSave]
   * @returns {{applyPlaneRadios: typeof applyPlaneRadios, updatePlaneVisibility: typeof updatePlaneVisibility, saveDataPlane: (value: string) => any, bindRadioGroup: (name: string, transform?: (value: string) => any) => void}}
   */
  function createSettingsUi(save, afterSave) {
    hideChromiumOptions()

    /**
     * Saves the Data Plane radio selection. WebTransport (in-page) is stored
     * as dataPlane=wt + useWorker=false, WebTransport (worker) as
     * dataPlane=wt + useWorker=true; the backend keeps reading the useWorker
     * flag.
     * @param {string} value
     * @returns {any}
     */
    function saveDataPlane(value) {
      if (value === 'wt-inpage') {
        save('dataPlane', 'wt')
        return save('useWorker', false)
      }
      if (value === 'wt') {
        save('dataPlane', 'wt')
        return save('useWorker', true)
      }
      return save('dataPlane', value)
    }

    /**
     * Binds change handling for one radio group, saving on selection.
     * @param {string} name
     * @param {(value: string) => any} [transform]
     * @returns {void}
     */
    function bindRadioGroup(name, transform) {
      document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
        radio.addEventListener('change', () => {
          if (!radio.checked) return
          const value = transform ? transform(radio.value) : radio.value
          save(name, value)
          if (afterSave) afterSave(name, value)
        })
      })
    }

    return {
      applyPlaneRadios,
      updatePlaneVisibility,
      saveDataPlane,
      bindRadioGroup
    }
  }

  webhid.export('settingsUi', {
    currentRadioValue,
    createSettingsUi
  })
})()
