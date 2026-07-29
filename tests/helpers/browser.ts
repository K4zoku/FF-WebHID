import { test as base, expect, type Page } from '@playwright/test';
import type { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../serve-policy.mjs';
import type { Server } from 'http';

const require = createRequire(import.meta.url);

const harnessRoot = require.resolve('firefox-webext-playwright-harness');
const harnessDir = dirname(harnessRoot);

const { acquireRdpPort } = require(`${harnessDir}/rdp-port.js`);
const { createFirefoxContext, cleanupFirefoxContext, FirefoxBackgroundPage } = require(`${harnessDir}/harness.js`);
const { NetworkEventBridge } = require(`${harnessDir}/network-bridge.js`);
const { wrapWithNetworkBridge } = require(`${harnessDir}/proxies.js`);
const { installAddScriptTagPatch } = require(`${harnessDir}/script-tag.js`);

interface FirefoxBgPage {
  evaluate: Page['evaluate'];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Servers = { main: { port: number; server: Server }; cross: { port: number; server: Server } };

const defaultRouteHandler = (route: { continue(): void }) => { route.continue(); };

const EXTENSION_PATH = resolve(__dirname, '..', '..', 'addon');

export const test = base.extend<
  PlaywrightTestArgs & PlaywrightTestOptions & {
    backgroundPage: FirefoxBgPage;
    sharedPage: Page;
  },
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & {
    servers: Servers;
    pageUrl: (path: string) => string;
    crossUrl: (path: string) => string;
    _harnessCtx: any;
    rdpPort: number;
  }
>({
  servers: [async ({}, use) => {
    const main = await startServer();
    const cross = await startServer();
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

  _harnessCtx: [async ({ rdpPort }, use) => {
    const { context } = await createFirefoxContext(rdpPort, EXTENSION_PATH, {
      routeHandler: defaultRouteHandler,
    });

    let bridge;
    let onRoute;
    let onUnroute;
    let onUnrouteAll;
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

  backgroundPage: [async ({ _harnessCtx }, use) => {
    await use(_harnessCtx._firefoxBgPage);
  }, { scope: 'worker' }],

  sharedPage: [async ({ _harnessCtx }, use) => {
    const page = await _harnessCtx.newPage();
    installAddScriptTagPatch(page);
    await use(wrapWithNetworkBridge(page, _harnessCtx._firefoxBridge));
  }, { scope: 'worker' }],

  pageUrl: [async ({ servers }, use) => {
    await use((path: string) => `http://localhost:${servers.main.port}${path}`);
  }, { scope: 'worker' }],

  crossUrl: [async ({ servers }, use) => {
    await use((path: string) => `http://localhost:${servers.cross.port}${path}`);
  }, { scope: 'worker' }],
});

export { expect };
