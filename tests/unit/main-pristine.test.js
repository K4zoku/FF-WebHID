import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync('addon/manifest.json', 'utf8'))
const mainEntry = manifest.content_scripts.find((entry) => entry.world === 'MAIN')
const bundleSource = readFileSync('addon/js/utils/bundle-files.js', 'utf8')

const bundleNames = ['worker', 'workerPolyfill', 'mv2MainWorld']

test('every MAIN entry starts with pristine bootstrap', () => {
  assert.equal(mainEntry.js[0], 'js/utils/bootstrap.js')
  for (const name of bundleNames) {
    const match = new RegExp(`${name}: \\[\\s*'([^']+)'`).exec(bundleSource)
    assert.ok(match, `missing ${name} bundle list`)
    assert.equal(match[1], 'js/utils/bootstrap.js', `${name} must bootstrap pristine capture first`)
  }
})

test('MAIN helper modules own their pristine dependency', () => {
  const requiresCapture = new Set([
    'js/utils/logger.js',
    'js/utils/device-filters.js',
    'js/utils/settings.js',
    'js/utils/webtransport.js',
    'js/utils/wire-format.js',
    'js/content/main/index.js'
  ])
  for (const file of mainEntry.js.slice(1)) {
    if (!requiresCapture.has(file)) continue
    const source = readFileSync(`addon/${file}`, 'utf8')
    assert.match(
      source,
      /webhid\.import\(['"]pristine['"]\)/,
      `${file} must import pristine capture`
    )
  }
})
