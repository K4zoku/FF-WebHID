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
};

const HEADERS: Record<string, Record<string, string>> = {
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
};

export async function startPolicyServer(port = 0): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/self-script') {
      const dest = (req.headers['sec-fetch-dest'] || '').toLowerCase();
      const isDocument =
        dest === 'document' ||
        (!dest && (req.headers.accept || '').includes('text/html'));
      res.writeHead(200, {
        'Content-Type': isDocument ? 'text/html' : 'application/javascript',
        'Cache-Control': 'no-store',
      });
      res.end(isDocument ? loadPage('self-script.html') : 'self.selfScriptRan = true;\n');
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
