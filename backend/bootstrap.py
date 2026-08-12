from sqlalchemy import select
from sqlalchemy.orm import Session

from config import Settings
from models import ORIGIN_COMPUTED, Catalogue, Question, ScoreComponent, User
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

STARTER_SCORE = "Raw score"
"""Name of the total the starter catalogue reports over its five items.

Seeded as catalogue data, exactly as the five questions are: nothing in the code
knows what the WHO-5 is or that its items are meant to be added up.
"""

SCORE_POSITION = 500
"""Where a seeded score sorts: after the questions it reads, before the
auto-tracked variables, which start at 1000."""


def _seed_score(db: Session, catalogue: Catalogue) -> None:
    """Add a total over every asked question of a freshly seeded catalogue.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    catalogue : Catalogue
        The catalogue just populated with its starter questions.
    """
    score = Question(
        catalogue_id=catalogue.id,
        kind="continuous",
        prompt=STARTER_SCORE,
        position=SCORE_POSITION,
        active=True,
        origin=ORIGIN_COMPUTED,
        aggregate="sum",
        require_all=True,
        # Bounds are worked out from the components on read, so the stored pair
        # is only there to satisfy the column.
        min_value=0.0,
        max_value=1.0,
    )
    db.add(score)
    db.flush()

    sources = db.execute(
        select(Question).where(
            Question.catalogue_id == catalogue.id,
            Question.origin == "asked",
        )
    ).scalars()
    for source in sources:
        db.add(
            ScoreComponent(
                score_question_id=score.id, source_question_id=source.id, weight=1.0
            )
        )
    db.flush()


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
            _seed_score(db, catalogue)

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
