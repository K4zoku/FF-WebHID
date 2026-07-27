import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type PlaywrightUseOptions = Exclude<Parameters<typeof defineConfig>[0], undefined>['use'];
type UseWithHarness = PlaywrightUseOptions & {
  firefoxHarnessConfig: { extensionPath: string };
};

export default defineConfig({
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  globalSetup: 'firefox-webext-playwright-harness/globalSetup',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    firefoxHarnessConfig: {
      extensionPath: resolve(__dirname, '..', 'addon'),
    },
  } as UseWithHarness,
  projects: [
    {
      name: 'firefox-browser',
      testDir: './tests/browser',
      use: { browserName: 'firefox' },
    },
    {
      name: 'firefox-e2e',
      testDir: './tests/e2e',
      use: { browserName: 'firefox' },
    },
  ],
});
