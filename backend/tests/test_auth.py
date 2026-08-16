import logging
from datetime import timedelta

import pytest

PUBLIC_PATHS = {"/api/version", "/api/login", "/api/refresh", "/api/login/totp"}
"""Every endpoint reachable without a bearer token.

Deliberately a literal list rather than something derived: adding to it is the
kind of change that should have to be typed out on purpose. `/api/login/totp`
is here because a second factor is presented *before* there is a session to
present it with — it is authorised by the short-lived token the password step
handed out, and refuses everything else.

Note what keeps this test able to tell public from protected: an endpoint that
answers 401 to bad *credentials in the body* looks exactly like one demanding a
bearer token. Both login steps are therefore called with no body at all, so they
answer 422 and are counted as reachable. That is why neither appears in
`SAMPLE_BODIES`."""
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


def test_docs_are_not_routed_without_the_env_var(client):
    import main

    routed = {getattr(route, "path", None) for route in main.app.routes}
    assert routed.isdisjoint(DOCS_PATHS)


# Asserted on the body rather than the status code because the SPA is mounted at
# "/" and answers an unknown path with index.html, so a disabled /docs is a 200
# rather than a 404 - and only when `backend/static` has been built, which is
# gitignored and therefore absent in a fresh clone. The marker strings hold
# either way.
def test_docs_are_not_served_without_the_env_var(client):
    assert '"openapi"' not in client.get("/openapi.json").text
    assert "swagger-ui" not in client.get("/docs").text.lower()
    assert "redoc" not in client.get("/redoc").text.lower()


def test_docs_are_served_when_the_env_var_is_set(docs_client):
    assert '"openapi"' in docs_client.get("/openapi.json").text
    assert "swagger-ui" in docs_client.get("/docs").text.lower()
    assert "redoc" in docs_client.get("/redoc").text.lower()


def test_the_schema_is_still_generated_for_codegen_when_docs_are_off(client):
    # `pnpm api:generate` calls app.openapi() directly rather than fetching the
    # endpoint, so switching the route off must not switch codegen off with it.
    import main

    assert "/api/login" in main.app.openapi()["paths"]


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
    deleted = client.delete(f"/api/users/{user['id']}", headers=admin_headers)
    assert deleted.status_code == 204
    assert client.get("/api/me", headers=headers).status_code == 401


def test_the_public_endpoints_are_exactly_the_listed_ones(client):
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


def test_login_hashes_even_for_an_unknown_username(client, monkeypatch):
    """Pins the code path rather than a wall-clock budget.

    The old code skipped hashing entirely when the username did not exist,
    which is what made a nonexistent username measurably faster to reject
    than a real one with a wrong password. A timing assertion in CI would be
    flaky, so this checks that `verify_password` still ran instead.
    """
    calls = []
    real_verify = __import__("security").verify_password

    def spy(password, password_hash):
        calls.append(password_hash)
        return real_verify(password, password_hash)

    monkeypatch.setattr("routers.auth.verify_password", spy)

    client.post("/api/login", json={"username": "nobody-at-all", "password": "x"})
    assert calls == [None]


def test_repeated_failures_lock_out_the_username(client):
    for _ in range(5):
        response = client.post(
            "/api/login", json={"username": "admin", "password": "wrong"}
        )
        assert response.status_code == 401
    locked = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    )
    assert locked.status_code == 429


def test_a_successful_login_resets_the_failure_count(client):
    for _ in range(4):
        client.post("/api/login", json={"username": "admin", "password": "wrong"})
    ok = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    )
    assert ok.status_code == 200

    for _ in range(4):
        response = client.post(
            "/api/login", json={"username": "admin", "password": "wrong"}
        )
        assert response.status_code == 401
    still_ok = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    )
    assert still_ok.status_code == 200


def test_lockout_applies_to_unknown_usernames_too(client):
    """Keyed on the submitted username, not on whether an account exists."""
    for _ in range(5):
        client.post("/api/login", json={"username": "nobody", "password": "x"})
    locked = client.post("/api/login", json={"username": "nobody", "password": "x"})
    assert locked.status_code == 429


def test_lockout_response_does_not_reveal_account_existence(client):
    for _ in range(5):
        client.post("/api/login", json={"username": "admin", "password": "wrong"})
    real_locked = client.post(
        "/api/login", json={"username": "admin", "password": "wrong"}
    )

    for _ in range(5):
        client.post("/api/login", json={"username": "nobody", "password": "wrong"})
    fake_locked = client.post(
        "/api/login", json={"username": "nobody", "password": "wrong"}
    )

    assert real_locked.status_code == fake_locked.status_code == 429
    assert real_locked.json() == fake_locked.json()


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


def test_changing_a_password_invalidates_outstanding_tokens(client, admin_headers):
    """A leaked token must not outlive the password it was issued under."""
    assert client.get("/api/me", headers=admin_headers).status_code == 200
    tokens = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    ).json()

    changed = client.put(
        "/api/me/password",
        headers=admin_headers,
        json={"current_password": "admin-password", "new_password": "a-new-password"},
    )
    assert changed.status_code == 204

    # Both halves of the old session are dead, on this device and any other.
    assert client.get("/api/me", headers=admin_headers).status_code == 401
    assert (
        client.post(
            "/api/refresh", json={"refresh_token": tokens["refresh_token"]}
        ).status_code
        == 401
    )

    # A fresh login works and its token is accepted.
    fresh = client.post(
        "/api/login", json={"username": "admin", "password": "a-new-password"}
    ).json()
    assert (
        client.get(
            "/api/me", headers={"Authorization": f"Bearer {fresh['access_token']}"}
        ).status_code
        == 200
    )


def test_an_admin_reset_ends_the_other_account_s_sessions(client, admin_headers):
    """A reset exists to lock someone out, so their tokens must stop working."""
    from tests.conftest import make_user

    user, headers = make_user(client, admin_headers, "resettable")
    assert client.get("/api/me", headers=headers).status_code == 200

    client.put(
        f"/api/users/{user['id']}",
        headers=admin_headers,
        json={},
    )
    reset = client.put(
        f"/api/users/{user['id']}/password",
        headers=admin_headers,
        json={"new_password": "chosen-by-the-admin"},
    )
    assert reset.status_code == 204
    assert client.get("/api/me", headers=headers).status_code == 401


def test_a_forged_token_version_is_rejected(client):
    """The version is signed, so it cannot simply be edited by the holder."""
    import jwt as pyjwt

    from config import get_settings

    settings = get_settings()
    forged = pyjwt.encode(
        {"sub": "1", "typ": "access", "ver": 99, "exp": 9999999999},
        settings.signing_key,
        algorithm="HS256",
    )
    assert (
        client.get("/api/me", headers={"Authorization": f"Bearer {forged}"}).status_code
        == 401
    )


def test_oversized_preferences_are_refused(client, admin_headers):
    """The document is opaque to the server, but it is not unbounded."""
    from schemas import PREFERENCES_MAX_BYTES

    too_big = client.put(
        "/api/me/preferences",
        headers=admin_headers,
        json={"junk": "A" * (PREFERENCES_MAX_BYTES + 1)},
    )
    assert too_big.status_code == 422

    fits = client.put(
        "/api/me/preferences", headers=admin_headers, json={"view": "line"}
    )
    assert fits.status_code == 200
    assert client.get("/api/me/preferences", headers=admin_headers).json() == {
        "view": "line"
    }


# The two below are a pair, and the order matters. The suite shares one
# application between tests and swaps the database under it, which is worth
# about forty seconds — and which is only safe while every piece of
# process-wide state is reset in between. These make a leak fail here, loudly,
# rather than somewhere else as a test that quietly stopped testing anything.


def test_a_test_may_leave_the_world_dirty(client, admin_headers):
    """Fill the failure budget, enrol a factor, and leave both behind."""
    import pyotp

    started = client.post("/api/me/totp", headers=admin_headers)
    secret = started.json()["secret"]
    client.post(
        "/api/me/totp/confirm",
        json={"code": pyotp.TOTP(secret).at(__import__("time").time() - 30)},
        headers=admin_headers,
    )
    for _ in range(5):
        client.post("/api/login", json={"username": "admin", "password": "wrong"})

    assert (
        client.post(
            "/api/login", json={"username": "admin", "password": "admin-password"}
        ).status_code
        == 429
    )


def test_and_the_next_one_finds_it_clean(client):
    body = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    )

    # Not 429: the login throttle is per process, and a stale one would spend
    # this test's budget on the last test's guesses.
    assert body.status_code == 200
    # Not `totp_required`: the database is this test's own, and an enrolment
    # from the test above would mean they are sharing one.
    assert body.json()["status"] == "complete"
