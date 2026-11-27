"""RIMDocs Ingestion tab on the Unstructured Explorer.

Shows which documents in prd_raw_rimdocs_core.rimdocs_palm_pah_dt made it into
a rimdocs_extracts_core.doc_chunks* table. A document counts as ingested when
<r_object_id>.pdf is a file_name in the chosen chunks table.

The match query runs once per source scope (chunks table, product codes,
combined-code matching, latest-only) and the document rows are kept in memory
for CACHE_TTL. Every chart, breakdown, page and CSV is cut from that copy, so
flipping filters or tabs never goes back to Postgres.

Uses the shared 'postgres_query_runner' section of dq_config.json, database
'regulatory', same as epod.py / nipo.py.
"""
from __future__ import annotations

import csv
import io
import logging
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from auth import require_permission
from postgres_query_runner import PgConnectionPool

logger = logging.getLogger(__name__)

rim_ingestion_router = APIRouter(prefix="/api/rim-ingestion", tags=["RIMDocs Ingestion"])

DATABASE = "regulatory"
DOCS_SCHEMA, DOCS_TABLE = "prd_raw_rimdocs_core", "rimdocs_palm_pah_dt"
CHUNKS_SCHEMA = "rimdocs_extracts_core"
DEFAULT_CHUNKS_TABLE = "doc_chunks_clinical_immbot_second_new"

INGESTED, NOT_INGESTED = "Ingested", "Not ingested"
STATUSES = (INGESTED, NOT_INGESTED)
BLANK = "(blank)"

TOP_N = 25
MAX_PAGE_SIZE = 250
MAX_CODES = 500
CACHE_TTL = 600          # document rows per scope
SOURCES_TTL = 3600       # chunk table list + product codes
CACHE_MAX_SCOPES = 8
STATEMENT_TIMEOUT_MS = 300_000

# Facets picked on the page, applied to the cached rows.
VIEW_FILTERS = {"status": "ingestion_status", "approval": "a_status", "object_type": "r_object_type", "domain": "domain"}

BREAKDOWN_COLUMNS = {
    "product_code": "Product", "a_status": "Approval status", "domain": "Domain",
    "r_object_type": "Object type", "r_version_label": "Version label", "region": "Region",
    "country": "Country", "a_content_type": "Content type",
}

ROW_COLUMNS = [
    "product_code", "r_object_id", "edms_number", "object_name", "a_status", "r_object_type",
    "domain", "r_version_label", "approved_date", "chunk_count", "ingestion_status",
]
SEARCH_COLUMNS = ("r_object_id", "edms_number", "object_name")
TEXT_COLUMNS = ("product_code", "r_object_id", "edms_number", "object_name", "r_object_type", "a_status",
                "domain", "region", "country", "r_version_label", "a_content_type")

_config: Optional[Dict[str, Any]] = None


def set_rim_ingestion_dependencies(config: Optional[Dict[str, Any]]):
    """Called once from app.py with the 'postgres_query_runner' config section."""
    global _config
    _config = config
    if not _config:
        logger.warning("postgres_query_runner config not found - RIMDocs Ingestion endpoints will be unavailable")


def _connect():
    import psycopg2

    if not _config or not _config.get("host"):
        raise HTTPException(status_code=503, detail="RIMDocs Ingestion isn't configured: no 'postgres_query_runner' section in dq_config.json.")
    try:
        return psycopg2.connect(
            host=_config.get("host"),
            port=int(_config.get("port") or 5432),
            user=_config.get("user"),
            password=_config.get("password") or "",
            dbname=DATABASE,
            sslmode=_config.get("sslmode") or "prefer",
            connect_timeout=int(_config.get("connect_timeout_seconds") or 10),
            application_name="dqe_rim_ingestion",
            options=f"-c statement_timeout={STATEMENT_TIMEOUT_MS} -c default_transaction_read_only=on",
        )
    except Exception as e:
        logger.error(f"RIMDocs Ingestion connection failed: {e}")
        raise HTTPException(status_code=502, detail="Could not connect to the data source. Please try again later.")


_pool = PgConnectionPool(_connect, "RIM_INGESTION")


def _run(query, params=None) -> Tuple[List[str], List[tuple]]:
    try:
        return _pool.run(query, params)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"RIMDocs Ingestion query failed: {e}")
        raise HTTPException(status_code=502, detail="The ingestion query failed. Please try again.")


# ============================================================================
# Cache
# ============================================================================

_cache: Dict[Any, Tuple[float, Any]] = {}
_cache_guard = threading.Lock()
_load_locks: Dict[Any, threading.Lock] = {}


def _cached(key, ttl: float, load, refresh: bool = False):
    """TTL cache with one loader per key, so the page's parallel requests for
    the same scope share a single Postgres round trip."""
    asked = time.monotonic()
    with _cache_guard:
        hit = _cache.get(key)
        if hit and not refresh and asked - hit[0] < ttl:
            return hit[1]
        lock = _load_locks.setdefault(key, threading.Lock())
    with lock:
        with _cache_guard:
            hit = _cache.get(key)
            # another request loaded it while we waited for the lock
            if hit and (hit[0] >= asked or (not refresh and time.monotonic() - hit[0] < ttl)):
                return hit[1]
        value = load()
        with _cache_guard:
            _cache[key] = (time.monotonic(), value)
            scopes = [k for k in _cache if k[0] == "docs"]
            if len(scopes) > CACHE_MAX_SCOPES:
                oldest = min(scopes, key=lambda k: _cache[k][0])
                _cache.pop(oldest, None)
                _load_locks.pop(oldest, None)
        return value


# ============================================================================
# Source data
# ============================================================================

def _load_sources() -> Dict[str, Any]:
    from psycopg2 import sql

    _, tables = _run(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = %s AND table_name LIKE 'doc\\_chunks%%' ORDER BY table_name",
        [CHUNKS_SCHEMA],
    )
    _, codes = _run(sql.SQL(
        "SELECT DISTINCT product_code FROM {} WHERE product_code IS NOT NULL ORDER BY 1"
    ).format(sql.Identifier(DOCS_SCHEMA, DOCS_TABLE)))
    names = [t[0] for t in tables]
    return {
        "database": DATABASE,
        "docs_table": f"{DOCS_SCHEMA}.{DOCS_TABLE}",
        "chunks_schema": CHUNKS_SCHEMA,
        "chunk_tables": names,
        "default_chunks_table": DEFAULT_CHUNKS_TABLE if DEFAULT_CHUNKS_TABLE in names else (names[0] if names else None),
        "product_codes": [c[0] for c in codes],
    }


def _sources(refresh: bool = False) -> Dict[str, Any]:
    return _cached(("sources",), SOURCES_TTL, _load_sources, refresh)


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _iso_date(value) -> Optional[str]:
    """Some rows carry 0001-01-01 as a placeholder: those count as no date."""
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date) and value.year >= 1900:
        return value.isoformat()
    return None


def _load_docs(chunks_table: str, codes: Tuple[str, ...], match_inside: bool, latest_only: bool) -> Dict[str, Any]:
    from psycopg2 import sql

    where, params = [], []
    if codes:
        if match_inside:
            where.append("AND product_code ILIKE ANY(%s)")
            params.append([f"%{_like_escape(c)}%" for c in codes])
        else:
            where.append("AND product_code = ANY(%s)")
            params.append(list(codes))
    if latest_only:
        where.append("AND i_latest_flag = 1")

    # One row per product + document. Chunks are counted per file first so the
    # join can't multiply document rows.
    query = sql.SQL("""
        WITH docs AS (
            SELECT DISTINCT ON (product_code, r_object_id)
                   product_code, r_object_id, edms_number, object_name, r_object_type,
                   a_status, domain, region, country, r_version_label, a_content_type, approved_date
            FROM {docs}
            WHERE r_object_id IS NOT NULL {where}
            ORDER BY product_code, r_object_id, approved_date DESC NULLS LAST
        ),
        chunks AS (
            SELECT file_name, COUNT(*) AS chunk_count
            FROM {chunks}
            GROUP BY file_name
        )
        SELECT d.*, COALESCE(c.chunk_count, 0) AS chunk_count, c.file_name IS NOT NULL AS ingested
        FROM docs d
        LEFT JOIN chunks c ON c.file_name = d.r_object_id || '.pdf'
    """).format(
        docs=sql.Identifier(DOCS_SCHEMA, DOCS_TABLE),
        chunks=sql.Identifier(CHUNKS_SCHEMA, chunks_table),
        where=sql.SQL(" ".join(where)),
    )
    cols, raw = _run(query, params)
    rows = []
    for r in raw:
        rec = dict(zip(cols, r))
        for k in TEXT_COLUMNS:
            rec[k] = None if rec[k] is None else str(rec[k])
        rec["approved_date"] = _iso_date(rec["approved_date"])
        rec["chunk_count"] = int(rec["chunk_count"] or 0)
        rec["ingestion_status"] = INGESTED if rec.pop("ingested") else NOT_INGESTED
        rows.append(rec)
    return {"rows": rows, "loaded_at": datetime.now(timezone.utc).isoformat()}


# ============================================================================
# Scope (query params shared by every data endpoint)
# ============================================================================

class Scope:
    def __init__(self, chunks_table, codes, match_inside, latest_only, picks):
        self.chunks_table = chunks_table
        self.codes = codes
        self.match_inside = match_inside
        self.latest_only = latest_only
        self.picks = picks

    @property
    def key(self):
        return ("docs", self.chunks_table, self.codes, self.match_inside, self.latest_only)


def scope_params(
    chunks_table: Optional[str] = Query(None, max_length=128),
    codes: List[str] = Query([]),
    match_inside: bool = Query(True),
    latest_only: bool = Query(False),
    status: List[str] = Query([]),
    approval: List[str] = Query([]),
    object_type: List[str] = Query([]),
    domain: List[str] = Query([]),
) -> Scope:
    if len(codes) > MAX_CODES:
        raise HTTPException(status_code=422, detail=f"Pick at most {MAX_CODES} product codes.")
    sources = _sources()
    tables = sources["chunk_tables"]
    if not tables:
        raise HTTPException(status_code=503, detail=f"No doc_chunks tables found in {CHUNKS_SCHEMA}.")
    table = chunks_table or sources["default_chunks_table"]
    if table not in tables:
        raise HTTPException(status_code=422, detail=f"Unknown chunks table '{chunks_table}'.")
    picks = {VIEW_FILTERS[k]: set(v) for k, v in
             (("status", status), ("approval", approval), ("object_type", object_type), ("domain", domain)) if v}
    return Scope(table, tuple(sorted(set(codes))), match_inside, latest_only, picks)


def _docs(scope: Scope, refresh: bool = False) -> Dict[str, Any]:
    return _cached(scope.key, CACHE_TTL,
                   lambda: _load_docs(scope.chunks_table, scope.codes, scope.match_inside, scope.latest_only), refresh)


# ============================================================================
# Aggregation (pure, over the cached rows)
# ============================================================================

def apply_picks(rows: Iterable[dict], picks: Dict[str, set]) -> List[dict]:
    if not picks:
        return list(rows)
    return [r for r in rows if all(r.get(col) in vals for col, vals in picks.items())]


def unique_docs(rows: Iterable[dict]) -> List[dict]:
    seen, out = set(), []
    for r in rows:
        if r["r_object_id"] not in seen:
            seen.add(r["r_object_id"])
            out.append(r)
    return out


def kpis(rows: List[dict]) -> Dict[str, Any]:
    docs = unique_docs(rows)
    total = len(docs)
    ingested = sum(1 for d in docs if d["ingestion_status"] == INGESTED)
    return {
        "documents": total,
        "ingested": ingested,
        "not_ingested": total - ingested,
        "rate": ingested / total if total else 0.0,
        "chunks": sum(d["chunk_count"] for d in docs),
    }


def _per_value(rows: Iterable[dict], key) -> Dict[str, Dict[str, dict]]:
    """value -> r_object_id -> row, so each document counts once per value."""
    out: Dict[str, Dict[str, dict]] = defaultdict(dict)
    for r in rows:
        v = key(r)
        if v is None:
            continue
        out[v].setdefault(r["r_object_id"], r)
    return out


def summary_table(rows: Iterable[dict], by: str) -> List[Dict[str, Any]]:
    out = []
    for value, docs in _per_value(rows, lambda r: r.get(by) or BLANK).items():
        n = len(docs)
        ing = sum(1 for d in docs.values() if d["ingestion_status"] == INGESTED)
        out.append({
            "value": value, "documents": n, "ingested": ing, "not_ingested": n - ing,
            "ingested_pct": ing / n * 100 if n else 0.0,
            "chunks": sum(d["chunk_count"] for d in docs.values()),
        })
    out.sort(key=lambda r: (-r["documents"], r["value"]))
    return out


def by_year(rows: List[dict]) -> Dict[str, Any]:
    per = _per_value(rows, lambda r: r["approved_date"][:4] if r["approved_date"] else None)
    dated = {oid for docs in per.values() for oid in docs}
    out = []
    for year in sorted(per):
        docs = per[year].values()
        ing = sum(1 for d in docs if d["ingestion_status"] == INGESTED)
        out.append({"year": int(year), "ingested": ing, "not_ingested": len(per[year]) - ing})
    return {"rows": out, "undated": len({r["r_object_id"] for r in rows} - dated)}


def facet_options(rows: List[dict], column: str) -> List[Dict[str, Any]]:
    counts = Counter()
    for value, docs in _per_value(rows, lambda r: r.get(column)).items():
        counts[value] = len(docs)
    return [{"value": v, "count": c} for v, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def search_rows(rows: List[dict], term: str) -> List[dict]:
    t = term.strip().lower()
    if not t:
        return rows
    return [r for r in rows if any(t in (r.get(c) or "").lower() for c in SEARCH_COLUMNS)]


def sort_rows(rows: List[dict], col: str, desc: bool) -> List[dict]:
    present = [r for r in rows if r.get(col) is not None]
    missing = [r for r in rows if r.get(col) is None]
    key = (lambda r: r[col]) if col == "chunk_count" else (lambda r: str(r[col]).lower())
    return sorted(present, key=key, reverse=desc) + missing


# ============================================================================
# Endpoints
# ============================================================================

@rim_ingestion_router.get("/sources")
def rim_ingestion_sources(refresh: bool = Query(False)):
    """Chunk tables to pick from and every product code, for the source panel."""
    return _sources(refresh)


@rim_ingestion_router.get("/dashboard")
def rim_ingestion_dashboard(scope: Scope = Depends(scope_params), refresh: bool = Query(False)):
    """Everything the Overview tab draws, in one response."""
    data = _docs(scope, refresh)
    rows = data["rows"]
    view = apply_picks(rows, scope.picks)
    products = summary_table(view, "product_code")
    return {
        "loaded_at": data["loaded_at"],
        "source": {"database": DATABASE, "docs_table": f"{DOCS_SCHEMA}.{DOCS_TABLE}",
                   "chunks_table": f"{CHUNKS_SCHEMA}.{scope.chunks_table}"},
        "scope_rows": len(rows),
        "scope_documents": len({r["r_object_id"] for r in rows}),
        "options": {
            "status": facet_options(rows, "ingestion_status"),
            "approval": facet_options(rows, "a_status"),
            "object_type": facet_options(rows, "r_object_type"),
            "domain": facet_options(rows, "domain"),
        },
        "kpis": kpis(view),
        # the coverage split ignores the status pick, so picking a side highlights it instead of zeroing the other
        "flow": kpis(apply_picks(rows, {c: v for c, v in scope.picks.items() if c != "ingestion_status"})),
        "by_product": {"rows": products[:TOP_N], "distinct": len(products)},
        "by_year": by_year(view),
    }


@rim_ingestion_router.get("/breakdown")
def rim_ingestion_breakdown(
    scope: Scope = Depends(scope_params),
    by: str = Query("product_code"),
):
    if by not in BREAKDOWN_COLUMNS:
        raise HTTPException(status_code=422, detail=f"Can't break down by '{by}'.")
    view = apply_picks(_docs(scope)["rows"], scope.picks)
    rows = summary_table(view, by)
    return {"by": by, "label": BREAKDOWN_COLUMNS[by], "rows": rows, "distinct": len(rows), "top_n": TOP_N}


def _table_rows(scope: Scope, search: str, sort_col: str, sort_dir: str) -> List[dict]:
    if sort_col not in ROW_COLUMNS:
        raise HTTPException(status_code=422, detail=f"Can't sort by '{sort_col}'.")
    rows = search_rows(apply_picks(_docs(scope)["rows"], scope.picks), search)
    return sort_rows(rows, sort_col, sort_dir == "desc")


@rim_ingestion_router.get("/rows")
def rim_ingestion_rows(
    scope: Scope = Depends(scope_params),
    search: str = Query("", max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    sort_col: str = Query("product_code"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
):
    rows = _table_rows(scope, search, sort_col, sort_dir)
    total = len(rows)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, total_pages)
    start = (page - 1) * page_size
    return {
        "rows": [{c: r.get(c) for c in ROW_COLUMNS} for r in rows[start:start + page_size]],
        "total": total, "page": page, "page_size": page_size, "total_pages": total_pages,
    }


@rim_ingestion_router.get("/rows/download", dependencies=[Depends(require_permission("downloadUnstructuredData"))])
def rim_ingestion_download(
    scope: Scope = Depends(scope_params),
    search: str = Query("", max_length=200),
    sort_col: str = Query("product_code"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
):
    """Every matching row as CSV, not just the page on screen."""
    rows = _table_rows(scope, search, sort_col, sort_dir)

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(ROW_COLUMNS)
        for i, r in enumerate(rows, 1):
            writer.writerow(["" if r.get(c) is None else r[c] for c in ROW_COLUMNS])
            if i % 5000 == 0:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    return StreamingResponse(
        generate(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="rimdocs_ingestion_{stamp}.csv"'},
    )
