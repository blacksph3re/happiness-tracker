"""Turning an instant and an offset into a local day.

In the shared zone because all three halves need it: a session, an answer and a
pomodoro all record UTC plus the offset in force, and all three have to agree on
which local day that lands in. It lived in `timetrack` while only sessions
needed it; a second caller is the signal it was shared all along.
"""

from datetime import date, datetime, timedelta

MAX_UTC_OFFSET = 14 * 60
"""Largest real UTC offset in minutes. Kiribati is +14; nowhere is further."""

MIN_UTC_OFFSET = -12 * 60
"""Smallest real UTC offset in minutes."""


def local_day(instant: datetime, utc_offset: int) -> date:
    """Return the local day an instant falls in.

    Parameters
    ----------
    instant : datetime.datetime
        A naive UTC instant, as everything in this database stores.
    utc_offset : int
        Minutes east of UTC in force at that instant.

    Returns
    -------
    datetime.date
        The local day.
    """
    return (instant + timedelta(minutes=utc_offset)).date()


def offset_is_real(utc_offset: int) -> bool:
    """Report whether an offset names somewhere on Earth.

    Parameters
    ----------
    utc_offset : int
        Minutes east of UTC.

    Returns
    -------
    bool
        True when the offset lies within the range real zones use.
    """
    return MIN_UTC_OFFSET <= utc_offset <= MAX_UTC_OFFSET
