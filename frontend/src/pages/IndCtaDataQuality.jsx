import { apiFetch, downloadFile } from '../utils/apiClient';
import { Component, Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { hardwareTier, measureTier, subscribeTier } from '../utils/perfTier';
import { useRBAC } from '../context/RBACContext';

// colours, confidence and icon maps
const C = {
  text: '#312c2a', body: '#6e6259', muted: '#81766f', faint: '#a39992', line: '#e8e6e3', line2: '#d5cfc9', tint: '#f1efed', soft: '#faf9f8',
  red: '#eb1700', redSoft: '#fff3f1', green: '#328714', greenL: '#53ce76', greenSoft: '#eff7eb', blue: '#0f68b2', blueSoft: '#edf5fc',
  sky: '#69d0ff', orange: '#ff6017', orangeSoft: '#fff4ee', violet: '#8c3bbb', violetSoft: '#f7f0fb', yellow: '#fbe058',
};

// Display style for the confidence keys the backend sends today. Anything else
// still renders, just in a neutral style with its raw key as the label.
const CONF = {
  'CLOSE MATCH': { c: C.green, bg: 'rgba(50,135,20,.10)', soft: C.greenSoft, label: 'Close match', short: 'Same thing, different formatting', fix: 'Align casing, spacing or punctuation. Usually minutes.' },
  'POSSIBLE MATCH': { c: C.orange, bg: 'rgba(255,96,23,.11)', soft: C.orangeSoft, label: 'Possible match', short: 'Close, but check before changing', fix: 'Confirm wording, strength or form with the source.' },
  'CLEAR MISMATCH': { c: C.red, bg: 'rgba(235,23,0,.09)', soft: C.redSoft, label: 'Clear mismatch', short: 'Two different things', fix: 'A data steward decides which value is right.' },
};
const CONF_ORDER = Object.keys(CONF);
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

function confOf(key) {
  if (!key || key === 'NONE') return { c: C.faint, bg: 'rgba(163,153,146,.14)', soft: C.tint, label: 'Not scored', short: 'Rule does not compare names' };
  return CONF[key] || { c: C.muted, bg: 'rgba(129,118,111,.12)', soft: C.tint, label: titleCase(key), short: 'Scored by the rule', fix: 'Review the values with the data owner.' };
}

// confidence keys in a stable order: known ones first, then whatever else showed up
function confKeys(keys) {
  const all = [...new Set(keys.filter((k) => k && k !== 'NONE'))];
  return [...CONF_ORDER.filter((k) => all.includes(k)), ...all.filter((k) => !CONF[k]).sort()];
}

const GROUP_COLORS = [[C.blue, C.blueSoft], [C.violet, C.violetSoft], [C.orange, C.orangeSoft], [C.green, C.greenSoft], [C.sky, '#eefaff'], [C.red, C.redSoft]];

// colours follow the sorted group names, so they stay put when the counts reorder
function groupColors(groups) {
  const names = [...new Set(groups.map((g) => g || 'OTHER'))].sort();
  const pick = (g) => GROUP_COLORS[Math.max(0, names.indexOf(g || 'OTHER')) % GROUP_COLORS.length];
  return { color: (g) => pick(g)[0], soft: (g) => pick(g)[1] };
}

const groupLabel = (g) => (g ? g[0] + g.slice(1).toLowerCase() : 'Other');

// the API's age bucket keys, with how the page shows them
const AGES = [
  { key: '0-7', label: '0-7 days', c: C.sky },
  { key: '8-30', label: '8-30 days', c: C.blue },
  { key: '31-90', label: '31-90 days', c: C.orange },
  { key: '90+', label: '90+ days', c: C.red },
];
const ageOf = (k) => AGES.find((a) => a.key === k);

const ICONS = {
  alert: 'JJ_Icon_Alert_RGB', check: 'JJ_Icon_Check_RGB', time: 'JJ_Icon_Time_RGB', timer: 'JJ_Icon_Timer_RGB',
  records: 'JJ_Icon_Records_Information_RGB', analysis: 'JJ_Icon_Analysis_RGB', info: 'JJ_Icon_Info_RGB', db: 'JJ_Icon_Database_RGB',
  filter: 'JJ_Icon_Filter', search: 'JJ_Icon_Search_RGB', refresh: 'JJ_Icon_Refresh_RGB', download: 'JJ_Icon_Download_PDF_RGB',
  close: 'JJ_Icon_Close', 'chev-r': 'JJ_Icon_Chevron_Right', 'chev-l': 'JJ_Icon_Chevron_Left', 'chev-d': 'JJ_Icon_Chevron_Down',
  sql: 'JJ_Icon_Stationery_RGB', help: 'JJ_Icon_Help', shield: 'JJ_Icon_Shield_RGB', ai: 'JJ_Icon_AI_RGB', chart: 'JJ_Icon_Graph_Chart_RGB',
  sort: 'JJ_Icon_Sort', cal: 'JJ_Icon_Calendar_RGB', link: 'JJ_Icon_Link_RGB', play: 'JJ_Icon_Video_Play_RGB', dash: 'JJ_Icon_Dashboard_RGB',
  outcomes: 'JJ_Icon_Outcomes', record: 'JJ_Icon_Record_RGB', lock: 'JJ_Icon_Lock_black',
};

// formatting and detail parsing
const DAY = 864e5;

const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? '-' : Number(n).toLocaleString('en-US'));
// short form for small badges: 13,561 -> 13.6K, 1,250,000 -> 1.3M (full number goes in the tooltip)
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmtK = (n) => (n == null || Number.isNaN(Number(n)) ? '-' : COMPACT.format(Number(n)));
// Never rounds a real amount away: 3 fixed out of 13,564 reads "<1%", not "0%",
// and 13,561 open out of 13,564 reads ">99%", not "100%".
const pct = (x, d = 0) => {
  if (x == null || !Number.isFinite(x)) return '-';
  const lim = 0.5 / 10 ** (d + 2);
  if (x > 0 && x < lim) return `<${(1 / 10 ** d).toFixed(d)}%`;
  if (x < 1 && x > 1 - lim) return `>${(100 - 1 / 10 ** d).toFixed(d)}%`;
  return `${(x * 100).toFixed(d)}%`;
};
const ratio = (a, b) => (b ? a / b : null);

// dates come back as ISO strings, sometimes date-only for weeks
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function relTime(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return '-';
  const s = (now - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86400);
  return days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

const shortDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
};
const fullDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleString('en-US') : '-';
};
const weekLabel = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
};
const daysBetween = (a, b) => {
  const x = toDate(a), y = toDate(b);
  return x && y ? (y - x) / DAY : null;
};
const plural = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;
const minutes = (sec) => (sec ? `${Math.round(sec / 60) || 1} minute${Math.round(sec / 60) === 1 ? '' : 's'}` : '');

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// The API only sends weeks that had activity. Fill the gaps with zeros and walk
// the backlog back from today's open count, the same way the backend does.
function fillWeeks(trend, weeks, openNow, now = Date.now()) {
  const rows = (trend || []).map((w) => ({ ...w, d: toDate(w.week) })).filter((w) => w.d);
  if (!rows.length) return [];
  const byKey = new Map(rows.map((w) => [isoDay(w.d), w]));
  let last = rows[rows.length - 1].d;
  while (addDays(last, 7).getTime() <= now) last = addDays(last, 7);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = addDays(last, -7 * i);
    const hit = byKey.get(isoDay(d));
    out.push({ week: isoDay(d), new: hit?.new || 0, resolved: hit?.resolved || 0 });
  }
  let backlog = openNow;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].backlog = Math.max(0, backlog);
    backlog = backlog - out[i].new + out[i].resolved;
  }
  return out;
}

// "Label: value || Label: value" into parts
function parseDetail(str) {
  return String(str || '').split('||').map((p) => {
    const i = p.indexOf(':');
    return i < 0 ? { label: '', value: p.trim() } : { label: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  }).filter((p) => p.label || p.value);
}

const SIDE = /^(jnj|ema sms|ema|sms|pharma|source|target|mdm)\s+/i;
const stripSide = (label) => String(label || '').replace(SIDE, '').replace(SIDE, '').trim();

// pairs up "JNJ X" with "EMA SMS X" so they can be compared
function pairDetail(parts) {
  const m = new Map();
  parts.forEach((p) => {
    const k = stripSide(p.label).toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  });
  const out = [];
  m.forEach((list, key) => {
    if (list.length === 2) out.push({ type: 'pair', key, left: list[0], right: list[1] });
    else list.forEach((p) => out.push({ type: 'single', ...p }));
  });
  return out;
}

const isNullish = (v) => !v || /^null$/i.test(String(v).trim());

// word level LCS so the words that differ can be highlighted
function wordDiff(a, b) {
  const split = (s) => String(s || '').split(/(\s+|[,()/+-])/).filter(Boolean);
  const ta = split(a), tb = split(b);
  const n = ta.length, m = tb.length;
  const eq = (x, y) => x.toLowerCase() === y.toLowerCase();
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = eq(ta[i], tb[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const ra = ta.map((t) => ({ t, same: false })), rb = tb.map((t) => ({ t, same: false }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(ta[i], tb[j])) { ra[i].same = rb[j].same = true; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  [...ra, ...rb].forEach((x) => { if (!x.t.trim()) x.same = true; });
  return [ra, rb];
}

// API calls, errors and caches
const PERMISSION_LABEL = 'View IND/CTA Data Quality';

class IcqError extends Error {
  constructor(message, status = 0, detail = '') {
    super(message);
    this.name = 'IcqError';
    this.status = status;
    this.detail = detail;
  }
}

// one sentence a person can act on, plus the raw bits for "Show details"
function messageFor(status, detail) {
  if (status === 401) return 'Your session expired. Reload the page to sign in again.';
  if (status === 403) return `You do not have access to IND/CTA Data Quality. Ask an admin for the ${PERMISSION_LABEL} permission.`;
  if (status === 504) return 'Snowflake took too long to answer. Try again in a moment.';
  return detail || `Request failed (HTTP ${status})`;
}

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  const detail = typeof body.detail === 'string' ? body.detail
    : Array.isArray(body.detail) ? body.detail.map((d) => d?.msg).filter(Boolean).join('; ') : '';
  return new IcqError(messageFor(res.status, detail), res.status, detail || res.statusText);
}

const netError = (e) => (e?.name === 'TypeError'
  ? 'Can not reach the SmartHub server. Check that the backend is running.'
  : e?.message || 'Something went wrong');

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// network failures get one retry after 800ms, HTTP errors never do
async function getJson(path, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await apiFetch(path, { signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (e?.status) throw new IcqError(messageFor(e.status, e.detail), e.status, e.detail);
      if (e?.name === 'TypeError' && attempt === 0) { await wait(800, signal); continue; }
      throw new IcqError(netError(e), 0, String(e?.message || e));
    }
    if (!res.ok) throw await readError(res);
    return res.json();
  }
}

const isAbort = (e) => e?.name === 'AbortError';

function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, String(v)); });
  return p.toString();
}

// filters as the API spells them
function apiFilters(f) {
  return { status: f.status, group: f.group, rule: f.rule, confidence: f.conf, q: f.q, days: f.days, age: f.age };
}

const summaryUrl = (weeks, refresh) => `/dq/ind-cta/summary?${qs({ weeks, refresh: refresh ? 'true' : '' })}`;
const issuesUrl = (f) => `/dq/ind-cta/issues?${qs({ ...apiFilters(f), sort: f.sort, dir: f.dir, page: f.page, page_size: f.size })}`;
const facetsUrl = (f) => `/dq/ind-cta/facets?${qs(apiFilters(f))}`;
const historyUrl = (pk, rule) => `/dq/ind-cta/history?${qs({ source_pk: pk, rule })}`;
const STATUS_URL = '/dq/ind-cta/status';

async function exportCsv(f) {
  try {
    await downloadFile(`/dq/ind-cta/export?${qs(apiFilters(f))}`, `ind_cta_dq_${f.status}.csv`);
  } catch (e) {
    if (e?.status) throw new IcqError(messageFor(e.status, e.detail), e.status, e.detail);
    throw new IcqError(netError(e));
  }
}

// summaries live for the whole session, one per weeks value
const summaryCache = new Map();

// small short-lived cache so a prefetched page shows instantly
const pageCache = new Map();
const PAGE_TTL = 60e3;
function pageGet(url) {
  const hit = pageCache.get(url);
  if (!hit || Date.now() - hit.t > PAGE_TTL) return null;
  return hit.data;
}
function pagePut(url, data) {
  pageCache.set(url, { t: Date.now(), data });
  if (pageCache.size > 30) pageCache.delete(pageCache.keys().next().value);
}
function pageClear() { pageCache.clear(); }

// navigator.clipboard only exists on https, so fall back to a textarea
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    let ok;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// URL state
const TABS = ['overview', 'rules', 'issues'];
const WEEKS = [12, 26, 52];
const STATUSES = ['open', 'resolved', 'all'];
const SORTS = ['source_pk', 'rule', 'group', 'name', 'first_seen', 'updated', 'resolved_at', 'name_score', 'semantic_score', 'edit_distance', 'overlap', 'confidence', 'versions'];
const SIZES = [25, 50, 100, 250];
const DAYS = ['7', '30', '90'];
const AGE_KEYS = ['0-7', '8-30', '31-90', '90+'];
const RULE_SORTS = ['open', 'new', 'fix', 'id'];

const DEFAULT_WEEKS = 26;
const DEFAULT_SIZE = 50;
const FILTER_KEYS = ['status', 'group', 'rule', 'conf', 'q', 'days', 'age', 'sort', 'dir', 'page', 'size'];
const ISSUE_KEYS = ['issue', 'irule'];

// the Fixed view sorts by when things were fixed, the others by when they appeared
const defaultSort = (status) => (status === 'resolved' ? 'resolved_at' : 'first_seen');

const text = (v, max) => (v ? String(v).trim().slice(0, max) : '');

const DEFAULT_FILTERS = {
  status: 'open', group: '', rule: '', conf: '', q: '', days: '', age: '',
  sort: 'first_seen', dir: 'desc', page: 1, size: DEFAULT_SIZE,
};

function readFilters(sp) {
  const status = STATUSES.includes(sp.get('status')) ? sp.get('status') : 'open';
  const page = parseInt(sp.get('page'), 10);
  const size = parseInt(sp.get('size'), 10);
  // a raw "+" in a hand-typed URL arrives as a space
  const age = (sp.get('age') || '').trim().replace(/^90$/, '90+');
  return {
    status,
    group: text(sp.get('group'), 100),
    rule: text(sp.get('rule'), 200),
    conf: text(sp.get('conf'), 60),
    q: text(sp.get('q'), 200),
    days: DAYS.includes(sp.get('days')) ? sp.get('days') : '',
    age: AGE_KEYS.includes(age) ? age : '',
    sort: SORTS.includes(sp.get('sort')) ? sp.get('sort') : defaultSort(status),
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 0 && page < 1e6 ? page : 1,
    size: SIZES.includes(size) ? size : DEFAULT_SIZE,
  };
}

function writeFilters(p, f) {
  FILTER_KEYS.forEach((k) => p.delete(k));
  if (f.status !== 'open') p.set('status', f.status);
  ['group', 'rule', 'conf', 'q', 'days', 'age'].forEach((k) => { if (f[k]) p.set(k, f[k]); });
  if (f.sort !== defaultSort(f.status)) p.set('sort', f.sort);
  if (f.dir !== 'desc') p.set('dir', f.dir);
  if (f.page > 1) p.set('page', String(f.page));
  if (f.size !== DEFAULT_SIZE) p.set('size', String(f.size));
  return p;
}

// the Fixed view sorts by fix date, the others by first seen
function fixSort(f) {
  if (f.status === 'resolved' && f.sort === 'first_seen') f.sort = 'resolved_at';
  if (f.status !== 'resolved' && f.sort === 'resolved_at') f.sort = 'first_seen';
  return f;
}

function readState(sp) {
  const weeks = Number(sp.get('weeks'));
  return {
    tab: TABS.includes(sp.get('indctatab')) ? sp.get('indctatab') : 'overview',
    weeks: WEEKS.includes(weeks) ? weeks : DEFAULT_WEEKS,
    filters: readFilters(sp),
    rq: text(sp.get('rq'), 100),
    rgroup: text(sp.get('rgroup'), 100),
    rsort: RULE_SORTS.includes(sp.get('rsort')) ? sp.get('rsort') : 'open',
    issue: text(sp.get('issue'), 300),
    irule: text(sp.get('irule'), 200),
  };
}

// params whose raw value is not one the page accepts
function invalidKeys(sp) {
  const bad = [];
  const has = (k) => sp.has(k);
  const num = (k) => Number(sp.get(k));
  if (has('indctatab') && !TABS.includes(sp.get('indctatab'))) bad.push('indctatab');
  if (has('weeks') && !WEEKS.includes(num('weeks'))) bad.push('weeks');
  if (has('status') && !STATUSES.includes(sp.get('status'))) bad.push('status');
  if (has('sort') && !SORTS.includes(sp.get('sort'))) bad.push('sort');
  if (has('dir') && !['asc', 'desc'].includes(sp.get('dir'))) bad.push('dir');
  if (has('page') && !(Number.isInteger(num('page')) && num('page') > 0 && num('page') < 1e6)) bad.push('page');
  if (has('size') && !SIZES.includes(num('size'))) bad.push('size');
  if (has('days') && !DAYS.includes(sp.get('days'))) bad.push('days');
  if (has('age') && !AGE_KEYS.includes((sp.get('age') || '').trim().replace(/^90$/, '90+'))) bad.push('age');
  if (has('rsort') && !RULE_SORTS.includes(sp.get('rsort'))) bad.push('rsort');
  return bad;
}

const setOr = (p, k, v, dflt) => { if (v === dflt || v === '' || v == null) p.delete(k); else p.set(k, String(v)); };

function useUrlState() {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => readState(sp), [sp]);
  // while the tour runs every change replaces, so it leaves no history behind
  const replaceAll = useRef(false);
  // lets setFilters drop a rule that is not in the newly picked group
  const ruleGroup = useRef(() => null);
  // the router hands out a new setter on every URL change; keeping the latest
  // in a ref lets every action below keep one identity, so memoised views skip renders
  const setRef = useRef(setSp);
  setRef.current = setSp;

  // clean junk out of hand-edited or stale links, without adding history
  useEffect(() => {
    const bad = invalidKeys(sp);
    if (bad.length) {
      setSp((prev) => { const p = new URLSearchParams(prev); bad.forEach((k) => p.delete(k)); return p; }, { replace: true });
    }
  }, [sp, setSp]);

  const update = useCallback((fn, replace = false) => {
    setRef.current((prev) => {
      const p = new URLSearchParams(prev);
      fn(p);
      return p;
    }, { replace: replace || replaceAll.current });
  }, []);

  const setTab = useCallback((t) => update((p) => {
    setOr(p, 'indctatab', t, 'overview');
    ISSUE_KEYS.forEach((k) => p.delete(k));
  }), [update]);

  const setWeeks = useCallback((w) => update((p) => setOr(p, 'weeks', w, DEFAULT_WEEKS), true), [update]);

  const setFilters = useCallback((patch, { replace = false } = {}) => update((p) => {
    const cur = readFilters(p);
    const next = { ...cur, ...patch };
    if (!('page' in patch)) next.page = 1;
    if ('group' in patch && next.group && next.rule) {
      const g = ruleGroup.current(next.rule);
      if (g && g !== next.group) next.rule = '';
    }
    if ('status' in patch && !('sort' in patch)) fixSort(next);
    writeFilters(p, next);
  }, replace), [update]);

  // drill-down: fresh filters, issue explorer, new history entry
  const go = useCallback((patch) => update((p) => {
    p.set('indctatab', 'issues');
    ISSUE_KEYS.forEach((k) => p.delete(k));
    writeFilters(p, fixSort({ ...DEFAULT_FILTERS, ...patch, page: 1 }));
  }), [update]);

  const setRules = useCallback((patch, replace = false) => update((p) => {
    if ('rq' in patch) setOr(p, 'rq', patch.rq, '');
    if ('rgroup' in patch) setOr(p, 'rgroup', patch.rgroup, '');
    if ('rsort' in patch) setOr(p, 'rsort', patch.rsort, 'open');
  }, replace), [update]);

  const openIssue = useCallback((pk, rule, { replace = false, page } = {}) => update((p) => {
    p.set('issue', pk);
    p.set('irule', rule);
    if (page) setOr(p, 'page', page, 1);
  }, replace), [update]);

  const closeIssue = useCallback(() => update((p) => ISSUE_KEYS.forEach((k) => p.delete(k)), true), [update]);

  // drop values that the loaded data says do not exist
  const dropParams = useCallback((keys) => update((p) => keys.forEach((k) => p.delete(k)), true), [update]);

  const snapshot = useCallback(() => sp.toString(), [sp]);
  const restore = useCallback((snap) => setRef.current(new URLSearchParams(snap), { replace: true }), []);
  const replaceTo = useCallback((fn) => update(fn, true), [update]);

  return {
    ...state, setTab, setWeeks, setFilters, go, setRules, openIssue, closeIssue, dropParams,
    snapshot, restore, replaceTo, replaceAll, ruleGroup,
  };
}

// data hooks
// One summary per weeks value, cached for the session. Switching weeks keeps the
// old numbers on screen until the new ones land.
function useSummary(weeks, nonce) {
  const [s, set] = useState(() => ({
    data: summaryCache.get(weeks) || null, forWeeks: weeks, error: null, loading: !summaryCache.has(weeks), refreshing: false, refreshError: null,
  }));
  const ctl = useRef(null);

  const fetchSummary = useCallback((refresh) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    set((p) => ({ ...p, loading: !refresh, refreshing: refresh, error: refresh ? p.error : null, refreshError: null }));
    return getJson(summaryUrl(weeks, refresh), c.signal).then((d) => {
      if (ctl.current !== c) return false;
      summaryCache.set(weeks, d);
      set({ data: d, forWeeks: weeks, error: null, loading: false, refreshing: false, refreshError: null });
      return true;
    }).catch((e) => {
      if (isAbort(e) || ctl.current !== c) return false;
      set((p) => (p.data
        ? { ...p, loading: false, refreshing: false, refreshError: e }
        : { ...p, loading: false, refreshing: false, error: e }));
      return false;
    });
  }, [weeks]);

  useEffect(() => {
    const hit = summaryCache.get(weeks);
    if (hit) {
      ctl.current?.abort();
      set({ data: hit, forWeeks: weeks, error: null, loading: false, refreshing: false, refreshError: null });
      return undefined;
    }
    fetchSummary(false);
    return () => ctl.current?.abort();
  }, [weeks, fetchSummary]);

  // coming back online: try again only if the last attempt failed
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (s.error || s.refreshError) fetchSummary(!!s.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const dismiss = useCallback(() => set((p) => ({ ...p, refreshError: null })), []);
  return { ...s, refresh: () => fetchSummary(true), retry: () => fetchSummary(false), dismiss };
}

// Generic GET with abort, late-response guard and stale-while-revalidate.
// keep: false clears the old data when the url changes (used for one issue's history).
function useResource(url, { nonce = 0, keep = true, cacheGet, cachePut, cacheDrop } = {}) {
  const [s, set] = useState({ data: null, error: null, loading: !!url, url: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) {
      set({ data: null, error: null, loading: false, url: null });
      return undefined;
    }
    const hit = cacheGet?.(url);
    if (hit) {
      set({ data: hit, error: null, loading: false, url });
      return undefined;
    }
    const c = new AbortController();
    set((p) => ({ data: keep || p.url === url ? p.data : null, error: null, loading: true, url: p.url }));
    getJson(url, c.signal)
      .then((d) => {
        if (c.signal.aborted) return;
        cachePut?.(url, d);
        set({ data: d, error: null, loading: false, url });
      })
      .catch((e) => {
        if (isAbort(e) || c.signal.aborted) return;
        set((p) => ({ ...p, error: e, loading: false, url }));
      });
    return () => c.abort();
    // cache helpers are module functions, so they never change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, tick, keep]);

  const reload = useCallback(() => {
    cacheDrop?.(url);
    setTick((t) => t + 1);
  }, [url, cacheDrop]);

  return { ...s, reload };
}

// ticks every minute so relative times stay honest without refetching
function useNow(ms = 60e3) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

// The portal's perfTier also counts the OS reduce-motion setting as "lite"; this
// page only looks at the hardware, and steps down if the frame-rate check says so.
function useMachineTier() {
  const [tier, setTier] = useState(hardwareTier);
  useEffect(() => subscribeTier(() => setTier((t) => (t === 'full' ? 'lite' : 'min'))), []);
  return tier;
}

// true only once `flag` has stayed on for `ms`, so fast loads never flash a skeleton
function useDelayed(flag, ms = 150) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) { setOn(false); return undefined; }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return flag && on;
}

function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let t;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setW(el.clientWidth), 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [ref]);
  return w;
}

// shared contexts
const noop = () => {};
const TipCtx = createContext({ show: noop, showAt: noop, move: noop, hide: noop });
const ToastCtx = createContext(noop);
const ToastStateCtx = createContext({ msg: '', bad: false, on: false });
// true while the current view is painting for the first time, so entrance
// animations and count-ups run once and never on a refetch
const AnimCtx = createContext(false);

const useTip = () => useContext(TipCtx);
const useToast = () => useContext(ToastCtx);
const useAnim = () => useContext(AnimCtx);

// numbers derived from the summary
// a rule is "scored" when it carries name match scores or confidence bands
const isScored = (r) => r.avg_name_score != null || r.avg_semantic_score != null || Object.keys(r.confidence || {}).length > 0;

// Everything the overview and rules views read, worked out once per summary
function buildModel(summary, weeks, now) {
  if (!summary?.kpis) return null;
  const k = summary.kpis;
  const rules = (summary.rules || []).map((r) => ({ ...r, scored: isScored(r) }));
  const groups = summary.groups || [];
  const colors = groupColors([...groups.map((g) => g.group), ...rules.map((r) => r.group)]);
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const open = k.open_issues || 0;
  const resolved = k.resolved_issues || 0;

  const trend = fillWeeks(summary.trend, weeks, open, now);
  const last12 = trend.slice(-12);
  const last4 = trend.slice(-4);
  const new4 = last4.reduce((s, w) => s + w.new, 0);
  const fixed4 = last4.reduce((s, w) => s + w.resolved, 0);
  const bNow = trend.length ? trend[trend.length - 1].backlog : open;
  const b4 = trend.length > 4 ? trend[trend.length - 5].backlog : null;
  const backlogChange = b4 ? (bNow - b4) / b4 : null;
  const backlogDiff = b4 != null ? bNow - b4 : null;
  const state = !trend.length ? null : fixed4 > new4 ? 'good' : fixed4 < new4 ? 'bad' : 'flat';

  const byOpen = [...rules].sort((a, b) => b.open - a.open || String(a.id).localeCompare(String(b.id)));
  const top = byOpen[0]?.open > 0 ? byOpen[0] : null;
  const stuckList = byOpen.filter((r) => r.open > 0 && r.resolved === 0);
  // a second card for the same rule says nothing new
  const stuck = stuckList.find((r) => r !== top) || null;

  const conf = summary.confidence || [];
  const confMap = Object.fromEntries(conf.map((c) => [c.label, c.count]));
  const scoredKeys = confKeys(conf.map((c) => c.label));
  const scoredTotal = scoredKeys.reduce((s, key) => s + (confMap[key] || 0), 0);
  const closeCount = confMap['CLOSE MATCH'] || 0;

  const aging = Array.isArray(summary.aging) ? summary.aging : null;

  return {
    k, rules, groups, colors, ruleById, open, resolved,
    groupOrder: [...new Set([...groups.map((g) => g.group), ...rules.map((r) => r.group)].filter(Boolean))],
    total: open + resolved,
    fixRate: ratio(resolved, open + resolved),
    trend, last12, new4, fixed4, backlogChange, backlogDiff, state,
    byOpen, top, stuck, stuckCount: stuckList.length,
    activeRules: k.active_rules ?? rules.filter((r) => r.open > 0).length,
    totalRules: rules.length,
    scoredRules: rules.filter((r) => r.scored),
    confMap, scoredKeys, scoredTotal, closeCount,
    aging,
    hasGroupRecords: groups.length > 0 && groups.every((g) => g.affected_records != null),
    hasSpark: rules.length > 0 && rules.every((r) => Array.isArray(r.spark)),
  };
}

// dialogs: focus trap and scroll lock
const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Lock the page scroller (the app's <main>, not body) and keep the scrollbar's
// space so nothing jumps. Counted, so a modal over the drawer is fine.
let locks = 0;
let saved = null;
function lockScroll(scroller) {
  if (!scroller) return () => {};
  if (locks++ === 0) {
    // with a stable gutter the scrollbar's space stays put, so nothing re-lays out
    const stable = getComputedStyle(scroller).scrollbarGutter?.includes('stable');
    const bar = stable ? 0 : scroller.offsetWidth - scroller.clientWidth;
    saved = { overflow: scroller.style.overflow, pad: scroller.style.paddingRight };
    scroller.style.overflow = 'hidden';
    if (bar > 0) scroller.style.paddingRight = `${bar}px`;
  }
  return () => {
    if (--locks === 0 && saved) {
      scroller.style.overflow = saved.overflow;
      scroller.style.paddingRight = saved.pad;
      saved = null;
    }
  };
}

// focus trap: first control gets focus on open, Tab cycles inside,
// and focus goes back to whatever opened the dialog
function useDialog(ref, { open, scroller, returnTo, initial }) {
  useEffect(() => {
    if (!open) return undefined;
    const node = ref.current;
    const back = returnTo?.current || document.activeElement;
    const unlock = lockScroll(scroller);
    const first = (initial && node?.querySelector(initial)) || node?.querySelector(FOCUSABLE) || node;
    first?.focus({ preventScroll: true });

    const trap = (e) => {
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    node?.addEventListener('keydown', trap);
    return () => {
      node?.removeEventListener('keydown', trap);
      unlock();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// Icon
function Icon({ name, size, color, className = '', style }) {
  const file = ICONS[name] || name;
  return (
    <span
      aria-hidden="true"
      className={`ic ${className}`}
      style={{ '--m': `url("/icons/${file}.svg")`, ...(size ? { width: size, height: size } : null), ...(color ? { color } : null), ...style }}
    />
  );
}

// small (i) that explains how a number is counted, on hover or focus
function Qmark({ tip, label = 'How this is counted' }) {
  return (
    <button type="button" className="qmark" data-tip={tip} aria-label={`${label}: ${tip}`} onClick={(e) => e.stopPropagation()}>
      <Icon name="info" />
    </button>
  );
}

// Btn
function Btn({ children, className = '', ...rest }) {
  return <button type="button" className={`btn ${className}`} {...rest}>{children}</button>;
}

// a card or row that acts like a button, with Enter and Space
function Clickable({ as: Tag = 'div', onClick, className = '', children, ...rest }) {
  const key = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e); }
  };
  return <Tag role="button" tabIndex={0} className={`click ${className}`} onClick={onClick} onKeyDown={key} {...rest}>{children}</Tag>;
}

function SqlButton({ onOpen, query, label = 'View SQL', large, disabled }) {
  const { hasPermission } = useRBAC();
  if (!hasPermission('viewIndCtaSql')) return null;
  return (
    <button
      type="button"
      className={`sqlbtn ${large ? 'lg' : ''}`}
      disabled={disabled || !query}
      onClick={(e) => { e.stopPropagation(); onOpen(query, e.currentTarget); }}
      data-tip={query ? undefined : 'Available once the numbers have loaded'}
    >
      <Icon name="sql" />{label}
    </button>
  );
}

// Pill
function ConfPill({ value, small }) {
  const c = confOf(value);
  return (
    <span className={`pill ${small ? 'sm' : ''}`} style={{ background: c.bg, color: c.c }}>
      <i style={{ background: c.c }} />{c.label}
    </span>
  );
}

// Rule IDs come from Snowflake with the source system's "MDM_" prefix. Shown
// without it; the raw ID is still what filters, URLs and the API use.
const ruleLabel = (id) => String(id ?? '').replace(/^MDM[\s_-]+/i, '');
const RuleChip = ({ id }) => <span className="chip" title={ruleLabel(id)}>{ruleLabel(id)}</span>;

function GroupPill({ group, color }) {
  return (
    <span className="gpill" style={{ color, borderColor: `${color}40`, background: `${color}0f` }}>{group || 'Other'}</span>
  );
}

// Seg
function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

// Spark
// little trend line. Needs two or more numbers, otherwise draws nothing
function Spark({ values, color, w = 120, h = 30, fill = true, label }) {
  const id = useId().replace(/:/g, '');
  const vals = (values || []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  if (vals.length < 2) return null;
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const x = (i) => (i / (vals.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = vals.length - 1;
  // The svg stretches to the card width, which would squash a circle drawn inside
  // it into an oval (and clip it at the edge), so the end dot is a plain span on top.
  return (
    <span className="spk" style={{ height: h }}>
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".18" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${d} L${x(last)},${h} L${x(0)},${h} Z`} fill={`url(#sp${id})`} />}
      <path className="draw" d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"
        vectorEffect="non-scaling-stroke" pathLength="1" strokeDasharray="1" style={{ '--c': 1 }} />
    </svg>
    <i className="spk-dot" aria-hidden="true" style={{ left: `${(x(last) / w) * 100}%`, top: y(vals[last]), borderColor: color }} />
    </span>
  );
}

// StackBar
// parts: [{ n, c, label }]. Each slice shows its share on hover or focus.
function StackBar({ parts, height = 12, label }) {
  const shown = (parts || []).filter((p) => p.n > 0);
  const tot = shown.reduce((s, p) => s + p.n, 0);
  const summary = label || shown.map((p) => `${p.label} ${fmt(p.n)}`).join(', ');
  return (
    <div className="stack" style={{ height }} role="img" aria-label={tot ? summary : 'No data'}>
      {shown.map((p, i) => (
        <span
          key={p.label}
          className="growx"
          style={{ width: `${(p.n / tot) * 100}%`, background: p.c, animationDelay: `${i * 80}ms` }}
          data-tip={`${p.label}: ${fmt(p.n)} (${pct(p.n / tot)})`}
        />
      ))}
    </div>
  );
}

// Kpi
const show = (v, dec) => Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

// counts up from zero on the view's first paint only; later changes just swap the number
// The frames write straight into the span, so a count-up never re-renders React.
function CountUp({ value, decimals = 0, ms = 1100 }) {
  const anim = useAnim();
  const el = useRef(null);
  const [start] = useState(() => anim);
  const done = useRef(!start);
  const ok = Number.isFinite(Number(value));

  useLayoutEffect(() => {
    const node = el.current;
    if (!node || !ok) return undefined;
    if (done.current) { node.textContent = show(value, decimals); return undefined; }
    const t0 = performance.now();
    let raf;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      node.textContent = show(value * (1 - (1 - k) ** 4), decimals);
      if (k < 1) raf = requestAnimationFrame(tick);
      else done.current = true;
    };
    node.textContent = show(0, decimals);
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); done.current = true; node.textContent = show(value, decimals); };
  }, [value, decimals, ms, ok]);

  if (!ok) return '-';
  return <span ref={el} />;
}

// change against the previous period. upIsBad picks which direction is red
function Delta({ now, prev, upIsBad, label }) {
  if (prev == null || now == null) return null;
  const d = now - prev;
  if (!d) return <span className="faint">same as {label.replace(/^vs /, '')}</span>;
  const bad = upIsBad ? d > 0 : d < 0;
  return (
    <>
      <span className={bad ? 'up' : 'down'}>
        <span aria-hidden="true">{d > 0 ? '▲' : '▼'}</span> {fmt(Math.abs(d))}
        <span className="sr">{d > 0 ? ' more' : ' fewer'}</span>
      </span>{' '}<span className="faint">{label}</span>
    </>
  );
}

function Kpi({ label, value, decimals = 0, suffix, sub, tip, icon, color, bg, tone, delay = 0, children, id }) {
  return (
    <div className="kpi rise" style={{ animationDelay: `${delay}ms` }} id={id}>
      <div className="lab">
        {label}
        {tip && <Qmark tip={tip} label={label} />}
        <span className="icb" style={{ background: bg, color }}><Icon name={icon} /></span>
      </div>
      <div className="val num" style={{ color: tone }}>
        {value == null ? '-' : <CountUp value={value} decimals={decimals} />}
        {suffix && value != null && <small>{suffix}</small>}
      </div>
      <div className="sub">{sub}</div>
      {children}
    </div>
  );
}

// Ring
// share of every issue ever raised that is now fixed
function Ring({ value, fixed, total }) {
  const id = useId().replace(/:/g, '');
  const R = 72, circ = 2 * Math.PI * R;
  const frac = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <div className="ringbox" role="img" aria-label={Number.isFinite(value) ? `${frac > 0 && frac < 0.005 ? 'Less than 1' : Math.round(frac * 100)}% of issues fixed${total ? `, ${fmt(fixed)} of ${fmt(total)}` : ''}` : 'Fix rate not available'}>
      <svg width="172" height="172" viewBox="0 0 172 172" aria-hidden="true">
        <defs>
          <linearGradient id={`rg${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={C.greenL} />
            <stop offset="1" stopColor={C.green} />
          </linearGradient>
        </defs>
        <circle cx="86" cy="86" r={R} fill="none" stroke={C.tint} strokeWidth="14" />
        <circle cx="86" cy="86" r={R + 11} fill="none" stroke={C.line} strokeWidth="1" strokeDasharray="2 5" />
        {frac > 0 && (
          <circle className="ring-arc" cx="86" cy="86" r={R} fill="none" stroke={`url(#rg${id})`} strokeWidth="14" strokeLinecap="round"
            strokeDasharray={`${circ * frac} ${circ}`} transform="rotate(-90 86 86)" style={{ '--c': circ * frac }} />
        )}
      </svg>
      <div className="ring-c" aria-hidden="true">
        <div className="big num">{!Number.isFinite(value) ? '-'
          : frac > 0 && frac < 0.005 ? <><b>&lt;1</b><span>%</span></>
            : <><b><CountUp value={frac * 100} /></b><span>%</span></>}</div>
        {total ? (
          <>
            <span className="ring-n"><b className="num">{fmt(fixed)}</b> of <b className="num">{fmt(total)}</b></span>
            <small>issues ever raised are fixed</small>
          </>
        ) : <small>of all issues ever raised are fixed</small>}
      </div>
    </div>
  );
}

// Tooltip
// One tooltip for the whole page. Plain text tips come from data-tip attributes
// (hover or keyboard focus); charts pass rich content through useTip().
function TipProvider({ rootRef, children }) {
  const el = useRef(null);
  const [content, setContent] = useState(null);
  const at = useRef({ x: 0, y: 0, rect: null });
  const source = useRef(null);

  // size is measured once per new content, and moves are batched to one per
  // frame, so following the mouse never forces a layout
  const size = useRef({ w: 0, h: 0 });
  const frame = useRef(0);
  const place = useCallback(() => {
    frame.current = 0;
    const t = el.current;
    if (!t) return;
    const { w, h } = size.current, vw = window.innerWidth, vh = window.innerHeight;
    let x, y;
    const r = at.current.rect;
    if (r) {
      x = Math.min(vw - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
      y = r.bottom + 10;
      if (y + h > vh - 10) y = r.top - h - 10;
    } else {
      const { x: px, y: py } = at.current;
      x = px + 14; y = py + 16;
      if (x + w > vw - 10) x = px - w - 14;
      if (y + h > vh - 10) y = py - h - 12;
    }
    t.style.transform = `translate(${Math.max(4, x)}px,${Math.max(4, y)}px)`;
  }, []);

  useLayoutEffect(() => {
    if (el.current) size.current = { w: el.current.offsetWidth, h: el.current.offsetHeight };
    place();
  }, [content, place]);
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(place); }, [place]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const api = useMemo(() => ({
    show: (c, x, y) => { at.current = { x, y, rect: null }; setContent(c); },
    showAt: (c, node) => { at.current = { x: 0, y: 0, rect: node?.getBoundingClientRect?.() || null }; setContent(c); },
    move: (x, y) => { at.current = { x, y, rect: null }; schedule(); },
    hide: () => { source.current = null; setContent(null); },
  }), [schedule]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const find = (t) => t?.closest?.('[data-tip]');
    const over = (e) => {
      const n = find(e.target);
      if (n === source.current) return;
      source.current = n;
      if (n && n.dataset.tip) { at.current = { x: e.clientX, y: e.clientY, rect: null }; setContent(n.dataset.tip); }
      else if (!n && !e.target.closest?.('[data-rich-tip]')) setContent(null);
    };
    const move = (e) => { if (source.current) { at.current = { x: e.clientX, y: e.clientY, rect: null }; schedule(); } };
    const leave = () => { source.current = null; setContent(null); };
    const focus = (e) => {
      const n = find(e.target);
      if (n && n.dataset.tip && e.target.matches(':focus-visible')) { source.current = n; api.showAt(n.dataset.tip, n); }
    };
    const blur = () => { if (source.current) { source.current = null; setContent(null); } };
    const key = (e) => { if (e.key === 'Escape') setContent(null); };
    const scroll = () => setContent(null);
    root.addEventListener('mouseover', over);
    root.addEventListener('mousemove', move, { passive: true });
    root.addEventListener('mouseleave', leave);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', blur);
    root.addEventListener('scroll', scroll, { capture: true, passive: true });
    document.addEventListener('keydown', key);
    return () => {
      root.removeEventListener('mouseover', over);
      root.removeEventListener('mousemove', move);
      root.removeEventListener('mouseleave', leave);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', blur);
      root.removeEventListener('scroll', scroll, true);
      document.removeEventListener('keydown', key);
    };
  }, [rootRef, api, schedule]);

  return (
    <TipCtx.Provider value={api}>
      {children}
      <div ref={el} className={`tip ${content ? 'on' : ''}`} role="tooltip" aria-hidden={!content}>{content}</div>
    </TipCtx.Provider>
  );
}

// Toast
function ToastProvider({ children }) {
  const [t, setT] = useState({ msg: '', bad: false, on: false });
  const timer = useRef(null);
  const toast = useCallback((msg, bad = false) => {
    clearTimeout(timer.current);
    setT({ msg, bad, on: true });
    timer.current = setTimeout(() => setT((p) => ({ ...p, on: false })), bad ? 3600 : 2200);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      <ToastStateCtx.Provider value={t}>{children}</ToastStateCtx.Provider>
    </ToastCtx.Provider>
  );
}

// rendered inside the .icq root so the scoped styles apply
function ToastOutlet() {
  const t = useContext(ToastStateCtx);
  return (
    <div className={`toast ${t.on ? 'on' : ''} ${t.bad ? 'bad' : ''}`} role="status" aria-live="polite">
      {t.msg && <Icon name={t.bad ? 'alert' : 'check'} />}
      <span>{t.on ? t.msg : ''}</span>
    </div>
  );
}

// Skeleton
const Skel = ({ h = 16, w = '100%', r, style }) => (
  <div className="skel" aria-hidden="true" style={{ height: h, width: w, borderRadius: r, ...style }} />
);

const Card = ({ children, style }) => <div className="card" style={{ padding: 20, ...style }}>{children}</div>;

function OverviewSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }} aria-hidden="true">
      <div className="hero">
        <Skel h={172} w={172} r="50%" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Skel h={22} w={160} r={999} />
          <Skel h={34} w="70%" />
          <Skel h={14} w="92%" />
          <Skel h={14} w="80%" />
          <div className="gsplit"><Skel h={84} style={{ flex: 1 }} r={14} /><Skel h={84} style={{ flex: 1 }} r={14} /></div>
        </div>
        <div className="start"><Skel h={18} w={110} /><Skel h={58} r={13} style={{ marginTop: 14 }} /><Skel h={58} r={13} style={{ marginTop: 8 }} /><Skel h={58} r={13} style={{ marginTop: 8 }} /></div>
      </div>
      <div className="kpis">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="kpi" key={i}><Skel h={11} w="60%" /><Skel h={28} w="45%" style={{ marginTop: 10 }} /><Skel h={11} w="80%" style={{ marginTop: 8 }} /><Skel h={30} style={{ marginTop: 8 }} /></div>
        ))}
      </div>
      <div className="grid-a">
        <Card><Skel h={18} w="40%" /><Skel h={12} w="70%" style={{ marginTop: 8 }} /><Skel h={300} style={{ marginTop: 18 }} r={12} /></Card>
        <Card><Skel h={18} w="50%" /><Skel h={60} r={14} style={{ marginTop: 18 }} /><Skel h={60} r={14} style={{ marginTop: 10 }} /><Skel h={64} r={12} style={{ marginTop: 22 }} /></Card>
      </div>
      <div className="grid-b">
        <Card><Skel h={18} w="60%" /><Skel h={12} r={999} style={{ marginTop: 18 }} />{[0, 1, 2, 3].map((i) => <Skel key={i} h={62} r={14} style={{ marginTop: 10 }} />)}</Card>
        <Card><Skel h={18} w="40%" /><Skel h={340} r={12} style={{ marginTop: 18 }} /></Card>
      </div>
      <Card><Skel h={18} w="30%" />{[0, 1, 2, 3, 4].map((i) => <Skel key={i} h={58} r={13} style={{ marginTop: 10 }} />)}</Card>
    </div>
  );
}

function KpiSkeleton({ n = 4 }) {
  return (
    <div className={`kpis ${n === 4 ? 'k4' : ''}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div className="kpi" key={i}><Skel h={11} w="60%" /><Skel h={28} w="40%" style={{ marginTop: 10 }} /><Skel h={11} w="70%" style={{ marginTop: 8 }} /></div>
      ))}
    </div>
  );
}

function RuleRowsSkeleton({ n = 6 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <Skel key={i} h={62} r={13} style={{ marginTop: 8 }} />)}
    </div>
  );
}

function RailSkeleton() {
  return (
    <div aria-hidden="true">
      {[3, 3, 4, 1, 5].map((n, s) => (
        <div className="facet" key={s}>
          <Skel h={10} w="40%" style={{ marginBottom: 10 }} />
          {Array.from({ length: n }, (_, i) => <Skel key={i} h={22} style={{ marginTop: 8 }} />)}
        </div>
      ))}
    </div>
  );
}

function TableRowsSkeleton({ rows = 8, cols = 9 }) {
  return Array.from({ length: rows }, (_, i) => (
    <tr key={i} aria-hidden="true">
      {Array.from({ length: cols }, (_, j) => (
        <td key={j}><Skel h={j === 3 ? 30 : 12} w={j === 0 ? 9 : j === cols - 1 ? 0 : '80%'} /></td>
      ))}
    </tr>
  ));
}

function HistorySkeleton() {
  return (
    <div className="tl" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="tli" key={i}><span className="pt" /><div className="box"><Skel h={13} w="55%" /><Skel h={11} w="35%" style={{ marginTop: 8 }} /></div></div>
      ))}
    </div>
  );
}

// EmptyState
function EmptyState({ icon = 'search', tone = 'grey', title, text, action }) {
  const colors = tone === 'green' ? ['var(--green-soft)', 'var(--green)'] : ['var(--tint)', 'var(--faint)'];
  return (
    <div className="empty">
      <span className="eb" style={{ background: colors[0], color: colors[1] }}><Icon name={icon} /></span>
      <h4>{title}</h4>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

// ErrorState
// full card for when the page has nothing to show
function ErrorCard({ error, onRetry, title = "Couldn't load IND/CTA data", children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="errcard rise" role="alert">
      <span className="eb" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><Icon name="alert" /></span>
      <div style={{ flex: '1 1 300px', minWidth: 0 }}>
        <h3>{title}</h3>
        <p>{error?.message || 'Something went wrong.'}</p>
        <div className="row gap8" style={{ flexWrap: 'wrap' }}>
          {onRetry && <Btn className="primary" onClick={onRetry}><Icon name="refresh" />Try again</Btn>}
          {children}
          <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide details' : 'Show details'}</button>
        </div>
        {open && (
          <pre>{`Status: ${error?.status || 'no response'}\nDetail: ${error?.detail || error?.message || '-'}`}</pre>
        )}
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <div className="errcard rise" role="alert" style={{ borderColor: 'var(--line2)' }}>
      <span className="eb" style={{ background: 'var(--tint)', color: 'var(--body)' }}><Icon name="lock" /></span>
      <div style={{ flex: '1 1 300px', minWidth: 0 }}>
        <h3>You don't have access to this page</h3>
        <p>IND/CTA Data Quality needs the <b>{PERMISSION_LABEL}</b> permission. Ask a SmartHub admin to add it to your role.</p>
      </div>
    </div>
  );
}

function InlineError({ error, onRetry, title = "Couldn't load this" }) {
  return (
    <div className="inline-err" role="alert">
      <span className="eb"><Icon name="alert" /></span>
      <h4>{title}</h4>
      <p>{error?.message || 'Something went wrong.'}</p>
      {onRetry && <Btn className="sm" onClick={onRetry}><Icon name="refresh" />Retry</Btn>}
    </div>
  );
}

function Banner({ tone = 'amber', icon = 'alert', children, action, onClose }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'red' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>{children}</div>
      {action}
      {onClose && <button type="button" className="x" onClick={onClose} aria-label="Dismiss"><Icon name="close" /></button>}
    </div>
  );
}

// one broken view should never take the whole page down
class ViewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, key: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('IND/CTA DQ view crashed', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="errcard" role="alert">
          <span className="eb" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><Icon name="alert" /></span>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <h3>This view hit a problem</h3>
            <p>The rest of the page still works. {String(this.state.error?.message || '')}</p>
            <Btn className="primary" onClick={() => this.setState((s) => ({ error: null, key: s.key + 1 }))}><Icon name="refresh" />Reload this view</Btn>
          </div>
        </div>
      );
    }
    return <div key={this.state.key} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}

// SqlModal
const KW = new Set('select from where and or not in is null as with on join left group by order having limit offset union all distinct case when then else end asc desc nulls last true false ilike qualify over partition grouping sets'.split(' '));
const FN = new Set('count count_if min max avg median sum any_value iff coalesce dateadd datediff date_trunc current_timestamp current_date random row_number to_timestamp_ntz left'.split(' '));
const TOKEN = /(--.*$)|('(?:[^']|'')*')|("[^"]*")|(\b\d+\b)|(:\w+)|([A-Za-z_][A-Za-z0-9_$]*)/g;

function highlight(line) {
  const out = [];
  let last = 0, m, i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [t, com, str, id, num, bind, word] = m;
    let style = null;
    if (com) style = { color: C.faint, fontStyle: 'italic' };
    else if (str) style = { color: C.green };
    else if (id) style = { color: C.blue };
    else if (num || bind) style = { color: C.violet };
    else if (KW.has(word.toLowerCase())) style = { color: C.red, fontWeight: 700 };
    else if (FN.has(word.toLowerCase())) style = { color: C.orange };
    out.push(style ? <span key={i++} style={style}>{t}</span> : t);
    last = m.index + t.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function SqlModal({ query, runAs, onClose, scroller }) {
  const box = useRef(null);
  const toast = useToast();
  useDialog(box, { open: !!query, scroller, initial: '[data-close]' });
  const lines = useMemo(() => String(query?.sql || '').split('\n'), [query]);
  if (!query) return null;

  const role = runAs?.role, wh = runAs?.warehouse;
  const use = [role && `USE ROLE ${role};`, wh && `USE WAREHOUSE ${wh};`].filter(Boolean).join('\n');
  const copy = async (text, what) => toast((await copyText(text)) ? `${what} copied` : 'Could not copy', false);
  const steps = ['Open a Snowflake worksheet', role ? `Switch to role ${role}` : 'Use a role that can read the IND/CTA view', 'Paste it and click Run'];

  return (
    <div className="modal">
      <div className="veil" onClick={onClose} />
      <div className="mbox" ref={box} role="dialog" aria-modal="true" aria-labelledby="icq-sql-title" tabIndex={-1}>
        <div style={{ height: 3, background: C.blue }} />
        <div style={{ padding: '18px 22px 14px', display: 'flex', gap: 14, alignItems: 'flex-start', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: C.blueSoft, color: C.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name="sql" size={17} /></span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="eyebrow">How this is pulled</div>
            <h3 id="icq-sql-title" style={{ fontSize: 17, marginTop: 3 }}>{query.title || 'SQL'}</h3>
            {query.note && <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--body)', lineHeight: 1.5 }}>{query.note}</p>}
          </div>
          <Btn className="icon sm" data-close onClick={onClose} aria-label="Close"><Icon name="close" size={11} /></Btn>
        </div>
        <div className="row gap8" style={{ padding: '10px 22px', background: 'var(--soft)', borderBottom: '1px solid var(--line)', fontSize: 12, flexWrap: 'wrap' }}>
          {role && <span className="pill" style={{ background: '#fff', border: '1px solid var(--line)', color: 'var(--body)' }}>Role <b style={{ color: 'var(--text)' }}>{role}</b></span>}
          {wh && <span className="pill" style={{ background: '#fff', border: '1px solid var(--line)', color: 'var(--body)' }}>Warehouse <b style={{ color: 'var(--text)' }}>{wh}</b></span>}
          <span className="grow" />
          {use && <Btn className="sm" onClick={() => copy(use, 'USE ROLE')}>Copy USE ROLE</Btn>}
          <Btn className="primary sm" onClick={() => copy(query.sql, 'SQL')}><Icon name="sql" size={12} />Copy SQL</Btn>
        </div>
        <div className="mbody">
          <pre aria-label="SQL">
            {lines.map((l, i) => (
              <div key={i}><span className="ln">{i + 1}</span>{highlight(l)}{l ? '' : ' '}</div>
            ))}
          </pre>
        </div>
        <div className="row gap12 steps" style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', background: 'var(--soft)', fontSize: 12.5, color: 'var(--body)', flexWrap: 'wrap' }}>
          {steps.map((t, i) => <span key={t} className="row gap8"><b>{i + 1}</b>{t}</span>)}
        </div>
      </div>
    </div>
  );
}

// Drawer
const Diff = ({ tokens, cls }) => tokens.map((t, i) => (t.same ? t.t : <mark key={i} className={cls}>{t.t}</mark>));

// Pull one issue together from whatever we have: the row it was opened from,
// the rule it belongs to and its real history rows.
function buildIssue(target, fromRow, rule, versions) {
  const v = versions || [];
  const cur = v.find((x) => x.DB_IS_CURRENT === true || x.DB_IS_CURRENT === 'true');
  const latest = cur || v[0] || {};
  const s = fromRow || {};
  const firstSeen = s.FIRST_SEEN || v.reduce((m, x) => (!m || (x.DL_CREATED_DATE && x.DL_CREATED_DATE < m) ? x.DL_CREATED_DATE : m), null);
  const known = versions != null;
  const status = known ? (cur ? 'OPEN' : 'RESOLVED') : s.STATUS || (s.NAME_SIMILARITY_SCORE != null ? 'OPEN' : null);
  const pick = (k) => (latest[k] ?? s[k] ?? null);
  return {
    pk: target.pk,
    rule: target.rule,
    status,
    name: s.DQ_NAME || latest.DQ_NAME || rule?.name || '',
    description: s.DQ_DESCRIPTION || latest.DQ_DESCRIPTION || rule?.description || '',
    group: s.DQ_GROUP || latest.DQ_GROUP || rule?.group || '',
    detail: latest.DQ_DATA_DETAIL || s.DQ_DATA_DETAIL || '',
    conf: pick('DQ_CONFIDENCE_REASON'),
    ns: pick('NAME_SIMILARITY_SCORE'),
    ss: pick('SEMANTIC_SIMILARITY_SCORE'),
    ov: pick('WORD_OVERLAP_RATIO'),
    ed: pick('EDIT_DISTANCE'),
    firstSeen,
    resolvedAt: s.RESOLVED_AT || (known && !cur ? v[0]?.DB_ROW_END_DATE : null),
    updated: s.DL_LAST_UPDATED_DATE || latest.DL_LAST_UPDATED_DATE || null,
  };
}

function explain(it, items) {
  if (it.conf === 'CLOSE MATCH') return { tone: C.green, soft: C.greenSoft, icon: 'check', h: 'Same thing, written differently', p: 'Both systems describe the same item. Only casing, spacing or punctuation differs.', n: 'Likely fix: align the JNJ value to the EMA SMS spelling.' };
  if (it.conf === 'POSSIBLE MATCH') {
    return Number(it.ns) > Number(it.ss)
      ? { tone: C.orange, soft: C.orangeSoft, icon: 'alert', h: 'Spelling is close, meaning shifts', p: 'The values look alike but something meaningful changed, such as strength, salt form or dose form.', n: 'Likely fix: confirm the correct value with the regulatory source before changing.' }
      : { tone: C.orange, soft: C.orangeSoft, icon: 'info', h: 'Same meaning, other words', p: 'The wording differs, for example a synonym or an abbreviation, but both point to the same thing.', n: 'Likely fix: use the controlled term from EMA SMS.' };
  }
  if (it.conf === 'CLEAR MISMATCH') return { tone: C.red, soft: C.redSoft, icon: 'alert', h: 'These are two different things', p: 'The JNJ value and the EMA SMS value do not describe the same item.', n: 'Likely fix: a data steward decides which side is right and corrects the other.' };
  const labels = items.map((x) => (x.label || x.left?.label || '').toLowerCase()).join(' ');
  if (items.some((x) => x.type === 'single' && isNullish(x.value))) return { tone: C.blue, soft: C.blueSoft, icon: 'info', h: 'A required value is empty', p: 'IND/CTA has no value for this field on the record.', n: 'Likely fix: fill it in at the source system. It will clear on the next load.' };
  if (/\bunit/.test(labels)) return { tone: C.blue, soft: C.blueSoft, icon: 'info', h: 'Unit is not in the controlled list', p: 'The unit used here is not one of the allowed units.', n: 'Likely fix: pick the matching unit from the allowed list.' };
  if (/duplicate/.test(labels)) return { tone: C.violet, soft: C.violetSoft, icon: 'info', h: 'Looks like a duplicate', p: 'Another record appears to describe the same thing.', n: 'Likely fix: merge the records or mark them as distinct.' };
  return { tone: C.body, soft: C.tint, icon: 'info', h: 'The rule flagged this record', p: it.description || 'The values below did not pass the rule.', n: 'Likely fix: check the values below against the source system.' };
}

// Half-circle gauge with the value sitting inside the arc. A zero still shows a
// red stub at the start of the track, so it reads as "lowest", not "missing".
function Gauge({ label, value, help, format, max = 1, invert }) {
  const has = value != null && Number.isFinite(Number(value));
  const frac = has ? Math.max(0, Math.min(1, Number(value) / max)) : 0;
  const good = invert ? 1 - frac : frac;
  const col = !has ? C.line : good >= 0.85 ? C.green : good >= 0.6 ? C.orange : C.red;
  const R = 40, len = Math.PI * R;
  const arc = `M${54 - R},50 A${R},${R} 0 0 1 ${54 + R},50`;
  const shown = has ? Math.max(good, 0.015) : 0;
  return (
    <div className="gauge" title={has ? undefined : 'No score for this issue'}>
      <div className="gwrap">
        <svg width="108" height="56" viewBox="0 0 108 56" aria-hidden="true">
          <path d={arc} fill="none" stroke={C.tint} strokeWidth="8" strokeLinecap="round" />
          {has && <path className="draw" d={arc} fill="none" stroke={col} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${len * shown} ${len}`} style={{ '--c': len * shown }} />}
        </svg>
        <div className="gv num" style={{ color: has ? C.text : C.faint }}>{has ? format(Number(value)) : '-'}</div>
      </div>
      <div className="gl">{label}</div>
      <div className="gh">{help}</div>
    </div>
  );
}

function Timeline({ versions, it }) {
  const list = versions;
  return (
    <div className="tl">
      {it.status === 'RESOLVED' && (
        <div className="tli fixed">
          <span className="pt" />
          <div className="box">
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}><b className="green">Fixed</b><span className="faint">{shortDate(it.resolvedAt)}</span></div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>The rule stopped finding this issue in the next load.</div>
          </div>
        </div>
      )}
      {list.map((v, i) => {
        const cur = v.DB_IS_CURRENT === true || v.DB_IS_CURRENT === 'true';
        const older = list[i + 1];
        const note = !older ? 'First raised' : older.DQ_DATA_DETAIL !== v.DQ_DATA_DETAIL ? 'Value changed, still failing' : 'Seen again, still failing';
        const by = v.DL_UPDATED_BY || v.DL_CREATED_BY;
        return (
          <div className={`tli ${cur ? 'cur' : ''}`} key={v.DB_UUID || `${v.DB_ROW_START_DATE}-${i}`}>
            <span className="pt" />
            <div className="box">
              <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, gap: 8, flexWrap: 'wrap' }}>
                <b>{cur ? 'Current version' : `Version ${list.length - i}`}</b>
                <span className="faint">{shortDate(v.DB_ROW_START_DATE)} → {cur || !v.DB_ROW_END_DATE ? 'now' : shortDate(v.DB_ROW_END_DATE)}</span>
              </div>
              <div className="row gap12" style={{ fontSize: 12, color: 'var(--faint)', marginTop: 4, flexWrap: 'wrap' }}>
                <span>{note}</span>
                {by && <span>by {by}</span>}
                {v.DQ_CONFIDENCE_REASON && <ConfPill value={v.DQ_CONFIDENCE_REASON} small />}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Drawer({ target, fromRow, rule, history, nav, onClose, onSql, groupColor, now, scroller, modalOpen }) {
  const box = useRef(null);
  const toast = useToast();
  const open = !!target;
  useDialog(box, { open, scroller, initial: '[data-close]' });

  const versions = history?.data?.versions || null;
  const it = useMemo(() => (target ? buildIssue(target, fromRow, rule, versions) : null), [target, fromRow, rule, versions]);
  const items = useMemo(() => pairDetail(parseDetail(it?.detail)), [it]);

  // back to the top whenever a different issue shows
  useEffect(() => { if (box.current) box.current.scrollTop = 0; }, [target?.pk, target?.rule]);

  // ← → step through the list, unless a modal is on top or the user is typing
  useEffect(() => {
    if (!open || !nav) return undefined;
    const key = (e) => {
      if (modalOpen || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.target.closest?.('input,select,textarea')) return;
      if (e.key === 'ArrowRight' && nav.hasNext) { e.preventDefault(); nav.next(); }
      if (e.key === 'ArrowLeft' && nav.hasPrev) { e.preventDefault(); nav.prev(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, nav, modalOpen]);

  if (!it) return null;

  const isOpen = it.status === 'OPEN';
  const known = it.status != null;
  const gc = groupColor(it.group);
  const ex = explain(it, items);
  const took = daysBetween(it.firstSeen, it.resolvedAt || now);
  const copy = async (text, what) => toast((await copyText(text)) ? `${what} copied` : 'Could not copy', false);
  const headerReady = !!(it.name || it.description || fromRow);
  const hasScores = it.ns != null || it.ss != null;

  return (
    <>
      <div className="veil" onClick={onClose} />
      <aside ref={box} className="drawer" role="dialog" aria-modal="true" aria-labelledby="icq-drawer-title" tabIndex={-1}
        style={{ '--accent': !known ? C.line2 : isOpen ? C.red : C.green }}>
        <div className="dh">
          <div className="row gap8" style={{ flexWrap: 'wrap' }}>
            {known && (
              <span className={`status-pill ${isOpen ? 'open' : 'good'}`}><i />{isOpen ? 'Open' : `Fixed ${it.resolvedAt ? relTime(it.resolvedAt, now) : ''}`}</span>
            )}
            <RuleChip id={it.rule} />
            {it.group && <GroupPill group={it.group} color={gc} />}
            <span className="grow" />
            {nav && (
              <span className="navbtns">
                <Btn className="icon sm" onClick={nav.prev} disabled={!nav.hasPrev} aria-label="Previous issue"><Icon name="chev-l" size={10} /></Btn>
                <span className="num" aria-live="polite">{fmt(nav.index)} of {fmt(nav.total)}</span>
                <Btn className="icon sm" onClick={nav.next} disabled={!nav.hasNext} aria-label="Next issue"><Icon name="chev-r" size={10} /></Btn>
              </span>
            )}
            <Btn className="icon sm" data-close onClick={onClose} aria-label="Close"><Icon name="close" size={11} /></Btn>
          </div>
          {headerReady ? (
            <>
              <h2 id="icq-drawer-title">{it.name || it.rule}</h2>
              {it.description && <p>{it.description}</p>}
            </>
          ) : (
            <>
              <h2 id="icq-drawer-title" className="sr">Issue {it.pk}</h2>
              <Skel h={22} w="70%" style={{ marginTop: 14 }} /><Skel h={13} w="90%" style={{ marginTop: 8 }} />
            </>
          )}
          <div className="meta">
            <div><div className="k">Source PK</div><button type="button" className="v num" onClick={() => copy(it.pk, 'Source PK')} data-tip="Copy Source PK">{it.pk}<Icon name="sql" /></button></div>
            {it.firstSeen && <div><div className="k">First seen</div><div className="v">{shortDate(it.firstSeen)}</div></div>}
            {took != null && known && <div><div className="k">{isOpen ? 'Open for' : 'Took'}</div><div className="v">{plural(Math.max(1, Math.round(took)), 'day')}</div></div>}
            {it.updated && <div><div className="k">Last updated</div><div className="v" data-tip={toDate(it.updated)?.toLocaleString('en-US')}>{relTime(it.updated, now)}</div></div>}
          </div>
        </div>

        <div className="db">
          {hasScores && (
            <div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <div className="sec-t" style={{ margin: 0 }}>Match scores <Qmark tip="Scores run from 0 to 1. Higher means more alike. Edits is the number of characters you would need to change." /></div>
                {it.conf && <ConfPill value={it.conf} />}
              </div>
              <div className="gauges">
                <Gauge label="Spelling" value={it.ns} help="how alike the letters are" format={(v) => v.toFixed(2)} />
                <Gauge label="Meaning" value={it.ss} help="how alike the meaning is" format={(v) => v.toFixed(2)} />
                <Gauge label="Shared words" value={it.ov} help="words found in both" format={(v) => pct(v)} />
                <Gauge label="Edits" value={it.ed} help="characters to change, fewer is closer" format={(v) => fmt(v)} max={25} invert />
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div>
              <div className="sec-t">What differs {items.some((x) => x.type === 'pair') && <span>· highlighted words are the ones that do not match</span>}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map((x, i) => {
                  if (x.type === 'pair') {
                    const [a, b] = wordDiff(x.left.value, x.right.value);
                    return (
                      <div className="cmp" key={`p${i}`}>
                        <div className="side" style={{ '--acc': C.red }}><div className="sl"><span className="red">JNJ</span>{stripSide(x.left.label)}</div><div className="sv">{isNullish(x.left.value) ? <span className="miss">missing</span> : <Diff tokens={a} cls="a" />}</div></div>
                        <span className="vs">vs</span>
                        <div className="side" style={{ '--acc': C.blue }}><div className="sl"><span style={{ color: C.blue }}>EMA SMS</span>{stripSide(x.right.label)}</div><div className="sv">{isNullish(x.right.value) ? <span className="miss">missing</span> : <Diff tokens={b} cls="b" />}</div></div>
                      </div>
                    );
                  }
                  const miss = isNullish(x.value);
                  return (
                    <div className="side" key={`s${i}`} style={{ '--acc': miss ? C.red : C.line2 }}>
                      <div className="sl">{x.label || 'Detail'}</div>
                      <div className="sv">{miss ? <span className="miss">missing</span> : x.value}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {it.detail || versions ? (
            <div className="plain" style={{ '--tone-soft': ex.soft }}>
              <span className="pi" style={{ color: ex.tone }}><Icon name={ex.icon} /></span>
              <div>
                <div className="sec-t" style={{ margin: '0 0 4px', color: ex.tone }}>What this means</div>
                <h4>{ex.h}</h4><p>{ex.p}</p><div className="next"><b>{ex.n}</b></div>
              </div>
            </div>
          ) : <Skel h={96} r={16} />}

          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
              <div className="sec-t" style={{ margin: 0 }}>History{versions ? ` · ${plural(versions.length, 'version')}` : ''}</div>
              <SqlButton query={history?.data?.sql} onOpen={onSql} />
            </div>
            {history?.error ? (
              <InlineError error={history.error} onRetry={history.reload} title="Couldn't load the history" />
            ) : versions ? (
              versions.length ? <Timeline versions={versions} it={it} /> : <p className="muted" style={{ fontSize: 13 }}>No history rows came back for this issue.</p>
            ) : <HistorySkeleton />}
          </div>

          <div className="row gap8" style={{ flexWrap: 'wrap' }}>
            <Btn onClick={() => copy(it.pk, 'Source PK')}><Icon name="sql" size={13} />Copy Source PK</Btn>
            <Btn onClick={() => copy(window.location.href, 'Link')}><Icon name="link" size={13} />Copy link to this issue</Btn>
            <span className="grow" />
            <span className="faint" style={{ fontSize: 12 }}>Tip: use ← → to move between issues, Esc to close</span>
          </div>
        </div>
      </aside>
    </>
  );
}

// FlowChart
// One outlier week (the first full load, usually) would flatten every other bar,
// so the scale tops out a bit above the second biggest week instead.
function capFor(vals) {
  const s = [...vals].sort((a, b) => b - a), top = s[0] || 0, next = s[1] || 0;
  return top > 20 && top > Math.max(next, 1) * 4 ? Math.max(next * 1.3, 4) : Math.max(top, 1);
}
function niceStep(max) {
  const raw = max / 3, p = 10 ** Math.floor(Math.log10(raw || 1)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const TipBody = ({ d }) => (
  <>
    <b>Week of {weekLabel(d.week)}</b>
    <div className="tr"><span><i style={{ background: C.red }} />New</span><b>{fmt(d.new)}</b></div>
    <div className="tr"><span><i style={{ background: C.green }} />Fixed</span><b>{fmt(d.resolved)}</b></div>
    <div className="tr"><span><i style={{ background: C.blue }} />Still open</span><b>{fmt(d.backlog)}</b></div>
  </>
);

function FlowChart({ data: all }) {
  const box = useRef(null);
  const width = useWidth(box);
  const tip = useTip();
  const W = Math.max(width, 300), H = 300;

  // weeks before tracking started are all zero: leave them out instead of
  // drawing an empty stretch with the backlog line lying on the floor
  const data = useMemo(() => {
    const first = (all || []).findIndex((d) => d.new || d.resolved || d.backlog > 0);
    return first > 0 && all.length - first >= 2 ? all.slice(first) : all;
  }, [all]);
  const trimmed = (all?.length || 0) > (data?.length || 0);

  const g = useMemo(() => {
    if (!data?.length) return null;
    const pad = { l: 44, r: 58, t: 26, b: 30 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const capN = capFor(data.map((d) => d.new)), capF = capFor(data.map((d) => d.resolved));
    const share = Math.max(0.22, Math.min(0.5, capF / (capN + capF)));
    const mid = pad.t + ih * (1 - share), upH = mid - pad.t, dnH = pad.t + ih - mid;
    const hN = (v) => (Math.min(v, capN) / capN) * upH, hF = (v) => (Math.min(v, capF) / capF) * dnH;
    const bl = data.map((d) => d.backlog), bMax = Math.max(...bl), bMin = Math.min(...bl);
    // the scale is at least 10% of the backlog tall, so a move of 86 on 13,563
    // shows as the small change it is instead of a cliff
    const span = Math.max(bMax - bMin, Math.abs(bMax) * 0.1, 5);
    // the backlog line lives above the zero line, so it never reads as negative
    const lo = (bMax + bMin) / 2 - span * 0.65, hi = (bMax + bMin) / 2 + span * 0.65, yTop = pad.t + 10, yBot = mid - 12;
    const yB = (v) => yBot - ((v - lo) / (hi - lo)) * (yBot - yTop);
    const bw = iw / data.length, x = (i) => pad.l + i * bw + bw / 2, bwi = Math.max(3, Math.min(22, bw * 0.58));
    const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yB(d.backlog).toFixed(1)}`).join(' ');
    const step = niceStep(capN), ticks = [];
    for (let v = step; v <= capN; v += step) ticks.push(v);
    // fixed side gets its own scale below the line, at most 2 labels in the smaller band
    let stepF = niceStep(capF);
    while (capF / stepF > 2) stepF *= 2;
    const ticksF = [];
    for (let v = stepF; v <= capF + 1e-9; v += stepF) ticksF.push(v);
    const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 74))));
    const clipped = data.filter((d) => d.new > capN || d.resolved > capF);
    return { pad, iw, ih, capN, capF, mid, hN, hF, bMax, bMin, yB, bw, x, bwi, path, ticks, ticksF, every, clipped };
  }, [data, W]);

  const totals = useMemo(() => (data || []).reduce((a, d) => ({ n: a.n + d.new, f: a.f + d.resolved }), { n: 0, f: 0 }), [data]);

  if (!data?.length) {
    return <div ref={box} className="note" style={{ minHeight: 120, alignItems: 'center', justifyContent: 'center' }}><Icon name="info" /><span>No weekly activity in this window yet.</span></div>;
  }

  const { pad, ih, capN, capF, mid, hN, hF, bMax, bMin, yB, bw, x, bwi, path, ticks, ticksF, every, clipped } = g;
  const ax = { fontSize: 10.5, fill: C.faint };
  const last = data.length - 1;
  const label = `Weekly new and fixed issues over ${data.length} weeks: ${fmt(totals.n)} new, ${fmt(totals.f)} fixed, ${fmt(data[last].backlog)} still open now.`;

  return (
    <div ref={box} className="chartbox" style={{ marginTop: 8 }}>
      <svg width={W} height={H} style={{ display: 'block' }} role="img" aria-label={label} data-rich-tip
        onMouseLeave={() => tip.hide()}>
        <defs>
          <linearGradient id="icqBk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.blue} stopOpacity=".12" />
            <stop offset="1" stopColor={C.blue} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={mid - hN(v)} y2={mid - hN(v)} stroke={C.line} strokeDasharray="2 4" />
            <text x={pad.l - 8} y={mid - hN(v) + 3.5} textAnchor="end" {...ax} fill={C.red}>{fmt(v)}</text>
          </g>
        ))}
        {ticksF.map((v) => (
          <g key={`f${v}`}>
            <line x1={pad.l} x2={W - pad.r} y1={mid + hF(v)} y2={mid + hF(v)} stroke={C.line} strokeDasharray="2 4" />
            <text x={pad.l - 8} y={mid + hF(v) + 3.5} textAnchor="end" {...ax} fill={C.green}>{fmt(v)}</text>
          </g>
        ))}
        {data.length > 1 && <path d={`${path} L${x(last)},${mid} L${x(0)},${mid} Z`} fill="url(#icqBk)" />}
        <line x1={pad.l} x2={W - pad.r} y1={mid} y2={mid} stroke={C.line2} />
        <text x={pad.l - 8} y={mid + 3.5} textAnchor="end" {...ax}>0</text>
        <text x={W - pad.r + 8} y={yB(bMax) + 4} fontSize="11" fontWeight="700" fill={C.blue}>{fmt(bMax)}</text>
        {bMax !== bMin && <text x={W - pad.r + 8} y={Math.max(yB(bMin), yB(bMax) + 15) + 4} fontSize="11" fill={C.blue}>{fmt(bMin)}</text>}
        {data.map((d, i) => {
          const up = hN(d.new), dn = hF(d.resolved);
          const origin = { transformOrigin: `${x(i)}px ${mid}px`, animationDelay: `${i * 18}ms` };
          return (
            <g key={d.week} className="wk"
              onMouseEnter={(e) => tip.show(<TipBody d={d} />, e.clientX, e.clientY)}
              onMouseMove={(e) => tip.move(e.clientX, e.clientY)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} className="hov" fill="transparent" />
              {d.new > 0 && <rect className="growy" x={x(i) - bwi / 2} y={mid - Math.max(up, 1.5)} width={bwi} height={Math.max(up, 1.5)} rx="3" fill={C.red} opacity=".88" style={origin} />}
              {d.resolved > 0 && <rect className="growy" x={x(i) - bwi / 2} y={mid} width={bwi} height={Math.max(dn, 1.5)} rx="3" fill={C.green} opacity=".85" style={origin} />}
              {d.new > capN && (
                <>
                  <path d={`M${x(i) - bwi / 2 - 2},${pad.t + 12} l${bwi / 2 + 2},-4 l${bwi / 2 + 2},4`} fill="none" stroke="#fff" strokeWidth="3" />
                  <text x={x(i)} y={pad.t - 8} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={C.red}>{fmt(d.new)}</text>
                </>
              )}
              {d.resolved > capF && <path d={`M${x(i) - bwi / 2 - 2},${pad.t + ih - 12} l${bwi / 2 + 2},4 l${bwi / 2 + 2},-4`} fill="none" stroke="#fff" strokeWidth="3" />}
              {i % every === 0 && <text x={x(i)} y={H - 8} textAnchor="middle" {...ax}>{weekLabel(d.week)}</text>}
            </g>
          );
        })}
        {data.length > 1 && (
          <>
            <path d={path} fill="none" stroke="#fff" strokeWidth="6" strokeLinejoin="round" opacity=".9" pointerEvents="none" />
            <path className="draw" d={path} fill="none" stroke={C.blue} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" pathLength="1" strokeDasharray="1" style={{ '--c': 1, animationDuration: '1.5s' }} pointerEvents="none" />
          </>
        )}
        <circle cx={x(last)} cy={yB(data[last].backlog)} r="4.5" fill="#fff" stroke={C.blue} strokeWidth="2.2" pointerEvents="none" />
      </svg>
      {trimmed && (
        <div className="note"><Icon name="info" /><span>Tracking started the week of {weekLabel(data[0].week)}, so the empty weeks before it are left out.</span></div>
      )}
      {clipped.length > 0 && (
        <div className="note"><Icon name="info" /><span>The week of {weekLabel(clipped[0].week)} is far bigger than the rest, so its bar is cut off to keep the other weeks readable. Hover it for the exact count.</span></div>
      )}
      <div className="sr">
        <table>
          <caption>Issues per week</caption>
          <thead><tr><th>Week of</th><th>New</th><th>Fixed</th><th>Still open</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.week}><td>{weekLabel(d.week)}</td><td>{d.new}</td><td>{d.resolved}</td><td>{d.backlog}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

// MatchMap
const QUADS = [
  { x0: 0.8, x1: 1, y0: 0.75, y1: 1, label: 'Formatting only', c: C.green, at: 'br' },
  { x0: 0, x1: 0.8, y0: 0.75, y1: 1, label: 'Same meaning, other words', c: C.blue, at: 'tl' },
  { x0: 0.8, x1: 1, y0: 0, y1: 0.75, label: 'Looks close, meaning drifts', c: C.orange, at: 'br' },
  { x0: 0, x1: 0.8, y0: 0, y1: 0.75, label: 'Real mismatch', c: C.red, at: 'bl' },
];

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const keyOf = (p) => p.DQ_CONFIDENCE_REASON || 'NONE';

function DotTip({ p }) {
  const pair = pairDetail(parseDetail(p.DQ_DATA_DETAIL)).find((z) => z.type === 'pair');
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}><b>{p.SOURCE_PK}</b><span className="faint">{ruleLabel(p.DQ_IDENTIFIER)}</span></div>
      {pair && (
        <>
          <div style={{ marginTop: 4 }}><b style={{ color: C.red }}>A</b> {pair.left.value}</div>
          <div><b style={{ color: C.blue }}>B</b> {pair.right.value}</div>
        </>
      )}
      <div className="faint" style={{ marginTop: 5 }}>spelling {num(p.NAME_SIMILARITY_SCORE).toFixed(2)} · meaning {num(p.SEMANTIC_SIMILARITY_SCORE).toFixed(2)}</div>
      <div style={{ color: C.red, fontWeight: 700, marginTop: 4 }}>Click to open</div>
    </>
  );
}

function MatchMap({ points, onPick }) {
  const box = useRef(null);
  const width = useWidth(box);
  const tip = useTip();
  const [hidden, setHidden] = useState(() => new Set());

  const pts = useMemo(() => (points || []).filter((p) => num(p.NAME_SIMILARITY_SCORE) != null && num(p.SEMANTIC_SIMILARITY_SCORE) != null), [points]);
  const counts = useMemo(() => pts.reduce((m, p) => { m[keyOf(p)] = (m[keyOf(p)] || 0) + 1; return m; }, {}), [pts]);
  const keys = useMemo(() => {
    const k = confKeys(Object.keys(counts));
    return counts.NONE ? [...k, 'NONE'] : k;
  }, [counts]);
  const shown = useMemo(() => pts.filter((p) => !hidden.has(keyOf(p))), [pts, hidden]);

  const W = Math.max(width, 300), H = 340, pad = { l: 46, r: 16, t: 16, b: 42 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x = (v) => pad.l + Math.max(0, Math.min(1, v)) * iw;
  const y = (v) => pad.t + ih - Math.max(0, Math.min(1, v)) * ih;

  const toggle = (k) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (!pts.length) {
    return <div ref={box} className="note" style={{ minHeight: 120, alignItems: 'center', justifyContent: 'center' }}><Icon name="info" /><span>No open issues carry name scores right now.</span></div>;
  }

  const label = `Scatter of ${fmt(pts.length)} open issues by spelling and meaning similarity. ${keys.map((k) => `${confOf(k).label} ${fmt(counts[k] || 0)}`).join(', ')}.`;

  return (
    <div>
      <div className="toggles">
        {keys.map((k) => {
          const c = confOf(k), off = hidden.has(k);
          return (
            <button key={k} type="button" className={`tg ${off ? 'off' : ''}`} aria-pressed={!off} data-k={k} onClick={() => toggle(k)}
              style={{ background: c.c, color: '#fff', borderColor: c.c }}>
              <i style={{ background: '#fff' }} />{c.label} · {fmt(counts[k] || 0)}
            </button>
          );
        })}
        <span className="faint" style={{ fontSize: 12, marginLeft: 'auto' }}>Click a band to hide it</span>
      </div>
      <div ref={box} className="chartbox">
        <svg width={W} height={H} style={{ display: 'block' }} role="img" aria-label={label} data-rich-tip onMouseLeave={() => tip.hide()}>
          {QUADS.map((q) => <rect key={q.label} x={x(q.x0)} y={y(q.y1)} width={x(q.x1) - x(q.x0)} height={y(q.y0) - y(q.y1)} fill={q.c} opacity=".045" rx="4" pointerEvents="none" />)}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t} pointerEvents="none">
              <line x1={x(t)} x2={x(t)} y1={pad.t} y2={pad.t + ih} stroke={C.line} strokeDasharray="2 4" />
              <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke={C.line} strokeDasharray="2 4" />
              <text x={x(t)} y={H - 24} textAnchor="middle" fontSize="10" fill={C.faint}>{t}</text>
              <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill={C.faint}>{t}</text>
            </g>
          ))}
          <text x={pad.l + iw / 2} y={H - 5} textAnchor="middle" fontSize="11" fontWeight="700" fill={C.muted} pointerEvents="none">Spelling similarity  →</text>
          <text transform={`translate(13 ${pad.t + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fontWeight="700" fill={C.muted} pointerEvents="none">Meaning similarity  →</text>
          <g className="fadein">
          {shown.map((p) => {
            const c = confOf(p.DQ_CONFIDENCE_REASON);
            return (
              <circle key={`${p.SOURCE_PK}|${p.DQ_IDENTIFIER}`} className="mdot" cx={x(num(p.NAME_SIMILARITY_SCORE))} cy={y(num(p.SEMANTIC_SIMILARITY_SCORE))} r="4.4"
                fill={c.c} fillOpacity=".45" stroke="#fff" strokeWidth=".8"
                onMouseEnter={(e) => tip.show(<DotTip p={p} />, e.clientX, e.clientY)}
                onMouseMove={(e) => tip.move(e.clientX, e.clientY)}
                onClick={() => { tip.hide(); onPick(p, shown); }} />
            );
          })}
          </g>
          {QUADS.map((q) => (
            <text key={`l${q.label}`} x={q.at[1] === 'r' ? x(q.x1) - 8 : x(q.x0) + 8} y={q.at[0] === 't' ? y(q.y1) + 15 : y(q.y0) - 8}
              textAnchor={q.at[1] === 'r' ? 'end' : 'start'} fontSize="11" fontWeight="700" fill={q.c} stroke="#fff" strokeWidth="3" paintOrder="stroke" pointerEvents="none">{q.label}</text>
          ))}
        </svg>
      </div>
      {!shown.length && <div className="note" style={{ justifyContent: 'center' }}><Icon name="info" /><span>All bands are hidden. Click a band above to show its dots again.</span></div>}
    </div>
  );
}

// Rules
function ConfCell({ r }) {
  if (!r.scored) return <span className="faint" style={{ fontSize: 11.5 }} data-tip="This rule checks for missing or invalid values, so there is nothing to score.">Not scored</span>;
  const parts = confKeys(Object.keys(r.confidence || {})).map((k) => ({ n: r.confidence[k], c: confOf(k).c, label: confOf(k).label }));
  if (!parts.some((p) => p.n > 0)) return <span className="faint" style={{ fontSize: 11.5 }}>No open scored issues</span>;
  return <StackBar parts={parts} height={8} />;
}

function RuleRows({ list, full, colors, onOpen, showSpark }) {
  const max = Math.max(1, ...list.map((r) => r.open));
  return (
    <div>
      {full ? (
        <div className="rhead" aria-hidden="true">
          <span /><span>Rule</span><span style={{ textAlign: 'right' }}>Open</span><span className="hide-md">Progress</span>
          <span className="hide-sm">Match confidence</span><span className="hide-md">{showSpark ? '12-week trend' : ''}</span><span />
        </div>
      ) : (
        <div className="rhead" aria-hidden="true">
          <span /><span>Rule</span><span style={{ textAlign: 'right' }}>Open</span><span className="hide-sm">Match confidence</span><span className="hide-sm" style={{ textAlign: 'right' }}>Fix rate</span>
        </div>
      )}
      {list.map((r, i) => {
        const gc = colors.color(r.group);
        const tot = r.open + r.resolved;
        return (
          <Clickable key={r.id} className="rrow rise" style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }} onClick={() => onOpen(r)}
            aria-label={`${ruleLabel(r.id)} ${r.name}: ${fmt(r.open)} open. View issues`}>
            <span className={`rk num ${i < 3 && r.open ? 'top' : ''}`}>{String(i + 1).padStart(2, '0')}</span>
            <div style={{ minWidth: 0 }}>
              {/* ID on the left, centred on the name and description, which sit under each other */}
              <div className="rmain">
                <RuleChip id={r.id} />
                <div className="rtext">
                  <span className="rname" title={r.name}>{r.name}</span>
                  {/* the Rules tab already shows one group at a time, so the group pill only appears on the mixed Overview list */}
                  {(!full || r.description) && (
                    <div className="row gap8" style={{ marginTop: 4, minWidth: 0 }}>{!full && <GroupPill group={r.group} color={gc} />}{r.description && <span className="rdesc" title={r.description}>{r.description}</span>}</div>
                  )}
                </div>
              </div>
              {!full && <div className="minibar" style={{ height: 5 }}><span className="growx" style={{ width: `${(r.open / max) * 100}%`, background: C.red, opacity: 0.85 }} /></div>}
            </div>
            <div>
              <div className="rbig num">{fmt(r.open)}</div>
              <div className="rsmall" style={{ color: r.new_7d ? C.red : C.faint }}>{r.new_7d ? `+${fmt(r.new_7d)} this week` : 'no new'}</div>
            </div>
            {full ? (
              <>
                <div className="hide-md">
                  <div className="row" style={{ fontSize: 11.5 }}>
                    <b className={(r.fix_rate || 0) >= 0.5 ? 'green' : ''}>{pct(r.fix_rate)}</b><span className="faint" style={{ marginLeft: 6 }}>fixed</span>
                    <span className="grow" /><span className="faint num">{fmt(r.resolved)}/{fmt(tot)}</span>
                  </div>
                  <div className="minibar"><span className="growx" style={{ width: `${(r.fix_rate || 0) * 100}%`, background: C.green }} /></div>
                </div>
                <div className="hide-sm"><ConfCell r={r} /></div>
                <div className="hide-md" style={{ height: 30 }}>
                  {showSpark && <Spark values={r.spark} color={gc} label={`New issues per week for ${ruleLabel(r.id)}, last 12 weeks: ${(r.spark || []).join(', ')}`} />}
                </div>
                <div style={{ textAlign: 'right' }}><span className="rviewbtn">View issues <Icon name="chev-r" /></span></div>
              </>
            ) : (
              <>
                <div className="hide-sm"><ConfCell r={r} /></div>
                <div className="hide-sm" style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: (r.fix_rate || 0) >= 0.5 ? C.green : C.body }}>{pct(r.fix_rate)}</div>
                  <div className="rsmall">{fmt(r.resolved)} fixed</div>
                </div>
              </>
            )}
          </Clickable>
        );
      })}
    </div>
  );
}

const SORTERS = {
  open: (a, b) => b.open - a.open,
  new: (a, b) => (b.new_7d || 0) - (a.new_7d || 0) || b.open - a.open,
  fix: (a, b) => (b.fix_rate ?? -1) - (a.fix_rate ?? -1),
  id: (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
};

const Rules = memo(function Rules({ m, rq, rgroup, rsort, setRules, go, onSql, sql }) {
  const [text, setText] = useState(rq);
  const input = useRef(null);
  const timer = useRef(null);
  useEffect(() => { setText(rq); }, [rq]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const groupNames = m.groupOrder;
  const group = groupNames.includes(rgroup) ? rgroup : (groupNames[0] || '');
  const list = useMemo(() => {
    const q = rq.toLowerCase();
    return m.rules
      .filter((r) => (!group || r.group === group) && (!q || `${r.id} ${ruleLabel(r.id)} ${r.name} ${r.description || ''}`.toLowerCase().includes(q)))
      .sort((a, b) => SORTERS[rsort](a, b) || String(a.id).localeCompare(String(b.id)));
  }, [m.rules, rq, group, rsort]);

  const clean = m.rules.filter((r) => !r.open).length;
  const onType = (v) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRules({ rq: v.trim() }, true), 200);
  };
  const perGroup = groupNames.map((g) => `${fmt(m.rules.filter((r) => r.group === g).length)} ${groupLabel(g).toLowerCase()}`).join(' · ');

  return (
    <>
      <section className="kpis k4">
        <Kpi label="Rules running" value={m.totalRules} icon="shield" color={C.violet} bg={C.violetSoft} sub={perGroup} delay={0} />
        <Kpi label="Rules with open issues" value={m.activeRules} icon="alert" color={C.red} bg={C.redSoft} sub={`${plural(clean, 'rule')} fully clean`} delay={50} />
        <Kpi label="Rules with no fixes yet" value={m.stuckCount} icon="timer" color={C.orange} bg={C.orangeSoft} sub="worth a conversation with the owner" delay={100} />
        <Kpi label="Name rules scored" value={m.scoredRules.length} icon="filter" color={C.green} bg={C.greenSoft} sub="compare JNJ with EMA SMS" delay={150} />
      </section>
      <section className="card rise rules-full" id="icq-rules">
        <div className="card-h">
          <span className="badge" style={{ background: C.violetSoft, color: C.violet }}><Icon name="shield" /></span>
          <div className="grow"><h3>Every IND/CTA rule</h3><p>What each rule checks, how much it is finding, and how fast its issues get fixed. Click a rule to see its issues.</p></div>
          <div className="card-a"><SqlButton query={sql} onOpen={onSql} /></div>
        </div>
        <div className="card-b">
          <div className="toolbar">
            <div className="search">
              <Icon name="search" />
              <input ref={input} value={text} onChange={(e) => onType(e.target.value)} placeholder="Search rules by ID, name or description" aria-label="Search rules" />
              {text && <button type="button" className="clr" aria-label="Clear search" onClick={() => { setText(''); clearTimeout(timer.current); setRules({ rq: '' }, true); input.current?.focus(); }}><Icon name="close" /></button>}
            </div>
            {groupNames.length > 1 && <Seg label="Group" value={group} onChange={(v) => setRules({ rgroup: v === groupNames[0] ? '' : v }, true)} options={groupNames.map((g) => [g, groupLabel(g)])} />}
            <span className="grow" />
            <span className="faint" style={{ fontSize: 12 }}>Sort by</span>
            <Seg label="Sort" value={rsort} onChange={(v) => setRules({ rsort: v }, true)} options={[['open', 'Most open'], ['new', 'Newest'], ['fix', 'Best fix rate'], ['id', 'Rule ID']]} />
          </div>
          <div style={{ marginTop: 14 }} aria-live="polite" className="sr">{plural(list.length, 'rule')} shown</div>
          {list.length ? (
            <RuleRows list={list} full colors={m.colors} showSpark={m.hasSpark} onOpen={(r) => go({ rule: r.id, group: r.group || '' })} />
          ) : (
            <EmptyState title={m.rules.length ? 'No rules match' : 'No rules yet'} text={m.rules.length ? 'Try a different search or group.' : 'The IND/CTA view has no rule results yet.'} />
          )}
        </div>
      </section>
    </>
  );
});

// Overview
// "In the last 4 weeks ..." Says how much the backlog moved in issues, and adds
// the percent only when it rounds to at least 1%, so it never reads "up 0%".
function BacklogLine({ m }) {
  const { fixed4: f, new4: n, backlogDiff: d } = m;
  if (!f && !n) return <>Nothing was fixed and nothing new came in during the last 4 weeks.</>;
  const share = d && m.backlogChange != null ? Math.abs(m.backlogChange) : 0;
  return (
    <>
      In the last 4 weeks the team fixed <b>{fmt(f)}</b> {f === 1 ? 'issue' : 'issues'} while <b>{fmt(n)}</b> new {n === 1 ? 'one' : 'ones'} came in
      {d === 0 && <>, so the backlog <b>did not change</b></>}
      {d != null && d !== 0 && (
        <>, so the backlog <b className={d < 0 ? 'green' : 'red'}>{d < 0 ? 'shrank' : 'grew'} by {fmt(Math.abs(d))}</b>
          {share >= 0.005 && <> ({d < 0 ? 'down' : 'up'} {pct(share)})</>}</>
      )}.
    </>
  );
}

function Hero({ m, go, onSql, sql }) {
  const { k, top, stuck, closeCount, state, colors } = m;
  const actions = [
    top && { key: 'top', f: { rule: top.id, group: top.group || '' }, icon: 'alert', c: C.red, bg: C.redSoft, t: 'Biggest hotspot', m: top.name, s: `${ruleLabel(top.id)} · ${fmt(top.open)} open · ${pct(top.open / Math.max(1, m.open))} of backlog` },
    closeCount > 0 && { key: 'quick', f: { conf: 'CLOSE MATCH' }, icon: 'check', c: C.green, bg: C.greenSoft, t: 'Quick wins', m: plural(closeCount, 'close match', 'close matches'), s: 'Only formatting differs. Fast to clear.' },
    stuck && { key: 'stuck', f: { rule: stuck.id, group: stuck.group || '' }, icon: 'timer', c: C.orange, bg: C.orangeSoft, t: 'Stuck rule', m: stuck.name, s: `${ruleLabel(stuck.id)} · ${fmt(stuck.open)} open, nothing fixed yet` },
  ].filter(Boolean);

  return (
    <section className={`hero rise ${actions.length ? '' : 'noaside'}`} id="icq-hero">
      <span className="blob b1" aria-hidden="true" /><span className="blob b2" aria-hidden="true" /><span className="blob b3" aria-hidden="true" />
      <Ring value={m.fixRate} fixed={m.resolved} total={m.total} />
      <div style={{ minWidth: 0 }}>
        <div className="row gap8" style={{ flexWrap: 'wrap' }}>
          <span className="eyebrow red">Right now</span>
          {state && (
            <span className={`status-pill ${state}`} data-tip="Compares fixes with new issues over the last 4 weeks." tabIndex={0}>
              <Icon name={state === 'good' ? 'check' : 'alert'} />{state === 'good' ? 'Improving' : state === 'bad' ? 'Needs attention' : 'Holding steady'}
            </span>
          )}
          <span className="grow" />
          <SqlButton query={sql} onOpen={onSql} label="View SQL for these numbers" />
        </div>
        <h2 className="hero-h"><em className="num"><CountUp value={m.open} /></em> open issues across <span className="num">{fmt(k.affected_records)}</span> IND/CTA records</h2>
        {m.trend.length > 0 && (
          <p className="hero-p">
            <BacklogLine m={m} />
            {top && <> The biggest hotspot is <b>{top.name}</b> with {plural(top.open, 'open issue')}, {pct(top.open / Math.max(1, m.open))} of all open issues.</>}
          </p>
        )}
        {m.groups.length > 0 && (
          <div className="gsplit" id="icq-gsplit">
            {m.groups.map((g) => {
              const tot = g.open + g.resolved;
              const col = colors.color(g.group);
              return (
                <button key={g.group} type="button" className="gcard" onClick={() => go({ group: g.group })} aria-label={`See open ${g.group} issues`}>
                  <span className="gname"><i style={{ background: col }} />{g.group}</span>
                  <span className="gnum num" style={{ display: 'block' }}>{fmt(g.open)} <span>open</span></span>
                  <span className="gsub" style={{ display: 'block' }}><span>{plural(g.rules, 'rule')}</span> · <span>{fmt(g.resolved)} fixed</span> · <span>{pct(tot ? g.resolved / tot : null)} done</span></span>
                  <span className="gbar">
                    <span className="growx" style={{ width: `${tot ? (g.resolved / tot) * 100 : 0}%`, background: C.green, animationDelay: '.3s' }} />
                    <span className="growx" style={{ width: `${tot ? (g.open / tot) * 100 : 0}%`, background: col, opacity: 0.75, animationDelay: '.3s' }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {actions.length > 0 && (
        <aside className="start" id="icq-start">
          <div className="start-h"><Icon name="outcomes" size={15} />Start here</div>
          <div className="start-sub">{actions.length === 1 ? 'The place where an hour of work moves the numbers most.' : `${actions.length === 2 ? 'Two' : 'Three'} places where an hour of work moves the numbers most.`}</div>
          {actions.map((a) => (
            <button key={a.key} type="button" className="act" data-act={a.key} onClick={() => go(a.f)}>
              <span className="n" style={{ background: a.bg, color: a.c }}><Icon name={a.icon} /></span>
              <span style={{ minWidth: 0 }}>
                <span className="t" style={{ display: 'block' }}>{a.t}</span>
                <span className="m" style={{ display: 'block' }}>{a.m}</span>
                <span className="s" style={{ display: 'block' }}>{a.s}</span>
              </span>
              <span className="go"><Icon name="chev-r" /></span>
            </button>
          ))}
        </aside>
      )}
    </section>
  );
}

function Kpis({ m }) {
  const { k, last12, colors } = m;
  const age = m.aging;
  const medFix = k.median_days_to_fix;
  return (
    <section className="kpis" id="icq-kpis">
      <Kpi label="Open issues" value={m.open} icon="alert" color={C.red} bg={C.redSoft} tone={C.red} delay={60}
        sub={m.total ? `${pct(m.open / m.total)} of everything ever raised` : ''} tip="Issues a rule raised that are still present in the latest IND/CTA load.">
        {last12.length > 1 && <div className="sp"><Spark values={last12.map((w) => w.backlog)} color={C.red} label="Open issues at the end of each of the last 12 weeks" /></div>}
      </Kpi>
      <Kpi label="New this week" value={k.new_7d} icon="time" color={C.orange} bg={C.orangeSoft} delay={110}
        sub={<Delta now={k.new_7d} prev={k.new_prev_7d} upIsBad label="vs last week" />} tip="Issues first seen in the last 7 days, compared with the 7 days before.">
        {last12.length > 1 && <div className="sp"><Spark values={last12.map((w) => w.new)} color={C.orange} label="New issues per week, last 12 weeks" /></div>}
      </Kpi>
      <Kpi label="Fixed · 30 days" value={k.resolved_30d} icon="check" color={C.green} bg={C.greenSoft} tone={C.green} delay={160}
        sub={k.resolved_prev_30d != null ? <Delta now={k.resolved_30d} prev={k.resolved_prev_30d} label="vs prior 30d" /> : ''}
        tip="Issues that stopped showing up in the last 30 days. An issue counts as fixed when the rule no longer finds it.">
        {last12.length > 1 && <div className="sp"><Spark values={last12.map((w) => w.resolved)} color={C.green} label="Fixed issues per week, last 12 weeks" /></div>}
      </Kpi>
      <Kpi label="Records affected" value={k.affected_records} icon="records" color={C.blue} bg={C.blueSoft} delay={210}
        sub={k.affected_records ? `${(m.open / k.affected_records).toFixed(1)} issues per record` : ''} tip="Distinct source records (Source PK) with at least one open issue.">
        {m.hasGroupRecords && (
          <div className="sp bars"><StackBar height={8} parts={m.groups.map((g) => ({ n: g.affected_records, c: colors.color(g.group), label: `${g.group} records` }))} /></div>
        )}
      </Kpi>
      <Kpi label="Rules firing" value={m.activeRules} icon="shield" color={C.violet} bg={C.violetSoft} delay={260}
        sub={`of ${fmt(m.totalRules)} rules · ${fmt(m.stuckCount)} with no fixes yet`} tip="Rules that currently have at least one open issue.">
        {m.totalRules > 0 && <div className="sp bars"><StackBar height={8} parts={[{ n: m.activeRules, c: C.violet, label: 'Firing' }, { n: m.totalRules - m.activeRules, c: C.line2, label: 'Clean' }]} /></div>}
      </Kpi>
      <Kpi label="Avg open age" value={k.avg_age_days} suffix="days" icon="timer" color={C.body} bg={C.tint} delay={310}
        sub={medFix != null ? `median fix takes ${plural(Math.round(medFix), 'day')}` : ''}
        tip="How long open issues have been waiting, on average. The median fix time is measured on fixed issues.">
        {age && <div className="sp bars"><StackBar height={8} parts={age.map((b) => ({ n: b.count, c: ageOf(b.bucket)?.c || C.faint, label: ageOf(b.bucket)?.label || b.bucket }))} /></div>}
      </Kpi>
    </section>
  );
}

function Backlog({ m, go, onSql, sql }) {
  const { groups, colors, aging, k } = m;
  const ageMax = aging ? Math.max(1, ...aging.map((b) => b.count)) : 1;
  const old = aging?.find((b) => b.bucket === '90+');
  return (
    <div className="card rise" id="icq-groups" style={{ animationDelay: '240ms' }}>
      <div className="card-h">
        <span className="badge" style={{ background: C.blueSoft, color: C.blue }}><Icon name="db" /></span>
        <div className="grow"><h3>Where the backlog sits</h3><p>Open issues by data group{aging ? ', and how long they have been waiting' : ''}.</p></div>
        <div className="card-a"><SqlButton query={sql.group_records || sql.rules} onOpen={onSql} /></div>
      </div>
      <div className="card-b">
        {groups.length ? (
          <div className="glist">
            {groups.map((g) => (
              <Clickable key={g.group} className="grow-item" onClick={() => go({ group: g.group })} aria-label={`${g.group}: ${fmt(g.open)} open. See issues`}>
                <span className="sw" style={{ background: colors.soft(g.group), color: colors.color(g.group) }}>{String(g.group || '?')[0]}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row"><b style={{ fontSize: 13.5 }}>{g.group}</b><span className="grow" /><b className="num" style={{ fontFamily: 'var(--fd)', fontSize: 17 }}>{fmt(g.open)}</b></div>
                  <div className="minibar"><span className="growx" style={{ width: `${m.open ? (g.open / m.open) * 100 : 0}%`, background: colors.color(g.group) }} /></div>
                  <div className="row" style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 5, gap: 6, flexWrap: 'wrap' }}>
                    <span>{pct(m.open ? g.open / m.open : null)} of open · {plural(g.rules, 'rule')}{g.affected_records != null ? ` · ${plural(g.affected_records, 'record')}` : ''}</span>
                    <span className="grow" /><span className="green">{fmt(g.resolved)} fixed</span>
                  </div>
                </div>
              </Clickable>
            ))}
          </div>
        ) : <p className="muted" style={{ fontSize: 13 }}>No groups in the data yet.</p>}
        {aging && (
          <>
            <div className="subhead">How old are open issues <Qmark tip="Age is counted from the first time a rule raised the issue. Click a bucket to see those issues." /></div>
            <div className="aging">
              {AGES.map((a) => {
                const n = aging.find((b) => b.bucket === a.key)?.count || 0;
                return (
                  <button key={a.key} type="button" className="age" onClick={() => go({ age: a.key })} aria-label={`${fmt(n)} open issues waiting ${a.label}`}>
                    <div className="al">{a.label}</div>
                    <div className="av num">{fmt(n)}</div>
                    <div className="ab" style={{ background: a.c, opacity: 0.35 + (0.65 * n) / ageMax }} />
                  </button>
                );
              })}
            </div>
            {m.open > 0 && old && (
              <div className="note"><Icon name="info" /><span>
                {pct(old.count / m.open)} of open issues are older than 90 days.
                {k.first_load_open != null && k.first_load && <> {fmt(k.first_load_open)} of them came in with the first full load on {shortDate(k.first_load)}.</>}
              </span></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Confidence({ m, go, onSql, sql }) {
  const { scoredKeys, confMap, scoredTotal } = m;
  const unscored = Math.max(0, m.open - scoredTotal);
  const unscoredRules = m.rules.length - m.scoredRules.length;
  return (
    <div className="card rise" id="icq-conf" style={{ animationDelay: '280ms' }}>
      <div className="card-h">
        <span className="badge" style={{ background: C.greenSoft, color: C.green }}><Icon name="filter" /></span>
        <div className="grow"><h3>How sure are the name matches?</h3><p>{plural(m.scoredRules.length, 'rule')} compare JNJ values with EMA SMS. Each band tells you how much effort a fix is likely to take.</p></div>
        <div className="card-a"><SqlButton query={sql} onOpen={onSql} /></div>
      </div>
      <div className="card-b">
        {scoredKeys.length > 0 && <StackBar parts={scoredKeys.map((key) => ({ n: confMap[key] || 0, c: confOf(key).c, label: confOf(key).label }))} />}
        {scoredKeys.map((key) => {
          const c = confOf(key), n = confMap[key] || 0;
          return (
            <Clickable key={key} className="band" data-k={key} onClick={() => go({ conf: key })} aria-label={`${c.label}: ${fmt(n)} open. Review`}>
              <span className="bar" style={{ background: c.c }} />
              <div style={{ minWidth: 0 }}>
                <div className="bt"><ConfPill value={key} small /><span>{c.short}</span></div>
                {c.fix && <div className="bf">Typical fix: {c.fix}</div>}
              </div>
              <div className="bn"><b className="num">{fmt(n)}</b><span>{pct(scoredTotal ? n / scoredTotal : null)} · review <Icon name="chev-r" /></span></div>
            </Clickable>
          );
        })}
        <Clickable className="band dashed" onClick={() => go({ conf: 'NONE' })} aria-label={`Not scored: ${fmt(unscored)} open. Review`}>
          <span className="bar" style={{ background: C.line2 }} />
          <div style={{ minWidth: 0 }}>
            <div className="bt"><ConfPill value={null} small /><span>Missing or invalid values</span></div>
            <div className="bf">{plural(unscoredRules, 'rule')} check for empty or invalid fields, so there is nothing to compare.</div>
          </div>
          <div className="bn"><b className="num">{fmt(unscored)}</b><span>open · review <Icon name="chev-r" /></span></div>
        </Clickable>
      </div>
    </div>
  );
}

const Overview = memo(function Overview({ m, summary, weeks, setWeeks, go, setTab, onSql, onPick, now, cacheSeconds, weeksBusy }) {
  const sql = summary.sql || {};
  return (
    <>
      <Hero m={m} go={go} onSql={onSql} sql={sql.kpis} />
      <Kpis m={m} />
      <section className="grid-a">
        <div className="card rise" id="icq-flow" style={{ animationDelay: '200ms' }}>
          <div className="card-h">
            <span className="badge" style={{ background: C.redSoft, color: C.red }}><Icon name="chart" /></span>
            <div className="grow"><h3>Is the backlog shrinking?</h3><p>Red bars are new issues, green bars are fixes. The blue line is what is still open at the end of each week.</p></div>
            <div className="card-a">
              <Seg label="Weeks" value={weeks} onChange={setWeeks} options={[[12, '12 weeks'], [26, '26 weeks'], [52, '52 weeks']]} />
              <SqlButton query={sql.trend} onOpen={onSql} />
            </div>
          </div>
          <div className="card-b dim" style={{ opacity: weeksBusy ? 0.6 : undefined }} aria-busy={weeksBusy || undefined}>
            <div className="legend"><span><i style={{ background: C.red }} />New</span><span><i style={{ background: C.green }} />Fixed</span><span><i className="ln" style={{ background: C.blue }} />Still open</span></div>
            <FlowChart data={m.trend} />
          </div>
        </div>
        <Backlog m={m} go={go} onSql={onSql} sql={sql} />
      </section>
      <section className="grid-b">
        <Confidence m={m} go={go} onSql={onSql} sql={sql.rules} />
        <div className="card rise" id="icq-map" style={{ animationDelay: '320ms' }}>
          <div className="card-h">
            <span className="badge" style={{ background: C.violetSoft, color: C.violet }}><Icon name="search" /></span>
            <div className="grow"><h3>Name match map</h3><p>Each dot is one open issue. Right means similar spelling, up means similar meaning. Click a dot to inspect it.</p></div>
            <div className="card-a"><SqlButton query={sql.scatter} onOpen={onSql} /></div>
          </div>
          <div className="card-b"><MatchMap points={summary.scatter} onPick={onPick} /></div>
        </div>
      </section>
      <section className="card rise" id="icq-hotspots" style={{ animationDelay: '360ms' }}>
        <div className="card-h">
          <span className="badge" style={{ background: C.redSoft, color: C.red }}><Icon name="alert" /></span>
          <div className="grow"><h3>Rule hotspots</h3><p>The {m.byOpen.length >= 5 ? 'five rules' : plural(m.byOpen.length, 'rule')} holding the most open issues. Click a rule to see its issues.</p></div>
          <div className="card-a"><Btn className="sm" onClick={() => setTab('rules')} data-tab="rules">See all {fmt(m.totalRules)} rules <Icon name="chev-r" size={9} /></Btn></div>
        </div>
        <div className="card-b">
          {m.byOpen.length
            ? <RuleRows list={m.byOpen.slice(0, 5)} colors={m.colors} onOpen={(r) => go({ rule: r.id, group: r.group || '' })} />
            : <p className="muted" style={{ fontSize: 13 }}>No rules have raised issues yet.</p>}
        </div>
      </section>
      <div className="foot">
        <span>
          Numbers built {relTime(summary.generated_at, now)}{summary.elapsed_ms != null ? ` in ${fmt(summary.elapsed_ms)} ms` : ''}
          {cacheSeconds ? `, cached for ${minutes(cacheSeconds)}` : ''}. Use Refresh for live numbers.
        </span>
      </div>
    </>
  );
});

// Issues
const DAYS_OPTS = [['', 'Any time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];
const COLS = 9;

function Opt({ on, onPick, label, count, dot, showCount = true }) {
  return (
    <button type="button" role="radio" className="opt" aria-checked={on} onClick={onPick}>
      <span className="rb" />{dot && <i className="dot" style={{ background: dot }} />}<span>{label}</span>
      {showCount && <span className="c num">{count == null ? '' : fmt(count)}</span>}
    </button>
  );
}

function Rail({ f, setFilters, facets, m }) {
  const fc = facets.data;
  const counts = (name) => fc?.[name] || {};
  const groups = useMemo(() => {
    // same order as the toggle bar: biggest backlog first
    return [...new Set([...(m?.groupOrder || []), ...Object.keys(fc?.group || {}), f.group].filter(Boolean))];
  }, [m, fc, f.group]);
  const confs = useMemo(() => confKeys([...(m?.scoredKeys || []), ...Object.keys(fc?.confidence || {}), f.conf]), [m, fc, f.conf]);
  const rules = useMemo(() => {
    const byId = new Map((m?.rules || []).map((r) => [r.id, r]));
    Object.keys(fc?.rule || {}).forEach((id) => { if (!byId.has(id)) byId.set(id, { id, name: '', group: '' }); });
    if (f.rule && !byId.has(f.rule)) byId.set(f.rule, { id: f.rule, name: '', group: '' });
    return [...byId.values()].filter((r) => !f.group || !r.group || r.group === f.group || r.id === f.rule)
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }, [m, fc, f.group, f.rule]);
  const show = !!fc;
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  if (!fc && facets.loading) return <aside className="card rail" aria-busy="true"><h4><Icon name="filter" size={14} color={C.red} />Narrow it down</h4><RailSkeleton /></aside>;

  return (
    <aside className="card rail rise" id="icq-rail" aria-label="Filters" aria-busy={facets.loading || undefined}>
      <h4><Icon name="filter" size={14} color={C.red} />Narrow it down</h4>
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>Pick one option per section. Counts update as you go.</div>
      {facets.error && (
        <div className="banner red" style={{ padding: '8px 10px', fontSize: 12 }}>
          <span style={{ flex: 1 }}>Counts did not load. {facets.error.message}</span>
          <button type="button" className="linkbtn" onClick={facets.reload}>Retry</button>
        </div>
      )}
      <div className="facet" role="radiogroup" aria-label="Status">
        <div className="facet-t">Status <Qmark tip="Open: the rule still finds it. Fixed: it stopped showing up in a later load." /></div>
        <Opt on={f.status === 'open'} onPick={() => setFilters({ status: 'open' })} label="Open" dot={C.red} count={counts('status').OPEN || 0} showCount={show} />
        <Opt on={f.status === 'resolved'} onPick={() => setFilters({ status: 'resolved' })} label="Fixed" dot={C.green} count={counts('status').RESOLVED || 0} showCount={show} />
        <Opt on={f.status === 'all'} onPick={() => setFilters({ status: 'all' })} label="Everything" count={sum(counts('status'))} showCount={show} />
      </div>
      <div className="facet" role="radiogroup" aria-label="Data group">
        <div className="facet-t">Data group</div>
        {groups.map((g) => <Opt key={g} on={f.group === g} onPick={() => setFilters({ group: g })} label={groupLabel(g)} dot={m?.colors.color(g)} count={counts('group')[g] || 0} showCount={show} />)}
      </div>
      <div className="facet" role="radiogroup" aria-label="Match confidence">
        <div className="facet-t">Match confidence <Qmark tip="Only name comparison rules are scored. Missing value rules show as Not scored." /></div>
        <Opt on={!f.conf} onPick={() => setFilters({ conf: '' })} label="Any" showCount={false} />
        {confs.map((k) => <Opt key={k} on={f.conf === k} onPick={() => setFilters({ conf: k })} label={confOf(k).label} dot={confOf(k).c} count={counts('confidence')[k] || 0} showCount={show} />)}
        <Opt on={f.conf === 'NONE'} onPick={() => setFilters({ conf: 'NONE' })} label="Not scored" dot={C.line2} count={counts('confidence').NONE || 0} showCount={show} />
      </div>
      <div className="facet">
        <label className="facet-t" htmlFor="icq-rulesel">Rule</label>
        <select id="icq-rulesel" value={f.rule} onChange={(e) => setFilters({ rule: e.target.value })} style={{ width: '100%' }}>
          <option value="">All rules</option>
          {rules.map((r) => (
            <option key={r.id} value={r.id}>{ruleLabel(r.id)}{r.name ? ` · ${r.name}` : ''}{show ? ` (${fmt(counts('rule')[r.id] || 0)})` : ''}</option>
          ))}
        </select>
      </div>
      <div className="facet" role="radiogroup" aria-label="Waiting for">
        <div className="facet-t">Waiting for <Qmark tip="How long ago the issue was first raised." /></div>
        <Opt on={!f.age} onPick={() => setFilters({ age: '' })} label="Any age" showCount={false} />
        {AGES.map((a) => <Opt key={a.key} on={f.age === a.key} onPick={() => setFilters({ age: a.key })} label={a.label} dot={a.c} count={counts('age')[a.key] || 0} showCount={show} />)}
      </div>
      <div className="facet" role="radiogroup" aria-label="First seen">
        <div className="facet-t">First seen</div>
        {DAYS_OPTS.map(([v, l]) => <Opt key={v} on={f.days === v} onPick={() => setFilters({ days: v })} label={l} showCount={false} />)}
      </div>
    </aside>
  );
}

function meterColor(v) { return v >= 0.9 ? C.green : v >= 0.7 ? C.orange : C.red; }
function Meter({ label, v }) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return null;
  return (
    <div className="mm"><span className="t">{label}</span><span className="tr"><span style={{ width: `${Math.max(0, Math.min(1, n)) * 100}%`, background: meterColor(n) }} /></span><b className="num">{n.toFixed(2)}</b></div>
  );
}

function Preview({ detail }) {
  const items = pairDetail(parseDetail(detail));
  const pair = items.find((x) => x.type === 'pair');
  if (pair) {
    const [a, b] = wordDiff(pair.left.value, pair.right.value);
    return (
      <div className="prev">
        <div><span className="tag" style={{ color: C.red, background: C.redSoft }}>JNJ</span>{isNullish(pair.left.value) ? <span className="miss">missing</span> : <Diff tokens={a} cls="a" />}</div>
        <div><span className="tag" style={{ color: C.blue, background: C.blueSoft }}>EMA</span>{isNullish(pair.right.value) ? <span className="miss">missing</span> : <Diff tokens={b} cls="b" />}</div>
        <div className="k">{stripSide(pair.left.label)}</div>
      </div>
    );
  }
  if (!items.length) return <span className="faint">-</span>;
  const head = items.slice(0, items.length > 2 ? 1 : 2);
  return (
    <div className="prev">
      {head.map((x, i) => (
        <div key={i}><span className="faint" style={{ marginRight: 6 }}>{x.label}</span>{isNullish(x.value) ? <span className="miss">missing</span> : x.value}</div>
      ))}
      {items.length > 2 && <div className="k">+{items.length - 1} more fields</div>}
    </div>
  );
}

function Th({ k, label, w, right, f, onSort }) {
  const on = k && f.sort === k;
  return (
    <th style={{ width: w, textAlign: right ? 'right' : undefined }} className={on ? 'on' : ''} aria-sort={on ? (f.dir === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
      {k ? <button type="button" onClick={() => onSort(k)}>{label}{on ? (f.dir === 'desc' ? ' ↓' : ' ↑') : ''}</button> : label}
    </th>
  );
}

const Issues = memo(function Issues({ m, f, setFilters, issues, facets, onOpen, onSql, onExport, exporting, now, searchRef }) {
  const [q, setQ] = useState(f.q);
  const timer = useRef(null);
  const wrap = useRef(null);
  const scroll = useRef(null);
  useEffect(() => { setQ(f.q); }, [f.q]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const data = issues.data;
  const rows = useMemo(() => data?.rows || [], [data]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / f.size));
  const fixedView = f.status === 'resolved';
  const showSkeleton = useDelayed(!data && issues.loading, 150);

  // page ran past the end (old link, or rows got fixed): clamp once we know the total
  useEffect(() => {
    if (data && total > 0 && f.page > pages) setFilters({ page: pages }, { replace: true });
  }, [data, total, pages, f.page, setFilters]);

  // new page: bring the top of the table back into view (the page is the only scroller)
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    const w = wrap.current, main = w?.closest('main');
    if (!w || !main) return;
    const tb = parseFloat(getComputedStyle(w).getPropertyValue('--tb')) || 0;
    const by = w.getBoundingClientRect().top - main.getBoundingClientRect().top - tb - 12;
    if (by < 0) main.scrollBy({ top: by, behavior: 'smooth' });
  }, [f.page, f.size]);

  // prefetch the next page while idle, unless the connection asked us to save data
  useEffect(() => {
    if (!data || f.page >= pages || navigator.connection?.saveData) return undefined;
    const next = issuesUrl({ ...f, page: f.page + 1 });
    if (pageGet(next)) return undefined;
    const ctl = new AbortController();
    const run = () => getJson(next, ctl.signal).then((d) => pagePut(next, d)).catch(() => {});
    const id = window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: 3000 }) : setTimeout(run, 1200);
    return () => {
      ctl.abort();
      if (window.cancelIdleCallback) window.cancelIdleCallback(id); else clearTimeout(id);
    };
  }, [data, f, pages]);

  const shadowFrame = useRef(0);
  const paintShadows = useCallback(() => {
    shadowFrame.current = 0;
    const s = scroll.current, w = wrap.current;
    if (!s || !w) return;
    // fits: no sideways scroll needed, so the header can stick to the page instead
    w.classList.toggle('fits', s.scrollWidth <= s.clientWidth + 1);
    w.classList.toggle('shl', s.scrollLeft > 2);
    w.classList.toggle('shr', s.scrollLeft + s.clientWidth < s.scrollWidth - 2);
  }, []);
  const shadows = useCallback(() => { if (!shadowFrame.current) shadowFrame.current = requestAnimationFrame(paintShadows); }, [paintShadows]);
  useEffect(() => {
    paintShadows();
    // the box also changes width when the app sidebar opens or closes, not only on window resize
    const ro = scroll.current ? new ResizeObserver(shadows) : null;
    if (ro) ro.observe(scroll.current);
    return () => { ro?.disconnect(); cancelAnimationFrame(shadowFrame.current); shadowFrame.current = 0; };
  }, [rows, paintShadows, shadows]);

  const onType = (v) => {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFilters({ q: v.trim() }, { replace: true }), 300);
  };
  const onSort = (k) => setFilters({ sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc', page: 1 });

  const ruleName = m?.ruleById.get(f.rule)?.name;
  const chips = [
    f.rule && ['rule', `Rule: ${ruleLabel(f.rule)}${ruleName ? ` · ${ruleName}` : ''}`],
    f.conf && ['conf', f.conf === 'NONE' ? 'Not scored' : confOf(f.conf).label],
    f.days && ['days', `First seen in last ${f.days} days`],
    f.age && ['age', `Waiting ${AGES.find((a) => a.key === f.age)?.label || f.age}`],
    f.q && ['q', `Search: "${f.q}"`],
  ].filter(Boolean);
  const clearAll = () => setFilters({ rule: '', conf: '', q: '', days: '', age: '' });
  const busy = issues.loading && !!data;
  const start = total ? (f.page - 1) * f.size + 1 : 0;
  const end = Math.min(f.page * f.size, total);
  const sizes = [25, 50, 100, ...(f.size === 250 ? [250] : [])];

  let body;
  if (issues.error && !busy) {
    body = <tr><td colSpan={COLS}><InlineError error={issues.error} onRetry={issues.reload} title="Couldn't load the issues" /></td></tr>;
  } else if (!data) {
    body = showSkeleton ? <TableRowsSkeleton rows={10} cols={COLS} /> : null;
  } else if (!rows.length) {
    body = (
      <tr><td colSpan={COLS}>
        {chips.length ? (
          <EmptyState icon="search" title="No issues match these filters" text="Try removing a filter or widening the date range." action={<Btn className="sm" onClick={clearAll}>Clear all filters</Btn>} />
        ) : f.status === 'open' ? (
          <EmptyState icon="check" tone="green" title="Nothing open here" text="Every rule in this view is currently passing." />
        ) : f.status === 'resolved' ? (
          <EmptyState icon="search" title="No issues have been fixed yet" text="Fixed issues show up here once a rule stops finding them." />
        ) : (
          <EmptyState icon="search" title="Nothing here yet" text="The IND/CTA view has no issues yet." />
        )}
      </td></tr>
    );
  } else {
    body = rows.map((r) => {
      const open = r.STATUS === 'OPEN';
      const when = fixedView ? r.RESOLVED_AT : r.FIRST_SEEN;
      return (
        <tr key={`${r.SOURCE_PK}|${r.DQ_IDENTIFIER}`} className="ir" tabIndex={0} aria-label={`${r.SOURCE_PK}, ${ruleLabel(r.DQ_IDENTIFIER)} ${r.DQ_NAME || ''}, ${open ? 'open' : 'fixed'}. Open details`}
          onClick={() => onOpen(r, rows)}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(r, rows); } }}>
          <td style={{ paddingRight: 0 }}><span className="sdot" style={{ background: open ? C.red : C.green }} data-tip={open ? 'Open' : 'Fixed'} /></td>
          <td className="num" style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.SOURCE_PK}>{r.SOURCE_PK}</td>
          <td>
            <div className="row gap6" style={{ marginBottom: 3 }}><RuleChip id={r.DQ_IDENTIFIER} /></div>
            <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.35, overflowWrap: 'anywhere' }}>{r.DQ_NAME}</div>
          </td>
          <td style={{ maxWidth: 0 }}><Preview detail={r.DQ_DATA_DETAIL} /></td>
          <td>
            {r.NAME_SIMILARITY_SCORE != null || r.SEMANTIC_SIMILARITY_SCORE != null
              ? <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Meter label="spelling" v={r.NAME_SIMILARITY_SCORE} /><Meter label="meaning" v={r.SEMANTIC_SIMILARITY_SCORE} /></div>
              : <span className="faint">-</span>}
          </td>
          <td>{r.DQ_CONFIDENCE_REASON ? <ConfPill value={r.DQ_CONFIDENCE_REASON} small /> : <span className="faint" style={{ fontSize: 12 }}>Not scored</span>}</td>
          <td style={{ whiteSpace: 'nowrap', color: 'var(--body)' }} data-tip={toDate(when)?.toLocaleString('en-US')}>{relTime(when, now)}</td>
          <td className="num" style={{ textAlign: 'right', fontWeight: 700, color: r.VERSIONS > 1 ? C.blue : C.faint }}>{fmt(r.VERSIONS)}</td>
          <td style={{ textAlign: 'right' }}><span className="openhint">Open <Icon name="chev-r" /></span></td>
        </tr>
      );
    });
  }

  // same filter as the rail's Data group, as a quick toggle next to the search
  const groupOpts = useMemo(() => (m?.groupOrder || []).map((g) => [g, groupLabel(g)]), [m]);

  return (
    <div className="iss">
      <Rail f={f} setFilters={setFilters} facets={facets} m={m} />
      <section className="card rise" style={{ animationDelay: '80ms' }} id="icq-table">
        <div className="card-b" style={{ paddingTop: 18 }}>
          <div className="toolbar">
            <div className="search">
              <Icon name="search" />
              <input ref={searchRef} id="icq-iq" value={q} onChange={(e) => onType(e.target.value)} placeholder="Search Source PK, value or rule" aria-label="Search issues" aria-keyshortcuts="/" />
              {q ? <button type="button" className="clr" aria-label="Clear search" onClick={() => { setQ(''); clearTimeout(timer.current); setFilters({ q: '' }, { replace: true }); searchRef.current?.focus(); }}><Icon name="close" /></button> : <span className="kbd" aria-hidden="true">/</span>}
            </div>
            {groupOpts.length > 1 && <Seg label="Data group" value={f.group} onChange={(v) => v !== f.group && setFilters({ group: v })} options={groupOpts} />}
            <div className="tactions">
              <SqlButton query={data?.sql} onOpen={onSql} large />
              <Btn onClick={onExport} disabled={!total || exporting} className={exporting ? 'busy' : ''} aria-busy={exporting || undefined}>
                {exporting ? <span className="spin" /> : <Icon name="download" size={14} />}
                {exporting ? 'Exporting' : `Export ${fmt(total)} to CSV`}
              </Btn>
            </div>
          </div>
          {chips.length > 0 && (
            <div className="chips" id="icq-chips">
              <Icon name="filter" />
              {chips.map(([k, l]) => (
                <button key={k} type="button" className="fchip" onClick={() => setFilters({ [k]: '' })} aria-label={`Remove filter ${l}`}>{l}<Icon name="close" /></button>
              ))}
              <button type="button" className="linkbtn" onClick={clearAll}>Clear all</button>
            </div>
          )}
          <div className="tbl-wrap" ref={wrap}>
            <div className="tbl-scroll" ref={scroll} onScroll={shadows} aria-busy={busy || undefined}>
              <table style={{ opacity: busy ? 0.55 : 1, transition: 'opacity .2s' }}>
                <thead>
                  <tr>
                    <th style={{ width: 20 }}><span className="sr">Status</span></th>
                    <Th k="source_pk" label="Source PK" w={112} f={f} onSort={onSort} />
                    <Th k="rule" label="Rule" w={210} f={f} onSort={onSort} />
                    <Th label="What differs" f={f} />
                    <Th k="name_score" label="Scores" w={150} f={f} onSort={onSort} />
                    <Th k="confidence" label="Confidence" w={124} f={f} onSort={onSort} />
                    <Th k={fixedView ? 'resolved_at' : 'first_seen'} label={fixedView ? 'Fixed' : 'First seen'} w={96} f={f} onSort={onSort} />
                    <Th k="versions" label="Ver" w={48} right f={f} onSort={onSort} />
                    <th style={{ width: 64 }}><span className="sr">Open</span></th>
                  </tr>
                </thead>
                <tbody>{body}</tbody>
              </table>
            </div>
          </div>
          <div className="pager">
            <span aria-live="polite">
              {data ? <><b className="num" style={{ color: 'var(--text)' }}>{fmt(total)}</b> {total === 1 ? 'issue' : 'issues'} · showing {fmt(start)}-{fmt(end)}</> : issues.loading ? 'Loading issues' : ''}
            </span>
            <span className="grow" />
            <label className="row gap6">Rows
              <select value={f.size} onChange={(e) => setFilters({ size: Number(e.target.value) }, { replace: true })}>
                {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <Btn className="icon sm" onClick={() => setFilters({ page: f.page - 1 })} disabled={f.page <= 1} aria-label="Previous page"><Icon name="chev-l" size={11} /></Btn>
            <span className="num">Page <b style={{ color: 'var(--text)' }}>{fmt(Math.min(f.page, pages))}</b> of {fmt(pages)}</span>
            <Btn className="icon sm" onClick={() => setFilters({ page: f.page + 1 })} disabled={!data || f.page >= pages} aria-label="Next page"><Icon name="chev-r" size={11} /></Btn>
          </div>
        </div>
      </section>
    </div>
  );
});

// page shell
// the tour is its own chunk so the page doesn't pay for it until someone presses play
const Tour = lazy(() => import('./IndCtaDataQualityTour'));

// helpers the tour chunk borrows, passed in so it never imports this file back
const TOUR_KIT = { C, confOf, fmt, pct, plural, ruleLabel, DEFAULT_FILTERS, defaultSort, writeFilters, lockScroll, useTip, useToast };

const TITLES = { overview: 'Overview', rules: 'Rules', issues: 'Issue explorer' };

// faint dots and lines behind the top of the page. Positions come from a
// low-discrepancy sequence so they spread evenly and never change between renders.
function NetBg() {
  const box = useRef(null);
  const W = useWidth(box);
  const H = 620;
  const svg = useMemo(() => {
    if (!W) return null;
    const pts = Array.from({ length: Math.round(W / 34) }, (_, i) => {
      const a = ((i + 1) * 0.7548776662466927) % 1, b = ((i + 1) * 0.5698402909980532) % 1, k = ((i + 1) * 0.6180339887) % 1;
      return [a * W, 40 + b * (H - 60), k];
    });
    const lines = [];
    pts.forEach((p, i) => pts.slice(i + 1).forEach((q, j) => {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < 150) lines.push(<line key={`${i}-${j}`} x1={p[0].toFixed(1)} y1={p[1].toFixed(1)} x2={q[0].toFixed(1)} y2={q[1].toFixed(1)} stroke={C.red} strokeOpacity={(0.13 * (1 - d / 150)).toFixed(3)} />);
    }));
    return (
      <svg width={W} height={H}>
        {lines}
        {pts.map(([x, y, k], i) => (
          <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={(1.3 + k * 1.6).toFixed(1)} fill={k < 0.78 ? C.red : k < 0.9 ? C.blue : C.faint}
            style={{ '--d': `${(3 + k * 4).toFixed(1)}s`, '--dl': `${(k * 3).toFixed(1)}s` }} />
        ))}
      </svg>
    );
  }, [W]);
  return <div className="bgnet" ref={box} aria-hidden="true">{svg}</div>;
}

function Tabs({ tab, setTab, m }) {
  const list = [
    ['overview', 'dash', 'Overview', null],
    ['rules', 'shield', 'Rules', m ? <span key="b" className="cnt num" data-tip={m.totalRules >= 1000 ? `${fmt(m.totalRules)} rules` : undefined}>{fmtK(m.totalRules)}</span> : null],
    ['issues', 'alert', <><span className="lg">Issue explorer</span><span className="sm">Issues</span></>, m ? <span key="b" className="cnt warn num" data-tip={`${fmt(m.open)} open issues`}>{fmtK(m.open)}</span> : null],
  ];
  const refs = useRef({});
  const onKey = (e) => {
    const ids = list.map((t) => t[0]);
    const i = ids.indexOf(tab);
    const to = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[e.key];
    if (!to) return;
    e.preventDefault();
    setTab(to);
    refs.current[to]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="Views" onKeyDown={onKey} id="icq-tabs">
      {list.map(([v, icon, label, extra]) => (
        <button key={v} ref={(n) => { refs.current[v] = n; }} type="button" role="tab" id={`icq-tab-${v}`} aria-controls="icq-panel"
          aria-selected={tab === v} tabIndex={tab === v ? 0 : -1} className="tab" data-tab={v} onClick={() => tab !== v && setTab(v)}>
          <Icon name={icon} />{label}{extra}
        </button>
      ))}
    </div>
  );
}

function Page({ onBack }) {
  const root = useRef(null);
  const content = useRef(null);
  const searchRef = useRef(null);
  const [scroller, setScroller] = useState(null);
  const url = useUrlState();
  const { tab, weeks, filters: urlFilters } = url;
  const toast = useToast();
  const now = useNow();
  const online = useOnline();
  // full, lite (no GPU or a weak machine) or min (still dropping frames).
  // Decided by the machine alone; the OS "reduce motion" setting is not used here.
  const tier = useMachineTier();
  const [nonce, setNonce] = useState(0);
  const [offlineSeen, setOfflineSeen] = useState(false);

  // the sticky topbar's height, so the issue table header can stick right under it
  useLayoutEffect(() => {
    const el = root.current, bar = el?.querySelector('.topbar');
    if (!el || !bar) return undefined;
    const set = () => el.style.setProperty('--tb', `${bar.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // the app scrolls inside <main>, not the window
  useLayoutEffect(() => {
    const main = root.current?.closest('main') || document.scrollingElement;
    setScroller(main);
    main?.classList.add('icq-scroller');
    return () => main?.classList.remove('icq-scroller');
  }, []);

  useEffect(() => {
    if (!online) setOfflineSeen(true);
    else if (offlineSeen) { setNonce((n) => n + 1); setOfflineSeen(false); }
  }, [online, offlineSeen]);

  const summary = useSummary(weeks, nonce);
  const status = useResource(STATUS_URL, { nonce });
  const cacheSeconds = status.data?.cache_seconds;
  // the model only cares which day it is, so the minute tick doesn't rebuild every view
  const today = Math.floor(now / 864e5);
  const m = useMemo(() => buildModel(summary.data, summary.forWeeks, Date.now()), [summary.data, summary.forWeeks, today]); // eslint-disable-line react-hooks/exhaustive-deps

  // The explorer always shows one data group. With none in the URL it is the
  // first one (the biggest backlog), so the URL stays clean for the default.
  const firstGroup = m?.groupOrder[0] || '';
  const f = useMemo(() => (urlFilters.group || !firstGroup ? urlFilters : { ...urlFilters, group: firstGroup }), [urlFilters, firstGroup]);

  // so picking a group can drop a rule from another group
  useEffect(() => { url.ruleGroup.current = (id) => m?.ruleById.get(id)?.group || null; }, [m, url.ruleGroup]);

  // drop group / rule / confidence values the data has never heard of
  const { dropParams } = url;
  useEffect(() => {
    if (!m) return;
    const bad = [];
    const groups = new Set([...m.groups.map((g) => g.group), ...m.rules.map((r) => r.group)]);
    if (f.group && groups.size && !groups.has(f.group)) bad.push('group');
    if (f.rule && m.rules.length && f.rule.split(',').some((id) => !m.ruleById.has(id.trim()))) bad.push('rule');
    if (f.conf && f.conf !== 'NONE' && !CONF[f.conf] && !(f.conf in m.confMap)) bad.push('conf');
    if (bad.length) dropParams(bad);
  }, [m, f.group, f.rule, f.conf, dropParams]);

  // issues and facets only load on the explorer
  // wait for the summary first: it decides the default data group, so the
  // explorer never fetches (and flashes) every group before narrowing down
  const onIssues = tab === 'issues' && (!!m || !!summary.error);
  const iUrl = onIssues ? issuesUrl(f) : null;
  const fUrl = onIssues ? facetsUrl(f) : null;
  const issues = useResource(iUrl, { nonce, cacheGet: pageGet, cachePut: pagePut, cacheDrop: pageClear });
  const facets = useResource(fUrl, { nonce });

  // drawer
  const target = useMemo(() => (url.issue && url.irule ? { pk: url.issue, rule: url.irule } : null), [url.issue, url.irule]);
  const history = useResource(target ? historyUrl(target.pk, target.rule) : null, { nonce, keep: false });
  const [ctx, setCtx] = useState({ source: null, list: [] });
  const pending = useRef(null);

  const { openIssue, setFilters, closeIssue } = url;
  const navigate = useNavigate();
  // when we pushed the drawer's history entry, closing steps back off it
  const pushed = useRef(false);
  const open = useRef(false);
  open.current = !!target;
  const { replaceAll } = url;
  const openRow = useCallback((row, list, source = 'table') => {
    setCtx({ source, list });
    if (!open.current) pushed.current = !replaceAll.current;
    openIssue(row.SOURCE_PK, row.DQ_IDENTIFIER, { replace: open.current });
  }, [openIssue, replaceAll]);
  useEffect(() => { if (!target) pushed.current = false; }, [target]);

  const rows = issues.data?.rows;
  const list = useMemo(() => (ctx.source === 'map' ? ctx.list : rows || []), [ctx, rows]);
  const idx = target ? list.findIndex((r) => r.SOURCE_PK === target.pk && r.DQ_IDENTIFIER === target.rule) : -1;
  const fromRow = idx >= 0 ? list[idx] : (summary.data?.scatter || []).find((r) => target && r.SOURCE_PK === target.pk && r.DQ_IDENTIFIER === target.rule) || null;

  // stepping past the end of a table page loads the next page, then opens its first row
  useEffect(() => {
    if (!pending.current || !rows?.length || issues.loading) return;
    const r = pending.current === 'first' ? rows[0] : rows[rows.length - 1];
    pending.current = null;
    openIssue(r.SOURCE_PK, r.DQ_IDENTIFIER, { replace: true });
  }, [rows, issues.loading, openIssue]);

  const nav = useMemo(() => {
    if (!target || idx < 0) return null;
    if (ctx.source === 'map') {
      const go = (d) => { const r = list[idx + d]; if (r) openIssue(r.SOURCE_PK, r.DQ_IDENTIFIER, { replace: true }); };
      return { index: idx + 1, total: list.length, hasPrev: idx > 0, hasNext: idx < list.length - 1, prev: () => go(-1), next: () => go(1) };
    }
    const total = issues.data?.total ?? list.length;
    const pos = (f.page - 1) * f.size + idx;
    const step = (d) => {
      const r = list[idx + d];
      if (r) { openIssue(r.SOURCE_PK, r.DQ_IDENTIFIER, { replace: true }); return; }
      const page = f.page + d;
      if (page < 1 || (page - 1) * f.size >= total) return;
      pending.current = d > 0 ? 'first' : 'last';
      setFilters({ page }, { replace: true });
    };
    return { index: pos + 1, total, hasPrev: pos > 0, hasNext: pos < total - 1, prev: () => step(-1), next: () => step(1) };
  }, [target, idx, ctx.source, list, issues.data, f.page, f.size, openIssue, setFilters]);

  const closeDrawer = useCallback(() => {
    if (pushed.current) { pushed.current = false; navigate(-1); } else closeIssue();
  }, [navigate, closeIssue]);

  // SQL modal
  const [sqlView, setSqlView] = useState(null);
  const openSql = useCallback((q) => setSqlView(q), []);
  const runAs = sqlView === issues.data?.sql ? issues.data?.run_as
    : sqlView === history.data?.sql ? history.data?.run_as
      : sqlView === facets.data?.sql ? facets.data?.run_as : summary.data?.run_as;

  // keyboard: Esc closes the modal first, then the drawer. "/" jumps to search.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    const key = (e) => {
      if (tourOpen) return;
      if (e.key === 'Escape') {
        if (sqlView) { e.preventDefault(); setSqlView(null); return; }
        if (target) { e.preventDefault(); closeDrawer(); }
        return;
      }
      if (e.key === '/' && tab === 'issues' && !target && !sqlView && !e.target.closest?.('input,select,textarea,[contenteditable=true]')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [sqlView, target, tab, closeDrawer, tourOpen]);

  // drill-downs land at the top of the page
  const toTop = useCallback(() => {
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [scroller]);
  const { go: goUrl, setTab: setTabUrl } = url;
  const go = useCallback((patch) => { goUrl(patch); toTop(); }, [goUrl, toTop]);
  const setTab = useCallback((t) => { setTabUrl(t); toTop(); }, [setTabUrl, toTop]);
  const pickDot = useCallback((p, shown) => openRow(p, shown, 'map'), [openRow]);
  const pickRow = useCallback((r, all) => openRow(r, all, 'table'), [openRow]);

  // entrance animations only on each view's first paint with data
  // Decided during render (not in an effect) so the very first render with data
  // already has it, otherwise the count-ups mount a frame too early and never run.
  const hasData = !!m;
  const [seenTabs, setSeenTabs] = useState([]);
  const [animTab, setAnimTab] = useState(null);
  if (hasData && !seenTabs.includes(tab)) {
    setSeenTabs([...seenTabs, tab]);
    setAnimTab(tab);
  }
  const anim = animTab === tab;
  useEffect(() => {
    if (!animTab) return undefined;
    const t = setTimeout(() => setAnimTab(null), 2600);
    return () => clearTimeout(t);
  }, [animTab]);

  // watch the frame rate once while the busiest view is up; a struggling
  // machine drops to a lighter tier for the rest of the session
  useEffect(() => (hasData && tab === 'overview' ? measureTier(5) : undefined), [hasData, tab]);

  useEffect(() => {
    const before = document.title;
    return () => { document.title = before; };
  }, []);
  useEffect(() => { document.title = `${TITLES[tab]} · IND/CTA Data Quality · SmartHub`; }, [tab]);

  const refresh = async () => {
    pageClear();
    setNonce((n) => n + 1);
    if (await summary.refresh()) toast('Fresh numbers pulled from Snowflake');
  };

  const [exporting, setExporting] = useState(false);
  const total = issues.data?.total;
  const doExport = useCallback(async () => {
    setExporting(true);
    try {
      await exportCsv(f);
      toast(`Exported ${fmt(total)} ${total === 1 ? 'issue' : 'issues'}`);
    } catch (e) {
      toast(`Export failed. ${e.message}`, true);
    }
    setExporting(false);
  }, [f, total, toast]);

  const firstLoad = summary.loading && !summary.data;
  const showSkel = useDelayed(firstLoad, 150);
  const busy = summary.refreshing || (summary.loading && !!summary.data) || (onIssues && ((issues.loading && !!issues.data) || (facets.loading && !!facets.data)));
  const denied = summary.error?.status === 403;
  const k = summary.data?.kpis;

  let view;
  if (denied) view = <NoAccess />;
  else if (tab === 'issues') {
    view = (
      <Issues m={m} f={f} setFilters={setFilters} issues={issues} facets={facets} now={now} searchRef={searchRef}
        onOpen={pickRow} onSql={openSql} onExport={doExport} exporting={exporting} />
    );
  } else if (summary.error && !summary.data) {
    view = <ErrorCard error={summary.error} onRetry={summary.retry}>{tab !== 'issues' && <Btn onClick={() => setTab('issues')}>Open issue explorer</Btn>}</ErrorCard>;
  } else if (!m) {
    view = !showSkel ? null : tab === 'rules' ? <><KpiSkeleton n={4} /><div className="card" style={{ padding: 20 }}><RuleRowsSkeleton n={8} /></div></> : <OverviewSkeleton />;
  } else if (tab === 'rules') {
    view = <Rules m={m} rq={url.rq} rgroup={url.rgroup} rsort={url.rsort} setRules={url.setRules} go={go} onSql={openSql} sql={summary.data.sql?.rules} />;
  } else {
    view = (
      <Overview m={m} summary={summary.data} weeks={weeks} setWeeks={url.setWeeks} go={go} setTab={setTab} onSql={openSql} now={now}
        cacheSeconds={cacheSeconds} weeksBusy={summary.loading && summary.forWeeks !== weeks}
        onPick={pickDot} />
    );
  }

  const freshTip = k ? [
    `Last IND/CTA load: ${fullDate(k.last_load)}.`,
    summary.data?.generated_at && `Numbers on this page were pulled from Snowflake ${relTime(summary.data.generated_at, now)}.`,
    cacheSeconds && `They are cached for ${minutes(cacheSeconds)}.`,
  ].filter(Boolean).join(' ') : '';

  return (
    <AnimCtx.Provider value={anim}>
      <div className={['icq', anim && 'anim', tier !== 'full' && 'lite', tier === 'min' && 'min'].filter(Boolean).join(' ')} ref={root}>
        <style>{CSS}</style>
        {/* the tooltip lives inside .icq so its scoped styles apply */}
        <TipProvider rootRef={root}>
          <NetBg />
          <header className="topbar">
            <div className="wrap topbar-in">
              {onBack && <button type="button" className="back" onClick={onBack} aria-label="Back to check types" data-tip="Back to check types"><Icon name="chev-l" /></button>}
              <Link className="brand" to="/dashboard" aria-label="GRA SmartHub home"><small>J&amp;J Innovative Medicine</small><b>GRA SmartHub</b></Link>
              <span className="vdiv" aria-hidden="true" />
              <div className="ptitle"><h1>IND/CTA Data Quality</h1><span>Data Quality Engine</span></div>
              <span className="grow" />
              <Tabs tab={tab} setTab={setTab} m={m} />
              <div className="top-actions">
                {k?.last_load && <span className="fresh" data-tip={freshTip} tabIndex={0}><span className="live" />Updated <b>{relTime(k.last_load, now)}</b></span>}
                <Btn className="tourbtn" onClick={() => setTourOpen(true)} aria-label="Take the tour" data-tip="A one minute guided tour of this page" disabled={denied}>
                  <Icon name="play" /><span className="lbl">Take the tour</span>
                </Btn>
                <Btn onClick={refresh} disabled={summary.refreshing || firstLoad} className={summary.refreshing ? 'busy' : ''} aria-busy={summary.refreshing || undefined}>
                  {summary.refreshing ? <span className="spin" /> : <Icon name="refresh" />}<span className="lbl">{summary.refreshing ? 'Refreshing' : 'Refresh'}</span>
                </Btn>
              </div>
            </div>
            {busy && <div className="loadbar" aria-hidden="true"><span /></div>}
          </header>

          <div className="wrap icq-main" ref={content} id="icq-panel" role="tabpanel" aria-labelledby={`icq-tab-${tab}`} aria-busy={busy || firstLoad || undefined}>
            {!online && <Banner tone="grey" icon="alert">You are offline. Showing what was already loaded. The page refreshes itself when the connection comes back.</Banner>}
            {summary.refreshError && summary.data && (
              <Banner onClose={summary.dismiss} action={<Btn className="sm" onClick={refresh}>Retry</Btn>}>
                <b>Could not refresh.</b> Showing numbers from {relTime(summary.data.generated_at, now)}. {summary.refreshError.message}
              </Banner>
            )}
            {tab === 'issues' && summary.error && !summary.data && !denied && (
              <Banner tone="red" action={<Btn className="sm" onClick={summary.retry}>Retry</Btn>}>Rule names and group colours did not load. {summary.error.message}</Banner>
            )}
            <div className={`viewwrap ${busy && !firstLoad && tab !== 'issues' ? 'dimmed' : ''}`}>
              <ViewBoundary key={tab}>{view}</ViewBoundary>
            </div>
          </div>
          <ToastOutlet />

          <Drawer target={target} fromRow={fromRow} rule={target ? m?.ruleById.get(target.rule) : null} history={history} nav={nav}
            onClose={closeDrawer} onSql={openSql} groupColor={(g) => m?.colors.color(g) || C.faint} now={now} scroller={scroller} modalOpen={!!sqlView} />
          <SqlModal query={sqlView} runAs={runAs} onClose={() => setSqlView(null)} scroller={scroller} />

          {tourOpen && (
            <Suspense fallback={null}>
              <Tour url={url} m={m} summary={summary} scroller={scroller} content={content} kit={TOUR_KIT}
                onClose={() => setTourOpen(false)} />
            </Suspense>
          )}
        </TipProvider>
      </div>
    </AnimCtx.Provider>
  );
}

export default function IndCtaDataQuality({ onBack }) {
  return <ToastProvider><Page onBack={onBack} /></ToastProvider>;
}

// styles, all scoped under .icq
const CSS = `
.icq{
  --bg:#f7f5f2; --panel:#fff; --soft:#faf9f8; --tint:#f1efed; --line:#e8e6e3; --line2:#d5cfc9;
  --text:#312c2a; --body:#6e6259; --muted:#81766f; --faint:#a39992;
  --red:#eb1700; --red-soft:#fff3f1; --green:#328714; --green-soft:#eff7eb; --green-l:#53ce76;
  --blue:#0f68b2; --blue-soft:#edf5fc; --sky:#69d0ff; --orange:#ff6017; --orange-soft:#fff4ee;
  --jj-gray-02:#e8e6e3; --jj-gray-03:#d5cfc9; --jj-gray-08:#312c2a;
  --violet:#8c3bbb; --violet-soft:#f7f0fb; --yellow:#fbe058; --amber:#b25e00; --amber-soft:#fff7e6;
  --ft:'JohnsonText',Arial,sans-serif; --fd:'JohnsonDisplay',Arial,sans-serif;
  --ease:cubic-bezier(.22,1,.36,1); --ease-io:cubic-bezier(.45,0,.25,1);
  --sh:0 1px 2px rgba(49,44,42,.04),0 12px 32px -22px rgba(49,44,42,.25);
  --sh-lg:0 30px 70px -30px rgba(49,44,42,.35);
  position:relative;min-height:100%;background:var(--bg);color:var(--text);font-family:var(--ft);font-size:14px;-webkit-font-smoothing:antialiased;isolation:isolate
}
.icq *,.icq *::before,.icq *::after{box-sizing:border-box}
.icq button{font-family:inherit;color:inherit}
.icq h1,.icq h2,.icq h3,.icq h4{font-family:var(--fd);margin:0;font-weight:700}
.icq p{margin:0}
.icq .num{font-variant-numeric:tabular-nums}
.icq .wrap{max-width:1480px;margin:0 auto;padding:0 clamp(16px,2.6vw,36px)}
.icq .muted{color:var(--muted)} .icq .faint{color:var(--faint)} .icq .red{color:var(--red)} .icq .green{color:var(--green)}
.icq .row{display:flex;align-items:center} .icq .gap6{gap:6px} .icq .gap8{gap:8px} .icq .gap12{gap:12px} .icq .grow{flex:1}
.icq svg text{font-family:var(--ft)}
.icq .sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.icq .sr table{min-width:0}

/* icons: J&J svgs used as masks so they take the text colour */
.icq .ic{display:inline-block;flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:var(--m) center/contain no-repeat;mask:var(--m) center/contain no-repeat}

/* motion. One-off entrance animations only run while the root has .anim, and
   only ever move transform, opacity or a stroke offset, which stay cheap without a GPU */
.icq .spk{position:relative;display:block;width:100%}
.icq .spk svg{display:block;overflow:visible}
.icq .spk-dot{position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#fff;border:1.6px solid;box-sizing:border-box;pointer-events:none}
.icq.anim .spk-dot{animation:icqFade .4s .9s var(--ease-io) both}
@keyframes icqRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes icqFade{from{opacity:0}to{opacity:1}}
@keyframes icqSlideIn{from{transform:translateX(48px);opacity:0}to{transform:none;opacity:1}}
@keyframes icqPulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(2.4);opacity:0}100%{opacity:0}}
@keyframes icqDraw{from{stroke-dashoffset:var(--c)}to{stroke-dashoffset:0}}
@keyframes icqSpin{to{transform:rotate(360deg)}}
@keyframes icqBar{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@keyframes icqFloat1{0%,100%{transform:translate(0,0)}50%{transform:translate(-26px,18px)}}
@keyframes icqFloat2{0%,100%{transform:translate(0,0)}50%{transform:translate(22px,-14px)}}
@keyframes icqGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes icqGrow2{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes icqTwinkle{0%,100%{opacity:.25}50%{opacity:.9}}
@keyframes icqShimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.icq.anim .rise{animation:icqRise .6s var(--ease) both}
.icq.anim .draw{animation:icqDraw 1.1s var(--ease) both}
.icq.anim .growx{transform-origin:left;animation:icqGrow .8s var(--ease) both}
.icq.anim .growy{animation:icqGrow2 .7s var(--ease) both}
.icq.anim .fadein{animation:icqFade .6s var(--ease-io) both}

/* page background network */
.icq .bgnet{position:absolute;left:0;right:0;top:0;height:620px;pointer-events:none;z-index:-1;overflow:hidden;
  background:radial-gradient(900px 380px at 78% -60px,rgba(235,23,0,.07),transparent 70%),radial-gradient(700px 320px at 10% -40px,rgba(105,208,255,.10),transparent 70%);
  -webkit-mask:linear-gradient(#000 55%,transparent);mask:linear-gradient(#000 55%,transparent)}
.icq .bgnet svg{position:absolute;inset:0}
.icq .wk:hover .hov{fill:rgba(49,44,42,.035)}
.icq .bgnet circle{animation:icqTwinkle var(--d,4s) var(--dl,0s) ease-in-out infinite}

/* top bar */
.icq .topbar{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.74);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border-bottom:1px solid var(--line)}
.icq .topbar-in{display:flex;align-items:center;gap:14px;min-height:56px}
.icq .brand{display:flex;flex-direction:column;line-height:1.05;color:var(--red);text-decoration:none;cursor:pointer;flex:none;border-radius:6px}
.icq .brand small{font-family:var(--ft);font-weight:700;font-size:10px;letter-spacing:-.01em}
.icq .brand b{font-family:var(--fd);font-weight:700;font-size:17px;letter-spacing:-.015em;margin-top:1px}
.icq .vdiv{width:1px;height:28px;background:var(--line2);flex:none}
.icq .back{width:32px;height:32px;border-radius:9px;border:1px solid transparent;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;color:var(--muted);margin:0 -6px 0 -8px;transition:background .15s,border-color .15s,color .15s}
.icq .back .ic{width:12px;height:12px}
.icq .back:hover{background:#fff;border-color:var(--line);color:var(--red)}
.icq .ptitle{display:flex;flex-direction:column;min-width:0}
.icq .ptitle h1{font-family:var(--fd);font-weight:500;font-size:15px;letter-spacing:.16em;text-transform:uppercase;line-height:1.15;white-space:nowrap;color:var(--text)}
.icq .ptitle span{font-size:11.5px;color:var(--muted);margin-top:2px;white-space:nowrap}
.icq .top-actions{display:flex;align-items:center;gap:8px;flex:none}
.icq .fresh{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);padding:0 12px;height:32px;border-radius:999px;background:#fff;border:1px solid var(--line);white-space:nowrap;cursor:default}
.icq .fresh b{color:var(--text)}
.icq .live{position:relative;width:7px;height:7px;border-radius:50%;background:var(--green);flex:none}
.icq .live::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--green);animation:icqPulse 2.4s ease-out infinite}
.icq .top-actions .btn{height:32px;min-height:32px}
.icq .btn.tourbtn{border-color:var(--red);background:var(--red);color:#fff}
.icq .btn.tourbtn:hover{background:#d41500;border-color:#d41500}
.icq .tab .sm{display:none}
.icq .loadbar{position:absolute;left:0;right:0;bottom:-1px;height:3px;overflow:hidden;pointer-events:none}
.icq .loadbar span{display:block;width:35%;height:100%;background:var(--red);animation:icqBar 1s ease-in-out infinite}

/* buttons */
.icq .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:13px;font-weight:700;padding:8px 14px;min-height:32px;border-radius:10px;border:1px solid var(--line2);background:#fff;color:var(--text);cursor:pointer;white-space:nowrap;transition:border-color .18s,background .18s,box-shadow .18s,transform .18s;text-decoration:none}
.icq .btn:hover{border-color:var(--faint);background:var(--soft)}
.icq .btn:active{transform:translateY(1px)}
.icq .btn .ic{width:14px;height:14px}
.icq .btn.primary{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 10px 22px -12px rgba(235,23,0,.65)}
.icq .btn.primary:hover{background:#d41500}
.icq .btn.sm{font-size:12px;padding:6px 10px;border-radius:9px}
.icq .btn.icon{padding:0;width:32px;height:32px}
.icq .btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.icq .btn.busy:disabled{opacity:.8;cursor:progress}
.icq .spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(235,23,0,.2);border-top-color:var(--red);animation:icqSpin .75s linear infinite;flex:none}
.icq :is(button,a,input,select,[tabindex]):focus-visible{outline:2px solid var(--red);outline-offset:2px}
.icq .card-a{margin-left:auto;display:flex;align-items:center;gap:8px;min-height:34px;flex-wrap:wrap}
.icq .sqlbtn{display:inline-flex;align-items:center;gap:6px;height:32px;font-size:12px;font-weight:700;color:var(--body);padding:0 11px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer;white-space:nowrap}
.icq .sqlbtn .ic{width:12px;height:12px;color:var(--blue)}
.icq .sqlbtn:hover{border-color:var(--line2);background:var(--soft)}
.icq .sqlbtn:disabled{opacity:.45;cursor:not-allowed}
.icq .sqlbtn.lg{height:36px;padding:0 14px;font-size:13px;border-radius:10px;border-color:var(--line2);color:var(--text)}
.icq .sqlbtn.lg .ic{width:14px;height:14px}

/* tabs */
.icq .eyebrow{font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);display:flex;align-items:center;gap:8px}
.icq .eyebrow.red{color:var(--red)}
.icq .tabs{display:inline-flex;gap:3px;padding:3px;border-radius:13px;background:rgba(255,255,255,.9);border:1px solid var(--line);box-shadow:0 1px 2px rgba(49,44,42,.04),0 10px 26px -20px rgba(49,44,42,.35);flex:none}
.icq .tab{display:inline-flex;align-items:center;gap:8px;border:none;background:transparent;cursor:pointer;height:32px;padding:0 13px;border-radius:10px;font-size:13.5px;font-weight:700;color:var(--body);white-space:nowrap;transition:background .2s,color .2s}
.icq .tab .ic{width:15px;height:15px;color:var(--faint);transition:color .2s}
.icq .tab:hover{color:var(--text);background:var(--soft)}
.icq .tab[aria-selected=true]{background:var(--text);color:#fff}
.icq .tab[aria-selected=true] .ic{color:#fff}
.icq .tab .cnt{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--tint);color:var(--body)}
.icq .tab[aria-selected=true] .cnt{background:#fff;color:var(--text)}
.icq .tab .cnt.warn{background:var(--orange);color:#fff}
.icq .tab[aria-selected=true] .cnt.warn{background:var(--orange);color:#fff}

/* cards */
.icq .card{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:var(--sh);min-width:0;position:relative}
.icq .card-h{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 0;flex-wrap:wrap}
.icq .card-h .badge{width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none}
.icq .card-h .badge .ic{width:16px;height:16px}
.icq .card-h h3{font-size:16px;line-height:1.3}
.icq .card-h p{margin:3px 0 0;font-size:12.5px;color:var(--muted);line-height:1.45}
.icq .card-b{padding:14px 20px 20px}
.icq .qmark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--tint);color:var(--muted);cursor:help;vertical-align:middle;margin-left:4px;border:none;padding:0;flex:none}
.icq .qmark .ic{width:10px;height:10px}
.icq .qmark:hover,.icq .qmark:focus-visible{background:var(--blue-soft);color:var(--blue)}
.icq .icq-main{position:relative;display:flex;flex-direction:column;gap:18px;padding-top:22px;padding-bottom:60px;transition:opacity .2s}
.icq .viewwrap{display:flex;flex-direction:column;gap:18px;transition:opacity .2s}
.icq .viewwrap.dimmed{opacity:.7}
.icq .click{cursor:pointer}

/* hero */
.icq .hero{position:relative;overflow:hidden;border-radius:24px;background:#fff;border:1px solid var(--line);box-shadow:var(--sh);padding:clamp(20px,2.2vw,30px);display:grid;grid-template-columns:auto minmax(0,1fr) minmax(300px,380px);gap:clamp(20px,2.4vw,36px);align-items:center}
.icq .hero.noaside{grid-template-columns:auto minmax(0,1fr)}
/* soft glows drawn as gradients, not blur filters, so they cost nothing to repaint */
.icq .blob{position:absolute;border-radius:50%;pointer-events:none}
.icq .blob.b1{width:420px;height:320px;right:-80px;top:-140px;background:radial-gradient(closest-side,rgba(235,23,0,.10),rgba(235,23,0,0));animation:icqFloat1 14s var(--ease-io) infinite}
.icq .blob.b2{width:380px;height:260px;left:32%;bottom:-180px;background:radial-gradient(closest-side,rgba(105,208,255,.20),rgba(105,208,255,0));animation:icqFloat2 16s var(--ease-io) infinite}
.icq .blob.b3{width:300px;height:240px;left:-100px;top:-120px;background:radial-gradient(closest-side,rgba(251,224,88,.22),rgba(251,224,88,0));animation:icqFloat2 18s var(--ease-io) infinite}
.icq .hero > :not(.blob){position:relative}
.icq .ringbox{position:relative;width:172px;height:172px}
.icq.anim .ring-arc{animation:icqDraw 1.4s cubic-bezier(.2,.7,.2,1) both}
.icq .ring-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.icq .ring-c .big{font-family:var(--fd);font-weight:700;font-size:40px;line-height:1;letter-spacing:-.02em}
.icq .ring-c .big b{font-weight:700}
.icq .ring-c .big > span{font-size:20px;color:var(--faint);margin-left:1px}
.icq .ring-c small{font-size:11px;color:var(--muted);margin-top:6px;max-width:100px;line-height:1.3}
.icq .ring-c .ring-n{margin-top:7px;max-width:118px;font-size:12px;line-height:1.3;color:var(--muted)}
.icq .ring-c .ring-n b{color:var(--text);font-weight:700}
.icq .ring-c .ring-n + small{margin-top:2px}
.icq .status-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 11px;border-radius:999px;border:none}
.icq .status-pill .ic{width:11px;height:11px}
.icq .status-pill.good{background:var(--green-soft);color:var(--green)}
.icq .status-pill.bad{background:var(--orange-soft);color:var(--orange)}
.icq .status-pill.flat{background:var(--tint);color:var(--body)}
.icq .status-pill.open{background:var(--red-soft);color:var(--red)}
.icq .hero-h{font-size:clamp(22px,2vw,30px);line-height:1.18;margin-top:10px;letter-spacing:-.015em}
.icq .hero-h em{font-style:normal;color:var(--red)}
.icq .hero-p{margin:10px 0 0;color:var(--body);font-size:14px;line-height:1.65;max-width:720px}
.icq .hero-p b{color:var(--text)}
.icq .gsplit{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.icq .gcard{flex:1 1 170px;text-align:left;background:rgba(255,255,255,.75);border:1px solid var(--line);border-radius:14px;padding:11px 14px;cursor:pointer;transition:border-color .18s,transform .18s,box-shadow .18s}
.icq .gcard:hover{border-color:var(--line2);transform:translateY(-2px);box-shadow:0 12px 24px -18px rgba(49,44,42,.4)}
.icq .gcard .gname{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--muted)}
.icq .gcard .gname i{width:9px;height:9px;border-radius:3px}
.icq .gcard .gnum{font-family:var(--fd);font-weight:700;font-size:22px;margin-top:4px}
.icq .gcard .gnum span{font-size:12px;color:var(--faint);font-family:var(--ft)}
.icq .gcard .gsub{font-size:11.5px;color:var(--faint);margin-top:1px}
.icq .gcard .gsub > span{white-space:nowrap}
.icq .chartbox{overflow-x:auto;overflow-y:hidden;min-width:0}
.icq .gcard .gbar{height:5px;border-radius:9px;background:var(--tint);margin-top:9px;overflow:hidden;display:flex}
.icq .gcard .gbar span{height:100%}
.icq .start{background:rgba(255,255,255,.82);border:1px solid var(--line);border-radius:18px;padding:16px;backdrop-filter:blur(6px)}
.icq .start-h{display:flex;align-items:center;gap:8px;font-family:var(--fd);font-weight:700;font-size:15px}
.icq .start-h .ic{color:var(--red)}
.icq .start-sub{font-size:12px;color:var(--faint);margin:2px 0 12px}
.icq .act{display:flex;align-items:flex-start;gap:12px;width:100%;text-align:left;border:1px solid var(--line);background:#fff;border-radius:13px;padding:11px 12px;cursor:pointer;margin-top:8px;transition:border-color .18s,box-shadow .18s,transform .18s}
.icq .act:hover{border-color:rgba(235,23,0,.35);box-shadow:0 10px 22px -16px rgba(235,23,0,.5);transform:translateX(2px)}
.icq .act .n{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none}
.icq .act .n .ic{width:14px;height:14px}
.icq .act .t{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.icq .act .m{font-size:13.5px;font-weight:700;margin-top:2px;line-height:1.3}
.icq .act .s{font-size:12px;color:var(--muted);margin-top:2px}
.icq .act .go{margin-left:auto;align-self:center;color:var(--faint)}
.icq .act .go .ic{width:10px;height:10px}
.icq .act:hover .go{color:var(--red)}

/* kpis */
.icq .kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.icq .kpis.k4{grid-template-columns:repeat(4,minmax(0,1fr))}
.icq .kpi{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px 16px 12px;box-shadow:var(--sh);position:relative;overflow:hidden;transition:transform .2s,box-shadow .2s;min-width:0}
.icq .kpi:hover{transform:translateY(-2px);box-shadow:0 18px 36px -24px rgba(49,44,42,.35)}
.icq .kpi .lab{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.icq .kpi .icb{margin-left:auto;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none}
.icq .kpi .icb .ic{width:13px;height:13px}
.icq .kpi .val{font-family:var(--fd);font-weight:700;font-size:clamp(22px,1.8vw,28px);letter-spacing:-.02em;margin-top:4px;line-height:1.1}
.icq .kpi .val small{font-size:13px;color:var(--faint);font-weight:700;margin-left:3px;letter-spacing:0}
.icq .kpi .sub{font-size:11.5px;color:var(--muted);margin-top:4px;min-height:16px}
.icq .kpi .sp{margin-top:8px;height:30px}
.icq .kpi .sp.bars{display:flex;align-items:flex-end}
.icq .up{color:var(--red);font-weight:700} .icq .down{color:var(--green);font-weight:700}
.icq .grid-a{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(320px,1fr);gap:18px}
.icq .grid-b{display:grid;grid-template-columns:minmax(320px,1fr) minmax(0,1.5fr);gap:18px}
.icq .seg{display:inline-flex;background:var(--tint);border-radius:999px;padding:4px;gap:2px;flex-wrap:wrap}
.icq .seg button{border:none;background:transparent;cursor:pointer;font-size:13px;font-weight:700;padding:6px 16px;min-height:30px;border-radius:999px;color:var(--muted);transition:background .15s,color .15s}
.icq .seg button:hover:not([aria-pressed=true]){color:var(--text)}
.icq .seg button[aria-pressed=true]{background:var(--jj-gray-08);color:#fff;box-shadow:0 2px 6px -2px rgba(49,44,42,.45)}
.icq .legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.icq .legend span{display:inline-flex;align-items:center;gap:6px}
.icq .legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.icq .legend i.ln{height:3px;width:16px;border-radius:2px}
.icq .note{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--muted);margin-top:10px;line-height:1.45}
.icq .note .ic{width:13px;height:13px;color:var(--blue);margin-top:1px}

/* groups + aging */
.icq .glist{display:flex;flex-direction:column;gap:10px}
.icq .grow-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;cursor:pointer;transition:border-color .18s,background .18s;background:#fff;width:100%;text-align:left}
.icq .grow-item:hover{border-color:var(--line2);background:var(--soft)}
.icq .grow-item .sw{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none;font-family:var(--fd);font-weight:700;font-size:13px}
.icq .minibar{height:6px;border-radius:9px;background:var(--tint);overflow:hidden;display:flex;margin-top:6px}
.icq .minibar span{height:100%}
.icq .aging{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px}
.icq .age{border-radius:12px;padding:10px 10px 9px;border:1px solid var(--line);background:#fff;cursor:pointer;transition:border-color .18s;text-align:left}
.icq .age:hover{border-color:var(--line2)}
.icq .age .al{font-size:11px;color:var(--muted)}
.icq .age .av{font-family:var(--fd);font-weight:700;font-size:18px;margin-top:2px}
.icq .age .ab{height:4px;border-radius:9px;margin-top:6px}
.icq .subhead{font-size:10.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:18px 0 8px;display:flex;align-items:center}

/* confidence bands */
.icq .stack{display:flex;border-radius:999px;overflow:hidden;background:var(--tint);gap:2px;width:100%}
.icq .stack span{height:100%}
.icq .band{display:grid;grid-template-columns:4px 1fr auto;gap:14px;align-items:center;padding:12px 14px 12px 0;border:1px solid var(--line);border-radius:14px;margin-top:10px;cursor:pointer;overflow:hidden;transition:border-color .18s,box-shadow .18s,transform .18s;background:#fff;width:100%;text-align:left}
.icq .band:hover{transform:translateX(2px);box-shadow:0 12px 26px -20px rgba(49,44,42,.45)}
.icq .band.dashed{border-style:dashed;background:var(--soft)}
.icq .band .bar{align-self:stretch;margin:-12px 0}
.icq .band .bt{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.icq .band .bf{font-size:11.5px;color:var(--faint);margin-top:4px}
.icq .band .bn{text-align:right}
.icq .band .bn b{font-family:var(--fd);font-size:20px;display:block;line-height:1}
.icq .band .bn span{font-size:11.5px;color:var(--faint);display:inline-flex;align-items:center;gap:4px}
.icq .band .bn .ic{width:8px;height:8px}
.icq .pill{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700}
.icq .pill i{width:6px;height:6px;border-radius:50%}
.icq .pill.sm{padding:2px 8px;font-size:11px}

/* scatter toggles */
.icq .toggles{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;align-items:center}
.icq .tg{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;min-height:28px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid}
.icq .tg i{width:7px;height:7px;border-radius:50%}
.icq .tg.off{background:#fff !important;color:var(--faint) !important;border-color:var(--line) !important;text-decoration:line-through}
.icq .tg.off i{background:var(--line) !important}
.icq .fchip:hover{background:var(--jj-gray-03)}
.icq .mdot{cursor:pointer}
.icq .mdot:hover,.icq .mdot:focus-visible{r:6.5;outline:none;stroke:var(--text);stroke-width:1.5}

/* rule rows */
.icq .chip{font-size:11px;font-weight:700;letter-spacing:.02em;color:var(--body);background:var(--tint);padding:2px 7px;border-radius:6px;white-space:nowrap}
.icq .gpill{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;padding:2px 8px;border-radius:999px;border:1px solid}
.icq .rrow{display:grid;grid-template-columns:30px minmax(0,1fr) 110px 150px 96px;align-items:center;gap:16px;padding:11px 14px;border:1px solid var(--line);border-radius:13px;cursor:pointer;background:#fff;transition:background .15s,border-color .15s,box-shadow .15s;margin-top:8px;width:100%;text-align:left}
.icq .rrow:hover{background:#fffbfa;border-color:rgba(235,23,0,.3);box-shadow:0 8px 20px -16px rgba(235,23,0,.5)}
.icq .rrow .rk{font-family:var(--fd);font-weight:300;font-size:18px;text-align:right;color:var(--line2)}
.icq .rrow .rk.top{color:var(--red)}
.icq .rname{font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.icq .rmain{display:flex;align-items:center;gap:10px;min-width:0}
.icq .rmain > .chip{flex:none;min-width:64px;text-align:center}
.icq .rtext{min-width:0;flex:1}
.icq .rdesc{font-size:12px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icq .rhead{display:grid;grid-template-columns:30px minmax(0,1fr) 110px 150px 96px;gap:16px;padding:0 14px 6px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.icq .rbig{font-family:var(--fd);font-weight:700;font-size:18px;line-height:1;text-align:right}
.icq .rsmall{font-size:11px;color:var(--faint);margin-top:3px;text-align:right;white-space:nowrap}
.icq .rules-full .rrow,.icq .rules-full .rhead{grid-template-columns:30px minmax(0,1fr) 92px 170px 150px 120px 110px}
.icq .rules-full .rhead{margin-top:14px;padding-bottom:8px}
.icq .rviewbtn{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:6px 10px;border-radius:9px;border:1px solid var(--line2);background:#fff;white-space:nowrap}
.icq .rviewbtn .ic{width:8px;height:8px}

/* toolbar + inputs */
.icq .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.icq .search{position:relative;flex:1 1 260px;max-width:420px}
.icq .tactions{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.icq .search > .ic{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--faint);pointer-events:none}
.icq .search input{width:100%;font-family:var(--ft);font-size:13px;padding:9px 34px 9px 34px;min-height:36px;border-radius:11px;border:1px solid var(--line2);background:#fff;color:var(--text);transition:border-color .15s,box-shadow .15s}
.icq .search input:focus,.icq select:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(235,23,0,.1)}
.icq .search .clr{position:absolute;right:4px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;width:28px;height:28px;display:flex;align-items:center;justify-content:center;color:var(--faint);border-radius:7px}
.icq .search .clr:hover{color:var(--text);background:var(--tint)}
.icq .search .clr .ic{width:10px;height:10px}
.icq .kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:10.5px;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:1px 5px;background:var(--soft);pointer-events:none}
.icq select{font-family:var(--ft);font-size:13px;padding:8px 30px 8px 11px;min-height:34px;border-radius:10px;border:1px solid var(--line2);background:#fff;color:var(--text);cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px;background-repeat:no-repeat;max-width:100%}

/* issues layout */
.icq .iss{display:grid;grid-template-columns:270px minmax(0,1fr);gap:18px;align-items:start}
.icq .rail{display:flex;flex-direction:column;gap:6px;padding:16px}
.icq .rail h4{font-size:15px;display:flex;align-items:center;gap:8px}
.icq .facet{border-top:1px solid var(--line);padding-top:12px;margin-top:8px}
.icq .facet-t{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:6px;display:flex;align-items:center}
.icq .opt{display:flex;align-items:center;gap:9px;width:100%;border:none;background:transparent;cursor:pointer;padding:7px 9px;min-height:32px;border-radius:9px;font-size:13px;color:var(--body);text-align:left;transition:background .15s}
.icq .opt:hover{background:var(--soft)}
.icq .opt .rb{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--line2);flex:none;display:flex;align-items:center;justify-content:center}
.icq .opt[aria-checked=true]{background:var(--jj-gray-02);color:var(--jj-gray-08);font-weight:700;box-shadow:inset 0 0 0 1px var(--jj-gray-03)}
.icq .opt[aria-checked=true] .rb{border-color:var(--jj-gray-08)}
.icq .opt[aria-checked=true] .rb::after{content:"";width:7px;height:7px;border-radius:50%;background:var(--jj-gray-08)}
.icq .opt[aria-checked=true] .c{color:var(--body)}
.icq .opt .c{margin-left:auto;font-size:12px;color:var(--faint)}
.icq .opt .dot{width:8px;height:8px;border-radius:50%;flex:none;cursor:inherit}
.icq .chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:12px}
.icq .chips > .ic{width:13px;height:13px;color:var(--faint)}
.icq .fchip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--jj-gray-03);background:var(--jj-gray-02);color:var(--jj-gray-08);border-radius:999px;padding:4px 9px 4px 11px;min-height:28px;font-size:12px;font-weight:700;cursor:pointer}
.icq .fchip .ic{width:8px;height:8px}
.icq .linkbtn{border:none;background:none;color:var(--muted);font-size:12px;cursor:pointer;text-decoration:underline;padding:4px}
.icq .tbl-wrap{margin-top:14px;border:1px solid var(--line);border-radius:14px;overflow:clip;background:#fff;position:relative}
.icq .tbl-wrap::before,.icq .tbl-wrap::after{content:"";position:absolute;top:0;bottom:0;width:18px;pointer-events:none;z-index:3;opacity:0;transition:opacity .2s}
.icq .tbl-wrap::before{left:0;background:linear-gradient(90deg,rgba(49,44,42,.12),transparent)}
.icq .tbl-wrap::after{right:0;background:linear-gradient(-90deg,rgba(49,44,42,.12),transparent)}
.icq .tbl-wrap.shl::before,.icq .tbl-wrap.shr::after{opacity:1}
.icq .tbl-scroll{overflow-x:auto;overflow-y:hidden;min-height:380px}
.icq .tbl-wrap.fits .tbl-scroll{overflow:visible}
.icq .tbl-wrap.fits th{top:var(--tb,0px)}
.icq table{width:100%;border-collapse:collapse;font-size:13px;min-width:1040px;table-layout:fixed}
.icq th{position:sticky;top:0;z-index:2;background:var(--soft);border-bottom:1px solid var(--line);padding:10px 12px;text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);white-space:nowrap}
.icq th button{all:unset;cursor:pointer;border-radius:4px}
.icq th button:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.icq th button:hover{color:var(--text)}
.icq th.on button{color:var(--blue)}
.icq td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
.icq tr.ir{cursor:pointer;transition:background .12s}
.icq tr.ir:hover,.icq tr.ir:focus-visible{background:#fff8f7}
.icq tr.ir:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
.icq tr.ir:hover .openhint,.icq tr.ir:focus-visible .openhint{opacity:1}
.icq .openhint{opacity:0;color:var(--red);font-size:11.5px;font-weight:700;transition:opacity .15s;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.icq .openhint .ic{width:8px;height:8px}
.icq .sdot{display:block;width:9px;height:9px;border-radius:50%}
.icq .prev{font-size:12.5px;line-height:1.55;min-width:0}
.icq .prev div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icq .prev .tag{font-weight:700;margin-right:6px;font-size:11px;padding:0 5px;border-radius:4px}
.icq .prev .k{font-size:10.5px;color:var(--faint)}
.icq mark{color:inherit;border-radius:3px;padding:0}
.icq mark.a{background:rgba(235,23,0,.13)} .icq mark.b{background:rgba(15,104,178,.14)}
.icq .miss{color:var(--red);font-weight:700;font-style:italic}
.icq .mm{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--faint)}
.icq .mm .t{width:52px}
.icq .mm .tr{width:56px;height:5px;border-radius:9px;background:var(--tint);overflow:hidden}
.icq .mm .tr span{display:block;height:100%}
.icq .mm b{color:var(--body);font-weight:400;width:28px}
.icq .pager{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;font-size:13px;color:var(--body)}
.icq .pager select{padding:6px 28px 6px 10px}
.icq .empty{padding:70px 20px;text-align:center}
.icq .empty .eb{width:52px;height:52px;border-radius:15px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
.icq .empty .eb .ic{width:22px;height:22px}
.icq .empty h4{font-size:18px}
.icq .empty p{margin:6px 0 14px;color:var(--muted)}

/* banners + errors */
.icq .banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 14px;border-radius:14px;border:1px solid;font-size:13px;line-height:1.45}
.icq .banner .ic{width:15px;height:15px}
.icq .banner.amber{background:var(--amber-soft);border-color:rgba(178,94,0,.25);color:#6b3a00}
.icq .banner.amber > .ic{color:var(--amber)}
.icq .banner.red{background:var(--red-soft);border-color:rgba(235,23,0,.25);color:var(--text)}
.icq .banner.red > .ic{color:var(--red)}
.icq .banner.grey{background:#fff;border-color:var(--line2);color:var(--text)}
.icq .banner .x{border:none;background:none;cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.icq .banner .x .ic{width:10px;height:10px}
.icq .errcard{background:#fff;border:1px solid rgba(235,23,0,.25);border-radius:18px;padding:clamp(18px,2vw,28px);display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;box-shadow:var(--sh)}
.icq .errcard .eb{width:46px;height:46px;border-radius:13px;display:flex;align-items:center;justify-content:center;flex:none}
.icq .errcard .eb .ic{width:22px;height:22px}
.icq .errcard h3{font-size:18px}
.icq .errcard p{margin:6px 0 14px;color:var(--body);font-size:13.5px;line-height:1.55;word-break:break-word}
.icq .errcard pre{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--soft);border:1px solid var(--line);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--body)}
.icq .inline-err{display:flex;flex-direction:column;align-items:center;text-align:center;padding:50px 20px;gap:4px}
.icq .inline-err .eb{width:46px;height:46px;border-radius:13px;display:inline-flex;align-items:center;justify-content:center;background:var(--red-soft);color:var(--red);margin-bottom:8px}
.icq .inline-err h4{font-size:16px}
.icq .inline-err p{color:var(--body);font-size:13px;margin:4px 0 12px;max-width:520px;word-break:break-word}

/* skeletons */
.icq .skel{border-radius:8px;background:var(--tint);position:relative;overflow:hidden}
.icq .skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.6),rgba(255,255,255,0));transform:translateX(-100%);animation:icqShimmer 1.5s var(--ease-io) infinite}

/* drawer */
.icq .veil{position:fixed;inset:0;background:rgba(241,239,237,.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:icqFade .25s var(--ease-io) both;z-index:60}
.icq .drawer{position:fixed;top:0;right:0;bottom:0;width:min(700px,100vw);background:var(--bg);z-index:61;overflow-y:auto;overscroll-behavior:contain;border-left:1px solid var(--line);box-shadow:-30px 0 70px -35px rgba(49,44,42,.4);animation:icqSlideIn .38s var(--ease) both;outline:none}
.icq .dh{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid var(--line);padding:22px 28px 18px}
.icq .dh::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--accent)}
.icq .dh h2{font-size:20px;line-height:1.25;margin-top:12px}
.icq .dh p{margin:4px 0 0;color:var(--body);font-size:13.5px;line-height:1.5}
.icq .dh .status-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
.icq .meta{display:flex;gap:26px;margin-top:16px;flex-wrap:wrap}
.icq .meta .k{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.icq .meta .v{font-weight:700;margin-top:3px;font-size:13.5px}
.icq .meta button.v{all:unset;font-weight:700;margin-top:3px;font-size:13.5px;cursor:copy;display:inline-flex;align-items:center;gap:6px;border-radius:4px}
.icq .meta button.v:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.icq .meta button.v .ic{width:12px;height:12px;color:var(--faint)}
.icq .db{padding:22px 28px 60px;display:flex;flex-direction:column;gap:24px}
.icq .sec-t{font-size:10.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.icq .sec-t span{text-transform:none;letter-spacing:0;font-weight:400}
.icq .plain{display:flex;gap:14px;padding:16px;border-radius:16px;background:linear-gradient(110deg,#fff 0%,var(--tone-soft) 100%);border:1px solid var(--line)}
.icq .plain .pi{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex:none;background:#fff;border:1px solid var(--line)}
.icq .plain .pi .ic{width:17px;height:17px}
.icq .plain h4{font-size:15px}
.icq .plain p{margin:4px 0 0;font-size:13.5px;color:var(--body);line-height:1.55}
.icq .plain .next{margin-top:8px;font-size:12.5px;color:var(--text)}
.icq .cmp{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch}
/* only side by side boxes share a row; a single box in the column list keeps its natural height */
.icq .cmp > .side{flex:1 1 240px}
.icq .side{min-width:0;border:1px solid var(--line);border-radius:14px;padding:13px 15px 13px 18px;background:#fff;position:relative}
.icq .side::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:var(--acc)}
.icq .side .sl{display:flex;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:5px}
.icq .side .sv{font-size:15px;font-weight:700;line-height:1.4;word-break:break-word}
.icq .vs{align-self:center;font-family:var(--fd);font-weight:300;font-style:italic;color:var(--faint);font-size:14px}
.icq .gauges{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.icq .gauge{border:1px solid var(--line);border-radius:14px;padding:12px 10px 11px;text-align:center;background:#fff}
.icq .gauge .gwrap{position:relative;width:108px;height:56px;margin:0 auto}
.icq .gauge .gwrap svg{display:block}
.icq .gauge .gv{position:absolute;left:0;right:0;bottom:4px;font-family:var(--fd);font-weight:700;font-size:17px;line-height:1}
.icq .gauge .gl{font-size:11.5px;font-weight:700;color:var(--body);margin-top:8px}
.icq .gauge .gh{font-size:11px;color:var(--faint);margin-top:2px;line-height:1.35}
.icq .tl{position:relative;padding-left:24px}
.icq .tl::before{content:"";position:absolute;left:6px;top:10px;bottom:10px;width:2px;background:var(--line)}
.icq .tli{position:relative;margin-bottom:10px}
.icq .tli .pt{position:absolute;left:-23px;top:15px;width:12px;height:12px;border-radius:50%;border:2px solid var(--line2);background:#fff}
.icq .tli.cur .pt{background:var(--red);border-color:var(--red);box-shadow:0 0 0 4px rgba(235,23,0,.12)}
.icq .tli.fixed .pt{background:var(--green);border-color:var(--green)}
.icq .tli .box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px 13px}
.icq .tli.fixed .box{border-color:rgba(50,135,20,.3);background:var(--green-soft)}
.icq .navbtns{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}

/* modal */
.icq .modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:clamp(10px,3vw,32px)}
.icq .modal .veil{position:absolute}
.icq .mbox{position:relative;z-index:1;width:min(1000px,100%);max-height:100%;display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:var(--sh-lg);overflow:hidden;animation:icqRise .3s both;outline:none}
.icq .mbox .mbody{overflow:auto;flex:1;overscroll-behavior:contain}
.icq .mbox pre{margin:0;padding:14px 0;font-family:var(--ft);font-size:12.5px;line-height:1.65;white-space:pre}
.icq .mbox pre .ln{display:inline-block;width:48px;text-align:right;padding-right:14px;color:var(--line2);user-select:none}
.icq .mbox .steps b{width:20px;height:20px;border-radius:50%;background:var(--blue-soft);color:var(--blue);display:inline-flex;align-items:center;justify-content:center;font-size:11px}

/* tooltip + toast */
.icq .tip{position:fixed;left:0;top:0;z-index:100;pointer-events:none;background:#fff;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.45;max-width:290px;box-shadow:0 18px 40px -16px rgba(49,44,42,.35);opacity:0;transition:opacity .12s}
.icq .tip.on{opacity:1}
.icq .tip .tr{display:flex;justify-content:space-between;gap:14px;margin-top:3px}
.icq .tip .tr span{color:var(--muted);display:flex;align-items:center;gap:6px}
.icq .tip .tr i{width:8px;height:8px;border-radius:2px;display:inline-block}
.icq .toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);z-index:110;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 16px;font-size:13px;font-weight:700;box-shadow:var(--sh-lg);opacity:0;transition:opacity .25s var(--ease-io),transform .3s var(--ease);display:flex;align-items:center;gap:8px;pointer-events:none;max-width:calc(100vw - 32px)}
.icq .toast.on{opacity:1;transform:translate(-50%,0)}
.icq .toast .ic{color:var(--green)}
.icq .toast.bad .ic{color:var(--red)}
.icq .foot{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:12px;color:var(--faint);flex-wrap:wrap}

/* scrollbars inside the page, and on the <main> scroller while the page is mounted */
.icq .scroll,.icq .drawer,.icq .tabs,.icq select,.icq .tbl-scroll,.icq .mbody,main.icq-scroller{scrollbar-width:thin;scrollbar-color:var(--line2,#d5cfc9) transparent}
.icq .scroll::-webkit-scrollbar,.icq .drawer::-webkit-scrollbar,.icq .tabs::-webkit-scrollbar,.icq select::-webkit-scrollbar,.icq .tbl-scroll::-webkit-scrollbar,.icq .mbody::-webkit-scrollbar,main.icq-scroller::-webkit-scrollbar{width:8px;height:8px}
.icq .scroll::-webkit-scrollbar-track,.icq .drawer::-webkit-scrollbar-track,.icq .tabs::-webkit-scrollbar-track,.icq .tbl-scroll::-webkit-scrollbar-track,.icq .mbody::-webkit-scrollbar-track,main.icq-scroller::-webkit-scrollbar-track{background:transparent}
.icq .scroll::-webkit-scrollbar-thumb,.icq .drawer::-webkit-scrollbar-thumb,.icq .tabs::-webkit-scrollbar-thumb,.icq select::-webkit-scrollbar-thumb,.icq .tbl-scroll::-webkit-scrollbar-thumb,.icq .mbody::-webkit-scrollbar-thumb,main.icq-scroller::-webkit-scrollbar-thumb{background:#d5cfc9;border-radius:8px}
.icq .scroll::-webkit-scrollbar-thumb:hover,.icq .drawer::-webkit-scrollbar-thumb:hover,.icq .tabs::-webkit-scrollbar-thumb:hover,.icq .tbl-scroll::-webkit-scrollbar-thumb:hover,.icq .mbody::-webkit-scrollbar-thumb:hover,main.icq-scroller::-webkit-scrollbar-thumb:hover{background:#a39992}

main.icq-scroller{scrollbar-gutter:stable;background:#f7f5f2}
/* lite machines skip painting the lower sections until they scroll near them */
.icq.lite .grid-b,.icq.lite #icq-hotspots{content-visibility:auto;contain-intrinsic-size:auto 640px}

/* touch: bigger hit targets */
@media (pointer:coarse){
  .icq .btn,.icq .opt,.icq .tab,.icq .sqlbtn,.icq .fchip,.icq .seg button,.icq .tg,.icq select,.icq .search input{min-height:36px}
  .icq .btn.icon{width:36px;height:36px}
}

@media (max-width:1460px){.icq .fresh{display:none}}
@media (max-width:1380px){.icq .kpis{grid-template-columns:repeat(3,1fr)} .icq .kpis.k4{grid-template-columns:repeat(2,1fr)} .icq .hero{grid-template-columns:auto minmax(0,1fr)} .icq .start{grid-column:1/-1}}
@media (max-width:1360px){.icq .tourbtn .lbl{display:none} .icq .tourbtn{width:32px;padding:0}}
@media (max-width:1150px){
  .icq .grid-a,.icq .grid-b{grid-template-columns:1fr} .icq .iss{grid-template-columns:1fr} 
  .icq .rules-full .rrow,.icq .rules-full .rhead{grid-template-columns:30px minmax(0,1fr) 92px 150px 110px} .icq .rules-full .hide-md{display:none}
  .icq .topbar-in{flex-wrap:wrap;row-gap:0;padding-top:6px} .icq .topbar .grow{display:none} .icq .top-actions{margin-left:auto}
  .icq .tabs{order:5;width:100%;margin:6px 0 8px;overflow-x:auto} .icq .tab{flex:1;justify-content:center}
}
@media (max-width:760px){
  .icq .kpis{grid-template-columns:repeat(2,1fr)} .icq .hero,.icq .hero.noaside{grid-template-columns:1fr;justify-items:start}
  .icq .top-actions .lbl,.icq .ptitle span,.icq .vdiv,.icq .back{display:none} .icq .topbar-in{gap:10px} .icq .ptitle{flex:1}
  .icq .ptitle h1{font-size:12px;letter-spacing:.08em;overflow:hidden;text-overflow:ellipsis} .icq .top-actions .btn{width:34px;height:34px;padding:0}
  .icq .tab .ic{display:none} .icq .tab .lg{display:none} .icq .tab .sm{display:inline}
  .icq .gauges{grid-template-columns:repeat(2,1fr)}
  .icq .rrow,.icq .rhead{grid-template-columns:24px minmax(0,1fr) 80px} .icq .hide-sm{display:none}
  .icq .rules-full .rrow,.icq .rules-full .rhead{grid-template-columns:24px minmax(0,1fr) 80px}
  .icq .rules-full .rrow > :last-child,.icq .rules-full .rhead > :last-child{display:none}
  .icq .kpis.k4{grid-template-columns:repeat(2,1fr)} .icq .tab{padding:0 8px;font-size:13px;gap:6px}
  .icq .brand b{font-size:15px} .icq .brand small{font-size:9px}
  .icq .aging{grid-template-columns:repeat(2,1fr)}
  .icq .dh{padding:18px 18px 14px} .icq .db{padding:18px 18px 50px}
}
@media (max-width:520px){
  .icq .kpis,.icq .kpis.k4{grid-template-columns:1fr}
  .icq .tab .cnt{display:none}
}
/* Machines without a GPU (perfTier lite): no live blur behind sticky or fixed
   panels, no twinkling background dots, lighter drawer shadow. */
.icq.lite .topbar{background:rgba(255,255,255,.97);backdrop-filter:none;-webkit-backdrop-filter:none}
.icq.lite .veil{background:rgba(241,239,237,.9);backdrop-filter:none;-webkit-backdrop-filter:none}
.icq.lite .start{background:rgba(255,255,255,.95);backdrop-filter:none}
.icq.lite .bgnet circle{animation:none}
.icq.lite .blob{will-change:transform}
.icq.lite .drawer{box-shadow:-10px 0 28px -18px rgba(49,44,42,.35)}
/* lite: every animation still plays. Hover and state changes only tween what the
   compositor can do on the CPU (no shadow or size tweening, the end state is the same) */
.icq.lite *,.icq.lite *::before,.icq.lite *::after{transition-property:opacity,color,background-color,border-color,stroke-dashoffset !important}
/* only hover lifts get transform tweening back. Things script moves every frame
   (tooltip, tour spotlight, pins, cursor) must never tween, or they trail behind */
.icq.lite :is(.btn,.gcard,.act,.kpi,.band){transition-property:opacity,transform,color,background-color,border-color !important}
.icq.lite.anim .rrow.rise:nth-child(n+22){animation:none}
/* the tour measures and zooms into these, so they must be painted while it runs */
.icq.lite:has(.film > *) .grid-b,.icq.lite:has(.film > *) #icq-hotspots{content-visibility:visible}
/* min (still dropping frames): same graphics, only the endless background loops rest */
.icq.min .blob{animation:none}
`;