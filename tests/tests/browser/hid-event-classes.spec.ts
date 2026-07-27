import { test, expect } from '../../helpers/browser.js';

test.describe('HIDConnectionEvent', () => {

  test('new HIDConnectionEvent("connect", { device }) creates an instance', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype);
      const ev = new HIDConnectionEvent('connect', { device: fakeDevice });
      return {
        type: ev.type,
        deviceIsSame: ev.device === fakeDevice,
        instanceOf: ev instanceof HIDConnectionEvent,
        instanceOfEvent: ev instanceof Event,
      };
    });
    expect(result.type).toBe('connect');
    expect(result.deviceIsSame).toBe(true);
    expect(result.instanceOf).toBe(true);
    expect(result.instanceOfEvent).toBe(true);
  });

  test('new HIDConnectionEvent("disconnect", { device }) is also constructable', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype);
      const ev = new HIDConnectionEvent('disconnect', { device: fakeDevice });
      return { type: ev.type, deviceIsSame: ev.device === fakeDevice };
    });
    expect(result.type).toBe('disconnect');
    expect(result.deviceIsSame).toBe(true);
  });

});

test.describe('HIDInputReportEvent', () => {

  test('new HIDInputReportEvent("inputreport", { device, reportId, data }) creates an instance', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype);
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      const ev = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 1,
        data: dv,
      });
      return {
        type: ev.type,
        deviceIsSame: ev.device === fakeDevice,
        reportId: ev.reportId,
        dataIsSame: ev.data === dv,
        instanceOf: ev instanceof HIDInputReportEvent,
      };
    });
    expect(result.type).toBe('inputreport');
    expect(result.deviceIsSame).toBe(true);
    expect(result.reportId).toBe(1);
    expect(result.dataIsSame).toBe(true);
    expect(result.instanceOf).toBe(true);
  });

  test('data attribute is a DataView', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype);
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      const ev = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 0,
        data: dv,
      });
      return ev.data instanceof DataView;
    });
    expect(result).toBe(true);
  });

  test('reportId ranges 0–255 (octet)', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const fakeDevice = Object.create(HIDDevice.prototype);
      const buf = new ArrayBuffer(1);
      const dv = new DataView(buf);
      const ev = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 255,
        data: dv,
      });
      const ev2 = new HIDInputReportEvent('inputreport', {
        device: fakeDevice,
        reportId: 0,
        data: dv,
      });
      return { high: ev.reportId, low: ev2.reportId };
    });
    expect(result.high).toBe(255);
    expect(result.low).toBe(0);
  });

});
