import { test, expect } from '../helpers/browser.js'
import { navigateToPolicyCheck } from '../helpers/browser-utils.js'

test.describe('MAIN-world pristine intrinsics', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('internal event state survives hostile native patches', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      const nativeEventTarget = EventTarget
      const nativeMap = Map
      const nativeWeakMap = WeakMap
      const nativeObject = Object
      const nativeReflect = Reflect
      const nativeUint8Array = Uint8Array
      const nativeDataView = DataView
      type NativeMethod = (...args: unknown[]) => unknown
      const ownMethod = (target: object, key: string): NativeMethod => {
        let current: object | null = target
        while (current) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key)
          if (descriptor && typeof descriptor.value === 'function') {
            return descriptor.value as NativeMethod
          }
          current = Reflect.getPrototypeOf(current)
        }
        throw new Error('missing method: ' + key)
      }
      const originalEventTarget = {
        add: ownMethod(nativeEventTarget.prototype, 'addEventListener'),
        remove: ownMethod(nativeEventTarget.prototype, 'removeEventListener'),
        dispatch: ownMethod(nativeEventTarget.prototype, 'dispatchEvent')
      }
      const originalMap = {
        get: ownMethod(nativeMap.prototype, 'get'),
        set: ownMethod(nativeMap.prototype, 'set')
      }
      const originalWeakMap = {
        get: ownMethod(nativeWeakMap.prototype, 'get'),
        set: ownMethod(nativeWeakMap.prototype, 'set')
      }
      const originalObjectDescriptor = ownMethod(nativeObject, 'getOwnPropertyDescriptor')
      const originalFreeze = ownMethod(nativeObject, 'freeze')
      const originalReflectConstruct = ownMethod(nativeReflect, 'construct')
      const originalUint8Set = ownMethod(nativeUint8Array.prototype, 'set')
      const originalDataViewGetUint32 = ownMethod(nativeDataView.prototype, 'getUint32')
      nativeEventTarget.prototype.addEventListener = () => {
        throw new Error('patched EventTarget.addEventListener')
      }
      nativeEventTarget.prototype.removeEventListener = () => {
        throw new Error('patched EventTarget.removeEventListener')
      }
      nativeEventTarget.prototype.dispatchEvent = () => {
        throw new Error('patched EventTarget.dispatchEvent')
      }
      nativeMap.prototype.get = () => {
        throw new Error('patched Map.get')
      }
      nativeMap.prototype.set = () => {
        throw new Error('patched Map.set')
      }
      nativeWeakMap.prototype.get = () => {
        throw new Error('patched WeakMap.get')
      }
      nativeWeakMap.prototype.set = () => {
        throw new Error('patched WeakMap.set')
      }
      nativeObject.getOwnPropertyDescriptor = () => {
        throw new Error('patched Object.getOwnPropertyDescriptor')
      }
      nativeReflect.construct = () => {
        throw new Error('patched Reflect.construct')
      }
      nativeObject.freeze = (target: object): object => target
      nativeUint8Array.prototype.set = () => {
        throw new Error('patched Uint8Array.set')
      }
      nativeDataView.prototype.getUint32 = () => {
        throw new Error('patched DataView.getUint32')
      }
      globalThis.Uint8Array = class HostileUint8Array {}
      globalThis.DataView = class HostileDataView {}

      let received = false
      navigator.hid.addEventListener('probe', () => {
        received = true
      })
      const event = new HIDConnectionEvent('probe', { device: navigator.hid })
      navigator.hid.dispatchEvent(event)
      const constructorsReplaced =
        nativeUint8Array !== globalThis.Uint8Array && nativeDataView !== globalThis.DataView
      nativeEventTarget.prototype.addEventListener = originalEventTarget.add
      nativeEventTarget.prototype.removeEventListener = originalEventTarget.remove
      nativeEventTarget.prototype.dispatchEvent = originalEventTarget.dispatch
      nativeMap.prototype.get = originalMap.get
      nativeMap.prototype.set = originalMap.set
      nativeWeakMap.prototype.get = originalWeakMap.get
      nativeWeakMap.prototype.set = originalWeakMap.set
      nativeObject.getOwnPropertyDescriptor = originalObjectDescriptor
      nativeObject.freeze = originalFreeze
      nativeReflect.construct = originalReflectConstruct
      nativeUint8Array.prototype.set = originalUint8Set
      nativeDataView.prototype.getUint32 = originalDataViewGetUint32
      globalThis.Uint8Array = nativeUint8Array
      globalThis.DataView = nativeDataView
      return {
        received,
        type: event.type,
        deviceIsSame: event.device === navigator.hid,
        nativeConstructorsStillAvailable: constructorsReplaced
      }
    })

    expect(result.received).toBe(true)
    expect(result.type).toBe('probe')
    expect(result.deviceIsSame).toBe(true)
    expect(result.nativeConstructorsStillAvailable).toBe(true)
  })
})
