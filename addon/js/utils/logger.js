// Logger module: level-based filtering, controlled by `logLevel` in
// browser.storage.local. Levels: 0=error, 1=warn, 2=info, 3=debug.
// Default: 1 (warn + error). Higher levels include lower ones.
//
// Level changes reassign the methods to either the real console function or
// a no-op, so call sites never need `if (level >= X)` guards.
//
// Usage:
//   <script src="logger.js"></script>      // popup/settings/content scripts
//   logger.info("hello")
//   const t = perf.begin(); ... perf.end(t, "label")  // performance timing

const LEVEL_ERROR = 0;
const LEVEL_WARN = 1;
const LEVEL_INFO = 2;
const LEVEL_DEBUG = 3;

const _nop = () => {};

const logger = {
  error: _nop,
  warn: _nop,
  info: _nop,
  debug: _nop,
  _level: LEVEL_WARN,
  _loaded: false,
};

function _applyLevel(level) {
  logger._level = level;
  logger.error = level >= LEVEL_ERROR ? console.error.bind(console) : _nop;
  logger.warn  = level >= LEVEL_WARN  ? console.warn.bind(console)  : _nop;
  logger.info  = level >= LEVEL_INFO  ? console.info.bind(console)  : _nop;
  logger.debug = level >= LEVEL_DEBUG ? console.debug.bind(console) : _nop;
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

// Performance timing helper. perf.begin() returns a timestamp token;
// perf.end(token, label) logs `label <elapsed>ms` at debug level.
// When logLevel < debug, both are no-ops; zero overhead.
const perf = {
  begin: _nop,
  end: _nop,
};

function _applyPerf() {
  if (logger._level >= LEVEL_DEBUG) {
    perf.begin = () => performance.now();
    perf.end = (t0, label) => logger.debug(label + ' ' + (performance.now() - t0).toFixed(2) + 'ms');
  } else {
    perf.begin = _nop;
    perf.end = _nop;
  }
}

async function _load() {
  if (logger._loaded) return;
  logger._loaded = true;
  try {
    const ext = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    if (!ext || !ext.storage || !ext.storage.local) return;
    const result = await ext.storage.local.get({ logLevel: LEVEL_WARN });
    _applyLevel(_parseLevel(result.logLevel));
    _applyPerf();
    if (ext.storage.onChanged) {
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.logLevel) {
          _applyLevel(_parseLevel(changes.logLevel.newValue));
          _applyPerf();
        }
      });
    }
  } catch {
    // storage unavailable (e.g. page context without extension APIs)
  }
}

_applyLevel(LEVEL_WARN);
_applyPerf();
_load();

if (typeof self !== 'undefined') { self.logger = logger; self.perf = perf; }
if (typeof window !== 'undefined') { window.logger = logger; window.perf = perf; }
if (typeof module !== 'undefined' && module.exports) module.exports = { logger, perf };
