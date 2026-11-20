// Shared worksheets in Data Studio, the browser side: the text merge, the
// session that keeps one worksheet in step with the server
// (backend/shared_worksheets.py), and the layer that draws the others' cursors.
import React, { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';

// One file on purpose: hot reload of this file reloads the page, which is fine.
/* eslint-disable react-refresh/only-export-components */

// ---- Text operations. Has to agree with
// backend/shared_worksheets.py, which does the same maths on the server.
//
// An operation walks the whole text once: a positive number keeps that many
// UTF-16 units, a string inserts it, a negative number deletes that many.
// "abc" -> "abXc" is [2, "X", 1].

const isIns = (p) => typeof p === 'string';

function push(out, part) {
  if (part === 0 || part === '') return;
  const last = out[out.length - 1];
  if (out.length && isIns(part) && isIns(last)) out[out.length - 1] = last + part;
  else if (out.length && !isIns(part) && !isIns(last) && (part > 0) === (last > 0)) out[out.length - 1] = last + part;
  else out.push(part);
}

function apply(text, op) {
  let out = '';
  let i = 0;
  op.forEach(part => {
    if (isIns(part)) out += part;
    else if (part > 0) { out += text.slice(i, i + part); i += part; }
    else i -= part;
  });
  if (i !== text.length) throw new Error('Edit does not fit the text');
  return out;
}

// Two edits made against the same text. Returns [a2, b2] so that a then b2
// gives the same text as b then a2. Same-spot inserts: a's text goes first.
// Always call it with this browser's own edit as `a`; the server does too.
function transform(a, b) {
  const a2 = [];
  const b2 = [];
  let ia = 0;
  let ib = 0;
  let pa = a[0];
  let pb = b[0];
  while (pa !== undefined || pb !== undefined) {
    if (isIns(pa)) { push(a2, pa); push(b2, pa.length); pa = a[++ia]; continue; }
    if (isIns(pb)) { push(a2, pb.length); push(b2, pb); pb = b[++ib]; continue; }
    if (pa === undefined || pb === undefined) throw new Error('Edits were made against different text');
    const n = Math.min(Math.abs(pa), Math.abs(pb));
    if (pa > 0 && pb > 0) { push(a2, n); push(b2, n); }
    else if (pa < 0 && pb > 0) push(a2, -n);
    else if (pa > 0 && pb < 0) push(b2, -n);
    pa = pa > 0 ? pa - n : pa + n;
    pb = pb > 0 ? pb - n : pb + n;
    if (pa === 0) pa = a[++ia];
    if (pb === 0) pb = b[++ib];
  }
  return [a2, b2];
}

// One edit that does what a then b does.
function compose(a, b) {
  const out = [];
  let ia = 0;
  let ib = 0;
  let pa = a[0];
  let pb = b[0];
  while (pa !== undefined || pb !== undefined) {
    if (!isIns(pa) && pa < 0) { push(out, pa); pa = a[++ia]; continue; }
    if (isIns(pb)) { push(out, pb); pb = b[++ib]; continue; }
    if (pa === undefined || pb === undefined) throw new Error('Edits do not follow each other');
    const lenA = isIns(pa) ? pa.length : pa;
    const n = Math.min(lenA, Math.abs(pb));
    if (isIns(pa)) {
      if (pb > 0) push(out, pa.slice(0, n));      // typed, then kept
      pa = pa.slice(n) || a[++ia];                // typed, then deleted: gone
    } else {
      push(out, pb > 0 ? n : -n);
      pa = pa - n || a[++ia];
    }
    pb = pb > 0 ? pb - n : pb + n;
    if (pb === 0) pb = b[++ib];
  }
  return out;
}

// Where a cursor at pos ends up after op.
function transformPos(pos, op) {
  let next = pos;
  let left = pos;
  for (const part of op) {
    if (isIns(part)) next += part.length;
    else if (part > 0) left -= part;
    else { next -= Math.min(left, -part); left += part; }
    if (left < 0) break;
  }
  return Math.max(0, next);
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

// The edit that turns `before` into `after`, or null when they are the same.
// One keystroke, paste or format is always one changed stretch.
function diff(before, after) {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end += 1;
  // Never cut an emoji in half: the server refuses that.
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start -= 1;
  if (end > 0 && isLow(before.charCodeAt(before.length - end))) end -= 1;
  const op = [];
  push(op, start);
  push(op, after.slice(start, after.length - end));
  push(op, -(before.length - start - end));
  push(op, end);
  return op;
}

// ---- Session

// One shared worksheet, as this browser sees it.
//
// The server holds the text at a revision. This side keeps at most one edit
// on its way to the server (inflight) and one more that collects everything
// typed since (buffer). An edit by someone else arrives on the stream, is
// rebased over those two and applied to the text on screen. Our own edit
// coming back on the stream is the server saying "got it".
//
// Nothing here knows about React or fetch: `api` and `on` are passed in.
//   api.post(path, body)      -> promise, rejects with { status, body }
//   api.stream(path)          -> EventSource-like (see apiEventSource)
//   on.text(text, mapPos)     -> the text changed because of someone else;
//                                mapPos moves a cursor position along with it
//   on.change()               -> meta / status changed, re-read them
//   on.event({ type, ... })   -> someone joined or left
// Cursors move far more often than anything else, so they have their own
// channel: subscribe(fn) + peersRev. Only what draws cursors listens there.
//   on.lost(text)             -> local edits could not be merged; `text` is what the user had
//   on.gone(reason)           -> deleted, or no longer invited

const RECENT_OPS = 60;
const CURSOR_MS = 33;           // at most one cursor update per two frames
const DRAIN_MS = 4000;
const FLASH_MS = 1200;          // how long freshly typed text by someone else stays tinted
const TYPING_MS = FLASH_MS;     // and how long they count as typing

const newClientId = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
};

export class SharedSession {
  constructor(id, api, on, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }) {
    this.id = id;
    this.api = api;
    this.on = on;
    this.timers = timers;
    this.client = newClientId();
    this.base = `/api/studio/shared/${id}`;

    this.text = '';
    this.rev = 0;
    this.ready = false;         // has the text from the server
    this.status = 'offline';    // offline | connecting | live
    this.meta = null;
    this.inflight = null;       // { op, seq }
    this.buffer = null;
    this.seq = 0;
    this.sending = false;

    this.peers = new Map();     // client -> { email, name, state, sel, selTag, typedAt, flash }
    this.peersRev = 0;
    this.listeners = new Set();
    this.batch = null;          // other people's edits waiting to be shown together
    this.recent = [];           // last few server edits, for cursors that arrive late
    this.sel = null;
    this.state = 'idle';
    this.sentCursor = '';

    this.es = null;
    this.wanted = false;
    this.dead = false;
    this.retries = 0;
    this.caughtUp = false;
  }

  /* ------------------------------ connection ------------------------------ */

  connect() {
    if (this.dead) return;
    this.wanted = true;
    this.timers.clear(this.drainTimer);
    if (!this.es) this.open();
  }

  // Called when the tab is no longer on screen. Unsent edits get a moment to
  // go out first.
  disconnect() {
    this.wanted = false;
    if (!this.es) return;
    if (!this.pending()) { this.close(); return; }
    this.timers.clear(this.drainTimer);
    this.drainTimer = this.timers.set(() => { if (!this.wanted) this.close(); }, DRAIN_MS);
  }

  destroy() {
    this.disconnect();
    this.dead = true;
  }

  pending() { return Boolean(this.inflight || this.buffer); }

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  peersChanged() {
    this.peersRev += 1;
    this.listeners.forEach(fn => fn());
  }

  open() {
    this.timers.clear(this.retryTimer);
    this.caughtUp = false;
    this.setStatus('connecting');
    const qs = `client=${this.client}${this.ready ? `&rev=${this.rev}` : ''}`;
    const es = this.api.stream(`${this.base}/stream?${qs}`);
    this.es = es;
    const mine = (fn) => (e) => { if (this.es === es) fn(e); };
    const json = (fn) => mine((e) => fn(JSON.parse(e.data)));
    es.addEventListener('init', json(d => this.onInit(d)));
    es.addEventListener('meta', json(d => { this.meta = d; this.on.change(); }));
    es.addEventListener('op', json(d => this.onOp(d)));
    es.addEventListener('presence', json(d => this.onPresence(d)));
    es.addEventListener('gone', mine(() => this.gone('gone')));
    es.addEventListener('reconnect', mine(() => this.reopen(0)));
    es.onend = mine(() => this.reopen());
    es.onerror = mine((e) => {
      if (e?.status === 404 || e?.status === 403) { this.gone(e.status === 403 ? 'denied' : 'gone'); return; }
      this.reopen();
    });
  }

  close() {
    this.timers.clear(this.retryTimer);
    this.timers.clear(this.drainTimer);
    this.timers.clear(this.cursorTimer);
    this.timers.clear(this.postTimer);
    this.cursorTimer = null;
    if (this.es) { const es = this.es; this.es = null; es.close(); }
    this.peers.clear();
    this.peersChanged();
    this.status = 'offline';
    this.on.change();
  }

  reopen(delay) {
    if (this.es) { const es = this.es; this.es = null; es.close(); }
    this.peers.clear();
    this.peersChanged();
    this.status = 'offline';
    this.on.change();
    if (this.dead || (!this.wanted && !this.pending())) return;
    const wait = delay ?? Math.min(10000, 500 * 2 ** this.retries);
    this.retries += 1;
    this.retryTimer = this.timers.set(() => { if (!this.es && !this.dead) this.open(); }, wait);
  }

  gone(reason) {
    if (this.dead) return;
    this.dead = true;
    this.close();
    this.on.gone(reason);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.on.change();
  }

  /* -------------------------------- stream -------------------------------- */

  onInit({ sql, rev }) {
    // The whole text again. If this is not the first time, the server could
    // not replay what we missed, so unsent edits have nowhere to go.
    if (this.ready && this.pending() && this.text !== sql) this.on.lost(this.text);
    this.inflight = null;
    this.buffer = null;
    this.sending = false;
    this.recent = [];
    this.text = sql;
    this.rev = rev;
    this.ready = true;
    this.batch = null;
    this.on.text(this.text, (pos) => Math.min(pos, sql.length));
  }

  onOp({ rev, op, client, seq, sel }) {
    if (!this.ready || rev <= this.rev) return;
    if (rev !== this.rev + 1) { this.resync(); return; }     // a hole; never expected on one stream
    this.rev = rev;
    this.recent.push({ rev, op });
    if (this.recent.length > RECENT_OPS) this.recent.shift();
    const move = (r) => (r ? { a: transformPos(r.a, op), h: transformPos(r.h, op) } : r);
    this.peers.forEach(p => { p.sel = move(p.sel); p.flash = move(p.flash); });

    if (client === this.client && this.inflight && seq === this.inflight.seq) {
      this.inflight = null;
      this.retries = 0;
      if (this.buffer) { const next = this.buffer; this.buffer = null; this.send(next); }
      else if (!this.wanted) this.close();
      else this.queueCursor();
      this.peersChanged();
      return;
    }

    let theirs = op;
    try {
      if (this.inflight) [this.inflight.op, theirs] = transform(this.inflight.op, theirs);
      if (this.buffer) [this.buffer, theirs] = transform(this.buffer, theirs);
      this.text = apply(this.text, theirs);
    } catch {
      this.resync();
      return;
    }

    // Their caret arrives with their edit, so both move in the same frame.
    const who = this.peers.get(client);
    if (who) {
      const now = Date.now();
      who.sel = sel || who.sel;
      who.selTag = sel ? `${rev}:${sel.a},${sel.h}` : who.selTag;
      who.typedAt = now;
      // What they just typed, to tint for a moment.
      let at = 0;
      let from = -1;
      let to = -1;
      op.forEach(part => {
        if (typeof part === 'string') { if (from < 0) from = at; at += part.length; to = at; }
        else if (part > 0) at += part;
      });
      if (from >= 0) {
        const fresh = who.flash && now - who.flashAt < FLASH_MS;
        who.flash = fresh ? { a: Math.min(who.flash.a, from), h: Math.max(who.flash.h, to) } : { a: from, h: to };
        who.flashAt = now;
      }
      this.timers.clear(who.calm);
      who.calm = this.timers.set(() => { who.flash = null; this.peersChanged(); }, FLASH_MS + 50);
    }

    // Several edits often arrive in one network read. They go to the screen
    // together, as one repaint, instead of one repaint each.
    const applied = theirs;
    if (this.batch) this.batch.push(applied);
    else {
      this.batch = [applied];
      queueMicrotask(() => {
        const ops = this.batch;
        this.batch = null;
        if (!ops) return;
        this.on.text(this.text, (pos) => ops.reduce((p, o) => transformPos(p, o), pos));
        this.peersChanged();
      });
    }
  }

  onPresence({ peers }) {
    const seen = new Set();
    peers.forEach(p => {
      seen.add(p.client);
      const old = this.peers.get(p.client);
      const tag = `${p.rev}:${p.sel ? `${p.sel.a},${p.sel.h}` : ''}`;
      let sel = old?.sel ?? null;
      if (!old || old.selTag !== tag) {
        sel = p.sel;
        // Reported against an older revision: carry it over the edits since.
        if (sel) this.recent.forEach(r => { if (r.rev > p.rev) sel = { a: transformPos(sel.a, r.op), h: transformPos(sel.h, r.op) }; });
      }
      if (old) Object.assign(old, { name: p.name, state: p.state, sel, selTag: tag });
      else {
        const here = [...this.peers.values()].some(x => x.email === p.email);    // same person, another tab
        this.peers.set(p.client, { email: p.email, name: p.name, state: p.state, sel, selTag: tag, typedAt: 0, flash: null, flashAt: 0 });
        if (this.caughtUp && !here) this.on.event?.({ type: 'join', email: p.email, name: p.name });
      }
    });
    [...this.peers.entries()].forEach(([c, p]) => {
      if (seen.has(c)) return;
      this.peers.delete(c);
      if (![...this.peers.values()].some(x => x.email === p.email)) this.on.event?.({ type: 'leave', email: p.email, name: p.name });
    });

    if (!this.caughtUp) {
      // First presence after (re)connecting comes after every missed edit.
      // An edit still unconfirmed by now never reached the server: send it again.
      this.caughtUp = true;
      this.retries = 0;
      this.status = 'live';
      if (!this.wanted && !this.pending()) { this.close(); return; }
      if (this.inflight) this.post();
      else if (this.buffer) { const next = this.buffer; this.buffer = null; this.send(next); }
      this.sentCursor = '';
      this.queueCursor();
      this.on.change();
    }
    this.peersChanged();
  }

  // Start over from the server's text.
  resync() {
    if (this.es) { const es = this.es; this.es = null; es.close(); }
    if (this.pending()) this.on.lost(this.text);
    this.inflight = null;
    this.buffer = null;
    this.ready = false;
    this.open();
  }

  /* -------------------------------- editing ------------------------------- */

  canEdit() { return this.ready && !this.dead && this.meta?.role !== 'view'; }

  // The user changed the text on screen.
  edit(text, sel) {
    if (sel !== undefined) this.sel = sel;
    const op = diff(this.text, text);
    if (!op) return;
    this.text = text;
    if (this.inflight) this.buffer = this.buffer ? compose(this.buffer, op) : op;
    else this.send(op);
    this.peersChanged();
    if (!this.es && !this.dead) this.open();
  }

  send(op) {
    this.seq += 1;
    this.inflight = { op, seq: this.seq };
    this.post();
  }

  post() {
    if (this.status !== 'live' || this.sending || !this.inflight) return;     // goes out once caught up
    const { seq } = this.inflight;
    this.sending = true;
    this.sentCursor = this.cursorKey();
    this.api.post(`${this.base}/ops`, { client: this.client, seq, rev: this.rev, op: this.inflight.op, sel: this.sel })
      .then(() => {
        this.sending = false;
        // Confirmed on the stream before this reply landed, and the next edit is already waiting.
        if (this.inflight && this.inflight.seq !== seq) this.post();
      })
      .catch((err) => {
        this.sending = false;
        if (this.dead || !this.inflight) return;
        if (this.inflight.seq !== seq) { this.post(); return; }
        if (err?.status === 404) { this.gone('gone'); return; }
        if (err?.status === 409 || err?.status === 403 || err?.status === 413 || err?.status === 400) {
          this.on.lost(this.text, err.status === 413 ? 'too_large' : err.status === 403 ? 'view_only' : 'conflict');
          this.inflight = null;
          this.buffer = null;
          this.ready = false;
          if (this.es) { const es = this.es; this.es = null; es.close(); }
          this.open();
          return;
        }
        // Network or server hiccup. The server ignores a repeat of an edit it
        // already has, so sending the same one again is safe.
        this.postTimer = this.timers.set(() => this.post(), Math.min(8000, 600 * 2 ** Math.min(this.retries++, 4)));
      });
  }

  /* -------------------------------- cursors ------------------------------- */

  cursorKey() { return `${this.state}:${this.sel ? `${this.sel.a},${this.sel.h}` : ''}`; }

  // The user's own cursor moved (sel = { a, h } or null), or a query started / finished.
  select(sel, state) {
    if (sel !== undefined) this.sel = sel;
    if (state) this.state = state;
    this.queueCursor();
  }

  // Goes out at once when nothing was sent lately, so a single click or arrow
  // key shows up without waiting; a drag or a held key is capped at one update
  // per CURSOR_MS.
  queueCursor() {
    if (this.cursorTimer || this.cursorKey() === this.sentCursor) return;
    const wait = Math.max(0, CURSOR_MS - (Date.now() - (this.cursorAt || 0)));
    this.cursorTimer = this.timers.set(() => {
      this.cursorTimer = null;
      // With edits still on their way the position would not mean the same
      // text on the server; it goes out with the edit, or right after it.
      if (this.status !== 'live' || this.pending() || this.cursorKey() === this.sentCursor) return;
      const key = this.cursorKey();
      this.sentCursor = key;
      this.cursorAt = Date.now();
      this.api.post(`${this.base}/cursor`, { client: this.client, rev: this.rev, sel: this.sel, state: this.state })
        .then(() => this.queueCursor())      // it moved again while that one was out
        .catch(() => { if (this.sentCursor === key) this.sentCursor = ''; });
    }, wait);
  }

  // Everyone else in the worksheet, with cursors in on-screen positions.
  others() {
    const local = (pos) => {
      let p = pos;
      if (this.inflight) p = transformPos(p, this.inflight.op);
      if (this.buffer) p = transformPos(p, this.buffer);
      return Math.min(p, this.text.length);
    };
    const now = Date.now();
    const out = [];
    this.peers.forEach((p, client) => {
      if (client === this.client) return;
      out.push({
        client, email: p.email, name: p.name, state: p.state,
        typing: now - p.typedAt < TYPING_MS,
        sel: p.sel ? { a: local(p.sel.a), h: local(p.sel.h) } : null,
        flash: p.flash && now - p.flashAt < FLASH_MS ? { a: local(p.flash.a), h: local(p.flash.h) } : null,
      });
    });
    return out;
  }

  me() { return this.peers.get(this.client)?.email || null; }
}

// ---- Cursors on screen

// The other people in a shared worksheet, re-read whenever one of them moves,
// types, joins or leaves. Only the component that calls this re-renders.
const noPeers = () => () => {};

export function usePeers(session) {
  const rev = useSyncExternalStore(session ? session.subscribe : noPeers, () => (session ? session.peersRev : 0));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (session ? session.others() : []), [session, rev]);
}

// The other people in a shared worksheet, drawn over the SQL editor: a caret
// with a name flag that glides to where they are, their selection, and a tint
// on what they typed a moment ago.
//
// It listens to the session by itself (usePeers), so a cursor moving repaints
// this layer and nothing else. The rest of the pane is not re-rendered.

const CSS = `
.sf-peer-caret { transition: transform 90ms cubic-bezier(.2,.8,.2,1); will-change: transform; }
.sf-peer-flash { animation: sf-peer-flash 1200ms ease-out forwards; }
.sf-peer-flag { animation: sf-peer-flag 2600ms ease-out forwards; }
@keyframes sf-peer-flash { 0%, 45% { opacity: 1; } 100% { opacity: 0; } }
@keyframes sf-peer-flag { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sf-peer-caret { transition: none; } }
`;
if (typeof document !== 'undefined' && !document.getElementById('sf-peer-css')) {
  const el = document.createElement('style');
  el.id = 'sf-peer-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Where text positions are on screen. The text is laid out once in a hidden
// copy of the textarea (same font, padding and width, so it wraps the same)
// and every caret and selection is read off that one layout.
const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordSpacing', 'textIndent'];
let mirror = null;

function measure(ta, text, peers) {
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, {
      position: 'absolute', top: '0', left: '-99999px', visibility: 'hidden', pointerEvents: 'none', margin: '0', border: '0',
      boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    });
    document.body.appendChild(mirror);
  }
  const style = window.getComputedStyle(ta);
  COPIED.forEach(k => { mirror.style[k] = style[k]; });
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = `${text}\u200b`;        // so there is always a character to measure at the very end
  const node = mirror.firstChild;
  const box = mirror.getBoundingClientRect();
  const lineH = parseFloat(style.lineHeight) || 21;
  const padTop = parseFloat(style.paddingTop) || 0;
  const range = document.createRange();
  const clamp = (pos) => Math.max(0, Math.min(pos, text.length));
  // A glyph box is shorter than its line; snap to the line it is on.
  const lineTop = (r) => padTop + Math.max(0, Math.floor((r.top + r.height / 2 - box.top - padTop) / lineH)) * lineH;

  const caretAt = (pos) => {
    const p = clamp(pos);
    range.setStart(node, p);
    range.setEnd(node, p + 1);
    const r = range.getClientRects()[0] || range.getBoundingClientRect();
    return { x: r.left - box.left, y: lineTop(r) };
  };
  const rectsOf = (from, to) => {
    const [a, b] = [clamp(Math.min(from, to)), clamp(Math.max(from, to))];
    if (a === b) return [];
    range.setStart(node, a);
    range.setEnd(node, b);
    const lines = new Map();        // one bar per line, however the browser split it
    [...range.getClientRects()].forEach(r => {
      const y = lineTop(r);
      const line = lines.get(y) || { y, x: Infinity, right: -Infinity };
      line.x = Math.min(line.x, r.left - box.left);
      line.right = Math.max(line.right, r.right - box.left);
      lines.set(y, line);
    });
    return [...lines.values()].map(l => ({ x: l.x, y: l.y, w: Math.max(l.right - l.x, 5), h: lineH }));
  };

  const out = peers.map(p => ({
    client: p.client,
    caret: p.sel ? caretAt(p.sel.h) : null,
    sel: p.sel ? rectsOf(p.sel.a, p.sel.h) : [],
    flash: p.flash ? rectsOf(p.flash.a, p.flash.h) : [],
  }));
  mirror.textContent = '';
  return { lineH, marks: out };
}

export function PeerLayer({ session, taRef, text, width, scroll, colorOf, nameOf }) {
  const peers = usePeers(session);
  const [layout, setLayout] = useState({ lineH: 21, marks: [] });
  useLayoutEffect(() => {
    const ta = taRef.current;
    setLayout(ta && peers.length ? measure(ta, text, peers) : { lineH: 21, marks: [] });
  }, [peers, text, width, taRef]);
  if (!layout.marks.length) return null;

  const byClient = new Map(peers.map(p => [p.client, p]));
  return (
    <div aria-hidden="true" className="absolute inset-0 z-[2] overflow-hidden pointer-events-none">
      <div className="absolute top-0 left-0" style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
        {layout.marks.map((m, n) => {
          const peer = byClient.get(m.client);
          if (!peer) return null;
          // Two people on the same spot: the second name goes above the first instead of over it.
          const stacked = m.caret ? layout.marks.slice(0, n).filter(o => o.caret && Math.abs(o.caret.x - m.caret.x) < 40 && o.caret.y === m.caret.y).length : 0;
          const color = colorOf(peer.email);
          const bar = (r, key, cls, alpha) => (
            <span key={key} className={`absolute rounded-[2px] ${cls}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: `${color}${alpha}` }} />
          );
          return (
            <React.Fragment key={m.client}>
              {/* keyed by its shape: growing while they type restarts the fade, so it only fades once they stop */}
              {m.flash.map((r, i) => bar(r, `f${i}:${Math.round(r.x)}:${r.y}:${Math.round(r.w)}`, 'sf-peer-flash', '2e'))}
              {m.sel.map((r, i) => bar(r, `s${i}`, '', '38'))}
              {m.caret && (
                <span data-peer-caret="" className="sf-peer-caret absolute top-0 left-0" style={{ transform: `translate3d(${m.caret.x}px, ${m.caret.y}px, 0)` }}>
                  <span className="absolute rounded-full" style={{ left: -1, top: 0, width: 2, height: layout.lineH, background: color }} />
                  <span className="absolute rounded-[1px]" style={{ left: -3, top: -2, width: 6, height: 5, background: color }} />
                  {/* The name sits on top of the line above, so it only shows while they are on the move:
                      keyed by where they are, every move brings it back, then it fades to leave the text readable. */}
                  <span
                    key={`${Math.round(m.caret.x)}:${m.caret.y}:${peer.typing}`}
                    className="sf-peer-flag absolute whitespace-nowrap rounded-[3px] px-1 font-sans text-white shadow-sm"
                    style={{ left: -3, top: m.caret.y < 16 + stacked * 15 ? layout.lineH + stacked * 15 : -15 - stacked * 15, fontSize: 10, lineHeight: '14px', background: color }}
                  >
                    {nameOf(peer)}{peer.typing ? ' …' : ''}
                  </span>
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
