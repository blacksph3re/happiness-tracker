"""Rules and arithmetic for tracked time.

Framework-free, like the wellbeing rules beside it: what a session *is*, and how
its duration divides across the days it touches. Nothing here reads the database
or knows about HTTP.
"""

from datetime import date, datetime, time, timedelta

from services.clock import MAX_UTC_OFFSET, MIN_UTC_OFFSET, local_day


class TimeRuleError(ValueError):
    """Raised when a session does not describe an interval that could happen.

    A plain exception rather than an HTTP error, for the same reason
    `QuestionRuleError` is one: these are facts about what a session is, and
    they hold whether the caller arrived over HTTP or from a script. The router
    translates it into a 422.
    """


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


def _ends_at(entry, as_of: datetime) -> datetime:
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


def duration_seconds(entry, as_of: datetime) -> int:
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


def starting_day(entry) -> date:
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


def day_offsets(entries: list) -> dict[date, int]:
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


def daily_slices(entry, as_of: datetime, offsets: dict | None = None):
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
    offsets = offsets or {}
    home = starting_day(entry)
    minutes = offsets.get(home, entry.utc_offset)
    offset = timedelta(minutes=minutes)
    cursor = entry.started_at + offset
    finish = _ends_at(entry, as_of) + offset

    slices: list[tuple[date, int]] = []
    while cursor < finish:
        day = cursor.date()
        midnight = datetime.combine(day + timedelta(days=1), time.min)
        boundary = min(finish, midnight)

        # Spilling into a day that keeps a different clock: hand the rest back
        # to the day that started it rather than divide at a midnight the two
        # days disagree about.
        spills_into = day + timedelta(days=1)
        if boundary < finish and offsets.get(spills_into, minutes) != minutes:
            slices.append((day, int((finish - cursor).total_seconds())))
            break

        slices.append((day, int((boundary - cursor).total_seconds())))
        cursor = boundary
    return slices


def check_no_overlap(entry, others: list) -> None:
    """Check that a session does not overlap another on the same project.

    Two projects may run at once - that is the point of the tracker - but one
    project running twice over the same minutes is a double count, not a fact:
    the same hour would be reported twice under the same name.

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


def deduction_for(tracked_seconds: int, bands: list) -> int:
    """Return the deduction a day of this length attracts, in seconds.

    The highest threshold the day reaches is the one that applies, and the
    deduction never takes the day below zero - ten minutes tracked minus a
    thirty minute break is nothing, not minus twenty.

    A band with no `deduct_minutes` caps instead of deducting: it removes
    whatever the day ran past its threshold, so a ten hour cap reports ten
    hours however long the day actually was.

    Parameters
    ----------
    tracked_seconds : int
        What was tracked on the day, for one tag.
    bands : list of models.DeductionBand
        The tag's rule, in any order.

    Returns
    -------
    int
        Seconds to remove. Zero when nothing was tracked: a day off owes no
        lunch break.
    """
    if tracked_seconds <= 0 or not bands:
        return 0
    reached = [band for band in bands if band.from_minutes * 60 <= tracked_seconds]
    if not reached:
        return 0
    band = max(reached, key=lambda held: held.from_minutes)
    if band.deduct_minutes is None:
        return tracked_seconds - band.from_minutes * 60
    return min(tracked_seconds, band.deduct_minutes * 60)


def reported(tracked_seconds: int, bands: list, add_minutes: int | None = None) -> int:
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


def summarise(entries: list, as_of: datetime) -> dict[date, dict[int, int]]:
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
        ``{day: {project_id: seconds}}``. Parallel sessions are simply added, so
        a day's total across projects can exceed 24 hours - that is what a sum
        over projects means, and nothing here pretends otherwise.
    """
    offsets = day_offsets(entries)
    totals: dict[date, dict[int, int]] = {}
    for entry in entries:
        for day, seconds in daily_slices(entry, as_of, offsets):
            if seconds:
                by_project = totals.setdefault(day, {})
                by_project[entry.project_id] = (
                    by_project.get(entry.project_id, 0) + seconds
                )
    return totals


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
