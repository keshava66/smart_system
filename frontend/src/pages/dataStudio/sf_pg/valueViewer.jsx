import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ChevronUp, Copy, Download, Link2,
  ListTree, Maximize2, Search, TriangleAlert, WrapText, X,
} from 'lucide-react';
import { cellText } from '../shared/studioHelpers';
import { Button, IconButton, Modal, Spinner, ViewTab } from './paneUi';
import { fmtN, isBig, plural, useEngine } from './paneLib';

// One cell, opened from the results grid: JSON as a tree you can fold and
// search, anything else as text with line numbers. Big cells the grid only
// has the start of load in full on open (up to AUTO_LOAD_BYTES).

const AUTO_LOAD_BYTES = 1024 * 1024;
const PARSE_MAX_CHARS = 5_000_000;     // past this JSON is shown as text only
const TREE_MAX_NODES = 300_000;        // past this the tree would be too slow to fold
const CHILDREN_PAGE = 200;             // children shown per object / array, more on request
const ROWS_PAGE = 2_000;               // tree rows drawn, more on request
const TEXT_MAX_LINES = 20_000;         // text view lines drawn; Copy and Download have all of it
const HIGHLIGHT_MAX_CHARS = 1_500_000;
const STRING_CLAMP = 280;              // long strings show this much until opened
const MATCH_MAX = 1_000;

const COLORS = { key: '#7a2f8e', string: '#1f6b3a', number: '#0b5cad', boolean: '#a14a00', null: '#8a7f78', punct: '#a39992' };

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const childId = (id, key) => `${id}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const pathText = (path) => path.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : IDENT.test(k) ? `${s}.${k}` : `${s}[${JSON.stringify(k)}]`), '$');
const entriesOf = (v) => (Array.isArray(v) ? v.map((c, i) => [i, c]) : Object.entries(v));
const sizeLabel = (v) => (Array.isArray(v) ? plural(v.length, 'item') : plural(Object.keys(v).length, 'key'));
const scalarText = (v) => (typeof v === 'string' ? v : String(v));

const countNodes = (root, cap) => {
  let n = 0;
  const stack = [root];
  while (stack.length && n <= cap) {
    const v = stack.pop();
    n += 1;
    if (v && typeof v === 'object') for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push(c);
  }
  return n;
};

// Every key or scalar value containing q, depth first, with its ancestors so
// the tree can open the way to it.
const findMatches = (root, q) => {
  const out = [];
  const walk = (v, id, path, ancestors) => {
    if (out.length >= MATCH_MAX) return;
    const key = path[path.length - 1];
    const keyHit = path.length > 0 && typeof key === 'string' && key.toLowerCase().includes(q);
    const isLeaf = v === null || typeof v !== 'object';
    const valueHit = isLeaf && scalarText(v).toLowerCase().includes(q);
    if (keyHit || valueHit) out.push({ id, path, ancestors, keyHit, valueHit });
    if (isLeaf) return;
    const next = [...ancestors, { id, size: Array.isArray(v) ? v.length : Object.keys(v).length }];
    let i = 0;
    for (const [k, c] of entriesOf(v)) {
      next[next.length - 1].index = i;
      walk(c, childId(id, k), [...path, k], next.map(a => ({ ...a })));
      i += 1;
      if (out.length >= MATCH_MAX) return;
    }
  };
  walk(root, '', [], []);
  return out;
};

// Rows for what is open, in order. Closing brackets aren't rows: an open
// node's summary sits on its own line, like a file tree.
const flatten = (root, isOpen, shownOf) => {
  const rows = [];
  const walk = (v, id, path, depth) => {
    const kind = kindOf(v);
    const container = kind === 'object' || kind === 'array';
    const open = container && (depth === 0 || isOpen(id, depth));
    rows.push({ id, path, depth, value: v, kind, container, open });
    if (!open) return;
    const all = entriesOf(v);
    const shown = shownOf(id);
    for (const [k, c] of all.slice(0, shown)) walk(c, childId(id, k), [...path, k], depth + 1);
    if (all.length > shown) rows.push({ id: `${id}#more`, more: true, parent: id, depth: depth + 1, left: all.length - shown });
  };
  walk(root, '', [], 0);
  return rows;
};

function Marked({ text, q, current }) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className={`rounded-[2px] text-inherit ${current ? 'bg-[#ffb74d]' : 'bg-[#ffe8a3]'}`}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

function RowActions({ row, onCopied }) {
  const copyValue = async () => {
    const v = row.value;
    if (await copyText(row.container ? JSON.stringify(v, null, 2) : scalarText(v))) onCopied('Value copied');
  };
  const copyPath = async () => { if (await copyText(pathText(row.path))) onCopied('Path copied'); };
  return (
    <span className="ml-auto pl-2 flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100 transition-opacity">
      {row.depth > 0 && <IconButton icon={Link2} label={`Copy path ${pathText(row.path)}`} size={22} iconSize={12} onClick={copyPath} />}
      <IconButton icon={Copy} label="Copy value" size={22} iconSize={12} onClick={copyValue} />
    </span>
  );
}

function TreeRow({ row, q, match, current, toggle, stringOpen, toggleString, showMore, onCopied }) {
  const pad = { paddingLeft: 10 + row.depth * 18 };
  if (row.more) {
    return (
      <div className="flex items-center h-[28px]" style={pad}>
        <button type="button" onClick={() => showMore(row.parent)} className="ml-[18px] text-[12px] font-medium text-[var(--sig-ink)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] rounded">
          Show {fmtN(Math.min(CHILDREN_PAGE, row.left))} more of {fmtN(row.left)}
        </button>
      </div>
    );
  }
  const key = row.path[row.path.length - 1];
  const keyQ = match?.keyHit ? q : '';
  const valQ = match?.valueHit ? q : '';
  let value;
  if (row.container) {
    value = (
      <span className="text-[#8a7f78]">
        <span style={{ color: COLORS.punct }}>{row.kind === 'array' ? '[' : '{'}</span>
        <span className="mx-1 text-[11.5px] font-johnson-text">{sizeLabel(row.value)}</span>
        <span style={{ color: COLORS.punct }}>{row.kind === 'array' ? ']' : '}'}</span>
      </span>
    );
  } else if (row.kind === 'string') {
    const s = row.value;
    const long = s.length > STRING_CLAMP || s.split('\n', 6).length > 5;
    const open = !long || stringOpen;
    const shown = open ? s : s.slice(0, STRING_CLAMP).split('\n').slice(0, 5).join('\n');
    value = (
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: COLORS.string }}>
        <span style={{ color: COLORS.punct }}>&quot;</span><Marked text={shown} q={valQ} current={current} />{!open && '…'}<span style={{ color: COLORS.punct }}>&quot;</span>
        {long && (
          <button type="button" onClick={toggleString} className="ml-2 align-baseline font-johnson-text text-[11.5px] font-medium text-[var(--sig-ink)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] rounded">
            {open ? 'Show less' : `Show all · ${fmtN(s.length)} chars`}
          </button>
        )}
      </span>
    );
  } else {
    value = <span style={{ color: COLORS[row.kind] || COLORS.null }}><Marked text={scalarText(row.value)} q={valQ} current={current} /></span>;
  }
  return (
    <div
      data-id={row.id}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.container ? row.open : undefined}
      className={`group relative flex items-start min-h-[28px] py-[4px] pr-2 rounded-md ${current ? 'bg-[#fff3d6]' : 'hover:bg-[#f4f2f0]'}`}
      style={pad}
    >
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-[#ece8e4]" style={{ left: 18 + i * 18 }} />
      ))}
      {row.container && row.depth > 0 ? (
        <button
          type="button"
          onClick={() => toggle(row.id, row.open)}
          aria-label={row.open ? 'Collapse' : 'Expand'}
          className="flex-shrink-0 w-[18px] h-[20px] -ml-[2px] flex items-center justify-center rounded text-[#8a7f78] hover:text-[#312c2a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]"
        >
          {row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : <span className="flex-shrink-0 w-[18px]" />}
      <span className="min-w-0 flex-1 font-mono text-[12.5px] leading-[20px]">
        {row.depth > 0 && (
          <>
            {typeof key === 'number'
              ? <span className="text-[#a39992]">{key}</span>
              : <span style={{ color: COLORS.key }} className="font-medium"><Marked text={key} q={keyQ} current={current} /></span>}
            <span className="mr-1.5" style={{ color: COLORS.punct }}>:</span>
          </>
        )}
        {value}
      </span>
      <RowActions row={row} onCopied={onCopied} />
    </div>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
function JsonLine({ line }) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(JSON_TOKEN)) {
    if (m.index > at) out.push(line.slice(at, m.index));
    const [whole, str, colon, lit, num] = m;
    const color = str ? (colon ? COLORS.key : COLORS.string) : lit ? (lit === 'null' ? COLORS.null : COLORS.boolean) : num ? COLORS.number : undefined;
    out.push(<span key={m.index} style={{ color }}>{str || whole}</span>);
    if (colon) out.push(colon);
    at = m.index + whole.length;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}

export function ValueViewer({ cell, onClose }) {
  const E = useEngine();
  const open = !!cell;
  const [full, setFull] = useState(null);      // { text, truncated, size } | { error }
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('tree');
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [toast, setToast] = useState('');
  const bodyRef = useRef(null);
  const searchRef = useRef(null);

  const raw = cell?.value;
  const big = isBig(raw);
  const preview = big && !full?.text;

  const load = useCallback(async () => {
    if (!cell?.loadFull) return;
    setLoading(true);
    try {
      const got = await cell.loadFull();
      const t = got.value === null || got.value === undefined ? null : typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
      setFull({ text: t, truncated: got.truncated, size: got.size });
    } catch (err) {
      setFull({ error: err.message || 'Could not load the value' });
    } finally {
      setLoading(false);
    }
  }, [cell]);

  // A new cell starts clean; a big one loads in full straight away when it is small enough.
  useEffect(() => {
    setFull(null);
    setQuery('');
    setHit(0);
    setLoading(false);
    if (cell && isBig(cell.value) && cell.loadFull && (cell.value.size || 0) <= AUTO_LOAD_BYTES) load();
  }, [cell, load]);

  const text = full && 'text' in full ? full.text : big ? raw.preview : cellText(raw);
  const isNull = text === null || text === undefined;

  const parsed = useMemo(() => {
    if (isNull || preview || text.length > PARSE_MAX_CHARS || !/^\s*[[{]/.test(text)) return null;
    try {
      const value = JSON.parse(text);
      return { value, pretty: JSON.stringify(value, null, 2), tree: countNodes(value, TREE_MAX_NODES) <= TREE_MAX_NODES };
    } catch { return null; }
  }, [text, isNull, preview]);

  const view = parsed?.tree && mode === 'tree' ? 'tree' : 'text';
  const shownText = parsed ? parsed.pretty : (text ?? '');
  const q = query.trim().toLowerCase();

  /* ------------------------------ tree state ------------------------------ */
  const [depthOpen, setDepthOpen] = useState(2);           // levels open by default
  const [overrides, setOverrides] = useState(() => new Map());
  const [shown, setShown] = useState(() => new Map());
  const [stringOpen, setStringOpen] = useState(() => new Map());
  const [rowLimit, setRowLimit] = useState(ROWS_PAGE);
  useEffect(() => {
    setDepthOpen(2); setOverrides(new Map()); setShown(new Map()); setStringOpen(new Map()); setRowLimit(ROWS_PAGE);
  }, [parsed]);

  const matches = useMemo(() => (view === 'tree' && q ? findMatches(parsed.value, q) : []), [view, q, parsed]);
  const matchById = useMemo(() => new Map(matches.map(m => [m.id, m])), [matches]);
  // Searching opens the way to every match, and the strings it is in.
  const forced = useMemo(() => {
    const ids = new Set();
    const need = new Map();
    const strings = new Set();
    for (const m of matches) {
      for (const a of m.ancestors) {
        ids.add(a.id);
        need.set(a.id, Math.max(need.get(a.id) || 0, a.index + 1));
      }
      if (m.valueHit) strings.add(m.id);
    }
    return { ids, need, strings };
  }, [matches]);
  useEffect(() => {
    if (!forced.ids.size) return;
    setOverrides(prev => {
      const next = new Map(prev);
      for (const id of forced.ids) next.delete(id);
      return next;
    });
  }, [forced]);

  const isOpen = useCallback((id, depth) => (overrides.has(id) ? overrides.get(id) : forced.ids.has(id) || depth < depthOpen), [overrides, forced, depthOpen]);
  const shownOf = useCallback((id) => Math.max(shown.get(id) || CHILDREN_PAGE, forced.need.get(id) || 0), [shown, forced]);
  const rows = useMemo(() => (view === 'tree' ? flatten(parsed.value, isOpen, shownOf) : []), [view, parsed, isOpen, shownOf]);

  /* ------------------------------ text state ------------------------------ */
  const lines = useMemo(() => (view === 'text' ? shownText.split('\n') : []), [view, shownText]);
  const textMatches = useMemo(() => {
    if (view !== 'text' || !q) return [];
    const out = [];
    for (let i = 0; i < lines.length && out.length < MATCH_MAX; i += 1) {
      const l = lines[i].toLowerCase();
      for (let at = l.indexOf(q); at !== -1 && out.length < MATCH_MAX; at = l.indexOf(q, at + q.length)) out.push({ line: i, at });
    }
    return out;
  }, [view, q, lines]);

  const total = view === 'tree' ? matches.length : textMatches.length;
  const current = total ? Math.min(hit, total - 1) : -1;
  const currentId = view === 'tree' && current >= 0 ? matches[current].id : null;
  const currentLine = view === 'text' && current >= 0 ? textMatches[current].line : -1;
  useEffect(() => { setHit(0); }, [q, view]);

  // Keep the current match drawn, then bring it into view.
  const currentRow = currentId == null ? -1 : rows.findIndex(r => r.id === currentId);
  useEffect(() => {
    if (currentRow >= rowLimit) setRowLimit(Math.ceil((currentRow + 1) / ROWS_PAGE) * ROWS_PAGE);
  }, [currentRow, rowLimit]);
  useEffect(() => {
    const box = bodyRef.current;
    if (!box) return;
    const sel = currentId != null ? `[data-id="${CSS.escape(currentId)}"]` : currentLine >= 0 ? `[data-line="${currentLine}"]` : null;
    if (sel) box.querySelector(sel)?.scrollIntoView({ block: 'center' });
  }, [currentId, currentLine, rowLimit]);

  const step = (d) => { if (total) setHit(h => (Math.min(h, total - 1) + d + total) % total); };
  const toggle = (id, wasOpen) => setOverrides(prev => new Map(prev).set(id, !wasOpen));
  const isStringOpen = (id) => (stringOpen.has(id) ? stringOpen.get(id) : forced.strings.has(id));
  const toggleString = (id, wasOpen) => setStringOpen(prev => new Map(prev).set(id, !wasOpen));
  const showMore = (id) => setShown(prev => new Map(prev).set(id, shownOf(id) + CHILDREN_PAGE));
  const setAll = (depth) => { setOverrides(new Map()); setDepthOpen(depth); setRowLimit(ROWS_PAGE); };

  const flash = useCallback((msg) => { setToast(msg); }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 1400);
    return () => clearTimeout(t);
  }, [toast]);

  const copyAll = async () => { if (await copyText(parsed ? parsed.pretty : (text ?? 'NULL'))) flash('Copied'); };
  const download = () => {
    const blob = new Blob([parsed ? parsed.pretty : (text ?? '')], { type: parsed ? 'application/json' : 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(cell?.title || 'value').replace(/[^\w.-]+/g, '_')}.${parsed ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !isNull) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };
  const onSearchKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
  };

  const meta = [
    cell?.type,
    parsed ? 'JSON' : null,
    isNull ? null : `${fmtN(preview ? raw.size : shownText.length)} ${preview ? 'bytes' : 'characters'}`,
    !isNull && !preview && view === 'text' ? plural(lines.length, 'line') : null,
  ].filter(Boolean);
  const drawnLines = lines.length > TEXT_MAX_LINES ? lines.slice(0, TEXT_MAX_LINES) : lines;
  const highlight = parsed && shownText.length <= HIGHLIGHT_MAX_CHARS;

  return (
    <Modal open={open} onClose={onClose} width={1040} labelledBy="sf-value-title">
      <div className="flex flex-col h-[min(86vh,860px)] min-h-0" onKeyDown={onKeyDown}>
        {/* header */}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-5 pt-4 pb-3 border-b border-[#e8e6e3]">
          <div className="min-w-0 flex-1 basis-[220px]">
            <h3 id="sf-value-title" className="font-johnson-display font-bold text-[16px] leading-tight text-[#312c2a] break-all">{cell?.title}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {meta.map((m, i) => (
                <span key={m} className={`inline-flex items-center h-[20px] px-2 rounded-full text-[11px] ${i === 0 && cell?.type ? 'font-mono bg-[var(--sig-soft)] text-[var(--sig-ink)]' : 'bg-[#f1efed] text-[#6e6259]'}`}>{m}</span>
              ))}
              {preview && !loading && <span className="inline-flex items-center h-[20px] px-2 rounded-full text-[11px] bg-[#fff3ea] text-[#a14a00]">Showing the start only</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            {preview && cell?.loadFull && (
              <Button variant="primary" icon={loading ? undefined : Maximize2} disabled={loading} onClick={load}>
                {loading ? <><Spinner size={12} /> Loading…</> : 'Load full value'}
              </Button>
            )}
            {!isNull && !preview && <Button icon={Download} onClick={download}>Download</Button>}
            {!isNull && <Button icon={toast === 'Copied' ? Check : Copy} onClick={copyAll}>{toast === 'Copied' ? 'Copied' : 'Copy'}</Button>}
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
        </div>

        {/* toolbar */}
        {!isNull && (
          <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-[#e8e6e3] bg-[#fbfaf9]">
            {parsed?.tree && (
              <div role="tablist" aria-label="View" className="flex items-center gap-0.5 p-0.5 rounded-[9px] bg-[#efedea]">
                <ViewTab active={view === 'tree'} onClick={() => setMode('tree')} icon={ListTree} accent={E.accent} title="Fold and unfold the JSON">Tree</ViewTab>
                <ViewTab active={view === 'text'} onClick={() => setMode('text')} icon={AlignLeft} accent={E.accent} title="The formatted JSON as text">Text</ViewTab>
              </div>
            )}
            <div className="flex items-center flex-1 min-w-[200px] max-w-[420px] h-[30px] rounded-md border border-[#d5cfc9] bg-white focus-within:border-[var(--sig)] focus-within:ring-2 focus-within:ring-[var(--sig-ring)]">
              <Search size={14} className="ml-2.5 flex-shrink-0 text-[#8a7f78]" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={view === 'tree' ? 'Search keys and values' : 'Search'}
                aria-label="Search in this value"
                className="flex-1 min-w-0 h-full px-2 bg-transparent text-[12.5px] text-[#312c2a] placeholder:text-[#a39992] focus:outline-none"
              />
              {q && (
                <>
                  <span className="flex-shrink-0 px-1 text-[11.5px] tabular-nums text-[#6e6259]" aria-live="polite">
                    {total ? `${current + 1} of ${fmtN(total)}${total >= MATCH_MAX ? '+' : ''}` : 'No matches'}
                  </span>
                  <IconButton icon={ChevronUp} label="Previous match (Shift+Enter)" size={24} iconSize={13} disabled={!total} onClick={() => step(-1)} />
                  <IconButton icon={ChevronDown} label="Next match (Enter)" size={24} iconSize={13} disabled={!total} onClick={() => step(1)} />
                  <IconButton icon={X} label="Clear search" size={24} iconSize={13} className="mr-0.5" onClick={() => setQuery('')} />
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {view === 'tree' ? (
                <>
                  <Button icon={ChevronsUpDown} onClick={() => setAll(Infinity)}>Expand all</Button>
                  <Button icon={ChevronsDownUp} onClick={() => setAll(1)}>Collapse all</Button>
                </>
              ) : (
                <Button icon={WrapText} onClick={() => setWrap(w => !w)} aria-pressed={wrap} className={wrap ? '!bg-[var(--sig-soft)] !text-[var(--sig-ink)]' : ''}>Wrap</Button>
              )}
            </div>
          </div>
        )}

        {full?.error && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-md bg-[#fdf3f1] px-3 py-2 text-[12.5px] text-[#9e0000]">
            <TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />{full.error}
          </div>
        )}
        {full?.truncated && (
          <div className="mx-5 mt-3 rounded-md bg-[#fff6e5] px-3 py-2 text-[12.5px] text-[#7a4a00]">
            This value is {fmtN(full.size)} characters; the first {fmtN((full.text || '').length)} are here. Download the query result for all of it.
          </div>
        )}

        {/* body */}
        <div ref={bodyRef} className="relative flex-1 min-h-0 overflow-auto bg-white">
          {isNull ? (
            <div className="h-full flex items-center justify-center">
              <span className="px-3 py-1 rounded-full bg-[#f1efed] font-mono text-[12.5px] text-[#8a7f78]">NULL</span>
            </div>
          ) : view === 'tree' ? (
            <div role="tree" aria-label={`${cell?.title} value`} className="px-3 py-3">
              {rows.slice(0, rowLimit).map((row) => {
                const strOpen = isStringOpen(row.id);
                return (
                  <TreeRow
                    key={row.id}
                    row={row}
                    q={q}
                    match={matchById.get(row.id)}
                    current={row.id === currentId}
                    toggle={toggle}
                    stringOpen={strOpen}
                    toggleString={() => toggleString(row.id, strOpen)}
                    showMore={showMore}
                    onCopied={flash}
                  />
                );
              })}
              {rows.length > rowLimit && (
                <div className="py-3 text-center">
                  <Button onClick={() => setRowLimit(l => l + ROWS_PAGE)}>Show {fmtN(Math.min(ROWS_PAGE, rows.length - rowLimit))} more rows</Button>
                </div>
              )}
            </div>
          ) : (
            <div className={`py-3 font-mono text-[12.5px] leading-[20px] text-[#312c2a] ${wrap ? '' : 'w-max min-w-full'}`}>
              {drawnLines.map((line, i) => (
                <div key={i} data-line={i} className={`flex ${i === currentLine ? 'bg-[#fff3d6]' : ''}`}>
                  <span aria-hidden="true" className="sticky left-0 flex-shrink-0 w-[56px] pr-3 text-right select-none text-[#b8afa8] bg-inherit">{i + 1}</span>
                  <span className={`flex-1 min-w-0 pr-5 ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>
                    {q && line.toLowerCase().includes(q)
                      ? <Marked text={line} q={q} current={i === currentLine} />
                      : highlight ? <JsonLine line={line} /> : line || ' '}
                  </span>
                </div>
              ))}
              {lines.length > TEXT_MAX_LINES && (
                <div className="px-5 pt-3 font-johnson-text text-[12px] text-[#6e6259]">
                  The first {fmtN(TEXT_MAX_LINES)} of {fmtN(lines.length)} lines are shown. Copy or Download for all of it.
                </div>
              )}
              {preview && (
                <div className="px-5 pt-3 font-johnson-text text-[12px] text-[#6e6259]">
                  {loading ? 'Loading the full value…' : 'Only the start of this value is here. Load full value to see all of it.'}
                </div>
              )}
            </div>
          )}
          {toast && toast !== 'Copied' && (
            <div role="status" className="sticky bottom-3 float-right mr-4 px-3 py-1.5 rounded-lg bg-[#312c2a] text-white text-[12px] shadow-lg">{toast}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
