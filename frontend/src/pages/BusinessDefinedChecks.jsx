import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import ExecutiveView from './ExecutiveView';
import { apiEventSource, apiFetch } from '../utils/apiClient';
import { useRBAC } from '../context/RBACContext';
import { hardwareTier, measureTier, subscribeTier } from '../utils/perfTier';
import './BusinessDefinedChecks.css';
import checkSrc from '/icons/JJ_Icon_Check_RGB.svg';
import alertSrc from '/icons/JJ_Icon_Alert_RGB.svg';
import closeSrc from '/icons/JJ_Icon_Close.svg';
import databaseSrc from '/icons/JJ_Icon_Database_RGB.svg';
import dashboardSrc from '/icons/JJ_Icon_Dashboard_RGB.svg';
import chartSrc from '/icons/JJ_Icon_Graph_Chart_RGB.svg';
import analysisSrc from '/icons/JJ_Icon_Analysis_RGB.svg';
import recordsSrc from '/icons/JJ_Icon_Records_Information_RGB.svg';
import refreshSrc from '/icons/JJ_Icon_Refresh_RGB.svg';
import searchSrc from '/icons/JJ_Icon_Search_RGB.svg';
import filterSrc from '/icons/JJ_Icon_Filter.svg';
import chevRSrc from '/icons/JJ_Icon_Chevron_Right.svg';
import chevLSrc from '/icons/JJ_Icon_Chevron_Left.svg';
import chevDSrc from '/icons/JJ_Icon_Chevron_Down.svg';
import infoSrc from '/icons/JJ_Icon_Info_RGB.svg';
import shieldSrc from '/icons/JJ_Icon_Shield_RGB.svg';
import downloadSrc from '/icons/JJ_Icon_Download_PDF_RGB.svg';
import timeSrc from '/icons/JJ_Icon_Time_RGB.svg';
import calendarSrc from '/icons/JJ_Icon_Calendar_RGB.svg';
import editSrc from '/icons/JJ_Icon_Edit_RGB.svg';
import addSrc from '/icons/JJ_Icon_Add.svg';
import eyeSrc from '/icons/JJ_Icon_Vision_Accessibility_RGB.svg';
import networkSrc from '/icons/JJ_Icon_Network_RGB.svg';
import aiSrc from '/icons/JJ_Icon_AI_RGB.svg';
import playSrc from '/icons/JJ_Icon_Video_Play_RGB.svg';
import helpSrc from '/icons/JJ_Icon_Help.svg';
import outcomesSrc from '/icons/JJ_Icon_Outcomes.svg';
import infographicSrc from '/icons/JJ_Icon_Infographic_RGB.svg';
import saveSrc from '/icons/JJ_Icon_Save_RGB.svg';

const ICONS = {
  check: checkSrc, alert: alertSrc, close: closeSrc, database: databaseSrc, dashboard: dashboardSrc,
  chart: chartSrc, analysis: analysisSrc, records: recordsSrc, refresh: refreshSrc, search: searchSrc,
  filter: filterSrc, chevR: chevRSrc, chevL: chevLSrc, chevD: chevDSrc, info: infoSrc, shield: shieldSrc,
  download: downloadSrc, time: timeSrc, calendar: calendarSrc, edit: editSrc, add: addSrc, eye: eyeSrc,
  network: networkSrc, ai: aiSrc, play: playSrc, help: helpSrc, outcomes: outcomesSrc,
  infographic: infographicSrc, save: saveSrc,
};

const HEALTH = {
  ok: { label: 'Healthy', color: '#328714', cls: 'ok', icon: 'check' },
  warn: { label: 'Warning', color: '#ff6017', cls: 'warn', icon: 'alert' },
  crit: { label: 'Critical', color: '#eb1700', cls: 'crit', icon: 'close' },
  none: { label: 'No result', color: '#a39992', cls: 'none', icon: 'info' },
};
const health = (p) => (p >= 95 ? 'ok' : p >= 80 ? 'warn' : 'crit');
// The backend flags rules whose last run gave no pass rate (it errored).
const ruleHealth = (r) => (r?.no_result ? 'none' : health(r?.pass_percentage));
// Average pass rate of the rules that have one.
const passMean = (list) => {
  const scored = list.filter((r) => !r.no_result);
  return scored.length ? mean(scored.map((r) => r.pass_percentage)) : null;
};
// health of an average that may be missing
const avgHealth = (p) => (p == null ? 'none' : health(p));
const healthColor = (p) => HEALTH[health(p)].color;

const SEVS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const SEV_COLOR = { CRITICAL: '#9e0000', HIGH: '#ff6017', MEDIUM: '#d9b400', LOW: '#a39992' };
const SEV_LIGHT = new Set(['MEDIUM', 'LOW']);
const sevRank = (s) => {
  const i = SEVS.indexOf(s);
  return i < 0 ? SEVS.length : i;
};
const SERIES = ['#eb1700', '#0f68b2', '#8c3bbb'];

const TABS = [
  { id: 'overview', name: 'Overview', icon: 'dashboard' },
  { id: 'dataset-health', name: 'Dataset Info', icon: 'database' },
  { id: 'trends', name: 'Trends', icon: 'chart' },
  { id: 'failed-rows', name: 'Failed Rows', icon: 'alert' },
  { id: 'admin', name: 'Superuser', icon: 'shield', admin: true },
  { id: 'review', name: 'Review', icon: 'outcomes', admin: true },
];

const VAL_MODES = [
  { mode: 'EXECUTE_FULL', label: 'New rules only', button: 'Run Validation', desc: 'Validate rules added since the last run', icon: 'add' },
  { mode: 'EXECUTE_ALLRULES', label: 'All rules', button: 'Run All Rules', desc: 'Validate every active, compiled rule', icon: 'records' },
  { mode: 'EXECUTE_RULE', label: 'Specific rule…', button: 'Validate a rule', desc: 'Pick one rule and run it on the full table', icon: 'search' },
  { mode: 'EXECUTE_ALLRULES_DELTA', label: 'Delta · all rules', button: 'Delta - All Rules', desc: 'Semi-monthly delta validation for every rule', icon: 'time' },
];
const modeLabel = (mode) => {
  const m = VAL_MODES.find((v) => v.mode === mode);
  if (m) return m.label;
  return mode?.startsWith('EXECUTE_') ? `Rule ${mode.slice(8)}` : mode || '';
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => (n == null || Number.isNaN(+n) ? '-' : Math.round(+n).toLocaleString('en-US'));
const pct = (n) => (n == null || Number.isNaN(+n) ? '-' : `${(+n).toFixed(1)}%`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);

// Dates from Snowflake come as 'YYYY-MM-DD' (no zone) or ISO timestamps. A bare
// date is a calendar day, so build it in local time instead of letting Date()
// read it as UTC midnight and show the previous day.
// A date-time with no zone comes from Snowflake, where both the DQE engine and
// SmartHub run their sessions in America/New_York, so it is Eastern wall time.
// Reading it as the browser's own zone put it hours off outside the Eastern zone.
const ET_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const etOffset = (ms) => {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;
const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const n = NAIVE.exec(s);
  if (n) {
    const wall = Date.UTC(+n[1], +n[2] - 1, +n[3], +n[4], +n[5], +(n[6] || 0), +(n[7] || 0).toString().padEnd(3, '0'));
    const guess = wall - etOffset(wall);
    return new Date(wall - etOffset(guess));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ago = (v, now = Date.now()) => {
  const d = toDate(v);
  if (!d) return 'never';
  const mins = (now - d.getTime()) / 6e4;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const h = mins / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

const ET = 'America/New_York';
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`) ? '⌘' : 'Ctrl';
const fmtDateTime = (v) => {
  // A bare date is a calendar day, not an instant: converting it to ET moved it
  // to the previous evening for anyone east of New York.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) return fmtDay(v);
  const d = toDate(v);
  if (!d) return '-';
  const day = d.toLocaleDateString('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time} ET`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (v) => {
  const d = toDate(v);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '-';
};
const fmtShortDay = (v, withYear = false) => {
  const d = toDate(v);
  if (!d) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? ` '${String(d.getFullYear()).slice(2)}` : ''}`;
};

// "Q3 2026" for a quarterly range, "Sep 16-30" for a semi-monthly one.
const cycleLabel = (range, delta) => {
  const from = toDate(range?.from_date);
  const to = toDate(range?.to_date);
  if (!from || !to) return delta ? 'Semi-Monthly' : 'Quarterly';
  if (!delta) return `Q${Math.floor(from.getMonth() / 3) + 1} ${from.getFullYear()}`;
  return from.getMonth() === to.getMonth()
    ? `${MONTHS[from.getMonth()]} ${from.getDate()}-${to.getDate()}`
    : `${fmtShortDay(from)} - ${fmtShortDay(to)}`;
};

// Run snapshots are suffixed YYYYMMDD_HHMMSS in UTC (the DQE engine names
// them with datetime.now(timezone.utc)); shown in ET like every other time here.
const fmtRunSuffix = (name) => {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(name || '');
  if (!m) return name || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return `${d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })} ET`;
};

const KW = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'OVER', 'PARTITION', 'BY', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'AS', 'ON', 'JOIN', 'LEFT', 'INNER', 'BETWEEN', 'LIKE', 'EXISTS', 'DISTINCT', 'GROUP', 'ORDER', 'HAVING', 'TRUE', 'FALSE']);
const TOKEN = /('(?:[^']|'')*')|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\s+)|([^\sA-Za-z_']+)|(')/g;
const sqlTokens = (sql) => {
  const text = String(sql || '');
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const [tok, str, word] = m;
    let cls = '';
    if (str) cls = 'st';
    else if (word && KW.has(word.toUpperCase())) cls = 'kw';
    else if (word && /^\s*\(/.test(text.slice(m.index + tok.length))) cls = 'fn';
    out.push({ t: tok, cls });
  }
  return out;
};

// Text starting with = + - @ (or a tab/CR) runs as a formula when the CSV is
// opened in Excel, and rule titles are typed by users; a leading quote keeps
// it text. Numbers are left alone so negatives still read as numbers.
const csvCell = (c) => {
  let v = String(c ?? '');
  if (typeof c !== 'number' && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

const exportRulesCsv = (list, delta) => {
  const rows = [['rule_id', 'title', 'dataset', 'severity', 'pass_percentage', 'failing_rows'],
    ...list.map((r) => [r.rule_id, r.rule_title, r.dataset_title, r.severity, r.no_result ? '' : r.pass_percentage, r.failed_rows ?? ''])];
  saveBlob(new Blob([`\ufeff${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }), `bdc_rules_${delta ? 'semimonthly' : 'quarterly'}.csv`);
};

const copyText = (text, toast, what) => {
  if (!navigator.clipboard?.writeText) { toast('Copy is not available here; select the text and copy it', 'bad'); return; }
  navigator.clipboard.writeText(text).then(() => toast(`${what} copied`, 'ok'), () => toast('Copy is blocked by the browser', 'bad'));
};

const saveBlob = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

const isTrue = (v) => v === true || ['true', '1', 'y', 'yes'].includes(String(v ?? '').trim().toLowerCase());

const parseColorColumns = (str) => {
  if (!str) return [null, null];
  const parts = String(str).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [parts[0] || null, parts[1] || null];
};

// Keep in sync with backend/diff_color_rules.py
const DIFF_COLOR_RULES = [
  { diffCol: 'DIFFERENCE_ACTUAL_SUBMISSION_VS_MODIFIED_SUBMISSION_DATE', targets: ['ACTUAL_SUBMISSION_DATE', 'ACTUAL_SUBMISSION_MODIFIED_DATE'], requireNotNull: ['ACTUAL_SUBMISSION_DATE'], mode: 'days' },
  { diffCol: 'DIFFERENCE_EVENT_CREATED_VS_SUBMISSION_DATE', targets: ['ACTUAL_SUBMISSION_DATE'], requireNotNull: [], mode: 'sign' },
  { diffCol: 'DIFFERENCE_ACTUAL_APPROVAL_VS_MODIFIED_APPROVAL_DATE', targets: ['ACTUAL_APPROVED_DATE', 'ACTUAL_APPROVED_MODIFIED_DATE'], requireNotNull: [], mode: 'days' },
];

const isNullish = (v) => v === null || v === undefined || v === '';
// Calendar days between two dates, like Snowflake DATEDIFF('day'), which the
// colour filter and the Excel export use. Rounding hours up made a row read
// yellow under the "Within 7 days" filter.
const calDay = (v) => {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  // a zone-less value is already an Eastern wall date; anything else is placed in ET
  if (m && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = toDate(v);
  if (!d) return null;
  const p = Object.fromEntries(ET_PARTS.formatToParts(d).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day);
};
const dayDiff = (a, b) => {
  const d1 = calDay(a);
  const d2 = calDay(b);
  if (d1 === null || d2 === null) return null;
  return Math.abs(Math.round((d1 - d2) / 864e5));
};
const bandOfDays = (d) => (d === null ? 'r' : d <= 7 ? 'g' : d <= 15 ? 'y' : 'r');
const RANK = { g: 0, y: 1, r: 2 };

// Per-cell colour bands for a page of failed rows: the rule's COLOR_COLUMNS
// day difference, the fixed DIFFERENCE_* rules, or (consolidated report) each
// rule listed in FAILURE_MODE. Returns, per row, { colIndex: ['g','r',...] }.
const cellBands = (columns, rows, { colorColumns = null, ruleColorMap = null } = {}) => {
  const idx = {};
  columns.forEach((c, i) => { idx[String(c).trim().toUpperCase()] = i; });
  const [c1, c2] = parseColorColumns(colorColumns);
  const i1 = c1 ? idx[c1] : undefined;
  const i2 = c2 ? idx[c2] : undefined;
  const fm = idx.FAILURE_MODE;
  const diffRules = DIFF_COLOR_RULES
    .map((spec) => ({ spec, targets: spec.targets.filter((t) => t in idx).map((t) => idx[t]) }))
    .filter((r) => r.spec.diffCol in idx && r.targets.length);

  return rows.map((row) => {
    const out = {};
    const add = (ci, band) => { (out[ci] ??= []).push(band); };
    if (ruleColorMap && fm !== undefined && row[fm]) {
      for (const rid of String(row[fm]).split(',').map((s) => s.trim())) {
        const pair = ruleColorMap[rid];
        if (!pair?.[0] || !pair?.[1]) continue;
        const a = idx[String(pair[0]).toUpperCase()];
        const b = idx[String(pair[1]).toUpperCase()];
        if (a === undefined || b === undefined) continue;
        const band = bandOfDays(dayDiff(row[a], row[b]));
        add(a, band);
        add(b, band);
      }
    } else if (i1 !== undefined && i2 !== undefined) {
      const band = bandOfDays(dayDiff(row[i1], row[i2]));
      add(i1, band);
      add(i2, band);
    }
    for (const { spec, targets } of diffRules) {
      let band;
      if (spec.requireNotNull.some((c) => idx[c] === undefined || isNullish(row[idx[c]]))) band = 'r';
      else {
        const raw = row[idx[spec.diffCol]];
        const n = parseFloat(String(raw ?? '').trim());
        if (isNullish(raw) || Number.isNaN(n)) band = 'r';
        else if (spec.mode === 'sign') band = n >= 0 ? 'g' : 'r';
        else band = bandOfDays(Math.abs(n));
      }
      targets.forEach((ci) => add(ci, band));
    }
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort((a, b) => RANK[b] - RANK[a]);
    return out;
  });
};

const BAND_BG = { g: 'rgba(83,206,118,.16)', y: 'rgba(251,224,88,.3)', r: 'rgba(235,23,0,.1)' };

// Finds known rule ids in validation output, so the progress bar moves with real work.
const ruleIdPattern = (ids) => {
  const safe = ids.filter(Boolean).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return safe.length ? new RegExp(`\\b(${safe.join('|')})\\b`, 'g') : null;
};

// Rules table filtering and sorting, shared by the explorer and the palette.
const SORTS = {
  title: (r) => r.rule_title.toLowerCase(),
  sev: (r) => sevRank(r.severity),
  pass: (r) => r.pass_percentage,
  failed: (r) => r.failed_rows ?? -1,
};
const SORT_KEYS = Object.keys(SORTS);

const filterRules = (rules, { q, sev, health: h, ds }, sort) => {
  const qq = q.trim().toLowerCase();
  const list = rules.filter((r) => (!qq || [r.rule_id, r.rule_title, r.dataset_title].some((x) => x.toLowerCase().includes(qq)))
    && (!sev.size || sev.has(r.severity)) && (h === 'all' || r.h === h) && (!ds || r.dataset_title === ds));
  const val = SORTS[sort.key];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x > y ? 1 : x < y ? -1 : a.rule_id.localeCompare(b.rule_id)) * dir;
  });
};

const DELTA_SHEETS = ['new_failures', 'resolved_rows', 'persisting_rows'];

const pairBand = (a, b) => bandOfDays(dayDiff(a, b));

const deltaSubtitle = (rule, data) => {
  if (!data) return rule ? rule.rule_title : '';
  const toLabel = /\d{8}_\d{6}$/.test(data.to_table || '') ? fmtRunSuffix(data.to_table) : 'the latest run';
  return `${fmtRunSuffix(data.from_table)} run vs ${toLabel}`;
};

const REVIEW_FILTERS = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const enc = encodeURIComponent;
const qs = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${enc(v)}`)
  .join('&');

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await apiFetch(path, { method, body, signal });
  if (!res.ok) {
    let detail = res.statusText || `Request failed (${res.status})`;
    try {
      const parsed = await res.json();
      const d = parsed?.detail ?? parsed?.message;
      if (d) detail = typeof d === 'string' ? d : JSON.stringify(d);
    } catch {
      /* body was not JSON; keep the status text */
    }
    throw new HttpError(detail, res.status);
  }
  return res.json();
}

const get = (path, signal) => request(path, { signal });
const post = (path, body, signal) => request(path, { method: 'POST', body: body ?? {}, signal });
const put = (path, body) => request(path, { method: 'PUT', body });
const patch = (path, body) => request(path, { method: 'PATCH', body });

const api = {
  summary: (delta, refresh, signal) => get(`/api/bdc/summary?${qs({ delta_mode: delta, refresh: refresh || undefined })}`, signal),
  badge: (delta, signal) => get(`/api/review/badge?delta_mode=${delta}`, signal),
  trends: (id, delta, signal) => get(`/api/trends/${enc(id)}?delta_mode=${delta}`, signal),
  registry: (id, signal) => get(`/api/rules/${enc(id)}/registry`, signal),
  failedCount: (id, delta, signal) => get(`/api/rules/${enc(id)}/failed-rows-count?delta_mode=${delta}`, signal),
  failedRows: (id, { page, size, color = 'ALL', delta, sort }, signal) =>
    post(`/api/rules/${enc(id)}/failed-rows?${qs({ page, page_size: size, color_filter: color, delta_mode: delta, sort_col: sort?.col, sort_dir: sort?.dir })}`, {}, signal),
  deltaRows: (id, { sheet, page, size, from, to, delta, sort }, signal) =>
    post(`/api/rules/${enc(id)}/delta-rows?${qs({ sheet, page, page_size: size, stg_table: from, to_stg_table: to, delta_mode: delta, sort_col: sort?.col, sort_dir: sort?.dir })}`, {}, signal),
  stgTables: (id, delta, signal) => get(`/api/rules/${enc(id)}/stg-tables?delta_mode=${delta}`, signal),

  reviewRules: (delta, signal) => get(`/api/review/rules?delta_mode=${delta}`, signal),
  reviewHistory: (ruleId, delta, signal) => get(`/api/review/history?${qs({ rule_id: ruleId, limit: 1000, delta_mode: delta })}`, signal),
  submitReview: (body, delta) => post(`/api/review/submit?delta_mode=${delta}`, body),
  approveBulk: (ruleIds, note, delta) => post(`/api/review/approve-bulk?delta_mode=${delta}`, { rule_ids: ruleIds, note }),
  undoReviews: (reviewIds) => post('/api/review/undo', { review_ids: reviewIds }),

  dqTable: (type, page, size, signal) => get(`/api/admin/dq-tables/${type}?page=${page}&page_size=${size}`, signal),
  dqTableSchema: (signal) => get('/api/admin/dq-tables/rule-input/schema', signal),
  dqRow: (type, key, signal) => get(`/api/admin/dq-tables/${type}/row?key=${enc(key)}`, signal),
  toggleRuleActive: (ruleId, isActive) => patch('/api/admin/dq-tables/rule-input/toggle-active', { rule_id: ruleId, is_active: isActive }),
  createRule: (row) => post('/api/admin/dq-tables/rule-input/row', { row }),
  updateRule: (pkCol, pkVal, updates) => put('/api/admin/dq-tables/rule-input/row', { primary_key_col: pkCol, primary_key_val: pkVal, updates }),
  ruleDatasets: (signal) => get('/api/admin/dq-tables/rule-input/datasets', signal),
  nextVersion: (ruleId, signal) => get(`/api/admin/dq-tables/rule-input/next-version?rule_id=${enc(ruleId)}`, signal),
  createDateRow: (row) => post('/api/admin/dq-tables/date-input/row', { row }),
  updateDateRow: (id, updates) => put('/api/admin/dq-tables/date-input/row', { id, updates }),
  toggleDateActive: (id, isActive) => patch('/api/admin/dq-tables/date-input/toggle-active', { id, is_active: isActive }),
  databases: (conn, signal) => get(`/api/admin/tables/databases?${qs({ connection_type: conn })}`, signal),
  schemas: (conn, database, signal) => get(`/api/admin/tables/schemas?${qs({ connection_type: conn, database })}`, signal),
  tableNames: (conn, database, schema, signal) => get(`/api/admin/tables/table-names?${qs({ connection_type: conn, database, schema })}`, signal),
  columns: (conn, database, schema, table, signal) => get(`/api/admin/tables/columns?${qs({ connection_type: conn, database, schema, table })}`, signal),
  runs: (signal) => get('/api/bdc/runs?limit=100', signal),

  consolidatedLatest: (delta, signal) => get(`/api/consolidated-report/latest?delta_mode=${delta}`, signal),
  consolidatedHistory: (delta, signal) => get(`/api/consolidated-report/history?delta_mode=${delta}`, signal),
  consolidatedFetch: (name, delta, signal) => get(`/api/consolidated-report/fetch?${qs({ report_name: name, delta_mode: delta })}`, signal),
};

const audit = (action, target = '', details = '') => {
  apiFetch('/api/audit/log', { method: 'POST', body: { action, target, details } })
    .catch(() => { /* the audit trail must never break the page */ });
};

// Subscribes to a server-sent event stream. Resolves when `isLast(event)` says
// so, rejects on an error event, a dropped connection or an abort.
const stream = (path, { onEvent, isLast = (e) => e.type === 'done' || e.type === 'ready', rejectOnError = true, signal } = {}) =>
  new Promise((resolve, reject) => {
    const es = apiEventSource(path);
    const stop = () => es.close();
    const abort = () => {
      stop();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    es.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      onEvent?.(data);
      if (data.type === 'error' && rejectOnError) {
        stop();
        signal?.removeEventListener('abort', abort);
        reject(new Error(data.message || 'The server reported an error'));
      } else if (isLast(data)) {
        stop();
        signal?.removeEventListener('abort', abort);
        resolve(data);
      }
    };
    es.onerror = (e) => {
      stop();
      signal?.removeEventListener('abort', abort);
      reject(new Error(e?.status ? (e.message || `The server refused the request (${e.status})`) : 'Connection to the server was lost'));
    };
    es.onend = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('The server closed the stream before it finished'));
    };
  });

// Reads a download body with progress and hands the file to the browser.
async function downloadWithProgress(path, { fallbackName, onProgress, signal }) {
  const res = await apiFetch(path, { signal });
  if (res.status === 404) throw new HttpError('The prepared file has expired. Please try again.', 404);
  if (!res.ok) {
    let detail = `Download failed (${res.status})`;
    try {
      const d = (await res.json())?.detail;
      if (typeof d === 'string' && d) detail = d;
    } catch {
      /* body was not JSON; keep the status */
    }
    throw new HttpError(detail, res.status);
  }
  const total = Number(res.headers.get('Content-Length')) || 0;
  const disposition = res.headers.get('Content-Disposition') || '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  return { blob: new Blob(chunks), name: named ? decodeURIComponent(named[1]) : fallbackName };
}

// ── query cache ──────────────────────────────────────────────────────────────
// Shared by every view on the page: switching tabs or cadence paints from what
// is already here and refreshes in the background. Each key has one request in
// flight at most; a newer request always wins over an older, slower one.
const cache = new Map();

const entryFor = (key) => {
  let e = cache.get(key);
  if (!e) {
    e = { data: undefined, error: null, at: 0, inflight: null, seq: 0, subs: new Set(), fetcher: null };
    cache.set(key, e);
  }
  return e;
};
const notify = (e) => e.subs.forEach((fn) => fn());

function loadQuery(key, fetcher, { force = false } = {}) {
  const e = entryFor(key);
  e.fetcher = fetcher;
  if (e.inflight && !force) return e.inflight.promise;
  e.inflight?.ctrl.abort();
  const ctrl = new AbortController();
  const id = ++e.seq;
  const promise = Promise.resolve()
    .then(() => fetcher(ctrl.signal))
    .then(
      (data) => {
        if (id !== e.seq) return;
        e.data = data;
        e.error = null;
        e.at = Date.now();
      },
      (err) => {
        if (id !== e.seq || err?.name === 'AbortError') return;
        e.error = err;
      },
    )
    .finally(() => {
      if (id !== e.seq) return;
      e.inflight = null;
      notify(e);
    });
  e.inflight = { promise, ctrl };
  notify(e);
  return promise;
}

function setQueryData(key, updater) {
  const e = entryFor(key);
  e.data = typeof updater === 'function' ? updater(e.data) : updater;
  e.at = Date.now();
  notify(e);
}

// Marks matching entries stale; the ones on screen refetch right away.
function refetchQueries(prefix) {
  for (const [key, e] of cache) {
    if (!key.startsWith(prefix)) continue;
    e.at = 0;
    if (e.subs.size && e.fetcher) loadQuery(key, e.fetcher, { force: true });
  }
}

function useQuery(key, fetcher, { ttl = 30000, enabled = true } = {}) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => {
    if (!enabled || !key) return undefined;
    const e = entryFor(key);
    e.subs.add(rerender);
    if (!e.inflight && (e.data === undefined || Date.now() - e.at > ttl || e.error)) {
      loadQuery(key, (signal) => fetcherRef.current(signal));
    }
    rerender();
    return () => {
      e.subs.delete(rerender);
      if (!e.subs.size && e.inflight) {
        e.inflight.ctrl.abort();
        e.inflight = null;
        e.seq += 1;
      }
    };
  }, [key, enabled, ttl]);

  const e = key && enabled ? cache.get(key) : undefined;
  const reload = useCallback(
    (opts) => (key ? loadQuery(key, (signal) => fetcherRef.current(signal), { force: true, ...opts }) : Promise.resolve()),
    [key],
  );
  return {
    data: e?.data,
    error: e?.error || null,
    loading: !!e && e.data === undefined && (!!e.inflight || (!e.error && !e.at)),
    refreshing: !!e?.inflight && e.data !== undefined,
    reload,
  };
}

// ── URL state ────────────────────────────────────────────────────────────────
// Everything a person would want back after a refresh or a shared link lives
// in the query string. Layers (drawer, modal) push a history entry so Back
// closes them; closing one ourselves pops that entry instead of piling up.
function useUrlState() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useRef({ state: location.state, depth: location.state?.bdxLayer || 0 });
  useEffect(() => { nav.current = { state: location.state, depth: location.state?.bdxLayer || 0 }; }, [location.state]);
  // The router's functional setter is handed the params of the last render, so
  // two updates in one click (close the drawer, then switch tab) used to lose
  // the first. Each update builds on the one before it instead.
  // Layout effects run before any passive effect in the tree, so a child that
  // updates the URL from its own effect already sees the committed params.
  const latest = useRef(params);
  useLayoutEffect(() => { latest.current = params; }, [params]);
  const setRef = useRef(setParams);
  useLayoutEffect(() => { setRef.current = setParams; }, [setParams]);

  const update = useCallback((patch, { push = false, layer = false, clearLayer = false } = {}) => {
    const { state, depth } = nav.current;
    const next = new URLSearchParams(latest.current);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '' || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    latest.current = next;
    const nextState = layer ? { bdxLayer: depth + 1 } : push || clearLayer ? null : state;
    nav.current = { state: nextState, depth: nextState?.bdxLayer || 0 };
    setRef.current(next, { replace: !push, state: nextState });
  }, []);

  const closeLayer = useCallback((keys) => {
    if (nav.current.depth > 0) navigate(-1);
    else update(Object.fromEntries(keys.map((k) => [k, null])));
  }, [navigate, update]);

  return { params, update, closeLayer };
}

// ── small utilities ──────────────────────────────────────────────────────────

// Calls fn at most once per animation frame with the latest arguments.
function useRafCallback(fn) {
  const fnRef = useRef(fn);
  const frame = useRef(0);
  const args = useRef(null);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return useCallback((...a) => {
    args.current = a;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      fnRef.current(...args.current);
    });
  }, []);
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Keeps Tab inside an open dialog and gives focus back to whatever opened it.
function useFocusTrap(ref, active) {
  useEffect(() => {
    if (!active) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    const opener = document.activeElement;
    // a field the body asks for, else the dialog's close button, else the first control
    const first = () => node.querySelector('[data-autofocus]:not(.m-x)') || node.querySelector('.m-x') || node.querySelector(FOCUSABLE) || node;
    const t = setTimeout(() => {
      if (!node.contains(document.activeElement)) first().focus({ preventScroll: true });
    }, 30);
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [a, b] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      node.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

function useElementWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)));
    ro.observe(node);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// ── toasts ───────────────────────────────────────────────────────────────────

const ToastContext = createContext(() => {});
const useToast = () => useContext(ToastContext);

const I = ({ n, style, className = '' }) => (
  <i className={`ico ${className}`} style={{ '--i': `url("${ICONS[n]}")`, ...style }} aria-hidden="true" />
);

const SevBadge = ({ s }) => (
  <span className={`sev ${['CRITICAL', 'HIGH', 'MEDIUM'].includes(s) ? s : 'LOW'}`}><i className="d" />{s || 'NONE'}</span>
);

const HealthBadge = ({ p, h: key }) => {
  const h = HEALTH[key || health(p)];
  return <span className={`hb ${h.cls}`}><I n={h.icon} />{h.label}</span>;
};

const PassBar = ({ p, delay = 0, none = false }) => (
  <div className="pb">
    <div className="track">{!none && <div className="fill" style={{ width: `${clamp(+p || 0, 0, 100)}%`, background: HEALTH[health(p)].color, animationDelay: `${delay}ms` }} />}</div>
    <b>{none ? '-' : pct(p)}</b>
  </div>
);

const Ring = memo(function Ring({ p, size = 46, stroke = 5, color, label = true, fs, none = false }) {
  const ref = useRef(null);
  const rad = (size - stroke) / 2;
  const c = 2 * Math.PI * rad;
  const target = none ? c : c * (1 - clamp(+p || 0, 0, 100) / 100);
  useEffect(() => {
    const el = ref.current;
    let a = 0;
    let b = 0;
    a = requestAnimationFrame(() => { b = requestAnimationFrame(() => { if (el) el.style.strokeDashoffset = target; }); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, [target]);
  return (
    <span className="ringw" style={{ width: size, height: size }} aria-label={none ? 'No result' : `${pct(p)} pass rate`} role="img">
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="#e8e6e3" strokeWidth={stroke} />
        <circle ref={ref} className="p" cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={color || HEALTH[health(p)].color}
          strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c} />
      </svg>
      {label && <span className="rnum" style={{ fontSize: fs || Math.round(size * 0.26) }} aria-hidden="true">{none ? '-' : Math.round(+p || 0)}</span>}
    </span>
  );
});

const Spark = memo(function Spark({ values, w = 90, h = 28, color = '#0f68b2', area = true, fluid = false }) {
  const id = useId().replace(/:/g, '');
  if (!values || values.length < 2) {
    return <svg width={fluid ? '100%' : w} height={h} aria-hidden="true"><line x1="0" x2={fluid ? '100%' : w} y1={h / 2} y2={h / 2} stroke="#d5cfc9" strokeDasharray="3 4" /></svg>;
  }
  const lo = Math.min(...values) - 2;
  const hi = Math.max(...values) + 2;
  const pts = values.map((v, i) => [(i * w) / (values.length - 1), h - ((v - lo) / (hi - lo || 1)) * h]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg width={fluid ? '100%' : w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio={fluid ? 'none' : undefined} style={{ overflow: 'visible' }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".25" /><stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={`${d}L${w},${h}L0,${h}Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} vectorEffect={fluid ? 'non-scaling-stroke' : undefined} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {!fluid && <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} />}
    </svg>
  );
});

// Animates a number by writing straight to the DOM, so counting never re-renders React.
function CountUp({ value, dec = 0, suffix = '', start = true, dur = 1200 }) {
  const ref = useRef(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !start) return undefined;
    const a = shown.current;
    const t0 = performance.now();
    let raf = 0;
    const show = (v) => {
      shown.current = v;
      el.firstChild.nodeValue = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    };
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      show(a + (value - a) * (1 - (1 - k) ** 4));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, dec, start, dur]);
  return <span ref={ref}>{'0'}{suffix}</span>;
}

const Code = ({ sql, onCopy }) => (
  <div className="code">
    {onCopy && <button type="button" className="cp" onClick={onCopy}><I n="save" />Copy</button>}
    {sqlTokens(sql).map((tok, i) => (tok.cls ? <span key={i} className={tok.cls}>{tok.t}</span> : tok.t))}
  </div>
);

const Empty = ({ icon = 'filter', title, children }) => (
  <div className="empty"><div className="ei"><I n={icon} /></div><h4>{title}</h4>{children && <p>{children}</p>}</div>
);

const ErrorState = ({ error, onRetry, title = 'Could not load this' }) => (
  <div className="err" role="alert">
    <div className="ei"><I n="alert" /></div>
    <h4>{title}</h4>
    <p>{error?.message || String(error || 'Something went wrong.')}</p>
    {onRetry && <button type="button" className="btn sm ghost" onClick={onRetry}><I n="refresh" />Try again</button>}
  </div>
);

const InlineError = ({ error, onRetry }) => (
  <div className="inline-err" role="alert">
    <I n="alert" /><span>{error?.message || String(error)}</span>
    {onRetry && <button type="button" className="btn sm ghost" onClick={onRetry}>Retry</button>}
  </div>
);

const Sk = ({ w = '100%', h = 12, r, className = '', style }) => (
  <span className={`sk ${className}`} style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />
);

const SkRows = ({ rows = 6, cols = 4 }) => (
  <div aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div className="sk-row" key={i}>
        <Sk w={72} h={22} r={6} />
        <div className="sk-stack"><Sk w={`${70 - ((i * 13) % 30)}%`} h={13} /><Sk w="30%" h={10} /></div>
        {Array.from({ length: cols - 2 }, (_, j) => <Sk key={j} w={90} h={12} />)}
      </div>
    ))}
  </div>
);

const Pager = ({ page, pages, onPage, disabled, children }) => (
  <div className="pager">
    {children}
    <span style={{ flex: 1 }} />
    <button type="button" className="btn sm ghost" disabled={disabled || page <= 1} onClick={() => onPage(1)}>First</button>
    <button type="button" className="btn sm ghost" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
    <label className="pg-jump">Page
      <input key={page} type="number" min={1} max={pages} defaultValue={page} disabled={disabled || pages <= 1} aria-label={`Page number, 1 to ${pages}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape' && e.currentTarget.value !== String(page)) { e.stopPropagation(); e.currentTarget.value = page; }
        }}
        onBlur={(e) => {
          const n = Math.min(pages, Math.max(1, Math.round(Number(e.currentTarget.value)) || page));
          e.currentTarget.value = n;
          if (n !== page) onPage(n);
        }} />
      of {pages}
    </label>
    <button type="button" className="btn sm ghost" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    <button type="button" className="btn sm ghost" disabled={disabled || page >= pages} onClick={() => onPage(pages)}>Last</button>
  </div>
);

// Content stays mounted for the length of the closing transition.
function useLatched(open, content, ms) {
  const [kept, setKept] = useState(open ? content : null);
  useEffect(() => {
    if (open) { setKept(content); return undefined; }
    const t = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(t);
  }, [open, content, ms]);
  return open ? content : kept;
}

function Drawer({ open, label, children }) {
  const ref = useRef(null);
  const body = useLatched(open, children, 520);
  useFocusTrap(ref, open);
  return (
    <div ref={ref} className={`drawer ${open ? 'on' : ''}`} role="dialog" aria-modal="true" aria-label={label}
      aria-hidden={!open} inert={!open} tabIndex={-1}>
      {body}
    </div>
  );
}

function Modal({ open, wide, title, sub, actions, onClose, foot, footClass = '', bare = false, children, label }) {
  const ref = useRef(null);
  const titleId = useId();
  const content = useMemo(() => (open ? { title, sub, actions, foot, children, footClass, bare } : null), [open, title, sub, actions, foot, children, footClass, bare]);
  const shown = useLatched(open, content, 360);
  const [full, setFull] = useState(false);
  if (!open && full) setFull(false);
  useFocusTrap(ref, open);
  return (
    <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${full ? 'full' : ''} ${open ? 'on' : ''}`} role="dialog" aria-modal="true"
      aria-labelledby={shown ? titleId : undefined} aria-label={shown ? undefined : label} aria-hidden={!open} inert={!open} tabIndex={-1}>
      {shown && (
        <>
          <div className="m-h">
            <div style={{ minWidth: 0 }}><h3 id={titleId}>{shown.title}</h3>{shown.sub && <p>{shown.sub}</p>}</div>
            <div className="m-c" />
            <div className="m-act">
              {shown.actions}
              {wide && (
                <button type="button" className="icon-btn" onClick={() => setFull((f) => !f)} aria-pressed={full}
                  aria-label={full ? 'Exit full screen' : 'Full screen'} data-tip={full ? 'Exit full screen' : 'Full screen'} data-tip-always="">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {full
                      ? <path d="M6 1.5V6H1.5M10 1.5V6h4.5M6 14.5V10H1.5M10 14.5V10h4.5" />
                      : <path d="M1.5 6V1.5H6M14.5 6V1.5H10M1.5 10v4.5H6M14.5 10v4.5H10" />}
                  </svg>
                </button>
              )}
              <button type="button" className="icon-btn m-x" onClick={onClose} aria-label="Close dialog"><I n="close" /></button>
            </div>
          </div>
          {shown.bare ? shown.children : <div className="m-b">{shown.children}</div>}
          {!shown.bare && shown.foot && <div className={`m-f ${shown.footClass}`}>{shown.foot}</div>}
        </>
      )}
    </div>
  );
}

const TOAST_LOOK = { ok: ['#328714', 'check'], bad: ['#eb1700', 'close'], info: ['#0f68b2', 'info'] };

function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((msg, kind = 'ok', action, onAction) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems((list) => [...list.slice(-3), { id, msg, kind, action, onAction }]);
    timers.current.set(id, setTimeout(() => dismiss(id), action ? 6000 : 4000));
  }, [dismiss]);
  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="bdx bdx-layer">
          <div className="toasts" role="status" aria-live="polite">
            {items.map((t) => {
              const [c, icon] = TOAST_LOOK[t.kind] || TOAST_LOOK.info;
              return (
                <div className="toast" key={t.id}>
                  <span className="ti" style={{ background: c }}><I n={icon} /></span>
                  <span>{t.msg}</span>
                  {t.action && <button type="button" onClick={() => { dismiss(t.id); t.onAction?.(); }}>{t.action}</button>}
                  <span className="tl" style={{ animationDuration: t.action ? '6s' : '4s' }} />
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

// One styled tooltip for every truncated label on the page. Elements opt in
// with data-tip (full text). It only shows when the text is actually cut off,
// unless data-tip-always is set (icon buttons).
function TruncationTip() {
  const ref = useRef(null);
  useEffect(() => {
    const tip = ref.current;
    let current = null;
    let raf = 0;
    const hide = () => { current = null; tip.classList.remove('on'); };
    const place = (el) => {
      const r = el.getBoundingClientRect();
      tip.style.left = '0px';
      tip.style.top = '0px';
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
      let y = r.top - th - 8;
      if (y < 8) y = r.bottom + 8;
      x = Math.round(x);
      y = Math.round(Math.min(y, window.innerHeight - th - 8));
      tip.style.transform = `translate(${x}px,${y}px)`;
    };
    let watch = 0;
    const show = (el) => {
      clearInterval(watch);
      const text = el.getAttribute('data-tip');
      if (!text) return;
      const always = el.hasAttribute('data-tip-always');
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (!always && !cut) return;
      current = el;
      tip.textContent = text;
      tip.classList.toggle('mono', el.hasAttribute('data-tip-mono'));
      place(el);
      tip.classList.add('on');
      watch = setInterval(() => { if (!current?.isConnected) { hide(); clearInterval(watch); } }, 250);
    };
    const over = (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el === current) return;
      cancelAnimationFrame(raf);
      if (!el) { hide(); return; }
      raf = requestAnimationFrame(() => show(el));
    };
    // keyboard focus only: a dialog focusing its first button on open popped that button's tip
    const focus = (e) => { const el = e.target.closest?.('[data-tip]'); if (el && e.target.matches?.(':focus-visible')) show(el); };
    const blur = () => hide();
    document.addEventListener('pointerover', over, { passive: true });
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('scroll', hide, { passive: true, capture: true });
    document.addEventListener('pointerdown', hide, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(watch);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('scroll', hide, { capture: true });
      document.removeEventListener('pointerdown', hide);
    };
  }, []);
  return createPortal(<div className="bdx bdx-layer"><div ref={ref} className="bdx-ttip" aria-hidden="true" /></div>, document.body);
}

const Toggle = ({ on, onClick, label, disabled, busy }) => (
  <button type="button" className={`tog ${on ? 'on' : ''} ${busy ? 'busy' : ''}`} role="switch" aria-checked={!!on}
    aria-label={label} onClick={onClick} disabled={disabled || busy} />
);

// Relative time that keeps itself current without re-rendering its parent.
function Ago({ v }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);
  return <>{ago(v)}</>;
}

// Hero canvases, built for Cloud PCs with no GPU: every pixel is rasterised on
// the CPU, so backing stores stay at 1x (the small dial goes up to 2x until the
// governor trips), frames are capped, nothing uses
// shadowBlur or per-frame gradients, static layers are cached offscreen,
// drawing stops while the hero is off screen or the tab is hidden, and a
// frame-time governor drops to a lighter scene when frames run long.


const TAU = Math.PI * 2;
const ACCENT = '235,23,0';
const BAR = { ok: 'rgba(50,135,20,.55)', warn: '#ff6017', crit: '#eb1700' };
const DS_COLOR = { ok: '#328714', warn: '#ff6017', crit: '#eb1700' };
const ease = (x) => 1 - (1 - clamp(x, 0, 1)) ** 3;

const fit = (c, dpr = 1) => {
  const w = Math.max(1, Math.round(c.clientWidth));
  const h = Math.max(1, Math.round(c.clientHeight));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (c.width !== bw) c.width = bw;
  if (c.height !== bh) c.height = bh;
  const ctx = c.getContext('2d', { alpha: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
};

// One loop drives every canvas in the hero. It only runs while the hero is on
// screen and the tab is visible, so a scrolled-away page costs nothing.
// `still` (GPU-less machines, reduced motion, or a governor trip) turns off the
// continuous motion: each canvas then repaints only when something on it
// changed, and the loop stops completely in between. With software
// compositing every repainted frame is a full-screen CPU blit, so an idle
// hero that keeps drawing costs most of a cloud PC's CPU.
function createHeroLoop(hero, still = false) {
  // The OS "reduce motion" setting is deliberately not followed on this page.
  const calm = false;
  const perf = { lite: calm || still, calm, still: calm || still, n: 0, total: 0, prev: 0 };
  const scenes = new Set();
  let visible = true;
  let raf = 0;
  let last = 0;

  const gap = () => (perf.lite ? 50 : 33);
  const sample = (t) => {
    if (perf.prev) {
      const d = t - perf.prev;
      if (d < 250) {
        perf.total += d;
        perf.n += 1;
        if (perf.n >= 45) {
          if (perf.total / perf.n > 40) { perf.lite = true; perf.still = true; }
          perf.n = 0;
          perf.total = 0;
        }
      }
    }
    perf.prev = t;
  };
  const wanted = (t) => [...scenes].some((s) => s.wants(t));
  const frame = (t) => {
    raf = 0;
    if (t - last >= gap()) {
      last = t;
      if (!perf.still) sample(t);
      scenes.forEach((s) => { if (s.wants(t)) s.draw(t); });
    }
    if (wanted(t)) raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    const run = visible && !document.hidden && scenes.size > 0;
    if (run && !raf) {
      perf.prev = 0;
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); });
  io.observe(hero);
  document.addEventListener('visibilitychange', sync);

  return {
    perf,
    add(scene) { scenes.add(scene); sync(); return () => { scenes.delete(scene); sync(); }; },
    // something changed on a canvas: draw it on the next frame
    wake: sync,
    setStill(v) {
      perf.still = v || calm || perf.still;
      perf.lite = perf.lite || perf.still;
      scenes.forEach((s) => s.touch?.());
      sync();
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      scenes.clear();
    },
  };
}

// Drifting node field behind the hero copy. `pointer` is written by the hero's
// pointer handler (once per frame) and only read here.
function createAmbient(canvas, loop, pointer) {
  const { perf } = loop;
  let g = fit(canvas);
  let nodes = [];
  let wasLite = perf.lite;
  const build = () => {
    const n = Math.round(Math.min(perf.lite ? 36 : 64, (g.w * g.h) / 28000));
    nodes = Array.from({ length: n }, () => ({
      x: Math.random() * g.w, y: Math.random() * g.h,
      vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
      r: 1 + Math.random() * 1.3, b: Math.random() < 0.65,
    }));
    nodes.sort((a, b) => a.x - b.x);
  };
  let dirty = true;
  build();
  const ro = new ResizeObserver(() => { g = fit(canvas); build(); dirty = true; loop.wake(); });
  ro.observe(canvas);

  const scene = {
    wants: () => !perf.still || dirty,
    touch() { dirty = true; },
    draw(now) {
      dirty = false;
      const t = perf.still ? 0 : now;
      if (wasLite !== perf.lite) { wasLite = perf.lite; build(); }
      const { ctx, w, h } = g;
      const step = 76;
      ctx.clearRect(0, 0, w, h);
      const ox = -(pointer.x - 0.5) * 30;
      const oy = -(pointer.y - 0.5) * 20;
      ctx.strokeStyle = 'rgba(175,165,155,.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -step; x < w + step; x += step) {
        const fx = Math.round(x + ox + ((t / 70) % step)) + 0.5;
        ctx.moveTo(fx, 0); ctx.lineTo(fx, h);
      }
      for (let y = -step; y < h + step; y += step) {
        const fy = Math.round(y + oy) + 0.5;
        ctx.moveTo(0, fy); ctx.lineTo(w, fy);
      }
      ctx.stroke();

      for (const n of perf.still ? [] : nodes) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < -10) n.x = w + 10; if (n.x > w + 10) n.x = -10;
        if (n.y < -10) n.y = h + 10; if (n.y > h + 10) n.y = -10;
      }
      // insertion sort: the order barely changes between frames
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        let j = i - 1;
        while (j >= 0 && nodes[j].x > n.x) { nodes[j + 1] = nodes[j]; j -= 1; }
        nodes[j + 1] = n;
      }
      if (!perf.lite) {
        ctx.strokeStyle = 'rgba(163,153,146,.12)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]; const b = nodes[j]; const dx = b.x - a.x;
            if (dx > 110) break;
            const dy = b.y - a.y;
            if (dx * dx + dy * dy < 12000) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
          }
        }
        ctx.stroke();
      }
      for (const blue of [true, false]) {
        ctx.fillStyle = blue ? 'rgba(15,104,178,.45)' : `rgba(${ACCENT},.4)`;
        ctx.beginPath();
        for (const n of nodes) if (n.b === blue) { ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, TAU); }
        ctx.fill();
      }
      if (pointer.active && !perf.still) {
        ctx.strokeStyle = 'rgba(235,23,0,.15)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (const n of nodes) {
          const dx = pointer.cx - n.x; const dy = pointer.cy - n.y;
          if (dx * dx + dy * dy < 25000) { ctx.moveTo(n.x, n.y); ctx.lineTo(pointer.cx, pointer.cy); }
        }
        ctx.stroke();
      }
    },
  };
  const remove = loop.add(scene);
  return { destroy() { remove(); ro.disconnect(); } };
}

// The health dial, read inside out like an instrument:
//   core      average pass arc with a live end marker
//   dataset   thin ring with titles bent along it
//   needles   one per rule; length = failure rate, colour = health, a cap at the tip
//   domains   a thick outer band, one slice per active domain in DQ_RULE_INPUT
//             (comb-hatched when the domain has no rules yet, so gaps show)
//   bezel     fine tick ring, then domain labels outside it
// A radar sweep circles the needles and lights each one as it passes. Hovering
// anything (or a legend chip) dims whatever is not related to it.
// All dial text is SVG laid over the canvas, so it stays sharp whatever the
// canvas backing resolution is (the governor drops the canvas to 1x on slow
// machines, which blurs canvas text on scaled displays). The canvas only measures.
const LABEL_PX = 10;
const DS_PX = 9;
const LABEL_FONT = `700 ${LABEL_PX}px JohnsonText, Arial`;
const DS_FONT = `700 ${DS_PX}px JohnsonText, Arial`;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};
// setAttribute only when the value changed: per-frame updates stay cheap.
const setA = (n, k, v) => { const s = String(v); if (n.getAttribute(k) !== s) n.setAttribute(k, s); };
const XLINK = 'http://www.w3.org/1999/xlink';
const setHref = (n, v) => {
  if (n.getAttribute('href') === v) return;
  n.setAttribute('href', v);
  n.setAttributeNS(XLINK, 'xlink:href', v);
};
let dialUid = 0;
const EMPTY = '#c9c1b9';
const INK = '#6e6259';
const DOM_GAP = 0.1;
const DS_GAP = 0.035;
const SWEEP_MS = 9000;    // one radar turn
const SWEEP_TAIL = 1.1;   // radians of afterglow behind the sweep line
// Domain names run long ("Regulatory Strategy & Planning"). Narrow lines keep
// the labels from eating the dial's width: up to three, then an ellipsis.
const LABEL_LINES = 3;
const LABEL_LH = 12;
const wrapLabel = (name, max = 13) => {
  const words = String(name || '').toUpperCase().split(/\s+/).filter(Boolean);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur || `${cur} ${w}`.length <= max) lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
    else lines.push(w);
  }
  const out = lines.slice(0, LABEL_LINES).map((l) => (l.length > max + 4 ? `${l.slice(0, max + 3)}…` : l));
  if (lines.length > LABEL_LINES) out[LABEL_LINES - 1] = `${out[LABEL_LINES - 1].slice(0, max - 1)}…`;
  return out;
};
const angDiff = (a, b) => ((((a - b) % TAU) + TAU * 1.5) % TAU) - Math.PI; // signed, -PI..PI
const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const NEEDLE = { ok: '#3d9a1c', warn: '#ff6017', crit: '#eb1700', none: '#a39992' };

function createDial(canvas, svg, loop, { onHover, onPick }) {
  const uid = `dial${(dialUid += 1)}`;
  const { perf } = loop;
  // Dial is small, so it gets a sharp backing store on hi-dpi screens; the governor drops it to 1x.
  const wantDpr = () => (perf.lite ? 1 : Math.min(2, window.devicePixelRatio || 1));
  let g = fit(canvas, wantDpr());
  let bars = [];
  let sig = '';
  let avg = 0;
  let showDomains = false;
  let born = performance.now();
  let geo = null;
  let layer = null;
  let sweep = null;
  let spin = 0;
  let labelW = 76;
  let charW = new Map();
  let hover = null;      // the hovered item
  let healthFocus = null; // 'ok' | 'warn' | 'crit' from the legend
  let at = null;         // last pointer position (client coords) while over the canvas
  let pending = false;
  let frame = 0;
  let dead = false;
  let dirty = true; // when still, the dial repaints only after a change
  const touch = () => { dirty = true; loop.wake(); };

  const measure = () => {
    const { ctx } = g;
    ctx.save();
    ctx.font = LABEL_FONT;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    for (const b of bars) if (b.kind === 'dom') b.textW = Math.max(...b.lines.map((l) => ctx.measureText(l).width));
    labelW = showDomains ? bars.reduce((m, b) => (b.kind === 'dom' ? Math.max(m, b.textW) : m), 40) : 0;
    ctx.font = DS_FONT;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    charW = new Map();
    for (const b of bars) if (b.kind === 'ds') for (const ch of `${b.label}…`) if (!charW.has(ch)) charW.set(ch, ctx.measureText(ch).width + 0.6);
    ctx.restore();
  };

  const layout = () => {
    const { w, h, dpr } = g;
    if (w < 200 || h < 120) { geo = null; return; }
    const narrow = w < 520;
    // Domain labels sit at R and run outward. If giving them room would shrink
    // the dial too far, drop them (the tooltip still names every domain).
    const lines = bars.reduce((m, b) => (b.kind === 'dom' ? Math.max(m, b.lines.length) : m), 1);
    const full = narrow ? Math.min(w * 0.47, h / 2) * 0.94 : Math.min(w * 0.36, h / 2 - 14);
    const fitted = Math.min(w * 0.35, h / 2 - 14 - ((lines - 1) * LABEL_LH) / 2, w / 2 - labelW - 16);
    const labels = showDomains && !narrow && fitted >= Math.max(150, full * 0.78);
    const R = labels ? fitted : full;
    const cr = R * 0.4;
    // The HTML readout in the core is sized in CSS; scale it with the core so it always fits.
    canvas.parentElement?.style.setProperty('--dial-core', clamp(cr / 92, 0.55, 1.15).toFixed(3));
    geo = {
      cx: w / 2, cy: h / 2, R, cr, narrow, labels,
      rDs: cr + 9,                          // dataset ring
      rDsText: cr + 18,                     // curved dataset titles
      r0: cr + 30,                          // needles start
      rDom: R * 0.86,                       // domain band centre
      domW: Math.max(5, R * 0.035),         // domain band thickness
      rTick: R * 0.92,                      // bezel
      rLabel: R * 1.0,                      // domain labels
    };
    geo.span = (showDomains ? R * 0.79 : R * 0.86) - geo.r0;

    // Everything that never moves is painted once and blitted each frame.
    layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
    const x = layer.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cx, cy, r0, span, rTick, rDom, domW } = geo;

    const glow = x.createRadialGradient(cx, cy, cr * 0.8, cx, cy, R * 0.95);
    glow.addColorStop(0, `rgba(${ACCENT},.10)`);
    glow.addColorStop(0.55, `rgba(${ACCENT},.035)`);
    glow.addColorStop(1, `rgba(${ACCENT},0)`);
    x.fillStyle = glow;
    x.beginPath(); x.arc(cx, cy, R * 0.95, 0, TAU); x.fill();

    // needle field: scale rings at 10 / 25 / 50% failure, and faint radial guides
    x.strokeStyle = 'rgba(163,153,146,.22)';
    x.lineWidth = 1;
    for (const q of [0.2, 0.5, 1]) {
      x.setLineDash(q === 1 ? [] : [1, 4]);
      x.beginPath(); x.arc(cx, cy, r0 + span * q, 0, TAU); x.stroke();
    }
    x.setLineDash([]);
    x.strokeStyle = 'rgba(163,153,146,.10)';
    x.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      x.lineTo(cx + Math.cos(a) * (r0 + span), cy + Math.sin(a) * (r0 + span));
    }
    x.stroke();
    // domain band track
    if (showDomains) {
      x.strokeStyle = 'rgba(163,153,146,.13)';
      x.lineWidth = domW;
      x.beginPath(); x.arc(cx, cy, rDom, 0, TAU); x.stroke();
    }

    // bezel: 120 ticks, every 10th long
    x.strokeStyle = 'rgba(110,98,89,.28)';
    x.lineWidth = 1;
    x.beginPath();
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * TAU;
      const len = i % 10 === 0 ? 7 : i % 5 === 0 ? 4.5 : 2.5;
      x.moveTo(cx + Math.cos(a) * rTick, cy + Math.sin(a) * rTick);
      x.lineTo(cx + Math.cos(a) * (rTick + len), cy + Math.sin(a) * (rTick + len));
    }
    x.stroke();

    // core: soft drop, white face, inner track for the average arc
    const drop = x.createRadialGradient(cx, cy + 5, cr * 0.9, cx, cy + 5, cr + 24);
    drop.addColorStop(0, 'rgba(49,44,42,.18)');
    drop.addColorStop(1, 'rgba(49,44,42,0)');
    x.fillStyle = drop;
    x.beginPath(); x.arc(cx, cy + 5, cr + 24, 0, TAU); x.fill();
    x.fillStyle = '#fff';
    x.beginPath(); x.arc(cx, cy, cr, 0, TAU); x.fill();
    x.strokeStyle = 'rgba(163,153,146,.35)';
    x.lineWidth = 1;
    x.beginPath(); x.arc(cx, cy, cr + 0.5, 0, TAU); x.stroke();
    x.lineWidth = 3;
    x.strokeStyle = '#efece8';
    x.beginPath(); x.arc(cx, cy, cr - 7, 0, TAU); x.stroke();

    // radar sweep: a conic afterglow painted once into a donut, rotated per frame
    const sr = Math.ceil(rDom + domW);
    sweep = document.createElement('canvas');
    sweep.width = sweep.height = Math.round(sr * 2 * dpr);
    const s = sweep.getContext('2d');
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (s.createConicGradient) {
      const cg = s.createConicGradient(-SWEEP_TAIL, sr, sr);
      const f = SWEEP_TAIL / TAU;
      cg.addColorStop(0, `rgba(${ACCENT},0)`);
      cg.addColorStop(f * 0.999, `rgba(${ACCENT},.11)`);
      cg.addColorStop(f, `rgba(${ACCENT},0)`);
      cg.addColorStop(1, `rgba(${ACCENT},0)`);
      s.fillStyle = cg;
      s.beginPath(); s.arc(sr, sr, sr, 0, TAU); s.fill();
    }
    s.strokeStyle = `rgba(${ACCENT},.35)`;
    s.lineWidth = 1;
    s.beginPath(); s.moveTo(sr + cr, sr); s.lineTo(sr * 2, sr); s.stroke();
    s.globalCompositeOperation = 'destination-out';
    s.fillStyle = '#000';
    s.beginPath(); s.arc(sr, sr, cr + 2, 0, TAU); s.fill();
    geo.sr = sr;
  };
  const refit = () => { g = fit(canvas, wantDpr()); layout(); placeStatic(); dirty = true; };
  layout();
  const ro = new ResizeObserver(refit);
  ro.observe(canvas);
  // Label widths depend on the web font. Canvas measuring never triggers a font
  // download, so request it, and re-measure whenever a font finishes loading.
  const remeasure = () => { if (!dead) { measure(); layout(); placeStatic(); touch(); } };
  const fonts = document.fonts;
  if (fonts) {
    Promise.allSettled([fonts.load(LABEL_FONT), fonts.load(DS_FONT)]).then(remeasure);
    fonts.addEventListener?.('loadingdone', remeasure);
  }

  // ── SVG text layer ──────────────────────────────────────────────────────────
  // Dataset titles ride a textPath on a circle drawn twice round (so a title
  // near the path start never gets clipped); one path runs clockwise for the
  // top half, one anticlockwise for the bottom half so no title is upside down.
  let paths = null;
  let scale = [];
  const trim = (text, room) => {
    let chars = [...text];
    const width = (cs) => cs.reduce((n, ch) => n + (charW.get(ch) || 5.5), 0);
    if (width(chars) <= room) return text;
    while (chars.length && width(chars) + (charW.get('…') || 6) > room) chars.pop();
    return chars.length < 2 ? '' : `${chars.join('')}…`;
  };
  const buildText = () => {
    svg.replaceChildren();
    const defs = svgEl('defs');
    paths = { cw: svgEl('path', { id: `${uid}-cw` }), ccw: svgEl('path', { id: `${uid}-ccw` }) };
    defs.append(paths.cw, paths.ccw);
    svg.append(defs);
    scale = [[0.2, '10%'], [0.5, '25%'], [1, '50%+']].map(([q, t]) => {
      const n = svgEl('text', { class: 'dt-scale' }, t);
      n.q = q;
      svg.append(n);
      return n;
    });
    for (const b of bars) {
      if (b.kind === 'ds') {
        b.tp = svgEl('textPath', { 'text-anchor': 'middle' });
        setHref(b.tp, `#${uid}-cw`);
        b.svg = svgEl('text', { class: 'dt-ds', 'dominant-baseline': 'central', style: 'display:none' });
        b.svg.append(b.tp);
        b.fit = null;
        svg.append(b.svg);
      } else if (b.kind === 'dom') {
        b.svg = svgEl('text', { class: 'dt-dom', style: 'display:none' });
        b.spans = b.lines.map((l) => svgEl('tspan', {}, l));
        b.svg.append(...b.spans);
        svg.append(b.svg);
      }
    }
    placeStatic();
  };
  const placeStatic = () => {
    if (!paths) return;
    const { w, h } = g;
    setA(svg, 'viewBox', `0 0 ${w} ${h}`);
    if (!geo) { svg.style.display = 'none'; return; }
    svg.style.display = '';
    const { cx, cy, rDsText: r, r0, span, narrow } = geo;
    const loop2 = (sweepFlag) => `M ${cx + r} ${cy} ${[0, 1, 2, 3].map((i) => `A ${r} ${r} 0 0 ${sweepFlag} ${cx + (i % 2 ? r : -r)} ${cy}`).join(' ')}`;
    paths.cw.setAttribute('d', loop2(1));
    paths.ccw.setAttribute('d', loop2(0));
    for (const n of scale) {
      setA(n, 'x', (cx + 4).toFixed(1));
      setA(n, 'y', (cy - (r0 + span * n.q) + 10).toFixed(1)); // just inside its ring, clear of the domain band
      // the inner marks crowd together on a small dial; keep only the outer one then
      n.style.display = narrow || (n.q < 1 && span * 0.3 < 16) ? 'none' : '';
    }
    for (const b of bars) if (b.kind === 'ds') b.fit = null; // arc room depends on radius
  };

  // What stays lit while something is focused: the item, its parents and its children.
  const related = (b) => {
    if (healthFocus) return b.kind === 'rule' ? b.h === healthFocus : b.healths.has(healthFocus);
    if (!hover) return true;
    if (hover.kind === 'rule') return b === hover || b.key === hover.dsKey || b.key === hover.domKey;
    if (hover.kind === 'ds') return b === hover || b.dsKey === hover.key || b.key === hover.domKey;
    return b === hover || b.domKey === hover.key;
  };

  // Analytic hit test against the geometry of the last painted frame, so the
  // whole of every needle and arc is hoverable whatever its size.
  const pick = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const out = { best: null, mx, my, w: r.width, h: r.height };
    if (!geo || mx < 0 || my < 0 || mx > r.width || my > r.height) return out;
    const { cx, cy, rDs, rDsText, r0, rDom, domW } = geo;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.hypot(dx, dy);
    const m = Math.atan2(dy, dx);
    const inArc = (b) => ((((m - (b.a0 + spin)) % TAU) + TAU) % TAU) <= b.a1 - b.a0;
    let bd = Infinity;
    for (const b of bars) {
      if (b.kind === 'dom') {
        if (!showDomains) continue;
        // hovering the label counts as hovering its slice
        if (b.box && mx >= b.box.x0 && mx <= b.box.x1 && my >= b.box.y0 && my <= b.box.y1) { bd = -1; out.best = b; continue; }
        const off = Math.abs(dist - rDom);
        if (off < domW / 2 + 6 && off < bd && inArc(b)) { bd = off; out.best = b; }
        continue;
      }
      if (b.kind === 'ds') {
        // the thin ring plus the band its title sits in
        if (dist > rDs - 7 && dist < rDsText + 6) {
          const off = Math.abs(dist - rDs) * 0.5;
          if (off < bd && inArc(b)) { bd = off; out.best = b; }
        }
        continue;
      }
      const da = angDiff(m, b.a + spin);
      if (Math.abs(da) > Math.PI / 2) continue;
      const along = dist * Math.cos(da);
      const perp = Math.abs(dist * Math.sin(da));
      if (perp < 7 && along > r0 - 4 && along < r0 + Math.max(b.len || 0, 14) + 8 && perp < bd) { bd = perp; out.best = b; }
    }
    return out;
  };

  const update = () => {
    if (!at) return;
    const { best, mx, my, w, h } = pick(at.x, at.y);
    if (best !== hover) touch();
    hover = best;
    canvas.style.cursor = best && best.kind !== 'dom' ? 'pointer' : '';
    onHover(best, mx, my, w, h);
  };

  const INTRO_MS = 1900; // needles and arcs grow in, then the dial holds still
  const scene = {
    wants: (t) => !perf.still || dirty || t - born < INTRO_MS,
    touch() { dirty = true; },
    draw(t) {
      dirty = false;
      if (g.dpr !== wantDpr()) refit();
      const { ctx, w, h } = g;
      ctx.clearRect(0, 0, w, h);
      if (!geo) return;
      const k = t - born;
      const { cx, cy, cr, rDs, rDsText, r0, rDom, domW, rLabel, span, sr } = geo;
      spin = perf.still ? 0 : t * (perf.calm ? 0.000006 : 0.000012);
      const grow = ease(k / 1200);
      const focusing = !!(hover || healthFocus);
      ctx.drawImage(layer, 0, 0, w, h);

      // radar sweep (skipped for reduced motion and on slow machines)
      const radar = !perf.calm && !perf.lite && bars.length > 0;
      const sweepA = (t / SWEEP_MS) * TAU;
      if (radar) {
        ctx.save();
        ctx.globalAlpha = focusing ? 0.35 : 1;
        ctx.translate(cx, cy);
        ctx.rotate(sweepA);
        ctx.drawImage(sweep, -sr, -sr, sr * 2, sr * 2);
        ctx.restore();
      }

      ctx.lineCap = 'round';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const on = hover === b;
        const lit = related(b);
        ctx.globalAlpha = focusing && !lit ? 0.22 : 1;

        if (b.kind === 'dom') {
          if (!showDomains) { if (b.svg) b.svg.style.display = 'none'; continue; }
          const a0 = b.a0 + spin + 0.014;
          const a1 = b.a1 + spin - 0.014;
          const end = a0 + Math.max(0, a1 - a0) * grow;
          ctx.lineCap = 'butt';
          if (b.empty) {
            // comb hatch: reads as "slot reserved, nothing in it yet"
            ctx.strokeStyle = on ? INK : EMPTY;
            ctx.lineWidth = domW;
            ctx.setLineDash([1.5, 3.5]);
            ctx.beginPath(); ctx.arc(cx, cy, rDom, a0, end); ctx.stroke();
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = b.color;
            ctx.lineWidth = on ? domW + 3 : domW;
            ctx.beginPath(); ctx.arc(cx, cy, rDom, a0, end); ctx.stroke();
            ctx.strokeStyle = rgba(b.color, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(cx, cy, rDom - domW / 2 - 4, a0, end); ctx.stroke();
          }
          ctx.lineCap = 'round';
          if (geo.labels) {
            const m = (b.a0 + b.a1) / 2 + spin;
            const cos = Math.cos(m);
            const sin = Math.sin(m);
            // leader tick from the band to the label
            ctx.strokeStyle = b.empty ? EMPTY : b.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cx + cos * (rDom + domW / 2 + 2), cy + sin * (rDom + domW / 2 + 2));
            ctx.lineTo(cx + cos * (rLabel - 8), cy + sin * (rLabel - 8));
            ctx.stroke();
            const lx = (cx + cos * rLabel).toFixed(1);
            const ly = cy + sin * rLabel + (Math.abs(cos) <= 0.2 ? Math.sign(sin) * 7 : 0) - ((b.lines.length - 1) * LABEL_LH) / 2;
            const anchor = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle';
            const left = anchor === 'start' ? +lx : anchor === 'end' ? lx - b.textW : lx - b.textW / 2;
            b.box = { x0: left - 4, x1: left + b.textW + 4, y0: ly - LABEL_LH / 2 - 3, y1: ly + (b.lines.length - 0.5) * LABEL_LH + 3 };
            setA(b.svg, 'text-anchor', anchor);
            setA(b.svg, 'fill', on && !b.empty ? b.color : b.empty ? '#9b918a' : INK);
            setA(b.svg, 'opacity', ctx.globalAlpha.toFixed(2));
            b.spans.forEach((n, j) => { setA(n, 'x', lx); setA(n, 'y', (ly + j * LABEL_LH).toFixed(1)); });
          }
          if (!geo.labels) b.box = null;
          if (b.svg) b.svg.style.display = geo.labels ? '' : 'none';
          continue;
        }

        if (b.kind === 'ds') {
          const a0 = b.a0 + spin + 0.012;
          const a1 = b.a1 + spin - 0.012;
          const end = a0 + Math.max(0, a1 - a0) * grow;
          ctx.strokeStyle = b.color;
          ctx.lineWidth = on ? 4 : 2.5;
          ctx.beginPath(); ctx.arc(cx, cy, rDs, a0, end); ctx.stroke();
          // end caps mark where one dataset stops and the next begins
          ctx.fillStyle = b.color;
          for (const a of [a0, end]) { ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rDs, cy + Math.sin(a) * rDs, on ? 3 : 2.2, 0, TAU); ctx.fill(); }
          if (b.fit == null) {
            b.fit = trim(b.label, (b.a1 - b.a0) * rDsText - 12);
            b.tp.textContent = b.fit;
          }
          const mid = (a0 + a1) / 2;
          const norm = ((mid % TAU) + TAU) % TAU;
          const flip = Math.sin(mid) > 0.05;
          // The path starts at angle 0 and loops twice (length 4πr). Keep the title's
          // centre between π and 3π along it, so half a loop of room is always left
          // on both sides and no title runs off either end.
          const base = flip ? (TAU - norm) % TAU : norm;
          const off = (base < Math.PI ? base + TAU : base) * rDsText;
          setHref(b.tp, `#${uid}-${flip ? 'ccw' : 'cw'}`);
          setA(b.tp, 'startOffset', off.toFixed(1));
          setA(b.svg, 'fill', on ? b.color : INK);
          setA(b.svg, 'opacity', (ctx.globalAlpha * grow).toFixed(2));
          if (b.svg.style.display) b.svg.style.display = '';
          continue;
        }

        // rule needle
        const ang = b.a + spin;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const fail = b.h === 'none' ? 0 : (100 - b.pass) / 50;
        const len = Math.max(0.06, Math.min(1, fail)) * span * ease((k - i * 22) / 900);
        b.len = len;
        // how recently the sweep crossed this needle: 1 right on the line, fading over the tail
        let ping = 0;
        if (radar) {
          const behind = (((sweepA - ang) % TAU) + TAU) % TAU;
          if (behind < SWEEP_TAIL) ping = 1 - behind / SWEEP_TAIL;
        }
        const col = NEEDLE[b.h];
        const x0 = cx + cos * r0; const y0 = cy + sin * r0;
        const x1 = cx + cos * (r0 + len); const y1 = cy + sin * (r0 + len);
        const pulse = b.h === 'crit' && !perf.still ? (Math.sin(t / 400 + i) + 1) * 0.06 : 0;
        ctx.strokeStyle = rgba(col, 0.1 + pulse + ping * 0.22 + (on ? 0.15 : 0));
        ctx.lineWidth = on ? 16 : 12;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.strokeStyle = b.h === 'ok' ? rgba(col, 0.75) : col;
        ctx.lineWidth = on ? 4.5 : 3;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        // tip cap
        const capR = (on ? 5.5 : 4) + ping * 1.5;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x1, y1, capR, 0, TAU); ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // average pass arc with an end marker
      const avgEnd = -Math.PI / 2 + ((TAU * avg) / 100) * ease(k / 1600);
      const ac = DS_COLOR[health(avg)];
      ctx.lineWidth = 3;
      ctx.strokeStyle = ac;
      ctx.beginPath(); ctx.arc(cx, cy, cr - 7, -Math.PI / 2, avgEnd); ctx.stroke();
      if (avg > 0) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx + Math.cos(avgEnd) * (cr - 7), cy + Math.sin(avgEnd) * (cr - 7), 4, 0, TAU); ctx.fill();
        ctx.strokeStyle = ac;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      // The dial keeps turning (and the page can scroll) under a still pointer,
      // so hover is re-resolved every frame, not just on pointermove.
      if (at && !pending) update();
    },
  };
  const remove = loop.add(scene);

  const flush = () => { frame = 0; pending = false; update(); };
  const onMove = (e) => {
    at = { x: e.clientX, y: e.clientY };
    pending = true;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const onLeave = () => {
    at = null;
    pending = false;
    cancelAnimationFrame(frame);
    frame = 0;
    if (hover) touch();
    hover = null;
    canvas.style.cursor = '';
    onHover(null);
  };
  const onClick = (e) => {
    // Open what is highlighted under the pointer. Click coordinates are whole
    // pixels while hover uses sub-pixel ones, so re-picking could miss at an
    // edge. Touch has no hover, so it picks from the tap point.
    const best = hover || pick(e.clientX, e.clientY).best;
    if (best && best.kind !== 'dom') onPick(best);
  };
  canvas.addEventListener('pointermove', onMove, { passive: true });
  canvas.addEventListener('pointerleave', onLeave, { passive: true });
  canvas.addEventListener('pointercancel', onLeave, { passive: true });
  canvas.addEventListener('click', onClick);

  return {
    // domains: [{ name, empty, pass, datasets: [{ name, pass, rules }] }]; null = no domain data, hide the outer ring
    setData(domains, average) {
      dirty = true;
      const list = domains || [];
      showDomains = list.length > 0 && !list[0].hidden;
      const slots = list.reduce((n, d) => n + Math.max(1, d.datasets.reduce((m, s) => m + s.rules.length, 0)), 0);
      const gaps = (list.length > 1 ? DOM_GAP * list.length : 0)
        + list.reduce((n, d) => n + DS_GAP * Math.max(0, d.datasets.length - 1), 0);
      const per = slots ? (TAU - gaps) / slots : 0;
      let a = -Math.PI / 2 + (list.length > 1 ? DOM_GAP / 2 : 0);
      const next = [];
      for (const dm of list) {
        const d0 = a;
        const domKey = `m:${dm.name}`;
        const domHealths = new Set();
        if (!dm.datasets.length) a += per; // empty domain keeps one slot
        dm.datasets.forEach((d, j) => {
          if (j) a += DS_GAP;
          const s0 = a;
          const dsKey = `s:${dm.name}|${d.name}`;
          const dsHealths = new Set();
          const rules = d.rules.map((r) => ({ r, p: clamp(num(r.pass_percentage), 0, 100) })).sort((p, q) => p.p - q.p);
          for (const { r, p } of rules) {
            const h = r.no_result ? 'none' : health(p);
            dsHealths.add(h);
            domHealths.add(h);
            next.push({ kind: 'rule', key: `r:${r.rule_id}`, rule: r, pass: p, a: a + per / 2, h, dsKey, domKey });
            a += per;
          }
          next.push({ kind: 'ds', key: dsKey, domKey, ds: d, a0: s0, a1: a, color: d.pass == null ? EMPTY : DS_COLOR[health(num(d.pass))], label: String(d.name || '').toUpperCase(), healths: dsHealths });
        });
        next.push({
          kind: 'dom', key: domKey, dom: dm, a0: d0, a1: a, empty: !dm.datasets.length, healths: domHealths,
          color: dm.datasets.length && dm.pass != null ? DS_COLOR[health(num(dm.pass))] : EMPTY, lines: wrapLabel(dm.name),
        });
        if (list.length > 1) a += DOM_GAP;
      }
      // Only replay the intro when what is on the dial actually changed, not on every refetch.
      const nextSig = `${showDomains}#${next.map((b) => `${b.key}:${b.pass ?? ''}`).join('|')}`;
      if (nextSig !== sig) born = performance.now();
      sig = nextSig;
      bars = next;
      avg = clamp(num(average), 0, 100);
      measure();
      layout();
      buildText();
      // Drop any tooltip built from the old data; the next frame re-resolves hover.
      if (hover) { hover = null; onHover(null); }
      loop.wake();
    },
    // Legend chips light up one health band on the dial.
    focusHealth(h) { healthFocus = h || null; touch(); },
    destroy() {
      dead = true;
      fonts?.removeEventListener?.('loadingdone', remeasure);
      svg.replaceChildren();
      remove();
      ro.disconnect();
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointercancel', onLeave);
      canvas.removeEventListener('click', onClick);
    },
  };
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const tipRow = (label, value, color) => {
  const row = el('div', 'tr');
  const b = el('b', '', value);
  if (color) b.style.color = color;
  row.append(el('span', '', label), b);
  return row;
};
const TIP_TONE = { ok: '#8fe3a5', warn: '#ffb38a', crit: '#ff8a7a' };

function RangeFact({ range, loading, onRetry }) {
  let body;
  if (loading) body = <Sk h={14} w={150} />;
  else if (!range || range.error) {
    body = (
      <span className="v" style={{ gap: 8 }}>
        <span className="muted" style={{ fontFamily: 'var(--text)', fontSize: 12.5 }}>Unavailable</span>
        <button type="button" className="v" onClick={onRetry}>Retry</button>
      </span>
    );
  } else if (range.status === 'none' || !range.from_date) {
    body = <span className="v muted" style={{ fontFamily: 'var(--text)', fontSize: 12.5 }}>No active range configured</span>;
  } else {
    body = <span className="v">{fmtDay(range.from_date)} <span className="ar">→</span> {fmtDay(range.to_date)}</span>;
  }
  const multiple = range?.status === 'multiple';
  return (
    <div className={`fact ${multiple ? 'warn' : ''}`}
      data-tip={multiple ? `${range.active_count} ranges are active for this cadence; only one is expected. Showing the most recently updated.` : undefined}
      data-tip-always={multiple ? '' : undefined}>
      <span className="k">Current dataset range{multiple ? ` · ${range.active_count} active` : ''}</span>
      {body}
    </div>
  );
}

const Hero = memo(function Hero({ model, loading, delta, lite, onRule, onDataset, onHealth, onAttention, onFind, onRetryRange }) {
  const heroRef = useRef(null);
  const ambientRef = useRef(null);
  const dialRef = useRef(null);
  const dialTextRef = useRef(null);
  const tipRef = useRef(null);
  const engines = useRef({});
  const handlers = useRef({});
  useEffect(() => { handlers.current = { onRule, onDataset }; });
  const liteRef = useRef(lite);
  // the tier can drop after a few seconds of measuring; stop the motion then
  useEffect(() => { liteRef.current = lite; if (lite) engines.current.loop?.setStill(true); }, [lite]);

  useEffect(() => {
    const hero = heroRef.current;
    const loop = createHeroLoop(hero, liteRef.current);
    const pointer = { x: 0.5, y: 0.5, cx: 0, cy: 0, active: false };
    const ambient = createAmbient(ambientRef.current, loop, pointer);
    const tip = tipRef.current;
    let lastKey = null;
    const dial = createDial(dialRef.current, dialTextRef.current, loop, {
      onHover(item, mx, my, w, h) {
        if (!item) { lastKey = null; tip.classList.remove('on'); return; }
        if (item.key !== lastKey) {
          lastKey = item.key;
          if (item.rule) {
            const r = item.rule;
            tip.replaceChildren(
              el('div', 'tid', `${r.rule_id} · ${r.severity || 'NONE'}`),
              el('div', 'tt', r.rule_title),
              tipRow('Pass rate', r.no_result ? 'No result' : pct(r.pass_percentage), TIP_TONE[ruleHealth(r)]),
              tipRow('Failing rows', fmt(r.failed_rows)),
            );
          } else if (item.ds) {
            const d = item.ds;
            tip.replaceChildren(
              el('div', 'tid', `DATASET · ${plural(d.rules.length, 'rule').toUpperCase()}`),
              el('div', 'tt', d.name),
              tipRow('Average pass', d.pass == null ? 'No result' : pct(d.pass)),
              tipRow('Failing rows', fmt(d.failed)),
            );
          } else {
            const d = item.dom;
            tip.replaceChildren(
              el('div', 'tid', d.empty ? 'DOMAIN · NO RULES IN VIEW' : `DOMAIN · ${plural(d.rules.length, 'rule').toUpperCase()}`),
              el('div', 'tt', d.name),
              ...(d.empty
                ? [tipRow('Status', 'No approved rules in view')]
                : [tipRow('Datasets', String(d.datasets.length)), tipRow('Average pass', d.pass == null ? 'No result' : pct(d.pass), TIP_TONE[avgHealth(d.pass)]), tipRow('Failing rows', fmt(d.failed))]),
            );
          }
        }
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        const x = Math.max(0, mx + 16 + tw > w ? mx - 16 - tw : mx + 16);
        const y = Math.max(0, Math.min(my - 20, h - th));
        tip.style.transform = `translate(${x}px,${y}px)`;
        tip.classList.add('on');
      },
      onPick(item) {
        if (item.rule) handlers.current.onRule(item.rule.rule_id);
        else if (item.ds) handlers.current.onDataset(item.ds.name);
      },
    });
    engines.current = { dial, loop };

    let frame = 0;
    let last = null;
    const apply = () => {
      frame = 0;
      const b = hero.getBoundingClientRect();
      pointer.x = (last.clientX - b.left) / b.width;
      pointer.y = (last.clientY - b.top) / b.height;
      pointer.cx = last.clientX - b.left;
      pointer.cy = last.clientY - b.top;
      pointer.active = true;
    };
    const move = (e) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const leave = () => { pointer.active = false; };
    hero.addEventListener('pointermove', move, { passive: true });
    hero.addEventListener('pointerleave', leave, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerleave', leave);
      dial.destroy();
      ambient.destroy();
      loop.destroy();
      engines.current = {};
    };
  }, []);

  const domains = model?.domains;
  const avg = model?.avg ?? 0;
  useEffect(() => {
    engines.current.dial?.setData(domains ?? null, avg);
  }, [domains, avg]);

  const counts = { ok: 0, warn: 0, crit: 0, none: 0 };
  model?.rules.forEach((r) => { counts[r.h] += 1; });
  const d = model?.trendDelta;
  const label = delta ? 'Semi-Monthly' : 'Quarterly';
  const dialLabel = model
    ? `Health dial: ${plural(model.rules.length, 'rule')} across ${plural(model.datasets.length, 'dataset')}${model.domainList ? ` in ${plural(model.domainList.length, 'active domain')}` : ''}. ${counts.ok} healthy, ${counts.warn} warning, ${counts.crit} critical. Average pass rate ${pct(avg)}.`
    : 'Health dial loading';

  return (
    <section className="hero" ref={heroRef}>
      <canvas className="ambient" ref={ambientRef} aria-hidden="true" />
      <div className="veil" /><div className="halo" />
      <div className="hero-in">
        <div className="copy">
          <div className="eyebrow"><span className="dot" /><span>{label} cycle · {model ? cycleLabel(model.range, delta) : '…'}</span></div>
          <h2 className="h1"><span className="sweep">Every rule,</span><br /><em>held to account.</em></h2>
          <p className="lede">Business rules written by the people who own the data, executed against governed sources every cycle. See what passed, what slipped, and exactly which rows need a second look.</p>
          <div className="facts" data-tour="bdc-range">
            <RangeFact range={model?.range} loading={loading} onRetry={onRetryRange} />
            <div className="fact">
              <span className="k">Last validation</span>
              {loading ? <Sk h={14} w={110} /> : (
                <span className="v" data-tip={model?.lastRun ? fmtDateTime(model.lastRun) : undefined} data-tip-always="">
                  {model?.lastRun && <I n="check" style={{ width: 13, height: 13, color: 'var(--green)' }} />}
                  {model?.lastRun ? <Ago v={model.lastRun} /> : 'No runs recorded'}
                </span>
              )}
            </div>
            <div className="fact">
              <span className="k">Next scheduled run</span>
              {loading ? <Sk h={14} w={140} /> : <span className="v">{model?.nextRun ? fmtDay(model.nextRun.at) : 'Not scheduled'}</span>}
            </div>
          </div>
          <div className="ctas">
            <button type="button" className="btn xl primary" onClick={onAttention}>Review what&apos;s failing <span className="arrow" aria-hidden="true">→</span></button>
            <button type="button" className="btn xl soft" onClick={onFind}><I n="search" />Find a rule</button>
          </div>
        </div>
        <div className="viz" data-tour="bdc-dial">
          <div className="viz-stage">
            <canvas className="dial" ref={dialRef} role="img" aria-label={dialLabel} />
            <svg className="dial-text" ref={dialTextRef} aria-hidden="true" />
            <div className="core">
              <div className="core-num">
                {model ? <CountUp value={avg} dec={1} suffix={<small style={{ fontSize: '.5em', fontWeight: 500, color: 'var(--g6)' }}>%</small>} /> : '-'}
              </div>
              <div className="core-lbl">Average pass rate</div>
              {d != null && (
                <span className={`core-delta ${d >= 0 ? 'up' : 'down'}`} data-tip="Change since the previous run" data-tip-always="">
                  {d >= 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)} pts
                </span>
              )}
            </div>
            <div className="tip" ref={tipRef} aria-hidden="true" />
          </div>
          <div className="legend">
            {Object.entries(HEALTH).filter(([k]) => k !== 'none' || counts.none).map(([k, h]) => (
              <button type="button" className="chip" key={k} onClick={() => onHealth(k)}
                onPointerEnter={() => engines.current.dial?.focusHealth(k)} onPointerLeave={() => engines.current.dial?.focusHealth(null)}
                onFocus={() => engines.current.dial?.focusHealth(k)} onBlur={() => engines.current.dial?.focusHealth(null)}
                aria-label={`Show ${h.label.toLowerCase()} rules (${counts[k]})`}>
                <span className="sw" style={{ background: h.color, boxShadow: `0 0 8px ${h.color}` }} />{h.label} <b>{model ? counts[k] : '–'}</b>
              </button>
            ))}
            <span className="hint">{model && !model.rules.length ? 'No approved rules yet' : 'Bar length = failure rate · click to open'}</span>
          </div>
        </div>
      </div>
    </section>
  );
});

const Kpis = memo(function Kpis({ model, loading, pending, pendingLoading, isAdmin, onQueue }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return undefined;
    const node = ref.current;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, { threshold: 0.2 });
    io.observe(node);
    const t = setTimeout(() => setSeen(true), 2500);
    return () => { io.disconnect(); clearTimeout(t); };
  }, [seen]);

  const k = model?.kpi;
  const d = model?.trendDelta;
  const unknown = k ? k.rules - k.failing_rows_known : 0;
  const items = [
    { t: 'Tables monitored', v: k?.tables, i: 'database', c: '#0f68b2', foot: <span className="kpi-s">across {plural(k?.datasets ?? 0, 'dataset')}</span> },
    { t: 'Rules executed', v: k?.rules, i: 'check', c: '#8c3bbb', foot: <span className="kpi-s">{k?.at_100 ?? 0} at 100%</span> },
    {
      t: 'Average pass rate', v: k?.avg_pass, dec: 1, suffix: <small>%</small>, i: 'chart', c: '#328714',
      foot: (
        <>
          {d != null ? <span className={`kpi-s ${d >= 0 ? 'delta-up' : 'delta-dn'}`}>{d >= 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)} pts</span> : <span className="kpi-s">No earlier run</span>}
          <Spark values={model?.series.map((s) => s.avg_pass)} w={84} h={28} color="#328714" />
        </>
      ),
    },
    {
      t: 'Failing rows', v: k?.failing_rows, i: 'alert', c: '#ff6017',
      foot: (
        <span className="kpi-s" data-tip={unknown ? `${plural(unknown, 'rule')} without a results table yet are not counted` : undefined} data-tip-always="">
          {plural(k?.critical ?? 0, 'rule')} below 80%
        </span>
      ),
    },
    {
      t: 'Awaiting review', v: pending, busy: pendingLoading, i: 'outcomes', c: '#eb1700',
      foot: isAdmin ? <button type="button" className="btn sm ghost" onClick={onQueue}>Open queue →</button> : <span className="kpi-s">pending sign-off</span>,
    },
  ];
  return (
    <section className="kpis" ref={ref} data-tour="bdc-kpi-cards" aria-label="Headline numbers">
      {items.map((it, idx) => (
        <div className={`kpi spot ${seen ? 'in' : ''}`} style={{ animationDelay: `${idx * 70}ms` }} key={it.t}>
          <div className="kpi-h"><span className="kpi-t">{it.t}</span><span className="kpi-i" style={{ background: `${it.c}14`, color: it.c }}><I n={it.i} /></span></div>
          <div className="kpi-v">
            {it.v != null ? <CountUp value={it.v} dec={it.dec || 0} suffix={it.suffix} start={seen} />
              : (it.busy ?? loading) ? <Sk w={70} h={30} r={8} /> : '-'}
          </div>
          <div className="kpi-f">{loading ? <Sk w={110} h={11} /> : it.foot}</div>
        </div>
      ))}
    </section>
  );
});

const digestParts = (model) => {
  const { rules, datasets, avg, trendDelta: d } = model;
  if (!rules.length) return [{ t: 'No rules have been approved for this cadence yet. Approved rules show up here after their next run.' }];
  const parts = [{ t: 'Average pass rate is ' }, { t: pct(avg), b: true }];
  if (d != null) parts.push({ t: `, ${d >= 0 ? 'up' : 'down'} ` }, { t: `${Math.abs(d).toFixed(1)} pts`, b: true }, { t: ' on the previous run. ' });
  else parts.push({ t: ` across ${plural(rules.length, 'rule')}. ` });
  const crit = rules.filter((r) => r.severity === 'CRITICAL' && !r.no_result && r.pass_percentage < 95);
  if (crit.length) parts.push({ t: `${plural(crit.length, 'critical-severity rule')}`, b: true }, { t: ` ${crit.length > 1 ? 'are' : 'is'} below target. ` });
  else if (rules.some((r) => r.severity === 'CRITICAL')) parts.push({ t: 'Every critical-severity rule is healthy. ' });
  const scored = rules.filter((r) => !r.no_result);
  const worst = scored.length ? scored.reduce((a, b) => (b.pass_percentage < a.pass_percentage ? b : a)) : null;
  const ranked = datasets.filter((d) => d.pass != null);
  const best = ranked.length ? ranked.reduce((a, b) => (b.pass > a.pass ? b : a)) : null;
  if (worst) parts.push({ t: 'The weakest rule is ' }, { t: worst.rule_id, b: true }, { t: ` (${worst.rule_title}, ${pct(worst.pass_percentage)})` });
  const noResult = rules.length - scored.length;
  if (best && ranked.length > 1) parts.push({ t: ', and ' }, { t: best.name, b: true }, { t: ` is the strongest dataset at ${pct(best.pass)}.` });
  else if (worst) parts.push({ t: '.' });
  if (noResult) parts.push({ t: ` ${plural(noResult, 'rule')} had no result on the last run.`, b: false });
  return parts;
};

function Digest({ model }) {
  const ref = useRef(null);
  const toast = useToast();
  const parts = useMemo(() => digestParts(model), [model]);
  const plain = parts.map((p) => p.t).join('');
  const typed = useRef('');

  useEffect(() => {
    const node = ref.current;
    const render = (n) => {
      const out = [];
      let left = n;
      for (const p of parts) {
        if (left <= 0) break;
        const text = p.t.slice(0, left);
        left -= p.t.length;
        out.push(p.b ? Object.assign(document.createElement('b'), { textContent: text }) : document.createTextNode(text));
      }
      if (n < plain.length) out.push(Object.assign(document.createElement('span'), { className: 'cur' }));
      node.replaceChildren(...out);
    };
    if (typed.current === plain) { render(plain.length); return undefined; }
    typed.current = plain;
    let i = 0;
    const t = setInterval(() => {
      i += 3;
      render(Math.min(i, plain.length));
      if (i >= plain.length) clearInterval(t);
    }, 16);
    return () => { clearInterval(t); render(plain.length); };
  }, [parts, plain]);

  const copy = () => {
    copyText(plain, toast, 'Digest');
  };
  return (
    <div className="digest">
      <span className="di"><I n="ai" /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span className="lbl">Cycle digest · computed from this cycle&apos;s results</span>
        <p aria-hidden="true" ref={ref} />
        <span className="sr">{plain}</span>
      </div>
      <div className="acts"><button type="button" className="btn sm ghost" onClick={copy}><I n="save" />Copy</button></div>
    </div>
  );
}

const RuleRow = memo(function RuleRow({ r, i, onRule }) {
  const open = () => onRule(r.rule_id);
  return (
    <tr onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      tabIndex={0} aria-label={`${r.rule_id} ${r.rule_title}, ${r.no_result ? 'no result' : pct(r.pass_percentage)}`} style={{ animationDelay: `${Math.min(i, 20) * 20}ms` }}>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="rid">{r.rule_id}</span>
          <div style={{ minWidth: 0 }}>
            <div className="rt" data-tip={r.rule_title}>{r.rule_title}</div>
            <div className="rs trunc" data-tip={r.dataset_title}>{r.dataset_title || 'No dataset'}</div>
          </div>
        </div>
      </td>
      <td className="c-sev"><SevBadge s={r.severity} /></td>
      <td><PassBar p={r.pass_percentage} none={r.no_result} delay={Math.min(i, 20) * 25} /></td>
      <td className="c-trend"><Spark values={r.values} w={80} h={24} color={healthColor(r.pass_percentage)} /></td>
      <td className="num c-fail">{fmt(r.failed_rows)}</td>
      <td><HealthBadge p={r.pass_percentage} h={r.h} /></td>
      <td className="c-go"><span className="go"><I n="chevR" /></span></td>
    </tr>
  );
});

const RuleCard = memo(function RuleCard({ r, i, onRule }) {
  return (
    <button type="button" className="rcard" onClick={() => onRule(r.rule_id)} style={{ animationDelay: `${Math.min(i, 16) * 30}ms`, textAlign: 'left' }}>
      <div className="top-row">
        <div><span className="rid">{r.rule_id}</span><div style={{ marginTop: 8 }}><SevBadge s={r.severity} /></div></div>
        <Ring p={r.pass_percentage} none={r.no_result} size={56} stroke={5.5} />
      </div>
      <div className="rt" data-tip={r.rule_title}>{r.rule_title}</div>
      <div className="rs trunc" data-tip={r.dataset_title}>{r.dataset_title || 'No dataset'}</div>
      <div className="foot"><span className="mono">{fmt(r.failed_rows)} failing</span><Spark values={r.values} w={80} h={24} color={healthColor(r.pass_percentage)} /></div>
    </button>
  );
});

function Explorer({ model, filters, setFilters, onRule, canDownload }) {
  const toast = useToast();
  const [q, setQ] = useState(filters.q);
  const typing = useRef(false);
  const latest = useRef({ q: filters.q, setFilters });
  useEffect(() => { latest.current = { q: filters.q, setFilters }; });
  const debounced = useDebounced(q, 200);
  useEffect(() => { if (!typing.current) setQ(filters.q); }, [filters.q]);
  useEffect(() => {
    if (typing.current && debounced !== latest.current.q) latest.current.setFilters({ q: debounced || null });
    typing.current = false;
  }, [debounced]);
  const liveQ = useDeferredValue(q);
  const list = useMemo(() => filterRules(model.rules, { ...filters, q: liveQ }, filters.sort), [model.rules, filters, liveQ]);
  // The first rows paint at once and the rest follow over the next frames, so
  // opening the tab doesn't block on hundreds of rows (worst on CPU-only PCs).
  const [cap, setCap] = useState(40);
  useEffect(() => {
    if (cap >= list.length) return undefined;
    const t = setTimeout(() => setCap((c) => c + 60), 16);
    return () => clearTimeout(t);
  }, [cap, list.length]);
  const shown = list.length > cap ? list.slice(0, cap) : list;

  const sevList = useMemo(() => {
    const extra = [...new Set(model.rules.map((r) => r.severity))].filter((s) => s && !SEVS.includes(s));
    return [...SEVS, ...extra];
  }, [model.rules]);

  const toggleSev = (s) => {
    const next = new Set(filters.sev);
    if (next.has(s)) next.delete(s); else next.add(s);
    setFilters({ sev: [...next].join(',') || null });
  };
  const sortBy = (key) => setFilters({ sort: `${key}.${filters.sort.key === key && filters.sort.dir === 'asc' ? 'desc' : 'asc'}` });
  const th = (label, key, cls = '') => {
    const on = filters.sort.key === key;
    return (
      <th className={`s ${cls} ${on ? `sorted ${filters.sort.dir}` : ''}`} aria-sort={on ? (filters.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => sortBy(key)} style={{ font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', color: 'inherit' }}>
          {label}<span className="ar" aria-hidden="true">▾</span>
        </button>
      </th>
    );
  };
  const tags = [
    ...[...filters.sev].map((s) => [`Severity: ${s}`, () => toggleSev(s)]),
    ...(filters.health !== 'all' ? [[`Health: ${HEALTH[filters.health].label}`, () => setFilters({ health: null })]] : []),
    ...(filters.ds ? [[`Dataset: ${filters.ds}`, () => setFilters({ ds: null })]] : []),
    ...(filters.q ? [[`"${filters.q}"`, () => { setQ(''); setFilters({ q: null }); }]] : []),
  ];
  const exportCsv = () => {
    exportRulesCsv(list, model.delta);
    toast(`Exported ${plural(list.length, 'rule')}`, 'ok');
  };

  return (
    <>
      <div className="card-h" style={{ paddingBottom: 14, borderBottom: '1px solid var(--g2)' }}>
        <div className="card-t"><span className="ci"><I n="records" /></span>Active rules</div>
        <span className="card-sub" aria-live="polite">{list.length} of {plural(model.rules.length, 'rule')}</span>
      </div>
      <div className="tool">
        <label className="field grow"><I n="search" />
          <input value={q} onChange={(e) => { typing.current = true; setQ(e.target.value); }} placeholder="Search by rule ID, title or dataset" aria-label="Search rules" />
        </label>
        {sevList.map((s) => {
          const on = filters.sev.has(s);
          return (
            <button type="button" key={s} className={`pill ${on ? 'on' : ''} ${on && SEV_LIGHT.has(s) ? 'light' : ''}`} aria-pressed={on}
              onClick={() => toggleSev(s)} style={on ? { background: SEV_COLOR[s] || '#a39992' } : undefined}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          );
        })}
        <div className="seg" role="group" aria-label="Health">
          {['all', 'ok', 'warn', 'crit', ...(model.rules.some((r) => r.no_result) || filters.health === 'none' ? ['none'] : [])].map((h) => (
            <button type="button" key={h} className={filters.health === h ? 'on' : ''} aria-pressed={filters.health === h}
              onClick={() => setFilters({ health: h === 'all' ? null : h })}>{h === 'all' ? 'All' : HEALTH[h].label}</button>
          ))}
        </div>
        <select className="sel" value={filters.ds} onChange={(e) => setFilters({ ds: e.target.value || null })} aria-label="Dataset">
          <option value="">All datasets</option>
          {model.datasets.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Layout">
          <button type="button" className={filters.layout === 'table' ? 'on' : ''} aria-pressed={filters.layout === 'table'} onClick={() => setFilters({ layout: null })}
            aria-label="Table" data-tip="Table" data-tip-always=""><I n="records" /></button>
          <button type="button" className={filters.layout === 'cards' ? 'on' : ''} aria-pressed={filters.layout === 'cards'} onClick={() => setFilters({ layout: 'cards' })}
            aria-label="Cards" data-tip="Cards" data-tip-always=""><I n="dashboard" /></button>
        </div>
        {canDownload && <button type="button" className="btn sm ghost" onClick={exportCsv} disabled={!list.length}><I n="download" />Export</button>}
      </div>
      {tags.length > 0 && (
        <div className="active-f">
          {tags.map(([label, clear]) => (
            <span className="tagx" key={label}>{label}<button type="button" onClick={clear} aria-label={`Remove filter ${label}`}><I n="close" /></button></span>
          ))}
          <button type="button" className="btn sm" style={{ color: 'var(--g6)' }} onClick={() => { setQ(''); setFilters({ q: null, sev: null, health: null, ds: null }); }}>Clear all</button>
        </div>
      )}
      {!list.length ? (
        model.rules.length ? <Empty title="No rules match">Try removing a filter.</Empty>
          : model.noDatasets ? <Empty icon="shield" title="No datasets assigned">You don’t have access to any Business Checks datasets yet. Ask a User Management admin to give you one.</Empty>
          : <Empty icon="records" title="No approved rules">Rules appear here once they have been reviewed and approved for this cadence.</Empty>
      ) : filters.layout === 'cards' ? (
        <div className="rcards">{shown.map((r, i) => <RuleCard key={r.rule_id} r={r} i={i} onRule={onRule} />)}</div>
      ) : (
        <div className="twrap">
          <table className="t">
            <thead><tr>
              {th('Rule', 'title')}{th('Severity', 'sev', 'c-sev')}{th('Pass rate', 'pass')}
              <th className="c-trend">Trend</th>{th('Failing rows', 'failed', 'c-fail')}<th>Health</th><th className="c-go"><span className="sr">Open</span></th>
            </tr></thead>
            <tbody>{shown.map((r, i) => <RuleRow key={r.rule_id} r={r} i={i} onRule={onRule} />)}</tbody>
          </table>
        </div>
      )}
      <div className="tfoot">
        <span>Pass thresholds: <b style={{ color: 'var(--green-t)' }}>95%+</b> healthy · <b style={{ color: 'var(--orange-t)' }}>80-94.9%</b> warning · <b style={{ color: 'var(--red-t)' }}>below 80%</b> critical</span>
        <span>Click any rule for full detail</span>
      </div>
    </>
  );
}

function Overview({ model, loading, error, onRetry, filters, setFilters, onRule, canDownload }) {
  if (error && !model) return <section className="card"><ErrorState error={error} onRetry={onRetry} title="Could not load the rules" /></section>;
  if (loading || !model) {
    return (
      <>
        <div className="digest"><span className="di"><I n="ai" /></span><div style={{ flex: 1 }}><span className="lbl">Cycle digest</span><Sk h={14} w="80%" style={{ marginTop: 8 }} /><Sk h={14} w="55%" style={{ marginTop: 8 }} /></div></div>
        <section className="card"><div className="card-h" style={{ paddingBottom: 14 }}><div className="card-t"><span className="ci"><I n="records" /></span>Active rules</div></div><SkRows rows={8} cols={6} /></section>
      </>
    );
  }
  return (
    <>
      <Digest model={model} />
      <section className="card explorer-anchor" id="bdc-explorer" data-tour="bdc-rules-table">
        <Explorer model={model} filters={filters} setFilters={setFilters} onRule={onRule} canDownload={canDownload} />
      </section>
    </>
  );
}

const NOTE = { ok: 'average at 95% or above', warn: 'average between 80% and 95%', crit: 'average below 80%' };

function Datasets({ model, loading, error, onRetry, onDataset }) {
  if (error && !model) return <section className="card"><ErrorState error={error} onRetry={onRetry} title="Could not load datasets" /></section>;
  if (loading || !model) {
    return (
      <>
        <div className="dsum">{[0, 1, 2].map((i) => <div className="stat" key={i}><Sk w="60%" h={10} /><Sk w={40} h={22} style={{ marginTop: 10 }} /></div>)}</div>
        <div className="dgrid">{[0, 1, 2, 3].map((i) => <div className="dcard" key={i} style={{ animation: 'none' }}><Sk w="55%" h={18} /><Sk w="35%" h={11} style={{ marginTop: 8 }} /><Sk h={26} style={{ marginTop: 18 }} /><Sk w="40%" h={11} style={{ marginTop: 14 }} /></div>)}</div>
      </>
    );
  }
  const list = [...model.datasets].sort((a, b) => (a.pass ?? 101) - (b.pass ?? 101));
  const counts = { ok: 0, warn: 0, crit: 0, none: 0 };
  list.forEach((d) => { counts[avgHealth(d.pass)] += 1; });
  return (
    <>
      <div className="dsum">
        {['ok', 'warn', 'crit'].map((k) => (
          <div className="stat" key={k}>
            <span className="lbl">{HEALTH[k].label} datasets</span>
            <div className="v" style={{ color: `var(--${k === 'ok' ? 'green' : k === 'warn' ? 'orange' : 'red'}-t)` }}>{counts[k]}</div>
            <div className="s">{NOTE[k]}</div>
          </div>
        ))}
      </div>
      {!list.length ? (
        <section className="card"><Empty icon="database" title="No datasets yet">Datasets appear once approved rules have a dataset title.</Empty></section>
      ) : (
        <div className="dgrid" data-tour="bdc-dataset-table">
          {list.map((d, i) => (
            <button type="button" className="dcard spot" key={d.name} onClick={() => onDataset(d.name)} style={{ animationDelay: `${i * 60}ms`, textAlign: 'left' }}
              aria-label={`${d.name}: ${plural(d.rules.length, 'rule')}, average ${d.pass == null ? 'no result' : pct(d.pass)}`}>
              <div className="dh">
                <div style={{ minWidth: 0 }}>
                  <span className="dn" data-tip={d.name}>{d.name}</span>
                  <div className="tbls">{plural(d.tables.size, 'table')} · {plural(d.rules.length, 'rule')}</div>
                  <div style={{ marginTop: 10 }}><HealthBadge p={d.pass} h={avgHealth(d.pass)} /></div>
                </div>
                <Ring p={d.pass} none={d.pass == null} size={74} stroke={7} fs={19} />
              </div>
              <div className="strip" aria-hidden="true">
                {[...d.rules].sort((a, b) => a.pass_percentage - b.pass_percentage).map((r, j) => (
                  <span key={r.rule_id} data-tip={`${r.rule_id} · ${r.rule_title} · ${pct(r.pass_percentage)}`} data-tip-always=""
                    style={{ background: HEALTH[r.h].color, opacity: 0.45 + r.pass_percentage / 200, animationDelay: `${i * 60 + j * 40}ms` }} />
                ))}
              </div>
              <div className="df">
                <span>Failing rows <b>{fmt(d.failed)}</b></span>
                <span className="open">View rules <I n="chevR" style={{ width: 11, height: 11 }} /></span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const H = 340;
const P = { l: 40, r: 16, t: 12, b: 30 };

function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function Chart({ series }) {
  const host = useRef(null);
  const W = useElementWidth(host);
  const hair = useRef(null);
  const dots = useRef(null);
  const tip = useRef(null);

  const { dates, lo, lines } = useMemo(() => {
    const all = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
    const values = series.flatMap((s) => s.points.map((p) => p.v));
    const low = Math.max(0, Math.floor((Math.min(...values, 76) - 4) / 10) * 10);
    return { dates: all, lo: low, lines: series };
  }, [series]);

  const n = Math.max(1, dates.length - 1);
  const x = (i) => P.l + (i * (W - P.l - P.r)) / n;
  const y = (v) => P.t + ((100 - v) * (H - P.t - P.b)) / (100 - lo || 1);
  const at = (date) => dates.indexOf(date);
  const withYear = dates.length > 1 && dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4);
  const step = Math.ceil(dates.length / Math.max(2, Math.floor((W - 60) / 70)));

  const move = useRafCallback((clientX) => {
    if (!host.current || !W || !dates.length) return;
    const b = host.current.getBoundingClientRect();
    const i = clamp(Math.round((clientX - b.left - P.l) / ((W - P.l - P.r) / n)), 0, dates.length - 1);
    const date = dates[i];
    hair.current.setAttribute('x1', x(i));
    hair.current.setAttribute('x2', x(i));
    hair.current.style.display = '';
    const rows = lines.map((s, k) => {
      const idx = s.points.findIndex((p) => p.date === date);
      return { s, k, p: s.points[idx], prev: idx > 0 ? s.points[idx - 1] : null };
    });
    dots.current.replaceChildren(...rows.filter((r) => r.p).map(({ k, p }) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p.v)); c.setAttribute('r', 6);
      c.setAttribute('fill', SERIES[k]); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', 2.5);
      return c;
    }));
    const head = Object.assign(document.createElement('div'), { className: 'h', textContent: fmtShortDay(date, true) });
    const body = rows.map(({ s, k, p, prev }) => {
      const r = document.createElement('div');
      r.className = 'r';
      const sw = Object.assign(document.createElement('i'), { className: 'sw' });
      sw.style.background = SERIES[k];
      const name = Object.assign(document.createElement('span'), { textContent: s.id });
      const val = Object.assign(document.createElement('b'), { textContent: p ? pct(p.v) : 'no run' });
      r.append(sw, name, val);
      if (p && prev) {
        const dlt = document.createElement('small');
        const diff = p.v - prev.v;
        dlt.textContent = ` ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
        dlt.style.color = diff >= 0 ? '#8fe3a5' : '#ffb38a';
        r.append(dlt);
      }
      return r;
    });
    tip.current.replaceChildren(head, ...body);
    tip.current.style.opacity = 1;
    // Measured, and kept inside the chart: on a phone the old fixed 190px guess put it off the left edge.
    const tw = tip.current.offsetWidth;
    const right = x(i) + 14;
    tip.current.style.left = `${clamp(right + tw > W ? x(i) - 14 - tw : right, 0, Math.max(0, W - tw))}px`;
    tip.current.style.top = '20px';
  });
  const leave = () => {
    if (!hair.current) return;
    hair.current.style.display = 'none';
    dots.current.replaceChildren();
    tip.current.style.opacity = 0;
  };

  return (
    <div className="chart" ref={host} onPointerMove={(e) => move(e.clientX)} onPointerLeave={leave} data-tour="bdc-trend-chart"
      role="img" aria-label={`Pass rate over time for ${lines.map((s) => s.id).join(', ')}`}>
      {W > 0 && (
        <svg width={W} height={H} aria-hidden="true">
          <defs>
            {lines.map((s, k) => (
              <linearGradient id={`bdx-ta${k}`} key={s.id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={SERIES[k]} stopOpacity=".22" /><stop offset="1" stopColor={SERIES[k]} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          <rect x={P.l} y={y(100)} width={W - P.l - P.r} height={y(95) - y(100)} fill="rgba(50,135,20,.07)" />
          <rect x={P.l} y={y(95)} width={W - P.l - P.r} height={y(80) - y(95)} fill="rgba(255,96,23,.06)" />
          {lo < 80 && <rect x={P.l} y={y(80)} width={W - P.l - P.r} height={y(lo) - y(80)} fill="rgba(235,23,0,.045)" />}
          {Array.from({ length: Math.floor((100 - lo) / 10) + 1 }, (_, i) => lo + i * 10).map((v) => (
            <g key={v}>
              <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#e8e6e3" strokeDasharray={v === 100 ? '' : '3 4'} />
              <text x={P.l - 8} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="#766b64" fontFamily="JohnsonText">{v}%</text>
            </g>
          ))}
          {[95, 80].map((v) => <line key={v} x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke={v === 95 ? '#328714' : '#ff6017'} strokeOpacity=".5" strokeDasharray="6 4" />)}
          {dates.map((d, i) => ((i % step === 0 || i === dates.length - 1) ? (
            <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="#766b64" fontFamily="JohnsonText">{fmtShortDay(d, withYear)}</text>
          ) : null))}
          {lines.map((s, k) => {
            const pts = s.points.map((p) => [x(at(p.date)), y(p.v)]);
            const d = smooth(pts);
            return (
              <g key={`${s.id}-${dates.length}-${W}`}>
                {k === 0 && pts.length > 1 && <path className="ar" d={`${d}L${pts[pts.length - 1][0]},${y(lo)}L${pts[0][0]},${y(lo)}Z`} fill={`url(#bdx-ta${k})`} />}
                {pts.length > 1 && <path className="ln" pathLength="1" d={d} stroke={SERIES[k]} style={{ animationDelay: `${k * 150}ms` }} />}
                {pts.map((p, i) => <circle key={i} className="pt" cx={p[0]} cy={p[1]} r="3.4" fill="#fff" stroke={SERIES[k]} strokeWidth="2" style={{ animationDelay: `${600 + Math.min(i, 30) * 40}ms` }} />)}
              </g>
            );
          })}
          <line ref={hair} y1={P.t} y2={H - P.b} stroke="#312c2a" strokeOpacity=".25" style={{ display: 'none' }} />
          <g ref={dots} />
        </svg>
      )}
      <div className="ctip" ref={tip} />
    </div>
  );
}

function TrendList({ rules, selected, filter, setFilter, onToggle }) {
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rules.filter((r) => !q || `${r.rule_id} ${r.rule_title}`.toLowerCase().includes(q));
  }, [rules, filter]);
  return (
    <section className="card" data-tour="bdc-rule-select">
      <div className="card-h"><div className="card-t"><span className="ci"><I n="records" /></span>Rules</div><span className="card-sub">Compare up to 3</span></div>
      <div style={{ padding: '12px 14px 0' }}>
        <label className="field"><I n="search" /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rules" aria-label="Filter rules" /></label>
      </div>
      <div className="rlist" role="listbox" aria-multiselectable="true" aria-label="Rules to compare">
        {list.length ? list.map((r) => {
          const i = selected.indexOf(r.rule_id);
          const on = i >= 0;
          return (
            <button type="button" key={r.rule_id} className={`rli ${on ? 'on' : ''}`} role="option" aria-selected={on} onClick={() => onToggle(r.rule_id)}>
              <span className="cb" style={on ? { background: SERIES[i] } : undefined}>{on && <I n="check" />}</span>
              <span className="m">
                <span className="t" style={{ display: 'block' }} data-tip={r.rule_title}>{r.rule_title}</span>
                <span className="s">{r.rule_id} · {pct(r.pass_percentage)}</span>
              </span>
              <Spark values={r.values} w={56} h={20} color={healthColor(r.pass_percentage)} area={false} />
            </button>
          );
        }) : <div className="empty" style={{ padding: 24 }}><p>No rules match.</p></div>}
      </div>
    </section>
  );
}

function Trends({ model, loading, error, onRetry, selected, setSelected, filter, setFilter }) {
  const toast = useToast();
  const delta = !!model?.delta;
  const [a, b, c] = selected;
  const qa = useQuery(a ? `trend:${delta}:${a}` : null, (s) => api.trends(a, delta, s), { ttl: 60000 });
  const qb = useQuery(b ? `trend:${delta}:${b}` : null, (s) => api.trends(b, delta, s), { ttl: 60000 });
  const qc = useQuery(c ? `trend:${delta}:${c}` : null, (s) => api.trends(c, delta, s), { ttl: 60000 });
  const queries = [qa, qb, qc].slice(0, selected.length);
  const series = useMemo(() => [qa.data, qb.data, qc.data].slice(0, selected.length).map((data, k) => ({
    id: selected[k],
    points: (data || []).map((p) => ({ date: String(p.date).slice(0, 10), v: +p.pass_percentage })).filter((p) => toDate(p.date)),
  })), [selected, qa.data, qb.data, qc.data]);

  if (error && !model) return <section className="card"><ErrorState error={error} onRetry={onRetry} title="Could not load rules" /></section>;
  if (loading || !model) {
    return (
      <div className="tr-grid">
        <section className="card"><div className="card-h"><div className="card-t">Rules</div></div><div style={{ padding: 14 }}>{Array.from({ length: 7 }, (_, i) => <Sk key={i} h={34} style={{ marginBottom: 8 }} />)}</div></section>
        <section className="card"><div className="card-b"><Sk h={300} r={14} /></div></section>
      </div>
    );
  }
  if (!model.rules.length) return <section className="card"><Empty icon="chart" title="No rules to chart">Approved rules with run history show up here.</Empty></section>;

  const toggle = (id) => {
    const i = selected.indexOf(id);
    if (i >= 0) { if (selected.length > 1) setSelected(selected.filter((x) => x !== id)); return; }
    if (selected.length >= 3) { toast('Compare up to 3 rules at a time', 'info'); return; }
    setSelected([...selected, id]);
  };
  const busy = queries.some((q) => q.loading);
  const failed = queries.map((q, k) => (q.error ? { id: selected[k], q } : null)).filter(Boolean);
  const first = series[0];
  const t = first?.points || [];
  const vals = t.map((p) => p.v);
  const mx = vals.length ? Math.max(...vals) : null;
  const mn = vals.length ? Math.min(...vals) : null;
  const ch = vals.length > 1 ? vals[vals.length - 1] - vals[0] : null;
  const label = (v) => (v == null ? '' : fmtShortDay(t[vals.indexOf(v)]?.date, true));
  const drawn = series.filter((s) => s.points.length);

  return (
    <div className="tr-grid">
      <TrendList rules={model.rules} selected={selected} filter={filter} setFilter={setFilter} onToggle={toggle} />
      <div style={{ minWidth: 0 }}>
        <section className="card">
          <div className="card-h">
            <div className="card-t"><span className="ci"><I n="chart" /></span>Pass rate over time</div>
            <div className="leg"><span><i style={{ background: 'rgba(50,135,20,.25)' }} />95%+ healthy</span><span><i style={{ background: 'rgba(255,96,23,.22)' }} />80-94.9% warning</span><span><i style={{ background: 'rgba(235,23,0,.16)' }} />below 80% critical</span></div>
          </div>
          <div className="card-b">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {selected.map((id, k) => {
                const r = model.byId.get(id);
                return (
                  <span className="chip" key={id} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, maxWidth: '100%' }}>
                    <span className="sw" style={{ background: SERIES[k] }} /><b>{id}</b>
                    <span className="trunc" style={{ maxWidth: 260 }} data-tip={r?.rule_title}>{r?.rule_title}</span>
                    {selected.length > 1 && <button type="button" onClick={() => toggle(id)} style={{ marginLeft: 2, color: 'var(--g6)' }} aria-label={`Remove ${id} from the comparison`}><I n="close" style={{ width: 9, height: 9 }} /></button>}
                  </span>
                );
              })}
            </div>
            {failed.map(({ id, q }) => <div key={id} style={{ marginBottom: 10 }}><InlineError error={new Error(`${id}: ${q.error.message}`)} onRetry={() => q.reload()} /></div>)}
            {busy && !drawn.length ? <Sk h={H} r={14} /> : drawn.length ? <Chart series={drawn} /> : (
              !failed.length && <Empty icon="chart" title="No run history yet">This rule has not been executed in this cadence.</Empty>
            )}
          </div>
        </section>
        {first && vals.length > 0 && (
          <div className="stats mt">
            {[
              ['Latest', pct(vals[vals.length - 1]), fmtShortDay(t[t.length - 1].date, true)],
              ['Best', pct(mx), label(mx)],
              ['Worst', pct(mn), label(mn)],
              ['Change over period', ch == null ? '-' : <span style={{ color: ch >= 0 ? 'var(--green-t)' : 'var(--red-t)' }}>{ch >= 0 ? '+' : ''}{ch.toFixed(1)} pts</span>,
                `${fmtShortDay(t[0].date, true)} to ${fmtShortDay(t[t.length - 1].date, true)}`],
            ].map(([k, v, s]) => (
              <div className="stat" key={k}><span className="lbl">{k} · {first.id}</span><div className="v">{v}</div><div className="s">{s}</div></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RulePicker({ rules, rule, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const wrap = useRef(null);
  const input = useRef(null);
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return [...rules].sort((a, b) => a.pass_percentage - b.pass_percentage)
      .filter((r) => !qq || `${r.rule_id} ${r.rule_title}`.toLowerCase().includes(qq));
  }, [rules, q]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    wrap.current?.querySelector('.combo-list button.hl')?.scrollIntoView({ block: 'nearest' });
  }, [hl, open]);

  const choose = (r) => { onPick(r.rule_id); setOpen(false); setQ(''); input.current?.blur(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHl((h) => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && open && list[hl]) { e.preventDefault(); choose(list[hl]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };
  return (
    <div className={`combo ${open ? 'open' : ''}`} ref={wrap} style={{ marginBottom: 16 }} data-tour="bdc-rule-select">
      <label className="field" style={{ height: 48, borderRadius: 14, padding: '0 16px' }}>
        <I n="search" />
        <input ref={input} value={q} placeholder="Pick a rule to inspect its failing rows" autoComplete="off" role="combobox"
          aria-expanded={open} aria-controls="bdx-fr-list" aria-autocomplete="list" aria-label="Pick a rule"
          aria-activedescendant={open && list[hl] ? `bdx-fr-${hl}` : undefined}
          onFocus={() => { setOpen(true); setHl(0); }} onChange={(e) => { setQ(e.target.value); setOpen(true); setHl(0); }} onKeyDown={onKey} />
        {rule && <span className="rid">{rule.rule_id}</span>}
        {rule && <span className="ttl-x trunc" style={{ fontSize: 12.5, color: 'var(--g6)', maxWidth: 280 }} data-tip={rule.rule_title}>{rule.rule_title}</span>}
      </label>
      <div className="combo-list" id="bdx-fr-list" role="listbox">
        {list.length ? list.map((r, i) => (
          <button type="button" key={r.rule_id} id={`bdx-fr-${i}`} role="option" aria-selected={r.rule_id === rule?.rule_id} tabIndex={-1}
            className={i === hl ? 'hl' : ''} onMouseEnter={() => setHl(i)} onClick={() => choose(r)}>
            <span className="rid">{r.rule_id}</span><span className="t" data-tip={r.rule_title}>{r.rule_title}</span>
            <SevBadge s={r.severity} />
            <b className="num" style={{ width: 52, textAlign: 'right', color: healthColor(r.pass_percentage) }}>{pct(r.pass_percentage)}</b>
          </button>
        )) : <div className="empty" style={{ padding: 20 }}>No rules match</div>}
      </div>
    </div>
  );
}

function Act({ icon, color, title, text, onClick, progress, disabled, tour }) {
  return (
    <button type="button" className="act" onClick={onClick} disabled={disabled} data-tour={tour} aria-busy={!!progress}>
      <span className="ai" style={{ background: `${color}14`, color }}><I n={icon} /></span>
      <span className="arrow"><I n="chevR" /></span>
      <h4>{title}</h4>
      <p>{progress ? `${progress.label} · ${progress.pct}%` : text}</p>
      <span className="prog" style={{ width: progress ? `${progress.pct}%` : 0 }} />
    </button>
  );
}

function FailedRows({ model, loading, error, onRetry, rule, onPick, onPreview, onDelta, onConsolidated, onDownload, download, onAdvanced }) {
  // onDownload is null without the download permission
  const toast = useToast();
  const delta = !!model?.delta;
  const id = rule?.rule_id;
  const reg = useQuery(id ? `reg:${id}` : null, (s) => api.registry(id, s), { ttl: 120000 });
  const needCount = !!rule && rule.failed_rows == null;
  const count = useQuery(needCount ? `count:${delta}:${id}` : null, (s) => api.failedCount(id, delta, s), { ttl: 60000 });

  if (error && !model) return <section className="card"><ErrorState error={error} onRetry={onRetry} title="Could not load rules" /></section>;
  if (loading || !model) {
    return (
      <>
        <Sk h={48} r={14} style={{ marginBottom: 16 }} />
        <div className="fr-top">
          <section className="card"><div className="card-b" style={{ paddingTop: 20 }}><div className="fr-head"><Sk w={112} h={112} className="circle" /><div style={{ flex: 1 }}><Sk w="40%" h={22} /><Sk w="70%" h={20} style={{ marginTop: 12 }} /></div></div></div></section>
          <section className="card"><div className="card-b"><Sk h={120} /></div></section>
        </div>
      </>
    );
  }
  if (!model.rules.length || !rule) return <section className="card"><Empty icon="alert" title="No rules to inspect">Approved rules with failing rows show up here.</Empty></section>;

  const failed = rule.failed_rows ?? count.data?.total_count ?? null;
  const copy = () => {
    copyText(reg.data?.sql_predicate || '', toast, 'Predicate');
  };
  const notFound = reg.error?.status === 404;

  return (
    <>
      <RulePicker rules={model.rules} rule={rule} onPick={onPick} />
      <div className="fr-top">
        <section className="card spot">
          <div className="card-b" style={{ paddingTop: 20 }}>
            <div className="fr-head">
              <Ring p={rule.pass_percentage} none={rule.no_result} size={112} stroke={10} fs={26} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><span className="rid">{rule.rule_id}</span><SevBadge s={rule.severity} /><HealthBadge p={rule.pass_percentage} h={rule.h} /></div>
                <h3 style={{ margin: '10px 0 4px', fontFamily: 'var(--display)', fontSize: 21, letterSpacing: '-.02em', lineHeight: 1.2 }}>{rule.rule_title}</h3>
                <div className="card-sub">{rule.dataset_title || 'No dataset'}</div>
              </div>
            </div>
            <div className="fr-stats">
              <div className="stat"><span className="lbl">Failing rows</span><div className="v" style={{ color: 'var(--red-t)' }}>{needCount && count.loading ? <Sk w={60} h={20} /> : fmt(failed)}</div></div>
              <div className="stat">
                <span className="lbl">Rows evaluated</span>
                <div className="v" data-tip={rule.rows_evaluated == null ? 'This run did not record how many rows it evaluated' : undefined} data-tip-always="">
                  {rule.rows_evaluated == null ? <span className="muted" style={{ fontSize: 15 }}>Not recorded</span> : fmt(rule.rows_evaluated)}
                </div>
              </div>
              <div className="stat">
                <span className="lbl">Last executed</span>
                <div className="v" style={{ fontSize: 15, marginTop: 10 }} data-tip={rule.last_run ? fmtDateTime(rule.last_run) : undefined} data-tip-always="">{rule.last_run ? ago(rule.last_run) : 'Never'}</div>
              </div>
            </div>
          </div>
        </section>
        <section className="card" data-tour="bdc-sql-section">
          <div className="card-h"><div className="card-t"><span className="ci"><I n="network" /></span>Rule registry</div><span className="card-sub">Predicate a row must match to fail</span></div>
          <div className="card-b">
            {reg.loading ? <Sk h={90} r={12} />
              : notFound ? <div className="note-box"><I n="info" /><span>No validated SQL predicate is in the registry for this rule yet. It is written by the next compilation run.</span></div>
                : reg.error ? <InlineError error={reg.error} onRetry={reg.reload} />
                  : <Code sql={reg.data?.sql_predicate} onCopy={copy} />}
            {rule.color_columns && <p className="card-sub" style={{ margin: '12px 0 0' }}>Colour-coded columns: <span className="mono">{rule.color_columns}</span></p>}
            <div style={{ marginTop: 14 }}>
              <span className="lbl">Pass rate, last {rule.values.length} {rule.values.length === 1 ? 'run' : 'runs'}</span>
              <div style={{ marginTop: 8 }}><Spark values={rule.values} w={420} h={56} color={healthColor(rule.pass_percentage)} fluid /></div>
            </div>
          </div>
        </section>
      </div>
      <div className="acts mt">
        <Act icon="eye" color="#0f68b2" title="Preview failing rows" text="Browse every failing row in place, page by page." onClick={onPreview} tour="bdc-show-failed" disabled={failed === 0} />
        {onDownload && <Act icon="download" color="#328714" title="Download Excel" text={failed === 0 ? 'No failing rows to export.' : 'Full export with colour-coded columns applied.'} onClick={onDownload} progress={download} disabled={failed === 0} />}
        <Act icon="chart" color="#8c3bbb" title="Compare runs" text="New, resolved and persisting failures since the last run." onClick={onDelta} tour="bdc-delta" />
        <Act icon="records" color="#eb1700" title="Consolidated report" text="One workbook across every rule in this cycle." onClick={onConsolidated} />
      </div>
      <p className="card-sub" style={{ marginTop: 10 }}>
        Need two specific runs? <button type="button" data-tour="bdc-adv-delta" onClick={onAdvanced} style={{ color: 'var(--blue)', fontWeight: 700 }}>Choose the runs to compare</button>
      </p>
    </>
  );
}

const PAGE = 50;
const BAND_TEXT = { g: '#15803d', y: '#a14a0a', r: '#b91c1c' };

const compare = (a, b) => {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const sa = String(a).trim();
  const sb = String(b).trim();
  const na = parseFloat(sa);
  const nb = parseFloat(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && sa !== '' && sb !== '') return na - nb;
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
};

// Failed rows, delta sheets and the consolidated report all render through this.
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/;
const colKind = (rows, ci) => {
  let kind = null;
  for (const row of rows) {
    const v = row[ci];
    if (v === null || v === undefined || v === '') continue;
    const k = typeof v === 'boolean' || /^(true|false)$/i.test(String(v)) ? 'bool'
      : typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? 'num'
        : DATE_RE.test(String(v)) ? 'date' : 'text';
    if (kind && kind !== k) return 'text';
    kind = k;
  }
  return kind || 'text';
};
const KIND_GLYPH = { num: '#', text: 'Aa', bool: 'T/F' };
const KIND_NAME = { num: 'Number', text: 'Text', bool: 'Boolean', date: 'Date' };

// Sorting is done by whoever holds every row (the server, or the consolidated
// report's caller): sorting one page in place only ever ordered those 50 rows.
const nextSort = (sort, col) => (sort?.col !== col ? { col, dir: 'asc' } : sort.dir === 'asc' ? { col, dir: 'desc' } : null);
const sortRows = (rows, columns, sort) => {
  const ci = sort ? columns.indexOf(sort.col) : -1;
  if (ci < 0) return rows;
  const k = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compare(a[ci], b[ci]) * k);
};

const RowsTable = memo(function RowsTable({ columns, rows, offset = 0, colorColumns, ruleColorMap, busy, empty = 'No rows found.', sort = null, onSort }) {
  const order = useMemo(() => rows.map((_, i) => i), [rows]);
  const bands = useMemo(() => cellBands(columns, rows, { colorColumns, ruleColorMap }), [columns, rows, colorColumns, ruleColorMap]);
  const fm = columns.indexOf('FAILURE_MODE');
  const kinds = useMemo(() => columns.map((_, ci) => colKind(rows, ci)), [columns, rows]);

  if (!rows.length && !busy) return <Empty icon="check" title={empty} />;
  return (
    <div className="dtable-wrap">
      {busy && <div className="busy" aria-label="Loading"><span className="spinner-lg" /></div>}
      <div className="dtable" tabIndex={0} aria-label="Rows">
        <table className="t">
          <thead><tr>
            <th aria-label="Row number" />
            {columns.map((c, ci) => {
              const on = sort?.col === c;
              return (
                <th key={`${c}-${ci}`} className={`s ${on ? `sorted ${sort.dir}` : ''}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" style={{ font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', color: 'inherit' }}
                    disabled={!onSort || busy} onClick={() => onSort(nextSort(sort, c))}>
                    <span className="kind" title={KIND_NAME[kinds[ci]]} aria-hidden="true">
                      {kinds[ci] === 'date'
                        ? <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></svg>
                        : KIND_GLYPH[kinds[ci]]}
                    </span>
                    {c}<span className="ar" aria-hidden="true">▾</span>
                  </button>
                </th>
              );
            })}
          </tr></thead>
          <tbody>
            {order.map((ri) => {
              const row = rows[ri];
              const band = bands[ri];
              return (
                <tr key={ri}>
                  <td className="mono" style={{ color: 'var(--g6)' }}>{offset + ri + 1}</td>
                  {row.map((cell, ci) => {
                    const b = band[ci];
                    const style = b ? (b.length === 1 ? { background: BAND_BG[b[0]] }
                      : { background: `linear-gradient(90deg, ${b.map((x, k) => `${BAND_BG[x]} ${(k * 100) / b.length}% ${((k + 1) * 100) / b.length}%`).join(', ')})` }) : undefined;
                    if (cell === null || cell === undefined) return <td key={ci} style={style}><span className="nul">NULL</span></td>;
                    const text = String(cell);
                    if (ci === fm && ruleColorMap) {
                      return (
                        <td key={ci}>
                          {text.split(',').map((id, k) => {
                            const rid = id.trim();
                            const pair = ruleColorMap[rid];
                            const a = pair ? columns.findIndex((c) => c.toUpperCase() === String(pair[0]).toUpperCase()) : -1;
                            const b = pair ? columns.findIndex((c) => c.toUpperCase() === String(pair[1]).toUpperCase()) : -1;
                            const own = a >= 0 && b >= 0 ? pairBand(row[a], row[b]) : null;
                            return <span key={rid}>{k > 0 && <span style={{ color: 'var(--g6)' }}> · </span>}<span style={{ color: own ? BAND_TEXT[own] : undefined, fontWeight: own === 'y' ? 700 : 400 }}>{rid}</span></span>;
                          })}
                        </td>
                      );
                    }
                    return <td key={ci} style={style}><span className="cellv" data-tip={text}>{text}</span></td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

const CF_OPTIONS = [['ALL', 'All'], ['green', 'Within 7 days'], ['yellow', '8-15 days'], ['red', 'Over 15 days']];
const SW = { green: '#53ce76', yellow: '#fbe058', red: '#eb1700' };

function PreviewBody({ rule, delta, color, setColor, origin }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const id = rule?.rule_id;
  // Reset during render, not in an effect: an effect let one request go out for the old page first.
  const scope = `${id}:${color}:${delta}`;
  const [seen, setSeen] = useState(scope);
  if (seen !== scope) { setSeen(scope); setPage(1); setSort(null); }
  const key = id ? `fr:${delta}:${id}:${color}:${sort ? `${sort.col}.${sort.dir}` : ''}:${page}` : null;
  const q = useQuery(key, (s) => api.failedRows(id, { page, size: PAGE, color, delta, sort }, s), { ttl: 30000 });
  const last = useRef(null);
  if (q.data) last.current = q.data;
  const data = q.data || last.current;
  // Older rows stay on screen while the next page loads; a failed load drops the spinner so the error shows.
  const busy = q.loading || q.refreshing || (!q.error && data !== q.data);
  // A rerun can leave fewer pages than the one being shown.
  useEffect(() => { if (q.data && q.data.page > q.data.total_pages) setPage(q.data.total_pages); }, [q.data]);
  const logged = useRef('');
  useEffect(() => {
    if (!q.data || logged.current === `${id}:${delta}`) return;
    logged.current = `${id}:${delta}`;
    if (origin === 'review') audit('bdc_review_failed_rows_viewed', id, `Viewed failed rows for rule "${id}" (under review)`);
    else audit('bdc_failed_rows_viewed', id, `Viewed failed rows for rule "${id}" — ${q.data.total_count ?? 0} rows`);
  }, [q.data, id, delta, origin]);

  const [c1, c2] = parseColorColumns(rule?.color_columns);
  const canColor = !!(c1 && c2 && data?.columns?.some((c) => c.toUpperCase() === c1) && data.columns.some((c) => c.toUpperCase() === c2));
  const anchor = useRef(null);
  const [slot, setSlot] = useState(null);
  useLayoutEffect(() => { setSlot(anchor.current?.closest('.modal')?.querySelector('.m-c') || null); }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {canColor && slot && createPortal(
        <div className="seg cf" role="group" aria-label="Colour filter">
          {CF_OPTIONS.map(([v, l]) => (
            <button type="button" key={v} className={color === v ? 'on' : ''} aria-pressed={color === v} onClick={() => setColor(v)}>
              {v !== 'ALL' && <span className="sw" style={{ background: SW[v] }} />}{l}
            </button>
          ))}
        </div>,
        slot,
      )}
      {q.error && !data ? (
        <ErrorState error={q.error} onRetry={q.reload} title={q.error.status === 404 ? 'No results table yet' : 'Could not load the failing rows'} />
      ) : !data ? (
        <Sk h={320} r={12} />
      ) : (
        <>
          {q.error && <div style={{ marginBottom: 10 }}><InlineError error={q.error} onRetry={q.reload} /></div>}
          <RowsTable columns={data.columns} rows={data.rows} offset={(data.page - 1) * PAGE} colorColumns={rule?.color_columns}
            busy={busy} empty={color === 'ALL' ? 'No failing rows' : 'No rows in this colour band'}
            sort={sort} onSort={(next) => { setSort(next); setPage(1); }} />
          <div className="m-pg">
            <Pager page={data.page} pages={data.total_pages} onPage={setPage} disabled={busy}>
              <span style={{ fontSize: 12, color: 'var(--g6)' }}>
                Showing {data.total_count ? `${fmt((data.page - 1) * PAGE + 1)}-${fmt(Math.min(data.page * PAGE, data.total_count))}` : 0} of {fmt(data.total_count)}
              </span>
            </Pager>
          </div>
        </>
      )}
    </>
  );
}

const SHEET_LOOK = { new_failures: ['New failures', '#eb1700', 'red'], resolved_rows: ['Resolved', '#328714', 'green'], persisting_rows: ['Persisting', '#ff6017', 'orange'] };

function DeltaBody({ rule, delta, sheet, from, to, setSheet }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const id = rule?.rule_id;
  const scope = `${id}:${sheet}:${from}:${to}:${delta}`;
  const [seen, setSeen] = useState(scope);
  if (seen !== scope) { setSeen(scope); setPage(1); setSort(null); }
  const key = id ? `delta:${delta}:${id}:${from || ''}:${to || ''}:${sheet}:${sort ? `${sort.col}.${sort.dir}` : ''}:${page}` : null;
  const q = useQuery(key, (s) => api.deltaRows(id, { sheet, page, size: PAGE, from, to, delta, sort }, s), { ttl: 60000 });
  const last = useRef(null);
  if (q.data) last.current = q.data;
  const data = q.data || last.current;
  const busy = q.loading || q.refreshing || (!q.error && data !== q.data);
  useEffect(() => { if (q.data && q.data.page > q.data.total_pages) setPage(q.data.total_pages); }, [q.data]);
  const logged = useRef('');
  useEffect(() => {
    const k = `${id}:${from}:${to}`;
    if (!id || logged.current === k) return;
    logged.current = k;
    audit('bdc_delta_report_viewed', id, `Viewed delta report for rule "${id}" (sheet: ${sheet}${from ? `, snapshot: ${from}` : ''})`);
  }, [id, from, to, sheet]);

  if (q.error && !data) {
    return <ErrorState error={q.error} onRetry={q.reload} title={q.error.status === 404 ? 'Not enough runs to compare' : 'Could not compare the runs'} />;
  }
  return (
    <>
      <p className="card-sub" style={{ margin: '0 0 12px' }}>{data ? `Comparing the ${deltaSubtitle(rule, data)}.` : 'Comparing the two most recent runs…'}</p>
      <div className="dl-stats" role="tablist" aria-label="Delta sheets">
        {DELTA_SHEETS.map((k) => {
          const [l, c, tone] = SHEET_LOOK[k];
          return (
            <button type="button" key={k} role="tab" aria-selected={sheet === k} className="stat" onClick={() => setSheet(k)}
              style={{ textAlign: 'left', cursor: 'pointer', transition: 'all .25s', ...(sheet === k ? { borderColor: c, boxShadow: `0 0 0 3px ${c}22` } : {}) }}>
              <span className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="sw" style={{ background: c }} />{l}</span>
              <div className="v" style={{ color: `var(--${tone}-t)` }}>{data ? fmt(data.sheet_counts?.[k]) : <Sk w={50} h={20} />}</div>
            </button>
          );
        })}
      </div>
      {!data ? <Sk h={300} r={12} /> : (
        <>
          {q.error && <div style={{ marginBottom: 10 }}><InlineError error={q.error} onRetry={q.reload} /></div>}
          <RowsTable columns={data.columns} rows={data.rows} offset={(data.page - 1) * PAGE} colorColumns={rule?.color_columns}
            busy={busy} sort={sort} onSort={(next) => { setSort(next); setPage(1); }}
            empty={sheet === 'new_failures' ? 'No new failures since the earlier run' : sheet === 'resolved_rows' ? 'Nothing was resolved between these runs' : 'No failures carried over'} />
          <div className="m-pg">
            <Pager page={data.page} pages={data.total_pages} onPage={setPage} disabled={busy}>
              <span style={{ fontSize: 12, color: 'var(--g6)' }}>{plural(data.total_count, 'row')}</span>
            </Pager>
          </div>
        </>
      )}
    </>
  );
}

function RunPickerBody({ rule, delta, initial, onApply, onCancel }) {
  const id = rule?.rule_id;
  const q = useQuery(id ? `stg:${delta}:${id}` : null, (s) => api.stgTables(id, delta, s), { ttl: 60000 });
  const [picked, setPicked] = useState({ from: initial.from || null, to: initial.to || null });
  useEffect(() => {
    if (id) audit('bdc_advanced_delta_picker_opened', id, `Opened advanced delta snapshot picker for rule "${id}"`);
  }, [id]);
  const tables = q.data?.tables;
  // '' as "to" means the current results (CORE). After a passing run that is
  // newer than every snapshot, so it has to be offered, and it is the default.
  const from = picked.from ?? tables?.find((t) => t.is_previous)?.table_name ?? null;
  const to = picked.to ?? '';

  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} title="Could not list past runs" />;
  if (!tables) return <Sk h={260} r={12} />;
  if (!tables.length) return <Empty icon="database" title="No archived runs">This rule has no historical snapshots to compare yet.</Empty>;
  const chosen = { from, to };
  const list = (side) => (
    <div>
      <span className="lbl" style={{ display: 'block', marginBottom: 8 }}>{side === 'from' ? 'From (older run)' : 'To (newer run)'}</span>
      <div className="rlist" role="listbox" aria-label={side === 'from' ? 'Older run' : 'Newer run'}>
        {side === 'to' && (
          <button type="button" role="option" aria-selected={to === ''} className={`rli ${to === '' ? 'on' : ''}`} onClick={() => setPicked({ ...chosen, to: '' })}>
            <span className="cb" style={to === '' ? { background: '#328714' } : undefined}>{to === '' && <I n="check" />}</span>
            <span className="m"><span className="t" style={{ display: 'block' }}>Current results</span><span className="s">The latest run (default)</span></span>
          </button>
        )}
        {tables.map((t) => {
          const on = chosen[side] === t.table_name;
          const other = chosen[side === 'from' ? 'to' : 'from'];
          return (
            <button type="button" key={t.table_name} role="option" aria-selected={on} disabled={other === t.table_name}
              className={`rli ${on ? 'on' : ''}`} onClick={() => setPicked({ ...chosen, [side]: t.table_name })}>
              <span className="cb" style={on ? { background: side === 'from' ? '#0f68b2' : '#328714' } : undefined}>{on && <I n="check" />}</span>
              <span className="m"><span className="t" style={{ display: 'block' }} data-tip={fmtRunSuffix(t.run_suffix || t.table_name)}>{fmtRunSuffix(t.run_suffix || t.table_name)}</span>
                <span className="s">{t.is_previous ? 'Previous run (default)' : t.is_latest ? 'Newest saved run' : 'Archived run'}</span></span>
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <>
      <div className="run-pick">{list('from')}{list('to')}</div>
      {from && to && from >= to && <p className="card-sub" style={{ color: 'var(--orange-t)', marginTop: 12 }}>The &quot;from&quot; run is newer than the &quot;to&quot; run, so new and resolved rows will be swapped.</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={!from} onClick={() => onApply(from, to || null)}><I n="chart" />Compare these runs</button>
      </div>
    </>
  );
}

function RuleRunPicker({ rules, onRun }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rules.filter((r) => !qq || `${r.rule_id} ${r.rule_title}`.toLowerCase().includes(qq));
  }, [rules, q]);
  return (
    <>
      <label className="field" style={{ marginBottom: 10 }}><I n="search" /><input data-autofocus="" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules" aria-label="Search rules" /></label>
      <div className="rlist" style={{ maxHeight: 340, padding: 0 }}>
        {list.length ? list.map((r) => (
          <button type="button" key={r.rule_id} className="rli" onClick={() => onRun(r.rule_id)}>
            <span className="rid">{r.rule_id}</span>
            <span className="m"><span className="t" style={{ display: 'block' }} data-tip={r.rule_title}>{r.rule_title}</span><span className="s">{r.dataset_title || 'No dataset'}</span></span>
            <SevBadge s={r.severity} />
          </button>
        )) : <Empty title="No rules match" />}
      </div>
    </>
  );
}

const CPAGE = 100;

function ConsolidatedBody({ delta, canGenerate, canDownload, limited, reportName, setReportName, download, onDownload }) {
  const toast = useToast();
  const [view, setView] = useState('report');
  const [gen, setGen] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const ctrl = useRef(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const latest = useQuery(!reportName && !fresh ? `cons:latest:${delta}` : null, (s) => api.consolidatedLatest(delta, s), { ttl: 60000 });
  const named = useQuery(reportName && fresh?.report_name !== reportName ? `cons:fetch:${delta}:${reportName}` : null, (s) => api.consolidatedFetch(reportName, delta, s), { ttl: 300000 });
  const history = useQuery(view === 'history' ? `cons:history:${delta}` : null, (s) => api.consolidatedHistory(delta, s), { ttl: 30000 });

  const report = fresh && (!reportName || fresh.report_name === reportName) ? fresh : reportName ? named.data : latest.data?.found ? latest.data : null;
  const loading = reportName ? named.loading : latest.loading;
  const loadError = reportName ? named.error : latest.error;
  const logged = useRef('');
  useEffect(() => {
    if (!report?.report_name || logged.current === report.report_name || fresh) return;
    logged.current = report.report_name;
    if (reportName) audit('bdc_consolidated_history_viewed', reportName, `Viewed historic consolidated report: ${reportName}`);
    else audit('bdc_consolidated_latest_viewed', report.report_name, `Viewed latest consolidated report from Snowflake: ${report.report_name}`);
  }, [report, reportName, fresh]);
  useEffect(() => { setPage(1); }, [search, report, sort]);
  useEffect(() => { setSort(null); }, [report]);

  const generate = async () => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    setGen({ pct: 0, label: 'Starting…' });
    setView('report');
    try {
      const done = await stream(`/api/consolidated-report/prepare?delta_mode=${delta}`, {
        signal: ctrl.current.signal,
        isLast: (e) => e.type === 'ready',
        onEvent: (e) => { if (e.type !== 'ready' && e.type !== 'error') setGen({ pct: e.pct ?? 0, label: e.label ?? 'Working…' }); },
      });
      const saved = done.persisted !== false;
      const next = { report_name: done.report_name, persisted: saved, summary: { ...done.summary, generated_at: new Date().toISOString() }, preview: done.preview };
      setFresh(next);
      setReportName(done.report_name);
      loadQuery(`cons:history:${delta}`, (s) => api.consolidatedHistory(delta, s), { force: true });
      audit('bdc_consolidated_report_generated', done.report_name || '', `Generated consolidated failed rows report (rules: ${done.summary?.rules_count ?? 0})`);
      toast(saved ? 'Consolidated report is ready' : 'Report built, but saving it to Snowflake failed', saved ? 'ok' : 'bad');
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Report generation failed: ${e.message}`, 'bad');
    } finally {
      setGen(null);
    }
  };

  const rows = useMemo(() => report?.preview?.rows || [], [report]);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const hit = s ? rows.filter((r) => r.some((c) => c !== null && String(c).toLowerCase().includes(s))) : rows;
    return sortRows(hit, report?.preview?.columns || [], sort);
  }, [rows, search, sort, report]);
  const pages = Math.max(1, Math.ceil(filtered.length / CPAGE));
  const pageRows = filtered.slice((page - 1) * CPAGE, page * CPAGE);

  const head = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
      <div className="seg" role="tablist" aria-label="Consolidated report view">
        <button type="button" role="tab" aria-selected={view === 'report'} className={view === 'report' ? 'on' : ''} onClick={() => setView('report')}><I n="records" />Report</button>
        <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}><I n="time" />History</button>
      </div>
      {view === 'report' && report && (
        <label className="field search-in" style={{ height: 30 }}><I n="search" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this report" aria-label="Search this report" /></label>
      )}
      <span style={{ flex: 1 }} />
      {view === 'report' && report?.report_name && report.persisted !== false && canDownload && (
        <button type="button" className="btn sm ghost" onClick={() => onDownload(report.report_name)} disabled={!!download}>
          <I n="download" />{download ? `${download.label} · ${download.pct}%` : 'Download Excel'}
        </button>
      )}
      {canGenerate && <button type="button" className="btn sm primary" onClick={generate} disabled={!!gen}><I n="refresh" />Generate new report</button>}
    </div>
  );

  if (gen) {
    return (
      <>
        {head}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="lbl">{gen.label}</span><b className="num">{gen.pct}%</b></div>
        <div className="bigbar"><span style={{ width: `${gen.pct}%` }} /></div>
        <p className="card-sub" style={{ marginTop: 12 }}>This can take a few minutes on large cycles. You can keep working; closing this window cancels the run.</p>
      </>
    );
  }
  if (view === 'history') {
    return (
      <>
        {head}
        {history.error ? <ErrorState error={history.error} onRetry={history.reload} title="Could not load report history" />
          : !history.data ? <Sk h={220} r={12} />
            : !history.data.reports.length ? <Empty icon="records" title="No reports yet">Generate the first consolidated report for this cadence.</Empty>
              : (
                <div className="att">
                  {history.data.reports.map((r, i) => (
                    <button type="button" className="att-row" key={r.report_name} style={{ animationDelay: `${Math.min(i, 10) * 40}ms`, textAlign: 'left' }}
                      onClick={() => { setFresh(null); setReportName(i === 0 ? null : r.report_name); setView('report'); }}>
                      <span className="rid">{i === 0 ? 'Latest' : `#${history.data.reports.length - i}`}</span>
                      <div className="meta"><div className="t mono" data-tip={r.report_name}>{r.report_name}</div>
                        <div className="s"><span>{fmtDateTime(r.generated_at)}</span><span>{plural(r.rules_count ?? 0, 'rule')}</span><span>{fmt(r.duplicates_removed)} duplicates removed</span></div></div>
                      <div className="fr"><b>{fmt(r.total_rows)}</b><span>unique rows</span></div>
                      <span className="go"><I n="chevR" /></span>
                    </button>
                  ))}
                </div>
              )}
      </>
    );
  }
  return (
    <>
      {head}
      {loading ? <Sk h={300} r={12} />
        : loadError ? <ErrorState error={loadError} onRetry={reportName ? named.reload : latest.reload} title="Could not load the report" />
          : !report ? (
            <Empty icon="records" title="No consolidated report yet">{canGenerate ? 'Generate one to combine every rule’s failing rows into one workbook.' : 'An operator has to generate the first one for this cadence.'}</Empty>
          ) : (
            <>
              <div className="dl-stats">
                <div className="stat"><span className="lbl">Unique rows</span><div className="v">{fmt(report.summary.total_rows)}</div></div>
                <div className="stat"><span className="lbl">Duplicates removed</span><div className="v">{fmt(report.summary.duplicates_removed)}</div></div>
                <div className="stat"><span className="lbl">Generated</span><div className="v" style={{ fontSize: 14, marginTop: 10 }}>{fmtDateTime(report.summary.generated_at)}</div></div>
              </div>
              {report.persisted === false && <div className="note-box" style={{ marginBottom: 10 }}><I n="alert" /><span>This report could not be saved to Snowflake, so it is not in History and can’t be downloaded. Generate it again to keep a copy.</span></div>}
              <p className="card-sub" style={{ margin: '0 0 10px' }}>{limited && 'Showing only rules from your datasets. '}<span className="mono">FAILURE_MODE</span> lists every rule that flagged the row. {report.report_name && <span className="mono">{report.report_name}</span>}</p>
              {report.preview.truncated && (
                <div className="note-box" style={{ marginBottom: 10 }}><I n="info" /><span>Showing the first {fmt(rows.length)} of {fmt(report.preview.total)} rows here; search and sorting cover these only. {report.persisted !== false && canDownload ? 'Download the Excel for every row.' : ''}</span></div>
              )}
              <RowsTable columns={report.preview.columns} rows={pageRows} offset={(page - 1) * CPAGE} ruleColorMap={report.summary.rule_color_map || null}
                empty={search ? 'No rows match your search' : 'No failing rows'} sort={sort} onSort={setSort} />
              <div className="m-pg">
                <Pager page={page} pages={pages} onPage={setPage}>
                  <span style={{ fontSize: 12, color: 'var(--g6)' }}>{fmt(filtered.length)} rows{filtered.length !== rows.length ? ` (filtered from ${fmt(rows.length)})` : ''}</span>
                </Pager>
              </div>
            </>
          )}
    </>
  );
}

function ReviewHistoryBody({ ruleId, delta }) {
  // Asked per rule: filtering the newest 1000 decisions of every rule lost older history.
  const q = useQuery(`rvhist:${delta}:${ruleId}`, (s) => api.reviewHistory(ruleId, delta, s), { ttl: 15000 });
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} title="Could not load review history" />;
  if (!q.data) return <Sk h={200} r={12} />;
  const items = q.data.history;
  if (!items.length) return <Empty icon="records" title="No decisions yet">Nobody has reviewed this rule in this cadence.</Empty>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="t">
        <thead><tr><th>Decision</th><th>Reviewed by</th><th>When</th><th>Note</th></tr></thead>
        <tbody>
          {items.map((h, i) => (
            <tr key={h.REVIEW_ID || i} style={{ cursor: 'default' }}>
              <td><span className={`hb ${h.STATUS === 'ACCEPTED' ? 'ok' : 'crit'}`}>{h.STATUS === 'ACCEPTED' ? 'Approved' : 'Rejected'}</span>{i === 0 && <span className="rid" style={{ marginLeft: 6 }}>Latest</span>}</td>
              <td><span className="trunc" style={{ maxWidth: 220 }} data-tip={h.REVIEWED_BY}>{h.REVIEWED_BY || '-'}</span></td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(h.REVIEWED_AT)}</td>
              <td><span className="trunc" style={{ maxWidth: 320 }} data-tip={h.REVIEW_NOTE}>{h.REVIEW_NOTE || '-'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_OF = { pending: 'NOT_REVIEWED', approved: 'ACCEPTED', rejected: 'REJECTED' };

function Review({ review, model, delta, filter, setFilter, onPeek, onHistory, onRule, onChanged }) {
  const toast = useToast();
  const [notes, setNotes] = useState({});
  const [noting, setNoting] = useState(() => new Set());
  const [missing, setMissing] = useState(() => new Set());
  const [busy, setBusy] = useState({});
  const [leaving, setLeaving] = useState(() => new Set());
  const [bulkAsk, setBulkAsk] = useState(false);
  useEffect(() => {
    if (!bulkAsk) return undefined;
    const t = setTimeout(() => setBulkAsk(false), 6000);
    return () => clearTimeout(t);
  }, [bulkAsk]);
  const undoable = useRef(new Map());
  const noteRefs = useRef({});
  const key = `review:${delta}`;

  const rules = useMemo(() => {
    const seen = new Set();
    return (review.data?.rules || []).filter((r) => (seen.has(r.rule_id) ? false : seen.add(r.rule_id)))
      .map((r) => ({ ...r, rule_title: r.rule_title || r.rule_id, severity: (r.severity || '').toUpperCase(), status: r.review_status || 'NOT_REVIEWED' }))
      .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.pass_percentage - b.pass_percentage);
  }, [review.data]);

  if (review.error && !review.data) return <section className="card"><ErrorState error={review.error} onRetry={review.reload} title="Could not load the review queue" /></section>;
  if (!review.data) {
    return (
      <>
        <section className="card" style={{ marginBottom: 16 }}><div className="card-b"><Sk w="40%" h={18} /><Sk w="30%" h={12} style={{ marginTop: 10 }} /><Sk h={8} style={{ marginTop: 14 }} /></div></section>
        <div className="rv-list">{[0, 1, 2, 3].map((i) => <div className="rv" key={i} style={{ animation: 'none', padding: 16 }}><span /><Sk w={48} h={48} className="circle" /><div><Sk w="30%" h={14} /><Sk w="60%" h={14} style={{ marginTop: 8 }} /></div></div>)}</div>
      </>
    );
  }

  const n = rules.length;
  const acc = rules.filter((r) => r.status === 'ACCEPTED').length;
  const rej = rules.filter((r) => r.status === 'REJECTED').length;
  const show = rules.filter((r) => filter === 'all' || r.status === STATUS_OF[filter] || leaving.has(r.rule_id));
  const failing = (id) => model?.failedByRule?.[id] ?? null;

  const applyLocal = (ids, status, note, me) => {
    const now = new Date().toISOString();
    setQueryData(key, (d) => d && ({
      ...d,
      rules: d.rules.map((r) => (ids.includes(r.rule_id) ? { ...r, review_status: status, last_reviewed_by: me, last_reviewed_at: now, last_review_note: note } : r)),
    }));
  };
  const settle = (ids, status, note) => {
    const animate = filter === 'pending' || (filter !== 'all' && STATUS_OF[filter] !== status);
    if (!animate) { applyLocal(ids, status, note, 'you'); onChanged(); return; }
    setLeaving((s) => new Set([...s, ...ids]));
    setTimeout(() => {
      applyLocal(ids, status, note, 'you');
      setLeaving((s) => { const next = new Set(s); ids.forEach((id) => next.delete(id)); return next; });
      onChanged();
    }, 430);
  };
  const undo = async (ids) => {
    const reviewIds = ids.map((id) => undoable.current.get(id)).filter(Boolean);
    if (!reviewIds.length) return;
    try {
      await api.undoReviews(reviewIds);
      ids.forEach((id) => undoable.current.delete(id));
      ids.forEach((id) => audit('bdc_review_undone', id, `Took back the review decision for rule "${id}"`));
      toast(ids.length > 1 ? `Took back ${plural(ids.length, 'decision')}` : `${ids[0]} decision taken back`, 'info');
      onChanged();
      review.reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const startNote = (id) => {
    setNoting((s) => new Set(s).add(id));
    requestAnimationFrame(() => noteRefs.current[id]?.focus());
  };
  const stopNote = (id) => setNoting((s) => { const c = new Set(s); c.delete(id); return c; });

  const decide = async (r, status) => {
    const note = (notes[r.rule_id] || '').trim();
    if (status === 'REJECTED' && !note) {
      setMissing((s) => new Set(s).add(r.rule_id));
      startNote(r.rule_id);
      return;
    }
    setBusy((b) => ({ ...b, [r.rule_id]: status }));
    try {
      const res = await api.submitReview({
        rule_id: r.rule_id, rule_title: r.rule_title, status, note: note || null,
        sql_predicate_snapshot: r.sql_predicate || null, failed_row_count: failing(r.rule_id),
      }, delta);
      undoable.current.set(r.rule_id, res.review_id);
      audit(status === 'ACCEPTED' ? 'bdc_review_accepted' : 'bdc_review_rejected', r.rule_id,
        status === 'ACCEPTED' ? `Approved rule "${r.rule_title || r.rule_id}" — now visible to users`
          : `Rejected rule "${r.rule_title || r.rule_id}": ${note}`);
      setNotes((m) => { const c = { ...m }; delete c[r.rule_id]; return c; });
      stopNote(r.rule_id);
      settle([r.rule_id], status, note || null);
      toast(status === 'ACCEPTED' ? `${r.rule_id} approved and now visible to users` : `${r.rule_id} rejected`, status === 'ACCEPTED' ? 'ok' : 'bad', 'Undo', () => undo([r.rule_id]));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy((b) => ({ ...b, [r.rule_id]: null }));
    }
  };

  const healthy = rules.filter((r) => r.status === 'NOT_REVIEWED' && r.pass_percentage >= 95);
  const approveHealthy = async () => {
    // Approving makes rules visible to every user, so a bulk approve asks once first.
    if (!bulkAsk) { setBulkAsk(true); return; }
    setBulkAsk(false);
    const ids = healthy.map((r) => r.rule_id);
    setBusy((b) => ({ ...b, __bulk: true }));
    try {
      const res = await api.approveBulk(ids, 'Bulk approved, within threshold', delta);
      Object.entries(res.review_ids || {}).forEach(([id, rid]) => undoable.current.set(id, rid));
      ids.forEach((id) => audit('bdc_review_accepted', id, `Approved rule "${id}" (bulk approve, pass rate within threshold)`));
      settle(ids, 'ACCEPTED', 'Bulk approved, within threshold');
      toast(`Approved ${plural(ids.length, 'healthy rule')}`, 'ok', 'Undo', () => undo(ids));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy((b) => ({ ...b, __bulk: false }));
    }
  };

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-b rv-head">
          <div>
            <div className="card-t" style={{ fontSize: 18 }}>Sign-off queue · {model ? cycleLabel(model.range, delta) : delta ? 'Semi-Monthly' : 'Quarterly'}</div>
            <div className="card-sub" style={{ marginTop: 4 }}><b style={{ color: 'var(--g8)' }}>{acc + rej} of {n}</b> rules reviewed · {acc} approved · {rej} rejected · only approved rules are visible to users</div>
            <div className="rv-prog" role="progressbar" aria-valuemin={0} aria-valuemax={n} aria-valuenow={acc + rej} aria-label="Review progress">
              <span style={{ width: n ? `${(acc / n) * 100}%` : 0, background: 'var(--green)' }} />
              <span style={{ width: n ? `${(rej / n) * 100}%` : 0, background: 'var(--red)' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Show">
              {REVIEW_FILTERS.map(([v, l]) => <button type="button" key={v} className={filter === v ? 'on' : ''} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>)}
            </div>
            {/* The tip sits on a wrapper: a disabled button gets no pointer events, so its own tip never showed. */}
            <span className="tipw" data-tip={healthy.length ? `Approve ${plural(healthy.length, 'pending rule')} at 95% or above` : 'No pending rules at 95% or above'} data-tip-always="">
              <button type="button" className="btn sm ok" onClick={approveHealthy} disabled={!healthy.length || busy.__bulk} aria-live="polite">
                <I n="check" />{busy.__bulk ? 'Approving…' : bulkAsk ? `Confirm: approve ${plural(healthy.length, 'rule')}` : 'Approve all healthy'}
              </button>
            </span>
            {bulkAsk && <button type="button" className="btn sm ghost" onClick={() => setBulkAsk(false)}>Cancel</button>}
          </div>
        </div>
      </section>
      <div className="rv-list">
        {show.length ? show.map((r, i) => {
          const decided = r.status !== 'NOT_REVIEWED';
          const isNoting = noting.has(r.rule_id);
          const saving = busy[r.rule_id];
          return (
            <div className={`rv ${isNoting ? 'noting' : ''} ${leaving.has(r.rule_id) ? 'out' : ''}`} key={r.rule_id} style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
              <span className="bar" style={{ background: SEV_COLOR[r.severity] || '#a39992' }} />
              <Ring p={r.pass_percentage} none={r.no_result} size={48} stroke={5} />
              <div className="m">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" className="rid" onClick={() => onRule(r.rule_id)} aria-label={`Open ${r.rule_id} details`}>{r.rule_id}</button>
                  <SevBadge s={r.severity} /><span className="card-sub">{r.dataset_title || 'No dataset'}</span>
                </div>
                <div className="rt" style={{ marginTop: 6, maxWidth: 'none', whiteSpace: 'normal' }}>{r.rule_title}</div>
                {decided && (
                  <div className="stamp" style={{ marginTop: 6 }}>
                    {r.status === 'ACCEPTED' ? '✓ Approved' : '✕ Rejected'} by {r.last_reviewed_by || 'unknown'}
                    {r.last_reviewed_at ? ` · ${fmtDateTime(r.last_reviewed_at)}` : ''}
                    {r.last_review_note ? ` · “${r.last_review_note}”` : ''}
                    <button type="button" style={{ marginLeft: 8, fontWeight: 700, color: 'var(--blue)' }} onClick={() => onHistory(r.rule_id)}>History</button>
                  </div>
                )}
                <div className="note">
                  <textarea ref={(el) => { noteRefs.current[r.rule_id] = el; }} value={notes[r.rule_id] || ''}
                    onChange={(e) => { setNotes((m) => ({ ...m, [r.rule_id]: e.target.value })); setMissing((s) => { const c = new Set(s); c.delete(r.rule_id); return c; }); }}
                    placeholder={missing.has(r.rule_id) ? 'A reason is required to reject' : 'Why is this being rejected? (required)'}
                    aria-label={`Reason for rejecting ${r.rule_id}`} aria-invalid={missing.has(r.rule_id)} maxLength={4000}
                    style={missing.has(r.rule_id) ? { borderColor: 'var(--red)' } : undefined} />
                </div>
              </div>
              <div className="fr" style={{ textAlign: 'right' }}><b className="num" style={{ fontSize: 16 }}>{fmt(failing(r.rule_id))}</b><div className="lbl">failing rows</div></div>
              <div className="btns">
                {undoable.current.has(r.rule_id) && decided ? (
                  <button type="button" className="btn sm ghost" onClick={() => undo([r.rule_id])}>Undo</button>
                ) : null}
                <button type="button" className="btn sm ghost" onClick={() => onPeek(r.rule_id)}><I n="eye" />Rows</button>
                {r.status !== 'REJECTED' && (
                  <button type="button" className="btn sm danger" disabled={!!saving} onClick={() => (isNoting ? decide(r, 'REJECTED') : startNote(r.rule_id))}>
                    <I n="close" />{saving === 'REJECTED' ? 'Saving…' : isNoting ? 'Confirm reject' : 'Reject'}
                  </button>
                )}
                {isNoting && <button type="button" className="btn sm ghost" onClick={() => stopNote(r.rule_id)}>Cancel</button>}
                {r.status !== 'ACCEPTED' && !isNoting && (
                  <button type="button" className="btn sm ok" disabled={!!saving} onClick={() => decide(r, 'ACCEPTED')}><I n="check" />{saving === 'ACCEPTED' ? 'Saving…' : 'Approve'}</button>
                )}
              </div>
            </div>
          );
        }) : (
          <section className="card">
            {filter === 'pending' ? <Empty icon="check" title="Queue cleared">Every rule for this cycle has been signed off.</Empty>
              : <Empty icon="check" title="Nothing here yet">Decisions show up here as rules are reviewed.</Empty>}
          </section>
        )}
      </div>
    </>
  );
}

const CURATED = {
  'rule-input': ['RULE_ID', 'RULE_TITLE', 'DATASET_TITLE', 'SEVERITY', 'IS_ACTIVE'],
  'date-input': ['REPORT_SET', 'FROM_DATE', 'TO_DATE', 'IS_ACTIVE', 'NOTES'],
};
const MONO = new Set(['RULE_ID', 'TARGET_TABLE', 'DELTA_TABLE', 'REPORT_SET', 'SQL_PREDICATE', 'ID']);

const tableKey = (type, page) => `dq:${type}:${page}`;
const colIndex = (columns, name) => columns.findIndex((c) => String(c).toUpperCase() === name);

function DqTable({ type, sections, editMode, setEditMode, onNew, onEdit, onChanged }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState({});
  useEffect(() => { setPage(1); setSearch(''); }, [type]);
  const q = useQuery(tableKey(type, page), (s) => api.dqTable(type, page, PAGE, s), { ttl: 20000 });
  const prev = useRef(null);
  if (q.data) prev.current = { type, data: q.data };
  const data = q.data || (prev.current?.type === type ? prev.current.data : null);
  useEffect(() => { if (q.data && q.data.page > q.data.total_pages) setPage(q.data.total_pages); }, [q.data]);

  const view = useMemo(() => {
    if (!data) return null;
    const all = data.columns;
    const curated = CURATED[type]?.filter((c) => colIndex(all, c) >= 0);
    const cols = curated?.length >= 3 ? curated : all.map((c) => String(c).toUpperCase());
    const s = search.trim().toLowerCase();
    const rows = s ? data.rows.filter((r) => r.some((c) => c && String(c).toLowerCase().includes(s))) : data.rows;
    return { cols, idx: cols.map((c) => colIndex(all, c)), rows, all };
  }, [data, type, search]);

  const toggle = async (row) => {
    const all = data.columns;
    const isRule = type === 'rule-input';
    const key = row[colIndex(all, isRule ? 'RULE_ID' : 'ID')];
    const active = isTrue(row[colIndex(all, 'IS_ACTIVE')]);
    setPending((p) => ({ ...p, [key]: !active }));
    try {
      const res = isRule ? await api.toggleRuleActive(key, !active) : await api.toggleDateActive(key, !active);
      const retired = isRule && Array.isArray(res?.retired) ? res.retired : [];
      let details = `Rule "${key}" ${!active ? 'activated' : 'deactivated'} in ${type}`;
      if (!isRule) {
        const set = row[colIndex(all, 'REPORT_SET')];
        const from = String(row[colIndex(all, 'FROM_DATE')] || '').slice(0, 10);
        const to = String(row[colIndex(all, 'TO_DATE')] || '').slice(0, 10);
        details = `${!active ? 'Activated' : 'Deactivated'} — ${[set, from && to ? `${from} → ${to}` : null].filter(Boolean).join(': ')}`;
      }
      audit('bdc_rule_toggled', String(key), details);
      toast(isRule
        ? `${key} ${!active ? 'activated' : 'deactivated'}${retired.length ? `; ${retired.join(', ')} switched off` : ''}`
        : (!active ? 'Range activated; other ranges in this report set were switched off' : 'Range deactivated'), 'ok');
      onChanged?.();
      await loadQuery(tableKey(type, page), (s) => api.dqTable(type, page, PAGE, s), { force: true });
    } catch (e) {
      toast(`Could not change it: ${e.message}`, 'bad');
    } finally {
      setPending((p) => { const c = { ...p }; delete c[key]; return c; });
    }
  };

  const title = sections.find((x) => x.id === type)?.label;
  const editable = type === 'rule-input' || type === 'date-input';
  const lockedToggles = type === 'rule-input' && !editMode;
  return (
    <>
      <div className="card-h" style={{ paddingBottom: 14, borderBottom: '1px solid var(--g2)' }}>
        <div className="card-t">{title}</div>
        <div className="su-tools">
          <label className="field"><I n="search" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this page" aria-label="Search this page" /></label>
          {type === 'rule-input' && (
            <div className="seg" role="group" aria-label="Edit mode">
              <button type="button" className={!editMode ? 'on' : ''} aria-pressed={!editMode} onClick={() => setEditMode(false)}><I n="eye" />View</button>
              <button type="button" className={editMode ? 'on' : ''} aria-pressed={editMode} onClick={() => setEditMode(true)}><I n="edit" />Edit</button>
            </div>
          )}
          {type === 'rule-input' && <button type="button" className="btn sm primary" onClick={onNew}><I n="add" />New rule</button>}
          {type === 'date-input' && <button type="button" className="btn sm primary" onClick={onNew}><I n="add" />New date range</button>}
          {type === 'date-input' && <span className="card-sub">One active range per report set</span>}
          <button type="button" className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => q.reload()} aria-label="Reload table" data-tip="Reload" data-tip-always=""><I n="refresh" style={{ width: 13, height: 13 }} /></button>
        </div>
      </div>
      {q.error && !data ? <ErrorState error={q.error} onRetry={q.reload} title="Could not load this table" />
        : !view ? <div style={{ padding: 20 }}>{Array.from({ length: 8 }, (_, i) => <Sk key={i} h={30} style={{ marginBottom: 8 }} />)}</div>
          : (
            <>
              {q.error && <div style={{ padding: '10px 20px 0' }}><InlineError error={q.error} onRetry={q.reload} /></div>}
              <div style={{ overflow: 'auto', maxHeight: 560, position: 'relative' }} tabIndex={0} role="region" aria-label={`${title || type} rows`} aria-busy={q.loading || q.refreshing}>
                {!view.rows.length ? <Empty title={search ? 'No rows on this page match' : 'This table is empty'} /> : (
                  <table className="t">
                    <thead><tr>{view.cols.map((c) => <th key={c} className={c === 'DATASET_TITLE' ? 'c-ds' : ''}>{c.replace(/_/g, ' ')}</th>)}{editable && <th><span className="sr">Edit</span></th>}</tr></thead>
                    <tbody>
                      {view.rows.map((row, ri) => {
                        const keyVal = row[colIndex(view.all, type === 'date-input' ? 'ID' : 'RULE_ID')] ?? ri;
                        return (
                          <tr key={`${keyVal}-${ri}`} style={{ cursor: 'default' }}>
                            {view.cols.map((c, ci) => {
                              const v = row[view.idx[ci]];
                              if (c === 'IS_ACTIVE' && editable) {
                                const on = keyVal in pending ? pending[keyVal] : isTrue(v);
                                return (
                                  <td key={c}>
                                    <span className="tipw" data-tip={lockedToggles ? 'Switch to Edit to change status' : undefined} data-tip-always="">
                                      <Toggle on={on} busy={keyVal in pending} disabled={lockedToggles} onClick={() => toggle(row)} label={`${on ? 'Deactivate' : 'Activate'} ${keyVal}`} />
                                    </span>
                                  </td>
                                );
                              }
                              if (v === null || v === undefined) return <td key={c} className={c === 'DATASET_TITLE' ? 'c-ds' : ''}><span className="muted">-</span></td>;
                              const text = String(v);
                              if (c === 'RULE_ID') return <td key={c}><span className="rid">{text}</span></td>;
                              return (
                                <td key={c} className={c === 'DATASET_TITLE' ? 'c-ds card-sub' : ''}>
                                  <span className={`cell-clip ${MONO.has(c) ? 'mono' : ''}`} data-tip={text} data-tip-mono={MONO.has(c) ? '' : undefined}>
                                    {c.endsWith('_DATE') && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text}
                                  </span>
                                </td>
                              );
                            })}
                            {editable && (
                              <td>
                                <span className="tipw" data-tip={type === 'rule-input' && !editMode ? 'Switch to Edit to change rules' : 'Edit'} data-tip-always="">
                                  <button type="button" className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => onEdit(String(keyVal))}
                                    disabled={type === 'rule-input' && !editMode} aria-label={`Edit ${keyVal}`}>
                                    <I n="edit" style={{ width: 13, height: 13 }} />
                                  </button>
                                </span>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="tfoot">
                <Pager page={data.page} pages={data.total_pages} onPage={setPage} disabled={q.loading}>
                  <span>{fmt(data.total_count)} rows{search ? ` · ${view.rows.length} on this page match` : ''}</span>
                </Pager>
              </div>
            </>
          )}
    </>
  );
}

const RESULT = {
  success: ['ok', 'Succeeded'], partial: ['warn', 'Some rules failed'], failed: ['crit', 'Failed'], running: ['new', 'Running'], detached: ['warn', 'Detached'], lost: ['warn', 'Lost'],
};
const duration = (s) => (s == null ? '-' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

function RunLog() {
  const q = useQuery('bdc:runs', (s) => api.runs(s), { ttl: 15000 });
  return (
    <>
      <div className="card-h" style={{ paddingBottom: 14, borderBottom: '1px solid var(--g2)' }}>
        <div className="card-t">Validation log</div>
        <div className="su-tools">
          <span className="card-sub">Runs started from SmartHub, most recent first</span>
          <button type="button" className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => q.reload()} aria-label="Reload log" data-tip="Reload" data-tip-always=""><I n="refresh" style={{ width: 13, height: 13 }} /></button>
        </div>
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} title="Could not load the run log" />
        : !q.data ? <div style={{ padding: 20 }}>{Array.from({ length: 6 }, (_, i) => <Sk key={i} h={30} style={{ marginBottom: 8 }} />)}</div>
          : !q.data.runs.length ? <Empty icon="time" title="No runs yet">Validation and compilation runs started here are listed with who ran them and how they ended.</Empty>
            : (
              <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Validation runs">
                <table className="t">
                  <thead><tr><th>Run</th><th>Type</th><th>Mode</th><th>Duration</th><th>Triggered by</th><th>Result</th></tr></thead>
                  <tbody>
                    {q.data.runs.map((r) => {
                      const [cls, label] = RESULT[r.status] || ['warn', r.status];
                      return (
                        <tr key={r.id} style={{ cursor: 'default' }}>
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.started_at)}</td>
                          <td>{r.kind === 'compilation' ? 'Compilation' : 'Validation'}</td>
                          <td><span className="mono">{r.kind === 'compilation' ? '-' : modeLabel(r.mode)}</span></td>
                          <td className="num">{duration(r.seconds)}</td>
                          <td className="card-sub"><span className="trunc" style={{ maxWidth: 220 }} data-tip={r.started_by_email || r.started_by}>{r.started_by || r.started_by_email || '-'}</span></td>
                          <td><span className={`hb ${cls}`} data-tip={r.returncode != null ? `Exit code ${r.returncode}` : undefined} data-tip-always="">{label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
    </>
  );
}

function Superuser({ section, setSection, sections, editMode, setEditMode, onNewRule, onEditRule, onNewDate, onEditDate, onChanged }) {
  const counts = {
    'rule-input': useQuery(tableKey('rule-input', 1), (s) => api.dqTable('rule-input', 1, PAGE, s), { ttl: 60000 }).data?.total_count,
    'rule-registry': useQuery(section === 'rule-registry' ? tableKey('rule-registry', 1) : null, (s) => api.dqTable('rule-registry', 1, PAGE, s), { ttl: 60000 }).data?.total_count,
    'date-input': useQuery(tableKey('date-input', 1), (s) => api.dqTable('date-input', 1, PAGE, s), { ttl: 60000 }).data?.total_count,
  };
  return (
    <div className="su" data-tour="bdc-admin-section">
      <section className="card su-nav" aria-label="Superuser sections">
        {sections.map((x) => (
          <button type="button" key={x.id} className={section === x.id ? 'on' : ''} aria-current={section === x.id ? 'page' : undefined} onClick={() => setSection(x.id)}>
            <I n={x.icon} />{x.label}{counts[x.id] != null && <span className="c">{fmt(counts[x.id])}</span>}
          </button>
        ))}
        <div style={{ margin: '10px 8px 4px', padding: 12, borderRadius: 12, background: 'rgba(235,23,0,.05)', fontSize: 12, color: 'var(--g7)', lineHeight: 1.45 }}>
          <b style={{ color: 'var(--red-t)' }}>Superuser area.</b> Changes here write straight to the DQ control tables.
        </div>
      </section>
      <section className="card" style={{ overflow: 'hidden', minWidth: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          {section === 'run-log' ? <RunLog /> : (
            <DqTable type={section} sections={sections} editMode={editMode} setEditMode={setEditMode}
              onNew={section === 'date-input' ? onNewDate : onNewRule} onEdit={section === 'date-input' ? onEditDate : onEditRule} onChanged={onChanged} />
          )}
        </div>
      </section>
    </div>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────

const CREATE_AUTO = new Set(['CREATED_TS', 'CREATED_AT', 'UPDATED_TS', 'UPDATED_AT', 'IS_ACTIVE', 'RULE_TYPE']);
const TS_COLS = new Set(['CREATED_TS', 'UPDATED_TS', 'CREATED_AT', 'UPDATED_AT']);
const LONG = ['DESCRIPTION', 'SQL', 'PREDICATE', 'NOTES'];
const DROPDOWNS = {
  CONNECTION_TYPE: ['Snowflake', 'Denodo - Coming Soon', 'PostgreSQL'],
  SEVERITY: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'],
};
const slug = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const label = (c) => c.replace(/_/g, ' ');

function TableBrowser({ value, onChange, connection, id }) {
  const conn = connection || 'Snowflake';
  const [open, setOpen] = useState(false);
  const [db, setDb] = useState(null);
  const [schema, setSchema] = useState(null);
  const [q, setQ] = useState('');
  const wrap = useRef(null);
  useEffect(() => { setDb(null); setSchema(null); }, [conn]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', close);
    wrap.current?.addEventListener('keydown', esc);
    const node = wrap.current;
    return () => { document.removeEventListener('pointerdown', close); node?.removeEventListener('keydown', esc); };
  }, [open]);
  const dbs = useQuery(open ? `tb:db:${conn}` : null, (s) => api.databases(conn, s), { ttl: 300000 });
  const schemas = useQuery(open && db ? `tb:sc:${conn}:${db}` : null, (s) => api.schemas(conn, db, s), { ttl: 300000 });
  const tables = useQuery(open && db && schema ? `tb:tb:${conn}:${db}:${schema}` : null, (s) => api.tableNames(conn, db, schema, s), { ttl: 300000 });
  const list = (tables.data?.tables || []).filter((t) => !q || `${t.table_name} ${t.full_name}`.toLowerCase().includes(q.toLowerCase()));

  const col = (title, query, items, render) => (
    <div className="tb-col">
      <span className="lbl">{title}</span>
      {query === null ? <div className="none">Pick one on the left</div>
        : query.loading ? <Sk h={24} style={{ margin: 6 }} />
          : query.error ? <div className="none" style={{ color: 'var(--maroon)' }}>{query.error.message}</div>
            : !items.length ? <div className="none">None found</div> : items.map(render)}
    </div>
  );
  return (
    <div className="tb" ref={wrap}>
      <button type="button" id={id} className="tb-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {value ? <span className="trunc" data-tip={value} data-tip-mono="">{value}</span> : <span className="ph">Select a table…</span>}
        <I n="chevD" />
      </button>
      {open && (
        <div className="tb-pop">
          <label className="field"><I n="search" /><input value={q} onChange={(e) => setQ(e.target.value)} disabled={!schema} placeholder={schema ? `Search ${tables.data?.tables?.length ?? ''} tables` : 'Pick a database and schema first'} aria-label="Search tables" /></label>
          <div className="tb-cols">
            {col('Database', dbs, dbs.data?.databases || [], (d) => (
              <button type="button" key={d} className={db === d ? 'on' : ''} onClick={() => { setDb(d); setSchema(null); }}><span className="trunc" data-tip={d}>{d}</span></button>
            ))}
            {col('Schema', db ? schemas : null, schemas.data?.schemas || [], (sc) => (
              <button type="button" key={sc} className={schema === sc ? 'on' : ''} onClick={() => setSchema(sc)}><span className="trunc" data-tip={sc}>{sc}</span></button>
            ))}
            {col('Table', schema ? tables : null, list, (t) => (
              <button type="button" key={t.full_name} className={value === t.full_name ? 'on' : ''} onClick={() => { onChange(t.full_name); setOpen(false); setQ(''); }}>
                <span className="trunc" data-tip={t.full_name}>{t.table_name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ColorColumns({ value, onChange, connection, table }) {
  const conn = connection || 'Snowflake';
  const parts = String(table || '').split('.').filter(Boolean);
  const [db, schema, name] = parts.length >= 3 ? parts.slice(-3) : [null, null, null];
  const q = useQuery(name ? `tb:cols:${conn}:${db}.${schema}.${name}` : null, (s) => api.columns(conn, db, schema, name, s), { ttl: 300000 });
  const prevTable = useRef(table);
  useEffect(() => {
    if (prevTable.current !== table) { prevTable.current = table; onChange(''); }
  }, [table, onChange]);
  if (!name) return <span className="hint">Select a target table first to choose colour columns.</span>;
  if (q.error) return <span className="field-err">{q.error.message}</span>;
  const cols = [...(q.data?.columns || [])].sort((a, b) => {
    const da = /DATE|TIME/i.test(a.type || '');
    const dbb = /DATE|TIME/i.test(b.type || '');
    return da === dbb ? a.name.localeCompare(b.name) : da ? -1 : 1;
  });
  const picked = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const resolve = (raw) => cols.find((c) => c.name.toUpperCase() === String(raw || '').toUpperCase());
  const set = (i, v) => {
    const next = [picked[0] || '', picked[1] || ''];
    next[i] = v;
    onChange(next.filter(Boolean).join(', '));
  };
  return (
    <div className="cc-grid">
      {[0, 1].map((i) => {
        const cur = resolve(picked[i]);
        return (
          <label key={i}>Column {i + 1}
            <select value={cur?.name || picked[i] || ''} onChange={(e) => set(i, e.target.value)} disabled={q.loading}>
              <option value="">{q.loading ? 'Loading…' : 'None'}</option>
              {cols.map((c) => <option key={c.name} value={c.name} disabled={c.name === picked[1 - i]}>{c.name}{c.type ? ` (${c.type})` : ''}</option>)}
            </select>
            {cur?.type && !/DATE|TIME/i.test(cur.type) && <span className="cc-warn">Not a date column, so day-difference colouring may not work.</span>}
          </label>
        );
      })}
    </div>
  );
}

// Datasets in use, cut to the ones this person may save under. A fixed list
// here offered titles a dataset-limited superuser was then refused on save.
function DatasetField({ fid, col, value, onChange }) {
  const q = useQuery('dq:rule-input:datasets', (s) => api.ruleDatasets(s), { ttl: 300000 });
  const opts = q.data?.datasets || [];
  if (q.data && !q.data.any_allowed) {
    return (
      <label htmlFor={fid}>{label(col)}
        <select id={fid} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {value && !opts.includes(value) && <option value={value}>{value}</option>}
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label htmlFor={fid}>{label(col)}
      <input id={fid} list={`${fid}-list`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Pick or type a dataset" autoComplete="off" />
      <datalist id={`${fid}-list`}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
      {q.error && <span className="hint">Could not load the dataset list; type the title.</span>}
    </label>
  );
}

function Field({ col, value, onChange, draft, locked }) {
  const up = col.toUpperCase();
  const fid = `bdx-f-${up}`;
  if (locked) return <label className="full" htmlFor={fid}>{label(col)}<input id={fid} value={value ?? ''} readOnly /></label>;
  if (up === 'DATASET_TITLE') return <DatasetField fid={fid} col={col} value={value} onChange={onChange} />;
  if (up === 'TARGET_TABLE' || up === 'DELTA_TABLE') {
    return <div className="full" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="lbl" style={{ fontWeight: 700 }}>{label(col)}{up === 'TARGET_TABLE' && <span className="req">*</span>}</span><TableBrowser id={fid} value={value} connection={draft.CONNECTION_TYPE} onChange={onChange} /></div>;
  }
  if (up === 'COLOR_COLUMNS') {
    return <div className="full" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="lbl" style={{ fontWeight: 700 }}>{label(col)}</span><ColorColumns value={value} onChange={onChange} connection={draft.CONNECTION_TYPE} table={draft.TARGET_TABLE} /></div>;
  }
  if (up === 'IS_ACTIVE') {
    const on = isTrue(value);
    return <label>{label(col)}<span style={{ display: 'flex', alignItems: 'center', gap: 10, height: 40 }}><Toggle on={on} onClick={() => onChange(!on)} label="Active" /><span className="hint">{on ? 'Active' : 'Inactive'}</span></span></label>;
  }
  if (DROPDOWNS[up]) {
    const opts = DROPDOWNS[up];
    const v = opts.find((o) => o.toUpperCase() === String(value ?? '').toUpperCase()) || value || '';
    return (
      <label htmlFor={fid}>{label(col)}
        <select id={fid} value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {!opts.includes(v) && v && <option value={v}>{v}</option>}
          {opts.map((o) => <option key={o} value={o} disabled={o.includes('Coming Soon')}>{o}</option>)}
        </select>
      </label>
    );
  }
  const long = LONG.some((k) => up.includes(k)) || String(value ?? '').length > 60;
  return (
    <label className={long ? 'full' : ''} htmlFor={fid}><span>{label(col)}{up === 'RULE_TITLE' && <span className="req">*</span>}</span>
      {long ? <textarea id={fid} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input id={fid} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

function FormFoot({ confirming, saving, onCancel, onSubmit, onBack, message, action }) {
  return (
    <div className={`m-f ${confirming ? 'confirming' : ''}`}>
      {confirming ? <span className="confirm-msg">{message}</span> : <span className="spacer" />}
      <button type="button" className="btn ghost" onClick={confirming ? onBack : onCancel} disabled={saving}>{confirming ? 'Back' : 'Cancel'}</button>
      <button type="button" className="btn primary" onClick={onSubmit} disabled={saving}><I n="save" />{saving ? 'Saving…' : confirming ? 'Yes, save' : action}</button>
    </div>
  );
}

function RuleForm({ mode, ruleKey, onDone, onCancel }) {
  const toast = useToast();
  const isNew = mode === 'new';
  const schema = useQuery(isNew ? 'dq:rule-input:schema' : null, (s) => api.dqTableSchema(s), { ttl: 300000 });
  const row = useQuery(!isNew && ruleKey ? `dq:rule-input:row:${ruleKey}` : null, (s) => api.dqRow('rule-input', ruleKey, s), { ttl: 0 });
  const version = useQuery(!isNew && ruleKey ? `dq:next:${ruleKey}` : null, (s) => api.nextVersion(ruleKey, s), { ttl: 0 });
  const columns = isNew ? schema.data?.columns : row.data?.columns;
  const original = useMemo(() => (row.data ? Object.fromEntries(row.data.columns.map((c, i) => [c, row.data.row[i] ?? ''])) : null), [row.data]);
  const [draft, setDraft] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (draft || !columns) return;
    setDraft(isNew ? Object.fromEntries(columns.filter((c) => !CREATE_AUTO.has(c.toUpperCase())).map((c) => [c, ''])) : { ...original });
  }, [columns, original, draft, isNew]);
  const logged = useRef(false);
  useEffect(() => {
    if (isNew || !row.data || logged.current) return;
    logged.current = true;
    audit('bdc_rule_edit_attempted', ruleKey, `Opened edit modal for rule "${ruleKey}" in rule-input`);
  }, [isNew, row.data, ruleKey]);

  const loadErr = isNew ? schema.error : row.error;
  if (loadErr) return <div className="m-b"><ErrorState error={loadErr} onRetry={isNew ? schema.reload : row.reload} title={row.error?.status === 404 ? 'That rule no longer exists' : 'Could not open the form'} /></div>;
  if (!draft || !columns) return <div className="m-b"><div className="form">{Array.from({ length: 6 }, (_, i) => <Sk key={i} h={40} />)}</div></div>;

  const pkCol = columns.find((c) => c.toUpperCase() === 'RULE_ID') || columns[0];
  const set = (c) => (v) => { setDraft((d) => ({ ...d, [c]: v })); setConfirming(false); setError(null); };
  const visible = isNew
    ? columns.filter((c) => !CREATE_AUTO.has(c.toUpperCase()))
    // IS_ACTIVE is left out: a saved edit is always the new active version
    // (the server sets it), so a switch here would do nothing.
    : columns.filter((c) => !TS_COLS.has(c.toUpperCase()) && !['RULE_TYPE', 'IS_ACTIVE'].includes(c.toUpperCase()));
  const derivedId = slug(draft.RULE_TITLE);
  const hasTable = columns.some((c) => c.toUpperCase() === 'TARGET_TABLE');

  const submit = async () => {
    if (isNew && !derivedId) { setError('Give the rule a title; its RULE_ID is made from it.'); return; }
    if (isNew && `${derivedId}_v1`.length > 190) { setError('The title is too long to make a RULE_ID from (190 characters at most). Shorten it.'); return; }
    if (isNew && derivedId.startsWith('DELTA_')) { setError('The RULE_ID can’t start with DELTA_ (that prefix marks Semi-Monthly reviews). Reword the start of the title.'); return; }
    if (hasTable && !String(draft.TARGET_TABLE || '').trim()) { setError('Choose the target table the rule checks.'); return; }
    if (!confirming) { setConfirming(true); return; }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const id = `${derivedId}_v1`;
        await api.createRule({ ...draft, RULE_ID: id, RULE_TYPE: 'CUSTOM' });
        audit('bdc_rule_created', id, `Created DQ rule "${id}"${draft.RULE_DESCRIPTION ? `: ${draft.RULE_DESCRIPTION}` : ''}`);
        toast(`${id} created · run compilation to activate it`, 'ok');
      } else {
        const updates = {};
        columns.forEach((c) => {
          if (c === pkCol || !(c in draft)) return;
          if (String(draft[c] ?? '') !== String(original[c] ?? '')) updates[c] = draft[c];
        });
        if (!Object.keys(updates).length) { onCancel(); return; }
        await api.updateRule(pkCol, original[pkCol], updates);
        audit('bdc_rule_row_updated', String(original[pkCol]), `Updated rule row "${original[pkCol]}" in rule-input: changed fields [${Object.keys(updates).join(', ')}]`);
        toast(version.data ? `Saved as ${version.data.next_version_id}` : `Saved ${original[pkCol]}`, 'ok');
      }
      onDone();
    } catch (e) {
      setError(e.message);
      setConfirming(false);
      setSaving(false);
    }
  };

  return (
    <>
      <div className="m-b">
        {!isNew && (
          <div className="note-box">
            <I n="info" />
            <span>{version.loading ? 'Working out the next version…'
              : version.data ? <>Saving deactivates <code>{version.data.original_rule_id}</code> and inserts a new active row <code>{version.data.next_version_id}</code>.</>
                : 'Saving creates a new version of this rule.'}</span>
          </div>
        )}
        {error && <div style={{ marginBottom: 14 }}><InlineError error={error} /></div>}
        <div className="form">
          {isNew && (
            <label>RULE ID
              <input value={derivedId} readOnly placeholder="Made from the rule title" aria-describedby="bdx-rid-hint" />
              <span className="hint" id="bdx-rid-hint">{derivedId ? <>Saved as <b>{derivedId}_v1</b></> : 'Type a title to generate it'}</span>
            </label>
          )}
          {visible.filter((c) => !(isNew && c.toUpperCase() === 'RULE_ID')).map((c) => (
            <Field key={c} col={c} value={draft[c]} onChange={set(c)} draft={draft} locked={!isNew && c === pkCol} />
          ))}
        </div>
      </div>
      <FormFoot confirming={confirming} saving={saving} onCancel={onCancel} onBack={() => setConfirming(false)} onSubmit={submit}
        action={isNew ? 'Create rule' : version.data ? `Save as ${version.data.next_version_id}` : 'Save new version'}
        message={isNew ? <>Insert <b>{derivedId}_v1</b> into Snowflake with IS_ACTIVE set to TRUE?</> : <>Write these changes to Snowflake as a new version?</>} />
    </>
  );
}

const REPORT_SETS = ['RTE_REPORT_BASELINE', 'RTE_REPORT_BIWEEKLY', 'RTE_REPORT_QUARTERLY'];
const DATE_LOCKED = new Set(['ID', 'CREATED_DATE', 'UPDATED_DATE', 'CREATED_TS', 'UPDATED_TS', 'CREATED_AT', 'UPDATED_AT']);

function DateForm({ mode, rowKey, onDone, onCancel }) {
  const toast = useToast();
  const isNew = mode === 'new';
  const row = useQuery(!isNew && rowKey ? `dq:date-input:row:${rowKey}` : null, (s) => api.dqRow('date-input', rowKey, s), { ttl: 0 });
  const original = useMemo(() => (row.data ? Object.fromEntries(row.data.columns.map((c, i) => [c, row.data.row[i] ?? ''])) : null), [row.data]);
  const [draft, setDraft] = useState(isNew ? { REPORT_SET: '', FROM_DATE: '', TO_DATE: '', IS_ACTIVE: true, NOTES: '' } : null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (!isNew && original && !draft) setDraft({ ...original }); }, [isNew, original, draft]);

  if (row.error) return <div className="m-b"><ErrorState error={row.error} onRetry={row.reload} title={row.error.status === 404 ? 'That range no longer exists' : 'Could not open the form'} /></div>;
  if (!draft) return <div className="m-b"><div className="form">{Array.from({ length: 4 }, (_, i) => <Sk key={i} h={40} />)}</div></div>;
  const cols = isNew ? Object.keys(draft) : row.data.columns;
  const set = (c) => (v) => { setDraft((d) => ({ ...d, [c]: v })); setConfirming(false); setError(null); };
  const day = (v) => String(v || '').slice(0, 10);

  const submit = async () => {
    const f = day(draft.FROM_DATE);
    const t = day(draft.TO_DATE);
    if (!String(draft.REPORT_SET || '').trim()) { setError('Choose a report set.'); return; }
    if (!f || !t) { setError('Both dates are required.'); return; }
    if (f > t) { setError('The range has to start on or before its end date.'); return; }
    if (!confirming) { setConfirming(true); return; }
    setSaving(true);
    try {
      if (isNew) {
        await api.createDateRow({ ...draft, FROM_DATE: f, TO_DATE: t });
        audit('bdc_date_row_created', draft.REPORT_SET, `Created date-input row: ${draft.REPORT_SET} ${f}→${t}`);
        toast(`${draft.REPORT_SET} range created`, 'ok');
      } else {
        const updates = {};
        cols.forEach((c) => {
          if (DATE_LOCKED.has(c.toUpperCase())) return;
          const now = c.toUpperCase().endsWith('_DATE') ? day(draft[c]) : draft[c];
          const was = c.toUpperCase().endsWith('_DATE') ? day(original[c]) : original[c];
          if (String(now ?? '') !== String(was ?? '')) updates[c] = now;
        });
        if (!Object.keys(updates).length) { onCancel(); return; }
        const idCol = cols.find((c) => c.toUpperCase() === 'ID');
        await api.updateDateRow(original[idCol], updates);
        audit('bdc_date_row_updated', String(original[idCol]), `Updated date-input row ${draft.REPORT_SET}: changed fields [${Object.keys(updates).join(', ')}]`);
        toast('Date range saved', 'ok');
      }
      onDone();
    } catch (e) {
      setError(e.message);
      setConfirming(false);
      setSaving(false);
    }
  };

  return (
    <>
      <div className="m-b">
        {error && <div style={{ marginBottom: 14 }}><InlineError error={error} /></div>}
        <div className="form">
          {cols.map((c) => {
            const up = c.toUpperCase();
            const fid = `bdx-d-${up}`;
            if (DATE_LOCKED.has(up)) return <label key={c} htmlFor={fid}>{label(c)}<input id={fid} value={draft[c] || 'Set by the server'} readOnly /></label>;
            if (up === 'REPORT_SET') {
              return (
                <label key={c} className="full" htmlFor={fid}><span>Report set<span className="req">*</span></span>
                  <select id={fid} value={draft[c]} onChange={(e) => set(c)(e.target.value)} data-autofocus="">
                    <option value="">Select…</option>
                    {[...new Set([...REPORT_SETS, draft[c]].filter(Boolean))].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              );
            }
            if (up === 'FROM_DATE' || up === 'TO_DATE') return <label key={c} htmlFor={fid}><span>{label(c)}<span className="req">*</span></span><input id={fid} type="date" value={day(draft[c])} onChange={(e) => set(c)(e.target.value)} /></label>;
            if (up === 'IS_ACTIVE') {
              const on = isTrue(draft[c]);
              return <label key={c}>Active<span style={{ display: 'flex', alignItems: 'center', gap: 10, height: 40 }}><Toggle on={on} onClick={() => set(c)(!on)} label="Active" /><span className="hint">{on ? 'Active: other ranges in this set are switched off' : 'Inactive'}</span></span></label>;
            }
            return <label key={c} className="full" htmlFor={fid}>{label(c)}<textarea id={fid} value={draft[c] ?? ''} onChange={(e) => set(c)(e.target.value)} placeholder="Optional" style={{ fontFamily: 'var(--text)' }} /></label>;
          })}
        </div>
      </div>
      <FormFoot confirming={confirming} saving={saving} onCancel={onCancel} onBack={() => setConfirming(false)} onSubmit={submit}
        action={isNew ? 'Create range' : 'Save changes'}
        message={<>{isNew ? 'Insert' : 'Save'} <b>{draft.REPORT_SET}</b> {day(draft.FROM_DATE)} → {day(draft.TO_DATE)}?</>} />
    </>
  );
}

const useIndicator = (wrapRef, pillRef, selector, key, inset = 0) => {
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const pill = pillRef.current;
    if (!wrap || !pill) return undefined;
    const place = () => {
      const on = wrap.querySelector(selector);
      if (!on) { pill.style.width = '0px'; return; }
      pill.style.width = `${on.offsetWidth}px`;
      pill.style.transform = `translateX(${on.offsetLeft - inset}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    document.fonts?.ready.then(place);
    return () => ro.disconnect();
  }, [wrapRef, pillRef, selector, key, inset]);
};

function TopBar({
  delta, onCadence, showBack, onBack, onPalette, canRun, canExec, valMode, onValidate, onValPick, onCompile,
  onExec, onRefresh, refreshing, onTour, run, onShowRun, limited,
}) {
  const cad = useRef(null);
  const pill = useRef(null);
  const [menu, setMenu] = useState(false);
  const [spin, setSpin] = useState(false);
  const split = useRef(null);
  useIndicator(cad, pill, 'button.on', String(delta), 3);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!split.current?.contains(e.target)) setMenu(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc, true); };
  }, [menu]);
  // Dataset-limited people can only validate single rules from their datasets
  const modes = limited ? VAL_MODES.filter((m) => m.mode === 'EXECUTE_RULE') : VAL_MODES;
  const current = modes.find((m) => m.mode === valMode) || modes[0];
  const busy = run?.status === 'running';

  return (
    <header className="top">
      <div className="top-l" data-tour="bdc-env">
        {showBack && <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to the Data Quality Engine" data-tip="Back" data-tip-always=""><I n="chevL" /></button>}
        <div className="mark"><I n="analysis" /></div>
        <div className="ttl"><div className="crumb">Data Quality Engine</div><h1 data-tip="Business Defined Checks">Business Defined Checks</h1></div>
      </div>
      <div className="cad" ref={cad} data-tour="bdc-cadence" role="radiogroup" aria-label="Cadence">
        <span className="cad-pill" ref={pill} />
        <button type="button" role="radio" aria-checked={!delta} className={!delta ? 'on' : ''} onClick={() => onCadence(false)}><I n="calendar" style={{ width: 13, height: 13 }} />Quarterly</button>
        <button type="button" role="radio" aria-checked={delta} className={delta ? 'on' : ''} onClick={() => onCadence(true)}><I n="time" style={{ width: 13, height: 13 }} />Semi-Monthly<span className="live" /></button>
      </div>
      <div className="top-r" data-tour="bdc-actions">
        {run && (
          <button type="button" className="runpill" onClick={onShowRun} aria-label={`${run.label}: ${busy ? `${run.pct}%` : run.status}. Show progress`}>
            {busy ? <span className="spinner" /> : <I n={run.status === 'ok' ? 'check' : 'alert'} style={{ width: 12, height: 12 }} />}
            <span className="rp-t">{busy ? `${run.kind === 'compile' ? 'Compiling' : 'Validating'} · ` : run.status === 'ok' ? 'Run finished' : run.status === 'partial' ? 'Some rules failed' : 'Run failed'}</span>{busy && `${run.pct}%`}
          </button>
        )}
        <button type="button" className="search-btn" onClick={onPalette} aria-label={`Search rules and actions (${MOD_KEY} K)`}><I n="search" /><span>Search rules and actions</span><kbd>{MOD_KEY} K</kbd></button>
        {canRun && !limited && <button type="button" className="btn ghost blue" onClick={onCompile} disabled={busy} aria-label="Compile" data-tip="Compile rules" data-tip-always=""><I n="network" /><span className="bt">Compile</span></button>}
        {canRun && (
          <div className="split" ref={split}>
            <button type="button" className="btn primary" onClick={onValidate} disabled={busy} aria-label={current.button}><I n="play" /><span>{current.button}</span></button>
            <button type="button" className="btn primary caret" onClick={() => setMenu((m) => !m)} aria-label="Validation options" aria-expanded={menu} aria-haspopup="menu" disabled={busy}><I n="chevD" /></button>
            <div className={`menu ${menu ? 'open' : ''}`} role="menu" aria-hidden={!menu}>
              {modes.map((m) => (
                <button type="button" role="menuitem" key={m.mode} tabIndex={menu ? 0 : -1} onClick={() => { setMenu(false); onValPick(m.mode); }}>
                  <span className="mi"><I n={m.icon} /></span><span><b>{m.label}</b><small>{m.desc}</small></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {canExec && <button type="button" className="btn ghost violet" onClick={onExec} aria-label="Executive View" data-tip="Executive View" data-tip-always=""><I n="dashboard" /><span className="bt">Executive View</span></button>}
        <button type="button" className={`icon-btn ${spin || refreshing ? 'spin' : ''}`} onClick={() => { setSpin(true); onRefresh(); }}
          onAnimationEnd={() => setSpin(false)} aria-label="Refresh data" data-tip="Refresh data" data-tip-always=""><I n="refresh" /></button>
        <button type="button" className="icon-btn" onClick={onTour} aria-label="Take a tour" data-tip="Take a tour" data-tip-always=""><I n="help" /></button>
      </div>
    </header>
  );
}

function TabBar({ tabs, active, onTab, badge, synced }) {
  const nav = useRef(null);
  const ind = useRef(null);
  useIndicator(nav, ind, '.tab.on', `${active}:${tabs.length}:${badge > 0}`);
  // scroll the tab strip sideways only, scrollIntoView was dragging the whole page down on load
  useEffect(() => {
    const n = nav.current;
    const t = n?.querySelector('.tab.on');
    if (!t) return;
    const nb = n.getBoundingClientRect();
    const tb = t.getBoundingClientRect();
    if (tb.left < nb.left) n.scrollLeft += tb.left - nb.left;
    else if (tb.right > nb.right) n.scrollLeft += tb.right - nb.right;
  }, [active]);
  const onKey = (e) => {
    const i = tabs.findIndex((t) => t.id === active);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onTab(next.id);
    requestAnimationFrame(() => nav.current?.querySelector('.tab.on')?.focus({ preventScroll: true }));
  };
  return (
    <div className="tabs-bar">
      <div className="tabs-row">
        <nav className="tabs" ref={nav} role="tablist" aria-label="Business Defined Checks views" data-tour="bdc-tabs" onKeyDown={onKey}>
          <span className="tab-ind" ref={ind} />
          {tabs.map((t, i) => (
            <button type="button" key={t.id} role="tab" id={`bdx-tab-${t.id}`} aria-selected={active === t.id} aria-controls="bdx-panel"
              tabIndex={active === t.id ? 0 : -1} className={`tab ${active === t.id ? 'on' : ''}`} onClick={() => onTab(t.id)}
              data-tip={`${t.name} (${i + 1})`} data-tip-always="">
              <I n={t.icon} />{t.name}
              {t.id === 'review' && badge > 0 ? <span className="badge" aria-label={`${badge} awaiting review`}>{badge > 99 ? '99+' : badge}</span> : t.admin ? <span className="adm" aria-hidden="true" /> : null}
            </button>
          ))}
        </nav>
        <div className="tabs-meta">
          <span className="dot" style={{ background: 'var(--green)', boxShadow: '0 0 8px rgba(50,135,20,.6)' }} />
          Synced {synced ? <Ago v={synced} /> : '…'} · press <kbd>1</kbd>-<kbd>{tabs.length}</kbd> to switch tabs
        </div>
      </div>
    </div>
  );
}

function Palette({ open, onClose, groups }) {
  const ref = useRef(null);
  const input = useRef(null);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  useFocusTrap(ref, open);
  useEffect(() => {
    if (open) { setQ(''); setHl(0); requestAnimationFrame(() => input.current?.focus()); }
  }, [open]);
  const shown = useMemo(() => (open ? groups(q.trim().toLowerCase()) : []), [open, groups, q]);
  const flat = shown.flatMap((g) => g.items);
  const idx = clamp(hl, 0, Math.max(0, flat.length - 1));
  useEffect(() => {
    ref.current?.querySelector('.pal-i.hl')?.scrollIntoView({ block: 'nearest' });
  }, [idx, q]);
  const run = (item) => { if (!item) return; onClose(); setTimeout(item.run, 120); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setHl(clamp(idx + (e.key === 'ArrowDown' ? 1 : -1), 0, flat.length - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); run(flat[idx]); }
  };
  let k = 0;
  return (
    <div ref={ref} className={`pal ${open ? 'on' : ''}`} role="dialog" aria-modal="true" aria-label="Command palette" aria-hidden={!open} inert={!open}>
      <div className="pal-in">
        <I n="search" />
        <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setHl(0); }} onKeyDown={onKey} role="combobox" aria-expanded="true"
          aria-controls="bdx-pal-list" aria-activedescendant={flat.length ? `bdx-pal-${idx}` : undefined}
          placeholder="Jump to a rule, dataset, tab or action" autoComplete="off" aria-label="Search commands" />
        <kbd>Esc</kbd>
      </div>
      <div className="pal-r" id="bdx-pal-list" role="listbox">
        {shown.length ? shown.map((g) => (
          <div key={g.name} role="group" aria-label={g.name}>
            <div className="pal-g">{g.name}</div>
            {g.items.map((it) => {
              const i = k++;
              return (
                <button type="button" key={`${g.name}-${it.title}-${i}`} id={`bdx-pal-${i}`} role="option" aria-selected={i === idx}
                  className={`pal-i ${i === idx ? 'hl' : ''}`} onMouseMove={() => { if (i !== idx) setHl(i); }} onClick={() => run(it)} tabIndex={-1}>
                  <span className="pi"><I n={it.icon} /></span><span className="t" data-tip={it.title}>{it.title}</span>{it.sub && <small>{it.sub}</small>}
                </button>
              );
            })}
          </div>
        )) : <div className="empty" style={{ padding: 30 }}><h4>No matches</h4><p>Try a rule ID or a dataset name.</p></div>}
      </div>
      <div className="pal-f"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>{MOD_KEY} K</kbd> toggle</span></div>
    </div>
  );
}

const TOUR = [
  ['bdc-cadence', 'Pick your cadence', 'Flip between the quarterly cycle and the semi-monthly delta. Everything on the page follows this switch.'],
  ['bdc-range', 'Know what you are looking at', 'The active dataset range, when validation last ran, and when it runs next.'],
  ['bdc-dial', 'The health dial', 'One bar per rule, grouped by dataset. Longer bars fail more, colour is health. Hover to inspect, click a bar or dataset to open it.'],
  ['bdc-kpi-cards', 'Headline numbers', 'Tables, rules, pass rate, failing rows and the sign-off queue at a glance.'],
  ['bdc-tabs', 'Go deeper', 'Datasets, trends, failing rows and, for superusers, the review queue. Number keys jump between tabs.'],
  ['bdc-actions', 'Run and search', `Kick off compilation or validation, or press ${MOD_KEY} K to jump to anything.`],
];

function Tour({ open, onClose }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const card = useRef(null);
  const steps = useMemo(() => (open ? TOUR.filter(([sel]) => {
    const el = document.querySelector(`[data-tour="${sel}"]`);
    return el && el.getClientRects().length;
  }) : []), [open]);
  useFocusTrap(card, open && !!box);
  useEffect(() => { if (open) setI(0); }, [open]);
  useEffect(() => {
    if (!open || !steps[i]) { setBox(null); return undefined; }
    const el = document.querySelector(`[data-tour="${steps[i][0]}"]`);
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    let raf = 0;
    const measure = () => {
      const b = el.getBoundingClientRect();
      setBox({ left: b.left, top: b.top, width: b.width, height: b.height, bottom: b.bottom });
    };
    const t = setTimeout(measure, 380);
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    window.addEventListener('resize', onMove);
    document.addEventListener('scroll', onMove, { passive: true, capture: true });
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('scroll', onMove, { capture: true });
    };
  }, [open, i, steps]);
  if (!open || !box || !steps[i]) return null;
  const [, title, text] = steps[i];
  const pad = 8;
  let top = box.bottom + 16;
  if (top + 190 > window.innerHeight) top = Math.max(16, box.top - 206);
  const left = clamp(box.left, 16, window.innerWidth - 336);
  const last = i === steps.length - 1;
  return createPortal(
    <div className="bdx bdx-layer">
      <div className="tour-hole" style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} />
      <div className="tour-card" ref={card} style={{ top, left }} role="dialog" aria-modal="true" aria-labelledby="bdx-tour-t">
        <span className="lbl">Step {i + 1} of {steps.length}</span>
        <h4 id="bdx-tour-t">{title}</h4>
        <p>{text}</p>
        <div className="tf">
          <div className="tour-dots" aria-hidden="true">{steps.map((s, k) => <i key={s[0]} className={k === i ? 'on' : ''} />)}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {i > 0 && <button type="button" className="btn sm ghost" onClick={() => setI(i - 1)}>Back</button>}
            <button type="button" className="btn sm ghost" onClick={onClose}>Skip</button>
            <button type="button" className="btn sm primary" data-autofocus="" onClick={() => (last ? onClose() : setI(i + 1))}>{last ? 'Finish' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RunBody({ run }) {
  const log = useRef(null);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.count]);
  if (!run) return null;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="lbl">Progress</span><b className="num" aria-live="polite">{run.pct}%</b>
      </div>
      <div className="bigbar" role="progressbar" aria-valuenow={run.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Run progress"><span style={{ width: `${run.pct}%` }} /></div>
      <div className="steps" style={{ marginTop: 14 }}>
        {run.steps.map((s) => (
          <div key={s.label} className={`step ${s.state === 'run' ? 'run' : s.state === 'done' ? 'done' : ''}`} style={s.state === 'fail' ? { color: 'var(--maroon)', fontWeight: 700 } : undefined}>
            <span className="si" style={s.state === 'fail' ? { borderColor: 'var(--maroon)', background: '#fdf0ee' } : undefined}>
              {s.state === 'done' && <I n="check" />}{s.state === 'fail' && <I n="close" style={{ color: 'var(--maroon)' }} />}
            </span>
            {s.label}<small>{s.note || ''}</small>
          </div>
        ))}
      </div>
      <div className="log" ref={log} role="log" aria-label="Run output" tabIndex={0}>
        {run.lines.length > run.shown.length && <div className="wn">… {run.lines.length - run.shown.length} earlier lines hidden</div>}
        {run.shown.map((l) => (
          <div key={l.n} className={l.cls}>{l.type === 'separator' ? '────────' : `[${l.time}] ${l.text}`}</div>
        ))}
      </div>
      {run.status !== 'running' && (
        <p className="card-sub" style={{ marginTop: 12 }}>
          {run.status === 'ok' ? 'Finished. The page has the new results.'
            : run.status === 'partial' ? 'Finished, but some rules failed. Results from the rules that ran are on the page; the log above says which failed.'
              : 'The run did not finish cleanly; the log above has the details.'}
        </p>
      )}
    </>
  );
}

function AiAnalysis({ raw }) {
  const ai = useMemo(() => {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }, [raw]);
  if (!ai) return null;
  const conf = typeof ai.confidence === 'number' ? Math.round(ai.confidence * 100) : null;
  return (
    <div className="sec">
      <span className="lbl">AI analysis</span>
      <div className="ai-box">
        {ai.interpreted_rule && <div><span className="lbl">Interpreted rule</span><p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5 }}>{ai.interpreted_rule}</p></div>}
        {conf != null && (
          <div className="conf">
            <span className="lbl">Confidence</span>
            <span className="track"><span style={{ width: `${conf}%`, background: conf >= 90 ? 'var(--green)' : conf >= 70 ? '#d9b400' : 'var(--red)' }} /></span>
            <b className="num">{conf}%</b>
          </div>
        )}
        {ai.columns_used?.length > 0 && <div><span className="lbl">Columns used</span><div className="chips" style={{ marginTop: 6 }}>{ai.columns_used.map((c) => <span className="rid" key={c}>{c}</span>)}</div></div>}
        {ai.assumptions?.length > 0 && <div><span className="lbl">Assumptions</span><ul>{ai.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      </div>
    </div>
  );
}

function RuleDrawer({ rule, review, canRun, onClose, onPreview, onTrend, onValidate }) {
  const toast = useToast();
  const id = rule.rule_id;
  const reg = useQuery(`reg:${id}`, (s) => api.registry(id, s), { ttl: 120000 });
  const sql = reg.data?.sql_predicate || review?.sql_predicate;
  const values = rule.values || [];
  const first = rule.trend?.[0]?.date;
  const last = rule.trend?.[rule.trend.length - 1]?.date;
  const copy = () => copyText(sql || '', toast, 'Predicate');
  return (
    <>
      <div className="dr-h">
        <button type="button" className="icon-btn dr-x" onClick={onClose} aria-label="Close details"><I n="close" /></button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
          <span className="rid">{id}</span><SevBadge s={rule.severity} /><HealthBadge p={rule.pass_percentage} h={rule.h} />
          {review && review.status !== 'ACCEPTED' && <span className="hb new">{review.status === 'REJECTED' ? 'Rejected' : 'Awaiting review'}</span>}
        </div>
        <h2>{rule.rule_title}</h2>
        {rule.rule_description && <p>{rule.rule_description}</p>}
      </div>
      <div className="dr-b">
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', padding: 18, borderRadius: 16, background: '#fff', border: '1px solid var(--line)' }}>
          <Ring p={rule.pass_percentage} none={rule.no_result} size={104} stroke={9} fs={24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="lbl">Pass rate · {plural(values.length, 'run')}</span>
            <div style={{ marginTop: 8 }}><Spark values={values} w={300} h={54} color={healthColor(rule.pass_percentage)} fluid /></div>
            {first && <div className="card-sub" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><span>{fmtShortDay(first, true)}</span><span>{fmtShortDay(last, true)}</span></div>}
          </div>
        </div>
        <div className="kv sec">
          <div><span className="lbl">Failing rows</span><b style={{ color: 'var(--red-t)' }}>{fmt(rule.failed_rows)}</b></div>
          <div><span className="lbl">Rows evaluated</span><b>{rule.rows_evaluated == null ? 'Not recorded' : fmt(rule.rows_evaluated)}</b></div>
          <div><span className="lbl">Dataset</span><b>{rule.dataset_title || '-'}</b></div>
          <div><span className="lbl">Last executed</span><b>{rule.last_run ? fmtDateTime(rule.last_run) : 'Never'}</b></div>
        </div>
        <div className="sec">
          <span className="lbl">SQL predicate</span>
          {reg.loading && !sql ? <Sk h={80} r={12} />
            : sql ? <Code sql={sql} onCopy={copy} />
              : reg.error && reg.error.status !== 404 ? <InlineError error={reg.error} onRetry={reg.reload} />
                : <div className="note-box"><I n="info" /><span>No validated predicate in the registry yet.</span></div>}
        </div>
        {review?.ai_output && <AiAnalysis raw={review.ai_output} />}
      </div>
      <div className="dr-f">
        <button type="button" className="btn primary" onClick={onPreview} disabled={rule.failed_rows === 0}><I n="eye" />Preview failing rows</button>
        {onTrend && <button type="button" className="btn ghost" onClick={onTrend}><I n="chart" />Open in Trends</button>}
        {canRun && <button type="button" className="btn ghost" onClick={onValidate}><I n="play" />Validate this rule</button>}
      </div>
    </>
  );
}

function DatasetDrawer({ ds, onClose, onRule, onFilter }) {
  const rules = useMemo(() => [...ds.rules].sort((a, b) => a.pass_percentage - b.pass_percentage), [ds]);
  return (
    <>
      <div className="dr-h">
        <button type="button" className="icon-btn dr-x" onClick={onClose} aria-label="Close details"><I n="close" /></button>
        <span className="lbl" style={{ position: 'relative' }}>Dataset</span>
        <h2>{ds.name}</h2>
        <p>{plural(ds.rules.length, 'rule')} across {plural(ds.tables.size, 'table')} · average {ds.pass == null ? 'no result' : pct(ds.pass)}</p>
      </div>
      <div className="dr-b">
        <div className="att">
          {rules.map((r, i) => (
            <button type="button" className="att-row" key={r.rule_id} onClick={() => onRule(r.rule_id)} style={{ animationDelay: `${i * 60}ms`, textAlign: 'left' }}>
              <Ring p={r.pass_percentage} none={r.no_result} size={42} stroke={4.5} />
              <div className="meta"><div className="t" data-tip={r.rule_title}>{r.rule_title}</div><div className="s"><span className="rid">{r.rule_id}</span><SevBadge s={r.severity} /></div></div>
              <div className="fr"><b>{fmt(r.failed_rows)}</b><span>failing</span></div>
              <span className="go"><I n="chevR" /></span>
            </button>
          ))}
        </div>
      </div>
      <div className="dr-f"><button type="button" className="btn primary" onClick={onFilter}><I n="filter" />Show in rules table</button></div>
    </>
  );
}

const VALID_TABS = ['overview', 'dataset-health', 'trends', 'failed-rows', 'admin', 'review'];
const ADMIN_TABS = new Set(['admin', 'review']);

const DQ_TABLE_TABS = [
  { id: 'rule-input', label: 'DQ Rule Governance', icon: 'records' },
  { id: 'rule-registry', label: 'DQ Rules AI Registry', icon: 'ai' },
  { id: 'date-input', label: 'DQ Date Input', icon: 'calendar' },
];
const SU_SECTIONS = [...DQ_TABLE_TABS, { id: 'run-log', label: 'Validation log', icon: 'time' }];

const MODALS = new Set(['preview', 'delta', 'runs', 'consolidated', 'runpick', 'newrule', 'editrule', 'newdate', 'editdate', 'rvhistory']);
const COLOR_FILTERS = new Set(['green', 'yellow', 'red']);
const LAYER_KEYS = ['drawer', 'modal', 'mrule', 'mrow', 'cf', 'sheet', 'from', 'to', 'rep', 'org'];

const NO_DOMAIN = 'No domain';
// Rules grouped domain -> dataset for the dial. Every active domain from
// DQ_RULE_INPUT is listed, even with no rules, so gaps in coverage show.
// With no domain info at all (older backend) everything goes in one hidden
// group, so the dial still draws its datasets and rules, just no domain band.
const buildDomains = (rules, datasets, active) => {
  if (!Array.isArray(active) && !rules.some((r) => r.domain)) {
    return [{ name: '', hidden: true, rules, datasets, empty: !rules.length, pass: rules.length ? passMean(rules) : null, failed: 0 }];
  }
  const byName = new Map((active || []).map((n) => [n, []]));
  for (const r of rules) {
    const k = r.domain || NO_DOMAIN;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const dsByName = new Map(datasets.map((d) => [d.name, d]));
  return [...byName]
    .map(([name, list]) => {
      const groups = new Map();
      for (const r of list) {
        if (!groups.has(r.dataset_title)) groups.set(r.dataset_title, []);
        groups.get(r.dataset_title).push(r);
      }
      const dss = [...groups].map(([dn, rs]) => {
        const full = dsByName.get(dn);
        // a dataset split across domains gets its own slice per domain
        return rs.length === full?.rules.length ? full : { name: dn, rules: rs, pass: passMean(rs), failed: rs.reduce((n, r) => n + (r.failed_rows || 0), 0) };
      }).sort((x, y) => x.name.localeCompare(y.name));
      return {
        name,
        rules: list,
        datasets: dss,
        empty: !list.length,
        pass: list.length ? passMean(list) : null,
        failed: list.reduce((n, r) => n + (r.failed_rows || 0), 0),
      };
    })
    .sort((x, y) => (x.name === NO_DOMAIN) - (y.name === NO_DOMAIN) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
};

const buildModel = (data) => {
  if (!data) return null;
  const rules = data.rules.map((r) => ({
    ...r,
    dataset_title: r.dataset_title || 'No dataset',
    h: ruleHealth(r),
    values: (r.trend || []).map((p) => p.pass_percentage),
  }));
  const groups = new Map();
  for (const r of rules) {
    if (!groups.has(r.dataset_title)) groups.set(r.dataset_title, []);
    groups.get(r.dataset_title).push(r);
  }
  const datasets = [...groups].map(([name, list]) => ({
    name,
    rules: list,
    tables: new Set(list.map((r) => r.target_table).filter(Boolean)),
    pass: passMean(list),
    failed: list.reduce((n, r) => n + (r.failed_rows || 0), 0),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const avg = data.kpi.avg_pass;
  return {
    domains: buildDomains(rules, datasets, data.domains),
    domainList: Array.isArray(data.domains) ? data.domains : null,
    delta: data.delta_mode,
    rules,
    byId: new Map(rules.map((r) => [r.rule_id, r])),
    datasets,
    avg,
    trendDelta: data.kpi.prev_avg_pass == null ? null : avg - data.kpi.prev_avg_pass,
    kpi: data.kpi,
    series: data.series,
    range: data.range,
    nextRun: data.next_run,
    lastRun: data.last_run,
    failedByRule: data.failed_by_rule || {},
    generatedAt: data.generated_at,
    noDatasets: data.scope?.all === false && !data.scope.datasets?.length,
  };
};

const fromReview = (r, failedByRule) => ({
  rule_id: r.rule_id,
  rule_title: r.rule_title || r.rule_id,
  rule_description: r.rule_description || '',
  severity: (r.severity || '').toUpperCase(),
  target_table: r.target_table || '',
  dataset_title: r.dataset_title || 'No dataset',
  pass_percentage: r.pass_percentage ?? 0,
  no_result: !!r.no_result || r.pass_percentage == null,
  h: r.no_result || r.pass_percentage == null ? 'none' : health(r.pass_percentage ?? 0),
  status: r.exec_status,
  color_columns: r.color_columns || '',
  failed_rows: failedByRule?.[r.rule_id] ?? null,
  rows_evaluated: null,
  last_run: null,
  trend: [],
  values: [],
});

const parseSort = (raw) => {
  const [key, dir] = String(raw || '').split('.');
  return SORT_KEYS.includes(key) ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : { key: 'pass', dir: 'asc' };
};

const STEP_LABELS = {
  validate: (label) => ['Connect to the validation service', `Run ${label}`, 'Refresh results'],
  compile: () => ['Connect to the compilation service', 'Compile rule predicates', 'Refresh rule list'],
};
const timeOf = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function Page({ onBack }) {
  const { hasPermission } = useRBAC();
  const isAdmin = hasPermission('viewBDCSuperuser');
  const canRun = hasPermission('runBDCOperations');
  const canExec = hasPermission('viewBDCExecutive');
  // no standard permission means executive only, no way out
  const canStd = hasPermission('viewBDCStandard');
  const canDownload = hasPermission('downloadBDCData');
  const toast = useToast();
  const mounted = useMounted();
  const { params: searchParams, update, closeLayer } = useUrlState();
  // GPU-less cloud PCs (software compositing) get the light mode: the same
  // page and its one-off animations, without continuous motion or per-frame
  // repaint effects. Decided by the hardware (or measured slow frames), never
  // by the OS "reduce motion" setting, which this page doesn't follow.
  const [measuredSlow, setMeasuredSlow] = useState(false);
  useEffect(() => subscribeTier((t) => setMeasuredSlow(t !== 'full')), []);
  const lite = hardwareTier() !== 'full' || measuredSlow;
  useEffect(() => measureTier(5), []);
  useEffect(() => {
    const html = document.documentElement;
    if (lite) html.setAttribute('data-bdx-lite', ''); else html.removeAttribute('data-bdx-lite');
    return () => html.removeAttribute('data-bdx-lite');
  }, [lite]);

  // ── URL → state ────────────────────────────────────────────────────────────
  const delta = searchParams.get('mode') === 'delta';
  const isExec = !canStd || (canExec && searchParams.get('view') !== 'standard');
  const rawTab = searchParams.get('tab') ?? '';
  const tab = VALID_TABS.includes(rawTab) && (isAdmin || !ADMIN_TABS.has(rawTab)) ? rawTab : 'overview';
  const tabs = useMemo(() => TABS.filter((t) => isAdmin || !t.admin), [isAdmin]);
  const section = SU_SECTIONS.some((x) => x.id === searchParams.get('dqtab')) ? searchParams.get('dqtab') : 'rule-input';
  const rvFilter = REVIEW_FILTERS.some(([v]) => v === searchParams.get('rv')) ? searchParams.get('rv') : 'pending';
  const drawerParam = searchParams.get('drawer') || '';
  const modalParam = MODALS.has(searchParams.get('modal')) ? searchParams.get('modal') : null;
  const mrule = searchParams.get('mrule') || '';
  const mrow = searchParams.get('mrow') || '';

  // ── data ───────────────────────────────────────────────────────────────────
  const summaryKey = `summary:${delta}`;
  const summary = useQuery(isExec ? null : summaryKey, (s) => api.summary(delta, false, s), { ttl: 30000 });
  const badge = useQuery(isExec ? null : `badge:${delta}`, (s) => api.badge(delta, s), { ttl: 30000 });
  const model = useMemo(() => buildModel(summary.data), [summary.data]);
  const modelLoading = summary.loading && !model;
  // Only some datasets: anything spanning every dataset is hidden (the API refuses it too)
  const limited = summary.data?.scope ? !summary.data.scope.all : false;

  const layerRuleId = drawerParam.startsWith('rule:') ? drawerParam.slice(5) : mrule;
  const needsReview = isAdmin && !isExec && (tab === 'review' || (!!layerRuleId && !!model && !model.byId.has(layerRuleId)));
  const review = useQuery(needsReview ? `review:${delta}` : null, (s) => api.reviewRules(delta, s), { ttl: 20000 });
  const reviewById = useMemo(() => new Map((review.data?.rules || []).map((r) => [r.rule_id, { ...r, status: r.review_status || 'NOT_REVIEWED' }])), [review.data]);
  const resolveRule = useCallback((id) => {
    if (!id) return null;
    const known = model?.byId.get(id);
    if (known) return known;
    const r = reviewById.get(id);
    return r ? fromReview(r, model?.failedByRule) : null;
  }, [model, reviewById]);

  const filters = useMemo(() => {
    const known = new Set([...SEVS, ...(model?.rules.map((r) => r.severity) || [])]);
    const ds = searchParams.get('ds') || '';
    return {
      q: searchParams.get('q') || '',
      sev: new Set((searchParams.get('sev') || '').split(',').filter((s) => known.has(s))),
      health: Object.keys(HEALTH).includes(searchParams.get('health')) ? searchParams.get('health') : 'all',
      ds: !model || model.datasets.some((d) => d.name === ds) ? ds : '',
      sort: parseSort(searchParams.get('sort')),
      layout: searchParams.get('layout') === 'cards' ? 'cards' : 'table',
    };
  }, [searchParams, model]);

  const worstId = useMemo(() => {
    const list = model?.rules.filter((r) => !r.no_result).length ? model.rules.filter((r) => !r.no_result) : model?.rules || [];
    return list.length ? list.reduce((a, b) => (b.pass_percentage < a.pass_percentage ? b : a)).rule_id : null;
  }, [model]);
  const compare = useMemo(() => {
    const ids = (searchParams.get('cmp') || '').split(',').filter((id) => model?.byId.has(id));
    return [...new Set(ids)].slice(0, 3).length ? [...new Set(ids)].slice(0, 3) : worstId ? [worstId] : [];
  }, [searchParams, model, worstId]);
  const frRule = model?.byId.get(searchParams.get('rule')) || (worstId ? model.byId.get(worstId) : null);

  // ── navigation helpers ─────────────────────────────────────────────────────
  const selfNav = useRef(false);
  const lastTab = useRef(tab);
  const setTab = useCallback((id, { silent = false, patch = {} } = {}) => {
    if (id === tab && !Object.keys(patch).length) return;
    selfNav.current = true;
    update({ tab: id, ...patch }, { push: id !== tab });
    if (!silent && id !== tab) audit('bdc_tab_viewed', id, `Viewed BDC tab "${id}"`);
  }, [tab, update]);
  useEffect(() => {
    if (lastTab.current !== tab && !selfNav.current) audit('bdc_tab_viewed', tab, `Viewed BDC tab "${tab}" via browser navigation`);
    lastTab.current = tab;
    selfNav.current = false;
  }, [tab]);

  const setFilters = useCallback((patch) => update(patch), [update]);
  const setDelta = useCallback((next) => {
    if (next === delta) return;
    update({ mode: next ? 'delta' : null });
    audit('bdc_delta_mode_toggled', next ? 'delta' : 'standard', `Switched to ${next ? 'Semi-Monthly' : 'quarterly'} data view`);
    toast(`Showing ${next ? 'semi-monthly' : 'quarterly'} data`, 'info');
  }, [delta, update, toast]);
  const setExec = useCallback((next) => {
    update({ view: next ? null : 'standard' });
    audit('bdc_view_mode_toggled', next ? 'executive' : 'standard', `Switched to ${next ? 'executive' : 'standard'} view`);
  }, [update]);

  const openLayer = useCallback((patch) => update({ ...Object.fromEntries(LAYER_KEYS.map((k) => [k, null])), ...patch }, { push: true, layer: true }), [update]);
  const closeLayers = useCallback(() => closeLayer(LAYER_KEYS), [closeLayer]);
  const swapLayer = useCallback((patch) => update({ ...Object.fromEntries(LAYER_KEYS.map((k) => [k, null])), ...patch }, { clearLayer: true }), [update]);

  const openRule = useCallback((id) => openLayer({ drawer: `rule:${id}` }), [openLayer]);
  const openDataset = useCallback((name) => openLayer({ drawer: `ds:${name}` }), [openLayer]);
  const scrollToExplorer = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById('bdc-explorer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const goExplorer = useCallback((patch) => {
    if (tab !== 'overview') setTab('overview', { patch });
    else update(patch);
    scrollToExplorer();
  }, [tab, setTab, update]);

  // A layer pointing at something that no longer exists closes itself.
  const drawerRule = drawerParam.startsWith('rule:') ? resolveRule(drawerParam.slice(5)) : null;
  const drawerDs = drawerParam.startsWith('ds:') ? model?.datasets.find((d) => d.name === drawerParam.slice(3)) : null;
  const modalRule = resolveRule(mrule);
  const reviewSettled = !needsReview || !!review.data || !!review.error;
  useEffect(() => {
    if (!model || !reviewSettled) return;
    const badDrawer = drawerParam && !drawerRule && !drawerDs;
    const needsRule = ['preview', 'delta', 'runs', 'rvhistory'].includes(modalParam);
    const badModal = (searchParams.get('modal') && !modalParam) || (needsRule && !modalRule)
      || ((modalParam === 'editrule' || modalParam === 'editdate') && !mrow)
      || ((modalParam === 'newrule' || modalParam === 'editrule' || modalParam === 'newdate' || modalParam === 'editdate' || modalParam === 'rvhistory') && !isAdmin)
      || (modalParam === 'runpick' && !canRun);
    if (badDrawer || badModal) update(Object.fromEntries(LAYER_KEYS.map((k) => [k, null])), { clearLayer: true });
  }, [model, reviewSettled, drawerParam, drawerRule, drawerDs, modalParam, modalRule, mrow, searchParams, isAdmin, canRun, update]);

  // ── refresh ────────────────────────────────────────────────────────────────
  const refreshAll = useCallback(async ({ quiet = false } = {}) => {
    await Promise.all([
      loadQuery(summaryKey, (s) => api.summary(delta, true, s), { force: true }),
      loadQuery(`badge:${delta}`, (s) => api.badge(delta, s), { force: true }),
    ]);
    refetchQueries(`trend:${delta}`);
    refetchQueries(`review:${delta}`);
    refetchQueries(`rvhist:${delta}`);
    refetchQueries('reg:');
    refetchQueries('dq:');
    if (!quiet && mounted.current) toast('Data refreshed', 'ok');
  }, [summaryKey, delta, toast, mounted]);
  // After a write to the control tables: the summary (rules, colours, domains,
  // date range) and the badge can change; nothing else on the page reads them.
  const refreshSummary = useCallback(() => {
    // The other cadence is not on screen: mark it stale so it refetches when shown.
    refetchQueries(`summary:${!delta}`);
    refetchQueries(`badge:${!delta}`);
    return Promise.all([
      loadQuery(summaryKey, (s) => api.summary(delta, true, s), { force: true }),
      loadQuery(`badge:${delta}`, (s) => api.badge(delta, s), { force: true }),
    ]);
  }, [summaryKey, delta]);

  // ── downloads ──────────────────────────────────────────────────────────────
  const [downloads, setDownloads] = useState({});
  const busyDownloads = useRef(new Map());
  useEffect(() => () => busyDownloads.current.forEach((c) => c.abort()), []);
  const runDownload = useCallback(async (key, { prepare, download, fallbackName, what, onDone }) => {
    if (busyDownloads.current.has(key)) return;
    const ctrl = new AbortController();
    busyDownloads.current.set(key, ctrl);
    const set = (p) => { if (mounted.current) setDownloads((d) => ({ ...d, [key]: p })); };
    set({ pct: 0, label: 'Starting' });
    try {
      const ready = await stream(prepare, {
        signal: ctrl.signal,
        isLast: (e) => e.type === 'ready',
        onEvent: (e) => { if (e.type !== 'ready' && e.type !== 'error' && e.pct != null) set({ pct: Math.round(e.pct), label: e.label?.replace(/[.…]+$/, '') || 'Preparing' }); },
      });
      set({ pct: 0, label: 'Downloading' });
      const file = await downloadWithProgress(download(ready.token), {
        fallbackName: ready.filename || fallbackName, signal: ctrl.signal, onProgress: (p) => set({ pct: p, label: 'Downloading' }),
      });
      saveBlob(file.blob, ready.filename || file.name);
      onDone?.();
      if (mounted.current) toast(`${what} is ready`, 'ok');
    } catch (e) {
      if (e.name !== 'AbortError' && mounted.current) toast(`${what} failed: ${e.message}`, 'bad');
    } finally {
      busyDownloads.current.delete(key);
      if (mounted.current) setDownloads((d) => { const c = { ...d }; delete c[key]; return c; });
    }
  }, [toast, mounted]);

  const downloadFailed = useCallback((rule, origin) => {
    const id = rule.rule_id;
    runDownload(`failed:${delta}:${id}`, {
      prepare: `/api/rules/${encodeURIComponent(id)}/prepare-download?delta_mode=${delta}`,
      download: (t) => `/api/rules/${encodeURIComponent(id)}/download-ready?token=${encodeURIComponent(t)}`,
      fallbackName: `${id}_failed_rows.xlsx`,
      what: `Failed rows for ${id}`,
      onDone: () => (origin === 'review'
        ? audit('bdc_review_failed_rows_downloaded', id, `Downloaded failed rows for rule "${id}" (under review)`)
        : audit('bdc_failed_rows_downloaded', id, `Downloaded failed rows for rule "${id}"`)),
    });
  }, [delta, runDownload]);
  const downloadDelta = useCallback((rule, from, to) => {
    const id = rule.rule_id;
    const q = new URLSearchParams({ delta_mode: String(delta) });
    if (from) q.set('stg_table', from);
    if (to) q.set('to_stg_table', to);
    runDownload(`delta:${delta}:${id}:${from || ''}:${to || ''}`, {
      prepare: `/api/rules/${encodeURIComponent(id)}/prepare-delta?${q}`,
      download: (t) => `/api/rules/${encodeURIComponent(id)}/download-delta?token=${encodeURIComponent(t)}`,
      fallbackName: `${id}_delta_report.xlsx`,
      what: `Delta workbook for ${id}`,
      onDone: () => audit('bdc_delta_report_downloaded', id, `Downloaded delta report for rule "${id}"${from ? ` (vs snapshot: ${from})` : ''}`),
    });
  }, [delta, runDownload]);
  const downloadConsolidated = useCallback((name) => {
    runDownload(`cons:${delta}:${name}`, {
      prepare: `/api/consolidated-report/prepare-excel?report_name=${encodeURIComponent(name)}&delta_mode=${delta}`,
      download: (t) => `/api/consolidated-report/download?token=${encodeURIComponent(t)}`,
      fallbackName: 'consolidated_failed_rows.xlsx',
      what: 'Consolidated report',
      onDone: () => audit('bdc_consolidated_report_downloaded', name, 'Downloaded consolidated failed rows Excel report'),
    });
  }, [delta, runDownload]);

  // ── validation / compilation runs ──────────────────────────────────────────
  const [run, setRun] = useState(null);
  const [runOpen, setRunOpen] = useState(false);
  const runState = useRef(null);
  const runCtrl = useRef(null);
  useEffect(() => () => runCtrl.current?.abort(), []);
  const [pickedValMode, setValMode] = useState('EXECUTE_FULL');
  const valMode = limited ? 'EXECUTE_RULE' : pickedValMode;

  const snapshot = useRafCallback(() => {
    const st = runState.current;
    if (!st || !mounted.current) return;
    const expected = st.expected || 0;
    let pctDone = 3;
    if (st.connected) pctDone = st.kind === 'validate' && expected ? Math.round(8 + (84 * Math.min(st.seen.size, expected)) / expected) : 8;
    if (st.phase === 'refresh') pctDone = 96;
    if (st.status !== 'running') pctDone = st.status === 'ok' || st.status === 'partial' ? 100 : pctDone;
    const labels = STEP_LABELS[st.kind](modeLabel(st.mode).toLowerCase());
    const at = { connect: 0, stream: 1, refresh: 2, end: 3 }[st.phase];
    const stateOf = (i) => {
      if (st.failedAt === i) return 'fail';
      if (i < at) return 'done';
      return i === at && st.status === 'running' ? 'run' : '';
    };
    const notes = [
      st.connectedIn != null ? `${(st.connectedIn / 1000).toFixed(1)}s` : '',
      st.kind === 'validate' && expected ? `${plural(st.lines.length, 'line')} · ${Math.min(st.seen.size, expected)}/${expected} rules` : plural(st.lines.length, 'line'),
      st.refreshedIn != null ? `${(st.refreshedIn / 1000).toFixed(1)}s` : '',
    ];
    setRun({
      kind: st.kind, label: st.label, status: st.status, pct: pctDone, count: st.lines.length, lines: st.lines,
      shown: st.lines.slice(-400), steps: labels.map((label, i) => ({ label, state: stateOf(i), note: notes[i] })),
    });
  });

  const startRun = useCallback((kind, mode = 'EXECUTE_FULL') => {
    if (runState.current?.status === 'running') { setRunOpen(true); return; }
    const ruleId = kind === 'validate' && !VAL_MODES.some((m) => m.mode === mode) ? mode.slice(8) : null;
    const label = kind === 'compile' ? 'Compilation' : ruleId ? `Validation · ${ruleId}` : `Validation · ${modeLabel(mode)}`;
    // Rule ids from this cadence's results. A delta run only covers rules with a
    // DELTA_TABLE, which only the Semi-Monthly view knows, so elsewhere the
    // count is unknown and the bar moves by phase instead of by rule.
    const ids = mode === 'EXECUTE_ALLRULES_DELTA' && !model?.delta ? [] : Object.keys(model?.failedByRule || {});
    const st = {
      kind, mode, label, status: 'running', phase: 'connect', lines: [], seen: new Set(), connected: false,
      started: performance.now(), expected: kind === 'compile' ? 0 : ruleId ? 1 : mode === 'EXECUTE_FULL' ? 0 : ids.length,
      pattern: kind === 'validate' ? ruleIdPattern(ruleId ? [ruleId] : ids) : null, failedAt: null,
    };
    runState.current = st;
    runCtrl.current?.abort();
    const ctrl = new AbortController();
    runCtrl.current = ctrl;
    setRunOpen(true);
    snapshot();

    const isVal = kind === 'validate';
    audit(isVal ? 'bdc_validation_started' : 'bdc_compilation_started', isVal ? mode : 'compilation', isVal ? `Started validation (mode: ${modeLabel(mode)})` : 'Started compilation');
    const push = (e) => {
      if (!st.connected) { st.connected = true; st.connectedIn = performance.now() - st.started; st.phase = 'stream'; }
      if (e.type === 'done') return;
      const text = e.message || '';
      if (st.pattern && text) for (const m of text.matchAll(st.pattern)) st.seen.add(m[1]);
      const cls = e.type === 'success' ? 'ok' : e.type === 'error' || /\b(error|failed|exception|traceback)\b/i.test(text) ? 'wn' : '';
      st.lines.push({ n: st.lines.length, type: e.type, text, time: timeOf(e.timestamp), cls });
      snapshot();
    };
    const url = isVal ? `/api/run-validation?mode=${encodeURIComponent(mode)}` : '/api/run-compilation';
    stream(url, { signal: ctrl.signal, rejectOnError: false, isLast: (e) => e.type === 'done', onEvent: push })
      .then(async (done) => {
        const ok = done.returncode === 0;
        // The DQE engine exits 1 when some rules errored; the others still wrote results.
        const partial = done.returncode === 1;
        audit(isVal ? 'bdc_validation_completed' : 'bdc_compilation_completed', isVal ? mode : 'compilation',
          `${isVal ? `Validation (mode: ${modeLabel(mode)})` : 'Compilation'} ${ok ? 'succeeded' : partial ? 'finished with some rules failing (exit code 1)' : `failed (exit code ${done.returncode})`}`);
        if (!ok && !partial) {
          st.status = 'fail';
          st.failedAt = 1;
          snapshot();
          if (mounted.current) toast(`${label} failed`, 'bad', 'View log', () => setRunOpen(true));
          return;
        }
        st.phase = 'refresh';
        snapshot();
        const t0 = performance.now();
        await refreshAll({ quiet: true });
        refetchQueries('bdc:runs');
        st.refreshedIn = performance.now() - t0;
        st.phase = 'end';
        st.status = partial ? 'partial' : 'ok';
        snapshot();
        if (mounted.current) {
          if (partial) toast(`${label} finished, but some rules failed`, 'bad', 'View log', () => setRunOpen(true));
          else toast(`${label} finished`, 'ok', 'View log', () => setRunOpen(true));
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        st.status = 'fail';
        st.failedAt = { connect: 0, stream: 1, refresh: 2 }[st.phase] ?? 1;
        st.lines.push({ n: st.lines.length, type: 'error', text: err.message, time: timeOf(), cls: 'wn' });
        snapshot();
        if (mounted.current) toast(`${label}: ${err.message}`, 'bad');
      });
  }, [model, snapshot, refreshAll, toast, mounted]);

  const validate = useCallback(() => {
    if (valMode === 'EXECUTE_RULE') openLayer({ modal: 'runpick' });
    else startRun('validate', valMode);
  }, [valMode, openLayer, startRun]);
  const pickValMode = useCallback((m) => {
    if (m === 'EXECUTE_RULE') { openLayer({ modal: 'runpick' }); return; }
    setValMode(m);
    startRun('validate', m);
  }, [openLayer, startRun]);

  // ── layers, palette, tour, keys ────────────────────────────────────────────
  const [palette, setPalette] = useState(false);
  const [tour, setTour] = useState(false);
  const [editMode, setEditModeState] = useState(false);
  const setEditMode = useCallback((on) => {
    setEditModeState(on);
    if (on) audit('bdc_edit_mode_entered', 'rule-input', 'Entered edit mode for "rule-input" table');
  }, []);
  const startTour = useCallback(() => {
    setPalette(false);
    setTour(true);
    audit('bdc_tour_started', '', 'Started guided tour');
  }, []);

  const keys = useRef({});
  useEffect(() => {
    keys.current = { palette, tour, runOpen, modal: modalParam, drawer: drawerParam, tabs, setTab, closeLayers };
  });
  useEffect(() => {
    if (isExec) return undefined;
    const onKey = (e) => {
      const k = keys.current;
      const el = document.activeElement;
      const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.key === 'Escape') {
        if (k.palette) setPalette(false);
        else if (k.tour) setTour(false);
        else if (k.runOpen) setRunOpen(false);
        else if (k.modal || k.drawer) k.closeLayers();
        return;
      }
      if (k.palette || k.tour || typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      if (/^[1-9]$/.test(e.key) && !k.modal && !k.drawer && !k.runOpen) {
        const t = k.tabs[+e.key - 1];
        if (t) k.setTab(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isExec]);

  const root = useRef(null);
  const spot = useRafCallback((target, x, y) => {
    const b = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${x - b.left}px`);
    target.style.setProperty('--my', `${y - b.top}px`);
  });
  useEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    // the pointer spotlight repaints its card on every move; skipped in light mode
    const move = (e) => { if (document.documentElement.hasAttribute('data-bdx-lite')) return; const s = e.target.closest?.('.spot'); if (s) spot(s, e.clientX, e.clientY); };
    node.addEventListener('pointermove', move, { passive: true });
    const top = node.querySelector('.top');
    const setTop = () => node.style.setProperty('--top-h', `${getComputedStyle(top).position === 'sticky' ? top.offsetHeight : 0}px`);
    setTop();
    const ro = new ResizeObserver(setTop);
    ro.observe(top);
    return () => { node.removeEventListener('pointermove', move); ro.disconnect(); };
  }, [spot, isExec]);

  const exportCsv = useCallback(() => {
    if (!model) return;
    const list = filterRules(model.rules, filters, filters.sort);
    exportRulesCsv(list, delta);
    toast(`Exported ${plural(list.length, 'rule')}`, 'ok');
  }, [model, filters, delta, toast]);

  const paletteGroups = useCallback((q) => {
    const m = (s) => !q || s.toLowerCase().includes(q);
    const actions = [
      canRun && { title: 'Run validation', icon: 'play', run: validate },
      canRun && !limited && { title: 'Run compilation', icon: 'network', run: () => startRun('compile') },
      { title: `Switch to ${delta ? 'Quarterly' : 'Semi-Monthly'} data`, icon: 'time', run: () => setDelta(!delta) },
      canDownload && { title: 'Export rules as CSV', icon: 'download', run: exportCsv },
      { title: 'Refresh data', icon: 'refresh', run: () => refreshAll() },
      canExec && { title: 'Open the Executive View', icon: 'dashboard', run: () => setExec(true) },
      { title: 'Take the guided tour', icon: 'help', run: startTour },
    ].filter(Boolean).filter((a) => m(a.title));
    const tabItems = tabs.filter((t) => m(t.name) || m(`go to ${t.name}`)).map((t) => ({ title: `Go to ${t.name}`, icon: t.icon, run: () => setTab(t.id) }));
    const rules = (model?.rules || []).filter((r) => m(`${r.rule_id} ${r.rule_title}`)).slice(0, 8)
      .map((r) => ({ title: r.rule_title, icon: 'records', sub: `${r.rule_id} · ${pct(r.pass_percentage)}`, run: () => openRule(r.rule_id) }));
    const sets = (model?.datasets || []).filter((d) => m(d.name))
      .map((d) => ({ title: d.name, icon: 'database', sub: `${plural(d.rules.length, 'rule')} · ${d.pass == null ? 'no result' : pct(d.pass)}`, run: () => openDataset(d.name) }));
    return [['Actions', actions], ['Tabs', tabItems], ['Rules', rules], ['Datasets', sets]].filter(([, items]) => items.length).map(([name, items]) => ({ name, items }));
  }, [canRun, limited, canDownload, canExec, validate, startRun, delta, setDelta, exportCsv, refreshAll, setExec, startTour, tabs, setTab, model, openRule, openDataset]);

  // ── hero callbacks (stable, so the memoised hero never re-renders on filter changes) ──
  const heroHealth = useCallback((h) => goExplorer({ health: h }), [goExplorer]);
  const heroAttention = useCallback(() => goExplorer({ sort: 'pass.asc' }), [goExplorer]);
  const heroFind = useCallback(() => setPalette(true), []);
  // Retry skips the server's 30 s summary cache, which also holds a failed date-range lookup.
  const retrySummary = useCallback(() => loadQuery(summaryKey, (s) => api.summary(delta, true, s), { force: true }), [summaryKey, delta]);
  const openQueue = useCallback(() => setTab('review'), [setTab]);

  // The page behind an open dialog, drawer or palette must not scroll. Layers
  // are portalled into <body>, so when the page scrolls inside the app's <main>
  // (the normal case) a wheel over them can't reach it and nothing needs doing;
  // toggling overflow on <main> cost a full relayout and repaint per open.
  // Only a page that scrolls the window itself gets locked.
  const layerUp = !isExec && (!!drawerParam || !!modalParam || palette || runOpen);
  useEffect(() => {
    if (!layerUp) return undefined;
    let el = root.current?.parentElement;
    while (el && el !== document.body && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (el && el !== document.body) return undefined;
    const html = document.documentElement;
    const prev = [html.style.overflow, html.style.scrollbarGutter];
    html.style.scrollbarGutter = 'stable';
    html.style.overflow = 'hidden';
    return () => { [html.style.overflow, html.style.scrollbarGutter] = prev; };
  }, [layerUp]);

  if (isExec) {
    return (
      <ExecutiveView
        embedded
        showHeader
        deltaMode={delta}
        onDeltaModeChange={(next) => {
          update({ mode: next ? 'delta' : null });
          audit('bdc_delta_mode_toggled', next ? 'delta' : 'standard', `Switched to ${next ? 'Semi-Monthly' : 'quarterly'} data view`);
        }}
        onExitExec={canStd ? () => setExec(false) : undefined}
        onBack={onBack}
      />
    );
  }

  // ── panel ──────────────────────────────────────────────────────────────────
  const common = { model, loading: modelLoading, error: summary.error, onRetry: retrySummary };
  let panel;
  if (tab === 'overview') panel = <Overview {...common} filters={filters} setFilters={setFilters} onRule={openRule} canDownload={canDownload} />;
  else if (tab === 'dataset-health') panel = <Datasets {...common} onDataset={openDataset} />;
  else if (tab === 'trends') {
    panel = (
      <Trends {...common} selected={compare} setSelected={(ids) => update({ cmp: ids.join(',') })}
        filter={searchParams.get('tq') || ''} setFilter={(v) => update({ tq: v || null })} />
    );
  } else if (tab === 'failed-rows') {
    const id = frRule?.rule_id;
    panel = (
      <FailedRows {...common} rule={frRule} onPick={(rid) => update({ rule: rid })}
        onPreview={() => openLayer({ modal: 'preview', mrule: id })}
        onDelta={() => openLayer({ modal: 'delta', mrule: id })}
        onAdvanced={() => openLayer({ modal: 'runs', mrule: id })}
        onConsolidated={() => openLayer({ modal: 'consolidated' })}
        onDownload={canDownload ? () => frRule && downloadFailed(frRule) : null}
        download={frRule ? downloads[`failed:${delta}:${id}`] : null} />
    );
  } else if (tab === 'admin') {
    panel = (
      <Superuser section={section} setSection={(id) => update({ dqtab: id })} sections={SU_SECTIONS} editMode={editMode} setEditMode={setEditMode}
        onNewRule={() => openLayer({ modal: 'newrule' })} onEditRule={(key) => openLayer({ modal: 'editrule', mrow: key })}
        onNewDate={() => openLayer({ modal: 'newdate' })} onEditDate={(key) => openLayer({ modal: 'editdate', mrow: key })}
        onChanged={refreshSummary} />
    );
  } else if (tab === 'review') {
    panel = (
      <Review review={review} model={model} delta={delta} filter={rvFilter} setFilter={(v) => update({ rv: v === 'pending' ? null : v })}
        onPeek={(id) => openLayer({ modal: 'preview', mrule: id, org: 'review' })} onHistory={(id) => openLayer({ modal: 'rvhistory', mrule: id })}
        onRule={openRule}
        onChanged={() => { refreshAll({ quiet: true }); }} />
    );
  }

  // ── modal content ──────────────────────────────────────────────────────────
  const cadence = delta ? 'Semi-Monthly' : 'Quarterly';
  const rangeText = model?.range?.from_date ? `${fmtDay(model.range.from_date)} to ${fmtDay(model.range.to_date)}` : cycleLabel(model?.range, delta);
  let modal = null;
  if (modalParam && (modalRule || !['preview', 'delta', 'runs', 'rvhistory'].includes(modalParam))) {
    const r = modalRule;
    const cf = COLOR_FILTERS.has(searchParams.get('cf')) ? searchParams.get('cf') : 'ALL';
    const sheet = DELTA_SHEETS.includes(searchParams.get('sheet')) ? searchParams.get('sheet') : 'new_failures';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const origin = searchParams.get('org') === 'review' ? 'review' : 'tab';
    if (modalParam === 'preview') {
      const dl = downloads[`failed:${delta}:${r.rule_id}`];
      modal = {
        wide: true, title: `Failing rows · ${r.rule_id}`, sub: r.rule_title,
        body: <PreviewBody rule={r} delta={delta} color={cf} setColor={(v) => update({ cf: v === 'ALL' ? null : v })} origin={origin} />,
        actions: canDownload && <button type="button" className="btn primary" onClick={() => downloadFailed(r, origin)} disabled={!!dl || r.failed_rows === 0}><I n="download" />{dl ? `${dl.label} · ${dl.pct}%` : 'Download Excel'}</button>,
      };
    } else if (modalParam === 'delta') {
      const dl = downloads[`delta:${delta}:${r.rule_id}:${from || ''}:${to || ''}`];
      modal = {
        wide: true, title: `Compare runs · ${r.rule_id}`, sub: r.rule_title,
        body: <DeltaBody rule={r} delta={delta} sheet={sheet} from={from} to={to} setSheet={(v) => update({ sheet: v === 'new_failures' ? null : v })} />,
        foot: (
          <>
            <button type="button" className="btn ghost" onClick={() => openLayer({ modal: 'runs', mrule: r.rule_id, from, to })}><I n="time" />Choose runs…</button>
            <span style={{ flex: 1 }} />
            {canDownload && <button type="button" className="btn primary" onClick={() => downloadDelta(r, from, to)} disabled={!!dl}>{dl ? `${dl.label} · ${dl.pct}%` : 'Download delta workbook'}</button>}
          </>
        ),
      };
    } else if (modalParam === 'runs') {
      modal = {
        title: `Choose runs · ${r.rule_id}`, sub: 'Pick the older and the newer run to compare',
        body: <RunPickerBody rule={r} delta={delta} initial={{ from, to }} onCancel={closeLayers}
          onApply={(f, t) => swapLayer({ modal: 'delta', mrule: r.rule_id, from: f, to: t })} />,
      };
    } else if (modalParam === 'consolidated') {
      const rep = searchParams.get('rep') || null;
      modal = {
        wide: true, title: `Consolidated report · ${cadence}`, sub: 'Failing rows across every active rule, de-duplicated, with a FAILURE_MODE column',
        body: <ConsolidatedBody delta={delta} canGenerate={canRun && !limited} canDownload={canDownload} limited={limited} reportName={rep} setReportName={(name) => update({ rep: name })}
          download={rep ? downloads[`cons:${delta}:${rep}`] : Object.entries(downloads).find(([k]) => k.startsWith(`cons:${delta}:`))?.[1]}
          onDownload={downloadConsolidated} />,
      };
    } else if (modalParam === 'runpick') {
      modal = {
        title: 'Validate a specific rule', sub: 'Runs full-table validation for one rule only',
        body: <RuleRunPicker rules={model?.rules || []} onRun={(id) => { swapLayer({}); startRun('validate', `EXECUTE_${id}`); }} />,
      };
    } else if (modalParam === 'newrule' || modalParam === 'editrule') {
      const isNew = modalParam === 'newrule';
      modal = {
        bare: true, title: isNew ? 'New business rule' : `Edit ${mrow}`, sub: isNew ? 'IS_ACTIVE is set to TRUE and timestamps are set by the server' : 'Saving creates a new version of this rule',
        body: <RuleForm key={`${modalParam}:${mrow}`} mode={isNew ? 'new' : 'edit'} ruleKey={mrow} onCancel={closeLayers}
          onDone={() => { closeLayers(); refetchQueries('dq:'); refreshSummary(); }} />,
      };
    } else if (modalParam === 'newdate' || modalParam === 'editdate') {
      const isNew = modalParam === 'newdate';
      modal = {
        bare: true, title: isNew ? 'New date range' : 'Edit date range', sub: 'CREATED_DATE and UPDATED_DATE are set by the server',
        body: <DateForm key={`${modalParam}:${mrow}`} mode={isNew ? 'new' : 'edit'} rowKey={mrow} onCancel={closeLayers}
          onDone={() => { closeLayers(); refetchQueries('dq:'); refreshSummary(); }} />,
      };
    } else if (modalParam === 'rvhistory') {
      modal = { title: `Review history · ${r.rule_id}`, sub: r.rule_title, body: <ReviewHistoryBody ruleId={r.rule_id} delta={delta} /> };
    }
  }
  const runModal = runOpen && run ? {
    title: run.label, sub: `${cadence} · ${rangeText}`,
    body: <RunBody run={run} />,
    foot: run.status === 'running' ? <button type="button" className="btn ghost" onClick={() => setRunOpen(false)}>Run in background</button> : null,
  } : null;
  const shownModal = runModal || modal;
  const drawerOpen = !!(drawerRule || drawerDs) && !shownModal;
  const anyLayer = drawerOpen || !!shownModal || palette;
  const closeShown = runModal ? () => setRunOpen(false) : closeLayers;

  return (
    <div className="bdx bdx-page" ref={root}>
      <TopBar delta={delta} onCadence={setDelta} showBack onBack={onBack} onPalette={heroFind} canRun={canRun} canExec={canExec}
        valMode={valMode} onValidate={validate} onValPick={pickValMode} onCompile={() => startRun('compile')}
        onExec={() => setExec(true)} onRefresh={() => refreshAll()} refreshing={summary.refreshing} onTour={startTour}
        run={run} onShowRun={() => setRunOpen(true)} limited={limited} />
      <Hero model={model} loading={modelLoading} delta={delta} lite={lite} onRule={openRule} onDataset={openDataset} onHealth={heroHealth}
        onAttention={heroAttention} onFind={heroFind} onRetryRange={retrySummary} />
      <div className="wrap">
        <Kpis model={model} loading={modelLoading} pending={badge.data?.pending ?? null} pendingLoading={badge.loading} isAdmin={isAdmin} onQueue={openQueue} />
        <TabBar tabs={tabs} active={tab} onTab={setTab} badge={isAdmin ? badge.data?.pending ?? 0 : 0} synced={model?.generatedAt} />
        <div role="tabpanel" id="bdx-panel" aria-labelledby={`bdx-tab-${tab}`} key={`${tab}:${delta}`} className="panel">{panel}</div>
      </div>

      {createPortal(
        <div className="bdx bdx-layer">
          <div className={`scrim ${anyLayer ? 'on' : ''}`} onClick={() => (palette ? setPalette(false) : closeShown())} aria-hidden="true" />
          <Drawer open={drawerOpen} label="Details">
            {drawerRule ? (
              <RuleDrawer key={drawerRule.rule_id} rule={drawerRule} review={reviewById.get(drawerRule.rule_id)} canRun={canRun} onClose={closeLayers}
                onPreview={() => openLayer({ modal: 'preview', mrule: drawerRule.rule_id })}
                onTrend={model?.byId.has(drawerRule.rule_id) ? () => { swapLayer({}); setTab('trends', { patch: { cmp: drawerRule.rule_id } }); } : null}
                onValidate={() => { swapLayer({}); startRun('validate', `EXECUTE_${drawerRule.rule_id}`); }} />
            ) : drawerDs ? (
              <DatasetDrawer key={drawerDs.name} ds={drawerDs} onClose={closeLayers} onRule={openRule}
                onFilter={() => { swapLayer({}); goExplorer({ ds: drawerDs.name }); }} />
            ) : null}
          </Drawer>
          <Modal open={!!shownModal} wide={shownModal?.wide} bare={shownModal?.bare} title={shownModal?.title} sub={shownModal?.sub} actions={shownModal?.actions}
            foot={shownModal?.foot} onClose={closeShown} label="Dialog">
            {shownModal?.body}
          </Modal>
          <Palette open={palette} onClose={() => setPalette(false)} groups={paletteGroups} />
        </div>,
        document.body,
      )}
      <Tour open={tour} onClose={() => setTour(false)} />
      <TruncationTip />
    </div>
  );
}

export default function BusinessDefinedChecks({ onBack }) {
  return (
    <ToastHost>
      <Page onBack={onBack} />
    </ToastHost>
  );
}