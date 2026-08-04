/**
 * @typedef {object} Logger
 * @property {(msg: string, ...args: any[]) => void} error
 * @property {(msg: string, ...args: any[]) => void} warn
 * @property {(msg: string, ...args: any[]) => void} info
 * @property {(msg: string, ...args: any[]) => void} debug
 * @property {(level: number) => void} applyLevel
 * @property {(m: string) => void} initLogger
 * @property {(store: object|null) => void} bindSettings
 * @property {number} level
 * @property {boolean} loaded
 */

/**
 * @typedef {object} SettingsStore
 * @property {(keys: string|string[], callback: Function) => Function} on
 * @property {(patch: object) => object} set
 * @property {() => object} getAll
 * @property {string} dataPlane
 * @property {number} logLevel
 * @property {boolean} daemonAsNmHost
 * @property {string} devicePickerMode
 * @property {boolean} workerPolyfillEnabled
 * @property {boolean} allowActivationlessRequestDevice
 */
