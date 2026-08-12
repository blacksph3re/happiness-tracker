from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from passlib.context import CryptContext

from config import get_settings

ACCESS_TOKEN_TYPE = "access"
"""Value of the ``typ`` claim on tokens accepted as bearer credentials."""

REFRESH_TOKEN_TYPE = "refresh"
"""Value of the ``typ`` claim on tokens accepted only by the refresh endpoint."""

_pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


class TokenError(Exception):
    """Raised when a token is missing, malformed, expired or of the wrong type."""


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


def verify_password(password: str, password_hash: str) -> bool:
    """Check a plaintext password against a stored hash.

    Parameters
    ----------
    password : str
        The candidate plaintext password.
    password_hash : str
        The stored Argon2 hash.

    Returns
    -------
    bool
        True when the password matches.
    """
    try:
        return _pwd_context.verify(password, password_hash)
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
