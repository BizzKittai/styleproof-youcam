#!/usr/bin/env node
// Local static preview only; no processing, credential or mutating endpoint.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_HASHES } from '../app/manifest.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const allowed = new Set(['index.html', 'styles.css', 'app.mjs', 'manifest.mjs', 'demo-manifest.json', ...Object.keys(ASSET_HASHES)]);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export function createHandler(root = APP_ROOT) {
  return async (request, response) => {
    const baseHeaders = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    function send(code, body, headers = {}) { response.writeHead(code, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers }); response.end(request.method === 'HEAD' ? undefined : body); }
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Static recorded demo only. No processing endpoint.', { Allow: 'GET, HEAD' });
    let filename;
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    } catch { return send(400, 'Invalid path.'); }
    if (!allowed.has(filename)) return send(404, 'Not found.');
    try {
      const bytes = await readFile(path.join(root, filename));
      return send(200, bytes, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream' });
    } catch { return send(404, 'Not found.'); }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2);
  const port = arg.length === 0 ? 4178 : Number(arg[0]);
  if (arg.length > 1 || !Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('Usage: node tools/serve-demo.mjs [port1024–65535]'); process.exitCode = 1;
  } else {
    const server = createServer(createHandler());
    server.on('error', () => { console.error('Local preview could not start. No provider request was made.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`StyleProof recorded-result preview: http://127.0.0.1:${port}`));
  }
}
