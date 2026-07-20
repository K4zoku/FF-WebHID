import { test, expect } from '../helpers/fixtures.js';

test.describe('Addon handshake and polyfill', () => {
  test('navigator.hid is polyfilled', async ({ testApi }) => {
    const loaded = await testApi.isPolyfillLoaded();
    expect(loaded).toBe(true);
  });

  test('getDevices is a function', async ({ sharedPage }) => {
    const isFn = await sharedPage.evaluate(
      () => typeof navigator.hid.getDevices === 'function',
    );
    expect(isFn).toBe(true);
  });

  test('getDevices returns an array', async ({ testApi }) => {
    const devices = await testApi.getDevices();
    expect(Array.isArray(devices)).toBe(true);
  });

  test('requestDevice is a function', async ({ sharedPage }) => {
    const isFn = await sharedPage.evaluate(
      () => typeof navigator.hid.requestDevice === 'function',
    );
    expect(isFn).toBe(true);
  });
});
