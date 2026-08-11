from sqlalchemy import select
from sqlalchemy.orm import Session

from config import Settings
from models import Catalogue, Question, User
from security import hash_password
from services import create_catalogue

DEFAULT_CATALOGUE_NAME = "WHO-5"
"""Name of the catalogue created on a fresh installation."""

STARTER_QUESTIONS = (
    "I have felt cheerful and in good spirits",
    "I have felt calm and relaxed",
    "I have felt active and vigorous",
    "I woke up feeling fresh and rested",
    "My daily life has been filled with things that interest me",
)
"""The five items of the WHO-5 Well-Being Index, in their published order.

Reproduced verbatim so the catalogue stays comparable with the instrument. The
WHO-5 is validated over a two-week recall window, so a daily reading is an
adaptation: the trend is meaningful, the published clinical cut-offs are not.
"""

STARTER_BOUNDS = (0.0, 5.0, "At no time", "All of the time")
"""The WHO-5 response scale: a six-point frequency rating from 0 to 5."""


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
    catalogue = None
    if settings.bootstrap_question_catalogue:
        catalogue = db.execute(
            select(Catalogue).where(Catalogue.name == DEFAULT_CATALOGUE_NAME)
        ).scalar_one_or_none()
        if catalogue is None:
            catalogue = create_catalogue(db, DEFAULT_CATALOGUE_NAME)
            low, high, low_label, high_label = STARTER_BOUNDS
            for position, prompt in enumerate(STARTER_QUESTIONS):
                db.add(
                    Question(
                        catalogue_id=catalogue.id,
                        kind="discrete",
                        prompt=prompt,
                        position=position,
                        active=True,
                        min_value=low,
                        max_value=high,
                        min_label=low_label,
                        max_label=high_label,
                    )
                )
            db.flush()

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
        db.add(
            User(
                username=settings.admin_user,
                password_hash=hash_password(settings.admin_password),
                is_admin=True,
                is_editor=True,
                default_catalogue_id=catalogue.id if catalogue else None,
            )
        )
    db.commit()
