"""Reading tasks, the whole of what can be done to a list, and who can see it.

**There is no ``POST /api/todos``.** Writes to tasks and steps go through
`/api/sync` and nowhere else, exactly as sessions and pomodoros already do,
which is what makes the offline path the only path — so it cannot rot from
disuse. Lists are the exception and are ordinary CRUD, like projects and tags
and for the same reason: a container is not something you make on a train.
Membership is CRUD for the same reason again, and online-only: a list you
cannot see is not one you can queue a write against.

Three resolvers decide what a caller may do, and every handler here goes
through one of them rather than checking for itself:

* `_get_list` — **owner only**, for renaming, recolouring, deleting and
  sharing. A member gets 404 from it, like everybody else.
* `_get_visible_list` — owner **or** member, for reading the roster.
* `visible_list_ids` — the same set as a subquery, for the two collection reads.
"""

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from deps import CurrentUser, DbSession
from models import Todo, TodoList, TodoListMember, User
from schemas import (
    TodoListCreate,
    TodoListMemberCreate,
    TodoListMemberOut,
    TodoListOut,
    TodoListUpdate,
    TodoOut,
    TodoPage,
)
from services import (
    ARCHIVE_PAGE_LIMIT,
    TodoRuleError,
    append_list_rank,
    archived_page,
    lists_for,
    member_list,
    members_of,
    membership,
    open_todos,
    own_list,
)

router = APIRouter(tags=["Todos"])


def list_out(row: TodoList, caller_id: int) -> TodoListOut:
    """Describe one list to the account asking about it.

    Built here rather than read off the row, because one field depends on who
    is asking: `members` is the owner's to see, and a member is told only that
    the list is shared and by whom.

    Parameters
    ----------
    row : TodoList
        The list, with `owner` and `members` loaded.
    caller_id : int
        The account reading it.

    Returns
    -------
    TodoListOut
        The list as this caller sees it.
    """
    held = list(row.members)
    return TodoListOut(
        id=row.id,
        name=row.name,
        kind=row.kind,
        colour=row.colour,
        rank=row.rank,
        owner=row.owner.username,
        shared=bool(held),
        members=[member.user.username for member in held]
        if row.user_id == caller_id
        else None,
    )


def _touch_list(row: TodoList) -> None:
    """Mark a list as written, because its membership changed.

    `/api/changes` has no fingerprint for a membership row — the set a caller
    can see is counted through `todo_lists` — and SQLAlchemy's ``onupdate``
    fires on the row being written, which is never the list. Without this,
    sharing a list moves nothing the **owner's** digest can see and their other
    device keeps showing a roster one name short. The member's own digest moves
    on the count, which is the half that would have hidden it.

    The same reasoning as `_touch_catalogue` in `routers/catalogues.py`, and the
    same mechanism: `flag_modified` rather than re-assigning a field, because
    SQLAlchemy skips a set whose value has not changed, so
    ``row.name = row.name`` emits no UPDATE at all.

    Parameters
    ----------
    row : TodoList
        The list whose watermark should move.
    """
    flag_modified(row, "name")


def _get_list(db: DbSession, user: CurrentUser, list_id: int) -> TodoList:
    """Load a list the signed-in user **owns**.

    The owner check lives here rather than in each handler: five endpoints
    inherit it by construction, and five separate checks would be five chances
    to forget one.

    A *member* of the list gets 404 from here, exactly as a stranger does.
    Renaming, recolouring, deleting and sharing are the owner's alone, and the
    house rule is that anything not yours is missing rather than forbidden — a
    member can see the list on their board and still cannot learn from this
    endpoint that it is a list they are not allowed to rename.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    list_id : int
        Identifier of the list.

    Returns
    -------
    TodoList
        The list.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the list does not exist, belongs to someone else,
        or is merely shared with this caller. Another account's list is
        missing, not forbidden: whether it exists is not this caller's business
        either.
    """
    held = own_list(db, user.id, list_id)
    if held is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="List not found"
        )
    return held


def _get_visible_list(db: DbSession, user: CurrentUser, list_id: int) -> TodoList:
    """Load a list the signed-in user owns **or is a member of**.

    For the reads a member is entitled to. The write handlers use `_get_list`
    instead, which is the narrower of the two.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    list_id : int
        Identifier of the list.

    Returns
    -------
    TodoList
        The list.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when no list this caller can see has that id.
    """
    held = member_list(db, user.id, list_id)
    if held is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="List not found"
        )
    return held


@router.get(
    "/todos",
    response_model=list[TodoOut],
    operation_id="listTodos",
    summary="Read every task outside the archive",
    description=(
        "Every task in every list the caller can see — their own and the ones "
        "shared with them — except the archived ones, with the subtasks nested "
        "inside each. There is no range and no window: an open task from March "
        "is as relevant as one from today, so the collection is read whole and "
        "cached as a whole."
    ),
)
def list_todos(user: CurrentUser, db: DbSession) -> list[Todo]:
    """Return the unarchived tasks of every list the caller can see.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of Todo
        Ordered by rank, with steps eagerly loaded — one query for the tasks
        and one for every step of all of them, never one per task, and never
        one per list either: visibility is a subquery.
    """
    return open_todos(db, user.id)


@router.get(
    "/todos/archive",
    response_model=TodoPage,
    operation_id="listArchivedTodos",
    summary="Read a page of the archive",
    description=(
        "Archived tasks, newest arrival first, capped at 500. Send the `next` "
        "marker back as `before` for the page after. The archive never enters "
        "the device snapshot, which is what keeps the offline footprint bounded "
        "however long the account lives. **The caller's own archive and nothing "
        "else**: an archive cannot be shared, and a cleanup on a shared list "
        "writes into the archive of whoever owns the list."
    ),
)
def list_archived_todos(
    user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=ARCHIVE_PAGE_LIMIT, ge=1, le=ARCHIVE_PAGE_LIMIT),
    before: str | None = Query(default=None),
) -> TodoPage:
    """Return one page of the signed-in account's own archive.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    limit : int, optional
        Most tasks to return, by default and at most 500.
    before : str or None, optional
        A marker from a previous page, or None for the newest.

    Returns
    -------
    TodoPage
        The page and the marker for the one after it, which is null at the end.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when `before` is not a marker this server wrote.
        Refused rather than ignored: a discarded marker returns page one, which
        a caller walking the archive would read as the end and loop on.
    """
    try:
        items, cursor = archived_page(db, user.id, limit, before)
    except TodoRuleError as refusal:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(refusal)
        ) from None
    return TodoPage(items=[TodoOut.model_validate(row) for row in items], next=cursor)


@router.get(
    "/todos/lists",
    response_model=list[TodoListOut],
    operation_id="listTodoLists",
    summary="Read the lists the caller can see",
    description=(
        "Every list the caller owns and every list shared with them, in column "
        "order: their own inbox first, their own archive last, and the ordinary "
        "lists between them by rank — a shared list among them, by the rank its "
        "owner gave it. Branch on `kind` and never on the name: both system "
        "lists can be renamed. `owner` names the account a list belongs to and "
        "`members` is present only in the owner's own view."
    ),
)
def list_todo_lists(user: CurrentUser, db: DbSession) -> list[TodoListOut]:
    """Return every list the signed-in account can see.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of TodoListOut
        In column order, each described as this caller sees it.
    """
    return [list_out(row, user.id) for row in lists_for(db, user.id)]


@router.post(
    "/todos/lists",
    response_model=TodoListOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createTodoList",
    summary="Make a list",
    description=(
        "Create an ordinary list. With no rank it is appended after the last "
        "list but **before** the archive, which is drawn at the far right of "
        "the move-between-lists view."
    ),
)
def create_todo_list(
    payload: TodoListCreate, user: CurrentUser, db: DbSession
) -> TodoListOut:
    """Create one ordinary list for the signed-in account.

    Parameters
    ----------
    payload : TodoListCreate
        Name, colour and optionally where it sorts.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TodoListOut
        The list as stored, owned by the caller and shared with nobody.
    """
    created = TodoList(
        user_id=user.id,
        kind="ordinary",
        name=payload.name,
        colour=payload.colour,
        rank=payload.rank or append_list_rank(db, user.id),
    )
    db.add(created)
    db.commit()
    db.refresh(created)
    return list_out(created, user.id)


@router.put(
    "/todos/lists/{list_id}",
    response_model=TodoListOut,
    operation_id="updateTodoList",
    summary="Rename, recolour or reorder a list",
    description=(
        "Allowed on the two system lists as on any other — the code branches "
        "on `kind` and never reads the name. What may not change is `kind` "
        "itself, which answers `409`."
    ),
)
def update_todo_list(
    list_id: int, payload: TodoListUpdate, user: CurrentUser, db: DbSession
) -> TodoListOut:
    """Change a list's name, colour or position.

    Parameters
    ----------
    list_id : int
        Identifier of the list.
    payload : TodoListUpdate
        The fields to change. Omitted ones are left alone.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TodoListOut
        The list as it now stands.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the list is not the caller's **own** — a member of
        a shared list gets that too, because renaming is the owner's — or 409
        when the payload names a different `kind`. There is no way to make a
        second inbox, and the partial unique index would report the attempt as
        a 500.
    """
    held = _get_list(db, user, list_id)
    if payload.kind is not None and payload.kind != held.kind:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A list cannot change what kind of list it is",
        )
    if payload.name is not None:
        held.name = payload.name
    if payload.colour is not None:
        held.colour = payload.colour
    if payload.rank is not None:
        held.rank = payload.rank
    db.commit()
    db.refresh(held)
    return list_out(held, user.id)


@router.delete(
    "/todos/lists/{list_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteTodoList",
    summary="Delete a list and everything in it",
    description=(
        "Takes the list's tasks and their subtasks with it, and the membership "
        "rows: everybody it was shared with loses it. Archived work is "
        "untouched, because an archived task is in the *archive* list and not "
        "in this one. The inbox and the archive answer `409`, and so does "
        "anybody but the owner asking — with a `404`."
    ),
)
def delete_todo_list(list_id: int, user: CurrentUser, db: DbSession) -> None:
    """Delete one ordinary list, cascading to its tasks and their steps.

    Parameters
    ----------
    list_id : int
        Identifier of the list.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the list is not the caller's own, or 409 when it
        is the inbox or the archive. Neither can be deleted: the inbox is where
        a task with no list lands, and the archive is where *won't do* means
        something.
    """
    held = _get_list(db, user, list_id)
    if held.kind != "ordinary":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"The {held.kind} cannot be deleted",
        )
    # Through the ORM rather than by one DELETE, so the cascade to `todo_steps`
    # runs whatever the connection's foreign-key setting happens to be. A
    # migration connection has them off, and a half-deleted tree is silent.
    for task in list(held.todos):
        db.delete(task)
    db.delete(held)
    db.commit()


def _member_out(row: TodoListMember) -> TodoListMemberOut:
    """Describe one membership row.

    Parameters
    ----------
    row : TodoListMember
        The row, with `user` and `sharer` loaded.

    Returns
    -------
    TodoListMemberOut
        The member, named by account and by username.
    """
    return TodoListMemberOut(
        user_id=row.user_id,
        username=row.user.username,
        added_by=row.sharer.username if row.sharer is not None else None,
        created_at=row.created_at,
    )


@router.get(
    "/todos/lists/{list_id}/members",
    response_model=list[TodoListMemberOut],
    operation_id="listTodoListMembers",
    summary="Read who a list is shared with",
    description=(
        "The owner and every member may read the roster. The **owner is not in "
        "it**: they are `owner` on the list itself, and a row saying somebody "
        "shares a list with themselves is a row this schema cannot hold."
    ),
)
def list_todo_list_members(
    list_id: int, user: CurrentUser, db: DbSession
) -> list[TodoListMemberOut]:
    """Return the membership rows of a list the caller can see.

    Parameters
    ----------
    list_id : int
        Identifier of the list.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of TodoListMemberOut
        Oldest first, empty for a list nobody else holds.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the caller can neither own nor see the list.
    """
    held = _get_visible_list(db, user, list_id)
    return [_member_out(row) for row in members_of(db, held.id)]


@router.post(
    "/todos/lists/{list_id}/members",
    response_model=TodoListMemberOut,
    status_code=status.HTTP_201_CREATED,
    # Declared so the generated client knows both codes carry a member: the
    # handler answers 200 when the row was already there, and a schema naming
    # only 201 would leave a caller to guess what a 200 holds.
    responses={
        status.HTTP_200_OK: {
            "model": TodoListMemberOut,
            "description": "Already a member; nothing was created.",
        }
    },
    operation_id="addTodoListMember",
    summary="Share a list with somebody",
    description=(
        "Owner only; anybody else gets `404`. **Idempotent**: sharing with the "
        "same person twice answers `200` and the row that was already there, "
        "because the owner's intent is already satisfied and a `409` would make "
        "a client handle an error that means success. An unknown username "
        "answers `404`, sharing with yourself `409`, and a system list `409` — "
        "every account has exactly one inbox, and sharing one would make a "
        "member's parsed `#inbox` ambiguous."
    ),
)
def add_todo_list_member(
    list_id: int,
    payload: TodoListMemberCreate,
    user: CurrentUser,
    db: DbSession,
    response: Response,
) -> TodoListMemberOut:
    """Add one member to a list the caller owns.

    Parameters
    ----------
    list_id : int
        Identifier of the list.
    payload : TodoListMemberCreate
        The username to share with.
    user : User
        The authenticated user, who must own the list.
    db : sqlalchemy.orm.Session
        Active database session.
    response : fastapi.Response
        Written to so that a repeat answers 200 rather than claiming to have
        created a second row.

    Returns
    -------
    TodoListMemberOut
        The membership, whether it was just made or already there.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the list is not the caller's own or no such
        username exists, or 409 when the list is a system list or the name is
        the caller's own.
    """
    held = _get_list(db, user, list_id)
    if held.kind != "ordinary":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"The {held.kind} cannot be shared",
        )

    invited = db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none()
    if invited is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    if invited.id == user.id:
        # A conflict rather than a 422: the name is perfectly readable, and
        # what is wrong is the state it would produce — the owner is never a
        # member row, so there is nothing here to store.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A list is already yours; it cannot be shared with you",
        )

    already = membership(db, held.id, invited.id)
    if already is not None:
        response.status_code = status.HTTP_200_OK
        return _member_out(already)

    added = TodoListMember(list_id=held.id, user_id=invited.id, added_by=user.id)
    db.add(added)
    # The digest counts membership through `todo_lists`, so the owner's own
    # watermark has to be moved by hand. See `_touch_list`.
    _touch_list(held)
    db.commit()
    db.refresh(added)
    return _member_out(added)


@router.delete(
    "/todos/lists/{list_id}/members/{member_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="removeTodoListMember",
    summary="Stop sharing a list, or leave one",
    description=(
        "The owner removes anybody; a member removes only themselves, which is "
        "*Leave*. Anything else answers `404`, the owner included — they are not "
        "a member row, so there is nothing to remove them from. The tasks stay "
        "in the list: they belong to the list and not to whoever typed them."
    ),
)
def remove_todo_list_member(
    list_id: int, member_id: int, user: CurrentUser, db: DbSession
) -> None:
    """Remove one member from a list, as its owner or as that member.

    Parameters
    ----------
    list_id : int
        Identifier of the list.
    member_id : int
        The account to remove. Equal to the caller's own id when leaving.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the caller can neither see the list nor is
        entitled to remove that account, or when no such membership exists.
        Never 403: whether the row exists is not that caller's business either.
    """
    held = _get_visible_list(db, user, list_id)
    if held.user_id != user.id and member_id != user.id:
        # A member may leave and may do nothing else. Missing rather than
        # forbidden, as everywhere here.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member not found"
        )

    stored = membership(db, held.id, member_id)
    if stored is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Member not found"
        )

    db.delete(stored)
    # Moves the *owner's* watermark; the leaver's own count drops on its own.
    _touch_list(held)
    db.commit()
