from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from models import Answer, Catalogue, Question, QuestionOption, SYSTEM_KEYS

WEEKDAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
"""Weekday option labels, ordered so that index 0 is Monday."""

MONTH_LABELS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
"""Month option labels, ordered so that index 0 is January."""

SYSTEM_QUESTION_SPECS = {
    "weekday": {"prompt": "Weekday", "kind": "enum", "options": WEEKDAY_LABELS},
    "day_of_year": {
        "prompt": "Day of the year",
        "kind": "discrete",
        "bounds": (1.0, 366.0, "Jan 1", "Dec 31"),
    },
    "month": {"prompt": "Month", "kind": "enum", "options": MONTH_LABELS},
    "year": {
        "prompt": "Year",
        "kind": "discrete",
        "bounds": (2000.0, 2100.0, "2000", "2100"),
    },
    "first_answer_hour": {
        "prompt": "Hour of first answer",
        "kind": "discrete",
        "bounds": (0.0, 23.0, "Midnight", "23:00"),
    },
}
"""Definition of each auto-tracked question.

Weekday and month are enums because they are categories, not quantities: the
step from Sunday to Monday is not a change of six, and treating them as scales
invited plotting them over time, which says nothing. They exist to subset the
data, and the remaining three are scales that happen to be recorded for you.
"""


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
        spec = SYSTEM_QUESTION_SPECS[key]
        low, high, low_label, high_label = spec.get("bounds", (None, None, None, None))
        question = Question(
            catalogue_id=catalogue.id,
            kind=spec["kind"],
            prompt=spec["prompt"],
            position=1000 + offset,
            active=True,
            system_key=key,
            min_value=low,
            max_value=high,
            min_label=low_label,
            max_label=high_label,
        )
        db.add(question)
        db.flush()
        for position, label in enumerate(spec.get("options", ())):
            db.add(
                QuestionOption(
                    question_id=question.id, label=label, position=position
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

    Enum keys yield the zero-based position of the option to select; scaled keys
    yield the value itself.

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
        "weekday": float(day.isoweekday() - 1),
        "day_of_year": float(day.timetuple().tm_yday),
        "month": float(day.month - 1),
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
            select(Question)
            .options(selectinload(Question.options))
            .where(
                Question.catalogue_id == catalogue_id,
                Question.system_key.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    values = _system_values(day, local_hour)
    for question in system_questions:
        computed = values[question.system_key]
        if question.kind == "enum":
            # The computed number is the option's position, not the answer.
            option = next(
                (o for o in question.options if o.position == int(computed)), None
            )
            if option is None:
                continue
            db.add(
                Answer(
                    user_id=user_id,
                    question_id=question.id,
                    day=day,
                    option_id=option.id,
                )
            )
            continue
        db.add(
            Answer(
                user_id=user_id,
                question_id=question.id,
                day=day,
                value=computed,
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
