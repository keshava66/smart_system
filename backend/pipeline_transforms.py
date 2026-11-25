"""What a pipeline does to the data on its way to Snowflake, read from its processors (fragments included),
its origin and its Snowflake destination - for any pipeline, whatever its source database.

analyze(pipeline)  -> the effects: columns added / removed / renamed, values rewritten, rows filtered, custom code
use_renames(v, tx) -> the validation script compares renamed columns under their Snowflake name
apply(result, tx)  -> differences the pipeline causes on purpose move from validation_issues to
                      expected_differences, and the table's status is graded on what's left

Stdlib only: the runner imports it with the validation Python.
"""
import fnmatch
import re

# StreamSets field types -> pieces of source column type names they cover
SDC_TYPES = {
    "DATETIME": ("DATE", "TIME"), "DATE": ("DATE",), "TIME": ("TIME",), "ZONED_DATETIME": ("ZONE", "OFFSET"),
    "STRING": ("CHAR", "TEXT", "STRING", "CLOB", "XML"), "INTEGER": ("INT", "NUMBER"), "LONG": ("INT", "NUMBER"),
    "SHORT": ("INT", "NUMBER"), "DECIMAL": ("DEC", "NUMER", "NUMBER", "MONEY"), "DOUBLE": ("FLOAT", "DOUBLE", "REAL", "NUMBER"),
    "FLOAT": ("FLOAT", "REAL", "NUMBER"), "BOOLEAN": ("BIT", "BOOL"), "BYTE_ARRAY": ("BINARY", "BLOB", "RAW", "IMAGE"),
}
_REGEX_CHARS = set("()[]*+?|\\^$.{}")
# processors that don't change what lands in Snowflake
_HARMLESS = ("delay", "schemagenerator", "devidentity", "identity", "headerattribute", "datagenerator_devdata",
             "pipelinefinisher", "fragment")


def _empty():
    return {"steps": [], "added": {}, "removed": {}, "removed_globs": [], "keep_only": None, "renamed": {},
            "rename_rules": [], "changed": {}, "wild": [], "rows": [], "dedup": None, "unknown": [],
            "adds_unknown": None, "notes": []}


# ── reading stages ─────────────────────────────────────────────────────────────
def _conf(stage):
    """Stage settings as {full name: value} (raw StreamSets stage) - or the extractor's flat dict."""
    c = stage.get("configuration")
    if isinstance(c, dict):
        return c
    return {x["name"]: x.get("value") for x in c or [] if isinstance(x, dict) and x.get("name")}


def _get(cfg, *names):
    """A setting by the last segment of its name (conf.rules -> rules), case-insensitive."""
    want = [n.lower() for n in names]
    for k, val in cfg.items():
        if k.split(".")[-1].lower() in want and val not in (None, "", []):
            return val
    return None


def _list(v):
    return v if isinstance(v, list) else [v] if v not in (None, "") else []


def _short(text, n=60):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t if len(t) <= n else t[:n - 1] + "…"


def _field(path):
    """StreamSets field path -> (COLUMN, how): how is top / nested / wild / dynamic / record."""
    p = str(path or "").strip()
    if not p:
        return None, None
    if "${" in p and not p.startswith("/*"):
        return None, "dynamic"
    body = p[1:] if p.startswith("/") else p
    if not body:
        return None, "record"
    if body[0] in "'\"":
        end = body.find(body[0], 1)
        name, rest = (body[1:end], body[end + 1:]) if end > 0 else (body[1:], "")
    else:
        name, _, rest = body.partition("/")
        name, br, more = name.partition("[")
        rest = rest or (br + more)
    if "*" in name:
        return name.upper(), "wild"
    return name.upper(), ("nested" if rest.strip("/") else "top")


def _types_in(path):
    """/*[${f:type() == 'DATETIME'}] -> ['DATETIME']; no predicate -> None (any type)."""
    hits = re.findall(r"f:type\(\)\s*==\s*['\"](\w+)['\"]", str(path or ""))
    return [h.upper() for h in hits] or None


def _paths(value):
    """Every field path ('/x') inside a setting value (lists / dicts / strings)."""
    if isinstance(value, str):
        return [value] if value.strip().startswith("/") else []
    if isinstance(value, dict):
        return [p for x in value.values() for p in _paths(x)]
    if isinstance(value, list):
        return [p for x in value for p in _paths(x)]
    return []


def _walk(stages, frag=None, depth=0):
    """Processors in the extract, with fragments opened up. Yields (stage, label)."""
    for s in stages or []:
        if not isinstance(s, dict):
            continue
        label = (s.get("uiInfo") or {}).get("label") or s.get("instanceName") or "stage"
        inner = ((s.get("enriched_commit_info") or {}).get("pipeline_definition") or {}).get("stages")
        if "fragmentprocessor" in str(s.get("stageName", "")).lower() or inner:
            if inner and depth < 5:
                name = (s.get("uiInfo") or {}).get("fragmentName") or label
                yield from _walk(inner, f"{frag} › {name}" if frag else name, depth + 1)
            elif not inner:
                yield {"stageName": "fragment-unread", "uiInfo": {"label": label}}, frag
            continue
        yield s, (f"{frag} › {label}" if frag else label)


# ── one analyser ───────────────────────────────────────────────────────────────
class _Tx:
    def __init__(self):
        self.tx = _empty()

    def step(self, stage, kind, detail):
        self.tx["steps"].append({"stage": stage, "kind": kind, "detail": detail})

    def set_field(self, path, stage, why):
        col, how = _field(path)
        if how == "top":
            self.tx["added"].setdefault(col, f"{stage} sets it ({why})")
        elif how == "nested":
            self.tx["changed"].setdefault(col, f"{stage} changes a field inside it")
        elif how in ("wild", "record"):
            self.wild(stage, col or "*", None, f"{stage} rewrites matching fields")
        elif how == "dynamic":
            self.tx["unknown"].append(f"{stage} writes to a field named at run time")

    def change(self, path, stage, why):
        col, how = _field(path)
        types = _types_in(path)
        if how in ("top", "nested"):
            self.tx["changed"].setdefault(col, f"{stage} {why}")
        elif how in ("wild", "record"):
            self.wild(stage, col or "*", types, f"{stage} {why}")
        elif how == "dynamic":
            self.tx["unknown"].append(f"{stage} changes a field named at run time")

    def wild(self, stage, glob, types, why):
        self.tx["wild"].append({"glob": glob or "*", "types": types, "why": why})

    def rows(self, why, way="fewer"):
        """A reason the row counts can differ. way: the direction it can move Snowflake's count - 'fewer' rows
        (filters, dedup, offsets), 'more' (pivots, CDC inserted as-is) or 'any'. Only a mismatch in that direction
        is explained by it: a filter never explains extra rows, an insert-only CDC load never explains missing ones."""
        self.tx["rows"].append({"why": why, "way": way})


def _preconditions(a, cfg, label):
    pre = [x for x in _list(_get(cfg, "stageRecordPreconditions")) if str(x).strip()]
    req = [x for x in _list(_get(cfg, "stageRequiredFields")) if str(x).strip()]
    on_err = str(_get(cfg, "stageOnRecordError") or "TO_ERROR")
    if pre:
        a.rows(f"{label} drops records failing {_short('; '.join(map(str, pre)))} ({on_err})")
    if req:
        a.rows(f"{label} drops records missing {', '.join(map(str, req))} ({on_err})")


def _processor(a, s, label):
    name = str(s.get("stageName") or "").lower()
    cfg = _conf(s)
    _preconditions(a, cfg, label)

    if "expressiondprocessor" in name or "expressionprocessor" in name:
        sets = [e for e in _list(_get(cfg, "expressionProcessorConfigs")) if isinstance(e, dict) and e.get("fieldToSet")]
        for e in sets:
            a.set_field(e["fieldToSet"], label, f"= {_short(e.get('expression'), 40)}")
        if sets:
            a.step(label, "sets columns", ", ".join(f"{e['fieldToSet']} = {_short(e.get('expression'), 40)}" for e in sets))
    elif "fieldremover" in name or "fieldfilter" in name:   # Field Remover is FieldFilterDProcessor
        fields = [f for f in _list(_get(cfg, "fields")) if isinstance(f, str)]
        op = str(_get(cfg, "filterOperation") or "REMOVE").upper()
        if op == "KEEP":
            tops = [c for c, how in map(_field, fields) if how == "top"]
            a.tx["keep_only"] = (set(a.tx["keep_only"]) & set(tops)) if a.tx["keep_only"] is not None else set(tops)
            a.tx["keep_only_by"] = label
            a.step(label, "keeps only", ", ".join(fields))
        elif op == "REMOVE":
            for f in fields:
                col, how = _field(f)
                if how == "top":
                    a.tx["removed"].setdefault(col, f"removed by {label}")
                elif how == "wild":
                    a.tx["removed_globs"].append((col, f"removed by {label} ({f})"))
            a.step(label, "removes columns", ", ".join(fields))
        else:   # REMOVE_NULL / REMOVE_EMPTY / REMOVE_CONSTANT: the column stays, some values go
            for f in fields:
                a.change(f, label, f"removes the value when {op.replace('REMOVE_', '').lower()}")
            a.step(label, "removes values", f"{op} on {', '.join(fields)}")
    elif "fieldrenamer" in name:
        maps = [m for v in cfg.values() if isinstance(v, list) for m in v
                if isinstance(m, dict) and m.get("fromFieldExpression") and m.get("toFieldExpression")]
        for m in maps:
            src, dst = (str(m[k]).strip().lstrip("/").strip("'\"") for k in ("fromFieldExpression", "toFieldExpression"))
            if set(src) & _REGEX_CHARS:
                a.tx["rename_rules"].append((src, re.sub(r"\$(\d+)", r"\\\1", dst)))   # Java $1 -> Python \1
            else:
                a.tx["renamed"][src.upper()] = dst.upper()
        if maps:
            a.step(label, "renames columns", ", ".join(f"{m['fromFieldExpression']} → {m['toFieldExpression']}" for m in maps))
    elif "fieldmapper" in name:
        on = str(_get(cfg, "operateOn") or "").upper()
        expr = _get(cfg, "mappingExpression")
        if on == "FIELD_NAMES":
            a.step(label, "renames columns", f"by expression {_short(expr)} (applied when matching columns)")
        elif on == "FIELD_VALUES":
            a.wild(label, "*", _types_in(_get(cfg, "conditionalExpression")), f"{label} rewrites values ({_short(expr, 40)})")
            a.step(label, "rewrites values", _short(expr))
        else:
            a.tx["unknown"].append(f"{label} moves fields around ({_short(expr, 40)})")
            a.step(label, "moves fields", _short(expr))
    elif "fieldtypeconverter" in name:
        by_type = [c for c in _list(_get(cfg, "wholeTypeConverterConfigs")) if isinstance(c, dict) and c.get("sourceType")]
        if str(_get(cfg, "convertBy") or "").upper() == "BY_TYPE" and by_type:
            for c in by_type:
                a.wild(label, "*", [str(c["sourceType"]).upper()], f"{label} converts {c['sourceType']} to {c.get('targetType')}")
            a.step(label, "converts types", ", ".join(f"{c['sourceType']} → {c.get('targetType')}" for c in by_type))
        else:
            convs = [c for c in _list(_get(cfg, "fieldTypeConverterConfigs")) if isinstance(c, dict)]
            for c in convs:
                for f in _paths(c.get("fields")):
                    a.change(f, label, f"converts it to {c.get('targetType')}")
            if convs:
                a.step(label, "converts types", "; ".join(f"{', '.join(_paths(c.get('fields')))} → {c.get('targetType')}" for c in convs))
    elif "fieldreplacer" in name:
        rules = [r for r in _list(_get(cfg, "rules")) if isinstance(r, dict) and r.get("fields")]
        for r in rules:
            what = "sets it to null" if r.get("setToNull") else f"replaces it with {_short(r.get('replacement'), 50)}"
            for f in _list(r["fields"]):
                a.change(f, label, what)
        if rules:
            a.step(label, "replaces values", "; ".join(f"{r['fields']} → {'null' if r.get('setToNull') else _short(r.get('replacement'), 70)}" for r in rules))
    elif "splitterdprocessor" in name:
        src = _get(cfg, "fieldPath")
        outs = [x for x in _list(_get(cfg, "fieldPathsForSplits")) if isinstance(x, str)]
        for o in outs:
            a.set_field(o, label, f"split from {src}")
        if str(_get(cfg, "originalFieldAction") or "REMOVE").upper() == "REMOVE":
            col, how = _field(src)
            if how == "top":
                a.tx["removed"].setdefault(col, f"split up and removed by {label}")
        a.step(label, "splits a column", f"{src} → {', '.join(outs)}")
    elif "fieldmerger" in name:
        maps = [m for m in _list(_get(cfg, "mergeMapping")) if isinstance(m, dict)]
        for m in maps:
            col, how = _field(m.get("fromField"))
            if how == "top":
                a.tx["removed"].setdefault(col, f"merged into {m.get('toField')} by {label}")
            a.set_field(m.get("toField"), label, f"merged from {m.get('fromField')}")
        a.step(label, "merges columns", ", ".join(f"{m.get('fromField')} → {m.get('toField')}" for m in maps))
    elif "fieldorder" in name:
        fields = [f for f in _list(_get(cfg, "fields")) if isinstance(f, str)]
        extra = str(_get(cfg, "extraFieldAction") or "").upper()
        if extra == "DISCARD":
            tops = [c for c, how in map(_field, fields) if how == "top"]
            a.tx["keep_only"] = set(tops) if a.tx["keep_only"] is None else a.tx["keep_only"] & set(tops)
            a.tx["keep_only_by"] = label
        elif extra == "TO_ERROR":
            a.rows(f"{label} sends records with extra fields to error")
        a.step(label, "orders columns", f"{len(fields)} column(s), others {extra.lower() or 'kept'}")
    elif "fieldflattener" in name:
        a.tx["adds_unknown"] = f"flattened by {label}"
        a.wild(label, "*", None, f"{label} flattens nested fields")
        a.step(label, "flattens fields", "nested fields become top-level columns")
    elif "listpivot" in name or "fieldpivot" in name or "mappivot" in name:
        a.rows(f"{label} turns each list item into its own record", "more")
        a.step(label, "pivots", str(_get(cfg, "listPath") or ""))
    elif "selector" in name:
        preds = [p for p in _list(_get(cfg, "lanePredicates")) if isinstance(p, dict)]
        conds = [str(p.get("predicate")) for p in preds if str(p.get("predicate", "")).strip().lower() not in ("default", "")]
        if conds:
            a.rows(f"{label} routes records by condition ({_short(' | '.join(conds), 80)})")
            a.step(label, "routes records", " | ".join(conds))
    elif "deduplicat" in name:
        a.tx["dedup"] = f"{label} drops duplicate records"
        a.rows(f"{label} drops duplicate records")
        a.step(label, "drops duplicates", str(_get(cfg, "compareFields") or "all fields"))
    elif any(k in name for k in ("jython", "groovy", "javascript", "scripting", "jexl", "java")):
        a.tx["unknown"].append(f"{label} runs custom code")
        a.tx["adds_unknown"] = a.tx["adds_unknown"] or f"possibly from custom code in {label}"
        a.step(label, "custom code", "can change columns, values and rows - not predicted")
    elif "fieldhasher" in name or "fieldmask" in name or "valuereplacer" in name or "nullreplacer" in name:
        targets = {str(v) for k, v in _flat(cfg) if k.lower() in ("targetfield", "targetfieldpath")}
        for t in targets:
            a.set_field(t, label, "hash")
        for f in _paths(cfg):
            if f not in targets:
                a.change(f, label, "masks / hashes / replaces its values")
        a.step(label, "rewrites values", ", ".join(sorted(set(_paths(cfg)))) or "")
    elif any(h in name for h in _HARMLESS):
        pass
    else:
        outs = {str(v) for k, v in _flat(cfg) if k.lower() in (
            "outputfield", "outputfieldpath", "targetfield", "targetfieldpath", "newpath", "parsedfieldpath",
            "zippedfieldpath", "resultfieldpath", "field")} - {""}
        outs = {o for o in outs if o.startswith("/")}
        for o in outs:
            a.set_field(o, label, "written by this stage")
        if outs:
            a.step(label, "writes columns", ", ".join(sorted(outs)))
        else:
            a.tx["notes"].append(f"{label} ({_short(s.get('stageName'), 50)}) isn't recognised - its effect isn't predicted")


def _flat(value, key=""):
    """(last key, value) for every scalar inside a nested setting."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _flat(v, str(k).split(".")[-1])
    elif isinstance(value, list):
        for v in value:
            yield from _flat(v, key)
    elif value not in (None, ""):
        yield key, value


def _origin(a, p):
    for s in (p.get("pipeline_flow") or {}).get("sources") or []:
        cfg = s.get("configuration") or {}
        try:
            import json
            tcs = json.loads(cfg.get("Tableconfigs") or "[]")
        except ValueError:
            tcs = []
        for tc in tcs if isinstance(tcs, list) else []:
            if not isinstance(tc, dict):
                continue
            first = tc.get("offsetColumnToInitialOffsetValue") or []
            last = tc.get("offsetColumnToLastOffsetValue") or []
            if first:
                a.rows(f"the origin starts reading at offset {_short(first, 60)}")
            if last:
                a.rows(f"the origin stops reading at offset {_short(last, 60)}")
        return s
    return None


def _destination(a, p, origin):
    from pipeline_sources import origin_family   # same folder; stdlib only
    for t in (p.get("pipeline_flow") or {}).get("targets") or []:
        if t.get("technology") != "Snowflake":
            continue
        cfg = t.get("configuration") or {}
        cdc_origin = origin_family((origin or {}).get("type")) in ("sqlserver_cdc", "sqlserver_ct", "oracle_cdc", "mysql_binlog")
        if cdc_origin and str(cfg.get("Cdcdata")).lower() != "true":
            a.rows("the origin sends every change but Snowflake only inserts (Process CDC Data is off), so changed rows repeat", "more")
            a.step(t.get("stage_name") or "Snowflake", "inserts every change", "Process CDC Data is off")
        elif cdc_origin:
            a.step(t.get("stage_name") or "Snowflake", "applies changes", "inserts, updates and deletes are merged (Process CDC Data)")
        if str(cfg.get("Trimspaces")).lower() == "true":
            a.tx["notes"].append("Snowflake destination trims spaces from text values - text columns can differ slightly")
        return


def analyze(pipeline: dict) -> dict:
    a = _Tx()
    origin = _origin(a, pipeline)
    st = (pipeline.get("pipeline_stages") or {}).get("stages") or {}
    for s, label in _walk(list(st.get("processors") or []) + list(st.get("other") or [])):
        if s.get("stageName") == "fragment-unread":
            a.tx["notes"].append(f"Fragment {label} couldn't be read - its effect isn't predicted")
            continue
        try:
            _processor(a, s, label)
        except Exception as e:   # one odd stage mustn't stop the run
            a.tx["notes"].append(f"{label} couldn't be read ({type(e).__name__}) - its effect isn't predicted")
    _destination(a, pipeline, origin)
    return a.tx


# ── using the analysis ─────────────────────────────────────────────────────────
def describe_steps(tx):
    """For the page: what each stage does, plus anything that can't be predicted."""
    out = [dict(s) for s in tx.get("steps") or []]
    out += [{"stage": None, "kind": "note", "detail": n} for n in tx.get("notes") or []]
    return out


def describe(tx):
    return [f"{s['stage']}: {s['kind']} - {s['detail']}" if s["stage"] else s["detail"] for s in describe_steps(tx)]


def use_renames(v, tx):
    """Compare columns a Field Renamer renamed under their new (Snowflake) name. tx=None switches it off."""
    D = v.DataValidator
    if not hasattr(D, "_ptx_own"):
        D._ptx_own = D._transform

        def _transform(self, name):
            ren = getattr(D, "_ptx_renames", None)
            if ren:
                hit = ren[0].get(name.upper())
                if hit:
                    return hit
                for rx, repl in ren[1]:
                    if rx.fullmatch(name):
                        return rx.sub(repl, name, count=1).upper()
            return D._ptx_own(self, name)
        D._transform = _transform
    rules = []
    for pat, repl in (tx or {}).get("rename_rules") or []:
        try:
            rules.append((re.compile(pat), repl))
        except re.error:
            pass
    D._ptx_renames = (tx["renamed"], rules) if tx and (tx["renamed"] or rules) else None


def _type_hit(types, col_type):
    if not types:
        return True
    t = (col_type or "").upper()
    return any(piece in t for ty in types for piece in SDC_TYPES.get(ty, (ty,)))


def _changed(tx, col, col_type):
    if col in tx["changed"]:
        return tx["changed"][col]
    if col in tx["added"]:   # set on a column the source already has: values replaced
        return tx["added"][col].replace(" sets it ", " overwrites it ")
    for w in tx["wild"]:
        if fnmatch.fnmatchcase(col, w["glob"].upper()) and _type_hit(w["types"], col_type):
            return w["why"]
    return None


def _added(tx, col):
    if col in tx["added"]:
        return f"added by {tx['added'][col].split(' sets it ')[0]}"
    return tx["adds_unknown"]


def _removed(tx, col, renamed_to):
    if col in tx["removed"]:
        return tx["removed"][col]
    for glob, why in tx["removed_globs"]:
        if fnmatch.fnmatchcase(col, glob):
            return why
    if tx["keep_only"] is not None and col not in tx["keep_only"]:
        return f"not kept by {tx.get('keep_only_by')}"
    if col in renamed_to:
        return f"renamed to {renamed_to[col]}"
    return None


def _apply_table(t, tx):
    ca, dq = t["column_analysis"], t.get("data_quality") or {}
    stats = t.get("column_statistics") or []
    types = {s["column_name"]: s.get("source_type") for s in stats}
    expected, issues, rows_explained = [], [], False

    sf_left, src_left = [], []
    for c in ca.get("snowflake_only_columns") or []:
        why = _added(tx, c)
        (expected.append(f"{c} only in Snowflake - {why}") if why else sf_left.append(c))
    for c in ca.get("source_only_columns") or []:
        why = _removed(tx, c, tx["renamed"])
        (expected.append(f"{c} only in source - {why}") if why else src_left.append(c))

    def null_reason():
        if (ca.get("common_columns") or 0) != len(stats):
            return None   # LOB columns count in the total but have no per-column numbers: can't tell
        diffs = {s["column_name"]: (s["snowflake_stats"]["null_count"] or 0) - (s["source_stats"]["null_count"] or 0)
                 for s in stats if s["snowflake_stats"]["null_count"] != s["source_stats"]["null_count"]}
        total = (dq.get("snowflake_nulls") or 0) - (dq.get("source_nulls") or 0)
        if not diffs or sum(diffs.values()) != total:
            return None
        whys = {c: _changed(tx, c, types.get(c)) for c in diffs}
        if not all(whys.values()):
            return None
        for s in stats:
            if s["column_name"] in whys:
                s["expected"] = whys[s["column_name"]]
        return "; ".join(f"{c}: {w}" for c, w in whys.items())

    def dup_reason():
        if tx["dedup"]:
            return tx["dedup"]
        for s in stats:
            why = _changed(tx, s["column_name"], s.get("source_type"))
            if why:
                return f"{s['column_name']} values differ on purpose ({why}), so duplicate rows differ"
        return None

    issues_in = t.get("validation_issues") or []
    rc = t.get("row_counts") or {}
    row_mismatch = not rc.get("match", True)
    src_n, sf_n = rc.get("source"), rc.get("snowflake")
    way = "fewer" if isinstance(src_n, int) and isinstance(sf_n, int) and sf_n < src_n else "more" if isinstance(src_n, int) and isinstance(sf_n, int) else None
    reasons = [r["why"] for r in tx["rows"] if way and r["way"] in (way, "any")]
    filtered = "; ".join(reasons) if row_mismatch and reasons else None
    for issue in issues_in:
        if issue.startswith("Columns only in Snowflake:"):
            if sf_left:
                issues.append("Columns only in Snowflake: " + ", ".join(sorted(sf_left)))
            continue
        if issue.startswith("Columns only in Source:"):
            if src_left:
                issues.append("Columns only in Source: " + ", ".join(sorted(src_left)))
            continue
        why = None
        m = re.match(r"Column (.+?): distinct count mismatch", issue)
        if m:
            why = _changed(tx, m.group(1), types.get(m.group(1)))
            if why:
                for s in stats:
                    if s["column_name"] == m.group(1):
                        s["expected"] = why
        elif issue.startswith("Null count mismatch"):
            why = null_reason()
        elif issue.startswith("Duplicate count mismatch"):
            why = dup_reason()
        elif issue.startswith("Row count mismatch") and filtered:
            why, rows_explained = filtered, True
        if not why and filtered and not issue.startswith("Columns only"):
            why = "follows from the rows the pipeline leaves out"   # fewer rows: distinct / null / duplicate counts move too
        if why:
            expected.append(f"{issue} - {why}")
        else:
            issues.append(issue)

    t["validation_issues"] = issues
    if expected:
        t["expected_differences"] = expected
    if tx["unknown"] and (issues or row_mismatch):
        t["transformation_notes"] = [f"{u} - remaining differences may come from it" for u in tx["unknown"]]
    # same grading as the script, on what's left: rows differ (and the pipeline doesn't filter) = CRITICAL
    t["status"] = ("CRITICAL" if row_mismatch and not rows_explained else
                   "WARNING" if issues or row_mismatch else "PASSED")


def apply(result: dict, tx: dict) -> dict:
    result["transformations"] = describe_steps(tx)
    vr = result.get("validation_results")
    if not vr:
        return result
    tables = vr.get("table_validations") or []
    for t in tables:
        if t.get("status") in ("PASSED", "WARNING", "CRITICAL") and isinstance(t.get("column_analysis"), dict):
            _apply_table(t, tx)
    sm = vr.setdefault("summary", {})
    n = lambda st: sum(1 for t in tables if t.get("status") == st)
    sm.update(passed=n("PASSED"), critical=n("CRITICAL"), warnings=n("WARNING"),
              expected=sum(1 for t in tables if t.get("expected_differences")),
              success_rate=round(n("PASSED") / len(tables) * 100, 2) if tables else 0)
    return result
