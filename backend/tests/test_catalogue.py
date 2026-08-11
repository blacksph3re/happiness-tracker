SYSTEM_KEYS = {"weekday", "day_of_year", "month", "year", "first_answer_hour"}


def test_bootstrap_creates_starter_catalogue(client, admin_headers, catalogue_id):
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    prompts = [q["prompt"] for q in detail["questions"] if q["system_key"] is None]
    assert prompts == [
        "I have felt cheerful and in good spirits",
        "I have felt calm and relaxed",
        "I have felt active and vigorous",
        "I woke up feeling fresh and rested",
        "My daily life has been filled with things that interest me",
    ]
    scaled = [q for q in detail["questions"] if q["system_key"] is None]
    assert all(q["kind"] == "discrete" for q in scaled)
    # The WHO-5 response scale runs 0-5, not 1-5.
    assert all((q["min_value"], q["max_value"]) == (0.0, 5.0) for q in scaled)
    assert all(q["min_label"] == "At no time" for q in scaled)
    assert {q["system_key"] for q in detail["questions"] if q["system_key"]} == SYSTEM_KEYS


def test_new_catalogue_gets_its_own_system_questions(client, admin_headers):
    created = client.post(
        "/api/catalogues", headers=admin_headers, json={"name": "Work"}
    ).json()
    detail = client.get(f"/api/catalogues/{created['id']}", headers=admin_headers).json()
    assert {q["system_key"] for q in detail["questions"] if q["system_key"]} == SYSTEM_KEYS
    assert [q for q in detail["questions"] if q["system_key"] is None] == []


def test_duplicate_catalogue_name_is_rejected(client, admin_headers):
    client.post("/api/catalogues", headers=admin_headers, json={"name": "Work"})
    again = client.post("/api/catalogues", headers=admin_headers, json={"name": "Work"})
    assert again.status_code == 409


def test_system_questions_cannot_be_edited_or_deleted(
    client, admin_headers, catalogue_id
):
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    system_id = next(q["id"] for q in detail["questions"] if q["system_key"])
    assert (
        client.put(
            f"/api/questions/{system_id}", headers=admin_headers, json={"prompt": "no"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/questions/{system_id}/options",
            headers=admin_headers,
            json={"label": "no"},
        ).status_code
        == 403
    )


def test_unanswered_questions_are_freely_editable(
    client, admin_headers, starter_questions
):
    question_id = starter_questions[0]["id"]
    response = client.put(
        f"/api/questions/{question_id}",
        headers=admin_headers,
        json={"min_value": 1, "max_value": 10, "max_label": "Boundless"},
    )
    assert response.status_code == 200
    assert response.json()["max_value"] == 10.0
    assert response.json()["max_label"] == "Boundless"


def test_answered_questions_freeze_their_scale(
    client, admin_headers, starter_questions
):
    question_id = starter_questions[0]["id"]
    client.put(
        "/api/answers",
        headers=admin_headers,
        json={
            "day": "2026-03-04",
            "local_hour": 9,
            "question_id": question_id,
            "value": 4,
        },
    )
    frozen = client.put(
        f"/api/questions/{question_id}",
        headers=admin_headers,
        json={"min_value": 1, "max_value": 10},
    )
    assert frozen.status_code == 409
    assert "already been answered" in frozen.json()["detail"].lower()

    # Prompt, position and active stay editable forever.
    allowed = client.put(
        f"/api/questions/{question_id}",
        headers=admin_headers,
        json={"prompt": "How energetic did you feel", "active": False, "position": 7},
    )
    assert allowed.status_code == 200
    assert allowed.json()["active"] is False


def test_deactivated_question_keeps_its_history(
    client, admin_headers, catalogue_id, starter_questions
):
    question_id = starter_questions[0]["id"]
    client.put(
        "/api/answers",
        headers=admin_headers,
        json={
            "day": "2026-03-04",
            "local_hour": 9,
            "question_id": question_id,
            "value": 4,
        },
    )
    client.put(
        f"/api/questions/{question_id}", headers=admin_headers, json={"active": False}
    )
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    question = next(q for q in detail["questions"] if q["id"] == question_id)
    assert question["active"] is False

    rows = client.get("/api/answers", headers=admin_headers).json()
    assert any(row["question_id"] == question_id for row in rows)


def test_enum_options_freeze_once_answered(client, admin_headers, catalogue_id):
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Where did you work",
            "options": [{"label": "Home"}, {"label": "Office"}],
        },
    ).json()
    added = client.post(
        f"/api/questions/{created['id']}/options",
        headers=admin_headers,
        json={"label": "Cafe"},
    )
    assert added.status_code == 201
    assert len(added.json()["options"]) == 3

    client.put(
        "/api/answers",
        headers=admin_headers,
        json={
            "day": "2026-03-04",
            "local_hour": 9,
            "question_id": created["id"],
            "option_id": created["options"][0]["id"],
        },
    )
    assert (
        client.post(
            f"/api/questions/{created['id']}/options",
            headers=admin_headers,
            json={"label": "Beach"},
        ).status_code
        == 409
    )


def test_question_payload_must_match_its_kind(client, admin_headers, catalogue_id):
    path = f"/api/catalogues/{catalogue_id}/questions"
    assert (
        client.post(
            path,
            headers=admin_headers,
            json={"kind": "enum", "prompt": "x", "options": [{"label": "only"}]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            path, headers=admin_headers, json={"kind": "discrete", "prompt": "x"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            path,
            headers=admin_headers,
            json={
                "kind": "continuous",
                "prompt": "x",
                "min_value": 10,
                "max_value": 1,
            },
        ).status_code
        == 422
    )


def test_catalogue_with_answers_cannot_be_deleted(
    client, admin_headers, catalogue_id, starter_questions
):
    client.put(
        "/api/answers",
        headers=admin_headers,
        json={
            "day": "2026-03-04",
            "local_hour": 9,
            "question_id": starter_questions[0]["id"],
            "value": 4,
        },
    )
    response = client.delete(f"/api/catalogues/{catalogue_id}", headers=admin_headers)
    assert response.status_code == 409


def test_bounds_cannot_be_set_on_an_enum_question(client, admin_headers, catalogue_id):
    """The database check constraint must never be the thing that rejects this."""
    created = client.post(
        f"/api/catalogues/{catalogue_id}/questions",
        headers=admin_headers,
        json={
            "kind": "enum",
            "prompt": "Where did you work",
            "options": [{"label": "Home"}, {"label": "Office"}],
        },
    ).json()
    response = client.put(
        f"/api/questions/{created['id']}", headers=admin_headers, json={"min_value": 1}
    )
    assert response.status_code == 422


def test_renaming_a_catalogue_keeps_its_questions_and_answers(
    client, admin_headers, catalogue_id, starter_questions
):
    client.put(
        "/api/answers",
        headers=admin_headers,
        json={
            "day": "2026-03-04",
            "local_hour": 9,
            "question_id": starter_questions[0]["id"],
            "value": 4,
        },
    )
    renamed = client.put(
        f"/api/catalogues/{catalogue_id}",
        headers=admin_headers,
        json={"name": "Evening check-in"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Evening check-in"

    listed = client.get("/api/catalogues", headers=admin_headers).json()
    assert [c["name"] for c in listed] == ["Evening check-in"]

    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers).json()
    assert len(detail["questions"]) == len(starter_questions) + 5
    assert client.get("/api/answers", headers=admin_headers).json() != []


def test_renaming_onto_an_existing_name_is_rejected(client, admin_headers, catalogue_id):
    client.post("/api/catalogues", headers=admin_headers, json={"name": "Work"})
    clash = client.put(
        f"/api/catalogues/{catalogue_id}", headers=admin_headers, json={"name": "Work"}
    )
    assert clash.status_code == 409
    # The failed rename must not have half-applied.
    names = {c["name"] for c in client.get("/api/catalogues", headers=admin_headers).json()}
    assert "Work" in names and len(names) == 2


def test_renaming_to_a_blank_name_is_rejected(client, admin_headers, catalogue_id):
    response = client.put(
        f"/api/catalogues/{catalogue_id}", headers=admin_headers, json={"name": ""}
    )
    assert response.status_code == 422


def test_renaming_an_unknown_catalogue_is_a_404(client, admin_headers):
    response = client.put(
        "/api/catalogues/9999", headers=admin_headers, json={"name": "Nowhere"}
    )
    assert response.status_code == 404


def test_a_prompt_longer_than_the_limit_is_refused(client, admin_headers, catalogue_id):
    """The questionnaire reserves room for exactly this much question."""
    from models import PROMPT_MAX_LENGTH

    path = f"/api/catalogues/{catalogue_id}/questions"
    body = {"kind": "discrete", "prompt": "x", "min_value": 1, "max_value": 5}

    at_limit = client.post(
        path, headers=admin_headers, json={**body, "prompt": "a" * PROMPT_MAX_LENGTH}
    )
    assert at_limit.status_code == 201

    too_long = client.post(
        path, headers=admin_headers, json={**body, "prompt": "a" * (PROMPT_MAX_LENGTH + 1)}
    )
    assert too_long.status_code == 422

    # The same ceiling applies when rewording an existing question.
    created = at_limit.json()
    assert (
        client.put(
            f"/api/questions/{created['id']}",
            headers=admin_headers,
            json={"prompt": "a" * (PROMPT_MAX_LENGTH + 1)},
        ).status_code
        == 422
    )
