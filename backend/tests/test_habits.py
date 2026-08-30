"""The rules a habit definition has to satisfy, at both layers.

A habit is an enum question carrying three extra facts. Two things are worth
testing that the shape rules alone do not say:

* the freeze that stops an answered question gaining or losing options must
  **not** stop it being marked as a habit, because that is a definition over
  answers which are already correct;
* the check constraints have to hold against raw SQL, since they exist for the
  hand-written UPDATE that never meets the service layer.
"""

import sqlite3

import pytest

from services import HabitRuleError, check_habit_shape
from tests.conftest import make_user
from tests.test_answers import answer


def make_habit(client, headers, catalogue_id, **overrides):
    """Create a gym-shaped habit question and return the response."""
    payload = {
        "kind": "enum",
        "prompt": "Went to gym?",
        "icon": "🏃",
        "habit_period": "week",
        "habit_target": 1,
        "habit_direction": "at_least",
        "options": [
            {"label": "Long", "counts": True},
            {"label": "Short", "counts": True},
            {"label": "No"},
        ],
    }
    payload.update(overrides)
    return client.post(
        f"/api/catalogues/{catalogue_id}/questions", headers=headers, json=payload
    )


# --------------------------------------------------------------------------
# The shape rules, at the service layer
# --------------------------------------------------------------------------


def test_a_habit_needs_all_three_fields_or_none_of_them():
    check_habit_shape("enum", None, None, None)
    check_habit_shape("enum", "week", 1, "at_least")

    with pytest.raises(HabitRuleError):
        check_habit_shape("enum", "week", None, "at_least")
    with pytest.raises(HabitRuleError):
        check_habit_shape("enum", None, 1, "at_least")
    with pytest.raises(HabitRuleError):
        check_habit_shape("enum", "week", 1, None)


def test_only_an_enum_question_can_be_a_habit():
    with pytest.raises(HabitRuleError):
        check_habit_shape("discrete", "week", 1, "at_least")
    with pytest.raises(HabitRuleError):
        check_habit_shape("continuous", "day", 1, "at_least")


def test_a_target_of_zero_is_allowed_only_as_a_ceiling():
    check_habit_shape("enum", "week", 0, "at_most")
    with pytest.raises(HabitRuleError):
        check_habit_shape("enum", "week", 0, "at_least")


def test_a_negative_target_is_never_allowed():
    with pytest.raises(HabitRuleError):
        check_habit_shape("enum", "week", -1, "at_most")


# --------------------------------------------------------------------------
# The same rules over HTTP
# --------------------------------------------------------------------------


def test_a_habit_round_trips_with_its_target_icon_and_counted_options(
    client, admin_headers, catalogue_id
):
    created = make_habit(client, admin_headers, catalogue_id)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["habit_period"] == "week"
    assert body["habit_target"] == 1
    assert body["habit_direction"] == "at_least"
    assert body["icon"] == "🏃"
    assert [option["counts"] for option in body["options"]] == [True, True, False]


def test_a_plain_question_reports_no_habit_and_no_counted_options(
    client, admin_headers, catalogue_id
):
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Weather?",
            "options": [{"label": "Sun"}, {"label": "Rain"}],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["habit_period"] is None
    assert body["habit_target"] is None
    assert body["habit_direction"] is None
    assert body["icon"] is None
    assert [option["counts"] for option in body["options"]] == [False, False]


def test_a_habit_target_on_a_scaled_question_is_refused(
    client, admin_headers, catalogue_id
):
    refused = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "discrete",
            "prompt": "Slept well?",
            "min_value": 1,
            "max_value": 5,
            "habit_period": "week",
            "habit_target": 1,
            "habit_direction": "at_least",
        },
    )
    assert refused.status_code == 422, refused.text


def test_half_a_habit_is_refused(client, admin_headers, catalogue_id):
    refused = make_habit(client, admin_headers, catalogue_id, habit_target=None)
    assert refused.status_code == 422, refused.text


def test_an_unknown_period_or_direction_is_refused_before_any_handler_runs(
    client, admin_headers, catalogue_id
):
    # Pydantic's Literal, which answers with the field name rather than a rule.
    for field, value in (
        ("habit_period", "fortnight"),
        ("habit_direction", "roughly"),
    ):
        refused = make_habit(client, admin_headers, catalogue_id, **{field: value})
        assert refused.status_code == 422, refused.text
        assert field in refused.text


def test_a_ceiling_of_zero_is_accepted(client, admin_headers, catalogue_id):
    created = make_habit(
        client,
        admin_headers,
        catalogue_id,
        prompt="Smoked?",
        icon="🚭",
        habit_target=0,
        habit_direction="at_most",
        options=[{"label": "Yes", "counts": True}, {"label": "No"}],
    )
    assert created.status_code == 201, created.text
    assert created.json()["habit_target"] == 0


def test_a_negative_target_is_refused_over_http(client, admin_headers, catalogue_id):
    refused = make_habit(
        client, admin_headers, catalogue_id, habit_target=-1, habit_direction="at_most"
    )
    assert refused.status_code == 422, refused.text


def test_an_icon_longer_than_the_limit_is_refused(client, admin_headers, catalogue_id):
    refused = make_habit(client, admin_headers, catalogue_id, icon="🏃" * 20)
    assert refused.status_code == 422, refused.text


# --------------------------------------------------------------------------
# The freeze, and the exemption that matters
# --------------------------------------------------------------------------


def test_counts_may_be_changed_on_a_question_that_has_answers(
    client, admin_headers, catalogue_id
):
    """The load-bearing one: a definition over correct answers stays editable.

    Marking an option as counted does not reinterpret a recorded answer the way
    adding a choice would. It says what the recorded answers *mean* for a
    streak, and a definition change is retroactive here by design.
    """
    created = make_habit(client, admin_headers, catalogue_id).json()
    short = next(o for o in created["options"] if o["label"] == "Short")
    answer(client, admin_headers, created["id"], option_id=short["id"])

    changed = client.put(
        f"/api/questions/{created['id']}/options/{short['id']}",
        headers=admin_headers,
        json={"counts": False},
    )
    assert changed.status_code == 200, changed.text
    assert [o["counts"] for o in changed.json()["options"]] == [True, False, False]


def test_a_habit_target_may_be_changed_on_a_question_that_has_answers(
    client, admin_headers, catalogue_id
):
    created = make_habit(client, admin_headers, catalogue_id).json()
    answer(client, admin_headers, created["id"], option_id=created["options"][0]["id"])

    changed = client.put(
        f"/api/questions/{created['id']}",
        headers=admin_headers,
        json={
            "habit_period": "week",
            "habit_target": 3,
            "habit_direction": "at_most",
            "icon": "🚭",
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["habit_target"] == 3
    assert changed.json()["habit_direction"] == "at_most"
    assert changed.json()["icon"] == "🚭"


def test_a_habit_may_be_turned_off_and_the_counted_options_are_left_alone(
    client, admin_headers, catalogue_id
):
    created = make_habit(client, admin_headers, catalogue_id).json()
    off = client.put(
        f"/api/questions/{created['id']}",
        headers=admin_headers,
        json={
            "habit_period": None,
            "habit_target": None,
            "habit_direction": None,
        },
    )
    assert off.status_code == 200, off.text
    assert off.json()["habit_period"] is None
    # Kept, so turning it back on does not lose an answer nobody asked for again.
    assert [o["counts"] for o in off.json()["options"]] == [True, True, False]


def test_an_option_may_still_not_be_added_or_removed_once_answered(
    client, admin_headers, catalogue_id
):
    """The other half of the exemption: it has to stay narrow."""
    created = make_habit(client, admin_headers, catalogue_id).json()
    answer(client, admin_headers, created["id"], option_id=created["options"][0]["id"])

    added = client.post(
        f"/api/questions/{created['id']}/options",
        headers=admin_headers,
        json={"label": "Very long"},
    )
    assert added.status_code == 409, added.text

    removed = client.delete(
        f"/api/questions/{created['id']}/options/{created['options'][2]['id']}",
        headers=admin_headers,
    )
    assert removed.status_code == 409, removed.text


def test_renaming_an_option_leaves_its_counted_flag_alone(
    client, admin_headers, catalogue_id
):
    created = make_habit(client, admin_headers, catalogue_id).json()
    long_option = created["options"][0]
    renamed = client.put(
        f"/api/questions/{created['id']}/options/{long_option['id']}",
        headers=admin_headers,
        json={"label": "A long one"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["options"][0]["label"] == "A long one"
    assert renamed.json()["options"][0]["counts"] is True


# --------------------------------------------------------------------------
# Ownership: the endpoint resolves a bare option id
# --------------------------------------------------------------------------


def test_another_accounts_option_is_not_found(
    client, admin_headers, catalogue_id, admin_token
):
    created = make_habit(client, admin_headers, catalogue_id).json()
    _, other = make_user(client, admin_headers, "intruder")

    refused = client.put(
        f"/api/questions/{created['id']}/options/{created['options'][0]['id']}",
        headers=other,
        json={"counts": False},
    )
    assert refused.status_code == 404, refused.text


def test_an_option_from_another_question_is_not_found(
    client, admin_headers, catalogue_id
):
    mine = make_habit(client, admin_headers, catalogue_id).json()
    other = make_habit(
        client, admin_headers, catalogue_id, prompt="Read today?", icon="📖"
    ).json()

    refused = client.put(
        f"/api/questions/{mine['id']}/options/{other['options'][0]['id']}",
        headers=admin_headers,
        json={"counts": False},
    )
    assert refused.status_code == 404, refused.text


# --------------------------------------------------------------------------
# The schema is the floor under a hand-written UPDATE
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("clause", "why"),
    [
        ("habit_period = 'week'", "a period with no target or direction"),
        ("habit_target = 1", "a target with no period"),
        ("habit_direction = 'at_least'", "a direction with no period"),
        (
            "habit_period = 'fortnight', habit_target = 1,"
            " habit_direction = 'at_least'",
            "a period nobody defined",
        ),
        (
            "habit_period = 'week', habit_target = 1, habit_direction = 'often'",
            "a direction nobody defined",
        ),
        (
            "habit_period = 'week', habit_target = -1, habit_direction = 'at_most'",
            "a target below zero",
        ),
    ],
)
def test_the_check_constraints_refuse_a_broken_habit(
    client, admin_headers, catalogue_id, tmp_path, clause, why
):
    """No service layer here — raw SQL against the database itself.

    These constraints exist for the hand-written UPDATE that never meets a
    router, so going through the API would prove nothing about them. Applied to
    a question that is *not* already a habit, so that setting one field on its
    own really does leave the row half-defined.
    """
    plain = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Weather?",
            "options": [{"label": "Sun"}, {"label": "Rain"}],
        },
    )
    assert plain.status_code == 201, plain.text

    connection = sqlite3.connect(tmp_path / "test.db")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            with connection:
                connection.execute(
                    f"UPDATE questions SET {clause} WHERE id = ?",  # noqa: S608
                    (plain.json()["id"],),
                )
    finally:
        connection.close()


def test_the_database_refuses_a_habit_on_a_scaled_question(
    client, admin_headers, starter_questions, tmp_path
):
    """The enum rule, at the layer that has no idea what a router is."""
    scaled = next(q for q in starter_questions if q["kind"] != "enum")

    connection = sqlite3.connect(tmp_path / "test.db")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            with connection:
                connection.execute(
                    "UPDATE questions SET habit_period = 'week', habit_target = 1,"
                    " habit_direction = 'at_least' WHERE id = ?",
                    (scaled["id"],),
                )
    finally:
        connection.close()


def test_an_icon_can_be_taken_off_again(client, admin_headers, catalogue_id):
    """An explicit null clears it; every other field reads null as "leave alone".

    Without the distinction a chosen icon would be permanent, since there is no
    other value that means "none".
    """
    created = make_habit(client, admin_headers, catalogue_id).json()
    assert created["icon"] == "🏃"

    cleared = client.put(
        f"/api/questions/{created['id']}", headers=admin_headers, json={"icon": None}
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["icon"] is None


def test_an_edit_that_says_nothing_about_the_icon_leaves_it_alone(
    client, admin_headers, catalogue_id
):
    """The other half: omitting the field must not clear it."""
    created = make_habit(client, admin_headers, catalogue_id).json()

    renamed = client.put(
        f"/api/questions/{created['id']}",
        headers=admin_headers,
        json={"prompt": "Gym?"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["icon"] == "🏃"
