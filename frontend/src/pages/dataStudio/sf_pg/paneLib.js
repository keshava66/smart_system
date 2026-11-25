import { createContext, useContext } from 'react';
import sfIcon from '/icons/snowflake_badge.svg';
import pgIcon from '/icons/postgres_badge.svg';

// One pane, two engines. Postgres has no cross-database queries, so each
// worksheet there picks its database (pickDb) and sends it with the query.
// The engine's colour carries every state (selection, focus, the open picker);
// red stays for Run, primary buttons, errors and anything destructive.
export const sigVars = (E) => ({ '--sig': E.accent, '--sig-ink': E.ink, '--sig-soft': E.soft, '--sig-mid': E.mid, '--sig-ring': `${E.accent}55` });

export const ENGINES = {
  snowflake: { id: 'snowflake', label: 'Snowflake', api: '/api/snowflake', icon: sfIcon, store: 'snowflake', log: 'sf', configKey: 'snowflake_query_runner', accent: '#29b5e8', ink: '#0b6f94', soft: '#e6f6fc', mid: '#bfe7f7', copier: true, pickDb: false, upperIdents: true, sample: '"MY_DB"."PUBLIC"."MY_TABLE"' },
  postgres: { id: 'postgres', label: 'Postgres', api: '/api/pgstudio', icon: pgIcon, store: 'pgstudio', log: 'pg', configKey: 'postgres_query_runner', accent: '#336791', ink: '#24496b', soft: '#e9eff6', mid: '#c4d5e7', copier: false, pickDb: true, upperIdents: false, sample: '"public"."my_table"' },
};

export const EngineCtx = createContext(ENGINES.snowflake);

// Adds the worksheet's login/role query string (conn_id=..&role=..) to a URL.
export const withQs = (url, qs) => (qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url);

export const useEngine = () => useContext(EngineCtx);

// J&J palette for the Snowflake pane. Neutrals come from the warm J&J grays,
// red is the one brand accent and is kept for primary actions and focus.
// Status colours are functional only (dots, small badges), never big fills.
export const T = {
  ink: '#312c2a',
  text: '#4a423e',
  muted: '#6e6259',
  faint: '#766a63',
  line: '#e8e6e3',
  lineStrong: '#d5cfc9',
  panel: '#f1efed',
  panelSoft: '#f8f7f5',
  zebra: '#fbfaf9',
  hover: '#f4f2f0',
  red: '#eb1700',
  redHover: '#c51300',
  redSoft: 'var(--sig-soft)',
  redTint: 'rgba(235,23,0,0.08)',
  maroon: '#9e0000',
  green: '#328714',
  greenSoft: '#eef6ea',
  amber: '#a14a00',
  amberSoft: '#fff3ea',
  blue: '#0f68b2',
};

export const fmtMs = (ms) => {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

// One formatter each: toLocaleString builds a new one per call, which adds up across a grid.
export const NF = new Intl.NumberFormat();

export const fmtN = (n) => (typeof n === 'number' || typeof n === 'bigint' ? NF.format(n) : (n ?? 0).toLocaleString());

export const plural = (n, word) => `${fmtN(n)} ${word}${n === 1 ? '' : 's'}`;

// Snowflake type as people expect to read it, the way Snowsight shows it.
// Query results come back with connector names (FIXED, TEXT, REAL) and the
// table columns API gives the bare INFORMATION_SCHEMA type plus its length,
// precision and scale, so both get turned into NUMBER(38,0), VARCHAR(100)...
const TIME_TYPES = new Set(['TIME', 'TIMESTAMP', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ', 'DATETIME']);

const ALIASES = {
  FIXED: 'NUMBER', DECIMAL: 'NUMBER', NUMERIC: 'NUMBER', INT: 'NUMBER', INTEGER: 'NUMBER', BIGINT: 'NUMBER',
  SMALLINT: 'NUMBER', TINYINT: 'NUMBER', BYTEINT: 'NUMBER',
  REAL: 'FLOAT', DOUBLE: 'FLOAT', 'DOUBLE PRECISION': 'FLOAT', FLOAT4: 'FLOAT', FLOAT8: 'FLOAT',
  TEXT: 'VARCHAR', STRING: 'VARCHAR', CHARACTER: 'CHAR', VARBINARY: 'BINARY', DATETIME: 'TIMESTAMP_NTZ',
};

// Postgres spells some types out in full; show the names people write.
const PG_SHORT = [[/^character varying/i, 'varchar'], [/^timestamp without time zone/i, 'timestamp'], [/^timestamp with time zone/i, 'timestamptz'],
  [/^time without time zone/i, 'time'], [/^double precision/i, 'float8'], [/^character\b/i, 'char']];

const shortType = (t) => PG_SHORT.reduce((x, [re, to]) => x.replace(re, to), t);

// Snowflake's defaults for "no limit" (VARCHAR 16 MB, BINARY 8 MB, and the 128 MB ceiling).
const MAX_LEN = new Set([16777216, 8388608, 134217728, 67108864]);

export function displayType(col) {
  if (!col) return '';
  if (typeof col === 'string') col = { type: col };
  if (col.display_type) return shortType(col.display_type).replace(/^(VARCHAR|TEXT|STRING|BINARY)\((16777216|8388608|134217728|67108864)\)$/i, '$1');
  const raw = shortType(String(col.data_type || col.type || '').trim()).toUpperCase();
  if (!raw || raw.includes('(')) return raw;
  const base = ALIASES[raw] || raw;
  const p = col.precision ?? col.numeric_precision;
  const sc = col.scale ?? col.numeric_scale;
  const len = col.char_length ?? col.internal_size;
  if (base === 'NUMBER') return p != null ? `NUMBER(${p},${sc ?? 0})` : 'NUMBER';
  if (base === 'VARCHAR' || base === 'CHAR' || base === 'BINARY') return len && !MAX_LEN.has(Number(len)) ? `${base}(${len})` : base;
  if (TIME_TYPES.has(base) && sc != null && col.type && !col.data_type) return `${base}(${sc})`;
  return base;
}

export function typeFamily(t) {
  const u = (t || '').toUpperCase();
  if (/\[\]$/.test(u)) return 'vec';      // Postgres arrays (integer[] is a list, not a number)
  if (/^(NUMBER|FLOAT|FIXED|REAL|DECIMAL|NUMERIC|INT|INTEGER|BIGINT|SMALLINT|TINYINT|BYTEINT|DOUBLE)/.test(u)) return 'num';
  if (/^(DATE|TIME|TIMESTAMP|DATETIME)/.test(u)) return 'time';
  if (/^BOOL/.test(u)) return 'bool';
  if (/^(VARIANT|OBJECT|ARRAY|MAP|JSON)/.test(u)) return 'json';
  if (/^(BINARY|VARBINARY|BYTEA)/.test(u)) return 'bin';
  if (/^(GEOGRAPHY|GEOMETRY)/.test(u)) return 'geo';
  if (/^VECTOR/.test(u)) return 'vec';
  return 'text';
}

export function colGlyph(dataType) {
  return { num: '#', time: '◷', bool: '✓', json: '{}', bin: '01', geo: '⌖', vec: '[]', text: 'Aa' }[typeFamily(dataType)];
}

// "Saggurthi, Keshava purna vardhan" (how the directory writes names) -> Keshava;
// "Ann Tester" -> Ann; "ann@x.com" -> ann.
export const firstName = (name) => {
  const n = (name || '').trim();
  const given = n.includes(',') ? n.slice(n.indexOf(',') + 1) : n;
  return given.trim().split(/[\s@]/)[0] || n.split(/[\s@,]/)[0] || 'Someone';
};

export const isBig = (v) => Boolean(v && typeof v === 'object' && v.$truncated);

/* ----------------------------- SQL formatting ---------------------------- */
// Small Snowflake-aware formatter. Clause keywords start a new line, select
// lists / ORDER BY / GROUP BY break on commas, WHERE / HAVING break on
// AND / OR, and subqueries indent. Anything it isn't sure about (comments,
// $$ bodies, DDL, MERGE, scripts) is handed back untouched, so it never
// changes what a statement does.

export const FMT_IND = '    ';

const FMT_SKIP_LEAD = /^\s*(CREATE|ALTER|MERGE|CALL|BEGIN|DECLARE|EXECUTE|GRANT|REVOKE|SHOW|DESC|DESCRIBE|USE|COPY|PUT|GET|LIST|REMOVE|UNDROP|DROP|TRUNCATE|COMMENT|EXPLAIN)\b/i;

const FMT_PAREN_SPACE = new Set(['IN', 'AS', 'ON', 'AND', 'OR', 'NOT', 'USING', 'VALUES', 'FROM', 'JOIN', 'EXISTS', 'OVER', 'INTO', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'WHERE', 'BY', 'IS', 'ALL', 'ANY', 'WITH', 'LATERAL', 'SET', 'HAVING', 'QUALIFY', 'UNION', 'CASE', 'RETURN']);

function fmtLex(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if ((c === '-' && sql[i + 1] === '-') || (c === '/' && sql[i + 1] === '*') || (c === '/' && sql[i + 1] === '/')) return null;
    if (c === '$' && sql[i + 1] === '$') return null;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && c === "'") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j += 1;
      }
      if (j >= n) return null;
      out.push({ k: c === "'" ? 'str' : 'id', t: sql.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_@$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[A-Za-z0-9_$@#]/.test(sql[j]) || sql.charCodeAt(j) > 127)) j += 1;
      out.push({ k: 'w', t: sql.slice(i, j), u: sql.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) j += 1;
      out.push({ k: 'num', t: sql.slice(i, j) });
      i = j;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (['::', '<=', '>=', '<>', '!=', '||', '=>', '->'].includes(two)) { out.push({ k: 'op', t: two }); i += 2; continue; }
    if ('(),;.[]'.includes(c)) { out.push({ k: 'p', t: c }); i += 1; continue; }
    out.push({ k: 'op', t: c });
    i += 1;
  }
  return out;
}

// Nest parentheses so clause splitting can treat each group as one item.
function fmtTree(tokens) {
  const root = [];
  const stack = [root];
  for (const tok of tokens) {
    if (tok.t === '(') {
      const g = { k: 'grp', items: [] };
      stack[stack.length - 1].push(g);
      stack.push(g.items);
    } else if (tok.t === ')') {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      stack[stack.length - 1].push(tok);
    }
  }
  return stack.length === 1 ? root : null;
}

// Keywords that get upper cased inside clause bodies, like Snowsight's formatter.
const FMT_UPPER = new Set(['AND', 'OR', 'NOT', 'IN', 'AS', 'ON', 'IS', 'NULL', 'LIKE', 'ILIKE', 'RLIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'OVER', 'PARTITION', 'BY', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'NATURAL', 'EXISTS', 'ALL', 'ANY', 'TRUE', 'FALSE', 'INTERVAL', 'USING', 'LATERAL', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING',
  'FOLLOWING', 'CURRENT', 'ROW', 'WITHIN', 'GROUP', 'FILTER', 'ESCAPE', 'PIVOT', 'UNPIVOT', 'FOR', 'SAMPLE', 'RECURSIVE', 'AT', 'BEFORE']);

const isW = (tok, ...words) => tok && tok.k === 'w' && words.includes(tok.u);

const isSubquery = (items) => isW(items[0], 'SELECT', 'WITH');

function fmtInline(items, depth) {
  let out = '';
  let prev = null;
  items.forEach((tok, idx) => {
    let text;
    if (tok.k === 'grp') {
      text = isSubquery(tok.items)
        ? `(\n${fmtStatement(tok.items, depth + 1)}\n${FMT_IND.repeat(depth)})`
        : `(${fmtInline(tok.items, depth)})`;
    } else {
      const next = items[idx + 1];
      text = tok.k === 'w' && FMT_UPPER.has(tok.u) && !(next && next.k === 'grp' && !FMT_PAREN_SPACE.has(tok.u)) ? tok.u : tok.t;
    }
    let space = !!out;
    if (prev) {
      if (tok.k === 'p' && [',', ';', '.', ']'].includes(tok.t)) space = false;
      if (tok.k === 'op' && (tok.t === '::' || tok.t === ':')) space = false;
      if (prev.k === 'p' && ['.', '['].includes(prev.t)) space = false;
      if (prev.k === 'op' && (prev.t === '::' || prev.t === ':')) space = false;
      if (tok.t === '[') space = false;
      if (tok.k === 'grp' && (prev.k === 'w' || prev.k === 'id') && !FMT_PAREN_SPACE.has(prev.u)) space = false;
      // unary minus / plus
      const before = items[idx - 2];
      if (prev.k === 'op' && (prev.t === '-' || prev.t === '+') && (!before || before.k === 'op' || (before.k === 'p' && before.t === ',') || before.k === 'w' && FMT_PAREN_SPACE.has(before.u))) space = false;
    }
    out += (space ? ' ' : '') + text;
    prev = tok;
  });
  return out;
}

// Splits a list on top level separators, keeping the separator words with
// the part that follows (for AND / OR / JOIN).
function fmtSplitCommas(items) {
  const parts = [[]];
  items.forEach(tok => {
    if (tok.k === 'p' && tok.t === ',') parts.push([]);
    else parts[parts.length - 1].push(tok);
  });
  return parts.filter(p => p.length);
}

function fmtSplitLogic(items) {
  const parts = [[]];
  let between = false;
  items.forEach(tok => {
    if (isW(tok, 'BETWEEN')) between = true;
    if (isW(tok, 'AND', 'OR') && parts[parts.length - 1].length) {
      if (tok.u === 'AND' && between) { between = false; parts[parts.length - 1].push(tok); return; }
      parts.push([tok]);
      return;
    }
    parts[parts.length - 1].push(tok);
  });
  return parts;
}

const JOIN_LEAD = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER', 'JOIN', 'ASOF'];

function fmtSplitFrom(items) {
  const parts = [[]];
  for (let i = 0; i < items.length; i += 1) {
    const tok = items[i];
    if (tok.k === 'p' && tok.t === ',') { parts.push([]); continue; }
    if (isW(tok, ...JOIN_LEAD) && parts[parts.length - 1].length) {
      // only a join if a JOIN keyword follows within this run of join words
      let j = i;
      while (isW(items[j], ...JOIN_LEAD) && !isW(items[j], 'JOIN')) j += 1;
      if (isW(items[j], 'JOIN') && !isW(items[i - 1], ...JOIN_LEAD)) { parts.push([tok]); continue; }
    }
    parts[parts.length - 1].push(tok);
  }
  return parts.filter(p => p.length);
}

// Clause keywords, longest first so GROUP BY wins over GROUP.
const CLAUSES = [
  ['INSERT', 'OVERWRITE', 'INTO'], ['INSERT', 'INTO'], ['DELETE', 'FROM'], ['GROUP', 'BY'], ['ORDER', 'BY'],
  ['UNION', 'ALL'], ['UNION', 'DISTINCT'], ['UNION'], ['INTERSECT'], ['EXCEPT'], ['MINUS'],
  ['WITH'], ['SELECT'], ['FROM'], ['WHERE'], ['HAVING'], ['QUALIFY'], ['LIMIT'], ['OFFSET'], ['FETCH'],
  ['UPDATE'], ['SET'], ['VALUES'], ['WINDOW'],
];

const CLAUSE_KIND = {
  SELECT: 'comma', 'GROUP BY': 'comma', 'ORDER BY': 'comma', SET: 'comma', VALUES: 'comma', WITH: 'comma', WINDOW: 'comma',
  WHERE: 'logic', HAVING: 'logic', QUALIFY: 'logic', FROM: 'from', 'DELETE FROM': 'from', UPDATE: 'from',
};

function fmtStatement(items, depth) {
  const clauses = [];
  let cur = null;
  for (let i = 0; i < items.length; i += 1) {
    const tok = items[i];
    let hit = null;
    if (tok.k === 'w' && !(cur && cur.kw === 'WITH' && !isW(tok, 'SELECT', 'INSERT', 'UPDATE', 'DELETE'))) {
      hit = CLAUSES.find(words => words.every((w, k) => isW(items[i + k], w)));
    }
    // SET inside UPDATE only, so "SET" in other spots stays inline
    if (hit && hit[0] === 'SET' && !clauses.some(c => c.kw === 'UPDATE')) hit = null;
    if (hit) {
      cur = { kw: hit.join(' '), body: [] };
      clauses.push(cur);
      i += hit.length - 1;
    } else if (cur) {
      cur.body.push(tok);
    } else {
      cur = { kw: '', body: [tok] };
      clauses.push(cur);
    }
  }
  const pad = FMT_IND.repeat(depth);
  const pad1 = FMT_IND.repeat(depth + 1);
  return clauses.map(({ kw, body }) => {
    let head = kw;
    let rest = body;
    if (kw === 'SELECT') {
      while (isW(rest[0], 'DISTINCT', 'ALL')) { head += ` ${rest[0].t}`; rest = rest.slice(1); }
      if (isW(rest[0], 'TOP') && rest[1]?.k === 'num') { head += ` ${rest[0].t} ${rest[1].t}`; rest = rest.slice(2); }
    }
    if (!rest.length) return pad + head;
    const kind = CLAUSE_KIND[kw];
    let parts;
    if (kind === 'comma') parts = fmtSplitCommas(rest).map((p, i, all) => fmtInline(p, depth + 1) + (i < all.length - 1 ? ',' : ''));
    else if (kind === 'logic') parts = fmtSplitLogic(rest).map(p => fmtInline(p, depth + 1));
    else if (kind === 'from') parts = fmtSplitFrom(rest).map((p, i, all) => fmtInline(p, depth + 1) + (i < all.length - 1 && !isW(all[i + 1][0], ...JOIN_LEAD) ? ',' : ''));
    else parts = [fmtInline(rest, depth + 1)];
    if (!head) return pad + parts.join(' ');
    if (kw === 'INSERT INTO' || kw === 'INSERT OVERWRITE INTO') parts = parts.map(x => x.replace(/^([^\s(]+)\(/, '$1 ('));
    if (kw === 'WITH') {
      const ctes = fmtSplitCommas(rest).map(x => fmtInline(x, depth));
      return `${pad}WITH ${ctes.join(`,\n${pad}`)}`;
    }
    if (parts.length === 1 && !parts[0].includes('\n') && parts[0].length <= 72) return `${pad}${head} ${parts[0]}`;
    return `${pad}${head}\n${parts.map(p => pad1 + p).join('\n')}`;
  }).join('\n');
}

export function formatSql(sql) {
  const text = String(sql || '');
  if (!text.trim() || FMT_SKIP_LEAD.test(text)) return text.replace(/\t/g, FMT_IND);
  try {
    const tokens = fmtLex(text);
    if (!tokens) return text;
    const statements = [[]];
    tokens.forEach(tok => {
      if (tok.k === 'p' && tok.t === ';') statements.push([]);
      else statements[statements.length - 1].push(tok);
    });
    const hadSemi = /;\s*$/.test(text);
    const out = [];
    for (const st of statements) {
      if (!st.length) continue;
      if (FMT_SKIP_LEAD.test(st[0].t)) return text;
      const tree = fmtTree(st);
      if (!tree) return text;
      out.push(fmtStatement(tree, 0));
    }
    if (!out.length) return text;
    return out.join(';\n\n') + (hadSemi || out.length > 1 ? ';' : '');
  } catch {
    return text;
  }
}

// Statement spans in a worksheet, same rules as split_script in the backend:
// semicolons inside strings, quoted names, comments and $$ / $tag$ bodies don't split.
export function statementSpans(sql, backslashEscapes = false) {
  const spans = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const push = (a, b) => {
    const text = sql.slice(a, b);
    const code = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (code) spans.push({ start: a + (text.length - text.trimStart().length), end: b });
  };
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (ch === "'") {
      i += 1;
      while (i < n && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" || (backslashEscapes && sql[i] === '\\') ? 2 : 1;
      i += 1;
    } else if (ch === '"') {
      const j = sql.indexOf('"', i + 1);
      i = j < 0 ? n : j + 1;
    } else if (ch === '-' && nx === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (ch === '/' && nx === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
    } else if (ch === '$' && !/[\w$]/.test(sql[i - 1] || '')) {
      const m = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const j = sql.indexOf(m[0], i + m[0].length);
        i = j < 0 ? n : j + m[0].length;
      } else i += 1;
    } else if (ch === ';') {
      push(start, i);
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  push(start, n);
  return spans;
}

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
