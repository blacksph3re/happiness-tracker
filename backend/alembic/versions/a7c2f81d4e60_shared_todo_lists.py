"""A todo list can be shared: one member table and one index swap.

Revision ID: a7c2f81d4e60
Revises: e5b90c2a71d4
Create Date: 2026-09-12

**No table is rebuilt.** That is worth stating precisely rather than leaving a
reader to work it out, because one half of this revision looks exactly like the
operation that has emptied tables in this database before:

* ``todo_list_members`` is new, so none of the copy-``DROP``-rename hazard
  applies to it at all.
* ``uq_todo_client_id`` is a **standalone partial index**, not a table
  constraint, so re-keying it is ``DROP INDEX`` followed by ``CREATE INDEX`` and
  ``todos`` is never copied. Written through ``batch_alter_table`` it would have
  been, which is the mistake this note exists to prevent. Measured rather than
  assumed: ``SELECT name, rootpage FROM sqlite_master WHERE type = 'table'``
  either side of the upgrade leaves ``todos`` and ``todo_steps`` unmoved, and
  ``tests/test_migrations.py::test_the_task_identity_swap_keeps_every_row_and_does_not_rebuild_the_table``
  asserts it with the table this revision creates as the control.

The swap is what makes a shared task one row. ``todos.client_id`` was unique per
**user**, as a session's and a pomodoro's still are; two members of one list
would each look a task up under their own id, find nothing, and insert a second
row. The ids are UUIDs, so nothing existing changes meaning — and the guard
below says so rather than assuming it.

``todo_steps.client_id`` is deliberately untouched. It is unique per ``todo_id``,
the parent is the scope, and every member resolves the same parent row.

There is no data step: ``todos.user_id`` stops meaning *owner* and starts
meaning *created by*, which is a change of reading rather than of rows.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a7c2f81d4e60"
down_revision: str | Sequence[str] | None = "e5b90c2a71d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _refuse_on_a_shared_identity() -> None:
    """Stop before the swap if two accounts already hold one `client_id`.

    Astronomically unlikely — the ids are UUIDs — and worth a guard anyway,
    because the alternative is a bare ``CREATE UNIQUE INDEX`` reporting *UNIQUE
    constraint failed* and naming neither the rows nor what to do about them. A
    migration that refuses beats one that stops halfway through.

    Run ahead of every statement here, so a database it refuses on is still
    exactly the database it found.

    Raises
    ------
    RuntimeError
        If any `client_id` appears on more than one task, naming them.
    """
    clashing = [
        row[0]
        for row in op.get_bind().execute(
            sa.text(
                "SELECT client_id FROM todos WHERE client_id IS NOT NULL"
                " GROUP BY client_id HAVING count(*) > 1"
            )
        )
    ]
    if clashing:
        raise RuntimeError(
            "These task identities are held by more than one row, so they "
            "cannot become globally unique: "
            + ", ".join(sorted(clashing))
            + ". Decide which row each one names before migrating."
        )


def upgrade() -> None:
    """Add the member table and re-key a task's identity on `client_id` alone."""
    _refuse_on_a_shared_identity()

    op.create_table(
        "todo_list_members",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("list_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        # `SET NULL` on the sharer and `CASCADE` on the other two: losing the
        # account that shared a list must not revoke everybody's access to it,
        # where losing the list or the member means the row has nothing left to
        # say.
        sa.ForeignKeyConstraint(["added_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["list_id"], ["todo_lists.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("list_id", "user_id", name="uq_list_member"),
    )
    op.create_index(
        "ix_todo_list_members_list_id", "todo_list_members", ["list_id"], unique=False
    )
    op.create_index(
        "ix_todo_list_members_user_id", "todo_list_members", ["user_id"], unique=False
    )

    # Index DDL only. A `batch_alter_table` here would name the index as its
    # reason to copy, DROP and rename `todos`.
    op.drop_index("uq_todo_client_id", table_name="todos")
    op.create_index(
        "uq_todo_client_id",
        "todos",
        ["client_id"],
        unique=True,
        sqlite_where=sa.text("client_id IS NOT NULL"),
    )


def downgrade() -> None:
    """Un-share every list and key a task's identity per account again.

    Narrowing the index cannot collide: a globally unique `client_id` is unique
    per user by implication, so this direction needs no guard.

    Every membership row goes, which is the honest cost of reversing a feature
    whose data has nowhere else to live. The tasks a member created in somebody
    else's list stay where they are, in the list they belong to — reachable
    again only by its owner.
    """
    op.drop_index("uq_todo_client_id", table_name="todos")
    op.create_index(
        "uq_todo_client_id",
        "todos",
        ["user_id", "client_id"],
        unique=True,
        sqlite_where=sa.text("client_id IS NOT NULL"),
    )

    op.drop_index("ix_todo_list_members_user_id", table_name="todo_list_members")
    op.drop_index("ix_todo_list_members_list_id", table_name="todo_list_members")
    op.drop_table("todo_list_members")
