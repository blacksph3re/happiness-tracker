# Daily tracker

Two things worth recording every day, in one place.

**Wellbeing** — track your satisfaction with work/life/whatever in regular questionaries, then get automated statistics. **Time** — track where your hours go: check in to a project, check out when you stop, and read the week back.

Two halves, one login. A landing page puts each of them one tap away; inside either, the navigation is only about that half.

## Screenshots

Answering: one tap per question, and the next one opens without waiting for the server.

![The questionnaire, showing one question with its scale as a row of tappable bands](docs/screenshots/answering.png)

The record: every answer you have given, days running left to right, with a button to fill in any past or future day.

![The answer table, with one row per question and one column per day](docs/screenshots/record.png)

Patterns: line, radar, scatter and box views over a window you choose, with a smoothing control that trades daily detail for trend.

![The stats page, plotting several questions over time](docs/screenshots/patterns.png)

Time: projects as check-in cards, several timers at once, and the running one in the browser tab.

![The track view, with two timers running](docs/screenshots/track.png)

The `Day` window on Patterns: one day along the clock, a lane per project, so a meeting inside a work session reads as exactly that.

![A day laid out as a horizontal timeline with one lane per project](docs/screenshots/time-day.png)

Where the hours went, by project or grouped by tag.

![Hours per project per day, with a share donut and a weekday breakdown](docs/screenshots/time-patterns.png)

## Scores

A catalogue can define a score: a total or an average over the questions you pick,
each with a weight. It behaves like any other question — it appears in the record,
the export and the plots — except that nobody answers it. It is worked out from the
answers every time they are read, so editing a definition applies to everything
already recorded and no stored answer is ever rewritten. By default a day is scored
only when every question feeding it was answered.

The starter catalogue ships with the WHO-5 raw score, defined as ordinary catalogue
data. Scores are edited under **Questions**, below the question list.

## Tracked time

A **project** is anything you want the hours for; a **session** is one check-in and
the check-out that ends it. Both belong to you alone — there is no editor flag and no
shared list.

- **Several timers may run at once.** A "meeting" inside a "work" session is the case
  this is built for, so checking in never closes anything. It also means a day can
  total more than 24 hours: that is what a sum over projects is, and the app says so
  rather than hiding it.
- **A session crossing midnight counts on both days**, split at local midnight. The
  split is worked out when the time is read, so one session stays one row and
  correcting a check-out time is still a single edit.
- **Instants are stored in UTC** with the offset captured at check-in. Durations are
  therefore exact across a daylight-saving change, where local arithmetic would report
  an eight-hour day as seven.
- **A day keeps one clock**, taken from the session that opened it, so every session on
  a day is read and split by the same midnight. Travelling used to leave a day meaning
  two things at once — two sessions both reading 09:00, an hour apart. A session that
  would spill into a day on a *different* clock is kept whole on the day it started and
  marked as such: the two midnights are not the same instant, so dividing there would
  either count an hour twice or lose one.
- **Nothing is auto-closed.** A session running for three days shows up as exactly that
  in the record, where it can be corrected; the app does not invent an end it cannot
  know.
- **A stop can be taken back.** While a project is idle and its last session ended
  today, **Track** offers `Resume`: the old session reopens with its original start, so
  the time it spent stopped counts as worked rather than leaving a hole beside a new
  one. It is deliberately not offered for older sessions — absorbing a day and a half
  is not a mistake anyone means to make.
- **Archiving retires a project from the reports.** Its sessions stay in the record
  and in the export — they happened — but a project nobody tracks any more is not a
  pattern. Deactivating a question does the same on the wellbeing side.
- **One project cannot run twice over the same minutes.** Two projects at once is the
  point of the tracker; the same project twice would report one hour twice under one
  name. An edit that would overlap is refused, and the record offers to merge the two
  into one session — earliest start, latest end — or to discard the change.
- **Tags group projects** on the patterns page. A project can carry several, so tag
  totals overlap rather than partition — they are a way of reading the time, not a
  filing of it. Projects with no tag are reported as *Untagged*, so nothing is hidden.

A tag can carry a **deduction rule**: bands of *from this many tracked minutes, remove
this many*. The highest threshold a day reaches applies, a day with nothing tracked is
never deducted from, and no day goes below zero. It is worked out on read, so changing
the rule fixes last month too. Rules belong to a tag rather than to the account, because
"work days lose a lunch break" is a statement about work — a day of reading owes nobody
one. Edit them under **Projects → Rule**.

**Patterns** steps through named periods — a week, a month, a quarter — rather than a
rolling count of days back from today, so each has a name on the page and a previous to
go to. A month or a quarter is drawn as a line with a smoothing control, because a
quarter of grouped bars is a picket fence.

It also filters: *only days where* narrows the hours by weekday, or by anything the
questionnaire recorded — so "what did the hours look like on days I slept badly" is a
question the two halves answer together. A day with nothing tracked breaks the line
rather than reading as zero hours, which is a toggle.

The shortest window — `Day` — is drawn along a clock rather than as totals: a lane per project, showing *when* rather than how much. It is the only view
where overlap reads as overlap instead of as two numbers that happen to add past 24
hours. The axis fits the hours actually used, with a `Full day` toggle for the whole
24, and the project/tag switch regroups the lanes while each block keeps its own
project's colour.

Sessions are edited, added by hand and deleted in **Record** — a session has `Delete`
on its own row, because the one most often removed is an accidental tap on Track, which
has no times worth correcting. Record also has a
`Merge sessions` toggle: one row per project per day, from the first start to the last
end, showing the time *tracked* rather than the distance between them — so a lunch
break shortens the duration without moving the clock. Projects, colours and tags live
in **Projects**. `Download .xlsx` gives every session on one sheet and the
daily totals per project and per tag on two more.

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
