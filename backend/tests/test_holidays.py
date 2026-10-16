from datetime import date

import holidays
import pytest

from services.holidays import GERMAN_STATES, easter_sunday, public_holidays

YEARS = range(2015, 2036)


def test_easter_falls_on_the_known_sundays():
    assert easter_sunday(2024) == date(2024, 3, 31)
    assert easter_sunday(2025) == date(2025, 4, 20)
    assert easter_sunday(2026) == date(2026, 4, 5)
    assert easter_sunday(2038) == date(2038, 4, 25)


def test_the_sixteen_states_are_the_reference_libraries_sixteen():
    reference = {code for code in holidays.Germany.subdivisions if len(code) == 2}
    assert set(GERMAN_STATES) == reference


@pytest.mark.parametrize("state", sorted(GERMAN_STATES))
def test_every_states_holidays_match_the_reference_library(state):
    # The reference is a maintained library, kept out of the image: what it says
    # a state keeps is what this has to say too, name for name, one-offs
    # included. A rule written wrong here fails this rather than a balance.
    for year in YEARS:
        # English named explicitly: the library otherwise follows the locale of
        # whoever runs the tests.
        reference = holidays.Germany(subdiv=state, years=year, language="en_US")
        expected = dict(reference.items())
        assert public_holidays(state, year) == expected, f"{state} {year}"


def test_no_state_means_no_public_holidays():
    assert public_holidays(None, 2026) == {}


def test_a_rule_begins_in_its_year():
    assert date(2018, 3, 8) not in public_holidays("BE", 2018)
    assert public_holidays("BE", 2019)[date(2019, 3, 8)] == "Women's Day"
    assert date(2022, 3, 8) not in public_holidays("MV", 2022)
    assert date(2023, 3, 8) in public_holidays("MV", 2023)


def test_one_offs_happen_once():
    assert date(2017, 10, 31) in public_holidays("BY", 2017)
    assert date(2018, 10, 31) not in public_holidays("BY", 2018)
    assert date(2025, 5, 8) in public_holidays("BE", 2025)
    assert date(2026, 5, 8) not in public_holidays("BE", 2026)
