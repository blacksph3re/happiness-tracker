"""Move both halves of the application to one new version.

    uv run python scripts/bump_version.py 0.3.0

The two are in lockstep by rule — they ship as one image — so there is one
command that moves them rather than two files to remember. `tests/test_version.py`
fails if they ever disagree, which is what makes the rule more than a habit.

Deliberately does not commit, tag, or guess the next number. What kind of change
just happened is a judgement nobody should delegate to a script: on 0.x a feature
is a minor bump and a fix is a patch, and only the person who wrote it knows
which it was.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
"""The repository root, two levels above `backend/scripts/`."""

PYPROJECT = ROOT / "backend" / "pyproject.toml"
"""Where the backend declares its version, and where the app reads it at runtime."""

PACKAGE_JSON = ROOT / "app" / "package.json"
"""Where the frontend declares its version, and where Vite reads it at build time."""

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def bump(version: str) -> None:
    """Write `version` into both halves.

    Parameters
    ----------
    version : str
        The new semantic version, such as ``0.3.0``.

    Raises
    ------
    SystemExit
        If `version` is not a semantic version, or either file does not hold a
        version line where one is expected — better to stop than to write a
        half-bumped pair.
    """
    if not SEMVER.match(version):
        raise SystemExit(f"{version!r} is not a semantic version, like 0.3.0")

    toml = PYPROJECT.read_text()
    updated, count = re.subn(
        r'^version = "[^"]+"$', f'version = "{version}"', toml, count=1, flags=re.M
    )
    if count != 1:
        raise SystemExit(f"no version line found in {PYPROJECT}")

    package = json.loads(PACKAGE_JSON.read_text())
    if "version" not in package:
        raise SystemExit(f"no version key found in {PACKAGE_JSON}")
    package["version"] = version

    PYPROJECT.write_text(updated)
    # Two spaces and a trailing newline, which is how the file is already
    # written; a reformat here would be noise in every version bump's diff.
    PACKAGE_JSON.write_text(json.dumps(package, indent=2) + "\n")
    both = f"{PYPROJECT.relative_to(ROOT)} and {PACKAGE_JSON.relative_to(ROOT)}"
    print(f"{both} → {version}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: bump_version.py <version>")
    bump(sys.argv[1])
