import { test, expect } from '../helpers/e2e.js'
import type { Page } from '@playwright/test'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput, type WebhidMockProcess } from '../helpers/e2e-process.js'
import { sleep } from '../helpers/test-utils.js'
import type { FirefoxBgPage } from '../helpers/harness.js'

const VENDOR = mockIdFor('vendor')
const PACKET = [0x10, 0x20, 0x30, 0x40, 0x50].concat(new Array(59).fill(0))

async function prepareFanoutPage(
  sharedPage: Page,
  backgroundPage: FirefoxBgPage,
  enableWorker: boolean
): Promise<void> {
  const origin = new URL(sharedPage.url()).origin
  await backgroundPage.evaluate((siteOrigin: string) => {
    return browser.storage.local.set({ [`settings :: ${siteOrigin} :: dataPlane`]: 'nm' })
  }, origin)
  await sharedPage.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded'
  })
  await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)

  if (enableWorker) {
    await backgroundPage.evaluate((siteOrigin: string) => {
      return browser.storage.local.set({
        [`settings :: ${siteOrigin} :: workerPolyfillEnabled`]: true
      })
    }, origin)
    await sleep(500)
    await sharedPage.reload({ waitUntil: 'domcontentloaded' })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  }

  await sharedPage.goto(`${origin}/tests/pages/input-report-fanout.html`, {
    waitUntil: 'domcontentloaded'
  })
}

async function runFanout(
  sharedPage: Page,
  backgroundPage: FirefoxBgPage,
  vendorDevice: WebhidMockProcess,
  iframeCount: number,
  includeWorker: boolean
): Promise<unknown> {
  await prepareFanoutPage(sharedPage, backgroundPage, includeWorker)
  await sharedPage.evaluate(
    ({ iframeCount: count, includeWorker: worker }) => {
      window.postMessage(
        { type: 'startFanout', iframeCount: count, includeWorker: worker },
        location.origin
      )
    },
    { iframeCount, includeWorker }
  )
  await sharedPage.waitForFunction(
    () => {
      const results = window.tests?.results
      const error = results?.fanoutError
      if (typeof error === 'string') throw new Error(error)
      return results?.fanoutReady === true
    },
    { timeout: 15000 }
  )
  await sleep(300)
  sendInput(vendorDevice, 1, PACKET)
  const expectedRecipients = 1 + iframeCount + (includeWorker ? 1 : 0)
  await sharedPage.waitForFunction(
    (expected) => {
      const reports = window.tests?.results?.fanoutReports
      return Array.isArray(reports) && reports.length === expected
    },
    expectedRecipients,
    { timeout: 15000 }
  )
  const reports = await sharedPage.evaluate(() => window.tests?.results?.fanoutReports)
  await sharedPage.evaluate(async () => {
    const device = (await navigator.hid.getDevices())[0]
    if (!device) return
    if (device.opened) await device.close()
    await device.forget()
  })
  const origin = new URL(sharedPage.url()).origin
  await sharedPage.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded'
  })
  return reports
}

test.describe.serial('Public input report fan-out', () => {
  test('page and iframe both open and listen for input reports', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const reports = await runFanout(sharedPage, backgroundPage, vendorDevice, 1, false)
    expect(reports).toEqual([
      { reportId: 1, bytes: PACKET },
      { reportId: 1, bytes: PACKET }
    ])
  })

  test('page, iframe, and worker all open and listen for input reports', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const reports = await runFanout(sharedPage, backgroundPage, vendorDevice, 1, true)
    expect(reports).toEqual([
      { reportId: 1, bytes: PACKET },
      { reportId: 1, bytes: PACKET },
      { reportId: 1, bytes: PACKET }
    ])
  })

  test('page and two iframes all open and listen for input reports', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    const reports = await runFanout(sharedPage, backgroundPage, vendorDevice, 2, false)
    expect(reports).toEqual([
      { reportId: 1, bytes: PACKET },
      { reportId: 1, bytes: PACKET },
      { reportId: 1, bytes: PACKET }
    ])
  })
})
