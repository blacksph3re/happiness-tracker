import sqlite3
from datetime import UTC, datetime, timedelta

import pyotp
import pytest

from .conftest import build_client, make_user


@pytest.fixture
def enrolled(client, admin_headers):
    """Return the admin's confirmed TOTP secret, having gone through enrolment."""
    started = client.post("/api/me/totp", headers=admin_headers)
    assert started.status_code == 200, started.text
    secret = started.json()["secret"]

    # Confirmed with the previous step's code, which is what a phone running a
    # little slow shows. That leaves the current step unspent, so the tests
    # below can sign in with `now()` — confirming burns the step it uses, on
    # purpose, and a code is never good twice.
    confirmed = client.post(
        "/api/me/totp/confirm",
        json={"code": code_at(secret, -1)},
        headers=admin_headers,
    )
    assert confirmed.status_code == 204, confirmed.text
    return secret


def sign_in(client, username="admin", password="admin-password"):
    """Post credentials and return the response."""
    return client.post("/api/login", json={"username": username, "password": password})


def code_at(secret, offset_steps=0):
    """Return a valid code for the step `offset_steps` away from now."""
    return pyotp.TOTP(secret).at(
        datetime.now(UTC) + timedelta(seconds=30 * offset_steps)
    )


def test_login_without_enrolment_is_unchanged(client):
    body = sign_in(client).json()

    assert body["status"] == "complete"
    assert body["access_token"]
    assert body["totp_token"] is None


def test_a_secret_generated_but_never_confirmed_does_not_gate_login(
    client, admin_headers
):
    # The bug the confirmed_at split exists to prevent: generating a QR code and
    # then closing the tab must not lock somebody out of their own account.
    started = client.post("/api/me/totp", headers=admin_headers)
    assert started.status_code == 200

    body = sign_in(client).json()

    assert body["status"] == "complete"
    assert body["access_token"]


def test_enrolment_needs_a_correct_code_to_confirm(client, admin_headers):
    client.post("/api/me/totp", headers=admin_headers)

    refused = client.post(
        "/api/me/totp/confirm", json={"code": "000000"}, headers=admin_headers
    )

    assert refused.status_code == 400
    # And the account is still not gated, because nothing was proven.
    assert sign_in(client).json()["status"] == "complete"


def test_confirming_without_starting_is_refused(client, admin_headers):
    refused = client.post(
        "/api/me/totp/confirm", json={"code": "000000"}, headers=admin_headers
    )

    assert refused.status_code == 400


def test_an_enrolled_account_is_challenged_and_completes(client, enrolled):
    first = sign_in(client).json()
    assert first["status"] == "totp_required"
    assert first["access_token"] is None
    assert first["totp_token"]

    second = client.post(
        "/api/login/totp",
        json={"totp_token": first["totp_token"], "code": pyotp.TOTP(enrolled).now()},
    )

    assert second.status_code == 200
    assert second.json()["access_token"]


def test_me_reports_whether_a_second_factor_is_on(client, admin_headers, enrolled):
    body = client.get("/api/me", headers=admin_headers).json()

    assert body["totp_enabled"] is True


def test_a_totp_token_is_not_a_bearer_credential(client, enrolled):
    handed_out = sign_in(client).json()["totp_token"]

    refused = client.get("/api/me", headers={"Authorization": f"Bearer {handed_out}"})

    assert refused.status_code == 401


def test_an_access_token_cannot_be_spent_at_the_totp_step(
    client, admin_token, enrolled
):
    refused = client.post(
        "/api/login/totp",
        json={"totp_token": admin_token, "code": pyotp.TOTP(enrolled).now()},
    )

    assert refused.status_code == 401


def test_a_code_cannot_be_replayed_inside_its_own_window(client, enrolled):
    code = pyotp.TOTP(enrolled).now()

    first = client.post(
        "/api/login/totp",
        json={"totp_token": sign_in(client).json()["totp_token"], "code": code},
    )
    second = client.post(
        "/api/login/totp",
        json={"totp_token": sign_in(client).json()["totp_token"], "code": code},
    )

    assert first.status_code == 200
    assert second.status_code == 401


def test_a_code_from_the_next_step_is_accepted(client, enrolled):
    # The phone a little fast, rather than a little slow. Asserted over HTTP as
    # well as in the unit tests below, because the two have to agree on which
    # steps count as now.
    answered = client.post(
        "/api/login/totp",
        json={
            "totp_token": sign_in(client).json()["totp_token"],
            "code": code_at(enrolled, 1),
        },
    )

    assert answered.status_code == 200


def test_bad_codes_share_the_password_budget(client, enrolled):
    # Four wrong passwords and one wrong code is five failures, not four and
    # one: an attacker holding the password must not get a fresh allowance by
    # moving on to the second step.
    for _ in range(4):
        assert sign_in(client, password="wrong").status_code == 401

    token = sign_in(client).json()["totp_token"]
    spent = client.post("/api/login/totp", json={"totp_token": token, "code": "000000"})
    assert spent.status_code == 401

    locked = sign_in(client)
    assert locked.status_code == 429


def test_a_correct_code_clears_the_failures(client, enrolled):
    for _ in range(3):
        assert sign_in(client, password="wrong").status_code == 401

    token = sign_in(client).json()["totp_token"]
    done = client.post(
        "/api/login/totp",
        json={"totp_token": token, "code": pyotp.TOTP(enrolled).now()},
    )
    assert done.status_code == 200

    # The budget is back: three more failures do not lock the account.
    for _ in range(3):
        assert sign_in(client, password="wrong").status_code == 401
    assert sign_in(client).status_code == 200


def test_refresh_never_challenges_an_enrolled_account(client, enrolled):
    tokens = client.post(
        "/api/login/totp",
        json={
            "totp_token": sign_in(client).json()["totp_token"],
            "code": pyotp.TOTP(enrolled).now(),
        },
    ).json()

    renewed = client.post(
        "/api/refresh", json={"refresh_token": tokens["refresh_token"]}
    )

    assert renewed.status_code == 200
    assert renewed.json()["access_token"]


def test_disabling_needs_a_current_code(client, admin_headers, enrolled):
    refused = client.request(
        "DELETE", "/api/me/totp", json={"code": "000000"}, headers=admin_headers
    )

    assert refused.status_code == 400
    assert sign_in(client).json()["status"] == "totp_required"


def test_disabling_signs_other_sessions_out(client, admin_headers, enrolled):
    removed = client.request(
        "DELETE",
        "/api/me/totp",
        json={"code": pyotp.TOTP(enrolled).now()},
        headers=admin_headers,
    )
    assert removed.status_code == 204

    # The reason for turning it off may be that something is wrong, so every
    # other session goes with it — including the one that asked.
    assert client.get("/api/me", headers=admin_headers).status_code == 401
    assert sign_in(client).json()["status"] == "complete"


def test_an_admin_clears_someone_elses_and_they_log_in_with_the_password_alone(
    client, admin_headers
):
    theirs, headers = make_user(client, admin_headers, "forgetful")
    secret = client.post("/api/me/totp", headers=headers).json()["secret"]
    client.post(
        "/api/me/totp/confirm",
        json={"code": code_at(secret, -1)},
        headers=headers,
    )
    assert (
        sign_in(client, "forgetful", "user-password").json()["status"]
        == "totp_required"
    )

    cleared = client.delete(f"/api/users/{theirs['id']}/totp", headers=admin_headers)

    assert cleared.status_code == 204
    body = sign_in(client, "forgetful", "user-password").json()
    assert body["status"] == "complete"
    assert body["access_token"]
    # And a second factor stripped from underneath somebody reaches them as an
    # unexpected logout rather than as nothing at all.
    assert client.get("/api/me", headers=headers).status_code == 401


def test_only_a_user_manager_may_clear_someone_elses(client, admin_headers):
    _, ordinary = make_user(client, admin_headers, "ordinary")
    victim, _ = make_user(client, admin_headers, "victim")

    refused = client.delete(f"/api/users/{victim['id']}/totp", headers=ordinary)

    assert refused.status_code == 403


def test_the_stored_secret_is_not_readable_from_the_database(
    tmp_path, monkeypatch, request
):
    # Configured to encrypt is not the same as encrypting. This reads the file
    # the way anyone with the disk would.
    generator = build_client(tmp_path, monkeypatch, {})
    client = next(generator)
    headers = {
        "Authorization": "Bearer "
        + client.post(
            "/api/login", json={"username": "admin", "password": "admin-password"}
        ).json()["access_token"]
    }
    secret = client.post("/api/me/totp", headers=headers).json()["secret"]

    stored = (
        sqlite3.connect(tmp_path / "test.db")
        .execute("SELECT totp_secret FROM users WHERE username = 'admin'")
        .fetchone()[0]
    )

    assert stored
    assert secret not in stored
    request.addfinalizer(lambda: next(generator, None))


# The skew window and the replay guard, at the level they are decided. Driven
# directly rather than over HTTP: both are statements about which time-steps
# count, and a test that has to guess where the clock is when it runs would be
# asserting the answer some of the time and the boundary the rest of it.


def _step_now():
    """Return the time-step the current moment falls in."""
    return int(datetime.now(UTC).timestamp()) // 30


def test_a_code_from_either_adjacent_step_is_accepted():
    from security import verify_totp

    secret = pyotp.random_base32()

    assert verify_totp(secret, code_at(secret, -1), None) == _step_now() - 1
    assert verify_totp(secret, code_at(secret, 0), None) == _step_now()
    assert verify_totp(secret, code_at(secret, 1), None) == _step_now() + 1


def test_two_steps_away_is_not_accepted():
    # Ninety seconds of slack is a real weakening, not tolerance: it triples
    # the codes valid at any one moment.
    from security import verify_totp

    secret = pyotp.random_base32()

    assert verify_totp(secret, code_at(secret, -2), None) is None
    assert verify_totp(secret, code_at(secret, 2), None) is None


def test_a_step_already_spent_is_refused_even_though_the_code_is_right():
    from security import verify_totp

    secret = pyotp.random_base32()
    spent = _step_now()

    assert verify_totp(secret, code_at(secret, 0), spent) is None
    # And so is the one before it, which the skew window would otherwise still
    # be offering: two codes are valid at once, and both have to go.
    assert verify_totp(secret, code_at(secret, -1), spent) is None
    # The next one is fine, which is what stops the guard being a lockout.
    assert verify_totp(secret, code_at(secret, 1), spent) == spent + 1


def test_a_wrong_code_is_refused_whatever_has_been_spent():
    from security import verify_totp

    secret = pyotp.random_base32()

    assert verify_totp(secret, "000000", None) is None


def test_a_sealed_secret_survives_the_round_trip_and_a_rotated_key_does_not():
    from security import open_totp_secret, seal_totp_secret

    secret = pyotp.random_base32()
    sealed = seal_totp_secret(secret)

    assert sealed != secret
    assert open_totp_secret(sealed) == secret
    # A key that no longer opens it reads as "no second factor" rather than as
    # a crash: rotating the key locks nobody out of anything but their own
    # enrolment, which they can simply do again.
    assert open_totp_secret("not-a-fernet-token") is None
    assert open_totp_secret(None) is None
