import { test, expect } from '../helpers/e2e.js'
import { sleep } from '../helpers/test-utils.js'
import { spawn, type ChildProcess } from 'child_process'
import { createConnection } from 'net'
import { createHash } from 'crypto'
import { createWriteStream, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { mockIdFor } from '../helpers/e2e-devices.js'
import { sendInput } from '../helpers/e2e-process.js'
import { VENDOR_INPUT_SIZE } from '../helpers/e2e-reports.js'

const VENDOR = mockIdFor('vendor')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DAEMON_BIN = resolve(__dirname, '..', '..', 'crates', 'target', 'debug', 'webhid-daemon')

interface NmDeviceEntry {
  deviceId: number
  vendorId: number
  productId: number
}

interface NmHandshakeResponse {
  s: number
  w?: number
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

interface NmClient {
  request<T>(msg: Record<string, unknown>): Promise<T>
  close(): void
}

interface WsState {
  opened: boolean
  closed: boolean
  messages: number
  closeCode: number
}

declare global {
  interface Window {
    __wsState?: WsState
    __wsBState?: WsState
  }
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
          const { promise, resolve } = Promise.withResolvers<T>()
          pending.set(id, (v) => resolve(v as T))
          const len = Buffer.alloc(4)
          len.writeUInt32LE(body.length, 0)
          sock.write(Buffer.concat([len, body]))
          return promise
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

test.describe.serial('WebHID E2E (transport revocation)', () => {
  test('closing session A revokes its WS transport while session B keeps the device', async ({
    sharedPage,
    vendorDevice
  }) => {
    test.setTimeout(90000)
    const socketPath = join(tmpdir(), `webhid-revoke-${process.pid}-${Date.now()}.sock`)
    const daemon = spawn(DAEMON_BIN, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHID_SOCKET: socketPath }
    })
    const logStream = createWriteStream(socketPath.replace(/\.sock$/, '.log'))
    daemon.stdout.pipe(logStream)
    daemon.stderr.pipe(logStream)
    try {
      await waitForDaemonListening(daemon)
      const nm = await makeNmClient(socketPath)
      const hs = await nm.request<NmHandshakeResponse>({ a: 8 })
      expect(hs.s).toBe(200)
      expect(hs.w).toBeTruthy()
      expect(hs.N).toBeTruthy()
      const wsPort = hs.w as number
      const nonce = hs.N as string

      const enumerate = await nm.request<NmEnumerateResponse>({ a: 1 })
      const vendor = enumerate.D.find(
        (d) => d.vendorId === VENDOR.vendorId && d.productId === VENDOR.productId
      )
      expect(vendor).toBeTruthy()
      const deviceId = vendor!.deviceId

      const openA = await nm.request<NmOpenResponse>({ a: 2, i: deviceId })
      expect(openA.s).toBe(201)
      const tokenA = openA.t as string
      const openB = await nm.request<NmOpenResponse>({ a: 2, i: deviceId })
      expect(openB.s).toBe(201)
      const tokenB = openB.t as string
      expect(tokenA).not.toBe(tokenB)

      const hashA = createHash('sha256')
        .update(tokenA + nonce)
        .digest('hex')
      const hashB = createHash('sha256')
        .update(tokenB + nonce)
        .digest('hex')

      await sharedPage.evaluate(
        ({ port, hash }: { port: number; hash: string }) => {
          const state: WsState = {
            opened: false,
            closed: false,
            messages: 0,
            closeCode: 0
          }
          const ws = new WebSocket('ws://127.0.0.1:' + port, 'webhid.' + hash)
          ws.binaryType = 'arraybuffer'
          ws.onopen = () => {
            state.opened = true
          }
          ws.onclose = (e) => {
            state.closed = true
            state.closeCode = e.code
          }
          ws.onmessage = () => {
            state.messages++
          }
          window.__wsState = state
        },
        { port: wsPort, hash: hashA }
      )
      await sharedPage.waitForFunction(() => window.__wsState?.opened === true, undefined, {
        timeout: 10000
      })

      sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0xaa))
      await sharedPage.waitForFunction(() => (window.__wsState?.messages ?? 0) > 0, undefined, {
        timeout: 10000
      })

      const closeA = await nm.request<{ s: number }>({ a: 3, i: deviceId, T: tokenA })
      expect(closeA.s).toBe(204)

      await sharedPage.waitForFunction(() => window.__wsState?.closed === true, undefined, {
        timeout: 10000
      })
      const aState = await sharedPage.evaluate(() => window.__wsState!)

      expect(aState.closeCode).not.toBe(0)

      await sleep(500)
      sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0xbb))
      await sleep(1000)
      const aMessagesAfter = await sharedPage.evaluate(() => window.__wsState!.messages)
      expect(aMessagesAfter).toBe(aState.messages)

      await sharedPage.evaluate(
        ({ port, hash }: { port: number; hash: string }) => {
          const state: WsState = {
            opened: false,
            closed: false,
            messages: 0,
            closeCode: 0
          }
          const ws = new WebSocket('ws://127.0.0.1:' + port, 'webhid.' + hash)
          ws.binaryType = 'arraybuffer'
          ws.onopen = () => {
            state.opened = true
          }
          ws.onclose = () => {
            state.closed = true
          }
          ws.onmessage = () => {
            state.messages++
          }
          window.__wsBState = state
        },
        { port: wsPort, hash: hashB }
      )
      await sharedPage.waitForFunction(() => window.__wsBState?.opened === true, undefined, {
        timeout: 10000
      })
      sendInput(vendorDevice, 1, new Array<number>(VENDOR_INPUT_SIZE).fill(0xcc))
      await sharedPage.waitForFunction(() => (window.__wsBState?.messages ?? 0) > 0, undefined, {
        timeout: 10000
      })

      nm.close()
    } finally {
      daemon.kill('SIGTERM')
      rmSync(socketPath, { force: true })
    }
  })
})
