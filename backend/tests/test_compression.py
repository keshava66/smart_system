import gzip
import json

import pytest
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from fastapi.testclient import TestClient

from compression import GZipJSONMiddleware

BIG = {"rows": [{"table_name": f"T{i}", "status": "PASSED", "columns": list(range(20))} for i in range(500)]}


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(GZipJSONMiddleware, minimum_size=1024)

    @app.get("/big")
    def big():
        return BIG

    @app.get("/small")
    def small():
        return {"ok": True}

    @app.get("/sse")
    def sse():
        def gen():
            for i in range(3):
                yield f"data: {'x' * 2000} {i}\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/ndjson")
    def ndjson():
        def gen():
            for i in range(3):
                yield json.dumps({"i": i, "pad": "y" * 2000}) + "\n"
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    @app.get("/xlsx")
    def xlsx():
        return Response(b"\x00" * 5000, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.get("/text")
    def text():
        return PlainTextResponse("hello " * 1000)

    return TestClient(app)


def test_big_json_is_gzipped_and_identical(client):
    r = client.get("/big", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert r.json() == BIG  # client unzips; data unchanged
    assert int(r.headers["content-length"]) < len(json.dumps(BIG)) / 5


def test_raw_bytes_are_valid_gzip(client):
    with client.stream("GET", "/big", headers={"Accept-Encoding": "gzip"}) as r:
        raw = b"".join(r.iter_raw())
    assert json.loads(gzip.decompress(raw)) == BIG


def test_no_gzip_when_client_does_not_ask(client):
    r = client.get("/big", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers
    assert r.json() == BIG


def test_small_response_left_alone(client):
    r = client.get("/small", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers
    assert r.json() == {"ok": True}


@pytest.mark.parametrize("path", ["/sse", "/ndjson"])
def test_streams_pass_through(client, path):
    r = client.get(path, headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers
    assert r.text.count("\n") >= 3


def test_binary_left_alone(client):
    r = client.get("/xlsx", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers
    assert len(r.content) == 5000


def test_text_is_gzipped(client):
    r = client.get("/text", headers={"Accept-Encoding": "gzip, deflate"})
    assert r.headers["content-encoding"] == "gzip"
    assert r.text == "hello " * 1000


def test_attachment_download_left_alone():
    app = FastAPI()
    app.add_middleware(GZipJSONMiddleware, minimum_size=10)

    @app.get("/log.txt")
    def log():
        return PlainTextResponse("line\n" * 1000, headers={"Content-Disposition": 'attachment; filename="x.txt"'})

    r = TestClient(app).get("/log.txt", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers
    assert int(r.headers["content-length"]) == 5000


# ── viewUnstructuredSQL: explorer responses drop "sql"/"count_sql" for callers without it ──

@pytest.fixture(scope="module")
def sql_app():
    import os
    os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000")
    import app as A
    from fastapi import Request, Depends

    def mark(request: Request):
        request.state.hide_sql = request.headers.get("x-test-perm") != "yes"

    mini = FastAPI()
    mini.add_middleware(A._HideSqlMiddleware)
    mini.add_middleware(GZipJSONMiddleware, minimum_size=10)

    @mini.get("/api/x/json", dependencies=[Depends(mark)])
    def j():
        return {"rows": [1], "sql": "SELECT 1", "nested": {"count_sql": "SELECT 2", "keep": 1}, "items": [{"sql": "x", "v": 2}]}

    @mini.get("/api/x/stream", dependencies=[Depends(mark)])
    def st():
        def gen():
            yield '{"a": 1, "sql": "S"}\n{"b"'
            yield ': 2, "count_sql": "C"}\n'
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    @mini.get("/api/x/csv", dependencies=[Depends(mark)])
    def c():
        return PlainTextResponse("sql,v\nSELECT 1,2\n" * 100, media_type="text/csv")

    return TestClient(mini)


def test_sql_kept_with_permission(sql_app):
    r = sql_app.get("/api/x/json", headers={"x-test-perm": "yes"})
    assert r.json()["sql"] == "SELECT 1" and r.json()["nested"]["count_sql"] == "SELECT 2"


def test_sql_stripped_without_permission(sql_app):
    r = sql_app.get("/api/x/json", headers={"Accept-Encoding": "gzip"})
    assert r.json() == {"rows": [1], "nested": {"keep": 1}, "items": [{"v": 2}]}


def test_sql_stripped_from_split_stream(sql_app):
    r = sql_app.get("/api/x/stream")
    assert [json.loads(l) for l in r.text.splitlines() if l.strip()] == [{"a": 1}, {"b": 2}]


def test_csv_untouched(sql_app):
    assert sql_app.get("/api/x/csv").text.startswith("sql,v\nSELECT 1,2")
