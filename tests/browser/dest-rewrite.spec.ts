import { test, expect } from '../helpers/browser.js';

test.describe('Sec-Fetch header faking for shadow-URL worker request', () => {
  test('server sees navigation headers (dest=document, mode=navigate, site=none, user=?1, HTML accept) for the worker self-request', async ({
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
      return (await res.json()) as {
        dest: string | null;
        mode: string | null;
        site: string | null;
        user: string | null;
        accept: string | null;
        status: number;
      };
    });
    expect(observed.dest).toBe('document');
    expect(observed.mode).toBe('navigate');
    expect(observed.site).toBe('none');
    expect(observed.user).toBe('?1');
    // Firefox's navigation Accept (any version) starts with the HTML list;
    // the worker-script default is the bare "*/*".
    expect(observed.accept).toMatch(/^text\/html,application\/xhtml\+xml/);
    expect(observed.status).toBe(200);
  });
});
