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

from models import Answer, Project, Question, QuestionOption, TimeEntry
from schemas import AnswerIn, SyncEntryPayload
from services.timetrack import TimeRuleError, check_entry_shape, check_no_overlap
from services.wellbeing import QuestionRuleError, check_answer, sync_system_answers


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
    if question is None:
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

    if stored is None:
        stored = Answer(
            user_id=user_id, question_id=payload.question_id, day=payload.day
        )
        db.add(stored)

    stored.value = payload.value
    stored.option_id = payload.option_id
    stored.client_updated_at = claimed
    stored.server_received_at = now

    # The day's auto-tracked answers are written by the same rule as an online
    # answer, so a day first answered offline is not missing its weekday.
    sync_system_answers(
        db,
        user_id,
        question.catalogue_id,
        payload.day,
        payload.local_hour,
    )
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
