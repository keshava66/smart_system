import React, { useEffect, useMemo, useRef } from "react";

const PAGE_SIZES = [50, 100, 250, 500];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const Ico = ({ d, className = 'ico' }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>
);

// Text with the search hits marked. Exact hits get the red underline,
// typo hits (a letter or two off) the yellow one.
export function Highlight({ text, matcher }) {
  const s = text == null ? '' : String(text);
  const r = matcher && s ? matcher.ranges(s) : [];
  if (!r.length) return s;
  const parts = [];
  let last = 0;
  r.forEach(([a, b, d]) => {
    if (a > last) parts.push(s.slice(last, a));
    parts.push(<mark key={a} className={d ? 'fz' : undefined}>{s.slice(a, b)}</mark>);
    last = b;
  });
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// Records of one view: filter, hit-only and compact switches, sortable
// headers with hit counts, pager and "load more". The table state lives in
// the page (one entry per view) so it survives switching views.
export default function DataTable({
  columns, records, hits, matcher, valueCap, st, onChange,
  onOpenRecord, onOpenCell, flashCol, loadMore,
}) {
  const wrapRef = useRef(null);

  const hitCount = useMemo(() => {
    const out = Object.fromEntries(columns.map((c) => [c, 0]));
    if (matcher) records.forEach((r) => columns.forEach((c) => { if (matcher.test(String(r[c] ?? ''))) out[c]++; }));
    return out;
  }, [columns, records, matcher]);

  const anyHitCol = columns.some((c) => hitCount[c] > 0);
  const focusCols = !!st.focusCols && anyHitCol;

  const pastRows = useMemo(() => (hits || []).filter((h) => h === false).length, [hits]);

  const rows = useMemo(() => {
    let list = records.map((row, i) => ({ row, i }));
    const fq = st.filter.trim().toLowerCase();
    if (fq) list = list.filter(({ row }) => columns.some((c) => String(row[c] ?? '').toLowerCase().includes(fq)));
    if (st.onlyHits && matcher) list = list.filter(({ row }) => columns.some((c) => matcher.test(String(row[c] ?? ''))));
    if (st.sort) list = [...list].sort((a, b) => st.dir * collator.compare(String(a.row[st.sort] ?? ''), String(b.row[st.sort] ?? '')));
    return list;
  }, [records, columns, st.filter, st.onlyHits, st.sort, st.dir, matcher]);

  const pages = Math.max(1, Math.ceil(rows.length / st.size));
  const page = Math.min(st.page, pages - 1);
  const pageRows = rows.slice(page * st.size, page * st.size + st.size);
  const from = rows.length ? page * st.size + 1 : 0;
  const to = Math.min(rows.length, (page + 1) * st.size);

  useEffect(() => {
    if (!flashCol || !wrapRef.current) return;
    const th = wrapRef.current.querySelector(`th[data-c="${CSS.escape(flashCol)}"]`);
    th?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [flashCol]);

  const toggleSort = (c) => {
    if (st.sort !== c) onChange({ sort: c, dir: 1 });
    else if (st.dir === 1) onChange({ dir: -1 });
    else onChange({ sort: null, dir: 1 });
  };

  return (
    <>
      <div className="tools">
        <label className="fm-filter">
          <Ico d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-3.5-3.5" />
          <input value={st.filter} onChange={(e) => onChange({ filter: e.target.value, page: 0 })}
            placeholder="Filter these records" aria-label="Filter records" />
        </label>
        {matcher && (
          <label className="switch">
            <input type="checkbox" checked={st.onlyHits} onChange={(e) => onChange({ onlyHits: e.target.checked, page: 0 })} />
            Only rows with a highlighted hit
          </label>
        )}
        {matcher && (
          <label className="switch" title={anyHitCol ? 'Fade the columns that have no highlighted hit' : 'No column has a highlighted hit in these rows'}>
            <input type="checkbox" checked={!!st.focusCols} disabled={!anyHitCol} onChange={(e) => onChange({ focusCols: e.target.checked })} />
            Focus matching columns
          </label>
        )}
        <label className="switch">
          <input type="checkbox" checked={st.compact} onChange={(e) => onChange({ compact: e.target.checked })} />
          Compact rows
        </label>
        <span className="spacer" />
        <span className="tools-hint">Click a header to sort, a cell to see it in full</span>
      </div>

      {pastRows > 0 && (
        <p className="past-note"><i />
          <span>
            {pastRows} row{pastRows > 1 ? 's' : ''} matched on text Denodo didn&rsquo;t send back (it cuts values at {valueCap} characters).
            Use the open button on {pastRows > 1 ? 'those rows' : 'that row'} to see the full record.
          </span>
        </p>
      )}

      <div className={`tbl-wrap ${st.compact ? 'compact' : ''} ${focusCols ? 'dimcols' : ''}`} ref={wrapRef}>
        <table>
          <thead>
            <tr>
              <th className="lead" aria-label="Open record" />
              {columns.map((c) => {
                const sorted = st.sort === c;
                const cls = [hitCount[c] ? 'has' : '', sorted ? 'sorted' : '', sorted && st.dir < 0 ? 'desc' : '', flashCol === c ? 'col-flash' : '']
                  .filter(Boolean).join(' ');
                return (
                  <th key={c} data-c={c} className={cls || undefined}
                    aria-sort={sorted ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="sortb" onClick={() => toggleSort(c)} title={`Sort by ${c}`}>
                      <span className="th-name">{c}</span>
                      {hitCount[c] > 0 && <span className="hits" title={`${hitCount[c]} row${hitCount[c] > 1 ? 's' : ''} with a hit in this column`}>{hitCount[c]}</span>}
                      <Ico className="ico ar" d="m6 9 6 6 6-6" />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map(({ row, i }, k) => {
              const past = hits?.[i] === false;
              return (
                <tr key={i} className={past ? 'nohit' : undefined} style={{ animationDelay: `${Math.min(k, 20) * 16}ms` }}>
                  <td className="lead">
                    <button type="button" className={`rec-btn ${past ? 'past' : ''}`} onClick={() => onOpenRecord(i)}
                      title={past ? 'The match is past the text Denodo shows here. Open the full record to see it.' : 'Open the full record'}
                      aria-label="Open the full record">
                      <Ico d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6v6M10 14 20 4" />
                    </button>
                  </td>
                  {columns.map((c) => {
                    const t = row[c] == null ? '' : String(row[c]);
                    const cut = !!valueCap && t.length >= valueCap;
                    return (
                      <td key={c} className={[hitCount[c] ? 'has' : '', flashCol === c ? 'col-flash' : ''].filter(Boolean).join(' ') || undefined}
                        title={t ? (t.length > 300 ? `${t.slice(0, 300)}...` : t) : undefined}
                        onClick={() => { if (t) onOpenCell(c, t); }}>
                        <Highlight text={t} matcher={matcher} />
                        {cut && <span className="cut">[...]</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!pageRows.length && (
              <tr><td colSpan={columns.length + 1} className="rail-empty">No rows match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>
          {from.toLocaleString()}&ndash;{to.toLocaleString()} of {rows.length.toLocaleString()}
          {rows.length !== records.length && ` (filtered from ${records.length.toLocaleString()})`}
        </span>
        <div className="ctl">
          <label>Rows{' '}
            <select value={st.size} onChange={(e) => onChange({ size: Number(e.target.value), page: 0 })}>
              {PAGE_SIZES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => onChange({ page: page - 1 })}>
            <Ico d="M15 6l-6 6 6 6" />
          </button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onChange({ page: page + 1 })}>
            <Ico d="M9 6l6 6-6 6" />
          </button>
        </div>
      </div>

      {loadMore && loadMore.remaining > 0 && (
        <div className="loadmore">
          <button type="button" className="btn" disabled={loadMore.busy} onClick={loadMore.onClick}>
            {loadMore.busy
              ? <><span className="spin" />Loading rows</>
              : <><Ico d="M12 4v12m-5-5 5 5 5-5M5 20h14" />Load {loadMore.started ? 'next ' : ''}{loadMore.next.toLocaleString()} rows</>}
          </button>
          <span>
            {loadMore.started
              ? `${records.length.toLocaleString()} of ${loadMore.totalLabel} loaded`
              : `The search shows ${loadMore.perView} rows per view. This reads the rest straight from the view.`}
          </span>
          {loadMore.err && <span className="lm-err" role="alert">{loadMore.err}</span>}
        </div>
      )}
    </>
  );
}