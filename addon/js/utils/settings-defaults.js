(function () {
const GLOBAL_DEFAULTS = {
  perfLogging: false,
  fireAndForget: true,
  dataPlane: 'nm',
  controlPlane: 'nm',
  sabEnabled: true,
  sabCapacity: 8192,
  dispatchDataView: false,
  logLevel: 1,
  daemonAsNmHost: false,
};

globalThis.__webhid = globalThis.__webhid || {};
globalThis.__webhid.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS;
})();
