import { test, expect } from '../helpers/browser.js';

test.describe('Worker WebHID API', () => {

  let storageSet = false;

  test.beforeEach(async ({ backgroundPage, servers }) => {
    if (!storageSet) {
      const origin = `http://localhost:${servers.main.port}`;
      await backgroundPage.evaluate((origin) => browser.storage.local.set({
        [`settings :: ${origin} :: workerPolyfillEnabled`]: true,
      }), origin);
      await backgroundPage.evaluate((origin) => browser.storage.local.get(`settings :: ${origin} :: workerPolyfillEnabled`), origin);
      storageSet = true;
    }
  });

  test('Standard WebHID API surface in worker', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    const raw = await sharedPage.evaluate(async () => {
      const ts = Date.now();
      const w = new Worker('/worker.js?_=' + ts);
      const result = await new Promise((resolve, reject) => {
        w.onmessage = (e: MessageEvent) => resolve(e.data);
        w.onerror = (e: any) => reject(e.message || e.error?.message || String(e));
        setTimeout(() => reject('timeout'), 10000);
      });
      w.terminate();
      return result;
    });

    expect(raw).not.toBeNull();
    expect(raw!.hasNavigatorHid).toBe(true);
    expect(raw!.hasHID).toBe(true);
    expect(raw!.hasHIDDevice).toBe(true);
    expect(raw!.hasHIDInputReportEvent).toBe(true);
    expect(raw!.hasHIDConnectionEvent).toBe(true);
    expect(raw!.hidToStringTag).toBe('[object HID]');
    expect(raw!.getDevicesResult.ok).toBe(true);
    expect(raw!.requestDeviceError.ok).toBe(false);
    expect(raw!.requestDeviceError.name).toBe('NotSupportedError');
    expect(raw!.illegalConstructor.ok).toBe(false);
    expect(raw!.illegalConstructor.name).toBe('TypeError');
  });

});
