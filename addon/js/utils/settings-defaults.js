(function () {
const GLOBAL_DEFAULTS = {
  fireAndForget: true,
  dataPlane: 'nm',
  controlPlane: 'nm',
  logLevel: 1,
  daemonAsNmHost: false,
};

globalThis.__webhid = globalThis.__webhid || {};
globalThis.__webhid.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS;
})();
