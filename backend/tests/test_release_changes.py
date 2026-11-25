"""Checks for the production-hardening release, one block per change.

Runs offline: Graph, SSH and the extractor scripts are faked. The live side
of the same changes is in scripts/release_check.py.
"""
import ast
import base64
import hashlib
import importlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
TENANT = "11111111-2222-3333-4444-555555555555"
OTHER_TENANT = "99999999-8888-7777-6666-555555555555"


# Virtual environments often live inside backend/ (backend/venv); never scan them.
ENV_DIRS = {"venv", ".venv", "env", ".env", "site-packages", "node_modules", "__pycache__"}


def own_py_files(root: Path, skip=()):
    """Python files that are part of this repo under root: no virtualenvs, no skipped folders."""
    for py in root.rglob("*.py"):
        rel = py.relative_to(root).parts
        if ENV_DIRS & set(rel) or set(skip) & set(rel) or any((root / p / "pyvenv.cfg").exists() for p in rel[:1]):
            continue
        yield py


def jwt_with(claims: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.sig"


# --------------------------------------------------------------- sign-in tenant pin

class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}

    def json(self):
        return self._body


class FakeGraph:
    """Answers /me and /organization the way Graph does for a given tenant."""

    def __init__(self, me_status=200, tenant=TENANT, mail="ana.rivera@its.jnj.com"):
        self.me_status, self.tenant, self.mail = me_status, tenant, mail
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        if url.endswith("/me"):
            return FakeResponse(self.me_status, {"id": "u1", "userPrincipalName": self.mail,
                                                 "displayName": "Rivera, Ana", "mail": self.mail})
        if "/organization" in url:
            return FakeResponse(200, {"value": [{"id": self.tenant}]})
        raise AssertionError(f"unexpected Graph call {url}")


@pytest.fixture
def auth_mod(monkeypatch):
    import auth
    monkeypatch.setattr(auth, "ALLOWED_TENANTS", frozenset({TENANT}))
    return auth


def test_tid_is_read_from_the_token(auth_mod):
    assert auth_mod._token_tenant(jwt_with({"tid": TENANT.upper()})) == TENANT
    assert auth_mod._token_tenant(jwt_with({"oid": "x"})) is None
    assert auth_mod._token_tenant("not-a-jwt") is None
    assert auth_mod._token_tenant("a.%%%.c") is None


def test_own_tenant_signs_in(auth_mod, monkeypatch):
    graph = FakeGraph()
    monkeypatch.setattr(auth_mod, "_graph_session", graph)
    user = auth_mod._validate_token_with_graph(jwt_with({"tid": TENANT}))
    assert user["email"] == "ana.rivera@its.jnj.com"
    assert not any("/organization" in c for c in graph.calls), "tid in the token is enough"


def test_foreign_tenant_is_refused_even_with_a_known_mail(auth_mod, monkeypatch):
    # Another tenant's admin can set mail to any address, including an admin's here.
    monkeypatch.setattr(auth_mod, "_graph_session", FakeGraph(tenant=OTHER_TENANT, mail="admin@its.jnj.com"))
    with pytest.raises(HTTPException) as e:
        auth_mod._validate_token_with_graph(jwt_with({"tid": OTHER_TENANT}))
    assert e.value.status_code == 401


def test_opaque_token_falls_back_to_graph_organization(auth_mod, monkeypatch):
    monkeypatch.setattr(auth_mod, "_graph_session", FakeGraph(tenant=TENANT))
    assert auth_mod._validate_token_with_graph("opaque-token")["id"] == "u1"
    monkeypatch.setattr(auth_mod, "_graph_session", FakeGraph(tenant=OTHER_TENANT))
    with pytest.raises(HTTPException) as e:
        auth_mod._validate_token_with_graph("opaque-token")
    assert e.value.status_code == 401


def test_graph_rejection_is_401(auth_mod, monkeypatch):
    monkeypatch.setattr(auth_mod, "_graph_session", FakeGraph(me_status=401))
    with pytest.raises(HTTPException) as e:
        auth_mod._validate_token_with_graph(jwt_with({"tid": TENANT}))
    assert e.value.status_code == 401


def test_no_tenant_configured_refuses_everyone(auth_mod, monkeypatch):
    monkeypatch.setattr(auth_mod, "ALLOWED_TENANTS", frozenset())
    monkeypatch.setattr(auth_mod, "_graph_session", FakeGraph())
    with pytest.raises(HTTPException) as e:
        auth_mod._validate_token_with_graph(jwt_with({"tid": TENANT}))
    assert e.value.status_code == 503


def test_tenant_list_is_read_from_env_comma_separated():
    out = subprocess.run(
        [sys.executable, "-c", "import auth; print(sorted(auth.ALLOWED_TENANTS))"],
        cwd=BACKEND, capture_output=True, text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "AZURE_TENANT_ID": f" {TENANT.upper()} , {OTHER_TENANT} "},
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == str(sorted([TENANT, OTHER_TENANT]))


def test_env_example_and_preflight_know_the_tenant():
    assert re.search(r"^AZURE_TENANT_ID=", (BACKEND / ".env.example").read_text(encoding="utf-8"), re.M)
    pre = (BACKEND / "scripts" / "preflight.py").read_text(encoding="utf-8")
    assert '"AZURE_TENANT_ID"' in pre


def test_preflight_hashes_match_this_release():
    sys.path.insert(0, str(BACKEND / "scripts"))
    try:
        preflight = importlib.import_module("preflight")
    finally:
        sys.path.pop(0)
    stale = [rel for rel, digest in preflight.EXPECTED.items()
             if preflight.file_hash(REPO / rel) != digest]
    assert not stale, f"preflight would FAIL these files: {stale}"


# ------------------------------------------------------- StreamSets TLS and SSH trust

@pytest.fixture
def ss(monkeypatch):
    import streamsets_extractor as m
    monkeypatch.setattr(m, "_config", {"url": "https://sch.example/ ", "username": "u", "password": "p"})
    monkeypatch.setattr(m, "_scripts", {})
    return m


@pytest.fixture
def host_key():
    paramiko = pytest.importorskip("paramiko")
    return paramiko.Ed25519Key.generate() if hasattr(paramiko.Ed25519Key, "generate") else paramiko.RSAKey.generate(1024)


def test_streamsets_checks_certificates_by_default(ss, monkeypatch):
    assert ss._settings()["verify"] is True
    monkeypatch.setitem(ss._config, "verify_ssl", False)
    assert ss._settings()["verify"] is False
    monkeypatch.setitem(ss._config, "ca_bundle", "/etc/ssl/corp.pem")
    assert ss._settings()["verify"] == "/etc/ssl/corp.pem"


def test_fingerprint_matches_ssh_keygen_format(ss, host_key):
    fp = ss._host_fingerprint(host_key)
    expected = base64.b64encode(hashlib.sha256(host_key.asbytes()).digest()).decode().rstrip("=")
    assert fp == "SHA256:" + expected


def test_ssh_refuses_unknown_host_and_accepts_pinned(ss, host_key, tmp_path):
    import paramiko
    empty = tmp_path / "known_hosts"
    empty.write_text("", encoding="utf-8")
    client = ss._ssh_client({"ssh_known_hosts": str(empty)})
    with pytest.raises(paramiko.SSHException):
        client._policy.missing_host_key(client, "sdc1.example", host_key)

    pinned = ss._ssh_client({"ssh_known_hosts": str(empty),
                             "ssh_host_keys": {"sdc1.example": ss._host_fingerprint(host_key)}})
    pinned._policy.missing_host_key(pinned, "sdc1.example", host_key)
    assert pinned.get_host_keys().lookup("sdc1.example")

    # A pin for one host doesn't vouch for another.
    with pytest.raises(paramiko.SSHException):
        pinned._policy.missing_host_key(pinned, "sdc2.example", host_key)


def test_ssh_loads_the_configured_known_hosts(ss, host_key, tmp_path):
    kh = tmp_path / "known_hosts"
    kh.write_text(f"sdc1.example {host_key.get_name()} {host_key.get_base64()}\n", encoding="utf-8")
    client = ss._ssh_client({"ssh_known_hosts": str(kh)})
    assert client.get_host_keys().lookup("sdc1.example")


def test_extractor_script_gets_the_same_trust(ss, monkeypatch):
    monkeypatch.setitem(ss._config, "ssh_known_hosts", "~/.ssh/sdc_hosts")
    monkeypatch.setitem(ss._config, "ssh_host_keys", {"sdc1": "SHA256:abc"})
    cfg = ss._settings()
    env = ss._script_env(cfg, ss._config, "/tmp/work")
    assert env["STREAMSETS_VERIFY"] == "true"
    assert env["STREAMSETS_SSH_KNOWN_HOSTS"] == "~/.ssh/sdc_hosts"
    assert json.loads(env["STREAMSETS_SSH_HOST_KEYS"]) == {"sdc1": "SHA256:abc"}
    assert env["STREAMSETS_URL"] == "https://sch.example"
    monkeypatch.setitem(ss._config, "ca_bundle", "/etc/ssl/corp.pem")
    assert ss._script_env(ss._settings(), ss._config, "/tmp/w")["STREAMSETS_VERIFY"] == "/etc/ssl/corp.pem"


def test_config_example_documents_ssh_trust():
    cfg = json.loads((BACKEND / "dq_config.example.json").read_text(encoding="utf-8"))
    section = cfg["streamsets_extractor"]
    assert section["verify_ssl"] is True
    assert "ssh_known_hosts" in section and "ssh_host_keys" in section


EXTRACTORS = ["Simplified_extractor.py", "Final_pipeline_extractor.py"]


def load_script(name, monkeypatch, tmp_path, **env):
    """Import an extractor the way it runs: the backend passes STREAMSETS_* in the
    environment; run by hand, it reads config.ini from the working folder."""
    for k in ("STREAMSETS_VERIFY", "STREAMSETS_SSH_KNOWN_HOSTS", "STREAMSETS_SSH_HOST_KEYS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("STREAMSETS_URL", "https://sch.example")
    monkeypatch.setenv("STREAMSETS_USERNAME", "u")
    monkeypatch.setenv("STREAMSETS_PASSWORD", "p")
    (tmp_path / "config.ini").write_text("[streamsets]\nurl = https://sch.example\nusername = u\npassword = p\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    path = REPO / "DQ_IT_Validation" / "Streamsets" / name
    spec = importlib.util.spec_from_file_location(f"_rc_{name[:-3]}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("name", EXTRACTORS)
def test_extractor_tls_setting(name, monkeypatch, tmp_path):
    pytest.importorskip("paramiko")
    mod = load_script(name, monkeypatch, tmp_path)
    for raw, want in [(None, True), ("true", True), ("FALSE", False), ("0", False),
                      ("/etc/ssl/corp.pem", "/etc/ssl/corp.pem")]:
        if raw is None:
            monkeypatch.delenv("STREAMSETS_VERIFY", raising=False)
        else:
            monkeypatch.setenv("STREAMSETS_VERIFY", raw)
        assert mod._tls_verify() == want, raw


@pytest.mark.parametrize("name", EXTRACTORS)
def test_extractor_ssh_trust(name, monkeypatch, tmp_path, host_key):
    import paramiko
    empty = tmp_path / "kh"
    empty.write_text("", encoding="utf-8")
    fp = "SHA256:" + base64.b64encode(hashlib.sha256(host_key.asbytes()).digest()).decode().rstrip("=")
    mod = load_script(name, monkeypatch, tmp_path, STREAMSETS_SSH_KNOWN_HOSTS=str(empty),
                      STREAMSETS_SSH_HOST_KEYS=json.dumps({"sdc1": fp}))
    client = mod._trusted_ssh_client()
    client._policy.missing_host_key(client, "sdc1", host_key)
    with pytest.raises(paramiko.SSHException):
        client._policy.missing_host_key(client, "sdc2", host_key)


@pytest.mark.parametrize("name", EXTRACTORS)
def test_extractor_has_no_unchecked_tls_or_autoadd(name):
    src = (REPO / "DQ_IT_Validation" / "Streamsets" / name).read_text(encoding="utf-8")
    assert "verify=False" not in src
    assert "AutoAddPolicy" not in src
    assert "setdefault('verify', False)" not in src


def test_fuzzy_search_verifies_before_configure():
    import fuzzy_search
    src = (BACKEND / "fuzzy_search.py").read_text(encoding="utf-8")
    assert '"verify": False' not in src
    assert fuzzy_search is not None


# Explicit opt-outs read from an env var, off only when someone sets it on purpose.
TLS_OPT_OUTS = {"assistant/tools.py"}


def test_no_backend_code_turns_tls_off_by_default():
    hits = []
    for py in own_py_files(BACKEND, skip=("tests",)):
        if py.relative_to(BACKEND).as_posix() in TLS_OPT_OUTS:
            continue
        for i, line in enumerate(py.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if re.search(r"verify\s*=\s*False|\"verify_ssl\",\s*False|AutoAddPolicy\(", line):
                hits.append(f"{py.relative_to(BACKEND)}:{i}")
    assert not hits, hits


# ------------------------------------------------------------- Data API error text

def test_error_reference_is_short_and_random():
    import data_api
    refs = {data_api._error_ref() for _ in range(50)}
    assert len(refs) == 50
    assert all(re.fullmatch(r"[0-9a-f]{10}", r) for r in refs)


def test_consumer_502s_never_echo_the_driver_error():
    tree = ast.parse((BACKEND / "data_api.py").read_text(encoding="utf-8"))
    leaks = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "HTTPException"
                and any(k.arg == "status_code" and getattr(k.value, "value", None) == 502 for k in node.keywords)):
            detail = next((k.value for k in node.keywords if k.arg == "detail"), None)
            if detail is not None and any(isinstance(n, ast.Name) and n.id == "e" for n in ast.walk(detail)):
                leaks.append(node.lineno)
    assert not leaks, f"502 detail built from the exception at lines {leaks}"


# --------------------------------------------------------- hashing kept its output

def test_row_hash_unchanged():
    from data_validation import _row_hash
    row = {"a": 1, "b": "x "}
    assert _row_hash(row, ["a", "b"]) == hashlib.md5("1\x1fx".encode()).hexdigest()


def test_index_names_unchanged():
    from indexer import index_name
    long = "t" * 70
    name = index_name(long, "col", "btree")
    assert len(name.encode()) <= 63
    full = f"idx_{long}_col_btree"
    assert name.endswith("_" + hashlib.sha1(full.encode()).hexdigest()[:8] + "_btree")
    assert index_name("T", "Name", "gin") != index_name("t", "name", "gin")


# ---------------------------------------------------- every module still imports

MODULES = sorted(p.stem for p in BACKEND.glob("*.py")
                 if p.stem not in {"denodo_test"} and not p.stem.startswith("test_"))


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name):
    env = {**os.environ, "CORS_ORIGINS": os.environ.get("CORS_ORIGINS") or "http://localhost:5173"}
    out = subprocess.run([sys.executable, "-c", f"import {name}"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]


# ----------------------------------------------------------- dependency manifest

def third_party_imports(root: Path, skip_dirs=("tests", "scripts"), extra=()) -> set:
    files = list(own_py_files(root, skip=skip_dirs)) + list(extra)
    local = {p.stem for p in files} | {p.stem for p in BACKEND.glob("*.py")} | {"assistant", "scripts", "tests"}
    found = set()
    for py in files:
        for node in ast.walk(ast.parse(py.read_text(encoding="utf-8", errors="ignore"))):
            if isinstance(node, ast.Import):
                found |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module.split(".")[0])
    return {m for m in found if m not in sys.stdlib_module_names and m not in local}


IMPORT_TO_DIST = {"snowflake": "snowflake-connector-python", "psycopg2": "psycopg2-binary", "yaml": "PyYAML",
                  "jaydebeapi": "JayDeBeApi", "jpype": "JPype1", "dotenv": "python-dotenv",
                  "multipart": "python-multipart", "pymysql": "PyMySQL", "botocore": "boto3"}
# Optional extras loaded inside try/except, with a fallback when missing.
OPTIONAL = {"anyio", "redis", "azure", "mcp", "httpx", "ragas", "datasets", "langchain_openai", "langchain_core",
            "pgserver", "urllib3", "starlette", "pydantic_core", "sentence_transformers", "tiktoken"}
# anyio, starlette and pydantic_core arrive with fastapi; urllib3 with requests.


def requirement_names(path: Path) -> set:
    names = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#")[0].strip()
        if line:
            names.add(re.split(r"[\[<>=~! ]", line, maxsplit=1)[0].lower())
    return names


# Backend files the Pipeline Studio runner loads under the validation Python
# (scripts.python_path), which installs DQ_IT_Validation/requirements.txt.
VALIDATION_PYTHON_FILES = [BACKEND / f for f in ("pipeline_validation.py", "pipeline_sources.py", "pipeline_transforms.py")]


@pytest.mark.parametrize("folder,req,extra", [
    (BACKEND, BACKEND / "requirements.txt", ()),
    (REPO / "DQ_IT_Validation", REPO / "DQ_IT_Validation" / "requirements.txt", VALIDATION_PYTHON_FILES),
    (REPO / "Email_reports", REPO / "Email_reports" / "requirements.txt", ()),
])
def test_every_import_is_in_requirements(folder, req, extra):
    names = requirement_names(req)
    used = third_party_imports(folder, extra=extra)
    if extra:
        # The runner never imports the web stack; those lines sit behind its argparse entry point.
        used -= {"fastapi", "pydantic"}
    missing = sorted(m for m in used - OPTIONAL
                     if IMPORT_TO_DIST.get(m, m).lower() not in names)
    assert not missing, f"{req.relative_to(REPO)} lacks {missing}"


@pytest.mark.parametrize("req", ["backend/requirements.txt", "DQ_IT_Validation/requirements.txt",
                                 "Email_reports/requirements.txt"])
def test_requirements_are_pinned(req):
    loose = [l for l in (REPO / req).read_text(encoding="utf-8").splitlines()
             if l.strip() and not l.startswith("#") and "~=" not in l and "==" not in l]
    assert not loose, loose


@pytest.mark.parametrize("req", ["backend/requirements.txt", "DQ_IT_Validation/requirements.txt",
                                 "Email_reports/requirements.txt"])
def test_no_package_dropped_since_main(req, tmp_path):
    """Pinning must not lose anything: some users of these environments live
    outside this repo (the DQ engine, the Streamlit chatbot), so a scan can't
    prove a package unused."""
    old = subprocess.run(["git", "show", f"main:{req}"], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if old.returncode:
        pytest.skip("no main branch to compare with")
    (tmp_path / "old.txt").write_text(old.stdout, encoding="utf-8")
    dropped = requirement_names(tmp_path / "old.txt") - requirement_names(REPO / req)
    assert not dropped, f"{req} no longer lists {sorted(dropped)}"


# -------------------------------------------------------------- repo hygiene

def test_no_denodo_probe_output_tracked():
    tracked = subprocess.run(["git", "ls-files", "*.nx"], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    assert not tracked.strip()
    assert "*.json.nx" in (BACKEND / ".gitignore").read_text(encoding="utf-8")


def test_gitignore_audit_spool_line_fixed():
    lines = (BACKEND / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "/audit_spool/" in lines
    assert "ingestion_lab.yaml/audit_spool/" not in lines


# ------------------------------------------------- portal "Reduce motion" setting

def test_reduce_motion_preference_round_trip(monkeypatch):
    import contextlib
    import audit

    rows = {}

    class Conn:
        def execute(self, sql, params):
            if sql.lstrip().startswith("SELECT"):
                email = params[0]
                self.row = {"reduce_motion": rows[email]} if email in rows else None
            else:
                rows[params["email"]] = params["reduce_motion"]
                self.row = {"reduce_motion": rows[params["email"]]}
            return self

        def fetchone(self):
            return self.row

    monkeypatch.setattr(audit, "_db", lambda **_: contextlib.nullcontext(Conn()))
    who = {"user": {"email": "ana.rivera@its.jnj.com"}}

    assert audit.get_preferences(auth=who) == {"preferences": {"reduce_motion": False}}
    saved = audit.put_preferences(audit.PreferencesRequest(reduce_motion=True), auth=who)
    assert saved["preferences"] == {"reduce_motion": True}
    assert audit.get_preferences(auth=who) == {"preferences": {"reduce_motion": True}}


def test_reduce_motion_preference_is_open_to_every_signed_in_user():
    import audit

    routes = {(r.path, m): r for r in audit.audit_router.routes for m in r.methods}
    for method in ("GET", "PUT"):
        deps = [d.call for d in routes[("/api/audit/preferences", method)].dependant.dependencies]
        assert audit.require_auth in deps
