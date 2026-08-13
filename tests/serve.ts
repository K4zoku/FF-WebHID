import http from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { readFile } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ServerHandle {
  port: number
  server: http.Server
}

function getPort(server: http.Server): number {
  const addr = server.address()
  if (typeof addr === 'object' && addr !== null) {
    return addr.port
  }
  throw new Error('Server is not listening on a TCP port')
}

async function listen(server: http.Server, port = 0): Promise<ServerHandle> {
  server.listen(port)
  await once(server, 'listening')
  return { port: getPort(server), server }
}

function loadPage(name: string): string {
  const pagePath = resolve(__dirname, 'pages', name)
  return readFileSync(pagePath, 'utf-8')
}

const PAGES: Record<string, string> = {
  '/policy-check': loadPage('policy-check.html'),
  '/policy-check-blocked': loadPage('policy-check.html'),
  '/policy-check-allowed-self': loadPage('policy-check.html'),
  '/policy-check-allowed-all': loadPage('policy-check.html'),
  '/iframe-parent': loadPage('iframe-parent.html'),
  '/iframe-child-no-allow': loadPage('iframe-child.html'),
  '/iframe-child-with-allow': loadPage('iframe-child.html'),
  '/iframe-child-forge': loadPage('iframe-child-forge.html'),
  '/tt-policy': loadPage('tt-policy.html'),
  '/tt-policy-sinks': loadPage('tt-policy-sinks.html'),
  '/tt-policy-no-url': loadPage('tt-policy-no-url.html'),
  '/tt-policy-restricted': loadPage('tt-policy-restricted.html'),
  '/worker.js': loadPage('worker.js'),
  '/worker-plain.js': loadPage('worker-plain.js'),
  '/worker-polyfilled.js': loadPage('worker-polyfilled.js'),
  '/worker-race.js': loadPage('worker-race.js'),
  '/race-probe': loadPage('race-probe.html'),
  '/main-world-race-probe': loadPage('main-world-race-probe.html'),
  '/sri-check': loadPage('sri-check.html'),
  '/sri-test.js': loadPage('sri-test.js'),
  '/activation': loadPage('activation.html'),
  '/worker-spawn-csp': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-restrictive': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-trusted-types': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-connect': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-allowing': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-no-csp': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-meta': loadPage('worker-spawn-csp-meta.html'),
  '/worker-spawn-csp-both': loadPage('worker-spawn-csp-meta.html'),
  '/worker-spawn-csp-default-none': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-script-none': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-default-self': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-worker-none': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-report-only': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-multi': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-dup': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-star': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-ws-scheme': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-rewrite-script': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-rewrite-default': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-tt-append': loadPage('worker-spawn-csp.html'),
  '/worker-spawn-csp-tt-new': loadPage('worker-spawn-csp.html')
}

const HEADERS: Record<string, Record<string, string | string[]>> = {
  '/policy-check': {},
  '/policy-check-blocked': {
    'Permissions-Policy': 'hid=()'
  },
  '/policy-check-allowed-self': {
    'Permissions-Policy': 'hid=self'
  },
  '/policy-check-allowed-all': {
    'Permissions-Policy': 'hid=*'
  },
  '/worker-spawn-csp': {
    'Content-Security-Policy': "worker-src 'self'; connect-src 'self'"
  },
  '/worker-spawn-csp-restrictive': {
    'Content-Security-Policy': "worker-src 'none'; connect-src 'none'"
  },
  '/worker-spawn-csp-trusted-types': {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types webhid-worker"
  },
  '/worker-spawn-csp-connect': {
    'Content-Security-Policy': "connect-src 'self'"
  },
  '/worker-spawn-csp-allowing': {
    'Content-Security-Policy': "worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*"
  },
  '/worker-spawn-csp-both': {
    'Content-Security-Policy': "connect-src 'self'"
  },
  '/worker-spawn-csp-default-none': {
    'Content-Security-Policy': "default-src 'none'"
  },
  '/worker-spawn-csp-script-none': {
    'Content-Security-Policy': "script-src 'none'"
  },
  '/worker-spawn-csp-default-self': {
    'Content-Security-Policy': "default-src 'self'"
  },
  '/worker-spawn-csp-worker-none': {
    'Content-Security-Policy': "worker-src 'none'"
  },
  '/worker-spawn-csp-report-only': {
    'Content-Security-Policy-Report-Only': "worker-src 'none'"
  },
  '/worker-spawn-csp-multi': {
    'Content-Security-Policy': ["worker-src 'self'", "connect-src 'self'"]
  },
  '/worker-spawn-csp-dup': {
    'Content-Security-Policy': "worker-src *; worker-src 'none'"
  },
  '/worker-spawn-csp-star': {
    'Content-Security-Policy': 'worker-src *; connect-src *'
  },
  '/worker-spawn-csp-ws-scheme': {
    'Content-Security-Policy': "worker-src 'self' blob:; connect-src ws:"
  },
  '/worker-spawn-csp-rewrite-script': {
    'Content-Security-Policy': "script-src 'self'; connect-src 'self'"
  },
  '/worker-spawn-csp-rewrite-default': {
    'Content-Security-Policy': "default-src 'self'"
  },
  '/worker-spawn-csp-tt-append': {
    'Content-Security-Policy':
      "require-trusted-types-for 'script'; trusted-types foo; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*"
  },
  '/worker-spawn-csp-tt-new': {
    'Content-Security-Policy':
      "require-trusted-types-for 'script'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*"
  },
  '/tt-policy': {
    'Content-Security-Policy': 'trusted-types webhid-worker default'
  },
  '/tt-policy-sinks': {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types uRGq7 default"
  },
  '/tt-policy-no-url': {
    'Content-Security-Policy': 'trusted-types uRGq7 default'
  },
  '/tt-policy-restricted': {
    'Content-Security-Policy': 'trusted-types uRGq7 default'
  }
}

interface GatedRecord {
  dest: string | null
  mode: string | null
  site: string | null
  user: string | null
  accept: string | null
  status: number
}

let lastGated: GatedRecord = {
  dest: null,
  mode: null,
  site: null,
  user: null,
  accept: null,
  status: 0
}

const shadowRedirectCounts = new Map<string, number>()

function recordGated(req: http.IncomingMessage, status: number): GatedRecord {
  return {
    dest: (req.headers['sec-fetch-dest'] || '').toLowerCase() || null,
    mode: (req.headers['sec-fetch-mode'] || '').toLowerCase() || null,
    site: (req.headers['sec-fetch-site'] || '').toLowerCase() || null,
    user: req.headers['sec-fetch-user'] || null,
    accept: req.headers['accept'] || null,
    status
  }
}

function handleDestGated(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): boolean {
  if (pathname !== '/dest-gated') return false
  const dest = (req.headers['sec-fetch-dest'] || '').toLowerCase()
  if (dest === 'worker') {
    lastGated = recordGated(req, 403)
    res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('forbidden')
    return true
  }
  lastGated = recordGated(req, 200)
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
  res.end(loadPage('dest-gated.html'))
  return true
}

function handleShadowRedirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): boolean {
  const redirectChain = /^\/shadow-redirect-chain\/([^/]+)\/(\d+)$/.exec(pathname)
  if (!redirectChain) return false
  const [, token, stepsStr] = redirectChain
  const steps = Number(stepsStr)
  const count = (shadowRedirectCounts.get(token) || 0) + 1
  shadowRedirectCounts.set(token, count)
  if (count === 1) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    res.end(loadPage('dest-gated.html'))
    return true
  }
  if (steps > 0) {
    res.writeHead(302, {
      Location: `/shadow-redirect-chain/${token}/${steps - 1}`,
      'Cache-Control': 'no-store'
    })
    res.end()
    return true
  }
  lastGated = recordGated(req, 200)
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
  res.end(loadPage('dest-gated.html'))
  return true
}

function handleSelfWorker(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): boolean {
  if (pathname !== '/self-worker') return false
  const mode = (req.headers['sec-fetch-mode'] || '').toLowerCase()
  const isWorker = mode !== '' && mode !== 'navigate'
  res.writeHead(200, {
    'Content-Type': isWorker ? 'application/javascript' : 'text/html',
    'Cache-Control': 'no-store'
  })
  res.end(isWorker ? "self.postMessage('page-worker-ran');\n" : loadPage('self-worker.html'))
  return true
}

function handleLastDest(res: http.ServerResponse, pathname: string): boolean {
  if (pathname !== '/last-dest') return false
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(lastGated))
  return true
}

function handleSelfScript(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): boolean {
  if (pathname !== '/self-script') return false
  const dest = (req.headers['sec-fetch-dest'] || '').toLowerCase()
  const isDocument =
    dest === 'document' || (!dest && (req.headers.accept || '').includes('text/html'))
  res.writeHead(200, {
    'Content-Type': isDocument ? 'text/html' : 'application/javascript',
    'Cache-Control': 'no-store'
  })
  res.end(
    isDocument
      ? loadPage('self-script.html')
      : '(self.tests = self.tests || { results: {} }).results.selfScriptRan = true;\n'
  )
  return true
}

function servePage(res: http.ServerResponse, pathname: string): void {
  const body = PAGES[pathname]
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  const headers = HEADERS[pathname] || {}
  res.writeHead(200, {
    'Content-Type': pathname.endsWith('.js') ? 'application/javascript' : 'text/html',
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(body)
}

export async function startPolicyServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]
    if (
      handleDestGated(req, res, pathname) ||
      handleShadowRedirect(req, res, pathname) ||
      handleSelfWorker(req, res, pathname) ||
      handleLastDest(res, pathname) ||
      handleSelfScript(req, res, pathname)
    ) {
      return
    }
    servePage(res, pathname)
  })
  return listen(server, port)
}

const projectRoot = resolve(__dirname, '..')

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream'
}

export async function startStaticServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const filePath = join(projectRoot, req.url === '/' ? '/index.html' : (req.url ?? '/'))
    const resolved = resolve(filePath)
    if (!resolved.startsWith(projectRoot + '/')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    const ext = extname(resolved)
    readFile(resolved, (err, data) => {
      if (err) {
        res.end('Not found')
        return
      }
      const headers: Record<string, string> = {
        'Content-Type': MIME[ext] || 'application/octet-stream'
      }

      if (req.url === '/tests/pages/benchmark-image.html') {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  })
  return listen(server, port)
}
