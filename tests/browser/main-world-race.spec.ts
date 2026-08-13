import { test, expect } from '../helpers/browser.js'

interface RaceResult {
  hidAtFirstScript: 'present' | 'absent'
}

test.describe('MAIN-world polyfill ordering', () => {
  test('polyfill is installed before the first inline page script', async ({ page, pageUrl }) => {
    await page.goto(pageUrl('/main-world-race-probe'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const result = await page.evaluate(() => {
      const r = (window as unknown as { tests?: { results?: { mainWorldRace?: RaceResult } } })
        .tests?.results?.mainWorldRace
      return r ?? { hidAtFirstScript: 'missing' as const }
    })
    expect(result.hidAtFirstScript).toBe('present')
  })
})
