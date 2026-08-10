from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from config import get_settings

DATABASE_URL = get_settings().database_url

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, connection_record) -> None:
    """Turn on foreign key enforcement for every new SQLite connection.

    SQLite ignores foreign keys unless asked, which would silently defeat the
    ``ON DELETE CASCADE`` rules the schema relies on.

    Parameters
    ----------
    dbapi_connection : Any
        The freshly opened DBAPI connection.
    connection_record : Any
        SQLAlchemy's bookkeeping record for the connection. Unused.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


class Base(DeclarativeBase):
    """Declarative base class shared by every ORM model.

    Its ``metadata`` collects the schema of all mapped tables and is what
    Alembic compares against the database when autogenerating migrations.
    """


def get_db() -> Generator[Session, None, None]:
    """Provide a database session for the lifetime of a single request.

    Intended for use as a FastAPI dependency. The session is closed once the
    request finishes, whether or not it raised.

    Yields
    ------
    sqlalchemy.orm.Session
        A session bound to the application engine.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
