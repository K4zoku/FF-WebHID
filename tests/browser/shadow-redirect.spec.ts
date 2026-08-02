import { test, expect } from '../helpers/browser.js';
import type { Page } from '@playwright/test';

/**
 * The worker outcome the test page records (dest-gated.html writes
 * window.tests.results.workerState once its worker settles).
 */
type WorkerStateWindow = { tests?: { results?: { workerState?: string } } };

async function waitForWorkerState(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as WorkerStateWindow).tests?.results?.workerState !== 'pending',
    { timeout: 10000 },
  );
}

/** What the policy server records for the most recent gated request. */
interface GatedHeaders {
  dest: string | null;
  mode: string | null;
  site: string | null;
  user: string | null;
  accept: string | null;
  status: number;
}

async function readGatedHeaders(page: Page): Promise<GatedHeaders> {
  // Shape is the test server's own /last-dest contract (see tests/serve.ts).
  const payload = (await page.evaluate(async () => {
    const res = await fetch('/last-dest');
    return await res.json();
  })) as GatedHeaders;
  return payload;
}

test.describe('shadow-URL redirect following', () => {
  test('worker self-request follows redirects with navigation headers faked on the final hop', async ({
    sharedPage,
    pageUrl,
  }) => {
    await sharedPage.goto(pageUrl('/shadow-redirect-chain/chain4/4'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await waitForWorkerState(sharedPage);
    const observed = await readGatedHeaders(sharedPage);
    // 4 redirects, all treated as shadow: the final hop is served the worker
    // bundle, so the server sees faked navigation headers on it.
    expect(observed.dest).toBe('document');
    expect(observed.mode).toBe('navigate');
    expect(observed.status).toBe(200);
  });

  test('redirect chain longer than 4 hops is still followed to the end', async ({
    sharedPage,
    pageUrl,
  }) => {
    await sharedPage.goto(pageUrl('/shadow-redirect-chain/chain8/8'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await waitForWorkerState(sharedPage);
    const observed = await readGatedHeaders(sharedPage);
    // 8 redirects, every hop treated as shadow: the addon follows the chain to
    // the end, so the final hop is served the worker bundle with faked
    // navigation headers.
    expect(observed.dest).toBe('document');
    expect(observed.mode).toBe('navigate');
    expect(observed.status).toBe(200);
  });
});
