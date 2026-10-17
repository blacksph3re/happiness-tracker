"""The hour budget counts the whole rule: its switches are gone.

Revision ID: 9e4b1d7c3a52
Revises: 5c1e9a7b3d24
Create Date: 2026-10-17

``tags.add_in_budget`` and ``deduction_bands.in_budget`` let a part of a tag's
rule be left out of its hour budget. Nobody left one out, so the budget now
counts what the tag reports, and the two columns are dropped. A switch stored
as off simply stops mattering — the decision this revision records.

Dropped **in place**: SQLite has had ``DROP COLUMN`` since 3.35, and neither
column carries an index or a constraint, so nothing is rebuilt — ``tags`` above
all, which most tables point at. ``tests/test_migrations.py`` holds that, and
every row. The downgrade adds both back empty, which reads as on, in place too.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "9e4b1d7c3a52"
down_revision: str | Sequence[str] | None = "5c1e9a7b3d24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop both budget switches."""
    op.drop_column("tags", "add_in_budget")
    op.drop_column("deduction_bands", "in_budget")


def downgrade() -> None:
    """Add both budget switches back, empty: on."""
    op.add_column("tags", sa.Column("add_in_budget", sa.Boolean(), nullable=True))
    op.add_column(
        "deduction_bands", sa.Column("in_budget", sa.Boolean(), nullable=True)
    )
