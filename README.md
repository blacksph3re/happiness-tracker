# Happiness tracker

Track your satisfaction with work/life/whatever in regular questionaries, then get automated statistics.

## Screenshots

Answering: one tap per question, and the next one opens without waiting for the server.

![The questionnaire, showing one question with its scale as a row of tappable bands](docs/screenshots/answering.png)

The record: every answer you have given, days running left to right, with a button to fill in any past or future day.

![The answer table, with one row per question and one column per day](docs/screenshots/record.png)

Patterns: line, radar, scatter and box views over a window you choose, with a smoothing control that trades daily detail for trend.

![The stats page, plotting several questions over time](docs/screenshots/patterns.png)

## Installation

To install everything, just build the Dockerfile and run through docker. You may want to set some environment variables:

- `PORT` - the port exposed, by default 8000
- `DB_STORAGE` - Where the sqlite .db file is stored, by default database.db
- `ADMIN_USER` - The username of the initial admin acccount (default: `admin`)
- `ADMIN_PASSWORD` - **Required on a fresh install.** The password of the initial admin account. There is no default: an installation that forgets it fails to start rather than coming up with a guessable administrator. Only consulted while that account does not yet exist.
- `BOOTSTRAP_QUESTION_CATALOGUE` - If you want to bootstrap an initial catalogue of questions as a default (0/1)
- `JWT_SECRET` - **Required.** The key used to sign session tokens. The server refuses to start without one, because a generated key would sign every user out on each restart and give each worker of a multi-worker deployment a different key. Generate one with `python -c 'import secrets; print(secrets.token_urlsafe(48))'`.
- `ACCESS_TOKEN_TTL` - How long a session token stays valid before it has to be refreshed, by default 1h
- `REFRESH_TOKEN_TTL` - How long a user stays logged in without re-entering their password, by default 30d
- `PASSWORD_MIN_LENGTH` - Minimum length of a user password, by default 8

After installation, you want to define the questions that will be answering regularly. Questions are grouped in catalogues and every user has a default catalogue that will be automatically opened when he/she logs in.

## Development

In production one FastAPI process serves both the API and the compiled frontend. For development you run two processes instead, so that each half reloads on its own: the backend on `:8000` and the Vite dev server on `:5173`. **Use `http://localhost:5173` in the browser** — it proxies `/api` to the backend, so there is no CORS setup and no rebuild step between edits.

Prerequisites: [uv](https://docs.astral.sh/uv/) for the backend and [pnpm](https://pnpm.io/) for the frontend.

**Terminal 1 — backend, reloads on every `.py` save:**

```bash
cd backend
uv sync                      # first time only
uv run alembic upgrade head  # first time, and after pulling new migrations
JWT_SECRET=dev-secret ADMIN_PASSWORD=dev-admin-password uv run fastapi dev
```

Both variables are required. `JWT_SECRET` has no default because a generated one would sign every user out on each restart and give each worker of a multi-worker deployment a different key. `ADMIN_PASSWORD` has none because an installation that forgets it should fail loudly rather than come up with a guessable administrator; it is only consulted when the account does not yet exist.

The server does not create tables on its own either — starting against an unmigrated database fails with `no such table`, rather than quietly building a schema no migration accounts for. The admin account and the default catalogue *are* created on first start, once the tables exist.

**Terminal 2 — frontend, hot module reloading:**

```bash
cd app
pnpm install                 # first time only
pnpm dev
```

Then open http://localhost:5173 and sign in with `ADMIN_USER` / `ADMIN_PASSWORD` (`admin` / `dev-admin-password` with the command above). Svelte components swap in place without losing page state; the backend restarts on save and the browser picks it up on the next request.

Useful extras:

```bash
cd backend && uv run pytest    # the API test suite
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
is fixed to 2026-06-15 in `Europe/Berlin`, because "today" is computed in the browser and
an unpinned suite fails around midnight; and each test gets its own freshly created user,
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

Read the generated file before committing it. Autogenerate detects tables, columns and indexes, but it does not see data: converting a column's meaning, backfilling a new `NOT NULL`, or splitting a table needs those statements written by hand. It also cannot infer a `downgrade()` for a data change. SQLite cannot `ALTER` most things, so `env.py` sets `render_as_batch=True` and Alembic rewrites the table instead — the generated code will show `batch_alter_table` blocks. Apply, then `downgrade` and `upgrade` again to confirm the migration works in both directions before you commit.

## Catalogue

There are three types of questions
- Enum: A set of values that have no numeric correlation (Male/Female, Yes/No, Apples/Pears/Bananas, ...)
- Discrete: Discrete values that have a scale, an order is assumed (1/2/3/4/5). They have a lower and upper bound with a description (low/high), increment is always 1.
- Continuous: Continuous values that have a scale. They have a lower and upper bound with a description but no increments.

Furthermore, there are some answers that are always tracked automatically per day, if the user answered any questions:
- Weekday (enum: Mon … Sun)
- Day of the year (discrete)
- Month (enum: Jan … Dec)
- Year (discrete)
- Hour of the day when the first question was answered (discrete)

These are not plotted as variables of their own — weekday over time is a sawtooth, and weekday as a radar spoke means nothing. They appear in the stats page under "Only days where" instead, so they subset the data behind the other plots: weekends only, winter months only, and so on. Several can be combined, and they are still shown in the answer table and the .xlsx export.

The default catalogue is the [WHO-5 Well-Being Index](https://www.corc.uk.net/outcome-measures-guidance/directory-of-outcome-measures/the-world-health-organisation-five-well-being-index-who-5/), reproduced verbatim so answers stay comparable with the published instrument. All five are discrete questions on the WHO-5's own six-point scale, from 0 "At no time" to 5 "All of the time":

- I have felt cheerful and in good spirits
- I have felt calm and relaxed
- I have felt active and vigorous
- I woke up feeling fresh and rested
- My daily life has been filled with things that interest me

Note that the WHO-5 is validated over a two-week recall window. Answering it daily is an adaptation: your own trend over time is meaningful, but the published clinical cut-offs do not apply to a single day's score.

Questions are edited in the question catalogue edit page. This supports some fundamental options
- Add new question
- Add an enum option
- Change bounds/descriptions for a discrete/continuous action.
- Deactivate a question - it will no longer be displayed in the questionnaire.

In general, all changes to the question catalogue will never modify previous answers.

## User management

The admin user is the only user in the system that can create or delete users. Every user has a username + password and a default catalogue.

The landing page for every user, given it is still logged in, is directly the first question for the day. The user can start answering right away. There is also an option to get to the menu (top right stacked bar button) where the user can select its default catalogue, see stats or change the password. When all questions of the day are answered, it is automatically forwarded to the stats page.

## Question answering

Question answering is as seemless as possible. On tall screens, questions are arranged vertically, on wide screens horizontally. It requires exacly one interaction to answer one question (e.g. drag the continuous slider, click a discrete/enum value) to answer a question, after which the next one is opened after a short flip-page animation. With a back/forth button, questions can be skipped or answers corrected. By default, the questions for the current day are answered. Through the answer table, a past or future day can also be selected and questions can be answered or updated for other days

## Answer table

This is just a tabular display of the answers. The user can see each exact answer it gave. The table scrolls along the x axis for days.

Furthermore, a .xlsx download is available.

## Stats page

The main point of the app is to track mental KPIs over time. The job of the stats page is to display these stats. There are multiple views
- Simple line plots over time for each discrete/continuous variable
- Radar charts for every discrete/continuous variable
- Scatter plots that show correlation between any two variables
- Boxplots that show distribution of variables across timespans (weeks, months, ...)

Every plot that does not have a time axis allows to be smoothely animated across time through a time slider at the top of the corresponding stats page.

## Non-functional requirements

- The app is fully responsive
- No server call is required between questions, only at initial page load the whole catalogue is loaded into the frontend. 
- Answers are directly submitted through PUT at click but the server confirmation is not awaited before continuing user interaction
- Failed backend requests are displayed to the user with a toast.
- The backend stores passwords securely, they are never logged
- Every endpoint except for /version and /login require a valid JWT. This is asserted with a test for every endpoint that passes correct inputs but an invalid JWT.
- The system is performant enough to render question tracking over multiple years
- We expect a relatively low number of questions per catalogue (ca 10), design the UI for this amount.

