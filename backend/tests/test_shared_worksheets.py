"""Shared worksheets: the text merge on its own, then the API against a real
PostgreSQL.

The API half needs a disposable database:
    SHARED_WS_TEST_PG_DSN="host=localhost port=5432 user=postgres dbname=regtest" \\
        python -m pytest tests/test_shared_worksheets.py -q
and is skipped without it. The portal's tables go in a throwaway schema.
"""

import json
import os
import random
import threading
import uuid

import pytest

DSN = os.environ.get("SHARED_WS_TEST_PG_DSN")
if DSN:
    os.environ["SMARTHUB_DB_DSN"] = DSN
    os.environ["SMARTHUB_DB_SCHEMA"] = "smarthub_test_" + uuid.uuid4().hex[:8]

import shared_worksheets as sw  # noqa: E402

ALPHABET = ["a", "b", " ", "\n", "é", "😀", "SELECT"]


def random_op(text, rng):
    """A random edit of text, never cutting an emoji in half."""
    op, i, chars = [], 0, list(text)
    while i < len(chars):
        n = rng.randint(1, min(4, len(chars) - i))
        units = sum(sw._units(c) for c in chars[i:i + n])
        roll = rng.random()
        if roll < 0.2:
            sw._push(op, rng.choice(ALPHABET))
        if roll < 0.6:
            sw._push(op, units)
        else:
            sw._push(op, -units)
        i += n
    if rng.random() < 0.3 or not op:
        sw._push(op, rng.choice(ALPHABET))
    return op or [""]


def random_text(rng):
    return "".join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 12)))


def test_transform_converges():
    rng = random.Random(7)
    for _ in range(3000):
        text = random_text(rng)
        a, b = random_op(text, rng), random_op(text, rng)
        a2, b2 = sw.transform(a, b)
        assert sw.apply_op(sw.apply_op(text, a), b2) == sw.apply_op(sw.apply_op(text, b), a2)


def test_same_spot_inserts_keep_both():
    a2, b2 = sw.transform([2, "X", 1], [2, "Y", 1])
    assert sw.apply_op(sw.apply_op("abc", [2, "X", 1]), b2) == "abXYc"
    assert sw.apply_op(sw.apply_op("abc", [2, "Y", 1]), a2) == "abXYc"


def test_positions_are_utf16_units():
    assert sw.apply_op("a😀b", [3, "!", 1]) == "a😀!b"
    with pytest.raises(ValueError):
        sw.apply_op("a😀b", [2, "!", 2])        # between the two halves of the emoji
    with pytest.raises(ValueError):
        sw.apply_op("abc", [2])                 # does not cover the text


def test_cursor_follows_edits():
    assert sw.transform_pos(5, [2, "xx", 8]) == 7
    assert sw.transform_pos(5, [2, -6, 2]) == 2
    assert sw.transform_pos(1, [2, "xx", 8]) == 1


def test_check_op_refuses_junk():
    for bad in (None, [], [True], [1.5], [{"a": 1}], "abc"):
        with pytest.raises(ValueError):
            sw.check_op(bad)
    assert sw.check_op([1, 2, "a", "b", -1, -1]) == [3, "ab", -2]


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

needs_db = pytest.mark.skipif(not DSN, reason="SHARED_WS_TEST_PG_DSN not set")

OWNER, ANN, BOB, CAT = "owner@x.com", "ann@x.com", "bob@x.com", "cat@x.com"


@pytest.fixture(scope="module")
def api():
    from fastapi import FastAPI, Header
    from fastapi.testclient import TestClient
    import auth
    import db

    async def fake_auth(x_test_user: str = Header(...), x_test_perms: str = Header("runPostgresStudio")):
        perms = {p: True for p in x_test_perms.split(",") if p}
        perms["viewDataStudio"] = True
        return {"user": {"email": x_test_user, "name": x_test_user.split("@")[0].title()}, "role": "user", "permissions": perms}

    app = FastAPI()
    app.include_router(sw.shared_router)
    app.dependency_overrides[auth.require_auth] = fake_auth
    with TestClient(app) as client:
        yield client
    with db.transaction() as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{os.environ["SMARTHUB_DB_SCHEMA"]}" CASCADE')
    db.close_pool()


def as_(user, perms="runPostgresStudio"):
    return {"X-Test-User": user, "X-Test-Perms": perms}


def make(api, sql="select 1", guests=((ANN, True),)):
    r = api.post("/api/studio/shared", json={"engine": "postgres", "name": "Team sheet", "sql": sql}, headers=as_(OWNER))
    assert r.status_code == 200, r.text
    ws = r.json()["meta"]["id"]
    for email, can_edit in guests:
        assert api.put(f"/api/studio/shared/{ws}/members", json={"email": email, "can_edit": can_edit}, headers=as_(OWNER)).status_code == 200
    return ws


def send(api, ws, user, rev, op, seq=0, client=None):
    return api.post(f"/api/studio/shared/{ws}/ops", headers=as_(user),
                    json={"client": client or (user.split("@")[0] + "-client-1"), "seq": seq, "rev": rev, "op": op})


def text_of(api, ws, user=OWNER):
    return api.get(f"/api/studio/shared/{ws}", headers=as_(user)).json()["sql"]


@needs_db
def test_three_people_and_no_more(api):
    ws = make(api, guests=((ANN, True), (BOB, False)))
    r = api.put(f"/api/studio/shared/{ws}/members", json={"email": CAT, "can_edit": True}, headers=as_(OWNER))
    assert r.status_code == 409
    # Changing someone already in is not a fourth person.
    assert api.put(f"/api/studio/shared/{ws}/members", json={"email": BOB, "can_edit": True}, headers=as_(OWNER)).status_code == 200
    # Only the owner invites.
    assert api.put(f"/api/studio/shared/{ws}/members", json={"email": CAT, "can_edit": True}, headers=as_(ANN)).status_code == 403
    meta = api.get(f"/api/studio/shared/{ws}", headers=as_(ANN)).json()["meta"]
    assert meta["role"] == "edit" and [m["email"] for m in meta["members"]] == [ANN, BOB]
    # A name from the directory is kept, and not wiped by a later change without one.
    api.put(f"/api/studio/shared/{ws}/members", json={"email": BOB, "can_edit": True, "name": "Bob Smith"}, headers=as_(OWNER))
    api.put(f"/api/studio/shared/{ws}/members", json={"email": BOB, "can_edit": False}, headers=as_(OWNER))
    bob = api.get(f"/api/studio/shared/{ws}", headers=as_(OWNER)).json()["meta"]["members"][1]
    assert bob == {"email": BOB, "name": "Bob Smith", "can_edit": False}


@needs_db
def test_outsiders_and_wrong_pane_are_kept_out(api):
    ws = make(api)
    assert api.get(f"/api/studio/shared/{ws}", headers=as_(CAT)).status_code == 404
    assert send(api, ws, CAT, 0, [8, "x"]).status_code == 404
    assert api.get(f"/api/studio/shared/{ws}", headers=as_(ANN, "runSnowflakeQueryRunner")).status_code == 403
    assert not sw.is_member(ws, CAT) and sw.is_member(ws, ANN) and sw.is_member(ws, OWNER)


@needs_db
def test_view_only_cannot_edit_or_run(api):
    from fastapi import HTTPException
    ws = make(api, guests=((ANN, False),))
    assert send(api, ws, ANN, 0, [8, "x"]).status_code == 403
    assert api.patch(f"/api/studio/shared/{ws}", json={"name": "mine now"}, headers=as_(ANN)).status_code == 403
    with pytest.raises(HTTPException) as e:
        sw.require_editor(ws, "postgres", ANN)
    assert e.value.status_code == 403
    sw.require_editor(ws, "postgres", OWNER)
    with pytest.raises(HTTPException):
        sw.require_editor(ws, "snowflake", OWNER)


@needs_db
def test_edits_against_the_same_revision_both_land(api):
    ws = make(api, sql="select 1")
    assert send(api, ws, OWNER, 0, ["-- top\n", 8]).json()["rev"] == 1
    # Ann had not seen that yet; hers is rebased over it.
    assert send(api, ws, ANN, 0, [8, " from t"]).json()["rev"] == 2
    assert text_of(api, ws) == "-- top\nselect 1 from t"


@needs_db
def test_resend_is_not_applied_twice(api):
    ws = make(api, sql="")
    assert send(api, ws, OWNER, 0, ["a"], seq=1).json() == {"rev": 1}
    assert send(api, ws, OWNER, 0, ["a"], seq=1).json() == {"rev": 1, "duplicate": True}
    assert text_of(api, ws) == "a"


@needs_db
def test_bad_edits_ask_for_a_resync(api):
    ws = make(api, sql="abc")
    assert send(api, ws, OWNER, 5, [3, "x"]).status_code == 409           # from the future
    r = send(api, ws, OWNER, 0, [9, "x"])                                  # does not fit
    assert r.status_code == 409 and r.json()["detail"]["resync"] is True
    assert send(api, ws, OWNER, 0, [3, 1.5]).status_code == 400
    assert text_of(api, ws) == "abc"


@needs_db
def test_people_typing_at_once_end_up_with_the_same_text(api):
    """Three people, each a thread, each rebasing its own view the way the
    browser does. Everything they typed must be in the final text once."""
    ws = make(api, sql="", guests=((ANN, True), (BOB, True)))
    errors = []

    def typist(user, word):
        try:
            rev, text = 0, ""
            for i, ch in enumerate(word):
                while True:
                    r = send(api, ws, user, rev, ([sw._units(text)] if text else []) + [ch], seq=i)
                    if r.status_code == 200:
                        break
                    assert r.status_code == 409, r.text
                    snap = api.get(f"/api/studio/shared/{ws}", headers=as_(user)).json()
                    rev, text = snap["rev"], snap["sql"]
                snap = api.get(f"/api/studio/shared/{ws}", headers=as_(user)).json()
                rev, text = snap["rev"], snap["sql"]
        except Exception as e:      # noqa: BLE001
            errors.append(e)

    words = {OWNER: "A" * 15, ANN: "B" * 15, BOB: "C" * 15}
    threads = [threading.Thread(target=typist, args=item) for item in words.items()]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors, errors
    final = text_of(api, ws)
    assert sorted(final) == sorted("".join(words.values()))


@needs_db
def test_removed_person_loses_the_worksheet(api):
    ws = make(api)
    assert api.delete(f"/api/studio/shared/{ws}/members/{BOB}", headers=as_(ANN)).status_code == 403    # not the owner
    assert api.delete(f"/api/studio/shared/{ws}/members/{ANN}", headers=as_(OWNER)).json() == {"removed": True}
    assert api.get(f"/api/studio/shared/{ws}", headers=as_(ANN)).status_code == 404
    assert sw._delta(ws, ANN, 0, 0) is None


@needs_db
def test_guest_can_leave_and_owner_can_stop_sharing(api):
    ws = make(api)
    assert api.delete(f"/api/studio/shared/{ws}/members/{ANN}", headers=as_(ANN)).json() == {"removed": True}
    assert api.delete(f"/api/studio/shared/{ws}", headers=as_(ANN)).status_code == 404
    assert api.delete(f"/api/studio/shared/{ws}", headers=as_(OWNER)).json() == {"deleted": True}
    assert sw._delta(ws, OWNER, 0, 0) is None


@needs_db
def test_stream_catches_a_late_browser_up(api):
    ws = make(api, sql="x")
    send(api, ws, OWNER, 0, [1, "y"])
    send(api, ws, ANN, 1, [2, "z"])
    d = sw._delta(ws, ANN, 0, -1)
    assert [o["rev"] for o in d["ops"]] == [1, 2] and d["meta"]["role"] == "edit" and d["init"] is None
    assert sw._delta(ws, ANN, 2, d["meta"]["meta_rev"]) == {"ops": [], "meta": None, "init": None}
    # Older edits gone (pruned): the text itself is sent.
    import db
    with db.transaction() as conn:
        conn.execute("DELETE FROM studio_shared_ops WHERE worksheet_id = ? AND rev = 1", (ws,))
    assert sw._delta(ws, ANN, 0, -1)["init"] == {"sql": "xyz", "rev": 2}


@needs_db
def test_a_run_is_announced_to_the_worksheet(api):
    ws = make(api)
    before = api.get(f"/api/studio/shared/{ws}", headers=as_(ANN)).json()["meta"]
    sw.note_run(ws, {"user": {"email": OWNER, "name": "Owner"}}, "job123", "select 1")
    after = api.get(f"/api/studio/shared/{ws}", headers=as_(ANN)).json()["meta"]
    assert after["last_run"]["job_id"] == "job123" and after["last_run"]["by"] == OWNER
    assert after["meta_rev"] == before["meta_rev"] + 1


def parse(chunk):
    event, data = chunk.strip().split("\n", 1)
    return event[len("event: "):], json.loads(data[len("data: "):])


@needs_db
def test_stream_sends_state_then_live_edits(api):
    """Reads the stream the way the ASGI server does (TestClient would wait
    for it to end, and it doesn't)."""
    import asyncio
    ws = make(api, sql="select 42")
    auth = {"user": {"email": OWNER, "name": "Owner"}, "permissions": {"viewDataStudio": True, "runPostgresStudio": True}}

    async def scenario():
        resp = await sw.stream(ws, client="owner-client-1", rev=None, auth=auth)
        it = resp.body_iterator
        seen = [parse(await anext(it)) for _ in range(3)]
        # Ann types while the owner is listening.
        await asyncio.to_thread(send, api, ws, ANN, 0, [9, " + 1"])
        seen.append(parse(await asyncio.wait_for(anext(it), 5)))
        await it.aclose()
        return seen

    seen = asyncio.run(scenario())
    assert seen[0] == ("init", {"sql": "select 42", "rev": 0})
    assert seen[1][0] == "meta" and seen[1][1]["role"] == "owner"
    assert seen[2][0] == "presence" and [p["email"] for p in seen[2][1]["peers"]] == [OWNER]
    assert seen[3][0] == "op" and seen[3][1]["op"] == [9, " + 1"] and seen[3][1]["email"] == ANN
    assert sw._peers(ws) == []      # closing the stream took the owner out of the room
