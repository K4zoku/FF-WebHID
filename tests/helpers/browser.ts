import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import type { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startPolicyServer } from '../serve.js';
import type { Server } from 'http';

const require = createRequire(import.meta.url);

const harnessRoot = require.resolve('firefox-webext-playwright-harness');
const harnessDir = dirname(harnessRoot);

interface FirefoxBgPage {
  evaluate: Page['evaluate'];
}

interface FirefoxWebServer {
  registerRoute(pattern: string, handler: (route: { continue(): void }) => void): void;
  unregisterRoute(pattern: string, handler: (route: { continue(): void }) => void): void;
  clearRoutes(): void;
}

interface NetworkEventBridge {
  dispose(): void;
}

interface HarnessContext extends BrowserContext {
  _firefoxBgPage: FirefoxBgPage;
  _firefoxBridge: NetworkEventBridge;
  _firefoxWebServer: FirefoxWebServer;
  _rdpClient: unknown;
  _firefoxBackgroundConsoleActor: unknown;
  newPage(): Promise<Page>;
}

interface RdpPortHandle {
  port: number;
  release: () => Promise<void>;
}

interface CreateFirefoxContextOptions {
  routeHandler?: (route: { continue(): void }) => void;
  playwrightOptions?: { headless?: boolean };
}

type RouteHandler = (route: { continue(): void }) => void;

const { acquireRdpPort } = require(`${harnessDir}/rdp-port.js`) as {
  acquireRdpPort: (opts?: { maxAttempts?: number }) => Promise<RdpPortHandle>;
};
const { createFirefoxContext, cleanupFirefoxContext, FirefoxBackgroundPage } = require(`${harnessDir}/harness.js`) as {
  createFirefoxContext: (rdpPort: number, extensionPath: string, options?: CreateFirefoxContextOptions) => Promise<{ context: HarnessContext }>;
  cleanupFirefoxContext: (context: HarnessContext) => Promise<void>;
  FirefoxBackgroundPage: new (rdpClient: unknown, consoleActor: unknown) => FirefoxBgPage;
};
const { NetworkEventBridge } = require(`${harnessDir}/network-bridge.js`) as {
  NetworkEventBridge: new (firefoxWebServer: FirefoxWebServer) => NetworkEventBridge;
};
const { wrapWithNetworkBridge } = require(`${harnessDir}/proxies.js`) as {
  wrapWithNetworkBridge: <T>(target: T, bridge: NetworkEventBridge, opts?: { onRoute?: (pattern: string, handler: RouteHandler) => void; onUnroute?: (pattern: string, handler: RouteHandler) => void; onUnrouteAll?: () => void }) => T;
};
const { installAddScriptTagPatch } = require(`${harnessDir}/script-tag.js`) as {
  installAddScriptTagPatch: (page: Page) => void;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } };

const defaultRouteHandler: RouteHandler = (route) => { route.continue(); };

const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? resolve(process.env.EXTENSION_PATH)
  : resolve(__dirname, '..', '..', 'addon');

export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & {
    servers: Servers;
    pageUrl: (path: string) => string;
    crossUrl: (path: string) => string;
    harnessCtx: HarnessContext;
    rdpPort: number;
    backgroundPage: FirefoxBgPage;
    sharedPage: Page;
  }
>({
  servers: [async ({}, use) => {
    const main = await startPolicyServer();
    const cross = await startPolicyServer();
    await use({ main, cross });
    main.server.close();
    cross.server.close();
  }, { scope: 'worker', auto: true }],

  rdpPort: [async ({}, use) => {
    const { port, release } = await acquireRdpPort();
    try {
      await use(port);
    } finally {
      await release();
    }
  }, { scope: 'worker' }],

  harnessCtx: [async ({ rdpPort, headless }, use) => {
    const { context } = await createFirefoxContext(rdpPort, EXTENSION_PATH, {
      routeHandler: defaultRouteHandler,
      playwrightOptions: { headless },
    });

    let bridge: NetworkEventBridge | undefined;
    let onRoute: ((pattern: string, handler: RouteHandler) => void) | undefined;
    let onUnroute: ((pattern: string, handler: RouteHandler) => void) | undefined;
    let onUnrouteAll: (() => void) | undefined;
    try {
      await context.route('**/*', defaultRouteHandler);

      bridge = new NetworkEventBridge(context._firefoxWebServer);
      context._firefoxBridge = bridge;

      context._firefoxBgPage = new FirefoxBackgroundPage(
        context._rdpClient,
        context._firefoxBackgroundConsoleActor,
      );

      onRoute = (pattern: string, handler: (route: { continue(): void }) => void) => {
        if (typeof pattern !== 'string') return;
        context._firefoxWebServer.registerRoute(pattern, handler);
      };
      onUnroute = (pattern: string, handler: (route: { continue(): void }) => void) => {
        if (typeof pattern !== 'string') return;
        context._firefoxWebServer.unregisterRoute(pattern, handler);
      };
      onUnrouteAll = () => {
        context._firefoxWebServer.clearRoutes();
      };
    } catch (err) {
      bridge?.dispose();
      await cleanupFirefoxContext(context);
      throw err;
    }

    await use(wrapWithNetworkBridge(context, bridge, { onRoute, onUnroute, onUnrouteAll }));

    bridge.dispose();
    await cleanupFirefoxContext(context);
  }, { scope: 'worker' }],

  backgroundPage: [async ({ harnessCtx }, use) => {
    await use(harnessCtx._firefoxBgPage);
  }, { scope: 'worker' }],

  sharedPage: [async ({ harnessCtx }, use) => {
    const page = harnessCtx.pages()[0] ?? (await harnessCtx.newPage());
    installAddScriptTagPatch(page);
    await use(wrapWithNetworkBridge(page, harnessCtx._firefoxBridge));
  }, { scope: 'worker' }],

  page: [async ({ harnessCtx }, use) => {
    const page = await harnessCtx.newPage();
    installAddScriptTagPatch(page);
    try {
      await use(wrapWithNetworkBridge(page, harnessCtx._firefoxBridge));
    } finally {
      await page.close().catch(() => {});
    }
  }, { scope: 'test' }],

  pageUrl: [async ({ servers }, use) => {
    await use((path: string) => `http://localhost:${servers.main.port}${path}`);
  }, { scope: 'worker' }],

  crossUrl: [async ({ servers }, use) => {
    await use((path: string) => `http://localhost:${servers.cross.port}${path}`);
  }, { scope: 'worker' }],
});

export { expect };
