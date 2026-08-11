import { test as base, expect, type Page, type WorkerFixture } from '@playwright/test'
import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions
} from '@playwright/test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { rm } from 'fs/promises'
import { startStaticServer } from '../serve.js'
import {
  startDaemon,
  stopDaemon,
  startWebhidMock,
  stopWebhidMock,
  installNmManifest,
  uninstallNmManifest,
  installDaemonNmManifest,
  uninstallDaemonNmManifest,
  workerSocketPath,
  type DaemonProcess,
  type WebhidMockProcess
} from './e2e-process.js'
import { DEVICES, type DeviceKey } from './e2e-devices.js'
import {
  backgroundPageFixture,
  baseSharedPage,
  harnessCtxBody,
  pageFixture,
  rdpPortFixture,
  type FirefoxBgPage,
  type HarnessContext
} from './harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface E2eWorkerFixtures {
  daemon: DaemonProcess | null
  vendorDevice: MockDeviceFixture
  gamepadDevice: MockDeviceFixture
  httpPort: number
  nmManifest: void
  daemonMode: string
  rdpPort: number
  harnessCtx: HarnessContext
  backgroundPage: FirefoxBgPage
  sharedPage: Page
}

interface MockDeviceFixture {
  process: WebhidMockProcess['process']
  ready: Promise<void>
  vid: number
  pid: number
  descriptorPath: string
  key: DeviceKey
}

/** Configures the addon to spawn the daemon as its NM host when running in
 * daemon-nm mode (no-op in forwarder mode). */
export async function configureDaemonMode(
  backgroundPage: { evaluate: Page['evaluate'] },
  daemonMode: string
): Promise<void> {
  if (daemonMode !== 'daemon-nm') return
  await backgroundPage
    .evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))
    .catch(() => {})
}

function deviceFixture(
  key: DeviceKey
): Record<string, [WorkerFixture<MockDeviceFixture, object>, { scope: 'worker' }]> {
  const def = DEVICES[key]
  const descriptorPath = resolve(__dirname, '..', 'fixtures', 'descriptors', def.descriptor)
  return {
    [`${key}Device`]: [
      async ({}, use) => {
        const m = startWebhidMock(def.descriptor, def.vid, def.pid)
        await m.ready
        const live: MockDeviceFixture = {
          process: m.process,
          ready: m.ready,
          vid: def.vid,
          pid: def.pid,
          descriptorPath,
          key
        }
        await use(live)
        stopWebhidMock({ process: live.process, ready: live.ready })
      },
      { scope: 'worker' as const }
    ]
  }
}

const deviceFixtures = {
  ...deviceFixture('vendor'),
  ...deviceFixture('gamepad')
}

export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & E2eWorkerFixtures
>({
  daemonMode: [
    async ({}, use) => {
      const projectUse = test.info().project?.use as { daemonMode?: string } | undefined
      const mode = projectUse?.daemonMode || 'forwarder'
      await use(mode)
    },
    { scope: 'worker', option: true }
  ],

  daemon: [
    async ({ daemonMode }, use, workerInfo) => {
      if (daemonMode === 'forwarder') {
        await use(null)
        return
      }
      const socketPath = workerSocketPath(workerInfo.workerIndex)
      process.env.WEBHID_SOCKET = socketPath
      process.env.WEBHID_LOG_FILE = socketPath.replace(/\.sock$/, '.log')
      const d = await startDaemon(socketPath)
      await use(d)
      stopDaemon(d)
      await rm(socketPath, { force: true })
    },
    { scope: 'worker', auto: true }
  ],

  ...deviceFixtures,

  httpPort: [
    async ({}, use) => {
      const { port, server } = await startStaticServer()
      await use(port)
      server.close()
    },
    { scope: 'worker', auto: true }
  ],

  nmManifest: [
    async ({ daemonMode }, use) => {
      if (daemonMode === 'daemon-nm') {
        installDaemonNmManifest()
        await use()
        uninstallDaemonNmManifest()
      } else {
        installNmManifest()
        await use()
        uninstallNmManifest()
      }
    },
    { scope: 'worker', auto: true }
  ],

  rdpPort: rdpPortFixture(),

  harnessCtx: [
    async ({ rdpPort, headless }, use) => {
      const projectUse = test.info().project?.use as { launchOptions?: object } | undefined
      await harnessCtxBody({ rdpPort, headless }, use, {
        launchOptions: projectUse?.launchOptions
      })
    },
    { scope: 'worker' }
  ],

  backgroundPage: backgroundPageFixture(),

  sharedPage: [
    async ({ harnessCtx, httpPort, daemonMode, backgroundPage }, use) => {
      await configureDaemonMode(backgroundPage, daemonMode)
      const page = await baseSharedPage(harnessCtx)
      const url = `http://localhost:${httpPort}/tests/test-page.html`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
      await use(page)
    },
    { scope: 'worker' }
  ],

  page: pageFixture()
})

export { expect }
