from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import ORIGIN_COMPUTED, Answer, Question
from schemas import OptionOut, Variable
from services import score_bounds

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
            .options(selectinload(Question.options))
            .join(Answer, Answer.question_id == Question.id)
            .where(Answer.user_id == user.id)
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

    questions = sorted([*answered, *scores], key=lambda q: (q.position, q.id))

    variables: list[Variable] = []
    by_system_key: dict[str, Variable] = {}
    for question in questions:
        if question.system_key is not None:
            merged = by_system_key.get(question.system_key)
            if merged is not None:
                merged.question_ids.append(question.id)
                continue
        low, high = (
            score_bounds(question)
            if question.origin == ORIGIN_COMPUTED
            else (question.min_value, question.max_value)
        )
        variable = Variable(
            key=question.system_key or f"q{question.id}",
            origin=question.origin,
            label=question.prompt,
            kind=question.kind,
            system_key=question.system_key,
            min_value=low,
            max_value=high,
            min_label=question.min_label,
            max_label=question.max_label,
            options=[OptionOut.model_validate(option) for option in question.options],
            question_ids=[question.id],
            roles=(
                COMPUTED_ROLES
                if question.origin == ORIGIN_COMPUTED
                else SYSTEM_ROLES
                if question.system_key is not None
                else ENUM_ROLES
                if question.kind == "enum"
                else NUMERIC_ROLES
            ),
        )
        if question.system_key is not None:
            by_system_key[question.system_key] = variable
        variables.append(variable)
    return variables
