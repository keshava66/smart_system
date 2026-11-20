import pytest

from sf_pool import SnowflakePool


class FakeConn:
    made = 0

    def __init__(self):
        FakeConn.made += 1
        self.id = FakeConn.made
        self.closed = False

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


def make(clock, **kw):
    return SnowflakePool(FakeConn, clock=clock, **kw)


def test_reuses_connection(clock):
    pool = make(clock)
    with pool.connection() as a:
        pass
    with pool.connection() as b:
        pass
    assert a is b and not a.closed


def test_concurrent_use_gets_separate_connections(clock):
    pool = make(clock)
    with pool.connection() as a, pool.connection() as b:
        assert a is not b


def test_idle_too_long_is_replaced(clock):
    pool = make(clock, max_idle=60)
    with pool.connection() as a:
        pass
    clock.t += 61
    with pool.connection() as b:
        pass
    assert a is not b and a.closed


def test_too_old_is_replaced(clock):
    pool = make(clock, max_idle=1000, max_age=100)
    with pool.connection() as a:
        pass
    for _ in range(3):
        clock.t += 40
        with pool.connection() as c:
            pass
    assert c is not a and a.closed


def test_closed_by_server_is_replaced(clock):
    pool = make(clock)
    with pool.connection() as a:
        pass
    a.closed = True
    with pool.connection() as b:
        pass
    assert a is not b


def test_driver_error_discards_connection(clock):
    from snowflake.connector.errors import OperationalError
    pool = make(clock)
    with pytest.raises(OperationalError):
        with pool.connection() as a:
            raise OperationalError("network")
    assert a.closed
    with pool.connection() as b:
        pass
    assert b is not a


def test_normal_exception_keeps_connection(clock):
    pool = make(clock)
    with pytest.raises(ValueError):
        with pool.connection() as a:
            raise ValueError("404 path")
    with pool.connection() as b:
        pass
    assert a is b


def test_idle_cap(clock):
    pool = make(clock, max_idle_conns=1)
    with pool.connection() as a, pool.connection() as b:
        pass
    assert sum(c.closed for c in (a, b)) == 1


def test_close_all(clock):
    pool = make(clock)
    with pool.connection() as a:
        pass
    pool.close_all()
    assert a.closed
    with pool.connection() as b:
        pass
    assert b.closed  # not kept after shutdown


def test_discard_closes_on_release(clock):
    pool = make(clock)
    with pool.connection() as a:
        pool.discard(a)
    assert a.closed
    with pool.connection() as b:
        pass
    assert b is not a


# ── Postgres pool (postgres_query_runner.PgConnectionPool), against a real server ──
import os as _os
import threading as _threading
import time as _time

_PG_DSN = _os.environ.get("DATA_API_TEST_PG_DSN")
_pg = pytest.mark.skipif(not _PG_DSN, reason="DATA_API_TEST_PG_DSN not set")


def _pg_pool(**kw):
    import psycopg2
    from postgres_query_runner import PgConnectionPool
    return PgConnectionPool(lambda: psycopg2.connect(_PG_DSN), "test", **kw)


@_pg
def test_pg_pool_runs_queries_side_by_side():
    pool = _pg_pool()
    pool.run("select 1")
    t0 = _time.time()
    ths = [_threading.Thread(target=pool.run, args=("select pg_sleep(0.4)",)) for _ in range(6)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    assert _time.time() - t0 < 1.2  # one shared connection took ~2.4s
    pool.close_all()


@_pg
def test_pg_pool_recovers_when_server_kills_connections():
    import psycopg2
    pool = _pg_pool()
    for _ in range(3):
        pool.run("select 1")
    pids = [r[0] for r in pool.run("select pg_backend_pid()")[1]]
    admin = psycopg2.connect(_PG_DSN)
    admin.autocommit = True
    with admin.cursor() as c:
        c.execute("select pg_terminate_backend(%s)", (pids[0],))
    admin.close()
    _time.sleep(0.2)
    assert pool.run("select 42")[1] == [(42,)]
    pool.close_all()


@_pg
def test_pg_pool_caps_open_connections():
    pool = _pg_pool(max_open=3, max_idle=2)
    seen = []
    def q():
        seen.append(pool.run("select count(*) from pg_stat_activity where application_name = '' and backend_type = 'client backend'")[1][0][0])
        pool.run("select pg_sleep(0.2)")
    ths = [_threading.Thread(target=q) for _ in range(10)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    assert len(pool._idle) <= 2
    pool.close_all()


@_pg
def test_pg_pool_sql_error_keeps_connection_usable():
    import psycopg2
    pool = _pg_pool()
    with pytest.raises(psycopg2.Error):
        pool.run("select * from no_such_table")
    assert pool.run("select 1")[1] == [(1,)]
    pool.close_all()


# ── Explorer result cache (unstructured._cache_*): bounded by age, count and bytes ──

@pytest.fixture
def ucache(monkeypatch):
    import unstructured as U
    U._cache.clear()
    monkeypatch.setattr(U, "_cache_bytes", 0)
    monkeypatch.setattr(U, "_cache_swept", 0.0)
    yield U
    U._cache.clear()
    U._cache_bytes = 0


def test_cache_roundtrip_and_expiry(ucache, monkeypatch):
    U = ucache
    U._cache_set("k", {"rows": [1, 2, 3]})
    assert U._cache_get("k") == {"rows": [1, 2, 3]}
    real = U.time.time
    monkeypatch.setattr(U.time, "time", lambda: real() + U.CACHE_TTL_SECONDS + 1)
    assert U._cache_get("k") is None
    assert "k" not in U._cache and U._cache_bytes == 0  # expired entry is freed, not kept


def test_cache_stays_under_byte_budget(ucache, monkeypatch):
    U = ucache
    monkeypatch.setattr(U, "CACHE_MAX_BYTES", 200_000)
    blob = "x" * 30_000
    for i in range(50):
        U._cache_set(f"k{i}", {"text": blob})
    assert U._cache_bytes <= 200_000
    assert U._cache_get("k49") is not None   # newest kept
    assert U._cache_get("k0") is None        # oldest evicted
    assert U._cache_bytes == sum(e[2] for e in U._cache.values())


def test_cache_skips_oversized_payload(ucache, monkeypatch):
    U = ucache
    monkeypatch.setattr(U, "CACHE_MAX_BYTES", 100_000)
    U._cache_set("small", {"a": 1})
    U._cache_set("huge", {"text": "x" * 60_000})  # over a quarter of the budget
    assert U._cache_get("huge") is None and U._cache_get("small") == {"a": 1}


def test_cache_sweeps_expired_entries(ucache, monkeypatch):
    U = ucache
    for i in range(20):
        U._cache_set(f"old{i}", {"i": i})
    real = U.time.time
    monkeypatch.setattr(U.time, "time", lambda: real() + U.CACHE_TTL_SECONDS + U.CACHE_SWEEP_SECONDS + 1)
    U._cache_set("fresh", {"i": -1})
    assert list(U._cache) == ["fresh"]


def test_cache_overwrite_keeps_byte_count_right(ucache):
    U = ucache
    U._cache_set("k", {"text": "x" * 1000})
    U._cache_set("k", {"text": "x" * 10})
    assert U._cache_bytes == U._cache["k"][2]


def test_rim_source_is_configurable_and_validated():
    import unstructured as U
    try:
        U.set_unstructured_dependencies({"rimdocs_table": "DB.SCH.RIM_NARROW"})
        assert "FROM DB.SCH.RIM_NARROW" in U.BASE_CTE
        U.set_unstructured_dependencies({"rimdocs_table": "T; DROP TABLE X"})
        assert U.DEFAULT_SOURCE_OBJECT in U.BASE_CTE
    finally:
        U.set_unstructured_dependencies(None)
    assert U.DEFAULT_SOURCE_OBJECT in U.BASE_CTE


def test_warmer_only_runs_while_rim_docs_is_used(monkeypatch):
    import unstructured as U
    runs = []
    monkeypatch.setattr(U, "_config", {"x": 1})
    monkeypatch.setattr(U, "WARM_SECONDS", 0.05)
    monkeypatch.setattr(U, "WARM_IDLE_SECONDS", 0.2)
    monkeypatch.setattr(U, "warm_default_page", lambda: runs.append(1) or 9)
    monkeypatch.setattr(U, "_last_used", 0.0)
    monkeypatch.setattr(U, "_warm_thread", None)
    U.start_warmer()
    try:
        _time.sleep(0.3)
        assert len(runs) == 1  # startup warm only, nobody is using it
        U._mark_used()
        _time.sleep(0.15)
        assert len(runs) >= 2
        _time.sleep(0.4)
        settled = len(runs)
        _time.sleep(0.2)
        assert len(runs) == settled  # idle again, stopped refreshing
    finally:
        U.stop_warmer()
        U._warm_thread.join(1)


# ── Data Studio, Snowflake pane: pooled sessions and cancel ──

class _SfConn:
    def __init__(self, sid=7):
        self.session_id, self.closed, self.ran = sid, False, []

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True

    def cursor(self):
        conn = self

        class Cur:
            def execute(self, sql, params=None):
                conn.ran.append((sql, params))

            def close(self):
                pass
        return Cur()


def test_sf_pool_skips_a_closed_session(monkeypatch):
    import snowflake_query_runner as S
    pool = S._ConnectionPool()
    dead, fresh = _SfConn(1), _SfConn(2)
    pool.release(dead, pool._key(None, None, None), _time.time())
    dead.closed = True
    monkeypatch.setattr(S, "_connect", lambda *a, **k: fresh)
    assert pool.acquire()[0] is fresh


def test_sf_cancel_stops_the_running_statement_and_retires_the_session(monkeypatch):
    import threading
    import snowflake_query_runner as S
    side, busy = _SfConn(99), _SfConn(42)
    monkeypatch.setattr(S, "_pool", S._ConnectionPool())
    monkeypatch.setattr(S, "_connect", lambda *a, **k: side)
    job = {"job_id": "j1", "owner": "a@x.com", "status": "running", "conn": busy, "done": threading.Event(),
           "cancel_requested": False, "last_used": 0}
    monkeypatch.setitem(S._jobs, "j1", job)
    S.cancel_query("j1", auth={"user": {"email": "a@x.com"}})
    for _ in range(50):
        if side.ran:
            break
        _time.sleep(0.02)
    job["done"].set()
    # The statement's own query id isn't known yet, so the whole session is cancelled.
    assert side.ran[0] == ("SELECT SYSTEM$CANCEL_ALL_QUERIES(?)", (42,))
    S._pool.release(busy, S._pool._key(None, None, None), _time.time())
    assert busy.closed       # never handed to the next query


def test_sf_temp_objects_keep_a_session_out_of_the_pool():
    from snowflake_query_runner import _SESSION_CHANGE as R
    for sql in ("create temp table t as select 1", "CREATE OR REPLACE TEMPORARY TABLE x (a int)",
                "create local temporary stage s", "use role analyst", "begin"):
        assert R.search(sql), sql
    for sql in ("create table t (a int)", "select 1", "create transient table t (a int)"):
        assert not R.search(sql), sql


def test_sf_run_all_keeps_each_statements_result(monkeypatch):
    """Every statement of a run that returns rows gets a job of its own, so its
    result can be opened, paged and sorted; the rest just get a summary line."""
    import threading
    import snowflake_query_runner as S

    class Conn(_SfConn):
        def cursor(self):
            conn = self

            class Cur:
                description, rowcount, sfqid = None, -1, None

                def execute(self, sql, params=None):
                    conn.ran.append(sql)
                    self.sfqid = f"q{len(conn.ran)}"
                    rows = {"select a": 3, "show tables": 2, "select b": 5}.get(sql.strip().lower())
                    self.description = [("A", 0, None, None, None, None)] if rows else None
                    self.rowcount = rows if rows else 1
                    self._rows = [(i,) for i in range(rows or 0)]

                def fetchall(self):
                    return self._rows

                def close(self):
                    pass
            return Cur()

    conn = Conn()
    monkeypatch.setattr(S, "_pool", S._ConnectionPool())
    monkeypatch.setattr(S._pool, "acquire", lambda *a, **k: (conn, "k", _time.time()))
    monkeypatch.setattr(S, "_apply_statement_timeout", lambda *a, **k: None)
    planned = S.plan_statements("select a; use schema s; show tables; select b")
    job = S._new_job(planned[-1]["cls"], "DB", "SC", None, 60, "a@x.com")
    job.update(statements=planned, statement_results=[], slots=threading.Semaphore(0), profile=S.READ_PROFILE, shared_ws=None)
    S._run_job(job["job_id"])

    assert job["status"] == "success", job["error"]
    res = job["statement_results"]
    assert [r["index"] for r in res] == [1, 2, 3, 4]
    assert "job_id" not in res[1]                         # USE has no rows to show
    assert res[3]["job_id"] == job["job_id"] and job["row_count"] == 5
    first, show = S._jobs[res[0]["job_id"]], S._jobs[res[2]["job_id"]]
    assert (first["status"], first["row_count"], first["query_id"], first["conn"]) == ("success", 3, "q1", None)
    assert show["inline_rows"] == [[0], [1]]              # SHOW is read once, kept in memory
    assert first["_history_written"]                      # the run goes into history once, not per statement
    for r in res:
        S._jobs.pop(r.get("job_id"), None)


def test_sf_filter_menu_counts_a_result_held_in_memory():
    from snowflake_query_runner import ColumnFilter, ValuesRequest, inline_values
    job = {"columns": [{"name": "K"}, {"name": "N"}], "inline_rows": [["a", 1], ["a", 2], ["b", 3], [None, 4], [{"x": 1}, 5]]}
    got = inline_values(job, ValuesRequest(column="K", limit=2))
    assert got["values"][0] == {"value": "a", "count": 2} and len(got["values"]) == 2 and got["more"]
    got = inline_values(job, ValuesRequest(column="K", filters=[ColumnFilter(col="N", op="gt", value="1")]))
    assert {v["count"] for v in got["values"]} == {1}
    # Searching narrows the list to values containing the text.
    got = inline_values(job, ValuesRequest(column="K", search="B"))
    assert got["values"] == [{"value": "b", "count": 1}]


# ── Data Studio, Postgres pane ──

def test_pg_writes_hidden_in_a_select_need_the_confirm():
    from postgres_query_runner import classify_and_validate_sql as c
    cte = c("with d as (delete from t where id = 1 returning *) select * from d")
    assert cte.is_destructive and not cte.cursorable and cte.returns_rows and cte.lead_keyword == "DELETE"
    into = c("select * into t2 from t")
    assert into.is_destructive and not into.cursorable and not into.returns_rows
    plain = c("with a as (select 'into' x) select * from a")
    assert not plain.is_destructive and plain.cursorable


@pytest.fixture
def pgs(monkeypatch):
    import psycopg2.extensions
    d = psycopg2.extensions.parse_dsn(_PG_DSN)
    for k, v in (("PGQR_HOST", d.get("host", "localhost")), ("PGQR_PORT", d.get("port", "5432")),
                 ("PGQR_USER", d.get("user", "postgres")), ("PGQR_PASSWORD", d.get("password", "")),
                 ("PGQR_DATABASE", d.get("dbname", "postgres"))):
        monkeypatch.setenv(k, v)
    import postgres_studio as P
    monkeypatch.setattr(P, "_record_history", lambda *a, **k: None)
    return P, {"user": {"email": "t@x.com"}}


def _pg_run(P, auth, sql, sid, wait=5000, confirm=True):
    return P.start_query(P.PgQueryRequest(sql=sql, session_id=sid, wait_ms=wait, confirm=confirm), conn_id=None, auth=auth)


@_pg
def test_pg_closing_a_worksheet_cancels_its_run(pgs):
    P, A = pgs
    r = _pg_run(P, A, "select pg_sleep(30)", "ws-close", wait=0)
    _time.sleep(0.5)
    P.close_session("ws-close", auth=A)
    job = P._jobs[r["job_id"]]
    assert job["done"].wait(10) and job["status"] == "cancelled", job["error"]


@_pg
def test_pg_closing_an_old_result_never_waits_on_a_run(pgs):
    P, A = pgs
    old = _pg_run(P, A, "select 1", "ws-busy")
    new = _pg_run(P, A, "select pg_sleep(2)", "ws-busy", wait=0)
    _time.sleep(0.3)
    t0 = _time.time()
    P.close_query(old["job_id"], auth=A)
    assert _time.time() - t0 < 0.5
    assert P._jobs[new["job_id"]]["done"].wait(10)


@_pg
def test_pg_run_all_keeps_each_statements_result(pgs):
    P, A = pgs
    r = _pg_run(P, A, "select 1 as a union all select 2; set search_path to public; select 'x' as b", "ws-parts")
    assert r["status"] == "success", r.get("error")
    first, setp, last = r["statements"]
    assert "job_id" not in setp and last["job_id"] == r["job_id"]
    rows = P.get_query_rows(first["job_id"], P.RowsRequest(page=1, page_size=10, sort=[{"col": "a", "dir": "desc"}]), auth=A)
    assert rows["rows"] == [[2], [1]]
    # The next run on the worksheet clears them all.
    _pg_run(P, A, "select 3", "ws-parts")
    with pytest.raises(P.HTTPException) as e:
        P.get_query_rows(first["job_id"], P.RowsRequest(page=1, page_size=10), auth=A)
    assert e.value.status_code == 410
    P.close_session("ws-parts", auth=A)


@_pg
def test_pg_filter_menu_counts_values_across_the_result(pgs):
    P, A = pgs
    from snowflake_query_runner import ColumnFilter
    r = _pg_run(P, A, "select * from (values ('a', 1, '{}'::json), ('a', 2, '{}'), ('b', 3, '{}'), (null, 4, '{}')) t(k, n, j)", "ws-vals")
    got = P.get_query_values(r["job_id"], P.ValuesRequest(column="k"), auth=A)
    assert got["values"] == [{"value": "a", "count": 2}, {"value": "b", "count": 1}] and not got["more"]
    # Other filters still apply; one on the same column is ignored.
    got = P.get_query_values(r["job_id"], P.ValuesRequest(column="k", filters=[ColumnFilter(col="n", op="gt", value="1"), ColumnFilter(col="k", op="eq", value="a")]), auth=A)
    assert got["values"] == [{"value": "a", "count": 1}, {"value": "b", "count": 1}]
    got = P.get_query_values(r["job_id"], P.ValuesRequest(column="k", search="B"), auth=A)
    assert got["values"] == [{"value": "b", "count": 1}]
    # json can't be grouped: a clear 400, and an open transaction on the worksheet survives it.
    _pg_run(P, A, "begin", "ws-vals")
    r = _pg_run(P, A, "select '{}'::json as j", "ws-vals")
    with pytest.raises(P.HTTPException) as e:
        P.get_query_values(r["job_id"], P.ValuesRequest(column="j"), auth=A)
    assert e.value.status_code == 400
    assert _pg_run(P, A, "select 1 as ok", "ws-vals")["status"] == "success"
    _pg_run(P, A, "rollback", "ws-vals")
    P.close_session("ws-vals", auth=A)


@_pg
def test_pg_edit_matches_a_row_whose_big_value_was_cut_short(pgs):
    P, A = pgs
    _pg_run(P, A, "drop table if exists ds_nokey; create table ds_nokey(v text, big text);"
                  "insert into ds_nokey values ('a', repeat('x', 30000)), ('b', 'y')", "ws-edit")
    got = P.table_rows(P.TableRowsRequest(database=P._cfg()["default_database"], schema="public", table="ds_nokey",
                                          page=1, page_size=10, sort=[{"col": "v", "dir": "asc"}]), conn_id=None, auth=A)
    row = dict(zip([c["name"] for c in got["columns"]], got["rows"][0]))
    assert row["big"]["$truncated"]
    done = P.table_mutate(P.MutateRequest(database=P._cfg()["default_database"], schema="public", table="ds_nokey",
                                          changes=[{"kind": "update", "original": row, "values": {"v": "a2"}}], confirm=True),
                          conn_id=None, auth=A)
    assert done["total"] == 1
    _pg_run(P, A, "drop table ds_nokey", "ws-edit")
