"""capping deduction bands

Revision ID: 709c677cc1c5
Revises: ff867453dd4f
Create Date: 2026-08-13 17:47:51.853594

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "709c677cc1c5"
down_revision: Union[str, Sequence[str], None] = "ff867453dd4f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Let a band leave its deduction open, meaning "cap the day here"."""
    with op.batch_alter_table("deduction_bands") as batch:
        batch.alter_column("deduct_minutes", existing_type=sa.Integer(), nullable=True)
        batch.drop_constraint("ck_band_deduction_positive", type_="check")
        batch.create_check_constraint(
            "ck_band_deduction_positive",
            "deduct_minutes is null or deduct_minutes >= 0",
        )


def downgrade() -> None:
    """Turn caps back into plain bands that deduct nothing."""
    op.execute(
        "update deduction_bands set deduct_minutes = 0 where deduct_minutes is null"
    )
    with op.batch_alter_table("deduction_bands") as batch:
        batch.alter_column("deduct_minutes", existing_type=sa.Integer(), nullable=False)
        batch.drop_constraint("ck_band_deduction_positive", type_="check")
        batch.create_check_constraint(
            "ck_band_deduction_positive", "deduct_minutes >= 0"
        )
