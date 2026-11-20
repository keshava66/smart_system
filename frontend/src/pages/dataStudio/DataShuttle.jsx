import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchJson, formatBytes } from './shared/studioHelpers';
import { apiEventSource } from '../../utils/apiClient';
import { IconDefs, Icon } from './shared/studioParts';

import playIcon from "/icons/JJ_Icon_Video_Play_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import sfIcon from "/icons/snowflake_badge.svg";
import pgIcon from "/icons/postgres_badge.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";

const API = '/api/shuttle';
const NEW_SCHEMA = '__new_schema__';
const ENGINE = { pg_to_sf: ['postgres', 'snowflake'], sf_to_pg: ['snowflake', 'postgres'] };
const NAME = { postgres: 'Postgres', snowflake: 'Snowflake' };
const ICON = { postgres: pgIcon, snowflake: sfIcon };
const LOG_COLOR = { info: '#cbc4bc', success: '#7fc25f', warn: '#f0a35e', error: '#ff8a7a' };
const PHASE = {
  queued: 'queued', starting: 'starting', preparing: 'preparing', unloading: 'Snowflake unloading',
  'waiting for connections': 'waiting for free connections',
  copying: 'copying', verifying: 'checking row counts', finalizing: 'swapping into target',
  done: 'done', failed: 'failed', cancelled: 'cancelled',
};

const fmtDur = (sec) => {
  if (sec == null) return '-';
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
};
const fmtBytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round((b || 0) / 1024 ** 2)} MB`);
const STEP_COLOR = { reading: '#2f6fb3', downloading: '#2f6fb3', uploading: '#a14a00', 'COPY INTO': '#eb1700', loading: '#eb1700', waiting: '#b8afa8' };

// The live picture of a running table: both stages, speed, time left and what
// every worker is doing this second. Fed by the job stream, so it moves as the
// data does.
function LivePanel({ live }) {
  const fetchPct = live.files_total ? (live.fetched / live.files_total) * 100 : 0;
  const loadPct = live.percent;
  const busy = live.workers.filter(w => w.file);
  const waiting = live.workers.length - busy.length;
  const Stat = ({ label, value }) => (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-[#81766f]">{label}</span>
      <span className="text-[13px] font-medium text-[#312c2a] tabular-nums">{value}</span>
    </div>
  );
  return (
    <div className="mt-2.5 flex flex-col gap-3 p-3 bg-[#f8f7f5] border border-[#f1efed] rounded-lg">
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Done" value={`${live.percent}%`} />
        <Stat label="Rows / sec" value={fmtN(live.rows_s)} />
        <Stat label="Time left" value={live.eta_secs != null ? `~${fmtDur(live.eta_secs)}` : 'working it out'} />
        <Stat label="Running for" value={fmtDur(live.elapsed_secs)} />
      </div>

      {[
        {
          label: `${live.fetch_word[0].toUpperCase()}${live.fetch_word.slice(1)}`,
          pct: fetchPct,
          text: `${live.fetched}/${live.files_total} files`
            + (live.total_bytes ? ` · ${fmtBytes(live.fetched_bytes)} of ${fmtBytes(live.total_bytes)}` : '')
            + (!live.total_bytes && live.read_rows ? ` · ${fmtN(live.read_rows)} rows` : '')
            + ` · ${live.fetch_mb_s} MB/s`,
          tone: '#2f6fb3',
        },
        {
          label: `${live.load_word[0].toUpperCase()}${live.load_word.slice(1)}`,
          pct: loadPct,
          text: `${live.loaded}/${live.files_total} files · ${fmtN(live.rows)}${live.total_rows ? ` of ${fmtN(live.total_rows)}` : ''} rows`,
          tone: '#eb1700',
        },
      ].map(stage => (
        <div key={stage.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="font-medium text-[#312c2a]">{stage.label}</span>
            <span className="text-[#6e6259] tabular-nums">{stage.text}</span>
          </div>
          <ProgressBar pct={Math.min(100, stage.pct)} tone={stage.tone} />
        </div>
      ))}

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[#81766f]">
          Now · {busy.length} working{waiting ? `, ${waiting} waiting for files` : ''}
        </span>
        <div className="max-h-[150px] overflow-y-auto flex flex-col gap-0.5">
          {busy.sort((a, b) => b.secs - a.secs).map((w, i) => (
            <div key={i} className="flex items-center gap-2 text-[11.5px] font-mono">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STEP_COLOR[w.step] || '#81766f' }} />
              <span className="w-[86px] flex-shrink-0 text-[#6e6259]">{w.step}</span>
              <span className="flex-1 min-w-0 truncate text-[#312c2a]" title={w.file}>{w.file}</span>
              {w.rows != null && <span className="text-[#6e6259] tabular-nums">{fmtN(w.rows)} rows</span>}
              <span className="w-[70px] text-right text-[#6e6259] tabular-nums">{w.percent != null ? `${w.percent}%` : ''}</span>
              <span className="w-[58px] text-right text-[#81766f] tabular-nums">{fmtDur(w.secs)}</span>
            </div>
          ))}
          {!busy.length && <span className="text-[11.5px] text-[#81766f]">Between files…</span>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------- form and progress pieces ----------------------- */

const Field = ({ label, children, hint }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide">{label}</span>
    {children}
    {hint && <span className="text-[11px] text-[#81766f]">{hint}</span>}
  </label>
);

const Select = ({ value, onChange, options, placeholder, disabled }) => (
  <div className="relative">
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="w-full h-[32px] pl-2.5 pr-7 rounded border border-[#e8e6e3] bg-white text-[12.5px] appearance-none disabled:bg-[#f6f5f3] disabled:text-[#81766f]"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
      })}
    </select>
    <Icon src={chevronDownIcon} className="w-2.5 h-2.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" tint="gray" />
  </div>
);

const Pill = ({ active, onClick, children, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    className={`h-[30px] px-3 rounded text-[12.5px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      active ? 'border-[#eb1700] bg-[#fdeeec] text-[#eb1700] font-medium' : 'border-[#e8e6e3] hover:bg-[#f6f5f3]'
    }`}
  >
    {children}
  </button>
);

const BADGE = {
  pending: { label: 'queued', bg: '#f6f5f3', fg: '#6e6259', dot: '#81766f' },
  running: { label: 'copying', bg: '#fdeeec', fg: '#eb1700', dot: '#eb1700' },
  success: { label: 'done', bg: '#eef6ea', fg: '#328714', dot: '#328714' },
  failed: { label: 'failed', bg: '#fdf3f1', fg: '#9e0000', dot: '#9e0000' },
  partial: { label: 'partly done', bg: '#fff3ea', fg: '#a14a00', dot: '#a14a00' },
  cancelled: { label: 'cancelled', bg: '#f6f5f3', fg: '#6e6259', dot: '#81766f' },
  interrupted: { label: 'interrupted', bg: '#fff3ea', fg: '#a14a00', dot: '#a14a00' },
  skipped: { label: 'not run', bg: '#f6f5f3', fg: '#81766f', dot: '#c9c2bc' },
};

// Same rule as the backend uses for blank names: a plain lower_case name is
// UPPER_CASE in Snowflake and the other way round, so a typed "orders" finds
// ORDERS instead of creating a quoted "orders" nobody can query unquoted.
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const normName = (name, engine) => {
  const n = (name || '').trim();
  if (!PLAIN.test(n)) return n;
  if (engine === 'snowflake' && n === n.toLowerCase()) return n.toUpperCase();
  if (engine === 'postgres' && n === n.toUpperCase()) return n.toLowerCase();
  return n;
};

const Badge = ({ status }) => {
  const b = BADGE[status] || { ...BADGE.failed, label: status || 'unknown' };
  return (
    <span className="inline-flex items-center gap-1.5 h-[20px] px-2 rounded text-[10.5px] font-medium" style={{ background: b.bg, color: b.fg }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.dot }} />
      {b.label}
    </span>
  );
};

const ProgressBar = ({ pct, tone = '#eb1700' }) => (
  <div
    className="h-[6px] rounded-full bg-[#f1efed] overflow-hidden"
    role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct == null ? undefined : Math.round(pct)}
  >
    <div
      className="h-full rounded-full transition-all duration-300"
      // Unknown shows empty; a started bar shows at least a sliver.
      style={{ width: `${pct == null || pct <= 0 ? 0 : Math.max(2, Math.min(100, pct))}%`, background: tone }}
    />
  </div>
);

const fmtN = (n) => (n ?? 0).toLocaleString();
const JOB_TONE = { success: '#328714', partial: '#a14a00', failed: '#9e0000', cancelled: '#81766f', interrupted: '#a14a00' };
const fmtElapsed = (ms) => (ms == null ? '-' : ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
  : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);

const EMPTY_FORM = {
  sourceDatabase: '', sourceSchema: '', sourceTable: '', sourceTables: [],
  targetDatabase: '', targetSchema: '', targetTable: '',
};

export default function DataShuttle() {
  const [health, setHealth] = useState(null);
  const [direction, setDirection] = useState('pg_to_sf');
  const [copyType, setCopyType] = useState('table');
  const [ifExists, setIfExists] = useState('fail');
  const [pgConnId, setPgConnId] = useState('');
  const [workers, setWorkers] = useState({ source: '', target: '' });   // '' = auto
  const [form, setForm] = useState(EMPTY_FORM);
  const [customSchema, setCustomSchema] = useState(false);
  const [filter, setFilter] = useState('');

  // catalog cache: "engine:side:conn|db|schema" -> list
  const [cat, setCat] = useState({});
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState(null);
  const [cancelling, setCancelling] = useState(false);   // job id while its cancel is under way
  const [history, setHistory] = useState([]);            // your recent copies
  const [pending, setPending] = useState(null);          // history saves still waiting on the database
  const [showAll, setShowAll] = useState(false);
  const [historyDown, setHistoryDown] = useState(false);   // portal database unreachable for the list

  const streamRef = useRef(null);
  const pollRef = useRef(null);
  const sinceRef = useRef(0);
  const watchingRef = useRef(null);      // the one job id updates may come in for; null = none
  const logBoxRef = useRef(null);

  const [srcEngine, tgtEngine] = ENGINE[direction];
  // Each side is capped by its own database's connection cap.
  const maxFor = (engine) => health?.max_workers?.[engine] || 8;
  const maxWorkers = { source: maxFor(srcEngine), target: maxFor(tgtEngine) };
  const pgConns = health?.postgres?.connections || [];

  useEffect(() => {
    fetchJson(`${API}/health`).then(setHealth).catch(e => setError(e.message));
  }, []);

  const key = (engine, side, db = '', schema = '') =>
    `${engine}:${side}:${engine === 'postgres' ? pgConnId : ''}|${db}|${schema}`;

  const load = useCallback((engine, side, db = '', schema = '', fresh = false) => {
    const k = `${engine}:${side}:${engine === 'postgres' ? pgConnId : ''}|${db}|${schema}`;
    if (cat[k] && !fresh) return;
    setCat(c => ({ ...c, [k]: 'loading' }));
    const q = new URLSearchParams({ engine, side });
    if (db) q.set('database', db);
    if (schema) q.set('schema', schema);
    if (engine === 'postgres' && pgConnId) q.set('conn_id', pgConnId);
    if (fresh) q.set('bypass_cache', 'true');
    fetchJson(`${API}/catalog?${q}`)
      .then(d => setCat(c => ({ ...c, [k]: d.tables || d.schemas || d.databases || [] })))
      .catch(e => { setCat(c => ({ ...c, [k]: [] })); setError(e.message); });
  }, [cat, pgConnId]);

  const list = (k) => (Array.isArray(cat[k]) ? cat[k] : []);
  const loading = (k) => cat[k] === 'loading';

  useEffect(() => { load(srcEngine, 'source'); load(tgtEngine, 'target'); }, [srcEngine, tgtEngine, load]);

  // Lists are cached on the server too, so a table made a minute ago only
  // shows up after a fresh read.
  const refreshLists = () => {
    setError(null);
    load(srcEngine, 'source', '', '', true);
    if (form.sourceDatabase) load(srcEngine, 'source', form.sourceDatabase, '', true);
    if (form.sourceDatabase && form.sourceSchema) load(srcEngine, 'source', form.sourceDatabase, form.sourceSchema, true);
    load(tgtEngine, 'target', '', '', true);
    if (form.targetDatabase) load(tgtEngine, 'target', form.targetDatabase, '', true);
  };

  const set = (patch) => { setForm(f => ({ ...f, ...patch })); setPlan(null); setError(null); };

  const switchDirection = (d) => {
    if (d === direction) return;
    setDirection(d);
    setForm(EMPTY_FORM);
    setWorkers({ source: '', target: '' });   // the limits differ per database
    setCustomSchema(false);
    setPlan(null);
    setError(null);
  };

  /* ------------------------------ job watching ----------------------------- */

  const stop = () => {
    // A poll already in flight would otherwise come back, move sinceRef for
    // the wrong job and schedule itself again, forever.
    watchingRef.current = null;
    if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stop(), []);

  const apply = useCallback((id, patch, logs) => {
    setJob(prev => {
      if (prev && prev.job_id !== id) return prev;
      const base = prev || { job_id: id, logs: [] };
      return { ...base, ...patch, logs: logs?.length ? [...(base.logs || []), ...logs] : (base.logs || []) };
    });
  }, []);

  const poll = useCallback(async (id) => {
    if (watchingRef.current !== id) return;
    try {
      const d = await fetchJson(`${API}/jobs/${id}/status?wait_ms=4000&since_log=${sinceRef.current}`);
      if (watchingRef.current !== id) return;
      sinceRef.current = d.log_count;
      const { logs, ...rest } = d;
      apply(id, rest, logs);
      if (d.status === 'running') pollRef.current = setTimeout(() => poll(id), 500);
    } catch (e) {
      if (watchingRef.current !== id) return;
      if (e.status === 404 || e.status === 403) {
        // The server no longer has this job in memory (restarted, or it
        // expired). Asking again will never work - show what history has.
        watchingRef.current = null;
        try {
          setJob({ ...(await fetchJson(`${API}/history/${id}`)), readOnly: true });
        } catch {
          apply(id, { status: 'interrupted' }, null);
        }
        setError('Lost track of this copy on the server (it was probably restarted). Showing what history has.');
        return;
      }
      // A dropped request on a long job is not the job failing - keep asking.
      pollRef.current = setTimeout(() => poll(id), 5000);
    }
  }, [apply]);

  const watch = useCallback((id) => {
    stop();
    watchingRef.current = id;
    let finished = false;
    const s = apiEventSource(`${API}/jobs/${id}/stream?since_log=${sinceRef.current}`);
    streamRef.current = s;
    const fallBack = () => {
      if (streamRef.current === s) { s.close(); streamRef.current = null; }
      // A copy runs for a long time and proxies drop streams. Whether it never
      // connected, dropped halfway or was closed cleanly by a proxy, polling
      // carries on from the last log line.
      if (!finished && watchingRef.current === id) pollRef.current = setTimeout(() => poll(id), 1000);
    };
    s.addEventListener('logs', (e) => {
      const d = JSON.parse(e.data);
      sinceRef.current = d.log_count;
      apply(id, { log_count: d.log_count }, d.logs);
    });
    s.addEventListener('progress', (e) => apply(id, JSON.parse(e.data), null));
    s.addEventListener('done', () => {
      finished = true;
      if (streamRef.current === s) { s.close(); streamRef.current = null; }
    });
    s.addEventListener('error', fallBack);
    s.addEventListener('end', fallBack);
  }, [apply, poll]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [job?.logs?.length]);

  /* ------------------------------ history ---------------------------------- */

  const loadHistory = useCallback(
    () => fetchJson(`${API}/history?limit=30`)
      .then(d => { setHistory(d.jobs || []); setHistoryDown(Boolean(d.db_error)); return d; })
      .catch(() => null),
    [],
  );
  const pendingCount = useRef(0);
  const loadPending = useCallback(
    () => fetchJson(`${API}/history-pending`).then((d) => {
      const n = d?.pending?.length || 0;
      // Something just got saved: the list's "not saved yet" marks are stale.
      if (n < pendingCount.current) loadHistory();
      pendingCount.current = n;
      setPending(d);
    }).catch(() => {}),
    [loadHistory],
  );

  // Open a copy: a running one reconnects to its live stream, a finished one
  // is read back from history.
  const openJob = useCallback(async (j) => {
    stop();
    setError(null);
    try {
      if (j.live) {
        sinceRef.current = 0;
        const d = await fetchJson(`${API}/jobs/${j.job_id}/status?since_log=0`);
        setJob(d);
        sinceRef.current = d.log_count;
        if (d.status === 'running') watch(j.job_id);
      } else {
        setJob({ ...(await fetchJson(`${API}/history/${j.job_id}`)), readOnly: true });
      }
    } catch (e) {
      setError(e.message);
    }
  }, [watch]);

  // Coming back to the page picks a running copy up where it is.
  useEffect(() => {
    loadHistory().then(d => {
      const running = d?.jobs?.find(j => j.live && j.status === 'running');
      if (running) openJob(running);
    });
    loadPending();
    const t = setInterval(loadPending, 30000);
    return () => clearInterval(t);
  }, [loadHistory, loadPending, openJob]);

  // A copy that just finished belongs in the list (and may now be pending).
  const justFinished = Boolean(job && job.status !== 'running' && !job.readOnly);
  useEffect(() => {
    if (!justFinished) return undefined;
    loadHistory(); loadPending();
    // The first save attempt runs just after the copy ends; look again so a
    // database problem shows up now, not on the next 30s tick.
    const t = setTimeout(loadPending, 4000);
    return () => clearTimeout(t);
  }, [justFinished, loadHistory, loadPending]);

  const retryPending = async (id) => {
    try { await fetchJson(`${API}/history-pending/${id}/retry`, { method: 'POST' }); setTimeout(loadPending, 2000); setTimeout(loadPending, 6000); }
    catch (e) { setError(e.message); }
  };
  const abortPending = async (id) => {
    if (!window.confirm('Stop trying to save this copy to history? The copy itself is not affected, only its history record is dropped.')) return;
    try { await fetchJson(`${API}/history-pending/${id}`, { method: 'DELETE' }); loadPending(); loadHistory(); }
    catch (e) { setError(e.message); }
  };

  /* --------------------------------- actions -------------------------------- */

  const body = (confirm) => ({
    direction, copy_type: copyType, if_exists: ifExists,
    pg_conn_id: pgConnId || null,
    source_database: form.sourceDatabase, source_schema: form.sourceSchema,
    source_table: copyType === 'table' ? form.sourceTable : null,
    source_tables: copyType === 'tables' ? form.sourceTables : null,
    target_database: form.targetDatabase,
    // A picked schema is sent exactly as listed; only typed names are normalised.
    target_schema: customSchema ? normName(form.targetSchema, tgtEngine) : form.targetSchema,
    target_table: copyType === 'table' ? (normName(form.targetTable, tgtEngine) || null) : null,
    source_workers: workers.source ? Number(workers.source) : null,
    target_workers: workers.target ? Number(workers.target) : null,
    confirm,
  });

  const check = () => {
    if (!form.sourceDatabase || !form.sourceSchema) return 'Pick a source database and schema.';
    if (copyType === 'table' && !form.sourceTable) return 'Pick a source table.';
    if (copyType === 'tables' && !form.sourceTables.length) return 'Pick at least one table.';
    if (!form.targetDatabase || !form.targetSchema.trim()) return 'Pick a target database and schema.';
    for (const side of ['source', 'target']) {
      const v = workers[side];
      if (v && !(Number(v) >= 1 && Number(v) <= maxWorkers[side])) {
        return `${side === 'source' ? 'Source' : 'Target'} workers must be 1 to ${maxWorkers[side]}, or blank for auto.`;
      }
    }
    return null;
  };

  const preview = async () => {
    const msg = check();
    if (msg) { setError(msg); return; }
    setPlanning(true);
    setError(null);
    try {
      setPlan(await fetchJson(`${API}/start`, { method: 'POST', body: body(false) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setPlanning(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const d = await fetchJson(`${API}/start`, { method: 'POST', body: body(true) });
      sinceRef.current = 0;
      setJob({ job_id: d.job_id, status: 'running', tables: [], logs: [], percent: 0, elapsed_ms: 0,
               source: '', target: '', tables_total: d.tables_total, tables_done: 0 });
      setPlan(null);
      watch(d.job_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setCancelling(job.job_id);
    try { await fetchJson(`${API}/jobs/${job.job_id}/cancel`, { method: 'POST' }); }
    catch (e) { setError(e.message); setCancelling(false); }
  };

  const reset = () => { stop(); setJob(null); setPlan(null); setError(null); loadHistory(); };

  /* --------------------------------- render --------------------------------- */

  const srcDbs = key(srcEngine, 'source');
  const srcSchemas = key(srcEngine, 'source', form.sourceDatabase);
  const srcTables = key(srcEngine, 'source', form.sourceDatabase, form.sourceSchema);
  const tgtDbs = key(tgtEngine, 'target');
  const tgtSchemas = key(tgtEngine, 'target', form.targetDatabase);

  // With no schema picked the tables key is the same as the databases (or
  // schemas) key, so it would list those as tables.
  const srcList = form.sourceSchema ? cat[srcTables] : null;
  const objects = useMemo(
    () => (Array.isArray(srcList) ? srcList : []).filter(t => t && t.name && t.kind !== 'external_table'),
    [srcList],
  );
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return n ? objects.filter(t => t.name.toLowerCase().includes(n)) : objects;
  }, [objects, filter]);
  const tableOptions = objects.map(t => ({
    value: t.name,
    label: `${t.name}${t.kind !== 'table' ? '  (view)' : ''}${t.est_rows ? `  · ~${fmtN(t.est_rows)} rows` : ''}`,
  }));

  const busy = job?.status === 'running';
  const caseHint = tgtEngine === 'snowflake'
    ? 'Blank keeps the source name, in upper case. A typed lower_case name becomes UPPER_CASE.'
    : 'Blank keeps the source name, in lower case. A typed UPPER_CASE name becomes lower_case.';
  const typedTarget = normName(form.targetTable, tgtEngine);
  const typedSchema = normName(form.targetSchema, tgtEngine);
  const configErrors = [health?.snowflake_error, health?.postgres_error, health?.disk_error].filter(Boolean);

  const pgConnPicker = pgConns.length > 1 && (
    <Field label="Postgres connection">
      <Select
        value={pgConnId}
        options={pgConns.map(c => ({ value: c.id, label: c.label }))}
        placeholder="Default"
        onChange={v => { setPgConnId(v); setForm(EMPTY_FORM); setCustomSchema(false); setPlan(null); }}
      />
    </Field>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white text-[#312c2a] font-johnson-text">
      <IconDefs />

      <div className="flex-shrink-0 h-[48px] px-4 border-b border-[#e8e6e3]">
        {/* same column as the content below, so the two line up on wide screens */}
        <div className="mx-auto w-full max-w-5xl h-full flex items-center gap-2.5">
        <Icon src={ICON[srcEngine]} className="w-4 h-4" tint={null} />
        <span className="text-[#81766f]">→</span>
        <Icon src={ICON[tgtEngine]} className="w-4 h-4" tint={null} />
        <span className="text-[14px] font-medium tracking-[-.01em] whitespace-nowrap flex-shrink-0">Data Shuttle</span>
        {health?.snowflake && (
          <span
            className="min-w-0 flex-1 text-[11px] text-[#81766f] truncate"
            title={`Snowflake reads as ${health.snowflake.read_as}, writes as ${health.snowflake.write_as}`}
          >
            Snowflake reads as {health.snowflake.read_as}, writes as {health.snowflake.write_as}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          {health?.free_disk_gb != null && (
            <span className="text-[11px] text-[#81766f] whitespace-nowrap" title="Free space on the portal server for staging files">
              {health.free_disk_gb} GB free
            </span>
          )}
          {!job && (
            <button onClick={refreshLists} className="h-[26px] px-2.5 rounded border border-[#e8e6e3] text-[11.5px] whitespace-nowrap hover:bg-[#f6f5f3]">
              Refresh lists
            </button>
          )}
        </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-5xl">
        {configErrors.length > 0 && (
          <div className="mb-4 flex items-start gap-2 px-3.5 py-2.5 border border-[#f3d0cc] bg-[#fdf3f1] rounded-lg text-[12px] text-[#9e0000]">
            <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">Data Shuttle is not fully set up on this server</div>
              {configErrors.map(m => <div key={m} className="mt-0.5 break-words">{m}</div>)}
            </div>
          </div>
        )}
        {pending?.pending?.length > 0 && (
          <div className="mb-4 border border-[#f3c9a6] bg-[#fff3ea] rounded-lg">
            <div className="flex items-start gap-2 px-3.5 py-2.5 text-[12px] text-[#a14a00]">
              <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium">
                  {pending.pending.length} cop{pending.pending.length === 1 ? 'y is' : 'ies are'} not saved to history yet - the portal database could not be reached.
                </div>
                <div className="mt-0.5">
                  The copies themselves are fine. Their history is kept on the server and retried automatically
                  (3 quick tries, then every 30 minutes 3 times, then every hour) until it is saved or you abort it.
                </div>
              </div>
            </div>
            <div className="divide-y divide-[#f3d9c2] border-t border-[#f3d9c2]">
              {pending.pending.map(p => {
                const wait = Math.max(0, p.next_at - pending.now);
                return (
                  <div key={p.job_id} className="flex items-center gap-3 px-3.5 py-2 text-[11.5px]">
                    <span className="flex-1 min-w-0 truncate text-[#312c2a]" title={p.error || ''}>
                      {p.source} → {p.target} <span className="text-[#81766f]">({p.status})</span>
                    </span>
                    <span className="flex-shrink-0 text-[#a14a00]">
                      {p.attempts} attempt{p.attempts === 1 ? '' : 's'} · next {wait > 0 ? `in ${fmtDur(wait)}` : 'now'}
                    </span>
                    <button onClick={() => retryPending(p.job_id)} className="flex-shrink-0 h-[24px] px-2.5 rounded border border-[#e8c3a3] bg-white hover:bg-[#fffaf6]">
                      Retry now
                    </button>
                    <button onClick={() => abortPending(p.job_id)} className="flex-shrink-0 h-[24px] px-2.5 rounded text-[#9e0000] hover:bg-[#fdf3f1]">
                      Abort saving history
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="mb-5 border border-[#e8e6e3] rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3.5 py-2 bg-[#f6f5f3] border-b border-[#e8e6e3]">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide whitespace-nowrap">Your recent copies</span>
                {historyDown && (
                  <span className="text-[10.5px] text-[#a14a00] truncate" title="The portal database could not be reached, so older copies are not listed">
                    · history database unreachable, showing this server's copies only
                  </span>
                )}
              </span>
              {history.length > 5 && (
                <button onClick={() => setShowAll(v => !v)} className="text-[11px] text-[#eb1700] hover:underline">
                  {showAll ? 'Show fewer' : `Show all ${history.length}`}
                </button>
              )}
            </div>
            <div className="divide-y divide-[#f1efed]">
              {(showAll ? history : history.slice(0, 5)).map(h => (
                <button
                  key={h.job_id}
                  onClick={() => openJob(h)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2 text-left text-[12px] hover:bg-[#f8f7f5] ${
                    job?.job_id === h.job_id ? 'bg-[#fdeeec] hover:bg-[#fdeeec]' : ''}`}
                >
                  <Badge status={h.status} />
                  <span className="flex-1 min-w-0 truncate" title={`${h.source} → ${h.target}`}>{h.source} → {h.target}</span>
                  {h.tables_total > 1 && <span className="flex-shrink-0 text-[10.5px] text-[#81766f]">{h.tables_total} tables</span>}
                  {h.status === 'interrupted' && <span className="text-[10.5px] text-[#a14a00]">by a server restart</span>}
                  {h.saved === false && <span className="text-[10.5px] text-[#a14a00]">not saved yet</span>}
                  {h.rows_copied != null && <span className="flex-shrink-0 text-[#81766f]">{fmtN(h.rows_copied)} rows</span>}
                  {h.started_at && (
                    <span className="flex-shrink-0 w-[118px] text-right text-[#81766f]">
                      {new Date(h.started_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {!job && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-6">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide">Direction</span>
                <div className="flex gap-2">
                  <Pill active={direction === 'pg_to_sf'} onClick={() => switchDirection('pg_to_sf')}>Postgres → Snowflake</Pill>
                  <Pill active={direction === 'sf_to_pg'} onClick={() => switchDirection('sf_to_pg')}>Snowflake → Postgres</Pill>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide">What to copy</span>
                <div className="flex gap-2">
                  <Pill active={copyType === 'table'} onClick={() => { setCopyType('table'); setPlan(null); }}>One table</Pill>
                  <Pill active={copyType === 'tables'} onClick={() => { setCopyType('tables'); setPlan(null); }}>Several</Pill>
                  <Pill active={copyType === 'schema'} onClick={() => { setCopyType('schema'); setPlan(null); }}>Whole schema</Pill>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide">If the target exists</span>
                <div className="flex gap-2">
                  <Pill active={ifExists === 'fail'} onClick={() => { setIfExists('fail'); setPlan(null); }}>Stop</Pill>
                  <Pill active={ifExists === 'overwrite'} onClick={() => { setIfExists('overwrite'); setPlan(null); }}>Replace rows</Pill>
                  <Pill active={ifExists === 'append'} onClick={() => { setIfExists('append'); setPlan(null); }}>Append rows</Pill>
                </div>
              </div>
            </div>

            <div className="text-[12px] text-[#6e6259] bg-[#f8f7f5] border border-[#f1efed] rounded p-3">
              {direction === 'pg_to_sf'
                ? 'Postgres is read in parallel page ranges, all inside one snapshot, so every reader sees the same moment. Each range goes to Snowflake as a compressed file and is loaded with COPY INTO.'
                : 'Snowflake unloads the table to compressed files in one statement, then several files at a time are loaded into Postgres with COPY.'}
              {' '}Everything lands in a staging table first. The target is only touched once the row counts match
              exactly, so a failed or cancelled run leaves it as it was.
              {ifExists === 'overwrite' && ' Replace rows keeps the target table, its grants and indexes, and swaps its rows in one transaction.'}
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div className="flex flex-col gap-3 p-3.5 border border-[#e8e6e3] rounded-lg">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <Icon src={ICON[srcEngine]} className="w-3.5 h-3.5" tint={null} /> Source · {NAME[srcEngine]}
                </span>
                {srcEngine === 'postgres' && pgConnPicker}
                <Field label="Database">
                  <Select
                    value={form.sourceDatabase}
                    options={list(srcDbs)}
                    placeholder={loading(srcDbs) ? 'Loading…' : 'Choose a database'}
                    onChange={v => { set({ sourceDatabase: v, sourceSchema: '', sourceTable: '', sourceTables: [] }); load(srcEngine, 'source', v); }}
                  />
                </Field>
                <Field label="Schema">
                  <Select
                    value={form.sourceSchema}
                    options={list(srcSchemas)}
                    placeholder={loading(srcSchemas) ? 'Loading…' : 'Choose a schema'}
                    disabled={!form.sourceDatabase}
                    onChange={v => { setFilter(''); set({ sourceSchema: v, sourceTable: '', sourceTables: [] }); load(srcEngine, 'source', form.sourceDatabase, v); }}
                  />
                </Field>
                {copyType === 'table' && (
                  <Field label="Table or view">
                    <Select
                      value={form.sourceTable}
                      options={tableOptions}
                      placeholder={loading(srcTables) ? 'Loading…' : 'Choose a table'}
                      disabled={!form.sourceSchema}
                      onChange={v => set({ sourceTable: v })}
                    />
                  </Field>
                )}
                {copyType === 'tables' && (
                  <Field label={`Tables${form.sourceTables.length ? ` · ${form.sourceTables.length} selected` : ''}`}>
                    <div className="border border-[#e8e6e3] rounded">
                      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[#f1efed] bg-[#f8f7f5]">
                        <input
                          value={filter}
                          onChange={e => setFilter(e.target.value)}
                          placeholder="Filter"
                          disabled={!form.sourceSchema}
                          className="flex-1 min-w-0 h-[24px] px-2 rounded border border-[#e8e6e3] text-[11.5px]"
                        />
                        <button
                          type="button"
                          disabled={!shown.length}
                          onClick={() => {
                            const names = shown.map(t => t.name);
                            const allOn = names.every(n => form.sourceTables.includes(n));
                            set({ sourceTables: allOn ? form.sourceTables.filter(n => !names.includes(n)) : [...new Set([...form.sourceTables, ...names])] });
                          }}
                          className="text-[11px] text-[#eb1700] hover:underline disabled:opacity-40"
                        >
                          {shown.length && shown.every(t => form.sourceTables.includes(t.name)) ? 'Clear these' : 'Select these'}
                        </button>
                      </div>
                      <div className="max-h-[190px] overflow-y-auto">
                        {!form.sourceSchema && <div className="px-2.5 py-2 text-[11.5px] text-[#81766f]">Pick a schema first.</div>}
                        {shown.map(t => {
                          const on = form.sourceTables.includes(t.name);
                          return (
                            <label key={t.name} className="flex items-center gap-2 px-2.5 py-1 text-[12px] hover:bg-[#f8f7f5] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => set({ sourceTables: on ? form.sourceTables.filter(n => n !== t.name) : [...form.sourceTables, t.name] })}
                              />
                              <span className="flex-1 min-w-0 truncate" title={t.name}>{t.name}</span>
                              {t.est_rows != null && <span className="text-[10.5px] text-[#81766f]">~{fmtN(t.est_rows)}</span>}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </Field>
                )}
              </div>

              <div className="flex flex-col gap-3 p-3.5 border border-[#e8e6e3] rounded-lg">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <Icon src={ICON[tgtEngine]} className="w-3.5 h-3.5" tint={null} /> Target · {NAME[tgtEngine]}
                </span>
                {tgtEngine === 'postgres' && pgConnPicker}
                <Field label="Database">
                  <Select
                    value={form.targetDatabase}
                    options={list(tgtDbs)}
                    placeholder={loading(tgtDbs) ? 'Loading…' : 'Choose a database'}
                    onChange={v => { setCustomSchema(false); set({ targetDatabase: v, targetSchema: '' }); load(tgtEngine, 'target', v); }}
                  />
                </Field>
                <Field label="Schema">
                  <Select
                    value={customSchema ? NEW_SCHEMA : form.targetSchema}
                    options={[{ value: NEW_SCHEMA, label: '+ New schema…' }, ...list(tgtSchemas)]}
                    placeholder={loading(tgtSchemas) ? 'Loading…' : 'Choose a schema'}
                    disabled={!form.targetDatabase}
                    onChange={v => { setCustomSchema(v === NEW_SCHEMA); set({ targetSchema: v === NEW_SCHEMA ? '' : v }); }}
                  />
                </Field>
                {customSchema && (
                  <Field
                    label="New schema name"
                    hint={`Created when the copy starts${typedSchema && typedSchema !== form.targetSchema.trim() ? ` as ${typedSchema}` : ''}.`}
                  >
                    <input
                      value={form.targetSchema}
                      onChange={e => set({ targetSchema: e.target.value })}
                      placeholder={tgtEngine === 'snowflake' ? 'SCHEMA_NAME' : 'schema_name'}
                      spellCheck={false}
                      className="w-full h-[32px] px-2.5 rounded border border-[#e8e6e3] text-[12.5px]"
                    />
                  </Field>
                )}
                {copyType === 'table' ? (
                  <Field
                    label="Table name"
                    hint={typedTarget && typedTarget !== form.targetTable.trim() ? `Lands as ${typedTarget}.` : caseHint}
                  >
                    <input
                      value={form.targetTable}
                      onChange={e => set({ targetTable: e.target.value })}
                      placeholder={form.sourceTable || 'target_table'}
                      spellCheck={false}
                      className="w-full h-[32px] px-2.5 rounded border border-[#e8e6e3] text-[12.5px]"
                    />
                  </Field>
                ) : (
                  <div className="text-[11px] text-[#81766f]">
                    Every table keeps its name, in {tgtEngine === 'snowflake' ? 'upper' : 'lower'} case when it is a plain name.
                  </div>
                )}
              </div>
            </div>

            <details className="text-[12px] text-[#6e6259]">
              <summary className="cursor-pointer select-none w-fit hover:text-[#312c2a]">
                Advanced
                {(workers.source || workers.target) && ` · workers ${workers.source || 'auto'} / ${workers.target || 'auto'}`}
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-5">
                  {['source', 'target'].map(side => {
                    const engine = side === 'source' ? srcEngine : tgtEngine;
                    return (
                      <Field key={side} label={`${side === 'source' ? 'Source' : 'Target'} workers · ${NAME[engine]}`} hint={`1 to ${maxWorkers[side]}`}>
                        <input
                          type="number" min="1" max={maxWorkers[side]} step="1" value={workers[side]}
                          onChange={e => {
                            // Whole numbers only, and never above what this server allows.
                            const v = e.target.value.replace(/\D/g, '');
                            const next = v === '' ? '' : String(Math.min(maxWorkers[side], Math.max(1, Number(v))));
                            setWorkers(w => ({ ...w, [side]: next }));
                            setPlan(null);
                          }}
                          placeholder="Auto"
                          className="w-[140px] h-[32px] px-2.5 rounded border border-[#e8e6e3] text-[12.5px]"
                        />
                      </Field>
                    );
                  })}
                </div>
                <span className="text-[11px] text-[#81766f]">
                  Optional. Leave blank and Data Shuttle sizes each side per table. Source workers read
                  {srcEngine === 'postgres' ? ' Postgres page ranges' : ' files from Snowflake'}, target workers load
                  {tgtEngine === 'snowflake' ? ' them into Snowflake' : ' them into Postgres'}. Raise the slower side.
                </span>
              </div>
            </details>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 bg-[#fdf3f1] border border-[#f3d0cc] rounded text-[12px] text-[#9e0000]">
                <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 whitespace-pre-wrap">{error}</div>
              </div>
            )}

            {!plan && (
              <button
                onClick={preview}
                disabled={planning}
                className="self-start h-[34px] px-4 rounded bg-[#eb1700] text-white text-[12.5px] font-medium hover:bg-[#c51300] disabled:opacity-50"
              >
                {planning ? 'Checking…' : 'Preview copy'}
              </button>
            )}

            {plan && (
              <div className="border border-[#e8e6e3] rounded-lg overflow-hidden">
                <div className="px-3.5 py-2.5 bg-[#f6f5f3] border-b border-[#e8e6e3] text-[12.5px] font-medium">
                  {plan.items.length} table{plan.items.length === 1 ? '' : 's'} · ~{fmtN(plan.items.reduce((s, i) => s + (i.est_rows || 0), 0))} rows
                  {!plan.target_schema_exists && <span className="ml-2 font-normal text-[11.5px] text-[#a14a00]">schema {customSchema ? typedSchema : form.targetSchema} will be created</span>}
                </div>
                <div className="max-h-[260px] overflow-y-auto divide-y divide-[#f1efed]">
                  {plan.items.map(i => (
                    <div key={i.n} className="px-3.5 py-2 text-[12px]">
                      <div className="flex items-center gap-3">
                        <span className="flex-1 min-w-0 truncate" title={`${i.name} → ${i.target}`}>{i.name} → {i.target}</span>
                        {i.target_exists && (
                          <span className="px-1.5 py-0.5 rounded bg-[#fff3ea] text-[#a14a00] text-[10.5px]">
                            exists · {ifExists === 'overwrite' ? 'rows replaced' : 'rows appended'}
                          </span>
                        )}
                        <span className="flex-shrink-0 text-[#6e6259]">
                          ~{fmtN(i.est_rows)} rows{i.bytes ? ` · ${formatBytes(i.bytes)}` : ''} · {i.columns} cols
                        </span>
                      </div>
                      {i.warnings.map((w, k) => <div key={k} className="mt-0.5 text-[11px] text-[#a14a00]">{w}</div>)}
                    </div>
                  ))}
                </div>
                {plan.warnings?.length > 0 && (
                  <div className="px-3.5 py-2 bg-[#fff3ea] text-[11.5px] text-[#a14a00]">{plan.warnings.join(' · ')}</div>
                )}
                <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-[#e8e6e3]">
                  <button
                    onClick={start}
                    disabled={starting}
                    className="flex items-center gap-2 h-[32px] px-4 rounded bg-[#eb1700] text-white text-[12.5px] font-medium hover:bg-[#c51300] disabled:opacity-50"
                  >
                    <Icon src={playIcon} className="w-2.5 h-2.5" tint="white" />
                    {starting ? 'Starting…' : 'Start copy'}
                  </button>
                  <button onClick={() => setPlan(null)} className="h-[32px] px-3 rounded border border-[#e8e6e3] text-[12.5px] hover:bg-[#f6f5f3]">
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {job && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Badge status={job.status} />
                <span className="text-[13px] font-medium truncate" title={job.source ? `${job.source} → ${job.target}` : ''}>
                  {job.source ? `${job.source} → ${job.target}` : 'Starting…'}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[11.5px] text-[#81766f]">{fmtElapsed(job.elapsed_ms)}</span>
                {job.readOnly && (
                  <span className="text-[11px] text-[#81766f]">{job.saved === false ? 'from history (not saved yet)' : 'from history'}</span>
                )}
                {busy && !job.readOnly && (
                  <button
                    onClick={reset}
                    title="Hide this copy and go back to the form. It keeps running - reopen it from Your recent copies."
                    className="h-[28px] px-3 rounded border border-[#e8e6e3] text-[12px] hover:bg-[#f6f5f3]"
                  >
                    Close view
                  </button>
                )}
                {busy && !job.readOnly && (
                  <button onClick={cancel} disabled={cancelling === job.job_id} className="h-[28px] px-3 rounded border border-[#e8e6e3] text-[12px] hover:bg-[#f6f5f3] disabled:opacity-50">
                    {cancelling === job.job_id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
                {(!busy || job.readOnly) && (
                  <button onClick={reset} className="h-[28px] px-3 rounded bg-[#eb1700] text-white text-[12px] hover:bg-[#c51300]">
                    {job.readOnly ? 'Back' : 'New copy'}
                  </button>
                )}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 bg-[#fdf3f1] border border-[#f3d0cc] rounded text-[12px] text-[#9e0000]">
                <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 whitespace-pre-wrap">{error}</div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11.5px] text-[#6e6259]">
                <span>{job.tables_done}/{job.tables_total} table{job.tables_total === 1 ? '' : 's'} · {fmtN(job.rows_copied)} of ~{fmtN(job.est_rows_total)} rows</span>
                <span>{job.percent != null ? `${job.percent}%` : '-'}</span>
              </div>
              <ProgressBar pct={job.percent} tone={JOB_TONE[job.status] || '#eb1700'} />
            </div>

            {job.tables?.length > 0 && (
              <div className="border border-[#e8e6e3] rounded-lg overflow-hidden">
                <div className="max-h-[520px] overflow-y-auto divide-y divide-[#f1efed]">
                  {job.tables.map(t => {
                    const cancelled = t.phase === 'cancelled' || t.error === 'Cancelled';
                    const pct = t.status === 'success' ? 100
                      : t.live ? t.live.percent
                        : t.est_rows ? Math.min(99, Math.round((t.rows_copied / t.est_rows) * 100))
                          : t.chunks_total ? Math.round((t.chunks_done / t.chunks_total) * 100) : 0;
                    return (
                      <div key={t.name} className="px-3.5 py-2.5">
                        <div className="flex items-center justify-between mb-1.5 gap-3">
                          <span className="min-w-0 text-[12.5px] font-medium truncate" title={`${t.name} → ${t.target}`}>{t.name} → {t.target}</span>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-[11px] text-[#81766f]">
                              {t.status === 'running' && `${PHASE[t.phase] || t.phase}${t.phase_secs != null ? ` ${fmtDur(t.phase_secs)}` : ''} · `}
                              {fmtN(t.rows_copied)}{t.est_rows ? ` / ${fmtN(t.est_rows)}` : ''} rows
                              {t.chunks_total > 0 && (t.status === 'running'
                                ? ` · ${job.direction === 'sf_to_pg' ? 'downloaded' : 'read'} ${t.chunks_fetched || 0}/${t.chunks_total} · loaded ${t.chunks_done}/${t.chunks_total} files`
                                : ` · ${t.chunks_done}/${t.chunks_total} files`)}
                            </span>
                            <Badge status={cancelled ? 'cancelled' : t.status} />
                          </div>
                        </div>
                        <ProgressBar
                          pct={t.status === 'failed' && !cancelled ? 100 : pct}
                          tone={cancelled ? '#81766f' : t.status === 'failed' ? '#9e0000' : t.status === 'success' ? '#328714' : '#eb1700'}
                        />
                        {t.live && <LivePanel live={t.live} />}
                        {t.error && t.error !== 'Cancelled' && <div className="mt-1 text-[11px] text-[#9e0000] [overflow-wrap:anywhere]">{t.error}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[#6e6259] uppercase tracking-wide">Activity log</span>
              <div ref={logBoxRef} className="h-[240px] overflow-y-auto bg-[#312c2a] rounded-lg p-3 font-mono text-[11.5px] leading-[1.6]">
                {!job.logs?.length && (
                  <div className="text-[#6e6259]">{job.readOnly || job.status !== 'running' ? 'No activity log was saved for this copy.' : 'Waiting for the first update…'}</div>
                )}
                {(job.logs || []).map((l, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-[#81766f] flex-shrink-0">{new Date(l.ts * 1000).toLocaleTimeString()}</span>
                    <span style={{ color: LOG_COLOR[l.level] || '#cbc4bc' }} className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}