import { test, expect } from '../helpers/browser.js'
import { navigateToPolicyCheck } from '../helpers/browser-utils.js'

test.describe('HIDConnectionEvent', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('new HIDConnectionEvent("connect", { device }) creates an instance', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate<{
      type: string
      deviceIsSame: boolean
      instanceOf: boolean
      instanceOfEvent: boolean
      bubbles: boolean
      cancelable: boolean
      composed: boolean
    }>(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const ev = new HIDConnectionEvent('connect', {
        device: fakeDevice,
        bubbles: true,
        cancelable: true,
        composed: true
      })
      return {
        type: ev.type,
        deviceIsSame: ev.device === fakeDevice,
        instanceOf: ev instanceof HIDConnectionEvent,
        instanceOfEvent: ev instanceof Event,
        bubbles: ev.bubbles,
        cancelable: ev.cancelable,
        composed: ev.composed
      }
    })
    expect(result.type).toBe('connect')
    expect(result.deviceIsSame).toBe(true)
    expect(result.instanceOf).toBe(true)
    expect(result.instanceOfEvent).toBe(true)
    expect(result.bubbles).toBe(true)
    expect(result.cancelable).toBe(true)
    expect(result.composed).toBe(true)
  })

  test('new HIDConnectionEvent("disconnect", { device }) is also constructable', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate<{ type: string; deviceIsSame: boolean }>(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const ev = new HIDConnectionEvent('disconnect', { device: fakeDevice })
      return { type: ev.type, deviceIsSame: ev.device === fakeDevice }
    })
    expect(result.type).toBe('disconnect')
    expect(result.deviceIsSame).toBe(true)
  })

  test('requires device in the event init dictionary', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      try {
        new HIDConnectionEvent('connect')
        return { ok: true, name: null }
      } catch (error) {
        return { ok: false, name: error instanceof Error ? error.name : String(error) }
      }
    })
    expect(result).toEqual({ ok: false, name: 'TypeError' })
  })
})

test.describe('HIDInputReportEvent', () => {
  test.beforeEach(async ({ sharedPage, pageUrl }) => {
    await navigateToPolicyCheck(sharedPage, pageUrl)
  })

  test('new HIDInputReportEvent("inputreport", { device, reportId, data }) creates an instance', async ({
    sharedPage
  }) => {
    const result = await sharedPage.evaluate<{
      type: string
      deviceIsSame: boolean
      reportId: number
      dataIsSame: boolean
      instanceOf: boolean
    }>(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const buf = new ArrayBuffer(4)
      const dv = new DataView(buf)
      const ev = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 1,
        data: dv
      })
      return {
        type: ev.type,
        deviceIsSame: ev.device === fakeDevice,
        reportId: ev.reportId,
        dataIsSame: ev.data === dv,
        instanceOf: ev instanceof HIDInputReportEvent
      }
    })
    expect(result.type).toBe('inputreport')
    expect(result.deviceIsSame).toBe(true)
    expect(result.reportId).toBe(1)
    expect(result.dataIsSame).toBe(true)
    expect(result.instanceOf).toBe(true)
  })

  test('data attribute is a DataView', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate<boolean>(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const buf = new ArrayBuffer(8)
      const dv = new DataView(buf)
      const ev = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 0,
        data: dv
      })
      return ev.data instanceof DataView
    })
    expect(result).toBe(true)
  })

  test('reportId ranges 0–255 (octet)', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate<{
      high: number
      low: number
      stringValue: number
      fractionalValue: number
      invalid: string[]
    }>(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const data = new DataView(new ArrayBuffer(1))
      const invalid = [Number.NaN, Number.POSITIVE_INFINITY, -1, 256].map((reportId) => {
        try {
          new HIDInputReportEvent('inputreport', {
            device: fakeDevice,
            reportId,
            data
          })
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
      return {
        high: new HIDInputReportEvent('inputreport', {
          device: fakeDevice,
          reportId: 255,
          data
        }).reportId,
        low: new HIDInputReportEvent('inputreport', {
          device: fakeDevice,
          reportId: 0,
          data
        }).reportId,
        stringValue: new HIDInputReportEvent('inputreport', {
          device: fakeDevice,
          reportId: '1',
          data
        }).reportId,
        fractionalValue: new HIDInputReportEvent('inputreport', {
          device: fakeDevice,
          reportId: 1.9,
          data
        }).reportId,
        invalid
      }
    })
    expect(result.high).toBe(255)
    expect(result.low).toBe(0)
    expect(result.stringValue).toBe(1)
    expect(result.fractionalValue).toBe(1)
    expect(result.invalid).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError'])
  })

  test('requires all HIDInputReportEvent init members', async ({ sharedPage }) => {
    const result = await sharedPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype) as HIDDevice
      const data = new DataView(new ArrayBuffer(1))
      const cases = [
        { reportId: 0, data },
        { device: fakeDevice, data },
        { device: fakeDevice, reportId: 0 }
      ]
      return cases.map((init) => {
        try {
          new HIDInputReportEvent('inputreport', init)
          return 'accepted'
        } catch (error) {
          return error instanceof Error ? error.name : String(error)
        }
      })
    })
    expect(result).toEqual(['TypeError', 'TypeError', 'TypeError'])
  })
})
