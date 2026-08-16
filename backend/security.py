import secrets
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import jwt
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from passlib.context import CryptContext

from config import get_settings
from models import User

ACCESS_TOKEN_TYPE = "access"
"""Value of the ``typ`` claim on tokens accepted as bearer credentials."""

REFRESH_TOKEN_TYPE = "refresh"
"""Value of the ``typ`` claim on tokens accepted only by the refresh endpoint."""

TOTP_TOKEN_TYPE = "totp"
"""Value of the ``typ`` claim on tokens that authorise one thing: presenting a
second factor.

A third type rather than a reused access token, and the distinction is what
makes the two-step login safe: `decode_token` already refuses a token whose type
is not the one asked for, so a half-finished login cannot be spent as a bearer
credential and a bearer credential cannot be spent to skip the second step."""

TOTP_TOKEN_TTL = timedelta(minutes=5)
"""How long a challenge stays answerable. Long enough to find a phone, short
enough that the token is worthless by the time anybody could misuse it."""

TOTP_SKEW_STEPS = 1
"""Steps either side of now that a code is accepted for.

One step is 30 seconds of tolerance for a phone whose clock has drifted. Wider
multiplies the codes valid at any moment, which is a real weakening; narrower
turns ordinary clock drift into a locked account."""

TOTP_ISSUER = "Daily Tracker"
"""Name shown beside the account in an authenticator app."""

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


@lru_cache
def _cipher() -> Fernet:
    """Return the cipher protecting stored TOTP secrets.

    Returns
    -------
    cryptography.fernet.Fernet
        Built from `TOTP_ENCRYPTION_KEY`, cached for the process the same way
        the settings are.

    Raises
    ------
    RuntimeError
        If the key is unset or is not a valid Fernet key.
    """
    try:
        return Fernet(get_settings().totp_key.encode())
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "TOTP_ENCRYPTION_KEY is not a valid Fernet key. Generate one with "
            "`python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'`."
        ) from exc


def new_totp_secret() -> str:
    """Generate a fresh base32 shared secret.

    Returns
    -------
    str
        A random secret, in the form an authenticator app expects.
    """
    return pyotp.random_base32()


def seal_totp_secret(secret: str) -> str:
    """Encrypt a shared secret for storage.

    Encrypted rather than hashed, unlike a password: verifying a code means
    computing the expected one, which needs the plaintext back.

    Parameters
    ----------
    secret : str
        The base32 secret.

    Returns
    -------
    str
        A Fernet token, safe to persist.
    """
    return _cipher().encrypt(secret.encode()).decode()


def open_totp_secret(sealed: str | None) -> str | None:
    """Recover a stored shared secret.

    Parameters
    ----------
    sealed : str or None
        The stored Fernet token, or None when enrolment never began.

    Returns
    -------
    str or None
        The base32 secret, or None when there is nothing stored or the stored
        value cannot be decrypted with the current key — which is what a
        rotated `TOTP_ENCRYPTION_KEY` looks like from here. Reported as "no
        second factor" rather than as a crash, so a rotated key locks nobody
        out of anything except their own enrolment.
    """
    if not sealed:
        return None
    try:
        return _cipher().decrypt(sealed.encode()).decode()
    except InvalidToken:
        return None


def totp_uri(secret: str, username: str) -> str:
    """Build the `otpauth://` URI an authenticator app scans.

    Parameters
    ----------
    secret : str
        The base32 shared secret.
    username : str
        The account name shown in the app.

    Returns
    -------
    str
        The provisioning URI.
    """
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=TOTP_ISSUER)


def verify_totp(secret: str, code: str, last_step: int | None) -> int | None:
    """Check a code, and report which time-step it belongs to.

    Parameters
    ----------
    secret : str
        The base32 shared secret.
    code : str
        The six digits submitted.
    last_step : int or None
        The highest step already spent on this account, or None when no code
        has been accepted yet.

    Returns
    -------
    int or None
        The step the code belongs to, which the caller must store; or None
        when the code is wrong, already spent, or from a step already passed.

    Notes
    -----
    A code stays valid for its whole 30-second step, so anyone who observes one
    can present it again inside that window. Refusing any step at or below the
    last one accepted makes each code strictly single-use — and refuses an
    *earlier* step too, which matters because the skew window means two
    different codes can be valid at the same moment.
    """
    totp = pyotp.TOTP(secret)
    now = int(time.time())
    for offset in range(-TOTP_SKEW_STEPS, TOTP_SKEW_STEPS + 1):
        at = now + offset * totp.interval
        step = at // totp.interval
        if last_step is not None and step <= last_step:
            continue
        if secrets.compare_digest(totp.at(at), code):
            return int(step)
    return None


def clear_totp(user: User) -> None:
    """Strip a second factor from an account and sign its sessions out.

    Every field goes, not only the confirmation: leaving the secret behind
    would let a later `confirm` turn the same one back on without the person
    who owns the account ever scanning it again.

    The token version is bumped with it, on the theory that the reason a second
    factor is coming off might be that something is wrong. It also means an
    administrator quietly stripping somebody's second factor reaches them as an
    unexpected logout rather than as nothing at all.

    Parameters
    ----------
    user : models.User
        The account to clear. Not committed here.
    """
    user.totp_secret = None
    user.totp_confirmed_at = None
    user.totp_last_step = None
    user.token_version += 1
