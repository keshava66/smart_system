// Production static server for the SmartHub build (dist/).
//
// Replaces `serve`, whose handler opened every file before answering 304 Not
// Modified and never closed it. Each cached page load leaked descriptors until
// the process hit EMFILE and crashed. Here conditional requests are answered
// from a stat() alone, and every opened file is closed whatever the outcome.
//
// A supervisor process runs WORKERS copies of the server, replaces any that
// die, owns the log file and rotates it by size. In production start it with
// scripts/frontend.sh, which also brings it back after a reboot (via cron).
//
// Env:   PORT (3000), HOST (0.0.0.0), DIST_DIR (./dist), WORKERS (2),
//        TLS_CERT + TLS_KEY (PEM paths, enables HTTPS),
//        LOG_FILE (unset: stdout), LOG_MAX_MB (50), LOG_KEEP (5),
//        PID_FILE (unset: none), ACCESS_LOG (1, set 0 to log errors only)
// Signals to the supervisor: TERM/INT stop gracefully, USR2 restarts workers
// one at a time with no downtime (use after replacing the TLS certificate).

import cluster from 'node:cluster';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import {
  createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import readline from 'node:readline';
import { createSecureContext } from 'node:tls';
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
const DRAIN_IDLE_MS = 1_000;
const HANDOFF_SETTLE_MS = 500;

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

    if (req.url === '/healthz') {
      try {
        await access(appShell);
        sendText(res, 200, 'ok');
      } catch {
        sendText(res, 503, 'build missing');
      }
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
    if (req.url === '/healthz' && res.statusCode === 200) return;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.writableFinished ? res.statusCode : `${res.statusCode} aborted`;
    log.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${status} ${ms.toFixed(1)}ms`);
  }

  function onRequest(req, res) {
    const startedAt = process.hrtime.bigint();
    if (server.draining) res.setHeader('Connection', 'close');
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


// Size-based rotation: frontend.log -> frontend.log.1 -> ... -> frontend.log.<keep>.
export class RotatingLog {
  constructor(file, { maxBytes, keep }) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    mkdirSync(path.dirname(file), { recursive: true });
    this.openStream();
  }

  openStream() {
    // Open synchronously so the file exists before the first rotation check.
    const fd = openSync(this.file, 'a');
    this.size = fstatSync(fd).size;
    this.stream = createWriteStream(null, { fd });
    this.stream.on('error', (error) => process.stderr.write(`Log write to ${this.file} failed: ${error.message}\n`));
  }

  write(line) {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    this.stream.write(text);
    this.size += bytes;
  }

  rotate() {
    // The old stream keeps its descriptor, so writes still queued land in .1.
    this.stream.end();
    try {
      for (let n = this.keep - 1; n >= 1; n -= 1) {
        const older = `${this.file}.${n}`;
        if (existsSync(older)) renameSync(older, `${this.file}.${n + 1}`);
      }
      if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    } catch (error) {
      process.stderr.write(`Log rotation of ${this.file} failed, continuing in the same file: ${error.message}\n`);
    }
    this.openStream();
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function readInteger(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

export function readConfig(env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, env.DIST_DIR || 'dist');

  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(`${path.join(root, 'index.html')} not found. Run "npm run build" first.`);
  }
  if (Boolean(env.TLS_CERT) !== Boolean(env.TLS_KEY)) {
    throw new Error('Set both TLS_CERT and TLS_KEY for HTTPS, or neither for HTTP.');
  }

  let tlsOptions = null;
  if (env.TLS_CERT) {
    tlsOptions = { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) };
    try {
      createSecureContext(tlsOptions);
    } catch (error) {
      throw new Error(`TLS_CERT / TLS_KEY are not a usable certificate and key: ${error.message}`, { cause: error });
    }
  }

  return {
    root,
    port: readInteger(env, 'PORT', 3000, 1, 65535),
    host: env.HOST || '0.0.0.0',
    tls: tlsOptions,
    workers: readInteger(env, 'WORKERS', 2, 1, 64),
    accessLog: env.ACCESS_LOG !== '0',
    logFile: env.LOG_FILE ? path.resolve(env.LOG_FILE) : null,
    logMaxBytes: readInteger(env, 'LOG_MAX_MB', 50, 1, 10_240) * 1024 * 1024,
    logKeep: readInteger(env, 'LOG_KEEP', 5, 1, 100),
    pidFile: env.PID_FILE ? path.resolve(env.PID_FILE) : null,
  };
}

const RESPAWN_DELAY_MS = 1_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_PER_WINDOW = 10;

function runPrimary(config) {
  const logFile = config.logFile
    ? new RotatingLog(config.logFile, { maxBytes: config.logMaxBytes, keep: config.logKeep })
    : null;
  const write = (line) => (logFile ? logFile.write(line) : process.stdout.write(`${line}\n`));
  const note = (message) => write(`${new Date().toISOString()} [supervisor] ${message}`);
  const scheme = config.tls ? 'https' : 'http';

  const retiring = new Set();
  const crashTimes = [];
  let stopping = false;
  let reloading = false;

  cluster.setupPrimary({ silent: Boolean(logFile) });

  if (config.pidFile) {
    mkdirSync(path.dirname(config.pidFile), { recursive: true });
    writeFileSync(config.pidFile, `${process.pid}\n`);
  }

  function fork() {
    const worker = cluster.fork();
    if (logFile) {
      for (const output of [worker.process.stdout, worker.process.stderr]) {
        readline.createInterface({ input: output, crlfDelay: Infinity }).on('line', write);
      }
    }
    worker.on('message', (message) => {
      if (message?.type !== 'fatal') return;
      if (reloading) {
        note(`new worker cannot start (${message.reason}); the running workers keep serving`);
        retiring.add(worker.id);
        return;
      }
      note(`cannot start: ${message.reason}`);
      stop(1);
    });
    return worker;
  }

  function retire(worker) {
    return new Promise((resolve) => {
      if (worker.isDead()) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => worker.process.kill('SIGKILL'), SHUTDOWN_GRACE_MS + 2_000);
      worker.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        worker.send({ type: 'shutdown' });
      } catch {
        worker.process.kill('SIGTERM');
      }
    });
  }

  function waitUntilListening(worker) {
    return new Promise((resolve) => {
      const onListening = () => finish(true);
      const onExit = () => finish(false);
      const finish = (started) => {
        worker.off('listening', onListening);
        worker.off('exit', onExit);
        resolve(started);
      };
      worker.once('listening', onListening);
      worker.once('exit', onExit);
    });
  }

  async function stop(code) {
    if (stopping) return;
    stopping = true;
    note('shutting down');
    await Promise.all(Object.values(cluster.workers).map(retire));
    if (config.pidFile && existsSync(config.pidFile)
      && readFileSync(config.pidFile, 'utf8').trim() === String(process.pid)) {
      rmSync(config.pidFile, { force: true });
    }
    note('stopped');
    if (logFile) await logFile.close();
    process.exit(code);
  }

  async function reload() {
    if (stopping || reloading) return;
    reloading = true;
    note('restarting workers one at a time');
    for (const old of Object.values(cluster.workers)) {
      if (stopping) break;
      const started = await waitUntilListening(fork());
      if (!started) {
        note('restart stopped early: a new worker failed to start');
        break;
      }
      retiring.add(old.id);
      await retire(old);
    }
    reloading = false;
    note('restart finished');
  }

  cluster.on('listening', (worker, address) => {
    note(`worker ${worker.process.pid} serving ${config.root} on ${scheme}://${config.host}:${address.port}`);
  });

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    if (retiring.delete(worker.id)) return;

    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift();
    note(`worker ${worker.process.pid} exited (${signal || `code ${code}`}), starting a replacement`);

    if (crashTimes.length > MAX_CRASHES_PER_WINDOW) {
      note(`${crashTimes.length} worker crashes within a minute, stopping`);
      stop(1);
      return;
    }
    setTimeout(() => {
      if (!stopping) fork();
    }, RESPAWN_DELAY_MS);
  });

  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  process.on('SIGUSR2', () => reload());
  process.on('uncaughtException', (error) => {
    note(`supervisor error, exiting: ${error.stack || error.message}`);
    process.exit(1);
  });

  note(`starting ${config.workers} worker(s), pid ${process.pid}`);
  for (let i = 0; i < config.workers; i += 1) fork();
}

function reportFatal(reason) {
  if (process.send) {
    process.send({ type: 'fatal', reason }, () => process.exit(1));
  } else {
    console.error(`Cannot start: ${reason}`);
    process.exit(1);
  }
}

function runWorker(config) {
  let server;
  try {
    server = createStaticServer(config);
  } catch (error) {
    reportFatal(error.message);
    return;
  }

  server.on('error', (error) => {
    reportFatal(error.code === 'EADDRINUSE'
      ? `port ${config.port} is already in use. Stop the old server first.`
      : error.message);
  });
  server.listen(config.port, config.host);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (!server.listening) {
      // Still starting up: nothing to drain, and closing now would race the listen.
      process.exit(0);
    }
    // http.Server#close() would also drop sockets that were accepted but have
    // not sent their request yet. Stop accepting at the net level instead,
    // answer what is in flight with Connection: close, and only then close
    // keep-alive sockets that are genuinely idle.
    // The exit waits a moment after the last socket closes: a connection the
    // supervisor handed over just before it saw this worker stop listening is
    // still in transit, and must be refused (so it goes to another worker)
    // rather than lost with the process.
    server.draining = true;
    net.Server.prototype.close.call(server, () => setTimeout(() => process.exit(0), HANDOFF_SETTLE_MS));
    setTimeout(() => server.closeIdleConnections(), DRAIN_IDLE_MS).unref();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('message', (message) => {
    if (message?.type === 'shutdown') shutdown();
  });
  process.on('SIGTERM', shutdown);
  // Ctrl+C reaches every process in the group; the supervisor decides what stops.
  process.on('SIGINT', () => {});
  // Stop taking connections, let in-flight requests finish, then exit so the
  // supervisor starts a clean replacement.
  process.on('uncaughtException', (error) => {
    console.error(`${new Date().toISOString()} [worker ${process.pid}] uncaught error, replacing this worker: ${error.stack || error.message}`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    shutdown();
  });
}

function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    reportFatal(error.message);
    return;
  }
  if (cluster.isPrimary) {
    runPrimary(config);
  } else {
    runWorker(config);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
