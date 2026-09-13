from sqlalchemy import select
from sqlalchemy.orm import Session

from config import Settings
from models import User
from security import hash_password
from services import build_from_template, ensure_system_lists
from templates import CATALOGUE_TEMPLATES, DEFAULT_TEMPLATE


def bootstrap(db: Session, settings: Settings) -> None:
    """Create the admin account and starter catalogue if they are absent.

    Idempotent: it creates only what is missing and never overwrites an existing
    account's password, so restarting with a changed ``ADMIN_PASSWORD`` leaves
    the running credentials alone. It also provisions the two system todo lists
    for **every** account, for the same reason.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    settings : Settings
        Runtime configuration supplying the admin credentials and the
        catalogue bootstrap flag.
    """
    admin = db.execute(
        select(User).where(User.username == settings.admin_user)
    ).scalar_one_or_none()
    if admin is None:
        if not settings.admin_password:
            raise RuntimeError(
                f"ADMIN_PASSWORD is not set, so the {settings.admin_user!r} account "
                "cannot be created. Set it to the password you want that account to "
                "have; it is only used when the account does not yet exist."
            )
        if len(settings.admin_password) < settings.password_min_length:
            raise RuntimeError(
                "ADMIN_PASSWORD is shorter than PASSWORD_MIN_LENGTH "
                f"({settings.password_min_length})."
            )
        admin = User(
            username=settings.admin_user,
            password_hash=hash_password(settings.admin_password),
            is_admin=True,
        )
        db.add(admin)
        # The account first, and flushed for its id: a catalogue belongs to
        # somebody now, so there is nobody to build one for until this exists.
        db.flush()

    if settings.bootstrap_question_catalogue and admin.default_catalogue_id is None:
        catalogue = build_from_template(
            db, CATALOGUE_TEMPLATES[DEFAULT_TEMPLATE], admin.id
        )
        admin.default_catalogue_id = catalogue.id

    # Every account, not only the one just created: an account made before the
    # todo half existed gains its inbox and archive at the next startup, so the
    # migration's inserts are a convenience rather than the only path. The
    # partial unique index on `(user_id, kind)` is what makes running this at
    # every boot free rather than merely harmless.
    for user_id in db.execute(select(User.id)).scalars():
        ensure_system_lists(db, user_id)

    db.commit()
