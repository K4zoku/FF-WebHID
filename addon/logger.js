// Logger module — level-based filtering, controlled by `logLevel` in
// browser.storage.local. Levels: 0=error, 1=warn, 2=info, 3=debug.
// Default: 1 (warn + error). Higher levels include lower ones.
//
// Usage:
//   importScripts('logger.js');            // workers
//   <script src="logger.js"></script>      // popup/settings
//   // content scripts: load via manifest or importScripts
//
// Then call `logger.info(...)`, `logger.debug(...)`, etc. The methods
// are no-ops when the configured level is below their threshold.

const LEVEL_ERROR = 0;
const LEVEL_WARN = 1;
const LEVEL_INFO = 2;
const LEVEL_DEBUG = 3;

const logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},

  _level: LEVEL_WARN,
  _loaded: false,
};

function _applyLevel(level) {
  logger._level = level;
  logger.error = level >= LEVEL_ERROR ? console.error.bind(console) : () => {};
  logger.warn = level >= LEVEL_WARN ? console.warn.bind(console) : () => {};
  logger.info = level >= LEVEL_INFO ? console.info.bind(console) : () => {};
  logger.debug = level >= LEVEL_DEBUG ? console.debug.bind(console) : () => {};
}

function _parseLevel(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
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
    const ext = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (!ext || !ext.storage || !ext.storage.local) return;
    const result = await ext.storage.local.get({ logLevel: LEVEL_WARN });
    _applyLevel(_parseLevel(result.logLevel));
    if (ext.storage.onChanged) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.logLevel) {
          _applyLevel(_parseLevel(changes.logLevel.newValue));
        }
      });
    }
  } catch {
    // storage unavailable (e.g. page context without extension APIs)
  }
}

_applyLevel(LEVEL_WARN);
_load();

if (typeof self !== 'undefined') self.logger = logger;
if (typeof window !== 'undefined') window.logger = logger;
if (typeof module !== 'undefined' && module.exports) module.exports = logger;
