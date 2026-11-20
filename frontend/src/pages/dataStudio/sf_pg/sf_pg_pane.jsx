import React, { createContext, forwardRef, useCallback, useContext, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  AlignLeft, ArrowDown, ArrowUp, CaseSensitive, Keyboard, Ban, Bookmark, ChartColumnBig, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp, CircleCheck, Columns2, Grid3x3, IdCard, Rows2, ScanText, Code2, Columns3, Copy, CopyPlus, Database,
  ArrowRightToLine, Download, ExternalLink, Eye, FileCode2, Filter, History, Info, KeyRound,
  Layers, Link2, Loader2, LogOut, Maximize2, Minimize2, Moon, PanelLeftClose, PanelLeftOpen, Pencil,
  Play, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Square, Sun,
  Table2, Trash2, TriangleAlert, Undo2, UserPlus, Users, WifiOff, X,
} from 'lucide-react';
import TableCopier from './TableCopier';
import { ChartView, PivotView, ProfileView, RecordView } from './resultViews';
import { apiEventSource, apiFetch, downloadFile } from '../../../utils/apiClient';
import { PeerLayer, SharedSession, usePeers } from './collab';
import { useInPageLog } from '../useInPageLog';
import { useRBAC } from '../../../context/RBACContext';
import { useMsal } from '@azure/msal-react';
import { graphToken, searchDirectory } from '../../components/CommunicationParts';
import { useDirectoryPhotos } from '../../../hooks/useDirectoryPhotos';
import {
  caretPixelPos, cellText, clauseAtCaret, DEFAULT_COL_WIDTH, EXPORT_FORMATS, fetchJson,
  FILTER_OPS, formatBytes, formatWhen, leadKeywordHint, MAX_COL_WIDTH, MIN_COL_WIDTH,
  PAGE_SIZE_OPTIONS, parseTableRefs, PG_SUGGESTIONS, rankSuggestions, resolveRef, sqlTokenAtCaret, STATIC_SUGGESTIONS,
  TOKEN_COLORS, tokenizeSql,
} from '../shared/studioHelpers';
import sfIcon from '/icons/snowflake_badge.svg';
import pgIcon from '/icons/postgres_badge.svg';

// One pane, two engines. Postgres has no cross-database queries, so each
// worksheet there picks its database (pickDb) and sends it with the query.
// The engine's colour carries every state (selection, focus, the open picker);
// red stays for Run, primary buttons, errors and anything destructive.
const sigVars = (E) => ({ '--sig': E.accent, '--sig-ink': E.ink, '--sig-soft': E.soft, '--sig-mid': E.mid, '--sig-ring': `${E.accent}55` });

const ENGINES = {
  snowflake: { id: 'snowflake', label: 'Snowflake', api: '/api/snowflake', icon: sfIcon, store: 'snowflake', log: 'sf', configKey: 'snowflake_query_runner', accent: '#29b5e8', ink: '#0b6f94', soft: '#e6f6fc', mid: '#bfe7f7', copier: true, pickDb: false, upperIdents: true, sample: '"MY_DB"."PUBLIC"."MY_TABLE"' },
  postgres: { id: 'postgres', label: 'Postgres', api: '/api/pgstudio', icon: pgIcon, store: 'pgstudio', log: 'pg', configKey: 'postgres_query_runner', accent: '#336791', ink: '#24496b', soft: '#e9eff6', mid: '#c4d5e7', copier: false, pickDb: true, upperIdents: false, sample: '"public"."my_table"' },
};
const EngineCtx = createContext(ENGINES.snowflake);

// Adds the worksheet's login/role query string (conn_id=..&role=..) to a URL.
const withQs = (url, qs) => (qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url);
const useEngine = () => useContext(EngineCtx);

// J&J palette for the Snowflake pane. Neutrals come from the warm J&J grays,
// red is the one brand accent and is kept for primary actions and focus.
// Status colours are functional only (dots, small badges), never big fills.
const T = {
  ink: '#312c2a',
  text: '#4a423e',
  muted: '#6e6259',
  faint: '#766a63',
  line: '#e8e6e3',
  lineStrong: '#d5cfc9',
  panel: '#f1efed',
  panelSoft: '#f8f7f5',
  zebra: '#fbfaf9',
  hover: '#f4f2f0',
  red: '#eb1700',
  redHover: '#c51300',
  redSoft: 'var(--sig-soft)',
  redTint: 'rgba(235,23,0,0.08)',
  maroon: '#9e0000',
  green: '#328714',
  greenSoft: '#eef6ea',
  amber: '#a14a00',
  amberSoft: '#fff3ea',
  blue: '#0f68b2',
};

const fmtMs = (ms) => {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

// One formatter each: toLocaleString builds a new one per call, which adds up across a grid.
const NF = new Intl.NumberFormat();
const NF4 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const fmtN = (n) => (typeof n === 'number' || typeof n === 'bigint' ? NF.format(n) : (n ?? 0).toLocaleString());
const fmtStat = (n) => (Number.isInteger(n) ? NF.format(n) : NF4.format(n));

const plural = (n, word) => `${fmtN(n)} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------- hooks ---------------------------------- */

function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

// Width of an element as it resizes (0 until it's on screen).
function useWidth(el) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

// Ticks while a query runs so the status bar shows live elapsed time.
function useElapsed(running, startedAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);
  if (!running || !startedAt) return null;
  return Math.max(0, now - startedAt);
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  const dismiss = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), []);
  const push = useCallback((message, tone = 'info', ms = 4500) => {
    seq.current += 1;
    const id = seq.current;
    setToasts(ts => [...ts.slice(-3), { id, message, tone }]);
    if (ms) setTimeout(() => dismiss(id), ms);
  }, [dismiss]);
  return { toasts, push, dismiss };
}

// Snowflake errors look like:
//   "001003 (42000): SQL compilation error:\nsyntax error line 2 at position 5 unexpected 'FORM'."
// Pull out the code, state and position so the panel can point at the line.
function parseSfError(raw) {
  const text = String(raw || '').trim();
  const head = /^(\d{6})\s*\((\w{5})\):\s*/.exec(text);
  const body = head ? text.slice(head[0].length) : text;
  let pos = /line\s+(\d+)\s+at\s+position\s+(\d+)/i.exec(body);
  const pg = !pos && /^LINE (\d+): .*\n( *)\^/m.exec(body);
  if (pg) pos = [null, pg[1], Math.max(1, pg[2].length - `LINE ${pg[1]}: `.length + 1)];
  // Multi-statement runs end with "Statement 3 of 5, starting on line 12." and the
  // line above is counted inside that statement.
  const at = /Statement \d+ of \d+, starting on line (\d+)\.\s*$/.exec(body);
  if (pos && at) pos = [null, Number(pos[1]) + Number(at[1]) - 1, pos[2]];
  const firstBreak = body.indexOf('\n');
  let title = firstBreak > 0 ? body.slice(0, firstBreak) : body;
  let detail = firstBreak > 0 ? body.slice(firstBreak + 1).trim() : '';
  if (title.length > 140 && !detail) { detail = title; title = 'Query failed'; }
  return {
    code: head?.[1] || null,
    state: head?.[2] || null,
    title: title.replace(/:$/, '') || 'Query failed',
    detail,
    line: pos ? Number(pos[1]) : null,
    col: pos ? Number(pos[2]) : null,
    raw: text,
  };
}

// Snowflake type as people expect to read it, the way Snowsight shows it.
// Query results come back with connector names (FIXED, TEXT, REAL) and the
// table columns API gives the bare INFORMATION_SCHEMA type plus its length,
// precision and scale, so both get turned into NUMBER(38,0), VARCHAR(100)...
const TIME_TYPES = new Set(['TIME', 'TIMESTAMP', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ', 'DATETIME']);
const ALIASES = {
  FIXED: 'NUMBER', DECIMAL: 'NUMBER', NUMERIC: 'NUMBER', INT: 'NUMBER', INTEGER: 'NUMBER', BIGINT: 'NUMBER',
  SMALLINT: 'NUMBER', TINYINT: 'NUMBER', BYTEINT: 'NUMBER',
  REAL: 'FLOAT', DOUBLE: 'FLOAT', 'DOUBLE PRECISION': 'FLOAT', FLOAT4: 'FLOAT', FLOAT8: 'FLOAT',
  TEXT: 'VARCHAR', STRING: 'VARCHAR', CHARACTER: 'CHAR', VARBINARY: 'BINARY', DATETIME: 'TIMESTAMP_NTZ',
};

// Postgres spells some types out in full; show the names people write.
const PG_SHORT = [[/^character varying/i, 'varchar'], [/^timestamp without time zone/i, 'timestamp'], [/^timestamp with time zone/i, 'timestamptz'],
  [/^time without time zone/i, 'time'], [/^double precision/i, 'float8'], [/^character\b/i, 'char']];
const shortType = (t) => PG_SHORT.reduce((x, [re, to]) => x.replace(re, to), t);

// Snowflake's defaults for "no limit" (VARCHAR 16 MB, BINARY 8 MB, and the 128 MB ceiling).
const MAX_LEN = new Set([16777216, 8388608, 134217728, 67108864]);

function displayType(col) {
  if (!col) return '';
  if (typeof col === 'string') col = { type: col };
  if (col.display_type) return shortType(col.display_type).replace(/^(VARCHAR|TEXT|STRING|BINARY)\((16777216|8388608|134217728|67108864)\)$/i, '$1');
  const raw = shortType(String(col.data_type || col.type || '').trim()).toUpperCase();
  if (!raw || raw.includes('(')) return raw;
  const base = ALIASES[raw] || raw;
  const p = col.precision ?? col.numeric_precision;
  const sc = col.scale ?? col.numeric_scale;
  const len = col.char_length ?? col.internal_size;
  if (base === 'NUMBER') return p != null ? `NUMBER(${p},${sc ?? 0})` : 'NUMBER';
  if (base === 'VARCHAR' || base === 'CHAR' || base === 'BINARY') return len && !MAX_LEN.has(Number(len)) ? `${base}(${len})` : base;
  if (TIME_TYPES.has(base) && sc != null && col.type && !col.data_type) return `${base}(${sc})`;
  return base;
}

function typeFamily(t) {
  const u = (t || '').toUpperCase();
  if (/\[\]$/.test(u)) return 'vec';      // Postgres arrays (integer[] is a list, not a number)
  if (/^(NUMBER|FLOAT|FIXED|REAL|DECIMAL|NUMERIC|INT|INTEGER|BIGINT|SMALLINT|TINYINT|BYTEINT|DOUBLE)/.test(u)) return 'num';
  if (/^(DATE|TIME|TIMESTAMP|DATETIME)/.test(u)) return 'time';
  if (/^BOOL/.test(u)) return 'bool';
  if (/^(VARIANT|OBJECT|ARRAY|MAP|JSON)/.test(u)) return 'json';
  if (/^(BINARY|VARBINARY|BYTEA)/.test(u)) return 'bin';
  if (/^(GEOGRAPHY|GEOMETRY)/.test(u)) return 'geo';
  if (/^VECTOR/.test(u)) return 'vec';
  return 'text';
}

function colGlyph(dataType) {
  return { num: '#', time: '◷', bool: '✓', json: '{}', bin: '01', geo: '⌖', vec: '[]', text: 'Aa' }[typeFamily(dataType)];
}

/* ------------------------------ primitives ------------------------------ */

const BTN = {
  primary: 'bg-[#eb1700] text-white hover:bg-[#c51300] border border-transparent shadow-[0_1px_2px_rgba(49,44,42,.18)]',
  danger: 'bg-[#9e0000] text-white hover:bg-[#7f0000] border border-transparent',
  dark: 'bg-[#312c2a] text-white hover:bg-[#1f1b1a] border border-transparent',
  secondary: 'bg-white text-[#312c2a] border border-[#d5cfc9] hover:bg-[#f4f2f0] hover:border-[#cbc4bc]',
  ghost: 'bg-transparent text-[#4a423e] border border-transparent hover:bg-[#f1efed]',
};

function Button({ variant = 'secondary', size = 'md', icon, children, className = '', ...rest }) {
  const IconCmp = icon;
  const h = size === 'sm' ? 'h-6 px-2 text-[11.5px] gap-1' : 'h-7 px-2.5 text-[12px] gap-1.5';
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-45 disabled:cursor-not-allowed ${h} ${BTN[variant]} ${className}`}
    >
      {IconCmp && <IconCmp size={size === 'sm' ? 12 : 13} strokeWidth={2} className="flex-shrink-0" />}
      {children}
    </button>
  );
}

function IconButton({ icon, label, active, size = 26, className = '', iconSize = 14, ...rest }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center flex-shrink-0 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-40 ${
        active ? 'bg-[var(--sig-soft)] text-[var(--sig-ink)]' : 'text-[#6e6259] hover:bg-[#f1efed] hover:text-[#312c2a]'
      } ${className}`}
    >
      <IconCmp size={iconSize} strokeWidth={1.9} />
    </button>
  );
}

// Small icon button for the editor's own toolbar, dark or light to match it.
function EdTool({ dark, icon, label, className = '', ...rest }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={`inline-flex items-center justify-center w-[26px] h-[24px] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-35 disabled:cursor-not-allowed ${
        dark ? 'text-[#a39992] hover:bg-[#352f2c] hover:text-white' : 'text-[#6e6259] hover:bg-[#f1efed] hover:text-[#312c2a]'} ${className}`}
    >
      <IconCmp size={14} strokeWidth={1.9} />
    </button>
  );
}

// Foot of the editor: run it, see it going, see how long it took.
// Statements whose "rows affected" means something; for the rest it's just "Done".
const CHANGES_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'TRUNCATE']);

// One chip per statement of a multi-statement run. Statements that returned
// rows open their result; the rest say what they did.
function StatementStrip({ parts, shown, accent, onPick }) {
  const stripRef = useRef(null);
  // Which edges have chips scrolled out of sight, for the fade.
  const [cut, setCut] = useState({ l: false, r: false });
  const measure = () => {
    const el = stripRef.current;
    if (el) setCut({ l: el.scrollLeft > 1, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [shown, parts.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return undefined;
    // The scrollbar is hidden, so an ordinary mouse wheel scrolls sideways here.
    const wheel = (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('wheel', wheel); ro.disconnect(); };
  }, []);
  const fade = cut.l || cut.r
    ? `linear-gradient(90deg, ${cut.l ? 'transparent, #000 28px' : '#000'}, ${cut.r ? '#000 calc(100% - 28px), transparent' : '#000'})`
    : undefined;
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Statements in this run"
      onScroll={measure}
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      className="flex-shrink-0 flex items-end gap-1 px-2 pt-1.5 overflow-x-auto ds-noscroll border-b border-[#efedea]"
    >
      {parts.map(p => {
        const on = p.job_id && p.job_id === shown;
        const opens = Boolean(p.job_id);
        const kind = p.statement_type || (p.text.match(/^\s*([A-Za-z]+)/)?.[1] || '').toUpperCase() || 'Statement';
        const what = p.status === 'failed' ? 'Failed'
          : p.status === 'skipped' ? 'Not run'
          : opens ? plural(p.row_count ?? 0, 'row')
          : CHANGES_ROWS.has(kind) && p.rows_affected != null ? `${fmtN(p.rows_affected)} affected` : 'Done';
        return (
          <button
            key={p.index}
            type="button"
            role="tab"
            aria-selected={Boolean(on)}
            disabled={!opens}
            onClick={() => onPick(p)}
            title={`${p.text}${p.status === 'failed' ? '\n\nThis statement failed. Open it to see the error' : p.status === 'skipped' ? '\n\nNot run, an earlier statement failed' : opens ? '' : '\n\nNo rows to show'}`}
            className={`relative top-px flex-shrink-0 flex items-center gap-1.5 h-[26px] pl-1.5 pr-2.5 rounded-t-[7px] border border-b-0 text-[12px] whitespace-nowrap transition-colors ${on
              ? 'bg-white border-[#e8e6e3] text-[#312c2a] font-medium'
              : opens ? 'border-transparent text-[#6e6259] hover:bg-[#f8f7f5] hover:text-[#312c2a]' : 'border-transparent text-[#a39992] cursor-default'}`}
          >
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold tabular-nums"
              style={on ? { background: accent, color: '#fff' } : { background: '#f1efed', color: p.status === 'failed' ? '#9e0000' : '#6e6259' }}
            >
              {p.index}
            </span>
            <span>{kind}</span>
            <span className={`tabular-nums ${p.status === 'failed' ? 'text-[#9e0000]' : on ? 'text-[#6e6259]' : ''}`}>{what}</span>
          </button>
        );
      })}
    </div>
  );
}

function RunBar({ dark, accent, busy, othersBusy, status, meta, elapsed, statementCount, leadHint, canRun, lockedReason, onRun, onRunAll, onCancel }) {
  const going = busy || othersBusy;
  const ms = going ? elapsed : meta?.elapsed_ms;
  const label = going ? (othersBusy ? 'Someone else is running this worksheet' : 'Running')
    : status === 'success' ? (meta?.statement_count > 1 ? `Done, ${meta.statement_count} statements` : 'Done')
    : status === 'failed' ? 'Failed'
    : status === 'cancelled' ? 'Cancelled'
    : statementCount > 1 ? `${statementCount} statements` : 'Ready';
  const dim = dark ? '#a39992' : '#766a63';
  const track = dark ? '#433b37' : '#efedea';
  // A quick query reads "28 ms", a slow one "4.2 s", a very slow one "2m 05s".
  const [num, unit] = ms == null ? ['0.0', 's'] : ms < 1000 && !going ? [String(Math.round(ms)), 'ms'] : ms < 60000 ? [(ms / 1000).toFixed(1), 's'] : [null, null];
  return (
    <div className="flex-shrink-0 flex items-center gap-1.5 min-w-0 px-2 py-1.5 border-t" style={{ borderColor: track }}>
      {busy ? (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-[9px] bg-white text-[#312c2a] text-[13px] font-semibold shadow-[0_0_0_1px_#e8e6e3] hover:bg-[#f8f7f5] flex-shrink-0"
        >
          <Square size={12} fill="currentColor" />Cancel
          <span className="hidden md:inline-flex items-center h-[18px] px-1.5 rounded bg-[#f1efed] text-[10px] font-medium text-[#6e6259]">{MOD} Enter</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          title={lockedReason || (statementCount > 1 ? `${MOD} + Enter runs the selection, or the statement at the cursor` : `${MOD} + Enter runs the selection, or the whole worksheet`)}
          className={`inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-[9px] text-[12.5px] font-semibold flex-shrink-0 transition-transform enabled:active:scale-[.97] disabled:cursor-not-allowed ${!canRun
            ? (dark ? 'bg-[#3a3330] text-[#8f847c]' : 'bg-[#f1efed] text-[#a39992]')
            : `text-white ${leadHint ? 'bg-[#9e0000] hover:bg-[#7f0000]' : 'bg-[#eb1700] hover:bg-[#c51300]'}`}`}
        >
          <Play size={13} fill="currentColor" />
          {leadHint ? `Run ${leadHint}` : statementCount > 1 ? 'Run statement' : 'Run'}
          <span className={`hidden md:inline-flex items-center h-[18px] px-1.5 rounded text-[10px] font-medium ${canRun ? 'bg-white/20' : dark ? 'bg-white/5' : 'bg-white'}`}>{MOD} Enter</span>
        </button>
      )}
      {!going && statementCount > 1 && (
        <button
          type="button"
          onClick={onRunAll}
          disabled={!canRun}
          title={`${MOD} + Shift + Enter runs every statement in order and shows the last result`}
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-[9px] text-[12px] font-medium flex-shrink-0 disabled:opacity-45 ${dark ? 'text-[#d9d1ca] hover:bg-[#352f2c] hover:text-white' : 'text-[#4a423e] hover:bg-[#f1efed]'}`}
        >
          <ChevronsRight size={15} />Run all {statementCount}
        </button>
      )}
      <div className="flex-1 min-w-0 flex items-center gap-2.5 ml-1.5">
        {/* Only while something runs; once done, the words and the timer say it. */}
        {going && (
          <div className="relative flex-1 max-w-[340px] min-w-[40px] h-[5px] flex" aria-hidden="true">
            <span className="relative flex-1 rounded-full overflow-hidden" style={{ background: track }}>
              <span className="ds-run absolute inset-y-0 left-0 w-2/5 rounded-full" style={{ background: accent }} />
            </span>
          </div>
        )}
        <span className="min-w-0 truncate text-[12px]" style={{ color: status === 'failed' && !going ? (dark ? '#ff8a70' : '#9e0000') : dim }} aria-live="polite">{label}</span>
      </div>
      <div className={`flex-shrink-0 min-w-[56px] text-right font-johnson-display tabular-nums ${ms == null ? (dark ? 'text-[#6e6259]' : 'text-[#cbc4bc]') : dark ? 'text-white' : 'text-[#312c2a]'}`}>
        {num != null ? <><span className="text-[19px] font-medium">{num}</span><span className="ml-0.5 text-[11px]" style={{ color: dim }}>{unit}</span></> : <span className="text-[15px] font-medium">{fmtMs(ms)}</span>}
      </div>
    </div>
  );
}

// Top of the explorer: which engine, which account, and as whom.
function ConnCard({ E, state, info, conn, connections, connId, onConn, role, roleOptions, roleKey, onRole, roleLabel, writesOk }) {
  // The user it signs in as. The server address and Snowflake account aren't much use here.
  const where = conn?.user || info?.user;
  const look = state === 'ready' ? ['#286d10', 'Connected', true] : state === 'checking' ? ['#a14a00', 'Connecting', false] : ['#9e0000', state === 'unconfigured' ? 'Not set up' : 'Offline', false];
  const chip = (k, v, warn) => (
    <span className={`inline-flex items-center gap-1.5 max-w-full h-[24px] px-2.5 rounded-full border text-[11.5px] ${warn ? 'bg-[#fff3ea] border-[#f6dfcc] text-[#a14a00]' : 'bg-white border-black/[.06] text-[#312c2a]'}`}>
      {k && <span className="text-[#766a63]">{k}</span>}<span className="truncate">{v}</span>
    </span>
  );
  return (
    <div className="flex-shrink-0 mx-3 mt-3 mb-1 px-3.5 py-3 rounded-[12px] transition-colors" style={{ background: E.soft }}>
      <div className="flex items-start gap-2.5">
        <img src={E.icon} alt="" className="w-[22px] h-[22px] mt-[2px] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-johnson-display font-bold text-[16px] leading-tight text-[#312c2a]">{E.label}</div>
          <div className="truncate text-[11.5px] text-[#6e6259]" title={where || ''}>{where || (state === 'checking' ? 'Reaching the server...' : state === 'unconfigured' ? 'Not configured' : 'Server not reachable')}</div>
        </div>
        <span className="flex-shrink-0 inline-flex items-center gap-1.5 mt-[3px] text-[11px] font-medium" style={{ color: look[0] }}>
          <span className={`w-[7px] h-[7px] rounded-full ${look[2] ? 'ds-live' : ''}`} style={{ background: look[0] }} />{look[1]}
        </span>
      </div>
      {(!E.pickDb || (connections.length > 1 && onConn) || !writesOk) && (
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 min-w-0">
        {E.pickDb ? (
          connections.length > 1 && onConn ? (
            <Picker size="sm" variant="chip" prefix="Connection" value={connId || ''} onChange={e => onConn(e.target.value)} title="Connection this worksheet runs on" aria-label="Login" className="max-w-full">
              {connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Picker>
          ) : null
        ) : (
          roleOptions.length > 0 && onRole ? (
            <Picker size="sm" variant="chip" prefix="Role" value={roleKey} onChange={e => onRole(e.target.value)} title={role ? `Role: ${role}` : 'Role this worksheet runs as'} aria-label="Role" className="max-w-full">
              {roleOptions.map(o => <option key={`${o.conn}|${o.role}`} value={`${o.conn}|${o.role}`}>{roleLabel(o)}</option>)}
            </Picker>
          ) : chip('Role', role || 'default')
        )}
        {!E.pickDb && chip('Warehouse', conn?.warehouse || info?.warehouse || 'default')}
        {!writesOk && chip(null, 'Read only', true)}
      </div>
      )}
    </div>
  );
}

// A view in the results bar: one segment of a pill switcher.
function ViewTab({ active, onClick, icon, children, title, accent, compact }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={typeof children === 'string' ? children : undefined}
      title={compact ? `${children}: ${title}` : title}
      onClick={onClick}
      className={`flex-shrink-0 inline-flex items-center gap-1.5 h-[24px] px-2 rounded-[7px] text-[12px] font-medium whitespace-nowrap transition-[color,background-color,box-shadow] ${
        active ? 'bg-white text-[#312c2a] shadow-[0_1px_2px_rgba(49,44,42,.12)]' : 'text-[#6e6259] hover:text-[#312c2a]'}`}
    >
      <IconCmp size={13} strokeWidth={2} style={active ? { color: accent } : undefined} />
      <span className={compact ? 'hidden' : ''}>{children}</span>
    </button>
  );
}

// Dropdown with a search box. Same props as a <select> with <option> children,
// and onChange gets { target: { value } } so call sites read like a select.
const PICKER_CSS = `
.sf-pick-list::-webkit-scrollbar { width: 8px; }
.sf-pick-list::-webkit-scrollbar-track { background: transparent; margin: 4px 0; }
.sf-pick-list::-webkit-scrollbar-thumb { background: #d5cfc9; border-radius: 8px; border: 2px solid #fff; }
.sf-pick-list::-webkit-scrollbar-thumb:hover { background: #a39992; }
@supports not selector(::-webkit-scrollbar) {
  .sf-pick-list { scrollbar-width: thin; scrollbar-color: #d5cfc9 transparent; }
}
`;
// Motion for the pane: results arriving, a run in progress, the live dot.
const DS_CSS = `
@keyframes ds-scan { 0% { transform: translateY(-100%); opacity: .9 } 85% { opacity: .5 } 100% { transform: translateY(var(--ds-h, 600px)); opacity: 0 } }
@keyframes ds-run { 0% { transform: translateX(-100%) } 100% { transform: translateX(250%) } }
@keyframes ds-pulse { 0% { transform: scale(1); opacity: .45 } 70%, 100% { transform: scale(3); opacity: 0 } }
@keyframes ds-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes ds-count { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.ds-scan { position: absolute; left: 0; right: 0; top: 0; height: 70px; pointer-events: none; z-index: 15; will-change: transform, opacity; animation: ds-scan 1s cubic-bezier(.2,.8,.2,1) forwards }
.ds-in { animation: ds-in .45s cubic-bezier(.2,.8,.2,1) both }
.ds-count { animation: ds-count .35s cubic-bezier(.2,.8,.2,1) both }
/* Transform and opacity only: a box-shadow pulse repaints every frame, which a cloud PC without a GPU feels. */
.ds-live { position: relative }
.ds-live::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: inherit; animation: ds-pulse 2.4s ease-out infinite; will-change: transform, opacity }
.ds-run { animation: ds-run 1.2s ease-in-out infinite }
.ds-noscroll { scrollbar-width: none } .ds-noscroll::-webkit-scrollbar { display: none }
/* Thin, warm scrollbars across Data Studio (popups included), darker on hover */
.ds-root, .ds-root *, .ds-pop, .ds-pop * { scrollbar-width: thin; scrollbar-color: #d5cfc9 transparent }
.ds-root *:hover, .ds-pop *:hover { scrollbar-color: #a39992 transparent }
.ds-root .ds-dark, .ds-root .ds-dark * { scrollbar-color: #4a423e transparent }
.ds-root .ds-dark:hover, .ds-root .ds-dark *:hover { scrollbar-color: #6e6259 transparent }
@media (prefers-reduced-motion: reduce) { .ds-scan { display: none } .ds-in, .ds-count, .ds-live::after, .ds-sfbar { animation: none } .ds-run { animation: none; width: 100%; opacity: .55 } }
`;
if (typeof document !== 'undefined' && !document.getElementById('ds-css')) {
  const el = document.createElement('style');
  el.id = 'ds-css';
  el.textContent = DS_CSS;
  document.head.appendChild(el);
}
if (typeof document !== 'undefined' && !document.getElementById('sf-pick-css')) {
  const el = document.createElement('style');
  el.id = 'sf-pick-css';
  el.textContent = PICKER_CSS;
  document.head.appendChild(el);
}

function Picker({ icon: Icon, size = 'md', tone = 'light', variant, prefix, className = '', children, value, onChange, disabled, title, 'aria-label': label }) {
  const dark = tone === 'dark';
  const sm = size === 'sm';
  const eng = useEngine();     // the list opens outside the pane, so it brings the colours along
  // 'crumb': a flat name chip, like the database > schema path over the editor.
  const crumb = variant === 'crumb';
  // 'chip': a white pill with a label in front ("Role ..."), like the chips beside it.
  const pill = variant === 'chip';
  const options = React.Children.toArray(children)
    .filter(c => c?.type === 'option')
    .map(c => ({ value: String(c.props.value ?? ''), label: String(c.props.children ?? c.props.value ?? '') }));
  const current = options.find(o => o.value === String(value ?? ''));

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const listRef = useRef(null);

  // The empty-value placeholder is only there to label an unset select.
  const shown = options.filter(o => o.value !== '' && (!q || o.label.toLowerCase().includes(q.toLowerCase())));

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const maxW = Math.min(380, vw - 16);
    // Grow to fit the longest name, open leftwards when there's no room on the right,
    // and never run off either edge of the screen.
    const x = r.left + maxW <= vw - 8 ? { left: r.left } : r.right - maxW >= 8 ? { right: vw - r.right } : { left: 8 };
    const below = window.innerHeight - r.bottom;
    const y = below < 260 && r.top > below ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 };
    setPos({ ...x, ...y, minWidth: Math.min(Math.max(r.width, 220), maxW), maxWidth: maxW });
  }, []);

  const openList = () => {
    if (disabled) return;
    place();
    setQ('');
    setHi(Math.max(0, options.filter(o => o.value !== '').findIndex(o => o.value === current?.value)));
    setOpen(true);
  };
  const close = (focus = true) => { setOpen(false); if (focus) btnRef.current?.focus(); };
  const pick = (o) => { if (o.value !== current?.value) onChange?.({ target: { value: o.value } }); close(); };

  useEffect(() => {
    if (!open) return;
    const outside = (e) => { if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(false); };
    const away = (e) => { if (!popRef.current?.contains(e.target)) close(false); };
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', away, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[hi]) pick(shown[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <span className={`group relative inline-flex items-center self-center ${crumb ? 'min-w-[48px]' : 'min-w-[56px] sm:min-w-[72px]'} flex-shrink ${className}`}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openList())}
        onKeyDown={e => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) { e.preventDefault(); openList(); } }}
        className={pill
          ? `w-full min-w-0 flex items-center gap-1.5 h-[24px] pl-2.5 pr-1.5 rounded-full border bg-white text-left text-[11.5px] text-[#312c2a] cursor-pointer transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${open ? 'border-[var(--sig)] ring-2 ring-[var(--sig-ring)]' : 'border-black/[.06] hover:border-[#cbc4bc] focus-visible:border-[var(--sig)]'}`
          : crumb
          ? `w-full min-w-0 flex items-center h-[24px] px-2 rounded-[6px] text-left text-[12px] font-medium cursor-pointer transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${dark
            ? `${open ? 'bg-[#433b37] text-white' : 'bg-[#352f2c] text-[#d9d1ca] hover:bg-[#433b37] hover:text-white'} focus-visible:ring-1 focus-visible:ring-[#a39992]`
            : `${open ? 'bg-[#e8e6e3] text-[#312c2a]' : 'bg-[#f1efed] text-[#4a423e] hover:bg-[#e8e6e3] hover:text-[#312c2a]'} focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]`}`
          : `w-full min-w-0 flex items-center gap-1.5 text-left cursor-pointer rounded-md border font-medium transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${dark
          ? `bg-[#352f2c] text-[#efe9e4] ${open ? 'border-[#6e6259]' : 'border-transparent hover:bg-[#433b37] focus-visible:border-[#a39992]'}`
          : `bg-white text-[#312c2a] shadow-[0_1px_0_rgba(49,44,42,0.04)] ${open ? 'border-[var(--sig)] ring-2 ring-[var(--sig-ring)]' : 'border-[#d5cfc9] hover:border-[#a39992] hover:bg-[#fbfaf9] focus-visible:border-[var(--sig)] focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]'}`} ${
          sm ? 'h-[22px] px-1.5 text-[11.5px]' : 'h-[28px] px-2 text-[12.5px]'}`}
      >
        {prefix && <span className="flex-shrink-0 text-[#766a63]">{prefix}</span>}
        {Icon && !crumb && !pill && <Icon size={sm ? 12 : 13} className={`hidden sm:block flex-shrink-0 ${open ? 'text-[var(--sig-ink)]' : dark ? 'text-[#a39992]' : 'text-[#766a63]'}`} />}
        <span className={`flex-1 min-w-0 truncate ${current?.value ? '' : `${dark ? 'text-[#a39992]' : 'text-[#766a63]'} font-normal`}`}>{current?.label || label}</span>
        {!crumb && <ChevronDown size={pill ? 12 : sm ? 12 : 14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180 text-[var(--sig-ink)]' : dark ? 'text-[#a39992]' : 'text-[#766a63]'}`} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ ...sigVars(eng), position: 'fixed', ...pos, width: 'max-content', zIndex: 1000 }}
          className="ds-pop flex flex-col rounded-lg border border-[#e8e6e3] bg-white shadow-[0_10px_28px_rgba(49,44,42,0.14),0_2px_6px_rgba(49,44,42,0.06)] overflow-hidden"
        >
          <div className="relative p-1.5 border-b border-[#efedea]">
            <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#a39992]" />
            <input
              autoFocus
              value={q}
              onChange={e => { setQ(e.target.value); setHi(0); }}
              onKeyDown={onKey}
              placeholder={`Search ${(label || '').toLowerCase()}s`}
              aria-label={`Search ${label || ''}`}
              className="w-full h-[28px] pl-7 pr-7 rounded-md border border-[#e8e6e3] bg-[#fbfaf9] text-[12.5px] text-[#312c2a] placeholder:text-[#a39992] focus:outline-none focus:border-[var(--sig)] focus:bg-white"
            />
            {q && (
              <button type="button" onClick={() => { setQ(''); setHi(0); }} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-[#766a63] hover:text-[#312c2a]">
                <X size={12} />
              </button>
            )}
          </div>
          <div ref={listRef} role="listbox" aria-label={label} className="sf-pick-list max-h-[280px] overflow-y-auto p-1">
            {shown.length === 0 && <div className="px-2.5 py-3 text-center text-[12px] text-[#766a63]">No matches</div>}
            {shown.map((o, i) => {
              const on = o.value === current?.value;
              return (
                <div
                  key={o.value}
                  data-i={i}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(o)}
                  title={o.label}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer text-[12.5px] ${
                    on ? 'text-[var(--sig-ink)] font-semibold' : 'text-[#312c2a]'} ${i === hi ? (on ? 'bg-[var(--sig-mid)]' : 'bg-[#f4f2f0]') : (on ? 'bg-[#fdf0ee]' : '')}`}
                >
                  <Check size={13} className={`flex-shrink-0 ${on ? '' : 'invisible'}`} />
                  <span className="min-w-0 truncate"><Highlight text={o.label} q={q} /></span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

const Kbd = ({ children }) => (
  <kbd className="inline-flex items-center h-[18px] px-1.5 rounded border border-[#d5cfc9] bg-white text-[10.5px] font-sans text-[#6e6259] shadow-[0_1px_0_#d5cfc9]">
    {children}
  </kbd>
);

const Spinner = ({ size = 14, className = '' }) => (
  <Loader2 size={size} className={`animate-spin text-[var(--sig-ink)] ${className}`} aria-label="Loading" />
);

const StatusDot = ({ color, pulse }) => (
  <span className="relative inline-flex w-2 h-2 flex-shrink-0">
    {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: color }} />}
    <span className="relative w-2 h-2 rounded-full" style={{ background: color }} />
  </span>
);

// Thin indeterminate bar, the same cue Snowflake shows above a running grid.
const ProgressBar = () => (
  <div className="relative h-[2px] w-full overflow-hidden bg-[var(--sig-soft)]">
    <style>{'@keyframes sfbar{0%{transform:translateX(-100%)}60%,100%{transform:translateX(286%)}}'}</style>
    <div className="ds-sfbar absolute top-0 left-0 h-full w-[35%] bg-[var(--sig)]" style={{ animation: 'sfbar 1.3s ease-in-out infinite', willChange: 'transform' }} />
  </div>
);

const Skel = ({ w = '100%', h = 10, className = '' }) => (
  <div className={`animate-pulse rounded bg-[#ece9e6] ${className}`} style={{ width: w, height: h }} />
);

function GridSkeleton({ cols = 6, rows = 12 }) {
  return (
    <div className="min-w-full">
      <div className="flex border-b border-[#e8e6e3] bg-[#f8f7f5]">
        <div className="w-[52px] flex-shrink-0 h-[44px] border-r border-[#e8e6e3]" />
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="flex-1 min-w-[120px] h-[44px] px-3 flex flex-col justify-center gap-1.5 border-r border-[#e8e6e3]">
            <Skel w="60%" h={9} />
            <Skel w="35%" h={7} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className={`flex border-b border-[#f1efed] ${r % 2 ? 'bg-[#fbfaf9]' : ''}`}>
          <div className="w-[52px] flex-shrink-0 h-[30px] border-r border-[#f1efed]" />
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="flex-1 min-w-[120px] h-[30px] px-3 flex items-center border-r border-[#f1efed]">
              <Skel w={`${35 + ((r * 7 + c * 13) % 55)}%`} h={8} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, children, action }) {
  const IconCmp = icon;
  return (
    <div className="min-h-full flex items-center justify-center px-6 py-8">
      <div className="max-w-[420px] text-center">
        {IconCmp && (
          <div className="mx-auto mb-3.5 w-11 h-11 rounded-xl bg-[#f1efed] flex items-center justify-center text-[#6e6259]">
            <IconCmp size={20} strokeWidth={1.7} />
          </div>
        )}
        <div className="font-johnson-display text-[15px] font-bold text-[#312c2a]">{title}</div>
        {children && <div className="mt-1.5 text-[12.5px] leading-relaxed text-[#6e6259]">{children}</div>}
        {action && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ errors ---------------------------------- */

function ErrorPanel({ error, onRetry, onJump, retryLabel = 'Try again' }) {
  const [copied, setCopied] = useState(false);
  if (!error) return null;
  const e = parseSfError(error);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(e.raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* no clipboard */ }
  };
  return (
    <div className="p-5">
      <div className="max-w-[820px] rounded-lg border border-[#f3d0cc] bg-white overflow-hidden shadow-[0_1px_3px_rgba(49,44,42,.06)]">
        <div className="flex items-start gap-3 px-4 py-3.5 bg-[#fdf3f1] border-b border-[#f3d0cc]">
          <TriangleAlert size={18} className="flex-shrink-0 mt-[1px] text-[#9e0000]" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-bold text-[#312c2a] break-words">{e.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#6e6259]">
              {e.code && <span>Error <span className="font-mono text-[#312c2a]">{e.code}</span></span>}
              {e.state && <span>SQL state <span className="font-mono text-[#312c2a]">{e.state}</span></span>}
              {e.line != null && <span>Line {e.line}, position {e.col}</span>}
            </div>
          </div>
        </div>
        {e.detail && (
          <pre className="m-0 px-4 py-3 max-h-[220px] overflow-auto text-[12px] leading-relaxed font-mono text-[#4a423e] whitespace-pre-wrap break-words">
            {e.detail}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[#f1efed] bg-[#fbfaf9]">
          {onRetry && <Button size="sm" variant="dark" icon={RotateCcw} onClick={onRetry}>{retryLabel}</Button>}
          {onJump && e.line != null && (
            <Button size="sm" onClick={() => onJump(e.line, e.col)}>Go to line {e.line}</Button>
          )}
          <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy error'}</Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- toasts --------------------------------- */

function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  const tone = {
    success: { Icon: CircleCheck, color: T.green },
    error: { Icon: TriangleAlert, color: T.maroon },
    info: { Icon: Info, color: T.muted },
  };
  return (
    <div className="pointer-events-none absolute bottom-12 right-4 z-[60] flex flex-col items-end gap-2 max-w-[calc(100%-32px)]">
      {toasts.map(t => {
        const s = tone[t.tone] || tone.info;
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 w-[340px] max-w-full pl-3.5 pr-2 py-2.5 rounded-lg bg-white border border-[#e8e6e3] shadow-[0_8px_24px_rgba(49,44,42,.14)] text-[12.5px] text-[#312c2a]"
          >
            <s.Icon size={16} className="flex-shrink-0 mt-[1px]" style={{ color: s.color }} />
            <div className="flex-1 min-w-0 break-words leading-snug">{t.message}</div>
            <button onClick={() => onDismiss(t.id)} className="p-0.5 rounded text-[#766a63] hover:bg-[#f1efed]" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------- pager --------------------------------- */

function Pager({ page, totalPages, loading, onGo }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onGo(n);
    else setDraft(String(page));
  };
  const last = totalPages || 1;
  return (
    <div className="flex items-center gap-1">
      <IconButton icon={ChevronsLeft} label="First page" size={26} iconSize={14} onClick={() => onGo(1)} disabled={page <= 1 || loading} />
      <IconButton icon={ChevronLeft} label="Previous page" size={26} iconSize={14} onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} />
      <span className="flex items-center gap-1.5 px-1 text-[12px] text-[#6e6259] tabular-nums whitespace-nowrap">
        Page
        <input
          type="number"
          min="1"
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          aria-label="Go to page"
          className="w-[52px] h-[26px] rounded-md border border-[#d5cfc9] bg-white px-1.5 text-center text-[12px] text-[#312c2a] tabular-nums focus:outline-none focus:border-[var(--sig)] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        of {fmtN(last)}
      </span>
      <IconButton icon={ChevronRight} label="Next page" size={26} iconSize={14} onClick={() => onGo(page + 1)} disabled={page >= last || loading} />
      <IconButton icon={ChevronsRight} label="Last page" size={26} iconSize={14} onClick={() => onGo(last)} disabled={page >= last || loading} />
    </div>
  );
}

/* -------------------------------- modals -------------------------------- */

function Modal({ open, onClose, width = 480, children, labelledBy }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#312c2a]/45 px-4 py-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={e => e.stopPropagation()}
        className="w-full max-h-full flex flex-col bg-white rounded-xl shadow-[0_24px_60px_rgba(49,44,42,.28)] overflow-hidden font-johnson-text"
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>
  );
}

function ConfirmDestructiveModal({ info, onCancel, onConfirm, confirming }) {
  return (
    <Modal open={!!info} onClose={onCancel} width={460} labelledBy="sf-confirm-title">
      {info && (
        <>
          <div className="flex items-start gap-3.5 px-5 pt-5">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[var(--sig-soft)] flex items-center justify-center text-[#9e0000]">
              <TriangleAlert size={19} />
            </div>
            <div className="min-w-0">
              <h3 id="sf-confirm-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a]">
                {info.count > 1 ? `Run these ${info.count} statements?` : `Run this ${info.statement_type} statement?`}
              </h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6e6259]">{info.message}</p>
              {info.warning && (
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#9e0000] bg-[#fdf3f1] border border-[#f3d0cc] rounded-md px-3 py-2">
                  {info.warning.split('\n').map((w, i) => <span key={i} className="block">{w}</span>)}
                </p>
              )}
            </div>
          </div>
          <div className="mt-5 px-5 py-3.5 flex items-center justify-end gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="danger" onClick={onConfirm} disabled={confirming}>
              {confirming ? 'Running...' : info.count > 1 ? 'Run all' : `Run ${info.statement_type}`}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Read-only SQL with the same colours as the editor. Used for DDL, history,
// saved queries, the details tab and the change preview.
function SqlCode({ sql, className = '', theme = 'light', format = true }) {
  const palette = TOKEN_COLORS[theme] || TOKEN_COLORS.light;
  const tokens = useMemo(() => tokenizeSql(format ? formatSql(sql || '') : (sql || '')), [sql, format]);
  return (
    <code className={`font-mono ${className}`}>
      {tokens.map((tok, i) => (
        <span key={i} style={{ color: palette[tok.kind] || palette.plain, fontStyle: tok.kind === 'comment' ? 'italic' : undefined }}>{tok.text}</span>
      ))}
    </code>
  );
}

const SHOW_MAX = 2_000_000;    // characters drawn in the viewer; Copy and Download get all of it

// Text viewer (DDL, a cell). For a cell the grid only had the start of,
// loadFull fetches the whole value: shown pretty-printed when it is JSON,
// and it can be copied or saved as a file.
function TextModal({ title, subtitle, body, onClose, mono = true, sql = false, loadFull, fileName }) {
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(null);       // { text, truncated, size } | { error }
  const [loading, setLoading] = useState(false);
  useEffect(() => { setFull(null); setLoading(false); }, [title, body]);
  const text = full?.text ?? body ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* no clipboard */ }
  };
  const load = async () => {
    setLoading(true);
    try {
      const got = await loadFull();
      let t = got.value === null || got.value === undefined ? 'NULL' : typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
      let json = false;
      if (t.length < 5_000_000 && /^\s*[[{]/.test(t)) {
        try { t = JSON.stringify(JSON.parse(t), null, 2); json = true; } catch { /* not JSON */ }
      }
      setFull({ text: t, json, truncated: got.truncated, size: got.size });
    } catch (err) {
      setFull({ error: err.message || 'Could not load the value' });
    } finally {
      setLoading(false);
    }
  };
  const save = () => {
    const blob = new Blob([text], { type: full?.json ? 'application/json' : 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(fileName || title || 'value').replace(/[^\w.-]+/g, '_')}.${full?.json ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const shown = text.length > SHOW_MAX ? `${text.slice(0, SHOW_MAX)}\n\n… the first ${fmtN(SHOW_MAX)} characters are shown. Copy or Download for all of it.` : text;
  return (
    <Modal open={!!title} onClose={onClose} width={820} labelledBy="sf-text-title">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#e8e6e3]">
        <div className="min-w-0 flex-1">
          <h3 id="sf-text-title" className="font-johnson-display font-bold text-[15px] text-[#312c2a] break-all">{title}</h3>
          {subtitle && <div className="text-[11.5px] text-[#6e6259] mt-0.5">{full?.text ? `${subtitle} · ${fmtN(full.text.length)} characters${full.json ? ' · JSON, formatted' : ''}` : subtitle}</div>}
        </div>
        {loadFull && !full?.text && (
          <Button size="sm" variant="primary" icon={loading ? undefined : Maximize2} disabled={loading} onClick={load}>
            {loading ? <><Spinner size={12} /> Loading…</> : 'Load full value'}
          </Button>
        )}
        {full?.text && <Button size="sm" icon={Download} onClick={save}>Download</Button>}
        <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      {full?.error && <div className="mx-5 mt-3 flex items-start gap-2 rounded-md bg-[#fdf3f1] px-3 py-2 text-[12.5px] text-[#9e0000]"><TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />{full.error}</div>}
      {full?.truncated && <div className="mx-5 mt-3 rounded-md bg-[#fff6e5] px-3 py-2 text-[12.5px] text-[#7a4a00]">This value is {fmtN(full.size)} characters; the first {fmtN(full.text.length)} are here. Download the query result for all of it.</div>}
      <pre className={`flex-1 min-h-[120px] overflow-auto m-0 px-5 py-4 text-[12.5px] leading-relaxed text-[#312c2a] whitespace-pre-wrap break-words bg-[#fbfaf9] ${mono ? 'font-mono' : 'font-johnson-text'}`}>
        {sql ? <SqlCode sql={shown} /> : shown}
      </pre>
    </Modal>
  );
}

function SavePromptModal({ open, initialName, onCancel, onSave }) {
  const [name, setName] = useState(initialName || '');
  const [shared, setShared] = useState(false);
  useEffect(() => { if (open) { setName(initialName || ''); setShared(false); } }, [open, initialName]);
  return (
    <Modal open={open} onClose={onCancel} width={420} labelledBy="sf-save-title">
      <div className="px-5 pt-5">
        <h3 id="sf-save-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a]">Save query</h3>
        <label className="block mt-3.5 text-[11.5px] font-medium text-[#6e6259]" htmlFor="sf-save-name">Name</label>
        <input
          id="sf-save-name"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), shared); }}
          placeholder="e.g. Daily order counts"
          className="mt-1 w-full h-9 rounded-md border border-[#d5cfc9] px-3 text-[13px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] focus:ring-2 focus:ring-[var(--sig-ring)]"
        />
        <label className="mt-3 flex items-center gap-2 text-[12.5px] text-[#4a423e] cursor-pointer select-none">
          <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} className="accent-[var(--sig)]" />
          Share with everyone who can use Data Studio
        </label>
      </div>
      <div className="mt-5 px-5 py-3.5 flex items-center justify-end gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(name.trim(), shared)} disabled={!name.trim()}>Save</Button>
      </div>
    </Modal>
  );
}

/* --------------------------- shared worksheets --------------------------- */

// One colour per person, by their place in the worksheet (owner first). Red is
// left out: that is your own caret.
const PEER_COLORS = ['#0f68b2', '#8c3bbb', '#328714'];
// "Saggurthi, Keshava purna vardhan" (how the directory writes names) -> Keshava;
// "Ann Tester" -> Ann; "ann@x.com" -> ann.
const firstName = (name) => {
  const n = (name || '').trim();
  const given = n.includes(',') ? n.slice(n.indexOf(',') + 1) : n;
  return given.trim().split(/[\s@]/)[0] || n.split(/[\s@,]/)[0] || 'Someone';
};
const initials = (name) => {
  const parts = (name || '?').split('@')[0].split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

const peerLabel = (peer) => firstName(peer.name);

// Open connections (one per browser tab) folded into people.
function groupPeople(others, meta, colorOf) {
  const people = [];
  others.forEach(p => {
    if (p.email === meta?.you) return;
    let person = people.find(x => x.email === p.email);
    if (!person) {
      const member = meta?.members.find(m => m.email === p.email);
      person = { email: p.email, name: p.name, color: colorOf(p.email), viewOnly: member ? !member.can_edit : false, at: null };
      people.push(person);
    }
    person.typing = person.typing || p.typing;
    person.running = person.running || p.state === 'running';
    if (p.sel && person.at === null) person.at = p.sel.h;
  });
  return people;
}

// Avatars of who is here and what they are doing. Listens to the session by
// itself, so cursors and typing dots don't re-render the pane around it.
function PeerBar({ session, meta, colorOf, onFollow }) {
  const people = groupPeople(usePeers(session), meta, colorOf);
  const photoFor = useDirectoryPhotos(people);
  const live = session?.status === 'live';
  // A reconnect is usually over in a blink; only say so when it isn't.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (live) { setSlow(false); return undefined; }
    const t = setTimeout(() => setSlow(true), 700);
    return () => clearTimeout(t);
  }, [live]);
  return (
    <div className="flex items-center mr-2" aria-label="People in this worksheet">
      {people.map(p => (
        <button key={p.email} type="button" onClick={() => p.at !== null && onFollow(p.at)} className="-ml-1.5 first:ml-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]" title={`${p.name} · click to jump to their cursor`}>
          <PeerAvatar person={{ ...p, photo: photoFor(p) }} />
        </button>
      ))}
      <span
        className="ml-1.5 hidden sm:flex items-center gap-1.5 text-[11.5px] text-[#6e6259] whitespace-nowrap"
        title={live || !slow ? 'Edits are shared as you type' : 'Edits you make now are sent once the connection is back'}
      >
        <StatusDot color={live || !slow ? T.green : T.amber} pulse={!live && slow} />
        {!live && slow ? 'Reconnecting' : meta?.role === 'view' ? 'View only' : people.length ? 'Live' : 'Only you'}
      </span>
    </div>
  );
}

// The strip under the editor: shortcut hints, or what the others are doing
// right now when someone is typing or running a query.
function PeerActivity({ session, meta, children }) {
  const doing = groupPeople(usePeers(session), meta, () => '').filter(p => p.running || p.typing)
    .map(p => `${firstName(p.name)} is ${p.running ? 'running a query' : 'typing'}`).join(' · ');
  if (!doing) return children;
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-[#0f68b2]" aria-live="polite">
      <Spinner size={11} /><span className="truncate">{doing}</span>
    </div>
  );
}

function PeerAvatar({ person, size = 24 }) {
  const doing = person.running ? 'running a query' : person.typing ? 'typing' : person.online === false ? 'not here right now' : person.viewOnly ? 'viewing' : 'here';
  return (
    <span
      title={`${person.name} · ${doing}`}
      className="relative inline-flex flex-shrink-0 items-center justify-center rounded-full text-white text-[10px] font-bold ring-2 ring-[#f8f7f5] select-none"
      style={{ width: size, height: size, background: person.color, opacity: person.online === false ? 0.4 : 1, boxShadow: person.photo ? `0 0 0 2px ${person.color}` : undefined }}
    >
      {person.photo ? <img src={person.photo} alt="" className="w-full h-full rounded-full object-cover" /> : initials(person.name)}
      {(person.running || person.typing) && <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-[var(--sig)] ring-1 ring-white animate-pulse" />}
    </span>
  );
}

const ROLE_SELECT = 'h-8 rounded-md border border-[#d5cfc9] bg-white px-2 text-[12.5px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] disabled:opacity-50';

// Who is in a shared worksheet and what they may do. Before the worksheet is
// shared it is the one place that says what sharing means.
function ShareModal({ open, onClose, tab, meta, session, engineLabel, colorOf, onShare, onInvite, onRemove, onStop, link }) {
  const peers = usePeers(open ? session : null);
  const here = new Set(peers.map(p => p.email));
  const [email, setEmail] = useState('');
  const [canEdit, setCanEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hits, setHits] = useState([]);       // directory matches: { name, email, title }
  const [pick, setPick] = useState(0);
  const [searching, setSearching] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) { setEmail(''); setCanEdit(true); setError(null); setHits([]); setConfirmStop(false); setCopied(false); } }, [open, tab?.id]);

  // Search the company directory (Azure AD) as you type: name or email.
  // Anyone it can't find can still be invited by typing the full address.
  const msal = useMsal();
  const msalRef = useRef(msal);
  msalRef.current = msal;
  const taken = new Set([meta?.owner?.email, ...(meta?.members || []).map(m => m.email)].filter(Boolean));
  const takenKey = [...taken].join('|');
  useEffect(() => {
    const q = email.trim();
    if (!open || q.length < 2) { setHits([]); setSearching(false); return undefined; }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await searchDirectory(await graphToken(msalRef.current.instance, msalRef.current.accounts), q, 8);
        if (!stale) { setHits(found.filter(p => !takenKey.split('|').includes(p.email.toLowerCase()))); setPick(0); }
      } catch {
        if (!stale) setHits([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 180);
    return () => { stale = true; clearTimeout(timer); };
  }, [email, open, takenKey]);
  const photoFor = useDirectoryPhotos(open ? [meta?.owner, ...(meta?.members || []), ...hits].filter(Boolean) : []);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); return true; } catch (err) { setError(err.message || 'That did not work'); return false; } finally { setBusy(false); }
  };
  const invite = async (who) => {
    const to = (who?.email || email).trim().toLowerCase();
    if (!to) return;
    if (await run(() => onInvite(to, canEdit, who?.name || ''))) { setEmail(''); setHits([]); }
  };
  const onEmailKey = (e) => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setPick(i => (i + 1) % hits.length); }
    else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setPick(i => (i - 1 + hits.length) % hits.length); }
    else if (e.key === 'Escape' && hits.length) { e.stopPropagation(); setHits([]); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && hits.length) { e.preventDefault(); invite(hits[pick]); }
    else if (e.key === 'Enter' && email.trim()) invite();
  };

  const owner = meta?.role === 'owner';
  const members = meta?.members || [];
  const full = members.length >= 2;
  const person = (m, role) => (
    <div key={m.email} className="flex items-center gap-2.5 py-1.5">
      <PeerAvatar person={{ name: m.name || m.email, color: colorOf(m.email), photo: photoFor(m), online: m.email === meta.you || here.has(m.email) }} size={28} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[13px] text-[#312c2a]">{m.name || m.email}{m.email === meta.you && <span className="text-[#766a63]"> (you)</span>}</div>
        {m.name && <div className="truncate text-[11.5px] text-[#766a63]">{m.email}</div>}
      </div>
      {role === 'owner' && <span className="text-[12px] text-[#6e6259]">Owner</span>}
      {role !== 'owner' && owner && (
        <>
          <select
            value={m.can_edit ? 'edit' : 'view'}
            disabled={busy}
            onChange={e => run(() => onInvite(m.email, e.target.value === 'edit'))}
            aria-label={`Access for ${m.email}`}
            className={ROLE_SELECT}
          >
            <option value="edit">Can edit</option>
            <option value="view">View only</option>
          </select>
          <IconButton icon={X} label={`Remove ${m.email}`} disabled={busy} onClick={() => run(() => onRemove(m.email))} />
        </>
      )}
      {role !== 'owner' && !owner && <span className="text-[12px] text-[#6e6259]">{m.can_edit ? 'Can edit' : 'View only'}</span>}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} width={480} labelledBy="sf-share-title">
      <div className="px-5 pt-5 pb-1 overflow-y-auto">
        <h3 id="sf-share-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a] truncate">Share &ldquo;{tab?.name}&rdquo;</h3>

        {!tab?.shared && (
          <p className="mt-2.5 text-[13px] leading-relaxed text-[#4a423e]">
            Work in this worksheet with up to two other people at the same time. Everyone sees the SQL as it is typed,
            where the others&apos; cursors are, and the results of queries run here. You choose who can edit and who can only watch.
          </p>
        )}

        {tab?.shared && !meta && (
          <div className="mt-4 flex items-center gap-2 text-[13px] text-[#6e6259]"><Spinner /> Connecting to the worksheet...</div>
        )}

        {tab?.shared && meta && (
          <>
            <div className="mt-3">
              {person(meta.owner, 'owner')}
              {members.map(m => person(m, 'member'))}
            </div>

            {owner && !full && (
              <div className="mt-3 pt-3 border-t border-[#e8e6e3]">
                <label className="block text-[11.5px] font-medium text-[#6e6259]" htmlFor="sf-share-email">Invite people</label>
                <div className="relative mt-1 flex items-center gap-2">
                  <input
                    id="sf-share-email"
                    autoFocus
                    type="text"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={onEmailKey}
                    placeholder="Search by name or email"
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={hits.length > 0}
                    aria-controls="sf-share-hits"
                    aria-activedescendant={hits.length ? `sf-share-hit-${pick}` : undefined}
                    className="flex-1 min-w-0 h-8 rounded-md border border-[#d5cfc9] px-2.5 text-[13px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] focus:ring-2 focus:ring-[var(--sig-ring)]"
                  />
                  <select value={canEdit ? 'edit' : 'view'} onChange={e => setCanEdit(e.target.value === 'edit')} aria-label="Access" className={ROLE_SELECT}>
                    <option value="edit">Can edit</option>
                    <option value="view">View only</option>
                  </select>
                  <Button variant="primary" icon={UserPlus} onClick={() => invite()} disabled={busy || !email.trim()}>Invite</Button>
                  {searching && !hits.length && <span className="absolute right-[196px] top-1/2 -translate-y-1/2"><Spinner size={12} /></span>}
                </div>
                {hits.length > 0 && (
                  <div id="sf-share-hits" role="listbox" className="mt-1 max-h-[264px] overflow-y-auto py-1 bg-white border border-[#e8e6e3] rounded-lg shadow-[0_6px_18px_rgba(49,44,42,.10)]">
                    {hits.map((h, i) => (
                      <div
                        key={h.email}
                        id={`sf-share-hit-${i}`}
                        role="option"
                        aria-selected={i === pick}
                        onMouseDown={e => { e.preventDefault(); invite(h); }}
                        onMouseEnter={() => setPick(i)}
                        className={`flex items-center gap-2.5 mx-1 px-2 py-1.5 rounded-md cursor-pointer ${i === pick ? 'bg-[var(--sig-soft)]' : ''}`}
                      >
                        <PeerAvatar person={{ name: h.name || h.email, color: '#766a63', photo: photoFor(h) }} size={28} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-[13px] text-[#312c2a]">{h.name || h.email}</span>
                          <span className="block truncate text-[11.5px] text-[#766a63]">{h.email}{h.title ? ` · ${h.title}` : ''}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-[11.5px] text-[#766a63]">They need access to the {engineLabel} pane. Send them the link once they are added.</p>
              </div>
            )}
            {owner && full && <p className="mt-3 pt-3 border-t border-[#e8e6e3] text-[12px] text-[#6e6259]">This worksheet is full: three people. Remove someone to invite another.</p>}
            <p className="mt-3 text-[11.5px] leading-relaxed text-[#766a63]">
              Results of queries run here are shown to everyone in the worksheet, whatever their own {engineLabel} role.
            </p>
          </>
        )}

        {error && <div className="mt-3 flex items-start gap-2 rounded-md bg-[#fdf3f1] px-3 py-2 text-[12.5px] text-[#9e0000]"><TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />{error}</div>}
      </div>

      <div className="mt-4 px-5 py-3.5 flex items-center gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
        {tab?.shared && meta && (
          <>
            <Button icon={copied ? Check : Link2} onClick={() => { navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            {owner && (confirmStop
              ? <Button variant="danger" disabled={busy} onClick={async () => { if (await run(onStop)) onClose(); }}>Yes, stop sharing</Button>
              : <Button variant="ghost" onClick={() => setConfirmStop(true)} title="Everyone keeps a private copy of the text">Stop sharing</Button>)}
            {!owner && <Button variant="ghost" icon={LogOut} disabled={busy} onClick={async () => { if (await run(() => onRemove(meta.you))) onClose(); }}>Leave</Button>}
          </>
        )}
        <span className="flex-1" />
        {tab?.shared
          ? <Button variant="primary" onClick={onClose}>Done</Button>
          : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" icon={Users} disabled={busy} onClick={() => run(onShare)}>{busy ? 'Sharing...' : 'Share worksheet'}</Button>
            </>
          )}
      </div>
    </Modal>
  );
}

// Shows a bound statement with its values filled in so people can read what
// will run. Display only, the real call still binds parameters.
function inlineParams(sql, params) {
  if (!Array.isArray(params) || !params.length) return sql;
  let i = 0;
  let out = '';
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?' && i < params.length) {
      const v = params[i];
      i += 1;
      out += v === null || v === undefined ? 'NULL' : `'${(cellText(v) || '').replace(/'/g, "''")}'`;
      continue;
    }
    out += ch;
  }
  return out;
}

const KIND_STYLE = {
  update: { label: 'Update', color: '#a14a00', bg: '#fff3ea' },
  insert: { label: 'Insert', color: '#328714', bg: '#eef6ea' },
  delete: { label: 'Delete', color: '#9e0000', bg: '#fdf3f1' },
};

const showVal = (v) => (v === null || v === undefined || v === ''
  ? <span className="inline-block px-1.5 rounded bg-[#f1efed] text-[10.5px] font-medium text-[#766a63]">NULL</span>
  : <span className="break-all">{cellText(v)}</span>);

function ChangeCard({ change, index, statement, showSql, keys }) {
  const st = KIND_STYLE[change.kind] || KIND_STYLE.update;
  const keyCols = (keys && keys.length ? keys : Object.keys(change.original || {})).filter(k => change.original && k in change.original);
  const keyPreview = keyCols.slice(0, 3).map(k => `${k} = ${cellText(change.original[k]) ?? 'NULL'}`).join(' · ');
  return (
    <div className="rounded-lg border border-[#e8e6e3] bg-white overflow-hidden">
      <div className="flex items-center gap-2.5 px-3.5 py-2 border-b border-[#f1efed] bg-[#fbfaf9]">
        <span className="text-[11px] font-bold uppercase tracking-[.06em] px-2 py-0.5 rounded" style={{ color: st.color, background: st.bg }}>{st.label}</span>
        <span className="text-[12px] text-[#766a63] tabular-nums">#{index + 1}</span>
        {change.kind !== 'insert' && keyPreview && (
          <span className="min-w-0 truncate text-[11.5px] font-mono text-[#6e6259]" title={keyCols.map(k => `${k} = ${cellText(change.original[k]) ?? 'NULL'}`).join('\n')}>
            {keyPreview}{keyCols.length > 3 ? ` +${keyCols.length - 3} more` : ''}
          </span>
        )}
      </div>
      {change.kind === 'update' && (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[10.5px] font-bold uppercase tracking-[.06em] text-[#766a63]">
              <th className="px-3.5 py-1.5 w-[32%] font-bold">Column</th>
              <th className="px-3.5 py-1.5 w-[34%] font-bold">Before</th>
              <th className="px-3.5 py-1.5 font-bold">After</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(change.values).map(([col, v]) => (
              <tr key={col} className="border-t border-[#f1efed] align-top">
                <td className="px-3.5 py-2 font-medium text-[#312c2a] break-all">{col}</td>
                <td className="px-3.5 py-2 text-[#766a63] line-through decoration-[#cbc4bc]">{showVal(change.original?.[col])}</td>
                <td className="px-3.5 py-2 text-[#312c2a] bg-[#fffaf5]">{showVal(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {change.kind === 'insert' && (
        <div className="px-3.5 py-2 grid grid-cols-[minmax(120px,32%)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          {Object.entries(change.values).map(([col, v]) => (
            <React.Fragment key={col}>
              <span className="font-medium text-[#312c2a] break-all">{col}</span>
              <span className="text-[#312c2a]">{showVal(v)}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      {change.kind === 'delete' && (
        <div className="px-3.5 py-2 text-[12.5px] text-[#6e6259]">This row will be removed from the table.</div>
      )}
      {showSql && statement && (
        <pre className="m-0 px-3.5 py-2.5 border-t border-[#f1efed] bg-[#fbfaf9] text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-[260px] overflow-auto">
          <SqlCode sql={inlineParams(statement.sql, statement.params)} />
        </pre>
      )}
    </div>
  );
}

function ApplyChangesModal({ preview, table, saving, onCancel, onApply }) {
  const [showKeys, setShowKeys] = useState(false);
  const [showSql, setShowSql] = useState(false);
  useEffect(() => { if (preview) { setShowKeys(false); setShowSql(false); } }, [preview]);
  const keys = preview?.key_columns || [];
  const noPk = preview && !preview.has_primary_key && keys.length > 4;
  const counts = (preview?.changes || []).reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {});
  return (
    <Modal open={!!preview} onClose={onCancel} width={780} labelledBy="sf-apply-title">
      {preview && (
        <>
          <div className="flex-shrink-0 px-5 pt-4 pb-3.5 border-b border-[#e8e6e3]">
            <div className="text-[11.5px] text-[#766a63] font-mono truncate" title={table ? `${table.database}.${table.schema}` : ''}>
              {table ? `${table.database}.${table.schema}` : ''}
            </div>
            <h3 id="sf-apply-title" className="mt-0.5 font-johnson-display font-bold text-[16px] leading-snug text-[#312c2a] break-all">
              Review changes to {table?.table}
            </h3>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {Object.entries(counts).map(([k, n]) => {
                const st = KIND_STYLE[k] || KIND_STYLE.update;
                return (
                  <span key={k} className="inline-flex items-center h-6 px-2.5 rounded-full text-[12px] font-medium" style={{ color: st.color, background: st.bg }}>
                    {n} {st.label.toLowerCase()}{n === 1 ? '' : 's'}
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowKeys(v => !v)}
                className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full border border-[#e8e6e3] text-[12px] text-[#4a423e] hover:bg-[#f4f2f0]"
                aria-expanded={showKeys}
              >
                <KeyRound size={12} className="text-[#a14a00]" />
                Matched on {keys.length === 1 ? keys[0] : `${keys.length} columns`}
                <ChevronDown size={12} className={`transition-transform ${showKeys ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {showKeys && (
              <div className="mt-2.5 max-h-[110px] overflow-y-auto flex flex-wrap gap-1 p-2 rounded-md bg-[#f8f7f5] border border-[#efedea]">
                {keys.map(k => <span key={k} className="px-1.5 py-0.5 rounded bg-white border border-[#e8e6e3] text-[11px] font-mono text-[#4a423e]">{k}</span>)}
              </div>
            )}
            {noPk && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-[#a14a00]">
                This table has no primary key, so each row is found by comparing every column. That works, just slower on big tables.
              </p>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-3 bg-[#f8f7f5]">
            {preview.changes.map((c, i) => (
              <ChangeCard key={i} change={c} index={i} statement={preview.statements[i]} showSql={showSql} keys={keys} />
            ))}
          </div>

          <div className="flex-shrink-0 flex flex-wrap items-center gap-3 px-5 py-3.5 border-t border-[#e8e6e3] bg-white">
            <label className="flex items-center gap-2 text-[12.5px] text-[#4a423e] cursor-pointer select-none">
              <input type="checkbox" checked={showSql} onChange={e => setShowSql(e.target.checked)} className="accent-[var(--sig)]" />
              Show SQL
            </label>
            <span className="hidden md:inline text-[11.5px] text-[#766a63]">Runs in one transaction. If any row doesn't match exactly once, nothing is changed.</span>
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button variant="danger" onClick={onApply} disabled={saving}>{saving ? 'Applying...' : 'Apply changes'}</Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

// Object navigator, laid out like the DBeaver tree / Snowsight object browser.
// Several branches can be open at once, names get the full row width, and the
// row actions float over the right edge on hover instead of pushing the name.

const enc = encodeURIComponent;

const compact = (n) => {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-[var(--sig-mid)] text-inherit rounded-[2px] px-[1px]">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function TreeSkeleton({ depth, count = 3 }) {
  return (
    <div className="py-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 h-[28px]" style={{ paddingLeft: 12 + depth * 16 + 18 }}>
          <Skel w={14} h={14} className="rounded-[3px]" />
          <Skel w={`${70 + ((i * 37) % 70)}px`} h={9} />
        </div>
      ))}
    </div>
  );
}

function NodeNote({ depth, children, tone = 'muted', onRetry }) {
  return (
    <div
      className="flex items-center gap-2 min-h-[26px] pr-3 text-[11.5px]"
      style={{ paddingLeft: 12 + depth * 16 + 18, color: tone === 'error' ? T.maroon : T.faint }}
    >
      <span className="min-w-0 truncate" title={typeof children === 'string' ? children : undefined}>{children}</span>
      {onRetry && (
        <button onClick={onRetry} className="flex-shrink-0 inline-flex items-center gap-1 text-[#312c2a] underline underline-offset-2 hover:text-[var(--sig-ink)]">
          <RotateCcw size={11} /> Retry
        </button>
      )}
    </div>
  );
}

function NodeError({ error, depth, onRetry }) {
  if (error?.status === 403) return <NodeNote depth={depth}>No access with this role</NodeNote>;
  return <NodeNote depth={depth} tone="error" onRetry={onRetry}>{error?.message || 'Could not load'}</NodeNote>;
}

// One tree row. Indentation guides are drawn as thin left borders so deep
// trees stay readable.
function Row({
  depth, open, onToggle, icon, iconColor, label, q, meta, title,
  selected, onClick, onDoubleClick, bold, leaf, fq, actions,
}) {
  const IconCmp = icon;
  return (
    <div
      className={`group relative flex items-center h-[28px] pr-2.5 cursor-pointer select-none rounded-md mx-1.5 ${
        selected ? 'bg-[var(--sig-soft)]' : 'hover:bg-[#f4f2f0]'
      }`}
      style={{ paddingLeft: 6 + depth * 16 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
      data-fq={fq}
      role="treeitem"
      aria-expanded={leaf ? undefined : open}
      aria-selected={selected}
    >
      {selected && <span className="absolute left-0 top-[5px] bottom-[5px] w-[3px] rounded-full bg-[var(--sig)]" />}
      {leaf ? (
        <span className="w-[18px] flex-shrink-0" />
      ) : (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggle(); }}
          className="w-[18px] h-[18px] flex-shrink-0 flex items-center justify-center rounded text-[#766a63] hover:text-[#312c2a]"
          aria-label={open ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          <ChevronRight size={13} strokeWidth={2.2} className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        </button>
      )}
      <IconCmp size={14} strokeWidth={1.9} className="flex-shrink-0 mr-2" style={{ color: iconColor }} />
      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${bold ? 'font-medium text-[#312c2a]' : 'text-[#312c2a]'}`}>
        <Highlight text={label} q={q} />
      </span>
      {meta && (
        <span className={`flex-shrink-0 pl-2 text-[11px] tabular-nums text-[#766a63] ${actions ? 'group-hover:invisible group-focus-within:invisible' : ''}`}>{meta}</span>
      )}
      {actions && (
        // Quick actions on hover, over the row count so the name keeps its room.
        <span className={`absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-px pl-3 ${selected ? 'bg-[linear-gradient(90deg,transparent,var(--sig-soft)_12px)]' : 'bg-[linear-gradient(90deg,transparent,#f4f2f0_12px)]'}`}>
          {actions.map(([Ico, label, run]) => (
            <button
              key={label}
              type="button"
              title={label}
              aria-label={label}
              onClick={e => { e.stopPropagation(); run(); }}
              onDoubleClick={e => e.stopPropagation()}
              className="w-[22px] h-[22px] inline-flex items-center justify-center rounded-md text-[#6e6259] hover:bg-white hover:text-[#312c2a]"
            >
              <Ico size={13} strokeWidth={2} />
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

// A table's details, beside the work: size, its columns and its definition.
function TableDetails({ info, cq, onClose, onPreview, onInsert, onToast }) {
  const E = useEngine();
  const [cols, setCols] = useState(null);
  const [ddl, setDdl] = useState(null);
  const key = info ? `${info.database}.${info.schema}.${info.table}` : '';
  useEffect(() => {
    if (!info) return undefined;
    let live = true;
    const q = (k) => encodeURIComponent(k);
    setCols(null);
    setDdl(null);
    fetchJson(withQs(`${E.api}/columns?database=${q(info.database)}&schema=${q(info.schema)}&table=${q(info.table)}`, cq))
      .then(d => { if (live) setCols(d.columns || []); })
      .catch(err => { if (live) setCols(err); });
    fetchJson(withQs(`${E.api}/ddl?database=${q(info.database)}&schema=${q(info.schema)}&name=${q(info.table)}&kind=${info.kind}`, cq))
      .then(d => { if (live) setDdl(d.ddl || ''); })
      .catch(err => { if (live) setDdl(err); });
    return () => { live = false; };
  }, [key, cq]); // eslint-disable-line react-hooks/exhaustive-deps
  const fq = info ? `"${info.database}"."${info.schema}"."${info.table}"` : '';
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => onToast(`${what} copied`, 'success', 2000)).catch(() => {});
  const fig = (value, label) => (
    <div className="min-w-0 px-3 py-2.5 rounded-[10px] bg-[#f3f1ef]">
      <b className="block truncate font-johnson-display text-[20px] leading-tight tabular-nums text-[#312c2a]">{value}</b>
      <span className="text-[12px] text-[#6e6259]">{label}</span>
    </div>
  );
  return (
    <>
      {info && <div className="absolute inset-0 z-[47] bg-[#312c2a]/20" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`absolute inset-y-0 right-0 z-[48] w-[380px] max-w-[calc(100%-24px)] flex flex-col bg-white border-l border-[#e8e6e3] transition-transform duration-200 ${info ? 'translate-x-0 shadow-[-8px_0_32px_rgba(49,44,42,.16)]' : 'translate-x-full invisible'}`}
        aria-hidden={!info}
        aria-label="Table details"
      >
        {info && (
          <>
            <div className="flex-shrink-0 flex items-start gap-2 pl-4 pr-2 pt-3.5">
              <div className="flex-1 min-w-0">
                <h2 className="m-0 truncate font-johnson-display font-bold text-[17px] text-[#312c2a]">{info.table}</h2>
                <div className="truncate text-[12px] text-[#766a63]">{info.kind === 'VIEW' ? 'View' : 'Table'} in {info.database}.{info.schema}</div>
              </div>
              <IconButton icon={X} label="Close details" onClick={onClose} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-4">
              <div className="grid grid-cols-2 gap-2">
                {fig(info.rows != null ? fmtN(info.rows) : '-', info.kind === 'VIEW' ? 'rows (not counted for views)' : 'rows')}
                {fig(info.bytes != null ? formatBytes(info.bytes) : '-', 'on disk')}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                <Button variant="primary" icon={Play} onClick={() => onPreview(info.database, info.schema, info.table)}>Preview rows</Button>
                <Button icon={ArrowRightToLine} onClick={() => onInsert(fq)}>Insert name</Button>
                <IconButton icon={Copy} label="Copy the full name" onClick={() => copy(fq, 'Table name')} />
              </div>

              <h3 className="mt-5 mb-2 text-[12.5px] font-semibold text-[#6e6259]">
                {Array.isArray(cols) ? plural(cols.length, 'column') : 'Columns'}
              </h3>
              {cols === null && <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skel key={i} h={14} w={`${55 + ((i * 23) % 40)}%`} />)}</div>}
              {cols instanceof Error && <div className="text-[12px] text-[#9e0000]">{cols.message || 'Could not read the columns'}</div>}
              {Array.isArray(cols) && (
                <div className="rounded-[10px] border border-[#efedea] divide-y divide-[#f3f1ef]">
                  {cols.map(c => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => onInsert(c.name)}
                      title={`${c.name}\n${displayType(c)}${c.nullable === false ? ' · NOT NULL' : ''}${c.comment ? `\n${c.comment}` : ''}\nClick to insert into the editor`}
                      className="w-full flex items-center gap-2 min-w-0 h-[30px] px-2.5 text-left hover:bg-[#f7f6f4]"
                    >
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-[#312c2a]">{c.name}</span>
                      {c.is_primary_key && <span className="flex-shrink-0 px-1.5 rounded bg-[var(--sig-soft)] text-[10.5px] text-[var(--sig-ink)]">key</span>}
                      <code className="ml-auto flex-shrink-0 max-w-[45%] truncate text-[11px] text-[#766a63]">{displayType(c)}</code>
                    </button>
                  ))}
                </div>
              )}

              <h3 className="mt-5 mb-2 flex items-center text-[12.5px] font-semibold text-[#6e6259]">
                Definition
                {typeof ddl === 'string' && ddl && <IconButton icon={Copy} label="Copy the definition" size={22} iconSize={12} className="ml-auto" onClick={() => copy(ddl, 'Definition')} />}
              </h3>
              {ddl === null && <Skel h={80} className="rounded-[10px]" />}
              {ddl instanceof Error && <div className="text-[12px] text-[#9e0000]">{ddl.message || 'Could not read the definition'}</div>}
              {typeof ddl === 'string' && (
                <pre className="m-0 max-h-[320px] overflow-auto px-3 py-2.5 rounded-[10px] bg-[#f8f7f5] text-[11.5px] leading-[1.6] font-mono text-[#312c2a] whitespace-pre">
                  {ddl ? <SqlCode sql={ddl} format={false} /> : '(no definition returned)'}
                </pre>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

// Shown under the selected table so its name stays fully readable.
function ActionStrip({ depth, children }) {
  return (
    <div className="flex flex-wrap items-center gap-1 mx-1.5 mb-1 py-1 pr-2 rounded-b-md bg-[var(--sig-soft)]" style={{ paddingLeft: 6 + depth * 16 + 18 }}>
      {children}
    </div>
  );
}

const Act = ({ icon, label, onClick }) => {
  const IconCmp = icon;
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onClick(); }}
      className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-white border border-[#e8e6e3] text-[11.5px] text-[#312c2a] hover:border-[var(--sig)] hover:text-[var(--sig-ink)] transition-colors"
    >
      <IconCmp size={12} strokeWidth={2} />
      {label}
    </button>
  );
};



function SfExplorer({
  onInsert, onPreview, onEditData, onShowDdl, onCollapse, onSelect, selected,
  reveal, logInPage, canEdit = true, onToast, cq = '', onDetails,
}) {
  const E = useEngine();
  const [databases, setDatabases] = useState(null);
  const [dbError, setDbError] = useState(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const cache = useRef({ schemas: {}, tables: {}, columns: {} });
  const [, tick] = useState(0);
  const rerender = useCallback(() => tick(t => t + 1), []);
  const searchRef = useRef(null);

  const loadDatabases = useCallback((bypass = false) => {
    setDatabases(null);
    setDbError(null);
    if (bypass) {
      cache.current = { schemas: {}, tables: {}, columns: {} };
      setOpen(new Set());
      if (E.id === 'snowflake') {
        fetchJson(withQs(`${E.api}/search-tables/warm?force=true`, cq), { method: 'POST' }).catch(() => {});
      }
    }
    fetchJson(withQs(`${E.api}/databases${bypass ? '?bypass_cache=true' : ''}`, cq))
      .then(data => setDatabases(data.databases || []))
      .catch(err => setDbError(err));
  }, []);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);

  const load = useCallback((bucket, key, url, pick, force = false) => {
    const store = cache.current[bucket];
    if (!force && store[key] !== undefined && !(store[key] instanceof Error)) return;
    store[key] = 'loading';
    rerender();
    fetchJson(url)
      .then(data => { store[key] = pick(data); rerender(); })
      .catch(err => { store[key] = err; rerender(); });
  }, [rerender]);

  const loadSchemas = useCallback((db, force) => load('schemas', db, withQs(`${E.api}/schemas?database=${enc(db)}`, cq), d => d.schemas || [], force), [load]);
  const loadTables = useCallback((db, schema, force) => load('tables', `${db}.${schema}`,
    withQs(`${E.api}/tables?database=${enc(db)}&schema=${enc(schema)}`, cq), d => d.tables || [], force), [load]);
  const loadColumns = useCallback((db, schema, table, force) => load('columns', `${db}.${schema}.${table}`,
    withQs(`${E.api}/columns?database=${enc(db)}&schema=${enc(schema)}&table=${enc(table)}`, cq), d => d.columns || [], force), [load]);

  const toggle = (key, onOpen) => {
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else { next.add(key); onOpen?.(); }
      return next;
    });
  };

  // Deep links open straight to a table, so walk the tree down to it.
  useEffect(() => {
    if (!reveal?.database || !databases) return;
    const keys = [`d:${reveal.database}`];
    loadSchemas(reveal.database);
    if (reveal.schema) {
      keys.push(`s:${reveal.database}.${reveal.schema}`);
      loadTables(reveal.database, reveal.schema);
    }
    setOpen(prev => {
      if (keys.every(k => prev.has(k))) return prev;
      const next = new Set(prev);
      keys.forEach(k => next.add(k));
      return next;
    });
  }, [reveal?.database, reveal?.schema, databases, loadSchemas, loadTables]);

  const copyName = async (fq) => {
    try {
      await navigator.clipboard.writeText(fq);
      onToast?.(`Copied ${fq}`, 'success', 2200);
    } catch { /* no clipboard */ }
  };

  const q = search.trim();
  const hit = (name) => !q || name.toLowerCase().includes(q.toLowerCase());

  const tablesOf = (db, schema) => cache.current.tables[`${db}.${schema}`];
  const schemaHasHit = (db, schema) => {
    const t = tablesOf(db, schema);
    return Array.isArray(t) && t.some(x => hit(x.name));
  };
  const dbHasHit = (db) => {
    const s = cache.current.schemas[db];
    return Array.isArray(s) && s.some(sc => hit(sc) || schemaHasHit(db, sc));
  };
  const visibleDbs = (databases || []).filter(db => hit(db) || dbHasHit(db));

  // Search every database for table names, not just what's expanded.
  // Runs on its own only when the loaded tree has nothing. If the tree
  // already has hits, the user has to ask for it with the button.
  const [askedFind, setAskedFind] = useState('');
  const canFind = true;
  const hasLocal = !!q && visibleDbs.length > 0;
  const findOn = canFind && q.length >= 2 && (!hasLocal || askedFind === q.toLowerCase());
  const [found, setFound] = useState(null);
  const [findBusy, setFindBusy] = useState(false);
  const [findErr, setFindErr] = useState(null);
  const findCache = useRef(new Map());
  const lastFound = useRef({ q: '', data: null });

  // build the server side name index as soon as the explorer opens,
  // so the first search doesn't wait on Snowflake
  useEffect(() => {
    if (!canFind) return;
    fetchJson(withQs(`${E.api}/search-tables/warm`, cq), { method: 'POST' }).catch(() => {});
  }, [canFind, cq]);

  useEffect(() => {
    if (!findOn) { setFound(null); setFindErr(null); setFindBusy(false); return; }
    const key = q.toLowerCase();

    // seen this exact query, show it straight away
    const hitCache = findCache.current.get(key);
    if (hitCache) { setFound(hitCache); setFindErr(null); setFindBusy(false); return; }

    // still typing the same word: narrow the last results locally while the server answers
    const prev = lastFound.current;
    if (prev.data && key.startsWith(prev.q) && prev.data.total <= prev.data.results.length) {
      const words = key.split(/[^a-z0-9]+/).filter(Boolean);
      const narrowed = prev.data.results.filter(r => words.every(w => r.name.toLowerCase().includes(w)));
      setFound({ ...prev.data, results: narrowed, total: narrowed.length });
    }

    const ctrl = new AbortController();
    setFindBusy(true);
    const t = setTimeout(() => {
      fetchJson(withQs(`${E.api}/search-tables?q=${enc(q)}`, cq), { signal: ctrl.signal })
        .then(d => {
          findCache.current.set(key, d);
          if (findCache.current.size > 100) findCache.current.delete(findCache.current.keys().next().value);
          lastFound.current = { q: key, data: d };
          setFound(d);
          setFindErr(null);
          setFindBusy(false);
        })
        .catch(err => {
          if (err?.name === 'AbortError') return;
          setFound(null);
          setFindErr(err);
          setFindBusy(false);
        });
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, findOn, cq]);

  // refresh button should also drop cached search results
  useEffect(() => { findCache.current.clear(); lastFound.current = { q: '', data: null }; }, [databases]);

  // After a search hit is opened, wait for its schema to load and the row
  // to render, then scroll the tree so the row sits in the middle.
  const treeRef = useRef(null);
  const scrollTo = useRef(null);
  const scrollToFq = useCallback((fq) => {
    clearInterval(scrollTo.current);
    const started = Date.now();
    const tryScroll = () => {
      const box = treeRef.current;
      const el = box?.querySelector(`[data-fq="${CSS.escape(fq)}"]`);
      if (!el) {
        if (Date.now() - started > 10000) clearInterval(scrollTo.current);
        return;
      }
      clearInterval(scrollTo.current);
      // wait a frame so the search panel above has collapsed and the height is final
      requestAnimationFrame(() => {
        const b = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const target = box.scrollTop + (r.top - b.top) - (box.clientHeight / 2) + (r.height / 2);
        box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      });
    };
    scrollTo.current = setInterval(tryScroll, 100);
    tryScroll();
  }, []);
  useEffect(() => () => clearInterval(scrollTo.current), []);

  // jump to a search hit in the tree and select it
  const openHit = (r) => {
    loadSchemas(r.database);
    loadTables(r.database, r.schema);
    setOpen(prev => {
      const next = new Set(prev);
      next.add(`d:${r.database}`);
      next.add(`s:${r.database}.${r.schema}`);
      return next;
    });
    const isView = r.kind === 'view' || r.kind === 'materialized_view';
    onSelect?.({ kind: isView ? 'view' : 'table', fq: `${r.database}.${r.schema}.${r.name}`, database: r.database, schema: r.schema, table: r.name });
    setSearch('');
    scrollToFq(`${r.database}.${r.schema}.${r.name}`);
    logInPage?.(`${E.log}_explorer_search_open`, `Opened search hit "${r.database}.${r.schema}.${r.name}"`);
  };

  const isSel = (kind, fq) => selected && selected.kind === kind && selected.fq === fq;


  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      <div className="flex-shrink-0 flex items-center gap-2 h-[44px] pl-4 pr-2 border-b border-[#e8e6e3]">
        <Database size={15} strokeWidth={2} className="text-[var(--sig-ink)] flex-shrink-0" />
        <span className="text-[13px] font-bold text-[#312c2a] truncate">Databases</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={RefreshCw} label="Refresh objects" onClick={() => loadDatabases(true)} />
          {onCollapse && <IconButton icon={PanelLeftClose} label="Hide explorer" onClick={onCollapse} />}
        </div>
      </div>

      <div className="flex-shrink-0 px-3 py-2.5">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-[#d5cfc9] bg-white focus-within:border-[var(--sig)] focus-within:ring-2 focus-within:ring-[var(--sig-ring)] transition">
          <Search size={14} className="flex-shrink-0 text-[#766a63]" />
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setSearch(''); }}
            placeholder="Filter databases, schemas, tables"
            aria-label="Filter objects"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] text-[#312c2a] placeholder-[#766a63] focus:outline-none"
          />
          {search && (
            <button onClick={() => { setSearch(''); searchRef.current?.focus(); }} className="p-0.5 rounded text-[#766a63] hover:text-[#312c2a]" aria-label="Clear filter">
              <X size={13} />
            </button>
          )}
        </div>
        {q && !canFind && <div className="mt-1.5 px-0.5 text-[11px] text-[#766a63]">Filters objects already loaded. Expand a schema to search its tables.</div>}
      </div>

      {canFind && q.length >= 2 && !findOn && (
        <div className="flex-shrink-0 px-3 pb-2 border-b border-[#e8e6e3]">
          <button
            onClick={() => setAskedFind(q.toLowerCase())}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-[#312c2a] hover:bg-[#f4f2f0]"
          >
            <Search size={12} className="flex-shrink-0 text-[#766a63]" />
            <span className="truncate">Search all databases for "{q}"</span>
          </button>
        </div>
      )}

      {findOn && (
        <div className="flex-shrink-0 max-h-[45%] overflow-y-auto border-b border-[#e8e6e3] pb-2">
          <div className="flex items-center gap-1.5 px-4 pb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#766a63]">
            <span>All databases</span>
            {findBusy && <Loader2 size={11} className="animate-spin" />}
            {found && !findBusy && <span className="ml-auto normal-case tracking-normal font-normal">{found.total} match{found.total === 1 ? '' : 'es'}</span>}
          </div>
          {findErr && <NodeNote depth={0} tone="error">Search failed: {findErr.message || String(findErr)}</NodeNote>}
          {found && found.results.length === 0 && !findBusy && <NodeNote depth={0}>No tables named like "{q}".</NodeNote>}
          {found && found.results.map(r => {
            const isView = r.kind === 'view' || r.kind === 'materialized_view';
            const IconCmp = isView ? Eye : Table2;
            const fq = `${r.database}.${r.schema}.${r.name}`;
            return (
              <div
                key={fq}
                onClick={() => openHit(r)}
                onDoubleClick={() => onPreview(r.database, r.schema, r.name)}
                title={`${fq}\nClick to open in the tree, double-click to preview`}
                className="flex items-center gap-2 mx-1.5 px-2.5 py-1 rounded-md cursor-pointer hover:bg-[#f4f2f0]"
              >
                <IconCmp size={13} className="flex-shrink-0" style={{ color: isView ? T.blue : 'var(--sig-ink)' }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-[#312c2a]">{r.name}</div>
                  <div className="truncate text-[10.5px] font-mono text-[#766a63]">{r.database}.{r.schema}</div>
                </div>
                {r.est_rows != null && <span className="flex-shrink-0 text-[10.5px] text-[#766a63]">{compact(r.est_rows)}</span>}
              </div>
            );
          })}
          {found && found.total > found.results.length && (
            <div className="px-4 pt-1 text-[11px] text-[#766a63]">Showing top {found.results.length}. Type more to narrow it down.</div>
          )}
        </div>
      )}

      <div ref={treeRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-3" role="tree" aria-label={`${E.label} objects`}>
        {databases === null && !dbError && <TreeSkeleton depth={0} count={7} />}
        {dbError && <NodeError error={dbError} depth={0} onRetry={() => loadDatabases(true)} />}
        {databases && databases.length === 0 && <NodeNote depth={0}>No databases visible to this role.</NodeNote>}

        {visibleDbs.map(db => {
          const dKey = `d:${db}`;
          const dOpen = open.has(dKey) || (!!q && dbHasHit(db) && !hit(db));
          const schemas = cache.current.schemas[db];
          return (
            <div key={db}>
              <Row
                depth={0}
                open={dOpen}
                onToggle={() => toggle(dKey, () => { loadSchemas(db); logInPage?.(`${E.log}_explorer_expand`, `Expanded ${E.label} database "${db}"`); })}
                onClick={() => { onSelect?.({ kind: 'database', fq: db, database: db }); toggle(dKey, () => loadSchemas(db)); }}
                icon={Database}
                iconColor={T.muted}
                label={db}
                q={q}
                bold
                title={db}
                selected={isSel('database', db)}
                meta={Array.isArray(schemas) ? String(schemas.length) : null}
              />
              {dOpen && (
                <div>
                  {schemas === 'loading' && <TreeSkeleton depth={1} count={3} />}
                  {schemas instanceof Error && <NodeError error={schemas} depth={1} onRetry={() => loadSchemas(db, true)} />}
                  {Array.isArray(schemas) && schemas.length === 0 && <NodeNote depth={1}>No schemas</NodeNote>}
                  {Array.isArray(schemas) && schemas.filter(sc => !q || hit(db) || hit(sc) || schemaHasHit(db, sc)).map(schema => {
                    const sFq = `${db}.${schema}`;
                    const sKey = `s:${sFq}`;
                    const sOpen = open.has(sKey) || (!!q && schemaHasHit(db, schema) && !hit(schema));
                    const tables = tablesOf(db, schema);
                    const shownTables = Array.isArray(tables)
                      ? tables.filter(t => !q || hit(t.name) || hit(schema) || hit(db))
                      : tables;
                    return (
                      <div key={schema}>
                        <Row
                          depth={1}
                          open={sOpen}
                          onToggle={() => toggle(sKey, () => { loadTables(db, schema); logInPage?.(`${E.log}_explorer_expand`, `Expanded ${E.label} schema "${sFq}"`); })}
                          onClick={() => { onSelect?.({ kind: 'schema', fq: sFq, database: db, schema }); toggle(sKey, () => loadTables(db, schema)); }}
                          icon={Layers}
                          iconColor={T.muted}
                          label={schema}
                          q={q}
                          title={sFq}
                          selected={isSel('schema', sFq)}
                          meta={Array.isArray(tables) ? String(tables.length) : null}
                        />
                        {sOpen && (
                          <div>
                            {tables === 'loading' && <TreeSkeleton depth={2} count={4} />}
                            {tables instanceof Error && <NodeError error={tables} depth={2} onRetry={() => loadTables(db, schema, true)} />}
                            {Array.isArray(tables) && tables.length === 0 && <NodeNote depth={2}>No tables or views</NodeNote>}
                            {Array.isArray(shownTables) && shownTables.map(t => {
                              const tFq = `${sFq}.${t.name}`;
                              const tKey = `t:${tFq}`;
                              const tOpen = open.has(tKey);
                              const isView = t.kind === 'view' || t.kind === 'materialized_view';
                              const cols = cache.current.columns[tFq];
                              const size = t.size_bytes != null ? ` · ${formatBytes(t.size_bytes)}` : '';
                              const rows = t.est_rows != null ? ` · ~${t.est_rows.toLocaleString()} rows` : '';
                              const select = () => onSelect?.({ kind: isView ? 'view' : 'table', fq: tFq, database: db, schema, table: t.name });
                              const details = () => { select(); onDetails?.({ database: db, schema, table: t.name, kind: isView ? 'VIEW' : 'TABLE', rows: t.est_rows ?? t.row_count ?? null, bytes: t.size_bytes ?? null }); };
                              return (
                                <div key={t.name}>
                                  <Row
                                    depth={2}
                                    open={tOpen}
                                    onToggle={() => toggle(tKey, () => loadColumns(db, schema, t.name))}
                                    onClick={select}
                                    onDoubleClick={() => onPreview(db, schema, t.name)}
                                    icon={isView ? Eye : Table2}
                                    iconColor={isView ? T.blue : 'var(--sig-ink)'}
                                    label={t.name}
                                    q={q}
                                    title={`${tFq}\n${isView ? 'View' : 'Table'}${rows}${size}\nClick to select, double-click to preview`}
                                    selected={isSel(isView ? 'view' : 'table', tFq)}
                                    meta={compact(t.est_rows)}
                                    fq={tFq}
                                    actions={[
                                      [Eye, 'Preview the first rows', () => onPreview(db, schema, t.name)],
                                      [ArrowRightToLine, 'Insert the full name into the editor', () => onInsert(`"${db}"."${schema}"."${t.name}"`)],
                                      [Info, 'Details', details],
                                    ]}
                                  />
                                  {isSel(isView ? 'view' : 'table', tFq) && (
                                    <ActionStrip depth={2}>
                                      <Act icon={Play} label="Preview" onClick={() => onPreview(db, schema, t.name)} />
                                      {!isView && canEdit && <Act icon={Pencil} label="Edit data" onClick={() => onEditData(db, schema, t.name)} />}
                                      <Act icon={Info} label="Details" onClick={details} />
                                      <Act icon={Code2} label="DDL" onClick={() => onShowDdl(db, schema, t.name, isView ? 'VIEW' : 'TABLE')} />
                                      <Act icon={Copy} label="Copy name" onClick={() => copyName(`"${db}"."${schema}"."${t.name}"`)} />
                                    </ActionStrip>
                                  )}
                                  {tOpen && (
                                    <div>
                                      {cols === 'loading' && <TreeSkeleton depth={3} count={4} />}
                                      {cols instanceof Error && <NodeError error={cols} depth={3} onRetry={() => loadColumns(db, schema, t.name, true)} />}
                                      {Array.isArray(cols) && cols.map(col => (
                                        <div
                                          key={col.name}
                                          onClick={() => onInsert(col.name)}
                                          title={`${col.name}\n${displayType(col)}${col.nullable ? '' : ' · NOT NULL'}${col.is_primary_key ? ' · primary key' : ''}${col.comment ? `\n${col.comment}` : ''}\nClick to insert into the editor`}
                                          className="group flex items-center gap-2 h-[26px] mx-1.5 pr-2.5 rounded-md cursor-pointer hover:bg-[#f4f2f0]"
                                          style={{ paddingLeft: 6 + 3 * 16 + 18 }}
                                        >
                                          {col.is_primary_key
                                            ? <KeyRound size={12} className="flex-shrink-0 text-[#a14a00]" />
                                            : <span className="w-[12px] flex-shrink-0 text-center text-[10px] font-mono text-[#766a63]">{colGlyph(displayType(col))}</span>}
                                          <span className="min-w-0 flex-1 truncate text-[12px] text-[#4a423e]">{col.name}</span>
                                          <span className="flex-shrink-0 max-w-[50%] truncate text-[10.5px] font-mono text-[#766a63]" title={displayType(col)}>{displayType(col)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {databases && databases.length > 0 && (
        <div className="flex-shrink-0 px-4 py-2 border-t border-[#e8e6e3] bg-[#f8f7f5] text-[11px] text-[#766a63]">
          {selected?.fq ? (
            <>
              <div className="uppercase tracking-[.08em] font-bold text-[10px]">{selected.kind}</div>
              <div className="mt-0.5 font-mono text-[11.5px] leading-snug text-[#312c2a] break-all line-clamp-3" title={selected.fq}>{selected.fq}</div>
            </>
          ) : (
            <>{databases.length} database{databases.length === 1 ? '' : 's'} · double-click a table to preview</>
          )}
        </div>
      )}
    </div>
  );
}

// Result grid modelled on the DBeaver data editor: row numbers, sticky
// header, type under each column name, right aligned numbers, NULL shown as
// a quiet badge, click to select a cell and Ctrl/Cmd+C to copy it.

const ROW_H = 28;
const HEAD_H = 66;   // name, type and a small chart of the values
const HEAD_H_SLIM = 46;   // name and type only

// What the header chart draws for one column of the rows on screen.
function sparkOf(rows, i, family) {
  if (!rows.length) return null;
  if (family === 'num' || family === 'time') {
    const vals = [];
    for (const r of rows) {
      const v = r[i];
      if (v == null || typeof v === 'object') continue;
      if (family === 'num') { const n = Number(v); if (Number.isFinite(n)) vals.push(n); }
      else { const m = /^(\d{4})-(\d{2})/.exec(String(v)); if (m) vals.push(+m[1] * 12 + +m[2]); }
    }
    if (vals.length < 2) return null;
    let lo = Infinity, hi = -Infinity;
    vals.forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
    // One value all the way down: a flat bar says that better than one spike.
    if (lo === hi) return { kind: 'many' };
    const bins = Array(16).fill(0);
    vals.forEach(v => { bins[Math.min(15, Math.floor((v - lo) / ((hi - lo) || 1) * 16))]++; });
    return { kind: 'bins', bins };
  }
  if (family === 'text' || family === 'bool') {
    const counts = new Map();
    for (const r of rows) { const v = r[i]; const k = v == null ? '\u0000' : typeof v === 'object' ? '\u0001' : String(v); counts.set(k, (counts.get(k) || 0) + 1); }
    if (counts.size > 30) return { kind: 'many' };
    return { kind: 'shares', shares: [...counts.values()].sort((a, b) => b - a).slice(0, 6).map(n => n / rows.length) };
  }
  return null;
}

function MiniSpark({ data, accent }) {
  if (!data) return <span className="block h-[14px]" />;
  if (data.kind === 'many') return <span className="block h-[14px] pt-[8px]"><span className="block h-[4px] rounded-full" style={{ background: accent, opacity: 0.22 }} /></span>;
  if (data.kind === 'shares') {
    return (
      <span className="flex h-[14px] items-end gap-[2px]" aria-hidden="true">
        {data.shares.map((f, k) => <span key={k} className="h-[6px] rounded-[2px]" style={{ width: `${f * 100}%`, background: accent, opacity: 0.9 - k * 0.13 }} />)}
      </span>
    );
  }
  const mx = Math.max(...data.bins);
  return (
    <span className="flex h-[14px] items-end gap-[1.5px]" aria-hidden="true">
      {data.bins.map((n, k) => <span key={k} className="flex-1 rounded-t-[1.5px]" style={{ height: `${Math.max(8, n / mx * 100)}%`, background: accent, opacity: n ? 0.6 : 0.15 }} />)}
    </span>
  );
}
const FONT = '12.5px JohnsonText, Arial, sans-serif';

let measureCtx = null;
const textWidth = (s, font = FONT) => {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
  }
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
};

// First guess at a column width from its header and the first rows, so names
// and values are readable without dragging every column open.
function fitWidth(name, type, rows, colIndex, cap = 380, pad = 28) {
  let w = Math.max(textWidth(name, `600 ${FONT}`) + 62, textWidth(type || '', '10.5px monospace') + 72);
  const sample = Math.min(rows.length, 60);
  for (let r = 0; r < sample; r += 1) {
    const v = rows[r]?.[colIndex];
    const s = v === null || v === undefined ? 'NULL' : (cellText(v) || '').slice(0, 90);
    w = Math.max(w, textWidth(s) + pad);
    if (w >= cap) break;
  }
  return Math.round(Math.max(96, Math.min(cap, w)));
}

// A popup that can't be cut off: it renders on <body>, fixed next to the
// element it opens from (the parent of where it's placed), opens upward when
// there's more room above, and never gets taller than the room it has.
function Floating({ align = 'left', className = '', style, boxRef, children, ...rest }) {
  const E = useEngine();
  const spot = useRef(null);
  const box = useRef(null);
  const [pos, setPos] = useState(null);
  const setBox = useCallback((el) => { box.current = el; if (boxRef) boxRef.current = el; }, [boxRef]);
  const place = useCallback(() => {
    const a = spot.current?.parentElement?.getBoundingClientRect();
    const b = box.current;
    if (!a || !b) return;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 4, edge = 8;
    const w = b.offsetWidth;
    const below = vh - a.bottom - gap - edge, above = a.top - gap - edge;
    const up = b.scrollHeight > below && above > below;
    const left = Math.round(Math.max(edge, Math.min(align === 'right' ? a.right - w : a.left, vw - edge - w)));
    const next = up
      ? { left, top: 'auto', bottom: Math.round(vh - a.top + gap), maxHeight: Math.floor(above) }
      : { left, top: Math.round(a.bottom + gap), bottom: 'auto', maxHeight: Math.floor(below) };
    setPos(p => (p && p.left === next.left && p.top === next.top && p.bottom === next.bottom && p.maxHeight === next.maxHeight ? p : next));
  }, [align]);
  // Content can change size (values arriving), so check after every render; it only sets state when something moved.
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [place]);
  return (
    <>
      <span ref={spot} hidden />
      {createPortal(
        <div
          ref={setBox}
          {...rest}
          style={{ ...sigVars(E), position: 'fixed', zIndex: 1000, overflowY: 'auto', ...(pos || { left: 0, top: 0, visibility: 'hidden' }), ...style }}
          className={`ds-pop ${className}`}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

function FilterPopover({ column: fixedColumn, columns, current, onApply, onClear, onClose, alignRight }) {
  // Opened from the filter bar it starts with a column to pick; from a header it knows its column.
  const [column, setColumn] = useState(fixedColumn || columns?.[0] || '');
  const [op, setOp] = useState(current?.op || 'contains');
  const [value, setValue] = useState(current?.values ? current.values.join('\n') : (current?.value ?? ''));
  const spec = FILTER_OPS.find(f => f.id === op);
  const isList = op === 'in' || op === 'not_in';

  const apply = () => {
    if (!spec.needsValue) { onApply({ col: column, op }); return; }
    if (isList) {
      const values = value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
      if (values.length) onApply({ col: column, op, values });
      return;
    }
    onApply({ col: column, op, value });
  };

  const field = 'w-full rounded-md border border-[#d5cfc9] bg-white px-2.5 text-[12.5px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] focus:ring-2 focus:ring-[var(--sig-ring)]';

  return (
    <Floating
      align={alignRight ? 'right' : 'left'}
      className="w-[260px] bg-white border border-[#e8e6e3] rounded-lg shadow-[0_12px_32px_rgba(49,44,42,.18)] p-3 font-johnson-text text-[#312c2a]"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-2">
        <Filter size={13} className="text-[var(--sig-ink)]" />
        <div className="text-[12px] font-bold text-[#312c2a] truncate flex-1" title={column}>{columns ? 'Add a filter' : column}</div>
        <button onClick={onClose} className="p-0.5 rounded text-[#766a63] hover:bg-[#f1efed]" aria-label="Close"><X size={13} /></button>
      </div>
      {columns && (
        <select value={column} onChange={e => setColumn(e.target.value)} aria-label="Column" title={column} className={`${field} h-8 mb-2 truncate`}>
          {columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <select value={op} onChange={e => setOp(e.target.value)} className={`${field} h-8 mb-2`}>
        {FILTER_OPS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      {spec.needsValue && (isList ? (
        <textarea autoFocus rows={4} value={value} onChange={e => setValue(e.target.value)} placeholder="One value per line" className={`${field} py-2 font-mono resize-none`} />
      ) : (
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') onClose(); }}
          placeholder="Value"
          className={`${field} h-8 font-mono`}
        />
      ))}
      <div className="flex items-center justify-between mt-3">
        <button onClick={onClear} disabled={!current} className="text-[12px] text-[#6e6259] hover:text-[#9e0000] disabled:opacity-40">Remove filter</button>
        <Button size="sm" variant="primary" onClick={apply}>Apply</Button>
      </div>
    </Floating>
  );
}

// + Filter: pick a column, then one of its most common values, or empty /
// not empty, or any other condition.
function FilterMenu({ columns, fetchValues, onAdd, onClose }) {
  const [col, setCol] = useState(null);
  const [q, setQ] = useState('');
  const [vals, setVals] = useState(null);      // null loading | Error | { values, more, scope }
  const [advanced, setAdvanced] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    const away = (e) => { if (!boxRef.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [onClose]);
  const [vq, setVq] = useState('');
  useEffect(() => { setVq(''); }, [col]);
  useEffect(() => {
    if (!col) return undefined;
    let live = true;
    setVals(null);
    // Typing waits a beat before asking the server again.
    const t = setTimeout(() => {
      fetchValues(col, vq.trim()).then(d => { if (live) setVals(d); }).catch(err => { if (live) setVals(err instanceof Error ? err : new Error(String(err))); });
    }, vq ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [col, vq]); // eslint-disable-line react-hooks/exhaustive-deps
  // A key column: every value shows up once, so counts don't help, search does.
  const unique = Boolean(vals && !(vals instanceof Error) && vals.values.length > 1 && vals.values.every(v => v.count === 1));
  const pick = (f) => { onAdd(f); onClose(); };
  const label = (v) => (typeof v === 'string' ? v.replace(ISO_STAMP, '$1 $2') : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const shown = columns.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const item = 'w-full flex items-center gap-2 min-w-0 h-[30px] px-2.5 rounded-[7px] text-left text-[12.5px] text-[#312c2a] hover:bg-[#f3f1ef]';

  if (advanced) {
    return (
      <FilterPopover column={col} onApply={pick} onClear={onClose} onClose={onClose} alignRight />
    );
  }
  return (
    <Floating boxRef={boxRef} align="right" className="flex flex-col [&>*]:flex-shrink-0 w-[260px] rounded-[12px] border border-[#e8e6e3] bg-white p-1.5 shadow-[0_12px_32px_rgba(49,44,42,.16)] font-johnson-text">
      {!col ? (
        <>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && shown[0]) setCol(shown[0].name); }}
            placeholder="Filter on a column"
            aria-label="Find a column"
            className="w-full h-[28px] mb-1 px-2.5 rounded-[7px] border border-[#e8e6e3] bg-[#fbfaf9] text-[12.5px] focus:outline-none focus:border-[var(--sig)] focus:bg-white"
          />
          {/* Lists shrink first on a short screen, so the choices under them stay in view. */}
          <div className="!flex-shrink min-h-[64px] max-h-[300px] overflow-y-auto">
            {shown.map(c => (
              <button key={c.name} type="button" onClick={() => setCol(c.name)} className={item}>
                <span className="w-[14px] flex-shrink-0 text-center text-[10.5px] font-mono text-[#a39992]">{colGlyph(c.type)}</span>
                <span className="min-w-0 truncate">{c.name}</span>
              </button>
            ))}
            {!shown.length && <div className="px-2.5 py-2 text-[12px] text-[#a39992]">No column matches</div>}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1 min-w-0 px-1 pt-0.5 pb-1">
            <button type="button" onClick={() => setCol(null)} aria-label="Pick another column" title="Pick another column" className="flex-shrink-0 w-[22px] h-[22px] inline-flex items-center justify-center rounded-md text-[#766a63] hover:bg-[#f3f1ef]">
              <ChevronLeft size={13} />
            </button>
            <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-[#a39992]">{col} is</span>
          </div>
          <input
            autoFocus
            value={vq}
            onChange={e => setVq(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && vq.trim()) pick({ col, op: 'contains', value: vq.trim() }); }}
            placeholder="Search values"
            aria-label={`Search the values of ${col}`}
            className="w-full h-[28px] mb-1 px-2.5 rounded-[7px] border border-[#e8e6e3] bg-[#fbfaf9] text-[12.5px] focus:outline-none focus:border-[var(--sig)] focus:bg-white"
          />
          <div className="!flex-shrink min-h-[64px] max-h-[240px] overflow-y-auto">
            {vq.trim() && (
              <button type="button" onClick={() => pick({ col, op: 'contains', value: vq.trim() })} className={`${item} text-[var(--sig-ink)]`}>
                <span className="min-w-0 truncate">Contains "{vq.trim()}"</span>
              </button>
            )}
            {vals === null && <div className="space-y-1.5 px-2.5 py-1.5">{Array.from({ length: 5 }).map((_, i) => <Skel key={i} h={14} w={`${50 + ((i * 17) % 40)}%`} />)}</div>}
            {vals instanceof Error && <div className="px-2.5 py-1.5 text-[12px] text-[#766a63]">{vals.message || "Can't list this column's values"}</div>}
            {vals && !(vals instanceof Error) && vals.values.map(({ value, count }) => (
              <button key={label(value)} type="button" onClick={() => pick({ col, op: 'eq', value: String(value) })} className={`${item} justify-between`}>
                <span className="min-w-0 truncate">{label(value)}</span>
                <span className="flex-shrink-0 tabular-nums text-[12px] text-[#a39992]">{fmtN(count)}</span>
              </button>
            ))}
            {vals && !(vals instanceof Error) && !vals.values.length && <div className="px-2.5 py-1.5 text-[12px] text-[#a39992]">{vq.trim() ? 'No value contains that' : 'Only empty values here'}</div>}
          </div>
          {vals && !(vals instanceof Error) && vals.values.length > 0 && (vals.more || vals.scope === 'page') && (
            <div className="px-2.5 pt-0.5 text-[11px] text-[#a39992]">
              {unique ? 'Every value is different here. Search to find one.' : vals.scope === 'page' ? 'Counted on the rows on screen' : vq.trim() ? `The ${vals.values.length} most common matches` : `The ${vals.values.length} most common`}
            </div>
          )}
          <div className="my-1.5 h-px bg-[#efedea]" />
          <button type="button" onClick={() => pick({ col, op: 'is_null' })} className={item}>Is empty</button>
          <button type="button" onClick={() => pick({ col, op: 'is_not_null' })} className={item}>Is not empty</button>
          <button type="button" onClick={() => setAdvanced(true)} className={`${item} text-[var(--sig-ink)]`}>More conditions...</button>
        </>
      )}
    </Floating>
  );
}

// The header's Filter button and its menu.
function FilterButton({ columns, fetchValues, onAdd, count, compact }) {
  const [adding, setAdding] = useState(false);
  const closeAdding = useCallback(() => setAdding(false), []);
  return (
    <span className="relative">
      <Button
        size="sm"
        icon={Filter}
        onMouseDown={e => { if (adding) e.stopPropagation(); }}
        onClick={() => setAdding(a => !a)}
        aria-expanded={adding}
        aria-label="Filter"
        title="Filter the rows"
        className={adding || count ? '!border-[var(--sig)] !text-[var(--sig-ink)]' : ''}
      >
        <span className={compact ? 'hidden' : 'hidden sm:inline'}>Filter</span>
        {count > 0 && <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--sig)] text-white text-[10px] leading-[15px] tabular-nums">{count}</span>}
      </Button>
      {adding && <FilterMenu columns={columns} fetchValues={fetchValues} onAdd={onAdd} onClose={closeAdding} />}
    </span>
  );
}

// Active filters as chips, shown only once there are some.
function FilterBar({ filters, onRemove, onClear }) {
  const opLabel = (id) => FILTER_OPS.find(f => f.id === id)?.label || id;
  const shown = (f) => (f.values ? f.values.join(', ') : f.value);
  return (
    <div className="relative z-[25] flex-shrink-0 flex flex-wrap items-center gap-1.5 min-w-0 px-2 py-1.5 border-b border-[#efedea]">
      {filters.map(f => (
        <span key={f.col} className="flex-shrink-0 inline-flex items-center gap-1.5 max-w-[320px] h-[24px] pl-2.5 pr-1 rounded-[7px] bg-[var(--sig-soft)] text-[12px] text-[var(--sig-ink)]">
          <span className="truncate">
            {f.col} {opLabel(f.op)}{shown(f) != null && shown(f) !== '' && <> <b className="font-semibold">{shown(f)}</b></>}
          </span>
          <button type="button" onClick={() => onRemove(f.col)} aria-label={`Remove the filter on ${f.col}`} title="Remove this filter" className="flex-shrink-0 w-[18px] h-[18px] inline-flex items-center justify-center rounded-[5px] hover:bg-black/[.08]">
            <X size={11} />
          </button>
        </span>
      ))}
      <button type="button" onClick={onClear} className="flex-shrink-0 h-[24px] px-2.5 rounded-[7px] border border-[#e8e6e3] text-[12px] text-[#6e6259] hover:text-[#312c2a] hover:border-[#cbc4bc]">Clear all</button>
    </div>
  );
}

// 2026-11-17T13:51:17.682741-05:00 reads better with a space, the way psql and Snowsight show it.
const ISO_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

const isBig = (v) => Boolean(v && typeof v === 'object' && v.$truncated);

function CellValue({ value, numeric }) {
  if (typeof value === 'string' && ISO_STAMP.test(value)) return <span className="tabular-nums">{value.replace('T', ' ')}</span>;
  if (isBig(value)) {
    return (
      <span className="inline-flex items-center gap-1.5 max-w-full" title="Too large to show here. Download the result to get the whole value.">
        <span className="flex-shrink-0 px-1.5 rounded bg-[#f1efed] text-[10.5px] font-medium text-[#6e6259]">{formatBytes(value.size)}</span>
        <span className="truncate font-mono text-[12px] text-[#6e6259]">{value.preview.slice(0, 200)}</span>
      </span>
    );
  }
  if (value === null || value === undefined) {
    return <span className="inline-block px-1.5 rounded bg-[#f1efed] text-[10.5px] font-medium tracking-wide text-[#766a63]">NULL</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-[#328714] font-medium' : 'text-[#766a63]'}>{String(value).toUpperCase()}</span>;
  }
  if (typeof value === 'object') {
    return <span className="font-mono text-[12px] text-[#4a423e]">{cellText(value)}</span>;
  }
  return <span className={numeric ? 'tabular-nums' : undefined}>{String(value)}</span>;
}

// Typing in the editor re-renders the pane on every key. The grid only has
// to repaint when its data does, so it is memoized, and its callbacks are
// passed through a ref so they are always the latest ones anyway.
const NO_META = {};
const NO_ROWS = [];
const GRID_FNS = ['setWidths', 'onSort', 'onFilter', 'onEditCell', 'onToggleDelete', 'onEditNewCell', 'onRemoveNewRow', 'onOpenCell', 'onCopied', 'onRowSelect', 'onCopyRow', 'onSelection'];

function SfGrid(props) {
  const latest = useRef(props);
  latest.current = props;
  const fns = useMemo(() => Object.fromEntries(GRID_FNS.map(k => [k, (...a) => latest.current[k]?.(...a)])), []);
  return <SfGridView {...props} {...fns} />;
}

// Which cell an event in the grid body landed on, from its data-cell="r:c".
const cellAt = (e) => {
  const td = e.target.closest?.('td[data-cell]');
  if (!td) return null;
  const [r, c] = td.dataset.cell.split(':').map(Number);
  return { r, c };
};
const NO_EDITS = {};
const CELL_BASE = 'border-b border-r border-[#efedea]';

// One grid row. Memoized so moving the cell cursor or dragging a block only
// re-renders the rows it touches, not every cell on the page. The mouse
// handlers live on <tbody> for the same reason.
const GridRow = React.memo(function GridRow({
  row, r, columns, colTypes, rowEdits, isDeleted, picked, dupMsg, editable, columnMeta, rowOffset,
  selC, block, onRowSelect, onCopyRow, onToggleDelete, onEditCell,
}) {
  const zebra = r % 2 === 1;
  const rowBg = isDeleted ? '#fdf3f1' : picked ? '#fff6f4' : zebra ? '#fbfaf9' : '#ffffff';
  const [b1, b2] = block ? block.split(':').map(Number) : [-1, -2];
  return (
    <tr className="group/row">
      <td
        className={`${CELL_BASE} sticky left-0 z-[10] text-right pr-3 text-[11px] tabular-nums text-[#766a63] ${editable ? 'cursor-pointer' : ''}`}
        style={{ height: ROW_H, background: picked ? 'var(--sig-mid)' : selC >= 0 ? 'var(--sig-soft)' : '#f8f7f5', boxShadow: picked ? 'inset 3px 0 0 var(--sig)' : undefined }}
        onClick={e => editable && onRowSelect?.(r, e)}
        title={editable ? 'Click to select, Ctrl or Shift click for more rows' : undefined}
      >
        {editable ? (
          <span className="inline-flex items-center justify-end gap-0.5 w-full">
            {dupMsg && <span title={dupMsg} className="mr-auto pl-1 text-[9.5px] font-bold text-[#9e0000]">DUP</span>}
            <button
              onClick={e => { e.stopPropagation(); onCopyRow?.([r]); }}
              title="Copy this row as a new row"
              aria-label="Copy row"
              className="p-0.5 rounded text-[#766a63] opacity-0 group-hover/row:opacity-100 hover:bg-[#e8e6e3] hover:text-[#312c2a]"
            >
              <CopyPlus size={12} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); onToggleDelete(r); }}
              title={isDeleted ? 'Keep this row' : 'Mark row for deletion'}
              aria-label={isDeleted ? 'Keep row' : 'Delete row'}
              className={`p-0.5 rounded ${isDeleted ? 'text-[#9e0000]' : 'text-[#766a63] opacity-0 group-hover/row:opacity-100'} hover:bg-[#e8e6e3]`}
            >
              {isDeleted ? <Undo2 size={12} /> : <Trash2 size={12} />}
            </button>
            <span className="min-w-[22px] text-right">{rowOffset + r + 1}</span>
          </span>
        ) : rowOffset + r + 1}
      </td>
      {columns.map((col, c) => {
        const name = col.name;
        const dirty = Object.prototype.hasOwnProperty.call(rowEdits, name);
        const value = dirty ? rowEdits[name] : row[c];
        const meta = columnMeta[name];
        const numeric = typeFamily(colTypes[c]) === 'num' || typeof row[c] === 'number';
        const cellEditable = editable && !isDeleted && (meta ? meta.editable : true) && !isBig(row[c]);
        const isSel = selC === c;
        const inBlock = c >= b1 && c <= b2;
        const text = value === null || value === undefined ? 'NULL' : cellText(value);
        return (
          <td
            key={name}
            data-cell={`${r}:${c}`}
            title={text && text.length > 24 ? text.slice(0, 600) : undefined}
            className={`${CELL_BASE} px-3 ${inBlock ? '' : 'group-hover/row:!bg-[#f4f2f0]'} focus-within:!bg-white focus-within:!shadow-[inset_0_0_0_2px_var(--sig)] ${numeric ? 'text-right' : ''} ${isDeleted ? 'line-through text-[#766a63]' : ''}`}
            style={{
              height: ROW_H,
              background: inBlock ? 'var(--sig-soft)' : dirty ? '#fff3ea' : rowBg,
              boxShadow: isSel ? 'inset 0 0 0 2px var(--sig)' : dirty && dupMsg ? 'inset 3px 0 0 #9e0000' : dirty ? 'inset 3px 0 0 #ff6017' : undefined,
            }}
          >
            {cellEditable ? (
              <input
                value={value === null || value === undefined ? '' : cellText(value)}
                onChange={e => onEditCell(r, name, e.target.value)}
                placeholder={value === null ? 'NULL' : ''}
                className={`truncate w-full h-[24px] bg-transparent text-[12.5px] text-[#312c2a] placeholder-[#a39992] px-1 -mx-1 focus:outline-none ${numeric ? 'text-right tabular-nums' : ''}`}
              />
            ) : (
              <div className="truncate leading-[18px]">
                <CellValue value={value} numeric={numeric} />
              </div>
            )}
          </td>
        );
      })}
      <td aria-hidden="true" className="border-b border-[#efedea]" style={{ height: ROW_H, background: isDeleted ? '#fdf3f1' : rowBg }} />
    </tr>
  );
});

const SfGridView = React.memo(function SfGridView({
  columns, rows, widths, setWidths,
  sort, onSort, filters, onFilter,
  dimmed, rowOffset = 0,
  editable = false, columnMeta = {}, edits = {}, deleted = [], newRows = [],
  onEditCell, onToggleDelete, onEditNewCell, onRemoveNewRow, onOpenCell, onCopied,
  selectedRows = [], onRowSelect, onCopyRow, dupNew = {}, dupRows = {}, onSelection,
  stats = false, onToggleStats,
}) {
  const [openFilter, setOpenFilter] = useState(null);
  const headH = stats ? HEAD_H : HEAD_H_SLIM;
  const E = useEngine();
  // Header charts follow the rows on screen.
  const sparks = useMemo(() => (stats ? columns.map((c, i) => sparkOf(rows, i, typeFamily(c.type || c.display_type))) : []), [columns, rows, stats]);
  const rowSelSet = useMemo(() => new Set(selectedRows), [selectedRows]);
  // A block of cells, spreadsheet style: sel is the cell with the cursor,
  // anchor the corner the block was started from (Shift+click / Shift+arrows / drag).
  const [sel, setSel] = useState(null); // { r, c }
  const [anchor, setAnchor] = useState(null);
  const dragRef = useRef(false);
  const resizeRef = useRef(null);
  const wrapRef = useRef(null);
  const deletedSet = useMemo(() => new Set(deleted), [deleted]);

  useEffect(() => {
    const close = () => setOpenFilter(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // New result set, new selection.
  useEffect(() => { setSel(null); setAnchor(null); }, [columns, rows]);
  useEffect(() => {
    const up = () => { dragRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const box = sel ? {
    r1: Math.min(sel.r, (anchor || sel).r), r2: Math.max(sel.r, (anchor || sel).r),
    c1: Math.min(sel.c, (anchor || sel).c), c2: Math.max(sel.c, (anchor || sel).c),
  } : null;
  const multi = box && (box.r2 > box.r1 || box.c2 > box.c1);

  const typeOf = useCallback((col) => displayType(columnMeta[col.name]) || displayType(col), [columnMeta]);
  const colTypes = useMemo(() => columns.map(typeOf), [columns, typeOf]);

  // Fill in widths for columns nobody has sized yet, before the first paint.
  useLayoutEffect(() => {
    if (!columns?.length) return;
    const missing = columns.filter(c => widths[c.name] == null);
    if (!missing.length) return;
    setWidths(w => {
      const next = { ...w };
      columns.forEach((c, i) => { if (next[c.name] == null) next[c.name] = fitWidth(c.name, typeOf(c), rows, i, 380, editable ? 40 : 28); });
      return next;
    });
  }, [columns, rows, widths, setWidths, typeOf, editable]);

  const widthOf = (name) => widths[name] || DEFAULT_COL_WIDTH;

  const startResize = (e, name) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { name, startX: e.clientX, startWidth: widthOf(name) };
    const onMove = (ev) => {
      const st = resizeRef.current;
      if (!st) return;
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, st.startWidth + (ev.clientX - st.startX)));
      setWidths(w => ({ ...w, [st.name]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const autoFit = (e, col, i) => {
    e.stopPropagation();
    setWidths(w => ({ ...w, [col.name]: fitWidth(col.name, typeOf(col), rows, i, MAX_COL_WIDTH, editable ? 40 : 28) }));
  };

  const valueAt = (r, c) => {
    const name = columns[c]?.name;
    const rowEdits = edits[r] || {};
    return Object.prototype.hasOwnProperty.call(rowEdits, name) ? rowEdits[name] : rows[r]?.[c];
  };

  const scrollCellIntoView = (r, c) => {
    requestAnimationFrame(() => {
      wrapRef.current?.querySelector(`[data-cell="${r}:${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  // The block as text: tab between cells, a line per row (pastes into Excel
  // as cells). With headers, the column names go on top.
  const blockText = (b, headers) => {
    const lines = [];
    if (headers) lines.push(columns.slice(b.c1, b.c2 + 1).map(c => c.name).join('\t'));
    for (let r = b.r1; r <= b.r2; r += 1) {
      const cells = [];
      for (let c = b.c1; c <= b.c2; c += 1) {
        const v = valueAt(r, c);
        cells.push(v === null || v === undefined ? '' : String(cellText(v)).replace(/[\t\n\r]+/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  };

  // Tell the page what is selected, so the status bar can show count / sum / average.
  useEffect(() => {
    if (!onSelection) return;
    if (!box || !multi) { onSelection(null); return; }
    let count = 0; let nums = 0; let sum = 0; let min = Infinity; let max = -Infinity;
    for (let r = box.r1; r <= box.r2; r += 1) {
      for (let c = box.c1; c <= box.c2; c += 1) {
        const v = valueAt(r, c);
        count += 1;
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
        if (n !== null) { nums += 1; sum += n; if (n < min) min = n; if (n > max) max = n; }
      }
    }
    onSelection({ count, rows: box.r2 - box.r1 + 1, cols: box.c2 - box.c1 + 1, nums, sum, min, max });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box?.r1, box?.r2, box?.c1, box?.c2, multi, rows, edits]);
  useEffect(() => () => onSelection?.(null), [onSelection]);

  const pick = (r, c, extend) => {
    if (extend && sel) setAnchor(a => a || sel);
    else setAnchor(null);
    setSel({ r, c });
  };

  const onKeyDown = async (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a' && rows.length && columns.length) {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setSel({ r: rows.length - 1, c: columns.length - 1 });
      return;
    }
    if (!sel) return;
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (move) {
      e.preventDefault();
      // Ctrl+arrow jumps to the edge, like a spreadsheet.
      const r = Math.max(0, Math.min(rows.length - 1, mod ? (move[0] < 0 ? 0 : move[0] > 0 ? rows.length - 1 : sel.r) : sel.r + move[0]));
      const c = Math.max(0, Math.min(columns.length - 1, mod ? (move[1] < 0 ? 0 : move[1] > 0 ? columns.length - 1 : sel.c) : sel.c + move[1]));
      pick(r, c, e.shiftKey);
      scrollCellIntoView(r, c);
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(blockText(box, e.shiftKey));
        onCopied?.(multi ? `${plural((box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1), 'cell')} copied${e.shiftKey ? ' with headers' : ''}` : undefined);
      } catch { /* no clipboard */ }
      return;
    }
    if (e.key === 'Enter' && !editable) {
      e.preventDefault();
      onOpenCell?.(columns[sel.c].name, valueAt(sel.r, sel.c), sel.r);
    }
    // F keeps rows like the selected cell, Shift F hides them.
    if (!mod && !e.altKey && e.code === 'KeyF' && !editable && onFilter) {
      const v = valueAt(sel.r, sel.c);
      if (v !== null && v !== undefined && typeof v === 'object') return;   // a cut-short big value
      e.preventDefault();
      const col = columns[sel.c].name;
      onFilter(v == null ? { col, op: e.shiftKey ? 'is_not_null' : 'is_null' } : { col, op: e.shiftKey ? 'neq' : 'eq', value: String(v) });
    }
    if (e.key === 'Escape') { setSel(null); setAnchor(null); }
  };

  const filterFor = (name) => (filters || []).find(f => f.col === name) || null;
  const sortFor = (name) => (sort || []).find(s => s.col === name) || null;

  const gutterW = Math.max(52, String(rowOffset + rows.length + newRows.length).length * 8 + 30) + (editable ? 44 : 0);
  const cellBase = 'border-b border-r border-[#efedea]';
  const headBase = 'border-b border-r border-[#efedea] bg-white';

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`relative focus:outline-none transition-opacity ${dimmed ? 'opacity-55 pointer-events-none' : ''}`}
      aria-label="Result grid"
    >
      <table
        className="border-separate border-spacing-0 text-[12.5px] font-johnson-text text-[#312c2a] select-none"
        // Real pixel width: with max-content the browser drops fixed layout and long text ignores the column widths.
        style={{ tableLayout: 'fixed', width: gutterW + columns.reduce((s, c) => s + widthOf(c.name), 0), minWidth: '100%' }}
      >
        <colgroup>
          <col style={{ width: gutterW }} />
          {columns.map(c => <col key={c.name} style={{ width: widthOf(c.name) }} />)}
          {/* soaks up spare width so the row numbers and real columns keep their size */}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th
              className={`${headBase} sticky top-0 left-0 z-[22] p-0 text-[10.5px] font-medium text-[#766a63]`}
              style={{ height: headH }}
            >
              {onToggleStats ? (
                <button
                  type="button"
                  onClick={onToggleStats}
                  aria-pressed={stats}
                  title={stats ? 'Hide column summaries' : 'Show a summary of each column'}
                  className={`w-full h-full flex items-center justify-center ${stats ? '' : 'hover:bg-[#faf9f8]'}`}
                >
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md ${stats ? 'text-white' : 'text-[#766a63] hover:text-[#312c2a]'}`} style={stats ? { background: E.accent } : undefined}>
                    <ChartColumnBig size={13} />
                  </span>
                </button>
              ) : <span className="block text-right pr-3">#</span>}
            </th>
            {columns.map((col, i) => {
              const name = col.name;
              const meta = columnMeta[name];
              const type = typeOf(col);
              const activeSort = sortFor(name);
              const activeFilter = filterFor(name);
              const sortIdx = activeSort && sort.length > 1 ? sort.indexOf(activeSort) + 1 : null;
              return (
                <th
                  key={name}
                  className={`${headBase} group/th sticky top-0 z-[20] p-0 text-left font-normal align-middle`}
                  style={{ height: headH }}
                >
                  <div className="relative h-full flex items-center">
                    <button
                      onClick={e => onSort(name, e.shiftKey)}
                      title={`${name}\n${type}${meta?.nullable === false ? ' · NOT NULL' : ''}\nClick to sort, Shift+click to add to the sort`}
                      className="flex-1 min-w-0 h-full pl-3 pr-1 flex flex-col justify-center text-left hover:bg-[#faf9f8]"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        {meta?.is_primary_key && <KeyRound size={11} className="flex-shrink-0 text-[#a14a00]" aria-label="Primary key" />}
                        <span className="truncate text-[12.5px] font-bold text-[#312c2a]">{name}</span>
                        {activeSort && (
                          <span className="flex-shrink-0 inline-flex items-center text-[var(--sig-ink)]">
                            {activeSort.dir === 'asc' ? <ArrowUp size={12} strokeWidth={2.4} /> : <ArrowDown size={12} strokeWidth={2.4} />}
                            {sortIdx && <span className="text-[9.5px] font-bold">{sortIdx}</span>}
                          </span>
                        )}
                      </span>
                      <span className="mt-[2px] flex items-center gap-1 min-w-0 text-[10.5px] font-mono text-[#766a63]">
                        <span className="flex-shrink-0">{colGlyph(type)}</span>
                        <span className="truncate">{type}</span>
                      </span>
                      {stats && <span className="block mt-[5px] mr-1"><MiniSpark data={sparks[i]} accent={E.accent} /></span>}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setOpenFilter(openFilter === name ? null : name); }}
                      title={activeFilter ? 'Edit filter' : 'Filter this column'}
                      aria-label={`Filter ${name}`}
                      className={`flex-shrink-0 mr-2 w-6 h-6 flex items-center justify-center rounded-md transition ${
                        activeFilter ? 'bg-[var(--sig-soft)] text-[var(--sig-ink)]' : 'text-[#766a63] opacity-0 group-hover/th:opacity-100 focus:opacity-100 hover:bg-[#e8e6e3]'
                      }`}
                    >
                      <Filter size={12} strokeWidth={2.2} />
                    </button>
                    {openFilter === name && (
                      <FilterPopover
                        column={name}
                        current={activeFilter}
                        alignRight={i > 0 && i >= columns.length - 2}
                        onApply={f => { onFilter(f); setOpenFilter(null); }}
                        onClear={() => { onFilter({ col: name, op: null }); setOpenFilter(null); }}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                    <span
                      onMouseDown={e => startResize(e, name)}
                      onDoubleClick={e => autoFit(e, col, i)}
                      onClick={e => e.stopPropagation()}
                      title="Drag to resize, double-click to fit"
                      className="absolute top-0 -right-[3px] z-[5] h-full w-[7px] cursor-col-resize after:absolute after:left-[3px] after:top-2 after:bottom-2 after:w-[1px] hover:after:bg-[var(--sig)]"
                    />
                  </div>
                </th>
              );
            })}
            <th aria-hidden="true" className="sticky top-0 z-[20] p-0 border-b border-[#efedea] bg-white" style={{ height: headH }} />
          </tr>
        </thead>
        <tbody
          onMouseDown={e => {
            const at = cellAt(e);
            if (!at || e.button !== 0) return;
            pick(at.r, at.c, e.shiftKey);
            // Drag across cells to select a block (not while editing a cell).
            if (!e.shiftKey && e.target.tagName !== 'INPUT') { dragRef.current = true; setAnchor({ r: at.r, c: at.c }); }
          }}
          onMouseOver={e => {
            if (!dragRef.current) return;
            const at = cellAt(e);
            if (at) setSel(s => (s && s.r === at.r && s.c === at.c ? s : at));
          }}
          onDoubleClick={e => {
            const at = cellAt(e);
            if (!at) return;
            const name = columns[at.c].name;
            const raw = rows[at.r]?.[at.c];
            const meta = columnMeta[name];
            const cellEditable = editable && !deletedSet.has(at.r) && (meta ? meta.editable : true) && !isBig(raw);
            if (!cellEditable) onOpenCell?.(name, raw, at.r);
          }}
        >
          {rows.map((row, r) => {
            const selC = sel && sel.r === r ? sel.c : -1;
            return (
              <GridRow
                key={r}
                row={row}
                r={r}
                columns={columns}
                colTypes={colTypes}
                rowEdits={edits[r] || NO_EDITS}
                isDeleted={deletedSet.has(r)}
                picked={rowSelSet.has(r)}
                dupMsg={dupRows[r]}
                editable={editable}
                columnMeta={columnMeta}
                rowOffset={rowOffset}
                selC={selC}
                block={multi && r >= box.r1 && r <= box.r2 ? `${box.c1}:${box.c2}` : ''}
                onRowSelect={onRowSelect}
                onCopyRow={onCopyRow}
                onToggleDelete={onToggleDelete}
                onEditCell={onEditCell}
              />
            );
          })}

          {editable && newRows.map((draft, i) => {
            const dup = dupNew[i];
            const bg = dup ? '#fdf3f1' : '#f6fbf3';
            return (
            <tr key={`new-${i}`} data-newrow={i}>
              <td className={`${cellBase} sticky left-0 z-[10] text-right pr-2`} style={{ height: ROW_H, background: dup ? 'var(--sig-mid)' : '#eef6ea' }} title={dup || 'New row'}>
                <span className={`inline-flex items-center gap-1 text-[10.5px] font-bold ${dup ? 'text-[#9e0000]' : 'text-[#328714]'}`}>
                  <button onClick={() => onRemoveNewRow(i)} title="Discard this new row" className="p-0.5 rounded text-[#6e6259] hover:bg-[#dcebd5]">
                    <X size={12} />
                  </button>
                  {dup ? 'DUP' : 'NEW'}
                </span>
              </td>
              {columns.map(col => {
                const meta = columnMeta[col.name];
                return (
                  <td key={col.name} className={`${cellBase} px-3 focus-within:!bg-white focus-within:!shadow-[inset_0_0_0_2px_var(--sig)]`} style={{ height: ROW_H, background: bg }}>
                    {meta && !meta.editable ? (
                      <span className="text-[11px] italic text-[#766a63]">not editable</span>
                    ) : (
                      <input
                        value={draft[col.name] ?? ''}
                        onChange={e => onEditNewCell(i, col.name, e.target.value)}
                        placeholder={meta?.nullable === false ? 'required' : 'NULL'}
                        className={`w-full h-[24px] bg-transparent text-[12.5px] text-[#312c2a] placeholder-[#a39992] px-1 -mx-1 focus:outline-none ${typeFamily(typeOf(col)) === 'num' ? 'text-right tabular-nums' : ''}`}
                      />
                    )}
                  </td>
                );
              })}
              <td aria-hidden="true" className="border-b border-[#efedea] px-3 text-[11.5px] text-[#9e0000] whitespace-nowrap" style={{ height: ROW_H, background: bg }}>{dup}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

/* --------------------- editing a query's result rows --------------------- */
// A result can be edited in place when it plainly comes from one table, the
// way DBeaver allows it: one SELECT, one table, no joins, grouping or set ops.
const IDENT = '(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)';
const FROM_ONE = new RegExp(`\\bFROM\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2})`, 'gi');
const NOT_EDITABLE = /\b(JOIN|GROUP\s+BY|UNION|INTERSECT|EXCEPT|MINUS|DISTINCT|HAVING|PIVOT|UNPIVOT|LATERAL|FLATTEN|CONNECT\s+BY|MATCH_RECOGNIZE|QUALIFY|RESULT_SCAN)\b/i;

function editTargetFor(sql, defaultDb, defaultSchema, upperIdents = true) {
  const clean = String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(clean)) return { error: 'Only the result of a SELECT can be edited.' };
  if ((clean.match(/\bSELECT\b/gi) || []).length > 1) return { error: 'Results with subqueries or CTEs can\'t be edited. Select from the table directly.' };
  const bad = NOT_EDITABLE.exec(clean);
  if (bad) return { error: `Results that use ${bad[1].toUpperCase().replace(/\s+/g, ' ')} can't be edited, because rows no longer map one to one onto the table.` };
  const froms = [...clean.matchAll(FROM_ONE)];
  if (froms.length !== 1) return { error: 'Only results from a single table can be edited.' };
  const after = clean.slice(froms[0].index + froms[0][0].length);
  if (/^\s*,/.test(after) || /^\s*\(/.test(after)) return { error: 'Only results from a single table can be edited.' };
  const parts = froms[0][1].split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : upperIdents ? p.toUpperCase() : p.toLowerCase()));
  const [database, schema, table] = parts.length === 3 ? parts
    : parts.length === 2 ? [defaultDb, ...parts]
      : [defaultDb, defaultSchema, parts[0]];
  if (!database || !schema || !table) return { error: 'Use the full DATABASE.SCHEMA.TABLE name in FROM so the table can be found.' };
  return { database, schema, table };
}

/* ----------------------------- SQL formatting ---------------------------- */
// Small Snowflake-aware formatter. Clause keywords start a new line, select
// lists / ORDER BY / GROUP BY break on commas, WHERE / HAVING break on
// AND / OR, and subqueries indent. Anything it isn't sure about (comments,
// $$ bodies, DDL, MERGE, scripts) is handed back untouched, so it never
// changes what a statement does.

const FMT_IND = '    ';
const FMT_SKIP_LEAD = /^\s*(CREATE|ALTER|MERGE|CALL|BEGIN|DECLARE|EXECUTE|GRANT|REVOKE|SHOW|DESC|DESCRIBE|USE|COPY|PUT|GET|LIST|REMOVE|UNDROP|DROP|TRUNCATE|COMMENT|EXPLAIN)\b/i;
const FMT_PAREN_SPACE = new Set(['IN', 'AS', 'ON', 'AND', 'OR', 'NOT', 'USING', 'VALUES', 'FROM', 'JOIN', 'EXISTS', 'OVER', 'INTO', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'WHERE', 'BY', 'IS', 'ALL', 'ANY', 'WITH', 'LATERAL', 'SET', 'HAVING', 'QUALIFY', 'UNION', 'CASE', 'RETURN']);

function fmtLex(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if ((c === '-' && sql[i + 1] === '-') || (c === '/' && sql[i + 1] === '*') || (c === '/' && sql[i + 1] === '/')) return null;
    if (c === '$' && sql[i + 1] === '$') return null;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && c === "'") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j += 1;
      }
      if (j >= n) return null;
      out.push({ k: c === "'" ? 'str' : 'id', t: sql.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_@$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[A-Za-z0-9_$@#]/.test(sql[j]) || sql.charCodeAt(j) > 127)) j += 1;
      out.push({ k: 'w', t: sql.slice(i, j), u: sql.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) j += 1;
      out.push({ k: 'num', t: sql.slice(i, j) });
      i = j;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (['::', '<=', '>=', '<>', '!=', '||', '=>', '->'].includes(two)) { out.push({ k: 'op', t: two }); i += 2; continue; }
    if ('(),;.[]'.includes(c)) { out.push({ k: 'p', t: c }); i += 1; continue; }
    out.push({ k: 'op', t: c });
    i += 1;
  }
  return out;
}

// Nest parentheses so clause splitting can treat each group as one item.
function fmtTree(tokens) {
  const root = [];
  const stack = [root];
  for (const tok of tokens) {
    if (tok.t === '(') {
      const g = { k: 'grp', items: [] };
      stack[stack.length - 1].push(g);
      stack.push(g.items);
    } else if (tok.t === ')') {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      stack[stack.length - 1].push(tok);
    }
  }
  return stack.length === 1 ? root : null;
}

// Keywords that get upper cased inside clause bodies, like Snowsight's formatter.
const FMT_UPPER = new Set(['AND', 'OR', 'NOT', 'IN', 'AS', 'ON', 'IS', 'NULL', 'LIKE', 'ILIKE', 'RLIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'OVER', 'PARTITION', 'BY', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'NATURAL', 'EXISTS', 'ALL', 'ANY', 'TRUE', 'FALSE', 'INTERVAL', 'USING', 'LATERAL', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING',
  'FOLLOWING', 'CURRENT', 'ROW', 'WITHIN', 'GROUP', 'FILTER', 'ESCAPE', 'PIVOT', 'UNPIVOT', 'FOR', 'SAMPLE', 'RECURSIVE', 'AT', 'BEFORE']);

const isW = (tok, ...words) => tok && tok.k === 'w' && words.includes(tok.u);
const isSubquery = (items) => isW(items[0], 'SELECT', 'WITH');

function fmtInline(items, depth) {
  let out = '';
  let prev = null;
  items.forEach((tok, idx) => {
    let text;
    if (tok.k === 'grp') {
      text = isSubquery(tok.items)
        ? `(\n${fmtStatement(tok.items, depth + 1)}\n${FMT_IND.repeat(depth)})`
        : `(${fmtInline(tok.items, depth)})`;
    } else {
      const next = items[idx + 1];
      text = tok.k === 'w' && FMT_UPPER.has(tok.u) && !(next && next.k === 'grp' && !FMT_PAREN_SPACE.has(tok.u)) ? tok.u : tok.t;
    }
    let space = !!out;
    if (prev) {
      if (tok.k === 'p' && [',', ';', '.', ']'].includes(tok.t)) space = false;
      if (tok.k === 'op' && (tok.t === '::' || tok.t === ':')) space = false;
      if (prev.k === 'p' && ['.', '['].includes(prev.t)) space = false;
      if (prev.k === 'op' && (prev.t === '::' || prev.t === ':')) space = false;
      if (tok.t === '[') space = false;
      if (tok.k === 'grp' && (prev.k === 'w' || prev.k === 'id') && !FMT_PAREN_SPACE.has(prev.u)) space = false;
      // unary minus / plus
      const before = items[idx - 2];
      if (prev.k === 'op' && (prev.t === '-' || prev.t === '+') && (!before || before.k === 'op' || (before.k === 'p' && before.t === ',') || before.k === 'w' && FMT_PAREN_SPACE.has(before.u))) space = false;
    }
    out += (space ? ' ' : '') + text;
    prev = tok;
  });
  return out;
}

// Splits a list on top level separators, keeping the separator words with
// the part that follows (for AND / OR / JOIN).
function fmtSplitCommas(items) {
  const parts = [[]];
  items.forEach(tok => {
    if (tok.k === 'p' && tok.t === ',') parts.push([]);
    else parts[parts.length - 1].push(tok);
  });
  return parts.filter(p => p.length);
}

function fmtSplitLogic(items) {
  const parts = [[]];
  let between = false;
  items.forEach(tok => {
    if (isW(tok, 'BETWEEN')) between = true;
    if (isW(tok, 'AND', 'OR') && parts[parts.length - 1].length) {
      if (tok.u === 'AND' && between) { between = false; parts[parts.length - 1].push(tok); return; }
      parts.push([tok]);
      return;
    }
    parts[parts.length - 1].push(tok);
  });
  return parts;
}

const JOIN_LEAD = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER', 'JOIN', 'ASOF'];

function fmtSplitFrom(items) {
  const parts = [[]];
  for (let i = 0; i < items.length; i += 1) {
    const tok = items[i];
    if (tok.k === 'p' && tok.t === ',') { parts.push([]); continue; }
    if (isW(tok, ...JOIN_LEAD) && parts[parts.length - 1].length) {
      // only a join if a JOIN keyword follows within this run of join words
      let j = i;
      while (isW(items[j], ...JOIN_LEAD) && !isW(items[j], 'JOIN')) j += 1;
      if (isW(items[j], 'JOIN') && !isW(items[i - 1], ...JOIN_LEAD)) { parts.push([tok]); continue; }
    }
    parts[parts.length - 1].push(tok);
  }
  return parts.filter(p => p.length);
}

// Clause keywords, longest first so GROUP BY wins over GROUP.
const CLAUSES = [
  ['INSERT', 'OVERWRITE', 'INTO'], ['INSERT', 'INTO'], ['DELETE', 'FROM'], ['GROUP', 'BY'], ['ORDER', 'BY'],
  ['UNION', 'ALL'], ['UNION', 'DISTINCT'], ['UNION'], ['INTERSECT'], ['EXCEPT'], ['MINUS'],
  ['WITH'], ['SELECT'], ['FROM'], ['WHERE'], ['HAVING'], ['QUALIFY'], ['LIMIT'], ['OFFSET'], ['FETCH'],
  ['UPDATE'], ['SET'], ['VALUES'], ['WINDOW'],
];
const CLAUSE_KIND = {
  SELECT: 'comma', 'GROUP BY': 'comma', 'ORDER BY': 'comma', SET: 'comma', VALUES: 'comma', WITH: 'comma', WINDOW: 'comma',
  WHERE: 'logic', HAVING: 'logic', QUALIFY: 'logic', FROM: 'from', 'DELETE FROM': 'from', UPDATE: 'from',
};

function fmtStatement(items, depth) {
  const clauses = [];
  let cur = null;
  for (let i = 0; i < items.length; i += 1) {
    const tok = items[i];
    let hit = null;
    if (tok.k === 'w' && !(cur && cur.kw === 'WITH' && !isW(tok, 'SELECT', 'INSERT', 'UPDATE', 'DELETE'))) {
      hit = CLAUSES.find(words => words.every((w, k) => isW(items[i + k], w)));
    }
    // SET inside UPDATE only, so "SET" in other spots stays inline
    if (hit && hit[0] === 'SET' && !clauses.some(c => c.kw === 'UPDATE')) hit = null;
    if (hit) {
      cur = { kw: hit.join(' '), body: [] };
      clauses.push(cur);
      i += hit.length - 1;
    } else if (cur) {
      cur.body.push(tok);
    } else {
      cur = { kw: '', body: [tok] };
      clauses.push(cur);
    }
  }
  const pad = FMT_IND.repeat(depth);
  const pad1 = FMT_IND.repeat(depth + 1);
  return clauses.map(({ kw, body }) => {
    let head = kw;
    let rest = body;
    if (kw === 'SELECT') {
      while (isW(rest[0], 'DISTINCT', 'ALL')) { head += ` ${rest[0].t}`; rest = rest.slice(1); }
      if (isW(rest[0], 'TOP') && rest[1]?.k === 'num') { head += ` ${rest[0].t} ${rest[1].t}`; rest = rest.slice(2); }
    }
    if (!rest.length) return pad + head;
    const kind = CLAUSE_KIND[kw];
    let parts;
    if (kind === 'comma') parts = fmtSplitCommas(rest).map((p, i, all) => fmtInline(p, depth + 1) + (i < all.length - 1 ? ',' : ''));
    else if (kind === 'logic') parts = fmtSplitLogic(rest).map(p => fmtInline(p, depth + 1));
    else if (kind === 'from') parts = fmtSplitFrom(rest).map((p, i, all) => fmtInline(p, depth + 1) + (i < all.length - 1 && !isW(all[i + 1][0], ...JOIN_LEAD) ? ',' : ''));
    else parts = [fmtInline(rest, depth + 1)];
    if (!head) return pad + parts.join(' ');
    if (kw === 'INSERT INTO' || kw === 'INSERT OVERWRITE INTO') parts = parts.map(x => x.replace(/^([^\s(]+)\(/, '$1 ('));
    if (kw === 'WITH') {
      const ctes = fmtSplitCommas(rest).map(x => fmtInline(x, depth));
      return `${pad}WITH ${ctes.join(`,\n${pad}`)}`;
    }
    if (parts.length === 1 && !parts[0].includes('\n') && parts[0].length <= 72) return `${pad}${head} ${parts[0]}`;
    return `${pad}${head}\n${parts.map(p => pad1 + p).join('\n')}`;
  }).join('\n');
}

function formatSql(sql) {
  const text = String(sql || '');
  if (!text.trim() || FMT_SKIP_LEAD.test(text)) return text.replace(/\t/g, FMT_IND);
  try {
    const tokens = fmtLex(text);
    if (!tokens) return text;
    const statements = [[]];
    tokens.forEach(tok => {
      if (tok.k === 'p' && tok.t === ';') statements.push([]);
      else statements[statements.length - 1].push(tok);
    });
    const hadSemi = /;\s*$/.test(text);
    const out = [];
    for (const st of statements) {
      if (!st.length) continue;
      if (FMT_SKIP_LEAD.test(st[0].t)) return text;
      const tree = fmtTree(st);
      if (!tree) return text;
      out.push(fmtStatement(tree, 0));
    }
    if (!out.length) return text;
    return out.join(';\n\n') + (hadSemi || out.length > 1 ? ';' : '');
  } catch {
    return text;
  }
}

/* ------------------------- editor text helpers ------------------------- */

const splitIdent = (w) => w
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .split(/[_\s-]+/)
  .filter(Boolean)
  .map(p => p.toLowerCase());

const CASES = {
  upper: s => s.toUpperCase(),
  lower: s => s.toLowerCase(),
  camel: s => s.replace(/[A-Za-z0-9_]+/g, w => splitIdent(w).map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('')),
  pascal: s => s.replace(/[A-Za-z0-9_]+/g, w => splitIdent(w).map(p => p[0].toUpperCase() + p.slice(1)).join('')),
  snake: s => s.replace(/[A-Za-z0-9_]+/g, w => splitIdent(w).join('_')),
  title: s => s.toLowerCase().replace(/(^|[\s_(.,])([a-z])/g, (m, a, b) => a + b.toUpperCase()),
};

// Statement spans in a worksheet, same rules as split_script in the backend:
// semicolons inside strings, quoted names, comments and $$ / $tag$ bodies don't split.
function statementSpans(sql, backslashEscapes = false) {
  const spans = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const push = (a, b) => {
    const text = sql.slice(a, b);
    const code = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (code) spans.push({ start: a + (text.length - text.trimStart().length), end: b });
  };
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (ch === "'") {
      i += 1;
      while (i < n && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" || (backslashEscapes && sql[i] === '\\') ? 2 : 1;
      i += 1;
    } else if (ch === '"') {
      const j = sql.indexOf('"', i + 1);
      i = j < 0 ? n : j + 1;
    } else if (ch === '-' && nx === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (ch === '/' && nx === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
    } else if (ch === '$' && !/[\w$]/.test(sql[i - 1] || '')) {
      const m = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const j = sql.indexOf(m[0], i + m[0].length);
        i = j < 0 ? n : j + m[0].length;
      } else i += 1;
    } else if (ch === ';') {
      push(start, i);
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  push(start, n);
  return spans;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

const SHORTCUTS = [
  ['Run selection, or the statement at the cursor', `${MOD} Enter`],
  ['Run all statements', `${MOD} Shift Enter`],
  ['Undo / redo', `${MOD} Z / ${MOD} Y`],
  ['Format SQL', `${MOD} Shift F`],
  ['UPPER CASE', `${MOD} Shift U`],
  ['lower case', `${MOD} Shift L`],
  ['camelCase', `${MOD} Alt C`],
  ['PascalCase', `${MOD} Alt P`],
  ['snake_case', `${MOD} Alt S`],
  ['Toggle line comment', `${MOD} /`],
  ['Duplicate line', 'Shift Alt ↓'],
  ['Move line up / down', 'Alt ↑ / ↓'],
  ['Delete line', `${MOD} Shift K`],
  ['Indent / outdent', 'Tab / Shift Tab'],
  ['Show suggestions', `${MOD} Space`],
  ['Save query', `${MOD} S`],
  ['Results: keep rows like the selected cell', 'F'],
  ['Results: hide rows like the selected cell', 'Shift F'],
  ['Results: select cells', 'Drag / Shift click'],
  ['Results: grow the selection', 'Shift ←↑↓→'],
  ['Results: jump to the edge', `${MOD} ←↑↓→`],
  ['Results: select the whole page', `${MOD} A`],
  ['Results: copy cells / with headers', `${MOD} C / ${MOD} Shift C`],
];

// SQL editor: a transparent textarea over a painted <pre>. Line numbers live
// inside the painted layer so they scroll and wrap with the text, which keeps
// them lined up even when a long line wraps.

const LINE_H = 21;
const FONT_SIZE = 13;

const THEMES = {
  light: { bg: '#ffffff', gutter: '#f8f7f5', gutterLine: '#efedea', num: '#a39992', numOn: '#312c2a', caret: '#eb1700', sel: 'rgba(235,23,0,0.16)', placeholder: '#a39992' },
  dark: { bg: '#2b2624', gutter: '#2b2624', gutterLine: '#2b2624', num: '#93877f', numOn: '#ffffff', caret: '#ffffff', sel: 'rgba(105,208,255,0.24)', placeholder: '#9a8f87' },
};

function splitLines(tokens) {
  const lines = [[]];
  tokens.forEach(tok => {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: tok.kind, text: part });
    });
  });
  return lines;
}

const SUGGEST_BADGE = {
  column: ['C', T.green], function: ['f', '#8c3bbb'], schema: ['S', '#8c3bbb'],
  database: ['D', T.ink], view: ['V', T.blue], table: ['T', 'var(--sig-ink)'], keyword: ['K', T.muted],
};

// Where the suggestion list goes on screen. It is drawn on the page itself
// (a portal), so the editor's edges and the tab bar above can't cut it off,
// and it opens below the caret or above it, whichever has more room in the
// window, shrinking to fit when neither has the full 220px.
function suggestBox(ta, suggest, padLeft) {
  const box = ta.getBoundingClientRect();
  const caretTop = box.top + suggest.top - suggest.lineHeight;
  const caretBottom = box.top + suggest.top;
  const below = window.innerHeight - caretBottom - 8;
  const above = caretTop - 8;
  const down = below >= 160 || below >= above;
  const left = box.left + Math.max(padLeft, Math.min(suggest.left, box.width - 250));
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - 248)),
    maxHeight: Math.max(90, Math.min(220, down ? below : above)),
    ...(down ? { top: caretBottom + 4 } : { bottom: window.innerHeight - caretTop + 4 }),
  };
}

// Undo and redo for the editor. The browser's own history is wiped by every
// edit made in code (a picked suggestion, a name inserted from the explorer,
// a loaded query) and lost when the worksheet is switched, so the editor keeps
// its own, per worksheet, for as long as the page is open.
// ponytail: whole-text snapshots, capped at 300 steps; fine for worksheets, switch to diffs if huge scripts get slow.
const HISTORIES = new Map();
const HISTORY_MAX = 300;

const SfEditor = forwardRef(function SfEditor({ value, onChange: setValue, historyKey, onRun, onRunAll, onSave, theme = 'light', defaultDb, defaultSchema, placeholder, cq = '', readOnly = false, session = null, peerColor, onSelect }, ref) {
  const E = useEngine();
  const taRef = useRef(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [suggest, setSuggest] = useState(null);
  const suggestRef = useRef(null);
  // The list sits on the page, not in the editor: close it when the page
  // moves under it, but not when the list itself or the editor scrolls.
  const suggestOpen = Boolean(suggest);
  useEffect(() => {
    if (!suggestOpen) return undefined;
    const close = (e) => {
      if (e.type === 'scroll' && (e.target === taRef.current || suggestRef.current?.contains(e.target))) return;
      setSuggest(null);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [suggestOpen]);
  const objectCache = useRef({});
  const updateRef = useRef(() => {});
  // Names that arrive later only open the list if you're still typing there.
  const typingRef = useRef(false);
  const base = THEMES[theme] || THEMES.light;
  // The light editor's caret and selection take the engine's colour.
  const th = theme === 'dark' ? base : { ...base, caret: E.ink, sel: `${E.accent}2e` };

  const hist = useMemo(() => {
    let h = historyKey ? HISTORIES.get(historyKey) : null;
    if (!h) {
      h = { undo: [], redo: [], at: 0, kind: null };
      if (historyKey) HISTORIES.set(historyKey, h);
    }
    return h;
  }, [historyKey]);
  const shownRef = useRef(value);      // the text as the history last saw it
  const nextKind = useRef(null);       // set by code edits, so they are a step of their own
  const remember = (before, kind) => {
    const now = Date.now();
    // Letters typed in a row are one step, until a pause or a space.
    const joins = kind === 'type' && hist.kind === 'type' && now - hist.at < 1000 && hist.undo.length;
    if (!joins) {
      hist.undo.push(before);
      if (hist.undo.length > HISTORY_MAX) hist.undo.shift();
    }
    hist.redo = [];
    hist.at = now;
    hist.kind = kind;
  };
  const onChange = (next, kind = 'edit') => {
    const before = shownRef.current ?? '';
    if (next !== before) remember(before, kind);
    shownRef.current = next;
    setValue(next);
  };
  // Changes from outside (a query loaded from history, a worksheet restored)
  // are a step too. Someone else's typing in a shared worksheet is not ours to undo.
  useEffect(() => {
    if (value === shownRef.current) return;
    if (!session && shownRef.current != null) remember(shownRef.current, 'edit');
    shownRef.current = value;
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const travel = (from, to) => {
    const ta = taRef.current;
    const back = from.pop();
    if (back == null || readOnly) return;
    const now = value || '';
    to.push(now);
    hist.kind = null;
    shownRef.current = back;
    setValue(back);
    // The caret goes to the end of what changed.
    let a = 0;
    while (a < back.length && a < now.length && back[a] === now[a]) a += 1;
    let z = 0;
    while (z < back.length - a && z < now.length - a && back[back.length - 1 - z] === now[now.length - 1 - z]) z += 1;
    const at = Math.max(a, back.length - z);
    requestAnimationFrame(() => { if (ta) { ta.focus(); ta.setSelectionRange(at, at); } });
  };
  const undo = () => travel(hist.undo, hist.redo);
  const redo = () => travel(hist.redo, hist.undo);
  // The browser's Edit menu (and the touch bar) send undo as an input event.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return undefined;
    const before = (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); undoRef.current(); }
      if (e.inputType === 'historyRedo') { e.preventDefault(); redoRef.current(); }
    };
    ta.addEventListener('beforeinput', before);
    return () => ta.removeEventListener('beforeinput', before);
  }, []);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  const palette = TOKEN_COLORS[theme] || TOKEN_COLORS.light;

  const lineCount = Math.max(1, (value || '').split('\n').length);
  const gutterW = Math.max(52, String(lineCount).length * 8 + 36);
  const padLeft = gutterW + 14;

  // The statement the cursor is in gets a bar down its lines and a run arrow
  // on its first line, so you can see what Run will send.
  const [caret, setCaret] = useState(0);
  const trackCaret = () => { const ta = taRef.current; if (ta) setCaret(ta.selectionStart); };
  const spans = useMemo(() => statementSpans(value || '', E.upperIdents), [value, E.upperIdents]);
  const lineOf = useCallback((pos) => (value || '').slice(0, pos).split('\n').length - 1, [value]);
  const current = useMemo(() => {
    if (!spans.length) return null;
    let pick = spans[0];
    spans.forEach(sp => { if (sp.start <= caret) pick = sp; });
    const body = (value || '').slice(pick.start, pick.end).replace(/\s+$/, '');
    // Comments above the statement aren't part of what you'd point at.
    const lead = /^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(body)[0].length;
    const code = pick.start + lead;
    return { ...pick, code, from: lineOf(code), to: lineOf(pick.start + body.length) };
  }, [spans, caret, value, lineOf]);
  const caretLine = lineOf(caret);
  const lineEls = useRef([]);
  const [arrowTop, setArrowTop] = useState(null);
  const runHere = (e) => {
    e.preventDefault();
    const ta = taRef.current;
    if (!ta || !current) return;
    ta.focus();
    ta.setSelectionRange(current.code, current.code);
    setCaret(current.code);
    onRun?.();
  };

  const lines = useMemo(() => splitLines(tokenizeSql(value || '')), [value]);
  // Shared worksheets: tell the others where this cursor is.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const readSel = () => {
    const ta = taRef.current;
    if (!ta) return null;
    const back = ta.selectionDirection === 'backward';
    return { a: back ? ta.selectionEnd : ta.selectionStart, h: back ? ta.selectionStart : ta.selectionEnd };
  };
  const shared = Boolean(onSelect);
  useEffect(() => {
    if (!shared) return undefined;
    const report = () => {
      if (document.activeElement === taRef.current) onSelectRef.current?.(readSel());
    };
    document.addEventListener('selectionchange', report);
    return () => document.removeEventListener('selectionchange', report);
  }, [shared]);

  // The painted layer has to wrap at exactly the textarea's inner width, which
  // shrinks when its scrollbar shows up.
  const [innerW, setInnerW] = useState(null);
  // Lines wrap, so the arrow goes where the statement's first line really is.
  useLayoutEffect(() => {
    const el = current && lineEls.current[current.from];
    setArrowTop(el ? el.offsetTop : null);
  }, [current, value, innerW]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setInnerW(ta.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const ta = taRef.current;
    if (ta && ta.clientWidth !== innerW) setInnerW(ta.clientWidth);
  }, [value, innerW]);

  /* ------------------------------ completion ------------------------------ */
  // Where a name points, as [database, schema, table]. Postgres can't reach
  // another database from a query, so there a dotted name is schema.table
  // inside the worksheet's database; Snowflake names go database.schema.table.
  const pg = E.pickDb;
  const homeSchema = defaultSchema || (pg ? 'public' : null);
  const refKey = useCallback((r) => {
    const parts = r.parts;
    if (pg) {
      if (!defaultDb) return null;
      return parts.length >= 2 ? [defaultDb, ...parts.slice(-2)] : [defaultDb, homeSchema, parts[0]];
    }
    if (parts.length >= 3) return parts.slice(-3);
    if (parts.length === 2) return defaultDb ? [defaultDb, parts[0], parts[1]] : null;
    return defaultDb && defaultSchema ? [defaultDb, defaultSchema, parts[0]] : null;
  }, [pg, defaultDb, defaultSchema, homeSchema]);
  // What typed "a." / "a.b." asks for: [db] schemas, [db, schema] tables, [db, schema, table] columns.
  const lookupFor = useCallback((context) => {
    if (!pg) return context;
    return defaultDb ? [defaultDb, ...context.slice(-2)] : null;
  }, [pg, defaultDb]);
  // Bare words: Postgres offers the database's schemas and the default
  // schema's tables, Snowflake its databases.
  const topLevel = useCallback(() => (pg && defaultDb ? [[defaultDb], [defaultDb, homeSchema]] : [[]]), [pg, defaultDb, homeSchema]);

  const ensureObjects = useCallback((context) => {
    const cache = objectCache.current;
    const key = context.join('.');
    if (cache[key] !== undefined) return;
    cache[key] = 'loading';
    const settle = (items) => { cache[key] = items; if (typingRef.current) updateRef.current(taRef.current); };
    const e = encodeURIComponent;
    let req;
    if (context.length === 0) {
      req = fetchJson(withQs(`${E.api}/databases`, cq)).then(d => (d.databases || []).map(x => ({ text: x, kind: 'database' })));
    } else if (context.length === 1) {
      req = fetchJson(withQs(`${E.api}/schemas?database=${e(context[0])}`, cq)).then(d => (d.schemas || []).map(x => ({ text: x, kind: 'schema' })));
    } else if (context.length === 2) {
      req = fetchJson(withQs(`${E.api}/tables?database=${e(context[0])}&schema=${e(context[1])}`, cq))
        .then(d => (d.tables || []).map(t => ({ text: t.name, kind: t.kind === 'table' ? 'table' : 'view', detail: t.kind === 'table' ? 'table' : 'view' })));
    } else if (context.length === 3) {
      req = fetchJson(withQs(`${E.api}/columns?database=${e(context[0])}&schema=${e(context[1])}&table=${e(context[2])}`, cq))
        .then(d => (d.columns || []).map(c => ({ text: c.name, kind: 'column', detail: displayType(c), pk: c.is_primary_key })));
    } else {
      settle([]);
      return;
    }
    req.then(settle).catch(() => settle([]));
  }, []);

  const columnsInScope = useCallback((refs) => {
    const out = [];
    refs.forEach(r => {
      const named = refKey(r);
      if (!named) return;
      // Only ask for columns of a table that exists. Without this every
      // keystroke of "FROM pu", "pub", "publ"... asked the server for a table
      // by that name. The schema's table list is one cached request.
      const tables = objectCache.current[named.slice(0, 2).join('.')];
      if (tables === undefined) { ensureObjects(named.slice(0, 2)); return; }
      const real = Array.isArray(tables) && tables.find(t => t.text.toLowerCase() === String(named[2]).toLowerCase());
      if (!real) return;
      const parts = [named[0], named[1], real.text];
      const cached = objectCache.current[parts.join('.')];
      if (cached === undefined) { ensureObjects(parts); return; }
      if (!Array.isArray(cached)) return;
      cached.forEach(col => out.push({ ...col, source: r.alias || r.table }));
    });
    return out;
  }, [ensureObjects, refKey]);

  const updateSuggest = useCallback((ta, force = false) => {
    if (!ta || ta.selectionStart !== ta.selectionEnd) { setSuggest(null); return; }
    const caret = ta.selectionStart;
    const { word, context } = sqlTokenAtCaret(ta.value, caret);
    const refs = parseTableRefs(ta.value);
    const clause = clauseAtCaret(ta.value, caret);
    let items;
    if (context.length > 0 && context.length <= 3) {
      let lookup = lookupFor(context);
      if (context.length === 1) {
        const r = resolveRef(refs, context[0]);
        const resolved = r && refKey(r);
        if (resolved) lookup = resolved;
      }
      if (!lookup) { setSuggest(null); return; }
      const objects = objectCache.current[lookup.join('.')];
      if (objects === undefined || objects === 'loading') { ensureObjects(lookup); setSuggest(null); return; }
      items = rankSuggestions(objects, word, clause).slice(0, 14);
    } else {
      if (word.length < (force ? 0 : 2)) { setSuggest(null); return; }
      const named = topLevel().flatMap(k => {
        const got = objectCache.current[k.join('.')];
        if (got === undefined) ensureObjects(k);
        return Array.isArray(got) ? got : [];
      });
      items = rankSuggestions([...columnsInScope(refs), ...(pg ? PG_SUGGESTIONS : STATIC_SUGGESTIONS), ...named], word, clause).slice(0, 12);
    }
    if (!items?.length) { setSuggest(null); return; }
    const pos = caretPixelPos(ta, caret);
    setSuggest({ items, index: 0, left: pos.left, top: pos.top, lineHeight: pos.lineHeight, boxHeight: ta.clientHeight });
  }, [ensureObjects, columnsInScope, refKey, lookupFor, topLevel, pg]);

  useEffect(() => { updateRef.current = updateSuggest; }, [updateSuggest]);

  const accept = (item) => {
    const ta = taRef.current;
    if (!ta || !item) return;
    const caret = ta.selectionStart;
    const { start } = sqlTokenAtCaret(ta.value, caret);
    // A database or schema name has more after it; a table's name is the end of it.
    const chains = ['database', 'schema'].includes(item.kind);
    const suffix = chains ? '.' : (item.kind === 'function' || /[ (]$/.test(item.text) ? '' : ' ');
    const insert = item.text + suffix;
    onChange(ta.value.slice(0, start) + insert + ta.value.slice(caret));
    setSuggest(null);
    requestAnimationFrame(() => {
      ta.focus();
      const p = start + insert.length;
      ta.setSelectionRange(p, p);
      if (chains) updateRef.current(ta);
    });
  };

  /* ------------------------------ public api ------------------------------ */
  /* ---------------------------- editing commands --------------------------- */
  // Replaces a range as if typed, through execCommand, falling back to a
  // plain value swap. Either way it is one undo step.
  const replaceRange = (start, end, text, selA, selB) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    nextKind.current = 'edit';
    let ok;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    nextKind.current = null;
    if (!ok) onChange(ta.value.slice(0, start) + text + ta.value.slice(end));
    const a = selA ?? start + text.length;
    const b = selB ?? a;
    requestAnimationFrame(() => ta.setSelectionRange(a, b));
  };

  const lineSpan = (ta) => {
    const v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let endAt = ta.selectionEnd;
    if (endAt > ta.selectionStart && v[endAt - 1] === '\n') endAt -= 1;
    let b = v.indexOf('\n', endAt);
    if (b < 0) b = v.length;
    return [a, b];
  };

  const wordAt = (ta) => {
    const v = ta.value;
    let a = ta.selectionStart;
    let b = ta.selectionEnd;
    if (a !== b) return [a, b];
    while (a > 0 && /[A-Za-z0-9_$]/.test(v[a - 1])) a -= 1;
    while (b < v.length && /[A-Za-z0-9_$]/.test(v[b])) b += 1;
    return [a, b];
  };

  const runCommand = (name) => {
    const ta = taRef.current;
    if (!ta) return;
    const v = ta.value;
    setSuggest(null);
    if (name === 'format') {
      const hasSel = ta.selectionStart !== ta.selectionEnd;
      const [a, b] = hasSel ? [ta.selectionStart, ta.selectionEnd] : [0, v.length];
      const next = formatSql(v.slice(a, b));
      if (next !== v.slice(a, b)) replaceRange(a, b, next, hasSel ? a : undefined, hasSel ? a + next.length : undefined);
      return;
    }
    if (CASES[name]) {
      const [a, b] = wordAt(ta);
      if (a === b) return;
      const next = CASES[name](v.slice(a, b));
      if (next !== v.slice(a, b)) replaceRange(a, b, next, a, a + next.length);
      return;
    }
    const [a, b] = lineSpan(ta);
    const block = v.slice(a, b);
    if (name === 'comment') {
      const lines = block.split('\n');
      const all = lines.filter(l => l.trim()).every(l => /^\s*--/.test(l));
      const next = lines.map(l => {
        if (!l.trim()) return l;
        return all ? l.replace(/^(\s*)-- ?/, '$1') : `-- ${l}`;
      }).join('\n');
      replaceRange(a, b, next, a, a + next.length);
    } else if (name === 'duplicate') {
      replaceRange(b, b, `\n${block}`, b + 1, b + 1 + block.length);
    } else if (name === 'deleteLine') {
      const end = b < v.length ? b + 1 : b;
      const start = b < v.length || a === 0 ? a : a - 1;
      replaceRange(start, end, '', start, start);
    } else if (name === 'moveUp' && a > 0) {
      const pa = v.lastIndexOf('\n', a - 2) + 1;
      const prev = v.slice(pa, a - 1);
      replaceRange(pa, b, `${block}\n${prev}`, pa, pa + block.length);
    } else if (name === 'moveDown' && b < v.length) {
      let nb = v.indexOf('\n', b + 1);
      if (nb < 0) nb = v.length;
      const nextLine = v.slice(b + 1, nb);
      replaceRange(a, nb, `${nextLine}\n${block}`, a + nextLine.length + 1, a + nextLine.length + 1 + block.length);
    } else if (name === 'indent' || name === 'outdent') {
      const lines = block.split('\n');
      const next = lines.map(l => (name === 'indent' ? FMT_IND + l : l.replace(/^( {1,4}|\t)/, ''))).join('\n');
      replaceRange(a, b, next, a, a + next.length);
    }
  };

  useImperativeHandle(ref, () => ({
    command: (name) => { if (!readOnly) runCommand(name); },
    focus: () => taRef.current?.focus(),
    // { a: anchor, h: head }, and back. Used to keep the caret where it was
    // when someone else's edit lands in a shared worksheet.
    getSelection: readSel,
    setSelection: (a, h) => taRef.current?.setSelectionRange(Math.min(a, h), Math.max(a, h), a > h ? 'backward' : 'forward'),
    // Scroll so a position is in view, without moving this user's own caret.
    reveal: (pos) => {
      const ta = taRef.current;
      if (ta) ta.scrollTop = Math.max(0, (ta.value.slice(0, pos).split('\n').length - 3) * LINE_H);
    },
    // Selected text if there is any, else the statement the cursor is in
    // (or the last one before it), like Snowsight.
    statement: () => {
      const ta = taRef.current;
      const text = value || '';
      if (ta && ta.selectionStart !== ta.selectionEnd) return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
      const spans = statementSpans(text, E.upperIdents);
      if (spans.length <= 1 || !ta) return text.trim();
      const caret = ta.selectionStart;
      let pick = spans[0];
      spans.forEach(sp => { if (sp.start <= caret) pick = sp; });
      return text.slice(pick.start, pick.end).trim();
    },
    insert: (text) => {
      if (readOnly) return;
      const ta = taRef.current;
      if (!ta) { onChange((value ? `${value} ` : '') + text); return; }
      const s = ta.selectionStart ?? ta.value.length;
      const en = ta.selectionEnd ?? ta.value.length;
      onChange(ta.value.slice(0, s) + text + ta.value.slice(en));
      requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s + text.length, s + text.length); });
    },
    jumpTo: (line, col) => {
      const ta = taRef.current;
      if (!ta) return;
      const all = ta.value.split('\n');
      let p = 0;
      for (let i = 0; i < Math.min(line - 1, all.length - 1); i += 1) p += all[i].length + 1;
      const lineText = all[Math.min(line - 1, all.length - 1)] || '';
      const at = p + Math.min(Math.max(0, (col || 1) - 1), lineText.length);
      ta.focus();
      ta.setSelectionRange(p, p + lineText.length);
      ta.scrollTop = Math.max(0, (line - 3) * LINE_H);
      setTimeout(() => ta.setSelectionRange(at, at), 900);
    },
  }));

  const textStyle = { fontSize: FONT_SIZE, lineHeight: `${LINE_H}px`, paddingLeft: padLeft, paddingRight: 16, paddingTop: 10, paddingBottom: 10 };

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: th.bg }}>
      <div aria-hidden="true" className="absolute inset-y-0 left-0 z-0" style={{ width: gutterW, background: th.gutter, borderRight: `1px solid ${th.gutterLine}` }} />
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <pre
          className="m-0 font-mono whitespace-pre-wrap break-words"
          style={{ ...textStyle, width: innerW || '100%', boxSizing: 'border-box', transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
        >
          {lines.map((line, i) => (
            <div key={i} ref={el => { lineEls.current[i] = el; }} className="relative" style={{ minHeight: LINE_H }}>
              <span
                className="absolute text-right select-none tabular-nums"
                style={{ right: `calc(100% + ${padLeft - gutterW + 10}px)`, width: gutterW - 24, color: i === caretLine ? th.numOn : th.num, fontSize: 11.5, fontWeight: i === caretLine ? 600 : 400 }}
              >
                {i + 1}
              </span>
              {current && i >= current.from && i <= current.to && (
                <span
                  className={`absolute inset-y-0 w-[3px] ${i === current.from ? 'rounded-t-full' : ''} ${i === current.to ? 'rounded-b-full' : ''}`}
                  style={{ left: gutterW - 6 - padLeft, background: E.accent }}
                />
              )}
              {line.length ? line.map((tok, j) => (
                <span key={j} style={{ color: palette[tok.kind] || palette.plain, fontStyle: tok.kind === 'comment' ? 'italic' : undefined }}>{tok.text}</span>
              )) : '\u200b'}
            </div>
          ))}
        </pre>
      </div>

      {onRun && current && arrowTop != null && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={runHere}
          title={`Run this statement (${MOD} Enter)`}
          aria-label="Run this statement"
          className="absolute z-10 left-[6px] flex items-center justify-center w-[18px] rounded hover:bg-black/10"
          style={{ top: arrowTop - scroll.top, height: LINE_H, color: E.accent }}
        >
          <Play size={11} fill="currentColor" strokeWidth={0} />
        </button>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={e => {
          typingRef.current = true;
          const next = e.target.value;
          const prev = shownRef.current ?? '';
          const added = next.length - prev.length;
          const ch = added === 1 ? next[e.target.selectionStart - 1] : '';
          const kind = nextKind.current || ((added === 1 && ch && !/\s/.test(ch)) || added === -1 ? 'type' : 'edit');
          onChange(next, kind);
          updateSuggest(e.target);
          trackCaret();
        }}
        readOnly={readOnly}
        onFocus={() => { topLevel().forEach(ensureObjects); onSelect?.(readSel()); }}
        onSelect={() => { trackCaret(); onSelect?.(readSel()); }}
        onClick={() => { typingRef.current = false; setSuggest(null); }}
        onBlur={() => { typingRef.current = false; setTimeout(() => setSuggest(null), 150); onSelect?.(null); }}
        onScroll={e => { setSuggest(null); setScroll({ top: e.target.scrollTop, left: e.target.scrollLeft }); }}
        onKeyDown={e => {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && e.key === 'Enter') { e.preventDefault(); typingRef.current = false; setSuggest(null); (e.shiftKey ? onRunAll : onRun)?.(); return; }
          if (readOnly) return;
          if (mod && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
            e.preventDefault();
            setSuggest(null);
            if (e.code === 'KeyY' || e.shiftKey) redo(); else undo();
            return;
          }
          const combo = [mod && 'mod', e.altKey && 'alt', e.shiftKey && 'shift', e.code].filter(Boolean).join('+');
          const cmd = {
            'mod+shift+KeyF': 'format',
            'mod+shift+KeyU': 'upper',
            'mod+shift+KeyL': 'lower',
            'mod+alt+KeyC': 'camel',
            'mod+alt+KeyP': 'pascal',
            'mod+alt+KeyS': 'snake',
            'mod+Slash': 'comment',
            'alt+shift+ArrowDown': 'duplicate',
            'alt+shift+ArrowUp': 'duplicate',
            'alt+ArrowUp': 'moveUp',
            'alt+ArrowDown': 'moveDown',
            'mod+shift+KeyK': 'deleteLine',
          }[combo];
          if (cmd) { e.preventDefault(); runCommand(cmd); return; }
          if (combo === 'mod+Space') { e.preventDefault(); updateSuggest(e.target, true); return; }
          if (combo === 'mod+KeyS') { e.preventDefault(); onSave?.(); return; }
          if (suggest) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSuggest(s => ({ ...s, index: (s.index + 1) % s.items.length })); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSuggest(s => ({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })); return; }
            if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); accept(suggest.items[suggest.index]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setSuggest(null); return; }
          }
          // Tab indents instead of leaving the editor. With several lines
          // selected it shifts all of them.
          if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target;
            const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
            if (e.shiftKey) runCommand('outdent');
            else if (multi) runCommand('indent');
            else replaceRange(ta.selectionStart, ta.selectionEnd, FMT_IND);
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        aria-label="SQL editor"
        className="relative z-[1] block w-full h-full m-0 border-0 bg-transparent text-transparent font-mono resize-none focus:outline-none whitespace-pre-wrap break-words overflow-auto"
        style={{ ...textStyle, caretColor: th.caret, '--sf-sel': th.sel, '--sf-ph': th.placeholder }}
      />
      <style>{`textarea[aria-label="SQL editor"]::selection{background:var(--sf-sel)} textarea[aria-label="SQL editor"]::placeholder{color:var(--sf-ph)}`}</style>
      {session && (
        <PeerLayer session={session} taRef={taRef} text={value || ''} width={innerW} scroll={scroll} colorOf={peerColor} nameOf={peerLabel} />
      )}

      {suggest && taRef.current && createPortal(
        <div
          ref={suggestRef}
          className="ds-pop fixed z-[1000] min-w-[240px] max-w-[540px] w-max overflow-y-auto rounded-lg border border-[#e8e6e3] bg-white py-1 shadow-[0_12px_32px_rgba(49,44,42,.18)] text-[12.5px] font-mono"
          style={{ ...sigVars(E), ...suggestBox(taRef.current, suggest, padLeft) }}
          role="listbox"
        >
          {suggest.items.map((item, i) => {
            const on = i === suggest.index;
            const [badge, color] = SUGGEST_BADGE[item.kind] || SUGGEST_BADGE.keyword;
            return (
              <div
                key={`${item.kind}-${item.source || ''}-${item.text}`}
                role="option"
                aria-selected={on}
                onMouseDown={e => { e.preventDefault(); accept(item); }}
                onMouseEnter={() => setSuggest(s => ({ ...s, index: i }))}
                className={`flex items-center gap-2.5 mx-1 px-2 h-[28px] rounded-md cursor-pointer ${on ? 'bg-[var(--sig-soft)] text-[#312c2a]' : 'text-[#4a423e]'}`}
              >
                <span className="w-[16px] h-[16px] flex-shrink-0 rounded-[4px] flex items-center justify-center text-[9.5px] font-bold text-white" style={{ background: color }}>{badge}</span>
                <span className="whitespace-nowrap">{item.text}</span>
                {item.pk && <span className="flex-shrink-0 text-[9px] font-bold text-[#a14a00]">PK</span>}
                {(item.detail || item.source) && (
                  <span className="ml-auto pl-4 flex-shrink-0 text-[10.5px] whitespace-nowrap text-[#766a63] font-johnson-text">
                    {item.source ? `${item.source}${item.detail ? ` · ${item.detail}` : ''}` : item.detail}
                  </span>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
});

/*
  Data Studio, Snowflake and Postgres panes (same component, see ENGINES).

  Layout follows Snowsight worksheets with a DBeaver flavour: object tree on
  the left, worksheet tabs across the top, SQL editor over a result grid, and
  a status bar at the bottom. Each worksheet tab keeps its own result view, so
  switching tabs brings back what that tab last returned.

  URL: ?pane=snowflake&ws=<worksheet id>  for a worksheet
       ?pane=snowflake&db=..&schema=..&table=..  for the data editor
  The URL is the source of truth for the open tab whenever it points at one,
  so links and reloads land on the same place.
*/

const lsKeys = (p) => ({
  tabs: `${p}.tabs`,
  activeTab: `${p}.activeTab`,
  theme: `${p}.editorTheme`,
  pageSize: `${p}.pageSize`,
  explorer: `${p}.explorerCollapsed`,
  explorerW: `${p}.explorerWidth`,
  editorH: `${p}.editorHeight`,
  layout: `${p}.layout`,
  editorW: `${p}.editorWidth`,
  colStats: `${p}.columnStats`,
});

const readLocal = (key, fallback = null) => {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const writeLocal = (key, value) => {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
};

const EMPTY_VIEW = {
  status: 'idle', // idle | starting | running | success | failed | cancelled
  jobId: null,
  meta: null,
  error: null,
  sql: '',
  startedAt: null,
  rows: [],
  columns: [],
  page: 1,
  totalPages: 1,
  rowCount: null,
  sort: [],
  filters: [],
  widths: {},
  loading: false,
  tableMeta: null,
  keyColumns: [],
  edits: {},
  deleted: [],
  newRows: [],
  rowSel: [],
  editTarget: null, // { database, schema, table } when a query result is being edited
  ranBy: null,      // shared worksheet: who started this run, when it wasn't us
  stuckJob: null,   // Postgres: an earlier run still holding this worksheet, offered to cancel
  run: null,        // a multi-statement run: { jobId, meta, sql }; jobId/meta above are the statement on screen
};

const newQueryTab = (n) => ({ id: `q${Date.now().toString(36)}${n}`, kind: 'query', name: `Worksheet ${n}`, sql: '' });
const newCopierTab = () => ({ id: `copier${Date.now().toString(36)}`, kind: 'copier', name: 'Table Copier' });
const sameTable = (t, db, schema, table) => t.kind === 'data' && t.table.database === db && t.table.schema === schema && t.table.table === table;

// Result views that read the loaded rows, beside the grid itself.
const LOOK_VIEWS = new Set(['record', 'profile', 'chart', 'pivot']);

const EXPLORER_MIN = 220;
const EXPLORER_MAX = 520;

/* --------------------------- small local pieces --------------------------- */

function Menu({ open, onClose, children, align = 'right' }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = () => onClose();
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <Floating
      align={align}
      className="min-w-[170px] py-1 bg-white border border-[#e8e6e3] rounded-lg shadow-[0_12px_32px_rgba(49,44,42,.16)] font-johnson-text"
      onClick={e => e.stopPropagation()}
    >
      {children}
    </Floating>
  );
}

const MenuItem = ({ children, onClick, hint }) => (
  <button onClick={onClick} className="w-full flex items-center gap-3 px-3 h-8 text-left text-[12.5px] text-[#312c2a] hover:bg-[#f4f2f0]">
    <span className="flex-1">{children}</span>
    {hint && <span className="text-[11px] text-[#766a63]">{hint}</span>}
  </button>
);

function SubTab({ active, onClick, icon, children, count, title }) {
  const IconCmp = icon;
  return (
    <button
      onClick={onClick}
      title={title}
      role="tab"
      aria-selected={active}
      className={`relative h-full flex items-center gap-1.5 px-1 text-[12.5px] whitespace-nowrap transition-colors ${
        active ? 'text-[#312c2a] font-bold' : 'text-[#6e6259] hover:text-[#312c2a]'
      }`}
    >
      <IconCmp size={14} strokeWidth={2} className={active ? 'text-[var(--sig-ink)]' : ''} />
      {children}
      {count != null && <span className="ml-0.5 px-1.5 rounded-full bg-[#f1efed] text-[10.5px] font-medium text-[#6e6259] tabular-nums">{count}</span>}
      {active && <span className="absolute left-0 right-0 bottom-0 h-[2px] rounded-full bg-[var(--sig)]" />}
    </button>
  );
}

function DetailRow({ label, children, mono }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-4 py-2.5 border-b border-[#f1efed] text-[12.5px]">
      <div className="text-[#6e6259]">{label}</div>
      <div className={`min-w-0 break-words text-[#312c2a] ${mono ? 'font-mono text-[12px]' : ''}`}>{children}</div>
    </div>
  );
}

/* ================================ the pane ================================ */

// Tooltips for the whole pane, same look and feel as IND/CTA Data Quality:
// a white card that follows the pointer. Picks up the normal title="" on any
// element (moved to data-tip on first hover so the browser's own one doesn't
// show too). Rendered into document.body so scroll areas can't clip it.
// Only tip when it adds something: the text is cut off, or there is no text
// at all (icon-only buttons). Fully visible labels and values get nothing.
const tipNeeded = (el) => {
  // A dropdown's own text doesn't report overflow, so its title always shows.
  if (el.tagName === 'SELECT') return true;
  const nodes = [el, ...el.querySelectorAll('.truncate, input, [class*="line-clamp"]')];
  if (nodes.some(n => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)) return true;
  if (el.hasAttribute('data-cell')) return false;
  return !(el.innerText || el.value || '').trim();
};

function TipLayer({ children }) {
  const [text, setText] = useState(null);
  const boxRef = useRef(null);
  const elRef = useRef(null);
  const at = useRef({ x: 0, y: 0 });
  const size = useRef({ w: 0, h: 0 });
  const frame = useRef(0);
  // The tip keeps its words while it fades out, instead of an empty box.
  const lastText = useRef('');
  if (text) lastText.current = text;

  // size is measured once per new text, moves are batched to one per frame
  const place = useCallback(() => {
    frame.current = 0;
    const t = boxRef.current;
    if (!t) return;
    const { w, h } = size.current, vw = window.innerWidth, vh = window.innerHeight;
    const { x: px, y: py } = at.current;
    let x = px + 14, y = py + 16;
    if (x + w > vw - 10) x = px - w - 14;
    if (y + h > vh - 10) y = py - h - 12;
    t.style.transform = `translate(${Math.max(4, x)}px,${Math.max(4, y)}px)`;
  }, []);

  useLayoutEffect(() => {
    if (!text) return;
    if (boxRef.current) size.current = { w: boxRef.current.offsetWidth, h: boxRef.current.offsetHeight };
    place();
  }, [text, place]);

  const hide = useCallback(() => { elRef.current = null; setText(null); }, []);
  // Once you click something its tip has done its job; it stays away until
  // the pointer leaves that element.
  const pressed = useRef(null);

  const onOver = (e) => {
    let el = e.target.closest?.('[title], [data-tip]');
    if (el && el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.removeAttribute('title');
      if (t) el.setAttribute('data-tip', t);
    }
    let tip = el?.getAttribute('data-tip') || null;
    if (tip && !tipNeeded(el)) tip = null;
    // Cut-off text with no title of its own shows itself in full.
    const cut = !tip && e.target.closest?.('.truncate, [class*="line-clamp"]');
    if (cut && (cut.scrollWidth > cut.clientWidth + 1 || cut.scrollHeight > cut.clientHeight + 1)) {
      el = cut;
      const full = (cut.value ?? cut.textContent).trim();
      tip = full ? (full.length > 900 ? `${full.slice(0, 900)}...` : full) : null;
    }
    if (el === elRef.current) return;
    if (el && pressed.current && pressed.current.contains(el)) return;
    elRef.current = el;
    if (tip && tip.length > 300) tip = `${tip.slice(0, 300)}…`;
    at.current = { x: e.clientX, y: e.clientY };
    setText(tip);
  };

  const onMove = (e) => {
    if (!elRef.current) return;
    at.current = { x: e.clientX, y: e.clientY };
    if (!frame.current) frame.current = requestAnimationFrame(place);
  };

  const onOut = (e) => {
    if (pressed.current && !pressed.current.contains(e.relatedTarget)) pressed.current = null;
    if (elRef.current && !elRef.current.contains(e.relatedTarget)) hide();
  };
  const onDown = () => { pressed.current = elRef.current; hide(); };

  useEffect(() => {
    if (!text) return undefined;
    const evs = [['scroll', true], ['wheel', true], ['pointerdown', true], ['keydown', true], ['resize', false], ['blur', false]];
    evs.forEach(([n, c]) => window.addEventListener(n, hide, c));
    // the element can disappear under the pointer without any pointer event
    const gone = setInterval(() => { if (!elRef.current?.isConnected) hide(); }, 300);
    return () => {
      evs.forEach(([n, c]) => window.removeEventListener(n, hide, c));
      clearInterval(gone);
    };
  }, [text, hide]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div className="contents" onPointerOver={onOver} onPointerMove={onMove} onPointerOut={onOut} onPointerDownCapture={onDown}>
      {children}
      {createPortal(
        <div
          ref={boxRef}
          role="tooltip"
          aria-hidden={!text}
          style={{ position: 'fixed', left: 0, top: 0, zIndex: 10000, opacity: text ? 1 : 0, boxShadow: '0 18px 40px -16px rgba(49,44,42,.35)' }}
          className="pointer-events-none max-w-[290px] px-3 py-2.5 rounded-xl border border-jj-gray-08 bg-jj-gray-08 text-white text-[12.5px] leading-[1.45] font-johnson-text whitespace-pre-line [overflow-wrap:anywhere] transition-opacity duration-100"
        >
          {text || lastText.current}
        </div>,
        document.body
      )}
    </div>
  );
}

export default function SnowflakePane({ engine = 'snowflake', ...props }) {
  return (
    <EngineCtx.Provider value={ENGINES[engine]}>
      <TipLayer>
        <div className="contents" style={sigVars(ENGINES[engine])}>
          <StudioPane {...props} />
        </div>
      </TipLayer>
    </EngineCtx.Provider>
  );
}

export const PostgresPane = (props) => <SnowflakePane {...props} engine="postgres" />;

function StudioPane({ active: paneActive = true }) {
  const E = useEngine();
  // Snowflake has its own write / copy permissions, Postgres doesn't (yet).
  // The server checks these too, this just hides what would 403.
  const { hasPermission } = useRBAC();
  const isSf = E.id === 'snowflake';
  const canWrite = !isSf || hasPermission('writeSnowflake');
  const canCopy = isSf && hasPermission('copySnowflakeTables');
  const allRoles = !isSf || hasPermission('useAllSnowflakeRoles');
  const LS = useMemo(() => lsKeys(E.store), [E.store]);
  const logInPage = useInPageLog();
  const { toasts, push: toast, dismiss } = useToasts();
  const [params, setParams] = useSearchParams();
  const isWide = useMediaQuery('(min-width: 1024px)');

  /* ------------------------------ connection ------------------------------ */
  const [connState, setConnState] = useState('checking'); // checking | ready | unconfigured | error
  const [connError, setConnError] = useState(null);
  const [serverInfo, setServerInfo] = useState(null);

  const checkConnection = useCallback(() => {
    setConnState('checking');
    setConnError(null);
    fetchJson(`${E.api}/health`)
      .then(data => { setServerInfo(data); setConnState('ready'); })
      .catch(err => {
        setConnError(err.message);
        setConnState(err.status === 503 && err.body?.detail ? 'unconfigured' : 'error');
      });
  }, []);
  useEffect(() => { checkConnection(); }, [checkConnection]);

  /* ------------------------------ worksheets ------------------------------ */
  const [tabs, setTabs] = useState(() => {
    try {
      const stored = JSON.parse(readLocal(LS.tabs, 'null'));
      if (Array.isArray(stored) && stored.length) return stored;
    } catch { /* fall through */ }
    return [newQueryTab(1)];
  });
  const [fallbackId, setFallbackId] = useState(() => readLocal(LS.activeTab, '') || null);

  const urlWs = params.get('ws');
  const urlDb = params.get('db');
  const urlSchema = params.get('schema');
  const urlTable = params.get('table');

  // The URL decides when it points at a tab we have; otherwise the last tab used.
  const urlTab = paneActive
    ? (urlTable ? tabs.find(t => sameTable(t, urlDb, urlSchema, urlTable)) : tabs.find(t => t.id === urlWs))
    : null;
  const active = urlTab || tabs.find(t => t.id === fallbackId) || tabs[0];
  const activeIdRef = useRef(active.id);
  activeIdRef.current = active.id;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const sharedLinkRef = useRef(null);
  // Shared worksheets closed in this page. The URL can still point at one for
  // a moment after its tab closes; it must not be reopened from the link.
  const closedSharedRef = useRef(new Set());
  // Once the URL has moved on, a later link to it opens it as usual.
  useEffect(() => {
    closedSharedRef.current.forEach(id => { if (id !== urlWs) closedSharedRef.current.delete(id); });
  }, [urlWs]);
  const [sharedLinkTick, setSharedLinkTick] = useState(0);

  useEffect(() => {
    if (fallbackId !== active.id) setFallbackId(active.id);
  }, [active.id, fallbackId]);

  useEffect(() => {
    writeLocal(LS.tabs, JSON.stringify(tabs.filter(t => t.kind === 'query')));
    writeLocal(LS.activeTab, active.id);
  }, [tabs, active.id]);

  const writeUrl = useCallback((tab, push = false) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      ['ws', 'db', 'schema', 'table'].forEach(k => next.delete(k));
      if (tab.kind === 'data') {
        next.set('db', tab.table.database);
        next.set('schema', tab.table.schema);
        next.set('table', tab.table.table);
      } else {
        next.set('ws', tab.id);
      }
      return next;
    }, { replace: !push });
  }, [setParams]);

  const selectTab = useCallback((tab, push = false) => {
    setFallbackId(tab.id);
    if (paneActive) writeUrl(tab, push);
  }, [paneActive, writeUrl]);

  // Fill in or correct the URL when it doesn't point at a real tab.
  useEffect(() => {
    if (!paneActive) return;
    if (urlTable) return; // a table link, handled below once connected
    if (urlWs && tabs.some(t => t.id === urlWs)) return;
    if (urlWs?.startsWith('s_') && sharedLinkRef.current !== `failed:${urlWs}` && !closedSharedRef.current.has(urlWs)) return; // a shared link, opened below
    writeUrl(active);
  }, [paneActive, urlWs, urlTable, tabs, active, writeUrl, sharedLinkTick]);

  const [views, setViews] = useState({});
  const view = views[active.id] || EMPTY_VIEW;
  const patchView = useCallback((id, patch) => {
    setViews(v => ({ ...v, [id]: { ...(v[id] || EMPTY_VIEW), ...patch } }));
  }, []);
  const patchActive = useCallback((patch) => patchView(activeIdRef.current, patch), [patchView]);

  const viewsRef = useRef(views);
  viewsRef.current = views;

  const setTabSql = (id, sql) => setTabs(ts => ts.map(t => (t.id === id ? { ...t, sql } : t)));
  const queryText = active.sql || '';

  // Shared worksheets (tab.shared = the worksheet's id on the server). Each
  // has a session that keeps its text in step with the other people in it;
  // see collab/sharedSession.js. Everything further down that changes a
  // worksheet's text goes through editSql so the others get it too.
  const sessionsRef = useRef(new Map());
  const sessionOf = (id) => sessionsRef.current.get(id) || null;
  const sharedOf = (id) => tabsRef.current.find(t => t.id === id)?.shared || null;
  const [, bumpShared] = useState(0);
  const session = active.shared ? sessionOf(active.id) : null;
  const sharedRole = session?.meta?.role || null;
  // A shared worksheet can't be typed in until its text has arrived, or at all with view-only access.
  const lockedTab = Boolean(active.shared) && !session?.canEdit();
  const editSql = (id, sql) => {
    const s = sessionOf(id);
    if (s) {
      if (!s.canEdit()) return;
      s.edit(sql, id === activeIdRef.current ? editorRef.current?.getSelection() : undefined);
    }
    setTabSql(id, sql);
  };
  // Name, database and schema of a shared worksheet are everyone's.
  const patchShared = (id, body) => {
    const ws = sharedOf(id);
    if (!ws || !sessionOf(id)?.canEdit()) return;
    fetchJson(`/api/studio/shared/${ws}`, { method: 'PATCH', body }).catch(err => toast(err.message || 'Could not update the shared worksheet', 'error'));
  };

  // Each worksheet has its own database, login (conn) and role. Kept in a ref
  // too, so a tab created a moment ago is already right when its query starts.
  const metaRef = useRef({});
  tabs.forEach(t => { metaRef.current[t.id] = { database: t.database, schema: t.schema, conn: t.conn, role: t.role }; });
  const connections = serverInfo?.connections || [];
  const connOf = (id) => {
    const c = metaRef.current[id]?.conn;
    return connections.some(x => x.id === c) ? c : serverInfo?.conn_id || null;
  };
  const roleOf = (id) => (allRoles ? metaRef.current[id]?.role || null : null);
  const connInfo = (id) => connections.find(x => x.id === connOf(id)) || null;
  const dbOf = (id) => metaRef.current[id]?.database || connInfo(id)?.default_database || serverInfo?.default_database || null;
  // Picked schema, else the config default while still on the config database.
  const schemaOf = (id) => metaRef.current[id]?.schema
    || (metaRef.current[id]?.database ? null : connInfo(id)?.default_schema || serverInfo?.default_schema || null);
  // conn_id=..&role=.. for the calls that depend on who is logged in.
  const cqOf = (id) => {
    const q = new URLSearchParams();
    if (connections.length > 1 && connOf(id)) q.set('conn_id', connOf(id));
    if (roleOf(id)) q.set('role', roleOf(id));
    return q.toString();
  };
  // useCallbacks below read this so they never send a stale login (conn_id).
  const cqRef = useRef(cqOf);
  cqRef.current = cqOf;
  const tabDb = dbOf(active.id);
  const tabSchema = schemaOf(active.id);
  const activeConn = connInfo(active.id);
  const activeRole = roleOf(active.id) || activeConn?.role || serverInfo?.role || null;
  const cq = cqOf(active.id);
  const writesOk = canWrite && (activeConn?.allow_writes ?? serverInfo?.allow_writes) !== false;
  const setTabMeta = (id, patch) => {
    metaRef.current[id] = { ...(metaRef.current[id] || {}), ...patch };
    setTabs(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)));
  };
  const setTabDb = (id, database) => {
    if (!database) return;
    setTabMeta(id, { database, schema: undefined });
    patchShared(id, { database, schema: null });
  };
  const setTabSchema = (id, schema) => {
    setTabMeta(id, { schema: schema || undefined });
    patchShared(id, { schema: schema || null });
  };
  // A new login starts on its own default database, schema and role.
  const setTabConn = (id, conn) => setTabMeta(id, { conn, role: undefined, database: undefined, schema: undefined });
  const setTabRole = (id, role) => setTabMeta(id, { role: role || undefined });

  const [dbLists, setDbLists] = useState({});
  const dbList = dbLists[cq] || [];
  useEffect(() => {
    if (connState !== 'ready' || dbLists[cq]) return;
    fetchJson(withQs(`${E.api}/databases`, cq)).then(d => setDbLists(m => ({ ...m, [cq]: d.databases || [] }))).catch(() => {});
  }, [E.api, connState, cq, dbLists]);

  // Snowflake schema dropdown, per login/role and database.
  const [schemaLists, setSchemaLists] = useState({});
  const schemaKey = `${cq}|${tabDb || ''}`;
  const schemaList = schemaLists[schemaKey] || [];
  useEffect(() => {
    if (E.pickDb || connState !== 'ready' || !tabDb || schemaLists[schemaKey]) return;
    fetchJson(withQs(`${E.api}/schemas?database=${encodeURIComponent(tabDb)}`, cq))
      .then(d => setSchemaLists(m => ({ ...m, [schemaKey]: d.schemas || [] })))
      .catch(() => setSchemaLists(m => ({ ...m, [schemaKey]: [] })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [E.pickDb, E.api, connState, schemaKey]);

  // Snowflake role dropdown: the roles of every connection in one list.
  // Picking a role picks the connection it belongs to.
  const [rolesByConn, setRolesByConn] = useState({});
  const activeConnId = connOf(active.id);
  const roleOptions = connections.flatMap(c => (allRoles ? rolesByConn[c.id] || c.roles || [] : [c.role].filter(Boolean)).map(role => ({ conn: c.id, role })));
  const activeRoleKey = `${activeConnId}|${activeRole || ''}`;
  if (activeRole && !roleOptions.some(o => `${o.conn}|${o.role}` === activeRoleKey)) roleOptions.unshift({ conn: activeConnId, role: activeRole });
  // Same role name under two logins: add the user so they can be told apart.
  const roleLabel = (o) => (roleOptions.filter(x => x.role === o.role).length > 1
    ? `${o.role} (${connections.find(c => c.id === o.conn)?.user || o.conn})` : o.role);
  const pickRole = (id, key) => {
    const [conn, role] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    if (conn !== connOf(id)) setTabMeta(id, { conn, role, database: undefined, schema: undefined });
    else setTabRole(id, role);
  };
  useEffect(() => {
    if (E.pickDb || connState !== 'ready') return;
    connections.filter(c => !rolesByConn[c.id]).forEach(c => {
      const q = connections.length > 1 ? `?conn_id=${encodeURIComponent(c.id)}` : '';
      fetchJson(`${E.api}/roles${q}`)
        .then(d => setRolesByConn(m => ({ ...m, [c.id]: d.roles || [] })))
        .catch(() => setRolesByConn(m => ({ ...m, [c.id]: [] })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [E.pickDb, E.api, connState, connections.length]);

  const addTab = (sql = '', name, database) => {
    const n = tabs.filter(t => t.kind === 'query').length + 1;
    // A new worksheet keeps the login and role of the one you were on.
    const inherit = { conn: metaRef.current[active.id]?.conn, role: metaRef.current[active.id]?.role };
    const tab = { ...newQueryTab(n), sql, ...(name ? { name } : {}), ...(database ? { database } : {}), ...inherit };
    metaRef.current[tab.id] = { database, ...inherit };
    setTabs(ts => [...ts, tab]);
    selectTab(tab);
    return tab;
  };

  const addCopierTab = () => {
    const existing = tabs.find(t => t.kind === 'copier');
    if (existing) { selectTab(existing); return; }
    const tab = newCopierTab();
    setTabs(ts => [...ts, tab]);
    selectTab(tab);
  };

  const closeArmed = useRef(null);
  const closeTab = (id) => {
    // Unsaved row edits would be lost: the first close asks, the second within a few seconds closes.
    const pending = viewsRef.current[id];
    const unsaved = pending ? Object.keys(pending.edits || {}).length + (pending.deleted || []).length + (pending.newRows || []).length : 0;
    if (unsaved && closeArmed.current !== id) {
      closeArmed.current = id;
      setTimeout(() => { if (closeArmed.current === id) closeArmed.current = null; }, 4000);
      toast(`${plural(unsaved, 'unsaved change')} in this tab. Close it again to discard ${unsaved === 1 ? 'it' : 'them'}.`, 'error', 4000);
      return;
    }
    closeArmed.current = null;
    const idx = tabs.findIndex(t => t.id === id);
    const next = tabs.filter(t => t.id !== id);
    const list = next.length ? next : [newQueryTab(1)];
    setTabs(list);
    stopPolling(id);
    // A query still running in a closed worksheet would run on to the end for nobody.
    const v = viewsRef.current[id];
    if (v?.jobId && (v.status === 'running' || v.status === 'starting') && !v.ranBy) {
      apiFetch(`${E.api}/query/${v.jobId}/cancel`, { method: 'POST' }).catch(() => {});
    }
    runSeqRef.current[id] = (runSeqRef.current[id] || 0) + 1;
    // A shared worksheet stays on the server; this only closes the tab.
    if (tabsRef.current.find(t => t.id === id)?.shared) closedSharedRef.current.add(id);
    sessionOf(id)?.destroy();
    sessionsRef.current.delete(id);
    delete seenMetaRef.current[id];
    // Postgres keeps a session per worksheet; let it go with the tab. Not for a
    // shared worksheet: the last result run there lives on that session and
    // the others may still be looking at it (it closes itself when idle).
    if (E.pickDb && !tabsRef.current.find(t => t.id === id)?.shared) apiFetch(`${E.api}/session/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    setViews(v => { const n = { ...v }; delete n[id]; return n; });
    if (id === active.id) selectTab(list[Math.max(0, Math.min(idx, list.length) - 1)] || list[0]);
  };

  const [renaming, setRenaming] = useState(null);
  const commitRename = (id, name) => {
    const clean = name.trim();
    if (clean && !(sharedOf(id) && !sessionOf(id)?.canEdit())) {
      setTabs(ts => ts.map(t => (t.id === id ? { ...t, name: clean.slice(0, 60) } : t)));
      patchShared(id, { name: clean.slice(0, 60) });
    }
    setRenaming(null);
  };

  /* -------------------------------- layout -------------------------------- */
  const [explorerCollapsed, setExplorerCollapsed] = useState(() => readLocal(LS.explorer) === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [explorerW, setExplorerW] = useState(() => {
    const n = parseInt(readLocal(LS.explorerW, ''), 10);
    return Number.isFinite(n) ? Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, n)) : 288;
  });
  const showExplorer = isWide ? !explorerCollapsed : drawerOpen;
  const toggleExplorer = () => {
    if (!isWide) { setDrawerOpen(o => !o); return; }
    setExplorerCollapsed(c => { writeLocal(LS.explorer, c ? '0' : '1'); return !c; });
  };

  const startExplorerResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = explorerW;
    let last = startW;
    const onMove = (ev) => {
      last = Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, startW + ev.clientX - startX));
      setExplorerW(last);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      writeLocal(LS.explorerW, String(last));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const [editorTheme, setEditorTheme] = useState(() => (readLocal(LS.theme) === 'dark' ? 'dark' : 'light'));
  const toggleEditorTheme = () => setEditorTheme(t => {
    const next = t === 'dark' ? 'light' : 'dark';
    writeLocal(LS.theme, next);
    logInPage(`${E.log}_editor_theme`, `Switched the query editor to ${next} mode`);
    return next;
  });

  const workRef = useRef(null);
  // Until someone drags the divider, the editor takes a share of the window
  // (about 40%) instead of a fixed height, so a tall screen isn't left with a
  // ten line editor.
  const [workH, setWorkH] = useState(0);    // re-render once the work area has a height, and when it changes
  const [editorH, setEditorH] = useState(() => {
    const n = parseInt(readLocal(LS.editorH, ''), 10);
    return Number.isFinite(n) ? n : null;
  });
  const clampEditor = useCallback((h, known) => {
    const whole = known || workRef.current?.clientHeight || 700;
    return Math.max(180, Math.min(Math.max(180, whole - 220), h ?? Math.round(Math.max(whole < 640 ? 220 : 300, whole * 0.44))));
  }, []);
  // Editor over the whole work area, results tucked away. A run brings them back.
  const [editorMax, setEditorMax] = useState(false);
  // The other way round: results over the whole work area, editor tucked away.
  const [resultsMax, setResultsMax] = useState(false);
  const [colStats, setColStats] = useState(() => readLocal(LS.colStats) === '1');
  const toggleColStats = useCallback(() => setColStats(v => { writeLocal(LS.colStats, v ? '0' : '1'); return !v; }), [LS.colStats]);
  // Editor above the results, or beside them on a wide screen.
  const [layout, setLayout] = useState(() => (readLocal(LS.layout) === 'side' ? 'side' : 'stacked'));
  const sideBySide = layout === 'side' && isWide;
  const pickLayout = (next) => setLayout(l => {
    if (l === next) return l;
    writeLocal(LS.layout, next);
    logInPage(`${E.log}_layout`, next === 'side' ? 'Put the editor beside the results' : 'Put the editor above the results');
    return next;
  });
  const [editorW, setEditorW] = useState(() => {
    const n = parseInt(readLocal(LS.editorW, ''), 10);
    return Number.isFinite(n) ? n : 560;
  });
  const startEditorWidthResize = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = editorW, whole = workRef.current?.clientWidth || 1200;
    let last = startW;
    const onMove = (ev) => { last = Math.max(340, Math.min(whole - 380, startW + ev.clientX - startX)); setEditorW(last); };
    const onUp = () => {
      document.body.style.cursor = '';
      writeLocal(LS.editorW, String(last));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const startEditorResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH ?? clampEditor(null);
    let last = startH;
    const onMove = (ev) => { last = clampEditor(startH + ev.clientY - startY); setEditorH(last); };
    const onUp = () => {
      document.body.style.cursor = '';
      writeLocal(LS.editorH, String(last));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'row-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  // Keep the editor from swallowing the results on short windows.
  // Watched with a ResizeObserver so render never has to read the height itself.
  const [workEl, setWorkEl] = useState(null);
  const workRefCb = useCallback((el) => { workRef.current = el; setWorkEl(el); }, []);
  useEffect(() => {
    if (!workEl) return undefined;
    // A height nobody picked stays unset, so it keeps following the window.
    const ro = new ResizeObserver(([e]) => {
      const h = Math.round(e.contentRect.height);
      setWorkH(h);
      setEditorH(v => (v === null ? v : clampEditor(v, h)));
    });
    ro.observe(workEl);
    return () => ro.disconnect();
  }, [workEl, clampEditor]);

  const resultsRef = useRef(null);
  // Worksheet tabs: fade the edge only when some are scrolled out of sight,
  // and keep the active one in view.
  const [tabStrip, setTabStrip] = useState(null);
  const stripW = useWidth(tabStrip);
  // Measured after layout, not during render: reading scrollWidth in render
  // forces a full layout on every keystroke.
  const [tabsCut, setTabsCut] = useState(false);
  useLayoutEffect(() => {
    if (tabStrip) setTabsCut(tabStrip.scrollWidth > stripW + 1);
  }, [tabStrip, stripW, tabs.length]);
  useEffect(() => {
    tabStrip?.querySelector('[role=tab][aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabStrip, active.id, tabs.length]);
  const [resultsEl, setResultsEl] = useState(null);
  const resultsW = useWidth(resultsEl);
  // Icons only when the labels would not fit beside the count and actions.
  const compactViews = sideBySide || (resultsW > 0 && resultsW < 1000);
  // A narrow results panel (side by side on a small screen): buttons go icon-only.
  const narrowResults = resultsW > 0 && resultsW < 640;
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === resultsRef.current && !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else resultsRef.current?.requestFullscreen?.();
  };

  const [resultTab, setResultTab] = useState('data'); // data | record | profile | chart | pivot | columns | details
  // The tab lights up at once; the view behind it (a chart, a pivot) renders right after, without blocking the click.
  const shownTab = useDeferredValue(resultTab);
  const [recIdx, setRecIdx] = useState(0);             // row shown in the record view
  const [chartBy, setChartBy] = useState(null);        // column the chart groups by

  /* -------------------------------- editor -------------------------------- */
  const editorRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  const closeCase = useCallback(() => setCaseOpen(false), []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const copyQueryText = async () => {
    if (!queryText.trim()) return;
    try {
      await navigator.clipboard.writeText(queryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { toast('Clipboard is not available here', 'error'); }
  };

  const [pageSize, setPageSize] = useState(() => {
    const stored = parseInt(readLocal(LS.pageSize, ''), 10);
    return PAGE_SIZE_OPTIONS.includes(stored) ? stored : 100;
  });
  const [cellDetail, setCellDetail] = useState(null);
  const [cellStats, setCellStats] = useState(null);    // the grid's selected block: count, sum, avg...
  // How to fetch the whole of a cell the grid only had the start of: by its
  // place in the result page, or in the data editor by primary key (Postgres).
  const cellLoader = (col, r) => {
    const tabId = active.id;
    const v = viewsRef.current[tabId] || EMPTY_VIEW;
    if (active.kind === 'data') {
      const pk = v.keyColumns || [];
      if (!E.pickDb || !pk.length) return undefined;
      const names = (v.columns || []).map(c => c.name);
      const key = Object.fromEntries(pk.map(k => [k, v.rows?.[r]?.[names.indexOf(k)]]));
      const t = active.table;
      return () => fetchJson(withQs(`${E.api}/table/cell`, cqRef.current(tabId)), {
        method: 'POST', body: { database: t.database, schema: t.schema, table: t.table, key, column: col },
      });
    }
    if (!v.jobId) return undefined;
    return () => fetchJson(`${E.api}/query/${v.jobId}/cell`, {
      method: 'POST', body: { page: v.page || 1, page_size: pageSize, sort: v.sort, filters: v.filters, index: r, column: col },
    });
  };

  /* --------------------------- history / saved --------------------------- */
  const [panel, setPanel] = useState(null); // history | saved | null
  const [tableInfo, setTableInfo] = useState(null);   // the table in the details panel
  const openDetails = (info) => { setPanel(null); setTableInfo(info); };
  useEffect(() => {
    if (!tableInfo) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) setTableInfo(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tableInfo]);
  const [history, setHistory] = useState({ status: 'idle', items: [], error: null });
  const [saved, setSaved] = useState({ status: 'idle', items: [], error: null });
  const [panelFilter, setPanelFilter] = useState('');
  const [savePromptOpen, setSavePromptOpen] = useState(false);

  const loadHistory = useCallback(() => {
    setHistory(h => ({ ...h, status: 'loading', error: null }));
    fetchJson(`${E.api}/history?limit=50`)
      .then(data => setHistory({ status: 'ready', items: data.history || [], error: null }))
      .catch(err => setHistory(h => ({ ...h, status: 'error', error: err.message })));
  }, []);
  const loadSaved = useCallback(() => {
    setSaved(s => ({ ...s, status: 'loading', error: null }));
    fetchJson(`${E.api}/saved`)
      .then(data => setSaved({ status: 'ready', items: data.saved || [], error: null }))
      .catch(err => setSaved(s => ({ ...s, status: 'error', error: err.message })));
  }, []);

  useEffect(() => {
    if (connState !== 'ready') return;
    loadHistory();
    loadSaved();
  }, [connState, loadHistory, loadSaved]);

  const recentQueries = useMemo(() => {
    const seen = new Set();
    return history.items.filter(h => {
      const k = (h.sql || '').trim();
      if (h.status !== 'success' || !k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 4);
  }, [history.items]);

  // Escape closes the history / saved drawer, unless a dialog on top has it.
  useEffect(() => {
    if (!panel) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog]')) setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  const openPanel = (which) => {
    setTableInfo(null);
    setPanelFilter('');
    setPanel(p => (p === which ? null : which));
    if (which === 'history') loadHistory(); else loadSaved();
  };

  /* --------------------------------- jobs --------------------------------- */
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePreview, setSavePreview] = useState(null);
  const [textModal, setTextModal] = useState(null);

  const pollRef = useRef({});
  const runSeqRef = useRef({});
  const stopPolling = (id) => {
    if (pollRef.current[id]) { clearTimeout(pollRef.current[id]); delete pollRef.current[id]; }
  };
  useEffect(() => () => Object.keys(pollRef.current).forEach(stopPolling), []);

  const pageSeq = useRef({});
  const fetchPage = useCallback(async (tabId, jid, pageNum, size, sortVal, filterVal, seq) => {
    const mine = (pageSeq.current[tabId] || 0) + 1;
    pageSeq.current[tabId] = mine;
    patchView(tabId, { loading: true });
    try {
      const data = await fetchJson(`${E.api}/query/${jid}/rows`, {
        method: 'POST',
        body: { page: pageNum, page_size: size, sort: sortVal, filters: filterVal },
      });
      if (mine !== pageSeq.current[tabId]) return;     // a newer page, sort or filter was asked for
      if (seq !== undefined && seq !== runSeqRef.current[tabId]) return;
      patchView(tabId, { rows: data.rows || [], page: data.page, rowCount: data.total_rows, totalPages: data.total_pages || 1, loading: false, rowSel: [] });
    } catch (err) {
      if (mine !== pageSeq.current[tabId]) return;
      if (seq !== undefined && seq !== runSeqRef.current[tabId]) return;
      // The result itself is gone (expired, or replaced by a newer run): say so
      // in the grid, once, instead of an empty grid and a toast per request.
      if (err.status === 410 || err.status === 404) {
        patchView(tabId, { loading: false, rows: [], status: 'failed', error: err.status === 404 ? 'This result has expired on the server. Run the query again.' : err.message });
        return;
      }
      patchView(tabId, { loading: false });
      toast(err.message || 'Could not load that page of rows', 'error');
    }
  }, [patchView, toast]);

  // Set when a save in result-edit mode re-runs the query, so editing turns
  // straight back on once the fresh rows land.
  const pendingEditRef = useRef({});
  const resumeEditRef = useRef(null);

  const applyFinished = useCallback((tabId, jid, data, seq, firstPage) => {
    const patch = { meta: data, rowCount: data.row_count };
    if ((data.statement_count || 1) > 1) patch.run = { jobId: jid, meta: data, sql: viewsRef.current[tabId]?.sql || '' };
    if (data.status === 'success') {
      patch.status = 'success';
      if (data.returns_rows && firstPage) {
        patch.rows = firstPage.rows || [];
        patch.page = firstPage.page || 1;
        patch.rowCount = firstPage.total_rows;
        patch.totalPages = firstPage.total_pages || 1;
      }
    } else if (data.status === 'failed') {
      patch.status = 'failed';
      patch.error = data.error || 'Query failed';
    } else {
      patch.status = data.status;
    }
    patchView(tabId, patch);
    if (data.status === 'success' && data.returns_rows && !firstPage) fetchPage(tabId, jid, 1, pageSize, [], [], seq);
    const resumeSql = pendingEditRef.current[tabId];
    delete pendingEditRef.current[tabId];
    if (resumeSql && data.status === 'success' && data.returns_rows) resumeEditRef.current?.(tabId, resumeSql, data.columns || []);
    loadHistory();
  }, [fetchPage, pageSize, loadHistory, patchView]);

  // Long-polls the job. A dropped request (network blip, proxy timeout, a
  // server restart in progress) is retried with backoff; the query is still
  // running on the server, so one bad request must not fail it on screen.
  const pollStatus = useCallback((tabId, jid, seq, misses = 0) => {
    pollRef.current[tabId] = setTimeout(async () => {
      try {
        const data = await fetchJson(`${E.api}/query/${jid}/status?wait_ms=10000`);
        if (seq !== runSeqRef.current[tabId]) return;
        if (data.status === 'running') { pollStatus(tabId, jid, seq); return; }
        applyFinished(tabId, jid, data, seq);
      } catch (err) {
        if (seq !== runSeqRef.current[tabId]) return;
        const gone = err.status === 404 || err.status === 403 || err.status === 401;
        if (!gone && misses < 6) { pollStatus(tabId, jid, seq, misses + 1); return; }
        patchView(tabId, { status: 'failed', error: gone ? 'The query result expired on the server. Run it again.' : err.message || 'Lost the connection while checking on the query' });
      }
    }, misses ? Math.min(8000, 400 * 2 ** misses) : 0);
  }, [applyFinished, patchView]);

  const submitQuery = async (tabId, sql, confirm) => {
    const seq = runSeqRef.current[tabId];
    try {
      const data = await fetchJson(withQs(`${E.api}/query`, cqOf(tabId)), {
        method: 'POST',
        body: {
          sql, confirm, wait_ms: 2500, page_size: pageSize,
          ...(E.pickDb ? { database: dbOf(tabId), session_id: tabId } : { database: dbOf(tabId), schema: schemaOf(tabId) }),
          // Run into a shared worksheet: the others get to read the result.
          ...(sharedOf(tabId) ? { shared_ws: sharedOf(tabId) } : {}),
        },
      });
      if (seq !== runSeqRef.current[tabId]) {
        // Cancelled (or run again) while this was starting: the server never
        // heard, so stop it now instead of letting it run to the end.
        if (data.job_id && data.status === 'running') apiFetch(`${E.api}/query/${data.job_id}/cancel`, { method: 'POST' }).catch(() => {});
        return;
      }
      logInPage(`${E.log}_query_run`, `Ran ${E.label} query${confirm ? ' (confirmed destructive)' : ''}: ${sql.slice(0, 300)}`);
      patchView(tabId, { jobId: data.job_id });
      if (data.status && data.status !== 'running') { applyFinished(tabId, data.job_id, data, seq, data.first_page); return; }
      patchView(tabId, { status: 'running' });
      pollStatus(tabId, data.job_id, seq);
    } catch (err) {
      if (seq !== runSeqRef.current[tabId]) return;
      if (err.status === 409 && err.body?.detail?.requires_confirmation) {
        setPendingConfirm({ ...err.body.detail, sql, tabId });
        patchView(tabId, { status: 'idle', startedAt: null });
      } else if (err.status === 409 && err.body?.detail?.running_job_id) {
        patchView(tabId, { status: 'failed', error: err.message, stuckJob: err.body.detail.running_job_id });
      } else {
        patchView(tabId, { status: 'failed', error: err.message || 'Could not start the query' });
      }
    } finally {
      setConfirming(false);
    }
  };

  const startRun = (tabId, sql, previousJobId) => {
    runSeqRef.current[tabId] = (runSeqRef.current[tabId] || 0) + 1;
    stopPolling(tabId);
    // Hand the old job's session back to the pool straight away.
    const runJob = viewsRef.current[tabId]?.run?.jobId;
    [...new Set([previousJobId, runJob].filter(Boolean))]
      .forEach(j => apiFetch(`${E.api}/query/${j}`, { method: 'DELETE' }).catch(() => {}));
    patchView(tabId, { ...EMPTY_VIEW, status: 'starting', sql, startedAt: Date.now() });
    setEditorMax(false);
    // A chart or pivot redraws for the new result, so stay on it.
    setResultTab(t => (LOOK_VIEWS.has(t) ? t : 'data'));
    setRecIdx(0);
    submitQuery(tabId, sql, false);
  };

  // Multi-statement run: each statement that returned rows can be opened.
  // Its result is a job of its own, so paging, sorting and downloads follow it.
  const runParts = useMemo(() => {
    const r = view.run;
    if (!r) return [];
    const spans = statementSpans(r.sql, E.upperIdents);
    const done = (r.meta.statements || []).map(st => ({ ...st, text: spans[st.index - 1] ? r.sql.slice(spans[st.index - 1].start, spans[st.index - 1].end).trim() : st.sql }));
    // The statement that failed, and the ones it stopped, aren't in the list.
    const total = r.meta.statement_count || done.length;
    const reached = done.length + 1;
    for (let i = reached; i <= total; i += 1) {
      const sp = spans[i - 1];
      const failed = i === reached && r.meta.status === 'failed';
      // The failed one opens the run itself, which is where its error is.
      done.push({ index: i, status: failed ? 'failed' : 'skipped', job_id: failed ? r.jobId : undefined, text: sp ? r.sql.slice(sp.start, sp.end).trim() : '' });
    }
    return done;
  }, [view.run, E.upperIdents]);
  const shownPart = runParts.find(p => p.job_id && p.job_id === view.jobId);

  const showPart = async (part) => {
    const tabId = active.id;
    const v = viewsRef.current[tabId] || EMPTY_VIEW;
    if (!v.run || !part.job_id || part.job_id === v.jobId) return;
    if (v.editTarget && Object.keys(v.edits || {}).length + (v.deleted || []).length + (v.newRows || []).length) {
      toast('Save or revert your edits to these rows first', 'info', 4000);
      return;
    }
    const seq = runSeqRef.current[tabId];
    const reset = { sort: [], filters: [], page: 1, rows: [], rowSel: [], widths: {}, editTarget: null, edits: {}, deleted: [], newRows: [], keyColumns: [], tableMeta: null };
    setRecIdx(0);
    if (part.job_id === v.run.jobId) {
      const m = v.run.meta;
      patchView(tabId, { ...reset, jobId: v.run.jobId, meta: m, sql: v.run.sql, rowCount: m.row_count, status: m.status, error: m.status === 'failed' ? m.error : null });
      if (m.status === 'success' && m.returns_rows) fetchPage(tabId, v.run.jobId, 1, pageSize, [], [], seq);
      return;
    }
    patchView(tabId, { ...reset, jobId: part.job_id, sql: part.text, rowCount: part.row_count, status: 'success', error: null, loading: true });
    try {
      const data = await fetchJson(`${E.api}/query/${part.job_id}/status`);
      if (seq !== runSeqRef.current[tabId] || viewsRef.current[tabId]?.jobId !== part.job_id) return;
      patchView(tabId, { meta: data, rowCount: data.row_count });
      fetchPage(tabId, part.job_id, 1, pageSize, [], [], seq);
    } catch (err) {
      if (seq !== runSeqRef.current[tabId]) return;
      patchView(tabId, { loading: false, status: 'failed', error: err.status === 404 ? 'This result has expired on the server. Run the query again.' : err.message });
    }
  };

  const busy = view.status === 'running' || view.status === 'starting';
  // A worksheet that hasn't run anything yet: the editor takes the room.
  const waiting = active.kind === 'query' && view.status === 'idle' && !sideBySide && !resultsMax && !editorMax;
  const editorFill = editorMax || waiting;
  // ranBy is set on a run someone else started in a shared worksheet. It is
  // shown like any other, but it is not ours to wait for or cancel.
  const ownBusy = busy && !view.ranBy;

  const runQuery = (sqlOverride) => {
    if (active.kind !== 'query' || ownBusy) return;
    if (lockedTab) {
      toast(sharedRole === 'view' ? 'You have view-only access to this shared worksheet' : 'Still connecting to the shared worksheet', 'info');
      return;
    }
    const sql = (typeof sqlOverride === 'string' ? sqlOverride : editorRef.current?.statement()) || queryText.trim();
    if (!sql) return;
    if (view.editTarget && Object.keys(view.edits || {}).length + (view.deleted || []).length + (view.newRows || []).length) {
      toast('Save or revert your edits to these rows before running again', 'info', 5000);
      return;
    }
    startRun(active.id, sql, view.jobId);
  };

  const runAll = () => runQuery(queryText.trim());
  const statementCount = useMemo(() => statementSpans(queryText, E.upperIdents).length, [queryText, E.upperIdents]);

  const cancelQuery = async () => {
    stopPolling(active.id);
    runSeqRef.current[active.id] = (runSeqRef.current[active.id] || 0) + 1;
    if (view.jobId) {
      logInPage(`${E.log}_query_cancel`, `Cancelled a running ${E.label} query (job ${view.jobId})`);
      try { await apiFetch(`${E.api}/query/${view.jobId}/cancel`, { method: 'POST' }); } catch { /* best effort */ }
    }
    patchActive({ status: 'cancelled', meta: { elapsed_ms: view.startedAt ? Date.now() - view.startedAt : null } });
  };

  const elapsed = useElapsed(busy, view.startedAt);

  /* --------------------------- shared worksheets --------------------------- */
  const seenMetaRef = useRef({});
  const stoppingRef = useRef(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [sharedMenu, setSharedMenu] = useState(null); // null = closed, else { status, items }
  const closeSharedMenu = useCallback(() => setSharedMenu(null), []);

  // Someone else ran a query in the worksheet: show their result here as well.
  // The job belongs to them; the server lets the people in the worksheet read it.
  const adoptRun = async (tabId, run, announce) => {
    const mine = (v) => v.jobId === run.job_id || ((v.status === 'running' || v.status === 'starting') && !v.ranBy);
    if (!run?.job_id || mine(viewsRef.current[tabId] || EMPTY_VIEW)) return;
    if (Date.now() / 1000 - run.at > 45 * 60) return; // the server only keeps a result that long
    let data;
    try { data = await fetchJson(`${E.api}/query/${run.job_id}/status`); } catch { return; }
    if (!sharedOf(tabId) || mine(viewsRef.current[tabId] || EMPTY_VIEW)) return;
    runSeqRef.current[tabId] = (runSeqRef.current[tabId] || 0) + 1;
    const seq = runSeqRef.current[tabId];
    stopPolling(tabId);
    // Our own run from another browser tab is not "someone else".
    const self = run.by && run.by === sessionOf(tabId)?.meta?.you;
    patchView(tabId, { ...EMPTY_VIEW, status: 'running', jobId: run.job_id, sql: run.sql, startedAt: run.at * 1000, ranBy: self ? 'you' : firstName(run.by_name || run.by) });
    if (announce && !self) toast(`${firstName(run.by_name || run.by)} ran a query`, 'info', 2500);
    if (data.status === 'running') pollStatus(tabId, run.job_id, seq);
    else applyFinished(tabId, run.job_id, data, seq);
  };

  // Swap a tab for one with another id (private <-> shared). Its result is
  // let go: on Postgres it lives on the old tab's connection.
  const rekeyTab = (oldId, next) => {
    stopPolling(oldId);
    metaRef.current[next.id] = metaRef.current[oldId];
    setTabs(ts => ts.map(t => (t.id === oldId ? next : t)));
    setViews(v => { const n = { ...v }; delete n[oldId]; return n; });
    if (E.pickDb) apiFetch(`${E.api}/session/${encodeURIComponent(oldId)}`, { method: 'DELETE' }).catch(() => {});
    if (activeIdRef.current === oldId) selectTab(next);
  };

  // Called by the sessions. Kept in a ref so a session made on an earlier
  // render still reaches the current state.
  const sharedHandlers = useRef({});
  sharedHandlers.current = {
    // Someone else's edit. The caret stays on the text it was on.
    text: (id, text, mapPos) => {
      const ed = id === activeIdRef.current ? editorRef.current : null;
      const sel = ed?.getSelection();
      flushSync(() => setTabSql(id, text));
      if (sel) ed.setSelection(mapPos(sel.a), mapPos(sel.h));
    },
    change: (id) => {
      const m = sessionOf(id)?.meta;
      if (m && seenMetaRef.current[id] !== m.meta_rev) {
        const first = seenMetaRef.current[id] === undefined;
        seenMetaRef.current[id] = m.meta_rev;
        const t = tabsRef.current.find(x => x.id === id);
        if (t && (t.name !== m.name || (t.database || null) !== m.database || (t.schema || null) !== m.schema)) {
          setTabMeta(id, { name: m.name, database: m.database || undefined, schema: m.schema || undefined });
        }
        adoptRun(id, m.last_run || {}, !first);
      }
      bumpShared(n => n + 1);
    },
    event: (id, ev) => {
      if (id === activeIdRef.current) toast(`${firstName(ev.name)} ${ev.type === 'join' ? 'joined' : 'left'}`, 'info', 2200);
    },
    // Edits that could not be merged are never thrown away: they go to a tab of their own.
    lost: (id, text, why) => {
      const t = tabsRef.current.find(x => x.id === id);
      const n = tabsRef.current.filter(x => x.kind === 'query').length + 1;
      setTabs(ts => [...ts, { ...newQueryTab(n), name: `${t?.name || 'Worksheet'} (my edits)`.slice(0, 60), sql: text, database: t?.database, conn: t?.conn, role: t?.role }]);
      const reason = why === 'view_only' ? 'You now have view-only access to this worksheet.'
        : why === 'too_large' ? 'The shared worksheet is at its size limit.'
          : 'Your latest edits could not be merged into the shared worksheet.';
      toast(`${reason} Your text is kept in a new private tab.`, 'error', 10000);
    },
    gone: (id, why) => {
      const t = tabsRef.current.find(x => x.id === id);
      sessionsRef.current.delete(id);
      delete seenMetaRef.current[id];
      if (!t) return;
      const stopped = stoppingRef.current.delete(t.shared);
      const n = tabsRef.current.filter(x => x.kind === 'query').length + 1;
      rekeyTab(id, { ...t, id: newQueryTab(n).id, shared: undefined, name: (stopped ? t.name : `${t.name} (copy)`).slice(0, 60) });
      if (stopped) toast(`Stopped sharing "${t.name}"`, 'success', 4000);
      else toast(`"${t.name}" is ${why === 'denied' ? 'not available to you any more' : 'no longer shared with you'}. Its text is kept here as a private copy.`, 'info', 10000);
    },
  };

  // Sessions follow the tabs: one per shared tab, gone when the tab is.
  useEffect(() => {
    const map = sessionsRef.current;
    return () => { map.forEach(s => s.destroy()); map.clear(); };
  }, []);
  useEffect(() => {
    const map = sessionsRef.current;
    tabs.forEach(t => {
      if (!t.shared || map.has(t.id)) return;
      const call = (name) => (...args) => sharedHandlers.current[name](t.id, ...args);
      map.set(t.id, new SharedSession(
        t.shared,
        { post: (path, body) => fetchJson(path, { method: 'POST', body }), stream: apiEventSource },
        { text: call('text'), change: call('change'), lost: call('lost'), gone: call('gone'), event: call('event') },
      ));
    });
    [...map.keys()].forEach(id => {
      if (!tabs.some(t => t.id === id)) { map.get(id).destroy(); map.delete(id); }
    });
  }, [tabs]);
  // Only the worksheet on screen holds a connection (a browser allows few).
  useEffect(() => {
    sessionsRef.current.forEach((s, id) => (paneActive && id === active.id ? s.connect() : s.disconnect()));
  }, [paneActive, active.id, tabs]);
  // The others see "is running a query" next to this person.
  useEffect(() => {
    if (active.shared) sessionOf(active.id)?.select(undefined, ownBusy ? 'running' : 'idle');
  }, [ownBusy, active.id, active.shared]);

  const openShared = async (wsId) => {
    const id = `s_${wsId}`;
    closedSharedRef.current.delete(id);       // opened on purpose again
    const have = tabsRef.current.find(t => t.id === id);
    if (have) { selectTab(have); return; }
    const snap = await fetchJson(`/api/studio/shared/${encodeURIComponent(wsId)}`);
    if (snap.meta.engine !== E.id) throw new Error(`That worksheet belongs to the ${ENGINES[snap.meta.engine]?.label || 'other'} pane`);
    const from = metaRef.current[activeIdRef.current] || {};
    const tab = { id, kind: 'query', shared: wsId, name: snap.meta.name, sql: snap.sql, database: snap.meta.database || undefined, schema: snap.meta.schema || undefined, conn: from.conn, role: from.role };
    metaRef.current[id] = { database: tab.database, schema: tab.schema, conn: tab.conn, role: tab.role };
    setTabs(ts => (ts.some(t => t.id === id) ? ts : [...ts, tab]));
    selectTab(tab);
  };

  // A link to a shared worksheet (?ws=s_<id>) that isn't open yet.
  useEffect(() => {
    if (!paneActive || !urlWs?.startsWith('s_') || tabs.some(t => t.id === urlWs)) return;
    if (sharedLinkRef.current === urlWs || sharedLinkRef.current === `failed:${urlWs}` || closedSharedRef.current.has(urlWs)) return;
    sharedLinkRef.current = urlWs;
    openShared(urlWs.slice(2))
      .then(() => { sharedLinkRef.current = null; })
      .catch(err => {
        sharedLinkRef.current = `failed:${urlWs}`;
        setSharedLinkTick(n => n + 1);
        toast(err.status === 404 ? 'That shared worksheet does not exist, or is not shared with you' : err.message || 'Could not open the shared worksheet', 'error', 8000);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneActive, urlWs, tabs]);

  const shareWorksheet = async () => {
    const id = active.id;
    if (active.kind !== 'query' || active.shared) return;
    if (ownBusy) throw new Error('Wait for the running query to finish, then share');
    const snap = await fetchJson('/api/studio/shared', {
      method: 'POST',
      body: { engine: E.id, name: active.name, sql: active.sql || '', database: active.database || null, schema: active.schema || null },
    });
    const now = tabsRef.current.find(t => t.id === id) || active;
    rekeyTab(id, { ...now, id: `s_${snap.meta.id}`, shared: snap.meta.id });
    logInPage(`${E.log}_share`, `Shared ${E.label} worksheet "${active.name}"`);
  };
  const sharedCall = async (method, path, body) => {
    const snap = await fetchJson(`/api/studio/shared/${active.shared}${path}`, { method, body });
    const s = sessionOf(active.id);
    if (s && snap?.meta) { s.meta = snap.meta; sharedHandlers.current.change(active.id); }
  };
  const inviteToShared = (email, canEdit, name = '') => sharedCall('PUT', '/members', { email, can_edit: canEdit, name });
  const removeFromShared = (email) => sharedCall('DELETE', `/members/${encodeURIComponent(email)}`);
  const stopSharing = async () => {
    stoppingRef.current.add(active.shared);
    try { await sharedCall('DELETE', ''); } catch (err) { stoppingRef.current.delete(active.shared); throw err; }
  };
  const openSharedMenu = () => {
    setSharedMenu({ status: 'loading', items: [] });
    fetchJson(`/api/studio/shared?engine=${E.id}`)
      .then(d => setSharedMenu(m => m && { status: 'ready', items: d.worksheets || [] }))
      .catch(err => setSharedMenu(m => m && { status: 'error', items: [], error: err.message }));
  };

  // One colour per person, the same on everyone's screen.
  const sharedMeta = session?.meta || null;
  const peerColor = (email) => {
    const order = sharedMeta ? [sharedMeta.owner.email, ...sharedMeta.members.map(m => m.email)] : [];
    return PEER_COLORS[Math.max(0, order.indexOf(email)) % PEER_COLORS.length];
  };
  const shareLink = (() => {
    if (!active.shared || typeof window === 'undefined') return '';
    const u = new URL(window.location.href);
    u.search = `?pane=${E.id}&ws=${active.id}`;
    return u.toString();
  })();

  /* ---------------------------- data editor tabs --------------------------- */
  const tablePageSeq = useRef({});
  const loadTablePage = useCallback(async (tabId, target, pageNum, size, sortVal, filterVal) => {
    // Only the latest request lands, however the answers come back.
    const seq = (tablePageSeq.current[tabId] || 0) + 1;
    tablePageSeq.current[tabId] = seq;
    patchView(tabId, { loading: true, error: null });
    try {
      const data = await fetchJson(withQs(`${E.api}/table/rows`, cqRef.current(tabId)), {
        method: 'POST',
        body: { database: target.database, schema: target.schema, table: target.table, page: pageNum, page_size: size, sort: sortVal, filters: filterVal },
      });
      if (seq !== tablePageSeq.current[tabId]) return;
      patchView(tabId, {
        columns: data.columns || [],
        rows: data.rows || [],
        tableMeta: { primary_key: data.primary_key || [], editable: data.editable },
        keyColumns: data.primary_key || [],
        page: data.page,
        rowCount: data.total_rows,
        totalPages: data.total_pages || 1,
        loading: false,
        status: 'success',
        rowSel: [],
      });
    } catch (err) {
      if (seq !== tablePageSeq.current[tabId]) return;
      patchView(tabId, { error: err.message || 'Could not read the table', loading: false, status: 'failed' });
    }
  }, [patchView]);

  const openDataEditor = (database, schema, tableName, { fromUrl = false } = {}) => {
    const existing = tabs.find(t => sameTable(t, database, schema, tableName));
    const inherit = { conn: metaRef.current[active.id]?.conn, role: metaRef.current[active.id]?.role };
    const tab = existing || { id: `d${Date.now().toString(36)}`, kind: 'data', name: tableName, table: { database, schema, table: tableName }, ...inherit };
    if (!existing) metaRef.current[tab.id] = inherit;
    if (!existing) setTabs(ts => [...ts, tab]);
    if (!fromUrl) selectTab(tab, true);
    if (!existing || !views[tab.id]?.columns?.length) {
      patchView(tab.id, { ...EMPTY_VIEW, loading: true });
      loadTablePage(tab.id, tab.table, 1, pageSize, [], []);
    }
    setResultTab('data');
    if (!isWide) setDrawerOpen(false);
    logInPage(`${E.log}_data_editor_open`, `Opened the data editor for ${database}.${schema}.${tableName}`);
  };

  // A table link opens the data editor once we're connected.
  useEffect(() => {
    if (!paneActive || connState !== 'ready' || !urlTable || !urlDb || !urlSchema) return;
    if (tabs.some(t => sameTable(t, urlDb, urlSchema, urlTable))) return;
    openDataEditor(urlDb, urlSchema, urlTable, { fromUrl: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneActive, connState, urlDb, urlSchema, urlTable]);

  // Leaving the page with unsaved row edits in any tab asks first.
  const anyUnsaved = Object.values(views).some(v => Object.keys(v.edits || {}).length || (v.deleted || []).length || (v.newRows || []).some(d => Object.values(d).some(x => x !== '' && x != null)));
  useEffect(() => {
    if (!anyUnsaved) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyUnsaved]);

  const dirtyCount = useMemo(
    () => Object.keys(view.edits || {}).length + (view.deleted || []).length + (view.newRows || []).length,
    [view.edits, view.deleted, view.newRows],
  );

  const columnMetaByName = useMemo(() => {
    const map = {};
    (view.columns || []).forEach(c => { map[c.name] = c; });
    return map;
  }, [view.columns]);

  const editCell = (rowIndex, col, value) => {
    const colIndex = (view.columns || []).findIndex(c => c.name === col);
    const raw = view.rows[rowIndex]?.[colIndex];
    const original = raw === null || raw === undefined ? '' : cellText(raw);
    const rowEdits = { ...(view.edits[rowIndex] || {}) };
    if (value === original) delete rowEdits[col]; else rowEdits[col] = value;
    const nextEdits = { ...view.edits };
    if (Object.keys(rowEdits).length === 0) delete nextEdits[rowIndex]; else nextEdits[rowIndex] = rowEdits;
    patchActive({ edits: nextEdits });
  };

  const isDataTab = (t) => t.kind === 'data';
  const rowOffsetOf = (r) => ((view.page || 1) - 1) * pageSize + r + 1;

  /* ----------------------- copy rows / duplicate guard ---------------------- */
  // Rows are compared on the primary key when there is one, otherwise on every
  // comparable column, the same way the backend finds a row to update.
  const matchCols = useMemo(() => {
    const cols = view.columns || [];
    if (view.keyColumns?.length) return view.keyColumns;
    return cols.filter(c => c.comparable !== false).map(c => c.name);
  }, [view.columns, view.keyColumns]);

  const norm = useCallback((name, v) => {
    if (v === null || v === undefined || v === '') return '\u0000';
    const meta = (view.columns || []).find(c => c.name === name);
    const fam = typeFamily(displayType(meta));
    const t = String(typeof v === 'object' ? cellText(v) : v).trim();
    if (fam === 'num' && t !== '' && Number.isFinite(Number(t))) return String(Number(t));
    if (fam === 'bool') return t.toLowerCase();
    return t;
  }, [view.columns]);

  const dupInfo = useMemo(() => {
    const out = { rows: {}, news: {}, count: 0 };
    if (!(isDataTab(active) || view.editTarget) || !matchCols.length || !view.rows?.length && !view.newRows?.length) return out;
    const idx = {};
    (view.columns || []).forEach((c, i) => { idx[c.name] = i; });
    const deletedSet = new Set(view.deleted || []);
    const seen = new Map();
    const keyLabel = view.keyColumns?.length ? view.keyColumns.join(', ') : null;
    view.rows.forEach((row, r) => {
      if (deletedSet.has(r)) return;
      const e = view.edits[r] || {};
      const sig = matchCols.map(n => norm(n, Object.prototype.hasOwnProperty.call(e, n) ? e[n] : row[idx[n]])).join('\u0001');
      if (seen.has(sig)) {
        if (view.edits[r]) { out.rows[r] = `Same ${keyLabel ? keyLabel : 'values'} as row ${rowOffsetOf(seen.get(sig))}`; out.count += 1; }
        else if (view.edits[seen.get(sig)]) { out.rows[seen.get(sig)] = `Same ${keyLabel ? keyLabel : 'values'} as row ${rowOffsetOf(r)}`; out.count += 1; }
      } else {
        seen.set(sig, r);
      }
    });
    const seenNew = new Map();
    (view.newRows || []).forEach((draft, i) => {
      if (!Object.values(draft).some(v => v !== '' && v !== undefined)) return;
      const sig = matchCols.map(n => norm(n, draft[n])).join('\u0001');
      if (seen.has(sig)) {
        out.news[i] = keyLabel ? `${keyLabel} already used by row ${rowOffsetOf(seen.get(sig))}` : `Identical to row ${rowOffsetOf(seen.get(sig))}. Change at least one value.`;
        out.count += 1;
      } else if (seenNew.has(sig)) {
        out.news[i] = `Same as new row ${seenNew.get(sig) + 1}`;
        out.count += 1;
      } else {
        seenNew.set(sig, i);
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, matchCols, norm, view.rows, view.edits, view.deleted, view.newRows, view.keyColumns, view.page, pageSize, view.editTarget]);

  const gridScrollRef = useRef(null);

  const copyRows = (indices) => {
    const list = [...indices].sort((a, b) => a - b).filter(r => view.rows[r]);
    if (!list.length) return;
    const cols = view.columns || [];
    const drafts = list.map(r => {
      const e = view.edits[r] || {};
      const d = {};
      cols.forEach((c, i) => {
        if (c.editable === false) return;
        const v = Object.prototype.hasOwnProperty.call(e, c.name) ? e[c.name] : view.rows[r][i];
        // Only the start of a big value is here; copying it would save a cut-off copy.
        d[c.name] = v === null || v === undefined || isBig(v) ? '' : cellText(v);
      });
      return d;
    });
    patchActive({ newRows: [...view.newRows, ...drafts], rowSel: [] });
    toast(
      `Copied ${plural(drafts.length, 'row')} to the bottom. ${view.keyColumns?.length ? `Give ${drafts.length === 1 ? 'it' : 'each'} a new ${view.keyColumns.join(', ')}` : 'Change at least one value in each'} before saving.`,
      'info', 6000,
    );
    focusNewRow(view.newRows.length);
  };

  // Brings a new row into view and puts the cursor in its first box.
  const focusNewRow = (i) => {
    requestAnimationFrame(() => {
      const el = gridScrollRef.current;
      const tr = el?.querySelector(`tr[data-newrow="${i}"]`);
      if (!tr) { if (el) el.scrollTop = el.scrollHeight; return; }
      tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      tr.querySelector('input')?.focus({ preventScroll: true });
    });
  };

  const addRow = () => {
    const blank = (view.newRows || []).findIndex(d => !Object.values(d).some(v => v !== '' && v !== undefined && v !== null));
    if (blank >= 0) {
      toast(`New row ${blank + 1} is still empty. Fill it in before adding another.`, 'info', 4000);
      focusNewRow(blank);
      return;
    }
    patchActive({ newRows: [...view.newRows, {}] });
    focusNewRow(view.newRows.length);
  };

  const lastPickRef = useRef(null);
  const selectRow = (r, e) => {
    const cur = new Set(view.rowSel || []);
    if (e.shiftKey && lastPickRef.current != null) {
      const [a, b] = [Math.min(lastPickRef.current, r), Math.max(lastPickRef.current, r)];
      for (let i = a; i <= b; i += 1) cur.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      if (cur.has(r)) cur.delete(r); else cur.add(r);
      lastPickRef.current = r;
    } else {
      const only = cur.size === 1 && cur.has(r);
      cur.clear();
      if (!only) cur.add(r);
      lastPickRef.current = r;
    }
    patchActive({ rowSel: [...cur] });
  };

  const toggleDelete = (rowIndex) => {
    const set = new Set(view.deleted);
    if (set.has(rowIndex)) set.delete(rowIndex); else set.add(rowIndex);
    patchActive({ deleted: [...set] });
  };

  const editNewCell = (i, col, value) => {
    patchActive({ newRows: view.newRows.map((row, idx) => (idx === i ? { ...row, [col]: value } : row)) });
  };

  const buildChanges = () => {
    const changes = [];
    const originalOf = (rowIndex) => {
      const row = view.rows[rowIndex];
      const obj = {};
      view.columns.forEach((c, i) => { obj[c.name] = row[i]; });
      return obj;
    };
    const deletedSet = new Set(view.deleted);
    Object.entries(view.edits).forEach(([rowIndex, rowEdits]) => {
      const idx = Number(rowIndex);
      if (deletedSet.has(idx)) return; // a delete wins over edits on the same row
      const values = {};
      Object.entries(rowEdits).forEach(([col, value]) => { values[col] = value === '' ? null : value; });
      changes.push({ kind: 'update', original: originalOf(idx), values });
    });
    deletedSet.forEach(idx => changes.push({ kind: 'delete', original: originalOf(idx) }));
    view.newRows.forEach(draft => {
      const values = {};
      Object.entries(draft).forEach(([col, value]) => { if (value !== '' && value !== undefined) values[col] = value; });
      if (Object.keys(values).length) changes.push({ kind: 'insert', values });
    });
    return changes;
  };

  const editTable = active.kind === 'data' ? active.table : view.editTarget;

  const mutate = (changes, confirm) => fetchJson(withQs(`${E.api}/table/mutate`, cq), {
    method: 'POST',
    body: {
      database: editTable.database,
      schema: editTable.schema,
      table: editTable.table,
      changes,
      key_columns: view.keyColumns.length ? view.keyColumns : null,
      ...(confirm ? { confirm: true } : {}),
    },
  });

  const previewSave = async () => {
    if (dupInfo.count) {
      toast(`${plural(dupInfo.count, 'row')} would duplicate another row. Change the highlighted rows first.`, 'error', 7000);
      return;
    }
    const changes = buildChanges();
    if (!changes.length) { toast('Nothing to save yet. Empty new rows are skipped.', 'info'); return; }
    setSaving(true);
    try {
      const data = await mutate(changes, false);
      setSavePreview({ ...data, changes, tabId: active.id, has_primary_key: !!view.tableMeta?.primary_key?.length });
    } catch (err) {
      toast(err.message || 'Could not prepare the changes', 'error', 8000);
    } finally {
      setSaving(false);
    }
  };

  const applySave = async () => {
    if (!savePreview) return;
    setSaving(true);
    try {
      const data = await mutate(savePreview.changes, true);
      logInPage(`${E.log}_data_editor_save`, `Applied ${data.summary} to ${editTable.database}.${editTable.schema}.${editTable.table}`);
      setSavePreview(null);
      patchActive({ edits: {}, deleted: [], newRows: [] });
      toast(`Applied ${data.summary}`, 'success');
      if (active.kind === 'data') {
        loadTablePage(active.id, active.table, view.page, pageSize, view.sort, view.filters);
      } else {
        // Re-run so the grid shows what is really in the table now.
        pendingEditRef.current[active.id] = view.sql;
        startRun(active.id, view.sql, view.jobId);
      }
    } catch (err) {
      setSavePreview(null);
      toast(err.message || 'Changes were not applied', 'error', 9000);
    } finally {
      setSaving(false);
    }
  };

  /* --------------------------- grid interactions --------------------------- */
  const isData = active.kind === 'data';
  const isCopier = active.kind === 'copier';
  const editingResult = !isData && !!view.editTarget;
  const editing = isData || editingResult;

  const [editLoading, setEditLoading] = useState(false);

  // Turns on editing for a query's result: looks the table up, lines the
  // result columns up with the table's, and works out how rows get matched.
  const startEditResult = async (tabId, sql, resultCols, quiet = false) => {
    const target = editTargetFor(sql, dbOf(tabId), E.pickDb ? serverInfo?.default_schema : schemaOf(tabId), E.upperIdents);
    if (target.error) { if (!quiet) toast(target.error, 'info', 8000); return; }
    const fq = `${target.database}.${target.schema}.${target.table}`;
    setEditLoading(true);
    try {
      const e = encodeURIComponent;
      const data = await fetchJson(withQs(`${E.api}/columns?database=${e(target.database)}&schema=${e(target.schema)}&table=${e(target.table)}`, cqOf(tabId)));
      const tcols = data.columns || [];
      const byName = Object.fromEntries(tcols.map(c => [c.name, c]));
      const names = resultCols.map(c => c.name);
      const mapped = resultCols.map(c => (byName[c.name]
        ? { ...byName[c.name] }
        : { name: c.name, type: c.type, display_type: c.display_type, editable: false, comparable: false, derived: true }));
      const pk = data.primary_key || tcols.filter(c => c.is_primary_key).map(c => c.name);
      let keys;
      if (pk.length) {
        const missing = pk.filter(k => !names.includes(k));
        if (missing.length) throw new Error(`Add ${missing.join(', ')} to the SELECT so each row can be matched to ${target.table}.`);
        keys = pk;
      } else {
        const comparable = tcols.filter(c => c.comparable !== false).map(c => c.name);
        const missing = comparable.filter(k => !names.includes(k));
        if (missing.length) throw new Error(`${target.table} has no primary key, so every column is needed to find a row. Use SELECT * to edit this result.`);
        keys = comparable;
      }
      if (!mapped.some(c => c.editable && !c.derived)) throw new Error('None of the columns in this result can be edited.');
      patchView(tabId, {
        editTarget: target, columns: mapped, keyColumns: keys,
        tableMeta: { primary_key: pk, editable: true },
        edits: {}, deleted: [], newRows: [], rowSel: [], widths: {},
      });
      if (!quiet) toast(`Editing ${fq}. Changes go back to the table when you save.`, 'info', 5000);
      logInPage(`${E.log}_result_edit_open`, `Started editing query results of ${fq}`);
    } catch (err) {
      if (!quiet) toast(err.message || `Could not open ${fq} for editing`, 'error', 9000);
    } finally {
      setEditLoading(false);
    }
  };
  resumeEditRef.current = (tabId, sql, cols) => startEditResult(tabId, sql, cols, true);

  const stopEditResult = () => {
    if (dirtyCount) { toast('Save or revert your changes before you stop editing', 'info'); return; }
    patchActive({ editTarget: null, columns: [], keyColumns: [], tableMeta: null, rowSel: [], widths: {} });
  };

  const reload = (patch) => {
    const next = { ...view, ...patch };
    if (isData) loadTablePage(active.id, active.table, patch.page ?? 1, patch.pageSize ?? pageSize, next.sort, next.filters);
    else if (view.jobId && view.meta) fetchPage(active.id, view.jobId, patch.page ?? 1, patch.pageSize ?? pageSize, next.sort, next.filters, runSeqRef.current[active.id]);
  };

  const handleSort = (col, additive) => {
    if (editing && dirtyCount) { toast('Save or revert your changes before sorting', 'info'); return; }
    const existing = view.sort.find(s => s.col === col);
    const flipped = existing && existing.dir === 'asc' ? 'desc' : 'asc';
    let next;
    if (!additive) next = [{ col, dir: existing ? flipped : 'asc' }];
    else if (existing) next = view.sort.map(s => (s.col === col ? { col, dir: flipped } : s));
    else next = [...view.sort, { col, dir: 'asc' }];
    patchActive({ sort: next });
    reload({ sort: next, page: 1 });
  };

  // Unsaved edits are kept by row position on this page. Anything that
  // changes which rows are on the page would move them onto other rows.
  const holdEdits = (what) => {
    if (!(editing && dirtyCount)) return false;
    toast(`Save or revert your changes before ${what}`, 'info');
    return true;
  };

  const handleFilter = (f) => {
    if (holdEdits('filtering')) return;
    const without = view.filters.filter(x => x.col !== f.col);
    const next = f.op ? [...without, f] : without;
    patchActive({ filters: next });
    reload({ filters: next, page: 1 });
  };

  // The filter menu's value counts: over the whole result on the server,
  // or, in a table tab, over the rows on screen.
  const fetchValues = async (col, search = '') => {
    if (!isData && view.jobId) {
      return fetchJson(`${E.api}/query/${view.jobId}/values`, { method: 'POST', body: { column: col, filters: view.filters, limit: 8, search: search || undefined } });
    }
    const needle = search.toLowerCase();
    const i = gridColumns.findIndex(c => c.name === col);
    const counts = new Map();
    (view.rows || []).forEach(r => {
      const v = Array.isArray(r) ? r[i] : r?.[col];
      if (v == null || typeof v === 'object') return;
      if (needle && !String(v).toLowerCase().includes(needle)) return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }));
    return { values: top, more: counts.size > 8, scope: 'page' };
  };

  const clearFilters = () => { if (holdEdits('changing the filters')) return; patchActive({ filters: [] }); reload({ filters: [], page: 1 }); };

  const goToPage = (n) => {
    if (editing && dirtyCount) { toast('Save or revert your changes before changing page', 'info'); return; }
    const clamped = Math.max(1, Math.min(view.totalPages || 1, n));
    if (clamped === view.page && !view.loading) return;
    reload({ page: clamped });
  };

  const changePageSize = (n) => {
    if (holdEdits('changing the page size')) return;
    setPageSize(n);
    writeLocal(LS.pageSize, String(n));
    reload({ page: 1, pageSize: n });
  };

  const setWidths = useCallback((updater) => {
    setViews(v => {
      const id = activeIdRef.current;
      const cur = v[id] || EMPTY_VIEW;
      const widths = typeof updater === 'function' ? updater(cur.widths) : updater;
      return { ...v, [id]: { ...cur, widths } };
    });
  }, []);

  /* -------------------------------- exports -------------------------------- */
  const [exportOpen, setExportOpen] = useState(false);
  const closeExport = useCallback(() => setExportOpen(false), []);
  const downloadResults = (fmt) => {
    if (!view.jobId) return;
    const qs = new URLSearchParams({ fmt });
    if (view.sort.length) qs.set('sort_json', JSON.stringify(view.sort));
    if (view.filters.length) qs.set('filters_json', JSON.stringify(view.filters));
    logInPage(`${E.log}_query_download`, `Downloaded the full ${E.label} result set (job ${view.jobId}) as ${fmt.toUpperCase()}`);
    toast(`Preparing ${fmt.toUpperCase()} download`, 'info', 2500);
    downloadFile(`${E.api}/query/${view.jobId}/download?${qs}`, `${E.id}_results.${fmt}`)
      .catch(err => toast(err.message || 'Download failed', 'error'));
  };

  /* ------------------------- saved / history actions ----------------------- */
  const saveCurrentQuery = async (name, shared) => {
    try {
      await fetchJson(`${E.api}/saved`, { method: 'POST', body: { name, sql: queryText, shared, ...(E.pickDb ? { database: tabDb } : {}) } });
      setSavePromptOpen(false);
      loadSaved();
      toast(`Saved "${name}"`, 'success');
      logInPage(`${E.log}_query_saved`, `Saved the query "${name}"`);
    } catch (err) {
      toast(err.message || 'Could not save the query', 'error');
    }
  };

  const deleteSaved = async (id) => {
    try { await fetchJson(`${E.api}/saved/${id}`, { method: 'DELETE' }); loadSaved(); toast('Saved query deleted', 'success', 2500); }
    catch (err) { toast(err.message || 'Could not delete the saved query', 'error'); }
  };

  // Clearing history and deleting a saved query can't be undone: the first
  // click asks, a second click within a few seconds does it.
  const [armed, setArmed] = useState(null);
  const arm = (what, fn) => {
    if (armed === what) { setArmed(null); fn(); return; }
    setArmed(what);
    setTimeout(() => setArmed(a => (a === what ? null : a)), 4000);
  };

  const clearHistory = async () => {
    try { await fetchJson(`${E.api}/history`, { method: 'DELETE' }); setHistory({ status: 'ready', items: [], error: null }); }
    catch (err) { toast(err.message || 'Could not clear the history', 'error'); }
  };

  // SQL from the explorer, history or saved queries goes into the worksheet
  // on screen only when that holds nothing of the person's own: empty, or a
  // table preview we put there. Anything else would be lost, so it opens a
  // new worksheet instead.
  const reusable = (tab) => tab.kind === 'query' && !ownBusy && !lockedTab
    && (!(tab.sql || '').trim() || (tab.preview && tab.sql === tab.preview));
  const loadSql = (sql, name, newTab = false, database = null) => {
    const dbName = E.pickDb ? database || null : null;
    if (!newTab && reusable(active)) {
      editSql(active.id, sql);
      if (dbName) setTabDb(active.id, dbName);
      setTabs(ts => ts.map(t => (t.id === active.id ? { ...t, preview: undefined, ...(name && !t.shared && /^Worksheet \d+$/.test(t.name) ? { name } : {}) } : t)));
    } else {
      addTab(sql, name, dbName);
    }
    setPanel(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  /* --------------------------- explorer actions --------------------------- */
  const [explorerSel, setExplorerSel] = useState(null);

  const previewTable = (database, schema, tableName) => {
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    // Postgres can't name another database in a query; the worksheet is switched to it instead.
    const sql = `SELECT *\nFROM ${E.pickDb ? '' : `${q(database)}.`}${q(schema)}.${q(tableName)}\nLIMIT 100;`;
    let tab = active;
    if (!reusable(active)) tab = addTab(sql, tableName, database);
    else { editSql(active.id, sql); setTabDb(active.id, database); }
    setTabs(ts => ts.map(t => (t.id === tab.id ? { ...t, preview: sql } : t)));
    setExplorerSel({ kind: 'table', fq: `${database}.${schema}.${tableName}` });
    if (!isWide) setDrawerOpen(false);
    startRun(tab.id, sql, tab.id === active.id ? view.jobId : null);
  };

  const showDdl = async (database, schema, name, kind) => {
    const title = `${database}.${schema}.${name}`;
    setTextModal({ title, subtitle: `${kind === 'VIEW' ? 'View' : 'Table'} DDL`, body: 'Loading DDL...' });
    try {
      const data = await fetchJson(withQs(`${E.api}/ddl?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}&kind=${kind}`, cq));
      setTextModal(m => (m && m.title === title ? { ...m, body: data.ddl || '(no DDL returned)' } : m));
    } catch (err) {
      setTextModal(null);
      toast(err.message || 'Could not read the DDL', 'error');
    }
  };

  const insertIntoEditor = (text) => {
    if (active.kind !== 'query' || lockedTab) { addTab(text); return; }
    editorRef.current?.insert(text);
  };

  /* -------------------------------- derived -------------------------------- */
  const leadHint = leadKeywordHint(queryText);
  const gridSource = isData ? view.columns : view.meta?.columns;
  const gridColumns = useMemo(() => (gridSource || []).map(c => { const t = displayType(c); return { name: c.name, type: t, display_type: t }; }), [gridSource]);
  const gridFamilies = useMemo(() => gridColumns.map(c => typeFamily(c.type)), [gridColumns]);
  // The extra views read rows, they don't edit them; editing goes back to the grid.
  useEffect(() => { if (editing && LOOK_VIEWS.has(resultTab)) setResultTab('data'); }, [editing, resultTab]);
  // J and K step through rows in the record view, like a mail client.
  useEffect(() => {
    if (resultTab !== 'record' || !paneActive) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      if (e.key === 'j') setRecIdx(i => Math.min(i + 1, Math.max(0, (view.rows?.length || 1) - 1)));
      if (e.key === 'k') setRecIdx(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resultTab, paneActive, view.rows]);
  const canEdit = (isData ? view.tableMeta?.editable : editingResult) && writesOk;
  const hasGrid = isData ? (view.columns || []).length > 0 : (view.status === 'success' && view.meta?.returns_rows);
  // Read once per result, not on every render (a layout read in render runs on each keystroke).
  const scanH = useMemo(() => gridScrollRef.current?.clientHeight || 600, [view.jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const canFilter = hasGrid && !editing && (resultTab === 'data' || LOOK_VIEWS.has(resultTab));
  const columnsList = isData ? (view.columns || []) : (view.meta?.columns || []);
  const rowOffset = ((view.page || 1) - 1) * pageSize;
  const selectedObj = isData
    ? { kind: 'table', fq: `${active.table.database}.${active.table.schema}.${active.table.table}` }
    : explorerSel;

  const statusLine = (() => {
    if (isCopier) return null;
    if (isData) {
      if (view.loading && !view.columns.length) return { color: E.accent, pulse: true, text: 'Loading table...' };
      if (view.status === 'failed') return { color: T.maroon, text: 'Could not load the table' };
      const key = view.keyColumns?.length ? `key ${view.keyColumns.join(', ')}` : 'no primary key, rows matched on every column';
      return { color: T.green, text: `${plural(view.rowCount ?? 0, 'row')} · ${canEdit ? 'editable' : 'read only'} · ${key}` };
    }
    if (busy && view.ranBy) return { color: E.accent, pulse: true, text: `${view.ranBy === 'you' ? 'Running in another tab of yours' : `${view.ranBy} is running a query`} · ${fmtMs(elapsed)}` };
    if (busy) return { color: E.accent, pulse: true, text: `Running in ${E.pickDb ? tabDb : activeConn?.warehouse || serverInfo?.warehouse || E.label} · ${fmtMs(elapsed)}` };
    if (editingResult && view.status === 'success') return { color: T.amber, text: `${plural(view.rowCount ?? 0, 'row')} · editing ${view.editTarget.table}${dirtyCount ? ` · ${plural(dirtyCount, 'unsaved change')}` : ''}` };
    if (view.status === 'failed') return { color: T.maroon, text: `Failed${view.meta?.elapsed_ms != null ? ` after ${fmtMs(view.meta.elapsed_ms)}` : ''}` };
    if (view.status === 'cancelled') return { color: T.faint, text: `Cancelled${view.meta?.elapsed_ms != null ? ` after ${fmtMs(view.meta.elapsed_ms)}` : ''}` };
    if (view.status === 'success' && view.meta) {
      const bits = view.meta.returns_rows
        ? [plural(view.rowCount ?? 0, 'row'), fmtMs(view.meta.elapsed_ms)]
        : [`${plural(view.meta.rows_affected ?? 0, 'row')} affected`, fmtMs(view.meta.elapsed_ms)];
      if (view.meta.bytes_scanned_human) bits.push(`${view.meta.bytes_scanned_human} scanned`);
      if (view.meta.from_cache) bits.push('from cache');
      if (view.run) bits.push(`statement ${shownPart?.index ?? view.run.meta.statement_count} of ${view.run.meta.statement_count}`);
      if (view.ranBy) bits.push(view.ranBy === 'you' ? 'run in another tab' : `run by ${view.ranBy}`);
      return { color: T.green, text: bits.join(' · ') };
    }
    return { color: T.lineStrong, text: 'Ready' };
  })();

  const filteredPanelItems = (list) => {
    const q = panelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(x => (x.sql || '').toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q));
  };

  /* ------------------------------ early states ----------------------------- */
  if (connState === 'checking' && !serverInfo) {
    return (
      <div className="h-full flex overflow-hidden bg-[#efedea] font-johnson-text" aria-busy="true">
        <div className="hidden lg:flex w-[288px] flex-shrink-0 flex-col bg-white border-r border-[#e8e6e3]">
          <div className="mx-3 mt-3 mb-1 px-3.5 py-3 rounded-[12px] space-y-2.5" style={{ background: E.soft }}>
            <div className="flex items-center gap-2.5"><img src={E.icon} alt="" className="w-[22px] h-[22px]" /><Skel w={90} h={12} /></div>
            <Skel w="60%" h={20} className="!rounded-full" />
          </div>
          <div className="p-3"><Skel h={32} className="rounded-md" /></div>
          <div className="px-4 space-y-3 pt-1">{Array.from({ length: 8 }).map((_, i) => <Skel key={i} w={`${50 + ((i * 29) % 45)}%`} h={10} />)}</div>
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-[52px] px-3 flex items-center gap-2">
            <Skel w={130} h={34} className="!rounded-[10px]" /><div className="ml-auto flex gap-2"><Skel w={84} h={34} className="!rounded-[10px]" /><Skel w={34} h={34} className="!rounded-[10px]" /></div>
          </div>
          <div className="mx-3 h-[38%] min-h-[180px] rounded-[14px] bg-[#2b2624] flex items-center justify-center gap-2 text-[12.5px] text-[#a39992]">
            <Spinner /> Connecting to {E.label}...
          </div>
          <div className="flex-1 min-h-0 m-3 rounded-[14px] bg-white shadow-[0_0_0_1px_#e8e6e3] overflow-hidden"><GridSkeleton cols={5} rows={8} /></div>
        </div>
      </div>
    );
  }

  if (connState === 'unconfigured') {
    return (
      <div className="h-full flex items-center justify-center p-4 bg-[#efedea] font-johnson-text">
        <div className="w-full max-w-[520px] rounded-[14px] bg-white shadow-[0_0_0_1px_#e8e6e3,0_8px_24px_rgba(49,44,42,.06)]">
          <EmptyState
            icon={Database}
            title={`${E.label} isn't set up for Data Studio yet`}
            action={<Button icon={RefreshCw} onClick={checkConnection}>Check again</Button>}
          >
            Add a <code className="px-1.5 py-0.5 rounded bg-[#f1efed] text-[12px] text-[#312c2a] break-all">{E.configKey}</code> section to the backend config to switch it on.
            {connError && !connError.includes(E.configKey) && <div className="mt-2 text-[11.5px] text-[#766a63] break-words">{connError}</div>}
          </EmptyState>
        </div>
      </div>
    );
  }

  /* --------------------------------- render -------------------------------- */
  const tabIcon = (tab, tv) => {
    if (tab.kind === 'data') return <Pencil size={12} className="flex-shrink-0 text-[#a14a00]" />;
    if (tab.kind === 'copier') return <CopyPlus size={13} className="flex-shrink-0 text-[#6e6259]" />;
    if (tv.status === 'running' || tv.status === 'starting') return <Spinner size={12} />;
    if (tab.shared) return <Users size={13} className="flex-shrink-0 text-[#0f68b2]" aria-label="Shared worksheet" />;
    const c = tv.status === 'failed' ? T.maroon : tv.status === 'success' ? T.green : null;
    return c
      ? <StatusDot color={c} />
      : <FileCode2 size={13} className="flex-shrink-0 text-[#766a63]" />;
  };

  return (
    <div className="ds-root relative h-full flex overflow-hidden bg-[#efedea] text-[#312c2a] font-johnson-text">

      {/* ------------------------------ explorer ------------------------------ */}
      {!isWide && drawerOpen && (
        <div className="absolute inset-0 z-[45] bg-[#312c2a]/30" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}
      <aside
        className={isWide
          ? `${showExplorer ? 'flex' : 'hidden'} relative flex-shrink-0 flex-col bg-white border-r border-[#e8e6e3]`
          : `absolute inset-y-0 left-0 z-[46] flex flex-col bg-white transition-transform duration-200 ${drawerOpen ? 'translate-x-0 shadow-[8px_0_32px_rgba(49,44,42,.18)]' : '-translate-x-full invisible'}`}
        style={{ width: isWide ? explorerW : Math.min(340, (typeof window !== 'undefined' ? window.innerWidth : 360) - 40) }}
        aria-label="Object explorer"
        aria-hidden={!showExplorer}
      >
        <ConnCard
          E={E}
          state={connState}
          info={serverInfo}
          conn={activeConn}
          connections={connections}
          connId={activeConnId}
          onConn={active.kind === 'query' ? (id => setTabConn(active.id, id)) : null}
          role={activeRole}
          roleOptions={roleOptions}
          roleKey={activeRoleKey}
          onRole={active.kind === 'query' ? (key => pickRole(active.id, key)) : null}
          roleLabel={roleLabel}
          writesOk={writesOk}
        />
        <div className="flex-1 min-h-0 min-w-0">
          <SfExplorer
            key={cq}
            cq={cq}
            onInsert={insertIntoEditor}
            onPreview={previewTable}
            onEditData={(db, sc, t) => openDataEditor(db, sc, t)}
            onShowDdl={showDdl}
            onDetails={openDetails}
            onCollapse={isWide ? undefined : toggleExplorer}
            onSelect={setExplorerSel}
            selected={selectedObj}
            reveal={isData ? active.table : null}
            logInPage={logInPage}
            canEdit={writesOk}
            onToast={toast}
          />
        </div>
        {isWide && (
          <div
            onMouseDown={startExplorerResize}
            onDoubleClick={() => { setExplorerW(288); writeLocal(LS.explorerW, '288'); }}
            title="Drag to resize, double-click to reset"
            className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-[var(--sig-ring)] active:bg-[var(--sig)]"
          />
        )}
      </aside>

      {/* ------------------------------ workspace ----------------------------- */}
      <div ref={workRefCb} className="flex-1 min-w-0 flex flex-col min-h-0">

        {/* top bar: worksheets, then the tools that act on them */}
        <div className="flex-shrink-0 flex items-center gap-1.5 h-[40px] px-2">
          <IconButton
            icon={showExplorer ? PanelLeftClose : PanelLeftOpen}
            label={showExplorer ? 'Hide databases' : 'Show databases'}
            onClick={toggleExplorer}
            size={30}
            className="flex-shrink-0 hover:!bg-white"
          />
          <span aria-hidden="true" className="flex-shrink-0 w-px h-5 mx-1 bg-[#d5cfc9]" />
          <div
            className="min-w-0 flex items-center gap-1 h-full overflow-x-auto ds-noscroll"
            ref={setTabStrip}
            style={tabsCut ? { maskImage: 'linear-gradient(90deg,#000 calc(100% - 24px),transparent)', WebkitMaskImage: 'linear-gradient(90deg,#000 calc(100% - 24px),transparent)' } : undefined}
            role="tablist"
          >
            {tabs.map(tab => {
              const on = tab.id === active.id;
              const tv = views[tab.id] || EMPTY_VIEW;
              const label = tab.kind === 'data' ? tab.table.table : tab.name;
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={on}
                  tabIndex={0}
                  onClick={() => selectTab(tab)}
                  onKeyDown={e => { if (e.key === 'Enter') selectTab(tab); }}
                  onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
                  onDoubleClick={() => tab.kind === 'query' && setRenaming(tab.id)}
                  title={tab.kind === 'data' ? `${tab.table.database}.${tab.table.schema}.${tab.table.table}` : `${tab.name}${tab.shared ? '\nShared worksheet' : ''}\nDouble-click to rename`}
                  className={`group relative flex-shrink-0 flex items-center gap-2 h-[30px] min-w-[104px] max-w-[260px] pl-2.5 pr-1 rounded-[9px] cursor-pointer select-none text-[12.5px] transition-[color,background-color,box-shadow] ${
                    on ? 'bg-white text-[#312c2a] font-medium shadow-[0_0_0_1px_#e8e6e3,0_1px_2px_rgba(49,44,42,.06)]' : 'text-[#6e6259] hover:bg-white/60 hover:text-[#312c2a]'
                  }`}
                >
                  {tabIcon(tab, tv)}
                  {renaming === tab.id ? (
                    <input
                      autoFocus
                      defaultValue={tab.name}
                      onClick={e => e.stopPropagation()}
                      onBlur={e => commitRename(tab.id, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitRename(tab.id, e.target.value); if (e.key === 'Escape') setRenaming(null); }}
                      className="flex-1 min-w-0 h-[22px] px-1 rounded border border-[var(--sig)] bg-white text-[12.5px] focus:outline-none"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate">{label}</span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                    title="Close tab"
                    aria-label={`Close ${label}`}
                    className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-[#766a63] hover:bg-[#f1efed] hover:text-[#312c2a] ${on ? '' : 'opacity-0 group-hover:opacity-100'}`}
                  >
                    <X size={12} strokeWidth={2.2} />
                  </button>
                </div>
              );
            })}
          </div>
          <IconButton icon={Plus} label="New worksheet" onClick={() => addTab()} size={28} className="flex-shrink-0 hover:!bg-white" />
          <div className="flex-1 min-w-0" />
          {active.shared && session && (
            <PeerBar session={session} meta={sharedMeta} colorOf={peerColor} onFollow={pos => editorRef.current?.reveal(pos)} />
          )}
          {active.kind === 'query' && isWide && (
            <div role="radiogroup" aria-label="Layout" className="flex-shrink-0 flex items-center p-[2px] rounded-[9px] bg-[#e8e6e3]/70">
              {[['stacked', Rows2, 'Editor above the results'], ['side', Columns2, 'Editor beside the results']].map(([k, Ico, label]) => {
                const on = (k === 'side') === sideBySide;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={label}
                    title={label}
                    onClick={() => pickLayout(k)}
                    className={`inline-flex items-center justify-center w-[28px] h-[24px] rounded-[7px] transition-colors ${on ? 'bg-white text-[#312c2a] shadow-[0_1px_2px_rgba(49,44,42,.14)]' : 'text-[#766a63] hover:text-[#312c2a]'}`}
                  >
                    <Ico size={14} strokeWidth={1.9} />
                  </button>
                );
              })}
            </div>
          )}
          {active.kind === 'query' && (
            <Button variant="secondary" icon={UserPlus} onClick={() => setShareOpen(true)} title={active.shared ? 'People in this worksheet' : 'Work in this worksheet with other people'} className="!rounded-[9px] !h-[30px] !border-[#e8e6e3]">
              <span className="hidden sm:inline">Share</span>
            </Button>
          )}
          <span className="relative">
            <IconButton
              icon={Users}
              label="Shared worksheets"
              active={Boolean(sharedMenu)}
              size={30}
              className="hover:!bg-white"
              onClick={e => { e.stopPropagation(); if (sharedMenu) setSharedMenu(null); else openSharedMenu(); }}
            />
            <Menu open={Boolean(sharedMenu)} onClose={closeSharedMenu}>
              <div className="w-[260px] max-h-[320px] overflow-y-auto">
                {sharedMenu?.status === 'loading' && <div className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-[#6e6259]"><Spinner size={12} /> Loading...</div>}
                {sharedMenu?.status === 'error' && <div className="px-3 py-2 text-[12.5px] text-[#9e0000]">{sharedMenu.error || 'Could not load shared worksheets'}</div>}
                {sharedMenu?.status === 'ready' && sharedMenu.items.length === 0 && (
                  <div className="px-3 py-2 text-[12.5px] text-[#6e6259]">No shared worksheets yet. Use Share on a worksheet to start one.</div>
                )}
                {sharedMenu?.items.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => { setSharedMenu(null); openShared(w.id).catch(err => toast(err.message || 'Could not open the shared worksheet', 'error')); }}
                    className="block w-full text-left px-3 py-1.5 hover:bg-[#f4f2f0]"
                  >
                    <span className="block truncate text-[12.5px] text-[#312c2a]">{w.name}</span>
                    <span className="block truncate text-[11px] text-[#766a63]">{w.owned ? 'Yours' : `From ${w.owner.name || w.owner.email}`} · {plural(w.people, 'person').replace('persons', 'people')}</span>
                  </button>
                ))}
              </div>
            </Menu>
          </span>
          {E.copier && canCopy && (
            <IconButton icon={CopyPlus} label="Copy a table or schema" onClick={addCopierTab} size={30} className="hover:!bg-white" />
          )}
          <IconButton icon={History} label="Query history" active={panel === 'history'} onClick={() => openPanel('history')} size={30} className="hover:!bg-white" />
          <IconButton icon={Bookmark} label="Saved queries" active={panel === 'saved'} onClick={() => openPanel('saved')} size={30} className="hover:!bg-white" />
        </div>

        {connState === 'error' && (
          <div className="flex-shrink-0 flex items-center gap-3 mx-3 mb-2.5 px-4 py-2.5 rounded-[12px] bg-[#fdf3f1] border border-[#f3d0cc] text-[12.5px] text-[#312c2a]">
            <WifiOff size={15} className="flex-shrink-0 text-[#9e0000]" />
            <span className="flex-1 min-w-0 truncate" title={connError || ''}>
              <span className="font-bold">Can't reach {E.label}.</span> {connError || 'The Data Studio API did not answer.'}
            </span>
            <Button size="sm" icon={RefreshCw} onClick={checkConnection}>Retry</Button>
          </div>
        )}

        {isCopier && (
          <div className="flex-1 min-h-0 mx-3 mb-3 rounded-[14px] overflow-hidden bg-white shadow-[0_0_0_1px_#e8e6e3]">
            {canCopy ? <TableCopier serverInfo={serverInfo} /> : (
              <div className="p-6 text-[13px] text-[#6e6259]">You don't have Copy Tables access. Ask an admin to turn it on in User Management.</div>
            )}
          </div>
        )}

        {/* editor and results: one above the other, or side by side. Until the
            worksheet has a result, the editor gets the room and results wait in a slim bar. */}
        <div className={sideBySide && active.kind === 'query' && !isCopier ? 'flex-1 min-h-0 flex gap-0 px-2 pb-2' : 'contents'}>
        {active.kind === 'query' && !resultsMax && (
          <div
            className={sideBySide ? `${editorMax ? 'flex-1' : 'flex-shrink-0'} relative min-h-0 min-w-0 flex flex-col` : `contents`}
            // The results keep at least 440px beside it, whatever width was saved.
            style={sideBySide && !editorMax ? { width: editorW, maxWidth: 'calc(100% - 448px)', minWidth: 300 } : undefined}
          >
            <section
              className={`relative mx-2 flex flex-col min-h-0 min-w-0 rounded-[12px] overflow-hidden ${editorTheme === 'dark' ? 'ds-dark' : ''} ${sideBySide ? '!mx-0' : ''} ${editorFill || sideBySide ? 'flex-1' : 'flex-shrink-0'} ${editorMax && !sideBySide ? 'mb-2' : ''}`}
              style={{
                background: editorTheme === 'dark' ? '#2b2624' : '#ffffff',
                boxShadow: editorTheme === 'dark' ? '0 1px 2px rgba(0,0,0,.25)' : '0 0 0 1px #e8e6e3',
                ...(editorFill || sideBySide ? {} : { height: editorH ?? clampEditor(null, workH || 700) }),
              }}
              aria-label="SQL editor"
            >
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] z-10" style={{ background: `linear-gradient(90deg, ${E.accent}, transparent 65%)` }} />
              {/* where it runs, who else is here, editor tools */}
              <div className="flex-shrink-0 flex items-center gap-1.5 min-w-0 pl-3 pr-2 pt-2 pb-0.5">
                {!isCopier && E.pickDb && connections.length > 1 && (
                  <Picker tone={editorTheme} size="sm" value={activeConnId || ''} onChange={e => setTabConn(active.id, e.target.value)} title="Login this worksheet runs as" aria-label="Connection" icon={KeyRound} className="max-w-[180px]">
                    {connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </Picker>
                )}
                {!isCopier && (
                  <Picker tone={editorTheme} size="sm" value={tabDb || ''} onChange={e => setTabDb(active.id, e.target.value)} title={tabDb ? `Database: ${tabDb}` : 'Database this worksheet runs in'} aria-label="Database" variant="crumb" className="max-w-[220px]">
                    {!tabDb && <option value="">Database</option>}
                    {(dbList.includes(tabDb) || !tabDb ? dbList : [tabDb, ...dbList]).map(d => <option key={d} value={d}>{d}</option>)}
                  </Picker>
                )}
                {!isCopier && !E.pickDb && (
                  <>
                    <ChevronRight size={12} className={`flex-shrink-0 ${editorTheme === 'dark' ? 'text-[#6e6259]' : 'text-[#a39992]'}`} />
                    <Picker tone={editorTheme} size="sm" value={tabSchema || ''} onChange={e => setTabSchema(active.id, e.target.value)} disabled={!tabDb} title={tabSchema ? `Schema: ${tabSchema}` : 'Schema this worksheet runs in'} aria-label="Schema" variant="crumb" className="max-w-[220px]">
                      {!tabSchema && <option value="">Schema</option>}
                      {(schemaList.includes(tabSchema) || !tabSchema ? schemaList : [tabSchema, ...schemaList]).map(x => <option key={x} value={x}>{x}</option>)}
                    </Picker>
                  </>
                )}
                <div className="flex-1 min-w-0 flex justify-end pr-1">
                  <PeerActivity session={active.shared ? session : null} meta={sharedMeta}>{null}</PeerActivity>
                </div>
                <div className="flex-shrink-0 flex items-center gap-0.5">
                  <EdTool dark={editorTheme === 'dark'} icon={AlignLeft} label={`Format SQL (${MOD} Shift F)`} onClick={() => editorRef.current?.command('format')} disabled={!queryText.trim()} />
                  <span className="relative">
                    <EdTool dark={editorTheme === 'dark'} icon={CaseSensitive} label="Change case of the selection or word" onClick={e => { e.stopPropagation(); setCaseOpen(o => !o); }} />
                    <Menu open={caseOpen} onClose={closeCase}>
                      {[['upper', 'UPPER CASE', `${MOD} Shift U`], ['lower', 'lower case', `${MOD} Shift L`], ['camel', 'camelCase', `${MOD} Alt C`], ['pascal', 'PascalCase', `${MOD} Alt P`], ['snake', 'snake_case', `${MOD} Alt S`], ['title', 'Title Case', null]].map(([id, label, hint]) => (
                        <MenuItem key={id} hint={hint} onClick={() => { setCaseOpen(false); editorRef.current?.command(id); }}>{label}</MenuItem>
                      ))}
                    </Menu>
                  </span>
                  <EdTool dark={editorTheme === 'dark'} icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy the SQL'} onClick={copyQueryText} disabled={!queryText.trim()} />
                  <EdTool dark={editorTheme === 'dark'} icon={Bookmark} label="Save this query" onClick={() => setSavePromptOpen(true)} disabled={!queryText.trim()} />
                  <EdTool dark={editorTheme === 'dark'} icon={editorTheme === 'dark' ? Sun : Moon} label={editorTheme === 'dark' ? 'Light editor' : 'Dark editor'} onClick={toggleEditorTheme} />
                  <EdTool dark={editorTheme === 'dark'} icon={Keyboard} label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)} />
                  <EdTool dark={editorTheme === 'dark'} icon={editorMax ? Minimize2 : Maximize2} label={editorMax ? 'Show results' : 'Give the editor the whole space'} onClick={() => setEditorMax(m => !m)} />
                </div>
              </div>
              <div className="relative flex-1 min-h-0">
                <SfEditor
                  key={`${active.id}|${cq}`}
                  historyKey={active.id}
                  cq={cq}
                  ref={editorRef}
                  value={queryText}
                  onChange={sql => editSql(active.id, sql)}
                  readOnly={lockedTab}
                  session={active.shared ? session : null}
                  peerColor={peerColor}
                  onSelect={active.shared ? (sel => sessionOf(active.id)?.select(sel)) : undefined}
                  onRun={() => runQuery()}
                  onRunAll={runAll}
                  onSave={() => queryText.trim() && setSavePromptOpen(true)}
                  theme={editorTheme}
                  defaultDb={tabDb}
                  defaultSchema={(E.pickDb ? serverInfo?.default_schema : tabSchema) || null}
                  placeholder={`-- Write ${E.label} SQL here, or double-click a table on the left\nSELECT *\nFROM ${E.sample}\nLIMIT 100;`}
                />
              </div>
              <RunBar
                dark={editorTheme === 'dark'}
                accent={E.accent}
                busy={ownBusy}
                othersBusy={busy && !ownBusy}
                status={view.run ? view.run.meta.status : view.status}
                meta={view.run?.meta || view.meta}
                elapsed={elapsed}
                statementCount={statementCount}
                leadHint={leadHint}
                canRun={Boolean(queryText.trim()) && connState === 'ready' && !lockedTab}
                lockedReason={sharedRole === 'view' ? 'You have view-only access to this shared worksheet' : null}
                onRun={() => runQuery()}
                onRunAll={runAll}
                onCancel={cancelQuery}
              />
            </section>
            {sideBySide && !editorMax && (
              <div
                onMouseDown={startEditorWidthResize}
                onDoubleClick={() => { setEditorW(560); writeLocal(LS.editorW, '560'); }}
                title="Drag to resize, double-click to reset"
                role="separator"
                aria-orientation="vertical"
                className="group absolute top-0 -right-[9px] z-10 h-full w-[18px] flex items-center justify-center cursor-col-resize"
              >
                <span className="w-[4px] h-10 rounded-full bg-[#cbc4bc] opacity-0 group-hover:opacity-100 group-hover:bg-[var(--sig)] transition-opacity" />
              </div>
            )}
            {!editorFill && !sideBySide && (
              <div
                onMouseDown={startEditorResize}
                onDoubleClick={() => { setEditorH(null); try { window.localStorage.removeItem(LS.editorH); } catch { /* private mode */ } }}
                title="Drag to resize, double-click to reset"
                role="separator"
                aria-orientation="horizontal"
                className="group flex-shrink-0 h-[8px] flex items-center justify-center cursor-row-resize"
              >
                <div className="w-10 h-[4px] rounded-full bg-[#cbc4bc] opacity-0 group-hover:opacity-100 group-hover:bg-[var(--sig)] transition-opacity" />
              </div>
            )}
          </div>
        )}
        {sideBySide && active.kind === 'query' && !resultsMax && !editorMax && <div className="w-2 flex-shrink-0" />}

        {waiting && (
          <button
            type="button"
            onClick={() => editorRef.current?.focus?.()}
            className="flex-shrink-0 mx-2 my-2 h-[32px] flex items-center gap-2.5 px-3 rounded-[10px] bg-white shadow-[0_0_0_1px_#e8e6e3] text-left text-[12.5px] text-[#6e6259] hover:text-[#312c2a]"
            title="Results open here when you run a query"
          >
            <Table2 size={14} className="flex-shrink-0 text-[#a39992]" />
            <span className="font-medium text-[#312c2a]">Results</span>
            <span className="truncate">Run a query with <Kbd>{MOD}</Kbd> + <Kbd>Enter</Kbd> and its rows open here</span>
          </button>
        )}

        {/* results */}
        {!isCopier && !(editorMax && active.kind === 'query') && !waiting && (
          <div
            ref={el => { resultsRef.current = el; setResultsEl(el); }}
            className={`relative flex-1 min-h-0 min-w-0 flex flex-col bg-white rounded-[12px] overflow-hidden shadow-[0_0_0_1px_#e8e6e3,0_1px_2px_rgba(49,44,42,.04)] ${sideBySide && active.kind === 'query' ? '' : 'mx-2 mb-2'}`}
          >
            {isData && (
              <div className="flex-shrink-0 flex items-center gap-2 min-w-0 px-4 pt-3 pb-1">
                <img src={E.icon} alt="" className="w-[16px] h-[16px] flex-shrink-0" />
                <nav aria-label="Current table" className="min-w-0 flex items-center gap-1 text-[13px]">
                  <span className="hidden sm:inline min-w-[3ch] truncate shrink-[8] text-[#6e6259]" title={active.table.database}>{active.table.database}</span>
                  <ChevronRight size={13} className="hidden sm:block flex-shrink-0 text-[#a39992]" />
                  <span className="hidden sm:inline min-w-[3ch] truncate shrink-[8] text-[#6e6259]" title={active.table.schema}>{active.table.schema}</span>
                  <ChevronRight size={13} className="hidden sm:block flex-shrink-0 text-[#a39992]" />
                  <span className="min-w-[60px] truncate font-johnson-display font-bold text-[17px] text-[#312c2a]" title={`${active.table.database}.${active.table.schema}.${active.table.table}`}>{active.table.table}</span>
                  <IconButton
                    icon={Copy}
                    label="Copy full table name"
                    size={24}
                    iconSize={12}
                    onClick={() => navigator.clipboard?.writeText(`"${active.table.database}"."${active.table.schema}"."${active.table.table}"`).then(() => toast('Table name copied', 'success', 2000)).catch(() => {})}
                  />
                </nav>
                {dirtyCount > 0 && (
                  <span className="flex-shrink-0 inline-flex items-center h-[22px] px-2 rounded-full bg-[#fff3ea] text-[11.5px] font-medium text-[#a14a00]">{dirtyCount} unsaved</span>
                )}
              </div>
            )}
            {!isData && runParts.length > 1 && !busy && (
              <StatementStrip parts={runParts} shown={view.jobId} accent={E.accent} onPick={showPart} />
            )}
            <div className="flex-shrink-0 flex items-center gap-3 min-h-[38px] min-w-0 px-2 border-b border-[#efedea]">
              <div className="min-w-0 flex items-center p-[2px] rounded-[9px] bg-[#f1efed] overflow-x-auto ds-noscroll" role="tablist" aria-label="Result views">
                <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'data'} onClick={() => setResultTab('data')} icon={Table2} title="The rows as a table">{isData ? 'Data' : 'Table'}</ViewTab>
                {hasGrid && !editing && (
                  <>
                    <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'record'} onClick={() => setResultTab('record')} icon={IdCard} title="One row at a time">Record</ViewTab>
                    <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'profile'} onClick={() => setResultTab('profile')} icon={ScanText} title="Every column at a glance">Profile</ViewTab>
                    <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'chart'} onClick={() => setResultTab('chart')} icon={ChartColumnBig} title="Chart the rows">Chart</ViewTab>
                    <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'pivot'} onClick={() => setResultTab('pivot')} icon={Grid3x3} title="Pivot table">Pivot</ViewTab>
                  </>
                )}
                <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'columns'} onClick={() => setResultTab('columns')} icon={Columns3} title="Column names and types">Columns</ViewTab>
                <ViewTab accent={E.accent} compact={compactViews} active={resultTab === 'details'} onClick={() => setResultTab('details')} icon={Info} title="Timing, statements and where it ran">Details</ViewTab>
              </div>
              {hasGrid && !busy && view.rowCount != null && (
                <div key={`${view.jobId || ''}|${view.rowCount}`} className={`ds-count items-baseline gap-1 flex-shrink-0 whitespace-nowrap ${resultsW > 0 && resultsW < 460 ? 'hidden' : 'hidden md:flex'}`}>
                  <span className="font-johnson-display font-bold text-[18px] leading-none tabular-nums text-[#312c2a]">{fmtN(view.rowCount)}</span>
                  <span className="text-[12.5px] text-[#6e6259]">{view.rowCount === 1 ? 'row' : 'rows'}</span>
                </div>
              )}

              <div className="ml-auto flex-shrink-0 flex items-center gap-1.5">
                {resultTab === 'data' && editing && dupInfo.count > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[#fdf3f1] text-[12px] font-medium text-[#9e0000]" title="Rows marked DUP match another row. Change them before saving.">
                    <TriangleAlert size={12} />{plural(dupInfo.count, 'duplicate')}
                  </span>
                )}
                {resultTab === 'data' && canEdit && (view.rowSel || []).length > 0 && (
                  <Button size="sm" icon={CopyPlus} onClick={() => copyRows(view.rowSel)} title="Copy the selected rows as new rows">
                    Copy {plural(view.rowSel.length, 'row')}
                  </Button>
                )}
                {resultTab === 'data' && canEdit && (
                  <Button size="sm" icon={Plus} onClick={addRow}>
                    <span className="hidden sm:inline">Add row</span>
                  </Button>
                )}
                {resultTab === 'data' && editing && dirtyCount > 0 && (
                  <Button size="sm" icon={Undo2} onClick={() => patchActive({ edits: {}, deleted: [], newRows: [] })}>
                    <span className="hidden sm:inline">Revert</span>
                  </Button>
                )}
                {editing && dirtyCount > 0 && (
                  <Button size="sm" variant="primary" icon={Save} onClick={previewSave} disabled={saving}>
                    {saving ? 'Preparing...' : `Review ${dirtyCount}`}
                  </Button>
                )}
                {isData && (
                  <IconButton
                    icon={RefreshCw}
                    label="Reload rows"
                    onClick={() => (dirtyCount ? toast('Save or revert your changes first', 'info') : loadTablePage(active.id, active.table, view.page, pageSize, view.sort, view.filters))}
                  />
                )}
                {canFilter && (
                  <FilterButton columns={gridColumns || []} fetchValues={fetchValues} onAdd={handleFilter} count={view.filters?.length || 0} compact={narrowResults} />
                )}
                {resultTab === 'data' && !isData && hasGrid && !busy && writesOk && (
                  editingResult ? (
                    <Button size="sm" variant="dark" icon={Check} onClick={stopEditResult} title="Stop editing this result">
                      <span className="hidden sm:inline">Done editing</span>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      icon={editLoading ? Loader2 : Pencil}
                      disabled={editLoading}
                      onClick={() => startEditResult(active.id, view.sql, view.meta?.columns || [])}
                      title="Edit these rows and save the changes back to the table"
                    >
                      <span className={narrowResults ? 'hidden' : 'hidden sm:inline'}>Edit rows</span>
                    </Button>
                  )
                )}
                {!isData && hasGrid && view.jobId && (view.rowCount ?? 0) > 0 && (
                  <span className="relative">
                    <Button size="sm" icon={Download} title="Download the result" onClick={e => { e.stopPropagation(); setExportOpen(o => !o); }}>
                      <span className={narrowResults ? 'hidden' : 'hidden sm:inline'}>Download</span>
                      <ChevronDown size={12} />
                    </Button>
                    <Menu open={exportOpen} onClose={closeExport}>
                      <div className="px-3 pt-1.5 pb-1 text-[11.5px] font-medium text-[#766a63]">Full result set</div>
                      {EXPORT_FORMATS.map(f => (
                        <MenuItem key={f.id} hint={`.${f.id}`} onClick={() => { setExportOpen(false); downloadResults(f.id); }}>{f.label}</MenuItem>
                      ))}
                    </Menu>
                  </span>
                )}
                {active.kind === 'query' && (
                  <IconButton
                    icon={resultsMax ? ChevronsDown : ChevronsUp}
                    label={resultsMax ? 'Show the editor again' : 'Give the results the whole space'}
                    active={resultsMax}
                    onClick={() => { setResultsMax(m => !m); setEditorMax(false); }}
                  />
                )}
                {hasGrid && (
                  <IconButton icon={isFullscreen ? Minimize2 : Maximize2} label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen} />
                )}
              </div>
            </div>

            {(busy || view.loading || editLoading) && <ProgressBar />}
            {canFilter && view.filters?.length > 0 && (
              <FilterBar
                filters={view.filters}
                onRemove={col => handleFilter({ col })}
                onClear={clearFilters}
              />
            )}
            {editingResult && resultTab === 'data' && (
              <div className="flex-shrink-0 flex items-center gap-2.5 px-4 py-2 bg-[#fff8f2] border-b border-[#f6dfcc] text-[12px] text-[#4a423e]">
                <Pencil size={13} className="flex-shrink-0 text-[#a14a00]" />
                <span className="min-w-0 truncate">
                  Editing rows of <span className="font-mono font-medium text-[#312c2a]">{view.editTarget.database}.{view.editTarget.schema}.{view.editTarget.table}</span>
                  <span className="text-[#766a63]"> · matched on {view.keyColumns.length === 1 ? view.keyColumns[0] : view.tableMeta?.primary_key?.length ? view.keyColumns.join(', ') : 'every column'}</span>
                  {(view.columns || []).some(c => c.derived) && <span className="text-[#766a63]"> · computed columns are read only</span>}
                </span>
              </div>
            )}

            <div ref={gridScrollRef} className="relative flex-1 min-h-0 overflow-auto">
              {/* A sweep down the rows when a new result lands. */}
              {hasGrid && !busy && !view.error && view.jobId && (
                <div key={view.jobId} aria-hidden="true" className="ds-scan" onAnimationEnd={e => { e.currentTarget.style.display = 'none'; }} style={{ '--ds-h': `${scanH}px`, background: `linear-gradient(180deg, transparent, ${E.accent}14 80%, ${E.accent}80)` }} />
              )}
              {/* The grid stays mounted (just hidden) behind the other views, so coming back to Table is instant. */}
              {(shownTab === 'data' || hasGrid) && (
                <div className={shownTab === 'data' ? 'contents' : 'hidden'}>
                  {!isData && view.status === 'idle' && (
                    <EmptyState
                      icon={Play}
                      title="Run a query to see results here"
                      // Pick up where you left off: the last few distinct queries that worked.
                      action={recentQueries.length > 0 && (
                        <div className="w-full text-left">
                          <div className="mb-1 px-2.5 text-[12px] font-medium text-[#6e6259]">Pick up a recent query</div>
                          {recentQueries.map(h => (
                            <button
                              key={h.id}
                              onClick={() => loadSql(h.sql, null, false, h.database)}
                              title={`${h.sql}\n\nOpens here, or in a new worksheet if this one has SQL in it`}
                              className="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-[#f4f2f0]"
                            >
                              <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-[#312c2a]">{h.sql.replace(/\s+/g, ' ')}</span>
                              <span className="flex-shrink-0 text-[11px] text-[#766a63]">{formatWhen(h.created_at)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    >
                      Write SQL above and press <Kbd>{MOD}</Kbd> + <Kbd>Enter</Kbd>, or double-click any table on the left to preview its first 100 rows.
                    </EmptyState>
                  )}
                  {((!isData && busy) || (isData && view.loading && !view.columns.length && !view.error)) && <GridSkeleton cols={6} rows={12} />}
                  {view.error && (
                    <ErrorPanel
                      error={view.error}
                      retryLabel={isData ? 'Reload' : view.stuckJob ? 'Cancel it and run' : 'Run again'}
                      onRetry={isData
                        ? () => loadTablePage(active.id, active.table, view.page || 1, pageSize, view.sort, view.filters)
                        : view.stuckJob
                          ? async () => {
                            await apiFetch(`${E.api}/query/${view.stuckJob}/cancel`, { method: 'POST' }).catch(() => {});
                            startRun(active.id, view.sql, null);
                          }
                          : (view.sql ? () => startRun(active.id, view.sql, view.jobId) : undefined)}
                      onJump={!isData && view.sql && queryText.includes(view.sql)
                        // Lines count from the statement that ran; move them to where it sits in the editor.
                        ? (line, col) => editorRef.current?.jumpTo(line + queryText.slice(0, queryText.indexOf(view.sql)).split('\n').length - 1, col)
                        : undefined}
                    />
                  )}
                  {!isData && view.status === 'cancelled' && (
                    <EmptyState icon={Ban} title="Query cancelled" action={view.sql && <Button icon={RotateCcw} onClick={() => startRun(active.id, view.sql, view.jobId)}>Run again</Button>}>
                      {E.label} was asked to stop the statement. Nothing more will be returned for it.
                    </EmptyState>
                  )}
                  {!isData && view.status === 'success' && view.meta && !view.meta.returns_rows && (
                    <EmptyState icon={CircleCheck} title="Statement executed">
                      {plural(view.meta.rows_affected ?? 0, 'row')} affected in {fmtMs(view.meta.elapsed_ms)}. This statement returns no rows to show.
                    </EmptyState>
                  )}
                  {hasGrid && !busy && !view.error && (
                    <>
                      <SfGrid
                        stats={colStats}
                        onToggleStats={toggleColStats}
                        columns={gridColumns}
                        rows={view.rows}
                        widths={view.widths}
                        setWidths={setWidths}
                        sort={view.sort}
                        onSort={handleSort}
                        filters={view.filters}
                        onFilter={handleFilter}
                        dimmed={view.loading}
                        rowOffset={rowOffset}
                        editable={canEdit}
                        columnMeta={editing ? columnMetaByName : NO_META}
                        edits={view.edits}
                        deleted={view.deleted}
                        newRows={editing ? view.newRows : NO_ROWS}
                        onEditCell={editCell}
                        onToggleDelete={toggleDelete}
                        onEditNewCell={editNewCell}
                        onRemoveNewRow={i => patchActive({ newRows: view.newRows.filter((_, idx) => idx !== i) })}
                        selectedRows={editing ? view.rowSel || NO_ROWS : NO_ROWS}
                        onRowSelect={selectRow}
                        onCopyRow={copyRows}
                        dupNew={dupInfo.news}
                        dupRows={dupInfo.rows}
                        onOpenCell={(col, value, r) => setCellDetail({
                          title: col,
                          body: isBig(value)
                            ? `${value.preview}\n\n… only the first ${fmtN(value.preview.length)} characters of ${formatBytes(value.size)} are shown here. Use Load full value to see all of it.`
                            : cellText(value) ?? 'NULL',
                          loadFull: isBig(value) ? cellLoader(col, r) : undefined,
                        })}
                        onCopied={(msg) => toast(msg || 'Cell copied', 'success', 1500)}
                        onSelection={setCellStats}
                      />
                      {view.rows.length === 0 && (!editing || view.newRows.length === 0) && !view.loading && (
                        <div className="sticky left-0 py-12 text-center">
                          <div className="text-[13px] font-medium text-[#312c2a]">
                            {view.filters.length ? 'No rows match these filters' : 'No rows returned'}
                          </div>
                          {view.filters.length > 0 && (
                            <Button size="sm" className="mt-3" icon={X} onClick={clearFilters}>Clear filters</Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {view.loading && hasGrid && (
                    <div className="pointer-events-none sticky bottom-3 flex justify-center">
                      <span className="inline-flex items-center gap-2 h-8 px-3 rounded-full bg-white border border-[#e8e6e3] shadow-[0_4px_16px_rgba(49,44,42,.12)] text-[12px] text-[#4a423e]">
                        <Spinner size={13} /> Loading rows...
                      </span>
                    </div>
                  )}
                </div>
              )}

              {LOOK_VIEWS.has(shownTab) && (
                !hasGrid || busy || view.error ? (
                  busy ? <GridSkeleton cols={4} rows={8} /> : (
                    <EmptyState icon={ChartColumnBig} title="Nothing to look at yet">Run a query that returns rows, or open a table, and it shows up here.</EmptyState>
                  )
                ) : shownTab === 'record' ? (
                  <RecordView
                    columns={gridColumns}
                    families={gridFamilies}
                    rows={view.rows}
                    rowOffset={rowOffset}
                    index={recIdx}
                    onIndex={setRecIdx}
                    accent={E.accent}
                    onCopy={obj => navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() => toast('Row copied as JSON', 'success', 1500)).catch(() => {})}
                  />
                ) : shownTab === 'profile' ? (
                  <ProfileView columns={gridColumns} families={gridFamilies} rows={view.rows} total={view.rowCount} accent={E.accent} onChart={name => { setChartBy(name); setResultTab('chart'); }} />
                ) : shownTab === 'chart' ? (
                  <ChartView columns={gridColumns} families={gridFamilies} rows={view.rows} total={view.rowCount} accent={E.accent} groupBy={chartBy} onGroupBy={setChartBy} />
                ) : (
                  <PivotView columns={gridColumns} families={gridFamilies} rows={view.rows} total={view.rowCount} accent={E.accent} />
                )
              )}

              {shownTab === 'columns' && (
                columnsList.length === 0 ? (
                  <EmptyState icon={Columns3} title="No columns yet">Run a query that returns rows, or open a table, to see its columns.</EmptyState>
                ) : (
                  <table className="w-full border-separate border-spacing-0 text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[11px] font-bold uppercase tracking-[.06em] text-[#6e6259]">
                        {['#', 'Column', 'Type', 'Nullable', 'Key'].map(h => (
                          <th key={h} className={`sticky top-0 z-10 h-9 px-4 bg-[#f8f7f5] border-b border-[#e8e6e3] font-bold ${h === '#' ? 'w-[56px] text-right' : ''}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {columnsList.map((c, i) => (
                        <tr key={c.name} className="hover:bg-[#f4f2f0]">
                          <td className="h-9 px-4 border-b border-[#f1efed] text-right tabular-nums text-[#766a63]">{i + 1}</td>
                          <td className="h-9 px-4 border-b border-[#f1efed] font-medium break-all">{c.name}</td>
                          <td className="h-9 px-4 border-b border-[#f1efed] font-mono text-[12px] text-[#4a423e]">{displayType(c)}</td>
                          <td className="h-9 px-4 border-b border-[#f1efed] text-[#6e6259]">{c.nullable === false ? 'NOT NULL' : c.nullable === true ? 'yes' : '-'}</td>
                          <td className="h-9 px-4 border-b border-[#f1efed]">
                            {c.is_primary_key ? <span className="inline-flex items-center gap-1 text-[#a14a00] font-medium"><KeyRound size={12} /> PK</span> : <span className="text-[#a39992]">-</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {shownTab === 'details' && (
                <div className="max-w-[860px] px-5 py-3">
                  {isData ? (
                    <>
                      <DetailRow label="Table" mono>{`${active.table.database}.${active.table.schema}.${active.table.table}`}</DetailRow>
                      <DetailRow label="Rows">{fmtN(view.rowCount)}</DetailRow>
                      <DetailRow label="Columns">{fmtN(view.columns.length)}</DetailRow>
                      <DetailRow label="Row key">{view.keyColumns?.length ? view.keyColumns.join(', ') : <span className="text-[#a14a00]">No primary key, rows are matched on every column</span>}</DetailRow>
                      <DetailRow label="Editing">{canEdit ? 'Enabled. Changes apply in one transaction.' : 'Read only'}</DetailRow>
                      <DetailRow label="Unsaved changes">{dirtyCount ? plural(dirtyCount, 'change') : 'None'}</DetailRow>
                    </>
                  ) : (
                    <>
                      <DetailRow label="Status">
                        <span className="inline-flex items-center gap-2"><StatusDot color={statusLine.color} pulse={statusLine.pulse} />{view.status === 'idle' ? 'Nothing run yet' : view.status.charAt(0).toUpperCase() + view.status.slice(1)}</span>
                      </DetailRow>
                      <DetailRow label="Duration">{busy ? fmtMs(elapsed) : fmtMs(view.meta?.elapsed_ms)}</DetailRow>
                      <DetailRow label={view.meta && !view.meta.returns_rows ? 'Rows affected' : 'Rows'}>
                        {view.meta ? fmtN(view.meta.returns_rows ? view.rowCount : view.meta.rows_affected) : '-'}
                      </DetailRow>
                      {!E.pickDb && <DetailRow label="Bytes scanned">{view.meta?.bytes_scanned_human || (view.meta?.bytes_scanned != null ? fmtN(view.meta.bytes_scanned) : '-')}</DetailRow>}
                      {!E.pickDb && <DetailRow label="Result cache">{view.meta?.from_cache == null ? '-' : view.meta.from_cache ? 'Hit' : 'Miss'}</DetailRow>}
                      {(view.run?.meta || view.meta)?.statements?.length > 0 && (
                        <DetailRow label="Statements">
                          <ol className="m-0 p-0 list-none space-y-1">
                            {(view.run?.meta || view.meta).statements.map(st => (
                              <li key={st.index} className="flex items-baseline gap-2 min-w-0">
                                <span className="flex-shrink-0 tabular-nums text-[#766a63]">{st.index}.</span>
                                <span className="flex-shrink-0 font-medium">{st.statement_type}</span>
                                <span className="min-w-0 truncate font-mono text-[11.5px] text-[#6e6259]" title={st.sql}>{st.sql}</span>
                                <span className="ml-auto flex-shrink-0 tabular-nums text-[#766a63]">
                                  {st.row_count != null ? plural(st.row_count, 'row') : st.rows_affected != null ? `${fmtN(st.rows_affected)} affected` : ''}
                                  {' · '}{fmtMs(st.elapsed_ms)}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </DetailRow>
                      )}
                      <DetailRow label="Job id" mono>{view.jobId || '-'}</DetailRow>
                      <DetailRow label="SQL" mono>
                        {view.sql ? <pre className="m-0 px-3 py-2 rounded-md bg-[#fbfaf9] border border-[#efedea] whitespace-pre-wrap break-words max-h-[320px] overflow-auto"><SqlCode sql={view.sql} /></pre> : '-'}
                      </DetailRow>
                    </>
                  )}
                  {E.pickDb ? (
                    <>
                      {!isData && <DetailRow label="Database">{tabDb || '-'}</DetailRow>}
                      <DetailRow label="User">{activeConn?.user || serverInfo?.user || '-'}</DetailRow>
                      <DetailRow label="Server" mono>{activeConn?.host || serverInfo?.account || '-'}</DetailRow>
                    </>
                  ) : (
                    <>
                      <DetailRow label="User">{activeConn?.user || serverInfo?.user || '-'}</DetailRow>
                      <DetailRow label="Role">{activeRole || 'default'}</DetailRow>
                      <DetailRow label="Warehouse">{activeConn?.warehouse || serverInfo?.warehouse || 'default'}</DetailRow>
                      <DetailRow label="Account" mono>{activeConn?.account || serverInfo?.account || '-'}</DetailRow>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* status bar */}
            <div className="flex-shrink-0 flex items-center flex-wrap gap-x-4 gap-y-1 min-h-[30px] px-3 py-0.5 border-t border-[#efedea] bg-white">
              {statusLine && (
                <div className="flex items-center gap-2 min-w-0 text-[12px] text-[#4a423e] tabular-nums" aria-live="polite">
                  <StatusDot color={statusLine.color} pulse={statusLine.pulse} />
                  <span className="truncate">{statusLine.text}</span>
                </div>
              )}
              {cellStats && hasGrid && resultTab === 'data' && (
                <div className="flex items-center gap-3 min-w-0 text-[12px] text-[#4a423e] tabular-nums" title="Selected cells. Ctrl+C copies them, Ctrl+Shift+C with the column names.">
                  <span className="text-[#766a63]">{fmtN(cellStats.rows)} × {fmtN(cellStats.cols)} selected</span>
                  {cellStats.nums > 0 && (
                    <>
                      <span>Sum <b className="font-medium text-[#312c2a]">{fmtStat(cellStats.sum)}</b></span>
                      <span>Avg <b className="font-medium text-[#312c2a]">{fmtStat(cellStats.sum / cellStats.nums)}</b></span>
                      <span className="hidden lg:inline">Min <b className="font-medium text-[#312c2a]">{fmtStat(cellStats.min)}</b></span>
                      <span className="hidden lg:inline">Max <b className="font-medium text-[#312c2a]">{fmtStat(cellStats.max)}</b></span>
                    </>
                  )}
                </div>
              )}
              {hasGrid && (resultTab === 'data' || LOOK_VIEWS.has(resultTab)) && (
                <div className="ml-auto flex items-center gap-3">
                  <label className="hidden sm:flex items-center gap-2 text-[12px] text-[#6e6259] whitespace-nowrap" title="Rows per page">
                    <span className={narrowResults ? 'hidden' : ''}>Rows per page</span>
                    <select
                      value={pageSize}
                      onChange={e => changePageSize(Number(e.target.value))}
                      disabled={view.loading}
                      className="h-[22px] rounded-md border border-[#d5cfc9] bg-white px-1 text-[11.5px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)]"
                    >
                      {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <Pager page={view.page} totalPages={view.totalPages || 1} loading={view.loading} onGo={goToPage} />
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>

      <TableDetails
        info={tableInfo}
        cq={cq}
        onClose={() => setTableInfo(null)}
        onPreview={(d, sc, t) => { setTableInfo(null); previewTable(d, sc, t); }}
        onInsert={text => insertIntoEditor(text)}
        onToast={toast}
      />

      {/* ------------------------ history / saved drawer ----------------------- */}
      {panel && <div className="absolute inset-0 z-[47] bg-[#312c2a]/20" onClick={() => setPanel(null)} aria-hidden="true" />}
      <aside
        className={`absolute inset-y-0 right-0 z-[48] w-[380px] max-w-[calc(100%-24px)] flex flex-col bg-white border-l border-[#e8e6e3] transition-transform duration-200 ${panel ? 'translate-x-0 shadow-[-8px_0_32px_rgba(49,44,42,.16)]' : 'translate-x-full invisible'}`}
        aria-hidden={!panel}
        aria-label="Query history and saved queries"
      >
        <div className="flex-shrink-0 flex items-center gap-1 h-[52px] px-3 border-b border-[#e8e6e3]">
          <div className="flex items-stretch gap-4 h-full pl-1">
            <SubTab active={panel === 'history'} onClick={() => openPanel('history')} icon={History}>History</SubTab>
            <SubTab active={panel === 'saved'} onClick={() => openPanel('saved')} icon={Bookmark}>Saved</SubTab>
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton icon={RefreshCw} label="Refresh" onClick={() => (panel === 'history' ? loadHistory() : loadSaved())} />
            <IconButton icon={X} label="Close" onClick={() => setPanel(null)} />
          </div>
        </div>
        <div className="flex-shrink-0 px-3 py-2.5 border-b border-[#f1efed]">
          <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-[#d5cfc9] focus-within:border-[var(--sig)] focus-within:ring-2 focus-within:ring-[var(--sig-ring)]">
            <Search size={14} className="text-[#766a63]" />
            <input
              value={panelFilter}
              onChange={e => setPanelFilter(e.target.value)}
              placeholder={panel === 'saved' ? 'Search saved queries' : 'Search history'}
              className="flex-1 min-w-0 bg-transparent text-[12.5px] focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {panel === 'history' && (
            <>
              {history.status === 'loading' && !history.items.length && (
                <div className="p-4 space-y-4">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="space-y-2"><Skel w="40%" h={8} /><Skel w="90%" h={10} /></div>)}</div>
              )}
              {history.status === 'error' && <ErrorPanel error={history.error} onRetry={loadHistory} />}
              {history.status === 'ready' && history.items.length === 0 && (
                <EmptyState icon={History} title="No history yet">Queries you run show up here.</EmptyState>
              )}
              {filteredPanelItems(history.items).map(h => (
                <div key={h.id} className="group px-4 py-3 border-b border-[#f1efed] hover:bg-[#fbfaf9]">
                  <div className="flex items-center gap-2 mb-1.5 min-h-[24px] text-[11px] text-[#766a63] tabular-nums">
                    <StatusDot color={h.status === 'success' ? T.green : T.maroon} />
                    <span>{formatWhen(h.created_at)}</span>
                    <span>·</span>
                    <span>{fmtMs(h.elapsed_ms)}</span>
                    {h.row_count != null && <><span>·</span><span className="truncate">{plural(h.row_count, 'row')}</span></>}
                    {E.pickDb && h.database && <><span>·</span><span className="truncate" title="Database">{h.database}</span></>}
                    <span className="ml-auto flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <IconButton icon={ExternalLink} label="Open in a new worksheet" size={24} iconSize={13} onClick={() => loadSql(h.sql, null, true, h.database)} />
                    </span>
                  </div>
                  <button onClick={() => loadSql(h.sql, null, false, h.database)} className="block w-full text-left rounded-md -mx-1.5 px-1.5 py-1 hover:bg-[#f1efed]" title={`${h.sql.length > 900 ? `${h.sql.slice(0, 900)}...` : h.sql}\n\nClick to load into the current worksheet`}>
                    <div className="text-[12px] leading-[18px] font-mono text-[#312c2a] whitespace-pre-wrap line-clamp-6 break-words"><SqlCode sql={h.sql} /></div>
                  </button>
                  {h.error && <div className="mt-1.5 text-[11px] text-[#9e0000] line-clamp-2">{h.error}</div>}
                </div>
              ))}
              {history.items.length > 0 && (
                <div className="p-3 text-center">
                  <Button size="sm" variant={armed === 'history' ? 'danger' : 'ghost'} icon={Trash2} onClick={() => arm('history', clearHistory)}>{armed === 'history' ? 'Click again to clear all history' : 'Clear history'}</Button>
                </div>
              )}
            </>
          )}
          {panel === 'saved' && (
            <>
              {saved.status === 'loading' && !saved.items.length && (
                <div className="p-4 space-y-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="space-y-2"><Skel w="50%" h={10} /><Skel w="85%" h={8} /></div>)}</div>
              )}
              {saved.status === 'error' && <ErrorPanel error={saved.error} onRetry={loadSaved} />}
              {saved.status === 'ready' && saved.items.length === 0 && (
                <EmptyState icon={Bookmark} title="No saved queries">Use the bookmark above the editor, or {MOD} + S, to keep a query for later.</EmptyState>
              )}
              {filteredPanelItems(saved.items).map(s => (
                <div key={s.id} className="group px-4 py-3 border-b border-[#f1efed] hover:bg-[#fbfaf9]">
                  <div className="flex items-start gap-2">
                    <button onClick={() => loadSql(s.sql, s.name, true, s.database)} className="flex-1 min-w-0 text-left">
                      <div className="text-[13px] font-bold text-[#312c2a] truncate" title={s.name}>{s.name}</div>
                      <div className="mt-0.5 text-[11px] text-[#766a63] truncate">
                        {formatWhen(s.updated_at)}{s.shared ? ' · shared' : ''}{!s.owned && s.user_email ? ` · ${s.user_email}` : ''}
                      </div>
                    </button>
                    {s.owned && (
                      armed === `saved:${s.id}`
                        ? <Button size="sm" variant="danger" onClick={() => arm(`saved:${s.id}`, () => deleteSaved(s.id))}>Delete?</Button>
                        : <IconButton icon={Trash2} label="Delete saved query" size={26} iconSize={13} onClick={() => arm(`saved:${s.id}`, () => deleteSaved(s.id))} className="md:opacity-0 md:group-hover:opacity-100" />
                    )}
                  </div>
                  <div className="mt-1.5 text-[11.5px] leading-[17px] font-mono text-[#6e6259] whitespace-pre-wrap line-clamp-4 break-words"><SqlCode sql={s.sql} /></div>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {/* --------------------------------- modals -------------------------------- */}
      <ConfirmDestructiveModal
        info={pendingConfirm}
        confirming={confirming}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const info = pendingConfirm;
          setPendingConfirm(null);
          setConfirming(true);
          patchView(info.tabId, { status: 'starting', startedAt: Date.now(), sql: info.sql });
          submitQuery(info.tabId, info.sql, true);
        }}
      />
      <TextModal title={textModal?.title} subtitle={textModal?.subtitle} body={textModal?.body} sql={textModal?.body !== 'Loading DDL...'} onClose={() => setTextModal(null)} />
      <TextModal
        title={cellDetail?.title}
        subtitle="Cell value"
        body={cellDetail?.body}
        loadFull={cellDetail?.loadFull}
        fileName={cellDetail?.title}
        onClose={() => setCellDetail(null)}
      />
      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} width={440} labelledBy="sf-keys-title">
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[#e8e6e3]">
          <Keyboard size={17} className="text-[var(--sig-ink)]" />
          <h3 id="sf-keys-title" className="flex-1 font-johnson-display font-bold text-[15px] text-[#312c2a]">Editor shortcuts</h3>
          <IconButton icon={X} label="Close" onClick={() => setShortcutsOpen(false)} />
        </div>
        <div className="overflow-y-auto px-5 py-2">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-2 border-b border-[#f1efed] last:border-0 text-[12.5px]">
              <span className="text-[#312c2a]">{label}</span>
              <span className="flex items-center gap-1 flex-shrink-0">{keys.split(' ').map((k, i) => (k === '/' ? <span key={i} className="text-[#766a63]">/</span> : <Kbd key={i}>{k}</Kbd>))}</span>
            </div>
          ))}
          <p className="py-3 text-[11.5px] text-[#766a63]">Case changes apply to the selection, or to the word under the cursor when nothing is selected. Ctrl+Z undoes any of them. Copied cells paste into Excel as cells, and the status bar shows the count, sum and average of a selection.</p>
        </div>
      </Modal>
      <ShareModal
        open={shareOpen && active.kind === 'query'}
        onClose={() => setShareOpen(false)}
        tab={active}
        meta={sharedMeta}
        session={session}
        engineLabel={E.label}
        colorOf={peerColor}
        onShare={shareWorksheet}
        onInvite={inviteToShared}
        onRemove={removeFromShared}
        onStop={stopSharing}
        link={shareLink}
      />
      <SavePromptModal
        open={savePromptOpen}
        initialName={active.kind === 'query' ? active.name : ''}
        onCancel={() => setSavePromptOpen(false)}
        onSave={saveCurrentQuery}
      />
      <ApplyChangesModal
        preview={savePreview}
        table={editing ? editTable : null}
        saving={saving}
        onCancel={() => setSavePreview(null)}
        onApply={applySave}
      />
    </div>
  );
}