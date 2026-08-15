"""Replaying a device's offline queue.

One endpoint for both halves, because a device queues answers and sessions
together and replaying them in the order they were made is the point. The
answers are per intent rather than per request: a session the server cannot
accept must not wedge the fortnight of answers queued behind it.
"""

from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import ValidationError

from deps import CurrentUser, DbSession
from schemas import (
    AnswerIn,
    SyncEntryPayload,
    SyncRequest,
    SyncResponse,
    SyncResult,
    TimeEntryOut,
)
from services.sync import (
    SyncOutcome,
    apply_answer,
    apply_entry,
    delete_entry,
)

router = APIRouter(tags=["sync"])

MAX_CLOCK_SKEW = 86_400
"""Seconds into the future a device's clock may claim before it is refused.

A wrong clock writes wrong ordering and nothing here can detect that in general.
What it can detect is a claim far enough ahead that it would win every
comparison for years, which is the version of the problem that does lasting
damage.
"""


def _malformed(seq: int, invalid: ValidationError) -> SyncResult:
    """Report an intent the server cannot even read as a conflict, not a 422.

    A queue holding one unreadable intent — an old app version, a payload
    mangled in storage — must still deliver the fortnight of answers behind it,
    so this is the same per-intent verdict as any other refusal.

    Parameters
    ----------
    seq : int
        The intent's sequence number.
    invalid : pydantic.ValidationError
        What was wrong with it.

    Returns
    -------
    SyncResult
        A conflict naming the first problem found.
    """
    first = invalid.errors()[0]
    where = ".".join(str(part) for part in first["loc"])
    return SyncResult(
        seq=seq,
        outcome=SyncOutcome.CONFLICT,
        detail=(
            "This device sent something the server could not read: "
            f"{where} {first['msg']}"
        ),
    )


def _server_now() -> datetime:
    """Return the current UTC time without a zone, as the columns store it."""
    return datetime.now(UTC).replace(tzinfo=None)


@router.post(
    "/sync",
    response_model=SyncResponse,
    operation_id="syncIntents",
    summary="Replay writes made offline",
    description=(
        "Send the device's queue oldest-first. Every intent gets its own "
        "outcome, so one the server cannot accept does not block the rest. "
        "Replaying the same queue twice is safe: an intent that is not newer "
        "than what is stored is reported as superseded rather than applied."
    ),
)
def sync_intents(
    payload: SyncRequest, user: CurrentUser, db: DbSession
) -> SyncResponse:
    """Apply a device's queued writes, newest change winning each collision.

    Parameters
    ----------
    payload : SyncRequest
        The intents, in the order the device made them.
    user : User
        The authenticated user. Intents are always applied as this account,
        never as whoever the device thought it was.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    SyncResponse
        One result per intent, and the server's own clock. Nothing here raises:
        every refusal is one intent's verdict, because a queue holding one bad
        item must still deliver the fortnight of answers behind it. A device
        whose clock is wrong would otherwise never sync anything again.
    """
    now = _server_now()
    results: list[SyncResult] = []

    for intent in payload.intents:
        claimed = intent.client_updated_at
        if claimed.tzinfo is not None:
            claimed = claimed.astimezone(UTC).replace(tzinfo=None)
        if (claimed - now).total_seconds() > MAX_CLOCK_SKEW:
            results.append(
                SyncResult(
                    seq=intent.seq,
                    outcome=SyncOutcome.CONFLICT,
                    detail=(
                        "This change claims to have been made more than a day in "
                        "the future. Check the clock on this device."
                    ),
                )
            )
            continue

        if intent.kind == "answer.put":
            try:
                answer = AnswerIn.model_validate(intent.payload)
            except ValidationError as invalid:
                results.append(_malformed(intent.seq, invalid))
                continue
            outcome, detail = apply_answer(db, user.id, claimed, answer, now)
            results.append(SyncResult(seq=intent.seq, outcome=outcome, detail=detail))
            continue

        if not intent.client_id:
            results.append(
                SyncResult(
                    seq=intent.seq,
                    outcome=SyncOutcome.CONFLICT,
                    detail="This session arrived without the id its device gave it",
                )
            )
            continue

        if intent.kind == "entry.delete":
            outcome, detail = delete_entry(db, user.id, intent.client_id, claimed)
            results.append(SyncResult(seq=intent.seq, outcome=outcome, detail=detail))
            continue

        try:
            session = SyncEntryPayload.model_validate(intent.payload)
        except ValidationError as invalid:
            results.append(_malformed(intent.seq, invalid))
            continue

        outcome, detail, entry = apply_entry(
            db, user.id, intent.client_id, claimed, session, now
        )
        results.append(
            SyncResult(
                seq=intent.seq,
                outcome=outcome,
                detail=detail,
                entry=TimeEntryOut.model_validate(entry)
                if entry is not None and outcome != SyncOutcome.CONFLICT
                else None,
            )
        )

    db.commit()
    return SyncResponse(results=results, server_time=now)
