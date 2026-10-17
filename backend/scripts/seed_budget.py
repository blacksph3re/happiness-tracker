"""Fill a development database with an hour budget worth looking at.

Budget mode only says something against a contract that has been lived in: a
year of workdays mostly tracked, the public holidays the calendar knows,
vacations and sick days marked by hand, a bridge day, a few workdays nobody
tracked or explained — which is what the alarm colour is for — and days off
still ahead, which wait in the line above today.

It works on a tag that already has a contract and leaves that contract alone;
given a tag without one, it writes 8h Monday to Friday from 1 January. Sessions
go on the tag's first project, only on days that project has no time on yet,
and existing days off and resets are never touched — so it can be run over a
hand-made history, and again to extend one.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/seed_budget.py --tag "Work deducted"
"""

import argparse
import random
import sys
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import (  # noqa: E402
    BudgetReset,
    Project,
    ProjectTag,
    Tag,
    TagContract,
    TagDayOff,
    TimeEntry,
    User,
)
from services import MONDAY_TO_FRIDAY, easter_sunday, public_holidays  # noqa: E402

CARRIED_OVER_MINUTES = 12 * 60
"""The balance a contract starts from: overtime brought in from before it."""


def local_offset(moment: datetime) -> int:
    """Return this machine's UTC offset at an instant, in minutes.

    The same reading `seed_time.py` takes, so a seeded summer day carries
    +02:00 and a winter one +01:00, as a session recorded here would.

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


def busy_days(entries: list[TimeEntry], now: datetime) -> set[date]:
    """Return every local day a project's sessions already touch.

    From the day a session starts to the day it ends, so a session left running
    overnight keeps the next morning free of seeded time too.

    Parameters
    ----------
    entries : list of TimeEntry
        The project's sessions.
    now : datetime.datetime
        The current UTC instant, the end of a running session.

    Returns
    -------
    set of datetime.date
        The local days.
    """
    days = set()
    for entry in entries:
        shift = timedelta(minutes=entry.utc_offset)
        first = (entry.started_at + shift).date()
        last = ((entry.ended_at or now) + shift).date()
        while first <= last:
            days.add(first)
            first += timedelta(days=1)
    return days


def workday_test(contracts: list[TagContract]):
    """Build a test for whether a contract expects work on a day.

    By the rules `budget_days` reads: the period in force, its workdays, and
    not a public holiday in its state.

    Parameters
    ----------
    contracts : list of TagContract
        The tag's periods, oldest first.

    Returns
    -------
    collections.abc.Callable
        ``works(day) -> bool``.
    """
    holidays: dict[tuple[str | None, int], dict[date, str]] = {}

    def works(day: date) -> bool:
        periods = [one for one in contracts if one.starts_on <= day]
        if not periods or periods[-1].daily_minutes <= 0:
            return False
        period = periods[-1]
        if not period.workdays & (1 << day.weekday()):
            return False
        key = (period.state, day.year)
        if key not in holidays:
            holidays[key] = public_holidays(period.state, day.year)
        return day not in holidays[key]

    return works


def plan_days_off(
    workdays: list[date], busy: set[date], today: date, rng: random.Random
) -> tuple[dict[date, str], set[date]]:
    """Decide which workdays were taken off, and which nobody explained.

    The week before Easter and two weeks in summer are vacation, three sick
    spells take a day or two each, a Friday after a Thursday holiday is a bridge
    day, and three workdays are simply left empty — one of them in the last two
    weeks, so the alarm shows without scrolling. Ahead of today, the week after
    next and the days between Christmas and New Year are booked. A day that
    already holds time is never chosen.

    Parameters
    ----------
    workdays : list of datetime.date
        The contract's workdays, in order, past and future.
    busy : set of datetime.date
        Days that already hold time.
    today : datetime.date
        The local day in progress.
    rng : random.Random
        The seeded source of chance.

    Returns
    -------
    tuple of (dict of datetime.date to str, set of datetime.date)
        The days off by kind, and the workdays to leave untracked.
    """
    known = set(workdays)
    past = [day for day in workdays if day < today and day not in busy]
    off: dict[date, str] = {}

    good_friday = easter_sunday(today.year) - timedelta(days=2)
    for day in past:
        if good_friday - timedelta(days=4) <= day < good_friday:
            off[day] = "vacation"
        thursday = day - timedelta(days=1)
        if day.weekday() == 4 and thursday.weekday() == 3 and thursday not in known:
            # A Thursday the contract expected nothing on, before a weekend.
            off[day] = "other"

    summer = [day for day in past if day.month in (7, 8) and day.weekday() == 0]
    if summer:
        first = rng.choice(summer[:-1] or summer)
        for day in past:
            if first <= day < first + timedelta(days=14):
                off[day] = "vacation"

    free = [day for day in past if day not in off]
    for day in rng.sample(free, min(3, len(free))):
        off[day] = "sick"
        following = past[past.index(day) + 1] if day != past[-1] else None
        if following and following not in off and rng.random() < 0.5:
            off[following] = "sick"

    free = [day for day in past if day not in off]
    recent = [day for day in free if day >= today - timedelta(days=14)]
    empty = set(rng.sample(recent, min(1, len(recent))))
    older = [day for day in free if day not in empty]
    empty |= set(rng.sample(older, min(2, len(older))))

    ahead = today + timedelta(days=(7 - today.weekday()) + 7)
    for step in range(5):
        day = ahead + timedelta(days=step)
        if day in known:
            off[day] = "vacation"
    for step in range(28, 32):
        day = date(today.year, 12, step)
        if day > today and day in known:
            off[day] = "vacation"
    return off, empty


def sessions_for(day: date, rng: random.Random) -> list[tuple[datetime, datetime]]:
    """Return a plausible workday as local start and end times.

    Usually a morning and an afternoon with lunch between, sometimes one long
    stretch; Fridays run shorter.

    Parameters
    ----------
    day : datetime.date
        The local day.
    rng : random.Random
        The seeded source of chance.

    Returns
    -------
    list of tuple of (datetime.datetime, datetime.datetime)
        Naive local starts and ends.
    """
    hours = min(10.0, max(5.0, rng.gauss(7.75, 0.7)))
    if day.weekday() == 4:
        hours -= 0.8
    began = datetime.combine(day, time(8)) + timedelta(minutes=rng.uniform(0, 75))
    if rng.random() < 0.2:
        return [(began, began + timedelta(hours=hours))]
    morning = min(5.0, max(3.0, rng.gauss(4.0, 0.4)))
    lunch = timedelta(minutes=rng.uniform(30, 60))
    noon = began + timedelta(hours=morning)
    return [
        (began, noon),
        (noon + lunch, noon + lunch + timedelta(hours=hours - morning)),
    ]


def seed(
    tag_name: str | None, username: str | None, state: str | None, seed_value: int
) -> None:
    """Write sessions, days off and a starting balance for one contracted tag.

    Parameters
    ----------
    tag_name : str or None
        The tag. The first tag with a contract when omitted.
    username : str or None
        Whose tag. The first account when omitted.
    state : str or None
        The federal state for a contract this writes; an existing one keeps
        its own.
    seed_value : int
        Seed for the chance, so a run can be repeated exactly.

    Raises
    ------
    RuntimeError
        If there is no such user, no such tag, or no project on it.
    """
    rng = random.Random(seed_value)
    today = date.today()
    now = datetime.now(UTC).replace(tzinfo=None)

    with SessionLocal() as db:
        statement = select(User).order_by(User.id)
        if username:
            statement = statement.where(User.username == username)
        user = db.execute(statement).scalars().first()
        if user is None:
            raise RuntimeError(f"No user named {username!r}")

        tags = select(Tag).where(Tag.user_id == user.id).order_by(Tag.position)
        if tag_name:
            tag = db.execute(tags.where(Tag.name == tag_name)).scalars().first()
        else:
            tag = next(
                (one for one in db.execute(tags).scalars() if one.contracts), None
            )
        if tag is None:
            raise RuntimeError(f"No tag {tag_name or 'with a contract'!r}")

        if not tag.contracts:
            db.add(
                TagContract(
                    tag_id=tag.id,
                    starts_on=date(today.year, 1, 1),
                    daily_minutes=480,
                    workdays=MONDAY_TO_FRIDAY,
                    state=state,
                )
            )
            db.flush()
            db.refresh(tag)
        contracts = list(tag.contracts)

        project = (
            db.execute(
                select(Project)
                .join(ProjectTag, ProjectTag.project_id == Project.id)
                .where(ProjectTag.tag_id == tag.id, Project.active.is_(True))
                .order_by(Project.position)
            )
            .scalars()
            .first()
        )
        if project is None:
            raise RuntimeError(f"{tag.name} has no active project to track time on")

        entries = list(
            db.execute(
                select(TimeEntry).where(TimeEntry.project_id == project.id)
            ).scalars()
        )
        busy = busy_days(entries, now)
        marked = {
            row.day
            for row in db.execute(
                select(TagDayOff).where(TagDayOff.tag_id == tag.id)
            ).scalars()
        }

        works = workday_test(contracts)
        start = contracts[0].starts_on
        horizon = date(today.year, 12, 31)
        workdays = [
            start + timedelta(days=step)
            for step in range((horizon - start).days + 1)
            if works(start + timedelta(days=step))
        ]
        off, empty = plan_days_off(workdays, busy, today, rng)

        stamp = now
        marking = 0
        for day, kind in sorted(off.items()):
            if day in marked or day in busy:
                continue
            db.add(
                TagDayOff(tag_id=tag.id, day=day, kind=kind, client_updated_at=stamp)
            )
            marking += 1

        written = 0
        for day in workdays:
            if day > today:
                break
            if day in busy or day in off or day in marked or day in empty:
                continue
            for began, ended in sessions_for(day, rng):
                if day == today:
                    # Only the part of today that has already happened.
                    ended = min(ended, datetime.now() - timedelta(minutes=5))
                    if ended <= began:
                        continue
                offset = local_offset(began)
                db.add(
                    TimeEntry(
                        user_id=user.id,
                        project_id=project.id,
                        started_at=began - timedelta(minutes=offset),
                        ended_at=ended - timedelta(minutes=offset),
                        utc_offset=offset,
                    )
                )
                written += 1

        resetting = db.execute(
            select(BudgetReset).where(
                BudgetReset.tag_id == tag.id, BudgetReset.day == start
            )
        ).scalar_one_or_none()
        if resetting is None:
            db.add(
                BudgetReset(
                    tag_id=tag.id,
                    day=start,
                    balance_minutes=CARRIED_OVER_MINUTES,
                    client_updated_at=stamp,
                )
            )

        db.commit()
        print(
            f"{user.username} · {tag.name} on {project.name}: {written} sessions, "
            f"{marking} days off, {len(empty)} workdays left empty, "
            f"from {start}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default=None, help="the contracted tag")
    parser.add_argument("--user", default=None, help="whose tag")
    parser.add_argument(
        "--state", default="BE", help="the state for a contract this writes"
    )
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    arguments = parser.parse_args()
    seed(arguments.tag, arguments.user, arguments.state, arguments.seed)
