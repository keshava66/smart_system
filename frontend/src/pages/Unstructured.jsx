import React, { Suspense, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useSearchParams, useNavigate } from 'react-router-dom';
import LoadingSpinner from './components/LoadingSpinner';
import VrExternalWelcome from './components/VrExternalWelcome';
import { haOf, passesFacets, pickedCount } from './components/vrExternalFacets';
import UnstructuredWelcome from './components/UnstructuredWelcome';
import { lazyPage } from '../utils/lazyPage';

// Each explorer is its own download, fetched the first time it's opened (or
// ahead of time from the welcome screen), so opening one doesn't pay for all.
const EpodExplorer = lazyPage(() => import('./components/EpodExplorer'));
const NipoExplorer = lazyPage(() => import('./components/NipoExplorer'));
const FDAExplorer = lazyPage(() => import('./components/FDAExplorer'));
const VirtualRegulatorExplorer = lazyPage(() => import('./components/VirtualRegulatorExplorer'));
const VrExternalExplorer = lazyPage(() => import('./components/VrExternalExplorer'));
const ImmbotExplorer = lazyPage(() => import('./components/ImmbotExplorer'));
const CortellisExplorer = lazyPage(() => import('./components/CortellisExplorer'));
const EXPLORERS_BY_DOC_TYPE = {
  vr: [VirtualRegulatorExplorer, VrExternalExplorer, CortellisExplorer],
  immbot: [ImmbotExplorer],
  epod: [EpodExplorer],
  nipo: [NipoExplorer],
  fda: [FDAExplorer],
};
const preloadDocType = (id) => (EXPLORERS_BY_DOC_TYPE[id] || []).forEach(c => c.preload());
const ExplorerLoading = () => (
  <div className="flex-1 min-h-0 flex items-center justify-center"><LoadingSpinner /></div>
);
import { useRBAC, UNSTRUCTURED_TABS, UNSTRUCTURED_SUBTABS } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';

import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import recordsIcon from "/icons/JJ_Icon_Records_Information_RGB.svg";
import shieldIcon from "/icons/JJ_Icon_Shield_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import analysisIcon from "/icons/JJ_Icon_Analysis_RGB.svg";
import dataVizIcon from "/icons/JJ_Icon_Data_Visualization.svg";
import safetyIcon from "/icons/JJ_Icon_Safety.svg";
import leaderIcon from "/icons/JJ_Icon_Leader_RGB.svg";
import aiIcon from "/icons/JJ_Icon_AI_RGB.svg";
import editIcon from "/icons/JJ_Icon_Edit_RGB.svg";
import { apiFetch, apiJson, downloadFile } from '../utils/apiClient';

// Collapsible "Search fields" block for the filter rail. Starts closed (open if a
// search is already filled in) so the text boxes don't push the facets off
// screen. Inputs stay mounted while closed, so typed values are kept.
function SearchSection({ children, label = 'Search fields', hint = 'Type in any box to find records where that field contains your text. Boxes combine, so every filled box has to match. Results update a moment after you stop typing.' }) {
  const bodyRef = useRef(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const n = [...el.querySelectorAll('input')].filter(i => i.value.trim()).length;
    if (n !== active) setActive(n);
  });
  // Opens by itself once if it mounts with a search already typed in (e.g. the
  // filter rail was collapsed and reopened). The count above lands after the
  // first render, so this has to follow it rather than run once on mount.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (active > 0 && !autoOpened.current) { autoOpened.current = true; setOpen(true); }
  }, [active]);
  return (
    <div className="border-b border-jj-gray-01 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={hint}
        className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors"
      >
        <span className="flex items-center gap-2 text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          <svg viewBox="0 0 16 16" className="w-[13px] h-[13px] flex-shrink-0 text-jj-gray-06" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m10.4 10.4 3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {label}
          {active > 0 && (
            <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">
              {active}
            </span>
          )}
        </span>
        <svg viewBox="0 0 10 10" className={`w-2.5 h-2.5 flex-shrink-0 text-jj-gray-06 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div ref={bodyRef} className={open ? 'px-[18px] pb-3.5 space-y-2 max-h-[45vh] overflow-y-auto' : 'hidden'}>
        {children}
      </div>
    </div>
  );
}


// Column keys -> readable labels in detail panels ("first_created_at" -> "First created at").
const prettyKey = (k) => String(k).replace(/_/g, ' ').toLowerCase()
  .replace(/\b(id|url|pdf|jj|eu|us|fda|crl|ectd|rim)\b/g, (m) => m.toUpperCase())
  .replace(/^./, (c) => c.toUpperCase());


const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// jj-red = #eb1700 -> normalized 0.9216 / 0.0902 / 0
// feColorMatrix repaints any icon solid red based only on shape/alpha,
// regardless of the source SVG's own color. Extra matrices provide the
// ink / gray / white tints the redesign uses.
const IconDefs = () => (
  <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <filter id="jj-red-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.9216  0 0 0 0 0.0902  0 0 0 0 0  0 0 0 1 0" />
    </filter>
    <filter id="jj-ink-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.1922  0 0 0 0 0.1725  0 0 0 0 0.1647  0 0 0 1 0" />
    </filter>
    <filter id="jj-gray-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.5059  0 0 0 0 0.4627  0 0 0 0 0.4353  0 0 0 1 0" />
    </filter>
    <filter id="jj-white-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
    </filter>
  </svg>
);

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};

const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

// Copy-to-clipboard glyph (two overlapping sheets) - no SVG asset needed,
// just inherits text color via currentColor so it matches whatever button
// it's dropped into (dark editor toolbar, light SQL modal, etc).
const CopyIcon = ({ className = "w-3 h-3" }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

// Columns shown in the table, in order. (Table is ~2.8M rows in Snowflake -
// everything here is paginated/filtered server-side, never loaded whole.)
const DEFAULT_COLUMNS = [
  "FILE_NAME", "OBJ_ID", "A_STATUS", "R_VERSION_LABEL",
  "OBJECT_NAME", "ARTIFACT_NAME", "PRODUCT_CODE", "DOMAIN",
  "INSIGHT_FAMILY_CODE", "INSIGHT_FAMILY_NAME", "INSIGHT_THERAPEUTIC_AREA",
  "JJ_NUMBER", "JJ_TITLE", "CLINICAL_TRIAL_ID",
];

// Columns that get a checkbox facet in the left rail.
const FILTERABLE_COLUMNS = [
  "A_STATUS", "STATUS", "DOMAIN", "PRODUCT_CODE", "ARTIFACT_NAME",
  "INSIGHT_FAMILY_CODE", "INSIGHT_FAMILY_NAME", "INSIGHT_THERAPEUTIC_AREA", "CLINICAL_TRIAL_ID",
];

// Starting width per column (px) before the user drags anything - roughly
// what each column needs for a typical value, so the table doesn't open
// looking cramped or wasting space.
const DEFAULT_COL_WIDTHS = {
  FILE_NAME: 210, OBJ_ID: 160, A_STATUS: 110, R_VERSION_LABEL: 130,
  OBJECT_NAME: 220, ARTIFACT_NAME: 190, PRODUCT_CODE: 130, DOMAIN: 110,
  INSIGHT_FAMILY_CODE: 170, INSIGHT_FAMILY_NAME: 170, INSIGHT_THERAPEUTIC_AREA: 170,
  JJ_NUMBER: 130, JJ_TITLE: 220, CLINICAL_TRIAL_ID: 150,
};
const MIN_COL_WIDTH = 60;
const MAX_AUTOFIT_WIDTH = 640;

// Lazily-created offscreen canvas reused for every text measurement - a
// fresh canvas per call would work too, just wasteful given how often
// double-click-to-fit (and now auto-fit-on-load) can fire.
let _measureCanvas = null;
function measureTextWidth(font, text) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Snowflake/DBeaver-style default: every column sized to whatever its
// widest visible value needs, computed fresh off whatever rows are on
// screen right now. Returns a plain { COL: px } map - callers layer any
// user drag-resize on top of this, not the other way around.
// headerFont/cellFont are measured separately - the header renders bold
// uppercase at 10.5px, body cells render regular weight at 12px, and those
// two fonts do NOT produce the same per-character width, so measuring both
// with one font (the header's) systematically underestimates how wide the
// actual data needs and clips the longest values in a column.
// A_STATUS doesn't render its raw text - it renders StatusPill, which adds
// its own padding (9px each side), a small dot, and the gap before the
// label. Measuring the plain status string and stopping there leaves the
// pill nowhere near enough room, so it clips ("Superseded.."). Extend this
// map if other columns ever get a similar chip/pill treatment.
const COLUMN_CHROME_EXTRA = { A_STATUS: 32 };

function computeFitWidths(headerFont, cellFont, cols, rowsForMeasure, cellTextFor) {
  const widths = {};
  cols.forEach(col => {
    let max = measureTextWidth(headerFont, col);
    rowsForMeasure.forEach(r => {
      const w = measureTextWidth(cellFont, cellTextFor(r, col));
      if (w > max) max = w;
    });
    const chrome = COLUMN_CHROME_EXTRA[col] || 0;
    widths[col] = Math.min(MAX_AUTOFIT_WIDTH, Math.max(MIN_COL_WIDTH, Math.ceil(max) + 40 + chrome)); // + cell padding/sort arrow, with a little slack for rounding
  });
  return widths;
}

// Tracks a scroll container's live width so the filler column can absorb
// whatever's left over after the real columns, instead of the table just
// stopping short and leaving a dead gray gap before the scrollbar. Uses a
// callback ref (not a plain useRef) because the table's tab unmounts the
// div when you switch away - a plain ref wouldn't reattach the observer
// when it comes back.
function useElementWidth() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef(null);
  const setRef = useCallback((el) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect?.width;
        if (w != null) setWidth(w);
      });
      ro.observe(el);
      observerRef.current = ro;
      setWidth(el.clientWidth);
    } else {
      setWidth(0);
    }
  }, []);
  return [width, setRef];
}

const TAB_LABELS = {
  overview: 'Explore',
  table: 'Data table',
  breakdown: 'Domain breakdown',
};

const DOC_TYPE_LABELS = {
  vr: 'Virtual Regulator',
  immbot: 'IMMBOT',
  mirai: 'MirAI',
  rmwcreate: 'RMWCreate',
  rimdocs: 'RimDocs',
  fda: 'FDA & Others',
  epod: 'EPOD',
  haq: 'Q!',
  nipo: 'Nipocalimab',
};

// Same glyph each document set gets on the welcome screen, so the tab strip
// reads as the compact version of that grid.
const DOC_TYPE_ICONS = {
  vr: leaderIcon,
  immbot: safetyIcon,
  mirai: aiIcon,
  rmwcreate: editIcon,
  rimdocs: recordsIcon,
  fda: shieldIcon,
  epod: databaseIcon,
  haq: analysisIcon,
  nipo: dataVizIcon,
};

// FDA tab dashboard picker - add new dashboards here as they're built; the
// dropdown button and routing below already support any number of entries.
// `table` drives the "Postgres · schema.table" label in the header.
const FDA_DASHBOARDS = [
  { id: 'crl_matches', label: 'CRL AI Matches', table: 'vector_embedding.crl_ai_matches' },
  { id: 'crl_letters', label: 'CRL Letters Overview', table: 'vector_embedding.crl_letters' },
  { id: 'crl_pink_letters', label: 'Pink Sheet Letters', table: 'vector_embedding.crl_pink_letters' },
  { id: 'ectd_docs', label: 'eCTD Documents', table: 'vector_embedding.ectd_docs' },
  { id: 'fda_letters_v2', label: 'FDA CRL Letters', table: 'vector_embedding.fda_crl_letters' },
  { id: 'milvexian_metadata', label: 'Milvexian Metadata', table: 'vector_embedding.milvexian_metadata' },
  { id: 'rim_facility_index', label: 'RIM Facility Index', table: 'vector_embedding.rimdocs_facility_index_unified' },
];

const VR_TAB_LABELS = { explore: 'Explore', table: 'Data table' };
// Internal gets the business views; External keeps Explore / Data table
const VR_INTERNAL_TAB_LABELS = { explore: 'Overview', library: 'Documents', table: 'Data table' };
const VR_EXT_FALLBACK = [{ id: 'press_releases', label: 'FDA Press Releases', kind: 'press' }];
const IMMBOT_TAB_LABELS = { explore: 'Explore', table: 'Data table', breakdown: 'Breakdown' };

const FILTER_LABELS = {
  A_STATUS: "Status",
  STATUS: "Ingestion Status",
  DOMAIN: "Domain",
  PRODUCT_CODE: "Product code",
  ARTIFACT_NAME: "Artifact name",
  INSIGHT_FAMILY_CODE: "Insight family code",
  INSIGHT_FAMILY_NAME: "Insight family",
  INSIGHT_THERAPEUTIC_AREA: "Therapeutic area",
  CLINICAL_TRIAL_ID: "Clinical trial ID",
};

// Fixed colors keyed by status text (from the jj-* tailwind palette,
// never row-order-dependent).
const STATUS_COLOR_MAP = {
  "Approved": "#328714",   // jj-green-03
  "Superseded": "#0f68b2", // jj-blue-03
  "Withdrawn": "#eb1700",  // jj-red
  "Retired": "#a39992",    // jj-gray-05
};
const FALLBACK_COLORS = ["#ff6017", "#8c3bbb", "#004685", "#9e0000", "#3b5a0d"];
// Colors for the therapeutic-area × domain stacked chart, assigned to domains
// in descending-volume order (stable for a given response).
const DOMAIN_PALETTE = ["#0f68b2", "#328714", "#ff6017", "#8c3bbb", "#eb1700", "#004685", "#53ce76", "#9e0000", "#fbe058", "#b19beb", "#541980", "#a39992"];
function colorForStatus(status, fallbackIndexRef) {
  if (STATUS_COLOR_MAP[status]) return STATUS_COLOR_MAP[status];
  const color = FALLBACK_COLORS[fallbackIndexRef.i % FALLBACK_COLORS.length];
  fallbackIndexRef.i += 1;
  return color;
}

// Fixed colors for the STATUS column (ingestion status) - a pipeline-run
// state, not a document lifecycle state like A_STATUS, so it gets its own
// map: green = success, orange = failed/error (shown to users as "Pending" -
// see INGESTION_STATUS_DISPLAY_LABELS below), blue = in progress. Matched
// case-insensitively since the raw column may come back in any case.
const INGESTION_STATUS_COLOR_MAP = {
  SUCCESS: "#328714",  // jj-green-03
  ERROR: "#ff6017",    // jj-orange-03
  FAILED: "#ff6017",   // jj-orange-03
  RUNNING: "#0f68b2",  // jj-blue-03
};
function colorForIngestionStatus(status, fallbackIndexRef) {
  const key = String(status || "").trim().toUpperCase();
  if (INGESTION_STATUS_COLOR_MAP[key]) return INGESTION_STATUS_COLOR_MAP[key];
  const color = FALLBACK_COLORS[fallbackIndexRef.i % FALLBACK_COLORS.length];
  fallbackIndexRef.i += 1;
  return color;
}

// Display-only rename for the STATUS column: users see "Pending" instead of
// "ERROR", but the raw value (filter state, API params, WHERE clauses) stays
// ERROR everywhere - only what's rendered on screen goes through this.
const INGESTION_STATUS_DISPLAY_LABELS = {
  ERROR: "PENDING",
};
function ingestionStatusDisplayLabel(status) {
  const key = String(status || "").trim().toUpperCase();
  return INGESTION_STATUS_DISPLAY_LABELS[key] || status;
}

// filters state -> a JSON blob the backend json.loads()'s back into a dict.
// Deliberately NOT percent-encoded here: URLSearchParams encodes the value
// exactly once when the request URL is built. Encoding it here too would
// double-encode (e.g. a value containing a space or a quote character would
// come out as %2520/%2522 on the wire, and the backend - which only
// URL-decodes once - would then compare against that mangled literal
// instead of the real value, so the filter would silently match nothing).
function encodeFilters(filters) {
  const cleaned = {};
  Object.entries(filters).forEach(([col, vals]) => {
    if (vals && vals.length) cleaned[col] = vals;
  });
  return Object.keys(cleaned).length ? JSON.stringify(cleaned) : '';
}

function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// 45900 -> "45.9K", 1250000 -> "1.25M", 2400000000 -> "2.4B" - for compact chart labels.
function formatCompact(n) {
  if (n == null || isNaN(n)) return n;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

// 45900 -> "44.8 KB", 1250000000 -> "1.16 GB" - FILE_SIZE is bytes.
function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let val = Math.abs(n);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  const sign = n < 0 ? '-' : '';
  return `${sign}${val.toFixed(i === 0 ? 0 : 2).replace(/\.00$/, '')} ${units[i]}`;
}

// Absolute Eastern-time rendering, matching the backend's convention
// (audit.py timestamps everything in America/New_York) - explicit timeZone
// so this doesn't silently shift to whatever zone the viewer's own
// browser/OS happens to be set to.
function formatEasternTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) + ' ET';
}

// "Synced X ago" for the header pill - relative, compact. The relative
// portion ("3 min ago") is a delta between two client-clock instants, so
// it's timezone-independent by construction. Once it falls back to an
// absolute date/time (>24h), that absolute rendering must be pinned to
// Eastern explicitly - see formatEasternTimestamp.
function formatTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatEasternTimestamp(ts);
}

// Shared pagination controls: « first ‹ prev [page input] of N next › last ».
// The page input commits on Enter or blur and clamps to [1, totalPages].
function Pager({ page, totalPages, loading, onGo }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onGo(n);
    else setDraft(String(page));
  };
  const btn = "px-2.5 py-1.5 rounded-lg border border-jj-gray-03 text-[11.5px] font-johnson-text disabled:opacity-40 hover:bg-jj-gray-01";
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onGo(1)} disabled={page <= 1 || loading} className={btn} title="First page">«</button>
      <button onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} className={btn} title="Previous page">Prev</button>
      <span className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 tabular-nums">
        <input
          type="number"
          min="1"
          max={totalPages}
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          className="w-[62px] border border-jj-gray-03 rounded-lg px-2 py-1 text-center font-johnson-text tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label="Go to page"
        />
        of {totalPages.toLocaleString()}
      </span>
      <button onClick={() => onGo(page + 1)} disabled={page >= totalPages || loading} className={btn} title="Next page">Next</button>
      <button onClick={() => onGo(totalPages)} disabled={page >= totalPages || loading} className={btn} title="Last page">»</button>
    </div>
  );
}

async function fetchJson(url, opts) {
  // apiFetch attaches the bearer token and accepts a full URL or a bare path.
  const res = await apiFetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

/* ============================== Filter rail ============================== */

function FacetGroup({ label, column, selected, onChange, dotColors, counts }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(counts ? Object.keys(counts) : null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [query, setQuery] = useState('');

  // When exact counts are already on hand (e.g. ingestion status, sourced
  // from the same chart data as the KPI donut), skip the network round-trip
  // and just seed the option list straight from those counts - and re-seed
  // if the counts arrive/refresh after this group has already mounted.
  useEffect(() => {
    if (counts) setOptions(Object.keys(counts));
  }, [counts]);

  const loadOptions = useCallback(async () => {
    if (counts) return;
    if (options !== null) return;
    setLoading(true);
    setFailedToLoad(false);
    try {
      const data = await fetchJson(`${API_BASE_URL}/api/unstructured/filter-options?column=${column}`);
      setOptions(data.values || []);
    } catch {
      setOptions(null);
      setFailedToLoad(true);
    } finally {
      setLoading(false);
    }
  }, [column, options, counts]);

  const toggleValue = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };

  // Counted facets (ingestion status) show biggest-first with a relative
  // volume bar; plain facets keep whatever order the backend returned.
  const baseOptions = counts
    ? [...(options || [])].sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
    : (options || []);
  const shown = baseOptions.filter(o => o.toLowerCase().includes(query.toLowerCase()));
  const maxCount = counts ? Math.max(1, ...Object.values(counts)) : 0;

  return (
    <div className="border-b border-jj-gray-01 last:border-0">
      <button
        onClick={() => { setOpen(o => !o); if (!open) loadOptions(); }}
        className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors"
      >
        <span className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          {label}
          {selected.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">
              {selected.length}
            </span>
          )}
        </span>
        <Icon src={open ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5 flex-shrink-0" />
      </button>
      {open && (
        <div className="px-[18px] pb-3.5">
          {(options && options.length > 8) && (
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Narrow list…"
              className="w-full mb-2 px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
            />
          )}
          <div className="max-h-48 overflow-y-auto overflow-x-hidden">
            {loading && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Loading…</div>}
            {!loading && failedToLoad && (
              <div className="py-1.5">
                <div className="text-xs font-johnson-text text-jj-maroon-05 mb-1">Couldn't load values.</div>
                <button onClick={loadOptions} className="text-xs font-johnson-text text-jj-blue-03 underline">Retry</button>
              </div>
            )}
            {!loading && !failedToLoad && options !== null && shown.length === 0 && (
              <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">No values found</div>
            )}
            {!loading && !failedToLoad && shown.map(opt => {
              const color = (dotColors && dotColors[opt]) || STATUS_COLOR_MAP[opt] || '#cbc4bc';
              if (counts) {
                const checked = selected.includes(opt);
                const count = counts[opt] || 0;
                const pct = Math.round((count / maxCount) * 100);
                return (
                  <label key={opt} className="flex flex-col gap-1.5 py-2 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={checked} onChange={() => toggleValue(opt)} className="accent-[#0f68b2] flex-shrink-0" />
                      <span
                        className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold text-jj-gray-08' : 'font-medium'}`}
                        style={checked ? undefined : { color }}
                      >
                        {column === 'STATUS' ? ingestionStatusDisplayLabel(opt) : opt}
                      </span>
                      <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">{formatCompact(count)}</span>
                    </div>
                    <div className="h-[5px] rounded-full bg-jj-gray-01 ml-[22px]">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                    </div>
                  </label>
                );
              }
              return (
                <label key={opt} className="flex items-center gap-2 py-[5px] text-[12.5px] font-johnson-text text-jj-gray-08 cursor-pointer hover:bg-jj-gray-01/60 rounded px-1 -mx-1">
                  <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggleValue(opt)} className="accent-[#0f68b2]" />
                  <span className="truncate flex items-center gap-2">
                    {column === 'A_STATUS' && (
                      <span className="w-[7px] h-[7px] rounded-full inline-block flex-shrink-0" style={{ background: color }} />
                    )}
                    {opt}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterRail({ filters, setFilters, searchFileName, setSearchFileName, searchObjectName, setSearchObjectName, searchJjTitle, setSearchJjTitle, searchArtifactName, setSearchArtifactName, searchJjNumber, setSearchJjNumber, activeFilterCount, onClearAll, onCollapse, statusColors, ingestionStatusCounts, ingestionStatusColors, logInPage }) {
  return (
    <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
      <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
          <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
          Refine
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
              {activeFilterCount}
            </span>
          )}
        </div>
        <button onClick={onClearAll} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
          Clear all
        </button>
        <button onClick={onCollapse} title="Collapse filters" className="p-1 rounded hover:bg-jj-gray-01">
          <Icon src={chevronRightIcon} tint="gray" className="w-2.5 h-2.5 rotate-180" />
        </button>
      </div>

      <SearchSection>
        {[
          { value: searchFileName, set: setSearchFileName, ph: 'File name contains…' },
          { value: searchObjectName, set: setSearchObjectName, ph: 'Object name contains…' },
          { value: searchJjTitle, set: setSearchJjTitle, ph: 'Title contains…' },
          { value: searchArtifactName, set: setSearchArtifactName, ph: 'Artifact name contains…' },
          { value: searchJjNumber, set: setSearchJjNumber, ph: 'JJ number contains…' },
        ].map(({ value, set, ph }) => (
          <div key={ph} className="relative">
            <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
            <input
              value={value}
              onChange={e => set(e.target.value)}
              placeholder={ph}
              className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
            />
          </div>
        ))}
        <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
      </SearchSection>

      <div className="flex-1 overflow-y-auto">
        {FILTERABLE_COLUMNS.map(col => (
          <FacetGroup
            key={col}
            label={FILTER_LABELS[col] || col}
            column={col}
            dotColors={col === 'A_STATUS' ? statusColors : col === 'STATUS' ? ingestionStatusColors : undefined}
            counts={col === 'STATUS' && ingestionStatusCounts && Object.keys(ingestionStatusCounts).length > 0 ? ingestionStatusCounts : undefined}
            selected={filters[col] || []}
            onChange={(vals) => {
              const prevVals = filters[col] || [];
              const added = vals.filter(v => !prevVals.includes(v));
              const removed = prevVals.filter(v => !vals.includes(v));
              const label = FILTER_LABELS[col] || col;
              if (added.length) logInPage('filter_add', `Added ${label} filter: ${added.join(', ')}`);
              if (removed.length) logInPage('filter_remove', `Removed ${label} filter: ${removed.join(', ')}`);
              setFilters(f => ({ ...f, [col]: vals }));
            }}
          />
        ))}
      </div>

      <div className="flex-shrink-0 px-[18px] py-3.5 border-t border-jj-gray-01 text-[10.5px] font-johnson-text text-jj-gray-05 leading-relaxed">
        Charts &amp; table follow your filters.
      </div>
    </div>
  );
}

/* ============================== Modals ============================== */

function SqlModal({ modal, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!modal) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(modal.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable - text is still selectable
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-02 flex-shrink-0 bg-white">
          <div>
            <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Query</h3>
            <div className="text-xs font-johnson-text text-jj-gray-06">{modal.title}</div>
          </div>
          <button onClick={onClose}><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>
        <div className="p-5 flex-1 min-h-0 overflow-y-auto">
          {modal.sql ? (
            <>
              <div className="relative">
                <pre className="text-xs font-mono bg-jj-gray-08 text-white/90 rounded-xl p-4 pr-12 overflow-x-auto whitespace-pre-wrap break-words">
                  {modal.sql}
                </pre>
                <button
                  onClick={handleCopy}
                  title={copied ? 'Copied' : 'Copy SQL'}
                  className={`absolute top-2.5 right-2.5 p-1.5 rounded-lg border transition-colors ${
                    copied ? 'text-jj-green-03 border-jj-green-03/50' : 'text-white/60 border-white/20 hover:text-white hover:border-white/40'
                  }`}
                >
                  {copied ? '✓' : <CopyIcon className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button
                onClick={handleCopy}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-03 text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
              >
                <CopyIcon />
                {copied ? 'Copied' : 'Copy SQL'}
              </button>
            </>
          ) : (
            <div className="text-xs font-johnson-text text-jj-gray-06">
              No query has run yet for this card - it'll appear here after the data loads.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailModal({ record, onClose }) {
  if (!record) return null;
  const cellDisplayText = (v) => {
    if (typeof v === 'object' && v !== null) {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-02 flex-shrink-0 bg-white">
          <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Record detail</h3>
          <button onClick={onClose}><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-0 flex-1 min-h-0 overflow-y-auto">
          {Object.entries(record).map(([k, v]) => (
            <div key={k} className="flex gap-4 text-xs font-johnson-text border-b border-jj-gray-01 last:border-0 py-2.5">
              <div className="w-1/3 text-jj-gray-06 flex-shrink-0">{prettyKey(k)}</div>
              <div className="w-2/3 text-jj-gray-08 break-words">{v === null || v === undefined || v === '' ? <span className="text-jj-gray-04">—</span> : cellDisplayText(v)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================== Charts (no recharts) ============================== */

const ChartSkeleton = ({ height = 240 }) => (
  <div style={{ height }} className="flex items-center justify-center">
    <LoadingSpinner />
  </div>
);

const NoData = () => (
  <div className="text-xs font-johnson-text text-jj-gray-06 py-10 text-center">No data for current filters.</div>
);

// Shown inside a card whose endpoint failed while the others loaded fine
// (e.g. a backend that doesn't serve this chart yet).
const CardUnavailable = ({ message, onRetry }) => (
  <div className="py-9 px-3 text-center">
    <div className="text-xs font-johnson-text text-jj-maroon-05 mb-1.5 break-words">{message}</div>
    <button onClick={onRetry} className="text-xs font-johnson-text text-jj-blue-03 underline">Retry</button>
  </div>
);

// Lightweight cursor-following tooltip for the dependency-free charts.
// rows: [{ label, header: true }] for the title line, then
//       [{ label, value, color? }] per data line (value shown untruncated).
function useChartTip() {
  const [tip, setTip] = useState(null); // { x, y, rows }
  const show = (e, rows) => setTip({ x: e.clientX, y: e.clientY, rows });
  const hide = () => setTip(null);
  const node = tip ? (
    <div
      className="fixed z-[60] pointer-events-none rounded-lg bg-jj-gray-08 text-white shadow-xl px-3 py-2"
      style={{
        left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220),
        // rough height guess (header + rows, ~20px each) so the tooltip
        // flips above the cursor instead of running off the bottom edge
        top: (() => {
          const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
          const estHeight = tip.rows.length * 20 + 16;
          return tip.y + 14 + estHeight > winH ? Math.max(8, tip.y - estHeight - 10) : tip.y + 14;
        })(),
      }}
    >
      {tip.rows.map((r, i) => r.header ? (
        <div key={i} className="text-[11px] font-johnson-text font-bold mb-1 whitespace-nowrap">{r.label}</div>
      ) : (
        <div key={i} className="flex items-center gap-2 text-[11px] font-johnson-text whitespace-nowrap leading-relaxed">
          {r.color && <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: r.color }} />}
          <span className="text-white/70">{r.label}</span>
          <span className="ml-auto pl-4 tabular-nums">{r.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

// Status pill used in the data table.
function StatusPill({ value }) {
  const color = STATUS_COLOR_MAP[value] || "#6e6259";
  const bg = STATUS_COLOR_MAP[value] ? `${color}17` : "rgba(110,98,89,.1)";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: bg, color: value === 'Retired' ? '#6e6259' : color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value}
    </span>
  );
}

// Donut of ingestion status mix (SVG stroke-dasharray) - fed from the
// ingestion-status chart data (the STATUS column). Hovering any segment
// shows every status with its record count plus the total - same all-rows
// tooltip as the other charts.
function StatusDonut({ segments }) {
  const tip = useChartTip();
  const R = 26, C = 2 * Math.PI * R;
  const total = segments.reduce((a, s) => a + s.count, 0);
  const tipRows = [
    { label: 'Ingestion Status', header: true },
    ...segments.map(s => ({ label: ingestionStatusDisplayLabel(s.status), value: s.count, color: s.color })),
    { label: 'Total', value: total },
  ];
  let offset = 0;
  return (
    <>
    <svg width="64" height="64" viewBox="0 0 64 64" className="flex-shrink-0 -rotate-90">
      <circle cx="32" cy="32" r={R} fill="none" stroke="#f1efed" strokeWidth="9" />
      {segments.map((s, i) => {
        const dash = s.frac * C;
        const el = (
          <circle key={i} cx="32" cy="32" r={R} fill="none" stroke={s.color} strokeWidth="9"
            strokeDasharray={`${dash} ${C}`} strokeDashoffset={-offset}
            style={{ cursor: 'default' }}
            onMouseMove={(e) => tip.show(e, tipRows)}
            onMouseLeave={tip.hide}
          />
        );
        offset += dash;
        return el;
      })}
    </svg>
    {tip.node}
    </>
  );
}

// Horizontal stacked bars: one row per domain, segments per status.
function DomainStatusBars({ data, statuses, statusColors, labelWidth = 76 }) {
  const tip = useChartTip();
  const totals = data.map(row => statuses.reduce((a, s) => a + (row[s] || 0), 0));
  const max = Math.max(...totals, 1);
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap text-[10px] font-johnson-text text-jj-gray-07 mb-3">
        {statuses.map(s => (
          <span key={s} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-[2px] inline-block" style={{ background: statusColors[s] }} />{s}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {data.map((row, i) => {
          const present = statuses.filter(s => (row[s] || 0) > 0);
          return (
          <div
            key={row.domain}
            className="flex items-center gap-2.5 cursor-default rounded hover:bg-jj-gray-01/60"
            onMouseMove={(e) => tip.show(e, [
              { label: row.domain, header: true },
              ...present.map(s => ({ label: s, value: row[s], color: statusColors[s] })),
              { label: 'Total', value: totals[i] },
            ])}
            onMouseLeave={tip.hide}
          >
            <span className="text-right text-[11px] font-johnson-text text-jj-gray-07 flex-shrink-0 truncate" style={{ width: labelWidth }}>{row.domain}</span>
            <div className="flex-1 min-w-0">
              {/* Every present status gets minWidth so tiny segments stay visible
                  even inside a short bar; the container min grows to fit them. */}
              <div className="flex h-[15px] rounded overflow-hidden" style={{ width: `${(totals[i] / max) * 100}%`, minWidth: Math.max(8, present.length * 4) }}>
                {present.map(s => (
                  <div key={s} style={{ flex: `${row[s]} 1 0%`, background: statusColors[s], minWidth: 4 }} />
                ))}
              </div>
            </div>
            <span className="w-[42px] text-right text-[11px] font-johnson-text text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(totals[i])}</span>
          </div>
          );
        })}
      </div>
      {tip.node}
    </div>
  );
}

// Ranked horizontal bars for therapeutic areas.
function RankedBars({ data }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex flex-col gap-2">
      {data.map(d => (
        <div
          key={d.area}
          className="cursor-default rounded hover:bg-jj-gray-01/60"
          onMouseMove={(e) => tip.show(e, [
            { label: d.area, header: true },
            { label: 'Records', value: d.count, color: '#0f68b2' },
          ])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
            <span className="text-jj-gray-08 truncate pr-2">{d.area}</span>
            <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(d.count)}</span>
          </div>
          <div className="h-[9px] rounded bg-jj-gray-01">
            <div className="h-full rounded" style={{ width: `${(d.count / max) * 100}%`, background: 'linear-gradient(90deg,#0f68b2,#004685)' }} />
          </div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

// Vertical columns for distinct objects by domain.
function ColumnChart({ data }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 flex items-end gap-2.5 border-b border-jj-gray-02 px-0.5" style={{ minHeight: 150 }}>
        {data.map(d => (
          <div
            key={d.domain}
            className="flex-1 h-full flex flex-col items-center justify-end gap-1 min-w-0 cursor-default rounded hover:bg-jj-gray-01/60"
            onMouseMove={(e) => tip.show(e, [
              { label: d.domain, header: true },
              { label: 'Distinct objects', value: d.count, color: '#328714' },
            ])}
            onMouseLeave={tip.hide}
          >
            <span className="text-[9.5px] font-johnson-text text-jj-gray-07 tabular-nums">{formatCompact(d.count)}</span>
            <div
              className="w-full max-w-[30px] rounded-t-[5px]"
              style={{ height: `${(d.count / max) * 78}%`, minHeight: 3, background: 'linear-gradient(180deg,#53ce76,#328714)' }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2.5 px-0.5 pt-1.5">
        {data.map(d => (
          <div key={d.domain} className="flex-1 text-center text-[9px] font-johnson-text text-jj-gray-06 truncate" title={d.domain}>{d.domain}</div>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

// Format an ISO period into a short axis/tooltip label, shaped by granularity.
// Format an ISO period into a short axis/tooltip label, shaped by granularity.
// Snowflake's DATE_TRUNC buckets land exactly on UTC boundaries (midnight for
// day/week/month), so formatting must stay in UTC too - letting the browser
// convert to local time shifts the displayed date backward for anyone west
// of UTC (e.g. US Eastern), which silently puts a March bucket in "Feb 2026".
function periodLabel(iso, granularity) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  if (granularity === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (granularity === 'hour') {
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' })}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Documents-over-time trend line. data: [{ period: iso string, count }],
// oldest first. Dependency-free SVG line + filled area, same hover-tooltip
// convention as the other charts on this tab.
function TrendLine({ data, granularity = 'month', height = 240 }) {
  const tip = useChartTip();
  const [containerWidth, containerRef] = useElementWidth();
  const [hoverIdx, setHoverIdx] = useState(null);
  const h = height;
  const padL = 46, padR = 28, padT = 16, padB = 26;
  // Every point gets a fixed minimum width so its label never has to fight
  // its neighbors for room - hour labels ("Jun 19, 8 AM") need more room
  // than day/week/month ones, so the floor is wider for hour granularity.
  // Once there are more points than fit at that width, the chart just gets
  // wider than the card and the wrapper below scrolls horizontally instead
  // of thinning labels or squeezing points together.
  //
  // That width is capped, though: at Hour granularity across a long date
  // range there can be thousands of points, and minStepX * thousands would
  // make an SVG hundreds of thousands of pixels wide - past what browsers
  // reliably paint (it renders corrupted/squished until something forces a
  // full re-layout, which is why switching granularity or reloading "fixed"
  // it). MAX_CHART_WIDTH keeps the chart in territory every browser handles
  // cleanly; label thinning (below) only ever kicks in once we're actually
  // up against that cap.
  const MAX_CHART_WIDTH = 12000;
  const minStepX = granularity === 'hour' ? 88 : 68;
  const contentPlotW = Math.min(MAX_CHART_WIDTH - padL - padR, Math.max(1, data.length - 1) * minStepX);
  const w = Math.max(containerWidth, padL + padR + contentPlotW);
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const max = Math.max(...data.map(d => d.count), 1);
  // Round the axis ceiling up to a clean step (like the 0/500/1K/1.5K/2K
  // reference) instead of using the raw max as the top gridline.
  const niceMax = (() => {
    const rough = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return step * 4;
  })();
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const points = data.map((d, i) => ({
    x: padL + i * stepX,
    y: padT + plotH - (d.count / niceMax) * plotH,
    ...d,
  }));
  // Every point gets its own label at the target minStepX spacing. The only
  // time that's not achievable is when MAX_CHART_WIDTH above capped the
  // chart (an extreme point count, mainly Hour granularity over a long
  // range) - in that one case, fall back to thinning labels so they don't
  // overlap, since the chart itself can't grow any wider to fit them all.
  const labelEvery = stepX < minStepX - 1 ? Math.max(1, Math.ceil(minStepX / stepX)) : 1;
  // Gentle Catmull-Rom -> cubic-Bezier smoothing so the line reads as a trend,
  // not a jagged EKG - falls back to a straight segment between any two
  // points that isn't part of a fuller run (start/end of the series).
  const linePath = points.reduce((path, p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const p0 = points[i - 2] || points[i - 1];
    const p1 = points[i - 1];
    const p2 = p;
    const p3 = points[i + 1] || p;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    return `${path} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }, '');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${padT + plotH} L${points[0].x.toFixed(1)},${padT + plotH} Z`;
  const RED = '#d13c2e';
  const hovered = hoverIdx != null ? points[hoverIdx] : null;
  const scrollable = w > containerWidth;
  return (
    <div ref={containerRef} className="w-full">
      {containerWidth > 0 && (
      <div className={scrollable ? 'overflow-x-auto pb-1' : undefined}>
      <svg
        width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}
        onMouseLeave={() => { setHoverIdx(null); tip.hide(); }}
      >
        <defs>
          <linearGradient id="trendAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={RED} stopOpacity="0.16" />
            <stop offset="100%" stopColor={RED} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="#eceae7" strokeWidth="1" />
            <text x={padL - 10} y={padT + plotH * (1 - f) + 4} textAnchor="end" className="fill-jj-gray-06" style={{ font: '11px "Johnson Text", sans-serif' }}>
              {f === 0 ? '0' : formatCompact(niceMax * f)}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#trendAreaFill)" stroke="none" />
        {hovered && (
          <line x1={hovered.x} x2={hovered.x} y1={padT} y2={padT + plotH} stroke={RED} strokeWidth="1" strokeDasharray="3 3" opacity="0.35" />
        )}
        <path
          d={linePath} fill="none" stroke={RED} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 1px 1px rgba(209,60,46,0.15))' }}
        />
        {points.map((p, i) => (
          <g key={i}>
            {/* Wide invisible hit target - the visible dot alone is too small
                to hover reliably, especially with many points packed together. */}
            <rect
              x={p.x - stepX / 2} y={padT} width={Math.max(stepX, 4)} height={plotH} fill="transparent"
              className="cursor-default"
              onMouseMove={(e) => {
                setHoverIdx(i);
                tip.show(e, [
                  { label: periodLabel(p.period, granularity), header: true },
                  { label: 'Documents', value: p.count, color: RED },
                ]);
              }}
            />
            <circle
              cx={p.x} cy={p.y} r={hoverIdx === i ? 6 : data.length > 60 ? 2.5 : 4.5}
              fill={RED} stroke="white" strokeWidth={hoverIdx === i ? 2 : 1.5}
              style={{ transition: 'r 0.1s ease, stroke-width 0.1s ease' }}
              pointerEvents="none"
            />
            {/* Every point gets its own label at normal ranges - labelEvery
                only thins them out when MAX_CHART_WIDTH capped the chart. */}
            {i % labelEvery === 0 && (
              <text
                x={p.x} y={h - 6}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                className="fill-jj-gray-06" style={{ font: '10.5px "Johnson Text", sans-serif' }}
              >
                {periodLabel(p.period, granularity)}
              </text>
            )}
          </g>
        ))}
      </svg>
      </div>
      )}
      {tip.node}
    </div>
  );
}

/* ============================== Breakdown tree helpers ============================== */

// null/empty labels sort first and display as "(blank)" - same convention as
// the pivot table this tab is modeled on.
function breakdownLabel(v) {
  return v && String(v).trim() ? String(v).trim() : '(blank)';
}
function breakdownSortKey(v) {
  return v && String(v).trim() ? String(v).trim() : '';
}

// Flat [domain, ta, artifact, cnt] rows -> 2-level expandable tree.
// grouping='domain' (default) nests Domain -> Therapeutic area -> Artifact.
// grouping='ta' flips the top two levels: Therapeutic area -> Domain -> Artifact.
// Same rows, same totals - just which column drives the outer grouping.
function buildBreakdownTree(rows, grouping = 'domain') {
  const outerMap = new Map();
  let grandTotal = 0;
  rows.forEach(([domain, ta, artifact, cnt]) => {
    const [outerVal, innerVal] = grouping === 'ta' ? [ta, domain] : [domain, ta];
    grandTotal += cnt;
    const oKey = breakdownSortKey(outerVal);
    if (!outerMap.has(oKey)) outerMap.set(oKey, { label: breakdownLabel(outerVal), total: 0, innerMap: new Map() });
    const oNode = outerMap.get(oKey);
    oNode.total += cnt;

    const iKey = breakdownSortKey(innerVal);
    if (!oNode.innerMap.has(iKey)) oNode.innerMap.set(iKey, { label: breakdownLabel(innerVal), total: 0, artifacts: [] });
    const iNode = oNode.innerMap.get(iKey);
    iNode.total += cnt;
    iNode.artifacts.push({ label: breakdownLabel(artifact), count: cnt, domain, ta });
  });

  const domains = Array.from(outerMap.entries())
    .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
    .map(([oKey, o]) => ({
      key: oKey,
      label: o.label,
      total: o.total,
      tas: Array.from(o.innerMap.entries())
        .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
        .map(([iKey, t]) => ({
          key: `${oKey}\u0000${iKey}`,
          label: t.label,
          total: t.total,
          artifacts: t.artifacts.sort((a, b) => (a.label === '(blank)' ? 1 : b.label === '(blank)' ? -1 : a.label.localeCompare(b.label))),
        })),
    }));

  return { grandTotal, domains };
}

// Narrows what's listed without changing what the numbers mean.
function filterBreakdownTree(tree, query) {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const matches = (s) => s.toLowerCase().includes(q);

  const domains = tree.domains
    .map(d => {
      const domainHit = matches(d.label);
      const tas = d.tas
        .map(t => {
          const taHit = matches(t.label);
          const artifacts = (domainHit || taHit) ? t.artifacts : t.artifacts.filter(a => matches(a.label));
          if (!domainHit && !taHit && artifacts.length === 0) return null;
          return { ...t, artifacts };
        })
        .filter(Boolean);
      if (!domainHit && tas.length === 0) return null;
      return { ...d, tas };
    })
    .filter(Boolean);

  return { grandTotal: tree.grandTotal, domains };
}

function BreakdownTree({ tree, expandedDomains, expandedTAs, toggleDomain, toggleTA, onDrillDown }) {
  const gridCols = { gridTemplateColumns: 'minmax(0,1fr) 170px 110px 90px' };
  const drillBtn = (onClick, title) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className="opacity-0 group-hover:opacity-100 text-[10.5px] font-johnson-text text-jj-blue-03 underline flex-shrink-0 transition-opacity"
    >
      View docs
    </button>
  );
  return (
    <div className="font-johnson-text">
      <div className="grid px-[18px] bg-[#faf9f8] border-b border-jj-gray-01 sticky top-0 z-[5]" style={gridCols}>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 py-2 pr-2">Category</div>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 py-2 px-2">Share</div>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 py-2 pl-2 text-right">Objects</div>
        <div />
      </div>
      <div className="grid px-[18px] bg-jj-blue-03/[.06] border-b border-jj-gray-01 text-[12.5px] font-bold text-jj-gray-08" style={gridCols}>
        <div className="py-[9px] pr-2">Grand total</div>
        <div />
        <div className="py-[9px] pl-2 text-right tabular-nums">{tree.grandTotal.toLocaleString()}</div>
        <div />
      </div>
      {tree.domains.map(d => {
        const dOpen = expandedDomains.has(d.key);
        const share = tree.grandTotal ? (d.total / tree.grandTotal) * 100 : 0;
        return (
          <React.Fragment key={d.key}>
            <div onClick={() => toggleDomain(d.key)} className="group grid px-[18px] border-b border-jj-gray-01/60 text-[12.5px] cursor-pointer hover:bg-[#faf9f8]" style={gridCols}>
              <div className="py-[9px] pr-2 flex items-center gap-2 font-bold text-jj-gray-08 min-w-0">
                <Icon src={dOpen ? chevronDownIcon : chevronRightIcon} tint="ink" className="w-[9px] h-[9px] flex-shrink-0" />
                <span className="truncate">{d.label}</span>
              </div>
              <div className="py-[9px] px-2 flex items-center">
                <div className="w-full h-[6px] rounded-[3px] bg-jj-gray-01">
                  <div className="h-full rounded-[3px] bg-jj-blue-03" style={{ width: `${share}%` }} />
                </div>
              </div>
              <div className="py-[9px] pl-2 text-right tabular-nums text-jj-gray-08">{d.total.toLocaleString()}</div>
              <div className="py-[9px] pl-2 flex items-center justify-end">{drillBtn(() => onDrillDown({ level: 'outer', label: d.label }), `View documents in "${d.label}"`)}</div>
            </div>
            {dOpen && d.tas.map(t => {
              const tOpen = expandedTAs.has(t.key);
              return (
                <React.Fragment key={t.key}>
                  <div onClick={() => toggleTA(t.key)} className="group grid px-[18px] border-b border-jj-gray-01/60 text-[12px] cursor-pointer hover:bg-[#faf9f8]" style={gridCols}>
                    <div className="py-2 pr-2 pl-[26px] flex items-center gap-2 text-jj-gray-08 min-w-0">
                      <Icon src={tOpen ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2 h-2 flex-shrink-0" />
                      <span className="truncate">{t.label}</span>
                    </div>
                    <div />
                    <div className="py-2 pl-2 text-right tabular-nums text-jj-gray-08">{t.total.toLocaleString()}</div>
                    <div className="py-2 pl-2 flex items-center justify-end">{drillBtn(() => onDrillDown({ level: 'inner', outerLabel: d.label, label: t.label }), `View documents in "${d.label} / ${t.label}"`)}</div>
                  </div>
                  {tOpen && t.artifacts.map((a, i) => (
                    <div key={i} className={`group grid px-[18px] border-b border-jj-gray-01/40 text-[11.5px] text-jj-gray-07 hover:bg-jj-blue-03/[.07] cursor-pointer ${i % 2 ? 'bg-[#faf9f8]' : ''}`} style={gridCols} onClick={() => onDrillDown({ level: 'artifact', outerLabel: d.label, innerLabel: t.label, label: a.label })}>
                      <div className="py-[7px] pr-2 pl-[52px] truncate">{a.label}</div>
                      <div />
                      <div className="py-[7px] pl-2 text-right tabular-nums">{a.count.toLocaleString()}</div>
                      <div className="py-[7px] pl-2 flex items-center justify-end">{drillBtn(() => onDrillDown({ level: 'artifact', outerLabel: d.label, innerLabel: t.label, label: a.label }), `View documents in "${a.label}"`)}</div>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </React.Fragment>
        );
      })}
      {tree.domains.length === 0 && (
        <div className="px-3 py-8 text-center text-jj-gray-06 text-xs">No matches.</div>
      )}
    </div>
  );
}

/* ============================== Shared UI bits ============================== */

function Card({ className = "", children }) {
  return (
    <div className={`bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] ${className}`}>
      {children}
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-red-50 border border-jj-maroon-05 text-jj-maroon-05 text-sm font-johnson-text">
      <div className="flex items-center gap-2">
        <Icon src={alertIcon} className="w-4 h-4" />
        {message}
      </div>
      <button onClick={onRetry} className="underline flex-shrink-0">Retry</button>
    </div>
  );
}

/* ============================== Coming soon ============================== */

// Placeholder for explorers that aren't wired up yet (MirAI, RMWCreate).
function ComingSoon({ icon, title, message, actionLabel, onAction }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-5">
      <div className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] px-12 py-10 text-center max-w-md">
        <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-jj-red/10 flex items-center justify-center">
          <Icon src={icon} tint="red" className="w-5 h-5" />
        </div>
        {title && <div className="font-johnson-display font-bold text-[26px] tracking-wide text-jj-red leading-none mb-2">{title}</div>}
        <div className="font-johnson-display font-bold text-[20px] text-jj-gray-08">Coming soon</div>
        <div className="text-[12.5px] font-johnson-text text-jj-gray-06 mt-2">{message}</div>
        {onAction && (
          <button
            onClick={onAction}
            className="mt-5 px-[18px] py-[9px] rounded-full bg-jj-gray-08 text-white text-[12.5px] font-johnson-text font-medium hover:bg-black transition-colors"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================== Page ============================== */

/* ============================== HAQ tab ============================== */

const HAQ_FILTER_COLUMNS = [
  { column: 'is_strategically_important', label: 'Strategically important' },
  { column: 'is_esi', label: 'ESI' },
  { column: 'is_ssi', label: 'SSI' },
  { column: 'is_active', label: 'Active' },
  { column: 'action_taken', label: 'Action taken' },
  { column: 'significance', label: 'Significance' },
  { column: 'outcome', label: 'Outcome' },
];

const HAQ_TABLE_COLUMNS = [
  { key: 'question_number', label: 'Question #' },
  { key: 'question', label: 'Question' },
  { key: 'answer', label: 'Answer' },
  { key: 'is_strategically_important', label: 'Strategic' },
  { key: 'is_esi', label: 'ESI' },
  { key: 'is_ssi', label: 'SSI' },
  { key: 'action_taken', label: 'Action taken' },
  { key: 'significance', label: 'Significance' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'modified_on', label: 'Modified' },
];

function haqFacetValueLabel(column, value) {
  if (value === null || value === undefined) return '(blank)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function HaqFacetGroup({ label, column, selected, onChange, options, loading }) {
  const [open, setOpen] = useState(false);
  const toggleValue = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  const sorted = [...(options || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
  const maxCount = Math.max(1, ...sorted.map(o => o.count || 0));

  return (
    <div className="border-b border-jj-gray-01 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors"
      >
        <span className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          {label}
          {selected.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">
              {selected.length}
            </span>
          )}
        </span>
        <Icon src={open ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5 flex-shrink-0" />
      </button>
      {open && (
        <div className="px-[18px] pb-3.5">
          {loading && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Loading…</div>}
          {!loading && sorted.length === 0 && (
            <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">No values found</div>
          )}
          {!loading && sorted.map(({ value, count }) => {
            const valKey = String(value);
            const checked = selected.includes(valKey);
            const pct = Math.round((count / maxCount) * 100);
            return (
              <label key={valKey} className="flex flex-col gap-1.5 py-2 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={checked} onChange={() => toggleValue(valKey)} className="accent-[#0f68b2] flex-shrink-0" />
                  <span className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold text-jj-gray-08' : 'font-medium text-jj-gray-08'}`}>
                    {haqFacetValueLabel(column, value)}
                  </span>
                  <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">{formatCompact(count)}</span>
                </div>
                <div className="h-[5px] rounded-full bg-jj-gray-01 ml-[22px]">
                  <div className="h-full rounded-full bg-jj-blue-03" style={{ width: `${pct}%` }} />
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HaqKpiCard({ label, value, tone = 'ink' }) {
  return (
    <div className="flex-1 min-w-[140px] bg-white border border-jj-gray-02 rounded-2xl px-5 py-4">
      <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-06">{label}</div>
      <div className={`mt-1 text-2xl font-johnson-display font-bold tabular-nums ${tone === 'red' ? 'text-jj-red' : 'text-jj-gray-08'}`}>
        {value}
      </div>
    </div>
  );
}

function HaqExplorer({ logInPage }) {
  const canDownload = useRBAC().hasPermission('downloadUnstructuredData');
  const [filters, setFilters] = useState({});
  const [searchQuestion, setSearchQuestion] = useState('');
  const [searchAnswer, setSearchAnswer] = useState('');
  const [searchQuestionNumber, setSearchQuestionNumber] = useState('');
  const debouncedQuestion = useDebounced(searchQuestion);
  const debouncedAnswer = useDebounced(searchAnswer);
  const debouncedQuestionNumber = useDebounced(searchQuestionNumber);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState('modified_on');
  const [sortDir, setSortDir] = useState('desc');

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [summary, setSummary] = useState(null);
  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Full-screen the table card only (not the whole page). Listening to
  // fullscreenchange rather than tracking our own flag keeps the button
  // label right when the user leaves with Esc.
  const tableCardRef = useRef(null);
  const [tableFullscreen, setTableFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setTableFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleTableFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else tableCardRef.current?.requestFullscreen?.();
  };

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join('||')}`);
    return parts.join(',');
  }, [filters]);

  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  // Reset to page 1 whenever filters/search change.
  useEffect(() => { setPage(1); }, [filtersParam, debouncedQuestion, debouncedAnswer, debouncedQuestionNumber, pageSize]);

  useEffect(() => {
    const ctl = new AbortController(); // cancelled on leave so it stops holding a browser connection
    fetchJson(`${API_BASE_URL}/api/haq/summary`, { signal: ctl.signal }).then(setSummary).catch((e) => { if (e.name !== 'AbortError') setSummary(null); });
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const qs = filtersParam ? `?filters=${encodeURIComponent(filtersParam)}` : '';
    fetchJson(`${API_BASE_URL}/api/haq/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (filtersParam) params.set('filters', filtersParam);
    if (debouncedQuestion) params.set('question', debouncedQuestion);
    if (debouncedAnswer) params.set('answer', debouncedAnswer);
    if (debouncedQuestionNumber) params.set('question_number', debouncedQuestionNumber);
    params.set('page', String(page));
    params.set('page_size', String(pageSize));
    params.set('sort_col', sortCol);
    params.set('sort_dir', sortDir);
    fetchJson(`${API_BASE_URL}/api/haq/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setLoading(false);
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        setError(e.message || 'Failed to load HAQ data');
        setLoading(false);
      });
    return () => controller.abort();
  }, [filtersParam, debouncedQuestion, debouncedAnswer, debouncedQuestionNumber, page, pageSize, sortCol, sortDir]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('desc'); }
  };

  const cellText = (row, col) => {
    const v = row[col];
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (col === 'modified_on' || col === 'created_on') return formatEasternTimestamp(v);
    return String(v);
  };

  // Query params shared by the table fetch and the "download all" stream, so
  // the CSV always covers exactly what's on screen.
  const buildHaqQuery = () => {
    const params = new URLSearchParams();
    if (filtersParam) params.set('filters', filtersParam);
    if (debouncedQuestion) params.set('question', debouncedQuestion);
    if (debouncedAnswer) params.set('answer', debouncedAnswer);
    if (debouncedQuestionNumber) params.set('question_number', debouncedQuestionNumber);
    params.set('sort_col', sortCol);
    params.set('sort_dir', sortDir);
    return params;
  };

  // Current page comes straight from state - no point round-tripping rows
  // the browser already has.
  const downloadPageCsv = () => {
    logInPage('export_page', `Downloaded current page (${rows.length} rows) of Q! questions`);
    const cols = HAQ_TABLE_COLUMNS.map(c => c.key);
    const esc = (v) => {
      const t = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [cols.join(',')];
    rows.forEach(r => lines.push(cols.map(c => esc(cellText(r, c))).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: 'haq_questions_page.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage('export_all', `Downloaded all ${total.toLocaleString()} matching Q! questions`);
    try {
      await downloadFile(`/api/haq/data/download?${buildHaqQuery().toString()}`, 'haq_questions.csv');
    } catch (e) {
      setError(e.message || 'Download failed');
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Filter rail */}
      <div className="w-[260px] flex-shrink-0 bg-white border-r border-jj-gray-02 overflow-y-auto">
        <div className="px-[18px] py-3.5 flex items-center justify-between border-b border-jj-gray-02">
          <span className="text-[12.5px] font-johnson-text font-bold text-jj-gray-08">Filters</span>
          {activeFilterCount > 0 && (
            <button onClick={() => setFilters({})} className="text-[11px] font-johnson-text text-jj-blue-03 underline">
              Clear all
            </button>
          )}
        </div>
        <SearchSection>
          <input
            value={searchQuestion}
            onChange={e => setSearchQuestion(e.target.value)}
            placeholder="Search question…"
            className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
          />
          <input
            value={searchAnswer}
            onChange={e => setSearchAnswer(e.target.value)}
            placeholder="Search answer…"
            className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
          />
          <input
            value={searchQuestionNumber}
            onChange={e => setSearchQuestionNumber(e.target.value)}
            placeholder="Search question #…"
            className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
          />
        </SearchSection>
        {HAQ_FILTER_COLUMNS.map(({ column, label }) => (
          <HaqFacetGroup
            key={column}
            label={label}
            column={column}
            selected={filters[column] || []}
            onChange={(vals) => setFilters(prev => ({ ...prev, [column]: vals }))}
            options={facets[column] || []}
            loading={facetsLoading}
          />
        ))}
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-shrink-0 px-6 pt-5 pb-3 flex gap-3 flex-wrap">
          <HaqKpiCard label="Total questions" value={summary ? summary.total.toLocaleString() : '—'} />
          <HaqKpiCard label="Active" value={summary ? summary.active.toLocaleString() : '—'} />
          <HaqKpiCard label="Strategically important" value={summary ? summary.strategically_important.toLocaleString() : '—'} tone="red" />
          <HaqKpiCard label="ESI" value={summary ? summary.esi.toLocaleString() : '—'} />
          <HaqKpiCard label="SSI" value={summary ? summary.ssi.toLocaleString() : '—'} />
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden px-6 pb-6 gap-0">
          {error && <ErrorBanner message={error} onRetry={() => setPage(p => p)} />}
          <div ref={tableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
              <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2.5">
                {canDownload && (<>
                <button
                  onClick={downloadPageCsv}
                  disabled={loading || rows.length === 0}
                  className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                  title="Downloads the current page only"
                >
                  <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                  Download page
                </button>
                <button
                  onClick={downloadAllCsv}
                  disabled={loading || downloadingAll || total === 0}
                  className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                  title="Streams every matching question as CSV - no row cap"
                >
                  <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                  {downloadingAll ? 'Preparing…' : `Download all (${total.toLocaleString()})`}
                </button>
                </>)}
                <button
                  onClick={toggleTableFullscreen}
                  className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                  title={tableFullscreen ? 'Exit full screen' : 'View the table full screen'}
                >
                  {tableFullscreen ? '⤳ Exit full screen' : '⛶ Full screen'}
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 relative">
              {loading && (
                <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                  <LoadingSpinner />
                </div>
              )}
              <div className="h-full overflow-auto">
            <table className="w-full text-[12px] font-johnson-text">
              <thead className="sticky top-0 z-[5]">
                <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                  {HAQ_TABLE_COLUMNS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className="text-left px-3 py-2.5 font-bold cursor-pointer select-none whitespace-nowrap"
                    >
                      {col.label} {sortCol === col.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={row.id ?? i}
                    onClick={() => setDetailRow(row)}
                    className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                  >
                    {HAQ_TABLE_COLUMNS.map(col => (
                      <td key={col.key} className="px-3 py-2 max-w-[240px] truncate text-jj-gray-08" title={cellText(row, col.key)}>
                        {cellText(row, col.key)}
                      </td>
                    ))}
                  </tr>
                ))}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={HAQ_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                      No rows match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
              </div>
            </div>

            <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
              <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                {total.toLocaleString()} rows
                <select
                  value={pageSize}
                  onChange={e => setPageSize(Number(e.target.value))}
                  disabled={loading}
                  className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                >
                  {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                </select>
              </div>
              <Pager page={page} totalPages={totalPages} loading={loading} onGo={setPage} />
            </div>
          </div>
        </div>
      </div>

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}

// Branded scrollbars for the whole explorer, chevron buttons included.
// Scoped with a body class (not a wrapper) so portaled menus, drawers and
// modals pick it up too. Firefox has no scrollbar buttons, so it just gets
// the thin warm-gray bar.
const SCROLLBAR_STYLE_ID = 'ue-scrollbar-style';
const chev = (d, color) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='${d}' fill='none' stroke='${encodeURIComponent(color)}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
const CHEV = { up: 'M2.5 6.5 5 4l2.5 2.5', down: 'M2.5 3.5 5 6l2.5-2.5', left: 'M6.5 2.5 4 5l2.5 2.5', right: 'M3.5 2.5 6 5 3.5 7.5' };
const SB = 'body.ue-scrollbars';
const SCROLLBAR_CSS = `
${SB} ::-webkit-scrollbar { width: 12px; height: 12px; }
${SB} ::-webkit-scrollbar-track { background: transparent; }
${SB} ::-webkit-scrollbar-corner { background: transparent; }
${SB} ::-webkit-scrollbar-thumb { background-color: #d6cec7; border: 3px solid transparent; background-clip: content-box; border-radius: 999px; min-height: 36px; min-width: 36px; }
${SB} ::-webkit-scrollbar-thumb:hover { background-color: #a99d94; }
${SB} ::-webkit-scrollbar-thumb:active { background-color: #eb1700; }
${SB} ::-webkit-scrollbar-button { display: none; }
${SB} ::-webkit-scrollbar-button:single-button { display: block; width: 12px; height: 12px; background-color: transparent; background-repeat: no-repeat; background-position: center; background-size: 9px 9px; }
${SB} ::-webkit-scrollbar-button:single-button:vertical:decrement { background-image: ${chev(CHEV.up, '#8a7e76')}; }
${SB} ::-webkit-scrollbar-button:single-button:vertical:increment { background-image: ${chev(CHEV.down, '#8a7e76')}; }
${SB} ::-webkit-scrollbar-button:single-button:horizontal:decrement { background-image: ${chev(CHEV.left, '#8a7e76')}; }
${SB} ::-webkit-scrollbar-button:single-button:horizontal:increment { background-image: ${chev(CHEV.right, '#8a7e76')}; }
${SB} ::-webkit-scrollbar-button:single-button:vertical:decrement:hover { background-image: ${chev(CHEV.up, '#eb1700')}; }
${SB} ::-webkit-scrollbar-button:single-button:vertical:increment:hover { background-image: ${chev(CHEV.down, '#eb1700')}; }
${SB} ::-webkit-scrollbar-button:single-button:horizontal:decrement:hover { background-image: ${chev(CHEV.left, '#eb1700')}; }
${SB} ::-webkit-scrollbar-button:single-button:horizontal:increment:hover { background-image: ${chev(CHEV.right, '#eb1700')}; }
@supports not selector(::-webkit-scrollbar) {
  ${SB} * { scrollbar-width: thin; scrollbar-color: #d6cec7 transparent; }
}
`;

function useExplorerScrollbars() {
  useEffect(() => {
    if (!document.getElementById(SCROLLBAR_STYLE_ID)) {
      const el = document.createElement('style');
      el.id = SCROLLBAR_STYLE_ID;
      el.textContent = SCROLLBAR_CSS;
      document.head.appendChild(el);
    }
    document.body.classList.add('ue-scrollbars');
    return () => document.body.classList.remove('ue-scrollbars');
  }, []);
}

export default function Unstructured() {
  useExplorerScrollbars();
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const userEmail = user?.email || user?.username || 'unknown';
  // Every in-page interaction on Unstructured (tab switches, filter
  // edits, sorts, pagination, reloads, query runs, SQL/detail views,
  // exports, etc.) is logged under a single action name so it's all
  // groupable in the audit log; `target` + `details` carry the specifics.
  const logInPage = useCallback((target, details) => {
    logAuditEvent('rm_inpage', userEmail, target, details);
  }, [userEmail]);
  const canViewSql = hasPermission('viewUnstructuredSQL');
  const canViewTotals = hasPermission('viewUnstructuredRimDocsTotals');
  const canDownload = hasPermission('downloadUnstructuredData');
  const canViewRimDocs = hasPermission(UNSTRUCTURED_TABS.rimdocs);
  // filter for sub-tab ids inside a document set: ['explore', ...].filter(canSub(UNSTRUCTURED_SUBTABS.epod))
  const canSub = (subs) => (id) => hasPermission(subs[id]);
  const [filters, setFilters] = useState({});
  const [searchFileName, setSearchFileName] = useState('');
  const [searchObjectName, setSearchObjectName] = useState('');
  const [searchJjTitle, setSearchJjTitle] = useState('');
  const [searchArtifactName, setSearchArtifactName] = useState('');
  const [searchJjNumber, setSearchJjNumber] = useState('');

  const debouncedFileName = useDebounced(searchFileName);
  const debouncedObjectName = useDebounced(searchObjectName);
  const debouncedJjTitle = useDebounced(searchJjTitle);
  const debouncedArtifactName = useDebounced(searchArtifactName);
  const debouncedJjNumber = useDebounced(searchJjNumber);

  // Log free-text filter changes once typing settles (debounced value
  // actually applied). Compares against the last value actually seen -
  // not just "have I run before" - so a duplicate effect firing (e.g. React
  // Strict Mode's intentional double-invoke on mount) with an unchanged
  // value is a no-op instead of a false "cleared" log.
  const lastLoggedFileName = useRef(debouncedFileName);
  useEffect(() => {
    if (lastLoggedFileName.current === debouncedFileName) return;
    lastLoggedFileName.current = debouncedFileName;
    if (debouncedFileName) logInPage('filter_add', `Set FILE_NAME search to "${debouncedFileName}"`);
    else logInPage('filter_remove', 'Cleared FILE_NAME search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFileName]);
  const lastLoggedObjectName = useRef(debouncedObjectName);
  useEffect(() => {
    if (lastLoggedObjectName.current === debouncedObjectName) return;
    lastLoggedObjectName.current = debouncedObjectName;
    if (debouncedObjectName) logInPage('filter_add', `Set OBJECT_NAME search to "${debouncedObjectName}"`);
    else logInPage('filter_remove', 'Cleared OBJECT_NAME search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedObjectName]);
  const lastLoggedJjTitle = useRef(debouncedJjTitle);
  useEffect(() => {
    if (lastLoggedJjTitle.current === debouncedJjTitle) return;
    lastLoggedJjTitle.current = debouncedJjTitle;
    if (debouncedJjTitle) logInPage('filter_add', `Set JJ_TITLE search to "${debouncedJjTitle}"`);
    else logInPage('filter_remove', 'Cleared JJ_TITLE search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedJjTitle]);
  const lastLoggedArtifactName = useRef(debouncedArtifactName);
  useEffect(() => {
    if (lastLoggedArtifactName.current === debouncedArtifactName) return;
    lastLoggedArtifactName.current = debouncedArtifactName;
    if (debouncedArtifactName) logInPage('filter_add', `Set ARTIFACT_NAME search to "${debouncedArtifactName}"`);
    else logInPage('filter_remove', 'Cleared ARTIFACT_NAME search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedArtifactName]);
  const lastLoggedJjNumber = useRef(debouncedJjNumber);
  useEffect(() => {
    if (lastLoggedJjNumber.current === debouncedJjNumber) return;
    lastLoggedJjNumber.current = debouncedJjNumber;
    if (debouncedJjNumber) logInPage('filter_add', `Set JJ_NUMBER search to "${debouncedJjNumber}"`);
    else logInPage('filter_remove', 'Cleared JJ_NUMBER search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedJjNumber]);

  const [sortCol, setSortCol] = useState('FILE_NAME');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [distinctOnly, setDistinctOnly] = useState(false); // one row per FILE_NAME instead of one per version

  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [colWidths, setColWidths] = useState({}); // manual overrides only - { COL: px }, wins over auto-fit
  const [autoColWidths, setAutoColWidths] = useState({}); // recomputed from whatever's on screen, like Snowflake/DBeaver's default
  const resizeStateRef = useRef(null); // { col, startX, startWidth, currentWidth, setWidths } while a drag is in progress
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [elapsedMs, setElapsedMs] = useState(null);
  const [, setQueryId] = useState(null);
  const [rowsCached, setRowsCached] = useState(false);

  const [summary, setSummary] = useState({ total_count: null, distinct_file_names: null, ingested_size_bytes: null, total_size_bytes: null });
  const [domainStatusChart, setDomainStatusChart] = useState({ data: [], statuses: [] });
  const [ingestionStatusChart, setIngestionStatusChart] = useState({ data: [], statuses: [] });
  const [ingestionStatusFacetChart, setIngestionStatusFacetChart] = useState({ data: [] });
  const [taChart, setTaChart] = useState([]);
  const [taDomainChart, setTaDomainChart] = useState(null); // { data, domains } | null when the endpoint isn't served
  const [distinctObjChart, setDistinctObjChart] = useState([]);
  const [docsOverTimeChart, setDocsOverTimeChart] = useState([]);
  const [docsOverTimeGranularity] = useState('hour');
  const [rowsSql, setRowsSql] = useState('');
  const [summarySql, setSummarySql] = useState('');
  const [domainStatusSql, setDomainStatusSql] = useState('');
  const [ingestionStatusSql, setIngestionStatusSql] = useState('');
  const [taSql, setTaSql] = useState('');
  const [distinctObjSql, setDistinctObjSql] = useState('');
  const [docsOverTimeSql, setDocsOverTimeSql] = useState('');
  const [sqlModal, setSqlModal] = useState(null); // { title, sql } | null

  const [rowsLoading, setRowsLoading] = useState(true);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [epodBusy, setEpodBusy] = useState(false);
  const [nipoBusy, setNipoBusy] = useState(false);
  const [fdaBusy, setFdaBusy] = useState(false);
  const [vrBusy, setVrBusy] = useState(false);
  const [vrSyncedAt, setVrSyncedAt] = useState(null);
  const [vrReloadKey, setVrReloadKey] = useState(0);
  const [immbotBusy, setImmbotBusy] = useState(false);
  const [immbotSyncedAt, setImmbotSyncedAt] = useState(null);
  const [immbotReloadKey, setImmbotReloadKey] = useState(0);
  const [epodDatasets, setEpodDatasets] = useState([]);
  const [epodDatasetsLoading, setEpodDatasetsLoading] = useState(false);
  const [epodDatasetMenuOpen, setEpodDatasetMenuOpen] = useState(false);
  const epodDatasetBtnRef = useRef(null);
  const [epodDatasetMenuCoords, setEpodDatasetMenuCoords] = useState({ top: 0, left: 0, width: 0 });
  // FDA "dashboards" picker - just one entry today (CRL AI Matches), but
  // built as a list + dropdown from the start since more dashboards are
  // planned for this tab. Hardcoded, not discovered from the backend, since
  // unlike EPOD's datasets these aren't derived from live Postgres tables.
  const [fdaDashboardMenuOpen, setFdaDashboardMenuOpen] = useState(false);
  const fdaDashboardBtnRef = useRef(null);
  const [fdaDashboardMenuCoords, setFdaDashboardMenuCoords] = useState({ top: 0, left: 0, width: 0 });
  // VR External table picker. List comes from the backend (config driven),
  // press releases stays as the fallback so the dropdown is never empty.
  const [vrSources, setVrSources] = useState(VR_EXT_FALLBACK);
  const [vrSourcesLoading, setVrSourcesLoading] = useState(false);
  // facet picks for the table view rail, e.g. { site: ['Canada Gazette'] }
  const [vrFacets, setVrFacets] = useState({});
  const [vrSourceMenuOpen, setVrSourceMenuOpen] = useState(false);
  const vrSourceBtnRef = useRef(null);
  const [vrSourceMenuCoords, setVrSourceMenuCoords] = useState({ top: 0, left: 0, width: 0 });
  const [rowsError, setRowsError] = useState(null);
  const [chartsError, setChartsError] = useState(null); // all five endpoints down
  const [cardErrors, setCardErrors] = useState({});      // per-card failures: { summary, domainStatus, ta, distinctObj, ingestionStatus } - docsOverTime is silent by request, not tracked here
  const [detailRecord, setDetailRecord] = useState(null);
  const [searchParamsNav, setSearchParamsNav] = useSearchParams();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [, forceTick] = useState(0); // re-render every 30s so "X min ago" stays current
  const [isFullscreen, setIsFullscreen] = useState(false);
  const tableCardRef = useRef(null);
  const [dataScrollWidth, setDataScrollRef] = useElementWidth();
  // Top-level document-set tabs. Order matches the cards on the welcome
  // screen (UnstructuredWelcome) so the two don't drift apart.
  // No doctype in the URL yet -> activeDocType is null and the welcome
  // screen (choose an explorer) renders instead of defaulting into one.
  // Only the sets this user has a permission for (UNSTRUCTURED_TABS).
  const docTypeIds = ['vr', 'immbot', 'mirai', 'rmwcreate', 'haq', 'nipo', 'rimdocs', 'epod', 'fda']
    .filter(id => hasPermission(UNSTRUCTURED_TABS[id]));
  // thin divider in the tab strip after this one (new chunk explorers | existing sets)
  const docTypeGroupEnd = 'rmwcreate';
  const urlDocType = searchParamsNav.get('doctype');
  const activeDocType = docTypeIds.includes(urlDocType) ? urlDocType : null;
  // RIM Docs lives in this component, so its loads used to fire whichever
  // explorer was open (9 Snowflake calls behind every VR / Q! / FDA visit,
  // filling the browser's ~6 connections). They only run while RIM Docs is open.
  const rimActive = canViewRimDocs && activeDocType === 'rimdocs';
  const setActiveDocType = (id) => {
    if (id !== activeDocType) {
      logInPage('doctype_change', `Switched to "${DOC_TYPE_LABELS[id] || id}" document set on Unstructured`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('doctype', id);
      // coming back to Virtual Regulator External -> FDA press releases Explore
      if (id === 'vr' && next.get('vrscope') === 'external') {
        next.delete('vrha'); next.delete('vrsource'); next.set('vrtab', 'explore');
      }
      return next;
    }, { replace: false });
  };

  const tabIds = ['overview', 'table', 'breakdown'].filter(canSub(UNSTRUCTURED_SUBTABS.rimdocs));
  const urlTab = searchParamsNav.get('tab');
  const activeTab = tabIds.includes(urlTab) ? urlTab : tabIds[0];

  // EPOD's own Explore/Data table sub-tabs - separate from RimDocs' segTabs
  // above since EPOD is a self-contained explorer (see EpodExplorer), but
  // rendered in the same header spot next to the page title.
  const epodTabIds = ['explore', 'table'].filter(canSub(UNSTRUCTURED_SUBTABS.epod));
  const urlEpodTab = searchParamsNav.get('epodtab');
  const activeEpodTab = epodTabIds.includes(urlEpodTab) ? urlEpodTab : epodTabIds[0];
  const setActiveEpodTab = (id) => {
    if (id !== activeEpodTab) {
      logInPage('epod_tab_change', `Switched to "${id === 'explore' ? 'Explore' : 'Data table'}" tab on EPOD`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('epodtab', id);
      return next;
    }, { replace: false });
  };

  // Which doc_chunks_<suffix>/ingestion_log_<suffix> table pair EPOD reads
  // from (EDQM, NDA, ... or the base 'default' set) - see the dropdown next
  // to the Explore/Data table tabs. epodDatasets is fetched once below.
  const urlEpodDataset = searchParamsNav.get('epoddataset');
  const activeEpodDataset = (urlEpodDataset && epodDatasets.some(d => d.id === urlEpodDataset))
    ? urlEpodDataset
    : (epodDatasets[0]?.id || null);
  const setActiveEpodDataset = (id) => {
    const label = epodDatasets.find(d => d.id === id)?.label || id;
    if (id !== activeEpodDataset) {
      logInPage('epod_dataset_change', `Switched EPOD dataset to "${label}"`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('epoddataset', id);
      return next;
    }, { replace: false });
    setEpodDatasetMenuOpen(false);
  };

  // Fetched once per visit to EPOD. (It used to re-run whenever loading ended
  // with no datasets, so a failing or empty endpoint was called in a tight loop.)
  const epodDatasetsTried = useRef(false);
  useEffect(() => {
    if (activeDocType !== 'epod') { epodDatasetsTried.current = false; return undefined; }
    if (epodDatasets.length > 0 || epodDatasetsTried.current) return undefined;
    epodDatasetsTried.current = true;
    const ctl = new AbortController();
    setEpodDatasetsLoading(true);
    fetchJson(`${API_BASE_URL}/api/epod/datasets`, { signal: ctl.signal })
      .then(data => setEpodDatasets(data.items || []))
      .catch(() => {}) // no list: the explorer falls back to its default dataset
      .finally(() => setEpodDatasetsLoading(false));
    return () => { ctl.abort(); epodDatasetsTried.current = false; };
  }, [activeDocType, epodDatasets.length]);

  // Nipo's own Explore/Data table sub-tabs - same shape as EPOD's, since
  // Nipo is also a self-contained Postgres explorer (see NipoExplorer), just
  // with no dataset picker (rimdocs_nipo is a single fixed schema).
  const nipoTabIds = ['explore', 'table'].filter(canSub(UNSTRUCTURED_SUBTABS.nipo));
  const urlNipoTab = searchParamsNav.get('nipotab');
  const activeNipoTab = nipoTabIds.includes(urlNipoTab) ? urlNipoTab : nipoTabIds[0];
  const setActiveNipoTab = (id) => {
    if (id !== activeNipoTab) {
      logInPage('nipo_tab_change', `Switched to "${id === 'explore' ? 'Explore' : 'Data table'}" tab on Nipo`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('nipotab', id);
      return next;
    }, { replace: false });
  };

  // FDA's own Explore/Data table sub-tabs - same shape as Nipo's, since FDA
  // is also a self-contained Postgres explorer (see FDAExplorer), with no
  // dataset picker (vector_embedding.crl_ai_matches is a single fixed table).
  const fdaTabIds = ['explore', 'table'].filter(canSub(UNSTRUCTURED_SUBTABS.fda));
  const urlFdaTab = searchParamsNav.get('fdatab');
  const activeFdaTab = fdaTabIds.includes(urlFdaTab) ? urlFdaTab : fdaTabIds[0];
  const setActiveFdaTab = (id) => {
    if (id !== activeFdaTab) {
      logInPage('fda_tab_change', `Switched to "${id === 'explore' ? 'Explore' : 'Data table'}" tab on FDA`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('fdatab', id);
      return next;
    }, { replace: false });
  };

  // Virtual Regulator sub-tabs. Internal: Overview / Documents / Data table. External: Explore / Data table. Reload bumps vrReloadKey.
  const vrTabIds = ['explore', 'library', 'table'];
  const vrExternalTabIds = ['explore', 'table'];
  const urlVrTab = searchParamsNav.get('vrtab');
  const activeVrTab = vrTabIds.includes(urlVrTab) ? urlVrTab : 'explore';
  // Internal / External switch in the middle of the Virtual Regulator header.
  // Internal = the VIRTUAL_REGULATOR explorer; External = FDA press release RSS.
  const vrScopeIds = ['internal', 'external', 'cortellis'].filter(canSub(UNSTRUCTURED_SUBTABS.vr));
  const urlVrScope = searchParamsNav.get('vrscope');
  // External and Cortellis share the dropdown, each has its own permission
  const vrCanExt = vrScopeIds.includes('external') || vrScopeIds.includes('cortellis');
  const activeVrScope = vrScopeIds.includes(urlVrScope) ? urlVrScope : vrScopeIds[0];
  const VR_SCOPE_LABELS = { internal: 'Internal', external: 'External', cortellis: 'Cortellis' };
  const [vrExtMenu, setVrExtMenu] = useState(null);
  // the menu is placed from the button's position, so close it if the page moves
  useEffect(() => {
    if (!vrExtMenu) return;
    const close = () => setVrExtMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); document.removeEventListener('keydown', onKey); };
  }, [vrExtMenu]);
  const setActiveVrScope = (id) => {
    setVrExtMenu(null);
    if (id !== activeVrScope) {
      logInPage('vr_scope_change', `Switched Virtual Regulator to ${VR_SCOPE_LABELS[id]}`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('vrscope', id);
      // External always opens on the FDA press releases Explore tab
      if (id === 'external') { next.delete('vrha'); next.delete('vrsource'); next.set('vrtab', 'explore'); }
      // leaving or re-entering Cortellis starts from its table list
      ['ct', 'cttab', 'ctf', 'ctq', 'cty', 'ctp', 'cts', 'ctn'].forEach(k => next.delete(k));
      return next;
    }, { replace: false });
  };

  // External flow: health authority (vrha) -> table (vrsource) -> data.
  // No vrha = land on FDA press releases, vrha=* = health authority list,
  // vrha but no vrsource = that authority's tables.
  const VR_ALL_HA = '*';
  const vrPress = vrSources.find(s => s.kind === 'press');
  const rawVrHa = searchParamsNav.get('vrha');
  const vrLandOnPress = rawVrHa == null && !!vrPress;
  const urlVrHa = vrLandOnPress ? haOf(vrPress) : rawVrHa === VR_ALL_HA ? null : rawVrHa;
  const vrHaSources = urlVrHa ? vrSources.filter(s => haOf(s) === urlVrHa) : [];
  const activeVrHa = vrHaSources.length ? urlVrHa : null;
  const urlVrSource = vrLandOnPress ? vrPress.id : searchParamsNav.get('vrsource');
  const activeVrSourceInfo = vrHaSources.find(s => s.id === urlVrSource) || null;
  const activeVrSource = activeVrSourceInfo?.id || null;
  const vrExtStage = !activeVrHa ? 'ha' : !activeVrSourceInfo ? 'tables' : 'data';

  const setActiveVrHa = (ha) => {
    const list = ha ? vrSources.filter(s => haOf(s) === ha) : [];
    if (ha) logInPage('vr_ha_change', `Picked health authority "${ha}" on Virtual Regulator External`);
    else logInPage('vr_ha_change', 'Returned to health authority list on Virtual Regulator External');
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('vrha', ha || VR_ALL_HA);
      // only one table - skip the table list and open it
      if (list.length === 1) next.set('vrsource', list[0].id); else next.delete('vrsource');
      return next;
    }, { replace: false });
    setVrSourceMenuOpen(false);
  };

  const setActiveVrSource = (id) => {
    if (id !== activeVrSource) {
      const label = vrSources.find(s => s.id === id)?.label || id;
      logInPage('vr_source_change', `Switched Virtual Regulator External table to "${label}"`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      if (activeVrHa) next.set('vrha', activeVrHa);
      if (id) next.set('vrsource', id); else next.delete('vrsource');
      return next;
    }, { replace: false });
    setVrSourceMenuOpen(false);
  };

  // rail can open any table, so jump to its own health authority too
  const openVrTable = (id) => {
    const src = vrSources.find(s => s.id === id);
    if (!src || id === activeVrSource) return;
    logInPage('vr_source_change', `Switched Virtual Regulator External table to "${src.label}"`);
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('vrha', haOf(src));
      next.set('vrsource', id);
      return next;
    }, { replace: false });
  };

  const needVrSources = activeDocType === 'vr' && activeVrScope === 'external';
  // extra external tables only get the data table, no explore
  const vrTableOnly = activeVrScope === 'external' && activeVrSourceInfo?.kind === 'table';
  const shownVrTab = vrTableOnly ? 'table'
    : activeVrScope !== 'internal' && !vrExternalTabIds.includes(activeVrTab) ? 'explore'
    : activeVrTab;
  const vrTabLabels = activeVrScope === 'internal' ? VR_INTERNAL_TAB_LABELS : VR_TAB_LABELS;
  useEffect(() => {
    if (!needVrSources) return;
    // Cancel, not just ignore, on leave: a request left running holds one of the
    // browser's ~6 connections to the server and the next screen queues behind it.
    let dead = false;
    const ctl = new AbortController();
    setVrSourcesLoading(true);
    apiJson(`/api/vr-external/sources${vrReloadKey ? '?bypass_cache=true' : ''}`, { signal: ctl.signal })
      .then(res => { if (!dead && res?.sources?.length) setVrSources(res.sources); })
      .catch(() => {}) // keep the fallback, press releases still works
      .finally(() => { if (!dead) setVrSourcesLoading(false); });
    return () => { dead = true; ctl.abort(); };
  }, [needVrSources, vrReloadKey]);

  // facets narrow the header dropdown + the open table. no facets = just this
  // authority's tables in the dropdown.
  const vrFacetCount = pickedCount(vrFacets);
  const vrMatchingTables = vrSources.filter(s => s.kind === 'table' && passesFacets(s, vrFacets));
  const vrMenuSources = vrFacetCount ? vrMatchingTables : vrHaSources;
  const vrNoMatch = vrFacetCount > 0 && activeVrSourceInfo?.kind === 'table' && !vrMatchingTables.length;
  // filters changed and the open table no longer fits -> jump to the first one that does
  useEffect(() => {
    if (vrExtStage !== 'data' || activeVrSourceInfo?.kind !== 'table') return;
    if (passesFacets(activeVrSourceInfo, vrFacets)) return;
    const next = vrMatchingTables[0];
    if (!next) return;
    setSearchParamsNav(prev => {
      const p = new URLSearchParams(prev);
      p.set('vrha', haOf(next));
      p.set('vrsource', next.id);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrFacets, vrSources]);

  // moved somewhere the filters don't describe (press releases, HA list, a
  // table picked outside the rail, internal scope) -> drop them so the rail
  // doesn't show stale ticks
  useEffect(() => {
    if (!pickedCount(vrFacets)) return;
    const fits = activeVrScope === 'external' && vrExtStage === 'data'
      && activeVrSourceInfo?.kind === 'table' && passesFacets(activeVrSourceInfo, vrFacets);
    if (!fits) setVrFacets({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVrSource, activeVrScope, vrExtStage]);

  // welcome / table list screens don't mount an explorer, so nothing clears busy
  useEffect(() => {
    if (activeVrScope === 'external' && vrExtStage !== 'data') setVrBusy(false);
  }, [activeVrScope, vrExtStage]);
  const vrBusyAll = vrBusy || (activeVrScope === 'external' && vrSourcesLoading);

  const setActiveVrTab = (id) => {
    if (id !== activeVrTab) {
      logInPage('vr_tab_change', `Switched to "${vrTabLabels[id] || id}" tab on Virtual Regulator`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('vrtab', id);
      return next;
    }, { replace: false });
  };

  // IMMBOT sub-tabs (Explore / Data table / Breakdown). The explorer
  // itself lives in ImmbotExplorer; Reload bumps immbotReloadKey.
  const immbotTabIds = ['explore', 'table', 'breakdown'].filter(canSub(UNSTRUCTURED_SUBTABS.immbot));
  const urlImmbotTab = searchParamsNav.get('immbottab');
  const activeImmbotTab = immbotTabIds.includes(urlImmbotTab) ? urlImmbotTab : immbotTabIds[0];
  const setActiveImmbotTab = (id) => {
    if (id !== activeImmbotTab) {
      logInPage('immbot_tab_change', `Switched to "${IMMBOT_TAB_LABELS[id] || id}" tab on IMMBOT`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('immbottab', id);
      return next;
    }, { replace: false });
  };

  // Which FDA dashboard is showing (see FDA_DASHBOARDS above).
  const urlFdaDashboard = searchParamsNav.get('fdadashboard');
  const activeFdaDashboard = FDA_DASHBOARDS.some(d => d.id === urlFdaDashboard) ? urlFdaDashboard : FDA_DASHBOARDS[0].id;
  const setActiveFdaDashboard = (id) => {
    const label = FDA_DASHBOARDS.find(d => d.id === id)?.label || id;
    if (id !== activeFdaDashboard) {
      logInPage('fda_dashboard_change', `Switched FDA dashboard to "${label}"`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('fdadashboard', id);
      return next;
    }, { replace: false });
    setFdaDashboardMenuOpen(false);
  };

  // Drops ?doctype= so activeDocType goes null and the welcome grid comes
  // back. Tab/filter params go with it - picking a different explorer from
  // the grid shouldn't inherit the last one's view state.
  const navigate = useNavigate();
  const backToWelcome = () => {
    logInPage('doctype_change', 'Returned to the explorer picker on Unstructured');
    setSearchParamsNav(new URLSearchParams(), { replace: false });
  };

  const setActiveTab = (id) => {
    if (id !== activeTab) {
      logInPage('tab_change', `Switched to "${TAB_LABELS[id] || id}" tab on Unstructured`);
    }
    setSearchParamsNav(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: false });
  };

  const hasLoggedInitialTabRef = useRef(false);
  useEffect(() => {
    if (hasLoggedInitialTabRef.current) return;
    hasLoggedInitialTabRef.current = true;
    logInPage('tab_view', `Landed on "${TAB_LABELS[activeTab] || activeTab}" tab on Unstructured`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [breakdownRows, setBreakdownRows] = useState([]);
  const [breakdownSql, setBreakdownSql] = useState('');
  const [breakdownLoading, setBreakdownLoading] = useState(true);
  const [breakdownError, setBreakdownError] = useState(null);
  const [breakdownLoaded, setBreakdownLoaded] = useState(false);
  const [expandedDomains, setExpandedDomains] = useState(new Set());
  const [expandedTAs, setExpandedTAs] = useState(new Set());
  const [breakdownSearch, setBreakdownSearch] = useState('');
  const [breakdownGrouping, setBreakdownGrouping] = useState('domain'); // 'domain' | 'ta' - which level nests outer/inner
  const debouncedBreakdownSearch = useDebounced(breakdownSearch);
  const lastLoggedBreakdownSearch = useRef(debouncedBreakdownSearch);
  useEffect(() => {
    if (lastLoggedBreakdownSearch.current === debouncedBreakdownSearch) return;
    lastLoggedBreakdownSearch.current = debouncedBreakdownSearch;
    if (debouncedBreakdownSearch) logInPage('filter_add', `Searched breakdown tree for "${debouncedBreakdownSearch}"`);
    else logInPage('filter_remove', 'Cleared breakdown tree search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedBreakdownSearch]);

  const rowsAbortRef = useRef(null);
  const chartsAbortRef = useRef(null);
  const mountedRef = useRef(true);

  const filtersParam = useMemo(() => encodeFilters(filters), [filters]);
  const searchParams = useMemo(() => new URLSearchParams({
    ...(filtersParam ? { filters: filtersParam } : {}),
    ...(debouncedFileName ? { search_file_name: debouncedFileName } : {}),
    ...(debouncedObjectName ? { search_object_name: debouncedObjectName } : {}),
    ...(debouncedJjTitle ? { search_jj_title: debouncedJjTitle } : {}),
    ...(debouncedArtifactName ? { search_artifact_name: debouncedArtifactName } : {}),
    ...(debouncedJjNumber ? { search_jj_number: debouncedJjNumber } : {}),
  }), [filtersParam, debouncedFileName, debouncedObjectName, debouncedJjTitle, debouncedArtifactName, debouncedJjNumber]);
  const { STATUS: _selfStatusFilter, ...filtersWithoutStatus } = filters;
  const ingestionStatusFacetParam = useMemo(() => encodeFilters(filtersWithoutStatus), [filters]);
  const ingestionStatusFacetParams = useMemo(() => new URLSearchParams({
    ...(ingestionStatusFacetParam ? { filters: ingestionStatusFacetParam } : {}),
    ...(debouncedFileName ? { search_file_name: debouncedFileName } : {}),
    ...(debouncedObjectName ? { search_object_name: debouncedObjectName } : {}),
    ...(debouncedJjTitle ? { search_jj_title: debouncedJjTitle } : {}),
    ...(debouncedArtifactName ? { search_artifact_name: debouncedArtifactName } : {}),
    ...(debouncedJjNumber ? { search_jj_number: debouncedJjNumber } : {}),
  }), [ingestionStatusFacetParam, debouncedFileName, debouncedObjectName, debouncedJjTitle, debouncedArtifactName, debouncedJjNumber]);

  const activeFilterCount = Object.values(filters).reduce((n, v) => n + (v?.length || 0), 0)
    + (searchFileName ? 1 : 0) + (searchObjectName ? 1 : 0) + (searchJjTitle ? 1 : 0) + (searchArtifactName ? 1 : 0) + (searchJjNumber ? 1 : 0);

  const openSqlModal = (payload) => {
    logInPage('view_sql', `Viewed SQL for "${payload.title}"`);
    setSqlModal(payload);
  };

  const clearAllFilters = () => {
    if (activeFilterCount > 0) logInPage('filter_clear_all', 'Cleared all filters and search terms');
    setFilters({}); setSearchFileName(''); setSearchObjectName(''); setSearchJjTitle(''); setSearchArtifactName(''); setSearchJjNumber('');
  };

  // Chips describing every active filter/search term, each individually removable.
  const activeChips = useMemo(() => {
    const chips = [];
    Object.entries(filters).forEach(([col, vals]) => {
      (vals || []).forEach(v => chips.push({
        key: `${col}:${v}`,
        text: `${FILTER_LABELS[col] || col}: ${col === 'STATUS' ? ingestionStatusDisplayLabel(v) : v}`,
        onRemove: () => {
          logInPage('filter_remove', `Removed ${FILTER_LABELS[col] || col} filter: ${v}`);
          setFilters(f => ({ ...f, [col]: f[col].filter(x => x !== v) }));
        },
      }));
    });
    if (searchFileName) chips.push({ key: 'sf', text: `FILE_NAME: "${searchFileName}"`, onRemove: () => setSearchFileName('') });
    if (searchObjectName) chips.push({ key: 'so', text: `OBJECT_NAME: "${searchObjectName}"`, onRemove: () => setSearchObjectName('') });
    if (searchJjTitle) chips.push({ key: 'sj', text: `JJ_TITLE: "${searchJjTitle}"`, onRemove: () => setSearchJjTitle('') });
    if (searchArtifactName) chips.push({ key: 'sa', text: `ARTIFACT_NAME: "${searchArtifactName}"`, onRemove: () => setSearchArtifactName('') });
    if (searchJjNumber) chips.push({ key: 'sn', text: `JJ_NUMBER: "${searchJjNumber}"`, onRemove: () => setSearchJjNumber('') });
    return chips;
  }, [filters, searchFileName, searchObjectName, searchJjTitle, searchArtifactName, searchJjNumber]);

  // Fetch one page of rows for an explicit page number - never reads `page`
  // state internally so callers control exactly which page gets requested
  // (avoids the filter-change/page-reset double-fire race).
  const fetchRows = useCallback(async (targetPage, opts = {}) => {
    if (!rimActive) return;
    if (rowsAbortRef.current) rowsAbortRef.current.abort();
    const controller = new AbortController();
    rowsAbortRef.current = controller;

    setRowsLoading(true);
    setRowsError(null);
    try {
      const params = new URLSearchParams(searchParams);
      params.set('page', targetPage);
      params.set('page_size', pageSize);
      params.set('sort_col', sortCol);
      params.set('sort_dir', sortAsc ? 'asc' : 'desc');
      if (distinctOnly) params.set('distinct_only', 'true');
      if (opts.bypassCache) params.set('bypass_cache', 'true');

      const data = await fetchJson(`${API_BASE_URL}/api/unstructured/rows?${params.toString()}`, { signal: controller.signal });
      if (!mountedRef.current || rowsAbortRef.current !== controller) return; // superseded

      setColumns(data.columns || []);
      setRows(data.rows || []);
      setTotalCount(data.total_count || 0);
      setTotalPages(data.total_pages || 1);
      setElapsedMs(data.elapsed_ms);
      setQueryId(data.query_id);
      setRowsSql(data.sql || '');
      setRowsCached(!!data.cached);
      setPage(targetPage);

      // If the requested page no longer exists (data shrank on refresh),
      // fall back to the last valid page instead of showing an empty table.
      if (data.total_pages && targetPage > data.total_pages) {
        fetchRows(data.total_pages, opts);
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded - newer request owns state
      if (mountedRef.current) setRowsError(e.message || 'Failed to load Unstructured metadata');
    } finally {
      // Only the still-current request may clear the spinner.
      if (rowsAbortRef.current === controller) setRowsLoading(false);
    }
  }, [searchParams, pageSize, sortCol, sortAsc, distinctOnly, rimActive]);

  const loadSummaryAndCharts = useCallback(async (opts = {}) => {
    if (!rimActive) return;
    if (chartsAbortRef.current) chartsAbortRef.current.abort();
    const controller = new AbortController();
    chartsAbortRef.current = controller;

    setChartsLoading(true);
    setChartsError(null);
    const params = new URLSearchParams(searchParams);
    if (opts.bypassCache) params.set('bypass_cache', 'true');
    const qs = params.toString();

    // allSettled, not all: each card loads independently, so one missing or
    // broken endpoint (e.g. a backend without /chart/domain-distinct-objects
    // yet) degrades only its own card instead of blanking every KPI + chart.
    const [summaryRes, domainRes, taRes, distinctObjRes, taDomRes, ingestionStatusRes] = await Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/unstructured/summary?${qs}`, { signal: controller.signal }),
      fetchJson(`${API_BASE_URL}/api/unstructured/chart/domain-status?${qs}`, { signal: controller.signal }),
      fetchJson(`${API_BASE_URL}/api/unstructured/chart/therapeutic-area?${qs}`, { signal: controller.signal }),
      fetchJson(`${API_BASE_URL}/api/unstructured/chart/domain-distinct-objects?${qs}`, { signal: controller.signal }),
      fetchJson(`${API_BASE_URL}/api/unstructured/chart/therapeutic-area-domain?${qs}`, { signal: controller.signal }),
      fetchJson(`${API_BASE_URL}/api/unstructured/chart/ingestion-status?${qs}`, { signal: controller.signal }),
    ]);
    if (!mountedRef.current || chartsAbortRef.current !== controller) return;
    const results = [summaryRes, domainRes, taRes, distinctObjRes, taDomRes, ingestionStatusRes];
    if (results.some(r => r.status === 'rejected' && r.reason?.name === 'AbortError')) return; // superseded

    const errors = {};

    if (summaryRes.status === 'fulfilled') {
      setSummary(summaryRes.value);
      setSummarySql(summaryRes.value.sql || '');
      setLastSyncedAt(Date.now());
    } else {
      errors.summary = summaryRes.reason?.message || 'Failed to load summary';
    }

    if (domainRes.status === 'fulfilled') {
      setDomainStatusSql(domainRes.value.sql || '');
      const statuses = new Set();
      const byDomain = {};
      (domainRes.value.rows || []).forEach(([domain, status, count]) => {
        const d = (domain && String(domain).trim()) || 'Unknown';
        const s = (status && String(status).trim()) || 'Unknown';
        statuses.add(s);
        byDomain[d] = byDomain[d] || {};
        byDomain[d][s] = count;
      });
      const sortedDomains = Object.entries(byDomain)
        .map(([domain, counts]) => ({ domain, ...counts, __total: Object.values(counts).reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.__total - a.__total)
        .map((row) => { const rest = { ...row }; delete rest.__total; return rest; });
      setDomainStatusChart({
        data: sortedDomains,
        statuses: Array.from(statuses),
      });
    } else {
      errors.domainStatus = domainRes.reason?.message || 'Failed to load chart';
    }

    if (ingestionStatusRes.status === 'fulfilled') {
      setIngestionStatusSql(ingestionStatusRes.value.sql || '');
      setIngestionStatusChart({
        data: (ingestionStatusRes.value.rows || []).map(([status, count]) => ({
          status: (status && String(status).trim()) || 'Unknown',
          count,
        })),
        statuses: (ingestionStatusRes.value.rows || []).map(([status]) => (status && String(status).trim()) || 'Unknown'),
      });
    } else {
      errors.ingestionStatus = ingestionStatusRes.reason?.message || 'Failed to load chart';
    }

    // Stacked TA×domain is preferred; the flat endpoint stays as the fallback
    // for backends that don't serve /chart/therapeutic-area-domain yet.
    if (taDomRes.status === 'fulfilled') {
      setTaSql(taDomRes.value.sql || '');
      const byTa = new Map();
      const domainTotals = new Map();
      (taDomRes.value.rows || []).forEach(([ta, domain, count]) => {
        const t = (ta && String(ta).trim()) || 'Unknown';
        const d = (domain && String(domain).trim()) || 'Unknown';
        if (!byTa.has(t)) byTa.set(t, { domain: t, __total: 0 });
        const row = byTa.get(t);
        row[d] = (row[d] || 0) + count;
        row.__total += count;
        domainTotals.set(d, (domainTotals.get(d) || 0) + count);
      });
      const domains = Array.from(domainTotals.entries()).sort((a, b) => b[1] - a[1]).map(([d]) => d);
      const data = Array.from(byTa.values())
        .sort((a, b) => b.__total - a.__total)
        .slice(0, 15)
        .map((row) => { const rest = { ...row }; delete rest.__total; return rest; });
      setTaDomainChart({ data, domains });
    } else {
      setTaDomainChart(null);
    }
    if (taRes.status === 'fulfilled') {
      if (taDomRes.status !== 'fulfilled') setTaSql(taRes.value.sql || '');
      setTaChart((taRes.value.rows || []).map(([area, count]) => ({ area: area || 'Unknown', count })));
    }
    if (taRes.status === 'rejected' && taDomRes.status === 'rejected') {
      errors.ta = taDomRes.reason?.message || taRes.reason?.message || 'Failed to load chart';
    }

    if (distinctObjRes.status === 'fulfilled') {
      setDistinctObjSql(distinctObjRes.value.sql || '');
      setDistinctObjChart((distinctObjRes.value.rows || []).map(([domain, count]) => ({
        domain: (domain && String(domain).trim()) || 'Unknown',
        count,
      })));
    } else {
      errors.distinctObj = distinctObjRes.reason?.message || 'Failed to load chart';
    }

    setCardErrors(errors);
    // Banner only when everything is down (backend unreachable) - partial
    // failures surface inside their own cards. (5 card-error keys max; the
    // TA card only errors when both of its endpoints fail.)
    setChartsError(Object.keys(errors).length >= 5 ? (errors.summary || 'Failed to load summary and charts') : null);
    setChartsLoading(false);
  }, [searchParams, rimActive]);

  // Documents-over-time trend has its own load path (doesn't refetch every
  // other KPI + chart on the tab) and, on request, no longer surfaces its own
  // failures anywhere in the UI - it just keeps whatever it last had (or
  // stays empty) rather than showing an error card or feeding the top banner.
  const docsOverTimeAbortRef = useRef(null);
  const breakdownAbortRef = useRef(null);
  const [docsOverTimeLoading, setDocsOverTimeLoading] = useState(true);
  const loadDocsOverTime = useCallback(async (opts = {}) => {
    if (!rimActive) return;
    if (docsOverTimeAbortRef.current) docsOverTimeAbortRef.current.abort();
    const controller = new AbortController();
    docsOverTimeAbortRef.current = controller;

    setDocsOverTimeLoading(true);
    const params = new URLSearchParams(searchParams);
    if (opts.bypassCache) params.set('bypass_cache', 'true');
    params.set('granularity', docsOverTimeGranularity);

    try {
      const data = await fetchJson(`${API_BASE_URL}/api/unstructured/chart/documents-over-time?${params.toString()}`, { signal: controller.signal });
      if (!mountedRef.current || docsOverTimeAbortRef.current !== controller) return; // superseded
      setDocsOverTimeSql(data.sql || '');
      setDocsOverTimeChart((data.rows || []).map(([period, count]) => ({ period, count })));
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded
      // No error UI for this chart by request - just leave whatever data we
      // already had (or stay empty on first load) instead of showing a card
      // error or feeding the top "some cards couldn't load" banner.
    } finally {
      if (docsOverTimeAbortRef.current === controller) setDocsOverTimeLoading(false);
    }
  }, [searchParams, docsOverTimeGranularity, rimActive]);

  useEffect(() => {
    loadDocsOverTime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDocsOverTime]);

  // Domain -> Therapeutic area -> Artifact drill-down. Always the full table,
  // no filters - loaded lazily on first visit to the tab.
  const loadBreakdown = useCallback(async (opts = {}) => {
    if (!rimActive) return;
    breakdownAbortRef.current?.abort();
    const controller = new AbortController();
    breakdownAbortRef.current = controller;
    setBreakdownLoading(true);
    setBreakdownError(null);
    try {
      const params = new URLSearchParams(searchParams);
      if (opts.bypassCache) params.set('bypass_cache', 'true');
      const data = await fetchJson(`${API_BASE_URL}/api/unstructured/chart/breakdown?${params.toString()}`, { signal: controller.signal });
      if (breakdownAbortRef.current !== controller) return;
      setBreakdownRows(data.rows || []);
      setBreakdownSql(data.sql || '');
      setBreakdownLoaded(true);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setBreakdownError(e.message || 'Failed to load breakdown');
    } finally {
      if (breakdownAbortRef.current === controller) setBreakdownLoading(false);
    }
  }, [searchParams, rimActive]);

  // Refetch whenever the filter bar changes, and also the first time this
  // tab is opened.
  useEffect(() => {
    if (activeTab === 'breakdown') loadBreakdown();
    else setBreakdownLoaded(false); // filters moved on while we weren't looking - refetch next visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, filtersParam, debouncedFileName, debouncedObjectName, debouncedJjTitle, debouncedArtifactName, debouncedJjNumber]);

  const breakdownTree = useMemo(() => buildBreakdownTree(breakdownRows, breakdownGrouping), [breakdownRows, breakdownGrouping]);
  const filteredBreakdownTree = useMemo(
    () => filterBreakdownTree(breakdownTree, breakdownSearch),
    [breakdownTree, breakdownSearch]
  );
  const searching = breakdownSearch.trim().length > 0;

  const toggleBreakdownGrouping = () => {
    const next = breakdownGrouping === 'domain' ? 'ta' : 'domain';
    logInPage('breakdown_grouping_toggle', `Switched breakdown hierarchy to group by ${next === 'ta' ? 'Therapeutic area' : 'Domain'} first`);
    setBreakdownGrouping(next);
    setExpandedDomains(new Set());
    setExpandedTAs(new Set());
  };

  // Sets the relevant checkbox filters and jumps to the data table - a
  // "(blank)" label means the underlying value is NULL, which can't be
  // expressed as an IN-list filter, so that dimension is just left alone.
  const drillDownFromBreakdown = ({ level, outerLabel, innerLabel, label }) => {
    const outerCol = breakdownGrouping === 'ta' ? 'INSIGHT_THERAPEUTIC_AREA' : 'DOMAIN';
    const innerCol = breakdownGrouping === 'ta' ? 'DOMAIN' : 'INSIGHT_THERAPEUTIC_AREA';
    const set = (col, val) => { if (val && val !== '(blank)') return { [col]: [val] }; return {}; };
    const next = {
      ...(level === 'outer' ? set(outerCol, label) : set(outerCol, outerLabel)),
      ...(level === 'inner' ? set(innerCol, label) : level === 'artifact' ? set(innerCol, innerLabel) : {}),
      ...(level === 'artifact' ? set('ARTIFACT_NAME', label) : {}),
    };
    logInPage('breakdown_drilldown', `Drilled from breakdown into data table (${JSON.stringify(next)})`);
    setFilters(next);
    setActiveTab('table');
  };

  // Small aggregate (a few hundred rows at most) - exported straight from
  // what's already loaded client-side, no extra round-trip needed.
  const downloadBreakdownCsv = () => {
    logInPage('csv_download', 'Downloaded domain breakdown as CSV');
    const lines = ['DOMAIN,INSIGHT_THERAPEUTIC_AREA,ARTIFACT_NAME,DISTINCT_OBJ_ID_COUNT'];
    breakdownRows.forEach(([domain, ta, artifact, cnt]) => {
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      lines.push([esc(domain), esc(ta), esc(artifact), cnt].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unstructured_domain_breakdown.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Top artifacts across all domains - aggregated client-side from the same
  // breakdown rows, no extra endpoint needed.
  const topArtifacts = useMemo(() => {
    const byArtifact = new Map();
    breakdownRows.forEach(([, , artifact, cnt]) => {
      const label = breakdownLabel(artifact);
      byArtifact.set(label, (byArtifact.get(label) || 0) + cnt);
    });
    return Array.from(byArtifact.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [breakdownRows]);

  const toggleDomain = (key) => {
    logInPage('breakdown_toggle', `${expandedDomains.has(key) ? 'Collapsed' : 'Expanded'} domain "${key}" in breakdown tree`);
    setExpandedDomains(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const toggleTA = (key) => {
    logInPage('breakdown_toggle', `${expandedTAs.has(key) ? 'Collapsed' : 'Expanded'} therapeutic area "${key}" in breakdown tree`);
    setExpandedTAs(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const expandAllBreakdown = () => {
    logInPage('breakdown_toggle', 'Expanded all nodes in breakdown tree');
    setExpandedDomains(new Set(breakdownTree.domains.map(d => d.key)));
    setExpandedTAs(new Set(breakdownTree.domains.flatMap(d => d.tas.map(t => t.key))));
  };
  const collapseAllBreakdown = () => {
    logInPage('breakdown_toggle', 'Collapsed all nodes in breakdown tree');
    setExpandedDomains(new Set());
    setExpandedTAs(new Set());
  };
  // While searching, matched branches are force-expanded; manual state
  // resumes when the box is cleared.
  const effectiveExpandedDomains = searching
    ? new Set(filteredBreakdownTree.domains.map(d => d.key))
    : expandedDomains;
  const effectiveExpandedTAs = searching
    ? new Set(filteredBreakdownTree.domains.flatMap(d => d.tas.map(t => t.key)))
    : expandedTAs;

  // Any change to filters/search/sort means "start over" on page 1.
  useEffect(() => {
    fetchRows(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersParam, debouncedFileName, debouncedObjectName, debouncedJjTitle, debouncedArtifactName, debouncedJjNumber, sortCol, sortAsc, pageSize, distinctOnly, rimActive]);

  useEffect(() => {
    loadSummaryAndCharts();
  }, [loadSummaryAndCharts]);

  // Separate, best-effort fetch for the Ingestion Status facet's own
  // sidebar counts - deliberately decoupled from loadSummaryAndCharts so it
  // can use ingestionStatusFacetParams (all filters except STATUS) instead
  // of the fully-filtered searchParams the KPI donut needs. A failure here
  // just means the sidebar falls back to the plain checkbox list (no
  // counts/bars); it's not worth surfacing as a page-level card error.
  useEffect(() => {
    if (!rimActive) return;
    const controller = new AbortController();
    fetchJson(`${API_BASE_URL}/api/unstructured/chart/ingestion-status?${ingestionStatusFacetParams.toString()}`, { signal: controller.signal })
      .then(data => {
        if (!mountedRef.current) return;
        setIngestionStatusFacetChart({
          data: (data.rows || []).map(([status, count]) => ({
            status: (status && String(status).trim()) || 'Unknown',
            count,
          })),
        });
      })
      .catch(() => {}); // AbortError on superseded requests, or a genuine failure - either way, silently keep the last good value
    return () => controller.abort();
  }, [ingestionStatusFacetParams, rimActive]);

  // Leaving RIM Docs for another explorer: cancel its loads so they stop
  // holding browser connections. Coming back loads them again (rimActive is a dependency).
  useEffect(() => {
    if (rimActive) return;
    [rowsAbortRef, chartsAbortRef, docsOverTimeAbortRef, breakdownAbortRef].forEach(r => r.current?.abort());
    setBreakdownLoaded(false);
  }, [rimActive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rowsAbortRef.current?.abort();
      chartsAbortRef.current?.abort();
      docsOverTimeAbortRef.current?.abort();
      breakdownAbortRef.current?.abort();
      document.removeEventListener('mousemove', onColResizeMove);
      document.removeEventListener('mouseup', onColResizeEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleTableFullscreen = () => {
    logInPage('fullscreen_toggle', document.fullscreenElement ? 'Exited full screen on data table' : 'Entered full screen on data table');
    if (document.fullscreenElement) document.exitFullscreen();
    else tableCardRef.current?.requestFullscreen?.();
  };

  const handleRefresh = async () => {
    logInPage('reload_snowflake', `Reloaded live data from Snowflake for Unstructured (tab: "${TAB_LABELS[activeTab] || activeTab}")`);
    setRefreshing(true);
    await Promise.all([
      fetchRows(page, { bypassCache: true }),
      loadSummaryAndCharts({ bypassCache: true }),
      loadDocsOverTime({ bypassCache: true }),
      ...(breakdownLoaded ? [loadBreakdown({ bypassCache: true })] : []),
    ]);
    setRefreshing(false);
  };

  /* ---------- table helpers ---------- */

  // Callers pass their own width-getter/setter in, so a drag or a
  // double-click always lands on the right state. Snowflake VARIANT/OBJECT/ARRAY columns
  // come back as real JS objects/arrays, not strings - plain String(v) on
  // those gives "[object Object]", so objects get JSON-stringified instead.
  const cellDisplayText = (v) => {
    if (v === null || v === undefined || v === '') return 'null';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  };
  const cellText = cellDisplayText;

  const getColWidth = (col) => colWidths[col] ?? autoColWidths[col] ?? DEFAULT_COL_WIDTHS[col] ?? 160;

  // Drag-to-resize: mousedown on a header's right-edge handle starts it,
  // mousemove (bound to the whole document, not just the handle, since the
  // cursor easily outruns a 6px-wide target) tracks it, mouseup ends it.
  const onColResizeMove = useCallback((e) => {
    const st = resizeStateRef.current;
    if (!st) return;
    const next = Math.max(MIN_COL_WIDTH, st.startWidth + (e.clientX - st.startX));
    st.currentWidth = next;
    st.setWidths(w => ({ ...w, [st.col]: next }));
  }, []);

  const onColResizeEnd = useCallback(() => {
    const st = resizeStateRef.current;
    if (st) logInPage('column_resize', `Resized ${st.col} column to ${Math.round(st.currentWidth)}px`);
    resizeStateRef.current = null;
    document.removeEventListener('mousemove', onColResizeMove);
    document.removeEventListener('mouseup', onColResizeEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startColResize = (e, col, getWidth, setWidths) => {
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the header's sort-on-click
    resizeStateRef.current = { col, startX: e.clientX, startWidth: getWidth(col), currentWidth: getWidth(col), setWidths };
    document.addEventListener('mousemove', onColResizeMove);
    document.addEventListener('mouseup', onColResizeEnd);
  };

  // Double-click a column edge, Excel-style: size the column to whatever its
  // widest visible value needs. `values` is the already-stringified list of
  // that column's cells on the current page - fetching every filtered/query
  // row just to measure text isn't worth it, and the visible page is almost
  // always representative.
  const autoFitColumn = (e, col, values, setWidths) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const table = th?.closest('table');
    const td = table?.querySelector('td');
    const headerFont = th ? window.getComputedStyle(th).font : '700 10.5px sans-serif';
    const cellFont = td ? window.getComputedStyle(td).font : '400 12px sans-serif';
    const fitted = computeFitWidths(headerFont, cellFont, [col], values.map(v => ({ v })), (r) => r.v)[col];
    logInPage('column_resize', `Auto-fit ${col} column to ${fitted}px`);
    setWidths(w => ({ ...w, [col]: fitted }));
  };

  const handleSort = (col) => {
    const nextAsc = sortCol === col ? !sortAsc : true;
    logInPage('sort_change', `Sorted data table by ${col} (${nextAsc ? 'ascending' : 'descending'})`);
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(true); }
  };

  const goToPage = (newPage) => {
    const clamped = Math.max(1, Math.min(totalPages, newPage));
    if (clamped !== page) logInPage('pagination', `Went to data table page ${clamped} of ${totalPages}`);
    fetchRows(clamped);
  };

  // CSV export downloads only the current page - the whole filtered set can
  // be millions of rows.
  const downloadCsv = () => {
    logInPage('csv_download', `Downloaded data table page ${page} (${rows.length} rows) as CSV`);
    const cols = DEFAULT_COLUMNS.filter(c => columns.includes(c));
    const lines = [cols.join(',')];
    rows.forEach(r => {
      const rowObj = Object.fromEntries(columns.map((c, i) => [c, r[i]]));
      lines.push(cols.map(c => {
        const v = rowObj[c] === null || rowObj[c] === undefined ? '' : String(rowObj[c]).replace(/"/g, '""');
        return /[",\n]/.test(v) ? `"${v}"` : v;
      }).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unstructured_page_${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Full filtered set, not just what's on screen - streamed straight from
  // the backend so this works even for a multi-million row result.
  const downloadAllCsv = () => {
    logInPage('csv_download', `Downloaded ${distinctOnly ? 'all distinct files' : 'all matching rows'} (${totalCount} rows) as CSV`);
    const params = new URLSearchParams(searchParams);
    params.set('sort_col', sortCol);
    params.set('sort_dir', sortAsc ? 'asc' : 'desc');
    if (distinctOnly) params.set('distinct_only', 'true');
    downloadFile(`/api/unstructured/rows/download?${params.toString()}`, 'unstructured_rows.csv');
  };

  const tableRows = useMemo(
    () => rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    [rows, columns]
  );

  const visibleCols = DEFAULT_COLUMNS.filter(c => columns.includes(c));

  // Data-driven default widths, Snowflake/DBeaver-style: every time a new
  // page of rows lands, size each column to what it actually needs. Runs
  // after the table's own header has painted so the font/measurement
  // matches exactly what's on screen, rather than guessing at a font string.
  useEffect(() => {
    if (!visibleCols.length) return;
    const th = tableCardRef.current?.querySelector('th');
    const td = tableCardRef.current?.querySelector('td');
    const headerFont = th ? window.getComputedStyle(th).font : '700 10.5px sans-serif';
    const cellFont = td ? window.getComputedStyle(td).font : '400 12px sans-serif';
    setAutoColWidths(computeFitWidths(headerFont, cellFont, visibleCols, tableRows, (r, c) => cellText(r[c])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns]);

  // Same status always gets the same color across renders/refreshes.
  const statusColors = useMemo(() => {
    const ref = { i: 0 };
    const map = {};
    domainStatusChart.statuses.forEach(s => { map[s] = colorForStatus(s, ref); });
    return map;
  }, [domainStatusChart.statuses]);

  // Domain -> color for the TA×domain stacked chart (palette assigned in
  // descending-volume order, stable per response).
  const taDomainColors = useMemo(() => {
    const map = {};
    (taDomainChart?.domains || []).forEach((d, i) => { map[d] = DOMAIN_PALETTE[i % DOMAIN_PALETTE.length]; });
    return map;
  }, [taDomainChart]);

  // Colors keyed off the facet data (all-filters-except-STATUS), since that
  // set always includes every status that could still be selected - the
  // donut's own self-inclusive data can be a strict subset (e.g. only
  // SUCCESS once SUCCESS is selected) and would otherwise leave sibling
  // statuses uncolored.
  const ingestionStatusColors = useMemo(() => {
    const ref = { i: 0 };
    const map = {};
    ingestionStatusFacetChart.data.forEach(({ status }) => { map[status] = colorForIngestionStatus(status, ref); });
    return map;
  }, [ingestionStatusFacetChart.data]);

  // status -> count for the Ingestion Status facet's own checkboxes/bars.
  // Deliberately sourced from ingestionStatusFacetChart (STATUS excluded
  // from its own filter) rather than ingestionStatusChart, so picking one
  // status doesn't filter its siblings out of existence in the sidebar.
  const ingestionStatusCounts = useMemo(() => {
    const map = {};
    ingestionStatusFacetChart.data.forEach(({ status, count }) => { map[status] = count; });
    return map;
  }, [ingestionStatusFacetChart.data]);

  // Ingestion status (STATUS column) mix for the KPI donut.
  const ingestionStatusMix = useMemo(() => {
    const sum = ingestionStatusChart.data.reduce((a, row) => a + (row.count || 0), 0);
    if (!sum) return { segments: [], ingested: null };
    const sorted = [...ingestionStatusChart.data].sort((a, b) => b.count - a.count);
    const successRow = ingestionStatusChart.data.find(({ status }) => String(status || "").trim().toUpperCase() === "SUCCESS");
    const successCount = successRow ? successRow.count : 0;
    return {
      segments: sorted.map(({ status, count }) => ({ status, color: ingestionStatusColors[status], frac: count / sum, count })),
      ingested: { pct: Math.round((successCount / sum) * 100), color: ingestionStatusColors.SUCCESS || INGESTION_STATUS_COLOR_MAP.SUCCESS },
    };
  }, [ingestionStatusChart, ingestionStatusColors]);

  const busy = refreshing || rowsLoading || chartsLoading;

  const segTabs = [
    { id: 'overview', label: 'Explore' },
    { id: 'table', label: 'Data table' },
    { id: 'breakdown', label: 'Domain breakdown' },
  ].filter(t => tabIds.includes(t.id));

  /* ============================== render ============================== */

  // On the welcome screen, download the explorers this user can open in the
  // background so picking one is instant.
  const docTypesKey = docTypeIds.join(',');
  useEffect(() => {
    if (activeDocType !== null) return undefined;
    const run = () => docTypesKey.split(',').forEach(preloadDocType);
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(run, 300);
    return () => clearTimeout(id);
  }, [activeDocType, docTypesKey]);

  // Nothing picked yet - show the "choose an explorer" landing screen
  // instead of the tabbed workspace below. All the hooks above still run
  // on every render either way (rules of hooks), they just sit idle until
  // a document set is chosen and activeDocType stops being null.
  if (activeDocType === null) {
    return <UnstructuredWelcome onSelect={setActiveDocType} allowed={docTypeIds} />;
  }

  return (
    // max-h-screen: if the parent ever fails to give this page a definite
    // height (percentage heights can resolve to auto at some zoom levels),
    // cap at the viewport so the header/tabs stay pinned and the inner
    // regions scroll - instead of the whole page growing past the viewport.
    <div className="h-full max-h-screen flex flex-col overflow-hidden bg-jj-gray-01 relative">
      <IconDefs />
      {busy && (
        <div className="fixed top-0 left-0 right-0 h-0.5 bg-jj-blue-03 z-50 animate-pulse" />
      )}

      {/* ── Top bar: brand, page name, document set tabs ── */}
      <div className="flex-shrink-0 bg-white border-b border-jj-gray-02 px-7 py-2.5">
        <div className="flex items-center gap-5 min-w-0">
          <div className="flex items-center gap-4 flex-shrink-0">
            <button onClick={() => navigate('/dashboard')} title="Go to dashboard" className="flex-shrink-0">
              <img src="/sh_logo.png" alt="GRA SmartHub" draggable={false} className="block select-none w-[96px] h-auto" />
            </button>
            <span className="w-px h-[30px] bg-jj-gray-03" />
            <button
              onClick={backToWelcome}
              title="Back to all explorers"
              className="group flex flex-col items-start gap-[3px] text-left whitespace-nowrap"
            >
              <span className="font-johnson-display font-bold text-[13px] uppercase tracking-[.16em] leading-none text-jj-gray-08 group-hover:text-jj-red transition-colors">
                Unstructured Explorer
              </span>
              <span className="font-johnson-text text-[9.5px] uppercase tracking-[.22em] leading-none text-jj-gray-06">
                Global Regulatory Affairs
              </span>
            </button>
          </div>

          <nav
            aria-label="Document sets"
            className="flex items-center gap-1 min-w-0 overflow-x-auto bg-jj-gray-01 border border-jj-gray-02 rounded-xl p-1"
            style={{ paddingBottom: 2 }}
          >
            {docTypeIds.map(id => {
              const active = activeDocType === id;
              return (
                <React.Fragment key={id}>
                  <button
                    onClick={() => setActiveDocType(id)}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-center gap-2 pl-2 pr-3.5 py-[6px] rounded-lg text-[13px] font-johnson-text whitespace-nowrap transition-all flex-shrink-0 ${
                      active
                        ? 'bg-white text-jj-gray-08 font-medium shadow-[0_1px_4px_rgba(49,44,42,.14)]'
                        : 'text-jj-gray-06 hover:text-jj-gray-08 hover:bg-white/70'
                    }`}
                  >
                    <span className={`flex items-center justify-center w-[22px] h-[22px] rounded-md transition-colors ${
                      active ? 'bg-jj-red/10' : 'bg-jj-gray-02/80 group-hover:bg-jj-gray-02'
                    }`}>
                      <Icon src={DOC_TYPE_ICONS[id]} tint={active ? 'red' : 'gray'} className="w-[12px] h-[12px]" />
                    </span>
                    {DOC_TYPE_LABELS[id]}
                  </button>
                  {id === docTypeGroupEnd && <span className="w-px h-[18px] bg-jj-gray-03 mx-1 flex-shrink-0" />}
                </React.Fragment>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ── Header with brand backdrop ── */}
      <div className="flex-shrink-0 relative bg-white border-b border-jj-gray-02 overflow-hidden">
        <img
          src="/background.png"
          alt=""
          aria-hidden="true"
          className="absolute pointer-events-none select-none"
          style={{ top: -120, right: -60, width: 760, opacity: .55 }}
        />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg,#fff 0%,#fff 46%,rgba(255,255,255,.55) 74%,rgba(255,255,255,.2) 100%)' }} />
        <div className="relative px-7 pt-[18px] pb-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex items-center gap-4">
            <span className="relative flex items-center justify-center w-[46px] h-[46px] rounded-2xl bg-white border border-jj-gray-02 shadow-[0_6px_18px_-10px_rgba(235,23,0,.45)] flex-shrink-0">
              <span className="absolute inset-[5px] rounded-xl bg-jj-red/[.08]" />
              <Icon src={DOC_TYPE_ICONS[activeDocType]} tint="red" className="relative w-[20px] h-[20px]" />
            </span>
            <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="font-johnson-display font-bold text-[26px] leading-none tracking-[-.01em] text-jj-gray-08">{DOC_TYPE_LABELS[activeDocType]}</h1>
              {(() => {
                const pill = {
                  vr: { busy: vrBusyAll, at: vrSyncedAt },
                  immbot: { busy: immbotBusy, at: immbotSyncedAt },
                  rimdocs: { busy, at: lastSyncedAt },
                  epod: { busy: epodBusy, at: null },
                  nipo: { busy: nipoBusy, at: null },
                  fda: { busy: fdaBusy, at: null },
                }[activeDocType];
                if (!pill) return null;
                return (
                  <span
                    title={pill.at ? `Last synced ${formatEasternTimestamp(pill.at)}` : undefined}
                    className="inline-flex items-center gap-1.5 bg-jj-gray-01 rounded-full px-[11px] py-[3px] text-xs font-johnson-text text-jj-gray-06 whitespace-nowrap flex-shrink-0"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${pill.busy ? 'bg-jj-orange-03 animate-pulse' : 'bg-jj-green-03'}`} />
                    {pill.busy ? 'Syncing…' : pill.at ? `Synced ${formatTimeAgo(pill.at)}` : 'Synced'}
                  </span>
                );
              })()}
            </div>
            {activeDocType === 'rimdocs' && (
              <div className="mt-1.5 text-xs font-johnson-text text-jj-gray-06 tabular-nums">
                {totalCount.toLocaleString()} rows match current filters
                {elapsedMs != null && <> · {elapsedMs.toLocaleString()} ms{rowsCached ? ' · cached' : ''}</>}
              </div>
            )}
            </div>
          </div>

          {activeDocType === 'vr' && (
          <div className="flex-1 flex justify-center min-w-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {vrScopeIds.includes('internal') && (
                <button
                  onClick={() => setActiveVrScope('internal')}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeVrScope === 'internal'
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  Internal
                </button>
              )}
              {vrCanExt && (
                <button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setVrExtMenu(m => m ? null : { top: r.bottom + 6, left: r.left });
                  }}
                  className={`flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeVrScope !== 'internal'
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {activeVrScope === 'cortellis' ? 'Cortellis' : 'External'}
                  <Icon src={chevronDownIcon} tint={activeVrScope !== 'internal' ? 'white' : 'ink'} className={`w-[9px] h-[9px] transition-transform ${vrExtMenu ? 'rotate-180' : ''}`} />
                </button>
              )}
            </div>
            {vrExtMenu && ReactDOM.createPortal(
              <>
                <div className="fixed inset-0 z-[9998]" onClick={() => setVrExtMenu(null)} />
                <div
                  style={{ position: 'fixed', top: vrExtMenu.top, left: vrExtMenu.left }}
                  className="w-[260px] bg-white border border-jj-gray-02 rounded-2xl shadow-[0_12px_32px_rgba(49,44,42,.16)] z-[9999] p-1.5"
                >
                  <div className="px-2.5 pt-1.5 pb-2 text-[10px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-05">
                    External sources
                  </div>
                  {[
                    { id: 'external', label: 'Health authorities', sub: 'FDA press releases and HA tables', icon: shieldIcon },
                    { id: 'cortellis', label: 'Cortellis', sub: 'Trials, products, milestones, HA news', icon: dataVizIcon },
                  ].filter(o => vrScopeIds.includes(o.id)).map(o => {
                    const on = activeVrScope === o.id;
                    return (
                      <button
                        key={o.id}
                        onClick={() => setActiveVrScope(o.id)}
                        className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors ${
                          on ? 'bg-jj-red/[.06]' : 'hover:bg-jj-gray-01'
                        }`}
                      >
                        <span className={`w-8 h-8 flex-shrink-0 rounded-lg flex items-center justify-center ${on ? 'bg-jj-red/10' : 'bg-jj-gray-01'}`}>
                          <Icon src={o.icon} tint={on ? 'red' : 'ink'} className="w-4 h-4" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className={`block text-[12.5px] font-johnson-text ${on ? 'text-jj-red font-medium' : 'text-jj-gray-08'}`}>{o.label}</span>
                          <span className="block text-[11px] font-johnson-text text-jj-gray-06 truncate">{o.sub}</span>
                        </span>
                        {on && <span className="w-1.5 h-1.5 rounded-full bg-jj-red flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </>,
              document.body
            )}
          </div>
          )}

          {activeDocType === 'vr' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            {(activeVrScope === 'internal' || (activeVrScope === 'external' && vrExtStage === 'data')) && (
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {(vrTableOnly ? ['table'] : activeVrScope === 'internal' ? vrTabIds : vrExternalTabIds).map(id => (
                <button
                  key={id}
                  onClick={() => setActiveVrTab(id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    shownVrTab === id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {vrTabLabels[id]}
                </button>
              ))}
            </div>
            )}
            {activeVrScope === 'external' && vrExtStage === 'data' && (
            <div className="relative">
              <button
                ref={vrSourceBtnRef}
                onClick={() => {
                  if (!vrSourceMenuOpen && vrSourceBtnRef.current) {
                    const rect = vrSourceBtnRef.current.getBoundingClientRect();
                    setVrSourceMenuCoords({
                      top: rect.bottom + window.scrollY + 8,
                      left: rect.right + window.scrollX,
                      width: rect.width,
                    });
                  }
                  setVrSourceMenuOpen(o => !o);
                }}
                title="Choose which external table to view"
                className="flex items-center gap-2 px-[16px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
              >
                {activeVrSourceInfo.label}
                <Icon src={chevronDownIcon} tint="white" className={`w-[10px] h-[10px] transition-transform ${vrSourceMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {vrSourceMenuOpen && ReactDOM.createPortal(
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setVrSourceMenuOpen(false)} />
                  <div
                    style={{
                      position: 'absolute',
                      top: vrSourceMenuCoords.top,
                      left: vrSourceMenuCoords.left,
                      transform: 'translateX(-100%)',
                      minWidth: Math.max(vrSourceMenuCoords.width, 220),
                    }}
                    className="max-h-80 overflow-y-auto bg-white border border-jj-gray-02 rounded-xl shadow-[0_8px_24px_rgba(49,44,42,.18)] z-[9999] py-1.5"
                  >
                    {vrFacetCount > 0 ? (
                      <div className="px-3.5 pt-1 pb-2 mb-1 border-b border-jj-gray-01 text-[10.5px] font-johnson-text text-jj-gray-06">
                        {vrFacetCount} filter{vrFacetCount === 1 ? '' : 's'} on ·{' '}
                        <button onClick={() => setVrFacets({})} className="text-jj-blue-03 underline">clear</button>
                      </div>
                    ) : (
                      <div className="px-3.5 pt-1 pb-2 mb-1 border-b border-jj-gray-01 text-[10.5px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-06 truncate">
                        {activeVrHa}
                      </div>
                    )}
                    {vrMenuSources.length === 0 && (
                      <div className="px-3.5 py-2 text-[12px] font-johnson-text text-jj-gray-05">No tables match.</div>
                    )}
                    {vrMenuSources.map(s => (
                      <button
                        key={s.id}
                        onClick={() => { openVrTable(s.id); setVrSourceMenuOpen(false); }}
                        className={`w-full flex items-center justify-between gap-2 px-3.5 py-2 text-left text-[12.5px] font-johnson-text hover:bg-jj-gray-01 ${
                          s.id === activeVrSource ? 'text-jj-red font-medium' : 'text-jj-gray-08'
                        }`}
                      >
                        <span className="truncate">{s.label}</span>
                      </button>
                    ))}
                    <button
                      onClick={() => setActiveVrHa(null)}
                      className="w-full mt-1 pt-2 px-3.5 pb-1 border-t border-jj-gray-01 text-left text-[11.5px] font-johnson-text text-jj-blue-03 hover:text-jj-red"
                    >
                      ← All health authorities
                    </button>
                  </div>
                </>,
                document.body
              )}
            </div>
            )}
            <button
              onClick={() => { logInPage('refresh', 'Reloaded Virtual Regulator data'); setVrReloadKey(k => k + 1); }}
              disabled={vrBusyAll}
              title="Reload live data"
              className="flex items-center gap-2 px-[18px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium disabled:opacity-60 hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
            >
              <Icon src={refreshIcon} tint="white" className={`w-[13px] h-[13px] ${vrBusyAll ? 'animate-spin' : ''}`} />
              {vrBusyAll ? 'Loading…' : 'Reload'}
            </button>
          </div>
          )}

          {activeDocType === 'immbot' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {immbotTabIds.map(id => (
                <button
                  key={id}
                  onClick={() => setActiveImmbotTab(id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeImmbotTab === id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {IMMBOT_TAB_LABELS[id]}
                </button>
              ))}
            </div>
            <button
              onClick={() => { logInPage('refresh', 'Reloaded IMMBOT data'); setImmbotReloadKey(k => k + 1); }}
              disabled={immbotBusy}
              title="Reload live data"
              className="flex items-center gap-2 px-[18px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium disabled:opacity-60 hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
            >
              <Icon src={refreshIcon} tint="white" className={`w-[13px] h-[13px] ${immbotBusy ? 'animate-spin' : ''}`} />
              {immbotBusy ? 'Loading…' : 'Reload'}
            </button>
          </div>
          )}

          {activeDocType === 'rimdocs' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {segTabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeTab === tab.id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Reload live data"
              className="flex items-center gap-2 px-[18px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium disabled:opacity-60 hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
            >
              <Icon src={refreshIcon} tint="white" className={`w-[13px] h-[13px] ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Reloading…' : 'Reload'}
            </button>
          </div>
          )}

          {activeDocType === 'epod' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {[{ id: 'explore', label: 'Explore' }, { id: 'table', label: 'Data table' }].filter(t => epodTabIds.includes(t.id)).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveEpodTab(tab.id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeEpodTab === tab.id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative">
              <button
                ref={epodDatasetBtnRef}
                onClick={() => {
                  if (!epodDatasetMenuOpen && epodDatasetBtnRef.current) {
                    const rect = epodDatasetBtnRef.current.getBoundingClientRect();
                    setEpodDatasetMenuCoords({
                      top: rect.bottom + window.scrollY + 8,
                      left: rect.right + window.scrollX,
                      width: rect.width,
                    });
                  }
                  setEpodDatasetMenuOpen(o => !o);
                }}
                disabled={epodDatasetsLoading || epodDatasets.length === 0}
                title="Choose which dataset to explore"
                className="flex items-center gap-2 px-[16px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium disabled:opacity-60 hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
              >
                {epodDatasetsLoading ? 'Loading…' : (epodDatasets.find(d => d.id === activeEpodDataset)?.label || 'Dataset')}
                <Icon src={chevronDownIcon} tint="white" className={`w-[10px] h-[10px] transition-transform ${epodDatasetMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {epodDatasetMenuOpen && ReactDOM.createPortal(
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setEpodDatasetMenuOpen(false)} />
                  <div
                    style={{
                      position: 'absolute',
                      top: epodDatasetMenuCoords.top,
                      left: epodDatasetMenuCoords.left,
                      transform: 'translateX(-100%)',
                      minWidth: Math.max(epodDatasetMenuCoords.width, 220),
                    }}
                    className="max-h-80 overflow-y-auto bg-white border border-jj-gray-02 rounded-xl shadow-[0_8px_24px_rgba(49,44,42,.18)] z-[9999] py-1.5"
                  >
                    {epodDatasets.map(d => (
                      <button
                        key={d.id}
                        onClick={() => setActiveEpodDataset(d.id)}
                        className={`w-full flex items-center justify-between gap-2 px-3.5 py-2 text-left text-[12.5px] font-johnson-text hover:bg-jj-gray-01 ${
                          d.id === activeEpodDataset ? 'text-jj-red font-medium' : 'text-jj-gray-08'
                        }`}
                      >
                        <span className="truncate">{d.label}</span>
                        {!d.has_log && <span className="text-[9.5px] font-johnson-text text-jj-gray-05 flex-shrink-0">no log</span>}
                      </button>
                    ))}
                  </div>
                </>,
                document.body
              )}
            </div>
          </div>
          )}

          {activeDocType === 'nipo' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {[{ id: 'explore', label: 'Explore' }, { id: 'table', label: 'Data table' }].filter(t => nipoTabIds.includes(t.id)).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveNipoTab(tab.id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeNipoTab === tab.id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          )}

          {activeDocType === 'fda' && (
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="flex bg-jj-gray-01/90 border border-jj-gray-02 rounded-full p-[3px] gap-0.5">
              {[{ id: 'explore', label: 'Explore' }, { id: 'table', label: 'Data table' }].filter(t => fdaTabIds.includes(t.id)).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveFdaTab(tab.id)}
                  className={`px-4 py-[7px] rounded-full text-[12.5px] font-johnson-text transition-colors ${
                    activeFdaTab === tab.id
                      ? 'bg-jj-gray-08 text-white font-medium'
                      : 'text-jj-gray-07 hover:text-jj-gray-08'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative">
              <button
                ref={fdaDashboardBtnRef}
                onClick={() => {
                  if (!fdaDashboardMenuOpen && fdaDashboardBtnRef.current) {
                    const rect = fdaDashboardBtnRef.current.getBoundingClientRect();
                    setFdaDashboardMenuCoords({
                      top: rect.bottom + window.scrollY + 8,
                      left: rect.right + window.scrollX,
                      width: rect.width,
                    });
                  }
                  setFdaDashboardMenuOpen(o => !o);
                }}
                title="Choose which FDA dashboard to view"
                className="flex items-center gap-2 px-[16px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium disabled:opacity-60 hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
              >
                {FDA_DASHBOARDS.find(d => d.id === activeFdaDashboard)?.label || 'Dashboard'}
                <Icon src={chevronDownIcon} tint="white" className={`w-[10px] h-[10px] transition-transform ${fdaDashboardMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {fdaDashboardMenuOpen && ReactDOM.createPortal(
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setFdaDashboardMenuOpen(false)} />
                  <div
                    style={{
                      position: 'absolute',
                      top: fdaDashboardMenuCoords.top,
                      left: fdaDashboardMenuCoords.left,
                      transform: 'translateX(-100%)',
                      minWidth: Math.max(fdaDashboardMenuCoords.width, 220),
                    }}
                    className="max-h-80 overflow-y-auto bg-white border border-jj-gray-02 rounded-xl shadow-[0_8px_24px_rgba(49,44,42,.18)] z-[9999] py-1.5"
                  >
                    {FDA_DASHBOARDS.map(d => (
                      <button
                        key={d.id}
                        onClick={() => setActiveFdaDashboard(d.id)}
                        className={`w-full flex items-center justify-between gap-2 px-3.5 py-2 text-left text-[12.5px] font-johnson-text hover:bg-jj-gray-01 ${
                          d.id === activeFdaDashboard ? 'text-jj-red font-medium' : 'text-jj-gray-08'
                        }`}
                      >
                        <span className="truncate">{d.label}</span>
                      </button>
                    ))}
                  </div>
                </>,
                document.body
              )}
            </div>
          </div>
          )}
        </div>

        {/* Active filter chips */}
        {activeDocType === 'rimdocs' && activeChips.length > 0 && (activeTab === 'overview' || activeTab === 'table' || activeTab === 'breakdown') && (
          <div className="relative px-7 pb-3 flex items-center gap-2 flex-wrap">
            {activeChips.map(chip => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-white border border-jj-gray-03 text-[11px] font-johnson-text text-jj-gray-08"
              >
                {chip.text}
                <button onClick={chip.onRemove} className="hover:opacity-60">
                  <Icon src={closeIcon} alt="Remove" tint="gray" className="w-2 h-2" />
                </button>
              </span>
            ))}
            <button onClick={clearAllFilters} className="text-[11px] font-johnson-text text-jj-blue-03 underline">
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <Suspense fallback={<ExplorerLoading />}>
      {activeDocType === 'vr' && activeVrScope === 'external' && vrExtStage !== 'data' ? (
        <VrExternalWelcome
          sources={vrSources}
          loading={vrSourcesLoading && (vrSources === VR_EXT_FALLBACK || (!!urlVrHa && !activeVrHa))}
          ha={activeVrHa}
          onPickHa={setActiveVrHa}
          onPickTable={setActiveVrSource}
          onOpenSource={openVrTable}
          onBack={() => setActiveVrHa(null)}
        />
      ) : activeDocType === 'vr' && activeVrScope === 'external' ? (
        <>
        <nav aria-label="Breadcrumb" className="flex-shrink-0 bg-white border-b border-jj-gray-02 px-7 py-2.5 flex items-center gap-2 text-[12.5px] font-johnson-text text-jj-gray-06 min-w-0">
          <button
            onClick={() => (vrHaSources.length > 1 ? setActiveVrSource(null) : setActiveVrHa(null))}
            title="Back"
            aria-label="Back"
            className="flex items-center justify-center w-[26px] h-[26px] rounded-lg border border-jj-gray-02 text-jj-gray-06 hover:text-jj-red hover:border-jj-gray-03 transition-colors flex-shrink-0"
          >
            <Icon src={chevronRightIcon} tint="gray" className="w-[11px] h-[11px] rotate-180" />
          </button>
          <button onClick={() => setActiveVrHa(null)} className="px-1.5 py-0.5 rounded-md text-jj-gray-06 hover:text-jj-red hover:bg-jj-gray-01 whitespace-nowrap transition-colors">Health authorities</button>
          <Icon src={chevronRightIcon} tint="gray" className="w-[9px] h-[9px] opacity-60 flex-shrink-0" />
          {vrHaSources.length > 1 ? (
            <button onClick={() => setActiveVrSource(null)} className="px-1.5 py-0.5 rounded-md text-jj-gray-06 hover:text-jj-red hover:bg-jj-gray-01 truncate transition-colors">{activeVrHa}</button>
          ) : (
            <span className="px-1.5 py-0.5 truncate">{activeVrHa}</span>
          )}
          <Icon src={chevronRightIcon} tint="gray" className="w-[9px] h-[9px] opacity-60 flex-shrink-0" />
          <span aria-current="page" className="px-2.5 py-[3px] rounded-full bg-jj-red/[.07] text-jj-gray-08 font-medium truncate">{activeVrSourceInfo.label}</span>
        </nav>
        <VrExternalExplorer
          key={activeVrSource}
          source={activeVrSourceInfo}
          sources={vrSources}
          facets={vrFacets}
          onFacetsChange={setVrFacets}
          onOpenTable={openVrTable}
          noMatch={vrNoMatch}
          logInPage={logInPage}
          activeTab={shownVrTab}
          onBusyChange={setVrBusy}
          onSynced={setVrSyncedAt}
          canViewSql={canViewSql}
          reloadKey={vrReloadKey}
        />
        </>
      ) : activeDocType === 'vr' && activeVrScope === 'cortellis' ? (
        <CortellisExplorer
          logInPage={logInPage}
          activeTab={shownVrTab}
          onBusyChange={setVrBusy}
          onSynced={setVrSyncedAt}
          canViewSql={canViewSql}
          reloadKey={vrReloadKey}
        />
      ) : activeDocType === 'mirai' || activeDocType === 'rmwcreate' ? (
        <ComingSoon
          icon={DOC_TYPE_ICONS[activeDocType]}
          message={`The ${DOC_TYPE_LABELS[activeDocType]} explorer is being built. Check back soon.`}
        />
      ) : activeDocType === 'vr' ? (activeVrScope === 'internal' &&
        <VirtualRegulatorExplorer
          logInPage={logInPage}
          activeTab={activeVrTab}
          onTabChange={setActiveVrTab}
          onBusyChange={setVrBusy}
          onSynced={setVrSyncedAt}
          canViewSql={canViewSql}
          reloadKey={vrReloadKey}
        />
      ) : activeDocType === 'immbot' ? (
        <ImmbotExplorer
          logInPage={logInPage}
          activeTab={activeImmbotTab}
          onTabChange={setActiveImmbotTab}
          onBusyChange={setImmbotBusy}
          onSynced={setImmbotSyncedAt}
          canViewSql={canViewSql}
          reloadKey={immbotReloadKey}
        />
      ) : activeDocType === 'haq' ? (
        <HaqExplorer logInPage={logInPage} />
      ) : activeDocType === 'epod' ? (
        <EpodExplorer logInPage={logInPage} activeTab={activeEpodTab} onBusyChange={setEpodBusy} dataset={activeEpodDataset} />
      ) : activeDocType === 'nipo' ? (
        <NipoExplorer logInPage={logInPage} activeTab={activeNipoTab} onBusyChange={setNipoBusy} />
      ) : activeDocType === 'fda' ? (
        <FDAExplorer logInPage={logInPage} activeTab={activeFdaTab} onBusyChange={setFdaBusy} dashboard={activeFdaDashboard} />
      ) : (
      <div className="flex-1 min-h-0 flex">

        {/* ============ EXPLORE ============ */}
        {(activeTab === 'overview' || activeTab === 'table' || activeTab === 'breakdown') && (railCollapsed ? (
          <div className="w-10 flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col items-center pt-3 gap-2">
            <button onClick={() => { logInPage('filter_rail_toggle', 'Expanded the filter rail'); setRailCollapsed(false); }} title="Expand filters" className="p-1.5 rounded hover:bg-jj-gray-01">
              <Icon src={chevronRightIcon} tint="ink" className="w-3 h-3" />
            </button>
            <button onClick={() => { logInPage('filter_rail_toggle', 'Expanded the filter rail'); setRailCollapsed(false); }} title="Expand filters" className="relative p-1.5 rounded hover:bg-jj-gray-01">
              <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[15px] h-[15px] px-0.5 rounded-full bg-jj-red text-white text-[9px] font-medium">{activeFilterCount}</span>
              )}
            </button>
          </div>
        ) : (
          <FilterRail
              filters={filters}
              setFilters={setFilters}
              searchFileName={searchFileName}
              setSearchFileName={setSearchFileName}
              searchObjectName={searchObjectName}
              setSearchObjectName={setSearchObjectName}
              searchJjTitle={searchJjTitle}
              setSearchJjTitle={setSearchJjTitle}
              searchArtifactName={searchArtifactName}
              setSearchArtifactName={setSearchArtifactName}
              searchJjNumber={searchJjNumber}
              setSearchJjNumber={setSearchJjNumber}
              activeFilterCount={activeFilterCount}
              onClearAll={clearAllFilters}
              onCollapse={() => { logInPage('filter_rail_toggle', 'Collapsed the filter rail'); setRailCollapsed(true); }}
              statusColors={statusColors}
              ingestionStatusCounts={ingestionStatusCounts}
              ingestionStatusColors={ingestionStatusColors}
              logInPage={logInPage}
          />
        ))}

        {activeTab === 'overview' && (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <div className="p-5 flex flex-col gap-3.5 min-h-full">
                {rowsError && <ErrorBanner message={rowsError} onRetry={() => fetchRows(page)} />}
                {chartsError && <ErrorBanner message={`Couldn't load summary/charts: ${chartsError}`} onRetry={() => loadSummaryAndCharts()} />}
                {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
                  <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                    Some cards couldn't load ({Object.keys(cardErrors).length} of 5) - likely an endpoint this backend doesn't serve yet. The rest of the page keeps working; details are in each card.
                  </div>
                )}

                {/* KPI band - responsive grid so cells wrap at narrow widths /
                    high zoom instead of overlapping */}
                <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
                  <div className="bg-white px-5 py-4 flex items-center gap-4 min-w-0">
                    {ingestionStatusMix.segments.length > 0
                      ? <StatusDonut segments={ingestionStatusMix.segments} />
                      : <div className="w-16 h-16 rounded-full border-[9px] border-jj-gray-01 flex-shrink-0" />}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide">Distinct files</div>
                        {canViewSql && ingestionStatusSql && (
                          <button onClick={() => openSqlModal({ title: 'Ingestion status mix', sql: ingestionStatusSql })} className="text-[10px] font-johnson-text text-jj-blue-03 underline">SQL</button>
                        )}
                      </div>
                      <div
                        className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums"
                        title={summary.distinct_file_names != null ? summary.distinct_file_names.toLocaleString() : undefined}
                      >
                        {chartsLoading && summary.distinct_file_names == null ? '…' : summary.distinct_file_names != null ? formatCompact(summary.distinct_file_names) : '—'}
                      </div>
                      {canViewTotals && ingestionStatusMix.ingested ? (
                        <div className="text-[11px] font-johnson-text text-jj-gray-06 mt-1.5">
                          <span className="font-medium" style={{ color: ingestionStatusMix.ingested.color }}>{ingestionStatusMix.ingested.pct}% ingested</span>
                        </div>
                      ) : (
                        <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">unique file names</div>
                      )}
                      {cardErrors.ingestionStatus && !chartsLoading && (
                        <div className="text-[11px] font-johnson-text text-jj-maroon-05 mt-1.5">
                          Ingestion status unavailable · <button onClick={() => loadSummaryAndCharts()} className="underline">retry</button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                    <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Domains covered</div>
                    <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">{chartsLoading && !domainStatusChart.data.length ? '…' : domainStatusChart.data.length}</div>
                    <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">in current filters</div>
                  </div>
                  <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Size ingested so far</div>
                      {canViewSql && summarySql && (
                        <button onClick={() => openSqlModal({ title: 'Size ingested (filtered)', sql: summarySql })} className="text-[10px] font-johnson-text text-jj-blue-03 underline mb-1">SQL</button>
                      )}
                    </div>
                    <div
                      className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums"
                      title={summary.ingested_size_bytes != null ? `${summary.ingested_size_bytes.toLocaleString()} bytes` : undefined}
                    >
                      {chartsLoading && summary.ingested_size_bytes == null ? '…' : summary.ingested_size_bytes != null ? formatBytes(summary.ingested_size_bytes) : '—'}
                    </div>
                    {cardErrors.summary && !chartsLoading ? (
                      <div className="text-[11px] font-johnson-text text-jj-maroon-05 mt-1.5">
                        Summary unavailable · <button onClick={() => loadSummaryAndCharts()} className="underline">retry</button>
                      </div>
                    ) : (
                      <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">
                        {canViewTotals && summary.total_size_bytes != null ? `of ${formatBytes(summary.total_size_bytes)} total` : 'in current filters'}
                      </div>
                    )}
                  </div>
                  {canViewTotals && (
                    <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                      <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Total size</div>
                      <div
                        className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums"
                        title={summary.total_size_bytes != null ? `${summary.total_size_bytes.toLocaleString()} bytes` : undefined}
                      >
                        {chartsLoading && summary.total_size_bytes == null ? '…' : summary.total_size_bytes != null ? formatBytes(summary.total_size_bytes) : '—'}
                      </div>
                      <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">across all documents</div>
                    </div>
                  )}
                </div>

                {/* Charts row - wraps to one column when there isn't room for two */}
                <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))' }}>
                  <Card className="px-5 py-4 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Volume by domain &amp; status</div>
                      {canViewSql && (
                        <button onClick={() => openSqlModal({ title: 'Volume by Domain & Status', sql: domainStatusSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>
                      )}
                    </div>
                    {chartsLoading ? <ChartSkeleton /> : cardErrors.domainStatus ? (
                      <CardUnavailable message={cardErrors.domainStatus} onRetry={() => loadSummaryAndCharts()} />
                    ) : domainStatusChart.data.length ? (
                      <DomainStatusBars data={domainStatusChart.data} statuses={domainStatusChart.statuses} statusColors={statusColors} />
                    ) : <NoData />}
                  </Card>
                  <Card className="px-5 py-4 flex flex-col min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Distinct objects by domain</div>
                      {canViewSql && (
                        <button onClick={() => openSqlModal({ title: 'Distinct Objects by Domain', sql: distinctObjSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>
                      )}
                    </div>
                    <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Unique documents</div>
                    {chartsLoading ? <ChartSkeleton height={170} /> : cardErrors.distinctObj ? (
                      <CardUnavailable message={cardErrors.distinctObj} onRetry={() => loadSummaryAndCharts()} />
                    ) : distinctObjChart.length ? (
                      <ColumnChart data={distinctObjChart} />
                    ) : <NoData />}
                  </Card>
                </div>

                {/* Documents Ingested over time - own full-width row */}
                <Card className="px-5 py-4 flex-shrink-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Documents Ingested over time</div>
                    {canViewSql && (
                      <button onClick={() => openSqlModal({ title: 'Documents Ingested over Time', sql: docsOverTimeSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>
                    )}
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Unique files by hour of ingestion</div>
                  {docsOverTimeLoading ? <ChartSkeleton /> : docsOverTimeChart.length ? (
                    <TrendLine data={docsOverTimeChart} granularity={docsOverTimeGranularity} />
                  ) : <NoData />}
                </Card>

                {/* Therapeutic areas × domain - own full-width row */}
                <Card className="px-5 py-4 flex-shrink-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Volume by therapeutic area &amp; domain</div>
                    {canViewSql && (
                      <button onClick={() => openSqlModal({ title: 'Volume by Therapeutic Area & Domain', sql: taSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>
                    )}
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">Top 15 by record volume{taDomainChart ? ' · stacked by domain' : ''}</div>
                  {chartsLoading ? <ChartSkeleton /> : cardErrors.ta ? (
                    <CardUnavailable message={cardErrors.ta} onRetry={() => loadSummaryAndCharts()} />
                  ) : taDomainChart && taDomainChart.data.length ? (
                    <DomainStatusBars data={taDomainChart.data} statuses={taDomainChart.domains} statusColors={taDomainColors} labelWidth={168} />
                  ) : taChart.length ? (
                    <>
                      <RankedBars data={taChart} />
                      <div className="text-[10.5px] font-johnson-text text-jj-gray-05 mt-3">Per-domain split needs the /chart/therapeutic-area-domain endpoint - this backend doesn't serve it yet, so totals only.</div>
                    </>
                  ) : <NoData />}
                </Card>
              </div>
            </div>
        )}

        {/* ============ DATA TABLE ============ */}
        {activeTab === 'table' && (
          <div className="flex-1 min-w-0 flex flex-col gap-3.5 p-5 overflow-hidden">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => fetchRows(page)} />}
                <div
                  ref={tableCardRef}
                  className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden"
                >
                  <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                    <div className="flex items-center gap-4">
                      <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                        {distinctOnly ? 'Distinct files' : 'Matching records'} <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{totalCount.toLocaleString()}</span>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={distinctOnly}
                          onChange={e => {
                            const next = e.target.checked;
                            logInPage('distinct_toggle', `${next ? 'Enabled' : 'Disabled'} distinct-files-only view`);
                            setDistinctOnly(next);
                          }}
                          className="accent-[#0f68b2]"
                        />
                        One row per file
                      </label>
                    </div>
                    <div className="flex items-center gap-3.5">
                      {canViewSql && (
                        <button onClick={() => openSqlModal({ title: 'Data table (current page)', sql: rowsSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                      )}
                      {canDownload && (<>
                      <button
                        onClick={downloadCsv}
                        disabled={rowsLoading || tableRows.length === 0}
                        className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                        title="Downloads the current page only"
                      >
                        <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                        Download page
                      </button>
                      <button
                        onClick={downloadAllCsv}
                        disabled={rowsLoading || totalCount === 0}
                        className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                        title="Streams every matching row as CSV - no row cap"
                      >
                        <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                        Download all ({totalCount.toLocaleString()})
                      </button>
                      </>)}
                      <button
                        onClick={toggleTableFullscreen}
                        className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                        title={isFullscreen ? 'Exit full screen' : 'View the table full screen'}
                      >
                        {isFullscreen ? '⤳ Exit full screen' : '⛶ Full screen'}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 relative">
                    {rowsLoading && (
                      <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                        <LoadingSpinner />
                      </div>
                    )}
                    <div ref={setDataScrollRef} className="h-full overflow-auto">
                      <table className="text-xs font-johnson-text" style={{ tableLayout: 'fixed', width: Math.max(visibleCols.reduce((sum, c) => sum + getColWidth(c), 0), dataScrollWidth) }}>
                        <colgroup>
                          {visibleCols.map((col, i) => {
                            const extra = i === visibleCols.length - 1 ? Math.max(0, dataScrollWidth - visibleCols.reduce((sum, c) => sum + getColWidth(c), 0)) : 0;
                            return <col key={col} style={{ width: getColWidth(col) + extra }} />;
                          })}
                        </colgroup>
                        <thead className="sticky top-0 z-[5]">
                          <tr className="bg-[#faf9f8]">
                            {visibleCols.map(col => (
                              <th
                                key={col}
                                onClick={() => handleSort(col)}
                                className="relative px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 cursor-pointer select-none whitespace-nowrap overflow-hidden hover:bg-jj-gray-02 border-b border-r border-jj-gray-02"
                              >
                                {col}{sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : ''}
                                <div
                                  onClick={e => e.stopPropagation()}
                                  onMouseDown={e => startColResize(e, col, getColWidth, setColWidths)}
                                  onDoubleClick={e => autoFitColumn(e, col, tableRows.map(r => cellText(r[col])), setColWidths)}
                                  title="Drag to resize · double-click to fit"
                                  className="absolute top-0 right-0 h-full w-[7px] cursor-col-resize hover:bg-jj-blue-03/30"
                                />
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.map((r, idx) => (
                            <tr
                              key={`${page}-${idx}-${r.OBJ_ID || ''}-${r.R_VERSION_LABEL || ''}`}
                              onClick={() => {
                                logInPage('row_detail_view', `Opened record detail for ${r.FILE_NAME || r.OBJ_ID || 'row ' + idx}`);
                                setDetailRecord(r);
                              }}
                              className="hover:bg-jj-blue-03/5 cursor-pointer"
                            >
                              {visibleCols.map(col => (
                                <td key={col} className={`px-3 py-2.5 truncate border-b border-r border-jj-gray-01 ${col === 'FILE_NAME' ? 'font-medium text-jj-gray-08' : 'text-jj-gray-07'}`}>
                                  {col === 'A_STATUS' && r[col]
                                    ? <StatusPill value={String(r[col])} />
                                    : (r[col] === null || r[col] === undefined || r[col] === '' ? <span className="text-jj-gray-04">—</span> : cellDisplayText(r[col]))}
                                </td>
                              ))}
                            </tr>
                          ))}
                          {!rowsLoading && !rowsError && tableRows.length === 0 && (
                            <tr>
                              <td colSpan={visibleCols.length || 1} className="px-3 py-8 text-center text-jj-gray-06">
                                No rows match the current filters.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Pagination */}
                  <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                    <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                      <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                      {totalCount.toLocaleString()} rows
                      <select
                        value={pageSize}
                        onChange={e => { logInPage('page_size_change', `Changed data table page size to ${e.target.value}`); setPageSize(Number(e.target.value)); }}
                        disabled={rowsLoading}
                        className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                      >
                        {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                      </select>
                    </div>
                    <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={goToPage} />
                  </div>
                </div>
          </div>
        )}

        {/* ============ DOMAIN BREAKDOWN ============ */}
        {activeTab === 'breakdown' && (
          <div className="flex-1 min-w-0 flex gap-3.5 p-5 overflow-hidden">
            <Card className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div>
                  <div className="text-[13.5px] font-johnson-text font-bold text-jj-gray-08">Domain breakdown</div>
                  <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-0.5">
                    {breakdownGrouping === 'ta' ? 'Therapeutic area → Domain → Artifact' : 'Domain → Therapeutic area → Artifact'} · unique documents · follows your filters
                  </div>
                </div>
                <div className="flex items-center gap-3.5 flex-shrink-0">
                  {canDownload && (
                  <button onClick={downloadBreakdownCsv} disabled={breakdownRows.length === 0} className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01">
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Export
                  </button>
                  )}
                  {canViewSql && (
                    <button onClick={() => openSqlModal({ title: 'Domain Breakdown', sql: breakdownSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 flex items-center gap-2 px-[18px] py-2.5 border-b border-jj-gray-01">
                <div className="relative flex-1 max-w-[300px]">
                  <Icon src={searchIcon} tint="gray" className="w-3 h-3 absolute left-2.5 top-[9px]" />
                  <input
                    value={breakdownSearch}
                    onChange={e => setBreakdownSearch(e.target.value)}
                    placeholder="Search domain, area, or artifact…"
                    className="w-full pl-8 pr-2 py-[7px] text-xs font-johnson-text rounded-lg border border-jj-gray-03 bg-[#faf9f8] focus:outline-none focus:border-jj-blue-03 focus:bg-white"
                  />
                </div>
                <button
                  onClick={toggleBreakdownGrouping}
                  className="px-3.5 py-[7px] rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                  title="Swap which column nests the other"
                >
                  Group by: {breakdownGrouping === 'ta' ? 'Therapeutic area' : 'Domain'}
                </button>
                <button
                  onClick={expandAllBreakdown}
                  disabled={searching}
                  className="px-3.5 py-[7px] rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                >
                  Expand all
                </button>
                <button
                  onClick={collapseAllBreakdown}
                  disabled={searching}
                  className="px-3.5 py-[7px] rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                >
                  Collapse all
                </button>
                <span className="ml-auto text-[11px] font-johnson-text text-jj-gray-06 hidden lg:block">Hover a row for "View docs" · click a row to expand</span>
              </div>

              <div className="flex-1 min-h-0 relative">
                {breakdownLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  {breakdownError && (
                    <div className="p-4">
                      <ErrorBanner message={breakdownError} onRetry={() => loadBreakdown()} />
                    </div>
                  )}
                  {!breakdownLoading && !breakdownError && breakdownRows.length === 0 && (
                    <div className="px-3 py-8 text-center text-jj-gray-06 text-xs font-johnson-text">No data.</div>
                  )}
                  {!breakdownError && breakdownRows.length > 0 && (
                    <BreakdownTree
                      tree={filteredBreakdownTree}
                      onDrillDown={drillDownFromBreakdown}
                      expandedDomains={effectiveExpandedDomains}
                      expandedTAs={effectiveExpandedTAs}
                      toggleDomain={toggleDomain}
                      toggleTA={toggleTA}
                    />
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 px-[18px] py-2.5 border-t border-jj-gray-01 text-[11px] font-johnson-text text-jj-gray-06">
                Search auto-expands matching branches · manual expand state resumes when cleared
              </div>
            </Card>

            <Card className="w-[320px] flex-shrink-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13.5px] font-johnson-text font-bold text-jj-gray-08">Top artifacts overall</div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-0.5">Unique documents across current filters</div>
              </div>
              <div className="flex-1 overflow-y-auto px-[18px] py-3.5 flex flex-col gap-[11px]">
                {breakdownLoading && <ChartSkeleton height={200} />}
                {!breakdownLoading && topArtifacts.map((a) => (
                  <div key={a.label} title={`${a.label}: ${a.count.toLocaleString()}`}>
                    <div className="flex justify-between text-[11.5px] font-johnson-text mb-[3px]">
                      <span className="text-jj-gray-08 truncate pr-2" title={a.label}>{a.label}</span>
                      <span className="tabular-nums flex-shrink-0 text-jj-gray-08">{formatCompact(a.count)}</span>
                    </div>
                    <div className="h-2 rounded-[3px] bg-jj-gray-01">
                      <div className="h-full rounded-[3px] bg-jj-gray-08" style={{ width: `${(a.count / (topArtifacts[0]?.count || 1)) * 100}%` }} />
                    </div>
                  </div>
                ))}
                {!breakdownLoading && topArtifacts.length === 0 && <NoData />}
              </div>
            </Card>
          </div>
        )}

      </div>
      )}
      </Suspense>

      <DetailModal record={detailRecord} onClose={() => setDetailRecord(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}