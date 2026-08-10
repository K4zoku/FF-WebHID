import { test } from '../helpers/e2e.js'
import { withTimeout } from '../helpers/test-utils.js'
import { type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

import { dirname, join, resolve } from 'node:path'
import { ProfilerCapture } from './capture-profile.js'
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

type BenchApi = {
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

interface BenchmarkFixtures {
  harnessCtx: { newPage(): Promise<Page> }
  backgroundPage: { evaluate: Page['evaluate'] }
  vendorDevice: WebhidMockProcess
  httpPort: number
  daemonMode: string
  /** Harness RDP port; required when BENCHMARK_PROFILE_DIR is set. */
  rdpPort?: number
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
export const WT_STREAM_ATTACHED = 'WT persistent stream attached'

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

function splitEnv(name: string): string[] | null {
  const raw = process.env[name]
  if (!raw) return null
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : null
}

function numEnv(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
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
        (window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }).webhidBenchmark!.run(
          a.warmup,
          a.runNumber,
          a.attempt,
          a.maxAttempts
        ),
      { warmup, runNumber, attempt, maxAttempts }
    )
    await withTimeout(runPromise, RUN_TIMEOUT_MS, 'image-painted not reached')
    const duration = await page.evaluate(() =>
      (
        window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
      ).webhidBenchmark!.getMeasure()
    )
    if (duration == null) throw new Error('roundtrip measure missing after painted')
    const latencies = await page.evaluate(() =>
      (
        window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
      ).webhidBenchmark!.getLatencies()
    )
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
      await page.evaluate(() =>
        (
          window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
        ).webhidBenchmark!.warmup()
      )
      return
    } catch (err) {
      lastErr = err
    } finally {
      relay.stop()
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function configureDaemonMode(
  backgroundPage: { evaluate: Page['evaluate'] },
  daemonMode: string
): Promise<void> {
  if (daemonMode !== 'daemon-nm') return
  await backgroundPage
    .evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))
    .catch(() => {})
}

async function configurePageSettings(
  backgroundPage: { evaluate: Page['evaluate'] },
  origin: string,
  mode: 'ws' | 'wt' | 'nm',
  opts?: { inPage?: boolean }
): Promise<void> {
  await setDataPlane(backgroundPage, origin, mode)
  const spawnMode = process.env.BENCHMARK_WORKER_SPAWN
  if (spawnMode === 'blob' || spawnMode === 'shadow') {
    await setWorkerSpawnMode(backgroundPage, origin, spawnMode)
  }
  if (opts?.inPage) {
    await setUseWorker(backgroundPage, origin, false)
    await setLogLevel(backgroundPage, origin, 3)
  } else if (process.env.BENCHMARK_DEBUG_LOG) {
    await setLogLevel(backgroundPage, origin, 3)
  }
}

async function prepareBenchmarkPage(page: Page, origin: string): Promise<void> {
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
  await page.waitForFunction(
    () =>
      ((
        window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
      ).webhidBenchmark?.chunkCount() ?? 0) > 0,
    {
      timeout: 15000
    }
  )
}

async function verifyChunkCount(page: Page): Promise<void> {
  const img = await readFile(IMAGE_PATH)
  const chunks = chunkImage(img)
  if (
    (await page.evaluate(() =>
      (
        window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
      ).webhidBenchmark!.chunkCount()
    )) !== chunks.length
  ) {
    throw new Error('page chunk count does not match file-based chunking')
  }
}

async function resetBenchmarkSettings(
  backgroundPage: { evaluate: Page['evaluate'] },
  origin: string
): Promise<void> {
  await backgroundPage
    .evaluate(
      ({ origin }: { origin: string }) =>
        browser.storage.local.remove([
          'settings :: dataPlane',
          'settings :: useWorker',
          'settings :: logLevel',
          'settings :: workerSpawnMode',
          `settings :: ${origin} :: dataPlane`,
          `settings :: ${origin} :: useWorker`,
          `settings :: ${origin} :: logLevel`,
          `settings :: ${origin} :: workerSpawnMode`
        ]),
      { origin }
    )
    .catch(() => {})
}

async function startProfiler(rdpPort: number): Promise<ProfilerCapture> {
  const profiler = await ProfilerCapture.connect(rdpPort)
  await profiler.startProfiler({
    features: splitEnv('BENCHMARK_PROFILE_FEATURES') ?? [
      'js',
      'stackwalk',
      'ipcmessages',
      'cpu',
      'cpuallthreads'
    ],
    threads: splitEnv('BENCHMARK_PROFILE_THREADS') ?? ['GeckoMain', 'Worker'],
    entries: numEnv('BENCHMARK_PROFILE_ENTRIES') ?? 1 << 28,
    interval: numEnv('BENCHMARK_PROFILE_INTERVAL') ?? 1
  })
  return profiler
}

async function saveProfile(
  profiler: ProfilerCapture,
  profileDir: string,
  mode: string,
  inPage: boolean
): Promise<void> {
  const t0 = Date.now()
  try {
    const file = join(profileDir, `profile-${mode}${inPage ? '-inpage' : ''}.json`)
    const threads = await profiler.stopAndSave(file)
    console.log(
      `[profiler] saved ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${threads.join(' | ')}`
    )
  } catch (e) {
    console.warn(
      `[profiler] capture failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  profiler.disconnect()
}

export async function benchmarkMode(
  fixtures: BenchmarkFixtures,
  mode: 'ws' | 'wt' | 'nm',
  opts?: { inPage?: boolean }
): Promise<BenchmarkResult> {
  const { harnessCtx, backgroundPage, vendorDevice, httpPort, daemonMode, rdpPort } = fixtures
  const page = await harnessCtx.newPage()
  const origin = `http://localhost:${httpPort}`

  await configureDaemonMode(backgroundPage, daemonMode)
  await configurePageSettings(backgroundPage, origin, mode, opts)
  await prepareBenchmarkPage(page, origin)
  await verifyChunkCount(page)

  const profileDir = process.env.BENCHMARK_PROFILE_DIR
  const profiler = profileDir && rdpPort ? await startProfiler(rdpPort) : null

  return await runBenchmark(page, vendorDevice, { inPage: !!opts?.inPage })
    .finally(() => resetBenchmarkSettings(backgroundPage, origin))
    .finally(async () => {
      if (profiler) {
        await saveProfile(profiler, profileDir!, mode, !!opts?.inPage)
      }
      if (!page.isClosed()) page.close().catch(() => {})
    })
}

export async function runBenchmark(
  page: Page,
  mock: WebhidMockProcess,
  opts: { inPage?: boolean } = {}
): Promise<BenchmarkResult> {
  const fallbacks: string[] = []
  let wtStreamAttached = false
  const onConsole = (msg: { text(): string; type(): string }) => {
    const text = msg.text()
    if (FALLBACK_PATTERNS.some((p) => text.includes(p))) {
      fallbacks.push(`[${msg.type()}] ${text}`)
    }
    if (text.includes(WT_STREAM_ATTACHED) && text.includes('polyfill')) {
      wtStreamAttached = true
    }
  }
  page.on('console', onConsole)
  try {
    await page.evaluate(() =>
      (window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }).webhidBenchmark!.open()
    )

    let warmup: number | null = null
    try {
      const warmupStart = Date.now()
      await runWarmupWithRetry(page, mock)
      warmup = Date.now() - warmupStart
    } catch {}

    if (opts.inPage && !wtStreamAttached) {
      const deadline = Date.now() + 2000
      while (!wtStreamAttached && Date.now() < deadline) {
        await page.waitForTimeout(200)
      }
      if (!wtStreamAttached) {
        throw new Error(
          'in-page WT data plane did not attach its stream during warmup; the ' +
            'spawn degraded to NM' +
            (fallbacks.length ? ': ' + fallbacks.join(' | ') : '')
        )
      }
    }

    const envRuns = Number(process.env.BENCHMARK_RUNS)
    const projectUse = test.info().project?.use as { benchmarkRuns?: number } | undefined
    const runs =
      Number.isInteger(envRuns) && envRuns > 0
        ? envRuns
        : (projectUse?.benchmarkRuns ?? DEFAULT_RUNS)

    const runsOut: Array<{
      duration: number
      latencies: number[]
      marks: Record<string, number | null>
    }> = []
    let failures = 0
    for (let run = 0; run < runs; run++) {
      try {
        const { duration, latencies } = await runOnceWithRetry(page, mock, false, run + 1)
        const marks = await page.evaluate(() =>
          (
            window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
          ).webhidBenchmark!.getMarks()
        )
        runsOut.push({ duration, latencies, marks })
      } catch {
        failures++
      }
    }

    const setup = await page.evaluate(() =>
      (
        window.tests!.helper as unknown as { webhidBenchmark?: BenchApi }
      ).webhidBenchmark!.getMarks()
    )
    const openMs =
      setup.dataReady != null && setup.openStart != null ? setup.dataReady - setup.openStart : null
    await page.evaluate(() => {
      document.getElementById('bench-status')!.textContent = ''
    })

    return { open: openMs, warmup, runs: runsOut, failures, fallbacks, wtStreamAttached }
  } finally {
    page.off('console', onConsole)
  }
}

export function percentile(vals: number[], p: number): number {
  const s = [...vals].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}

/** Skips the benchmark when the data plane degraded to NM: the numbers would
 * measure Native Messaging, not the requested mode, so a silent pass is worse
 * than a skip with the fallback messages attached. */
export function skipOnFallback(result: BenchmarkResult, mode: string): void {
  if (result.fallbacks.length > 0) {
    test.skip(
      true,
      `${mode} benchmark degraded to NM fallback: ${result.fallbacks.join(' | ')}. ` +
        'The numbers would measure NM, not ' +
        mode +
        '. Rerun to see if the spawn recovers.'
    )
  }
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
