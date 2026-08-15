"""Client identity and clocks, for offline writes

Revision ID: b1c4e7a90d21
Revises: 709c677cc1c5
Create Date: 2026-08-15

Every column here exists so that a write made with no connection can be replayed
later and ordered against writes made elsewhere in the meantime:

* ``client_updated_at`` is the device's own clock at the moment of the tap, which
  is what last-write-wins compares. The server's ``updated_at`` cannot do that
  job — a fortnight-old queued answer would arrive looking newer than yesterday's
  correction.
* ``server_received_at`` records when the write actually landed, so a device with
  a wrong clock leaves something reconstructable behind.
* ``time_entries.client_id`` is the identity a session has before the server
  gives it one, so a correction or a deletion made offline knows what it refers
  to, and so replaying the same intent twice touches one row.

The existing rows are backfilled rather than left null: a session with no client
id could never be the target of an offline edit, and dating them from
``updated_at`` keeps every comparison total.
"""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "b1c4e7a90d21"
down_revision: str | Sequence[str] | None = "709c677cc1c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the client clocks and identities, and backfill them."""
    with op.batch_alter_table("answers") as batch:
        batch.add_column(sa.Column("client_updated_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("server_received_at", sa.DateTime(), nullable=True))

    with op.batch_alter_table("time_entries") as batch:
        batch.add_column(sa.Column("client_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("client_updated_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("server_received_at", sa.DateTime(), nullable=True))

    connection = op.get_bind()
    for table in ("answers", "time_entries"):
        connection.execute(
            sa.text(
                f"UPDATE {table} SET client_updated_at = updated_at "  # noqa: S608
                "WHERE client_updated_at IS NULL"
            )
        )

    # One uuid per row, generated here rather than in SQL: SQLite has no uuid
    # function, and a constant would collide with the unique index below.
    rows = connection.execute(
        sa.text("SELECT id FROM time_entries WHERE client_id IS NULL")
    ).fetchall()
    for (entry_id,) in rows:
        connection.execute(
            sa.text("UPDATE time_entries SET client_id = :cid WHERE id = :eid"),
            {"cid": str(uuid4()), "eid": entry_id},
        )

    op.create_index(
        "uq_entry_client_id",
        "time_entries",
        ["user_id", "client_id"],
        unique=True,
        sqlite_where=sa.text("client_id IS NOT NULL"),
    )


def downgrade() -> None:
    """Drop the client clocks and identities."""
    op.drop_index("uq_entry_client_id", table_name="time_entries")
    with op.batch_alter_table("time_entries") as batch:
        batch.drop_column("server_received_at")
        batch.drop_column("client_updated_at")
        batch.drop_column("client_id")
    with op.batch_alter_table("answers") as batch:
        batch.drop_column("server_received_at")
        batch.drop_column("client_updated_at")
