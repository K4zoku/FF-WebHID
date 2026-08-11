import { type Page } from '@playwright/test'
import { sleep, withTimeout } from './test-utils.js'
import { sendInput, type WebhidMockProcess } from './e2e-process.js'
import { mockIdFor } from './e2e-devices.js'
import type { DeviceFilter } from './e2e-types.js'

export const VENDOR = mockIdFor('vendor')
export const VENDOR_INPUT_SIZE = 64
export const VENDOR_OUTPUT_ID = 1
export const FEATURE_REPORT_ID = 0x02

export const VENDOR_CTX = {
  f: VENDOR,
  size: VENDOR_INPUT_SIZE,
  outputId: VENDOR_OUTPUT_ID,
  featureId: FEATURE_REPORT_ID
}

export type VendorCtx = typeof VENDOR_CTX

export interface ReportEvent {
  reportId: number
  data: number[]
}

export function nextInputReport(
  page: Page,
  flt: DeviceFilter,
  marker?: { index: number; value: number }
): Promise<ReportEvent> {
  return page.evaluate(
    ({ f, link }: { f: DeviceFilter; link: { index: number; value: number } | undefined }) => {
      const { promise, resolve, reject } = Promise.withResolvers<ReportEvent>()
      void navigator.hid.getDevices().then((ds) => {
        const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)
        if (!d) {
          reject(new Error(`device not paired: ${JSON.stringify(f)}`))
          return
        }
        d.oninputreport = (event) => {
          const r: ReportEvent = {
            reportId: event.reportId,
            data: Array.from(new Uint8Array(event.data.buffer))
          }
          if (!link || r.data[link.index] === link.value) resolve(r)
        }
      })
      return promise
    },
    { f: flt, link: marker }
  )
}

export async function sendUntilReported(
  device: WebhidMockProcess,
  page: Page,
  flt: DeviceFilter,
  reportId: number,
  payload: number[],
  marker: { index: number; value: number },
  opts: { attempts?: number; timeoutMs?: number } = {}
): Promise<ReportEvent> {
  const attempts = opts.attempts ?? 5
  const timeoutMs = opts.timeoutMs ?? 2000
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reportPromise = nextInputReport(page, flt, marker)
    await sleep(250)
    sendInput(device, reportId, payload)
    try {
      return await withTimeout(
        reportPromise,
        timeoutMs,
        'report not received on attempt ' + attempt
      )
    } catch (err) {
      if (attempt === attempts - 1) throw err
    }
  }
  throw new Error('unreachable')
}
