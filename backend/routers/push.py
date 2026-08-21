"""Registering and forgetting the browsers that may be sent a notification.

Phase one of `PUSH_NOTIFICATIONS_PROPOSAL.md`: the subscription lifecycle, and
nothing that sends. Deliberately shippable on its own — a device can be enrolled
and un-enrolled, and that half is verifiable without a push service existing
anywhere.

Web push is the one optional secret in this application. Absent VAPID keys, this
router answers honestly rather than failing: see `Settings.vapid_private_key`.
"""

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from config import get_settings
from deps import CurrentUser, DbSession
from models import PushSubscription
from schemas import PushEndpoint, PushKey, PushSubscriptionIn, PushSubscriptionOut

router = APIRouter(prefix="/push", tags=["Push"])

UNCONFIGURED = "This server is not set up to send notifications"
"""Explanation returned when a deployment has no VAPID keys."""


@router.get(
    "/key",
    response_model=PushKey,
    operation_id="getPushKey",
    summary="Whether push works here, and the key to subscribe with",
    description=(
        "A browser needs the server's VAPID public key before it can subscribe. "
        "A deployment without one reports `configured: false` rather than an "
        "error, because push being off is a configuration and not a fault."
    ),
)
def get_push_key(user: CurrentUser) -> PushKey:
    """Report whether push is configured, and the public key when it is.

    Parameters
    ----------
    user : User
        The authenticated user. Required only so the key is not a public fact
        about the deployment; it grants nothing on its own.

    Returns
    -------
    PushKey
        The public key, or nulls when the deployment has no VAPID keys.
    """
    settings = get_settings()
    if not settings.push_configured:
        return PushKey(configured=False, public_key=None)
    return PushKey(configured=True, public_key=settings.vapid_public_key)


@router.get(
    "/subscriptions",
    response_model=list[PushSubscriptionOut],
    operation_id="listPushSubscriptions",
    summary="The devices this account has enrolled",
)
def list_subscriptions(user: CurrentUser, db: DbSession) -> list[PushSubscription]:
    """List the authenticated user's registered browsers.

    Parameters
    ----------
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    list of PushSubscription
        Never another account's, and never carrying an endpoint.
    """
    return list(
        db.execute(
            select(PushSubscription)
            .where(PushSubscription.user_id == user.id)
            .order_by(PushSubscription.created_at)
        ).scalars()
    )


@router.post(
    "/subscriptions",
    response_model=PushSubscriptionOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="registerPushSubscription",
    summary="Register this browser for notifications",
    description=(
        "Safe to call on every launch, which is what the client does: an "
        "endpoint already stored is updated rather than duplicated. That "
        "re-registration is also what prunes devices that stop coming back, "
        "since a push service cannot be relied on to report one as gone."
    ),
)
def register(
    payload: PushSubscriptionIn, user: CurrentUser, db: DbSession
) -> PushSubscription:
    """Store or refresh one browser's subscription.

    Parameters
    ----------
    payload : PushSubscriptionIn
        The subscription as the browser reports it.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    PushSubscription
        The stored row.

    Raises
    ------
    fastapi.HTTPException
        With status 503 when the deployment has no VAPID keys. Storing an
        address nothing can ever send to would be worse than refusing it.
    """
    if not get_settings().push_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=UNCONFIGURED
        )

    # Matched on the endpoint alone, not on (user, endpoint): the endpoint
    # belongs to a *browser*, so signing in as somebody else on the same device
    # has to move the subscription rather than add a second one. Two rows would
    # mean one person's notifications arriving on another person's screen.
    stored = db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    ).scalar_one_or_none()

    subscription = stored or PushSubscription(endpoint=payload.endpoint)
    subscription.user_id = user.id
    subscription.p256dh = payload.p256dh
    subscription.auth = payload.auth
    subscription.label = payload.label
    if stored is None:
        db.add(subscription)
    db.commit()
    db.refresh(subscription)
    return subscription


@router.delete(
    "/subscriptions",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="forgetPushSubscription",
    summary="Stop sending notifications to this browser",
    description=(
        "Idempotent. A browser whose permission was revoked reports it on its "
        "next launch, which may be long after the row was already pruned."
    ),
)
def forget(payload: PushEndpoint, user: CurrentUser, db: DbSession) -> Response:
    """Remove one of the authenticated user's subscriptions.

    Parameters
    ----------
    payload : PushEndpoint
        The endpoint to forget.
    user : User
        The authenticated user.
    db : sqlalchemy.orm.Session
        Active database session.

    Returns
    -------
    fastapi.Response
        Empty, with status 204, whether or not there was anything to remove.
    """
    stored = db.execute(
        select(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint,
            PushSubscription.user_id == user.id,
        )
    ).scalar_one_or_none()
    if stored is not None:
        db.delete(stored)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
