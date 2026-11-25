"""Executive view payload (no database, no network).

Run from backend/:  python -m pytest tests/test_bdc_executive.py -q
"""

from datetime import date

from auth import dataset_key
from bdc_admin import build_executive

RULE_COLS = ["RULE_ID", "RULE_TITLE", "RULE_DESCRIPTION", "SEVERITY", "TARGET_TABLE", "PASS_PERCENTAGE", "STATUS", "__ACCEPTED"]
INPUT_COLS = ["RULE_ID", "RULE_TITLE", "DATASET_TITLE", "DOMAIN", "COMPONENT_NAME", "IS_ACTIVE"]

RAW = {
    "rules": (RULE_COLS, [
        ("R1", "Rule one", "d1", "HIGH", "T1", 91.5, "PASS", True),
        ("R2", "Rule two", "", "LOW", "T2", None, "ERROR", True),   # ran, no result
        ("R3", "Rule three", "", "LOW", "T3", 99.0, "PASS", False),  # not approved
    ]),
    "input": (INPUT_COLS, [
        ("R1", "Rule one", "RightTime", "CMC", "Comp A", True),
        ("R2", "Rule two", "MDM", "MDM", None, True),
        ("R3", "Rule three", "RightTime", "Labeling", None, True),
        (None, None, "RightTime", "Planning", None, True),           # domain with no rule yet
        ("R4", "", "RightTime", "CMC", None, True),                  # half-configured
    ]),
    "trends": [
        ("R1", date(2026, 3, 31), 90.0),
        ("R1", date(2026, 6, 30), 91.5),
        ("R2", date(2026, 6, 30), None),
        ("R3", date(2026, 6, 30), 99.0),
    ],
}


def test_approved_rules_with_scores_and_history():
    out = build_executive(RAW, None)
    assert [r["rule_id"] for r in out["rules"]] == ["R1", "R2"]
    r1, r2 = out["rules"]
    assert r1["pass_percentage"] == 91.5 and r1["component_name"] == "Comp A" and r1["severity"] == "HIGH"
    assert r2["pass_percentage"] is None  # no result is "not scored", never 0
    assert out["history"] == {
        "R1": [{"date": "2026-03-31", "pass_percentage": 90.0}, {"date": "2026-06-30", "pass_percentage": 91.5}],
        "R2": [],
    }
    # Labeling's only rule is not approved; Planning has none yet
    assert out["empty_domains"] == ["Labeling", "Planning"]


def test_dataset_scope_cuts_rules_and_domains():
    out = build_executive(RAW, {dataset_key("MDM")})
    assert [r["rule_id"] for r in out["rules"]] == ["R2"]
    assert out["empty_domains"] == []
    assert set(out["history"]) == {"R2"}


def test_unreadable_trends_are_reported_not_blank():
    assert build_executive({**RAW, "trends": None}, None)["history"] is None
