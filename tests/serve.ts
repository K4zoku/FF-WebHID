import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { readFile } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ServerHandle {
  port: number;
  server: http.Server;
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    return addr.port;
  }
  throw new Error('Server is not listening on a TCP port');
}

async function listen(server: http.Server, port = 0): Promise<ServerHandle> {
  server.listen(port);
  await once(server, 'listening');
  return { port: getPort(server), server };
}

// --- Policy server: in-memory page map + per-route Permissions-Policy headers ---

function loadPage(name: string): string {
  const pagePath = resolve(__dirname, 'pages', name);
  return readFileSync(pagePath, 'utf-8');
}

const PAGES: Record<string, string> = {
  '/policy-check': loadPage('policy-check.html'),
  '/policy-check-blocked': loadPage('policy-check.html'),
  '/policy-check-allowed-self': loadPage('policy-check.html'),
  '/policy-check-allowed-all': loadPage('policy-check.html'),
  '/iframe-parent': loadPage('iframe-parent.html'),
  '/iframe-child-no-allow': loadPage('iframe-child.html'),
  '/iframe-child-with-allow': loadPage('iframe-child.html'),
  '/worker-check': loadPage('worker-check.html'),
  '/worker.js': loadPage('worker.js'),
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
  '/worker-spawn-csp-tt-new': loadPage('worker-spawn-csp.html'),
};

const HEADERS: Record<string, Record<string, string | string[]>> = {
  '/policy-check': {},
  '/policy-check-blocked': {
    'Permissions-Policy': 'hid=()',
  },
  '/policy-check-allowed-self': {
    'Permissions-Policy': 'hid=self',
  },
  '/policy-check-allowed-all': {
    'Permissions-Policy': 'hid=*',
  },
  '/worker-spawn-csp': {
    'Content-Security-Policy': "worker-src 'self'; connect-src 'self'",
  },
  '/worker-spawn-csp-restrictive': {
    'Content-Security-Policy': "worker-src 'none'; connect-src 'none'",
  },
  '/worker-spawn-csp-trusted-types': {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types webhid-worker",
  },
  '/worker-spawn-csp-connect': {
    'Content-Security-Policy': "connect-src 'self'",
  },
  '/worker-spawn-csp-allowing': {
    'Content-Security-Policy': "worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*",
  },
  '/worker-spawn-csp-both': {
    'Content-Security-Policy': "connect-src 'self'",
  },
  '/worker-spawn-csp-default-none': {
    'Content-Security-Policy': "default-src 'none'",
  },
  '/worker-spawn-csp-script-none': {
    'Content-Security-Policy': "script-src 'none'",
  },
  '/worker-spawn-csp-default-self': {
    'Content-Security-Policy': "default-src 'self'",
  },
  '/worker-spawn-csp-worker-none': {
    'Content-Security-Policy': "worker-src 'none'",
  },
  '/worker-spawn-csp-report-only': {
    'Content-Security-Policy-Report-Only': "worker-src 'none'",
  },
  '/worker-spawn-csp-multi': {
    'Content-Security-Policy': ["worker-src 'self'", "connect-src 'self'"],
  },
  '/worker-spawn-csp-dup': {
    'Content-Security-Policy': "worker-src *; worker-src 'none'",
  },
  '/worker-spawn-csp-star': {
    'Content-Security-Policy': "worker-src *; connect-src *",
  },
  '/worker-spawn-csp-ws-scheme': {
    'Content-Security-Policy': "worker-src 'self' blob:; connect-src ws:",
  },
  '/worker-spawn-csp-rewrite-script': {
    'Content-Security-Policy': "script-src 'self'; connect-src 'self'",
  },
  '/worker-spawn-csp-rewrite-default': {
    'Content-Security-Policy': "default-src 'self'",
  },
  '/worker-spawn-csp-tt-append': {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types foo; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*",
  },
  '/worker-spawn-csp-tt-new': {
    'Content-Security-Policy': "require-trusted-types-for 'script'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*",
  },
};

// Records the Sec-Fetch-Dest seen by the most recent /dest-gated request, so
// tests can assert whether the addon rewrote the worker self-request header.
let lastGatedDest: string | null = null;
let lastGatedStatus = 0;

export async function startPolicyServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/dest-gated') {
      const dest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
      lastGatedDest = dest || null;
      if (dest === 'worker') {
        // Simulates a server that rejects worker-destination requests.
        lastGatedStatus = 403;
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('forbidden');
        return;
      }
      lastGatedStatus = 200;
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(loadPage('dest-gated.html'));
      return;
    }
    if (pathname === '/self-worker') {
      // Sec-Fetch-Mode distinguishes the navigation ("navigate") from the
      // worker self-request ("same-origin"); Sec-Fetch-Dest cannot be used
      // here because the addon rewrites it to "document" for the worker
      // self-request.
      const mode = (req.headers['sec-fetch-mode'] || '').toLowerCase();
      const isWorker = mode !== '' && mode !== 'navigate';
      res.writeHead(200, {
        'Content-Type': isWorker ? 'application/javascript' : 'text/html',
        'Cache-Control': 'no-store',
      });
      res.end(isWorker ? "self.postMessage('page-worker-ran');\n" : loadPage('self-worker.html'));
      return;
    }
    if (pathname === '/last-dest') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ dest: lastGatedDest, status: lastGatedStatus }));
      return;
    }
    if (pathname === '/self-script') {
      const dest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
      const isDocument =
        dest === 'document' ||
        (!dest && (req.headers.accept || '').includes('text/html'));
      res.writeHead(200, {
        'Content-Type': isDocument ? 'text/html' : 'application/javascript',
        'Cache-Control': 'no-store',
      });
      res.end(isDocument ? loadPage('self-script.html') : '(self.tests = self.tests || { results: {} }).results.selfScriptRan = true;\n');
      return;
    }
    const body = PAGES[pathname];
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const headers = HEADERS[pathname] || {};
    res.writeHead(200, {
      'Content-Type': pathname.endsWith('.js') ? 'application/javascript' : 'text/html',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  });
  return listen(server, port);
}

// --- Static server: filesystem, rooted at the tests/ directory ---

const projectRoot = resolve(__dirname, '..');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream',
};

export async function startStaticServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const filePath = join(projectRoot, req.url === '/' ? '/index.html' : req.url ?? '/');
    const resolved = resolve(filePath);
    if (!resolved.startsWith(projectRoot + '/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const ext = extname(resolved);
    readFile(resolved, (err, data) => {
      if (err) {
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return listen(server, port);
}
