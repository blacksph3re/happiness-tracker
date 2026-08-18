import csv
import sqlite3
from datetime import datetime
from io import BytesIO
from itertools import count
from zipfile import ZipFile

from tests.conftest import make_user

HOUR = 3600


def at(day, hour, minute=0):
    """Build an instant on a day in June 2026, as the API takes it."""
    return datetime(2026, 6, day, hour, minute).isoformat()


def make_project(client, headers, name="The rewrite", **extra):
    """Create a project and return its body."""
    response = client.post(
        "/api/projects", headers=headers, json={"name": name, **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


def make_tag(client, headers, name="Work", **extra):
    """Create a tag and return its body."""
    response = client.post("/api/tags", headers=headers, json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


# Sessions are written one way now — the sync queue — so the helpers speak it.
# The app has no other door, and a test that used one would be testing something
# nobody can reach.
_written = count(1)


def stamp(seq):
    """Return a clock that advances with the sequence, so later is later."""
    return f"2026-06-15T{seq // 60:02d}:{seq % 60:02d}:00"


def send(client, headers, intents):
    """Replay intents and return the results by sequence number."""
    response = client.post("/api/sync", headers=headers, json={"intents": intents})
    assert response.status_code == 200, response.text
    return {row["seq"]: row for row in response.json()["results"]}


def write_entry(client, headers, project_id, start, end, offset=0, client_id=None):
    """Record one session, as a device would.

    Returns
    -------
    tuple of (str, dict)
        The identity the session was given, and the server's verdict on it.
    """
    seq = next(_written)
    identity = client_id or f"test-{seq}"
    results = send(
        client,
        headers,
        [
            {
                "seq": seq,
                "kind": "entry.upsert",
                "client_id": identity,
                # Ordered by the sequence, so a correction made later in a test
                # is later by the clock the merge rules read.
                "client_updated_at": f"2026-06-15T{seq // 60:02d}:{seq % 60:02d}:00",
                "payload": {
                    "project_id": project_id,
                    "started_at": start,
                    "ended_at": end,
                    "utc_offset": offset,
                },
            }
        ],
    )
    return identity, results[seq]


def record(client, headers, project_id, start, end, offset=0):
    """Add a finished session, ignoring its identity."""
    return write_entry(client, headers, project_id, start, end, offset)[1]


def check_in(client, headers, project_id, day=10, hour=9, offset=0):
    """Start a timer: a session with no end yet."""
    return write_entry(client, headers, project_id, at(day, hour), None, offset)


def check_out(client, headers, project_id, identity, started, day=10, hour=17):
    """Stop a timer by writing the same session with an end."""
    return write_entry(
        client, headers, project_id, started, at(day, hour), client_id=identity
    )


def totals(client, headers, by="project", **params):
    """Read the summary as ``{(day, key): seconds}``."""
    response = client.get(
        "/api/time/summary", headers=headers, params={"by": by, **params}
    )
    assert response.status_code == 200, response.text
    return {(row["day"], row["key"]): row["seconds"] for row in response.json()}


def test_a_new_account_has_no_projects(client, admin_headers):
    assert client.get("/api/projects", headers=admin_headers).json() == []


def test_two_projects_run_at_once(client, admin_headers):
    work = make_project(client, admin_headers, "Work")
    meeting = make_project(client, admin_headers, "Meeting")
    assert (
        check_in(client, admin_headers, work["id"], hour=9)[1]["outcome"] == "applied"
    )
    assert (
        check_in(client, admin_headers, meeting["id"], hour=11)[1]["outcome"]
        == "applied"
    )

    running = [
        e
        for e in client.get("/api/time/entries", headers=admin_headers).json()
        if e["ended_at"] is None
    ]
    assert len(running) == 2


def test_the_database_itself_refuses_a_second_open_entry(
    client, admin_headers, tmp_path
):
    # Not only the service: the partial unique index is what makes the rule
    # hold for anything that writes to this database.
    project = make_project(client, admin_headers)
    identity, _ = check_in(client, admin_headers, project["id"])
    entry = client.get("/api/time/entries", headers=admin_headers).json()[0]

    db = sqlite3.connect(tmp_path / "test.db")
    try:
        db.execute(
            "INSERT INTO time_entries (user_id, project_id, started_at, ended_at,"
            " utc_offset) VALUES (1, ?, '2026-06-10 12:00:00', NULL, 0)",
            (entry["project_id"],),
        )
    except sqlite3.IntegrityError as error:
        message = str(error).lower()
        assert "uq_open_entry_per_project" in message or "unique" in message
    else:
        raise AssertionError("the database allowed two open entries on one project")
    finally:
        db.close()


def test_two_users_may_run_the_same_project_name(client, admin_headers):
    _, other = make_user(client, admin_headers, "colleague")
    mine = make_project(client, admin_headers, "Shared name")
    theirs = make_project(client, other, "Shared name")
    assert check_in(client, admin_headers, mine["id"])[1]["outcome"] == "applied"
    assert check_in(client, other, theirs["id"])[1]["outcome"] == "applied"


def test_a_duplicate_project_name_is_refused_for_one_user(client, admin_headers):
    make_project(client, admin_headers, "Twice")
    again = client.post("/api/projects", headers=admin_headers, json={"name": "Twice"})
    assert again.status_code == 409


def test_a_session_ending_before_it_starts_is_refused(client, admin_headers):
    project = make_project(client, admin_headers)
    refused = record(client, admin_headers, project["id"], at(10, 17), at(10, 9))
    assert refused["outcome"] == "conflict"


def test_a_session_over_midnight_is_split_across_both_days(client, admin_headers):
    project = make_project(client, admin_headers)
    record(client, admin_headers, project["id"], at(10, 22), at(11, 2))
    assert totals(client, admin_headers) == {
        ("2026-06-10", project["id"]): 2 * HOUR,
        ("2026-06-11", project["id"]): 2 * HOUR,
    }


def test_a_running_session_is_counted_up_to_as_of(client, admin_headers):
    project = make_project(client, admin_headers)
    check_in(client, admin_headers, project["id"], hour=9)
    counted = totals(client, admin_headers, as_of=at(10, 11))
    assert counted == {("2026-06-10", project["id"]): 2 * HOUR}


def test_parallel_sessions_are_added(client, admin_headers):
    work = make_project(client, admin_headers, "Work")
    meeting = make_project(client, admin_headers, "Meeting")
    record(client, admin_headers, work["id"], at(10, 9), at(10, 17))
    record(client, admin_headers, meeting["id"], at(10, 11), at(10, 12))
    # Nine tracked hours on a 24-hour day: that is what a sum over projects is.
    counted = totals(client, admin_headers)
    assert counted[("2026-06-10", work["id"])] == 8 * HOUR
    assert counted[("2026-06-10", meeting["id"])] == HOUR


def test_sessions_that_merely_touch_are_allowed(client, admin_headers):
    project = make_project(client, admin_headers)
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    assert (
        record(client, admin_headers, project["id"], at(10, 12), at(10, 13))["outcome"]
        == "applied"
    )


def test_a_tag_totals_its_projects(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    one = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    two = make_project(client, admin_headers, "Reviews", tag_ids=[tag["id"]])
    record(client, admin_headers, one["id"], at(10, 9), at(10, 12))
    record(client, admin_headers, two["id"], at(10, 13), at(10, 14))
    assert totals(client, admin_headers, by="tag") == {
        ("2026-06-10", tag["id"]): 4 * HOUR
    }


def test_a_project_with_two_tags_counts_in_both(client, admin_headers):
    work = make_tag(client, admin_headers, "Work")
    meetings = make_tag(client, admin_headers, "Meetings")
    standup = make_project(
        client, admin_headers, "Standup", tag_ids=[work["id"], meetings["id"]]
    )
    record(client, admin_headers, standup["id"], at(10, 9), at(10, 10))
    assert totals(client, admin_headers, by="tag") == {
        ("2026-06-10", work["id"]): HOUR,
        ("2026-06-10", meetings["id"]): HOUR,
    }


def test_untagged_work_is_reported_under_no_tag(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    tagged = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    loose = make_project(client, admin_headers, "Reading")
    record(client, admin_headers, tagged["id"], at(10, 9), at(10, 10))
    record(client, admin_headers, loose["id"], at(10, 11), at(10, 13))
    assert totals(client, admin_headers, by="tag") == {
        ("2026-06-10", tag["id"]): HOUR,
        ("2026-06-10", None): 2 * HOUR,
    }


def test_deleting_a_tag_keeps_the_time(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))

    assert (
        client.delete(f"/api/tags/{tag['id']}", headers=admin_headers).status_code
        == 204
    )
    assert totals(client, admin_headers) == {("2026-06-10", project["id"]): 3 * HOUR}
    # The same time, now reported as untagged.
    assert totals(client, admin_headers, by="tag") == {("2026-06-10", None): 3 * HOUR}


def test_retagging_regroups_history(client, admin_headers):
    old = make_tag(client, admin_headers, "Old")
    new = make_tag(client, admin_headers, "New")
    project = make_project(client, admin_headers, "Backend", tag_ids=[old["id"]])
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))

    client.put(
        f"/api/projects/{project['id']}",
        headers=admin_headers,
        json={"tag_ids": [new["id"]]},
    )
    # A label is a view of the time, not a second record of it, so yesterday
    # regroups too.
    assert totals(client, admin_headers, by="tag") == {
        ("2026-06-10", new["id"]): 3 * HOUR
    }


def test_the_range_includes_a_session_merely_overlapping_it(client, admin_headers):
    project = make_project(client, admin_headers)
    record(client, admin_headers, project["id"], at(9, 22), at(11, 3))
    counted = totals(client, admin_headers, start="2026-06-10", end="2026-06-10")
    assert counted == {("2026-06-10", project["id"]): 24 * HOUR}


def test_another_users_project_tag_and_entry_are_missing(client, admin_headers):
    _, other = make_user(client, admin_headers, "stranger")
    project = make_project(client, admin_headers)
    tag = make_tag(client, admin_headers)
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    entry = client.get("/api/time/entries", headers=admin_headers).json()[0]

    assert (
        client.put(
            f"/api/projects/{project['id']}", headers=other, json={"name": "mine now"}
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/tags/{tag['id']}", headers=other, json={"name": "mine now"}
        ).status_code
        == 404
    )
    # A queue is always replayed as the account that sent it, so another user's
    # session is not something a stranger can name, let alone delete.
    stranger = send(
        client,
        other,
        [
            {
                "seq": 901,
                "kind": "entry.delete",
                "client_id": entry["client_id"],
                "client_updated_at": "2026-06-15T23:00:00",
            }
        ],
    )
    assert stranger[901]["outcome"] == "applied"
    assert len(client.get("/api/time/entries", headers=admin_headers).json()) == 1
    assert client.get("/api/time/entries", headers=other).json() == []


def test_deleting_a_tracked_project_is_refused(client, admin_headers):
    project = make_project(client, admin_headers)
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    assert (
        client.delete(
            f"/api/projects/{project['id']}", headers=admin_headers
        ).status_code
        == 409
    )


def test_an_untracked_project_can_be_deleted(client, admin_headers):
    project = make_project(client, admin_headers)
    assert (
        client.delete(
            f"/api/projects/{project['id']}", headers=admin_headers
        ).status_code
        == 204
    )


def test_archiving_a_running_project_is_refused(client, admin_headers):
    project = make_project(client, admin_headers)
    identity, _ = check_in(client, admin_headers, project["id"])
    refused = client.put(
        f"/api/projects/{project['id']}", headers=admin_headers, json={"active": False}
    )
    assert refused.status_code == 409

    check_out(client, admin_headers, project["id"], identity, at(10, 9))
    assert (
        client.put(
            f"/api/projects/{project['id']}",
            headers=admin_headers,
            json={"active": False},
        ).status_code
        == 200
    )


def test_correcting_a_session_moves_the_total(client, admin_headers):
    project = make_project(client, admin_headers)
    identity, _ = write_entry(
        client, admin_headers, project["id"], at(10, 9), at(10, 12)
    )

    write_entry(
        client, admin_headers, project["id"], at(10, 9), at(10, 17), client_id=identity
    )
    assert totals(client, admin_headers) == {("2026-06-10", project["id"]): 8 * HOUR}


def test_deleting_a_session_removes_its_time(client, admin_headers):
    project = make_project(client, admin_headers)
    identity, _ = write_entry(
        client, admin_headers, project["id"], at(10, 9), at(10, 12)
    )
    results = send(
        client,
        admin_headers,
        [
            {
                "seq": 900,
                "kind": "entry.delete",
                "client_id": identity,
                "client_updated_at": "2026-06-15T23:00:00",
            }
        ],
    )
    assert results[900]["outcome"] == "applied"
    assert totals(client, admin_headers) == {}


def test_a_running_session_can_be_deleted(client, admin_headers):
    # The accidental tap: there is no end time to correct, so removing the row
    # has to be possible.
    project = make_project(client, admin_headers)
    identity, _ = check_in(client, admin_headers, project["id"])

    results = send(
        client,
        admin_headers,
        [
            {
                "seq": 902,
                "kind": "entry.delete",
                "client_id": identity,
                "client_updated_at": "2026-06-15T23:00:00",
            }
        ],
    )
    assert results[902]["outcome"] == "applied"
    assert client.get("/api/time/entries", headers=admin_headers).json() == []
    # And the project is startable again, so the index released with the row.
    assert (
        check_in(client, admin_headers, project["id"], hour=11)[1]["outcome"]
        == "applied"
    )


def test_an_archived_project_leaves_the_summary(client, admin_headers):
    kept = make_project(client, admin_headers, "Backend")
    retired = make_project(client, admin_headers, "Reading")
    record(client, admin_headers, kept["id"], at(10, 9), at(10, 12))
    record(client, admin_headers, retired["id"], at(10, 20), at(10, 21))

    assert len(totals(client, admin_headers)) == 2
    client.put(
        f"/api/projects/{retired['id']}", headers=admin_headers, json={"active": False}
    )

    # Gone from the reports...
    assert totals(client, admin_headers) == {("2026-06-10", kept["id"]): 3 * HOUR}
    # ...but the hours are still recorded, and still exported.
    rows = client.get("/api/time/entries", headers=admin_headers).json()
    assert len(rows) == 2
    assert any(row["project_id"] == retired["id"] for row in rows)


def set_rule(client, headers, tag_id, bands=(), add_minutes=None):
    """Replace a tag's whole rule — what it adds, and what it deducts."""
    return client.put(
        f"/api/tags/{tag_id}/rule",
        headers=headers,
        json={"add_minutes": add_minutes, "bands": list(bands)},
    )


def set_bands(client, headers, tag_id, bands):
    """Replace a tag's deduction bands, leaving its addition alone."""
    return set_rule(client, headers, tag_id, bands)


def tag_rows(client, headers, **params):
    """Read the tag summary as ``{(day, tag): row}``."""
    response = client.get(
        "/api/time/summary", headers=headers, params={"by": "tag", **params}
    )
    return {(row["day"], row["key"]): row for row in response.json()}


def test_a_tag_with_no_rule_reports_what_it_tracked(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    record(client, admin_headers, project["id"], at(10, 9), at(10, 17))

    row = tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]
    assert row["seconds"] == 8 * HOUR
    assert row["deduction"] == 0
    assert row["reported"] == 8 * HOUR


def test_a_capping_band_holds_the_day_at_its_threshold(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    assert (
        set_bands(
            client,
            admin_headers,
            tag["id"],
            [{"from_minutes": 600, "deduct_minutes": None}],
        ).status_code
        == 200
    )

    record(client, admin_headers, project["id"], at(10, 8), at(10, 22))
    row = tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]
    assert (row["seconds"], row["deduction"], row["reported"]) == (
        14 * HOUR,
        4 * HOUR,
        10 * HOUR,
    )

    stored = client.get(f"/api/tags/{tag['id']}/rule", headers=admin_headers).json()
    assert stored == {
        "add_minutes": None,
        "bands": [{"from_minutes": 600, "deduct_minutes": None}],
    }


def test_a_rule_can_add_time_to_every_tracked_day(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    assert set_rule(client, admin_headers, tag["id"], add_minutes=60).status_code == 200

    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    row = tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]

    assert (row["seconds"], row["added"], row["deduction"], row["reported"]) == (
        3 * HOUR,
        HOUR,
        0,
        4 * HOUR,
    )


def test_the_addition_lands_before_the_bands_are_tested(client, admin_headers):
    # Three tracked hours do not reach a 210-minute threshold; three plus an
    # added one do. End to end, because the ordering has to survive the summary
    # as well as the arithmetic.
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    set_rule(
        client,
        admin_headers,
        tag["id"],
        bands=[{"from_minutes": 210, "deduct_minutes": 20}],
        add_minutes=60,
    )

    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    row = tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]

    assert row["reported"] == 3 * HOUR + 40 * 60
    # And the four fields reconcile, which is the whole reason `added` is sent.
    assert row["seconds"] + row["added"] - row["deduction"] == row["reported"]


def test_an_untracked_day_earns_no_addition(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    set_rule(client, admin_headers, tag["id"], add_minutes=60)
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))

    # The 11th was never tracked, so it has no row at all — an addition cannot
    # conjure a day into the summary.
    assert ("2026-06-11", tag["id"]) not in tag_rows(client, admin_headers)


def test_an_addition_of_zero_is_stored_as_no_addition(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    assert set_rule(client, admin_headers, tag["id"], add_minutes=0).status_code == 200

    stored = client.get(f"/api/tags/{tag['id']}/rule", headers=admin_headers).json()
    assert stored["add_minutes"] is None


def test_a_negative_addition_is_refused(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    refused = set_rule(client, admin_headers, tag["id"], add_minutes=-30)
    assert refused.status_code == 422


def test_a_lunch_rule_deducts_by_band(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    assert (
        set_bands(
            client,
            admin_headers,
            tag["id"],
            [
                {"from_minutes": 0, "deduct_minutes": 30},
                {"from_minutes": 360, "deduct_minutes": 45},
            ],
        ).status_code
        == 200
    )

    # A short day: half an hour.
    record(client, admin_headers, project["id"], at(10, 9), at(10, 13))
    short = tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]
    assert (short["seconds"], short["deduction"], short["reported"]) == (
        4 * HOUR,
        1800,
        4 * HOUR - 1800,
    )

    # A long one: three quarters.
    record(client, admin_headers, project["id"], at(11, 9), at(11, 18))
    long_day = tag_rows(client, admin_headers)[("2026-06-11", tag["id"])]
    assert (long_day["seconds"], long_day["deduction"], long_day["reported"]) == (
        9 * HOUR,
        2700,
        9 * HOUR - 2700,
    )


def test_the_rule_is_retroactive(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    record(client, admin_headers, project["id"], at(10, 9), at(10, 17))

    set_bands(
        client, admin_headers, tag["id"], [{"from_minutes": 0, "deduct_minutes": 60}]
    )
    # Nothing was recomputed, because nothing was stored.
    assert tag_rows(client, admin_headers)[("2026-06-10", tag["id"])]["reported"] == (
        7 * HOUR
    )


def test_the_rule_belongs_to_its_tag_alone(client, admin_headers):
    work = make_tag(client, admin_headers, "Work")
    reading = make_tag(client, admin_headers, "Reading")
    worked = make_project(client, admin_headers, "Backend", tag_ids=[work["id"]])
    read = make_project(client, admin_headers, "A book", tag_ids=[reading["id"]])
    set_bands(
        client, admin_headers, work["id"], [{"from_minutes": 0, "deduct_minutes": 45}]
    )

    record(client, admin_headers, worked["id"], at(10, 9), at(10, 17))
    record(client, admin_headers, read["id"], at(10, 19), at(10, 21))

    rows = tag_rows(client, admin_headers)
    assert rows[("2026-06-10", work["id"])]["reported"] == 8 * HOUR - 2700
    # A day of reading owes nobody a lunch break.
    assert rows[("2026-06-10", reading["id"])]["reported"] == 2 * HOUR


def test_project_rows_carry_no_deduction(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    project = make_project(client, admin_headers, "Backend", tag_ids=[tag["id"]])
    set_bands(
        client, admin_headers, tag["id"], [{"from_minutes": 0, "deduct_minutes": 45}]
    )
    record(client, admin_headers, project["id"], at(10, 9), at(10, 17))

    row = next(
        row
        for row in client.get("/api/time/summary", headers=admin_headers).json()
        if row["key"] == project["id"]
    )
    # A deduction belongs to a tag; a project bar stays tracked time.
    assert (row["deduction"], row["reported"]) == (0, 8 * HOUR)


def test_two_bands_at_the_same_threshold_are_refused(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    refused = set_bands(
        client,
        admin_headers,
        tag["id"],
        [
            {"from_minutes": 0, "deduct_minutes": 30},
            {"from_minutes": 0, "deduct_minutes": 45},
        ],
    )
    assert refused.status_code == 422


def test_deleting_a_tag_takes_its_rule(client, admin_headers):
    tag = make_tag(client, admin_headers, "Work")
    set_bands(
        client, admin_headers, tag["id"], [{"from_minutes": 0, "deduct_minutes": 30}]
    )
    assert (
        client.delete(f"/api/tags/{tag['id']}", headers=admin_headers).status_code
        == 204
    )


def test_another_users_rule_is_missing(client, admin_headers):
    _, other = make_user(client, admin_headers, "bystander")
    tag = make_tag(client, admin_headers, "Work")
    assert client.get(f"/api/tags/{tag['id']}/rule", headers=other).status_code == 404
    assert set_bands(client, other, tag["id"], []).status_code == 404


def test_the_tracked_range_reports_the_edges(client, admin_headers):
    empty = client.get("/api/time/range", headers=admin_headers).json()
    assert empty == {"first": None, "last": None}

    project = make_project(client, admin_headers)
    record(client, admin_headers, project["id"], at(10, 9), at(10, 12))
    record(client, admin_headers, project["id"], at(14, 9), at(14, 12))

    assert client.get("/api/time/range", headers=admin_headers).json() == {
        "first": "2026-06-10",
        "last": "2026-06-14",
    }


def test_the_tracked_range_reads_each_days_own_offset(client, admin_headers):
    project = make_project(client, admin_headers)
    # 23:30 UTC is already the next day two hours east.
    record(client, admin_headers, project["id"], at(10, 23, 30), at(11, 1), offset=120)
    assert client.get("/api/time/range", headers=admin_headers).json()["first"] == (
        "2026-06-11"
    )


def exported(client, headers, name="sessions.csv", **params):
    """Read one CSV out of the export bundle as a list of rows."""
    response = client.get("/api/time/export.zip", headers=headers, params=params)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    with ZipFile(BytesIO(response.content)) as bundle:
        assert bundle.namelist() == ["sessions.csv", "by-project.csv", "by-tag.csv"]
        text = bundle.read(name).decode("utf-8-sig")
    return list(csv.reader(text.splitlines()))
