import { apiFetch, getAccessToken } from './apiClient';
import { msalInstance } from '../config/msalInstance';

// Every event is saved in localStorage before it is sent (one key per event,
// so two tabs can't overwrite each other) and removed only once the server
// has it. A failed send is retried with backoff, when the connection comes
// back, when the tab is shown again and on the next page load. Each event
// carries its own id, so the server ignores repeats and a retry is always safe.
const PREFIX = 'smarthub:audit:';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // the server won't age events further
const BATCH = 100;
const KEEPALIVE_MAX = 60_000;              // browsers cap keepalive bodies at 64 KB
const LOGOUT_WAIT_MS = 3000;
const COALESCE_MS = 50;

const memory = new Map();                  // used when storage is blocked
const inFlight = new Set();
let running = null;
let again = false;
let retryMs = 0;
let retryTimer = null;

const currentUser = () => {
  try {
    const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    return (account?.username || '').toLowerCase();
  } catch {
    return '';
  }
};

const newId = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function save(ev) {
  try {
    localStorage.setItem(PREFIX + ev.id, JSON.stringify(ev));
  } catch {
    memory.set(ev.id, ev);
  }
}

function remove(id) {
  memory.delete(id);
  try { localStorage.removeItem(PREFIX + id); } catch { /* storage blocked */ }
}

function pending() {
  const out = [...memory.values()];
  const bad = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try { out.push(JSON.parse(localStorage.getItem(key))); } catch { bad.push(key); }
    }
    bad.forEach(k => localStorage.removeItem(k));
  } catch { /* storage blocked: memory only */ }
  return out;
}

const wire = (e) => ({
  id: e.id, action: e.action, target: e.target, details: e.details, age_ms: Date.now() - e.at,
});

// payload is built only after the token is ready: age_ms is measured at that
// moment, so time spent getting the first token (often ~1s right after
// sign-in) isn't counted as zero age, which stamped user_login after the
// page views that followed it.
async function post(path, makePayload) {
  await getAccessToken();
  const body = JSON.stringify(makePayload());
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // lets the request finish while the tab is closing; only then, since a
    // browser that refuses keepalive here would fail every normal send too
    keepalive: document.visibilityState === 'hidden' && body.length < KEEPALIVE_MAX,
  });
}

// 'done' nothing left to send, 'more' sent a full batch, 'fail' try later
async function sendOnce() {
  const me = currentUser();
  if (!me) return 'done';                    // no account, no token: wait for sign-in
  // Pick the batch only once the token is ready and the events of the same
  // moment have landed: a login and the page view right after it then travel
  // together, so their order holds (sent apart, the first one's network time
  // made the login look later than the page view).
  await getAccessToken();
  await new Promise(resolve => setTimeout(resolve, COALESCE_MS));
  const now = Date.now();
  const batch = [];
  for (const ev of pending()) {
    if (!ev?.id || !ev.action || now - ev.at > MAX_AGE_MS) { if (ev?.id) remove(ev.id); continue; }
    // queued under another account: only that account may send it
    if (inFlight.has(ev.id) || (ev.user && ev.user !== me)) continue;
    batch.push(ev);
    if (batch.length >= BATCH) break;
  }
  if (!batch.length) return 'done';

  batch.forEach(e => inFlight.add(e.id));
  try {
    let res = await post('/api/audit/log/batch', () => ({ events: batch.map(wire) }));
    if (res.status === 404 || res.status === 405) {
      // older backend without /log/batch: one at a time
      for (const e of batch) {
        res = await post('/api/audit/log', () => wire(e));
        if (res.ok || res.status === 422) remove(e.id);
        else return 'fail';
      }
      return batch.length < BATCH ? 'done' : 'more';
    }
    if (res.ok) {
      batch.forEach(e => remove(e.id));
      return batch.length < BATCH ? 'done' : 'more';
    }
    if (res.status === 413 || res.status === 422) {
      // the server will never take this batch; keep it out of the loop
      console.warn('Audit events rejected by the server', res.status, batch);
      batch.forEach(e => remove(e.id));
      return 'more';
    }
    return 'fail';
  } catch {
    return 'fail';
  } finally {
    batch.forEach(e => inFlight.delete(e.id));
  }
}

function scheduleRetry() {
  retryMs = Math.min(Math.max(2000, retryMs * 2), 60_000);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flushAuditLog, retryMs);
}

/** Send whatever is queued. Safe to call any time; calls share one run. */
export function flushAuditLog() {
  if (running) { again = true; return running; }
  running = (async () => {
    for (;;) {
      again = false;
      let result;
      do { result = await sendOnce(); } while (result === 'more');
      if (result === 'fail') { scheduleRetry(); return; }
      retryMs = 0;
      if (!again) return;
    }
  })().finally(() => { running = null; });
  return running;
}

/**
 * Record a user action. Never throws and never blocks the caller for long:
 * the event is stored first, so it survives a failed request, a closed tab
 * or a sign-out, and is delivered later. The actor is always taken from the
 * signed-in token on the server; userEmail is kept for call-site compatibility.
 */
export const logAuditEvent = (action, userEmail, target = '', details = '') => {
  try {
    save({
      id: newId(),
      action: String(action || ''),
      target: String(target || ''),
      details: String(details || ''),
      at: Date.now(),
      user: currentUser() || String(userEmail || '').toLowerCase(),
    });
  } catch { /* nothing more we can do here */ }
  // Resolves when the send settles, or after LOGOUT_WAIT_MS at most, so a
  // sign-out that awaits it is never held up (the event stays queued).
  return Promise.race([
    flushAuditLog().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, LOGOUT_WAIT_MS)),
  ]);
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', flushAuditLog);
  window.addEventListener('pagehide', flushAuditLog);
  document.addEventListener('visibilitychange', flushAuditLog);
  // anything left by a closed tab or an outage, once MSAL is up
  setTimeout(flushAuditLog, 3000);
  setInterval(() => { if (!running) flushAuditLog(); }, 30_000);
}