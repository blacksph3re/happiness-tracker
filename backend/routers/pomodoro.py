"""Reading pomodoros, and copying a day of them onto a project.

There is no write endpoint here. A pomodoro is recorded the way a session is —
through the offline queue in `routers.sync` — because a focus timer is precisely
the thing somebody runs on a train. What this router owns is the two things a
device cannot work out for itself: the derived state of a row, and the transfer.

The transfer is the only point at which this half touches the other, and it is
deliberately one-way. It copies; it does not link.
"""

from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from deps import CurrentUser, DbSession
from models import Pomodoro, TimeEntry
from routers.projects import own_project
from schemas import PomodoroOut, TransferRequest
from services import (
    TimeRuleError,
    check_no_overlap,
    elapsed_seconds,
    local_day,
    pomodoro_state,
    split_seconds,
    transferable,
)

router = APIRouter(tags=["Focus"])

RANGE_PAD = timedelta(days=1)
"""How far either side of a requested range the query reaches.

A range is asked for in local days but stored as UTC instants, and the two can
differ by up to fourteen hours. Padding by a whole day is cheap and means no
pomodoro is missed at the edges.
"""


def _server_now() -> datetime:
    """Return now as a naive UTC instant, matching how pomodoros are stored.

    Only a fallback: a client that sends its own `as_of` keeps the screen and
    anything computed here agreeing to the second.

    Returns
    -------
    datetime.datetime
        The current UTC instant, without a timezone.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def pomodoro_out(pomodoro: Pomodoro, as_of: datetime) -> PomodoroOut:
    """Project one pomodoro, with the four fields that are computed on read.

    Public because `routers.sync` returns a pomodoro too, and the two must agree
    on what one looks like.

    Parameters
    ----------
    pomodoro : Pomodoro
        The row.
    as_of : datetime.datetime
        Now, in UTC. Only consulted to tell running from finished.

    Returns
    -------
    PomodoroOut
        The row plus its state and its elapsed time, split into the two phases.
    """
    focus, rest = split_seconds(pomodoro)
    return PomodoroOut(
        id=pomodoro.id,
        task=pomodoro.task,
        started_at=pomodoro.started_at,
        ended_at=pomodoro.ended_at,
        utc_offset=pomodoro.utc_offset,
        focus_seconds=pomodoro.focus_seconds,
        break_seconds=pomodoro.break_seconds,
        tainted=pomodoro.tainted,
        transferred_at=pomodoro.transferred_at,
        client_id=pomodoro.client_id,
        state=pomodoro_state(pomodoro, as_of),
        elapsed_seconds=elapsed_seconds(pomodoro),
        focus_elapsed_seconds=focus,
        break_elapsed_seconds=rest,
    )


def _in_range(
    db: DbSession, user_id: int, start: date | None, end: date | None
) -> list[Pomodoro]:
    """Return the pomodoros beginning within a range of local days.

    Beginning inside, not overlapping: a pomodoro belongs whole to the day it
    started on, as a session does, and no pomodoro is long enough for the
    distinction to matter in practice.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    user_id : int
        Whose pomodoros to read.
    start : datetime.date or None
        First local day wanted, or None for no lower bound.
    end : datetime.date or None
        Last local day wanted, or None for no upper bound.

    Returns
    -------
    list of Pomodoro
        Earliest first, never another account's.
    """
    query = select(Pomodoro).where(Pomodoro.user_id == user_id)
    if start is not None:
        query = query.where(
            Pomodoro.started_at
            >= datetime.min.combine(start, datetime.min.time()) - RANGE_PAD
        )
    if end is not None:
        query = query.where(
            Pomodoro.started_at
            <= datetime.min.combine(end, datetime.max.time()) + RANGE_PAD
        )

    rows = list(db.execute(query.order_by(Pomodoro.started_at)).scalars())
    # The padding above is generous on purpose; the local day is what was asked
    # for, so the edges are trimmed with each row's own offset.
    if start is not None:
        rows = [
            row for row in rows if local_day(row.started_at, row.utc_offset) >= start
        ]
    if end is not None:
        rows = [row for row in rows if local_day(row.started_at, row.utc_offset) <= end]
    return rows


@router.get(
    "/pomodoros",
    response_model=list[PomodoroOut],
    operation_id="listPomodoros",
    summary="Read pomodoros over a range of local days",
    description=(
        "Every pomodoro of the signed-in account that began within the range, "
        "earliest first, each carrying the state and elapsed time computed for "
        "the moment asked about."
    ),
)
def list_pomodoros(
    user: CurrentUser,
    db: DbSession,
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    as_of: datetime | None = Query(default=None),
) -> list[PomodoroOut]:
    """List the authenticated user's pomodoros over a range of local days.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    start : datetime.date or None
        First local day wanted.
    end : datetime.date or None
        Last local day wanted.
    as_of : datetime.datetime or None
        The client's own clock, so the screen and the derived state agree.

    Returns
    -------
    list of PomodoroOut
        The pomodoros, earliest first.
    """
    moment = as_of or _server_now()
    return [pomodoro_out(row, moment) for row in _in_range(db, user.id, start, end)]


@router.post(
    "/pomodoros/transfer",
    status_code=status.HTTP_201_CREATED,
    operation_id="transferPomodoros",
    summary="Copy a day's pomodoro time onto a project",
    description=(
        "Write one session holding the day's untransferred focus and break "
        "time, and mark those pomodoros as copied so the same hour cannot be "
        "written twice. A copy, not a link: correcting a pomodoro afterwards "
        "does not reach the session, and the session is corrected where every "
        "other session is."
    ),
)
def transfer_pomodoros(
    payload: TransferRequest,
    user: CurrentUser,
    db: DbSession,
    as_of: datetime | None = Query(default=None),
) -> dict:
    """Copy one local day of pomodoro time onto one of the user's projects.

    Parameters
    ----------
    payload : TransferRequest
        Which day, which project, and optionally where to place the session.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.
    as_of : datetime.datetime or None
        The client's own clock.

    Returns
    -------
    dict
        The identifier and bounds of the session written.

    Raises
    ------
    fastapi.HTTPException
        With status 404 when the project is not the caller's, and 422 when
        there is nothing left to copy or the session would cover minutes the
        project already covers.
    """
    moment = as_of or _server_now()
    project = own_project(db, user, payload.project_id)
    rows = _in_range(db, user.id, payload.day, payload.day)
    total = transferable(rows, moment)

    if total.seconds <= 0 or total.started_at is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="There is no pomodoro time left to copy on that day",
        )

    started_at = payload.started_at or total.started_at
    entry = TimeEntry(
        user_id=user.id,
        project_id=project.id,
        started_at=started_at,
        ended_at=started_at + timedelta(seconds=total.seconds),
        # The offset of the day being copied, so the session lands on the same
        # local day the pomodoros did.
        utc_offset=rows[0].utc_offset,
        note=None,
        # So the Time view can say where an hour came from. Not a reference to
        # the pomodoros: they are free to be edited or deleted afterwards, and
        # this has to outlive them.
        source="pomodoro",
    )

    others = list(
        db.execute(
            select(TimeEntry).where(
                TimeEntry.user_id == user.id, TimeEntry.project_id == project.id
            )
        ).scalars()
    )
    try:
        check_no_overlap(entry, others)
    except TimeRuleError as refusal:
        # Refused rather than merged, unlike the offline queue: this is a
        # deliberate press with somebody watching, and moving the block is a
        # choice they can make. Nothing is stamped, so the button still offers
        # the same time afterwards.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(refusal)
        ) from None

    db.add(entry)
    stamped = 0
    for row in rows:
        if pomodoro_state(row, moment) != "running":
            row.transferred_at = moment
            stamped += 1
    db.commit()
    db.refresh(entry)

    return {
        "entry_id": entry.id,
        "started_at": entry.started_at,
        "ended_at": entry.ended_at,
        "seconds": total.seconds,
        "pomodoros": stamped,
    }
