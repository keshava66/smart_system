"""Source side of Pipeline Studio validation, beyond Oracle: SQL Server, and table discovery for every
origin type we run (JDBC Multitable / Query, SQL Server CDC and Change Tracking, Oracle CDC, MySQL binlog).

Stdlib only at import time: the runner (pipeline_validation.py run as a script) imports this with the
validation Python, which has no web packages. Drivers (pymssql / jaydebeapi) load only when a SQL Server
connection is opened.

How it fits the validation script: the script talks to its source only through OracleConnector and
conn.cursor(). sqlserver_connector() builds a drop-in subclass whose cursor rewrites the script's
Oracle-flavoured SQL for SQL Server (COUNT -> COUNT_BIG, derived-table aliases, no hints / DUAL).
"""
import json
import math
import re
import time
from collections import Counter
from decimal import Decimal

# ═══════════════════════════════════════════════════════════════════════════════
# SQL helpers shared by the MariaDB and SQL Server cursors
# ═══════════════════════════════════════════════════════════════════════════════
_SQL_KEYWORDS = {"where", "group", "order", "having", "limit", "union", "join", "left", "right",
                 "inner", "outer", "cross", "on", "for", "window", "except", "intersect", "option"}


def _alias_derived(sql: str) -> str:
    """'FROM (subquery)' with no alias -> 'FROM (subquery) AS _dN' (Oracle allows it, MariaDB/SQL Server don't)."""
    spots = []
    for m in re.finditer(r"\bFROM\s*\(", sql, re.I):
        depth, i = 0, m.end() - 1
        while i < len(sql):
            depth += {"(": 1, ")": -1}.get(sql[i], 0)
            if depth == 0:
                break
            i += 1
        if depth:
            continue   # unbalanced - leave it alone
        nxt = re.match(r"\s*(\w+)", sql[i + 1:])
        if not nxt or nxt.group(1).lower() in _SQL_KEYWORDS:
            spots.append(i + 1)
    for n, at in enumerate(sorted(spots, reverse=True)):   # back to front keeps earlier offsets valid
        sql = f"{sql[:at]} AS _d{n}{sql[at:]}"
    return sql


def _num(x):
    # SUM() can come back as Decimal; the script compares and JSON-dumps plain ints
    return int(x) if isinstance(x, Decimal) and x == x.to_integral_value() else x


def _like(pattern):
    """SQL LIKE pattern (StreamSets table / capture-instance pattern) -> case-insensitive regex."""
    return re.compile("".join(".*" if c == "%" else "." if c == "_" else re.escape(c) for c in pattern) + r"\Z", re.I)


def _tsql(sql: str) -> str:
    """The script's SQL, made safe for SQL Server."""
    sql = re.sub(r"/\*\+.*?\*/\s*", "", sql, flags=re.S)                          # Oracle hints
    sql = re.sub(r"\s+FROM\s+DUAL\b", "", sql, flags=re.I)                         # SELECT 1 FROM DUAL
    sql = re.sub(r"\bCOUNT\s*\(\s*\*\s*\)", "COUNT_BIG(*)", sql, flags=re.I)       # INT overflows past 2.1bn rows
    sql = re.sub(r"\bCOUNT\s*\(\s*DISTINCT\b", "COUNT_BIG(DISTINCT", sql, flags=re.I)
    sql = re.sub(r"\bTHEN\s+1\s+ELSE\s+0\s+END\b", "THEN CAST(1 AS BIGINT) ELSE 0 END", sql, flags=re.I)  # null SUMs too
    return _alias_derived(sql)


# ═══════════════════════════════════════════════════════════════════════════════
# What kind of source a pipeline reads
# ═══════════════════════════════════════════════════════════════════════════════
LABELS = {"oracle": "Oracle", "mariadb": "MariaDB", "sqlserver": "SQL Server"}
SUPPORTED = tuple(LABELS)


def driver_kind(url: str):
    """jdbc:<driver>:... -> 'oracle' / 'mariadb' / 'sqlserver' / the raw driver name / None."""
    u = (url or "").strip().lower()
    if not u.startswith("jdbc:") or ":" not in u[5:]:
        return None
    d = u.split(":")[1]
    return {"mysql": "mariadb", "mariadb": "mariadb", "sqlserver": "sqlserver", "jtds": "sqlserver",
            "oracle": "oracle"}.get(d, d)


def origin_family(stage_type: str) -> str:
    """What a source stage is, from its StreamSets stage name."""
    t = (stage_type or "").lower().replace("_", "")
    if "sqlservercdc" in t or "cdcsqlserver" in t:
        return "sqlserver_cdc"
    if "sqlserverct" in t or "ctsqlserver" in t or "changetracking" in t:
        return "sqlserver_ct"
    if "oraclecdc" in t or "cdcoracle" in t:
        return "oracle_cdc"
    if "originmysql" in t or "mysqldsource" in t or "binlog" in t:
        return "mysql_binlog"
    if "tablejdbc" in t or "jdbctable" in t:
        return "multitable"
    if "jdbc" in t:
        return "query"
    return "other"


FAMILY_KIND = {"sqlserver_cdc": "sqlserver", "sqlserver_ct": "sqlserver", "oracle_cdc": "oracle", "mysql_binlog": "mariadb"}
FAMILY_LABEL = {"sqlserver_cdc": "SQL Server CDC", "sqlserver_ct": "SQL Server Change Tracking", "oracle_cdc": "Oracle CDC",
                "mysql_binlog": "MySQL binlog", "multitable": "JDBC Multitable", "query": "JDBC Query"}
DB_ORIGINS = tuple(FAMILY_LABEL)


def source_stage(pipeline: dict):
    """The extracted source stage that reads a database (first one), or None."""
    for s in (pipeline.get("pipeline_flow") or {}).get("sources") or []:
        if origin_family(s.get("type")) in DB_ORIGINS or s.get("technology") == "JDBC/Database":
            return s
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Table discovery for every origin: rewrite its table settings into the JDBC Multitable shape the
# validation script reads (Tableconfigs[0]: schema + tablePatternList), marked for discovery
# ═══════════════════════════════════════════════════════════════════════════════
def _json_list(v):
    if isinstance(v, list):
        return v
    try:
        x = json.loads(v) if isinstance(v, str) and v.strip() else []
        return x if isinstance(x, list) else []
    except ValueError:
        return []


def _cfg(cfg: dict, *names):
    """A setting by any of its display names (the extractor title-cases the last name segment)."""
    low = {k.lower().replace(" ", ""): v for k, v in cfg.items()}
    for n in names:
        v = low.get(n.lower().replace(" ", ""))
        if v not in (None, ""):
            return v
    return None


def normalize_origin(pipeline: dict) -> dict:
    """On a copy: CDC / Change Tracking / binlog table settings -> a Tableconfigs entry with '_discover', so the
    tables are read from the source at run time (as StreamSets does). Multitable/query pipelines are untouched."""
    p = json.loads(json.dumps(pipeline))
    s = source_stage(p)
    if not s:
        return p
    fam = origin_family(s.get("type"))
    cfg = s.setdefault("configuration", {})
    tc = None
    if fam == "sqlserver_cdc":
        rules = [{"pattern": e.get("capture_instance") or "%", "exclusion": e.get("tableExclusionPattern") or ""}
                 for e in _json_list(cfg.get("Tableconfigs")) if isinstance(e, dict)]
        if rules:
            # capture instances are named <schema>_<table>: 'dbo_%' -> schema dbo
            schemas = {r["pattern"].split("_")[0] for r in rules if "_" in r["pattern"] and "%" not in r["pattern"].split("_")[0]}
            tc = {"schema": schemas.pop() if len(schemas) == 1 else "", "cdcRules": rules}
    elif fam == "sqlserver_ct":
        ents = [e for e in _json_list(cfg.get("Tableconfigs")) if isinstance(e, dict)]
        if ents:
            tc = {"schema": ents[0].get("schema") or "", "tablePatterns": [e.get("tablePattern") or "%" for e in ents],
                  "exclusions": [e.get("tableExclusionPattern") for e in ents if e.get("tableExclusionPattern")]}
    elif fam == "oracle_cdc":
        ents = [e for e in _json_list(_cfg(cfg, "Schematableconfigs", "Tables")) if isinstance(e, dict)]
        if ents:
            tc = {"schema": ents[0].get("schema") or "", "tablePatterns": [e.get("table") or "%" for e in ents],
                  "exclusions": [e.get("excludePattern") for e in ents if e.get("excludePattern")]}
    elif fam == "mysql_binlog":
        inc = [x.strip() for x in str(_cfg(cfg, "Includetables", "Include Tables") or "").split(",") if x.strip()]
        ign = [x.strip() for x in str(_cfg(cfg, "Ignoretables", "Ignore Tables") or "").split(",") if x.strip()]
        if inc:
            db = inc[0].split(".")[0] if "." in inc[0] else ""
            tc = {"schema": db, "tablePatterns": [x.split(".", 1)[-1] for x in inc if x.split(".")[0] == db or "." not in x],
                  "exclusions": ["|".join(_like(x.split(".", 1)[-1]).pattern[:-2] for x in ign)] if ign else []}
    if tc is not None:
        tc.update({"_discover": fam, "isTablePatternListProvided": False, "tablePatternList": []})
        cfg["Tableconfigs"] = json.dumps([tc])
    return p


def discover_tables(tc: dict, conn) -> "tuple[list, list]":
    """(schema, table) pairs a discovering origin reads, from an open connector. Returns (pairs, notes)."""
    notes = []
    if tc.get("cdcRules"):
        found = conn.get_cdc_tables()   # [(capture_instance, schema, table)]
        pairs = []
        for inst, sch, tbl in found:
            for r in tc["cdcRules"]:
                if _like(r["pattern"]).match(inst) and not (r["exclusion"] and re.fullmatch(r["exclusion"], inst)):
                    pairs.append((sch, tbl))
                    break
        notes.append(f"{len(found)} CDC capture instance(s) on the server, {len(pairs)} match the pipeline")
    else:
        schema = tc.get("schema") or ""
        found = conn.get_all_tables()
        pats = [_like(x) for x in (tc.get("tablePatterns") or [tc.get("tablePattern") or "%"])]
        exc = [re.compile(x) for x in tc.get("exclusions") or [] if x] + \
              ([re.compile(tc["tableExclusionPattern"])] if tc.get("tableExclusionPattern") else [])
        pairs = [(schema, t) for t in found if any(p.match(t) for p in pats) and not any(e.fullmatch(t) for e in exc)]
    seen, out = set(), []
    for sch, tbl in pairs:   # a table can have two capture instances
        if (sch.lower(), tbl.lower()) not in seen:
            seen.add((sch.lower(), tbl.lower()))
            out.append((sch, tbl))
    return out, notes


def pick_schema(pairs, wanted: str = ""):
    """The script validates one schema per pipeline: the one asked for, else the one with most tables."""
    if not pairs:
        return wanted, [], []
    count = Counter(s for s, _ in pairs)
    schema = next((s for s in count if wanted and s.lower() == wanted.lower()), None) or count.most_common(1)[0][0]
    return schema, [t for s, t in pairs if s == schema], sorted(s for s in count if s != schema)


# ═══════════════════════════════════════════════════════════════════════════════
# SQL Server
# ═══════════════════════════════════════════════════════════════════════════════
def parse_sqlserver_url(url: str) -> dict:
    """jdbc:sqlserver://host[\\instance][:port][;k=v...] -> parts. jTDS URLs (jdbc:jtds:sqlserver://host:port/db) too."""
    u = (url or "").strip()
    out = {"host": None, "port": None, "instance": None, "database": None, "props": {}}
    m = re.match(r"jdbc:jtds:sqlserver://([^:/;]+)(?::(\d+))?(?:/([^;]+))?(.*)", u, re.I)
    if not m:
        m = re.match(r"jdbc:sqlserver://([^:;/]*)(?::(\d+))?()(.*)", u, re.I)
    if not m:
        return out
    host, port, db, rest = m.groups()
    if host and "\\" in host:
        host, out["instance"] = host.split("\\", 1)
    props = {}
    for part in (rest or "").split(";"):
        if "=" in part:
            k, val = part.split("=", 1)
            props[k.strip().lower()] = val.strip()
    out.update(host=host or props.get("servername"), port=port or props.get("portnumber"),
               database=db or props.get("databasename") or props.get("database"), props=props)
    out["instance"] = out["instance"] or props.get("instancename")
    return out


def sqlserver_settings(cfg: dict, url: str = "") -> dict:
    """Where and how to connect: the validation config's 'sqlserver' section first, then the pipeline's own URL."""
    s = cfg or {}
    own = parse_sqlserver_url(s.get("jdbc_url") or "")
    pipe = parse_sqlserver_url(url)
    pick = lambda k: own.get(k) or pipe.get(k)
    props = {**pipe["props"], **own["props"]}
    integrated = str(props.get("integratedsecurity", "")).lower() == "true"
    ntlm = str(props.get("authenticationscheme", "")).lower() == "ntlm"
    truthy = lambda v: str(v).lower() in ("true", "1", "yes", "strict", "mandatory")
    return {
        "host": s.get("host") or pick("host"),
        "port": int(s.get("port") or pick("port") or 1433),
        "instance": s.get("instance") or pick("instance"),
        "database": s.get("database") or pick("database"),
        # Windows (NTLM) login: domain from the config or the URL's domain=...
        "domain": s.get("domain") or (props.get("domain") if (integrated or ntlm) else None),
        "trusted": bool(s.get("trusted")),   # sign in as the account the portal runs under (Windows only)
        "encrypt": bool(s["encrypt"]) if "encrypt" in s else truthy(props.get("encrypt", "false")),
        "driver": (s.get("driver") or "pymssql").lower(),   # pymssql (pip only) or jdbc (needs Java + driver_jar)
        "driver_jar": s.get("driver_jar"),
        "jdbc_url": s.get("jdbc_url") or url,
    }


_LOB = {"text": "CLOB", "ntext": "CLOB", "xml": "CLOB", "image": "BLOB", "geography": "BLOB",
        "geometry": "BLOB", "sql_variant": "BLOB", "hierarchyid": "BLOB"}


def _ss_type(t: str) -> str:
    """SQL Server type as the script sees it: types SQL Server can't COUNT(DISTINCT) or GROUP BY are named
    '<TYPE> (CLOB/BLOB)' so the script leaves them out of statistics and duplicate checks."""
    low = (t or "").lower()
    return f"{low.upper()} ({_LOB[low]})" if low in _LOB else (t or "UNKNOWN").upper()


class _MsCursor:
    def __init__(self, cur, conn):
        self._c, self._conn = cur, conn

    def execute(self, sql, params=None):
        sql = _tsql(sql)
        if params is not None and self._conn.paramstyle == "pyformat":
            sql = sql.replace("?", "%s")   # our own queries are written with ?
        try:
            return self._c.execute(sql, tuple(params)) if params is not None else self._c.execute(sql)
        except Exception as e:
            if self._conn.timeout_ms and re.search(r"time.?out|timed out", str(e), re.I):
                raise TimeoutError("Table time limit reached") from e   # the script reports it as a timeout
            raise

    def fetchone(self):
        row = self._c.fetchone()
        return tuple(_num(x) for x in row) if row else row

    def fetchall(self):
        return [tuple(_num(x) for x in row) for row in self._c.fetchall()]

    @property
    def description(self):
        return self._c.description

    def close(self):
        try:
            self._c.close()
        except Exception:
            pass


class _MsConn:
    """DB-API connection wrapper. Exposes call_timeout so the script's per-table deadline reaches the driver."""

    def __init__(self, raw, paramstyle):
        self._raw, self.paramstyle, self.timeout_ms = raw, paramstyle, 0

    @property
    def call_timeout(self):
        return self.timeout_ms

    @call_timeout.setter
    def call_timeout(self, ms):
        self.timeout_ms = ms or 0
        inner = getattr(self._raw, "_conn", None)   # pymssql: per-connection query timeout, seconds
        if inner is not None and hasattr(inner, "query_timeout"):
            try:
                inner.query_timeout = math.ceil(ms / 1000) if ms else 0
            except Exception:
                pass   # ponytail: JDBC has no per-query timeout here; the script still stops waiting

    def cursor(self):
        return _MsCursor(self._raw.cursor(), self)

    def close(self):
        self._raw.close()


def sqlserver_connector(v):
    """Build the SQL Server connector on top of the loaded script's OracleConnector (keeps its retry/reconnect).
    Connection settings live on the class (`opts`, from sqlserver_settings) - one pipeline per run."""

    class SQLServerConnector(v.OracleConnector):
        opts: dict = {}

        def connect(self):
            o = self.opts
            try:
                self.conn = self._open_jdbc(o) if o.get("driver") == "jdbc" else self._open_pymssql(o)
                self.last_activity = time.time()
                return True
            except ImportError as e:
                v.print_safe(f"❌ SQL Server source needs {e.name or 'pymssql'}: "
                             f"{'pip install jaydebeapi JPype1 (and Java)' if o.get('driver') == 'jdbc' else 'pip install pymssql'}"
                             " (in the validation Python)")
                return False
            except Exception as e:
                v.log_detailed_error("SQL Server Connection Failed", e,
                                     {"User": self._login_name(), "Host": f"{o.get('host')}:{o.get('port')}",
                                      "Database": o.get("database"), "Schema": self.schema, "Driver": o.get("driver")})
                return False

        def _login_name(self):
            d = self.opts.get("domain")
            return f"{d}\\{self.user}" if d and self.user and "\\" not in self.user else self.user

        def _open_pymssql(self, o):
            import pymssql
            server = f"{o['host']}\\{o['instance']}" if o.get("instance") else o["host"]
            kw = dict(server=server, database=o.get("database") or "", login_timeout=30, autocommit=True,
                      appname="SmartHub IT Checks")
            if not o.get("instance"):
                kw["port"] = str(o["port"])
            if not o.get("trusted"):
                kw.update(user=self._login_name(), password=self.password)   # DOMAIN\user = NTLM login
            if o.get("encrypt"):
                kw["encryption"] = "require"
            try:
                raw = pymssql.connect(**kw)
            except TypeError:   # pymssql older than 2.3 has no 'encryption' (FreeTDS config decides)
                kw.pop("encryption", None)
                v.print_safe("⚠️  This pymssql can't force encryption - upgrade to pymssql 2.3+ if the server requires it")
                raw = pymssql.connect(**kw)
            c = raw.cursor()
            c.execute("SET QUOTED_IDENTIFIER ON; SET ARITHABORT ON; SET TEXTSIZE 2147483647")   # "schema"."table" works
            c.close()
            return _MsConn(raw, "pyformat")

        def _open_jdbc(self, o):
            import jaydebeapi
            url = o.get("jdbc_url") or f"jdbc:sqlserver://{o['host']}:{o['port']}"
            if o.get("database") and not re.search(r";\s*database(name)?=", url, re.I):
                url += f";databaseName={o['database']}"
            if o.get("domain") and not re.search(r"integratedsecurity=true", url, re.I):
                url += f";integratedSecurity=true;authenticationScheme=NTLM;domain={o['domain']}"
            if not o.get("driver_jar"):
                raise Exception("sqlserver.driver_jar isn't set in the validation config (path to mssql-jdbc .jar)")
            raw = jaydebeapi.connect("com.microsoft.sqlserver.jdbc.SQLServerDriver", url,
                                     [self.user or "", self.password or ""], o["driver_jar"])
            try:
                raw.jconn.setReadOnly(True)   # validation never writes to the source
            except Exception:
                pass
            return _MsConn(raw, "qmark")

        def is_alive(self):
            if not self.conn:
                return False
            try:
                c = self.conn.cursor()
                c.execute("SELECT 1")
                c.fetchone()
                c.close()
                self.last_activity = time.time()
                return True
            except Exception:
                return False

        def _rows(self, sql, params=()):
            if not self.ensure_connected():
                raise Exception("Failed to establish SQL Server connection")
            c = self.conn.cursor()
            try:
                c.execute(sql, params)
                return c.fetchall()
            finally:
                c.close()
                self.last_activity = time.time()

        def get_columns(self, table_name):
            rows = self._rows("""SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
                                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION""",
                              (self.schema, table_name))
            if not rows:
                raise Exception(f"Table {table_name} not found in schema {self.schema}")
            return [{"name": r[0], "type": _ss_type(r[1]), "nullable": r[2] == "YES"} for r in rows]

        def get_columns_from_query(self, query):
            try:   # real types, so text/xml columns are kept out of DISTINCT / GROUP BY
                if not self.ensure_connected():
                    raise Exception("Failed to establish SQL Server connection")
                c = self.conn.cursor()
                try:
                    # @tsql must be NVARCHAR, so inline it as N'...' rather than trust each driver's param typing
                    c.execute("EXEC sp_describe_first_result_set @tsql = N'" + query.replace("'", "''") + "'")
                    names = [d[0].lower() for d in c.description]
                    rows = c.fetchall()
                finally:
                    c.close()
                ix = lambda n: names.index(n)
                return [{"name": r[ix("name")], "type": _ss_type(re.sub(r"\(.*", "", r[ix("system_type_name")] or "")),
                         "nullable": bool(r[ix("is_nullable")])} for r in rows if not r[ix("is_hidden")]]
            except Exception:
                c = self.conn.cursor()
                try:
                    c.execute(f"SELECT * FROM ({query}) WHERE 1=0")
                    c.fetchall()
                    return [{"name": d[0], "type": "UNKNOWN", "nullable": True} for d in c.description]
                finally:
                    c.close()

        def get_all_tables(self):
            # tables and views, as the Multitable origin reads both
            return [r[0] for r in self._rows("""SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                                                WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME""", (self.schema,))]

        def get_cdc_tables(self):
            """[(capture_instance, schema, table)] for every CDC-enabled table this login can see."""
            try:
                rows = self._rows("""SELECT ct.capture_instance, s.name, t.name FROM cdc.change_tables ct
                                     JOIN sys.tables t ON t.object_id = ct.source_object_id
                                     JOIN sys.schemas s ON s.schema_id = t.schema_id ORDER BY s.name, t.name""")
            except Exception as e:   # no rights on the cdc schema: CDC-tracked tables, default instance names
                v.print_safe(f"⚠️  Can't read cdc.change_tables ({type(e).__name__}) - using tables marked is_tracked_by_cdc")
                rows = self._rows("""SELECT s.name + '_' + t.name, s.name, t.name FROM sys.tables t
                                     JOIN sys.schemas s ON s.schema_id = t.schema_id
                                     WHERE t.is_tracked_by_cdc = 1 ORDER BY s.name, t.name""")
            return [tuple(r) for r in rows]

        def get_constraints(self, table_name):
            out = {"primary_keys": [], "unique_constraints": [], "check_constraints": [],
                   "not_null_columns": [], "foreign_keys": []}
            obj = "OBJECT_ID(QUOTENAME(?) + '.' + QUOTENAME(?))"
            p = (self.schema, table_name)
            try:
                # names upper-cased like Oracle's, so they compare with Snowflake's
                out["primary_keys"] = [r[0].upper() for r in self._rows(f"""
                    SELECT c.name FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE i.object_id = {obj} AND i.is_primary_key = 1 AND ic.is_included_column = 0
                    ORDER BY ic.key_ordinal""", p)]
                uniq = {}
                for name, col in self._rows(f"""
                        SELECT i.name, c.name FROM sys.indexes i
                        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                        WHERE i.object_id = {obj} AND i.is_unique = 1 AND i.is_primary_key = 0 AND ic.is_included_column = 0
                        ORDER BY i.name, ic.key_ordinal""", p):
                    uniq.setdefault(name, []).append(col.upper())
                out["unique_constraints"] = [{"name": n, "columns": c} for n, c in uniq.items()]
                out["not_null_columns"] = [r[0].upper() for r in self._rows(
                    f"SELECT name FROM sys.columns WHERE object_id = {obj} AND is_nullable = 0 ORDER BY column_id", p)]
                fks = {}
                for name, col, rt, rc in self._rows(f"""
                        SELECT fk.name, pc.name, OBJECT_NAME(fk.referenced_object_id), rc.name
                        FROM sys.foreign_keys fk
                        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                        WHERE fk.parent_object_id = {obj} ORDER BY fk.name, fkc.constraint_column_id""", p):
                    fk = fks.setdefault(name, {"columns": [], "referenced_table": rt, "referenced_columns": []})
                    fk["columns"].append(col.upper())
                    fk["referenced_columns"].append(rc.upper())
                out["foreign_keys"] = [{"name": n, **f} for n, f in fks.items()]
                out["check_constraints"] = [{"name": n, "condition": c} for n, c in self._rows(
                    f"SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = {obj}", p)]
            except Exception as e:
                v.log_detailed_error(f"SQL Server - Failed to get constraints for table {table_name}", e,
                                     {"Table": table_name, "Schema": self.schema})
            return out

    return SQLServerConnector
