from datetime import date, datetime

import pytest

from services.timetrack import (
    MONDAY_TO_FRIDAY,
    ContractPeriod,
    TimeRuleError,
    added_for,
    budget_days,
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


def test_overlapping_sessions_on_one_project_count_their_shared_time_once():
    entries = [
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
        FakeEntry(at(10, 11), at(10, 14), project_id=1),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 5 * HOUR}}


def test_a_session_inside_another_adds_nothing_to_the_project():
    entries = [
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
        FakeEntry(at(10, 10), at(10, 11), project_id=1),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 3 * HOUR}}


def test_identical_sessions_count_once():
    entries = [
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 3 * HOUR}}


def test_overlapping_sessions_on_different_projects_still_add():
    entries = [
        FakeEntry(at(10, 9), at(10, 12), project_id=1),
        FakeEntry(at(10, 10), at(10, 11), project_id=2),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 3 * HOUR, 2: HOUR}}


def test_a_finished_session_inside_a_running_one_adds_nothing():
    entries = [
        FakeEntry(at(10, 9), None, project_id=1),
        FakeEntry(at(10, 10), at(10, 11), project_id=1),
    ]
    assert summarise(entries, at(10, 14)) == {date(2026, 6, 10): {1: 5 * HOUR}}


def test_an_overlap_across_midnight_counts_once_on_each_day():
    entries = [
        FakeEntry(at(10, 22), at(11, 2), project_id=1),
        FakeEntry(at(10, 23), at(11, 1), project_id=1),
    ]
    assert summarise(entries, at(11, 12)) == {
        date(2026, 6, 10): {1: 2 * HOUR},
        date(2026, 6, 11): {1: 2 * HOUR},
    }


def test_an_overlap_recorded_on_two_clocks_is_measured_in_real_time():
    # The same real hour, one session told in UTC and one in UTC+2. The day
    # reads both by its opener's clock, but what overlaps is the instants.
    entries = [
        FakeEntry(at(10, 9), at(10, 12), utc_offset=0, project_id=1),
        FakeEntry(at(10, 10), at(10, 11), utc_offset=120, project_id=1),
    ]
    assert summarise(entries, at(10, 20)) == {date(2026, 6, 10): {1: 3 * HOUR}}


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


def test_a_capped_day_owes_its_break_before_the_cap():
    # The employer takes the break first and caps what is left, so a ten-hour
    # cap behind a 45-minute break bites only past 10h45 tracked.
    bands = [FakeBand(360, 30), FakeBand(480, 45), FakeBand(600, None)]
    assert reported(10 * HOUR, bands) == 9 * HOUR + 15 * 60
    assert deduction_for(10 * HOUR, bands) == 45 * 60
    assert reported(10 * HOUR + 45 * 60, bands) == 10 * HOUR
    assert reported(11 * HOUR, bands) == 10 * HOUR
    assert deduction_for(11 * HOUR, bands) == HOUR


def test_the_break_is_chosen_by_the_day_before_the_cap():
    # Twelve hours reach the 45-minute band, whatever the cap leaves.
    bands = [FakeBand(360, 30), FakeBand(480, 45), FakeBand(600, None)]
    assert reported(12 * HOUR, bands, add_minutes=60) == 10 * HOUR
    assert reported(9 * HOUR, bands, add_minutes=60) == 9 * HOUR + 15 * 60


def test_the_lowest_of_two_caps_binds():
    # A cap is a ceiling on what the day reports; a higher one changes nothing.
    bands = [FakeBand(600, None), FakeBand(660, None)]
    assert reported(12 * HOUR, bands) == 10 * HOUR
    assert reported(10 * HOUR + 30 * 60, bands) == 10 * HOUR


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


# --- The hour budget ----------------------------------------------------------
#
# June 2026: the 1st is a Monday. Contracts default to Mon-Fri at 8h a day, and
# "today" is Monday the 15th unless a test says otherwise.


def june(day):
    return date(2026, 6, day)


def contract(starts=1, hours=8, workdays=MONDAY_TO_FRIDAY, state=None):
    return ContractPeriod(
        starts_on=june(starts), daily_minutes=hours * 60, workdays=workdays, state=state
    )


def budget(tracked=None, contracts=None, today=15, **extra):
    days = budget_days(
        tracked={june(day): hours * HOUR for day, hours in (tracked or {}).items()},
        contracts=contracts or [contract()],
        today=june(today),
        **extra,
    )
    return {row.day.day: row for row in days}


def test_a_workday_expects_its_hours_and_a_weekend_nothing():
    rows = budget(today=8)
    assert [rows[day].expected for day in range(1, 8)] == [8 * HOUR] * 5 + [0, 0]
    assert rows[6].kind == "rest"


def test_an_untracked_workday_costs_its_hours():
    rows = budget({1: 8, 2: 8, 4: 8, 5: 8}, today=8)
    assert rows[3].counted == 0
    assert rows[7].balance == -8 * HOUR


def test_overtime_accumulates():
    rows = budget({day: 9 for day in range(1, 6)}, today=8)
    assert rows[7].balance == 5 * HOUR


def test_time_on_a_rest_day_counts_in_full():
    rows = budget({1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 3}, today=8)
    assert rows[7].balance == 3 * HOUR


def test_today_shows_its_progress_and_does_not_count_until_it_is_over():
    rows = budget({1: 8, 2: 3}, today=2)
    assert rows[2].open
    assert (rows[2].counted, rows[2].expected) == (3 * HOUR, 8 * HOUR)
    assert rows[2].balance == 0
    assert 3 not in rows


def test_nothing_is_expected_before_the_contract():
    rows = budget(contracts=[contract(starts=3)], today=8)
    assert min(rows) == 3


def test_a_contract_change_applies_from_its_date_only():
    rows = budget(contracts=[contract(), contract(starts=8, hours=4)], today=15)
    assert rows[5].expected == 8 * HOUR
    assert rows[8].expected == 4 * HOUR
    assert rows[14].balance == -(5 * 8 + 5 * 4) * HOUR


def test_a_contract_of_zero_hours_ends_the_expectation():
    rows = budget(contracts=[contract(), contract(starts=8, hours=0)], today=15)
    assert rows[8].expected == 0
    assert rows[14].balance == -40 * HOUR


def test_workdays_are_the_contracts_own():
    monday_to_thursday = 1 | 2 | 4 | 8
    rows = budget(contracts=[contract(workdays=monday_to_thursday)], today=8)
    assert rows[5].kind == "rest"
    assert rows[5].expected == 0


def test_a_public_holiday_in_the_contracts_state_costs_nothing():
    # Corpus Christi, Thursday 4 June 2026: kept in Bavaria, not in Berlin.
    bavaria = budget(contracts=[contract(state="BY")], today=8)
    berlin = budget(contracts=[contract(state="BE")], today=8)
    assert (bavaria[4].kind, bavaria[4].name, bavaria[4].expected) == (
        "holiday",
        "Corpus Christi",
        0,
    )
    assert berlin[4].expected == 8 * HOUR


def test_a_day_off_costs_nothing():
    rows = budget({1: 8, 2: 8, 4: 8, 5: 8}, days_off={june(3): "vacation"}, today=8)
    assert (rows[3].kind, rows[3].name, rows[3].expected) == ("off", "vacation", 0)
    assert rows[7].balance == 0


def test_a_day_off_on_a_rest_day_changes_nothing():
    rows = budget(days_off={june(6): "vacation"}, today=8)
    assert rows[6].kind == "rest"


def test_a_reset_fixes_the_balance_at_the_start_of_its_day():
    rows = budget({8: 9}, resets={june(8): 2 * HOUR}, today=10)
    assert rows[5].balance == -40 * HOUR
    assert rows[8].reset == 2 * HOUR
    assert rows[8].balance == 3 * HOUR
    assert rows[9].balance == -5 * HOUR


def test_the_latest_reset_before_a_day_wins():
    rows = budget(resets={june(2): 0, june(4): 10 * HOUR}, today=5)
    assert rows[4].balance == 2 * HOUR


def test_the_budget_counts_what_the_tag_reports():
    # The whole rule, addition and every band: 9h tracked, +1h, then the
    # 45-minute band — 9h 15m, what the tag reports for the day.
    bands = [FakeBand(0, 30), FakeBand(360, 45)]
    rows = budget({1: 9}, add_minutes=60, bands=bands, today=2)
    assert rows[1].counted == 9 * HOUR + 15 * 60
    assert rows[1].counted == reported(9 * HOUR, bands, add_minutes=60)


def test_a_budget_with_no_contract_is_empty():
    assert budget_days(tracked={}, contracts=[], today=june(15)) == []


def test_a_day_off_from_the_balance_costs_its_hours_and_is_still_a_day_off():
    rows = budget(days_off={june(3): "balance"}, today=4)
    assert (rows[3].kind, rows[3].name) == ("off", "balance")
    assert rows[3].expected == 8 * HOUR
    assert rows[3].balance == rows[2].balance - 8 * HOUR


def test_time_tracked_on_a_day_off_from_the_balance_counts_against_its_hours():
    rows = budget(tracked={3: 2}, days_off={june(3): "balance"}, today=4)
    assert rows[3].balance - rows[2].balance == -6 * HOUR


def test_a_day_off_from_the_balance_on_a_weekend_or_a_holiday_costs_nothing():
    # Saturday the 6th; Corpus Christi, Thursday the 4th, in Bavaria.
    rows = budget(
        days_off={june(6): "balance", june(4): "balance"},
        contracts=[contract(state="BY")],
        today=8,
    )
    assert (rows[6].kind, rows[6].expected) == ("rest", 0)
    assert (rows[4].kind, rows[4].expected) == ("holiday", 0)
