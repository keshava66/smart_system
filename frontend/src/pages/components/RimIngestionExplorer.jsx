import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import {
  Activity, Check, ChevronDown, Copy, Database, Download, FileSearch, FilterX, Layers,
  RefreshCw, Search, X,
} from 'lucide-react';
import { useRBAC } from '../../context/RBACContext';
import { apiFetch, downloadFile } from '../../utils/apiClient';
import { useReducedMotion } from '../../utils/motion';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import Arrow from '../../components/Arrow';

// RIMDocs Ingestion tab: which rimdocs_palm_pah_dt documents made it into a
// doc_chunks table. Backed by /api/rim-ingestion/*; the server keeps the
// matched rows for the picked source, so the page filters below are instant.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const API = `${API_BASE_URL}/api/rim-ingestion`;

const INGESTED = 'Ingested';
const NOT_INGESTED = 'Not ingested';
const GREEN = '#328714';
const RED = '#eb1700';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const PICKS = [
  { id: 'status', label: 'Ingestion status' },
  { id: 'approval', label: 'Approval status' },
  { id: 'object_type', label: 'Object type' },
  { id: 'domain', label: 'Domain' },
];

const BREAKDOWNS = [
  { id: 'product_code', label: 'Product' },
  { id: 'a_status', label: 'Approval status' },
  { id: 'domain', label: 'Domain' },
  { id: 'r_object_type', label: 'Object type' },
  { id: 'r_version_label', label: 'Version label' },
  { id: 'region', label: 'Region' },
  { id: 'country', label: 'Country' },
  { id: 'a_content_type', label: 'Content type' },
];

const COLUMNS = [
  { key: 'ingestion_status', label: 'Status', width: 132 },
  { key: 'product_code', label: 'Product', width: 170 },
  { key: 'r_object_id', label: 'Object ID', width: 170, mono: true },
  { key: 'edms_number', label: 'EDMS number', width: 150, mono: true },
  { key: 'object_name', label: 'Document', width: 320 },
  { key: 'a_status', label: 'Approval', width: 120 },
  { key: 'r_object_type', label: 'Object type', width: 150 },
  { key: 'domain', label: 'Domain', width: 140 },
  { key: 'r_version_label', label: 'Version', width: 110 },
  { key: 'approved_date', label: 'Approved', width: 120 },
  { key: 'chunk_count', label: 'Chunks', width: 96, numeric: true },
];

const DETAIL_LABELS = {
  ingestion_status: 'Ingestion status', product_code: 'Product code', r_object_id: 'Object ID',
  edms_number: 'EDMS number', object_name: 'Document name', a_status: 'Approval status',
  r_object_type: 'Object type', domain: 'Domain', r_version_label: 'Version label',
  approved_date: 'Approved', chunk_count: 'Chunks',
};

// Scoped styles: shimmer + bar growth. Off when the portal's motion setting is.
const STYLES = `
@keyframes ri-shimmer { from { background-position: -320px 0; } to { background-position: 320px 0; } }
@keyframes ri-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes ri-pulse { 0% { box-shadow: 0 0 0 0 rgba(83,206,118,.55); } 70% { box-shadow: 0 0 0 7px rgba(83,206,118,0); } 100% { box-shadow: 0 0 0 0 rgba(83,206,118,0); } }
@keyframes ri-bar { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
.ri-skel { background: linear-gradient(90deg,#f1efed 0px,#e8e6e3 160px,#f1efed 320px); background-size: 640px 100%; animation: ri-shimmer 1.3s linear infinite; }
.ri-in { animation: ri-in .34s cubic-bezier(.2,0,0,1) both; }
.ri-live { animation: ri-pulse 2s ease-out infinite; }
.ri-progress::after { content: ''; position: absolute; inset: 0; width: 40%; background: linear-gradient(90deg,transparent,#eb1700,transparent); animation: ri-bar 1.1s cubic-bezier(.4,0,.2,1) infinite; }
.ri-grow { transition: width .55s cubic-bezier(.2,0,0,1), height .55s cubic-bezier(.2,0,0,1), stroke-dashoffset .8s cubic-bezier(.2,0,0,1); }
.ri-root :is(button, select, [tabindex]):focus-visible { outline: 2px solid #0f68b2 !important; outline-offset: 2px; }
.ri-hatch { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.38) 0 2px, transparent 2px 6px); }
.ri-scroll::-webkit-scrollbar { height: 8px; width: 8px; }
.ri-scroll::-webkit-scrollbar-thumb { background: #d5cfc9; border-radius: 8px; }
html.reduce-motion .ri-skel, html.reduce-motion .ri-in, html.reduce-motion .ri-live, html.reduce-motion .ri-progress::after { animation: none; }
html.reduce-motion .ri-grow { transition: none; }
`;

/* ============================== helpers ============================== */

function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pct = (r, digits = 1) => `${(r * 100).toFixed(digits)}%`;

function compact(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US');
}

function easternStamp(ts) {
  return `${new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })} ET`;
}

function timeAgo(ts, now) {
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : easternStamp(ts);
}

async function fetchJson(url, signal) {
  const res = await apiFetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json();
}

function buildParams(source, picks, extra = {}) {
  const p = new URLSearchParams();
  if (source.table) p.set('chunks_table', source.table);
  source.codes.forEach(c => p.append('codes', c));
  p.set('match_inside', String(source.matchInside));
  p.set('latest_only', String(source.latestOnly));
  Object.entries(picks).forEach(([k, vals]) => vals.forEach(v => p.append(k, v)));
  Object.entries(extra).forEach(([k, v]) => { if (v !== undefined && v !== '') p.set(k, String(v)); });
  return p;
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// Counts up to the new value instead of jumping, so a refresh reads as live.
function useCountUp(target, duration = 700) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return undefined;
    if (reduce) { from.current = target; setShown(target); return undefined; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - (1 - k) ** 3;
      const v = a + (target - a) * eased;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = target; };
  }, [target, duration, reduce]);
  return shown;
}

function useOutside(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [ref, open, onClose]);
}

function useTip() {
  const [tip, setTip] = useState(null);
  const show = useCallback((e, title, lines) => setTip({ x: e.clientX, y: e.clientY, title, lines }), []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div
      role="tooltip"
      className="fixed z-[70] pointer-events-none rounded-xl bg-jj-gray-08 text-white shadow-popover px-3.5 py-2.5 min-w-[180px]"
      style={{
        left: Math.min(tip.x + 16, window.innerWidth - 230),
        top: tip.y + 16 + 110 > window.innerHeight ? tip.y - 110 : tip.y + 16,
      }}
    >
      <div className="text-[11.5px] font-johnson-text font-bold mb-1.5 max-w-[260px] truncate">{tip.title}</div>
      {tip.lines.map(l => (
        <div key={l.label} className="flex items-center gap-2 text-[11px] font-johnson-text leading-[1.7]">
          {l.color && <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: l.color }} />}
          <span className="text-white/65">{l.label}</span>
          <span className="ml-auto pl-5 tabular-nums">{l.value}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

/* ============================== primitives ============================== */

const Card = ({ className = '', children, ...rest }) => (
  <section className={`bg-white border border-jj-gray-02 rounded-2xl shadow-[0_1px_2px_rgba(49,44,42,.04),0_8px_24px_-18px_rgba(49,44,42,.25)] ${className}`} {...rest}>
    {children}
  </section>
);

const CardHead = ({ title, hint, right }) => (
  <div className="flex items-start justify-between gap-3 mb-4">
    <div className="min-w-0">
      <h3 className="font-johnson-display font-bold text-[15px] leading-tight text-jj-gray-08">{title}</h3>
      {hint && <p className="mt-1 text-[11.5px] font-johnson-text text-jj-gray-07">{hint}</p>}
    </div>
    {right}
  </div>
);

const Skeleton = ({ className = '' }) => <div className={`ri-skel rounded-lg ${className}`} />;

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11px] font-johnson-text text-jj-gray-07">
      {[[INGESTED, GREEN], [NOT_INGESTED, RED]].map(([l, c]) => (
        <span key={l} className="inline-flex items-center gap-1.5"><span className={`w-3 h-3 rounded-[3px] ${l === NOT_INGESTED ? 'ri-hatch' : ''}`} style={{ backgroundColor: c }} />{l}</span>
      ))}
    </div>
  );
}

function StatusPill({ value }) {
  const on = value === INGESTED;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-johnson-text font-medium whitespace-nowrap ${on ? 'bg-[#328714]/10 text-jj-green-05' : 'bg-jj-red/10 text-jj-maroon-05'}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: on ? GREEN : RED }} />
      {value}
    </span>
  );
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={hint}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 h-9 pl-1.5 pr-3 rounded-full border border-jj-gray-02 bg-white hover:border-jj-gray-03 text-[12.5px] font-johnson-text text-jj-gray-08 whitespace-nowrap transition-colors"
    >
      <span className={`relative w-[30px] h-[18px] rounded-full transition-colors ${checked ? 'bg-jj-gray-08' : 'bg-jj-gray-03'}`}>
        <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[12px]' : ''}`} />
      </span>
      {label}
    </button>
  );
}

const iconBtn = 'inline-flex items-center justify-center gap-2 h-9 px-3.5 rounded-full border text-[12.5px] font-johnson-text whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

// Multi-select popover with search, counts and Only / Clear.
function PickMenu({ label, options, selected, onChange, loading, wide = false, emptyText = 'No values', allLabel = 'All' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const listId = useId();
  const close = useCallback(() => { setOpen(false); setQ(''); }, []);
  useOutside(ref, open, close);
  const sel = new Set(selected);
  const term = q.trim().toLowerCase();
  const matches = term ? options.filter(o => String(o.value).toLowerCase().includes(term)) : options;
  const shown = matches.slice(0, 300);
  const toggle = (v) => onChange(sel.has(v) ? selected.filter(x => x !== v) : [...selected, v]);
  const summary = selected.length === 0 ? allLabel : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className={`${iconBtn} w-full justify-between ${selected.length ? 'bg-jj-gray-08 text-white border-jj-gray-08' : 'bg-white text-jj-gray-08 border-jj-gray-02 hover:border-jj-gray-03'}`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={selected.length ? 'text-white/70' : 'text-jj-gray-07'}>{label}</span>
          <span className="font-medium truncate max-w-[150px]">{summary}</span>
        </span>
        <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={listId}
          className={`absolute z-[60] mt-2 left-0 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:mt-0 max-sm:w-auto ${wide ? 'sm:w-[360px]' : 'sm:w-[300px]'} bg-white border border-jj-gray-02 rounded-2xl shadow-popover animate-menu-in overflow-hidden`}
        >
          <div className="p-2.5 border-b border-jj-gray-01">
            <label className="flex items-center gap-2 h-9 px-3 rounded-xl bg-jj-gray-01 focus-within:ring-2 focus-within:ring-jj-blue-03/30">
              <Search size={14} className="text-jj-gray-07 flex-shrink-0" aria-hidden="true" />
              <input
                autoFocus
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}`}
                className="w-full bg-transparent text-[12.5px] font-johnson-text text-jj-gray-08 placeholder:text-jj-gray-06 focus:outline-none"
              />
            </label>
          </div>
          <div className="max-h-[300px] overflow-y-auto ri-scroll py-1.5">
            {loading && <div className="px-4 py-3 text-xs font-johnson-text text-jj-gray-07">Loading…</div>}
            {!loading && shown.length === 0 && <div className="px-4 py-3 text-xs font-johnson-text text-jj-gray-07">{term ? 'No matches' : emptyText}</div>}
            {!loading && shown.map(o => {
              const on = sel.has(o.value);
              return (
                <div key={o.value} className="group flex items-center gap-2 px-2 mx-1.5 rounded-lg hover:bg-jj-gray-01">
                  <button type="button" onClick={() => toggle(o.value)} className="flex-1 min-w-0 flex items-center gap-2.5 py-2 text-left" aria-pressed={on}>
                    <span className={`w-4 h-4 rounded-[5px] border flex items-center justify-center flex-shrink-0 transition-colors ${on ? 'bg-jj-gray-08 border-jj-gray-08' : 'border-jj-gray-04 bg-white'}`}>
                      {on && <Check size={11} strokeWidth={3} className="text-white" aria-hidden="true" />}
                    </span>
                    <span className={`truncate text-[12.5px] font-johnson-text ${on ? 'font-bold text-jj-gray-08' : 'text-jj-gray-08'}`}>{o.value}</span>
                  </button>
                  <button type="button" onClick={() => onChange([o.value])} className="opacity-0 group-hover:opacity-100 focus:opacity-100 min-h-[24px] min-w-[36px] rounded-md text-[11px] font-johnson-text text-jj-blue-03 hover:bg-white">Only</button>
                  {o.count != null && <span className="text-[11px] font-johnson-text text-jj-gray-07 tabular-nums">{compact(o.count)}</span>}
                </div>
              );
            })}
            {matches.length > shown.length && (
              <div className="px-4 py-2 text-[11px] font-johnson-text text-jj-gray-07">{(matches.length - shown.length).toLocaleString()} more. Refine the search to see them.</div>
            )}
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5 border-t border-jj-gray-01 bg-jj-gray-01/50">
            <span className="text-[11px] font-johnson-text text-jj-gray-07 tabular-nums">{selected.length} of {options.length.toLocaleString()} selected</span>
            <button type="button" onClick={() => onChange([])} disabled={!selected.length} className="text-[11.5px] font-johnson-text text-jj-blue-03 disabled:text-jj-gray-06">Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================== charts ============================== */

function Gauge({ rate, size = 168 }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const shown = useCountUp(rate);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 168 168" className="w-full h-full -rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="ri-gauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#53ce76" />
            <stop offset="100%" stopColor="#328714" />
          </linearGradient>
        </defs>
        <circle cx="84" cy="84" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="14" />
        <circle cx="84" cy="84" r={r} fill="none" stroke="rgba(235,23,0,.55)" strokeWidth="14" strokeDasharray="3 3" />
        <circle
          className="ri-grow"
          cx="84" cy="84" r={r} fill="none" stroke="url(#ri-gauge)" strokeWidth="14" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, rate)))}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-johnson-display font-bold text-white text-[34px] leading-none tabular-nums">{pct(shown, 1)}</span>
        <span className="mt-1.5 text-[11px] font-johnson-text uppercase tracking-[.2em] text-white/65">ingested</span>
      </div>
    </div>
  );
}

function StackedBars({ rows, onPick, pickHint }) {
  const tip = useTip();
  const max = Math.max(1, ...rows.map(r => r.documents ?? r.ingested + r.not_ingested));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map(r => {
        const total = r.documents ?? r.ingested + r.not_ingested;
        const lines = [
          { label: INGESTED, value: fmt(r.ingested), color: GREEN },
          { label: NOT_INGESTED, value: fmt(r.not_ingested), color: RED },
          { label: 'Rate', value: pct(total ? r.ingested / total : 0) },
        ];
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="truncate text-[12px] font-johnson-text text-jj-gray-08">{r.value}</span>
              <span className="flex-shrink-0 text-[11.5px] font-johnson-text tabular-nums text-jj-gray-07">
                <span className="text-jj-gray-08 font-medium">{fmt(total)}</span>
                <span className="text-jj-gray-07"> · {pct(total ? r.ingested / total : 0, 0)}</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-jj-gray-01 overflow-hidden">
              <div className="ri-grow h-full flex rounded-full overflow-hidden" style={{ width: `${(total / max) * 100}%` }}>
                <span className="h-full" style={{ width: `${total ? (r.ingested / total) * 100 : 0}%`, background: GREEN }} />
                <span className="h-full flex-1 ri-hatch" style={{ backgroundColor: RED }} />
              </div>
            </div>
          </>
        );
        return (
          <li key={r.value} onMouseMove={e => tip.show(e, r.value, lines)} onMouseLeave={tip.hide}>
            {onPick ? (
              <button type="button" onClick={() => onPick(r.value)} title={pickHint} className="w-full text-left rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-jj-gray-01/70">
                {body}
              </button>
            ) : <div className="px-0 py-0.5">{body}</div>}
          </li>
        );
      })}
      {tip.node}
    </ul>
  );
}

function YearColumns({ rows, height = 220 }) {
  const tip = useTip();
  const max = Math.max(1, ...rows.map(r => r.ingested + r.not_ingested));
  return (
    <div className="overflow-x-auto ri-scroll -mx-1 px-1 pb-1">
      <div className="flex items-end gap-[6px]" style={{ height: height + 40, minWidth: rows.length * 34 }}>
        {rows.map(r => {
          const total = r.ingested + r.not_ingested;
          return (
            <div
              key={r.year}
              className="flex-1 min-w-[28px] h-full flex flex-col justify-end items-center gap-1.5 group"
              onMouseMove={e => tip.show(e, String(r.year), [
                { label: INGESTED, value: fmt(r.ingested), color: GREEN },
                { label: NOT_INGESTED, value: fmt(r.not_ingested), color: RED },
                { label: 'Rate', value: pct(total ? r.ingested / total : 0) },
              ])}
              onMouseLeave={tip.hide}
            >
              <span className="text-[11px] font-johnson-text text-jj-gray-07 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">{compact(total)}</span>
              <div className="ri-grow w-full max-w-[44px] flex flex-col justify-end rounded-t-md overflow-hidden group-hover:brightness-110" style={{ height: (total / max) * height }}>
                <span className="ri-hatch" style={{ height: `${total ? (r.not_ingested / total) * 100 : 0}%`, backgroundColor: RED }} />
                <span className="flex-1" style={{ background: GREEN }} />
              </div>
              <span className="text-[11px] font-johnson-text text-jj-gray-07 tabular-nums">{rows.length > 14 ? `'${String(r.year).slice(2)}` : r.year}</span>
            </div>
          );
        })}
      </div>
      {tip.node}
    </div>
  );
}

/* ============================== states ============================== */

function ErrorCard({ message, onRetry }) {
  return (
    <Card className="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-4 ri-in">
      <span className="w-11 h-11 rounded-2xl bg-jj-red/10 text-jj-red flex items-center justify-center flex-shrink-0"><Activity size={20} aria-hidden="true" /></span>
      <div className="flex-1 min-w-0">
        <div className="font-johnson-display font-bold text-[15px] text-jj-gray-08">Couldn&apos;t load ingestion data</div>
        <div className="mt-1 text-[12.5px] font-johnson-text text-jj-gray-07 break-words">{message}</div>
      </div>
      <button type="button" onClick={onRetry} className={`${iconBtn} bg-jj-gray-08 text-white border-jj-gray-08 hover:bg-black`}>
        <RefreshCw size={14} aria-hidden="true" /> Try again
      </button>
    </Card>
  );
}

function EmptyCard({ title, body, action }) {
  return (
    <Card className="px-6 py-14 flex flex-col items-center text-center ri-in">
      <span className="w-12 h-12 rounded-2xl bg-jj-gray-01 text-jj-gray-07 flex items-center justify-center"><FileSearch size={22} aria-hidden="true" /></span>
      <div className="mt-4 font-johnson-display font-bold text-[16px] text-jj-gray-08">{title}</div>
      <div className="mt-1.5 max-w-[420px] text-[12.5px] font-johnson-text text-jj-gray-07">{body}</div>
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

/* ============================== overview ============================== */

function Kpi({ label, value, sub, accent, format = fmt }) {
  const shown = useCountUp(value);
  return (
    <div className="min-w-0 rounded-2xl bg-white/[.06] border border-white/10 px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-johnson-text uppercase tracking-[.14em] text-white/65">
        {accent && <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />}
        {label}
      </div>
      <div className="mt-2 font-johnson-display font-bold text-white text-[24px] sm:text-[28px] leading-none tabular-nums truncate">{format(Math.round(shown))}</div>
      {sub && <div className="mt-1.5 text-[11px] font-johnson-text text-white/65 truncate">{sub}</div>}
    </div>
  );
}

function Hero({ dash }) {
  const k = dash.kpis;
  return (
    <section className="relative overflow-hidden rounded-[22px] bg-jj-gray-08 text-white ri-in">
      {/* static grid + glow: no blur filters, cheap on CPU-rendered Cloud PCs */}
      <svg className="absolute inset-0 w-full h-full opacity-[.07] pointer-events-none" aria-hidden="true">
        <defs><pattern id="ri-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#fff" strokeWidth="1" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#ri-grid)" />
      </svg>
      <div className="absolute -top-24 -right-16 w-[340px] h-[340px] rounded-full pointer-events-none" style={{ background: 'radial-gradient(closest-side, rgba(235,23,0,.35), transparent)' }} aria-hidden="true" />
      <div className="absolute -bottom-28 left-1/3 w-[320px] h-[320px] rounded-full pointer-events-none" style={{ background: 'radial-gradient(closest-side, rgba(83,206,118,.18), transparent)' }} aria-hidden="true" />
      <div className="relative p-5 sm:p-6 lg:p-7 flex flex-col lg:flex-row lg:items-center gap-6">
        <div className="flex items-center gap-5 sm:gap-6 min-w-0">
          <Gauge rate={k.rate} />
          <div className="min-w-0">
            <div className="text-[11px] font-johnson-text uppercase tracking-[.22em] text-white/65">Ingestion coverage</div>
            <div className="mt-2 font-johnson-display font-bold text-[20px] sm:text-[24px] leading-tight">
              {fmt(k.ingested)} <span className="text-white/65 font-normal">of</span> {fmt(k.documents)}
            </div>
            <div className="mt-1 text-[12.5px] font-johnson-text text-white/70">documents have chunks in this table</div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-johnson-text text-white/65">
              <span className="inline-flex items-center gap-1.5"><Database size={12} aria-hidden="true" />{dash.source.chunks_table}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 sm:gap-3 flex-1 min-w-0 lg:ml-auto lg:max-w-[760px]">
          <Kpi label="Documents" value={k.documents} sub={dash.scope_documents !== k.documents ? `of ${fmt(dash.scope_documents)} in source` : 'unique object IDs'} />
          <Kpi label="Ingested" value={k.ingested} accent={GREEN} sub={pct(k.rate)} />
          <Kpi label="Not ingested" value={k.not_ingested} accent={RED} sub={pct(k.documents ? 1 - k.rate : 0)} />
          <Kpi label="Chunks" value={k.chunks} sub={k.ingested ? `${fmt(Math.round(k.chunks / k.ingested))} per document` : 'none yet'} format={compact} />
        </div>
      </div>
    </section>
  );
}

function Overview({ dash, loading, onPickProduct }) {
  if (!dash) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[220px] rounded-[22px]" />
        <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-[360px] rounded-2xl" /><Skeleton className="h-[360px] rounded-2xl" /></div>
      </div>
    );
  }
  const products = dash.by_product;
  const years = dash.by_year;
  return (
    <div className={`flex flex-col gap-4 transition-opacity ${loading ? 'opacity-70' : ''}`}>
      <p role="status" aria-atomic="true" className="sr-only">
        {`${fmt(dash.kpis.ingested)} of ${fmt(dash.kpis.documents)} documents ingested, ${pct(dash.kpis.rate)}`}
      </p>
      <Hero dash={dash} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Card className="p-5 sm:p-6 min-w-0 ri-in">
          <CardHead
            title="By product"
            hint={products.distinct > products.rows.length ? `Top ${products.rows.length} of ${fmt(products.distinct)} products by document count` : `${fmt(products.distinct)} products`}
            right={<Legend />}
          />
          {products.rows.length ? (
            <div className="max-h-[520px] overflow-y-auto ri-scroll pr-1">
              <StackedBars rows={products.rows} onPick={onPickProduct} pickHint="Narrow the source to this product" />
            </div>
          ) : <div className="py-10 text-center text-xs font-johnson-text text-jj-gray-07">No products in this selection.</div>}
        </Card>
        <Card className="p-5 sm:p-6 min-w-0 ri-in">
          <CardHead
            title="By approval year"
            hint={years.undated ? `${fmt(years.undated)} documents have no approval date and aren't shown` : 'Every document has an approval date'}
            right={<Legend />}
          />
          {years.rows.length ? <YearColumns rows={years.rows} /> : <div className="py-10 text-center text-xs font-johnson-text text-jj-gray-07">No approval dates in this selection.</div>}
        </Card>
      </div>
    </div>
  );
}

/* ============================== breakdown ============================== */

function Breakdown({ by, setBy, data, loading, error, onRetry }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ col: 'documents', dir: 'desc' });
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.rows || []).filter(r => !term || String(r.value).toLowerCase().includes(term));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = a[sort.col]; const y = b[sort.col];
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
  }, [data, q, sort]);
  const label = BREAKDOWNS.find(b => b.id === by)?.label || by;
  const headers = [
    { col: 'value', label, align: 'left' },
    { col: 'documents', label: 'Documents' },
    { col: 'ingested', label: INGESTED },
    { col: 'not_ingested', label: NOT_INGESTED },
    { col: 'ingested_pct', label: 'Rate' },
    { col: 'chunks', label: 'Chunks' },
  ];
  const sortBy = (col) => setSort(s => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'value' ? 'asc' : 'desc' }));

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto ri-scroll -mx-1 px-1">
        <div role="tablist" aria-label="Break down by" className="inline-flex gap-1 p-1 rounded-full bg-white border border-jj-gray-02">
          {BREAKDOWNS.map(b => (
            <button
              key={b.id}
              role="tab"
              aria-selected={by === b.id}
              type="button"
              onClick={() => setBy(b.id)}
              className={`h-8 px-3.5 rounded-full text-[12.5px] font-johnson-text whitespace-nowrap transition-colors ${by === b.id ? 'bg-jj-gray-08 text-white font-medium' : 'text-jj-gray-07 hover:text-jj-gray-08 hover:bg-jj-gray-01'}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorCard message={error} onRetry={onRetry} /> : !data ? (
        <div className="grid gap-4 xl:grid-cols-2"><Skeleton className="h-[420px] rounded-2xl" /><Skeleton className="h-[420px] rounded-2xl" /></div>
      ) : (
        <div className={`grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] transition-opacity ${loading ? 'opacity-70' : ''}`}>
          <Card className="p-5 sm:p-6 min-w-0 ri-in">
            <CardHead
              title={`By ${label.toLowerCase()}`}
              hint={data.distinct > data.top_n ? `Top ${data.top_n} of ${fmt(data.distinct)} values. The table has all of them.` : `${fmt(data.distinct)} values`}
              right={<Legend />}
            />
            {data.rows.length ? (
              <div className="max-h-[560px] overflow-y-auto ri-scroll pr-1"><StackedBars rows={data.rows.slice(0, data.top_n)} /></div>
            ) : <div className="py-10 text-center text-xs font-johnson-text text-jj-gray-07">Nothing to break down.</div>}
          </Card>
          <Card className="min-w-0 flex flex-col overflow-hidden ri-in">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 pt-5 pb-4">
              <div>
                <h3 className="font-johnson-display font-bold text-[15px] text-jj-gray-08">All values</h3>
                <p className="mt-1 text-[11.5px] font-johnson-text text-jj-gray-07 tabular-nums">{fmt(rows.length)} of {fmt(data.rows.length)} shown</p>
              </div>
              <label className="flex items-center gap-2 h-9 px-3 rounded-full border border-jj-gray-02 bg-white w-full sm:w-[240px] focus-within:ring-2 focus-within:ring-jj-blue-03/30">
                <Search size={14} className="text-jj-gray-07" aria-hidden="true" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Filter ${label.toLowerCase()}`} aria-label={`Filter ${label}`} className="w-full bg-transparent text-[12.5px] font-johnson-text focus:outline-none" />
              </label>
            </div>
            <div className="overflow-auto ri-scroll max-h-[560px] border-t border-jj-gray-01">
              <table className="w-full min-w-[620px] text-[12.5px] font-johnson-text">
                <thead className="sticky top-0 z-[1] bg-jj-gray-01/95">
                  <tr>
                    {headers.map(h => (
                      <th key={h.col} scope="col" aria-sort={sort.col === h.col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-4 py-2.5 font-bold text-[11px] uppercase tracking-[.12em] text-jj-gray-07 whitespace-nowrap ${h.align === 'left' ? 'text-left' : 'text-right'}`}>
                        <button type="button" onClick={() => sortBy(h.col)} className="inline-flex items-center gap-1 hover:text-jj-gray-08">
                          {h.label}{sort.col === h.col && <Arrow dir={sort.dir} />}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.value} className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50">
                      <td className="px-4 py-2.5 text-jj-gray-08 font-medium max-w-[280px] truncate" title={r.value}>{r.value}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-jj-gray-08">{fmt(r.documents)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-jj-green-05">{fmt(r.ingested)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-jj-maroon-05">{fmt(r.not_ingested)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-2.5">
                          <div className="w-[72px] h-1.5 rounded-full bg-jj-gray-02 overflow-hidden hidden sm:block">
                            <div className="h-full rounded-full ri-grow" style={{ width: `${r.ingested_pct}%`, background: GREEN }} />
                          </div>
                          <span className="tabular-nums text-jj-gray-08 w-[48px] text-right">{r.ingested_pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-jj-gray-07">{fmt(r.chunks)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={headers.length} className="px-4 py-10 text-center text-jj-gray-07">No values match that filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================== documents ============================== */

function CopyButton({ text, label }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => setDone(true)).catch(() => {});
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="inline-flex items-center justify-center w-6 h-6 rounded-md text-jj-gray-07 hover:text-jj-gray-08 hover:bg-jj-gray-02 flex-shrink-0"
    >
      {done ? <Check size={12} className="text-jj-green-03" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

function DetailDrawer({ row, onClose }) {
  useEffect(() => {
    if (!row) return undefined;
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [row, onClose]);
  if (!row) return null;
  return (
    <div className="fixed inset-0 z-[80] flex justify-end" role="dialog" aria-modal="true" aria-label="Document detail">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-jj-gray-08/40 cursor-default" />
      <aside className="relative w-full sm:w-[460px] h-full bg-white shadow-popover flex flex-col ri-in">
        <header className="flex items-start gap-3 px-5 sm:px-6 py-5 border-b border-jj-gray-02">
          <div className="min-w-0 flex-1">
            <StatusPill value={row.ingestion_status} />
            <h3 className="mt-2.5 font-johnson-display font-bold text-[17px] leading-snug text-jj-gray-08 break-words">{row.object_name || row.r_object_id}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-full flex items-center justify-center text-jj-gray-07 hover:bg-jj-gray-01"><X size={18} aria-hidden="true" /></button>
        </header>
        <dl className="flex-1 overflow-y-auto ri-scroll px-5 sm:px-6 py-2">
          {Object.entries(DETAIL_LABELS).map(([k, label]) => {
            const v = row[k];
            const empty = v == null || v === '';
            return (
              <div key={k} className="flex gap-4 py-3 border-b border-jj-gray-01 last:border-0">
                <dt className="w-[38%] flex-shrink-0 text-[11.5px] font-johnson-text text-jj-gray-07">{label}</dt>
                <dd className="flex-1 min-w-0 flex items-start gap-1.5 text-[12.5px] font-johnson-text text-jj-gray-08 break-words">
                  <span className="min-w-0 flex-1">{empty ? <span className="text-jj-gray-06">—</span> : k === 'chunk_count' ? fmt(v) : k === 'ingestion_status' ? v : String(v)}</span>
                  {!empty && (k === 'r_object_id' || k === 'edms_number') && <CopyButton text={String(v)} label={label} />}
                </dd>
              </div>
            );
          })}
          <div className="py-4 text-[11.5px] font-johnson-text text-jj-gray-07">
            Matched on file name <code className="px-1.5 py-0.5 rounded bg-jj-gray-01 text-jj-gray-08">{row.r_object_id}.pdf</code>
          </div>
        </dl>
      </aside>
    </div>
  );
}

function Documents({ state, setState, data, loading, error, onRetry, onOpen, canDownload, onDownload, downloading }) {
  const narrow = useMediaQuery('(max-width: 767.98px)');
  const { search, sortCol, sortDir, pageSize } = state;
  const sortBy = (col) => setState(s => ({ ...s, page: 1, sortCol: col, sortDir: s.sortCol === col && s.sortDir === 'asc' ? 'desc' : 'asc' }));
  const total = data?.total ?? 0;
  const totalPages = data?.total_pages ?? 1;
  const go = (p) => setState(s => ({ ...s, page: Math.min(Math.max(1, p), totalPages) }));
  const rows = data?.rows || [];
  const from = total ? (data.page - 1) * data.page_size + 1 : 0;
  const to = total ? from + rows.length - 1 : 0;

  return (
    <Card className="flex flex-col min-h-[520px] overflow-hidden ri-in">
      <div className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-4 border-b border-jj-gray-01">
        <label className="flex items-center gap-2 h-10 px-3.5 rounded-full border border-jj-gray-02 bg-jj-gray-01/60 flex-1 min-w-[220px] focus-within:bg-white focus-within:ring-2 focus-within:ring-jj-blue-03/30 transition-colors">
          <Search size={15} className="text-jj-gray-07 flex-shrink-0" aria-hidden="true" />
          <input
            value={search}
            onChange={e => setState(s => ({ ...s, search: e.target.value, page: 1 }))}
            placeholder="Search object ID, EDMS number or document name"
            aria-label="Search documents"
            className="w-full bg-transparent text-[13px] font-johnson-text text-jj-gray-08 placeholder:text-jj-gray-06 focus:outline-none"
          />
          {search && (
            <button type="button" onClick={() => setState(s => ({ ...s, search: '', page: 1 }))} aria-label="Clear search" className="text-jj-gray-07 hover:text-jj-gray-08"><X size={14} aria-hidden="true" /></button>
          )}
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[12px] font-johnson-text text-jj-gray-07 tabular-nums whitespace-nowrap">
            {data ? `${fmt(total)} rows` : '…'}
          </span>
          {canDownload && (
            <button type="button" onClick={onDownload} disabled={!total || downloading} className={`${iconBtn} bg-jj-gray-08 text-white border-jj-gray-08 hover:bg-black`} title="Download every matching row as CSV">
              <Download size={14} aria-hidden="true" />{downloading ? 'Preparing…' : 'Download CSV'}
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        {loading && data && <div className="absolute top-0 inset-x-0 h-[2px] overflow-hidden z-[2] ri-progress bg-jj-red/10" />}
        {error ? (
          <div className="p-5"><ErrorCard message={error} onRetry={onRetry} /></div>
        ) : !data ? (
          <div className="p-5 flex flex-col gap-2.5">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : rows.length === 0 ? (
          <div className="p-5"><EmptyCard title="No documents match" body={search ? 'Nothing matches that search. Try part of an object ID, an EDMS number or a word from the document name.' : 'Nothing left after these filters.'} /></div>
        ) : narrow ? (
          <ul className="divide-y divide-jj-gray-01">
            {rows.map(r => (
              <li key={`${r.product_code}|${r.r_object_id}`}>
                <button type="button" onClick={() => onOpen(r)} className="w-full text-left px-4 py-3.5 hover:bg-jj-gray-01/60 focus:outline-none focus-visible:bg-jj-gray-01">
                  <div className="flex items-center justify-between gap-3">
                    <StatusPill value={r.ingestion_status} />
                    <span className="text-[11px] font-johnson-text text-jj-gray-07 tabular-nums">{fmt(r.chunk_count)} chunks</span>
                  </div>
                  <div className="mt-2 text-[13px] font-johnson-text font-medium text-jj-gray-08 line-clamp-2">{r.object_name || '—'}</div>
                  <div className="mt-1 text-[11.5px] font-johnson-text text-jj-gray-07 truncate">{r.product_code} · {r.r_object_id}{r.edms_number ? ` · ${r.edms_number}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className={`overflow-auto ri-scroll max-h-[calc(100vh-340px)] min-h-[360px] transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <table className="text-[12.5px] font-johnson-text border-collapse" style={{ minWidth: '100%', width: 'max-content' }}>
              <thead className="sticky top-0 z-[1]">
                <tr className="bg-jj-gray-01">
                  {COLUMNS.map(c => (
                    <th key={c.key} scope="col" style={{ minWidth: c.width }} aria-sort={sortCol === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-4 py-3 font-bold text-[11px] uppercase tracking-[.12em] text-jj-gray-07 whitespace-nowrap ${c.numeric ? 'text-right' : 'text-left'}`}>
                      <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:text-jj-gray-08">
                        {c.label}{sortCol === c.key && <Arrow dir={sortDir} />}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={`${r.product_code}|${r.r_object_id}`}
                    onClick={() => onOpen(r)}
                    onKeyDown={e => { if (e.key === 'Enter') onOpen(r); }}
                    tabIndex={0}
                    className="group border-t border-jj-gray-01 hover:bg-jj-gray-01/60 cursor-pointer focus:outline-none focus-visible:bg-jj-gray-01"
                  >
                    {COLUMNS.map(c => {
                      const v = r[c.key];
                      return (
                        <td key={c.key} style={{ minWidth: c.width, maxWidth: c.width * 1.8 }} className={`px-4 py-2.5 ${c.numeric ? 'text-right tabular-nums' : ''} ${c.mono ? 'tabular-nums' : ''}`}>
                          {c.key === 'ingestion_status' ? <StatusPill value={v} />
                            : c.key === 'chunk_count' ? <span className={v ? 'text-jj-gray-08' : 'text-jj-gray-06'}>{fmt(v)}</span>
                              : v == null || v === '' ? <span className="text-jj-gray-06">—</span>
                                : (
                                  <span className="flex items-center gap-1 min-w-0">
                                    <span className={`truncate ${c.key === 'object_name' ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-07'}`} title={String(v)}>{v}</span>
                                    {c.key === 'r_object_id' && <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100"><CopyButton text={String(v)} label="object ID" /></span>}
                                  </span>
                                )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-jj-gray-01 bg-jj-gray-01/40">
          <div className="flex items-center gap-2.5 text-[12px] font-johnson-text text-jj-gray-07">
            <span className="tabular-nums">{fmt(from)}–{fmt(to)} of {fmt(total)}</span>
            <select
              value={pageSize}
              onChange={e => setState(s => ({ ...s, pageSize: Number(e.target.value), page: 1 }))}
              aria-label="Rows per page"
              className="h-8 pl-2.5 pr-7 rounded-full border border-jj-gray-02 bg-white text-[12px]"
            >
              {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            {[['«', 1, 'First page'], ['‹', data.page - 1, 'Previous page']].map(([t, p, l]) => (
              <button key={l} type="button" onClick={() => go(p)} disabled={data.page <= 1 || loading} aria-label={l} className="w-8 h-8 rounded-full border border-jj-gray-02 bg-white text-[13px] text-jj-gray-08 disabled:opacity-35 hover:border-jj-gray-03">{t}</button>
            ))}
            <span className="px-3 text-[12px] font-johnson-text text-jj-gray-07 tabular-nums">{fmt(data.page)} / {fmt(totalPages)}</span>
            {[['›', data.page + 1, 'Next page'], ['»', totalPages, 'Last page']].map(([t, p, l]) => (
              <button key={l} type="button" onClick={() => go(p)} disabled={data.page >= totalPages || loading} aria-label={l} className="w-8 h-8 rounded-full border border-jj-gray-02 bg-white text-[13px] text-jj-gray-08 disabled:opacity-35 hover:border-jj-gray-03">{t}</button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ============================== explorer ============================== */

const EMPTY_PICKS = { status: [], approval: [], object_type: [], domain: [] };

export default function RimIngestionExplorer({ logInPage, activeTab, onBusyChange, onSynced }) {
  const canDownload = useRBAC().hasPermission('downloadUnstructuredData');
  const now = useNow();

  /* ---------- source (what the server matches) ---------- */
  const [sources, setSources] = useState(null);
  const [sourcesError, setSourcesError] = useState(null);
  const [source, setSource] = useState({ table: null, codes: [], matchInside: true, latestOnly: false });
  const [picks, setPicks] = useState(EMPTY_PICKS);
  const [live, setLive] = useState(false);

  const loadSources = useCallback((signal) => {
    setSourcesError(null);
    fetchJson(`${API}/sources`, signal)
      .then(s => {
        setSources(s);
        setSource(prev => (prev.table ? prev : { ...prev, table: s.default_chunks_table }));
      })
      .catch(e => { if (e.name !== 'AbortError') setSourcesError(e.message); });
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    loadSources(ctl.signal);
    return () => ctl.abort();
  }, [loadSources]);

  const sourceKey = JSON.stringify(source);
  const ready = Boolean(source.table);

  /* ---------- dashboard ---------- */
  const [dash, setDash] = useState(null);
  const [dashFor, setDashFor] = useState(null);
  const dashForRef = useRef(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const forceRefresh = useRef(false);

  useEffect(() => {
    if (!ready) return undefined;
    const ctl = new AbortController();
    const refresh = forceRefresh.current;
    forceRefresh.current = false;
    setDashLoading(true);
    setDashError(null);
    const key = JSON.stringify(source);
    // a new source drops the old numbers so they're never shown as the new ones
    if (dashForRef.current !== key) setDash(null);
    fetchJson(`${API}/dashboard?${buildParams(source, picks, refresh ? { refresh: true } : {})}`, ctl.signal)
      .then(d => { dashForRef.current = key; setDash(d); setDashFor(key); setDashLoading(false); onSynced?.(d.loaded_at); })
      .catch(e => { if (e.name !== 'AbortError') { setDashError(e.message); setDashLoading(false); } });
    return () => ctl.abort();
  }, [ready, source, picks, refreshNonce, onSynced]);

  const refresh = useCallback(() => {
    logInPage?.('ingestion_refresh', 'Refreshed RIMDocs Ingestion data');
    forceRefresh.current = true;
    setRefreshNonce(n => n + 1);
  }, [logInPage]);

  // Live: re-match every few minutes while the tab is visible.
  useEffect(() => {
    if (!live) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') { forceRefresh.current = true; setRefreshNonce(n => n + 1); } };
    const t = setInterval(tick, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [live]);

  const dataReady = dash && dashFor === sourceKey;
  const loadedAt = dataReady ? dash.loaded_at : null;

  /* ---------- breakdown ---------- */
  const [by, setBy] = useState('product_code');
  const [bd, setBd] = useState(null);
  const [bdLoading, setBdLoading] = useState(false);
  const [bdError, setBdError] = useState(null);
  const [bdNonce, setBdNonce] = useState(0);
  useEffect(() => {
    if (activeTab !== 'breakdown' || !loadedAt) return undefined;
    const ctl = new AbortController();
    setBdLoading(true);
    setBdError(null);
    setBd(prev => (prev && prev.by === by ? prev : null));
    fetchJson(`${API}/breakdown?${buildParams(source, picks, { by })}`, ctl.signal)
      .then(d => { setBd(d); setBdLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setBdError(e.message); setBdLoading(false); } });
    return () => ctl.abort();
  }, [activeTab, loadedAt, source, picks, by, bdNonce]);

  /* ---------- documents ---------- */
  const [docState, setDocState] = useState({ search: '', sortCol: 'product_code', sortDir: 'asc', page: 1, pageSize: 50 });
  const search = useDebounced(docState.search);
  const [docs, setDocs] = useState(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState(null);
  const [docsNonce, setDocsNonce] = useState(0);
  const [detail, setDetail] = useState(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (activeTab !== 'documents' || !loadedAt) return undefined;
    const ctl = new AbortController();
    setDocsLoading(true);
    setDocsError(null);
    const q = buildParams(source, picks, { search, sort_col: docState.sortCol, sort_dir: docState.sortDir, page: docState.page, page_size: docState.pageSize });
    fetchJson(`${API}/rows?${q}`, ctl.signal)
      .then(d => { setDocs(d); setDocsLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setDocsError(e.message); setDocsLoading(false); } });
    return () => ctl.abort();
  }, [activeTab, loadedAt, source, picks, search, docState.sortCol, docState.sortDir, docState.page, docState.pageSize, docsNonce]);

  useEffect(() => {
    if (search) logInPage?.('ingestion_search', `Searched RIMDocs Ingestion documents for "${search}"`);
  }, [search, logInPage]);

  const openDetail = useCallback((r) => {
    logInPage?.('row_detail_view', `Opened RIMDocs Ingestion detail for ${r.r_object_id}`);
    setDetail(r);
  }, [logInPage]);
  const closeDetail = useCallback(() => setDetail(null), []);

  const download = async () => {
    setDownloading(true);
    logInPage?.('export_all', `Downloaded ${docs?.total ?? 0} RIMDocs Ingestion rows`);
    try {
      const q = buildParams(source, picks, { search, sort_col: docState.sortCol, sort_dir: docState.sortDir });
      await downloadFile(`/api/rim-ingestion/rows/download?${q}`, 'rimdocs_ingestion.csv');
    } catch (e) {
      setDocsError(e.message || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  /* ---------- busy pill in the page header ---------- */
  const busy = !sources || dashLoading || bdLoading || docsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  /* ---------- filter changes ---------- */
  const setSourceField = (field, value, note) => {
    logInPage?.('ingestion_source', note);
    setDocState(s => ({ ...s, page: 1 }));
    setSource(s => ({ ...s, [field]: value }));
  };
  const setPick = (id, vals) => {
    const label = PICKS.find(p => p.id === id)?.label;
    logInPage?.('filter_change', `RIMDocs Ingestion ${label}: ${vals.length ? vals.join(', ') : 'all'}`);
    setDocState(s => ({ ...s, page: 1 }));
    setPicks(p => ({ ...p, [id]: vals }));
  };
  const pickProduct = (code) => {
    if (source.codes.includes(code)) return;
    setSourceField('codes', [...source.codes, code], `Narrowed RIMDocs Ingestion to product ${code}`);
  };
  const activePicks = PICKS.flatMap(p => picks[p.id].map(v => ({ id: p.id, label: p.label, value: v })));
  const clearAll = () => {
    logInPage?.('filter_clear', 'Cleared RIMDocs Ingestion filters');
    setDocState(s => ({ ...s, page: 1 }));
    setPicks(EMPTY_PICKS);
    setSource(s => ({ ...s, codes: [], latestOnly: false, matchInside: true }));
  };
  const anyFilter = activePicks.length > 0 || source.codes.length > 0 || source.latestOnly || !source.matchInside;

  const codeOptions = useMemo(() => (sources?.product_codes || []).map(v => ({ value: v })), [sources]);
  const options = dataReady ? dash.options : null;
  const viewEmpty = dataReady && dash.kpis.documents === 0;
  const sourceEmpty = dataReady && dash.scope_documents === 0;

  /* ---------- render ---------- */
  if (sourcesError && !sources) {
    return (
      <div className="ri-root flex-1 min-h-0 overflow-y-auto bg-jj-gray-01 p-4 sm:p-6">
        <style>{STYLES}</style>
        <ErrorCard message={sourcesError} onRetry={() => loadSources()} />
      </div>
    );
  }

  return (
    <div className="ri-root flex-1 min-h-0 overflow-y-auto ri-scroll bg-jj-gray-01">
      <style>{STYLES}</style>

      {/* ── Command bar: source + page filters ── */}
      <div className="relative lg:sticky lg:top-0 z-[40] bg-jj-gray-01/95 border-b border-jj-gray-02">
        {(dashLoading || !sources) && <div className="absolute bottom-0 inset-x-0 h-[2px] overflow-hidden ri-progress" aria-hidden="true" />}
        <div className="px-4 sm:px-6 py-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative inline-flex items-center h-9 rounded-full border border-jj-gray-02 bg-white hover:border-jj-gray-03 focus-within:ring-2 focus-within:ring-jj-blue-03/40 min-w-0 max-w-full">
              <Layers size={14} className="absolute left-3 text-jj-gray-07 pointer-events-none" aria-hidden="true" />
              <span className="sr-only">Chunks table</span>
              <select
                value={source.table || ''}
                disabled={!sources}
                onChange={e => setSourceField('table', e.target.value, `Switched RIMDocs Ingestion chunks table to ${e.target.value}`)}
                className="appearance-none bg-transparent h-full pl-8 pr-8 rounded-full text-[12.5px] font-johnson-text text-jj-gray-08 focus:outline-none max-w-[min(360px,calc(100vw-48px))] truncate"
              >
                {!sources && <option>Loading tables…</option>}
                {(sources?.chunk_tables || []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <ChevronDown size={14} className="absolute right-3 text-jj-gray-07 pointer-events-none" aria-hidden="true" />
            </label>
            <div className="w-[min(280px,100%)]">
              <PickMenu
                label="Products"
                allLabel="All products"
                options={codeOptions}
                selected={source.codes}
                loading={!sources}
                wide
                onChange={v => setSourceField('codes', v, `RIMDocs Ingestion products: ${v.length ? v.join(', ') : 'all'}`)}
              />
            </div>
            <Toggle
              checked={source.matchInside}
              onChange={v => setSourceField('matchInside', v, `RIMDocs Ingestion combined codes ${v ? 'on' : 'off'}`)}
              label="Combined codes"
              hint="Also match rows like 'ACT-064992 + JNJ-67896049-AAA' when you pick JNJ-67896049-AAA"
            />
            <Toggle
              checked={source.latestOnly}
              onChange={v => setSourceField('latestOnly', v, `RIMDocs Ingestion latest versions only ${v ? 'on' : 'off'}`)}
              label="Latest versions"
              hint="Only rows where i_latest_flag = 1"
            />
            <div className="flex items-center gap-2 ml-auto">
              <span
                role="status"
                className="hidden md:inline-flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-07 whitespace-nowrap"
                title={loadedAt ? `Matched ${easternStamp(loadedAt)}` : undefined}
              >
                <span className={`w-2 h-2 rounded-full ${dashLoading ? 'bg-jj-orange-03' : live ? 'bg-jj-green-01 ri-live' : 'bg-jj-green-03'}`} />
                {dashLoading ? 'Matching documents to chunks…' : loadedAt ? `Matched ${timeAgo(loadedAt, now)}` : 'Waiting for data'}
              </span>
              <button
                type="button"
                onClick={() => { logInPage?.('ingestion_live', `RIMDocs Ingestion auto-refresh ${live ? 'off' : 'on'}`); setLive(l => !l); }}
                aria-pressed={live}
                title="Re-match every 5 minutes while this tab is open"
                className={`${iconBtn} ${live ? 'bg-jj-green-03/10 border-jj-green-03/40 text-jj-green-05' : 'bg-white border-jj-gray-02 text-jj-gray-08 hover:border-jj-gray-03'}`}
              >
                <Activity size={14} aria-hidden="true" /> Live
              </button>
              <button type="button" onClick={refresh} disabled={!ready || dashLoading} className={`${iconBtn} bg-jj-gray-08 border-jj-gray-08 text-white hover:bg-black`} title="Match documents to chunks again now">
                <RefreshCw size={14} className={dashLoading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            {PICKS.map(p => (
              <div key={p.id} className="min-w-0 sm:w-[220px]">
                <PickMenu
                  label={p.label}
                  options={options?.[p.id] || []}
                  selected={picks[p.id]}
                  loading={!options}
                  onChange={v => setPick(p.id, v)}
                />
              </div>
            ))}
            {anyFilter && (
              <button type="button" onClick={clearAll} className={`${iconBtn} col-span-2 sm:col-span-1 bg-transparent border-transparent text-jj-blue-03 hover:bg-white`}>
                <FilterX size={14} aria-hidden="true" /> Reset
              </button>
            )}
          </div>

          {activePicks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {activePicks.map(c => (
                <span key={`${c.id}:${c.value}`} className="inline-flex items-center gap-1.5 h-7 pl-3 pr-1.5 rounded-full bg-white border border-jj-gray-02 text-[11.5px] font-johnson-text text-jj-gray-08 ri-in">
                  <span className="text-jj-gray-07">{c.label}:</span>{c.value}
                  <button type="button" onClick={() => setPick(c.id, picks[c.id].filter(v => v !== c.value))} aria-label={`Remove ${c.label} ${c.value}`} className="w-6 h-6 rounded-full flex items-center justify-center text-jj-gray-07 hover:bg-jj-gray-01 hover:text-jj-gray-08">
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="p-4 sm:p-6 max-w-[1680px] mx-auto">
        {dashError && !dataReady ? (
          <ErrorCard message={dashError} onRetry={() => setRefreshNonce(n => n + 1)} />
        ) : sourceEmpty ? (
          <EmptyCard
            title="No documents match this source"
            body="No rows in the documents table match the products and options picked above."
            action={anyFilter && <button type="button" onClick={clearAll} className={`${iconBtn} bg-jj-gray-08 text-white border-jj-gray-08`}><FilterX size={14} aria-hidden="true" /> Reset filters</button>}
          />
        ) : viewEmpty ? (
          <EmptyCard
            title="Nothing left after these filters"
            body="Every document in this source was filtered out. Remove a filter to see them again."
            action={<button type="button" onClick={() => setPicks(EMPTY_PICKS)} className={`${iconBtn} bg-jj-gray-08 text-white border-jj-gray-08`}><FilterX size={14} aria-hidden="true" /> Clear page filters</button>}
          />
        ) : (
          <>
            {dashError && <div className="mb-4 px-4 py-2.5 rounded-xl bg-white border border-jj-red/30 text-[12px] font-johnson-text text-jj-maroon-05">Showing the last good numbers. {dashError}</div>}
            {activeTab === 'overview' && <Overview dash={dataReady ? dash : null} loading={dashLoading} onPickProduct={pickProduct} />}
            {activeTab === 'breakdown' && (
              <Breakdown by={by} setBy={(v) => { logInPage?.('ingestion_breakdown', `RIMDocs Ingestion breakdown by ${v}`); setBy(v); }} data={dataReady ? bd : null} loading={bdLoading} error={bdError} onRetry={() => setBdNonce(n => n + 1)} />
            )}
            {activeTab === 'documents' && (
              <Documents
                state={docState}
                setState={setDocState}
                data={dataReady ? docs : null}
                loading={docsLoading}
                error={docsError}
                onRetry={() => setDocsNonce(n => n + 1)}
                onOpen={openDetail}
                canDownload={canDownload}
                onDownload={download}
                downloading={downloading}
              />
            )}
          </>
        )}
      </div>

      <DetailDrawer row={detail} onClose={closeDetail} />
    </div>
  );
}
