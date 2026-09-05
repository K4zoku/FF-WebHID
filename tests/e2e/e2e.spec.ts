import { test, expect } from '../helpers/e2e.js'
import { sleep } from '../helpers/test-utils.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import type { DeviceFilter } from '../helpers/e2e-types.js'
import {
  VENDOR,
  VENDOR_CTX,
  VENDOR_INPUT_SIZE,
  VENDOR_OUTPUT_ID,
  nextInputReport,
  sendUntilReported,
  type ReportEvent
} from '../helpers/e2e-reports.js'
import { sendInput, waitForOutputReport, startWebhidMock } from '../helpers/e2e-process.js'

const GAMEPAD = mockIdFor('gamepad')

const GAMEPAD_INPUT_SIZE = 5

type VendorCtx = typeof VENDOR_CTX

test.describe.serial('WebHID E2E', () => {
  test('navigator.hid is polyfilled', async ({ sharedPage }) => {
    expect(await sharedPage.evaluate(() => typeof navigator.hid !== 'undefined')).toBe(true)
  })

  test('grant vendor permission and verify VID/PID, collections', async ({
    sharedPage,
    vendorDevice
  }) => {
    const count = await grantDevicePermission(sharedPage, [VENDOR])
    expect(count).toBe(1)
    const info = await sharedPage.evaluate(async (f: DeviceFilter) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)!
      return {
        vendorId: d.vendorId,
        productId: d.productId,
        collectionCount: d.collections.length
      }
    }, VENDOR)
    expect(info.vendorId).toBe(vendorDevice.vid)
    expect(info.productId).toBe(vendorDevice.pid)
    expect(info.collectionCount).toBe(2)
  })

  test('sendReport fails before open', async ({ sharedPage }) => {
    const errorName = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      try {
        await d.sendReport(ctx.outputId, new Uint8Array(ctx.size))
        return null
      } catch (e) {
        return e instanceof Error ? e.name : String(e)
      }
    }, VENDOR_CTX)
    expect(errorName).toBe('InvalidStateError')
  })

  test('sendFeatureReport fails before open', async ({ sharedPage }) => {
    const errorName = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      try {
        await d.sendFeatureReport(ctx.featureId, new Uint8Array(4))
        return null
      } catch (e) {
        return e instanceof Error ? e.name : String(e)
      }
    }, VENDOR_CTX)
    expect(errorName).toBe('InvalidStateError')
  })

  test('receiveFeatureReport fails before open', async ({ sharedPage }) => {
    const errorName = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      try {
        await d.receiveFeatureReport(ctx.featureId)
        return null
      } catch (e) {
        return e instanceof Error ? e.name : String(e)
      }
    }, VENDOR_CTX)
    expect(errorName).toBe('InvalidStateError')
  })

  test('open device', async ({ sharedPage }) => {
    const opened = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      await d.open()
      return d.opened
    }, VENDOR_CTX)
    expect(opened).toBe(true)
  })

  test('receive 64-byte input packet', async ({ sharedPage, vendorDevice }) => {
    const reportPromise = nextInputReport(sharedPage, VENDOR)
    await sleep(200)
    sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0))
    const event = await reportPromise
    expect(event.reportId).toBe(1)
    expect(event.data.length).toBe(VENDOR_INPUT_SIZE)
  })

  test('receive input packet with button press', async ({ sharedPage, vendorDevice }) => {
    const packet = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    packet[0] = 0xff
    packet[1] = 0xe1
    const event = await sendUntilReported(vendorDevice, sharedPage, VENDOR, 1, packet, {
      index: 1,
      value: 0xe1
    })
    expect(event.reportId).toBe(1)
    expect(event.data.length).toBe(VENDOR_INPUT_SIZE)
    expect(event.data[0]).toBe(0xff)
  })

  test('multiple input reports in sequence', async ({ sharedPage, vendorDevice }) => {
    for (let i = 0; i < 3; i++) {
      const reportPromise = nextInputReport(sharedPage, VENDOR, { index: 1, value: 0xa0 + i })
      await sleep(500)
      const packet = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
      packet[0] = i
      packet[1] = 0xa0 + i
      sendInput(vendorDevice, 1, packet)
      const event = await reportPromise
      expect(event.reportId).toBe(1)
      expect(event.data[0]).toBe(i)
      expect(event.data[1]).toBe(0xa0 + i)
    }
  })

  test('addEventListener inputreport fires alongside oninputreport', async ({
    sharedPage,
    vendorDevice
  }) => {
    const dualPromise = sharedPage.evaluate((f: DeviceFilter) => {
      const { promise, resolve, reject } = Promise.withResolvers<{
        onInput: ReportEvent
        addEventListener: ReportEvent
      }>()
      void navigator.hid.getDevices().then((ds) => {
        const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)
        if (!d) {
          reject(new Error(`device not paired: ${JSON.stringify(f)}`))
          return
        }
        const toResult = (event: HIDInputReportEvent): ReportEvent => ({
          reportId: event.reportId,
          data: Array.from(new Uint8Array(event.data.buffer))
        })
        let onInput: ReportEvent | null = null
        let onAdd: ReportEvent | null = null
        d.oninputreport = (event) => {
          onInput = toResult(event)
          if (onAdd) resolve({ onInput, addEventListener: onAdd })
        }
        d.addEventListener('inputreport', (event) => {
          onAdd = toResult(event)
          if (onInput) resolve({ onInput, addEventListener: onAdd })
        })
      })
      return promise
    }, VENDOR)

    await sleep(500)

    sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0))

    const { onInput, addEventListener: addEvt } = await dualPromise
    expect(onInput.reportId).toBe(1)
    expect(addEvt.reportId).toBe(1)
    expect(onInput.data.length).toBe(addEvt.data.length)
  })

  test('inputreport.data does not include report-ID byte for vendor report', async ({
    sharedPage,
    vendorDevice
  }) => {
    const reportPromise = nextInputReport(sharedPage, VENDOR, { index: 0, value: 0xaa })
    await sleep(500)
    const packet = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    packet[0] = 0xaa
    sendInput(vendorDevice, 1, packet)
    const event = await reportPromise
    expect(event.reportId).toBe(1)
    expect(event.data.length).toBe(VENDOR_INPUT_SIZE)
    expect(event.data[0]).toBe(0xaa)
  })

  test('sendReport succeeds with output report ID after open', async ({
    sharedPage,
    vendorDevice
  }) => {
    const outputPromise = waitForOutputReport(vendorDevice)
    await sleep(200)
    await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      await d.sendReport(ctx.outputId, new Uint8Array(ctx.size).fill(0x42))
    }, VENDOR_CTX)
    const output = await outputPromise
    expect(output.data[0]).toBe(VENDOR_OUTPUT_ID)
  })

  test('sendFeatureReport fails when the descriptor declares no feature reports', async ({
    sharedPage
  }) => {
    const errorName = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      try {
        await d.sendFeatureReport(ctx.featureId, new Uint8Array([0xab, 0xab, 0xab, 0xab]))
        return null
      } catch (e) {
        return e instanceof Error ? e.name : String(e)
      }
    }, VENDOR_CTX)
    expect(errorName).toBe('NetworkError')
  })

  test('receiveFeatureReport fails when the descriptor declares no feature reports', async ({
    sharedPage
  }) => {
    const errorName = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      try {
        await d.receiveFeatureReport(ctx.featureId)
        return null
      } catch (e) {
        return e instanceof Error ? e.name : String(e)
      }
    }, VENDOR_CTX)
    expect(errorName).toBe('NetworkError')
  })

  test('WS data plane works with gamepad when the page URL has a fragment', async ({
    sharedPage,
    gamepadDevice
  }) => {
    const count = await grantDevicePermission(sharedPage, [GAMEPAD])
    expect(count).toBe(1)

    const url = sharedPage.url()
    await sharedPage.goto(url + '#frag', { waitUntil: 'domcontentloaded', timeout: 15000 })

    await sharedPage.evaluate(async (f: DeviceFilter) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)!
      await d.open()
    }, GAMEPAD)

    const reportPromise = nextInputReport(sharedPage, GAMEPAD)
    await sleep(200)
    sendInput(gamepadDevice, 0, new Array<number>(GAMEPAD_INPUT_SIZE).fill(0))
    const event = await reportPromise
    expect(event.reportId).toBe(0)
    expect(event.data.length).toBe(GAMEPAD_INPUT_SIZE)
  })

  test('device disconnect closes opened HIDDevice state', async ({
    sharedPage,
    vendorDevice
  }) => {
    const disconnected = sharedPage.evaluate(async () => {
      const device = (await navigator.hid.getDevices())[0]
      if (!device) throw new Error('vendor device missing before disconnect')
      if (!device.opened) await device.open()
      const { promise, resolve, reject } = Promise.withResolvers<boolean>()
      navigator.hid.addEventListener('disconnect', () => resolve(device.opened === false))
      setTimeout(() => reject(new Error('disconnect event not received within 10s')), 10000)
      return promise
    })
    vendorDevice.process.stdin!.write('{"cmd":"destroy"}\n')
    expect(await disconnected).toBe(true)

    const m = startWebhidMock('vendor.bin', vendorDevice.vid, vendorDevice.pid)
    await m.ready
    vendorDevice.process = m.process
    vendorDevice.ready = m.ready

    await sharedPage.evaluate((f: DeviceFilter) => {
      const start = Date.now()
      return (async () => {
        for (;;) {
          const ds = await navigator.hid.getDevices()
          if (ds.some((x) => x.vendorId === f.vendorId && x.productId === f.productId)) return
          if (Date.now() - start > 10000) {
            throw new Error('vendor device did not re-enumerate after mock recreate')
          }
          const { promise: t, resolve: done } = Promise.withResolvers<void>()
          setTimeout(done, 100)
          await t
        }
      })()
    }, VENDOR)
  })

  test('open and close device', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      await d.open()
      const wasOpen = d.opened
      await d.close()
      return { wasOpen, nowOpen: d.opened }
    }, VENDOR_CTX)
    expect(result.wasOpen).toBe(true)
    expect(result.nowOpen).toBe(false)
  })

  test('open and close multiple times', async ({ sharedPage }) => {
    await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      for (let i = 0; i < 3; i++) {
        await d.open()
        await d.close()
      }
    }, VENDOR_CTX)
  })

  test('forget unpairs the device and sendReport fails after', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      await d.open()
      await d.forget()
      let sendError: string | null = null
      try {
        await d.sendReport(ctx.outputId, new Uint8Array(ctx.size))
      } catch (e) {
        sendError = e instanceof Error ? e.name : String(e)
      }
      return { sendError, remaining: (await navigator.hid.getDevices()).length }
    }, VENDOR_CTX)
    expect(result.sendError).toBe('InvalidStateError')
    expect(result.remaining).toBe(1)
  })
})
