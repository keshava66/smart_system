"""
SQL text helpers for Data Studio's Snowflake tab, also used by the Postgres tab
(postgres_studio.py) and the Data Shuttle: identifier quoting, JSON-safe values,
statement splitting and classification, and the result-grid filter / sort SQL.
No connections and no state here.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, time as time_, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel

# ============================================================================
# Identifiers and values
# ============================================================================

def quote_ident(name: str) -> str:
    """Double-quote a Snowflake identifier, escaping any embedded quotes. Every
    identifier that reaches SQL in this module goes through here - identifiers
    can't be bound as parameters, so this is the only thing standing between a
    table name and an injection."""
    if name is None:
        raise HTTPException(status_code=400, detail="Empty identifier")
    text = str(name)
    if not text or "\x00" in text:
        raise HTTPException(status_code=400, detail="Invalid identifier")
    if len(text) > 255:
        raise HTTPException(status_code=400, detail="Identifier is too long")
    return '"' + text.replace('"', '""') + '"'


def qualified(database: Optional[str], schema: Optional[str], table: str) -> str:
    parts = []
    if database:
        parts.append(quote_ident(database))
    if schema:
        parts.append(quote_ident(schema))
    parts.append(quote_ident(table))
    return ".".join(parts)


def _to_json_safe(val):
    """Coerce Snowflake result values into something json-encodable. Numeric and
    temporal precision is preserved as text rather than float - a browser
    round-tripping a NUMBER(38,10) through a JS number would silently corrupt
    it."""
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, Decimal):
        return str(val)
    if isinstance(val, (datetime, date, time_)):
        return val.isoformat()
    if isinstance(val, timedelta):
        return str(val)
    if isinstance(val, (bytes, bytearray, memoryview)):
        return bytes(val).hex().upper()
    if isinstance(val, float):
        if val != val or val in (float("inf"), float("-inf")):
            return None
        return val
    if isinstance(val, (list, tuple)):
        return [_to_json_safe(v) for v in val]
    if isinstance(val, dict):
        return {k: _to_json_safe(v) for k, v in val.items()}
    if isinstance(val, (int, str)):
        return val
    try:
        return str(val)
    except Exception:
        return None


def _flatten_for_text(val) -> str:
    """One-line text form used by the CSV/Excel writers."""
    safe = _to_json_safe(val)
    if safe is None:
        return ""
    if isinstance(safe, (dict, list)):
        return json.dumps(safe, separators=(",", ":"))
    return str(safe)


# ============================================================================
# SQL validation / classification
# ----------------------------------------------------------------------------
# Full Snowflake SQL is allowed - this is NOT a read-only runner. Two rules are
# enforced instead: one statement per run (so stacked-statement injection is
# never possible), and anything that mutates data or schema needs an explicit
# `confirm: true` from the caller, with a louder warning when an UPDATE/DELETE
# has no WHERE clause.
# ============================================================================

_ALWAYS_BLOCKED = [
    # Credential and account surface that has no business being driven from a
    # web query box, confirmed or not.
    (r"\bALTER\s+ACCOUNT\b", "ALTER ACCOUNT is not allowed from Data Studio"),
    (r"\bCREATE\s+(OR\s+REPLACE\s+)?(SECURITY\s+INTEGRATION|STORAGE\s+INTEGRATION|API\s+INTEGRATION|NOTIFICATION\s+INTEGRATION)\b",
     "Integration objects cannot be created from Data Studio"),
    (r"\bALTER\s+(SECURITY|STORAGE|API|NOTIFICATION)\s+INTEGRATION\b",
     "Integration objects cannot be altered from Data Studio"),
    (r"\bCREATE\s+(OR\s+REPLACE\s+)?USER\b", "User management is not allowed from Data Studio"),
    (r"\b(ALTER|DROP)\s+USER\b", "User management is not allowed from Data Studio"),
    (r"\bSYSTEM\$GET_PRIVATELINK", "This system function is not allowed from Data Studio"),
]

_DESTRUCTIVE_LEAD_KEYWORDS = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER",
    "CREATE", "GRANT", "REVOKE", "CALL", "COMMENT", "COPY", "PUT", "GET",
    "REMOVE", "UNDROP", "EXECUTE", "BEGIN", "COMMIT", "ROLLBACK",
}
# USE / SET / UNSET / ALTER SESSION only change this run's session, so they run
# without a confirm. That's what lets a script start with USE WAREHOUSE.

_DQL_LEAD_KEYWORDS = {"SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "LIST", "LS", "VALUES", "TABLE"}


def _strip_sql_comments(sql: str) -> str:
    """Removes '--' and /* */ comments without touching string literals,
    quoted identifiers, or $$-quoted bodies (used by procedures and UDFs).
    Newlines inside comments are preserved so error line numbers still line up."""
    out = []
    i, n = 0, len(sql)
    in_sq = in_dq = in_dollar = False
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_dollar:
            if ch == "$" and nxt == "$":
                out.append("$$")
                i += 2
                in_dollar = False
                continue
            out.append(ch)
            i += 1
            continue
        if in_sq:
            out.append(ch)
            if ch == "\\" and nxt:
                out.append(nxt)
                i += 2
                continue
            if ch == "'":
                if nxt == "'":
                    out.append(nxt)
                    i += 2
                    continue
                in_sq = False
            i += 1
            continue
        if in_dq:
            out.append(ch)
            if ch == '"':
                if nxt == '"':
                    out.append(nxt)
                    i += 2
                    continue
                in_dq = False
            i += 1
            continue
        if ch == "$" and nxt == "$":
            in_dollar = True
            out.append("$$")
            i += 2
            continue
        if ch == "'":
            in_sq = True
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_dq = True
            out.append(ch)
            i += 1
            continue
        if ch == "-" and nxt == "-":
            while i < n and sql[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if sql[i] == "/" and sql[i + 1: i + 2] == "*":
                    depth += 1
                    i += 2
                    continue
                if sql[i] == "*" and sql[i + 1: i + 2] == "/":
                    depth -= 1
                    i += 2
                    continue
                if sql[i] == "\n":
                    out.append("\n")
                i += 1
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def split_statements(sql: str) -> List[str]:
    """Splits on ';' that sit outside strings, quoted identifiers and $$ bodies.
    Expects text that has already been through _strip_sql_comments."""
    stmts, cur = [], []
    in_sq = in_dq = in_dollar = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_dollar:
            cur.append(ch)
            if ch == "$" and nxt == "$":
                cur.append(nxt)
                i += 2
                in_dollar = False
                continue
            i += 1
            continue
        if in_sq:
            cur.append(ch)
            if ch == "\\" and nxt:
                cur.append(nxt)
                i += 2
                continue
            if ch == "'":
                if nxt == "'":
                    cur.append(nxt)
                    i += 2
                    continue
                in_sq = False
            i += 1
            continue
        if in_dq:
            cur.append(ch)
            if ch == '"':
                if nxt == '"':
                    cur.append(nxt)
                    i += 2
                    continue
                in_dq = False
            i += 1
            continue
        if ch == "$" and nxt == "$":
            in_dollar = True
            cur.append("$$")
            i += 2
            continue
        if ch == "'":
            in_sq = True
            cur.append(ch)
            i += 1
            continue
        if ch == '"':
            in_dq = True
            cur.append(ch)
            i += 1
            continue
        if ch == ";":
            stmts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    stmts.append("".join(cur))
    return [s.strip() for s in stmts if s.strip()]


def _depth_zero_has(sql: str, pattern: str) -> bool:
    """True if `pattern` matches at parenthesis depth 0 - i.e. in the outer
    statement rather than inside a subquery."""
    depth = 0
    in_sq = in_dq = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_sq:
            if ch == "\\" and nxt:
                i += 2
                continue
            if ch == "'":
                if nxt == "'":
                    i += 2
                    continue
                in_sq = False
            i += 1
            continue
        if in_dq:
            if ch == '"':
                in_dq = False
            i += 1
            continue
        if ch == "'":
            in_sq = True
            i += 1
            continue
        if ch == '"':
            in_dq = True
            i += 1
            continue
        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0 and re.match(pattern, sql[i:], re.IGNORECASE):
            return True
        i += 1
    return False


def _lead_after_cte(sql: str) -> str:
    """For `WITH x AS (...) DELETE ...`, find the real command after the CTE
    list so the statement is classified on what it actually does."""
    depth = 0
    in_sq = in_dq = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_sq:
            if ch == "\\" and nxt:
                i += 2
                continue
            if ch == "'":
                if nxt == "'":
                    i += 2
                    continue
                in_sq = False
            i += 1
            continue
        if in_dq:
            if ch == '"':
                in_dq = False
            i += 1
            continue
        if ch == "'":
            in_sq = True
            i += 1
            continue
        if ch == '"':
            in_dq = True
            i += 1
            continue
        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0 and i > 0:
            m = re.match(r"\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE)\b", sql[i:], re.IGNORECASE)
            if m and not re.match(r"[A-Za-z0-9_$]", sql[i - 1]):
                return m.group(1).upper()
        i += 1
    return "SELECT"


@dataclass
class SqlClassification:
    cleaned_sql: str
    lead_keyword: str
    is_destructive: bool
    returns_rows: bool
    warning: Optional[str] = None


def classify_and_validate_sql(sql: str) -> SqlClassification:
    """Validates a single well-formed statement and classifies it. Raises 400 for
    anything structurally invalid (empty, multiple statements, blocked)."""
    if sql is None:
        raise HTTPException(status_code=400, detail="Query is empty")
    stripped = _strip_sql_comments(sql).strip()
    if not stripped:
        raise HTTPException(status_code=400, detail="Query is empty")

    statements = split_statements(stripped)
    if not statements:
        raise HTTPException(status_code=400, detail="Query is empty")
    if len(statements) > 1:
        raise HTTPException(status_code=400, detail="Only a single statement is allowed per run - highlight one and run the selection")

    for pattern, message in _ALWAYS_BLOCKED:
        if re.search(pattern, stripped, re.IGNORECASE):
            raise HTTPException(status_code=400, detail=message)

    # Execute the user's original text (comments and formatting intact); only
    # the trailing semicolon comes off.
    cleaned = sql.strip()
    while cleaned.endswith(";"):
        cleaned = cleaned[:-1].rstrip()

    m = re.match(r"^\s*([A-Za-z_]+)", stripped)
    lead = m.group(1).upper() if m else ""
    effective = lead

    if lead == "WITH":
        effective = _lead_after_cte(stripped)
    elif lead == "EXPLAIN":
        # Snowflake's EXPLAIN never runs the statement, so it's always safe.
        effective = "EXPLAIN"
    elif lead == "ALTER" and re.match(r"^\s*ALTER\s+SESSION\b", stripped, re.IGNORECASE):
        effective = "ALTERSESSION"

    is_destructive = effective in _DESTRUCTIVE_LEAD_KEYWORDS
    returns_rows = effective in _DQL_LEAD_KEYWORDS or effective == "EXPLAIN"

    warning = None
    if effective in ("UPDATE", "DELETE"):
        if not _depth_zero_has(stripped, r"\bWHERE\b"):
            warning = f"This {effective} has no WHERE clause and will affect every row in the target table."
    elif effective == "TRUNCATE":
        warning = "TRUNCATE removes every row in the target table and cannot be filtered."
    elif effective == "DROP":
        warning = "DROP permanently removes the object. Snowflake's UNDROP can recover it only within the object's Time Travel window."
    elif effective == "ALTER" and re.search(r"\bDROP\s+COLUMN\b", stripped, re.IGNORECASE):
        warning = "This ALTER drops a column, which permanently discards its data."
    elif effective == "CREATE" and re.search(r"\bCREATE\s+OR\s+REPLACE\b", stripped, re.IGNORECASE):
        warning = "CREATE OR REPLACE overwrites the existing object and drops its data."
    elif effective in ("USE", "SET", "UNSET", "ALTERSESSION", "BEGIN", "COMMIT", "ROLLBACK"):
        # Every run gets its own Snowflake session, so session-scoped state set
        # here is gone by the next statement. Worth saying out loud - it's a
        # classic "why didn't my USE take effect" moment.
        warning = "Each run uses its own Snowflake session, so this lasts until the end of this run only. Put it in the same run as the statements that need it, or fully qualify your objects."

    return SqlClassification(
        cleaned_sql=cleaned,
        lead_keyword=effective,
        is_destructive=is_destructive,
        returns_rows=returns_rows,
        warning=warning,
    )


MAX_STATEMENTS_PER_RUN = 100
_DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def split_script(sql: str, backslash_escapes: bool = True) -> List[tuple]:
    """A worksheet split into statements, as (text, lines before it). Semicolons
    inside strings, quoted names, comments and $$ / $tag$ bodies don't split.
    Comment-only pieces are dropped."""
    spans, start, i, n = [], 0, 0, len(sql)
    while i < n:
        ch, nxt = sql[i], sql[i + 1: i + 2]
        if ch == "'":
            i += 1
            while i < n:
                if backslash_escapes and sql[i] == "\\":
                    i += 2
                    continue
                if sql[i] == "'":
                    if sql[i + 1: i + 2] == "'":
                        i += 2
                        continue
                    break
                i += 1
            i += 1
        elif ch == '"':
            j = sql.find('"', i + 1)
            i = n if j < 0 else j + 1
        elif ch == "-" and nxt == "-":
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif ch == "/" and nxt == "*":
            depth, i = 1, i + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif ch == "$" and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in "_$")) and (m := _DOLLAR_TAG.match(sql, i)):
            j = sql.find(m.group(0), m.end())
            i = n if j < 0 else j + len(m.group(0))
        elif ch == ";":
            spans.append((start, i))
            start = i = i + 1
        else:
            i += 1
    spans.append((start, n))
    out = []
    for a, b in spans:
        text = sql[a:b]
        if not _strip_sql_comments(text).strip():
            continue
        first = a + len(text) - len(text.lstrip())
        out.append((text.strip(), sql.count("\n", 0, first)))
    return out


def plan_statements(sql: str, classify=None, backslash_escapes: bool = True) -> List[Dict[str, Any]]:
    """Split a run into statements and classify each one. Shared with the
    Postgres pane, which passes its own classifier."""
    classify = classify or classify_and_validate_sql
    parts = split_script(sql or "", backslash_escapes)
    if not parts:
        raise HTTPException(status_code=400, detail="Query is empty")
    if len(parts) > MAX_STATEMENTS_PER_RUN:
        raise HTTPException(status_code=400, detail=f"A run can have at most {MAX_STATEMENTS_PER_RUN} statements")
    planned = []
    for k, (text, line) in enumerate(parts):
        try:
            c = classify(text)
        except HTTPException as e:
            if len(parts) == 1:
                raise
            raise HTTPException(status_code=e.status_code, detail=f"Statement {k + 1} (line {line + 1}): {e.detail}")
        planned.append({"sql": c.cleaned_sql, "cls": c, "line": line})
    return planned


def confirm_detail(planned: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The 409 body asking the user to confirm every statement that writes."""
    risky = [p for p in planned if p["cls"].is_destructive]
    multi = len(planned) > 1
    warnings = [
        (f"Statement {planned.index(p) + 1}: " if multi else "") + p["cls"].warning
        for p in risky if p["cls"].warning
    ]
    if len(risky) == 1:
        kind = risky[0]["cls"].lead_keyword
        a = "an" if kind[:1] in "AEIOU" else "a"
        message = f"This run includes {a} {kind} statement that will modify data or schema." if multi else \
            f"This is {a} {kind} statement and will modify data or schema."
    else:
        kind = ", ".join(dict.fromkeys(p["cls"].lead_keyword for p in risky))
        message = f"{len(risky)} statements in this run will modify data or schema ({kind})."
    return {
        "message": message,
        "requires_confirmation": True,
        "statement_type": kind,
        "count": len(risky),
        "warning": "\n".join(warnings) or None,
    }


def failed_at(message: str, planned: List[Dict[str, Any]], k: int) -> str:
    """Error text for statement k of a multi-statement run. The footer is what
    the editor reads to jump to the right line."""
    if len(planned) <= 1:
        return message
    return f"{message}\n\nStatement {k + 1} of {len(planned)}, starting on line {planned[k]['line'] + 1}."


def _statement_result(st: Dict[str, Any], k: int, started: float, status: str, **extra) -> Dict[str, Any]:
    """One line of the per-statement summary shown in the Details tab."""
    return {
        "index": k + 1,
        "line": st["line"] + 1,
        "statement_type": st["cls"].lead_keyword if st.get("cls") else None,
        "status": status,
        "elapsed_ms": int((time.time() - started) * 1000),
        "sql": st["sql"][:300],
        **extra,
    }


# ============================================================================
# Result-set filtering, shared by query results and the table data editor
# ============================================================================

TEXT_OPS = {"contains", "not_contains", "starts", "ends"}
NULL_OPS = {"is_null", "is_not_null"}
COMPARE_OPS = {"eq", "neq", "gt", "gte", "lt", "lte"}
SET_OPS = {"in", "not_in"}
ALL_OPS = TEXT_OPS | NULL_OPS | COMPARE_OPS | SET_OPS


class ColumnFilter(BaseModel):
    col: str
    op: str
    value: Optional[Any] = None
    values: Optional[List[Any]] = None


def build_where(filters: Optional[List[ColumnFilter]], valid_columns: Optional[List[str]] = None):
    """Turns UI filters into a WHERE fragment plus its bound parameters. Column
    names are validated against the result's own columns and then quoted;
    values are always bound, never interpolated."""
    if not filters:
        return "", []
    valid_set = set(valid_columns) if valid_columns else None
    clauses: List[str] = []
    params: List[Any] = []
    for f in filters:
        op = (f.op or "").lower()
        if op not in ALL_OPS:
            raise HTTPException(status_code=400, detail=f"Unsupported filter operator '{f.op}'")
        if valid_set is not None and f.col not in valid_set:
            raise HTTPException(status_code=400, detail=f"'{f.col}' is not a column of this result")
        col = quote_ident(f.col)
        if op == "is_null":
            clauses.append(f"{col} IS NULL")
        elif op == "is_not_null":
            clauses.append(f"{col} IS NOT NULL")
        elif op in TEXT_OPS:
            text = "" if f.value is None else str(f.value)
            # ESCAPE '\' so a literal % or _ typed in the filter box stays literal.
            pattern = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            if op == "contains":
                clauses.append(f"TO_VARCHAR({col}) ILIKE ? ESCAPE '\\\\'")
                params.append(f"%{pattern}%")
            elif op == "not_contains":
                clauses.append(f"(TO_VARCHAR({col}) NOT ILIKE ? ESCAPE '\\\\' OR {col} IS NULL)")
                params.append(f"%{pattern}%")
            elif op == "starts":
                clauses.append(f"TO_VARCHAR({col}) ILIKE ? ESCAPE '\\\\'")
                params.append(f"{pattern}%")
            else:
                clauses.append(f"TO_VARCHAR({col}) ILIKE ? ESCAPE '\\\\'")
                params.append(f"%{pattern}")
        elif op in SET_OPS:
            values = f.values if f.values is not None else ([f.value] if f.value is not None else [])
            if not values:
                raise HTTPException(status_code=400, detail=f"Filter on '{f.col}' needs at least one value")
            if len(values) > 1000:
                raise HTTPException(status_code=400, detail="An IN filter is limited to 1000 values")
            placeholders = ", ".join("?" for _ in values)
            negate = "NOT " if op == "not_in" else ""
            clauses.append(f"TO_VARCHAR({col}) {negate}IN ({placeholders})")
            params.extend("" if v is None else str(v) for v in values)
        else:
            sql_op = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            if op == "eq" and f.value is None:
                clauses.append(f"{col} IS NULL")
                continue
            if op == "neq" and f.value is None:
                clauses.append(f"{col} IS NOT NULL")
                continue
            # Compared as text so the same filter works against any column type
            # without the caller having to know the column's declared type. A
            # number in a range filter is compared as a number, or 9 sorts after 10.
            if op in ("gt", "gte", "lt", "lte") and re.match(r"^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$", str(f.value or "")):
                clauses.append(f"TRY_TO_DOUBLE(TO_VARCHAR({col})) {sql_op} ?")
                params.append(float(str(f.value).strip()))
                continue
            clauses.append(f"TO_VARCHAR({col}) {sql_op} ?")
            params.append("" if f.value is None else str(f.value))
    if not clauses:
        return "", []
    return " WHERE " + " AND ".join(clauses), params


def build_order_by(sort: Optional[List[Dict[str, str]]], valid_columns: Optional[List[str]] = None) -> str:
    if not sort:
        return ""
    valid_set = set(valid_columns) if valid_columns else None
    parts = []
    for entry in sort:
        col = entry.get("col")
        direction = (entry.get("dir") or "asc").lower()
        if direction not in ("asc", "desc"):
            raise HTTPException(status_code=400, detail="Sort direction must be 'asc' or 'desc'")
        if not col:
            continue
        if valid_set is not None and col not in valid_set:
            raise HTTPException(status_code=400, detail=f"'{col}' is not a column of this result")
        parts.append(f"{quote_ident(col)} {'ASC' if direction == 'asc' else 'DESC'} NULLS LAST")
    return (" ORDER BY " + ", ".join(parts)) if parts else ""
