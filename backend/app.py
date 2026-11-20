import os as _os
import warnings as _warnings

# Trust the operating system's certificate store (where corporate root CAs such
# as J&J's are installed) for outbound HTTPS, so internal services like Denodo
# can be verified instead of skipping the check. SMARTHUB_OS_TRUSTSTORE=false turns it off.
if (_os.environ.get("SMARTHUB_OS_TRUSTSTORE") or "true").strip().lower() not in ("0", "false", "no", "off"):
    try:
        import truststore as _truststore
        _truststore.inject_into_ssl()
    except ImportError:
        pass

# The Snowflake connector warns on every connection that a logout default will
# change in a future version. The portal runs no async Snowflake queries, so
# either default behaves the same here; keep the logs readable.
_warnings.filterwarnings("ignore", message=r".*enable_server_session_keep_alive_auto_detection was not set.*", category=FutureWarning)

from fastapi import FastAPI, HTTPException, Body, Query, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
import orjson
import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
from io import BytesIO
import re
import inspect
import json
import os
import snowflake.connector
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from pathlib import Path
import logging
from datetime import datetime
import pytz
from typing import Optional, List, Dict, Any
import oracledb
import threading
from concurrent.futures import ThreadPoolExecutor
from pydantic import BaseModel
from dataclasses import dataclass

# Server-side authentication & authorization. Identity comes from the
# validated bearer token only — never from a client-supplied header.
from auth import (
    require_auth,
    require_permission,
    invalidate_role_cache,
    set_rbac_config_loader,
    configure_ad_groups,
    configure_api_keys,
    get_all_roles,
    BUILTIN_ROLES,
    normalize_user_overrides,
    validate_role_definition,
    effective_permissions_from_config,
    get_role_permissions,
    ROLE_ID_PATTERN,
    AD_GROUP_ROLES,
    fetch_user_groups,
    holds_everything,
    primary_role,
    get_roles_permissions,
    user_roles_entry,
    normalize_datasets,
    get_role_datasets,
    bdc_datasets,
    dataset_sql,
)
import time
import subprocess
import asyncio
import uuid
import db
import copy
from contextlib import contextmanager

# Timezone — all app-generated timestamps use Eastern Time (auto DST: EST/EDT)
EASTERN = pytz.timezone('America/New_York')


class _TTLByteCache:

    def __init__(self, ttl_seconds: int = 900):
        self._ttl = ttl_seconds
        self._store: Dict[str, tuple[float, bytes]] = {}
        self._lock = threading.Lock()

    def _sweep_locked(self) -> None:
        now = time.time()
        expired = [k for k, (exp, _) in self._store.items() if exp <= now]
        for k in expired:
            del self._store[k]

    def __setitem__(self, token: str, data: bytes) -> None:
        with self._lock:
            self._sweep_locked()
            self._store[token] = (time.time() + self._ttl, data)

    def pop(self, token: str, default=None):
        with self._lock:
            entry = self._store.pop(token, None)
        if entry is None:
            return default
        exp, data = entry
        if exp <= time.time():
            return default
        return data


# In-memory caches for prepared download files {token: bytes}, TTL-expired so
# never-fetched files don't accumulate.
_download_cache = _TTLByteCache(ttl_seconds=900)   # 15 min

_delta_cache = _TTLByteCache(ttl_seconds=900)       # 15 min

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="GRA-SmartHub Backend", version="0.1.0")


# The portal's own PostgreSQL database (smarthub_core). A database that can't
# be reached, or a statement that ran past its timeout, is a 503 the browser
# can retry - not a stack trace. A constraint violation that got past a
# module's own checks means two people changed the same thing at once.
# Errors from other PostgreSQL servers (query runners, source systems) use the
# same driver classes, so only ones db.py tagged as its own are answered here;
# anything else stays the plain 500 it always was.
from fastapi import Request as _Request
from fastapi.responses import JSONResponse as _JSONResponse, PlainTextResponse as _PlainTextResponse


def _not_ours(request: _Request, exc: Exception):
    logger.error(f"Unhandled {type(exc).__name__} on {request.method} {request.url.path}", exc_info=exc)
    return _PlainTextResponse("Internal Server Error", status_code=500)


@app.exception_handler(db.DatabaseUnavailable)
@app.exception_handler(db.OperationalError)
async def _database_unavailable(request: _Request, exc: Exception):
    if not db.is_core_error(exc):
        return _not_ours(request, exc)
    logger.error(f"Database unavailable on {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return _JSONResponse(
        status_code=503,
        content={"detail": "The portal database is busy or unavailable. Try again in a moment."},
        headers={"Retry-After": "2"},
    )


@app.exception_handler(db.IntegrityError)
async def _database_conflict(request: _Request, exc: Exception):
    if not db.is_core_error(exc):
        return _not_ours(request, exc)
    logger.warning(f"Database conflict on {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return _JSONResponse(
        status_code=409,
        content={"detail": "That clashes with a change made at the same moment. Refresh and try again."},
    )


# ============================================================================
# CONFIGURATION
# ============================================================================

def load_config():
    """Load configuration from denodo_config.json"""
    config_path = Path(__file__).parent / "dq_config.json"
    if not config_path.exists():
        raise FileNotFoundError(f"Configuration file not found: {config_path}")

    with open(config_path, 'r') as f:
        config = json.load(f)

    if 'denodo_service_account' not in config:
        raise ValueError("Denodo service account configuration not found")
    if 'snowflake' not in config:
        raise ValueError("Snowflake configuration not found")
    if 'scripts' not in config:
        raise ValueError("Scripts configuration not found")
    required_script_fields = ['script_dir', 'python_path']
    for field in required_script_fields:
        if field not in config['scripts']:
            raise ValueError(f"Scripts config missing required field: {field}")
    # Validate Snowflake config has required fields
    required_sf_fields = ['account', 'user', 'private_key_path', 'private_key_password',
                          'role', 'warehouse', 'database', 'schema', 'table_name']
    for field in required_sf_fields:
        if field not in config['snowflake']:
            raise ValueError(f"Snowflake config missing required field: {field}")

    return config


# ============================================================================
# BUSINESS DEFINED CHECKS - Configuration & Connection Management
# ============================================================================

# What the results schemas are called when the config does not say. These were
# hard-coded in every query until they became settings.
DEFAULT_CORE_SCHEMA = "DQ_CORE"
DEFAULT_STG_SCHEMA = "DQ_STG"


class BDCConfigManager:
    """Configuration manager for Business Defined Checks"""

    def __init__(self, main_config: dict):
        self.config = main_config
        self.available = False

        try:
            if not main_config:
                logger.warning("⚠️ BDC config not found - main config is None")
                return

            if 'business_defined_checks' not in main_config:
                logger.warning("⚠️ BDC section not found in config")
                return

            self.bdc_config = main_config['business_defined_checks']
            self.available = True
            logger.info("✅ BDC configuration loaded")
        except Exception as e:
            logger.warning(f"⚠️ Could not load BDC config: {e}")

    def get_snowflake_config(self) -> Dict[str, str]:
        """Get Snowflake configuration for BDC"""
        if not self.available:
            raise ValueError("BDC configuration not available")
        return self.bdc_config

    def get_write_snowflake_config(self) -> Dict[str, str]:
        """Get write-specific Snowflake configuration.

        Looks for a ``business_defined_checks_write`` key in the top-level config.
        Falls back to the standard read config when no write-specific section exists.
        """
        if not self.available:
            raise ValueError("BDC configuration not available")

        if "business_defined_checks_write" in self.config:
            return self.config["business_defined_checks_write"]

        logger.warning(
            "No 'business_defined_checks_write' section found in config — falling back to read "
            "credentials for write operations."
        )
        return self.get_snowflake_config()

    def get_dq_config(self) -> Dict[str, str]:
        """Get Data Quality table/view names"""
        if not self.available:
            raise ValueError("BDC configuration not available")
        return self.bdc_config

    def get_full_table_name(self, table_name: str) -> str:
        """Returns fully qualified table name: database.schema.table"""
        sf_config = self.get_snowflake_config()
        database = sf_config.get('database')
        schema = sf_config.get('schema')
        return f"{database}.{schema}.{table_name}"

    # ------------------------------------------------------------------
    # Results schemas
    #
    # The registry and its views live in 'schema'. The rows a run produces
    # live somewhere else again - historically the literal DQ_CORE, with the
    # archive of past runs in DQ_STG. Both are settings now; they keep those
    # names when nothing says otherwise, so an existing deployment sees no
    # change.
    # ------------------------------------------------------------------

    def get_core_schema(self) -> str:
        """Schema holding the current failed-row tables and the review registry."""
        if not self.available:
            return DEFAULT_CORE_SCHEMA
        return str(self.bdc_config.get('core_schema') or '').strip() or DEFAULT_CORE_SCHEMA

    def get_stg_schema(self) -> str:
        """Schema holding the archived per-run snapshots."""
        if not self.available:
            return DEFAULT_STG_SCHEMA
        return str(self.bdc_config.get('stg_schema') or '').strip() or DEFAULT_STG_SCHEMA

    def core_table(self, table_name: str) -> str:
        """database.core_schema.table"""
        database = self.get_snowflake_config().get('database')
        return f"{database}.{self.get_core_schema()}.{table_name}"

    def stg_table(self, table_name: str) -> str:
        """database.stg_schema.table"""
        database = self.get_snowflake_config().get('database')
        return f"{database}.{self.get_stg_schema()}.{table_name}"


@dataclass
class SnowflakeQueryResult:
    """Result of a Snowflake query"""
    rows: list[tuple]
    columns: list[str]
    query_id: Optional[str]
    elapsed_ms: int


class SnowflakeClient:
    """Snowflake client wrapper"""

    def __init__(self, conn: snowflake.connector.SnowflakeConnection):
        self.conn = conn

    def execute(self, sql: str, params: Optional[Dict[str, Any]] = None) -> SnowflakeQueryResult:
        """Execute SQL query and return results"""
        t0 = time.time()
        cur = self.conn.cursor()
        try:
            cur.execute(sql, params or {})
            rows = cur.fetchall() if cur.description else []
            cols = [c[0] for c in cur.description] if cur.description else []
            qid = getattr(cur, "sfqid", None)
            elapsed = int((time.time() - t0) * 1000)
            return SnowflakeQueryResult(rows=rows, columns=cols, query_id=qid, elapsed_ms=elapsed)
        finally:
            cur.close()

    def close(self):
        """Close the Snowflake connection"""
        if self.conn:
            self.conn.close()


def load_bdc_private_key(private_key_path: str, private_key_password: str) -> bytes:
    """Load private key for BDC Snowflake connection"""
    if not Path(private_key_path).exists():
        raise FileNotFoundError(f"Private key file not found at {private_key_path}")

    with open(private_key_path, "rb") as f:
        key = serialization.load_pem_private_key(
            f.read(),
            password=private_key_password.encode() if private_key_password else None
        )
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )


def get_bdc_snowflake_connection(config: Dict[str, str]) -> snowflake.connector.SnowflakeConnection:
    """Create Snowflake connection for BDC"""
    private_key = load_bdc_private_key(
        config["private_key_path"],
        config.get("private_key_password", "")
    )

    conn = snowflake.connector.connect(
        user=config["user"],
        account=config["account"],
        private_key=private_key,
        role=config["role"],
        warehouse=config["warehouse"],
        database=config["database"],
        schema=config["schema"],
        # Same session zone as the DQE engine, so CURRENT_TIMESTAMP() written by
        # either side means Eastern time and the UI can read naive times as ET.
        timezone="America/New_York",
    )
    return conn


class BDCConnectionManager:
    """Manages Snowflake connections for Business Defined Checks with auto-refresh"""

    def __init__(self, config_manager: BDCConfigManager):
        self.config_manager = config_manager
        self.connections: Dict[str, SnowflakeClient] = {}
        self.connection_locks: Dict[str, threading.Lock] = {}
        self.connection_created_at: Dict[str, float] = {}
        self.available = False
        # Refresh connections after 2 hours (tokens expire after ~4 hours)
        self.CONNECTION_TTL = 2 * 60 * 60  # 2 hours in seconds

        if not config_manager.available:
            logger.warning("⚠️ BDC Connection Manager not initialized - config not available")
            return

        # Initialize single connection lock
        self.connection_locks["DEFAULT"] = threading.Lock()

        # Validate config and create initial connection
        self._initialize_connections()
        self.available = True

    def _initialize_connections(self):
        """Initialize the Snowflake connection"""
        try:
            sf_config = self.config_manager.get_snowflake_config()
            conn = get_bdc_snowflake_connection(sf_config)
            self.connections["DEFAULT"] = SnowflakeClient(conn)
            self.connection_created_at["DEFAULT"] = time.time()
            logger.info("✅ BDC connection established")
        except Exception as e:
            logger.warning(f"⚠️ BDC connection failed: {e}")
            self.connections["DEFAULT"] = None

    def _is_connection_expired(self) -> bool:
        """Check if connection should be refreshed based on TTL"""
        if "DEFAULT" not in self.connection_created_at:
            return True
        age = time.time() - self.connection_created_at["DEFAULT"]
        return age > self.CONNECTION_TTL

    def _validate_and_refresh_connection(self) -> bool:
        """Validate connection and refresh if needed. Returns True if connection is valid."""
        with self.connection_locks["DEFAULT"]:
            client = self.connections.get("DEFAULT")

            if client is None:
                logger.info("Creating new BDC connection")
                return self._create_new_connection()

            if self._is_connection_expired():
                logger.info("Refreshing BDC connection (TTL exceeded)")
                return self._create_new_connection()

            try:
                result = client.execute("SELECT 1")
                if result.rows:
                    return True
                logger.warning("BDC connection validation failed")
                return self._create_new_connection()
            except Exception as e:
                error_str = str(e)
                if "token has expired" in error_str.lower() or "authentication" in error_str.lower():
                    logger.warning("BDC connection token expired, refreshing...")
                else:
                    logger.warning(f"BDC connection error: {e}")
                return self._create_new_connection()

    def _create_new_connection(self) -> bool:
        """Create a new connection. Must be called within lock."""
        try:
            if self.connections.get("DEFAULT"):
                try:
                    self.connections["DEFAULT"].close()
                except:
                    pass

            # Create new connection
            sf_config = self.config_manager.get_snowflake_config()
            conn = get_bdc_snowflake_connection(sf_config)
            self.connections["DEFAULT"] = SnowflakeClient(conn)
            self.connection_created_at["DEFAULT"] = time.time()
            logger.info("✅ BDC connection created successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to create BDC connection: {e}")
            self.connections["DEFAULT"] = None
            return False

    def get_client(self) -> SnowflakeClient:
        """Get a validated Snowflake client"""
        if not self.available:
            raise HTTPException(
                status_code=503,
                detail="Business Defined Checks service not available - configuration missing"
            )

        if not self._validate_and_refresh_connection():
            raise HTTPException(
                status_code=503,
                detail="Failed to establish Snowflake connection"
            )

        client = self.connections.get("DEFAULT")
        if client is None:
            raise HTTPException(
                status_code=503,
                detail="Snowflake connection not available"
            )

        return client

    def close_all(self):
        """Close the Snowflake connection"""
        with self.connection_locks.get("DEFAULT", threading.Lock()):
            client = self.connections.get("DEFAULT")
            if client:
                try:
                    client.close()
                    logger.info("Closed BDC connection")
                except Exception as e:
                    logger.error(f"Error closing BDC connection: {e}")


# ============================================================================
# BUSINESS DEFINED CHECKS - Response Models
# ============================================================================

class KPIResponse(BaseModel):
    tables: int
    rules: int
    avg_pass: float


class RuleMetadata(BaseModel):
    rule_id: str
    rule_title: str
    rule_description: str
    severity: str
    target_table: str
    dataset_title: str = ""
    # None when the last run produced no result (it errored); never 0, which read as "everything failed"
    pass_percentage: Optional[float] = None
    status: str
    color_columns: str = ""


class DatasetHealth(BaseModel):
    dataset: str
    total_rules: int
    pass_rate: float
    status: str


class TrendData(BaseModel):
    date: str
    pass_percentage: float


class RuleRegistry(BaseModel):
    rule_id: str
    target_table: str
    sql_predicate: str


class FailedRowsResponse(BaseModel):
    columns: List[str]
    rows: List[List[Any]]
    count: int
    total_count: int
    page: int
    page_size: int
    total_pages: int


# Load config at startup
try:
    CONFIG = load_config()
    DENODO_SERVICE_USERNAME = CONFIG['denodo_service_account']['username']
    DENODO_SERVICE_PASSWORD = CONFIG['denodo_service_account']['password']
    DENODO_BASE_URL = CONFIG['denodo_service_account']['base_url']
    logger.info("✅ Data Validation configuration loaded")
except Exception as e:
    logger.warning(f"⚠️ Could not load Data Validation config: {e}")
    CONFIG = None
    DENODO_SERVICE_USERNAME = None
    DENODO_SERVICE_PASSWORD = None
    DENODO_BASE_URL = None

# Map AD groups -> roles for server-side authorization. Reads the optional
# "ad_groups" section of dq_config.json, falling back to AD_GROUP_* env vars.
configure_ad_groups(CONFIG.get("ad_groups") if CONFIG else None)
configure_api_keys(CONFIG.get("api_keys") if CONFIG else None)

# Fuzzy Match (Denodo search, metadata, Excel export)
import fuzzy_search
fuzzy_search.configure(CONFIG)
app.include_router(fuzzy_search.router)
fuzzy_search.warm_up()

# Initialize BDC components
try:
    bdc_config_manager = BDCConfigManager(CONFIG)
    bdc_connection_manager = BDCConnectionManager(bdc_config_manager)
    if bdc_connection_manager.available:
        logger.info("✅ Business Defined Checks initialized")
except Exception as e:
    logger.warning(f"⚠️ BDC initialization failed: {e}")
    bdc_config_manager = None
    bdc_connection_manager = None

# ── Admin routes (separate file — edit bdc_admin.py, not here) ─────────────
from bdc_admin import (admin_router, bdc_router, set_bdc_dependencies, record_start, record_end, record_detached,
                       require_bdc_rule, require_bdc_rule_download, rule_allowed, list_datasets,
                       review_mode_sql, ensure_no_conflicting_run, RUN_MODE_RE, WHOLE_RUN_MODES)

set_bdc_dependencies(bdc_config_manager, bdc_connection_manager)
for _r in (admin_router, bdc_router):
    app.include_router(_r, dependencies=[Depends(require_permission("viewBusinessChecks"))])
# ─────────────────────────────────────────────────────────────────────────────

# ── Audit log routes (separate file — edit audit.py, not here) ──────────────
from audit import audit_router, write_audit_event, count_known_users

app.include_router(
    audit_router,
    dependencies=[Depends(require_auth)],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Consolidated report routes (separate file — edit consolidated_report.py) ─
from consolidated_report import consolidated_router
from consolidated_report import set_bdc_dependencies as set_consolidated_deps, _rule_table_name

# ── Review routes ─────────────────────────────────────────────────────────────
from review import review_router, set_review_dependencies
from excel_utils import apply_excel_type_formatting, apply_gradient_fills
import diff_color_rules as _dcr

set_consolidated_deps(
    bdc_config_manager,
    bdc_connection_manager,
    # Read factory: opens a fresh dedicated connection per parallel read worker.
    # Uses the standard (read) key-pair credentials from the config.
    connection_factory=(
        lambda: get_bdc_snowflake_connection(
            bdc_config_manager.get_snowflake_config()
        )
    ) if bdc_config_manager else None,
    # Write factory: opens a fresh dedicated connection per write worker.
    # Uses the <ENV>_WRITE credentials (e.g. DEV_WRITE) from the config so
    # that all Snowflake write operations (DDL, INSERT, registry) are performed
    # under separate, write-specific credentials.
    write_connection_factory=(
        lambda: get_bdc_snowflake_connection(
            bdc_config_manager.get_write_snowflake_config()
        )
    ) if bdc_config_manager else None,
)
app.include_router(
    consolidated_router,
    dependencies=[Depends(require_permission("viewBusinessChecks"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Wire review router ────────────────────────────────────────────────────────
set_review_dependencies(
    config_manager=bdc_config_manager,
    connection_manager=bdc_connection_manager,
    write_connection_factory=(
        lambda: get_bdc_snowflake_connection(
            bdc_config_manager.get_write_snowflake_config()
        )
    ) if bdc_config_manager else None,
)
app.include_router(
    review_router,
    dependencies=[Depends(require_permission("viewBusinessChecks"))],
)

# ── Unstructured routes (separate file — edit unstructured.py, not here) ────
# ── "View SQL" permission (viewUnstructuredSQL) ─────────────────────────────
# Explorer responses carry the SQL that produced them ("sql", "count_sql") for
# the View SQL buttons. For callers without the permission, _sql_visibility
# (a dependency on the explorer routers) marks the request and this strips
# those fields, including from the newline-delimited JSON streams.
_SQL_KEYS = {"sql", "count_sql"}


def _strip_sql(obj):
    if isinstance(obj, dict):
        return {k: _strip_sql(v) for k, v in obj.items() if k not in _SQL_KEYS}
    if isinstance(obj, list):
        return [_strip_sql(v) for v in obj]
    return obj


class _HideSqlMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        state = scope.setdefault("state", {})  # shared with request.state downstream
        mode = None   # None = untouched, "json" = buffer whole body, "ndjson" = per line
        start = None
        buf = b""

        async def send_wrapper(message):
            nonlocal mode, start, buf
            if message["type"] == "http.response.start":
                ctype = dict((k.lower(), v) for k, v in message.get("headers", [])).get(b"content-type", b"")
                if state.get("hide_sql"):
                    if ctype.startswith(b"application/json"):
                        mode = "json"
                    elif ctype.startswith(b"application/x-ndjson"):
                        mode = "ndjson"
                if mode == "json":
                    start = message  # held until the body is rewritten (length changes)
                    return
                if mode == "ndjson":
                    message = {**message, "headers": [(k, v) for k, v in message["headers"] if k.lower() != b"content-length"]}
                return await send(message)
            if message["type"] != "http.response.body" or mode is None:
                return await send(message)
            more = message.get("more_body", False)
            buf += message.get("body", b"")
            if mode == "json":
                if more:
                    return
                try:
                    body = orjson.dumps(_strip_sql(orjson.loads(buf)))
                except Exception:
                    body = buf  # not valid JSON after all: send as it was
                headers = [(k, v) for k, v in start["headers"] if k.lower() != b"content-length"]
                headers.append((b"content-length", str(len(body)).encode()))
                await send({**start, "headers": headers})
                return await send({"type": "http.response.body", "body": body})
            # ndjson: rewrite each complete line, keep the partial tail for the next chunk
            *lines, buf = buf.split(b"\n") if more else (buf.split(b"\n") + [b""])
            out = []
            for line in lines:
                try:
                    out.append(orjson.dumps(_strip_sql(orjson.loads(line))) if line.strip() else line)
                except Exception:
                    out.append(line)
            await send({"type": "http.response.body", "body": b"\n".join(out) + (b"\n" if lines else b""), "more_body": more})

        await self.app(scope, receive, send_wrapper)


async def _sql_visibility(request: _Request, auth: dict = Depends(require_auth)):
    request.state.hide_sql = auth.get("permissions", {}).get("viewUnstructuredSQL") is not True


app.add_middleware(_HideSqlMiddleware)

from unstructured import unstructured_router, set_unstructured_dependencies

set_unstructured_dependencies(CONFIG.get("unstructured") if CONFIG else None)
app.include_router(
    unstructured_router,
    dependencies=[Depends(require_permission("viewUnstructured", "viewUnstructuredRimDocs")), Depends(_sql_visibility)],
)

# Virtual Regulator + IMMBOT tabs - same Snowflake connection as above (see chunk_explorer.py)
from virtual_regulator import virtual_regulator_router, set_virtual_regulator_dependencies
from immbot import immbot_router, set_immbot_dependencies

set_virtual_regulator_dependencies(CONFIG.get("unstructured") if CONFIG else None)
set_immbot_dependencies(CONFIG.get("unstructured") if CONFIG else None)
from vr_external import vr_external_router, set_vr_external_dependencies

set_vr_external_dependencies(CONFIG.get("unstructured") if CONFIG else None)
from cortellis import cortellis_router
for _router, _perms in ((virtual_regulator_router, ("viewUnstructuredVR", "viewUnstructuredVRInternal")),
                        (vr_external_router, ("viewUnstructuredVR", "viewUnstructuredVRExternal")),
                        (cortellis_router, ("viewUnstructuredVR", "viewUnstructuredVRCortellis")),
                        (immbot_router, ("viewUnstructuredIMMBOT",))):
    app.include_router(_router, dependencies=[Depends(require_permission("viewUnstructured", *_perms)), Depends(_sql_visibility)])
# ─────────────────────────────────────────────────────────────────────────────

# ── Structured Explorer (Find it) routes (separate file — edit gra_data_domains.py, not here) ──
from gra_data_domains import gra_data_domains_router, set_gra_data_domains_dependencies

set_gra_data_domains_dependencies(CONFIG.get("unstructured") if CONFIG else None)
app.include_router(
    gra_data_domains_router,
    dependencies=[Depends(require_permission("viewGraDataDomains"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── HAQ routes (separate file — edit haq.py, not here) ──────────────────────
from haq import haq_router, set_haq_dependencies

set_haq_dependencies(CONFIG.get("postgres_query_runner") if CONFIG else None)
app.include_router(
    haq_router,
    dependencies=[Depends(require_permission("viewUnstructured", "viewUnstructuredHAQ")), Depends(_sql_visibility)],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── EPOD routes (separate file — edit epod.py, not here) ────────────────────
# Reuses the 'postgres_query_runner' config section only (host/user/password) -
# no dedicated 'epod' config block, no PGQR_* env var fallback. epod.py
# overrides the database name to 'regulatory' internally.
from epod import epod_router, set_epod_dependencies

set_epod_dependencies(CONFIG.get("postgres_query_runner") if CONFIG else None)
app.include_router(
    epod_router,
    dependencies=[Depends(require_permission("viewUnstructured", "viewUnstructuredEPOD")), Depends(_sql_visibility)],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Nipo routes (separate file — edit nipo.py, not here) ────────────────────
from nipo import nipo_router, set_nipo_dependencies

set_nipo_dependencies(CONFIG.get("postgres_query_runner") if CONFIG else None)
app.include_router(
    nipo_router,
    dependencies=[Depends(require_permission("viewUnstructured", "viewUnstructuredNipo")), Depends(_sql_visibility)],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── FDA routes (separate file — edit fda.py, not here) ──────────────────────
from fda import fda_router, set_fda_dependencies

set_fda_dependencies(CONFIG.get("postgres_query_runner") if CONFIG else None)
app.include_router(
    fda_router,
    dependencies=[Depends(require_permission("viewUnstructured", "viewUnstructuredFDA")), Depends(_sql_visibility)],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Shared Postgres connection config (used by Data Studio's Postgres tab) ─
from postgres_query_runner import set_postgres_dependencies

set_postgres_dependencies(CONFIG.get("postgres_query_runner") if CONFIG else None)
# ─────────────────────────────────────────────────────────────────────────────

# ── Data Studio (Snowflake) routes (separate file — edit snowflake_query_runner.py) ─
from snowflake_query_runner import snowflake_router, set_snowflake_dependencies

set_snowflake_dependencies(
    CONFIG.get("snowflake_query_runner") if CONFIG else None,
    CONFIG.get("snowflake") if CONFIG else None,
)
app.include_router(
    snowflake_router,
    dependencies=[Depends(require_permission("viewDataStudio", "runSnowflakeQueryRunner"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Data Studio (Postgres) routes (separate file — edit postgres_studio.py) ─
# Uses the 'postgres_query_runner' config section wired in above.
from postgres_studio import pg_studio_router

app.include_router(
    pg_studio_router,
    dependencies=[Depends(require_permission("viewDataStudio", "runPostgresStudio"))],
)

# Shared worksheets for the two panes above (edit shared_worksheets.py).
# Per-engine access is checked inside, against the worksheet's own engine.
from shared_worksheets import shared_router
app.include_router(shared_router)
# ─────────────────────────────────────────────────────────────────────────────

# ── S3 Explorer routes (separate file — edit s3_explorer.py, not here) ────
from s3_explorer import s3_router, set_s3_dependencies

set_s3_dependencies(CONFIG.get("s3_explorer") if CONFIG else None)
app.include_router(
    s3_router,
    dependencies=[Depends(require_permission("viewDataStudio", "runS3Explorer"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── StreamSets Extractor routes (separate file — edit streamsets_extractor.py, not here) ──
from streamsets_extractor import streamsets_router, set_streamsets_dependencies

set_streamsets_dependencies(
    CONFIG.get("streamsets_extractor") if CONFIG else None,
    CONFIG.get("scripts") if CONFIG else None,
    CONFIG.get("it_validation") if CONFIG else None,
)
app.include_router(
    streamsets_router,
    dependencies=[Depends(require_permission("viewDataStudio", "runStreamsetsExtractor"))],
)
# ─────────────────────────────────────────────────────────────────────────────
# ── Pipeline Studio: validation routes (separate file — edit pipeline_validation.py) ──
from pipeline_validation import pipeline_validation_router, set_pipeline_validation_dependencies

_it_report = (CONFIG or {}).get("snowflake") or {}
set_pipeline_validation_dependencies(
    CONFIG.get("it_validation") if CONFIG else None,
    CONFIG.get("scripts") if CONFIG else None,
    report_connect=lambda: create_snowflake_connection(),   # defined further down, so looked up per request
    report_table=(f"{_it_report['database']}.{_it_report['schema']}.{_it_report['table_name']}"
                  if all(_it_report.get(k) for k in ("database", "schema", "table_name")) else None),
)
app.include_router(pipeline_validation_router)
# ─────────────────────────────────────────────────────────────────────────────
# ── Data Shuttle routes (separate file — edit data_shuttle.py, not here) ──
# Postgres <-> Snowflake table copies. Uses the Snowflake and Postgres logins wired in above.
from data_shuttle import shuttle_router, set_data_shuttle_dependencies

set_data_shuttle_dependencies(CONFIG.get("data_shuttle") if CONFIG else None)
app.include_router(
    shuttle_router,
    dependencies=[Depends(require_permission("viewDataStudio", "runDataShuttle"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Communication Center routes (separate file — edit communication_center.py) ──
from communication_center import communications_router, set_communication_dependencies

set_communication_dependencies(CONFIG.get("communications") if CONFIG else None)
app.include_router(
    communications_router,
    dependencies=[Depends(require_permission("sendCommunications"))],
)
# ────────────────────────────────────────────────────────────────────────────

from release_notes import release_notes_router

app.include_router(
    release_notes_router,
    dependencies=[Depends(require_permission("sendCommunications"))],
)
# ────────────────────────────────────────────────────────────────────────────

# ── Ingestion Lab routes (separate file — edit ingestion_lab.py, not here) ──
from ingestion_lab import ingestion_router, set_ingestion_lab_dependencies, shutdown as shutdown_ingestion

# Its own config: backend/ingestion_lab.yaml (or $INGESTION_LAB_CONFIG).
set_ingestion_lab_dependencies(legacy_section=CONFIG.get("ingestion_lab") if CONFIG else None)
app.include_router(ingestion_router, dependencies=[Depends(require_permission("viewIngestionLab"))])
# ─────────────────────────────────────────────────────────────────────────────

# ── Data Validation routes (separate file — edit data_validation.py, not here) ─────────
from data_validation import data_validation_router, set_data_validation_dependencies

set_data_validation_dependencies(CONFIG)
app.include_router(
    data_validation_router,
    dependencies=[Depends(require_permission("viewDataValidation"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── IND/CTA Data Quality routes (separate file — edit ind_cta_dq.py, not here) ───────
from ind_cta_dq import ind_cta_dq_router, set_ind_cta_dq_dependencies

try:
    set_ind_cta_dq_dependencies(CONFIG.get("ind_cta_dq") if CONFIG else None, bdc_connection_manager)
except ValueError as _e:
    logger.error(f"IND/CTA DQ config error: {_e}")
app.include_router(
    ind_cta_dq_router,
    dependencies=[Depends(require_permission("viewIndCtaQuality"))],
)
# ─────────────────────────────────────────────────────────────────────────────

# ── Safety DQ routes (reads safety_dq_data.xlsx, edit safety_dq.py, not here) ──
from safety_dq import safety_dq_router

app.include_router(safety_dq_router, dependencies=[Depends(require_permission("viewSafetyDQ"))])
# ─────────────────────────────────────────────────────────────────────────────

# ── Data API Export routes (separate file — edit data_api.py, not here) ────
from data_api import data_api_router

app.include_router(data_api_router)

# Native Enterprise Agentic RAG + evaluation (additive; legacy RAG tabs remain intact).
from rag import rag_router
from rag_evaluation import rag_evaluation_router
app.include_router(rag_router)
app.include_router(rag_evaluation_router)

# Optional MCP endpoint for AI agents; no-op unless DATA_API_MCP_ENABLED=1.
from data_api_mcp import install_data_api_mcp
install_data_api_mcp(app)

# ── Index Health (any Postgres table) ──
from indexer import index_health_router
app.include_router(index_health_router, dependencies=[Depends(require_permission("viewDataStudio"))])
# ─────────────────────────────────────────────────────────────────────────────

# ── Avatar assistant routes (separate module — edit assistant/router.py, not here) ─
from assistant.router import router as assistant_router

app.include_router(assistant_router)
# ─────────────────────────────────────────────────────────────────────────────


# Microsoft Graph API
GRAPH_API_ENDPOINT = "https://graph.microsoft.com/v1.0"

# CORS
def _cors_origins() -> list[str]:
    """Allowed browser origins. We pin these instead of using "*" because
    credentials are allowed and the two together are a security hole.
    Order: cors_origins in dq_config.json, then the CORS_ORIGINS env var
    (comma-separated). No fallback — if neither is set we fail at startup
    rather than quietly serving a wrong or over-permissive origin."""
    if CONFIG and CONFIG.get("cors_origins"):
        return CONFIG["cors_origins"]
    env = os.getenv("CORS_ORIGINS", "")
    if env.strip():
        return [o.strip() for o in env.split(",") if o.strip()]
    raise RuntimeError(
        "No CORS origins configured. Set 'cors_origins' in dq_config.json "
        "or the CORS_ORIGINS env var (comma-separated)."
    )


_allowed_origins = _cors_origins()
logger.info(f"CORS allowed origins: {_allowed_origins}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Records every authenticated API write as an audit event (audit.py).
from audit import AuditApiCallMiddleware
app.add_middleware(AuditApiCallMiddleware)

# Gzips finished JSON/text responses (added last, so it wraps everything above).
# Streams pass through untouched. Turn off with SMARTHUB_GZIP=false, e.g. if a
# proxy in front already compresses.
from compression import GZipJSONMiddleware
if (os.environ.get("SMARTHUB_GZIP") or "true").strip().lower() not in ("0", "false", "no", "off"):
    app.add_middleware(GZipJSONMiddleware, minimum_size=1024)


# ============================================================================
# SSO AUTHENTICATION
# ============================================================================

# Token validation, role resolution and the require_auth / require_permission
# dependencies now live in auth.py so that every router shares one
# implementation. See the import near the top of this file.


# ============================================================================
# SSO ENDPOINTS
# ============================================================================

@app.get("/health")
def health_check():
    """Health check for all services"""
    bdc_status = {}
    if bdc_connection_manager and bdc_connection_manager.available:
        try:
            client = bdc_connection_manager.get_client()
            bdc_status["connection"] = "connected" if client else "disconnected"
        except:
            bdc_status["connection"] = "disconnected"

    try:
        database = db.health()
    except Exception as e:
        database = {"ok": False, "error": type(e).__name__}

    return {
        "status": "healthy",
        "database": database,
        "timestamp": datetime.now(EASTERN).isoformat(),
        "service": "GRA-SmartHub Backend",
        "version": "0.1.0",
        "features": {
            "sso_auth": True,
            "denodo": DENODO_SERVICE_USERNAME is not None,
            "data_validation": CONFIG is not None,
            "business_defined_checks": bdc_connection_manager and bdc_connection_manager.available,
            "bdc_environments": bdc_status if bdc_status else "unavailable"
        }
    }


@app.get("/auth/user")
async def get_user_info(auth: dict = Depends(require_auth)):
    """Get authenticated user"""
    return auth["user"]


@app.get("/auth/user/photo")
async def get_user_profile_photo(auth: dict = Depends(require_auth)):
    """Get user profile photo"""
    try:
        token = auth["token"]
        logger.info(f"📸 Photo request: {auth['user']['username']}")

        headers = {'Authorization': f'Bearer {token}'}
        response = await asyncio.to_thread(
            requests.get,
            f"{GRAPH_API_ENDPOINT}/me/photo/$value",
            headers=headers,
            timeout=10
        )

        if response.status_code == 200:
            logger.info("✅ Photo fetched")
            return StreamingResponse(BytesIO(response.content), media_type="image/jpeg")
        elif response.status_code == 404:
            logger.info("ℹ️ No photo")
            raise HTTPException(status_code=404, detail="No photo")
        else:
            raise HTTPException(status_code=response.status_code, detail="Failed")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Photo error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch photo")


@app.get("/auth/user/details")
async def get_user_details(auth: dict = Depends(require_auth)):
    """Get detailed user info"""
    try:
        token = auth["token"]
        headers = {'Authorization': f'Bearer {token}'}
        response = await asyncio.to_thread(
            requests.get, f"{GRAPH_API_ENDPOINT}/me", headers=headers, timeout=10
        )

        if response.status_code == 200:
            details = response.json()
            return {
                "basic": auth["user"],
                "details": {
                    "displayName": details.get("displayName"),
                    "givenName": details.get("givenName"),
                    "surname": details.get("surname"),
                    "jobTitle": details.get("jobTitle"),
                    "department": details.get("department"),
                    "officeLocation": details.get("officeLocation"),
                    "mobilePhone": details.get("mobilePhone"),
                    "businessPhones": details.get("businessPhones", []),
                }
            }
        return {"basic": auth["user"], "details": None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# DENODO ENDPOINTS
# ============================================================================

@app.post("/validate")
def validate_credentials(username: str = Body(...), password: str = Body(...), auth: dict = Depends(require_permission("viewMetadata"))):
    """LEGACY: Validate Denodo credentials (kept for compatibility)"""
    base_url = "https://denodo-dev2.jnj.com:9443/denodo-data-catalog"
    endpoint = "/public/api/search/metadata?serverId=1"
    url = f"{base_url}{endpoint}"

    payload = {
        "text": "",
        "elementType": "Views",
        "withEndorsements": False,
        "withWarnings": False,
        "withDeprecations": False,
        "categoryIds": [],
        "tagIds": [],
        "databaseIds": [71],
        "searchType": "EXACT_MATCH",
        "offset": 0,
        "limit": 1
    }

    headers = {"Content-Type": "application/json", "Accept": "application/json"}

    try:
        resp = requests.post(
            url,
            auth=HTTPBasicAuth(username, password),
            headers=headers,
            data=json.dumps(payload),
            # Same setting as every other Denodo call: on unless the config says otherwise.
            verify=((CONFIG or {}).get("denodo_service_account", {}).get("verify_ssl", True)),
            timeout=10
        )

        if resp.status_code == 200:
            return {"valid": True, "message": "Valid", "username": username}
        elif resp.status_code == 401:
            return {"valid": False, "message": "Invalid credentials"}
        elif resp.status_code == 403:
            return {"valid": False, "message": "Access denied"}
        else:
            return {"valid": False, "message": f"Failed: {resp.status_code}"}
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Timeout")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Connection error")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# /search, /metadata and /download live in fuzzy_search.py


# ============================================================================
# DATA QUALITY ENDPOINTS
# ============================================================================

_private_key_cache: Dict[tuple, bytes] = {}
_private_key_lock = threading.Lock()


def get_private_key(path, password):
    """Load private key for Snowflake authentication.

    Decrypting the key is slow, so the result is kept per file. A changed file
    (new mtime or size, e.g. a rotated key) is read again.
    """
    st = os.stat(path)
    key = (os.path.abspath(path), st.st_mtime_ns, st.st_size)
    with _private_key_lock:
        cached = _private_key_cache.get(key)
    if cached is not None:
        return cached
    with open(path, "rb") as key_file:
        p_key = serialization.load_pem_private_key(
            key_file.read(),
            password=password.encode(),
            backend=default_backend()
        )
    der = p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    with _private_key_lock:
        # drop older versions of the same file
        for k in [k for k in _private_key_cache if k[0] == key[0]]:
            del _private_key_cache[k]
        _private_key_cache[key] = der
    return der


def create_snowflake_connection():
    """Create Snowflake connection using configuration"""
    if not CONFIG:
        raise HTTPException(status_code=500, detail="Config not loaded")

    sf_config = CONFIG['snowflake']

    try:
        # Load private key
        private_key = get_private_key(
            sf_config['private_key_path'],
            sf_config['private_key_password']
        )

        # Create connection
        conn = snowflake.connector.connect(
            user=sf_config['user'],
            account=sf_config['account'],
            private_key=private_key,
            role=sf_config['role'],
            warehouse=sf_config['warehouse'],
            database=sf_config['database'],
            schema=sf_config['schema']
        )
        return conn
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Private key file not found: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Snowflake connection error: {e}")


def _fast_json(payload) -> Response:
    """JSON response via orjson. For multi-MB payloads FastAPI's default encoder
    walks every value in Python and takes about a second; this takes milliseconds.
    Same JSON out (NaN becomes null, which the browser can parse; Python's 'NaN' it can't)."""
    return Response(content=orjson.dumps(payload, default=str), media_type="application/json")


# Logged-in connections reused by the IT Checks report endpoints.
from sf_pool import SnowflakePool
it_report_pool = SnowflakePool(create_snowflake_connection, max_idle_conns=6)


@app.get("/dq/validation_report_tables")
def get_validation_report_tables(auth: dict = Depends(require_permission("viewITChecks"))):
    if not CONFIG:
        raise HTTPException(status_code=500, detail="Config not loaded")
    try:
        sf_config = CONFIG['snowflake']
        return {"tables": [{
            "table_name": sf_config['table_name'],
            "database": sf_config['database'],
            "schema": sf_config['schema'],
            "account": sf_config['account']
        }]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/dq/validation_report_dates")
def get_validation_report_dates(auth: dict = Depends(require_permission("viewITChecks"))):
    """Return all available run dates, newest first."""
    if not CONFIG:
        raise HTTPException(status_code=500, detail="Config not loaded")

    sf_config = CONFIG['snowflake']
    table_name = sf_config['table_name']
    schema = sf_config['schema']
    database = sf_config['database']
    full_table_name = f"{database}.{schema}.{table_name}"

    try:
        with it_report_pool.connection() as conn, conn.cursor() as cur:
            cur.execute(f"""
                SELECT load_date, run_timestamp, database,
                       TRY_TO_NUMBER(report_data:overall_summary:total_tables_validated::STRING)
                FROM {full_table_name}
                ORDER BY load_date DESC
            """)
            rows = cur.fetchall()
        runs = [
            {
                "load_date": row[0].strftime('%Y-%m-%d %H:%M:%S.%f')[:23] if row[0] else None,
                "run_timestamp": row[1].strftime('%Y-%m-%d %H:%M:%S.%f')[:23] if row[1] else None,
                "database": row[2] or None,
                "tables": int(row[3]) if row[3] is not None else None,  # tables that run validated
            }
            for row in rows
        ]
        return _fast_json({"runs": runs, "total": len(runs)})
    except HTTPException:
        raise
    except snowflake.connector.errors.ProgrammingError as e:
        raise HTTPException(status_code=500, detail=f"Snowflake query error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/dq/validation_report")
def get_validation_report(
        load_date:  Optional[str] = Query(None, description="Single run to fetch. Omit (or pass 'ALL') to merge all runs."),
        load_dates: Optional[str] = Query(None, description="Comma-separated load_dates to merge a specific subset of runs."),
        auth: dict = Depends(require_permission("viewITChecks")),
):
    if not CONFIG:
        raise HTTPException(status_code=500, detail="Config not loaded")

    sf_config = CONFIG['snowflake']
    table_name = sf_config['table_name']
    schema = sf_config['schema']
    database = sf_config['database']
    full_table_name = f"{database}.{schema}.{table_name}"

    def _query(sql, params=None):
        # Holds a pooled connection only for the query itself, not the merge below.
        with it_report_pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    try:
        if load_date and load_date.upper() != 'ALL':
            date_list = [load_date.replace('T', ' ')[:23]]
        elif load_dates and load_dates.strip():
            date_list = sorted({d.strip().replace('T', ' ')[:23] for d in load_dates.split(',') if d.strip()})
            if not date_list:
                raise HTTPException(status_code=400, detail="load_dates is empty")
        else:
            date_list = []  # all runs

        # The report table only changes when a run is saved or trimmed, so a merged response is
        # kept until it does. Checking costs one tiny query instead of re-reading every report.
        fp = _query(f"SELECT COUNT(*), MAX(load_date), MIN(load_date) FROM {full_table_name}")[0]
        key = (full_table_name, tuple(date_list), tuple(str(v) for v in fp))
        with _REPORT_CACHE_LOCK:
            body = _REPORT_CACHE.get(key)
            if body is not None:
                _REPORT_CACHE.move_to_end(key)
        if body is not None:
            return Response(content=body, media_type="application/json")

        if date_list:
            where = ' OR '.join(["TO_CHAR(load_date, 'YYYY-MM-DD HH24:MI:SS.FF9') LIKE %s"] * len(date_list))
            rows = _query(f"""
                SELECT report_data, run_timestamp, load_date, database
                FROM {full_table_name}
                WHERE {where}
                ORDER BY load_date DESC
            """, [d + '%' for d in date_list])
        else:
            rows = _query(f"""
                SELECT report_data, run_timestamp, load_date, database
                FROM {full_table_name}
                ORDER BY load_date DESC
            """)
        if not rows:
            if len(date_list) == 1:
                raise HTTPException(status_code=404, detail=f"No report found for load_date={load_date}")
            raise HTTPException(status_code=404, detail="No reports found for the selected runs" if date_list
                                else "No reports found")
        if len(date_list) == 1:
            rows = rows[:1]

        body = orjson.dumps({
            "table_name": table_name,
            "database": database,
            "schema": schema,
            "report_data": _merge_reports(rows),
            "run_timestamp": _fmt_ts(rows[0][1]),
            "load_date": _fmt_ts(rows[0][2]),
            "runs_merged": len(rows),
            "newest_date": _fmt_ts(rows[0][2]),
            "oldest_date": _fmt_ts(rows[-1][2]),
        }, default=str)
        with _REPORT_CACHE_LOCK:
            _REPORT_CACHE[key] = body
            while len(_REPORT_CACHE) > _REPORT_CACHE_MAX:
                _REPORT_CACHE.popitem(last=False)
        return Response(content=body, media_type="application/json")
    except HTTPException:
        raise  # keep 404 "no reports" as a 404, not a 500
    except snowflake.connector.errors.ProgrammingError as e:
        raise HTTPException(status_code=500, detail=f"Snowflake query error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


from collections import OrderedDict as _OrderedDict
_REPORT_CACHE: "_OrderedDict[tuple, bytes]" = _OrderedDict()
_REPORT_CACHE_LOCK = threading.Lock()
_REPORT_CACHE_MAX = 8  # merged responses kept (all runs + a few picked combinations)


def _fmt_ts(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:23] if dt else None


def _load_report_json(raw):
    if not isinstance(raw, (str, bytes)):
        return raw or {}
    try:
        return orjson.loads(raw)  # several times faster on multi-MB reports
    except orjson.JSONDecodeError:
        return json.loads(raw)    # e.g. integers past 64 bits, which orjson refuses


def _merge_reports(rows) -> dict:
    """Merge report rows (newest first) into one report: the newest result per table wins.
    Every table is tagged with the database, schemas and source db it came from, because
    the same table name can exist in another database or schema."""
    pipelines: Dict[str, dict] = {}
    seen: Dict[str, set] = {}
    latest = None
    for raw, _run_ts, _load_date, source_db in rows:
        rd = _load_report_json(raw)
        if latest is None:
            latest = rd
        source_db = source_db or ''
        for pipeline in rd.get('pipeline_results') or []:
            pname = pipeline.get('pipeline_name', 'Unknown')
            vr = pipeline.get('validation_results') or {}
            if pname not in pipelines:
                meta = {k: v for k, v in vr.items() if k != 'table_validations'}
                meta['table_validations'] = []
                pipelines[pname] = {**{k: v for k, v in pipeline.items() if k != 'validation_results'},
                                    'validation_results': meta}
                seen[pname] = set()
            for table in vr.get('table_validations') or []:
                tkey = (source_db, pipeline.get('source_schema', ''), table.get('table_name', ''))
                if tkey in seen[pname]:
                    continue
                seen[pname].add(tkey)
                pipelines[pname]['validation_results']['table_validations'].append({
                    **table,
                    '_source_schema': pipeline.get('source_schema', ''),
                    '_source_type': pipeline.get('source_type', ''),
                    '_snowflake_database': pipeline.get('snowflake_database', ''),
                    '_snowflake_schema': pipeline.get('snowflake_schema', ''),
                    '_source_db': source_db,
                })
    return {**(latest or {}), 'pipeline_results': list(pipelines.values())}

# ============================================================================
# SINGLE TABLE VALIDATION (IT Checks "Re-validate")
# Grades one table exactly like DQ_IT_Validation/Src_to_Trgt_Validation_Script.py does in the
# scheduled run, so a re-validated row means the same thing as one from the batch report.
# ============================================================================

def parse_streamsets_replaceall(expression: str):
    """Parse StreamSets replaceAll expression and extract pattern-replacement pairs."""
    cleaned = expression.replace('\\"', '"').replace('\\\\', '\\')
    pattern = r',\s*"([^"]*)",\s*"([^"]*)"\)'
    matches = re.findall(pattern, cleaned)
    return matches


def transform_column_name(column_name: str, transformations=None):
    """Transform column name using dynamic transformation rules."""
    if transformations is None:
        transformations = [('[^a-zA-Z0-9]', '_'), ('_+', '_')]

    transformed = column_name
    for pattern, replacement in transformations:
        try:
            transformed = re.sub(pattern, replacement, transformed)
        except Exception as e:
            logger.warning(f"Regex error - pattern: {pattern}, error: {e}")
            continue
    return transformed


# Logged-in Oracle sessions, one small pool per (user, dsn). Bulk re-validate calls the
# endpoint once per table; a fresh Oracle login each time was most of the wait.
_ORACLE_POOLS: dict = {}
_ORACLE_POOLS_LOCK = threading.Lock()


def _oracle_pool(oracle_config: dict):
    key = (oracle_config['user'], oracle_config['dsn'])
    with _ORACLE_POOLS_LOCK:
        pool = _ORACLE_POOLS.get(key)
        if pool is None:
            pool = oracledb.create_pool(
                user=oracle_config['user'], password=oracle_config['password'], dsn=oracle_config['dsn'],
                min=0, max=int(oracle_config.get('pool_max', 6)), increment=1,
                getmode=oracledb.POOL_GETMODE_TIMEDWAIT, wait_timeout=30000,  # ms
                ping_interval=60,
            )
            _ORACLE_POOLS[key] = pool
    return pool


def create_oracle_connection(oracle_config: dict):
    """Oracle session from the pool for this DSN. Returns (pool, connection)."""
    try:
        pool = _oracle_pool(oracle_config)
        return pool, pool.acquire()
    except Exception as e:
        logger.error(f"Oracle connection error: {e}")
        raise HTTPException(status_code=500, detail=f"Oracle connection error: {e}")


def close_oracle_pools():
    with _ORACLE_POOLS_LOCK:
        pools = list(_ORACLE_POOLS.values())
        _ORACLE_POOLS.clear()
    for pool in pools:
        try:
            pool.close(force=True)
        except Exception as e:
            logger.warning(f"Oracle pool close: {e}")


def get_oracle_config(target_database: str = '') -> dict:
    """
    Resolve the right Oracle config for a given target database.

    Lookup order:
      1. CONFIG['oracle_connections'][target_database]  — exact match
      2. CONFIG['oracle_connections'] entry whose key is contained in target_database
         (handles cases where target_database is a full path like 'PRD.RAW.RIMDOCS')
      3. CONFIG['oracle']                               — single legacy config (fallback)

    Raises 503 if no matching config is found at all.
    """
    connections = CONFIG.get('oracle_connections', {})

    if connections:
        # 1. Exact match
        if target_database in connections:
            return connections[target_database]
        # 2. Partial match — key appears anywhere in target_database string
        td_upper = target_database.upper()
        for key, cfg in connections.items():
            if key.upper() in td_upper:
                return cfg

    # 3. Legacy single-connection fallback
    if 'oracle' in CONFIG:
        return CONFIG['oracle']

    raise HTTPException(
        status_code=503,
        detail=(
            f"No Oracle connection configured for database '{target_database}'. "
            "Add it to 'oracle_connections' in your config file."
        )
    )


@app.get("/dq/oracle_connections")
def get_oracle_connections(auth: dict = Depends(require_permission("viewITChecks"))):
    """
    Return the set of database identifiers that have an Oracle connection configured.
    The frontend uses this to disable the per-table refresh button for databases
    that cannot be re-validated.
    """
    if not CONFIG:
        return {"configured": [], "has_default": False}

    connections = CONFIG.get('oracle_connections', {})
    has_default = 'oracle' in CONFIG
    return {
        "configured": list(connections.keys()),
        "has_default": has_default,
    }


# Field-name transformation rules per pipeline, read from the StreamSets report. The file
# is only re-read when it changes (it can be several MB and bulk re-validate asks per table).
_TRANSFORM_CACHE = {'key': None, 'rules': {}}
_TRANSFORM_LOCK = threading.Lock()


def _report_pipeline_rules(pipeline: dict):
    """Same detection as the batch script (Field Mapper on FIELD_NAMES), then the older
    'parameters' form some reports carry."""
    stages = ((pipeline.get('pipeline_stages') or {}).get('stages') or {}).get('processors') or []
    for proc in stages:
        if 'FieldMapper' not in (proc.get('stageName') or ''):
            continue
        cfg = {c.get('name'): c.get('value') for c in proc.get('configuration') or [] if isinstance(c, dict)}
        expr = cfg.get('fieldMapperConfig.mappingExpression')
        if cfg.get('fieldMapperConfig.operateOn') == 'FIELD_NAMES' and expr:
            rules = parse_streamsets_replaceall(expr)
            if rules:
                return rules
    for param in pipeline.get('parameters') or []:
        value = param.get('parameter', '') if isinstance(param, dict) else ''
        if 'replaceAll' in value and 'f:name()' in value:
            rules = parse_streamsets_replaceall(value)
            if rules:
                return rules
    return None


def _pipeline_transformations(pipeline_name: str):
    path = ((CONFIG.get('validation') or {}).get('report_paths') or {}).get('path')
    if not path:
        return None
    try:
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
        with _TRANSFORM_LOCK:
            if _TRANSFORM_CACHE['key'] != key:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                pipelines = data if isinstance(data, list) else data.get('pipelines', [])
                _TRANSFORM_CACHE['rules'] = {p.get('pipeline_name'): _report_pipeline_rules(p)
                                             for p in pipelines if isinstance(p, dict)}
                _TRANSFORM_CACHE['key'] = key
            return _TRANSFORM_CACHE['rules'].get(pipeline_name)
    except Exception as e:
        logger.warning(f"Could not load transformations from report {path}: {e}")
        return None


_LOB_TYPES = ('CLOB', 'BLOB', 'NCLOB', 'BFILE', 'LONG', 'LONG RAW')


def _is_lob(col_type) -> bool:
    t = (col_type or '').upper()
    return any(lob in t for lob in _LOB_TYPES)


def _scan_query(cols, stat_cols, source, hint=''):
    """Row count, per-column distinct/null counts and total nulls in ONE pass over the table
    (same query the batch script runs). Result: [rows, D0, N0, D1, N1, ..., total_nulls]."""
    parts = ['COUNT(*)']
    for i, c in enumerate(stat_cols):
        parts.append(f'COUNT(DISTINCT "{c}") AS D{i}')
        parts.append(f'SUM(CASE WHEN "{c}" IS NULL THEN 1 ELSE 0 END) AS N{i}')
    nulls = ' + '.join(f'SUM(CASE WHEN "{c}" IS NULL THEN 1 ELSE 0 END)' for c in cols) or '0'
    parts.append(f'{nulls} AS TOTAL_NULLS')
    return f"SELECT {hint}{', '.join(parts)} FROM {source}"


def _dupes_query(cols, source, hint=''):
    col_list = ', '.join(f'"{c}"' for c in cols)
    return (f"SELECT {hint}COUNT(*) FROM (SELECT {col_list}, COUNT(*) AS cnt FROM {source} "
            f"GROUP BY {col_list} HAVING COUNT(*) > 1) duplicates")


def _oracle_parallel_hint(degree) -> str:
    """Oracle parallel query degree for the full scans (validation.oracle_parallel_degree,
    same setting as the batch script). 0 or 1 = no hint."""
    try:
        degree = int(degree or 0)
    except (TypeError, ValueError):
        logger.warning(f"validation.oracle_parallel_degree {degree!r} is not a number; using no PARALLEL hint")
        return ''
    if degree < 0 or degree > 64:
        logger.warning(f"validation.oracle_parallel_degree {degree} is outside 0-64; using no PARALLEL hint")
        return ''
    return f'/*+ PARALLEL({degree}) */ ' if degree >= 2 else ''


class _Deadline:
    """Time budget for one re-validation. Every query gets what is left, so nothing can
    hold a worker thread (or a database session) past it."""
    def __init__(self, seconds):
        self.seconds = f"{seconds:g}"  # for messages: 900, not 900.0
        self.end = time.monotonic() + seconds

    @property
    def passed(self):
        return time.monotonic() >= self.end

    def left(self):
        s = self.end - time.monotonic()
        if s <= 0:
            raise TimeoutError(f"Validation exceeded {self.seconds}s timeout")
        return s


def _ora_q(conn, dl, sql, params=None, all_rows=False):
    conn.call_timeout = max(1, int(dl.left() * 1000))  # ms; the session is dropped afterwards if it fires
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall() if all_rows else cur.fetchone()


_SF_TIMEOUT_KW: dict = {}


def _sf_takes_timeout(cur) -> bool:
    """snowflake-connector-python 3.x has execute(timeout=) and cancels the query on the server
    when it fires. 5.x accepts the argument but ignores it, so there the limit goes through
    ALTER SESSION (undone before the connection goes back to the pool)."""
    kind = type(cur)
    if kind not in _SF_TIMEOUT_KW:
        try:
            _SF_TIMEOUT_KW[kind] = 'timeout' in inspect.signature(cur.execute).parameters
        except (TypeError, ValueError):
            _SF_TIMEOUT_KW[kind] = False
    return _SF_TIMEOUT_KW[kind]


def _sf_q(conn, dl, sql, params=None, all_rows=False, names=False):
    cur = conn.cursor()
    try:
        seconds = max(1, int(dl.left()) + 1)
        if _sf_takes_timeout(cur):
            cur.execute(sql, params, timeout=seconds)  # server-side cancel when it runs out
        else:
            cur.execute(f'ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = {seconds}')
            cur.execute(sql, params)
        rows = cur.fetchall() if all_rows or names else cur.fetchone()
        if names:  # SHOW output: read columns by name, their order changes between releases
            cols = [d[0].lower() for d in cur.description]
            return [dict(zip(cols, r)) for r in rows]
        return rows
    finally:
        cur.close()


def _sf_reset_session_timeout(conn):
    """Undo the ALTER SESSION limit (5.x driver) before the pooled connection is reused."""
    cur = conn.cursor()
    try:
        if not _sf_takes_timeout(cur):
            cur.execute('ALTER SESSION UNSET STATEMENT_TIMEOUT_IN_SECONDS')
    except Exception as e:
        logger.warning(f"Snowflake session reset failed, dropping the connection: {e}")
        it_report_pool.discard(conn)
    finally:
        try:
            cur.close()
        except Exception:
            pass


def _both(a, b):
    """Run the Oracle side and the Snowflake side at the same time."""
    with ThreadPoolExecutor(max_workers=2) as ex:
        fa, fb = ex.submit(a), ex.submit(b)
        return fa.result(), fb.result()


def _oracle_constraints(conn, dl, owner, table, nn_columns):
    """Same queries as the batch script's OracleConnector.get_constraints."""
    out = {'primary_keys': [], 'unique_constraints': [], 'check_constraints': [],
           'not_null_columns': list(nn_columns), 'foreign_keys': []}
    try:
        out['primary_keys'] = [r[0] for r in _ora_q(conn, dl, """
            SELECT cols.column_name FROM all_constraints cons
            JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
            WHERE cons.constraint_type = 'P' AND cons.owner = :1 AND cons.table_name = :2
            ORDER BY cols.position""", [owner, table], all_rows=True)]
        uniques = {}
        for name, col in _ora_q(conn, dl, """
            SELECT cons.constraint_name, cols.column_name FROM all_constraints cons
            JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
            WHERE cons.constraint_type = 'U' AND cons.owner = :1 AND cons.table_name = :2
            ORDER BY cons.constraint_name, cols.position""", [owner, table], all_rows=True):
            uniques.setdefault(name, []).append(col)
        out['unique_constraints'] = [{'name': n, 'columns': c} for n, c in uniques.items()]
        for name, cond in _ora_q(conn, dl, r"""
            SELECT constraint_name, search_condition FROM all_constraints
            WHERE constraint_type = 'C' AND owner = :1 AND table_name = :2
              AND constraint_name NOT LIKE 'SYS\_%' ESCAPE '\'""", [owner, table], all_rows=True):
            cond = cond.read() if hasattr(cond, 'read') else cond
            if cond and 'IS NOT NULL' not in cond.upper():  # NOT NULL is compared on its own
                out['check_constraints'].append({'name': name, 'condition': cond})
        fks = {}
        for name, col, ref_table, ref_col in _ora_q(conn, dl, """
            SELECT cons.constraint_name, cols.column_name, ref_cons.table_name, ref_cols.column_name
            FROM all_constraints cons
            JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
            JOIN all_constraints ref_cons ON cons.r_constraint_name = ref_cons.constraint_name
                                         AND cons.r_owner = ref_cons.owner
            JOIN all_cons_columns ref_cols ON ref_cons.constraint_name = ref_cols.constraint_name
                                          AND ref_cons.owner = ref_cols.owner AND cols.position = ref_cols.position
            WHERE cons.constraint_type = 'R' AND cons.owner = :1 AND cons.table_name = :2
            ORDER BY cons.constraint_name, cols.position""", [owner, table], all_rows=True):
            fk = fks.setdefault(name, {'name': name, 'columns': [], 'referenced_table': ref_table,
                                       'referenced_columns': []})
            fk['columns'].append(col)
            fk['referenced_columns'].append(ref_col)
        out['foreign_keys'] = list(fks.values())
    except Exception as e:
        if dl.passed:  # out of time (the driver's own timeout error): not a constraint problem
            raise
        logger.warning(f"Oracle constraints for {owner}.{table}: {e}")  # batch script: logged, compared as empty
    return out


def _snowflake_constraints(conn, dl, fq_table, describe_rows):
    """Same sources as the batch script's SnowflakeConnector.get_constraints."""
    out = {'primary_keys': [], 'unique_constraints': [], 'check_constraints': [],
           'not_null_columns': [], 'foreign_keys': []}
    for row in describe_rows:
        name = row[0]
        if row[5] == 'Y':
            out['primary_keys'].append(name)
        if row[6] == 'Y':
            out['unique_constraints'].append({'name': f'UNIQUE_{name}', 'columns': [name]})
        if row[3] == 'N':
            out['not_null_columns'].append(name)
        if len(row) > 7 and row[7]:
            out['check_constraints'].append({'name': f'CHECK_{name}', 'condition': row[7]})
    try:
        keys = {}
        for r in sorted(_sf_q(conn, dl, f'SHOW UNIQUE KEYS IN TABLE {fq_table}', names=True),
                        key=lambda r: (r.get('constraint_name') or '', r.get('key_sequence') or 0)):
            keys.setdefault(r.get('constraint_name') or f"UNIQUE_{r.get('column_name')}", []).append(r.get('column_name'))
        out['unique_constraints'] = [{'name': n, 'columns': c} for n, c in keys.items()]
    except Exception:
        if dl.passed:
            raise
        # keep the per-column list from DESCRIBE
    try:
        fks = {}
        for r in sorted(_sf_q(conn, dl, f'SHOW IMPORTED KEYS IN TABLE {fq_table}', names=True),
                        key=lambda r: (r.get('fk_name') or '', r.get('key_sequence') or 0)):
            name = r.get('fk_name') or f"FK_{r.get('pk_table_name')}"
            fk = fks.setdefault(name, {'name': name, 'columns': [], 'referenced_table': r.get('pk_table_name'),
                                       'referenced_columns': []})
            fk['columns'].append(r.get('fk_column_name'))
            fk['referenced_columns'].append(r.get('pk_column_name'))
        out['foreign_keys'] = list(fks.values())
    except Exception:
        if dl.passed:
            raise
        # no access to SHOW IMPORTED KEYS: report none, as the batch script does
    return out


def _compare_constraints(oc, sc, tf, nn_details):
    """Statuses and warnings with the batch script's rules."""
    counts = {k: {'source': 0, 'snowflake': 0} for k in
              ('primary_keys', 'foreign_keys', 'unique_constraints', 'check_constraints', 'not_null_constraints')}
    vr = {
        'primary_keys': {'status': 'UNKNOWN', 'details': None},
        'unique_constraints': {'status': 'UNKNOWN', 'details': None},
        'check_constraints': {'status': 'UNKNOWN', 'details': None},
        'not_null_constraints': {'status': 'UNKNOWN', 'details': nn_details},
        'foreign_keys': {'status': 'UNKNOWN', 'details': None},
    }
    o_pk, s_pk = {tf(c) for c in oc['primary_keys']}, {c.upper() for c in sc['primary_keys']}
    if o_pk == s_pk:
        vr['primary_keys'] = {'status': 'MATCH', 'details': f"Primary keys match: {sorted(o_pk)}"}
    else:
        details = []
        if o_pk - s_pk:
            counts['primary_keys']['source'] = len(o_pk - s_pk)
            details.append(f"Primary keys only in Source: {sorted(o_pk - s_pk)}")
        if s_pk - o_pk:
            counts['primary_keys']['snowflake'] = len(s_pk - o_pk)
            details.append(f"Primary keys only in Snowflake: {sorted(s_pk - o_pk)}")
        vr['primary_keys'] = {'status': 'MISMATCH', 'details': '; '.join(details)}

    for key, label in (('unique_constraints', 'Unique constraint'), ('check_constraints', 'Check constraint')):
        o, s = len(oc[key]), len(sc[key])
        if o == s:
            vr[key] = {'status': 'MATCH', 'details': f"{label} count matches: {o}"}
        else:
            vr[key] = {'status': 'MISMATCH', 'details': f"{label} count mismatch: Source={o}, Snowflake={s}"}
            counts[key]['source' if o > s else 'snowflake'] = abs(o - s)

    o_nn, s_nn = {tf(c) for c in oc['not_null_columns']}, {c.upper() for c in sc['not_null_columns']}
    if o_nn - s_nn:
        counts['not_null_constraints']['source'] = len(o_nn - s_nn)
    if s_nn - o_nn:
        counts['not_null_constraints']['snowflake'] = len(s_nn - o_nn)
    if any(d.get('validation_status') == 'FAIL' for d in nn_details):
        vr['not_null_constraints']['status'] = 'VALIDATION_FAILED'
    elif o_nn != s_nn:
        vr['not_null_constraints']['status'] = 'DEFINITION_MISMATCH'
    elif not o_nn:
        vr['not_null_constraints']['status'] = 'NONE'
    else:
        vr['not_null_constraints']['status'] = 'MATCH'

    o, s = len(oc['foreign_keys']), len(sc['foreign_keys'])
    if o == s == 0:
        vr['foreign_keys'] = {'status': 'NONE', 'details': "No foreign keys in either system"}
    elif o == s:
        vr['foreign_keys'] = {'status': 'MATCH', 'details': f"Foreign key count matches: {o}"}
    else:
        vr['foreign_keys'] = {'status': 'MISMATCH', 'details': f"Foreign key count mismatch: Source={o}, Snowflake={s}"}
        counts['foreign_keys']['source' if o > s else 'snowflake'] = abs(o - s)

    warnings = {f"{k.replace('_', ' ').title()} mismatch": f"Source={c['source']}, Snowflake={c['snowflake']}"
                for k, c in counts.items() if c['source'] or c['snowflake']}
    return {
        'constraint_analysis_performed': True,
        'constraint_warnings': warnings,
        'constraint_details': {'source': oc, 'snowflake': sc},
        'validation_results': vr,
        'summary': {k: v['status'] for k, v in vr.items()},
    }


def validate_single_table_logic(oracle_conn, snowflake_conn, table_config: dict, transformations: list,
                                timeout: float = 900):
    """
    One table, same checks and grading as the batch script: row count, column statistics,
    total nulls, duplicates and constraints. Oracle and Snowflake run side by side, and the
    count, statistics and null total come from a single scan per side.
    """
    started = time.monotonic()
    dl = _Deadline(timeout)
    table_name = table_config['table_name']
    source_schema = table_config['source_schema']
    target_database = table_config['target_database']
    target_schema = table_config['target_schema']
    snowflake_table = table_config['snowflake_table']
    ora_fq = f'"{source_schema}"."{table_name}"'
    sf_fq = f'"{target_database}"."{target_schema}"."{snowflake_table}"'
    vcfg = (CONFIG or {}).get('validation') or {}
    excluded = {c.upper() for c in (vcfg.get('excluded_columns') or [])}
    hint = _oracle_parallel_hint(vcfg.get('oracle_parallel_degree', 8))

    def tf(name):
        return (transform_column_name(name, transformations) if transformations else name).upper()

    result = {
        'table_name': table_name,
        'source_schema': source_schema,
        'target_database': target_database,
        'target_schema': target_schema,
        'snowflake_table': snowflake_table,
        'pipeline_name': table_config.get('pipeline_name', ''),
        'source_type': 'Oracle',  # re-validate only connects to Oracle
        'status': 'PASSED',
        'Snowflake_Last_Updated': None,
        'Last_Checked': datetime.now(EASTERN).isoformat(),
    }

    def fail(status, msg):
        # Same shape as the batch script's ERROR / TIMEOUT / NOT FOUND rows: no measured
        # sections, so the page shows "not measured" instead of empty numbers.
        for k in ('row_counts', 'column_analysis', 'data_quality', 'column_statistics', 'constraint_analysis'):
            result.pop(k, None)
        result.update(status=status, error=msg, validation_issues=[msg],
                      validation_time=round(time.monotonic() - started, 2),
                      Last_Checked=datetime.now(EASTERN).isoformat())
        return result

    try:
        # ── columns (Oracle) | existence + DESCRIBE (Snowflake) ──
        def ora_meta():
            return _ora_q(oracle_conn, dl,
                          "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM ALL_TAB_COLUMNS "
                          "WHERE OWNER = :1 AND TABLE_NAME = :2 ORDER BY COLUMN_ID",
                          [source_schema, table_name], all_rows=True)

        def sf_meta():
            found = _sf_q(snowflake_conn, dl,
                          f'SELECT LAST_ALTERED FROM "{target_database}".INFORMATION_SCHEMA.TABLES '
                          f'WHERE UPPER(TABLE_SCHEMA) = UPPER(%s) AND UPPER(TABLE_NAME) = UPPER(%s)',
                          (target_schema, snowflake_table))
            if not found:
                return None, None
            return found, _sf_q(snowflake_conn, dl, f'DESCRIBE TABLE {sf_fq}', all_rows=True)

        ora_rows, (sf_found, describe) = _both(ora_meta, sf_meta)
        if not sf_found:
            return fail('TABLE_NOT_FOUND', f"Table '{snowflake_table}' does not exist in Snowflake")
        if sf_found[0]:
            result['Snowflake_Last_Updated'] = sf_found[0].isoformat()

        oracle_nn = [r[0] for r in ora_rows if r[2] == 'N']
        oracle_columns = [{'name': r[0], 'type': r[1]} for r in ora_rows if r[0].upper() not in excluded]
        snowflake_columns = [{'name': r[0], 'type': r[1]} for r in describe if r[0].upper() not in excluded]
        if not oracle_columns or not snowflake_columns:
            return fail('ERROR', 'Unable to retrieve columns from source or target')

        oracle_names = {tf(c['name']) for c in oracle_columns}
        sf_by_name = {}
        for c in snowflake_columns:
            sf_by_name.setdefault(c['name'].upper(), c)
        common = oracle_names & set(sf_by_name)
        oracle_only = oracle_names - set(sf_by_name)
        snowflake_only = set(sf_by_name) - oracle_names

        oracle_common_cols, sf_common_cols, matched, seen = [], [], [], set()
        for col in oracle_columns:
            name = tf(col['name'])
            if name in common:
                oracle_common_cols.append(col)
                sf_common_cols.append(sf_by_name[name])
                if name not in seen:
                    seen.add(name)
                    matched.append({'oracle_col': col, 'sf_col': sf_by_name[name], 'matched_name': name})
        stat_matches = [m for m in matched if not _is_lob(m['oracle_col']['type'])]

        result['column_analysis'] = {
            'source_columns': len(oracle_columns),
            'snowflake_columns': len(snowflake_columns),
            'common_columns': len(common),
            'source_only_columns': sorted(oracle_only),
            'snowflake_only_columns': sorted(snowflake_only),
            'excluded_columns': sorted(excluded),
        }

        # ── one scan per side: row count + column statistics + total nulls ──
        o_row, s_row = _both(
            lambda: _ora_q(oracle_conn, dl, _scan_query([c['name'] for c in oracle_common_cols],
                                                        [m['oracle_col']['name'] for m in stat_matches],
                                                        ora_fq, hint)),
            lambda: _sf_q(snowflake_conn, dl, _scan_query([c['name'] for c in sf_common_cols],
                                                          [m['sf_col']['name'] for m in stat_matches], sf_fq)))
        oracle_count, sf_count = o_row[0], s_row[0]
        oracle_nulls = o_row[-1] if o_row[-1] is not None else 0
        sf_nulls = s_row[-1] if s_row[-1] is not None else 0
        column_statistics = []
        for i, m in enumerate(stat_matches):
            od, on, sd, sn = (v if v is not None else 0 for v in
                              (o_row[1 + 2 * i], o_row[2 + 2 * i], s_row[1 + 2 * i], s_row[2 + 2 * i]))
            stat = {
                'column_name': m['matched_name'],
                'source_type': m['oracle_col']['type'],
                'snowflake_type': m['sf_col']['type'],
                'source_stats': {'distinct_count': od, 'null_count': on},
                'snowflake_stats': {'distinct_count': sd, 'null_count': sn},
                'stats_match': {'distinct_count': od == sd, 'null_count': on == sn},
            }
            if transformations:
                stat['source_original_name'] = m['oracle_col']['name']
                stat['snowflake_name'] = m['sf_col']['name']
            column_statistics.append(stat)

        # ── duplicates, then constraints (Oracle metadata | Snowflake keys + NOT NULL scan) ──
        o_dupe_cols = [c['name'] for c in oracle_common_cols if not _is_lob(c['type'])]
        s_dupe_cols = [c['name'] for c in sf_common_cols if not _is_lob(c['type'])]
        oracle_dupes, sf_dupes = _both(
            lambda: (_ora_q(oracle_conn, dl, _dupes_query(o_dupe_cols, ora_fq, hint))[0] or 0)
            if o_dupe_cols else 0,
            lambda: (_sf_q(snowflake_conn, dl, _dupes_query(s_dupe_cols, sf_fq))[0] or 0) if s_dupe_cols else 0)

        try:
            sf_name = {c['name'].upper(): c['name'] for c in snowflake_columns}
            nn_check = [sf_name[c] for c in dict.fromkeys(tf(c) for c in oracle_nn) if c in sf_name]

            def sf_side():
                sc = _snowflake_constraints(snowflake_conn, dl, sf_fq, describe)
                s_nn = {c.upper() for c in sc['not_null_columns']}
                details = []
                if nn_check:
                    parts = ', '.join(f'COUNT(*) - COUNT("{c}")' for c in nn_check)
                    total_rows, *null_counts = _sf_q(snowflake_conn, dl, f'SELECT COUNT(*), {parts} FROM {sf_fq}')
                    details = [{'column': c, 'exists_in_source': True, 'exists_in_snowflake': c.upper() in s_nn,
                                'snowflake_total_rows': total_rows, 'snowflake_null_count': n,
                                'validation_status': 'PASS' if n == 0 else 'FAIL'}
                               for c, n in zip(nn_check, null_counts)]
                return sc, details

            oc, (sc, nn_details) = _both(
                lambda: _oracle_constraints(oracle_conn, dl, source_schema, table_name, oracle_nn), sf_side)
            constraint_analysis = _compare_constraints(oc, sc, tf, nn_details)
        except Exception as e:
            if isinstance(e, TimeoutError) or dl.passed:
                raise
            logger.error(f"Constraint analysis error for {table_name}: {e}")
            constraint_analysis = {
                'constraint_analysis_performed': True,
                'constraint_warnings': {'error': f"Error during constraint analysis: {e}"},
                'constraint_details': {'source': {}, 'snowflake': {}},
                'validation_results': {},
                'summary': {},
            }

        # ── grade (batch script order) ──
        issues = []
        if oracle_count != sf_count:
            issues.append(f"Row count mismatch: Source={oracle_count}, Snowflake={sf_count}")
        if oracle_only:
            issues.append(f"Columns only in Source: {', '.join(sorted(oracle_only))}")
        if snowflake_only:
            issues.append(f"Columns only in Snowflake: {', '.join(sorted(snowflake_only))}")
        if oracle_nulls != sf_nulls:
            issues.append(f"Null count mismatch: Source={oracle_nulls}, Snowflake={sf_nulls}")
        if oracle_dupes != sf_dupes:
            issues.append(f"Duplicate count mismatch: Source={oracle_dupes}, Snowflake={sf_dupes}")
        for c in column_statistics:
            if not c['stats_match']['distinct_count']:
                issues.append(f"Column {c['column_name']}: distinct count mismatch "
                              f"(Source={c['source_stats']['distinct_count']}, "
                              f"Snowflake={c['snowflake_stats']['distinct_count']})")

        result.update(
            # same grading as the batch script: CRITICAL only when the row counts differ
            status='CRITICAL' if oracle_count != sf_count else 'WARNING' if issues else 'PASSED',
            row_counts={'source': oracle_count, 'snowflake': sf_count, 'match': oracle_count == sf_count},
            data_quality={'source_nulls': oracle_nulls, 'snowflake_nulls': sf_nulls,
                          'null_match': oracle_nulls == sf_nulls, 'source_duplicates': oracle_dupes,
                          'snowflake_duplicates': sf_dupes, 'duplicate_match': oracle_dupes == sf_dupes},
            column_statistics=column_statistics,
            constraint_analysis=constraint_analysis,
            validation_issues=issues,
            validation_time=round(time.monotonic() - started, 2),
            Last_Checked=datetime.now(EASTERN).isoformat(),
        )
        return result

    except Exception as e:
        if isinstance(e, TimeoutError) or dl.passed:
            logger.warning(f"Re-validation of {table_name} timed out after {dl.seconds}s")
            return fail('TIMEOUT', f"Validation exceeded {dl.seconds}s timeout")
        logger.error(f"Error validating table {table_name}: {e}")
        return fail('ERROR', f"Validation error: {e}")


@app.post("/dq/validate_single_table")
def validate_single_table(  # sync on purpose: FastAPI runs it in a worker thread, so blocking DB calls don't freeze the server
        pipeline_name:   str = Body(...),
        table_name:      str = Body(...),
        source_schema:   str = Body(...),
        target_database: str = Body(...),
        target_schema:   str = Body(...),
        snowflake_table: str = Body(...),
        source_db:       str = Body(default=''),
        auth: dict = Depends(require_permission("runITChecks")),
):
    """Validate a single table and return results without saving to Snowflake."""
    if not CONFIG:
        raise HTTPException(status_code=500, detail="Config not loaded")

    # These five values are inlined into Oracle/Snowflake queries as schema,
    # database and table identifiers throughout this endpoint, so they can't be
    # bound as parameters. Validate them here — before any query runs — and
    # reject anything that isn't a plain identifier. Oracle/Snowflake allow
    # '$' and '#' in object names, so those are permitted alongside the usual
    # letters, digits and underscore. Anything with a quote, space, dot or
    # semicolon is refused rather than escaped.
    _identifiers = {
        "table_name": table_name,
        "source_schema": source_schema,
        "target_database": target_database,
        "target_schema": target_schema,
        "snowflake_table": snowflake_table,
    }
    for _field, _value in _identifiers.items():
        if not _is_sql_object_name(_value):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid {_field}: must be a plain table/schema identifier",
            )

    # Route to the correct Oracle connection using the DATABASE column value
    # from DQ_IT_VALIDATION_REPORT (source_db), falling back to target_database.
    db_key = source_db or target_database
    oracle_config = get_oracle_config(db_key)
    transformations = _pipeline_transformations(pipeline_name)
    vcfg = CONFIG.get('validation', {}) or {}
    # Whole-table budget. Each query gets what's left and is cancelled on the server when it runs out.
    timeout = float(vcfg.get('revalidate_timeout') or 900)
    table_config = {
        'table_name': table_name,
        'source_schema': source_schema,
        'target_database': target_database,
        'target_schema': target_schema,
        'snowflake_table': snowflake_table,
        'pipeline_name': pipeline_name,
    }

    logger.info(f"Re-validating {source_schema}.{table_name} (source_db={db_key}, dsn={oracle_config.get('dsn')}, "
                f"transformations={'yes' if transformations else 'no'})")
    pool, oracle_conn = create_oracle_connection(oracle_config)
    result = None
    try:
        with it_report_pool.connection() as snowflake_conn:
            try:
                result = validate_single_table_logic(oracle_conn, snowflake_conn, table_config, transformations, timeout)
            finally:
                # A timed-out or failed query can leave the session unusable: don't reuse it.
                if not isinstance(result, dict) or result.get('status') in ('TIMEOUT', 'ERROR'):
                    it_report_pool.discard(snowflake_conn)
                else:
                    _sf_reset_session_timeout(snowflake_conn)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in validate_single_table: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        broken = not isinstance(result, dict) or result.get('status') in ('TIMEOUT', 'ERROR')
        try:
            if broken:
                pool.drop(oracle_conn)
            else:
                oracle_conn.call_timeout = 0
                pool.release(oracle_conn)
        except Exception as e:
            logger.warning(f"Oracle session cleanup: {e}")

    logger.info(f"Validation complete for {table_name}: {result['status']} in {result.get('validation_time')}s")
    return {
        'success': True,
        'validation_result': result
    }


# ============================================================================
# BUSINESS DEFINED CHECKS - API ENDPOINTS
# ============================================================================

@app.get("/api/overview/kpi", response_model=KPIResponse)
def get_bdc_kpi(
    delta_mode: bool = Query(False, description="When True, query the _DELTA views"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Get KPI overview for Business Defined Checks"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    latest_key = dq_config['rule_latest_view']
    if delta_mode:
        latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
    rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)

    # Delta-mode reviews are stored in DQ_REVIEW_REGISTRY keyed by a "DELTA_"
    # prefix on RULE_ID (see review.py). Match the join to the current mode
    # so a rule accepted in one mode doesn't count as approved in the other.
    review_filter  = review_mode_sql(delta_mode)
    review_id_expr = "'DELTA_' || v.RULE_ID" if delta_mode else "v.RULE_ID"

    ds_where = dataset_sql(auth, "v.DATASET_TITLE")
    result = sf.execute(f"""
        WITH latest_reviews AS (
            SELECT RULE_ID, STATUS
            FROM {bdc_config_manager.core_table('DQ_REVIEW_REGISTRY')}
            WHERE {review_filter}
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY RULE_ID ORDER BY REVIEWED_AT DESC) = 1
        )
        SELECT
            COUNT(DISTINCT v.TARGET_TABLE)   AS TABLES,
            COUNT(DISTINCT v.RULE_ID)        AS RULES,
            ROUND(AVG(v.PASS_PERCENTAGE), 2) AS AVG_PASS
        FROM {rule_latest_view} v
        INNER JOIN latest_reviews lr
            ON lr.RULE_ID = {review_id_expr} AND lr.STATUS = 'ACCEPTED'
        WHERE 1 = 1{ds_where}
    """)

    if not result.rows:
        raise HTTPException(status_code=404, detail="No data found")

    row = result.rows[0]
    return {
        "tables": int(row[0] or 0),
        "rules": int(row[1] or 0),
        "avg_pass": float(row[2] or 0)
    }


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _is_safe_identifier(name: str | None) -> bool:
    """True when name is a plain SQL identifier we can safely inline unquoted."""
    return bool(name) and bool(_IDENT_RE.match(name))


# Table/schema/database names get inlined as quoted identifiers (Oracle and
# Snowflake), so they may contain '$' and '#' in addition to the usual set —
# but never a quote, dot, space or semicolon that could break out of the
# identifier. Kept separate from _IDENT_RE, which is deliberately stricter for
# the unquoted-inline color-filter case.
_OBJECT_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#]*$")


def _is_sql_object_name(name: str | None) -> bool:
    """True when name is a plain table/schema/database identifier."""
    return bool(name) and bool(_OBJECT_NAME_RE.match(name))


def _parse_color_columns(color_columns_str: str | None) -> tuple[str | None, str | None]:
    """Parse a comma-separated COLOR_COLUMNS string (e.g. 'ACTUAL_SUBMISSION_DATE, EVENT_CREATED_DATE')
    into a (col1, col2) tuple.  Returns (None, None) when absent or malformed."""
    if not color_columns_str:
        return (None, None)
    parts = [p.strip().upper() for p in color_columns_str.split(",") if p.strip()]
    col1 = parts[0] if len(parts) > 0 else None
    col2 = parts[1] if len(parts) > 1 else None
    return (col1, col2)


@app.get("/api/rules", response_model=List[RuleMetadata])
def get_bdc_rules(
    delta_mode: bool = Query(False, description="When True, query the _DELTA views"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Get all rules for Business Defined Checks"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    latest_key = dq_config['rule_latest_view']
    if delta_mode:
        latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
    rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)
    rule_input_table = bdc_config_manager.get_full_table_name(dq_config['rule_input_table'])

    # Delta-mode reviews are stored in DQ_REVIEW_REGISTRY keyed by a "DELTA_"
    # prefix on RULE_ID (see review.py), so quarterly and delta sign-off are
    # independent even though they share one table. Match the join to the
    # current mode so a rule accepted in one mode doesn't leak into the other.
    review_filter  = review_mode_sql(delta_mode)
    review_id_expr = "'DELTA_' || v.RULE_ID" if delta_mode else "v.RULE_ID"

    ds_where = dataset_sql(auth, "v.DATASET_TITLE")

    # Only return rules whose LATEST review is ACCEPTED.
    # Uses ROW_NUMBER() / QUALIFY to isolate the most recent review per rule so
    # that a subsequent rejection correctly hides a previously-approved rule.
    # If the registry table doesn't exist yet (first startup), fall back to all rules.
    try:
        result = sf.execute(f"""
            WITH latest_reviews AS (
                SELECT RULE_ID, STATUS
                FROM {bdc_config_manager.core_table('DQ_REVIEW_REGISTRY')}
                WHERE {review_filter}
                                QUALIFY ROW_NUMBER() OVER (PARTITION BY RULE_ID ORDER BY REVIEWED_AT DESC) = 1
            )
            SELECT
                v.RULE_ID,
                v.RULE_TITLE,
                v.RULE_DESCRIPTION,
                v.SEVERITY,
                v.TARGET_TABLE,
                v.DATASET_TITLE,
                v.PASS_PERCENTAGE,
                v.STATUS,
                i.COLOR_COLUMNS
            FROM {rule_latest_view} v
            LEFT JOIN {rule_input_table} i
                ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
            INNER JOIN latest_reviews lr
                ON lr.RULE_ID = {review_id_expr} AND lr.STATUS = 'ACCEPTED'
            WHERE 1 = 1{ds_where}
            ORDER BY v.RULE_ID
        """)
    except Exception as _e:
        logger.warning(f"/api/rules review filter failed ({_e}); returning unfiltered")
        result = sf.execute(f"""
            SELECT v.RULE_ID, v.RULE_TITLE, v.RULE_DESCRIPTION, v.SEVERITY,
                   v.TARGET_TABLE, v.DATASET_TITLE, v.PASS_PERCENTAGE, v.STATUS, i.COLOR_COLUMNS
            FROM {rule_latest_view} v
            LEFT JOIN {rule_input_table} i ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
            WHERE 1 = 1{ds_where}
            ORDER BY v.RULE_ID
        """)

    return [
        {
            "rule_id": row[0],
            "rule_title": row[1] or "",
            "rule_description": row[2] or "",
            "severity": row[3] or "",
            "target_table": row[4] or "",
            "dataset_title": row[5] or "",
            "pass_percentage": float(row[6]) if row[6] is not None else None,
            "status": row[7] or "",
            "color_columns": row[8] or "",
        }
        for row in result.rows
    ]


@app.get("/api/dataset-health", response_model=List[DatasetHealth])
def get_bdc_dataset_health(
    delta_mode: bool = Query(False, description="When True, query the _DELTA health view"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Get dataset health for Business Defined Checks"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    health_key = dq_config['rule_health_view']
    if delta_mode:
        health_key = health_key + '_DELTA' if not health_key.endswith('_DELTA') else health_key
    rule_health_view = bdc_config_manager.get_full_table_name(health_key)

    # Delta-mode reviews are stored in DQ_REVIEW_REGISTRY keyed by a "DELTA_"
    # prefix on RULE_ID (see review.py). Match the join to the current mode
    # so a rule accepted in one mode doesn't count as approved in the other.
    review_filter  = review_mode_sql(delta_mode)
    review_id_expr = "'DELTA_' || v.RULE_ID" if delta_mode else "v.RULE_ID"

    ds_where = dataset_sql(auth, "v.DATASET_TITLE")
    result = sf.execute(f"""
        WITH latest_reviews AS (
            SELECT RULE_ID, STATUS
            FROM {bdc_config_manager.core_table('DQ_REVIEW_REGISTRY')}
            WHERE {review_filter}
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY RULE_ID ORDER BY REVIEWED_AT DESC) = 1
        )
        SELECT
            DATASET_TITLE,
            COUNT(DISTINCT v.RULE_ID) AS RULE_COUNT,
            ROUND(AVG(v.PASS_PERCENTAGE), 2) AS PASS_RATE,
            CASE
                WHEN AVG(v.PASS_PERCENTAGE) >= 95 THEN 'HEALTHY'
                WHEN AVG(v.PASS_PERCENTAGE) >= 80 THEN 'WARNING'
                ELSE 'CRITICAL'
            END AS STATUS
        FROM {rule_health_view} v
        INNER JOIN latest_reviews lr
            ON lr.RULE_ID = {review_id_expr} AND lr.STATUS = 'ACCEPTED'
        WHERE v.DATASET_TITLE IS NOT NULL{ds_where}
        GROUP BY v.DATASET_TITLE
        ORDER BY PASS_RATE ASC
    """)

    return [
        {
            "dataset": row[0],
            "total_rules": int(row[1]),
            "pass_rate": float(row[2]) if row[2] is not None else 0.0,
            "status": row[3]
        }
        for row in result.rows
    ]


@app.get("/api/trends/{rule_id}", response_model=List[TrendData])
def get_bdc_rule_trends(
        rule_id: str,
        delta_mode: bool = Query(False, description="When True, query the _DELTA trends table"),
        auth: dict = Depends(require_bdc_rule),
):
    """Get trend data for a specific rule in Business Defined Checks"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()

    # In delta mode, append _DELTA to the configured trends view name
    trends_view_key = dq_config['rule_trends_view']
    if delta_mode:
        trends_view_key = trends_view_key + '_DELTA' if not trends_view_key.endswith('_DELTA') else trends_view_key
    rule_trends_view = bdc_config_manager.get_full_table_name(trends_view_key)

    result = sf.execute(f"""
        SELECT
            TO_CHAR(RUN_DATE, 'YYYY-MM-DD') AS DATE,
            AVG_PASS_PERCENTAGE AS PASS
        FROM {rule_trends_view}
        WHERE RULE_ID = %(rule_id)s
        ORDER BY RUN_DATE
    """, {"rule_id": rule_id})

    # A run that recorded no pass rate is a gap, not a 500 for the whole chart.
    return [
        {
            "date": str(row[0]),
            "pass_percentage": float(row[1])
        }
        for row in result.rows if row[1] is not None
    ]


@app.get("/api/rules/{rule_id}/registry", response_model=RuleRegistry)
def get_bdc_rule_registry(
        rule_id: str,
        auth: dict = Depends(require_bdc_rule),
):
    """Get rule registry details for Business Defined Checks"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    rule_registry_table = bdc_config_manager.get_full_table_name(dq_config['rule_registry_table'])

    result = sf.execute(f"""
        SELECT
            RULE_ID,
            TARGET_TABLE,
            SQL_PREDICATE
        FROM {rule_registry_table}
        WHERE RULE_ID = %(rule_id)s
          AND IS_VALIDATED = TRUE
    """, {"rule_id": rule_id})

    # A validated row with no predicate is the same as none yet (the page says
    # so); before, the NULL failed the response model and came back as a 500.
    if not result.rows or result.rows[0][2] is None:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    row = result.rows[0]
    return {
        "rule_id": row[0],
        "target_table": row[1] or "",
        "sql_predicate": row[2]
    }


@app.post("/api/rules/{rule_id}/failed-rows", response_model=FailedRowsResponse)
def get_bdc_failed_rows(
        rule_id: str,
        page: int = Query(1, ge=1),
        page_size: int = Query(100, ge=1, le=1000),
        color_filter: str = Query("ALL", description="Color filter: ALL, green, yellow, red"),
        delta_mode: bool = Query(False, description="When True, read from the _DELTA failed-rows table"),
        sort_col: Optional[str] = Query(None, description="Column to sort the whole result by"),
        sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
        auth: dict = Depends(require_bdc_rule),
):
    """Get paginated failed rows from the pre-computed DQ_CORE failed rows table"""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    sf_config = bdc_config_manager.get_snowflake_config()
    database = sf_config.get("database")
    latest_key = dq_config['rule_latest_view']
    if delta_mode:
        latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
    rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)

    rule_input_table = bdc_config_manager.get_full_table_name(dq_config['rule_input_table'])

    # Get RULE_TITLE and COLOR_COLUMNS to build the DQ_CORE table name and color filter
    meta = sf.execute(f"""
        SELECT v.RULE_TITLE, i.COLOR_COLUMNS
        FROM {rule_latest_view} v
        LEFT JOIN {rule_input_table} i
            ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
        WHERE v.RULE_ID = %(rule_id)s
        LIMIT 1
    """, {"rule_id": rule_id})
    if not meta.rows:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    rule_title = meta.rows[0][0]
    color_col1, color_col2 = _parse_color_columns(meta.rows[0][1])
    table_name = _rule_table_name(rule_id, rule_title)
    if delta_mode:
        table_name = f"DELTA_{table_name}"

    fq_table = bdc_config_manager.core_table(table_name)

    # Build optional WHERE clause based on color_filter.
    # Color is determined by the absolute day difference between the two
    # COLOR_COLUMNS dates defined in DQ_RULE_INPUT (same logic as the UI).
    # We only apply the filter when both date columns exist in the table.
    color_filter = color_filter.upper()
    where_clause = ""
    if color_filter in ("GREEN", "YELLOW", "RED") and color_col1 and color_col2:
        # COLOR_COLUMNS comes from the user-writable DQ_RULE_INPUT table, so we
        # can't drop it into SQL as-is. Pull the table's real column list and
        # only keep the color cols if they're actual columns and plain
        # identifiers. Once they pass both checks they're safe to inline.
        col_check = sf.execute(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = %(core_schema)s
              AND TABLE_NAME   = %(table_name)s
            """,
            {"core_schema": bdc_config_manager.get_core_schema(), "table_name": table_name},
        )
        real_cols = {r[0] for r in col_check.rows}
        cols_ok = (
            _is_safe_identifier(color_col1) and _is_safe_identifier(color_col2)
            and color_col1 in real_cols and color_col2 in real_cols
        )
        if cols_ok:
            diff_expr = f"ABS(DATEDIFF('day', {color_col1}, {color_col2}))"
            if color_filter == "GREEN":
                where_clause = f"WHERE {diff_expr} <= 7"
            elif color_filter == "YELLOW":
                where_clause = f"WHERE {diff_expr} BETWEEN 8 AND 15"
            elif color_filter == "RED":
                where_clause = (
                    f"WHERE {diff_expr} >= 16"
                    f" OR {color_col1} IS NULL"
                    f" OR {color_col2} IS NULL"
                )

    try:
        total_count = int(sf.execute(f"SELECT COUNT(*) FROM {fq_table} {where_clause}").rows[0][0])
        total_pages = max(1, -(-total_count // page_size))
        offset = (page - 1) * page_size
        # LIMIT/OFFSET over an unordered result can repeat or skip rows between
        # pages. These tables have no key column, so order by a hash of the
        # whole row: stable across requests, and rows that tie are (in practice) identical.
        order = '"__BDC_ORD"'
        if sort_col:
            # sort the whole table, not just one page; the name must be a real column
            cols = sf.execute(f"SELECT * FROM {fq_table} LIMIT 0").columns
            if sort_col not in cols:
                raise HTTPException(status_code=400, detail=f"Unknown column '{sort_col}'")
            quoted = '"' + sort_col.replace('"', '""') + '"'
            order = f'{quoted} {sort_dir.upper()} NULLS LAST, "__BDC_ORD"'
        result = sf.execute(
            f'SELECT * EXCLUDE "__BDC_ORD" FROM (SELECT *, HASH(*) AS "__BDC_ORD" FROM {fq_table} {where_clause}) '
            f'ORDER BY {order} LIMIT {page_size} OFFSET {offset}'
        )
        return {
            "columns": result.columns,
            "rows": [list(r) for r in result.rows],
            "count": len(result.rows),
            "total_count": total_count,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        if "does not exist" in msg.lower() or "object not found" in msg.lower():
            raise HTTPException(status_code=404,
                                detail=f"No failed rows table found for rule '{rule_id}'. It may not have been executed yet.")
        raise HTTPException(status_code=500, detail=f"Error reading {fq_table}: {msg}")


@app.get("/api/rules/{rule_id}/failed-rows-count")
def get_bdc_failed_rows_count(
        rule_id: str,
        delta_mode: bool = Query(False),
        auth: dict = Depends(require_bdc_rule),
):
    """Return only the total count of failed rows for a rule (lightweight, no pagination)."""
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    sf_config = bdc_config_manager.get_snowflake_config()
    database = sf_config.get("database")
    latest_key = dq_config['rule_latest_view']
    if delta_mode:
        latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
    rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)
    rule_input_table = bdc_config_manager.get_full_table_name(dq_config['rule_input_table'])

    meta = sf.execute(f"""
        SELECT v.RULE_TITLE
        FROM {rule_latest_view} v
        WHERE v.RULE_ID = %(rule_id)s
        LIMIT 1
    """, {"rule_id": rule_id})
    if not meta.rows:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    rule_title = meta.rows[0][0]
    table_name = _rule_table_name(rule_id, rule_title)
    if delta_mode:
        table_name = f"DELTA_{table_name}"

    fq_table = bdc_config_manager.core_table(table_name)

    try:
        total_count = int(sf.execute(f"SELECT COUNT(*) FROM {fq_table}").rows[0][0])
        return {"total_count": total_count}
    except Exception as e:
        msg = str(e)
        if "does not exist" in msg.lower() or "object not found" in msg.lower():
            return {"total_count": None}  # table not run yet — return null, not an error
        raise HTTPException(status_code=500, detail=f"Count query failed: {msg}")


@app.get("/api/rules/{rule_id}/download-failed-rows")
def download_bdc_failed_rows(
        rule_id: str,
        delta_mode: bool = Query(False, description="When True, download from the _DELTA table"),
        auth: dict = Depends(require_bdc_rule_download),
):
    import io as _io
    from datetime import datetime as _dt
    import xlsxwriter

    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    sf_config = bdc_config_manager.get_snowflake_config()
    database = sf_config.get("database")
    latest_key = dq_config['rule_latest_view']
    if delta_mode:
        latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
    rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)
    rule_input_table = bdc_config_manager.get_full_table_name(dq_config['rule_input_table'])

    meta = sf.execute(f"""
        SELECT v.RULE_TITLE, i.COLOR_COLUMNS
        FROM {rule_latest_view} v
        LEFT JOIN {rule_input_table} i
            ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
        WHERE v.RULE_ID = %(rule_id)s
        LIMIT 1
    """, {"rule_id": rule_id})
    if not meta.rows:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    rule_title = meta.rows[0][0]
    color_col1, color_col2 = _parse_color_columns(meta.rows[0][1])
    table_name = _rule_table_name(rule_id, rule_title)
    if delta_mode:
        table_name = f"DELTA_{table_name}"

    fq_table = bdc_config_manager.core_table(table_name)

    cur = sf.conn.cursor()
    try:
        cur.execute(f"SELECT * FROM {fq_table}")
    except Exception as e:
        cur.close()
        msg = str(e)
        if "does not exist" in msg.lower() or "object not found" in msg.lower():
            raise HTTPException(status_code=404, detail=f"No failed rows table found for rule '{rule_id}'.")
        raise HTTPException(status_code=500, detail=f"Error reading {fq_table}: {msg}")

    try:
        # Collect all batches into one DataFrame
        batches = list(cur.fetch_pandas_batches())
    finally:
        cur.close()

    import pandas as _pd
    df = _pd.concat(batches, ignore_index=True) if batches else _pd.DataFrame()

    # Build Excel in memory with xlsxwriter
    buf = _io.BytesIO()
    workbook = xlsxwriter.Workbook(buf, {"in_memory": True, "constant_memory": False})
    worksheet = workbook.add_worksheet("Failed Rows")

    # --- Formats ---
    header_fmt = workbook.add_format({
        "bold": True, "bg_color": "#E8E6E3", "border": 1,
        "font_name": "Calibri", "font_size": 10, "align": "center"
    })
    base_props = {"border": 1, "font_name": "Calibri", "font_size": 10}
    fmt_green = workbook.add_format(
        {**base_props, "bg_color": "#DCFCE7", "left": 2, "left_color": "#328714"})  # ≤ 7 days
    fmt_yellow = workbook.add_format(
        {**base_props, "bg_color": "#FEF9C3", "left": 2, "left_color": "#CA8A04"})  # 8–15 days
    fmt_red = workbook.add_format(
        {**base_props, "bg_color": "#FEE2E2", "left": 2, "left_color": "#EB1700"})  # ≥ 16 days
    fmt_plain = workbook.add_format({**base_props})
    header_color_fmt = workbook.add_format({
        "bold": True, "bg_color": "#D1FAE5", "border": 1,
        "font_name": "Calibri", "font_size": 10, "align": "center",
        "left": 2, "left_color": "#328714"
    })

    cols = list(df.columns)

    # Identify date column indices from COLOR_COLUMNS (strip whitespace from column names)
    stripped = [c.strip() for c in cols]
    created_idx = stripped.index(color_col1) if color_col1 and color_col1 in stripped else -1
    approved_idx = stripped.index(color_col2) if color_col2 and color_col2 in stripped else -1
    has_date_cols = created_idx != -1 and approved_idx != -1

    # Hardcoded DIFFERENCE_* rules — layered on top of COLOR_COLUMNS
    dcr_col_index = _dcr.build_col_index(cols)
    dcr_rules = _dcr.active_rules(dcr_col_index)
    dcr_targets = _dcr.target_col_indices(dcr_col_index)
    _SEV_FMT = {_dcr.GREEN: fmt_green, _dcr.YELLOW: fmt_yellow, _dcr.RED: fmt_red}
    _SEV_HEX = {_dcr.GREEN: "#DCFCE7", _dcr.YELLOW: "#FEF9C3", _dcr.RED: "#FEE2E2"}
    gradient_cells = {}  # (row, col) 1-indexed -> [hex, ...] worst first

    # Write header row — highlight the color columns
    for c, col_name in enumerate(cols):
        is_color_col = (has_date_cols and c in (created_idx, approved_idx)) or c in dcr_targets
        worksheet.write(0, c, col_name, header_color_fmt if is_color_col else header_fmt)

    def _day_diff(v1, v2) -> int | None:
        """Return absolute day difference between two date-like values, or None."""
        try:
            d1 = _pd.Timestamp(v1)
            d2 = _pd.Timestamp(v2)
            if _pd.isna(d1) or _pd.isna(d2):
                return None
            return abs((d1.normalize() - d2.normalize()).days)  # calendar days, like DATEDIFF
        except Exception:
            return None

    # Write data rows — color coding applied only to the color / diff-rule columns
    for r, row in enumerate(df.itertuples(index=False), start=1):
        row_vals = list(row)

        # Gather every severity each cell picks up, from both colouring paths
        sev_accum = {}
        if has_date_cols:
            days = _day_diff(row_vals[created_idx], row_vals[approved_idx])
            sev = (_dcr.RED if days is None
                   else _dcr.GREEN if days <= 7
                   else _dcr.YELLOW if days <= 15 else _dcr.RED)
            sev_accum[created_idx] = [sev]
            sev_accum[approved_idx] = [sev]
        if dcr_rules:
            _dcr.accumulate(row_vals, dcr_col_index, sev_accum, dcr_rules)

        # Worst severity is the solid fill; anything mixed gets a gradient later
        cell_fmts = {}
        for ci, sevs in sev_accum.items():
            unique = list(dict.fromkeys(sevs))
            worst = max(unique, key=lambda s: _dcr.SEVERITY_RANK[s])
            cell_fmts[ci] = _SEV_FMT[worst]
            if len(unique) > 1:
                ordered = sorted(unique, key=lambda s: -_dcr.SEVERITY_RANK[s])
                gradient_cells[(r + 1, ci + 1)] = [_SEV_HEX[s] for s in ordered]

        for c, val in enumerate(row_vals):
            fmt = cell_fmts.get(c, fmt_plain)
            # Convert pandas NA/NaT to empty string so Excel doesn't choke
            if _pd.isna(val) if not isinstance(val, str) else False:
                worksheet.write(r, c, "", fmt)
            else:
                worksheet.write(r, c, val, fmt)

    workbook.close()
    buf.seek(0)
    file_bytes = apply_excel_type_formatting(buf)
    file_bytes = apply_gradient_fills(file_bytes, {"Failed Rows": gradient_cells})

    filename = f"{rule_id}_all_failed_rows.xlsx"
    file_size = len(file_bytes)
    return StreamingResponse(
        _io.BytesIO(file_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(file_size),
        }
    )


@app.get("/api/rules/{rule_id}/prepare-download")
async def prepare_bdc_download(
        rule_id: str,
        delta_mode: bool = Query(False, description="When True, stream from the _DELTA table"),
        auth: dict = Depends(require_bdc_rule_download),
):
    """
    SSE endpoint that streams real build-step progress (5 steps), builds the
    XLSX in the background, caches it, and finally emits a 'ready' event with
    a one-time download token the frontend can use to fetch the file.
    """
    import pandas as _pd

    def _sse(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def stream():
        try:
            # ── Step 1: connect / validate rule ──────────────────────────────
            yield _sse({"step": 1, "total": 5, "pct": 5, "label": "Connecting to Snowflake..."})
            await asyncio.sleep(0)  # yield to event loop so the client receives it immediately

            if not bdc_connection_manager or not bdc_config_manager:
                yield _sse({"type": "error", "message": "Business Defined Checks service not available"})
                return

            sf = bdc_connection_manager.get_client()
            dq_config = bdc_config_manager.get_dq_config()
            sf_config = bdc_config_manager.get_snowflake_config()
            database = sf_config.get("database")
            latest_key = dq_config['rule_latest_view']
            if delta_mode:
                latest_key = latest_key + '_DELTA' if not latest_key.endswith('_DELTA') else latest_key
            rule_latest_view = bdc_config_manager.get_full_table_name(latest_key)
            rule_registry_table = bdc_config_manager.get_full_table_name(dq_config['rule_registry_table'])
            trends_key = dq_config['rule_trends_view']
            if delta_mode and not trends_key.endswith('_DELTA'):
                trends_key += '_DELTA'  # "Last Validation Run" has to come from the same cadence
            rule_trends_view = bdc_config_manager.get_full_table_name(trends_key)
            rule_input_table = bdc_config_manager.get_full_table_name(dq_config['rule_input_table'])

            # Fetch full rule metadata for the Dashboard sheet
            meta = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: sf.execute(f"""
                    SELECT
                        v.RULE_ID,
                        v.RULE_TITLE,
                        v.RULE_DESCRIPTION,
                        v.SEVERITY,
                        v.TARGET_TABLE,
                        v.PASS_PERCENTAGE,
                        v.STATUS,
                        r.SQL_PREDICATE,
                        i.COLOR_COLUMNS
                    FROM {rule_latest_view} v
                    LEFT JOIN {rule_registry_table} r
                        ON v.RULE_ID = r.RULE_ID AND r.IS_VALIDATED = TRUE
                    LEFT JOIN {rule_input_table} i
                        ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
                    WHERE v.RULE_ID = %(rule_id)s
                    LIMIT 1
                """, {"rule_id": rule_id})
            )
            if not meta.rows:
                yield _sse({"type": "error", "message": f"Rule '{rule_id}' not found"})
                return

            row = meta.rows[0]
            rule_meta = {
                "Rule ID": row[0],
                "Rule Title": row[1],
                "Description": row[2] or "—",
                "Severity": row[3],
                "Target Table": row[4],
                "Pass Rate": f"{row[5]}%" if row[5] is not None else "—",
                "Status": row[6],
                "SQL Predicate": row[7] or "—",
                "Downloaded At": datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S %Z"),
            }
            rule_title = row[1]
            dl_color_col1, dl_color_col2 = _parse_color_columns(row[8])

            table_name = _rule_table_name(rule_id, rule_title)
            if delta_mode:
                table_name = f"DELTA_{table_name}"
            fq_table = bdc_config_manager.core_table(table_name)

            # Fetch last validation run date sequentially (simple, reliable)
            try:
                last_run_result = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: sf.execute(f"""
                        SELECT TO_CHAR(MAX(RUN_DATE), 'YYYY-MM-DD HH24:MI:SS')
                        FROM {rule_trends_view}
                        WHERE RULE_ID = %(rule_id)s
                    """, {"rule_id": rule_id})
                )
                last_run = (last_run_result.rows[0][0]
                            if last_run_result.rows and last_run_result.rows[0][0]
                            else "—")
            except Exception:
                last_run = "—"

            # ── Step 2: execute query ─────────────────────────────────────────
            yield _sse({"step": 2, "total": 5, "pct": 20, "label": "Executing Snowflake query..."})
            await asyncio.sleep(0)

            cur = sf.conn.cursor()
            try:
                await asyncio.get_event_loop().run_in_executor(None, lambda: cur.execute(f"SELECT * FROM {fq_table}"))
            except Exception as e:
                cur.close()
                msg = str(e)
                if "does not exist" in msg.lower() or "object not found" in msg.lower():
                    yield _sse({"type": "error", "message": f"No failed rows table found for rule '{rule_id}'."})
                else:
                    yield _sse({"type": "error", "message": f"Error reading {fq_table}: {msg}"})
                return

            # ── Step 3: fetch rows ────────────────────────────────────────────
            yield _sse({"step": 3, "total": 5, "pct": 40, "label": "Fetching rows from Snowflake..."})
            await asyncio.sleep(0)

            try:
                batches = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: list(cur.fetch_pandas_batches())
                )
            finally:
                cur.close()

            df = _pd.concat(batches, ignore_index=True) if batches else _pd.DataFrame()

            # Compute colour counts from the DataFrame (no extra SQL round-trip)
            colour_counts = None
            try:
                if dl_color_col1 and dl_color_col2:
                    stripped_cols = [c.strip() for c in df.columns]
                    if dl_color_col1 in stripped_cols and dl_color_col2 in stripped_cols:
                        c_idx = stripped_cols.index(dl_color_col1)
                        a_idx = stripped_cols.index(dl_color_col2)
                        c_col = df.columns[c_idx]
                        a_col = df.columns[a_idx]
                        diff = (_pd.to_datetime(df[c_col], errors='coerce').dt.normalize() -
                                _pd.to_datetime(df[a_col], errors='coerce').dt.normalize()).abs().dt.days
                        colour_counts = {
                            "green": int((diff <= 7).sum()),
                            "yellow": int(((diff >= 8) & (diff <= 15)).sum()),
                            "red": int((diff.isna() | (diff >= 16)).sum()),
                        }
            except Exception:
                colour_counts = None

            # ── Step 4: build Excel with per-chunk progress ───────────────────
            total_rows = len(df)
            yield _sse({"step": 4, "total": 5, "pct": 40, "label": f"Building Excel file ({total_rows:,} rows)..."})
            await asyncio.sleep(0)

            import io as _io
            import xlsxwriter

            buf = _io.BytesIO()
            workbook = xlsxwriter.Workbook(buf, {"in_memory": True, "constant_memory": False})

            # ── Dashboard sheet (first) ───────────────────────────────────────
            dash = workbook.add_worksheet("Dashboard")
            dash.set_column(0, 0, 28)  # label column
            dash.set_column(1, 1, 60)  # value column

            # Formats
            title_fmt = workbook.add_format({
                "bold": True, "font_size": 16, "font_name": "Calibri",
                "font_color": "#FFFFFF", "bg_color": "#0F68B2",
                "align": "left", "valign": "vcenter", "border": 0,
            })
            subtitle_fmt = workbook.add_format({
                "bold": True, "font_size": 11, "font_name": "Calibri",
                "font_color": "#FFFFFF", "bg_color": "#1A7FCC",
                "align": "left", "valign": "vcenter",
            })
            label_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#312C2A", "bg_color": "#E8E6E3",
                "border": 1, "valign": "top",
            })
            value_fmt = workbook.add_format({
                "font_size": 10, "font_name": "Calibri",
                "font_color": "#312C2A", "bg_color": "#FFFFFF",
                "border": 1, "valign": "top", "text_wrap": True,
            })
            pass_green_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#166534", "bg_color": "#DCFCE7",
                "border": 1, "valign": "top",
            })
            pass_yellow_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#854D0E", "bg_color": "#FEF9C3",
                "border": 1, "valign": "top",
            })
            pass_red_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#991B1B", "bg_color": "#FEE2E2",
                "border": 1, "valign": "top",
            })
            severity_crit_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#FFFFFF", "bg_color": "#EB1700",
                "border": 1, "valign": "top",
            })
            severity_high_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#FFFFFF", "bg_color": "#FF6017",
                "border": 1, "valign": "top",
            })
            status_active_fmt = workbook.add_format({
                "bold": True, "font_size": 10, "font_name": "Calibri",
                "font_color": "#166534", "bg_color": "#DCFCE7",
                "border": 1, "valign": "top",
            })
            sql_fmt = workbook.add_format({
                "font_size": 9, "font_name": "Courier New",
                "font_color": "#1E3A5F", "bg_color": "#F0F4F8",
                "border": 1, "valign": "top", "text_wrap": True,
            })
            meta_fmt = workbook.add_format({
                "italic": True, "font_size": 9, "font_name": "Calibri",
                "font_color": "#81766F", "bg_color": "#FAFAFA",
                "border": 1,
            })

            # Title banner (merged across both columns)
            dash.set_row(0, 36)
            dash.merge_range(0, 0, 0, 1, "  Rule Dashboard", title_fmt)

            dash.set_row(1, 4)  # thin spacer row

            # Section header
            dash.set_row(2, 20)
            dash.merge_range(2, 0, 2, 1, "  Rule Information", subtitle_fmt)

            # Helper to pick pass-rate format
            def _pass_fmt(pass_str):
                try:
                    pct = float(pass_str.replace("%", ""))
                    if pct >= 95:  return pass_green_fmt
                    if pct >= 80:  return pass_yellow_fmt
                    return pass_red_fmt
                except Exception:
                    return value_fmt

            # Rows: (label, value, optional_value_format)
            field_rows = [
                ("Rule ID", rule_meta["Rule ID"], None),
                ("Rule Title", rule_meta["Rule Title"], None),
                ("Description", rule_meta["Description"], None),
                ("Severity", rule_meta["Severity"],
                 severity_crit_fmt if rule_meta["Severity"] == "CRITICAL"
                 else severity_high_fmt if rule_meta["Severity"] == "HIGH"
                 else None),
                ("Target Table", rule_meta["Target Table"], None),
                ("Pass Rate", rule_meta["Pass Rate"], _pass_fmt(rule_meta["Pass Rate"])),
                ("Status", rule_meta["Status"],
                 status_active_fmt if rule_meta["Status"] == "ACTIVE" else None),
                ("Total Failed Rows", f"{len(df):,}", pass_red_fmt if len(df) > 0 else pass_green_fmt),
            ]

            # Colour-band breakdown (only when date columns exist)
            if colour_counts is not None:
                green_fmt_row = workbook.add_format(
                    {"border": 1, "font_name": "Calibri", "font_size": 10, "bold": True, "bg_color": "#DCFCE7",
                     "font_color": "#166534"})
                yellow_fmt_row = workbook.add_format(
                    {"border": 1, "font_name": "Calibri", "font_size": 10, "bold": True, "bg_color": "#FEF9C3",
                     "font_color": "#854D0E"})
                red_fmt_row = workbook.add_format(
                    {"border": 1, "font_name": "Calibri", "font_size": 10, "bold": True, "bg_color": "#FEE2E2",
                     "font_color": "#991B1B"})
                field_rows += [
                    ("Rows ≤ 7 days (Green)", f"{colour_counts['green']:,}", green_fmt_row),
                    ("Rows 8–15 days (Yellow)", f"{colour_counts['yellow']:,}", yellow_fmt_row),
                    ("Rows ≥ 16 days (Red)", f"{colour_counts['red']:,}", red_fmt_row),
                ]

            field_rows += [
                ("Last Validation Run", last_run, None),
                ("Downloaded At", rule_meta["Downloaded At"], None),
            ]

            for i, (label, value, val_fmt) in enumerate(field_rows):
                r = i + 3
                row_h = 40 if label == "Description" else 18
                dash.set_row(r, row_h)
                dash.write(r, 0, label, label_fmt)
                dash.write(r, 1, value, val_fmt or value_fmt)

            # SQL Predicate section (taller, monospace)
            sql_row = len(field_rows) + 4
            dash.set_row(sql_row - 1, 4)  # spacer
            dash.set_row(sql_row, 20)
            dash.merge_range(sql_row, 0, sql_row, 1, "  SQL Predicate", subtitle_fmt)
            dash.set_row(sql_row + 1, max(60, min(120, len(rule_meta["SQL Predicate"]) // 2)))
            dash.write(sql_row + 1, 0, "SQL Predicate", label_fmt)
            dash.write(sql_row + 1, 1, rule_meta["SQL Predicate"], sql_fmt)

            # Footer
            footer_row = sql_row + 3
            dash.merge_range(footer_row, 0, footer_row, 1,
                             f"  Generated by GRA-SmartHub  ·  {rule_meta['Downloaded At']}",
                             meta_fmt)

            # ── Failed Rows sheet (second) ────────────────────────────────────
            worksheet = workbook.add_worksheet("Failed Rows")

            base_props = {"border": 1, "font_name": "Calibri", "font_size": 10}
            fmt_green = workbook.add_format({**base_props, "bg_color": "#DCFCE7", "left": 2, "left_color": "#328714"})
            fmt_yellow = workbook.add_format({**base_props, "bg_color": "#FEF9C3", "left": 2, "left_color": "#CA8A04"})
            fmt_red = workbook.add_format({**base_props, "bg_color": "#FEE2E2", "left": 2, "left_color": "#EB1700"})
            fmt_plain = workbook.add_format({**base_props})
            header_fmt = workbook.add_format({
                "bold": True, "bg_color": "#E8E6E3", "border": 1,
                "font_name": "Calibri", "font_size": 10, "align": "center"
            })
            header_color_fmt = workbook.add_format({
                "bold": True, "bg_color": "#D1FAE5", "border": 1,
                "font_name": "Calibri", "font_size": 10, "align": "center",
                "left": 2, "left_color": "#328714"
            })

            cols = list(df.columns)
            stripped = [c.strip() for c in cols]
            created_idx = stripped.index(dl_color_col1) if dl_color_col1 and dl_color_col1 in stripped else -1
            approved_idx = stripped.index(dl_color_col2) if dl_color_col2 and dl_color_col2 in stripped else -1
            has_date_cols = created_idx != -1 and approved_idx != -1

            # Hardcoded DIFFERENCE_* rules — layered on top of COLOR_COLUMNS
            dcr_col_index = _dcr.build_col_index(cols)
            dcr_rules = _dcr.active_rules(dcr_col_index)
            dcr_targets = _dcr.target_col_indices(dcr_col_index)
            _SEV_FMT = {_dcr.GREEN: fmt_green, _dcr.YELLOW: fmt_yellow, _dcr.RED: fmt_red}
            _SEV_HEX = {_dcr.GREEN: "#DCFCE7", _dcr.YELLOW: "#FEF9C3", _dcr.RED: "#FEE2E2"}
            gradient_cells = {}  # (row, col) 1-indexed -> [hex, ...] worst first

            # Write header row — highlight the color columns
            for c, col_name in enumerate(cols):
                is_color_col = (has_date_cols and c in (created_idx, approved_idx)) or c in dcr_targets
                worksheet.write(0, c, col_name, header_color_fmt if is_color_col else header_fmt)

            def _day_diff(v1, v2):
                try:
                    d1, d2 = _pd.Timestamp(v1), _pd.Timestamp(v2)
                    if _pd.isna(d1) or _pd.isna(d2):
                        return None
                    return abs((d1.normalize() - d2.normalize()).days)  # calendar days, like DATEDIFF
                except Exception:
                    return None

            # Write rows in chunks — color coding applied only to the two color columns
            CHUNK_SIZE = 500
            last_reported_pct = 40

            def _write_chunk(start: int, end: int):
                for r in range(start, end):
                    row_vals = list(df.iloc[r])

                    sev_accum = {}
                    if has_date_cols:
                        days = _day_diff(row_vals[created_idx], row_vals[approved_idx])
                        sev = (_dcr.RED if days is None
                               else _dcr.GREEN if days <= 7
                               else _dcr.YELLOW if days <= 15 else _dcr.RED)
                        sev_accum[created_idx] = [sev]
                        sev_accum[approved_idx] = [sev]
                    if dcr_rules:
                        _dcr.accumulate(row_vals, dcr_col_index, sev_accum, dcr_rules)

                    cell_fmts = {}
                    for ci, sevs in sev_accum.items():
                        unique = list(dict.fromkeys(sevs))
                        worst = max(unique, key=lambda s: _dcr.SEVERITY_RANK[s])
                        cell_fmts[ci] = _SEV_FMT[worst]
                        if len(unique) > 1:
                            ordered = sorted(unique, key=lambda s: -_dcr.SEVERITY_RANK[s])
                            gradient_cells[(r + 2, ci + 1)] = [_SEV_HEX[s] for s in ordered]

                    for c, val in enumerate(row_vals):
                        fmt = cell_fmts.get(c, fmt_plain)
                        if not isinstance(val, str) and _pd.isna(val):
                            worksheet.write(r + 1, c, "", fmt)
                        else:
                            worksheet.write(r + 1, c, val, fmt)

            for chunk_start in range(0, total_rows, CHUNK_SIZE):
                chunk_end = min(chunk_start + CHUNK_SIZE, total_rows)
                await asyncio.get_event_loop().run_in_executor(None,
                                                               lambda s=chunk_start, e=chunk_end: _write_chunk(s, e))

                rows_done = chunk_end
                # Map row progress (0→total_rows) into pct range 40→88
                build_pct = int(40 + (rows_done / max(total_rows, 1)) * 48) if total_rows > 0 else 88
                if build_pct > last_reported_pct:
                    last_reported_pct = build_pct
                    yield _sse({
                        "step": 4, "total": 5, "pct": build_pct,
                        "label": f"Building Excel file... ({rows_done:,} / {total_rows:,} rows)"
                    })
                    await asyncio.sleep(0)

            # ── Step 5: close workbook & cache ────────────────────────────────
            yield _sse({"step": 5, "total": 5, "pct": 90, "label": "Finalizing file..."})
            await asyncio.sleep(0)

            await asyncio.get_event_loop().run_in_executor(None, workbook.close)
            buf.seek(0)
            file_bytes = await asyncio.get_event_loop().run_in_executor(
                None, lambda: apply_excel_type_formatting(buf)
            )
            if gradient_cells:
                yield _sse({"step": 5, "total": 5, "pct": 95, "label": "Applying colors..."})
                await asyncio.sleep(0)
                file_bytes = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: apply_gradient_fills(file_bytes, {"Failed Rows": gradient_cells})
                )

            token = str(uuid.uuid4())
            _download_cache[token] = file_bytes

            yield _sse({
                "type": "ready",
                "pct": 100,
                "token": token,
                "filename": f"{rule_id}_all_failed_rows.xlsx",
                "size": len(file_bytes),
            })

        except Exception as e:
            yield _sse({"type": "error", "message": f"Unexpected error: {str(e)}"})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/rules/{rule_id}/download-ready")
def fetch_prepared_download(rule_id: str, token: str = Query(...), auth: dict = Depends(require_bdc_rule_download)):
    """
    One-time endpoint: returns the cached XLSX for the given token and removes it.
    """
    file_bytes = _download_cache.pop(token, None)
    if file_bytes is None:
        raise HTTPException(status_code=404, detail="Download token not found or already used.")

    filename = f"{rule_id}_all_failed_rows.xlsx"
    return StreamingResponse(
        BytesIO(file_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(file_bytes)),
        }
    )


# ============================================================================
# DELTA REPORT — CORE vs previous STG run
# ============================================================================

# ============================================================================
# DELTA REPORT — CORE vs previous STG run
# ============================================================================

@app.get("/api/rules/{rule_id}/stg-tables")
def list_stg_tables(
        rule_id: str,
        delta_mode: bool = Query(False, description="When True, list DELTA_ prefixed STG tables"),
        auth: dict = Depends(require_bdc_rule),
):
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    sf_config = bdc_config_manager.get_snowflake_config()
    database = sf_config.get("database")
    # Same view as /delta-rows: the Semi-Monthly picker has to find rules that
    # only exist in the _DELTA view, and derive the same snapshot names.
    view_key = dq_config['rule_latest_view']
    if delta_mode and not view_key.endswith('_DELTA'):
        view_key += '_DELTA'
    rule_view = bdc_config_manager.get_full_table_name(view_key)

    meta = sf.execute(f"SELECT RULE_TITLE FROM {rule_view} WHERE RULE_ID = %(rule_id)s LIMIT 1", {"rule_id": rule_id})
    if not meta.rows:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    rule_title = meta.rows[0][0]
    base_name = _rule_table_name(rule_id, rule_title)
    if delta_mode:
        base_name = f"DELTA_{base_name}"

    tables = []
    for i, row in enumerate(_rule_snapshots(sf, database, base_name)):
        table_name = row[0]
        created = row[1]
        # Extract the timestamp suffix: everything after base_name_
        suffix = table_name[len(base_name) + 1:] if table_name.startswith(base_name + "_") else ""
        tables.append({
            "table_name": table_name,
            "full_name": bdc_config_manager.stg_table(table_name),
            "run_suffix": suffix,
            "created_at": created.isoformat() if created else None,
            "is_latest": i == 0,
            "is_previous": i == 1,
        })

    # The run the default comparison starts from (same choice as /delta-rows).
    try:
        default_from = _default_from_snapshot(sf, bdc_config_manager.core_table(base_name), [t["table_name"] for t in tables])
    except HTTPException:
        default_from = None
    for t in tables:
        t["is_previous"] = t["table_name"] == default_from

    return {
        "rule_id": rule_id,
        "base_name": base_name,
        "core_table": bdc_config_manager.core_table(base_name),
        "default_from": default_from,
        "tables": tables,
    }


DELTA_SHEETS = ("new_failures", "resolved_rows", "persisting_rows")
_DELTA_CACHE_TTL = 120.0
_DELTA_CACHE_MAX = 6   # ponytail: whole result frames in memory; move to Redis if these get big or many workers need to share
# Its own name: this used to be "_delta_cache" too, which silently replaced the
# download-token cache above, so prepared delta workbooks shared (and got
# evicted from) this 6-slot frame cache and never expired.
_delta_frames_cache: Dict[tuple, tuple] = {}
_delta_cache_lock = threading.Lock()
_SNAPSHOT_SUFFIX_RE = re.compile(r"[0-9_]+")


def _rule_snapshots(sf, database: str, base_name: str) -> list:
    """(TABLE_NAME, CREATED) of this rule's STG run snapshots, newest first.
    Matched exactly in Python: in the old LIKE '<base>\\_%' the underscores
    still acted as wildcards, so ..._V1 also picked up ..._V10's snapshots."""
    rows = sf.execute(f"""
        SELECT TABLE_NAME, CREATED FROM {database}.INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = %(schema)s AND STARTSWITH(TABLE_NAME, %(prefix)s)
    """, {"schema": bdc_config_manager.get_stg_schema(), "prefix": f"{base_name}_"}).rows
    mine = [r for r in rows if _SNAPSHOT_SUFFIX_RE.fullmatch(r[0][len(base_name) + 1:])]
    return sorted(mine, key=lambda r: r[0], reverse=True)


def _default_from_snapshot(sf, core_fq: str, stg_names: list) -> str:
    """The run to compare the latest one against. A failing run writes a new
    snapshot and CORE becomes a copy of it, so the previous run is the 2nd
    newest snapshot. A passing run empties CORE and writes no snapshot, so then
    the previous run is the newest one."""
    try:
        core_rows = int(sf.execute(f"SELECT COUNT(*) FROM {core_fq}").rows[0][0])
    except Exception:
        core_rows = 1  # can't tell; keep the usual rule
    need = 2 if core_rows else 1
    if len(stg_names) < need:
        raise HTTPException(
            status_code=404,
            detail=f"Need at least {need} earlier run{'s' if need > 1 else ''} to compare against. Found {len(stg_names)}.",
        )
    return stg_names[need - 1]


def _check_snapshot(name: Optional[str], snapshots: list) -> None:
    """A caller-named snapshot has to be one of this rule's. Without this, anyone
    allowed one rule could read another dataset's rows by naming its table."""
    if name and name not in {r[0] for r in snapshots}:
        raise HTTPException(status_code=404, detail=f"Run '{name}' is not a snapshot of this rule.")


def _delta_frames(sf, core_fq: str, stg_fq: str) -> dict:
    """Both runs compared once; the three sheets are slices of the same merge.
    Cached briefly so paging and switching sheets don't re-read two whole tables."""
    key = (core_fq, stg_fq)
    with _delta_cache_lock:
        hit = _delta_frames_cache.get(key)
        if hit and time.monotonic() - hit[0] < _DELTA_CACHE_TTL:
            return hit[1]

    def read(fq: str, label: str) -> pd.DataFrame:
        cur = sf.conn.cursor()
        try:
            cur.execute(f"SELECT * FROM {fq}")
            batches = list(cur.fetch_pandas_batches())
            return pd.concat(batches, ignore_index=True) if batches else pd.DataFrame()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error reading {label} table ({fq}): {e}")
        finally:
            cur.close()

    df_core = read(core_fq, "CORE")
    df_stg = read(stg_fq, "STG")
    compare_cols = [c for c in df_core.columns if c in set(df_stg.columns)]
    if not compare_cols:
        raise HTTPException(status_code=500, detail="No common columns found between CORE and STG tables.")

    try:
        core_cmp = df_core[compare_cols].astype(str).reset_index(drop=True)
        stg_cmp = df_stg[compare_cols].astype(str).reset_index(drop=True)
        core_cmp["__pos__"] = pd.RangeIndex(len(core_cmp))
        stg_keys = stg_cmp.drop_duplicates()
        left = pd.merge(core_cmp, stg_keys, on=compare_cols, how="left", indicator=True)
        new_pos = left.loc[left["_merge"] == "left_only", "__pos__"].drop_duplicates().values
        kept_pos = left.loc[left["_merge"] == "both", "__pos__"].drop_duplicates().values

        stg_cmp["__pos__"] = pd.RangeIndex(len(stg_cmp))
        core_keys = core_cmp[compare_cols].drop_duplicates()
        right = pd.merge(stg_cmp, core_keys, on=compare_cols, how="left", indicator=True)
        gone_pos = right.loc[right["_merge"] == "left_only", "__pos__"].drop_duplicates().values
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delta computation failed: {e}")

    frames = {
        "sheets": {
            "new_failures": df_core.iloc[new_pos].reset_index(drop=True),
            "resolved_rows": df_stg[compare_cols].iloc[gone_pos].reset_index(drop=True),
            "persisting_rows": df_core.iloc[kept_pos].reset_index(drop=True),
        },
        "core_rows": len(df_core),
        "stg_rows": len(df_stg),
    }
    with _delta_cache_lock:
        if len(_delta_frames_cache) >= _DELTA_CACHE_MAX:
            _delta_frames_cache.pop(min(_delta_frames_cache, key=lambda k: _delta_frames_cache[k][0]))
        _delta_frames_cache[key] = (time.monotonic(), frames)
    return frames


class DeltaRowsResponse(FailedRowsResponse):
    sheet: str
    sheet_counts: Dict[str, int]
    from_table: str
    to_table: str


@app.post("/api/rules/{rule_id}/delta-rows", response_model=DeltaRowsResponse)
def get_delta_rows(
        rule_id: str,
        sheet: str = Query("new_failures", description="new_failures | resolved_rows | persisting_rows"),
        page: int = Query(1, ge=1),
        page_size: int = Query(100, ge=1, le=1000),
        stg_table: Optional[str] = Query(None,
                                         description="FROM STG table (older run). Defaults to 2nd most recent."),
        to_stg_table: Optional[str] = Query(None,
                                            description="TO STG table (newer run). When provided, replaces DQ_CORE as the current-run source."),
        delta_mode: bool = Query(False, description="When True, compare the Semi-Monthly (DELTA_) runs"),
        sort_col: Optional[str] = Query(None, description="Column to sort the whole sheet by"),
        sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
        auth: dict = Depends(require_bdc_rule),
):
    """
    Compute and paginate the delta between two runs for the given rule.
    - stg_table    = FROM (older run). Defaults to 2nd most recent DQ_STG snapshot.
    - to_stg_table = TO   (newer run). When provided uses DQ_STG; otherwise uses DQ_CORE (latest).

    sheet=new_failures    → rows in TO not in FROM
    sheet=resolved_rows   → rows in FROM no longer in TO
    sheet=persisting_rows → rows failing in both runs
    The response also carries the row count of every sheet.
    """
    if not bdc_connection_manager or not bdc_config_manager:
        raise HTTPException(status_code=503, detail="Business Defined Checks service not available")
    if sheet not in DELTA_SHEETS:
        raise HTTPException(status_code=400, detail=f"sheet must be one of {', '.join(DELTA_SHEETS)}")
    for name in (stg_table, to_stg_table):
        if name and not _is_sql_object_name(name):
            raise HTTPException(status_code=400, detail=f"'{name}' is not a valid table name")

    sf = bdc_connection_manager.get_client()
    dq_config = bdc_config_manager.get_dq_config()
    sf_config = bdc_config_manager.get_snowflake_config()
    database = sf_config.get("database")
    view_key = dq_config['rule_latest_view']
    if delta_mode and not view_key.endswith('_DELTA'):
        view_key += '_DELTA'
    rule_view = bdc_config_manager.get_full_table_name(view_key)
    stg_schema = bdc_config_manager.get_stg_schema()

    meta = sf.execute(f"SELECT RULE_TITLE FROM {rule_view} WHERE RULE_ID = %(rule_id)s LIMIT 1", {"rule_id": rule_id})
    if not meta.rows:
        raise HTTPException(status_code=404, detail=f"Rule '{rule_id}' not found")

    rule_title = meta.rows[0][0]
    base_name = _rule_table_name(rule_id, rule_title)
    if delta_mode:
        base_name = f"DELTA_{base_name}"

    snapshots = _rule_snapshots(sf, database, base_name)
    _check_snapshot(to_stg_table, snapshots)
    _check_snapshot(stg_table, snapshots)

    if to_stg_table:
        core_fq, to_name = bdc_config_manager.stg_table(to_stg_table), to_stg_table
    else:
        core_fq, to_name = bdc_config_manager.core_table(base_name), base_name

    if stg_table:
        from_name = stg_table
    elif to_stg_table:
        # an explicit newer snapshot: compare with the one just before it
        names = [r[0] for r in snapshots]
        older = names[names.index(to_stg_table) + 1:] if to_stg_table in names else []
        if not older:
            raise HTTPException(status_code=404, detail="There is no earlier run than the one picked.")
        from_name = older[0]
    else:
        from_name = _default_from_snapshot(sf, core_fq, [r[0] for r in snapshots])

    frames = _delta_frames(sf, core_fq, bdc_config_manager.stg_table(from_name))
    result_df = frames["sheets"][sheet]
    if sort_col:
        if sort_col not in result_df.columns:
            raise HTTPException(status_code=400, detail=f"Unknown column '{sort_col}'")
        args = dict(ascending=sort_dir == "asc", na_position="last", kind="mergesort")
        try:
            result_df = result_df.sort_values(sort_col, **args)
        except TypeError:  # mixed types in one column
            result_df = result_df.sort_values(sort_col, key=lambda c: c.astype(str), **args)

    total_count = len(result_df)
    total_pages = max(1, -(-total_count // page_size))
    offset = (page - 1) * page_size
    page_df = result_df.iloc[offset: offset + page_size]

    rows = []
    for row_vals in page_df.itertuples(index=False):
        rows.append([
            None if (not isinstance(v, str) and pd.isna(v)) else v
            for v in row_vals
        ])

    return {
        "columns": list(result_df.columns),
        "rows": rows,
        "count": len(rows),
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "sheet": sheet,
        "sheet_counts": {k: len(v) for k, v in frames["sheets"].items()},
        "from_table": from_name,
        "to_table": to_name,
    }


@app.get("/api/rules/{rule_id}/prepare-delta")
async def prepare_delta_report(
        rule_id: str,
        stg_table: Optional[str] = Query(None, description="Specific STG table name. Defaults to 2nd most recent."),
        to_stg_table: Optional[str] = Query(None, description="TO STG table (newer run). Defaults to the current DQ_CORE run."),
        delta_mode: bool = Query(False, description="When True, compare the Semi-Monthly (DELTA_) runs"),
        auth: dict = Depends(require_bdc_rule_download),
):
    """
    SSE endpoint that streams progress while computing the delta between:
      - DQ_CORE.<table>        — current failed rows
      - DQ_STG.<table>_<ts>   — 2nd most recent historical run

    Emits step/pct/label progress events, then a 'ready' event with a
    one-time download token the frontend can use to fetch the XLSX.
    """
    import pandas as _pd
    import io as _io
    import xlsxwriter

    def _sse(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def stream():
        try:
            for name in (stg_table, to_stg_table):
                if name and not _is_sql_object_name(name):
                    yield _sse({"type": "error", "message": f"'{name}' is not a valid table name"})
                    return
            # ── Step 1: connect + resolve rule metadata ───────────────────────
            yield _sse({"step": 1, "total": 5, "pct": 5, "label": "Connecting to Snowflake…"})
            await asyncio.sleep(0)

            if not bdc_connection_manager or not bdc_config_manager:
                yield _sse({"type": "error", "message": "Business Defined Checks service not available"})
                return

            sf = bdc_connection_manager.get_client()
            dq_cfg = bdc_config_manager.get_dq_config()
            sf_cfg = bdc_config_manager.get_snowflake_config()
            database = sf_cfg.get("database")
            view_key = dq_cfg['rule_latest_view']
            if delta_mode and not view_key.endswith('_DELTA'):
                view_key += '_DELTA'
            rule_view = bdc_config_manager.get_full_table_name(view_key)
            rule_input_table = bdc_config_manager.get_full_table_name(dq_cfg['rule_input_table'])

            meta = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: sf.execute(f"""
                    SELECT v.RULE_ID, v.RULE_TITLE, v.RULE_DESCRIPTION, v.SEVERITY,
                           v.TARGET_TABLE, v.PASS_PERCENTAGE, v.STATUS, v.DATASET_TITLE,
                           i.COLOR_COLUMNS
                    FROM {rule_view} v
                    LEFT JOIN {rule_input_table} i
                        ON v.RULE_ID = i.RULE_ID AND i.IS_ACTIVE = TRUE
                    WHERE v.RULE_ID = %(rule_id)s
                    LIMIT 1
                """, {"rule_id": rule_id})
            )
            if not meta.rows:
                yield _sse({"type": "error", "message": f"Rule '{rule_id}' not found"})
                return

            row = meta.rows[0]
            rule_title = row[1]
            delta_color_col1, delta_color_col2 = _parse_color_columns(row[8])
            rule_meta = {
                "Rule ID": row[0],
                "Rule Title": row[1],
                "Description": row[2] or "—",
                "Severity": row[3],
                "Target Table": row[4],
                "Pass Rate": f"{row[5]}%" if row[5] is not None else "—",
                "Status": row[6],
                "Dataset Title": row[7] or "—",
                "Generated At": datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S %Z"),
            }

            # Derive base table name (same logic as CORE failed-rows endpoints)
            base_name = _rule_table_name(rule_id, rule_title)
            if delta_mode:
                base_name = f"DELTA_{base_name}"

            core_fq = bdc_config_manager.stg_table(to_stg_table) if to_stg_table else bdc_config_manager.core_table(base_name)

            # ── Step 2: resolve STG table ─────────────────────────────────────
            yield _sse({"step": 2, "total": 5, "pct": 20, "label": "Locating historical run…"})
            await asyncio.sleep(0)

            snapshots = await asyncio.get_event_loop().run_in_executor(
                None, lambda: _rule_snapshots(sf, database, base_name)
            )
            stg_names = [r[0] for r in snapshots]
            try:
                _check_snapshot(to_stg_table, snapshots)
                _check_snapshot(stg_table, snapshots)
            except HTTPException as e:
                yield _sse({"type": "error", "message": str(e.detail)})
                return

            if stg_table:
                # Advanced mode: caller specified an explicit STG table
                stg_table_name = stg_table
                stg_fq = bdc_config_manager.stg_table(stg_table_name)
            else:
                # Default mode: the run before the latest one
                try:
                    if to_stg_table:
                        older = stg_names[stg_names.index(to_stg_table) + 1:]
                        if not older:
                            raise HTTPException(status_code=404, detail="There is no earlier run than the one picked.")
                        stg_table_name = older[0]
                    else:
                        stg_table_name = await asyncio.get_event_loop().run_in_executor(
                            None, lambda: _default_from_snapshot(sf, core_fq, stg_names))
                except HTTPException as e:
                    yield _sse({"type": "error", "message": str(e.detail)})
                    return
                stg_fq = bdc_config_manager.stg_table(stg_table_name)

            rule_meta["CORE Table (Current Run)"] = to_stg_table or base_name
            rule_meta["STG Table (Previous Run)"] = stg_table_name

            # Parse run dates from STG table name suffixes (format: YYYYMMDD_HHMMSS)
            import re as _re
            from datetime import datetime as _dt

            def _parse_stg_date(table_name):
                m = _re.search(r"(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$", table_name)
                if not m:
                    return table_name
                yr, mo, dy, hh, mm, ss = m.groups()
                # the engine names snapshots in UTC
                ts = pytz.utc.localize(_dt(int(yr), int(mo), int(dy), int(hh), int(mm), int(ss)))
                return ts.astimezone(EASTERN).strftime("%b %d, %Y  %H:%M:%S %Z")

            rule_meta["From Run Date (Previous)"] = _parse_stg_date(stg_table_name)

            if to_stg_table:
                rule_meta["To Run Date (Latest)"] = _parse_stg_date(to_stg_table)
            elif stg_table:
                rule_meta["To Run Date (Latest)"] = _parse_stg_date(stg_names[0]) if stg_names else "Latest run"
            else:
                rule_meta["To Run Date (Latest)"] = _parse_stg_date(stg_names[0])

            # ── Step 3: fetch both tables ─────────────────────────────────────
            yield _sse({"step": 3, "total": 5, "pct": 40, "label": "Fetching runs data…"})
            await asyncio.sleep(0)

            try:
                frames = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: _delta_frames(sf, core_fq, stg_fq)
                )
            except HTTPException as e:
                yield _sse({"type": "error", "message": str(e.detail)})
                return

            # ── Step 4: compute delta ─────────────────────────────────────────
            yield _sse({"step": 4, "total": 5, "pct": 60, "label": "Computing delta…"})
            await asyncio.sleep(0)

            df_new = frames["sheets"]["new_failures"]
            df_res = frames["sheets"]["resolved_rows"]
            df_keep = frames["sheets"]["persisting_rows"]

            rule_meta["Total CORE Rows"] = f"{frames['core_rows']:,}"
            rule_meta["Total STG Rows (Previous Run)"] = f"{frames['stg_rows']:,}"
            rule_meta["New Failures (in CORE, not in STG)"] = f"{len(df_new):,}"
            rule_meta["Resolved Rows (in STG, not in CORE)"] = f"{len(df_res):,}"
            rule_meta["Persisting Failures (in both runs)"] = f"{len(df_keep):,}"

            # ── Step 5: build Excel ───────────────────────────────────────────
            yield _sse({
                "step": 5, "total": 5, "pct": 75,
                "label": f"Building Excel ({len(df_new):,} new failures, {len(df_res):,} resolved)…"
            })
            await asyncio.sleep(0)

            buf = _io.BytesIO()
            workbook = xlsxwriter.Workbook(buf, {"in_memory": True, "constant_memory": False})

            # ── Formats ───────────────────────────────────────────────────────
            def _fmt(**kw):
                return workbook.add_format({"font_name": "Calibri", "font_size": 10, "border": 1, **kw})

            title_fmt = _fmt(bold=True, font_size=16, bg_color="#312C2A", font_color="#FFFFFF", border=0, align="left",
                             valign="vcenter")
            section_fmt = _fmt(bold=True, font_size=11, bg_color="#0F68B2", font_color="#FFFFFF", border=0,
                               align="left", valign="vcenter")
            label_fmt = _fmt(bold=True, bg_color="#E8E6E3", font_color="#312C2A", valign="top")
            value_fmt = _fmt(bg_color="#FFFFFF", font_color="#312C2A", valign="top", text_wrap=True)
            meta_fmt = _fmt(italic=True, font_size=9, bg_color="#FAFAFA", font_color="#81766F")

            new_hdr_fmt = _fmt(bold=True, bg_color="#E8E6E3", font_color="#312C2A", align="center")
            res_hdr_fmt = _fmt(bold=True, bg_color="#E8E6E3", font_color="#312C2A", align="center")
            plain_fmt = _fmt(bg_color="#FFFFFF", font_color="#9CA3AF", italic=True)

            # Date-diff color formats — cell-level only (matching UI behaviour)
            base_props = {"border": 1, "font_name": "Calibri", "font_size": 10}
            fmt_green = workbook.add_format(
                {**base_props, "bg_color": "#DCFCE7", "left": 2, "left_color": "#328714"})  # ≤ 7 days
            fmt_yellow = workbook.add_format(
                {**base_props, "bg_color": "#FEF9C3", "left": 2, "left_color": "#CA8A04"})  # 8–15 days
            fmt_red_row = workbook.add_format(
                {**base_props, "bg_color": "#FEE2E2", "left": 2, "left_color": "#EB1700"})  # ≥ 16 days
            fmt_plain = workbook.add_format({**base_props})  # no date cols
            hdr_color_fmt = workbook.add_format({
                "bold": True, "bg_color": "#D1FAE5", "border": 1,
                "font_name": "Calibri", "font_size": 10, "align": "center",
                "left": 2, "left_color": "#328714"
            })

            # ── Dashboard sheet ───────────────────────────────────────────────
            dash = workbook.add_worksheet("Dashboard")
            dash.set_column(0, 0, 38)
            dash.set_column(1, 1, 58)
            dash.set_column(3, 3, 22)  # Sheet Guide — label col
            dash.set_column(4, 4, 52)  # Sheet Guide — description col

            dash.set_row(0, 36)
            dash.merge_range(0, 0, 0, 1, f"  Delta Report — {rule_meta['Dataset Title']}", title_fmt)
            dash.set_row(1, 4)  # spacer
            dash.set_row(2, 20)
            dash.merge_range(2, 0, 2, 1, "  Rule Information", section_fmt)

            # ── Sheet Guide (columns D–E, starting at row 2) ──────────────────
            guide_title_fmt = _fmt(bold=True, font_size=11, bg_color="#312C2A", font_color="#FFFFFF",
                                   border=0, align="left", valign="vcenter")
            guide_hdr_fmt = _fmt(bold=True, bg_color="#E8E6E3", font_color="#312C2A",
                                 align="left", valign="vcenter")
            guide_dash_fmt = _fmt(bg_color="#F8F8F8", font_color="#312C2A", valign="top", text_wrap=True)
            guide_new_fmt = _fmt(bg_color="#F8F8F8", font_color="#312C2A", valign="top", text_wrap=True)
            guide_res_fmt = _fmt(bg_color="#DCFCE7", font_color="#312C2A", valign="top", text_wrap=True)

            dash.set_row(2, 20)
            dash.merge_range(2, 3, 2, 4, "  Sheet Guide", guide_title_fmt)

            dash.set_row(3, 16)
            dash.write(3, 3, "Sheet Name", guide_hdr_fmt)
            dash.write(3, 4, "Description", guide_hdr_fmt)

            sheet_guide = [
                ("Dashboard", guide_dash_fmt,
                 "Rule metadata, delta summary counts, and this sheet guide."),
                ("New Failures", guide_new_fmt,
                 "Failures that appeared since the last execution."),
                ("Resolved Failures", guide_res_fmt,
                 "Failures that have been resolved or dropped since the last execution."),
                ("Persisting Failures", guide_new_fmt,
                 "Failures present in both runs, still open since the last execution."),
            ]

            rule_fields = [
                ("Rule ID", rule_meta["Rule ID"]),
                ("Rule Title", rule_meta["Rule Title"]),
                ("Description", rule_meta["Description"]),
                ("Target Table", rule_meta["Target Table"]),
                ("Pass Rate", rule_meta["Pass Rate"]),
                ("Status", rule_meta["Status"]),
            ]

            # Build a height map: row → max height needed across both col B and col E
            # Sheet guide rows start at 4, rule_fields rows start at 3 — they overlap at rows 4-6
            row_heights = {}
            for i, (lbl, val) in enumerate(rule_fields):
                r = i + 3
                lines_b = max(1, -(-len(str(val)) // 58))
                row_heights[r] = max(row_heights.get(r, 18), lines_b * 15)
            for i, (name, fmt, desc) in enumerate(sheet_guide):
                r = 4 + i
                lines_e = max(1, -(-len(desc) // 52))
                row_heights[r] = max(row_heights.get(r, 18), lines_e * 15)

            # Apply all row heights first, then write cells
            for r, h in row_heights.items():
                dash.set_row(r, max(18, h))

            for i, (name, fmt, desc) in enumerate(sheet_guide):
                r = 4 + i
                dash.write(r, 3, name, fmt)
                dash.write(r, 4, desc, fmt)

            for i, (lbl, val) in enumerate(rule_fields):
                r = i + 3
                dash.write(r, 0, lbl, label_fmt)
                dash.write(r, 1, val, value_fmt)

            sep = len(rule_fields) + 4
            dash.set_row(sep, 4)  # spacer
            dash.set_row(sep + 1, 20)
            dash.merge_range(sep + 1, 0, sep + 1, 1, "  Delta Summary", section_fmt)

            delta_fields = [
                ("From Run Date (Previous)", rule_meta["From Run Date (Previous)"]),
                ("To Run Date (Latest)",     rule_meta["To Run Date (Latest)"]),
                ("Previous Run Row Count",   rule_meta["Total STG Rows (Previous Run)"]),
                ("Latest Run Row Count",     rule_meta["Total CORE Rows"]),
                ("New Failures",             rule_meta["New Failures (in CORE, not in STG)"]),
                ("Resolved Failures",        rule_meta["Resolved Rows (in STG, not in CORE)"]),
                ("Persisting Failures",      rule_meta["Persisting Failures (in both runs)"]),
            ]
            for i, (lbl, val) in enumerate(delta_fields):
                r = sep + 2 + i
                lines = max(1, -(-len(str(val)) // 58))
                dash.set_row(r, max(18, lines * 15))
                dash.write(r, 0, lbl, label_fmt)
                dash.write(r, 1, val, value_fmt)

            footer_r = sep + 2 + len(delta_fields) + 1
            dash.merge_range(
                footer_r, 0, footer_r, 1,
                f"  Generated by GRA-SmartHub  ·  {rule_meta['Generated At']}",
                meta_fmt
            )

            # ── Helper: write a data sheet ────────────────────────────────────
            def _day_diff(v1, v2):
                try:
                    d1, d2 = _pd.Timestamp(v1), _pd.Timestamp(v2)
                    if _pd.isna(d1) or _pd.isna(d2):
                        return None
                    return abs((d1.normalize() - d2.normalize()).days)  # calendar days, like DATEDIFF
                except Exception:
                    return None

            _SEV_FMT = {_dcr.GREEN: fmt_green, _dcr.YELLOW: fmt_yellow, _dcr.RED: fmt_red_row}
            _SEV_HEX = {_dcr.GREEN: "#DCFCE7", _dcr.YELLOW: "#FEF9C3", _dcr.RED: "#FEE2E2"}
            sheet_gradients = {}  # sheet name -> { (row, col): [hex, ...] }

            def _write_sheet(ws_name, df, hdr_fmt, empty_msg):
                ws = workbook.add_worksheet(ws_name)
                cols = list(df.columns) if not df.empty else []

                if df.empty:
                    ws.merge_range(0, 0, 0, 5, empty_msg, plain_fmt)
                    return

                stripped = [c.strip() for c in cols]
                created_idx = stripped.index(
                    delta_color_col1) if delta_color_col1 and delta_color_col1 in stripped else -1
                approved_idx = stripped.index(
                    delta_color_col2) if delta_color_col2 and delta_color_col2 in stripped else -1
                has_dates = created_idx != -1 and approved_idx != -1

                # Hardcoded DIFFERENCE_* rules — layered on top of COLOR_COLUMNS
                dcr_col_index = _dcr.build_col_index(cols)
                dcr_rules = _dcr.active_rules(dcr_col_index)
                dcr_targets = _dcr.target_col_indices(dcr_col_index)
                gradient_cells = {}

                # Write header row — highlight the two color columns
                for c, col_name in enumerate(cols):
                    is_color_col = (has_dates and c in (created_idx, approved_idx)) or c in dcr_targets
                    ws.write(0, c, col_name, hdr_color_fmt if is_color_col else hdr_fmt)

                for r, row_vals in enumerate(df.itertuples(index=False), start=1):
                    row_list = list(row_vals)

                    sev_accum = {}
                    if has_dates:
                        days = _day_diff(row_list[created_idx], row_list[approved_idx])
                        sev = (_dcr.RED if days is None
                               else _dcr.GREEN if days <= 7
                               else _dcr.YELLOW if days <= 15 else _dcr.RED)
                        sev_accum[created_idx] = [sev]
                        sev_accum[approved_idx] = [sev]
                    if dcr_rules:
                        _dcr.accumulate(row_list, dcr_col_index, sev_accum, dcr_rules)

                    cell_fmts = {}
                    for ci, sevs in sev_accum.items():
                        unique = list(dict.fromkeys(sevs))
                        worst = max(unique, key=lambda s: _dcr.SEVERITY_RANK[s])
                        cell_fmts[ci] = _SEV_FMT[worst]
                        if len(unique) > 1:
                            ordered = sorted(unique, key=lambda s: -_dcr.SEVERITY_RANK[s])
                            gradient_cells[(r + 1, ci + 1)] = [_SEV_HEX[s] for s in ordered]

                    for c, val in enumerate(row_list):
                        fmt = cell_fmts.get(c, fmt_plain)
                        if not isinstance(val, str) and _pd.isna(val):
                            ws.write(r, c, "", fmt)
                        else:
                            ws.write(r, c, val, fmt)

                if gradient_cells:
                    sheet_gradients[ws_name] = gradient_cells

            # Row-by-row writing is slow on big runs; keep it off the event loop
            # so the rest of the API stays responsive meanwhile.
            loop = asyncio.get_event_loop()
            sheets = (
                ("New Failures", df_new, new_hdr_fmt,
                 "No new failures — no failures appeared since the last execution."),
                ("Resolved Failures", df_res, res_hdr_fmt,
                 "No resolved rows — no failures have been resolved or dropped since the last execution."),
                ("Persisting Failures", df_keep, new_hdr_fmt,
                 "No persisting rows — every earlier failure was resolved."),
            )
            for n, args in enumerate(sheets, start=1):
                await loop.run_in_executor(None, lambda a=args: _write_sheet(*a))
                yield _sse({"step": 5, "total": 5, "pct": 75 + 5 * n, "label": f"Wrote {args[0]}…"})

            await loop.run_in_executor(None, workbook.close)
            buf.seek(0)
            file_bytes = await asyncio.get_event_loop().run_in_executor(
                None, lambda: apply_excel_type_formatting(buf)
            )
            if sheet_gradients:
                file_bytes = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: apply_gradient_fills(file_bytes, sheet_gradients)
                )

            token = str(uuid.uuid4())
            _delta_cache[token] = file_bytes

            yield _sse({
                "type": "ready",
                "pct": 100,
                "token": token,
                "filename": f"{rule_id}_delta_report.xlsx",
                "size": len(file_bytes),
                "new_failures": len(df_new),
                "resolved": len(df_res),
                "persisting": len(df_keep),
            })

        except Exception as e:
            logger.error(f"Delta report error for {rule_id}: {e}")
            yield _sse({"type": "error", "message": f"Unexpected error: {str(e)}"})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/rules/{rule_id}/download-delta")
def fetch_delta_download(rule_id: str, token: str = Query(...), auth: dict = Depends(require_bdc_rule_download)):
    """
    One-time endpoint: returns the cached delta XLSX for the given token and removes it.
    """
    file_bytes = _delta_cache.pop(token, None)
    if file_bytes is None:
        raise HTTPException(status_code=404, detail="Delta download token not found or already used.")

    filename = f"{rule_id}_delta_report.xlsx"
    return StreamingResponse(
        BytesIO(file_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(file_bytes)),
        }
    )


# ============================================================================
# RBAC (Role-Based Access Control)
# ============================================================================

# Stored in smarthub_core (rbac_custom_roles, rbac_user_overrides,
# rbac_user_permissions, rbac_meta). The legacy JSON file is read once to seed
# an empty database, then renamed so nothing is silently lost.
RBAC_LEGACY_JSON = Path(__file__).parent / "rbac_config.json"

# Every writer takes this advisory lock first, so two admins saving at once
# (on any worker or replica) queue instead of one overwriting the other.
_RBAC_LOCK = "rbac-config"


class RBACConfig(BaseModel):
    custom_roles: Dict[str, Any] = {}
    user_roles: Dict[str, Any] = {}
    user_role_overrides: Dict[str, str] = {}
    user_permission_overrides: Dict[str, Any] = {}
    last_modified: str = ""
    modified_by: str = ""


def _read_config(conn) -> dict:
    """Reassemble the config dict from its tables + the meta row, matching
    the exact shape the old JSON file returned so auth.py and the endpoints
    don't need to know the storage changed. One statement: a single round
    trip, and the four tables are read from the same snapshot."""
    rows = conn.execute("""
        SELECT 'role' AS kind, role_id AS k, definition::text AS a, NULL::text AS b, NULL::boolean AS c,
               NULL::text AS d
          FROM rbac_custom_roles
        UNION ALL
        SELECT 'user', email, role_name, roles::text, keep_ad, NULL FROM rbac_user_overrides
        UNION ALL
        SELECT 'perm', email, grants::text, revokes::text, NULL, datasets::text FROM rbac_user_permissions
        UNION ALL
        SELECT 'meta', key, value, NULL, NULL, NULL FROM rbac_meta
        ORDER BY 1, 2
    """).fetchall()

    custom_roles: Dict[str, Any] = {}
    user_roles: Dict[str, Any] = {}
    permission_overrides: Dict[str, Any] = {}
    meta: Dict[str, Any] = {}
    for row in rows:
        kind, key = row["kind"], row["k"]
        if kind == "role":
            try:
                custom_roles[key] = json.loads(row["a"])
            except (json.JSONDecodeError, TypeError):
                logger.error(f"Corrupt RBAC role definition for '{key}' — skipping")
        elif kind == "user":
            # Hand-given roles: {"roles": [...], "keep_ad": bool}. role_name
            # keeps the first one so an older build reading this table works.
            try:
                roles = json.loads(row["b"]) if row["b"] else [row["a"]]
            except (json.JSONDecodeError, TypeError):
                roles = [row["a"]]
            if not isinstance(roles, list):
                roles = [row["a"]]
            roles = [r for r in roles if isinstance(r, str) and r]
            if roles:
                user_roles[key] = {"roles": roles, "keep_ad": bool(row["c"])}
        elif kind == "perm":
            # Per-user custom access on top of the role: {"add": [...], "remove": [...]}
            try:
                permission_overrides[key] = {
                    "add": json.loads(row["a"] or "[]"),
                    "remove": json.loads(row["b"] or "[]"),
                    "datasets": json.loads(row["d"] or "[]"),
                }
            except (json.JSONDecodeError, TypeError):
                logger.error(f"Corrupt custom access for '{key}' — skipping")
        else:
            meta[key] = row["a"]

    overrides: Dict[str, str] = {email: primary_role(e["roles"]) for email, e in user_roles.items()}
    return {
        "custom_roles": custom_roles,
        "user_roles": user_roles,
        # One role per person, kept for older readers (assistant, old pages)
        "user_role_overrides": overrides,
        "user_permission_overrides": permission_overrides,
        "last_modified": meta.get("last_modified", ""),
        "modified_by": meta.get("modified_by", ""),
    }


def _write_config(conn, config: dict, modified_by: str) -> None:
    """Persist the full config inside the caller's open transaction. Replaces
    the table contents wholesale — the same 'the dict is the source of truth'
    semantics the JSON version had, just transactional."""
    custom_roles = config.get("custom_roles") or {}
    # user_roles is the source of truth; a config without it (legacy JSON)
    # is read from the one-role map, with the AD role ignored like before
    if "user_roles" in config:
        user_roles = config.get("user_roles") or {}
    else:
        user_roles = {e: {"roles": [r], "keep_ad": False}
                      for e, r in (config.get("user_role_overrides") or {}).items() if r}

    conn.execute("DELETE FROM rbac_custom_roles")
    conn.executemany(
        "INSERT INTO rbac_custom_roles (role_id, definition) VALUES (?, ?)",
        [(rid, json.dumps(defn)) for rid, defn in custom_roles.items()],
    )

    conn.execute("DELETE FROM rbac_user_overrides")
    conn.executemany(
        "INSERT INTO rbac_user_overrides (email, role_name, roles, keep_ad) VALUES (?, ?, ?, ?)",
        [
            (email, primary_role(e["roles"]), json.dumps(e["roles"]), bool(e.get("keep_ad")))
            for email, e in user_roles.items()
            if e.get("roles")
        ],
    )

    permission_overrides = config.get("user_permission_overrides") or {}
    conn.execute("DELETE FROM rbac_user_permissions")
    conn.executemany(
        "INSERT INTO rbac_user_permissions (email, grants, revokes, datasets) VALUES (?, ?, ?, ?)",
        [
            (email, json.dumps(entry.get("add") or []), json.dumps(entry.get("remove") or []),
             json.dumps(entry.get("datasets") or []))
            for email, entry in permission_overrides.items()
            if entry.get("add") or entry.get("remove") or entry.get("datasets")
        ],
    )

    now = datetime.now(EASTERN).isoformat()
    conn.executemany(
        "INSERT INTO rbac_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [("last_modified", now), ("modified_by", modified_by)],
    )


def _init_rbac_db() -> None:
    """Startup housekeeping. Runs under the RBAC lock so several workers
    booting together do it once, not once each."""
    # The default role was renamed Viewer -> No access. A customised copy
    # saved under the old name follows the rename; any other name an admin
    # chose is left alone.
    with db.transaction() as conn:
        db.advisory_xact_lock(conn, _RBAC_LOCK, timeout_ms=30000)
        row = conn.execute(
            "SELECT definition FROM rbac_custom_roles WHERE role_id = 'viewer' FOR UPDATE"
        ).fetchone()
        if row:
            try:
                definition = json.loads(row["definition"])
                if isinstance(definition, dict) and definition.get("name") == "Viewer":
                    definition["name"] = "No access"
                    conn.execute("UPDATE rbac_custom_roles SET definition = ? WHERE role_id = 'viewer'",
                                 (json.dumps(definition),))
            except (json.JSONDecodeError, TypeError):
                pass

    # One-time seed: only into an empty database, only if the old file exists.
    if not RBAC_LEGACY_JSON.exists():
        return
    try:
        with open(RBAC_LEGACY_JSON, "r") as f:
            legacy = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.error(f"RBAC legacy file unreadable, not migrating it: {e}")
        return
    seeded = False
    try:
        with db.transaction() as conn:
            db.advisory_xact_lock(conn, _RBAC_LOCK, timeout_ms=30000)
            if conn.execute("SELECT 1 FROM rbac_meta LIMIT 1").fetchone():
                return
            _write_config(conn, legacy, legacy.get("modified_by") or "migration")
            seeded = True
    except Exception as e:
        logger.error(f"RBAC migration from JSON failed — starting empty: {e}")
        return
    if seeded:
        try:
            RBAC_LEGACY_JSON.rename(RBAC_LEGACY_JSON.with_suffix(".json.migrated"))
        except OSError as e:
            logger.warning(f"Seeded RBAC from rbac_config.json but could not rename it: {e}")
        logger.info(
            "Migrated rbac_config.json into the database "
            f"({len(legacy.get('custom_roles') or {})} custom roles, "
            f"{len(legacy.get('user_role_overrides') or {})} overrides)"
        )


# The portal still comes up without its database (plenty of pages don't need
# it); everything that does answers 503 until it's back, and the schema check
# runs again on first use.
try:
    _init_rbac_db()
except Exception as _e:
    logger.error(f"RBAC startup housekeeping skipped - database not ready: {type(_e).__name__}: {_e}")


# auth.py asks for this on every authenticated request, from the event loop,
# so the database is kept off that path almost entirely:
#   - under RBAC_CONFIG_TTL_SECONDS old: served from memory;
#   - older than that: still served from memory, while one background thread
#     re-reads it (stale-while-revalidate), so no request waits on the network;
#   - only with nothing cached, or a copy older than RBAC_CONFIG_MAX_STALE_SECONDS
#     (refreshes failing), does a request read it itself.
# Writes in this process drop the copy at once (rbac_mutation); other workers
# pick a change up within a few seconds, well inside auth.py's 60s role cache.
RBAC_CONFIG_TTL_SECONDS = 5
RBAC_CONFIG_MAX_STALE_SECONDS = 60
_rbac_cached: Dict[str, Any] = {"config": None, "at": 0.0, "generation": 0, "refreshing": False}
_rbac_cache_lock = threading.Lock()

_RBAC_FAIL_CLOSED = {"custom_roles": {}, "user_roles": {}, "user_role_overrides": {},
                     "user_permission_overrides": {}, "last_modified": "", "modified_by": ""}


def _drop_rbac_config_cache() -> None:
    # Bumping the generation also stops a read that started before the write
    # committed from putting its (older) copy back afterwards.
    with _rbac_cache_lock:
        _rbac_cached["config"] = None
        _rbac_cached["generation"] += 1


def _fetch_rbac_config(generation: int) -> dict:
    with db.transaction(read_only=True) as conn:
        config = _read_config(conn)
    with _rbac_cache_lock:
        if _rbac_cached["generation"] == generation:
            _rbac_cached["config"], _rbac_cached["at"] = config, time.monotonic()
    return config


def _refresh_rbac_config(generation: int) -> None:
    try:
        _fetch_rbac_config(generation)
    except Exception as e:
        logger.warning(f"Background RBAC refresh failed, serving the last copy: {type(e).__name__}: {e}")
    finally:
        with _rbac_cache_lock:
            _rbac_cached["refreshing"] = False


def load_rbac_config() -> dict:
    """Load RBAC configuration. Read-only; safe to call concurrently. Hands
    back a private copy, so a caller can't change what the next one sees."""
    with _rbac_cache_lock:
        cached, at, generation = _rbac_cached["config"], _rbac_cached["at"], _rbac_cached["generation"]
        age = time.monotonic() - at
        start_refresh = (cached is not None and RBAC_CONFIG_TTL_SECONDS <= age < RBAC_CONFIG_MAX_STALE_SECONDS
                         and not _rbac_cached["refreshing"])
        if start_refresh:
            _rbac_cached["refreshing"] = True
    if cached is not None and age < RBAC_CONFIG_MAX_STALE_SECONDS:
        if start_refresh:
            threading.Thread(target=_refresh_rbac_config, args=(generation,),
                             name="rbac-refresh", daemon=True).start()
        return copy.deepcopy(cached)
    try:
        return copy.deepcopy(_fetch_rbac_config(generation))
    except Exception as e:
        logger.error(f"Error loading RBAC config: {e}")
        # Fail closed — no custom roles, no overrides. Callers fall back to AD
        # group / 'viewer', never to elevated access.
        return copy.deepcopy(_RBAC_FAIL_CLOSED)


# auth.py resolves roles/permissions through this loader. Wiring it here (rather
# than importing app.py from auth.py) keeps the dependency direction one-way.
set_rbac_config_loader(load_rbac_config)


@contextmanager
def rbac_mutation(modified_by: str = "system"):
    """Atomic read-modify-write of the RBAC config.

    Takes the RBAC advisory lock for the length of one transaction, hands the
    caller the *current* config to mutate in place, then persists and commits
    it. Two admins editing at the same time — on any worker — serialize
    instead of clobbering each other, and a crash or a raised HTTPException
    mid-edit rolls back cleanly rather than leaving a half-written config.
    Role caches are dropped on success so changes take effect immediately
    instead of after the cache TTL.

        with rbac_mutation(modified_by=user_email) as config:
            config["custom_roles"][role_id] = role_definition
    """
    with db.transaction() as conn:
        db.advisory_xact_lock(conn, _RBAC_LOCK, timeout_ms=15000)
        config = _read_config(conn)
        yield config
        _write_config(conn, config, modified_by)
    # Only reached on a clean commit (exceptions re-raise above and skip this).
    _drop_rbac_config_cache()
    invalidate_role_cache()
    logger.info(f"RBAC config updated by {modified_by}")


BUILTIN_ROLE_IDS = tuple(BUILTIN_ROLES.keys())

# What someone needs to keep working on the User Management page.
_USER_MANAGEMENT_PERMISSIONS = ("viewUserManagement", "manageUsers", "manageRoles")


def _guard_self_lockout(config: dict, auth: dict) -> None:
    """Call inside rbac_mutation after the change is made to `config` and
    before it is saved. Refuses a change that would take away any User
    Management permission the caller holds right now, whether it comes
    through their role assignment, a role edit, a role delete or their own
    custom access. Raising here rolls the whole change back."""
    email = (auth["user"].get("email") or "").lower()
    if not email:
        return
    after = effective_permissions_from_config(email, auth.get("groups"), config)
    lost = [p for p in _USER_MANAGEMENT_PERMISSIONS if auth["permissions"].get(p) is True and after.get(p) is not True]
    if lost:
        raise HTTPException(
            status_code=400,
            detail=f"This change would take away your own access ({', '.join(map(_permission_label, lost))}). "
                   "Ask another administrator to make it.",
        )


def _is_admin(auth: dict) -> bool:
    """Admins can hand out anything, even what their own (edited) role lacks."""
    return "admin" in (auth.get("roles") or [auth.get("role")]) and not auth.get("is_api_key")


def _guard_escalation(auth: dict, granting) -> None:
    """Nobody but an admin can hand out a permission they don't hold
    themselves, so a 'Manage Users' holder can't make themselves (or a
    friend) an admin."""
    if _is_admin(auth):
        return
    missing = sorted({p for p in granting if auth["permissions"].get(p) is not True})
    if missing:
        shown = ", ".join(map(_permission_label, missing[:4]))
        more = f" and {len(missing) - 4} more" if len(missing) > 4 else ""
        raise HTTPException(
            status_code=403,
            detail=f"You can't grant access you don't have yourself: {shown}{more}",
        )


def _guard_datasets(auth: dict, granting) -> None:
    """Same rule for BDC datasets: only hand out ones you can see yourself."""
    if not granting or _is_admin(auth):
        return
    mine = bdc_datasets(auth)
    if mine is None:
        return
    missing = sorted(set(granting) - mine)
    if missing:
        raise HTTPException(status_code=403,
                            detail=f"You can't grant BDC datasets you don't have yourself: {', '.join(missing[:4])}")


def _true_keys(perms: Dict[str, Any]) -> set:
    return {k for k, v in (perms or {}).items() if v is True}


async def _groups_for(auth: dict, emails) -> Optional[Dict[str, list]]:
    """AD groups of the people a change touches, read with the caller's token.
    None when the caller holds every permission: nothing they do can hand out
    more than they have, so there's no need to look."""
    emails = sorted({(e or "").lower() for e in emails if e})
    if _is_admin(auth) or holds_everything(auth["permissions"]) or not emails:
        return None
    token = auth.get("token")
    if not token:
        raise HTTPException(status_code=403, detail="This change needs a signed-in administrator")
    sem = asyncio.Semaphore(8)

    async def one(email):
        async with sem:
            return email, await asyncio.to_thread(fetch_user_groups, token, email)

    try:
        return dict(await asyncio.gather(*(one(e) for e in emails)))
    except Exception as e:
        logger.warning(f"Couldn't read AD groups to check a change: {e}")
        raise HTTPException(status_code=503, detail="Couldn't check the directory to confirm this change. Try again.")


def _guard_target_gain(auth: dict, groups_by_email: Optional[Dict[str, list]], before: dict, after: dict) -> None:
    """Whatever a change newly gives someone (a role coming back from their AD
    group, a removal undone) has to be something the caller holds too."""
    if groups_by_email is None:
        return
    gained = set()
    for email, groups in groups_by_email.items():
        was = effective_permissions_from_config(email, groups, before)
        now = effective_permissions_from_config(email, groups, after)
        gained |= {p for p, v in now.items() if v is True and was.get(p) is not True}
    _guard_escalation(auth, gained)


@app.get("/api/rbac/config")
def get_rbac_config(auth: dict = Depends(require_auth)):
    """Get complete RBAC configuration"""
    try:
        config = load_rbac_config()
        # Who holds which role is only for people who can open User Management,
        # plus Communication Center senders (its recipient picker lists people
        # by role). Custom access stays User Management only. Everyone else
        # gets just their own entries.
        held = auth["permissions"]
        me = (auth["user"].get("email") or "").lower()
        if held.get("viewUserManagement") is not True:
            own_role = (config.get("user_role_overrides") or {}).get(me)
            own_roles = (config.get("user_roles") or {}).get(me)
            own_access = (config.get("user_permission_overrides") or {}).get(me)
            senders = held.get("sendCommunications") is True
            config = {
                **config,
                "user_role_overrides": (config.get("user_role_overrides") or {}) if senders
                else ({me: own_role} if own_role else {}),
                "user_roles": (config.get("user_roles") or {}) if senders
                else ({me: own_roles} if own_roles else {}),
                "user_permission_overrides": {me: own_access} if own_access else {},
                "modified_by": "",
            }
        # Include the canonical built-in definitions so the frontend renders
        # from the same source the backend enforces against.
        # Same merge as get_all_roles(), from the config already read above
        merged_roles = {rid: dict(rdef) for rid, rdef in BUILTIN_ROLES.items()}
        merged_roles.update(config.get("custom_roles") or {})
        config = {**config, "builtin_roles": merged_roles}
        # Untouched defaults, so the page can show what "Reset to default" would
        # bring back and fall back to them once a customised built-in is reset.
        config["builtin_defaults"] = BUILTIN_ROLES
        # The page maps groups with the same list the API enforces with, so
        # the two can't drift apart through separate env files
        if held.get("viewUserManagement") is True:
            config["ad_groups"] = dict(AD_GROUP_ROLES)
        return {"success": True, "config": config, "caller_role": auth["role"],
                "caller_roles": auth.get("roles") or [auth["role"]],
                "caller_permissions": auth["permissions"]}
    except Exception as e:
        logger.error(f"Error fetching RBAC config: {e}")
        raise HTTPException(status_code=500, detail="Could not load the access configuration")


@app.get("/api/rbac/bdc-datasets")
def get_bdc_dataset_options(auth: dict = Depends(require_permission("viewUserManagement"))):
    """DATASET_TITLEs from DQ_RULE_INPUT, for the dataset pickers on User Management."""
    try:
        return {"success": True, "datasets": list_datasets()}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Could not list BDC datasets: {e}")
        raise HTTPException(status_code=503, detail="Could not read the dataset list from Snowflake")


@app.post("/api/rbac/roles")
def create_custom_role(
        role_data: Dict[str, Any] = Body(...),
        auth: dict = Depends(require_permission("manageRoles")),
):
    """Create a new custom role"""
    user_email = auth["user"]["email"]
    try:
        role_id = role_data.get('role_id')
        if not isinstance(role_id, str) or not ROLE_ID_PATTERN.match(role_id):
            raise HTTPException(status_code=400, detail="Role ID must be 1-64 lowercase letters, numbers or underscores")
        if role_id in BUILTIN_ROLE_IDS:
            raise HTTPException(status_code=400, detail="That role ID belongs to a built-in role")
        try:
            role_definition = validate_role_definition(role_data.get('role_definition'))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        _guard_escalation(auth, _true_keys(role_definition["permissions"]))
        _guard_datasets(auth, role_definition["bdc_datasets"])

        with rbac_mutation(modified_by=user_email) as config:
            if role_id in config.get("custom_roles", {}):
                raise HTTPException(status_code=400, detail="Role ID already exists")
            config.setdefault("custom_roles", {})[role_id] = role_definition

        write_audit_event(
            action="role_created",
            performed_by=user_email,
            target=role_id,
            details=f"Created custom role '{role_definition.get('name', role_id)}'",
        )

        logger.info(f"Custom role created: {role_id} by {user_email}")

        return {"success": True, "message": "Custom role created successfully", "role_id": role_id,
                "role": role_definition}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating custom role: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/rbac/roles/{role_id}")
def update_custom_role(
        role_id: str,
        role_definition: Dict[str, Any] = Body(...),
        auth: dict = Depends(require_permission("manageRoles")),
):
    """Update an existing custom role or modify a built-in role"""
    user_email = auth["user"]["email"]
    try:
        # Left out: the role keeps the datasets it has
        keep_datasets = isinstance(role_definition, dict) and "bdc_datasets" not in role_definition
        try:
            role_definition = validate_role_definition(role_definition)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        with rbac_mutation(modified_by=user_email) as config:
            # Check if role exists (either in custom_roles or is a valid built-in role)
            role_exists = role_id in config.get("custom_roles", {}) or role_id in BUILTIN_ROLE_IDS
            if not role_exists:
                raise HTTPException(status_code=404, detail="Role not found")

            previous = config.get("custom_roles", {}).get(role_id) or BUILTIN_ROLES.get(role_id, {})
            previous_perms = get_role_permissions(role_id, config)
            _guard_escalation(auth, _true_keys(role_definition["permissions"]) - _true_keys(previous_perms))
            previous_datasets = get_role_datasets(role_id, config)
            if keep_datasets:
                role_definition["bdc_datasets"] = previous_datasets
            _guard_datasets(auth, set(role_definition["bdc_datasets"]) - set(previous_datasets))

            # Update/create the role in custom_roles (this overrides built-in definitions)
            config.setdefault("custom_roles", {})[role_id] = role_definition
            _guard_self_lockout(config, auth)

        # Build human-readable diff
        changes = []

        # Name change
        old_name = previous.get('name', '')
        new_name = role_definition.get('name', '')
        if old_name and old_name != new_name:
            changes.append(f"Name: '{old_name}' → '{new_name}'")

        # Description change
        old_desc = previous.get('description', '')
        new_desc = role_definition.get('description', '')
        if old_desc != new_desc:
            changes.append(f"Description changed")

        # Color change
        old_color = previous.get('color', '')
        new_color = role_definition.get('color', '')
        if old_color and old_color != new_color:
            changes.append(f"Color: '{old_color}' → '{new_color}'")

        # Permission changes
        old_perms = previous_perms
        new_perms = role_definition.get('permissions', {})
        all_perm_keys = set(list(old_perms.keys()) + list(new_perms.keys()))
        granted = []
        revoked = []
        for perm in sorted(all_perm_keys):
            old_val = old_perms.get(perm, False) is True
            new_val = new_perms.get(perm, False) is True
            if not old_val and new_val:
                granted.append(_permission_label(perm))
            elif old_val and not new_val:
                revoked.append(_permission_label(perm))
        if granted:
            changes.append(f"Permissions granted: {', '.join(granted)}")
        if revoked:
            changes.append(f"Permissions revoked: {', '.join(revoked)}")
        ds_added = sorted(set(role_definition["bdc_datasets"]) - set(previous_datasets))
        ds_removed = sorted(set(previous_datasets) - set(role_definition["bdc_datasets"]))
        if ds_added:
            changes.append(f"BDC datasets granted: {', '.join(ds_added)}")
        if ds_removed:
            changes.append(f"BDC datasets removed: {', '.join(ds_removed)}")

        details = '; '.join(changes) if changes else f"No changes detected for role '{new_name or role_id}'"

        write_audit_event(
            action="role_updated",
            performed_by=user_email,
            target=role_id,
            details=details,
        )

        logger.info(f"Role updated: {role_id} by {user_email}")

        return {"success": True, "message": "Role updated successfully", "role": role_definition}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating role: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/rbac/roles/{role_id}")
async def delete_custom_role(
        role_id: str,
        auth: dict = Depends(require_permission("manageRoles")),
):
    """Delete a custom role or reset a built-in role to defaults"""
    user_email = auth["user"]["email"]
    try:
        is_builtin = role_id in BUILTIN_ROLE_IDS
        users_to_remove = []

        # People on a deleted custom role drop back to their AD group, which
        # may give them more than the caller holds
        holders = [] if is_builtin else [
            e for e, entry in (load_rbac_config().get("user_roles") or {}).items() if role_id in (entry.get("roles") or [])
        ]
        groups_by_email = await _groups_for(auth, holders)

        with rbac_mutation(modified_by=user_email) as config:
            before = copy.deepcopy(config)
            # For custom roles, they must exist in custom_roles
            if not is_builtin and role_id not in config.get("custom_roles", {}):
                raise HTTPException(status_code=404, detail="Role not found")

            # Remove from custom_roles (if it exists)
            if role_id in config.get("custom_roles", {}):
                del config["custom_roles"][role_id]

            # For custom roles (not built-in), take it off everyone who has it.
            # Anyone left with no hand-given role goes back to their AD group.
            if not is_builtin:
                user_roles = config.setdefault("user_roles", {})
                users_to_remove = [e for e, entry in user_roles.items() if role_id in (entry.get("roles") or [])]
                for email in users_to_remove:
                    left = [r for r in user_roles[email]["roles"] if r != role_id]
                    if left:
                        user_roles[email] = {**user_roles[email], "roles": left}
                    else:
                        del user_roles[email]

            # A reset can hand a built-in back more than it has now; same rule
            # as editing it.
            if is_builtin:
                _guard_escalation(auth, _true_keys(get_role_permissions(role_id, config)))
            elif groups_by_email is not None:
                # Anyone assigned since the lookup above gets looked up too
                missing = [e for e in users_to_remove if e not in groups_by_email]
                if missing:
                    raise HTTPException(status_code=409, detail="Assignments changed while deleting. Try again.")
                _guard_target_gain(auth, {e: groups_by_email[e] for e in users_to_remove}, before, config)
            _guard_self_lockout(config, auth)

        action = "reset to defaults" if is_builtin else "deleted"
        logger.info(f"Role {action}: {role_id} by {user_email}")

        write_audit_event(
            action="role_reset" if is_builtin else "role_deleted",
            performed_by=user_email,
            target=role_id,
            details=f"Role reset to defaults: '{role_id}'" if is_builtin else f"Deleted custom role: '{role_id}'",
        )

        message = f"Built-in role reset to defaults successfully" if is_builtin else "Custom role deleted successfully"
        return {"success": True, "message": message, "removed_users": users_to_remove}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting custom role: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _roles_text(roles, keep_ad) -> str:
    text = ", ".join(f"'{r}'" for r in roles)
    return text + (" + AD group role" if keep_ad else " (AD group role ignored)")


@app.post("/api/rbac/user-assignments")
async def assign_user_role(
        assignment: Dict[str, Any] = Body(...),
        auth: dict = Depends(require_permission("manageUsers")),
):
    """Give someone one or more roles by hand.

    Body: {"user_email", "role_names": [...], "keep_ad": bool}. The list
    replaces whatever they had. keep_ad on: their AD group's role still
    counts on top; off: the AD role is ignored. Left out, keep_ad stays what
    it was, or is on for someone new. "role_name" (one role) still works.
    """
    user_email = auth["user"]["email"]
    try:
        target_email = (assignment.get('user_email') or '').strip().lower()
        if not target_email or '@' not in target_email or len(target_email) > 320:
            raise HTTPException(status_code=400, detail="Invalid email address")

        role_names = assignment.get('role_names')
        if role_names is None and assignment.get('role_name'):
            role_names = [assignment.get('role_name')]
        if not isinstance(role_names, list) or not all(isinstance(r, str) and r for r in role_names):
            raise HTTPException(status_code=400, detail="role_names must be a list of role IDs")
        role_names = list(dict.fromkeys(role_names))
        if not role_names:
            raise HTTPException(status_code=400, detail="Pick at least one role")

        keep_ad = assignment.get('keep_ad')
        if keep_ad is not None and not isinstance(keep_ad, bool):
            raise HTTPException(status_code=400, detail="keep_ad must be true or false")

        # A mistyped role would be stored and quietly count for nothing
        valid_roles = set(get_all_roles().keys())
        unknown = [r for r in role_names if r not in valid_roles]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown role(s): {', '.join(unknown)}")

        # Switching keep_ad on brings their AD role back in, which may give
        # more than the caller holds
        seen = user_roles_entry(load_rbac_config(), target_email)
        seen_keep = (seen or {}).get("keep_ad")
        next_keep = keep_ad if keep_ad is not None else (seen_keep if seen else True)
        brings_ad_back = bool(seen) and not seen_keep and next_keep
        groups_by_email = await _groups_for(auth, [target_email]) if brings_ad_back else None

        with rbac_mutation(modified_by=user_email) as config:
            before = copy.deepcopy(config)
            user_roles = config.setdefault("user_roles", {})
            previous = user_roles.get(target_email)
            prev_roles = list((previous or {}).get("roles") or [])
            prev_keep = bool((previous or {}).get("keep_ad"))
            if bool(previous) != bool(seen) or prev_keep != bool(seen_keep):
                raise HTTPException(status_code=409, detail="Their roles changed while saving. Try again.")
            if keep_ad is None:
                keep_ad = prev_keep if previous else True

            # Every new role has to be one the caller could hold out in full
            added = [r for r in role_names if r not in prev_roles]
            _guard_escalation(auth, _true_keys(get_roles_permissions(added, config)) if added else set())

            user_roles[target_email] = {"roles": role_names, "keep_ad": keep_ad}
            _guard_target_gain(auth, groups_by_email, before, config)
            _guard_self_lockout(config, auth)

        if previous:
            audit_action = "role_updated"
            audit_details = f"Changed roles from {_roles_text(prev_roles, prev_keep)} to {_roles_text(role_names, keep_ad)}"
        else:
            audit_action = "role_assigned"
            audit_details = f"Assigned {_roles_text(role_names, keep_ad)}"

        write_audit_event(
            action=audit_action,
            performed_by=user_email,
            target=target_email,
            details=audit_details,
        )

        logger.info(f"Roles set: {target_email} -> {role_names} keep_ad={keep_ad} by {user_email}")

        return {"success": True, "message": f"Roles saved for {target_email}",
                "entry": {"roles": role_names, "keep_ad": keep_ad}}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning user role: {e}")
        raise HTTPException(status_code=500, detail="Could not save the roles")


@app.delete("/api/rbac/user-assignments/{user_email}")
async def remove_user_assignment(
        user_email: str,
        auth: dict = Depends(require_permission("manageUsers")),
):
    """Remove a user's role assignment"""
    admin_email = auth["user"]["email"]
    try:
        user_email_lower = user_email.strip().lower()
        # Without the manual role they fall back to their AD group, which can
        # be more than the caller has (an AD admin who was demoted by hand)
        groups_by_email = await _groups_for(auth, [user_email_lower])

        with rbac_mutation(modified_by=admin_email) as config:
            user_roles = config.setdefault("user_roles", {})
            if user_email_lower not in user_roles:
                raise HTTPException(status_code=404, detail="User assignment not found")
            before = copy.deepcopy(config)
            removed = user_roles.pop(user_email_lower)
            _guard_target_gain(auth, groups_by_email, before, config)
            _guard_self_lockout(config, auth)

        write_audit_event(
            action="role_removed",
            performed_by=admin_email,
            target=user_email_lower,
            details=f"Removed roles given by hand: {', '.join(removed.get('roles') or [])}",
        )

        logger.info(f"Role assignment removed: {user_email_lower} by {admin_email}")

        return {"success": True, "message": f"Role assignment removed for {user_email_lower}"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing user assignment: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _permission_label(permission: str) -> str:
    """viewBDCSuperuser -> 'View BDC Superuser' for audit entries."""
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", permission)
    return spaced[:1].upper() + spaced[1:]


# Losing these through your own edit would lock you out of this page.
_SELF_LOCKOUT_PERMISSIONS = ("viewUserManagement", "manageUsers")


@app.put("/api/rbac/user-permissions/{user_email}")
async def set_user_permissions(
        user_email: str,
        body: Dict[str, Any] = Body(...),
        auth: dict = Depends(require_permission("manageUsers")),
):
    """Set one person's custom access on top of their role.

    Body: {"add": [permission, ...], "remove": [permission, ...]}. Both lists
    empty clears the custom access, same as DELETE.
    """
    admin_email = auth["user"]["email"]
    target = (user_email or "").strip().lower()
    if not target or "@" not in target:
        raise HTTPException(status_code=400, detail="Invalid email address")

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be an object")

    try:
        add, remove = normalize_user_overrides(body.get("add"), body.get("remove"))
        # Left out: their datasets stay as they are
        datasets = normalize_datasets(body["datasets"]) if "datasets" in body else None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if target == (admin_email or "").lower() and any(p in remove for p in _SELF_LOCKOUT_PERMISSIONS):
        raise HTTPException(status_code=400, detail="You can't remove your own access to User Management")

    previous_entry = (load_rbac_config().get("user_permission_overrides") or {}).get(target) or {}
    # Quick refusal before any directory lookup: a new grant the caller doesn't hold
    _guard_escalation(auth, set(add) - set(previous_entry.get("add") or []))
    # Undoing a removal hands back part of their role, so that needs checking
    # against what they'd really end up with
    restoring = set(previous_entry.get("remove") or []) - set(remove)
    held = auth["permissions"]
    needs_lookup = not _is_admin(auth) and any(held.get(p) is not True for p in restoring)
    groups_by_email = await _groups_for(auth, [target]) if needs_lookup else None

    try:
        with rbac_mutation(modified_by=admin_email) as config:
            before = copy.deepcopy(config)
            store = config.setdefault("user_permission_overrides", {})
            previous = store.get(target) or {}
            _guard_escalation(auth, set(add) - set(previous.get("add") or []))
            prev_datasets = list(previous.get("datasets") or [])
            if datasets is None:
                datasets = prev_datasets
            _guard_datasets(auth, set(datasets) - set(prev_datasets))
            if add or remove or datasets:
                store[target] = {"add": add, "remove": remove, "datasets": datasets}
            else:
                store.pop(target, None)
            if needs_lookup:
                _guard_target_gain(auth, groups_by_email, before, config)
            elif not _is_admin(auth) and set(previous.get("remove") or []) - set(remove) - _true_keys(held):
                # Changed since we looked; don't guess
                raise HTTPException(status_code=409, detail="Their access changed while saving. Try again.")
            _guard_self_lockout(config, auth)

        before_add, before_remove = set(previous.get("add") or []), set(previous.get("remove") or [])
        changes = []
        granted = [p for p in add if p not in before_add]
        removed = [p for p in remove if p not in before_remove]
        undone = sorted((before_add - set(add)) | (before_remove - set(remove)))
        if granted:
            changes.append("Granted: " + ", ".join(map(_permission_label, granted)))
        if removed:
            changes.append("Removed: " + ", ".join(map(_permission_label, removed)))
        if undone:
            changes.append("Back to role: " + ", ".join(map(_permission_label, undone)))
        ds_added = sorted(set(datasets) - set(prev_datasets))
        ds_removed = sorted(set(prev_datasets) - set(datasets))
        if ds_added:
            changes.append("BDC datasets granted: " + ", ".join(ds_added))
        if ds_removed:
            changes.append("BDC datasets removed: " + ", ".join(ds_removed))

        write_audit_event(
            action="role_access_customized" if (add or remove or datasets) else "role_access_reset",
            performed_by=admin_email,
            target=target,
            details="; ".join(changes) if changes else "Custom access saved with no changes",
        )
        logger.info(f"Custom access for {target} set by {admin_email}: +{len(add)} -{len(remove)}")

        return {"success": True,
                "overrides": {"add": add, "remove": remove, "datasets": datasets} if (add or remove or datasets) else None}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving custom access: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/rbac/user-permissions/{user_email}")
async def clear_user_permissions(
        user_email: str,
        auth: dict = Depends(require_permission("manageUsers")),
):
    """Drop one person's custom access so they get exactly their role."""
    return await set_user_permissions(user_email, {"add": [], "remove": [], "datasets": []}, auth)


_known_users_cache: Dict[str, Any] = {"value": None, "at": 0.0}


@app.get("/api/rbac/directory-stats")
async def get_rbac_directory_stats(auth: dict = Depends(require_permission("viewUserManagement"))):
    """How many different people have used SmartHub, from the audit log. The
    Access Map uses it to size the 'everyone else' ribbon (people on the
    default role)."""
    try:
        # A full pass over the audit log; the number moves slowly, so it is
        # worked out at most every five minutes.
        now = time.time()
        if _known_users_cache["value"] is None or now - _known_users_cache["at"] > 300:
            _known_users_cache["value"] = await asyncio.to_thread(count_known_users)
            _known_users_cache["at"] = now
        return {"success": True, "known_users": _known_users_cache["value"]}
    except Exception as e:
        logger.error(f"Error counting known users: {e}")
        return {"success": False, "known_users": None}


# ============================================================================
# VALIDATION SCRIPT RUNNER
# ============================================================================

_BDC_RUN_TASKS: set = set()  # strong refs to background drains of runs whose browser left


def _spawn_bdc_task(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _BDC_RUN_TASKS.add(task)
    task.add_done_callback(_BDC_RUN_TASKS.discard)


def _sse_event(kind: str, **extra) -> str:
    return f"data: {json.dumps({'type': kind, **extra, 'timestamp': datetime.now(EASTERN).isoformat()})}\n\n"


async def _run_ended(run_id, returncode) -> None:
    """Record how a run ended. A good run rewrites the failed-row tables, so
    cached delta comparisons of those tables are dropped as well."""
    await record_end(run_id, returncode)
    if returncode in (0, 1):  # 1 = some rules errored, the rest rewrote their tables
        with _delta_cache_lock:
            _delta_frames_cache.clear()


def _dqe_run_response(kind: str, arg: str, label: str, auth: dict, intro: list) -> StreamingResponse:
    """Run the DQ engine (python -m src.dqe.main <arg>) and stream its output.

    If the browser goes away mid-run the script carries on, so its output is
    drained in the background until it exits and the run log gets the real
    result. Before, nobody read the pipe after a disconnect: once it filled
    the script blocked on its next print and never finished."""
    import os

    script_dir = CONFIG['scripts']['script_dir']
    python_path = CONFIG['scripts']['python_path']
    title = label[:1].upper() + label[1:]

    async def drain(process, run_id):
        try:
            while await process.stdout.read(1 << 16):
                pass
            await process.wait()
            await _run_ended(run_id, process.returncode)
            logger.info(f"BDC {kind} {arg} finished after its browser left (exit {process.returncode})")
        except Exception as e:
            logger.warning(f"BDC {kind} {arg}: lost track of the script after the browser left: {e}")
            record_detached(run_id)

    async def stream():
        run_id = await record_start(kind, arg if kind == "validation" else "COMPILE", auth)
        process = None
        recorded = False
        try:
            yield _sse_event('status', message=f'Starting {label}...')
            for msg in intro:
                yield _sse_event('info', message=msg)
            yield _sse_event('info', message=f'Working directory: {script_dir}')
            yield _sse_event('info', message=f'Python: {python_path}')
            yield _sse_event('separator')

            process = await asyncio.create_subprocess_exec(
                python_path, "-m", "src.dqe.main", arg,
                cwd=script_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
                limit=1 << 20,  # long log lines (SQL, tracebacks) used to overflow the 64 KB default
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                # errors="replace": one odd byte in the output used to end the stream
                text = line.decode('utf-8', errors='replace').rstrip()
                if text:
                    yield _sse_event('output', message=text)
            await process.wait()

            yield _sse_event('separator')
            if process.returncode == 0:
                yield _sse_event('success', message=f'{title} completed successfully!')
            elif process.returncode == 1 and kind == "validation":
                # the DQE engine exits 1 when some rules errored; the rest still wrote results
                yield _sse_event('error', message=f'{title} finished, but some rules failed (exit code 1). See the log above.')
            else:
                yield _sse_event('error', message=f'{title} failed with exit code {process.returncode}')
            recorded = True
            await _run_ended(run_id, process.returncode)
            yield _sse_event('done', returncode=process.returncode)

        except FileNotFoundError:
            yield _sse_event('error', message=f"Python executable not found at {python_path}")
            recorded = True
            await _run_ended(run_id, -1)
            yield _sse_event('done', returncode=-1)
        except Exception as e:
            yield _sse_event('error', message=f"Error running {label}: {e}")
            if process is None:
                recorded = True
                await _run_ended(run_id, -1)
            yield _sse_event('done', returncode=-1)
        finally:
            if not recorded:
                try:
                    if process is not None:
                        _spawn_bdc_task(drain(process, run_id))
                    else:
                        record_detached(run_id)
                except Exception as e:
                    logger.warning(f"BDC {kind}: could not follow up on run {run_id}: {e}")
                    record_detached(run_id)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/run-validation")
async def run_validation(
        mode: str = Query("EXECUTE_FULL", description="EXECUTE_FULL | EXECUTE_ALLRULES | EXECUTE_ALLRULES_DELTA | EXECUTE_<RULE_ID>"),
        # Was runITChecks, an IT Checks permission: BDC operators without it got
        # a 403 and IT operators without BDC rights could start BDC runs.
        auth: dict = Depends(require_permission("runBDCOperations")),
):
    """Run the BDC validation script and stream console output in real time."""
    if not RUN_MODE_RE.fullmatch(mode or ""):
        raise HTTPException(status_code=400, detail="mode must be EXECUTE_FULL, EXECUTE_ALLRULES, EXECUTE_ALLRULES_DELTA or EXECUTE_<RULE_ID>")
    # Dataset-limited people can only run single rules from their own datasets
    if mode in WHOLE_RUN_MODES:
        if bdc_datasets(auth) is not None:
            raise HTTPException(status_code=403, detail="This run covers every dataset; you can only validate rules from your own datasets")
    elif not await asyncio.to_thread(rule_allowed, auth, mode[len("EXECUTE_"):]):
        raise HTTPException(status_code=404, detail=f"Rule '{mode[len('EXECUTE_'):]}' not found")
    await ensure_no_conflicting_run("validation", mode)
    return _dqe_run_response("validation", mode, "validation", auth, [f"Mode: {mode}"])


@app.get("/api/run-compilation")
async def run_compilation(auth: dict = Depends(require_permission("runBDCOperations"))):
    """Run the compilation script and stream console output in real time."""
    if bdc_datasets(auth) is not None:
        raise HTTPException(status_code=403, detail="Compilation covers every dataset; your access is limited to some datasets")
    await ensure_no_conflicting_run("compilation", "COMPILE")
    return _dqe_run_response("compilation", "COMPILE", "compilation", auth, [])


# ============================================================================

# ── IT validation runs, shared through Postgres (tables in V003__it_validation_runs.sql) ──
# The server that starts a run owns the script process. It writes the output to it_run_logs in
# small batches and sends NOTIFY it_run_log; every server LISTENs, so watchers anywhere wake up
# and read the new lines straight away (polling is only the fallback if LISTEN is down).
# Stop requests go the same way on it_run_stop, so the owning server kills the script at once.
_IT_DB_LABEL = {"insight7": "Insight7", "rimdocs": "RIMDocs"}
_IT_FLUSH = 0.15        # seconds: how often new output is written while the script is printing
_IT_HEARTBEAT = 2.0     # seconds: heartbeat + stop check when nothing else happens
_IT_FALLBACK = 1.0      # seconds: watchers re-read this often if a NOTIFY never arrives
_IT_PING = 15.0         # seconds of silence before an SSE comment, so proxies keep the stream open
_IT_STALE = "60 seconds"  # no heartbeat for this long = the owning server died
_IT_KEEP = "90 days"    # ponytail: old runs are pruned when a new one starts; make it a config value if someone asks
_IT_ACTIVE: dict = {}   # run_id -> (Popen, _ItLog) for runs this server owns
_IT_TASKS: set = set()  # strong refs so running tasks aren't garbage-collected


class _ItWake:
    """Per-run wake-up signal. Waiters grab .ev before reading the database, so a wake that
    lands while they're reading still counts (the old event stays set)."""
    def __init__(self):
        self.ev = asyncio.Event()
        self.watchers = 0  # streams on this server using it; dropped from the table at 0

    def fire(self):
        old, self.ev = self.ev, asyncio.Event()
        old.set()


_IT_LOG_WAKE: dict = {}   # run_id -> _ItWake (new log lines)
_IT_STOP_WAKE: dict = {}  # run_id -> _ItWake (stop requested)
_it_listener_started = False


def _it_wake(table: dict, run_id: str) -> _ItWake:
    w = table.get(run_id)
    if w is None:
        w = table[run_id] = _ItWake()
    return w


def _it_start_listener():
    """One LISTEN connection per process, on its own thread; fires the wake events on the loop."""
    global _it_listener_started
    if _it_listener_started:
        return
    _it_listener_started = True
    import select
    import threading
    loop = asyncio.get_running_loop()

    def on_notify(channel, run_id):
        table = _IT_LOG_WAKE if channel == "it_run_log" else _IT_STOP_WAKE
        w = table.get(run_id)
        if w:
            w.fire()

    def listen_forever():
        backoff = 1
        while True:
            conn = None
            try:
                conn = db.open_connection(application_name="smarthub-it-listen")
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute("LISTEN it_run_log; LISTEN it_run_stop;")
                backoff, idle = 1, 0.0
                while True:
                    if select.select([conn], [], [], 5)[0]:
                        conn.poll()
                        while conn.notifies:
                            n = conn.notifies.pop(0)
                            loop.call_soon_threadsafe(on_notify, n.channel, n.payload)
                        idle = 0.0
                    else:
                        idle += 5
                        if idle >= 30:  # quiet for a while: make sure the connection is still alive
                            with conn.cursor() as cur:
                                cur.execute("SELECT 1")
                            idle = 0.0
            except Exception as e:
                logger.warning(f"IT run listener: {e}; reconnecting in {backoff}s (watchers fall back to polling)")
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

    threading.Thread(target=listen_forever, name="it-run-listener", daemon=True).start()


def _it_db(fn, *args, read_only=False):
    """Run one short database job off the event loop."""
    def job():
        with db.transaction(read_only=read_only) as conn:
            return fn(conn, *args)
    return asyncio.to_thread(job)


def _it_reap(conn):
    """Close runs whose server stopped heartbeating (crash, kill -9, network loss)."""
    conn.execute(f"""UPDATE it_runs SET status = 'lost', finished_at = now()
                     WHERE finished_at IS NULL AND heartbeat_at < now() - interval '{_IT_STALE}'""")


def _it_user(auth: dict) -> str:
    """Display name without the AD suffix: 'Doe, Jane [JRDUS NON-J&J]' -> 'Doe, Jane'."""
    user = auth.get("user") or {}
    name = re.sub(r"\s*\[[^\]]*\]", "", user.get("name") or "").strip()
    return name or user.get("email") or "a user"


def _it_email(auth: dict) -> str:
    return (auth.get("user") or {}).get("email") or ""


def _sse(evt: dict) -> str:
    return f"data: {json.dumps(evt, default=str)}\n\n"


def _it_sse(gen):
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


def _it_error_stream(msg):
    async def gen():
        now = datetime.now(EASTERN).isoformat()
        yield _sse({"type": "error", "message": msg, "timestamp": now})
        yield _sse({"type": "done", "returncode": -1, "timestamp": now})
    return _it_sse(gen())


class _ItLog:
    """Buffers lines in memory (filled from the reader thread) and writes them in batches."""
    def __init__(self, run_id):
        import threading
        self.run_id, self.seq, self.pending = run_id, 0, []
        self.lock = threading.Lock()

    def add(self, kind, message=""):
        with self.lock:
            self.seq += 1
            self.pending.append((self.run_id, self.seq, datetime.now(EASTERN), kind, message))

    def flush(self, conn):
        """Write buffered lines + heartbeat, wake every watcher; returns who asked to stop (or None)."""
        with self.lock:
            rows, self.pending = self.pending, []
        try:
            if rows:
                conn.executemany("INSERT INTO it_run_logs (run_id, seq, ts, type, message) VALUES (?, ?, ?, ?, ?)", rows)
                conn.execute("SELECT pg_notify('it_run_log', ?)", (self.run_id,))  # delivered on commit
            row = conn.execute("UPDATE it_runs SET heartbeat_at = now() WHERE id = ? RETURNING stop_requested_by",
                               (self.run_id,)).fetchone()
        except Exception:
            with self.lock:
                self.pending = rows + self.pending  # keep them for the next try
            raise
        return row["stop_requested_by"] if row else None


async def _it_run_task(run_id: str, db_name: str, cmd: list, log: _ItLog):
    """Runs the script to completion no matter who is watching, on the server that started it.
    subprocess.Popen + a dedicated reader thread: asyncio subprocesses raise NotImplementedError on
    Windows' SelectorEventLoop (uvicorn --reload), and asyncio.to_thread(readline) would hold one of
    the shared executor threads for the whole run, slowing every other request."""
    import os
    import subprocess
    import threading
    label = _IT_DB_LABEL[db_name]
    loop = asyncio.get_running_loop()
    process, stopped_by, rc = None, None, -1
    exited = loop.create_future()
    stop_wake = _it_wake(_IT_STOP_WAKE, run_id)

    async def flush():
        nonlocal stopped_by
        try:
            asked = await _it_db(log.flush)
        except Exception as e:
            logger.warning(f"IT run {run_id}: couldn't write log to Postgres, will retry: {e}")
            return
        if asked and not stopped_by and process and process.poll() is None:
            stopped_by = asked
            logger.info(f"IT validation {run_id} ({db_name}) stopped by {asked}")
            process.terminate()
            loop.call_later(10, lambda: process.poll() is None and process.kill())

    async def ticker():
        last = 0.0
        while True:
            ev = stop_wake.ev
            try:
                await asyncio.wait_for(ev.wait(), _IT_FLUSH)
                woke = True
            except asyncio.TimeoutError:
                woke = False
            now = loop.time()
            if woke or log.pending or now - last >= _IT_HEARTBEAT:
                last = now
                await flush()

    unpublished = False  # the script saved to STG only (some pipeline failed), so the page won't show it

    def read_output():
        nonlocal unpublished
        try:
            for line in iter(process.stdout.readline, b""):
                decoded = line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    log.add("output", decoded)
                    if "CORE not updated" in decoded:
                        unpublished = True
            code = process.wait()
        except Exception as e:  # pragma: no cover - pipe errors
            code = process.wait()
            log.add("error", f"Lost the script's output: {type(e).__name__}: {e}")
        loop.call_soon_threadsafe(lambda: exited.done() or exited.set_result(code))

    tick = asyncio.ensure_future(ticker())
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"},
        )
        _IT_ACTIVE[run_id] = (process, log)
        threading.Thread(target=read_output, name=f"it-run-{db_name}", daemon=True).start()
        rc = await exited
        log.add("separator")
        if stopped_by:
            log.add("error", f"{label} validation stopped by {stopped_by}.")
        elif rc == 0 and unpublished:
            log.add("error", f"{label} validation finished, but some pipelines failed, so the results were "
                             "saved to staging only and are not shown on IT Checks. See the errors above.")
        elif rc == 0:
            log.add("success", f"{label} validation completed. Results saved to Snowflake.")
        else:
            log.add("error", f"{label} validation failed with exit code {rc}")
    except FileNotFoundError:
        log.add("error", "Script or Python executable not found. Check it_validation config paths.")
    except Exception as e:
        log.add("error", f"Error running IT validation: {type(e).__name__}: {e}")
        logger.exception(f"IT run {run_id} crashed")
        if process and process.poll() is None:
            process.kill()
    finally:
        tick.cancel()
        _IT_ACTIVE.pop(run_id, None)
        _IT_STOP_WAKE.pop(run_id, None)
        status = "stopped" if stopped_by else "success" if rc == 0 else "failed"

        def close(conn):
            conn.execute("UPDATE it_runs SET status = ?, returncode = ?, finished_at = now() WHERE id = ?",
                         (status, rc, run_id))
            log.flush(conn)  # last lines + NOTIFY in the same commit as the final status
        for attempt in range(5):  # the row must not stay 'running'; the reaper is the last resort
            try:
                await _it_db(close)
                break
            except Exception as e:
                logger.warning(f"IT run {run_id}: couldn't save final status ({e}); retrying")
                await asyncio.sleep(2 * (attempt + 1))
        logger.info(f"IT validation {run_id} ({db_name}) finished: {status} (exit {rc})")


async def _it_watch(run_id: str, after: int = 0):
    """Stream a run's log from Postgres: everything after `after`, then new lines until it finishes.
    Works for any run on any server, including finished ones (history). Each event carries its seq
    so a browser that loses the connection can resume where it left off."""
    _it_start_listener()
    wake = _it_wake(_IT_LOG_WAKE, run_id)
    wake.watchers += 1
    last, quiet = after, 0.0
    try:
        yield _sse({"type": "run", "run_id": run_id})
        while True:
            ev = wake.ev  # before the read: a NOTIFY during the read still wakes us
            def read(conn):
                rows = conn.execute("SELECT seq, ts, type, message FROM it_run_logs WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 5000",
                                    (run_id, last)).fetchall()
                run = conn.execute(f"""SELECT status, returncode, host, finished_at,
                                              finished_at IS NULL AND heartbeat_at < now() - interval '{_IT_STALE}' AS stale
                                       FROM it_runs WHERE id = ?""", (run_id,)).fetchone()
                return rows, run
            try:
                rows, run = await _it_db(read, read_only=True)
                if run and run["stale"]:
                    await _it_db(_it_reap)
                    continue
            except Exception as e:
                yield _sse({"type": "error", "message": f"Lost connection to the run log: {e}", "timestamp": datetime.now(EASTERN).isoformat()})
                yield _sse({"type": "done", "returncode": -1, "timestamp": datetime.now(EASTERN).isoformat()})
                return
            if run is None:
                yield _sse({"type": "error", "message": "Run not found.", "timestamp": datetime.now(EASTERN).isoformat()})
                yield _sse({"type": "done", "returncode": -1, "timestamp": datetime.now(EASTERN).isoformat()})
                return
            if rows:
                last = rows[-1]["seq"]
                quiet = 0.0
                # one write for the whole batch instead of one per line
                yield "".join(_sse({"seq": r["seq"], "type": r["type"], "message": r["message"], "timestamp": r["ts"]}) for r in rows)
                if len(rows) == 5000:
                    continue  # more backlog waiting; don't sleep
            if run["finished_at"]:
                if run["status"] == "lost":
                    yield _sse({"type": "error", "message": f"The server running this validation ({run['host']}) stopped responding.", "timestamp": run["finished_at"]})
                yield _sse({"type": "done", "returncode": run["returncode"] if run["returncode"] is not None else -1,
                            "stopped": run["status"] == "stopped", "run_id": run_id, "timestamp": run["finished_at"]})
                return
            try:
                await asyncio.wait_for(ev.wait(), _IT_FALLBACK)
            except asyncio.TimeoutError:
                quiet += _IT_FALLBACK
                if quiet >= _IT_PING:
                    quiet = 0.0
                    yield ": ping\n\n"
    finally:
        # Count watchers instead of peeking at the event: another stream may be between
        # reads (not waiting) and would otherwise lose its wake-ups and fall back to polling.
        wake.watchers -= 1
        if wake.watchers <= 0 and _IT_LOG_WAKE.get(run_id) is wake:
            del _IT_LOG_WAKE[run_id]


@app.get("/api/run-it-validation")
async def run_it_validation(
    db_name: str = Query(..., alias="db", description="Database to validate: 'insight7' | 'rimdocs'"),
    auth: dict = Depends(require_permission("runITChecks")),
):
    """
    Start the IT source-to-target validation for one database and stream its output (SSE).
    If that database is already running (on any server), streams that run instead of starting another.

    The 'it_validation' section in dq_config.json must follow this shape:
      {
        "it_validation": {
          "script_path": "/abs/path/to/Src_to_Trgt_Validation_Script.py",
          "insight7": { "config_path": "/abs/path/to/insight7_config.json" },
          "rimdocs":  { "config_path": "/abs/path/to/rimdocs_config.json"  }
        }
      }
    report_path is optional in each db block; falls back to whatever the
    validation config itself specifies.
    """
    import socket
    import uuid
    import psycopg2

    if not CONFIG or "it_validation" not in CONFIG:
        return _it_error_stream("'it_validation' section not found in dq_config.json")
    if db_name not in _IT_DB_LABEL:
        return _it_error_stream(f"Unknown database '{db_name}'. Must be one of: {', '.join(_IT_DB_LABEL)}")

    it_cfg      = CONFIG["it_validation"]
    db_cfg      = it_cfg.get(db_name, {})
    SCRIPT_PATH = it_cfg.get("script_path")
    CONFIG_PATH = db_cfg.get("config_path")
    REPORT_PATH = db_cfg.get("report_path")          # optional
    PYTHON_PATH = CONFIG.get("scripts", {}).get("python_path")
    if not SCRIPT_PATH or not CONFIG_PATH or not PYTHON_PATH:
        return _it_error_stream(f"Missing 'scripts.python_path', 'it_validation.script_path' or '{db_name}.config_path' in dq_config.json")

    run_id = uuid.uuid4().hex
    started_by = _it_user(auth)

    def claim(conn):
        """Insert our run, or return the id of the one already running for this db."""
        _it_reap(conn)
        conn.execute(f"DELETE FROM it_runs WHERE started_at < now() - interval '{_IT_KEEP}'")
        try:
            conn.execute("SAVEPOINT claim")
            conn.execute("INSERT INTO it_runs (id, db, started_by, started_by_email, host) VALUES (?, ?, ?, ?, ?)",
                         (run_id, db_name, started_by, _it_email(auth), socket.gethostname()))
            return None
        except psycopg2.errors.UniqueViolation:  # it_runs_one_running_idx: one running per db
            conn.execute("ROLLBACK TO SAVEPOINT claim")
            row = conn.execute("SELECT id FROM it_runs WHERE db = ? AND finished_at IS NULL", (db_name,)).fetchone()
            return row["id"] if row else None

    try:
        existing = await _it_db(claim)
    except Exception as e:
        return _it_error_stream(f"Couldn't start the run (database error): {e}")
    if existing:
        return _it_sse(_it_watch(existing))

    _it_start_listener()
    log = _ItLog(run_id)
    log.add("status", f"Starting IT validation — {_IT_DB_LABEL[db_name]} (by {started_by})")
    log.add("info", f"Script:  {SCRIPT_PATH}")
    log.add("info", f"Config:  {CONFIG_PATH}")
    cmd = [PYTHON_PATH, SCRIPT_PATH, "--config", CONFIG_PATH]
    if REPORT_PATH:
        log.add("info", f"Report:  {REPORT_PATH}")
        cmd += ["--report", REPORT_PATH]
    log.add("separator")
    task = asyncio.ensure_future(_it_run_task(run_id, db_name, cmd, log))
    _IT_TASKS.add(task)
    task.add_done_callback(_IT_TASKS.discard)
    return _it_sse(_it_watch(run_id))


@app.get("/api/it-validation-stream")
async def it_validation_stream(
    run_id: str = Query(...),
    after: int = Query(0, ge=0, description="Resume after this log seq (reconnects)"),
    auth: dict = Depends(require_permission("viewITChecks")),
):
    """Watch any run (live or finished) by id. Never starts one."""
    return _it_sse(_it_watch(run_id, after))


@app.get("/api/it-validation-status")
async def it_validation_status(auth: dict = Depends(require_permission("viewITChecks"))):
    """Runs in progress right now, on any server: {db: {run_id, started_by, started_at, stopping}}."""
    def read(conn):
        return conn.execute(f"""SELECT id, db, started_by, started_at, stop_requested_by,
                                       heartbeat_at < now() - interval '{_IT_STALE}' AS stale
                                FROM it_runs WHERE finished_at IS NULL""").fetchall()
    rows = await _it_db(read, read_only=True)
    if any(r["stale"] for r in rows):
        await _it_db(_it_reap)
        rows = [r for r in rows if not r["stale"]]
    return {r["db"]: {"running": True, "run_id": r["id"], "started_by": r["started_by"],
                      "started_at": r["started_at"], "stopping": bool(r["stop_requested_by"])} for r in rows}


@app.get("/api/it-runs")
async def list_it_runs(
    limit: int = Query(50, ge=1, le=500),
    auth: dict = Depends(require_permission("viewITChecks")),
):
    """Run history, newest first."""
    def read(conn):
        return conn.execute(f"""
            SELECT id, db, started_by, started_by_email, started_at, finished_at, returncode, stop_requested_by, host,
                   CASE WHEN finished_at IS NULL AND heartbeat_at < now() - interval '{_IT_STALE}' THEN 'lost' ELSE status END AS status,
                   EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::int AS seconds
            FROM it_runs ORDER BY started_at DESC LIMIT ?""", (limit,)).fetchall()
    return [dict(r) for r in await _it_db(read, read_only=True)]


@app.get("/api/it-runs/{run_id}/log.txt")
async def download_it_run_log(run_id: str, auth: dict = Depends(require_permission("viewITChecks"))):
    def read(conn):
        return conn.execute("SELECT * FROM it_runs WHERE id = ?", (run_id,)).fetchone(), conn.execute(
            "SELECT ts, type, message FROM it_run_logs WHERE run_id = ? ORDER BY seq", (run_id,)).fetchall()
    run, rows = await _it_db(read, read_only=True)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    def et(ts, f='%Y-%m-%d %H:%M:%S'):
        return ts.astimezone(EASTERN).strftime(f) if hasattr(ts, 'astimezone') else str(ts or '')
    head = (f"{_IT_DB_LABEL.get(run['db'], run['db'])} IT validation · started by {run['started_by']} "
            f"at {et(run['started_at'])} ET · {run['status']}"
            + (f" (exit {run['returncode']})" if run['returncode'] is not None else "")
            + (f" · stopped by {run['stop_requested_by']}" if run['stop_requested_by'] else "") + "\n\n")
    body = "\n".join("-" * 60 if r["type"] == "separator" else f"{et(r['ts'])}  {r['message']}" for r in rows)
    name = f"it_validation_{run['db']}_{et(run['started_at'], '%Y-%m-%d_%H-%M-%S')}.txt"
    return _PlainTextResponse(head + body + "\n",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/stop-it-validation")
async def stop_it_validation(
    db_name: str = Query(..., alias="db", description="Database to stop: 'insight7' | 'rimdocs'"),
    auth: dict = Depends(require_permission("runITChecks")),
):
    """Ask the server running this validation to stop it. NOTIFY wakes that server immediately;
    every watcher's stream then ends with done/stopped=true."""
    if db_name not in _IT_DB_LABEL:
        raise HTTPException(status_code=400, detail=f"Unknown database '{db_name}'. Must be one of: {', '.join(_IT_DB_LABEL)}")
    who = _it_user(auth)
    def ask(conn):
        row = conn.execute("""UPDATE it_runs SET stop_requested_by = COALESCE(stop_requested_by, ?)
                              WHERE db = ? AND finished_at IS NULL RETURNING id""", (who, db_name)).fetchone()
        if row:
            conn.execute("SELECT pg_notify('it_run_stop', ?)", (row["id"],))
        return row
    row = await _it_db(ask)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No {db_name} validation is running.")
    logger.info(f"IT validation {row['id']} ({db_name}): stop requested by {who}")
    return {"stopping": True, "run_id": row["id"]}


def _it_shutdown():
    """Server going down (deploy/restart): kill our scripts and close their runs now,
    instead of leaving them 'running' until the 60s reaper notices."""
    for run_id, (process, log) in list(_IT_ACTIVE.items()):
        try:
            if process.poll() is None:
                process.terminate()
            log.add("error", "The server restarted, so this validation was stopped. Start it again when ready.")
            with db.transaction() as conn:
                log.flush(conn)
                conn.execute("UPDATE it_runs SET status = 'lost', finished_at = now() WHERE id = ? AND finished_at IS NULL", (run_id,))
        except Exception as e:
            logger.warning(f"IT run {run_id}: shutdown cleanup failed: {e}")


# ============================================================================

@app.on_event("startup")
def _start_background_warmers():
    # Keeps the default RIM Docs page in cache (UNSTRUCTURED_WARM_SECONDS, 0 = off).
    try:
        import unstructured
        unstructured.start_warmer()
    except Exception as e:
        logger.warning(f"Unstructured warmer not started: {e}")


@app.on_event("shutdown")
def shutdown_event():
    """Close all connections on shutdown"""
    _it_shutdown()
    shutdown_ingestion()
    if bdc_connection_manager and bdc_connection_manager.available:
        logger.info("Closing BDC Snowflake connections...")
        bdc_connection_manager.close_all()
        logger.info("✅ BDC connections closed")

    try:
        from snowflake_query_runner import shutdown as shutdown_sfqr
        shutdown_sfqr()
        logger.info("✅ Data Studio Snowflake connections closed")
    except Exception as e:
        logger.warning(f"Data Studio Snowflake shutdown: {e}")

    try:
        from data_shuttle import shutdown as shutdown_shuttle
        shutdown_shuttle()
    except Exception as e:
        logger.warning(f"Data Shuttle shutdown: {e}")

    try:
        import unstructured
        unstructured.stop_warmer()
    except Exception as e:
        logger.warning(f"Unstructured warmer stop: {e}")

    try:
        it_report_pool.close_all()
    except Exception as e:
        logger.warning(f"IT report Snowflake pool shutdown: {e}")
    close_oracle_pools()

    # Queued audit events go in (or to the spool) before the pool closes.
    from audit import flush_audit_queue
    flush_audit_queue()
    db.close_pool()


# ============================================================================
# STARTUP
# ============================================================================

if __name__ == '__main__':
    import uvicorn

    logger.info("=" * 60)
    logger.info("GRA-SmartHub Backend v0.1.0")
    logger.info("=" * 60)
    logger.info("✅ Azure AD SSO")
    logger.info(f"{'✅' if DENODO_SERVICE_USERNAME else '❌'} Denodo Fuzzy Search")
    logger.info(f"{'✅' if CONFIG else '❌'} Data Validation (Data Quality Validation)")
    logger.info(
        f"{'✅' if bdc_connection_manager and bdc_connection_manager.available else '❌'} Business Defined Checks")
    logger.info("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8000)