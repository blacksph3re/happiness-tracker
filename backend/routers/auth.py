from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from deps import CurrentUser, DbSession
from models import Catalogue, User
from schemas import (
    AccessToken,
    DefaultCatalogueChange,
    LoginRequest,
    PasswordChange,
    RefreshRequest,
    TokenPair,
    UserOut,
    Version,
)
from security import (
    ACCESS_TOKEN_TYPE,
    REFRESH_TOKEN_TYPE,
    TokenError,
    create_token,
    decode_token,
    hash_password,
    issue_tokens,
    verify_password,
)
from config import get_settings

router = APIRouter(tags=["auth"])

APP_VERSION = "0.1.0"
"""Version reported by the public version endpoint."""


@router.get("/version", response_model=Version)
def version() -> Version:
    """Report the running application version.

    Returns
    -------
    Version
        The version payload. Public, requiring no authentication.
    """
    return Version(version=APP_VERSION)


@router.post("/login", response_model=TokenPair)
def login(payload: LoginRequest, db: DbSession) -> TokenPair:
    """Exchange a username and password for an access and refresh token.

    Parameters
    ----------
    payload : LoginRequest
        Submitted credentials.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TokenPair
        The freshly minted tokens.

    Raises
    ------
    fastapi.HTTPException
        With status 401 when the credentials do not match. Unknown usernames
        and wrong passwords are answered identically so the endpoint cannot be
        used to enumerate accounts.
    """
    user = db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )
    return TokenPair(**issue_tokens(user.id))


@router.post("/refresh", response_model=AccessToken)
def refresh(payload: RefreshRequest, db: DbSession) -> AccessToken:
    """Exchange a refresh token for a new access token.

    Parameters
    ----------
    payload : RefreshRequest
        The refresh token issued at login.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    AccessToken
        A new bearer token and its lifetime.

    Raises
    ------
    fastapi.HTTPException
        With status 401 when the token is malformed, expired, an access token
        rather than a refresh token, or belongs to a deleted user.
    """
    try:
        claims = decode_token(payload.refresh_token, REFRESH_TOKEN_TYPE)
    except TokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        ) from None
    user = db.get(User, int(claims["sub"]))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    settings = get_settings()
    return AccessToken(
        access_token=create_token(user.id, ACCESS_TOKEN_TYPE, settings.access_ttl),
        token_type="bearer",
        expires_in=int(settings.access_ttl.total_seconds()),
    )


@router.get("/me", response_model=UserOut)
def read_me(user: CurrentUser) -> User:
    """Return the authenticated user's own account.

    Parameters
    ----------
    user : User
        The authenticated user.

    Returns
    -------
    User
        The same user, serialised without password material.
    """
    return user


@router.put("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_own_password(payload: PasswordChange, user: CurrentUser, db: DbSession) -> None:
    """Change the authenticated user's own password.

    Open to every user regardless of their permission flags, and always
    requiring the current password — an administrator resetting someone else's
    password uses the user-management route instead.

    Parameters
    ----------
    payload : PasswordChange
        The current and replacement passwords.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 403 when `current_password` does not match.
    """
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Current password is wrong"
        )
    user.password_hash = hash_password(payload.new_password)
    db.commit()


@router.put("/me/default-catalogue", response_model=UserOut)
def change_own_default_catalogue(
    payload: DefaultCatalogueChange, user: CurrentUser, db: DbSession
) -> User:
    """Choose which catalogue the authenticated user answers by default.

    Open to every user regardless of their permission flags.

    Parameters
    ----------
    payload : DefaultCatalogueChange
        The catalogue to switch to.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    User
        The updated user.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the catalogue does not exist.
    """
    if db.get(Catalogue, payload.catalogue_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Catalogue not found"
        )
    user.default_catalogue_id = payload.catalogue_id
    db.commit()
    db.refresh(user)
    return user
