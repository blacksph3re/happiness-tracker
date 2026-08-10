import math
from datetime import date
from io import BytesIO

from fastapi import APIRouter, HTTPException, Query, Response, status
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import Answer, Question, QuestionOption
from schemas import AnswerDelete, AnswerIn, AnswerOut
from services import prune_system_answers, sync_system_answers

router = APIRouter(prefix="/answers", tags=["answers"])


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
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="An enum question is answered with an option",
            )
        option = db.get(QuestionOption, payload.option_id)
        if option is None or option.question_id != question.id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Option does not belong to this question",
            )
        return

    if payload.value is None or payload.option_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A scaled question is answered with a value",
        )
    # NaN compares false against every bound, so it would slip past the range
    # checks below and only fail at insert time as a 500.
    if not math.isfinite(payload.value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Value must be a finite number",
        )
    if question.min_value is not None and payload.value < question.min_value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Value is below the question's lower bound",
        )
    if question.max_value is not None and payload.value > question.max_value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Value is above the question's upper bound",
        )
    if question.kind == "discrete" and payload.value != int(payload.value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A discrete question takes whole numbers",
        )


@router.put("", status_code=status.HTTP_204_NO_CONTENT)
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


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_answer(payload: AnswerDelete, user: CurrentUser, db: DbSession) -> None:
    """Clear one answer, and the day's auto-tracked rows if it was the last.

    Parameters
    ----------
    payload : AnswerDelete
        The day and question to clear.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 403 when the question is auto-tracked, or 404 when it does
        not exist.
    """
    _load_answerable_question(db, payload.question_id)
    answer = db.execute(
        select(Answer).where(
            Answer.user_id == user.id,
            Answer.question_id == payload.question_id,
            Answer.day == payload.day,
        )
    ).scalar_one_or_none()
    if answer is not None:
        db.delete(answer)
        db.flush()
    prune_system_answers(db, user.id, payload.day)
    db.commit()


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


@router.get("", response_model=list[AnswerOut])
def list_answers(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None, alias="from"),
    end: date | None = Query(default=None, alias="to"),
) -> list[Answer]:
    """Return the authenticated user's answers, auto-tracked values included.

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
    list of Answer
        Matching answers, never including another user's data.
    """
    return _answers_in_range(db, user.id, start, end)


@router.get("/export.xlsx")
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
    answers = _answers_in_range(db, user.id, start, end)
    question_ids = {answer.question_id for answer in answers}
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

    by_day: dict[date, dict[int, Answer]] = {}
    for answer in answers:
        by_day.setdefault(answer.day, {})[answer.question_id] = answer
    for day in sorted(by_day):
        row: list[object] = [day.isoformat()]
        for question in questions:
            answer = by_day[day].get(question.id)
            if answer is None:
                row.append(None)
            elif answer.option_id is not None:
                row.append(option_labels.get(answer.option_id))
            else:
                row.append(answer.value)
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
