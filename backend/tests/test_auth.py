import logging
from datetime import timedelta

import pytest


PUBLIC_PATHS = {"/api/version", "/api/login", "/api/refresh"}
DOCS_PATHS = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

SAMPLE_BODIES = {
    ("PUT", "/api/me/password"): {"current_password": "x", "new_password": "abcdefgh"},
    ("PUT", "/api/me/default-catalogue"): {"catalogue_id": 1},
    ("POST", "/api/users"): {"username": "x", "password": "abcdefgh"},
    ("PUT", "/api/users/{user_id}"): {"is_admin": True},
    ("PUT", "/api/users/{user_id}/password"): {"new_password": "abcdefgh"},
    ("POST", "/api/catalogues"): {"name": "x"},
    ("PUT", "/api/catalogues/{catalogue_id}"): {"name": "x"},
    ("POST", "/api/catalogues/{catalogue_id}/questions"): {
        "kind": "discrete",
        "prompt": "x",
        "min_value": 1,
        "max_value": 5,
    },
    ("PUT", "/api/questions/{question_id}"): {"prompt": "x"},
    ("POST", "/api/questions/{question_id}/options"): {"label": "x"},
    ("PUT", "/api/answers"): {
        "day": "2026-01-01",
        "local_hour": 9,
        "question_id": 1,
        "value": 3,
    },
    ("DELETE", "/api/answers"): {"day": "2026-01-01", "question_id": 1},
}


def iter_api_routes(app):
    """Return every (method, path) the app exposes under /api.

    Read from the OpenAPI schema rather than from ``app.routes``, because
    FastAPI defers router inclusion and the internal route tree is not a stable
    place to enumerate endpoints.
    """
    schema = app.openapi()
    routes = []
    for path, operations in schema["paths"].items():
        if not path.startswith("/api"):
            continue
        for method in operations:
            if method.upper() in {"HEAD", "OPTIONS", "PARAMETERS"}:
                continue
            routes.append((method.upper(), path))
    return sorted(routes)


def concretise(path):
    """Substitute placeholder ids into a templated path."""
    return (
        path.replace("{user_id}", "1")
        .replace("{catalogue_id}", "1")
        .replace("{question_id}", "1")
        .replace("{option_id}", "1")
    )


def protected_calls(app):
    """Return (method, path, body) triples for every authenticated endpoint."""
    return [
        (method, concretise(path), SAMPLE_BODIES.get((method, path)))
        for method, path in iter_api_routes(app)
        if path not in PUBLIC_PATHS
    ]


def bad_tokens():
    """Return a labelled set of credentials that must never authenticate."""
    import security

    return {
        "missing": None,
        "malformed": "not-a-jwt",
        "expired": security.create_token(1, "access", timedelta(seconds=-10)),
        "wrong_key": __import__("jwt").encode(
            {"sub": "1", "typ": "access", "exp": 9999999999}, "another-secret"
        ),
        "refresh_as_access": security.create_token(
            1, "refresh", timedelta(minutes=5)
        ),
    }


def test_every_protected_endpoint_rejects_bad_credentials(client):
    import main

    calls = protected_calls(main.app)
    assert len(calls) >= 12, "route discovery found suspiciously few endpoints"

    failures = []
    for label, token in bad_tokens().items():
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        for method, path, body in calls:
            response = client.request(method, path, headers=headers, json=body)
            if response.status_code != 401:
                failures.append(f"{label}: {method} {path} -> {response.status_code}")
    assert not failures, failures


def test_token_for_deleted_user_is_rejected(client, admin_headers):
    from tests.conftest import make_user

    user, headers = make_user(client, admin_headers, "doomed")
    assert client.get("/api/me", headers=headers).status_code == 200
    assert client.delete(f"/api/users/{user['id']}", headers=admin_headers).status_code == 204
    assert client.get("/api/me", headers=headers).status_code == 401


def test_public_endpoint_list_is_exactly_three(client):
    import main

    public = set()
    for method, path in iter_api_routes(main.app):
        response = client.request(
            method, concretise(path), json=SAMPLE_BODIES.get((method, path))
        )
        if response.status_code != 401:
            public.add(path)
    assert public == PUBLIC_PATHS


def test_login_rejects_wrong_password_indistinguishably(client):
    unknown = client.post(
        "/api/login", json={"username": "nobody", "password": "whatever"}
    )
    wrong = client.post(
        "/api/login", json={"username": "admin", "password": "wrong-password"}
    )
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_password_never_appears_in_logs(client, caplog):
    secret = "extremely-secret-password"
    with caplog.at_level(logging.DEBUG):
        client.post("/api/login", json={"username": "admin", "password": secret})
    assert secret not in caplog.text


def test_refresh_returns_new_access_token(client):
    tokens = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    ).json()
    refreshed = client.post(
        "/api/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200
    headers = {"Authorization": f"Bearer {refreshed.json()['access_token']}"}
    assert client.get("/api/me", headers=headers).status_code == 200


def test_access_token_is_not_accepted_as_refresh_token(client):
    tokens = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    ).json()
    response = client.post(
        "/api/refresh", json={"refresh_token": tokens["access_token"]}
    )
    assert response.status_code == 401


def test_configured_ttls_are_honoured(client):
    import jwt as pyjwt

    from config import get_settings

    tokens = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    ).json()
    settings = get_settings()
    access = pyjwt.decode(
        tokens["access_token"], settings.signing_key, algorithms=["HS256"]
    )
    refresh = pyjwt.decode(
        tokens["refresh_token"], settings.signing_key, algorithms=["HS256"]
    )
    assert access["exp"] - access["iat"] == pytest.approx(
        settings.access_ttl.total_seconds(), abs=2
    )
    assert refresh["exp"] - refresh["iat"] == pytest.approx(
        settings.refresh_ttl.total_seconds(), abs=2
    )
