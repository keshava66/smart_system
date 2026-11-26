from __future__ import annotations

import csv
import difflib
import io
import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import db
import shared_worksheets
from auth import require_permission
from snowflake_sql import (
    PROFILE_MAX_COLUMNS, profile_dist_sql, profile_family, profile_finish, profile_rows, profile_stats, profile_stats_sql,
    quote_ident, qualified, _to_json_safe, _flatten_for_text, _strip_sql_comments, SqlClassification,
    plan_statements, confirm_detail, failed_at, _statement_result, ColumnFilter,
    build_where, build_order_by,
)

logger = logging.getLogger(__name__)

snowflake_router = APIRouter(prefix="/api/snowflake", tags=["Data Studio - Snowflake"])

# Wired in from app.py via set_snowflake_dependencies()
_config: Optional[Dict[str, Any]] = None
_fallback_config: Optional[Dict[str, Any]] = None

# Workspace (history / saved queries) lives in the portal database:
# smarthub_core.sf_query_history and sf_saved_queries.

# ============================================================================
# Config
# ============================================================================

DEFAULT_STATEMENT_TIMEOUT_SECONDS = 300      # per query unless the caller overrides
MAX_STATEMENT_TIMEOUT_SECONDS = 3600         # hard cap regardless of what's asked for
DEFAULT_MAX_CONCURRENT_JOBS = 6              # dedicated connections held at once
DEFAULT_JOB_TTL_SECONDS = 45 * 60            # jobs get GC'd after this
JOB_IDLE_RELEASE_SECONDS = 120               # a job nobody is paging gives its connection back
ROWS_PAGE_MAX_SIZE = 1000                    # on-screen paging cap
DOWNLOAD_CHUNK_ROWS = 10_000                 # rows per fetchmany while streaming a download
XLSX_MAX_ROWS = 1_048_575                    # Excel's own sheet limit, minus the header
META_CACHE_TTL_SECONDS = 300                 # explorer cache
HISTORY_KEEP_PER_USER = 500                  # trimmed on write
COPY_STATEMENT_TIMEOUT_SECONDS = 4 * 60 * 60   # a copy statement may run this long before Snowflake stops it


def _clean_cfg(value):
    """Trim whitespace and stray wrapping quotes off a config string.

    Config values get pasted by hand, and a leftover quote or trailing space in
    something like the account identifier turns into a %22 in the login URL and
    a DNS failure that reads like a network outage. Cheap to strip, miserable
    to debug otherwise."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    while len(text) >= 2 and text[0] == text[-1] and text[0] in ("\"", "'"):
        text = text[1:-1].strip()
    return text.strip("\"'").strip()


def _cfg_value(key: str, env_var: str, default=None):
    if _config and _config.get(key) not in (None, ""):
        return _clean_cfg(_config[key])
    if os.environ.get(env_var):
        return _clean_cfg(os.environ[env_var])
    if _fallback_config and _fallback_config.get(key) not in (None, ""):
        return _clean_cfg(_fallback_config[key])
    return default


def _raw_cfg_value(key: str, env_var: str, default=None):
    """Same lookup as _cfg_value but byte-for-byte - secrets are allowed to
    start or end with a quote."""
    if _config and _config.get(key) not in (None, ""):
        return _config[key]
    if os.environ.get(env_var):
        return os.environ[env_var]
    if _fallback_config and _fallback_config.get(key) not in (None, ""):
        return _fallback_config[key]
    return default


def _configured() -> bool:
    return bool(_config or _fallback_config or os.environ.get("SFQR_ACCOUNT"))


# ============================================================================
# Credential profiles
#
# Most deployments run on one Snowflake login. Some can't: the role that can
# read the source schemas is not the role that can write to the target one.
# A write profile - the "sqrn_write" block inside snowflake_query_runner, or
# SFQRW_* env vars - covers that. Anything it leaves out falls back to the read
# profile, so the block can be as small as a different user and role.
#
# Nothing changes for a deployment without one: every connection is the read
# profile, which is the config that was always there.
# ============================================================================

READ_PROFILE = "read"
WRITE_PROFILE = "write"


# The block is "sqrn_write" in dq_config.json; "write" is still read so an
# existing config keeps working.
WRITE_SECTION_KEYS = ("sqrn_write", "write")


def _write_section() -> Optional[Dict[str, Any]]:
    if not _config:
        return None
    for key in WRITE_SECTION_KEYS:
        section = _config.get(key)
        if isinstance(section, dict) and section:
            return section
    return None


def _write_configured() -> bool:
    """True when writes are meant to go through a second login. Env vars alone
    are enough - SFQRW_USER with no config block is a valid setup."""
    if _write_section():
        return True
    return any(os.environ.get(var) for var in ("SFQRW_ACCOUNT", "SFQRW_USER", "SFQRW_ROLE"))


def _write_cfg_value(key: str, env_var: str, raw: bool = False):
    section = _write_section()
    if section and section.get(key) not in (None, ""):
        return section[key] if raw else _clean_cfg(section[key])
    if os.environ.get(env_var):
        return os.environ[env_var] if raw else _clean_cfg(os.environ[env_var])
    return None


def _require_config() -> Dict[str, Any]:
    if not _configured():
        raise HTTPException(
            status_code=503,
            detail="Data Studio (Snowflake) is not configured - add a 'snowflake_query_runner' section to dq_config.json",
        )
    cfg = {
        "account": _cfg_value("account", "SFQR_ACCOUNT"),
        "user": _cfg_value("user", "SFQR_USER"),
        "password": _raw_cfg_value("password", "SFQR_PASSWORD"),
        "private_key_path": _key_path(_cfg_value("private_key_path", "SFQR_PRIVATE_KEY_PATH")),
        "private_key_password": _raw_cfg_value("private_key_password", "SFQR_PRIVATE_KEY_PASSWORD", ""),
        "role": _cfg_value("role", "SFQR_ROLE"),
        "warehouse": _cfg_value("warehouse", "SFQR_WAREHOUSE"),
        "database": _cfg_value("database", "SFQR_DATABASE"),
        "schema": _cfg_value("schema", "SFQR_SCHEMA"),
        "statement_timeout_seconds": int(_cfg_value("statement_timeout_seconds", "SFQR_STATEMENT_TIMEOUT", DEFAULT_STATEMENT_TIMEOUT_SECONDS)),
        "max_statement_timeout_seconds": int(_cfg_value("max_statement_timeout_seconds", "SFQR_MAX_STATEMENT_TIMEOUT", MAX_STATEMENT_TIMEOUT_SECONDS)),
        "max_concurrent_jobs": int(_cfg_value("max_concurrent_jobs", "SFQR_MAX_CONCURRENT_JOBS", DEFAULT_MAX_CONCURRENT_JOBS)),
        "job_ttl_seconds": int(_cfg_value("job_ttl_seconds", "SFQR_JOB_TTL_SECONDS", DEFAULT_JOB_TTL_SECONDS)),
        "login_timeout": int(_cfg_value("login_timeout_seconds", "SFQR_LOGIN_TIMEOUT", 30)),
        # Cloning a whole schema or moving a large table is not a 5 minute job.
        "copy_timeout_seconds": int(_cfg_value("copy_timeout_seconds", "SFQR_COPY_TIMEOUT", COPY_STATEMENT_TIMEOUT_SECONDS)),
        # Turning this off makes the whole page read-only, no matter what the
        # caller's RBAC role says. Belt and braces for prod deployments.
        "allow_writes": _cfg_value("allow_writes", "SFQR_ALLOW_WRITES", True) not in (False, "false", "False", 0, "0"),
    }
    numbered = numbered_sections(_config)
    if numbered and not cfg["user"]:
        # Only numbered users: the first one is the default login (and the copier's read login).
        first = next(iter(numbered.values()))
        for key in ("account", "user", "role", "warehouse", "database", "schema"):
            if first.get(key) not in (None, ""):
                cfg[key] = _clean_cfg(first[key])
        key = first.get("private_key") or first.get("private_key_path")
        cfg["password"] = first.get("password")
        cfg["private_key_path"] = _key_path(_clean_cfg(key)) if key else None
        cfg["private_key_password"] = first.get("private_key_password") or cfg["private_key_password"]
        if not cfg["role"] and _as_list(first.get("roles")):
            cfg["role"] = _as_list(first.get("roles"))[0]
    if not cfg["account"] or not cfg["user"]:
        raise HTTPException(status_code=503, detail="Data Studio (Snowflake) config is missing 'account' or 'user'")
    if not cfg["password"] and not cfg["private_key_path"]:
        raise HTTPException(status_code=503, detail="Data Studio (Snowflake) config needs either 'password' or 'private_key_path'")
    return cfg


# ============================================================================
# Numbered connections (user_1, private_key_1, roles_1, warehouse_1, label_1...)
#
# Each number with a user is one login in the worksheet's connection dropdown.
# Keys without a number are shared. Postgres reads its numbered keys with the
# same parser. A worksheet's login and role travel as a profile string
# "c:<n>|<role>", which keeps them in every pool and cache key for free.
# ============================================================================

_NUMBERED_KEY = re.compile(r"^(.+?)_?(\d+)$")
CONN_PREFIX = "c:"


def numbered_sections(section: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """{"1": {"user": .., "password": ..}, "2": {...}} from user_1 / user1 style
    keys, in number order. Only numbers that have a user count."""
    found: Dict[str, Dict[str, Any]] = {}
    for key, value in (section or {}).items():
        m = _NUMBERED_KEY.match(str(key))
        if m and value not in (None, ""):
            found.setdefault(str(int(m.group(2))), {})[m.group(1)] = value
    return {n: found[n] for n in sorted(found, key=int) if found[n].get("user")}


def _as_list(value) -> List[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v).strip() for v in value if str(v).strip()]


def _key_path(path: Optional[str]) -> Optional[str]:
    """A bare file name is looked up in private_key_path_base."""
    if not path:
        return path
    base = _cfg_value("private_key_path_base", "SFQR_PRIVATE_KEY_PATH_BASE")
    return str(Path(base) / path) if base and not Path(path).is_absolute() else path


def conn_profile(conn_id: Optional[str], role: Optional[str]) -> str:
    """Profile string for a worksheet's login and role. Validates both."""
    numbered = numbered_sections(_config)
    if conn_id in (None, "", "default"):
        if not numbered:
            return f"{CONN_PREFIX}default|{role}" if role else READ_PROFILE
        conn_id = next(iter(numbered))
    if conn_id not in numbered:
        raise HTTPException(status_code=400, detail=f"Unknown connection '{conn_id}'")
    allowed = _as_list(numbered[conn_id].get("roles"))
    if role and allowed and role.upper() not in {r.upper() for r in allowed}:
        raise HTTPException(status_code=400, detail=f"Role {role} is not in the roles configured for this connection")
    return f"{CONN_PREFIX}{conn_id}|{role or ''}"


def _numbered_config(conn_id: str, role: Optional[str]) -> Dict[str, Any]:
    cfg = dict(_require_config())
    n = numbered_sections(_config).get(conn_id)
    if n is None and conn_id != "default":
        raise HTTPException(status_code=400, detail=f"Unknown connection '{conn_id}'")
    if n:
        # Start from the shared (unnumbered) keys, not from whichever user filled the defaults.
        for key, env in (("account", "SFQR_ACCOUNT"), ("user", "SFQR_USER"), ("role", "SFQR_ROLE"),
                         ("warehouse", "SFQR_WAREHOUSE"), ("database", "SFQR_DATABASE"), ("schema", "SFQR_SCHEMA")):
            cfg[key] = _clean_cfg(n[key]) if n.get(key) not in (None, "") else _cfg_value(key, env)
        for key in ("statement_timeout_seconds", "max_statement_timeout_seconds"):
            if key in n:
                cfg[key] = int(n[key])
        if "allow_writes" in n:
            cfg["allow_writes"] = n["allow_writes"] not in (False, "false", "False", 0, "0")
        # Credentials as a set, like the write profile: a user with its own key
        # or password never borrows another user's. The passphrase can be shared.
        key = n.get("private_key") or n.get("private_key_path")
        if key or n.get("password"):
            cfg["password"] = n.get("password")
            cfg["private_key_path"] = _key_path(_clean_cfg(key)) if key else None
            cfg["private_key_password"] = n.get("private_key_password") or _raw_cfg_value(
                "private_key_password", "SFQR_PRIVATE_KEY_PASSWORD", "")
        cfg["label"] = n.get("label") or cfg["user"]
        cfg["roles"] = _as_list(n.get("roles"))
    else:
        cfg["label"] = (_config or {}).get("label") or cfg["user"]
        cfg["roles"] = _as_list((_config or {}).get("roles"))
    if role:
        cfg["role"] = role
    elif cfg["roles"] and (not n or not n.get("role")):
        cfg["role"] = cfg["roles"][0]
    if not cfg["account"]:
        raise HTTPException(status_code=503, detail=f"Connection {conn_id} has no 'account'")
    cfg["conn_id"] = conn_id
    return cfg


def connections() -> List[Dict[str, Any]]:
    """What the connection dropdown lists. Never includes secrets."""
    out = []
    for cid in list(numbered_sections(_config)) or ["default"]:
        c = _numbered_config(cid, None)
        out.append({"id": cid, "label": c["label"], "user": c["user"], "account": c["account"],
                    "role": c["role"], "roles": c["roles"], "warehouse": c["warehouse"],
                    "default_database": c["database"], "default_schema": c["schema"],
                    "allow_writes": c["allow_writes"]})
    return out


def _profile_config(profile: str = READ_PROFILE) -> Dict[str, Any]:
    """The connection settings for one profile. The write profile is the read
    config with its own keys laid over the top. A "c:<n>|<role>" profile is a
    numbered login, optionally switched to another role."""
    if profile and profile.startswith(CONN_PREFIX):
        cid, _, role = profile[len(CONN_PREFIX):].partition("|")
        return _numbered_config(cid, role or None)
    cfg = _require_config()
    if profile != WRITE_PROFILE or not _write_configured():
        return cfg

    write = dict(cfg)
    for key, env_var in (
        ("account", "SFQRW_ACCOUNT"),
        ("user", "SFQRW_USER"),
        ("role", "SFQRW_ROLE"),
        ("warehouse", "SFQRW_WAREHOUSE"),
        ("database", "SFQRW_DATABASE"),
        ("schema", "SFQRW_SCHEMA"),
        ("private_key_path", "SFQRW_PRIVATE_KEY_PATH"),
    ):
        value = _write_cfg_value(key, env_var)
        if value not in (None, ""):
            write[key] = value

    # Credentials are taken as a set: a write profile that names a password or
    # a key file uses only its own, so a half-filled block can never end up
    # pairing the read user with the write password.
    password = _write_cfg_value("password", "SFQRW_PASSWORD", raw=True)
    key_path = _write_cfg_value("private_key_path", "SFQRW_PRIVATE_KEY_PATH")
    key_password = _write_cfg_value("private_key_password", "SFQRW_PRIVATE_KEY_PASSWORD", raw=True)
    if password or key_path:
        write["password"] = password
        write["private_key_path"] = key_path
        write["private_key_password"] = key_password or ""

    if not write["password"] and not write["private_key_path"]:
        raise HTTPException(
            status_code=503,
            detail="The Snowflake write profile needs either 'password' or 'private_key_path'",
        )
    return write


def _profile_label(profile: str) -> str:
    cfg = _profile_config(profile)
    return f"{cfg['user']}" + (f"/{cfg['role']}" if cfg.get("role") else "")


def set_snowflake_dependencies(config: Optional[Dict[str, Any]], fallback: Optional[Dict[str, Any]] = None):
    """Called once from app.py. `config` is the 'snowflake_query_runner' section;
    `fallback` is the main 'snowflake' section, used for any key the runner
    section leaves out so a minimal config still works."""
    global _config, _fallback_config
    _config = config
    _fallback_config = fallback
    if not _configured():
        logger.warning("⚠️ snowflake_query_runner config not found - Data Studio Snowflake endpoints will be unavailable")
    else:
        _init_db()
        _pool.warm()


# ============================================================================
# Connections
# ============================================================================

_private_key_cache: Dict[str, bytes] = {}
_private_key_lock = threading.Lock()


def _load_private_key(path: str, password: str) -> bytes:
    """DER-encoded PKCS8 bytes, cached by (path, mtime) so we're not re-reading
    and re-deriving the key on every single connection."""
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization

    key_file = Path(path)
    if not key_file.exists():
        raise HTTPException(status_code=503, detail=f"Snowflake private key not found at {path}")
    cache_key = f"{path}:{key_file.stat().st_mtime_ns}"
    with _private_key_lock:
        cached = _private_key_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        with open(key_file, "rb") as f:
            p_key = serialization.load_pem_private_key(
                f.read(),
                password=password.encode() if password else None,
                backend=default_backend(),
            )
        der = p_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not load Snowflake private key: {e}")
    with _private_key_lock:
        _private_key_cache.clear()
        _private_key_cache[cache_key] = der
    return der


def _connect(database: Optional[str] = None, schema: Optional[str] = None, warehouse: Optional[str] = None,
             profile: str = READ_PROFILE):
    """Fresh Snowflake connection. Imported lazily so the module still imports
    in environments without the connector installed."""
    import snowflake.connector

    cfg = _profile_config(profile)
    kwargs: Dict[str, Any] = {
        "account": cfg["account"],
        "user": cfg["user"],
        "login_timeout": cfg["login_timeout"],
        # No network_timeout on purpose. It is not a login setting: the
        # connector applies it to every statement and cancels the query from
        # the client side when it elapses - which is how a 30 second login
        # timeout turned into "SQL execution was cancelled by the client due to
        # a timeout" on any query that ran longer than half a minute. How long
        # a statement may run is Snowflake's business, set per session with
        # STATEMENT_TIMEOUT_IN_SECONDS below.
        "application": "SmartHub_SnowflakeQueryRunner",
        "client_session_keep_alive": True,
        # We only ever bind values, never identifiers, and Snowflake's
        # client-side binding is what makes the value/identifier split real.
        "paramstyle": "qmark",
    }
    if cfg["private_key_path"]:
        kwargs["private_key"] = _load_private_key(cfg["private_key_path"], cfg["private_key_password"] or "")
    else:
        kwargs["password"] = cfg["password"]
    for key, val in (
        ("role", cfg["role"]),
        ("warehouse", warehouse or cfg["warehouse"]),
        ("database", database or cfg["database"]),
        ("schema", schema or cfg["schema"]),
    ):
        if val:
            kwargs[key] = val
    try:
        conn = snowflake.connector.connect(**kwargs)
        conn._sh_profile = profile      # which login, so a cancel can come from the same user
        return conn
    except HTTPException:
        raise
    except Exception as e:
        text = str(e)
        if "getaddrinfo" in text or "NameResolutionError" in text or "Failed to resolve" in text:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Snowflake host {cfg['account']}.snowflakecomputing.com could not be resolved. "
                    "That is almost always a malformed 'account' in the config (a stray quote, a full "
                    "URL instead of the identifier, or the wrong region suffix) rather than a network fault."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Could not connect to Snowflake: {e}")


def _apply_statement_timeout(conn, cur, seconds: int):
    """Set STATEMENT_TIMEOUT_IN_SECONDS for this session.

    Pooled sessions remember what they were last set to, so the extra round
    trip only happens when the value actually changes."""
    wanted = max(1, int(seconds))
    if getattr(conn, "_sfqr_timeout", None) == wanted:
        return
    try:
        cur.execute(f"ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = {wanted}")
        try:
            conn._sfqr_timeout = wanted
        except Exception:
            pass
    except Exception as e:
        logger.info("Could not set STATEMENT_TIMEOUT_IN_SECONDS: %s", e)


def _closed(conn) -> bool:
    try:
        return bool(conn.is_closed())
    except Exception:
        return False


def _doom(conn):
    """A session that was sent a cancel is closed when released, never pooled:
    a cancel landing late must not stop the next user's query on it."""
    try:
        conn._sh_doomed = True
    except Exception:
        pass


def _cancel_session_queries(conn):
    """Stop whatever is running on this connection's session. The cursor has no
    cancel(), and a statement's query id only arrives once it has finished, so
    SYSTEM$CANCEL_ALL_QUERIES on the session is the one thing that stops it
    from the first second. It runs on another session of the same login."""
    session_id = getattr(conn, "session_id", None)
    if not session_id:
        return
    _doom(conn)
    try:
        with _pooled(profile=getattr(conn, "_sh_profile", READ_PROFILE)) as side:
            cur = side.cursor()
            try:
                cur.execute("SELECT SYSTEM$CANCEL_ALL_QUERIES(?)", (session_id,))
            finally:
                cur.close()
    except Exception as e:
        logger.info("Cancelling Snowflake session %s failed: %s", session_id, e)


def _quiet_close(conn):
    if conn is None:
        return
    try:
        conn.close()
    except Exception:
        pass


_STALE_MARKERS = (
    "connection is closed", "not connected", "connection was closed", "broken pipe",
    "closed database", "closed connection", "already closed",
    "connection reset", "connection aborted", "eof occurred", "session no longer exists",
    "authentication token has expired", "session expired", "socket", "timed out",
)


def _looks_stale(e: Exception) -> bool:
    text = str(e).lower()
    return any(marker in text for marker in _STALE_MARKERS)


class _ConnectionPool:
    """Warm Snowflake connections, reused across requests.

    A Snowflake login is the single most expensive thing this module does -
    roughly a second of TLS plus authentication, which used to be paid on every
    query, every page of a table and every explorer click. Handing out an
    already-authenticated session instead is what makes the page feel instant.

    Connections are keyed by (database, schema, warehouse) because those are set
    at login. Idle ones are retired well before Snowflake's own session timeout
    so a checkout never hands back a dead socket.
    """

    MAX_AGE = 55 * 60          # retire before Snowflake's default session timeout
    MAX_IDLE_PER_KEY = 4       # per (database, schema, warehouse)

    def __init__(self):
        self._idle: Dict[tuple, List[tuple]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(database, schema, warehouse, profile=READ_PROFILE):
        # The profile is part of the key: two logins are two different sets of
        # sessions, and handing a write session to a read caller (or the other
        # way round) would silently run it as the wrong role.
        return (profile or READ_PROFILE, database or "", schema or "", warehouse or "")

    def acquire(self, database=None, schema=None, warehouse=None, profile=READ_PROFILE):
        key = self._key(database, schema, warehouse, profile)
        while True:
            with self._lock:
                bucket = self._idle.get(key)
                if not bucket:
                    break
                conn, created = bucket.pop()
            # is_closed() is a local flag, no round trip.
            if time.time() - created > self.MAX_AGE or _closed(conn):
                _quiet_close(conn)
                continue
            return conn, key, created
        return _connect(database, schema, warehouse, profile), key, time.time()

    def release(self, conn, key, created):
        if conn is None:
            return
        if time.time() - created > self.MAX_AGE or getattr(conn, "_sh_doomed", False):
            _quiet_close(conn)
            return
        with self._lock:
            bucket = self._idle.setdefault(key, [])
            if len(bucket) >= self.MAX_IDLE_PER_KEY:
                spare = True
            else:
                bucket.append((conn, created))
                spare = False
        if spare:
            _quiet_close(conn)

    def warm(self, count=2):
        """Open a couple of connections in the background at startup so the
        first person to hit the page doesn't pay for the login."""
        def _open():
            try:
                conn, key, created = self.acquire()
                self.release(conn, key, created)
            except Exception as e:
                logger.info("Snowflake pool warm-up skipped: %s", e)
        for _ in range(count):
            threading.Thread(target=_open, daemon=True).start()

    def close_all(self):
        with self._lock:
            buckets = list(self._idle.values())
            self._idle.clear()
        for bucket in buckets:
            for conn, _created in bucket:
                _quiet_close(conn)


_pool = _ConnectionPool()


@contextmanager
def _pooled(database=None, schema=None, warehouse=None, profile=READ_PROFILE):
    """Check a connection out of the pool for the duration of the block. A
    connection that errors is dropped rather than handed to the next caller."""
    conn, key, created = _pool.acquire(database, schema, warehouse, profile)
    ok = True
    try:
        yield conn
    except Exception as e:
        ok = not _looks_stale(e)
        raise
    finally:
        if ok:
            _pool.release(conn, key, created)
        else:
            _quiet_close(conn)


def _run_meta(fn, profile: str = READ_PROFILE):
    """Run a catalog query on a pooled connection, retrying once on a stale
    session. Metadata calls no longer share one serialized connection, so the
    explorer tree can expand several nodes in parallel."""
    for attempt in (0, 1):
        conn, key, created = _pool.acquire(profile=profile)
        cur = None
        try:
            cur = conn.cursor()
            result = fn(cur)
            cur.close()
            _pool.release(conn, key, created)
            return result
        except Exception as e:
            if cur is not None:
                try:
                    cur.close()
                except Exception:
                    pass
            if attempt == 0 and _looks_stale(e):
                _quiet_close(conn)
                continue
            if _looks_stale(e):
                _quiet_close(conn)
            else:
                _pool.release(conn, key, created)
            raise


# ============================================================================
# Tiny in-process TTL cache for explorer metadata.
# ============================================================================

_cache: Dict[str, tuple] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, payload = entry
        if time.time() - ts > META_CACHE_TTL_SECONDS:
            return None
        return payload


def _cache_set(key: str, payload: Any):
    with _cache_lock:
        _cache[key] = (time.time(), payload)
        if len(_cache) > 2000:
            oldest = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest, None)


def _cache_drop_prefix(prefix: str):
    with _cache_lock:
        for key in [k for k in _cache if k.startswith(prefix)]:
            _cache.pop(key, None)


def _drop_table_cache(database: str, schema: str):
    """A schema that just gained a table is stale under every profile that can
    see it, not only the one that wrote it."""
    for profile in (READ_PROFILE, WRITE_PROFILE):
        _cache_drop_prefix(f"sf-tables:{profile}:{database}:{schema}")


def _guard_writes_allowed(classification: SqlClassification):
    cfg = _require_config()
    if classification.is_destructive and not cfg["allow_writes"]:
        raise HTTPException(
            status_code=403,
            detail="This deployment's Data Studio (Snowflake) is configured read-only (allow_writes = false)",
        )


# ============================================================================
# Job registry
# ============================================================================

_executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix="sfqr")
_job_slots = threading.Semaphore(DEFAULT_MAX_CONCURRENT_JOBS)
_job_slots_size = DEFAULT_MAX_CONCURRENT_JOBS
_job_slots_lock = threading.Lock()

_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


class _Cancelled(Exception):
    pass


def _resize_job_slots(new_size: int):
    global _job_slots, _job_slots_size
    with _job_slots_lock:
        if new_size != _job_slots_size:
            _job_slots = threading.Semaphore(new_size)
            _job_slots_size = new_size


def _new_job(classification: SqlClassification, database: Optional[str], schema: Optional[str],
             warehouse: Optional[str], timeout_seconds: int, owner: str) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "owner": (owner or "").strip().lower(),
        "sql": classification.cleaned_sql,
        "database": database,
        "schema": schema,
        "warehouse": warehouse,
        "lead_keyword": classification.lead_keyword,
        "is_destructive": classification.is_destructive,
        "returns_rows": classification.returns_rows,
        "timeout_seconds": timeout_seconds,
        "status": "running",           # running | success | failed | cancelled
        "conn": None,
        "pool_key": None,             # so the connection goes back to the pool, not the bin
        "pool_created": 0.0,
        "done": threading.Event(),    # lets a caller wait for a fast query inline
        "cursor": None,               # live cursor while running, for cancel()
        "query_id": None,
        "columns": None,               # [{name, type}]
        "row_count": None,
        "rows_affected": None,
        "error": None,
        "created_at": time.time(),
        "last_used": time.time(),
        "started_at": time.time(),
        "finished_at": None,
        "job_lock": threading.Lock(),
        "cancel_requested": False,
        # Materialized results, used when RESULT_SCAN can't be (duplicate
        # column names, SHOW commands, expired result cache).
        "inline_rows": None,
        "profile": READ_PROFILE,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    return job


def _touch(job: Dict[str, Any]) -> Dict[str, Any]:
    job["last_used"] = time.time()
    return job


def _get_job(job_id: str, owner: Optional[str] = None, shared: bool = False) -> Dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or expired query job")
    # Jobs hold a live Snowflake connection and a result set; only the person
    # who started one can read it back. The exception (shared=True: status,
    # rows, download) is a job run into a shared worksheet, which the other
    # people in that worksheet can read too.
    if owner is not None and job["owner"] and job["owner"] != (owner or "").strip().lower():
        if not (shared and job.get("shared_ws") and shared_worksheets.is_member(job["shared_ws"], owner)):
            raise HTTPException(status_code=404, detail="Unknown or expired query job")
    return _touch(job)


# Statements that change the session itself. A connection that ran one is
# closed instead of going back to the pool, or the next person's query (any
# user) would run with this one's role, database, settings or open transaction.
_SESSION_CHANGE = re.compile(
    r"^\s*(USE|ALTER\s+SESSION|SET|UNSET|BEGIN|START\s+TRANSACTION|CALL|EXECUTE\s+IMMEDIATE|DECLARE"
    # Temporary tables, stages, file formats... live in the session, so the next
    # person handed it could read them.
    r"|CREATE\s+(OR\s+REPLACE\s+)?((LOCAL|GLOBAL)\s+)?(TEMP|TEMPORARY|VOLATILE))\b",
    re.IGNORECASE)


def _close_job(job: Dict[str, Any]):
    """Hand the job's connection back to the pool so the next query reuses the
    warm session instead of logging in again."""
    conn = job.get("conn")
    if conn is not None and job.get("dirty_session"):
        _quiet_close(conn)
    elif conn is not None:
        _pool.release(conn, job.get("pool_key") or _ConnectionPool._key(job["database"], job["schema"], job["warehouse"], job["profile"]),
                      job.get("pool_created") or time.time())
    job["conn"] = None


def cleanup_jobs():
    ttl = DEFAULT_JOB_TTL_SECONDS
    if _configured():
        try:
            ttl = _require_config()["job_ttl_seconds"]
        except HTTPException:
            pass
    now = time.time()
    cutoff = now - ttl
    with _jobs_lock:
        stale = [jid for jid, j in _jobs.items() if j["created_at"] < cutoff]
        # A finished query nobody is paging through has no reason to sit on a
        # Snowflake session. Give it back; the next page reacquires one and
        # reads the same result via RESULT_SCAN.
        idle = [j for j in _jobs.values()
                if j.get("conn") is not None
                and j["status"] != "running"
                and now - j.get("last_used", 0) > JOB_IDLE_RELEASE_SECONDS]
    for job in idle:
        _close_job(job)
    for jid in stale:
        with _jobs_lock:
            job = _jobs.pop(jid, None)
        if job:
            _close_job(job)


def _describe_columns(cur) -> List[Dict[str, str]]:
    """Column names plus a readable Snowflake type, straight off the cursor
    description so it costs nothing extra."""
    out = []
    for d in (cur.description or []):
        name = d[0]
        type_code = d[1]
        try:
            from snowflake.connector.constants import FIELD_ID_TO_NAME
            type_name = FIELD_ID_TO_NAME.get(type_code, str(type_code))
        except Exception:
            type_name = str(type_code)
        internal_size = d[3] if len(d) > 3 else None
        precision = d[4] if len(d) > 4 else None
        scale = d[5] if len(d) > 5 else None
        out.append({
            "name": name,
            "type": type_name,
            "display_type": _display_type(type_name, internal_size, precision, scale),
        })
    return out


def _display_type(type_name, internal_size, precision, scale) -> str:
    """Connector names (FIXED, TEXT, REAL) turned into what Snowsight shows:
    NUMBER(38,0), VARCHAR(16777216), FLOAT, TIMESTAMP_NTZ(9)."""
    t = (type_name or "").upper()
    if t == "FIXED":
        return f"NUMBER({precision},{scale or 0})" if precision is not None else "NUMBER"
    if t == "REAL":
        return "FLOAT"
    if t == "TEXT":
        return f"VARCHAR({internal_size})" if internal_size else "VARCHAR"
    if t == "BINARY":
        return f"BINARY({internal_size})" if internal_size else "BINARY"
    if t in ("TIME", "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "TIMESTAMP_TZ") and scale is not None:
        return f"{t}({scale})"
    return t


def _has_duplicate_columns(columns: List[Dict[str, str]]) -> bool:
    names = [c["name"] for c in columns]
    return len(names) != len(set(names))


def _capture_rows(job: Dict[str, Any], conn, cur):
    """Columns and row count of the result the cursor just produced."""
    columns = _describe_columns(cur)
    job["columns"] = columns
    row_count = cur.rowcount
    # SHOW/DESC and anything with duplicate output column names can't
    # be re-read through RESULT_SCAN by name, so those get materialized
    # once here and paged from memory instead.
    needs_inline = (
        job["lead_keyword"] in ("SHOW", "DESC", "DESCRIBE", "LIST", "LS")
        or _has_duplicate_columns(columns)
    )
    if needs_inline:
        rows = cur.fetchall()
        job["inline_rows"] = [[_to_json_safe(v) for v in r] for r in rows]
        job["columns"] = _dedupe_columns(columns)
        job["row_count"] = len(job["inline_rows"])
    else:
        if row_count is None or row_count < 0:
            row_count = _result_scan_count(conn, job["query_id"])
        job["row_count"] = row_count
    job["rows_affected"] = None


def _statement_job(job: Dict[str, Any], st: Dict[str, Any], query_id: str) -> Dict[str, Any]:
    """A finished job for one statement of a multi-statement run, so its result
    can be paged, sorted and downloaded like any other. It holds no connection:
    RESULT_SCAN reads it back from any session of the same login."""
    part = _new_job(st["cls"], job["database"], job["schema"], job["warehouse"], job["timeout_seconds"], job["owner"])
    now = time.time()
    part.update(
        sql=st["sql"], statements=[st], statement_results=[], profile=job["profile"], shared_ws=job.get("shared_ws"),
        is_destructive=False, query_id=query_id, status="success", started_at=job["statement_started"], finished_at=now,
        _history_written=True,    # the run as a whole goes into history, once
    )
    part["done"].set()
    return part


def _run_job(job_id: str):
    job = _get_job(job_id)
    try:
        conn, pool_key, pool_created = _pool.acquire(job["database"], job["schema"], job["warehouse"], job["profile"])
    except HTTPException as e:
        job["status"] = "failed"
        job["error"] = e.detail if isinstance(e.detail, str) else str(e.detail)
        job["finished_at"] = time.time()
        job["done"].set()
        job["slots"].release()
        return

    job["conn"] = conn
    job["pool_key"] = pool_key
    job["pool_created"] = pool_created
    cur = None
    try:
        cur = conn.cursor()
        job["cursor"] = cur
        _apply_statement_timeout(conn, cur, job["timeout_seconds"])

        if job["cancel_requested"]:
            raise _Cancelled()

        planned = job.get("statements") or [{"sql": job["sql"], "line": 0, "cls": None}]
        for k, st in enumerate(planned):
            job["current_statement"] = k
            job["statement_started"] = started = time.time()
            cur.execute(st["sql"])
            job["query_id"] = cur.sfqid
            if job["cancel_requested"]:
                raise _Cancelled()
            if k < len(planned) - 1:
                extra = {"query_id": cur.sfqid}
                if st.get("cls") is not None and st["cls"].returns_rows:
                    part = _statement_job(job, st, cur.sfqid)
                    _capture_rows(part, conn, cur)
                    extra.update(job_id=part["job_id"], row_count=part["row_count"])
                job.setdefault("statement_results", []).append(_statement_result(st, k, started, "success", **extra))

        if job["returns_rows"]:
            _capture_rows(job, conn, cur)
        else:
            # DML/DDL: Snowflake reports what it touched in the result row.
            affected = 0
            try:
                rows = cur.fetchall()
                for row in rows:
                    for value in row:
                        if isinstance(value, (int, Decimal)) and not isinstance(value, bool):
                            affected += int(value)
                if not rows and cur.rowcount and cur.rowcount > 0:
                    affected = cur.rowcount
            except Exception:
                affected = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            job["rows_affected"] = affected
            job["columns"] = []
            job["row_count"] = 0

        job["status"] = "success"
        job["finished_at"] = time.time()
        if len(planned) > 1:
            job["statement_results"].append(_statement_result(
                planned[-1], len(planned) - 1, job["statement_started"],
                "success", query_id=job["query_id"], row_count=job["row_count"], rows_affected=job["rows_affected"],
                **({"job_id": job["job_id"]} if job["returns_rows"] else {})))
    except _Cancelled:
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
    except Exception as e:
        message = failed_at(str(e), job.get("statements") or [], job.get("current_statement", 0))
        if job["cancel_requested"] or "SQL execution canceled" in message:
            job["status"] = "cancelled"
        elif "STATEMENT_TIMEOUT" in message.upper() or "statement timed out" in message.lower():
            job["status"] = "failed"
            job["error"] = f"Query timed out after {job['timeout_seconds']}s"
        else:
            job["status"] = "failed"
            job["error"] = message
        job["finished_at"] = time.time()
    finally:
        job["cursor"] = None
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass
        # A finished non-SELECT (or a failed run) has nothing left to page
        # through, so its connection goes back immediately.
        if job["status"] != "success" or not job["returns_rows"] or job["inline_rows"] is not None:
            _close_job(job)
        # Before done is set, so a client told "finished" never reads a stale list.
        if job["is_destructive"]:
            catalog_changed(names=any(st["cls"] is not None and st["cls"].lead_keyword in _RENAMING_LEADS
                                      for st in job.get("statements") or []))
        job["done"].set()
        job["slots"].release()


def _dedupe_columns(columns: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """SHOW output can repeat a column name; suffix the repeats so the grid can
    key on them safely."""
    seen: Dict[str, int] = {}
    out = []
    for col in columns:
        name = col["name"]
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[col['name']]}"
        else:
            seen[name] = 0
        out.append({**col, "name": name})
    return out


def _result_scan_sql(query_id: str) -> str:
    """RESULT_SCAN takes the query id as a *bound value*, so this never
    interpolates it - callers pass query_id as a parameter."""
    return "SELECT * FROM TABLE(RESULT_SCAN(?))"


def _result_scan_count(conn, query_id: str) -> Optional[int]:
    cur = conn.cursor()
    try:
        cur.execute(f"SELECT COUNT(*) FROM ({_result_scan_sql(query_id)})", (query_id,))
        row = cur.fetchone()
        return int(row[0]) if row else 0
    except Exception as e:
        logger.info("RESULT_SCAN count failed for %s: %s", query_id, e)
        return None
    finally:
        try:
            cur.close()
        except Exception:
            pass


def _job_connection(job: Dict[str, Any]):
    """The job's connection. No liveness ping - that was a full round trip on
    every page turn to guard against something that almost never happens.
    Callers retry once instead, via _drop_job_connection."""
    conn = job.get("conn")
    if conn is not None:
        return conn
    conn, pool_key, pool_created = _pool.acquire(job["database"], job["schema"], job["warehouse"], job["profile"])
    job["conn"] = conn
    job["pool_key"] = pool_key
    job["pool_created"] = pool_created
    return conn


def _drop_job_connection(job: Dict[str, Any]):
    """Throw away a connection that failed mid-page so the retry gets a fresh
    one. RESULT_SCAN only needs the same user and role, both of which come from
    this module's config, so a new session can still read the result."""
    _quiet_close(job.get("conn"))
    job["conn"] = None


# ============================================================================
# Workspace storage - query history and saved queries
# ============================================================================

def _db(read_only: bool = False):
    # This page has always sent naive UTC ISO strings; the browser appends the
    # Z itself (studioHelpers.formatWhen), so keep handing it that shape.
    return db.transaction(read_only=read_only, datetime_format=db.utc_naive_iso)


_db_ready = False


def _init_db():
    """Nothing to create any more (migrations own the tables). Confirms the
    schema once; until that works, history simply isn't recorded and the
    workspace endpoints answer 503, but the rest of Data Studio still runs."""
    global _db_ready
    if _db_ready:
        return
    try:
        db.ensure_ready()
        _db_ready = True
    except Exception as e:
        logger.warning("Data Studio workspace storage not ready yet: %s", e)


def _record_history(user_email: str, job: Dict[str, Any]):
    if not _db_ready:
        return
    try:
        elapsed = int(((job.get("finished_at") or time.time()) - job["started_at"]) * 1000)
        email = (user_email or "").strip().lower()
        with _db() as conn:
            conn.execute(
                """INSERT INTO sf_query_history (id, user_email, sql, database, schema, status, elapsed_ms, row_count, error, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    uuid.uuid4().hex,
                    email,
                    job["sql"][:20000],
                    job.get("database") or "",
                    job.get("schema") or "",
                    job.get("status") or "",
                    elapsed,
                    job.get("row_count"),
                    (job.get("error") or "")[:2000],
                    datetime.now(timezone.utc),
                ),
            )
            # Keep the newest N per person: find the (N+1)th newest and delete
            # it and everything older. The (user_email, created_at DESC, id)
            # index finds that row without sorting the lot.
            conn.execute(
                """DELETE FROM sf_query_history h
                   USING (SELECT created_at, id FROM sf_query_history
                           WHERE user_email = ?
                           ORDER BY created_at DESC, id DESC
                           OFFSET ? LIMIT 1) AS edge
                   WHERE h.user_email = ?
                     AND (h.created_at, h.id) <= (edge.created_at, edge.id)""",
                (email, HISTORY_KEEP_PER_USER, email),
            )
    except Exception as e:
        logger.info("Could not record Snowflake query history: %s", e)


# ============================================================================
# Request models
# ============================================================================

class SnowflakeQueryRequest(BaseModel):
    sql: str
    database: Optional[str] = None
    schema_: Optional[str] = Field(None, alias="schema")
    warehouse: Optional[str] = None
    confirm: bool = False
    timeout_seconds: Optional[int] = None
    # How long POST /query will hold the response open waiting for the query to
    # finish. Most queries beat this, which turns the whole run into a single
    # request instead of submit + poll + fetch.
    wait_ms: int = 2500
    page_size: int = 100
    shared_ws: Optional[str] = None      # shared worksheet this run belongs to; its people can read the result

    model_config = {"populate_by_name": True}


class RowsRequest(BaseModel):
    page: int = 1
    page_size: int = 100
    sort: Optional[List[Dict[str, str]]] = None
    filters: Optional[List[ColumnFilter]] = None


class ValuesRequest(BaseModel):
    """The most common values of one column, for the filter menu. The other
    filters still apply; one on this column itself is left out."""
    column: str
    filters: Optional[List[ColumnFilter]] = None
    limit: int = Field(8, ge=1, le=50)
    search: Optional[str] = Field(None, max_length=200)   # only values containing this

    def others(self) -> List[ColumnFilter]:
        out = [f for f in (self.filters or []) if f.col != self.column]
        if self.search:
            out.append(ColumnFilter(col=self.column, op="contains", value=self.search))
        return out


def _value_key(v):
    return v if isinstance(v, (str, int, float, bool)) else json.dumps(v, sort_keys=True, default=str)


def inline_values(job: Dict[str, Any], body: "ValuesRequest") -> Dict[str, Any]:
    """Value counts for a result held in memory (SHOW, duplicate names)."""
    names = [c["name"] for c in job["columns"]]
    if body.column not in names:
        raise HTTPException(status_code=400, detail=f"'{body.column}' is not a column of this result")
    i = names.index(body.column)
    rows, _ = _paged_inline(job, RowsRequest(page=1, page_size=max(1, len(job["inline_rows"] or [])), filters=body.others()))
    counts, first = {}, {}
    for r in rows:
        v = r[i]
        if v is None:
            continue
        k = _value_key(v)
        counts[k] = counts.get(k, 0) + 1
        first.setdefault(k, v)
    top = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:body.limit]
    return {"column": body.column, "values": [{"value": first[k], "count": n} for k, n in top], "more": len(counts) > body.limit}


class CellRequest(RowsRequest):
    """One cell of a page the grid already showed: the page as it was asked
    for (same sort and filters), the row's place on it and the column."""
    index: int = Field(..., ge=0)
    column: str


CELL_FULL_MAX_CHARS = 10_000_000      # "Load full value" in the grid; bigger than this, download the result


def full_cell(v) -> Dict[str, Any]:
    """A cell for the cell viewer: the whole value, up to CELL_FULL_MAX_CHARS."""
    if isinstance(v, (dict, list)):
        v = json.dumps(v, default=str, ensure_ascii=False)
    if isinstance(v, str) and len(v) > CELL_FULL_MAX_CHARS:
        return {"value": v[:CELL_FULL_MAX_CHARS], "truncated": True, "size": len(v)}
    return {"value": v, "truncated": False}


class TableRowsRequest(BaseModel):
    database: str
    schema_: str = Field(..., alias="schema")
    table: str
    page: int = 1
    page_size: int = 100
    sort: Optional[List[Dict[str, str]]] = None
    filters: Optional[List[ColumnFilter]] = None
    exact_count: bool = True

    model_config = {"populate_by_name": True}


class RowChange(BaseModel):
    kind: str                                  # insert | update | delete
    values: Optional[Dict[str, Any]] = None    # insert/update: the new values
    original: Optional[Dict[str, Any]] = None  # update/delete: the row as read


class MutateRequest(BaseModel):
    database: str
    schema_: str = Field(..., alias="schema")
    table: str
    changes: List[RowChange]
    key_columns: Optional[List[str]] = None
    confirm: bool = False

    model_config = {"populate_by_name": True}


class SavedQueryRequest(BaseModel):
    name: str
    sql: str
    database: Optional[str] = None
    schema_: Optional[str] = Field(None, alias="schema")
    shared: bool = False

    model_config = {"populate_by_name": True}


# ============================================================================
# Endpoints - explorer
# ============================================================================

PERM = "runSnowflakeQueryRunner"
PERM_ALL_ROLES = "useAllSnowflakeRoles"   # switch to any role, not just the login's default
PERM_WRITE = "writeSnowflake"             # writes from the worksheet and grid edits
PERM_COPY = "copySnowflakeTables"         # Table Copier

_USE_ROLE = re.compile(r"\bUSE\s+(SECONDARY\s+)?ROLES?\b", re.IGNORECASE)


def _has(auth: dict, perm: str) -> bool:
    return (auth.get("permissions") or {}).get(perm) is True


def _default_role(conn_id: Optional[str]) -> str:
    try:
        return (_profile_config(conn_profile(conn_id, None)).get("role") or "").strip('"')
    except HTTPException:
        raise
    except Exception:
        return ""


def _default_conn_id() -> str:
    numbered = numbered_sections(_config)
    return next(iter(numbered)) if numbered else "default"


def _check_role(auth: dict, conn_id: Optional[str], role: Optional[str]):
    """Without All Roles a user gets one login (the first one) and its
    default role. Each login has its own role, so picking another login is
    switching role too."""
    if _has(auth, PERM_ALL_ROLES):
        return
    if conn_id not in (None, "", "default", _default_conn_id()):
        raise HTTPException(status_code=403, detail="You can only use the default Snowflake role. Ask an admin for 'All Roles' access.")
    if role and role.strip('"').upper() != _default_role(conn_id).upper():
        raise HTTPException(status_code=403, detail="You can only use the default Snowflake role. Ask an admin for 'All Roles' access.")


def _visible_connections(auth: dict) -> List[Dict[str, Any]]:
    conns = connections()
    if _has(auth, PERM_ALL_ROLES):
        return conns
    first = _default_conn_id()
    return [c for c in conns if c["id"] == first][:1] or conns[:1]


def sf_auth(request: Request, auth: dict = Depends(require_permission(PERM))) -> dict:
    """Snowflake access plus the role check. Every endpoint takes the role as
    a query param, so checking it here covers all of them."""
    _check_role(auth, request.query_params.get("conn_id"), request.query_params.get("role"))
    return auth


def _require(auth: dict, perm: str, what: str):
    if not _has(auth, perm):
        raise HTTPException(status_code=403, detail=f"You don't have permission to {what} in Snowflake")


@snowflake_router.get("/health")
def health(conn_id: Optional[str] = Query(None), role: Optional[str] = Query(None),
           auth: dict = Depends(require_permission(PERM))):
    # No role check here: an old tab saved on another login should land back
    # on the default one, not fail to connect.
    if not _has(auth, PERM_ALL_ROLES):
        conn_id, role = None, None
    cfg = _profile_config(conn_profile(conn_id, role))
    return {
        "configured": True,
        "connections": _visible_connections(auth),
        "conn_id": cfg.get("conn_id") or "default",
        "account": cfg["account"],
        "user": cfg["user"],
        "role": cfg["role"],
        "warehouse": cfg["warehouse"],
        "default_database": cfg["database"],
        "default_schema": cfg["schema"],
        "allow_writes": cfg["allow_writes"] and _has(auth, PERM_WRITE),
        "can_write": _has(auth, PERM_WRITE),
        "can_copy": _has(auth, PERM_COPY),
        "can_use_all_roles": _has(auth, PERM_ALL_ROLES),
        "max_page_size": ROWS_PAGE_MAX_SIZE,
        # Present only when writes go through a second login - the copier uses
        # it to browse target databases with the credentials that own them.
        "write_profile": (
            {
                "configured": True,
                "account": _profile_config(WRITE_PROFILE)["account"],
                "user": _profile_config(WRITE_PROFILE)["user"],
                "role": _profile_config(WRITE_PROFILE)["role"],
                "warehouse": _profile_config(WRITE_PROFILE)["warehouse"],
            }
            if _write_configured() else {"configured": False}
        ),
    }


@snowflake_router.get("/roles")
def list_roles(conn_id: Optional[str] = Query(None), auth: dict = Depends(sf_auth)):
    """Roles a worksheet can switch to: roles_N from the config, or every role
    granted to that login when none are listed."""
    profile = conn_profile(conn_id, None)
    cfg = _profile_config(profile)
    if not _has(auth, PERM_ALL_ROLES):
        return {"roles": [cfg["role"]] if cfg["role"] else [], "default": cfg["role"], "configured": True, "locked": True}
    if cfg.get("roles"):
        return {"roles": cfg["roles"], "default": cfg["role"], "configured": True}
    cache_key = f"sf-roles:{profile}"
    cached = _cache_get(cache_key)
    if cached is None:
        def read(cur):
            cur.execute("SELECT CURRENT_AVAILABLE_ROLES()")
            return sorted(json.loads(cur.fetchone()[0] or "[]"))
        try:
            cached = _run_meta(read, profile)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not list roles: {e}")
        _cache_set(cache_key, cached)
    return {"roles": cached, "default": cfg["role"], "configured": False}


@snowflake_router.get("/databases")
def list_databases(
    bypass_cache: bool = Query(False),
    profile: str = Query(READ_PROFILE, description="Which credentials to browse with: read or write"),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    _require_config()
    which = _use_profile(profile, conn_id, role)
    cache_key = f"sf-databases:{which}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    home = _profile_config(which)["database"]

    def read(cur):
        # INFORMATION_SCHEMA.DATABASES only lists databases the current role
        # holds privileges on, whereas SHOW DATABASES lists everything in the
        # account - including the ones that blow up with "insufficient
        # privileges" the moment you expand them.
        if home:
            try:
                cur.execute(f"SELECT DATABASE_NAME FROM {quote_ident(home)}.INFORMATION_SCHEMA.DATABASES")
                names = {r[0] for r in cur.fetchall() if r[0]}
                if names:
                    return sorted(names)
            except Exception as e:
                logger.info("INFORMATION_SCHEMA.DATABASES unavailable, falling back to SHOW: %s", e)
        cur.execute("SHOW TERSE DATABASES")
        rows = cur.fetchall()
        name_idx = _column_index(cur, "name", default=1)
        return sorted({r[name_idx] for r in rows if r[name_idx]})

    try:
        databases = _run_meta(read, which)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, "databases")
    payload = {"databases": databases, "cached": False}
    _cache_set(cache_key, payload)
    return payload


def _use_profile(profile: Optional[str], conn_id: Optional[str] = None, role: Optional[str] = None) -> str:
    """Catalog calls name the profile they want to browse with. Asking for the
    write profile on a deployment that has none is not an error - there is only
    one login, and it answers for both. A worksheet's login and role win."""
    if conn_id or role:
        return conn_profile(conn_id, role)
    if (profile or "").strip().lower() == WRITE_PROFILE and _write_configured():
        return WRITE_PROFILE
    return READ_PROFILE


def _column_index(cur, name: str, default: int = 0) -> int:
    """SHOW output column order isn't contractual across Snowflake releases, so
    look the column up by name and only fall back to a position."""
    for i, d in enumerate(cur.description or []):
        if d[0].lower() == name.lower():
            return i
    return default


@snowflake_router.get("/schemas")
def list_schemas(
    database: str = Query(...),
    bypass_cache: bool = Query(False),
    profile: str = Query(READ_PROFILE, description="Which credentials to browse with: read or write"),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    _require_config()
    which = _use_profile(profile, conn_id, role)
    cache_key = f"sf-schemas:{which}:{database}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    def read(cur):
        # SCHEMATA is privilege-filtered the same way DATABASES is.
        cur.execute(f"SELECT SCHEMA_NAME FROM {quote_ident(database)}.INFORMATION_SCHEMA.SCHEMATA")
        return sorted({r[0] for r in cur.fetchall() if r[0]})

    try:
        schemas = _run_meta(read, which)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, f"schemas in {database}")
    payload = {"schemas": schemas, "cached": False}
    _cache_set(cache_key, payload)
    return payload


@snowflake_router.get("/tables")
def list_tables(
    database: str = Query(...),
    schema: str = Query(...),
    bypass_cache: bool = Query(False),
    profile: str = Query(READ_PROFILE, description="Which credentials to browse with: read or write"),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    """Tables and views with the row count and byte size Snowflake already keeps
    in INFORMATION_SCHEMA - never a live COUNT(*), so this stays instant even
    against schemas full of billion-row tables."""
    _require_config()
    which = _use_profile(profile, conn_id, role)
    cache_key = f"sf-tables:{which}:{database}:{schema}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    def read(cur):
        cur.execute(
            f"""
            SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT, BYTES, IS_TRANSIENT
            FROM {quote_ident(database)}.INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
            """,
            (schema,),
        )
        tables = []
        for name, table_type, row_count, byte_size, transient in cur.fetchall():
            kind = "table"
            upper = (table_type or "").upper()
            if "VIEW" in upper:
                kind = "materialized_view" if "MATERIALIZED" in upper else "view"
            elif "EXTERNAL" in upper:
                kind = "external_table"
            tables.append({
                "name": name,
                "kind": kind,
                "est_rows": int(row_count) if row_count is not None else None,
                "size_bytes": int(byte_size) if byte_size is not None else None,
                "transient": (transient or "NO").upper() == "YES",
            })
        return tables

    try:
        tables = _run_meta(read, which)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, f"tables in {database}.{schema}")
    payload = {"tables": tables, "cached": False}
    _cache_set(cache_key, payload)
    return payload


# ---------------------------------------------------------------------------
# Table name search. One in-memory index of every table/view name the role can
# see, built with a single SHOW call (metadata only, no warehouse), served
# stale while it refreshes in the background so a search never waits on
# Snowflake after the first build.
# ---------------------------------------------------------------------------

NAME_INDEX_TTL = 10 * 60
SHOW_CAP = 10000            # SHOW never returns more than this many rows
_name_index: Dict[str, Dict[str, Any]] = {}
_name_index_lock = threading.Lock()
_name_index_gen = 0         # bumped by catalog_changed(); a build from an older generation is thrown away
_SPLIT = re.compile(r"[^a-z0-9]+")


def _kind_of(raw: str) -> str:
    up = (raw or "").upper()
    if "MATERIALIZED" in up:
        return "materialized_view"
    if "VIEW" in up:
        return "view"
    if "EXTERNAL" in up:
        return "external_table"
    return "table"


def _show_objects(cur, scope: str) -> List[tuple]:
    cur.execute(f"SHOW TERSE OBJECTS IN {scope}")
    rows = cur.fetchall()
    di = _column_index(cur, "database_name", 3)
    si = _column_index(cur, "schema_name", 4)
    ni = _column_index(cur, "name", 1)
    ki = _column_index(cur, "kind", 2)
    return [(r[di], r[si], r[ni], r[ki]) for r in rows if r[si] != "INFORMATION_SCHEMA"]


def _info_schema_objects(cur, database: str) -> List[tuple]:
    cur.execute(
        f"""
        SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
        FROM {quote_ident(database)}.INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
        """
    )
    return [tuple(r) for r in cur.fetchall()]


def _build_name_index(which: str, dbs: List[str]) -> List[tuple]:
    # fastest path: one call for the whole account
    rows = _run_meta(lambda cur: _show_objects(cur, "ACCOUNT"), which)
    if len(rows) < SHOW_CAP:
        raw = rows
    else:
        # too many objects for one SHOW, go database by database
        def one(db_name):
            got = _run_meta(lambda cur: _show_objects(cur, f"DATABASE {quote_ident(db_name)}"), which)
            if len(got) >= SHOW_CAP:
                got = _run_meta(lambda cur: _info_schema_objects(cur, db_name), which)
            return got

        raw = []
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(dbs)))) as pool:
            for fut in [pool.submit(one, d) for d in dbs]:
                try:
                    raw.extend(fut.result())
                except Exception as e:
                    logger.info("name index skipped a database: %s", e)

    items = []
    for db_name, schema, name, kind in raw:
        if not name:
            continue
        low = name.lower()
        items.append((db_name, schema, name, _kind_of(kind), low, tuple(p for p in _SPLIT.split(low) if p)))
    return items


def _refresh_index(which: str, dbs: List[str]) -> Dict[str, Any]:
    with _name_index_lock:
        gen = _name_index_gen
    try:
        items = _build_name_index(which, dbs)
        parts = sorted({p for it in items for p in it[5]})
        entry = {"items": items, "parts": parts, "built": time.time(), "building": False}
        with _name_index_lock:
            if gen == _name_index_gen:
                _name_index[which] = entry
        logger.info("table name index for %s: %d objects", which, len(items))
        return entry
    except Exception:
        with _name_index_lock:
            entry = _name_index.get(which)
            if entry and gen == _name_index_gen:
                entry["building"] = False
        raise


def _get_index(which: str, dbs_fn, force: bool = False) -> Dict[str, Any]:
    # warm-up already running and nothing built yet, wait for it instead of
    # starting a second build
    for _ in range(300):
        with _name_index_lock:
            entry = _name_index.get(which)
            waiting = entry and entry.get("items") is None and entry.get("building")
        if not waiting:
            break
        time.sleep(0.1)
    with _name_index_lock:
        entry = _name_index.get(which)
        fresh = entry and entry.get("items") is not None and time.time() - entry["built"] < NAME_INDEX_TTL
        if entry and entry.get("items") is not None and not force:
            if not fresh and not entry["building"]:
                entry["building"] = True
                threading.Thread(target=_bg_refresh, args=(which, dbs_fn), daemon=True).start()
            return entry
    return _refresh_index(which, dbs_fn())


# Every cached list of databases, schemas, tables, columns and DDL. Roles stay:
# they don't change when objects do.
_CATALOG_PREFIXES = ("sf-databases:", "sf-schemas:", "sf-tables:", "sf-columns:", "sf-colmeta:",
                     "sf-schemacols:", "sf-ddl:", "sf-srcobj:", "sf-writeread:")


# Statements that can add, remove, rename or hide objects. INSERT, UPDATE and
# the like only move row counts, so they leave the (slow to rebuild) search index.
_RENAMING_LEADS = {"CREATE", "DROP", "ALTER", "UNDROP", "GRANT", "REVOKE", "CALL", "EXECUTE"}


def catalog_changed(names: bool = True):
    """Objects were created, dropped, renamed or written to: forget what the
    explorer, the pickers and the search remember, for every login and role."""
    global _name_index_gen
    for prefix in _CATALOG_PREFIXES:
        _cache_drop_prefix(prefix)
    if not names:
        return
    with _name_index_lock:
        _name_index_gen += 1
        _name_index.clear()


@snowflake_router.post("/catalog/refresh")
def refresh_catalog(auth: dict = Depends(sf_auth)):
    """The explorer's Refresh button: picks up objects changed outside Data Studio."""
    _require_config()
    catalog_changed()
    return {"ok": True}


def _bg_refresh(which, dbs_fn):
    try:
        _refresh_index(which, dbs_fn())
    except Exception as e:
        logger.info("background name index refresh failed: %s", e)


def _token_part_scores(token: str, parts: List[str]) -> Dict[str, float]:
    # score each distinct name part once, not once per table
    out = {}
    n = len(token)
    for p in parts:
        if p == token:
            out[p] = 1.0
        elif p.startswith(token):
            out[p] = 0.92
        elif token in p:
            out[p] = 0.85
        elif n >= 4 and abs(len(p) - n) <= 2:
            sm = difflib.SequenceMatcher(None, token, p)
            if sm.real_quick_ratio() >= 0.75 and sm.quick_ratio() >= 0.75:
                r = sm.ratio()
                if r >= 0.75:
                    out[p] = r * 0.8
    return out


def _search_index(entry: Dict[str, Any], q: str, database: Optional[str]) -> List[Dict[str, Any]]:
    tokens = [t for t in _SPLIT.split(q.lower()) if t]
    if not tokens:
        return []
    whole = "_".join(tokens)
    tables = [_token_part_scores(t, entry["parts"]) for t in tokens]
    want_db = database.upper() if database else None
    hits = []
    for db_name, schema, name, kind, low, parts in entry["items"]:
        if want_db and db_name.upper() != want_db:
            continue
        if low == whole:
            score = 3.0
        else:
            total = 0.0
            for t, table in zip(tokens, tables):
                best = 0.0
                for p in parts:
                    v = table.get(p)
                    if v and v > best:
                        best = v
                if not best and t in low:
                    best = 0.85
                if not best:
                    break
                total += best
            else:
                score = total / len(tokens) + (0.3 if whole in low else 0)
                hits.append((score, db_name, schema, name, kind))
            continue
        hits.append((score, db_name, schema, name, kind))
    hits.sort(key=lambda h: (-h[0], len(h[3]), h[3]))
    return hits


@snowflake_router.get("/search-tables")
def search_tables(
    q: str = Query(..., min_length=2),
    database: Optional[str] = Query(None, description="Only search this database"),
    limit: int = Query(100, ge=1, le=500),
    bypass_cache: bool = Query(False),
    profile: str = Query(READ_PROFILE),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    """Find tables and views by name across every database the role can see.
    Each word in q can hit any part of the name, small typos are ok."""
    _require_config()
    which = _use_profile(profile, conn_id, role)
    dbs_fn = lambda: list_databases(bypass_cache=False, profile=profile, conn_id=conn_id, role=role, auth=auth)["databases"]
    try:
        entry = _get_index(which, dbs_fn, force=bypass_cache)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, "table names")
    hits = _search_index(entry, q, database)
    return {
        "results": [
            {"database": d, "schema": s, "name": n, "kind": k, "score": round(sc, 3)}
            for sc, d, s, n, k in hits[:limit]
        ],
        "total": len(hits),
        "indexed": len(entry["items"]),
        "age_seconds": int(time.time() - entry["built"]),
    }


@snowflake_router.post("/search-tables/warm")
def warm_search_index(
    force: bool = Query(False, description="Rebuild even if the index is fresh"),
    profile: str = Query(READ_PROFILE),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    """Called when the explorer opens, so the index is ready before anyone types."""
    _require_config()
    which = _use_profile(profile, conn_id, role)
    with _name_index_lock:
        entry = _name_index.get(which)
        if entry and (entry.get("building") or (not force and time.time() - entry["built"] < NAME_INDEX_TTL)):
            return {"ok": True, "ready": entry.get("items") is not None}
        if entry:
            entry["building"] = True
        else:
            _name_index[which] = {"items": None, "parts": [], "built": 0, "building": True}
    dbs_fn = lambda: list_databases(bypass_cache=force, profile=profile, conn_id=conn_id, role=role, auth=auth)["databases"]
    threading.Thread(target=_bg_refresh, args=(which, dbs_fn), daemon=True).start()
    return {"ok": True, "ready": False}


def _fetch_columns(database: str, schema: str, table: str, bypass_cache: bool = False,
                    profile: str = READ_PROFILE) -> List[Dict[str, Any]]:
    """Column metadata for a table. Cached, because the data grid needs it on
    every page turn and every save, and a schema doesn't change between two
    clicks of the Next button."""
    cache_key = f"sf-colmeta:{profile}:{database}:{schema}:{table}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    def read(cur):
        cur.execute(
            f"""
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION,
                   CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COMMENT
            FROM {quote_ident(database)}.INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
            """,
            (schema, table),
        )
        raw = cur.fetchall()
        if not raw:
            raise HTTPException(status_code=404, detail=f"{schema}.{table} was not found in {database}")

        pk_cols: List[str] = []
        try:
            cur.execute(f"SHOW PRIMARY KEYS IN TABLE {qualified(database, schema, table)}")
            pk_rows = cur.fetchall()
            col_idx = _column_index(cur, "column_name", default=4)
            seq_idx = _column_index(cur, "key_sequence", default=5)
            ordered = sorted(pk_rows, key=lambda r: r[seq_idx] if isinstance(r[seq_idx], int) else 0)
            pk_cols = [r[col_idx] for r in ordered]
        except Exception as e:
            # Views and most Snowflake tables have no declared PK. Not an error.
            logger.debug("No primary keys for %s.%s.%s: %s", database, schema, table, e)
        return raw, pk_cols

    raw, pk_cols = _run_meta(read, profile)

    columns = [_column_row(*row, pk_cols=pk_cols) for row in raw]
    _cache_set(cache_key, columns)
    return columns


def _column_row(name, data_type, nullable, default, position, char_len, precision, scale, comment,
                 pk_cols=()) -> Dict[str, Any]:
    return {
        "name": name,
        "data_type": (data_type or "").upper(),
        "nullable": (nullable or "YES").upper() == "YES",
        "default": default,
        "position": position,
        "char_length": char_len,
        "precision": precision,
        "scale": scale,
        "comment": comment,
        "is_primary_key": name in pk_cols,
        "editable": is_editable_type(data_type or ""),
        "comparable": is_comparable_type(data_type or ""),
    }


def _fetch_schema_columns(database: str, schema: str, profile: str = READ_PROFILE) -> Dict[str, List[Dict[str, Any]]]:
    """Every column in the schema, keyed by table, in one query.

    A copy that has to build its own CREATE TABLE needs the columns of each
    object it is copying. Asking per table means one round trip each - plus
    another for its primary keys - which is 170 of them for an 85 table schema
    and about half a minute of staring at "Checking...". Primary keys are left
    out on purpose: a copy does not use them."""
    cache_key = f"sf-schemacols:{profile}:{database}:{schema}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    def read(cur):
        cur.execute(
            f"""
            SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION,
                   CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COMMENT
            FROM {quote_ident(database)}.INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, ORDINAL_POSITION
            """,
            (schema,),
        )
        return cur.fetchall()

    try:
        rows = _run_meta(read, profile)
    except Exception as e:
        # Not fatal - the caller falls back to asking table by table.
        logger.info("Bulk column read failed for %s.%s: %s", database, schema, e)
        return {}

    by_table: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        by_table.setdefault(row[0], []).append(_column_row(*row[1:]))
    _cache_set(cache_key, by_table)
    return by_table


@snowflake_router.get("/columns")
def list_columns(
    database: str = Query(...),
    schema: str = Query(...),
    table: str = Query(...),
    bypass_cache: bool = Query(False),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    _require_config()
    which = _use_profile(None, conn_id, role)
    cache_key = f"sf-columns:{which}:{database}:{schema}:{table}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    try:
        columns = _fetch_columns(database, schema, table, bypass_cache=bypass_cache, profile=which)
    except HTTPException:
        raise
    except Exception as e:
        raise _meta_http_error(e, f"columns of {schema}.{table}")
    payload = {
        "columns": columns,
        "primary_key": [c["name"] for c in columns if c["is_primary_key"]],
        "cached": False,
    }
    _cache_set(cache_key, payload)
    return payload


DDL_KINDS = {"TABLE", "VIEW", "MATERIALIZED_VIEW", "FUNCTION", "PROCEDURE", "SCHEMA"}


def _object_ddl(database: str, schema: str, name: str, kind: str = "TABLE",
                 profile: str = READ_PROFILE) -> str:
    """GET_DDL for one object, straight from Snowflake."""
    kind_upper = (kind or "TABLE").upper().replace(" ", "_")
    if kind_upper not in DDL_KINDS:
        raise HTTPException(status_code=400, detail=f"Unsupported object kind '{kind}'")
    # GET_DDL has no MATERIALIZED_VIEW argument - VIEW returns it either way.
    sf_kind = "VIEW" if kind_upper == "MATERIALIZED_VIEW" else kind_upper

    # Cached: a schema copy reads the DDL of every view it finds, and it builds
    # the same plan twice - once to preview it, once to run it.
    cache_key = f"sf-ddl:{profile}:{sf_kind}:{database}:{schema}:{name}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    def read(cur):
        cur.execute("SELECT GET_DDL(?, ?, TRUE)", (sf_kind, f"{database}.{schema}.{name}"))
        return cur.fetchone()

    row = _run_meta(read, profile)
    ddl = row[0] if row else ""
    _cache_set(cache_key, ddl)
    return ddl


@snowflake_router.get("/ddl")
def get_ddl(
    database: str = Query(...),
    schema: str = Query(...),
    name: str = Query(...),
    kind: str = Query("TABLE"),
    profile: str = Query(READ_PROFILE, description="Which credentials to read the DDL with"),
    conn_id: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    """GET_DDL for a table or view - the thing every DBeaver user reaches for
    right after opening an object."""
    try:
        return {"ddl": _object_ddl(database, schema, name, kind, _use_profile(profile, conn_id, role))}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read DDL: {e}")


# ============================================================================
# Endpoints - query execution
# ============================================================================

@snowflake_router.post("/query")
def start_query(body: SnowflakeQueryRequest, conn_id: Optional[str] = Query(None), role: Optional[str] = Query(None),
                auth: dict = Depends(sf_auth)):
    cleanup_jobs()
    profile = _use_profile(None, conn_id, role)
    cfg = _profile_config(profile)
    _resize_job_slots(cfg["max_concurrent_jobs"])

    planned = plan_statements(body.sql)
    risky = [p["cls"] for p in planned if p["cls"].is_destructive]
    if risky:
        _require(auth, PERM_WRITE, "run write statements")
    if not _has(auth, PERM_ALL_ROLES) and _USE_ROLE.search(_strip_sql_comments(body.sql or "")):
        raise HTTPException(status_code=403, detail="USE ROLE needs 'All roles' access in Snowflake")
    if risky and not cfg["allow_writes"]:
        raise HTTPException(status_code=403, detail="This connection is configured read-only (allow_writes = false)")
    if risky and not body.confirm:
        raise HTTPException(status_code=409, detail=confirm_detail(planned))
    if body.shared_ws:
        shared_worksheets.require_editor(body.shared_ws, "snowflake", auth["user"]["email"])
    # The last statement's result is the one shown, like a Snowsight "Run all".
    classification = planned[-1]["cls"]

    timeout_seconds = body.timeout_seconds or cfg["statement_timeout_seconds"]
    timeout_seconds = max(1, min(int(timeout_seconds), cfg["max_statement_timeout_seconds"]))

    slots = _job_slots
    if not slots.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail=f"Too many queries already running (max {cfg['max_concurrent_jobs']} concurrent). Cancel one or wait for it to finish.",
        )

    job = _new_job(
        classification,
        body.database or cfg["database"],
        body.schema_ or cfg["schema"],
        body.warehouse,
        timeout_seconds,
        auth["user"]["email"],
    )
    job["slots"] = slots
    job["statements"] = planned
    job["statement_results"] = []
    job["profile"] = profile
    job["dirty_session"] = any(_SESSION_CHANGE.search(_strip_sql_comments(p["sql"])) for p in planned)
    job["shared_ws"] = body.shared_ws
    job["is_destructive"] = bool(risky)
    if len(planned) > 1:
        job["sql"] = body.sql.strip()
    try:
        _executor.submit(_run_job, job["job_id"])
    except Exception as e:
        with _jobs_lock:
            _jobs.pop(job["job_id"], None)
        slots.release()
        raise HTTPException(status_code=503, detail=f"Could not schedule the query: {e}")
    if body.shared_ws:
        shared_worksheets.note_run(body.shared_ws, auth, job["job_id"], job["sql"])

    response = {
        "job_id": job["job_id"],
        "status": "running",
        "statement_type": classification.lead_keyword,
        "is_destructive": bool(risky),
        "returns_rows": classification.returns_rows,
        "warning": classification.warning if len(planned) == 1 else None,
    }

    wait_seconds = max(0.0, min(int(body.wait_ms or 0), 15000) / 1000.0)
    if wait_seconds and job["done"].wait(wait_seconds):
        response.update(_job_status_payload(job))
        _record_history_once(auth["user"]["email"], job)
        if job["status"] == "success" and job["returns_rows"]:
            page_size = max(1, min(int(body.page_size or 100), ROWS_PAGE_MAX_SIZE))
            try:
                response["first_page"] = get_query_rows(
                    job["job_id"], RowsRequest(page=1, page_size=page_size), auth=auth,
                )
            except HTTPException:
                # Not fatal - the client just falls back to asking for page 1.
                pass
    return response


def _job_status_payload(job: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "statement_type": job["lead_keyword"],
        "returns_rows": job["returns_rows"],
        "is_destructive": job["is_destructive"],
        "changes_catalog": job["is_destructive"],
        "columns": job["columns"],
        "row_count": job["row_count"],
        "rows_affected": job["rows_affected"],
        "query_id": job["query_id"],
        "error": job["error"],
        "elapsed_ms": int(((job["finished_at"] or time.time()) - job["started_at"]) * 1000),
        "statement_count": len(job.get("statements") or []) or 1,
        "statements": job.get("statement_results") or [],
    }


def _record_history_once(user_email: str, job: Dict[str, Any]):
    if job["status"] != "running" and not job.get("_history_written"):
        job["_history_written"] = True
        _record_history(user_email, job)


@snowflake_router.get("/query/{job_id}/status")
def get_query_status(job_id: str, wait_ms: int = Query(0, ge=0, le=15000),
                     auth: dict = Depends(sf_auth)):
    """Long-polls when wait_ms is set: the request parks on the job's completion
    event instead of the client burning round trips on a fixed timer."""
    job = _get_job(job_id, auth["user"]["email"], shared=True)
    if wait_ms and job["status"] == "running":
        job["done"].wait(wait_ms / 1000.0)
        _touch(job)
    _record_history_once(job["owner"] or auth["user"]["email"], job)   # the runner's history, whoever asks first
    return _job_status_payload(job)


# What the grid gets of one value. A file in a BINARY / bytea column, or a
# document in a text or JSON column, can be megabytes; a page of a hundred of
# those froze (or crashed) the browser. The grid gets a short preview and the
# full size; downloads still get every byte.
CELL_MAX_CHARS = 20_000
CELL_PREVIEW_CHARS = 2_000


def grid_cell(v):
    if isinstance(v, str):
        return {"$truncated": True, "preview": v[:CELL_PREVIEW_CHARS], "size": len(v)} if len(v) > CELL_MAX_CHARS else v
    if isinstance(v, (dict, list)):
        text = json.dumps(v, default=str, ensure_ascii=False)
        if len(text) > CELL_MAX_CHARS:
            return {"$truncated": True, "preview": text[:CELL_PREVIEW_CHARS], "size": len(text)}
    return v


def _is_truncated(v) -> bool:
    return isinstance(v, dict) and v.get("$truncated") is True


def grid_rows(rows):
    return [[grid_cell(v) for v in r] for r in rows]


def _paged_inline(job: Dict[str, Any], body: RowsRequest):
    """Paging, sorting and filtering for the small materialized results (SHOW,
    duplicate column names) that RESULT_SCAN can't serve."""
    names = [c["name"] for c in job["columns"]]
    rows = job["inline_rows"] or []

    if body.filters:
        idx = {n: i for i, n in enumerate(names)}
        for f in body.filters:
            if f.col not in idx:
                raise HTTPException(status_code=400, detail=f"'{f.col}' is not a column of this result")
            i = idx[f.col]
            op = (f.op or "").lower()
            needle = "" if f.value is None else str(f.value).lower()
            if op == "is_null":
                rows = [r for r in rows if r[i] is None]
            elif op == "is_not_null":
                rows = [r for r in rows if r[i] is not None]
            elif op == "contains":
                rows = [r for r in rows if needle in _flatten_for_text(r[i]).lower()]
            elif op == "not_contains":
                rows = [r for r in rows if needle not in _flatten_for_text(r[i]).lower()]
            elif op == "starts":
                rows = [r for r in rows if _flatten_for_text(r[i]).lower().startswith(needle)]
            elif op == "ends":
                rows = [r for r in rows if _flatten_for_text(r[i]).lower().endswith(needle)]
            elif op == "eq":
                rows = [r for r in rows if _flatten_for_text(r[i]) == ("" if f.value is None else str(f.value))]
            elif op == "neq":
                rows = [r for r in rows if _flatten_for_text(r[i]) != ("" if f.value is None else str(f.value))]
            elif op in ("in", "not_in"):
                wanted = {str(v) for v in (f.values or ([f.value] if f.value is not None else []))}
                if op == "in":
                    rows = [r for r in rows if _flatten_for_text(r[i]) in wanted]
                else:
                    rows = [r for r in rows if _flatten_for_text(r[i]) not in wanted]
            else:
                # gt/gte/lt/lte: numeric when both sides parse, text otherwise.
                target = "" if f.value is None else str(f.value)

                def key_of(value):
                    text = _flatten_for_text(value)
                    try:
                        return (0, float(text))
                    except (TypeError, ValueError):
                        return (1, text)

                try:
                    target_key = (0, float(target))
                except ValueError:
                    target_key = (1, target)
                compare = {
                    "gt": lambda a: a > target_key,
                    "gte": lambda a: a >= target_key,
                    "lt": lambda a: a < target_key,
                    "lte": lambda a: a <= target_key,
                }[op]
                rows = [r for r in rows if key_of(r[i])[0] == target_key[0] and compare(key_of(r[i]))]

    if body.sort:
        idx = {n: i for i, n in enumerate(names)}
        for entry in reversed(body.sort):
            col = entry.get("col")
            if col not in idx:
                raise HTTPException(status_code=400, detail=f"'{col}' is not a column of this result")
            i = idx[col]
            reverse = (entry.get("dir") or "asc").lower() == "desc"

            def sort_key(row, i=i):
                value = row[i]
                if value is None:
                    return (2, "")
                text = _flatten_for_text(value)
                try:
                    return (0, float(text))
                except (TypeError, ValueError):
                    return (1, text)

            rows = sorted(rows, key=sort_key, reverse=reverse)

    total = len(rows)
    start = (body.page - 1) * body.page_size
    return rows[start:start + body.page_size], total


@snowflake_router.post("/query/{job_id}/rows")
def get_query_rows(job_id: str, body: RowsRequest, auth: dict = Depends(sf_auth)):
    job = _get_job(job_id, auth["user"]["email"], shared=True)
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")

    page = max(1, int(body.page))
    page_size = max(1, min(int(body.page_size), ROWS_PAGE_MAX_SIZE))
    body = body.model_copy(update={"page": page, "page_size": page_size})

    if not job["returns_rows"]:
        return {"columns": [], "rows": [], "page": 1, "page_size": page_size, "total_rows": 0, "total_pages": 1}

    if job["inline_rows"] is not None:
        rows, total = _paged_inline(job, body)
        return {
            "columns": job["columns"],
            "rows": grid_rows(rows),
            "page": page,
            "page_size": page_size,
            "total_rows": total,
            "total_pages": max(1, -(-total // page_size)),
        }

    names = [c["name"] for c in job["columns"]]
    where_sql, where_params = build_where(body.filters, names)
    order_sql = build_order_by(body.sort, names)
    offset = (page - 1) * page_size

    def scan(conn):
        cur = conn.cursor()
        try:
            base = f"({_result_scan_sql(job['query_id'])})"
            total = job["row_count"] or 0
            if where_sql:
                cur.execute(f"SELECT COUNT(*) FROM {base}{where_sql}", (job["query_id"], *where_params))
                total = int(cur.fetchone()[0])
            cur.execute(
                f"SELECT * FROM {base}{where_sql}{order_sql} LIMIT {page_size} OFFSET {offset}",
                (job["query_id"], *where_params),
            )
            return grid_rows([[_to_json_safe(v) for v in r] for r in cur.fetchall()]), total
        finally:
            try:
                cur.close()
            except Exception:
                pass

    with job["job_lock"]:
        try:
            rows, total = scan(_job_connection(job))
        except Exception as first:
            if not _looks_stale(first):
                raise HTTPException(status_code=500, detail=_friendly_result_scan_error(first))
            _drop_job_connection(job)
            try:
                rows, total = scan(_job_connection(job))
            except Exception as second:
                raise HTTPException(status_code=500, detail=_friendly_result_scan_error(second))

    return {
        "columns": job["columns"],
        "rows": rows,
        "page": page,
        "page_size": page_size,
        "total_rows": total,
        "total_pages": max(1, -(-total // page_size)) if total else 1,
    }


@snowflake_router.post("/query/{job_id}/values")
def get_query_values(job_id: str, body: ValuesRequest, auth: dict = Depends(sf_auth)):
    job = _get_job(job_id, auth["user"]["email"], shared=True)
    if job["status"] != "success" or not job["returns_rows"]:
        raise HTTPException(status_code=409, detail="This result has no rows to count")
    if job["inline_rows"] is not None:
        return inline_values(job, body)
    names = [c["name"] for c in job["columns"]]
    if body.column not in names:
        raise HTTPException(status_code=400, detail=f"'{body.column}' is not a column of this result")
    where_sql, where_params = build_where(body.others(), names)
    col = quote_ident(body.column)
    where_sql = f"{where_sql} AND {col} IS NOT NULL" if where_sql else f" WHERE {col} IS NOT NULL"

    def scan(conn):
        cur = conn.cursor()
        try:
            base = f"({_result_scan_sql(job['query_id'])})"
            cur.execute(f"SELECT {col}, COUNT(*) FROM {base}{where_sql} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {body.limit + 1}",
                        (job["query_id"], *where_params))
            return [[_to_json_safe(v) for v in r] for r in cur.fetchall()]
        finally:
            try:
                cur.close()
            except Exception:
                pass

    with job["job_lock"]:
        try:
            rows = scan(_job_connection(job))
        except Exception as first:
            if not _looks_stale(first):
                raise HTTPException(status_code=400, detail=f"Can't count the values of {body.column}: {first}")
            _drop_job_connection(job)
            rows = scan(_job_connection(job))
    return {"column": body.column, "values": [{"value": v, "count": int(n)} for v, n in rows[:body.limit]], "more": len(rows) > body.limit}


_PRIVILEGE_MARKERS = ("insufficient privileges", "does not exist or not authorized",
                      "not authorized", "003001", "002003")


def _is_privilege_error(e: Exception) -> bool:
    text = str(e).lower()
    return any(marker in text for marker in _PRIVILEGE_MARKERS)


def _meta_http_error(e: Exception, what: str) -> HTTPException:
    """A missing grant isn't a server fault - it's a 403 the tree can render as
    a quiet "no access" line instead of a wall of red."""
    if _is_privilege_error(e):
        return HTTPException(status_code=403, detail=f"This role has no access to {what}.")
    return HTTPException(status_code=500, detail=f"Failed to list {what}: {e}")


def _friendly_result_scan_error(e: Exception) -> str:
    text = str(e)
    if "does not exist" in text.lower() and "result" in text.lower():
        return "This result set has expired in Snowflake (results are kept for 24 hours). Re-run the query."
    return f"Failed to fetch rows: {text}"


class ProfileRequest(BaseModel):
    """Profile past the page in the browser: a whole table (source "table") or
    every row of a finished query's result (source "result"), with the
    grid's filters when it has any."""
    source: str = Field(..., pattern="^(table|result)$")
    database: Optional[str] = None
    schema_: Optional[str] = Field(None, alias="schema")
    table: Optional[str] = None
    job_id: Optional[str] = None
    filters: Optional[List[ColumnFilter]] = None
    columns: Optional[List[str]] = None      # just these columns (the Profile card's "Whole table" button)

    model_config = {"populate_by_name": True}


_QUERY_ID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _profile_capped(columns: List[tuple], wanted: Optional[List[str]] = None, what: str = "this result"):
    if wanted:
        have = {name for name, _ in columns}
        missing = [w for w in wanted if w not in have]
        if missing:
            raise HTTPException(status_code=400, detail=f"{', '.join(missing)} is not a column of {what}")
        keep = set(wanted)
        columns = [c for c in columns if c[0] in keep]
    return columns[:PROFILE_MAX_COLUMNS], max(0, len(columns) - PROFILE_MAX_COLUMNS)


@snowflake_router.post("/profile")
def profile_data(body: ProfileRequest, conn_id: Optional[str] = Query(None), role: Optional[str] = Query(None),
                 auth: dict = Depends(sf_auth)):
    """Counts, ranges, distinct values and distributions for every column of a
    whole table or result, worked out by Snowflake rather than the browser."""
    started = time.time()
    if body.source == "result":
        if not body.job_id:
            raise HTTPException(status_code=400, detail="job_id is required")
        job = _get_job(body.job_id, auth["user"]["email"], shared=True)
        _touch(job)
        if job["status"] != "success" or not job["returns_rows"]:
            raise HTTPException(status_code=409, detail="This result is not available any more. Run the query again.")
        names = [c["name"] for c in job["columns"]]
        types = {c["name"]: c.get("display_type") or c.get("type") or "" for c in job["columns"]}
        cols, skipped = _profile_capped([(c["name"], profile_family(c.get("type"))) for c in job["columns"]], body.columns)
        if job["inline_rows"] is not None:
            rows, _ = _paged_inline(job, RowsRequest(page=1, page_size=max(1, len(job["inline_rows"])), filters=body.filters))
            out = profile_rows([[r[names.index(n)] for n, _ in cols] for r in rows], cols)
            for c in out["columns"]:
                c["type"] = types.get(c["name"], "")
            return {**out, "source": "result", "columns_skipped": skipped, "elapsed_ms": int((time.time() - started) * 1000)}
        qid = job.get("query_id") or ""
        if not _QUERY_ID.match(qid):
            raise HTTPException(status_code=409, detail="This result can't be read back. Run the query again.")
        # RESULT_SCAN normally takes the id bound; here it appears once per
        # branch of a UNION, so the id (checked above to be a bare UUID) is inlined.
        source = f"TABLE(RESULT_SCAN('{qid}'))"
        database, schema, profile = job["database"], job["schema"], job["profile"]
    else:
        if not (body.database and body.schema_ and body.table):
            raise HTTPException(status_code=400, detail="database, schema and table are required")
        profile = _use_profile(None, conn_id, role)
        table_cols = _fetch_columns(body.database, body.schema_, body.table, profile=profile)
        names = [c["name"] for c in table_cols]
        types = {c["name"]: c["data_type"] for c in table_cols}
        cols, skipped = _profile_capped([(c["name"], profile_family(c["data_type"])) for c in table_cols], body.columns, body.table)
        source = qualified(body.database, body.schema_, body.table)
        database, schema = body.database, body.schema_

    where, params = build_where(body.filters, names)
    timeout = _profile_config(profile)["statement_timeout_seconds"]
    try:
        with _pooled(database, schema, profile=profile) as conn:
            cur = conn.cursor()
            try:
                _apply_statement_timeout(conn, cur, timeout)
                cur.execute(profile_stats_sql(source, where, cols, "snowflake"), tuple(params))
                stats = profile_stats(cur.fetchone(), cols)
                dist = profile_dist_sql(source, where, stats, "snowflake")
                rows = []
                if dist:
                    sql, branches = dist
                    cur.execute(sql, tuple(params) * branches)
                    rows = cur.fetchall()
            finally:
                cur.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not profile this {'result' if body.source == 'result' else 'table'}: {e}")
    out = profile_finish(stats, rows)
    for c in out["columns"]:
        c["type"] = types.get(c["name"], "")
    return {**out, "source": body.source, "columns_skipped": skipped, "elapsed_ms": int((time.time() - started) * 1000)}


@snowflake_router.post("/query/{job_id}/cell")
def get_query_cell(job_id: str, body: CellRequest, auth: dict = Depends(sf_auth)):
    """The whole value of one cell the grid could only show the start of."""
    job = _get_job(job_id, auth["user"]["email"], shared=True)
    _touch(job)
    if job["status"] != "success" or not job["returns_rows"]:
        raise HTTPException(status_code=409, detail="This result is not available any more. Run the query again.")
    names = [c["name"] for c in job["columns"]]
    if body.column not in names:
        raise HTTPException(status_code=400, detail=f"Unknown column '{body.column}'")
    size = max(1, min(int(body.page_size), ROWS_PAGE_MAX_SIZE))
    if job["inline_rows"] is not None:
        rows, _ = _paged_inline(job, body.model_copy(update={"page_size": size}))
        if body.index >= len(rows):
            raise HTTPException(status_code=404, detail="That row is no longer on this page")
        return full_cell(rows[body.index][names.index(body.column)])
    where_sql, where_params = build_where(body.filters, names)
    order_sql = build_order_by(body.sort, names)
    offset = (max(1, int(body.page)) - 1) * size + body.index

    def scan(conn):
        cur = conn.cursor()
        try:
            cur.execute(
                f"SELECT {quote_ident(body.column)} FROM ({_result_scan_sql(job['query_id'])}){where_sql}{order_sql} LIMIT 1 OFFSET {offset}",
                (job["query_id"], *where_params))
            got = cur.fetchone()
        finally:
            cur.close()
        if got is None:
            raise HTTPException(status_code=404, detail="That row is no longer on this page")
        return full_cell(_to_json_safe(got[0]))

    with job["job_lock"]:
        try:
            return scan(_job_connection(job))
        except HTTPException:
            raise
        except Exception as first:
            if not _looks_stale(first):
                raise HTTPException(status_code=500, detail=_friendly_result_scan_error(first))
            _drop_job_connection(job)
            try:
                return scan(_job_connection(job))
            except HTTPException:
                raise
            except Exception as second:
                raise HTTPException(status_code=500, detail=_friendly_result_scan_error(second))


@snowflake_router.post("/query/{job_id}/cancel")
def cancel_query(job_id: str, auth: dict = Depends(sf_auth)):
    job = _get_job(job_id, auth["user"]["email"])
    if job["status"] != "running":
        return {"job_id": job_id, "status": job["status"]}
    job["cancel_requested"] = True

    def stop():
        # Twice: a statement sent a moment before the first cancel may not have
        # reached Snowflake yet, so there was nothing to cancel.
        for wait in (0, 2):
            conn = job.get("conn")
            if conn is not None:
                _doom(conn)
            if job["done"].wait(wait):
                return
            if conn is not None:
                _cancel_session_queries(conn)

    _executor.submit(stop)
    return {"job_id": job_id, "status": "cancelling"}


@snowflake_router.delete("/query/{job_id}")
def close_query(job_id: str, auth: dict = Depends(sf_auth)):
    job = _get_job(job_id, auth["user"]["email"])
    with _jobs_lock:
        _jobs.pop(job_id, None)
    _close_job(job)
    return {"job_id": job_id, "status": "closed"}


# ============================================================================
# Endpoints - export
# ============================================================================

EXPORT_FORMATS = {"csv", "tsv", "json", "xlsx", "sql"}


@snowflake_router.get("/query/{job_id}/download")
def download_query(
    job_id: str,
    fmt: str = Query("csv"),
    sort_json: Optional[str] = Query(None),
    filters_json: Optional[str] = Query(None),
    auth: dict = Depends(sf_auth),
):
    """Streams the FULL result set. Rows are pulled in DOWNLOAD_CHUNK_ROWS
    batches from a dedicated cursor, so memory stays flat no matter how big the
    result is - nothing is ever materialized in one go."""
    job = _get_job(job_id, auth["user"]["email"], shared=True)
    fmt = (fmt or "csv").lower()
    if fmt not in EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported export format '{fmt}'")
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")
    if not job["returns_rows"]:
        raise HTTPException(status_code=409, detail="This statement did not return rows")

    sort = _parse_json_param(sort_json, "sort")
    filters = [ColumnFilter(**f) for f in (_parse_json_param(filters_json, "filters") or [])]
    names = [c["name"] for c in job["columns"]]

    if job["inline_rows"] is not None:
        rows, _ = _paged_inline(job, RowsRequest(page=1, page_size=len(job["inline_rows"]) or 1, sort=sort, filters=filters))
        return _stream_rows(fmt, names, iter([rows]), f"snowflake_query_{job_id[:8]}", job["columns"])

    where_sql, where_params = build_where(filters, names)
    order_sql = build_order_by(sort, names)
    query_id = job["query_id"]
    database, schema, warehouse, profile = job["database"], job["schema"], job["warehouse"], job["profile"]

    def batches():
        with _pooled(database, schema, warehouse, profile) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"SELECT * FROM ({_result_scan_sql(query_id)}){where_sql}{order_sql}",
                    (query_id, *where_params),
                )
                while True:
                    batch = cur.fetchmany(DOWNLOAD_CHUNK_ROWS)
                    if not batch:
                        break
                    yield batch
            finally:
                try:
                    cur.close()
                except Exception:
                    pass

    return _stream_rows(fmt, names, batches(), f"snowflake_query_{job_id[:8]}", job["columns"])


def _parse_json_param(raw: Optional[str], label: str):
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail=f"'{label}' is not valid JSON")
    if not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail=f"'{label}' must be a JSON array")
    return parsed


def _stream_rows(fmt: str, names: List[str], batches, base_filename: str, columns: List[Dict[str, str]]):
    if fmt in ("csv", "tsv"):
        delimiter = "\t" if fmt == "tsv" else ","

        def generate():
            buf = io.StringIO()
            writer = csv.writer(buf, delimiter=delimiter, lineterminator="\n")
            writer.writerow(names)
            yield buf.getvalue()
            for batch in batches:
                buf = io.StringIO()
                writer = csv.writer(buf, delimiter=delimiter, lineterminator="\n")
                for row in batch:
                    writer.writerow([_flatten_for_text(v) for v in row])
                yield buf.getvalue()

        media = "text/tab-separated-values" if fmt == "tsv" else "text/csv"
        return _attachment(generate(), media, f"{base_filename}.{fmt}")

    if fmt == "json":
        def generate():
            yield "[\n"
            first = True
            for batch in batches:
                chunk = []
                for row in batch:
                    obj = {name: _to_json_safe(value) for name, value in zip(names, row)}
                    chunk.append(("" if first else ",\n") + json.dumps(obj, default=str))
                    first = False
                if chunk:
                    yield "".join(chunk)
            yield "\n]\n"

        return _attachment(generate(), "application/json", f"{base_filename}.json")

    if fmt == "sql":
        def generate():
            for batch in batches:
                lines = []
                for row in batch:
                    values = ", ".join(_sql_literal(v) for v in row)
                    cols = ", ".join(quote_ident(n) for n in names)
                    lines.append(f"INSERT INTO {quote_ident('TARGET_TABLE')} ({cols}) VALUES ({values});\n")
                yield "".join(lines)

        return _attachment(generate(), "application/sql", f"{base_filename}.sql")

    # xlsx: xlsxwriter's constant_memory mode keeps one row in RAM at a time.
    import tempfile

    import xlsxwriter

    tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    tmp.close()
    written = 0
    truncated = False
    try:
        workbook = xlsxwriter.Workbook(tmp.name, {"constant_memory": True, "default_date_format": "yyyy-mm-dd hh:mm:ss"})
        sheet = workbook.add_worksheet("Results")
        header_fmt = workbook.add_format({"bold": True, "bg_color": "#F2F2F2", "border": 1})
        for i, name in enumerate(names):
            sheet.write_string(0, i, str(name), header_fmt)
        sheet.freeze_panes(1, 0)
        for batch in batches:
            for row in batch:
                if written >= XLSX_MAX_ROWS:
                    truncated = True
                    break
                written += 1
                for i, value in enumerate(row):
                    safe = _to_json_safe(value)
                    if safe is None:
                        continue
                    if isinstance(safe, bool):
                        sheet.write_boolean(written, i, safe)
                    elif isinstance(safe, (int, float)):
                        sheet.write_number(written, i, safe)
                    else:
                        text = _flatten_for_text(value)
                        # Excel's own hard limit on a single cell.
                        sheet.write_string(written, i, text[:32767])
            if truncated:
                break
        if truncated:
            sheet.write_string(min(written + 1, XLSX_MAX_ROWS), 0,
                               f"Truncated at {XLSX_MAX_ROWS:,} rows - Excel's sheet limit. Use CSV for the full result set.")
        workbook.close()
    except Exception as e:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to build the Excel file: {e}")

    def generate_file():
        try:
            with open(tmp.name, "rb") as fh:
                while True:
                    chunk = fh.read(1024 * 256)
                    if not chunk:
                        break
                    yield chunk
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    return _attachment(
        generate_file(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"{base_filename}.xlsx",
    )


def _attachment(generator, media_type: str, filename: str):
    return StreamingResponse(
        generator,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float, Decimal)):
        return str(value)
    text = _flatten_for_text(value).replace("\\", "\\\\").replace("'", "''")
    return "'" + text + "'"


# ============================================================================
# Table data editor
# ----------------------------------------------------------------------------
# The grid-editing half of the page: read a table's rows directly (with server
# side paging, sorting and filtering), then push cell edits, new rows and
# deletes back as generated SQL. Every mutation runs inside one transaction and
# is verified to touch exactly the rows it claimed to, or the whole batch rolls
# back.
# ============================================================================

# Types whose values a text input can round-trip safely.
_UNEDITABLE_TYPES = {"GEOGRAPHY", "GEOMETRY", "BINARY", "VARBINARY", "VECTOR", "FILE"}
_SEMI_STRUCTURED = {"VARIANT", "OBJECT", "ARRAY", "MAP"}
_NUMERIC_TYPES = {"NUMBER", "DECIMAL", "NUMERIC", "INT", "INTEGER", "BIGINT", "SMALLINT",
                  "TINYINT", "BYTEINT", "FLOAT", "FLOAT4", "FLOAT8", "DOUBLE", "REAL"}


def _base_type(data_type: str) -> str:
    return re.sub(r"\(.*\)", "", (data_type or "")).strip().upper()


def is_editable_type(data_type: str) -> bool:
    return _base_type(data_type) not in _UNEDITABLE_TYPES


def is_comparable_type(data_type: str) -> bool:
    """Semi-structured and geo columns can't sit in a WHERE key match directly;
    they get compared as text instead."""
    base = _base_type(data_type)
    return base not in _SEMI_STRUCTURED and base not in _UNEDITABLE_TYPES


def _cast_placeholder(data_type: str) -> str:
    """SQL fragment that turns a bound string into the column's real type.
    Values always arrive as text from the browser, so the cast happens in
    Snowflake where the type rules actually live."""
    base = _base_type(data_type)
    if base in _SEMI_STRUCTURED:
        return "TO_VARIANT(PARSE_JSON(?))"
    if base in _NUMERIC_TYPES:
        return f"CAST(? AS {data_type})"
    if base in ("BOOLEAN",):
        return "TO_BOOLEAN(?)"
    if base in ("DATE",):
        return "TO_DATE(?)"
    if base in ("TIME",):
        return "TO_TIME(?)"
    if base.startswith("TIMESTAMP"):
        return f"TO_{base}(?)" if base in ("TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "TIMESTAMP_TZ") else "TO_TIMESTAMP(?)"
    return "CAST(? AS VARCHAR)" if base in ("VARCHAR", "STRING", "TEXT", "CHAR", "CHARACTER") else "?"


def _bind_value(value: Any, data_type: str):
    """Everything binds as a string (or None) and gets cast in SQL. Keeping one
    representation end to end is what stops '007' from silently becoming 7 or a
    timestamp from losing its offset."""
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _key_columns_for(columns: List[Dict[str, Any]], requested: Optional[List[str]]) -> List[str]:
    by_name = {c["name"]: c for c in columns}
    if requested:
        unknown = [c for c in requested if c not in by_name]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown key column(s): {', '.join(unknown)}")
        return list(requested)
    pk = [c["name"] for c in columns if c["is_primary_key"]]
    if pk:
        return pk
    # No declared PK - Snowflake rarely has one. Match on every comparable
    # column's original value instead, and let the affected-row check below be
    # the thing that guarantees we only touched one row.
    fallback = [c["name"] for c in columns if c["comparable"]]
    if not fallback:
        raise HTTPException(
            status_code=400,
            detail="This table has no primary key and no comparable columns, so rows cannot be matched safely. Add a primary key or edit via SQL.",
        )
    return fallback


def _where_for_row(original: Dict[str, Any], key_columns: List[str], columns_by_name: Dict[str, Dict[str, Any]]):
    """WHERE that matches exactly the row the user was looking at. EQUAL_NULL is
    used throughout so a NULL in a key column matches a NULL rather than
    matching nothing."""
    clauses, params = [], []
    for name in key_columns:
        col = columns_by_name.get(name)
        if col is None:
            raise HTTPException(status_code=400, detail=f"Unknown key column '{name}'")
        if name not in original:
            raise HTTPException(status_code=400, detail=f"The row is missing key column '{name}' - refresh and try again")
        value = original[name]
        if _is_truncated(value):
            # The grid only had the start of this value, so it can't be matched.
            # The other columns still do, and the one-row check guards the rest.
            continue
        ident = quote_ident(name)
        if not col["comparable"]:
            clauses.append(f"EQUAL_NULL(TO_VARCHAR({ident}), ?)")
            params.append(_bind_value(value, "VARCHAR"))
        elif _base_type(col["data_type"]) in _SEMI_STRUCTURED:
            clauses.append(f"EQUAL_NULL(TO_VARCHAR({ident}), ?)")
            params.append(_bind_value(value, "VARCHAR"))
        else:
            clauses.append(f"EQUAL_NULL({ident}, {_cast_placeholder(col['data_type'])})")
            params.append(_bind_value(value, col["data_type"]))
    if not clauses:
        raise HTTPException(status_code=400, detail="No key columns available to match this row")
    return " AND ".join(clauses), params


@snowflake_router.post("/table/rows")
def table_rows(body: TableRowsRequest, conn_id: Optional[str] = Query(None), role: Optional[str] = Query(None),
               auth: dict = Depends(sf_auth)):
    """Paged, sorted, filtered read straight off a table - the data-editor grid,
    as opposed to the result of an ad-hoc query."""
    profile = _use_profile(None, conn_id, role)
    cfg = _profile_config(profile)
    page = max(1, int(body.page))
    page_size = max(1, min(int(body.page_size), ROWS_PAGE_MAX_SIZE))
    columns = _fetch_columns(body.database, body.schema_, body.table, profile=profile)
    names = [c["name"] for c in columns]

    where_sql, where_params = build_where(body.filters, names)
    order_sql = build_order_by(body.sort, names)
    target = qualified(body.database, body.schema_, body.table)
    offset = (page - 1) * page_size

    # The row count and the page itself are independent queries, so they run at
    # the same time on two pooled connections rather than one after the other.
    count_future = None
    if body.exact_count:
        def count_rows():
            with _pooled(body.database, body.schema_, profile=profile) as conn:
                cur = conn.cursor()
                try:
                    cur.execute(f"SELECT COUNT(*) FROM {target}{where_sql}", tuple(where_params))
                    return int(cur.fetchone()[0])
                finally:
                    cur.close()

        count_future = _executor.submit(count_rows)

    try:
        with _pooled(body.database, body.schema_, profile=profile) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"SELECT * FROM {target}{where_sql}{order_sql} LIMIT {page_size} OFFSET {offset}",
                    tuple(where_params),
                )
                result_columns = _describe_columns(cur)
                rows = grid_rows([[_to_json_safe(v) for v in r] for r in cur.fetchall()])
            finally:
                cur.close()
    except HTTPException:
        raise
    except Exception as e:
        if count_future is not None:
            count_future.cancel()
        raise HTTPException(status_code=500, detail=f"Failed to read {body.schema_}.{body.table}: {e}")

    total = None
    if count_future is not None:
        try:
            total = count_future.result()
        except Exception as e:
            # A slow or failed count shouldn't cost the user their rows.
            logger.info("Row count for %s failed: %s", target, e)

    key_columns = [c["name"] for c in columns if c["is_primary_key"]]
    return {
        "columns": columns,
        "result_columns": result_columns,
        "rows": rows,
        "page": page,
        "page_size": page_size,
        "total_rows": total,
        "total_pages": max(1, -(-total // page_size)) if total else None,
        "primary_key": key_columns,
        "editable": cfg["allow_writes"] and _has(auth, PERM_WRITE),
    }


@snowflake_router.post("/table/mutate")
def table_mutate(body: MutateRequest, conn_id: Optional[str] = Query(None), role: Optional[str] = Query(None),
                 auth: dict = Depends(sf_auth)):
    """Applies grid edits as one transaction. Each statement is checked to have
    affected exactly one row; anything else rolls the whole batch back, so a
    stale row version can never quietly update a hundred rows."""
    _require(auth, PERM_WRITE, "edit table data")
    profile = _use_profile(None, conn_id, role)
    cfg = _profile_config(profile)
    if not cfg["allow_writes"]:
        raise HTTPException(status_code=403, detail="This connection is configured read-only")
    if not body.changes:
        raise HTTPException(status_code=400, detail="No changes to apply")
    if len(body.changes) > 500:
        raise HTTPException(status_code=400, detail="Apply at most 500 row changes at a time")

    columns = _fetch_columns(body.database, body.schema_, body.table, profile=profile)
    by_name = {c["name"]: c for c in columns}
    key_columns = _key_columns_for(columns, body.key_columns)
    target = qualified(body.database, body.schema_, body.table)

    # Build every statement up front so a bad change fails before anything runs.
    plan: List[Dict[str, Any]] = []
    for index, change in enumerate(body.changes):
        kind = (change.kind or "").lower()
        if kind == "insert":
            values = change.values or {}
            if not values:
                raise HTTPException(status_code=400, detail=f"Change {index + 1}: an insert needs at least one value")
            unknown = [c for c in values if c not in by_name]
            if unknown:
                raise HTTPException(status_code=400, detail=f"Change {index + 1}: unknown column(s) {', '.join(unknown)}")
            cols, placeholders, params = [], [], []
            for name, value in values.items():
                col = by_name[name]
                if not col["editable"]:
                    raise HTTPException(status_code=400, detail=f"Column '{name}' ({col['data_type']}) cannot be edited from the grid")
                cols.append(quote_ident(name))
                placeholders.append("NULL" if value is None else _cast_placeholder(col["data_type"]))
                if value is not None:
                    params.append(_bind_value(value, col["data_type"]))
            sql = f"INSERT INTO {target} ({', '.join(cols)}) SELECT {', '.join(placeholders)}"
            plan.append({"kind": "insert", "sql": sql, "params": params, "expect": 1, "index": index,
                         "dup_check": _dup_check(target, {k: values.get(k) for k in key_columns}, key_columns, by_name)})

        elif kind == "update":
            values = change.values or {}
            original = change.original or {}
            if not values:
                raise HTTPException(status_code=400, detail=f"Change {index + 1}: an update needs at least one changed value")
            unknown = [c for c in values if c not in by_name]
            if unknown:
                raise HTTPException(status_code=400, detail=f"Change {index + 1}: unknown column(s) {', '.join(unknown)}")
            sets, params = [], []
            for name, value in values.items():
                col = by_name[name]
                if not col["editable"]:
                    raise HTTPException(status_code=400, detail=f"Column '{name}' ({col['data_type']}) cannot be edited from the grid")
                if value is None:
                    sets.append(f"{quote_ident(name)} = NULL")
                else:
                    sets.append(f"{quote_ident(name)} = {_cast_placeholder(col['data_type'])}")
                    params.append(_bind_value(value, col["data_type"]))
            where_sql, where_params = _where_for_row(original, key_columns, by_name)
            sql = f"UPDATE {target} SET {', '.join(sets)} WHERE {where_sql}"
            after = {k: (values[k] if k in values else original.get(k)) for k in key_columns}
            plan.append({"kind": "update", "sql": sql, "params": params + where_params, "expect": 1, "index": index,
                         "dup_check": _dup_check(target, after, key_columns, by_name)})

        elif kind == "delete":
            original = change.original or {}
            where_sql, where_params = _where_for_row(original, key_columns, by_name)
            sql = f"DELETE FROM {target} WHERE {where_sql}"
            plan.append({"kind": "delete", "sql": sql, "params": where_params, "expect": 1, "index": index})

        else:
            raise HTTPException(status_code=400, detail=f"Change {index + 1}: unknown change kind '{change.kind}'")

    if not body.confirm:
        return {
            "requires_confirmation": True,
            "key_columns": key_columns,
            # params let the UI show the actual values in the preview; the
            # confirmed call rebuilds and binds them the same way.
            "statements": [{"kind": p["kind"], "sql": p["sql"], "params": p["params"]} for p in plan],
            "summary": _change_summary(plan),
        }

    conn, pool_key, pool_created = _pool.acquire(body.database, body.schema_, profile=profile)
    applied = []
    healthy = True
    try:
        cur = conn.cursor()
        cur.execute("BEGIN")
        try:
            for step in plan:
                cur.execute(step["sql"], tuple(step["params"]))
                affected = _affected_rows(cur)
                if affected != step["expect"]:
                    raise _MutationMismatch(step, affected)
                # The grid matches rows on the key columns, so two rows with the
                # same key values could never be edited safely again. Checked
                # after the statement so earlier rows in this batch count too.
                if step.get("dup_check"):
                    check_sql, check_params = step["dup_check"]
                    cur.execute(check_sql, tuple(check_params))
                    found = cur.fetchone()
                    if found and found[0] and int(found[0]) > 1:
                        raise _DuplicateRow(step, key_columns)
                applied.append({"kind": step["kind"], "rows": affected})
            cur.execute("COMMIT")
        except Exception:
            try:
                cur.execute("ROLLBACK")
            except Exception:
                healthy = False     # may still be inside the transaction: never pool it
            raise
        finally:
            cur.close()
    except _DuplicateRow as dr:
        step = dr.step
        what = "the same primary key as" if any(c["is_primary_key"] for c in columns) else "exactly the same values as"
        raise HTTPException(
            status_code=409,
            detail=(
                f"Change {step['index'] + 1} ({step['kind']}) would leave a row with {what} another row "
                f"(compared on {', '.join(dr.key_columns[:6])}{'...' if len(dr.key_columns) > 6 else ''}). "
                "Nothing was applied. Change at least one value and try again."
            ),
        )
    except _MutationMismatch as mm:
        step, affected = mm.step, mm.affected
        if affected == 0:
            detail = (
                f"Change {step['index'] + 1} ({step['kind']}) matched no rows - the row was changed or deleted by "
                "someone else since you loaded it. Nothing was applied; refresh and try again."
            )
        else:
            detail = (
                f"Change {step['index'] + 1} ({step['kind']}) would have affected {affected} rows instead of 1. "
                "Nothing was applied. This table has no unique key for these values."
            )
        raise HTTPException(status_code=409, detail=detail)
    except HTTPException:
        raise
    except Exception as e:
        healthy = healthy and not _looks_stale(e)
        raise HTTPException(status_code=500, detail=f"Changes were rolled back: {e}")
    finally:
        if healthy:
            _pool.release(conn, pool_key, pool_created)
        else:
            _quiet_close(conn)

    _drop_table_cache(body.database, body.schema_)
    _cache_drop_prefix(f"sf-tables:{profile}:{body.database}:{body.schema_}")
    try:
        from audit import write_audit_event
        write_audit_event(
            "sfqr_table_edit",
            auth["user"]["email"],
            f"{body.database}.{body.schema_}.{body.table}",
            _change_summary(plan),
        )
    except Exception:
        pass

    return {"applied": applied, "total": len(applied), "summary": _change_summary(plan)}


class _DuplicateRow(Exception):
    def __init__(self, step: Dict[str, Any], key_columns: List[str]):
        super().__init__(f"{step['kind']} would create a duplicate row")
        self.step = step
        self.key_columns = key_columns


def _dup_check(target: str, row: Dict[str, Any], key_columns: List[str], by_name: Dict[str, Dict[str, Any]]):
    """COUNT(*) of rows that look the same as `row` on the key columns. Run
    after an insert or update, more than one means we just made a duplicate."""
    where_sql, where_params = _where_for_row(row, key_columns, by_name)
    return f"SELECT COUNT(*) FROM {target} WHERE {where_sql}", where_params


class _MutationMismatch(Exception):
    def __init__(self, step: Dict[str, Any], affected: int):
        super().__init__(f"{step['kind']} affected {affected} rows")
        self.step = step
        self.affected = affected


def _affected_rows(cur) -> int:
    """Snowflake returns the touched-row counts as a result row ('number of rows
    updated', 'number of rows inserted', ...). Sum them; fall back to rowcount."""
    try:
        rows = cur.fetchall()
    except Exception:
        rows = None
    if rows:
        total = 0
        for row in rows:
            for value in row:
                if isinstance(value, (int, Decimal)) and not isinstance(value, bool):
                    total += int(value)
        return total
    return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def _change_summary(plan: List[Dict[str, Any]]) -> str:
    counts = {"insert": 0, "update": 0, "delete": 0}
    for step in plan:
        counts[step["kind"]] += 1
    parts = [f"{n} {kind}{'s' if n != 1 else ''}" for kind, n in counts.items() if n]
    return ", ".join(parts) or "no changes"


# ============================================================================
# Workspace endpoints - history and saved queries
# ============================================================================

@snowflake_router.get("/history")
def get_history(limit: int = Query(50, ge=1, le=200), auth: dict = Depends(sf_auth)):
    _init_db()
    email = (auth["user"]["email"] or "").strip().lower()
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, sql, database, schema, status, elapsed_ms, row_count, error, created_at "
            "FROM sf_query_history WHERE user_email = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            (email, limit),
        ).fetchall()
    return {"history": [dict(r) for r in rows]}


@snowflake_router.delete("/history")
def clear_history(auth: dict = Depends(sf_auth)):
    _init_db()
    email = (auth["user"]["email"] or "").strip().lower()
    with _db() as conn:
        conn.execute("DELETE FROM sf_query_history WHERE user_email = ?", (email,))
    return {"cleared": True}


@snowflake_router.get("/saved")
def list_saved(auth: dict = Depends(sf_auth)):
    _init_db()
    email = (auth["user"]["email"] or "").strip().lower()
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, user_email, name, sql, database, schema, shared, created_at, updated_at "
            "FROM sf_saved_queries WHERE user_email = ? OR shared ORDER BY updated_at DESC, id",
            (email,),
        ).fetchall()
    return {
        "saved": [
            {**dict(r), "shared": bool(r["shared"]), "owned": r["user_email"] == email}
            for r in rows
        ]
    }


@snowflake_router.post("/saved")
def create_saved(body: SavedQueryRequest, auth: dict = Depends(sf_auth)):
    _init_db()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the saved query a name")
    if len(name) > 200:
        raise HTTPException(status_code=400, detail="That name is too long (200 characters max)")
    if not (body.sql or "").strip():
        raise HTTPException(status_code=400, detail="There's no SQL to save")
    email = (auth["user"]["email"] or "").strip().lower()
    now = datetime.now(timezone.utc)
    saved_id = uuid.uuid4().hex
    with _db() as conn:
        conn.execute(
            "INSERT INTO sf_saved_queries (id, user_email, name, sql, database, schema, shared, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (saved_id, email, name, body.sql[:200000], body.database or "", body.schema_ or "", bool(body.shared), now, now),
        )
    return {"id": saved_id, "name": name, "created_at": db.utc_naive_iso(now)}


@snowflake_router.put("/saved/{saved_id}")
def update_saved(saved_id: str, body: SavedQueryRequest, auth: dict = Depends(sf_auth)):
    _init_db()
    email = (auth["user"]["email"] or "").strip().lower()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give the saved query a name")
    if len(name) > 200:
        raise HTTPException(status_code=400, detail="That name is too long (200 characters max)")
    if not (body.sql or "").strip():
        raise HTTPException(status_code=400, detail="There's no SQL to save")
    now = datetime.now(timezone.utc)
    with _db() as conn:
        # Owner check and write in one statement, so the row can't change
        # hands (or vanish) between checking and updating.
        updated = conn.execute(
            "UPDATE sf_saved_queries SET name = ?, sql = ?, database = ?, schema = ?, shared = ?, updated_at = ? "
            "WHERE id = ? AND user_email = ? RETURNING id",
            (name, body.sql[:200000], body.database or "", body.schema_ or "", bool(body.shared), now, saved_id, email),
        ).fetchone()
        if not updated:
            row = conn.execute("SELECT user_email FROM sf_saved_queries WHERE id = ?", (saved_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Saved query not found")
            raise HTTPException(status_code=403, detail="Only the owner can edit this saved query")
    return {"id": saved_id, "updated_at": db.utc_naive_iso(now)}


@snowflake_router.delete("/saved/{saved_id}")
def delete_saved(saved_id: str, auth: dict = Depends(sf_auth)):
    _init_db()
    email = (auth["user"]["email"] or "").strip().lower()
    with _db() as conn:
        deleted = conn.execute(
            "DELETE FROM sf_saved_queries WHERE id = ? AND user_email = ? RETURNING id", (saved_id, email)
        ).fetchone()
        if not deleted:
            row = conn.execute("SELECT user_email FROM sf_saved_queries WHERE id = ?", (saved_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Saved query not found")
            raise HTTPException(status_code=403, detail="Only the owner can delete this saved query")
    return {"deleted": True}


def shutdown():
    """Called from app.py's shutdown hook - drop every held connection."""
    with _jobs_lock:
        jobs = list(_jobs.values())
        _jobs.clear()
    for job in jobs:
        _close_job(job)
    _pool.close_all()
