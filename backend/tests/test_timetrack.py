from datetime import date, datetime

import pytest

from services.timetrack import (
    TimeRuleError,
    added_for,
    check_entry_shape,
    check_no_overlap,
    daily_slices,
    day_offsets,
    deduction_for,
    duration_seconds,
    group_by_tag,
    reported,
    starting_day,
    summarise,
)

HOUR = 3600


class FakeEntry:
    """A session without a database, so the arithmetic is tested on its own."""

    def __init__(self, started_at, ended_at=None, utc_offset=0, project_id=1):
        self.id = None
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


class FakeBand:
    """A deduction band without a database."""

    def __init__(self, from_minutes, deduct_minutes=None):
        self.from_minutes = from_minutes
        self.deduct_minutes = deduct_minutes


LUNCH = [FakeBand(0, 30), FakeBand(360, 45)]


def test_no_bands_means_no_deduction():
    assert deduction_for(5 * HOUR, []) == 0
    assert reported(5 * HOUR, []) == 5 * HOUR


def test_a_short_day_takes_the_lower_band():
    assert reported(4 * HOUR, LUNCH) == 4 * HOUR - 1800


def test_a_long_day_takes_the_higher_band():
    assert reported(9 * HOUR, LUNCH) == 9 * HOUR - 2700


def test_a_day_exactly_on_a_threshold_takes_the_higher_band():
    # The threshold is reached, not merely passed.
    assert deduction_for(6 * HOUR, LUNCH) == 2700


def test_a_deduction_never_takes_a_day_below_zero():
    assert reported(600, LUNCH) == 0
    assert deduction_for(600, LUNCH) == 600


def test_a_day_with_nothing_tracked_owes_nothing():
    assert deduction_for(0, LUNCH) == 0
    assert reported(0, LUNCH) == 0


def test_bands_starting_above_zero_leave_short_days_alone():
    bands = [FakeBand(240, 30)]
    assert reported(2 * HOUR, bands) == 2 * HOUR
    assert reported(5 * HOUR, bands) == 5 * HOUR - 1800


def test_a_capping_band_holds_a_day_at_its_threshold():
    cap = [FakeBand(10 * HOUR // 60, None)]
    assert reported(9 * HOUR, cap) == 9 * HOUR
    assert reported(10 * HOUR, cap) == 10 * HOUR
    assert reported(14 * HOUR, cap) == 10 * HOUR
    assert deduction_for(14 * HOUR, cap) == 4 * HOUR


def test_a_capping_band_sits_above_deducting_ones():
    bands = [FakeBand(0, 30), FakeBand(600, None)]
    assert reported(4 * HOUR, bands) == 4 * HOUR - 1800
    assert reported(12 * HOUR, bands) == 10 * HOUR


def test_a_cap_at_zero_reports_nothing():
    assert reported(4 * HOUR, [FakeBand(0, None)]) == 0


def test_an_addition_lifts_every_tracked_day():
    assert reported(3 * HOUR, [], add_minutes=60) == 4 * HOUR
    assert added_for(3 * HOUR, add_minutes=60) == HOUR


def test_the_addition_is_counted_before_the_bands_are_tested():
    # The case the whole feature turns on. Three hours does not reach a
    # three-and-a-half hour threshold; three hours plus an added one does, so the
    # band applies and the day reports 3:40. Getting the order wrong reports 3:00
    # — a plausible number, and the wrong one.
    band = [FakeBand(210, 20)]

    assert reported(3 * HOUR, band, add_minutes=60) == 3 * HOUR + 40 * 60


def test_the_same_day_without_the_addition_never_reaches_that_band():
    # The other half of the test above: without this, "the band applied" and
    # "the band was never reached" both pass.
    band = [FakeBand(210, 20)]

    assert reported(3 * HOUR, band) == 3 * HOUR
    assert deduction_for(3 * HOUR, band) == 0


def test_a_day_that_tracked_nothing_earns_no_addition():
    # The mirror of "a day off owes no lunch break". Without this every untracked
    # day in a range sprouts an hour and the averages measure the rule.
    assert added_for(0, add_minutes=60) == 0
    assert reported(0, [], add_minutes=60) == 0
    assert reported(0, LUNCH, add_minutes=60) == 0


def test_one_tracked_minute_earns_the_whole_addition():
    assert reported(60, [], add_minutes=60) == 60 + HOUR


def test_a_cap_swallows_the_addition():
    cap = [FakeBand(600, None)]

    assert reported(9 * HOUR + 1800, cap, add_minutes=60) == 10 * HOUR


def test_a_deduction_cannot_take_an_increased_day_below_zero():
    assert reported(60, [FakeBand(0, 24 * 60)], add_minutes=60) == 0


def test_no_addition_reports_exactly_what_it_did_before():
    for tracked in (0, 600, 4 * HOUR, 9 * HOUR):
        assert reported(tracked, LUNCH, add_minutes=None) == reported(tracked, LUNCH)
        assert reported(tracked, LUNCH, add_minutes=0) == reported(tracked, LUNCH)


def test_overlapping_sessions_on_one_project_are_refused():
    existing = FakeEntry(at(10, 9), at(10, 12), project_id=1)
    existing.id = 1
    clash = FakeEntry(at(10, 11), at(10, 13), project_id=1)
    clash.id = None
    with pytest.raises(TimeRuleError):
        check_no_overlap(clash, [existing])


def test_touching_sessions_do_not_overlap():
    existing = FakeEntry(at(10, 9), at(10, 12), project_id=1)
    existing.id = 1
    following = FakeEntry(at(10, 12), at(10, 13), project_id=1)
    following.id = None
    check_no_overlap(following, [existing])


def test_another_project_may_run_over_the_same_minutes():
    existing = FakeEntry(at(10, 9), at(10, 12), project_id=1)
    existing.id = 1
    parallel = FakeEntry(at(10, 10), at(10, 11), project_id=2)
    parallel.id = None
    check_no_overlap(parallel, [existing])


def test_a_running_session_blocks_everything_after_it():
    running = FakeEntry(at(10, 9), None, project_id=1)
    running.id = 1
    later = FakeEntry(at(10, 20), at(10, 21), project_id=1)
    later.id = None
    with pytest.raises(TimeRuleError):
        check_no_overlap(later, [running])


def test_a_days_offset_comes_from_its_first_session():
    # Landed and kept working: the later session was recorded an hour west.
    early = FakeEntry(at(10, 7), at(10, 8), utc_offset=120)
    late = FakeEntry(at(10, 12), at(10, 13), utc_offset=60)
    assert day_offsets([late, early]) == {date(2026, 6, 10): 120}


def test_every_session_on_a_day_is_read_in_the_days_offset():
    early = FakeEntry(at(10, 7), at(10, 8), utc_offset=120)
    late = FakeEntry(at(10, 22, 30), at(10, 23), utc_offset=60)
    offsets = day_offsets([early, late])
    # 22:30 UTC is 00:30 on the 11th at +120, so the day's clock moves it.
    assert daily_slices(late, at(11, 0), offsets) == [(date(2026, 6, 11), 1800)]


def test_which_day_a_session_belongs_to_uses_its_own_offset():
    # Recorded at +120, where 23:30 UTC is already the next day.
    entry = FakeEntry(at(10, 23, 30), at(11, 0), utc_offset=120)
    assert starting_day(entry) == date(2026, 6, 11)


def test_an_overnight_session_still_splits_when_the_clock_agrees():
    entry = FakeEntry(at(10, 22), at(11, 2), utc_offset=0)
    offsets = day_offsets([entry, FakeEntry(at(11, 8), at(11, 9), utc_offset=0)])
    assert daily_slices(entry, at(11, 3), offsets) == [
        (date(2026, 6, 10), 2 * HOUR),
        (date(2026, 6, 11), 2 * HOUR),
    ]


def test_an_overnight_session_is_kept_whole_when_the_clocks_differ():
    # Flew west overnight: the 10th keeps +120, the 11th opens on +60.
    crossing = FakeEntry(at(10, 20), at(11, 1), utc_offset=120)
    next_day = FakeEntry(at(11, 8), at(11, 9), utc_offset=60)
    offsets = day_offsets([crossing, next_day])

    slices = daily_slices(crossing, at(11, 2), offsets)
    assert slices == [(date(2026, 6, 10), 5 * HOUR)]
    # Neither an hour invented nor an hour lost.
    assert sum(seconds for _, seconds in slices) == duration_seconds(
        crossing, at(11, 2)
    )


def test_flying_east_also_neither_invents_nor_loses_an_hour():
    crossing = FakeEntry(at(10, 20), at(11, 1), utc_offset=60)
    next_day = FakeEntry(at(11, 8), at(11, 9), utc_offset=120)
    offsets = day_offsets([crossing, next_day])

    slices = daily_slices(crossing, at(11, 2), offsets)
    assert sum(seconds for _, seconds in slices) == duration_seconds(
        crossing, at(11, 2)
    )
    assert len(slices) == 1


def test_without_offsets_a_session_is_read_in_its_own():
    entry = FakeEntry(at(10, 22), at(11, 2), utc_offset=0)
    assert daily_slices(entry, at(11, 3)) == [
        (date(2026, 6, 10), 2 * HOUR),
        (date(2026, 6, 11), 2 * HOUR),
    ]
