import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type PlaywrightUseOptions = Exclude<Parameters<typeof defineConfig>[0], undefined>['use'];

export default defineConfig({
  timeout: 120000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  globalSetup: 'firefox-webext-playwright-harness/globalSetup',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'firefox-browser',
      testDir: './browser',
      use: { browserName: 'firefox' },
    },
    {
      name: 'firefox-e2e',
      testDir: './e2e',
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon'),
        },
      } as PlaywrightUseOptions & { firefoxHarnessConfig: { extensionPath: string } },
    },
  ],
});
