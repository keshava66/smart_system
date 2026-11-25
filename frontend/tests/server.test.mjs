// @vitest-environment node
// Static production server (server.mjs). Run: npm test
import http from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer } from '../server.mjs';

const APP_JS = `export const answer = ${JSON.stringify('x'.repeat(4096))};\n`;
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const VIDEO = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

let dist;
let server;
let agent;
let port;

function request(urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const openDescriptors = () => readdirSync('/proc/self/fd').length;

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), 'smarthub-dist-'));
  mkdirSync(path.join(dist, 'assets'));
  mkdirSync(path.join(dist, 'fonts'));
  writeFileSync(path.join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), APP_JS);
  writeFileSync(path.join(dist, 'fonts', 'Display-Bold.otf'), Buffer.alloc(2048, 7));
  writeFileSync(path.join(dist, 'spinner.mp4'), VIDEO);
  writeFileSync(path.join(dist, '.env'), 'SECRET=1');
  writeFileSync(path.join(tmpdir(), 'outside-dist.txt'), 'outside');

  server = createStaticServer({ root: dist, accessLog: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
});

afterAll(async () => {
  agent.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dist, { recursive: true, force: true });
  rmSync(path.join(tmpdir(), 'outside-dist.txt'), { force: true });
});

describe('static server', () => {
  it('serves a hashed asset with long-lived cache headers', async () => {
    const res = await request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.toString()).toBe(APP_JS);
  });

  it('answers a matching ETag with 304 and no body', async () => {
    const first = await request('/assets/app-abc123.js');
    const res = await request('/assets/app-abc123.js', { headers: { 'If-None-Match': first.headers.etag } });
    expect(res.status).toBe(304);
    expect(res.body.length).toBe(0);
  });

  it('answers If-Modified-Since with 304', async () => {
    const first = await request('/fonts/Display-Bold.otf');
    const res = await request('/fonts/Display-Bold.otf', {
      headers: { 'If-Modified-Since': first.headers['last-modified'] },
    });
    expect(res.status).toBe(304);
  });

  it('serves a changed file after a deploy instead of 304', async () => {
    const first = await request('/fonts/Display-Bold.otf');
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(dist, 'fonts', 'Display-Bold.otf'), later, later);
    const res = await request('/fonts/Display-Bold.otf', { headers: { 'If-None-Match': first.headers.etag } });
    expect(res.status).toBe(200);
  });

  it.runIf(process.platform === 'linux')('does not leak file descriptors on 304 or 200 responses', async () => {
    const etag = (await request('/fonts/Display-Bold.otf')).headers.etag;
    await request('/spinner.mp4');
    const before = openDescriptors();

    for (let i = 0; i < 400; i += 1) {
      await request('/fonts/Display-Bold.otf', { headers: { 'If-None-Match': etag } });
      await request('/spinner.mp4');
      await request('/dashboard');
    }

    expect(openDescriptors() - before).toBeLessThanOrEqual(2);
  });

  it('compresses text with brotli or gzip depending on the client', async () => {
    const br = await request('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(APP_JS);

    const gz = await request('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip, br;q=0' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.body).toString()).toBe(APP_JS);
  });

  it('falls back to index.html for app routes, never cached', async () => {
    for (const route of ['/', '/dashboard', '/logout', '/data-api-view/42/sales.v2']) {
      const res = await request(route);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body.toString()).toBe(INDEX_HTML);
    }
  });

  it('returns 404 for a missing static file instead of HTML', async () => {
    const res = await request('/assets/old-chunk-999.js');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('refuses dotfiles and paths outside dist', async () => {
    for (const attempt of ['/.env', '/%2e%2e/outside-dist.txt', '/assets/..%2f..%2foutside-dist.txt', '/a%00b', '/..%5coutside-dist.txt']) {
      const res = await request(attempt);
      expect(res.status, attempt).toBe(404);
      expect(res.body.toString(), attempt).not.toContain('outside');
      expect(res.body.toString(), attempt).not.toContain('SECRET');
    }
  });

  it('serves byte ranges for video', async () => {
    const res = await request('/spinner.mp4', { headers: { Range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${VIDEO.length}`);
    expect([...res.body]).toEqual([...VIDEO.subarray(10, 20)]);

    const suffix = await request('/spinner.mp4', { headers: { Range: 'bytes=-5' } });
    expect([...suffix.body]).toEqual([...VIDEO.subarray(95)]);

    const bad = await request('/spinner.mp4', { headers: { Range: 'bytes=500-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${VIDEO.length}`);
  });

  it('answers HEAD with headers only', async () => {
    const res = await request('/spinner.mp4', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(VIDEO.length));
    expect(res.body.length).toBe(0);
  });

  it('rejects methods other than GET and HEAD', async () => {
    const res = await request('/', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });
});
