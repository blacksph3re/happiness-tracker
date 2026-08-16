from datetime import datetime, timedelta

from tests.test_time_api import at, make_project

EARLIER = "2026-06-10T08:00:00"
LATER = "2026-06-10T20:00:00"


def sync(client, headers, intents):
    """Replay a queue and return the results keyed by their sequence number."""
    response = client.post("/api/sync", headers=headers, json={"intents": intents})
    assert response.status_code == 200, response.text
    body = response.json()
    return {result["seq"]: result for result in body["results"]}


def entry_intent(seq, client_id, project_id, when, start_hour=9, end_hour=12, **extra):
    """Build one session intent."""
    return {
        "seq": seq,
        "kind": "entry.upsert",
        "client_id": client_id,
        "client_updated_at": when,
        "payload": {
            "project_id": project_id,
            "started_at": at(10, start_hour),
            "ended_at": at(10, end_hour),
            "utc_offset": 0,
            **extra,
        },
    }


def sessions(client, headers):
    """Every session the account holds."""
    return client.get("/api/time/entries", headers=headers).json()


def test_a_queued_session_lands(client, admin_headers):
    project = make_project(client, admin_headers)
    results = sync(
        client, admin_headers, [entry_intent(1, "abc", project["id"], EARLIER)]
    )

    assert results[1]["outcome"] == "applied"
    assert len(sessions(client, admin_headers)) == 1


def test_replaying_the_same_queue_twice_changes_nothing(client, admin_headers):
    # The case a connection dropping mid-flush produces: the device cannot know
    # what landed, so it sends the queue again.
    project = make_project(client, admin_headers)
    intents = [entry_intent(1, "abc", project["id"], EARLIER)]

    sync(client, admin_headers, intents)
    results = sync(client, admin_headers, intents)

    assert results[1]["outcome"] == "superseded"
    assert len(sessions(client, admin_headers)) == 1


def test_the_later_change_to_a_session_wins(client, admin_headers):
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], LATER)])

    # A queue from the other device, made earlier but arriving later.
    results = sync(
        client,
        admin_headers,
        [entry_intent(2, "abc", project["id"], EARLIER, end_hour=17)],
    )

    assert results[2]["outcome"] == "superseded"
    assert sessions(client, admin_headers)[0]["ended_at"] == at(10, 12)


def test_an_edit_to_a_session_deleted_elsewhere_brings_it_back(client, admin_headers):
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], EARLIER)])
    sync(
        client,
        admin_headers,
        [
            {
                "seq": 2,
                "kind": "entry.delete",
                "client_id": "abc",
                "client_updated_at": "2026-06-10T12:00:00",
            }
        ],
    )
    assert sessions(client, admin_headers) == []

    # The other device knew nothing of the deletion and corrected the session.
    results = sync(
        client,
        admin_headers,
        [entry_intent(3, "abc", project["id"], LATER, end_hour=17)],
    )

    assert results[3]["outcome"] == "applied"
    restored = sessions(client, admin_headers)
    assert len(restored) == 1
    assert restored[0]["ended_at"] == at(10, 17)


def test_a_delete_behind_a_newer_edit_is_dropped(client, admin_headers):
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], LATER)])

    results = sync(
        client,
        admin_headers,
        [
            {
                "seq": 2,
                "kind": "entry.delete",
                "client_id": "abc",
                "client_updated_at": EARLIER,
            }
        ],
    )

    assert results[2]["outcome"] == "dropped"
    assert "kept" in results[2]["detail"]
    assert len(sessions(client, admin_headers)) == 1


def test_a_delete_ahead_of_every_change_is_applied(client, admin_headers):
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], EARLIER)])

    results = sync(
        client,
        admin_headers,
        [
            {
                "seq": 2,
                "kind": "entry.delete",
                "client_id": "abc",
                "client_updated_at": LATER,
            }
        ],
    )

    assert results[2]["outcome"] == "applied"
    assert sessions(client, admin_headers) == []


def test_a_delete_tying_with_an_edit_is_dropped(client, admin_headers):
    # A tie is doubt, and doubt keeps the session.
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], EARLIER)])

    results = sync(
        client,
        admin_headers,
        [
            {
                "seq": 2,
                "kind": "entry.delete",
                "client_id": "abc",
                "client_updated_at": EARLIER,
            }
        ],
    )

    assert results[2]["outcome"] == "dropped"
    assert len(sessions(client, admin_headers)) == 1


def test_deleting_something_already_gone_is_a_no_op(client, admin_headers):
    results = sync(
        client,
        admin_headers,
        [
            {
                "seq": 1,
                "kind": "entry.delete",
                "client_id": "never-existed",
                "client_updated_at": LATER,
            }
        ],
    )

    assert results[1]["outcome"] == "applied"


def test_an_overlapping_session_is_merged_into_the_union(client, admin_headers):
    project = make_project(client, admin_headers)
    # Recorded on the other device, 09:00 to 12:00.
    sync(client, admin_headers, [entry_intent(1, "one", project["id"], EARLIER)])

    # This device recorded 11:00 to 16:00 on the same project while offline.
    results = sync(
        client,
        admin_headers,
        [
            entry_intent(
                2, "two", project["id"], LATER, start_hour=11, end_hour=16
            )
        ],
    )

    assert results[2]["outcome"] == "merged"
    assert "merged into one" in results[2]["detail"]
    # One session covering both, and no minute invented: they overlapped, so
    # their union holds no untracked time.
    remaining = sessions(client, admin_headers)
    assert len(remaining) == 1
    assert remaining[0]["started_at"] == at(10, 9)
    assert remaining[0]["ended_at"] == at(10, 16)


def test_a_session_for_a_missing_project_is_a_conflict(client, admin_headers):
    results = sync(client, admin_headers, [entry_intent(1, "abc", 9999, EARLIER)])

    assert results[1]["outcome"] == "conflict"
    assert "project" in results[1]["detail"]


def test_one_refused_intent_does_not_block_the_rest(client, admin_headers):
    # The reason results are per intent: a session the server cannot take must
    # not hold up the fortnight of answers queued behind it.
    project = make_project(client, admin_headers)
    results = sync(
        client,
        admin_headers,
        [
            entry_intent(1, "gone", 9999, EARLIER),
            entry_intent(2, "fine", project["id"], EARLIER),
        ],
    )

    assert results[1]["outcome"] == "conflict"
    assert results[2]["outcome"] == "applied"
    assert len(sessions(client, admin_headers)) == 1


def answer_intent(seq, question_id, when, value, day="2026-06-10"):
    """Build one answer intent."""
    return {
        "seq": seq,
        "kind": "answer.put",
        "client_updated_at": when,
        "payload": {
            "day": day,
            "local_hour": 9,
            "question_id": question_id,
            "value": value,
        },
    }


def scaled_question(client, headers):
    """Return the first answerable scaled question of the bootstrapped catalogue."""
    me = client.get("/api/me", headers=headers).json()
    catalogue = client.get(
        f"/api/catalogues/{me['default_catalogue_id']}", headers=headers
    ).json()
    return next(
        question
        for question in catalogue["questions"]
        if question["origin"] == "asked" and question["kind"] != "enum"
    )


def stored_answer(client, headers, question_id, day="2026-06-10"):
    """Return the value stored for one question on one day."""
    rows = client.get("/api/answers", headers=headers).json()
    return next(
        (
            row["value"]
            for row in rows
            if row["question_id"] == question_id and row["day"] == day
        ),
        None,
    )


def test_a_queued_answer_lands_with_its_auto_tracked_day(client, admin_headers):
    question = scaled_question(client, admin_headers)
    intents = [answer_intent(1, question["id"], EARLIER, 4)]
    results = sync(client, admin_headers, intents)

    assert results[1]["outcome"] == "applied"
    assert stored_answer(client, admin_headers, question["id"]) == 4
    # A day first answered offline is not missing its weekday: the same rule
    # that writes them online runs here.
    rows = client.get("/api/answers", headers=admin_headers).json()
    system = [row for row in rows if row["day"] == "2026-06-10"]
    assert len(system) > 1


def test_the_later_answer_wins_whichever_arrives_first(client, admin_headers):
    question = scaled_question(client, admin_headers)
    sync(client, admin_headers, [answer_intent(1, question["id"], LATER, 5)])

    # The phone was offline for a fortnight and answers the same day, earlier.
    intents = [answer_intent(2, question["id"], EARLIER, 2)]
    results = sync(client, admin_headers, intents)

    assert results[2]["outcome"] == "superseded"
    assert stored_answer(client, admin_headers, question["id"]) == 5


def test_an_answer_newer_than_the_stored_one_replaces_it(client, admin_headers):
    question = scaled_question(client, admin_headers)
    sync(client, admin_headers, [answer_intent(1, question["id"], EARLIER, 2)])

    results = sync(client, admin_headers, [answer_intent(2, question["id"], LATER, 5)])

    assert results[2]["outcome"] == "applied"
    assert stored_answer(client, admin_headers, question["id"]) == 5


def test_a_clock_far_in_the_future_is_refused(client, admin_headers):
    question = scaled_question(client, admin_headers)
    ahead = (datetime.now() + timedelta(days=3)).isoformat()

    # One intent's verdict, not the request's: a device with a wrong clock must
    # still be able to deliver everything else it is holding.
    project = make_project(client, admin_headers)
    results = sync(
        client,
        admin_headers,
        [
            answer_intent(1, question["id"], ahead, 4),
            entry_intent(2, "fine", project["id"], EARLIER),
        ],
    )

    assert results[1]["outcome"] == "conflict"
    assert "clock" in results[1]["detail"]
    assert results[2]["outcome"] == "applied"


def test_a_session_intent_without_an_identity_is_refused(client, admin_headers):
    project = make_project(client, admin_headers)
    results = sync(
        client,
        admin_headers,
        [
            entry_intent(1, None, project["id"], EARLIER),
            entry_intent(2, "fine", project["id"], EARLIER),
        ],
    )

    assert results[1]["outcome"] == "conflict"
    assert results[2]["outcome"] == "applied"


def test_a_queue_is_never_replayed_into_another_account(client, admin_headers):
    from tests.conftest import make_user

    project = make_project(client, admin_headers)
    _, other_headers = make_user(client, admin_headers, "someone-else")

    # The same queue, sent by an account that does not own the project.
    results = sync(
        client, other_headers, [entry_intent(1, "abc", project["id"], EARLIER)]
    )

    assert results[1]["outcome"] == "conflict"
    assert sessions(client, other_headers) == []
    assert sessions(client, admin_headers) == []


def test_a_session_carries_its_identity_back(client, admin_headers):
    # The client keys its rows by this and refers to it in every later
    # correction, so a session it could not name would be one it could never
    # edit — offline or otherwise.
    project = make_project(client, admin_headers)
    sync(client, admin_headers, [entry_intent(1, "abc", project["id"], EARLIER)])

    rows = sessions(client, admin_headers)
    assert [row["client_id"] for row in rows] == ["abc"]


def test_a_day_answered_twice_in_one_queue_is_not_a_collision(client, admin_headers):
    # Two answers for the same day, replayed together: exactly what a device
    # holds after answering a questionnaire with no connection. Each one asks
    # for the day's auto-tracked answers, and the second must see what the first
    # wrote — in the same transaction, before either has been committed.
    question = scaled_question(client, admin_headers)
    me = client.get("/api/me", headers=admin_headers).json()
    catalogue = client.get(
        f"/api/catalogues/{me['default_catalogue_id']}", headers=admin_headers
    ).json()
    other = next(
        one
        for one in catalogue["questions"]
        if one["origin"] == "asked"
        and one["kind"] != "enum"
        and one["id"] != question["id"]
    )

    results = sync(
        client,
        admin_headers,
        [
            answer_intent(1, question["id"], EARLIER, 4),
            answer_intent(2, other["id"], EARLIER, 3),
        ],
    )

    assert results[1]["outcome"] == "applied"
    assert results[2]["outcome"] == "applied"


def test_an_answer_and_its_correction_in_one_queue(client, admin_headers):
    # Answered, then thought better of — both offline, both in the same queue.
    # The second has to find the first, which nothing in the session guarantees
    # until it has been flushed.
    question = scaled_question(client, admin_headers)
    results = sync(
        client,
        admin_headers,
        [
            answer_intent(1, question["id"], EARLIER, 2),
            answer_intent(2, question["id"], LATER, 5),
        ],
    )

    assert results[1]["outcome"] == "applied"
    assert results[2]["outcome"] == "applied"
    assert stored_answer(client, admin_headers, question["id"]) == 5
