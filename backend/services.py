from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Answer, Catalogue, Question, SYSTEM_KEYS

SYSTEM_QUESTION_SPECS = {
    "weekday": ("Weekday", 1.0, 7.0, "Monday", "Sunday"),
    "day_of_year": ("Day of the year", 1.0, 366.0, "Jan 1", "Dec 31"),
    "month": ("Month", 1.0, 12.0, "January", "December"),
    "year": ("Year", 2000.0, 2100.0, "2000", "2100"),
    "first_answer_hour": ("Hour of first answer", 0.0, 23.0, "Midnight", "23:00"),
}
"""Definition of each auto-tracked question: prompt, bounds and bound labels."""


def create_catalogue(db: Session, name: str) -> Catalogue:
    """Create a catalogue together with its five auto-tracked questions.

    Every catalogue carries its own copy of the system questions, so no code
    path downstream has to special-case a catalogue that lacks them. This is the
    only supported way to create a catalogue.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed by this function.
    name : str
        Unique display name for the catalogue.

    Returns
    -------
    Catalogue
        The new catalogue, flushed so that its id is populated.
    """
    catalogue = Catalogue(name=name)
    db.add(catalogue)
    db.flush()
    for offset, key in enumerate(SYSTEM_KEYS):
        prompt, low, high, low_label, high_label = SYSTEM_QUESTION_SPECS[key]
        db.add(
            Question(
                catalogue_id=catalogue.id,
                kind="discrete",
                prompt=prompt,
                position=1000 + offset,
                active=True,
                system_key=key,
                min_value=low,
                max_value=high,
                min_label=low_label,
                max_label=high_label,
            )
        )
    db.flush()
    return catalogue


def question_is_answered(db: Session, question_id: int) -> bool:
    """Report whether any user has answered a question.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    question_id : int
        The question to check.

    Returns
    -------
    bool
        True when at least one answer references the question, which freezes
        its bounds, labels, kind and options.
    """
    stmt = select(Answer.id).where(Answer.question_id == question_id).limit(1)
    return db.execute(stmt).first() is not None


def _system_values(day: date, local_hour: int) -> dict[str, float]:
    """Compute the auto-tracked values for a day.

    Parameters
    ----------
    day : datetime.date
        The client-local calendar day being answered.
    local_hour : int
        Client-local hour at which the day's first answer arrived.

    Returns
    -------
    dict of str to float
        One value per system key.
    """
    return {
        "weekday": float(day.isoweekday()),
        "day_of_year": float(day.timetuple().tm_yday),
        "month": float(day.month),
        "year": float(day.year),
        "first_answer_hour": float(local_hour),
    }


def sync_system_answers(
    db: Session, user_id: int, catalogue_id: int, day: date, local_hour: int
) -> None:
    """Ensure a day's auto-tracked answers exist for a user.

    Written in the same transaction as the day's first real answer. Existing
    rows are left untouched, so ``first_answer_hour`` keeps recording the first
    submission rather than the most recent one.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed by this function.
    user_id : int
        The answering user.
    catalogue_id : int
        Catalogue that owns the question just answered.
    day : datetime.date
        The client-local calendar day being answered.
    local_hour : int
        Client-local hour of the submission.
    """
    # A day gets exactly one set of auto-tracked answers, no matter how many
    # catalogues it was answered in. Scoping this check to the answered
    # catalogue instead would give a user who switches catalogue mid-day two
    # conflicting `first_answer_hour` values for the same day.
    already_recorded = db.execute(
        select(Answer.id)
        .join(Question, Question.id == Answer.question_id)
        .where(
            Answer.user_id == user_id,
            Answer.day == day,
            Question.system_key.is_not(None),
        )
        .limit(1)
    ).first()
    if already_recorded is not None:
        return

    system_questions = (
        db.execute(
            select(Question).where(
                Question.catalogue_id == catalogue_id,
                Question.system_key.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    values = _system_values(day, local_hour)
    for question in system_questions:
        db.add(
            Answer(
                user_id=user_id,
                question_id=question.id,
                day=day,
                value=values[question.system_key],
            )
        )


def prune_system_answers(db: Session, user_id: int, day: date) -> None:
    """Remove a day's auto-tracked answers once no real answers remain.

    A day must never carry auto-tracked values without content behind them.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed by this function.
    user_id : int
        The user whose day is being pruned.
    day : datetime.date
        The calendar day to check.
    """
    remaining = db.execute(
        select(Answer.id)
        .join(Question, Question.id == Answer.question_id)
        .where(
            Answer.user_id == user_id,
            Answer.day == day,
            Question.system_key.is_(None),
        )
        .limit(1)
    ).first()
    if remaining is not None:
        return
    system_answers = (
        db.execute(
            select(Answer)
            .join(Question, Question.id == Answer.question_id)
            .where(
                Answer.user_id == user_id,
                Answer.day == day,
                Question.system_key.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    for answer in system_answers:
        db.delete(answer)
