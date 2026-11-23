#!/usr/bin/env python3
"""Release check for the production-hardening branch.

Covers every change in the release, in four stages:

  static   lint, frontend build, bundle sizes, moved code still matches main,
           installed packages match the pinned requirements, preflight
  unit     backend pytest (incl. tests/test_release_changes.py) and
           frontend vitest (tests/release.test.jsx)
  api      the live backend: health, sign-in rules, one read per changed
           module, Data API consumer calls, StreamSets, assistant navigation
  ui       the live portal in Chromium at six screen sizes: layout, drawer,
           skip link, command palette, every Data Studio pane, every page
           the assistant can open, the explorers' search boxes

Usage (from the repo root):

  python scripts/release_check.py                       # static + unit only
  python scripts/release_check.py --login \\
      --app-url https://smarthub.example.com --api-url https://smarthub-api.example.com
                                                        # first run: a browser opens, sign in once
  python scripts/release_check.py --app-url ... --api-url ...
                                                        # everything, headless, with your session

Optional live inputs:
  --data-api-id / --data-api-key / --data-api-alias   a Data API to call as a consumer
  --streamsets-resource PIPELINE_ID:relative/path     a resource file to read over SSH
  --token                                             a bearer token instead of the browser session

The browser session is kept in .release_check/profile (git-ignored). It holds
your sign-in, so don't copy it anywhere. Results land in .release_check/<time>/:
report.json and a screenshot per page and screen size.

Exit code 0 when nothing failed. SKIP means the check couldn't run here (no
permission, not configured, no input given) and says why.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
FRONTEND = REPO / "frontend"
STATE = REPO / ".release_check"

VIEWPORTS = [(375, 812, "phone"), (768, 1024, "tablet"), (1024, 768, "small-laptop"),
             (1280, 800, "laptop"), (1920, 1080, "desktop"), (2560, 1440, "qhd")]

# ------------------------------------------------------------------- reporting

results: list[dict] = []
COLORS = {"PASS": "\033[32m", "FAIL": "\033[31m", "SKIP": "\033[33m"}


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def record(stage: str, name: str, status: str, detail: str = ""):
    results.append({"stage": stage, "check": name, "status": status, "detail": detail})
    tint = COLORS[status] if sys.stdout.isatty() else ""
    reset = "\033[0m" if tint else ""
    line = f"  {tint}{status:4}{reset}  {name}"
    print(line + (f"  - {detail}" if detail else ""), flush=True)


def check(stage: str, name: str):
    """Decorator-free helper: `with check(...) as c:` records PASS unless c.fail/c.skip or an exception."""
    return _Check(stage, name)


class _Check:
    def __init__(self, stage, name):
        self.stage, self.name, self.status, self.detail = stage, name, "PASS", ""

    def fail(self, detail):
        self.status, self.detail = "FAIL", detail

    def skip(self, detail):
        self.status, self.detail = "SKIP", detail

    def note(self, detail):
        self.detail = detail

    def __enter__(self):
        return self

    def __exit__(self, kind, err, _tb):
        if err is not None:
            self.status, self.detail = "FAIL", f"{kind.__name__}: {err}"[:500]
        record(self.stage, self.name, self.status, self.detail)
        return True


def run(cmd, cwd, timeout=1800, env=None):
    # UTF-8 both ways: Windows consoles default to cp1252, which can't read the
    # emoji and arrows some tools and files print.
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                         timeout=timeout, shell=isinstance(cmd, str),
                         env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", **(env or {})})
    return out.returncode, (out.stdout or "") + (out.stderr or "")


def tail(text, n=15):
    return " | ".join(l.strip() for l in text.strip().splitlines()[-n:] if l.strip())[:900]


NPM = "npm.cmd" if os.name == "nt" else "npm"
NPX = "npx.cmd" if os.name == "nt" else "npx"

# ---------------------------------------------------------------------- static


def stage_static(args):
    print("\nStatic checks")
    with check("static", "frontend lint: 0 errors, 0 warnings") as c:
        code, out = run([NPX, "eslint", ".", "--max-warnings=0"], FRONTEND)
        if code:
            c.fail(tail(out))

    if not args.skip_build:
        with check("static", "frontend production build") as c:
            code, out = run([NPX, "vite", "build"], FRONTEND)
            if code:
                c.fail(tail(out))
    bundle_checks()
    moved_code_checks()

    with check("static", "backend compiles, no undefined names or unused imports") as c:
        code, out = run([sys.executable, "-m", "ruff", "check", "--select", "E9,F", "--exclude",
                         "tests,assistant/tests", "-q", "."], BACKEND)
        if "No module named ruff" in out:
            code, out = run([sys.executable, "-m", "compileall", "-q", "."], BACKEND)
            c.note("ruff not installed; compile check only (pip install ruff for the full check)")
        if code:
            c.fail(tail(out))

    for req in ("backend/requirements.txt", "DQ_IT_Validation/requirements.txt", "Email_reports/requirements.txt"):
        with check("static", f"installed packages satisfy {req}") as c:
            bad = unmet_requirements(REPO / req)
            if bad is None:
                c.skip("pip's 'packaging' module isn't installed")
            elif bad:
                c.fail("; ".join(bad))

    with check("static", "preflight: reviewed files, tenant setting, database") as c:
        code, out = run([sys.executable, "scripts/preflight.py"], BACKEND, timeout=300)
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL")]
        if any(f.startswith("FAIL  SMARTHUB_DB_DSN") for f in fails):
            # Not a server environment: only the reviewed-files part applies here.
            fails = [f for f in fails if not f.startswith(("FAIL  SMARTHUB_DB_DSN", "FAIL  AZURE_TENANT_ID"))]
            c.note("no backend/.env here: checked the reviewed files only (run on the server for the rest)")
        if fails:
            c.fail("; ".join(fails)[:900])


def unmet_requirements(path: Path):
    try:
        from importlib.metadata import PackageNotFoundError, version
        from packaging.requirements import Requirement
    except ImportError:
        return None
    bad = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        req = Requirement(line)
        try:
            have = version(req.name)
        except PackageNotFoundError:
            bad.append(f"{req.name} not installed")
            continue
        if not req.specifier.contains(have, prereleases=True):
            bad.append(f"{req.name} {have} (wants {req.specifier})")
    return bad


def bundle_checks():
    dist = FRONTEND / "dist"
    with check("static", "bundle: first page loads under 200 kB of app code, vendors split") as c:
        if not dist.exists():
            c.skip("no frontend/dist; run without --skip-build")
            return
        html = (dist / "index.html").read_text(encoding="utf-8")
        first = re.findall(r'(?:src|href)="/?(assets/[^"]+\.js)"', html)
        entry = [f for f in first if re.match(r"assets/index-", f)]
        size = (dist / entry[0]).stat().st_size if entry else 0
        problems = []
        if not entry:
            problems.append("no entry chunk in index.html")
        elif size > 200_000:
            problems.append(f"entry is {size // 1000} kB")
        for vendor in ("vendor-react", "vendor-msal"):
            if not any(vendor in f for f in first):
                problems.append(f"{vendor} not preloaded")
        for lazy in ("vendor-three", "vendor-r3f", "vendor-charts"):
            if any(lazy in f for f in first):
                problems.append(f"{lazy} loads on the first page")
        if problems:
            c.fail("; ".join(problems))
        else:
            c.note(f"entry {size // 1000} kB")

    with check("static", "bundle: each Data Studio pane is its own file") as c:
        if not dist.exists():
            c.skip("no frontend/dist")
            return
        names = [p.name for p in (dist / "assets").glob("*.js")]
        missing = [p for p in ("sf_pg_pane-", "indexer-", "S3Pane-", "StreamsetsPane-", "DataShuttle-")
                   if not any(n.startswith(p) for n in names)]
        studio = [n for n in names if n.startswith("DataStudio-")]
        if missing:
            c.fail(f"no separate chunk for {missing}")
        elif studio and (dist / "assets" / studio[0]).stat().st_size > 100_000:
            c.fail(f"DataStudio chunk still {(dist / 'assets' / studio[0]).stat().st_size // 1000} kB")

    with check("static", "bundle: no file over 900 kB") as c:
        if not dist.exists():
            c.skip("no frontend/dist")
            return
        big = [f"{p.name} {p.stat().st_size // 1000} kB" for p in (dist / "assets").glob("*.js")
               if p.stat().st_size > 900_000]
        if big:
            c.fail(", ".join(big))


# Code that moved to a new file must come out byte-for-byte the same as it was on
# main, apart from the export keyword. Changes made on purpose are listed here.
MOVES = [
    ("frontend/src/pages/components/CommunicationParts.jsx", "frontend/src/pages/components/communicationLib.js", {}),
    ("frontend/src/pages/dataApi/ui.jsx", "frontend/src/pages/dataApi/highlight.js", {}),
    ("frontend/src/pages/dataStudio/indexer.jsx", "frontend/src/pages/dataStudio/indexerLib.js", {}),
    ("frontend/src/context/RBACContext.jsx", "frontend/src/config/permissions.js", {}),
    ("frontend/src/pages/Dashboard.jsx", "frontend/src/utils/events.js", {}),
    ("frontend/src/pages/dataApi/Publish.jsx", "frontend/src/pages/dataApi/markdown.js",
     {"escHtml": "now escapes double quotes so a link can't break out of href"}),
    ("frontend/src/pages/components/ChunkExplorer.jsx", "frontend/src/components/SearchSection.jsx",
     {"SearchSection": "recount runs on new children instead of every render; same result"}),
]
DECL = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)", re.M)


def top_level(src: str) -> dict:
    """name -> declaration text, split at column-0 declarations."""
    marks = [(m.start(), m.group(1)) for m in DECL.finditer(src)]
    out = {}
    for i, (start, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(src)
        body = src[start:end]
        body = re.sub(r"\n(?:\s*\n|(?://|/\*|\s\*)[^\n]*\n)*\s*$", "\n", body + "\n")   # trailing comments
        out[name] = re.sub(r"^export\s+(default\s+)?", "", body).strip()
    return out


def git_show(ref_path: str):
    code, out = run(["git", "show", ref_path], REPO)
    return out if code == 0 else None


def moved_code_checks():
    for old, new, changed in MOVES:
        name = f"moved code unchanged: {Path(new).name} vs main:{Path(old).name}"
        with check("static", name) as c:
            before = git_show(f"main:{old}")
            if before is None:
                c.skip("no 'main' branch here to compare with")
                continue
            now = top_level((REPO / new).read_text(encoding="utf-8"))
            was = top_level(before)
            diffs = []
            for sym, body in now.items():
                if sym in changed:
                    continue
                if sym not in was:
                    diffs.append(f"{sym} is new")
                elif re.sub(r"\s+", " ", was[sym]) != re.sub(r"\s+", " ", body):
                    diffs.append(f"{sym} differs")
            if diffs:
                c.fail(", ".join(diffs))
            else:
                c.note(f"{len(now)} declarations" + (f"; intended: {', '.join(changed)}" if changed else ""))


# ------------------------------------------------------------------------ unit


def stage_unit(args):
    print("\nUnit tests")
    with check("unit", "frontend: vitest tests/release.test.jsx") as c:
        code, out = run([NPX, "vitest", "run"], FRONTEND)
        m = re.search(r"Tests\s+(.+?)\n", out)
        c.note(m.group(1).strip() if m else "")
        if code:
            c.fail(tail(out, 25))

    with check("unit", "backend: full pytest suite") as c:
        code, out = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests", "assistant/tests",
                         "--ignore=assistant/tests/eval_live.py",
                         "--deselect", "tests/test_data_api_retrieval_pg.py",
                         "--deselect", "tests/test_shared_worksheets.py",
                         "--deselect", "tests/test_ingestion_lab.py"], BACKEND, timeout=3600)
        summary = [l for l in out.splitlines() if re.search(r"\d+ (passed|failed)", l)]
        c.note(summary[-1].strip("= ") if summary else "")
        if "No module named pytest" in out:
            c.fail("pytest isn't installed in this Python: pip install -r backend/requirements-dev.txt")
        elif code:
            c.fail(tail("\n".join(l for l in out.splitlines() if l.startswith(("FAILED", "ERROR"))) or out, 20))

    # Each database suite owns the process-wide schema setting, so they run one per process.
    for test, dsn in (("tests/test_data_api_retrieval_pg.py", "DATA_API_TEST_PG_DSN"),
                      ("tests/test_shared_worksheets.py", "SHARED_WS_TEST_PG_DSN"),
                      ("tests/test_ingestion_lab.py", "INGESTION_TEST_PG_DSN")):
        with check("unit", f"backend on PostgreSQL: {Path(test).stem}") as c:
            if not os.environ.get(dsn):
                c.skip(f"set {dsn} to a scratch database to run it")
                continue
            code, out = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", test], BACKEND, timeout=1800)
            summary = [l for l in out.splitlines() if re.search(r"\d+ (passed|failed)", l)]
            c.note(summary[-1].strip("= ") if summary else "")
            if code:
                c.fail(tail(out, 20))


# ------------------------------------------------------------------------- api


class Api:
    def __init__(self, base, token):
        import requests
        self.base, self.token = base.rstrip("/"), token
        self.http = requests.Session()
        try:
            import truststore
            truststore.inject_into_ssl()
        except ImportError:
            pass

    def get(self, path, token=..., **kw):
        headers = kw.pop("headers", {})
        tok = self.token if token is ... else token
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        return self.http.get(self.base + path, headers=headers, timeout=60, **kw)


def classify(c, r, what=""):
    """200 passes; 403 and 'not configured' 503s skip; anything else fails."""
    body = r.text[:300]
    if r.status_code == 200:
        return True
    if r.status_code == 403:
        c.skip(f"{what}this account lacks the permission")
    elif r.status_code == 503 and "Identity provider" in body:
        c.fail(f"{what}the server can't reach Microsoft Graph to check sign-ins")
    elif r.status_code in (400, 503) and re.search(
            r"not configured|not available|unavailable|not set|configuration missing|section found", body, re.I):
        c.skip(f"{what}not configured on this server: {body[:160]}")
    else:
        c.fail(f"{what}HTTP {r.status_code}: {body[:200]}")
    return False


# One cheap read per backend module this release touched.
MODULE_READS = [
    ("audit", "/api/audit/stats"), ("audit (people view)", "/api/audit/people"),
    ("review", "/api/review/badge"), ("bdc_admin", "/api/bdc/summary"),
    ("data_shuttle", "/api/shuttle/health"), ("epod", "/api/epod/summary"), ("fda", "/api/fda/summary"),
    ("haq", "/api/haq/summary"), ("nipo", "/api/nipo/summary"), ("indexer", "/index-health/databases"),
    ("rag", "/rag/profiles"), ("streamsets_extractor", "/api/streamsets/health"),
    ("data_api", "/data-api/list"), ("fuzzy_search", "/search/databases"),
]

# Plain requests the assistant must open straight away (portal map fixes).
NAV_PHRASES = [
    ("open pipeline studio", "pipelines"), ("take me to the about us page", "about"),
    ("open the rag evaluation page", "rag.evaluation"),
    ("take me to the IND/CTA data quality tracker", "dqe.indcta"),
    ("open the safety data quality dashboard", "dqe.safety"),
    ("open the audit people view", "audit.people"), ("open cortellis in virtual regulator", "un.vr.cortellis"),
    ("take me to the SF query runner", "studio.snowflake"), ("open the postgres query runner", "studio.postgres"),
]


def token_tid(token):
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("tid")
    except Exception:
        return None


def stage_api(args, token):
    print("\nLive backend")
    if not args.api_url:
        record("api", "live backend", "SKIP", "pass --api-url")
        return {}
    api = Api(args.api_url, token)

    with check("api", "GET /health") as c:
        r = api.get("/health", token=None)
        if r.status_code != 200:
            c.fail(f"HTTP {r.status_code}")
        else:
            db = (r.json() or {}).get("database") or {}
            c.note(f"database ok={db.get('ok')}")
            if db and db.get("ok") is False:
                c.fail(f"database not ok: {db}")

    with check("api", "GET /api/audit/preferences (Reduce motion setting)") as c:
        r = api.get("/api/audit/preferences")
        if r.status_code != 200:
            c.fail(f"HTTP {r.status_code}")
        elif not isinstance(((r.json() or {}).get("preferences") or {}).get("reduce_motion"), bool):
            c.fail(f"unexpected body: {r.text[:200]}")

    with check("api", "no token is refused (401)") as c:
        r = api.get("/api/rbac/config", token=None)
        if r.status_code != 401:
            c.fail(f"HTTP {r.status_code}")

    with check("api", "a made-up token is refused (401)") as c:
        r = api.get("/api/rbac/config", token="not-a-token")
        if r.status_code == 503:
            c.fail("HTTP 503: the server can't reach Microsoft Graph to check sign-ins")
        elif r.status_code != 401:
            c.fail(f"HTTP {r.status_code}")

    with check("api", "a token claiming another tenant is refused") as c:
        fake = "e30." + base64.urlsafe_b64encode(json.dumps(
            {"tid": "00000000-0000-0000-0000-000000000000"}).encode()).decode().rstrip("=") + ".x"
        r = api.get("/api/rbac/config", token=fake)
        if r.status_code not in (401, 503):
            c.fail(f"HTTP {r.status_code}")

    perms = {}
    with check("api", "your real sign-in is accepted (tenant pin lets your organization in)") as c:
        if not token:
            c.skip("no token: sign in with --login or pass --token")
        else:
            r = api.get("/api/rbac/config")
            if r.status_code == 503 and "AZURE_TENANT_ID" in r.text:
                c.fail("server has no AZURE_TENANT_ID set - every sign-in is refused")
            elif r.status_code != 200:
                c.fail(f"HTTP {r.status_code}: {r.text[:200]}")
            else:
                body = r.json()
                perms = body.get("caller_permissions") or {}
                c.note(f"role {body.get('caller_role')}, tenant {token_tid(token) or 'n/a'}")

    if not perms:
        record("api", "signed-in checks", "SKIP", "no accepted sign-in, see above")
        return perms

    for module, path in MODULE_READS:
        with check("api", f"{module}: GET {path}") as c:
            classify(c, api.get(path))

    data_api_checks(args, api)
    streamsets_checks(args, api)
    assistant_checks(args, api, perms)
    return perms


def data_api_checks(args, api):
    if not (args.data_api_id and args.data_api_key):
        record("api", "Data API consumer calls", "SKIP", "pass --data-api-id and --data-api-key (and --data-api-alias)")
        return
    key = {"X-API-Key": args.data_api_key}
    base = f"/data-api/{args.data_api_id}"
    alias = args.data_api_alias
    with check("api", "Data API: list tables with the key") as c:
        r = api.get(f"{base}/tables", token=None, headers=dict(key))
        if r.status_code != 200:
            c.fail(f"HTTP {r.status_code}: {r.text[:200]}")
        elif not alias:
            tables = r.json().get("tables") or []
            alias = tables[0].get("alias") if tables else None
            c.note(f"{len(tables)} tables; using alias {alias}")
    for endpoint in ("columns", "count", "rows"):
        with check("api", f"Data API: {endpoint} for {alias}") as c:
            if not alias:
                c.skip("no alias")
                continue
            params = {"limit": 5} if endpoint == "rows" else None
            r = api.get(f"{base}/{alias}/{endpoint}", token=None, headers=dict(key), params=params)
            if r.status_code == 502:
                ok = re.search(r"Reference: [0-9a-f]{10}", r.text)
                c.fail(f"source failed{' (driver text hidden, good)' if ok else ' and leaked: ' + r.text[:200]}")
            elif r.status_code != 200:
                c.fail(f"HTTP {r.status_code}: {r.text[:200]}")
    with check("api", "Data API: unknown alias is a clean 404") as c:
        r = api.get(f"{base}/no_such_alias_release_check/columns", token=None, headers=dict(key))
        if r.status_code != 404:
            c.fail(f"HTTP {r.status_code}: {r.text[:200]}")
    with check("api", "Data API: wrong key is refused") as c:
        r = api.get(f"{base}/tables", token=None, headers={"X-API-Key": "wrong-key"})
        if r.status_code not in (401, 403):
            c.fail(f"HTTP {r.status_code}")


def streamsets_checks(args, api):
    with check("api", "StreamSets: Control Hub reachable with certificate checks on") as c:
        r = api.get("/api/streamsets/pipelines")
        classify(c, r)
    with check("api", "StreamSets: resource file read over SSH (host key trusted)") as c:
        if not args.streamsets_resource:
            c.skip("pass --streamsets-resource PIPELINE_ID:relative/path")
            return
        pipeline, _, path = args.streamsets_resource.partition(":")
        r = api.get("/api/streamsets/resource", params={"pipeline_id": pipeline, "path": path})
        if r.status_code == 200:
            c.note(f"read from {r.json().get('host')}")
        else:
            c.fail(f"HTTP {r.status_code}: {r.text[:300]} - if the server log says 'untrusted host key', "
                   "add that fingerprint to ssh_host_keys or the host to known_hosts")


def assistant_checks(args, api, perms):
    if perms and perms.get("viewAssistantAvatar") is not True:
        record("api", "assistant navigation", "SKIP", "this account can't use the assistant")
        return
    if args.no_assistant:
        record("api", "assistant navigation", "SKIP", "--no-assistant given")
        return
    for phrase, expect in NAV_PHRASES:
        with check("api", f"assistant opens '{phrase}'") as c:
            r = api.http.post(api.base + "/assistant/chat", stream=True, timeout=90,
                              headers={"Authorization": f"Bearer {api.token}", "Accept": "text/event-stream"},
                              json={"messages": [{"role": "user", "content": phrase}],
                                    "screen": {"route": "/dashboard", "url": "/dashboard"}})
            if r.status_code != 200:
                classify(c, r)
                continue
            found = None
            problem = None
            started = time.time()
            for raw in r.iter_lines(decode_unicode=True):
                if raw and raw.startswith("data:"):
                    try:
                        event = json.loads(raw[5:].strip())
                    except ValueError:
                        continue
                    if event.get("type") == "error":
                        problem = event.get("message") or "error"
                        break
                    action = event.get("action") or {}
                    if action.get("name") == "navigate_to":
                        found = action.get("args") or {}
                        break
                if time.time() - started > 60:
                    break
            r.close()
            if problem and "not configured" in problem:
                c.skip(f"assistant {problem}")
            elif problem:
                c.fail(problem)
            elif not found:
                c.fail("no navigate action came back")
            elif found.get("destination") != expect:
                c.fail(f"went to {found.get('destination')} ({found.get('label')})")


# -------------------------------------------------------------------------- ui


def stage_ui(args, out_dir, token_box):
    print("\nLive portal in the browser")
    if not args.app_url:
        record("ui", "live portal", "SKIP", "pass --app-url")
        return
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        record("ui", "live portal", "FAIL", "pip install playwright && python -m playwright install chromium")
        return
    app = args.app_url.rstrip("/")
    profile = STATE / "profile"
    profile.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        ctx = open_browser(pw, profile, args)
        if ctx is None:
            return
        errors: list[str] = []

        def watch(page):
            page.on("pageerror", lambda e: errors.append(f"{page.url}: {e}"))
            if args.api_url:
                api = args.api_url.rstrip("/")

                def grab(req):
                    auth = req.headers.get("authorization", "")
                    if req.url.startswith(api) and auth.startswith("Bearer "):
                        token_box["token"] = auth[7:]
                page.on("request", grab)
            return page

        page = watch(ctx.pages[0] if ctx.pages else ctx.new_page())
        with check("ui", "signed in") as c:
            page.goto(app + "/dashboard", wait_until="domcontentloaded")
            deadline = time.time() + (300 if args.login else 45)
            if args.login:
                print("    Sign in in the browser window; the check carries on once the dashboard shows.")
            while time.time() < deadline:
                if "/dashboard" in page.url and page.locator("main#main-content").count():
                    break
                page.wait_for_timeout(1000)
            else:
                c.fail(f"still at {page.url} - run once with --login")
                ctx.close()
                return
            page.wait_for_load_state("networkidle")

        perms = fetch_perms(page, args)
        sections = [("screen sizes", lambda: shell_checks(ctx, watch, app, out_dir)),
                    ("skip link", lambda: skip_link_check(ctx, watch, app)),
                    ("command palette", lambda: palette_check(ctx, watch, app)),
                    ("reduce motion", lambda: motion_check(ctx, watch, app)),
                    ("Data Studio", lambda: data_studio_checks(ctx, watch, app, perms)),
                    ("every page", lambda: destination_checks(ctx, watch, app, perms, out_dir)),
                    ("explorer search", lambda: explorer_search_checks(ctx, watch, app, perms))]
        for label, section in sections:
            try:
                section()
            except Exception as e:  # one broken section shouldn't hide the rest
                record("ui", f"{label}: stopped early", "FAIL", f"{type(e).__name__}: {str(e).splitlines()[0][:300]}")

        with check("ui", "no uncaught script errors anywhere in the run") as c:
            if errors:
                c.fail(f"{len(errors)}: " + " | ".join(errors[:5]))
        ctx.close()


def token_from_browser(args):
    """Bearer token from the saved browser session, for an API-only run.
    Opens the portal (visibly with --login), waits for its first call to the
    backend and keeps the token that call carried."""
    if not (args.app_url and args.api_url):
        return None
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    api = args.api_url.rstrip("/")
    seen = {}
    STATE.joinpath("profile").mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        ctx = open_browser(pw, STATE / "profile", args)
        if ctx is None:
            return None
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def grab(req):
            auth = req.headers.get("authorization", "")
            if req.url.startswith(api) and auth.startswith("Bearer "):
                seen["token"] = auth[7:]
        page.on("request", grab)
        if args.login:
            print("    Sign in in the browser window; the check carries on once the dashboard shows.")
        page.goto(args.app_url.rstrip("/") + "/dashboard", wait_until="domcontentloaded")
        deadline = time.time() + (300 if args.login else 45)
        while time.time() < deadline and "token" not in seen:
            page.wait_for_timeout(500)
        ctx.close()
    return seen.get("token")


def open_browser(pw, profile, args):
    """Playwright's own Chromium if installed, else the machine's Chrome or Edge
    (handy on locked-down laptops that can't download browsers)."""
    channels = [args.browser] if args.browser != "auto" else ["chromium", "chrome", "msedge"]
    last = None
    for channel in channels:
        try:
            return pw.chromium.launch_persistent_context(
                str(profile), channel=None if channel == "chromium" else channel,
                headless=not (args.login or args.headed), viewport={"width": 1280, "height": 800})
        except Exception as e:  # browser not installed: try the next one
            last = e
    record("ui", "start a browser", "FAIL", f"{str(last).splitlines()[0][:200]} - run "
           "'python -m playwright install chromium' or pass --browser chrome / msedge")
    return None


def fetch_perms(page, args):
    """The signed-in user's permissions, read the way the portal reads them."""
    if not args.api_url:
        return {}
    got = {}

    def on_response(resp):
        if resp.url.endswith("/api/rbac/config") and resp.ok:
            try:
                got.update(resp.json().get("caller_permissions") or {})
            except Exception:
                pass
    page.on("response", on_response)
    page.reload(wait_until="networkidle")
    return got


def overflow_x(page):
    return page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")


def aside_class(page):
    return page.evaluate("document.querySelector('aside#main-navigation')?.className || ''")


def shell_checks(ctx, watch, app, out_dir):
    for w, h, label in VIEWPORTS:
        page = watch(ctx.new_page())
        page.set_viewport_size({"width": w, "height": h})
        for path in ("/dashboard", "/about"):
            with check("ui", f"{label} {w}px {path}: fits the screen") as c:
                page.goto(app + path, wait_until="networkidle")
                page.wait_for_timeout(600)
                page.screenshot(path=str(out_dir / f"{label}{path.replace('/', '_')}.png"), full_page=False)
                if overflow_x(page):
                    c.fail("page scrolls sideways")

            with check("ui", f"{label} {w}px {path}: navigation layout") as c:
                cls = aside_class(page)
                if w < 1024:
                    if "mobile" not in cls or "drawer" in cls:
                        c.fail(f"expected a closed drawer, aside is '{cls}'")
                    elif not page.locator("button[aria-controls='main-navigation']").first.is_visible():
                        c.fail("no menu button")
                elif path == "/dashboard" and w < 1280 and " open" in f" {cls}":
                    c.fail("sidebar should start collapsed below 1280px")
                elif path == "/dashboard" and w >= 1280 and " open" not in f" {cls}":
                    c.fail("sidebar should start expanded from 1280px")
                elif "mobile" in cls:
                    c.fail("drawer mode at desktop width")

            if w < 1024:
                drawer_checks(page, app, label, w, path)
        page.close()


def drawer_checks(page, app, label, w, path):
    menu = page.locator("button[aria-controls='main-navigation']").first
    is_open = lambda: "drawer" in aside_class(page)

    def reopen():
        menu.click()
        page.wait_for_timeout(400)
        return is_open()

    with check("ui", f"{label} {w}px {path}: drawer opens and Escape closes it") as c:
        if not reopen():
            c.fail("menu button didn't open it")
        else:
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            if is_open():
                c.fail("Escape left it open")

    with check("ui", f"{label} {w}px {path}: tapping outside closes the drawer") as c:
        reopen()
        page.mouse.click(w - 8, 400)
        page.wait_for_timeout(400)
        if is_open():
            c.fail("still open")

    with check("ui", f"{label} {w}px {path}: picking a page closes the drawer and goes there") as c:
        reopen()
        link = page.locator("aside#main-navigation a.sb-link:not(.on)").first
        target = link.get_attribute("href")
        link.click()
        page.wait_for_timeout(1200)
        if is_open():
            c.fail("still open after navigating")
        elif target and target not in page.url:
            c.fail(f"expected {target}, at {page.url}")
        page.goto(app + path, wait_until="networkidle")


def skip_link_check(ctx, watch, app):
    page = watch(ctx.new_page())
    with check("ui", "keyboard: first Tab shows 'Skip to content', Enter lands in the page") as c:
        page.goto(app + "/about", wait_until="networkidle")
        page.keyboard.press("Tab")
        info = page.evaluate("({cls: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top})")
        if "skip-link" not in info["cls"]:
            c.fail(f"first Tab went to '{info['cls']}'")
        elif info["top"] < 0:
            c.fail("skip link focused but off screen")
        else:
            page.keyboard.press("Enter")
            page.wait_for_timeout(300)
            if page.evaluate("document.activeElement.id") != "main-content" and "#main-content" not in page.url:
                c.fail("Enter didn't move to the page content")
    page.close()


def palette_check(ctx, watch, app):
    page = watch(ctx.new_page())
    with check("ui", "header search opens the command palette") as c:
        page.goto(app + "/dashboard", wait_until="networkidle")
        page.get_by_role("button", name="Search tools").click()
        try:
            page.wait_for_selector("input[placeholder^='Search tools and sections']", timeout=5000)
        except Exception:
            c.fail("palette didn't open")
    page.close()


def motion_check(ctx, watch, app):
    page = watch(ctx.new_page())
    on = "document.documentElement.classList.contains('reduce-motion')"

    def open_menu():
        chip = page.locator("header button[aria-haspopup='menu'], .sb-user button").first
        chip.click()
        return page.get_by_role("switch", name="Reduce motion").first

    with check("ui", "the OS reduce-motion setting is ignored") as c:
        page.emulate_media(reduced_motion="no-preference")
        page.goto(app + "/dashboard", wait_until="networkidle")
        saved = page.evaluate(on)
        page.emulate_media(reduced_motion="reduce")
        page.reload(wait_until="networkidle")
        if page.evaluate(on) != saved:
            c.fail("the page changed its motion mode when the OS asked for reduced motion")

    with check("ui", "account menu 'Reduce motion' switch applies, persists and restores") as c:
        switch = open_menu()
        switch.click()
        page.wait_for_timeout(800)  # let the save reach the server
        if page.evaluate(on) == saved:
            c.fail("switch didn't change the page")
        else:
            page.evaluate("localStorage.removeItem('smarthub.reduceMotion')")  # prove it came from the account
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(800)
            kept = page.evaluate(on)
            switch = open_menu()
            switch.click()  # back to what the user had
            page.wait_for_timeout(800)
            if kept == saved:
                c.fail("choice wasn't kept on the account after a reload")
            elif page.evaluate(on) != saved:
                c.fail("couldn't put the user's original setting back")
    page.close()


PANES = [("snowflake", "runSnowflakeQueryRunner"), ("postgres", "runPostgresStudio"), ("indexer", "viewPGindexer"),
         ("s3", "runS3Explorer"), ("streamsets", "runStreamsetsExtractor"), ("shuttle", "runDataShuttle")]
# Matches a production chunk (/assets/S3Pane-abc123.js) and a dev-server module (/src/.../S3Pane.jsx).
CHUNK = {"snowflake": "/sf_pg_pane", "postgres": "/sf_pg_pane", "indexer": "/indexer", "s3": "/S3Pane",
         "streamsets": "/StreamsetsPane", "shuttle": "/DataShuttle"}
BROKEN = ["This page didn't load", "Couldn't check your access", "Failed to fetch dynamically imported module"]


def page_broken(page):
    text = page.evaluate("document.body.innerText")
    return next((b for b in BROKEN if b in text), None)


def data_studio_checks(ctx, watch, app, perms):
    for pane, perm in PANES:
        with check("ui", f"Data Studio pane '{pane}' loads on demand") as c:
            if perms and perms.get(perm) is not True:
                c.skip(f"needs {perm}")
                continue
            page = watch(ctx.new_page())
            scripts = []
            page.on("request", lambda r, seen=scripts: seen.append(r.url) if r.resource_type == "script" else None)
            page.goto(app + "/dashboard", wait_until="networkidle")
            preloaded = any(CHUNK[pane] in s for s in scripts)
            page.goto(f"{app}/data-studio?pane={pane}", wait_until="networkidle")
            page.wait_for_timeout(1500)
            bad = page_broken(page)
            if bad:
                c.fail(bad)
            elif "/data-studio" not in page.url:
                c.fail(f"sent to {page.url}")
            elif not any(CHUNK[pane] in s for s in scripts):
                c.fail("pane code never loaded")
            else:
                c.note("prefetched while idle" if preloaded else "fetched when opened")
            page.close()


def load_portal_map():
    sys.path.insert(0, str(BACKEND))
    from assistant import portal_map as pm
    return pm


def destination_checks(ctx, watch, app, perms, out_dir):
    pm = load_portal_map()
    page = watch(ctx.new_page())
    for dest_id, x in pm.DESTINATIONS.items():
        route, params = pm.url_for(dest_id)
        url = route + (("?" + urlencode(params)) if params else "")
        with check("ui", f"page '{pm.breadcrumb(dest_id)}' opens ({url})") as c:
            if perms and not pm.can_access(dest_id, perms):
                c.skip("this account can't open it")
                continue
            try:
                page.goto(app + url, wait_until="networkidle")
            except Exception as e:
                if "ERR_CONNECTION" in str(e) or "ERR_NAME" in str(e):
                    c.fail(f"portal unreachable at {app}; stopping the page checks")
                    break
                raise
            page.wait_for_timeout(800)
            bad = page_broken(page)
            if bad:
                c.fail(bad)
                page.screenshot(path=str(out_dir / f"broken_{dest_id}.png"))
                continue
            if route != "/dashboard" and page.url.rstrip("/").endswith("/dashboard"):
                c.fail("bounced to the dashboard")
                continue
            if x.then_click:
                button = page.get_by_role("button", name=x.then_click)
                if not button.count():
                    button = page.locator(f"[aria-label='{x.then_click}'], [title='{x.then_click}']")
                if not button.count():
                    c.fail(f"no '{x.then_click}' button for the assistant to press")
    page.close()


def explorer_search_checks(ctx, watch, app, perms):
    pm = load_portal_map()
    page = watch(ctx.new_page())
    tried = 0
    for dest_id in [d for d in pm.DESTINATIONS if d.startswith("un.")]:
        if perms and not pm.can_access(dest_id, perms):
            continue
        route, params = pm.url_for(dest_id)
        page.goto(app + route + (("?" + urlencode(params)) if params else ""), wait_until="networkidle")
        page.wait_for_timeout(800)
        toggle = page.locator("button[aria-expanded]", has_text=re.compile("Search fields", re.I)).first
        if not toggle.count() or not toggle.is_visible():
            continue
        tried += 1
        with check("ui", f"search boxes count what you type ({pm.breadcrumb(dest_id)})") as c:
            if toggle.get_attribute("aria-expanded") != "true":
                toggle.click()
            box = toggle.locator("xpath=following-sibling::div[1]//input").first
            box.fill("a")
            page.wait_for_timeout(500)
            badge = toggle.locator("span span").first
            if not badge.count() or badge.inner_text().strip() != "1":
                c.fail("count didn't show 1 after typing")
            else:
                box.fill("")
                page.wait_for_timeout(500)
                if toggle.locator("span span").count():
                    c.fail("count stayed after clearing")
            bad = page_broken(page)
            if bad:
                c.fail(bad)
    if not tried:
        record("ui", "explorer search boxes", "SKIP", "no explorer with search fields is open to this account")
    page.close()


# ------------------------------------------------------------------------ main


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app-url", help="portal address, e.g. https://smarthub.example.com")
    p.add_argument("--api-url", help="backend address, e.g. https://smarthub-api.example.com")
    p.add_argument("--login", action="store_true", help="open a visible browser to sign in first")
    p.add_argument("--headed", action="store_true", help="show the browser while checking")
    p.add_argument("--browser", default="auto", choices=["auto", "chromium", "chrome", "msedge"],
                   help="which browser runs the UI checks (auto tries them in that order)")
    p.add_argument("--token", help="bearer token to use instead of the browser session")
    p.add_argument("--data-api-id")
    p.add_argument("--data-api-key")
    p.add_argument("--data-api-alias")
    p.add_argument("--streamsets-resource", help="PIPELINE_ID:relative/path of a resource file")
    p.add_argument("--no-assistant", action="store_true", help="skip the assistant checks (they call the LLM)")
    p.add_argument("--skip-build", action="store_true", help="reuse frontend/dist")
    p.add_argument("--only", choices=["static", "unit", "api", "ui"], action="append",
                   help="run just these stages (repeatable)")
    args = p.parse_args()
    stages = set(args.only or ["static", "unit", "api", "ui"])

    out_dir = STATE / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    token_box = {"token": args.token}

    if "static" in stages:
        stage_static(args)
    if "unit" in stages:
        stage_unit(args)
    # The browser run signs in and hands its token to the API checks.
    if "ui" in stages:
        stage_ui(args, out_dir, token_box)
    if "api" in stages:
        if not token_box.get("token") and "ui" not in stages:
            token_box["token"] = token_from_browser(args)
        stage_api(args, token_box.get("token"))

    counts = {s: sum(r["status"] == s for r in results) for s in ("PASS", "FAIL", "SKIP")}
    (out_dir / "report.json").write_text(json.dumps({"when": datetime.now().isoformat(), "args": {
        k: v for k, v in vars(args).items() if k not in ("token", "data_api_key")}, "counts": counts,
        "results": results}, indent=2), encoding="utf-8")
    print(f"\n{counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped. "
          f"Report and screenshots: {out_dir.relative_to(REPO)}")
    for r in results:
        if r["status"] == "FAIL":
            print(f"  FAIL  [{r['stage']}] {r['check']}: {r['detail']}")
    sys.exit(1 if counts["FAIL"] else 0)


if __name__ == "__main__":
    main()
