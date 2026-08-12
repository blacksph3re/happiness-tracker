from datetime import UTC, date, datetime, timedelta
from io import BytesIO

from fastapi import APIRouter, HTTPException, Query, Response, status
from openpyxl import Workbook
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from deps import CurrentUser, DbSession
from models import Project, Tag, TimeEntry
from routers.projects import own_project, running_entry
from schemas import (
    CheckIn,
    CheckOut,
    SummaryRow,
    TimeEntryCreate,
    TimeEntryOut,
    TimeEntryUpdate,
)
from services import (
    TimeRuleError,
    check_entry_shape,
    daily_slices,
    group_by_tag,
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


def _enforce(rule) -> None:
    """Run a session rule, turning its complaint into a 422.

    Parameters
    ----------
    rule : collections.abc.Callable
        A no-argument callable that raises `TimeRuleError` when unhappy.

    Raises
    ------
    fastapi.HTTPException
        With status 422 carrying the rule's own message.
    """
    try:
        rule()
    except TimeRuleError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from None


def _own_entry(db: DbSession, user: CurrentUser, entry_id: int) -> TimeEntry:
    """Load one of the signed-in user's sessions.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user : User
        The authenticated user.
    entry_id : int
        Identifier of the session.

    Returns
    -------
    TimeEntry
        The session.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when it does not exist or belongs to someone else.
    """
    entry = db.execute(
        select(TimeEntry).where(TimeEntry.id == entry_id, TimeEntry.user_id == user.id)
    ).scalar_one_or_none()
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
        )
    return entry


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


@router.post(
    "/projects/{project_id}/check-in",
    response_model=TimeEntryOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="checkIn",
    summary="Start a timer",
    description=(
        "Open a session on a project. Other projects may already be running - "
        "this never closes them."
    ),
)
def check_in(
    project_id: int, payload: CheckIn, user: CurrentUser, db: DbSession
) -> TimeEntry:
    """Start a timer on a project.

    Parameters
    ----------
    project_id : int
        Identifier of the project.
    payload : CheckIn
        When the check-in happened and where the client is.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TimeEntry
        The newly opened session.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when the project is archived or already running.
    """
    project = own_project(db, user, project_id)
    if not project.active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project is archived. Reactivate it to track against it.",
        )
    if running_entry(db, user, project.id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project is already running",
        )
    _enforce(lambda: check_entry_shape(payload.at, None, payload.utc_offset))

    entry = TimeEntry(
        user_id=user.id,
        project_id=project.id,
        started_at=payload.at,
        ended_at=None,
        utc_offset=payload.utc_offset,
        note=payload.note,
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError:
        # Two devices tapping the same card at once. The check above lost the
        # race, and the partial index caught it - which should read as the same
        # refusal, not as a server error.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project is already running",
        ) from None
    db.refresh(entry)
    return entry


@router.post(
    "/projects/{project_id}/check-out",
    response_model=TimeEntryOut,
    operation_id="checkOut",
    summary="Stop a timer",
    description="Close the session running on a project.",
)
def check_out(
    project_id: int, payload: CheckOut, user: CurrentUser, db: DbSession
) -> TimeEntry:
    """Stop the timer running on a project.

    Parameters
    ----------
    project_id : int
        Identifier of the project.
    payload : CheckOut
        When the check-out happened.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TimeEntry
        The closed session.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when nothing is running on that project - a silent
        no-op would leave the caller believing time was recorded.
    """
    project = own_project(db, user, project_id)
    entry = running_entry(db, user, project.id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This project is not running",
        )
    _enforce(lambda: check_entry_shape(entry.started_at, payload.at, entry.utc_offset))
    entry.ended_at = payload.at
    db.commit()
    db.refresh(entry)
    return entry


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


@router.post(
    "/time/entries",
    response_model=TimeEntryOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="createTimeEntry",
    summary="Record a past session",
    description=(
        "Add a session that was never tracked live. Always finished: a timer "
        "is started with check-in."
    ),
)
def create_entry(
    payload: TimeEntryCreate, user: CurrentUser, db: DbSession
) -> TimeEntry:
    """Record a session by hand.

    Parameters
    ----------
    payload : TimeEntryCreate
        The session to record.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TimeEntry
        The recorded session.
    """
    project = own_project(db, user, payload.project_id)
    _enforce(
        lambda: check_entry_shape(
            payload.started_at, payload.ended_at, payload.utc_offset
        )
    )
    entry = TimeEntry(
        user_id=user.id,
        project_id=project.id,
        started_at=payload.started_at,
        ended_at=payload.ended_at,
        utc_offset=payload.utc_offset,
        note=payload.note,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put(
    "/time/entries/{entry_id}",
    response_model=TimeEntryOut,
    operation_id="updateTimeEntry",
    summary="Correct a session",
    description=(
        "Change either end, the project or the note. Overlapping other "
        "sessions is allowed - parallel timers are the point."
    ),
)
def update_entry(
    entry_id: int, payload: TimeEntryUpdate, user: CurrentUser, db: DbSession
) -> TimeEntry:
    """Correct a recorded session.

    Parameters
    ----------
    entry_id : int
        Identifier of the session.
    payload : TimeEntryUpdate
        Fields to apply. Omitted fields are left alone.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    TimeEntry
        The corrected session.

    Raises
    ------
    fastapi.HTTPException
        With status 409 when moving a running session onto a project whose
        timer is already going, which the database would refuse anyway.
    """
    entry = _own_entry(db, user, entry_id)

    if payload.project_id is not None and payload.project_id != entry.project_id:
        moved_to = own_project(db, user, payload.project_id)
        if entry.ended_at is None and running_entry(db, user, moved_to.id) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That project is already running",
            )
        entry.project_id = moved_to.id

    started = payload.started_at if payload.started_at is not None else entry.started_at
    ended = payload.ended_at if payload.ended_at is not None else entry.ended_at
    _enforce(lambda: check_entry_shape(started, ended, entry.utc_offset))
    entry.started_at = started
    entry.ended_at = ended
    if payload.note is not None:
        entry.note = payload.note

    db.commit()
    db.refresh(entry)
    return entry


@router.delete(
    "/time/entries/{entry_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteTimeEntry",
    summary="Delete a session",
    description=(
        "Remove a session outright. A check-in to the wrong project is not a "
        "record to be corrected, it is a row that should not exist."
    ),
)
def delete_entry(entry_id: int, user: CurrentUser, db: DbSession) -> None:
    """Delete a session.

    Parameters
    ----------
    entry_id : int
        Identifier of the session.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    """
    db.delete(_own_entry(db, user, entry_id))
    db.commit()


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
    entries = _entries_in_range(db, user_id, start, end)
    totals = summarise(entries, as_of)
    if by == "tag":
        totals = group_by_tag(totals, _tags_of(db, user_id))

    rows = []
    for day in sorted(totals):
        if start is not None and day < start:
            continue
        if end is not None and day > end:
            continue
        ordered = sorted(totals[day].items(), key=lambda kv: (kv[0] is None, kv[0]))
        for key, seconds in ordered:
            rows.append(SummaryRow(day=day, key=key, seconds=seconds))
    return rows


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


@router.get(
    "/time/export.xlsx",
    operation_id="exportTime",
    summary="Download sessions as a spreadsheet",
    description=(
        "Every session on one sheet, with the daily totals per project and per "
        "tag on two more, worked out the same way the app shows them."
    ),
    responses={
        200: {
            "content": {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {}
            },
            "description": "An .xlsx workbook.",
        }
    },
)
def export_time(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    as_of: datetime | None = Query(default=None),
) -> Response:
    """Build a spreadsheet of the signed-in user's sessions.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    start : datetime.date or None
        First local day to include.
    end : datetime.date or None
        Last local day to include.
    as_of : datetime.datetime or None
        Now, in UTC, for any session still running.

    Returns
    -------
    fastapi.Response
        An ``.xlsx`` attachment.
    """
    moment = as_of or _server_now()
    entries = _entries_in_range(db, user.id, start, end)
    projects = {
        p.id: p
        for p in db.execute(select(Project).where(Project.user_id == user.id))
        .scalars()
        .all()
    }
    tags = {
        t.id: t
        for t in db.execute(select(Tag).where(Tag.user_id == user.id)).scalars().all()
    }

    workbook = Workbook()
    sessions = workbook.active
    sessions.title = "Sessions"
    sessions.append(["Project", "Started (UTC)", "Ended (UTC)", "Hours", "Note"])
    for entry in entries:
        seconds = sum(seconds for _, seconds in daily_slices(entry, moment))
        sessions.append(
            [
                projects[entry.project_id].name if entry.project_id in projects else "",
                entry.started_at.isoformat(sep=" ", timespec="minutes"),
                entry.ended_at.isoformat(sep=" ", timespec="minutes")
                if entry.ended_at
                else "running",
                round(seconds / 3600, 2),
                entry.note or "",
            ]
        )

    for title, grouping, names in (
        ("By project", "project", lambda key: projects[key].name),
        (
            "By tag",
            "tag",
            lambda key: tags[key].name if key is not None else "Untagged",
        ),
    ):
        sheet = workbook.create_sheet(title)
        sheet.append(["Day", title.removeprefix("By ").capitalize(), "Hours"])
        for row in _summary_rows(db, user.id, start, end, moment, grouping):
            sheet.append(
                [row.day.isoformat(), names(row.key), round(row.seconds / 3600, 2)]
            )

    buffer = BytesIO()
    workbook.save(buffer)
    return Response(
        content=buffer.getvalue(),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={"Content-Disposition": 'attachment; filename="tracked-time.xlsx"'},
    )
