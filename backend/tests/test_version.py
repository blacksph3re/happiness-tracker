import json
import re
import tomllib

from tests.conftest import BACKEND_DIR

"""The two halves carry one version, and it is a semantic one.

They ship as a single image, so a build in which they disagreed would be a build
nobody could name — "which version is this?" would have two answers. Keeping them
equal is a convention, and a convention nothing checks is a convention that has
already drifted: `app/package.json` sat at 0.0.0 while the backend said 0.1.0
until this test was written.
"""

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")

FRONTEND = BACKEND_DIR.parent / "app" / "package.json"


def backend_version():
    """Return the version declared in `pyproject.toml`."""
    with (BACKEND_DIR / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)["project"]["version"]


def frontend_version():
    """Return the version declared in `app/package.json`."""
    return json.loads(FRONTEND.read_text())["version"]


def test_the_two_halves_carry_the_same_version():
    assert backend_version() == frontend_version(), (
        "backend and frontend versions have drifted; "
        "`uv run python scripts/bump_version.py <version>` moves both"
    )


def test_the_version_is_semantic():
    assert SEMVER.match(backend_version()), backend_version()


def test_the_running_app_reports_the_declared_version():
    # Not a second constant: the endpoint reads what `pyproject.toml` declares,
    # so packaging metadata and what the app tells the world cannot disagree.
    from version import app_version

    assert app_version() == backend_version()


def test_the_version_endpoint_serves_it(client):
    response = client.get("/api/version")

    assert response.status_code == 200
    assert response.json() == {"version": backend_version()}
