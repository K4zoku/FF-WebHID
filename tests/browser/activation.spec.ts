import { test, expect } from '../helpers/browser.js';

interface ActivationResult {
  ok: boolean;
  name?: string;
  message?: string;
}

interface ProbeResult {
  syncActive: boolean;
  expiredActive: boolean;
}

// Transient activation is time-based (~5s in Firefox), not task-based: any
// task within the window sees isActive=true, regardless of evaluate's
// synthetic gesture. The only reliable way to get a no-gesture call is to run
// requestDevice() after the window expires. The call itself must originate
// from served page source (tests/pages/activation.html): code created inside
// page.evaluate carries "debugger eval code" in its stack, which the
// polyfill's isCalledFromConsole() exemption treats as a console call and
// skips the activation check for.
test.describe('requestDevice user-activation gate', () => {
  let origin: string;
  const settingKey = () => `settings :: ${origin} :: allowActivationlessRequestDevice`;

  test.beforeAll(async ({ backgroundPage, servers }) => {
    origin = `http://localhost:${servers.main.port}`;
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey());
  });

  test('PROBE: activation expires after the ~5s window', async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/self-script'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result: ProbeResult = await sharedPage.evaluate(async () => {
      const syncActive = navigator.userActivation ? navigator.userActivation.isActive : false;
      const { promise, resolve } = Promise.withResolvers<ProbeResult>();
      setTimeout(() => {
        const expiredActive = navigator.userActivation ? navigator.userActivation.isActive : false;
        resolve({ syncActive, expiredActive });
      }, 6000);
      return promise;
    });
    expect(result.syncActive).toBe(true); // evaluate carries a synthetic gesture
    expect(result.expiredActive).toBe(false); // expired once the window passes
  });

  test('default: requestDevice() without a user gesture rejects with SecurityError', async ({
    sharedPage,
    pageUrl
  }) => {
    await sharedPage.goto(pageUrl('/activation'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result: ActivationResult = await sharedPage.evaluate(() =>
      window.tests.helper.requestDeviceWithoutGesture(6000)
    );
    expect(result.ok).toBe(false);
    expect(result.name).toBe('SecurityError');
    expect(result.message).toContain('user gesture');
  });

  test('allowActivationlessRequestDevice: no SecurityError without a gesture', async ({
    backgroundPage,
    sharedPage,
    pageUrl
  }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.set({ [key]: true }), settingKey());
    await sharedPage.goto(pageUrl('/activation'), { waitUntil: 'domcontentloaded', timeout: 15000 });
    const result = await sharedPage.evaluate(async () => {
      let settled: string | null = null;
      window.tests.helper.requestDeviceWithoutGesture(6000).then((r: ActivationResult) => {
        settled = r.ok ? 'resolved' : 'rejected:' + r.name;
      });
      await new Promise((r) => setTimeout(r, 6800));
      return { settled };
    });
    // The chooser opens and waits for user selection; the call must NOT be
    // rejected with SecurityError merely because there is no gesture.
    expect(result.settled ?? '').not.toContain('SecurityError');
    // Dismiss the open modal chooser (Escape closes the <dialog>) so the test
    // leaves no dangling picker behind.
    await sharedPage.keyboard.press('Escape');
  });

  test.afterAll(async ({ backgroundPage }) => {
    await backgroundPage.evaluate((key) => browser.storage.local.remove(key), settingKey());
  });
});
