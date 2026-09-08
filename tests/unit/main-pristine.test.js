import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync('addon/manifest.json', 'utf8'))
const manifestV2 = JSON.parse(readFileSync('addon/manifest.v2.json', 'utf8'))
const chromiumManifest = JSON.parse(readFileSync('addon/manifest.chromium.json', 'utf8'))
const mainEntry = manifest.content_scripts.find((entry) => entry.world === 'MAIN')
const bundleSource = readFileSync('addon/js/utils/bundle-files.js', 'utf8')

const bundleNames = ['worker', 'workerPolyfill', 'mv2MainWorld']

test('every MAIN entry starts with pristine bootstrap', () => {
  assert.equal(mainEntry.js[0], 'js/utils/bootstrap.js')
  assert.equal(manifest.content_scripts[0].world, 'MAIN')
  assert.equal(manifest.content_scripts[1].world, 'ISOLATED')
  const mainSource = readFileSync('addon/js/content/main/index.js', 'utf8')
  const bridgeSource = readFileSync('addon/js/content/isolated/bridge.js', 'utf8')
  assert.match(mainSource, /nativeWindowPostMessage, target, null/)
  assert.doesNotMatch(mainSource, /webhidBridgeRequest|webhidBridgeReady/)
  assert.doesNotMatch(bridgeSource, /webhidBridgeRequest|webhidBridgeReady/)
  assert.doesNotMatch(bridgeSource, /webhidPolicyRequest|framePolicyResponse/)
  assert.equal(manifest.content_scripts.filter((entry) => entry.world === 'ISOLATED').length, 1)
  assert.equal(manifestV2.content_scripts.length, 2)
  assert.equal(
    chromiumManifest.content_scripts.filter((entry) => entry.world === 'ISOLATED').length,
    1
  )
  assert.equal(
    [
      ...manifest.content_scripts,
      ...manifestV2.content_scripts,
      ...chromiumManifest.content_scripts
    ].some((entry) => entry.js.includes('frame-identity.js')),
    false
  )
  assert.match(bridgeSource, /'setFrameDelegation'/)
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
