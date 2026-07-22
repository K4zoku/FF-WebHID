(function () {
  const webhid = globalThis.webhid;
  const LEVEL_ERROR = 0;
  const LEVEL_WARN = 1;
  const LEVEL_INFO = 2;
  const LEVEL_DEBUG = 3;

  const nop = () => {};
  let mod = "";

  function initLogger(m) {
    mod = m || "";
  }

  function prefix(levelName) {
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
      (mod ? "::" + mod : "") +
      " " +
      levelName +
      "]"
    );
  }

  const logger = {
    error: nop,
    warn: nop,
    info: nop,
    debug: nop,
    level: LEVEL_WARN,
    loaded: false,
    applyLevel: applyLevel,
    initLogger: initLogger,
  };

  function applyLevel(level) {
    logger.level = level;
    logger.error =
      level >= LEVEL_ERROR
        ? (...args) => console.error(prefix("ERROR"), ...args)
        : nop;
    logger.warn =
      level >= LEVEL_WARN
        ? (...args) => console.warn(prefix("WARN"), ...args)
        : nop;
    logger.info =
      level >= LEVEL_INFO
        ? (...args) => console.info(prefix("INFO"), ...args)
        : nop;
    logger.debug =
      level >= LEVEL_DEBUG
        ? (...args) => console.debug(prefix("DEBUG"), ...args)
        : nop;
  }

  function parseLevel(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (!isNaN(n)) return n;
      const map = { error: 0, warn: 1, warning: 1, info: 2, debug: 3 };
      return map[v.toLowerCase()] ?? LEVEL_WARN;
    }
    return LEVEL_WARN;
  }

  async function load() {
    if (logger.loaded) return;
    logger.loaded = true;
    try {
      if (!browser?.storage?.local) return;
      const result = await browser.storage.local.get({ logLevel: LEVEL_WARN });
      applyLevel(parseLevel(result.logLevel));
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.logLevel) {
          applyLevel(parseLevel(changes.logLevel.newValue));
        }
      });
    } catch {}
  }

  applyLevel(LEVEL_WARN);
  load();

  webhid.export("logger", logger);
})();
