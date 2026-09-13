"""A task carries its own optional colour.

Revision ID: b8d3a1f70c25
Revises: a7c2f81d4e60
Create Date: 2026-09-12

One column, and the one shape SQLite adds **in place**: nullable, with no
server default. Anything else — ``NOT NULL``, a non-constant default, a changed
constraint — sends the batch context down the copy-``DROP``-rename path, which
is the operation that has emptied tables in this database before. So this is a
bare ``ADD COLUMN`` rather than a ``batch_alter_table``, and it is measured
rather than asserted: ``SELECT name, rootpage FROM sqlite_master WHERE type =
'table'`` leaves ``todos`` unmoved either side, with
``tests/test_migrations.py::test_a_task_colour_is_added_without_rebuilding_the_table``
holding that and the row counts.

There is no data step and no backfill. NULL already means what every existing
task needs it to mean — *take the list's colour*, which is what the client
draws today — so a value written here would be inventing a choice nobody made.

No ``CheckConstraint`` either, and deliberately: the column is bounded by
`schemas.COLOUR_PATTERN` alone, as ``projects.colour`` and ``todo_lists.colour``
already are. A constraint listing today's palette would make a colour from a
later release a 500 on a server one version behind, and adding one later is the
rebuild path this revision exists to stay off.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b8d3a1f70c25"
down_revision: str | Sequence[str] | None = "a7c2f81d4e60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add `todos.colour`, nullable and with no default."""
    op.add_column("todos", sa.Column("colour", sa.String(length=16), nullable=True))


def downgrade() -> None:
    """Drop the column, losing whatever colours had been chosen.

    A dropped column **does** rebuild the table, which is why the guard on this
    direction is that there is nothing else to lose: `colour` holds a display
    choice and no other row refers to it.
    """
    with op.batch_alter_table("todos") as batch:
        batch.drop_column("colour")
