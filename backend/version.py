"""The application's version, read from the one place it is declared.

Semantic versioning, and the two halves move **in lockstep**: any change that
ships bumps both `backend/pyproject.toml` and `app/package.json` to the same
number, because they deploy as one image and a build where they disagreed would
be a build nobody could name.

Declared in `pyproject.toml` rather than as a constant here so that the packaging
metadata and the running application cannot drift — there is one number, and this
reads it. `tests/test_version.py` holds the frontend to it, and
`scripts/bump_version.py` moves both at once.
"""

import tomllib
from functools import cache
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent / "pyproject.toml"
"""Where the version is declared. Beside this file, in the image and in the repo."""


@cache
def app_version() -> str:
    """Return the running application's version.

    Read once and cached: the file cannot change under a running process, and
    `importlib.metadata` is not an option because the image installs the
    dependencies without installing the project itself.

    Returns
    -------
    str
        The semantic version, such as ``0.2.0``.
    """
    with PYPROJECT.open("rb") as handle:
        return tomllib.load(handle)["project"]["version"]
