"""A tag can carry a contract, days off and budget resets.

Revision ID: 744d2a58c91e
Revises: b8d3a1f70c25
Create Date: 2026-10-16

Three new tables and two new columns, and nothing else — autogenerate also
offered to rewrite the foreign key on ``pomodoros.todo_id``, which is drift
between the model's spelling and SQLite's and not part of this change, so it is
left out.

- ``tag_contracts``: the periods of a tag's contract, each in force from its
  ``starts_on``. The hour budget built on them is derived on read.
- ``tag_days_off``: days off marked by hand. A cleared one keeps its row with a
  NULL ``kind``, so last-write-wins holds both ways.
- ``budget_resets``: "Set hour budget", the balance at the start of a day,
  cleared the same way.
- ``tags.add_in_budget`` and ``deduction_bands.in_budget``: whether each part
  of the tag's rule counts toward the budget, NULL read as yes. Both are
  nullable with no default — the one shape SQLite adds **in place** — and so
  bare ``ADD COLUMN``s rather than batch operations, held by
  ``tests/test_migrations.py::test_a_contract_adds_its_columns_without_rebuilding``.

No data step: no tag has a contract until somebody gives it one.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "744d2a58c91e"
down_revision: str | Sequence[str] | None = "b8d3a1f70c25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATES = (
    "BB", "BE", "BW", "BY", "HB", "HE", "HH", "MV",
    "NI", "NW", "RP", "SH", "SL", "SN", "ST", "TH",
)  # fmt: skip
"""The sixteen states, spelled here rather than imported: a migration is frozen."""


def upgrade() -> None:
    """Create the three tables and add the two budget switches."""
    op.create_table(
        "tag_contracts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("daily_minutes", sa.Integer(), nullable=False),
        sa.Column("workdays", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=2), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "state is null or state in ("
            + ", ".join(f"'{code}'" for code in STATES)
            + ")",
            name="ck_contract_state",
        ),
        sa.CheckConstraint(
            "daily_minutes >= 0 and daily_minutes <= 1440",
            name="ck_contract_daily_minutes",
        ),
        sa.CheckConstraint(
            "workdays >= 0 and workdays <= 127", name="ck_contract_workdays"
        ),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tag_id", "starts_on", name="uq_contract_period_start"),
    )
    op.create_index("ix_tag_contracts_tag_id", "tag_contracts", ["tag_id"])

    op.create_table(
        "tag_days_off",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("client_updated_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "kind is null or kind in ('vacation', 'sick', 'other')",
            name="ck_day_off_kind",
        ),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tag_id", "day", name="uq_day_off_per_tag"),
    )
    op.create_index("ix_tag_days_off_tag_id", "tag_days_off", ["tag_id"])

    op.create_table(
        "budget_resets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("balance_minutes", sa.Integer(), nullable=True),
        sa.Column("client_updated_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tag_id", "day", name="uq_reset_per_tag"),
    )
    op.create_index("ix_budget_resets_tag_id", "budget_resets", ["tag_id"])

    op.add_column("tags", sa.Column("add_in_budget", sa.Boolean(), nullable=True))
    op.add_column(
        "deduction_bands", sa.Column("in_budget", sa.Boolean(), nullable=True)
    )


def downgrade() -> None:
    """Drop the switches and the three tables, losing every contract.

    Dropping a column rebuilds its table; nothing else refers to either switch,
    so the rebuild has nothing to lose.
    """
    with op.batch_alter_table("deduction_bands") as batch:
        batch.drop_column("in_budget")
    with op.batch_alter_table("tags") as batch:
        batch.drop_column("add_in_budget")
    op.drop_index("ix_budget_resets_tag_id", table_name="budget_resets")
    op.drop_table("budget_resets")
    op.drop_index("ix_tag_days_off_tag_id", table_name="tag_days_off")
    op.drop_table("tag_days_off")
    op.drop_index("ix_tag_contracts_tag_id", table_name="tag_contracts")
    op.drop_table("tag_contracts")
