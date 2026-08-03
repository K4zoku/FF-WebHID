import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import base from './playwright.config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type PlaywrightUseOptions = Exclude<Parameters<typeof defineConfig>[0], undefined>['use']

export default defineConfig({
  ...base,
  workers: 1,
  projects: [
    {
      name: 'firefox-benchmark',
      testDir: './benchmark',
      testIgnore: ['**/chromium/**', '**/loss/**'],
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'daemon-nm',
        benchmarkRuns: 5,
        launchOptions: {
          firefoxUserPrefs: { 'privacy.reduceTimerPrecision': false }
        }
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
        benchmarkRuns: number
        launchOptions: { firefoxUserPrefs: { [key: string]: boolean } }
      }
    },
    {
      name: 'firefox-benchmark-loss',
      testDir: './benchmark/loss',
      use: {
        browserName: 'firefox',
        firefoxHarnessConfig: {
          extensionPath: resolve(__dirname, '..', 'addon')
        },
        daemonMode: 'daemon-nm',
        benchmarkRuns: 5,
        launchOptions: {
          firefoxUserPrefs: { 'privacy.reduceTimerPrecision': false }
        }
      } as PlaywrightUseOptions & {
        firefoxHarnessConfig: { extensionPath: string }
        daemonMode: string
        benchmarkRuns: number
        launchOptions: { firefoxUserPrefs: { [key: string]: boolean } }
      }
    },
    {
      name: 'chromium-benchmark',
      testDir: './benchmark/chromium',
      timeout: 600000,
      use: {
        browserName: 'chromium',
        headless: true,
        benchmarkRuns: 5
      } as PlaywrightUseOptions & { benchmarkRuns: number }
    }
  ]
})
