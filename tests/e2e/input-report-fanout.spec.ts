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
  await backgroundPage.evaluate(
    ({ siteOrigin, enableWorker }) =>
      browser.storage.local.set({
        [`settings :: ${siteOrigin} :: dataPlane`]: 'nm',
        [`settings :: ${siteOrigin} :: workerPolyfillEnabled`]: enableWorker
      }),
    { siteOrigin: origin, enableWorker }
  )
  await sharedPage.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded'
  })
  await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)

  if (enableWorker) {
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
  const origin = new URL(sharedPage.url()).origin
  const settingKeys = [
    `settings :: ${origin} :: dataPlane`,
    `settings :: ${origin} :: workerPolyfillEnabled`
  ]
  const previous = await backgroundPage.evaluate((keys) => browser.storage.local.get(keys), settingKeys)
  try {
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
    return await sharedPage.evaluate(() => window.tests?.results?.fanoutReports)
  } finally {
    await sharedPage.evaluate(async () => {
      for (const device of await navigator.hid.getDevices()) {
        if (device.opened) await device.close()
        await device.forget()
      }
    })
    await backgroundPage.evaluate(
      ({ keys, values }) => {
        const missing = keys.filter((key) => !(key in values))
        return browser.storage.local.remove(missing).then(() => browser.storage.local.set(values))
      },
      { keys: settingKeys, values: previous }
    )
    await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
  }
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
  test('same-device WS planes stay independent after one frame is removed', async ({
    sharedPage,
    backgroundPage,
    vendorDevice
  }) => {
    test.setTimeout(60000)
    const origin = new URL(sharedPage.url()).origin
    const settingKeys = [
      `settings :: ${origin} :: dataPlane`,
      `settings :: ${origin} :: workerPolyfillEnabled`
    ]
    const previous = await backgroundPage.evaluate((keys) => browser.storage.local.get(keys), settingKeys)
    await backgroundPage.evaluate((keys) =>
      browser.storage.local.set({ [keys[0]]: 'ws', [keys[1]]: false }), settingKeys)
    try {
      await sharedPage.goto(`${origin}/tests/test-page.html`, {
        waitUntil: 'domcontentloaded'
      })
      await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
        timeout: 15000
      })
      expect(await grantDevicePermission(sharedPage, [VENDOR])).toBe(1)
      await sharedPage.evaluate(() => {
        const iframe = document.createElement('iframe')
        iframe.id = 'frame-owner'
        iframe.src = '/tests/test-page.html'
        document.body.appendChild(iframe)
      })
      await sharedPage.waitForFunction(
        () => document.querySelector<HTMLIFrameElement>('#frame-owner')?.contentWindow != null,
        { timeout: 15000 }
      )
      const child = sharedPage.frames().find((frame) => frame !== sharedPage.mainFrame())
      expect(child).toBeTruthy()
      await child!.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await sharedPage.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('top frame device missing')
        await device.open()
        let reports = 0
        device.addEventListener('inputreport', () => reports++)
        ;(window as typeof window & { __reports?: number }).__reports = reports
        Object.defineProperty(window, '__getReports', {
          configurable: true,
          value: () => reports
        })
      })
      await child!.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('child frame device missing')
        await device.open()
        let reports = 0
        device.addEventListener('inputreport', () => reports++)
        Object.defineProperty(window, '__getReports', {
          configurable: true,
          value: () => reports
        })
      })
      await sleep(300)
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => (window as typeof window & { __getReports?: () => number }).__getReports?.() === 1,
        { timeout: 15000 }
      )
      await child!.waitForFunction(
        () => (window as typeof window & { __getReports?: () => number }).__getReports?.() === 1,
        undefined,
        { timeout: 15000 }
      )
      await child!.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
      await child!.waitForFunction(() => typeof navigator.hid !== 'undefined', undefined, {
        timeout: 15000
      })
      await child!.evaluate(async () => {
        const device = (await navigator.hid.getDevices())[0]
        if (!device) throw new Error('reloaded child device missing')
        await device.open()
        let reports = 0
        device.addEventListener('inputreport', () => reports++)
        Object.defineProperty(window, '__getReports', {
          configurable: true,
          value: () => reports
        })
      })
      await sleep(300)
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => (window as typeof window & { __getReports?: () => number }).__getReports?.() === 2,
        { timeout: 15000 }
      )
      await child!.waitForFunction(
        () => (window as typeof window & { __getReports?: () => number }).__getReports?.() === 1,
        undefined,
        { timeout: 15000 }
      )
      await sharedPage.evaluate(() => document.querySelector('#frame-owner')?.remove())
      await sleep(500)
      sendInput(vendorDevice, 1, PACKET)
      await sharedPage.waitForFunction(
        () => (window as typeof window & { __getReports?: () => number }).__getReports?.() === 3,
        { timeout: 15000 }
      )
    } finally {
      await sharedPage.evaluate(async () => {
        for (const device of await navigator.hid.getDevices()) {
          if (device.opened) await device.close()
          await device.forget()
        }
      })
      await sharedPage.waitForFunction(
        async () => (await navigator.hid.getDevices()).length === 0,
        { timeout: 15000 }
      )
      await backgroundPage.evaluate(
        ({ keys, values }) => {
          const missing = keys.filter((key) => !(key in values))
          return browser.storage.local.remove(missing).then(() => browser.storage.local.set(values))
        },
        { keys: settingKeys, values: previous }
      )
      await sharedPage.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded' })
    }
  })
})
