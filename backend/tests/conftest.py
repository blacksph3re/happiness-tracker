import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from beartype.claw import beartype_packages

BACKEND_DIR = Path(__file__).resolve().parents[1]
VENV_DIR = BACKEND_DIR / ".venv"
sys.path.insert(0, str(BACKEND_DIR))

CHECKED_MODULES = (
    "bootstrap",
    "config",
    "database",
    "deps",
    "main",
    "models",
    "routers",
    "schemas",
    "security",
    "services",
)
"""The application's own modules, which the suite type-checks at runtime.

Listed rather than checking everything: beartype would otherwise wrap SQLAlchemy
and FastAPI too, which costs time and reports on code this repo does not own.
"""

# Every annotation in those modules becomes an assertion for the duration of the
# suite, so a function that says it returns a Question and hands back a dict
# fails here rather than at some distance from its cause. This is deliberately
# not installed anywhere the application itself imports: beartype is a dev
# dependency, the image is built with `--no-dev`, and a running server is
# unaffected. The hook rewrites modules as they are imported, so it has to be in
# place before any of them are - which is what puts it at the top of conftest.
beartype_packages(CHECKED_MODULES)

os.environ.setdefault("JWT_SECRET", "test-secret-key")
# A fixed Fernet key, so a test can decrypt what the server stored and check it
# really was encrypted rather than merely configured to be.
os.environ.setdefault(
    "TOTP_ENCRYPTION_KEY", "o0dLTjqIfBEr6C7t6y0jhRHBRALhtfPFksrJv1sPmKY="
)
os.environ.setdefault("ADMIN_USER", "admin")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password")
os.environ.setdefault("BOOTSTRAP_QUESTION_CATALOGUE", "1")


def apply_migrations():
    """Build the schema at ``DB_STORAGE`` by running the real migrations.

    The application no longer creates tables at startup, so the suite goes
    through Alembic like a deployment does. That also means a migration that
    drifts from the models breaks the tests rather than passing unnoticed.

    The Config is built without a file so that Alembic's own logging setup does
    not run: `fileConfig` disables existing loggers, which would empty the
    `caplog` assertions elsewhere in the suite.
    """
    from alembic.config import Config

    from alembic import command

    config = Config()
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(config, "head")


_TEMPLATE = None
"""A migrated but empty database, built once and copied per test."""


def migrated_template():
    """Return the path of a database with the schema already built.

    Every test wants its own database, and every test used to get one by
    walking the whole revision chain — which is the same twelve migrations, on
    the same empty file, a couple of hundred times over. Run once and copied,
    the result is byte-identical and the copy costs about a millisecond.

    What this must not become is a way of *skipping* the migrations: they still
    run, in this process, from the same code a deployment uses, and a revision
    that fails still fails here. `tests/test_migrations.py` walks the chain
    revision by revision on its own database and is untouched by this.

    Returns
    -------
    pathlib.Path
        The template file. Copy it; never open it for writing.
    """
    global _TEMPLATE
    if _TEMPLATE is None:
        import config

        built = Path(tempfile.mkdtemp(prefix="ht-template-")) / "template.db"
        previous = os.environ.get("DB_STORAGE")
        os.environ["DB_STORAGE"] = str(built)
        config.get_settings.cache_clear()
        forget_application_modules()
        try:
            apply_migrations()
        finally:
            if previous is None:
                os.environ.pop("DB_STORAGE", None)
            else:
                os.environ["DB_STORAGE"] = previous
            config.get_settings.cache_clear()
            # Building the template imports the application bound to *it*, and
            # a cached `database` module would hand the next import an engine
            # pointing at the template rather than at the test's own file.
            # Dropped again so this leaves nothing behind but the file.
            forget_application_modules()
        _TEMPLATE = built
    return _TEMPLATE


def forget_application_modules():
    """Drop every already-imported application module.

    The next import then rebuilds the engine against whatever ``DB_STORAGE``
    currently names. The `routers` *package* must go too: leaving it cached
    makes `from routers import auth` hand back the previous test's submodule,
    still bound to the previous test's database.
    """
    for name, module in list(sys.modules.items()):
        if name in {"config", "conftest"} or name.startswith("tests"):
            continue
        origin = getattr(module, "__file__", None)
        if not origin:
            continue
        path = Path(origin).resolve()
        if not path.is_relative_to(BACKEND_DIR) or path.is_relative_to(VENV_DIR):
            continue
        sys.modules.pop(name, None)


def build_client(tmp_path, monkeypatch, environment):
    """Yield a TestClient for an application rebuilt against `environment`.

    The application modules are dropped before the import, so the settings read
    at import time are the ones this call has just put in place rather than a
    previous test's.

    Parameters
    ----------
    tmp_path : pathlib.Path
        Directory holding this test's database file.
    monkeypatch : pytest.MonkeyPatch
        Used to scope the environment changes to the calling test.
    environment : dict of str to str
        Variables to set on top of the defaults.

    Yields
    ------
    fastapi.testclient.TestClient
        Client bound to the freshly imported application.
    """
    import config

    monkeypatch.setenv("DB_STORAGE", str(tmp_path / "test.db"))
    # Cleared rather than left alone: an exported DOCS_ENABLED in the
    # developer's shell would otherwise decide what the default-case tests see,
    # and they would pass or fail depending on whose machine ran them.
    monkeypatch.delenv("DOCS_ENABLED", raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    config.get_settings.cache_clear()
    forget_application_modules()

    # Copied rather than migrated: the schema is the same either way, and the
    # difference across the suite is the better part of a minute.
    shutil.copyfile(migrated_template(), tmp_path / "test.db")

    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as test_client:
        yield test_client

    config.get_settings.cache_clear()


def rebound_client(tmp_path, monkeypatch):
    """Yield a TestClient for the *same* application, on a fresh database.

    `build_client` rebuilds the world: it drops every application module and
    imports them again, because the engine is created at import time from
    ``DB_STORAGE``. That is about 170ms, and it was being paid by every test in
    the suite — the better part of half the running time, spent re-importing
    FastAPI routers and re-registering SQLAlchemy mappers that had not changed.

    Nothing imports the engine directly; the application reaches the database
    only through `SessionLocal`, which is a `sessionmaker` object the modules
    hold a reference to. Pointing that at a new engine therefore reaches all of
    them, and the import can happen once.

    What still has to be reset by hand is every piece of process-wide state the
    rebuild used to clear for free, and getting that list wrong is the way this
    leaks between tests:

    * the settings cache, so ``DB_STORAGE`` and the rest are re-read;
    * the login throttle, or a test that locks an account out would spend the
      next test's budget as well;
    * the TOTP cipher, which is keyed from the settings.

    A test needing a *different* environment cannot use this — `DOCS_ENABLED`
    and `PASSWORD_MIN_LENGTH` are read while the application is being
    constructed, so changing them means constructing it again. Those go through
    `build_client`, which is unchanged.

    Yields
    ------
    fastapi.testclient.TestClient
        Client bound to the shared application and this test's database.
    """
    import config

    database_path = tmp_path / "test.db"
    monkeypatch.setenv("DB_STORAGE", str(database_path))
    monkeypatch.delenv("DOCS_ENABLED", raising=False)
    config.get_settings.cache_clear()
    shutil.copyfile(migrated_template(), database_path)

    main = shared_application()

    from sqlalchemy import create_engine

    import database
    import security

    security.get_login_throttle.cache_clear()
    security._cipher.cache_clear()

    previous = database.engine
    engine = create_engine(
        config.get_settings().database_url, connect_args={"check_same_thread": False}
    )
    database.engine = engine
    database.SessionLocal.configure(bind=engine)

    from fastapi.testclient import TestClient

    # The context manager runs the application's lifespan, so the admin account
    # and the starter catalogue are bootstrapped into this test's database
    # exactly as they were before.
    with TestClient(main.app) as test_client:
        yield test_client

    engine.dispose()
    database.engine = previous
    database.SessionLocal.configure(bind=previous)
    config.get_settings.cache_clear()
    security.get_login_throttle.cache_clear()
    security._cipher.cache_clear()


_APPLICATION = None
"""The imported application, built once and rebound per test."""


def shared_application():
    """Import the application once, and hand back the same module after that.

    Returns
    -------
    module
        The imported ``main`` module.
    """
    global _APPLICATION
    # Checked against `sys.modules`, not merely cached: `build_client` drops
    # every application module to rebuild one with a different environment, and
    # after it has run, a held-onto `main` is a module whose routes close over
    # a *previous* `security` and `database`. Clearing the throttle on the new
    # one then clears a throttle nothing consults, and a lockout from one test
    # spends the next test's budget — which is how this first went wrong.
    if _APPLICATION is None or sys.modules.get("main") is not _APPLICATION:
        forget_application_modules()
        import main

        _APPLICATION = main
    return _APPLICATION


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Yield a TestClient backed by a fresh, bootstrapped database."""
    yield from rebound_client(tmp_path, monkeypatch)


@pytest.fixture
def docs_client(tmp_path, monkeypatch):
    """Yield a TestClient for an application built with the API docs enabled."""
    yield from build_client(tmp_path, monkeypatch, {"DOCS_ENABLED": "1"})


@pytest.fixture
def admin_token(client):
    """Return a bearer token for the bootstrapped admin account."""
    response = client.post(
        "/api/login", json={"username": "admin", "password": "admin-password"}
    )
    assert response.status_code == 200
    return response.json()["access_token"]


@pytest.fixture
def admin_headers(admin_token):
    """Return authorization headers for the bootstrapped admin account."""
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture
def catalogue_id(client, admin_headers):
    """Return the id of the bootstrapped default catalogue."""
    return client.get("/api/catalogues", headers=admin_headers).json()[0]["id"]


@pytest.fixture
def starter_questions(client, admin_headers, catalogue_id):
    """Return the bootstrapped questions the user actually answers."""
    detail = client.get(
        f"/api/catalogues/{catalogue_id}", headers=admin_headers
    ).json()
    return [q for q in detail["questions"] if q["origin"] == "asked"]


def make_user(client, admin_headers, username, **flags):
    """Create a user through the admin API and return a login token for them."""
    password = "user-password"
    response = client.post(
        "/api/users",
        headers=admin_headers,
        json={"username": username, "password": password, **flags},
    )
    assert response.status_code == 201, response.text
    login = client.post(
        "/api/login", json={"username": username, "password": password}
    )
    assert login.status_code == 200
    return response.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}
