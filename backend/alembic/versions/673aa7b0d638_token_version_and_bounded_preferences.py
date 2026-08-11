"""token version and bounded preferences

Revision ID: 673aa7b0d638
Revises: 98c9a74fa88c
Create Date: 2026-08-11 16:01:39.320212

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '673aa7b0d638'
down_revision: Union[str, Sequence[str], None] = '98c9a74fa88c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add the per-account token version and trim oversized preferences."""
    with op.batch_alter_table("users") as batch:
        batch.add_column(
            sa.Column(
                "token_version", sa.Integer(), nullable=False, server_default="0"
            )
        )

    # Anything already stored beyond the new ceiling is view state, not data
    # worth keeping; clearing it makes the column honest about its bound.
    op.execute(
        sa.text(
            "UPDATE users SET preferences = NULL"
            " WHERE preferences IS NOT NULL AND length(preferences) > 8192"
        )
    )


def downgrade() -> None:
    """Drop the per-account token version."""
    with op.batch_alter_table("users") as batch:
        batch.drop_column("token_version")
