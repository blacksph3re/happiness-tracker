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
  before writing code. `CATALOGUE_OWNERSHIP_PROPOSAL.md` is the pattern.

  These are working documents and most are deleted once the work lands, so
  **anything in one that is still true afterwards belongs here instead**. Do not
  leave a rule pointing at a proposal: several passages in this file used to cite
  `TIME_TRACKING_PLAN.md`, `COMPUTED_TOTALS_PROPOSAL.md`, `TIMEZONE_PROPOSAL.md`
  and `SYNC_FRESHNESS_PROPOSAL.md`, and every one of those files is gone.
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
- **Mutate the fix to prove the test.** Not just "watch it fail once": break each
  load-bearing behaviour in turn and confirm a *named* test fails for it. Five
  such probes on the pomodoro rules caught nothing, which is the point — the run
  is what makes the suite evidence rather than decoration.
- **Format only what you touched.** `ruff format .` also reformats pre-existing
  drift across the repo — five hundred lines of line-joining in old migrations
  and scripts, mixed into a diff that was supposed to be reviewable. Name the
  files. If unrelated churn does creep in, `git diff -w --ignore-blank-lines`
  tells you which files are cosmetic-only so they can be reverted.

## Non-functional requirements

Two, both standing, both cheaper to honour from the first commit:

- **Read from the store after the initial load, and never wait on a refetch.**
  Opening a view a second time, or switching between windows already seen, must
  paint from the store immediately. A request on navigation is allowed — that is
  how a change made on another device arrives — but nothing may *wait* for one,
  and `loading` may only be true when there is nothing to show. Entries are
  cached with the *range* they were loaded for and summaries by
  `(range, grouping)`; mutations update the cache in place and invalidate what
  they touched. `expectSettled()` asserts the no-loop half, `e2e/sync.spec.js`
  the no-waiting half.

  The rule used to be the stricter "must not refetch", asserted as *zero* API
  calls across a navigation. It was relaxed deliberately: forbidding the request
  was only ever a proxy for forbidding the wait, and it made a stale tab
  unfixable without a reload.

  `lib/revalidate.js` now asks `GET /api/changes` what moved and re-reads only
  that. The digest fingerprints each collection as a row **count and**
  `max(updated_at)`, because neither alone sees every change: a timestamp cannot
  see a deletion, since the deleted row takes its own with it, and a count cannot
  see an edit. It runs on navigation, visibility, focus, reconnect and a 30s tick
  that shares `PROBE_EVERY` with the offline probe — exactly one of the two
  applies at a time. A floor of 10s between checks, measured from when a check
  *finished*, is what stops a slow connection stacking them.

  A component must therefore **read its data from the store**, not snapshot it
  out of a loader. `x = await ensureX()` into local state cannot see a later
  update, which is the whole point — `await ensureX()` to start the load, and
  `$derived($xStore)` to read it.
- **Three zones, imports pointing inward** — see below. A feature that needs
  something from the other half means the thing belongs in the shared zone.

And one principle that has decided more arguments than any rule: **the app never
invents data.** It does not auto-close a session it cannot know the end of, does
not smooth over parallel timers summing past 24 hours, and does not split a
session at a midnight two days disagree about. Where a number needs explaining,
label it — `67h 35m across tags` — rather than quietly changing it.

## Where code goes

The app is three trackers sharing a login, and the code says so. Four zones, and
**imports only ever point inward at the shared one — never across**:

| | Wellbeing | Time | Focus | Shared |
| --- | --- | --- | --- | --- |
| Routers | `catalogues.py`, `answers.py`, `stats.py` | `projects.py`, `time.py` | `pomodoro.py` | `auth.py`, `users.py`, `admin.py`, `changes.py`, `sync.py` |
| Services | `services/wellbeing.py` | `services/timetrack.py` | `services/pomodoro.py` | `services/clock.py`; `services/__init__.py` re-exports all |
| Routes | `routes/wellbeing/` | `routes/time/` | `routes/pomodoro/` | `routes/` — Landing, Login, Settings, Users |
| Lib | `lib/wellbeing/` | `lib/time/` | `lib/pomodoro/` | `lib/store.js`, `api.js`, `router.js`, `clock.js`, `period.js`, `Swimlanes.svelte`, `facets.js`, `series.js`, `format.js`, `resource.svelte.js` |

Focus is the newest and shows the rule working: it needs `saveEntry` and
`projects`, both already exported from the shared `store.js`, so importing
*those* points inward rather than across and the time zone is never touched.
`local_day` moved to `services/clock.py` the moment a pomodoro also had to
decide which local day a UTC instant lands in.

The frontend has made the same move twice, and both were overdue rather than
new. **`lib/clock.js`** holds the generic half of what was `lib/time/duration.js`
— formatting a duration, reading a wall clock out of an instant and an offset,
`fromLocal`, `nowUtc`. `store.js`, the landing page and every pomodoro view were
reaching *across* for those, which is the tell. What stayed in
`lib/time/duration.js` is genuinely about sessions: `elapsed`, `startingDay`,
`dayOffsets`, `slices`. **`lib/Swimlanes.svelte`** is the other: one lane per
project, one lane per day and the focus strip are all the same component now.
What they share is not the drawing — that part is easy — but the axis thinning
and the pointer label, which is a pin/dismiss machine with three global
listeners and a phone caveat behind each one. **`lib/period.js`** followed for
the same reason: named windows are calendar work, not session work.

Because the component takes an axis rather than owning one, a caller can hand
it a *relative* window. The focus strip does: two hours per lane, each labelled
by the clock time it opened. A whole working day on one axis made a 25-minute
block a few pixels wide, which is a picture of nothing.

Two rules there are worth keeping straight, because they are easy to conflate.
A pomodoro joins a lane on its **start** — inside the two hours, it belongs to
that lane however far past the mark it runs. The **axis** then stretches to the
furthest any lane reaches, for every lane at once, so the rows stay comparable
and nothing is drawn clipped. Breaking on a count instead produces the same
number of lanes in the obvious test case and a different composition, which is
why the test asserts which pomodoro sits in which lane rather than how many
lanes there are.

If both halves need something, move it to the shared zone — the move is the
signal it was shared all along. `movingAverage` and the "only days where" facets
both arrived that way. `models.py` stays one file because SQLAlchemy wants one
registry, but keeps the groups visibly sectioned.

The three halves also do not link to each other in the UI. The landing page is
the only bridge, which is what keeps "Record" and "Patterns" unambiguous inside
each — and it is the rule that gets tested first by anything new. Focus writes a
session into Time and still may not link there.

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

**Equal padding does not make equal buttons.** Four controls in a question card
all carried `py-2` and came out three different heights, because their contents
did not: an arrow glyph, a 20px icon and `.meta` text have different line boxes.
The row is `items-stretch`, which is what makes the padding decide. `e2e/mobile.spec.js`
asserts the heights are one value, at phone width, by measurement.

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

## Two writes in one gesture go in one queue entry

`enqueue` starts a `flush`, and a `flush` already in flight **read the queue
before your second intent was on it** — `settle()`'s docstring has said so for a
while, but the consequence is easy to miss from the calling side. A second
`enqueue` in the same breath therefore sits in the outbox until the next wake
event, up to `PROBE_EVERY` later.

Anything that means *one* user action uses `enqueueAll` — `saveEntries`,
`savePomodoros`. Starting a pomodoro during a break is exactly this shape: it
ends one and begins another, and queued separately the second silently did not
reach the server. It passed alone and failed under a full parallel run, which is
the only reason it was found.

## A write that reads server state drains the queue first

`settle()` exists for the caller that has to know the server *has* something,
and there are two: an import reporting how many sessions it wrote, and the
pomodoro transfer. The transfer asks the server which pomodoros are still
uncopied, so one sitting in the outbox is one it will not copy — the button
would quietly leave that hour behind while reporting success on the rest.

It costs nothing when the queue is empty, so `await settle()` in front of such a
write is insurance rather than a trade.

## Sound is measurable, so measure it

Three defects shipped here in a row, each found by arithmetic rather than by
listening, and none of them visible in the code:

- **A clamped random walk is a square wave.** Brown noise is a *leaky* integral,
  `(last + 0.02 * white) / 1.02`. Drop the divisor and it wanders past ±1, and
  the clamp railed **99.4%** of samples.
- **An equal-gain crossfade loses 3dB in the middle.** Two uncorrelated signals
  faded across each other with weights `t` and `1-t` have combined power
  `t² + (1-t)²`, which halves at the midpoint. Once per loop that is an audible
  breath — measured at a steady −2.9dB for white, and reported as "pulsating".
  The loop is closed by subtracting the straight line between its two ends
  instead, which costs no level at all. White needs no treatment: consecutive
  samples are already unrelated.
- **Peak normalisation hands the level to one outlier**, and leaves two kinds of
  noise at unrelated loudness. RMS is what a listener hears.

`sounds.test.js` measures railing, the seam against the buffer's own steps, and
window RMS where the fade used to be. Each fails when its defect is put back.

## An audio context must be created inside a gesture

The chime at the end of a focus block did not play, and the phase logic was only
half of why. A browser refuses to start an `AudioContext` outside a user
gesture, and a quiet pomodoro's *first* sound is its chime — twenty-five minutes
after the only tap there was. Created then, the context arrives suspended and
stays that way, silently. `unlockAudio()` runs on Start and plays a one-frame
silent buffer, which is what actually moves iOS out of `suspended`.

The other half: `running` goes undefined the moment a pomodoro finishes, so a
phase read off it can never observe the end. `done` has to be a phase like any
other, or the last boundary is the one that never rings.

## Two numbers on one screen must come from one place

The transfer button read its figure back from the server while the totals above
it were computed on the device. The two answered slightly different questions —
one excluded pomodoros already copied — and so showed different durations a few
lines apart. Even once the rules agreed, the server round trip left the button a
beat behind the totals.

The fix was not to reconcile them but to delete one: the button is handed the
same value the totals display. `GET /api/pomodoros/transfer` existed only to
answer "what is left to copy", a question that no longer exists, so it went too.

Where a number genuinely cannot be the same — the transfer excludes a running
pomodoro, because a session needs an end — **say so on the screen**. That is the
house rule about `67h 35m across tags`: label it rather than quietly changing it.

## A shared one-second tick is not a stopwatch

`lib/time/tick.js` fires on an interval that began whenever something first
subscribed, which has nothing to do with when a timer started. Press Start 900ms
into that interval and the countdown sits on its opening value for nearly two
seconds — reported as "the first second feels longer than a second", and it was.
A countdown schedules its own timeout against its own `started_at`.

Doing that safely means the effect writing the aligned clock must not depend on
anything derived from it. It first did — the clock decided which pomodoro was
running, which decided what the effect watched — which is the feedback loop
`resource()` exists to prevent. The partition reads the shared tick; only the
countdown reads the aligned one.


## Everything belongs to somebody

Answers, projects, tags, deduction bands, preferences, catalogues and their
questions: every row in this database has an owner, and **another account's
anything answers 404** — not 403, because whether it exists is not that caller's
business either.

The one flag left is `is_admin`, for managing accounts. There is no permission
for editing questions, because a catalogue belongs to whoever answers it and
shaping your own tracker is not administration.

Two things to know when the next thing becomes owned, both of which bit here:

- **Scope the resolver, not the handlers.** `_get_catalogue`, `_get_question` and
  `_get_score` each take the owner and filter on it, so twelve endpoints inherit
  the check by construction. Twelve separate checks is twelve chances to forget
  one.
- **Anything that resolves a bare id is an authorization hole the moment the row
  has an owner.** None of it looks like a bug beforehand: while the thing is
  global there is nothing to check, so the absence reads as correct. The two
  found last time were the sync queue's `answer.put`, which validated the
  *shape* of an answer but never whose question it named, and
  `PUT /me/default-catalogue` — self-service, which is exactly why it did not
  look like part of the sweep, and which would have let an account point its own
  questionnaire at somebody else's questions.

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

`answers`, `time_entries` and `pomodoros` hold what happened. Anything else is a
view.

A pomodoro is the sharpest case: its state is `ended_at ?? started_at + focus +
break` compared against the two phase lengths, so **the three outcomes are
derived and there is no `outcome` column**. That is not tidiness — it is what
makes "completes at its planned end" free of any scheduler, and what makes
retrospective editing need no special handling, since correcting a time re-reads
the state. Only the phase *lengths* are stored, and deliberately: changing the
mode from 25/5 to 50/10 is not a claim about yesterday.

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
on the far side. Storing an IANA zone name instead would fix that, at the cost of
resolving a zone on every read and of deciding what a session means when a zone's
rules change under it — considered, and deliberately not done.

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

### Which changes rebuild the table

"Adding a column is safe" is the **wrong** rule, and a migration docstring here
asserted it for a while. The right one:

> A **nullable column with no server default** is added in place. Anything
> else — `NOT NULL`, a non-constant default such as `CURRENT_TIMESTAMP`, a
> changed constraint, a changed nullability, a dropped column — sends the batch
> context down the rebuild path.

SQLite refuses `ADD COLUMN NOT NULL DEFAULT (CURRENT_TIMESTAMP)` because it
requires a *constant* default, and Alembic quietly falls back to recreating the
table. That is how a six-table `updated_at` migration nearly rebuilt half the
schema; making the column nullable turned it into six in-place adds instead, and
the nulls cost nothing because the reader already treats "no timestamp" as
"compare on the count".

**Measure it rather than reasoning about it.** SQLite leaves a table's
`sqlite_master.rootpage` alone for an in-place add and moves it for a rebuild:

```sql
SELECT name, rootpage FROM sqlite_master WHERE type = 'table';
```

Run it either side of `alembic upgrade`. Identical means in place; changed means
the table was rebuilt. Confirm the check itself against a table you know was only
added to, or a coincidence reads as proof.

### Writing a data migration

Cloning rows is the easy half. What loses history is **repointing**: anything
naming a row by id — `answers.question_id` *and* `answers.option_id` — has to
move with it, and a half-repointed row is silently wrong rather than an error.

Three rules, each learned by hitting it:

- **Cascades do not fire.** Foreign keys are off for the migration connection, so
  deleting a parent orphans its children rather than removing them. Delete
  explicitly, deepest first.
- **Guard the destructive step.** Before deleting anything, count what still
  references it and raise if the answer is not zero. Nothing else will stop it,
  and the damage is silent. A migration that refuses to run beats one that
  half-succeeds.
- **A constraint swap comes before the data that would violate the old one.** A
  clone carrying its original's name cannot be inserted while a global unique on
  that name still stands, so the swap is phase one, not phase three.

An inline column-level `UNIQUE` is reported by SQLite without a name, so there is
nothing to write `drop_constraint` against. Hand `batch_alter_table` a
`copy_from=` table description that simply omits it: the new table is built from
that description plus the operations applied, so a constraint in neither is gone.

### Before it touches the real database

**Rehearse against a copy of production.** Pull the newest dump, run
`alembic upgrade head` against it locally, and read the result back — row counts
per table, `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, and whatever
invariant the migration is supposed to establish. Then boot the ORM against the
migrated copy, because a schema the models cannot map is a healthy container
serving 500s. Delete the copy afterwards: it holds password hashes and encrypted
TOTP secrets.

Take a fresh `happiness-dump` on the server immediately before deploying, under a
name the nightly rotation will not reclaim. The container runs
`alembic upgrade head` at startup, so deploying *is* migrating — there is no
separate step to decide about, and no moment between them to change your mind.

## Versioning

Semantic, and the two halves move **in lockstep**: `backend/pyproject.toml` and
`app/package.json` carry the same number, and any change that ships bumps both.
They deploy as one image, so a build where they disagreed would be a build
nobody could name.

| | |
| --- | --- |
| Bump both | `uv run python scripts/bump_version.py 0.3.0`, from `backend/` |
| On `0.x` | a feature is a minor bump, a fix is a patch |
| The backend reads it | `version.py` parses `pyproject.toml` — one declaration, no constant to drift |
| The frontend reads it | Vite bakes `__APP_VERSION__` in from `package.json` at build time |
| Enforced by | `tests/test_version.py`, which is why the rule is more than a habit — the two sat at 0.1.0 and 0.0.0 until it was written |

The script does not commit, tag, or guess the next number: which kind of change
just happened is a judgement, and the person who wrote it is the one who knows.

**Images are tagged with the version, not the commit.** A deploy therefore starts
by bumping, and `Settings → About` is where the running version is read back —
beside the server's own, when a cached worker is a release behind.

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
  its `Ended time 5 minutes later` stepper. Pass `{ exact: true }`. It cuts both
  ways: **adding** a label breaks somebody else's locator, and a new
  `aria-label="Starter questions"` is what made an existing `getByLabel('Question')`
  ambiguous. Renaming the newcomer beat loosening the test that was already right.
- **The e2e clock is set, not frozen.** Freezing stops anything animating from a
  time delta, and a canvas chart then draws its axes and no data at all. Use
  `page.clock.setSystemTime` and `fastForward`.
- **A poll cannot prove a negative.** `expect.poll` succeeds the moment *any*
  sample satisfies it, so polling for "this page does not scroll sideways"
  passes on the first frame — before the thing that overflows has rendered. It
  passed against the very toolbar it was written for. Sample repeatedly and
  assert on the **worst** value seen, and prove the test by reverting the fix.
- **Check the harness before believing "vacuous".** A batch probe of three
  fixes reported all three untested; the probe was grepping `tail -3`, which by
  then held Playwright's trace hint rather than the summary line. Two of the
  three were fine. A tool that reports everything as broken is usually the
  broken thing.
- **Screenshot the element, not the page,** when judging a detail. A full-page
  capture scaled to fit is too coarse to tell which button is highlighted — twice
  I reported a bug that was not there. Crop, or read `aria-pressed`.
- **Computed styles sampled during a transition are interpolated.** Wait for it to
  settle before believing a colour.
- **When synthetic data cannot reproduce a report, use the real database.** Copy
  `database.db`, reset the password on the *copy*, serve it on another port. A
  freeze that no generated fixture could produce reproduced on the first try.
- **A comment about infrastructure can be wrong.** A migration docstring here
  stated that batch mode "never rebuilds the table at all" for column adds. True
  of its own three nullable columns, false in general, and precisely the
  reasoning someone would lean on to judge the next migration safe. Where a claim
  decides whether something is dangerous, measure it and correct the comment.

## Settled decisions

Do not re-open these without being asked to; each was decided deliberately.

| | |
| --- | --- |
| Secrets | `JWT_SECRET`, `TOTP_ENCRYPTION_KEY` and `ADMIN_PASSWORD` have no defaults. The server crashes without them rather than generating one. The two keys are separate on purpose: rotating the signing key is routine and signs everyone out, and one key would make it also destroy every second-factor enrolment |
| Second factor | TOTP, opt-in per account, asked for at login and nowhere else. **No recovery codes** — an admin clears a locked-out user, and `scripts/clear_totp.py` clears an admin. Wrong codes share the password's per-username budget. Turning one off, by anybody, bumps `token_version` so it cannot be done to somebody silently |
| Login attempts | 5 failures per username per 15 minutes, counted in process memory and cleared by a restart. Keyed on the **submitted username**, never the client IP — the app sits behind nginx and does not trust proxy headers, so every request would otherwise share one key. A locked username answers `429` whether or not the account exists |
| Schema | The server never creates tables. An unmigrated database fails with `no such table` |
| Deployment | A VM behind nginx doing SSL and a second auth layer. **The domain is an environment variable, never in the repo** |
| Answers | **Never deleted** — there is no delete endpoint, and none should be added. Re-answering a day *does* overwrite, last-write-wins on the device's own clock (`test_repeated_answers_upsert_rather_than_duplicate`); this row used to read "never rewritten", which the upsert has contradicted for some time. A session, by contrast, is corrected and deleted freely |
| Scores | Over scaled questions only; an enum has no numeric value to contribute |
| Projects and tags | Per user. Sharing is a later feature |
| Catalogues | **Per user**, like everything else. There is no editor permission and no shared catalogue: a new account is built its own copy from a starter set in `templates.py`, and one account's questions answer 404 to another. Deleting your last catalogue is allowed — the questionnaire offers to build one |
| Starter sets | Code, not rows. A template stored in the database would be a catalogue owned by nobody, which is the thing per-user catalogues removed |
| Deduction rules | On a tag, not on the account — a day of reading owes nobody a lunch break. A tag with a rule shows **reported time only** — except the Patterns group table, which keeps tracked beside reported |
| Parallel timers | Several projects at once, yes. The same project twice over the same minutes, no |
| Long sessions | Never auto-closed, no warning. A multi-day session is a hand-editing job |
| Pomodoros | **Complete at their planned end**, because unlike a session that end was an *input*. `ended_at` is written only by an explicit stop — abandoning, or the next pomodoro cutting a break short — so nothing has to run for one to finish and there is no stored outcome an edit could contradict |
| Breaks | Count as worked time. There is **no button to abort one**: the only way out of a break is starting the next pomodoro, and the part that was used still counts |
| Taint | A label, never a deduction. Time spent is time spent |
| Pomodoro → Time | **A copy, made on request, never a link.** One button writes one session of the day's summed focus and break time, placed at the first pomodoro; `transferred_at` stops the same hour going twice. Correcting a pomodoro afterwards cannot reach the session, which is exactly why there is no synchronisation to keep. An earlier design linked them and generated merge windows, a `source` column and four edit-propagation rules before it was thrown away |
| A copied pomodoro | Still fully editable and deletable. Guards that froze one "so the two cannot disagree" were **removed on request** — the two are allowed to disagree, because a copy never promised otherwise, and the alternative was a row nobody could correct. Deleting one leaves its session behind; that is a job for the Time view |
| Copying twice | Allowed to be attempted. The offer is the **whole day**, always, so it matches the total on the same screen; the second copy is then refused by the ordinary overlap rule on the project, and deleting the first session in the Time view is the way through. Filtering the offer by what had already been copied is what made two numbers on one screen disagree |
| A running pomodoro | Is in the day's list and climbs the totals from the moment it starts. It carries no edit or delete control — an end time still moving is not something to correct — and it is **excluded from the transfer**, which needs a duration that is final. The card says so rather than quietly offering less |
| Focus sounds | Synthesised, not shipped. **"None" stays a valid choice**, which is why audio cannot be relied on to keep a backgrounded tab alive — and so why a pomodoro finishing while the app is closed is reported late. See `PUSH_NOTIFICATIONS_PROPOSAL.md` |
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
