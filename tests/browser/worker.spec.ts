import { test, expect } from '../helpers/browser.js';

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
        w.onerror = (e: ErrorEvent) => reject(new Error(e.message));
        setTimeout(() => reject(new Error('timeout')), 10000);
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

test.describe('Worker polyfill gating', () => {

  interface PlainWorkerResult {
    gotNull: boolean;
    data: { hello?: boolean } | null;
  }

  test('worker without workerPolyfill receives no init message', async ({ page, crossUrl }) => {
    await page.goto(crossUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const raw = await page.evaluate<PlainWorkerResult>(async () => {
      const w = new Worker('/worker-plain.js');
      const resultPromise = new Promise((resolve, reject) => {
        w.onmessage = (e) => resolve(e.data);
        w.onerror = (e) => reject(new Error(e.message));
        setTimeout(() => reject(new Error('timeout')), 10000);
      });
      w.postMessage({ hello: true });
      return resultPromise as Promise<PlainWorkerResult>;
    });
    expect(raw.gotNull).toBe(false);
    expect(raw.data!.hello).toBe(true);
  });

  test('blob worker gets no init message even with workerPolyfill on', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const raw = await page.evaluate<PlainWorkerResult>(async () => {
      const url = URL.createObjectURL(
        new Blob(['self.onmessage = (e) => self.postMessage({ gotNull: e.data === null, data: e.data })'])
      );
      const w = new Worker(url);
      const resultPromise = new Promise((resolve, reject) => {
        w.onmessage = (e) => resolve(e.data);
        w.onerror = (e) => reject(new Error(e.message));
        setTimeout(() => reject(new Error('timeout')), 10000);
      });
      w.postMessage({ hello: true });
      return resultPromise as Promise<PlainWorkerResult>;
    });
    expect(raw.gotNull).toBe(false);
    expect(raw.data!.hello).toBe(true);
  });

  test('live workerPolyfill toggle updates the worker init decision', async ({ page, crossUrl, backgroundPage }) => {
    await page.goto(crossUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await backgroundPage.evaluate((origin) => browser.storage.local.set({
      [`settings :: ${origin} :: workerPolyfillEnabled`]: true,
    }), crossUrl(''));
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      const r = await page.evaluate(async () => {
        const w = new Worker('/worker-polyfilled.js?_=' + Date.now());
        const resultPromise = new Promise((resolve) => {
          w.onmessage = (e) => resolve(e.data);
          w.onerror = () => resolve({ ok: false });
          setTimeout(() => resolve({ ok: false }), 2000);
        });
        const result = await resultPromise;
        w.terminate();
        return result as { ok: boolean };
      });
      if (r.ok) {
        ok = true;
      } else {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(ok).toBe(true);
  });

});
