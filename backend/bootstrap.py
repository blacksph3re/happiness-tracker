from sqlalchemy import select
from sqlalchemy.orm import Session

from config import Settings
from models import User
from security import hash_password
from services import build_from_template
from templates import CATALOGUE_TEMPLATES, DEFAULT_TEMPLATE

DEFAULT_CATALOGUE_NAME = CATALOGUE_TEMPLATES[DEFAULT_TEMPLATE].name
"""Name of the catalogue created on a fresh installation.

Read from the template rather than declared here, so the starter set has one
definition. `templates.py` is where it lives.
"""


def bootstrap(db: Session, settings: Settings) -> None:
    """Create the admin account and starter catalogue if they are absent.

    Idempotent: it creates only what is missing and never overwrites an existing
    account's password, so restarting with a changed ``ADMIN_PASSWORD`` leaves
    the running credentials alone.

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

    db.commit()
