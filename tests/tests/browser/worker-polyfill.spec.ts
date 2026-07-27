import { test, expect } from '../../helpers/browser.js';

test.describe('Worker Polyfill', () => {

  test.beforeEach(async ({ backgroundPage }) => {
    await backgroundPage.evaluate(() => browser.storage.local.set({
      'site:http://localhost:3080': { workerPolyfillEnabled: true },
    }));
    await backgroundPage.evaluate(() => browser.storage.local.get('site:http://localhost:3080'));
  });

  test('WebHID API surface is available in worker', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/worker-polyfill-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    await mainPage.waitForFunction(
      () => {
        const el = document.getElementById('__worker-polyfill-result');
        return el && el.textContent && el.textContent !== 'waiting...';
      },
      { timeout: 10000 },
    );

    const raw = await mainPage.evaluate(() => {
      const el = document.getElementById('__worker-polyfill-result');
      if (!el || !el.textContent) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    expect(raw).not.toBeNull();
    expect(raw!.hasNavigatorHid).toBe(true);
    expect(raw!.hasHID).toBe(true);
    expect(raw!.hasHIDDevice).toBe(true);
    expect(raw!.hasHIDInputReportEvent).toBe(true);
    expect(raw!.hasHIDConnectionEvent).toBe(true);
    expect(raw!.hidToStringTag).toBe('[object HID]');
  });

  test('method stubs throw NotSupportedError', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/worker-polyfill-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    await mainPage.waitForFunction(
      () => {
        const el = document.getElementById('__worker-polyfill-result');
        return el && el.textContent && el.textContent !== 'waiting...';
      },
      { timeout: 10000 },
    );

    const raw = await mainPage.evaluate(() => {
      const el = document.getElementById('__worker-polyfill-result');
      if (!el || !el.textContent) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    expect(raw).not.toBeNull();
    expect(raw!.getDevicesError.ok).toBe(false);
    expect(raw!.getDevicesError.name).toBe('NotSupportedError');
    expect(raw!.requestDeviceError.ok).toBe(false);
    expect(raw!.requestDeviceError.name).toBe('NotSupportedError');
  });

  test('HID constructor throws TypeError (Illegal constructor)', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/worker-polyfill-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    await mainPage.waitForFunction(
      () => {
        const el = document.getElementById('__worker-polyfill-result');
        return el && el.textContent && el.textContent !== 'waiting...';
      },
      { timeout: 10000 },
    );

    const raw = await mainPage.evaluate(() => {
      const el = document.getElementById('__worker-polyfill-result');
      if (!el || !el.textContent) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    expect(raw).not.toBeNull();
    expect(raw!.illegalConstructor.ok).toBe(false);
    expect(raw!.illegalConstructor.name).toBe('TypeError');
  });

  test('"use strict" prologue is preserved after polyfill prepend', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/worker-polyfill-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });

    await mainPage.waitForFunction(
      () => {
        const el = document.getElementById('__worker-strict-result');
        return el && el.textContent && el.textContent !== 'waiting...';
      },
      { timeout: 10000 },
    );

    const raw = await mainPage.evaluate(() => {
      const el = document.getElementById('__worker-strict-result');
      if (!el || !el.textContent) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    });

    expect(raw).not.toBeNull();
    expect(raw!.strictMode).toBe(true);
    expect(raw!.hasNavigatorHid).toBe(true);
    expect(raw!.hasHID).toBe(true);
  });

});
