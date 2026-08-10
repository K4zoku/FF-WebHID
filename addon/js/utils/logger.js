;(function () {
  const webhid = globalThis.webhid
  const LEVEL_ERROR = 0
  const LEVEL_WARN = 1
  const LEVEL_INFO = 2
  const LEVEL_DEBUG = 3

  /** @type {() => void} */
  const nop = () => {}
  /** @type {string} */
  let mod = ''

  /**
   * @param {string} m
   * @returns {void}
   */
  function initLogger(m) {
    mod = m || ''
  }

  /**
   * @param {string} levelName
   * @returns {string}
   */
  function prefix(levelName) {
    const t = new Date()
    const time =
      String(t.getHours()).padStart(2, '0') +
      ':' +
      String(t.getMinutes()).padStart(2, '0') +
      ':' +
      String(t.getSeconds()).padStart(2, '0') +
      '.' +
      String(t.getMilliseconds()).padStart(3, '0')
    return '[' + time + ' webhid' + (mod ? '::' + mod : '') + ' ' + levelName + ']'
  }

  /** @type {import("../types.js").Logger} */
  const logger = {
    error: nop,
    warn: nop,
    info: nop,
    debug: nop,
    level: LEVEL_WARN,
    applyLevel: applyLevel,
    initLogger: initLogger,
    bindSettings: bindSettings
  }

  /**
   * @param {number} level
   * @returns {void}
   */
  function applyLevel(level) {
    logger.level = level
    logger.error = level >= LEVEL_ERROR ? (...args) => console.error(prefix('ERROR'), ...args) : nop
    logger.warn = level >= LEVEL_WARN ? (...args) => console.warn(prefix('WARN'), ...args) : nop
    logger.info = level >= LEVEL_INFO ? (...args) => console.info(prefix('INFO'), ...args) : nop
    logger.debug = level >= LEVEL_DEBUG ? (...args) => console.debug(prefix('DEBUG'), ...args) : nop
  }

  /**
   * @param {number|string} v
   * @returns {number}
   */
  function parseLevel(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      const n = parseInt(v, 10)
      if (!isNaN(n)) return n
      const map = { error: 0, warn: 1, warning: 1, info: 2, debug: 3 }
      return map[v.toLowerCase()] != null ? map[v.toLowerCase()] : LEVEL_WARN
    }
    return LEVEL_WARN
  }

  /** @type {Function|null} */
  let unsubLogLevel = null

  /**
   * Re-points live logLevel updates at the given settings store.
   * Used in environments without the WebExtension `browser` API (page main
   * world, plain workers), where settings changes arrive over postMessage
   * instead of `browser.storage.onChanged`.
   * @param {object|null} store
   * @returns {void}
   */
  function bindSettings(store) {
    if (unsubLogLevel) {
      unsubLogLevel()
      unsubLogLevel = null
    }
    if (store && typeof store.on === 'function') {
      applyLevel(parseLevel(store.logLevel))
      unsubLogLevel = store.on('logLevel', (v) => applyLevel(parseLevel(v)))
    }
  }

  applyLevel(LEVEL_WARN)

  webhid.export('logger', logger)
})()
