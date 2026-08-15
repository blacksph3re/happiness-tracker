import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt
from passlib.context import CryptContext

from config import get_settings

ACCESS_TOKEN_TYPE = "access"
"""Value of the ``typ`` claim on tokens accepted as bearer credentials."""

REFRESH_TOKEN_TYPE = "refresh"
"""Value of the ``typ`` claim on tokens accepted only by the refresh endpoint."""

_pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

_DUMMY_PASSWORD_HASH = _pwd_context.hash("no account uses this password")
"""A real Argon2 hash that nothing will ever match.

Verifying a login for a username that does not exist against this costs the
same as verifying one for a real account, so the two cases cannot be told
apart by response time. Without it, a missing account would skip hashing
entirely and answer measurably faster than a wrong password for a real one.
"""


class TokenError(Exception):
    """Raised when a token is missing, malformed, expired or of the wrong type."""


class LoginLocked(Exception):
    """Raised when a username has failed to log in too many times recently."""


def hash_password(password: str) -> str:
    """Hash a plaintext password with Argon2.

    Parameters
    ----------
    password : str
        The plaintext password. Never logged and never stored.

    Returns
    -------
    str
        The encoded Argon2 hash, safe to persist.
    """
    return _pwd_context.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Check a plaintext password against a stored hash.

    Parameters
    ----------
    password : str
        The candidate plaintext password.
    password_hash : str or None
        The stored Argon2 hash, or None when no account was found. Checked
        against a fixed dummy hash instead of skipped, so a nonexistent
        username costs the same time as a wrong password for a real one.

    Returns
    -------
    bool
        True when the password matches. Always False when `password_hash` is
        None, since the dummy hash matches nothing.
    """
    try:
        return _pwd_context.verify(password, password_hash or _DUMMY_PASSWORD_HASH)
    except ValueError:
        return False


def create_token(
    subject: int, token_type: str, ttl: timedelta, token_version: int = 0
) -> str:
    """Mint a signed JSON Web Token for a user.

    Parameters
    ----------
    subject : int
        Identifier of the user the token authenticates.
    token_type : str
        Either `ACCESS_TOKEN_TYPE` or `REFRESH_TOKEN_TYPE`, written to the
        ``typ`` claim so the two can never substitute for one another.
    ttl : datetime.timedelta
        How long the token stays valid.
    token_version : int, optional
        The account's current token version, by default 0. A token whose
        version no longer matches the account is rejected.

    Returns
    -------
    str
        The encoded token.
    """
    settings = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(subject),
        "typ": token_type,
        "ver": token_version,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    return jwt.encode(payload, settings.signing_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    """Verify a token's signature, expiry and type.

    Parameters
    ----------
    token : str
        The encoded token.
    expected_type : str
        The ``typ`` claim the token must carry.

    Returns
    -------
    dict
        The decoded claims.

    Raises
    ------
    TokenError
        If the token is malformed, expired, signed with another key, or of a
        type other than `expected_type`.
    """
    settings = get_settings()
    try:
        claims = jwt.decode(
            token, settings.signing_key, algorithms=[settings.jwt_algorithm]
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != expected_type:
        raise TokenError("wrong token type")
    if not str(claims.get("sub", "")).isdigit():
        raise TokenError("missing subject")
    return claims


def issue_tokens(user_id: int, token_version: int = 0) -> dict[str, Any]:
    """Create the access and refresh token pair handed out at login.

    Parameters
    ----------
    user_id : int
        Identifier of the authenticated user.
    token_version : int, optional
        The account's current token version, by default 0.

    Returns
    -------
    dict
        A payload with ``access_token``, ``refresh_token``, ``token_type`` and
        ``expires_in`` (seconds until the access token expires).
    """
    settings = get_settings()
    return {
        "access_token": create_token(
            user_id, ACCESS_TOKEN_TYPE, settings.access_ttl, token_version
        ),
        "refresh_token": create_token(
            user_id, REFRESH_TOKEN_TYPE, settings.refresh_ttl, token_version
        ),
        "token_type": "bearer",
        "expires_in": int(settings.access_ttl.total_seconds()),
    }


class LoginThrottle:
    """A per-username sliding-window failed-login counter.

    Kept in process memory rather than the database: the deployment this app
    documents runs a single process, so there is no cross-worker state to
    reconcile, and a restart clearing the counters is an accepted trade-off
    against carrying login-attempt bookkeeping as persisted data. Keyed on the
    username exactly as submitted, whether or not an account by that name
    exists, so the lockout itself never reveals which usernames are real.
    """

    def __init__(
        self,
        max_attempts: int,
        window: timedelta,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Build a throttle enforcing `max_attempts` failures per `window`.

        Parameters
        ----------
        max_attempts : int
            Failures allowed for one username within `window` before `check`
            raises.
        window : datetime.timedelta
            How long a failure counts against a username.
        clock : Callable[[], float], optional
            Source of the current time, by default `time.monotonic`.
            Overridable in tests to age failures out without sleeping.
        """
        self._max_attempts = max_attempts
        self._window_seconds = window.total_seconds()
        self._clock = clock
        self._lock = threading.Lock()
        self._attempts: dict[str, list[float]] = {}

    def _recent(self, username: str, now: float) -> list[float]:
        """Return `username`'s recorded failure times still inside the window."""
        cutoff = now - self._window_seconds
        return [t for t in self._attempts.get(username, []) if t > cutoff]

    def check(self, username: str) -> None:
        """Raise if `username` has too many recent failures to try again.

        Parameters
        ----------
        username : str
            The username as submitted, not necessarily a real account.

        Raises
        ------
        LoginLocked
            If `max_attempts` failures were recorded within `window`.
        """
        now = self._clock()
        with self._lock:
            if len(self._recent(username, now)) >= self._max_attempts:
                raise LoginLocked(username)

    def record_failure(self, username: str) -> None:
        """Record one failed login attempt for `username`."""
        now = self._clock()
        with self._lock:
            self._attempts[username] = [*self._recent(username, now), now]

    def clear(self, username: str) -> None:
        """Forget any recorded failures for `username`, after a success."""
        with self._lock:
            self._attempts.pop(username, None)


@lru_cache
def get_login_throttle() -> LoginThrottle:
    """Return the process-wide login throttle, built from settings.

    Returns
    -------
    LoginThrottle
        Cached for the lifetime of the process, the same way `get_settings`
        is, so every request shares one counter.
    """
    settings = get_settings()
    return LoginThrottle(
        max_attempts=settings.login_max_attempts,
        window=settings.login_lockout_window_delta,
    )
