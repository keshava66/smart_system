import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronRight, Code2, Copy, Database, ArrowRightToLine, Eye, Info, KeyRound, Layers, Loader2, PanelLeftClose, Pencil, Play, RefreshCw,
  RotateCcw, Search, Table2, X,
} from 'lucide-react';
import { fetchJson, formatBytes } from '../shared/studioHelpers';
import { colGlyph, displayType, fmtN, plural, T, useEngine, withQs } from './paneLib';
import { Button, Highlight, IconButton, Skel, SqlCode } from './paneUi';

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
export function TableDetails({ info, cq, onClose, onPreview, onInsert, onToast }) {
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
    fetchJson(withQs(`${E.api}/columns?database=${q(info.database)}&schema=${q(info.schema)}&table=${q(info.table)}&bypass_cache=true`, cq))
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

// What the tree looked like (expanded nodes, how each was read, scroll and
// selection), per engine and login/role, so a reload puts it back.
const PICK = { schemas: d => d.schemas || [], tables: d => d.tables || [], columns: d => d.columns || [] };
const readTree = (key) => {
  try {
    const t = JSON.parse(window.localStorage.getItem(key) || 'null');
    return t && Array.isArray(t.open) && Array.isArray(t.loads) ? t : null;
  } catch { return null; }
};
const writeTree = (key, tree) => {
  try { window.localStorage.setItem(key, JSON.stringify(tree)); } catch { /* storage full or blocked */ }
};

export function SfExplorer({
  onInsert, onPreview, onEditData, onShowDdl, onCollapse, onSelect, selected,
  reveal, logInPage, canEdit = true, onToast, cq = '', onDetails, catalogVersion = 0, onRefresh,
}) {
  const E = useEngine();
  const [databases, setDatabases] = useState(null);
  const [dbError, setDbError] = useState(null);
  const [search, setSearch] = useState('');
  const treeKey = `${E.store}.explorerTree.${cq || 'default'}`;
  const saved = useRef(undefined);
  if (saved.current === undefined) saved.current = readTree(treeKey);
  const [open, setOpen] = useState(() => new Set(saved.current?.open || []));
  const cache = useRef({ schemas: {}, tables: {}, columns: {} });
  const [, tick] = useState(0);
  const rerender = useCallback(() => tick(t => t + 1), []);
  const searchRef = useRef(null);

  // The tree always reads live from the database (bypass_cache), so a reload
  // or Refresh shows objects created, dropped or renamed anywhere, not only
  // here. `req` remembers how each loaded node was fetched, and `seq` makes a
  // late answer from an older request lose to a newer one.
  const req = useRef({ schemas: {}, tables: {}, columns: {} });
  const seq = useRef({ databases: 0 });
  const openRef = useRef(open);
  const scrollTop = useRef(saved.current?.scroll || 0);
  const selectedRef = useRef(selected);
  const persist = useCallback(() => {
    const loads = [];
    for (const bucket of Object.keys(req.current)) {
      for (const [key, r] of Object.entries(req.current[bucket])) {
        if (openRef.current.has(r.openKey)) loads.push({ bucket, key, url: r.url, openKey: r.openKey });
      }
    }
    writeTree(treeKey, { open: [...openRef.current], loads, scroll: scrollTop.current, selected: selectedRef.current || null });
  }, [treeKey]);
  useEffect(() => { openRef.current = open; persist(); }, [open, persist]);
  useEffect(() => {
    if (!selected || selected === selectedRef.current) return;
    selectedRef.current = selected;
    persist();
  }, [selected, persist]);

  const loadDatabases = useCallback(() => {
    const n = ++seq.current.databases;
    setDbError(null);
    fetchJson(withQs(`${E.api}/databases?bypass_cache=true`, cq))
      .then(data => { if (n === seq.current.databases) setDatabases(data.databases || []); })
      .catch(err => { if (n === seq.current.databases) setDbError(err); });
  }, [E.api, cq]);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);

  const load = useCallback((bucket, key, url, pick, force = false, openKey = '') => {
    const store = cache.current[bucket];
    if (!force && store[key] !== undefined && !(store[key] instanceof Error)) return;
    req.current[bucket][key] = { url, pick, openKey };
    persist();
    const id = `${bucket}|${key}`;
    const n = (seq.current[id] || 0) + 1;
    seq.current[id] = n;
    // A re-read keeps showing what was there until the answer lands, so the
    // tree doesn't collapse to skeletons and lose its scroll position.
    if (!(force && Array.isArray(store[key]))) store[key] = 'loading';
    rerender();
    fetchJson(url)
      .then(data => { if (seq.current[id] === n) { store[key] = pick(data); rerender(); } })
      .catch(err => { if (seq.current[id] === n) { store[key] = err; rerender(); } });
  }, [rerender, persist]);

  const loadSchemas = useCallback((db, force) => load('schemas', db,
    withQs(`${E.api}/schemas?database=${enc(db)}&bypass_cache=true`, cq), d => d.schemas || [], force, `d:${db}`), [load, E.api, cq]);
  const loadTables = useCallback((db, schema, force) => load('tables', `${db}.${schema}`,
    withQs(`${E.api}/tables?database=${enc(db)}&schema=${enc(schema)}&bypass_cache=true`, cq), d => d.tables || [], force,
    `s:${db}.${schema}`), [load, E.api, cq]);
  const loadColumns = useCallback((db, schema, table, force) => load('columns', `${db}.${schema}.${table}`,
    withQs(`${E.api}/columns?database=${enc(db)}&schema=${enc(schema)}&table=${enc(table)}&bypass_cache=true`, cq), d => d.columns || [],
    force, `t:${db}.${schema}.${table}`), [load, E.api, cq]);

  // Put back what was expanded before the reload, read fresh, and the selection.
  useEffect(() => {
    const t = saved.current;
    if (!t) return;
    for (const l of t.loads) {
      if (PICK[l.bucket] && typeof l.url === 'string' && openRef.current.has(l.openKey)) load(l.bucket, l.key, l.url, PICK[l.bucket], true, l.openKey);
    }
    if (t.selected && !selectedRef.current) onSelect?.(t.selected);
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-read everything that is expanded, keeping the tree as it is. What is
  // collapsed is forgotten and read fresh when it is opened again.
  const reloadTree = useCallback(() => {
    if (E.id === 'snowflake') {
      fetchJson(withQs(`${E.api}/search-tables/warm?force=true`, cq), { method: 'POST' }).catch(() => {});
    }
    loadDatabases();
    for (const bucket of Object.keys(cache.current)) {
      const store = cache.current[bucket];
      for (const key of Object.keys(store)) {
        const r = req.current[bucket][key];
        if (r && openRef.current.has(r.openKey)) load(bucket, key, r.url, r.pick, true, r.openKey);
        else delete store[key];
      }
    }
    rerender();
  }, [E.id, E.api, cq, loadDatabases, load, rerender]);

  // A run, copy or Refresh changed objects: the pane bumps catalogVersion.
  const seenVersion = useRef(catalogVersion);
  useEffect(() => {
    if (seenVersion.current === catalogVersion) return;
    seenVersion.current = catalogVersion;
    reloadTree();
  }, [catalogVersion, reloadTree]);

  // Refresh also clears the server's cached lists, for the pickers and the
  // search as well as this tree, then lets the pane tell everyone.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    logInPage?.(`${E.log}_explorer_refresh`, `Refreshed the ${E.label} explorer`);
    fetchJson(withQs(`${E.api}/catalog/refresh`, cq), { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        setRefreshing(false);
        if (onRefresh) onRefresh();
        else reloadTree();
      });
  };

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
  }, [canFind, cq, E.api]);

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
  }, [q, findOn, cq, E.api]);

  // refresh button should also drop cached search results
  useEffect(() => { findCache.current.clear(); lastFound.current = { q: '', data: null }; }, [databases]);

  // After a search hit is opened, wait for its schema to load and the row
  // to render, then scroll the tree so the row sits in the middle.
  const treeRef = useRef(null);

  // Scroll: saved as you scroll; after a reload it is put back once the
  // restored nodes have all loaded, so rows above it are already in place.
  // Touching the tree first cancels that.
  const pendingScroll = useRef(scrollTop.current > 0 ? scrollTop.current : null);
  const saveTimer = useRef(0);
  useLayoutEffect(() => {
    const box = treeRef.current;
    const want = pendingScroll.current;
    if (want == null || !box || !databases) return;
    const busy = Object.values(cache.current).some(b => Object.values(b).includes('loading'));
    if (!busy) {
      box.scrollTop = want;
      pendingScroll.current = null;
    }
  });
  const onTreeScroll = () => {
    if (pendingScroll.current != null) return;
    scrollTop.current = treeRef.current?.scrollTop || 0;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 200);
  };
  const stopRestore = () => { pendingScroll.current = null; };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
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
    <div className="flex flex-col h-full min-h-0 bg-white" data-tip-delay>
      <div className="flex-shrink-0 flex items-center gap-2 h-[44px] pl-4 pr-2 border-b border-[#e8e6e3]">
        <Database size={15} strokeWidth={2} className="text-[var(--sig-ink)] flex-shrink-0" />
        <span className="text-[13px] font-bold text-[#312c2a] truncate">Databases</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={RefreshCw} label="Refresh objects" onClick={refresh} disabled={refreshing} aria-busy={refreshing}
            className={refreshing ? '[&_svg]:animate-spin' : ''} />
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

      <div ref={treeRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-3" role="tree" aria-label={`${E.label} objects`}
        onScroll={onTreeScroll} onWheel={stopRestore} onPointerDown={stopRestore} onKeyDown={stopRestore} onTouchStart={stopRestore}>
        {databases === null && !dbError && <TreeSkeleton depth={0} count={7} />}
        {dbError && <NodeError error={dbError} depth={0} onRetry={loadDatabases} />}
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
