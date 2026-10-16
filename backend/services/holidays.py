"""German public holidays, described rather than stored or imported.

A public holiday is a rule, not a fact somebody has to enter: a fixed date, a
date relative to Easter, and a table of which of the sixteen states keeps it,
plus the occasional one-off. So it is calculated, like the auto-tracked
variables — no network, no table, and it works offline in the client's port
(`app/src/lib/time/holidays.js`).

Held to an outside reference: `tests/test_holidays.py` compares every state and
every year 2015-2035 with the maintained `holidays` package, which is a dev
dependency only and never reaches the image. Holidays kept below state level —
Assumption Day in Catholic Bavaria, Corpus Christi in parts of Saxony and
Thuringia — follow the reference's state-level answer and are left out.
"""

from datetime import date, timedelta

from models import GERMAN_STATES

_EVERYWHERE = frozenset(GERMAN_STATES)

_FIXED: tuple[tuple[int, int, str, frozenset[str], int], ...] = (
    (1, 1, "New Year's Day", _EVERYWHERE, 0),
    (1, 6, "Epiphany", frozenset({"BW", "BY", "ST"}), 0),
    (3, 8, "Women's Day", frozenset({"BE"}), 2019),
    (3, 8, "Women's Day", frozenset({"MV"}), 2023),
    (5, 1, "Labor Day", _EVERYWHERE, 0),
    (8, 15, "Assumption Day", frozenset({"SL"}), 0),
    (9, 20, "World Children's Day", frozenset({"TH"}), 2019),
    (10, 3, "German Unity Day", _EVERYWHERE, 0),
    (10, 31, "Reformation Day", frozenset({"BB", "MV", "SN", "ST", "TH"}), 0),
    (10, 31, "Reformation Day", frozenset({"HB", "HH", "NI", "SH"}), 2017),
    (11, 1, "All Saints' Day", frozenset({"BW", "BY", "NW", "RP", "SL"}), 0),
    (12, 25, "Christmas Day", _EVERYWHERE, 0),
    (12, 26, "Second Day of Christmas", _EVERYWHERE, 0),
)
"""Fixed-date holidays: month, day, name, the states keeping it, the first year."""

_EASTER: tuple[tuple[int, str, frozenset[str]], ...] = (
    (-2, "Good Friday", _EVERYWHERE),
    (0, "Easter Sunday", frozenset({"BB"})),
    (1, "Easter Monday", _EVERYWHERE),
    (39, "Ascension Day", _EVERYWHERE),
    (49, "Pentecost", frozenset({"BB"})),
    (50, "Pentecost Monday", _EVERYWHERE),
    (60, "Corpus Christi", frozenset({"BW", "BY", "HE", "NW", "RP", "SL"})),
)
"""Holidays counted in days from Easter Sunday, and the states keeping each."""

_ONE_OFFS: tuple[tuple[date, str, frozenset[str]], ...] = (
    (date(2017, 10, 31), "Reformation Day", _EVERYWHERE),
    (
        date(2020, 5, 8),
        "75th anniversary of the liberation from Nazism and the end of the "
        "Second World War in Europe",
        frozenset({"BE"}),
    ),
    (
        date(2025, 5, 8),
        "80th anniversary of the liberation from Nazism and the end of the "
        "Second World War in Europe",
        frozenset({"BE"}),
    ),
    (
        date(2028, 6, 17),
        "75th anniversary of the East German uprising of 1953",
        frozenset({"BE"}),
    ),
)
"""Holidays declared for a single year."""


def easter_sunday(year: int) -> date:
    """Return Easter Sunday of a Gregorian year.

    The anonymous Gregorian algorithm (Meeus/Jones/Butcher): exact for every
    year of the Gregorian calendar, in integer arithmetic.

    Parameters
    ----------
    year : int
        The year.

    Returns
    -------
    datetime.date
        Easter Sunday.
    """
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741 - the algorithm's own name
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _repentance_day(year: int) -> date:
    """Return the Day of Prayer and Repentance: the Wednesday before 23 November.

    Parameters
    ----------
    year : int
        The year.

    Returns
    -------
    datetime.date
        The Wednesday between 16 and 22 November.
    """
    eve = date(year, 11, 22)
    return eve - timedelta(days=(eve.weekday() - 2) % 7)


def public_holidays(state: str | None, year: int) -> dict[date, str]:
    """Return a state's public holidays in a year, by date.

    Parameters
    ----------
    state : str or None
        A `GermanState` code, or None for a contract that keeps no public
        holidays.
    year : int
        The year.

    Returns
    -------
    dict
        ``{date: English name}``, matching the reference library's names.
    """
    if state is None:
        return {}
    found: dict[date, str] = {}
    for month, day, name, states, since in _FIXED:
        if state in states and year >= since:
            found[date(year, month, day)] = name
    easter = easter_sunday(year)
    for offset, name, states in _EASTER:
        if state in states:
            found[easter + timedelta(days=offset)] = name
    if state == "SN":
        found[_repentance_day(year)] = "Repentance and Prayer Day"
    for day, name, states in _ONE_OFFS:
        if day.year == year and state in states:
            found[day] = name
    return found
