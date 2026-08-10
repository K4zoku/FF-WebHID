import { test, expect } from '@playwright/test'
import { chromium } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startWebhidMock, stopWebhidMock } from '../../helpers/e2e-process.js'
import { startStaticServer } from '../../serve.js'
import { runBenchmark, printResults } from '../benchmark-utils.js'

const POLICY_PORT = 8123

test('image pipeline benchmark chromium native (headless auto)', async () => {
  const mock = startWebhidMock('vendor.bin', 0x16c0, 0x0001)
  await mock.ready
  const { port, server } = await startStaticServer(POLICY_PORT)
  const userDataDir = mkdtempSync(join(tmpdir(), 'webhid-crbench-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium'
  })
  try {
    const page = context.pages()[0] || (await context.newPage())
    const origin = `http://localhost:${port}`
    await page.goto(`${origin}/tests/pages/benchmark-image.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForFunction(
      () =>
        ((
          window.tests!.helper as unknown as { webhidBenchmark?: { chunkCount(): number } }
        ).webhidBenchmark?.chunkCount() ?? 0) > 0,
      {
        timeout: 15000
      }
    )

    const result = await runBenchmark(page, mock)
    expect(result.runs.length).toBeGreaterThan(0)
    printResults('native-headless', result)
  } finally {
    server.close()
    stopWebhidMock(mock)
    await context.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
