import { test, expect } from '@playwright/test'
import { startWebhidMock, stopWebhidMock } from '../../helpers/e2e-process.js'
import { startStaticServer } from '../../serve.js'
import { runBenchmark, printResults, VENDOR } from '../benchmark-utils.js'

test('image pipeline benchmark chromium native (semi-auto)', async ({ page }) => {
  const mock = startWebhidMock('vendor.bin', 0x16c0, 0x0001)
  await mock.ready
  const { port, server } = await startStaticServer()
  try {
    const origin = `http://localhost:${port}`

    await page.goto(`${origin}/tests/test-page.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
    console.log('>>> Select the FF-WebHID mock (0x16c0:0x0001) in the Chromium chooser')
    const granted = await page.evaluate((f) => window.tests!.helper!.requestDevice!([f]), VENDOR)
    expect(granted).toBe(1)

    await page.goto(`${origin}/tests/pages/benchmark-image.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForFunction(() => (window.webhidBenchmark?.chunkCount() ?? 0) > 0, {
      timeout: 15000
    })

    const result = await runBenchmark(page, mock)
    expect(result.runs.length).toBeGreaterThan(0)
    printResults('native', result)
  } finally {
    server.close()
    stopWebhidMock(mock)
  }
})
