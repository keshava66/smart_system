/* Pure helpers for Index Health, shared with the Data API index builder. */

// FastAPI 422s send detail as a list of {msg}; everything else is a string
export const msg = (e) => {
  const d = e?.detail;
  if (Array.isArray(d)) return d.map((x) => x?.msg || JSON.stringify(x)).join('; ');
  if (typeof d === 'string') return d;
  return e?.message || String(e);
};

export const compact = (n) => (n == null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const ago = (iso) => {
  if (!iso) return 'Never analyzed';
  const h = Math.round((Date.now() - new Date(iso)) / 36e5);
  if (h < 1) return 'just now';
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
};

// ponytail: client-side score; move to indexer.py if anything else needs it
export const scoreOf = (s) => Math.max(6, Math.min(100, 100 - s.critical * 20 - s.high * 9 - s.redundant * 4 - s.unused * 3));

const FEAT = {
  key: 'Add a primary key', stats: 'Refresh planner statistics', vector: 'Index vector search', substring: 'Index substring search',
  words: 'Index full-text search', filter: 'Index lookups and sorting', drop: 'Drop index', extension: 'Install pg_trgm',
};
export const featLabel = (f) => FEAT[f] || f;

export const titleOf = (m) => {
  const c = m.column;
  if (m.feature === 'drop') {
    const name = m.id.slice(5);
    return m.status === 'unused' ? `${name} is never used` : m.status === 'redundant' ? `${name} is redundant` : `${name} is invalid`;
  }
  if (m.feature === 'vector' && m.priority === 'info') return `Other similarity metrics on ${c}`;
  return {
    key: 'This table has no primary key', stats: 'The planner has no statistics', extension: 'pg_trgm is not installed',
    vector: `Vector search on ${c} reads every row`, substring: `Substring search on ${c} has no trigram index`,
    words: `Full-text search on ${c} has no GIN index`, filter: `Lookups on ${c} scan the whole table`,
  }[m.feature] || featLabel(m.feature);
};

export const DIAG = ['Reading the catalog and index stats', 'Matching columns to existing indexes', 'Checking for invalid, duplicate and unused indexes', 'Matching your query patterns', 'Ranking fixes by impact'];

export const usageLists = (usage) => {
  const pick = (k) => Object.keys(usage).filter((c) => (usage[c] || []).includes(k));
  return { search: pick('search'), filter: pick('filter'), vector: pick('vector') };
};
