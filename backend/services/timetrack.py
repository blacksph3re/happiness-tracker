"""Rules and arithmetic for tracked time.

Framework-free, like the wellbeing rules beside it: what a session *is*, and how
its duration divides across the days it touches. Nothing here reads the database
or knows about HTTP.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, Protocol, runtime_checkable

from services.clock import MAX_UTC_OFFSET, MIN_UTC_OFFSET, local_day
from services.holidays import public_holidays


class TimeRuleError(ValueError):
    """Raised when a session does not describe an interval that could happen.

    A plain exception rather than an HTTP error, for the same reason
    `QuestionRuleError` is one: these are facts about what a session is, and
    they hold whether the caller arrived over HTTP or from a script. The router
    translates it into a 422.
    """


@runtime_checkable
class Session(Protocol):
    """The four fields the session rules read, whatever is carrying them.

    A `Protocol` rather than `models.TimeEntry`, and not for looseness:
    `scripts/dump_derivations.py` feeds these same functions its own dataclass
    to build the conformance corpus the JavaScript ports are held against, so an
    ORM annotation here would be a lie the corpus already contradicts. Written
    out, the duck type becomes something a checker can hold to — beartype
    rejects a shape missing any of these during the suite.
    """

    project_id: int
    """Which project the session is against."""

    started_at: datetime
    """When it opened, in UTC."""

    ended_at: datetime | None
    """When it closed, in UTC, or None while it is still running."""

    utc_offset: int
    """Minutes east of UTC in force at check-in. See `services/clock.py`."""


def check_entry_shape(
    started_at: datetime, ended_at: datetime | None, utc_offset: int
) -> None:
    """Check that a session's endpoints describe a real interval.

    Parameters
    ----------
    started_at : datetime.datetime
        When the session began, in UTC.
    ended_at : datetime.datetime or None
        When it ended, in UTC, or None while it is still running.
    utc_offset : int
        Minutes east of UTC at check-in.

    Raises
    ------
    TimeRuleError
        If the session ends before it starts, or the offset is not a real one.
    """
    if not MIN_UTC_OFFSET <= utc_offset <= MAX_UTC_OFFSET:
        raise TimeRuleError(
            f"A UTC offset is between {MIN_UTC_OFFSET} and {MAX_UTC_OFFSET} minutes"
        )
    if ended_at is not None and ended_at <= started_at:
        raise TimeRuleError("A session has to end after it starts")


def _ends_at(entry: Session, as_of: datetime) -> datetime:
    """Return the instant a session is measured to.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.
    as_of : datetime.datetime
        Now, in UTC, as the client reports it. Used for a running session.

    Returns
    -------
    datetime.datetime
        `ended_at` for a finished session, `as_of` for a running one. Never
        earlier than `started_at`, so a clock that lags behind a check-in reads
        as zero rather than as a negative duration.
    """
    if entry.ended_at is not None:
        return entry.ended_at
    return max(entry.started_at, as_of)


def duration_seconds(entry: Session, as_of: datetime) -> int:
    """Return how long a session lasted, or has lasted so far.

    Computed from the UTC instants, so it is exact across a daylight-saving
    change where local arithmetic would be an hour out.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.
    as_of : datetime.datetime
        Now, in UTC. Only consulted for a running session.

    Returns
    -------
    int
        Whole seconds.
    """
    return int((_ends_at(entry, as_of) - entry.started_at).total_seconds())


def starting_day(entry: Session) -> date:
    """Return the local day a session belongs to.

    Read with the session's *own* offset, never the day's. The day's offset
    comes from its first session, so asking the day first would be circular;
    this uses only what the session itself carries.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.

    Returns
    -------
    datetime.date
        The local day the session began in.
    """
    return local_day(entry.started_at, entry.utc_offset)


def day_offsets(entries: list[Session]) -> dict[date, int]:
    """Decide each local day's offset from the session that opened it.

    A day is supposed to be a fixed 24-hour window. Letting every session carry
    its own offset made a day mean two things at once after a flight - two
    sessions both reading 09:00, an hour apart, with different midnights. One
    offset per day gives the window back.

    Parameters
    ----------
    entries : list of models.TimeEntry
        The sessions to consider, in any order.

    Returns
    -------
    dict
        ``{day: offset in minutes}``, taken from the earliest-starting session
        of each day. Days absent from the sessions are absent here too.
    """
    opener: dict[date, object] = {}
    for entry in entries:
        day = starting_day(entry)
        held = opener.get(day)
        if held is None or entry.started_at < held.started_at:
            opener[day] = entry
    return {day: entry.utc_offset for day, entry in opener.items()}


def daily_spans(
    entry: Session, as_of: datetime, offsets: dict[date, int] | None = None
) -> list[tuple[date, datetime, int]]:
    """Divide a session across its local days, keeping where each part starts.

    The same division as `daily_slices`, which is built on this one, with each
    part's start kept as a UTC instant. That is what `covered_seconds` needs to
    tell two sessions overlapping in real time from two that merely share a
    day: two sessions told by different clocks can read alike on the wall and
    still be hours apart.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.
    as_of : datetime.datetime
        Now, in UTC. Only consulted for a running session.
    offsets : dict, optional
        ``{day: offset}`` as `day_offsets` returns. See `daily_slices`.

    Returns
    -------
    list of (datetime.date, datetime.datetime, int)
        One triple per local day the session covers, in order: the day, the
        UTC instant its part starts, and the seconds falling in that day.
    """
    offsets = offsets or {}
    home = starting_day(entry)
    minutes = offsets.get(home, entry.utc_offset)
    offset = timedelta(minutes=minutes)
    cursor = entry.started_at + offset
    finish = _ends_at(entry, as_of) + offset

    spans: list[tuple[date, datetime, int]] = []
    while cursor < finish:
        day = cursor.date()
        midnight = datetime.combine(day + timedelta(days=1), time.min)
        boundary = min(finish, midnight)

        # Spilling into a day that keeps a different clock: hand the rest back
        # to the day that started it rather than divide at a midnight the two
        # days disagree about.
        spills_into = day + timedelta(days=1)
        if boundary < finish and offsets.get(spills_into, minutes) != minutes:
            spans.append((day, cursor - offset, int((finish - cursor).total_seconds())))
            break

        spans.append((day, cursor - offset, int((boundary - cursor).total_seconds())))
        cursor = boundary
    return spans


def daily_slices(
    entry: Session, as_of: datetime, offsets: dict[date, int] | None = None
) -> list[tuple[date, int]]:
    """Divide a session across the local days it touches.

    A session from 22:00 to 02:00 yields two hours on each of two days. The
    slices always sum to `duration_seconds`, so no time is created or lost by
    the split, and the session itself stays one row - correcting a check-out
    time remains a single-row edit.

    A session is read in the offset of the day it belongs to, not its own, so
    every session on a day is told by the same clock. The one exception is a
    session that would spill into a day on a *different* offset: it is kept
    whole on the day it started. The two days' midnights are not the same
    instant, so splitting there would either count an hour twice or lose it,
    depending on which way the traveller went.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.
    as_of : datetime.datetime
        Now, in UTC. Only consulted for a running session.
    offsets : dict, optional
        ``{day: offset}`` as `day_offsets` returns. Without it every session is
        read in its own offset, which is the behaviour of a single-timezone
        history and keeps this callable with one session in hand.

    Returns
    -------
    list of (datetime.date, int)
        One pair per local day the session covers, in order, with the seconds
        falling in that day. Empty when the session has no duration yet.
    """
    return [(day, seconds) for day, _, seconds in daily_spans(entry, as_of, offsets)]


def covered_seconds(spans: list[tuple[datetime, int]]) -> int:
    """Total the time a set of spans covers, counting shared seconds once.

    Overlapping sessions on one project are kept as recorded, and this is
    where their overlap stops being counted twice: the same arithmetic a merge
    would do, done when a total is read rather than when a session is written.
    Spans that only touch, or do not meet, add up exactly as before.

    Parameters
    ----------
    spans : list of (datetime.datetime, int)
        Each span's UTC start and its length in seconds, in any order.

    Returns
    -------
    int
        The seconds covered by at least one span.
    """
    total = 0
    reach: datetime | None = None
    for start, seconds in sorted(spans):
        end = start + timedelta(seconds=seconds)
        if reach is None or start >= reach:
            total += seconds
            reach = end
        elif end > reach:
            total += int((end - reach).total_seconds())
            reach = end
    return total


def check_no_overlap(entry: Session, others: list[Session]) -> None:
    """Check that a session does not overlap another on the same project.

    Only the pomodoro transfer asks this now. Overlapping sessions are
    otherwise kept, and `summarise` counts the minutes they share once; the
    transfer refuses instead, because it is a deliberate press with somebody
    watching and the refusal is what stops one day being copied twice.

    Parameters
    ----------
    entry : models.TimeEntry
        The session being written. A running session, with no end, is treated
        as reaching to the end of time.
    others : list of models.TimeEntry
        The user's other sessions, of which only the same project's matter.

    Raises
    ------
    TimeRuleError
        If the session covers any minute another already covers.
    """
    start = entry.started_at
    finish = entry.ended_at or datetime.max

    for other in others:
        if other.id is not None and other.id == getattr(entry, "id", None):
            continue
        if other.project_id != entry.project_id:
            continue
        if start < (other.ended_at or datetime.max) and other.started_at < finish:
            raise TimeRuleError("This overlaps another session on the same project")


@runtime_checkable
class Band(Protocol):
    """One step of a tag's deduction rule, whatever is carrying it.

    A `Protocol` for the same reason `Session` is one: the corpus dump builds
    these from its own dataclass, so the rules must state the shape rather than
    the class.
    """

    from_minutes: int
    """Tracked minutes at or above which this band applies."""

    deduct_minutes: int | None
    """Minutes to take off, or None to cap what the day reports after its break."""


def added_for(tracked_seconds: int, add_minutes: int | None) -> int:
    """Return the time a tag's rule adds to a day, in seconds.

    A flat amount on any day the tag tracked anything at all, with no minimum:
    one tracked minute earns the whole of it.

    Parameters
    ----------
    tracked_seconds : int
        What was tracked on the day, for one tag.
    add_minutes : int or None
        The tag's addition, or None for a tag that adds nothing.

    Returns
    -------
    int
        Seconds to add. Zero when nothing was tracked — the mirror of a day off
        owing no lunch break, and what keeps an untracked day from sprouting an
        hour it never worked.
    """
    if tracked_seconds <= 0 or not add_minutes:
        return 0
    return add_minutes * 60


def deduction_for(tracked_seconds: int, bands: list[Band]) -> int:
    """Return the deduction a day of this length attracts, in seconds.

    Of the bands that deduct (breaks), the highest threshold the day reaches is
    the one that applies, and it never takes the day below zero - ten minutes
    tracked minus a thirty minute break is nothing, not minus twenty.

    A band with no `deduct_minutes` caps instead: what the day reports after
    its break never exceeds the threshold. The break comes off first, as the
    employer takes it, so a ten hour cap behind a 45 minute break bites only
    past 10h45, and a day of exactly ten hours still owes its break. Of two
    caps the lower binds.

    Parameters
    ----------
    tracked_seconds : int
        What was tracked on the day, for one tag.
    bands : list of Band
        The tag's rule, in any order.

    Returns
    -------
    int
        Seconds to remove. Zero when nothing was tracked: a day off owes no
        lunch break.
    """
    if tracked_seconds <= 0 or not bands:
        return 0
    reached = [
        band
        for band in bands
        if band.deduct_minutes is not None and band.from_minutes * 60 <= tracked_seconds
    ]
    taken = 0
    if reached:
        band = max(reached, key=lambda held: held.from_minutes)
        taken = min(tracked_seconds, band.deduct_minutes * 60)
    caps = [band.from_minutes * 60 for band in bands if band.deduct_minutes is None]
    if caps:
        taken += max(0, tracked_seconds - taken - min(caps))
    return taken


def reported(
    tracked_seconds: int, bands: list[Band], add_minutes: int | None = None
) -> int:
    """Return what a day reports after its tag's whole rule.

    The addition lands **first**, and the bands are then tested against the
    increased total rather than the tracked one. That ordering is the rule, not
    an implementation detail: three hours does not reach a three-and-a-half hour
    threshold, and three hours plus an added one does, so the same band applies
    in one case and not the other.

    Parameters
    ----------
    tracked_seconds : int
        What was tracked on the day, for one tag.
    bands : list of models.DeductionBand
        The tag's deduction bands.
    add_minutes : int or None, optional
        The tag's addition, by default None.

    Returns
    -------
    int
        What the day reports, never below zero.
    """
    total = tracked_seconds + added_for(tracked_seconds, add_minutes)
    return total - deduction_for(total, bands)


def summarise(entries: list[Session], as_of: datetime) -> dict[date, dict[int, int]]:
    """Total the time each project holds on each local day.

    Parameters
    ----------
    entries : list of models.TimeEntry
        The sessions to count, in any order.
    as_of : datetime.datetime
        Now, in UTC, for any session still running.

    Returns
    -------
    dict
        ``{day: {project_id: seconds}}``. Within a project, minutes covered by
        more than one session count once: the sessions are kept as recorded and
        the overlap is resolved here. Across projects sessions are simply added,
        so a day's total can exceed 24 hours - that is what a sum over projects
        means, and nothing here pretends otherwise.
    """
    offsets = day_offsets(entries)
    parts: dict[date, dict[int, list[tuple[datetime, int]]]] = {}
    for entry in entries:
        for day, start, seconds in daily_spans(entry, as_of, offsets):
            if seconds:
                parts.setdefault(day, {}).setdefault(entry.project_id, []).append(
                    (start, seconds)
                )
    return {
        day: {project: covered_seconds(spans) for project, spans in by_project.items()}
        for day, by_project in parts.items()
    }


def group_by_tag(
    totals: dict[date, dict[int, int]], tags_of: dict[int, list[int]]
) -> dict[date, dict[int | None, int]]:
    """Regroup per-project totals under the tags that cover those projects.

    A project carrying two tags counts fully toward both, so the tag numbers
    overlap. They are a view of the same time from a different angle, not a
    partition of it, which is the price of letting one project be both "Work"
    and "Meetings".

    Parameters
    ----------
    totals : dict
        ``{day: {project_id: seconds}}``, as `summarise` returns.
    tags_of : dict
        ``{project_id: [tag_id, ...]}``. A project absent from this mapping, or
        present with an empty list, is untagged.

    Returns
    -------
    dict
        ``{day: {tag_id: seconds}}``, with ``None`` as the key for untagged
        work, so the regrouping still accounts for every tracked second.
    """
    grouped: dict[date, dict[int | None, int]] = {}
    for day, by_project in totals.items():
        bucket = grouped.setdefault(day, {})
        for project_id, seconds in by_project.items():
            keys: list[int | None] = list(tags_of.get(project_id) or [None])
            for key in keys:
                bucket[key] = bucket.get(key, 0) + seconds
    return grouped


TAKEN_FROM_BALANCE = "balance"
"""The day-off kind that costs its hours rather than excusing them."""

MONDAY_TO_FRIDAY = 0b0011111
"""The default workdays of a contract, as a bitmask with Monday as bit 0."""

BudgetKind = Literal["workday", "rest", "holiday", "off"]
"""What a day is to a contract.

``workday`` expects the contract's hours; ``rest`` is a day the contract does
not work (a weekend, or every day of a zero-hour period); ``holiday`` is a
public holiday in the contract's state; ``off`` is a day off marked by hand.
Tested in that order, so a public holiday on a Saturday reads as a holiday and
a day off marked on a weekend changes nothing.
"""


@dataclass(frozen=True)
class ContractPeriod:
    """One period of a tag's contract, in force from its start until the next."""

    starts_on: date
    """The first local day this period applies to."""

    daily_minutes: int
    """The average hours per workday, in minutes. Zero ends the contract."""

    workdays: int = MONDAY_TO_FRIDAY
    """The days of the week it works, as a bitmask with Monday as bit 0."""

    state: str | None = None
    """The federal state whose public holidays it keeps, or None for none."""


@dataclass(frozen=True)
class BudgetDay:
    """One day of an hour budget."""

    day: date
    """The local day."""

    kind: BudgetKind
    """What the day is to the contract in force on it."""

    name: str | None
    """The public holiday's name, or the day off's kind; None otherwise."""

    expected: int
    """Seconds the contract expected of the day."""

    counted: int
    """Seconds the day counts: tracked, through the parts of the rule switched on."""

    reset: int | None
    """The balance a reset fixed at the start of this day, in seconds, if any."""

    balance: int
    """The balance after the day, in seconds; for today, the balance before it."""

    open: bool
    """Whether this is today, which shows its progress and counts once it is over."""


def budget_days(
    *,
    tracked: dict[date, int],
    contracts: list[ContractPeriod],
    today: date,
    add_minutes: int | None = None,
    bands: list[Band] | None = None,
    days_off: dict[date, str] | None = None,
    resets: dict[date, int] | None = None,
) -> list[BudgetDay]:
    """Walk a tag's hour budget from its contract's start to today.

    Derived, never stored: a contract period, a day off, a reset or a change to
    the rule changes every day after it on the next read. Each day counts what
    the tag reports — the whole rule — minus what the contract expected; a reset
    fixes the balance at the start of its day; today shows its progress and
    counts once it is over. Nothing before the first period is expected, so the
    walk starts there, and a reset before it is ignored.

    Parameters
    ----------
    tracked : dict
        ``{day: seconds}`` the tag tracked, archived projects included.
    contracts : list of ContractPeriod
        The tag's contract periods, in any order.
    today : datetime.date
        The local day in progress.
    add_minutes : int or None, optional
        The tag's addition.
    bands : list of Band, optional
        The tag's bands.
    days_off : dict, optional
        ``{day: kind}`` of days off marked by hand. Every kind but
        ``balance`` excuses the day; ``balance`` keeps its expected hours, so it
        costs them as an untracked workday would.
    resets : dict, optional
        ``{day: seconds}`` of the balance fixed at the start of a day.

    Returns
    -------
    list of BudgetDay
        One per day from the first period's start to today, oldest first. Empty
        without a contract.
    """
    periods = sorted(contracts, key=lambda period: period.starts_on)
    if not periods:
        return []
    bands = bands or []
    days_off = days_off or {}
    resets = resets or {}
    holidays_by_year: dict[tuple[str | None, int], dict[date, str]] = {}

    rows: list[BudgetDay] = []
    balance = 0
    day = periods[0].starts_on
    current = 0
    while day <= today:
        while current + 1 < len(periods) and periods[current + 1].starts_on <= day:
            current += 1
        period = periods[current]
        key = (period.state, day.year)
        if key not in holidays_by_year:
            holidays_by_year[key] = public_holidays(period.state, day.year)
        holiday = holidays_by_year[key].get(day)
        works = (
            bool(period.workdays & (1 << day.weekday())) and period.daily_minutes > 0
        )

        if holiday is not None:
            kind, name = "holiday", holiday
        elif not works:
            kind, name = "rest", None
        elif day in days_off:
            kind, name = "off", days_off[day]
        else:
            kind, name = "workday", None
        # A day off taken from the balance is still a day off, but it costs its
        # hours: only the kinds that excuse a day take its expectation away.
        costs = kind == "workday" or (kind == "off" and name == TAKEN_FROM_BALANCE)
        expected = period.daily_minutes * 60 if costs else 0
        counted = reported(tracked.get(day, 0), bands, add_minutes)

        reset = resets.get(day)
        if reset is not None:
            balance = reset
        is_today = day == today
        if not is_today:
            balance += counted - expected
        rows.append(
            BudgetDay(
                day=day,
                kind=kind,
                name=name,
                expected=expected,
                counted=counted,
                reset=reset,
                balance=balance,
                open=is_today,
            )
        )
        day += timedelta(days=1)
    return rows
