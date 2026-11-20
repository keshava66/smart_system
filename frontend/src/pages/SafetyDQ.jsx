import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import chevronRight  from "/icons/JJ_Icon_Chevron_Right.svg";
import recordsSrc    from "/icons/JJ_Icon_Unfold_All_More.svg";
import closeSrc      from "/icons/JJ_Icon_Close.svg";
import refreshSrc    from "/icons/JJ_Icon_Refresh_RGB.svg";
import backgroundSrc from "/background.png";
import logoSrc       from "/sh_logo_jj.png";

import { apiFetch } from '../utils/apiClient';

// Safety tab in DQE. Same look as the BDC executive view.
// Data comes from backend/safety_dq_data.xlsx through /dq/safety/data (see safety_dq.py).
// Edit the Excel file and the page updates on Refresh, or by itself within 30s.

const POLL_MS = 30000;

/* ── helpers ── */

const TARGET = 95;
const FLOOR = 80;

const F = {
  red:    'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)',
  gray06: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)',
};

const Ic = ({ src, className = 'w-4 h-4', filter = F.gray06 }) => (
  <img src={src} alt="" className={className} style={{ filter, flexShrink: 0 }} />
);

const BANDS = [
  { color: '#328714', label: `${TARGET}%+` },
  { color: '#e06c00', label: `${FLOOR}-${TARGET - 0.1}%` },
  { color: '#eb1700', label: `Below ${FLOOR}%` },
];

const passColor = (p) =>
  p == null ? '#a39992' : p >= TARGET ? '#328714' : p >= FLOOR ? '#e06c00' : '#eb1700';

const parseDate = (v) => {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const monthLabel = (v) => {
  const d = parseDate(v);
  return d ? d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : String(v ?? '—');
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clamp = (v) => Math.max(0, Math.min(100, v));
const pctText = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Dimension column from the Excel file, else pulled from a title like "12S_DQR_Timeliness_v2"
const dimensionOf = (r) => {
  if (r.dimension) return String(r.dimension).trim().charAt(0).toUpperCase() + String(r.dimension).trim().slice(1);
  const parts = String(r.rule_title || r.rule_type || r.rule_id || '').split('_').filter(Boolean);
  while (parts.length > 1 && /^v\d+$/i.test(parts[parts.length - 1])) parts.pop();
  const w = parts[parts.length - 1] || '';
  if (!w || /^v\d+$/i.test(w)) return 'Unclassified';
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const avgOf = (list, dp = 0) => {
  const vals = list.map((r) => num(r.pass_percentage)).filter((n) => n !== null);
  const k = 10 ** dp;
  return vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * k) / k : null;
};

// latest score vs the run before it, averaged across the rules
const prevRunDelta = (list, history) => {
  const pairs = list
    .map((r) => {
      const now = num(r.pass_percentage);
      if (now === null) return null;
      const pts = (history[r.rule_id] || [])
        .map((p) => ({ d: parseDate(p?.date), v: num(p?.pass_percentage) }))
        .filter((p) => p.d && p.v !== null)
        .sort((a, b) => a.d - b.d);
      return { now, prev: pts.length > 1 ? pts[pts.length - 2].v : now, runs: pts.length };
    })
    .filter(Boolean);
  if (!pairs.some((p) => p.runs > 1)) return null;
  const mean = (k) => pairs.reduce((s, p) => s + p[k], 0) / pairs.length;
  return Math.round((mean('now') - mean('prev')) * 10) / 10;
};

const groupBy = (list, keyFn) => {
  const g = {};
  list.forEach((r) => { const k = keyFn(r); (g[k] = g[k] || []).push(r); });
  return g;
};

const DIM_ORDER = { Completeness: 0, Consistency: 1, Accuracy: 1, Timeliness: 2 };

const dimensionStats = (rows) =>
  Object.entries(groupBy(rows, dimensionOf))
    .map(([label, list]) => {
      const subs = new Set(list.map((r) => r.domain || 'Unassigned')).size;
      return { label, avg: avgOf(list), meta: `${subs} sub-domain${subs === 1 ? '' : 's'}` };
    })
    .sort((a, b) => (DIM_ORDER[a.label] ?? 9) - (DIM_ORDER[b.label] ?? 9) || a.label.localeCompare(b.label));

// one point per month, each rule averaged first so busy rules don't dominate
function averageSeries(series) {
  const avg = (a) => a.reduce((s, n) => s + n, 0) / a.length;
  const byMonth = new Map();
  series.forEach((points, i) => {
    (points || []).forEach((p) => {
      const v = num(p?.pass_percentage);
      const d = parseDate(p?.date);
      if (!d || v === null) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(key)) byMonth.set(key, { date: p.date, perRule: new Map() });
      const b = byMonth.get(key);
      if (parseDate(b.date) < d) b.date = p.date;
      if (!b.perRule.has(i)) b.perRule.set(i, []);
      b.perRule.get(i).push(v);
    });
  });
  const total = series.length || 1;
  return [...byMonth.values()]
    .map(({ date, perRule }) => {
      const vals = [...perRule.values()].map(avg);
      return { date, pass_percentage: Math.round(avg(vals) * 10) / 10, rules: vals.length, partial: vals.length < total / 2 };
    })
    .sort((a, b) => parseDate(a.date) - parseDate(b.date));
}

const seriesFor = (list, history) => averageSeries(list.map((r) => history[r.rule_id] || []));

const CSS = `
@keyframes exec-rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
@keyframes exec-slide { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:none; } }
@keyframes exec-spin { to { transform:rotate(360deg); } }
@keyframes exec-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.exv-pad{padding-left:28px;padding-right:28px}
.exv-hero{display:grid;gap:16px;align-items:stretch;grid-template-columns:392px minmax(0,1fr) 560px}
.exv-grid3{margin-top:0!important}
.exv-grid3{display:grid;gap:10px;grid-template-columns:repeat(3,minmax(0,1fr))}
.exv-drill{display:flex;gap:16px;align-items:flex-start}
.exv-drill-card{flex:none;width:460px}
.exv-drill-card.open{width:calc(100% - 796px)}
.exv-head{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;min-height:62px;flex-wrap:wrap;padding-top:8px;padding-bottom:8px}
.exv-scope-top{display:flex;align-items:center;gap:24px}
.exv-root, .exv-root .exv-head{background:#fff!important}
.exv-root .exv-head{border-bottom:none!important}
.exv-root .rounded-2xl,.exv-root [class*="rounded-["],.exv-root .rounded-xl,.exv-root .rounded-lg{border-radius:3px!important}
.exv-root .border-jj-gray-02{border-color:#cbc4bc!important}
.exv-root button[style*=box-shadow]{box-shadow:none!important;transform:none!important}
.exv-root *,.exv-root *:before,.exv-root *:after{animation:none!important;transition:none!important}
@media (max-width:1500px){
  .exv-hero{grid-template-columns:minmax(300px,392px) minmax(0,1fr)}
  .exv-hero > .exv-trend{grid-column:1/-1}
}
@media (max-width:1300px){
  .exv-drill{flex-direction:column;align-items:stretch}
  .exv-drill-card,.exv-drill-card.open{width:100%}
}
@media (max-width:900px){
  .exv-hero{grid-template-columns:minmax(0,1fr)}
  .exv-crumbs{display:none!important}
}
@media (max-width:640px){
  .exv-pad{padding-left:16px;padding-right:16px}
  .exv-grid3{grid-template-columns:minmax(0,1fr)}
  .exv-scope-top{flex-direction:column;align-items:stretch}
  .exv-health{flex-wrap:wrap}
  .exv-drill-cols{grid-template-columns:minmax(0,1fr)!important}
}
`;

const PILL = 'flex items-center gap-2 transition-colors px-3.5 py-1.5 rounded-full border border-jj-gray-03 bg-white hover:border-jj-red hover:text-jj-red font-johnson-text text-[12.5px] text-jj-gray-08';

/* ── small bits ─────────────────────────────────────────────────────────── */

function SeverityChip({ severity, compact = false }) {
  const s = String(severity || '').toUpperCase();
  const colors = {
    CRITICAL: ['#9e0000', '#fdf0ee'],
    HIGH:     ['#b04209', '#fff4ec'],
    MEDIUM:   ['#7a6400', '#fffbe3'],
    LOW:      ['#6e6259', '#f1efed'],
  };
  const [fg, bg] = colors[s] || colors.LOW;
  return (
    <span
      className="font-johnson-text font-bold rounded flex-shrink-0"
      style={{ color: fg, backgroundColor: bg, fontSize: compact ? '9.5px' : '11px', letterSpacing: '.08em', padding: compact ? '3px 6px' : '3px 8px' }}
    >
      {s || 'N/A'}
    </span>
  );
}

const RefreshIcon = ({ spin }) => (
  <span
    aria-hidden="true"
    style={{
      display: 'block', width: 14, height: 14, backgroundColor: '#000000',
      WebkitMask: `url("${refreshSrc}") center/contain no-repeat`,
      mask: `url("${refreshSrc}") center/contain no-repeat`,
      animation: spin ? 'exec-spin .7s linear infinite' : 'none',
    }}
  />
);

function EmptyState({ title, message, onRetry }) {
  return (
    <div className="h-full flex items-center justify-center px-6 py-16">
      <div
        className="w-full max-w-[440px] bg-white border border-jj-gray-03 rounded-2xl px-8 py-10 text-center"
        style={{ boxShadow: '0 24px 48px -28px rgba(49,44,42,.35)', animation: 'exec-rise .45s ease both' }}
      >
        <div
          className="mx-auto mb-5 w-16 h-16 rounded-full grid place-items-center"
          style={{ background: 'rgba(110,98,89,.08)', boxShadow: '0 0 0 8px rgba(110,98,89,.04)' }}
        >
          <Ic src={recordsSrc} className="w-7 h-7" />
        </div>
        <p className="m-0 font-johnson-display text-lg font-bold text-jj-gray-08">{title}</p>
        <p className="m-0 mt-2 font-johnson-text text-sm leading-relaxed text-jj-gray-06">{message}</p>
        {onRetry && <button onClick={onRetry} className={`mt-7 mx-auto ${PILL}`}>Try again</button>}
      </div>
    </div>
  );
}

function HealthPanel({ score, delta, rules, domains, components, belowTarget }) {
  const color = passColor(score);
  const Stat = ({ label, value }) => (
    <div className="flex-1 min-w-0">
      <p className="m-0 font-johnson-display text-[17px] font-bold" style={{ color: '#312c2a' }}>{value}</p>
      <p className="m-0 mt-0.5 font-johnson-text text-[11px] text-jj-gray-05">{label}</p>
    </div>
  );
  const Small = ({ label, children, color: c }) => (
    <div>
      <p className="m-0 font-johnson-text text-[11px] text-jj-gray-06">{label}</p>
      <p className="m-0 mt-1 font-johnson-display text-xl font-bold leading-none text-jj-gray-08" style={c ? { color: c } : undefined}>{children}</p>
    </div>
  );

  return (
    <div
      className="relative overflow-hidden rounded-[20px] px-6 pt-6 pb-5 bg-white border border-jj-gray-02"
      style={{ animation: 'exec-rise .5s cubic-bezier(.2,.8,.2,1) both' }}
    >
      <img src={backgroundSrc} alt="" className="absolute pointer-events-none" style={{ top: -150, right: -180, width: 560, opacity: 0.06 }} />
      <div className="relative">
        <p className="m-0 font-johnson-text text-[10.5px] font-bold uppercase tracking-[.16em] text-jj-gray-06">
          Safety Data quality indicators
        </p>

        <div className="exv-health flex items-center gap-6 mt-4">
          <div className="flex-shrink-0" style={{ width: 170 }}>
            <div className="font-johnson-display font-bold text-jj-gray-08" style={{ fontSize: 52, lineHeight: 1 }}>
              {score === null ? '—' : pctText(score)}
              <span className="text-jj-gray-05" style={{ fontSize: 20 }}>%</span>
            </div>
            <p className="m-0 mt-1 font-johnson-text text-[11px] text-jj-gray-06">overall pass rate</p>
            <div style={{ position: 'relative', height: 10, background: '#e8e6e3', marginTop: 10 }}>
              <div style={{ height: '100%', width: `${clamp(score ?? 0)}%`, background: color }} />
              <div title={`Target ${TARGET}%`} style={{ position: 'absolute', top: -3, bottom: -3, left: `${TARGET}%`, borderLeft: '2px solid #312c2a' }} />
            </div>
          </div>

          <div className="flex flex-col gap-3.5 min-w-0">
            <Small label="vs previous run" color={delta === null ? '#a39992' : delta >= 0 ? '#2f9e50' : '#d94e0f'}>
              {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta} pts`}
            </Small>
            <Small label="Target">{TARGET}%</Small>
            <Small label="Below target" color="#d94e0f">{belowTarget}</Small>
          </div>
        </div>

        <div className="flex gap-2.5 mt-5 pt-4" style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
          <Stat label="Components" value={components} />
          <Stat label="Domains" value={domains} />
          <Stat label="Approved rules" value={rules} />
        </div>
      </div>
    </div>
  );
}

const SHIMMER = {
  background: 'linear-gradient(90deg, #f0eeec 25%, #e4e1de 50%, #f0eeec 75%)',
  backgroundSize: '200% 100%',
  animation: 'exec-shimmer 1.4s linear infinite',
};

const SkCard = ({ h, className = '' }) => (
  <div className={`bg-white rounded-2xl border border-jj-gray-02 p-5 ${className}`} style={{ height: h }}>
    <div style={{ ...SHIMMER, width: '55%', height: 14, borderRadius: 4 }} />
    <div style={{ ...SHIMMER, width: '35%', height: 10, borderRadius: 4, marginTop: 12 }} />
    <div style={{ ...SHIMMER, width: '45%', height: 30, borderRadius: 6, marginTop: 18 }} />
  </div>
);

function PageSkeleton() {
  return (
    <div className="exv-pad pt-6" aria-busy="true" aria-label="Loading safety view">
      <div className="exv-hero">
        <SkCard h={466} />
        <div className="min-w-0 flex flex-col">
          <div style={{ ...SHIMMER, width: 160, height: 12, borderRadius: 4, marginBottom: 14 }} />
          <div className="exv-grid3">
            {[0, 1, 2, 3, 4, 5].map((i) => <SkCard key={i} h={210} />)}
          </div>
        </div>
        <div className="exv-trend flex flex-col">
          <div style={{ ...SHIMMER, width: 80, height: 12, borderRadius: 4, marginBottom: 14 }} />
          <SkCard h={440} />
        </div>
      </div>
      <SkCard h={420} className="mt-6" />
    </div>
  );
}

function TrendBars({ series, scopeLabel }) {
  const bars = useMemo(() => series.slice(-10), [series]);
  return (
    <div
      className="relative overflow-hidden h-full flex flex-col bg-white border border-jj-gray-02 rounded-2xl px-5 pt-4 pb-3.5"
      style={{ animation: 'exec-rise .5s .24s cubic-bezier(.2,.8,.2,1) both' }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h3 className="m-0 font-johnson-display text-[15px] font-bold text-jj-gray-08">Pass rate by quarter</h3>
          <p className="m-0 mt-1 font-johnson-text text-xs text-jj-gray-06">{scopeLabel}</p>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <div className="flex items-center gap-3.5 font-johnson-text text-[11px] text-jj-gray-06">
            <span className="flex items-center gap-1.5"><span style={{ width: 14, borderTop: '1px dashed #328714' }} />Target {TARGET}%</span>
            <span className="flex items-center gap-1.5"><span style={{ width: 14, borderTop: '1px dashed #0f68b2' }} />Floor {FLOOR}%</span>
          </div>
          <div className="flex items-center gap-3 font-johnson-text text-[11px] text-jj-gray-06">
            {BANDS.map((b) => (
              <span key={b.label} className="flex items-center gap-1.5">
                <span style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: b.color }} />
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {bars.length === 0 ? (
        <p className="m-0 mt-4 font-johnson-text text-xs text-jj-gray-05">No run history recorded for this scope yet.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1.5">
          {[...bars].reverse().map((b) => (
            <div key={b.date} className="flex items-center gap-3" title={`${b.rules} rules${b.partial ? ' (partial run)' : ''}`}>
              <span className="font-johnson-text text-[11px] text-jj-gray-06" style={{ width: 48 }}>{monthLabel(b.date)}</span>
              <div className="flex-1" style={{ position: 'relative', height: 14, background: '#f1efed' }}>
                <div style={{ height: '100%', width: `${clamp(b.pass_percentage)}%`, background: passColor(b.pass_percentage) }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${TARGET}%`, borderLeft: '1px dashed #312c2a' }} />
              </div>
              <span className="font-johnson-display text-[12px] font-bold" style={{ width: 42, textAlign: 'right', color: passColor(b.pass_percentage) }}>
                {b.pass_percentage}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, valueColor = '#312c2a', suffix, delay = 0, children }) {
  return (
    <div className="bg-white border border-jj-gray-02 rounded-2xl px-5 py-4" style={{ animation: `exec-rise .5s ${delay}s cubic-bezier(.2,.8,.2,1) both` }}>
      <p className="m-0 font-johnson-text text-[11px] font-bold uppercase tracking-[.1em] text-jj-gray-06">{label}</p>
      <div className="flex items-end gap-2 mt-2.5">
        <span className="font-johnson-display text-[32px] font-bold leading-none" style={{ color: valueColor }}>{value}</span>
        {suffix && <span className="font-johnson-text text-xs text-jj-gray-06 pb-1">{suffix}</span>}
      </div>
      {children}
    </div>
  );
}

// business wants "Accuracy" on the card, rule titles still say Consistency
const CARD_LABEL = { Consistency: 'Accuracy' };

function DimensionCard({ label, avg, meta, selected, onClick, compact = false }) {
  const name = CARD_LABEL[label] || label;
  const color = passColor(avg);
  return (
    <button
      onClick={onClick}
      className={`relative overflow-hidden block w-full h-full text-left bg-white rounded-2xl ${compact ? 'px-4 pt-4' : 'px-5 pt-5'} pb-0 flex flex-col`}
      style={{
        border: `1px solid ${selected ? 'rgba(235,23,0,0.32)' : '#e8e6e3'}`,
        boxShadow: selected ? '0 12px 28px rgba(49,44,42,0.10)' : '0 1px 2px rgba(49,44,42,0.03)',
        transform: selected ? 'translateY(-3px)' : 'none',
        transition: 'transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, border-color .22s ease',
      }}
    >
      <span className="absolute top-0 left-0 right-0 rounded-t-2xl" style={{ height: 3, backgroundColor: color, opacity: selected ? 1 : 0.7, transition: 'opacity .2s ease' }} />
      <div className="flex items-start justify-between gap-2.5">
        <span className="font-johnson-display font-bold text-jj-gray-08 truncate" style={{ fontSize: compact ? 14.5 : 17 }} title={name}>{name}</span>
        <span className="flex-shrink-0 flex items-center justify-center rounded-lg border border-jj-gray-02" style={{ width: compact ? 24 : 28, height: compact ? 24 : 28 }}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 11.5L11.5 2.5M11.5 2.5H4.5M11.5 2.5V9.5" stroke="#8c8377" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      <p className="m-0 mt-1.5 font-johnson-text text-jj-gray-05" style={{ fontSize: compact ? 11.5 : 12.5 }}>{meta}</p>
      <p className="m-0 mt-2.5 font-johnson-display font-bold leading-none" style={{ color, fontSize: compact ? 26 : 32 }}>
        {avg === null ? '—' : `${avg}%`}
      </p>
      <div style={{ height: 6, background: '#f1efed', margin: compact ? '12px 0 14px' : '14px 0 18px' }}>
        <div style={{ height: '100%', width: `${clamp(avg ?? 0)}%`, background: color }} />
      </div>
    </button>
  );
}

function DrillItem({ item, selected, onClick, severity, index }) {
  const color = passColor(item.pass);
  return (
    <button
      onClick={onClick}
      className="relative block w-full text-left rounded-[10px] px-3 py-2.5"
      style={{
        border: `1px solid ${selected ? 'rgba(235,23,0,0.35)' : 'transparent'}`,
        backgroundColor: selected ? '#fdf4f2' : '#ffffff',
        boxShadow: selected ? '0 6px 18px rgba(49,44,42,0.08)' : 'none',
        transform: selected ? 'translateX(2px)' : 'none',
        transition: 'background-color .18s ease, border-color .18s ease, box-shadow .18s ease, transform .18s ease',
        animation: `exec-rise .32s ${Math.min(index * 0.03, 0.3)}s cubic-bezier(.2,.8,.2,1) both`,
      }}
    >
      <span className="absolute left-0 rounded-full" style={{ top: 10, bottom: 10, width: 3, backgroundColor: selected ? '#eb1700' : 'transparent' }} />
      <div className="flex items-center gap-2 min-w-0">
        {severity
          ? <SeverityChip severity={item.severity} compact />
          : <span className="flex-shrink-0" style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: color }} />}
        <span
          className="flex-1 min-w-0 font-johnson-text text-jj-gray-08 truncate"
          style={{ fontSize: severity ? 11.5 : 12.5, fontWeight: selected ? 700 : 400 }}
          title={item.label}
        >
          {item.label}
        </span>
        <span className="font-johnson-display text-[12.5px] font-bold flex-shrink-0" style={{ color }}>
          {item.na ? 'NA' : item.pass === null ? '—' : `${item.pass}%`}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 rounded-full bg-jj-gray-01 overflow-hidden" style={{ height: 4 }}>
          <div className="h-full rounded-full" style={{ width: `${item.pass ?? 0}%`, backgroundColor: color, transition: 'width .9s cubic-bezier(.2,.8,.2,1)' }} />
        </div>
        <span className="font-johnson-text text-[10.5px] text-jj-gray-05 whitespace-nowrap">{item.meta}</span>
      </div>
    </button>
  );
}

function DrillColumn({ label, items, selected, onPick, emptyText, severity, last }) {
  return (
    <div className="min-w-0" style={{ borderRight: last ? 'none' : '1px solid #f1efed', animation: 'exec-slide .34s cubic-bezier(.2,.8,.2,1) both' }}>
      <div className="flex items-baseline justify-between gap-2 px-3.5 pt-3.5 pb-2.5">
        <span className="font-johnson-text text-[10.5px] font-bold uppercase tracking-[.14em] text-jj-gray-06">{label}</span>
        <span className="font-johnson-text text-[11px] text-jj-gray-05">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
      </div>
      <div className="px-2.5 pb-3.5 flex flex-col gap-1.5" style={{ maxHeight: 392, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <p className="m-2 mx-3 font-johnson-text text-xs text-jj-gray-05 leading-relaxed">{emptyText}</p>
        ) : (
          items.map((it, i) => (
            <DrillItem
              key={it.value}
              item={it}
              index={i}
              severity={severity}
              selected={selected === it.value}
              onClick={() => onPick(selected === it.value ? null : it.value)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ScoreBox({ score }) {
  const color = passColor(score);
  return (
    <div className="flex-shrink-0 text-center" style={{ width: 132, padding: '14px 8px', border: `2px solid ${color}` }}>
      <div className="font-johnson-display font-bold" style={{ fontSize: 34, lineHeight: 1, color }}>
        {score === null ? '—' : `${pctText(score)}%`}
      </div>
      <div className="font-johnson-text text-jj-gray-06" style={{ fontSize: 10, letterSpacing: '.08em', marginTop: 6 }}>PASS RATE</div>
    </div>
  );
}

function ScopePanel({ rule, scoped, scopeTitle, scopeDelta, series, onPickRule, activeDim, onPickDim }) {
  const score = avgOf(rule ? [rule] : scoped, 1);
  const bars = useMemo(() => series.slice(-14), [series]);
  const dims = useMemo(() => (rule ? [] : dimensionStats(scoped)), [scoped, rule]);
  const lowest = useMemo(
    () => scoped
      .map((r) => ({ r, n: num(r.pass_percentage) }))
      .filter((x) => x.n !== null)
      .sort((a, b) => a.n - b.n)
      .slice(0, 6)
      .map((x) => x.r),
    [scoped]
  );
  const facts = rule
    ? [
        ['Rule ID', rule.rule_id],
        ['Severity', rule.severity],
        ['Target table', rule.target_table],
        ['Component', rule.component_name],
        ['Connection', rule.connection_type],
        ['Dimension', CARD_LABEL[dimensionOf(rule)] || dimensionOf(rule)],
        ['Cadence', 'Quarterly'],
      ].filter(([, v]) => v)
    : [];

  return (
    <div className="bg-white border border-jj-gray-02 rounded-[20px] overflow-hidden">
      <div className="px-6 pt-5 pb-5 border-b border-jj-gray-01" style={{ paddingTop: 22 }}>
        <p className="m-0 font-johnson-text text-xs font-bold uppercase tracking-[.14em] text-jj-gray-06">{rule ? 'Rule detail' : 'Selection'}</p>
        <h3 className="m-0 mt-2.5 font-johnson-display text-2xl font-bold leading-tight text-jj-gray-08">{rule ? rule.rule_title || rule.rule_id : scopeTitle}</h3>
        <p className="m-0 mt-2 font-johnson-text text-sm text-jj-gray-06 leading-relaxed">
          {rule
            ? `${rule.component_name || 'Unassigned'} › ${rule.domain || 'Unassigned'}`
            : `${scoped.length} ${scoped.length === 1 ? 'rule' : 'rules'} in scope`}
        </p>

        <div className="exv-scope-top mt-5">
          <div className="flex flex-col items-center gap-2.5 flex-shrink-0">
            <ScoreBox score={score} />
            {scopeDelta !== null && (
              <span
                className="font-johnson-text text-xs font-bold rounded-md px-2.5 py-1.5"
                style={{ color: scopeDelta >= 0 ? '#328714' : '#eb1700', backgroundColor: scopeDelta >= 0 ? 'rgba(50,135,20,0.08)' : 'rgba(235,23,0,0.08)' }}
              >
                {scopeDelta >= 0 ? '+' : ''}{scopeDelta} pts vs previous
              </span>
            )}
          </div>
          {dims.length > 0 && (
            <div className="exv-grid3 flex-1 min-w-0" style={{ justifyItems: 'stretch' }}>
              {dims.slice(0, 6).map((c) => (
                <DimensionCard
                  key={c.label}
                  compact
                  label={c.label}
                  avg={c.avg}
                  meta={c.meta}
                  selected={activeDim === c.label}
                  onClick={() => onPickDim(activeDim === c.label ? null : c.label)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {rule ? (
        <div className="px-6 pt-5 pb-6">
          {rule.rule_description && (
            <p className="m-0 mb-4 font-johnson-text text-sm leading-relaxed text-jj-gray-08">{rule.rule_description}</p>
          )}
          {facts.map(([k, v]) => (
            <div key={k} className="flex gap-3 py-3 border-t border-jj-gray-01">
              <span className="font-johnson-text text-sm text-jj-gray-06 flex-shrink-0" style={{ width: 124 }}>{k}</span>
              <span className="flex-1 font-johnson-text text-sm font-bold text-jj-gray-08 break-words">{v}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-6 pt-5 pb-6">
          <p className="m-0 mb-3.5 font-johnson-text text-xs font-bold uppercase tracking-[.14em] text-jj-gray-06">Lowest scoring rules</p>
          {lowest.length === 0 ? (
            <p className="m-0 font-johnson-text text-xs text-jj-gray-05">No scored rules in this scope yet.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {lowest.map((r) => (
                <button
                  key={r.rule_id}
                  onClick={() => onPickRule(r)}
                  className="flex flex-col items-stretch gap-2 w-full text-left px-4 py-3.5 rounded-xl bg-white border border-jj-gray-02"
                  style={{ transition: 'border-color .18s ease, transform .18s ease' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#cbc4bc'; e.currentTarget.style.transform = 'translateX(2px)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e8e6e3'; e.currentTarget.style.transform = 'none'; }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SeverityChip severity={r.severity} compact />
                    <span className="flex-1 font-johnson-text text-sm font-bold text-jj-gray-08 truncate">
                      {CARD_LABEL[dimensionOf(r)] || dimensionOf(r)} · {r.domain || 'Unassigned'}
                    </span>
                    <span className="font-johnson-display text-base font-bold flex-shrink-0" style={{ color: passColor(Number(r.pass_percentage)) }}>
                      {Math.round(Number(r.pass_percentage))}%
                    </span>
                  </div>
                  <span className="font-johnson-text text-xs text-jj-gray-06 truncate">
                    {r.component_name || 'Unassigned'} › {r.domain || 'Unassigned'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="px-6 pb-6">
        <p className="m-0 mb-2 font-johnson-text text-[10.5px] font-bold uppercase tracking-[.14em] text-jj-gray-06">{rule ? 'Rule history' : 'Scope history'}</p>
        {bars.length === 0 ? (
          <p className="m-0 font-johnson-text text-xs text-jj-gray-05" style={{ minHeight: 96 }}>No run history recorded for this scope yet.</p>
        ) : (
          <>
            <div className="flex gap-1.5" style={{ height: 96 }}>
              {bars.map((b) => (
                <div key={b.date} className="flex flex-col h-full" style={{ flex: 1, maxWidth: 44 }}>
                  <span className="font-johnson-display text-[9.5px] font-bold text-center" style={{ height: 14, lineHeight: '14px', color: passColor(b.pass_percentage) }}>
                    {Math.round(b.pass_percentage)}%
                  </span>
                  <div className="flex-1 flex flex-col justify-end">
                    <div
                      className="rounded-t"
                      title={`${monthLabel(b.date)} · ${b.pass_percentage}%${b.partial ? ' (partial run)' : ''}`}
                      style={{ height: `${Math.max(4, clamp(b.pass_percentage))}%`, backgroundColor: passColor(b.pass_percentage), opacity: 0.9, transition: 'height .8s cubic-bezier(.2,.8,.2,1)' }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-1.5">
              {bars.map((b) => (
                <span key={b.date} className="text-center font-johnson-text text-[10px] text-jj-gray-06" style={{ flex: 1, maxWidth: 44 }}>
                  {monthLabel(b.date)}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── page ───────────────────────────────────────────────────────────────── */

export default function SafetyDQ() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastUpdated = useRef(null);

  // quiet = background poll, only swap the data when the file actually changed
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const res = await apiFetch('/dq/safety/data');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.detail || res.statusText || `Request failed (${res.status})`);
      if (!quiet || body.updated !== lastUpdated.current) {
        lastUpdated.current = body.updated;
        setData(body);
      }
      setError(null);
    } catch (e) {
      // a failed poll keeps the last good data on screen
      if (!quiet) setError(e?.message || 'Could not load the Safety data.');
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const refresh = () => { if (!refreshing) load(); };

  // drill state sits in the URL so a reload keeps the same selection
  const [params, setParams] = useSearchParams();
  const dim = params.get('sdim') || null;
  const dom = params.get('sdom') || null;
  const ruleId = params.get('srule') || null;
  const setDrill = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setParams]);
  const clearAll = () => setDrill({ sdim: null, sdom: null, srule: null });

  const rules = useMemo(() => data?.rules ?? [], [data]);
  const emptyDomains = useMemo(() => data?.emptyDomains ?? [], [data]);
  const history = useMemo(() => data?.history ?? {}, [data]);

  const byDim = useMemo(() => rules.filter((r) => !dim || dimensionOf(r) === dim), [rules, dim]);
  const scoped = useMemo(() => byDim.filter((r) => !dom || (r.domain || 'Unassigned') === dom), [byDim, dom]);

  const domainItems = useMemo(() => [
    ...Object.entries(groupBy(byDim, (r) => r.domain || 'Unassigned'))
      .map(([d, rows]) => ({ value: d, label: d, pass: avgOf(rows), meta: `${rows.length} ${rows.length === 1 ? 'rule' : 'rules'}` }))
      .sort((a, b) => (a.pass ?? 101) - (b.pass ?? 101)),
    ...(dim ? [] : emptyDomains.map((d) => ({ value: d, label: d, pass: null, na: true, meta: 'none approved' }))),
  ], [byDim, dim, emptyDomains]);

  const ruleItems = useMemo(() => (dom
    ? scoped
        .map((r) => ({
          value: r.rule_id,
          label: `${CARD_LABEL[dimensionOf(r)] || dimensionOf(r)} · ${r.rule_id}`,
          pass: r.pass_percentage == null ? null : Math.round(Number(r.pass_percentage)),
          meta: r.status || '',
          severity: r.severity,
        }))
        .sort((a, b) => (a.pass ?? 101) - (b.pass ?? 101))
    : []), [scoped, dom]);

  const dimensions = useMemo(() => dimensionStats(rules), [rules]);
  const selectedRule = useMemo(() => rules.find((r) => r.rule_id === ruleId) || null, [rules, ruleId]);
  const scopeSeries = useMemo(() => seriesFor(selectedRule ? [selectedRule] : scoped, history), [scoped, selectedRule, history]);

  const domainStats = useMemo(() => [
    ...Object.entries(groupBy(rules, (r) => r.domain || 'Unassigned')).map(([d, rows]) => ({ domain: d, pass: avgOf(rows) })),
    ...emptyDomains.map((d) => ({ domain: d, pass: null, na: true })),
  ], [rules, emptyDomains]);

  const score = avgOf(rules, 1);
  const scored = (r) => r.pass_percentage !== null;
  const highSev = rules.filter((r) => ['CRITICAL', 'HIGH'].includes(String(r.severity || '').toUpperCase()));
  const highAtRisk = highSev.filter((r) => scored(r) && Number(r.pass_percentage) < TARGET).length;
  const meetingTarget = rules.filter((r) => scored(r) && Number(r.pass_percentage) >= TARGET).length;
  const notScored = rules.filter((r) => !scored(r)).length;
  const naDomains = domainStats.filter((d) => d.na).length;

  const scopeTitle = dom || (dim ? `${CARD_LABEL[dim] || dim} checks` : 'All domains');
  const scopeLabel = `${scopeTitle} · ${scoped.length} ${scoped.length === 1 ? 'rule' : 'rules'} · quarterly runs`;
  const crumbs = [
    { label: dim ? `${CARD_LABEL[dim] || dim} checks` : 'All checks', onClick: clearAll },
    ...(dom ? [{ label: dom, onClick: () => setDrill({ srule: null }) }] : []),
    ...(selectedRule ? [{ label: ruleId, onClick: () => {} }] : []),
  ];
  const dirty = !!(dim || dom || ruleId);

  const header = (
    <div className="exv-head exv-pad bg-white">
      <div className="flex items-center gap-4 min-w-0">
        <img src={logoSrc} alt="SmartHub" style={{ height: 30, width: 'auto', display: 'block', flexShrink: 0 }} />
        <div className="exv-crumbs flex items-center gap-2 font-johnson-text text-[12.5px] text-jj-gray-06 min-w-0">
          <span>Data Quality Engine</span>
          <span className="text-jj-gray-04">/</span>
          <span>Business Defined Checks</span>
          <span className="text-jj-gray-04">/</span>
          <span className="text-jj-gray-08 font-bold">Pharmacovigilance Executive View</span>
        </div>
        {error && data && (
          <span className="font-johnson-text text-xs font-bold truncate" style={{ color: '#eb1700' }} title={error}>
            {error}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3.5 flex-wrap">
        <button
          onClick={refresh}
          className={PILL}
          title={data?.updated ? `Excel file last saved ${new Date(data.updated * 1000).toLocaleString()}` : undefined}
        >
          <RefreshIcon spin={refreshing} />
          Refresh
        </button>
      </div>
    </div>
  );

  const shell = (body) => (
    <div className="exv-root flex flex-col h-full bg-jj-gray-01">
      <style>{CSS}</style>
      {header}
      <div className="flex-1 min-h-0 overflow-auto">{body}</div>
    </div>
  );

  if (error && !data) return shell(<EmptyState title="Couldn't load the Safety data" message={error} onRetry={refresh} />);
  if (!data) return shell(<PageSkeleton />);
  if (!rules.length) {
    return shell(<EmptyState title="No rules yet" message="Add rows to the Rules sheet in safety_dq_data.xlsx and they show up here." onRetry={refresh} />);
  }

  return shell(
    <>
      <div className="exv-hero exv-pad pt-6">
        <HealthPanel
          score={score}
          delta={prevRunDelta(rules, history)}
          rules={rules.length}
          domains={domainStats.length}
          components={new Set(rules.map((r) => r.component_name || 'Unassigned')).size}
          belowTarget={rules.filter((r) => scored(r) && Number(r.pass_percentage) < TARGET).length}
        />

        <div className="min-w-0 flex flex-col">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <h2 className="m-0 font-johnson-display text-sm font-bold uppercase tracking-[.1em] text-jj-gray-06">Quality dimensions</h2>
            <span className="font-johnson-text text-xs text-jj-gray-05">Pick one to filter everything below</span>
          </div>
          <div className="exv-grid3 flex-1 min-h-0">
            {dimensions.map((c) => (
              <DimensionCard
                key={c.label}
                {...c}
                selected={dim === c.label}
                onClick={() => setDrill({ sdim: dim === c.label ? null : c.label, sdom: null, srule: null })}
              />
            ))}
          </div>

          <div className="exv-grid3 mt-2.5">
            <StatCard
              label="High-severity rules at risk"
              value={highAtRisk}
              valueColor="#eb1700"
              suffix={`of ${highSev.length} high or critical`}
              delay={0.06}
            >
              <div className="h-1.5 rounded-full bg-jj-gray-01 mt-3.5 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${highSev.length ? Math.round((highAtRisk / highSev.length) * 100) : 0}%`,
                    backgroundColor: '#eb1700',
                    transition: 'width 1s cubic-bezier(.2,.8,.2,1)',
                  }}
                />
              </div>
            </StatCard>

            <StatCard label="Rules meeting target" value={meetingTarget} valueColor="#328714" suffix={`of ${rules.length} rules`} delay={0.12}>
              <p className="m-0 mt-3.5 font-johnson-text text-xs text-jj-gray-06">
                {notScored} {notScored === 1 ? 'rule' : 'rules'} not yet scored
              </p>
            </StatCard>

            <StatCard
              label="Domains meeting target"
              value={domainStats.filter((d) => d.pass !== null && d.pass >= TARGET).length}
              valueColor="#328714"
              suffix={`of ${domainStats.filter((d) => d.pass !== null).length} scored${naDomains ? ` · ${naDomains} with no approved rules` : ''}`}
              delay={0.18}
            >
              <div className="flex gap-1 mt-3.5">
                {domainStats.map((d) => (
                  <div
                    key={d.domain}
                    title={`${d.domain} · ${d.na ? 'NA' : d.pass === null ? '—' : `${d.pass}%`}`}
                    style={{ flex: 1, height: 18, borderRadius: 3, backgroundColor: passColor(d.pass), opacity: 0.9 }}
                  />
                ))}
              </div>
            </StatCard>
          </div>
        </div>

        <div className="exv-trend min-w-0 flex flex-col">
          <div className="flex items-baseline gap-4 mb-3">
            <h2 className="m-0 font-johnson-display text-sm font-bold uppercase tracking-[.1em] text-jj-gray-06">History</h2>
          </div>
          <div className="flex-1 min-h-0">
            <TrendBars series={scopeSeries} scopeLabel={scopeLabel} />
          </div>
        </div>
      </div>

      <div className="exv-drill exv-pad py-5">
        <div
          className={`exv-drill-card ${dom ? 'open' : ''} bg-white border border-jj-gray-02 rounded-[20px] overflow-hidden`}
          style={{ transition: 'width .42s cubic-bezier(.2,.8,.2,1)' }}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-jj-gray-01">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
                    {i > 0 && <Ic src={chevronRight} className="w-3 h-3" />}
                    <button
                      onClick={c.onClick}
                      className="px-2.5 py-1 rounded-lg font-johnson-text text-[12.5px]"
                      style={{ fontWeight: last ? 700 : 400, color: last ? '#312c2a' : '#0f68b2', backgroundColor: last ? '#f1efed' : 'transparent' }}
                    >
                      {c.label}
                    </button>
                  </span>
                );
              })}
            </div>
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-02 bg-white font-johnson-text text-[11.5px]"
              style={{ color: dirty ? '#eb1700' : '#cbc4bc' }}
            >
              <Ic src={closeSrc} className="w-2.5 h-2.5" filter={dirty ? F.red : F.gray06} />
              Clear selection
            </button>
          </div>

          <div
            className={`grid ${dom ? 'exv-drill-cols' : ''}`}
            style={{ gridTemplateColumns: dom ? '1fr 1fr' : '1fr 0fr', transition: 'grid-template-columns .42s cubic-bezier(.2,.8,.2,1)' }}
          >
            <DrillColumn
              label="Domain"
              items={domainItems}
              selected={dom}
              onPick={(v) => setDrill({ sdom: v, srule: null })}
              emptyText="No safety domains in this scope."
              last={!dom}
            />
            <div
              className="min-w-0 overflow-hidden"
              style={{ opacity: dom ? 1 : 0, pointerEvents: dom ? 'auto' : 'none', transition: 'opacity .3s ease' }}
              aria-hidden={!dom}
              inert={!dom}
            >
              <DrillColumn
                label="Rule"
                items={ruleItems}
                selected={ruleId}
                onPick={(v) => setDrill({ srule: v })}
                emptyText="No rules under this domain."
                severity
                last
              />
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <ScopePanel
            rule={selectedRule}
            scoped={scoped}
            scopeTitle={scopeTitle}
            scopeDelta={prevRunDelta(selectedRule ? [selectedRule] : scoped, history)}
            series={scopeSeries}
            activeDim={dim}
            onPickDim={(v) => setDrill({ sdim: v, sdom: null, srule: null })}
            onPickRule={(r) => setDrill({ sdom: r.domain || 'Unassigned', srule: r.rule_id })}
          />
        </div>
      </div>
    </>
  );
}
