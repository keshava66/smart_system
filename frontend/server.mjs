// Production static server for the SmartHub build (dist/).
//
// Replaces `serve`, whose handler opened every file before answering 304 Not
// Modified and never closed it. Each cached page load leaked descriptors until
// the process hit EMFILE and crashed. Here conditional requests are answered
// from a stat() alone, and every opened file is closed whatever the outcome.
//
// Run:   npm run build && npm start
// Env:   PORT (3000), HOST (0.0.0.0), DIST_DIR (./dist),
//        TLS_CERT + TLS_KEY (PEM paths, enables HTTPS), ACCESS_LOG (1, set 0 to silence)

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest',
  '.txt', '.xml', '.svg', '.ico', '.otf', '.ttf', '.wasm',
]);

const COMPRESS_MIN_BYTES = 1024;
const COMPRESS_MAX_BYTES = 10 * 1024 * 1024;
const COMPRESS_CACHE_BYTES = 64 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'no-cache';
const CACHE_SHORT = 'public, max-age=3600';

// Keeps compressed bodies in memory so each file version is compressed once.
// Keys include size and mtime, so a new deploy never serves an old body.
class CompressedBodyCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
  }

  get(key, produce) {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.body;
    }

    const entry = { size: 0, body: null };
    entry.body = produce().then(
      (buffer) => {
        if (this.entries.get(key) === entry) {
          entry.size = buffer.length;
          this.bytes += buffer.length;
          this.evict();
        }
        return buffer;
      },
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, entry);
    return entry.body;
  }

  evict() {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) return;
      this.entries.delete(key);
      this.bytes -= entry.size;
    }
  }
}

function weakEtag(fileStat) {
  return `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
}

function isNotModified(req, etag, mtimeMs) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    const strip = (tag) => tag.trim().replace(/^W\//, '');
    const current = strip(etag);
    return ifNoneMatch.split(',').some((tag) => strip(tag) === current);
  }

  const ifModifiedSince = req.headers['if-modified-since'];
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

function pickEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const accepted = new Set();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

// Returns { start, end } for one satisfiable range, 'unsatisfiable', or null
// when the header should be ignored (absent, malformed or multi-range).
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function resolveTarget(root, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  if (pathname.split('/').some((segment) => segment.startsWith('.'))) return null;

  const absolute = path.join(root, pathname);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return { pathname, absolute };
}

function cacheControlFor(pathname, isAppShell) {
  if (isAppShell) return CACHE_REVALIDATE;
  if (pathname.startsWith('/assets/')) return CACHE_IMMUTABLE;
  return CACHE_SHORT;
}

function baseHeaders(isTls) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };
  if (isTls) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

async function statFile(absolute) {
  try {
    const fileStat = await stat(absolute);
    return fileStat.isFile() ? fileStat : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function readWhole(handle) {
  const fileStat = await handle.stat();
  const body = await handle.readFile();
  return { fileStat, body };
}

export function createStaticServer({ root, tls = null, accessLog = true, log = console }) {
  const distRoot = path.resolve(root);
  const appShell = path.join(distRoot, 'index.html');
  const compressedBodies = new CompressedBodyCache(COMPRESS_CACHE_BYTES);
  const securityHeaders = baseHeaders(Boolean(tls));

  function sendText(res, status, message, extraHeaders = {}) {
    const body = `${message}\n`;
    res.writeHead(status, {
      ...securityHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }

  async function locate(target) {
    const direct = await statFile(target.absolute);
    if (direct) {
      return { absolute: target.absolute, fileStat: direct, isAppShell: target.absolute === appShell };
    }

    // A missing file with a static extension is a real 404, not an app route:
    // returning HTML for a stale /assets/x.js only produces a MIME error.
    const extension = path.extname(target.pathname).toLowerCase();
    if (MIME_TYPES[extension]) return null;

    const shell = await statFile(appShell);
    return shell ? { absolute: appShell, fileStat: shell, isAppShell: true } : null;
  }

  async function serveCompressed(res, headers, absolute, encoding, isHead) {
    const handle = await open(absolute, 'r');
    let fileStat;
    let raw;
    try {
      ({ fileStat, body: raw } = await readWhole(handle));
    } finally {
      await handle.close();
    }

    const key = `${absolute}|${fileStat.size}|${fileStat.mtimeMs}|${encoding}`;
    const body = await compressedBodies.get(key, () => (
      encoding === 'br'
        ? brotli(raw, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
        : gzip(raw, { level: 9 })
    ));

    res.writeHead(200, {
      ...headers,
      ETag: weakEtag(fileStat),
      'Last-Modified': fileStat.mtime.toUTCString(),
      'Content-Encoding': encoding,
      'Content-Length': body.length,
    });
    res.end(isHead ? undefined : body);
  }

  async function serveStream(req, res, headers, absolute, isHead) {
    const handle = await open(absolute, 'r');
    let handedOff = false;
    try {
      const fileStat = await handle.stat();
      const etag = weakEtag(fileStat);
      const lastModified = fileStat.mtime.toUTCString();
      const fileHeaders = {
        ...headers,
        ETag: etag,
        'Last-Modified': lastModified,
        'Accept-Ranges': 'bytes',
      };

      // ETags here are weak, which If-Range may not match, so only the date form applies.
      const ifRange = req.headers['if-range'];
      const rangeAllowed = ifRange === undefined || ifRange.trim() === lastModified;
      const range = rangeAllowed ? parseRange(req.headers.range, fileStat.size) : null;

      if (range === 'unsatisfiable') {
        sendText(res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${fileStat.size}` });
        return;
      }

      const start = range ? range.start : 0;
      const end = range ? range.end : fileStat.size - 1;
      const length = fileStat.size === 0 ? 0 : end - start + 1;
      if (range) fileHeaders['Content-Range'] = `bytes ${start}-${end}/${fileStat.size}`;

      res.writeHead(range ? 206 : 200, { ...fileHeaders, 'Content-Length': length });
      if (isHead || length === 0) {
        res.end();
        return;
      }

      handedOff = true;
      const stream = handle.createReadStream({ start, end, autoClose: true });
      await pipeline(stream, res);
    } finally {
      if (!handedOff) await handle.close();
    }
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const target = resolveTarget(distRoot, req.url);
    if (!target) {
      sendText(res, 404, 'Not found');
      return;
    }

    const found = await locate(target);
    if (!found) {
      sendText(res, 404, 'Not found');
      return;
    }

    const { absolute, fileStat, isAppShell } = found;
    const extension = path.extname(absolute).toLowerCase();
    const compressible = COMPRESSIBLE.has(extension);
    const headers = {
      ...securityHeaders,
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(target.pathname, isAppShell),
    };
    if (compressible) headers.Vary = 'Accept-Encoding';

    const etag = weakEtag(fileStat);
    if (isNotModified(req, etag, fileStat.mtimeMs)) {
      res.writeHead(304, { ...headers, ETag: etag, 'Last-Modified': fileStat.mtime.toUTCString() });
      res.end();
      return;
    }

    const isHead = req.method === 'HEAD';
    const encoding = compressible && !req.headers.range ? pickEncoding(req.headers['accept-encoding']) : null;
    const worthCompressing = fileStat.size >= COMPRESS_MIN_BYTES && fileStat.size <= COMPRESS_MAX_BYTES;

    if (encoding && worthCompressing) {
      await serveCompressed(res, headers, absolute, encoding, isHead);
    } else {
      await serveStream(req, res, headers, absolute, isHead);
    }
  }

  function writeAccessLog(req, res, startedAt) {
    if (!accessLog) return;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.writableFinished ? res.statusCode : `${res.statusCode} aborted`;
    log.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${status} ${ms.toFixed(1)}ms`);
  }

  function onRequest(req, res) {
    const startedAt = process.hrtime.bigint();
    res.once('close', () => writeAccessLog(req, res, startedAt));

    handle(req, res).catch((error) => {
      if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      log.error(`${new Date().toISOString()} ${req.method} ${req.url} failed: ${error.code || ''} ${error.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error.code === 'EMFILE' || error.code === 'ENFILE') {
        sendText(res, 503, 'Server busy, retry shortly', { 'Retry-After': '1' });
        return;
      }
      sendText(res, 500, 'Internal server error');
    });
  }

  const server = tls ? createHttpsServer(tls, onRequest) : createHttpServer(onRequest);
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

function readConfig(env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, env.DIST_DIR || 'dist');
  const port = Number(env.PORT || 3000);
  const host = env.HOST || '0.0.0.0';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got "${env.PORT}"`);
  }
  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(`${path.join(root, 'index.html')} not found. Run "npm run build" first.`);
  }
  if (Boolean(env.TLS_CERT) !== Boolean(env.TLS_KEY)) {
    throw new Error('Set both TLS_CERT and TLS_KEY for HTTPS, or neither for HTTP.');
  }

  const tls = env.TLS_CERT
    ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) }
    : null;
  return { root, port, host, tls, accessLog: env.ACCESS_LOG !== '0' };
}

function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    console.error(`Cannot start: ${error.message}`);
    process.exit(1);
  }

  const server = createStaticServer(config);
  const scheme = config.tls ? 'https' : 'http';

  server.on('error', (error) => {
    const reason = error.code === 'EADDRINUSE'
      ? `port ${config.port} is already in use. Stop the old server first.`
      : error.message;
    console.error(`Cannot start: ${reason}`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(`${new Date().toISOString()} Serving ${config.root} on ${scheme}://${config.host}:${config.port}`);
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${new Date().toISOString()} ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    console.error(`${new Date().toISOString()} Uncaught error, exiting:`, error);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
