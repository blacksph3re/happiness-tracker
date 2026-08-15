from datetime import date
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


def system_answers(client, headers, catalogue_id, day=DAY):
    """Return the auto-tracked answers for a day, keyed by system key.

    Enum system questions resolve to their option label, scaled ones to their
    number, which is how each reads everywhere else in the app.
    """
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=headers).json()
    by_id = {q["id"]: q for q in detail["questions"] if q["system_key"]}
    labels = {
        option["id"]: option["label"]
        for question in by_id.values()
        for option in question["options"]
    }
    rows = client.get("/api/answers", headers=headers).json()
    return {
        by_id[row["question_id"]]["system_key"]: (
            labels[row["option_id"]] if row["option_id"] is not None else row["value"]
        )
        for row in rows
        if row["question_id"] in by_id and row["day"] == day
    }


def test_answering_a_day_materialises_system_answers(
    client, admin_headers, catalogue_id, starter_questions
):
    written = answer(client, admin_headers, starter_questions[0]["id"], 4)
    assert written["outcome"] == "applied"
    recorded = system_answers(client, admin_headers, catalogue_id)
    assert set(recorded) == SYSTEM_KEYS
    assert recorded["weekday"] == "Wed"  # 2026-03-04 was a Wednesday
    assert recorded["day_of_year"] == float(date.fromisoformat(DAY).timetuple().tm_yday)
    assert recorded["month"] == "Mar"
    assert recorded["year"] == 2026.0
    assert recorded["first_answer_hour"] == 9.0


def test_later_answers_do_not_move_the_first_hour(
    client, admin_headers, catalogue_id, starter_questions
):
    answer(client, admin_headers, starter_questions[0]["id"], 4, hour=9)
    answer(client, admin_headers, starter_questions[1]["id"], 2, hour=21)
    tracked = system_answers(client, admin_headers, catalogue_id)
    assert tracked["first_answer_hour"] == 9.0


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


def test_past_and_future_days_are_unbounded(
    client, admin_headers, starter_questions
):
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


def test_system_questions_reject_direct_writes(
    client, admin_headers, catalogue_id
):
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    system_id = next(q["id"] for q in detail["questions"] if q["system_key"])
    assert answer(client, admin_headers, system_id, 3)["outcome"] == "conflict"


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
        answer(client, admin_headers, created["id"], value=1)["outcome"]
        == "conflict"
    )
    assert (
        answer(client, admin_headers, starter_questions[0]["id"], option_id=option_id)[
            "outcome"
        ]
        == "conflict"
    )

def test_users_cannot_see_or_touch_each_others_answers(
    client, admin_headers, starter_questions
):
    _, alice = make_user(client, admin_headers, "alice")
    _, bob = make_user(client, admin_headers, "bob")
    question_id = starter_questions[0]["id"]

    answer(client, alice, question_id, 5)
    assert client.get("/api/answers", headers=bob).json() == []

    answer(client, bob, question_id, 1)
    alice_rows = [
        row
        for row in client.get("/api/answers", headers=alice).json()
        if row["question_id"] == question_id
    ]
    assert alice_rows[0]["value"] == 5.0

    # Bob overwriting his own answer leaves Alice's untouched.
    answer(client, bob, question_id, 2)
    alice_after = [
        row
        for row in client.get("/api/answers", headers=alice).json()
        if row["question_id"] == question_id
    ]
    assert alice_after[0]["value"] == 5.0


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


def test_system_variables_merge_across_catalogues(
    client, admin_headers, catalogue_id, starter_questions
):
    """Switching catalogue must not split an auto-tracked variable in two."""
    answer(client, admin_headers, starter_questions[0]["id"], 4, day="2026-03-04")

    second = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Second"}
    ).json()
    other_question = client.post(
        f"/api/catalogues/{second['id']}/questions",
        headers=admin_headers,
        json={"kind": "discrete", "prompt": "Sleep", "min_value": 1, "max_value": 5},
    ).json()
    answer(client, admin_headers, other_question["id"], 3, day="2026-03-06")

    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    weekday = [v for v in variables if v["system_key"] == "weekday"]
    assert len(weekday) == 1
    assert len(weekday[0]["question_ids"]) == 2


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

def test_one_set_of_system_answers_per_day_across_catalogues(
    client, admin_headers, starter_questions
):
    """A mid-day catalogue switch must not record a second first-answer hour."""
    answer(client, admin_headers, starter_questions[0]["id"], 4, hour=8)

    second = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Evening"}
    ).json()
    other = client.post(
        f"/api/catalogues/{second['id']}/questions",
        headers=admin_headers,
        json={"kind": "discrete", "prompt": "Sleep", "min_value": 1, "max_value": 5},
    ).json()
    answer(client, admin_headers, other["id"], 3, hour=20)

    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    hour_variable = next(v for v in variables if v["system_key"] == "first_answer_hour")
    rows = client.get("/api/answers", headers=admin_headers).json()
    hour_ids = hour_variable["question_ids"]
    hours = [row["value"] for row in rows if row["question_id"] in hour_ids]
    assert hours == [8.0], "the day must carry exactly one first-answer hour"


def test_a_second_catalogue_adds_no_second_set_of_system_rows(
    client, admin_headers, starter_questions
):
    """One day carries one set of auto-tracked answers, whatever it was answered in."""
    answer(client, admin_headers, starter_questions[0]["id"], 4, hour=8)
    second = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Evening"}
    ).json()
    other = client.post(
        f"/api/catalogues/{second['id']}/questions",
        headers=admin_headers,
        json={"kind": "discrete", "prompt": "Sleep", "min_value": 1, "max_value": 5},
    ).json()
    answer(client, admin_headers, other["id"], 3, hour=20)

    rows = client.get("/api/answers", headers=admin_headers).json()
    assert len(rows) == 7, "two real answers plus one set of five auto-tracked rows"


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
