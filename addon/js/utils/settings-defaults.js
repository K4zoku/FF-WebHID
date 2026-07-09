(function () {
const GLOBAL_DEFAULTS = {
  perfLogging: false,
  fireAndForget: true,
  dataPlane: 'ws',
  controlPlane: 'nm',
  sabEnabled: true,
  sabCapacity: 8192,
  dispatchDataView: false,
  logLevel: 1,
  daemonAsNmHost: false,
};

if (typeof self !== 'undefined') { self.__webhid = self.__webhid || {}; self.__webhid.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS; }
if (typeof window !== 'undefined') { window.__webhid = window.__webhid || {}; window.__webhid.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS; }
if (typeof module !== 'undefined' && module.exports) module.exports = { GLOBAL_DEFAULTS };
})();
