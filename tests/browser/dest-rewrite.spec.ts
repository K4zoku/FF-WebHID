import { test, expect } from '../helpers/browser.js';

test.describe('Sec-Fetch-Dest rewrite for shadow-URL worker request', () => {
  test('server sees dest=document (not worker) for the worker self-request', async ({
    sharedPage,
    pageUrl,
  }) => {
    await sharedPage.goto(pageUrl('/dest-gated'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    // Give the worker self-request a moment to hit the server.
    await sharedPage.waitForTimeout(1000);
    const observed = await sharedPage.evaluate(async () => {
      const res = await fetch('/last-dest');
      return (await res.json()) as { dest: string | null; status: number };
    });
    expect(observed.dest).toBe('document');
    expect(observed.status).toBe(200);
  });
});
