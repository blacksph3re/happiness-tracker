"""Auto-tracked variables are computed from the day, not stored as answers.

Weekday, day-of-year, month and year are pure functions of the calendar day and
the hour is a column on the answer, so none of them is an answer row any more.
These pin the four things that could regress: nothing is written, the hour
survives, the variables are still offered, and a second catalogue does not
double them.
"""

from tests.test_answers import DAY, SYSTEM_KEYS, answer


def test_answering_a_day_stores_no_auto_tracked_rows(
    client, admin_headers, starter_questions
):
    assert answer(client, admin_headers, starter_questions[0]["id"], 4)["outcome"] == (
        "applied"
    )
    rows = client.get("/api/answers", headers=admin_headers).json()
    assert [row["question_id"] for row in rows] == [starter_questions[0]["id"]]


def test_a_new_catalogue_has_no_auto_tracked_questions(client, admin_headers):
    created = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Work"}
    ).json()
    detail = client.get(
        f"/api/catalogues/{created['id']}", headers=admin_headers
    ).json()
    assert detail["questions"] == []


def test_the_starter_catalogue_has_no_auto_tracked_questions(
    client, admin_headers, catalogue_id
):
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    # The starter set still carries its computed score; only `auto` is gone.
    assert [q for q in detail["questions"] if q["origin"] == "auto"] == []


def test_an_answer_carries_the_hour_it_was_given_at(
    client, admin_headers, starter_questions
):
    answer(client, admin_headers, starter_questions[0]["id"], 4, hour=8)
    answer(client, admin_headers, starter_questions[1]["id"], 3, hour=20)
    rows = client.get("/api/answers", headers=admin_headers).json()
    by_question = {row["question_id"]: row["local_hour"] for row in rows}
    assert by_question[starter_questions[0]["id"]] == 8
    assert by_question[starter_questions[1]["id"]] == 20


def test_a_late_arriving_earlier_answer_keeps_its_own_hour(
    client, admin_headers, starter_questions
):
    """The bug the stored hour had: whichever write landed first won for ever.

    A phone answering at 08:00 offline and syncing after a laptop that answered
    at 14:00 recorded 14. Each row carrying its own hour is what lets the
    reader take the minimum and be right regardless of arrival order.
    """
    answer(client, admin_headers, starter_questions[0]["id"], 4, hour=14)
    answer(client, admin_headers, starter_questions[1]["id"], 3, hour=8)
    rows = client.get("/api/answers", headers=admin_headers).json()
    assert min(row["local_hour"] for row in rows if row["day"] == DAY) == 8


def test_system_variables_are_offered_without_any_question_behind_them(
    client, admin_headers, starter_questions
):
    answer(client, admin_headers, starter_questions[0]["id"], 4)
    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    system = {v["system_key"]: v for v in variables if v["system_key"]}
    assert set(system) == SYSTEM_KEYS
    assert all(v["question_ids"] == [] for v in system.values())
    assert all(v["roles"] == ["filter"] for v in system.values())
    assert all(v["origin"] == "auto" for v in system.values())


def test_an_enum_system_variable_offers_its_options_by_position(
    client, admin_headers, starter_questions
):
    """The option id is the position, because there is no option row to have one.

    It is also the value the client derives, so a chip and a day agree without
    a lookup.
    """
    answer(client, admin_headers, starter_questions[0]["id"], 4)
    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    weekday = next(v for v in variables if v["system_key"] == "weekday")
    assert [o["id"] for o in weekday["options"]] == list(range(7))
    assert [o["label"] for o in weekday["options"]] == [
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
        "Sun",
    ]
    month = next(v for v in variables if v["system_key"] == "month")
    assert [o["id"] for o in month["options"]] == list(range(12))


def test_one_weekday_variable_however_many_catalogues(
    client, admin_headers, starter_questions
):
    """What the cross-catalogue merge used to buy, now true by construction."""
    answer(client, admin_headers, starter_questions[0]["id"], 4)
    second = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Evening"}
    ).json()
    other = client.post(
        f"/api/catalogues/{second['id']}/questions",
        headers=admin_headers,
        json={"kind": "discrete", "prompt": "Sleep", "min_value": 1, "max_value": 5},
    ).json()
    answer(client, admin_headers, other["id"], 3, day="2026-03-06")

    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    assert len([v for v in variables if v["system_key"] == "weekday"]) == 1
    assert all(len(v["question_ids"]) <= 1 for v in variables)


def test_an_account_with_no_answers_is_offered_no_variables(client, admin_headers):
    assert client.get("/api/stats/variables", headers=admin_headers).json() == []
