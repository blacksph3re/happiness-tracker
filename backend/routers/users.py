from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from deps import AdminUser, DbSession
from models import Catalogue, User
from schemas import PasswordReset, UserCreate, UserOut, UserUpdate
from security import hash_password

router = APIRouter(prefix="/users", tags=["Users"])


def _get_user(db: DbSession, user_id: int) -> User:
    """Load a user or raise a 404.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Identifier of the user to load.

    Returns
    -------
    User
        The requested user.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when no such user exists.
    """
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    return user


def _check_catalogue(db: DbSession, catalogue_id: int | None) -> None:
    """Validate that a referenced catalogue exists.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    catalogue_id : int or None
        Catalogue to check. ``None`` is accepted and means "no default".

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the catalogue does not exist.
    """
    if catalogue_id is not None and db.get(Catalogue, catalogue_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Catalogue not found"
        )


@router.get(
    "",
    response_model=list[UserOut],
    operation_id="listUsers",
    summary="List accounts",
    description="List every account. Requires the user-management permission.",
)
def list_users(admin: AdminUser, db: DbSession) -> list[User]:
    """List every account.

    Parameters
    ----------
    admin : User
        The authenticated administrator.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of User
        All users, ordered by name.
    """
    return list(db.execute(select(User).order_by(User.username)).scalars().all())


@router.post(
    "",
    response_model=UserOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createUser",
    summary="Create an account",
    description="Create a new account with its permission flags.",
)
def create_user(payload: UserCreate, admin: AdminUser, db: DbSession) -> User:
    """Create a new account.

    Parameters
    ----------
    payload : UserCreate
        The account to create.
    admin : User
        The authenticated administrator.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    User
        The created user.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the username is taken, or 404 when the referenced
        default catalogue does not exist.
    """
    _check_catalogue(db, payload.default_catalogue_id)
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        is_admin=payload.is_admin,
        is_editor=payload.is_editor,
        default_catalogue_id=payload.default_catalogue_id,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Username already taken"
        ) from None
    db.refresh(user)
    return user


@router.put(
    "/{user_id}",
    response_model=UserOut,
    operation_id="updateUser",
    summary="Change an account",
    description=(
        "Change another account's permission flags or default catalogue. An "
        "administrator cannot remove their own user-management permission."
    ),
)
def update_user(
    user_id: int, payload: UserUpdate, admin: AdminUser, db: DbSession
) -> User:
    """Change another account's permission flags or default catalogue.

    Parameters
    ----------
    user_id : int
        The account to change.
    payload : UserUpdate
        Fields to apply. Omitted fields are left alone.
    admin : User
        The authenticated administrator.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    User
        The updated user.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the user or referenced catalogue does not exist.
    """
    user = _get_user(db, user_id)
    if payload.is_admin is False and user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You cannot remove your own admin permission",
        )
    if payload.is_admin is not None:
        user.is_admin = payload.is_admin
    if payload.is_editor is not None:
        user.is_editor = payload.is_editor
    if payload.default_catalogue_id is not None:
        _check_catalogue(db, payload.default_catalogue_id)
        user.default_catalogue_id = payload.default_catalogue_id
    db.commit()
    db.refresh(user)
    return user


@router.put(
    "/{user_id}/password",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="resetUserPassword",
    summary="Reset an account password",
    description="Set another account's password without knowing the old one.",
)
def reset_password(
    user_id: int, payload: PasswordReset, admin: AdminUser, db: DbSession
) -> None:
    """Set another account's password without knowing the old one.

    Parameters
    ----------
    user_id : int
        The account whose password is replaced.
    payload : PasswordReset
        The replacement password.
    admin : User
        The authenticated administrator.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the user does not exist.
    """
    user = _get_user(db, user_id)
    user.password_hash = hash_password(payload.new_password)
    # A reset exists to lock someone out; leaving their tokens alive would not.
    user.token_version += 1
    db.commit()


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteUser",
    summary="Delete an account",
    description="Delete an account and every answer it recorded.",
)
def delete_user(user_id: int, admin: AdminUser, db: DbSession) -> None:
    """Delete an account and every answer it recorded.

    Parameters
    ----------
    user_id : int
        The account to delete.
    admin : User
        The authenticated administrator.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the user does not exist, or 409 when an
        administrator tries to delete their own account.
    """
    user = _get_user(db, user_id)
    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You cannot delete your own account",
        )
    db.delete(user)
    db.commit()
