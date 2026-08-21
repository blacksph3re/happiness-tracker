from datetime import datetime, timedelta

from services.schedule import GRACE, announcement, is_due

START = datetime(2026, 8, 21, 9, 0)
FOCUS = 25 * 60
BREAK = 5 * 60


class FakePomodoro:
    """The five fields the scheduling rules read."""

    def __init__(self, **overrides):
        self.id = 1
        self.started_at = START
        self.ended_at = None
        self.focus_seconds = FOCUS
        self.break_seconds = BREAK
        self.notified_at = None
        self.task = None
        for key, value in overrides.items():
            setattr(self, key, value)


def at(minutes):
    return START + timedelta(minutes=minutes)


def test_it_is_due_the_moment_the_focus_ends():
    assert is_due(FakePomodoro(), now=at(25))


def test_it_is_not_due_before_then():
    assert not is_due(FakePomodoro(), now=at(24))


def test_it_stays_due_through_the_grace_period():
    assert is_due(FakePomodoro(), now=at(25) + GRACE)


def test_it_is_stale_after_the_grace_period():
    # The app's own on-wake notice covers this case and says the honest thing.
    # A push arriving ten minutes late announces a block already replaced.
    assert not is_due(FakePomodoro(), now=at(25) + GRACE + timedelta(seconds=1))


def test_every_pomodoro_that_predates_the_feature_is_stale():
    # What makes this safe to switch on: nothing already in the database gets
    # announced, because all of it is far outside the window.
    assert not is_due(FakePomodoro(), now=at(60 * 24 * 30))


def test_one_already_announced_is_not_announced_again():
    assert not is_due(FakePomodoro(notified_at=at(25)), now=at(25))


def test_an_abandoned_pomodoro_is_never_announced():
    # Abandoning is a decision, and whoever made it was looking at the screen.
    assert not is_due(FakePomodoro(ended_at=at(7)), now=at(25))


def test_one_stopped_during_its_break_still_gets_its_focus_announced():
    # Its focus did finish. The stop came later, when the next one started.
    assert is_due(FakePomodoro(ended_at=at(27)), now=at(25))


def test_the_announcement_names_the_task_when_there_is_one():
    payload = announcement(FakePomodoro(task="The rewrite"))
    assert payload["title"] == "The rewrite"
    assert "5 minute break" in payload["body"]


def test_an_unnamed_pomodoro_still_says_something():
    payload = announcement(FakePomodoro())
    assert payload["title"]
    assert payload["body"]


def test_a_pomodoro_with_no_break_says_so():
    payload = announcement(FakePomodoro(break_seconds=0))
    assert "break" not in payload["body"]


def test_the_payload_carries_only_what_the_worker_reads():
    # Append-only, and the worker receiving it may be an older release than the
    # server sending it. Anything new must be additive.
    assert set(announcement(FakePomodoro())) == {"title", "body", "path", "tag"}
