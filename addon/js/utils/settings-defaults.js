(function () {
const GLOBAL_DEFAULTS = {
  perfLogging: false,
  fireAndForget: true,
  dataPlane: 'nm',
  controlPlane: 'nm',
  sabEnabled: true,
  sabCapacity: 256,
  logLevel: 1,
  daemonAsNmHost: false,
};

globalThis.__webhid = globalThis.__webhid || {};
globalThis.__webhid.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS;
})();
