from tests.conftest import make_user

"""Starter question sets, and building a catalogue from one.

Templates are code, not rows, so the interesting assertions are about what a
build *produces* rather than about storage: the right questions, in order, with
a score over them, owned by the account that asked for it — and no link back to
the template afterwards.
"""


def templates(client, headers):
    """Read the templates on offer."""
    response = client.get("/api/catalogue-templates", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_templates_are_listed_with_what_they_are(client, admin_headers):
    offered = templates(client, admin_headers)

    assert [one["key"] for one in offered] == ["who-5"]
    who5 = offered[0]
    assert who5["name"] == "WHO-5"
    assert who5["description"]


def test_any_signed_in_account_may_read_them(client, admin_headers):
    # No permission: choosing what to track is not administration, which is the
    # whole reason the editing permission is going away.
    _, headers = make_user(client, admin_headers, "ordinary")

    assert [one["key"] for one in templates(client, headers)] == ["who-5"]


def test_templates_need_a_token(client):
    assert client.get("/api/catalogue-templates").status_code == 401


def test_the_bootstrapped_admin_starts_on_the_template(
    client, admin_headers, catalogue_id
):
    # The admin's own catalogue is built from the same registry the API offers,
    # so there is one definition of WHO-5 rather than two that can drift.
    detail = client.get(f"/api/catalogues/{catalogue_id}", headers=admin_headers)
    assert detail.status_code == 200, detail.text
    body = detail.json()

    assert body["name"] == "WHO-5"
    asked = [q for q in body["questions"] if q["origin"] == "asked"]
    assert [q["prompt"] for q in asked] == [
        "I have felt cheerful and in good spirits",
        "I have felt calm and relaxed",
        "I have felt active and vigorous",
        "I woke up feeling fresh and rested",
        "My daily life has been filled with things that interest me",
    ]
    assert all(q["min_value"] == 0.0 and q["max_value"] == 5.0 for q in asked)

    # The score the template names, over every question it added.
    scores = [q for q in body["questions"] if q["origin"] == "computed"]
    assert [q["prompt"] for q in scores] == ["Raw score"]

    # And the auto-tracked questions every catalogue carries.
    auto = [q for q in body["questions"] if q["origin"] == "auto"]
    assert len(auto) == 5
