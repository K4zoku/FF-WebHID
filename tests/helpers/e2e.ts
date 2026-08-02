import { test as base, expect, type Page, type BrowserContext, type WorkerFixture } from '@playwright/test'
import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions
} from '@playwright/test'
import { createRequire } from 'module'
import { rm } from 'fs/promises'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
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

const require = createRequire(import.meta.url)

const harnessRoot = require.resolve('firefox-webext-playwright-harness')
const harnessDir = dirname(harnessRoot)

interface FirefoxBgPage {
  evaluate: Page['evaluate']
}

interface FirefoxWebServer {
  registerRoute(pattern: string, handler: (route: { continue(): void }) => void): void
  unregisterRoute(pattern: string, handler: (route: { continue(): void }) => void): void
  clearRoutes(): void
}

interface NetworkEventBridge {
  dispose(): void
}

interface HarnessContext extends BrowserContext {
  _firefoxBgPage: FirefoxBgPage
  _firefoxBridge: NetworkEventBridge
  _firefoxWebServer: FirefoxWebServer
  _rdpClient: unknown
  _firefoxBackgroundConsoleActor: unknown
  newPage(): Promise<Page>
}

interface RdpPortHandle {
  port: number
  release: () => Promise<void>
}

interface CreateFirefoxContextOptions {
  routeHandler?: (route: { continue(): void }) => void
  playwrightOptions?: { headless?: boolean }
}

type RouteHandler = (route: { continue(): void }) => void

const { acquireRdpPort } = require(`${harnessDir}/rdp-port.js`) as {
  acquireRdpPort: (opts?: { maxAttempts?: number }) => Promise<RdpPortHandle>
}
const { createFirefoxContext, cleanupFirefoxContext, FirefoxBackgroundPage } = require(
  `${harnessDir}/harness.js`
) as {
  createFirefoxContext: (
    rdpPort: number,
    extensionPath: string,
    options?: CreateFirefoxContextOptions
  ) => Promise<{ context: HarnessContext }>
  cleanupFirefoxContext: (context: HarnessContext) => Promise<void>
  FirefoxBackgroundPage: new (rdpClient: unknown, consoleActor: unknown) => FirefoxBgPage
}
const { NetworkEventBridge } = require(`${harnessDir}/network-bridge.js`) as {
  NetworkEventBridge: new (firefoxWebServer: FirefoxWebServer) => NetworkEventBridge
}
const { wrapWithNetworkBridge } = require(`${harnessDir}/proxies.js`) as {
  wrapWithNetworkBridge: <T>(
    target: T,
    bridge: NetworkEventBridge,
    opts?: {
      onRoute?: (pattern: string, handler: RouteHandler) => void
      onUnroute?: (pattern: string, handler: RouteHandler) => void
      onUnrouteAll?: () => void
    }
  ) => T
}
const { installAddScriptTagPatch } = require(`${harnessDir}/script-tag.js`) as {
  installAddScriptTagPatch: (page: Page) => void
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const defaultRouteHandler: RouteHandler = (route) => {
  route.continue()
}

const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(__dirname, '..', '..', 'addon')

interface E2eWorkerFixtures {
  daemon: DaemonProcess | null
  vendorDevice: MockDeviceFixture
  gamepadDevice: MockDeviceFixture
  mouseDevice: MockDeviceFixture
  keyboardDevice: MockDeviceFixture
  httpPort: number
  nmManifest: void
  daemonMode: string
  rdpPort: number
  harnessCtx: HarnessContext
  backgroundPage: FirefoxBgPage
  sharedPage: Page
}

// The surface a test sees for one generated mock device. `process`/`ready`
// are mutable so a test can hot-plug (destroy + respawn) and hand the new
// process back; the fixture teardown stops whatever is current.
interface MockDeviceFixture {
  process: WebhidMockProcess['process']
  ready: Promise<void>
  vid: number
  pid: number
  descriptorPath: string
  key: DeviceKey
}

// Builds the worker fixtures `vendorDevice`, `gamepadDevice`, `mouseDevice`,
// `keyboardDevice` from the DEVICES table. Lazy: the mock is spawned the
// first time a test resolves the fixture and stays alive until the worker
// ends, so the paired device is reused across the serial chain. Teardown
// stops the current process, surviving a hot-plug swap from the disconnect
// test (stopWebhidMock tolerates an already-dead process).
function deviceFixture(key: DeviceKey): Record<string, [WorkerFixture<MockDeviceFixture, any>, { scope: 'worker' }]> {
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
  ...deviceFixture('gamepad'),
  ...deviceFixture('mouse'),
  ...deviceFixture('keyboard')
}


export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & E2eWorkerFixtures
>({
  daemonMode: [
    async ({}, use) => {
      // Custom worker option injected via the project's `use` block in
      // playwright.config.ts; Playwright's Project type doesn't declare it.
      const projectUse = test.info().project?.use as { daemonMode?: string } | undefined
      const mode = projectUse?.daemonMode || 'forwarder'
      await use(mode)
    },
    { scope: 'worker', option: true }
  ],

  daemon: [
    async ({ daemonMode }, use, workerInfo) => {
      if (daemonMode === 'daemon-nm') {
        await use(null)
        return
      }
      // Unique socket per worker so parallel daemons don't fight over one bind.
      // The NM forwarder discovers it via WEBHID_SOCKET, which the test Firefox
      // (and thus the forwarder it spawns) inherits from this worker process.
      const socketPath = workerSocketPath(workerInfo.workerIndex)
      process.env.WEBHID_SOCKET = socketPath
      const d = await startDaemon(socketPath)
      await use(d)
      stopDaemon(d)
      await rm(socketPath, { force: true })
    },
    { scope: 'worker', auto: true }
  ],

  // Lazy per-device mock registry. Each generated descriptor spawns its own
  // mock device (own PID from DEVICES) on first use and is torn down when the
  // worker ends. Devices are spawned on demand, not up front: a worker that
  // only touches the vendor device never pays for a gamepad mock.
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

  rdpPort: [
    async ({}, use) => {
      const { port, release } = await acquireRdpPort()
      try {
        await use(port)
      } finally {
        await release()
      }
    },
    { scope: 'worker' }
  ],

  // One Firefox instance + profile per worker (same pattern as
  // tests/helpers/browser.ts). The WebHID grant lives in the profile, so
  // pairing once at the start of the serial chain persists for every test in
  // the worker. applyFirefoxHarness is deliberately not used here: its
  // context/page fixtures are test-scoped (fresh profile per test), which is
  // exactly the per-test re-pairing this avoids.
  harnessCtx: [
    async ({ rdpPort, headless }, use) => {
      const { context } = await createFirefoxContext(rdpPort, EXTENSION_PATH, {
        routeHandler: defaultRouteHandler,
        playwrightOptions: { headless }
      })

      let bridge: NetworkEventBridge | undefined
      let onRoute: ((pattern: string, handler: RouteHandler) => void) | undefined
      let onUnroute: ((pattern: string, handler: RouteHandler) => void) | undefined
      let onUnrouteAll: (() => void) | undefined
      try {
        await context.route('**/*', defaultRouteHandler)

        bridge = new NetworkEventBridge(context._firefoxWebServer)
        context._firefoxBridge = bridge

        context._firefoxBgPage = new FirefoxBackgroundPage(
          context._rdpClient,
          context._firefoxBackgroundConsoleActor
        )

        onRoute = (pattern, handler) => {
          if (typeof pattern !== 'string') return
          context._firefoxWebServer.registerRoute(pattern, handler)
        }
        onUnroute = (pattern, handler) => {
          if (typeof pattern !== 'string') return
          context._firefoxWebServer.unregisterRoute(pattern, handler)
        }
        onUnrouteAll = () => {
          context._firefoxWebServer.clearRoutes()
        }
      } catch (err) {
        bridge?.dispose()
        await cleanupFirefoxContext(context)
        throw err
      }

      await use(wrapWithNetworkBridge(context, bridge, { onRoute, onUnroute, onUnrouteAll }))

      bridge.dispose()
      await cleanupFirefoxContext(context)
    },
    { scope: 'worker' }
  ],

  backgroundPage: [
    async ({ harnessCtx }, use) => {
      await use(harnessCtx._firefoxBgPage)
    },
    { scope: 'worker' }
  ],

  // Worker-scoped page shared by every test in the worker, so the device stays
  // paired (and opened) across the whole serial chain.
  sharedPage: [
    async ({ harnessCtx, httpPort, daemonMode, backgroundPage }, use) => {
      if (daemonMode === 'daemon-nm') {
        // Must run in the extension background context: `browser` is not
        // available in page context, so a page.evaluate here silently no-ops.
        await backgroundPage
          .evaluate(() => {
            return browser.storage.local.set({
              'settings :: daemonAsNmHost': true
            })
          })
          .catch(() => {})
      }
      const page = await harnessCtx.newPage()
      installAddScriptTagPatch(page)
      const url = `http://localhost:${httpPort}/tests/test-page.html`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
      await use(wrapWithNetworkBridge(page, harnessCtx._firefoxBridge))
    },
    { scope: 'worker' }
  ],

  // Test-scoped escape hatch for tests that need a clean page. Defined from
  // the harness context so it always has the extension, unlike Playwright's
  // default page fixture.
  page: [
    async ({ harnessCtx }, use) => {
      const page = await harnessCtx.newPage()
      installAddScriptTagPatch(page)
      await use(wrapWithNetworkBridge(page, harnessCtx._firefoxBridge))
    },
    { scope: 'test' }
  ]
})

export { expect }
