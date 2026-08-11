import json

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from deps import CurrentUser, DbSession
from models import Catalogue, User
from schemas import (
    AccessToken,
    MeOut,
    DefaultCatalogueChange,
    LoginRequest,
    PasswordChange,
    Preferences,
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

router = APIRouter()

APP_VERSION = "0.1.0"
"""Version reported by the public version endpoint."""


@router.get(
    "/version",
    response_model=Version,
    operation_id="getVersion",
    summary="Get the application version",
    description="Report the running application version. Public.",
    tags=["Auth"],
)
def version() -> Version:
    """Report the running application version.

    Returns
    -------
    Version
        The version payload. Public, requiring no authentication.
    """
    return Version(version=APP_VERSION)


@router.post(
    "/login",
    response_model=TokenPair,
    operation_id="login",
    summary="Sign in",
    description=(
        "Exchange a username and password for an access and a refresh token. "
        "Unknown usernames and wrong passwords are answered identically."
    ),
    tags=["Auth"],
)
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
    return TokenPair(**issue_tokens(user.id, user.token_version))


@router.post(
    "/refresh",
    response_model=AccessToken,
    operation_id="refreshAccessToken",
    summary="Renew an access token",
    description=(
        "Exchange a refresh token for a new access token. Access tokens are "
        "rejected here, and refresh tokens are rejected as bearer credentials."
    ),
    tags=["Auth"],
)
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
    if user is None or claims.get("ver", 0) != user.token_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    settings = get_settings()
    return AccessToken(
        access_token=create_token(
            user.id, ACCESS_TOKEN_TYPE, settings.access_ttl, user.token_version
        ),
        token_type="bearer",
        expires_in=int(settings.access_ttl.total_seconds()),
    )


@router.get(
    "/me",
    response_model=MeOut,
    operation_id="getCurrentUser",
    summary="Get my account",
    description=(
        "Return the signed-in account, without any password material, together "
        "with the password rules its own forms have to obey."
    ),
    tags=["Account"],
)
def read_me(user: CurrentUser) -> MeOut:
    """Return the authenticated user's own account and the password policy.

    The policy travels with the account so that a form can reject a too-short
    password before spending a round trip on it, without hardcoding a limit that
    the deployment is free to change.

    Parameters
    ----------
    user : User
        The authenticated user.

    Returns
    -------
    MeOut
        The account, serialised without password material, plus
        ``password_min_length``.
    """
    return MeOut(
        **UserOut.model_validate(user).model_dump(),
        password_min_length=get_settings().password_min_length,
    )


@router.put(
    "/me/password",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="changeMyPassword",
    summary="Change my password",
    description=(
        "Change the signed-in account's own password. Requires the current "
        "password, and is open to every user regardless of permission flags."
    ),
    tags=["Account"],
)
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
    # Everything issued under the old password stops working, including sessions
    # on other devices - which is the point of changing a leaked password.
    user.token_version += 1
    db.commit()


@router.get(
    "/me/preferences",
    response_model=Preferences,
    operation_id="getMyPreferences",
    summary="Get my saved view state",
    description=(
        "Return the stored UI preferences document, or an empty object when "
        "nothing has been saved. The backend does not interpret its contents."
    ),
    tags=["Account"],
)
def read_preferences(user: CurrentUser) -> Preferences:
    """Return the authenticated user's stored UI state.

    Parameters
    ----------
    user : User
        The authenticated user.

    Returns
    -------
    Preferences
        The stored document, or an empty one when nothing has been saved. A
        document that fails to parse is treated as absent rather than raising,
        so a bad write can never lock the user out of their own settings.
    """
    if not user.preferences:
        return Preferences()
    try:
        return Preferences(**json.loads(user.preferences))
    except (ValueError, TypeError):
        return Preferences()


@router.put(
    "/me/preferences",
    response_model=Preferences,
    operation_id="setMyPreferences",
    summary="Save my view state",
    description="Replace the stored UI preferences document.",
    tags=["Account"],
)
def write_preferences(
    payload: Preferences, user: CurrentUser, db: DbSession
) -> Preferences:
    """Replace the authenticated user's stored UI state.

    Open to every user regardless of their permission flags. The document is
    stored verbatim; the backend attaches no meaning to its contents.

    Parameters
    ----------
    payload : Preferences
        The document to store, replacing any previous one.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Preferences
        The document as stored.
    """
    user.preferences = payload.model_dump_json()
    db.commit()
    return payload


@router.put(
    "/me/default-catalogue",
    response_model=UserOut,
    operation_id="setMyDefaultCatalogue",
    summary="Choose my catalogue",
    description="Pick which catalogue the signed-in account answers each day.",
    tags=["Account"],
)
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
