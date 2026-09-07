import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

function loadSettings() {
  const exports = {}
  const sandbox = {
    browser: {
      runtime: { getManifest: () => ({ manifest_version: 3 }) },
      storage: { local: { get: async () => ({}) } }
    }
  }
  const context = vm.createContext(sandbox)
  const intrinsics = vm.runInContext('({ Object, Array, Map, Set, Proxy })', context)
  const mapMethods = {
    get: (receiver, key) => intrinsics.Map.prototype.get.call(receiver, key),
    set: (receiver, key, value) => intrinsics.Map.prototype.set.call(receiver, key, value),
    delete: (receiver, key) => intrinsics.Map.prototype.delete.call(receiver, key),
    has: (receiver, key) => intrinsics.Map.prototype.has.call(receiver, key),
    forEach: (receiver, callback, thisArg) =>
      intrinsics.Map.prototype.forEach.call(receiver, callback, thisArg)
  }
  const setMethods = {
    add: (receiver, value) => intrinsics.Set.prototype.add.call(receiver, value),
    delete: (receiver, value) => intrinsics.Set.prototype.delete.call(receiver, value),
    has: (receiver, value) => intrinsics.Set.prototype.has.call(receiver, value),
    forEach: (receiver, callback, thisArg) =>
      intrinsics.Set.prototype.forEach.call(receiver, callback, thisArg)
  }
  sandbox.webhid = {
    import(name) {
      if (name === 'pristine') {
        return {
          object: intrinsics.Object,
          types: {
            Map: { constructor: intrinsics.Map, proto: { methods: mapMethods } },
            Set: { constructor: intrinsics.Set, proto: { methods: setMethods } },
            Proxy: { constructor: intrinsics.Proxy },
            Array: {
              constructor: intrinsics.Array,
              proto: { methods: { push: intrinsics.Array.prototype.push } },
              getStaticDescriptor: () => ({ value: intrinsics.Array.isArray })
            }
          }
        }
      }
      if (name === 'isChromium') return false
      throw new Error('unexpected import: ' + name)
    },
    export(name, value) {
      exports[name] = value
    }
  }
  vm.runInContext(readFileSync('addon/js/utils/settings.js', 'utf8'), context)
  return { context, intrinsics, exports }
}

test('settings updates and overlays survive a poisoned array iterator', async () => {
  const { context, exports } = loadSettings()
  context.settingsExports = exports
  context.browser.storage.local.get = async (keys) => {
    const result = {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (key === 'settings :: dataPlane') result[key] = 'nm'
      if (key === 'settings :: https://example.test :: dataPlane') result[key] = 'ws'
    }
    return result
  }
  const result = await vm.runInContext(
    `(
      async () => {
        const store = settingsExports.createSettingsStore({ value: 1 })
        const changes = []
        store.on('value', (value) => changes.push(value))
        Array.prototype[Symbol.iterator] = () => {
          throw new Error('poisoned Array iterator')
        }
        const changed = store.set({ value: 2 })
        const effective = await settingsExports.loadEffectiveSettings('https://example.test')
        return { changed, changes, value: store.value, effective }
      }
    )()`,
    context
  )
  assert.equal(result.value, 2)
  assert.equal(result.changes[0], 2)
  assert.equal(result.effective.dataPlane, 'ws')
})
