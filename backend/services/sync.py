"""Replaying what a device recorded with no connection.

The rules here decide what happens when the same thing was changed in two
places. They are deliberately small and deliberately boring:

* **Latest change wins**, by the clock of the device that made the change —
  never by when the write arrived, or a fortnight-old queued answer would look
  newer than yesterday's correction.
* **A delete never beats an edit**, in either direction. A delete that arrives
  behind a newer edit is dropped; an edit to a session deleted elsewhere brings
  it back. A wrongly kept session is a row to delete again; a wrongly dropped
  one is gone.
* **Ties go to what is already stored**, so replaying an intent twice is a
  no-op.

This module sits in the shared zone because syncing spans both halves — answers
and sessions travel in one queue — and, like ``services/__init__``, it is the
one place allowed to know about both.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    Answer,
    Pomodoro,
    Project,
    Question,
    QuestionOption,
    TimeEntry,
    Todo,
    TodoStep,
)
from schemas import (
    AnswerIn,
    SyncEntryPayload,
    SyncPomodoroPayload,
    SyncStepPayload,
    SyncTodoPayload,
)
from services.pomodoro import PomodoroRuleError, check_pomodoro_shape
from services.timetrack import TimeRuleError, check_entry_shape, check_no_overlap
from services.todos import (
    append_todo_rank,
    between,
    find_step,
    find_todo,
    identity_is_taken,
    member_list,
    system_list,
)
from services.wellbeing import QuestionRuleError, check_answer


class SyncOutcome:
    """The verdicts an intent can receive. See `schemas.SyncResult`."""

    APPLIED = "applied"
    """The server took the change."""

    SUPERSEDED = "superseded"
    """Something newer was already stored, so the change was not needed."""

    MERGED = "merged"
    """The session overlapped another and the two became their union."""

    DROPPED = "dropped"
    """A deletion the server declined to carry out, because an edit outran it."""

    CONFLICT = "conflict"
    """Nothing here can decide it; a person has to."""


def _is_newer(claimed: datetime, stored: datetime | None) -> bool:
    """Whether a device's claimed change time beats what a row already holds.

    Ties are not newer. That is what makes replaying the same intent twice a
    no-op rather than a second write, and it is the only reason the queue can be
    flushed again after a connection drops mid-flush.

    Parameters
    ----------
    claimed : datetime.datetime
        `client_updated_at` from the intent.
    stored : datetime.datetime or None
        What the row carries, or None for a row written before offline support.

    Returns
    -------
    bool
        True when the intent should be applied.
    """
    if stored is None:
        return True
    return claimed > stored


def apply_answer(
    db: Session, user_id: int, claimed: datetime, payload: AnswerIn, now: datetime
) -> tuple[str, str | None]:
    """Store one answered question, keeping whichever version is newer.

    An answer is identified by the day and the question, never by a row id, so
    two devices answering the same question on the same day are the same answer
    and one of them wins.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose answer this is.
    claimed : datetime.datetime
        When the device says the answer was given.
    payload : AnswerIn
        The answer, already validated into its own shape.
    now : datetime.datetime
        Server time, recorded as when this was received.

    Returns
    -------
    tuple of (str, str or None)
        The outcome and, when it is not `applied`, why.
    """
    question = db.get(Question, payload.question_id)
    # Ownership, not merely existence. Catalogues belong to somebody now, and
    # this is the one write path that reaches a question by bare id — without
    # the second half, one account could record answers against another's
    # questions and both would then disagree about whose history it was.
    if question is None or question.catalogue.user_id != user_id:
        return SyncOutcome.CONFLICT, "That question no longer exists"

    # The same bar an answer had to meet when there was an endpoint of its own.
    # A queue is not a way past the rules — it is only a way past the network.
    option = (
        db.get(QuestionOption, payload.option_id)
        if payload.option_id is not None
        else None
    )
    try:
        check_answer(question, option, payload.value, payload.option_id)
    except QuestionRuleError as refusal:
        return SyncOutcome.CONFLICT, str(refusal)

    stored = db.execute(
        select(Answer).where(
            Answer.user_id == user_id,
            Answer.question_id == payload.question_id,
            Answer.day == payload.day,
        )
    ).scalar_one_or_none()

    if stored is not None and not _is_newer(claimed, stored.client_updated_at):
        return SyncOutcome.SUPERSEDED, "A newer answer for that day is already stored"

    fresh = stored is None
    if fresh:
        stored = Answer(
            user_id=user_id, question_id=payload.question_id, day=payload.day
        )

    stored.value = payload.value
    stored.option_id = payload.option_id
    stored.local_hour = payload.local_hour
    stored.client_updated_at = claimed
    stored.server_received_at = now

    if fresh:
        db.add(stored)
    # Flushed before the next intent looks — and after the row is complete, or
    # the constraint that an answer carries exactly one of a value and an option
    # refuses a half-built one. With `autoflush=False`, a queue holding an
    # answer and a correction to it would not find the first when the second
    # went looking, and would insert the same day twice.
    db.flush()
    return SyncOutcome.APPLIED, None


def apply_entry(
    db: Session,
    user_id: int,
    client_id: str,
    claimed: datetime,
    payload: SyncEntryPayload,
    now: datetime,
) -> tuple[str, str | None, TimeEntry | None]:
    """Create or correct one session, by the identity its device gave it.

    Creating and correcting are one operation on purpose: a correction to a
    session another device deleted re-creates it, which is the rule that a
    delete never beats an edit, falling out rather than being special-cased.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose session this is.
    client_id : str
        The device's identity for the session.
    claimed : datetime.datetime
        When the device says the session was last changed.
    payload : SyncEntryPayload
        The session's fields, already validated into their own shape.
    now : datetime.datetime
        Server time, recorded as when this was received.

    Returns
    -------
    tuple of (str, str or None, TimeEntry or None)
        The outcome, why when it is not `applied`, and the row as it stands.
    """
    stored = db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id == user_id, TimeEntry.client_id == client_id
        )
    ).scalar_one_or_none()

    if stored is not None and not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.SUPERSEDED,
            "A newer version of that session is already stored",
            stored,
        )

    project = db.get(Project, payload.project_id)
    if project is None or project.user_id != user_id:
        return SyncOutcome.CONFLICT, "That project no longer exists", None

    entry = stored or TimeEntry(user_id=user_id, client_id=client_id)
    entry.project_id = payload.project_id
    entry.started_at = payload.started_at
    entry.ended_at = payload.ended_at
    entry.utc_offset = payload.utc_offset
    entry.note = payload.note
    entry.client_updated_at = claimed
    entry.server_received_at = now

    try:
        check_entry_shape(entry.started_at, entry.ended_at, entry.utc_offset)
    except TimeRuleError as refusal:
        return SyncOutcome.CONFLICT, str(refusal), None

    others = [
        other
        for other in db.execute(
            select(TimeEntry).where(
                TimeEntry.user_id == user_id,
                TimeEntry.project_id == entry.project_id,
            )
        ).scalars()
        if other.client_id != client_id
    ]

    outcome = SyncOutcome.APPLIED
    detail = None
    try:
        check_no_overlap(entry, others)
    except TimeRuleError:  # noqa: BLE001 - the overlap is the expected path here
        # Their union, not a refusal: sessions that overlap have no gap between
        # them, so joining them invents no minute that was not tracked. This is
        # the same trade `merge_overlapping` already makes online.
        swallowed = [other for other in others if _overlaps(entry, other)]
        outcome, detail = _merge_into(entry, swallowed, db)

    if stored is None:
        db.add(entry)
    # The deletions a merge makes have to reach the database before the row that
    # swallowed them: at most one session per project may be open at a time, and
    # inserting the survivor first trips that index as a 500 rather than
    # merging. `_merge_into` marks them; this is where the order is enforced.
    db.flush()
    return outcome, detail, entry


def _overlaps(entry: TimeEntry, other: TimeEntry) -> bool:
    """Whether two sessions cover any of the same minutes.

    A running session is treated as reaching to the end of time, which is what
    makes checking into a project twice a collision rather than two rows.

    Parameters
    ----------
    entry : models.TimeEntry
        The session being written.
    other : models.TimeEntry
        A session already stored on the same project.

    Returns
    -------
    bool
        True when they share any interval.
    """
    ends = entry.ended_at or datetime.max
    other_ends = other.ended_at or datetime.max
    return entry.started_at < other_ends and other.started_at < ends


def _merge_into(
    entry: TimeEntry, swallowed: list[TimeEntry], db: Session
) -> tuple[str, str]:
    """Widen `entry` to cover everything it overlaps, and remove what it ate.

    Parameters
    ----------
    entry : models.TimeEntry
        The session being written, modified in place.
    swallowed : list of models.TimeEntry
        The sessions it overlaps, which are deleted.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    tuple of (str, str)
        The `merged` outcome and a description naming what was joined.
    """
    spans = []
    for other in swallowed:
        entry.started_at = min(entry.started_at, other.started_at)
        # One running session absorbs the other's open end rather than closing
        # it: the timer is still going, and inventing a stop is not this
        # function's business.
        if entry.ended_at is not None and other.ended_at is None:
            entry.ended_at = None
        elif entry.ended_at is not None:
            entry.ended_at = max(entry.ended_at, other.ended_at)
        ends = f"{other.ended_at:%H:%M}" if other.ended_at else "running"
        spans.append(f"{other.started_at:%Y-%m-%d %H:%M}–{ends}")
        db.delete(other)
    # Flushed here rather than left to the caller's insert: the survivor cannot
    # be written while a session it swallowed is still open on the same project.
    db.flush()
    return (
        SyncOutcome.MERGED,
        "Overlapped an existing session and was merged into one covering both: "
        + ", ".join(spans),
    )


def delete_entry(
    db: Session, user_id: int, client_id: str, claimed: datetime
) -> tuple[str, str | None]:
    """Remove one session, unless something newer happened to it.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose session this is.
    client_id : str
        The device's identity for the session.
    claimed : datetime.datetime
        When the device says the deletion was made.

    Returns
    -------
    tuple of (str, str or None)
        The outcome and, when the deletion was not carried out, why.
    """
    stored = db.execute(
        select(TimeEntry).where(
            TimeEntry.user_id == user_id, TimeEntry.client_id == client_id
        )
    ).scalar_one_or_none()

    # Already gone, here or elsewhere. Replaying a deletion is a no-op rather
    # than an error, which is what lets a queue be flushed twice safely.
    if stored is None:
        return SyncOutcome.APPLIED, None

    if not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.DROPPED,
            "That session was changed elsewhere after it was deleted here, so it "
            "was kept",
        )

    db.delete(stored)
    return SyncOutcome.APPLIED, None


def apply_pomodoro(
    db: Session,
    user_id: int,
    client_id: str,
    claimed: datetime,
    payload: SyncPomodoroPayload,
    now: datetime,
) -> tuple[str, str | None, Pomodoro | None]:
    """Record or correct one pomodoro from a device's queue.

    One kind for both, as `apply_entry` is: a correction to a pomodoro another
    device deleted re-creates it, which falls out rather than being special-cased.

    Unlike a session, nothing here checks for a collision with what is already
    stored. Pomodoros are not tracked time — they become time only when somebody
    presses the transfer button — so two that overlap are a device replaying its
    queue, not a double count.

    A pomodoro already copied to a project is edited like any other. The session
    it produced does not follow, and that is the accepted trade: the transfer is
    a copy and was never a link, so the alternative is a row nobody can correct
    for the sake of an agreement that was never promised.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose pomodoro this is.
    client_id : str
        The device's identity for it.
    claimed : datetime.datetime
        When the device says the change was made.
    payload : schemas.SyncPomodoroPayload
        The pomodoro as the device holds it.
    now : datetime.datetime
        The server's clock, recorded on the row.

    Returns
    -------
    tuple of (str, str or None, Pomodoro or None)
        The outcome, why when it was not applied, and the row as it now stands.
    """
    stored = db.execute(
        select(Pomodoro).where(
            Pomodoro.user_id == user_id, Pomodoro.client_id == client_id
        )
    ).scalar_one_or_none()

    if stored is not None and not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.SUPERSEDED,
            "A newer version of that pomodoro is already stored",
            stored,
        )

    # The task the timer names, resolved from the identity its device gave it
    # rather than from a primary key the device cannot know. Visibility, not
    # merely existence: `find_todo` resolves through the lists this caller can
    # see, so a pomodoro cannot point at a task in a list nobody shared with
    # them and read its title back — and a member removed from a list gets
    # *that task no longer exists* for the block they had queued against it.
    todo = None
    if payload.todo_client_id is not None:
        todo = find_todo(db, user_id, payload.todo_client_id)
        if todo is None:
            return SyncOutcome.CONFLICT, "That task no longer exists", None

    pomodoro = stored or Pomodoro(user_id=user_id, client_id=client_id)
    pomodoro.task = payload.task
    pomodoro.todo_id = todo.id if todo is not None else None
    pomodoro.started_at = payload.started_at
    pomodoro.ended_at = payload.ended_at
    pomodoro.utc_offset = payload.utc_offset
    pomodoro.focus_seconds = payload.focus_seconds
    pomodoro.break_seconds = payload.break_seconds
    pomodoro.tainted = payload.tainted
    pomodoro.client_updated_at = claimed
    pomodoro.server_received_at = now

    try:
        check_pomodoro_shape(
            pomodoro.started_at,
            pomodoro.ended_at,
            pomodoro.focus_seconds,
            pomodoro.break_seconds,
            pomodoro.utc_offset,
        )
    except PomodoroRuleError as refusal:
        return SyncOutcome.CONFLICT, str(refusal), None

    if stored is None:
        db.add(pomodoro)
    db.flush()
    return SyncOutcome.APPLIED, None, pomodoro


def delete_pomodoro(
    db: Session, user_id: int, client_id: str, claimed: datetime
) -> tuple[str, str | None]:
    """Remove one pomodoro, unless something newer happened to it.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose pomodoro this is.
    client_id : str
        The device's identity for it.
    claimed : datetime.datetime
        When the device says the deletion was made.

    A pomodoro already copied to a project is deleted like any other; the
    session it produced stays where it is. See `apply_pomodoro`.

    Returns
    -------
    tuple of (str, str or None)
        The outcome and, when the deletion was not carried out, why.
    """
    stored = db.execute(
        select(Pomodoro).where(
            Pomodoro.user_id == user_id, Pomodoro.client_id == client_id
        )
    ).scalar_one_or_none()

    if stored is None:
        return SyncOutcome.APPLIED, None

    if not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.DROPPED,
            "That pomodoro was changed elsewhere after it was deleted here, so "
            "it was kept",
        )

    db.delete(stored)
    return SyncOutcome.APPLIED, None


def apply_todo(
    db: Session,
    user_id: int,
    client_id: str,
    claimed: datetime,
    payload: SyncTodoPayload,
    now: datetime,
) -> tuple[str, str | None, Todo | None]:
    """Create or correct one task, by the identity its device gave it.

    One kind for both, as `apply_entry` is: a correction to a task another
    device deleted re-creates it, which is the rule that a delete never beats
    an edit, falling out rather than being special-cased.

    **Nothing merges.** A task has no extent, so there is no overlap rule and
    no `merged` outcome — the one thing that makes sessions complicated does
    not arise here.

    `archived_at` is written from the list rather than from the payload: a task
    in the archive gets a timestamp whether or not one arrived, and a task
    outside it has the column cleared. The column records **when** a task
    entered the archive and never *whether* it is in one, so it must not be
    able to disagree with the list the row is actually in.

    **Which archive is the server's too.** An archive is per account and a
    shared list is not, so a cleanup on a shared list has to write somewhere
    private — and the cleaner's own archive is the wrong place: the tasks would
    vanish for everybody else, which reads as a deletion nobody asked for. The
    destination is therefore resolved from the list the task is *coming from*,
    which is the owner's archive, and the archive id the client sent is
    overwritten rather than refused. It has to be overwritten: a member cannot
    know the owner's archive id, and refusing would leave cleanup on a shared
    list impossible from the only device that would ever do it.

    The rule is narrow by construction — it reads the stored row's list — so an
    ordinary private cleanup, and a task created directly into an archive, both
    land where they always did.

    **An identity nothing visible holds may still be taken.** `client_id` is
    unique globally, so a caller naming a list of their own for a task that
    sits in a list they cannot see is refused with *that task no longer
    exists* — see `identity_is_taken`. Left to the insert, the collision is an
    `IntegrityError` that fails the whole queue rather than one intent.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose task this is.
    client_id : str
        The device's identity for the task.
    claimed : datetime.datetime
        When the device says the task was last changed.
    payload : schemas.SyncTodoPayload
        The task as the device holds it.
    now : datetime.datetime
        Server time, recorded as when this was received.

    Returns
    -------
    tuple of (str, str or None, Todo or None)
        The outcome, why when it is not `applied`, and the row as it stands.
    """
    stored = find_todo(db, user_id, client_id)

    if stored is not None and not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.SUPERSEDED,
            "A newer version of that task is already stored",
            stored,
        )

    into = member_list(db, user_id, payload.list_id)
    if into is None:
        return SyncOutcome.CONFLICT, "That list no longer exists", None

    if into.kind == "archive" and stored is not None:
        # Archiving: the destination belongs to whoever owns the list the task
        # is leaving, never to whoever pressed the button. See the docstring.
        destination = system_list(db, stored.todo_list.user_id, "archive")
        if destination is None:
            return SyncOutcome.CONFLICT, "That archive no longer exists", None
        into = destination

    if stored is None and identity_is_taken(db, client_id):
        # Nothing visible holds this identity and yet it is taken, which means
        # the task is in a list this caller cannot see — and the list they
        # *did* name is one of their own. There is no write to apply, and
        # inserting anyway would collide with the global unique on `client_id`
        # and take every intent behind this one down with it.
        return SyncOutcome.CONFLICT, "That task no longer exists", None

    todo = stored or Todo(user_id=user_id, client_id=client_id)
    todo.list_id = into.id
    todo.title = payload.title
    todo.description = payload.description
    todo.planned_on = payload.planned_on
    todo.planned_at = payload.planned_at
    todo.due_on = payload.due_on
    todo.priority = payload.priority
    todo.duration_minutes = payload.duration_minutes
    todo.icon = payload.icon
    todo.colour = payload.colour
    todo.done_at = payload.done_at
    todo.active_since = payload.active_since
    todo.active_seconds = payload.active_seconds
    todo.archived_at = (payload.archived_at or now) if into.kind == "archive" else None
    todo.rank = payload.rank or todo.rank or append_todo_rank(db, into.id)
    todo.client_updated_at = claimed
    todo.server_received_at = now

    if stored is None:
        db.add(todo)
    # Flushed before the next intent looks, as `apply_answer` is: a queue
    # holding a task and a step on it must find the task when the step goes
    # looking, and `autoflush=False` means nothing else would make it visible.
    db.flush()
    return SyncOutcome.APPLIED, None, todo


def delete_todo(
    db: Session, user_id: int, client_id: str, claimed: datetime
) -> tuple[str, str | None]:
    """Remove one task and its steps, unless something newer happened to it.

    Its pomodoros stay. `pomodoros.todo_id` is `ON DELETE SET NULL`, so the
    hours spent on a deleted task are still in the focus history, reading the
    text that was typed at the time.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        The caller. A task is reached through the lists this caller can see, so
        a member deletes from a shared list and somebody removed from one finds
        nothing to delete.
    client_id : str
        The device's identity for the task.
    claimed : datetime.datetime
        When the device says the deletion was made.

    Returns
    -------
    tuple of (str, str or None)
        The outcome and, when the deletion was not carried out, why.
    """
    stored = find_todo(db, user_id, client_id)

    # Already gone, here or elsewhere. Replaying a deletion is a no-op rather
    # than an error, which is what lets a queue be flushed twice safely.
    if stored is None:
        return SyncOutcome.APPLIED, None

    if not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.DROPPED,
            "That task was changed elsewhere after it was deleted here, so it was kept",
        )

    db.delete(stored)
    # Before the next intent looks, so a step queued behind this deletion is
    # refused rather than inserted against a row on its way out.
    db.flush()
    return SyncOutcome.APPLIED, None


def apply_step(
    db: Session,
    user_id: int,
    client_id: str,
    claimed: datetime,
    payload: SyncStepPayload,
    now: datetime,
) -> tuple[str, str | None, TodoStep | None]:
    """Create or correct one subtask, resolving the parent its device named.

    The parent arrives as a `client_id` rather than as a key, because a step
    added in the modal of a task that is itself still in the outbox has no key
    to point at. Intents replay in order, so the parent is already applied —
    and where it was refused, this is refused too.

    The parent is resolved through the lists the caller can see, so a member
    ticks a step on a task somebody else created and a removed member gets
    *that task no longer exists*.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        The caller. A step is reached through its task, and the task through
        the lists this caller can see.
    client_id : str
        The device's identity for the step.
    claimed : datetime.datetime
        When the device says the step was last changed.
    payload : schemas.SyncStepPayload
        The step as the device holds it, naming its parent.
    now : datetime.datetime
        Server time, recorded as when this was received.

    Returns
    -------
    tuple of (str, str or None, TodoStep or None)
        The outcome, why when it is not `applied`, and the row as it stands.
    """
    parent = find_todo(db, user_id, payload.todo_client_id)
    if parent is None:
        return SyncOutcome.CONFLICT, "That task no longer exists", None

    stored = db.execute(
        select(TodoStep).where(
            TodoStep.todo_id == parent.id, TodoStep.client_id == client_id
        )
    ).scalar_one_or_none()

    if stored is not None and not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.SUPERSEDED,
            "A newer version of that subtask is already stored",
            stored,
        )

    step = stored or TodoStep(todo_id=parent.id, client_id=client_id)
    step.title = payload.title
    step.icon = payload.icon
    step.done_at = payload.done_at
    step.rank = payload.rank or step.rank or _appended_step_rank(db, parent.id)
    step.client_updated_at = claimed
    step.server_received_at = now

    if stored is None:
        db.add(step)
    db.flush()
    return SyncOutcome.APPLIED, None, step


def _appended_step_rank(db: Session, todo_id: int) -> str:
    """Return a rank placing a step after the last one on its task.

    The fallback for a step queued with no position, which the client does not
    normally produce: it computes the key a drop lands on.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    todo_id : int
        The task whose steps to measure.

    Returns
    -------
    str
        The new rank.
    """
    last = db.execute(
        select(TodoStep.rank)
        .where(TodoStep.todo_id == todo_id)
        .order_by(TodoStep.rank.desc())
        .limit(1)
    ).scalar_one_or_none()
    return between(last, None)


def delete_step(
    db: Session, user_id: int, client_id: str, claimed: datetime
) -> tuple[str, str | None]:
    """Remove one subtask, unless something newer happened to it.

    Named by its own identity alone, with no parent beside it: a step's owner
    is reached by joining the task, which is also the scope its `client_id` is
    unique within.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session. Not committed here.
    user_id : int
        Whose step this is, reached through the task.
    client_id : str
        The device's identity for the step.
    claimed : datetime.datetime
        When the device says the deletion was made.

    Returns
    -------
    tuple of (str, str or None)
        The outcome and, when the deletion was not carried out, why.
    """
    stored = find_step(db, user_id, client_id)

    if stored is None:
        return SyncOutcome.APPLIED, None

    if not _is_newer(claimed, stored.client_updated_at):
        return (
            SyncOutcome.DROPPED,
            "That subtask was changed elsewhere after it was deleted here, so "
            "it was kept",
        )

    db.delete(stored)
    db.flush()
    return SyncOutcome.APPLIED, None
