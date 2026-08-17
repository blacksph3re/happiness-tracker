from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from deps import CurrentUser, DbSession
from models import (
    Answer,
    Catalogue,
    DeductionBand,
    Project,
    Tag,
    TimeEntry,
    User,
)
from schemas import Changes, Fingerprint

router = APIRouter(tags=["Sync"])


def _fingerprint(db: Session, entity: type, where: ColumnElement[bool]) -> Fingerprint:
    """Count one collection and find when it last moved.

    The timestamp is nullable on every table, and reads NULL for a row written
    before it had the column. That is not a gap to work around: a collection
    whose newest stamp is NULL is compared on its count alone, which is how all
    of these behaved before the column existed.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active database session.
    entity : type
        The mapped class to count.
    where : sqlalchemy.sql.elements.ColumnElement
        Restriction narrowing the rows to the ones the caller owns.

    Returns
    -------
    Fingerprint
        The row count, and the newest ``updated_at`` among them or None.
    """
    row = db.execute(
        select(func.count(), func.max(entity.updated_at))
        .select_from(entity)
        .where(where)
    ).one()
    return Fingerprint(n=row[0], at=row[1])


@router.get(
    "/changes",
    response_model=Changes,
    operation_id="getChanges",
    summary="Fingerprint every collection",
    description=(
        "Report how much of each collection the signed-in account has and when "
        "it last moved, so a client can decide what to re-read without reading "
        "any of it. Counts and timestamps together: a timestamp cannot see a "
        "deletion and a count cannot see an edit."
    ),
)
def get_changes(user: CurrentUser, db: DbSession) -> Changes:
    """Report a fingerprint per collection for the authenticated user.

    Cheap by design — seven aggregates over indexed foreign keys — because the
    common answer is that nothing has moved, and that case has to cost less than
    the re-read it saves.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    Changes
        One fingerprint per collection, never counting another account's rows.
    """
    return Changes(
        answers=_fingerprint(db, Answer, Answer.user_id == user.id),
        time_entries=_fingerprint(db, TimeEntry, TimeEntry.user_id == user.id),
        projects=_fingerprint(db, Project, Project.user_id == user.id),
        tags=_fingerprint(db, Tag, Tag.user_id == user.id),
        # Bands hang off a tag rather than a user, so ownership is reached
        # through one. A band whose tag belongs to somebody else is not this
        # account's to hear about.
        rules=_fingerprint(
            db,
            DeductionBand,
            DeductionBand.tag_id.in_(select(Tag.id).where(Tag.user_id == user.id)),
        ),
        # Catalogues carry no owner: they are shared, and an editor changing one
        # changes it for everybody. So this fingerprint is global on purpose.
        catalogues=_fingerprint(db, Catalogue, Catalogue.id.is_not(None)),
        # Always exactly one row, so the count says nothing at all and the
        # timestamp carries the whole signal — which is what lets a default
        # catalogue changed on another device reach this one.
        me=_fingerprint(db, User, User.id == user.id),
    )
