from itertools import count

from tests.conftest import make_user

DAY = "2026-03-04"


_sent = count(1)


def stamp(seq):
    """Return a clock that advances with the sequence, so later is later."""
    return f"2026-06-15T{seq // 60:02d}:{seq % 60:02d}:00"


def answer(client, headers, question_id, value, day=DAY, hour=9):
    """Submit one answer the only way there is: through the sync queue."""
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
                    },
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["results"][0]


def score_of(client, headers, score_id, day=DAY):
    """Return the computed value of one score on one day, or None."""
    rows = client.get("/api/answers", headers=headers).json()
    for row in rows:
        if row["question_id"] == score_id and row["day"] == day:
            return row["value"]
    return None


def seeded_score(client, headers, catalogue_id):
    """Return the score the starter catalogue ships with."""
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=headers).json()
    return next(q for q in detail["questions"] if q["origin"] == "computed")


def make_score(client, headers, catalogue_id, **overrides):
    """Define a score over the starter questions and return the response."""
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=headers).json()
    asked = [q for q in detail["questions"] if q["origin"] == "asked"]
    payload = {
        "prompt": "Total",
        "aggregate": "sum",
        "components": [{"source_question_id": q["id"]} for q in asked[:2]],
    }
    payload.update(overrides)
    return client.post(
        f"/api/catalogues/{catalogue_id}/scores", headers=headers, json=payload
    )


def test_starter_catalogue_ships_a_total(client, admin_headers, catalogue_id):
    score = seeded_score(client, admin_headers, catalogue_id)
    assert score["prompt"] == "Raw score"
    assert score["aggregate"] == "sum"
    assert score["require_all"] is True
    assert len(score["components"]) == 5
    assert all(component["weight"] == 1.0 for component in score["components"])
    # After the questions it reads, before the auto-tracked block at 1000.
    asked = [
        q for q in
        client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers)
        .json()["questions"]
        if q["origin"] == "asked"
    ]
    assert all(q["position"] < score["position"] < 1000 for q in asked)


def test_a_complete_day_is_summed(
    client, admin_headers, catalogue_id, starter_questions
):
    for index, question in enumerate(starter_questions):
        answer(client, admin_headers, question["id"], float(index))
    score = seeded_score(client, admin_headers, catalogue_id)
    assert score_of(client, admin_headers, score["id"]) == 10.0


def test_a_partial_day_has_no_score(
    client, admin_headers, catalogue_id, starter_questions
):
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    score = seeded_score(client, admin_headers, catalogue_id)
    assert score_of(client, admin_headers, score["id"]) is None


def test_require_all_off_scores_what_is_there(
    client, admin_headers, catalogue_id, starter_questions
):
    created = make_score(
        client, admin_headers, catalogue_id, require_all=False
    ).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    assert score_of(client, admin_headers, created["id"]) == 4.0


def test_weights_and_mean(client, admin_headers, catalogue_id, starter_questions):
    created = make_score(
        client,
        admin_headers,
        catalogue_id,
        aggregate="mean",
        components=[
            {"source_question_id": starter_questions[0]["id"], "weight": 3.0},
            {"source_question_id": starter_questions[1]["id"], "weight": 1.0},
        ],
    ).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    answer(client, admin_headers, starter_questions[1]["id"], 0.0)
    assert score_of(client, admin_headers, created["id"]) == 3.0


def test_editing_a_definition_is_retroactive(
    client, admin_headers, catalogue_id, starter_questions
):
    created = make_score(client, admin_headers, catalogue_id).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    answer(client, admin_headers, starter_questions[1]["id"], 2.0)
    assert score_of(client, admin_headers, created["id"]) == 6.0

    client.put(
        f"/api/scores/{created['id']}",
        headers=admin_headers,
        json={
            "components": [{"source_question_id": starter_questions[0]["id"]}],
        },
    )
    # Nothing was recomputed, because nothing was stored: the same answers now
    # read differently because the definition does.
    assert score_of(client, admin_headers, created["id"]) == 4.0


def test_a_score_is_not_answerable(
    client, admin_headers, catalogue_id, starter_questions
):
    score = seeded_score(client, admin_headers, catalogue_id)
    assert answer(client, admin_headers, score["id"], 3.0)["outcome"] == "conflict"


def test_a_score_is_not_editable_as_a_question(
    client, admin_headers, catalogue_id
):
    score = seeded_score(client, admin_headers, catalogue_id)
    assert (
        client.put(
            f"/api/questions/{score['id']}",
            headers=admin_headers,
            json={"prompt": "no"},
        ).status_code
        == 403
    )


def test_enum_components_are_refused(client, admin_headers, catalogue_id):
    enum = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Where did you work?",
            "options": [{"label": "Home"}, {"label": "Office"}],
        },
    ).json()
    refused = make_score(
        client,
        admin_headers,
        catalogue_id,
        components=[{"source_question_id": enum["id"]}],
    )
    assert refused.status_code == 422


def test_a_score_cannot_feed_a_score(
    client, admin_headers, catalogue_id, starter_questions
):
    score = seeded_score(client, admin_headers, catalogue_id)
    refused = make_score(
        client,
        admin_headers,
        catalogue_id,
        components=[{"source_question_id": score["id"]}],
    )
    assert refused.status_code == 422


def test_components_stay_within_one_catalogue(
    client, admin_headers, catalogue_id, starter_questions
):
    other = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Work"}
    ).json()
    refused = make_score(
        client,
        admin_headers,
        other["id"],
        components=[{"source_question_id": starter_questions[0]["id"]}],
    )
    assert refused.status_code == 422


def test_bounds_come_from_the_components(
    client, admin_headers, catalogue_id, starter_questions
):
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    score = seeded_score(client, admin_headers, catalogue_id)
    variables = client.get("/api/stats/variables", headers=admin_headers).json()
    variable = next(v for v in variables if v["key"] == f"q{score['id']}")
    # Five items scored 0-5, summed.
    assert (variable["min_value"], variable["max_value"]) == (0.0, 25.0)
    assert variable["roles"] == ["axis", "radar"]


def test_a_deactivated_score_disappears(
    client, admin_headers, catalogue_id, starter_questions
):
    created = make_score(client, admin_headers, catalogue_id).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    answer(client, admin_headers, starter_questions[1]["id"], 2.0)
    assert score_of(client, admin_headers, created["id"]) == 6.0

    client.put(
        f"/api/scores/{created['id']}", headers=admin_headers, json={"active": False}
    )
    assert score_of(client, admin_headers, created["id"]) is None


def test_deleting_a_score_leaves_the_answers_alone(
    client, admin_headers, catalogue_id, starter_questions
):
    created = make_score(client, admin_headers, catalogue_id).json()
    answer(client, admin_headers, starter_questions[0]["id"], 4.0)
    assert client.delete(
        f"/api/scores/{created['id']}", headers=admin_headers
    ).status_code == 204
    rows = client.get("/api/answers", headers=admin_headers).json()
    assert any(
        row["question_id"] == starter_questions[0]["id"] and row["value"] == 4.0
        for row in rows
    )
    assert all(row["question_id"] != created["id"] for row in rows)


def test_scores_are_per_user(client, admin_headers, catalogue_id, starter_questions):
    _, other_headers = make_user(client, admin_headers, "bystander")
    for question in starter_questions:
        answer(client, admin_headers, question["id"], 3.0)
    score = seeded_score(client, admin_headers, catalogue_id)
    assert score_of(client, admin_headers, score["id"]) == 15.0
    assert score_of(client, other_headers, score["id"]) is None


def test_defining_a_score_needs_the_editor_flag(
    client, admin_headers, catalogue_id
):
    _, plain_headers = make_user(client, admin_headers, "reader")
    assert make_score(client, plain_headers, catalogue_id).status_code == 403

