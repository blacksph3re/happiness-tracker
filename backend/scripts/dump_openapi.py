"""Write the OpenAPI document to a file for the frontend code generator.

Run from `backend/`::

    uv run python scripts/dump_openapi.py ../app/openapi.json
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def dump(destination: Path) -> None:
    """Write the application's OpenAPI document to `destination`.

    Parameters
    ----------
    destination : pathlib.Path
        File to write. Parent directories must already exist.
    """
    destination.write_text(json.dumps(main.app.openapi(), indent=2) + "\n")
    print(f"wrote {destination}")


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
    dump(target)
