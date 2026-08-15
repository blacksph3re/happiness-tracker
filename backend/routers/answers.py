from datetime import date

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import ORIGIN_COMPUTED, Answer, Question
from schemas import AnswerOut
from services import score_for_day

router = APIRouter(prefix="/answers", tags=["Answers"])


def _with_scores(db: DbSession, user_id: int, answers: list[Answer]) -> list[dict]:
    """Return the answers plus a row for every score they add up to.

    Scores are computed here rather than stored, so a definition applies to the
    whole history the moment it changes and nothing has to be rewritten. They
    come back looking like any other answer, which is what lets the record
    table, the export and the stats page show them without knowing they exist.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The user whose answers these are. Unused beyond documenting intent: the
        answers are already theirs.
    answers : list of Answer
        Stored answers, in day order.

    Returns
    -------
    list of dict
        Serialisable rows: the stored answers, then the computed ones.
    """
    rows = [
        {
            "question_id": answer.question_id,
            "day": answer.day,
            "value": answer.value,
            "option_id": answer.option_id,
        }
        for answer in answers
    ]
    if not rows:
        return rows

    scores = (
        db.execute(
            select(Question)
            .options(selectinload(Question.components))
            .where(Question.origin == ORIGIN_COMPUTED, Question.active.is_(True))
        )
        .scalars()
        .all()
    )
    if not scores:
        return rows

    values_by_day: dict[date, dict[int, float]] = {}
    for answer in answers:
        if answer.value is not None:
            values_by_day.setdefault(answer.day, {})[answer.question_id] = answer.value

    for day, values in values_by_day.items():
        for score in scores:
            computed = score_for_day(score, values)
            if computed is not None:
                rows.append(
                    {
                        "question_id": score.id,
                        "day": day,
                        "value": computed,
                        "option_id": None,
                    }
                )
    return rows


def _answers_in_range(
    db: DbSession, user_id: int, start: date | None, end: date | None
) -> list[Answer]:
    """Load one user's answers within an optional date range.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The user whose answers are read.
    start : datetime.date or None
        Inclusive lower bound, or None for no bound.
    end : datetime.date or None
        Inclusive upper bound, or None for no bound.

    Returns
    -------
    list of Answer
        Matching answers ordered by day, then question.
    """
    stmt = select(Answer).where(Answer.user_id == user_id)
    if start is not None:
        stmt = stmt.where(Answer.day >= start)
    if end is not None:
        stmt = stmt.where(Answer.day <= end)
    stmt = stmt.order_by(Answer.day, Answer.question_id)
    return list(db.execute(stmt).scalars().all())


@router.get(
    "",
    response_model=list[AnswerOut],
    operation_id="listAnswers",
    summary="List my answers",
    description=(
        "Return the signed-in account's answers in an optional date range, "
        "auto-tracked values included."
    ),
)
def list_answers(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
) -> list[dict]:
    """Return the authenticated user's answers, with the values derived from them.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    start : datetime.date or None, optional
        Inclusive lower bound on the day, by default no bound.
    end : datetime.date or None, optional
        Inclusive upper bound on the day, by default no bound.

    Returns
    -------
    list of dict
        Matching answers, the auto-tracked values, and a row per score, never
        including another user's data.
    """
    return _with_scores(db, user.id, _answers_in_range(db, user.id, start, end))
