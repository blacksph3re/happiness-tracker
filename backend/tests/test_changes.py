import sqlite3
from itertools import count

import pytest

from tests.conftest import make_user
from tests.test_time_api import at, make_project, make_tag, write_entry

"""What the change digest reports, and what it must never miss.

The digest exists so a device can ask "has anything moved?" without re-reading
the collections themselves. Every test here is about one of the three ways it
could lie: missing a change, inventing one, or reporting another account's.
"""


@pytest.fixture
def backdate(tmp_path):
    """Push a table's `updated_at` back, so a later write lands in a later second.

    SQLite's `CURRENT_TIMESTAMP` has one-second resolution, so two writes inside
    the same second carry the same `updated_at` and a test asserting that an
    edit moved the watermark passes or fails on how fast the suite ran. This
    makes that deterministic without sleeping.
    """

    def push(table, minutes):
        connection = sqlite3.connect(tmp_path / "test.db")
        with connection:
            connection.execute(
                f"UPDATE {table} SET updated_at = "  # noqa: S608 - a literal, not input
                f"datetime(updated_at, '-{int(minutes)} minutes')"
            )
        connection.close()

    return push


@pytest.fixture
def clear_stamps(tmp_path):
    """Null a table's `updated_at`, reproducing rows that predate the column.

    The migration adds the column without backfilling it, so every row already
    in a real database reads NULL until it is next written. Nothing the API can
    do produces that state, which is exactly why it is worth a fixture.
    """

    def clear(table):
        connection = sqlite3.connect(tmp_path / "test.db")
        with connection:
            connection.execute(f"UPDATE {table} SET updated_at = NULL")  # noqa: S608
        connection.close()

    return clear


def digest(client, headers):
    """Read the change digest for the account behind `headers`."""
    response = client.get("/api/changes", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


_sent = count(1)


def answer(client, headers, question_id, day="2026-06-15", value=3):
    """Record one answer through the queue, as a device does.

    Each call carries a later `client_updated_at` than the last, because writes
    are resolved last-write-wins on that stamp: two answers sharing one would
    make the second a no-op, and a test "editing" an answer would silently be
    testing nothing at all.
    """
    seq = next(_sent)
    stamp = f"2026-06-15T09:{seq // 60:02d}:{seq % 60:02d}"
    response = client.post(
        "/api/sync",
        headers=headers,
        json={
            "intents": [
                {
                    "seq": seq,
                    "kind": "answer.put",
                    "client_updated_at": stamp,
                    "payload": {
                        "day": day,
                        "local_hour": 9,
                        "question_id": question_id,
                        "value": value,
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text


def test_every_collection_is_reported(client, admin_headers):
    body = digest(client, admin_headers)

    assert set(body) == {
        "answers",
        "time_entries",
        "projects",
        "tags",
        "rules",
        "pomodoros",
        "catalogues",
        "todos",
        "todo_steps",
        "todo_lists",
        "me",
    }
    for name, fingerprint in body.items():
        assert set(fingerprint) == {"n", "at"}, name


def test_a_fresh_account_reports_zeroes_rather_than_failing(client, admin_headers):
    _, headers = make_user(client, admin_headers, "newcomer")

    body = digest(client, headers)

    assert body["answers"] == {"n": 0, "at": None}
    assert body["time_entries"] == {"n": 0, "at": None}
    # The account itself always exists, which is what makes `me` the one row
    # that is never zero.
    assert body["me"]["n"] == 1


def test_answering_moves_the_answer_fingerprint(
    client, admin_headers, starter_questions
):
    before = digest(client, admin_headers)

    answer(client, admin_headers, starter_questions[0]["id"])
    after = digest(client, admin_headers)

    # More than one row: the first answer of a day also writes that day's
    # auto-tracked values, so the count rises by the whole day rather than by
    # the one question. What matters is that it rose.
    assert after["answers"]["n"] > before["answers"]["n"]
    assert after["answers"]["at"] is not None
    # Nothing else moved: a digest that changed wholesale on any write would
    # make the client re-read every collection every time.
    assert after["time_entries"] == before["time_entries"]
    assert after["projects"] == before["projects"]


def test_editing_an_answer_moves_the_timestamp_without_moving_the_count(
    client, admin_headers, starter_questions, backdate
):
    question = starter_questions[0]["id"]
    answer(client, admin_headers, question, value=3)
    # Backdated so the edit below lands in a later second than the insert.
    # `updated_at` comes from SQLite's `CURRENT_TIMESTAMP`, which has one-second
    # resolution — without this the test races the clock and passes or fails on
    # how quickly the suite runs, not on whether the fingerprint moved.
    backdate("answers", minutes=5)
    before = digest(client, admin_headers)

    # The same day and question, a different value: an update, not an insert.
    answer(client, admin_headers, question, value=5)
    after = digest(client, admin_headers)

    assert after["answers"]["n"] == before["answers"]["n"]
    assert after["answers"]["at"] > before["answers"]["at"], (
        "an edit that moves no fingerprint is an edit the client never learns about"
    )


def test_deleting_a_session_moves_the_count_down(client, admin_headers):
    project = make_project(client, admin_headers)
    # Sessions are written and deleted through the queue; there is no REST
    # delete, so a test using one would be testing a door nobody can open.
    client_id, _ = write_entry(
        client, admin_headers, project["id"], at(1, 9), at(1, 17)
    )
    before = digest(client, admin_headers)

    removed = client.post(
        "/api/sync",
        headers=admin_headers,
        json={
            "intents": [
                {
                    "seq": 90001,
                    "kind": "entry.delete",
                    "client_id": client_id,
                    "client_updated_at": "2026-06-15T18:00:00",
                }
            ]
        },
    )
    assert removed.status_code == 200, removed.text
    after = digest(client, admin_headers)

    # The count is the only thing that can see this: the deleted row took its
    # `updated_at` with it, so a timestamp watermark alone would report that
    # nothing had happened.
    assert after["time_entries"]["n"] == before["time_entries"]["n"] - 1


def test_projects_and_tags_are_counted(client, admin_headers):
    before = digest(client, admin_headers)

    make_project(client, admin_headers, name="Something new")
    make_tag(client, admin_headers, name="Errands")
    after = digest(client, admin_headers)

    assert after["projects"]["n"] == before["projects"]["n"] + 1
    assert after["tags"]["n"] == before["tags"]["n"] + 1


def test_renaming_a_project_moves_its_fingerprint(client, admin_headers, backdate):
    # The whole reason `updated_at` was added to these six tables. A rename
    # changes no count, so before the column this was invisible to every other
    # device until something else happened to move.
    project = make_project(client, admin_headers, name="The rewrite")
    backdate("projects", minutes=5)
    before = digest(client, admin_headers)

    renamed = client.put(
        f"/api/projects/{project['id']}",
        headers=admin_headers,
        json={"name": "The rewrite, again"},
    )
    assert renamed.status_code == 200, renamed.text
    after = digest(client, admin_headers)

    assert after["projects"]["n"] == before["projects"]["n"]
    assert after["projects"]["at"] > before["projects"]["at"]


def test_a_row_written_before_the_column_existed_reads_null(
    client, admin_headers, clear_stamps
):
    # What the migration deliberately does *not* do: backfill. Every row that
    # predates it carries NULL, which is the state this reproduces. The digest
    # has to report that rather than fail, and fall back to comparing counts —
    # exactly how these tables behaved before the column existed.
    make_project(client, admin_headers, name="Untouched")
    clear_stamps("projects")

    before = digest(client, admin_headers)
    assert before["projects"]["at"] is None
    assert before["projects"]["n"] >= 1

    # And a row added afterwards still moves the count, so the collection is not
    # silently frozen by the nulls beside it.
    make_project(client, admin_headers, name="Another")
    after = digest(client, admin_headers)
    assert after["projects"]["n"] == before["projects"]["n"] + 1


def test_one_account_never_sees_another_moving(
    client, admin_headers, starter_questions
):
    _, alice = make_user(client, admin_headers, "alice")
    _, bob = make_user(client, admin_headers, "bob")
    before = digest(client, bob)

    answer(client, alice, starter_questions[0]["id"])
    make_project(client, alice, name="Alice's work")

    assert digest(client, bob) == before


def test_the_digest_needs_a_token(client):
    assert client.get("/api/changes").status_code == 401


def test_another_accounts_catalogue_does_not_show_in_the_digest(client, admin_headers):
    # Catalogues were global when this fingerprint was written, so it counted
    # every row in the table. They have owners now, and a digest that moves
    # because somebody else edited their own questions both leaks that they did
    # and makes this account re-read for nothing.
    _, other = make_user(client, admin_headers, "mallory")
    before = client.get("/api/changes", headers=admin_headers).json()["catalogues"]

    created = client.post("/api/catalogues", headers=other, json={"name": "Theirs"})
    assert created.status_code == 201, created.text

    after = client.get("/api/changes", headers=admin_headers).json()["catalogues"]
    assert after == before


def test_a_question_added_or_edited_moves_the_catalogue_watermark(
    client, admin_headers, catalogue_id, backdate
):
    """Questions have no fingerprint of their own; they ride on their catalogue.

    Measured before this was fixed: adding a question and editing one both left
    the ``catalogues`` fingerprint at exactly the count and timestamp it started
    with, so a second device went on showing the old wording — and, once habits
    existed, the old target and therefore a different streak — until somebody
    reloaded the page.
    """
    backdate("catalogues", 10)
    before = digest(client, admin_headers)["catalogues"]

    added = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Went to gym?",
            "options": [{"label": "Yes"}, {"label": "No"}],
        },
    )
    assert added.status_code == 201, added.text
    after_add = digest(client, admin_headers)["catalogues"]
    assert after_add != before

    # Re-read after backdating, not before: the add above and the edit below
    # would otherwise land in the same second, and `CURRENT_TIMESTAMP` cannot
    # tell them apart.
    backdate("catalogues", 10)
    pushed_back = digest(client, admin_headers)["catalogues"]

    question = added.json()
    edited = client.put(
        f"/api/questions/{question['id']}",
        headers=admin_headers,
        json={"prompt": "Gym?"},
    )
    assert edited.status_code == 200, edited.text
    assert digest(client, admin_headers)["catalogues"] != pushed_back


def test_marking_an_option_as_counted_moves_the_catalogue_watermark(
    client, admin_headers, catalogue_id, backdate
):
    """A habit definition is the change most likely to be noticed as wrong.

    The wording of a question at least looks stale; a target changed on another
    device shows a *number* that quietly disagrees with the one beside it.
    """
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Went to gym?",
            "habit_period": "week",
            "habit_target": 1,
            "habit_direction": "at_least",
            "options": [{"label": "Yes"}, {"label": "No"}],
        },
    )
    assert created.status_code == 201, created.text
    question = created.json()

    backdate("catalogues", 10)
    before = digest(client, admin_headers)["catalogues"]

    marked = client.put(
        f"/api/questions/{question['id']}/options/{question['options'][0]['id']}",
        headers=admin_headers,
        json={"counts": True},
    )
    assert marked.status_code == 200, marked.text
    assert digest(client, admin_headers)["catalogues"] != before


def test_a_task_edit_moves_the_todo_watermark(client, admin_headers, backdate):
    # A tick is an edit no count can see, and it is the change that matters
    # most: a task ticked on a phone must reach the laptop without a reload.
    from tests.test_todos import kinds, one, tasks

    inbox = kinds(client, admin_headers)["inbox"]
    one(
        client,
        admin_headers,
        "todo.upsert",
        "digest-1",
        {"list_id": inbox["id"], "title": "Feed the cat", "planned_on": "2026-06-10"},
    )
    backdate("todos", minutes=5)
    before = digest(client, admin_headers)["todos"]

    one(
        client,
        admin_headers,
        "todo.upsert",
        "digest-1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": "2026-06-10",
            "done_at": "2026-06-10T09:00:00",
        },
    )

    after = digest(client, admin_headers)["todos"]
    assert after["n"] == before["n"]
    assert after["at"] > before["at"]
    assert tasks(client, admin_headers)[0]["done_at"] is not None


def test_ticking_a_step_moves_the_step_watermark(client, admin_headers, backdate):
    from tests.test_todos import kinds, one, push, step_intent, todo_intent

    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(9_100, "digest-2", inbox["id"]),
            step_intent(9_101, "digest-step", "digest-2"),
        ],
    )
    backdate("todo_steps", minutes=5)
    before = digest(client, admin_headers)["todo_steps"]

    one(
        client,
        admin_headers,
        "step.upsert",
        "digest-step",
        {
            "todo_client_id": "digest-2",
            "title": "Open the tin",
            "done_at": "2026-06-10T09:00:00",
        },
    )

    after = digest(client, admin_headers)["todo_steps"]
    assert after["n"] == before["n"] == 1
    assert after["at"] > before["at"]


def test_renaming_a_list_moves_the_list_watermark(client, admin_headers, backdate):
    from tests.test_todos import make_list

    created = make_list(client, admin_headers, "Errands")
    backdate("todo_lists", minutes=5)
    before = digest(client, admin_headers)["todo_lists"]

    renamed = client.put(
        f"/api/todos/lists/{created['id']}",
        headers=admin_headers,
        json={"name": "Errands, again"},
    )
    assert renamed.status_code == 200, renamed.text

    after = digest(client, admin_headers)["todo_lists"]
    assert after["n"] == before["n"] == 3
    assert after["at"] > before["at"]


def test_another_accounts_tasks_do_not_show_in_the_digest(client, admin_headers):
    # Steps reach their owner through the task, which is the one place this
    # could go wrong without looking wrong.
    from tests.test_todos import kinds, push, step_intent, todo_intent

    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(9_200, "digest-3", inbox["id"]),
            step_intent(9_201, "digest-step-3", "digest-3"),
        ],
    )
    _, headers = make_user(client, admin_headers, "newcomer")

    body = digest(client, headers)
    assert body["todos"] == {"n": 0, "at": None}
    assert body["todo_steps"] == {"n": 0, "at": None}
    # Their own two system lists, and neither of the admin's three.
    assert body["todo_lists"]["n"] == 2


def test_a_members_edit_moves_the_owners_todo_watermark(
    client, admin_headers, backdate
):
    # The failure this exists for: a task edited by a member moves nothing the
    # owner's digest can see, so the owner's second device keeps a stale board
    # until somebody reloads the page. The same shape as the habit target.
    from tests.test_todos import kinds, one, shared_setup, tasks

    errands, _, bob_headers = shared_setup(client, admin_headers)
    backdate("todos", minutes=5)
    before = digest(client, admin_headers)["todos"]

    one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {
            "list_id": errands["id"],
            "title": "Feed the cat",
            "planned_on": "2026-06-10",
            "done_at": "2026-06-10T09:00:00",
        },
    )

    after = digest(client, admin_headers)["todos"]
    assert after["n"] == before["n"] == 1
    assert after["at"] > before["at"]
    assert tasks(client, admin_headers)[0]["done_at"] is not None
    # And the other way round: the owner's edit moves the member's.
    assert digest(client, bob_headers)["todos"]["n"] == 1
    assert kinds(client, bob_headers)["inbox"]


def test_a_members_step_tick_moves_the_owners_step_watermark(
    client, admin_headers, backdate
):
    from tests.test_todos import one, shared_setup

    _, _, bob_headers = shared_setup(client, admin_headers)
    backdate("todo_steps", minutes=5)
    before = digest(client, admin_headers)["todo_steps"]

    one(
        client,
        bob_headers,
        "step.upsert",
        "shared-step-1",
        {
            "todo_client_id": "shared-1",
            "title": "Open the tin",
            "done_at": "2026-06-10T09:00:00",
        },
    )

    after = digest(client, admin_headers)["todo_steps"]
    assert after["n"] == before["n"] == 1
    assert after["at"] > before["at"]
    # The member sees the step at all, which is the read half of the same claim.
    assert digest(client, bob_headers)["todo_steps"]["n"] == 1


def test_a_task_in_an_unshared_list_moves_nobody_elses_digest(client, admin_headers):
    # The other half, and the one a digest widened too far would break: only
    # the lists a caller can see are counted, never every list of every
    # account that shared something with them.
    from tests.test_todos import (
        kinds,
        make_list,
        one,
        shared_setup,
    )

    _, _, bob_headers = shared_setup(client, admin_headers)
    before = digest(client, bob_headers)
    private = make_list(client, admin_headers, "Private")

    one(
        client,
        admin_headers,
        "todo.upsert",
        "private-1",
        {"list_id": private["id"], "title": "Not Bob's", "planned_on": "2026-06-10"},
    )
    one(
        client,
        admin_headers,
        "todo.upsert",
        "private-inbox-1",
        {
            "list_id": kinds(client, admin_headers)["inbox"]["id"],
            "title": "Not Bob's either",
            "planned_on": "2026-06-10",
        },
    )

    after = digest(client, bob_headers)
    assert after["todos"] == before["todos"]
    assert after["todo_lists"] == before["todo_lists"]


def test_a_list_shared_with_an_account_moves_its_list_count(client, admin_headers):
    # A list appearing on your board is a change you have to see, and a rename
    # of it is one no count can.
    from tests.test_todos import make_list, share

    _, bob_headers = make_user(client, admin_headers, "bob")
    before = digest(client, bob_headers)["todo_lists"]
    errands = make_list(client, admin_headers, "Errands")

    assert digest(client, bob_headers)["todo_lists"] == before
    share(client, admin_headers, errands["id"], "bob")

    assert digest(client, bob_headers)["todo_lists"]["n"] == before["n"] + 1


def test_adding_a_member_moves_the_owners_list_watermark(
    client, admin_headers, backdate
):
    # Membership rides on the list, as a question rides on its catalogue:
    # there is no fingerprint of its own, and the owner's other device would
    # otherwise keep showing a roster that is one name short.
    from tests.test_todos import make_list, share

    _, _ = make_user(client, admin_headers, "bob")
    errands = make_list(client, admin_headers, "Errands")
    backdate("todo_lists", minutes=5)
    before = digest(client, admin_headers)["todo_lists"]

    share(client, admin_headers, errands["id"], "bob")

    after = digest(client, admin_headers)["todo_lists"]
    assert after["n"] == before["n"] == 3
    assert after["at"] > before["at"]
