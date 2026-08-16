"""Container entrypoint: bring the schema up to date, then serve.

This exists because the runtime image is distroless. There is no shell to chain
``alembic upgrade head && uvicorn ...`` with, and none to expand ``${PORT}``, so
both steps are done here in Python instead.
"""

import os

import uvicorn
from alembic.config import Config

from alembic import command


def main() -> None:
    """Apply outstanding migrations, then serve the API and the built frontend.

    Migrations run in-process rather than as a separate container step: the
    application refuses to start against an unmigrated database, so the two are
    ordered here rather than left to whoever writes the deployment command.
    """
    command.upgrade(Config("alembic.ini"), "head")
    uvicorn.run(
        "main:app",
        host="0.0.0.0",  # noqa: S104 - bound inside the container, published on loopback
        port=int(os.environ.get("PORT", "8000")),
    )


if __name__ == "__main__":
    main()
