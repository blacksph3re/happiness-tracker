from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from deps import CurrentUser, DbSession, EditorUser
from models import Answer, Catalogue, Question, QuestionOption
from schemas import (
    CatalogueCreate,
    CatalogueDetail,
    CatalogueOut,
    OptionCreate,
    OptionUpdate,
    QuestionCreate,
    QuestionOut,
    QuestionUpdate,
)
from services import create_catalogue, question_is_answered

router = APIRouter(tags=["Catalogue"])

FROZEN_MESSAGE = (
    "This question has already been answered, so its scale and its set of "
    "options are fixed. Wording can still be changed; to rescale it, deactivate "
    "this question and create a new one."
)
"""Explanation returned when an edit would change an answered question's shape."""


def _get_catalogue(db: DbSession, catalogue_id: int) -> Catalogue:
    """Load a catalogue or raise a 404.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    catalogue_id : int
        Identifier of the catalogue.

    Returns
    -------
    Catalogue
        The requested catalogue.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when no such catalogue exists.
    """
    catalogue = db.get(Catalogue, catalogue_id)
    if catalogue is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Catalogue not found"
        )
    return catalogue


def _get_question(db: DbSession, question_id: int) -> Question:
    """Load an editable question or raise.

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
        With status 404 when the question does not exist, or 403 when it is one
        of the server-owned auto-tracked questions.
    """
    question = db.get(Question, question_id)
    if question is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Question not found"
        )
    if question.is_system:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Auto-tracked questions cannot be edited",
        )
    return question


@router.get(
    "/catalogues",
    response_model=list[CatalogueOut],
    operation_id="listCatalogues",
    summary="List catalogues",
    description="List every catalogue by name. Open to any signed-in user.",
)
def list_catalogues(user: CurrentUser, db: DbSession) -> list[Catalogue]:
    """List every catalogue by name.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of Catalogue
        All catalogues, ordered by name.
    """
    return list(db.execute(select(Catalogue).order_by(Catalogue.name)).scalars().all())


@router.get(
    "/catalogues/{catalogue_id}",
    response_model=CatalogueDetail,
    operation_id="getCatalogue",
    summary="Get a catalogue with its questions",
    description=(
        "Return a catalogue with every question, option, bound and label. This "
        "is the single request the questionnaire makes at page load."
    ),
)
def read_catalogue(catalogue_id: int, user: CurrentUser, db: DbSession) -> Catalogue:
    """Return a catalogue with every question it contains.

    This is the single request the questionnaire makes at page load; everything
    after it is a write.

    Parameters
    ----------
    catalogue_id : int
        Identifier of the catalogue.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Catalogue
        The catalogue, with questions and their options attached.
    """
    return _get_catalogue(db, catalogue_id)


@router.post(
    "/catalogues",
    response_model=CatalogueOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createCatalogue",
    summary="Create a catalogue",
    description=(
        "Create a catalogue, seeded with the five auto-tracked questions. "
        "Requires the catalogue-editing permission."
    ),
)
def add_catalogue(
    payload: CatalogueCreate, editor: EditorUser, db: DbSession
) -> Catalogue:
    """Create a catalogue, seeded with its auto-tracked questions.

    Parameters
    ----------
    payload : CatalogueCreate
        The catalogue name.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Catalogue
        The created catalogue.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the name is already taken.
    """
    try:
        # The flush inside create_catalogue is what trips the unique index, so
        # the whole call has to sit inside the guard, not just the commit.
        catalogue = create_catalogue(db, payload.name)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Name already taken"
        ) from None
    db.refresh(catalogue)
    return catalogue


@router.put(
    "/catalogues/{catalogue_id}",
    response_model=CatalogueOut,
    operation_id="renameCatalogue",
    summary="Rename a catalogue",
    description="Change a catalogue's display name.",
)
def rename_catalogue(
    catalogue_id: int, payload: CatalogueCreate, editor: EditorUser, db: DbSession
) -> Catalogue:
    """Rename a catalogue.

    Parameters
    ----------
    catalogue_id : int
        Identifier of the catalogue.
    payload : CatalogueCreate
        The new name.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Catalogue
        The renamed catalogue.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the name is already taken.
    """
    catalogue = _get_catalogue(db, catalogue_id)
    catalogue.name = payload.name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Name already taken"
        ) from None
    db.refresh(catalogue)
    return catalogue


@router.delete(
    "/catalogues/{catalogue_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteCatalogue",
    summary="Delete a catalogue",
    description=(
        "Delete a catalogue and its questions. Refused once any of its "
        "questions has been answered."
    ),
)
def delete_catalogue(catalogue_id: int, editor: EditorUser, db: DbSession) -> None:
    """Delete a catalogue and its questions.

    Parameters
    ----------
    catalogue_id : int
        Identifier of the catalogue.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when answers reference any of its questions, since
        deleting it would discard recorded history.
    """
    catalogue = _get_catalogue(db, catalogue_id)
    answered = db.execute(
        select(Answer.id)
        .join(Question, Question.id == Answer.question_id)
        .where(Question.catalogue_id == catalogue.id, Question.system_key.is_(None))
        .limit(1)
    ).first()
    if answered is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Catalogue has recorded answers and cannot be deleted",
        )
    db.delete(catalogue)
    db.commit()


@router.post(
    "/catalogues/{catalogue_id}/questions",
    response_model=QuestionOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createQuestion",
    summary="Add a question",
    description=(
        "Add a question to a catalogue. Enum questions need at least two "
        "options and no bounds; scaled questions need an ordered pair of bounds."
    ),
)
def add_question(
    catalogue_id: int, payload: QuestionCreate, editor: EditorUser, db: DbSession
) -> Question:
    """Add a question to a catalogue.

    Parameters
    ----------
    catalogue_id : int
        Catalogue that will own the question.
    payload : QuestionCreate
        The question to create.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The created question.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when the payload does not match the question kind: enum
        questions need at least two options and no bounds, numeric questions
        need an ordered pair of bounds.
    """
    catalogue = _get_catalogue(db, catalogue_id)
    if payload.kind == "enum":
        if len(payload.options) < 2:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="An enum question needs at least two options",
            )
        if payload.min_value is not None or payload.max_value is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="An enum question cannot have bounds",
            )
    else:
        if payload.min_value is None or payload.max_value is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A scaled question needs a lower and an upper bound",
            )
        if payload.min_value >= payload.max_value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The lower bound must be below the upper bound",
            )
        if payload.options:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A scaled question cannot have options",
            )

    question = Question(
        catalogue_id=catalogue.id,
        kind=payload.kind,
        prompt=payload.prompt,
        position=payload.position,
        active=True,
        min_value=payload.min_value,
        max_value=payload.max_value,
        min_label=payload.min_label,
        max_label=payload.max_label,
    )
    db.add(question)
    db.flush()
    for index, option in enumerate(payload.options):
        db.add(
            QuestionOption(
                question_id=question.id,
                label=option.label,
                position=option.position or index,
            )
        )
    db.commit()
    db.refresh(question)
    return question


@router.put(
    "/questions/{question_id}",
    response_model=QuestionOut,
    operation_id="updateQuestion",
    summary="Edit a question",
    description=(
        "Edit a question. Wording, ordering and activation may always change; "
        "the numeric bounds are frozen once the question has been answered."
    ),
)
def update_question(
    question_id: int, payload: QuestionUpdate, editor: EditorUser, db: DbSession
) -> Question:
    """Edit a question, honouring the freeze rule.

    Wording — `prompt`, `min_label` and `max_label` — along with `position` and
    `active` may always change. The numeric bounds may only change while the
    question has no answers, because altering them would silently reinterpret
    every value already recorded.

    Parameters
    ----------
    question_id : int
        Identifier of the question.
    payload : QuestionUpdate
        Fields to apply. Omitted fields are left alone.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The updated question.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when a bound would change on an answered question, or
        422 when the resulting bounds would be inverted.
    """
    question = _get_question(db, question_id)
    # Renaming is not rescaling: a changed label describes the same recorded
    # answers, while a changed bound would silently reinterpret them.
    frozen_fields = {
        "min_value": payload.min_value,
        "max_value": payload.max_value,
    }
    wording_fields = {
        "min_label": payload.min_label,
        "max_label": payload.max_label,
    }
    touches_frozen = any(
        value is not None and value != getattr(question, name)
        for name, value in frozen_fields.items()
    )
    if question.kind == "enum" and (
        payload.min_value is not None or payload.max_value is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="An enum question cannot have bounds",
        )
    if touches_frozen and question_is_answered(db, question.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=FROZEN_MESSAGE)

    if payload.prompt is not None:
        question.prompt = payload.prompt
    if payload.position is not None:
        question.position = payload.position
    if payload.active is not None:
        question.active = payload.active
    for name, value in {**frozen_fields, **wording_fields}.items():
        if value is not None:
            setattr(question, name, value)
    if (
        question.kind != "enum"
        and question.min_value is not None
        and question.max_value is not None
        and question.min_value >= question.max_value
    ):
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The lower bound must be below the upper bound",
        )
    db.commit()
    db.refresh(question)
    return question


@router.post(
    "/questions/{question_id}/options",
    response_model=QuestionOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="addQuestionOption",
    summary="Add an enum option",
    description="Add a choice to an enum question that has no answers yet.",
)
def add_option(
    question_id: int, payload: OptionCreate, editor: EditorUser, db: DbSession
) -> Question:
    """Add a choice to an enum question.

    Parameters
    ----------
    question_id : int
        Identifier of the question.
    payload : OptionCreate
        The choice to add.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The question with its updated option list.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the question has already been answered, or 422
        when it is not an enum question.
    """
    question = _get_question(db, question_id)
    if question.kind != "enum":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only enum questions have options",
        )
    if question_is_answered(db, question.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=FROZEN_MESSAGE)
    db.add(
        QuestionOption(
            question_id=question.id,
            label=payload.label,
            position=payload.position or len(question.options),
        )
    )
    db.commit()
    db.refresh(question)
    return question


@router.delete(
    "/questions/{question_id}/options/{option_id}",
    response_model=QuestionOut,
    operation_id="deleteQuestionOption",
    summary="Remove an enum option",
    description="Remove a choice from an enum question that has no answers yet.",
)
def delete_option(
    question_id: int, option_id: int, editor: EditorUser, db: DbSession
) -> Question:
    """Remove a choice from an unanswered enum question.

    Parameters
    ----------
    question_id : int
        Identifier of the question.
    option_id : int
        Identifier of the option to remove.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The question with its updated option list.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the option does not belong to the question, or 409
        when the question has already been answered.
    """
    question = _get_question(db, question_id)
    if question_is_answered(db, question.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=FROZEN_MESSAGE)
    option = db.get(QuestionOption, option_id)
    if option is None or option.question_id != question.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Option not found"
        )
    db.delete(option)
    db.commit()
    db.refresh(question)
    return question
