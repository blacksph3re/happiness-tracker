"""Put back the options of the auto-tracked enum questions.

A migration that rebuilt the ``questions`` table while SQLite was enforcing
foreign keys cascaded every row of ``question_options`` and ``answers`` away.
The auto-tracked questions cannot be edited through the API, so a database
damaged that way cannot record a weekday or a month again without this.

The labels are generated, not recovered: they come from the same table the
questions were created from, so restoring them is exact. Answers are not
recoverable and this does not pretend otherwise.

Run from ``backend/``::

    uv run python scripts/restore_system_options.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import ORIGIN_AUTO, Question, QuestionOption  # noqa: E402
from services import SYSTEM_QUESTION_SPECS  # noqa: E402


def restore() -> int:
    """Add the missing options to every auto-tracked enum question.

    Idempotent: a question that already carries options is left untouched, so
    running this on a healthy database changes nothing.

    Returns
    -------
    int
        How many options were inserted.
    """
    added = 0
    with SessionLocal() as db:
        questions = (
            db.execute(
                select(Question).where(
                    Question.origin == ORIGIN_AUTO, Question.kind == "enum"
                )
            )
            .scalars()
            .all()
        )
        for question in questions:
            if question.options:
                continue
            labels = SYSTEM_QUESTION_SPECS[question.system_key].get("options", ())
            for position, label in enumerate(labels):
                db.add(
                    QuestionOption(
                        question_id=question.id, label=label, position=position
                    )
                )
                added += 1
            print(f"{question.prompt} (catalogue {question.catalogue_id}): "
                  f"{len(labels)} options")
        db.commit()
    return added


if __name__ == "__main__":
    count = restore()
    print(f"Restored {count} options." if count else "Nothing to restore.")
