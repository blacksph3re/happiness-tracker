"""Fill a development database with plausible tracked time.

Produces the shapes the views have to cope with rather than a tidy average
week: a lunch gap, a meeting nested inside a work session, an overnight session
crossing midnight, and one project under two tags — so `/time/patterns` shows
something in both toggle positions and the record view has a session to draw on
two days.

Existing sessions are never touched, so this can be run again to extend the
history.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/seed_time.py --days 30
"""

import argparse
import random
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import Project, ProjectTag, Tag, TimeEntry, User  # noqa: E402

STARTER_TAGS = (("Work", "tide"), ("Deep", "iris"))
"""Tags to seed, with their palette tokens."""

STARTER_PROJECTS = (
    # name, colour, tags, typical start hour, typical hours
    ("The rewrite", "tide", ("Work", "Deep"), 9.0, 4.5),
    ("Reviews", "iris", ("Work",), 14.0, 1.5),
    ("Standup", "amber", ("Work",), 9.5, 0.25),
    ("Reading", "sage", (), 20.5, 1.0),
)
"""Projects to seed. One of them carries two tags, so the by-tag view has an
overlap to show; one carries none, so the Untagged bucket is not empty."""


def seed(days: int, username: str | None, seed_value: int) -> int:
    """Write projects, tags and sessions for one user.

    Parameters
    ----------
    days : int
        How many days of history to cover, ending today.
    username : str or None
        Whose history to write. The first account when omitted.
    seed_value : int
        Seed for the jitter, so a run can be repeated exactly.

    Returns
    -------
    int
        How many sessions were written.

    Raises
    ------
    RuntimeError
        If there is no such user.
    """
    rng = random.Random(seed_value)
    written = 0

    with SessionLocal() as db:
        statement = select(User).order_by(User.id)
        if username:
            statement = statement.where(User.username == username)
        user = db.execute(statement).scalars().first()
        if user is None:
            raise RuntimeError(f"No user named {username!r}")

        tags = {}
        for position, (name, colour) in enumerate(STARTER_TAGS):
            tag = db.execute(
                select(Tag).where(Tag.user_id == user.id, Tag.name == name)
            ).scalar_one_or_none()
            if tag is None:
                tag = Tag(
                    user_id=user.id, name=name, colour=colour, position=position
                )
                db.add(tag)
                db.flush()
            tags[name] = tag

        projects = {}
        for position, (name, colour, labels, _, _) in enumerate(STARTER_PROJECTS):
            project = db.execute(
                select(Project).where(Project.user_id == user.id, Project.name == name)
            ).scalar_one_or_none()
            if project is None:
                project = Project(
                    user_id=user.id,
                    name=name,
                    colour=colour,
                    position=position,
                    active=True,
                )
                db.add(project)
                db.flush()
                for label in labels:
                    db.add(
                        ProjectTag(project_id=project.id, tag_id=tags[label].id)
                    )
            projects[name] = project

        start = date.today() - timedelta(days=days - 1)
        existing = {
            (row.project_id, row.started_at.date())
            for row in db.execute(
                select(TimeEntry).where(
                    TimeEntry.user_id == user.id, TimeEntry.started_at >= start
                )
            ).scalars()
        }

        for offset in range(days):
            day = start + timedelta(days=offset)
            weekend = day.weekday() >= 5
            for name, _, _, hour, length in STARTER_PROJECTS:
                project = projects[name]
                if (project.id, day) in existing:
                    continue
                # Weekends are quieter, and nothing is tracked every single day.
                if weekend and name != "Reading":
                    continue
                if rng.random() < 0.15:
                    continue

                began = datetime.combine(day, time.min) + timedelta(
                    hours=hour + rng.uniform(-0.5, 0.5)
                )
                ran = timedelta(hours=max(0.1, length + rng.uniform(-0.5, 0.9)))
                db.add(
                    TimeEntry(
                        user_id=user.id,
                        project_id=project.id,
                        started_at=began,
                        ended_at=began + ran,
                        utc_offset=0,
                    )
                )
                written += 1

        # One session over midnight, so the split has something to divide and
        # the record view has a session to draw on two days.
        overnight_day = date.today() - timedelta(days=2)
        overnight = projects["The rewrite"]
        if (overnight.id, overnight_day) not in existing:
            began = datetime.combine(overnight_day, time(22, 15))
            db.add(
                TimeEntry(
                    user_id=user.id,
                    project_id=overnight.id,
                    started_at=began,
                    ended_at=began + timedelta(hours=3, minutes=40),
                    utc_offset=0,
                )
            )
            written += 1

        db.commit()
        print(f"{user.username}: {start} → {date.today()}")
        return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30, help="days of history")
    parser.add_argument("--user", default=None, help="whose history to write")
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    options = parser.parse_args()

    print(f"Wrote {seed(options.days, options.user, options.seed)} sessions.")
