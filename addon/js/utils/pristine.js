;(function () {
  const root = globalThis
  const NativeObject = Object
  const NativeReflect = Reflect
  const NativeFunction = Function
  const nativeApply = NativeReflect.apply
  const nativeConstruct = NativeReflect.construct
  const nativeOwnKeys = NativeReflect.ownKeys
  const nativeGet = NativeReflect.get
  const nativeReflectGetPrototypeOf = NativeReflect.getPrototypeOf
  const nativeSet = NativeReflect.set
  const nativeDelete = NativeReflect.deleteProperty
  const nativeDefine = NativeReflect.defineProperty
  const nativeSetPrototypeOf = NativeReflect.setPrototypeOf
  const nativeGetOwnPropertyDescriptor = NativeObject.getOwnPropertyDescriptor
  const nativeGetPrototypeOf = NativeObject.getPrototypeOf
  const nativeCreate = NativeObject.create
  const nativeDefineProperty = NativeObject.defineProperty
  const nativeFreeze = NativeObject.freeze
  const nativeObjectKeys = NativeObject.keys
  const nativeObjectEntries = NativeObject.entries
  const nativeObjectValues = NativeObject.values
  const nativeObjectAssign = NativeObject.assign
  const nativeHasOwn = NativeObject.prototype.hasOwnProperty
  const nativeFunctionBind = NativeFunction.prototype.bind

  const own = (object, key) => nativeGetOwnPropertyDescriptor(object, key)
  const call = (fn, receiver, args) => nativeApply(fn, receiver, args)
  const hasOwn = (object, key) => call(nativeHasOwn, object, [key])

  function snapshot(object) {
    const descriptors = nativeCreate(null)
    const keys = nativeOwnKeys(object)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const descriptor = own(object, key)
      nativeFreeze(descriptor)
      nativeDefineProperty(descriptors, key, {
        value: descriptor,
        writable: false,
        enumerable: true,
        configurable: false
      })
    }
    return nativeFreeze(descriptors)
  }

  function findDescriptor(chain, key) {
    for (let i = 0; i < chain.length; i++) {
      const descriptor = nativeGet(chain[i], key)
      if (descriptor !== undefined) return descriptor
    }
    return undefined
  }

  function operationTable(chain) {
    const methods = nativeCreate(null)
    const getters = nativeCreate(null)
    const setters = nativeCreate(null)
    const values = nativeCreate(null)
    const keys = []

    for (let i = 0; i < chain.length; i++) {
      const descriptors = chain[i]
      const names = nativeOwnKeys(descriptors)
      for (let j = 0; j < names.length; j++) {
        const key = names[j]
        if (
          hasOwn(values, key) ||
          hasOwn(methods, key) ||
          hasOwn(getters, key) ||
          hasOwn(setters, key)
        ) continue
        const descriptor = nativeGet(descriptors, key)
        const hasValue = hasOwn(descriptor, 'value')
        const descriptorValue = descriptor.value
        const getter = descriptor.get
        const setter = descriptor.set
        if (hasValue) {
          if (typeof descriptorValue === 'function') {
            nativeDefineProperty(methods, key, {
              value: (receiver, ...args) => call(descriptorValue, receiver, args),
              writable: false,
              enumerable: true,
              configurable: false
            })
          } else {
            nativeDefineProperty(values, key, {
              value: descriptorValue,
              writable: false,
              enumerable: true,
              configurable: false
            })
          }
        }
        if (getter) {
          nativeDefineProperty(getters, key, {
            value: (receiver) => call(getter, receiver, []),
            writable: false,
            enumerable: true,
            configurable: false
          })
        }
        if (setter) {
          nativeDefineProperty(setters, key, {
            value: (receiver, value) => call(setter, receiver, [value]),
            writable: false,
            enumerable: true,
            configurable: false
          })
        }
        keys[keys.length] = key
      }
    }

    nativeFreeze(methods)
    nativeFreeze(getters)
    nativeFreeze(setters)
    nativeFreeze(values)
    const table = { methods, getters, setters, values, keys }
    nativeFreeze(keys)
    return nativeFreeze(table)
  }
  const snapshotObjects = []
  const snapshotValues = []
  function cachedSnapshot(object) {
    for (let i = 0; i < snapshotObjects.length; i++) {
      if (snapshotObjects[i] === object) return snapshotValues[i]
    }
    const value = snapshot(object)
    snapshotObjects[snapshotObjects.length] = object
    snapshotValues[snapshotValues.length] = value
    return value
  }

  function captureType(type) {
    if (typeof type !== 'function') return null
    const prototypeDescriptor = own(type, 'prototype')
    const prototype = prototypeDescriptor && prototypeDescriptor.value
    const prototypeChain = []
    let current = prototype
    while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
      prototypeChain[prototypeChain.length] = cachedSnapshot(current)
      current = nativeGetPrototypeOf(current)
    }
    const staticChain = [cachedSnapshot(type)]
    let staticPrototype = nativeGetPrototypeOf(type)
    while (staticPrototype !== null) {
      staticChain[staticChain.length] = cachedSnapshot(staticPrototype)
      staticPrototype = nativeGetPrototypeOf(staticPrototype)
    }
    const proto = operationTable(prototypeChain)
    const statics = operationTable(staticChain)
    const captured = {
      constructor: type,
      prototype,
      proto,
      static: statics,
      construct(args, newTarget) {
        return nativeConstruct(type, args, newTarget || type)
      },
      getDescriptor(key) {
        return findDescriptor(prototypeChain, key)
      },
      getStaticDescriptor(key) {
        return findDescriptor(staticChain, key)
      }
    }
    nativeFreeze(captured)
    return captured
  }
  function captureOps(type) {
    const captured = type && type.proto ? type : captureType(type)
    return captured
      ? nativeFreeze({
          constructor: captured.constructor,
          prototype: captured.prototype,
          construct: captured.construct,
          proto: captured.proto,
          static: captured.static
        })
      : null
  }

  const typeNames = [
    'Object',
    'Array',
    'ArrayBuffer',
    'Blob',
    'DataView',
    'Date',
    'DOMException',
    'Error',
    'Event',
    'EventTarget',
    'Number',
    'Function',
    'Map',
    'MessageChannel',
    'MessagePort',
    'Navigator',
    'Promise',
    'Proxy',
    'ReadableStream',
    'ReadableStreamDefaultReader',
    'RegExp',
    'TrustedTypePolicy',
    'Set',
    'String',
    'TextDecoder',
    'TextEncoder',
    'TypeError',
    'Uint8Array',
    'URL',
    'WebTransport',
    'WeakMap',
    'Worker',
    'Window',
    'WritableStream',
    'WritableStreamDefaultWriter'
  ]
  const types = nativeCreate(null)
  for (let i = 0; i < typeNames.length; i++) {
    const name = typeNames[i]
    const type = root[name]
    nativeDefineProperty(types, name, {
      value: captureType(type),
      writable: false,
      enumerable: true,
      configurable: false
    })
  }
  nativeFreeze(types)

  const activationObject = root.navigator
    ? nativeGet(root.navigator, 'userActivation')
    : null
  let activationGetter = null
  let activationProto = activationObject
    ? nativeGetPrototypeOf(activationObject)
    : null
  const nativeWindowPostMessage =
    root.window && typeof root.window.postMessage === 'function' ? root.window.postMessage : null
  const nativeWindowAddEventListener =
    root.window && typeof root.window.addEventListener === 'function'
      ? root.window.addEventListener
      : null
  const nativeWindowRemoveEventListener =
    root.window && typeof root.window.removeEventListener === 'function'
      ? root.window.removeEventListener
      : null
  while (activationProto !== null && !activationGetter) {
    const descriptor = own(activationProto, 'isActive')
    if (descriptor && descriptor.get) activationGetter = descriptor.get
    activationProto = nativeGetPrototypeOf(activationProto)
  }
  const nativeNavigator = root.navigator
  const nativePermissions = nativeNavigator ? nativeGet(nativeNavigator, 'permissions') : null
  const permissionsQuery =
    nativePermissions && typeof nativePermissions.query === 'function'
      ? call(nativeFunctionBind, nativePermissions.query, [nativePermissions])
      : null
  const nativeConsole = root.console
  const consoleOps = nativeFreeze({
    error:
      nativeConsole && typeof nativeConsole.error === 'function'
        ? call(nativeFunctionBind, nativeConsole.error, [nativeConsole])
        : () => {},
    warn:
      nativeConsole && typeof nativeConsole.warn === 'function'
        ? call(nativeFunctionBind, nativeConsole.warn, [nativeConsole])
        : () => {},
    info:
      nativeConsole && typeof nativeConsole.info === 'function'
        ? call(nativeFunctionBind, nativeConsole.info, [nativeConsole])
        : () => {},
    debug:
      nativeConsole && typeof nativeConsole.debug === 'function'
        ? call(nativeFunctionBind, nativeConsole.debug, [nativeConsole])
        : () => {}
  })
  const host = nativeFreeze({
    window: root.window,
    self: root.self,
    navigator: root.navigator,
    crypto: root.crypto,
    trustedTypes: root.trustedTypes,
    console: consoleOps,
    userActivation: activationObject,
    userActivationIsActive: activationGetter
      ? () => call(activationGetter, activationObject, [])
      : null,
    windowAddEventListener: nativeWindowAddEventListener,
    windowRemoveEventListener: nativeWindowRemoveEventListener,
    permissionsQuery,
    permissions: nativePermissions,
    numberIsFinite: root.Number && root.Number.isFinite,
    mathTrunc: root.Math && root.Math.trunc,
    jsonStringify: root.JSON && root.JSON.stringify,
    parseInt: root.parseInt,
    isNaN: root.isNaN,
    windowPostMessageMethod: nativeWindowPostMessage,
    mathMin: root.Math && root.Math.min,
    postMessage:
      typeof root.postMessage === 'function'
        ? call(nativeFunctionBind, root.postMessage, [root])
        : null,
    timers: nativeFreeze({
      setTimeout:
        typeof root.setTimeout === 'function'
          ? call(nativeFunctionBind, root.setTimeout, [root])
          : null,
      clearTimeout:
        typeof root.clearTimeout === 'function'
          ? call(nativeFunctionBind, root.clearTimeout, [root])
          : null,
      setInterval:
        typeof root.setInterval === 'function'
          ? call(nativeFunctionBind, root.setInterval, [root])
          : null,
      clearInterval:
        typeof root.clearInterval === 'function'
          ? call(nativeFunctionBind, root.clearInterval, [root])
          : null,
      queueMicrotask:
        typeof root.queueMicrotask === 'function'
          ? call(nativeFunctionBind, root.queueMicrotask, [root])
          : null
    }),
    url: nativeFreeze({
      createObjectURL:
        root.URL && typeof root.URL.createObjectURL === 'function'
          ? call(nativeFunctionBind, root.URL.createObjectURL, [root.URL])
          : null,
      revokeObjectURL:
        root.URL && typeof root.URL.revokeObjectURL === 'function'
          ? call(nativeFunctionBind, root.URL.revokeObjectURL, [root.URL])
          : null
    }),
    cryptoRandomUUID:
      root.crypto && typeof root.crypto.randomUUID === 'function'
        ? call(nativeFunctionBind, root.crypto.randomUUID, [root.crypto])
        : null,
    trustedTypesCreatePolicy:
      root.trustedTypes && typeof root.trustedTypes.createPolicy === 'function'
        ? call(nativeFunctionBind, root.trustedTypes.createPolicy, [root.trustedTypes])
        : null
  })

  const object = nativeFreeze({
    assign: nativeObjectAssign,
    create: nativeCreate,
    defineProperty: nativeDefineProperty,
    defineProperties: NativeObject.defineProperties,
    entries: nativeObjectEntries,
    freeze: nativeFreeze,
    getOwnPropertyDescriptor: nativeGetOwnPropertyDescriptor,
    getOwnPropertyNames: NativeObject.getOwnPropertyNames,
    getOwnPropertySymbols: NativeObject.getOwnPropertySymbols,
    getPrototypeOf: nativeGetPrototypeOf,
    keys: nativeObjectKeys,
    values: nativeObjectValues,
    hasOwn: (target, key) => hasOwn(target, key)
  })
  const reflect = nativeFreeze({
    apply: nativeApply,
    construct: nativeConstruct,
    defineProperty: nativeDefine,
    deleteProperty: nativeDelete,
    get: nativeGet,
    getPrototypeOf: nativeReflectGetPrototypeOf,
    ownKeys: nativeOwnKeys,
    set: nativeSet,
    setPrototypeOf: nativeSetPrototypeOf
  })
  const pristine = nativeFreeze({ captureType, captureOps, types, host, object, reflect })

  nativeDefineProperty(root, 'webhidPristine', {
    value: pristine,
    writable: false,
    enumerable: false,
    configurable: true
  })
})()
