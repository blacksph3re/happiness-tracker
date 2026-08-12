import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, event, pool

from alembic import context

# make the app package importable when alembic runs from the project root
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import models  # noqa: E402,F401  (imported for its side effect: registering tables)
from database import DATABASE_URL, Base  # noqa: E402

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    # SQLite cannot alter a column in place, so batch mode rebuilds the whole
    # table: copy, DROP, rename. With foreign keys enforced - which the app
    # switches on for every connection - that DROP cascades, and every answer
    # and option referencing the table is deleted along with it. Alembic's own
    # SQLite guidance is to turn enforcement off while migrating.
    #
    # It is done on the raw connection rather than through the Connection,
    # because SQLite ignores the pragma inside a transaction and issuing it
    # through SQLAlchemy opens one - which also swallows Alembic's commit, so
    # the schema changes but the version stamp never lands.
    if connectable.dialect.name == "sqlite":

        @event.listens_for(connectable, "connect")
        def _relax_foreign_keys(dbapi_connection, connection_record) -> None:
            """Turn off foreign key enforcement for the migration connection.

            Parameters
            ----------
            dbapi_connection : sqlite3.Connection
                The freshly opened driver connection.
            connection_record : sqlalchemy.pool.base._ConnectionRecord
                Pool bookkeeping for that connection. Unused.
            """
            dbapi_connection.execute("PRAGMA foreign_keys=OFF")

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
