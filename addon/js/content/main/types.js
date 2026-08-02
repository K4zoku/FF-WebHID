/**
 * @typedef {object} HIDDeviceInfo
 * @property {string} id
 * @property {number} vendorId
 * @property {number} productId
 * @property {string} [productName]
 * @property {number} [usagePage]
 * @property {number} [usage]
 * @property {Array<{usagePage: number, usage: number}>} [collections]
 */

/**
 * @typedef {object} HIDDeviceFilter
 * @property {number} [vendorId]
 * @property {number} [productId]
 * @property {number} [usagePage]
 * @property {number} [usage]
 */

/**
 * @typedef {object} Logger
 * @property {(msg: string, ...args: any[]) => void} error
 * @property {(msg: string, ...args: any[]) => void} warn
 * @property {(msg: string, ...args: any[]) => void} info
 * @property {(msg: string, ...args: any[]) => void} debug
 * @property {(level: number) => void} applyLevel
 * @property {(m: string) => void} initLogger
 * @property {number} level
 * @property {boolean} loaded
 */

/**
 * @typedef {object} WsTransportOpts
 * @property {string} [tag]
 * @property {() => void} [onReady]
 * @property {() => void} [onClosed]
 * @property {(code: number) => void} [onAuthFailed]
 * @property {(frame: Uint8Array) => void} [onBinary]
 * @property {(text: string) => void} [onText]
 */

/**
 * @typedef {object} WsTransport
 * @property {(msg: {wsPort: number, token: string, logLevel?: number}) => void} connect
 * @property {(frame: Uint8Array | string) => boolean} send
 * @property {() => boolean} isOpen
 * @property {() => void} disconnect
 */

/**
 * @typedef {object} WtTransport
 * @property {(msg: {wtPort: number, wtCertHash?: string, token: string, logLevel?: number}) => void} connect
 * @property {(frame: Uint8Array | string) => boolean} send
 * @property {() => boolean} isOpen
 * @property {() => void} disconnect
 */

/**
 * @typedef {object} HIDDevice
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {(reportId: number, data: BufferSource) => Promise<void>} sendReport
 * @property {(reportId: number, data: BufferSource) => Promise<void>} sendFeatureReport
 * @property {(reportId: number) => Promise<DataView>} receiveFeatureReport
 * @property {HIDDeviceInfo} deviceInfo
 * @property {Function|null} oninputreport
 */

/**
 * @typedef {object} SettingsDefaults
 * @property {string} dataPlane
 * @property {number} logLevel
 * @property {boolean} daemonAsNmHost
 * @property {string} devicePickerMode
 * @property {boolean} workerPolyfillEnabled
 */
