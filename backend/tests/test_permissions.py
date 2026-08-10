import pytest

from tests.conftest import make_user

USER_ROUTES = [
    ("GET", "/api/users", None),
    ("POST", "/api/users", {"username": "someone", "password": "abcdefgh"}),
    ("PUT", "/api/users/1", {"is_editor": True}),
    ("PUT", "/api/users/1/password", {"new_password": "abcdefgh"}),
    ("DELETE", "/api/users/1", None),
]

EDITOR_ROUTES = [
    ("POST", "/api/catalogues", {"name": "another"}),
    ("PUT", "/api/catalogues/1", {"name": "renamed"}),
    ("DELETE", "/api/catalogues/1", None),
    (
        "POST",
        "/api/catalogues/1/questions",
        {"kind": "discrete", "prompt": "x", "min_value": 1, "max_value": 5},
    ),
]


@pytest.fixture
def actors(client, admin_headers):
    """Return headers for the four permission combinations."""
    _, plain = make_user(client, admin_headers, "plain")
    _, admin_only = make_user(client, admin_headers, "adminonly", is_admin=True)
    _, editor_only = make_user(client, admin_headers, "editoronly", is_editor=True)
    _, both = make_user(
        client, admin_headers, "both", is_admin=True, is_editor=True
    )
    return {
        "plain": plain,
        "admin_only": admin_only,
        "editor_only": editor_only,
        "both": both,
    }


@pytest.mark.parametrize("method,path,body", USER_ROUTES)
def test_user_routes_need_admin_flag(actors, client, method, path, body):
    for label in ("plain", "editor_only"):
        response = client.request(method, path, headers=actors[label], json=body)
        assert response.status_code == 403, f"{label} {method} {path}"
    for label in ("admin_only", "both"):
        response = client.request(method, path, headers=actors[label], json=body)
        assert response.status_code != 403, f"{label} {method} {path}"


@pytest.mark.parametrize("method,path,body", EDITOR_ROUTES)
def test_catalogue_routes_need_editor_flag(actors, client, method, path, body):
    for label in ("plain", "admin_only"):
        response = client.request(method, path, headers=actors[label], json=body)
        assert response.status_code == 403, f"{label} {method} {path}"
    for label in ("editor_only", "both"):
        response = client.request(method, path, headers=actors[label], json=body)
        assert response.status_code != 403, f"{label} {method} {path}"


def test_reading_catalogues_needs_no_flag(actors, client, catalogue_id):
    for label, headers in actors.items():
        assert client.get("/api/catalogues", headers=headers).status_code == 200
        assert (
            client.get(f"/api/catalogues/{catalogue_id}", headers=headers).status_code
            == 200
        )


def test_bootstrapped_admin_holds_both_flags(client, admin_headers):
    me = client.get("/api/me", headers=admin_headers).json()
    assert me["is_admin"] is True
    assert me["is_editor"] is True


def test_self_service_is_never_gated(client, admin_headers, catalogue_id):
    """A user with neither flag manages their own password and catalogue."""
    user, headers = make_user(client, admin_headers, "selfservice")

    changed = client.put(
        "/api/me/default-catalogue",
        headers=headers,
        json={"catalogue_id": catalogue_id},
    )
    assert changed.status_code == 200
    assert changed.json()["default_catalogue_id"] == catalogue_id

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
            "/api/users", headers=admin_headers, json={"username": "x", "password": "abc"}
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
