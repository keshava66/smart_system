import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import rim_ingestion as ri


def row(pc, oid, status, chunks=0, approved="2021-05-01", **kw):
    base = {c: None for c in ri.TEXT_COLUMNS}
    base.update(product_code=pc, r_object_id=oid, edms_number=f"EDMS-{oid}", object_name=f"Doc {oid}",
                a_status="Approved", r_object_type="rim_doc", domain="Clinical")
    base.update(kw)
    base.update(approved_date=approved, chunk_count=chunks, ingestion_status=status)
    return base


ROWS = [
    row("JNJ-1", "a1", ri.INGESTED, 10),
    row("JNJ-1", "a2", ri.NOT_INGESTED, approved=None),
    row("JNJ-2", "a1", ri.INGESTED, 10, approved="2023-02-02"),  # same doc under a second product
    row("JNJ-2", "b1", ri.NOT_INGESTED, a_status="Draft", domain=None, approved="2023-07-07"),
]
LOADS = []


@pytest.fixture
def client(monkeypatch):
    ri._cache.clear()
    LOADS.clear()
    monkeypatch.setattr(ri, "_load_sources", lambda: {
        "database": ri.DATABASE, "docs_table": "x.y", "chunks_schema": ri.CHUNKS_SCHEMA,
        "chunk_tables": ["doc_chunks_a", ri.DEFAULT_CHUNKS_TABLE], "default_chunks_table": ri.DEFAULT_CHUNKS_TABLE,
        "product_codes": ["JNJ-1", "JNJ-2"],
    })

    def load(table, codes, match_inside, latest_only):
        LOADS.append((table, codes, match_inside, latest_only))
        return {"rows": [dict(r) for r in ROWS], "loaded_at": "2026-11-27T00:00:00+00:00"}

    monkeypatch.setattr(ri, "_load_docs", load)
    app = FastAPI()
    app.include_router(ri.rim_ingestion_router)
    return TestClient(app)


def test_dashboard_counts_each_document_once(client):
    d = client.get("/api/rim-ingestion/dashboard").json()
    assert d["kpis"] == {"documents": 3, "ingested": 1, "not_ingested": 2, "rate": 1 / 3, "chunks": 10}
    assert d["scope_documents"] == 3
    assert {r["value"]: r["documents"] for r in d["by_product"]["rows"]} == {"JNJ-1": 2, "JNJ-2": 2}
    assert d["by_year"]["rows"] == [
        {"year": 2021, "ingested": 1, "not_ingested": 0},
        {"year": 2023, "ingested": 1, "not_ingested": 1},
    ]
    assert d["by_year"]["undated"] == 1
    assert d["source"]["chunks_table"].endswith(ri.DEFAULT_CHUNKS_TABLE)


def test_picks_filter_and_cache_is_reused(client):
    d = client.get("/api/rim-ingestion/dashboard", params={"approval": "Draft"}).json()
    assert d["kpis"]["documents"] == 1 and d["kpis"]["ingested"] == 0
    client.get("/api/rim-ingestion/rows", params={"status": ri.INGESTED})
    assert len(LOADS) == 1  # page filters never go back to Postgres
    client.get("/api/rim-ingestion/dashboard", params={"refresh": True})
    assert len(LOADS) == 2


def test_breakdown_labels_blanks(client):
    d = client.get("/api/rim-ingestion/breakdown", params={"by": "domain"}).json()
    assert {r["value"]: (r["documents"], r["ingested"]) for r in d["rows"]} == {"Clinical": (2, 1), ri.BLANK: (1, 0)}
    assert client.get("/api/rim-ingestion/breakdown", params={"by": "nope"}).status_code == 422


def test_rows_search_sort_page(client):
    d = client.get("/api/rim-ingestion/rows", params={"search": "edms-a1", "sort_col": "product_code", "sort_dir": "desc"}).json()
    assert d["total"] == 2 and [r["product_code"] for r in d["rows"]] == ["JNJ-2", "JNJ-1"]
    d = client.get("/api/rim-ingestion/rows", params={"page_size": 3, "page": 9}).json()
    assert d["page"] == 2 and len(d["rows"]) == 1
    d = client.get("/api/rim-ingestion/rows", params={"sort_col": "approved_date"}).json()
    assert d["rows"][-1]["approved_date"] is None  # blanks last


def test_rejects_unknown_table_and_sort(client):
    assert client.get("/api/rim-ingestion/rows", params={"chunks_table": "pg_user"}).status_code == 422
    assert client.get("/api/rim-ingestion/rows", params={"sort_col": "password"}).status_code == 422
    client.get("/api/rim-ingestion/rows", params={"chunks_table": "doc_chunks_a", "codes": ["JNJ-2", "JNJ-1"]})
    assert LOADS[-1] == ("doc_chunks_a", ("JNJ-1", "JNJ-2"), True, False)


def test_download_streams_every_row(client):
    scope = ri.scope_params(chunks_table=None, codes=[], match_inside=True, latest_only=False,
                            status=[], approval=[], object_type=[], domain=[])
    resp = ri.rim_ingestion_download(scope=scope, search="", sort_col="product_code", sort_dir="asc")

    async def body():
        return "".join([chunk async for chunk in resp.body_iterator])

    lines = asyncio.run(body()).strip().splitlines()
    assert lines[0] == ",".join(ri.ROW_COLUMNS) and len(lines) == 1 + len(ROWS)


def test_helpers():
    assert ri._like_escape("50%_a\\b") == "50\\%\\_a\\\\b"
    from datetime import date, datetime
    assert ri._iso_date(date(1, 1, 1)) is None
    assert ri._iso_date(datetime(2020, 3, 4, 5, 6)) == "2020-03-04"
