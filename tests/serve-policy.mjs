import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPage(name) {
  const path = resolve(__dirname, 'pages', name);
  return readFileSync(path, 'utf-8');
}

const PAGES = {
  '/policy-check': loadPage('policy-check.html'),
  '/policy-check-blocked': loadPage('policy-check.html'),
  '/policy-check-allowed-self': loadPage('policy-check.html'),
  '/policy-check-allowed-all': loadPage('policy-check.html'),
  '/iframe-parent': loadPage('iframe-parent.html'),
  '/iframe-child-no-allow': loadPage('iframe-child.html'),
  '/iframe-child-with-allow': loadPage('iframe-child.html'),
  '/worker-check': loadPage('worker-check.html'),
  '/worker.js': loadPage('worker.js'),
  '/worker-polyfill-check': loadPage('worker-polyfill-check.html'),
  '/worker-polyfill.js': loadPage('worker-polyfill.js'),
  '/worker-strict.js': loadPage('worker-strict.js'),
};

const HEADERS = {
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

export function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = req.url.split('?')[0];
      const body = PAGES[pathname];
      if (!body) {
        res.writeHead(404);
        res.end('not found: ' + req.url);
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
    server.listen(port, () => {
      resolve({ port, server });
    });
  });
}
