import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..', '..');

export default defineConfig({
  testDir: './tests',
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
      extensionPath: resolve(__dirname, '..', '..', 'addon'),
    },
  },
  projects: [
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
      },
    },
  ],
});
