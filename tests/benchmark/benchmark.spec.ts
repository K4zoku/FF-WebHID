import { test, expect } from '../helpers/e2e.js'
import { type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStreamingRelay } from '../helpers/e2e-relay.js'
import { type WebhidMockProcess } from '../helpers/e2e-process.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const VENDOR = mockIdFor('vendor')
const IMAGE_PATH = resolve(__dirname, '..', 'fixtures', 'images', 'sample.png')
// Image payload per report: 64-byte vendor report minus the 2-byte sequence header.
const PAYLOAD = 62
const RUNS = 5
const RUN_TIMEOUT_MS = 25000
const RUN_RETRIES = 3

declare global {
  interface Window {
    __webhidBenchmark?: {
      open(): Promise<void>
      run(warmup?: boolean): Promise<boolean>
      chunkCount(): number
      paints(): number
      getMeasure(): number
      getMarks(): Record<string, number | null>
    }
  }
}

type BgEvaluate = Page['evaluate']

async function setDataPlane(
  bg: { evaluate: BgEvaluate },
  origin: string,
  mode: 'ws' | 'nm'
): Promise<void> {
  await bg.evaluate(
    ({ origin, mode }: { origin: string; mode: string }) =>
      browser.storage.local.set({
        'settings :: dataPlane': mode,
        [`settings :: ${origin} :: dataPlane`]: mode
      }),
    { origin, mode }
  )
}

function chunkImage(img: Buffer): number[][] {
  const chunks: number[][] = []
  for (let seq = 0; seq * PAYLOAD < img.length; seq++) {
    const chunk = new Array<number>(PAYLOAD + 2).fill(0)
    chunk[0] = (seq >> 8) & 0xff
    chunk[1] = seq & 0xff
    const start = seq * PAYLOAD
    const end = Math.min(start + PAYLOAD, img.length)
    for (let i = start; i < end; i++) chunk[2 + (i - start)] = img[i]
    chunks.push(chunk)
  }
  return chunks
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error(msg)), ms)
  return Promise.race([p, promise]).finally(() => clearTimeout(timer))
}

async function runOnce(page: Page, mock: WebhidMockProcess, warmup: boolean): Promise<number> {
  const relay = startStreamingRelay(mock)
  try {
    const runPromise = page.evaluate((w) => window.__webhidBenchmark!.run(w), warmup)
    await withTimeout(runPromise, RUN_TIMEOUT_MS, 'image-painted not reached')
    return await page.evaluate(() => window.__webhidBenchmark!.getMeasure())
  } finally {
    relay.stop()
  }
}

async function runOnceWithRetry(
  page: Page,
  mock: WebhidMockProcess,
  label: string,
  warmup: boolean
): Promise<number> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RUN_RETRIES; attempt++) {
    try {
      return await runOnce(page, mock, warmup)
    } catch (err) {
      lastErr = err
      console.warn(`[benchmark] ${label} attempt ${attempt + 1} failed: ${errMsg(err)}; retrying`)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

test('image pipeline benchmark ws vs nm', async ({
  harnessCtx,
  backgroundPage,
  vendorDevice,
  httpPort,
  daemonMode
}) => {
  const page = await harnessCtx.newPage()
  const origin = `http://localhost:${httpPort}`

  if (daemonMode === 'daemon-nm') {
    await backgroundPage
      .evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))
      .catch(() => {})
  }

  await page.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  const granted = await grantDevicePermission(page, [VENDOR])
  expect(granted).toBe(1)

  await page.goto(`${origin}/tests/pages/benchmark-image.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await page.waitForFunction(() => (window.__webhidBenchmark?.chunkCount() ?? 0) > 0, {
    timeout: 15000
  })

  const img = await readFile(IMAGE_PATH)
  const chunks = chunkImage(img)
  expect(await page.evaluate(() => window.__webhidBenchmark!.chunkCount())).toBe(chunks.length)

  await page.evaluate(() => window.__webhidBenchmark!.open())

  const results: Record<'ws' | 'nm', number[]> = { ws: [], nm: [] }
  const marks: Record<string, Record<string, number | null>> = {}
  const failures: Record<string, number> = { ws: 0, nm: 0 }

  for (const mode of ['ws', 'nm'] as const) {
    await setDataPlane(backgroundPage, origin, mode)
    try {
      await runOnceWithRetry(page, vendorDevice, `${mode} warmup`, true)
    } catch (err) {
      console.warn(`[benchmark] ${mode} warmup failed after retries: ${errMsg(err)}`)
    }
    for (let run = 0; run < RUNS; run++) {
      try {
        const duration = await runOnceWithRetry(page, vendorDevice, `${mode} run ${run + 1}`, false)
        results[mode].push(duration)
        if (run === 0) marks[mode] = await page.evaluate(() => window.__webhidBenchmark!.getMarks())
      } catch (err) {
        failures[mode]++
        console.error(`[benchmark] ${mode} run ${run + 1} failed: ${errMsg(err)}`)
      }
    }
  }

  for (const mode of ['ws', 'nm'] as const) {
    expect(results[mode].length).toBeGreaterThan(0)
  }

  console.log('\n=== WebHID image pipeline benchmark: round-trip ms (lower is better) ===')
  console.log('mode | runs | median | min | max')
  for (const mode of ['ws', 'nm'] as const) {
    const v = results[mode]
    console.log(
      `${mode}  | ${v.length}    | ${median(v).toFixed(1)}  | ${Math.min(...v).toFixed(1)} | ${Math.max(...v).toFixed(1)}`
    )
    console.log(`  ${mode} runs: ${v.map((x) => x.toFixed(1)).join(', ')}`)
    if (marks[mode]) {
      const m = marks[mode]
      console.log(
        `  ${mode} first-run marks: decode ${(m.decoded! - m.sendStart!).toFixed(1)}ms, ` +
          `first-report ${(m.firstReport! - m.sendStart!).toFixed(1)}ms after send-start, ` +
          `paints ${await page.evaluate(() => window.__webhidBenchmark!.paints())}, ` +
          `roundtrip ${m.roundtrip!.toFixed(1)}ms`
      )
    }
    if (failures[mode] > 0) console.log(`  ${mode}: ${failures[mode]} failed run(s) after retries`)
  }
})
