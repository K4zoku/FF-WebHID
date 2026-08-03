import { test } from '../helpers/e2e.js'
import { type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStreamingRelay } from '../helpers/e2e-relay.js'
import { type WebhidMockProcess } from '../helpers/e2e-process.js'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'

export const VENDOR = mockIdFor('vendor')
export const IMAGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'images',
  'sample.png'
)

export const PAYLOAD = 62
export const DEFAULT_RUNS = 5
export const RUN_TIMEOUT_MS = 25000
export const RUN_RETRIES = 3

declare global {
  interface Window {
    webhidBenchmark?: {
      open(): Promise<void>
      run(
        warmup?: boolean,
        runNumber?: number,
        attempt?: number,
        maxAttempts?: number
      ): Promise<boolean>
      warmup(): Promise<boolean>
      chunkCount(): number
      paints(): number
      getMeasure(): number | null
      getLatencies(): number[]
      getMarks(): Record<string, number | null>
    }
  }
}

interface BenchmarkFixtures {
  harnessCtx: { newPage(): Promise<Page> }
  backgroundPage: { evaluate: Page['evaluate'] }
  vendorDevice: WebhidMockProcess
  httpPort: number
  daemonMode: string
}

/** Console messages that mean the data plane silently degraded to NM. */
const FALLBACK_PATTERNS = [
  'falling back to NM',
  'spawn failed',
  'using NM data plane',
  'cannot derive WS auth hash'
]

/** Positive signal that the in-page WT data plane actually engaged: the main
 * world (polyfill logger) logs this only after the WebTransport stream attach
 * succeeded. The worker logs the same text, but worker console does not reach
 * the page, so a match here is the in-page transport. */
const WT_STREAM_ATTACHED = 'WT persistent stream attached'

export interface BenchmarkResult {
  open: number | null
  warmup: number | null
  runs: Array<{ duration: number; latencies: number[]; marks: Record<string, number | null> }>
  failures: number
  /** Console messages matching FALLBACK_PATTERNS (data-plane degraded to NM). */
  fallbacks: string[]
  /** True when the in-page WT transport logged a successful stream attach. */
  wtStreamAttached: boolean
}

export async function setDataPlane(
  bg: { evaluate: Page['evaluate'] },
  origin: string,
  mode: 'ws' | 'wt' | 'nm'
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

export async function setWorkerSpawnMode(
  bg: { evaluate: Page['evaluate'] },
  origin: string,
  mode: 'shadow' | 'blob'
): Promise<void> {
  await bg.evaluate(
    ({ origin, mode }: { origin: string; mode: string }) =>
      browser.storage.local.set({
        'settings :: workerSpawnMode': mode,
        [`settings :: ${origin} :: workerSpawnMode`]: mode
      }),
    { origin, mode }
  )
}

export async function setUseWorker(
  bg: { evaluate: Page['evaluate'] },
  origin: string,
  enabled: boolean
): Promise<void> {
  await bg.evaluate(
    ({ origin, enabled }: { origin: string; enabled: boolean }) =>
      browser.storage.local.set({
        'settings :: useWorker': enabled,
        [`settings :: ${origin} :: useWorker`]: enabled
      }),
    { origin, enabled }
  )
}

export async function setLogLevel(
  bg: { evaluate: Page['evaluate'] },
  origin: string,
  level: number
): Promise<void> {
  await bg.evaluate(
    ({ origin, level }: { origin: string; level: number }) =>
      browser.storage.local.set({
        'settings :: logLevel': level,
        [`settings :: ${origin} :: logLevel`]: level
      }),
    { origin, level }
  )
}

export function chunkImage(img: Buffer): number[][] {
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

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error(msg)), ms)
  return Promise.race([p, promise]).finally(() => clearTimeout(timer))
}

async function runOnce(
  page: Page,
  mock: WebhidMockProcess,
  warmup: boolean,
  runNumber: number,
  attempt: number,
  maxAttempts: number
): Promise<{ duration: number; latencies: number[] }> {
  const relay = startStreamingRelay(mock)
  try {
    const runPromise = page.evaluate(
      (a: { warmup: boolean; runNumber: number; attempt: number; maxAttempts: number }) =>
        window.webhidBenchmark!.run(a.warmup, a.runNumber, a.attempt, a.maxAttempts),
      { warmup, runNumber, attempt, maxAttempts }
    )
    await withTimeout(runPromise, RUN_TIMEOUT_MS, 'image-painted not reached')
    const duration = await page.evaluate(() => window.webhidBenchmark!.getMeasure())
    if (duration == null) throw new Error('roundtrip measure missing after painted')
    const latencies = await page.evaluate(() => window.webhidBenchmark!.getLatencies())
    return { duration, latencies }
  } finally {
    relay.stop()
  }
}

async function runOnceWithRetry(
  page: Page,
  mock: WebhidMockProcess,
  warmup: boolean,
  runNumber: number
): Promise<{ duration: number; latencies: number[] }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RUN_RETRIES; attempt++) {
    try {
      return await runOnce(page, mock, warmup, runNumber, attempt + 1, RUN_RETRIES)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function runWarmupWithRetry(page: Page, mock: WebhidMockProcess): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RUN_RETRIES; attempt++) {
    const relay = startStreamingRelay(mock)
    try {
      await page.evaluate(() => window.webhidBenchmark!.warmup())
      return
    } catch (err) {
      lastErr = err
    } finally {
      relay.stop()
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export async function benchmarkMode(
  fixtures: BenchmarkFixtures,
  mode: 'ws' | 'wt' | 'nm',
  opts?: { inPage?: boolean }
): Promise<BenchmarkResult> {
  const { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode } = fixtures
  const page = await harnessCtx.newPage()
  const origin = `http://localhost:${httpPort}`

  if (daemonMode === 'daemon-nm') {
    await backgroundPage
      .evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))
      .catch(() => {})
  }

  await setDataPlane(backgroundPage, origin, mode)
  const spawnMode = process.env.BENCHMARK_WORKER_SPAWN
  if (spawnMode === 'blob' || spawnMode === 'shadow') {
    await setWorkerSpawnMode(backgroundPage, origin, spawnMode)
  }
  if (opts?.inPage) {
    await setUseWorker(backgroundPage, origin, false)
  }
  // Debug logging so data-plane spawn/fallback decisions are visible on the
  // page console; the wt-inpage benchmark asserts none of them degrade to NM.
  await setLogLevel(backgroundPage, origin, 3)

  const fallbacks: string[] = []
  let wtStreamAttached = false
  page.on('console', (msg) => {
    const text = msg.text()
    if (FALLBACK_PATTERNS.some((p) => text.includes(p))) {
      fallbacks.push(`[${msg.type()}] ${text}`)
    }
    if (text.includes(WT_STREAM_ATTACHED) && text.includes('polyfill')) {
      wtStreamAttached = true
    }
  })

  await page.goto(`${origin}/tests/test-page.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  const granted = await grantDevicePermission(page, [VENDOR])
  if (granted !== 1)
    throw new Error(`grantDevicePermission resolved ${granted} devices, expected 1`)

  await page.goto(`${origin}/tests/pages/benchmark-image.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await page.waitForFunction(() => (window.webhidBenchmark?.chunkCount() ?? 0) > 0, {
    timeout: 15000
  })

  const img = await readFile(IMAGE_PATH)
  const chunks = chunkImage(img)
  if ((await page.evaluate(() => window.webhidBenchmark!.chunkCount())) !== chunks.length) {
    throw new Error('page chunk count does not match file-based chunking')
  }

  const result = await runBenchmark(page, vendorDevice, fallbacks)
  if (opts?.inPage) {
    // Wait until the in-page WT either attaches its stream (real run, fast) or
    // the 10s spawn timeout fires the NM-fallback warning (harness). Asserting
    // before this would race the benchmark end and miss both signals.
    const deadline = Date.now() + 11500
    while (!wtStreamAttached && Date.now() < deadline) {
      await page.waitForTimeout(200)
    }
  }
  return { ...result, wtStreamAttached }
}

export async function runBenchmark(
  page: Page,
  mock: WebhidMockProcess,
  fallbacks: string[] = []
): Promise<BenchmarkResult> {
  await page.evaluate(() => window.webhidBenchmark!.open())

  let warmup: number | null = null
  try {
    const warmupStart = Date.now()
    await runWarmupWithRetry(page, mock)
    warmup = Date.now() - warmupStart
  } catch {}

  const envRuns = Number(process.env.BENCHMARK_RUNS)
  const projectUse = test.info().project?.use as { benchmarkRuns?: number } | undefined
  const runs =
    Number.isInteger(envRuns) && envRuns > 0 ? envRuns : (projectUse?.benchmarkRuns ?? DEFAULT_RUNS)

  const runsOut: Array<{
    duration: number
    latencies: number[]
    marks: Record<string, number | null>
  }> = []
  let failures = 0
  for (let run = 0; run < runs; run++) {
    try {
      const { duration, latencies } = await runOnceWithRetry(page, mock, false, run + 1)
      const marks = await page.evaluate(() => window.webhidBenchmark!.getMarks())
      runsOut.push({ duration, latencies, marks })
    } catch {
      failures++
    }
  }

  const setup = await page.evaluate(() => window.webhidBenchmark!.getMarks())
  const openMs =
    setup.dataReady != null && setup.openStart != null ? setup.dataReady - setup.openStart : null
  await page.evaluate(() => {
    document.getElementById('bench-status')!.textContent = ''
  })

  return { open: openMs, warmup, runs: runsOut, failures, fallbacks, wtStreamAttached: false }
}

export function percentile(vals: number[], p: number): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}

export function printResults(mode: string, result: BenchmarkResult): void {
  const { runs, failures } = result
  const fmt = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1))
  const pct = (vals: number[], p: number) => percentile(vals, p).toFixed(2)
  console.log(
    `\n=== WebHID image pipeline benchmark (${mode}): per-report round-trip ms (lower is better) ===`
  )
  console.log(`open: ${fmt(result.open)}ms`)
  console.log(`warmup: ${fmt(result.warmup)}ms`)
  const first = runs[0]
  const totalMs =
    first != null && first.marks.sendStart != null && first.marks.loadStart != null
      ? first.marks.sendStart - first.marks.loadStart
      : null
  console.log(`total: ${fmt(totalMs)}ms`)
  console.log('')
  console.log(
    `${'run'.padEnd(5)}${'min'.padStart(8)}${'p50'.padStart(8)}${'p90'.padStart(8)}${'p95'.padStart(8)}${'max'.padStart(8)}${'walltime'.padStart(10)}`
  )
  for (const [i, r] of runs.entries()) {
    const walltime =
      r.marks.runEnd != null && r.marks.runStart != null ? r.marks.runEnd - r.marks.runStart : null
    console.log(
      `#${String(i + 1).padEnd(4)}${pct(r.latencies, 0).padStart(8)}${pct(r.latencies, 50).padStart(
        8
      )}${pct(r.latencies, 90).padStart(8)}${pct(r.latencies, 95).padStart(8)}${pct(
        r.latencies,
        100
      ).padStart(8)}${fmt(walltime).padStart(10)}`
    )
  }
  console.log('')
  const durations = runs.map((r) => r.duration)
  const pct1 = (vals: number[], p: number) => percentile(vals, p).toFixed(1)
  console.log(
    `${'mode'.padEnd(6)}${'runs'.padStart(5)}${'min'.padStart(7)}${'p50'.padStart(7)}${'p90'.padStart(7)}${'p95'.padStart(7)}${'max'.padStart(7)}`
  )
  console.log(
    `${mode.padEnd(6)}${String(runs.length).padStart(5)}${pct1(durations, 0).padStart(7)}${pct1(
      durations,
      50
    ).padStart(7)}${pct1(durations, 90).padStart(7)}${pct1(durations, 95).padStart(7)}${pct1(
      durations,
      100
    ).padStart(7)}`
  )
  if (failures > 0) console.log(`  ${failures} failed run(s) after retries`)
  if (result.fallbacks.length > 0) {
    console.log('')
    console.log(
      'WARNING: the data plane degraded to NM fallback; these numbers measure ' +
        'Native Messaging, not the requested mode:'
    )
    for (const fb of result.fallbacks) console.log('  - ' + fb)
  }
}
