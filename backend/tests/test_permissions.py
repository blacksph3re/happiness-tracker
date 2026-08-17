import pytest

from tests.conftest import make_user

USER_ROUTES = [
    ("GET", "/api/users", None),
    ("POST", "/api/users", {"username": "someone", "password": "abcdefgh"}),
    ("PUT", "/api/users/1", {"is_admin": True}),
    ("PUT", "/api/users/1/password", {"new_password": "abcdefgh"}),
    ("DELETE", "/api/users/1", None),
]

OWNED_ROUTES = [
    ("GET", "/api/catalogues/{id}", None),
    ("PUT", "/api/catalogues/{id}", {"name": "renamed"}),
    ("DELETE", "/api/catalogues/{id}", None),
    (
        "POST",
        "/api/catalogues/{id}/questions",
        {"kind": "discrete", "prompt": "x", "min_value": 1, "max_value": 5},
    ),
]
"""Routes that take a catalogue id, and must not answer for somebody else's."""


@pytest.fixture
def actors(client, admin_headers):
    """Return headers for an ordinary account and for one that manages users."""
    _, plain = make_user(client, admin_headers, "plain")
    _, admin_only = make_user(client, admin_headers, "adminonly", is_admin=True)
    return {"plain": plain, "admin_only": admin_only}


def own_catalogue(client, headers):
    """Return the id of the catalogue that account was created with."""
    return client.get("/api/me", headers=headers).json()["default_catalogue_id"]


@pytest.mark.parametrize("method,path,body", USER_ROUTES)
def test_user_routes_need_admin_flag(actors, client, method, path, body):
    response = client.request(method, path, headers=actors["plain"], json=body)
    assert response.status_code == 403, f"plain {method} {path}"
    response = client.request(method, path, headers=actors["admin_only"], json=body)
    assert response.status_code != 403, f"admin_only {method} {path}"


@pytest.mark.parametrize("method,path,body", OWNED_ROUTES)
def test_a_catalogue_route_answers_only_for_its_owner(
    actors, client, method, path, body
):
    # The whole of the ownership sweep, from outside. Every one of these used to
    # be gated on a permission and reachable across accounts once you held it.
    mine = own_catalogue(client, actors["plain"])
    theirs = own_catalogue(client, actors["admin_only"])
    assert mine != theirs

    ours = client.request(
        method, path.format(id=mine), headers=actors["plain"], json=body
    )
    assert ours.status_code != 404, f"own catalogue: {method} {path}"

    # 404 rather than 403, the way another account's project already answers:
    # whether it exists is not this caller's business either. Managing users
    # does not help — there is nothing left that reaches somebody else's
    # questions.
    for label in ("plain", "admin_only"):
        actor = actors[label]
        target = theirs if label == "plain" else mine
        refused = client.request(
            method, path.format(id=target), headers=actor, json=body
        )
        assert refused.status_code == 404, f"{label} reached {method} {path}"


def test_anybody_may_create_and_read_their_own_catalogues(actors, client):
    for headers in actors.values():
        assert client.get("/api/catalogues", headers=headers).status_code == 200
        created = client.post("/api/catalogues", headers=headers, json={"name": "mine"})
        assert created.status_code == 201, created.text


def test_the_catalogue_listing_shows_only_your_own(actors, client):
    mine = own_catalogue(client, actors["plain"])
    listed = client.get("/api/catalogues", headers=actors["plain"]).json()

    assert [one["id"] for one in listed] == [mine]


def test_bootstrapped_admin_manages_users_and_nothing_else(client, admin_headers):
    me = client.get("/api/me", headers=admin_headers).json()
    assert me["is_admin"] is True
    # The flag that used to sit beside it is gone entirely, not merely False.
    assert "is_editor" not in me


def test_self_service_is_never_gated(client, admin_headers):
    """A user with no flags manages their own password and catalogue."""
    user, headers = make_user(client, admin_headers, "selfservice")
    second = client.post(
        "/api/catalogues", headers=headers, json={"name": "another of mine"}
    ).json()

    changed = client.put(
        "/api/me/default-catalogue",
        headers=headers,
        json={"catalogue_id": second["id"]},
    )
    assert changed.status_code == 200
    assert changed.json()["default_catalogue_id"] == second["id"]

    response = client.put(
        "/api/me/password",
        headers=headers,
        json={"current_password": "user-password", "new_password": "brand-new-pass"},
    )
    assert response.status_code == 204
    assert (
        client.post(
            "/api/login", json={"username": "selfservice", "password": "user-password"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/login",
            json={"username": "selfservice", "password": "brand-new-pass"},
        ).status_code
        == 200
    )


def test_self_service_cannot_touch_other_accounts(client, admin_headers):
    other, _ = make_user(client, admin_headers, "victim")
    _, headers = make_user(client, admin_headers, "attacker")
    assert (
        client.put(
            f"/api/users/{other['id']}/password",
            headers=headers,
            json={"new_password": "hijacked-pass"},
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/users/{other['id']}", headers=headers, json={"is_admin": True}
        ).status_code
        == 403
    )


def test_wrong_current_password_is_rejected_even_for_admin(client, admin_headers):
    response = client.put(
        "/api/me/password",
        headers=admin_headers,
        json={"current_password": "not-it", "new_password": "irrelevant-pass"},
    )
    assert response.status_code == 403


def test_short_passwords_are_rejected_everywhere(client, admin_headers):
    assert (
        client.post(
            "/api/users",
            headers=admin_headers,
            json={"username": "x", "password": "abc"},
        ).status_code
        == 422
    )
    user, headers = make_user(client, admin_headers, "shorty")
    assert (
        client.put(
            f"/api/users/{user['id']}/password",
            headers=admin_headers,
            json={"new_password": "abc"},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/me/password",
            headers=headers,
            json={"current_password": "user-password", "new_password": "abc"},
        ).status_code
        == 422
    )


def test_admin_cannot_remove_their_own_admin_flag(client, admin_headers):
    """With one admin, self-demotion would lock user management out for good."""
    me = client.get("/api/me", headers=admin_headers).json()
    response = client.put(
        f"/api/users/{me['id']}", headers=admin_headers, json={"is_admin": False}
    )
    assert response.status_code == 409
    assert client.get("/api/users", headers=admin_headers).status_code == 200


def test_preferences_round_trip_and_are_not_gated(client, admin_headers):
    """Stats view state persists per user and needs no permission flag."""
    user, headers = make_user(client, admin_headers, "prefs")

    assert client.get("/api/me/preferences", headers=headers).json() == {}

    saved = client.put(
        "/api/me/preferences",
        headers=headers,
        json={"view": "radar", "chosen": ["q6", "weekday"], "windowDays": 30},
    )
    assert saved.status_code == 200
    assert client.get("/api/me/preferences", headers=headers).json() == {
        "view": "radar",
        "chosen": ["q6", "weekday"],
        "windowDays": 30,
    }
    # One user's view state must never leak into another's.
    assert client.get("/api/me/preferences", headers=admin_headers).json() == {}


def test_me_exposes_the_password_policy(client, admin_headers, monkeypatch):
    """Forms need the minimum length to check before spending a round trip."""
    me = client.get("/api/me", headers=admin_headers).json()
    assert me["password_min_length"] == 8
    # And it is the configured value, not a constant baked into the schema.
    from config import get_settings

    assert me["password_min_length"] == get_settings().password_min_length


def test_user_listing_does_not_carry_the_password_policy(client, admin_headers):
    """It is a server rule, not an attribute of each account."""
    users = client.get("/api/users", headers=admin_headers).json()
    assert users
    assert all("password_min_length" not in user for user in users)
