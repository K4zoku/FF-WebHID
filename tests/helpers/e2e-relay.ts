import { sendInput, type WebhidMockProcess } from './e2e-process.js'

export interface RelayHandle {
  chunks: number[][]
  stop(): void
}

function makeLineScanner(onLine: (line: string) => void): (data: Buffer) => void {
  let pending = ''
  return (data: Buffer) => {
    pending += data.toString()
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (!line) continue
      onLine(line)
    }
  }
}

export function startStreamingRelay(mock: WebhidMockProcess): RelayHandle {
  const chunks: number[][] = []
  const onData = makeLineScanner((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: string; data?: number[] }
      if (parsed.event === 'output_report' && Array.isArray(parsed.data)) {
        chunks.push(parsed.data)
        sendInput(mock, 1, parsed.data.slice(1))
      }
    } catch {}
  })
  mock.process.stdout!.on('data', onData)
  return {
    chunks,
    stop: () => mock.process.stdout!.off('data', onData)
  }
}
