"""Habit questions

Revision ID: d7f2b45c1e88
Revises: c3e81f47a9d2
Create Date: 2026-08-30

A habit is an enum question with three extra facts: which of its options count,
how many days in a period must count, and whether the target is a floor or a
ceiling. Five columns and no new table.

**This revision rebuilds two tables**, which is the operation that has emptied
tables in this database before, so it is worth saying exactly why rather than
leaving a reader to work it out:

* ``questions`` gains five check constraints, and a changed constraint sends
  Alembic's batch mode down the copy-``DROP``-rename path whatever else is in
  the batch. ``icon``, ``habit_period``, ``habit_target`` and ``habit_direction``
  would each have been an in-place add on their own; they come along with the
  rebuild the constraints force.
* ``question_options.counts`` is ``NOT NULL DEFAULT 0``, and ``NOT NULL`` takes
  the same path.

``answers`` is deliberately untouched and is the control: a run of this revision
that moves its ``rootpage`` is a run that did something nobody asked for.
``tests/test_migrations.py`` walks the whole chain and fails if any revision
loses a row.

The constraints are also enforced in ``services/wellbeing.py``, because a
constraint violation is a 500 and a service check is a 422 naming the field.
These are the floor under a hand-written UPDATE, not the thing a caller meets.

Nothing is backfilled. Every existing question is a plain question, which is
exactly what three NULLs mean, and every existing option counts towards nothing,
which is what ``counts = 0`` means.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7f2b45c1e88"
down_revision: str | Sequence[str] | None = "c3e81f47a9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HABIT_CONSTRAINTS = (
    (
        "ck_question_habit_triple",
        "(habit_period is null) = (habit_target is null)"
        " and (habit_period is null) = (habit_direction is null)",
    ),
    ("ck_question_habit_enum", "habit_period is null or kind = 'enum'"),
    (
        "ck_question_habit_period",
        "habit_period is null or habit_period in ('day', 'week', 'month')",
    ),
    (
        "ck_question_habit_direction",
        "habit_direction is null or habit_direction in ('at_least', 'at_most')",
    ),
    ("ck_question_habit_target", "habit_target is null or habit_target >= 0"),
)
"""Every check this revision adds to ``questions``, name and condition."""


def upgrade() -> None:
    """Add the habit columns and the constraints that keep them coherent."""
    with op.batch_alter_table("questions", schema=None) as batch:
        batch.add_column(sa.Column("icon", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("habit_period", sa.String(length=8), nullable=True))
        batch.add_column(sa.Column("habit_target", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("habit_direction", sa.String(length=8), nullable=True)
        )
        for name, condition in HABIT_CONSTRAINTS:
            batch.create_check_constraint(name, condition)

    with op.batch_alter_table("question_options", schema=None) as batch:
        batch.add_column(
            sa.Column(
                "counts",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    """Drop the habit columns and their constraints.

    Every habit definition goes with them. The answers do not: a habit's answers
    are ordinary enum answers and stay exactly where they were, so re-running the
    upgrade and re-ticking the boxes restores every streak in full.
    """
    with op.batch_alter_table("question_options", schema=None) as batch:
        batch.drop_column("counts")

    with op.batch_alter_table("questions", schema=None) as batch:
        for name, _ in HABIT_CONSTRAINTS:
            batch.drop_constraint(name, type_="check")
        batch.drop_column("habit_direction")
        batch.drop_column("habit_target")
        batch.drop_column("habit_period")
        batch.drop_column("icon")
