;(function () {
  'use strict'

  /** @type {import("../types.js").Logger} */
  const logger = globalThis.webhid.import('logger')
  const fetchResource = globalThis.webhid.import('fetchResource')
  const http = globalThis.webhid.import('http')
  const t = globalThis.webhid.import('t')
  const localizeHTML = globalThis.webhid.import('localizeHTML')
  const guessDeviceType = globalThis.webhid.import('guessDeviceType')
  const groupDevices = globalThis.webhid.import('groupDevices')
  const groupIdFor = globalThis.webhid.import('groupIdFor')
  const applyDeviceIcon = globalThis.webhid.import('applyDeviceIcon')
  const syncBrowserTheme = globalThis.webhid.import('syncBrowserTheme')
  logger.initLogger('picker')

  /** @typedef {import("../main/types.js").HIDDeviceInfo} HIDDeviceInfo */

  /**
   *
   */
  class WebHidDevicePicker {
    /** @type {ShadowRoot|null} */
    shadow = null
    /** @type {HTMLElement|null} */
    host = null
    /** @type {HTMLDialogElement|null} */
    dialog = null
    /** @type {HIDDeviceInfo[]} */
    devices = []
    /** @type {object[]} */
    filters = []
    /** @type {object[]} */
    exclusionFilters = []
    /** @type {{[key: string]: HIDDeviceInfo[]}} */
    deviceGroups = {}
    /** @type {string[]|null} */
    pairedDevices = null
    /** @type {Promise<void>|null} */
    fragmentReady = null
    /** @type {Function|null} */
    resolveShow = null
    /** @type {boolean} */
    filterApplied = false
    /** @type {boolean} */
    enumerateError = false

    /** @constructor */
    constructor() {
      this.host = document.createElement('div')
      this.host.id = 'webhid-shadow-host'
      this.shadow = this.host.attachShadow({ mode: 'closed' })
      this.fragmentReady = this.loadFragment()
    }

    /** @returns {Promise<void>} */
    async loadFragment() {
      const html = await fetchResource('js/content/isolated/picker/fragment.html')
      const templateDoc = new DOMParser().parseFromString(html, 'text/html')
      const template = templateDoc.querySelector('#webhid-picker-template')
      this.shadow.appendChild(template.content.cloneNode(true))
      localizeHTML(this.shadow)

      syncBrowserTheme(this.host)
      if (browser.theme) browser.theme.onUpdated.addListener(() => syncBrowserTheme(this.host))

      this.dialog = this.shadow.querySelector('.webhid-modal')

      this.dialog.addEventListener('close', () => {
        const returnValue = this.dialog.returnValue
        const checked = this.dialog.querySelector('.webhid-device-radio:checked')
        const deviceId = checked != null ? checked.value : undefined
        if (returnValue === 'selected' && deviceId) {
          this.onDeviceSelected(this.deviceGroups[deviceId] || [])
        } else {
          this.onDeviceCancelled()
        }

        const hide = () => {
          this.dialog.style.display = 'none'
        }
        this.dialog.addEventListener('transitionend', hide, { once: true })
        setTimeout(hide, 300)
      })

      this.dialog.addEventListener('change', (e) => {
        if (!e.target.matches('.webhid-device-radio')) return
        this.dialog
          .querySelectorAll('.webhid-device-item')
          .forEach((el) => el.classList.remove('selected'))
        e.target.closest('.webhid-device-item').classList.add('selected')
        this.dialog.querySelector('#webhidConnectBtn').disabled = false
      })

      this.dialog.addEventListener('click', (e) => {
        if (e.target === this.dialog) this.dialog.close()
      })

      this.dialog.addEventListener('keydown', (e) => {
        if (e.target.matches('.webhid-device-item') && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          const radio = e.target.querySelector('.webhid-device-radio')
          if (radio && !radio.disabled) {
            radio.checked = true
            radio.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      })
    }

    /**
     * @param {object[]} [filters]
     * @param {object[]} [exclusionFilters]
     * @returns {Promise<{devices: HIDDeviceInfo[]}>}
     */
    async show(filters = [], exclusionFilters = []) {
      await this.fragmentReady
      this.filters = filters
      this.exclusionFilters = exclusionFilters

      if (typeof this.dialog.showModal === 'function') {
        if (this.dialog.open) this.dialog.close()
        this.dialog.style.display = ''
        await new Promise((r) => requestAnimationFrame(r))
        this.dialog.showModal()
      } else {
        this.dialog.setAttribute('open', '')
      }

      this.loadDevices()

      return new Promise((resolve) => {
        this.resolveShow = resolve
      })
    }

    /** @returns {Promise<void>} */
    async refreshDevices() {
      if (!this.dialog || !this.dialog.open) return
      this.pairedDevices = null
      await this.loadDevices()
    }

    /** @returns {boolean} */
    get isOpen() {
      return this.dialog == null ? void 0 : this.dialog.open != null ? this.dialog.open : false
    }

    /** @returns {Promise<void>} */
    async loadDevices() {
      try {
        const response = await browser.runtime.sendMessage({
          action: 'enumerate',
          filters: this.filters,
          exclusionFilters: this.exclusionFilters
        })
        if (response && http.isOk(response.s)) {
          this.devices = response.D || []
          this.filterApplied = response.filtered === true
          this.enumerateError = false
        } else {
          this.devices = []
          this.filterApplied = false
          this.enumerateError = true
          let code = response != null ? response.s : undefined
          code = code != null ? code : 0
          if (code === 500) {
            logger.warn('enumerate returned 500, treating as empty list')
          } else {
            logger.warn('enumerate returned status', code)
          }
        }
        this.renderDevices()
      } catch (error) {
        this.devices = []
        this.filterApplied = false
        this.enumerateError = true
        logger.warn(
          'enumerate exception:',
          error != null ? (error.message != null ? error.message : error) : error
        )
        this.renderDevices()
      }
    }

    /**
     * @returns {Promise<string[]>}
     */
    async getPairedDevices() {
      if (this.pairedDevices !== null) return this.pairedDevices
      try {
        const result = await browser.runtime.sendMessage({
          action: 'getPairedDevices',
          origin: window.location.origin
        })
        this.pairedDevices = result.hashes || []
        return this.pairedDevices
      } catch {
        return []
      }
    }

    /**
     * @param {HIDDeviceInfo} device
     * @returns {Promise<boolean>}
     */
    async deviceMatchesSaved(device) {
      const pairedIds = await this.getPairedDevices()
      return pairedIds.includes(device.deviceId)
    }

    /** @returns {Promise<void>} */
    async renderDevices() {
      if (!this.dialog) return
      const deviceList = this.dialog.querySelector('#webhidDeviceList')
      if (!deviceList) return
      deviceList.innerHTML = ''

      if (this.devices.length === 0) {
        const msg = document.createElement('div')
        msg.className = this.enumerateError ? 'webhid-error' : 'webhid-no-devices'
        msg.setAttribute('role', 'status')
        msg.textContent = this.enumerateError
          ? t('pickerNoDaemon')
          : this.filterApplied
            ? t('pickerNoMatch')
            : t('pickerNoDevices')
        deviceList.replaceChildren(msg)
        return
      }

      logger.debug('picker: ' + this.devices.length + ' device(s) matched filters')

      const groups = groupDevices(this.devices)

      const pairedStatuses = await Promise.all(
        this.devices.map((device) => this.deviceMatchesSaved(device))
      )

      this.deviceGroups = {}

      const template = this.shadow.getElementById('webhid-device-template')

      for (const [name, devices] of groups.entries()) {
        let isPaired = false
        const deviceIds = []
        for (const device of devices) {
          const index = this.devices.indexOf(device)
          if (index >= 0 && pairedStatuses[index]) isPaired = true
          deviceIds.push(device.deviceId)
        }

        const groupId = groupIdFor(devices)
        this.deviceGroups[groupId] = devices.slice()

        const device = devices[0]
        const type = guessDeviceType(device)

        const clone = template.content.cloneNode(true)
        const item = clone.querySelector('.webhid-device-item')
        const radio = clone.querySelector('.webhid-device-radio')

        radio.value = groupId
        item.classList.toggle('webhid-device-paired', isPaired)
        item.dataset.deviceId = groupId

        applyDeviceIcon(clone.querySelector('.webhid-device-icon'), type)

        clone.querySelector('.webhid-device-name').textContent = name

        const vendor = clone.querySelector('.webhid-device-vendor')
        device.manufacturer ? (vendor.textContent = device.manufacturer) : vendor.remove()

        const iface = clone.querySelector('.webhid-device-iface')
        devices.length > 1
          ? (iface.textContent = t('pickerInterfaces', [String(devices.length)]))
          : iface.remove()

        const parseHint = clone.querySelector('.webhid-device-parse-failed')
        device.descriptorParseFailed
          ? (parseHint.textContent = t('pickerParseFailed'))
          : parseHint.remove()

        deviceList.appendChild(clone)
      }
    }

    /**
     * @param {HIDDeviceInfo|HIDDeviceInfo[]} devices
     * @returns {void}
     */
    onDeviceSelected(devices) {
      const devicesArr = Array.isArray(devices) ? devices : [devices]
      ;(async () => {
        try {
          const paired = await this.getPairedDevices()
          for (const d of devicesArr) {
            if (!paired.includes(d.deviceId)) paired.push(d.deviceId)
          }
          this.pairedDevices = paired
        } catch (e) {
          logger.debug('getPairedDevices failed', e)
        }
      })()
      this.resolveShow?.({ devices: devicesArr })
      this.resolveShow = null
    }

    /** @returns {void} */
    onDeviceCancelled() {
      this.resolveShow?.({ devices: [] })
      this.resolveShow = null
    }
  }

  webhid.export('WebHidDevicePicker', WebHidDevicePicker)
})()
