import { test, expect } from '../helpers/e2e.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput, waitForOutputReport } from '../helpers/e2e-process.js'

const VENDOR = mockIdFor('vendor')
const VENDOR_INPUT_SIZE = 64

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

test.describe.serial('picker consent bypass', () => {
  test('baseline: vendor device is not granted before the bypass', async ({ sharedPage }) => {
    const vendorCount = await sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      return ds.filter((d) => d.vendorId === 0x16c0 && d.productId === 0x0001).length
    })
    expect(vendorCount).toBe(0)
  })

  test('prototype patch cannot capture the bridge port anymore', async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      for (const d of ds) await d.forget()
    })

    await sharedPage.reload({ waitUntil: 'domcontentloaded' })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
      timeout: 15000
    })

    const probe = await sharedPage.evaluate(async () => {
      const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage')
      if (!desc || !desc.writable) {
        return { error: 'MessagePort.prototype.postMessage is not patchable' }
      }
      const origPost = desc.value as (this: MessagePort, msg: unknown, ...rest: unknown[]) => void
      const state: { port: MessagePort | null; msgs: unknown[] } = { port: null, msgs: [] }
      ;(globalThis as Record<string, unknown>).__probe = state

      MessagePort.prototype.postMessage = function (this: MessagePort, msg, ...rest) {
        if (!state.port && this instanceof MessagePort) {
          state.port = this
          this.addEventListener('message', (e) => state.msgs.push(e.data))
        }
        return origPost.call(this, msg, ...rest)
      }

      await navigator.hid.getDevices()
      await navigator.hid.getDevices()
      const ds = await navigator.hid.getDevices()
      return {
        portCaptured: state.port != null,
        granted: ds.filter((d) => d.vendorId === 0x16c0 && d.productId === 0x0001).length
      }
    })

    expect(probe.error).toBeUndefined()
    expect(probe.portCaptured).toBe(false)
    expect(probe.granted).toBe(0)
  })

  test('legitimate chooser flow still grants, opens and drives reports', async ({
    sharedPage,
    vendorDevice
  }) => {
    const count = await grantDevicePermission(sharedPage, [VENDOR])
    expect(count).toBe(1)

    const opened = await sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === 0x16c0 && x.productId === 0x0001)
      if (!d) return { error: 'device missing from getDevices after chooser grant' }
      await d.open()
      return { opened: d.opened }
    })
    expect(opened.error).toBeUndefined()
    expect(opened.opened).toBe(true)

    const reportPromise = sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === 0x16c0 && x.productId === 0x0001)!
      const { promise, resolve } = Promise.withResolvers<{
        reportId: number
        data: number[]
      }>()
      d.oninputreport = (event) => {
        resolve({ reportId: event.reportId, data: Array.from(new Uint8Array(event.data.buffer)) })
      }
      return promise
    })
    await sleep(200)
    sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0))
    const event = await reportPromise
    expect(event.reportId).toBe(1)
    expect(event.data.length).toBe(VENDOR_INPUT_SIZE)

    const outputPromise = waitForOutputReport(vendorDevice)
    await sleep(200)
    await sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === 0x16c0 && x.productId === 0x0001)!
      await d.sendReport(1, new Uint8Array(64).fill(0x42))
    })
    const output = await outputPromise
    expect(output.data[0]).toBe(1)

    await sharedPage.evaluate(async () => {
      const ds = await navigator.hid.getDevices()
      for (const d of ds) await d.forget()
    })
  })
})
