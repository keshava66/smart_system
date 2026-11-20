import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiEventSource, apiJson, downloadFile } from '../utils/apiClient';

const API = '/api/ingestion-lab';
const ROW = 20;          // log row height, px
const OVERSCAN = 40;     // rows rendered above and below the viewport
const CHAR_W = 7.22;     // monospace width at 12px
const MAX_COLS = 3000;   // widest the log gets before long lines just get cut off visually
const CLIENT_MAX = 200000; // lines kept in the browser; a days-long run drops its oldest from view
const CLIENT_KEEP = 180000;

const STATUS = {
  running: { label: 'Running', tone: 'run' },
  success: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'warn' },
  timed_out: { label: 'Timed out', tone: 'bad' },
  lost: { label: 'Lost', tone: 'warn' },
  unknown: { label: 'Unknown', tone: 'mute' },
};
const STATUS_FILTERS = ['', 'running', 'success', 'failed', 'stopped', 'timed_out', 'lost'];

// ── small helpers ────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(sec) {
  if (sec == null || sec < 0) return '';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtClock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const secondsSince = (iso, now) => Math.max(0, (now - new Date(iso).getTime()) / 1000);

const canNotify = typeof window !== 'undefined' && 'Notification' in window;
const QUIET = 180;   // seconds without output before a running run is flagged as quiet

// when the newest log line was written (separators and gap notes carry no time)
function lastStamp(lines) {
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i -= 1) if (lines[i].ts) return lines[i].ts;
  return '';
}

const fmtLimit = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h} hour${h > 1 ? 's' : ''}`;
};

const shortPath = (p, max = 44) => (p.length > max ? `…${p.slice(-(max - 1))}` : p);

// Where a step's picked folder is remembered. Steps with no folder of their own share the pick
// with others looking for the same marker file (every main.py step, say).
const folderKeyOf = (serverId, s) => `${serverId}:${s.workdir || `@${s.folder_marker || ''}`}`;

const exitText = (rc) => (rc < 0 ? `killed (signal ${-rc})` : `exit ${rc}`);

function quoteArg(a) {
  if (a === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
  if (!a.includes("'")) return `'${a}'`;
  if (!/["$`\\!]/.test(a)) return `"${a}"`;   // reads better than '"'"'
  return `'${a.replace(/'/g, `'"'"'`)}'`;
}

const PH = /\{([a-z][a-z0-9_]{0,39})\}/g;

// A number written the way the server passes it on (Python's int() / repr()).
function pyNumber(n) {
  if (Number.isInteger(n)) return BigInt(n).toString();
  const a = Math.abs(n);
  if (a >= 1e-4 && a < 1e16) return String(n);
  const [m, e] = n.toExponential().split('e');
  const sign = e[0] === '-' ? '-' : '+';
  return `${m}e${sign}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
}

// Same rules as Step.argv on the server, so the preview is exactly what will run.
function previewCommand(step, values) {
  if (step.mode === 'shell') return step.command;
  const byName = Object.fromEntries(step.inputs.map((i) => [i.name, i]));
  const valueOf = (name) => {
    const spec = byName[name];
    const v = values[name];
    if (spec?.type === 'flag') return v ? spec.flag : '';
    if (v == null) return '';
    const t = String(v).trim();
    if (spec?.type === 'number' && /^[+-]?[0-9]+$/.test(t)) return BigInt(t).toString();
    if (spec?.type === 'number' && t !== '' && Number.isFinite(Number(t))) return pyNumber(Number(t));
    return t;
  };
  const fill = (text) => text.replace(PH, (_, name) => {
    const v = valueOf(name);
    if (byName[name]?.type === 'profile' && v) return `<${name}.json>`;   // written to a file when the run starts
    return byName[name]?.type === 'secret' && v ? '••••••••' : v;
  });
  const out = [];
  for (const part of step.command) {
    const group = Array.isArray(part) ? part : [part];
    const refs = group.flatMap((p) => [...p.matchAll(PH)].map((m) => m[1]));
    if (refs.some((r) => !valueOf(r))) {
      if (Array.isArray(part) || group.every((p) => new RegExp(`^${PH.source}$`).test(p))) continue;
    }
    group.forEach((p) => out.push(fill(p)));
  }
  return out.map(quoteArg).join(' ');
}

// Mirrors InputSpec.validate; the server checks again either way.
function checkField(spec, raw) {
  if (spec.type === 'flag') return '';
  if (spec.type === 'profile') return checkProfile(spec, raw);
  const v = raw == null ? '' : spec.type === 'secret' ? String(raw) : String(raw).trim();
  if (!v) return spec.required ? `${spec.label} is required` : '';
  if (spec.max_length && v.length > spec.max_length) return `At most ${spec.max_length} characters`;
  if (spec.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Must be a number';
    if (spec.integer && !Number.isInteger(n)) return 'Must be a whole number';
    if (spec.min != null && n < spec.min) return `At least ${spec.min}`;
    if (spec.max != null && n > spec.max) return `At most ${spec.max}`;
  }
  if ((spec.type === 'text' || spec.type === 'secret') && v.startsWith('-') && !spec.allow_dash) return "Can't start with '-'";
  if (spec.pattern) {
    try {
      if (!new RegExp(`^(?:${spec.pattern})$`).test(v)) return "Isn't in the expected format";
    } catch { /* server-side regex flavour; let the server decide */ }
  }
  return '';
}

function defaultsFor(step) {
  const v = {};
  step.inputs.forEach((i) => {
    if (i.type === 'flag') v[i.name] = Boolean(i.default);
    else v[i.name] = i.default != null ? asText(i.default) : '';
  });
  return v;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const errText = (e) => {
  const d = e?.detail;
  if (d && typeof d === 'object') return d.message || 'Request failed';
  return d || e?.message || 'Request failed';
};

// ── icons ────────────────────────────────────────────────────────────────────

const I = {
  play: <path d="M7 4.5v15l12-7.5z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  down: <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  redo: <path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V9h-4.5" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" strokeWidth="1.8" strokeLinejoin="round" />,
  term: <path d="M5 8l4 4-4 4M11 17h8" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  search: <path d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20" fill="none" strokeWidth="2" strokeLinecap="round" />,
  arrow: <path d="M12 5v14m0 0l-6-6m6 6l6-6" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  x: <path d="M6 6l12 12M18 6L6 18" fill="none" strokeWidth="2" strokeLinecap="round" />,
  copy: <path d="M9 9h10v10H9zM5 15V5h10" fill="none" strokeWidth="1.8" strokeLinejoin="round" />,
  up: <path d="M12 19V5m0 0l-6 6m6-6l6 6" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
};
const Icon = ({ n, size = 16 }) => (
  <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0" aria-hidden="true">{I[n]}</svg>
);

const Pill = ({ status, stopping }) => {
  const s = STATUS[status] || STATUS.unknown;
  return (
    <span className={`pill ${s.tone}`}>
      {status === 'running' && <i className="pulse" />}
      {status === 'running' && stopping ? 'Stopping…' : s.label}
    </span>
  );
};

// ── live log stream ──────────────────────────────────────────────────────────

function useRunStream(runId) {
  const linesRef = useRef([]);
  const widthRef = useRef(0);
  const [version, setVersion] = useState(0);
  const [end, setEnd] = useState(null);
  const [stopping, setStopping] = useState({ on: false, forcing: false });
  const [conn, setConn] = useState('idle');

  useEffect(() => {
    linesRef.current = [];
    widthRef.current = 0;
    setVersion((v) => v + 1);
    setEnd(null);
    setStopping({ on: false, forcing: false });
    if (!runId) { setConn('idle'); return undefined; }

    let es = null;
    let timer = null;
    let raf = 0;
    let last = 0;
    let tries = 0;
    let finished = false;
    let lines = linesRef.current;

    const bump = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setVersion((v) => v + 1); });
    };
    const push = (line) => {
      lines.push(line);
      const w = Math.min(line.m.length, MAX_COLS);
      if (w > widthRef.current) widthRef.current = w;
      if (lines.length > CLIENT_MAX) {
        // a new array, so the log view knows its indexes moved
        const dropped = lines.length - CLIENT_KEEP;
        lines = [{ s: 0, t: 'gap', m: `${dropped.toLocaleString()} older lines aren't kept on this page. Download the log for everything saved.`, ts: '' },
          ...lines.slice(dropped)];
        linesRef.current = lines;
      }
      bump();
    };
    const retry = () => {
      if (finished) return;
      tries += 1;
      setConn('retrying');
      timer = setTimeout(connect, Math.min(400 * 2 ** (tries - 1), 8000));
    };
    function connect() {
      if (finished) return;
      setConn(tries ? 'retrying' : 'connecting');
      es = apiEventSource(`${API}/runs/${runId}/stream?after=${last}`);
      es.onopen = () => setConn('live');
      es.onmessage = (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; }
        tries = 0;
        if (d.seq) {
          if (d.seq <= last) return;
          if (last && d.seq > last + 1) {
            const n = d.seq - last - 1;
            push({ s: 0, t: 'gap', m: `${n.toLocaleString()} older line${n > 1 ? 's were' : ' was'} trimmed from the saved log`, ts: '' });
          }
          last = d.seq;
          push({ s: d.seq, t: d.type, m: d.message || '', ts: d.ts });
          return;
        }
        if (d.type === 'state') { setStopping({ on: Boolean(d.stopping), forcing: Boolean(d.forcing) }); return; }
        if (d.type === 'done') {
          es.close();
          if (d.reconnect) { retry(); return; }
          finished = true;
          setEnd(d);
          setConn('closed');
          return;
        }
        if (d.type === 'error') push({ s: 0, t: 'error', m: d.message || 'Error', ts: new Date().toISOString() });
      };
      es.onerror = (e) => {
        if (finished) return;
        es.close();
        const st = e?.status;
        if (st && st >= 400 && st < 500 && st !== 429) {
          finished = true;
          push({ s: 0, t: 'error', m: st === 404 ? 'Run not found.' : `Server returned ${st}`, ts: new Date().toISOString() });
          setEnd({ status: 'unknown', returncode: -1 });
          setConn('closed');
          return;
        }
        retry();
      };
      es.onend = () => { if (!finished) retry(); };
    }
    connect();
    return () => {
      finished = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      es?.close();
    };
  }, [runId]);

  return { linesRef, widthRef, version, end, stopping, conn };
}

const ERR_RE = /\b(error|exception|traceback|fatal|failed|failure)\b/i;
const WARN_RE = /\bwarn(ing)?\b/i;

function lineClass(l) {
  if (l.t !== 'output') return l.t;
  if (ERR_RE.test(l.m)) return 'output e';
  if (WARN_RE.test(l.m)) return 'output w';
  return 'output';
}

function Highlight({ text, q }) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

function LogView({ linesRef, widthRef, version, filter, follow, setFollow, showTime, empty }) {
  const boxRef = useRef(null);
  const [view, setView] = useState({ top: 0, h: 480 });
  const matches = useRef({ arr: null, q: '', idx: [], scanned: 0 });
  const lines = linesRef.current;
  const q = filter.trim().toLowerCase();

  let idx = null;
  if (q) {
    const f = matches.current;
    if (f.arr !== lines || f.q !== q || f.scanned > lines.length) {
      f.arr = lines; f.q = q; f.idx = []; f.scanned = 0;
    }
    for (let i = f.scanned; i < lines.length; i += 1) {
      if (lines[i].t !== 'separator' && lines[i].t !== 'gap' && lines[i].m.toLowerCase().includes(q)) f.idx.push(i);
    }
    f.scanned = lines.length;
    idx = f.idx;
  }
  const count = idx ? idx.length : lines.length;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && follow) box.scrollTop = box.scrollHeight;
  }, [version, count, follow, q]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: box.clientHeight })));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Only the reader scrolling up stops following; new output growing the log
  // between our scroll and the scroll event must not.
  const lastTop = useRef(0);
  const onScroll = (e) => {
    const box = e.currentTarget;
    const top = box.scrollTop;
    setView({ top, h: box.clientHeight });
    const atBottom = top + box.clientHeight >= box.scrollHeight - ROW * 1.5;
    if (follow && top < lastTop.current - 2 && !atBottom) setFollow(false);
    else if (!follow && atBottom) setFollow(true);
    lastTop.current = top;
  };

  const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const stop = Math.min(count, Math.ceil((view.top + view.h) / ROW) + OVERSCAN);
  const gutter = showTime ? 132 : 64;
  const width = gutter + widthRef.current * CHAR_W + 32;
  const rows = [];
  for (let r = start; r < stop; r += 1) {
    const i = idx ? idx[r] : r;
    const l = lines[i];
    if (!l) continue;
    if (l.t === 'separator') {
      rows.push(<div key={i} className="ln sep" style={{ top: r * ROW }}><span /></div>);
      continue;
    }
    if (l.t === 'gap') {
      rows.push(<div key={i} className="ln gap" style={{ top: r * ROW }}><span>{l.m}</span></div>);
      continue;
    }
    if (l.tm === undefined) l.tm = fmtClock(l.ts);
    rows.push(
      <div key={i} className={`ln ${lineClass(l)}`} style={{ top: r * ROW }}>
        <span className="no">{l.s || ''}</span>
        {showTime && <span className="tm">{l.tm}</span>}
        <span className="tx"><Highlight text={l.m} q={q} /></span>
      </div>,
    );
  }

  return (
    <div className="log" ref={boxRef} onScroll={onScroll} role="log" aria-live="off" tabIndex={0}>
      {count === 0 ? (
        <div className="log-empty">{q && lines.length ? 'No lines match.' : empty}</div>
      ) : (
        <div className="log-in" style={{ height: count * ROW, minWidth: `max(100%, ${width}px)` }}>{rows}</div>
      )}
    </div>
  );
}

// ── inputs ───────────────────────────────────────────────────────────────────

function FolderPicker({ stepId, serverId, start, marker, onPick, onClose }) {
  const [path, setPath] = useState(start);
  const [typed, setTyped] = useState(start);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const req = useRef(0);

  const load = useCallback(async (target) => {
    const n = ++req.current;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ step_id: stepId, server_id: serverId, path: target });
      const d = await apiJson(`${API}/folders?${qs}`);
      if (n !== req.current) return;
      setData(d);
      setPath(d.path);
      setTyped(d.path);
    } catch (e) {
      if (n !== req.current) return;
      setError(errText(e));
    } finally {
      if (n === req.current) setLoading(false);
    }
  }, [stepId, serverId]);
  useEffect(() => { load(start); }, [load, start]);

  const join = (name) => `${path.replace(/\/+$/, '')}/${name}`;
  const go = (e) => { e.preventDefault(); if (typed.trim()) load(typed.trim()); };

  return (
    <div className="picker" role="dialog" aria-label="Choose a folder">
      <form className="pk-bar" onSubmit={go}>
        <button type="button" className="icon-btn" onClick={() => data?.parent && load(data.parent)} disabled={!data?.parent || loading}
          title="Up one folder" aria-label="Up one folder"><Icon n="up" size={14} /></button>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label="Folder path" />
        <button type="submit" className="btn ghost sm" disabled={loading}>Go</button>
      </form>
      {error && <div className="pk-err" role="alert">{error}</div>}
      <div className="pk-list" aria-busy={loading}>
        {loading && !data && <div className="pk-empty"><span className="spin" /></div>}
        {data?.parent && (
          <button type="button" className="pk-dir up" onClick={() => load(data.parent)} title={data.parent} disabled={loading}>
            <Icon n="up" size={14} /><span>..</span><small>{data.parent}</small>
          </button>
        )}
        {data && data.dirs.length === 0 && !loading && <div className="pk-empty">No folders in here.</div>}
        {data && data.dirs.map((d) => (
          <button key={d.name} type="button" className={`pk-dir${d.marked ? ' marked' : ''}`} onClick={() => load(join(d.name))}>
            <Icon n="folder" size={14} /><span>{d.name}</span>
            {d.marked && <em title={`Has ${marker}`}>{marker}</em>}
          </button>
        ))}
        {data?.truncated && <div className="pk-empty">Showing the first 500 folders. Type a path to go further.</div>}
      </div>
      <div className="pk-foot">
        <span className={`pk-here${data?.marked_here ? ' ok' : ''}`}>
          {data ? (marker ? (data.marked_here ? `${marker} is here` : `No ${marker} in this folder`) : '') : ''}
        </span>
        <button type="button" className="btn ghost sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn solid sm" disabled={!data || loading || Boolean(error)} onClick={() => onPick(data.path)}>Use this folder</button>
      </div>
    </div>
  );
}

// A step whose program is @python runs the virtualenv found in its folder, never another python.
function VenvCheck({ state, server, busy, onRetry, onCreate, onInstall }) {
  const { data, error, loading } = state;
  const usable = data?.pythons?.filter((p) => p.can_create) || [];
  const [pick, setPick] = useState('');
  const [withReq, setWithReq] = useState(true);
  const chosen = usable.some((p) => p.path === pick) ? pick : usable[0]?.path || '';
  if (loading && !data) return <div className="venv muted"><span className="spin" />Looking for a virtualenv…</div>;
  if (error) {
    return (
      <div className="venv bad" role="alert">
        <span>Couldn&apos;t check for a virtualenv: {error}</span>
        <button type="button" className="lnk dark" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (!data) return null;
  if (data.venv) {
    return (
      <div className="venv ok" title={data.venv}>
        <span className="sdot ok" aria-hidden="true" />Python: <code>{data.venv}</code>
        {data.requirements && (
          <button type="button" className="lnk dark" disabled={busy} onClick={onInstall}
            title={`pip install -r ${data.folder}/requirements.txt into this virtualenv`}>
            {busy ? 'Starting…' : 'Install requirements.txt'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="venv warn" role="alert">
      <b>No virtualenv for this folder</b>
      <span>This step only runs with a virtualenv, so it won&apos;t start. Looked for:</span>
      <ul>{data.looked.map((l) => <li key={l}><code>{l}</code></li>)}</ul>
      {usable.length ? (
        <>
          <label className="venv-l" htmlFor="il-venv-py">Create <code>{data.folder}/venv</code> on {server?.name} with</label>
          <select id="il-venv-py" value={chosen} onChange={(e) => setPick(e.target.value)} disabled={busy}>
            {data.pythons.map((p) => (
              <option key={p.path} value={p.path} disabled={!p.can_create}>
                Python {p.version} · {p.path}{p.can_create ? '' : ' (no venv module)'}
              </option>
            ))}
          </select>
          {data.requirements && (
            <label className="venv-c">
              <input type="checkbox" checked={withReq} onChange={(e) => setWithReq(e.target.checked)} disabled={busy} />
              Install requirements.txt into it
            </label>
          )}
          <div className="venv-a">
            <button type="button" className="btn solid sm" disabled={busy || !chosen}
              onClick={() => onCreate(chosen, data.requirements && withReq)}>
              {busy ? 'Starting…' : 'Create virtualenv'}
            </button>
            <button type="button" className="lnk dark" onClick={onRetry} disabled={loading}>Check again</button>
          </div>
        </>
      ) : (
        <span>
          No Python 3 with the venv module was found on {server?.name}
          {data.pythons.length ? ` (found ${data.pythons.map((p) => p.version).join(', ')}, none can make a virtualenv)` : ''}.
          Ask an admin to install python3-venv, then check again.
          <button type="button" className="lnk dark" onClick={onRetry}>Check again</button>
        </span>
      )}
    </div>
  );
}

// ── processing profile builder ───────────────────────────────────────────────
// Builds the JSON profile main.py reads with --profile (the Lab writes it to a file per run).
// The rules mirror processing_profile.py
// so mistakes show here; main.py checks again before it does anything.

const asText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));

const ID_RE = /^[a-z_][a-z0-9_]*$/i;            // profile_store._safe_identifier
const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;      // metadata field names
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAPPINGS = {
  extracted: {
    key: 'extracted_content',
    title: 'Source table',
    required: ['schema', 'table', 'doc_id_column', 'text_column'],
    optional: ['page_column', 'position_column', 'file_path_column', 'file_name_column'],
  },
  existing: {
    key: 'existing_chunks',
    title: 'Table to fill',
    required: ['schema', 'table', 'id_column', 'text_column', 'vector_column'],
    optional: ['note_column'],
  },
};
const LABELS = {
  schema: 'Schema', table: 'Table', doc_id_column: 'Document id column', text_column: 'Text column',
  page_column: 'Page column', position_column: 'Position column', file_path_column: 'File path column',
  file_name_column: 'File name column', id_column: 'Id column', vector_column: 'Vector column',
  note_column: 'Note column',
};
const HINTS = {
  position_column: 'Needed when a document has several rows and no page column',
  note_column: 'A TEXT column for short notes on rows that failed; must already exist',
  vector_column: 'Its pgvector size must match the dimensions below',
};

function blankProfile(mode) {
  const p = { version: 1 };
  if (mode !== 'existing') {
    p.chunking = { strategy: 'legacy', min_tokens: 200, max_tokens: 800, overlap_tokens: 100,
      small_section_policy: 'merge_forward', preserve_headers: true, tokenizer: 'cl100k_base' };
    p.metadata = { inherit_document_fields: true, document: {}, chunk: {} };
  }
  const m = MAPPINGS[mode];
  if (m) p[m.key] = Object.fromEntries(m.required.map((k) => [k, '']));
  p.embedding = { enabled: true, reuse_existing: true, batch_size: 16 };
  return p;
}

function parseProfile(text) {
  try {
    const p = JSON.parse(text);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch { return null; }
}

// what someone typed in a number box: a number when it is one, else kept as typed so it gets flagged
const num = (v) => (/^-?\d+$/.test(String(v).trim()) ? Number(v) : v);
const isInt = (v) => Number.isInteger(v);

function profileProblems(p, mode) {
  const e = {};
  if ('version' in p && p.version !== 1) e.version = 'Only version 1 profiles are supported';
  const c = p.chunking;
  if (c) {
    ['min_tokens', 'max_tokens', 'overlap_tokens'].forEach((k) => {
      if (k in c && (!isInt(c[k]) || c[k] < 0)) e[`chunking.${k}`] = 'A whole number, 0 or more';
    });
    const max = c.max_tokens ?? 800;
    const min = c.min_tokens ?? 200;
    const over = c.overlap_tokens ?? 100;
    if (!e['chunking.max_tokens'] && (max < 16 || max > 6000)) e['chunking.max_tokens'] = 'Between 16 and 6000';
    if (!e['chunking.min_tokens'] && isInt(max) && min > max) e['chunking.min_tokens'] = "Can't be more than the max";
    if (!e['chunking.overlap_tokens'] && isInt(max) && over >= Math.floor(max / 2)) {
      e['chunking.overlap_tokens'] = `Less than half the max (under ${Math.floor(max / 2)})`;
    }
  }
  const emb = p.embedding || {};
  if ('batch_size' in emb && (!isInt(emb.batch_size) || emb.batch_size < 1 || emb.batch_size > 128)) e['embedding.batch_size'] = 'Between 1 and 128';
  if ('dimensions' in emb && (!isInt(emb.dimensions) || emb.dimensions < 1 || emb.dimensions > 16000)) e['embedding.dimensions'] = 'Between 1 and 16000';
  // profile_store.py: the profile_chunks tables only take 1536-dim vectors
  else if (mode !== 'existing' && emb.enabled !== false && 'dimensions' in emb && emb.dimensions !== 1536) {
    e['embedding.dimensions'] = 'Profile chunk tables hold 1536 dimensions';
  }
  if ('progress_every_batches' in emb && (!isInt(emb.progress_every_batches) || emb.progress_every_batches < 1 || emb.progress_every_batches > 10000)) {
    e['embedding.progress_every_batches'] = 'Between 1 and 10000';
  }
  ['model', 'deployment'].forEach((k) => { if (k in emb && !MODEL_RE.test(String(emb[k]))) e[`embedding.${k}`] = 'Letters, digits, _ . -'; });
  if (mode === 'existing' && emb.enabled === false) e['embedding.enabled'] = 'Backfilling needs embeddings on';
  const meta = p.metadata;
  if (meta) {
    ['document', 'chunk'].forEach((level) => {
      const fields = meta[level] || {};
      if (Object.keys(fields).length > 100) e[`metadata.${level}`] = 'At most 100 fields';
      Object.entries(fields).forEach(([name, rule], i) => {
        const at = `metadata.${level}.${i}`;
        if (!FIELD_RE.test(name)) e[`${at}.name`] = 'Lowercase letters, digits and _, starting with a letter';
        if (rule.method === 'label' && !String(rule.label || '').trim()) e[`${at}.arg`] = 'Which label to look for';
        if (rule.method === 'regex' && !(String(rule.pattern || '').length >= 1 && String(rule.pattern).length <= 300)) e[`${at}.arg`] = 'A pattern, up to 300 characters';
        if (rule.method === 'constant' && (rule.value == null || rule.value === '')) e[`${at}.arg`] = 'The value to set';
        if ('first_pages' in rule && (!isInt(rule.first_pages) || rule.first_pages < 1 || rule.first_pages > 20)) e[`${at}.first_pages`] = '1 to 20';
      });
    });
  }
  const m = MAPPINGS[mode];
  if (m) {
    const src = p[m.key] || {};
    m.required.forEach((k) => { if (!String(src[k] || '').trim()) e[`${m.key}.${k}`] = 'Required'; });
    [...m.required, ...m.optional].forEach((k) => {
      if (src[k] && !ID_RE.test(src[k])) e[`${m.key}.${k}`] = 'A plain name: letters, digits and _';
    });
  }
  return e;
}

function checkProfile(spec, raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return spec.required ? `${spec.label} is required` : '';
  const p = parseProfile(v);
  if (!p) return `${spec.label} isn't valid JSON`;
  const first = Object.values(profileProblems(p, spec.profile_mode || 'documents'))[0];
  return first ? `${spec.label}: fix the highlighted settings` : '';
}

function PNum({ label, value, onChange, err, placeholder, disabled, hint }) {
  return (
    <label className={`pf${err ? ' err' : ''}`}>
      <span>{label}</span>
      <input type="text" inputMode="numeric" value={value ?? ''} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(err)} />
      {(err || hint) && <small className={err ? 'bad' : ''}>{err || hint}</small>}
    </label>
  );
}

function PText({ label, value, onChange, err, placeholder, disabled, hint, mono }) {
  return (
    <label className={`pf${err ? ' err' : ''}`}>
      <span>{label}</span>
      <input type="text" className={mono ? 'mono' : ''} value={value ?? ''} placeholder={placeholder} disabled={disabled}
        spellCheck={false} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(err)} />
      {(err || hint) && <small className={err ? 'bad' : ''}>{err || hint}</small>}
    </label>
  );
}

function PSelect({ label, value, options, onChange, disabled }) {
  return (
    <label className="pf">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function PSwitch({ label, checked, onChange, disabled, hint }) {
  return (
    <label className={`pf-sw${disabled ? ' dis' : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw" aria-hidden="true"><i /></span>
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

function MetaFields({ level, fields, errs, onChange, disabled }) {
  const rows = Object.entries(fields || {});
  const [clash, setClash] = useState('');
  const rebuild = (fn) => onChange(Object.fromEntries(fn(rows)));
  const rename = (i, name) => {
    if (rows.some(([n], j) => j !== i && n === name)) { setClash(`"${name}" is already used`); return; }
    setClash('');
    rebuild((r) => r.map(([n, rule], j) => (j === i ? [name, rule] : [n, rule])));
  };
  const setRule = (i, rule) => rebuild((r) => r.map(([n, old], j) => (j === i ? [n, rule] : [n, old])));
  const add = () => {
    let k = rows.length + 1;
    while (rows.some(([n]) => n === `field_${k}`)) k += 1;
    rebuild((r) => [...r, [`field_${k}`, { method: 'regex', pattern: '' }]]);
  };
  const ARG = { label: ['label', 'Label text, e.g. Indication'], regex: ['pattern', 'Regex; group 1 is kept if present'], constant: ['value', 'Value'] };
  return (
    <div className="pf-meta">
      {rows.length === 0 && <p className="muted">None. {level === 'document' ? 'Fields found once per document.' : 'Fields found in each chunk.'}</p>}
      {rows.map(([name, rule], i) => {
        const at = `metadata.${level}.${i}`;
        const [argKey, argHint] = ARG[rule.method] || ARG.regex;
        return (
          <div className="pf-row" key={i}>
            <div className="pf-row-h">
              <input type="text" className="mono" value={name} disabled={disabled} spellCheck={false} aria-label="Field name"
                aria-invalid={Boolean(errs[`${at}.name`])} onChange={(e) => rename(i, e.target.value)} />
              <select value={rule.method} disabled={disabled} aria-label="How to find it"
                onChange={(e) => {
                  const { label: _l, pattern: _p, value: _v, ...rest } = rule;
                  setRule(i, { ...rest, method: e.target.value, [ARG[e.target.value][0]]: '' });
                }}>
                <option value="label">After a label</option>
                <option value="regex">Regex</option>
                <option value="constant">Fixed value</option>
              </select>
              <button type="button" className="icon-btn" disabled={disabled} onClick={() => rebuild((r) => r.filter((_, j) => j !== i))}
                title="Remove field" aria-label={`Remove ${name}`}><Icon n="x" size={12} /></button>
            </div>
            <input type="text" className={rule.method === 'regex' ? 'mono' : ''} value={rule[argKey] ?? ''} placeholder={argHint}
              disabled={disabled} spellCheck={false} aria-invalid={Boolean(errs[`${at}.arg`])}
              onChange={(e) => setRule(i, { ...rule, [argKey]: e.target.value })} />
            {rule.method !== 'constant' && (
              <div className="pf-fp">
                <span>Only the first</span>
                <input type="text" inputMode="numeric" value={rule.first_pages ?? ''} placeholder="all" disabled={disabled}
                  aria-label="Only look at the first pages" aria-invalid={Boolean(errs[`${at}.first_pages`])}
                  onChange={(e) => {
                    const { first_pages: _f, ...rest } = rule;
                    setRule(i, e.target.value === '' ? rest : { ...rule, first_pages: num(e.target.value) });
                  }} />
                <span>pages</span>
              </div>
            )}
            {['name', 'arg', 'first_pages'].map((k) => errs[`${at}.${k}`] && <small key={k} className="bad">{errs[`${at}.${k}`]}</small>)}
          </div>
        );
      })}
      {clash && <small className="bad">{clash}</small>}
      {errs[`metadata.${level}`] && <small className="bad">{errs[`metadata.${level}`]}</small>}
      <button type="button" className="lnk dark" disabled={disabled} onClick={add}>+ Add field</button>
    </div>
  );
}

function ProfileField({ spec, value, onChange, disabled, templates }) {
  const mode = spec.profile_mode || 'documents';
  const text = String(value ?? '').trim();
  const on = Boolean(text);
  const p = on ? parseProfile(text) : null;
  const errs = p ? profileProblems(p, mode) : {};
  const shown = (k) => errs[k] || '';
  const bad = (...prefixes) => Object.keys(errs).some((k) => prefixes.some((x) => k.startsWith(x)));
  const [pickedTemplate, setPickedTemplate] = useState('');
  const set = (next) => onChange(JSON.stringify(next));
  const sec = (key, patch) => set({ ...p, [key]: { ...(p[key] || {}), ...patch } });
  const drop = (key, field) => { const { [field]: _gone, ...rest } = p[key] || {}; set({ ...p, [key]: rest }); };
  const optNum = (key, field, v) => (v === '' ? drop(key, field) : sec(key, { [field]: num(v) }));
  const optText = (key, field, v) => (v.trim() === '' ? drop(key, field) : sec(key, { [field]: v.trim() }));
  const list = templates?.list || [];

  const startFrom = (path) => {
    setPickedTemplate(path);
    if (!path) { set(blankProfile(mode)); return; }
    const t = list.find((x) => x.path === path);
    if (t?.profile) set(t.profile);
  };

  const header = (
    <div className="pf-top">
      <label htmlFor={`il-${spec.name}`}>{spec.label}{!spec.required && <em>optional</em>}</label>
      {!spec.required && (
        <PSwitch label={on ? 'On' : 'Off'} checked={on} disabled={disabled}
          onChange={(v) => { setPickedTemplate(''); onChange(v ? JSON.stringify(blankProfile(mode)) : ''); }} />
      )}
    </div>
  );
  if (!on) {
    return (
      <div className="fld pfw">
        {header}
        {spec.help && <small>{spec.help}</small>}
        {spec.required && (
          <button type="button" className="btn ghost sm" disabled={disabled} onClick={() => set(blankProfile(mode))}>Start a profile</button>
        )}
      </div>
    );
  }
  if (!p) {
    return (
      <div className="fld pfw">
        {header}
        <small className="bad">This profile isn&apos;t valid JSON any more.</small>
        <button type="button" className="btn ghost sm" disabled={disabled} onClick={() => set(blankProfile(mode))}>Start again</button>
      </div>
    );
  }
  const c = p.chunking || {};
  const emb = p.embedding || {};
  const meta = p.metadata || { inherit_document_fields: true, document: {}, chunk: {} };
  const m = MAPPINGS[mode];
  const nErr = Object.keys(errs).length;
  return (
    <div className="fld pfw">
      {header}
      {spec.help && <small>{spec.help}</small>}
      {spec.templates && (
        <label className="pf">
          <span>Start from</span>
          <select value={pickedTemplate} disabled={disabled || templates?.loading} onChange={(e) => startFrom(e.target.value)}>
            <option value="">{templates?.idle ? 'Defaults (pick the run folder to see profile files)' : templates?.loading ? 'Defaults (looking for profile files…)' : 'Defaults'}</option>
            {list.map((t) => (
              <option key={t.path} value={t.path} disabled={!t.profile}>{t.path}{t.profile ? '' : ' (unreadable)'}</option>
            ))}
          </select>
          {templates?.error && <small className="bad">{templates.error}</small>}
        </label>
      )}
      <PText label="Profile name" value={p.name ?? ''} disabled={disabled} placeholder="e.g. regulatory_v2"
        hint="Optional; shows in the log" onChange={(v) => { const { name: _n, ...rest } = p; set(v.trim() ? { ...rest, name: v } : rest); }} />
      {shown('version') && <small className="bad">{shown('version')}</small>}

      {m && (
        <details className="pf-sec" open>
          <summary className={bad(`${m.key}.`) ? 'bad' : ''}>{m.title}<span>{p[m.key]?.schema && p[m.key]?.table ? `${p[m.key].schema}.${p[m.key].table}` : 'not set'}</span></summary>
          {m.required.map((k) => (
            <PText key={k} label={LABELS[k]} mono value={p[m.key]?.[k] ?? ''} err={shown(`${m.key}.${k}`)} hint={HINTS[k]}
              disabled={disabled} onChange={(v) => sec(m.key, { [k]: v.trim() })} />
          ))}
          {m.optional.map((k) => (
            <PText key={k} label={`${LABELS[k]} (optional)`} mono value={p[m.key]?.[k] ?? ''} err={shown(`${m.key}.${k}`)} hint={HINTS[k]}
              disabled={disabled} onChange={(v) => optText(m.key, k, v)} />
          ))}
        </details>
      )}

      {mode !== 'existing' && (
        <details className="pf-sec">
          <summary className={bad('chunking.') ? 'bad' : ''}>Chunking<span>{c.strategy === 'toc_then_semantic' ? 'Headings, then semantic' : 'Standard'} · {asText(c.min_tokens ?? 200)}–{asText(c.max_tokens ?? 800)} tokens</span></summary>
          <PSelect label="Strategy" value={c.strategy || 'legacy'} disabled={disabled} onChange={(v) => sec('chunking', { strategy: v })}
            options={[['legacy', 'Standard (same as without a profile)'], ['toc_then_semantic', 'Headings first, then by meaning']]} />
          <div className="pf-3">
            <PNum label="Min tokens" value={c.min_tokens} err={shown('chunking.min_tokens')} disabled={disabled} onChange={(v) => sec('chunking', { min_tokens: num(v) })} />
            <PNum label="Max tokens" value={c.max_tokens} err={shown('chunking.max_tokens')} disabled={disabled} onChange={(v) => sec('chunking', { max_tokens: num(v) })} />
            <PNum label="Overlap" value={c.overlap_tokens} err={shown('chunking.overlap_tokens')} disabled={disabled} onChange={(v) => sec('chunking', { overlap_tokens: num(v) })} />
          </div>
          <PSelect label="Short sections" value={c.small_section_policy || 'merge_forward'} disabled={disabled}
            onChange={(v) => sec('chunking', { small_section_policy: v })}
            options={[['merge_forward', 'Merge into the next section'], ['keep', 'Keep as their own chunks']]} />
          <PSelect label="Tokenizer" value={c.tokenizer || 'cl100k_base'} disabled={disabled} onChange={(v) => sec('chunking', { tokenizer: v })}
            options={[['cl100k_base', 'cl100k_base (text-embedding-3, GPT-4)'], ['o200k_base', 'o200k_base (GPT-4o)']]} />
          <PSwitch label="Keep section headings in each chunk" checked={c.preserve_headers ?? true} disabled={disabled}
            onChange={(v) => sec('chunking', { preserve_headers: v })} />
        </details>
      )}

      {mode !== 'existing' && (
        <details className="pf-sec">
          <summary className={bad('metadata.') ? 'bad' : ''}>Metadata fields<span>{Object.keys(meta.document || {}).length} per document · {Object.keys(meta.chunk || {}).length} per chunk</span></summary>
          <h4>Per document</h4>
          <MetaFields level="document" fields={meta.document} errs={errs} disabled={disabled}
            onChange={(f) => set({ ...p, metadata: { ...meta, document: f } })} />
          <h4>Per chunk</h4>
          <MetaFields level="chunk" fields={meta.chunk} errs={errs} disabled={disabled}
            onChange={(f) => set({ ...p, metadata: { ...meta, chunk: f } })} />
          <PSwitch label="Chunks also get the document's fields" checked={meta.inherit_document_fields ?? true} disabled={disabled}
            onChange={(v) => set({ ...p, metadata: { ...meta, inherit_document_fields: v } })} />
        </details>
      )}

      <details className="pf-sec" open={mode === 'existing'}>
        <summary className={bad('embedding.') ? 'bad' : ''}>Embeddings<span>{emb.enabled === false && mode !== 'existing' ? 'off' : `${emb.model || 'default model'}${emb.dimensions ? ` · ${asText(emb.dimensions)} dims` : ''}`}</span></summary>
        {mode !== 'existing' && (
          <PSwitch label="Create embeddings" checked={emb.enabled ?? true} disabled={disabled} onChange={(v) => sec('embedding', { enabled: v })} />
        )}
        <PSwitch label="Reuse vectors that already exist" checked={emb.reuse_existing ?? true} disabled={disabled}
          hint={mode === 'existing' ? 'Off re-embeds every row, not only empty ones' : undefined}
          onChange={(v) => sec('embedding', { reuse_existing: v })} />
        <div className="pf-3">
          <PNum label="Batch size" value={emb.batch_size} err={shown('embedding.batch_size')} disabled={disabled} onChange={(v) => sec('embedding', { batch_size: num(v) })} />
          <PNum label="Dimensions" value={emb.dimensions} placeholder="1536" err={shown('embedding.dimensions')} disabled={disabled}
            onChange={(v) => optNum('embedding', 'dimensions', v)} />
          <PNum label="Log every" value={emb.progress_every_batches} placeholder="10" err={shown('embedding.progress_every_batches')}
            hint="batches" disabled={disabled} onChange={(v) => optNum('embedding', 'progress_every_batches', v)} />
        </div>
        <PText label="Model" mono value={emb.model} placeholder="config.ini's (e.g. text-embedding-3-large)" err={shown('embedding.model')}
          disabled={disabled} onChange={(v) => optText('embedding', 'model', v)} />
        <PText label="Azure deployment" mono value={emb.deployment} placeholder="config.ini's" err={shown('embedding.deployment')}
          disabled={disabled} onChange={(v) => optText('embedding', 'deployment', v)} />
        {shown('embedding.enabled') && <small className="bad">{shown('embedding.enabled')}</small>}
      </details>

      <details className="pf-sec">
        <summary>JSON<span>the file main.py reads</span></summary>
        <pre className="pf-json">{JSON.stringify(p, null, 2)}</pre>
        <button type="button" className="lnk dark" onClick={() => navigator.clipboard?.writeText(JSON.stringify(p, null, 2))}>
          <Icon n="copy" size={12} />Copy
        </button>
      </details>
      {nErr > 0 && <small className="bad">{nErr} setting{nErr > 1 ? 's need' : ' needs'} fixing above.</small>}
    </div>
  );
}

function Field({ spec, value, error, onChange, disabled, templates }) {
  if (spec.type === 'profile') {
    return (
      <>
        <ProfileField spec={spec} value={value} onChange={onChange} disabled={disabled} templates={templates} />
        {error && <small className="bad pf-err">{error}</small>}
      </>
    );
  }
  const id = `il-${spec.name}`;
  const common = { id, disabled, 'aria-invalid': Boolean(error), 'aria-describedby': spec.help || error ? `${id}-h` : undefined };
  let control;
  if (spec.type === 'flag') {
    return (
      <label className={`fld flag${disabled ? ' dis' : ''}`} htmlFor={id}>
        <input type="checkbox" {...common} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span className="sw" aria-hidden="true"><i /></span>
        <span className="flag-l">{spec.label}{spec.help && <small id={`${id}-h`}>{spec.help}</small>}</span>
      </label>
    );
  }
  if (spec.type === 'select') {
    control = (
      <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {!spec.required && <option value="">{spec.placeholder || '—'}</option>}
        {spec.required && !spec.options.some((o) => o.value === value) && <option value="" disabled>Choose…</option>}
        {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    const type = spec.type === 'secret' ? 'password' : spec.type === 'number' ? 'number' : spec.type === 'date' ? 'date' : 'text';
    control = (
      <input
        {...common}
        type={type}
        value={value ?? ''}
        placeholder={spec.placeholder || ''}
        maxLength={spec.max_length || undefined}
        min={spec.min ?? undefined}
        max={spec.max ?? undefined}
        step={spec.type === 'number' ? (spec.integer ? 1 : 'any') : undefined}
        autoComplete={spec.type === 'secret' ? 'new-password' : 'off'}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className={`fld${error ? ' err' : ''}`}>
      <label htmlFor={id}>{spec.label}{!spec.required && <em>optional</em>}</label>
      {control}
      {(error || spec.help) && <small id={`${id}-h`} className={error ? 'bad' : ''}>{error || spec.help}</small>}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function IngestionLab() {
  const [params, setParams] = useSearchParams();
  const visible = useVisible();

  const [cfg, setCfg] = useState(null);
  const [cfgError, setCfgError] = useState('');
  const [stepId, setStepId] = useState(() => store.get('ilab.step', null));
  const [forms, setForms] = useState({});
  const [touched, setTouched] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState([]);
  const [toast, setToast] = useState(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);

  const runId = params.get('run') || null;
  const [run, setRun] = useState(null);
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [showTime, setShowTime] = useState(() => store.get('ilab.time', true));
  const [notify, setNotify] = useState(() => canNotify && Notification.permission === 'granted' && store.get('ilab.notify', false));
  useEffect(() => { store.set('ilab.notify', notify); }, [notify]);

  const [hist, setHist] = useState({ runs: [], next: null, loading: true, error: '', paged: false });
  const [hf, setHf] = useState(() => ({ step: '', status: '', mine: false, server: '@current', ...store.get('ilab.hf', {}) }));
  const [serverId, setServerId] = useState(() => params.get('server') || store.get('ilab.server', null));
  const [checks, setChecks] = useState({});
  const [folders, setFolders] = useState(() => store.get('ilab.folders.v2', {}));
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState({});
  const [venv, setVenv] = useState({ key: '', data: null, error: '', loading: false });
  const [venvBusy, setVenvBusy] = useState(false);
  const venvReq = useRef(0);
  const [outside, setOutside] = useState({ sid: '', runs: {} });
  const [extConfirm, setExtConfirm] = useState(null);   // pid being confirmed for a stop
  const [tpl, setTpl] = useState({ key: '', data: null, error: '', loading: false });
  const tplReq = useRef(0);
  const histReq = useRef(0);

  const stream = useRunStream(runId);
  const toastTimer = useRef(null);
  const say = useCallback((text, tone = 'info') => {
    clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const openRun = useCallback((id, replace = false) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set('run', id); else n.delete('run');
      return n;
    }, { replace });
    setFilter('');
    setFollow(true);
    setConfirmStop(false);
  }, [setParams]);

  // steps
  const loadSteps = useCallback(async () => {
    try {
      const data = await apiJson(`${API}/steps`);
      setCfg(data);
      setCfgError('');
    } catch (e) {
      setCfgError(errText(e));
    }
  }, []);
  useEffect(() => { loadSteps(); }, [loadSteps]);
  useEffect(() => {
    if (!visible) return undefined;
    const t = setInterval(loadSteps, 60000);
    return () => clearInterval(t);
  }, [visible, loadSteps]);

  // servers: every step is shown as it looks on the chosen one (its folder, its python)
  const servers = useMemo(() => cfg?.servers || [], [cfg]);
  const server = servers.find((sv) => sv.id === serverId) || servers[0] || null;
  const multi = servers.length > 1;
  useEffect(() => { if (server && server.id !== serverId) setServerId(server.id); }, [server, serverId]);
  useEffect(() => {
    if (!serverId) return;
    store.set('ilab.server', serverId);
    if (multi && params.get('server') !== serverId) {
      setParams((p) => { const n = new URLSearchParams(p); n.set('server', serverId); return n; }, { replace: true });
    }
  }, [serverId, multi, params, setParams]);
  const allSteps = useMemo(() => cfg?.steps || [], [cfg]);
  const variantOf = useCallback((s, sid) => (s && s.servers?.[sid] ? { ...s, ...s.servers[sid] } : null), []);
  const steps = useMemo(() => (server ? allSteps.map((s) => variantOf(s, server.id)).filter(Boolean) : []), [allSteps, server, variantOf]);
  const step = steps.find((s) => s.id === stepId) || steps[0] || null;
  useEffect(() => { if (step && step.id !== stepId) setStepId(step.id); }, [step, stepId]);
  useEffect(() => { if (stepId) store.set('ilab.step', stepId); }, [stepId]);

  // can the portal log in to each server? (cached on the server side too)
  const loadChecks = useCallback(async (fresh = false) => {
    const remote = servers.filter((sv) => !sv.local);
    if (!remote.length) return;
    setChecks((c) => Object.fromEntries(remote.map((sv) => [sv.id, { ...(c[sv.id] || {}), loading: true }])));
    await Promise.all(remote.map(async (sv) => {
      try {
        const r = await apiJson(`${API}/servers/${encodeURIComponent(sv.id)}/check${fresh ? '?fresh=true' : ''}`);
        setChecks((c) => ({ ...c, [sv.id]: { ...r, loading: false } }));
      } catch (e) {
        setChecks((c) => ({ ...c, [sv.id]: { ok: false, error: errText(e), loading: false } }));
      }
    }));
  }, [servers]);
  useEffect(() => {
    if (!visible) return undefined;
    loadChecks();
    const t = setInterval(() => loadChecks(), 60000);
    return () => clearInterval(t);
  }, [visible, loadChecks]);

  useEffect(() => { store.set('ilab.folders.v2', folders); }, [folders]);
  // steps that start in the same folder share the choice: pick it once for all of them
  const folderKey = step && server ? folderKeyOf(server.id, step) : '';
  const chosenFolder = step?.folder_choice && folders[folderKey] && folders[folderKey] !== step.workdir ? folders[folderKey] : null;
  const workdir = chosenFolder || step?.workdir || '';
  const needsFolder = Boolean(step) && !workdir;
  useEffect(() => { setPicking(false); }, [folderKey]);
  const pickFolder = (path) => {
    setFolders((f) => {
      const n = { ...f };
      if (!path || path === step.workdir) delete n[folderKey]; else n[folderKey] = path;
      return n;
    });
    setPicking(false);
    setServerErrors((e) => { if (!e.workdir) return e; const n = { ...e }; delete n.workdir; return n; });
  };

  const switchServer = (id) => {
    setServerId(id);
    setConfirmStop(false);
    setServerErrors({});
  };
  useEffect(() => { store.set('ilab.time', showTime); }, [showTime]);
  useEffect(() => { store.set('ilab.hf', hf); }, [hf]);

  const values = useMemo(() => (step ? { ...defaultsFor(step), ...(forms[step.id] || {}) } : {}), [step, forms]);
  const fieldErrors = useMemo(() => {
    if (!step) return {};
    const out = {};
    step.inputs.forEach((spec) => { const e = checkField(spec, values[spec.name]); if (e) out[spec.name] = e; });
    return out;
  }, [step, values]);
  const preview = useMemo(() => (step ? previewCommand(step, values) : ''), [step, values]);

  const setValue = (name, v) => {
    setForms((f) => ({ ...f, [step.id]: { ...(f[step.id] || {}), [name]: v } }));
    setServerErrors((e) => { if (!e[name]) return e; const n = { ...e }; delete n[name]; return n; });
  };

  // active runs, across every server
  const loadActive = useCallback(async () => {
    try { setActive(await apiJson(`${API}/active`)); } catch { /* keep what we have */ }
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    loadActive();
    const t = setInterval(loadActive, 4000);
    return () => clearInterval(t);
  }, [visible, loadActive]);

  // runs started on the server by hand (nohup python main.py ...), found from its process list
  const serverKey = server?.id || '';
  const loadOutside = useCallback(async () => {
    if (!serverKey) return;
    try {
      const d = await apiJson(`${API}/outside?server_id=${encodeURIComponent(serverKey)}`);
      setOutside({ sid: serverKey, runs: d.runs || {} });
    } catch { /* keep what we have */ }
  }, [serverKey]);
  useEffect(() => {
    if (!visible || !serverKey) return undefined;
    loadOutside();
    const t = setInterval(loadOutside, 10000);
    return () => clearInterval(t);
  }, [visible, serverKey, loadOutside]);
  const outsideOf = (id) => (outside.sid === serverKey ? outside.runs[id] || [] : []);

  // first visit with nothing open: attach to this step's live run if there is one
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || runId || !step || !cfg) return;
    attached.current = true;
    apiJson(`${API}/active`).then((list) => {
      const here = list.filter((r) => !server || r.server_id === server.id);
      const live = here.find((r) => r.step_id === step.id) || here[0];
      if (live) openRun(live.id, true);
    }).catch(() => {});
  }, [runId, step, cfg, server, openRun]);

  // the run shown in the console
  const loadRun = useCallback(async (id) => {
    try { setRun(await apiJson(`${API}/runs/${id}`)); } catch { setRun(null); }
  }, []);
  useEffect(() => {
    setRun(null);
    if (runId) loadRun(runId);
  }, [runId, loadRun]);
  useEffect(() => { if (runId && stream.end) loadRun(runId); }, [stream.end, runId, loadRun]);
  const runLive = Boolean(runId) && !stream.end;
  useEffect(() => {
    if (!runLive || !visible) return undefined;
    const t = setInterval(() => loadRun(runId), 15000);
    return () => clearInterval(t);
  }, [runLive, visible, runId, loadRun]);

  // history
  const loadHistory = useCallback(async (more = false) => {
    const req = ++histReq.current;
    const qs = new URLSearchParams({ limit: '25' });
    if (hf.step) qs.set('step_id', hf.step);
    const histServer = hf.server === '@current' ? server?.id : hf.server;
    if (histServer && multi) qs.set('server_id', histServer);
    if (hf.status) qs.set('status', hf.status);
    if (hf.mine) qs.set('mine', 'true');
    if (more && hist.next) qs.set('before', hist.next);
    setHist((h) => ({ ...h, loading: true, error: '' }));
    try {
      const data = await apiJson(`${API}/runs?${qs}`);
      if (req !== histReq.current) return;
      setHist((h) => ({ runs: more ? [...h.runs, ...data.runs] : data.runs, next: data.next, loading: false, error: '', paged: more || false }));
    } catch (e) {
      if (req !== histReq.current) return;
      setHist((h) => ({ ...h, loading: false, error: errText(e) }));
    }
  }, [hf, hist.next, server, multi]);
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  useEffect(() => { loadHistoryRef.current(false); }, [hf, server?.id]);
  useEffect(() => {
    if (!visible) return undefined;
    // keep the first page fresh; once someone has paged back, leave their list alone
    const t = setInterval(() => { if (!hist.paged) loadHistoryRef.current(false); }, 15000);
    return () => clearInterval(t);
  }, [visible, hist.paged]);
  const activeKey = active.map((r) => r.id).join(',');
  const prevActive = useRef(activeKey);
  useEffect(() => {
    if (prevActive.current !== activeKey) { prevActive.current = activeKey; loadHistoryRef.current(false); }
  }, [activeKey]);
  useEffect(() => { if (stream.end) { loadHistoryRef.current(false); loadActive(); } }, [stream.end, loadActive]);

  // actions
  const canRun = Boolean(cfg?.can_run);
  const cfgFile = cfg?.config_file || 'ingestion_lab.yaml';
  const usesVenv = Boolean(step && step.mode === 'command' && step.command[0] === '@python');
  const venvKey = usesVenv && canRun && server && workdir ? `${server.id}|${step.id}|${workdir}` : '';
  const loadVenv = useCallback(async () => {
    const n = ++venvReq.current;
    if (!venvKey) { setVenv({ key: '', data: null, error: '', loading: false }); return; }
    setVenv((v) => ({ key: venvKey, data: v.key === venvKey ? v.data : null, error: '', loading: true }));
    try {
      const qs = new URLSearchParams({ step_id: step.id, server_id: server.id });
      if (chosenFolder) qs.set('workdir', chosenFolder);
      const data = await apiJson(`${API}/python?${qs}`);
      if (n === venvReq.current) setVenv({ key: venvKey, data, error: '', loading: false });
    } catch (e) {
      if (n === venvReq.current) setVenv({ key: venvKey, data: null, error: errText(e), loading: false });
    }
  }, [venvKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadVenv(); }, [loadVenv]);
  useEffect(() => { if (stream.end && run?.step_id === 'venv-setup') loadVenv(); }, [stream.end, run?.step_id, loadVenv]);
  const installReqs = async () => {
    setVenvBusy(true);
    try {
      const body = { step_id: step.id, server_id: server.id };
      if (chosenFolder) body.workdir = chosenFolder;
      const { run_id: id } = await apiJson(`${API}/requirements`, { method: 'POST', body });
      say('Installing requirements.txt. Follow it in the output console.');
      openRun(id);
      loadActive();
    } catch (e) {
      const d = e?.detail;
      if (e?.status === 409 && d?.run_id) { say(d.message, 'warn'); openRun(d.run_id); } else say(errText(e), 'bad');
    } finally {
      setVenvBusy(false);
    }
  };
  const noVenv = usesVenv && venv.key === venvKey && venv.data && !venv.data.venv;

  // profile files (profiles/*.json...) a profile input can start from, in the folder this run uses
  const hasTemplates = Boolean(step?.inputs.some((i) => i.templates));
  const tplKey = hasTemplates && canRun && server && workdir ? `${server.id}|${step.id}|${workdir}` : '';
  const loadTemplates = useCallback(async () => {
    const n = ++tplReq.current;
    if (!tplKey) { setTpl({ key: '', data: null, error: '', loading: false }); return; }
    setTpl((c) => ({ key: tplKey, data: c.key === tplKey ? c.data : null, error: '', loading: true }));
    try {
      const qs = new URLSearchParams({ step_id: step.id, server_id: server.id });
      if (chosenFolder) qs.set('workdir', chosenFolder);
      const data = await apiJson(`${API}/templates?${qs}`);
      if (n === tplReq.current) setTpl({ key: tplKey, data, error: '', loading: false });
    } catch (e) {
      if (n === tplReq.current) setTpl({ key: tplKey, data: null, error: errText(e), loading: false });
    }
  }, [tplKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  const templatesFor = (spec) => {
    if (!spec.templates) return undefined;
    if (!tplKey) return { idle: true, list: [] };
    if (tpl.key !== tplKey) return { loading: true, list: [] };
    return { loading: tpl.loading, error: tpl.error, list: tpl.data?.[spec.name] || [] };
  };

  const createVenv = async (python, requirements) => {
    setVenvBusy(true);
    try {
      const body = { step_id: step.id, server_id: server.id, python, requirements };
      if (chosenFolder) body.workdir = chosenFolder;
      const { run_id: id } = await apiJson(`${API}/venv`, { method: 'POST', body });
      say('Creating the virtualenv. Follow it in the output console; run the step once it finishes.');
      openRun(id);
      loadActive();
    } catch (e) {
      const d = e?.detail;
      if (e?.status === 409 && d?.run_id) { say(d.message, 'warn'); openRun(d.run_id); } else say(errText(e), 'bad');
      loadVenv();
    } finally {
      setVenvBusy(false);
    }
  };
  const stepLive = step && server
    ? active.find((r) => r.step_id === step.id && (step.one_at_a_time_everywhere || r.server_id === server.id))
    : null;
  const blocked = step?.one_at_a_time && stepLive;
  const ext = step ? outsideOf(step.id) : [];
  const formValid = Object.keys(fieldErrors).length === 0;

  const stopOutside = async (pid, force) => {
    setStopBusy(true);
    try {
      await apiJson(`${API}/outside/stop`, { method: 'POST', body: { step_id: step.id, server_id: server.id, pid, force } });
      say(force ? `Killed PID ${pid}.` : `Stop signal sent to PID ${pid}.`);
      setExtConfirm(null);
      setTimeout(loadOutside, 1500);
    } catch (e) {
      say(errText(e), 'bad');
      loadOutside();
    } finally {
      setStopBusy(false);
    }
  };

  const startRun = async () => {
    if (!step || starting) return;
    setTouched((t) => ({ ...t, [step.id]: true }));
    if (!formValid) return;
    if (blocked) { openRun(stepLive.id); return; }
    if (needsFolder) { setPicking(true); return; }
    setStarting(true);
    setServerErrors({});
    try {
      const inputs = {};
      step.inputs.forEach((spec) => {
        const v = values[spec.name];
        if (spec.type === 'flag') inputs[spec.name] = Boolean(v);
        else if (v !== '' && v != null) inputs[spec.name] = spec.type === 'secret' ? v : String(v).trim();
      });
      const body = { step_id: step.id, server_id: server.id, inputs };
      if (chosenFolder) body.workdir = chosenFolder;
      const { run_id: id } = await apiJson(`${API}/runs`, { method: 'POST', body });
      setForms((f) => {
        const mine = { ...(f[step.id] || {}) };
        step.inputs.forEach((spec) => { if (spec.type === 'secret') mine[spec.name] = ''; });
        return { ...f, [step.id]: mine };
      });
      openRun(id);
      loadActive();
    } catch (e) {
      const d = e?.detail;
      if (e?.status === 422 && d?.fields) { setServerErrors(d.fields); say(d.message || 'Some inputs need fixing.', 'bad'); }
      else if (e?.status === 409 && d?.run_id) { say(d.message, 'warn'); openRun(d.run_id); loadActive(); }
      else if (e?.status === 409 && d?.code === 'outside') { say(d.message, 'warn'); loadOutside(); }
      else if (e?.status === 409 && d?.code === 'no_venv') { say('No virtualenv for this folder. See the options above the Run button.', 'bad'); loadVenv(); }
      else say(errText(e), 'bad');
    } finally {
      setStarting(false);
    }
  };

  const stopRun = async (force = false) => {
    if (!runId || stopBusy) return;
    setStopBusy(true);
    try {
      const r = await apiJson(`${API}/runs/${runId}/stop${force ? '?force=true' : ''}`, { method: 'POST' });
      setConfirmStop(false);
      if (r.direct) say(force ? 'Killed it on the server.' : 'Stop signal sent on the server.');
      loadRun(runId);
    } catch (e) {
      say(errText(e), 'bad');
    } finally {
      setStopBusy(false);
    }
  };

  const applyPreset = (pr) => {
    const next = defaultsFor(step);
    Object.entries(pr.inputs).forEach(([k, v]) => {
      const spec = step.inputs.find((i) => i.name === k);
      next[k] = spec?.type === 'flag' ? Boolean(v) : asText(v);
    });
    setForms((f) => ({ ...f, [step.id]: next }));
    setTouched((t) => ({ ...t, [step.id]: false }));
    setServerErrors({});
  };

  const rerun = (r) => {
    const s = variantOf(allSteps.find((x) => x.id === r.step_id), r.server_id);
    if (!s) { say('That step is no longer set up on that server.', 'warn'); return; }
    if (server && r.server_id !== server.id) switchServer(r.server_id);
    const next = {};
    s.inputs.forEach((spec) => {
      const v = r.inputs?.[spec.name];
      if (spec.type === 'secret') next[spec.name] = '';
      else if (spec.type === 'flag') next[spec.name] = Boolean(v);
      else next[spec.name] = v == null ? '' : String(v);
    });
    setStepId(s.id);
    setForms((f) => ({ ...f, [s.id]: next }));
    if (s.folder_choice) {
      const key = folderKeyOf(r.server_id, s);
      setFolders((f) => {
        const n = { ...f };
        if (r.workdir && r.workdir !== s.workdir) n[key] = r.workdir; else delete n[key];
        return n;
      });
    }
    setTouched((t) => ({ ...t, [s.id]: false }));
    setServerErrors({});
    const secrets = s.inputs.some((spec) => spec.type === 'secret' && r.inputs?.[spec.name]);
    say(secrets ? 'Inputs filled in. Enter the secret values again, then Run.' : 'Inputs filled in. Check them and hit Run.');
  };

  const download = async (id) => {
    try { await downloadFile(`${API}/runs/${id}/log.txt`, `ingestion_${id}.txt`); } catch (e) { say(errText(e), 'bad'); }
  };

  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(preview); say('Command copied.'); } catch { say("Couldn't copy.", 'bad'); }
  };

  const onFormKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startRun(); } };

  // live console header values
  const status = stream.end ? stream.end.status : run?.status || (runId ? 'running' : null);
  const running = status === 'running';
  const anyRunning = running || hist.runs.some((r) => r.status === 'running');
  const now = useNow(anyRunning);
  const runStep = run ? variantOf(allSteps.find((s) => s.id === run.step_id), run.server_id) : null;
  const orphan = Boolean(canRun && run && run.status === 'lost' && run.remote && run.pid);
  const stopping = running && (stream.stopping.on || Boolean(run?.stopping));
  const forcing = stopping && (stream.stopping.forcing || Boolean(run?.force_stop_requested));
  const graceful = Boolean(runStep?.graceful_stop);
  const elapsed = run ? (running ? secondsSince(run.started_at, now) : run.seconds) : null;
  const showErrors = step && (touched[step.id] || false);
  const lastTs = running ? lastStamp(stream.linesRef.current) : '';
  const quietFor = lastTs ? secondsSince(lastTs, now) : 0;
  const missingModule = useMemo(() => Boolean(stream.end?.status === 'failed'
    && stream.linesRef.current.some((l) => l.t === 'output' && l.m.includes('ModuleNotFoundError'))),
  [stream.end, stream.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // tell the person when a run they watched finishes while the tab is in the background
  const sawLive = useRef('');
  useEffect(() => { if (runId && run?.id === runId && run.status === 'running' && !stream.end) sawLive.current = runId; }, [runId, run, stream.end]);
  useEffect(() => {
    if (!stream.end || sawLive.current !== runId) return;
    sawLive.current = '';
    if (!notify || document.visibilityState !== 'hidden' || !canNotify || Notification.permission !== 'granted') return;
    const label = (STATUS[stream.end.status] || STATUS.unknown).label;
    try {
      new Notification(`${run?.step_name || 'Ingestion run'}: ${label}`, {
        body: run?.server_name ? `On ${run.server_name}, started by ${run.started_by}` : undefined, tag: runId,
      });
    } catch { /* some browsers only allow notifications from a service worker */ }
  }, [stream.end, runId, notify, run]);
  const toggleNotify = async () => {
    if (notify) { setNotify(false); return; }
    if (Notification.permission === 'denied') { say('Notifications are blocked for this site in your browser settings.', 'warn'); return; }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setNotify(p === 'granted');
    if (p === 'granted') say("You'll get a notification when a run you're watching finishes.");
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); say('Link to this run copied.'); } catch { say("Couldn't copy.", 'bad'); }
  };

  // ── render ──
  if (!cfg && !cfgError) {
    return <div className="ilab"><style>{CSS}</style><div className="center"><span className="spin" />Loading Ingestion Lab…</div></div>;
  }
  if (cfgError && !cfg) {
    return (
      <div className="ilab"><style>{CSS}</style>
        <div className="center col"><b>Couldn&apos;t load Ingestion Lab</b><span>{cfgError}</span>
          <button type="button" className="btn" onClick={loadSteps}><Icon n="redo" />Try again</button></div>
      </div>
    );
  }

  return (
    <div className="ilab">
      <style>{CSS}</style>
      <header className="top">
        <div>
          <h1>Ingestion Lab</h1>
          <p>Run ingestion steps on {multi ? 'your servers' : 'the server'} and watch them live. Runs keep going if you close this page.</p>
        </div>
        <div className="top-r">
          {multi && (
            <div className="servers" role="tablist" aria-label="Server">
              {servers.map((sv) => {
                const c = checks[sv.id];
                const state = sv.local ? 'ok' : !c || c.loading ? 'wait' : c.ok ? 'ok' : 'bad';
                const count = active.filter((r) => r.server_id === sv.id).length;
                const tip = sv.local ? `${sv.host} (the portal server)` : state === 'bad' ? c.error
                  : state === 'ok' ? `${sv.host} · connected${c?.ms ? ` in ${c.ms} ms` : ''}` : `${sv.host} · checking…`;
                return (
                  <button key={sv.id} type="button" role="tab" aria-selected={sv.id === server?.id}
                    className={`srv${sv.id === server?.id ? ' on' : ''}`} onClick={() => switchServer(sv.id)} title={tip}>
                    <i className={`sdot ${state}`} aria-hidden="true" />
                    <span>{sv.name}</span>
                    {count > 0 && <span className="cnt" aria-label={`${count} running`}>{count}</span>}
                  </button>
                );
              })}
              <button type="button" className="icon-btn" onClick={() => loadChecks(true)} title="Check connections again" aria-label="Check server connections"><Icon n="redo" size={13} /></button>
            </div>
          )}
          {active.length > 0 && (
            <span className="live-n" title={active.map((r) => `${r.step_name} · ${r.started_by}`).join('\n')}>
              <i className="pulse" />{active.length} running
            </span>
          )}
        </div>
      </header>

      {cfg.errors?.length > 0 && (
        <div className="banner warn" role="alert">
          <b>Some steps in {cfgFile} couldn&apos;t be loaded:</b>
          <ul>{cfg.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {multi && server && checks[server.id] && checks[server.id].ok === false && !checks[server.id].loading && (
        <div className="banner bad top-gap" role="alert"><b>Can&apos;t reach {server.name}:</b> {checks[server.id].error}</div>
      )}

      {steps.length === 0 ? (
        <div className="center col empty-cfg">
          <span className="big"><Icon n="term" size={28} /></span>
          {allSteps.length > 0 ? (
            <>
              <b>No steps are set up for {server?.name}</b>
              <span>Give this server the vars its steps use (like <code>{'${workdir}'}</code>) in <code>{cfgFile}</code>, or pick another server.</span>
            </>
          ) : (
            <>
              <b>No ingestion steps are set up yet</b>
              <span>Add your servers and steps to <code>backend/{cfgFile}</code> on the server (start from <code>ingestion_lab.example.yaml</code>). It&apos;s picked up without a restart.</span>
            </>
          )}
          <button type="button" className="btn" onClick={loadSteps}><Icon n="redo" />Check again</button>
        </div>
      ) : (
        <div className="body">
          {/* ── left: steps + form ── */}
          <aside className="left">
            <section className="card steps" aria-label="Steps">
              <div className="card-h"><span className="cap">Steps</span><span className="n">{steps.length}</span></div>
              <ol>
                {steps.map((s, i) => {
                  const live = active.find((r) => r.step_id === s.id && r.server_id === server?.id);
                  const manual = outsideOf(s.id);
                  return (
                    <li key={s.id}>
                      <button type="button" className={`step${s.id === step?.id ? ' on' : ''}`} onClick={() => setStepId(s.id)} aria-pressed={s.id === step?.id}>
                        <span className="idx">{i + 1}</span>
                        <span className="nm"><b>{s.name}</b>{s.description && <small>{s.description}</small>}</span>
                        {live && <span className="dot" title={`Running · started by ${live.started_by}`}><i className="pulse" /></span>}
                        {!live && manual.length > 0 && (
                          <span className="dot" title={`Running outside the portal · PID ${manual.map((m) => m.pid).join(', ')}`}><i className="pulse ext" /></span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>

            {step && (
              <section className="card form" aria-label={`Run ${step.name}`} onKeyDown={onFormKey}>
                <div className="card-h"><span className="cap">Run</span><b className="ttl">{step.name}</b></div>
                <div className={`where${chosenFolder ? ' moved' : ''}${needsFolder ? ' none' : ''}`} title={workdir}>
                  <Icon n="folder" size={14} /><span>{needsFolder ? 'Pick the folder to run in' : shortPath(workdir, step.folder_choice && canRun ? 34 : 44)}</span>
                  {step.folder_choice && canRun && (
                    <span className="where-a">
                      {chosenFolder && step.workdir && <button type="button" className="lnk dark" onClick={() => pickFolder(null)} title={`Back to ${step.workdir}`}>Reset</button>}
                      <button type="button" className="lnk dark" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>{picking ? 'Close' : needsFolder ? 'Choose' : 'Change'}</button>
                    </span>
                  )}
                </div>
                {serverErrors.workdir && <div className="where-err" role="alert">{serverErrors.workdir}</div>}
                {picking && (
                  <FolderPicker stepId={step.id} serverId={server.id} start={workdir || step.folder_roots?.[0] || ''} marker={step.folder_marker}
                    onPick={pickFolder} onClose={() => setPicking(false)} />
                )}
                {step.inputs.length === 0 && <p className="muted">This step has no inputs.</p>}
                {step.presets?.length > 0 && (
                  <div className="presets" role="group" aria-label="Presets">
                    {step.presets.map((pr) => {
                      const on = Object.entries(pr.inputs).every(([k, v]) => {
                        const spec = step.inputs.find((i) => i.name === k);
                        return spec?.type === 'flag' ? Boolean(values[k]) === Boolean(v) : asText(values[k]) === asText(v);
                      }) && step.inputs.every((spec) => spec.name in pr.inputs || spec.type === 'secret'
                        || (spec.type === 'flag' ? Boolean(values[spec.name]) === Boolean(spec.default) : asText(values[spec.name]) === asText(spec.default)));
                      return (
                        <button key={pr.name} type="button" className={`chip${on ? ' on' : ''}`} title={pr.description || undefined}
                          disabled={!canRun || starting} onClick={() => applyPreset(pr)} aria-pressed={on}>{pr.name}</button>
                      );
                    })}
                  </div>
                )}
                {[false, true].map((adv) => {
                  const specs = step.inputs.filter((spec) => Boolean(spec.advanced) === adv);
                  if (!specs.length) return null;
                  const fields = (
                    <div className="fields" key={adv ? 'adv' : 'basic'}>
                      {specs.map((spec) => (
                        <Field
                          key={spec.name}
                          spec={spec}
                          value={values[spec.name]}
                          error={serverErrors[spec.name] || (showErrors ? fieldErrors[spec.name] : '')}
                          onChange={(v) => setValue(spec.name, v)}
                          disabled={!canRun || starting}
                          templates={templatesFor(spec)}
                        />
                      ))}
                    </div>
                  );
                  if (!adv) return fields;
                  // open by itself when something in here is set or needs fixing
                  const busy = specs.some((spec) => serverErrors[spec.name] || (showErrors && fieldErrors[spec.name])
                    || (spec.type === 'flag' ? Boolean(values[spec.name]) !== Boolean(spec.default)
                      : String(values[spec.name] ?? '') !== String(spec.default ?? '')));
                  const open = busy || Boolean(more[step.id]);
                  return (
                    <div className="more-o" key="adv">
                      <button type="button" className="lnk" aria-expanded={open} disabled={busy}
                        onClick={() => setMore((m) => ({ ...m, [step.id]: !m[step.id] }))}>
                        {open ? '▾' : '▸'} More options ({specs.length})
                      </button>
                      {open && fields}
                    </div>
                  );
                })}
                {venvKey && (
                  <VenvCheck key={venvKey} state={venv.key === venvKey ? venv : { loading: true }} server={server}
                    busy={venvBusy} onRetry={loadVenv} onCreate={createVenv} onInstall={installReqs} />
                )}
                <div className="cmd">
                  <div className="cmd-h"><span className="cap">Command</span>
                    <button type="button" className="lnk" onClick={copyCommand} title="Copy command"><Icon n="copy" size={13} />Copy</button></div>
                  <code><span className="mute">$ </span>{preview}</code>
                  {step.mode === 'command' && step.command[0] === '@python' && (
                    <small className="muted">@python is the virtualenv in the run folder (or up to 2 folders above it); the log shows which one ran.</small>
                  )}
                  {step.mode === 'shell' && step.inputs.length > 0 && (
                    <small className="muted">Inputs reach the command as {step.inputs.map((i) => `$IL_${i.name.toUpperCase()}`).join(', ')}.</small>
                  )}
                </div>
                {ext.length > 0 && (
                  <div className="venv warn ext-run" role="alert">
                    <b>Running outside the portal on {server?.name}</b>
                    {ext.map((m) => (
                      <div key={m.pid} className="ext-one">
                        <span>PID {m.pid} · {m.user}{m.seconds != null ? ` · ${fmtDuration(m.seconds)}` : ''} · <code title={m.folder}>{shortPath(m.folder, 40)}</code></span>
                        <code className="ext-cmd" title={m.command}>{m.command}</code>
                        {canRun && (extConfirm === m.pid ? (
                          <span className="confirm">
                            <span>Stop PID {m.pid}?</span>
                            <button type="button" className="btn danger sm" disabled={stopBusy} onClick={() => stopOutside(m.pid, false)}>{step.graceful_stop ? 'Ctrl-C' : 'Stop'}</button>
                            <button type="button" className="btn danger sm" disabled={stopBusy} onClick={() => stopOutside(m.pid, true)}>Kill</button>
                            <button type="button" className="btn ghost sm" onClick={() => setExtConfirm(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button type="button" className="lnk dark" onClick={() => setExtConfirm(m.pid)}>Stop it</button>
                        ))}
                      </div>
                    ))}
                    <small>Started by hand on the server, not from this page. It shows no live output here; its own log file has it.</small>
                  </div>
                )}
                {canRun ? (
                  <>
                    <button type="button" className="btn solid big" onClick={startRun} disabled={starting || (noVenv && !blocked) || (ext.length > 0 && !blocked)} aria-keyshortcuts="Control+Enter">
                      {starting ? <><span className="spin w" />Starting…</> : blocked ? <><Icon n="term" />View running run</> : <><Icon n="play" />Run {step.name}</>}
                    </button>
                    <div className="hint">
                      {ext.length > 0 && !blocked ? 'Already running outside the portal. Stop that one first, or wait for it to finish.' : needsFolder && !blocked ? 'Choose the folder to run in first.' : noVenv && !blocked ? 'Create a virtualenv for this folder first.' : blocked ? `Already running${multi && stepLive.server_id !== server?.id ? ` on ${stepLive.server_name}` : ''}, started by ${stepLive.started_by}. One run at a time for this step${step.one_at_a_time_everywhere && multi ? ' across all servers' : ''}.` : (
                        <>
                          {step.timeout_minutes ? `Stops automatically after ${fmtLimit(step.timeout_minutes)}. ` : ''}
                          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted lock">You can watch runs and their history. Starting a step needs the <b>Run Ingestion Steps</b> permission.</p>
                )}
              </section>
            )}
          </aside>

          {/* ── right: console + history ── */}
          <main className="right">
            <section className={`card console${running ? ' is-live' : ''}`} aria-label="Run output">
              <div className="con-h">
                <div className="con-t">
                  {runId ? (
                    <>
                      <Pill status={status || 'unknown'} stopping={stopping} />
                      <b>{run?.step_name || runStep?.name || 'Run'}</b>
                      {multi && run?.server_name && <span className="schip" title={run.server_id}>{run.server_name}</span>}
                      {run?.reconnecting && <span className="meta warn-t">Reconnecting to the server…</span>}
                      {run && <span className="meta">by {run.started_by} · {fmtWhen(run.started_at)}{elapsed != null && <> · <span className="num">{fmtDuration(elapsed)}</span></>}{!running && run.returncode != null && <> · {exitText(run.returncode)}</>}</span>}
                      {stream.conn === 'retrying' && <span className="meta warn-t">Reconnecting…</span>}
                      {quietFor >= QUIET && stream.conn === 'live' && (
                        <span className="meta warn-t" title="It may be waiting on something, or stuck">No output for {fmtDuration(quietFor)}</span>
                      )}
                    </>
                  ) : <b className="muted">Output</b>}
                </div>
                <div className="con-a">
                  <label className="search">
                    <Icon n="search" size={14} />
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines" aria-label="Filter log lines" />
                    {filter && <button type="button" className="clr" onClick={() => setFilter('')} aria-label="Clear filter"><Icon n="x" size={12} /></button>}
                  </label>
                  <button type="button" className={`tog${showTime ? ' on' : ''}`} onClick={() => setShowTime((v) => !v)} aria-pressed={showTime} title="Show timestamps">Time</button>
                  {canNotify && (
                    <button type="button" className={`tog${notify ? ' on' : ''}`} onClick={toggleNotify} aria-pressed={notify}
                      title="Notify me when a run I'm watching finishes while this tab is in the background">Notify</button>
                  )}
                  {runId && <button type="button" className="btn ghost" onClick={copyLink} title="Copy a link to this run"><Icon n="copy" />Link</button>}
                  {runId && <button type="button" className="btn ghost" onClick={() => download(runId)} title="Download log"><Icon n="down" />Log</button>}
                  {runId && run && !running && canRun && runStep && (
                    <button type="button" className="btn ghost" onClick={() => rerun(run)} title="Fill the form with this run's inputs"><Icon n="redo" />Rerun</button>
                  )}
                  {running && canRun && (
                    confirmStop ? (
                      <span className="confirm" role="alertdialog" aria-label="Confirm stop">
                        <span>{stopping ? 'Kill it now? Work in progress is lost.' : graceful ? 'Stop once in-flight work finishes?' : 'Stop this run and everything it started?'}</span>
                        <button type="button" className="btn danger" onClick={() => stopRun(stopping)} disabled={stopBusy}>
                          {stopBusy ? 'Stopping…' : stopping ? 'Force stop' : 'Stop run'}
                        </button>
                        <button type="button" className="btn ghost" onClick={() => setConfirmStop(false)}>Cancel</button>
                      </span>
                    ) : stopping && graceful && !forcing ? (
                      <button type="button" className="btn danger" onClick={() => setConfirmStop(true)} title={`Waits up to ${fmtDuration(runStep.stop_grace_seconds)} for in-flight work, then kills it`}>
                        <Icon n="stop" />Force stop
                      </button>
                    ) : (
                      <button type="button" className="btn danger" onClick={() => setConfirmStop(true)} disabled={stopping}><Icon n="stop" />{stopping ? 'Stopping…' : 'Stop'}</button>
                    )
                  )}
                  {orphan && (
                    confirmStop ? (
                      <span className="confirm" role="alertdialog" aria-label="Confirm stop on server">
                        <span>Stop PID {run.pid} on {run.server_name}?</span>
                        <button type="button" className="btn danger" onClick={() => stopRun(false)} disabled={stopBusy}>{graceful ? 'Ctrl-C' : 'Stop'}</button>
                        <button type="button" className="btn danger" onClick={() => stopRun(true)} disabled={stopBusy}>Kill</button>
                        <button type="button" className="btn ghost" onClick={() => setConfirmStop(false)}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" className="btn danger" onClick={() => setConfirmStop(true)}
                        title="The portal lost track of this run, but it may still be running on its server">
                        <Icon n="stop" />Stop on server
                      </button>
                    )
                  )}
                </div>
              </div>
              <div className="con-b">
                <LogView
                  linesRef={stream.linesRef}
                  widthRef={stream.widthRef}
                  version={stream.version}
                  filter={filter}
                  follow={follow}
                  setFollow={setFollow}
                  showTime={showTime}
                  empty={runId ? (stream.conn === 'connecting' ? 'Connecting…' : 'Waiting for output…') : 'Run a step, or pick a run from the history, to see its output here.'}
                />
                {!follow && (
                  <button type="button" className="jump" onClick={() => setFollow(true)}><Icon n="arrow" size={14} />Latest</button>
                )}
              </div>
              {run?.log_truncated && (
                <div className="con-f">
                  {runStep?.log_keep !== 'first'
                    ? `Long run: older output was trimmed from the saved log (${run.log_lines.toLocaleString()} lines so far). The first ${50} and the latest lines are kept.`
                    : `Output passed the line limit, so the rest wasn't saved (${run.log_lines.toLocaleString()} lines in total).`}
                  {runStep?.log_file && <> Full copy on the server: <code>{runStep.log_file}</code></>}
                </div>
              )}
              {missingModule && (
                <div className="con-f">
                  A Python package is missing from the virtualenv. If the run folder has a requirements.txt,
                  use <b>Install requirements.txt</b> next to Python in the Run panel, then run again.
                </div>
              )}
            </section>

            <section className="card hist" aria-label="Run history">
              <div className="hist-h">
                <span className="cap">History</span>
                <div className="hist-f">
                  <select value={hf.step} onChange={(e) => setHf((f) => ({ ...f, step: e.target.value }))} aria-label="Filter by step">
                    <option value="">All steps</option>
                    {allSteps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <select value={hf.status} onChange={(e) => setHf((f) => ({ ...f, status: e.target.value }))} aria-label="Filter by status">
                    {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s ? STATUS[s].label : 'Any status'}</option>)}
                  </select>
                  {multi && (
                    <select value={hf.server} onChange={(e) => setHf((f) => ({ ...f, server: e.target.value }))} aria-label="Filter by server">
                      <option value="@current">This server</option>
                      <option value="">All servers</option>
                      {servers.map((sv) => <option key={sv.id} value={sv.id}>{sv.name}</option>)}
                    </select>
                  )}
                  <button type="button" className={`tog${hf.mine ? ' on' : ''}`} onClick={() => setHf((f) => ({ ...f, mine: !f.mine }))} aria-pressed={hf.mine}>Mine</button>
                  <button type="button" className="icon-btn" onClick={() => loadHistory(false)} title="Refresh" aria-label="Refresh history"><Icon n="redo" size={14} /></button>
                </div>
              </div>
              <div className="hist-b">
                {hist.error && <div className="banner bad">{hist.error}</div>}
                {!hist.error && hist.runs.length === 0 && !hist.loading && <div className="muted pad">No runs yet.</div>}
                {hist.runs.length > 0 && (
                  <table>
                    <thead>
                      <tr><th>Status</th><th>Step</th>{multi && <th>Server</th>}<th>Inputs</th><th>Started</th><th className="r">Took</th><th>By</th><th aria-label="Actions" /></tr>
                    </thead>
                    <tbody>
                      {hist.runs.map((r) => {
                        const inputs = Object.entries(r.inputs || {}).filter(([, v]) => v !== '' && v !== false);
                        return (
                          <tr key={r.id} className={r.id === runId ? 'on' : ''} onClick={() => openRun(r.id)} tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') openRun(r.id); }}>
                            <td><Pill status={r.status} stopping={r.stopping} /></td>
                            <td className="b">{r.step_name}</td>
                            {multi && <td className="srvc">{r.server_name || r.server_id}</td>}
                            <td className="inp" title={inputs.map(([k, v]) => `${k}=${v}`).join('\n')}>
                              {inputs.length ? inputs.map(([k, v]) => <span key={k}>{k}<i>=</i>{v === true ? 'yes' : String(v).length > 48 ? `${String(v).slice(0, 47)}…` : String(v)}</span>) : <span className="mute">—</span>}
                            </td>
                            <td title={new Date(r.started_at).toLocaleString()}>{fmtWhen(r.started_at)}</td>
                            <td className="r num">{r.status === 'running' ? <span className="mute">{fmtDuration(secondsSince(r.started_at, now))}</span> : fmtDuration(r.seconds)}</td>
                            <td className="by">{r.started_by}</td>
                            <td className="act" onClick={(e) => e.stopPropagation()}>
                              {canRun && variantOf(allSteps.find((s) => s.id === r.step_id), r.server_id) && (
                                <button type="button" className="icon-btn" onClick={() => rerun(r)} title="Rerun with these inputs" aria-label="Rerun"><Icon n="redo" size={14} /></button>
                              )}
                              <button type="button" className="icon-btn" onClick={() => download(r.id)} title="Download log" aria-label="Download log"><Icon n="down" size={14} /></button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {hist.next && (
                  <button type="button" className="more" onClick={() => loadHistory(true)} disabled={hist.loading}>{hist.loading ? 'Loading…' : 'Load more'}</button>
                )}
              </div>
            </section>
          </main>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.text}<button type="button" onClick={() => setToast(null)} aria-label="Dismiss"><Icon n="x" size={12} /></button></div>}
    </div>
  );
}

const CSS = `
.ilab { --red:#eb1700; --maroon:#9e0000; --green:#328714; --orange:#ff6017; --blue:#0f68b2;
  --g1:#f1efed; --g2:#e8e6e3; --g3:#d5cfc9; --g4:#cbc4bc; --g5:#a39992; --g6:#81766f; --g7:#6e6259; --g8:#312c2a;
  --display:'JohnsonDisplay', Arial, sans-serif; --text:'JohnsonText', Arial, sans-serif;
  --mono:ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --shadow:0 1px 2px rgba(49,44,42,.06), 0 12px 32px -24px rgba(49,44,42,.45);
  position:relative; height:100%; display:flex; flex-direction:column; font-family:var(--text); color:var(--g8); background:var(--g1); }
.ilab *, .ilab *::before, .ilab *::after { box-sizing:border-box; }
.ilab b, .ilab strong { font-weight:700; }
.ilab button { font:inherit; color:inherit; cursor:pointer; }
.ilab button:disabled { cursor:default; opacity:.55; }
.ilab input, .ilab select { font:inherit; color:inherit; }
.ilab :focus-visible { outline:2px solid rgba(235,23,0,.5); outline-offset:2px; }
.ilab .ico { flex:none; }
.ilab .num { font-variant-numeric:tabular-nums; }
.ilab .muted, .ilab .mute { color:var(--g6); }
.ilab .cap { font-size:10.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--g7); }
.ilab code, .ilab kbd { font-family:var(--mono); }
.ilab kbd { font-size:10.5px; padding:1px 5px; border:1px solid var(--g3); border-bottom-width:2px; border-radius:4px; background:#fff; }
.ilab, .ilab * { scrollbar-width:thin; scrollbar-color:var(--g4) transparent; }
.ilab ::-webkit-scrollbar { width:8px; height:8px; }
.ilab ::-webkit-scrollbar-thumb { background:var(--g4); border-radius:9px; }
.ilab ::-webkit-scrollbar-track, .ilab ::-webkit-scrollbar-corner { background:transparent; }

@keyframes il-pulse { 0% { box-shadow:0 0 0 0 rgba(15,104,178,.55); } 70% { box-shadow:0 0 0 7px rgba(15,104,178,0); } 100% { box-shadow:0 0 0 0 rgba(15,104,178,0); } }
@keyframes il-spin { to { transform:rotate(360deg); } }
@keyframes il-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
.ilab .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--blue); animation:il-pulse 1.6s infinite; }
.ilab .spin { width:16px; height:16px; border-radius:50%; border:2px solid var(--g3); border-top-color:var(--red); animation:il-spin .8s linear infinite; display:inline-block; }
.ilab .spin.w { border-color:rgba(255,255,255,.35); border-top-color:#fff; width:14px; height:14px; }
.ilab .center { flex:1; display:flex; align-items:center; justify-content:center; gap:12px; color:var(--g7); padding:24px; text-align:center; }
.ilab .center.col { flex-direction:column; gap:10px; }
.ilab .center.col > span { max-width:460px; line-height:1.5; }
.ilab .empty-cfg .big { width:56px; height:56px; border-radius:16px; background:#fff; box-shadow:var(--shadow); display:grid; place-items:center; color:var(--red); margin-bottom:6px; }
.ilab .empty-cfg code { background:#fff; padding:1px 5px; border-radius:4px; border:1px solid var(--g2); }

.ilab .top { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; padding:20px 24px 4px; }
.ilab .top h1 { margin:0; font-family:var(--display); font-weight:700; font-size:24px; letter-spacing:-.01em; }
.ilab .top p { margin:4px 0 0; font-size:13px; color:var(--g6); }
.ilab .servers { display:flex; align-items:center; gap:4px; padding:4px; border-radius:12px; background:#fff; box-shadow:var(--shadow); flex-wrap:wrap; }
.ilab .srv { display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 11px; border:0; border-radius:9px; background:none; font-size:12.5px; color:var(--g7); white-space:nowrap; transition:background .15s, color .15s; }
.ilab .srv:hover { background:var(--g1); color:var(--g8); }
.ilab .srv.on { background:var(--g8); color:#fff; }
.ilab .sdot { width:7px; height:7px; border-radius:50%; background:var(--g4); flex:none; }
.ilab .sdot.ok { background:#3fae2a; }
.ilab .sdot.bad { background:var(--red); }
.ilab .sdot.wait { background:var(--g4); animation:il-blink 1s ease-in-out infinite; }
@keyframes il-blink { 50% { opacity:.35; } }
.ilab .srv .cnt { min-width:18px; height:18px; padding:0 5px; border-radius:9px; display:inline-grid; place-items:center; font-size:10.5px; font-weight:700; background:#e8f1fa; color:var(--blue); }
.ilab .srv.on .cnt { background:rgba(255,255,255,.2); color:#fff; }
.ilab .schip { font-size:11.5px; padding:2px 8px; border-radius:99px; background:var(--g2); color:var(--g7); }
.ilab td.srvc { color:var(--g7); }
.ilab .banner.bad.top-gap { margin:12px 24px 0; }
.ilab .top-r { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
.ilab .live-n { display:inline-flex; align-items:center; gap:8px; font-size:12.5px; padding:6px 12px; border-radius:99px; background:#fff; box-shadow:var(--shadow); color:var(--blue); white-space:nowrap; }

.ilab .banner { margin:12px 24px 0; padding:10px 14px; border-radius:10px; font-size:13px; line-height:1.45; }
.ilab .banner ul { margin:6px 0 0; padding-left:18px; }
.ilab .banner.warn { background:#fff4ec; border:1px solid #ffd2b8; color:#8a3a00; }
.ilab .banner.bad { background:#fdeceb; border:1px solid #f7c6c1; color:var(--maroon); margin:0 0 10px; }

.ilab .body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(300px,360px) minmax(0,1fr); gap:16px; padding:16px 24px 24px; }
.ilab .left { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:16px; padding:2px; margin:-2px; }
.ilab .right { min-height:0; min-width:0; display:flex; flex-direction:column; gap:16px; }
.ilab .card { background:#fff; border-radius:14px; box-shadow:var(--shadow); border:1px solid rgba(213,207,201,.55); animation:il-in .35s cubic-bezier(.16,1,.3,1) both; }
.ilab .card-h { display:flex; align-items:center; gap:10px; padding:14px 16px 10px; }
.ilab .card-h .n { font-size:11px; color:var(--g6); background:var(--g1); border-radius:99px; padding:1px 8px; }
.ilab .card-h .ttl { font-family:var(--display); font-size:15px; }

.ilab .steps ol { list-style:none; margin:0; padding:0 8px 8px; }
.ilab .step { width:100%; display:flex; align-items:center; gap:12px; text-align:left; padding:10px; border:1px solid transparent; border-radius:10px; background:none; transition:background .15s, border-color .15s; }
.ilab .step:hover { background:var(--g1); }
.ilab .step.on { background:#fff5f3; border-color:#f9cdc6; }
.ilab .step .idx { width:24px; height:24px; flex:none; display:grid; place-items:center; border-radius:7px; background:var(--g2); font-size:12px; font-weight:700; color:var(--g7); }
.ilab .step.on .idx { background:var(--red); color:#fff; }
.ilab .step .nm { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.ilab .step .nm b { font-size:14px; }
.ilab .step .nm small { font-size:12px; color:var(--g6); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ilab .step .dot { flex:none; display:grid; place-items:center; width:18px; }

.ilab .form { padding-bottom:16px; }
.ilab .where { display:flex; align-items:center; gap:7px; margin:0 16px 12px; padding:7px 10px; border-radius:8px; background:var(--g1); color:var(--g7); font-family:var(--mono); font-size:11.5px; min-width:0; }
.ilab .where span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ilab .where.moved { background:#fff5f3; color:var(--maroon); box-shadow:inset 0 0 0 1px #f9cdc6; }
.ilab .where > span:first-of-type { flex:1; min-width:0; }
.ilab .where-a { display:inline-flex; gap:2px; flex:none; margin-left:auto; }
.ilab .lnk.dark { color:var(--g7); font-family:var(--text); font-size:11.5px; font-weight:700; }
.ilab .lnk.dark:hover { color:var(--g8); background:rgba(49,44,42,.08); }
.ilab .where.none { background:#fff4ec; color:#8a3a00; font-family:var(--text); font-weight:600; }
.ilab .where-err { margin:-6px 16px 12px; font-size:11.5px; color:var(--red); }
.ilab .picker { margin:-4px 16px 14px; border:1px solid var(--g3); border-radius:10px; overflow:hidden; background:#fff; animation:il-in .2s both; }
.ilab .pk-bar { display:flex; align-items:center; gap:4px; padding:6px; border-bottom:1px solid var(--g2); background:var(--g1); }
.ilab .pk-bar input { flex:1; min-width:0; height:30px; border:1px solid var(--g3); border-radius:7px; padding:0 8px; font-family:var(--mono); font-size:11.5px; background:#fff; }
.ilab .pk-bar input:focus { outline:none; border-color:var(--g6); }
.ilab .btn.sm { height:28px; padding:0 10px; font-size:12px; }
.ilab .pk-err { padding:8px 10px; font-size:12px; color:var(--maroon); background:#fdeceb; border-bottom:1px solid #f7c6c1; }
.ilab .pk-list { max-height:220px; overflow:auto; padding:4px; }
.ilab .pk-dir { width:100%; display:flex; align-items:center; gap:8px; padding:6px 8px; border:0; border-radius:6px; background:none; text-align:left; font-size:12.5px; color:var(--g8); }
.ilab .pk-dir:hover { background:var(--g1); }
.ilab .pk-dir span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ilab .pk-dir em { font-style:normal; font-family:var(--mono); font-size:10.5px; padding:1px 6px; border-radius:99px; background:#eaf5e5; color:var(--green); }
.ilab .pk-dir.up { color:var(--g7); border-bottom:1px solid var(--g2); border-radius:6px 6px 0 0; margin-bottom:2px; }
.ilab .pk-dir.up span { flex:none; font-family:var(--mono); font-weight:700; }
.ilab .pk-dir.up small { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:var(--mono); font-size:10.5px; color:var(--g5); }
.ilab .pk-empty { padding:14px; text-align:center; font-size:12px; color:var(--g6); }
.ilab .pk-foot { display:flex; align-items:center; gap:6px; padding:6px; border-top:1px solid var(--g2); }
.ilab .pk-here { flex:1; font-size:11.5px; color:var(--g6); padding-left:4px; }
.ilab .pk-here.ok { color:var(--green); }
.ilab .fields { display:flex; flex-direction:column; gap:12px; padding:0 16px; }
.ilab .more-o { margin-top:12px; }
.ilab .more-o > .lnk { color:var(--g7); font-weight:700; margin:0 12px 10px; }
.ilab .more-o > .lnk:hover { color:var(--g8); background:rgba(49,44,42,.08); }
.ilab .more-o > .lnk:disabled { cursor:default; background:none; }
.ilab .venv { margin:12px 16px 0; padding:9px 11px; border-radius:8px; font-size:12px; line-height:1.45; display:flex; flex-direction:column; gap:6px; }
.ilab .venv code { font-family:var(--mono); font-size:11px; word-break:break-all; }
.ilab .venv.muted, .ilab .venv.ok { flex-direction:row; align-items:center; gap:7px; background:var(--g1); color:var(--g7); }
.ilab .venv.ok { overflow:hidden; white-space:nowrap; }
.ilab .venv.ok code { overflow:hidden; text-overflow:ellipsis; word-break:normal; }
.ilab .venv.ok .lnk { margin-left:auto; flex:none; }
.ilab .venv.warn { background:#fff4ec; border:1px solid #ffd2b8; color:#8a3a00; }
.ilab .venv.bad { background:#fdeceb; border:1px solid #f7c6c1; color:var(--maroon); }
.ilab .ext-one { display:flex; flex-direction:column; gap:4px; padding-top:6px; border-top:1px solid #ffd2b8; }
.ilab .ext-one .ext-cmd { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; word-break:normal; }
.ilab .ext-one .lnk, .ilab .ext-one .confirm { align-self:flex-start; }
.ilab .ext-one .confirm { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.ilab .pulse.ext { background:var(--orange); animation:none; }
.ilab .venv ul { margin:0; padding-left:16px; max-height:120px; overflow:auto; }
.ilab .venv select { width:100%; height:32px; border:1px solid #ffd2b8; border-radius:7px; background:#fff; font-size:12px; padding:0 6px; color:var(--g8); }
.ilab .venv-c { display:flex; align-items:center; gap:7px; }
.ilab .venv-a { display:flex; align-items:center; gap:10px; }
.ilab .presets { display:flex; flex-wrap:wrap; gap:6px; margin:0 16px 14px; }
.ilab .chip { height:28px; padding:0 11px; border-radius:99px; border:1px solid var(--g3); background:#fff; font-size:12px; color:var(--g7); transition:background .15s, border-color .15s, color .15s; }
.ilab .chip:hover:not(:disabled) { border-color:var(--g5); color:var(--g8); }
.ilab .chip.on, .ilab .chip.on:hover:not(:disabled) { background:var(--g8); border-color:var(--g8); color:#fff; }
.ilab .con-f code { font-family:var(--mono); font-size:11.5px; }
.ilab .fld { display:flex; flex-direction:column; gap:5px; }
.ilab .fld > label { font-size:12.5px; font-weight:700; color:var(--g8); display:flex; align-items:baseline; gap:6px; }
.ilab .fld > label em { font-style:normal; font-weight:400; font-size:11px; color:var(--g5); }
.ilab .fld input, .ilab .fld select { height:36px; padding:0 10px; border:1px solid var(--g3); border-radius:8px; background:#fff; font-size:13.5px; transition:border-color .15s, box-shadow .15s; width:100%; min-width:0; }
.ilab .fld input:focus, .ilab .fld select:focus { outline:none; border-color:var(--g6); box-shadow:0 0 0 3px rgba(49,44,42,.08); }
.ilab .fld input:disabled, .ilab .fld select:disabled { background:var(--g1); color:var(--g6); }
.ilab .fld.err input, .ilab .fld.err select { border-color:var(--red); box-shadow:0 0 0 3px rgba(235,23,0,.08); }
.ilab .fld small { font-size:11.5px; color:var(--g6); line-height:1.35; }
.ilab .fld small.bad { color:var(--red); }
.ilab .fld.flag { flex-direction:row; align-items:center; gap:10px; cursor:pointer; user-select:none; }
.ilab .fld.flag.dis { cursor:default; opacity:.6; }
.ilab .fld.flag input { position:absolute; opacity:0; width:1px; height:1px; }
.ilab .sw { flex:none; width:34px; height:20px; border-radius:99px; background:var(--g3); position:relative; transition:background .2s; }
.ilab .sw i { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.2); transition:transform .2s cubic-bezier(.16,1,.3,1); }
.ilab .fld.flag input:checked + .sw { background:var(--red); }
.ilab .fld.flag input:checked + .sw i { transform:translateX(14px); }
.ilab .fld.flag input:focus-visible + .sw { outline:2px solid rgba(235,23,0,.5); outline-offset:2px; }
.ilab .pfw { gap:8px; }
.ilab .pf-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ilab .pf-top > label { font-size:12.5px; font-weight:700; color:var(--g8); display:flex; align-items:baseline; gap:6px; }
.ilab .pf-top > label em { font-style:normal; font-weight:400; font-size:11px; color:var(--g5); }
.ilab .pfw .pf { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ilab .pfw .pf > span { font-size:11.5px; font-weight:600; color:var(--g7); }
.ilab .pfw input, .ilab .pfw select { height:32px; font-size:12.5px; padding:0 8px; border:1px solid var(--g3); border-radius:7px; background:#fff; width:100%; min-width:0; }
.ilab .pfw input.mono { font-family:var(--mono); font-size:11.5px; }
.ilab .pfw input[aria-invalid="true"] { border-color:var(--red); box-shadow:0 0 0 3px rgba(235,23,0,.08); }
.ilab .pf-sw { display:flex; align-items:center; gap:9px; cursor:pointer; font-size:12.5px; color:var(--g8); position:relative; }
.ilab .pf-sw.dis { cursor:default; opacity:.6; }
.ilab .pf-sw input { position:absolute; opacity:0; width:1px; height:1px; }
.ilab .pf-sw input:checked + .sw { background:var(--red); }
.ilab .pf-sw input:checked + .sw i { transform:translateX(14px); }
.ilab .pf-sw input:focus-visible + .sw { outline:2px solid rgba(235,23,0,.5); outline-offset:2px; }
.ilab .pf-sw small { display:block; font-size:11px; color:var(--g6); }
.ilab .pf-3 { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; }
.ilab .pf-sec { border:1px solid var(--g2); border-radius:9px; background:#fff; }
.ilab .pf-sec > summary { cursor:pointer; list-style:none; display:flex; align-items:baseline; gap:8px; padding:9px 11px; font-size:12.5px; font-weight:700; color:var(--g8); }
.ilab .pf-sec > summary::-webkit-details-marker { display:none; }
.ilab .pf-sec > summary::before { content:'▸'; color:var(--g5); font-size:10px; }
.ilab .pf-sec[open] > summary::before { content:'▾'; }
.ilab .pf-sec > summary span { margin-left:auto; font-weight:400; font-size:11px; color:var(--g6); text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.ilab .pf-sec > summary.bad, .ilab .pf-sec > summary.bad span { color:var(--red); }
.ilab .pf-sec[open] { padding-bottom:10px; }
.ilab .pf-sec[open] > :not(summary) { margin:0 11px 8px; }
.ilab .pf-sec h4 { margin:4px 11px 6px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--g6); }
.ilab .pf-meta { display:flex; flex-direction:column; gap:8px; }
.ilab .pf-meta p { margin:0; font-size:11.5px; }
.ilab .pf-row { display:flex; flex-direction:column; gap:6px; padding:8px; border-radius:8px; background:var(--g1); }
.ilab .pf-row-h { display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(0, 1fr) 28px; gap:6px; align-items:center; }
.ilab .pf-fp { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--g7); }
.ilab .pf-fp input { width:56px; flex:none; }
.ilab .pf-json { margin:0 0 6px; max-height:260px; overflow:auto; padding:10px; border-radius:8px; background:var(--g8); color:#f1efed; font-family:var(--mono); font-size:11px; line-height:1.5; }
.ilab small.pf-err { margin-top:-4px; font-size:11.5px; color:var(--red); }
.ilab .flag-l { display:flex; flex-direction:column; font-size:13px; font-weight:700; }
.ilab .flag-l small { font-weight:400; }

.ilab .cmd { margin:16px 16px 14px; padding:10px 12px; border-radius:10px; background:#1f1c1b; color:#ece9e6; }
.ilab .cmd-h { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
.ilab .cmd-h .cap { color:#a39992; }
.ilab .cmd code { display:block; font-size:12px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
.ilab .cmd .mute { color:#81766f; }
.ilab .cmd small { display:block; margin-top:6px; font-size:11px; color:#a39992; }
.ilab .lnk { display:inline-flex; align-items:center; gap:5px; border:0; background:none; color:#cbc4bc; font-size:11.5px; padding:2px 4px; border-radius:5px; }
.ilab .lnk:hover { color:#fff; background:rgba(255,255,255,.08); }

.ilab .btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; height:32px; padding:0 12px; border-radius:8px; border:1px solid var(--g3); background:#fff; font-size:13px; white-space:nowrap; transition:background .15s, border-color .15s, transform .15s, box-shadow .15s; }
.ilab .btn:hover:not(:disabled) { border-color:var(--g5); }
.ilab .btn.ghost { border-color:transparent; background:transparent; color:var(--g7); }
.ilab .btn.ghost:hover:not(:disabled) { background:var(--g1); border-color:transparent; color:var(--g8); }
.ilab .btn.solid { background:var(--red); border-color:var(--red); color:#fff; font-weight:700; }
.ilab .btn.solid:hover:not(:disabled) { background:#d41500; border-color:#d41500; box-shadow:0 10px 24px -14px rgba(235,23,0,.75); transform:translateY(-1px); }
.ilab .btn.big { width:calc(100% - 32px); margin:0 16px; height:42px; font-size:14px; border-radius:10px; }
.ilab .btn.danger { color:var(--maroon); border-color:#f3c3bd; background:#fff; }
.ilab .btn.danger:hover:not(:disabled) { background:#fdeceb; border-color:#eb9a90; }
.ilab .hint { margin:9px 16px 0; font-size:11.5px; color:var(--g6); text-align:center; line-height:1.4; }
.ilab .lock { margin:4px 16px 0; padding:10px 12px; background:var(--g1); border-radius:8px; font-size:12.5px; line-height:1.45; }
.ilab .form > p.muted:not(.lock) { margin:0 16px 4px; font-size:13px; }

.ilab .console { flex:1 1 0; min-height:340px; display:flex; flex-direction:column; overflow:hidden; }
.ilab .con-h { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:10px 12px 10px 16px; border-bottom:1px solid var(--g2); }
.ilab .con-t { display:flex; align-items:center; gap:10px; min-width:0; flex-wrap:wrap; }
.ilab .con-t > b { font-family:var(--display); font-size:15px; }
.ilab .meta { font-size:12.5px; color:var(--g6); }
.ilab .warn-t { color:var(--orange); }
.ilab .con-a { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ilab .search { display:flex; align-items:center; gap:6px; height:32px; padding:0 8px; border:1px solid var(--g3); border-radius:8px; color:var(--g6); background:#fff; }
.ilab .search:focus-within { border-color:var(--g6); }
.ilab .search input { border:0; outline:none; width:130px; font-size:12.5px; background:transparent; }
.ilab .search .clr { border:0; background:none; color:var(--g6); padding:2px; display:grid; place-items:center; border-radius:4px; }
.ilab .tog { height:32px; padding:0 10px; border-radius:8px; border:1px solid var(--g3); background:#fff; font-size:12.5px; color:var(--g7); }
.ilab .tog.on { background:var(--g8); border-color:var(--g8); color:#fff; }
.ilab .confirm { display:inline-flex; align-items:center; gap:6px; padding:3px 3px 3px 10px; border-radius:10px; background:#fdeceb; font-size:12.5px; color:var(--maroon); animation:il-in .2s both; }
.ilab .con-b { position:relative; flex:1; min-height:0; background:#1b1918; }
.ilab .con-f { padding:7px 16px; font-size:12px; background:#fff4ec; color:#8a3a00; border-top:1px solid #ffd2b8; }
.ilab .log { position:absolute; inset:0; overflow:auto; font-family:var(--mono); font-size:12px; color:#e5e1dd; outline:none; scrollbar-color:#4a4340 transparent; }
.ilab .log::-webkit-scrollbar-thumb { background:#4a4340; }
.ilab .log-in { position:relative; }
.ilab .log-empty { padding:24px 20px; color:#81766f; font-family:var(--text); font-size:13px; }
.ilab .ln { position:absolute; left:0; right:0; height:${ROW}px; line-height:${ROW}px; display:flex; white-space:pre; padding-right:16px; }
.ilab .ln:hover { background:rgba(255,255,255,.035); }
.ilab .ln .no { flex:none; width:56px; padding-right:12px; text-align:right; color:#5c5450; user-select:none; }
.ilab .ln .tm { flex:none; width:68px; color:#7d736d; user-select:none; }
.ilab .ln .tx { flex:none; }
.ilab .ln mark { background:#ffd45c; color:#1b1918; border-radius:2px; }
.ilab .ln.status .tx { color:#fff; font-weight:700; }
.ilab .ln.info .tx { color:#a39992; }
.ilab .ln.error .tx { color:#ff7b6b; font-weight:700; }
.ilab .ln.success .tx { color:#7fd36a; font-weight:700; }
.ilab .ln.output.e .tx { color:#ff9d90; }
.ilab .ln.output.w .tx { color:#ffc56b; }
.ilab .ln.sep span { position:absolute; left:16px; right:16px; top:50%; border-top:1px dashed #3d3734; }
.ilab .ln.gap { justify-content:center; color:#a39992; font-family:var(--text); font-size:11.5px; background:repeating-linear-gradient(135deg, rgba(255,255,255,.03) 0 8px, transparent 8px 16px); }
.ilab .jump { position:absolute; right:18px; bottom:16px; display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 12px; border-radius:99px; border:0; background:var(--red); color:#fff; font-size:12.5px; box-shadow:0 8px 20px -8px rgba(0,0,0,.6); animation:il-in .2s both; }

.ilab .pill { display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 9px; border-radius:99px; font-size:11.5px; font-weight:700; white-space:nowrap; }
.ilab .pill.run { background:#e8f1fa; color:var(--blue); }
.ilab .pill.ok { background:#eaf5e5; color:var(--green); }
.ilab .pill.bad { background:#fdeceb; color:var(--maroon); }
.ilab .pill.warn { background:#fff1e8; color:#b24400; }
.ilab .pill.mute { background:var(--g2); color:var(--g7); }

.ilab .hist { flex:0 0 auto; height:min(340px, 40%); min-height:200px; display:flex; flex-direction:column; overflow:hidden; }
.ilab .hist-h { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:10px 12px 10px 16px; border-bottom:1px solid var(--g2); }
.ilab .hist-f { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ilab .hist-f select { height:32px; border:1px solid var(--g3); border-radius:8px; padding:0 8px; font-size:12.5px; background:#fff; }
.ilab .icon-btn { width:30px; height:30px; display:inline-grid; place-items:center; border:0; border-radius:7px; background:none; color:var(--g6); }
.ilab .icon-btn:hover { background:var(--g1); color:var(--g8); }
.ilab .hist-b { flex:1; min-height:0; overflow:auto; padding:0 0 8px; }
.ilab .hist-b .pad { padding:18px 16px; font-size:13px; }
.ilab .hist-b .banner { margin:10px 12px; }
.ilab table { width:100%; border-collapse:collapse; font-size:12.5px; }
.ilab thead th { position:sticky; top:0; z-index:1; background:#fff; text-align:left; font-weight:400; font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--g6); padding:9px 10px; border-bottom:1px solid var(--g2); }
.ilab th:first-child, .ilab td:first-child { padding-left:16px; }
.ilab tbody tr { cursor:pointer; transition:background .12s; }
.ilab tbody tr:hover { background:var(--g1); }
.ilab tbody tr.on { background:#fff5f3; }
.ilab td { padding:8px 10px; border-bottom:1px solid var(--g2); vertical-align:middle; white-space:nowrap; }
.ilab td.b { font-weight:700; }
.ilab td.r, .ilab th.r { text-align:right; }
.ilab td.by { color:var(--g7); max-width:160px; overflow:hidden; text-overflow:ellipsis; }
.ilab td.inp { max-width:260px; overflow:hidden; text-overflow:ellipsis; font-family:var(--mono); font-size:11.5px; color:var(--g7); }
.ilab td.inp span + span { margin-left:8px; }
.ilab td.inp i { font-style:normal; color:var(--g5); }
.ilab td.act { text-align:right; padding-right:10px; }
.ilab .more { display:block; margin:10px auto 2px; height:30px; padding:0 14px; border-radius:8px; border:1px solid var(--g3); background:#fff; font-size:12.5px; }

.ilab .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:50; display:flex; align-items:center; gap:10px; max-width:min(560px, calc(100vw - 32px)); padding:10px 10px 10px 16px; border-radius:12px; background:var(--g8); color:#fff; font-size:13px; box-shadow:0 18px 40px -16px rgba(0,0,0,.55); animation:il-in .25s both; }
.ilab .toast.bad { background:var(--maroon); }
.ilab .toast.warn { background:#8a3a00; }
.ilab .toast button { border:0; background:rgba(255,255,255,.12); color:#fff; width:24px; height:24px; border-radius:6px; display:grid; place-items:center; flex:none; }

@media (max-width: 1100px) {
  .ilab { height:auto; min-height:100%; }
  .ilab .body { grid-template-columns:minmax(0,1fr); }
  .ilab .left { overflow:visible; }
  .ilab .console { flex:none; height:520px; }
  .ilab .hist { height:420px; }
}
@media (max-width: 640px) {
  .ilab .top, .ilab .body { padding-left:16px; padding-right:16px; }
  .ilab .banner, .ilab .banner.bad.top-gap { margin-left:16px; margin-right:16px; }
  .ilab .top { flex-direction:column; align-items:stretch; }
  .ilab .top-r { justify-content:flex-start; }
  .ilab .search input { width:90px; }
  .ilab .confirm > span { display:none; }
}
@media (prefers-reduced-motion: reduce) {
  .ilab *, .ilab *::before, .ilab *::after { animation:none !important; transition:none !important; }
}
`;