import { test, expect } from '../helpers/e2e.js'
import type { Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'child_process'
import { createConnection } from 'net'
import { createSocket } from 'dgram'
import { createHash } from 'crypto'
import { readFileSync, rmSync, createWriteStream } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { grantDevicePermission, mockIdFor } from '../helpers/e2e-devices.js'
import {
  sendInput,
  waitForOutputReport,
  type DaemonProcess,
  type WebhidMockProcess
} from '../helpers/e2e-process.js'
import type { DeviceFilter } from '../helpers/e2e-types.js'

declare global {
  interface Window {
    __wtOldClose?: () => void
    __wtLog?: string[]
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DAEMON_BIN = resolve(__dirname, '..', '..', 'crates', 'target', 'debug', 'webhid-daemon')

const VENDOR = mockIdFor('vendor')
const VENDOR_INPUT_SIZE = 64
const VENDOR_OUTPUT_ID = 1
const FEATURE_REPORT_ID = 0x02

const VENDOR_CTX = {
  f: VENDOR,
  size: VENDOR_INPUT_SIZE,
  outputId: VENDOR_OUTPUT_ID,
  featureId: FEATURE_REPORT_ID
}

type VendorCtx = typeof VENDOR_CTX

interface ReportEvent {
  reportId: number
  data: number[]
}

interface NmDeviceEntry {
  deviceId: number
  vendorId: number
  productId: number
}

interface NmHandshakeResponse {
  s: number
  W?: number
  H?: string
  N?: string
}

interface NmEnumerateResponse {
  s: number
  D: NmDeviceEntry[]
}

interface NmOpenResponse {
  s: number
  t?: string
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const t = setTimeout(() => reject(new Error(msg)), ms)
  return Promise.race([p, promise]).finally(() => clearTimeout(t))
}

function nextInputReport(
  page: Page,
  flt: DeviceFilter,
  marker?: { index: number; value: number }
): Promise<ReportEvent> {
  return page.evaluate(
    ({ f, link }: { f: DeviceFilter; link: { index: number; value: number } | undefined }) => {
      const { promise, resolve, reject } = Promise.withResolvers<ReportEvent>()
      void navigator.hid.getDevices().then((ds) => {
        const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)
        if (!d) {
          reject(new Error(`device not paired: ${JSON.stringify(f)}`))
          return
        }
        d.oninputreport = (event) => {
          const r: ReportEvent = {
            reportId: event.reportId,
            data: Array.from(new Uint8Array(event.data.buffer))
          }
          if (!link || r.data[link.index] === link.value) resolve(r)
        }
      })
      return promise
    },
    { f: flt, link: marker }
  )
}

async function sendUntilReported(
  device: WebhidMockProcess,
  page: Page,
  flt: DeviceFilter,
  reportId: number,
  payload: number[],
  marker: { index: number; value: number }
): Promise<ReportEvent> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reportPromise = nextInputReport(page, flt, marker)
    await sleep(250)
    sendInput(device, reportId, payload)
    try {
      return await withTimeout(reportPromise, 2500, 'report not received on attempt ' + attempt)
    } catch (err) {
      if (attempt === 7) throw err
    }
  }
  throw new Error('unreachable')
}

function logContains(daemon: DaemonProcess, needle: string): boolean {
  try {
    return readFileSync(daemon.socketPath.replace(/\.sock$/, '.log'), 'utf8').includes(needle)
  } catch {
    return false
  }
}

async function waitForLog(daemon: DaemonProcess, needle: string, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (logContains(daemon, needle)) return true
    if (Date.now() - start > timeoutMs) return false
    await sleep(200)
  }
}

interface NmClient {
  request<T>(msg: Record<string, unknown>): Promise<T>
  close(): void
}

function makeNmClient(socketPath: string): Promise<NmClient> {
  return new Promise((resolvePromise, reject) => {
    const sock = createConnection(socketPath)
    let buf = Buffer.alloc(0)
    const pending = new Map<number, (v: unknown) => void>()
    let nextId = 1
    sock.on('connect', () => {
      resolvePromise({
        request<T>(msg: Record<string, unknown>): Promise<T> {
          const id = nextId++
          const body = Buffer.from(JSON.stringify({ n: id, ...msg }))
          return new Promise<T>((res) => {
            pending.set(id, (v) => res(v as T))
            const len = Buffer.alloc(4)
            len.writeUInt32LE(body.length, 0)
            sock.write(Buffer.concat([len, body]))
          })
        },
        close() {
          sock.destroy()
        }
      })
    })
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0)
        if (buf.length < 4 + len) break
        const body = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        const parsed: unknown = JSON.parse(body.toString())
        if (typeof parsed === 'object' && parsed !== null && 'n' in parsed) {
          const id = (parsed as { n: number }).n
          if (pending.has(id)) {
            pending.get(id)!(parsed)
            pending.delete(id)
          }
        }
      }
    })
    sock.on('error', reject)
  })
}

function waitForDaemonListening(proc: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
      clearTimeout(timer)
      fn()
    }
    const onData = (d: Buffer) => {
      if (d.toString().includes('webhid-daemon listening on')) finish(resolvePromise)
    }
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`daemon exited with code ${code} before listening`)))
    }
    const timer = setTimeout(() => finish(() => reject(new Error('daemon start timeout'))), 10000)
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', onExit)
  })
}

test.describe.serial('WebHID E2E (WebTransport data plane)', () => {
  test('set dataPlane to wt before any device opens', async ({ sharedPage, backgroundPage }) => {
    await backgroundPage.evaluate(() => browser.storage.local.set({ 'settings :: dataPlane': 'wt' }))
    await sharedPage.reload({ waitUntil: 'domcontentloaded' })
    await sharedPage.waitForFunction(() => typeof navigator.hid !== 'undefined', {
      timeout: 15000
    })
  })

  test('grant vendor permission', async ({ sharedPage, vendorDevice: _vendorDevice }) => {
    const count = await grantDevicePermission(sharedPage, [VENDOR])
    expect(count).toBe(1)
  })

  test('open device spawns the WT data plane', async ({ sharedPage, daemon }) => {
    const opened = await sharedPage.evaluate(
      async (f: DeviceFilter) => {
        const ds = await navigator.hid.getDevices()
        const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)!
        await d.open()
        return d.opened
      },
      VENDOR
    )
    expect(opened).toBe(true)
    if (daemon) {
      expect(await waitForLog(daemon, 'WT connect gen=')).toBe(true)
      const log = readFileSync(daemon.socketPath.replace(/\.sock$/, '.log'), 'utf8')
      expect(log.lastIndexOf('WT connect gen=') > log.lastIndexOf('WS connect gen=')).toBe(true)
    }
  })

  test('receive input report over WT', async ({ sharedPage, vendorDevice }) => {
    const packet = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    packet[0] = 0xab
    packet[1] = 0x1a
    const event = await sendUntilReported(vendorDevice, sharedPage, VENDOR, 1, packet, {
      index: 1,
      value: 0x1a
    })
    expect(event.reportId).toBe(1)
    expect(event.data.length).toBe(VENDOR_INPUT_SIZE)
    expect(event.data[0]).toBe(0xab)
  })

  test('NM does not double-deliver while the device is in WT mode', async ({
    sharedPage,
    vendorDevice
  }) => {
    const observedPromise = sharedPage.evaluate((f: DeviceFilter) => {
      const { promise, resolve } = Promise.withResolvers<{ markers: number[]; all: string[] }>()
      const markers: number[] = []
      const all: string[] = []
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        resolve({ markers, all })
      }
      void navigator.hid.getDevices().then((ds) => {
        const d = ds.find((x) => x.vendorId === f.vendorId && x.productId === f.productId)!
        d.oninputreport = (event) => {
          const data = new Uint8Array(event.data.buffer)
          all.push('r' + event.reportId + ':' + data[0].toString(16) + ':' + data[1].toString(16))
          if (data[1] === 0x2a) {
            markers.push(data[0])
            setTimeout(finish, 1500)
          }
        }
      })
      setTimeout(finish, 4000)
      return promise
    }, VENDOR)
    const packet = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    packet[0] = 0x77
    packet[1] = 0x2a
    await sleep(200)
    sendInput(vendorDevice, 1, packet)
    const observed = await observedPromise
    expect(observed.markers).toEqual([0x77])
    expect(observed.all).toEqual(['r1:77:2a'])
  })

  test('sendReport over WT', async ({ sharedPage, vendorDevice }) => {
    const outputPromise = waitForOutputReport(vendorDevice)
    await sleep(200)
    await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      await d.sendReport(ctx.outputId, new Uint8Array(ctx.size).fill(0x42))
    }, VENDOR_CTX)
    const output = await outputPromise
    expect(output.data[0]).toBe(VENDOR_OUTPUT_ID)
  })

  test('receiveFeatureReport over WT', async ({ sharedPage }) => {
    const data = await sharedPage.evaluate(async (ctx: VendorCtx) => {
      const ds = await navigator.hid.getDevices()
      const d = ds.find((x) => x.vendorId === ctx.f.vendorId && x.productId === ctx.f.productId)!
      const view = await d.receiveFeatureReport(ctx.featureId)
      return Array.from(new Uint8Array(view.buffer))
    }, VENDOR_CTX)
    expect(Array.isArray(data)).toBe(true)
  })

  test('switching data plane ws→wt on an open device', async ({
    sharedPage,
    vendorDevice,
    backgroundPage,
    daemon
  }) => {
    await backgroundPage.evaluate(() => browser.storage.local.set({ 'settings :: dataPlane': 'ws' }))
    await sleep(2500)
    const wsPacket = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    wsPacket[1] = 0xb1
    const wsEvent = await sendUntilReported(vendorDevice, sharedPage, VENDOR, 1, wsPacket, {
      index: 1,
      value: 0xb1
    })
    expect(wsEvent.data[1]).toBe(0xb1)
    if (daemon) {
      expect(await waitForLog(daemon, 'WS connect gen=')).toBe(true)
    }

    await backgroundPage.evaluate(() => browser.storage.local.set({ 'settings :: dataPlane': 'wt' }))
    await sleep(2500)
    const wtPacket = new Array<number>(VENDOR_INPUT_SIZE).fill(0)
    wtPacket[1] = 0xb2
    const wtEvent = await sendUntilReported(vendorDevice, sharedPage, VENDOR, 1, wtPacket, {
      index: 1,
      value: 0xb2
    })
    expect(wtEvent.data[1]).toBe(0xb2)
    if (daemon) {
      expect(await waitForLog(daemon, 'WT connect gen=2')).toBe(true)
    }
  })

  test('WT generation rotates after cert expiry and drains the old port', async ({
    sharedPage,
    vendorDevice: _vendorDevice
  }) => {
    test.setTimeout(90000)
    const socketPath = join(tmpdir(), `webhid-wt-rotate-${process.pid}-${Date.now()}.sock`)
    const daemon = spawn(DAEMON_BIN, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHID_SOCKET: socketPath, WEBHID_WT_CERT_VALIDITY_SECS: '6' }
    })
    const logStream = createWriteStream(socketPath.replace(/\.sock$/, '.log'))
    daemon.stdout.pipe(logStream)
    daemon.stderr.pipe(logStream)
    try {
      await waitForDaemonListening(daemon)
      const nm = await makeNmClient(socketPath)
      const hs1 = await nm.request<NmHandshakeResponse>({ a: 8 })
      expect(hs1.s).toBe(200)
      expect(hs1.W).toBeTruthy()
      expect(hs1.H).toBeTruthy()
      const nonce = hs1.N as string
      const wtPort1 = hs1.W as number
      const wtHash1 = hs1.H as string

      const enumerate = await nm.request<NmEnumerateResponse>({ a: 1 })
      const vendor = enumerate.D.find(
        (d) => d.vendorId === VENDOR.vendorId && d.productId === VENDOR.productId
      )
      expect(vendor).toBeTruthy()
      const open = await nm.request<NmOpenResponse>({ a: 2, i: vendor!.deviceId })
      expect(open.s).toBe(201)
      const token = open.t as string
      const authHash = createHash('sha256').update(token + nonce).digest('hex')

      const workerSource = `
        const port = ${wtPort1}
        const cert = '${wtHash1}'
        const auth = '${authHash}'
        const hexToBytes = (s) => {
          const b = new Uint8Array(s.length / 2)
          for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16)
          return b
        }
        const concat = (a, b) => {
          const out = new Uint8Array(a.length + b.length)
          out.set(a, 0)
          out.set(b, a.length)
          return out
        }
        const report = (m) => self.postMessage(m)
        const connect = (path) =>
          new Promise((resolve, reject) => {
            const wt = new WebTransport('https://127.0.0.1:' + port + '/' + path, {
              serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(cert) }]
            })
            wt.ready.then(() => resolve(wt)).catch((e) => reject(new Error(e.message || e)))
          })
        ;(async () => {
          try {
            const wt1 = await connect(auth)
            const stream = await wt1.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()
            report('connected')
            const acks = []
            const ackLoop = (async () => {
              let buf = new Uint8Array(0)
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value) continue
                buf = concat(buf, new Uint8Array(value))
                while (buf.length >= 4) {
                  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
                  const len = dv.getUint32(0, true)
                  if (buf.length < 4 + len) break
                  const frame = buf.subarray(4, 4 + len)
                  buf = buf.subarray(4 + len)
                  acks.push(Array.from(frame))
                }
              }
            })()
            const sendFrame = async (marker) => {
              const before = acks.length
              const frame = new Uint8Array([0xff, marker, 0, 0, 0, 9])
              const header = new Uint8Array(4)
              new DataView(header.buffer).setUint32(0, frame.length, true)
              await writer.write(header)
              await writer.write(frame)
              for (let i = 0; i < 100; i++) {
                if (acks.length > before) return JSON.stringify(acks[acks.length - 1])
                await new Promise((r) => setTimeout(r, 100))
              }
              return 'no-ack'
            }
            report('ack1:' + (await sendFrame(1)))
            await new Promise((r) => setTimeout(r, 7000))
            report('waited')
            report('ack2:' + (await sendFrame(2)))
            let newState = 'accepted'
            try {
              const wt2 = await connect(auth)
              wt2.close()
            } catch (e) {
              newState = 'rejected'
            }
            report('new:' + newState)
            wt1.close()
            report('closed')
          } catch (e) {
            report('error:' + (e.message || e))
          }
        })()
      `
      await sharedPage.evaluate((src) => {
        const blob = new Blob([src], { type: 'application/javascript' })
        const log: string[] = (window.__wtLog = [])
        const worker = new Worker(URL.createObjectURL(blob))
        worker.onmessage = (e) => log.push(String(e.data))
      }, workerSource)
      try {
        await sharedPage.waitForFunction(
          () => (window.__wtLog || []).some((m) => m.startsWith('ack1:')),
          undefined,
          { timeout: 20000 }
        )
      } catch (e) {
        throw e
      }
      const ack1 = await sharedPage.evaluate(() =>
        ((window.__wtLog || []).find((m) => m.startsWith('ack1:')) || 'ack1:[]').slice(5)
      )
      expect(ack1).toBe('[255,1,0,0,0,1]')

      await sharedPage.waitForFunction(() => (window.__wtLog || []).includes('waited'), undefined, {
        timeout: 20000
      })
      await sleep(1500)

      const hs2 = await nm.request<NmHandshakeResponse>({ a: 8 })
      expect(hs2.s).toBe(200)
      expect(hs2.W).not.toBe(wtPort1)
      expect(hs2.H).not.toBe(wtHash1)

      await sharedPage.waitForFunction(
        () => (window.__wtLog || []).some((m) => m.startsWith('ack2:')),
        undefined,
        { timeout: 20000 }
      )
      const ack2 = await sharedPage.evaluate(() =>
        ((window.__wtLog || []).find((m) => m.startsWith('ack2:')) || 'ack2:[]').slice(5)
      )
      expect(ack2).toBe('[255,2,0,0,0,1]')

      await sharedPage.waitForFunction(() => (window.__wtLog || []).includes('new:rejected'), undefined, {
        timeout: 20000
      })
      await sharedPage.waitForFunction(() => (window.__wtLog || []).includes('closed'), undefined, {
        timeout: 20000
      })
      await sleep(1500)

      const portFree = await new Promise<boolean>((resolve) => {
        const udp = createSocket('udp4')
        udp.once('error', () => resolve(false))
        udp.bind(wtPort1, '127.0.0.1', () => {
          udp.close()
          resolve(true)
        })
      })
      expect(portFree).toBe(true)
    } finally {
      daemon.kill('SIGTERM')
      rmSync(socketPath, { force: true })
    }
  })
})
