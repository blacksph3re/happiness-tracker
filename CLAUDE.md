# Daily Tracker

Backend lives in `backend/` — FastAPI, managed with `uv`, SQLAlchemy ORM over SQLite,
Alembic for migrations. Run commands from `backend/` via `uv run ...`.

Frontend lives in `app/` — Svelte 5 SPA on Vite, managed with `pnpm` (there is no `npm`
on this machine). `pnpm build` emits into `backend/static`, which FastAPI mounts and
serves with an `index.html` fallback, so the whole thing ships as one server process.
API routes must be registered before that mount and should live under `/api`.

## Working here

The owner reviews by reading, then by using. Both are served by the same habits:

- **Propose before building anything substantial.** A markdown plan in the repo
  root — database design, an API sketch, the tests you intend, and the open
  questions marked `[assumed: X]` so a silent default is visible as a default.
  Answers come back inline in the file; fold them in and re-issue the document
  before writing code. `TIME_TRACKING_PLAN.md`, `COMPUTED_TOTALS_PROPOSAL.md` and
  `TIMEZONE_PROPOSAL.md` are the pattern.
- **Write the failing test first**, then the fix — stated explicitly, and it has
  caught vacuous tests here more than once.
- **Fix what is obviously wrong; ask about judgement calls.** Changing
  information density, product naming, or which of two defensible numbers a page
  shows is the owner's call, not a detail to decide quietly.
- **Prefer removing.** Deleting answers, the weekday chart on a week, Previous
  and Next on a custom window, the record's Restart button — each was cut on
  request because it did not earn its place. Suggest the cut.
- **Say what was verified and how.** Assertions without evidence get challenged,
  correctly. Screenshots, measurements and reproductions belong in the report.

## Non-functional requirements

Two, both standing, both cheaper to honour from the first commit:

- **Read from the store after the initial load.** Opening a view a second time,
  or switching between windows already seen, must not refetch or show a loading
  state. Entries are cached with the *range* they were loaded for and summaries
  by `(range, grouping)`; mutations update the cache in place and invalidate what
  they touched. `expectSettled()` asserts it.
- **Three zones, imports pointing inward** — see below. A feature that needs
  something from the other half means the thing belongs in the shared zone.

And one principle that has decided more arguments than any rule: **the app never
invents data.** It does not auto-close a session it cannot know the end of, does
not smooth over parallel timers summing past 24 hours, and does not split a
session at a midnight two days disagree about. Where a number needs explaining,
label it — `67h 35m across tags` — rather than quietly changing it.

## Where code goes

The app is two trackers sharing a login, and the code says so. Three zones, and
**imports only ever point inward at the shared one — never across**:

| | Wellbeing | Time | Shared |
| --- | --- | --- | --- |
| Routers | `catalogues.py`, `answers.py`, `stats.py` | `projects.py`, `time.py` | `auth.py`, `users.py` |
| Services | `services/wellbeing.py` | `services/timetrack.py` | `services/__init__.py` re-exports both |
| Routes | `routes/wellbeing/` | `routes/time/` | `routes/` — Landing, Login, Settings, Users |
| Lib | `lib/wellbeing/` | `lib/time/` | `lib/store.js`, `api.js`, `router.js`, `facets.js`, `series.js`, `resource.svelte.js` |

If both halves need something, move it to the shared zone — the move is the
signal it was shared all along. `movingAverage` and the "only days where" facets
both arrived that way. `models.py` stays one file because SQLAlchemy wants one
registry, but keeps the groups visibly sectioned.

The two halves also do not link to each other in the UI. The landing page is the
only bridge, which is what keeps "Record" and "Patterns" unambiguous inside each.

## Styling

Tailwind CSS v4 with Flowbite as the component layer, wired up in `app/src/app.css`
(there is no `tailwind.config.js` — v4 is configured in CSS).

The app defines its own palette in the `@theme` block of `app/src/app.css` and styles
against **those** tokens, not Flowbite's `bg-brand` family: `bg-ink`, `bg-ink-soft`,
`text-paper`, `text-haze`, `bg-dusk`, `hover:bg-dusk-lift`, `border-ember`. Two
utility classes carry the type treatment — `.meta` for labels and metadata, `.numeral`
for anything tabular. Add a token to `@theme` rather than reaching for a raw palette
step like `bg-indigo-600`.

Flowbite v4 dropped the `primary-*` scale used by earlier versions, and a class that
names a token which does not exist produces **no CSS at all** rather than an error —
`bg-primary-700` is silently invisible. After adding a class built on a new token,
confirm it appears in the built stylesheet under `backend/static/assets/`.

Flowbite's interactive behaviour comes from importing `flowbite` in `src/main.js`. It
initialises on load; components rendered later need an explicit `initFlowbite()`.

Three more v4 behaviours worth knowing, each of which cost a debugging session:

- **A class assembled at runtime generates no CSS.** `gap-{SEGMENT_GAP}` compiles to
  nothing, because the scanner only sees literal text. The same applies one layer
  down: `@theme` **tree-shakes** any token no utility mentions, so
  `var(--color-${project.colour})` built from stored data resolves to empty. The
  theme block is therefore `@theme static`, which emits every variable regardless.
- **A whole section can be re-themed by rebinding variables.** `bg-dusk` compiles to
  `background-color: var(--color-dusk)`, so `.section-time` redefines the accent
  tokens and everything inside recolours with no second set of class names. The
  corollary: a token used for *data* — a project's stored colour — must not be one a
  section rebinds, or two projects collapse to the same colour in there.
- **v4 leaves buttons on the browser's default cursor.** `app.css` restores
  `cursor: pointer` for enabled buttons app-wide.

Hover has one answer per kind of control, listed at the top of `app.css`: outlined
→ `border-white/40`, destructive → `border-ember`, filled → `bg-dusk-lift`, card →
`border-white/30` with `bg-dusk/10`, tinted band → `brightness-125`. Do not reach for
a `brightness` filter on anything else: it is active under the cursor at the moment of
a click, so it fights the state change it is supposed to accompany.

## Loading data in a component

A component **reads** data; it does not own the state of fetching it. Anything
that loads when reactive state changes goes through `resource()` in
`app/src/lib/resource.svelte.js`:

```js
const summary = resource(
  () => ({ start, end, by }),        // the only dependency
  (query) => ensureSummary(query),   // called untracked
  { name: 'time summary' }
)
const rows = $derived(summary.data ?? [])
```

The reason is a bug this app shipped. An `$effect` that reads state it also
writes re-triggers itself; Svelte catches that and throws
`effect_update_depth_exceeded` — **but only when the write is synchronous**.
Write after an `await` and the depth counter has reset by the time it lands, so
the effect loops forever with no error at all and the tab stops painting.

`resource()` closes both halves: its effect reads only the query and writes only
its own outputs, so a component holding one has nothing to feed back; and it
throws by name if it re-runs more than twenty times in a second, which is what a
cycle it cannot prevent looks like. `expectSettled()` in `app/e2e/fixtures.js`
asserts the same thing from outside — no endpoint refetched, page still
answering.

Do not write `$effect(() => load(...))` where `load` assigns component state.

## Derived values are computed on read, never stored

Scores over questions, deduction bands over tags, the midnight split, tag
grouping, a day's clock — none of these are written to the database. The reason
is the same every time: a stored derivation can disagree with the definition it
came from, and a definition change should be retroactive. Editing a score's
components fixes last month; so does editing a lunch-break band.

The corollary is that the **server computes it once** and the client reads the
result. `/api/time/summary` does the split and the grouping so the screen and
the exported CSV cannot drift. The client mirrors `slices()` only to *draw* a session
across two days without a round trip per day — never to report a number.

`answers` and `time_entries` hold what happened. Anything else is a view.

## Days, instants and offsets

The two halves record time differently, on purpose:

- **An answer** carries a client-local `day` and `local_hour`. The browser knows
  which day it is; the server stores what it is told.
- **A session** carries UTC instants plus the `utc_offset` in force at check-in.
  Durations come from the instants, so they stay exact across a daylight-saving
  change where local arithmetic reports an eight-hour day as seven.

Three rules follow, and they are easy to get subtly wrong:

1. A session's **own** offset decides which local day it belongs to.
2. A **day** takes its clock from the session that opened it, so every session on
   it reads and splits by one midnight. Without this a day means two things at
   once after a flight.
3. A session spilling into a day on a *different* clock is kept whole on the day
   it started. The two midnights are not the same instant, so splitting there
   would either invent an hour or lose one.

A fixed offset is not a timezone: a session spanning the change reads an hour out
on the far side. `TIMEZONE_PROPOSAL.md` records what storing an IANA zone name
would fix and what it would cost.

## Migrations

SQLite cannot alter a column in place, so `env.py` sets `render_as_batch=True`
and Alembic rewrites the table: copy, **`DROP`**, rename. The app enforces
foreign keys on every connection, and that `DROP` cascades — a migration that
merely narrowed a column silently deleted every answer and every option in this
database. `env.py` now disables foreign keys for the migration connection, via a
`connect` listener on the raw DBAPI connection: issued through SQLAlchemy the
pragma opens a transaction, where SQLite ignores it *and* Alembic's commit is
swallowed, so the schema advances without a version stamp.

`tests/test_migrations.py` seeds a database at the first revision and walks the
whole chain, failing if any revision loses a row. Run it before trusting a new
migration, and hand-write anything autogenerate cannot express — check the
generated file, since it does not see data.

## Verifying a change

- **A test that has never failed has not been shown to test anything.** Two tests
  here passed against broken code: one used a full page reload, which hid the
  store bug it was written for; another swiped in the direction where nothing
  could move. Break the fix, watch the test fail, put it back.
- **Playwright clicks an element's centre.** A card whose only dead region was
  the control users aim at passed every click test. Assert hit targets by
  *position* (`page.mouse.click(x, y)`) when the claim is "all of this is
  clickable".
- `getByLabel` matches substrings — a field labelled `Ended time` also matches
  its `Ended time 5 minutes later` stepper. Pass `{ exact: true }`.
- **The e2e clock is set, not frozen.** Freezing stops anything animating from a
  time delta, and a canvas chart then draws its axes and no data at all. Use
  `page.clock.setSystemTime` and `fastForward`.
- **Screenshot the element, not the page,** when judging a detail. A full-page
  capture scaled to fit is too coarse to tell which button is highlighted — twice
  I reported a bug that was not there. Crop, or read `aria-pressed`.
- **Computed styles sampled during a transition are interpolated.** Wait for it to
  settle before believing a colour.
- **When synthetic data cannot reproduce a report, use the real database.** Copy
  `database.db`, reset the password on the *copy*, serve it on another port. A
  freeze that no generated fixture could produce reproduced on the first try.

## Settled decisions

Do not re-open these without being asked to; each was decided deliberately.

| | |
| --- | --- |
| Secrets | `JWT_SECRET` and `ADMIN_PASSWORD` have no defaults. The server crashes without them rather than generating one |
| Login attempts | 5 failures per username per 15 minutes, counted in process memory and cleared by a restart. Keyed on the **submitted username**, never the client IP — the app sits behind nginx and does not trust proxy headers, so every request would otherwise share one key. A locked username answers `429` whether or not the account exists |
| Schema | The server never creates tables. An unmigrated database fails with `no such table` |
| Deployment | A VM behind nginx doing SSL and a second auth layer. **The domain is an environment variable, never in the repo** |
| Answers | Never rewritten, never deleted — there is no delete endpoint. A session, by contrast, is corrected and deleted freely |
| Scores | Over scaled questions only; an enum has no numeric value to contribute |
| Projects and tags | Per user. Sharing is a later feature |
| Deduction rules | On a tag, not on the account — a day of reading owes nobody a lunch break. A tag with a rule shows **reported time only** — except the Patterns group table, which keeps tracked beside reported |
| Parallel timers | Several projects at once, yes. The same project twice over the same minutes, no |
| Long sessions | Never auto-closed, no warning. A multi-day session is a hand-editing job |
| Navigation | The landing page is the only bridge between the halves; neither links to the other |
| Beartype | Test-time only. The image is built `--no-dev` and a running server never imports it |
| Ruff | Backend only, via pre-commit. Lint rules, plus the numpy docstrings below |

## Docstrings

**Python only.** Every class, method, property, and function outside of tests must
carry a [numpy-style](https://numpydoc.readthedocs.io/en/latest/format.html)
docstring. This applies to new code and to any existing code you touch.

JavaScript, Svelte and CSS on display components do not need blanket documentation. Comment the parts that
are not obvious from reading them — a workaround, a non-local invariant, a reason
something is done the slow way — and leave the self-evident alone. Core frontend logic such as the store requires blanket documentation to facilitate reading.

- Start with a one-line summary in the imperative mood, then an optional free-form
  description after a blank line.
- Document arguments under `Parameters`, results under `Returns` (or `Yields` for
  generators), and raised exceptions under `Raises`. Omit a section when it does not
  apply — a summary line alone is sufficient for a function that takes and returns
  nothing meaningful.
- Do not document `self` or `cls`.
- Never use a class-level `Attributes` section. Document each attribute with its own
  docstring on the line directly below its declaration, so the description sits next to
  the definition it describes. The class docstring stays a short summary of the whole.
- Test functions are exempt; give them descriptive names instead.

Attribute example:

```python
class User(Base):
    """A person who records happiness entries."""

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    """Unique, indexed address identifying the user."""
```

Function example:

```python
def score_entry(rating: int, weight: float = 1.0) -> float:
    """Scale a raw happiness rating by its weight.

    Parameters
    ----------
    rating : int
        Raw rating on a 1-10 scale.
    weight : float, optional
        Multiplier applied to the rating, by default 1.0.

    Returns
    -------
    float
        The weighted score.

    Raises
    ------
    ValueError
        If `rating` falls outside the 1-10 range.
    """
```
