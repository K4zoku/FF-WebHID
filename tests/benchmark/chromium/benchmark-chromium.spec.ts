import { test, expect } from '@playwright/test'
import { chromium } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startWebhidMock, stopWebhidMock } from '../../helpers/e2e-process.js'
import { startStaticServer } from '../../serve.js'
import { runBenchmark, printResults } from '../benchmark-utils.js'

// Fully automated (headless) native-WebHID benchmark. No chooser, no human
// click, no CDP grant (CDP cannot grant WebHID: grantPermissions lacks 'hid'
// and DeviceAccess does not cover the WebHID chooser).
//
// Prerequisite: the WebHidAllowDevicesForUrls policy must be installed where
// Chrome for Testing reads it, with the EXACT benchmark origin (the policy
// matches origins including the port):
//
//   /etc/opt/chrome_for_testing/policies/managed/webhid.json
//   {
//     "WebHidAllowDevicesForUrls": [
//       { "devices": [ { "vendor_id": 5824, "product_id": 1 } ],
//         "urls": [ "http://localhost:8123" ] }
//     ]
//   }
//
// (vendor 0x16c0 = 5824, product 0x0001 = 1; CI: write the file in the image;
// dev machine: one sudo step.) The policy pre-grants the mock, so
// navigator.hid.getDevices() returns it and the benchmark's own open()
// (getDevices-based) works without requestDevice.
//
// Launch constraints learned the hard way:
// - headless: true with the default browser uses chrome-headless-shell, which
//   has no udev/HID platform layer: Chrome never enumerates the mock.
//   `channel: 'chromium'` forces the full Chrome for Testing binary in new
//   headless mode, where enumeration works.
// - `--no-sandbox` ALSO breaks the udev enumeration: never pass it.
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
    await page.waitForFunction(() => (window.webhidBenchmark?.chunkCount() ?? 0) > 0, {
      timeout: 15000
    })

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
