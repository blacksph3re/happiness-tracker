import json
import sqlite3

import pytest

from tests.conftest import BACKEND_DIR, forget_application_modules


def revisions():
    """Return every revision from the first to head, in application order."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config()
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    script = ScriptDirectory.from_config(config)
    return [rev.revision for rev in script.walk_revisions()][::-1]


def upgrade(target):
    """Migrate the database named by ``DB_STORAGE`` to one revision."""
    from alembic.config import Config

    from alembic import command

    config = Config()
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(config, target)


@pytest.fixture
def migrated(tmp_path, monkeypatch):
    """Point the migrations at an empty database of this test's own."""
    import config

    path = tmp_path / "history.db"
    monkeypatch.setenv("DB_STORAGE", str(path))
    config.get_settings.cache_clear()
    # Alembic's env.py reads the URL from `database`, so a copy left over from
    # another test would migrate that test's file instead of this one's.
    forget_application_modules()
    yield path
    config.get_settings.cache_clear()
    forget_application_modules()


def test_migrating_a_populated_database_keeps_its_rows(migrated):
    # SQLite rebuilds a table to alter a column, and the app enforces foreign
    # keys, so a careless migration silently cascades every answer away. This
    # walks the whole chain over a database that already holds data.
    chain = revisions()
    upgrade(chain[0])

    db = sqlite3.connect(migrated)
    db.execute("INSERT INTO catalogues (id, name) VALUES (1, 'Kept')")
    db.execute(
        "INSERT INTO users (id, username, password_hash, is_admin, is_editor)"
        " VALUES (1, 'someone', 'hash', 0, 0)"
    )
    db.execute(
        "INSERT INTO questions (id, catalogue_id, kind, prompt, position, active)"
        " VALUES (1, 1, 'enum', 'Where did you work', 0, 1)"
    )
    db.execute(
        "INSERT INTO question_options (id, question_id, label, position)"
        " VALUES (1, 1, 'Home', 0)"
    )
    db.execute(
        "INSERT INTO answers (id, user_id, question_id, day, option_id)"
        " VALUES (1, 1, 1, '2026-01-01', 1)"
    )
    db.commit()

    watched = ["catalogues", "users", "questions", "question_options", "answers"]

    for revision in chain[1:]:
        upgrade(revision)

        # Sessions arrive part-way along the chain, so they are seeded the
        # moment the tables exist and watched from there on. Without this the
        # whole time-tracking half migrated untested, including the backfills
        # that give every existing session a client identity.
        if "time_entries" not in watched and _has_table(db, "time_entries"):
            db.execute(
                "INSERT INTO projects (id, user_id, name, colour, position, active)"
                " VALUES (1, 1, 'Kept', 'tide', 0, 1)"
            )
            db.execute(
                "INSERT INTO time_entries"
                " (id, user_id, project_id, started_at, ended_at, utc_offset)"
                " VALUES (1, 1, 1, '2026-01-01 09:00:00', '2026-01-01 12:00:00', 0)"
            )
            db.commit()
            watched += ["projects", "time_entries"]

        # The todo lists arrive with two rows per account rather than one, so
        # they cannot join `watched` above - but the data step that inserts
        # them is exactly the kind that can half-succeed, so it is checked from
        # the revision it lands on onwards.
        if _has_table(db, "todo_lists"):
            assert db.execute(
                "SELECT user_id, count(*) FROM todo_lists WHERE kind <> 'ordinary'"
                " GROUP BY user_id ORDER BY user_id"
            ).fetchall() == [(1, 2)], f"{revision} lost a system list"

            # A task and a step, from the revision that can hold them onwards.
            # The identity index on `todos` is swapped further down the chain,
            # and an index swap is exactly the operation that can take the
            # table with it - so there has to be a row in there to lose.
            if "todos" not in watched:
                db.execute(
                    "INSERT INTO todos (id, user_id, list_id, client_id, title,"
                    " planned_on, rank, active_seconds)"
                    " SELECT 1, 1, l.id, 'kept-task', 'Feed the cat',"
                    " '2026-06-01', 'n', 0 FROM todo_lists l"
                    " WHERE l.user_id = 1 AND l.kind = 'inbox'"
                )
                db.execute(
                    "INSERT INTO todo_steps (id, todo_id, client_id, title, rank)"
                    " VALUES (1, 1, 'kept-step', 'Open the tin', 'n')"
                )
                db.commit()
                watched += ["todos", "todo_steps"]

        counts = {
            table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in watched
        }
        assert all(count == 1 for count in counts.values()), (
            f"{revision} lost rows: {counts}"
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT * FROM alembic_version").fetchall() == [(revision,)]

    # Every session ends up with an identity of its own, which is what later
    # offline edits and deletions refer to.
    ids = db.execute("SELECT client_id FROM time_entries").fetchall()
    assert all(client_id for (client_id,) in ids), f"unbackfilled client ids: {ids}"


def _has_table(db, name):
    """Whether the database has reached the revision that creates `name`."""
    found = db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return found is not None


CATALOGUE_OWNERSHIP = "3f1a7c4e9b20"
"""The revision that gives every catalogue an owner and clones it per user."""

COMPUTED_SYSTEM_VALUES = "c3e81f47a9d2"
"""The revision that deletes the auto-tracked answers and moves the hour."""


def test_shared_catalogues_become_one_per_user_without_losing_answers(migrated):
    # The migration that can lose history, on the shape that can lose it: two
    # accounts answering the *same* global catalogue. Cloning is the easy half;
    # repointing every answer onto its own copy is the half worth a test.
    chain = revisions()
    upgrade(chain[chain.index(CATALOGUE_OWNERSHIP) - 1])

    db = sqlite3.connect(migrated)
    db.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin, is_editor)
             VALUES (1, 'alice', 'h', 1, 1), (2, 'bob', 'h', 0, 0);
        INSERT INTO catalogues (id, name) VALUES (1, 'WHO-5');
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                require_all, min_value, max_value)
             VALUES (10, 1, 'discrete', 'Cheerful', 0, 1, 'asked', 1, 0, 5);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                system_key, require_all)
             VALUES (11, 1, 'enum', 'Weekday', 1000, 1, 'auto', 'weekday', 1);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                aggregate, require_all, min_value, max_value)
             VALUES (12, 1, 'continuous', 'Raw score', 500, 1, 'computed',
                     'sum', 1, 0, 1);
        INSERT INTO score_components (score_question_id, source_question_id, weight)
             VALUES (12, 10, 1.0);
        INSERT INTO question_options (id, question_id, label, position)
             VALUES (20, 11, 'Mon', 0), (21, 11, 'Tue', 1);
        UPDATE users SET default_catalogue_id = 1;
        INSERT INTO answers (user_id, question_id, day, value)
             VALUES (1, 10, '2026-06-01', 5), (2, 10, '2026-06-01', 1);
        INSERT INTO answers (user_id, question_id, day, option_id)
             VALUES (1, 11, '2026-06-01', 20), (2, 11, '2026-06-01', 21);
        """
    )
    db.commit()

    # To that revision, not to head: the auto-tracked rows this seeds are the
    # subject of `COMPUTED_SYSTEM_VALUES` further down the chain, which deletes
    # them. Walking past here would make the enum assertions below untestable
    # for a reason that has nothing to do with the migration under test.
    upgrade(CATALOGUE_OWNERSHIP)

    # One catalogue each, both still called what they were called.
    owners = db.execute(
        "SELECT user_id, name FROM catalogues ORDER BY user_id"
    ).fetchall()
    assert owners == [(1, "WHO-5"), (2, "WHO-5")]

    # Every answer survived, and every one of them now belongs to a question in
    # its own owner's catalogue. This is the assertion the whole migration is
    # for: a repointing bug shows up here as a row belonging to somebody else.
    assert db.execute("SELECT count(*) FROM answers").fetchone()[0] == 4
    assert (
        db.execute(
            "SELECT count(*) FROM answers a"
            " JOIN questions q ON q.id = a.question_id"
            " JOIN catalogues c ON c.id = q.catalogue_id"
            " WHERE c.user_id <> a.user_id"
        ).fetchone()[0]
        == 0
    )

    # The enum answers still mean what they meant. A repointed `question_id`
    # beside a stale `option_id` would read as the wrong day of the week, or as
    # an option belonging to a question the answer no longer references.
    assert db.execute(
        "SELECT a.user_id, o.label FROM answers a"
        " JOIN question_options o ON o.id = a.option_id ORDER BY a.user_id"
    ).fetchall() == [(1, "Mon"), (2, "Tue")]
    assert (
        db.execute(
            "SELECT count(*) FROM answers a"
            " JOIN question_options o ON o.id = a.option_id"
            " WHERE o.question_id <> a.question_id"
        ).fetchone()[0]
        == 0
    )

    # Each account's default is its own copy, and the score came across too.
    assert (
        db.execute(
            "SELECT count(*) FROM users u JOIN catalogues c"
            " ON c.id = u.default_catalogue_id WHERE c.user_id <> u.id"
        ).fetchone()[0]
        == 0
    )
    assert db.execute("SELECT count(*) FROM score_components").fetchone()[0] == 2

    # Nothing of the shared originals is left behind, and no dangling rows.
    assert db.execute("SELECT count(*) FROM catalogues").fetchone()[0] == 2
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_auto_tracked_answers_become_computed_without_losing_the_hour(migrated):
    """The migration that deletes answers, on the data it deletes them from.

    `test_migrating_a_populated_database_keeps_its_rows` cannot see this: it
    seeds a question with a null `system_key`, so a migration deleting only
    auto-tracked rows walks past it untouched. What has to hold here is that
    every recorded answer survives, the hour reaches its new column, and nothing
    auto-tracked is left.
    """
    chain = revisions()
    upgrade(chain[chain.index(COMPUTED_SYSTEM_VALUES) - 1])

    db = sqlite3.connect(migrated)
    db.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin)
             VALUES (1, 'alice', 'h', 1);
        INSERT INTO catalogues (id, name, user_id) VALUES (1, 'WHO-5', 1);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                require_all, min_value, max_value)
             VALUES (10, 1, 'discrete', 'Cheerful', 0, 1, 'asked', 1, 0, 5);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                system_key, require_all)
             VALUES (11, 1, 'enum', 'Weekday', 1000, 1, 'auto', 'weekday', 1);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                system_key, require_all, min_value, max_value)
             VALUES (12, 1, 'discrete', 'Hour of first answer', 1004, 1, 'auto',
                     'first_answer_hour', 1, 0, 23);
        INSERT INTO question_options (id, question_id, label, position)
             VALUES (20, 11, 'Mon', 0), (21, 11, 'Tue', 1);
        UPDATE users SET default_catalogue_id = 1;
        INSERT INTO answers (user_id, question_id, day, value)
             VALUES (1, 10, '2026-06-01', 5), (1, 10, '2026-06-02', 3);
        INSERT INTO answers (user_id, question_id, day, option_id)
             VALUES (1, 11, '2026-06-01', 20), (1, 11, '2026-06-02', 21);
        INSERT INTO answers (user_id, question_id, day, value)
             VALUES (1, 12, '2026-06-01', 8), (1, 12, '2026-06-02', 17);
        UPDATE users SET preferences = '{"stats": {"filters": {"weekday": [20],
                                         "q10": [5]}}}';
        """
    )
    db.commit()

    upgrade(COMPUTED_SYSTEM_VALUES)

    # Only what a person recorded is left, and each row kept its own value.
    assert db.execute(
        "SELECT question_id, day, value FROM answers ORDER BY day"
    ).fetchall() == [(10, "2026-06-01", 5.0), (10, "2026-06-02", 3.0)]

    # The hour reached the column, per day. This is the irreversible step.
    assert db.execute(
        "SELECT day, local_hour FROM answers ORDER BY day"
    ).fetchall() == [("2026-06-01", 8), ("2026-06-02", 17)]

    # Nothing auto-tracked survives, options included.
    assert (
        db.execute("SELECT count(*) FROM questions WHERE origin = 'auto'").fetchone()[0]
        == 0
    )
    assert db.execute("SELECT count(*) FROM question_options").fetchone()[0] == 0
    assert "system_key" not in {
        row[1] for row in db.execute("PRAGMA table_info(questions)").fetchall()
    }

    # A weekday filter held an option row id, which now means nothing. It comes
    # back empty rather than silently matching no day at all; a filter on a real
    # question is untouched.
    stored = json.loads(
        db.execute("SELECT preferences FROM users WHERE id = 1").fetchone()[0]
    )
    assert stored["stats"]["filters"] == {"q10": [5]}

    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_the_migration_refuses_rather_than_lose_an_hour(migrated):
    """The guard, on the one shape that would lose data silently.

    A day whose only rows are auto-tracked has nowhere to put its hour, so the
    backfill leaves nothing behind and the delete would take the fact with it.
    A migration that refuses beats one that half-succeeds.
    """
    chain = revisions()
    upgrade(chain[chain.index(COMPUTED_SYSTEM_VALUES) - 1])

    db = sqlite3.connect(migrated)
    db.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin)
             VALUES (1, 'alice', 'h', 1);
        INSERT INTO catalogues (id, name, user_id) VALUES (1, 'WHO-5', 1);
        INSERT INTO questions
               (id, catalogue_id, kind, prompt, position, active, origin,
                system_key, require_all, min_value, max_value)
             VALUES (12, 1, 'discrete', 'Hour of first answer', 1004, 1, 'auto',
                     'first_answer_hour', 1, 0, 23);
        INSERT INTO answers (user_id, question_id, day, value)
             VALUES (1, 12, '2026-06-01', 8);
        """
    )
    db.commit()

    with pytest.raises(Exception, match="would lose their first-answer hour"):
        upgrade(COMPUTED_SYSTEM_VALUES)

    # And it refused before deleting anything.
    assert db.execute("SELECT count(*) FROM answers").fetchone()[0] == 1


TODOS = "e5b90c2a71d4"
"""The revision that adds the todo tables and provisions the two system lists."""


def test_every_existing_account_is_given_an_inbox_and_an_archive(migrated):
    """The data step, on the shape it exists for: accounts that predate it.

    Insert-only and the safest kind there is, which is precisely why it is easy
    to get half right - a loop that inserts for the first account and stops, or
    one that gives everybody the same list twice.
    """
    chain = revisions()
    upgrade(chain[chain.index(TODOS) - 1])

    db = sqlite3.connect(migrated)
    db.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin)
             VALUES (1, 'alice', 'h', 1), (2, 'bob', 'h', 0);
        """
    )
    db.commit()

    upgrade(TODOS)

    assert db.execute(
        "SELECT user_id, kind, name FROM todo_lists ORDER BY user_id, rank"
    ).fetchall() == [
        (1, "inbox", "Inbox"),
        (1, "archive", "Archive"),
        (2, "inbox", "Inbox"),
        (2, "archive", "Archive"),
    ]
    # The inbox sorts first and the archive last, which is what the ranks are
    # for: `todo_lists` is ordered by rank and nothing else.
    ranks = db.execute("SELECT rank FROM todo_lists WHERE user_id = 1").fetchall()
    assert len({rank for (rank,) in ranks}) == 2
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_the_pomodoro_link_is_added_without_rebuilding_the_table(migrated):
    """`pomodoros.todo_id` is a nullable column with no server default.

    Which means SQLite adds it **in place**: `sqlite_master.rootpage` for
    `pomodoros` is unmoved either side. Measured rather than reasoned about,
    because "adding a column is safe" is the wrong rule and a migration
    docstring in this repository asserted it for a while.
    """
    chain = revisions()
    upgrade(chain[chain.index(TODOS) - 1])

    db = sqlite3.connect(migrated)
    db.execute(
        "INSERT INTO users (id, username, password_hash, is_admin)"
        " VALUES (1, 'alice', 'h', 1)"
    )
    db.execute(
        "INSERT INTO pomodoros"
        " (id, user_id, started_at, utc_offset, focus_seconds, break_seconds,"
        "  tainted)"
        " VALUES (1, 1, '2026-06-10 09:00:00', 0, 1500, 300, 0)"
    )
    db.commit()

    def rootpages():
        return dict(
            db.execute(
                "SELECT name, rootpage FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        )

    before = rootpages()
    upgrade(TODOS)
    after = rootpages()

    assert after["pomodoros"] == before["pomodoros"], (
        "the pomodoros table was rebuilt: copy, DROP, rename is the operation "
        "that has emptied tables in this database before"
    )
    # The control, and the reason the check above is not a coincidence: a table
    # this revision creates has no rootpage beforehand at all.
    assert "todos" not in before
    assert db.execute("SELECT count(*) FROM pomodoros").fetchone()[0] == 1
    # And the column really carries the reference, which is what makes deleting
    # a task leave its pomodoros behind rather than take them.
    assert "todo_id" in {
        row[1] for row in db.execute("PRAGMA table_info(pomodoros)").fetchall()
    }
    assert any(
        row[2] == "todos"
        for row in db.execute("PRAGMA foreign_key_list(pomodoros)").fetchall()
    ), "todo_id was added without its foreign key"


SHARED_LISTS = "a7c2f81d4e60"
"""The revision that adds `todo_list_members` and re-keys a task's identity."""


def _seed_two_accounts_with_lists(db):
    """Give two accounts the inbox and archive this revision expects.

    Inserted by hand rather than left to the revision that provisions them:
    that data step runs over the accounts it *finds*, and these are created
    after it has already been applied.
    """
    db.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin)
             VALUES (1, 'alice', 'h', 1), (2, 'bob', 'h', 0);
        INSERT INTO todo_lists (user_id, name, kind, colour, rank)
             VALUES (1, 'Inbox', 'inbox', 'tide', 'a'),
                    (1, 'Archive', 'archive', 'haze', 'z'),
                    (2, 'Inbox', 'inbox', 'tide', 'a'),
                    (2, 'Archive', 'archive', 'haze', 'z');
        """
    )
    db.commit()


def _insert_task(db, user_id, client_id, todo_id):
    """Insert one task into an account's inbox."""
    db.execute(
        "INSERT INTO todos (id, user_id, list_id, client_id, title, planned_on,"
        " rank, active_seconds)"
        " SELECT ?, ?, l.id, ?, 'Feed the cat', '2026-06-01', 'n', 0"
        "   FROM todo_lists l WHERE l.user_id = ? AND l.kind = 'inbox'",
        (todo_id, user_id, client_id, user_id),
    )
    db.commit()


def test_the_task_identity_swap_keeps_every_row_and_does_not_rebuild_the_table(
    migrated,
):
    """`uq_todo_client_id` becomes unique on `client_id` alone.

    Both halves measured rather than reasoned about. The index is a standalone
    partial index rather than a table constraint, so dropping and re-creating
    it is pure index DDL and ``sqlite_master.rootpage`` for ``todos`` is
    unmoved — where a `batch_alter_table` would have gone down the
    copy-``DROP``-rename path, which is the operation that has emptied tables
    in this database before.
    """
    chain = revisions()
    upgrade(chain[chain.index(SHARED_LISTS) - 1])

    db = sqlite3.connect(migrated)
    _seed_two_accounts_with_lists(db)
    _insert_task(db, 1, "alice-task", 1)
    _insert_task(db, 2, "bob-task", 2)
    db.execute(
        "INSERT INTO todo_steps (id, todo_id, client_id, title, rank)"
        " VALUES (1, 1, 'alice-step', 'Open the tin', 'n')"
    )
    db.commit()

    def rootpages():
        return dict(
            db.execute(
                "SELECT name, rootpage FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        )

    before = rootpages()
    assert "todo_list_members" not in before
    upgrade(SHARED_LISTS)
    after = rootpages()

    assert after["todos"] == before["todos"], (
        "the todos table was rebuilt: copy, DROP, rename is the operation that "
        "has emptied tables in this database before"
    )
    assert after["todo_steps"] == before["todo_steps"]
    assert db.execute("SELECT count(*) FROM todos").fetchone()[0] == 2
    assert db.execute("SELECT count(*) FROM todo_steps").fetchone()[0] == 1

    # The identity is global now, which is what lets two members of one list
    # resolve the same task rather than each inserting their own copy.
    assert [row[2] for row in db.execute("PRAGMA index_info('uq_todo_client_id')")] == [
        "client_id"
    ]
    with pytest.raises(sqlite3.IntegrityError):
        _insert_task(db, 2, "alice-task", 3)
    db.rollback()

    # A step's identity is unchanged: it is unique per parent, and the parent
    # is how a member reaches it.
    assert sorted(
        row[2] for row in db.execute("PRAGMA index_info('uq_step_client_id')")
    ) == ["client_id", "todo_id"]
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_the_identity_swap_refuses_rather_than_fail_on_a_collision(migrated):
    """The guard, on the one shape that cannot be made unique.

    Two accounts holding the same `client_id` is astronomically unlikely — the
    ids are UUIDs — but a bare ``CREATE UNIQUE INDEX`` would report it as
    *UNIQUE constraint failed*, naming neither the rows nor what to do. A
    migration that refuses with the colliding ids beats one that stops with a
    sentence about an index.
    """
    chain = revisions()
    upgrade(chain[chain.index(SHARED_LISTS) - 1])

    db = sqlite3.connect(migrated)
    _seed_two_accounts_with_lists(db)
    _insert_task(db, 1, "same-id", 1)
    _insert_task(db, 2, "same-id", 2)

    with pytest.raises(Exception, match="same-id"):
        upgrade(SHARED_LISTS)

    # And it refused before touching anything: the guard runs ahead of the
    # DDL, so a database it stops on is still exactly the one it found.
    assert db.execute("SELECT count(*) FROM todos").fetchone()[0] == 2
    assert not _has_table(db, "todo_list_members")


TASK_COLOUR = "b8d3a1f70c25"
"""The revision that gives a task its own optional colour."""


def test_a_task_colour_is_added_without_rebuilding_the_table(migrated):
    """`todos.colour` is nullable with no server default, so it adds in place.

    Measured rather than reasoned about, for the reason the whole
    *Which changes rebuild the table* rule exists: "adding a column is safe" is
    the wrong rule, and only *nullable with no server default* takes the
    in-place path. `sqlite_master.rootpage` for `todos` is unmoved either side,
    with `todo_steps` as a second unmoved table and the row count as the thing
    a copy-``DROP``-rename would have taken.
    """
    chain = revisions()
    upgrade(chain[chain.index(TASK_COLOUR) - 1])

    db = sqlite3.connect(migrated)
    _seed_two_accounts_with_lists(db)
    _insert_task(db, 1, "alice-task", 1)
    db.execute(
        "INSERT INTO todo_steps (id, todo_id, client_id, title, rank)"
        " VALUES (1, 1, 'alice-step', 'Open the tin', 'n')"
    )
    db.commit()

    def rootpages():
        return dict(
            db.execute(
                "SELECT name, rootpage FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        )

    before = rootpages()
    assert "colour" not in {
        row[1] for row in db.execute("PRAGMA table_info(todos)").fetchall()
    }
    upgrade(TASK_COLOUR)
    after = rootpages()

    assert after["todos"] == before["todos"], (
        "the todos table was rebuilt: copy, DROP, rename is the operation that "
        "has emptied tables in this database before"
    )
    assert after["todo_steps"] == before["todo_steps"]
    assert db.execute("SELECT count(*) FROM todos").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM todo_steps").fetchone()[0] == 1

    # The column exists, is nullable, carries no default, and every existing
    # row reads null — which is what "take the list's colour" is spelled as.
    column = next(
        row
        for row in db.execute("PRAGMA table_info(todos)").fetchall()
        if row[1] == "colour"
    )
    assert column[2] == "VARCHAR(16)"
    assert column[3] == 0, "colour arrived NOT NULL, which rebuilds the table"
    assert column[4] is None, "a server default rebuilds the table too"
    assert db.execute("SELECT colour FROM todos").fetchall() == [(None,)]
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
