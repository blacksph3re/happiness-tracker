from datetime import date, datetime

import pytest

from services.timetrack import (
    TimeRuleError,
    check_entry_shape,
    daily_slices,
    duration_seconds,
    group_by_tag,
    summarise,
)

HOUR = 3600


class FakeEntry:
    """A session without a database, so the arithmetic is tested on its own."""

    def __init__(self, started_at, ended_at=None, utc_offset=0, project_id=1):
        self.started_at = started_at
        self.ended_at = ended_at
        self.utc_offset = utc_offset
        self.project_id = project_id


def at(day, hour, minute=0):
    """Build a UTC instant on a day in June 2026."""
    return datetime(2026, 6, day, hour, minute)


def test_a_session_inside_one_day_is_one_slice():
    entry = FakeEntry(at(10, 9), at(10, 17))
    assert daily_slices(entry, at(10, 20)) == [(date(2026, 6, 10), 8 * HOUR)]
    assert duration_seconds(entry, at(10, 20)) == 8 * HOUR


def test_a_session_over_midnight_is_split():
    entry = FakeEntry(at(10, 22), at(11, 2))
    assert daily_slices(entry, at(11, 5)) == [
        (date(2026, 6, 10), 2 * HOUR),
        (date(2026, 6, 11), 2 * HOUR),
    ]


def test_the_slices_sum_to_the_duration():
    entry = FakeEntry(at(10, 21, 37), at(12, 4, 12))
    slices = daily_slices(entry, at(12, 9))
    assert sum(seconds for _, seconds in slices) == duration_seconds(entry, at(12, 9))


def test_a_session_over_three_days_fills_the_middle_one():
    entry = FakeEntry(at(10, 23), at(13, 1))
    assert daily_slices(entry, at(13, 2)) == [
        (date(2026, 6, 10), HOUR),
        (date(2026, 6, 11), 24 * HOUR),
        (date(2026, 6, 12), 24 * HOUR),
        (date(2026, 6, 13), HOUR),
    ]


def test_the_offset_decides_which_day_a_slice_falls_in():
    # 23:30 UTC is already the next day two hours east, so nothing lands on the
    # 10th at all.
    entry = FakeEntry(at(10, 23, 30), at(11, 1, 30), utc_offset=120)
    assert daily_slices(entry, at(11, 2)) == [(date(2026, 6, 11), 2 * HOUR)]


def test_a_western_offset_pulls_a_session_back_a_day():
    entry = FakeEntry(at(11, 2), at(11, 4), utc_offset=-300)
    assert daily_slices(entry, at(11, 5)) == [(date(2026, 6, 10), 2 * HOUR)]


def test_a_running_session_is_measured_to_as_of():
    entry = FakeEntry(at(10, 9))
    assert duration_seconds(entry, at(10, 11, 30)) == 2 * HOUR + 1800
    assert daily_slices(entry, at(10, 11)) == [(date(2026, 6, 10), 2 * HOUR)]


def test_a_running_session_never_reads_negative():
    # A client clock lagging behind its own check-in must read zero, not a
    # negative duration that would subtract from the day's total.
    entry = FakeEntry(at(10, 9))
    assert duration_seconds(entry, at(10, 8)) == 0
    assert daily_slices(entry, at(10, 8)) == []


def test_totals_add_parallel_sessions_up():
    entries = [
        FakeEntry(at(10, 9), at(10, 17), project_id=1),
        FakeEntry(at(10, 11), at(10, 12), project_id=2),
    ]
    # A meeting inside a work session: nine hours tracked on a 24-hour day, and
    # that is what a sum over projects means.
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 8 * HOUR, 2: HOUR}}


def test_totals_merge_repeat_sessions_on_one_project():
    entries = [
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
        FakeEntry(at(10, 13), at(10, 17), project_id=1),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 7 * HOUR}}


def test_a_tag_totals_the_projects_it_covers():
    totals = {date(2026, 6, 10): {1: 8 * HOUR, 2: HOUR}}
    assert group_by_tag(totals, {1: [7], 2: [7]}) == {date(2026, 6, 10): {7: 9 * HOUR}}


def test_a_project_with_two_tags_counts_in_both():
    totals = {date(2026, 6, 10): {1: HOUR}}
    assert group_by_tag(totals, {1: [7, 8]}) == {date(2026, 6, 10): {7: HOUR, 8: HOUR}}


def test_untagged_work_is_kept_under_none():
    totals = {date(2026, 6, 10): {1: HOUR, 2: 2 * HOUR}}
    assert group_by_tag(totals, {1: [7]}) == {
        date(2026, 6, 10): {7: HOUR, None: 2 * HOUR}
    }


def test_an_empty_tag_list_is_untagged():
    totals = {date(2026, 6, 10): {1: HOUR}}
    assert group_by_tag(totals, {1: []}) == {date(2026, 6, 10): {None: HOUR}}


def test_a_session_ending_before_it_starts_is_refused():
    with pytest.raises(TimeRuleError):
        check_entry_shape(at(10, 17), at(10, 9), 0)
    with pytest.raises(TimeRuleError):
        check_entry_shape(at(10, 9), at(10, 9), 0)


def test_a_running_session_needs_no_end():
    check_entry_shape(at(10, 9), None, 120)


def test_an_impossible_offset_is_refused():
    with pytest.raises(TimeRuleError):
        check_entry_shape(at(10, 9), None, 900)
    with pytest.raises(TimeRuleError):
        check_entry_shape(at(10, 9), None, -800)
