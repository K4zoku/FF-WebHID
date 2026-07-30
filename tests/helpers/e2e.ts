import { test as base, type Page, expect } from '@playwright/test';
import type { TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { createRequire } from 'module';
import { startStaticServer } from '../serve.js';
import {
  startDaemon, stopDaemon,
  startWebhidMock, stopWebhidMock,
  installNmManifest, uninstallNmManifest, DEFAULT_SOCKET,
  type DaemonProcess, type WebhidMockProcess,
} from './e2e-process.js';
import type { WebHidTestAPI, DeviceFilter } from './e2e-types.js';

const require = createRequire(import.meta.url);

interface HarnessFixtures {
  backgroundPage: { evaluate: Page['evaluate'] };
  firefoxHarnessConfig: { extensionPath: string; postInstallPages?: (string | RegExp)[] };
  rdpPort: number;
}

type HarnessTestType = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & HarnessFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

const { applyFirefoxHarness } = require('firefox-webext-playwright-harness') as {
  applyFirefoxHarness: (
    test: typeof base,
    opts?: { defaultRouteHandler?: (route: { continue(): void }) => void },
  ) => HarnessTestType;
};
function createTestApi(page: Page): WebHidTestAPI {
  return {
    isPolyfillLoaded: () =>
      page.evaluate(() => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.isPolyfillLoaded()),
    getDevices: () =>
      page.evaluate(() => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.getDevices()),
    requestDevice: (filters?: DeviceFilter[]) =>
      page.evaluate((f: DeviceFilter[]) => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.requestDevice(f), filters ?? []),
    deviceInfo: (index: number) =>
      page.evaluate((i: number) => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.deviceInfo(i), index),
    open: (index: number) =>
      page.evaluate((i: number) => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.open(i), index),
    close: (index: number) =>
      page.evaluate((i: number) => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.close(i), index),
    sendReport: (index: number, reportId: number, data: number[]) =>
      page.evaluate(
        (args: { i: number; rId: number; arr: number[] }) =>
          (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.sendReport(args.i, args.rId, args.arr),
        { i: index, rId: reportId, arr: data },
      ),
    onInputReport: (index: number) =>
      page.evaluate((i: number) => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.onInputReport(i), index),
    resetDeviceState: () =>
      page.evaluate(() => (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest.resetDeviceState()),
  };
}

const harnessTest: HarnessTestType = applyFirefoxHarness(base, {
  defaultRouteHandler: (route: { continue(): void }) => route.continue(),
});

interface E2eTestFixtures {
  sharedPage: Page;
  testApi: WebHidTestAPI;
  beforeEach: void;
}

interface E2eWorkerFixtures {
  daemon: DaemonProcess;
  webhidMock: WebhidMockProcess;
  httpPort: number;
  nmManifest: void;
}

export const test = harnessTest.extend<E2eTestFixtures, E2eWorkerFixtures>({
  daemon: [async ({}, use) => {
    const d = await startDaemon();
    await use(d);
    stopDaemon(d);
  }, { scope: 'worker', auto: true }],

  webhidMock: [async ({}, use) => {
    const m = startWebhidMock('switchpro-gamepad.bin', 0x16c0, 0x0001);
    await m.ready;
    await use(m);
    stopWebhidMock(m);
  }, { scope: 'worker', auto: true }],

  httpPort: [async ({}, use) => {
    const { port, server } = await startStaticServer();
    await use(port);
    server.close();
  }, { scope: 'worker', auto: true }],

  nmManifest: [async ({}, use) => {
    installNmManifest(DEFAULT_SOCKET);
    await use();
    uninstallNmManifest();
  }, { scope: 'worker', auto: true }],

  sharedPage: [async ({ page, httpPort }, use) => {
    const url = `http://localhost:${httpPort}/tests/test-page.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(
      () => typeof (window as unknown as Window & { __webhidTest: WebHidTestAPI }).__webhidTest !== 'undefined',
      { timeout: 15000 },
    );
    await use(page);
  }, { scope: 'test' }],

  testApi: [async ({ sharedPage }, use) => {
    await use(createTestApi(sharedPage));
  }, { scope: 'test' }],

  beforeEach: [async ({}, use) => {
    await use();
  }, { scope: 'test', auto: true }],
});

export { expect };
