import math
from datetime import date
from io import BytesIO

from fastapi import APIRouter, HTTPException, Query, Response, status
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import ORIGIN_COMPUTED, Answer, Question, QuestionOption
from schemas import AnswerIn, AnswerOut
from services import score_for_day, sync_system_answers

router = APIRouter(prefix="/answers", tags=["Answers"])


def _load_answerable_question(db: DbSession, question_id: int) -> Question:
    """Load a question that a user is allowed to answer directly.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    question_id : int
        Identifier of the question.

    Returns
    -------
    Question
        The requested question.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the question does not exist, or 403 when it is
        auto-tracked and therefore written only by the server.
    """
    question = db.get(Question, question_id)
    if question is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Question not found"
        )
    if question.is_system:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Auto-tracked questions are written by the server",
        )
    if question.is_computed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A score is worked out from other answers, not answered itself",
        )
    return question


def _validate_response(db: DbSession, question: Question, payload: AnswerIn) -> None:
    """Check that a submitted response fits the question it answers.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    question : Question
        The question being answered.
    payload : AnswerIn
        The submitted answer.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when the wrong field is used for the question kind, the
        value falls outside the bounds, a discrete value is not integral, or the
        chosen option belongs to another question.
    """
    if question.kind == "enum":
        if payload.option_id is None or payload.value is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="An enum question is answered with an option",
            )
        option = db.get(QuestionOption, payload.option_id)
        if option is None or option.question_id != question.id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Option does not belong to this question",
            )
        return

    if payload.value is None or payload.option_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="A scaled question is answered with a value",
        )
    # NaN compares false against every bound, so it would slip past the range
    # checks below and only fail at insert time as a 500.
    if not math.isfinite(payload.value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Value must be a finite number",
        )
    if question.min_value is not None and payload.value < question.min_value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Value is below the question's lower bound",
        )
    if question.max_value is not None and payload.value > question.max_value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Value is above the question's upper bound",
        )
    if question.kind == "discrete" and payload.value != int(payload.value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="A discrete question takes whole numbers",
        )


@router.put(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="upsertAnswer",
    summary="Record an answer",
    description=(
        "Record or replace one answer for one day. Idempotent on "
        "(user, question, day); the day's auto-tracked answers are written in "
        "the same transaction."
    ),
)
def upsert_answer(payload: AnswerIn, user: CurrentUser, db: DbSession) -> None:
    """Record or replace one answer for one day.

    Idempotent on ``(user, question, day)``: submitting the same answer twice
    leaves a single row, and a correction overwrites in place. The day's
    auto-tracked answers are materialised in the same transaction.

    Parameters
    ----------
    payload : AnswerIn
        The submitted answer, carrying the client-local day and hour.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    """
    question = _load_answerable_question(db, payload.question_id)
    _validate_response(db, question, payload)

    answer = db.execute(
        select(Answer).where(
            Answer.user_id == user.id,
            Answer.question_id == question.id,
            Answer.day == payload.day,
        )
    ).scalar_one_or_none()
    if answer is None:
        answer = Answer(user_id=user.id, question_id=question.id, day=payload.day)
        db.add(answer)
    answer.value = payload.value
    answer.option_id = payload.option_id

    sync_system_answers(
        db, user.id, question.catalogue_id, payload.day, payload.local_hour
    )
    db.commit()


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


@router.get(
    "/export.xlsx",
    operation_id="exportAnswers",
    summary="Download my answers as a spreadsheet",
    description=(
        "Render the answers as an .xlsx workbook: one row per day, one column "
        "per question ever answered."
    ),
    response_description="An .xlsx attachment.",
    responses={
        200: {
            "content": {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {}
            }
        }
    },
)
def export_answers(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
) -> Response:
    """Render the authenticated user's answers as a spreadsheet.

    One row per day and one column per question ever answered, which is the
    orientation analysis tools expect even though the on-screen table runs the
    other way.

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
    fastapi.Response
        An ``.xlsx`` attachment.
    """
    # The same rows the app reads, so the spreadsheet agrees with the screen -
    # scores included.
    answers = _with_scores(db, user.id, _answers_in_range(db, user.id, start, end))
    question_ids = {answer["question_id"] for answer in answers}
    questions = (
        db.execute(
            select(Question)
            .options(selectinload(Question.options))
            .where(Question.id.in_(question_ids))
            .order_by(Question.position, Question.id)
        )
        .scalars()
        .all()
        if question_ids
        else []
    )
    option_labels = {
        option.id: option.label
        for question in questions
        for option in question.options
    }

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Answers"
    sheet.append(["Day"] + [question.prompt for question in questions])

    by_day: dict[date, dict[int, dict]] = {}
    for answer in answers:
        by_day.setdefault(answer["day"], {})[answer["question_id"]] = answer
    for day in sorted(by_day):
        row: list[object] = [day.isoformat()]
        for question in questions:
            answer = by_day[day].get(question.id)
            if answer is None:
                row.append(None)
            elif answer["option_id"] is not None:
                row.append(option_labels.get(answer["option_id"]))
            else:
                row.append(answer["value"])
        sheet.append(row)

    buffer = BytesIO()
    workbook.save(buffer)
    return Response(
        content=buffer.getvalue(),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": 'attachment; filename="happiness-answers.xlsx"'
        },
    )
