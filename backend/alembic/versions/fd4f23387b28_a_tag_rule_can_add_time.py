"""A tag rule can add time

Revision ID: fd4f23387b28
Revises: 3f1a7c4e9b20
Create Date: 2026-08-17

One nullable column, so a tag's rule can add time as well as take it away.

Nullable with no server default on purpose: that is the one shape SQLite adds in
place, and anything else — ``NOT NULL``, a default, a constraint — sends Alembic
down the copy, ``DROP``, rename path instead. `tags` is referenced by
`project_tags` and `deduction_bands`, so a rebuild here is not free.

Nothing is backfilled. NULL reads as "adds nothing", which is what every existing
tag does today, so this revision changes no number anywhere.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "fd4f23387b28"
down_revision: str | Sequence[str] | None = "3f1a7c4e9b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the nullable minutes a tag adds to each day it tracked."""
    with op.batch_alter_table("tags") as batch:
        batch.add_column(sa.Column("add_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Remove it, leaving every tag reporting tracked time less its deductions."""
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("add_minutes")
