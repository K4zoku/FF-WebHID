import { test } from '../../helpers/e2e.js'
import type { Page } from '@playwright/test'
import { sendInput, type WebhidMockProcess } from '../../helpers/e2e-process.js'
import { grantDevicePermission, mockIdFor, type DeviceFilter } from '../../helpers/e2e-devices.js'
import { setDataPlane, percentile } from '../benchmark-utils.js'

export const VENDOR = mockIdFor('vendor')

interface LossPageState {
  count: number
  last: number
  phaseStart: number
  phaseCount: number
  phaseGaps: number
  phaseMaxGap: number
  phaseFirstGap: number
}

declare global {
  interface Window {
    __lossState?: LossPageState
  }
}

// The mock prepends report ID 1 to make the 64-byte vendor input report.
const PAYLOAD_LEN = 63

const RUN_TIMEOUT_MS = 30000
const RUN_RETRIES = 3
const DEFAULT_RUNS = 5

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v > 0 ? v : fallback
}

/** Reports per second the benchmark pushes (the device polling rate). */
export const LOSS_RATE = envInt('BENCHMARK_LOSS_RATE', 8000)
/** Reports pushed per measured run. */
export const LOSS_COUNT = envInt('BENCHMARK_LOSS_COUNT', 6000)

/** Console messages that mean the data plane silently degraded to NM. */
const FALLBACK_PATTERNS = [
  'falling back to NM',
  'spawn failed',
  'using NM data plane',
  'cannot derive WS auth hash'
]

export interface LossFixtures {
  harnessCtx: { newPage(): Promise<Page> }
  backgroundPage: { evaluate: Page['evaluate'] }
  vendorDevice: { process: WebhidMockProcess['process']; ready: Promise<void> }
  httpPort: number
  daemonMode: string
}

export interface LossRun {
  received: number
  injected: number
  lost: number
  lostPct: number
  gaps: number
  maxGap: number
  firstGap: number
}

export interface LossResult {
  runs: LossRun[]
  failures: number
  fallbacks: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Injects `count` reports paced at `rate`/s, waits for the page counter to
 * drain, and returns the phase's delivery stats. Reports carry a 16-bit
 * sequence in the first two payload bytes so gaps are measurable end to end. */
async function runLossOnce(
  page: Page,
  mock: WebhidMockProcess,
  rate: number,
  count: number,
  startSeq: number
): Promise<LossRun> {
  await page.evaluate((s: number) => {
    const st = window.__lossState!
    st.phaseStart = s
    st.last = s - 1
    st.phaseCount = 0
    st.phaseGaps = 0
    st.phaseMaxGap = 0
    st.phaseFirstGap = -1
  }, startSeq)

  const tickMs = 1
  const perTick = Math.max(1, Math.round(rate / 1000))
  for (let i = 0; i < count; ) {
    for (let j = 0; j < perTick && i < count; j++, i++) {
      const payload = new Array<number>(PAYLOAD_LEN).fill(0)
      const seq = startSeq + i
      payload[0] = seq & 0xff
      payload[1] = (seq >> 8) & 0xff
      payload[2] = (seq >> 16) & 0xff
      sendInput(mock, 1, payload)
    }
    await sleep(tickMs)
  }

  // Drain: the page may take seconds to catch up (NM is rate-limited by the
  // browser messaging pipeline), so wait until the phase counter is stable.
  const deadline = Date.now() + RUN_TIMEOUT_MS
  let stable = -1
  let stableRounds = 0
  while (Date.now() < deadline) {
    await sleep(500)
    const c = await page.evaluate(() => window.__lossState!.phaseCount)
    if (c === stable) stableRounds++
    else stableRounds = 0
    stable = c
    if (stableRounds >= 2) break
  }
  const st = await page.evaluate(() => {
    const s = window.__lossState!
    return {
      received: s.phaseCount,
      gaps: s.phaseGaps,
      maxGap: s.phaseMaxGap,
      firstGap: s.phaseFirstGap
    }
  })
  const received = Math.min(st.received, count)
  return {
    received,
    injected: count,
    lost: count - received,
    lostPct: count > 0 ? ((count - received) / count) * 100 : 0,
    gaps: st.gaps,
    maxGap: st.maxGap,
    firstGap: st.firstGap
  }
}

async function runLossOnceWithRetry(
  page: Page,
  mock: WebhidMockProcess,
  rate: number,
  count: number,
  startSeq: number
): Promise<LossRun> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RUN_RETRIES; attempt++) {
    try {
      return await runLossOnce(page, mock, rate, count, startSeq)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Opens the vendor device on the given data plane and measures input-report
 * delivery loss at LOSS_RATE for LOSS_COUNT reports per run. */
export async function benchmarkLoss(
  fixtures: LossFixtures,
  mode: 'ws' | 'wt' | 'nm'
): Promise<LossResult> {
  const { harnessCtx, backgroundPage, httpPort, daemonMode } = fixtures
  const page = await harnessCtx.newPage()
  const fallbacks: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (FALLBACK_PATTERNS.some((p) => text.includes(p))) fallbacks.push(`[${msg.type()}] ${text}`)
  })
  const origin = `http://localhost:${httpPort}`

  if (daemonMode === 'daemon-nm') {
    await backgroundPage
      .evaluate(() => browser.storage.local.set({ 'settings :: daemonAsNmHost': true }))
      .catch(() => {})
  }
  await setDataPlane(backgroundPage, origin, mode)
  await page.goto(`${origin}/tests/test-page.html`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForFunction(() => typeof navigator.hid !== 'undefined', { timeout: 15000 })
  const granted = await grantDevicePermission(page, [VENDOR])
  if (granted !== 1) throw new Error(`grantDevicePermission resolved ${granted} devices, expected 1`)

  await page.evaluate(
    async (f: DeviceFilter) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)
      if (!d) throw new Error('vendor device not paired')
      await d.open()
      const state = {
        count: 0,
        last: -1,
        phaseStart: 0,
        phaseCount: 0,
        phaseGaps: 0,
        phaseMaxGap: 0,
        phaseFirstGap: -1
      }
      d.oninputreport = (ev) => {
        const data = new Uint8Array(ev.data.buffer)
        const seq = data[0] | (data[1] << 8) | (data[2] << 16)
        state.count++
        if (seq >= state.phaseStart) {
          state.phaseCount++
          if (state.last >= state.phaseStart - 1) {
            const gap = seq - state.last
            if (gap > 1) {
              state.phaseGaps++
              if (gap > state.phaseMaxGap) state.phaseMaxGap = gap
              if (state.phaseFirstGap < 0) state.phaseFirstGap = seq
            }
          }
        }
        state.last = seq
      }
      window.__lossState = state
    },
    VENDOR
  )

  const mock = { process: fixtures.vendorDevice.process, ready: fixtures.vendorDevice.ready }

  // Warmup burst (unmeasured) primes the worker/transport so run 1 starts with
  // a clear path, mirroring the send-pipeline benchmark.
  try {
    await runLossOnce(page, mock, LOSS_RATE, Math.floor(LOSS_COUNT / 2), 0)
  } catch {}

  const envRuns = Number(process.env.BENCHMARK_RUNS)
  const projectUse = test.info().project?.use as { benchmarkRuns?: number } | undefined
  const runs =
    Number.isInteger(envRuns) && envRuns > 0 ? envRuns : (projectUse?.benchmarkRuns ?? DEFAULT_RUNS)

  const runsOut: LossRun[] = []
  let failures = 0
  for (let run = 0; run < runs; run++) {
    const startSeq = (run + 1) * LOSS_COUNT
    try {
      runsOut.push(await runLossOnceWithRetry(page, mock, LOSS_RATE, LOSS_COUNT, startSeq))
    } catch {
      failures++
    }
  }

  await page.evaluate(async () => {
    const ds = await navigator.hid.getDevices()
    for (const d of ds) {
      try {
        await d.close()
      } catch {}
    }
  })
  try {
    await page.close()
  } catch {}
  return { runs: runsOut, failures, fallbacks }
}

export function printLossResults(mode: string, result: LossResult): void {
  const { runs, failures } = result
  const fmt = (v: number) => v.toFixed(3)
  console.log(
    `\n=== WebHID input-report loss benchmark (${mode}) @ ${LOSS_RATE}Hz x${LOSS_COUNT} ===`
  )
  console.log(
    `${'run'.padEnd(5)}${'received'.padStart(10)}${'lost'.padStart(7)}${'loss%'.padStart(8)}${'gaps'.padStart(7)}${'maxGap'.padStart(8)}${'firstGap'.padStart(9)}`
  )
  for (const [i, r] of runs.entries()) {
    console.log(
      `#${String(i + 1).padEnd(4)}${String(r.received).padStart(10)}${String(r.lost).padStart(
        7
      )}${fmt(r.lostPct).padStart(8)}${String(r.gaps).padStart(7)}${String(r.maxGap).padStart(
        8
      )}${String(r.firstGap).padStart(9)}`
    )
  }
  console.log('')
  if (runs.length > 0) {
    const pcts = runs.map((r) => r.lostPct)
    const last = runs[runs.length - 1]
    console.log(
      `${mode.padEnd(4)} loss% min=${fmt(percentile(pcts, 0))} p50=${fmt(
        percentile(pcts, 50)
      )} p90=${fmt(percentile(pcts, 90))} max=${fmt(percentile(pcts, 100))} ` +
        `(last run received ${last.received}/${last.injected})`
    )
  }
  if (failures > 0) console.log(`  ${failures} failed run(s) after retries`)
  if (result.fallbacks.length > 0) {
    console.log('')
    console.log(
      'WARNING: the data plane degraded to NM fallback; these numbers measure Native Messaging:'
    )
    for (const fb of result.fallbacks) console.log('  - ' + fb)
  }
}
