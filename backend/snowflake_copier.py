"""
Data Studio (Snowflake) Table Copier: copies a table, a list of tables or a
whole schema, by CLONE, INSERT ... SELECT, or row by row through this process
when the read and write logins can't see each other's side. Runs as background
jobs with a live log stream. Connections, config and permissions come from
snowflake_query_runner.py.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import snowflake_query_runner as core
from snowflake_query_runner import (
    PERM_COPY, READ_PROFILE, WRITE_PROFILE, _Cancelled, _apply_statement_timeout,
    _cache_get, _cache_set, _cancel_session_queries, _doom, _drop_table_cache, _executor, _fetch_columns,
    _fetch_schema_columns, _looks_stale, _meta_http_error, _object_ddl, _pooled, _profile_label, _quiet_close,
    _require, _require_config, _run_meta, _write_configured, logger, sf_auth,
)
from snowflake_sql import qualified, quote_ident

copy_router = APIRouter(prefix="/api/snowflake", tags=["Data Studio - Snowflake"])


COPY_CHUNK_TARGET_ROWS = 2_000_000      # aim for roughly this many rows per INSERT chunk
COPY_INSERT_CHUNK_THRESHOLD = 750_000   # below this, one INSERT beats splitting it up
MAX_CHUNKS_PER_TABLE = 8                # cap on how many chunks one table gets split into
MAX_PARALLEL_COPY_UNITS = 12            # global cap on concurrent chunks/clones for one job
MAX_TABLES_PER_SCHEMA_COPY = 200        # a schema copy bigger than this needs to be split by hand
COPY_JOB_TTL_SECONDS = 2 * 60 * 60      # copy jobs stick around longer than query jobs

# Copy units run in phases. Everything that reads from the source is phase 1 and
# runs in parallel; anything that reads from the target - a recreated view -
# waits for phase 1 to finish, whatever kind of copy job it belongs to.
COPY_PHASE_DATA = 1
COPY_PHASE_VIEWS = 2
TRANSFER_BATCH_ROWS = 10_000            # rows per round trip when a copy has to go through the API
TRANSFER_MAX_BINDS = 16_000             # Snowflake's own ceiling on bind variables in one statement
TRANSFER_MAX_ROWS = 5_000_000           # refuse a through-the-API copy bigger than this

_copy_jobs: Dict[str, Dict[str, Any]] = {}
_copy_jobs_lock = threading.Lock()
_copy_chunk_slots = threading.Semaphore(MAX_PARALLEL_COPY_UNITS)


class CopyRequest(BaseModel):
    copy_type: str                      # "table" | "tables" | "schema"
    mode: str                           # "clone" | "insert"
    if_exists: str = "fail"             # "fail" | "overwrite" | "append"
    source_database: str
    source_schema: str
    source_table: Optional[str] = None  # required when copy_type == "table"
    source_tables: Optional[List[str]] = None   # required when copy_type == "tables"
    target_database: str
    target_schema: str
    target_table: Optional[str] = None  # table copy only; defaults to source_table
    parallelism: Optional[int] = None   # caller-requested chunk count cap, insert mode only
    confirm: bool = False


def _copy_touch(job: Dict[str, Any]):
    """Wake anyone watching this job. The stream sleeps on this rather than on
    a clock, so a log line reaches the screen the moment it is written."""
    job["updated_at"] = time.time()
    pulse = job.get("pulse")
    if pulse is not None:
        pulse.set()


def _copy_log(job: Dict[str, Any], level: str, message: str):
    with job["lock"]:
        job["logs"].append({"ts": time.time(), "level": level, "message": message})
        if len(job["logs"]) > 1000:
            job["logs"] = job["logs"][-1000:]
    _copy_touch(job)


def _plan_chunks(est_rows: Optional[int], requested: Optional[int]) -> int:
    if not est_rows or est_rows <= COPY_INSERT_CHUNK_THRESHOLD:
        return 1
    n = -(-est_rows // COPY_CHUNK_TARGET_ROWS)  # ceil division
    n = max(2, min(n, MAX_CHUNKS_PER_TABLE))
    if requested:
        n = max(1, min(n, max(1, int(requested))))
    return n


def _enumerate_source_tables(database: str, schema: str) -> List[Dict[str, Any]]:
    """Everything in the schema that can be copied - tables and views alike.

    Tables come first so that a view recreated in the target has something to
    point at; external tables are left out, there being nothing to copy."""
    def read(cur):
        cur.execute(
            f"""
            SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT
            FROM {quote_ident(database)}.INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW', 'MATERIALIZED VIEW')
            ORDER BY TABLE_NAME
            """,
            (schema,),
        )
        rows = []
        for name, table_type, row_count in cur.fetchall():
            upper = (table_type or "").upper()
            if "VIEW" in upper:
                kind = "materialized_view" if "MATERIALIZED" in upper else "view"
            else:
                kind = "table"
            rows.append({
                "name": name, "kind": kind,
                "est_rows": int(row_count) if row_count is not None else 0,
            })
        rows.sort(key=lambda r: (r["kind"] != "table", r["name"]))
        return rows

    try:
        return _run_meta(read)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, f"tables in {database}.{schema}")


def _source_object(database: str, schema: str, name: str) -> Dict[str, Any]:
    """What the copy source actually is, and how big it is.

    A view has no ROW_COUNT and cannot be built with CREATE TABLE ... LIKE, so
    the plan needs to know which it is dealing with before it writes any SQL.

    Cached, because a hand-picked copy of 70 objects looks each one up, and the
    preview and the confirmed start both build the same plan."""
    cache_key = f"sf-srcobj:{database}:{schema}:{name}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    def read(cur):
        cur.execute(
            f"""
            SELECT TABLE_TYPE, ROW_COUNT FROM {quote_ident(database)}.INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            """,
            (schema, name),
        )
        return cur.fetchone()

    try:
        row = _run_meta(read)
    except Exception as e:
        logger.info("Source lookup skipped for %s.%s.%s: %s", database, schema, name, e)
        return {"kind": "table", "est_rows": None}

    if not row:
        return {"kind": "table", "est_rows": None}
    table_type = (row[0] or "").upper()
    kind = "table"
    if "VIEW" in table_type:
        kind = "materialized_view" if "MATERIALIZED" in table_type else "view"
    elif "EXTERNAL" in table_type:
        kind = "external_table"
    payload = {"kind": kind, "est_rows": int(row[1]) if row[1] is not None else None}
    _cache_set(cache_key, payload)
    return payload


def _table_row_estimate(database: str, schema: str, table: str) -> Optional[int]:
    return _source_object(database, schema, table)["est_rows"]


# ============================================================================
# Cross-profile copies
#
# The normal copy is one statement - INSERT INTO target SELECT FROM source -
# run by a single login that can see both sides. When reads and writes are two
# different logins, that statement cannot exist: whichever session runs it is
# blind to one half. Those copies go row by row through this process instead,
# read with one connection and inserted with the other.
#
# It is slower than anything Snowflake does internally, so it is only used when
# the write login genuinely cannot see the source - which is checked, not
# assumed.
# ============================================================================

_JSON_TYPES = {"VARIANT", "OBJECT", "ARRAY", "MAP"}
_BINARY_TYPES = {"BINARY", "VARBINARY"}
_GEO_TYPES = {"GEOGRAPHY", "GEOMETRY"}


def _writer_profile() -> str:
    """Whichever login owns the target. With no write profile configured that
    is the only login there is, which is how this always worked."""
    return WRITE_PROFILE if _write_configured() else READ_PROFILE


def _write_can_read(database: str, schema: str, table: Optional[str]) -> bool:
    """Can the write login see the source? A cross-profile copy is expensive,
    so it is worth one cheap DESCRIBE to find out whether it is needed."""
    if not _write_configured():
        return True
    target = (f"{quote_ident(database)}.{quote_ident(schema)}.{quote_ident(table)}" if table
              else f"{quote_ident(database)}.{quote_ident(schema)}")
    what = "TABLE" if table else "SCHEMA"

    # The preview and the confirmed start both plan the same copy, so without
    # this the probe runs twice for every job.
    cache_key = f"sf-writeread:{database}:{schema}:{table or ''}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return bool(cached)

    def probe(cur):
        cur.execute(f"DESCRIBE {what} {target}")
        cur.fetchone()
        return True

    try:
        allowed = bool(_run_meta(probe, WRITE_PROFILE))
    except Exception as e:
        logger.info("Write profile cannot read %s %s (%s) - copying through the API", what.lower(), target, e)
        allowed = False
    _cache_set(cache_key, allowed)
    return allowed


def _column_type_sql(col: Dict[str, Any]) -> str:
    """The column's type as it has to be written into a CREATE TABLE.

    CREATE TABLE ... LIKE would do this for us, but it needs one role that can
    see both tables, which is exactly what we do not have here."""
    data_type = (col.get("data_type") or "").upper()
    char_len = col.get("char_length")
    precision = col.get("precision")
    scale = col.get("scale")

    if data_type in ("TEXT", "VARCHAR", "STRING", "CHAR", "CHARACTER"):
        return f"VARCHAR({int(char_len)})" if char_len else "VARCHAR"
    if data_type in _BINARY_TYPES:
        return f"BINARY({int(char_len)})" if char_len else "BINARY"
    if data_type in ("NUMBER", "DECIMAL", "NUMERIC"):
        if precision is not None:
            return f"NUMBER({int(precision)},{int(scale or 0)})"
        return "NUMBER"
    if data_type in ("FLOAT", "FLOAT4", "FLOAT8", "DOUBLE", "REAL"):
        return "FLOAT"
    return data_type or "VARCHAR"


def _create_table_sql(tgt_q: str, columns: List[Dict[str, Any]], if_exists: str) -> str:
    verb = "CREATE OR REPLACE TABLE" if if_exists == "overwrite" else "CREATE TABLE"
    body = ",\n  ".join(
        f"{quote_ident(c['name'])} {_column_type_sql(c)}" + ("" if c.get("nullable", True) else " NOT NULL")
        for c in columns
    )
    return f"{verb} {tgt_q} (\n  {body}\n)"


def _transfer_expressions(columns: List[Dict[str, Any]]):
    """How each column leaves the source and how it goes back in.

    Most types survive the round trip as plain Python values. The ones that do
    not - semi-structured, binary and geospatial - travel as text and are
    rebuilt on the way in, which needs a function call around the bind.

    Returns (select_parts, rebuild_parts, needs_rebuild). `rebuild_parts` are
    written against the pseudo-columns of a VALUES clause (column1, column2...),
    because Snowflake does not accept function calls inside VALUES itself - the
    documented way round it is INSERT ... SELECT ... FROM VALUES."""
    select_parts, rebuild_parts = [], []
    needs_rebuild = False
    for i, col in enumerate(columns, start=1):
        name = quote_ident(col["name"])
        slot = f"column{i}"
        data_type = (col.get("data_type") or "").upper()
        if data_type in _JSON_TYPES:
            select_parts.append(f"TO_JSON({name})")
            rebuild_parts.append(f"PARSE_JSON({slot})")
            needs_rebuild = True
        elif data_type in _BINARY_TYPES:
            select_parts.append(f"HEX_ENCODE({name})")
            rebuild_parts.append(f"TO_BINARY({slot}, 'HEX')")
            needs_rebuild = True
        elif data_type == "GEOGRAPHY":
            select_parts.append(f"ST_ASWKT({name})")
            rebuild_parts.append(f"TO_GEOGRAPHY({slot})")
            needs_rebuild = True
        elif data_type == "GEOMETRY":
            select_parts.append(f"ST_ASWKT({name})")
            rebuild_parts.append(f"TO_GEOMETRY({slot})")
            needs_rebuild = True
        else:
            select_parts.append(name)
            rebuild_parts.append(slot)
    return select_parts, rebuild_parts, needs_rebuild


def _transfer_batch_rows(column_count: int, needs_rebuild: bool) -> int:
    """How many rows can go in one INSERT.

    Every value in the batch is a bind variable and Snowflake refuses a
    statement with more than ~16k of them, so a wide table takes fewer rows per
    round trip. A batch that has to be rebuilt column by column also makes a
    much longer statement, so it goes in smaller mouthfuls again."""
    ceiling = TRANSFER_BATCH_ROWS // 5 if needs_rebuild else TRANSFER_BATCH_ROWS
    return max(1, min(ceiling, TRANSFER_MAX_BINDS // max(1, column_count)))


def _transfer_unit(src_db, src_schema, src_table, tgt_db, tgt_schema, tgt_table,
                    est_rows, if_exists, columns=None) -> tuple:
    """Prep steps plus the single streaming unit for one cross-profile table."""
    columns = columns or _fetch_columns(src_db, src_schema, src_table, profile=READ_PROFILE)
    if not columns:
        raise HTTPException(status_code=404, detail=f"{src_schema}.{src_table} has no columns to copy")
    if est_rows and est_rows > TRANSFER_MAX_ROWS:
        raise HTTPException(
            status_code=400,
            detail=(f"{src_schema}.{src_table} has about {est_rows:,} rows. A copy between two different "
                    f"Snowflake logins goes through this API row by row, and that is capped at "
                    f"{TRANSFER_MAX_ROWS:,}. Either grant the write role read access on the source so "
                    f"Snowflake can do it internally, or copy the table in parts."),
        )

    src_q = qualified(src_db, src_schema, src_table)
    tgt_q = qualified(tgt_db, tgt_schema, tgt_table)
    select_parts, rebuild_parts, needs_rebuild = _transfer_expressions(columns)
    column_list = ", ".join(quote_ident(c["name"]) for c in columns)

    prep_steps: List[tuple] = []
    if if_exists in ("fail", "overwrite"):
        prep_steps.append((_create_table_sql(tgt_q, columns, if_exists), None,
                            f"Create structure for {tgt_schema}.{tgt_table} from the source columns"))

    unit = {
        "table": src_table, "target": tgt_table, "kind": "transfer_table",
        "sql": None, "params": None,
        "label": f"Transfer {src_schema}.{src_table} \u2192 {tgt_schema}.{tgt_table}",
        "source_database": src_db, "source_schema": src_schema,
        "target_database": tgt_db, "target_schema": tgt_schema,
        "select_sql": f"SELECT {', '.join(select_parts)} FROM {src_q}",
        "insert_prefix": (
            f"INSERT INTO {tgt_q} ({column_list}) SELECT {', '.join(rebuild_parts)} FROM VALUES "
            if needs_rebuild else
            f"INSERT INTO {tgt_q} ({column_list}) VALUES "
        ),
        "column_count": len(columns),
        "batch_rows": _transfer_batch_rows(len(columns), needs_rebuild),
        "est_rows": est_rows or 0,
    }
    return prep_steps, [unit]


# ============================================================================
# Recreating a view in another schema
#
# The view is taken as it is written - GET_DDL - and every reference to the
# source schema is pointed at the target one before it is run there. What it
# selects from has to exist in the target schema; if it does not, Snowflake
# says so and that error is what the job reports.
# ============================================================================

_IDENT = r'(?:"[^"]*"|[A-Za-z_][\w$]*)'
_QUALIFIED = rf'(?:{_IDENT}\s*\.\s*){{0,2}}{_IDENT}'

_VIEW_HEADER = re.compile(
    rf'''^\s*create\s+(?:or\s+replace\s+)?
         (?P<props>(?:secure\s+|recursive\s+|temporary\s+|temp\s+|volatile\s+)*)
         view\s+(?:if\s+not\s+exists\s+)?
         (?P<name>{_QUALIFIED})''',
    re.I | re.X,
)


# Snowflake stores a view's text as written, so whatever quoting goes in is
# what everyone reads back out of GET_DDL forever. A plain uppercase name needs
# no quotes and looks like the original did.
_BARE_IDENT = re.compile(r"^[A-Z_][A-Z0-9_$]*$")

# Quoting these would change nothing, but leaving them bare would break the
# statement, so they keep their quotes.
_RESERVED_IDENTS = {
    "ALL", "ALTER", "AND", "ANY", "AS", "BETWEEN", "BY", "CASE", "CAST", "CHECK", "COLUMN",
    "CONNECT", "CREATE", "CROSS", "CURRENT", "DELETE", "DISTINCT", "DROP", "ELSE", "EXISTS",
    "FALSE", "FOLLOWING", "FOR", "FROM", "FULL", "GRANT", "GROUP", "HAVING", "IN", "INNER",
    "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "LATERAL", "LEFT", "LIKE", "NATURAL", "NOT",
    "NULL", "OF", "ON", "OR", "ORDER", "QUALIFY", "REVOKE", "RIGHT", "ROW", "ROWS", "SAMPLE",
    "SELECT", "SET", "SOME", "START", "TABLE", "TABLESAMPLE", "THEN", "TO", "TRIGGER", "TRUE",
    "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "WHEN", "WHENEVER", "WHERE", "WITH",
}


def _ddl_ident(name: str) -> str:
    """An identifier for text that gets stored and read back.

    Bare when it is a plain uppercase name - which is how Snowflake writes its
    own DDL - and quoted when the quotes actually carry meaning."""
    text = str(name or "")
    if _BARE_IDENT.match(text) and text not in _RESERVED_IDENTS:
        return text
    return quote_ident(text)


def _ddl_qualified(database: str, schema: str, name: str) -> str:
    return f"{_ddl_ident(database)}.{_ddl_ident(schema)}.{_ddl_ident(name)}"


def _ident_pattern(name: str) -> str:
    """Matches an identifier however the DDL happens to spell it - bare or
    double-quoted. Snowflake writes them unquoted and upper-cased, but a view
    created from quoted names keeps the quotes."""
    return f'(?:{re.escape(chr(34) + name + chr(34))}|{re.escape(name)})'


def _retarget_view_ddl(ddl: str, src_db: str, src_schema: str, src_name: str,
                        tgt_db: str, tgt_schema: str, tgt_name: str, if_exists: str):
    """Point a view's DDL at the target schema. Returns (sql, references_rewritten)."""
    body = (ddl or "").strip().rstrip(";").strip()
    if not body:
        raise HTTPException(status_code=404, detail=f"Snowflake returned no DDL for {src_schema}.{src_name}")

    header = _VIEW_HEADER.match(body)
    if not header:
        raise HTTPException(
            status_code=400,
            detail=f"The DDL for {src_schema}.{src_name} does not read as a CREATE VIEW - copy it by hand.",
        )

    verb = "CREATE OR REPLACE VIEW" if if_exists == "overwrite" else "CREATE VIEW"
    props = " ".join(header.group("props").split())
    if props:
        verb = verb.replace("VIEW", f"{props.upper()} VIEW")
    body = f"{verb} {_ddl_qualified(tgt_db, tgt_schema, tgt_name)}" + body[header.end("name"):]

    # Anything the view selects from moves schema with it. Fully qualified
    # names go first, so the two-part rule never chews half of a three-part one.
    rewritten = 0
    db_schema = re.compile(
        rf'(?<![\w$."]){_ident_pattern(src_db)}\s*\.\s*{_ident_pattern(src_schema)}\s*\.',
        re.I,
    )
    body, count = db_schema.subn(f"{_ddl_ident(tgt_db)}.{_ddl_ident(tgt_schema)}.", body)
    rewritten += count

    # A two-part reference is only rewritten where it can only be an object -
    # straight after FROM, JOIN and friends. Anywhere else "DQ_CORE." is just
    # as likely to be a table alias in front of a column, and renaming that
    # would quietly break the view.
    schema_only = re.compile(
        rf'(\b(?:from|join|into|update|table)\s+){_ident_pattern(src_schema)}\s*\.',
        re.I,
    )
    body, count = schema_only.subn(lambda m: f"{m.group(1)}{_ddl_ident(tgt_schema)}.", body)
    rewritten += count

    return body, rewritten


def _view_recreate_unit(src_db, src_schema, src_name, tgt_db, tgt_schema, tgt_name, if_exists):
    """A view copied as a view: its own DDL, re-pointed and run in the target."""
    if if_exists == "append":
        raise HTTPException(
            status_code=400,
            detail="'append' means adding rows, and a view holds none. Use 'Stop' or 'Overwrite'.",
        )
    ddl = _object_ddl(src_db, src_schema, src_name, "VIEW", READ_PROFILE)
    sql, rewritten = _retarget_view_ddl(ddl, src_db, src_schema, src_name,
                                         tgt_db, tgt_schema, tgt_name, if_exists)
    return [], [{
        "table": src_name, "target": tgt_name, "kind": "recreate_view",
        "sql": sql, "params": None,
        "label": f"Recreate view {src_schema}.{src_name} → {tgt_schema}.{tgt_name}",
        "target_database": tgt_db, "target_schema": tgt_schema,
        "references_rewritten": rewritten,
        # Phase 2: a recreated view reads from the target schema, so it can only
        # compile once everything else in this job has landed there.
        "phase": COPY_PHASE_VIEWS,
        "est_rows": 0,
    }]


def _copy_table_units(src_db, src_schema, src_table, tgt_db, tgt_schema, tgt_table,
                       est_rows, mode, if_exists, parallelism, source_kind="table", strategy=None):
    """Prep statements (run once, sequentially) plus the parallel units for one
    table. Returns (prep_steps, units)."""
    src_q = qualified(src_db, src_schema, src_table)
    tgt_q = qualified(tgt_db, tgt_schema, tgt_table)

    # A view is a query, not storage: it has no structure to copy with LIKE and
    # no micro-partitions to clone. It lands as a table built from its own
    # result, in one statement - splitting that by hash would re-run the view
    # once per chunk, which is the opposite of faster.
    if source_kind in ("view", "materialized_view"):
        # Clone has no meaning for a view - there is nothing stored to clone -
        # so that choice recreates the view itself instead, which is what
        # "copy this object as it is" means for a view.
        if strategy == "view_ddl" or (strategy is None and mode == "clone"):
            return _view_recreate_unit(src_db, src_schema, src_table, tgt_db, tgt_schema, tgt_table, if_exists)
        if if_exists == "append":
            unit_sql = f"INSERT INTO {tgt_q} SELECT * FROM {src_q}"
            label = f"Append {src_schema}.{src_table} \u2192 {tgt_schema}.{tgt_table}"
        else:
            verb = "CREATE OR REPLACE TABLE" if if_exists == "overwrite" else "CREATE TABLE"
            unit_sql = f"{verb} {tgt_q} AS SELECT * FROM {src_q}"
            label = f"Materialise view {src_schema}.{src_table} \u2192 {tgt_schema}.{tgt_table}"
        return [], [{
            "table": src_table, "target": tgt_table, "kind": "view_to_table",
            "sql": unit_sql, "params": None, "label": label,
            "target_database": tgt_db, "target_schema": tgt_schema,
            "est_rows": est_rows or 0,
        }]

    if mode == "clone":
        verb = "CREATE OR REPLACE TABLE" if if_exists == "overwrite" else "CREATE TABLE"
        unit = {
            "table": src_table, "target": tgt_table, "kind": "clone_table",
            "sql": f"{verb} {tgt_q} CLONE {src_q}", "params": None,
            "label": f"Clone {src_schema}.{src_table} \u2192 {tgt_schema}.{tgt_table}",
            "target_database": tgt_db, "target_schema": tgt_schema,
            "est_rows": est_rows or 0,
        }
        return [], [unit]

    prep_steps: List[tuple] = []
    if if_exists == "overwrite":
        prep_steps.append((f"CREATE OR REPLACE TABLE {tgt_q} LIKE {src_q}", None,
                            f"Recreate structure for {tgt_schema}.{tgt_table}"))
    elif if_exists == "fail":
        prep_steps.append((f"CREATE TABLE {tgt_q} LIKE {src_q}", None,
                            f"Create structure for {tgt_schema}.{tgt_table}"))
    # if_exists == "append": the target table is expected to already exist.

    chunk_count = _plan_chunks(est_rows, parallelism)
    units = []
    for i in range(chunk_count):
        if chunk_count == 1:
            sql, params = f"INSERT INTO {tgt_q} SELECT * FROM {src_q}", None
        else:
            sql = f"INSERT INTO {tgt_q} SELECT * FROM {src_q} WHERE ABS(HASH(*)) % ? = ?"
            params = (chunk_count, i)
        units.append({
            "table": src_table, "target": tgt_table, "kind": "insert_chunk",
            "sql": sql, "params": params,
            "label": f"Copy {src_schema}.{src_table} chunk {i + 1}/{chunk_count} \u2192 {tgt_schema}.{tgt_table}",
            "target_database": tgt_db, "target_schema": tgt_schema,
            "est_rows": (est_rows or 0) // chunk_count,
        })
    return prep_steps, units


def _schema_exists(database: str, schema: str) -> Optional[bool]:
    """True, False, or None when the write login can't tell us."""
    def read(cur):
        cur.execute(
            f"SELECT 1 FROM {quote_ident(database)}.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
            (schema,),
        )
        return cur.fetchone() is not None

    try:
        return _run_meta(read, _writer_profile())
    except Exception as e:
        logger.info("Schema check skipped for %s.%s: %s", database, schema, e)
        return None


def _ensure_schema_steps(database: str, schema: str) -> List[tuple]:
    """A CREATE SCHEMA step, but only when the schema is really missing.

    The target schema can be typed by hand, so a copy has to be able to create
    it - and firing CREATE SCHEMA IF NOT EXISTS at one that already exists is
    not free: the role still needs CREATE SCHEMA on the database, which a
    write role scoped to one schema usually does not have."""
    # Unknown counts as "leave it alone" - better a clear "schema does not
    # exist" from Snowflake than a statement that trips on privileges.
    if _schema_exists(database, schema) is not False:
        return []
    return [(
        f"CREATE SCHEMA IF NOT EXISTS {quote_ident(database)}.{quote_ident(schema)}",
        None, f"Create schema {database}.{schema}",
    )]


def _copy_route(body: CopyRequest, first_table: Optional[str]) -> str:
    """"server" when one login can run the copy inside Snowflake, "transfer"
    when the data has to come through this process because the write login
    cannot see the source."""
    if not _write_configured():
        return "server"
    probe_table = body.source_table if body.copy_type == "table" else first_table
    if probe_table and _write_can_read(body.source_database, body.source_schema, probe_table):
        return "server"
    if not probe_table:
        return "server"                     # nothing to probe - nothing to copy either
    return "transfer"


def _settle_view_strategies(items: List[Dict[str, Any]], mode: str):
    """Decide, per object, whether a view stays a view.

    When everything picked is a view, the mode pills are about views and the
    choice is the user's: recreate it, or write out what it returns. When the
    selection also holds tables, those pills are about the tables - so a view
    keeps its nature rather than quietly arriving as a table."""
    views = [i for i in items if i.get("kind") in ("view", "materialized_view")]
    if not views:
        return
    views_only = len(views) == len(items)
    for item in views:
        item["strategy"] = "view" if (views_only and mode == "insert") else "view_ddl"


def _build_copy_plan(body: CopyRequest, target_table: Optional[str]) -> Dict[str, Any]:
    if body.copy_type == "table":
        source = _source_object(body.source_database, body.source_schema, body.source_table)
        items = [{"name": body.source_table, "target": target_table, "est_rows": source["est_rows"] or 0,
                  "strategy": body.mode, "kind": source["kind"]}]
    elif body.copy_type == "tables":
        # A hand-picked set. Each one is looked up on its own because the
        # selection can mix tables and views, and they are copied differently.
        names = [n.strip() for n in (body.source_tables or []) if (n or "").strip()]
        if len(names) > MAX_TABLES_PER_SCHEMA_COPY:
            raise HTTPException(
                status_code=400,
                detail=(f"{len(names)} objects selected - that's more than one copy job can take on "
                         f"({MAX_TABLES_PER_SCHEMA_COPY} max). Copy in smaller batches."),
            )
        # Past a handful, one listing of the schema is cheaper than a lookup
        # per name - the same reason the column read is done in bulk below.
        catalogue = {}
        if len(names) > 5:
            try:
                catalogue = {t["name"]: t for t in
                             _enumerate_source_tables(body.source_database, body.source_schema)}
            except HTTPException as e:
                logger.info("Bulk object listing unavailable (%s) - falling back per object", e.detail)

        items = []
        for name in names:
            listed = catalogue.get(name)
            source = ({"kind": listed["kind"], "est_rows": listed["est_rows"]} if listed
                      else _source_object(body.source_database, body.source_schema, name))
            items.append({"name": name, "target": name, "est_rows": source["est_rows"] or 0,
                          "strategy": body.mode, "kind": source["kind"]})
    else:
        tables = _enumerate_source_tables(body.source_database, body.source_schema)
        if len(tables) > MAX_TABLES_PER_SCHEMA_COPY:
            raise HTTPException(
                status_code=400,
                detail=(f"{len(tables)} tables in {body.source_schema} - that's more than one copy job can "
                         f"take on ({MAX_TABLES_PER_SCHEMA_COPY} max). Copy in smaller batches."),
            )
        items = [{"name": t["name"], "target": t["name"], "est_rows": t["est_rows"],
                  "strategy": body.mode, "kind": t["kind"]} for t in tables]

    _settle_view_strategies(items, body.mode)

    prep_steps: List[tuple] = []
    units: List[Dict[str, Any]] = []
    warnings: List[str] = []

    # Recreating a view moves no rows: the read login supplies the DDL and the
    # write login runs it, whatever either can or cannot see of the other side.
    # Only a selection that is nothing but views can skip the route check.
    recreating_views = bool(items) and all(i["strategy"] == "view_ddl" for i in items)

    route = "view_ddl" if recreating_views else _copy_route(body, items[0]["name"] if items else None)
    if route == "transfer":
        # A view is recreated from its DDL either way: that needs no access to
        # the other side's data, so the two-login problem never applies to it.
        # Only a table actually has to be cloned, and that is what cannot work.
        if body.mode == "clone" and any(i["strategy"] != "view_ddl" for i in items):
            raise HTTPException(
                status_code=400,
                # A code as well as the sentence: the screen offers to make this
                # exact change rather than asking someone to go and find it.
                detail={
                    "code": "clone_needs_one_role",
                    "message": (
                        f"Clone needs one Snowflake role that can see both sides, and the write login "
                        f"({_profile_label(WRITE_PROFILE)}) cannot read "
                        f"{body.source_database}.{body.source_schema}. Copy rows instead and the data is "
                        f"carried across by the portal - or grant the write role read access on the source."
                    ),
                },
            )
        writer = _profile_label(WRITE_PROFILE)
        reader = _profile_label(READ_PROFILE)
        if any(i["strategy"] != "view_ddl" for i in items):
            warnings.append(
                f"The write login ({writer}) cannot read {body.source_database}.{body.source_schema}, so the "
                f"rows are read as {reader} and inserted as {writer} through this API. That is slower than a "
                f"copy inside Snowflake and it holds both connections for the whole job."
            )
        # One read for every column in the schema beats one read per object.
        column_map = (_fetch_schema_columns(body.source_database, body.source_schema)
                      if len(items) > 1 else {})
        for item in items:
            if item["strategy"] == "view_ddl":
                table_prep, table_units = _view_recreate_unit(
                    body.source_database, body.source_schema, item["name"],
                    body.target_database, body.target_schema, item["target"],
                    body.if_exists if body.if_exists != "append" else "overwrite",
                )
            else:
                table_prep, table_units = _transfer_unit(
                    body.source_database, body.source_schema, item["name"],
                    body.target_database, body.target_schema, item["target"],
                    item["est_rows"], body.if_exists,
                    columns=column_map.get(item["name"]),
                )
                item["strategy"] = "transfer"
            prep_steps.extend(table_prep)
            units.extend(table_units)
            item["est_chunks"] = len(table_units)

        for step in reversed(_ensure_schema_steps(body.target_database, body.target_schema)):
            prep_steps.insert(0, step)
        return {
            "items": items, "prep_steps": prep_steps, "units": units, "route": route,
            "totals": {"tables": len(items), "est_rows": sum(i["est_rows"] for i in items)},
            "warnings": warnings,
        }

    # CREATE SCHEMA ... CLONE builds the schema itself, so it can only run when
    # there is no schema there yet - or when the caller has asked to replace the
    # whole thing. Cloning into a schema that already exists means cloning its
    # tables into it one by one, which is what falling through does.
    target_schema_exists = (
        _schema_exists(body.target_database, body.target_schema)
        if body.copy_type == "schema" and body.mode == "clone" else None
    )
    if body.copy_type == "schema" and body.mode == "clone" and target_schema_exists and body.if_exists == "overwrite":
        warnings.append(
            f"{body.target_database}.{body.target_schema} already exists and will be dropped and replaced "
            "by the clone - everything currently in it goes with it."
        )

    whole_schema_clone = (
        body.copy_type == "schema" and body.mode == "clone" and items
        and (body.if_exists == "overwrite" or target_schema_exists is False)
    )
    if whole_schema_clone:
        verb = "CREATE OR REPLACE SCHEMA" if body.if_exists == "overwrite" else "CREATE SCHEMA"
        src_q = f"{quote_ident(body.source_database)}.{quote_ident(body.source_schema)}"
        tgt_q = f"{quote_ident(body.target_database)}.{quote_ident(body.target_schema)}"
        units.append({
            "table": "__schema__", "target": body.target_schema, "kind": "clone_schema",
            "sql": f"{verb} {tgt_q} CLONE {src_q}", "params": None,
            "label": f"Clone schema {body.source_database}.{body.source_schema} \u2192 "
                     f"{body.target_database}.{body.target_schema} - one statement covering "
                     f"{len(items)} table(s) and everything else in the schema",
            "target_database": body.target_database, "target_schema": body.target_schema,
            "est_rows": sum(i["est_rows"] for i in items),
        })
        # CLONE copies a view's definition as it is written, so a cloned view
        # still selects from the schema it came from. Recreating each one
        # afterwards with its references re-pointed is what makes the copy
        # stand on its own - and phase 2 means it happens after the clone.
        for item in items:
            item["est_chunks"] = 1
            if item["kind"] not in ("view", "materialized_view"):
                continue
            try:
                _, view_units = _view_recreate_unit(
                    body.source_database, body.source_schema, item["name"],
                    body.target_database, body.target_schema, item["name"], "overwrite",
                )
            except HTTPException as exc:
                # A view whose DDL cannot be read (a secure view someone else
                # owns) still gets cloned; it just keeps pointing at the source.
                warnings.append(f"{item['name']}: {exc.detail}")
                item["strategy"] = "clone"
                continue
            units.extend(view_units)
            item["strategy"] = "view_ddl"

        return {
            "items": items, "prep_steps": [], "units": units, "route": route,
            "single_statement": True,
            "totals": {"tables": len(items), "est_rows": sum(i["est_rows"] for i in items)},
            "warnings": warnings,
        }

    prep_steps.extend(_ensure_schema_steps(body.target_database, body.target_schema))

    for item in items:
        table_prep, table_units = _copy_table_units(
            body.source_database, body.source_schema, item["name"],
            body.target_database, body.target_schema, item["target"],
            item["est_rows"], body.mode,
            body.if_exists if not (item["strategy"] == "view_ddl" and body.if_exists == "append") else "overwrite",
            body.parallelism,
            source_kind=item.get("kind", "table"), strategy=item["strategy"],
        )
        prep_steps.extend(table_prep)
        units.extend(table_units)
        item["est_chunks"] = len(table_units)

    return {
        "items": items,
        "prep_steps": prep_steps,
        "units": units,
        "route": route,
        "totals": {"tables": len(items), "est_rows": sum(i["est_rows"] for i in items)},
        "warnings": warnings,
    }


def _copy_endpoint_label(database: str, schema: str, name: Optional[str]) -> str:
    """db.schema for a whole-schema or multi-object job, db.schema.name for one."""
    return f"{database}.{schema}" + (f".{name}" if name else "")


def _new_copy_job(body: CopyRequest, plan: Dict[str, Any], owner: str) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    objects_total = len(plan["items"])
    tables = {}
    for unit in plan["units"]:
        if unit["table"] == "__schema__":
            # One statement covering the whole schema. Naming it after the first
            # table in the list - which is what it used to do - reads like that
            # one table is being copied and the other 84 are missing.
            row_name = f"Whole schema · {objects_total} object{'' if objects_total == 1 else 's'}"
        else:
            row_name = unit["table"]
        t = tables.setdefault(unit["table"], {
            "name": row_name,
            "target": unit["target"], "status": "pending",
            "est_rows": 0, "rows_copied": 0, "chunks_total": 0, "chunks_done": 0, "error": None,
        })
        t["est_rows"] += unit.get("est_rows", 0)
        t["chunks_total"] += 1

    job = {
        "job_id": job_id,
        "owner": (owner or "").strip().lower(),
        "copy_type": body.copy_type,
        "mode": body.mode,
        "route": plan.get("route", "server"),
        "if_exists": body.if_exists,
        "source": _copy_endpoint_label(body.source_database, body.source_schema, body.source_table
                                       if body.copy_type == "table" else None),
        "target": _copy_endpoint_label(body.target_database, body.target_schema, body.target_table
                                       if body.copy_type == "table" else None),
        "target_database": body.target_database,
        "target_schema": body.target_schema,
        "status": "running",   # running | success | failed | cancelled | partial
        "tables": tables,
        # Steps are what the progress list shows: a whole-schema clone is one
        # step covering many objects, so the two counts are not the same number
        # and the payload carries both.
        "tables_total": len(tables),
        "objects_total": objects_total,
        "tables_done": 0,
        "tables_failed": 0,
        "logs": [],
        "lock": threading.Lock(),
        "cancel_requested": False,
        "active_cursors": [],
        "created_at": time.time(),
        "started_at": time.time(),
        "finished_at": None,
        "updated_at": time.time(),
        "done": threading.Event(),
        # Set whenever anything about the job changes, so a watcher can wait on
        # it instead of polling.
        "pulse": threading.Event(),
    }
    with _copy_jobs_lock:
        _copy_jobs[job_id] = job
    return job


def _get_copy_job(job_id: str, owner: Optional[str] = None) -> Dict[str, Any]:
    with _copy_jobs_lock:
        job = _copy_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or expired copy job")
    if owner is not None and job["owner"] and job["owner"] != (owner or "").strip().lower():
        raise HTTPException(status_code=404, detail="Unknown or expired copy job")
    return job


def cleanup_copy_jobs():
    cutoff = time.time() - COPY_JOB_TTL_SECONDS
    with _copy_jobs_lock:
        stale = [jid for jid, j in _copy_jobs.items() if j["status"] != "running" and j["created_at"] < cutoff]
        for jid in stale:
            _copy_jobs.pop(jid, None)


def _stream_table(job: Dict[str, Any], unit: Dict[str, Any], table_state: Dict[str, Any]) -> int:
    """Read one table with the read login and insert it with the write one.

    Rows are counted into the job as each batch lands rather than at the end,
    so a long transfer shows a progress bar that actually moves."""
    batch_rows = unit["batch_rows"]
    row_values = "(" + ", ".join("?" * unit["column_count"]) + ")"
    copied = 0

    with _pooled(unit["source_database"], unit["source_schema"], profile=READ_PROFILE) as read_conn, \
         _pooled(unit["target_database"], unit["target_schema"], profile=WRITE_PROFILE) as write_conn:
        read_cur = read_conn.cursor()
        write_cur = write_conn.cursor()
        with job["lock"]:
            job["active_cursors"].extend([read_cur, write_cur])
        try:
            copy_timeout = _require_config()["copy_timeout_seconds"]
            _apply_statement_timeout(read_conn, read_cur, copy_timeout)
            _apply_statement_timeout(write_conn, write_cur, copy_timeout)
            read_cur.execute(unit["select_sql"])
            while True:
                if job["cancel_requested"]:
                    raise _Cancelled()
                rows = read_cur.fetchmany(batch_rows)
                if not rows:
                    break
                # One statement per batch, not per row - a round trip for every
                # row of a million-row table is the difference between minutes
                # and hours.
                sql = unit["insert_prefix"] + ", ".join([row_values] * len(rows))
                params = [value for row in rows for value in row]
                write_cur.execute(sql, params)
                copied += len(rows)
                # The planner checks ROW_COUNT before starting, but a view has
                # none to check - so the ceiling is enforced here as well.
                if copied > TRANSFER_MAX_ROWS:
                    raise HTTPException(
                        status_code=400,
                        detail=(f"{unit['label']} passed {TRANSFER_MAX_ROWS:,} rows, the limit for a copy that "
                                "has to go through this API. The rows written so far are still there - narrow "
                                "the source, or grant the write role read access so Snowflake can do it itself."),
                    )
                with job["lock"]:
                    table_state["rows_copied"] += len(rows)
                _copy_touch(job)
        finally:
            with job["lock"]:
                job["active_cursors"] = [c for c in job["active_cursors"]
                                          if c is not read_cur and c is not write_cur]
            for cur in (read_cur, write_cur):
                try:
                    cur.close()
                except Exception:
                    pass
    return copied


def _run_copy_unit(job: Dict[str, Any], unit: Dict[str, Any]):
    if job["cancel_requested"]:
        return
    _copy_chunk_slots.acquire()
    table_state = job["tables"].get(unit["table"]) if unit["table"] != "__schema__" else next(iter(job["tables"].values()))
    try:
        if job["cancel_requested"]:
            return
        with job["lock"]:
            if table_state["status"] == "pending":
                table_state["status"] = "running"

        if unit["kind"] == "transfer_table":
            try:
                rows = _stream_table(job, unit, table_state)
            except _Cancelled:
                _copy_log(job, "warn", f"cancelled - {unit['label']}")
                raise
            except Exception as e:
                with job["lock"]:
                    table_state["status"] = "failed"
                    table_state["error"] = str(e)
                _copy_log(job, "error", f"failed - {unit['label']}: {e}")
                raise
            with job["lock"]:
                table_state["chunks_done"] += 1
            _copy_log(job, "info", f"done - {unit['label']} ({rows:,} rows)")
            return

        conn, key, created = core._pool.acquire(unit["target_database"], unit["target_schema"],
                                           profile=_writer_profile())
        healthy = True
        cur = None
        try:
            cur = conn.cursor()
            with job["lock"]:
                job["active_cursors"].append(cur)
            # A clone of 78 tables, or an INSERT of a hundred million rows, is
            # allowed to take its time.
            _apply_statement_timeout(conn, cur, _require_config()["copy_timeout_seconds"])
            if unit["kind"] == "recreate_view":
                # The statement is the whole point of this one - show it, so a
                # failure can be read against exactly what was run.
                _copy_log(job, "info",
                          f"{unit['references_rewritten']} reference(s) re-pointed at the target schema")
                _copy_log(job, "info", unit["sql"])
            cur.execute(unit["sql"], unit["params"])
            rows = cur.rowcount if isinstance(cur.rowcount, int) and cur.rowcount > 0 else 0
            if unit["kind"] in ("clone_table", "clone_schema"):
                rows = unit.get("est_rows", 0)  # a clone is instant; report the estimate as "copied"
            with job["lock"]:
                table_state["rows_copied"] += rows
                table_state["chunks_done"] += 1
                job["active_cursors"] = [c for c in job["active_cursors"] if c is not cur]
            _copy_touch(job)
            if unit["kind"] == "recreate_view":
                _copy_log(job, "info", f"done - {unit['label']}")
            else:
                _copy_log(job, "info", f"done - {unit['label']} ({rows:,} rows)")
        except Exception as e:
            healthy = not _looks_stale(e)
            with job["lock"]:
                table_state["status"] = "failed"
                table_state["error"] = str(e)
            _copy_log(job, "error", f"failed - {unit['label']}: {e}")
            raise
        finally:
            if cur is not None:
                try:
                    cur.close()
                except Exception:
                    pass
            if healthy:
                core._pool.release(conn, key, created)
            else:
                _quiet_close(conn)
    finally:
        _copy_chunk_slots.release()
        # Several chunks of the same table can hit this at nearly the same
        # instant - "_finalized" makes the done/failed count exactly once
        # per table no matter how the threads interleave.
        with job["lock"]:
            if not table_state.get("_finalized"):
                if table_state["status"] == "failed":
                    table_state["_finalized"] = True
                    job["tables_failed"] += 1
                elif table_state["chunks_done"] >= table_state["chunks_total"]:
                    table_state["status"] = "success"
                    table_state["_finalized"] = True
                    job["tables_done"] += 1
                    _drop_table_cache(unit["target_database"], unit["target_schema"])


def _reset_failed_unit(job: Dict[str, Any], unit: Dict[str, Any]):
    """Put a failed object back to pending so it can be tried once more."""
    table_state = job["tables"].get(unit["table"])
    if not table_state:
        return
    with job["lock"]:
        if table_state.get("_finalized") and table_state["status"] == "failed":
            table_state["_finalized"] = False
            table_state["status"] = "pending"
            table_state["error"] = None
            job["tables_failed"] = max(0, job["tables_failed"] - 1)


def _run_view_units(job: Dict[str, Any], view_units: List[Dict[str, Any]]):
    """Recreate views, retrying the ones that failed.

    A view built on another view only compiles once that one exists, and
    nothing here knows which depends on which - so a pass that manages to
    create at least one view is worth repeating for the rest. Passes stop as
    soon as one makes no progress: that failure is real."""
    pending = list(view_units)
    for attempt in range(3):
        if not pending or job["cancel_requested"]:
            break
        if attempt:
            _copy_log(job, "info", f"Retrying {len(pending)} view(s) - a view they read from may "
                                   "only have been created in the pass before")
            for unit in pending:
                _reset_failed_unit(job, unit)

        failed = []
        for unit in pending:
            if job["cancel_requested"]:
                break
            try:
                _run_copy_unit(job, unit)
            except Exception:
                failed.append(unit)

        if len(failed) == len(pending):
            break                       # nothing moved; another pass changes nothing
        pending = failed


def _run_copy_job(job_id: str, prep_steps: List[tuple], units: List[Dict[str, Any]]):
    job = _copy_jobs.get(job_id)
    if not job:
        return
    how = {
        "transfer": "row transfer between two logins",
        "view_ddl": "view recreated from its own DDL",
    }.get(job.get("route"), job["mode"])
    objects = job.get("objects_total") or job["tables_total"]
    _copy_log(job, "info", f"Starting {job['copy_type']} copy: {job['source']} \u2192 {job['target']} "
                           f"({how}, {objects} object{'' if objects == 1 else 's'} "
                           f"in {job['tables_total']} step{'' if job['tables_total'] == 1 else 's'})")
    if job.get("route") == "transfer":
        _copy_log(job, "warn", f"Reading as {_profile_label(READ_PROFILE)}, writing as "
                               f"{_profile_label(WRITE_PROFILE)} - rows pass through the API")
    try:
        for sql, params, label in prep_steps:
            if job["cancel_requested"]:
                raise _Cancelled()
            _copy_log(job, "info", label)
            try:
                with _pooled(job["target_database"], profile=_writer_profile()) as conn:
                    cur = conn.cursor()
                    try:
                        _apply_statement_timeout(conn, cur, _require_config()["copy_timeout_seconds"])
                        cur.execute(sql, params)
                    finally:
                        cur.close()
            except Exception as e:
                _copy_log(job, "error", f"{label} failed: {e}")
                raise

        if job["cancel_requested"]:
            raise _Cancelled()

        # Tables first, views after - one object or seventy, hand-picked or a
        # whole schema. A recreated view points at the target schema, so
        # whatever it selects from has to be there before it runs.
        data_units = [u for u in units if u.get("phase", COPY_PHASE_DATA) == COPY_PHASE_DATA]
        view_units = [u for u in units if u.get("phase", COPY_PHASE_DATA) == COPY_PHASE_VIEWS]

        futures = [_executor.submit(_run_copy_unit, job, unit) for unit in data_units]
        for fut in futures:
            try:
                fut.result()
            except Exception as e:
                logger.info("Copy unit failed for job %s: %s", job_id, e)

        if view_units and not job["cancel_requested"]:
            _run_view_units(job, view_units)

        # New schemas, tables and views: drop the cached lists before the job reads as finished.
        core.catalog_changed()
        with job["lock"]:
            statuses = {t["status"] for t in job["tables"].values()}
            if job["cancel_requested"]:
                job["status"] = "cancelled"
            elif statuses == {"failed"}:
                job["status"] = "failed"
            elif "failed" in statuses:
                job["status"] = "partial"
            else:
                job["status"] = "success"
            total_rows = sum(t["rows_copied"] for t in job["tables"].values())
        tail = "" if job.get("route") == "view_ddl" else f", {total_rows:,} rows copied"
        _copy_log(job, "success" if job["status"] == "success" else "warn",
                  f"Copy {job['status']} - {job['tables_done']}/{job['tables_total']} step(s){tail}")
    except _Cancelled:
        with job["lock"]:
            job["status"] = "cancelled"
        _copy_log(job, "warn", "Copy cancelled")
    except HTTPException as e:
        with job["lock"]:
            job["status"] = "failed"
        _copy_log(job, "error", f"Copy failed: {e.detail}")
    except Exception as e:
        with job["lock"]:
            job["status"] = "failed"
        _copy_log(job, "error", f"Copy failed: {e}")
    finally:
        core.catalog_changed()      # a failed or cancelled copy may still have created objects
        job["finished_at"] = time.time()
        job["done"].set()
        _copy_touch(job)
        try:
            from audit import write_audit_event
            write_audit_event("sfqr_table_copy", job["owner"], job["target"],
                               f"{job['status']}: {job['source']} -> {job['target']} ({job['mode']})")
        except Exception:
            pass


def _copy_job_payload(job: Dict[str, Any], since_log: int = 0) -> Dict[str, Any]:
    with job["lock"]:
        tables = [
            {k: v for k, v in t.items() if not k.startswith("_")}
            for t in job["tables"].values()
        ]
        all_logs = list(job["logs"])
    rows_copied = sum(t["rows_copied"] for t in tables)
    est_rows_total = sum(t["est_rows"] for t in tables)
    percent = round(min(100.0, rows_copied / est_rows_total * 100), 1) if est_rows_total else (
        100.0 if job["status"] in ("success", "partial") else None
    )
    elapsed_ms = int(((job["finished_at"] or time.time()) - job["started_at"]) * 1000)
    return {
        "job_id": job["job_id"], "status": job["status"],
        "copy_type": job["copy_type"], "mode": job["mode"], "route": job.get("route", "server"),
        "source": job["source"], "target": job["target"],
        "tables_total": job["tables_total"], "tables_done": job["tables_done"],
        "tables_failed": job["tables_failed"],
        "objects_total": job.get("objects_total") or job["tables_total"],
        "rows_copied": rows_copied, "est_rows_total": est_rows_total, "percent": percent,
        "elapsed_ms": elapsed_ms,
        "tables": tables,
        "logs": all_logs[since_log:],
        "log_count": len(all_logs),
    }


@copy_router.post("/copy/start")
def start_copy(body: CopyRequest, auth: dict = Depends(sf_auth)):
    _require(auth, PERM_COPY, "copy tables")
    cleanup_copy_jobs()
    cfg = _require_config()
    if not cfg["allow_writes"]:
        raise HTTPException(status_code=403, detail="This deployment's Data Studio (Snowflake) is configured read-only")
    if body.copy_type not in ("table", "tables", "schema"):
        raise HTTPException(status_code=400, detail="copy_type must be 'table', 'tables' or 'schema'")
    if body.mode not in ("clone", "insert"):
        raise HTTPException(status_code=400, detail="mode must be 'clone' or 'insert'")
    if body.if_exists not in ("fail", "overwrite", "append"):
        raise HTTPException(status_code=400, detail="if_exists must be 'fail', 'overwrite' or 'append'")
    if body.mode == "clone" and body.if_exists == "append":
        raise HTTPException(
            status_code=400,
            detail="'append' isn't supported in clone mode - a clone always creates a new object. "
                   "Use 'overwrite', or switch to insert mode to add rows to an existing table.",
        )
    if body.copy_type == "table" and not (body.source_table or "").strip():
        raise HTTPException(status_code=400, detail="source_table is required for a table copy")
    if body.copy_type == "tables" and not [n for n in (body.source_tables or []) if (n or "").strip()]:
        raise HTTPException(status_code=400, detail="Pick at least one table or view to copy")
    if not (body.source_database or "").strip() or not (body.source_schema or "").strip():
        raise HTTPException(status_code=400, detail="A source database and schema are required")
    if not (body.target_database or "").strip() or not (body.target_schema or "").strip():
        raise HTTPException(status_code=400, detail="A target database and schema are required")

    target_table = (body.target_table or body.source_table or "").strip() or None
    if body.copy_type == "table":
        same_location = (
            body.source_database == body.target_database
            and body.source_schema == body.target_schema
            and (target_table or "") == (body.source_table or "")
        )
        if same_location:
            raise HTTPException(status_code=400, detail="Source and target are the same table")
    else:
        # A multi-select keeps every name, so landing back in the same schema
        # would mean copying each object onto itself.
        if body.source_database == body.target_database and body.source_schema == body.target_schema:
            raise HTTPException(status_code=400, detail="Source and target are the same schema")

    plan = _build_copy_plan(body, target_table)

    if not body.confirm:
        return {
            "requires_confirmation": True,
            "copy_type": body.copy_type, "mode": body.mode, "if_exists": body.if_exists,
            "source": _copy_endpoint_label(body.source_database, body.source_schema, body.source_table
                                           if body.copy_type == "table" else None),
            "target": _copy_endpoint_label(body.target_database, body.target_schema, target_table
                                           if body.copy_type == "table" else None),
            "items": plan["items"],
            "totals": plan["totals"],
            "warnings": plan["warnings"],
            # "server" = one statement inside Snowflake, "transfer" = the rows
            # come through this API because the two logins see different things.
            "route": plan.get("route", "server"),
            # A whole-schema clone is one statement covering every object in the
            # schema - views and the rest included, not only the tables listed.
            "single_statement": bool(plan.get("single_statement")),
        }

    if not plan["items"]:
        raise HTTPException(status_code=400, detail="Nothing to copy - the source schema has no tables")

    job = _new_copy_job(body, plan, auth["user"]["email"])
    try:
        _executor.submit(_run_copy_job, job["job_id"], plan["prep_steps"], plan["units"])
    except Exception as e:
        with _copy_jobs_lock:
            _copy_jobs.pop(job["job_id"], None)
        raise HTTPException(status_code=503, detail=f"Could not schedule the copy: {e}")

    return {"job_id": job["job_id"], "status": "running", "tables_total": job["tables_total"]}


@copy_router.get("/copy/{job_id}/status")
def get_copy_status(
    job_id: str,
    wait_ms: int = Query(0, ge=0, le=15000),
    since_log: int = Query(0, ge=0),
    auth: dict = Depends(sf_auth),
):
    job = _get_copy_job(job_id, auth["user"]["email"])
    if wait_ms and job["status"] == "running":
        job["done"].wait(wait_ms / 1000.0)
    job["updated_at"] = time.time()
    return _copy_job_payload(job, since_log=since_log)


def _copy_sse(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


@copy_router.get("/copy/{job_id}/stream")
def stream_copy(
    job_id: str,
    since_log: int = Query(0, ge=0),
    auth: dict = Depends(sf_auth),
):
    """The job as it happens, rather than as it was 4 seconds ago.

    Polling for a copy meant every log line waited for the next request, which
    is a long time to stare at nothing while 78 tables clone. This waits on the
    job's own pulse instead: a line written is a line sent."""
    job = _get_copy_job(job_id, auth["user"]["email"])

    def events():
        cursor = since_log
        last_progress = 0.0
        heartbeat = time.time()
        while True:
            # Cleared before reading, so an update that lands while this frame
            # is being built sets it again and the next wait returns at once.
            job["pulse"].clear()
            payload = _copy_job_payload(job, since_log=cursor)
            now = time.time()

            if payload["logs"]:
                yield _copy_sse("logs", {"logs": payload["logs"], "log_count": payload["log_count"]})
                cursor = payload["log_count"]
                heartbeat = now

            # Row counts move far faster than anyone can read, so the numbers
            # go out on a tick rather than on every batch.
            if now - last_progress >= 0.25 or payload["status"] != "running":
                progress = {k: v for k, v in payload.items() if k != "logs"}
                yield _copy_sse("progress", progress)
                last_progress = now
                heartbeat = now

            if payload["status"] != "running":
                yield _copy_sse("done", {"status": payload["status"]})
                return

            if now - heartbeat >= 15:
                yield ": keep-alive\n\n"      # proxies drop a silent stream
                heartbeat = now

            job["pulse"].wait(1.0)
            job["updated_at"] = time.time()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",      # nginx would otherwise hold the frames
        },
    )


@copy_router.post("/copy/{job_id}/cancel")
def cancel_copy(job_id: str, auth: dict = Depends(sf_auth)):
    job = _get_copy_job(job_id, auth["user"]["email"])
    if job["status"] != "running":
        return {"job_id": job_id, "status": job["status"]}
    job["cancel_requested"] = True
    with job["lock"]:
        conns = {id(c.connection): c.connection for c in job["active_cursors"] if getattr(c, "connection", None)}
    for conn in conns.values():
        _doom(conn)
        _executor.submit(_cancel_session_queries, conn)
    _copy_log(job, "warn", "Cancel requested - stopping in-flight chunks, no new ones will start")
    return {"job_id": job_id, "status": "cancelling"}


@copy_router.delete("/copy/{job_id}")
def close_copy(job_id: str, auth: dict = Depends(sf_auth)):
    _get_copy_job(job_id, auth["user"]["email"])     # 404 unless it's yours
    with _copy_jobs_lock:
        _copy_jobs.pop(job_id, None)
    return {"job_id": job_id, "status": "closed"}


@copy_router.get("/copy/jobs")
def list_copy_jobs(auth: dict = Depends(sf_auth)):
    owner = (auth["user"]["email"] or "").strip().lower()
    with _copy_jobs_lock:
        jobs = [j for j in _copy_jobs.values() if j["owner"] == owner]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return {
        "jobs": [
            {
                "job_id": j["job_id"], "status": j["status"], "copy_type": j["copy_type"],
                "mode": j["mode"], "source": j["source"], "target": j["target"],
                "created_at": j["created_at"], "tables_total": j["tables_total"],
                "tables_done": j["tables_done"],
            }
            for j in jobs[:20]
        ]
    }


def shutdown():
    """Called from app.py's shutdown hook - stop every running copy."""
    with _copy_jobs_lock:
        for job in _copy_jobs.values():
            job["cancel_requested"] = True
        _copy_jobs.clear()
