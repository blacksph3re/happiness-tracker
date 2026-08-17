from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from database import get_db
from models import User
from security import ACCESS_TOKEN_TYPE, TokenError, decode_token

_bearer = HTTPBearer(auto_error=False)

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)
"""The single response used for every authentication failure.

Deliberately uniform so that a caller cannot tell a missing token from an
expired one, or a valid user from an unknown one.
"""


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Resolve the user behind the request's bearer token.

    The user is re-loaded on every request, so deleting an account, or changing
    its password, takes effect immediately even though the tokens themselves are
    stateless.

    Parameters
    ----------
    credentials : fastapi.security.HTTPAuthorizationCredentials or None
        Parsed ``Authorization`` header, if present.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    User
        The authenticated user.

    Raises
    ------
    fastapi.HTTPException
        With status 401 if the token is absent, malformed, expired, of the
        wrong type, names a user that no longer exists, or was minted before
        the account's password last changed.
    """
    if credentials is None or not credentials.credentials:
        raise CREDENTIALS_ERROR
    try:
        claims = decode_token(credentials.credentials, ACCESS_TOKEN_TYPE)
    except TokenError:
        raise CREDENTIALS_ERROR from None
    user = db.get(User, int(claims["sub"]))
    if user is None:
        raise CREDENTIALS_ERROR
    # A token minted before the last password change is no longer this account's.
    if claims.get("ver", 0) != user.token_version:
        raise CREDENTIALS_ERROR
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
"""Dependency yielding the authenticated user."""

DbSession = Annotated[Session, Depends(get_db)]
"""Dependency yielding a request-scoped database session."""


def require_admin(user: CurrentUser) -> User:
    """Require the user-management permission.

    Parameters
    ----------
    user : User
        The authenticated user.

    Returns
    -------
    User
        The same user, once the flag is confirmed.

    Raises
    ------
    fastapi.HTTPException
        With status 403 when the user does not hold `is_admin`.
    """
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin permission required"
        )
    return user


AdminUser = Annotated[User, Depends(require_admin)]
"""Dependency yielding the authenticated user, if they may manage users."""
