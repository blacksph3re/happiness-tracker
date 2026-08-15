from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import DeductionBand, Project, Tag, TimeEntry
from routers.projects import own_tag
from schemas import (
    DeductionBandIn,
    DeductionBandOut,
    SummaryRow,
    TimeEntryOut,
    TrackedRange,
)
from services import (
    deduction_for,
    group_by_tag,
    reported,
    starting_day,
    summarise,
)

router = APIRouter(tags=["Time"])

RANGE_PAD = timedelta(days=1)
"""How far either side of a requested range the query reaches.

A range is asked for in local days but stored as UTC instants, and the two can
differ by up to fourteen hours. Padding by a whole day is cheap and means no
session is missed at the edges.
"""


def _server_now() -> datetime:
    """Return now as a naive UTC instant, matching how sessions are stored.

    Only a fallback: a client that sends its own `as_of` keeps the screen and
    anything computed here agreeing to the second.

    Returns
    -------
    datetime.datetime
        The current UTC instant, without a timezone.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def _entries_in_range(
    db: DbSession, user_id: int, start: date | None, end: date | None
) -> list[TimeEntry]:
    """Return the sessions overlapping a range of local days.

    Overlapping, not beginning inside: a session running across the start of
    the window belongs to it, and dropping it would lose the hours the window
    is asking about.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose sessions to read.
    start : datetime.date or None
        First local day of interest, or None for no lower bound.
    end : datetime.date or None
        Last local day of interest, or None for no upper bound.

    Returns
    -------
    list of TimeEntry
        Matching sessions, oldest first.
    """
    statement = select(TimeEntry).where(TimeEntry.user_id == user_id)
    if start is not None:
        lower = datetime.combine(start, datetime.min.time()) - RANGE_PAD
        statement = statement.where(
            or_(TimeEntry.ended_at.is_(None), TimeEntry.ended_at > lower)
        )
    if end is not None:
        upper = (
            datetime.combine(end, datetime.min.time()) + RANGE_PAD + timedelta(days=1)
        )
        statement = statement.where(TimeEntry.started_at < upper)
    return (
        db.execute(statement.order_by(TimeEntry.started_at, TimeEntry.id))
        .scalars()
        .all()
    )


@router.get(
    "/time/entries",
    response_model=list[TimeEntryOut],
    operation_id="listTimeEntries",
    summary="List sessions",
    description=(
        "Every session of the signed-in account overlapping the range, the "
        "running ones included."
    ),
)
def list_entries(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
) -> list[TimeEntry]:
    """Return the signed-in user's sessions over a range of local days.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    start : datetime.date or None
        First local day of interest.
    end : datetime.date or None
        Last local day of interest.

    Returns
    -------
    list of TimeEntry
        Matching sessions, never including another user's.
    """
    return _entries_in_range(db, user.id, start, end)


def _tags_of(db: DbSession, user_id: int) -> dict[int, list[int]]:
    """Map each of the user's projects to the tags covering it.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose projects to read.

    Returns
    -------
    dict
        ``{project_id: [tag_id, ...]}``, empty list for an untagged project.
    """
    projects = (
        db.execute(
            select(Project)
            .options(selectinload(Project.tags))
            .where(Project.user_id == user_id)
        )
        .scalars()
        .all()
    )
    return {p.id: [tag.id for tag in p.tags] for p in projects}


def _local(instant: datetime | None, utc_offset: int) -> str:
    """Render an instant in the offset it was recorded in.

    Parameters
    ----------
    instant : datetime.datetime or None
        The stored UTC instant, or None for a session still running.
    utc_offset : int
        Minutes east of UTC captured at check-in.

    Returns
    -------
    str
        ``YYYY-MM-DD HH:MM`` local, or an empty string when there is nothing to
        render.
    """
    if instant is None:
        return ""
    return (instant + timedelta(minutes=utc_offset)).isoformat(
        sep=" ", timespec="minutes"
    )


def _day_offset(entry, offsets: dict) -> int:
    """Return the offset the entry's day keeps.

    Parameters
    ----------
    entry : TimeEntry
        The session.
    offsets : dict
        ``{day: offset}`` as `day_offsets` returns.

    Returns
    -------
    int
        The day's offset, falling back to the session's own.
    """
    return offsets.get(starting_day(entry), entry.utc_offset)


def _offset_label(utc_offset: int) -> str:
    """Render a UTC offset the way a clock reads it, e.g. ``UTC+02:00``.

    Parameters
    ----------
    utc_offset : int
        Minutes east of UTC.

    Returns
    -------
    str
        The offset in hours and minutes, signed.
    """
    sign = "+" if utc_offset >= 0 else "-"
    minutes = abs(utc_offset)
    return f"UTC{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def _bands_of(db: DbSession, user_id: int) -> dict[int, list]:
    """Map each of the user's tags to its deduction rule.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose tags to read.

    Returns
    -------
    dict
        ``{tag_id: [DeductionBand, ...]}``, absent for a tag with no rule.
    """
    tags = (
        db.execute(
            select(Tag).options(selectinload(Tag.bands)).where(Tag.user_id == user_id)
        )
        .scalars()
        .all()
    )
    return {tag.id: list(tag.bands) for tag in tags if tag.bands}


def _summary_rows(
    db: DbSession,
    user_id: int,
    start: date | None,
    end: date | None,
    as_of: datetime,
    by: str,
) -> list[SummaryRow]:
    """Total tracked time per day, grouped by project or by tag.

    The one place the midnight split and the tag regrouping happen, so the
    screen and the spreadsheet cannot disagree about either.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose sessions to total.
    start : datetime.date or None
        First local day to report.
    end : datetime.date or None
        Last local day to report.
    as_of : datetime.datetime
        Now, in UTC, for any session still running.
    by : str
        ``project`` or ``tag``.

    Returns
    -------
    list of SummaryRow
        One row per day and group, in day order.
    """
    # Archived projects are retired from the reports the way a deactivated
    # question is: the sessions stay in the record and in the export, because
    # they happened, but a project nobody tracks any more is not a pattern.
    live = {
        project_id
        for (project_id,) in db.execute(
            select(Project.id).where(
                Project.user_id == user_id, Project.active.is_(True)
            )
        )
    }
    entries = [
        entry
        for entry in _entries_in_range(db, user_id, start, end)
        if entry.project_id in live
    ]
    totals = summarise(entries, as_of)
    bands: dict[int, list] = {}
    if by == "tag":
        totals = group_by_tag(totals, _tags_of(db, user_id))
        bands = _bands_of(db, user_id)

    rows = []
    for day in sorted(totals):
        if start is not None and day < start:
            continue
        if end is not None and day > end:
            continue
        ordered = sorted(totals[day].items(), key=lambda kv: (kv[0] is None, kv[0]))
        for key, seconds in ordered:
            rule = bands.get(key, [])
            rows.append(
                SummaryRow(
                    day=day,
                    key=key,
                    seconds=seconds,
                    deduction=deduction_for(seconds, rule),
                    reported=reported(seconds, rule),
                )
            )
    return rows


@router.get(
    "/tags/{tag_id}/deductions",
    response_model=list[DeductionBandOut],
    operation_id="listDeductions",
    summary="Read a tag's deduction rule",
    description=(
        "The bands turning this tag's tracked time into reported time, lowest "
        "threshold first. An empty list means no deduction."
    ),
)
def list_deductions(tag_id: int, user: CurrentUser, db: DbSession) -> list:
    """Return a tag's deduction bands.

    Parameters
    ----------
    tag_id : int
        Identifier of the tag.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of DeductionBand
        The bands, lowest threshold first.
    """
    own_tag(db, user, tag_id)
    return (
        db.execute(
            select(DeductionBand)
            .where(DeductionBand.tag_id == tag_id)
            .order_by(DeductionBand.from_minutes)
        )
        .scalars()
        .all()
    )


@router.put(
    "/tags/{tag_id}/deductions",
    response_model=list[DeductionBandOut],
    operation_id="setDeductions",
    summary="Replace a tag's deduction rule",
    description=(
        "Send the whole rule. A rule is edited as one thing - the bands only "
        "mean anything in relation to each other."
    ),
)
def set_deductions(
    tag_id: int, payload: list[DeductionBandIn], user: CurrentUser, db: DbSession
) -> list:
    """Replace a tag's deduction bands.

    The whole set at once rather than row by row: the bands are one rule with
    an ordering, and validating "no two thresholds the same" is only possible
    against the complete list.

    Parameters
    ----------
    tag_id : int
        Identifier of the tag.
    payload : list of DeductionBandIn
        The rule the tag should have afterwards.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of DeductionBand
        The stored rule, lowest threshold first.

    Raises
    ------
    fastapi.HTTPException
        With status 422 when two bands share a threshold.
    """
    tag = own_tag(db, user, tag_id)
    thresholds = [band.from_minutes for band in payload]
    if len(set(thresholds)) != len(thresholds):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Two bands cannot start at the same number of minutes",
        )

    for existing in db.execute(
        select(DeductionBand).where(DeductionBand.tag_id == tag.id)
    ).scalars():
        db.delete(existing)
    db.flush()
    for band in payload:
        db.add(
            DeductionBand(
                tag_id=tag.id,
                from_minutes=band.from_minutes,
                deduct_minutes=band.deduct_minutes,
            )
        )
    db.commit()
    return list_deductions(tag_id, user, db)


@router.get(
    "/time/range",
    response_model=TrackedRange,
    operation_id="trackedRange",
    summary="The days tracking spans",
    description=(
        "The first and last local day with a session, so a window control can "
        "stop at the edges of the history instead of sliding into empty years."
    ),
)
def tracked_range(user: CurrentUser, db: DbSession) -> TrackedRange:
    """Return the first and last local day the user has tracked.

    Read in each session's own offset, which is what decides the day it belongs
    to. Null on both ends when nothing has been tracked at all.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TrackedRange
        The edges of the history.
    """
    entries = (
        db.execute(
            select(TimeEntry).where(TimeEntry.user_id == user.id)
        )
        .scalars()
        .all()
    )
    if not entries:
        return TrackedRange(first=None, last=None)
    days = [starting_day(entry) for entry in entries]
    return TrackedRange(first=min(days), last=max(days))


@router.get(
    "/time/summary",
    response_model=list[SummaryRow],
    operation_id="timeSummary",
    summary="Total tracked time",
    description=(
        "Tracked seconds per local day, grouped by project or by tag. Sessions "
        "crossing midnight are already split; parallel sessions are added, so "
        "a day can total more than 24 hours."
    ),
)
def summary(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    as_of: datetime | None = Query(default=None),
    by: str = Query(default="project", pattern="^(project|tag)$"),
) -> list[SummaryRow]:
    """Return tracked totals per day.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    start : datetime.date or None
        First local day to report.
    end : datetime.date or None
        Last local day to report.
    as_of : datetime.datetime or None
        Now, in UTC, as the client reports it. Only running sessions consult
        it; the server's own clock is the fallback, but a client that sends its
        own keeps the screen and this agreeing to the second.
    by : str
        ``project`` or ``tag``.

    Returns
    -------
    list of SummaryRow
        One row per day and group.
    """
    return _summary_rows(db, user.id, start, end, as_of or _server_now(), by)
