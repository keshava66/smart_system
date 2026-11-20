"""Single-hand (chiral) drug support in the Cortellis explorer: reading the prefix,
the Stereo form filter, mirror forms, the cross-table search and the chiral pairs.
Snowflake is replaced by a fake runner; the SQL text is checked for the parts that matter."""
import json
import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth as AU
import cortellis as C
import unstructured as U

PRODUCTS = C.TABLES["rp_products"]


@pytest.mark.parametrize("name, kind, base", [
    ("(+)-mefloquine, Vernalis", C.ST_PLUS, "mefloquine"),
    ("(-)-pantoprazole, Sunovion", C.ST_MINUS, "pantoprazole"),
    ("(−)-3PPP, Maryland", C.ST_MINUS, "3ppp"),
    ("(R)-2'-Me-PMEG", C.ST_RS, "2'-me-pmeg"),
    ("(2R,4S)-itraconazole, J&J", C.ST_RS, "itraconazole"),
    ("(1'S, 2R)-foo", C.ST_RS, "foo"),
    ("(R,R)-formoterol", C.ST_RS, "formoterol"),
    ("(R-S) baclofen + naltrexone", C.ST_MIX, "baclofen + naltrexone"),
    ("(±)-ketamine", C.ST_MIX, "ketamine"),
    ("(18)F-EF5", C.ST_NONE, "(18)f-ef5"),      # isotope, not a hand
    ("(E1)-3s", C.ST_NONE, "(e1)-3s"),           # code name
    ("pantoprazole", C.ST_NONE, "pantoprazole"),
    ("", C.ST_NONE, ""),
])
def test_prefix_is_read_from_the_name(name, kind, base):
    assert C.stereo_kind(name) == kind
    assert C.stereo_base(name) == base


@pytest.mark.parametrize("name, twins", [
    ("(+)-calanolide A", ["(-)-calanolide A", "(−)-calanolide A", "(l)-calanolide A"]),
    ("(-)-pantoprazole, Sunovion", ["(+)-pantoprazole", "(d)-pantoprazole"]),
    ("(2R,4S)-itraconazole, J&J", ["(2S,4R)-itraconazole"]),
    ("(R)-didesmethylsibutramine", ["(S)-didesmethylsibutramine"]),
    ("pantoprazole", []),
    ("(±)-ketamine", []),
])
def test_other_hand_spellings(name, twins):
    assert C.stereo_twin_names(name) == twins


def test_sql_patterns_are_portable_and_quoted():
    sql = C._stereo_sql(PRODUCTS)
    for label, _ in C.STEREO_PATTERNS:
        assert f"THEN '{label}'" in sql
    # no Perl-only escapes; the quote in (1'S) is doubled for the SQL literal
    assert "\\d" not in sql and "\\s" not in sql
    assert "''?" in sql
    assert C._stereo_base_sql(PRODUCTS).startswith("LOWER(TRIM(REGEXP_REPLACE(")


def test_stereo_filter_only_on_tables_that_have_it():
    raw = json.dumps({C.STEREO: [C.ST_MINUS], "bogus": ["x"]})
    assert C._parse_filters(PRODUCTS, raw) == {C.STEREO: [C.ST_MINUS]}
    assert C._parse_filters(C.TABLES["rp_trials"], raw) == {}
    params = {}
    where = C._where(PRODUCTS, {C.STEREO: [C.ST_MINUS, C.ST_RS]}, "", None, params)
    assert where.count("CASE WHEN") == 2 and set(params.values()) == {C.ST_MINUS, C.ST_RS}


# ---- endpoints, with Snowflake faked ------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    U._cache.clear()
    monkeypatch.setattr(U, "_cache_bytes", 0)
    cols = ["id", "drugPrimaryName", "globalStatus", "chemicalStructure", "trialTitle", "diseases", "title", "brandName",
            "genericName", "PRODUCT", "ProductName", "drugNameSynonyms", "originatorName", "indication", "mechanismsOfAction",
            "products", "keywords", "number", "companyLead", "eventType", "APPLICANT", "CMT_DESC", "NDA_NUMBER",
            "ActiveIngredients", "CompanyName", "Indication", "CommitteeName", "eventDetails", "summary", "agency", "country",
            "trialSponsors", "trialId"]
    monkeypatch.setattr(C, "_columns", lambda spec, bypass: cols)
    calls = []

    def run(sql, params, what):
        calls.append((what, sql, params))
        if what in ("mirror self", "elsewhere self"):
            return SimpleNamespace(rows=[("(+)-calanolide A",)])
        if what == "mirror forms":
            return SimpleNamespace(rows=[("7", "calanolide A", C.ST_NONE, "No Development Reported", None)])
        if what == "elsewhere rp_trials":
            return SimpleNamespace(rows=[("t1", "Phase I study of (-)-calanolide A", True, 6), ("t2", "calanolide A in HIV", False, 6)])
        if what == "elsewhere hanews":
            raise C.HTTPException(status_code=500, detail="boom")  # one table failing
        if what.startswith("elsewhere"):
            return SimpleNamespace(rows=[])
        if what.startswith("/table/"):
            return SimpleNamespace(rows=[(0,)] if "count" in what else [], columns=["id", "drugPrimaryName"])
        if what == "insights chiral":
            return SimpleNamespace(rows=[("8", "(+)-calanolide A", "No Development Reported", C.ST_PLUS, "7", "calanolide A",
                                          "Launched", 4, 2, 0, 3)])
        raise AssertionError(what)

    monkeypatch.setattr(C, "_run_or_fail", run)
    app = FastAPI()
    app.include_router(C.cortellis_router)
    me = {"user": {"email": "t@x"}, "permissions": {p: True for p in AU.ALL_PERMISSIONS}, "roles": ["admin"],
          "role": "admin", "groups": [], "groups_known": True, "token": ""}
    app.dependency_overrides[AU.require_auth] = lambda: me
    yield TestClient(app), calls
    U._cache.clear()


def test_mirror_forms(api):
    client, calls = api
    r = client.get("/api/cortellis/mirror/rp_products?key=8")
    assert r.status_code == 200
    body = r.json()
    assert body["base"] == "calanolide a"
    assert body["forms"] == [{"key": "7", "name": "calanolide A", "kind": C.ST_NONE, "status": "No Development Reported", "smiles": None}]
    sql, params = next((s, p) for w, s, p in calls if w == "mirror forms")
    assert params == {"b": "calanolide a", "k": "8"} and "LIMIT 20" in sql
    # second call is served from the cache
    n = len(calls)
    client.get("/api/cortellis/mirror/rp_products?key=8")
    assert len(calls) == n


def test_mirror_on_a_table_without_drug_names(api):
    client, _ = api
    assert client.get("/api/cortellis/mirror/rp_trials?key=1").json() == {"base": None, "forms": []}


def test_elsewhere_finds_the_other_hand_and_survives_a_failing_table(api):
    client, calls = api
    body = client.get("/api/cortellis/mirror-elsewhere/rp_products?key=8").json()
    assert body["name"] == "calanolide A" and body["twin"] == "(-)-calanolide A"
    assert body["incomplete"] is True  # hanews failed
    assert [t["id"] for t in body["tables"]] == ["rp_trials"]
    trials = body["tables"][0]
    assert trials["mentions"] == 6 and trials["twin_hits"] == [{"key": "t1", "title": "Phase I study of (-)-calanolide A"}]
    # every table was asked, the twin spellings are escaped LIKE patterns, the record itself is left out of its own table
    asked = {w for w, _, _ in calls if w.startswith("elsewhere ") and w != "elsewhere self"}
    assert asked == {f"elsewhere {t}" for t in C.TABLES}
    _, sql, params = next(c for c in calls if c[0] == "elsewhere rp_products")
    assert params["self"] == "8" and params["base"] == "%calanolide A%" and params["tw0"] == "%(-)-calanolide A%"
    # a partial answer is not cached
    n = len(calls)
    client.get("/api/cortellis/mirror-elsewhere/rp_products?key=8")
    assert len(calls) > n


def test_chiral_pairs_counted_in_snowflake(api):
    client, calls = api
    out = C._chiral_pairs(PRODUCTS, set(["id", "drugPrimaryName", "globalStatus"]))
    assert out["pairs"] == 4 and out["original_launched_pct"] == 50 and out["single_launched_pct"] == 0 and out["single_stopped_pct"] == 75
    assert out["examples"][0]["original"]["name"] == "calanolide A"
    sql = next(s for w, s, _ in calls if w == "insights chiral")
    assert "QUALIFY ROW_NUMBER()" in sql and f"LIMIT {C.CHIRAL_EXAMPLES}" in sql and "COUNT(*) OVER ()" in sql
    assert re.search(r"x\.kind IN \('.+', '.+', '.+'\)", sql)


# ---- Greek letters in drug names (β-sitosterol) -------------------------------------

@pytest.mark.parametrize("q, expected", [
    ("beta-sitosterol", ["beta-sitosterol", "β-sitosterol", "ß-sitosterol", "Ã\u009f-sitosterol"]),
    ("β-sitosterol", ["beta-sitosterol", "β-sitosterol", "ß-sitosterol", "Ã\u009f-sitosterol"]),
    ("Β3 agonists", ["beta3 agonists", "Β3 agonists"]),   # capital Greek Beta
    ("alpha-glucosidase", ["alpha-glucosidase", "α-glucosidase"]),
    ("betamethasone", ["betamethasone", "betamethasone"]),  # a real word, left alone
])
def test_search_matches_greek_both_ways(q, expected):
    assert C._greek_variants(q) == expected


def test_search_sql_has_the_greek_variants():
    params = {}
    C._where(PRODUCTS, {}, "beta-catenin", None, params)
    # beta as the Greek letter, as the German ß older data uses, and as the garbled "Ã" + U+009F
    assert params == {"q": "%beta-catenin%", "q1": "%β-catenin%", "q2": "%ß-catenin%", "q3": "%Ã\u009f-catenin%"}


def test_name_sort_reads_greek_as_words():
    expr = C._sort_name_sql("drugPrimaryName")
    assert expr.count("REPLACE(") == len(C.GREEK) + 2 and "'β', 'beta'" in expr and 'LOWER("drugPrimaryName"::STRING)' in expr
    assert "'ã' || CHR(159), 'beta'" in expr and "'ß', 'beta'" in expr


def test_name_sort_is_stable_across_pages(api):
    client, calls = api
    r = client.get("/api/cortellis/table/rp_products?page=2&size=50&sort=drugPrimaryName&desc=true&bypass_cache=true")
    assert r.status_code == 200
    sql = next(s for w, s, _ in calls if w == "/table/rp_products")
    # Greek/ß-aware key first, then the raw name, then the id so equal names never swap between pages
    assert re.search(r'ORDER BY .*REPLACE\(.* DESC NULLS LAST, "drugPrimaryName" DESC, "id" LIMIT', sql)


def test_search_text_with_greek_reaches_the_table_query(api):
    client, calls = api
    client.get("/api/cortellis/table/rp_products?page=1&size=50&q=beta-catenin&bypass_cache=true")
    _, sql, params = next(c for c in calls if c[0] == "/table/rp_products")
    assert {"q", "q1", "q2", "q3"} <= set(params) and "%(q3)s" in sql
