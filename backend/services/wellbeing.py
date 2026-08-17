import math
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from models import (
    AGGREGATES,
    ORIGIN_ASKED,
    ORIGIN_AUTO,
    ORIGIN_COMPUTED,
    SYSTEM_KEYS,
    Answer,
    Catalogue,
    Question,
    QuestionOption,
    ScoreComponent,
)
from templates import SCORE_POSITION, Template

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


def create_catalogue(db: Session, name: str, user_id: int) -> Catalogue:
    """Create a catalogue together with its five auto-tracked questions.

    Every catalogue carries its own copy of the system questions, so no code
    path downstream has to special-case a catalogue that lacks them. This is the
    only supported way to create a catalogue.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed by this function.
    name : str
        Display name, unique among that user's catalogues.
    user_id : int
        The account the catalogue belongs to.

    Returns
    -------
    Catalogue
        The new catalogue, flushed so that its id is populated.
    """
    catalogue = Catalogue(name=name, user_id=user_id)
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
            origin=ORIGIN_AUTO,
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
                QuestionOption(question_id=question.id, label=label, position=position)
            )
    db.flush()
    return catalogue


def build_from_template(
    db: Session, template: Template, user_id: int, name: str | None = None
) -> Catalogue:
    """Create a catalogue holding a template's questions and its score.

    The questions are copied, not linked: a catalogue built from a template
    stops having anything to do with it the moment it exists, so changing a
    template in a later release cannot rewrite somebody's history.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed by this function.
    template : templates.Template
        The starter set to build from.
    user_id : int
        The account the catalogue belongs to.
    name : str, optional
        What to call it, overriding the template's own name.

    Returns
    -------
    Catalogue
        The new catalogue, flushed so that its id is populated.
    """
    catalogue = create_catalogue(db, name or template.name, user_id)
    for position, item in enumerate(template.questions):
        low, high, low_label, high_label = item.bounds
        db.add(
            Question(
                catalogue_id=catalogue.id,
                kind="discrete",
                prompt=item.prompt,
                position=position,
                active=True,
                min_value=low,
                max_value=high,
                min_label=low_label,
                max_label=high_label,
            )
        )
    db.flush()
    if template.score is not None:
        _add_score(db, catalogue, template.score)
    return catalogue


def _add_score(db: Session, catalogue: Catalogue, name: str) -> Question:
    """Add a total over every asked question of a catalogue.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    catalogue : Catalogue
        The catalogue whose asked questions the score reads.
    name : str
        What the score is called.

    Returns
    -------
    Question
        The computed question standing for the score.
    """
    score = Question(
        catalogue_id=catalogue.id,
        kind="continuous",
        prompt=name,
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
            Question.origin == ORIGIN_ASKED,
        )
    ).scalars()
    for source in sources:
        db.add(
            ScoreComponent(
                score_question_id=score.id, source_question_id=source.id, weight=1.0
            )
        )
    db.flush()
    return score


class QuestionRuleError(ValueError):
    """Raised when a question's shape contradicts the kind it declares.

    A plain exception rather than an HTTP error: these are rules about what a
    question *is*, and they hold whether the caller arrived over HTTP, through a
    migration, or from a future import script. The router translates it.
    """


def check_question_bounds(
    kind: str, min_value: float | None, max_value: float | None
) -> None:
    """Check that a question's bounds match the kind it declares.

    Kept apart from the option rule because the two are edited in different
    places: the bounds arrive on the question itself, the options through their
    own endpoint. An edit is only ever held to the rule it can actually break.

    Parameters
    ----------
    kind : str
        One of ``enum``, ``discrete`` or ``continuous``.
    min_value : float or None
        Proposed lower bound.
    max_value : float or None
        Proposed upper bound.

    Raises
    ------
    QuestionRuleError
        If an enum carries bounds, or a scaled question lacks one or has them
        the wrong way round.
    """
    if kind == "enum":
        if min_value is not None or max_value is not None:
            raise QuestionRuleError("An enum question cannot have bounds")
        return

    if min_value is None or max_value is None:
        raise QuestionRuleError("A scaled question needs a lower and an upper bound")
    if min_value >= max_value:
        raise QuestionRuleError("The lower bound must be below the upper bound")


def check_question_options(kind: str, option_count: int) -> None:
    """Check that a question carries the choices its kind calls for.

    Parameters
    ----------
    kind : str
        One of ``enum``, ``discrete`` or ``continuous``.
    option_count : int
        How many choices the question would carry.

    Raises
    ------
    QuestionRuleError
        If an enum has fewer than two choices, or a scaled question has any.
    """
    if kind == "enum":
        if option_count < 2:
            raise QuestionRuleError("An enum question needs at least two options")
        return

    if option_count:
        raise QuestionRuleError("A scaled question cannot have options")


def check_question_shape(
    kind: str,
    min_value: float | None,
    max_value: float | None,
    option_count: int,
) -> None:
    """Check every rule a question must satisfy to be created whole.

    Parameters
    ----------
    kind : str
        One of ``enum``, ``discrete`` or ``continuous``.
    min_value : float or None
        Proposed lower bound.
    max_value : float or None
        Proposed upper bound.
    option_count : int
        How many choices the question would carry.

    Raises
    ------
    QuestionRuleError
        If an enum carries bounds or fewer than two choices, or a scaled
        question carries choices, lacks a bound, or has them the wrong way round.
    """
    check_question_options(kind, option_count)
    check_question_bounds(kind, min_value, max_value)


class ScoreRuleError(ValueError):
    """Raised when a score's definition does not describe a usable score."""


def check_score_shape(aggregate: str, components: list[Question]) -> None:
    """Check that a score can be computed from the questions it names.

    Parameters
    ----------
    aggregate : str
        How the components combine.
    components : list of Question
        The questions the score would read, already loaded.

    Raises
    ------
    ScoreRuleError
        If the aggregate is unknown, no components were given, or one of them
        has no numeric value to contribute.
    """
    if aggregate not in AGGREGATES:
        raise ScoreRuleError(
            f"A score is combined with one of: {', '.join(AGGREGATES)}"
        )
    if not components:
        raise ScoreRuleError("A score needs at least one question to combine")

    for question in components:
        if question.origin != ORIGIN_ASKED:
            raise ScoreRuleError(
                f"{question.prompt!r} is not a question people answer, so it cannot "
                "feed a score"
            )
        if question.kind == "enum":
            raise ScoreRuleError(
                f"{question.prompt!r} is a set of choices, not a scale, so it has no "
                "value to add up. A scored yes/no is a discrete question with bounds "
                "0 and 1."
            )


def score_bounds(score: Question) -> tuple[float, float]:
    """Derive the range a score can take from the questions feeding it.

    Configuring the bounds separately would let them contradict the components;
    deriving them means the stats axis is always the truth.

    Parameters
    ----------
    score : Question
        A question of origin ``computed``, with its components loaded.

    Returns
    -------
    tuple of (float, float)
        Lowest and highest value the score can reach.
    """
    low = sum((c.source.min_value or 0) * c.weight for c in score.components)
    high = sum((c.source.max_value or 0) * c.weight for c in score.components)
    if score.aggregate == "mean":
        total_weight = sum(c.weight for c in score.components) or 1.0
        return low / total_weight, high / total_weight
    return low, high


def score_for_day(score: Question, values: dict[int, float]) -> float | None:
    """Combine one day's answers into this score.

    Parameters
    ----------
    score : Question
        A question of origin ``computed``, with its components loaded.
    values : dict of int to float
        The day's numeric answers, keyed by question id.

    Returns
    -------
    float or None
        The score, or None when the day cannot produce one: no component
        answered, or - when `require_all` is set - any component missing.
    """
    present = [
        c for c in score.components if values.get(c.source_question_id) is not None
    ]
    if not present:
        return None
    if score.require_all and len(present) != len(score.components):
        return None

    total = sum(values[c.source_question_id] * c.weight for c in present)
    if score.aggregate == "mean":
        total_weight = sum(c.weight for c in present)
        if not total_weight:
            return None
        total /= total_weight
    return round(total, 4)


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
    # Flushed at the end of this function, and the reason is the session: it is
    # created with `autoflush=False`, so a later call in the same transaction
    # would not see what this one added and would write the day's auto-tracked
    # answers a second time. One request now carries a whole queue — several
    # answers for one day arrive together — where it used to carry one write
    # that committed before the next arrived.
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
    db.flush()


def check_answer(question, option, day_value, day_option_id) -> None:
    """Check that a response fits the question it answers.

    Moved here from the router that used to own it, when the only way to write
    an answer became the sync queue: validation belongs to the rules, not to one
    of the doors into them, and a queued answer must meet the same bar as one
    typed with a connection.

    Parameters
    ----------
    question : Question
        The question being answered.
    option : QuestionOption or None
        The chosen option, already loaded, for an enum question.
    day_value : float or None
        The submitted numeric value.
    day_option_id : int or None
        The submitted option id.

    Raises
    ------
    QuestionRuleError
        When the wrong field is used for the question's kind, the value falls
        outside its bounds, a discrete value is not whole, the option belongs to
        another question, or the question is one the server writes itself.
    """
    if question.is_system:
        raise QuestionRuleError("Auto-tracked questions are written by the server")
    if question.is_computed:
        raise QuestionRuleError(
            "A score is worked out from other answers, not answered itself"
        )

    if question.kind == "enum":
        if day_option_id is None or day_value is not None:
            raise QuestionRuleError("An enum question is answered with an option")
        if option is None or option.question_id != question.id:
            raise QuestionRuleError("Option does not belong to this question")
        return

    if day_value is None or day_option_id is not None:
        raise QuestionRuleError("A scaled question is answered with a value")
    # NaN compares false against every bound, so it would slip past the range
    # checks below and only fail at insert time as a 500.
    if not math.isfinite(day_value):
        raise QuestionRuleError("Value must be a finite number")
    if question.min_value is not None and day_value < question.min_value:
        raise QuestionRuleError("Value is below the question's lower bound")
    if question.max_value is not None and day_value > question.max_value:
        raise QuestionRuleError("Value is above the question's upper bound")
    if question.kind == "discrete" and day_value != int(day_value):
        raise QuestionRuleError("A discrete question takes whole numbers")
