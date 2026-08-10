import net from 'node:net'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Minimal Firefox Remote Debugging Protocol client, scoped to what the
 * benchmark needs: drive the devtools "perf" actor over the debugger server's
 * raw TCP transport to capture a Gecko profile around a benchmark spec.
 *
 * Wire framing (devtools/shared/transport/packets.js):
 *   JSON frame: `<byteLen>:<json>`
 *   Bulk frame: `bulk <actor> <type> <length>:` followed by `length` raw bytes
 *
 * Capture flow (devtools/server/actors/perf.js, Firefox 140+):
 *   startProfiler({ entries, interval, features, threads })
 *     -> benchmark runs
 *   startCaptureAndStopProfiler() -> handle          (stops + captures)
 *   getPreviouslyCapturedProfileDataBulk({ handle }) -> bulk packet with the
 *     gzipped profile JSON
 */
interface Reply {
  error?: unknown
  message?: unknown
  value?: unknown
  perfActor?: unknown
  from?: unknown
}

class Pending {
  readonly promise: Promise<unknown>
  readonly resolve: (v: unknown) => void
  readonly reject: (e: Error) => void
  constructor(
    public bulk: boolean,
    timeoutMs: number,
    what: string
  ) {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.promise = promise
    this.resolve = resolve
    this.reject = reject
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    promise.finally(() => clearTimeout(timer))
  }
}

export class ProfilerCapture {
  private sock: net.Socket
  private buf = Buffer.alloc(0)
  private pending: Pending | null = null
  /** Remaining bulk payload bytes once the bulk header has been parsed. */
  private bulkRemaining: number | null = null
  private perfActor: string | null = null

  private constructor(sock: net.Socket) {
    this.sock = sock
  }

  /** Connect to Firefox's debugger server (the harness's `-start-debugger-server` port). */
  static connect(port: number): Promise<ProfilerCapture> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' })
      sock.setNoDelay(true)
      const client = new ProfilerCapture(sock)
      const fail = (e: unknown) => {
        sock.destroy()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
      sock.on('data', (d) => client.onData(d))
      sock.on('error', fail)
      sock.once('connect', async () => {
        try {
          await client.recv(10000, 'RDP hello')
          const root = await client.request('root', 'getRoot')
          if (
            !root ||
            typeof root !== 'object' ||
            !('perfActor' in root) ||
            typeof root.perfActor !== 'string'
          ) {
            throw new Error(`no perfActor on root: ${JSON.stringify(root).slice(0, 200)}`)
          }
          client.perfActor = root.perfActor
          sock.off('error', fail)
          resolve(client)
        } catch (e) {
          fail(e)
        }
      })
    })
  }

  private send(to: string, type: string, extra: Record<string, unknown> = {}): void {
    const body = JSON.stringify({ to, type, ...extra })
    this.sock.write(`${Buffer.byteLength(body)}:${body}`)
  }

  private recv(timeoutMs: number, what: string): Promise<unknown> {
    const pending = new Pending(false, timeoutMs, what)
    this.pending = pending
    return pending.promise
  }

  private request(to: string, type: string, extra?: Record<string, unknown>): Promise<unknown> {
    this.send(to, type, extra)
    return this.recv(120000, `RDP ${type}`)
  }

  async startProfiler(
    opts: {
      entries?: number
      interval?: number
      features?: string[]
      threads?: string[]
    } = {}
  ): Promise<void> {
    if (!this.perfActor) throw new Error('ProfilerCapture: not connected')
    const reply = (await this.request(this.perfActor, 'startProfiler', {
      entries: opts.entries ?? 1 << 28,
      interval: opts.interval ?? 1,
      features: opts.features ?? ['js', 'stackwalk', 'ipcmessages', 'cpu', 'cpuallthreads'],
      threads: opts.threads ?? ['GeckoMain', 'Worker']
    })) as Reply | null
    if (reply && 'error' in reply) {
      throw new Error(`startProfiler failed: ${String(reply.message ?? reply.error)}`)
    }
  }

  async isActive(): Promise<boolean> {
    if (!this.perfActor) throw new Error('ProfilerCapture: not connected')
    const reply = (await this.request(this.perfActor, 'isActive')) as Reply | null
    return reply !== null && typeof reply === 'object' && reply.value === true
  }

  /**
   * Stop the profiler, download the capture (a gzipped profile JSON over the
   * bulk transport), decompress and write it to `filePath`. Resolves with the
   * sampled thread names once the file is on disk.
   */
  async stopAndSave(filePath: string): Promise<string[]> {
    if (!this.perfActor) throw new Error('ProfilerCapture: not connected')
    const cap = (await this.request(this.perfActor, 'startCaptureAndStopProfiler')) as Reply | null
    if (!cap || typeof cap !== 'object' || typeof cap.value !== 'number') {
      throw new Error(`startCaptureAndStopProfiler: no handle (${JSON.stringify(cap)})`)
    }
    this.send(this.perfActor, 'getPreviouslyCapturedProfileDataBulk', { handle: cap.value })
    const gz = await this.recvBulk(300000)
    let json: string
    try {
      json = gunzipSync(gz).toString('utf8')
    } catch {
      json = gz.toString('utf8')
    }
    const profile = JSON.parse(json) as {
      threads?: Array<{ name?: string; processType?: string }>
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, json)
    return (profile.threads ?? []).map((t) => `${t.name ?? '?'} (${t.processType ?? '?'})`)
  }

  disconnect(): void {
    this.sock.destroy()
  }

  private recvBulk(timeoutMs: number): Promise<Buffer> {
    const pending = new Pending(true, timeoutMs, 'RDP bulk transfer')
    this.pending = pending
    return pending.promise as Promise<Buffer>
  }

  private onData(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    if (!this.pending) return
    if (this.pending.bulk) {
      if (this.bulkRemaining === null) {
        for (;;) {
          if (this.buf.length >= 5 && this.buf.subarray(0, 5).toString('latin1') === 'bulk ') {
            const sep = this.buf.indexOf(0x3a)
            if (sep >= 0) {
              const m = /^bulk (\S+) (\S+) (\d+):$/.exec(
                this.buf.subarray(0, sep + 1).toString('latin1')
              )
              if (m) {
                this.bulkRemaining = Number(m[3])
                this.buf = this.buf.subarray(sep + 1)
                break
              }
            }
            return
          }
          const sep = this.buf.indexOf(0x3a)
          if (sep < 0) return
          const len = parseInt(this.buf.subarray(0, sep).toString('latin1'), 10)
          if (Number.isNaN(len) || this.buf.length < sep + 1 + len) return
          this.buf = this.buf.subarray(sep + 1 + len)
        }
      }
      if (this.buf.length >= this.bulkRemaining!) {
        const payload = this.buf.subarray(0, this.bulkRemaining!)
        this.buf = this.buf.subarray(this.bulkRemaining!)
        this.bulkRemaining = null
        const p = this.pending
        this.pending = null
        p.resolve(payload)
      }
      return
    }
    for (;;) {
      const sep = this.buf.indexOf(0x3a)
      if (sep < 0) return
      const len = parseInt(this.buf.subarray(0, sep).toString('latin1'), 10)
      if (Number.isNaN(len) || this.buf.length < sep + 1 + len) return
      const payload = this.buf.subarray(sep + 1, sep + 1 + len)
      this.buf = this.buf.subarray(sep + 1 + len)
      let msg: unknown
      try {
        msg = JSON.parse(payload.toString('utf8'))
      } catch {
        continue
      }
      if (msg && typeof msg === 'object' && 'type' in msg) continue
      const p = this.pending
      this.pending = null
      p.resolve(msg)
      return
    }
  }
}
