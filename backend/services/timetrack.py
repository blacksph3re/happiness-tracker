"""Rules and arithmetic for tracked time.

Framework-free, like the wellbeing rules beside it: what a session *is*, and how
its duration divides across the days it touches. Nothing here reads the database
or knows about HTTP.
"""

from datetime import date, datetime, time, timedelta

MAX_UTC_OFFSET = 14 * 60
"""Largest real UTC offset in minutes. Kiribati is +14; nowhere is further."""

MIN_UTC_OFFSET = -12 * 60
"""Smallest real UTC offset in minutes."""


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


def daily_slices(entry, as_of: datetime) -> list[tuple[date, int]]:
    """Divide a session across the local days it touches.

    A session from 22:00 to 02:00 yields two hours on each of two days. The
    slices always sum to `duration_seconds`, so no time is created or lost by
    the split, and the session itself stays one row - correcting a check-out
    time remains a single-row edit.

    Local time is the stored instant plus the offset captured at check-in. A
    session spanning a daylight-saving change therefore carries one offset, so
    its boundaries can sit an hour out on the far side of the change; the total
    stays exact.

    Parameters
    ----------
    entry : models.TimeEntry
        The session.
    as_of : datetime.datetime
        Now, in UTC. Only consulted for a running session.

    Returns
    -------
    list of (datetime.date, int)
        One pair per local day the session covers, in order, with the seconds
        falling in that day. Empty when the session has no duration yet.
    """
    offset = timedelta(minutes=entry.utc_offset)
    cursor = entry.started_at + offset
    finish = _ends_at(entry, as_of) + offset

    slices: list[tuple[date, int]] = []
    while cursor < finish:
        day = cursor.date()
        midnight = datetime.combine(day + timedelta(days=1), time.min)
        boundary = min(finish, midnight)
        slices.append((day, int((boundary - cursor).total_seconds())))
        cursor = boundary
    return slices


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
    totals: dict[date, dict[int, int]] = {}
    for entry in entries:
        for day, seconds in daily_slices(entry, as_of):
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
