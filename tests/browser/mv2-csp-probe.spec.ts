import { test, expect } from '../helpers/browser.js'

interface CspProbeResult {
  hidUnderStrictCsp: 'present' | 'absent'
}

const LOOSE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'"

test('loose CSP is left untouched', async ({ page, pageUrl }) => {
  let cspHeader = ''
  page.on('response', (resp) => {
    if (resp.url().includes('/mv2-csp-loose-probe')) {
      cspHeader = resp.headers()['content-security-policy'] || ''
    }
  })
  await page.goto(pageUrl('/mv2-csp-loose-probe'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  expect(cspHeader).toBe(LOOSE_CSP)
  const result = await page.evaluate(() => {
    const r = (window as unknown as { tests?: { results?: { cspProbe?: CspProbeResult } } }).tests
      ?.results?.cspProbe
    return r ?? { hidUnderStrictCsp: 'missing' as const }
  })
  expect(result.hidUnderStrictCsp).toBe('present')
})

test('injected polyfill survives a strict page CSP (MV2)', async ({ page, pageUrl }) => {
  for (const route of [
    '/mv2-csp-probe',
    '/mv2-csp-header-probe',
    '/mv2-csp-nonce-probe',
    '/mv2-csp-tt-probe'
  ]) {
    await page.goto(pageUrl(route), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    const result = await page.evaluate(() => {
      const r = (window as unknown as { tests?: { results?: { cspProbe?: CspProbeResult } } })
        .tests?.results?.cspProbe
      return r ?? { hidUnderStrictCsp: 'missing' as const }
    })
    expect(result.hidUnderStrictCsp, `route ${route}`).toBe('present')
  }
})
