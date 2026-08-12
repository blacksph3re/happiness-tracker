from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from deps import CurrentUser, DbSession, EditorUser
from models import (
    ORIGIN_COMPUTED,
    Answer,
    Catalogue,
    Question,
    QuestionOption,
    ScoreComponent,
)
from schemas import (
    CatalogueCreate,
    CatalogueDetail,
    CatalogueOut,
    OptionCreate,
    QuestionCreate,
    QuestionOut,
    QuestionUpdate,
    ScoreCreate,
    ScoreUpdate,
)
from services import (
    QuestionRuleError,
    ScoreRuleError,
    check_question_bounds,
    check_question_shape,
    check_score_shape,
    create_catalogue,
    question_is_answered,
)

router = APIRouter(tags=["Catalogue"])

FROZEN_MESSAGE = (
    "This question has already been answered, so its scale and its set of "
    "options are fixed. Wording can still be changed; to rescale it, deactivate "
    "this question and create a new one."
)
"""Explanation returned when an edit would change an answered question's shape."""


def _enforce(rule) -> None:
    """Run a domain rule, turning its complaint into a 422.

    Keeps the rules themselves free of HTTP concepts: `services` states what a
    question may be, and this is the one place that becomes a status code.

    Parameters
    ----------
    rule : collections.abc.Callable
        A no-argument callable that raises `QuestionRuleError` when unhappy.

    Raises
    ------
    fastapi.HTTPException
        With status 422 carrying the rule's own message.
    """
    try:
        rule()
    except QuestionRuleError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from None


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
    if question.is_computed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A score is edited through the score routes, not as a question",
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
    _enforce(
        lambda: check_question_shape(
            payload.kind, payload.min_value, payload.max_value, len(payload.options)
        )
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
    # Check the bounds the edit would produce, not the ones it arrived with.
    # The option count is deliberately not re-checked here: this endpoint cannot
    # change it, so holding a rename to it would leave a question whose options
    # are missing with no way to put them back.
    _enforce(
        lambda: check_question_bounds(
            question.kind,
            payload.min_value if payload.min_value is not None else question.min_value,
            payload.max_value if payload.max_value is not None else question.max_value,
        )
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
    # No post-assignment bounds check: the same rule already vetted the shape
    # this edit produces, before anything was written.
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


def _enforce_score(rule) -> None:
    """Run a score rule, turning its complaint into a 422.

    The score equivalent of `_enforce`: `services` says what a score may be, and
    this is the one place that becomes a status code.

    Parameters
    ----------
    rule : collections.abc.Callable
        A no-argument callable that raises `ScoreRuleError` when unhappy.

    Raises
    ------
    fastapi.HTTPException
        With status 422 carrying the rule's own message.
    """
    try:
        rule()
    except ScoreRuleError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from None


def _load_components(
    db: DbSession, catalogue_id: int, components: list
) -> list[Question]:
    """Load the questions a score names, refusing any from another catalogue.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    catalogue_id : int
        The catalogue the score belongs to.
    components : list of ScoreComponentIn
        The requested components.

    Returns
    -------
    list of Question
        The questions, in the order requested.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when a component is missing or belongs elsewhere.
    """
    loaded = []
    for component in components:
        question = db.get(Question, component.source_question_id)
        if question is None or question.catalogue_id != catalogue_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A score can only combine questions from its own catalogue",
            )
        loaded.append(question)
    return loaded


def _get_score(db: DbSession, score_id: int) -> Question:
    """Load a score or raise.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    score_id : int
        Identifier of the computed question.

    Returns
    -------
    Question
        The score.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when there is no such score.
    """
    score = db.get(Question, score_id)
    if score is None or not score.is_computed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Score not found"
        )
    return score


@router.post(
    "/catalogues/{catalogue_id}/scores",
    response_model=QuestionOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createScore",
    summary="Define a score",
    description=(
        "Define a value computed from other questions in the same catalogue - a "
        "total or an average, optionally weighted. Scores are never answered and "
        "never stored: they are computed whenever answers are read, so changing a "
        "definition applies to the whole history at once."
    ),
)
def add_score(
    catalogue_id: int, payload: ScoreCreate, editor: EditorUser, db: DbSession
) -> Question:
    """Define a score over other questions in a catalogue.

    Parameters
    ----------
    catalogue_id : int
        Catalogue that will own the score.
    payload : ScoreCreate
        The score to create.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The created score.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when the definition names nothing usable.
    """
    catalogue = _get_catalogue(db, catalogue_id)
    sources = _load_components(db, catalogue.id, payload.components)
    _enforce_score(lambda: check_score_shape(payload.aggregate, sources))

    score = Question(
        catalogue_id=catalogue.id,
        # A score is a scale, so the rest of the app treats it as one; its
        # bounds are derived from the components rather than stored.
        kind="continuous",
        prompt=payload.prompt,
        position=payload.position,
        active=True,
        origin=ORIGIN_COMPUTED,
        aggregate=payload.aggregate,
        require_all=payload.require_all,
        min_value=0.0,
        max_value=1.0,
    )
    db.add(score)
    db.flush()
    for component in payload.components:
        db.add(
            ScoreComponent(
                score_question_id=score.id,
                source_question_id=component.source_question_id,
                weight=component.weight,
            )
        )
    db.commit()
    db.refresh(score)
    return score


@router.put(
    "/scores/{score_id}",
    response_model=QuestionOut,
    operation_id="updateScore",
    summary="Change a score",
    description=(
        "Change a score's name, aggregate, components or completeness rule. The "
        "change applies to every day already recorded, because the score is "
        "computed rather than stored."
    ),
)
def update_score(
    score_id: int, payload: ScoreUpdate, editor: EditorUser, db: DbSession
) -> Question:
    """Change a score's definition.

    Parameters
    ----------
    score_id : int
        Identifier of the score.
    payload : ScoreUpdate
        Fields to apply. Omitted fields are left alone.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Question
        The updated score.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when the result would not describe a usable score.
    """
    score = _get_score(db, score_id)
    aggregate = payload.aggregate or score.aggregate
    sources = (
        _load_components(db, score.catalogue_id, payload.components)
        if payload.components is not None
        else [component.source for component in score.components]
    )
    _enforce_score(lambda: check_score_shape(aggregate, sources))

    if payload.prompt is not None:
        score.prompt = payload.prompt
    if payload.position is not None:
        score.position = payload.position
    if payload.active is not None:
        score.active = payload.active
    if payload.require_all is not None:
        score.require_all = payload.require_all
    score.aggregate = aggregate

    if payload.components is not None:
        score.components.clear()
        db.flush()
        for component in payload.components:
            db.add(
                ScoreComponent(
                    score_question_id=score.id,
                    source_question_id=component.source_question_id,
                    weight=component.weight,
                )
            )
    db.commit()
    db.refresh(score)
    return score


@router.delete(
    "/scores/{score_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteScore",
    summary="Remove a score",
    description=(
        "Remove a score. Nothing recorded is lost, because a score never held "
        "anything of its own."
    ),
)
def delete_score(score_id: int, editor: EditorUser, db: DbSession) -> None:
    """Remove a score definition.

    Parameters
    ----------
    score_id : int
        Identifier of the score.
    editor : User
        The authenticated editor.
    db : sqlalchemy.orm.Session
        Active database session.
    """
    db.delete(_get_score(db, score_id))
    db.commit()
