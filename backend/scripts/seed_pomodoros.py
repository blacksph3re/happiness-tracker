"""Fill a development database with plausible focus history.

Produces the shapes the Focus views have to cope with rather than a tidy run of
identical blocks: one abandoned part-way through a focus, one whose break was
cut short by the next pomodoro starting, a tainted one, a day recorded under a
different mode, and one older day already copied to a project — so the transfer
button can be seen in both of its states.

Existing pomodoros are never touched, and a day that already has any is left
alone entirely, so this can be run again to extend the history.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/seed_pomodoros.py --days 30
"""

import argparse
import random
import sys
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import Pomodoro, Project, TimeEntry, User  # noqa: E402
from services import TimeRuleError, check_no_overlap, transferable  # noqa: E402

TASKS = (
    "The rewrite",
    "Review backlog",
    "Migration notes",
    "Reading",
    "Inbox",
    None,
    "Refactor the store",
    None,
)
"""What a pomodoro was for. Two are None, because an unnamed one is valid and
the day's list has to read well without a label."""

MODES = ((25 * 60, 5 * 60), (50 * 60, 10 * 60))
"""The lengths in force on a given day, stored per pomodoro.

Two of them, and chosen per day rather than globally, because the lengths are
deliberately *not* retroactive: a history where every row says 25/5 could not
show that changing the mode leaves yesterday alone.
"""


def utc_now() -> datetime:
    """Return now as a naive UTC instant, matching how the columns store it.

    Distinct from `datetime.now()`, which this script also uses: the layout walk
    below works in *local* wall time because that is what "start at nine" means,
    while anything compared against a stored instant has to be UTC. Mixing the
    two silently reads an offset out — a pomodoro still running looked finished.

    Returns
    -------
    datetime.datetime
        The current UTC instant, without a timezone.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def local_offset(moment: datetime) -> int:
    """Return this machine's UTC offset at an instant, in minutes.

    Seeded pomodoros carry the offset actually in force on the day they land
    on, as sessions do, so a summer day reads +02:00 and a winter one +01:00.

    Parameters
    ----------
    moment : datetime.datetime
        A naive local instant.

    Returns
    -------
    int
        Minutes east of UTC.
    """
    return int(moment.astimezone().utcoffset().total_seconds() // 60)


def _shapes(day: date, rng: random.Random) -> list[str]:
    """Decide how many pomodoros a day holds, and what shape each one is.

    Parameters
    ----------
    day : datetime.date
        The local day.
    rng : random.Random
        Source of the jitter.

    Returns
    -------
    list of str
        One marker per pomodoro: `plain`, `abandoned`, or `chained` for one
        that begins before the previous break has run out.
    """
    weekend = day.weekday() >= 5
    if weekend and rng.random() < 0.7:
        return []
    if rng.random() < 0.12:
        return []

    count = rng.randint(1, 3) if weekend else rng.randint(3, 7)
    shapes = []
    for _ in range(count):
        roll = rng.random()
        shapes.append(
            "abandoned" if roll < 0.12 else "chained" if roll < 0.34 else "plain"
        )
    return shapes


def seed(days: int, username: str | None, seed_value: int) -> tuple[int, int]:
    """Write pomodoros for one user, and copy one older day to a project.

    Parameters
    ----------
    days : int
        How many days of history to cover, ending today.
    username : str or None
        Whose history to write. The first account when omitted.
    seed_value : int
        Seed for the jitter, so a run can be repeated exactly.

    Returns
    -------
    tuple of (int, int)
        How many pomodoros were written, and how many of them were marked as
        copied to a project.

    Raises
    ------
    RuntimeError
        If there is no such user.
    """
    rng = random.Random(seed_value)
    written = 0
    stamped = 0

    with SessionLocal() as db:
        statement = select(User).order_by(User.id)
        if username:
            statement = statement.where(User.username == username)
        user = db.execute(statement).scalars().first()
        if user is None:
            raise RuntimeError(f"No user named {username!r}")

        start = date.today() - timedelta(days=days - 1)
        # A day that already holds pomodoros is filled only *up to* the
        # earliest of them, never around them: pomodoros run in a chain, and
        # interleaving new ones among rows already there would invent breaks
        # that were never taken. Today is the case that matters — one real
        # pomodoro this evening should not cost the whole day's history.
        ceiling: dict[date, datetime] = {}
        for row in db.execute(
            select(Pomodoro).where(Pomodoro.user_id == user.id)
        ).scalars():
            local = row.started_at + timedelta(minutes=row.utc_offset)
            held = ceiling.get(local.date())
            if held is None or local < held:
                ceiling[local.date()] = local

        for offset in range(days):
            day = start + timedelta(days=offset)
            # A margin, so the seeded chain finishes well before the real row
            # rather than butting against it.
            limit = min(
                datetime.now(),
                ceiling.get(day, datetime.max) - timedelta(minutes=10),
            )

            focus_seconds, break_seconds = MODES[0 if rng.random() < 0.8 else 1]
            shapes = _shapes(day, rng)
            # Walked forward from where the last one actually ended rather than
            # laid out on fixed hours. Two pomodoros cannot run at once — the
            # app ends one by starting the next — and a fixed spacing put the
            # next one *inside* the previous on 50/10 days.
            cursor = datetime.combine(day, time.min) + timedelta(
                hours=9.0 + rng.uniform(-0.5, 0.75)
            )
            lunch_after = len(shapes) // 2
            previous: Pomodoro | None = None

            for index, shape in enumerate(shapes):
                # Nothing in the future, and nothing running into a pomodoro
                # that is already there: today is half a day, not a whole one.
                if cursor + timedelta(seconds=focus_seconds + break_seconds) > limit:
                    break
                minutes = local_offset(cursor)
                started_at = cursor - timedelta(minutes=minutes)

                # A chained pomodoro starts before the previous break has run
                # out, which is the only way a break is ever cut short.
                if shape == "chained" and previous is not None and break_seconds > 90:
                    cut = previous.started_at + timedelta(
                        seconds=previous.focus_seconds
                        + rng.randint(30, break_seconds - 60)
                    )
                    previous.ended_at = cut
                    started_at = cut

                ended_at = (
                    started_at + timedelta(seconds=rng.randint(120, focus_seconds - 60))
                    if shape == "abandoned"
                    else None
                )
                pomodoro = Pomodoro(
                    user_id=user.id,
                    task=rng.choice(TASKS),
                    started_at=started_at,
                    ended_at=ended_at,
                    utc_offset=minutes,
                    focus_seconds=focus_seconds,
                    break_seconds=break_seconds,
                    # Rare, and never on an abandoned one by construction: the
                    # two mean different things and stacking them everywhere
                    # would make neither legible.
                    tainted=shape != "abandoned" and rng.random() < 0.1,
                )
                db.add(pomodoro)
                db.flush()
                written += 1
                previous = pomodoro

                # The next one begins after this one has finished, plus a gap —
                # and once a day, plus lunch.
                finished = (
                    ended_at
                    if ended_at is not None
                    else started_at + timedelta(seconds=focus_seconds + break_seconds)
                )
                gap = timedelta(minutes=rng.uniform(1, 18))
                if index == lunch_after:
                    gap += timedelta(minutes=rng.uniform(35, 70))
                cursor = finished + timedelta(minutes=minutes) + gap

        db.flush()

        # One older day copied to a project, so the transfer button can be seen
        # having already been pressed. Written through the same overlap rule the
        # endpoint uses, and skipped rather than forced if the project was also
        # tracked by hand that day — which is exactly the collision a real
        # transfer hits.
        copied_day = date.today() - timedelta(days=3)
        rows = [
            row
            for row in db.execute(
                select(Pomodoro).where(Pomodoro.user_id == user.id)
            ).scalars()
            if (row.started_at + timedelta(minutes=row.utc_offset)).date() == copied_day
        ]
        project = (
            db.execute(
                select(Project)
                .where(Project.user_id == user.id, Project.active.is_(True))
                .order_by(Project.position)
            )
            .scalars()
            .first()
        )

        if rows and project is not None:
            total = transferable(rows, utc_now())
            if total.seconds > 0 and total.started_at is not None:
                entry = TimeEntry(
                    user_id=user.id,
                    project_id=project.id,
                    started_at=total.started_at,
                    ended_at=total.started_at + timedelta(seconds=total.seconds),
                    utc_offset=rows[0].utc_offset,
                )
                others = list(
                    db.execute(
                        select(TimeEntry).where(
                            TimeEntry.user_id == user.id,
                            TimeEntry.project_id == project.id,
                        )
                    ).scalars()
                )
                try:
                    check_no_overlap(entry, others)
                except TimeRuleError:
                    print(
                        f"  (not copying {copied_day}: it would overlap tracked "
                        f"time on {project.name})"
                    )
                else:
                    db.add(entry)
                    for row in rows:
                        if row.transferred_at is None:
                            row.transferred_at = utc_now()
                            stamped += 1

        db.commit()
        print(f"{user.username}: {start} → {date.today()}")
        return written, stamped


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30, help="days of history")
    parser.add_argument("--user", default=None, help="whose history to write")
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    options = parser.parse_args()

    count, copied = seed(options.days, options.user, options.seed)
    print(f"Wrote {count} pomodoros, {copied} of them copied to a project.")
