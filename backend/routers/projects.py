from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import Project, ProjectTag, Tag, TimeEntry
from schemas import (
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
    TagCreate,
    TagOut,
    TagUpdate,
)

router = APIRouter(tags=["Projects"])

TAKEN_MESSAGE = "Name already taken"
"""Returned when a name collides with another of the user's own."""


def own_project(db: DbSession, user: CurrentUser, project_id: int) -> Project:
    """Load one of the signed-in user's projects.

    Public because `routers.time` needs the same lookup: every timer names a
    project, and it has to be one of the caller's.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    project_id : int
        Identifier of the project.

    Returns
    -------
    Project
        The project, with its tags loaded.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the project does not exist or belongs to someone
        else. Another user's project is missing, not forbidden: whether it
        exists is not this account's business.
    """
    project = db.execute(
        select(Project)
        .options(selectinload(Project.tags))
        .where(Project.id == project_id, Project.user_id == user.id)
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    return project


def own_tag(db: DbSession, user: CurrentUser, tag_id: int) -> Tag:
    """Load one of the signed-in user's tags.

    Public because `routers.time` needs it too: a tag carries the rule that
    turns its tracked time into reported time.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    tag_id : int
        Identifier of the tag.

    Returns
    -------
    Tag
        The tag.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the tag does not exist or belongs to someone else.
    """
    tag = db.execute(
        select(Tag).where(Tag.id == tag_id, Tag.user_id == user.id)
    ).scalar_one_or_none()
    if tag is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found"
        )
    return tag


def _apply_tags(db: DbSession, user: CurrentUser, project: Project, tag_ids: list[int]):
    """Replace the set of tags covering a project.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    project : Project
        The project being tagged.
    tag_ids : list of int
        The tags it should carry afterwards. Duplicates are ignored.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when one of the tags belongs to someone else.
    """
    wanted = {tag_id: own_tag(db, user, tag_id) for tag_id in set(tag_ids)}
    existing = db.execute(
        select(ProjectTag).where(ProjectTag.project_id == project.id)
    ).scalars()
    for link in existing:
        if link.tag_id in wanted:
            wanted.pop(link.tag_id)
        else:
            db.delete(link)
    for tag_id in wanted:
        db.add(ProjectTag(project_id=project.id, tag_id=tag_id))


@router.get(
    "/projects",
    response_model=list[ProjectOut],
    operation_id="listProjects",
    summary="List projects",
    description="Every project the signed-in account owns, active ones first.",
)
def list_projects(user: CurrentUser, db: DbSession) -> list[Project]:
    """Return the signed-in user's projects in display order.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of Project
        Active projects first, then archived ones, each in position order.
    """
    return (
        db.execute(
            select(Project)
            .options(selectinload(Project.tags))
            .where(Project.user_id == user.id)
            .order_by(Project.active.desc(), Project.position, Project.id)
        )
        .scalars()
        .all()
    )


@router.post(
    "/projects",
    response_model=ProjectOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createProject",
    summary="Create a project",
    description="Add a project to the signed-in account. No editor flag needed.",
)
def create_project(
    payload: ProjectCreate, user: CurrentUser, db: DbSession
) -> Project:
    """Create a project owned by the signed-in user.

    Parameters
    ----------
    payload : ProjectCreate
        The project to create.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Project
        The new project.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the user already has a project of that name.
    """
    project = Project(
        user_id=user.id,
        name=payload.name,
        colour=payload.colour,
        position=payload.position,
        active=True,
    )
    db.add(project)
    if _taken(db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TAKEN_MESSAGE)
    _apply_tags(db, user, project, payload.tag_ids)
    db.commit()
    db.refresh(project)
    return project


def _taken(db: DbSession) -> bool:
    """Flush pending work, reporting a unique-name collision instead of raising.

    The flush is what trips the index, so it happens inside a guard rather than
    at commit time, where it would surface as a 500.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    bool
        True when the flush failed on a uniqueness constraint.
    """
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return True
    return False


@router.put(
    "/projects/{project_id}",
    response_model=ProjectOut,
    operation_id="updateProject",
    summary="Edit a project",
    description=(
        "Rename, recolour, reorder, re-tag or archive a project. Archiving one "
        "whose timer is still running is refused."
    ),
)
def update_project(
    project_id: int, payload: ProjectUpdate, user: CurrentUser, db: DbSession
) -> Project:
    """Edit a project.

    Parameters
    ----------
    project_id : int
        Identifier of the project.
    payload : ProjectUpdate
        Fields to apply. Omitted fields are left alone.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Project
        The updated project.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the name is taken, or when archiving a project
        that still has a session running.
    """
    project = own_project(db, user, project_id)

    if (
        payload.active is False
        and project.active
        and running_entry(db, user, project.id)
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Check out of this project before archiving it",
        )

    for field in ("name", "colour", "position", "active"):
        value = getattr(payload, field)
        if value is not None:
            setattr(project, field, value)
    if _taken(db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TAKEN_MESSAGE)
    if payload.tag_ids is not None:
        _apply_tags(db, user, project, payload.tag_ids)
    db.commit()
    db.refresh(project)
    return project


def running_entry(
    db: DbSession, user: CurrentUser, project_id: int
) -> TimeEntry | None:
    """Return the project's running session, if it has one.

    Shared with `routers.time`, which opens and closes the sessions this finds.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    project_id : int
        Identifier of the project.

    Returns
    -------
    TimeEntry or None
        The open entry, or None when the project's timer is stopped.
    """
    return db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id == user.id,
            TimeEntry.project_id == project_id,
            TimeEntry.ended_at.is_(None),
        )
    ).scalar_one_or_none()


@router.delete(
    "/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteProject",
    summary="Delete a project",
    description=(
        "Remove a project that has never been tracked against. One with "
        "sessions is archived instead, so the hours survive."
    ),
)
def delete_project(project_id: int, user: CurrentUser, db: DbSession) -> None:
    """Delete a project that holds no sessions.

    Parameters
    ----------
    project_id : int
        Identifier of the project.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the project has sessions. Deleting it would take
        the hours with it, so archiving is the only way to retire it.
    """
    project = own_project(db, user, project_id)
    tracked = db.execute(
        select(TimeEntry.id).where(TimeEntry.project_id == project.id).limit(1)
    ).scalar_one_or_none()
    if tracked is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project has tracked time. Archive it instead.",
        )
    db.delete(project)
    db.commit()


@router.get(
    "/tags",
    response_model=list[TagOut],
    operation_id="listTags",
    summary="List tags",
    description="Every tag the signed-in account owns, in display order.",
)
def list_tags(user: CurrentUser, db: DbSession) -> list[Tag]:
    """Return the signed-in user's tags in display order.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of Tag
        The user's tags.
    """
    return (
        db.execute(
            select(Tag)
            .where(Tag.user_id == user.id)
            .order_by(Tag.position, Tag.id)
        )
        .scalars()
        .all()
    )


@router.post(
    "/tags",
    response_model=TagOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createTag",
    summary="Create a tag",
    description="Add a label that projects can be grouped by.",
)
def create_tag(payload: TagCreate, user: CurrentUser, db: DbSession) -> Tag:
    """Create a tag owned by the signed-in user.

    Parameters
    ----------
    payload : TagCreate
        The tag to create.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Tag
        The new tag.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the user already has a tag of that name.
    """
    tag = Tag(
        user_id=user.id,
        name=payload.name,
        colour=payload.colour,
        position=payload.position,
    )
    db.add(tag)
    if _taken(db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TAKEN_MESSAGE)
    db.commit()
    db.refresh(tag)
    return tag


@router.put(
    "/tags/{tag_id}",
    response_model=TagOut,
    operation_id="updateTag",
    summary="Edit a tag",
    description="Rename, recolour or reorder a tag.",
)
def update_tag(
    tag_id: int, payload: TagUpdate, user: CurrentUser, db: DbSession
) -> Tag:
    """Edit a tag.

    Parameters
    ----------
    tag_id : int
        Identifier of the tag.
    payload : TagUpdate
        Fields to apply. Omitted fields are left alone.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Tag
        The updated tag.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the name is taken.
    """
    tag = own_tag(db, user, tag_id)
    for field in ("name", "colour", "position"):
        value = getattr(payload, field)
        if value is not None:
            setattr(tag, field, value)
    if _taken(db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TAKEN_MESSAGE)
    db.commit()
    db.refresh(tag)
    return tag


@router.delete(
    "/tags/{tag_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteTag",
    summary="Delete a tag",
    description=(
        "Remove a label. No session references a tag, so this unlabels the "
        "projects it covered and destroys no tracked time."
    ),
)
def delete_tag(tag_id: int, user: CurrentUser, db: DbSession) -> None:
    """Delete a tag.

    Unlike a project, a tag may always be deleted: sessions reference projects
    and never tags, so removing one changes how time is grouped and not what
    was recorded.

    Parameters
    ----------
    tag_id : int
        Identifier of the tag.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    """
    db.delete(own_tag(db, user, tag_id))
    db.commit()
