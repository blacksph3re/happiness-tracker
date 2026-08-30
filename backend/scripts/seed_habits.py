"""Add habit questions to a development catalogue and answer them plausibly.

A habit is an ordinary enum question carrying a target, so this writes exactly
what the questionnaire would have written: one question with its options, and one
answer per day it was recorded. Nothing here is a special kind of row.

The point is to make the streak views worth looking at, so the patterns are
deliberately varied rather than uniformly good — a long run, a run broken some
weeks ago so the best is not the current one, a ceiling habit with a spell over
budget, and stretches nobody recorded at all. Between them they produce every
cell state: met, missed, unrecorded, and the open period on the clock.

Existing questions and answers are never overwritten, so this can be run again to
extend a history or to add the habits to a second catalogue.

Run from `backend/`::

    JWT_SECRET=x uv run python scripts/seed_habits.py --days 180
"""

import argparse
import random
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import selectinload  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import ORIGIN_ASKED, Answer, Question, QuestionOption, User  # noqa: E402

ANSWER_HOUR = 21
"""Hour the seeded answers are recorded at, as if filled in that evening."""

HABIT_POSITION = 800
"""Where habits sort in a catalogue: after the questions and after a score at 500.

Its own band, so re-running this does not interleave habits with whatever the
catalogue already held.
"""


@dataclass(frozen=True)
class Habit:
    """One habit to create, and how faithfully it was kept."""

    prompt: str
    """The question as it is asked."""

    icon: str
    """The emoji the chips and the streak rows draw it with."""

    period: str
    """``day``, ``week`` or ``month``."""

    target: int
    """How many days in a period must carry a counted answer."""

    direction: str
    """``at_least`` or ``at_most``."""

    options: tuple[tuple[str, bool], ...]
    """Each choice, and whether it counts towards the target."""

    weight: tuple[float, ...]
    """Odds of each option on a day this habit was answered, parallel to `options`."""

    answered: float = 1.0
    """Odds of the habit being answered at all on a given day.

    Below one leaves days genuinely unrecorded, which is a different cell from a
    day answered "No" — the distinction the whole grid exists to draw.
    """

    slump: tuple[int, int] = (0, 0)
    """Days back from today where the habit went badly, as (from, to).

    What makes a best run longer than the current one, which is the pair the
    landing chips show side by side.
    """

    gap: tuple[int, int] = (0, 0)
    """Days back from today where nothing was recorded at all, as (from, to)."""


HABITS = (
    Habit(
        prompt="Went to the gym?",
        icon="🏃",
        period="week",
        target=2,
        direction="at_least",
        options=(("A long one", True), ("A short one", True), ("No", False)),
        weight=(0.24, 0.18, 0.58),
        answered=0.93,
        slump=(70, 112),
        gap=(126, 140),
    ),
    Habit(
        prompt="Read today?",
        icon="📖",
        period="week",
        target=4,
        direction="at_least",
        options=(("Yes", True), ("No", False)),
        weight=(0.74, 0.26),
        answered=0.96,
        slump=(35, 49),
    ),
    Habit(
        prompt="Drank enough water?",
        icon="💧",
        period="day",
        target=1,
        direction="at_least",
        options=(("Yes", True), ("Not really", False)),
        weight=(0.88, 0.12),
        answered=0.9,
        gap=(56, 63),
    ),
    Habit(
        prompt="Drinks today?",
        icon="🍷",
        period="week",
        target=2,
        direction="at_most",
        options=(("None", False), ("One or two", True), ("More than that", True)),
        weight=(0.7, 0.22, 0.08),
        answered=0.94,
        slump=(14, 28),
    ),
)
"""What to create. Four habits, chosen between them to exercise every cell state."""


def _within(offset: int, window: tuple[int, int]) -> bool:
    """Report whether a day this far back falls inside a window.

    Parameters
    ----------
    offset : int
        Days back from today, zero being today.
    window : tuple of int
        The window as (from, to), both counted back from today.

    Returns
    -------
    bool
        True when the day is inside it. An empty window contains nothing.
    """
    start, end = window
    return start != end and start <= offset <= end


def _choose(rng: random.Random, habit: Habit, harder: bool) -> int:
    """Pick which option a day is answered with, as a position in `options`.

    Parameters
    ----------
    rng : random.Random
        Seeded source of randomness.
    habit : Habit
        The habit being answered.
    harder : bool
        Whether this day falls in the habit's slump.

    Returns
    -------
    int
        The position of the chosen option.
    """
    weights = list(habit.weight)
    if harder:
        for index, (_, counts) in enumerate(habit.options):
            # A floor is missed by choosing the counted options less often; a
            # ceiling is broken by choosing them more. One slump, opposite
            # handling, because "went badly" means opposite things.
            wanted = habit.direction == "at_most"
            weights[index] *= 3.0 if counts == wanted else 0.4
    return rng.choices(range(len(habit.options)), weights=weights, k=1)[0]


def ensure_habits(db, catalogue_id: int) -> list[tuple[Habit, Question, list[int]]]:
    """Create the habit questions this catalogue does not already have.

    Parameters
    ----------
    db : sqlalchemy.orm.Session
        Active session.
    catalogue_id : int
        Catalogue the questions belong to.

    Returns
    -------
    list
        One entry per habit: its description, the question row, and the option
        ids in display order.
    """
    made = []
    for offset, habit in enumerate(HABITS):
        question = db.execute(
            select(Question)
            .options(selectinload(Question.options))
            .where(
                Question.catalogue_id == catalogue_id,
                Question.prompt == habit.prompt,
            )
        ).scalar_one_or_none()

        if question is None:
            question = Question(
                catalogue_id=catalogue_id,
                kind="enum",
                prompt=habit.prompt,
                position=HABIT_POSITION + offset,
                active=True,
                origin=ORIGIN_ASKED,
                icon=habit.icon,
                habit_period=habit.period,
                habit_target=habit.target,
                habit_direction=habit.direction,
            )
            db.add(question)
            db.flush()
            for position, (label, counts) in enumerate(habit.options):
                db.add(
                    QuestionOption(
                        question_id=question.id,
                        label=label,
                        position=position,
                        counts=counts,
                    )
                )
            db.flush()
            db.refresh(question)
            print(f"created  {habit.icon} {habit.prompt}")
        else:
            print(f"existing {habit.icon} {habit.prompt}")

        ordered = sorted(question.options, key=lambda option: option.position)
        made.append((habit, question, [option.id for option in ordered]))
    return made


def seed(days: int, username: str | None, seed_value: int) -> tuple[int, int]:
    """Create the habits and answer them over a run of days.

    Parameters
    ----------
    days : int
        How many days back from today to fill.
    username : str or None
        Whose catalogue to fill, or None for the first user.
    seed_value : int
        Random seed, so a given run is reproducible.

    Returns
    -------
    tuple of int
        How many answers were written, and how many days already had one.

    Raises
    ------
    SystemExit
        If the named user does not exist or has no default catalogue.
    """
    rng = random.Random(seed_value)
    written = 0
    skipped = 0

    with SessionLocal() as db:
        query = (
            select(User).where(User.username == username)
            if username
            else select(User).order_by(User.id)
        )
        user = db.execute(query).scalars().first()
        if user is None:
            raise SystemExit("no such user")
        if not user.default_catalogue_id:
            raise SystemExit(f"{user.username} has no default catalogue")

        made = ensure_habits(db, user.default_catalogue_id)
        db.commit()

        today = date.today()
        start = today - timedelta(days=days - 1)

        for habit, question, option_ids in made:
            existing = {
                row[0]
                for row in db.execute(
                    select(Answer.day).where(
                        Answer.user_id == user.id,
                        Answer.question_id == question.id,
                    )
                ).all()
            }
            for offset in range(days):
                day = start + timedelta(days=offset)
                back = (today - day).days
                if day in existing:
                    skipped += 1
                    continue
                if _within(back, habit.gap):
                    continue
                if rng.random() > habit.answered:
                    continue
                position = _choose(rng, habit, _within(back, habit.slump))
                db.add(
                    Answer(
                        user_id=user.id,
                        question_id=question.id,
                        day=day,
                        option_id=option_ids[position],
                        local_hour=ANSWER_HOUR,
                    )
                )
                written += 1

        db.commit()
        print(f"{user.username}: {start} → {today}")
        return written, skipped


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=180, help="days of history")
    parser.add_argument("--user", default=None, help="whose history to write")
    parser.add_argument("--seed", type=int, default=11, help="random seed")
    options = parser.parse_args()

    count, already = seed(options.days, options.user, options.seed)
    print(f"Wrote {count} answers, left {already} existing days alone.")
