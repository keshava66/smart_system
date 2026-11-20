"""Data Studio shared worksheets: up to three people in one Snowflake or
Postgres worksheet at the same time.

What is kept where:
  - The text, who is invited and the last run are in the portal database
    (studio_shared_* tables), so they survive restarts and are right on every
    worker.
  - Who is looking right now and where their cursor is lives in this process
    only (see "Live" below).

Typing together: a browser sends each edit as an operation against the last
revision it saw. If others got in first, the edit is rebased over theirs
(operational transformation, same scheme as ot.js) under a row lock, so
everyone ends with the same text and nobody's keystrokes are dropped. Positions
count UTF-16 units because that is what a JS string index is.

The browser listens on GET /{id}/stream (server-sent events) and gets every
edit in order, plus presence and meta changes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import db
from auth import require_permission

logger = logging.getLogger(__name__)

shared_router = APIRouter(prefix="/api/studio/shared", tags=["Data Studio - Shared worksheets"])

ENGINE_PERMS = {"snowflake": "runSnowflakeQueryRunner", "postgres": "runPostgresStudio"}
MAX_GUESTS = 2                  # owner + 2 = three people
MAX_SQL_UNITS = 500_000         # UTF-16 units
MAX_OP_PARTS = 20_000
OPS_KEEP = 2000                 # a browser further behind than this reloads the text
MAX_TABS_PER_USER = 4           # same person, same worksheet, several browser tabs
IDLE_POLL_SECONDS = 3.0         # how soon an edit made on another worker shows up
KEEPALIVE_SECONDS = 15
STREAM_MAX_SECONDS = 30 * 60    # then the browser reconnects with a fresh token

_CLIENT_RE = r"^[A-Za-z0-9_-]{8,40}$"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ============================================================================
# Text operations
#
# An operation walks the whole text once: a positive number keeps that many
# units, a string inserts it, a negative number deletes that many.
# ============================================================================

def _units(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _push(out: list, part):
    """Append, merging with the part before it when they are the same kind."""
    if part == 0 or part == "":
        return
    if out:
        last = out[-1]
        if isinstance(part, str) and isinstance(last, str):
            out[-1] = last + part
            return
        if not isinstance(part, str) and not isinstance(last, str) and (part > 0) == (last > 0):
            out[-1] = last + part
            return
    out.append(part)


def check_op(op: Any) -> list:
    """The operation as sent by a browser, validated. Raises ValueError."""
    if not isinstance(op, list) or not op or len(op) > MAX_OP_PARTS:
        raise ValueError("Malformed edit")
    out: list = []
    for part in op:
        if isinstance(part, str):
            part.encode("utf-16-le")       # refuses half of a surrogate pair
        elif isinstance(part, bool) or not isinstance(part, int):
            raise ValueError("Malformed edit")
        _push(out, part)
    return out


def apply_op(text: str, op: list) -> str:
    raw = text.encode("utf-16-le")
    out, i = [], 0
    for part in op:
        if isinstance(part, str):
            out.append(part.encode("utf-16-le"))
        elif part > 0:
            out.append(raw[i * 2:(i + part) * 2])
            i += part
        else:
            i -= part
    if i * 2 != len(raw):
        raise ValueError("Edit does not fit the text it was made against")
    # Strict on purpose: an edit that cuts a surrogate pair in half is refused.
    return b"".join(out).decode("utf-16-le")


def transform(a: list, b: list) -> Tuple[list, list]:
    """Two edits made against the same text. Returns (a2, b2) so that applying
    a then b2 gives the same text as b then a2. When both insert at the same
    spot, a's text goes first; the browser calls this with the same argument
    order (its own edit first), which is what keeps the two sides in step."""
    a2: list = []
    b2: list = []
    ia = ib = 0
    pa = a[0] if a else None
    pb = b[0] if b else None

    def nxt(seq, i):
        i += 1
        return (seq[i] if i < len(seq) else None), i

    while pa is not None or pb is not None:
        if isinstance(pa, str):
            _push(a2, pa)
            _push(b2, _units(pa))
            pa, ia = nxt(a, ia)
            continue
        if isinstance(pb, str):
            _push(a2, _units(pb))
            _push(b2, pb)
            pb, ib = nxt(b, ib)
            continue
        if pa is None or pb is None:
            raise ValueError("Edits were made against different text")
        n = min(abs(pa), abs(pb))
        if pa > 0 and pb > 0:
            _push(a2, n)
            _push(b2, n)
        elif pa < 0 and pb > 0:
            _push(a2, -n)
        elif pa > 0 and pb < 0:
            _push(b2, -n)
        # both delete the same stretch: nothing left to do for either
        pa = pa - n if pa > 0 else pa + n
        pb = pb - n if pb > 0 else pb + n
        if pa == 0:
            pa, ia = nxt(a, ia)
        if pb == 0:
            pb, ib = nxt(b, ib)
    return a2, b2


def transform_pos(pos: int, op: list) -> int:
    """Where a cursor at pos ends up after op."""
    new, left = pos, pos
    for part in op:
        if isinstance(part, str):
            new += _units(part)
        elif part > 0:
            left -= part
        else:
            new -= min(left, -part)
            left += part
        if left < 0:
            break
    return max(0, new)


# ============================================================================
# Live: who has the worksheet open in this process
#
# ponytail: presence and cursors are per process, like the query jobs in
# snowflake_query_runner / postgres_studio. Text and members come from the
# database, so with several workers edits still arrive everywhere (within
# IDLE_POLL_SECONDS); only the avatars and cursors of people on another worker
# are missing. Move this to LISTEN/NOTIFY if the API ever runs multi-worker.
# ============================================================================

class _Sub:
    """One open stream. wake/dirty are only touched on the event loop thread."""

    def __init__(self, client: str, email: str, name: str):
        self.client = client
        self.email = email
        self.name = name
        self.loop = asyncio.get_running_loop()
        self.wake = asyncio.Event()
        self.dirty: set = set()
        self.inbox: List[Dict[str, Any]] = []    # edits handed over by submit_op, no database read needed
        self.sel: Optional[Dict[str, int]] = None
        self.sel_rev = 0
        self.state = "idle"

    def poke(self, kinds, op=None):
        if op is not None:
            self.inbox.append(op)
        self.dirty.update(kinds)
        self.wake.set()


_subs: Dict[str, Dict[str, _Sub]] = {}
_subs_lock = threading.Lock()


def _notify(ws_id: str, *kinds: str, op: Optional[Dict[str, Any]] = None):
    with _subs_lock:
        subs = list(_subs.get(ws_id, {}).values())
    for s in subs:
        try:
            s.loop.call_soon_threadsafe(s.poke, kinds, op)
        except RuntimeError:        # loop closed during shutdown
            pass


def _peers(ws_id: str) -> List[Dict[str, Any]]:
    with _subs_lock:
        return [{"client": s.client, "email": s.email, "name": s.name, "sel": s.sel,
                 "rev": s.sel_rev, "state": s.state} for s in _subs.get(ws_id, {}).values()]


# ============================================================================
# Store
# ============================================================================

def _email(auth: dict) -> str:
    return (auth["user"].get("email") or "").strip().lower()


def _name(auth: dict) -> str:
    name = re.sub(r"\s*\[[^\]]*\]", "", auth["user"].get("name") or "").strip()
    return name or _email(auth)


def _need_engine(auth: dict, engine: str):
    if (auth.get("permissions") or {}).get(ENGINE_PERMS[engine]) is not True:
        raise HTTPException(status_code=403, detail=f"You don't have access to the {engine.title()} pane")


def _row(conn, ws_id: str, lock: bool = False):
    row = conn.execute(
        "SELECT * FROM studio_shared_worksheets WHERE id = ?" + (" FOR UPDATE" if lock else ""), (ws_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="This shared worksheet no longer exists")
    return row


def _members(conn, ws_id: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT user_email, user_name, can_edit FROM studio_shared_members WHERE worksheet_id = ? ORDER BY added_at, user_email",
        (ws_id,)).fetchall()
    return [{"email": r["user_email"], "name": r["user_name"], "can_edit": bool(r["can_edit"])} for r in rows]


def _role(row, members, email: str) -> Optional[str]:
    """owner | edit | view | None"""
    if row["owner_email"] == email:
        return "owner"
    for m in members:
        if m["email"] == email:
            return "edit" if m["can_edit"] else "view"
    return None


def _need_role(row, members, email: str, edit: bool = False, owner: bool = False) -> str:
    role = _role(row, members, email)
    if role is None:
        # Same answer as a missing worksheet, so ids can't be probed.
        raise HTTPException(status_code=404, detail="This shared worksheet no longer exists")
    if owner and role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can do that")
    if edit and role == "view":
        raise HTTPException(status_code=403, detail="You have view-only access to this worksheet")
    return role


def _meta(row, members, email: str) -> Dict[str, Any]:
    try:
        last_run = json.loads(row["last_run"]) if row["last_run"] else None
    except ValueError:
        last_run = None
    return {
        "id": row["id"], "engine": row["engine"], "name": row["name"],
        "database": row["database"] or None, "schema": row["schema"] or None,
        "owner": {"email": row["owner_email"], "name": row["owner_name"]},
        "members": members, "role": _role(row, members, email), "you": email,
        "last_run": last_run, "meta_rev": row["meta_rev"],
    }


def _snapshot(ws_id: str, auth: dict) -> Dict[str, Any]:
    email = _email(auth)
    with db.transaction(read_only=True) as conn:
        row = _row(conn, ws_id)
        members = _members(conn, ws_id)
    _need_engine(auth, row["engine"])
    _need_role(row, members, email)
    return {"meta": _meta(row, members, email), "sql": row["sql"], "rev": row["rev"]}


def _delta(ws_id: str, email: str, rev: int, meta_rev: int, full: bool = False) -> Optional[Dict[str, Any]]:
    """What a stream at (rev, meta_rev) is missing. None when the worksheet is
    gone or this person was removed from it."""
    out: Dict[str, Any] = {"ops": [], "meta": None, "init": None}
    with db.transaction(read_only=True) as conn:
        row = conn.execute("SELECT rev, meta_rev FROM studio_shared_worksheets WHERE id = ?", (ws_id,)).fetchone()
        if not row:
            return None
        if full or row["meta_rev"] != meta_rev:
            whole = _row(conn, ws_id)
            members = _members(conn, ws_id)
            if _role(whole, members, email) is None:
                return None
            out["meta"] = _meta(whole, members, email)
        if row["rev"] > rev:
            ops = conn.execute(
                "SELECT rev, client_id, seq, user_email, op FROM studio_shared_ops WHERE worksheet_id = ? AND rev > ? ORDER BY rev",
                (ws_id, rev)).fetchall()
            if ops and ops[0]["rev"] == rev + 1:
                out["ops"] = [{"rev": o["rev"], "client": o["client_id"], "seq": o["seq"], "email": o["user_email"],
                               "op": json.loads(o["op"])} for o in ops]
            else:
                # Too far behind (older edits were pruned): send the text itself.
                whole = _row(conn, ws_id)
                out["init"] = {"sql": whole["sql"], "rev": whole["rev"]}
        elif row["rev"] < rev:
            whole = _row(conn, ws_id)
            out["init"] = {"sql": whole["sql"], "rev": whole["rev"]}
    return out


def _bump(conn, ws_id: str, sets: str = "", params: tuple = ()):
    conn.execute(
        f"UPDATE studio_shared_worksheets SET {sets + ', ' if sets else ''}meta_rev = meta_rev + 1, updated_at = now() WHERE id = ?",
        params + (ws_id,))


def _audit(action: str, auth: dict, target: str, details: str = ""):
    from audit import write_audit_event
    write_audit_event(action, _email(auth), target, details)


# ---- used by snowflake_query_runner / postgres_studio ----------------------

def require_editor(ws_id: str, engine: str, email: str):
    """Before a query is run into a shared worksheet."""
    email = (email or "").strip().lower()
    with db.transaction(read_only=True) as conn:
        row = _row(conn, ws_id)
        members = _members(conn, ws_id)
    if row["engine"] != engine:
        raise HTTPException(status_code=400, detail="That shared worksheet belongs to the other pane")
    _need_role(row, members, email, edit=True)


def note_run(ws_id: str, auth: dict, job_id: str, sql: str):
    """Tells everyone in the worksheet a query was started, so their result
    grid follows it. Never raises: the query is already running."""
    try:
        run = {"job_id": job_id, "by": _email(auth), "by_name": _name(auth), "sql": (sql or "")[:20000], "at": time.time()}
        with db.transaction() as conn:
            _bump(conn, ws_id, "last_run = ?", (json.dumps(run),))
        _notify(ws_id, "ops")
    except Exception as e:
        logger.warning("Could not announce the run in shared worksheet %s: %s", ws_id, e)


def is_member(ws_id: str, email: str) -> bool:
    """Can this person read results of queries run in the worksheet."""
    email = (email or "").strip().lower()
    try:
        with db.transaction(read_only=True) as conn:
            return bool(conn.execute(
                """SELECT 1 FROM studio_shared_worksheets w WHERE w.id = ? AND (w.owner_email = ? OR EXISTS (
                       SELECT 1 FROM studio_shared_members m WHERE m.worksheet_id = w.id AND m.user_email = ?))""",
                (ws_id, email, email)).fetchone())
    except Exception as e:
        logger.warning("Shared worksheet membership check failed: %s", e)
        return False


# ============================================================================
# Endpoints
# ============================================================================

_auth = require_permission("viewDataStudio")


class CreateBody(BaseModel):
    engine: str
    name: str = Field(..., min_length=1, max_length=200)
    sql: str = ""
    database: Optional[str] = None
    schema_: Optional[str] = Field(None, alias="schema")

    model_config = {"populate_by_name": True}


class PatchBody(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    database: Optional[str] = Field(None, max_length=255)
    schema_: Optional[str] = Field(None, alias="schema", max_length=255)

    model_config = {"populate_by_name": True}


class MemberBody(BaseModel):
    email: str = Field(..., max_length=320)
    can_edit: bool = True
    name: str = Field("", max_length=200)     # from the directory, so the list reads well before they join


class Sel(BaseModel):
    a: int = Field(..., ge=0, le=MAX_SQL_UNITS)     # anchor
    h: int = Field(..., ge=0, le=MAX_SQL_UNITS)     # head


class OpBody(BaseModel):
    client: str = Field(..., pattern=_CLIENT_RE)
    seq: int = Field(..., ge=0)
    rev: int = Field(..., ge=0)
    op: list
    sel: Optional[Sel] = None


class CursorBody(BaseModel):
    client: str = Field(..., pattern=_CLIENT_RE)
    rev: int = Field(..., ge=0)
    sel: Optional[Sel] = None
    state: str = Field("idle", pattern="^(idle|running)$")


@shared_router.get("")
def list_shared(engine: str = Query(...), auth: dict = Depends(_auth)):
    if engine not in ENGINE_PERMS:
        raise HTTPException(status_code=400, detail="Unknown engine")
    _need_engine(auth, engine)
    email = _email(auth)
    with db.transaction(read_only=True, datetime_format=db.utc_naive_iso) as conn:
        rows = conn.execute(
            """SELECT w.id, w.name, w.owner_email, w.owner_name, w.updated_at,
                      (SELECT COUNT(*) FROM studio_shared_members m WHERE m.worksheet_id = w.id) AS guests
               FROM studio_shared_worksheets w
               WHERE w.engine = ? AND (w.owner_email = ? OR EXISTS (
                     SELECT 1 FROM studio_shared_members m WHERE m.worksheet_id = w.id AND m.user_email = ?))
               ORDER BY w.updated_at DESC, w.id""",
            (engine, email, email)).fetchall()
    return {"worksheets": [{"id": r["id"], "name": r["name"], "owner": {"email": r["owner_email"], "name": r["owner_name"]},
                            "owned": r["owner_email"] == email, "people": int(r["guests"]) + 1,
                            "updated_at": r["updated_at"]} for r in rows]}


@shared_router.post("")
def create_shared(body: CreateBody, auth: dict = Depends(_auth)):
    if body.engine not in ENGINE_PERMS:
        raise HTTPException(status_code=400, detail="Unknown engine")
    _need_engine(auth, body.engine)
    if _units(body.sql) > MAX_SQL_UNITS:
        raise HTTPException(status_code=413, detail="This worksheet is too large to share")
    ws_id = uuid.uuid4().hex
    with db.transaction() as conn:
        conn.execute(
            """INSERT INTO studio_shared_worksheets (id, engine, owner_email, owner_name, name, sql, database, schema)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (ws_id, body.engine, _email(auth), _name(auth), body.name.strip()[:200] or "Shared worksheet",
             body.sql, body.database or "", body.schema_ or ""))
    _audit("studio_share_create", auth, ws_id, f"Shared a {body.engine} worksheet: {body.name[:200]}")
    return _snapshot(ws_id, auth)


@shared_router.get("/{ws_id}")
def get_shared(ws_id: str, auth: dict = Depends(_auth)):
    return _snapshot(ws_id, auth)


@shared_router.patch("/{ws_id}")
def patch_shared(ws_id: str, body: PatchBody, auth: dict = Depends(_auth)):
    sets, params = [], []
    sent = body.model_fields_set
    if body.name is not None and body.name.strip():
        sets.append("name = ?")
        params.append(body.name.strip()[:200])
    if "database" in sent:
        sets.append("database = ?")
        params.append(body.database or "")
    if "schema_" in sent:
        sets.append("schema = ?")
        params.append(body.schema_ or "")
    if sets:
        with db.transaction() as conn:
            row = _row(conn, ws_id, lock=True)
            _need_engine(auth, row["engine"])
            _need_role(row, _members(conn, ws_id), _email(auth), edit=True)
            _bump(conn, ws_id, ", ".join(sets), tuple(params))
        _notify(ws_id, "ops")
    return _snapshot(ws_id, auth)


@shared_router.delete("/{ws_id}")
def delete_shared(ws_id: str, auth: dict = Depends(_auth)):
    """Stop sharing. Everyone who has it open keeps the text as a private copy."""
    with db.transaction() as conn:
        row = _row(conn, ws_id, lock=True)
        _need_role(row, _members(conn, ws_id), _email(auth), owner=True)
        conn.execute("DELETE FROM studio_shared_worksheets WHERE id = ?", (ws_id,))
    _audit("studio_share_delete", auth, ws_id, f"Stopped sharing worksheet: {row['name']}")
    _notify(ws_id, "ops")
    return {"deleted": True}


@shared_router.put("/{ws_id}/members")
def put_member(ws_id: str, body: MemberBody, auth: dict = Depends(_auth)):
    """Invite someone, or change what an invited person may do."""
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a full email address")
    with db.transaction() as conn:
        row = _row(conn, ws_id, lock=True)      # the lock is what makes the 3 people cap hold
        members = _members(conn, ws_id)
        _need_engine(auth, row["engine"])
        _need_role(row, members, _email(auth), owner=True)
        if email == row["owner_email"]:
            raise HTTPException(status_code=400, detail="You already own this worksheet")
        known = any(m["email"] == email for m in members)
        if not known and len(members) >= MAX_GUESTS:
            raise HTTPException(status_code=409, detail=f"A shared worksheet holds {MAX_GUESTS + 1} people. Remove someone first.")
        conn.execute(
            """INSERT INTO studio_shared_members (worksheet_id, user_email, can_edit, user_name) VALUES (?, ?, ?, ?)
               ON CONFLICT (worksheet_id, user_email) DO UPDATE SET can_edit = EXCLUDED.can_edit,
                   user_name = COALESCE(NULLIF(EXCLUDED.user_name, ''), studio_shared_members.user_name)""",
            (ws_id, email, body.can_edit, body.name.strip()))
        _bump(conn, ws_id)
    _audit("studio_share_member", auth, ws_id,
           f"{'Changed' if known else 'Invited'} {email} ({'can edit' if body.can_edit else 'view only'}) on worksheet: {row['name']}")
    _notify(ws_id, "ops")
    return _snapshot(ws_id, auth)


@shared_router.delete("/{ws_id}/members/{email}")
def delete_member(ws_id: str, email: str, auth: dict = Depends(_auth)):
    """The owner removes someone, or an invited person leaves."""
    email = email.strip().lower()
    me = _email(auth)
    with db.transaction() as conn:
        row = _row(conn, ws_id, lock=True)
        _need_role(row, _members(conn, ws_id), me, owner=(email != me))
        gone = conn.execute("DELETE FROM studio_shared_members WHERE worksheet_id = ? AND user_email = ?", (ws_id, email)).rowcount
        if gone:
            _bump(conn, ws_id)
    if gone:
        _audit("studio_share_member", auth, ws_id,
               f"{'Left' if email == me else 'Removed ' + email + ' from'} worksheet: {row['name']}")
        _notify(ws_id, "ops")
    return {"removed": bool(gone)}


@shared_router.post("/{ws_id}/ops")
def submit_op(ws_id: str, body: OpBody, auth: dict = Depends(_auth)):
    email = _email(auth)
    try:
        op = check_op(body.op)
    except (ValueError, UnicodeError) as e:
        raise HTTPException(status_code=400, detail=str(e) or "Malformed edit")
    sel = [body.sel.a, body.sel.h] if body.sel else None

    # Every keystroke comes through here, so it is kept to as few round trips
    # as it can be: lock + access + resend check in one, the write in one, and
    # the edits to rebase over only when someone else got in first.
    with db.transaction() as conn:
        row = conn.execute(
            """SELECT w.engine, w.owner_email, w.sql, w.rev,
                      (SELECT m.can_edit FROM studio_shared_members m
                        WHERE m.worksheet_id = w.id AND m.user_email = ?) AS can_edit,
                      EXISTS (SELECT 1 FROM studio_shared_ops o
                               WHERE o.worksheet_id = w.id AND o.client_id = ? AND o.seq = ?) AS resend
               FROM studio_shared_worksheets w WHERE w.id = ? FOR UPDATE OF w""",
            (email, body.client, body.seq, ws_id)).fetchone()
        if not row or (row["owner_email"] != email and row["can_edit"] is None):
            raise HTTPException(status_code=404, detail="This shared worksheet no longer exists")
        _need_engine(auth, row["engine"])
        if row["owner_email"] != email and not row["can_edit"]:
            raise HTTPException(status_code=403, detail="You have view-only access to this worksheet")
        rev = row["rev"]
        if row["resend"]:
            return {"rev": rev, "duplicate": True}     # it is already in
        if body.rev > rev:
            raise HTTPException(status_code=409, detail={"resync": True, "message": "Edit is ahead of the worksheet"})
        try:
            if body.rev < rev:
                later = conn.execute("SELECT op FROM studio_shared_ops WHERE worksheet_id = ? AND rev > ? ORDER BY rev",
                                     (ws_id, body.rev)).fetchall()
                if len(later) != rev - body.rev:
                    raise HTTPException(status_code=409, detail={"resync": True, "message": "Edit is too far behind the worksheet"})
                for r in later:
                    op, theirs = transform(op, json.loads(r["op"]))
                    if sel:
                        sel = [transform_pos(p, theirs) for p in sel]
            text = apply_op(row["sql"], op)
        except (ValueError, UnicodeError):
            raise HTTPException(status_code=409, detail={"resync": True, "message": "Edit does not fit the worksheet"})
        if _units(text) > MAX_SQL_UNITS:
            raise HTTPException(status_code=413, detail="This worksheet is at its size limit")
        rev += 1
        conn.execute(
            """WITH saved AS (UPDATE studio_shared_worksheets SET sql = ?, rev = ?, updated_at = now() WHERE id = ? RETURNING id)
               INSERT INTO studio_shared_ops (worksheet_id, rev, client_id, seq, user_email, op)
               SELECT id, ?, ?, ?, ?, ? FROM saved""",
            (text, rev, ws_id, rev, body.client, body.seq, email, json.dumps(op, ensure_ascii=False, separators=(",", ":"))))
        if rev % 200 == 0:
            conn.execute("DELETE FROM studio_shared_ops WHERE worksheet_id = ? AND rev <= ?", (ws_id, rev - OPS_KEEP))

    sel_out = {"a": sel[0], "h": sel[1]} if sel else None
    with _subs_lock:
        sub = _subs.get(ws_id, {}).get(body.client)
        if sub and sub.email == email:
            sub.sel, sub.sel_rev = sel_out, rev
    # Straight to everyone's open stream, cursor included, so the text and the
    # caret that typed it land in the same frame.
    _notify(ws_id, "edit", op={"rev": rev, "client": body.client, "seq": body.seq, "email": email, "op": op, "sel": sel_out})
    return {"rev": rev}


@shared_router.post("/{ws_id}/cursor")
def post_cursor(ws_id: str, body: CursorBody, auth: dict = Depends(_auth)):
    """Cursor moved, or a query started / finished. The browser only sends
    this while it has no unsent edits, so sel is in revision `rev` positions."""
    with _subs_lock:
        sub = _subs.get(ws_id, {}).get(body.client)
        if not sub or sub.email != _email(auth):
            raise HTTPException(status_code=404, detail="Not connected to this worksheet")
        sub.sel = body.sel.model_dump() if body.sel else None
        sub.sel_rev = body.rev
        sub.state = body.state
    _notify(ws_id, "presence")
    return {"ok": True}


def _sse(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


@shared_router.get("/{ws_id}/stream")
async def stream(ws_id: str, client: str = Query(..., pattern=_CLIENT_RE), rev: Optional[int] = Query(None, ge=0),
                 auth: dict = Depends(_auth)):
    """Everything that happens in the worksheet, in order.

    Events: init (the whole text), meta, op, presence, gone (deleted, or you
    were removed), reconnect (stream is old, open a new one). Pass ?rev= to
    pick up where a dropped stream stopped."""
    email, name = _email(auth), _name(auth)
    first = await asyncio.to_thread(_snapshot, ws_id, auth)     # 404 / 403 before any streaming starts
    with _subs_lock:
        mine = [s for s in _subs.get(ws_id, {}).values() if s.email == email and s.client != client]
    if len(mine) >= MAX_TABS_PER_USER:
        raise HTTPException(status_code=429, detail="You have this worksheet open in too many tabs")

    async def events():
        sub = _Sub(client, email, name)
        with _subs_lock:
            old = _subs.setdefault(ws_id, {}).get(client)
            _subs[ws_id][client] = sub
        if old:
            old.loop.call_soon_threadsafe(old.poke, ("replaced",))
        try:
            # Remember this person's display name for the others' member list.
            await asyncio.to_thread(_remember_name, ws_id, email, name)
            if rev is None:
                cursor = first["rev"]
                yield _sse("init", {"sql": first["sql"], "rev": first["rev"]})
            else:
                cursor = rev
            meta_rev = first["meta"]["meta_rev"]
            yield _sse("meta", first["meta"])
            sub.dirty.update(("check", "presence"))
            _notify(ws_id, "presence")

            started = beat = time.monotonic()
            while True:
                kinds, sub.dirty = sub.dirty, set()
                sub.wake.clear()
                if "replaced" in kinds:
                    return
                # Edits handed over by submit_op go out as they are. The
                # database is only asked when one is missing (made on another
                # worker), on the idle check, and for meta changes.
                inbox, sub.inbox = sub.inbox, []
                for o in inbox:
                    if o["rev"] == cursor + 1:
                        cursor = o["rev"]
                        yield _sse("op", o)
                        beat = time.monotonic()
                    elif o["rev"] > cursor + 1:
                        kinds.add("ops")
                if "ops" in kinds or "check" in kinds:
                    try:
                        d = await asyncio.to_thread(_delta, ws_id, email, cursor, meta_rev)
                    except Exception as e:
                        logger.info("Shared worksheet stream could not read changes: %s", e)
                        d = {"ops": [], "meta": None, "init": None}
                    if d is None:
                        yield _sse("gone", {})
                        return
                    if d["init"]:
                        cursor = d["init"]["rev"]
                        yield _sse("init", d["init"])
                    for o in d["ops"]:
                        cursor = o["rev"]
                        yield _sse("op", o)
                    if d["meta"]:
                        meta_rev = d["meta"]["meta_rev"]
                        yield _sse("meta", d["meta"])
                    if d["init"] or d["ops"] or d["meta"]:
                        beat = time.monotonic()
                if "presence" in kinds:
                    yield _sse("presence", {"peers": _peers(ws_id)})
                    beat = time.monotonic()

                now = time.monotonic()
                if now - started > STREAM_MAX_SECONDS:
                    yield _sse("reconnect", {})
                    return
                if now - beat >= KEEPALIVE_SECONDS:
                    yield ": keep-alive\n\n"        # proxies drop a silent stream
                    beat = now
                try:
                    await asyncio.wait_for(sub.wake.wait(), IDLE_POLL_SECONDS)
                except asyncio.TimeoutError:
                    sub.dirty.add("check")          # an edit made on another worker has no poke
        finally:
            with _subs_lock:
                room = _subs.get(ws_id, {})
                if room.get(client) is sub:
                    del room[client]
                if not room:
                    _subs.pop(ws_id, None)
            _notify(ws_id, "presence")

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


def _remember_name(ws_id: str, email: str, name: str):
    try:
        with db.transaction() as conn:
            changed = conn.execute(
                "UPDATE studio_shared_members SET user_name = ? WHERE worksheet_id = ? AND user_email = ? AND user_name <> ?",
                (name, ws_id, email, name)).rowcount
            changed += conn.execute(
                "UPDATE studio_shared_worksheets SET owner_name = ? WHERE id = ? AND owner_email = ? AND owner_name <> ?",
                (name, ws_id, email, name)).rowcount
            if changed:
                _bump(conn, ws_id)
    except Exception as e:
        logger.info("Could not store display name for shared worksheet: %s", e)
