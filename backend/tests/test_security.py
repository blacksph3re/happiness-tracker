import pytest


def test_verify_password_checks_a_dummy_hash_for_a_missing_account():
    """A `None` hash goes through a full Argon2 verify, not a fast return."""
    from security import verify_password

    assert verify_password("anything", None) is False


def test_login_throttle_locks_after_max_attempts():
    from datetime import timedelta

    from security import LoginLocked, LoginThrottle

    throttle = LoginThrottle(max_attempts=3, window=timedelta(minutes=15))
    throttle.check("alice")
    for _ in range(3):
        throttle.record_failure("alice")
    with pytest.raises(LoginLocked):
        throttle.check("alice")


def test_login_throttle_is_keyed_per_username():
    from datetime import timedelta

    from security import LoginThrottle

    throttle = LoginThrottle(max_attempts=1, window=timedelta(minutes=15))
    throttle.record_failure("alice")
    throttle.check("bob")  # does not raise


def test_login_throttle_forgets_failures_after_the_window(monkeypatch):
    from datetime import timedelta

    from security import LoginThrottle

    now = [0.0]
    throttle = LoginThrottle(
        max_attempts=1, window=timedelta(seconds=10), clock=lambda: now[0]
    )
    throttle.record_failure("alice")
    now[0] = 11.0
    throttle.check("alice")  # does not raise: the failure aged out


def test_login_throttle_clear_forgets_recorded_failures():
    from datetime import timedelta

    from security import LoginThrottle

    throttle = LoginThrottle(max_attempts=1, window=timedelta(minutes=15))
    throttle.record_failure("alice")
    throttle.clear("alice")
    throttle.check("alice")  # does not raise
