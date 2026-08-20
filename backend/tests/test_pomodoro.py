from dataclasses import dataclass
from datetime import date, datetime, timedelta

import pytest

from services import (
    ABANDONED,
    COMPLETE,
    RUNNING,
    PomodoroRuleError,
    check_pomodoro_shape,
    effective_end,
    local_day,
    pomodoro_state,
    split_seconds,
    transferable,
)

START = datetime(2026, 8, 20, 9, 0)
FOCUS = 25 * 60
BREAK = 5 * 60


@dataclass
class FakePomodoro:
    started_at: datetime = START
    ended_at: datetime | None = None
    focus_seconds: int = FOCUS
    break_seconds: int = BREAK
    utc_offset: int = 0
    tainted: bool = False
    transferred_at: datetime | None = None


def at(minutes):
    return START + timedelta(minutes=minutes)


def test_planned_end_is_the_end_when_nothing_stopped_it():
    assert effective_end(FakePomodoro()) == at(30)


def test_an_explicit_stop_wins_over_the_planned_end():
    assert effective_end(FakePomodoro(ended_at=at(7))) == at(7)


def test_an_end_edited_past_the_planned_end_cannot_invent_break_time():
    # Capped rather than trusted: without this, moving the end later would add
    # break minutes that never happened.
    assert effective_end(FakePomodoro(ended_at=at(90))) == at(30)


def test_it_is_running_until_its_planned_end_passes():
    assert pomodoro_state(FakePomodoro(), as_of=at(10)) == RUNNING


def test_it_completes_at_its_planned_end_with_nothing_written():
    # The whole point: no timer, no background task, no write. A pomodoro
    # nobody was watching is complete the moment anyone reads it afterwards.
    assert pomodoro_state(FakePomodoro(), as_of=at(31)) == COMPLETE


def test_stopping_during_the_focus_is_abandoning():
    assert pomodoro_state(FakePomodoro(ended_at=at(7)), as_of=at(50)) == ABANDONED


def test_stopping_during_the_break_still_completes():
    assert pomodoro_state(FakePomodoro(ended_at=at(27)), as_of=at(50)) == COMPLETE


def test_stopping_exactly_on_the_focus_boundary_completes():
    assert pomodoro_state(FakePomodoro(ended_at=at(25)), as_of=at(50)) == COMPLETE


def test_a_full_pomodoro_splits_into_its_two_halves():
    assert split_seconds(FakePomodoro()) == (FOCUS, BREAK)


def test_an_abandoned_pomodoro_contributes_no_break_time():
    assert split_seconds(FakePomodoro(ended_at=at(7))) == (7 * 60, 0)


def test_a_break_cut_short_counts_only_the_part_that_was_used():
    assert split_seconds(FakePomodoro(ended_at=at(27))) == (FOCUS, 2 * 60)


def test_a_pomodoro_takes_its_day_from_its_own_offset():
    # 23:30 UTC is already the next day two hours east.
    late = datetime(2026, 8, 20, 23, 30)
    assert local_day(late, 0) == date(2026, 8, 20)
    assert local_day(late, 120) == date(2026, 8, 21)


def test_an_end_before_the_start_is_not_an_interval():
    with pytest.raises(PomodoroRuleError):
        check_pomodoro_shape(START, at(-5), FOCUS, BREAK, 0)


def test_a_pomodoro_with_no_focus_time_is_refused():
    with pytest.raises(PomodoroRuleError):
        check_pomodoro_shape(START, None, 0, BREAK, 0)


def test_an_impossible_offset_is_refused():
    with pytest.raises(PomodoroRuleError):
        check_pomodoro_shape(START, None, FOCUS, BREAK, 60 * 24)


def test_a_zero_length_break_is_allowed():
    check_pomodoro_shape(START, None, FOCUS, 0, 0)


def test_transferable_totals_focus_and_break_separately():
    day = [FakePomodoro(), FakePomodoro(started_at=at(30), ended_at=at(37))]
    total = transferable(day, as_of=at(200))
    assert total.focus_seconds == FOCUS + 7 * 60
    assert total.break_seconds == BREAK
    assert total.seconds == FOCUS + BREAK + 7 * 60


def test_transferable_still_offers_what_has_already_been_copied():
    # Deliberately not filtered. Excluding copied pomodoros made the day's total
    # and the transfer button disagree on one screen; copying twice is now the
    # owner's business, and the second session collides on the project instead.
    day = [
        FakePomodoro(transferred_at=datetime(2026, 8, 20, 12, 0)),
        FakePomodoro(started_at=at(30)),
    ]
    total = transferable(day, as_of=at(200))
    assert total.seconds == 2 * (FOCUS + BREAK)
    assert total.started_at == START


def test_transferable_ignores_a_pomodoro_still_running():
    # Its time is not final yet, and copying it would freeze a guess.
    day = [FakePomodoro(), FakePomodoro(started_at=at(30))]
    total = transferable(day, as_of=at(35))
    assert total.seconds == FOCUS + BREAK
    assert total.started_at == START


def test_transferable_is_empty_when_the_day_holds_nothing():
    total = transferable([], as_of=at(200))
    assert total.seconds == 0
    assert total.started_at is None


def test_tainted_time_is_counted_but_reported_apart():
    day = [FakePomodoro(tainted=True), FakePomodoro(started_at=at(30))]
    total = transferable(day, as_of=at(200))
    assert total.seconds == 2 * (FOCUS + BREAK)
    assert total.tainted_seconds == FOCUS + BREAK
