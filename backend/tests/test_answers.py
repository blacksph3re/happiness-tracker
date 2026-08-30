from itertools import count

from tests.conftest import make_user

DAY = "2026-03-04"
SYSTEM_KEYS = {"weekday", "day_of_year", "month", "year", "first_answer_hour"}


_sent = count(1)


def stamp(seq):
    """Return a clock that advances with the sequence, so later is later."""
    return f"2026-06-15T{seq // 60:02d}:{seq % 60:02d}:00"


def answer(client, headers, question_id, value=None, day=DAY, hour=9, option_id=None):
    """Submit one answer the only way there is: through the sync queue.

    Returns
    -------
    dict
        The verdict on that one intent, rather than an HTTP response — every
        write is now one item in a queue and is answered as one.
    """
    seq = next(_sent)
    response = client.post(
        "/api/sync",
        headers=headers,
        json={
            "intents": [
                {
                    "seq": seq,
                    "kind": "answer.put",
                    "client_updated_at": stamp(seq),
                    "payload": {
                        "day": day,
                        "local_hour": hour,
                        "question_id": question_id,
                        "value": value,
                        "option_id": option_id,
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["results"][0]


def test_repeated_answers_upsert_rather_than_duplicate(
    client, admin_headers, starter_questions
):
    question_id = starter_questions[0]["id"]
    answer(client, admin_headers, question_id, 4)
    answer(client, admin_headers, question_id, 4)
    answer(client, admin_headers, question_id, 2)
    rows = [
        row
        for row in client.get("/api/answers", headers=admin_headers).json()
        if row["question_id"] == question_id
    ]
    assert len(rows) == 1
    assert rows[0]["value"] == 2.0


def test_past_and_future_days_are_unbounded(client, admin_headers, starter_questions):
    question_id = starter_questions[0]["id"]
    for day in ("1999-01-01", "2099-12-31"):
        assert (
            answer(client, admin_headers, question_id, 3, day=day)["outcome"]
            == "applied"
        )
    rows = client.get("/api/answers", headers=admin_headers).json()
    days = {row["day"] for row in rows}
    assert {"1999-01-01", "2099-12-31"} <= days


def test_answers_are_filtered_by_range(client, admin_headers, starter_questions):
    question_id = starter_questions[0]["id"]
    answer(client, admin_headers, question_id, 3, day="2026-01-01")
    answer(client, admin_headers, question_id, 4, day="2026-06-01")
    rows = client.get(
        "/api/answers?from=2026-05-01&to=2026-07-01", headers=admin_headers
    ).json()
    assert {row["day"] for row in rows} == {"2026-06-01"}


def test_values_outside_bounds_are_rejected(client, admin_headers, starter_questions):
    question_id = starter_questions[0]["id"]
    assert answer(client, admin_headers, question_id, -1)["outcome"] == "conflict"
    assert answer(client, admin_headers, question_id, 6)["outcome"] == "conflict"
    assert answer(client, admin_headers, question_id, 2.5)["outcome"] == "conflict"
    # 0 is the bottom of the WHO-5 scale, so it must be accepted.
    assert answer(client, admin_headers, question_id, 0)["outcome"] == "applied"


def test_enum_answer_requires_a_matching_option(
    client, admin_headers, catalogue_id, starter_questions
):
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Where did you work",
            "options": [{"label": "Home"}, {"label": "Office"}],
        },
    ).json()
    option_id = created["options"][0]["id"]

    assert (
        answer(client, admin_headers, created["id"], option_id=option_id)["outcome"]
        == "applied"
    )
    # A value where an option belongs, and an option from another question:
    # both refused, and refused by the rules rather than by the door, which is
    # why they are still refused now the door has gone.
    assert (
        answer(client, admin_headers, created["id"], value=1)["outcome"] == "conflict"
    )
    assert (
        answer(client, admin_headers, starter_questions[0]["id"], option_id=option_id)[
            "outcome"
        ]
        == "conflict"
    )


def own_first_question(client, headers):
    """Return the id of that account's own first asked question."""
    me = client.get("/api/me", headers=headers).json()
    detail = client.get(
        f"/api/catalogues/{me['default_catalogue_id']}", headers=headers
    ).json()
    return next(q["id"] for q in detail["questions"] if q["origin"] == "asked")


def test_users_cannot_see_or_touch_each_others_answers(client, admin_headers):
    # Each account answers its *own* copy of the question now. They cannot share
    # one: a catalogue belongs to somebody, so the two ids below differ.
    _, alice = make_user(client, admin_headers, "alice")
    _, bob = make_user(client, admin_headers, "bob")
    alice_question = own_first_question(client, alice)
    bob_question = own_first_question(client, bob)
    assert alice_question != bob_question

    answer(client, alice, alice_question, 5)
    assert client.get("/api/answers", headers=bob).json() == []

    answer(client, bob, bob_question, 1)
    alice_rows = [
        row
        for row in client.get("/api/answers", headers=alice).json()
        if row["question_id"] == alice_question
    ]
    assert alice_rows[0]["value"] == 5.0

    # Bob overwriting his own answer leaves Alice's untouched.
    answer(client, bob, bob_question, 2)
    alice_after = [
        row
        for row in client.get("/api/answers", headers=alice).json()
        if row["question_id"] == alice_question
    ]
    assert alice_after[0]["value"] == 5.0


def test_answering_another_accounts_question_is_refused(client, admin_headers):
    # The hole the ownership sweep closed. Nothing in the app offers this, but
    # the sync queue takes a bare question id and used to look no further than
    # whether it existed.
    _, alice = make_user(client, admin_headers, "alice")
    _, bob = make_user(client, admin_headers, "bob")
    alice_question = own_first_question(client, alice)

    verdict = answer(client, bob, alice_question, 3)

    assert verdict["outcome"] == "conflict", verdict
    assert client.get("/api/answers", headers=bob).json() == []


def test_stats_variables_report_roles(
    client, admin_headers, catalogue_id, starter_questions
):
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Where did you work",
            "options": [{"label": "Home"}, {"label": "Office"}],
        },
    ).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4)
    answer(client, admin_headers, created["id"], option_id=created["options"][0]["id"])

    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    by_key = {variable["key"]: variable for variable in variables}
    assert SYSTEM_KEYS <= set(by_key)
    # Auto-tracked variables subset the data; they are never plotted themselves.
    for key in SYSTEM_KEYS:
        assert by_key[key]["roles"] == ["filter"], key
    assert by_key["weekday"]["kind"] == "enum"
    labels = [o["label"] for o in by_key["weekday"]["options"]]
    assert labels[:3] == ["Mon", "Tue", "Wed"]
    assert by_key["month"]["kind"] == "enum"
    assert by_key["year"]["kind"] == "discrete"
    assert by_key[f"q{created['id']}"]["roles"] == ["group", "radar"]
    assert "axis" not in by_key[f"q{created['id']}"]["roles"]


def test_non_finite_values_are_rejected(client, admin_headers, starter_questions):
    """NaN slips past every bound comparison, so it must be refused up front."""
    import json

    for raw in ("NaN", "Infinity"):
        response = client.request(
            "POST",
            "/api/sync",
            headers={**admin_headers, "Content-Type": "application/json"},
            content=json.dumps(
                {
                    "intents": [
                        {
                            "seq": 1,
                            "kind": "answer.put",
                            "client_updated_at": "2026-06-15T09:00:00",
                            "payload": {
                                "day": DAY,
                                "local_hour": 9,
                                "question_id": starter_questions[0]["id"],
                                "value": float("nan") if raw == "NaN" else float("inf"),
                            },
                        }
                    ]
                }
            ),
        )
        assert response.status_code == 200, f"{raw} -> {response.status_code}"
        verdict = response.json()["results"][0]
        assert verdict["outcome"] == "conflict", f"{raw} -> {verdict}"


def test_a_deactivated_question_leaves_the_variables(
    client, admin_headers, catalogue_id, starter_questions
):
    kept, retired = starter_questions[0], starter_questions[1]
    answer(client, admin_headers, kept["id"], 4)
    answer(client, admin_headers, retired["id"], 2)

    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    assert f"q{retired['id']}" in {v["key"] for v in variables}

    client.put(
        f"/api/questions/{retired['id']}", headers=admin_headers, json={"active": False}
    )

    # Off the plots, because nobody records it any more...
    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    keys = {v["key"] for v in variables}
    assert f"q{kept['id']}" in keys
    assert f"q{retired['id']}" not in keys

    # ...but the answer it already holds is still recorded and still exported.
    rows = client.get("/api/answers", headers=admin_headers).json()
    assert any(row["question_id"] == retired["id"] for row in rows)
    assert any(row["question_id"] == retired["id"] for row in rows)
