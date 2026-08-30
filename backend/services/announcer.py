"""The one thing in this application that runs on its own.

`main.py`'s lifespan has always started nothing: it bootstraps and yields, and
every line of code after that runs because a request arrived. A notification
that must land at a future moment is the first thing that cannot work that way,
and this is deliberately the smallest version of it — a loop, a claim, and no
generality.

What keeps it honest under a restart is the claim rather than the loop: marking
a pomodoro `WHERE notified_at IS NULL` and sending only if that update touched a
row means the worst a crash mid-send can do is lose one notification, never
repeat one. Losing one is already the accepted outcome — see `GRACE`.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from config import get_settings
from database import SessionLocal
from models import Pomodoro, PushSubscription
from services.push import send_to
from services.schedule import GRACE, announcement, is_due

logger = logging.getLogger(__name__)

MAX_FOCUS = timedelta(days=1)
"""The longest focus phase the API accepts, and so the furthest back to look."""

TICK = 15
"""Seconds between passes.

Comfortably inside the one-minute grace, so a boundary is never missed for want
of looking, and slow enough that an idle server is doing one indexed query every
quarter minute.
"""


def _due(db: Session, now: datetime) -> list[Pomodoro]:
    """Return the pomodoros whose focus has just ended.

    Bounded in SQL before the rules are applied, so an idle pass reads nothing:
    only pomodoros that started recently enough to be ending now can qualify,
    and the longest focus this app accepts is a day.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    now : datetime.datetime
        The current UTC instant.

    Returns
    -------
    list of Pomodoro
        Those `services.schedule.is_due` accepts.
    """
    candidates = db.execute(
        select(Pomodoro)
        .where(
            Pomodoro.notified_at.is_(None),
            # One whose focus is ending now started at most one focus-length
            # ago, and the API caps a phase at a day. The index on
            # (user_id, started_at) is not this query's, but the column is
            # indexed and the window is narrow.
            Pomodoro.started_at >= now - GRACE - MAX_FOCUS,
            Pomodoro.started_at <= now,
        )
        .order_by(Pomodoro.started_at)
    ).scalars()
    return [row for row in candidates if is_due(row, now)]


def _claim(db: Session, pomodoro: Pomodoro, now: datetime) -> bool:
    """Take responsibility for announcing one pomodoro.

    The whole of the concurrency story. The update is conditional on the column
    still being NULL, so of two workers reaching the same row, exactly one sees
    a rowcount of 1 and the other sees 0 and moves on.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    pomodoro : Pomodoro
        The row to claim.
    now : datetime.datetime
        What to stamp it with.

    Returns
    -------
    bool
        True when this caller may send.
    """
    claimed = db.execute(
        update(Pomodoro)
        .where(Pomodoro.id == pomodoro.id, Pomodoro.notified_at.is_(None))
        .values(notified_at=now)
    )
    db.commit()
    return claimed.rowcount == 1


def announce_once(now: datetime | None = None) -> int:
    """Run one pass: find what is due, claim it, and send it.

    Synchronous and self-contained, which is what makes it testable without a
    running event loop or a server.

    Parameters
    ----------
    now : datetime.datetime, optional
        The instant to judge against. Defaults to the current UTC instant.

    Returns
    -------
    int
        How many notifications were sent.
    """
    settings = get_settings()
    if not settings.push_configured:
        return 0

    moment = now or datetime.now(UTC).replace(tzinfo=None)
    sent = 0
    with SessionLocal() as db:
        for pomodoro in _due(db, moment):
            # Before the claim, not after. The claim exists to stop one
            # boundary being announced twice, and there is nothing to announce
            # twice if the account has no enrolled device — but taking it
            # anyway stamped the row as done, so enrolling a moment later and
            # still inside the grace period could never recover it.
            #
            # Reordering is safe for the race the claim guards: two workers may
            # both find subscriptions, but only one of them can win the claim.
            subscriptions = list(
                db.execute(
                    select(PushSubscription).where(
                        PushSubscription.user_id == pomodoro.user_id
                    )
                ).scalars()
            )
            if not subscriptions:
                continue
            if not _claim(db, pomodoro, moment):
                continue
            result = send_to(subscriptions, announcement(pomodoro), settings)
            sent += result.sent
            if result.gone:
                # The push service says these browsers are finished. Nothing
                # else prunes them reliably — see `services.push.GONE`.
                for dead in result.gone:
                    db.execute(
                        PushSubscription.__table__.delete().where(
                            PushSubscription.__table__.c.id == dead
                        )
                    )
                db.commit()
    return sent


async def announce_forever() -> None:
    """Poll for boundaries until cancelled.

    Every failure is swallowed and logged. A loop that dies takes the feature
    with it silently, and a notification is not worth a server.
    """
    while True:
        try:
            await asyncio.to_thread(announce_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a bad pass must not end the loop
            logger.exception("announcer pass failed")
        await asyncio.sleep(TICK)
