import React, { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';

// Extra ways to look at a result: one row at a time, every column at a glance,
// a quick chart and a pivot. They work on the rows already in the browser (the
// page on screen), never the whole result, and each one says so.

const isBig = (v) => Boolean(v && typeof v === 'object' && v.$truncated);
const NF2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt = (n) => (n == null || Number.isNaN(n) ? '' : NF2.format(Number(n)));

// Snowflake NUMBER arrives as text to keep its precision; read it back as a number.
const toNum = (v) => {
  if (v == null || v === '' || isBig(v)) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const toText = (v) => (v == null ? null : isBig(v) ? v.preview : typeof v === 'object' ? JSON.stringify(v) : String(v));
const monthOf = (v) => {
  const m = /^(\d{4})-(\d{2})/.exec(toText(v) || '');
  return m ? `${m[1]}-${m[2]}` : null;
};
const monthLabel = (k) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

const SHADES = (accent) => [accent, '#312c2a', `${accent}99`, '#6e6259', `${accent}55`, '#a39992', '#cbc4bc', '#766a63'];

function Note({ rows, total }) {
  const all = total != null && total <= rows;
  return (
    <span className="text-[11.5px] text-[#766a63]">
      {all ? `All ${fmt(rows)} rows` : `The ${fmt(rows)} rows on this page${total != null ? ` of ${fmt(total)}` : ''}. Raise rows per page, or add a GROUP BY, to cover more.`}
    </span>
  );
}

// Axis labels stay short; the tooltip on the bar has the full value.
const clip = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function Select({ label, value, onChange, options }) {
  const shown = options.find(([k]) => k === value)?.[1] ?? '';
  return (
    <label className="flex items-center gap-2 min-w-0 text-[12px] text-[#6e6259]">
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        title={shown}
        className="h-7 min-w-0 max-w-[220px] truncate rounded-md border border-[#d5cfc9] bg-white pl-2 pr-6 text-[12px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)]"
      >
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex p-[2px] rounded-[9px] bg-[#f1efed]" role="radiogroup">
      {options.map(([k, l]) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`h-6 px-2.5 rounded-[7px] text-[12px] font-medium transition-colors ${value === k ? 'bg-white text-[#312c2a] shadow-[0_1px_2px_rgba(49,44,42,.12)]' : 'text-[#6e6259] hover:text-[#312c2a]'}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

// Per-column summary of the loaded rows.
function profileColumn(rows, i, family) {
  const vals = rows.map(r => r[i]);
  const filled = vals.filter(v => v != null && v !== '');
  const counts = new Map();
  filled.forEach(v => { const k = toText(v); counts.set(k, (counts.get(k) || 0) + 1); });
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const out = { total: vals.length, filled: filled.length, empty: vals.length - filled.length, distinct: counts.size, top };
  if (family === 'time') {
    const ts = filled.map(toText).sort();
    const months = filled.map(monthOf).filter(Boolean).map(k => +k.slice(0, 4) * 12 + +k.slice(5, 7)).sort((a, b) => a - b);
    if (ts.length) out.time = { min: ts[0], max: ts[ts.length - 1], months };
  }
  if (family === 'num') {
    const nums = filled.map(toNum).filter(n => n != null).sort((a, b) => a - b);
    if (nums.length) {
      const q = (f) => nums[Math.floor((nums.length - 1) * f)];
      out.num = { min: nums[0], max: nums[nums.length - 1], avg: nums.reduce((a, b) => a + b, 0) / nums.length, median: q(0.5), q1: q(0.25), q3: q(0.75), values: nums };
    }
  }
  return out;
}

function Bins({ values, accent, bins = 18, height = 36 }) {
  if (!values?.length) return <div style={{ height }} />;
  const lo = values[0], hi = values[values.length - 1], b = Array(bins).fill(0);
  values.forEach(v => { b[Math.min(bins - 1, Math.floor((v - lo) / ((hi - lo) || 1) * bins))]++; });
  const mx = Math.max(...b);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }} aria-hidden="true">
      {b.map((n, k) => <span key={k} className="flex-1 rounded-t-[2px]" style={{ height: `${Math.max(4, n / mx * 100)}%`, background: accent, opacity: n ? 0.75 : 0.15 }} />)}
    </div>
  );
}

function Shares({ top, total, accent, height = 10 }) {
  let left = 0;
  return (
    <div className="relative w-full rounded-full overflow-hidden bg-[#f1efed]" style={{ height }} aria-hidden="true">
      {top.slice(0, 6).map(([k, n], i) => {
        const w = n / total * 100, el = <span key={k} className="absolute top-0 bottom-0" style={{ left: `${left}%`, width: `calc(${w}% - 2px)`, background: accent, opacity: 0.95 - i * 0.14 }} />;
        left += w;
        return el;
      })}
    </div>
  );
}

/* ------------------------------- record ------------------------------- */

export function RecordView({ columns, families, rows, rowOffset = 0, index, onIndex, onCopy, accent }) {
  const profiles = useMemo(() => columns.map((c, i) => profileColumn(rows, i, families[i])), [columns, rows, families]);
  if (!rows.length) return <div className="py-12 text-center text-[13px] text-[#6e6259]">No rows to show.</div>;
  const at = Math.min(Math.max(0, index), rows.length - 1);
  const row = rows[at];
  return (
    <div className="max-w-[920px] mx-auto px-5 py-4">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="flex-1 min-w-0 truncate m-0 font-johnson-display font-bold text-[20px] text-[#312c2a]">{toText(row[0]) ?? 'Empty'}</h3>
        <span className="text-[12.5px] text-[#766a63] tabular-nums">Row {fmt(rowOffset + at + 1)}</span>
        <button disabled={at === 0} onClick={() => onIndex(at - 1)} className="inline-flex items-center gap-1 h-7 pl-2 pr-3 rounded-md border border-[#d5cfc9] text-[12.5px] hover:bg-[#f4f2f0] disabled:opacity-40" title="Previous row (K)"><ChevronLeft size={14} />Previous</button>
        <button disabled={at === rows.length - 1} onClick={() => onIndex(at + 1)} className="inline-flex items-center gap-1 h-7 pl-3 pr-2 rounded-md border border-[#d5cfc9] text-[12.5px] hover:bg-[#f4f2f0] disabled:opacity-40" title="Next row (J)">Next<ChevronRight size={14} /></button>
        <button onClick={() => onCopy(Object.fromEntries(columns.map((c, i) => [c.name, row[i]])))} className="w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-[#f4f2f0] text-[#6e6259]" title="Copy the row as JSON"><Copy size={15} /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {columns.map((c, i) => {
          const v = row[i], p = profiles[i], n = families[i] === 'num' ? toNum(v) : null, t = toText(v);
          let ctx = null;
          if (n != null && p.num && p.num.max > p.num.min) {
            const pos = (n - p.num.min) / (p.num.max - p.num.min) * 100;
            const higher = Math.round(p.num.values.filter(x => x < n).length / p.num.values.length * 100);
            ctx = (
              <>
                <div className="relative h-[6px] mt-2.5 rounded-full bg-[#f1efed]">
                  <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pos}%`, background: `${accent}40` }} />
                  <span className="absolute -top-[3px] w-3 h-3 rounded-full border-2 border-white" style={{ left: `calc(${pos}% - 6px)`, background: accent, boxShadow: `0 0 0 1px ${accent}` }} />
                </div>
                <div className="mt-1.5 text-[11.5px] text-[#6e6259]">Higher than {higher}% of rows on this page. Range {fmt(p.num.min)} to {fmt(p.num.max)}.</div>
              </>
            );
          } else if (t != null && families[i] !== 'time' && p.distinct <= Math.max(30, p.filled / 4)) {
            const same = p.top.find(([k]) => k === t)?.[1] || 0;
            ctx = <div className="mt-1.5 text-[11.5px] text-[#6e6259]">{Math.round(same / p.total * 100)}% of rows on this page share this value</div>;
          }
          return (
            <div key={c.name} className="px-3.5 py-3 rounded-xl border border-[#e8e6e3]">
              <div className="flex justify-between gap-3 text-[11.5px] text-[#766a63]"><span className="truncate">{c.name}</span><span className="flex-shrink-0">{c.type}</span></div>
              <div className="mt-0.5 text-[15px] font-medium text-[#312c2a] break-words tabular-nums">
                {t == null ? <span className="italic font-normal text-[#a39992]">NULL</span> : n != null ? fmt(n) : t.length > 400 ? `${t.slice(0, 400)}…` : t}
              </div>
              {ctx}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- profile ------------------------------ */

export function ProfileView({ columns, families, rows, total, accent, onChart }) {
  const profiles = useMemo(() => columns.map((c, i) => profileColumn(rows, i, families[i])), [columns, rows, families]);
  return (
    <div className="px-5 py-4">
      <div className="mb-3"><Note rows={rows.length} total={total} /></div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
        {columns.map((c, i) => {
          const p = profiles[i], emptyPct = p.total ? Math.round(p.empty / p.total * 100) : 0;
          const unique = p.distinct === p.filled && p.filled > 1;
          const flag = emptyPct >= 5 ? `${emptyPct}% of rows are empty` : p.distinct === 1 ? 'Only one value' : unique && families[i] === 'text' ? 'Every value is different' : null;
          const chartable = (families[i] === 'time' || (families[i] !== 'num' && !unique)) && p.distinct > 1;
          return (
            <button
              key={c.name}
              onClick={() => chartable && onChart(c.name)}
              title={chartable ? `Chart rows by ${c.name}` : undefined}
              className={`flex flex-col justify-start text-left px-3.5 py-3 rounded-xl border border-[#e8e6e3] transition-shadow ${chartable ? 'hover:border-[#a39992] hover:shadow-[0_6px_20px_rgba(49,44,42,.06)]' : 'cursor-default'}`}
            >
              <div className="font-bold text-[13px] text-[#312c2a] truncate">{c.name}</div>
              <div className="text-[11.5px] text-[#766a63]">{c.type}</div>
              <div className="mt-2.5">
                {p.num ? <Bins values={p.num.values} accent={accent} /> : p.time ? <Bins values={p.time.months} accent={accent} /> : <div className="h-9 flex items-end"><Shares top={p.top} total={p.total || 1} accent={accent} /></div>}
              </div>
              <div className="flex justify-between gap-2 mt-2 text-[11.5px] text-[#6e6259] tabular-nums">
                <span className="flex-shrink-0 whitespace-nowrap">{fmt(p.distinct)} distinct</span>
                <span className="truncate">{p.num ? `${fmt(p.num.min)} to ${fmt(p.num.max)}` : p.time ? `${p.time.min.slice(0, 10)} to ${p.time.max.slice(0, 10)}` : p.top[0] ? (unique ? `e.g. ${p.top[0][0]}` : `Most: ${p.top[0][0]}`) : 'All empty'}</span>
              </div>
              {flag && <div className="mt-1.5 text-[11.5px] text-[#a14a00]">{flag}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- chart ------------------------------- */

function groupRows(rows, colIdx, family, measure, numIdx) {
  const g = new Map();
  rows.forEach(r => {
    const k = family === 'time' ? monthOf(r[colIdx]) ?? 'Empty' : toText(r[colIdx]) ?? 'Empty';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  });
  return [...g.entries()].map(([k, rs]) => {
    if (measure === 'count') return { k, v: rs.length };
    const nums = rs.map(r => toNum(r[numIdx])).filter(n => n != null), s = nums.reduce((a, b) => a + b, 0);
    return { k, v: measure === 'sum' ? s : nums.length ? s / nums.length : 0 };
  });
}

// Columns worth grouping by: a handful of repeated values, not an id.
function groupable(columns, families, rows, kinds) {
  return columns.map((c, i) => {
    if (!kinds.includes(families[i])) return null;
    const seen = new Set();
    for (const r of rows) { seen.add(families[i] === 'time' ? monthOf(r[i]) : toText(r[i])); if (seen.size > 200) break; }
    return { c, i, distinct: seen.size, useful: seen.size > 1 && (families[i] === 'time' || seen.size <= Math.max(30, rows.length / 4)) };
  }).filter(Boolean);
}

const measureOptions = (columns, families) => [
  ['count', 'Number of rows'],
  ...columns.flatMap((c, i) => (families[i] === 'num' ? [[`avg:${i}`, `Average ${c.name}`], [`sum:${i}`, `Total ${c.name}`]] : [])),
];

export function ChartView({ columns, families, rows, total, accent, groupBy, onGroupBy }) {
  const dims = useMemo(() => groupable(columns, families, rows, ['text', 'bool', 'time']), [columns, families, rows]);
  const [type, setType] = useState('column');
  const [measure, setMeasure] = useState(null);
  const dim = dims.find(d => d.c.name === groupBy) || dims.find(d => d.useful && families[d.i] !== 'time') || dims.find(d => d.useful) || dims[0];
  const mOpts = measureOptions(columns, families);
  // Already grouped (one row per value): counting gives 1 everywhere, so
  // chart the first number instead until something else is picked.
  const firstNum = families.findIndex(f => f === 'num');
  const auto = dim && dim.distinct === rows.length && firstNum >= 0 ? `sum:${firstNum}` : 'count';
  const m = mOpts.some(([k]) => k === measure) ? measure : auto;
  const [fn, numIdx] = m.split(':');
  const data = useMemo(() => {
    if (!dim) return [];
    const d = groupRows(rows, dim.i, families[dim.i], fn, Number(numIdx));
    if (families[dim.i] === 'time') return d.sort((a, b) => (a.k < b.k ? -1 : 1)).map(x => ({ ...x, label: x.k === 'Empty' ? x.k : monthLabel(x.k) }));
    return d.sort((a, b) => b.v - a.v).slice(0, 15).map(x => ({ ...x, label: x.k }));
  }, [rows, dim, families, fn, numIdx]);

  if (!dim) return <div className="py-12 text-center text-[13px] text-[#6e6259]">This result has no text or date column to group by. Try the Profile view.</div>;
  const isTime = families[dim.i] === 'time', noDonut = isTime || m.startsWith('avg');
  const kind = type === 'donut' && noDonut ? (isTime ? 'line' : 'column') : type;
  const label = mOpts.find(([k]) => k === m)?.[1];
  const shades = SHADES(accent);
  const tip = { contentStyle: { borderRadius: 8, border: '1px solid #e8e6e3', fontSize: 12 }, formatter: (v) => [fmt(v), label] };

  return (
    <div className="h-full flex flex-col px-5 py-4 min-h-[340px]">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Segmented value={kind} onChange={setType} options={[['column', 'Columns'], ['bar', 'Bars'], ['line', 'Line'], ...(noDonut ? [] : [['donut', 'Donut']])]} />
        <Select label="Group by" value={dim.c.name} onChange={onGroupBy} options={dims.map(d => [d.c.name, families[d.i] === 'time' ? `${d.c.name} (month)` : d.c.name])} />
        <Select label="Measure" value={m} onChange={setMeasure} options={mOpts} />
        <span className="ml-auto"><Note rows={rows.length} total={total} /></span>
      </div>
      <div className="flex-1 min-h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'donut' ? (
            <PieChart>
              <Tooltip {...tip} />
              <Pie
                data={data}
                dataKey="v"
                nameKey="label"
                innerRadius="52%"
                outerRadius="78%"
                paddingAngle={1}
                stroke="#fff"
                strokeWidth={2}
                labelLine={{ stroke: '#cbc4bc' }}
                label={({ x, y, textAnchor, label: name, percent }) => <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fill="#4a423e" fontSize={12}>{`${name} ${Math.round(percent * 100)}%`}</text>}
                style={{ fontSize: 12 }}
              >
                {data.map((d, i) => <Cell key={d.k} fill={shades[i % shades.length]} />)}
              </Pie>
            </PieChart>
          ) : kind === 'line' ? (
            <AreaChart data={data} margin={{ top: 16, right: 16, bottom: 4, left: 4 }}>
              <defs><linearGradient id="dsArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={accent} stopOpacity={0.3} /><stop offset="1" stopColor={accent} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke="#f1efed" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#766a63' }} tickLine={false} axisLine={{ stroke: '#e8e6e3' }} minTickGap={16} tickFormatter={v => clip(v, 14)} />
              <YAxis tick={{ fontSize: 11, fill: '#766a63' }} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
              <Tooltip {...tip} />
              <Area type="monotone" dataKey="v" stroke={accent} strokeWidth={2.5} fill="url(#dsArea)" dot={{ r: 3, fill: '#fff', stroke: accent, strokeWidth: 2 }} />
            </AreaChart>
          ) : (
            <BarChart data={data} layout={kind === 'bar' ? 'vertical' : 'horizontal'} margin={{ top: 22, right: 40, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#f1efed" vertical={kind === 'bar'} horizontal={kind !== 'bar'} />
              {kind === 'bar' ? (
                <>
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#766a63' }} tickLine={false} axisLine={false} tickFormatter={fmt} />
                  <YAxis type="category" dataKey="label" width={130} tick={{ fontSize: 12, fill: '#4a423e' }} tickLine={false} axisLine={false} tickFormatter={v => clip(v, 18)} />
                </>
              ) : (
                <>
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#766a63' }} tickLine={false} axisLine={{ stroke: '#e8e6e3' }} interval={data.length <= 12 ? 0 : 'preserveStartEnd'} minTickGap={6} tickFormatter={v => clip(v, data.length <= 6 ? 18 : data.length <= 12 ? 10 : 8)} />
                  <YAxis tick={{ fontSize: 11, fill: '#766a63' }} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
                </>
              )}
              <Tooltip {...tip} cursor={{ fill: '#f4f2f0' }} />
              <Bar dataKey="v" fill={accent} radius={kind === 'bar' ? [0, 5, 5, 0] : [5, 5, 0, 0]} maxBarSize={56}>
                <LabelList dataKey="v" position={kind === 'bar' ? 'right' : 'top'} formatter={fmt} style={{ fontSize: 11.5, fill: '#4a423e', fontWeight: 600 }} />
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* -------------------------------- pivot ------------------------------- */

export function PivotView({ columns, families, rows, total, accent }) {
  const dims = useMemo(() => groupable(columns, families, rows, ['text', 'bool']), [columns, families, rows]);
  const [rKey, setR] = useState(null);
  const [cKey, setC] = useState(null);
  const [measure, setMeasure] = useState('count');
  // Default: more values down the side, fewer across the top.
  const useful = dims.filter(d => d.useful).sort((a, b) => b.distinct - a.distinct);
  const rd = dims.find(d => d.c.name === rKey) || useful[0] || dims[0];
  const cd = dims.find(d => d.c.name === cKey && d !== rd) || useful.filter(d => d !== rd).pop() || dims.find(d => d !== rd);
  const mOpts = measureOptions(columns, families);
  const m = mOpts.some(([k]) => k === measure) ? measure : 'count';

  const table = useMemo(() => {
    if (!rd || !cd) return null;
    const [fn, idx] = m.split(':'), cells = new Map(), rk = new Set(), ck = new Set();
    rows.forEach(r => {
      const a = toText(r[rd.i]) ?? 'Empty', b = toText(r[cd.i]) ?? 'Empty', key = `${a}\u0000${b}`;
      rk.add(a); ck.add(b);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(r);
    });
    const agg = (rs) => {
      if (!rs?.length) return null;
      if (fn === 'count') return rs.length;
      const n = rs.map(r => toNum(r[Number(idx)])).filter(x => x != null), s = n.reduce((p, q) => p + q, 0);
      return fn === 'sum' ? s : n.length ? s / n.length : null;
    };
    const R = [...rk].sort(), C = [...ck].sort().slice(0, 24);
    const grid = R.map(a => C.map(b => agg(cells.get(`${a}\u0000${b}`))));
    const rowTot = R.map(a => agg(rows.filter(r => (toText(r[rd.i]) ?? 'Empty') === a)));
    const colTot = C.map(b => agg(rows.filter(r => (toText(r[cd.i]) ?? 'Empty') === b)));
    const max = Math.max(1, ...grid.flat().filter(v => v != null));
    return { R: R.slice(0, 200), C, grid, rowTot, colTot, all: agg(rows), max };
  }, [rows, rd, cd, m]);

  if (!rd || !cd) return <div className="py-12 text-center text-[13px] text-[#6e6259]">A pivot needs two text columns. This result has {dims.length}. Try the Chart view.</div>;
  const word = m === 'count' || m.startsWith('sum') ? 'Total' : 'All';
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Select label="Rows" value={rd.c.name} onChange={setR} options={dims.map(d => [d.c.name, d.c.name])} />
        <Select label="Columns" value={cd.c.name} onChange={setC} options={dims.filter(d => d !== rd).map(d => [d.c.name, d.c.name])} />
        <Select label="Measure" value={m} onChange={setMeasure} options={mOpts} />
        <span className="ml-auto"><Note rows={rows.length} total={total} /></span>
      </div>
      <div className="inline-block max-w-full overflow-auto rounded-xl border border-[#e8e6e3]">
        <table className="border-separate border-spacing-0 text-[12.5px] tabular-nums">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 h-8 px-3 text-left bg-[#f8f7f5] border-b border-[#e8e6e3] font-bold text-[#312c2a]" title={rd.c.name}><div className="max-w-[320px] truncate">{rd.c.name}</div></th>
              {table.C.map(k => <th key={k} className="sticky top-0 z-10 h-8 px-3 text-right bg-[#f8f7f5] border-b border-[#e8e6e3] font-medium text-[#6e6259] whitespace-nowrap"><div className="max-w-[200px] truncate ml-auto">{k}</div></th>)}
              <th className="sticky top-0 z-10 h-8 px-3 text-right bg-[#f8f7f5] border-b border-l border-[#e8e6e3] font-bold text-[#312c2a]">{word}</th>
            </tr>
          </thead>
          <tbody>
            {table.R.map((a, ri) => (
              <tr key={a}>
                <td className="sticky left-0 z-10 h-8 px-3 bg-white border-b border-[#f1efed] whitespace-nowrap text-[#312c2a]"><div className="max-w-[320px] truncate">{a}</div></td>
                {table.grid[ri].map((v, ci) => {
                  const t = v == null ? 0 : 0.08 + v / table.max * 0.72;
                  return (
                    <td key={ci} className="h-9 px-3 text-right border-b border-[#f1efed]" style={{ background: v == null ? undefined : `color-mix(in srgb, ${accent} ${Math.round(t * 100)}%, white)`, color: t > 0.5 ? '#fff' : undefined }}>
                      {v == null ? <span className="text-[#cbc4bc]">-</span> : fmt(v)}
                    </td>
                  );
                })}
                <td className="h-9 px-3 text-right border-b border-l border-[#f1efed] font-bold">{fmt(table.rowTot[ri])}</td>
              </tr>
            ))}
            <tr>
              <td className="sticky left-0 z-10 h-8 px-3 bg-white border-t border-[#e8e6e3] font-bold">{word}</td>
              {table.colTot.map((v, i) => <td key={i} className="h-9 px-3 text-right border-t border-[#e8e6e3] font-bold">{fmt(v)}</td>)}
              <td className="h-9 px-3 text-right border-t border-l border-[#e8e6e3] font-bold">{fmt(table.all)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
