import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  AlignLeft, CaseSensitive, Keyboard, Ban, Bookmark, ChartColumnBig, Check, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, CircleCheck,
  Columns2, Grid3x3, IdCard, Rows2, ScanText, Columns3, Copy, CopyPlus, Database, Download, ExternalLink, FileCode2, History, Info, KeyRound,
  Loader2, Maximize2, Minimize2, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Search, Sun, Table2,
  Trash2, TriangleAlert, Undo2, UserPlus, Users, WifiOff, X,
} from 'lucide-react';
import TableCopier from './TableCopier';
import { ChartView, PivotView, ProfileView, RecordView } from './resultViews';
import { apiEventSource, apiFetch, downloadFile } from '../../../utils/apiClient';
import { SharedSession } from './collab';
import { useInPageLog } from '../useInPageLog';
import { useRBAC } from '../../../context/RBACContext';
import { cellText, EXPORT_FORMATS, fetchJson, formatWhen, leadKeywordHint, PAGE_SIZE_OPTIONS } from '../shared/studioHelpers';
import {
  displayType, EngineCtx, ENGINES, firstName, fmtMs, fmtN, isBig, MOD, NF, plural, sigVars, statementSpans, T, typeFamily, useEngine, withQs,
} from './paneLib';
import {
  ApplyChangesModal, Button, ConfirmDestructiveModal, ConnCard, EdTool, EmptyState, ErrorPanel, GridSkeleton, IconButton, Kbd, Modal, Pager,
  PeerActivity, PeerBar, Picker, ProgressBar, RunBar, SavePromptModal, ShareModal, Skel, Spinner, SqlCode, StatementStrip, StatusDot,
  TextModal, Toasts, ViewTab,
} from './paneUi';
import { SfExplorer, TableDetails } from './explorer';
import { FilterBar, FilterButton, Floating, SfGrid } from './grid';
import { SfEditor } from './editor';
import { ValueViewer } from './valueViewer';

const NF4 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

const fmtStat = (n) => (Number.isInteger(n) ? NF.format(n) : NF4.format(n));

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

/* --------------------------- shared worksheets --------------------------- */

// One colour per person, by their place in the worksheet (owner first). Red is
// left out: that is your own caret.
const PEER_COLORS = ['#0f68b2', '#8c3bbb', '#328714'];

// Typing in the editor re-renders the pane on every key. The grid only has
// to repaint when its data does, so it is memoized, and its callbacks are
// passed through a ref so they are always the latest ones anyway.
const NO_META = {};

const NO_ROWS = [];

/* --------------------- editing a query's result rows --------------------- */
// A result can be edited in place when it plainly comes from one table, the
// way DBeaver allows it: one SELECT, one table, no joins, grouping or set ops.
const IDENT = '(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)';

const FROM_ONE = new RegExp(`\\bFROM\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2})`, 'gi');

const NOT_EDITABLE = /\b(JOIN|GROUP\s+BY|UNION|INTERSECT|EXCEPT|MINUS|DISTINCT|HAVING|PIVOT|UNPIVOT|LATERAL|FLATTEN|CONNECT\s+BY|MATCH_RECOGNIZE|QUALIFY|RESULT_SCAN)\b/i;

// Profile's "Whole table" only needs to know which one table a SELECT reads,
// so grouping, DISTINCT and the like are fine; joins and set operations aren't.
const NOT_ONE_TABLE = /\b(JOIN|UNION|INTERSECT|EXCEPT|MINUS|LATERAL|FLATTEN|RESULT_SCAN)\b/i;

function editTargetFor(sql, defaultDb, defaultSchema, upperIdents = true, anyShape = false) {
  const clean = String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(clean)) return { error: 'Only the result of a SELECT can be edited.' };
  if ((clean.match(/\bSELECT\b/gi) || []).length > 1) return { error: 'Results with subqueries or CTEs can\'t be edited. Select from the table directly.' };
  const bad = (anyShape ? NOT_ONE_TABLE : NOT_EDITABLE).exec(clean);
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

// Inside [data-tip-delay] (the explorer tree, the results and the data
// editor) a tip waits this long, so running the pointer over rows or cells
// doesn't flash one per row. Moving on from a tip that was showing (within
// TIP_WARM_MS) skips the wait.
const TIP_DELAY_MS = 500;
const TIP_WARM_MS = 300;

export function TipLayer({ children }) {
  const [text, setText] = useState(null);
  const shown = useRef(false);
  const warmUntil = useRef(0);
  const timer = useRef(0);
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

  const show = useCallback((tip) => { shown.current = !!tip; setText(tip); }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (shown.current) warmUntil.current = Date.now() + TIP_WARM_MS;
    shown.current = false;
    elRef.current = null;
    setText(null);
  }, []);
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
    clearTimeout(timer.current);
    const warm = shown.current || Date.now() < warmUntil.current;
    if (tip && !warm && el.closest('[data-tip-delay]')) {
      timer.current = setTimeout(() => { if (elRef.current === el) show(tip); }, TIP_DELAY_MS);
      return;
    }
    show(tip);
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

  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(timer.current); }, []);

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
  }, [E.api]);
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
  }, [tabs, active.id, LS]);

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

  // Bumped whenever objects may have changed (a run that wrote or ran DDL, a
  // finished copy, the explorer's Refresh). The explorer, the pickers and the
  // editor's suggestions all re-read their object lists from it.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalogChanged = useCallback(() => setCatalogVersion(v => v + 1), []);

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
  }, [E.pickDb, E.api, connState, schemaKey, schemaLists]);

  useEffect(() => {
    if (!catalogVersion) return;
    setDbLists({});
    setSchemaLists({});
  }, [catalogVersion]);

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
  const closeCell = useCallback(() => setCellDetail(null), []);
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
  }, [E.api]);
  const loadSaved = useCallback(() => {
    setSaved(s => ({ ...s, status: 'loading', error: null }));
    fetchJson(`${E.api}/saved`)
      .then(data => setSaved({ status: 'ready', items: data.saved || [], error: null }))
      .catch(err => setSaved(s => ({ ...s, status: 'error', error: err.message })));
  }, [E.api]);

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
  }, [patchView, toast, E.api]);

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
    // Failed and cancelled runs too: a script can create objects before it stops.
    if (data.changes_catalog && data.status !== 'running') catalogChanged();
    if (data.status === 'success' && data.returns_rows && !firstPage) fetchPage(tabId, jid, 1, pageSize, [], [], seq);
    const resumeSql = pendingEditRef.current[tabId];
    delete pendingEditRef.current[tabId];
    if (resumeSql && data.status === 'success' && data.returns_rows) resumeEditRef.current?.(tabId, resumeSql, data.columns || []);
    loadHistory();
  }, [fetchPage, pageSize, loadHistory, patchView, catalogChanged]);

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
  }, [applyFinished, patchView, E.api]);

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
  }, [patchView, E.api]);

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

  // A Profile card's "Whole table" button: that column over the table the
  // result plainly reads (the data editor's own table, with its filters), or
  // failing that, "All rows" of the result when it is bigger than the page.
  let profileWide = null;
  {
    const filters = view.filters || [];
    const post = (body) => (columns) => fetchJson(withQs(`${E.api}/profile`, cq), { method: 'POST', body: { ...body, columns } });
    const t = isData ? active.table
      : view.sql ? editTargetFor(view.sql, tabDb, E.pickDb ? serverInfo?.default_schema : tabSchema, E.upperIdents, true) : null;
    if (t && !t.error && t.table) {
      const tf = isData ? filters : [];
      profileWide = {
        label: 'Whole table', title: `This column over every row of ${t.table}${tf.length ? ', with the filters' : ''}`,
        key: `t|${E.id}|${cq}|${t.database}.${t.schema}.${t.table}|${JSON.stringify(tf)}`,
        load: post({ source: 'table', database: t.database, schema: t.schema, table: t.table, filters: tf }),
      };
    } else if (!isData && view.jobId && view.status === 'success' && (view.rowCount == null || view.rowCount > (view.rows || []).length)) {
      profileWide = {
        label: 'All rows', title: `This column over all ${view.rowCount != null ? fmtN(view.rowCount) : ''} rows of the result${filters.length ? ', with the filters' : ''}`,
        key: `r|${view.jobId}|${JSON.stringify(filters)}`,
        load: post({ source: 'result', job_id: view.jobId, filters }),
      };
    }
  }
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
          <div className="px-4 py-2 border-b border-[#e8e6e3] flex items-center gap-2 h-[41px]" style={{ background: E.soft }}>
            <Skel w={120} h={10} /><Skel w={64} h={10} className="ml-auto" />
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
            catalogVersion={catalogVersion}
            onRefresh={catalogChanged}
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
            {canCopy ? <TableCopier serverInfo={serverInfo} catalogVersion={catalogVersion} onFinished={catalogChanged} /> : (
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
                  catalogVersion={catalogVersion}
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
            data-tip-delay
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
                          value,
                          type: (view.columns || []).find(c => c.name === col)?.type || null,
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
                  <ProfileView columns={gridColumns} families={gridFamilies} rows={view.rows} total={view.rowCount} accent={E.accent} onChart={name => { setChartBy(name); setResultTab('chart'); }} wide={profileWide} />
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
      <ValueViewer cell={cellDetail} onClose={closeCell} />
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
