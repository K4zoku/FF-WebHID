import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { once } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.bin': 'application/octet-stream',
};

export async function startServer() {
  const server = http.createServer((req, res) => {
    const filePath = path.join(projectRoot, req.url === '/' ? '/index.html' : req.url);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  return { port, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.argv[2] || '0', 10) || 0;
  http.createServer((req, res) => {
    const filePath = path.join(projectRoot, req.url === '/' ? '/index.html' : req.url);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(port, () => {
    const addr = this.address();
    process.stdout.write(String(addr?.port || port));
  });
}
