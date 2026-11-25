import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play } from 'lucide-react';
import { PeerLayer } from './collab';
import {
  caretPixelPos, clauseAtCaret, fetchJson, parseTableRefs, PG_SUGGESTIONS, rankSuggestions, resolveRef, sqlTokenAtCaret, STATIC_SUGGESTIONS,
  TOKEN_COLORS, tokenizeSql,
} from '../shared/studioHelpers';
import { displayType, firstName, FMT_IND, formatSql, MOD, sigVars, statementSpans, T, useEngine, withQs } from './paneLib';

const peerLabel = (peer) => firstName(peer.name);

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

export const SfEditor = forwardRef(function SfEditor({ value, onChange: setValue, historyKey, onRun, onRunAll, onSave, theme = 'light', defaultDb, defaultSchema, placeholder, cq = '', readOnly = false, session = null, peerColor, onSelect, catalogVersion = 0 }, ref) {
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
  // Objects changed: suggest from fresh lists, not the ones read before.
  useEffect(() => { objectCache.current = {}; }, [catalogVersion]);
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
  }, [E.api, cq]);

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
