from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from deps import CurrentUser, DbSession
from models import (
    Answer,
    Catalogue,
    DeductionBand,
    Pomodoro,
    Project,
    Tag,
    TimeEntry,
    Todo,
    TodoList,
    TodoStep,
    User,
)
from schemas import Changes, Fingerprint
from services import visible_list_ids

router = APIRouter(tags=["Sync"])


def _fingerprint(db: Session, entity: type, where: ColumnElement[bool]) -> Fingerprint:
    """Count one collection and find when it last moved.

    The timestamp is nullable on every table, and reads NULL for a row written
    before it had the column. That is not a gap to work around: a collection
    whose newest stamp is NULL is compared on its count alone, which is how all
    of these behaved before the column existed.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    entity : type
        The mapped class to count.
    where : sqlalchemy.sql.elements.ColumnElement
        Restriction narrowing the rows to the ones the caller owns.

    Returns
    -------
    Fingerprint
        The row count, and the newest ``updated_at`` among them or None.
    """
    row = db.execute(
        select(func.count(), func.max(entity.updated_at))
        .select_from(entity)
        .where(where)
    ).one()
    return Fingerprint(n=row[0], at=row[1])


@router.get(
    "/changes",
    response_model=Changes,
    operation_id="getChanges",
    summary="Fingerprint every collection",
    description=(
        "Report how much of each collection the signed-in account has and when "
        "it last moved, so a client can decide what to re-read without reading "
        "any of it. Counts and timestamps together: a timestamp cannot see a "
        "deletion and a count cannot see an edit."
    ),
)
def get_changes(user: CurrentUser, db: DbSession) -> Changes:
    """Report a fingerprint per collection for the authenticated user.

    Cheap by design — eleven aggregates over indexed foreign keys — because the
    common answer is that nothing has moved, and that case has to cost less than
    the re-read it saves. Three of them narrow through the lists the caller can
    see, which is a subquery over two indexed columns rather than a second read.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Changes
        One fingerprint per collection, never counting another account's rows.
    """
    return Changes(
        answers=_fingerprint(db, Answer, Answer.user_id == user.id),
        time_entries=_fingerprint(db, TimeEntry, TimeEntry.user_id == user.id),
        projects=_fingerprint(db, Project, Project.user_id == user.id),
        tags=_fingerprint(db, Tag, Tag.user_id == user.id),
        # Bands hang off a tag rather than a user, so ownership is reached
        # through one. A band whose tag belongs to somebody else is not this
        # account's to hear about.
        rules=_fingerprint(
            db,
            DeductionBand,
            DeductionBand.tag_id.in_(select(Tag.id).where(Tag.user_id == user.id)),
        ),
        pomodoros=_fingerprint(db, Pomodoro, Pomodoro.user_id == user.id),
        catalogues=_fingerprint(db, Catalogue, Catalogue.user_id == user.id),
        # The three todo collections are scoped by **visibility** and not by
        # `user_id`, because a list can be shared: a task edited by one member
        # has to move every other member's fingerprint, or their second device
        # keeps a stale board until somebody reloads the page — the same
        # failure the habit target had. `visible_list_ids` is the one spelling
        # of that set, shared with the reads, so the digest cannot come to
        # disagree with what the board shows.
        todos=_fingerprint(db, Todo, Todo.list_id.in_(visible_list_ids(user.id))),
        # Steps hang off a task rather than a user, so they are reached through
        # one — as a deduction band's is through its tag.
        todo_steps=_fingerprint(
            db,
            TodoStep,
            TodoStep.todo_id.in_(
                select(Todo.id).where(Todo.list_id.in_(visible_list_ids(user.id)))
            ),
        ),
        # Membership is counted here rather than fingerprinted on its own: a
        # list shared with you *appearing* is a change you must see, and it
        # shows up as a count. The owner's side of the same act moves no count
        # at all, which is what `_touch_list` in `routers/todos.py` is for.
        todo_lists=_fingerprint(
            db, TodoList, TodoList.id.in_(visible_list_ids(user.id))
        ),
        # Always exactly one row, so the count says nothing at all and the
        # timestamp carries the whole signal — which is what lets a default
        # catalogue changed on another device reach this one.
        me=_fingerprint(db, User, User.id == user.id),
    )
