import { test, expect } from '../helpers/browser.js';
import "../types/webhid.js";
import "../types/webext.js";

interface WorkerResult {
  hasNavigatorHid: boolean;
  hasHID: boolean;
  hasHIDDevice: boolean;
  hasHIDInputReportEvent: boolean;
  hasHIDConnectionEvent: boolean;
  hidToStringTag: string;
  getDevicesResult: { ok: boolean };
  requestDeviceError: { ok: boolean; name?: string; message?: string };
  illegalConstructor: { ok: boolean; name?: string; message?: string };
}

test.describe('Worker WebHID API', () => {

  let storageSet = false;
  let raw: WorkerResult;
  test.beforeAll(async ({ backgroundPage, sharedPage, pageUrl, servers }) => {
    if (!storageSet) {
      const origin = `http://localhost:${servers.main.port}`;
      await backgroundPage.evaluate((origin) => browser.storage.local.set({
        [`settings :: ${origin} :: workerPolyfillEnabled`]: true,
      }), origin);
      storageSet = true;
    }

    await sharedPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    raw = await sharedPage.evaluate(async () => {
      const ts = Date.now();
      const w = new Worker('/worker.js?_=' + ts);
      const result = await new Promise((resolve, reject) => {
        w.onmessage = (e: MessageEvent) => resolve(e.data);
        w.onerror = (e: ErrorEvent) => reject(e.message || e.error?.message || String(e));
        setTimeout(() => reject('timeout'), 10000);
      });
      w.terminate();
      return result as WorkerResult;
    });
  });

  test('worker returns a result', () => {
    expect(raw).not.toBeNull();
  });

  test('navigator.hid exists in worker', () => {
    expect(raw.hasNavigatorHid).toBe(true);
  });

  test('HID class exists in worker', () => {
    expect(raw.hasHID).toBe(true);
  });

  test('HIDDevice class exists in worker', () => {
    expect(raw.hasHIDDevice).toBe(true);
  });

  test('HIDInputReportEvent class exists in worker', () => {
    expect(raw.hasHIDInputReportEvent).toBe(true);
  });

  test('HIDConnectionEvent class exists in worker', () => {
    expect(raw.hasHIDConnectionEvent).toBe(true);
  });

  test('navigator.hid.toString() tag in worker', () => {
    expect(raw.hidToStringTag).toBe('[object HID]');
  });

  test('getDevices() resolves in worker', () => {
    expect(raw.getDevicesResult.ok).toBe(true);
  });

  test('requestDevice() rejects with NotSupportedError in worker', () => {
    expect(raw.requestDeviceError.ok).toBe(false);
    expect(raw.requestDeviceError.name).toBe('NotSupportedError');
  });

  test('new HID() throws TypeError in worker', () => {
    expect(raw.illegalConstructor.ok).toBe(false);
    expect(raw.illegalConstructor.name).toBe('TypeError');
  });

});
