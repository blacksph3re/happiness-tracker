"""The todo rules: the two system lists, fractional ordering, and the reads.

Framework-free, like the other three service modules, and it imports none of
them. What lives here is everything the router and the sync queue both need to
agree about — which list a task is in, where a new one sorts, and how the
archive is paged.

**Three resolvers carry the whole of authorization here**, and which one a
caller wants is the only question it has to answer:

* `own_list` — owned by this caller. Renaming, recolouring, deleting and
  sharing a list, all of which are the owner's alone.
* `member_list` — owned by *or shared with* this caller. Every write to a task.
* `visible_list_ids` — the same set as a subquery, for the reads.

A task belongs to the list it is in rather than to whoever typed it, so nothing
below compares `Todo.user_id` against a caller. That column records who created
the row and is not an authorization fact — see `models.Todo.user_id`. The
archive is the exception that proves the rule: it is per account and never
shared, so `archived_page` scopes on the caller's own archive list and reads
every row in it whoever created them, which is exactly what a member's cleanup
of a shared list writes.
"""

from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime

from sqlalchemy import Select, and_, or_, select
from sqlalchemy.orm import Session, selectinload

from models import ListKind, Todo, TodoList, TodoListMember, TodoStep

ARCHIVE_PAGE_LIMIT = 500
"""Most tasks one archive page may hold, and the default.

About six months at three finished tasks a day, or 200KB of JSON. The archive
is the one collection with no ceiling and the one that never enters the device
snapshot, so it is read a page at a time with a cursor rather than whole.
"""

SYSTEM_LIST_SPECS: tuple[tuple[ListKind, str, str, str], ...] = (
    ("inbox", "Inbox", "tide", "a"),
    ("archive", "Archive", "haze", "z"),
)
"""Kind, name, colour and rank of the two lists every account is given.

**One definition of what the two lists are**, which is the whole point of
provisioning them rather than describing them: `ensure_system_lists` is called
from account creation and from startup, and a migration inserted them for the
accounts that predate the feature.

The ranks pin them to the ends. `"a"` is the zero of the rank encoding — see
`between` — so nothing can sort before the inbox, which is exactly where the
inbox belongs; `"z"` puts the archive at the far right, and `append_list_rank`
keeps new lists between the two.

Both are renameable and recolourable. Nothing in the code ever reads the name.
"""

RANK_DIGITS = "abcdefghijklmnopqrstuvwxyz"
"""The alphabet a rank is written in, lowest first."""

RANK_BASE = 26
"""How many digits a rank has. `RANK_DIGITS` as a number."""

_MIDDLE = RANK_BASE // 2
"""The digit a rank starts from, so the first key has room on both sides."""


class TodoRuleError(ValueError):
    """A todo rule the caller broke, reported as a 422 rather than a 500."""


def _digits(key: str) -> list[int]:
    """Read a rank as its digit values.

    Parameters
    ----------
    key : str
        A rank, which must be lowercase ``a``-``z``.

    Returns
    -------
    list of int
        One value per character, ``a`` being 0.

    Raises
    ------
    TodoRuleError
        If the key holds anything but lowercase letters.
    """
    if any(char not in RANK_DIGITS for char in key):
        raise TodoRuleError(f"{key!r} is not an ordering key")
    return [ord(char) - 97 for char in key]


def _spell(digits: list[int]) -> str:
    """Write digit values back as a rank.

    Parameters
    ----------
    digits : list of int
        Values in ``0``-``25``.

    Returns
    -------
    str
        The rank.
    """
    return "".join(RANK_DIGITS[digit] for digit in digits)


def _trimmed(digits: list[int]) -> list[int]:
    """Drop trailing zeros, which a rank's value does not depend on.

    ``"an"`` and ``"ana"`` are the same fraction, so comparing them as written
    would call one smaller than the other and the search for a midpoint between
    them would never terminate.

    Parameters
    ----------
    digits : list of int
        Digit values.

    Returns
    -------
    list of int
        The same value with no trailing zeros.
    """
    end = len(digits)
    while end and digits[end - 1] == 0:
        end -= 1
    return digits[:end]


def _after(before: str) -> str:
    """Return the shortest tidy key above `before`, with no upper bound.

    Incrementing the last digit is enough, because nothing is above `before`
    to collide with. Trailing ``z`` digits are dropped first, so ``"az"`` becomes
    ``"b"`` rather than ``"azn"`` — greater *and* shorter.

    Parameters
    ----------
    before : str
        The current last key.

    Returns
    -------
    str
        A key that sorts strictly after it.
    """
    digits = _digits(before)
    while digits and digits[-1] == RANK_BASE - 1:
        digits.pop()
    if not digits:
        # Every digit was a `z`, so there is nothing to carry into. One more
        # character is the only way up.
        return before + RANK_DIGITS[_MIDDLE]
    digits[-1] += 1
    return _spell(digits)


def _before(after: str) -> str:
    """Return the highest tidy key below `after`, with no lower bound.

    The mirror of `_after`: decrement the last significant digit. A digit that
    would become zero cannot end a key — a key ending in ``a`` is the same
    value as the key without it — so the result descends one character instead,
    which is how ``"b"`` becomes ``"an"``.

    Parameters
    ----------
    after : str
        The current first key.

    Returns
    -------
    str
        A key that sorts strictly before it.

    Raises
    ------
    TodoRuleError
        If `after` is written entirely in ``a``. That is the zero of this
        encoding and nothing sorts below it — which is deliberate for the one
        such rank in the database, the inbox's, since the inbox belongs at the
        left-hand end. `between` never produces such a key, so this cannot be
        reached by its own output.
    """
    digits = _trimmed(_digits(after))
    if not digits:
        raise TodoRuleError(f"nothing sorts before {after!r}")
    digits[-1] -= 1
    if digits[-1] == 0:
        digits.append(_MIDDLE)
    return _spell(digits)


def _midpoint(before: str, after: str) -> str:
    """Return a key strictly between two that already exist.

    Walks the two keys digit by digit. Where the digits are equal the answer
    must share them; where they differ by more than one there is room for a
    digit in between and the walk stops; where they differ by exactly one the
    answer takes the lower digit and everything after it is then free, because
    the prefix alone already puts the result below `after`.

    Parameters
    ----------
    before : str
        The lower neighbour.
    after : str
        The upper neighbour.

    Returns
    -------
    str
        A key sorting strictly between them, or `before` extended when the two
        are equal in value or the wrong way round — two devices inserting
        offline into one gap can produce the same key twice, and nothing sorts
        between a key and itself. The order is ``(rank, client_id)``, so the
        identity settles what is left.
    """
    low = _trimmed(_digits(before))
    high: list[int] | None = _trimmed(_digits(after))
    if high <= low:
        return before + RANK_DIGITS[_MIDDLE]

    out: list[int] = []
    index = 0
    while True:
        here = low[index] if index < len(low) else 0
        # Past the end of `after` cannot happen while it is still a bound: it
        # would mean `before` shares the whole of it as a prefix, which is the
        # `high <= low` case above.
        ceiling = RANK_BASE if high is None else high[index]
        if ceiling - here > 1:
            out.append((here + ceiling) // 2)
            return _spell(out)
        out.append(here)
        if ceiling - here == 1:
            # Strictly below `after` from here on, so the rest is unbounded.
            high = None
        index += 1


def between(before: str | None = None, after: str | None = None) -> str:
    """Return an ordering key that sorts between two others.

    Total by construction: between any two distinct keys there is always
    another, because a key can always grow one more digit, and the function
    never consults a length limit. So the bad outcome is not failure but keys
    that keep getting longer, and the answer to that is the rebalance a drag
    performs on its own column — not a bound here.

    Ported to JavaScript for the client, which computes the key a drop lands
    on, so it is kept deliberately simple and deterministic.

    Parameters
    ----------
    before : str or None, optional
        The key the result must sort after, or None for the start of the list.
    after : str or None, optional
        The key the result must sort before, or None for the end of it.

    Returns
    -------
    str
        The new key. Never ends in ``a``, which is what keeps prepending
        possible for ever: a key written entirely in ``a`` is this encoding's
        zero and has nothing below it.

    Raises
    ------
    TodoRuleError
        If either key holds a character outside ``a``-``z``, or if `before` is
        absent and `after` is this encoding's zero. See `_before`.
    """
    before = before or None
    after = after or None
    if before is None and after is None:
        return RANK_DIGITS[_MIDDLE]
    if after is None:
        return _after(before)
    if before is None:
        return _before(after)
    return _midpoint(before, after)


def system_list(db: Session, user_id: int, kind: ListKind) -> TodoList | None:
    """Return one of an account's two special lists.

    Looked up by `kind` and never by name, because both are renameable.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose list to find.
    kind : ListKind
        ``"inbox"`` or ``"archive"``. ``"ordinary"`` has no single answer and
        returns whichever row the database offers first.

    Returns
    -------
    TodoList or None
        The list, or None where the account has never been provisioned.
    """
    return (
        db.execute(
            select(TodoList).where(TodoList.user_id == user_id, TodoList.kind == kind)
        )
        .scalars()
        .first()
    )


def ensure_system_lists(db: Session, user_id: int) -> tuple[TodoList, TodoList]:
    """Give an account an inbox and an archive if it has none.

    Insert-if-absent, and safe to call as often as anything likes: the partial
    unique index on ``(user_id, kind)`` is what makes that true rather than the
    care taken here, which matters because it holds for a call site added later
    by somebody who never read this function.

    Not committed. The caller decides when, because both call sites are in the
    middle of building an account.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The account to provision.

    Returns
    -------
    tuple of (TodoList, TodoList)
        The inbox and the archive, in that order, whether they were just
        created or already there.
    """
    built = []
    for kind, name, colour, rank in SYSTEM_LIST_SPECS:
        held = system_list(db, user_id, kind)
        if held is None:
            held = TodoList(
                user_id=user_id, kind=kind, name=name, colour=colour, rank=rank
            )
            db.add(held)
            # Flushed per list, so the second lookup sees the first insert and
            # the caller gets rows with ids on them.
            db.flush()
        built.append(held)
    return built[0], built[1]


def _column_order(row: TodoList, user_id: int) -> tuple[int, str, int]:
    """Return the sort key placing one list in a caller's column order.

    Kind first, then rank, then identity. Rank alone very nearly does it — the
    inbox holds this encoding's zero and the archive holds ``"z"`` — but "very
    nearly" is a coincidence rather than a guarantee: both ranks are editable,
    and a *shared* list carries the rank its owner gave it, which this caller
    never chose. Sorting on kind first makes the two ends a fact.

    A shared list is always ordinary, so it sorts among the caller's own
    ordinary lists by its owner's rank, with the id settling a tie.

    Parameters
    ----------
    row : TodoList
        The list to place.
    user_id : int
        The caller, whose inbox and archive are the two ends.

    Returns
    -------
    tuple of (int, str, int)
        The sort key.
    """
    if row.user_id == user_id and row.kind == "inbox":
        place = 0
    elif row.user_id == user_id and row.kind == "archive":
        place = 2
    else:
        place = 1
    return place, row.rank, row.id


def lists_for(db: Session, user_id: int) -> list[TodoList]:
    """Return every list a caller can see, in column order.

    Their own, and the ones shared with them. The owner and the membership rows
    come with it, loaded in two further statements for all the lists at once:
    the reply names the owner of every list and the roster of the caller's own,
    and a relationship left lazy would be one query per list to say so.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose board to read.

    Returns
    -------
    list of TodoList
        The caller's own inbox first and their own archive last, with the
        ordinary lists and the shared ones between them by rank.
    """
    held = list(
        db.execute(
            select(TodoList)
            .where(TodoList.id.in_(visible_list_ids(user_id)))
            .options(
                selectinload(TodoList.owner),
                selectinload(TodoList.members).selectinload(TodoListMember.user),
            )
        )
        .unique()
        .scalars()
    )
    return sorted(held, key=lambda row: _column_order(row, user_id))


def own_list(db: Session, user_id: int, list_id: int) -> TodoList | None:
    """Return a list this caller **owns**, or None for anybody else's.

    The narrower of the two, for what only an owner may do: rename, recolour,
    reorder, delete, and decide who else can see it. A *member* gets None here
    and therefore a 404 — whether the list exists is not that caller's business
    either, even though they can see it on their own board.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The caller.
    list_id : int
        Identifier of the list.

    Returns
    -------
    TodoList or None
        The list, or None when it does not exist, belongs to someone else, or
        is merely shared with this caller — deliberately indistinguishable.
    """
    return db.execute(
        select(TodoList).where(TodoList.id == list_id, TodoList.user_id == user_id)
    ).scalar_one_or_none()


def member_list(db: Session, user_id: int, list_id: int) -> TodoList | None:
    """Return a list this caller owns **or is a member of**, or None.

    The resolver every write to a *task* goes through, because a task belongs
    to its list: a member may add, edit, tick, drag and delete tasks in a list
    somebody else owns. One ``OR`` rather than two queries, which is what the
    owner not being a member row buys.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The caller.
    list_id : int
        Identifier of the list.

    Returns
    -------
    TodoList or None
        The list, or None when this caller cannot see it — which is what a
        member removed while offline gets, and why their queued edits come back
        as *that list no longer exists*.
    """
    return db.execute(
        select(TodoList).where(
            TodoList.id == list_id,
            or_(
                TodoList.user_id == user_id,
                TodoList.id.in_(
                    select(TodoListMember.list_id).where(
                        TodoListMember.user_id == user_id
                    )
                ),
            ),
        )
    ).scalar_one_or_none()


def visible_list_ids(user_id: int) -> Select[tuple[int]]:
    """Build the subquery naming every list a caller can see.

    Their own, and the ones shared with them. One spelling, because every read
    in this module is defined against it and a condition written twice is two
    places for the board and the digest to disagree about what a caller holds.

    A subquery rather than a fetched list of ids, as `_archive_list_ids` is, so
    a read stays one round trip however many lists are involved — which is
    asserted from outside by `shared tasks come back without a query per list`.
    There is no session parameter for the same reason: nothing is executed here.

    Parameters
    ----------
    user_id : int
        The caller.

    Returns
    -------
    sqlalchemy.Select
        A select of list ids.
    """
    return select(TodoList.id).where(
        or_(
            TodoList.user_id == user_id,
            TodoList.id.in_(
                select(TodoListMember.list_id).where(TodoListMember.user_id == user_id)
            ),
        )
    )


def members_of(db: Session, list_id: int) -> list[TodoListMember]:
    """Return a list's membership rows, oldest first, with the accounts loaded.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    list_id : int
        Identifier of the list.

    Returns
    -------
    list of TodoListMember
        The rows, each carrying the member's account and whoever shared it.
    """
    return list(
        db.execute(
            select(TodoListMember)
            .where(TodoListMember.list_id == list_id)
            .order_by(TodoListMember.id)
            .options(
                selectinload(TodoListMember.user),
                selectinload(TodoListMember.sharer),
            )
        )
        .unique()
        .scalars()
    )


def membership(db: Session, list_id: int, user_id: int) -> TodoListMember | None:
    """Return one membership row, or None when that account is not a member.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    list_id : int
        Identifier of the list.
    user_id : int
        The account to look for. The list's **owner** is never a member row, so
        this answers None for them.

    Returns
    -------
    TodoListMember or None
        The row, or None.
    """
    return db.execute(
        select(TodoListMember).where(
            TodoListMember.list_id == list_id, TodoListMember.user_id == user_id
        )
    ).scalar_one_or_none()


def append_list_rank(db: Session, user_id: int) -> str:
    """Return a rank placing a new list after the last one but before the archive.

    The archive is drawn at the far right of the move-between-lists view, so
    appending *after* it would put every new list beyond the end of the board.

    Measured over the caller's **own** lists, which is narrower than what
    `lists_for` returns now that a list can be shared. A shared list carries
    the rank its owner gave it, and nothing stops that rank sorting past this
    caller's archive — measured over the visible set, one such list put every
    new list of this account's beyond the end of its own board. Reproduced
    before it was fixed, at `zzn` against an archive at `z`.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose lists to measure.

    Returns
    -------
    str
        The new rank.
    """
    own = [row for row in lists_for(db, user_id) if row.user_id == user_id]
    archive = next((row for row in own if row.kind == "archive"), None)
    others = [row for row in own if row is not archive]
    return between(
        others[-1].rank if others else None,
        archive.rank if archive else None,
    )


def append_todo_rank(db: Session, list_id: int) -> str:
    """Return a rank placing a task at the end of its list.

    The fallback for a task that arrives without one. The client computes the
    rank a drop lands on, so this is reached only by a write that never named a
    position — a task created by the pomodoro handover, say.

    Measured over the **list** and not over whoever created what is in it: on a
    shared list the last card may be somebody else's, and appending after only
    your own would land on top of theirs.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    list_id : int
        The list the task is going into.

    Returns
    -------
    str
        The new rank.
    """
    last = db.execute(
        select(Todo.rank)
        .where(Todo.list_id == list_id)
        .order_by(Todo.rank.desc())
        .limit(1)
    ).scalar_one_or_none()
    return between(last, None)


def find_todo(db: Session, user_id: int, client_id: str) -> Todo | None:
    """Return a task this caller can see, by the identity its device gave it.

    Resolved through the **lists** the caller can see and never through
    `Todo.user_id`: a task in a shared list belongs to the list, so the member
    who edits it is usually not the account that created it. That is also why
    `client_id` is globally unique — keyed per user, this lookup would miss a
    co-member's task and the caller's next write would insert a second row for
    it.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The caller.
    client_id : str
        The device's identity for the task.

    Returns
    -------
    Todo or None
        The task, or None when no list this caller can see holds it.
    """
    return db.execute(
        select(Todo).where(
            Todo.client_id == client_id,
            Todo.list_id.in_(visible_list_ids(user_id)),
        )
    ).scalar_one_or_none()


def identity_is_taken(db: Session, client_id: str) -> bool:
    """Whether any task at all already carries this device identity.

    Deliberately blind to who is asking, which is the only function here that
    is. `todos.client_id` is unique **globally** now, so a caller who cannot
    see the row that holds an identity still cannot insert a second one — and
    an insert that collides raises an `IntegrityError` out of the middle of a
    queue drain, failing every intent behind it rather than the one that was
    wrong. Asked before the insert, the same case is one intent's refusal.

    The only way to reach a taken identity with nothing visible under it is to
    name a list of your own while the task sits in a list you cannot see: a
    member removed from a shared list, or a stranger who guessed a UUID.
    Neither has a write here to make.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    client_id : str
        The device's identity for a task.

    Returns
    -------
    bool
        True when some task already holds it.
    """
    return (
        db.execute(
            select(Todo.id).where(Todo.client_id == client_id).limit(1)
        ).scalar_one_or_none()
        is not None
    )


def find_step(db: Session, user_id: int, client_id: str) -> TodoStep | None:
    """Return a step this caller can see, by the identity its device gave it.

    A step is reached through its task, which is also why its client id is
    unique per task rather than per account: the join is the scope. Sharing
    changed only what the join tests — the task's *list*, not who created it.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The caller.
    client_id : str
        The device's identity for the step.

    Returns
    -------
    TodoStep or None
        The step, or None when no task this caller can see holds it.
    """
    return (
        db.execute(
            select(TodoStep)
            .join(Todo, Todo.id == TodoStep.todo_id)
            .where(
                TodoStep.client_id == client_id,
                Todo.list_id.in_(visible_list_ids(user_id)),
            )
        )
        .scalars()
        .first()
    )


def _archive_list_ids(user_id: int) -> Select[tuple[int]]:
    """Build the subquery naming an account's archive list.

    One spelling, because the two collections are defined against each other:
    `open_todos` is everything *not* in it and `archived_page` everything in it,
    so a condition written twice is two places for the pair to stop being
    complementary and a task to fall into neither read or both.

    A subquery rather than a fetched id, so both callers stay one round trip.

    Per **account**, and it stays that way under sharing: an archive is a system
    list and a system list cannot be shared, so the caller's own archive is the
    only archive that can be inside `visible_list_ids` at all. What a member's
    cleanup of a shared list writes is a row in the *owner's* archive, which is
    the owner's to read and not this caller's.

    Parameters
    ----------
    user_id : int
        Whose archive to name.

    Returns
    -------
    sqlalchemy.Select
        A select of list ids, holding one row for a provisioned account.
    """
    return select(TodoList.id).where(
        TodoList.user_id == user_id, TodoList.kind == "archive"
    )


def _outside_archive(user_id: int) -> Select[tuple[Todo]]:
    """Build the query for every unarchived task a caller can see.

    By list on both halves, and by nothing else: a task in a shared list is
    read by every member whoever created it.

    Parameters
    ----------
    user_id : int
        The caller.

    Returns
    -------
    sqlalchemy.Select
        The query, unordered.
    """
    return select(Todo).where(
        Todo.list_id.in_(visible_list_ids(user_id)),
        Todo.list_id.notin_(_archive_list_ids(user_id)),
    )


def open_todos(db: Session, user_id: int) -> list[Todo]:
    """Return every task a caller can see outside the archive, steps loaded.

    There is no range and deliberately no cache key shaped like one: history is
    unbounded and irrelevant for sessions, but an open task from March is
    neither, so this collection is read whole.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        The caller. Their own lists and every list shared with them.

    Returns
    -------
    list of Todo
        Ordered by rank, then by the identity that breaks a tie.
    """
    return list(
        db.execute(
            _outside_archive(user_id).order_by(Todo.rank, Todo.client_id, Todo.id)
        )
        .unique()
        .scalars()
    )


def encode_cursor(archived_at: datetime, todo_id: int) -> str:
    """Pack an archive position into one opaque string.

    Both halves, never the timestamp alone: several tasks can be archived in
    the same instant — a cleanup archives a whole list at once — and a cursor
    that named only the time would either repeat them or skip them at a page
    boundary.

    Parameters
    ----------
    archived_at : datetime.datetime
        When the last task on the page arrived in the archive.
    todo_id : int
        That task's primary key.

    Returns
    -------
    str
        A cursor to hand back as ``before``.
    """
    raw = f"{archived_at.isoformat()}|{todo_id}".encode()
    return urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, int]:
    """Unpack a cursor produced by `encode_cursor`.

    Parameters
    ----------
    cursor : str
        The opaque string from a previous page.

    Returns
    -------
    tuple of (datetime.datetime, int)
        The position it names.

    Raises
    ------
    TodoRuleError
        If the cursor is not one this server wrote. Refused rather than
        ignored: a silently discarded cursor returns page one, which a caller
        paging through an archive would read as the end of it and loop.
    """
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        when, _, todo_id = urlsafe_b64decode(padded.encode()).decode().rpartition("|")
        return datetime.fromisoformat(when), int(todo_id)
    except (ValueError, UnicodeDecodeError) as broken:
        raise TodoRuleError("That is not a page marker from this archive") from broken


def archived_page(
    db: Session, user_id: int, limit: int, before: str | None = None
) -> tuple[list[Todo], str | None]:
    """Return one page of the archive, newest arrival first.

    Ordered by `Todo.archived_at` and not by `updated_at`, which would reorder
    the archive whenever an archived task was edited, nor by `done_at`, which
    is absent on everything marked *won't do*.

    Nothing can be dragged within the archive, so there is no rank to read
    here: a task arrives by being finished or abandoned, never by being placed.

    The caller's **own** archive and nothing else, which is what keeps a shared
    list's history private to the account that owns the list.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose archive to read.
    limit : int
        Most tasks to return.
    before : str or None, optional
        A cursor from a previous page, or None for the newest.

    Returns
    -------
    tuple of (list of Todo, str or None)
        The page, and the cursor for the one after it or None at the end.

    Raises
    ------
    TodoRuleError
        If `before` is not a cursor this server wrote.
    """
    # By list alone. A member's cleanup of a shared list writes rows into this
    # archive with their own id on them, and the owner has to be able to read
    # what landed in their archive whoever put it there.
    query = select(Todo).where(Todo.list_id.in_(_archive_list_ids(user_id)))
    if before is not None:
        when, todo_id = decode_cursor(before)
        query = query.where(
            or_(
                Todo.archived_at < when,
                and_(Todo.archived_at == when, Todo.id < todo_id),
            )
        )
    # One more than asked for, so "is there another page" is answered without a
    # second count — and so the cursor is only handed back when there is one.
    rows = list(
        db.execute(
            query.order_by(Todo.archived_at.desc(), Todo.id.desc()).limit(limit + 1)
        )
        .unique()
        .scalars()
    )
    page = rows[:limit]
    more = len(rows) > limit
    cursor = (
        encode_cursor(page[-1].archived_at, page[-1].id)
        if more and page and page[-1].archived_at is not None
        else None
    )
    return page, cursor
