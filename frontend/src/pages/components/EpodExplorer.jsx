import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRBAC } from '../../context/RBACContext';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";

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

// Self-contained explorer: this
// file owns its own small copies of the generic UI primitives it needs
// (Icon, Card, Pager, DetailModal, the dependency-free charts, etc.) rather
// than importing them from Unstructured.jsx, so it can be dropped into any
// page. It relies on the SVG tint filters (#jj-red-tint etc.) that
// Unstructured.jsx's <IconDefs /> already renders once at the page level.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

const FALLBACK_COLORS = ["#ff6017", "#8c3bbb", "#004685", "#9e0000", "#3b5a0d"];

/* ============================== shared helpers (mirrors Unstructured.jsx) ============================== */

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

function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function formatCompact(n) {
  if (n == null || isNaN(n)) return n;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatEasternTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) + ' ET';
}

function formatTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatEasternTimestamp(ts);
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

/* ============================== dependency-free charts (mirrors Unstructured.jsx) ============================== */

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

function StatusDonut({ segments, headerLabel = 'Breakdown', size = 132, centerLabel }) {
  const tip = useChartTip();
  const stroke = 14, R = (size - stroke) / 2, C = 2 * Math.PI * R, mid = size / 2;
  const total = segments.reduce((a, s) => a + s.count, 0);
  const tipRows = [
    { label: headerLabel, header: true },
    ...segments.map(s => ({ label: s.status, value: s.count, color: s.color })),
    { label: 'Total', value: total },
  ];
  let offset = 0;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={mid} cy={mid} r={R} fill="none" stroke="#f1efed" strokeWidth={stroke} />
        {segments.map((s, i) => {
          const dash = s.frac * C;
          const el = (
            <circle key={i} cx={mid} cy={mid} r={R} fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, dash - 2)} ${C}`} strokeDashoffset={-offset}
              onMouseMove={(e) => tip.show(e, tipRows)}
              onMouseLeave={tip.hide}
            />
          );
          offset += dash;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="font-johnson-display font-bold text-[22px] leading-none text-jj-gray-08 tabular-nums">{formatCompact(total)}</span>
        {centerLabel && <span className="text-[10px] font-johnson-text uppercase tracking-[.12em] text-jj-gray-05 mt-1">{centerLabel}</span>}
      </div>
      {tip.node}
    </div>
  );
}

// Horizontal ranked bars. `format` controls how values print (counts by default, bytes for sizes).
function Bars({ data, format = formatCompact, unit = "Chunks" }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d, i) => (
        <div
          key={`${d.area}-${i}`}
          className="cursor-default rounded px-1 -mx-1 py-0.5 hover:bg-jj-gray-01/60"
          onMouseMove={(e) => tip.show(e, [{ label: d.area, header: true }, { label: unit, value: format(d.count), color: "#0f68b2" }])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between gap-3 text-[11.5px] font-johnson-text mb-1">
            <span className="text-jj-gray-08 truncate">{d.area}</span>
            <span className="text-jj-gray-08 font-medium tabular-nums flex-shrink-0">{format(d.count)}</span>
          </div>
          <div className="h-[8px] rounded-full bg-jj-gray-01">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (d.count / max) * 100)}%`, background: "linear-gradient(90deg,#0f68b2,#004685)" }} />
          </div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

function periodLabel(iso, granularity) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  if (granularity === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (granularity === 'hour') {
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' })}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

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

/* ============================== filter rail ============================== */

function epodFacetValueLabel(column, value) {
  if (value === null || value === undefined) return '(blank)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function EpodFacetGroup({ label, column, selected, onChange, options, loading }) {
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
                    {epodFacetValueLabel(column, value)}
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


/* ============================== EPOD tab ============================== */
// Two sub-tabs backed by /api/epod/*: Explore (headline numbers, composition,
// activity, notable documents) and Data table (filter rail plus a paged grid).

const CHUNK_LEVEL_COLORS = { section: "#0f68b2", split: "#ff6017", page: "#328714" };
const INGESTION_STATUS_COLORS = { SUCCESS: "#328714", FAILED: "#eb1700", ERROR: "#eb1700", PENDING: "#0f68b2", RETRY: "#8c3bbb" };

// 45900 -> "44.8 KB", 1250000000 -> "1.16 GB" - file_size is bytes.
function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let val = Math.abs(n);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  const sign = n < 0 ? "-" : "";
  return `${sign}${val.toFixed(i === 0 ? 0 : 2).replace(/\.00$/, "")} ${units[i]}`;
}

function EpodLevelPill({ value }) {
  const color = CHUNK_LEVEL_COLORS[String(value || "").toLowerCase()] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unspecified"}
    </span>
  );
}

function IngestionStatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = INGESTION_STATUS_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

// Same ranked-bars visual as RankedBars, but labeled/tooltipped in bytes -
// for the largest-documents-by-file-size card, where formatCompact's plain
// number would read as a meaningless raw byte count.
function formatContentTypes(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.map(v => String(v).charAt(0).toUpperCase() + String(v).slice(1)).join(", ");
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadClientCsv(filename, columns, rows) {
  const lines = [columns.map(csvEscape).join(",")];
  rows.forEach(r => lines.push(columns.map(c => csvEscape(r[c])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Every column /api/epod/data returns, in table order. The API has always
// sent all of these - the grid just used to render ten of them. chunk_text
// and content_types carry no sortCol because ordering a text body or a
// text[] server-side isn't meaningful.
const EPOD_TABLE_COLUMNS = [
  { key: "file_name", label: "File name", sortCol: "file_name", bold: true, minWidth: 230 },
  { key: "doc_id", label: "Doc ID", sortCol: "doc_id", minWidth: 150 },
  { key: "chunk_id", label: "Chunk ID", sortCol: "chunk_id", minWidth: 150 },
  { key: "file_path", label: "File path", sortCol: "file_path", minWidth: 300 },
  { key: "section_title", label: "Section", sortCol: "section_title", minWidth: 220 },
  { key: "chunk_level", label: "Level", sortCol: "chunk_level", minWidth: 110 },
  { key: "chunk_index", label: "Chunk #", sortCol: "chunk_index", minWidth: 90 },
  { key: "chunk_total", label: "Chunks in doc", sortCol: "chunk_total", minWidth: 120 },
  { key: "page_start", label: "Page start", sortCol: "page_start", minWidth: 100 },
  { key: "page_end", label: "Page end", sortCol: "page_end", minWidth: 100 },
  { key: "content_types", label: "Content", minWidth: 150 },
  { key: "chunk_text", label: "Preview", minWidth: 340 },
  { key: "chunk_vector", label: "Embedding", minWidth: 150 },
  { key: "created_at", label: "Created", sortCol: "created_at", minWidth: 170 },
  { key: "updated_at", label: "Updated", sortCol: "updated_at", minWidth: 170 },
  // ingestion_log columns - null on datasets with no log table.
  { key: "ingestion_status", label: "Ingestion", sortCol: "ingestion_status", minWidth: 130 },
  { key: "ingestion_error_message", label: "Ingestion error", sortCol: "ingestion_error_message", minWidth: 260 },
  { key: "retry_count", label: "Retries", sortCol: "retry_count", minWidth: 90 },
  { key: "doc_file_size", label: "Doc size", sortCol: "doc_file_size", minWidth: 100 },
  { key: "doc_file_hash", label: "Doc hash", sortCol: "doc_file_hash", minWidth: 200 },
  { key: "doc_last_modified", label: "Doc modified", sortCol: "doc_last_modified", minWidth: 170 },
  { key: "doc_ingested_at", label: "Ingested", sortCol: "doc_ingested_at", minWidth: 170 },
  { key: "doc_log_updated_at", label: "Log updated", sortCol: "doc_log_updated_at", minWidth: 170 },
  { key: "log_chunk_count", label: "Log chunks", sortCol: "log_chunk_count", minWidth: 110 },
  { key: "log_pages_total", label: "Log pages", sortCol: "log_pages_total", minWidth: 110 },
];

// Text searches on the data table. `param` is the API query name; logOnly
// ones need the ingestion log, so they hide on datasets that don't have it.
const SEARCH_FIELDS = [
  { key: "file_name", param: "search_file_name", ph: "File name contains…" },
  { key: "section_title", param: "search_section_title", ph: "Section title contains…" },
  { key: "chunk_text", param: "search_chunk_text", ph: "Chunk text contains…" },
  { key: "doc_id", param: "search_doc_id", ph: "Doc ID contains…" },
  { key: "chunk_id", param: "search_chunk_id", ph: "Chunk ID contains…" },
  { key: "file_path", param: "search_file_path", ph: "File path contains…" },
  { key: "ingestion_error", param: "search_ingestion_error_message", ph: "Ingestion error contains…", logOnly: true },
];
const EMPTY_SEARCH = Object.fromEntries(SEARCH_FIELDS.map(f => [f.key, ""]));

const FACETS = [
  { column: "chunk_level", label: "Chunk level" },
  { column: "content_types", label: "Content types" },
  { column: "ingestion_status", label: "Ingestion status", logOnly: true },
  { column: "retry_count", label: "Retry count", logOnly: true },
];

const TIMESTAMP_COLUMNS = ["created_at", "updated_at", "doc_last_modified", "doc_ingested_at", "doc_log_updated_at"];

const PAGE_CSV_COLUMNS = [
  "chunk_id", "doc_id", "file_name", "file_path", "chunk_index", "chunk_total", "chunk_level",
  "section_title", "page_start", "page_end", "content_types", "chunk_text",
  "chunk_vector_dims", "chunk_vector_preview", "created_at", "updated_at",
  "doc_file_size", "doc_file_hash", "doc_last_modified", "doc_ingested_at", "doc_log_updated_at",
  "ingestion_status", "ingestion_error_message", "retry_count", "log_chunk_count", "log_pages_total",
];

// "Mar 1, 2026" / "12:54 PM ET" / "3 days ago" for the Last updated tile.
const formatDay = (ts) => new Date(ts).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
const formatClock = (ts) => new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
function daysAgo(ts) {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d <= 0) return formatTimeAgo(new Date(ts).getTime());
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

function cellFor(row, col) {
  if (TIMESTAMP_COLUMNS.includes(col)) return row[col] ? formatEasternTimestamp(row[col]) : "—";
  switch (col) {
    case "content_types": return formatContentTypes(row.content_types) || "—";
    case "doc_file_size": return row.doc_file_size != null ? formatBytes(row.doc_file_size) : "—";
    // The raw vector never leaves the server, just its size and a short prefix.
    case "chunk_vector": return row.chunk_vector_dims != null ? `${Number(row.chunk_vector_dims).toLocaleString()}-dim` : "—";
    default: {
      const v = row[col];
      // 0 is a real value for retries / chunk index / pages.
      return v === null || v === undefined || v === "" ? "—" : String(v);
    }
  }
}

const EXPLORE_SOURCE_COUNT = 7; // summary + 6 charts loaded by loadExplore

// Turns { label: count } rows into donut segments, biggest first.
function toSegments(rows, keyOf, palette) {
  const sum = rows.reduce((a, r) => a + (r.count || 0), 0);
  if (!sum) return [];
  let fallback = 0;
  return [...rows].sort((a, b) => b.count - a.count).map(r => {
    const name = keyOf(r);
    return {
      status: name,
      color: palette[String(name || "").toLowerCase()] || palette[String(name || "").toUpperCase()] || FALLBACK_COLORS[fallback++ % FALLBACK_COLORS.length],
      frac: r.count / sum,
      count: r.count,
    };
  });
}

/* ---------- small layout pieces for the Explore tab ---------- */

function SectionHead({ title, sub, right }) {
  return (
    <div className="flex items-end justify-between gap-3 mt-2">
      <div className="min-w-0">
        <h2 className="font-johnson-display font-bold text-[17px] leading-tight text-jj-gray-08">{title}</h2>
        {sub && <p className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="flex bg-white border border-jj-gray-02 shadow-[0_1px_2px_rgba(49,44,42,.06)] rounded-full p-[3px] gap-0.5 flex-shrink-0">
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          disabled={o.disabled}
          title={o.disabled ? o.disabledHint : undefined}
          className={`px-3.5 py-[5px] rounded-full text-[11.5px] font-johnson-text transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            value === o.id ? "bg-jj-red/[.08] text-jj-red font-medium" : "text-jj-gray-07 hover:text-jj-gray-08"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub, accent, loading }) {
  return (
    <div className="relative bg-white px-5 py-[18px] min-w-0 overflow-hidden">
      <span className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r" style={{ background: accent }} />
      <div className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.12em] text-jj-gray-06">{label}</div>
      <div className={`mt-2 font-johnson-display font-bold text-jj-gray-08 tabular-nums truncate text-[30px] leading-none`}>
        {loading ? "…" : value}
      </div>
      <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-2 truncate">{sub}</div>
    </div>
  );
}

function DonutCard({ title, sub, segments, loading, error, onRetry, headerLabel, centerLabel }) {
  return (
    <Card className="px-5 py-4 min-w-0 flex flex-col">
      <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">{title}</div>
      <div className="text-[11px] font-johnson-text text-jj-gray-05 mb-4">{sub}</div>
      {loading ? <ChartSkeleton height={140} /> : error ? (
        <CardUnavailable message={error} onRetry={onRetry} />
      ) : segments.length ? (
        <div className="flex-1 flex items-center gap-8 px-2">
          <StatusDonut segments={segments} headerLabel={headerLabel} centerLabel={centerLabel} />
          <div className="flex-1 min-w-0 flex flex-col gap-3.5">
            {segments.map(s => (
              <div key={s.status} className="min-w-0">
                <div className="flex items-baseline gap-2 text-[12px] font-johnson-text">
                  <span className="w-2 h-2 rounded-[2px] flex-shrink-0 self-center" style={{ background: s.color }} />
                  <span className="text-jj-gray-08 font-medium truncate flex-1 capitalize">{String(s.status).toLowerCase()}</span>
                  <span className="text-jj-gray-08 font-medium tabular-nums">{formatCompact(s.count)}</span>
                  <span className="text-jj-gray-05 tabular-nums w-10 text-right">{Math.round(s.frac * 100)}%</span>
                </div>
                <div className="h-[5px] rounded-full bg-jj-gray-01 mt-1.5 ml-4">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(2, s.frac * 100)}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : <NoData />}
    </Card>
  );
}

export default function EpodExplorer({ logInPage, activeTab, onBusyChange, dataset }) {
  const canDownload = useRBAC().hasPermission("downloadUnstructuredData");

  /* ---------- Explore ---------- */
  const [summary, setSummary] = useState(null);
  const [charts, setCharts] = useState({});
  const [chartsLoading, setChartsLoading] = useState(true);
  const [cardErrors, setCardErrors] = useState({});
  const [trendView, setTrendView] = useState("chunks");
  const [docsView, setDocsView] = useState("chunks");

  // Every call carries the selected dataset; without one the backend uses its default.
  const dsQuery = useCallback((extra) => {
    const params = new URLSearchParams(extra || {});
    if (dataset) params.set("dataset", dataset);
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [dataset]);

  const exploreSeq = useRef(0);
  const exploreAbort = useRef(null);
  const loadExplore = useCallback(() => {
    const sources = {
      summary: `/api/epod/summary${dsQuery()}`,
      level: `/api/epod/charts/chunk-level${dsQuery()}`,
      types: `/api/epod/charts/content-types${dsQuery()}`,
      topDocs: `/api/epod/charts/top-documents${dsQuery({ limit: 10 })}`,
      largest: `/api/epod/charts/largest-documents${dsQuery({ limit: 10 })}`,
      chunkTrend: `/api/epod/charts/chunks-over-time${dsQuery()}`,
      docTrend: `/api/epod/charts/ingestion-volume-over-time${dsQuery()}`,
    };
    const keys = Object.keys(sources);
    // Switching dataset while the last one is still loading: only the newest load may paint.
    const seq = ++exploreSeq.current;
    // Cancelled on leave / dataset switch so it stops holding browser connections.
    exploreAbort.current?.abort();
    const ctl = new AbortController();
    exploreAbort.current = ctl;
    setChartsLoading(true);
    Promise.allSettled(keys.map(k => fetchJson(`${API_BASE_URL}${sources[k]}`, { signal: ctl.signal }))).then(results => {
      if (seq !== exploreSeq.current || ctl.signal.aborted) return;
      const next = {};
      const errors = {};
      results.forEach((r, i) => {
        const k = keys[i];
        if (r.status === "rejected") errors[k] = r.reason?.message || "Couldn't load this card";
        else if (k === "summary") setSummary(r.value);
        else next[k] = r.value.rows || [];
      });
      setCharts(next);
      setCardErrors(errors);
      setChartsLoading(false);
    });
  }, [dsQuery]);

  useEffect(() => { loadExplore(); return () => exploreAbort.current?.abort(); }, [loadExplore]);

  const hasLog = summary?.has_log !== false;
  // Fall back to the views that always exist when a dataset has no log table.
  const trendShown = hasLog ? trendView : "chunks";
  const docsShown = hasLog ? docsView : "chunks";

  const levelSegments = useMemo(() => toSegments(charts.level || [], r => r.chunk_level, CHUNK_LEVEL_COLORS), [charts.level]);
  const typeBars = useMemo(() => (charts.types || []).map(r => ({ area: formatContentTypes([r.content_type]) || "(none)", count: r.count })), [charts.types]);
  const docBars = useMemo(() => (docsShown === "chunks"
    ? (charts.topDocs || []).map(r => ({ area: r.file_name, count: r.count }))
    : (charts.largest || []).map(r => ({ area: r.file_name, count: r.file_size }))
  ), [charts.topDocs, charts.largest, docsShown]);
  const trendPoints = useMemo(() => (charts[trendShown === "chunks" ? "chunkTrend" : "docTrend"] || [])
    .map(r => ({ period: r.period, count: r.count })), [charts, trendShown]);

  const kpiLoading = chartsLoading && !summary;
  const failedCards = Object.keys(cardErrors).length;

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState(EMPTY_SEARCH);
  const debouncedSearch = useDebounced(search);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("file_name");
  const [sortDir, setSortDir] = useState("asc");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);
  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Full screen for the table card only. Following fullscreenchange keeps the
  // button label right when someone leaves with Esc.
  const tableCardRef = useRef(null);
  const [tableFullscreen, setTableFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setTableFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleTableFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else tableCardRef.current?.requestFullscreen?.();
  };

  const filtersParam = useMemo(() => Object.entries(filters)
    .filter(([, vals]) => vals && vals.length > 0)
    .map(([col, vals]) => `${col}:${vals.join("||")}`)
    .join(","), [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);
  const activeSearchCount = Object.values(search).filter(v => v.trim()).length;

  useEffect(() => { setPage(1); }, [filtersParam, debouncedSearch, pageSize]);

  // Facet values differ per dataset, so start clean when it changes.
  useEffect(() => {
    setFilters({});
    setSearch(EMPTY_SEARCH);
    setPage(1);
  }, [dataset]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (dataset) params.set("dataset", dataset);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/epod/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam, dataset]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    SEARCH_FIELDS.forEach(f => { if (debouncedSearch[f.key]) params.set(f.param, debouncedSearch[f.key]); });
    if (dataset) params.set("dataset", dataset);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedSearch, dataset, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/epod/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Couldn't load EPOD chunks");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize, reloadTick]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const clearAll = () => { setFilters({}); setSearch(EMPTY_SEARCH); };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of EPOD chunks`);
    downloadClientCsv(`epod_${dataset || "default"}_page.csv`, PAGE_CSV_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching EPOD chunks`);
    try {
      await downloadFile(`/api/epod/data/download?${buildDataQuery().toString()}`, "epod_data.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const pillBtn = "flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ EXPLORE ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-4 max-w-[1600px] w-full mx-auto">
            {failedCards > 0 && !chartsLoading && (
              <ErrorBanner
                message={failedCards === EXPLORE_SOURCE_COUNT ? "Couldn't load the EPOD overview." : `${failedCards} of ${EXPLORE_SOURCE_COUNT} cards couldn't load.`}
                onRetry={loadExplore}
              />
            )}
            {!chartsLoading && !hasLog && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-jj-gray-02 text-[12px] font-johnson-text text-jj-gray-07">
                <Icon src={infoIcon} tint="gray" className="w-3.5 h-3.5 flex-shrink-0" />
                This dataset has no ingestion history, so pages, documents per day and file sizes aren't available.
              </div>
            )}

            {/* Headline numbers */}
            <div
              className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[16px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}
            >
              <Kpi
                label="Documents" accent="#eb1700" loading={kpiLoading}
                value={summary ? formatCompact(summary.distinct_documents) : "—"}
                sub={summary ? `${formatCompact(summary.distinct_files)} distinct files` : "unique documents"}
              />
              <Kpi
                label="Avg chunks / doc" accent="#0f68b2" loading={kpiLoading}
                value={summary ? summary.avg_chunks_per_doc : "—"}
                sub="how finely each document is split"
              />
              <Kpi
                label="Avg pages / doc" accent="#328714" loading={kpiLoading}
                value={summary?.avg_pages_per_doc ?? "—"}
                sub={hasLog ? "pages per source document" : "needs ingestion history"}
              />
              <Kpi
                label="Last updated" accent="#8c3bbb" loading={kpiLoading}
                value={summary?.last_updated ? formatDay(summary.last_updated) : "—"}
                sub={summary?.last_updated ? `${formatClock(summary.last_updated)} · ${daysAgo(summary.last_updated)}` : "most recent change"}
              />
            </div>

            {/* What the corpus is made of */}
            <SectionHead title="Composition" sub="How the documents break down into chunks and content" />
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
              <DonutCard
                title="Chunk levels" sub="Section, split and page chunks" headerLabel="Chunk level" centerLabel="chunks"
                segments={levelSegments} loading={chartsLoading} error={cardErrors.level} onRetry={loadExplore}
              />
              <Card className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Content types</div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mb-4">Chunks containing each type</div>
                {chartsLoading ? <ChartSkeleton height={120} /> : cardErrors.types ? (
                  <CardUnavailable message={cardErrors.types} onRetry={loadExplore} />
                ) : typeBars.length ? <Bars data={typeBars} /> : <NoData />}
              </Card>
            </div>

            {/* Activity over time */}
            <SectionHead
              title="Activity"
              sub={trendShown === "chunks" ? "Chunks created per day" : "Documents ingested per day"}
              right={(
                <Segmented
                  value={trendShown}
                  onChange={setTrendView}
                  options={[
                    { id: "chunks", label: "Chunks" },
                    { id: "docs", label: "Documents", disabled: !hasLog, disabledHint: "Needs ingestion history" },
                  ]}
                />
              )}
            />
            <Card className="px-5 py-4">
              {chartsLoading ? <ChartSkeleton /> : cardErrors[trendShown === "chunks" ? "chunkTrend" : "docTrend"] ? (
                <CardUnavailable message={cardErrors[trendShown === "chunks" ? "chunkTrend" : "docTrend"]} onRetry={loadExplore} />
              ) : trendPoints.length ? <TrendLine data={trendPoints} granularity="day" /> : <NoData />}
            </Card>

            {/* Notable documents */}
            <SectionHead
              title="Documents"
              sub={docsShown === "chunks" ? "Top 10 by number of chunks" : "Top 10 by file size"}
              right={(
                <Segmented
                  value={docsShown}
                  onChange={setDocsView}
                  options={[
                    { id: "chunks", label: "Most chunks" },
                    { id: "size", label: "Largest files", disabled: !hasLog, disabledHint: "Needs ingestion history" },
                  ]}
                />
              )}
            />
            <Card className="px-5 py-4 mb-2">
              {chartsLoading ? <ChartSkeleton height={200} /> : cardErrors[docsShown === "chunks" ? "topDocs" : "largest"] ? (
                <CardUnavailable message={cardErrors[docsShown === "chunks" ? "topDocs" : "largest"]} onRetry={loadExplore} />
              ) : docBars.length ? (
                <Bars data={docBars} format={docsShown === "size" ? formatBytes : formatCompact} unit={docsShown === "size" ? "Size" : "Chunks"} />
              ) : <NoData />}
            </Card>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[260px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col min-h-0">
            <div className="px-[18px] py-3.5 flex items-center justify-between border-b border-jj-gray-02 flex-shrink-0">
              <span className="flex items-center gap-2 text-[12.5px] font-johnson-text font-bold text-jj-gray-08">
                Refine
                {activeFilterCount + activeSearchCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount + activeSearchCount}
                  </span>
                )}
              </span>
              <button
                onClick={clearAll}
                disabled={activeFilterCount + activeSearchCount === 0}
                className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40"
              >
                Clear all
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SearchSection>
                {SEARCH_FIELDS.filter(f => hasLog || !f.logOnly).map(f => (
                  <input
                    key={f.key}
                    value={search[f.key]}
                    onChange={e => setSearch(s => ({ ...s, [f.key]: e.target.value }))}
                    placeholder={f.ph}
                    className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                ))}
              </SearchSection>
              {FACETS.filter(f => hasLog || !f.logOnly).map(f => (
                <EpodFacetGroup
                  key={f.column}
                  label={f.label}
                  column={f.column}
                  selected={filters[f.column] || []}
                  onChange={vals => setFilters(prev => ({ ...prev, [f.column]: vals }))}
                  options={facets[f.column] || []}
                  loading={facetsLoading}
                />
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden p-5 gap-3">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setReloadTick(t => t + 1)} />}
            <div ref={tableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between gap-3 px-[18px] py-3 border-b border-jj-gray-01 flex-wrap">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Chunks <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()} matching</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {canDownload && (
                    <>
                      <button onClick={downloadPageCsv} disabled={rowsLoading || rows.length === 0} className={pillBtn} title="Downloads the current page only">
                        <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                        Download page
                      </button>
                      <button onClick={downloadAllCsv} disabled={rowsLoading || downloadingAll || total === 0} className={pillBtn} title="Every matching row as CSV">
                        <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                        {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                      </button>
                    </>
                  )}
                  <button onClick={toggleTableFullscreen} className={pillBtn} title={tableFullscreen ? "Exit full screen" : "View the table full screen"}>
                    {tableFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {EPOD_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer hover:text-jj-gray-08" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={row.chunk_id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened EPOD chunk detail for ${row.file_name || row.chunk_id || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {EPOD_TABLE_COLUMNS.map(col => {
                            const text = cellFor(row, col.key);
                            return (
                              <td
                                key={col.key}
                                style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                                className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                                title={col.key === "chunk_vector" ? (row.chunk_vector_preview || undefined) : text}
                              >
                                {col.key === "chunk_level" && row.chunk_level ? <EpodLevelPill value={row.chunk_level} />
                                  : col.key === "ingestion_status" && row.ingestion_status ? <IngestionStatusPill value={row.ingestion_status} />
                                  : text}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={EPOD_TABLE_COLUMNS.length} className="px-3 py-10 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load chunks." : "No chunks match the current filters."}
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
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}