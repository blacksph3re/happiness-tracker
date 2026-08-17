import json
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from config import get_settings
from deps import CurrentUser, DbSession
from models import Catalogue, User
from schemas import (
    AccessToken,
    DefaultCatalogueChange,
    LoginRequest,
    LoginResult,
    MeOut,
    PasswordChange,
    Preferences,
    RefreshRequest,
    TokenPair,
    TotpChallenge,
    TotpCode,
    TotpEnrolment,
    UserOut,
    Version,
)
from security import (
    ACCESS_TOKEN_TYPE,
    REFRESH_TOKEN_TYPE,
    TOTP_TOKEN_TTL,
    TOTP_TOKEN_TYPE,
    LoginLocked,
    TokenError,
    clear_totp,
    create_token,
    decode_token,
    get_login_throttle,
    hash_password,
    issue_tokens,
    new_totp_secret,
    open_totp_secret,
    seal_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)

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
    response_model=LoginResult,
    operation_id="login",
    summary="Sign in",
    description=(
        "Exchange a username and password for tokens, or - when the account "
        "carries a second factor - for a short-lived token to present one "
        "with. Unknown usernames and wrong passwords are answered identically, "
        "and take the same time to answer. Too many failures for one username "
        "within the lockout window are refused with `429` until it passes."
    ),
    tags=["Auth"],
)
def login(payload: LoginRequest, db: DbSession) -> LoginResult:
    """Exchange a username and password for tokens, or for a challenge.

    Parameters
    ----------
    payload : LoginRequest
        Submitted credentials.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    LoginResult
        The tokens, or `totp_required` and a token to answer the challenge
        with.

    Raises
    ------
    fastapi.HTTPException
        With status 401 when the credentials do not match, or 429 when the
        submitted username has failed too many times recently. Unknown
        usernames and wrong passwords are answered identically, and the
        lockout is keyed on the submitted username regardless of whether an
        account exists, so neither response can be used to enumerate
        accounts.
    """
    throttle = get_login_throttle()
    try:
        throttle.check(payload.username)
    except LoginLocked:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Try again later.",
        ) from None

    user = db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none()
    # Always hashes, even for a username that does not exist: skipping it
    # would answer a nonexistent username measurably faster than a wrong
    # password for a real one.
    valid = verify_password(payload.password, user.password_hash if user else None)
    if user is None or not valid:
        throttle.record_failure(payload.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )

    # Confirmed, not merely present. A secret written when somebody opened the
    # enrolment page and then closed the tab would otherwise lock them out of
    # their own account with a code they never scanned.
    if user.totp_confirmed_at is not None:
        # The failure budget is deliberately *not* cleared here: the login is
        # not finished, and clearing it would hand an attacker who has the
        # password a fresh allowance to guess codes with.
        return LoginResult(
            status="totp_required",
            totp_token=create_token(
                user.id, TOTP_TOKEN_TYPE, TOTP_TOKEN_TTL, user.token_version
            ),
        )

    throttle.clear(payload.username)
    return LoginResult(status="complete", **issue_tokens(user.id, user.token_version))


@router.post(
    "/login/totp",
    response_model=TokenPair,
    operation_id="loginTotp",
    summary="Present a second factor",
    description=(
        "Complete a login by presenting a code from the enrolled "
        "authenticator. Takes the short-lived token the password step handed "
        "out; an access token is refused here. Wrong codes count against the "
        "same per-username budget as wrong passwords."
    ),
    tags=["Auth"],
)
def login_totp(payload: TotpChallenge, db: DbSession) -> TokenPair:
    """Complete a login by presenting a code.

    Parameters
    ----------
    payload : TotpChallenge
        The token from the password step and the digits from the app.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TokenPair
        The freshly minted tokens.

    Raises
    ------
    fastapi.HTTPException
        With status 401 when the token or the code is not good, or 429 when
        the account has failed too many times recently.
    """
    try:
        claims = decode_token(payload.totp_token, TOTP_TOKEN_TYPE)
    except TokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        ) from None

    user = db.get(User, int(claims["sub"]))
    if user is None or claims.get("ver", 0) != user.token_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )

    throttle = get_login_throttle()
    try:
        throttle.check(user.username)
    except LoginLocked:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Try again later.",
        ) from None

    secret = open_totp_secret(user.totp_secret)
    step = (
        verify_totp(secret, payload.code, user.totp_last_step)
        if secret and user.totp_confirmed_at is not None
        else None
    )
    if step is None:
        # Into the same bucket as a wrong password, deliberately: five guesses
        # per fifteen minutes against a million is not an attack, and an
        # attacker holding the password gets no fresh allowance by reaching
        # this step.
        throttle.record_failure(user.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )

    user.totp_last_step = step
    db.commit()
    throttle.clear(user.username)
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
        totp_enabled=user.totp_confirmed_at is not None,
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
def change_own_password(
    payload: PasswordChange, user: CurrentUser, db: DbSession
) -> None:
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
    except ValueError, TypeError:
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
        With status 404 when the catalogue does not exist or is not theirs.
    """
    catalogue = db.get(Catalogue, payload.catalogue_id)
    # Ownership, not merely existence: a catalogue belongs to somebody, and
    # answering out of another account's questions is not a thing to offer even
    # to the person asking for it.
    if catalogue is None or catalogue.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Catalogue not found"
        )
    user.default_catalogue_id = payload.catalogue_id
    db.commit()
    db.refresh(user)
    return user


@router.post(
    "/me/totp",
    response_model=TotpEnrolment,
    operation_id="beginTotpEnrolment",
    summary="Begin enrolling a second factor",
    description=(
        "Generate a shared secret and the URI an authenticator app scans. "
        "Nothing is demanded at login until the enrolment is confirmed, so "
        "abandoning this page cannot lock anybody out. Calling it again "
        "replaces an unconfirmed secret."
    ),
    tags=["Account"],
)
def begin_totp(user: CurrentUser, db: DbSession) -> TotpEnrolment:
    """Start enrolling a second factor for the signed-in account.

    Parameters
    ----------
    user : models.User
        The signed-in account.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TotpEnrolment
        The secret and the provisioning URI.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when a confirmed second factor is already in force.
        Replacing one without proving possession of the current device would
        make the whole thing a formality.
    """
    if user.totp_confirmed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A second factor is already enrolled. Remove it first.",
        )

    secret = new_totp_secret()
    user.totp_secret = seal_totp_secret(secret)
    # Cleared with the secret: the spent steps belong to the old one, and a
    # high-water mark left over from it would refuse the first code of the new.
    user.totp_last_step = None
    db.commit()
    return TotpEnrolment(secret=secret, otpauth_uri=totp_uri(secret, user.username))


@router.post(
    "/me/totp/confirm",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="confirmTotpEnrolment",
    summary="Finish enrolling a second factor",
    description=(
        "Prove the authenticator holds the secret. Only after this is a code "
        "demanded at login."
    ),
    tags=["Account"],
)
def confirm_totp(payload: TotpCode, user: CurrentUser, db: DbSession) -> None:
    """Complete enrolment by proving a code.

    Parameters
    ----------
    payload : TotpCode
        The digits from the authenticator app.
    user : models.User
        The signed-in account.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 400 when enrolment has not begun or the code is wrong.
    """
    secret = open_totp_secret(user.totp_secret)
    step = verify_totp(secret, payload.code, user.totp_last_step) if secret else None
    if step is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That code is not right. Check the clock on your phone.",
        )

    user.totp_last_step = step
    user.totp_confirmed_at = datetime.now(UTC).replace(tzinfo=None)
    db.commit()


@router.delete(
    "/me/totp",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="disableTotp",
    summary="Remove my second factor",
    description=(
        "Turn off the second factor, proving possession of the enrolled "
        "device first. Every session signs out, including this one."
    ),
    tags=["Account"],
)
def disable_totp(payload: TotpCode, user: CurrentUser, db: DbSession) -> None:
    """Remove the signed-in account's second factor.

    Parameters
    ----------
    payload : TotpCode
        A current code from the enrolled authenticator.
    user : models.User
        The signed-in account.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 400 when nothing is enrolled or the code is wrong.
    """
    secret = open_totp_secret(user.totp_secret)
    if user.totp_confirmed_at is None or secret is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No second factor is enrolled.",
        )
    if verify_totp(secret, payload.code, user.totp_last_step) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That code is not right.",
        )

    clear_totp(user)
    db.commit()
