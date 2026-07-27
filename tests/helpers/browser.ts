import { test as base, expect, type Page } from '@playwright/test';
import type { TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../serve-policy.mjs';
import type { Server } from 'http';

const require = createRequire(import.meta.url);

interface FirefoxBgPage {
  evaluate: Page['evaluate'];
}

interface HarnessFixtures {
  backgroundPage: FirefoxBgPage;
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MAIN_PORT = 3080;
const CROSS_PORT = 3081;

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } };

const harnessTest: HarnessTestType = applyFirefoxHarness(base, {
  defaultRouteHandler: (route: { continue(): void }) => { route.continue(); },
});

interface CustomTestFixtures {
  mainPage: Page;
}

interface CustomWorkerFixtures {
  servers: Servers;
  pageUrl: (path: string) => string;
  crossUrl: (path: string) => string;
}

export const test = harnessTest.extend<CustomTestFixtures, CustomWorkerFixtures>({
  servers: [async ({}, use) => {
    const main = await startServer(MAIN_PORT);
    const cross = await startServer(CROSS_PORT);
    await use({ main, cross });
    main.server.close();
    cross.server.close();
  }, { scope: 'worker', auto: true }],

  mainPage: [async ({ page }, use) => {
    await use(page);
  }, { scope: 'test' }],

  pageUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${MAIN_PORT}${path}`);
  }, { scope: 'worker' }],

  crossUrl: [async ({}, use) => {
    await use((path: string) => `http://localhost:${CROSS_PORT}${path}`);
  }, { scope: 'worker' }],
});

export { expect };
