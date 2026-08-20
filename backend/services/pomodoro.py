"""Rules and arithmetic for pomodoros.

Framework-free, like the two halves beside it. The whole of this module rests on
one decision: **a pomodoro's end is a timestamp only when something stopped it
early.** Left alone, it ends where it always said it would, and every reader
computes that from the row without anything having run.

That is what makes "completes at its planned end" cost nothing — no timer, no
background task, no write — and it is why there is no stored outcome to disagree
with the timestamps after an edit.

Nothing here writes a session. Time reaches the tracker only when somebody
presses the transfer button, and `transferable` is what that button reads.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from services.clock import offset_is_real

RUNNING = "running"
"""Started, and its planned end has not passed."""

ABANDONED = "abandoned"
"""Stopped by hand before the focus was over."""

COMPLETE = "complete"
"""The focus was seen through, whether or not the break ran its course."""

MAX_PHASE_SECONDS = 24 * 60 * 60
"""Longest a single phase may be asked for.

A day, which is already absurd for a focus block. The cap exists so a typo in a
client cannot write a pomodoro that stays running for a decade.
"""


class PomodoroRuleError(ValueError):
    """Raised when a pomodoro does not describe something that could happen.

    A plain exception rather than an HTTP error, for the same reason
    `TimeRuleError` is one: these are facts about what a pomodoro is, and they
    hold whether the caller arrived over HTTP or from a script. The router
    translates it into a 422.
    """


@dataclass(frozen=True)
class Transferable:
    """What the transfer button is offering to copy."""

    seconds: int
    """Total time to be written as a session: focus plus break."""

    focus_seconds: int
    """The focus part of it, for the sentence the button shows."""

    break_seconds: int
    """The break part of it."""

    tainted_seconds: int
    """How much of the total came from pomodoros marked tainted.

    Counted in the total rather than removed from it — time spent is time spent
    — but reported apart, because telling you so is the only thing the taint
    button is for.
    """

    started_at: datetime | None
    """When the day's earliest finished pomodoro began, or None if there is none.

    The session is placed here rather than spanning the whole stretch of day the
    pomodoros were spread across: what is recorded is the time spent, not the
    window it happened in.
    """

    count: int
    """How many pomodoros would be marked as copied."""


def check_pomodoro_shape(
    started_at: datetime,
    ended_at: datetime | None,
    focus_seconds: int,
    break_seconds: int,
    utc_offset: int,
) -> None:
    """Check that a pomodoro describes an interval that could happen.

    Parameters
    ----------
    started_at : datetime.datetime
        When the focus began, in UTC.
    ended_at : datetime.datetime or None
        When it was stopped early, in UTC, or None if nothing stopped it.
    focus_seconds : int
        Length of the focus phase as configured at the time.
    break_seconds : int
        Length of the break phase as configured at the time.
    utc_offset : int
        Minutes east of UTC in force when it started.

    Raises
    ------
    PomodoroRuleError
        If the focus is not positive, either phase is longer than a day, the
        offset names nowhere on Earth, or the end does not follow the start.
    """
    if focus_seconds <= 0:
        raise PomodoroRuleError("A pomodoro needs a focus phase")
    if break_seconds < 0:
        raise PomodoroRuleError("A break cannot be negative")
    if focus_seconds > MAX_PHASE_SECONDS or break_seconds > MAX_PHASE_SECONDS:
        raise PomodoroRuleError("A phase cannot be longer than a day")
    if not offset_is_real(utc_offset):
        raise PomodoroRuleError("That UTC offset does not exist")
    if ended_at is not None and ended_at <= started_at:
        raise PomodoroRuleError("A pomodoro has to end after it started")


def planned_end(pomodoro) -> datetime:
    """Return where a pomodoro said it would end when it started.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.

    Returns
    -------
    datetime.datetime
        `started_at` plus both phases, in UTC.
    """
    return pomodoro.started_at + timedelta(
        seconds=pomodoro.focus_seconds + pomodoro.break_seconds
    )


def effective_end(pomodoro) -> datetime:
    """Return the instant a pomodoro is measured to.

    `ended_at` is written only when something stopped the pomodoro early, so an
    unset one is not an unfinished pomodoro — it is one that ran as declared.

    The cap is load-bearing rather than defensive: correcting an end time is
    allowed, and without it, moving that time later would add break minutes that
    never happened.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.

    Returns
    -------
    datetime.datetime
        The earlier of its explicit end and its planned end.
    """
    limit = planned_end(pomodoro)
    if pomodoro.ended_at is None:
        return limit
    return min(pomodoro.ended_at, limit)


def elapsed_seconds(pomodoro) -> int:
    """Return how long a pomodoro lasted in total.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.

    Returns
    -------
    int
        Whole seconds between its start and its effective end.
    """
    return int((effective_end(pomodoro) - pomodoro.started_at).total_seconds())


def pomodoro_state(pomodoro, as_of: datetime) -> str:
    """Return which of the three states a pomodoro is in.

    Derived rather than stored, so correcting a time re-reads the state instead
    of leaving a label that disagrees with it.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.
    as_of : datetime.datetime
        Now, in UTC. Only consulted to tell running from finished.

    Returns
    -------
    str
        `RUNNING`, `ABANDONED` or `COMPLETE`.
    """
    if pomodoro.ended_at is None and as_of < planned_end(pomodoro):
        return RUNNING
    if elapsed_seconds(pomodoro) < pomodoro.focus_seconds:
        return ABANDONED
    return COMPLETE


def split_seconds(pomodoro) -> tuple[int, int]:
    """Divide a pomodoro's elapsed time into focus and break.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.

    Returns
    -------
    tuple of (int, int)
        Focus seconds and break seconds. An abandoned pomodoro reports no break
        at all, because a break it never reached is not time it spent.
    """
    elapsed = elapsed_seconds(pomodoro)
    focus = min(elapsed, pomodoro.focus_seconds)
    return focus, max(0, elapsed - pomodoro.focus_seconds)


def transferable(pomodoros: list, as_of: datetime) -> Transferable:
    """Total what the transfer button would copy to a project.

    Only one kind is left out: a pomodoro still running has no final duration,
    and freezing a guess of it is worse than waiting for the button to be
    pressed again.

    One already copied is **not** excluded, deliberately. It was, and the result
    was two numbers on one screen that disagreed — the day's total counting
    every pomodoro and the button offering whatever had not been copied yet.
    Copying twice is now possible and is the owner's business: the second
    session collides with the first on the same project and is refused, and
    deleting the first in the Time view is the way through. `transferred_at` is
    still stamped, because when a copy happened is worth knowing; nothing gates
    on it.

    Parameters
    ----------
    pomodoros : list of models.Pomodoro
        The day's pomodoros, in any order.
    as_of : datetime.datetime
        Now, in UTC.

    Returns
    -------
    Transferable
        The totals, and where the session would start. Every field is zero or
        None when there is nothing left to copy.
    """
    focus_total = 0
    break_total = 0
    tainted_total = 0
    earliest: datetime | None = None
    count = 0

    for pomodoro in pomodoros:
        if pomodoro_state(pomodoro, as_of) == RUNNING:
            continue
        focus, rest = split_seconds(pomodoro)
        focus_total += focus
        break_total += rest
        if pomodoro.tainted:
            tainted_total += focus + rest
        if earliest is None or pomodoro.started_at < earliest:
            earliest = pomodoro.started_at
        count += 1

    return Transferable(
        seconds=focus_total + break_total,
        focus_seconds=focus_total,
        break_seconds=break_total,
        tainted_seconds=tainted_total,
        started_at=earliest,
        count=count,
    )
