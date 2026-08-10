import { test, expect } from '../helpers/browser.js'

test.describe('page-created self-worker (new Worker(location.href))', () => {
  test("page's own worker script runs", async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/self-worker'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await sharedPage.waitForFunction(
      () =>
        (window as unknown as { tests?: { results?: { selfWorker?: string } } }).tests?.results
          ?.selfWorker !== 'pending',
      { timeout: 10000 }
    )
    const result = await sharedPage.evaluate(
      () =>
        (window as unknown as { tests?: { results?: { selfWorker?: string } } }).tests?.results
          ?.selfWorker
    )
    expect(result).toBe('page-worker-ran')
  })
})
