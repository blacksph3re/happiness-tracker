from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import ORIGIN_AUTO, ORIGIN_COMPUTED, SYSTEM_KEYS, Answer, Question
from schemas import OptionOut, Variable
from services import SYSTEM_QUESTION_SPECS, score_bounds

router = APIRouter(prefix="/stats", tags=["Stats"])

NUMERIC_ROLES = ["axis", "radar"]
"""Plot roles a scaled question can fill."""

ENUM_ROLES = ["group", "radar"]
"""Plot roles an enum question can fill: never an axis, since it has no scale."""

COMPUTED_ROLES = ["axis", "radar"]
"""A score is a number over time, so it plots like any other scale."""

SYSTEM_ROLES = ["filter"]
"""The only role an auto-tracked variable fills.

Weekday over time is a sawtooth and weekday on a radar is meaningless. What
these variables are actually good for is narrowing the data behind the other
plots - weekends only, winter only - so that is all they are offered for.
"""


def _system_variables() -> list[Variable]:
    """Describe the auto-tracked variables, which have no question row at all.

    Weekday, month, year and day-of-year are functions of the calendar day and
    the hour is a column on the answer, so none of them is stored and none has
    an id to be read under. The client derives the values; this says what they
    are, what they are called and what may be picked.

    An enum option is identified by its **position**, because there is no option
    row to carry a key. That is also the number the client derives for a day, so
    a chip and a day compare directly.

    Returns
    -------
    list of Variable
        One per system key, in the order they are declared.
    """
    out: list[Variable] = []
    for key in SYSTEM_KEYS:
        spec = SYSTEM_QUESTION_SPECS[key]
        low, high, low_label, high_label = spec.get("bounds", (None, None, None, None))
        out.append(
            Variable(
                key=key,
                origin=ORIGIN_AUTO,
                label=spec["prompt"],
                kind=spec["kind"],
                system_key=key,
                min_value=low,
                max_value=high,
                min_label=low_label,
                max_label=high_label,
                options=[
                    OptionOut(id=position, label=label, position=position)
                    for position, label in enumerate(spec.get("options", ()))
                ],
                question_ids=[],
                component_ids=[],
                roles=SYSTEM_ROLES,
            )
        )
    return out


@router.get(
    "/variables",
    response_model=list[Variable],
    operation_id="listStatsVariables",
    summary="List plottable variables",
    description=(
        "Describe every variable the signed-in account has data for, with the "
        "plot roles each supports. Auto-tracked variables are merged across "
        "catalogues by their system key."
    ),
)
def list_variables(user: CurrentUser, db: DbSession) -> list[Variable]:
    """Describe every variable the authenticated user has data for.

    Auto-tracked questions are merged across catalogues by their system key, so
    a user who has switched catalogue still sees one continuous variable rather
    than one per catalogue.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of Variable
        Variables in display order, each carrying the plot roles it supports.
    """
    answered = (
        db.execute(
            select(Question)
            # Components as well as options: every variable now reports what it
            # is made of, and reading that off a lazy relationship would put one
            # query per answered question behind this endpoint.
            .options(selectinload(Question.options), selectinload(Question.components))
            .join(Answer, Answer.question_id == Question.id)
            .where(Answer.user_id == user.id, Question.active.is_(True))
            .distinct()
            .order_by(Question.position, Question.id)
        )
        .scalars()
        .all()
    )

    # A score has no answers of its own to join against - it is worked out when
    # answers are read - so it is picked up by the catalogues the user has
    # actually answered in.
    catalogue_ids = {question.catalogue_id for question in answered}
    scores = (
        db.execute(
            select(Question)
            .options(selectinload(Question.components))
            .where(
                Question.origin == ORIGIN_COMPUTED,
                Question.active.is_(True),
                Question.catalogue_id.in_(catalogue_ids),
            )
        )
        .scalars()
        .all()
        if catalogue_ids
        else []
    )

    if not answered:
        return []

    questions = sorted([*answered, *scores], key=lambda q: (q.position, q.id))

    variables: list[Variable] = []
    for question in questions:
        low, high = (
            score_bounds(question)
            if question.origin == ORIGIN_COMPUTED
            else (question.min_value, question.max_value)
        )
        variable = Variable(
            key=f"q{question.id}",
            origin=question.origin,
            label=question.prompt,
            kind=question.kind,
            system_key=None,
            min_value=low,
            max_value=high,
            min_label=question.min_label,
            max_label=question.max_label,
            options=[OptionOut.model_validate(option) for option in question.options],
            question_ids=[question.id],
            # Empty for everything else: only a computed question has
            # components. Eagerly loaded on both queries above, so this is a
            # read off memory rather than a query per variable.
            component_ids=[
                component.source_question_id for component in question.components
            ],
            roles=(
                COMPUTED_ROLES
                if question.origin == ORIGIN_COMPUTED
                else ENUM_ROLES
                if question.kind == "enum"
                else NUMERIC_ROLES
            ),
        )
        variables.append(variable)
    return [*variables, *_system_variables()]
