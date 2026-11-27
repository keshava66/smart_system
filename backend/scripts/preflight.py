"""
Pre-deployment check for the portal database. Read-only: it opens one
transaction to prove it can write and rolls it back.

    cd backend
    python scripts/preflight.py                # one uvicorn worker, as the portal runs
    python scripts/preflight.py --workers 2

Each line is OK, WARN (works, but look at it) or FAIL (fix before going live).
Exit code is 1 if anything failed.
"""

import argparse
import hashlib
import os
import statistics
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# The reviewed version of every file this change touched. A mismatch means the
# copy here is older (or newer) than the one that was tested.
EXPECTED = {
    "Readme.md": "ce47eed64f753b09f9a4e32ac43661010330817e365b94da0785b9d8b6283eb9",
    "backend/.env.example": "fcc77d10d043097a892377cfd466e05506521401506c6646816e843d9e32db5c",
    "backend/app.py": "c90635c2edb03145066a4603006b5b869bca36daf364eed7e9e49aca2fdd4c94",
    "backend/assistant/knowledge/portal_overview.md": "57003e943beb4a6a3764f983da6419a8d31eafbbade8d14a4f0ae15e3bf554dd",
    "backend/assistant/memory.py": "d0a96d52e4979156502b11f7b682ed27fbe5c04b29c4ee8dab6e20d32ad22c06",
    "backend/assistant/portal_map.py": "e0c334378d0ea7901ed5a6d69493f7ca128ddb6d6e6654ef8429e73fe93ed201",
    "backend/assistant/tests/test_navigation.py": "7b431da676ac32c85e8ac49d39eaf7a6a6b0c395ceb74cdd5f8a4169617cd9d2",
    "backend/assistant/tests/test_portal_map.py": "38b9777e31a9585fc700325fbd80ccde21f110859d625fe4a5bf353273f8d207",
    "backend/assistant/tests/test_prompt_regression.py": "230f31ed42f1280ff8a4e6cfe6f1d96d1553315cb9627d2999df38013f55f7cc",
    "backend/audit.py": "4b1e763b15a7108c8835aca230de397e4f32fd50f128c789c42e46e0a229f1bd",
    "backend/auth.py": "647fba5901ef33522407cef0826394690a95f16f7bf13f0cc47fb32f4c0c02ed",
    "backend/bdc_admin.py": "8dcc48a1f9365a92332c62b4c3e4dca9caa587680c48b7774ca180229a2609cc",
    "backend/communication_center.py": "d3ce03ad2b735030d03483b137dc4782ef421a311ca8cf79743df430d161bcbb",
    "backend/consolidated_report.py": "d604bb243fb66b74d145bb17fb5bee23a2072a6db6a33f532413317cbaf8f2ad",
    "backend/data_api.py": "9e8ac64aaffdd4c9f9c5e00ef54a65ee105c44bb9f74b2bd1c046796ad0aadeb",
    "backend/data_api_mcp.py": "1e9338966edbc897ccefe9786814cace1128a81ce9e05ce2021a865937b41852",
    "backend/data_api_store.py": "514f39809567e6c057c91d4e81832773af5a1cb7a246bec2c99dd4c8aec87af3",
    "backend/data_shuttle.py": "02856b29faa7de768f5309fe422d83947f17d85d69e9da983dfcd69574faa65a",
    "backend/db.py": "2f57e871e9dc4b14773e57301b729e5ee95fbe3cbeba84239a1979d609d7716a",
    "backend/dq_config.example.json": "ebbff63dab7268748e268877198278902d376f17678633302733d8584f0424dc",
    "backend/ingestion_lab.example.yaml": "506b94772b25864fa75be08dd0b5109b41df0ced74481f0296072559879020b0",
    "backend/ingestion_lab.py": "d1138c061106444b711bca47032c5c835d206a8a952e9af81badae24d3b05d90",
    "backend/migrations/smarthub_core/V001__core_schema.sql": "b23ad4e2748c3edd1a69526b8396669a7940aa04dd22a07548c80237765d328f",
    "backend/migrations/smarthub_core/V002__audit_search_index.sql": "a73e0da8586c9ce7fb37a13c20ad9fdc565e63fb91c29299e564996fd0957bec",
    "backend/migrations/smarthub_core/V003__it_validation_runs.sql": "58f912c50226d89b2fb0761e42141bd8926abd60edfdd8cc6cf4a8ec98d07bcd",
    "backend/migrations/smarthub_core/V005__ingestion_lab.sql": "959e43b23fa75687db2539348edc31d02f2fcd8d40e97856a0b2215050d724ff",
    "backend/migrations/smarthub_core/V008__pg_studio_workspace.sql": "9d34d8f0d50678ac34114410205279fc3043e0968be0686125eea79beb1e0ff1",
    "backend/postgres_studio.py": "0dbb0584c1edd8dd72d65ff2df11181d33b70a8b361b5da3ee9e629743f18797",
    "backend/release_notes.py": "f1114f94d9ea1bc740b3048e6e38fc7cff767d6a0adc132a6e1ca38da9d28cb9",
    "backend/rim_ingestion.py": "903e81ff56e9c65ebe255631570d077e48a2b2ce5db6d8818bcf5a41032eb65d",
    "backend/scripts/check_timestamps.py": "78f4df3012ea5e75c1d8682497f06b9edd68c80a9d84248d34e3fa12058a94fd",
    "backend/scripts/migrate_sqlite_to_postgres.py": "85c73dc2ae5b83f1dffe1df4ae35766f1011fc79929dfac1742c5308cdedd97e",
    "backend/scripts/retrieval_demo.py": "50f2fddfa35ed2015c7bd45028b79ad594a307da6628e3380455fbb188e98232",
    "backend/snowflake_copier.py": "d995784d1e6382c66b3ee10871e803aafbdf7df53522efbcf402d390450fef98",
    "backend/snowflake_query_runner.py": "796acc6e6ffb4bac6844b35d2182a4b8433bc5fea9ec096f656dc4559c319da2",
    "backend/snowflake_sql.py": "46287db1b8814d7c65533225d298ec463ac6bdd460e0819e4e29c7f682627c43",
    "backend/tests/test_bdc_executive.py": "25137426a5774ed154ab957e954b1d9fc7a493aef120a79e802c4ce109b95fe9",
    "backend/tests/test_data_api_retrieval_pg.py": "213f99c233fd9ba78f975ecca4693dfb0ac42290ceaf19ba8c0c3ef473a96d6c",
    "backend/tests/test_rim_ingestion.py": "240c4f3ae0fe2d33ee981dfac4ba6c9c7b06c5327f108ebde75df43310b6d7ec",
    "backend/tests/test_sf_pool.py": "0c128d8ebc0b7925d10564ddac8020a1749e86510ecdb141f0f86bfc2cc24997",
    "frontend/src/assistant/FloatingAssistant.jsx": "277eeb1fd17f36712a072756f90db3008f45a7d9f89435b994161b217de17fa3",
    "frontend/src/assistant/assistantActions.js": "b5ca2babb4993804df907306684cdfd2d9dd8c2149272497d33ee9e8ca536157",
    "frontend/src/assistant/pageTips.js": "e7ce501f8b3109ebd72ac9a4d366c27eb283c6791e7256ed1ab3c6d3c9c42c67",
    "frontend/src/config/permissions.js": "9b8f83531b523cbb6746f9512582a114627b623ce90eafca0c8bffc160be54b3",
    "frontend/src/config/tools.js": "bd136f47e58556c18247d50967063b878db971ff86e39fc375f59d886a8721b2",
    "frontend/src/context/RBACContext.jsx": "15141ed0396c753584f8c58022d7eebb32724ddce9bcaf63402493bbee2a28a7",
    "frontend/src/pages/AuditPage.jsx": "1184b8792c3b3660a99be6a6b0b3eb0f5e3cb2f6ff093abf856ee0454ca4cdf2",
    "frontend/src/pages/BusinessDefinedChecks.css": "931f0df275af6471073f873804601a08911937ecdc89a1c28c0f2a77b8f5066e",
    "frontend/src/pages/BusinessDefinedChecks.jsx": "8e87e446d19efce6958af8e47cfcd47e566cd971f4b13421b3a2c4b66355cf69",
    "frontend/src/pages/DQEngine.jsx": "d8d5de1fc2462727d592a12ac6266fd6c0d77ca9ac30882f8aa6b3fd8af5168a",
    "frontend/src/pages/ExecutiveView.jsx": "e3ca320c2a9e53fdba4e31a4c5f41b20bdcf8317a9e81ec42d5cc8d3824a8116",
    "frontend/src/pages/IngestionLab.jsx": "7b8f6dbe4a41ab35b2250267b02748b618799a4b6b7b587f76158056d08bcd78",
    "frontend/src/pages/SafetyDQ.jsx": "a7e6eee8eeaac2ce7afcad4eb2d88666fdede3f621f762d99b65458cfe5d45d1",
    "frontend/src/pages/Unstructured.jsx": "aeaaeb1433c843ab6998c772a143ed932576c879686060d6d54d3c0e3e5aabeb",
    "frontend/src/pages/components/CommunicationParts.jsx": "fefa6a4930093da06874349d85b8fa8936c4865ff1a8bd06fa4c2e8d2cec6391",
    "frontend/src/pages/components/RimIngestionExplorer.jsx": "d9f3d0dfc223ce9088716c141a074af9f84db441d80d74791938b2a7211b348b",
    "frontend/src/pages/components/UnstructuredWelcome.jsx": "b17f8f2bdcc5b9ca09c9422979a0dca100db7258c36ec9df99d1f49f881b3a9a",
    "frontend/src/pages/dataApi/dataApiDocs.js": "57dca1cf847121ef4049bdc0d7f5c4f852d06ea691a98b551c962ce98a1e6879",
    "frontend/src/pages/dataStudio/panes.js": "a5251cd9bee298b914b8c4242a943928b8a75cc71c82cb40b7746ba1e835c78a",
    "frontend/src/pages/dataStudio/sf_pg/TableCopier.jsx": "028a80d5657573ac11a428680b1aca1a5c34aebe345eb062483978bfdfb2b446",
    "frontend/src/pages/dataStudio/sf_pg/editor.jsx": "cd6369e0978c3847179414fbddcb8fb9f359586413dfa32c43b9dccd3f9bee80",
    "frontend/src/pages/dataStudio/sf_pg/explorer.jsx": "03be8093eb0d4cb5899f1e8454c4fbe158be116db2c44f09bf82d5bab4f44e20",
    "frontend/src/pages/dataStudio/sf_pg/grid.jsx": "90cede707c3f13202c3dab833e861801608f636c35e130f5f348c5a3f37eee17",
    "frontend/src/pages/dataStudio/sf_pg/paneLib.js": "466939ab17e92c378fce8f64a5d55b76399cbfc3d4a66a70a3281fe728b8918c",
    "frontend/src/pages/dataStudio/sf_pg/paneUi.jsx": "716d31cb1262c96e51b46cf2f2797918be32cb8ed16b1611ee02f32754cd4f90",
    "frontend/src/pages/dataStudio/sf_pg/resultViews.jsx": "67c246136da85190a0c3eb9984766b99b15b4f702a1ec8a13a6840852bfd3830",
    "frontend/src/pages/dataStudio/sf_pg/sf_pg_pane.jsx": "4c3e218914db2f12395e2688ca91201d02738f5a1b201dbb234818d99755a57e",
    "frontend/src/pages/dataStudio/sf_pg/valuePreview.jsx": "bd7cad893e01734a6acad618b46eaa445fec33a4eacfba9b584028c848e92f5c",
    "frontend/src/pages/dataStudio/sf_pg/valueViewer.jsx": "0e72118b93a268384497b5547e971bb78a337723d431056e1c1055fe8275b9d1",
    "frontend/src/pages/dataStudio/shared/studioHelpers.jsx": "6c0bbefcc87e1c872343b57122ad7ab57997dbc16e946c75437d0ec3cea29362",
    "frontend/src/pages/userManagement/access.js": "3626b988281144d9e21f881cb2087e6a5238e47d8c94678e96a8bf25f5146589",
    "frontend/tests/bdc.test.jsx": "78ecdf7e8560fbfec50962b8baddaf66ba7d867cdaca235476caf4f8e5c987ec",
    "frontend/tests/dqe.test.jsx": "455ac719038fa7b7bc625898f50d8069a6e7da5f562a4bfb84cbe232b31f6ee9",
    "frontend/tests/studioExplorer.test.jsx": "0270586122d784c48bcb14741af77d200258fe0a880107dbc5c18dca2d0b4066",
    "frontend/tests/studioProfile.test.jsx": "a0434a660cb1e629b1ef4a1cc25e2c98c9e720e376ec82adaa5ccefd047182f5",
    "frontend/tests/studioTips.test.jsx": "74e09807da8b870efc8cbe3561fc8f8b3c0fd1d09e8d3c2ed122c0bf53ecde4c",
    "frontend/tests/studioValueViewer.test.jsx": "d6c2851fee5b93bad454a64beb2f36dc29ca43c6d30e94da2037e89913d88559",
}

TABLES = [
    "audit_log", "assistant_settings", "rbac_custom_roles", "rbac_user_overrides",
    "rbac_user_permissions", "rbac_meta", "email_templates", "email_history", "email_scheduled",
    "sf_query_history", "sf_saved_queries", "pg_query_history", "pg_saved_queries", "release_notes", "release_note_snapshots",
    "data_apis", "data_api_tables", "data_api_requests", "data_api_rate_windows",
    "data_api_embedding_models", "data_api_vector_registrations", "data_api_contracts",
    "data_api_search_settings", "assistant_user_memory", "schema_migrations",
    "it_runs", "it_run_logs", "ingestion_runs", "ingestion_run_logs",
]

results = []


def report(level, what, detail=""):
    results.append(level)
    print(f"{level:<5} {what}" + (f" — {detail}" if detail else ""))


def file_hash(path: Path) -> str:
    # Same normalisation as the migration checksums: line endings, a byte-order
    # mark and trailing whitespace at the end of the file don't count.
    text = path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").rstrip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_files():
    for rel, digest in EXPECTED.items():
        path = BACKEND.parent / rel
        if not path.exists():
            report("FAIL", f"{rel}", "missing")
        elif file_hash(path) != digest:
            report("FAIL", f"{rel}", "differs from the reviewed version - copy the latest one in")
    gone = BACKEND / "migrations" / "data_api_search_pg.sql"
    if gone.exists():
        report("WARN", "migrations/data_api_search_pg.sql", "obsolete, delete it")
    broken = []
    for py in sorted(BACKEND.rglob("*.py")):
        if any(part in (".venv", "venv", "node_modules", "__pycache__") for part in py.parts):
            continue
        try:
            compile(py.read_bytes(), str(py), "exec")
        except SyntaxError as e:
            broken.append(f"{py.relative_to(BACKEND)}: line {e.lineno}: {e.msg}")
    if broken:
        for b in broken:
            report("FAIL", "syntax error", b)
    if not any(level == "FAIL" for level in results):
        report("OK", "code", f"{len(EXPECTED)} changed files match the reviewed version; everything compiles")


def check_env():
    import assistant.env  # noqa: F401  loads backend/.env, as the server does at startup
    import db
    if os.environ.get("AZURE_TENANT_ID", "").strip():
        report("OK", "AZURE_TENANT_ID", "sign-in pinned to the configured tenant")
    else:
        report("FAIL", "AZURE_TENANT_ID", "not set - every sign-in is refused")
    s = db.settings()
    if not s.dsn:
        report("FAIL", "SMARTHUB_DB_DSN", "not set (environment or backend/.env)")
        return False
    dsn = s.dsn.lower()
    local = any(h in dsn for h in ("localhost", "127.0.0.1"))
    if not local and "sslmode=require" not in dsn and "sslmode=verify" not in dsn:
        report("WARN", "SMARTHUB_DB_DSN", "no sslmode=require - add it for RDS")
    else:
        report("OK", "SMARTHUB_DB_DSN", f"schema {s.schema}, pool {s.pool_max}, auto-migrate {s.auto_migrate}")
    stale = [v for v in ("ASSISTANT_PG_DSN", "DATABASE_URL", "PG_HOST", "PG_SCHEMA", "DATA_API_METADATA_DSN")
             if os.environ.get(v)]
    if stale:
        report("WARN", "old variables still set", ", ".join(stale) + " (no longer used; remove)")
    return True


def check_database(workers: int):
    import db
    try:
        raw = db.open_connection(application_name="smarthub-preflight")
    except Exception as e:
        report("FAIL", "connect", str(e))
        return
    try:
        raw.autocommit = True
        cur = raw.cursor()

        cur.execute("SHOW server_version_num")
        version = int(cur.fetchone()[0])
        if version < 120000:
            report("FAIL", "PostgreSQL version", f"{version // 10000} - 12 or newer is required")
        else:
            report("OK", "PostgreSQL version", str(version // 10000))

        times = []
        for _ in range(10):
            t = time.perf_counter()
            cur.execute("SELECT 1")
            cur.fetchone()
            times.append((time.perf_counter() - t) * 1000)
        rtt = statistics.median(times)
        if rtt > 20:
            report("WARN", "round trip to the database", f"{rtt:.1f} ms - the backend should run in the same "
                   "region/VPC as the database (expect ~1 ms)")
        else:
            report("OK", "round trip to the database", f"{rtt:.1f} ms")

        pending = db.pending()
        if pending:
            report("FAIL" if not db.settings().auto_migrate else "WARN", "migrations pending",
                   ", ".join(f"V{m.version:03d}" for m in pending)
                   + ("" if db.settings().auto_migrate else " - run python db.py migrate"))
        else:
            cur.execute(f'SELECT version, checksum FROM "{db.schema()}".schema_migrations')
            applied = dict(cur.fetchall())
            edited = [m for m in db.migrations() if applied.get(m.version) not in m.accepted]
            if edited:
                report("FAIL", "migrations", "applied files differ from the ones here: "
                       + ", ".join(f"V{m.version:03d}" for m in edited))
            else:
                report("OK", "migrations", f"all {len(applied)} applied, checksums match")

        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = %s", (db.schema(),))
        have = {r[0] for r in cur.fetchall()}
        missing = [t for t in TABLES if t not in have]
        if missing:
            report("FAIL", "tables", "missing: " + ", ".join(missing))
        else:
            report("OK", "tables", f"all {len(TABLES)} present")

        cur.execute("SELECT to_regclass(%s)", (f"{db.schema()}.audit_log_search_trgm_idx",))
        if cur.fetchone()[0] is None:
            report("WARN", "audit search index", "pg_trgm wasn't available, so Audit Log search scans the "
                   "table. Ask the DBA to run CREATE EXTENSION pg_trgm, then CREATE INDEX from "
                   "migrations/smarthub_core/V002")
        else:
            report("OK", "audit search index", "present")

        cur.execute("SELECT has_schema_privilege(%s, 'CREATE'), has_schema_privilege(%s, 'USAGE')",
                    (db.schema(), db.schema()))
        can_create, can_use = cur.fetchone()
        if not can_use:
            report("FAIL", "privileges", f"no USAGE on schema {db.schema()}")
        elif not can_create:
            report("WARN", "privileges", "no CREATE on the schema - future migrations need a role that has it")
        else:
            report("OK", "privileges", "USAGE and CREATE on the schema")

        cur.execute("SHOW max_connections")
        max_conn = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM pg_stat_activity")
        in_use = cur.fetchone()[0]
        per_worker = db.settings().pool_max + 8 + 1          # portal pool + Data API pools + migrator
        need = workers * per_worker
        headroom = max_conn - in_use
        level = "OK" if need <= headroom * 0.8 else ("WARN" if need <= headroom else "FAIL")
        report(level, "connections", f"{workers} workers can open up to {need}; server allows {max_conn}, "
               f"{in_use} in use now")

        cur.execute("SELECT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI'), "
                    "current_setting('TimeZone')")
        eastern, zone = cur.fetchone()
        report("OK" if zone == "America/New_York" else "FAIL", "session time zone", f"{zone}, now {eastern} ET")

        counts = []
        for table in TABLES:
            if table in have:
                cur.execute(f'SELECT count(*) FROM "{db.schema()}"."{table}"')
                counts.append(f"{table}={cur.fetchone()[0]}")
        report("OK", "rows", ", ".join(counts))

        raw.autocommit = False
        cur.execute("INSERT INTO audit_log (id, action, performed_by) VALUES ('preflight', 'preflight', 'preflight')")
        cur.execute("DELETE FROM audit_log WHERE id = 'preflight'")
        raw.rollback()
        report("OK", "write access", "insert/delete work (rolled back)")
    except Exception as e:
        report("FAIL", "database check", f"{type(e).__name__}: {e}")
    finally:
        raw.close()


def check_leftovers():
    old = [n for n in ("audit_log.db", "rbac.db", "communication_center.db", "data_api_exports.db",
                       "snowflake_query_runner.db", "release_notes.db") if (BACKEND / n).exists()]
    if old:
        report("OK", "old SQLite files", f"{', '.join(old)} still here - no longer read; archive after go-live")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=1, help="uvicorn workers you will run (the portal runs one)")
    args = parser.parse_args()
    check_files()
    if check_env():
        check_database(args.workers)
    check_leftovers()
    failed = results.count("FAIL")
    print(f"\n{failed} failure(s), {results.count('WARN')} warning(s).")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()