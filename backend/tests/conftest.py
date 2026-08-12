import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
VENV_DIR = BACKEND_DIR / ".venv"
sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("JWT_SECRET", "test-secret-key")
os.environ.setdefault("ADMIN_USER", "admin")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password")
os.environ.setdefault("BOOTSTRAP_QUESTION_CATALOGUE", "1")


def apply_migrations():
    """Build this test's schema by running the real migrations.

    The application no longer creates tables at startup, so the suite goes
    through Alembic like a deployment does. That also means a migration that
    drifts from the models breaks the tests rather than passing unnoticed.

    The Config is built without a file so that Alembic's own logging setup does
    not run: `fileConfig` disables existing loggers, which would empty the
    `caplog` assertions elsewhere in the suite.
    """
    from alembic import command
    from alembic.config import Config

    config = Config()
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(config, "head")


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


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Yield a TestClient backed by a fresh, bootstrapped database."""
    import config

    monkeypatch.setenv("DB_STORAGE", str(tmp_path / "test.db"))
    config.get_settings.cache_clear()
    forget_application_modules()

    apply_migrations()

    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as test_client:
        yield test_client

    config.get_settings.cache_clear()


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
