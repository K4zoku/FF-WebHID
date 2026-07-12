(function () {
  const LEVEL_ERROR = 0;
  const LEVEL_WARN = 1;
  const LEVEL_INFO = 2;
  const LEVEL_DEBUG = 3;

  const _nop = () => {};
  let _module = "";

  function initLogger(mod) {
    _module = mod || "";
  }

  function _prefix(levelName) {
    const t = new Date();
    const time =
      String(t.getHours()).padStart(2, "0") +
      ":" +
      String(t.getMinutes()).padStart(2, "0") +
      ":" +
      String(t.getSeconds()).padStart(2, "0") +
      "." +
      String(t.getMilliseconds()).padStart(3, "0");
    return (
      "[" +
      time +
      " webhid" +
      (_module ? "::" + _module : "") +
      " " +
      levelName +
      "]"
    );
  }

  const logger = {
    error: _nop,
    warn: _nop,
    info: _nop,
    debug: _nop,
    _level: LEVEL_WARN,
    _loaded: false,
    applyLevel: _applyLevel,
    initLogger: initLogger,
  };

  function _applyLevel(level) {
    logger._level = level;
    logger.error =
      level >= LEVEL_ERROR
        ? (...args) => console.error(_prefix("ERROR"), ...args)
        : _nop;
    logger.warn =
      level >= LEVEL_WARN
        ? (...args) => console.warn(_prefix("WARN"), ...args)
        : _nop;
    logger.info =
      level >= LEVEL_INFO
        ? (...args) => console.info(_prefix("INFO"), ...args)
        : _nop;
    logger.debug =
      level >= LEVEL_DEBUG
        ? (...args) => console.debug(_prefix("DEBUG"), ...args)
        : _nop;
  }

  function _parseLevel(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (!isNaN(n)) return n;
      const map = { error: 0, warn: 1, warning: 1, info: 2, debug: 3 };
      return map[v.toLowerCase()] ?? LEVEL_WARN;
    }
    return LEVEL_WARN;
  }

  async function _load() {
    if (logger._loaded) return;
    logger._loaded = true;
    try {
      if (!browser?.storage?.local) return;
      const result = await browser.storage.local.get({ logLevel: LEVEL_WARN });
      _applyLevel(_parseLevel(result.logLevel));
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.logLevel) {
          _applyLevel(_parseLevel(changes.logLevel.newValue));
        }
      });
    } catch {}
  }

  _applyLevel(LEVEL_WARN);
  _load();

  globalThis.__webhid = globalThis.__webhid || {};
  globalThis.__webhid.logger = logger;
})();
