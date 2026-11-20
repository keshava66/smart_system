import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRBAC } from "../context/RBACContext";
import { apiFetch } from "../utils/apiClient";
import { usePerfTier } from "../utils/perfTier";
import "./FuzzyMatch.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LOGO = '/sh_logo.png';
const STORAGE_KEY = 'jj_fuzzy_search_data';   // AuthContext clears it on sign-out
const META_VIEW_KEY = 'fm_meta_view';
const RAIL_KEY = 'fm_rail_w';
const RAIL_MIN = 200;
const RAIL_MAX = 640;
const RAIL_DEF = 300;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SOURCES = [
  { id: 'grail', label: 'GRAIL', color: '#0f68b2' },
  { id: 'insight', label: 'Insight', color: '#8c3bbb' },
  { id: 'insight7', label: 'Insight7', color: '#b19beb' },
  { id: 'lift', label: 'LIFT', color: '#328714' },
  { id: 'rimdocs', label: 'RIMDocs', color: '#ff6017' },
  { id: 'urp', label: 'URP', color: '#3fb6e8' },
];
const OTHER = { id: 'other', label: 'Other', color: '#a39992' };
const ALL_SOURCES = [...SOURCES, OTHER];
const srcById = Object.fromEntries(ALL_SOURCES.map((s) => [s.id, s]));
const KNOWN = new Set(SOURCES.map((s) => s.id));

const ROWS_PER_VIEW = 10;    // Denodo's global search sends 10 rows a view
const VALUE_CAP = 300;       // and cuts text at 300 characters
const HITS_CAP = 10000;      // its hit count stops here
const MORE_PAGE = 200;
const MAX_RECENT = 8;
const MAX_TERM = 500;

// The match dial, strict to loose. Each stop finds everything the one before did.
// Denodo can't go past 2 typos, so the extra stop is "longer words".
const TOL = {
  exact: { level: 0, label: 'Exact word', ends: false, dist: 0, sub: 'Just as typed' },
  ends: { level: 1, label: 'Longer words', ends: true, dist: 0, sub: 'customers, customer_id' },
  close: { level: 2, label: '1 typo', ends: true, dist: 1, threshold: 90, sub: 'custmer finds customer' },
  loose: { level: 3, label: '2 typos', ends: true, dist: 2, threshold: 80, sub: 'Most results, most noise' },
};
const TOL_KEYS = Object.keys(TOL);
const TRY = ['cell_line', 'edms', 'JNJ-1138098-AAA', '0901bacc8003042c', 'ADPV-000001', 'checklist_respondent__sys', 'dss__sys'];
const GHOSTS = ['darzalex', 'cell_line', 'JNJ-1138098-AAA', 'ADPV-000001', 'dss__sys'];
// ponytail: fixed vocabulary for "did you mean", swap for a /suggest endpoint when the backend has one
const LEX = ['darzalex', 'stelara', 'tremfya', 'pacemaker', 'customer', 'submission', 'dossier', 'regulatory', 'variation',
  'labelling', 'REG-2048', 'erleada', 'imbruvica', 'xarelto', 'invokana', 'simponi', 'remicade', 'zytiga', 'spravato',
  'rybrevant', 'carvykti', 'balversa', 'uptravi', 'opsumit', 'symtuza', 'prezista', 'renewal', 'commitment', 'product master',
  'package leaflet', ...TRY];
const FIXES = [
  ['custmer', 'customer', 'grail', 97], ['darzelax', 'darzalex', 'insight', 94], ['tremfia', 'tremfya', 'lift', 92],
  ['stelera', 'stelara', 'rimdocs', 95], ['pacemakr', 'pacemaker', 'urp', 96], ['submision', 'submission', 'grail', 95],
  ['dosier', 'dossier', 'rimdocs', 91], ['regulatroy', 'regulatory', 'urp', 90], ['varation', 'variation', 'insight7', 94],
  ['labeling', 'labelling', 'insight', 93], ['REG2048', 'REG-2048', 'lift', 99],
];

// Where the metadata search looks. EXACT_MATCH on names alone finds almost nothing.
const METADATA_SEARCH = {
  search_type: 'ALL_WORDS',
  where_to_search_list: ['ELEMENT_NAME', 'ELEMENT_DESC', 'FIELD_NAME', 'FIELD_DESC'],
};

const STRENGTH = [
  { id: 'strong', label: 'Strong', min: 85, color: '#328714', title: 'Strong matches', note: 'Name, description and fields all line up' },
  { id: 'good', label: 'Good', min: 70, color: '#0f68b2', title: 'Good matches', note: 'Clear hit in the name or the description' },
  { id: 'partial', label: 'Partial', min: 0, color: '#ff6017', title: 'Partial matches', note: 'Only some of the words line up' },
];
const strengthOf = (score) => STRENGTH.find((x) => score >= x.min);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const fmt = (n) => Number(n || 0).toLocaleString();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const today = () => new Date().toISOString().split('T')[0];
const isAbort = (e) => e?.name === 'AbortError';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const formatScore = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};
const namesOf = (l) => (Array.isArray(l) ? l : []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
const datasourceOf = (view) => {
  for (const t of String(view || '').toLowerCase().split('_')) if (KNOWN.has(t)) return t;
  return 'other';
};
const countLabel = (v) => `${fmt(v.record_count)}${v.total_capped ? '+' : ''}`;
const toDate = (x) => {
  if (x == null || x === '') return null;
  const d = new Date(typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x);
  return Number.isNaN(d.getTime()) ? null : d;
};
const srcLabel = (list) => {
  if (!list.length) return 'All sources';
  if (list.length <= 2) return list.map((id) => srcById[id]?.label || id).join(', ');
  return `${list.length} sources`;
};
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const ago = (d) => {
  const days = Math.round((d - Date.now()) / 864e5);
  if (Math.abs(days) < 31) return rtf.format(days, 'day');
  return Math.abs(days) < 365 ? rtf.format(Math.round(days / 30), 'month') : rtf.format(Math.round(days / 365), 'year');
};
// grail_reg_2048_product_master -> Reg 2048 product master
const humanize = (name) => {
  const parts = String(name || '').split('_').filter(Boolean);
  if (KNOWN.has(parts[0]?.toLowerCase())) parts.shift();
  return parts.length ? cap(parts.join(' ')) : String(name || '');
};
// long view names wrap at the underscores
const Wbr = ({ name }) => String(name || '').split('_').map((p, i) => (
  <React.Fragment key={i}>{i > 0 && <>_<wbr /></>}{p}</React.Fragment>
));
const readStore = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeStore = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
};
// all-lowercase names read better in capitals; anything with its own casing stays as it is
const showName = (n) => { const t = String(n ?? ''); return t === t.toLowerCase() ? t.toUpperCase() : t; };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Query parsing and matching. Same rule as fuzzy_search.py: 'term' is a whole
// word, 'term*' also takes longer words that start with it, 'term~0.9' allows
// one typo per word, 'term~0.8' or 'term~' two. They combine: 'term*~0.9'.
// ---------------------------------------------------------------------------
const MIN_PREFIX = 3;
const endsOf = (t) => {
  const s = String(t || '').trim();
  return s.endsWith('*') && !s.endsWith('\\*') ? [s.replace(/\*+$/, '').trim(), true] : [s, false];
};
// the user typed their own ~ or trailing *, which wins over the dial
const hasSyntax = (t) => String(t || '').includes('~') || endsOf(t)[1];
function parseTilde(raw) {
  const text = String(raw || '').trim();
  if (!text.includes('~')) return { term: text, fuzzy: false, threshold: 100, dist: 0 };
  const at = text.lastIndexOf('~');
  let term = text.slice(0, at).replace(/~/g, ' ').trim();
  const tail = text.slice(at + 1).trim();
  let threshold = 80;
  if (tail) {
    const n = Number(tail);
    if (Number.isFinite(n)) threshold = n <= 1 ? n * 100 : n;
    else term = `${term} ${tail}`.trim();
  }
  threshold = Math.round(Math.min(100, Math.max(0, threshold)));
  return { term, fuzzy: true, threshold, dist: threshold >= 90 ? 1 : 2 };
}
function parseQuery(raw) {
  const q = parseTilde(raw);
  const [term, ends] = endsOf(q.term);
  return { ...q, term, ends };
}
const buildQuery = (text, tol) => {
  const t = String(text || '').trim();
  const k = TOL[tol] || TOL.exact;
  if (!t || hasSyntax(t)) return t;
  return `${t}${k.ends ? '*' : ''}${k.threshold ? `~${(k.threshold / 100).toFixed(2)}` : ''}`;
};
const tolOf = (query) => {
  const q = parseQuery(query);
  if (q.fuzzy) return q.dist === 1 ? 'close' : 'loose';
  return q.ends ? 'ends' : 'exact';
};
const describe = (q) => {
  if (q.fuzzy) return `Allowing ${q.dist} typo${q.dist > 1 ? 's' : ''} per word${q.ends ? ', plus longer words' : ''}.`;
  return q.ends ? 'Exact words plus longer words that start with them.' : 'Exact words only.';
};

function osa(a, b, max = 9) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
function buildMatcher(query) {
  const q = parseQuery(query);
  if (!q.term) return null;
  if (!q.fuzzy && !q.ends) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${reEsc(q.term)}(?![\\p{L}\\p{N}_])`, 'giu');
    const ranges = (text) => {
      const out = [];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!m[0]) { re.lastIndex++; continue; }
        out.push([m.index, m.index + m[0].length, 0]);
      }
      return out;
    };
    return { ...q, ranges, test: (t) => ranges(t).length > 0 };
  }
  const words = q.term.toLowerCase().match(WORD_RE) || [];
  const prefixes = q.ends ? words.filter((w) => w.length >= MIN_PREFIX) : [];
  const ranges = (text) => {
    const out = [];
    const re = new RegExp(WORD_RE.source, 'gu');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length < 2) continue;
      const w = m[0].toLowerCase();
      let d = Math.min(...words.map((qw) => osa(qw, w, q.dist)));
      // a longer word that starts with the term counts as a near hit
      if (d > q.dist && prefixes.some((p) => w.startsWith(p))) d = 1;
      else if (d > q.dist) continue;
      out.push([m.index, m.index + m[0].length, Math.min(d, 2)]);
    }
    return out;
  };
  return { ...q, ranges, test: (t) => ranges(t).length > 0 };
}

// metadata search matches every word typed (ALL_WORDS), so each word is marked on its own.
// Whole words only, so "reg" doesn't light up "registry"; _ and - count as breaks.
const wordsReCache = new Map();
const wordsRe = (term) => {
  const t = String(term || '').trim().toLowerCase();
  if (wordsReCache.has(t)) return wordsReCache.get(t);
  const w = (t.match(WORD_RE) || []).filter((x) => x.length > 1);
  const re = w.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${w.map(reEsc).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  wordsReCache.set(t, re);
  return re;
};
const wordRanges = (text, term) => {
  const re = wordsRe(term);
  if (!re) return [];
  const s = String(text ?? '');
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length, 0]);
  }
  return out;
};
const hasWords = (text, term) => wordRanges(text, term).length > 0;

// spellings 1 and 2 letters off, for the match lab
function spellings(word) {
  const w = word.toLowerCase();
  const seen = new Set([w]);
  const byDist = { 1: [], 2: [] };
  const add = (v) => {
    if (v.length < 2 || seen.has(v)) return;
    seen.add(v);
    const d = osa(w, v, 2);
    if (d >= 1 && d <= 2) byDist[d].push(v);
  };
  const vow = { a: 'e', e: 'a', i: 'y', o: 'u', u: 'o', y: 'i' };
  const one = (x) => {
    const out = [];
    for (let i = 1; i < x.length; i++) out.push(x.slice(0, i) + x.slice(i + 1));
    for (let i = 1; i < x.length - 1; i++) out.push(x.slice(0, i) + x[i + 1] + x[i] + x.slice(i + 2));
    for (let i = 0; i < x.length; i++) if (vow[x[i]]) out.push(x.slice(0, i) + vow[x[i]] + x.slice(i + 1));
    return out;
  };
  const l1 = one(w);
  l1.forEach(add);
  l1.flatMap(one).forEach(add);
  return byDist;
}
// letters of b that are not in the longest common subsequence with a
function diffMask(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mask = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { mask[j] = false; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return mask;
}
function candidates(term) {
  const first = term.split(/\s+/)[0].slice(0, 30).toLowerCase();
  const sp = spellings(first);
  const pick = (arr, n) => {
    const out = [];
    const step = Math.max(1, Math.floor(arr.length / n));
    for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
    return out;
  };
  return [
    [{ label: cap(first), base: first }, { label: first.toUpperCase(), base: first }],
    first.length >= MIN_PREFIX ? [{ label: `${cap(first)}s`, base: first, suffix: 1 }, { label: `${first.toUpperCase()}_ID`, base: first, suffix: 3 }] : [],
    pick(sp[1], 3).map((v) => ({ label: cap(v), base: first, typo: 1 })),
    pick(sp[2], 3).map((v) => ({ label: cap(v), base: first, typo: 2 })),
  ];
}

// did-you-mean against the fixed vocabulary plus the user's own recent terms
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
function suggest(raw, recent) {
  const w = norm(parseQuery(raw).term);
  if (w.length < 2) return [];
  const seen = new Set();
  const vocab = [...recent.map((r) => [parseQuery(r).term, 'recent']), ...LEX.map((t) => [t, 'common'])]
    .filter(([t]) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const out = [];
  for (const [term, from] of vocab) {
    const n = norm(term);
    let kind = null;
    let d = 0;
    let score = 0;
    if (n === w) { kind = 'exact'; score = 100; } else if (n.startsWith(w)) { kind = 'comp'; score = 90 + Math.round((9 * w.length) / n.length); } else {
      d = osa(w, n, 2);
      if (d <= 2 && (d === 1 || w.length >= 5)) score = Math.round(100 * (1 - d / Math.max(w.length, n.length)));
      else if (w.length >= 4 && (d = osa(w, n.slice(0, w.length), 1)) <= 1) score = Math.round(100 * (1 - 1 / w.length)) - 4;
      else continue;
      kind = `t${d}`;
    }
    out.push({ term, from, kind, d, score, n, w });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
const KIND = { exact: 'Exact', comp: 'Completes', t1: '1 typo', t2: '2 typos' };

// facts about one catalog entry, worked out once when the answer lands
const enrich = (m, term) => ({
  ...m,
  _x: {
    src: datasourceOf(m.name),
    score: Math.max(0, Math.min(100, Number(m.score) || 0)),
    inName: hasWords(m.name, term),
    inDesc: (Array.isArray(m.description_matches) && m.description_matches.length > 0) || hasWords(m.description, term),
    nFields: Number(m.matched_fields) || 0,
    endorsed: (m.countEndorsements || 0) > 0,
    warn: (m.countWarnings || 0) > 0,
    dep: (m.countDeprecations || 0) > 0,
    tags: namesOf(m.tags),
    cats: namesOf(m.categories),
    updated: toDate(m.lastModificationVdpData),
  },
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const readError = async (resp) => {
  if (resp.status === 401) return 'Your session has expired. Sign in again and retry.';
  if (resp.status === 403) return "You don't have access to this. Ask an admin for Fuzzy Match access.";
  let text = '';
  try { text = await resp.text(); } catch { /* ignore */ }
  try {
    const detail = JSON.parse(text)?.detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* not JSON */ }
  if (resp.status === 504) return 'Denodo took too long to answer. Try a more specific term.';
  if (resp.status >= 500) return `The search service had a problem (HTTP ${resp.status}). Try again in a minute.`;
  return text.length && text.length < 300 ? text : `Request failed (HTTP ${resp.status})`;
};
const friendly = (e, fallback) => {
  if (e instanceof TypeError) return "Can't reach the server. Check your connection and try again.";
  return e?.message || fallback;
};
const postJson = async (path, body, signal) => {
  const resp = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error(await readError(resp));
  return resp.json();
};
const saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const csvCell = (value) => {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // stop Excel running it as a formula
  return `"${s.replace(/"/g, '""')}"`;
};
const exportMetadataCsv = (items) => {
  const header = ['Name', 'Database', 'Score', 'Matched Fields', 'Tagged Fields', 'Custom Properties',
    'Endorsements', 'Warnings', 'Deprecations', 'Categories', 'Tags', 'Description'];
  const rows = items.map((m) => [
    m.name, m.database_name, formatScore(m.score), m.matched_fields ?? 0, m.matched_fields_tagged ?? 0,
    m.matched_custom_properties ?? 0, m.countEndorsements ?? 0, m.countWarnings ?? 0, m.countDeprecations ?? 0,
    namesOf(m.categories).join('; '), namesOf(m.tags).join('; '), m.description,
  ].map(csvCell).join(','));
  const csv = `\ufeff${[header.map(csvCell).join(','), ...rows].join('\r\n')}`;
  const name = `metadata_results_${today()}.csv`;
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
  return name;
};

// answers kept for the life of the tab, so back/forward and repeats are instant
const resultCache = new Map();
const cachePut = (key, value) => {
  resultCache.delete(key);
  resultCache.set(key, value);
  while (resultCache.size > 12) resultCache.delete(resultCache.keys().next().value);
};
// Which fields of a catalog view matched. The metadata search only gives a count,
// so the names are asked per view, lazily, a few at a time.
const fieldsCache = new Map();
const fieldsQueue = [];
let fieldsActive = 0;
const pumpFields = () => {
  while (fieldsActive < 3 && fieldsQueue.length) {
    const job = fieldsQueue.shift();
    fieldsActive += 1;
    postJson('/metadata/matched-fields', { element_id: job.id, search_text: job.term, view: job.view, server_id: job.server || 1 })
      .then((d) => job.resolve(Array.isArray(d.fields) ? d.fields : []), job.reject)
      .finally(() => { fieldsActive -= 1; pumpFields(); });
  }
};
const loadMatchedFields = (id, term, view, server = 1) => {
  const k = `${server}|${id}|${term.toLowerCase()}`;
  if (fieldsCache.has(k)) return fieldsCache.get(k);
  const p = new Promise((resolve, reject) => { fieldsQueue.push({ id, term, view, server, resolve, reject }); pumpFields(); });
  fieldsCache.set(k, p);
  p.catch(() => fieldsCache.delete(k));
  return p;
};
const hasCatalogId = (m) => m && m.id !== '' && m.id != null && Number.isInteger(Number(m.id));

const viewMetaCache = new Map();
const fetchViewMetadata = async (view, database, signal) => {
  const k = `${database || ''}|${view}`;
  if (viewMetaCache.has(k)) return viewMetaCache.get(k);
  const data = await postJson('/metadata', { search_text: view, exact_name: true, ...(database ? { database } : {}) }, signal);
  const items = data.metadata || [];
  viewMetaCache.set(k, items);
  return items;
};

// URL is the source of truth for what is searched: q, m, src, db.
// v (selected view) and tab only change with replace.
const readParams = (sp) => {
  const m = sp.get('m') === 'meta' ? 'meta' : 'data';
  const q = (sp.get('q') || '').trim().slice(0, MAX_TERM);
  const src = [...new Set((sp.get('src') || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => KNOWN.has(s)))];
  const db = m === 'meta' ? [] : [...new Set((sp.get('db') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return { q, m, src, db };
};
const searchKey = (p) => JSON.stringify([p.q, p.m, [...p.src].sort(), [...p.db].sort((a, b) => a - b)]);
const toParams = (p) => {
  const o = { q: p.q };
  if (p.m === 'meta') o.m = 'meta';
  if (p.src.length) o.src = p.src.join(',');
  if (p.db.length) o.db = p.db.join(',');
  return o;
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const P = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-3.5-3.5',
  check: 'm5 12 5 5 9-10',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  down: 'M12 4v12m-5-5 5 5 5-5M5 20h14',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  copy: 'M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM5 15V5a1 1 0 0 1 1-1h9',
  back: 'M15 6l-6 6 6 6',
  panel: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16',
  table: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 10h18M9 10v10',
  layers: 'm12 3 9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  grid: 'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM15 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z',
  map: 'M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM8 6.5l8 4.5M8 17.5l8-4.5',
  db: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 7.5h.01',
  text: 'M4 6h16M4 12h10M4 18h13',
  cols: 'M4 5h16v14H4zM10 5v14M16 5v14',
  enter: 'M19 5v6a3 3 0 0 1-3 3H5M9 10l-4 4 4 4',
  chev: 'm7 10 5 5 5-5',
  next: 'M9 6l6 6-6 6',
  redo: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  ext: 'M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6v6M10 14 20 4',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
};
const Ico = ({ d, className = 'ico', style }) => (
  <svg className={className} style={style} viewBox="0 0 24 24" aria-hidden="true"><path d={P[d] || d} /></svg>
);
const Check = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>;

// ---------------------------------------------------------------------------
// Database picker. 60+ databases, only a few have a search index, so it is a
// searchable dropdown with the indexed ones on top instead of a wall of pills.
// ---------------------------------------------------------------------------
const byIndexThenName = (a, b) => (b.indexed === true) - (a.indexed === true) || a.name.localeCompare(b.name);

function hl(name, q) {
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return name;
  return <>{name.slice(0, i)}<mark>{name.slice(i, i + q.length)}</mark>{name.slice(i + q.length)}</>;
}

function DbPicker({ list, value, onChange, status, indexState = 'ok' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [cur, setCur] = useState(0);
  const boxRef = useRef(null);
  const inRef = useRef(null);
  const listRef = useRef(null);

  const sorted = useMemo(() => [...list].sort(byIndexThenName), [list]);
  const known = indexState === 'ok';
  const checking = indexState === 'loading';
  const nIdx = sorted.filter((d) => d.indexed === true).length;
  const useTab = known && nIdx ? tab : 'all';
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return sorted.filter((d) => (useTab === 'all' || d.indexed === true) && (!t || d.name.toLowerCase().includes(t) || String(d.db_id) === t));
  }, [sorted, q, useTab]);
  const byId = useMemo(() => new Map(list.map((d) => [d.id, d])), [list]);
  const picked = value.map((id) => byId.get(id)).filter(Boolean);

  useEffect(() => { setCur(0); }, [q, useTab]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const pickShown = () => onChange([...new Set([...value, ...shown.map((d) => d.id)])]);
  const openUp = () => { setOpen(true); requestAnimationFrame(() => inRef.current?.focus()); };

  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCur((c) => Math.min(c + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[cur]) toggle(shown[cur].id); else setOpen(true); }
    else if (e.key === 'Escape') { if (q) setQ(''); else setOpen(false); }
    else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
  };

  if (!list.length) return <div className="dbp-empty"><Ico d="db" />{status}</div>;

  // where the "not indexed" group starts, for the divider
  const firstRaw = useTab === 'all' && known ? shown.findIndex((d) => d.indexed === false) : -1;
  const MAX_CHIPS = 3;

  return (
    <div className={`dbp ${open ? 'on' : ''}`} ref={boxRef}>
      <div className="dbp-field" onClick={openUp}>
        <Ico d="db" className="ico dbp-lead" />
        {picked.slice(0, MAX_CHIPS).map((d) => (
          <span key={d.id} className={`dbp-chip ${d.indexed === false ? 'raw' : ''} ${d.indexed == null ? 'unk' : ''}`} title={d.indexed == null ? 'Checking the search index…' : d.indexed ? 'Indexed' : 'Not indexed in Denodo'}>
            <i />{d.name}
            <button type="button" aria-label={`Remove ${d.name}`} onClick={(e) => { e.stopPropagation(); toggle(d.id); }}><Ico d="x" /></button>
          </span>
        ))}
        {picked.length > MAX_CHIPS && <span className="dbp-more">+{picked.length - MAX_CHIPS} more</span>}
        <input ref={inRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={keys}
          placeholder={picked.length ? 'Add another…' : `Find a database (${list.length})`}
          role="combobox" aria-expanded={open} aria-controls="dbp-list" aria-label="Find a database" />
        {picked.length > 0 && (
          <button type="button" className="dbp-clear" onClick={(e) => { e.stopPropagation(); onChange([]); }} title="Clear all"><Ico d="x" /></button>
        )}
        <Ico d="chev" className="ico dbp-chev" />
      </div>

      {checking && !open && (
        <div className="dbp-status"><span className="dbp-spin" />Checking which databases have a search index. About a minute, you can pick and search meanwhile.</div>
      )}
      {!checking && !picked.length && nIdx > 0 && !open && (
        <div className="dbp-quick">
          <span>Indexed</span>
          {sorted.filter((d) => d.indexed === true).map((d) => (
            <button key={d.id} type="button" onClick={() => toggle(d.id)}><Ico d="plus" />{d.name}</button>
          ))}
        </div>
      )}

      <div className="dbp-pop" role="dialog" aria-label="Databases" onMouseDown={(e) => { if (e.target !== inRef.current) e.preventDefault(); }}>
        <div className="dbp-bar">
          <div className="dbp-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={useTab === 'all'} onClick={() => setTab('all')}>All <b>{list.length}</b></button>
            <button type="button" role="tab" aria-selected={useTab === 'idx'} disabled={!known || !nIdx} onClick={() => setTab('idx')}
              title={checking ? 'Still checking the search index' : !known ? 'Could not check the search index' : ''}>
              Indexed {checking ? <span className="dbp-spin" /> : <b>{known ? nIdx : '–'}</b>}
            </button>
          </div>
          <span className="dbp-acts">
            <button type="button" onClick={pickShown} disabled={!shown.length}>Select shown</button>
            <button type="button" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
          </span>
        </div>
        {checking && <div className="dbp-note"><span className="dbp-spin" />Checking which databases have a search index. You can pick and search meanwhile.</div>}
        {indexState === 'failed' && <div className="dbp-note warn"><Ico d="info" />Couldn&rsquo;t check the search index. Every database can still be searched.</div>}
        <div className="dbp-list" id="dbp-list" role="listbox" aria-multiselectable="true" ref={listRef}>
          {!shown.length && <div className="dbp-none">No database matches &ldquo;{q}&rdquo;</div>}
          {shown.map((d, i) => (
            <React.Fragment key={d.id}>
              {i === 0 && useTab === 'all' && known && d.indexed === true && <div className="dbp-sec">Indexed</div>}
              {i === firstRaw && <div className="dbp-sec">Not indexed</div>}
              <div role="option" data-i={i} aria-selected={value.includes(d.id)} className={`dbp-row ${i === cur ? 'cur' : ''} ${d.indexed === false ? 'raw' : ''}`}
                onPointerMove={() => i !== cur && setCur(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(d.id)}>
                <span className="dbp-bx"><Ico d="check" /></span>
                <span className="dbp-name">{hl(d.name, q.trim())}</span>
                {d.indexed === true && <span className="dbp-tag">indexed</span>}
                <span className="dbp-id" title={d.catalog === false ? 'In Denodo VDP but not synced to the Data Catalog' : `Server ${(d.servers || [1]).join(' and ')}`}>
                  {d.catalog === false ? 'VDP only' : (d.servers || [1]).map((n) => <em key={n} className="dbp-srv">S{n}</em>)}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>
        <div className="dbp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> pick</span><span><kbd>Esc</kbd> close</span>
          <span className="dbp-count">{value.length} picked</span>
        </div>
      </div>
    </div>
  );
}

// text with the hits marked: d0 exact, d1 one letter off or longer, d2 two off
function Marked({ text, ranges }) {
  const s = text == null ? '' : String(text);
  if (!ranges.length) return s;
  const out = [];
  let last = 0;
  ranges.forEach(([a, b, d]) => {
    if (a < last) return;
    if (a > last) out.push(s.slice(last, a));
    out.push(<mark key={a} className={`d${d}`}>{s.slice(a, b)}</mark>);
    last = b;
  });
  out.push(s.slice(last));
  return out;
}
const Hl = ({ text, mt }) => <Marked text={text} ranges={mt && text != null && text !== '' ? mt.ranges(String(text)) : []} />;
const Words = ({ text, term }) => <Marked text={text} ranges={wordRanges(text, term)} />;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
// true one frame after `dep` changes, so bars and rings grow from zero
function useGrow(dep) {
  const [grown, setGrown] = useState(null);
  useEffect(() => {
    let id2;
    const id = requestAnimationFrame(() => { id2 = requestAnimationFrame(() => setGrown(dep)); });
    return () => { cancelAnimationFrame(id); cancelAnimationFrame(id2); };
  }, [dep]);
  return grown === dep;
}

function useElapsed(running) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const t0 = Date.now();
    setSecs(0);
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
  }, [running]);
  return running ? secs : 0;
}

// matched field names of one catalog entry, loaded once it is on screen (or straight away when eager)
function useMatchedFields(m, term, eager = false) {
  const ref = useRef(null);
  const [state, setState] = useState({ status: 'idle', fields: [] });
  const want = !!term && hasCatalogId(m) && (m.matched_fields ?? 0) > 0;
  useEffect(() => {
    if (!want) return undefined;
    let alive = true;
    const start = () => {
      setState((s) => (s.status === 'idle' ? { ...s, status: 'loading' } : s));
      loadMatchedFields(Number(m.id), term, m.name, m.server_id)
        .then((fields) => { if (alive) setState({ status: 'ok', fields }); })
        .catch(() => { if (alive) setState({ status: 'error', fields: [] }); });
    };
    if (eager || !ref.current || typeof IntersectionObserver === 'undefined') { start(); return () => { alive = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => { alive = false; io.disconnect(); };
  }, [want, m, term, eager]);
  return [ref, state, want];
}

// ---------------------------------------------------------------------------
// Motion pieces
// ---------------------------------------------------------------------------
function CountUp({ to, plus, ms = 900 }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      setN(Math.round(to * (1 - (1 - p) ** 4)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return <>{fmt(n)}{n === to && plus ? '+' : ''}</>;
}

function Ghost() {
  const [text, setText] = useState('Search for ');
  useEffect(() => {
    let ex = 0;
    let i = 0;
    let dir = 1;
    const id = setInterval(() => {
      if (document.hidden) return;
      const w = GHOSTS[ex];
      i += dir;
      setText(`Search for ${w.slice(0, Math.max(0, i))}`);
      if (i === w.length + 12) dir = -1;
      if (i <= 0 && dir === -1) { dir = 1; ex = (ex + 1) % GHOSTS.length; }
    }, 85);
    return () => clearInterval(id);
  }, []);
  return <span className="ghost" aria-hidden="true">{text}</span>;
}

const DUST = ['a', 'e', '~', '*', 'r', 'o', 'y', '?', 'z', 'i', '~', 's'].map((g, i) => ({
  g,
  style: {
    left: `${4 + ((i * 37) % 92)}%`, '--s': `${16 + (i % 4) * 8}px`, '--d': `${24 + (i % 5) * 6}s`, '--w': `-${i * 3.1}s`,
    '--x': `${(i % 2 ? 1 : -1) * (20 + i * 4)}px`, '--o': 0.04 + (i % 3) * 0.02,
  },
}));
const Dust = memo(() => (
  <div className="dust" aria-hidden="true">{DUST.map((d, i) => <span key={i} style={d.style}>{d.g}</span>)}</div>
));

const Ticker = memo(() => {
  const row = FIXES.map(([bad, good, s, p], i) => (
    <span className="tk" key={i} style={{ '--c': srcById[s].color }}><i /><s>{bad}</s><Ico d="next" /><b>{good}</b><em>{p}%</em><small>{srcById[s].label}</small></span>
  ));
  return (
    <div className="ticker" aria-hidden="true">
      <span className="tk-lbl"><i />Example corrections</span>
      <div className="tk-vp"><div className="tk-track">{row}{row.map((x, i) => React.cloneElement(x, { key: `b${i}` }))}</div></div>
    </div>
  );
});

// Rotating headline. The typo words are filled and animated by hand (Web Animations),
// so React renders them empty and never touches them again.
const Headline = memo(() => {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const fm = root.closest('.fm');
    const home = root.closest('#home');
    const minTier = () => fm?.dataset.tier === 'min';
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const letters = (w, chars, cls) => {
      w.textContent = '';
      chars.forEach((c, k) => {
        const s = document.createElement('span');
        s.className = `tl${cls(k) ? ` ${cls(k)}` : ''}`;
        s.textContent = c;
        w.appendChild(s);
      });
    };
    const done = (w) => { w.textContent = w.dataset.fix; w.classList.add('fixed'); };
    // a word with one letter missing, the letter then drops into the gap
    const missWord = (w, wait) => {
      const fix = w.dataset.fix;
      const i = +w.dataset.miss;
      clearTimeout(w._t);
      w.classList.remove('fixed');
      letters(w, [...fix], (k) => (k === i ? 'add' : ''));
      const add = w.querySelector('.add');
      w._t = later(() => {
        if (minTier() || !add.animate) return done(w);
        add.style.width = 'auto';
        const full = add.offsetWidth;
        add.style.width = '';
        add.animate([
          { width: '0px', opacity: 0, transform: 'translateY(-.7em) rotate(-20deg) scale(.6)' },
          { width: `${full}px`, opacity: 1, transform: 'translateY(.06em) rotate(4deg) scale(1.1)', offset: 0.7 },
          { width: `${full}px`, opacity: 1, transform: 'none' },
        ], { duration: 700, easing: 'cubic-bezier(.34,1.4,.64,1)', fill: 'forwards' }).onfinish = () => done(w);
      }, wait);
    };
    // one word misspelled, then the two swapped letters hop back into place
    const typoWord = (w, wait) => {
      if (w.dataset.miss) { missWord(w, wait); return; }
      const fix = w.dataset.fix;
      const i = +w.dataset.i;
      const bad = [...fix];
      [bad[i], bad[i + 1]] = [bad[i + 1], bad[i]];
      clearTimeout(w._t);
      w.classList.remove('fixed');
      letters(w, bad, (k) => (k === i || k === i + 1 ? 'sw' : ''));
      w._t = later(() => {
        const [a, b] = w.querySelectorAll('.sw');
        if (minTier() || !a.animate) { done(w); return; }
        const wa = a.offsetWidth;
        const wb = b.offsetWidth;
        const ease = { duration: 650, easing: 'cubic-bezier(.34,1.4,.64,1)', fill: 'forwards' };
        a.animate([{ transform: 'none' }, { transform: `translate(${wb / 2}px,-.45em) rotate(14deg)`, offset: 0.5 }, { transform: `translateX(${wb}px)` }], ease);
        b.animate([{ transform: 'none' }, { transform: `translate(${-wa / 2}px,.1em) rotate(-6deg)`, offset: 0.5 }, { transform: `translateX(${-wa}px)` }], ease).onfinish = () => done(w);
      }, wait);
    };
    const play = (hs, wait = 1100) => hs.querySelectorAll('.tw').forEach((w, n) => typoWord(w, wait + n * 450));
    root.querySelectorAll('.tw').forEach((w) => { w.textContent = w.dataset.fix; });
    const heads = [...root.querySelectorAll('.hs')];
    let i = 0;
    const id = setInterval(() => {
      if (document.hidden || home?.classList.contains('off')) return;
      heads[i].classList.remove('on');
      heads[i].setAttribute('aria-hidden', 'true');
      i = (i + 1) % heads.length;
      heads[i].classList.add('on');
      heads[i].removeAttribute('aria-hidden');
      play(heads[i]);
    }, 5200);
    play(heads[0], 1500);
    return () => { clearInterval(id); timers.forEach(clearTimeout); };
  }, []);
  return (
    <h1 className="headline" ref={ref}>
      <span className="hs on"><span className="l1">Type it your <span className="tw" data-fix="way" data-i="1" />.</span><span className="l2"><span className="wd">We’ll</span> <span className="wd">find</span> <span className="wd">the</span> <span className="wd shim">match.</span></span></span>
      <span className="hs" aria-hidden="true"><span className="l1">Less exact <span className="tw" data-fix="typing" data-i="1" />.</span><span className="l2"><span className="wd">More</span> <span className="wd">accurate</span> <span className="wd shim">finding.</span></span></span>
      <span className="hs" aria-hidden="true"><span className="l1">Can’t <span className="tw" data-fix="remember" data-miss="3" /> the exact <span className="tw" data-fix="name" data-i="1" />?</span><span className="l2"><span className="wd">We’ll</span> <span className="wd">find</span> <span className="wd">it</span> <span className="wd">for</span> <span className="wd shim">you.</span></span></span>
    </h1>
  );
});

// ---------------------------------------------------------------------------
// Match lab faces
// ---------------------------------------------------------------------------
function Tok({ c, delay }) {
  const lab = c.label;
  let inner = lab;
  if (c.suffix) inner = <>{lab.slice(0, lab.length - c.suffix)}<em className="e0">{lab.slice(-c.suffix)}</em></>;
  else if (c.typo) {
    const mask = diffMask(c.base, lab.toLowerCase());
    inner = [...lab].map((ch, i) => (mask[i] ? <em key={i} className={`e${c.typo}`}>{ch}</em> : <React.Fragment key={i}>{ch}</React.Fragment>));
  }
  return <span className="tok" style={{ animationDelay: `${delay}ms` }}><span className="ck"><Check /></span><span>{inner}</span></span>;
}

function TuneFace({ text, tol, onTol, hidden, measureRef }) {
  const typed = hasSyntax(text);
  const active = typed ? tolOf(text) : tol;
  const term = (parseQuery(text).term || 'customer').slice(0, 40);
  const lvl = TOL[active].level;
  const groups = useMemo(() => candidates(term), [term]);
  const counts = groups.map((g) => g.length);
  const found = counts.slice(0, lvl + 1).reduce((a, b) => a + b, 0);
  const total = counts.reduce((a, b) => a + b, 0);
  const exact = lvl === 0;
  const [drag, setDrag] = useState(false);
  const rowsRef = useRef(null);
  const apRef = useRef(null);
  const knobRef = useRef(null);
  const fillRef = useRef(null);
  const trkRef = useRef(null);
  const railRef = useRef(null);
  const nRef = useRef(null);

  const measure = useCallback(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    const rowEls = [...rows.querySelectorAll('.row')];
    const sel = rowEls[lvl];
    if (!sel) return;
    const H = rows.offsetHeight;
    apRef.current.style.transform = `translateY(${sel.offsetTop + sel.offsetHeight - H}px)`;
    const mid = sel.offsetTop + sel.offsetHeight / 2;
    knobRef.current.style.transform = `translateY(${mid}px)`;
    fillRef.current.style.transform = `scaleY(${Math.max(0, (mid - 22) / Math.max(1, trkRef.current.offsetHeight))})`;
    railRef.current.querySelectorAll('.dot').forEach((d, i) => { if (rowEls[i]) d.style.top = `${rowEls[i].offsetTop + rowEls[i].offsetHeight / 2}px`; });
  }, [lvl]);
  measureRef.current = measure;
  useLayoutEffect(() => { measure(); }, [measure, term, hidden]);
  useEffect(() => {
    let raf;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => measureRef.current?.()); };
    window.addEventListener('resize', on);
    document.fonts?.ready?.then(on);
    return () => { window.removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, [measureRef]);

  // the counter jumps when the number changes
  const firstN = useRef(true);
  useEffect(() => {
    if (firstN.current) { firstN.current = false; return undefined; }
    const n = nRef.current;
    if (!n) return undefined;
    n.classList.remove('bump');
    void n.offsetWidth;
    n.classList.add('bump');
    const t = setTimeout(() => n.classList.remove('bump'), 260);
    return () => clearTimeout(t);
  }, [found]);

  const levelAt = (y) => {
    const rows = rowsRef.current;
    const top = rows.getBoundingClientRect().top;
    let best = 0;
    [...rows.querySelectorAll('.row')].forEach((r, i) => { if (y - top >= r.offsetTop - 3) best = i; });
    return best;
  };
  const pick = (k) => { if (!typed && k !== tol) onTol(k); };
  const onDown = (e) => {
    if (typed || e.target.closest('.tok')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
    pick(TOL_KEYS[levelAt(e.clientY)]);
  };
  const onMove = (e) => { if (drag) pick(TOL_KEYS[levelAt(e.clientY)]); };
  const onUp = () => setDrag(false);
  const onKey = (e) => {
    const l = TOL[tol].level;
    const m = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Home') { e.preventDefault(); pick('exact'); } else if (e.key === 'End') { e.preventDefault(); pick('loose'); } else if (m) { e.preventDefault(); pick(TOL_KEYS[Math.max(0, Math.min(3, l + m))]); }
  };

  const letters = [...term.slice(0, 16)];
  return (
    <div className={`face ${hidden ? 'hide' : ''}`}>
      <div className="lab-head">
        <div><div className="kick">Content search</div><h3>How close a match?</h3></div>
        <div className="finds">
          <div className={`ring ${exact ? 'exact' : ''}`} style={{ '--fm-p': exact ? 1 : total ? (found / total).toFixed(3) : 0 }}>
            <span className="n" ref={nRef}>{found}</span>
            <span className="ex" aria-hidden="true"><Ico d="target" /></span>
          </div>
          <small>{exact ? 'Exact spelling, any case' : <>of <span>{total}</span> spellings found</>}</small>
        </div>
      </div>
      <div className="tiles" aria-hidden="true">
        {letters.map((c, i) => (
          <span key={`${term}|${i}`} className={`tile ${c === ' ' ? 'sp' : ''}`} style={{ animationDelay: `${i * 22}ms` }}>{c === ' ' ? '' : c}</span>
        ))}
        {term.length > 16 && <span key={`${term}|etc`} className="tile etc">...</span>}
      </div>
      <div className={`spec ${typed ? 'locked' : ''} ${drag ? 'drag' : ''}`} role="slider" tabIndex={0} aria-label="How close a match"
        aria-valuemin={0} aria-valuemax={3} aria-valuenow={lvl} aria-valuetext={`${TOL[active].label}. ${TOL[active].sub}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
        <div className="vrail" ref={railRef}>
          <span className="trk" ref={trkRef}><span className="fill" ref={fillRef} /></span>
          <span className="knob" ref={knobRef} />
          {TOL_KEYS.map((k, i) => <span key={k} className={`dot ${i <= lvl ? 'on' : ''}`} />)}
        </div>
        <div className="rows" ref={rowsRef}>
          <div className="ap"><div className="ap-in" ref={apRef} /></div>
          {TOL_KEYS.map((k, i) => (
            <div key={`${term}|${k}`} className={`row ${i <= lvl ? 'in' : ''}`} data-l={i}>
              <button type="button" className="rl" tabIndex={-1}><b>{TOL[k].label}</b><small>{TOL[k].sub}</small></button>
              <div className="toks">
                {groups[i].length
                  ? groups[i].map((c, j) => <Tok key={c.label} c={c} delay={(i * 3 + j) * 30} />)
                  : <span className="tok" style={{ border: 0 }}>too short</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`lab-foot ${typed ? 'warn' : ''}`}>
        {typed
          ? <span>Set by the <code>~</code> or <code>*</code> you typed. Remove it to use the dial.</span>
          : (
            <>
              <span>Or type <code>{term.slice(0, 12)}*</code> <code>~0.9</code> <code>~0.8</code></span>
              <span className="legend-mini">
                <span><i style={{ background: 'var(--blue-wash)', border: '1px solid var(--blue)' }} />longer</span>
                <span><i style={{ background: 'var(--amber-wash)', border: '1px solid #e0a100' }} />typo</span>
              </span>
            </>
          )}
      </div>
    </div>
  );
}

function MetaFace({ text, hidden }) {
  const t = parseQuery(text).term || 'customer';
  const rows = [
    ['tag', 'View names', <>grail_<span className="hl">{t}</span>_master</>],
    ['text', 'Descriptions', <>Golden record of each <span className="hl">{t}</span> by market</>],
    ['cols', 'Field names', <>{t.toUpperCase()}_ID, <span className="hl">{t}</span>_status</>],
  ];
  return (
    <div className={`face ${hidden ? 'hide' : ''}`}>
      <div className="kick">Metadata search</div>
      <h3>Search the Data Catalog itself</h3>
      <div className="mrows">
        {rows.map(([ic, b, smp], i) => (
          <div className="mr" key={b} style={{ animationDelay: `${i * 70}ms` }}><span className="ic"><Ico d={ic} /></span><div><b>{b}</b><span className="smp">{smp}</span></div></div>
        ))}
      </div>
      <div className="mnote"><Ico d="info" /><span>Every word you type has to appear. Typo tolerance doesn’t apply here, so spell it as the catalog does.</span></div>
    </div>
  );
}

function ScanFace({ busy, secs, title, sub, hidden }) {
  return (
    <div className={`face ${hidden ? 'hide' : ''}`} aria-live="polite">
      <div className="scan-top">
        <div><div className="kick">Searching</div><h3>{title}</h3><p className="scan-sub">{sub}</p></div>
        <div className="clock" aria-label={`${secs} seconds`}>
          <svg viewBox="0 0 76 76"><circle className="bgc" cx="38" cy="38" r="32" /><circle className="fgc" cx="38" cy="38" r="32" /></svg>
          <div><b>{secs}</b><small>s</small></div>
        </div>
      </div>
      <div className="lanes" key={busy ? searchKey(busy.params) : ''}>
        {SOURCES.map((s, i) => (
          <div key={s.id} className={`lane ${busy && busy.params.src.length && !busy.params.src.includes(s.id) ? 'dim' : ''}`} style={{ '--c': s.color, animationDelay: `${i * 50}ms` }}>
            <span className="nm"><i />{s.label}</span><span className="tr"><b style={{ animationDelay: `${i * 0.22}s` }} /></span>
          </div>
        ))}
      </div>
      <p className={`whint ${busy && secs >= 1 ? 'on' : ''}`}>A new term usually takes 30 to 60s. Repeats are instant.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results pieces
// ---------------------------------------------------------------------------
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function RecordsTable({ columns, records, hits, matcher, valueCap, st, onChange, flashCol, onOpen, onCell, hitCount, more }) {
  const rows = useMemo(() => {
    let list = records.map((row, i) => ({ row, i }));
    const fq = st.filter.trim().toLowerCase();
    if (fq) list = list.filter(({ row }) => columns.some((c) => String(row[c] ?? '').toLowerCase().includes(fq)));
    if (st.sort) list = [...list].sort((a, b) => st.dir * collator.compare(String(a.row[st.sort] ?? ''), String(b.row[st.sort] ?? '')));
    return list;
  }, [records, columns, st.filter, st.sort, st.dir]);
  const pastRows = (hits || []).filter((h) => h === false).length;
  const anyHit = columns.some((c) => hitCount[c] > 0);
  const focus = !!st.focusCols && anyHit;
  const dim = (c) => (focus && !hitCount[c] ? 'dim' : '');
  const sortBy = (c) => {
    if (st.sort !== c) onChange({ sort: c, dir: 1 });
    else if (st.dir === 1) onChange({ dir: -1 });
    else onChange({ sort: null, dir: 1 });
  };
  return (
    <>
      <div className="tbar">
        <label className="filter"><Ico d="search" /><input value={st.filter} onChange={(e) => onChange({ filter: e.target.value })} placeholder="Filter these rows" aria-label="Filter rows" /></label>
        {matcher && (
          <label className="tog" title={anyHit ? 'Fade the columns with no highlighted hit' : 'No column has a highlighted hit in these rows'}>
            <input type="checkbox" checked={focus} disabled={!anyHit} onChange={(e) => onChange({ focusCols: e.target.checked })} /><span className="sw" />Focus matching columns
          </label>
        )}
        <span className="keys"><span><kbd>/</kbd> search</span><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> views</span></span>
      </div>
      {pastRows > 0 && (
        <p className="past"><Ico d="info" />
          <span>{pastRows} row{pastRows > 1 ? 's' : ''} matched on text past the first {valueCap} characters, so the hit doesn&rsquo;t show here. Open the row to read the full record.</span>
        </p>
      )}
      <div className="tab-body">
        <table className={`dt ${focus ? 'dimcols' : ''}`}>
          <thead>
            <tr>
              <th className="rn" aria-label="Row number">#</th>
              {columns.map((c) => (
                <th key={c} className={dim(c) || undefined} aria-sort={st.sort === c ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => sortBy(c)} title={`Sort by ${c}`}>
                    {showName(c)}{hitCount[c] > 0 && <span className="hc">{hitCount[c]}</span>}{st.sort === c && <span className="ar">{st.dir > 0 ? '↑' : '↓'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, i }) => (
              <tr key={i} className={hits?.[i] === false ? 'nohit' : undefined}>
                <td className="rn">
                  <span className="rn-n">{i + 1}</span>
                  <button type="button" className={`rec-btn ${hits?.[i] === false ? 'past' : ''}`} onClick={() => onOpen(i)} aria-label={`Open row ${i + 1} as a full record`}
                    title={hits?.[i] === false ? 'The match is past the text shown here. Open the full record to see it.' : 'Open the full record'}>
                    <Ico d="ext" />
                  </button>
                </td>
                {columns.map((c) => {
                  const t = row[c] == null ? '' : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c]);
                  return (
                    <td key={c} data-c={c} className={[flashCol === c ? 'flash' : '', dim(c), t ? 'val' : ''].filter(Boolean).join(' ') || undefined}
                      onClick={() => { if (t) onCell(i, c, t); }}>
                      <Hl text={t} mt={matcher} />{!!valueCap && t.length >= valueCap && <span className="cut">[...]</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p style={{ textAlign: 'center', color: 'var(--g6)', padding: 30 }}>No rows match that filter.</p>}
        {more}
      </div>
    </>
  );
}

function ScoreRing({ score, size, r, color, grown }) {
  const C = 2 * Math.PI * r;
  return (
    <div className="ring" style={color ? { '--c': color } : undefined}>
      <svg width={size} height={size}>
        <circle className="bgc" cx={size / 2} cy={size / 2} r={r} />
        <circle className="fgc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={C} strokeDashoffset={grown ? C * (1 - score / 100) : C} />
      </svg>
      <span>{formatScore(score)}</span>
    </div>
  );
}

const Ev = ({ on, children }) => <span className={on ? '' : 'off'}><span className="d">{on && <Ico d="check" />}</span>{children}</span>;

function MetaCard({ m, idx, i, term, grown, onOpen }) {
  const x = m._x;
  const s = srcById[x.src] || OTHER;
  const st = strengthOf(x.score);
  const [ref, fs] = useMatchedFields(m, term);
  const f = fs.fields;
  return (
    <button type="button" ref={ref} className="ac" data-mi={idx} style={{ '--c': s.color, animationDelay: `${Math.min(i, 11) * 35}ms` }}
      aria-label={`${m.name}, ${st.label} match ${formatScore(m.score)}`} onClick={() => onOpen(m)}>
      <div className="ac-top">
        <span className="src"><i />{s.label}</span><span className="sep">/</span><span>{m.database_name}</span>
        <span className="flags">
          {x.endorsed && <span className="flag ok"><Ico d="check" />Endorsed</span>}
          {x.warn && <span className="flag warn"><Ico d="info" />Warning</span>}
          {x.dep && <span className="flag dep">Deprecated</span>}
        </span>
      </div>
      <div className="ac-head">
        <div><div className="ac-title"><Words text={humanize(m.name)} term={term} /></div><div className="ac-tech"><Words text={showName(m.name)} term={term} /></div></div>
        <div className="score" style={{ '--c': st.color }}><ScoreRing score={x.score} size={48} r={20} grown={grown} /><small>{st.label}</small></div>
      </div>
      <div className="why">
        <div className="wt">Why it matched</div>
        <div className="ev">
          <Ev on={x.inName}>Name</Ev><Ev on={x.inDesc}>Description</Ev>
          <Ev on={x.nFields > 0}>{x.nFields ? plural(x.nFields, 'field') : 'Fields'}</Ev>
        </div>
        {f.length > 0 && (
          <div className="flds">
            {f.slice(0, 3).map((n) => <span key={n} className="fld" title={n}><Words text={showName(n)} term={term} /></span>)}
            {f.length > 3 && <span className="fld" title={f.slice(3).join(', ')}>+{f.length - 3}</span>}
          </div>
        )}
        {m.description ? <div className="quote"><Words text={m.description} term={term} /></div> : <div className="quote muted">No description in the catalog</div>}
      </div>
      <div className="ac-foot">
        <span className="tags">{x.tags.map((t) => <span key={t}>{t}</span>)}</span>
        {x.updated && <span className="when">Changed {ago(x.updated)}</span>}
        <span className="go2"><Ico d="next" /></span>
      </div>
    </button>
  );
}

// relationship map: source -> database -> asset
function MetaMap({ list, items, term, pin, setPin, hover, setHover, onOpen }) {
  const bodyRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [ready, setReady] = useState(false);
  const srcIdx = (id) => ALL_SOURCES.findIndex((x) => x.id === id);
  const srcs = useMemo(() => ALL_SOURCES.filter((x) => list.some((m) => m._x.src === x.id)), [list]);
  // databases follow their first source and assets follow their database, so few lines cross
  const dbs = useMemo(() => {
    const first = (d) => Math.min(...list.filter((m) => m.database_name === d).map((m) => srcIdx(m._x.src)));
    return [...new Set(list.map((m) => m.database_name))].sort((a, b) => first(a) - first(b) || String(a).localeCompare(String(b)));
  }, [list]);
  const assets = useMemo(() => [...list].sort((a, b) => dbs.indexOf(a.database_name) - dbs.indexOf(b.database_name) || b._x.score - a._x.score), [list, dbs]);
  const ix = (m) => items.indexOf(m);

  // databases sit beside their assets, sources beside their databases. Offsets, not rects,
  // so the entrance animation and the node transitions can't skew the lines.
  const layout = useCallback(() => {
    const body = bodyRef.current;
    if (!body || !body.offsetHeight) return;
    const H = body.offsetHeight;
    const gap = 10;
    const [ls, ld, la] = body.querySelectorAll('.lane');
    const place = (nodes) => {
      nodes.sort((a, b) => a.y - b.y);
      let prev = -Infinity;
      nodes.forEach((n) => { n.h = n.el.offsetHeight; n.top = Math.max(n.y - n.h / 2, prev + gap, 0); prev = n.top + n.h; });
      let limit = H;
      for (let i = nodes.length - 1; i >= 0; i--) { nodes[i].top = Math.min(nodes[i].top, limit - nodes[i].h); limit = nodes[i].top - gap; }
      nodes.forEach((n) => { n.el.style.transform = `translateY(${n.top}px)`; n.c = n.top + n.h / 2; });
    };
    const out = {};
    la.querySelectorAll('.mn.as').forEach((el) => {
      out[el.dataset.k] = { l: la.offsetLeft, r: la.offsetLeft + el.offsetWidth, y: la.offsetTop + el.offsetTop + el.offsetHeight / 2 };
    });
    const groups = [...la.querySelectorAll('.ag')];
    const dbNodes = [...ld.querySelectorAll('.mn')].map((el) => {
      const g = groups.find((x) => `d:${x.dataset.g}` === el.dataset.k);
      return { el, k: el.dataset.k, y: la.offsetTop + g.offsetTop + g.offsetHeight / 2 };
    });
    place(dbNodes);
    dbNodes.forEach((n) => { out[n.k] = { l: ld.offsetLeft, r: ld.offsetLeft + ld.offsetWidth, y: ld.offsetTop + n.c }; });
    const srcNodes = [...ls.querySelectorAll('.mn')].map((el) => {
      const ms = assets.filter((m) => `s:${m._x.src}` === el.dataset.k);
      return { el, k: el.dataset.k, y: ms.reduce((a, m) => a + out[`d:${m.database_name}`].y, 0) / ms.length - ls.offsetTop };
    });
    place(srcNodes);
    srcNodes.forEach((n) => { out[n.k] = { l: ls.offsetLeft, r: ls.offsetLeft + ls.offsetWidth, y: ls.offsetTop + n.c }; });
    setPos(out);
  }, [assets]);
  useLayoutEffect(() => {
    layout();
    let id2;
    const id = requestAnimationFrame(() => { layout(); id2 = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(id); cancelAnimationFrame(id2); };
  }, [layout]);
  useEffect(() => {
    let raf;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, [layout]);

  const keys = useMemo(() => new Set([...srcs.map((x) => `s:${x.id}`), ...dbs.map((d) => `d:${d}`), ...assets.map((m) => `a:${ix(m)}`)]), [srcs, dbs, assets]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pin && !keys.has(pin)) setPin(null); }, [pin, keys, setPin]);

  const k = pin || hover;
  const rel = new Set();
  const hits = [];
  if (k) {
    rel.add(k);
    const [type, id] = [k[0], k.slice(2)];
    assets.forEach((m) => {
      const i = ix(m);
      const hit = type === 's' ? m._x.src === id : type === 'd' ? m.database_name === id : i === Number(id);
      if (hit) { hits.push(m); [`s:${m._x.src}`, `d:${m.database_name}`, `a:${i}`].forEach((x) => rel.add(x)); }
    });
  }
  const on = (key) => (k && rel.has(key) ? 'on' : '');

  const pairs = new Map();
  assets.forEach((m) => { const key = `s:${m._x.src}|d:${m.database_name}`; pairs.set(key, (pairs.get(key) || 0) + 1); });
  const curve = (a, b) => {
    const p = pos[a];
    const q = pos[b];
    const mx = (p.r + q.l) / 2;
    return `M${p.r + 4} ${p.y}C${mx} ${p.y} ${mx} ${q.y} ${q.l - 4} ${q.y}`;
  };
  const paths = [];
  const ribs = [];
  let defs = null;
  if (pos && pairs.size) {
    const any = [...pairs.keys()][0].split('|');
    if (pos[any[0]] && pos[any[1]]) {
      const x1 = pos[any[0]].r;
      const x2 = pos[any[1]].l;
      defs = srcs.map((x) => (
        <linearGradient key={x.id} id={`fm-g-${x.id}`} gradientUnits="userSpaceOnUse" x1={x1} x2={x2} y1="0" y2="0">
          <stop offset="0" stopColor={x.color} /><stop offset="1" stopColor={x.color} stopOpacity=".35" />
        </linearGradient>
      ));
    }
    pairs.forEach((n, key) => {
      const [a, b] = key.split('|');
      if (!pos[a] || !pos[b]) return;
      paths.push({ key, cls: 'rb', d: curve(a, b), a, b, stroke: `url(#fm-g-${a.slice(2)})`, w: Math.min(16, 3 + n * 2.5) });
      ribs.push({ key, a, b, n, left: (pos[a].r + pos[b].l) / 2, top: (pos[a].y + pos[b].y) / 2 });
    });
    assets.forEach((m) => {
      const a = `d:${m.database_name}`;
      const b = `a:${ix(m)}`;
      if (!pos[a] || !pos[b]) return;
      paths.push({ key: `${a}|${b}`, cls: 'ln', d: curve(a, b), a, b, stroke: (srcById[m._x.src] || OTHER).color });
    });
  }
  const pathEl = (p) => <path key={p.key} className={p.cls} d={p.d} stroke={p.stroke} strokeWidth={p.w} />;
  const lit = k ? paths.filter((p) => rel.has(p.a) && rel.has(p.b)) : [];

  const avg = Math.round(hits.reduce((a, m) => a + m._x.score, 0) / (hits.length || 1));
  const names = (arr) => [...new Set(arr)].map((x, i) => <React.Fragment key={x}>{i > 0 && ', '}<b>{x}</b></React.Fragment>);
  let bar = null;
  if (k && hits.length) {
    const type = k[0];
    const id = k.slice(2);
    let color = 'var(--ink)';
    let txt;
    if (type === 's') {
      color = (srcById[id] || OTHER).color;
      txt = <><b>{(srcById[id] || OTHER).label}</b> feeds <b>{plural(hits.length, 'matched asset')}</b> through {names(hits.map((m) => m.database_name))} &middot; average match <b>{avg}</b></>;
    } else if (type === 'd') {
      color = '#81766f';
      txt = <><b>{id}</b> holds <b>{plural(hits.length, 'matched asset')}</b> from {names(hits.map((m) => (srcById[m._x.src] || OTHER).label))} &middot; average match <b>{avg}</b></>;
    } else {
      const m = hits[0];
      color = (srcById[m._x.src] || OTHER).color;
      const where = [m._x.inName && 'name', m._x.inDesc && 'description', m._x.nFields && plural(m._x.nFields, 'field')].filter(Boolean).join(', ') || 'the catalog';
      txt = <><b>{humanize(m.name)}</b> &middot; {(srcById[m._x.src] || OTHER).label} &rarr; {m.database_name} &middot; {strengthOf(m._x.score).label} match <b>{formatScore(m.score)}</b>, found in {where}</>;
    }
    bar = <div className="map-bar on"><span className="bd" style={{ '--c': color }} /><span>{txt}</span>{pin && <button type="button" className="unpin" onClick={() => { setPin(null); setHover(null); }}>Unpin<Ico d="x" /></button>}</div>;
  } else {
    bar = <div className="map-bar"><Ico d="info" /><span>Hover a source, database or asset to trace its path. Click a source or database to pin it.</span></div>;
  }

  const trace = (e) => {
    if (pin) return;
    const n = e.target.closest?.('[data-k]');
    const key = n ? n.dataset.k : null;
    if (key !== hover) setHover(key);
  };
  const strip = (items2) => (
    <span className="smini" title={STRENGTH.map((x) => `${x.label} ${items2.filter((m) => strengthOf(m._x.score) === x).length}`).join(', ')}>
      {STRENGTH.map((x) => { const n = items2.filter((m) => strengthOf(m._x.score) === x).length; return n ? <i key={x.id} style={{ '--s': x.color, flex: n }} /> : null; })}
    </span>
  );
  const head = (ic, b, sm, n) => <div className="mh"><span className="mi"><Ico d={ic} /></span><div><b>{b}</b><small>{sm}</small></div><span className="ct">{n}</span></div>;
  const evl = (m) => (
    <span className="evl" title={`Found in: ${[m._x.inName && 'name', m._x.inDesc && 'description', m._x.nFields && plural(m._x.nFields, 'field')].filter(Boolean).join(', ')}`}>
      <i className={m._x.inName ? 'on' : ''}>N</i><i className={m._x.inDesc ? 'on' : ''}>D</i><i className={m._x.nFields ? 'on' : ''}>F</i>
    </span>
  );
  const togglePin = (key) => { setPin((p) => (p === key ? null : key)); setHover(key); };

  return (
    <div className={`map ${k && hits.length ? 'focus' : ''}`} onMouseOver={trace} onFocus={trace} onMouseLeave={() => { if (!pin) setHover(null); }}>
      <div className="map-cols">
        {head('layers', 'Source systems', 'Where the data comes from', srcs.length)}
        {head('db', 'Databases', 'Where it sits in Denodo', dbs.length)}
        {head('search', 'Matched assets', <>Views that mention &ldquo;{term}&rdquo;</>, assets.length)}
      </div>
      {bar}
      <div className={`map-cols map-body ${ready ? 'ready' : ''}`} ref={bodyRef}>
        <svg className="links base" aria-hidden="true"><defs>{defs}</defs>{paths.map(pathEl)}</svg>
        <svg className="links lit" aria-hidden="true">{lit.map(pathEl)}</svg>
        <div className="lane ls">
          {srcs.map((x) => {
            const its = list.filter((m) => m._x.src === x.id);
            const key = `s:${x.id}`;
            return (
              <button type="button" key={key} className={`mn src ${on(key)}`} data-k={key} style={{ '--c': x.color }}
                aria-label={`${x.label}, ${plural(its.length, 'asset')}. Click to pin`} onClick={() => togglePin(key)}>
                <span className="sic">{x.label.slice(0, 2).toUpperCase()}</span>
                <span className="t"><b>{x.label}</b><small>{plural(its.length, 'asset')} &middot; {plural(new Set(its.map((m) => m.database_name)).size, 'database')}</small></span>
                {strip(its)}
              </button>
            );
          })}
        </div>
        <div className="lane ld">
          {dbs.map((d) => {
            const its = list.filter((m) => m.database_name === d);
            const key = `d:${d}`;
            return (
              <button type="button" key={key} className={`mn db ${on(key)}`} data-k={key} aria-label={`${d}, ${plural(its.length, 'asset')}. Click to pin`} onClick={() => togglePin(key)}>
                <span className="dbi"><Ico d="db" /></span>
                <span className="t"><b>{d}</b><small>from {[...new Set(its.map((m) => (srcById[m._x.src] || OTHER).label))].join(', ')}</small></span>
                <span className="cnt">{its.length}</span>
              </button>
            );
          })}
        </div>
        <div className="lane la">
          {dbs.map((d) => (
            <div className="ag" data-g={d} key={d}>
              {assets.filter((m) => m.database_name === d).map((m) => {
                const key = `a:${ix(m)}`;
                return (
                  <button type="button" key={key} className={`mn as ${on(key)}`} data-k={key} style={{ '--c': (srcById[m._x.src] || OTHER).color }} onClick={() => onOpen(m)}>
                    <span className="sq" style={{ '--s': strengthOf(m._x.score).color }}>{Math.round(m._x.score)}</span>
                    <span className="t"><b><Words text={humanize(m.name)} term={term} /></b><small>{showName(m.name)}</small></span>
                    {evl(m)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="ribs">
          {ribs.map((r) => <span key={r.key} className={`rib ${k && rel.has(r.a) && rel.has(r.b) ? 'on' : ''}`} style={{ left: r.left, top: r.top }}>{r.n}</span>)}
        </div>
      </div>
      <div className="map-legend">
        {STRENGTH.map((x) => <span key={x.id}><span className="sq" style={{ '--s': x.color }} />{x.label} match</span>)}
        <span><span className="evl"><i className="on">N</i><i className="on">D</i><i>F</i></span>Found in name, description, fields</span>
        <span><span className="thick"><i style={{ height: 3 }} /><i style={{ height: 7 }} /></span>Thicker line, more assets</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer and record
// ---------------------------------------------------------------------------
function DrawerBody({ m, term, related, onRel }) {
  const grown = useGrow(m);
  const x = m._x;
  const s = srcById[x.src] || OTHER;
  const st = strengthOf(x.score);
  const [, fs, want] = useMatchedFields(m, term, true);
  const vdp = toDate(m.lastModificationVdpData);
  const isst = toDate(m.lastModificationIsstData);
  const row = (on, title, body) => <div className={on ? '' : 'off'}><span className="d">{on && <Ico d="check" />}</span><div><b>{title}</b>{body}</div></div>;
  return (
    <>
      <div className="dr-score">
        <ScoreRing score={x.score} size={78} r={32} color={st.color} grown={grown} />
        <div><b>{st.label} match</b><small>{x.nFields} field{x.nFields !== 1 ? 's' : ''} matched in <b style={{ display: 'inline', font: 'inherit', fontWeight: 600 }}>{m.database_name || 'N/A'}</b></small></div>
      </div>
      {term ? (
        <div className="sec"><h5>Why it matched</h5><div className="whyl">
          {row(x.inName, 'Name', <span className="mono"><Words text={showName(m.name)} term={term} /></span>)}
          {row(x.inDesc, 'Description', m.description
            ? (x.inDesc ? <Words text={m.description} term={term} /> : <>Doesn&rsquo;t mention it: {m.description}</>)
            : 'No description in the catalog')}
          {row(x.nFields > 0, x.nFields ? `${plural(x.nFields, 'field name')}` : 'Field names', !want ? 'No field names matched'
            : fs.status === 'error' ? 'Couldn’t load the field names. The count is from the catalog.'
              : fs.status === 'ok' && !fs.fields.length ? 'The catalog didn’t name the fields.'
                : fs.fields.length ? <div className="flds" style={{ marginTop: 4 }}>{fs.fields.map((f) => <span key={f} className="fld"><Words text={showName(f)} term={term} /></span>)}</div>
                  : <div className="skel" style={{ height: 22, width: '60%', marginTop: 4 }} />)}
        </div></div>
      ) : (
        <div className="sec"><h5>Description</h5><p>{m.description || <span className="muted">No description in the catalog</span>}</p></div>
      )}
      <div className="kv">
        <div><b>{m.matched_fields_tagged ?? 0}</b><small>Tagged fields</small></div>
        <div><b>{m.matched_custom_properties ?? 0}</b><small>Custom properties</small></div>
        <div><b>{m.countEndorsements ?? 0}</b><small>Endorsements</small></div>
      </div>
      {(x.warn || x.dep || x.cats.length > 0) && (
        <div className="sec"><h5>Status and categories</h5><div className="chips">
          {x.warn && <span className="chip warn">{plural(m.countWarnings, 'warning')}</span>}
          {x.dep && <span className="chip dep">Deprecated</span>}
          {x.cats.map((c) => <span key={c} className="chip ok">{c}</span>)}
        </div></div>
      )}
      {x.tags.length > 0 && <div className="sec"><h5>Tags</h5><div className="chips">{x.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div></div>}
      <div className="sec"><h5>Database</h5>
        <p>{m.database_name || 'N/A'} (id {m.database_id ?? 'N/A'}){hasCatalogId(m) ? `, catalog id ${m.id}` : ''}. Source {s.label}.</p>
      </div>
      {(vdp || isst) && (
        <div className="sec"><h5>Last changed</h5>
          {vdp && <p>VDP: {vdp.toLocaleString()}</p>}
          {isst && <p>ISST: {isst.toLocaleString()}</p>}
        </div>
      )}
      {related?.length > 0 && (
        <div className="sec"><h5>Also matched in {m.database_name}</h5><div className="rel">
          {related.map((o) => (
            <button type="button" key={`${o.id}|${o.name}`} onClick={() => onRel(o)}>
              <span className="sq" style={{ '--s': strengthOf(o._x.score).color }}>{Math.round(o._x.score)}</span>
              <span style={{ minWidth: 0 }}><b><Words text={humanize(o.name)} term={term} /></b><small>{showName(o.name)}</small></span>
              <Ico d="next" />
            </button>
          ))}
        </div></div>
      )}
      <details className="raw"><summary>Show raw response</summary><pre>{JSON.stringify(m, (key, v) => (key === '_x' ? undefined : v), 2)}</pre></details>
    </>
  );
}

// Values that are really JSON or a Python dict printout ({'rel': 'self', 'title': None}) become an object.
// ponytail: hand parser for Python literals, no eval; gives up (returns null) on anything it doesn't know
function parseLoose(text) {
  const s = String(text ?? '').trim();
  if (!/^[[{]/.test(s) || s.length > 50000) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { /* try the Python form */ }
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error('not a literal'); };
  const seq = (end, push) => {
    i++; ws();
    if (s[i] === end) { i++; return; }
    for (;;) {
      push();
      ws();
      if (s[i] === ',') { i++; ws(); if (s[i] === end) { i++; return; } continue; }
      if (s[i++] === end) return;
      fail();
    }
  };
  const val = () => {
    ws();
    const c = s[i];
    if (c === '{') { const o = {}; seq('}', () => { const k = val(); ws(); if (s[i++] !== ':') fail(); o[String(k)] = val(); }); return o; }
    if (c === '[' || c === '(') { const a = []; seq(c === '[' ? ']' : ')', () => a.push(val())); return a; }
    if (c === "'" || c === '"') {
      i++;
      let out = '';
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\') { i++; out += { n: '\n', t: '\t', r: '\r' }[s[i]] ?? s[i]; } else out += s[i];
        i++;
      }
      if (s[i] !== c) fail();
      i++;
      return out;
    }
    const m = /^(None|True|False|null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    const w = m[0];
    if (w === 'None' || w === 'null') return null;
    if (w === 'True' || w === 'true') return true;
    if (w === 'False' || w === 'false') return false;
    return Number(w);
  };
  try { const v = val(); ws(); return i === s.length && v && typeof v === 'object' ? v : null; } catch { return null; }
}
const structOf = (v) => (v && typeof v === 'object' ? v : typeof v === 'string' ? parseLoose(v) : null);

// an object shown as a small key / value panel, nested ones inside
function Struct({ v, mt, depth = 0 }) {
  if (v === null || v === undefined) return <span className="jv-nil">null</span>;
  if (typeof v !== 'object') {
    if (typeof v === 'string') return v === '' ? <span className="jv-nil">empty</span> : <Hl text={v} mt={mt} />;
    return <span className="jv-lit">{String(v)}</span>;
  }
  const list = Array.isArray(v);
  const entries = list ? v.map((x, k) => [k, x]) : Object.entries(v);
  if (!entries.length) return <span className="jv-nil">{list ? 'empty list' : 'empty'}</span>;
  if (depth > 4) return <span className="mono">{JSON.stringify(v)}</span>;
  return (
    <div className="jv">
      {entries.map(([k, x]) => (
        <div className="jv-r" key={k}><span className="jv-k">{list ? `#${k + 1}` : k}</span><span className="jv-v"><Struct v={x} mt={mt} depth={depth + 1} /></span></div>
      ))}
    </div>
  );
}
const RawSwitch = ({ raw, setRaw }) => (
  <div className="segs" role="group" aria-label="How to show structured values">
    <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Formatted</button>
    <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
  </div>
);

function RecordBody({ view, database, link, query, onCopyAll, onCopyField }) {
  const [state, setState] = useState({ loading: true, error: '', record: null });
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [raw, setRaw] = useState(false);
  const listRef = useRef(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', record: null });
    if (!database || !link) {
      setState({ loading: false, error: 'This row has no link back to Denodo, so the full record can’t be read.', record: null });
      return undefined;
    }
    postJson('/search/record', { database, link }, ctrl.signal)
      .then((d) => setState({ loading: false, error: '', record: d.record || {} }))
      .catch((e) => { if (!isAbort(e)) setState({ loading: false, error: friendly(e, 'Could not load the record'), record: null }); });
    return () => ctrl.abort();
  }, [database, link, nonce]);
  const mt = useMemo(() => buildMatcher(query), [query]);
  const show = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const entries = Object.entries(state.record || {});
  const hitKeys = mt ? entries.filter(([, v]) => mt.test(show(v))).map(([k]) => k) : [];
  const emptyN = entries.filter(([, v]) => show(v) === '').length;
  const structs = useMemo(() => Object.fromEntries(Object.entries(state.record || {}).map(([k, v]) => [k, structOf(v)])), [state.record]);
  const anyStruct = Object.values(structs).some(Boolean);
  const f = q.trim().toLowerCase();
  const list = entries.filter(([k, v]) => (showEmpty || show(v) !== '' || hitKeys.includes(k))
    && (!f || k.toLowerCase().includes(f) || show(v).toLowerCase().includes(f)));
  const jump = (k) => {
    const row = listRef.current?.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  };

  const head = (
    <div className="rc-head">
      <div className="rc-title">
        <span className="rc-ic"><Ico d="table" /></span>
        <div style={{ minWidth: 0 }}>
          <h3>Full record</h3>
          <p title={view}><span className="mono">{showName(view)}</span>{database && <> &middot; {database}</>} &middot; read live from Denodo</p>
        </div>
      </div>
      <button type="button" className="x" data-close aria-label="Close" autoFocus><Ico d="x" /></button>
    </div>
  );
  if (state.loading || state.error) {
    return (
      <>
        {head}
        <div className="rc-body">
          {state.loading
            ? <div aria-busy="true" aria-label="Reading the record from Denodo">{[70, 50, 80, 40, 60, 55].map((w, i) => <div key={i} className="skel" style={{ height: 14, width: `${w}%`, margin: '12px 0' }} />)}</div>
            : <div className="rec-err" role="alert">{state.error}<div><button type="button" onClick={() => setNonce((n) => n + 1)}>Try again</button></div></div>}
        </div>
        <div className="rc-foot"><span className="spacer" /><button type="button" className="btn btn-ghost" data-close>Close</button></div>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="rc-tools">
        <label className="filter"><Ico d="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a field or value" aria-label="Find a field or value" /></label>
        {hitKeys.length > 0 && (
          <div className="rc-hits">
            <span>&ldquo;{mt.term}&rdquo; {mt.fuzzy ? 'or a close word ' : ''}in</span>
            {hitKeys.map((k) => <button type="button" key={k} onClick={() => jump(k)} title={`Go to ${k}`}>{showName(k)}</button>)}
          </div>
        )}
        {anyStruct && <RawSwitch raw={raw} setRaw={setRaw} />}
        {emptyN > 0 && (
          <label className="tog"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /><span className="sw" />Show empty fields ({emptyN})</label>
        )}
      </div>
      <div className="rc-list" ref={listRef}>
        {list.map(([k, v]) => {
          const t = show(v);
          const hit = hitKeys.includes(k);
          return (
            <div key={k} data-k={k} className={`rc-row ${hit ? 'hit' : ''} ${t ? '' : 'nil'}`}>
              <div className="rc-k">{showName(k)}</div>
              <div className="rc-v">{!t ? 'empty' : structs[k] && !raw ? <Struct v={structs[k]} mt={mt} /> : structs[k] ? <span className="rc-raw"><Hl text={t} mt={mt} /></span> : <Hl text={t} mt={mt} />}</div>
              {t ? <button type="button" className="rc-cp" aria-label={`Copy ${k}`} title="Copy value" onClick={() => onCopyField(t)}><Ico d="copy" /></button> : <span />}
            </div>
          );
        })}
        {!list.length && <p className="rc-none">{entries.length ? 'No field matches that filter.' : 'Denodo returned an empty record.'}</p>}
      </div>
      <div className="rc-foot">
        <span>{plural(entries.length, 'field')} &middot; {entries.length - emptyN} with values</span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" data-close>Close</button>
        <button type="button" className="btn btn-dark" disabled={!entries.length} onClick={() => onCopyAll(entries.map(([k, v]) => `${k}: ${show(v)}`).join('\n'))}><Ico d="copy" />Copy as text</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const newTableState = () => ({ sort: null, dir: 1, filter: '', focusCols: false, more: null, moreBusy: false, moreErr: '' });
const newMf = (layout) => ({ q: '', group: 'strength', sort: 'score', layout, strength: [] });
const META_SORTS = {
  score: (a, b) => b._x.score - a._x.score,
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
  changed: (a, b) => (b._x.updated?.getTime() || 0) - (a._x.updated?.getTime() || 0),
};
let measureCtx = null;   // canvas used to find the caret position for the flying letters

export default function FuzzyMatch() {
  const { hasPermission } = useRBAC();
  const canData = hasPermission('viewData');
  const canMetadata = hasPermission('viewMetadata');
  const modes = useMemo(() => [canData && 'data', canMetadata && 'meta'].filter(Boolean), [canData, canMetadata]);

  // ---- motion tier ----
  const tier = usePerfTier();
  const [paused, setPaused] = useState(false);
  // no FPS check here: it ran in prod only (StrictMode cancels it in dev) and cut the hero effects on the server
  useEffect(() => {
    const on = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const tierRef = useRef(tier);
  tierRef.current = tier;

  // ---- saved inputs ----
  const saved = useMemo(() => readStore(STORAGE_KEY, {}) || {}, []);
  const [tol, setTol] = useState(TOL[saved.tol] ? saved.tol : 'close');
  const [sources, setSources] = useState(() => (Array.isArray(saved.datasourceFilter) ? saved.datasourceFilter.filter((s) => KNOWN.has(s)) : []));
  const [dbs, setDbs] = useState(() => (Array.isArray(saved.databaseIds) ? saved.databaseIds.filter(Number.isInteger) : []));
  const [recent, setRecent] = useState(() => (Array.isArray(saved.recent) ? saved.recent.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : []));
  useEffect(() => {
    writeStore(STORAGE_KEY, { tol, datasourceFilter: sources, databaseIds: dbs, recent });
  }, [tol, sources, dbs, recent]);

  // ---- databases (and the live pill) ----
  const [dbInfo, setDbInfo] = useState({ status: 'loading', list: [] });
  const [dbNonce, setDbNonce] = useState(0);
  useEffect(() => {
    if (!canData) { setDbInfo({ status: 'ok', list: [] }); return undefined; }
    const ctrl = new AbortController();
    let retry;
    setDbInfo((d) => ({ ...d, status: d.status === 'ok' ? 'ok' : 'loading' }));
    apiFetch('/search/databases', { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json();
      })
      .then((d) => {
        const list = Array.isArray(d.databases) ? d.databases : [];
        setDbInfo({ status: 'ok', list, loading: !!d.loading, indexState: d.index_state || 'ok' });
        // no default pick. A saved pick is only trimmed once the full list is in,
        // the list can be short while the backend is still loading it
        if (!d.loading) setDbs((cur) => cur.filter((id) => list.some((x) => x.id === id)));
        // Denodo takes about a minute to list its databases; ask again until the backend has them
        // keep asking while the backend is still loading, slower after the first minute
        if (d.loading) retry = setTimeout(() => setDbNonce((n) => n + 1), dbNonce < 15 ? 4000 : 10000);
      })
      .catch((e) => { if (!isAbort(e)) setDbInfo((d) => ({ ...d, status: 'error', error: friendly(e, 'Could not reach the service') })); });
    return () => { ctrl.abort(); clearTimeout(retry); };
  }, [canData, dbNonce]);
  // only records searches pick databases; metadata always searches every one
  const dbListOf = useCallback((kind) => (kind === 'meta' ? [] : dbInfo.list), [dbInfo]);
  const pickDbsFor = (kind) => kind !== 'meta';
  // records search only covers what the user picked, metadata never takes a list
  const dbArg = useCallback((sel, kind) => (kind === 'meta' ? [] : [...sel]), []);
  const dbName = useCallback((id) => dbInfo.list.find((d) => d.id === id)?.name || String(id), [dbInfo]);
  const normDb = useCallback((l) => [...(l || [])].sort((a, b) => a - b), []);
  const dbLabel = (l, kind = 'data') => {
    const ids = normDb(l);
    const all = dbListOf(kind).length;
    if (!ids.length) return 'Pick databases';
    if (all && ids.length === all) return 'All databases';
    if (ids.length === 1) return dbName(ids[0]);
    return `${ids.length} databases`;
  };
  // plain checkboxes: "All" picks every one (or clears them when all are on)
  const nextDbs = (cur, id, kind = 'data') => {
    const allIds = dbListOf(kind).map((d) => d.id);
    if (id === 'all') return cur.length === allIds.length ? [] : allIds;
    return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  };

  // ---- URL ----
  const [sp, setSp] = useSearchParams();
  const params = useMemo(() => readParams(sp), [sp]);
  const key = params.q ? searchKey(params) : '';
  const selParam = sp.get('v') || '';
  const tab = sp.get('tab') === 'cols' ? 'cols' : 'rows';

  // ---- home inputs ----
  const [text, setText] = useState('');
  const [mode, setMode] = useState(modes[0] || 'data');
  const [homeErr, setHomeErr] = useState('');
  const qRef = useRef(null);
  const effMode = modes.includes(mode) ? mode : (modes[0] || 'data');

  // ---- search state ----
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(null);           // {key, from, params}
  const [retry, setRetry] = useState(0);
  const resRef = useRef(null);
  const abortRef = useRef(null);
  const refreshRef = useRef(false);
  resRef.current = res;
  const secs = useElapsed(!!busy);

  // ---- results UI ----
  const [srcFilter, setSrcFilter] = useState([]);
  const [railQ, setRailQ] = useState('');
  const [railSort, setRailSort] = useState('hits');
  const [collapsed, setCollapsed] = useState(false);
  const [railW, setRailW] = useState(() => {
    const n = Number(readStore(RAIL_KEY, RAIL_DEF));
    return Number.isFinite(n) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, n)) : RAIL_DEF;
  });
  const bodyRef = useRef(null);
  const [per, setPer] = useState({});
  const [flash, setFlash] = useState(null);
  const [miniText, setMiniText] = useState('');
  const [miniTol, setMiniTol] = useState('close');
  const [miniSources, setMiniSources] = useState([]);
  const [miniDbs, setMiniDbs] = useState([]);
  const [ddOpen, setDdOpen] = useState(null);       // 'src' | 'tol' | 'db' | null
  const [mf, setMf] = useState(() => newMf(readStore(META_VIEW_KEY, 'cards') === 'map' ? 'map' : 'cards'));
  const [metaMode, setMetaMode] = useState('first');
  const [metaSoft, setMetaSoft] = useState(0);
  const [mapPin, setMapPin] = useState(null);
  const [mapHover, setMapHover] = useState(null);
  const miniRef = useRef(null);
  const miniFormRef = useRef(null);
  const resKeyRef = useRef('');

  // ---- overlays ----
  const [modal, setModal] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const lastFocus = useRef(null);
  const exportCtrl = useRef(null);

  const showToast = useCallback((msg, sticky = false) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, sticky });
    if (!sticky) toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  const hideToast = useCallback(() => { clearTimeout(toastTimer.current); setToast(null); }, []);
  const copy = useCallback((value, msg) => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(() => showToast(msg))
      .catch(() => showToast('Copy is blocked by the browser. Select the text and copy it yourself.'));
  }, [showToast]);

  // ---- run a search whenever the URL says so ----
  const show = useCallback((r) => {
    setRes(r);
    resKeyRef.current = r.key;
    setSrcFilter([]);
    setRailQ('');
    setPer({});
    setFlash(null);
    setMf((f) => newMf(f.layout));
    setMetaMode('first');
    setMapPin(null);
    setMapHover(null);
    const term = parseQuery(r.params.q).term;
    setMiniText(term);
    setMiniTol(r.kind === 'meta' ? tol : tolOf(r.params.q));
    setMiniSources(r.params.src);
    setMiniDbs(r.params.db);
  }, [tol]);
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    if (!key) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(null);
      setRes(null);
      return;
    }
    const refresh = refreshRef.current;
    refreshRef.current = false;
    const cur = resRef.current;
    if (!refresh && cur && cur.key === key) return;
    const p = params;
    const from = cur ? 'results' : 'home';

    if ((p.m === 'meta' && !canMetadata) || (p.m === 'data' && !canData)) {
      setHomeErr(p.m === 'meta' ? "You don't have access to metadata search." : "You don't have access to record search.");
      setRes(null);
      return;
    }
    const hit = !refresh && resultCache.get(key);
    if (hit) {
      abortRef.current?.abort();
      setBusy(null);
      showRef.current(hit);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy({ key, from, params: p });
    setHomeErr('');
    if (from === 'home') {
      const term = parseQuery(p.q).term;
      setText(term);
      setMode(p.m);
      if (p.m === 'data') setTol(tolOf(p.q));
      setSources(p.src);
      if (p.m === 'data' && p.db.length) setDbs(p.db);
    }

    (async () => {
      try {
        let r;
        if (p.m === 'meta') {
          const term = parseQuery(p.q).term;
          const d = await postJson('/metadata', { search_text: term, datasources: p.src, ...METADATA_SEARCH }, ctrl.signal);
          const items = (Array.isArray(d.metadata) ? d.metadata : []).map((m) => enrich(m, term));
          r = { key, params: p, kind: 'meta', items, term, cached: !!d.cached };
        } else {
          const d = await postJson('/search', {
            search_text: p.q, datasources: p.src, refresh, ...(p.db.length ? { database_ids: p.db } : {}),
          }, ctrl.signal);
          const results = d.results && typeof d.results === 'object' ? d.results : {};
          Object.entries(results).forEach(([n, v]) => {
            v.datasource = v.datasource || datasourceOf(v.view || n);
            v.records = Array.isArray(v.records) ? v.records : [];
            v.record_count = v.record_count ?? v.records.length;
          });
          r = {
            key, params: p, kind: 'data', results,
            stats: {
              total: d.total_records ?? 0,
              views: d.view_count ?? Object.keys(results).length,
              tookMs: d.took_ms ?? 0,
              cached: !!d.cached,
              notes: Array.isArray(d.notes) ? d.notes : [],
              valueCap: d.value_cap || VALUE_CAP,
              perView: d.rows_per_view_cap || ROWS_PER_VIEW,
            },
          };
        }
        if (ctrl.signal.aborted) return;
        cachePut(key, r);
        showRef.current(r);
        hideToast();
        const remembered = p.m === 'meta' ? r.term : p.q;
        setRecent((prev) => [remembered, ...prev.filter((x) => x !== remembered)].slice(0, MAX_RECENT));
      } catch (e) {
        if (isAbort(e) || ctrl.signal.aborted) return;
        const msg = friendly(e, 'Search failed. Please try again.');
        if (from === 'home') {
          setHomeErr(msg);
        } else {
          showToast(msg);
          const back = resRef.current;
          if (back) setSp(toParams(back.params), { replace: true });
        }
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setBusy(null);
        }
      }
    })();
  // params is derived from key; retry re-runs the same key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, canData, canMetadata]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const go = useCallback((p, { push = true } = {}) => {
    const next = { ...p, q: p.q.trim().slice(0, MAX_TERM) };
    if (!next.q) return;
    if (searchKey(next) === key) { setRetry((n) => n + 1); return; }
    setSp(toParams(next), { replace: !push });
  }, [key, setSp]);

  const stopSearch = useCallback(() => {
    if (!busy) return;
    abortRef.current?.abort();
    abortRef.current = null;
    const from = busy.from;
    setBusy(null);
    if (from === 'home') setSp({}, { replace: true });
    else if (resRef.current) setSp(toParams(resRef.current.params), { replace: true });
    showToast('Search stopped');
  }, [busy, setSp, showToast]);

  const onResults = !!res && !!key;
  const onHome = !onResults;
  const onHomeRef = useRef(onHome);
  onHomeRef.current = onHome;
  const homeBusy = !!busy && busy.from === 'home';
  const resultsBusy = !!busy && busy.from === 'results';

  // results-side wait toast
  useEffect(() => {
    if (resultsBusy && secs >= 3) showToast(`Waiting on Denodo, ${secs}s. A new term usually takes 30 to 60s.`, true);
  }, [resultsBusy, secs, showToast]);

  // ---------------------------------------------------------------------------
  // Motion: background layers, pointer, view switch
  // ---------------------------------------------------------------------------
  const fmRef = useRef(null);
  const homeRef = useRef(null);
  const resultsRef = useRef(null);
  const cmdRef = useRef(null);
  const goRef = useRef(null);
  const spotRef = useRef(null);
  const auroraRef = useRef(null);
  const fieldRef = useRef(null);
  const segRef = useRef(null);
  const labMeasureRef = useRef(null);
  const ptr = useRef({ x: -9999, y: -9999, pending: false });
  const field = useRef({ P: [], W: 0, H: 0 });

  // sliding pill under Content / Metadata
  const placeSeg = useCallback(() => {
    const seg = segRef.current;
    if (!seg) return;
    const on = seg.querySelector('[aria-pressed=true]');
    const pill = seg.querySelector('.pill');
    if (!on || !pill) return;
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }, []);

  // A copy of the search bar flies into the results bar
  const flyBar = (fromEl, toEl, resultsEl) => {
    if (tierRef.current === 'min' || !fromEl?.animate || !toEl) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const ghost = fromEl.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    const shift = new DOMMatrix(getComputedStyle(resultsEl).transform).m42 || 0;
    Object.assign(ghost.style, { position: 'fixed', left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`, margin: 0, zIndex: 1070, pointerEvents: 'none', transformOrigin: '0 0', animation: 'none' });
    fmRef.current.appendChild(ghost);
    const sx = b.width / a.width;
    const sy = b.height / a.height;
    const to = `translate(${b.left - a.left}px,${b.top - shift - a.top}px) scale(${sx},${sy})`;
    const anim = ghost.animate([
      { transform: 'translate(0,0) scale(1,1)', opacity: 1 },
      { transform: to, opacity: 1, offset: 0.8 },
      { transform: to, opacity: 0 },
    ], { duration: 620, easing: 'cubic-bezier(.16,1,.3,1)' });
    toEl.animate([{ opacity: 0 }, { opacity: 0, offset: 0.65 }, { opacity: 1 }], { duration: 620 });
    anim.onfinish = () => ghost.remove();
    anim.oncancel = () => ghost.remove();
  };

  // home and results swap with a fade; the hidden one leaves the layout after it fades
  const firstView = useRef(true);
  useLayoutEffect(() => {
    const h = homeRef.current;
    const r = resultsRef.current;
    if (firstView.current) {
      firstView.current = false;
      h.classList.toggle('off', !onHome); h.classList.toggle('gone', !onHome);
      r.classList.toggle('off', onHome); r.classList.toggle('gone', onHome);
      return undefined;
    }
    const [showEl, hideEl] = onHome ? [h, r] : [r, h];
    showEl.classList.remove('gone');
    void showEl.offsetWidth;
    hideEl.classList.add('off');
    showEl.classList.remove('off');
    const t = setTimeout(() => { if (hideEl.classList.contains('off')) hideEl.classList.add('gone'); }, 450);
    if (onHome) { placeSeg(); labMeasureRef.current?.(); } else flyBar(cmdRef.current, miniFormRef.current, r);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onHome]);

  // letter constellation: drifting glyphs, linked when close, pushed away by the cursor
  useEffect(() => {
    const cv = fieldRef.current;
    const host = fmRef.current;
    if (!cv || !host) return undefined;
    if (!(onHome && tier === 'full' && !paused)) { cv.classList.remove('on'); return undefined; }
    const cx = cv.getContext('2d');
    const F = field.current;
    const GL = 'abcdefghijklmnopqrstuvwxyz~*?'.split('');
    const size = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      F.W = host.clientWidth; F.H = host.clientHeight;
      cv.width = F.W * dpr; cv.height = F.H * dpr;
      cv.style.width = `${F.W}px`; cv.style.height = `${F.H}px`;
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    if (!F.P.length) {
      const n = Math.round(Math.min(85, (F.W * F.H) / 17000));
      F.P = Array.from({ length: n }, () => {
        const vx = (Math.random() - 0.5) * 0.3;
        const vy = (Math.random() - 0.5) * 0.3;
        return { x: Math.random() * F.W, y: Math.random() * F.H, vx, vy, bx: vx, by: vy, g: GL[Math.random() * GL.length | 0], s: [12, 15, 19][Math.random() * 3 | 0], a: 0.12 + Math.random() * 0.14, fl: 0 };
      }).sort((p, q) => p.s - q.s);
    }
    cv.classList.add('on');
    let raf;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const { P: pts, W, H } = F;
      const mx = ptr.current.x;
      const my = ptr.current.y;
      cx.clearRect(0, 0, W, H);
      const R = 140;
      const L = 120;
      for (const p of pts) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < R * R) { const d = Math.sqrt(d2) || 1; const f = ((R - d) / R) * 0.55; p.vx += (dx / d) * f; p.vy += (dy / d) * f; p.fl = Math.max(p.fl, 0.8); }
        p.vx += (p.bx - p.vx) * 0.03; p.vy += (p.by - p.vy) * 0.03;
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
        if (Math.random() < 0.0012) { p.g = GL[Math.random() * GL.length | 0]; p.fl = 1; }
        p.fl *= 0.965;
      }
      cx.lineWidth = 1;
      // ponytail: O(n²) link scan, fine at the 85-glyph cap
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > L * L) continue;
          const k = 1 - Math.sqrt(d2) / L;
          const hot = Math.max(a.fl, b.fl);
          cx.strokeStyle = hot > 0.15 ? `rgba(235,23,0,${(k * 0.35 * hot).toFixed(3)})` : `rgba(49,44,42,${(k * 0.09).toFixed(3)})`;
          cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke();
        }
      }
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      let font = 0;
      for (const p of pts) {
        if (p.s !== font) { font = p.s; cx.font = `600 ${font}px 'Segoe UI', system-ui, sans-serif`; }
        cx.fillStyle = p.fl > 0.05 ? `rgba(235,23,0,${Math.min(0.9, p.a + p.fl * 0.6).toFixed(3)})` : `rgba(49,44,42,${p.a.toFixed(3)})`;
        cx.fillText(p.g, p.x, p.y);
      }
    };
    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(size);
    ro.observe(host);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [onHome, tier, paused]);

  useEffect(() => { if (tier !== 'full' || !onHome) spotRef.current?.classList.remove('on'); }, [tier, onHome]);

  // cursor: spotlight and parallax
  const applyPointer = () => {
    ptr.current.pending = false;
    if (tierRef.current !== 'full' || !onHomeRef.current) return;
    const { x, y } = ptr.current;
    const host = fmRef.current;
    spotRef.current.classList.add('on');
    spotRef.current.style.transform = `translate(${x}px,${y}px)`;
    const nx = x / host.clientWidth - 0.5;
    const ny = y / host.clientHeight - 0.5;
    auroraRef.current.style.transform = `translate(${nx * -40}px,${ny * -40}px)`;
  };
  const onHomeMove = (e) => {
    const r = fmRef.current.getBoundingClientRect();
    ptr.current.x = e.clientX - r.left;
    ptr.current.y = e.clientY - r.top;
    if (!ptr.current.pending) { ptr.current.pending = true; requestAnimationFrame(applyPointer); }
  };
  const onHomeLeave = () => { ptr.current.x = -9999; ptr.current.y = -9999; spotRef.current?.classList.remove('on'); };

  // magnetic search button
  const onCmdMove = (e) => {
    const b = goRef.current;
    if (!b) return;
    if (tierRef.current !== 'full' || b.disabled) { b.style.translate = ''; return; }
    const r = b.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    b.style.translate = Math.hypot(dx, dy) < 120 ? `${(dx * 0.18).toFixed(1)}px ${(dy * 0.28).toFixed(1)}px` : '';
  };
  const onCmdLeave = () => { if (goRef.current) goRef.current.style.translate = ''; };

  // typed letters lift off the caret
  const flyLetter = (input, ch) => {
    if (tierRef.current === 'min' || !ch || !document.body.animate) return;
    measureCtx ||= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(input);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const at = input.selectionStart ?? input.value.length;
    const r = input.getBoundingClientRect();
    const x = Math.min(r.width, measureCtx.measureText(input.value.slice(0, at)).width - input.scrollLeft);
    const s = document.createElement('span');
    s.className = 'fly';
    s.textContent = ch.slice(-1);
    s.style.left = `${r.left + x}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    fmRef.current.appendChild(s);
    const dx = (Math.random() - 0.5) * 40;
    const rot = (Math.random() - 0.5) * 60;
    const a = s.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.95 },
      { transform: `translate(calc(-50% + ${dx}px),calc(-50% - 58px)) rotate(${rot}deg) scale(1.5)`, opacity: 0 },
    ], { duration: 750, easing: 'cubic-bezier(.16,1,.3,1)' });
    a.onfinish = () => s.remove();
  };

  // launch burst when a search starts
  const burst = (el) => {
    if (tierRef.current === 'min' || !el?.animate) return;
    const r = el.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'burst';
    layer.style.left = `${r.left + r.width / 2}px`;
    layer.style.top = `${r.top + r.height / 2}px`;
    fmRef.current.appendChild(layer);
    const ring = document.createElement('i');
    layer.appendChild(ring);
    ring.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 0.8 }, { transform: 'translate(-50%,-50%) scale(3.4)', opacity: 0 }], { duration: 750, easing: 'cubic-bezier(.16,1,.3,1)' });
    const glyphs = ['~', '*', 'a', 'e', 'i', 'o', 'u', '?'];
    const n = tierRef.current === 'full' ? 18 : 10;
    for (let i = 0; i < n; i++) {
      const b = document.createElement('b');
      b.textContent = glyphs[i % glyphs.length];
      layer.appendChild(b);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const d = 60 + Math.random() * 80;
      b.animate([
        { transform: 'translate(-50%,-50%) scale(.5)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * d}px),calc(-50% + ${Math.sin(ang) * d}px)) rotate(${(Math.random() - 0.5) * 220}deg) scale(1.1)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 350, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
    }
    setTimeout(() => layer.remove(), 1200);
  };

  // click ripple on pills, chips and the search button
  useEffect(() => {
    const host = fmRef.current;
    const onDown = (e) => {
      if (tierRef.current === 'min') return;
      const t = e.target.closest?.('.pb,.qc,.go');
      if (!t || !host.contains(t)) return;
      const { clientX: x, clientY: y } = e;
      requestAnimationFrame(() => {
        if (!t.isConnected) return;
        const r = t.getBoundingClientRect();
        const d = Math.max(r.width, r.height) * 2.4;
        const s = document.createElement('span');
        s.className = 'rip';
        Object.assign(s.style, { left: `${x - r.left}px`, top: `${y - r.top}px`, width: `${d}px`, height: `${d}px` });
        t.appendChild(s);
        setTimeout(() => s.remove(), 700);
      });
    };
    host.addEventListener('pointerdown', onDown);
    return () => host.removeEventListener('pointerdown', onDown);
  }, []);

  // styled tooltips: any title inside the page shows in our own bubble instead of the browser's
  const tipRef = useRef(null);
  useEffect(() => {
    const host = fmRef.current;
    const tip = tipRef.current;
    let el = null;
    let timer = null;
    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove('on');
      if (el) { if (!el.hasAttribute('title') && el.dataset.tip) el.setAttribute('title', el.dataset.tip); el = null; }
    };
    const place = (target, text) => {
      if (!target.isConnected) return;
      tip.textContent = text;
      const r = target.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const below = r.top - h - 10 < 8;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${below ? r.bottom + 10 : r.top - h - 10}px`;
      tip.style.setProperty('--ax', `${Math.max(10, Math.min(w - 10, r.left + r.width / 2 - left))}px`);
      tip.dataset.side = below ? 'below' : 'above';
      tip.classList.add('on');
    };
    const over = (e) => {
      const target = e.target.closest?.('[title]');
      if (!target || target === el || !host.contains(target)) return;
      const text = target.getAttribute('title');
      if (!text) return;
      hide();
      el = target;
      target.dataset.tip = text;
      target.removeAttribute('title');    // stops the browser's own tooltip
      timer = setTimeout(() => place(target, text), 350);
    };
    const out = (e) => { if (el && !el.contains(e.relatedTarget)) hide(); };
    host.addEventListener('pointerover', over);
    host.addEventListener('pointerout', out);
    host.addEventListener('pointerdown', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide);
    return () => {
      hide();
      host.removeEventListener('pointerover', over);
      host.removeEventListener('pointerout', out);
      host.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------
  const homeQuery = effMode === 'meta' ? parseQuery(text).term : buildQuery(text, tol);
  const needDb = effMode === 'data' && !dbs.length;
  const canSearch = !!parseQuery(homeQuery).term && modes.length > 0 && !needDb;

  const startSearch = useCallback((override) => {
    const raw = override ?? text;
    const q = effMode === 'meta' ? parseQuery(raw).term : buildQuery(raw, tol);
    if (!parseQuery(q).term) { qRef.current?.focus(); return; }
    if (effMode === 'data' && !dbs.length) { setHomeErr('Pick at least one database to search.'); return; }
    setHomeErr('');
    burst(goRef.current);
    go({ q, m: effMode, src: sources, db: dbArg(dbs, effMode) });
  }, [text, effMode, tol, sources, dbs, dbArg, go]);

  useLayoutEffect(() => { if (onHome) placeSeg(); }, [onHome, effMode, modes, placeSeg]);
  useEffect(() => {
    const onResize = () => placeSeg();
    window.addEventListener('resize', onResize);
    document.fonts?.ready?.then(placeSeg);
    return () => window.removeEventListener('resize', onResize);
  }, [placeSeg]);

  // focus the box on first load (desktop only, no keyboard pop on phones)
  useEffect(() => {
    if (onHome && window.matchMedia?.('(pointer:fine)').matches) qRef.current?.focus({ preventScroll: true });
  }, [onHome]);

  const toggleSource = (id) => {
    setSources((cur) => {
      let next = id === 'all' ? [] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (next.length === SOURCES.length) next = [];
      return next;
    });
  };
  const setLabTol = (k) => { if (!hasSyntax(text)) setTol(k); };

  // ---- did you mean + type-ahead ----
  const [sug, setSug] = useState({ open: false, list: [], i: -1, completion: '' });
  const closeSug = () => setSug((s) => (s.open || s.completion ? { open: false, list: [], i: -1, completion: '' } : s));
  const refreshSug = (raw) => {
    const el = qRef.current;
    const list = effMode === 'data' && !busy && el && document.activeElement === el ? suggest(raw, recent) : [];
    if (!list.length || (list.length === 1 && list[0].kind === 'exact')) { closeSug(); return; }
    const top = list.find((s) => s.kind === 'comp');
    const atEnd = el.selectionStart === raw.length && el.scrollWidth <= el.clientWidth;
    const completion = top && atEnd && !hasSyntax(raw) && top.term.toLowerCase().startsWith(raw.toLowerCase()) ? top.term.slice(raw.length) : '';
    setSug({ open: true, list, i: -1, completion });
  };
  const pickSug = (i) => {
    const term = i >= 0 && sug.list[i] ? sug.list[i].term : text;
    if (i >= 0) setText(term);
    closeSug();
    if (homeBusy) return;
    startSearch(term);
  };
  const onQKey = (e) => {
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && sug.completion && !e.shiftKey) {
      e.preventDefault();
      const next = text + sug.completion;
      setText(next);
      requestAnimationFrame(() => refreshSug(next));
      return;
    }
    if (!sug.open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSug((s) => ({ ...s, i: Math.max(-1, Math.min(s.list.length - 1, s.i + step)) }));
    } else if (e.key === 'Escape') { e.stopPropagation(); closeSug(); } else if (e.key === 'Enter' && sug.i >= 0) { e.preventDefault(); pickSug(sug.i); }
  };
  const sugTerm = (s) => {
    if (s.kind === 'comp' && s.term.toLowerCase().startsWith(s.w)) return <>{s.term.slice(0, s.w.length)}<u>{s.term.slice(s.w.length)}</u></>;
    if (s.kind[0] !== 't' || s.n.length !== s.term.length) return s.term;
    const mask = diffMask(s.w, s.n);
    return [...s.term].map((c, i) => (mask[i] ? <em key={i}>{c}</em> : <React.Fragment key={i}>{c}</React.Fragment>));
  };

  const scanTitle = !busy ? '' : busy.params.m === 'meta'
    ? <>Metadata for <b>{parseQuery(busy.params.q).term}</b></>
    : <>Looking for <b>{busy.params.q}</b></>;
  const scanSub = !busy ? '' : busy.params.m === 'meta'
    ? 'View names, descriptions and field names in every catalog database.'
    : (() => {
      const q = parseQuery(busy.params.q);
      const srcTxt = busy.params.src.length ? busy.params.src.map((id) => srcById[id].label).join(', ') : 'All sources';
      const dbList = busy.params.db;
      const dbTxt = dbList.length ? ` in ${dbList.map(dbName).join(', ')}` : '';
      return `${srcTxt}${dbTxt}. ${describe(q)}`;
    })();

  const live = dbInfo.status === 'ok'
    ? { cls: 'live', text: `${SOURCES.length} sources connected`, title: `${SOURCES.length} sources connected` }
    : dbInfo.status === 'loading'
      ? { cls: 'live warn', text: 'Connecting', title: 'Checking the search service' }
      : { cls: 'live bad', text: "Can't reach service", title: dbInfo.error || 'The search service is not answering' };
  const face = homeBusy ? 'scan' : effMode === 'meta' ? 'meta' : 'tune';

  // ---------------------------------------------------------------------------
  // Results: data
  // ---------------------------------------------------------------------------
  const isData = res?.kind === 'data';
  const results = useMemo(() => (isData ? res.results : {}), [isData, res]);
  const allNames = useMemo(() => Object.keys(results), [results]);
  const matcher = useMemo(() => (isData ? buildMatcher(res.params.q) : null), [isData, res]);

  const railNames = useMemo(() => {
    const f = railQ.trim().toLowerCase();
    let names = allNames.filter((n) => !srcFilter.length || srcFilter.includes(results[n].datasource));
    if (f) names = names.filter((n) => n.toLowerCase().includes(f));
    return names.sort(railSort === 'hits'
      ? (a, b) => (results[b].record_count - results[a].record_count) || a.localeCompare(b)
      : (a, b) => a.localeCompare(b));
  }, [allNames, results, srcFilter, railQ, railSort]);
  const railGroups = useMemo(() => {
    const groups = {};
    railNames.forEach((n) => { (groups[results[n].datasource] ||= []).push(n); });
    return ALL_SOURCES.filter((s) => groups[s.id]).map((s) => ({ s, names: groups[s.id] }));
  }, [railNames, results]);
  const railOrder = useMemo(() => railGroups.flatMap((g) => g.names), [railGroups]);
  const selected = railOrder.includes(selParam) ? selParam : railOrder[0] || null;
  const grown = useGrow(res?.key || '');
  const colGrown = useGrow(`${res?.key || ''}|${selected}|${tab}`);

  const selectView = useCallback((n) => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      p.set('v', n);
      return p;
    }, { replace: true });
  }, [setSp]);
  const setTab = useCallback((t) => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      if (t === 'cols') p.set('tab', 'cols'); else p.delete('tab');
      return p;
    }, { replace: true });
  }, [setSp]);

  const tableOf = useCallback((n) => per[n] || newTableState(), [per]);
  const patchTable = useCallback((n, patch) => {
    setPer((prev) => ({ ...prev, [n]: { ...(prev[n] || newTableState()), ...patch } }));
  }, []);

  const view = selected ? results[selected] : null;
  const viewSt = selected ? tableOf(selected) : null;
  const viewMore = viewSt?.more || null;
  const shown = useMemo(() => (view ? (viewMore || { records: view.records, hits: view.hits || [], links: view.links || [], count: view.record_count }) : null), [view, viewMore]);
  const columns = useMemo(() => {
    if (!view) return [];
    const out = [];
    const seen = new Set();
    [...view.records, ...(shown?.records || [])].forEach((r) => Object.keys(r || {}).forEach((c) => { if (!seen.has(c)) { seen.add(c); out.push(c); } }));
    return out;
  }, [view, shown]);
  const baseColumns = useMemo(() => {
    if (!view) return [];
    const out = [];
    const seen = new Set();
    view.records.forEach((r) => Object.keys(r || {}).forEach((c) => { if (!seen.has(c)) { seen.add(c); out.push(c); } }));
    return out;
  }, [view]);
  const hitCount = useMemo(() => {
    const out = Object.fromEntries(columns.map((c) => [c, 0]));
    if (matcher && shown) shown.records.forEach((r) => columns.forEach((c) => { if (matcher.test(String(r[c] ?? ''))) out[c]++; }));
    return out;
  }, [columns, shown, matcher]);

  const loadMore = useCallback(async (n) => {
    const v = results[n];
    const st = tableOf(n);
    if (!v || st.moreBusy) return;
    const forKey = resKeyRef.current;
    patchTable(n, { moreBusy: true, moreErr: '' });
    try {
      const offset = st.more ? st.more.records.length : 0;
      const page = await postJson('/search/view-rows', {
        search_text: res.params.q, database: v.database, view: v.view, offset, limit: MORE_PAGE, columns: baseColumns,
      });
      if (resKeyRef.current !== forKey) return;
      setPer((prev) => {
        const cur = prev[n] || newTableState();
        const before = cur.more || { records: [], hits: [], links: [] };
        return {
          ...prev,
          [n]: {
            ...cur,
            moreBusy: false,
            more: {
              records: [...before.records, ...(page.records || [])],
              hits: [...before.hits, ...(page.hits || [])],
              links: [...before.links, ...(page.links || [])],
              count: page.count ?? v.record_count,
            },
          },
        };
      });
    } catch (e) {
      if (resKeyRef.current === forKey) patchTable(n, { moreBusy: false, moreErr: friendly(e, 'Could not load more rows') });
    }
  }, [results, tableOf, patchTable, res, baseColumns]);

  const flashColumn = (c) => {
    setTab('rows');
    setFlash({ c, t: Date.now() });
  };
  useEffect(() => {
    if (!flash) return undefined;
    const id = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(id);
  }, [flash]);

  // sliding selection in the rail
  const railRef = useRef(null);
  const selRef = useRef(null);
  const selPlaced = useRef(false);
  useLayoutEffect(() => {
    const list = railRef.current;
    const sel = selRef.current;
    if (!list || !sel) { selPlaced.current = false; return; }
    const cur = list.querySelector('.item[aria-current=true]');
    if (!cur) { sel.style.height = '0px'; return; }
    const instant = !selPlaced.current;
    if (instant) sel.style.transition = 'none';
    sel.style.height = `${cur.offsetHeight}px`;
    sel.style.transform = `translateY(${cur.offsetTop}px)`;
    sel.style.setProperty('--c', cur.style.getPropertyValue('--c'));
    if (instant) requestAnimationFrame(() => { sel.style.transition = ''; });
    selPlaced.current = true;
  });

  // tab ink
  const tabsRef = useRef(null);
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const on = tabs.querySelector('[aria-selected=true]');
    const ink = tabs.querySelector('.ink');
    if (!on || !ink) return;
    ink.style.width = `${on.offsetWidth}px`;
    ink.style.transform = `translateX(${on.offsetLeft}px)`;
  });
  const [, bump] = useState(0);
  useEffect(() => {
    const onResize = () => { selPlaced.current = false; bump((n) => n + 1); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // summary numbers for records
  const summary = useMemo(() => {
    if (!isData || !allNames.length) return null;
    const counts = {};
    allNames.forEach((n) => { const v = results[n]; counts[v.datasource] = (counts[v.datasource] || 0) + (v.record_count || 0); });
    const st = res.stats;
    const stats = [
      { n: st.total, l: 'matching records', plus: allNames.some((n) => results[n].total_capped) },
      { n: st.views, l: 'views' },
      { n: Object.keys(counts).length, l: 'sources hit' },
      { raw: `${(st.tookMs / 1000).toFixed(st.tookMs < 1000 ? 2 : 1)}s`, l: 'search time', cached: st.cached },
    ];
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const present = ALL_SOURCES.filter((s) => counts[s.id]);
    return { stats, counts, total, present };
  }, [isData, res, allNames, results]);

  // the view list can be dragged wider or narrower; the width is remembered
  const clampRail = (w) => Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, (bodyRef.current?.clientWidth || 2000) - 420, w)));
  const saveRailW = (w) => { const v = clampRail(w); setRailW(v); writeStore(RAIL_KEY, v); };
  const startRailDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const body = bodyRef.current;
    const h = e.currentTarget;
    h.setPointerCapture(e.pointerId);
    h.classList.add('drag');
    body.classList.add('resizing');
    const left = body.getBoundingClientRect().left;
    let w = railW;
    let raf = 0;
    const move = (ev) => {
      w = clampRail(ev.clientX - left - 5);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => body.style.setProperty('--rail-w', `${w}px`));
    };
    const up = () => {
      cancelAnimationFrame(raf);
      h.classList.remove('drag');
      body.classList.remove('resizing');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      saveRailW(w);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  };
  const railKeys = (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); saveRailW(railW - step); } else if (e.key === 'ArrowRight') { e.preventDefault(); saveRailW(railW + step); } else if (e.key === 'Home') { e.preventDefault(); saveRailW(RAIL_MIN); } else if (e.key === 'End') { e.preventDefault(); saveRailW(RAIL_MAX); }
  };

  const toggleSrcFilter = (id) => {
    setSrcFilter((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    if (res?.kind === 'meta') softMeta();
  };
  const refreshFromSource = () => {
    if (!res || busy) return;
    refreshRef.current = true;
    setRetry((n) => n + 1);
  };

  // ---------------------------------------------------------------------------
  // Results: metadata
  // ---------------------------------------------------------------------------
  const resMeta = res?.kind === 'meta';
  const metaItems = useMemo(() => (resMeta ? res.items : []), [resMeta, res]);
  const metaGrown = useGrow(resMeta ? res.key : '');
  const softMeta = () => { setMetaMode('soft'); setMetaSoft((n) => n + 1); };
  const patchMf = (patch, soft = true) => {
    setMf((f) => ({ ...f, ...patch }));
    if (patch.layout) writeStore(META_VIEW_KEY, patch.layout);
    if (soft) softMeta(); else setMetaMode('');
  };
  const metaList = useMemo(() => {
    const f = mf.q.trim().toLowerCase();
    return metaItems.filter((m) => (!srcFilter.length || srcFilter.includes(m._x.src))
      && (!mf.strength.length || mf.strength.includes(strengthOf(m._x.score).id))
      && (!f || `${m.name} ${m.database_name} ${m._x.tags.join(' ')} ${m._x.cats.join(' ')}`.toLowerCase().includes(f)))
      .sort(META_SORTS[mf.sort]);
  }, [metaItems, srcFilter, mf]);
  const metaGroups = useMemo(() => {
    const list = metaList;
    if (mf.group === 'none') return [{ key: 'all', items: list }];
    if (mf.group === 'strength') {
      return STRENGTH.map((x) => ({ key: x.id, title: x.title, note: x.note, color: x.color, items: list.filter((m) => strengthOf(m._x.score) === x) })).filter((x) => x.items.length);
    }
    if (mf.group === 'source') {
      return ALL_SOURCES.map((x) => {
        const items = list.filter((m) => m._x.src === x.id);
        const n = new Set(items.map((m) => m.database_name)).size;
        return { key: x.id, title: x.label, color: x.color, note: `in ${plural(n, 'database')}`, items };
      }).filter((x) => x.items.length);
    }
    return [...new Set(list.map((m) => m.database_name))].sort().map((d) => {
      const items = list.filter((m) => m.database_name === d);
      return { key: d, title: d, color: 'var(--ink)', note: `from ${[...new Set(items.map((m) => (srcById[m._x.src] || OTHER).label))].join(', ')}`, items };
    });
  }, [metaList, mf.group]);
  const toggleStrength = (id) => patchMf({ strength: mf.strength.includes(id) ? mf.strength.filter((x) => x !== id) : [...mf.strength, id] });

  // ---- mini search bar ----
  const miniTilde = hasSyntax(miniText);
  const miniActiveTol = miniTilde ? tolOf(miniText) : miniTol;
  const miniQuery = resMeta ? parseQuery(miniText).term : buildQuery(miniText, miniTol);
  const resDbKind = resMeta ? 'meta' : 'data';
  const miniDbsN = normDb(miniDbs);
  const sameDbs = !res || JSON.stringify(miniDbsN) === JSON.stringify(normDb(res.params.db));
  const miniDirty = !!res && (searchKey({ ...res.params, q: miniQuery, src: miniSources }) !== res.key || !sameDbs);
  const miniCanGo = miniDirty && !!parseQuery(miniQuery).term && (resMeta || miniDbsN.length > 0);
  const sameSources = res ? JSON.stringify([...miniSources].sort()) === JSON.stringify([...res.params.src].sort()) : true;

  const submitMini = (e) => {
    e.preventDefault();
    setDdOpen(null);
    if (busy) { stopSearch(); return; }
    if (!miniCanGo) return;
    setSources([...miniSources]);
    if (!resMeta && !miniTilde) setTol(miniTol);
    setText(miniText);
    const db = pickDbsFor(resDbKind) ? dbArg(miniDbsN, resDbKind) : res.params.db;
    if (pickDbsFor(resDbKind)) setDbs(miniDbsN);
    go({ q: miniQuery, m: resMeta ? 'meta' : 'data', src: [...miniSources], db });
  };
  const toggleMiniSource = (id) => {
    setMiniSources((cur) => {
      let next = id === 'all' ? [] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (next.length === SOURCES.length) next = [];
      return next;
    });
  };
  const DD_BTN = { src: 'srcBtn', tol: 'tolBtn', db: 'dbBtn' };
  const DD_MENU = { src: 'srcMenu', tol: 'tolMenu', db: 'dbMenu' };
  // filter box in the results page database menu
  const [dbQ, setDbQ] = useState('');
  const dbQRef = useRef(null);
  useEffect(() => {
    if (ddOpen === 'db') requestAnimationFrame(() => dbQRef.current?.focus());
    else setDbQ('');
  }, [ddOpen]);
  const menuDbs = useMemo(() => {
    const t = dbQ.trim().toLowerCase();
    return [...dbListOf(resDbKind)].sort(byIndexThenName).filter((x) => !t || x.name.toLowerCase().includes(t));
  }, [dbListOf, resDbKind, dbQ]);

  const menuKeys = (e) => {
    if (e.target === dbQRef.current) {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.querySelector('.dd-item')?.focus(); return; }
      if (e.key === 'Escape' && dbQ) { e.stopPropagation(); setDbQ(''); return; }
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && dbQRef.current && e.currentTarget.contains(dbQRef.current)) {
      // typing on a list item goes to the filter box
      dbQRef.current.focus();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll('.dd-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      const which = ddOpen;
      setDdOpen(null);
      document.getElementById(DD_BTN[which])?.focus();
    } else if (e.key === 'Tab') {
      setDdOpen(null);
    }
  };
  useEffect(() => {
    if (!ddOpen) return undefined;
    const onDoc = (e) => { if (!e.target.closest?.('.dd')) setDdOpen(null); };
    document.addEventListener('mousedown', onDoc);
    const id = setTimeout(() => {
      const menu = document.getElementById(DD_MENU[ddOpen]);
      (menu?.querySelector('.dd-item[aria-checked=true]') || menu?.querySelector('.dd-item'))?.focus();
    }, 30);
    return () => { document.removeEventListener('mousedown', onDoc); clearTimeout(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ddOpen]);

  const newSearch = () => {
    if (busy) { abortRef.current?.abort(); abortRef.current = null; setBusy(null); hideToast(); }
    setDrawer(null);
    if (res?.kind === 'data' && !hasSyntax(text)) setTol(tolOf(res.params.q));
    if (res) setMode(res.kind === 'meta' ? 'meta' : 'data');
    setSp({});
    setTimeout(() => qRef.current?.focus(), 80);
  };

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------
  const openModal = useCallback((m) => {
    if (!document.querySelector('.fm .modal.on')) lastFocus.current = document.activeElement;
    setModal(m);
  }, []);
  const closeModal = useCallback(() => {
    if (modal?.type === 'export' && modal.stage === 'working') return;
    setModal(null);
    setTimeout(() => lastFocus.current?.focus?.(), 0);
  }, [modal]);
  const cardRef = useRef(null);
  const [modalShown, setModalShown] = useState(null);
  const [cellRaw, setCellRaw] = useState(false);
  useEffect(() => {
    if (modal) { setModalShown(modal); return undefined; }
    const id = setTimeout(() => setModalShown(null), 300);
    return () => clearTimeout(id);
  }, [modal]);
  const modalStep = modal ? `${modal.type}|${modal.stage || ''}` : '';
  useEffect(() => {
    if (!modalStep) return undefined;
    const id = setTimeout(() => cardRef.current?.querySelector('[autofocus],[data-autofocus],button')?.focus(), 60);
    return () => clearTimeout(id);
  }, [modalStep]);

  // drawer: catalog entry for a view, or one metadata result
  const drawerCtrl = useRef(null);
  const openViewMeta = (v) => {
    drawerCtrl.current?.abort();
    const ctrl = new AbortController();
    drawerCtrl.current = ctrl;
    if (!drawer) lastFocus.current = document.activeElement;
    setDrawer({ title: v.view, src: v.datasource, loading: true, error: '', item: null, view: v });
    fetchViewMetadata(v.view, v.database, ctrl.signal)
      .then((items) => { if (!ctrl.signal.aborted) setDrawer((d) => d && { ...d, loading: false, item: items[0] ? enrich(items[0], '') : null, empty: !items.length }); })
      .catch((e) => { if (!isAbort(e)) setDrawer((d) => d && { ...d, loading: false, error: friendly(e, 'Could not load the metadata') }); });
  };
  const openMetaItem = (m) => {
    drawerCtrl.current?.abort();
    if (!drawer) lastFocus.current = document.activeElement;
    setDrawer({ title: m.name, sub: humanize(m.name), src: m._x.src, loading: false, error: '', item: m, term: res?.term || '' });
  };
  const closeDrawer = useCallback(() => {
    drawerCtrl.current?.abort();
    setDrawer(null);
    setTimeout(() => lastFocus.current?.focus?.(), 0);
  }, []);
  const [drawerShown, setDrawerShown] = useState(null);
  useEffect(() => {
    if (drawer) { setDrawerShown(drawer); return undefined; }
    const id = setTimeout(() => setDrawerShown(null), 500);
    return () => clearTimeout(id);
  }, [drawer]);
  const drCloseRef = useRef(null);
  const drawerOpen = !!drawer;
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const id = setTimeout(() => drCloseRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [drawerOpen]);

  // export
  const exportViews = isData ? railNames : [];
  const startExport = () => {
    if (!res) return;
    if (res.kind === 'meta') {
      try {
        const name = exportMetadataCsv(res.items);
        showToast(`${name} downloaded`);
      } catch (e) {
        showToast(friendly(e, 'Could not build the CSV'));
      }
      return;
    }
    openModal({ type: 'export', stage: 'choose' });
  };
  const runExport = async (kind) => {
    const count = exportViews.length;
    const ctrl = new AbortController();
    exportCtrl.current = ctrl;
    setModal({ type: 'export', stage: 'working', kind, count });
    try {
      const resp = await apiFetch('/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: XLSX_MIME },
        body: JSON.stringify({
          search_text: res.params.q,
          datasources: res.params.src,
          views: exportViews,
          include_metadata: kind === 'meta',
          all_rows: kind === 'all',
          ...(res.params.db.length ? { database_ids: res.params.db } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(await readError(resp));
      const blob = await resp.blob();
      const name = `fuzzy_search_${today()}.xlsx`;
      saveBlob(blob, name);
      if (!ctrl.signal.aborted) setModal({ type: 'export', stage: 'done', name });
    } catch (e) {
      if (isAbort(e)) return;
      setModal({ type: 'export', stage: 'error', kind, count, error: friendly(e, 'The export failed') });
    } finally {
      if (exportCtrl.current === ctrl) exportCtrl.current = null;
    }
  };
  const cancelExport = () => {
    exportCtrl.current?.abort();
    exportCtrl.current = null;
    setModal(null);
    showToast('Export cancelled');
  };
  useEffect(() => () => { exportCtrl.current?.abort(); drawerCtrl.current?.abort(); clearTimeout(toastTimer.current); }, []);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName || '';
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || document.activeElement?.isContentEditable;
      if (e.key === 'Escape') {
        if (ddOpen) { setDdOpen(null); return; }
        if (modal) { closeModal(); return; }
        if (drawer) { closeDrawer(); return; }
        if (mapPin) { setMapPin(null); setMapHover(null); }
        return;
      }
      if (modal || drawer) return;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        (onHome ? qRef.current : miniRef.current)?.focus();
        return;
      }
      if (typing || onHome || !isData || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
        const i = railOrder.indexOf(selected);
        const next = railOrder[i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)];
        if (next) {
          e.preventDefault();
          selectView(next);
          requestAnimationFrame(() => railRef.current?.querySelector(`.item[data-n="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }));
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ddOpen, modal, drawer, mapPin, closeModal, closeDrawer, onHome, isData, railOrder, selected, selectView]);

  // ---------------------------------------------------------------------------
  // Render pieces
  // ---------------------------------------------------------------------------
  const renderEmpty = () => {
    const q = parseQuery(res.params.q);
    const meta = res.kind === 'meta';
    const fixes = [];
    if (!meta) {
      const cur = TOL[tolOf(res.params.q)].level;
      if (cur < 1) fixes.push(['ends', 'Include longer words']);
      if (cur < 2) fixes.push(['close', 'Allow 1 typo']);
      if (cur < 3) fixes.push(['loose', 'Allow 2 typos']);
    }
    if (res.params.src.length) fixes.push(['all', 'Search all sources']);
    if (!meta && canMetadata) fixes.push(['meta', 'Search metadata instead']);
    if (meta && canData) fixes.push(['data', 'Search records instead']);
    const runFix = (f) => {
      const next = { ...res.params };
      if (TOL[f]) { next.q = buildQuery(q.term, f); setTol(f); }
      if (f === 'all') next.src = [];
      if (f === 'meta') { next.m = 'meta'; next.q = q.term; next.db = []; }
      if (f === 'data') { next.m = 'data'; next.q = buildQuery(q.term, tol); }
      go(next);
    };
    return (
      <div className="empty">
        <div className="eart" aria-hidden="true">
          <span className="tk" style={{ left: 6, top: 14 }}>{q.term.slice(0, 10)}</span>
          <span className="tk" style={{ right: 0, top: 0, animationDelay: '.6s' }}>?</span>
          <span className="tk" style={{ left: 46, bottom: 6, animationDelay: '1.2s' }}>~</span>
        </div>
        <h3>No {meta ? 'metadata' : 'matches'} for &ldquo;{q.term}&rdquo;</h3>
        <p>{meta
          ? `Nothing in the catalog${res.params.src.length ? ` for ${srcLabel(res.params.src)}` : ''} names or describes this.`
          : `Nothing in ${res.params.src.length ? res.params.src.map((i) => srcById[i].label).join(', ') : 'any source'} matched. ${describe(q)}`}</p>
        <div className="fix">
          {fixes.map(([k, l], i) => <button key={k} type="button" className={`btn ${i ? 'btn-line' : 'btn-dark'}`} onClick={() => runFix(k)} disabled={!!busy}>{l}</button>)}
        </div>
      </div>
    );
  };

  const renderSheet = () => {
    if (!view) {
      return (
        <div className="empty">
          <h3>No views to show</h3>
          <p>{railQ || srcFilter.length ? 'Nothing matches the filter.' : 'Pick a view on the left to see its records.'}</p>
          {(railQ || srcFilter.length > 0) && <div className="fix"><button type="button" className="btn btn-dark" onClick={() => { setRailQ(''); setSrcFilter([]); }}>Clear filters</button></div>}
        </div>
      );
    }
    const s = srcById[view.datasource] || OTHER;
    const cap10k = Math.min(shown.count ?? view.record_count, HITS_CAP);
    const remaining = cap10k - shown.records.length;
    const canMore = !!(view.database && view.view) && remaining > 0;
    const valueCap = view.value_cap || res.stats.valueCap;
    const maxHits = Math.max(1, ...Object.values(hitCount));
    const orderedCols = [...columns].sort((a, b) => hitCount[b] - hitCount[a]);
    const more = canMore && (
      <div className="more">
        <span>{fmt(remaining)} more matching rows in Denodo</span>
        <button type="button" className="btn btn-line" disabled={viewSt.moreBusy} onClick={() => loadMore(selected)}>
          {viewSt.moreBusy ? <span className="ibar" style={{ width: 80, display: 'inline-block' }} /> : <><Ico d="down" />Load {fmt(Math.min(MORE_PAGE, remaining))} more</>}
        </button>
        {viewSt.moreErr && <span className="err" role="alert">{viewSt.moreErr}</span>}
      </div>
    );
    return (
      <article className="sheet" key={selected} style={{ '--c': s.color }}>
        <div className="sh-head">
          <div className="title-row">
            <div style={{ minWidth: 0 }}>
              <div className="crumbs">
                <span className="badge" style={{ '--c': s.color }}><i />{s.label}</span>
                {view.database && <span className="db"><Ico d="db" />{view.database}</span>}
                <span className="vfacts"><b>{countLabel(view)}</b> match{view.record_count !== 1 ? 'es' : ''}, showing <b>{fmt(shown.records.length)}</b></span>
              </div>
              <h2 className="vname" title={view.view}><Wbr name={showName(view.view || selected)} /></h2>
            </div>
            <div className="acts">
              <button type="button" className="btn btn-line" onClick={() => copy(view.view || selected, 'View name copied')}><Ico d="copy" />Copy name</button>
              {canMetadata && <button type="button" className="btn btn-line" onClick={() => openViewMeta(view)}><Ico d="info" />Metadata</button>}
            </div>
          </div>
          <div className="tabs" role="tablist" ref={tabsRef}>
            <button type="button" role="tab" aria-selected={tab === 'rows'} onClick={() => setTab('rows')}><Ico d="table" />Records<span className="n">{fmt(shown.records.length)}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'cols'} onClick={() => setTab('cols')}><Ico d="layers" />Where it matched</button>
            <span className="ink" />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {tab === 'cols' ? (
            <div className="tab-body">
              <div className={`colhits ${colGrown ? 'grown' : ''}`}>
                {orderedCols.map((c, i) => (
                  <button type="button" key={c} className="ch" onClick={() => flashColumn(c)} title={`Show ${c} in the records`}>
                    <span className="cn">{showName(c)}</span>
                    <span className="tr"><b style={{ '--w': hitCount[c] / maxHits, transitionDelay: `${i * 50}ms` }} /></span>
                    <span className="cv">{hitCount[c] ? `${fmt(hitCount[c])} of ${fmt(shown.records.length)} rows` : 'No matches'}</span>
                  </button>
                ))}
                {!orderedCols.length && <p style={{ padding: 20, textAlign: 'center', color: 'var(--g6)' }}>This view sent back no columns.</p>}
              </div>
            </div>
          ) : (
            <RecordsTable
              columns={columns}
              records={shown.records}
              hits={shown.hits}
              matcher={matcher}
              valueCap={valueCap}
              st={viewSt}
              onChange={(patch) => patchTable(selected, patch)}
              flashCol={flash?.c || null}
              hitCount={hitCount}
              onOpen={(i) => openModal({ type: 'record', view: view.view || selected, database: view.database, link: shown.links?.[i], query: res.params.q })}
              onCell={(i, c, t) => openModal({ type: 'cell', col: c, val: t, row: i + 1, valueCap, view: view.view || selected, database: view.database, link: shown.links?.[i], query: res.params.q })}
              more={more}
            />
          )}
        </div>
      </article>
    );
  };

  const renderMetaSummary = () => {
    const items = metaItems;
    const n = items.length;
    const by = (f) => items.filter(f).length;
    const str = STRENGTH.map((x) => ({ ...x, n: by((m) => strengthOf(m._x.score) === x) }));
    const found = [['Name', by((m) => m._x.inName)], ['Description', by((m) => m._x.inDesc)], ['Field names', by((m) => m._x.nFields > 0)]];
    const counts = {};
    items.forEach((m) => { counts[m._x.src] = (counts[m._x.src] || 0) + 1; });
    const present = ALL_SOURCES.filter((x) => counts[x.id]);
    return (
      <section className={`summary msum ${metaGrown ? 'grown' : ''}`} key={`sum-${res.key}`}>
        <div className="stat big" style={{ animation: 'fm-rise .55s var(--out) both' }}>
          <div className="n"><CountUp to={n} ms={tier === 'min' ? 1 : 900} /></div>
          <div className="l">catalog assets match <b>&ldquo;{res.term}&rdquo;</b>{res.cached && <span className="cached">cached</span>}</div>
        </div>
        <div className="dist" style={{ animation: 'fm-rise .55s 60ms var(--out) both' }}>
          <div className="dist-top"><span>Match strength, click to filter</span></div>
          <div className={`sbar ${metaGrown ? 'grown' : ''} ${mf.strength.length ? 'filtered' : ''}`}>
            {str.filter((x) => x.n).map((x, i) => (
              <button key={x.id} type="button" className={mf.strength.includes(x.id) ? 'on' : undefined} style={{ '--c': x.color, flex: x.n, transitionDelay: `${i * 80}ms` }}
                title={`${x.label}: ${x.n}`} aria-label={`${x.label}: ${x.n}`} aria-pressed={mf.strength.includes(x.id)} onClick={() => toggleStrength(x.id)} />
            ))}
          </div>
          <div className={`legend ${mf.strength.length ? 'filtered' : ''}`}>
            {str.map((x) => (
              <button key={x.id} type="button" className={mf.strength.includes(x.id) ? 'on' : undefined} style={{ '--c': x.color }} disabled={!x.n} onClick={() => toggleStrength(x.id)}><i />{x.label} <b>{x.n}</b></button>
            ))}
          </div>
        </div>
        <div className="dist" style={{ animation: 'fm-rise .55s 120ms var(--out) both' }}>
          <div className="dist-top"><span>Where &ldquo;{res.term}&rdquo; was found</span></div>
          <div className="found">
            {found.map(([l, c], i) => <div className="fr" key={l}><span>{l}</span><span className="tr"><b style={{ '--w': n ? c / n : 0, transitionDelay: `${i * 90}ms` }} /></span><b>{c}</b></div>)}
          </div>
        </div>
        <div className="dist" style={{ animation: 'fm-rise .55s 180ms var(--out) both' }}>
          <div className="dist-top"><span>Assets by source, click to filter</span>{srcFilter.length > 0 && <button type="button" onClick={() => { setSrcFilter([]); softMeta(); }}>Show all</button>}</div>
          <div className={`sbar ${metaGrown ? 'grown' : ''} ${srcFilter.length ? 'filtered' : ''}`}>
            {present.map((x, i) => (
              <button key={x.id} type="button" className={srcFilter.includes(x.id) ? 'on' : undefined} style={{ '--c': x.color, flex: counts[x.id], transitionDelay: `${i * 70}ms` }}
                title={`${x.label}: ${counts[x.id]}`} aria-label={`${x.label}: ${counts[x.id]}`} aria-pressed={srcFilter.includes(x.id)} onClick={() => toggleSrcFilter(x.id)} />
            ))}
          </div>
          <div className={`legend ${srcFilter.length ? 'filtered' : ''}`}>
            {present.map((x) => <button key={x.id} type="button" className={srcFilter.includes(x.id) ? 'on' : undefined} style={{ '--c': x.color }} onClick={() => toggleSrcFilter(x.id)}><i />{x.label} <b>{counts[x.id]}</b></button>)}
          </div>
        </div>
      </section>
    );
  };

  const renderMeta = () => {
    const segs = (k, opts) => (
      <div className="segs" role="group">
        {opts.map(([v, l]) => <button key={v} type="button" aria-pressed={mf[k] === v} onClick={() => patchMf({ [k]: v })}>{l}</button>)}
      </div>
    );
    const all = metaItems.length;
    let k = 0;
    return (
      <>
        <div className="mtools">
          <label className="filter"><Ico d="search" /><input value={mf.q} onChange={(e) => patchMf({ q: e.target.value }, false)} placeholder="Filter assets, tags or categories" aria-label="Filter metadata" /></label>
          <span className="tl">Group</span>{segs('group', [['strength', 'Strength'], ['source', 'Source'], ['db', 'Database'], ['none', 'None']])}
          <span className="tl">Sort</span>{segs('sort', [['score', 'Best match'], ['name', 'A to Z'], ['changed', 'Recently changed']])}
          <span className="spacer" />
          <span className="mcount">{metaList.length === all ? `${plural(all, 'asset')}` : `${metaList.length} of ${plural(all, 'asset')}`}</span>
          {segs('layout', [['cards', <><Ico d="grid" />Cards</>], ['map', <><Ico d="map" />Relationship map</>]])}
        </div>
        <div className={`mwrap ${metaMode}`}>
          {!metaList.length ? (
            <div className="empty">
              <h3>No assets match these filters</h3><p>Clear them to see every asset again.</p>
              <div className="fix"><button type="button" className="btn btn-dark" onClick={() => { setMf((f) => newMf(f.layout)); setSrcFilter([]); softMeta(); }}>Clear filters</button></div>
            </div>
          ) : mf.layout === 'map' ? (
            <MetaMap list={metaList} items={metaItems} term={res.term} pin={mapPin} setPin={setMapPin} hover={mapHover} setHover={setMapHover} onOpen={openMetaItem} />
          ) : (
            <React.Fragment key={metaSoft}>
              {metaGroups.map((g, gi) => (
                <section className="msec" key={g.key} style={{ animationDelay: `${gi * 60}ms` }}>
                  {g.title && <div className="msec-h" style={{ '--c': g.color }}><i /><b>{g.title}</b><small>{g.note}</small><span className="ln" /><span className="ct">{g.items.length}</span></div>}
                  <div className="mgrid">
                    {g.items.map((m) => <MetaCard key={`${m.id ?? ''}|${m.name}|${m.database_name}`} m={m} idx={metaItems.indexOf(m)} i={k++} term={res.term} grown={metaGrown} onOpen={openMetaItem} />)}
                  </div>
                </section>
              ))}
            </React.Fragment>
          )}
        </div>
      </>
    );
  };

  const renderModal = () => {
    const m = modalShown;
    if (!m) return null;
    if (m.type === 'record') {
      return (
        <RecordBody view={m.view} database={m.database} link={m.link} query={m.query}
          onCopyAll={(t) => { copy(t, 'Record copied'); closeModal(); }} onCopyField={(t) => copy(t, 'Value copied')} />
      );
    }
    if (m.type === 'cell') {
      const cut = !!m.valueCap && m.val.length >= m.valueCap;
      const st = structOf(m.val);
      return (
        <>
          <div className="rc-head">
            <div className="rc-title">
              <span className="rc-ic"><Ico d="text" /></span>
              <div style={{ minWidth: 0 }}>
                <h3>{showName(m.col)}</h3>
                <p title={m.view}>Row {m.row} &middot; <span className="mono">{showName(m.view)}</span></p>
              </div>
            </div>
            <button type="button" className="x" data-close aria-label="Close" autoFocus><Ico d="x" /></button>
          </div>
          <div className="rc-body">
            {st && !cellRaw
              ? <Struct v={st} mt={matcher} />
              : <div className={`cv-val ${st ? 'rc-raw' : ''}`}><Hl text={m.val} mt={matcher} />{cut && <span className="cut"> [...]</span>}</div>}
            {cut && <p className="cv-cut"><Ico d="info" />Denodo cut this at {m.valueCap} characters. Open the full record for the rest.</p>}
          </div>
          <div className="rc-foot">
            <span>{plural(m.val.length, 'character')}</span>
            {st && <RawSwitch raw={cellRaw} setRaw={setCellRaw} />}
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={() => setModal({ type: 'record', view: m.view, database: m.database, link: m.link, query: m.query })}><Ico d="ext" />Full record</button>
            <button type="button" className="btn btn-dark" onClick={() => { copy(m.val, 'Value copied'); closeModal(); }}><Ico d="copy" />Copy value</button>
          </div>
        </>
      );
    }
    if (m.type === 'export') {
      const count = exportViews.length;
      if (m.stage === 'choose') {
        const opt = (k, ic, title, sub, tag, tint) => (
          <button type="button" className="opt" onClick={() => runExport(k)}>
            <span className="ic" style={tint}><Ico d={ic} /></span>
            <span><b>{title}</b><small>{sub}</small></span>
            <span className="t">{tag}</span>
          </button>
        );
        return (
          <>
            <h3>Export to Excel</h3>
            <p className="sub">Exports the {plural(count, 'view')} shown{srcFilter.length || railQ ? ' with your filter' : ''}. The summary sheet always has the real hit counts.</p>
            {opt('data', 'table', 'Records only', `Up to ${res?.stats?.perView || ROWS_PER_VIEW} rows per view, plus a summary sheet`, 'Fast')}
            {opt('all', 'down', 'All matching rows', 'Up to 5,000 rows per view, read one view at a time', 'Slower', { background: 'var(--blue-wash)', color: 'var(--blue)' })}
            {canMetadata && opt('meta', 'layers', 'Records and metadata', 'Adds a sheet with each view’s catalog entry', 'Fast', { background: 'var(--green-wash)', color: 'var(--green)' })}
            <div className="acts-row"><button type="button" className="btn btn-ghost" data-close>Cancel</button></div>
          </>
        );
      }
      if (m.stage === 'working') {
        const msg = m.kind === 'all' ? 'Reading every matching row from Denodo, view by view. This can take a few minutes.'
          : m.kind === 'meta' ? 'Building the workbook and looking up each view in the catalog.' : 'Building the workbook.';
        return (
          <>
            <h3>Exporting {plural(m.count, 'view')}</h3>
            <p className="sub">{msg}</p>
            <div className="ibar" style={{ margin: '6px 0 16px' }} />
            <div className="acts-row"><button type="button" className="btn btn-ghost" onClick={cancelExport}>Cancel export</button></div>
          </>
        );
      }
      if (m.stage === 'error') {
        return (
          <>
            <h3>Export failed</h3>
            <div className="rec-err" role="alert">{m.error}</div>
            <div className="acts-row">
              <button type="button" className="btn btn-ghost" data-close>Close</button>
              <button type="button" className="btn btn-dark" autoFocus onClick={() => runExport(m.kind)}><Ico d="redo" />Try again</button>
            </div>
          </>
        );
      }
      return (
        <>
          <div className="done"><svg viewBox="0 0 72 72" width="84" height="84" aria-hidden="true"><circle cx="36" cy="36" r="30" /><path d="m24 37 8 8 16-18" /></svg></div>
          <h3 style={{ textAlign: 'center' }}>Exported</h3>
          <p className="sub" style={{ textAlign: 'center' }}>{m.name} is in your downloads.</p>
          <div style={{ textAlign: 'center' }}><button type="button" className="btn btn-dark" data-close autoFocus>Done</button></div>
        </>
      );
    }
    return null;
  };

  const d = drawerShown;
  const noRail = !isData || !allNames.length;
  const allOn = !sources.length;
  const related = d?.item && d.term && resMeta ? metaItems.filter((o) => o !== d.item && o.database_name === d.item.database_name).slice(0, 4) : null;

  return (
    <div className={`fm ${paused ? 'paused' : ''}`} data-tier={tier} ref={fmRef}>
      <div className="bg" aria-hidden="true" />
      <div className={`fx ${onHome ? '' : 'dim'}`} aria-hidden="true">
        <div className="aurora" ref={auroraRef}><i /><i /><i /></div>
        <div className="spot" ref={spotRef} />
        <div className="floor"><i /></div>
        <canvas id="field" ref={fieldRef} />
      </div>

      <div className="app">
        {/* HOME */}
        <section className="view" id="home" ref={homeRef} aria-label="Fuzzy Search" aria-hidden={!onHome} onPointerMove={onHomeMove} onPointerLeave={onHomeLeave}>
          <Dust />
          <header className="top">
            <div className="brand">
              <img className="logo" src={LOGO} alt="GRA SmartHub" draggable="false" />
              <span className="rule" />
              <div className="brand-txt"><b>Data Discovery</b><small>Global Regulatory Affairs</small></div>
            </div>
            <div className="hright">
              <div className="hstat"><b><CountUp to={dbInfo.list.filter((x) => x.indexed === true).length} ms={tier === 'min' ? 1 : 1800} /></b>databases indexed</div><span className="hsep" />
              <div className="hstat"><b><CountUp to={SOURCES.length} ms={tier === 'min' ? 1 : 1800} /></b>source systems</div>
              {dbInfo.status === 'error' ? (
                <button type="button" className={live.cls} title={`${live.title}. Click to retry.`} onClick={() => setDbNonce((n) => n + 1)}><i /><span>{live.text}</span></button>
              ) : (
                <div className={live.cls} role="status" title={live.title}><i /><span>{live.text}</span></div>
              )}
            </div>
          </header>

          <div className="hero">
            <div className="left">
              <div className="eyebrow"><span className="tl"><span>~</span></span>Fuzzy Search <em>/</em> Content and metadata</div>
              <Headline />
              <p className="lede">One search across <span className="sn" style={{ '--c': '#0f68b2' }}>GRAIL</span> <span className="sn" style={{ '--c': '#8c3bbb' }}>Insight</span> <span className="sn" style={{ '--c': '#328714' }}>LIFT</span> <span className="sn" style={{ '--c': '#ff6017' }}>RIMDocs</span> and <span className="sn" style={{ '--c': '#3fb6e8' }}>URP</span>. Typos, plurals and IDs are all forgiven, and you choose how forgiving.</p>

              <form className="cmd" ref={cmdRef} autoComplete="off" onPointerMove={onCmdMove} onPointerLeave={onCmdLeave}
                onSubmit={(e) => { e.preventDefault(); closeSug(); if (homeBusy) stopSearch(); else startSearch(); }}>
                <div className="cmd-body">
                  <Ico d="search" className="ico lens" />
                  <div className="q-wrap">
                    <label className="sr" htmlFor="fm-q">Search term</label>
                    <input className="q" id="fm-q" ref={qRef} placeholder=" " spellCheck="false" maxLength={MAX_TERM} enterKeyHint="search" autoCapitalize="off"
                      role="combobox" aria-autocomplete="list" aria-controls="fm-sug" aria-expanded={sug.open} aria-activedescendant={sug.open ? `fm-sg-${sug.i}` : undefined}
                      value={text} disabled={!modes.length}
                      onChange={(e) => { const v = e.target.value; setText(v); if (homeErr) setHomeErr(''); flyLetter(e.target, e.nativeEvent?.data); refreshSug(v); }}
                      onFocus={(e) => refreshSug(e.target.value)}
                      onBlur={() => setTimeout(() => { if (document.activeElement !== qRef.current) closeSug(); }, 120)}
                      onKeyDown={onQKey} />
                    {!text && <Ghost />}
                    <span className="ahead" aria-hidden="true">{sug.completion && <>{text}<b>{sug.completion}</b><kbd>Tab</kbd></>}</span>
                  </div>
                  <button type="button" className="clear" aria-label="Clear search" hidden={!text} onClick={() => { setText(''); closeSug(); qRef.current?.focus(); }}><Ico d="x" /></button>
                  <div className="seg" ref={segRef} role="group" aria-label="What to search">
                    <span className="pill" />
                    {canData && <button type="button" aria-pressed={effMode === 'data'} onClick={() => { if (busy) return; setMode('data'); qRef.current?.focus(); requestAnimationFrame(() => refreshSug(qRef.current?.value || '')); }}>Content</button>}
                    {canMetadata && <button type="button" aria-pressed={effMode === 'meta'} onClick={() => { if (busy) return; setMode('meta'); closeSug(); qRef.current?.focus(); }}>Metadata</button>}
                  </div>
                  <button ref={goRef} className={`go ${homeBusy ? 'stopping' : ''} ${canSearch && !busy ? 'ready' : ''}`} type="submit"
                    disabled={!homeBusy && (!canSearch || !!busy)} aria-label={homeBusy ? 'Stop search' : 'Search'}>
                    <span className="run"><span>Search</span><kbd><Ico d="enter" /></kbd></span>
                    <span className="stop"><svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" /></svg>Stop</span>
                  </button>
                </div>
                <div className={`sug ${sug.open ? 'on' : ''}`} id="fm-sug" role="listbox" aria-label="Suggestions" onPointerDown={(e) => e.preventDefault()}>
                  {sug.open && (
                    <>
                      <div className="sg-h">Did you mean<span>{plural(sug.list.length, 'close spelling')}</span></div>
                      <button type="button" className="sg" id="fm-sg--1" role="option" aria-selected={sug.i === -1} onPointerMove={() => sug.i !== -1 && setSug((s) => ({ ...s, i: -1 }))} onClick={() => pickSug(-1)}>
                        <span className="sd"><Ico d="search" /></span>
                        <span className="t">{parseQuery(text).term}<small>as typed, {TOL[hasSyntax(text) ? tolOf(text) : tol].label.toLowerCase()}</small></span>
                        <span className="k">Enter</span><span className="m" />
                      </button>
                      {sug.list.map((s, i) => (
                        <button type="button" key={s.term} className="sg" id={`fm-sg-${i}`} role="option" aria-selected={i === sug.i}
                          style={{ '--c': s.from === 'recent' ? 'var(--blue)' : 'var(--g5)', animationDelay: `${(i + 1) * 30}ms` }}
                          onPointerMove={() => sug.i !== i && setSug((x) => ({ ...x, i }))} onClick={() => pickSug(i)}>
                          <span className="sd"><i /></span>
                          <span className="t">{sugTerm(s)}<small>{s.from === 'recent' ? 'from your recent searches' : 'common term'}</small></span>
                          <span className={`k ${s.kind}`}>{KIND[s.kind]}</span>
                          <span className="m"><span><b style={{ width: `${s.score}%` }} /></span>{s.score}%</span>
                        </button>
                      ))}
                      <div className="sg-f"><span><kbd>↑</kbd><kbd>↓</kbd>pick</span><span><kbd>↵</kbd>search</span><span><kbd>Tab</kbd>complete</span><span><kbd>Esc</kbd>close</span></div>
                    </>
                  )}
                </div>
              </form>

              <div className="scope">
                <div className="sc-row">
                  <div className="sc-h"><span className="cap">Search in</span><span className="sc-sum">{allOn ? `All ${SOURCES.length} sources` : `${sources.length} of ${SOURCES.length} sources`}</span></div>
                  <div className={`stiles ${allOn ? 'all-on' : ''}`} role="group" aria-label="Sources">
                    <button type="button" className="st st-all" aria-pressed={allOn} onClick={() => toggleSource('all')}>
                      <span className="st-dots">{SOURCES.map((s) => <i key={s.id} style={{ '--c': s.color }} />)}</span><b>All</b><small>{SOURCES.length} source systems</small>
                      <span className="st-ck"><Ico d="check" /></span>
                    </button>
                    {SOURCES.map((s) => (
                      <button key={s.id} type="button" className="st" style={{ '--c': s.color }} aria-pressed={sources.includes(s.id)} onClick={() => toggleSource(s.id)}>
                        <i /><b>{s.label}</b><small>{s.id}_* views</small><span className="st-ck"><Ico d="check" /></span>
                      </button>
                    ))}
                  </div>
                </div>
                {effMode === 'data' && pickDbsFor('data') && (
                  <div className="sc-row sc-db">
                    <div className="sc-h"><span className="cap">Databases</span>
                      <span className="sc-sum">{!dbListOf('data').length ? '' : dbs.length ? `${dbs.length} of ${dbListOf('data').length} picked` : 'Pick at least one'}</span>
                    </div>
                    <DbPicker list={dbListOf('data')} value={dbs} onChange={setDbs} indexState={dbInfo.indexState}
                      status={dbInfo.status === 'error' ? 'Could not load the database list' : dbInfo.status === 'loading' || dbInfo.loading ? 'Loading databases from Denodo…' : 'No databases available'} />
                  </div>
                )}
              </div>
              <div>
                {!modes.length && <div className="err" role="alert"><Ico d="info" /><span>You don&rsquo;t have access to record or metadata search. Ask an admin for access.</span></div>}
                {homeErr && !homeBusy && (
                  <div className="err" role="alert"><Ico d="info" /><span>{homeErr}</span>
                    {params.q && <button type="button" style={{ marginLeft: 'auto', fontWeight: 600, textDecoration: 'underline' }} onClick={() => setRetry((n) => n + 1)}>Try again</button>}
                  </div>
                )}
              </div>
              <div className="quick">
                <div className="qrow"><span className="lbl">Try</span>{TRY.map((t) => <button key={t} type="button" className="qc" onClick={() => { setText(t); qRef.current?.focus(); }}>{t}</button>)}</div>
                {recent.length > 0 && (
                  <div className="qrow"><span className="lbl">Recent</span>
                    {recent.map((t) => <button key={t} type="button" className="qc rc" title={t} disabled={!!busy || !modes.length} onClick={() => { setText(t); startSearch(t); }}>{t}</button>)}
                    <button type="button" className="qc clr" onClick={() => setRecent([])}>Clear</button>
                  </div>
                )}
              </div>
            </div>

            <div className="lab">
              <span className="glare" aria-hidden="true" />
              <TuneFace text={text} tol={tol} onTol={setLabTol} hidden={face !== 'tune'} measureRef={labMeasureRef} />
              <MetaFace text={text} hidden={face !== 'meta'} />
              <ScanFace busy={homeBusy ? busy : null} secs={secs} title={scanTitle} sub={scanSub} hidden={face !== 'scan'} />
            </div>
          </div>
          <Ticker />
        </section>

        {/* RESULTS */}
        <section className="view" id="results" ref={resultsRef} aria-label="Results" aria-hidden={onHome}>
          {res && (
            <>
              <header className="rtop">
                {!noRail && <button type="button" className="btn btn-ghost" title={collapsed ? 'Show the view list' : 'Hide the view list'} aria-label="Toggle view list" aria-pressed={!collapsed} onClick={() => setCollapsed((c) => !c)}><Ico d="panel" /></button>}
                <div className="brand"><img className="logo" src={LOGO} alt="GRA SmartHub" draggable="false" /></div>
                <form className="mini" ref={miniFormRef} autoComplete="off" onSubmit={submitMini}>
                  <Ico d="search" style={{ color: 'var(--g5)' }} />
                  <input ref={miniRef} value={miniText} spellCheck="false" aria-label="Search term" maxLength={MAX_TERM} onChange={(e) => setMiniText(e.target.value)} />
                  {!resMeta && (
                    <div className="dd" id="tolDD">
                      <button type="button" className="dd-btn" id="tolBtn" aria-haspopup="true" aria-expanded={ddOpen === 'tol'} aria-controls="tolMenu" disabled={miniTilde}
                        title={miniTilde ? 'Set by the ~ or * you typed' : 'How close a match'} onClick={() => setDdOpen((o) => (o === 'tol' ? null : 'tol'))}>
                        <span>{TOL[miniActiveTol].label}</span><Ico d="chev" className="ico chev" />
                      </button>
                      <div className={`dd-menu ${ddOpen === 'tol' ? 'on' : ''}`} id="tolMenu" role="radiogroup" aria-label="How close a match" onKeyDown={menuKeys}>
                        {TOL_KEYS.map((k) => (
                          <button key={k} type="button" className="dd-item" role="menuitemradio" aria-checked={k === miniActiveTol} tabIndex={ddOpen === 'tol' ? 0 : -1}
                            onClick={() => { setMiniTol(k); setDdOpen(null); document.getElementById('tolBtn')?.focus(); }}>
                            <span className="bx"><Ico d="check" /></span><span>{TOL[k].label}<small>{TOL[k].sub}</small></span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="dd" id="srcDD">
                    <button type="button" className="dd-btn" id="srcBtn" aria-haspopup="true" aria-expanded={ddOpen === 'src'} aria-controls="srcMenu"
                      title={miniSources.length ? miniSources.map((id) => srcById[id].label).join(', ') : 'All sources'} onClick={() => setDdOpen((o) => (o === 'src' ? null : 'src'))}>
                      <span className="dd-dots">{miniSources.slice(0, 4).map((id) => <i key={id} style={{ '--c': srcById[id].color }} />)}</span>
                      <span>{srcLabel(miniSources)}</span><Ico d="chev" className="ico chev" />
                    </button>
                    <div className={`dd-menu ${ddOpen === 'src' ? 'on' : ''}`} id="srcMenu" role="group" aria-label="Sources" onKeyDown={menuKeys}>
                      <button type="button" className="dd-item" role="menuitemcheckbox" aria-checked={!miniSources.length} tabIndex={ddOpen === 'src' ? 0 : -1} onClick={() => toggleMiniSource('all')}>
                        <span className="bx"><Ico d="check" /></span>All sources
                      </button>
                      <div className="dd-sep" />
                      {SOURCES.map((s) => (
                        <button key={s.id} type="button" className="dd-item" role="menuitemcheckbox" style={{ '--c': s.color }} aria-checked={miniSources.includes(s.id)} tabIndex={ddOpen === 'src' ? 0 : -1} onClick={() => toggleMiniSource(s.id)}>
                          <span className="bx"><Ico d="check" /></span><span className="sw" />{s.label}
                        </button>
                      ))}
                      <div className="dd-foot"><span>{sameSources ? 'Current search' : 'Press Search to apply'}</span></div>
                    </div>
                  </div>
                  {pickDbsFor(resDbKind) && (
                    <div className="dd" id="dbDD">
                      <button type="button" className="dd-btn" id="dbBtn" aria-haspopup="true" aria-expanded={ddOpen === 'db'} aria-controls="dbMenu"
                        title={miniDbsN.map(dbName).join(', ')} onClick={() => setDdOpen((o) => (o === 'db' ? null : 'db'))}>
                        <Ico d="db" /><span>{dbLabel(miniDbs, resDbKind)}</span><Ico d="chev" className="ico chev" />
                      </button>
                      <div className={`dd-menu ${ddOpen === 'db' ? 'on' : ''}`} id="dbMenu" role="group" aria-label="Databases" onKeyDown={menuKeys}>
                        <div className="dd-find">
                          <Ico d="search" />
                          <input ref={dbQRef} value={dbQ} onChange={(e) => setDbQ(e.target.value)} placeholder={`Find a database (${dbListOf(resDbKind).length})`}
                            aria-label="Find a database" tabIndex={ddOpen === 'db' ? 0 : -1} />
                          {dbQ && <button type="button" onClick={() => { setDbQ(''); dbQRef.current?.focus(); }} aria-label="Clear filter" tabIndex={-1}><Ico d="x" /></button>}
                        </div>
                        {dbQ.trim() ? (
                          <button type="button" className="dd-item" role="menuitem" disabled={!menuDbs.length} tabIndex={ddOpen === 'db' ? 0 : -1}
                            onClick={() => setMiniDbs([...new Set([...miniDbsN, ...menuDbs.map((x) => x.id)])])}>
                            <span className="bx"><Ico d="plus" /></span>Select {menuDbs.length} shown
                          </button>
                        ) : (
                          <button type="button" className="dd-item" role="menuitemcheckbox" aria-checked={miniDbsN.length > 0 && miniDbsN.length === dbListOf(resDbKind).length} tabIndex={ddOpen === 'db' ? 0 : -1}
                            onClick={() => setMiniDbs(nextDbs(miniDbsN, 'all', resDbKind))}>
                            <span className="bx"><Ico d="check" /></span>All databases
                          </button>
                        )}
                        <div className="dd-sep" />
                        {!menuDbs.length && <div className="dd-none">No database matches &ldquo;{dbQ}&rdquo;</div>}
                        {menuDbs.map((x) => (
                          <button key={x.id} type="button" className="dd-item" role="menuitemcheckbox" title={`${x.name} (id ${x.id})${x.indexed === false ? ', not indexed' : ''}`}
                            aria-checked={miniDbsN.includes(x.id)} tabIndex={ddOpen === 'db' ? 0 : -1}
                            onClick={() => setMiniDbs(nextDbs(miniDbsN, x.id, resDbKind))}>
                            <span className="bx"><Ico d="check" /></span><span className="dd-nm">{hl(x.name, dbQ.trim())}</span>{x.indexed === false && <span className="dd-raw">not indexed</span>}
                          </button>
                        ))}
                        <div className="dd-foot"><span>{sameDbs ? 'Current search' : 'Press Search to apply'}</span></div>
                      </div>
                    </div>
                  )}
                  <button type="submit" className={`mini-go ${resultsBusy ? 'stopping' : ''} ${!resultsBusy && miniCanGo && !busy ? 'dirty' : ''}`}
                    disabled={!resultsBusy && (!miniCanGo || !!busy)}
                    title={resultsBusy ? 'Stop search' : miniCanGo ? 'Search' : 'Change the term, typo tolerance or sources to search again'}>
                    {resultsBusy ? 'Stop' : 'Search'}
                  </button>
                </form>
                <div className="spacer" />
                {summary && (
                  <div className="rstats" key={`st-${res.key}`}>
                    <span><b><CountUp to={summary.stats[0].n} plus={summary.stats[0].plus} ms={tier === 'min' ? 1 : 900} /></b>records</span>
                    <span><b>{fmt(summary.stats[1].n)}</b>views</span>
                    <span><b>{summary.stats[3].raw}</b>
                      {summary.stats[3].cached && (
                        <button type="button" className="rcache" onClick={refreshFromSource} disabled={!!busy} title="Answered from the 30 minute cache. Click to refresh from source."><Ico d="redo" />cached</button>
                      )}
                    </span>
                    {res.stats.notes.length > 0 && <span className="rnote" title={res.stats.notes.join('\n')} aria-label={res.stats.notes.join(' ')}><Ico d="info" /></span>}
                  </div>
                )}
                <button type="button" className="btn btn-ghost" onClick={newSearch}><Ico d="back" /><span className="lbl">New search</span></button>
                <button type="button" className="btn btn-dark" disabled={resMeta ? !res.items.length : !allNames.length || !exportViews.length || !canData}
                  title={resMeta ? 'Download the metadata as CSV' : 'Download an Excel workbook'} onClick={startExport}>
                  <Ico d="down" /><span className="lbl">{resMeta ? 'Export to CSV' : 'Export to Excel'}</span>
                </button>
                <span className={`loadbar ${resultsBusy ? 'run' : ''}`} />
              </header>

              <div className="rwrap">
                {resMeta && metaItems.length > 0 && renderMetaSummary()}

                {isData && !summary && res.stats.notes.length > 0 && (
                  <div className="notes">{res.stats.notes.map((n) => <div key={n}><Ico d="info" /><span>{n}</span></div>)}</div>
                )}

                <div className={`body ${noRail ? 'one' : ''} ${collapsed ? 'collapsed' : ''}`} ref={bodyRef} style={{ '--rail-w': `${railW}px` }}>
                  {!noRail && (
                    <aside className="rail" aria-label="Views">
                      <div className="rail-head">
                        <div className="row1">
                          <h2>Views<span>{railNames.length}</span></h2>
                          <div className="sort" role="group" aria-label="Sort views">
                            <button type="button" aria-pressed={railSort === 'hits'} onClick={() => setRailSort('hits')}>Most hits</button>
                            <button type="button" aria-pressed={railSort === 'name'} onClick={() => setRailSort('name')}>A to Z</button>
                          </div>
                        </div>
                        {summary && (
                          <div className="srcs" role="group" aria-label="Filter by source">
                            <button type="button" aria-pressed={!srcFilter.length} onClick={() => setSrcFilter([])}>All<b>{fmt(summary.stats[0].n)}</b></button>
                            {summary.present.map((x) => (
                              <button key={x.id} type="button" style={{ '--c': x.color }} aria-pressed={srcFilter.includes(x.id)} onClick={() => toggleSrcFilter(x.id)}>
                                <i />{x.label}<b>{fmt(summary.counts[x.id])}</b>
                              </button>
                            ))}
                          </div>
                        )}
                        <label className="filter"><Ico d="search" /><input value={railQ} onChange={(e) => setRailQ(e.target.value)} placeholder="Filter views" aria-label="Filter views" /></label>
                      </div>
                      <div className="rail-list fresh" ref={railRef} key={res.key}>
                        <div className="sel" ref={selRef} />
                        {railGroups.map(({ s, names }) => (
                          <React.Fragment key={s.id}>
                            <div className="grp" style={{ '--c': s.color }}><i />{s.label}<span className="gn">{plural(names.length, 'view')}</span></div>
                            {names.map((n) => {
                              const v = results[n];
                              const dn = showName(n);
                              const cut = dn.indexOf('_');
                              return (
                                <button key={n} type="button" className="item" data-n={n} style={{ '--c': s.color }} aria-current={n === selected}
                                  title={`${dn}${v.database ? `\n${v.database}` : ''}\n${countLabel(v)} matches`} onClick={() => selectView(n)}>
                                  <span className="nm">{cut > 0 ? <><span>{dn.slice(0, cut + 1)}</span>{dn.slice(cut + 1)}</> : dn}</span>
                                  <span className="ct">{countLabel(v)}</span>
                                  {v.database && <span className="db">{v.database}</span>}
                                </button>
                              );
                            })}
                          </React.Fragment>
                        ))}
                        {!railNames.length && <p style={{ padding: 20, textAlign: 'center', color: 'var(--g6)', fontSize: 12.5 }}>No views match that filter.</p>}
                      </div>
                    </aside>
                  )}
                  {!noRail && !collapsed && (
                    <div className="rail-rs" role="separator" aria-orientation="vertical" aria-label="Resize the view list" tabIndex={0}
                      aria-valuenow={railW} aria-valuemin={RAIL_MIN} aria-valuemax={RAIL_MAX} title="Drag to resize. Double-click to reset."
                      onPointerDown={startRailDrag} onDoubleClick={() => saveRailW(RAIL_DEF)} onKeyDown={railKeys} />
                  )}
                  <div className="main" style={{ opacity: resultsBusy ? 0.45 : 1 }} aria-busy={resultsBusy}>
                    {isData && (allNames.length ? renderSheet() : renderEmpty())}
                    {resMeta && (metaItems.length ? renderMeta() : renderEmpty())}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <div className={`scrim ${drawer ? 'on' : ''}`} onClick={closeDrawer} aria-hidden="true" />
      <aside className={`drawer ${drawer ? 'on' : ''}`} aria-hidden={!drawer} role="dialog" aria-modal="true" aria-label="Metadata">
        {d && (
          <>
            <div className="dr-head">
              <div style={{ minWidth: 0 }}>
                <span className="badge" style={{ '--c': (srcById[d.src] || OTHER).color }}><i />{(srcById[d.src] || OTHER).label}</span>
                <h3>{d.sub || <Wbr name={showName(d.title)} />}</h3>
                {d.sub && <div className="mono" style={{ marginTop: 4, color: 'var(--g6)' }}>{showName(d.title)}</div>}
              </div>
              <button type="button" className="x" ref={drCloseRef} aria-label="Close" onClick={closeDrawer}><Ico d="x" /></button>
            </div>
            <div className="dr-body" key={`${d.title}|${d.loading}|${d.item?.id ?? ''}`}>
              {d.loading && (
                <>
                  <div className="skel" style={{ height: 110, marginBottom: 18 }} />
                  <div className="skel" style={{ height: 14, width: '70%', marginBottom: 10 }} />
                  <div className="skel" style={{ height: 14, width: '50%', marginBottom: 24 }} />
                  <div className="skel" style={{ height: 80 }} />
                </>
              )}
              {!d.loading && d.error && (
                <div className="rec-err" role="alert">{d.error}{d.view && <div><button type="button" onClick={() => openViewMeta(d.view)}>Try again</button></div>}</div>
              )}
              {!d.loading && !d.error && d.empty && (
                <div className="sec"><h5>No metadata found</h5><p>This view may not have metadata registered in the catalog.</p></div>
              )}
              {!d.loading && !d.error && d.item && <DrawerBody m={d.item} term={d.term} related={related} onRel={openMetaItem} />}
            </div>
          </>
        )}
      </aside>

      <div className={`modal ${modal ? 'on' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
        <div className={`card ${modalShown?.type === 'record' ? 'rec-card' : modalShown?.type === 'cell' ? 'rec-card cell' : ''}`} ref={cardRef} role="dialog" aria-modal="true" aria-hidden={!modal}
          onClick={(e) => { if (e.target.closest('[data-close]')) closeModal(); }}>
          {renderModal()}
        </div>
      </div>

      <div className="tip" ref={tipRef} role="tooltip" aria-hidden="true" />
      <div className={`toast ${toast ? 'on' : ''}`} role="status" aria-live="polite">
        {toast && <><Ico d={toast.sticky ? 'info' : 'check'} />{toast.msg}</>}
      </div>
    </div>
  );
}