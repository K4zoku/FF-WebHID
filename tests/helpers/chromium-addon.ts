import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { type BrowserContext, type Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..')

const NM_HOST_NAME = 'webhid.daemon_nm_host'

declare global {
  interface Window {
    __webhidPairResult?: { ok: boolean; count?: number; name?: string; message?: string }
  }
}

/**
 * Chrome for Testing (the Playwright `channel: 'chromium'` build, strace-
 * verified) looks up native messaging hosts inside the profile's own
 * user-data-dir as `<userDataDir>/NativeMessagingHosts/<name>.json`, not in
 * ~/.config. The manifest is written there and removed on cleanup.
 */
function chromeNmManifestPath(userDataDir: string): string {
  return join(userDataDir, 'NativeMessagingHosts', `${NM_HOST_NAME}.json`)
}

export function installChromeNmManifest(extensionId: string, userDataDir: string): void {
  const manifest = {
    name: NM_HOST_NAME,
    description: 'FF-WebHID daemon native messaging host (chromium testbed)',
    path: join(projectRoot, 'crates', 'target', 'debug', 'webhid-daemon'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }
  const p = chromeNmManifestPath(userDataDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(manifest, null, 2))
}

export function uninstallChromeNmManifest(userDataDir: string): void {
  rmSync(chromeNmManifestPath(userDataDir), { force: true })
}

function nmDaemonProcessCount(): number {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq webhid-daemon.exe', '/NH'], {
      encoding: 'utf8'
    })
    return r.status === 0 && !r.stdout.includes('INFO: No tasks') ? 1 : 0
  }
  const r = spawnSync('pgrep', ['-f', 'webhid-daemon chrome-extension://'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean).length : 0
}

/**
 * Waits until Chrome has spawned the daemon as an NM host. The extension's
 * boot-time connect targets the forwarder host; it only switches to the
 * daemon host once the settings page applies `daemonAsNmHost`, so this must
 * run after setExtensionSettings and before the first picker enumerate.
 */
export async function waitForNmDaemon(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (nmDaemonProcessCount() > 0) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`daemon not started as an NM host within ${timeoutMs}ms`)
}

/**
 * Reads the extension id from the background service worker URL.
 */
export async function getExtensionId(context: BrowserContext): Promise<string> {
  const deadline = Date.now() + 15000
  for (;;) {
    for (const sw of context.serviceWorkers()) {
      const m = /^chrome-extension:\/\/([^/]+)\//.exec(sw.url())
      if (m) return m[1]
    }
    if (Date.now() > deadline) {
      throw new Error('getExtensionId: background service worker not found')
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

export type AddonDataPlane = 'nm' | 'ws' | 'wt' | 'wt-inpage'

/**
 * Opens the extension settings page and writes the testbed settings:
 * the requested data plane (global + origin), modal picker mode (global +
 * origin, the default in-page shadow-DOM picker), daemon-as-NM-host (global
 * only). ws/wt use the blob worker spawn (the testbed page has no CSP, so the
 * blob path is allowed and the shadow-URL webRequest machinery is not needed);
 * wt-inpage runs the WebTransport plane in the page with `useWorker: false`.
 * Returns the runtime extension id read from the same page.
 */
export async function setExtensionSettings(
  context: BrowserContext,
  extensionId: string,
  origin: string,
  mode: AddonDataPlane = 'nm'
): Promise<string> {
  const page = await context.newPage()
  try {
    await page.goto(`chrome-extension://${extensionId}/js/internal/pages/settings/index.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const runtimeId = await page.evaluate(() => browser.runtime.id)
    const dataPlane = mode === 'wt-inpage' ? 'wt' : mode
    const keys: Record<string, string | boolean> = {
      'settings :: dataPlane': dataPlane,
      [`settings :: ${origin} :: dataPlane`]: dataPlane,
      'settings :: devicePickerMode': 'modal',
      [`settings :: ${origin} :: devicePickerMode`]: 'modal',
      'settings :: daemonAsNmHost': true
    }
    if (mode === 'ws' || mode === 'wt') {
      keys['settings :: workerSpawnMode'] = 'blob'
      keys[`settings :: ${origin} :: workerSpawnMode`] = 'blob'
    }
    if (mode === 'wt-inpage') {
      keys['settings :: useWorker'] = false
      keys[`settings :: ${origin} :: useWorker`] = false
      keys['settings :: logLevel'] = 3
      keys[`settings :: ${origin} :: logLevel`] = 3
    }
    await page.evaluate(({ keys }) => browser.storage.local.set(keys), { keys })
    return runtimeId
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Pairs the vendor mock device through the default in-page modal picker: a
 * trusted click on a shim button calls navigator.hid.requestDevice with the
 * vendor filter, the modal is focused with a click on its header (Chromium
 * showModal does not move focus into a closed shadow root), then
 * Tab/Enter/Tab/Tab/Enter drives item select + Connect.
 */
export async function pairViaPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    let btn = document.getElementById('webhid-pair-btn')
    if (!btn) {
      btn = document.createElement('button')
      btn.id = 'webhid-pair-btn'
      btn.textContent = 'Pair vendor device'
      btn.style.position = 'fixed'
      btn.style.top = '0'
      btn.style.left = '0'
      btn.style.zIndex = '2147483647'
      document.body.appendChild(btn)
    }
    btn.onclick = async () => {
      try {
        const devices = await navigator.hid.requestDevice({
          filters: [{ vendorId: 0x16c0, productId: 0x0001 }]
        })
        window.__webhidPairResult = { ok: true, count: devices.length }
      } catch (e) {
        const err = e as { name?: string; message?: string }
        window.__webhidPairResult = {
          ok: false,
          name: err.name,
          message: err.message
        }
      }
    }
  })
  type PairResult = { ok: boolean; count?: number; name?: string; message?: string }
  const { promise: requestResult, resolve: resolveResult } = Promise.withResolvers<PairResult>()
  const poll = async () => {
    const deadline = Date.now() + 30000
    for (;;) {
      const r = await page.evaluate(() => window.__webhidPairResult).catch(() => null)
      if (r) {
        resolveResult(r)
        return
      }
      if (Date.now() > deadline) {
        resolveResult({
          ok: false,
          name: 'Timeout',
          message: 'pairViaPicker: requestDevice never settled'
        })
        return
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 50)
      await promise
    }
  }
  void poll()
  await page.click('#webhid-pair-btn', { timeout: 15000 })

  await page.waitForFunction(
    () => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      return el != null && el.id === 'webhid-shadow-host'
    },
    { timeout: 15000 }
  )
  await page.waitForTimeout(800)
  await page.mouse.click(100, 20)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')

  const result = await requestResult
  if (!result.ok) {
    throw new Error(`pairViaPicker: requestDevice failed: ${result.name}: ${result.message}`)
  }
}
