import type { Page } from '@playwright/test'

export async function navigateToPolicyCheck(
  sharedPage: Page,
  pageUrl: (path: string) => string
): Promise<void> {
  await sharedPage.goto(pageUrl('/policy-check'), {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
}

export interface PermResult {
  isTop?: boolean
  isCrossOrigin?: boolean
  hidAllowed?: boolean
  queryHid?: string
  queryCamera?: string
  policySource?: string
  hidUndefined?: boolean
  getDevices?: { ok: boolean; count?: number; name?: string; message?: string }
}

interface WindowWithTests {
  tests?: {
    results: Record<string, unknown>
  }
}

async function getPermResult(page: Page): Promise<PermResult | null> {
  return page.evaluate((): PermResult | null => {
    const r = (window as unknown as WindowWithTests).tests?.results?.perm
    if (r && typeof r === 'object') return r
    return null
  })
}

export async function waitForPermResult(page: Page, timeout = 10000): Promise<PermResult | null> {
  await page.waitForFunction(
    (): boolean => {
      const r = (window as unknown as WindowWithTests).tests?.results?.perm
      return r !== null && typeof r === 'object'
    },
    { timeout }
  )
  return getPermResult(page)
}

/**
 * Arms the extension's shadow-URL interception from the background page for
 * the given URL, so a page-created `new Worker(location.href)` exercises the
 * shadow path (data-worker bundle + faked navigation headers) exactly like the
 * polyfill's own spawn.
 */
export async function armShadowSpawn(
  backgroundPage: {
    evaluate: (fn: (url: string) => Promise<void>, url: string) => Promise<void>
  },
  url: string
): Promise<void> {
  await backgroundPage.evaluate(async (url) => {
    const tabs = await browser.tabs.query({})
    const tab = tabs.find((t) => t.id != null) ?? tabs[0]
    const arm = (
      globalThis as unknown as { webhid?: { import: (n: string) => unknown } }
    ).webhid?.import('armShadowSpawn') as ((tabId: number, url: string) => void) | undefined
    arm?.(tab.id as number, url)
  }, url)
}
