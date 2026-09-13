# Daily tracker

Two things worth recording every day, in one place.

**Wellbeing** — track your satisfaction with work/life/whatever in regular questionaries, then get automated statistics. **Time** — track where your hours go: check in to a project, check out when you stop, and read the week back. **Focus** — a pomodoro timer whose finished blocks can be copied into Time as one session. **Tasks** — lists of what you mean to do, grouped five ways over three layouts, with a calendar and a timer you can start from a task.

## Screenshots

The landing page: the state of each half before you touch it, a way in and a way
to the patterns behind it, and a habit's streak underneath.

![The landing page, with four section cards and a row of habit cards below them](docs/screenshots/landing.png)

Answering: one tap per question, and the next one opens without waiting for the server.

![The questionnaire, showing one question with its scale as a row of tappable bands](docs/screenshots/answering.png)

The record: every answer you have given, days running left to right, with a button to fill in any past or future day.

![The answer table, with one row per question and one column per day](docs/screenshots/record.png)

Patterns: line, radar, correlation, spread and totals views over a window you choose, with a smoothing control that trades daily detail for trend.

![The stats page, plotting several questions over time](docs/screenshots/patterns.png)

Streaks: one row per habit, one cell per period. Green kept it, red did not, and an
outline is a period nobody recorded — which is not the same thing.

![A grid of coloured cells, one row per habit, with the current and best run beside each](docs/screenshots/streaks.png)

Time: projects as check-in cards, several timers at once, and the running one in the browser tab.

![The track view, with two timers running](docs/screenshots/track.png)

The `Day` window on Patterns: one day along the clock, a lane per project, so a meeting inside a work session reads as exactly that.

![A day laid out as a horizontal timeline with one lane per project](docs/screenshots/time-day.png)

Focus: a pomodoro timer with a countdown, an ambient sound, and the day's blocks under it.

![The focus timer mid-block, with the day's finished pomodoros listed below](docs/screenshots/focus.png)


## Installation

To install everything, just build the Dockerfile and run through docker. You may want to set some environment variables:

- `PORT` - the port exposed, by default 8000
- `DB_STORAGE` - Where the sqlite .db file is stored, by default database.db
- `ADMIN_USER` - The username of the initial admin acccount (default: `admin`)
- `ADMIN_PASSWORD` - **Required on a fresh install.** The password of the initial admin account. There is no default: an installation that forgets it fails to start rather than coming up with a guessable administrator. Only consulted while that account does not yet exist.
- `BOOTSTRAP_QUESTION_CATALOGUE` - If you want to bootstrap an initial catalogue of questions as a default (0/1)
- `JWT_SECRET` - **Required.** The key used to sign session tokens. The server refuses to start without one, because a generated key would sign every user out on each restart and give each worker of a multi-worker deployment a different key. Generate one with `python -c 'import secrets; print(secrets.token_urlsafe(48))'`.
- `TOTP_ENCRYPTION_KEY` - **Required.** The key protecting stored two-factor secrets. Deliberately separate from `JWT_SECRET`: rotating the signing key is a routine act that signs everyone out, and if the two were one key it would also destroy every enrolment on the system. Demanded at startup rather than at first enrolment, so a deployment that forgets it fails loudly rather than at the moment somebody is trying to secure their account. Generate one with `python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`. Losing it does not lock anybody out — the enrolments simply stop being recognised, and everyone signs in with their password and enrols again.
- `ACCESS_TOKEN_TTL` - How long a session token stays valid before it has to be refreshed, by default 1h
- `REFRESH_TOKEN_TTL` - How long a user stays logged in without re-entering their password, by default 30d
- `PASSWORD_MIN_LENGTH` - Minimum length of a user password, by default 8
- `LOGIN_MAX_ATTEMPTS` - Failed logins allowed for one username within `LOGIN_LOCKOUT_WINDOW` before further attempts are refused with `429`, by default 5
- `LOGIN_LOCKOUT_WINDOW` - How long a failed login counts against a username, by default 15m. The counter lives in process memory, so a restart clears it
- `DOCS_ENABLED` - Serve `/docs`, `/redoc` and `/openapi.json` (0/1), **off by default**. A deployment that leaves them on publishes its whole API surface to anyone who asks; set it in development, leave it unset in production. Code generation is unaffected either way, because `pnpm api:generate` reads the schema through `app.openapi()` rather than over HTTP

After installation, you want to define the questions that will be answering regularly. Questions are grouped in catalogues and every user has a default catalogue that will be automatically opened when he/she logs in.

## Architecture

`docs/architecture` holds a [LikeC4](https://likec4.dev) model — the three-zone
split of both halves of the codebase, and sequence diagrams for answering a
question, viewing the stats, tracking time and signing in.

```bash
pnpm dlx likec4 start docs/architecture
```

## Development

.. nobody is going to read this far, this section is more for me to remember how to develop in this repository ..

In production one FastAPI process serves both the API and the compiled frontend. For development you run two processes instead, so that each half reloads on its own: the backend on `:8000` and the Vite dev server on `:5173`. **Use `http://localhost:5173` in the browser** — it proxies `/api` to the backend, so there is no CORS setup and no rebuild step between edits.

Prerequisites: [uv](https://docs.astral.sh/uv/) for the backend and [pnpm](https://pnpm.io/) for the frontend.

**Terminal 1 — backend, reloads on every `.py` save:**

```bash
cd backend
uv sync                      # first time only
uv run alembic upgrade head  # first time, and after pulling new migrations
JWT_SECRET=dev-secret ADMIN_PASSWORD=dev-admin-password \
  TOTP_ENCRYPTION_KEY=$(uv run python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
  DOCS_ENABLED=1 uv run fastapi dev
```

`DOCS_ENABLED=1` puts the interactive API documentation back on http://localhost:8000/docs. It is off by default so that a deployment does not publish its API surface; development is the case it exists for.

All three are required. `JWT_SECRET` has no default because a generated one would sign every user out on each restart and give each worker of a multi-worker deployment a different key. `ADMIN_PASSWORD` has none because an installation that forgets it should fail loudly rather than come up with a guessable administrator; it is only consulted when the account does not yet exist. `TOTP_ENCRYPTION_KEY` has none for the same reason as the signing key, and is checked at startup so the failure arrives at a moment somebody can do something about it.

### Losing a second factor

There are no recovery codes, by decision. An ordinary user who loses their phone is cleared by an administrator — **People → Clear second factor**, which also signs them out. An administrator who loses their own phone has nobody above them, so the way back in is a script run where the database lives:

```bash
cd backend && DB_STORAGE=/srv/database.db uv run python scripts/clear_totp.py <username>
```

Against the deployed container, whose runtime image has no shell, override the entrypoint to the interpreter:

```bash
docker compose run --rm --entrypoint /srv/.venv/bin/python app scripts/clear_totp.py <username>
```

It grants nothing new: anybody able to run it already has the database file. What it saves is doing surgery on that file by hand.

The server does not create tables on its own either — starting against an unmigrated database fails with `no such table`, rather than quietly building a schema no migration accounts for. The admin account and the default catalogue *are* created on first start, once the tables exist.

**Terminal 2 — frontend, hot module reloading:**

```bash
cd app
pnpm install                 # first time only
pnpm dev
```

Then open http://localhost:5173 and sign in with `ADMIN_USER` / `ADMIN_PASSWORD` (`admin` / `dev-admin-password` with the command above). Svelte components swap in place without losing page state; the backend restarts on save and the browser picks it up on the next request.

Under `pytest`, [beartype](https://beartype.readthedocs.io/) turns every annotation in
the application's own modules into a runtime assertion, so a function that claims to
return a `Question` and hands back a dict fails in the test that touched it rather than
somewhere downstream. The hook is installed in `tests/conftest.py` and nowhere else:
beartype is a dev dependency, the image is built with `--no-dev`, and a running server
neither imports it nor pays for it. `tests/test_typing.py` fails if the hook ever stops
being installed.

Linting is [ruff](https://docs.astral.sh/ruff/), configured in `backend/pyproject.toml`
and wired to a pre-commit hook that only looks at `backend/`. Install it once with
`pre-commit install`; after that a commit runs `ruff check --fix` over the Python that
changed. Run it by hand with `cd backend && uv run ruff check .`. Beyond the usual
lint rules it enforces the numpy docstrings this repo asks for, with tests exempt.

Useful extras:

```bash
cd backend && uv run pytest    # the API test suite
cd backend && uv run ruff check .   # lint, the same rules the hook applies
cd backend && uv run python scripts/seed_answers.py --days 90   # a history to look at
cd backend && uv run python scripts/seed_time.py --days 30      # and some tracked hours
cd app && pnpm build           # emit the production bundle into backend/static
cd app && pnpm api:generate    # regenerate the typed API client after an endpoint changes
```

### The generated API client

The frontend does not hand-write URLs or field names. `pnpm api:generate` dumps the
backend's own OpenAPI document and generates a typed client into
`app/src/lib/generated/`, which every page calls through. Run it after adding or changing
an endpoint; the generated files are committed, so a clean checkout builds without a
backend running.

Around it sit two small modules worth knowing:

- `src/lib/api.js` holds the session — token storage, one shared refresh when several
  calls hit a 401 together, and turning a FastAPI error body into a sentence naming the
  field that was wrong.
- `src/lib/store.js` holds the data every page needs — the account, catalogues and the
  answer history — loaded once and shared, so moving between pages does not refetch and
  no two views disagree.

### End-to-end tests

Playwright drives a real browser against the app as it ships — one FastAPI process
serving both the API and the built frontend, not the two dev servers.

```bash
cd app
pnpm exec playwright install chromium   # first time only, ~180 MB
pnpm e2e
```

That builds the frontend, migrates a throwaway database at `/tmp/happiness-e2e.db`,
starts a server on port 8123, runs the suite, and shuts everything down. It touches
neither your development database nor a running dev server, so it is safe to run at any
time. It is deliberately not wired into any commit hook — `uv run pytest` is the check
worth running constantly; this one you run when you want it.

```bash
pnpm e2e:ui       # pick and step through tests interactively
pnpm e2e:report   # open the HTML report from the last run
pnpm exec playwright test e2e/answering.spec.js   # one file
pnpm exec playwright test --grep "double tap"     # one test by name
```

A failing run keeps a trace and a video under `app/test-results/`; open the trace with
`pnpm exec playwright show-trace <path>` to step through the failure frame by frame.

Two things the suite pins down deliberately, worth knowing before adding to it: the clock
is set to 2026-06-15 in `Europe/Berlin`, because "today" is computed in the browser and an
unpinned suite fails around midnight — set, not *frozen*, since stopping time also stops
anything that animates from time deltas, and a canvas chart then draws its axes and no
data at all; and each test gets its own freshly created user,
because answers are per-user and that is what keeps tests from seeing each other's data.
Take the catalogue by name rather than "the first one" — the listing is alphabetical, and
a test that creates a catalogue would otherwise change what later tests answer.

Once `pnpm build` has run, `uv run fastapi dev` alone serves the built frontend on `:8000` too, which is the quickest way to check the single-process setup behaves the same as in Docker. Delete `backend/static` to go back to backend-only mode.

## Migrations

The schema is versioned with [Alembic](https://alembic.sqlalchemy.org/), from `backend/`.

**In Docker, migrations apply themselves.** The container runs `alembic upgrade head` before the server starts, so pulling a new image and restarting is all an upgrade takes. Point `DB_STORAGE` at a mounted volume and take a copy of that file before upgrading — SQLite schema changes are applied in place.

**Applying migrations by hand:**

```bash
cd backend
uv run alembic upgrade head     # apply everything outstanding
uv run alembic current          # which revision the database is on
uv run alembic history          # every revision, newest last
uv run alembic downgrade -1     # step one revision back
```

**Writing one after changing a model:**

```bash
cd backend
uv run alembic revision --autogenerate -m "what changed"
```

Read the generated file before committing it. Autogenerate detects tables, columns and indexes, but it does not see data: converting a column's meaning, backfilling a new `NOT NULL`, or splitting a table needs those statements written by hand. It also cannot infer a `downgrade()` for a data change. SQLite cannot `ALTER` most things, so `env.py` sets `render_as_batch=True` and Alembic rewrites the table instead — the generated code will show `batch_alter_table` blocks. That rewrite is a `DROP` and a rename, which is why `env.py` also turns foreign key enforcement off while migrating: with it on, dropping `questions` cascades and takes every answer and option with it. `tests/test_migrations.py` migrates a populated database along the whole chain and fails if any revision loses a row. Apply, then `downgrade` and `upgrade` again to confirm the migration works in both directions before you commit.
