import { test, expect } from '../../helpers/browser.js';

test.describe('HIDDevice class', () => {

  test('HIDDevice constructor throws TypeError (Illegal constructor)', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      try {
        new HIDDevice();
        return { ok: true, name: '' } as const;
      } catch (e: unknown) {
        return { ok: false, name: e instanceof Error ? e.name : String(e) } as const;
      }
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe('TypeError');
  });

  test('HIDDevice.prototype has all six methods', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const methods = await mainPage.evaluate(() => {
      const proto = HIDDevice.prototype;
      return {
        open: typeof proto.open,
        close: typeof proto.close,
        forget: typeof proto.forget,
        sendReport: typeof proto.sendReport,
        sendFeatureReport: typeof proto.sendFeatureReport,
        receiveFeatureReport: typeof proto.receiveFeatureReport,
      };
    });
    expect(methods.open).toBe('function');
    expect(methods.close).toBe('function');
    expect(methods.forget).toBe('function');
    expect(methods.sendReport).toBe('function');
    expect(methods.sendFeatureReport).toBe('function');
    expect(methods.receiveFeatureReport).toBe('function');
  });

  test('opened getter is defined on HIDDevice.prototype', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const desc = Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'opened');
      return { hasGetter: typeof desc?.get === 'function', enumerable: desc?.enumerable };
    });
    expect(result.hasGetter).toBe(true);
    expect(result.enumerable).toBe(false);
  });

  test('oninputreport getter/setter is defined on HIDDevice.prototype', async ({ mainPage, pageUrl }) => {
    await mainPage.goto(pageUrl('/policy-check'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await mainPage.evaluate(() => {
      const desc = Object.getOwnPropertyDescriptor(HIDDevice.prototype, 'oninputreport');
      return { hasGetter: typeof desc?.get === 'function', hasSetter: typeof desc?.set === 'function' };
    });
    expect(result.hasGetter).toBe(true);
    expect(result.hasSetter).toBe(true);
  });

});
