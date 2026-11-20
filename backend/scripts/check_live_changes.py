"""
Checks the speed and correctness changes against your real Snowflake and
Postgres, using the backend's own dq_config.json. Read-only: it only calls
GET endpoints (plus single-table re-validate if you ask for it, which reads
Oracle and Snowflake and saves nothing).

    cd backend
    python scripts/check_live_changes.py              # everything except re-validate
    python scripts/check_live_changes.py --revalidate # also re-validates 3 tables

Prints timings, sizes and OK / WARN / FAIL. Never prints credentials, host
names or data values, so the output is safe to paste back.
Exit code is 1 if anything failed.
"""

import argparse
import asyncio
import gzip
import json
import logging
import os
import socket
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)
# This script measures; the portal's background RIM Docs refresh would only add load.
os.environ["UNSTRUCTURED_WARM_SECONDS"] = "0"

results = []


def report(status, name, detail=""):
    results.append(status)
    print(f"{status:5} {name}{'  ' + detail if detail else ''}", flush=True)


def short(e):
    # Type and a trimmed message only: no stack, no connection strings.
    return f"{type(e).__name__}: {str(e).splitlines()[0][:120]}" if str(e) else type(e).__name__


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--revalidate", action="store_true", help="also re-validate 3 tables (reads Oracle + Snowflake, saves nothing)")
    args = ap.parse_args()

    logging.disable(logging.WARNING)
    print("Loading the backend (same config the portal uses)...", flush=True)
    import app as A
    import auth as AU
    from fastapi.testclient import TestClient
    import httpx
    import uvicorn

    # Act as a user with every permission, in-process only (no token, nothing leaves this machine).
    me = {"user": {"email": "live-check@localhost", "name": "Live check"}, "token": "", "role": "admin",
          "roles": ["admin"], "groups": [], "groups_known": True,
          "permissions": {p: True for p in AU.ALL_PERMISSIONS}}
    A.app.dependency_overrides[AU.require_auth] = lambda: me
    client = TestClient(A.app)

    # Count new Snowflake logins made by the IT Checks pool.
    logins = {"n": 0}
    real_connect = A.it_report_pool._connect

    def counting_connect():
        logins["n"] += 1
        return real_connect()
    A.it_report_pool._connect = counting_connect

    print("\n== IT Checks (Snowflake) ==", flush=True)
    try:
        t = time.time()
        r = client.get("/dq/validation_report_dates")
        dates_s = time.time() - t
        r.raise_for_status()
        runs = r.json().get("runs", [])
        report("OK", "run list", f"{len(runs)} runs in {dates_s:.2f}s")
    except Exception as e:
        report("FAIL", "run list", short(e))
        runs = []

    report_json = None
    try:
        times = []
        for i in range(3):
            t = time.time()
            r = client.get("/dq/validation_report", headers={"Accept-Encoding": "identity"})
            times.append(time.time() - t)
            r.raise_for_status()
        raw = r.content
        report_json = r.json()
        rd = report_json.get("report_data") or {}
        tables = sum(len((p.get("validation_results") or {}).get("table_validations") or []) for p in rd.get("pipeline_results") or [])
        report("OK", "all runs combined", f"{report_json.get('runs_merged')} runs, {tables} tables")
        report("OK", "load time", f"first {times[0]:.2f}s, then {times[1]:.2f}s / {times[2]:.2f}s (login reused)")

        # What FastAPI's default encoder would have cost on this exact payload.
        from fastapi.encoders import jsonable_encoder
        t = time.time(); json.dumps(jsonable_encoder(report_json)).encode(); old_enc = time.time() - t
        import orjson
        t = time.time(); orjson.dumps(report_json, default=str); new_enc = time.time() - t
        report("OK", "response encoding", f"old way {old_enc:.2f}s -> now {new_enc:.3f}s (saved {old_enc - new_enc:.2f}s per load)")

        gz = client.get("/dq/validation_report", headers={"Accept-Encoding": "gzip"})
        sent = int(gz.headers.get("content-length") or len(gzip.compress(raw)))
        same = gz.json() == report_json
        enc = gz.headers.get("content-encoding")
        report("OK" if enc == "gzip" and same else "FAIL", "gzip",
               f"{len(raw) / 1e6:.2f} MB -> {sent / 1e6:.2f} MB over the wire ({len(raw) / max(sent, 1):.0f}x smaller), data identical: {same}")
    except Exception as e:
        report("FAIL", "IT Checks report", short(e))

    if runs:
        try:
            one = runs[0]["load_date"]
            t = time.time()
            r = client.get("/dq/validation_report", params={"load_date": one})
            r.raise_for_status()
            report("OK", "single run", f"loaded in {time.time() - t:.2f}s")
        except Exception as e:
            report("FAIL", "single run", short(e))

    if report_json is not None:
        report("OK" if logins["n"] <= 1 else "WARN", "Snowflake logins for all calls above", f"{logins['n']} (was one per call before)")

    if args.revalidate and report_json:
        print("\n== Single-table re-validate (reads Oracle + Snowflake, saves nothing) ==", flush=True)
        before = logins["n"]
        picked = []
        for p in report_json["report_data"].get("pipeline_results") or []:
            for tv in (p.get("validation_results") or {}).get("table_validations") or []:
                if len(picked) < 3 and tv.get("status") == "PASSED":
                    picked.append((p, tv))
        for p, tv in picked:
            body = {
                "pipeline_name": p.get("pipeline_name", ""),
                "table_name": tv.get("table_name", ""),
                "source_schema": tv.get("_source_schema") or p.get("source_schema", ""),
                "target_database": tv.get("_snowflake_database") or p.get("snowflake_database", ""),
                "target_schema": tv.get("_snowflake_schema") or p.get("snowflake_schema", ""),
                "snowflake_table": tv.get("snowflake_table") or tv.get("table_name", ""),
                "source_db": tv.get("_source_db", ""),
            }
            t = time.time()
            r = client.post("/dq/validate_single_table", json=body)
            status = (r.json().get("validation_result") or {}).get("status") if r.status_code == 200 else f"HTTP {r.status_code}"
            report("OK" if r.status_code == 200 else "WARN", f"re-validate table #{picked.index((p, tv)) + 1}", f"{status} in {time.time() - t:.2f}s")
        made = logins["n"] - before
        report("OK" if made <= 1 else "WARN", "Snowflake logins for those re-validations", f"{made} (was {len(picked)} before)")

    print("\n== RIM Docs, query by query, Snowflake's result cache off (what a cold first visit costs) ==", flush=True)
    try:
        rim_cold_profile()
    except Exception as e:
        report("WARN", "RIM Docs profile", short(e))

    print("\n== VR and IMMBOT, every part, Snowflake's result cache off ==", flush=True)
    try:
        vr_immbot_profile(client)
    except Exception as e:
        report("WARN", "VR / IMMBOT profile", short(e))

    print("\n== Cortellis single-hand drugs (RP Products) ==", flush=True)
    try:
        cortellis_stereo_check(client)
    except Exception as e:
        report("WARN", "Cortellis single-hand drugs", short(e))

    # The rest needs a real server so requests can overlap.
    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(A.app, host="127.0.0.1", port=port, log_level="critical", log_config=None))
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.1)

    @A.app.get("/__live_check_ping")
    async def _ping():
        return {"ok": 1}

    base = f"http://127.0.0.1:{port}"
    print("\n== Business Checks reports: does a slow query freeze other requests? ==", flush=True)
    asyncio.run(check_no_freeze(base, httpx))

    print("\n== Explorers: do a page's requests run side by side? ==", flush=True)
    pages = {
        "RIM Docs (Snowflake)": [f"/api/unstructured/{p}?bypass_cache=true" for p in
                                 ("summary", "chart/domain-status", "chart/therapeutic-area",
                                  "chart/domain-distinct-objects", "chart/therapeutic-area-domain", "chart/ingestion-status")],
        "FDA (Postgres)": ["/api/fda/summary", "/api/fda/charts/decision", "/api/fda/charts/method", "/api/fda/charts/top-sponsors?limit=10"],
        "NIPO (Postgres)": ["/api/nipo/summary", "/api/nipo/charts/by-indication", "/api/nipo/charts/by-application-type", "/api/nipo/facets"],
        "EPOD (Postgres)": ["/api/epod/summary", "/api/epod/charts/chunk-level", "/api/epod/charts/content-types", "/api/epod/charts/top-documents?limit=10"],
        "HAQ (Postgres)": ["/api/haq/summary", "/api/haq/facets", "/api/haq/data?page=1&page_size=50"],
    }
    for name, urls in pages.items():
        asyncio.run(check_parallel(base, httpx, name, urls))

    srv.should_exit = True
    # Log out of Snowflake cleanly instead of leaving it to interpreter exit.
    bdc = getattr(A, "bdc_connection_manager", None)
    for close in (A.it_report_pool.close_all, _close_explorer_snowflake,
                  bdc.close_all if bdc else (lambda: None)):
        try:
            close()
        except Exception:
            pass
    _close_leftover_snowflake()
    fails = results.count("FAIL")
    warns = results.count("WARN")
    print(f"\n{len(results) - fails - warns} OK, {warns} WARN, {fails} FAIL")
    sys.exit(1 if fails else 0)


def rim_cold_profile():
    """Times every query the RIM Docs page runs on open, with Snowflake's result
    cache switched off for this session only, and pulls the engine's own stats
    for each (time compiling / queued / executing, data scanned, spills).
    Prints numbers only: no SQL text, data values or credentials."""
    import re
    import unstructured as U
    if not U._config:
        report("WARN", "RIM Docs profile", "RIM Docs not configured here, skipped")
        return
    client = U._get_client()

    def one(sql):
        return U._run(sql, {}).rows

    one("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
    try:
        m = re.search(r"FROM\s+([A-Z0-9_$]+)\.([A-Z0-9_$]+)\.([A-Z0-9_$]+)", U.BASE_CTE, re.I)
        if m:
            db, schema, table = m.groups()
            info = one(f"SELECT TABLE_TYPE, ROW_COUNT, BYTES, CLUSTERING_KEY FROM {db}.INFORMATION_SCHEMA.TABLES "
                       f"WHERE TABLE_SCHEMA = '{schema}' AND TABLE_NAME = '{table}'")
            if info:
                kind, nrows, nbytes, ckey = info[0]
                size = f", {nrows:,} rows, {nbytes / 1e9:.2f} GB" if nrows is not None and nbytes is not None else ""
                report("OK", "RIM Docs source", f"{kind}{size}, clustering key: {'yes' if ckey else 'none'}")
        wh = one("SELECT CURRENT_WAREHOUSE()")[0][0]
        if wh:
            client.execute(f"SHOW WAREHOUSES LIKE '{wh}'")
            shown = client.execute('SELECT "size", "max_cluster_count" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))').rows
            if shown:
                report("OK", "warehouse", f"size {shown[0][0]}, up to {shown[0][1]} cluster(s)")

        # Record the query id of every query each part runs.
        seen = []
        real_run = U._run

        def recording_run(sql, params=None):
            res = real_run(sql, params)
            seen.append(res.query_id)
            return res
        U._run = recording_run
        nobody = {"permissions": {}, "user": {"email": "live-check"}}
        parts = []
        try:
            for fn, kw in U._default_page_calls():
                start = len(seen)
                t = time.time()
                try:
                    U._call_with_defaults(fn, bypass_cache=True, auth=nobody, **kw)
                    parts.append((fn.__name__.replace("get_", "").replace("_chart", ""), time.time() - t, seen[start:], None))
                except Exception as e:
                    parts.append((fn.__name__, time.time() - t, seen[start:], short(e)))
        finally:
            U._run = real_run

        cur = client.conn.cursor()
        cur.execute("SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION(RESULT_LIMIT => 200))")
        cols = [d[0].upper() for d in cur.description]
        hist = {r[cols.index("QUERY_ID")]: dict(zip(cols, r)) for r in cur.fetchall()}
        cur.close()

        def stat(h, *names):
            for n in names:
                if n in h and h[n] is not None:
                    return h[n]
            return None
        for name, secs, qids, err in parts:
            if err:
                report("WARN", f"RIM {name}", err)
                continue
            bits = []
            for q in qids:
                h = hist.get(q) or {}
                ms = lambda k: (stat(h, k) or 0) / 1000
                scanned = (stat(h, "BYTES_SCANNED") or 0) / 1e6
                spill = ((stat(h, "BYTES_SPILLED_TO_LOCAL_STORAGE") or 0) + (stat(h, "BYTES_SPILLED_TO_REMOTE_STORAGE") or 0)) / 1e6
                bits.append(f"exec {ms('EXECUTION_TIME'):.1f}s, compile {ms('COMPILATION_TIME'):.1f}s, "
                            f"queued {ms('QUEUED_OVERLOAD_TIME') + ms('QUEUED_PROVISIONING_TIME'):.1f}s, "
                            f"scanned {scanned:,.0f} MB" + (f", SPILLED {spill:,.0f} MB" if spill else ""))
            report("OK", f"RIM {name}", f"{secs:.2f}s total | " + " || ".join(bits))
    finally:
        one("ALTER SESSION SET USE_CACHED_RESULT = TRUE")


SLOW_PART = 5.0  # seconds; anything slower than this shows as WARN


def _get_part(client, url):
    """GET one endpoint. Returns (seconds, data, error). NDJSON streams are
    read to the end and merged, and an error line counts as a failure."""
    t = time.time()
    try:
        r = client.get(url)
    except Exception as e:  # server error raised through the test client
        return time.time() - t, None, short(e)
    secs = time.time() - t
    if r.status_code != 200:
        return secs, None, f"HTTP {r.status_code}"
    if "ndjson" not in r.headers.get("content-type", ""):
        return secs, r.json(), None
    data = {}
    for line in r.text.splitlines():
        if not line.strip():
            continue
        part = json.loads(line)
        if part.get("error") or part.get("type") == "error":
            return secs, None, "stream returned an error"
        if "rows+" in part:
            data.setdefault("rows", []).extend(part["rows+"])
        elif part.get("type") == "product":
            data.setdefault("cards", []).append(part["product"])
        else:
            data.update(part)
    return secs, data, None


def vr_immbot_profile(client):
    """Every request the VR (internal, external, Cortellis) and IMMBOT pages
    make, including the click-throughs (a document, a chunk, versions, a
    record), each timed with the engine's own stats. IDs for the
    click-throughs come from the earlier responses and are never printed."""
    import chunk_explorer
    import cortellis
    import unstructured as U
    import vr_external
    if not U._config:
        report("WARN", "VR / IMMBOT", "not configured here, skipped")
        return

    seen = []
    mods = [U, chunk_explorer, cortellis, vr_external]
    real = {m: m._run for m in mods}

    def recorder(fn):
        def run(sql, params=None):
            res = fn(sql, params)
            seen.append(res.query_id)
            return res
        return run

    parts = []

    def part(label, url):
        start = len(seen)
        secs, data, err = _get_part(client, url)
        parts.append((label, secs, seen[start:], err))
        return data or {}

    def q(**kw):
        return "&".join(f"{k}={quote(str(v))}" for k, v in kw.items())

    U._run("ALTER SESSION SET USE_CACHED_RESULT = FALSE", {})
    for m in mods:
        m._run = recorder(real[m])
    try:
        b = "bypass_cache=true"

        # ---- VR internal ----
        vr = "/api/virtual-regulator"
        part("VR products (stream)", f"{vr}/products/stream?{b}")
        for c in ("recent-docs", "common-sections", "owners", "modified-trend"):
            part(f"VR chart {c}", f"{vr}/chart/{c}?{b}")
        lib = part("VR library", f"{vr}/library?page=1&page_size=25&sort=modified&sort_dir=desc&{b}")
        part("VR library sorted by versions", f"{vr}/library?page=1&page_size=25&sort=versions&sort_dir=desc&{b}")
        part("VR table (documents)", f"{vr}/rows?mode=documents&page=1&page_size=50&sort_col=FILE_NAME&sort_dir=asc&{b}")
        part("VR table (chunks)", f"{vr}/rows?mode=chunks&page=1&page_size=50&sort_col=FILE_NAME&sort_dir=asc&{b}")
        for col in ("STUDY_ID", "MODIFIED_BY", "VERSION_LABEL", "STATUS", "CHUNK_LEVEL", "CONTENT_TYPE"):
            part(f"VR filter options {col}", f"{vr}/filter-options?column={col}&{b}")
        doc_id = next((r.get("DOC_ID") for r in lib.get("rows") or [] if r.get("DOC_ID")), None)
        if doc_id:
            doc = part("VR open document", f"{vr}/document?{q(doc_id=doc_id)}&distinct_chunks=true&{b}")
            part("VR document versions", f"{vr}/versions?{q(doc_id=doc_id)}&{b}")
            chunk_id = next((c.get("CHUNK_ID") for c in doc.get("chunks") or [] if c.get("CHUNK_ID")), None)
            if chunk_id:
                part("VR open chunk", f"{vr}/chunk?{q(chunk_id=chunk_id)}")
            word = next((w for c in doc.get("chunks") or [] for w in str(c.get("SECTION_TITLE") or "").split()
                         if len(w) >= 6 and w.isalpha()), None)
            if word:
                part("VR search in chunk text", f"{vr}/library?page=1&page_size=25&sort=modified&sort_dir=desc&"
                                                f"{q(search=json.dumps({'CHUNK_TEXT': word}))}&{b}")

        # ---- VR external ----
        srcs = part("VR external sources", f"/api/vr-external/sources?{b}")
        part("VR external press releases", f"/api/vr-external/items?{b}")
        for i, src in enumerate([x for x in srcs.get("sources") or [] if x.get("kind") == "table"], 1):
            part(f"VR external table #{i}", f"/api/vr-external/table/{quote(src['id'])}?{b}")

        # ---- VR Cortellis ----
        cs = part("Cortellis sources", f"/api/cortellis/sources?{b}")
        for i, src in enumerate(cs.get("sources") or [], 1):
            tid = quote(src["id"])
            meta = part(f"Cortellis #{i} meta", f"/api/cortellis/meta/{tid}?{b}")
            part(f"Cortellis #{i} overview", f"/api/cortellis/overview/{tid}?{b}")
            part(f"Cortellis #{i} insights", f"/api/cortellis/insights/{tid}?{b}")
            tbl = part(f"Cortellis #{i} table", f"/api/cortellis/table/{tid}?page=1&size=50&{b}")
            key = meta.get("key")
            cols = tbl.get("columns") or []
            if key in cols and tbl.get("rows"):
                part(f"Cortellis #{i} open record", f"/api/cortellis/record/{tid}?{q(key=tbl['rows'][0][cols.index(key)])}")

        # ---- IMMBOT ----
        im = "/api/immbot"
        part("IMMBOT summary", f"{im}/summary?{b}")
        for c in ("ingestion-status", "chunk-level", "content-types", "chunks-per-doc",
                  "trial-status", "compound-phase"):
            part(f"IMMBOT chart {c}", f"{im}/chart/{c}?{b}")
        part("IMMBOT chart over-time", f"{im}/chart/over-time?granularity=day&{b}")
        part("IMMBOT chart by-dimension", f"{im}/chart/by-dimension?dimension=PRIMARY_INDICATION&{b}")
        rows = part("IMMBOT table (documents)", f"{im}/rows?mode=documents&page=1&page_size=50&sort_col=FILE_NAME&sort_dir=asc&{b}")
        part("IMMBOT table (chunks)", f"{im}/rows?mode=chunks&page=1&page_size=50&sort_col=FILE_NAME&sort_dir=asc&{b}")
        part("IMMBOT breakdown", f"{im}/breakdown?{q(levels='INSIGHT_THERAPEUTIC_AREA,GENERIC,PROTOCOL_ID')}&{b}")
        import immbot
        for col in immbot.FILTER_COLUMNS:
            part(f"IMMBOT filter options {col}", f"{im}/filter-options?column={col}&{b}")
        rcols = [c.upper() for c in rows.get("columns") or []]
        first = (rows.get("rows") or [None])[0]
        doc_id = (first.get("DOC_ID") if isinstance(first, dict)
                  else first[rcols.index("DOC_ID")] if first and "DOC_ID" in rcols else None)
        if doc_id:
            doc = part("IMMBOT open document", f"{im}/document?{q(doc_id=doc_id)}&{b}")
            chunk_id = next((c.get("CHUNK_ID") for c in doc.get("chunks") or [] if c.get("CHUNK_ID")), None)
            if chunk_id:
                part("IMMBOT open chunk", f"{im}/chunk?{q(chunk_id=chunk_id)}")
    finally:
        for m, fn in real.items():
            m._run = fn
        U._run("ALTER SESSION SET USE_CACHED_RESULT = TRUE", {})

    hist = _session_history(U._get_client())
    for label, secs, qids, err in parts:
        if err:
            report("FAIL", label, f"{err} after {secs:.2f}s")
            continue
        hs = [hist.get(x) or {} for x in qids]
        sec = lambda h, k: (h.get(k) or 0) / 1000
        scanned = sum(h.get("BYTES_SCANNED") or 0 for h in hs) / 1e6
        spill = sum((h.get("BYTES_SPILLED_TO_LOCAL_STORAGE") or 0) + (h.get("BYTES_SPILLED_TO_REMOTE_STORAGE") or 0) for h in hs) / 1e6
        queued = max([sec(h, "QUEUED_OVERLOAD_TIME") + sec(h, "QUEUED_PROVISIONING_TIME") for h in hs] or [0])
        slowest = max([sec(h, "EXECUTION_TIME") for h in hs] or [0])
        detail = (f"{secs:.2f}s | {len(qids)} quer{'y' if len(qids) == 1 else 'ies'}, slowest exec {slowest:.1f}s, "
                  f"queued {queued:.1f}s, scanned {scanned:,.0f} MB" + (f", SPILLED {spill:,.0f} MB" if spill else ""))
        report("WARN" if secs > SLOW_PART else "OK", label, detail)


def cortellis_stereo_check(client):
    """Runs the new queries for real: the Stereo form filter counts, the chiral pairs,
    mirror forms and the search across every Cortellis table. Counts and timings only."""
    import cortellis as CT
    import unstructured as U
    if not U._config:
        report("WARN", "Cortellis", "not configured here, skipped")
        return
    tid = "rp_products"
    secs, ov, err = _get_part(client, f"/api/cortellis/overview/{tid}?bypass_cache=true")
    if err:
        report("FAIL", "overview with Stereo form filter", f"{err} after {secs:.2f}s")
        return
    facet = next((f for f in ov.get("facets") or [] if f.get("column") == CT.STEREO), None)
    if facet:
        counts = ", ".join(f"{v['value']}: {v['count']:,}" for v in facet["values"])
        report("OK", "Stereo form counts", f"{secs:.2f}s (whole overview) | {counts}")
    else:
        report("WARN", "Stereo form counts", "no names with a (+)/(-)/(R)/(S) prefix found; check how Cortellis writes them")

    secs, _, err = _get_part(client, f"/api/cortellis/table/{tid}?page=1&size=50&bypass_cache=true&filters="
                                     + quote(json.dumps({CT.STEREO: [CT.ST_MINUS]})))
    report("FAIL" if err else ("WARN" if secs > SLOW_PART else "OK"), "Records filtered to Single hand (-)", err or f"{secs:.2f}s")

    secs, ins, err = _get_part(client, f"/api/cortellis/insights/{tid}?bypass_cache=true")
    chiral = (ins or {}).get("chiral")
    if err or not chiral:
        report("FAIL" if err else "WARN", "Chiral switches", err or "no pairs returned")
        return
    report("WARN" if secs > SLOW_PART * 2 else "OK", "Chiral switches",
           f"{secs:.2f}s (all insights) | {chiral['pairs']:,} pairs, original launched {chiral['original_launched_pct']}%, "
           f"single hand launched {chiral['single_launched_pct']}%, single hand stopped {chiral['single_stopped_pct']}%")
    if not chiral["examples"]:
        return
    key = chiral["examples"][0]["single"]["key"]
    secs, mir, err = _get_part(client, f"/api/cortellis/mirror/{tid}?key={quote(str(key))}&bypass_cache=true")
    report("FAIL" if err else "OK", "Mirror forms (one record)", err or f"{secs:.2f}s | {len(mir.get('forms') or [])} other record(s) of the same molecule")
    secs, far, err = _get_part(client, f"/api/cortellis/mirror-elsewhere/{tid}?key={quote(str(key))}&bypass_cache=true")
    if err:
        report("FAIL", "Search across all Cortellis tables", f"{err} after {secs:.2f}s")
        return
    tables = far.get("tables") or []
    report("WARN" if far.get("incomplete") or secs > SLOW_PART * 2 else "OK", "Search across all Cortellis tables",
           f"{secs:.2f}s | mentioned in {len(tables)} table(s), other hand found in {sum(1 for t in tables if t['twin_hits'])}"
           + (" | some tables did not answer in time" if far.get("incomplete") else ""))


def _session_history(sf_client):
    cur = sf_client.conn.cursor()
    try:
        cur.execute("SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION(RESULT_LIMIT => 5000))")
        cols = [d[0].upper() for d in cur.description]
        return {r[cols.index("QUERY_ID")]: dict(zip(cols, r)) for r in cur.fetchall()}
    finally:
        cur.close()


def _close_leftover_snowflake():
    """Anything still open (say a connection the explorer swapped out and
    meant to close later) gets logged out now, not at interpreter exit."""
    import gc
    try:
        from snowflake.connector import SnowflakeConnection
    except ImportError:
        return
    for obj in gc.get_objects():
        if isinstance(obj, SnowflakeConnection):
            try:
                if not obj.is_closed():
                    obj.close()
            except Exception:
                pass


def _close_explorer_snowflake():
    import unstructured as U
    client = getattr(U._conn_manager, "_client", None)
    if client is not None:
        client.close()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def check_no_freeze(base, httpx):
    async with httpx.AsyncClient(base_url=base, timeout=300) as c:
        try:
            slow = asyncio.create_task(c.get("/api/consolidated-report/history"))
            await asyncio.sleep(0.05)
            worst = 0.0
            while not slow.done():
                t = time.time()
                await c.get("/__live_check_ping")
                worst = max(worst, time.time() - t)
                await asyncio.sleep(0.05)
            r = await slow
            if r.status_code == 503:
                report("WARN", "report history", "Business Checks not configured here, skipped")
                return
            report("OK" if worst < 0.5 else "FAIL", "other requests while report history loads",
                   f"slowest waited {worst:.2f}s (history itself HTTP {r.status_code})")
        except Exception as e:
            report("FAIL", "report history", short(e))


async def _get(c, url, httpx):
    # A server-side error can close the keep-alive connection under us; retry once.
    try:
        return await c.get(url)
    except httpx.TransportError:
        return await c.get(url)


async def check_parallel(base, httpx, name, urls):
    async with httpx.AsyncClient(base_url=base, timeout=300) as c:
        try:
            first = await _get(c, urls[0], httpx)
            if first.status_code in (502, 503):
                report("WARN", name, f"not configured or unreachable here (HTTP {first.status_code}), skipped")
                return
            one_by_one = []
            for u in urls:
                t = time.time()
                r = await _get(c, u, httpx)
                one_by_one.append(time.time() - t)
                if r.status_code >= 400:
                    report("WARN", name, f"{u.split('?')[0]} returned HTTP {r.status_code}")
            t = time.time()
            rs = await asyncio.gather(*(_get(c, u, httpx) for u in urls))
            together = time.time() - t
            ok = all(r.status_code < 400 for r in rs)
            total, slowest = sum(one_by_one), max(one_by_one)
            # Side by side means close to the slowest single call, not their sum.
            side_by_side = together < slowest + 0.5 * (total - slowest) + 0.15
            report("OK" if ok and side_by_side else "WARN", name,
                   f"{len(urls)} calls: one after another {total:.2f}s, all at once {together:.2f}s (slowest single {slowest:.2f}s)")
        except Exception as e:
            report("FAIL", name, f"{short(e)} (last call: {getattr(getattr(e, 'request', None), 'url', '?')})")


if __name__ == "__main__":
    main()
