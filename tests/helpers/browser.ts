import { test as base, expect, type Page } from '@playwright/test'
import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions
} from '@playwright/test'
import { startPolicyServer } from '../serve.js'
import type { Server } from 'http'
import {
  backgroundPageFixture,
  baseSharedPage,
  harnessCtxBody,
  pageFixture,
  rdpPortFixture,
  type FirefoxBgPage,
  type HarnessContext
} from './harness.js'

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } }

export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs &
    PlaywrightWorkerOptions & {
      servers: Servers
      pageUrl: (path: string) => string
      crossUrl: (path: string) => string
      harnessCtx: HarnessContext
      rdpPort: number
      backgroundPage: FirefoxBgPage
      sharedPage: Page
    }
>({
  servers: [
    async ({}, use) => {
      const main = await startPolicyServer()
      const cross = await startPolicyServer()
      await use({ main, cross })
      main.server.close()
      cross.server.close()
    },
    { scope: 'worker', auto: true }
  ],

  rdpPort: rdpPortFixture(),

  harnessCtx: [
    async ({ rdpPort, headless }, use) => {
      await harnessCtxBody({ rdpPort, headless }, use, { catchAllRoute: true })
    },
    { scope: 'worker' }
  ],

  backgroundPage: backgroundPageFixture(),

  sharedPage: [
    async ({ harnessCtx }, use) => {
      await use(await baseSharedPage(harnessCtx))
    },
    { scope: 'worker' }
  ],

  page: pageFixture(),

  pageUrl: [
    async ({ servers }, use) => {
      await use((path: string) => `http://localhost:${servers.main.port}${path}`)
    },
    { scope: 'worker' }
  ],

  crossUrl: [
    async ({ servers }, use) => {
      await use((path: string) => `http://localhost:${servers.cross.port}${path}`)
    },
    { scope: 'worker' }
  ]
})

export { expect }
