from datetime import datetime, timedelta
from itertools import count

from tests.conftest import make_user

FOCUS = 25 * 60
BREAK = 5 * 60
DAY = "2026-06-10"
START = datetime(2026, 6, 10, 9, 0)

_seq = count(1)
_clock = count(1)


def at(minutes):
    return (START + timedelta(minutes=minutes)).isoformat()


def stamp():
    """Return a client clock reading that always moves forward.

    Two writes sharing one `client_updated_at` make the second a silent no-op,
    which has produced a vacuous test here before.
    """
    return (datetime(2026, 6, 10, 8, 0) + timedelta(seconds=next(_clock))).isoformat()


def push(client, headers, kind, client_id, payload=None):
    """Send one sync intent and return its result."""
    response = client.post(
        "/api/sync",
        headers=headers,
        json={
            "intents": [
                {
                    "seq": next(_seq),
                    "kind": kind,
                    "client_updated_at": stamp(),
                    "client_id": client_id,
                    "payload": payload or {},
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["results"][0]


def start_pomodoro(client, headers, client_id="p1", minutes=0, **extra):
    """Queue a pomodoro that began `minutes` after START."""
    payload = {
        "started_at": at(minutes),
        "utc_offset": 0,
        "focus_seconds": FOCUS,
        "break_seconds": BREAK,
        **extra,
    }
    return push(client, headers, "pomodoro.upsert", client_id, payload)


def listing(client, headers, **params):
    response = client.get("/api/pomodoros", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def make_project(client, headers, name="The rewrite"):
    response = client.post("/api/projects", headers=headers, json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def test_a_queued_pomodoro_comes_back_in_the_listing(client, admin_headers):
    start_pomodoro(client, admin_headers)
    rows = listing(client, admin_headers)
    assert len(rows) == 1
    assert rows[0]["focus_seconds"] == FOCUS
    assert rows[0]["client_id"] == "p1"


def test_a_pomodoro_is_running_before_its_planned_end(client, admin_headers):
    start_pomodoro(client, admin_headers)
    rows = listing(client, admin_headers, as_of=at(10))
    assert rows[0]["state"] == "running"


def test_a_pomodoro_completes_at_its_planned_end_with_nothing_written(
    client, admin_headers
):
    start_pomodoro(client, admin_headers)
    rows = listing(client, admin_headers, as_of=at(31))
    assert rows[0]["state"] == "complete"
    assert rows[0]["ended_at"] is None
    assert rows[0]["elapsed_seconds"] == FOCUS + BREAK


def test_stopping_during_the_focus_abandons_it(client, admin_headers):
    start_pomodoro(client, admin_headers)
    start_pomodoro(client, admin_headers, ended_at=at(7))
    rows = listing(client, admin_headers, as_of=at(60))
    assert rows[0]["state"] == "abandoned"
    assert rows[0]["focus_elapsed_seconds"] == 7 * 60
    assert rows[0]["break_elapsed_seconds"] == 0


def test_an_end_edited_past_the_planned_end_invents_no_break_time(
    client, admin_headers
):
    start_pomodoro(client, admin_headers)
    start_pomodoro(client, admin_headers, ended_at=at(300))
    rows = listing(client, admin_headers, as_of=at(400))
    assert rows[0]["elapsed_seconds"] == FOCUS + BREAK


def test_the_task_can_be_corrected_afterwards(client, admin_headers):
    start_pomodoro(client, admin_headers, task="Wrong thing")
    start_pomodoro(client, admin_headers, task="The real thing")
    assert listing(client, admin_headers)[0]["task"] == "The real thing"


def test_a_pomodoro_needs_no_task_at_all(client, admin_headers):
    start_pomodoro(client, admin_headers)
    assert listing(client, admin_headers)[0]["task"] is None


def test_a_deleted_pomodoro_leaves_the_listing(client, admin_headers):
    start_pomodoro(client, admin_headers)
    push(client, admin_headers, "pomodoro.delete", "p1")
    assert listing(client, admin_headers) == []


def test_another_account_never_sees_it(client, admin_headers):
    start_pomodoro(client, admin_headers)
    _, other = make_user(client, admin_headers, "mallory")
    assert listing(client, other) == []


def test_a_pomodoro_is_refused_without_a_focus_phase(client, admin_headers):
    result = start_pomodoro(client, admin_headers, focus_seconds=0)
    assert result["outcome"] == "conflict"


def test_the_listing_is_bounded_by_local_day(client, admin_headers):
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    start_pomodoro(client, admin_headers, client_id="p2", minutes=60 * 24)
    rows = listing(client, admin_headers, start=DAY, end=DAY)
    assert [row["client_id"] for row in rows] == ["p1"]


# --- the transfer button ---------------------------------------------------


def transfer(client, headers, project_id, day=DAY, **extra):
    return client.post(
        "/api/pomodoros/transfer",
        headers=headers,
        json={"day": day, "project_id": project_id, **extra},
    )


def test_transferring_writes_one_session_of_the_summed_time(client, admin_headers):
    project = make_project(client, admin_headers)
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    start_pomodoro(client, admin_headers, client_id="p2", minutes=30)

    response = transfer(client, admin_headers, project["id"], as_of=at(200))
    assert response.status_code == 201, response.text

    entries = client.get("/api/time/entries", headers=admin_headers).json()
    assert len(entries) == 1
    started = datetime.fromisoformat(entries[0]["started_at"])
    ended = datetime.fromisoformat(entries[0]["ended_at"])
    # The summed time, placed at the first pomodoro - not the span of the day.
    assert (ended - started).total_seconds() == 2 * (FOCUS + BREAK)
    assert started == START


def test_copying_one_day_twice_collides_rather_than_duplicating(client, admin_headers):
    project = make_project(client, admin_headers)
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    assert (
        transfer(client, admin_headers, project["id"], as_of=at(200)).status_code == 201
    )

    again = transfer(client, admin_headers, project["id"], as_of=at(200))

    # Refused by the overlap rule rather than by a guard on the pomodoro: the
    # second session would cover minutes the first already covers. Deleting the
    # first in the Time view is the way through.
    assert again.status_code == 422
    assert "overlap" in again.json()["detail"].lower()
    assert len(client.get("/api/time/entries", headers=admin_headers).json()) == 1


def test_a_copied_session_says_where_it_came_from(client, admin_headers):
    project = make_project(client, admin_headers)
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    transfer(client, admin_headers, project["id"], as_of=at(200))

    [entry] = client.get("/api/time/entries", headers=admin_headers).json()

    assert entry["source"] == "pomodoro"


def test_a_session_tracked_by_hand_has_no_source(client, admin_headers):
    project = make_project(client, admin_headers)
    push(
        client,
        admin_headers,
        "entry.upsert",
        "e1",
        {
            "project_id": project["id"],
            "started_at": at(0),
            "ended_at": at(120),
            "utc_offset": 0,
        },
    )

    [entry] = client.get("/api/time/entries", headers=admin_headers).json()

    assert entry["source"] is None


def test_a_transfer_colliding_with_tracked_time_says_so_rather_than_failing(
    client, admin_headers
):
    project = make_project(client, admin_headers)
    push(
        client,
        admin_headers,
        "entry.upsert",
        "e1",
        {
            "project_id": project["id"],
            "started_at": at(0),
            "ended_at": at(120),
            "utc_offset": 0,
        },
    )
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)

    response = transfer(client, admin_headers, project["id"], as_of=at(200))
    assert response.status_code == 422
    assert "overlap" in response.json()["detail"].lower()


def test_a_colliding_transfer_can_be_placed_somewhere_else(client, admin_headers):
    project = make_project(client, admin_headers)
    push(
        client,
        admin_headers,
        "entry.upsert",
        "e1",
        {
            "project_id": project["id"],
            "started_at": at(0),
            "ended_at": at(120),
            "utc_offset": 0,
        },
    )
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)

    response = transfer(
        client, admin_headers, project["id"], started_at=at(180), as_of=at(300)
    )
    assert response.status_code == 201, response.text


def test_a_transfer_to_another_account_project_is_not_found(client, admin_headers):
    _, other = make_user(client, admin_headers, "mallory")
    theirs = make_project(client, other, name="Theirs")
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)

    response = transfer(client, admin_headers, theirs["id"], as_of=at(200))
    assert response.status_code == 404


def test_pomodoros_are_fingerprinted_for_the_change_digest(client, admin_headers):
    before = client.get("/api/changes", headers=admin_headers).json()
    assert "pomodoros" in before
    start_pomodoro(client, admin_headers)
    after = client.get("/api/changes", headers=admin_headers).json()
    assert after["pomodoros"]["n"] == before["pomodoros"]["n"] + 1


def test_a_copied_pomodoro_can_still_be_edited(client, admin_headers):
    project = make_project(client, admin_headers)
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    assert (
        transfer(client, admin_headers, project["id"], as_of=at(200)).status_code == 201
    )

    result = start_pomodoro(client, admin_headers, client_id="p1", task="Corrected")

    # The session it produced does not follow, and that is the accepted trade:
    # the transfer is a copy and was never a link.
    assert result["outcome"] == "applied"
    assert listing(client, admin_headers)[0]["task"] == "Corrected"
    assert len(client.get("/api/time/entries", headers=admin_headers).json()) == 1


def test_a_copied_pomodoro_can_still_be_deleted(client, admin_headers):
    project = make_project(client, admin_headers)
    start_pomodoro(client, admin_headers, client_id="p1", minutes=0)
    assert (
        transfer(client, admin_headers, project["id"], as_of=at(200)).status_code == 201
    )

    result = push(client, admin_headers, "pomodoro.delete", "p1")

    assert result["outcome"] == "applied"
    assert listing(client, admin_headers) == []
    # The session stays. Deleting it is a job for the Time view.
    assert len(client.get("/api/time/entries", headers=admin_headers).json()) == 1
