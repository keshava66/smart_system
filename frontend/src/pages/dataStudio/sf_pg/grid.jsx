import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChartColumnBig, ChevronLeft, CopyPlus, Filter, KeyRound, Trash2, Undo2, X } from 'lucide-react';
import { cellText, DEFAULT_COL_WIDTH, FILTER_OPS, formatBytes, MAX_COL_WIDTH, MIN_COL_WIDTH } from '../shared/studioHelpers';
import { colGlyph, displayType, fmtN, isBig, plural, sigVars, typeFamily, useEngine } from './paneLib';
import { Button, Skel } from './paneUi';

// Result grid modelled on the DBeaver data editor: row numbers, sticky
// header, type under each column name, right aligned numbers, NULL shown as
// a quiet badge, click to select a cell and Ctrl/Cmd+C to copy it.

const ROW_H = 28;

const HEAD_H = 66;

   // name, type and a small chart of the values
const HEAD_H_SLIM = 46;

   // name and type only

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
export function Floating({ align = 'left', className = '', style, boxRef, children, ...rest }) {
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
export function FilterButton({ columns, fetchValues, onAdd, count, compact }) {
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
export function FilterBar({ filters, onRemove, onClear }) {
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

const GRID_FNS = ['setWidths', 'onSort', 'onFilter', 'onEditCell', 'onToggleDelete', 'onEditNewCell', 'onRemoveNewRow', 'onOpenCell', 'onCopied', 'onRowSelect', 'onCopyRow', 'onSelection'];

export function SfGrid(props) {
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
