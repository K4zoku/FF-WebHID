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
 * @typedef {object} HIDDeviceInfo
 * @property {string} id
 * @property {number} vendorId
 * @property {number} productId
 * @property {string} [productName]
 * @property {number} [usagePage]
 * @property {number} [usage]
 * @property {Array<{usagePage: number, usage: number}>} [collections]
 * @property {boolean} [descriptorParseFailed]
 */
