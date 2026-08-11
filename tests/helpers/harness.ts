import {
  type Page,
  type BrowserContext,
  type TestFixture,
  type WorkerFixture
} from '@playwright/test'
import { createRequire } from 'module'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)

const harnessRoot = require.resolve('firefox-webext-playwright-harness')
const harnessDir = dirname(harnessRoot)

export interface FirefoxBgPage {
  evaluate: Page['evaluate']
}

export interface FirefoxWebServer {
  registerRoute(pattern: string, handler: (route: { continue(): void }) => void): void
  unregisterRoute(pattern: string, handler: (route: { continue(): void }) => void): void
  clearRoutes(): void
}

export interface NetworkEventBridge {
  dispose(): void
}

export interface HarnessContext extends BrowserContext {
  _firefoxBgPage: FirefoxBgPage
  _firefoxBridge: NetworkEventBridge
  _firefoxWebServer: FirefoxWebServer
  _rdpClient: unknown
  _firefoxBackgroundConsoleActor: unknown
  newPage(): Promise<Page>
}

export interface RdpPortHandle {
  port: number
  release: () => Promise<void>
}

export interface CreateFirefoxContextOptions {
  routeHandler?: (route: { continue(): void }) => void
  playwrightOptions?: { headless?: boolean; launchOptions?: object }
}

export type RouteHandler = (route: { continue(): void }) => void

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

export const defaultRouteHandler: RouteHandler = (route) => {
  route.continue()
}

export const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(__dirname, '..', '..', 'addon')

export interface HarnessCtxOptions {
  catchAllRoute?: boolean
  launchOptions?: object
}

/**
 * Creates the harness context (Firefox with the extension installed, the
 * network bridge wired, the background page exposed) and hands it to `use`.
 * The browser harness installs a catch-all route; the e2e harness must not
 * (Juggler interception breaks page-context WebTransport, see AGENTS.md).
 */
export async function harnessCtxBody(
  args: { rdpPort: number; headless?: boolean },
  use: (ctx: HarnessContext) => Promise<void>,
  opts: HarnessCtxOptions = {}
): Promise<void> {
  const { context } = await createFirefoxContext(args.rdpPort, EXTENSION_PATH, {
    routeHandler: defaultRouteHandler,
    playwrightOptions: opts.launchOptions
      ? { headless: args.headless, launchOptions: opts.launchOptions }
      : { headless: args.headless }
  })

  let bridge: NetworkEventBridge | undefined
  let onRoute: ((pattern: string, handler: RouteHandler) => void) | undefined
  let onUnroute: ((pattern: string, handler: RouteHandler) => void) | undefined
  let onUnrouteAll: (() => void) | undefined
  try {
    if (opts.catchAllRoute) await context.route('**/*', defaultRouteHandler)

    bridge = new NetworkEventBridge(context._firefoxWebServer)
    context._firefoxBridge = bridge

    context._firefoxBgPage = new FirefoxBackgroundPage(
      context._rdpClient,
      context._firefoxBackgroundConsoleActor
    )

    onRoute = (pattern: string, handler: (route: { continue(): void }) => void) => {
      if (typeof pattern !== 'string') return
      context._firefoxWebServer.registerRoute(pattern, handler)
    }
    onUnroute = (pattern: string, handler: (route: { continue(): void }) => void) => {
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
}

/** The harness context's initial page (or a fresh one), network-bridge wrapped. */
export async function baseSharedPage(harnessCtx: HarnessContext): Promise<Page> {
  const page = harnessCtx.pages()[0] ?? (await harnessCtx.newPage())
  installAddScriptTagPatch(page)
  return wrapWithNetworkBridge(page, harnessCtx._firefoxBridge)
}

export function rdpPortFixture(): [WorkerFixture<number, object>, { scope: 'worker' }] {
  return [
    async ({}, use) => {
      const { port, release } = await acquireRdpPort()
      try {
        await use(port)
      } finally {
        await release()
      }
    },
    { scope: 'worker' }
  ]
}

export function backgroundPageFixture(): [
  WorkerFixture<FirefoxBgPage, { harnessCtx: HarnessContext }>,
  { scope: 'worker' }
] {
  return [
    async ({ harnessCtx }, use) => {
      await use(harnessCtx._firefoxBgPage)
    },
    { scope: 'worker' }
  ]
}

export function pageFixture(): [
  TestFixture<Page, { harnessCtx: HarnessContext }>,
  { scope: 'test' }
] {
  return [
    async ({ harnessCtx }, use) => {
      const page = await harnessCtx.newPage()
      installAddScriptTagPatch(page)
      try {
        await use(wrapWithNetworkBridge(page, harnessCtx._firefoxBridge))
      } finally {
        await page.close().catch(() => {})
      }
    },
    { scope: 'test' }
  ]
}
