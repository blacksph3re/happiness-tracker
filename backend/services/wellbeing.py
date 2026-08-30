import math
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AGGREGATES,
    HABIT_DIRECTIONS,
    HABIT_PERIODS,
    ORIGIN_ASKED,
    ORIGIN_COMPUTED,
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
    """Create an empty catalogue.

    It used to arrive with five auto-tracked questions of its own. Those are
    computed from the day now — see `SYSTEM_QUESTION_SPECS` — so a catalogue
    holds only what its owner puts in it.

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


class HabitRuleError(ValueError):
    """Raised when a habit's definition does not describe a habit that can be kept.

    Separate from `QuestionRuleError` because the two answer different questions.
    A question's shape is about what it *is* — an enum with choices, a scale with
    bounds. A habit's shape is about what it *asks of you*, and a question can be
    perfectly well formed while the habit hung on it is not.
    """


def check_habit_shape(
    kind: str,
    habit_period: str | None,
    habit_target: int | None,
    habit_direction: str | None,
) -> None:
    """Check that three habit fields describe one coherent target.

    The same rules stand as check constraints on `questions`. Both, and
    deliberately: a constraint violation surfaces as a 500 with nothing in it a
    caller can act on, while this raises early enough for the router to answer
    422 naming the field. The constraints are the floor under a hand-written
    UPDATE, not the thing an API caller meets.

    Parameters
    ----------
    kind : str
        One of ``enum``, ``discrete`` or ``continuous``.
    habit_period : str or None
        Proposed period, or None for a question that is not a habit.
    habit_target : int or None
        Proposed target.
    habit_direction : str or None
        Proposed direction.

    Raises
    ------
    HabitRuleError
        If the three fields are not all set or all absent, if the question is
        not an enum, if the period or direction is not one this app knows, or if
        the target is negative — or zero under ``at_least``, which asks for
        nothing and would be met by every period including the empty ones.
    """
    present = [
        field is not None for field in (habit_period, habit_target, habit_direction)
    ]
    if not any(present):
        return
    if not all(present):
        raise HabitRuleError(
            "A habit needs a period, a target and a direction, or none of the three"
        )

    if kind != "enum":
        raise HabitRuleError("Only a question with options can be a habit")
    if habit_period not in HABIT_PERIODS:
        raise HabitRuleError(f"A habit period is one of {', '.join(HABIT_PERIODS)}")
    if habit_direction not in HABIT_DIRECTIONS:
        raise HabitRuleError(
            f"A habit direction is one of {', '.join(HABIT_DIRECTIONS)}"
        )
    if habit_target is None or habit_target < 0:
        raise HabitRuleError("A habit target cannot be negative")
    # Zero is what makes a stopping habit expressible — "no more than nothing" —
    # and is meaningless the other way round: at least zero is true of every
    # period, including every period nobody recorded.
    if habit_target == 0 and habit_direction == "at_least":
        raise HabitRuleError("A target of at least zero is met by doing nothing")


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


def system_values(day: date, local_hour: int) -> dict[str, float]:
    """Compute the auto-tracked values for a day.

    Nothing stores these. They are a function of the calendar day and of the
    day's earliest `Answer.local_hour`, computed wherever they are needed —
    which is what keeps them right on a day the questionnaire never saw.

    This is also the reference the client's port in `lib/wellbeing/derive.js` is
    held against, case by case, by `derivations.json`.

    Enum keys yield the zero-based position of the option to select, which is
    also the id that option is offered under; scaled keys yield the value.

    Parameters
    ----------
    day : datetime.date
        The client-local calendar day being described.
    local_hour : int
        Earliest client-local hour recorded on that day.

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


def check_answer(
    question: Question,
    option: QuestionOption | None,
    day_value: float | None,
    day_option_id: int | None,
) -> None:
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
