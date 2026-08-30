"""Deciding which pomodoros are due an announcement, and claiming them.

Phase three of `PUSH_NOTIFICATIONS_PROPOSAL.md`, and smaller than that document
proposed. It described a `scheduled_pushes` table with an asyncio task polling
it, which is the shape this needs if the thing being announced is arbitrary. It
is not: a pomodoro already records when it started and how long its focus runs,
so **when to send is derivable** and only *whether it was sent* has to be
stored. That is one nullable column, not a table.

Framework-free, as the rules beside it are: nothing here sends, opens a
connection, or knows what a notification looks like.
"""

from datetime import datetime, timedelta
from typing import Protocol, runtime_checkable

from services.pomodoro import Block

GRACE = timedelta(minutes=1)
"""How late an announcement may be and still be worth making.

One minute, settled. Past that the app's own on-wake notice covers it and says
the honest thing, while a push arriving ten minutes late announces the end of a
block you finished, made tea after, and have since replaced.

It is also what makes this safe to switch on: every pomodoro already in the
database is far outside the window, so the first run announces nothing.
"""


@runtime_checkable
class Announceable(Block, Protocol):
    """A block the announcer can describe and claim.

    Three fields beyond the derivation shape, and each is here for a reason the
    rules above are not: the id collapses repeats into one notification, the
    task is what the message says, and `notified_at` is the claim itself —
    `UPDATE ... WHERE notified_at IS NULL`, send only if it touched a row.
    """

    id: int
    """Surrogate key, used as the notification's collapse tag."""

    task: str | None
    """What the focus was for, shown as the notification's title."""

    notified_at: datetime | None
    """When this block's end was announced, or None while it is unclaimed."""


def focus_ends_at(pomodoro: Block) -> datetime:
    """Return the instant a pomodoro's focus phase is over.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.

    Returns
    -------
    datetime.datetime
        `started_at` plus the focus length, in UTC.
    """
    return pomodoro.started_at + timedelta(seconds=pomodoro.focus_seconds)


def is_due(pomodoro: Announceable, now: datetime) -> bool:
    """Report whether a pomodoro's focus has just ended and wants announcing.

    Three things disqualify one, and they are different kinds of "no":

    - **Already announced.** `notified_at` is the record of that.
    - **Stopped before the focus was over.** Abandoning is a decision, and the
      person who made it was looking at the screen.
    - **Too late.** Outside `GRACE`, which covers a server that was down and
      every pomodoro that existed before this feature did.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro.
    now : datetime.datetime
        The current UTC instant.

    Returns
    -------
    bool
        True when it should be announced now.
    """
    if pomodoro.notified_at is not None:
        return False
    ends = focus_ends_at(pomodoro)
    if pomodoro.ended_at is not None and pomodoro.ended_at < ends:
        return False
    return ends <= now <= ends + GRACE


def announcement(pomodoro: Announceable) -> dict[str, str]:
    """Build the payload for a pomodoro whose focus has ended.

    **Append-only.** The service worker reading this may be an older release
    than the server sending it, because the app prompts before taking an update
    rather than swapping itself — so fields may be added and none renamed or
    removed. See `app/src/sw.js`.

    Parameters
    ----------
    pomodoro : models.Pomodoro
        The pomodoro that has just finished its focus.

    Returns
    -------
    dict
        Title, body, click path and a collapse tag.
    """
    minutes = max(1, round(pomodoro.break_seconds / 60))
    return {
        "title": pomodoro.task or "Focus block finished",
        "body": (
            f"Time for a {minutes} minute break."
            if pomodoro.break_seconds > 0
            else "That is the focus done."
        ),
        "path": "/focus",
        # One line per pomodoro rather than a stack, if it is somehow sent twice.
        "tag": f"pomodoro-{pomodoro.id}",
    }
