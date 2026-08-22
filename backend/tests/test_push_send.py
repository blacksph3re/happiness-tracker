import base64
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from config import Settings
from services.push import send_to


class FakeSubscription:
    """The four fields `send_to` reads, without the ORM."""

    def __init__(self, id, endpoint, p256dh, auth):
        self.id = id
        self.endpoint = endpoint
        self.p256dh = p256dh
        self.auth = auth


class QuietServer(HTTPServer):
    """An HTTPServer that does not look up its own name.

    `HTTPServer.server_bind` calls `socket.getfqdn()`, which on a machine whose
    DNS does not answer for it blocks until the resolver gives up — thirty-five
    seconds of it, in fixture setup, for a server that only ever talks to
    127.0.0.1 and never uses the name for anything.
    """

    def server_bind(self):
        import socketserver

        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class Recorder(BaseHTTPRequestHandler):
    """A push service that records what it was sent and answers to order."""

    received = []
    reply = 201

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        Recorder.received.append(
            {
                "path": self.path,
                # Lowercased: HTTP headers are case-insensitive and the client
                # sends them lower, so a dict keyed as sent would read as absent.
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": self.rfile.read(length),
            }
        )
        status = Recorder.reply
        self.send_response(status)
        self.end_headers()

    def log_message(self, *args):
        """Silence the default stderr logging."""


@pytest.fixture
def push_service():
    """Run a local stand-in for Apple's or Google's push service.

    A subscription's endpoint is only a URL, which is the whole reason the
    server half of web push is testable with nothing external: the VAPID
    signing and the payload encryption happen here exactly as they would
    against the real thing.
    """
    Recorder.received = []
    Recorder.reply = 201
    server = QuietServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()


def _make_key():
    """Return a real P-256 private key, raw base64url, as `.env` holds it."""
    private = ec.generate_private_key(ec.SECP256R1())
    secret = private.private_numbers().private_value.to_bytes(32, "big")
    return base64.urlsafe_b64encode(secret).rstrip(b"=").decode()


_KEY = _make_key()
"""One key for the module. Generating a P-256 pair per test is the slowest
thing in this file and none of them cares which key it is."""


@pytest.fixture
def keys():
    """Return a real P-256 key, because pywebpush actually signs with it.

    Raw base64url rather than PEM, matching `scripts/generate_vapid.py`: it is
    one line, which is what `.env` wants, and it is what `py_vapid` reads
    without a file on disk.
    """
    private = ec.generate_private_key(ec.SECP256R1())
    secret = private.private_numbers().private_value.to_bytes(32, "big")
    return base64.urlsafe_b64encode(secret).rstrip(b"=").decode()


@pytest.fixture
def settings(keys):
    return Settings(
        jwt_secret="x",
        vapid_private_key=keys,
        vapid_public_key="ignored-by-the-sender",
        vapid_subject="mailto:someone@example.com",
    )


def browser(server, id=1, path="/send/abc"):
    """Build a subscription pointing at the local service, with a real key."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return FakeSubscription(
        id=id,
        endpoint=f"http://127.0.0.1:{server.server_port}{path}",
        p256dh=base64.urlsafe_b64encode(public).rstrip(b"=").decode(),
        auth=base64.urlsafe_b64encode(b"0123456789abcdef").rstrip(b"=").decode(),
    )


def test_a_notification_reaches_the_push_service(push_service, settings):
    result = send_to(
        [browser(push_service)], {"title": "Hi", "body": "There"}, settings
    )

    assert result.sent == 1
    assert result.gone == ()
    assert len(Recorder.received) == 1


def test_it_is_signed_and_encrypted(push_service, settings):
    send_to([browser(push_service)], {"title": "Hi"}, settings)

    [call] = Recorder.received
    # VAPID: the service is told who is asking, signed with the private key.
    assert call["headers"]["authorization"].startswith("vapid ")
    assert call["headers"]["content-encoding"] == "aes128gcm"
    # And the payload is not readable in transit.
    assert b"Hi" not in call["body"]
    assert len(call["body"]) > 0


def test_a_dead_endpoint_is_reported_for_pruning(push_service, settings):
    Recorder.reply = 410

    result = send_to([browser(push_service, id=7)], {"title": "Hi"}, settings)

    assert result.sent == 0
    assert result.gone == (7,)


def test_a_404_counts_as_gone_too(push_service, settings):
    Recorder.reply = 404

    result = send_to([browser(push_service, id=9)], {"title": "Hi"}, settings)

    assert result.gone == (9,)


def test_a_temporary_failure_is_not_pruned(push_service, settings):
    # A push service having a bad day is not a device that has gone away.
    Recorder.reply = 500

    result = send_to([browser(push_service, id=3)], {"title": "Hi"}, settings)

    assert result.gone == ()
    assert result.failed == 1


def test_one_dead_device_does_not_stop_the_others(push_service, settings):
    # Two endpoints, one unroutable: the reachable one must still be told.
    dead = FakeSubscription(
        id=1, endpoint="http://127.0.0.1:1/send/nobody", p256dh="x", auth="y"
    )
    result = send_to([dead, browser(push_service, id=2)], {"title": "Hi"}, settings)

    assert result.sent == 1
    assert result.failed == 1


def test_nothing_is_sent_when_push_is_not_configured(push_service):
    plain = Settings(jwt_secret="x")

    result = send_to([browser(push_service)], {"title": "Hi"}, plain)

    assert result == type(result)(sent=0, gone=(), failed=0)
    assert Recorder.received == []


# --- the announcer, end to end ---------------------------------------------


def test_a_finished_focus_is_announced_to_the_browser(
    push_client, push_headers, push_service, monkeypatch
):
    """One pomodoro, one enrolled browser, one pass of the announcer."""
    from datetime import datetime, timedelta

    import services.announcer as announcer
    from config import Settings, get_settings

    subscription = browser(push_service)
    registered = push_client.post(
        "/api/push/subscriptions",
        headers=push_headers,
        json={
            "endpoint": subscription.endpoint,
            "p256dh": subscription.p256dh,
            "auth": subscription.auth,
        },
    )
    assert registered.status_code == 201, registered.text

    started = datetime(2026, 8, 21, 9, 0)
    queued = push_client.post(
        "/api/sync",
        headers=push_headers,
        json={
            "intents": [
                {
                    "seq": 1,
                    "kind": "pomodoro.upsert",
                    "client_id": "p1",
                    "client_updated_at": "2026-08-21T08:00:00",
                    "payload": {
                        "task": "The rewrite",
                        "started_at": started.isoformat(),
                        "utc_offset": 0,
                        "focus_seconds": 1500,
                        "break_seconds": 300,
                    },
                }
            ]
        },
    )
    assert queued.json()["results"][0]["outcome"] == "applied"

    # The keys the fixture configured are not real, so the sender needs ones
    # that sign. Everything else — the row, the subscription, the claim — is
    # the application's own.
    real = Settings(
        jwt_secret="x",
        db_storage=get_settings().db_storage,
        vapid_private_key=_KEY,
        vapid_public_key="ignored-by-the-sender",
        vapid_subject="mailto:someone@example.com",
    )
    monkeypatch.setattr(announcer, "get_settings", lambda: real)

    ends = started + timedelta(seconds=1500)
    assert announcer.announce_once(now=ends) == 1
    assert len(Recorder.received) == 1

    # And not twice. The claim is what makes a restart mid-send lose at most
    # one notification rather than repeat one.
    assert announcer.announce_once(now=ends) == 0
    assert len(Recorder.received) == 1


def test_only_one_caller_may_announce_a_pomodoro(push_client, push_headers):
    """Two workers reaching one row: exactly one of them gets to send.

    The end-to-end test above cannot show this, because the query that finds
    due pomodoros already excludes announced ones — so a second pass never sees
    the row at all and would pass whether or not the claim were conditional.
    This calls the claim directly, which is the only way to put two callers on
    one row.
    """
    from datetime import datetime

    import services.announcer as announcer
    from database import SessionLocal
    from models import Pomodoro

    started = datetime(2026, 8, 21, 9, 0)
    push_client.post(
        "/api/sync",
        headers=push_headers,
        json={
            "intents": [
                {
                    "seq": 1,
                    "kind": "pomodoro.upsert",
                    "client_id": "p1",
                    "client_updated_at": "2026-08-21T08:00:00",
                    "payload": {
                        "started_at": started.isoformat(),
                        "utc_offset": 0,
                        "focus_seconds": 1500,
                        "break_seconds": 300,
                    },
                }
            ]
        },
    )

    with SessionLocal() as first, SessionLocal() as second:
        row = first.execute(select(Pomodoro)).scalar_one()
        mine = announcer._claim(first, row, started)
        theirs = announcer._claim(second, row, started)

    assert mine is True
    assert theirs is False


def test_a_dead_browser_is_pruned_by_the_announcer(
    push_client, push_headers, push_service, monkeypatch
):
    from datetime import datetime, timedelta

    import services.announcer as announcer
    from config import Settings, get_settings

    subscription = browser(push_service)
    push_client.post(
        "/api/push/subscriptions",
        headers=push_headers,
        json={
            "endpoint": subscription.endpoint,
            "p256dh": subscription.p256dh,
            "auth": subscription.auth,
        },
    )
    started = datetime(2026, 8, 21, 9, 0)
    push_client.post(
        "/api/sync",
        headers=push_headers,
        json={
            "intents": [
                {
                    "seq": 1,
                    "kind": "pomodoro.upsert",
                    "client_id": "p1",
                    "client_updated_at": "2026-08-21T08:00:00",
                    "payload": {
                        "started_at": started.isoformat(),
                        "utc_offset": 0,
                        "focus_seconds": 1500,
                        "break_seconds": 300,
                    },
                }
            ]
        },
    )

    Recorder.reply = 410
    real = Settings(
        jwt_secret="x",
        db_storage=get_settings().db_storage,
        vapid_private_key=_KEY,
        vapid_public_key="ignored",
        vapid_subject="mailto:someone@example.com",
    )
    monkeypatch.setattr(announcer, "get_settings", lambda: real)

    announcer.announce_once(now=started + timedelta(seconds=1500))

    # The push service says that browser is finished, so the row goes: nothing
    # else prunes one reliably.
    assert push_client.get("/api/push/subscriptions", headers=push_headers).json() == []


def test_a_pomodoro_is_not_burnt_when_there_is_nowhere_to_send_it(
    push_client, push_headers, push_service, monkeypatch
):
    """Enrol inside the grace period and still get the announcement.

    The claim used to be taken before the subscriptions were looked up, so an
    account with no enrolled device had its pomodoro stamped as announced and
    nothing sent — and enrolling a moment later, still well inside the grace
    period, could never recover it.
    """
    from datetime import datetime, timedelta

    import services.announcer as announcer
    from config import Settings, get_settings

    started = datetime(2026, 8, 21, 9, 0)
    push_client.post(
        "/api/sync",
        headers=push_headers,
        json={
            "intents": [
                {
                    "seq": 1,
                    "kind": "pomodoro.upsert",
                    "client_id": "p1",
                    "client_updated_at": "2026-08-21T08:00:00",
                    "payload": {
                        "started_at": started.isoformat(),
                        "utc_offset": 0,
                        "focus_seconds": 1500,
                        "break_seconds": 300,
                    },
                }
            ]
        },
    )

    real = Settings(
        jwt_secret="x",
        db_storage=get_settings().db_storage,
        vapid_private_key=_KEY,
        vapid_public_key="ignored",
        vapid_subject="mailto:someone@example.com",
    )
    monkeypatch.setattr(announcer, "get_settings", lambda: real)

    ends = started + timedelta(seconds=1500)
    assert announcer.announce_once(now=ends) == 0

    # Now a device appears, and the moment has not passed.
    subscription = browser(push_service)
    push_client.post(
        "/api/push/subscriptions",
        headers=push_headers,
        json={
            "endpoint": subscription.endpoint,
            "p256dh": subscription.p256dh,
            "auth": subscription.auth,
        },
    )

    assert announcer.announce_once(now=ends + timedelta(seconds=30)) == 1
