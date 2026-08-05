import { test, expect } from '../helpers/browser.js'

interface TtResults {
  hasTrustedTypes: boolean
  skipped?: boolean
  extHidden?: string
  swallowedType?: string
  swallowedChain?: string
  wrappedInstanceof?: boolean
  wrappedName?: string
  wrappedHasOwnScriptURL?: boolean
  wrappedHasOwnHtml?: boolean
  wrappedHasOwnScript?: boolean
  secondCall?: string
  defaultCreated?: string
  defaultDup?: string
  htmlCall?: string
  scriptCall?: string
  policyCreated?: boolean
  scriptURL?: string
  policyHasHTML?: boolean
  policyHasScript?: boolean
  sink?: string
  error?: string
  nativeHtmlType?: string
  nativeHtmlCall?: string
  nativeScriptType?: string
  nativeScriptCall?: string
  htmlErrorMessage?: string
  scriptErrorMessage?: string
  nativeHtmlErrorMessage?: string
  nativeScriptErrorMessage?: string
  urlType?: string
  urlCall?: string
  urlError?: string
  htmlType?: string
}

test.describe('Trusted Types policy handling', () => {
  let raw: TtResults | null = null

  test.beforeAll(async ({ sharedPage, pageUrl }) => {
    await sharedPage.goto(pageUrl('/tt-policy'), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await sharedPage.waitForFunction(
      () =>
        (window as unknown as { tests?: { results?: TtResults } }).tests?.results
          ?.hasTrustedTypes !== undefined,
      { timeout: 10000 }
    )
    raw = await sharedPage.evaluate(
      () => (window as unknown as { tests: { results: TtResults } }).tests.results
    )
  })

  test('browser exposes Trusted Types', () => {
    expect(raw?.hasTrustedTypes).toBe(true)
  })

  test('addon keeps the URL factory hidden from the page', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.extHidden).toBe('undefined')
  })

  test('first page call is swallowed and returns a working policy', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.swallowedType).toBe('function')
  })

  test('page rules chain through the wrapper', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.swallowedChain).toBe('https://x/worker.js#page')
  })

  test('wrapped policy passes TrustedTypePolicy identity checks', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.wrappedInstanceof).toBe(true)
    expect(raw?.wrappedName).toBe('webhid-worker')
  })

  test('wrapped policy only owns the functions the page rules define', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.wrappedHasOwnScriptURL).toBe(true)
    expect(raw?.wrappedHasOwnHtml).toBe(false)
    expect(raw?.wrappedHasOwnScript).toBe(false)
  })
  test('missing page rules remain unavailable', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.htmlCall).toBe('TypeError')
    expect(raw?.scriptCall).toBe('TypeError')
  })

  test('duplicate createPolicy with the claimed name throws', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.secondCall).toBe('TypeError')
  })

  test('native policy without rules has no HTML or script methods', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.nativeHtmlType).toBe('function')
    expect(raw?.nativeScriptType).toBe('function')
    expect(raw?.nativeHtmlCall).toBe('TypeError')
    expect(raw?.nativeScriptCall).toBe('TypeError')
  })
  test('missing method errors match native Trusted Types', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.htmlErrorMessage).toBe(raw?.nativeHtmlErrorMessage)
    expect(raw?.scriptErrorMessage).toBe(raw?.nativeScriptErrorMessage)
  })
  test('default policy can be created', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.defaultCreated).toBe('ok')
  })

  test('duplicate default policy creation throws', () => {
    test.skip(!raw?.hasTrustedTypes, 'browser lacks Trusted Types')
    expect(raw?.defaultDup).toBe('TypeError')
  })
})

test('restricted policy name is captured on the page first call', async ({
  sharedPage,
  pageUrl
}) => {
  await sharedPage.goto(pageUrl('/tt-policy-restricted'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await sharedPage.waitForFunction(
    () => {
      const pageWindow = window as unknown as { tests?: { results?: TtResults } }
      return pageWindow.tests?.results?.hasTrustedTypes !== undefined
    },
    { timeout: 10000 }
  )
  const restricted = await sharedPage.evaluate(() => {
    const pageWindow = window as unknown as { tests: { results: TtResults } }
    return pageWindow.tests.results
  })
  expect(restricted.swallowedType).toBe('function')
  expect(restricted.swallowedChain).toBe('https://x/worker.js#page')
  expect(restricted.wrappedInstanceof).toBe(true)
  expect(restricted.wrappedName).toBe('uRGq7')
  expect(restricted.defaultCreated).toBe('ok')
})

test('wrapped HTML and script policies satisfy required sinks', async ({ sharedPage, pageUrl }) => {
  await sharedPage.goto(pageUrl('/tt-policy-sinks'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await sharedPage.waitForFunction(
    () => {
      const pageWindow = window as unknown as { tests?: { results?: TtResults } }
      return pageWindow.tests?.results?.hasTrustedTypes !== undefined
    },
    { timeout: 10000 }
  )
  const result = await sharedPage.evaluate(() => {
    const pageWindow = window as unknown as { tests: { results: TtResults } }
    return pageWindow.tests.results
  })
  expect(result.policyCreated).toBe(true)
  expect(result.scriptURL).toBe('https://x/worker.js#page')
  expect(result.policyHasHTML).toBe(true)
  expect(result.policyHasScript).toBe(true)
  expect(result.sink).toBe('ok')
  expect(result.error).toBeUndefined()
})

test('missing createScriptURL rule remains unavailable to page', async ({
  sharedPage,
  pageUrl
}) => {
  await sharedPage.goto(pageUrl('/tt-policy-no-url'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await sharedPage.waitForFunction(
    () => {
      const pageWindow = window as unknown as { tests?: { results?: TtResults } }
      return pageWindow.tests?.results?.hasTrustedTypes !== undefined
    },
    { timeout: 10000 }
  )
  const result = await sharedPage.evaluate(() => {
    const pageWindow = window as unknown as { tests: { results: TtResults } }
    return pageWindow.tests.results
  })
  expect(result.urlType).toBe('function')
  expect(result.urlCall).toBe('TypeError')
  expect(result.urlError).toBe('TrustedTypePolicy.createScriptURL: Function missing.')
  expect(result.htmlType).toBe('function')
  expect(result.sink).toBe('ok')
})
