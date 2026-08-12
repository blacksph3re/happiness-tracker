from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from bootstrap import bootstrap
from config import get_settings
from database import SessionLocal
from routers import answers, auth, catalogues, projects, stats, time, users

STATIC_DIR = Path(__file__).resolve().parent / "static"
"""Directory holding the compiled frontend, produced by `pnpm build` in `app/`."""


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Seed the initial account and catalogue on startup.

    The schema itself is not created here. A database that has not been
    migrated makes startup fail rather than quietly growing tables that no
    migration accounts for; run ``alembic upgrade head`` first.

    Parameters
    ----------
    app : fastapi.FastAPI
        The application being started. Unused.

    Yields
    ------
    None
        Control returns to the server for the lifetime of the application.
    """
    settings = get_settings()
    # Touched here so a missing signing key stops the server on startup rather
    # than surfacing as a 500 on whoever tries to log in first.
    settings.signing_key  # noqa: B018  - the read itself is the check
    with SessionLocal() as db:
        bootstrap(db, settings)
    yield


API_TAGS = [
    {"name": "Auth", "description": "Signing in and renewing tokens. Public."},
    {
        "name": "Account",
        "description": (
            "The signed-in account acting on itself. Never gated on a "
            "permission flag."
        ),
    },
    {
        "name": "Users",
        "description": (
            "Acting on other people's accounts. Requires the user-management "
            "permission."
        ),
    },
    {
        "name": "Catalogue",
        "description": (
            "Catalogues and their questions. Reading is open to everyone; "
            "changing anything requires the catalogue-editing permission."
        ),
    },
    {"name": "Answers", "description": "Recording, reading and exporting answers."},
    {"name": "Stats", "description": "Metadata describing what can be plotted."},
]
"""Tag descriptions, in the order the documentation should present them."""

app = FastAPI(
    title="Happiness Tracker API",
    version=auth.APP_VERSION,
    summary="Track satisfaction with work, life or whatever in regular questionnaires.",
    description=(
        "Every endpoint lives under `/api`. `GET /api/version`, `POST /api/login` "
        "and `POST /api/refresh` are public; everything else needs a bearer token "
        "and answers `401` without one.\n\n"
        "Two independent permission flags govern the rest: `is_admin` for managing "
        "other people's accounts, `is_editor` for catalogues and questions."
    ),
    openapi_tags=API_TAGS,
    lifespan=lifespan,
)

# The answer history is long, repetitive JSON: five years of it compresses by
# roughly a factor of ten, which matters far more than the server-side time.
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(catalogues.router, prefix="/api")
app.include_router(answers.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(time.router, prefix="/api")


class SinglePageApp(StaticFiles):
    """Serve a built single-page app, falling back to its entry document.

    Unknown paths resolve to ``index.html`` instead of a 404 so that routes
    owned by the client-side router survive a full page load. Missing assets
    under the bundler's output directory keep returning 404.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        """Look up `path`, serving the SPA entry document when it is absent.

        Parameters
        ----------
        path : str
            Request path relative to the static directory.
        scope : starlette.types.Scope
            ASGI scope of the incoming request.

        Returns
        -------
        starlette.responses.Response
            The matched file, or ``index.html`` for unmatched non-asset paths.

        Raises
        ------
        starlette.exceptions.HTTPException
            If neither the requested file nor ``index.html`` can be served.
        """
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path.startswith("assets/"):
                raise
            return await super().get_response("index.html", scope)


# Mounted last so that every API route above takes precedence over the SPA.
if STATIC_DIR.is_dir():
    app.mount("/", SinglePageApp(directory=STATIC_DIR, html=True), name="spa")
