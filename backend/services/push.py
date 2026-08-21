"""Sending a notification to a browser, and forgetting the ones that are gone.

Phase two of `PUSH_NOTIFICATIONS_PROPOSAL.md`. Nothing here decides *when* to
send — that is the caller's business — and nothing here talks to the database
beyond being handed rows to delete.

The whole of it is testable without a push service existing anywhere: a
subscription's endpoint is only a URL, so pointing one at a local mock exercises
the VAPID signing, the payload encryption and the pruning exactly as Apple or
Google would.
"""

import json
import logging
from dataclasses import dataclass

from pywebpush import WebPushException, webpush

logger = logging.getLogger(__name__)

GONE = frozenset({404, 410})
"""Statuses that mean the endpoint will never work again.

`410 Gone` is what the specification says. `404` is included because push
services return it for an endpoint that was never theirs, and either way there
is nothing to retry.

Not the whole story on Apple's service, which has been observed answering `201`
for a subscription it had already replaced — so this prunes what it can see and
the client re-registering on launch does the rest. See `PushSubscription.updated_at`.
"""

TTL = 600
"""Seconds a push service should hold a message for a device that is offline.

Ten minutes, which is longer than the one-minute grace the sender allows and
short enough that a phone switched on tomorrow is not told about yesterday's
focus block. A notification about a moment that has passed is worse than none.
"""


@dataclass(frozen=True)
class Delivery:
    """What became of one attempt to notify one browser."""

    sent: int
    """How many endpoints accepted the message."""

    gone: tuple[int, ...]
    """Row ids of subscriptions the push service says no longer exist."""

    failed: int
    """Attempts that failed for some other reason, and may work next time."""


def send_to(subscriptions: list, payload: dict, settings) -> Delivery:
    """Send one notification to every one of a person's browsers.

    Each endpoint is attempted independently: one dead phone must not stop the
    laptop beside it being told.

    Parameters
    ----------
    subscriptions : list of models.PushSubscription
        The browsers to notify.
    payload : dict
        What the service worker will read. **Append-only** — see the handler in
        `app/src/sw.js`: the worker receiving this may be an older release than
        the server sending it, because the app prompts before taking an update
        rather than swapping itself.
    settings : config.Settings
        Where the VAPID keys and subject come from.

    Returns
    -------
    Delivery
        Counts, and the ids of subscriptions that should be deleted.
    """
    if not settings.push_configured or not subscriptions:
        return Delivery(sent=0, gone=(), failed=0)

    body = json.dumps(payload)
    sent = 0
    gone: list[int] = []
    failed = 0

    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                },
                data=body,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
                ttl=TTL,
            )
            sent += 1
        except WebPushException as refusal:
            status = getattr(refusal.response, "status_code", None)
            if status in GONE:
                gone.append(subscription.id)
            else:
                failed += 1
                # The endpoint is never logged: it is a capability URL, and a
                # log file is a poor place for one.
                logger.warning(
                    "push to subscription %s failed: %s", subscription.id, status
                )
        except Exception:  # noqa: BLE001 - a broken endpoint must not stop the rest
            failed += 1
            logger.exception("push to subscription %s raised", subscription.id)

    return Delivery(sent=sent, gone=tuple(gone), failed=failed)
