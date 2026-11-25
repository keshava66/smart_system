// @vitest-environment node
// Supervisor, config and log rotation for server.mjs. Run: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RotatingLog, readConfig } from '../server.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let work;
let dist;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(50);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false, timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DIST_DIR: dist, HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

const workerPids = (log) => [...log.matchAll(/worker (\d+) serving/g)].map((m) => Number(m[1]));

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'smarthub-supervisor-'));
  dist = path.join(work, 'dist');
  mkdirSync(dist);
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SmartHub</title>');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('uses production defaults', () => {
    const config = readConfig({ DIST_DIR: dist });
    expect(config).toMatchObject({ port: 3000, host: '0.0.0.0', workers: 2, tls: null, accessLog: true, logKeep: 5 });
    expect(config.logMaxBytes).toBe(50 * 1024 * 1024);
  });

  it('refuses a missing build', () => {
    expect(() => readConfig({ DIST_DIR: path.join(work, 'nope') })).toThrow(/npm run build/);
  });

  it('refuses invalid numbers', () => {
    expect(() => readConfig({ DIST_DIR: dist, PORT: '80a' })).toThrow(/PORT/);
    expect(() => readConfig({ DIST_DIR: dist, PORT: '70000' })).toThrow(/PORT/);
    expect(() => readConfig({ DIST_DIR: dist, WORKERS: '0' })).toThrow(/WORKERS/);
  });

  it('refuses half or broken TLS settings', () => {
    expect(() => readConfig({ DIST_DIR: dist, TLS_CERT: '/x.pem' })).toThrow(/both TLS_CERT and TLS_KEY/);
    const bad = path.join(work, 'bad.pem');
    writeFileSync(bad, 'not a certificate');
    expect(() => readConfig({ DIST_DIR: dist, TLS_CERT: bad, TLS_KEY: bad })).toThrow(/not a usable certificate/);
  });
});

describe('RotatingLog', () => {
  it('rotates by size and keeps only the configured number of files', async () => {
    const dir = path.join(work, 'rotate');
    const file = path.join(dir, 'frontend.log');
    const log = new RotatingLog(file, { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 20; i += 1) log.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(30)}`);
    await log.close();

    expect(readdirSync(dir).sort()).toEqual(['frontend.log', 'frontend.log.1', 'frontend.log.2']);
    for (const name of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, name)).length).toBeLessThanOrEqual(100);
    }
    expect(readFileSync(file, 'utf8')).toContain('line 19');
  });
});

describe.runIf(process.platform === 'linux')('supervisor', () => {
  it('replaces a crashed worker, reloads without downtime and stops cleanly', async () => {
    const port = await freePort();
    const logFile = path.join(work, 'run1', 'frontend.log');
    const pidFile = path.join(work, 'run1', 'frontend.pid');
    const server = startServer({ PORT: String(port), WORKERS: '2', LOG_FILE: logFile, PID_FILE: pidFile });
    const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');

    await waitFor(() => workerPids(log()).length === 2);
    expect(await health(port)).toBe(200);
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(server.child.pid));

    const [crashed, survivor] = workerPids(log());
    process.kill(crashed, 'SIGKILL');
    await waitFor(() => log().includes(`worker ${crashed} exited (SIGKILL)`));
    await waitFor(() => workerPids(log()).length === 3);
    const replacement = workerPids(log())[2];
    expect([crashed, survivor]).not.toContain(replacement);
    expect(await health(port)).toBe(200);

    let failedChecks = 0;
    let polling = true;
    const poller = (async () => {
      while (polling) {
        if (await health(port) !== 200) failedChecks += 1;
      }
    })();
    process.kill(server.child.pid, 'SIGUSR2');
    await waitFor(() => log().includes('restart finished'), 20_000);
    polling = false;
    await poller;
    expect(failedChecks).toBe(0);
    expect(workerPids(log()).length).toBe(5);

    process.kill(server.child.pid, 'SIGTERM');
    expect(await server.exited).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
    expect(log()).toContain('[supervisor] stopped');
  }, 40_000);

  it('exits with an error instead of looping when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();

    const logFile = path.join(work, 'run2', 'frontend.log');
    const server = startServer({ PORT: String(port), WORKERS: '2', LOG_FILE: logFile });
    expect(await server.exited).toBe(1);
    expect(readFileSync(logFile, 'utf8')).toContain(`port ${port} is already in use`);

    await new Promise((resolve) => blocker.close(resolve));
  }, 20_000);

  it('reports a bad configuration on stderr and exits', async () => {
    const server = startServer({ PORT: 'abc' });
    expect(await server.exited).toBe(1);
    expect(server.output()).toContain('PORT must be a whole number');
  });
});
