import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import base from './playwright.config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type PlaywrightUseOptions = Exclude<Parameters<typeof defineConfig>[0], undefined>['use']

export default defineConfig({
  ...base,
  // Forwarder-mode chain (root daemon + thin NM forwarder over the Unix
  // socket, the no-udev deployment): run explicitly via `npm run test:e2e`,
  // not part of the default suite. One worker: two heavy Firefox+daemon
  // stacks in parallel drop WS input reports (see AGENTS.md).
  workers: 1,
  projects: [
    {
      name: 'firefox-e2e-forwarder',
      testDir: './e2e',
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'forwarder'
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
      }
    }
  ]
})
