"""Give seeded sessions the offset they would have been recorded with.

`seed_time.py` used to stamp every session `utc_offset = 0`. Nothing was wrong
with the durations — those come from the UTC instants — but the record's clock
indicator reads a day's offset and dutifully reported `UTC+00:00` on every
seeded day, which is true of Iceland and not of anywhere the machine has been.

This restamps sessions carrying a zero offset with the offset actually in force
locally at that instant, *keeping the wall clock they already read*. A session
showing 09:00 still shows 09:00; the stored instant moves so that stays true.

Sessions recorded through the app are left alone: their offset is a fact about
where the check-in happened, not a placeholder.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/restamp_seeded_offsets.py --dry-run
"""

import argparse
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import TimeEntry  # noqa: E402


def restamp(dry_run: bool) -> int:
    """Move zero-offset sessions onto the machine's own clock.

    Parameters
    ----------
    dry_run : bool
        Report what would change without writing it.

    Returns
    -------
    int
        How many sessions were restamped.
    """
    changed = 0
    with SessionLocal() as db:
        entries = (
            db.execute(select(TimeEntry).where(TimeEntry.utc_offset == 0))
            .scalars()
            .all()
        )
        for entry in entries:
            # The stored instant currently *is* the local reading, because the
            # offset was zero. Keep that reading and give it the real offset.
            local = entry.started_at.astimezone()
            offset = int(local.utcoffset().total_seconds() // 60)
            if offset == 0:
                continue
            shift = timedelta(minutes=offset)
            if dry_run:
                print(
                    f"{entry.started_at} → {entry.started_at - shift} "
                    f"(UTC+{offset // 60:02d}:{offset % 60:02d})"
                )
            else:
                entry.started_at -= shift
                if entry.ended_at is not None:
                    entry.ended_at -= shift
                entry.utc_offset = offset
            changed += 1
        if not dry_run:
            db.commit()
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report, do not write")
    options = parser.parse_args()

    count = restamp(options.dry_run)
    verb = "would restamp" if options.dry_run else "restamped"
    print(f"{verb} {count} sessions.")
