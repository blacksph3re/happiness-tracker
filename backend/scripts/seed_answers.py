"""Fill a development database with a plausible answer history.

Values wander rather than repeat: each question follows its own random walk with
a mild weekday effect on top, so the timeline has trends to smooth, the weekday
facet has something to separate, and the scatter view has a correlation to find.
A fixed seed makes a given run reproducible.

Existing answers are never overwritten, so this can be run again to extend a
history or to fill in a question added later.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/seed_answers.py --days 90
"""

import argparse
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import selectinload  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import Answer, ORIGIN_ASKED, Question, User  # noqa: E402
from services import sync_system_answers  # noqa: E402

WEEKDAY_LIFT = (-0.2, -0.1, 0.0, 0.1, 0.4, 0.7, 0.5)
"""How much each weekday nudges an answer, Monday first.

Not a claim about anybody's week - it exists so the weekday facet and the box
plot have a difference to show instead of five identical distributions.
"""

ANSWER_HOUR = 21
"""Hour the seeded answers are recorded at, as if filled in that evening."""


def walk(rng: random.Random, low: float, high: float, days: int) -> list[float]:
    """Produce one question's values over a run of days.

    A random walk around the middle of the scale, pulled gently back towards it
    so the series neither flatlines nor sticks to an end.

    Parameters
    ----------
    rng : random.Random
        Seeded source of randomness.
    low : float
        Lower bound of the scale.
    high : float
        Upper bound of the scale.
    days : int
        How many values to produce.

    Returns
    -------
    list of float
        One value per day, within the bounds.
    """
    middle = (low + high) / 2
    span = high - low
    values = []
    position = middle + rng.uniform(-span / 8, span / 8)
    for _ in range(days):
        position += rng.gauss(0, span / 12) + (middle - position) * 0.15
        values.append(position)
    return values


def seed(days: int, username: str | None, seed_value: int) -> tuple[int, int]:
    """Write a history of answers for one user's default catalogue.

    Parameters
    ----------
    days : int
        How many days to cover, ending today.
    username : str or None
        Whose history to write. The first account when omitted.
    seed_value : int
        Seed for the random walk, so a run can be repeated exactly.

    Returns
    -------
    tuple of (int, int)
        How many answers were written, and how many were skipped as already
        present.

    Raises
    ------
    RuntimeError
        If there is no such user, or the user has no default catalogue.
    """
    rng = random.Random(seed_value)
    written = skipped = 0

    with SessionLocal() as db:
        statement = select(User).order_by(User.id)
        if username:
            statement = statement.where(User.username == username)
        user = db.execute(statement).scalars().first()
        if user is None:
            raise RuntimeError(f"No user named {username!r}")
        if user.default_catalogue_id is None:
            raise RuntimeError(f"{user.username!r} has no default catalogue")

        questions = (
            db.execute(
                select(Question)
                .options(selectinload(Question.options))
                .where(
                    Question.catalogue_id == user.default_catalogue_id,
                    Question.origin == ORIGIN_ASKED,
                    Question.active.is_(True),
                )
                .order_by(Question.position, Question.id)
            )
            .scalars()
            .all()
        )

        start = date.today() - timedelta(days=days - 1)
        series = {}
        for question in questions:
            if question.kind == "enum":
                if not question.options:
                    print(f"skipping {question.prompt!r}: it has no options")
                    continue
                series[question.id] = [
                    rng.choice(question.options) for _ in range(days)
                ]
            else:
                series[question.id] = walk(
                    rng, question.min_value, question.max_value, days
                )

        existing = {
            (row.question_id, row.day)
            for row in db.execute(
                select(Answer).where(
                    Answer.user_id == user.id, Answer.day >= start
                )
            ).scalars()
        }

        for offset in range(days):
            day = start + timedelta(days=offset)
            lift = WEEKDAY_LIFT[day.weekday()]
            for question in questions:
                if question.id not in series:
                    continue
                if (question.id, day) in existing:
                    skipped += 1
                    continue
                answer = Answer(user_id=user.id, question_id=question.id, day=day)
                if question.kind == "enum":
                    answer.option_id = series[question.id][offset].id
                else:
                    value = series[question.id][offset] + lift
                    value = min(max(value, question.min_value), question.max_value)
                    # Only a continuous question accepts a fraction; the rest are
                    # whole steps on their scale.
                    answer.value = (
                        round(value, 2)
                        if question.kind == "continuous"
                        else float(round(value))
                    )
                db.add(answer)
                written += 1
            sync_system_answers(
                db, user.id, user.default_catalogue_id, day, ANSWER_HOUR
            )

        db.commit()
        print(f"{user.username}: {start} → {date.today()}")
        return written, skipped


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=90, help="days of history")
    parser.add_argument("--user", default=None, help="whose history to write")
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    options = parser.parse_args()

    count, already = seed(options.days, options.user, options.seed)
    print(f"Wrote {count} answers, left {already} existing ones alone.")
