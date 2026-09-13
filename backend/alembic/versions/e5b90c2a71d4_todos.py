"""Todos: three tables, one pomodoro link, and two lists per account.

Revision ID: e5b90c2a71d4
Revises: d7f2b45c1e88
Create Date: 2026-09-11

**No existing table is rebuilt**, which is worth saying precisely rather than
leaving a reader to work out:

* ``todo_lists``, ``todos`` and ``todo_steps`` are new, so none of the
  copy-``DROP``-rename hazard applies to them at all.
* ``pomodoros.todo_id`` is a **nullable column with no server default**, which
  is the one shape SQLite adds in place. A ``NOT NULL``, a non-constant
  default, or a changed constraint would each have sent the batch context down
  the rebuild path — the operation that has emptied tables in this database
  before. Measured rather than assumed:
  ``SELECT name, rootpage FROM sqlite_master WHERE type = 'table'`` either side
  of the upgrade leaves ``pomodoros`` unmoved, and
  ``tests/test_migrations.py::test_the_pomodoro_link_is_added_without_rebuilding_the_table``
  asserts it with the tables this revision creates as the control.

The column is added with **hand-written DDL**, which is the one part of this
that needs defending. Neither of the two obvious ways works:
``op.add_column`` adds a column's constraints as a separate
``ALTER TABLE ... ADD CONSTRAINT``, which SQLite has no support for at all, and
``batch_alter_table`` names the foreign key as its reason to take the
copy-``DROP``-rename path — the very thing being avoided here. SQLite's own
``ALTER TABLE ... ADD COLUMN`` accepts a ``REFERENCES`` clause directly, and
does so precisely because the default is NULL: there is no existing row for the
new constraint to be violated by. So the statement is written out, and the
rootpage test is what says it did what it claims.

The data step gives every existing account an inbox and an archive. Insert-only
— no repointing, no deletion — which is the safest kind of data migration there
is, and it is guarded by ``NOT EXISTS`` on top of the partial unique index, so
running it against a database that somehow already has the rows inserts
nothing. ``bootstrap()`` calls the same helper at every startup, so this is a
convenience rather than the only path: an account that this revision missed
would be given its lists the next time the server came up.

The two lists are spelled out here rather than imported from
``services.todos``. A migration is a statement about one moment in the schema's
history and must not change when the helper does; if the inbox is ever renamed
in the code, the accounts migrated by this revision are still to have been
given a list called *Inbox*.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e5b90c2a71d4"
down_revision: str | Sequence[str] | None = "d7f2b45c1e88"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SYSTEM_LISTS = (
    {"kind": "inbox", "name": "Inbox", "colour": "tide", "rank": "a"},
    {"kind": "archive", "name": "Archive", "colour": "haze", "rank": "z"},
)
"""The two lists every account is given, as this revision found them.

The ranks pin them to the ends of the move-between-lists view: ``"a"`` is the
zero of the rank encoding, so nothing sorts before the inbox, and ``"z"`` puts
the archive at the far right.
"""


def upgrade() -> None:
    """Create the todo tables, link pomodoros to tasks, and provision lists."""
    op.create_table(
        "todo_lists",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("colour", sa.String(length=16), nullable=False),
        sa.Column("rank", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind in ('ordinary', 'inbox', 'archive')", name="ck_list_kind"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_todo_lists_user_id", "todo_lists", ["user_id"], unique=False)
    # At most one inbox and one archive per account, and no ceiling on ordinary
    # lists. This is what makes `ensure_system_lists` safe to call from
    # anywhere as often as anything likes.
    op.create_index(
        "uq_list_kind",
        "todo_lists",
        ["user_id", "kind"],
        unique=True,
        sqlite_where=sa.text("kind != 'ordinary'"),
    )

    op.create_table(
        "todos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("list_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("planned_on", sa.Date(), nullable=False),
        sa.Column("planned_at", sa.Time(), nullable=True),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("priority", sa.String(length=9), nullable=True),
        sa.Column("duration_minutes", sa.Integer(), nullable=True),
        sa.Column("icon", sa.String(length=16), nullable=True),
        sa.Column("rank", sa.String(length=255), nullable=False),
        sa.Column("done_at", sa.DateTime(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("active_since", sa.DateTime(), nullable=True),
        sa.Column("active_seconds", sa.Integer(), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(), nullable=True),
        sa.Column("server_received_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.CheckConstraint("active_seconds >= 0", name="ck_todo_active_not_negative"),
        sa.CheckConstraint(
            "duration_minutes is null or duration_minutes >= 0",
            name="ck_todo_duration_not_negative",
        ),
        sa.CheckConstraint(
            "priority is null or priority in"
            " ('very_high', 'high', 'medium', 'low', 'very_low')",
            name="ck_todo_priority",
        ),
        sa.ForeignKeyConstraint(["list_id"], ["todo_lists.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_todos_user_id", "todos", ["user_id"], unique=False)
    op.create_index("ix_todos_list_id", "todos", ["list_id"], unique=False)
    op.create_index(
        "ix_todos_user_planned", "todos", ["user_id", "planned_on"], unique=False
    )
    op.create_index(
        "ix_todos_list_archived", "todos", ["list_id", "archived_at"], unique=False
    )
    # As for sessions and pomodoros: a device's own id for a task is unique to
    # that device's owner, so replaying the same intent twice updates one row
    # instead of making two.
    op.create_index(
        "uq_todo_client_id",
        "todos",
        ["user_id", "client_id"],
        unique=True,
        sqlite_where=sa.text("client_id IS NOT NULL"),
    )

    op.create_table(
        "todo_steps",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("todo_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("icon", sa.String(length=16), nullable=True),
        sa.Column("rank", sa.String(length=255), nullable=False),
        sa.Column("done_at", sa.DateTime(), nullable=True),
        sa.Column("client_updated_at", sa.DateTime(), nullable=True),
        sa.Column("server_received_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["todo_id"], ["todos.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_todo_steps_todo_id", "todo_steps", ["todo_id"], unique=False)
    # Unique per **parent**, not per account: a step's owner is reached through
    # its task, and the wire names the parent anyway.
    op.create_index(
        "uq_step_client_id",
        "todo_steps",
        ["todo_id", "client_id"],
        unique=True,
        sqlite_where=sa.text("client_id IS NOT NULL"),
    )

    # In place, not in a batch: see the module docstring. `SET NULL` rather
    # than a cascade, because deleting a task must not delete the hours spent
    # on it - the pomodoro falls back to the text that was typed at the time.
    op.execute(
        "ALTER TABLE pomodoros ADD COLUMN todo_id INTEGER"
        " REFERENCES todos(id) ON DELETE SET NULL"
    )
    op.create_index("ix_pomodoros_todo_id", "pomodoros", ["todo_id"], unique=False)

    connection = op.get_bind()
    for spec in SYSTEM_LISTS:
        connection.execute(
            sa.text(
                "INSERT INTO todo_lists"
                " (user_id, name, kind, colour, rank, created_at, updated_at)"
                " SELECT u.id, :name, :kind, :colour, :rank,"
                "        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP"
                "   FROM users u"
                "  WHERE NOT EXISTS (SELECT 1 FROM todo_lists l"
                "                     WHERE l.user_id = u.id AND l.kind = :kind)"
            ),
            spec,
        )


def downgrade() -> None:
    """Drop the todo tables and unlink pomodoros from tasks.

    Every task, subtask and list goes with them, which is the honest cost of
    reversing a feature whose data has nowhere else to live. Nothing else is
    touched: `pomodoros.task` was never written by this revision, so the focus
    history reads exactly as it did before the link existed.

    The tables are dropped deepest first. Foreign keys are off on the migration
    connection, so a cascade would not fire to do it for us — deleting a parent
    orphans its children rather than removing them.

    Dropping the column **does** rebuild ``pomodoros``, unavoidably: SQLite
    cannot remove a column that carries a constraint without rewriting the
    table. That is the asymmetry to know about if this is ever reversed against
    real data — the upgrade is in place and the downgrade is not.
    """
    op.drop_index("ix_pomodoros_todo_id", table_name="pomodoros")
    with op.batch_alter_table("pomodoros", schema=None) as batch:
        batch.drop_column("todo_id")

    op.drop_index("uq_step_client_id", table_name="todo_steps")
    op.drop_index("ix_todo_steps_todo_id", table_name="todo_steps")
    op.drop_table("todo_steps")

    op.drop_index("uq_todo_client_id", table_name="todos")
    op.drop_index("ix_todos_list_archived", table_name="todos")
    op.drop_index("ix_todos_user_planned", table_name="todos")
    op.drop_index("ix_todos_list_id", table_name="todos")
    op.drop_index("ix_todos_user_id", table_name="todos")
    op.drop_table("todos")

    op.drop_index("uq_list_kind", table_name="todo_lists")
    op.drop_index("ix_todo_lists_user_id", table_name="todo_lists")
    op.drop_table("todo_lists")
