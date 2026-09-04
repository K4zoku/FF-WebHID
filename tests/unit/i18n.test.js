import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ADDON = resolve(ROOT, 'addon')
const EN_CATALOG = JSON.parse(readFileSync(resolve(ADDON, '_locales/en_US/messages.json'), 'utf8'))
const SOURCE_KEYS = new Set(Object.keys(EN_CATALOG))
const DYNAMIC_KEYS = ['planeNameWS', 'planeNameWT', 'planeNameNM']
const LOCALIZED_PAGES = [
  'js/internal/pages/popup/index.html',
  'js/internal/pages/settings/index.html',
  'js/internal/pages/picker/index.html',
  'js/internal/pages/devices/index.html'
]

function filesUnder(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path, predicate)
    return predicate(path) ? [path] : []
  })
}

function markupKeys(source) {
  const keys = new Set()
  for (const match of source.matchAll(/data-i18n(?:-md)?="([^"]+)"/g)) keys.add(match[1])
  for (const match of source.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(';')) {
      const separator = pair.indexOf(':')
      assert.ok(separator > 0, `invalid data-i18n-attr pair: ${pair}`)
      keys.add(pair.slice(separator + 1).trim())
    }
  }
  return keys
}

function staticTKeys(source) {
  return [...source.matchAll(/\bt\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]\s*\)/g)].map(
    (match) => match[1]
  )
}

function placeholders(message) {
  return [...message.matchAll(/\$(\d+)\b/g)].map((match) => match[1]).sort()
}

function loadI18n({ language, direction }) {
  const exports = {}
  const document = {
    documentElement: { lang: 'en' },
    querySelectorAll() {
      return []
    }
  }
  const context = {
    browser: {
      i18n: {
        getMessage(key) {
          return key === '@@bidi_dir' ? direction : ''
        },
        getUILanguage() {
          return language
        }
      }
    },
    document,
    globalThis: null,
    webhid: {
      export(name, value) {
        exports[name] = value
      }
    }
  }
  context.globalThis = context
  runInNewContext(readFileSync(resolve(ADDON, 'js/utils/i18n.js'), 'utf8'), context)
  return { ...exports, document }
}

test('every static localization reference resolves in en_US', () => {
  const keys = new Set(DYNAMIC_KEYS)
  for (const path of filesUnder(ADDON, (path) => path.endsWith('.html'))) {
    for (const key of markupKeys(readFileSync(path, 'utf8'))) keys.add(key)
  }
  for (const path of filesUnder(resolve(ADDON, 'js'), (path) => path.endsWith('.js'))) {
    for (const key of staticTKeys(readFileSync(path, 'utf8'))) keys.add(key)
  }
  for (const path of ['manifest.json', 'manifest.v2.json', 'manifest.chromium.json']) {
    const source = readFileSync(resolve(ADDON, path), 'utf8')
    for (const match of source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(match[1])
  }
  assert.deepEqual(
    [...keys].filter((key) => !SOURCE_KEYS.has(key)),
    []
  )
})

test('catalogues preserve source placeholders without requiring Crowdin parity', () => {
  for (const path of filesUnder(resolve(ADDON, '_locales'), (path) =>
    path.endsWith('messages.json')
  )) {
    const catalogue = JSON.parse(readFileSync(path, 'utf8'))
    for (const [key, entry] of Object.entries(catalogue)) {
      if (!Object.hasOwn(EN_CATALOG, key)) continue
      assert.equal(typeof entry.message, 'string', `${path}: ${key} must have a string message`)
      assert.deepEqual(
        placeholders(entry.message),
        placeholders(EN_CATALOG[key].message),
        `${path}: ${key} placeholders differ from en_US`
      )
    }
  }
})
test('high-value source strings match the current production architecture', () => {
  const popup = readFileSync(resolve(ADDON, 'js/internal/pages/popup/index.html'), 'utf8')
  const settings = readFileSync(resolve(ADDON, 'js/internal/pages/settings/index.html'), 'utf8')
  const popupDataPlane = 'WebTransport worker, WebSocket worker, or Native Messaging'
  const normalizedSettings = settings.replace(/\s+/g, ' ')
  const settingsDataPlane =
    '**WebTransport worker** (default): keeps transport work and parsing off the page main thread.\n' +
    '**WebSocket worker**: use when WebTransport is unavailable, such as on older Firefox.\n' +
    "**Native Messaging**: most compatible; use when a site's security policy prevents a worker transport."
  const hidePageAction = 'Hide Page Action'
  const hidePageActionDesc =
    'Keep the page action hidden when a site uses the WebHID API. The browser action still opens the device view by default.'
  assert.equal(EN_CATALOG.popupDataPlaneDesc.message, popupDataPlane)
  assert.equal(EN_CATALOG.settingsDataPlaneDesc.message, settingsDataPlane)
  assert.equal(EN_CATALOG.settingsHidePageAction.message, hidePageAction)
  assert.equal(EN_CATALOG.settingsHidePageActionDesc.message, hidePageActionDesc)
  assert.match(popup, new RegExp(popupDataPlane))
  assert.match(settings, /WebTransport worker/)
  assert.match(settings, /WebSocket worker/)
  assert.match(settings, new RegExp(hidePageAction))
  assert.ok(normalizedSettings.includes(hidePageActionDesc))
  assert.doesNotMatch(EN_CATALOG.settingsDataPlaneDesc.message, /in-page/i)
  assert.match(EN_CATALOG.pickerParseFailed.message, /cannot be opened/)
  assert.doesNotMatch(EN_CATALOG.pickerParseFailed.message, /sending reports still works/i)
})


test('localized extension pages keep text-bearing controls localized', () => {
  for (const relativePath of LOCALIZED_PAGES) {
    const source = readFileSync(resolve(ADDON, relativePath), 'utf8')
    assert.match(source, /<html lang="en">/, `${relativePath} needs an English fallback language`)
    for (const match of source.matchAll(/<(button|h[1-3]|p)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const text = match[3]
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!/[A-Za-z]/.test(text)) continue
      assert.match(
        match[0],
        /data-i18n(?:-md|-attr)?=/,
        `${relativePath}: text-bearing <${match[1]}> is not localized`
      )
    }
  }
})

test('i18n applies normalized language and direction metadata', () => {
  const { document, localizeHTML, t } = loadI18n({ language: 'ar_SA', direction: 'rtl' })
  assert.equal(t('missingKey'), 'missingKey')
  localizeHTML(document)
  assert.equal(document.documentElement.lang, 'ar-SA')
  assert.equal(document.documentElement.dir, 'rtl')
})

test('i18n preserves the static language fallback for invalid UI locales', () => {
  const { document, localizeHTML } = loadI18n({ language: 'not a locale', direction: '' })
  localizeHTML(document)
  assert.equal(document.documentElement.lang, 'en')
  assert.equal(document.documentElement.dir, undefined)
})
