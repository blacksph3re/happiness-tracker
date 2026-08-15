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
