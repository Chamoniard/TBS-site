#!/usr/bin/env node
/**
 * Local static file server for this site.
 * Uses Node's async I/O so one slow iCloud read cannot wedge the whole process
 * (unlike single-threaded / half-dead Python http.server).
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0].split('#')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.resolve(root, '.' + (cleaned.startsWith('/') ? cleaned : `/${cleaned}`));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = await fsp.stat(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    let rel = req.url || '/';
    if (rel === '/') rel = '/index.html';

    let filePath = safeJoin(ROOT, rel);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        st = await fsp.stat(filePath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
    }

    if (req.method === 'HEAD') {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    await sendFile(res, filePath);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.requestTimeout = 120000;
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;
server.maxConnections = 200;

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill it, then retry:`);
    console.error(`  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Serving (node) from:');
  console.log(' ', ROOT);
  console.log('Open:');
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log('Backend:');
  console.log(`  http://localhost:${PORT}/backend.html`);
  console.log('Login:');
  console.log(`  http://localhost:${PORT}/login.html`);
  console.log('(Use localhost for Firebase Google sign-in.)');
  console.log('Stop: Ctrl+C');
});
