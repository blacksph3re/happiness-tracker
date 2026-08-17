"""Catalogues belong to a user

Revision ID: 3f1a7c4e9b20
Revises: 8a23e0d33960
Create Date: 2026-08-17

Questions were the last thing in this application owned by everybody. This gives
every catalogue an owner, gives every account its own copy of what it could see
before, and drops the ``is_editor`` permission that existed only because
catalogues were shared.

**The cloning is the easy half; the repointing is the half that can lose
history.** An answer names its question by id, and every id changes here, so a
clone that forgets to carry `answers.question_id` *and* `answers.option_id`
across leaves rows pointing at questions this migration is about to delete. A
guard below refuses to go on if any answer is still pointing at an original,
because `env.py` disables foreign keys for the migration connection: nothing
would stop the delete, and the damage would be silent.

Four phases, in one revision because a half-migrated database is not a state
worth being able to stop in. SQLite has non-transactional DDL, so splitting them
into separate revisions would not buy atomicity either way.

1. Add ``catalogues.user_id`` (nullable), drop the global unique on ``name``,
   and add the per-user one. The constraint has to go first: a clone carries the
   same name as its original, so the very first insert would fail under it.
2. Clone every catalogue for every user; repoint that user's answers; delete the
   originals. Pure DML.
3. Now that every row has an owner, make ``user_id`` NOT NULL.
4. Drop ``users.is_editor``.

All four phases rebuild their tables — copy, ``DROP``, rename — because changing
nullability or a constraint cannot be done in place. That is the operation this
project has been bitten by before, and `tests/test_migrations.py` walks the whole
chain asserting no revision loses a row.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "3f1a7c4e9b20"
down_revision: str | Sequence[str] | None = "8a23e0d33960"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _catalogues_without_the_global_unique() -> sa.Table:
    """Describe ``catalogues`` as the first rebuild should understand it.

    Handed to `batch_alter_table` as ``copy_from`` so that it does not reflect
    the table itself. That is the point: the column-level ``UNIQUE`` on ``name``
    is an inline constraint SQLite reports without a name, which leaves nothing
    to write a ``drop_constraint`` against. Omitting it from this description is
    what removes it — the new table is built from here plus the operations
    applied, so a constraint absent from both is absent from the result.

    Dropping it has to happen *before* the cloning, not after: the first clone
    carries the same name as the original it was copied from, and with the
    global constraint still in place the very first insert fails.

    Returns
    -------
    sqlalchemy.Table
        Today's shape, minus the constraint being dropped.
    """
    return sa.Table(
        "catalogues",
        sa.MetaData(),
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )


def _clone_catalogues_per_user(connection: sa.Connection) -> None:
    """Give every account its own copy of every catalogue, answers and all.

    Every catalogue is cloned for every user rather than only the ones an
    account has touched. On a database with several of each that produces copies
    nobody asked for, and it is still the right trade: it is one rule instead of
    two, and it cannot be wrong about which catalogue somebody was about to
    start using.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's own connection, with foreign keys disabled.

    Raises
    ------
    RuntimeError
        If any answer still references an original question after repointing.
        That is a bug in this function, and continuing would delete the answer.
    """
    users = connection.execute(
        sa.text("SELECT id, default_catalogue_id FROM users ORDER BY id")
    ).fetchall()
    originals = connection.execute(
        sa.text("SELECT id, name, created_at FROM catalogues ORDER BY id")
    ).fetchall()
    if not users or not originals:
        return

    for user_id, default_catalogue_id in users:
        for catalogue_id, name, created_at in originals:
            clone_id = connection.execute(
                sa.text(
                    "INSERT INTO catalogues (name, created_at, user_id) "
                    "VALUES (:name, :created_at, :user_id) RETURNING id"
                ),
                {"name": name, "created_at": created_at, "user_id": user_id},
            ).scalar_one()

            questions, options = _clone_questions(connection, catalogue_id, clone_id)
            _clone_score_components(connection, questions)
            _repoint_answers(connection, user_id, questions, options)

            if default_catalogue_id == catalogue_id:
                connection.execute(
                    sa.text(
                        "UPDATE users SET default_catalogue_id = :clone WHERE id = :id"
                    ),
                    {"clone": clone_id, "id": user_id},
                )

    original_ids = [row[0] for row in originals]
    _refuse_if_answers_still_point_at(connection, original_ids)
    _delete_catalogues(connection, original_ids)


def _clone_questions(
    connection: sa.Connection, source_catalogue: int, target_catalogue: int
) -> tuple[dict[int, int], dict[int, int]]:
    """Copy one catalogue's questions and options into another.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's connection.
    source_catalogue : int
        Catalogue being copied from.
    target_catalogue : int
        Catalogue being copied into.

    Returns
    -------
    tuple of (dict, dict)
        Old-to-new ids for questions, and for options.
    """
    columns = (
        "kind, prompt, position, active, origin, system_key, aggregate, "
        "require_all, min_value, max_value, min_label, max_label"
    )
    rows = connection.execute(
        sa.text(f"SELECT id, {columns} FROM questions WHERE catalogue_id = :c"),  # noqa: S608
        {"c": source_catalogue},
    ).fetchall()

    questions: dict[int, int] = {}
    options: dict[int, int] = {}
    placeholders = ", ".join(f":{name.strip()}" for name in columns.split(","))
    for row in rows:
        values = dict(zip(columns.replace(" ", "").split(","), row[1:], strict=True))
        new_id = connection.execute(
            sa.text(
                f"INSERT INTO questions (catalogue_id, {columns}) "  # noqa: S608
                f"VALUES (:catalogue_id, {placeholders}) RETURNING id"
            ),
            {"catalogue_id": target_catalogue, **values},
        ).scalar_one()
        questions[row[0]] = new_id

        for option_id, label, position in connection.execute(
            sa.text(
                "SELECT id, label, position FROM question_options WHERE question_id = :q"
            ),
            {"q": row[0]},
        ).fetchall():
            options[option_id] = connection.execute(
                sa.text(
                    "INSERT INTO question_options (question_id, label, position) "
                    "VALUES (:q, :label, :position) RETURNING id"
                ),
                {"q": new_id, "label": label, "position": position},
            ).scalar_one()

    return questions, options


def _clone_score_components(
    connection: sa.Connection, questions: dict[int, int]
) -> None:
    """Rebuild the score-to-source links between a catalogue's cloned questions.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's connection.
    questions : dict
        Old-to-new question ids for the catalogue just cloned.
    """
    if not questions:
        return
    ids = ", ".join(str(int(old)) for old in questions)
    rows = connection.execute(
        sa.text(
            "SELECT score_question_id, source_question_id, weight FROM score_components "  # noqa: S608
            f"WHERE score_question_id IN ({ids})"
        )
    ).fetchall()
    for score_id, source_id, weight in rows:
        # A component whose source sits in another catalogue cannot be expressed
        # between these clones. None exist - a score reads its own catalogue -
        # and skipping is the safe answer if one ever did.
        if source_id not in questions:
            continue
        connection.execute(
            sa.text(
                "INSERT INTO score_components "
                "(score_question_id, source_question_id, weight) "
                "VALUES (:score, :source, :weight)"
            ),
            {
                "score": questions[score_id],
                "source": questions[source_id],
                "weight": weight,
            },
        )


def _repoint_answers(
    connection: sa.Connection,
    user_id: int,
    questions: dict[int, int],
    options: dict[int, int],
) -> None:
    """Move one user's answers onto their own copies of the questions.

    Both columns, and that is the whole point: an answer carrying a repointed
    `question_id` beside a stale `option_id` names an option belonging to a
    question it no longer references.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's connection.
    user_id : int
        Whose answers to move.
    questions : dict
        Old-to-new question ids.
    options : dict
        Old-to-new option ids.
    """
    for old_question, new_question in questions.items():
        connection.execute(
            sa.text(
                "UPDATE answers SET question_id = :new "
                "WHERE user_id = :u AND question_id = :old"
            ),
            {"new": new_question, "u": user_id, "old": old_question},
        )
    for old_option, new_option in options.items():
        connection.execute(
            sa.text(
                "UPDATE answers SET option_id = :new "
                "WHERE user_id = :u AND option_id = :old"
            ),
            {"new": new_option, "u": user_id, "old": old_option},
        )


def _refuse_if_answers_still_point_at(
    connection: sa.Connection, catalogue_ids: list[int]
) -> None:
    """Stop the migration if deleting the originals would take answers with it.

    A gate rather than a report. Foreign keys are off for this connection, so
    the delete below would not cascade — it would leave answers referencing rows
    that no longer exist, which is worse than either outcome it replaces.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's connection.
    catalogue_ids : list of int
        The catalogues about to be deleted.

    Raises
    ------
    RuntimeError
        If any answer still references a question in those catalogues.
    """
    ids = ", ".join(str(int(one)) for one in catalogue_ids)
    stranded = connection.execute(
        sa.text(
            "SELECT count(*) FROM answers WHERE question_id IN "  # noqa: S608
            f"(SELECT id FROM questions WHERE catalogue_id IN ({ids}))"
        )
    ).scalar_one()
    if stranded:
        raise RuntimeError(
            f"{stranded} answers still reference the original catalogues; "
            "refusing to delete them. This is a bug in the clone step, not a "
            "condition to retry."
        )


def _delete_catalogues(connection: sa.Connection, catalogue_ids: list[int]) -> None:
    """Delete catalogues and everything under them, deepest first.

    Explicitly, and in order, because `env.py` disables foreign keys for the
    migration connection: the ``ON DELETE CASCADE`` these tables carry does not
    fire here, and deleting only the catalogues would orphan every question and
    option beneath them.

    Parameters
    ----------
    connection : sqlalchemy.Connection
        The migration's connection.
    catalogue_ids : list of int
        The catalogues to remove.
    """
    ids = ", ".join(str(int(one)) for one in catalogue_ids)
    questions = f"(SELECT id FROM questions WHERE catalogue_id IN ({ids}))"  # noqa: S608
    connection.execute(
        sa.text(
            f"DELETE FROM score_components WHERE score_question_id IN {questions} "  # noqa: S608
            f"OR source_question_id IN {questions}"
        )
    )
    connection.execute(
        sa.text(f"DELETE FROM question_options WHERE question_id IN {questions}")  # noqa: S608
    )
    connection.execute(
        sa.text(f"DELETE FROM questions WHERE catalogue_id IN ({ids})")  # noqa: S608
    )
    connection.execute(sa.text(f"DELETE FROM catalogues WHERE id IN ({ids})"))  # noqa: S608


def upgrade() -> None:
    """Give catalogues an owner, clone them per user, and drop the permission."""
    # Phase 1 - the owner column and the constraint swap, together, because the
    # cloning below cannot run under the old global unique on `name`. `user_id`
    # stays nullable for now: there is nothing to put in it yet.
    with op.batch_alter_table(
        "catalogues", copy_from=_catalogues_without_the_global_unique()
    ) as batch:
        batch.add_column(sa.Column("user_id", sa.Integer(), nullable=True))
        batch.create_index("ix_catalogues_user_id", ["user_id"])
        batch.create_unique_constraint(
            "uq_catalogue_name_per_user", ["user_id", "name"]
        )
        batch.create_foreign_key(
            "fk_catalogues_user_id_users",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )

    # Phase 2 - the data.
    _clone_catalogues_per_user(op.get_bind())

    # Phase 3 - every row now has an owner, so the column can say so.
    with op.batch_alter_table("catalogues") as batch:
        batch.alter_column("user_id", existing_type=sa.Integer(), nullable=False)

    # Phase 4 - the permission that only existed because catalogues were shared.
    with op.batch_alter_table("users") as batch:
        batch.drop_column("is_editor")


def downgrade() -> None:
    """Return catalogues to being shared, keeping one copy of each name.

    Lossy on purpose, and it cannot be otherwise: going back means choosing one
    account's copy of a catalogue to be everybody's, and the answers belonging
    to the copies that lose are re-pointed at the survivor's questions by
    position. Present so the chain is walkable, not because reversing this is a
    thing anyone should plan to do.
    """
    with op.batch_alter_table("users") as batch:
        batch.add_column(
            sa.Column(
                "is_editor",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )
    with op.batch_alter_table("catalogues") as batch:
        batch.drop_constraint("uq_catalogue_name_per_user", type_="unique")
        batch.drop_index("ix_catalogues_user_id")
        batch.drop_column("user_id")
