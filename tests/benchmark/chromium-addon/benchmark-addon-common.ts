import { expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { startWebhidMock, stopWebhidMock } from '../../helpers/e2e-process.js'
import { startStaticServer } from '../../serve.js'
import { runBenchmark, printResults } from '../benchmark-utils.js'
import {
  installChromeNmManifest,
  uninstallChromeNmManifest,
  getExtensionId,
  setExtensionSettings,
  pairViaPicker,
  type AddonDataPlane
} from '../../helpers/chromium-addon.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHROMIUM_DIST = resolve(__dirname, '..', '..', '..', 'dist', 'chromium')
const POLICY_PORT = 8123

async function setupPage(
  context: BrowserContext,
  extensionId: string,
  origin: string,
  mode: AddonDataPlane
): Promise<Page> {
  const runtimeId = await setExtensionSettings(context, extensionId, origin, mode)
  expect(runtimeId).toBe(extensionId)
  const page = context.pages()[0] || (await context.newPage())
  await page.goto(`${origin}/tests/pages/benchmark-image.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await page.waitForFunction(() => navigator.hid != null, { timeout: 15000 })
  await page.waitForFunction(
    () =>
      ((
        window.tests!.helper as unknown as { webhidBenchmark?: { chunkCount(): number } }
      ).webhidBenchmark?.chunkCount() ?? 0) > 0,
    {
      timeout: 15000
    }
  )
  return page
}

export async function runChromiumAddonBenchmark(
  mode: AddonDataPlane,
  label: string
): Promise<void> {
  if (!existsSync(join(CHROMIUM_DIST, 'manifest.json'))) {
    throw new Error(
      'dist/chromium/manifest.json missing; run `TARGET=chromium npm run build:addon` first'
    )
  }
  const mock = startWebhidMock('vendor.bin', 0x16c0, 0x0001)
  await mock.ready
  const { port, server } = await startStaticServer(POLICY_PORT)
  const userDataDir = mkdtempSync(join(tmpdir(), 'webhid-addon-crbench-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [
      '--disable-features=WebHID',
      `--load-extension=${CHROMIUM_DIST}`,
      `--disable-extensions-except=${CHROMIUM_DIST}`,
      '--no-first-run',
      '--disable-default-apps'
    ]
  })
  try {
    const extensionId = await getExtensionId(context)
    installChromeNmManifest(extensionId, userDataDir)

    const page = await setupPage(context, extensionId, `http://localhost:${port}`, mode)
    await pairViaPicker(page)

    const paired = await page.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      return ds.filter((d) => d.vendorId === 0x16c0 && d.productId === 0x0001).length
    })
    expect(paired).toBe(1)

    const result = await runBenchmark(page, mock)
    expect(result.runs.length).toBeGreaterThan(0)
    expect(result.fallbacks).toHaveLength(0)
    printResults(label, result)
  } finally {
    uninstallChromeNmManifest(userDataDir)
    server.close()
    stopWebhidMock(mock)
    await context.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
