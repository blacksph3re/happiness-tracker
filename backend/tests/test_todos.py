"""The todo half: provisioning, ownership, the four sync kinds and the archive.

Writes to tasks and steps go through `/api/sync` and nowhere else, exactly as
sessions and pomodoros already do, so most of what is tested here is a queue
being replayed rather than an endpoint being called. Lists are the exception:
a container is not something you make on a train, so they are ordinary CRUD.
"""

from datetime import date, datetime, timedelta
from itertools import count

from tests.conftest import make_user

TODAY = "2026-06-10"
_seq = count(1)
_clock = count(1)


def stamp():
    """Return a client clock reading that always moves forward.

    Two writes sharing one `client_updated_at` make the second a silent no-op,
    which has produced a vacuous test in this suite before.
    """
    return (datetime(2026, 6, 10, 8, 0) + timedelta(seconds=next(_clock))).isoformat()


def push(client, headers, intents):
    """Replay a queue and return the results keyed by their sequence number."""
    response = client.post("/api/sync", headers=headers, json={"intents": intents})
    assert response.status_code == 200, response.text
    return {result["seq"]: result for result in response.json()["results"]}


def one(client, headers, kind, client_id, payload=None, when=None):
    """Send a single intent and return its result."""
    intents = [
        {
            "seq": next(_seq),
            "kind": kind,
            "client_updated_at": when or stamp(),
            "client_id": client_id,
            "payload": payload or {},
        }
    ]
    return next(iter(push(client, headers, intents).values()))


def todo_intent(seq, client_id, list_id, when=None, **extra):
    """Build one `todo.upsert` intent for a task planned today."""
    return {
        "seq": seq,
        "kind": "todo.upsert",
        "client_id": client_id,
        "client_updated_at": when or stamp(),
        "payload": {
            "list_id": list_id,
            "title": "Feed the cat",
            "planned_on": TODAY,
            **extra,
        },
    }


def step_intent(seq, client_id, todo_client_id, when=None, **extra):
    """Build one `step.upsert` intent naming its parent by client id."""
    return {
        "seq": seq,
        "kind": "step.upsert",
        "client_id": client_id,
        "client_updated_at": when or stamp(),
        "payload": {
            "todo_client_id": todo_client_id,
            "title": "Open the tin",
            **extra,
        },
    }


def lists(client, headers):
    """Every list the account holds, in rank order."""
    response = client.get("/api/todos/lists", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def kinds(client, headers):
    """Return the account's lists keyed by kind, for the two that are unique."""
    return {
        row["kind"]: row for row in lists(client, headers) if row["kind"] != "ordinary"
    }


def make_list(client, headers, name="Errands", **extra):
    """Create one ordinary list."""
    response = client.post(
        "/api/todos/lists", headers=headers, json={"name": name, **extra}
    )
    assert response.status_code == 201, response.text
    return response.json()


def tasks(client, headers):
    """Every task outside the archive, with its steps nested."""
    response = client.get("/api/todos", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def archived(client, headers, **params):
    """One page of the archive, newest first."""
    response = client.get("/api/todos/archive", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def me(client, headers):
    """Return the signed-in account."""
    return client.get("/api/me", headers=headers).json()


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


def test_an_account_is_built_an_inbox_and_an_archive(client, admin_headers):
    held = kinds(client, admin_headers)

    assert held["inbox"]["name"] == "Inbox"
    assert held["archive"]["name"] == "Archive"
    # The inbox sorts first and the archive last, which is where the
    # move-between-lists view draws them.
    assert [row["kind"] for row in lists(client, admin_headers)] == ["inbox", "archive"]


def test_a_new_account_is_built_them_too(client, admin_headers):
    _, headers = make_user(client, admin_headers, "newcomer")

    assert set(kinds(client, headers)) == {"inbox", "archive"}


def test_ensure_system_lists_is_idempotent(client, admin_headers):
    # The partial unique index is what makes this safe from anywhere, so the
    # helper being called twice must produce the same two rows rather than four.
    from database import SessionLocal
    from services import ensure_system_lists

    user_id = me(client, admin_headers)["id"]
    with SessionLocal() as db:
        first = [row.id for row in ensure_system_lists(db, user_id)]
        db.commit()
        second = [row.id for row in ensure_system_lists(db, user_id)]
        db.commit()

    assert first == second
    assert len(lists(client, admin_headers)) == 2


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------


def test_a_new_list_is_appended_before_the_archive(client, admin_headers):
    first = make_list(client, admin_headers, "Errands")
    second = make_list(client, admin_headers, "Home")

    order = [row["kind"] for row in lists(client, admin_headers)]
    assert order == ["inbox", "ordinary", "ordinary", "archive"]
    held = kinds(client, admin_headers)
    assert (
        held["inbox"]["rank"] < first["rank"] < second["rank"] < held["archive"]["rank"]
    )


def test_another_accounts_list_is_missing_rather_than_forbidden(client, admin_headers):
    mine = make_list(client, admin_headers)
    _, theirs = make_user(client, admin_headers, "stranger")

    assert (
        client.put(
            f"/api/todos/lists/{mine['id']}", headers=theirs, json={"name": "Mine now"}
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/todos/lists/{mine['id']}", headers=theirs).status_code
        == 404
    )
    # And nothing of it leaked into their own listing.
    assert [row["kind"] for row in lists(client, theirs)] == ["inbox", "archive"]


def test_deleting_a_system_list_is_refused(client, admin_headers):
    held = kinds(client, admin_headers)

    for kind in ("inbox", "archive"):
        response = client.delete(
            f"/api/todos/lists/{held[kind]['id']}", headers=admin_headers
        )
        assert response.status_code == 409, response.text

    assert len(lists(client, admin_headers)) == 2


def test_a_system_list_can_be_renamed_and_recoloured(client, admin_headers):
    held = kinds(client, admin_headers)

    response = client.put(
        f"/api/todos/lists/{held['archive']['id']}",
        headers=admin_headers,
        json={"name": "Done with", "colour": "rose"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "archive"
    assert response.json()["name"] == "Done with"


def test_changing_a_lists_kind_is_refused(client, admin_headers):
    ordinary = make_list(client, admin_headers)

    response = client.put(
        f"/api/todos/lists/{ordinary['id']}",
        headers=admin_headers,
        json={"kind": "archive"},
    )

    assert response.status_code == 409, response.text
    assert lists(client, admin_headers)[1]["kind"] == "ordinary"


def test_deleting_a_list_takes_its_tasks_and_steps_but_never_the_archive(
    client, admin_headers
):
    doomed = make_list(client, admin_headers, "Doomed")
    held = kinds(client, admin_headers)
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", doomed["id"]),
            step_intent(next(_seq), "s1", "t1"),
            todo_intent(next(_seq), "t2", held["archive"]["id"], title="Abandoned"),
        ],
    )

    response = client.delete(f"/api/todos/lists/{doomed['id']}", headers=admin_headers)

    assert response.status_code == 204, response.text
    assert tasks(client, admin_headers) == []
    # The archived task was never in the list being deleted, so it survives -
    # which is the whole reason the archive is a real row rather than a flag.
    assert [row["client_id"] for row in archived(client, admin_headers)["items"]] == [
        "t2"
    ]


# ---------------------------------------------------------------------------
# todo.upsert and todo.delete
# ---------------------------------------------------------------------------


def test_a_queued_task_lands(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    result = one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Feed the cat", "planned_on": TODAY},
    )

    assert result["outcome"] == "applied", result
    held = tasks(client, admin_headers)
    assert [(row["title"], row["planned_on"], row["steps"]) for row in held] == [
        ("Feed the cat", TODAY, [])
    ]
    # A rank is what the board orders by, so one always comes back.
    assert held[0]["rank"]


def test_a_correction_replaces_the_task_it_names(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Feed the cat", "planned_on": TODAY},
    )

    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cats",
            "planned_on": TODAY,
            "planned_at": "09:30:00",
            "priority": "high",
            "duration_minutes": 15,
        },
    )

    held = tasks(client, admin_headers)
    assert len(held) == 1
    assert held[0]["title"] == "Feed the cats"
    assert held[0]["planned_at"] == "09:30:00"
    assert held[0]["priority"] == "high"
    assert held[0]["duration_minutes"] == 15


# ---------------------------------------------------------------------------
# A task's own colour. Optional, and bounded by *shape* rather than by the six
# tokens the client offers today, exactly as a project's and a list's are: the
# palette gains tokens, and a colour chosen in a later release must not start
# answering 422 against a server that has not been redeployed. The client
# already draws an unknown token through `chipColour`'s fallback, so the one
# thing a rule here could buy - "nothing outside the palette gets in" - is a
# guarantee nothing needs.
# ---------------------------------------------------------------------------


def test_a_queued_colour_is_stored_and_comes_back(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    result = one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": "iris",
        },
    )

    assert result["outcome"] == "applied", result
    assert tasks(client, admin_headers)[0]["colour"] == "iris"


def test_a_task_with_no_colour_comes_back_null(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Feed the cat", "planned_on": TODAY},
    )

    # Null rather than a default the server picked: it means *take the list's
    # colour*, which is what the card draws when nothing was chosen.
    assert tasks(client, admin_headers)[0]["colour"] is None


def test_a_colour_can_be_cleared_back_to_null(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": "iris",
        },
    )

    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": None,
        },
    )

    # `todo.upsert` carries every field of the row, so there is no
    # *absent* versus *null* distinction to get wrong - the newest version of a
    # task simply is the task. Sending null is therefore the whole of taking a
    # colour off, and none of `model_fields_set` is needed.
    assert tasks(client, admin_headers)[0]["colour"] is None


def test_a_correction_that_omits_the_colour_clears_it_too(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": "iris",
        },
    )

    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Feed the cat", "planned_on": TODAY},
    )

    # The other half of the same rule, asserted rather than left implied: an
    # older client that knows nothing about the field sends a row without it
    # and the colour goes, exactly as an omitted `icon` or `priority` already
    # does. That is the cost of a payload that is the whole row, and it is
    # paid identically by every optional field on it.
    assert tasks(client, admin_headers)[0]["colour"] is None


def test_a_colour_survives_a_correction_that_changes_nothing_else(
    client, admin_headers
):
    inbox = kinds(client, admin_headers)["inbox"]
    payload = {
        "list_id": inbox["id"],
        "title": "Feed the cat",
        "planned_on": TODAY,
        "colour": "amber",
    }
    one(client, admin_headers, "todo.upsert", "t1", payload)

    result = one(client, admin_headers, "todo.upsert", "t1", dict(payload))

    assert result["outcome"] == "applied", result
    held = tasks(client, admin_headers)
    assert len(held) == 1
    assert held[0]["colour"] == "amber"


def test_a_colour_from_a_later_palette_is_accepted(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    result = one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": inbox["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": "seafoam",
        },
    )

    # The constraint decision, stated as a test: the shape is bounded and the
    # membership is not. `seafoam` is in no palette this release ships, and a
    # server one version behind the client that offers it must still store it.
    assert result["outcome"] == "applied", result
    assert tasks(client, admin_headers)[0]["colour"] == "seafoam"


def test_a_malformed_colour_is_refused(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    for bad in ["Iris", "#ff0000", "-iris", "1iris", "", "a" * 17]:
        result = one(
            client,
            admin_headers,
            "todo.upsert",
            f"t-{bad}",
            {
                "list_id": inbox["id"],
                "title": "Feed the cat",
                "planned_on": TODAY,
                "colour": bad,
            },
        )

        assert result["outcome"] == "conflict", (bad, result)
        assert "could not read" in result["detail"], (bad, result)
        assert "colour" in result["detail"], (bad, result)

    assert tasks(client, admin_headers) == []


def test_an_older_change_to_a_task_is_superseded(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    later, earlier = stamp(), "2026-06-01T08:00:00"
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Kept", "planned_on": TODAY},
        when=later,
    )

    result = one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Stale", "planned_on": TODAY},
        when=earlier,
    )

    assert result["outcome"] == "superseded", result
    assert tasks(client, admin_headers)[0]["title"] == "Kept"


def test_a_task_naming_another_accounts_list_is_refused(client, admin_headers):
    mine = make_list(client, admin_headers)
    _, theirs = make_user(client, admin_headers, "stranger")

    result = one(
        client,
        theirs,
        "todo.upsert",
        "t1",
        {"list_id": mine["id"], "title": "Yours now", "planned_on": TODAY},
    )

    assert result["outcome"] == "conflict", result
    assert tasks(client, admin_headers) == []
    assert tasks(client, theirs) == []


def test_a_task_delete_behind_a_newer_edit_is_dropped(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": inbox["id"], "title": "Kept", "planned_on": TODAY},
        when=stamp(),
    )

    result = one(client, admin_headers, "todo.delete", "t1", when="2026-06-01T08:00:00")

    assert result["outcome"] == "dropped", result
    assert len(tasks(client, admin_headers)) == 1


def test_a_task_delete_ahead_of_every_change_is_applied(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(client, admin_headers, [todo_intent(next(_seq), "t1", inbox["id"])])

    result = one(client, admin_headers, "todo.delete", "t1")

    assert result["outcome"] == "applied", result
    assert tasks(client, admin_headers) == []


def test_deleting_a_task_takes_its_steps(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s1", "t1"),
        ],
    )

    one(client, admin_headers, "todo.delete", "t1")

    # Re-creating the task by correcting it must not bring a stranded step back.
    push(client, admin_headers, [todo_intent(next(_seq), "t1", inbox["id"])])
    assert tasks(client, admin_headers)[0]["steps"] == []


# ---------------------------------------------------------------------------
# step.upsert and step.delete
# ---------------------------------------------------------------------------


def test_a_step_finds_a_parent_still_only_known_by_client_id(client, admin_headers):
    # The shape the modal produces offline: a task and a step on it, queued in
    # one gesture, neither of which the server has ever seen.
    inbox = kinds(client, admin_headers)["inbox"]

    results = push(
        client,
        admin_headers,
        [
            todo_intent(1_000, "t1", inbox["id"]),
            step_intent(1_001, "s1", "t1", rank="n"),
            step_intent(1_002, "s2", "t1", title="Put it down", rank="t"),
        ],
    )

    assert [results[seq]["outcome"] for seq in (1_000, 1_001, 1_002)] == ["applied"] * 3
    steps = tasks(client, admin_headers)[0]["steps"]
    assert [(row["client_id"], row["title"]) for row in steps] == [
        ("s1", "Open the tin"),
        ("s2", "Put it down"),
    ]


def test_a_step_is_ordered_by_rank_then_client_id(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]

    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s-later", "t1", rank="n"),
            step_intent(next(_seq), "s-earlier", "t1", rank="n"),
            step_intent(next(_seq), "s-first", "t1", rank="b"),
        ],
    )

    steps = tasks(client, admin_headers)[0]["steps"]
    assert [row["client_id"] for row in steps] == ["s-first", "s-earlier", "s-later"]


def test_ticking_a_step_is_one_intent(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s1", "t1"),
        ],
    )

    one(
        client,
        admin_headers,
        "step.upsert",
        "s1",
        {
            "todo_client_id": "t1",
            "title": "Open the tin",
            "done_at": "2026-06-10T09:00:00",
        },
    )

    steps = tasks(client, admin_headers)[0]["steps"]
    assert [row["done_at"] for row in steps] == ["2026-06-10T09:00:00"]
    # The parent is untouched: a step is not a rewrite of the task it sits on.
    assert tasks(client, admin_headers)[0]["done_at"] is None


def test_a_step_whose_parent_is_missing_is_refused(client, admin_headers):
    result = one(
        client,
        admin_headers,
        "step.upsert",
        "s1",
        {"todo_client_id": "never-existed", "title": "Orphan"},
    )

    assert result["outcome"] == "conflict", result
    assert "no longer exists" in result["detail"]


def test_a_step_whose_parent_belongs_to_someone_else_is_refused(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(client, admin_headers, [todo_intent(next(_seq), "t1", inbox["id"])])
    _, theirs = make_user(client, admin_headers, "stranger")

    result = one(
        client, theirs, "step.upsert", "s1", {"todo_client_id": "t1", "title": "Theirs"}
    )

    assert result["outcome"] == "conflict", result
    assert tasks(client, admin_headers)[0]["steps"] == []


def test_a_step_delete_behind_a_newer_edit_is_dropped(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s1", "t1", when=stamp()),
        ],
    )

    result = one(client, admin_headers, "step.delete", "s1", when="2026-06-01T08:00:00")

    assert result["outcome"] == "dropped", result
    assert len(tasks(client, admin_headers)[0]["steps"]) == 1


def test_a_step_delete_is_applied(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s1", "t1"),
        ],
    )

    result = one(client, admin_headers, "step.delete", "s1")

    assert result["outcome"] == "applied", result
    assert tasks(client, admin_headers)[0]["steps"] == []


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def test_steps_come_back_nested_without_a_query_per_task(client, admin_headers):
    # An N+1 of exactly the kind `Variable.component_ids` had to be warned
    # about. Asserted as "the cost does not grow with the number of tasks",
    # which is the claim, rather than as a number that would restate the
    # implementation.
    import database

    inbox = kinds(client, admin_headers)["inbox"]
    seen = []

    def count_statements(conn, cursor, statement, *rest):
        seen.append(statement)

    from sqlalchemy import event

    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            step_intent(next(_seq), "s1", "t1"),
        ],
    )
    event.listen(database.engine, "before_cursor_execute", count_statements)
    try:
        tasks(client, admin_headers)
        thin = len(seen)
        seen.clear()
        push(
            client,
            admin_headers,
            [
                intent
                for index in range(2, 8)
                for intent in (
                    todo_intent(next(_seq), f"t{index}", inbox["id"]),
                    step_intent(next(_seq), f"s{index}", f"t{index}"),
                )
            ],
        )
        seen.clear()
        held = tasks(client, admin_headers)
        fat = len(seen)
    finally:
        event.remove(database.engine, "before_cursor_execute", count_statements)

    assert len(held) == 7
    assert all(len(row["steps"]) == 1 for row in held)
    assert fat == thin, f"{thin} statements for one task, {fat} for seven"


def test_the_archive_is_not_in_the_ordinary_listing(client, admin_headers):
    held = kinds(client, admin_headers)
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", held["inbox"]["id"], title="Open"),
            todo_intent(next(_seq), "t2", held["archive"]["id"], title="Abandoned"),
        ],
    )

    assert [row["title"] for row in tasks(client, admin_headers)] == ["Open"]
    assert [row["title"] for row in archived(client, admin_headers)["items"]] == [
        "Abandoned"
    ]


def test_the_archive_is_newest_arrival_first(client, admin_headers):
    archive = kinds(client, admin_headers)["archive"]
    push(
        client,
        admin_headers,
        [
            todo_intent(
                next(_seq),
                "old",
                archive["id"],
                title="Long gone",
                archived_at="2026-05-01T09:00:00",
            ),
            todo_intent(
                next(_seq),
                "new",
                archive["id"],
                title="Just now",
                archived_at="2026-06-09T09:00:00",
            ),
        ],
    )

    page = archived(client, admin_headers)
    assert [row["title"] for row in page["items"]] == ["Just now", "Long gone"]
    assert page["next"] is None


def test_editing_an_archived_task_does_not_move_it(client, admin_headers):
    archive = kinds(client, admin_headers)["archive"]
    push(
        client,
        admin_headers,
        [
            todo_intent(
                next(_seq), "old", archive["id"], archived_at="2026-05-01T09:00:00"
            ),
            todo_intent(
                next(_seq), "new", archive["id"], archived_at="2026-06-09T09:00:00"
            ),
        ],
    )

    one(
        client,
        admin_headers,
        "todo.upsert",
        "old",
        {
            "list_id": archive["id"],
            "title": "Corrected",
            "planned_on": TODAY,
            "archived_at": "2026-05-01T09:00:00",
        },
    )

    assert [row["client_id"] for row in archived(client, admin_headers)["items"]] == [
        "new",
        "old",
    ]


def test_a_page_boundary_cannot_split_two_tasks_archived_at_one_instant(
    client, admin_headers
):
    # The reason the cursor is a pair rather than a timestamp: three tasks
    # archived in the same second, read one at a time, must come back as three
    # tasks and not as one of them three times.
    archive = kinds(client, admin_headers)["archive"]
    same = "2026-06-09T09:00:00"
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), f"a{index}", archive["id"], archived_at=same)
            for index in range(3)
        ],
    )

    seen, cursor = [], None
    while True:
        page = archived(
            client,
            admin_headers,
            **({"limit": 1, "before": cursor} if cursor else {"limit": 1}),
        )
        seen += [row["client_id"] for row in page["items"]]
        cursor = page["next"]
        if cursor is None:
            break

    assert sorted(seen) == ["a0", "a1", "a2"]


def test_the_archive_page_is_capped(client, admin_headers):
    assert (
        client.get(
            "/api/todos/archive", headers=admin_headers, params={"limit": 501}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/todos/archive", headers=admin_headers, params={"limit": 500}
        ).status_code
        == 200
    )


def test_a_garbled_cursor_is_refused_rather_than_ignored(client, admin_headers):
    response = client.get(
        "/api/todos/archive", headers=admin_headers, params={"before": "nonsense"}
    )

    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# archived_at is a timestamp, never a state
# ---------------------------------------------------------------------------


def test_archived_at_is_filled_on_the_way_in_and_cleared_on_the_way_out(
    client, admin_headers
):
    held = kinds(client, admin_headers)
    # Into the archive with nothing said about when, as an older client would.
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {"list_id": held["archive"]["id"], "title": "Abandoned", "planned_on": TODAY},
    )

    stamped = archived(client, admin_headers)["items"][0]["archived_at"]
    assert stamped is not None

    # And out again, claiming it is still archived. The list decides.
    one(
        client,
        admin_headers,
        "todo.upsert",
        "t1",
        {
            "list_id": held["inbox"]["id"],
            "title": "Abandoned",
            "planned_on": TODAY,
            "archived_at": stamped,
        },
    )

    assert archived(client, admin_headers)["items"] == []
    assert tasks(client, admin_headers)[0]["archived_at"] is None


# ---------------------------------------------------------------------------
# The pomodoro handover
# ---------------------------------------------------------------------------


def pomodoro_intent(seq, client_id, when=None, **payload):
    """Build one `pomodoro.upsert` intent."""
    return {
        "seq": seq,
        "kind": "pomodoro.upsert",
        "client_id": client_id,
        "client_updated_at": when or stamp(),
        "payload": {
            "started_at": "2026-06-10T09:00:00",
            "utc_offset": 0,
            "focus_seconds": 1500,
            "break_seconds": 300,
            **payload,
        },
    }


def pomodoros(client, headers):
    """Every pomodoro the account holds."""
    response = client.get("/api/pomodoros", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_pomodoro_names_its_task_by_the_id_its_device_gave_it(client, admin_headers):
    # The server id of a task still in the outbox is unknowable, so the wire
    # carries the client's own id and the server resolves it.
    inbox = kinds(client, admin_headers)["inbox"]

    results = push(
        client,
        admin_headers,
        [
            todo_intent(2_000, "t1", inbox["id"]),
            pomodoro_intent(2_001, "p1", todo_client_id="t1"),
        ],
    )

    assert results[2_001]["outcome"] == "applied", results
    stored = pomodoros(client, admin_headers)[0]
    assert stored["todo_client_id"] == "t1"
    assert stored["todo_id"] == tasks(client, admin_headers)[0]["id"]
    assert results[2_001]["pomodoro"]["todo_client_id"] == "t1"


def test_a_pomodoro_naming_another_accounts_task_is_refused(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(client, admin_headers, [todo_intent(next(_seq), "t1", inbox["id"])])
    _, theirs = make_user(client, admin_headers, "stranger")

    result = one(
        client,
        theirs,
        "pomodoro.upsert",
        "p1",
        {
            "started_at": "2026-06-10T09:00:00",
            "utc_offset": 0,
            "focus_seconds": 1500,
            "break_seconds": 300,
            "todo_client_id": "t1",
        },
    )

    assert result["outcome"] == "conflict", result
    assert pomodoros(client, theirs) == []


def test_a_pomodoro_with_no_task_keeps_its_typed_text(client, admin_headers):
    push(client, admin_headers, [pomodoro_intent(next(_seq), "p1", task="Something")])

    stored = pomodoros(client, admin_headers)[0]
    assert (stored["task"], stored["todo_id"], stored["todo_client_id"]) == (
        "Something",
        None,
        None,
    )


def test_deleting_a_task_leaves_its_pomodoros_behind_unlinked(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "t1", inbox["id"]),
            pomodoro_intent(next(_seq), "p1", todo_client_id="t1", task="Feed the cat"),
        ],
    )

    one(client, admin_headers, "todo.delete", "t1")

    stored = pomodoros(client, admin_headers)
    assert len(stored) == 1, "an hour of focus went with the task"
    assert stored[0]["todo_id"] is None
    assert stored[0]["task"] == "Feed the cat"


# ---------------------------------------------------------------------------
# Sharing a list
# ---------------------------------------------------------------------------


def share(client, headers, list_id, username, expect=201):
    """Add one member to a list by username."""
    response = client.post(
        f"/api/todos/lists/{list_id}/members",
        headers=headers,
        json={"username": username},
    )
    assert response.status_code == expect, response.text
    return response.json() if response.content else None


def roster(client, headers, list_id, expect=200):
    """Read a list's members."""
    response = client.get(f"/api/todos/lists/{list_id}/members", headers=headers)
    assert response.status_code == expect, response.text
    return response.json() if expect == 200 else None


def drop_member(client, headers, list_id, user_id, expect=204):
    """Remove one member from a list."""
    response = client.delete(
        f"/api/todos/lists/{list_id}/members/{user_id}", headers=headers
    )
    assert response.status_code == expect, response.text


def shared_setup(client, admin_headers):
    """Alice owns a list holding one task with one step, shared with Bob."""
    bob, bob_headers = make_user(client, admin_headers, "bob")
    errands = make_list(client, admin_headers, "Errands")
    push(
        client,
        admin_headers,
        [
            todo_intent(next(_seq), "shared-1", errands["id"]),
            step_intent(next(_seq), "shared-step-1", "shared-1"),
        ],
    )
    share(client, admin_headers, errands["id"], "bob")
    return errands, bob, bob_headers


def test_a_member_reads_the_shared_list_and_its_tasks(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    held = {row["id"]: row for row in lists(client, bob_headers)}
    assert errands["id"] in held, "a list shared with Bob is missing from his lists"
    assert held[errands["id"]]["owner"] == "admin"
    assert held[errands["id"]]["shared"] is True
    # The roster is the owner's to see. A member is told the list is shared and
    # by whom, and not who else holds it.
    assert held[errands["id"]]["members"] is None

    mine = tasks(client, bob_headers)
    assert [(row["client_id"], len(row["steps"])) for row in mine] == [("shared-1", 1)]


def test_the_owners_view_carries_the_roster(client, admin_headers):
    errands, _, _ = shared_setup(client, admin_headers)

    held = {row["id"]: row for row in lists(client, admin_headers)}
    assert held[errands["id"]]["members"] == ["bob"]
    assert held[errands["id"]]["shared"] is True
    assert held[errands["id"]]["owner"] == "admin"
    # An unshared list of the owner's own says so, with an empty roster rather
    # than a null one: the absence of members is a fact, not a withheld field.
    inbox = held[kinds(client, admin_headers)["inbox"]["id"]]
    assert (inbox["members"], inbox["shared"]) == ([], False)


def test_a_shared_list_sorts_among_the_ordinary_lists(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)
    make_list(client, bob_headers, "Home")

    order = lists(client, bob_headers)

    # Bob's own inbox first and his own archive last, whatever rank the owner
    # of a shared list happened to give it, with the shared list among the
    # ordinary ones.
    assert [row["kind"] for row in order] == [
        "inbox",
        "ordinary",
        "ordinary",
        "archive",
    ]
    assert order[0]["owner"] == "bob"
    assert order[-1]["owner"] == "bob"
    assert errands["id"] in {row["id"] for row in order[1:3]}


def test_a_non_member_neither_sees_nor_reaches_a_shared_lists_task(
    client, admin_headers
):
    errands, _, _ = shared_setup(client, admin_headers)
    _, carol = make_user(client, admin_headers, "carol")

    assert tasks(client, carol) == []
    assert errands["id"] not in {row["id"] for row in lists(client, carol)}
    # Not forbidden — missing. Whether it exists is not this caller's business.
    roster(client, carol, errands["id"], expect=404)
    assert (
        client.put(
            f"/api/todos/lists/{errands['id']}", headers=carol, json={"name": "Mine"}
        ).status_code
        == 404
    )
    result = one(
        client,
        carol,
        "todo.upsert",
        "carol-1",
        {"list_id": errands["id"], "title": "Yours now", "planned_on": TODAY},
    )
    assert result["outcome"] == "conflict", result
    assert result["detail"] == "That list no longer exists"


def test_a_member_reads_the_roster(client, admin_headers):
    errands, bob, bob_headers = shared_setup(client, admin_headers)

    held = roster(client, bob_headers, errands["id"])

    # The owner is `todo_lists.user_id` and never a member row, so a list
    # shared with one person has exactly one.
    assert [(row["username"], row["added_by"]) for row in held] == [("bob", "admin")]
    assert held[0]["user_id"] == bob["id"]


def test_a_members_task_upsert_into_the_shared_list_is_applied(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    result = one(
        client,
        bob_headers,
        "todo.upsert",
        "bob-1",
        {"list_id": errands["id"], "title": "Bob's turn", "planned_on": TODAY},
    )

    assert result["outcome"] == "applied", result
    assert {row["title"] for row in tasks(client, admin_headers)} == {
        "Feed the cat",
        "Bob's turn",
    }
    assert {row["title"] for row in tasks(client, bob_headers)} == {
        "Feed the cat",
        "Bob's turn",
    }


def test_a_member_editing_a_task_another_member_created_updates_one_row(
    client, admin_headers
):
    # The whole point of the identity swap. Keyed per user, Bob's edit would
    # look the task up under his own id, find nothing, and insert a second row
    # — two cards for one task, on every member's board.
    errands, _, bob_headers = shared_setup(client, admin_headers)

    result = one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {"list_id": errands["id"], "title": "Feed the cats", "planned_on": TODAY},
    )

    assert result["outcome"] == "applied", result
    held = tasks(client, admin_headers)
    assert [(row["client_id"], row["title"]) for row in held] == [
        ("shared-1", "Feed the cats")
    ]
    assert len(tasks(client, bob_headers)) == 1


def test_a_colour_a_member_chose_is_the_task_s_and_every_member_sees_it(
    client, admin_headers
):
    # A colour is a property of the *task*, not of who is looking at it, so
    # there is nothing per-member here and deliberately: one row, one colour,
    # and the last write wins as it does for the title. A colour per viewer
    # would be a second table and a second answer to "what colour is this
    # card", which is the shape the transfer button was deleted for.
    errands, _, bob_headers = shared_setup(client, admin_headers)

    result = one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {
            "list_id": errands["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "colour": "rose",
        },
    )

    assert result["outcome"] == "applied", result
    assert [row["colour"] for row in tasks(client, admin_headers)] == ["rose"]
    assert [row["colour"] for row in tasks(client, bob_headers)] == ["rose"]


def test_a_member_ticks_a_step_on_a_task_the_owner_created(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    result = one(
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

    assert result["outcome"] == "applied", result
    held = tasks(client, admin_headers)[0]["steps"]
    assert [step["done_at"] for step in held] == ["2026-06-10T09:00:00"]


def test_a_member_deletes_a_step_and_then_the_task(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    assert one(client, bob_headers, "step.delete", "shared-step-1")["outcome"] == (
        "applied"
    )
    assert tasks(client, admin_headers)[0]["steps"] == []
    assert one(client, bob_headers, "todo.delete", "shared-1")["outcome"] == "applied"
    assert tasks(client, admin_headers) == []


def test_a_removed_members_queued_edit_is_refused(client, admin_headers):
    # Sharing is a ceiling on offline honesty: a member removed while offline
    # still holds the tasks in their snapshot and can queue edits to them.
    errands, bob, bob_headers = shared_setup(client, admin_headers)
    drop_member(client, admin_headers, errands["id"], bob["id"])

    refused = one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {"list_id": errands["id"], "title": "Mine now", "planned_on": TODAY},
    )

    assert refused["outcome"] == "conflict", refused
    assert refused["detail"] == "That list no longer exists"
    assert tasks(client, admin_headers)[0]["title"] == "Feed the cat"
    # And the deletion it may also have queued takes nothing with it.
    assert one(client, bob_headers, "todo.delete", "shared-1")["outcome"] == "applied"
    assert len(tasks(client, admin_headers)) == 1
    assert tasks(client, bob_headers) == []


def test_a_removed_members_step_and_pomodoro_lose_the_task_too(client, admin_headers):
    errands, bob, bob_headers = shared_setup(client, admin_headers)
    drop_member(client, admin_headers, errands["id"], bob["id"])

    step = one(
        client,
        bob_headers,
        "step.upsert",
        "shared-step-1",
        {"todo_client_id": "shared-1", "title": "Open the tin"},
    )
    timer = one(
        client,
        bob_headers,
        "pomodoro.upsert",
        "bob-p1",
        {
            "started_at": "2026-06-10T09:00:00",
            "utc_offset": 0,
            "focus_seconds": 1500,
            "break_seconds": 300,
            "todo_client_id": "shared-1",
        },
    )

    gone = "That task no longer exists"
    assert (step["outcome"], step["detail"]) == ("conflict", gone)
    assert (timer["outcome"], timer["detail"]) == ("conflict", gone)
    assert tasks(client, admin_headers)[0]["steps"][0]["done_at"] is None


def test_a_member_starts_a_pomodoro_on_a_shared_task(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    result = one(
        client,
        bob_headers,
        "pomodoro.upsert",
        "bob-p1",
        {
            "started_at": "2026-06-10T09:00:00",
            "utc_offset": 0,
            "focus_seconds": 1500,
            "break_seconds": 300,
            "todo_client_id": "shared-1",
        },
    )

    assert result["outcome"] == "applied", result
    assert pomodoros(client, bob_headers)[0]["todo_client_id"] == "shared-1"


def test_only_the_owner_renames_or_deletes_a_shared_list(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    assert (
        client.put(
            f"/api/todos/lists/{errands['id']}",
            headers=bob_headers,
            json={"name": "Bob's errands"},
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/todos/lists/{errands['id']}", headers=bob_headers
        ).status_code
        == 404
    )
    renamed = client.put(
        f"/api/todos/lists/{errands['id']}",
        headers=admin_headers,
        json={"name": "Errands, again"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Errands, again"


def test_only_the_owner_adds_or_removes_a_member(client, admin_headers):
    errands, bob, bob_headers = shared_setup(client, admin_headers)
    carol, _ = make_user(client, admin_headers, "carol")
    share(client, admin_headers, errands["id"], "carol")

    # A member may not hand the list on, nor throw the other member out.
    share(client, bob_headers, errands["id"], "carol", expect=404)
    drop_member(client, bob_headers, errands["id"], carol["id"], expect=404)

    held = roster(client, admin_headers, errands["id"])
    assert {row["username"] for row in held} == {"bob", "carol"}


def test_a_member_can_leave(client, admin_headers):
    errands, bob, bob_headers = shared_setup(client, admin_headers)

    drop_member(client, bob_headers, errands["id"], bob["id"])

    assert errands["id"] not in {row["id"] for row in lists(client, bob_headers)}
    assert tasks(client, bob_headers) == []
    assert roster(client, admin_headers, errands["id"]) == []
    # The tasks belong to the list, so they stay in it.
    assert len(tasks(client, admin_headers)) == 1


def test_a_system_list_refuses_to_be_shared(client, admin_headers):
    _, _ = make_user(client, admin_headers, "bob")
    held = kinds(client, admin_headers)

    for kind in ("inbox", "archive"):
        share(client, admin_headers, held[kind]["id"], "bob", expect=409)

    assert roster(client, admin_headers, held["inbox"]["id"]) == []


def test_sharing_a_list_with_yourself_is_refused(client, admin_headers):
    errands = make_list(client, admin_headers, "Errands")

    share(client, admin_headers, errands["id"], "admin", expect=409)

    assert roster(client, admin_headers, errands["id"]) == []


def test_an_unknown_username_is_not_found(client, admin_headers):
    errands = make_list(client, admin_headers, "Errands")

    share(client, admin_headers, errands["id"], "nobody-here", expect=404)


def test_sharing_twice_is_idempotent(client, admin_headers):
    errands, _, _ = shared_setup(client, admin_headers)

    # 200 rather than 201: the second call creates nothing, and a status
    # claiming otherwise would be a lie about a row.
    again = share(client, admin_headers, errands["id"], "bob", expect=200)

    assert again["username"] == "bob"
    assert len(roster(client, admin_headers, errands["id"])) == 1


def test_removing_somebody_who_is_not_a_member_is_not_found(client, admin_headers):
    errands = make_list(client, admin_headers, "Errands")
    bob, _ = make_user(client, admin_headers, "bob")
    admin_id = me(client, admin_headers)["id"]

    drop_member(client, admin_headers, errands["id"], bob["id"], expect=404)
    # The owner is not a member row, so there is nothing to remove them from.
    drop_member(client, admin_headers, errands["id"], admin_id, expect=404)


def test_a_members_cleanup_lands_in_the_owners_archive(client, admin_headers):
    # The archive is per account, so a cleanup on a shared list has to write
    # somewhere private. The cleaner's own archive is the wrong choice: the
    # tasks would vanish for everybody else, which reads as a deletion nobody
    # asked for. The server therefore decides the destination from the task's
    # list and ignores the archive the client named.
    errands, _, bob_headers = shared_setup(client, admin_headers)
    bobs_archive = kinds(client, bob_headers)["archive"]

    result = one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {
            "list_id": bobs_archive["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "done_at": "2026-06-10T09:00:00",
        },
    )

    assert result["outcome"] == "applied", result
    landed = archived(client, admin_headers)["items"]
    assert [(row["client_id"], row["archived_at"] is not None) for row in landed] == [
        ("shared-1", True)
    ]
    assert landed[0]["list_id"] == kinds(client, admin_headers)["archive"]["id"]
    # Not into Bob's own archive, and off both boards.
    assert archived(client, bob_headers)["items"] == []
    assert tasks(client, bob_headers) == []
    assert tasks(client, admin_headers) == []


def test_a_task_of_the_members_own_still_archives_into_their_own_archive(
    client, admin_headers
):
    # The narrowness of the rule above: it reads the list the task came from,
    # so an ordinary private cleanup is untouched.
    _, _, bob_headers = shared_setup(client, admin_headers)
    held = kinds(client, bob_headers)
    push(client, bob_headers, [todo_intent(next(_seq), "bob-2", held["inbox"]["id"])])

    one(
        client,
        bob_headers,
        "todo.upsert",
        "bob-2",
        {
            "list_id": held["archive"]["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "done_at": "2026-06-10T09:00:00",
        },
    )

    assert [row["client_id"] for row in archived(client, bob_headers)["items"]] == [
        "bob-2"
    ]
    assert archived(client, admin_headers)["items"] == []


def test_an_archived_shared_task_is_still_the_owners_to_read(client, admin_headers):
    # The owner's archive holds a row whose `user_id` is the member who
    # cleaned it up, which is why the archive is read by list and not by
    # whoever created the task.
    errands, _, bob_headers = shared_setup(client, admin_headers)
    bobs_archive = kinds(client, bob_headers)["archive"]
    one(
        client,
        bob_headers,
        "todo.upsert",
        "shared-1",
        {
            "list_id": bobs_archive["id"],
            "title": "Feed the cat",
            "planned_on": TODAY,
            "done_at": "2026-06-10T09:00:00",
        },
    )

    # And the owner can put it back on the board.
    one(
        client,
        admin_headers,
        "todo.upsert",
        "shared-1",
        {"list_id": errands["id"], "title": "Feed the cat", "planned_on": TODAY},
    )

    assert archived(client, admin_headers)["items"] == []
    assert [row["client_id"] for row in tasks(client, admin_headers)] == ["shared-1"]
    assert [row["client_id"] for row in tasks(client, bob_headers)] == ["shared-1"]


def test_deleting_a_shared_list_takes_it_off_the_members_board(client, admin_headers):
    errands, _, bob_headers = shared_setup(client, admin_headers)

    assert (
        client.delete(
            f"/api/todos/lists/{errands['id']}", headers=admin_headers
        ).status_code
        == 204
    )

    assert tasks(client, bob_headers) == []
    assert [row["kind"] for row in lists(client, bob_headers)] == ["inbox", "archive"]


def test_shared_tasks_come_back_without_a_query_per_list(client, admin_headers):
    # The read resolves visibility through a subquery rather than by fetching
    # the list ids first, so the cost does not grow with the number of lists a
    # caller can see.
    from sqlalchemy import event

    import database

    errands, _, bob_headers = shared_setup(client, admin_headers)
    seen = []

    def count_statements(conn, cursor, statement, *rest):
        seen.append(statement)

    event.listen(database.engine, "before_cursor_execute", count_statements)
    try:
        tasks(client, bob_headers)
        thin = len(seen)
        for index in range(4):
            extra = make_list(client, admin_headers, f"More {index}")
            share(client, admin_headers, extra["id"], "bob")
            push(
                client,
                admin_headers,
                [todo_intent(next(_seq), f"shared-more-{index}", extra["id"])],
            )
        seen.clear()
        held = tasks(client, bob_headers)
        fat = len(seen)
    finally:
        event.remove(database.engine, "before_cursor_execute", count_statements)

    assert len(held) == 5
    assert fat == thin, f"{thin} statements for one shared list, {fat} for five"


# ---------------------------------------------------------------------------
# Ranks
# ---------------------------------------------------------------------------


def test_between_returns_a_key_strictly_inside_the_pair():
    from services import between

    assert "a" < between("a", "z") < "z"
    assert "n" < between("n", "o") < "o"


def test_between_prepends_a_thousand_times_without_failing():
    # The claim the ordering design rests on: there is always another key.
    from services import between

    first = between(None, None)
    keys = [first]
    for _ in range(1_000):
        key = between(None, keys[0])
        assert key < keys[0], f"{key!r} is not below {keys[0]!r}"
        keys.insert(0, key)

    assert keys == sorted(keys)
    assert len(keys[0]) <= 255, f"a key grew past the column: {len(keys[0])}"


def test_between_appends_a_thousand_times_without_failing():
    from services import between

    keys = [between(None, None)]
    for _ in range(1_000):
        key = between(keys[-1], None)
        assert key > keys[-1], f"{key!r} is not above {keys[-1]!r}"
        keys.append(key)

    assert keys == sorted(keys)
    assert len(keys[-1]) <= 255, f"a key grew past the column: {len(keys[-1])}"


def test_between_splits_the_same_gap_a_thousand_times():
    from services import between

    low, high = between(None, None), between(between(None, None), None)
    for _ in range(1_000):
        key = between(low, high)
        assert low < key < high, f"{key!r} is not between {low!r} and {high!r}"
        low = key


def test_between_extends_rather_than_failing_on_a_tie():
    # Two devices inserting offline into the same slot can produce one key
    # twice. Nothing sorts between a key and itself, so the rule is to extend
    # the first and let `(rank, client_id)` break what is left.
    from services import between

    assert between("n", "n") > "n"
    assert between("n", "b") > "n"


def test_between_never_ends_in_the_lowest_digit():
    # A key of all `a`s is the zero of this encoding, and nothing sorts below
    # it. `between` never produces one, which is what makes prepending total.
    from services import between

    key = between(None, None)
    for _ in range(200):
        assert not key.endswith("a"), key
        key = between(None, key)


def test_a_stranger_cannot_claim_a_task_by_rehoming_it_into_their_own_list(
    client, admin_headers
):
    # The one path where the global unique index is the thing standing in the
    # way rather than the lookup. `find_todo` resolves through visibility, so a
    # caller who cannot see a task gets `stored is None` — and an upsert naming
    # a list they *do* own would then insert a second row for an identity that
    # already exists. Refused by name, because the alternative is an
    # IntegrityError that fails the whole queue rather than one intent.
    errands, bob, bob_headers = shared_setup(client, admin_headers)
    drop_member(client, admin_headers, errands["id"], bob["id"])
    _, carol = make_user(client, admin_headers, "carol")

    for headers in (bob_headers, carol):
        result = one(
            client,
            headers,
            "todo.upsert",
            "shared-1",
            {
                "list_id": kinds(client, headers)["inbox"]["id"],
                "title": "Mine now",
                "planned_on": TODAY,
            },
        )
        assert result["outcome"] == "conflict", result
        assert result["detail"] == "That task no longer exists"

    held = tasks(client, admin_headers)
    assert [(row["client_id"], row["title"]) for row in held] == [
        ("shared-1", "Feed the cat")
    ]
    assert tasks(client, bob_headers) == []


def test_one_identity_names_one_task_in_the_whole_database(client, admin_headers):
    # The storage half of the identity swap, asserted where the swap lives. The
    # refusal above is what a caller *sees*; this is what makes it true of the
    # database rather than of the one code path that happens to ask. A second
    # writer of tasks added later inherits it by construction.
    import pytest
    from sqlalchemy.exc import IntegrityError

    from database import SessionLocal
    from models import Todo

    errands, bob, _ = shared_setup(client, admin_headers)
    inbox = kinds(client, admin_headers)["inbox"]

    with SessionLocal() as db:
        db.add(
            Todo(
                user_id=bob["id"],
                list_id=inbox["id"],
                client_id="shared-1",
                title="A second row for one task",
                planned_on=date.fromisoformat(TODAY),
                rank="n",
                active_seconds=0,
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()

    assert len(tasks(client, admin_headers)) == 1


def test_deleting_an_account_takes_its_memberships_with_it(client, admin_headers):
    # `db.delete(user)` reaches this table through the database and not through
    # a relationship — there is none on `User` — so it is the foreign key that
    # has to carry it. A stale membership row would leave the owner's roster
    # naming an account that no longer exists, and `list_out` reads the
    # username off it.
    errands, bob, _ = shared_setup(client, admin_headers)
    carol, _ = make_user(client, admin_headers, "carol")
    share(client, admin_headers, errands["id"], "carol")

    removed = client.delete(f"/api/users/{bob['id']}", headers=admin_headers)
    assert removed.status_code == 204, removed.text

    held = roster(client, admin_headers, errands["id"])
    assert [row["username"] for row in held] == ["carol"]
    assert [row["added_by"] for row in held] == ["admin"]
    drawn = {row["id"]: row for row in lists(client, admin_headers)}
    assert drawn[errands["id"]]["members"] == ["carol"]


def test_a_new_list_is_placed_among_the_callers_own_and_not_a_shared_one(
    client, admin_headers
):
    # `append_list_rank` measures what a caller *holds*, and what a caller
    # holds now includes lists somebody else ranked. Measured over the visible
    # set, a shared list ranked past the archive would put every new list
    # beyond the end of the board — so it measures the caller's own.
    _, bob, bob_headers = shared_setup(client, admin_headers)
    beyond = make_list(client, admin_headers, "Beyond")
    client.put(
        f"/api/todos/lists/{beyond['id']}", headers=admin_headers, json={"rank": "zz"}
    )
    share(client, admin_headers, beyond["id"], "bob")

    made = make_list(client, bob_headers, "Home")

    held = kinds(client, bob_headers)
    assert held["inbox"]["rank"] < made["rank"] < held["archive"]["rank"]
    assert [row["name"] for row in lists(client, bob_headers)][0] == "Inbox"
    assert [row["kind"] for row in lists(client, bob_headers)][-1] == "archive"


def test_a_malformed_rank_is_refused_per_intent(client, admin_headers):
    inbox = kinds(client, admin_headers)["inbox"]
    bad = ["m9", "M", "", "n-", "a b", "é"]
    intents = [
        todo_intent(next(_seq), f"t-bad-{at}", inbox["id"], rank=rank)
        for at, rank in enumerate(bad)
    ]
    intents.append(todo_intent(next(_seq), "t-good", inbox["id"], rank="n"))

    results = list(push(client, admin_headers, intents).values())

    for rank, result in zip(bad, results[:-1], strict=True):
        assert result["outcome"] == "conflict", (rank, result)
        assert "could not read" in result["detail"], (rank, result)
        assert "rank" in result["detail"], (rank, result)
    assert results[-1]["outcome"] == "applied", results[-1]
    assert [row["client_id"] for row in tasks(client, admin_headers)] == ["t-good"]

    step = one(
        client,
        admin_headers,
        "step.upsert",
        "s-bad",
        {"todo_client_id": "t-good", "title": "Chop onions", "rank": "m9"},
    )
    assert step["outcome"] == "conflict", step
    assert "rank" in step["detail"], step

    created = client.post(
        "/api/todos/lists",
        headers=admin_headers,
        json={"name": "Errands", "rank": "m9"},
    )
    assert created.status_code == 422, created.text
