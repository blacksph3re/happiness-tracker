# Daily Tracker

Four trackers — wellbeing, time, focus (pomodoros), todos — behind one login.

- **Backend** `backend/`: FastAPI, `uv`, SQLAlchemy over SQLite, Alembic. Run
  everything from `backend/` with `uv run …`.
- **Frontend** `app/`: Svelte 5 SPA on Vite, `pnpm` (there is no `npm`).
  `pnpm build` writes to `backend/static`, which FastAPI serves with an
  `index.html` fallback, so the app ships as one process. API routes live under
  `/api` and are registered before that mount.

The history behind most rules below — the bug, the measurement, the failed first
fix — is in git: this file as of `cad5fd7` tells it at length.

## Working here

- **Refactor without asking** when the shape of a fix is clear, including the
  tidying around it. Ask only about architectural trade-offs and changes a user
  would notice: a schema, an API surface, which of two defensible behaviours a
  screen has.
- **Propose before building anything substantial**: a markdown file in the repo
  root with the database design, an API sketch, the tests intended, and open
  questions marked `[assumed: X]`. Answers come back inline; fold them in and
  re-issue before writing code. Most proposals are deleted once built, so
  anything still true moves into this file, which never points at one.
- **Failing test first**, then the fix.
- **Fix the obviously wrong; ask about judgement calls** — density, naming,
  which of two numbers a page shows.
- **Prefer removing.** Suggest the cut.
- **Say what was verified and how**: screenshots, measurements, reproductions.
- **Mutate the fix to prove the test**: break each load-bearing behaviour in
  turn and confirm a *named* test fails.
- **Format only what you touched.** Never `ruff format .`; name the files.
  `git diff -w --ignore-blank-lines` finds cosmetic-only churn to revert.
- **Committing is the owner's job.** Stage, commit or push nothing unless asked
  in so many words. "Deploy" is not that permission: build and ship from the
  working tree, then say what is in it.

## Principles

- **The app never invents data.** No auto-closed sessions, no smoothing over
  parallel timers past 24h, no split at a midnight two days disagree about.
  Label a number that needs explaining (`67h 35m across tags`) rather than
  changing it. An unread collection has an unknown count, not zero.
- **Derived values are computed on read, never stored**: scores, deduction
  bands, the midnight split, tag grouping, a day's clock, auto-tracked
  variables, a pomodoro's outcome, an hour budget, public holidays. A definition
  change is then retroactive. `answers`, `time_entries`, `pomodoros` hold what
  happened; the rest is a view.
- **The server computes a number once; the client mirrors it only to draw or to
  work offline.** Where two implementations exist (`lib/time/summary.js`,
  `systemValues`, pomodoro state, the hour budget, public holidays),
  `backend/scripts/dump_derivations.py` writes `app/src/lib/derivations.json`
  and `conformance.test.js` holds both to it.
  Change a service, regenerate, keep both sides in step.
- **Two numbers on one screen come from one source.** Where they genuinely
  differ (the transfer excludes a running pomodoro), say so on screen.
- **State outlives its control.** A saved preference applies even where its
  control is not drawn (the smoothing span is `asLine ? smoothing : 1`). Check
  what `snapshot()` restores.

## Where code goes

Imports point **inward to the shared zone, never across**:

| | Wellbeing | Time | Focus | Todos | Shared |
| --- | --- | --- | --- | --- | --- |
| Routers | `catalogues.py`, `answers.py`, `stats.py` | `projects.py`, `time.py` | `pomodoro.py` | `todos.py` | `auth.py`, `users.py`, `admin.py`, `changes.py`, `sync.py` |
| Services | `services/wellbeing.py` | `services/timetrack.py`, `services/holidays.py` | `services/pomodoro.py` | `services/todos.py` | `services/clock.py`; `services/__init__.py` re-exports all |
| Routes | `routes/wellbeing/` | `routes/time/` | `routes/pomodoro/` | `routes/todos/` | `routes/` — Landing, Login, Settings, Users |
| Lib | `lib/wellbeing/` | `lib/time/` | `lib/pomodoro/` | `lib/todos/` | `lib/store.js`, `api.js`, `router.js`, `clock.js`, `day.js`, `period.js`, `habits.js`, `Swimlanes.svelte`, `pointer-label.svelte.js`, `dismiss.svelte.js`, `facets.js`, `series.js`, `format.js`, `resource.svelte.js`, `palette.js`, `icons.js`, `IconPicker.svelte`, `focus-mode.js`, `todo-settings.js`, `Frame.svelte`, `theme.svelte.js` |

- Something two zones need belongs in shared; the move is the signal it always
  was. Move only what is shared — nothing about a *task* left `lib/todos/`.
  `lib/clock.js` holds generic time (formatting, wall clocks, `fromLocal`,
  `nowUtc`); `lib/time/duration.js` holds what is about sessions (`elapsed`,
  `dayOffsets`, `slices`, `coveredSeconds`).
- **`store.js` is the one module reaching outward**, by named imports
  (`time/duration.js`, `time/summary.js`, `pomodoro/derive.js`,
  `todos/active.js`), because writes are composed there. Zones never reach
  sideways: cross-half writes go through `store.js` (Focus uses `saveEntry` and
  `saveTodo`, Todos uses `startPomodoro`).
- `models.py` stays one file (one SQLAlchemy registry), visibly sectioned. One
  foreign key crosses sections: `pomodoros.todo_id`, `ON DELETE SET NULL`.
- **The halves never link to each other**; the landing page is the only bridge.
  One exception, at the owner's request: starting a pomodoro from a task
  navigates to `/focus` (`lib/todos/start-focus.js`, after the local write, an
  action never a link).

## Loading and the store

- **Paint from the store, never wait on a refetch.** A request on navigation is
  fine; waiting for one is not. `loading` is true only when there is nothing to
  show — derive it (`loaded.loading && items.length === 0`), never
  `let loading = $state(true)` cleared in a `finally`. A figure drawn beside a
  loading state (a heading total) is empty while it loads.
- **Read data from the store**: `await ensureX()` to start a load,
  `$derived($xStore)` to read it. Never assign a loader's result to local state.
- **Anything loaded when reactive state changes goes through `resource()`**
  (`lib/resource.svelte.js`). Never `$effect(() => load())` where `load` assigns
  component state: a write after an `await` escapes Svelte's depth check and
  loops for ever silently. The same applies to effects that persist
  preferences: spread the stored section and read it under `untrack`.
- **An effect must read values that hold still.** A fresh object each tick
  re-runs it; derive a primitive in between.
- Caches: entries by loaded range, summaries by `(range, grouping)`; mutations
  update in place and invalidate what they touched. `expectSettled()` asserts no
  loop; `e2e/sync.spec.js` asserts no waiting.
- **Mark a collection fetched only on a confirmed read.** A failed read
  (`quietly` → `null`) is not an empty answer, and a guard must cover the reads it
  builds on (`ensureTagRules` seeds `complete` from `fetched.has('tags')`).
- **A read can lose a write it outran.** Loaders merge writes made during a read
  back over the reply (`mergeDuringRead`, keyed on `client_id`, `null`
  tombstones for deletes) and keep what the queue still names (`unconfirmed`),
  for answers, tasks, sessions and pomodoros. Rebuild the projection from the
  merge, never the reply. Every later session read is unbounded and shares one
  `once` key; bounded reads in parallel would break the merge maps.
- **An edit made while a read is outstanding is a real edit.** Pages restoring a
  view from preferences apply the snapshot first, then the confirmed read, and
  never over a control the person already touched (per control; `bind:` controls
  need `oninput`/`onchange` to mark themselves). Panels that open before their
  data use a token and a touched flag.
- **Change detection**: `lib/revalidate.js` asks `GET /api/changes` (per
  collection: row count + `max(updated_at)`) and re-reads only what moved, on
  navigation, visibility, focus, reconnect and a 30s tick, at most once per 10s
  measured from completion, one at a time. It cannot see two changes in one
  second — a cross-device test's second change must move a *count*. A re-read
  that fails keeps the old fingerprint (`applyChanges` reports failures through
  the counts on `fetched`), so the next check asks again. Every write under a
  catalogue calls `_touch_catalogue` (`flag_modified`, not reassignment).
- **The cloud is a refresh**: `refresh()` re-reads every collection this tab has
  read, past the floor, probing first if the app thinks it is offline.
  Preferences are neither fingerprinted nor refreshed.
- **Every SDK call goes through `unwrap`** (or `quietly`/`attempt`, built on it),
  which renews an expired access token. Tokens live an hour; a raw call made by a
  tab back from a night away reads the 401 as no answer. The change check did
  exactly that until a reload.

## Sync and the outbox

- **Durable before visible**: a write is on the outbox before the store or the
  screen shows it — announcements included.
- **One gesture, one `enqueueAll`** (`saveEntries`, `saveTodos`, `startPomodoro`,
  `replaceEntry`). Order inside a batch matters: `replaceEntry` queues the
  shortened original before the tail (else two *running* halves merge back);
  `startPomodoro` queues task → ended block → new block (the server refuses a
  pomodoro naming an unknown task).
- `flush` takes one trailing pass when asked during a drain; it chunks at 500
  intents (the server's cap). A drain the server rejects (500, 422) is not
  retried — deliberate.
- **A write that depends on server state calls `settle()` first** (import
  counts, the pomodoro transfer).
- **Sync payloads have no generated types** (`SyncIntent.payload` is untyped), so
  adding a payload field changes only the `*Out` type. **An upsert is the whole
  row**: omitting a field clears it, so payload builders (`todoPayload`) name
  every column. `SyncEntryPayload.merge` is the one non-column instruction.
  Datetimes are normalised to naive UTC by `UtcInstant`.
- **A refused intent retires and says so**: one toast per drain, the panel lists
  all. Signals derived from a sync reply (notices, refusal toasts) are published
  only after the answered intents are retired.
- **Accounts on one device**: queued writes carry their account; sign-out sends
  them first (≤5s), then asks. Queue, refusals (`unread:<id>`) and snapshot are
  per account and re-read when the token changes. `quietly` drops a reply for an
  account no longer signed in.
- An online-only page puts its server controls in one
  `<fieldset disabled={offline}>`.

## Routing and focus

- `beforeNavigate(fn)` guards links, `navigate()` and Back/Forward; a refused
  Back/Forward is undone with `history.go`. A guard must run before the
  irreversible step (sign-out asks `mayNavigate` before clearing tokens).
- Modals enter history through `openLayer`; only the task modal does. Wait for
  `popstate` before changing history after `history.back()`.
- A sign-in returns to `next` (same-origin app paths only). Unknown routes keep
  their address on a not-found page; routes match with `Object.hasOwn`.
- Keyboard vs pointer: `event.detail === 0`. Move focus into panels only for the
  keyboard (a tap focusing a field opens the phone keyboard).
- A card that moves keeps focus (`Tasks.svelte` remembers the focused card).
  Keyboard moves are chained and announced once stored. A question replacing its
  button takes focus onto Cancel and gives it back. A keyboard-opened menu is a
  real `role="menu"`. Every signed-in page has *Skip to content*; one tab stop
  per thing.

## Styling

Tailwind v4 + Flowbite, configured in `app/src/app.css` (no
`tailwind.config.js`; Flowbite JS via `src/main.js`, `initFlowbite()` for late
renders).

- **Use the app's tokens** from `@theme static` (`bg-ink`, `bg-ink-soft`,
  `text-paper`, `text-haze`, `bg-dusk`, `hover:bg-dusk-lift`, `border-ember`),
  `.meta` for labels and `.numeral` for figures. Add a token rather than a raw
  palette step, and never Flowbite's `bg-brand`/`primary-*` (the latter no longer
  exists). A class on a missing token
  emits no CSS — confirm new ones in the built stylesheet.
- Class names assembled at runtime generate nothing. `@theme static` keeps
  tokens that only stored data references. Sections re-theme by rebinding
  variables (`.section-time`), so a *data* colour must not be a rebound token.
- **Light theme** is `:root[data-theme='light']` rebinding tokens — every new
  token needs a light value. Appearance is per device (`ht.appearance`), applied
  by an inline script in `index.html` that also sets `theme-color` (must equal
  the light `--color-ink`; tested). `--color-white` is the dark ink in light, so
  white-in-both is `bg-sheet`. Filled controls get light text from a base rule
  naming `.bg-dusk`, `.bg-dusk-lift`, `hover:bg-dusk-lift`, `.btn-filled` — add
  new filled kinds there. Charts read colours with `themeToken()` inside a
  `$derived`, never hex. `theme.test.js` holds 4.5:1 in both themes (dark's
  known misses on accent fills are the owner's call). Light lifts the
  `disabled:opacity-*` utilities in `app.css`.
- **Buttons are a kind**: `.btn-filled` (16px radius), `.btn-outline`,
  `.btn-danger` (6px), 44px tall. Hover per kind: outlined `border-white/40`,
  destructive `border-ember`, filled `bg-dusk-lift`, card `border-white/30` +
  `bg-dusk/10`, tinted band `brightness-125` — no other brightness filters. Text
  fields, checkboxes and sliders have one shape each, as unlayered rules in
  `app.css` (so `hover:`/`focus:border-*` on a text field does nothing).
  `.meta`'s colour is in `@layer base`; `normal-case` beside `.meta` does nothing
  (left alone deliberately). Find controls in tests by hook or role, not by
  utility.
- **Layout**: equal padding does not make equal buttons — use stretched grids
  and measure. Each control group is its own flex container; labels
  `whitespace-nowrap`, never `break-words`; titles `overflow-wrap: anywhere`.
  Test rows at **320px**, and labels with 15% headroom (the meta font is the
  device's monospace). A 44px target in a dense row comes from a negative margin
  (`-m-1.5 size-11`), never padding; reaches should meet, not overlap; centring
  comes from the row's alignment. A select's trailing padding belongs to its
  chevron.
- **Phones**: inputs are 16px under `pointer: coarse` (iOS zoom), including the
  quick-add overlay; never disable zoom. Native date/time inputs need `min-w-0`
  in modals. Overlays opened by a press hang from their anchor and never reflow;
  confirmations go under the row they ask about. Toasts sit at the top. A
  column, and the calendar's hour grid, is never its own scroll box on a phone or
  a window under 30rem tall. `scrollbar-gutter: stable` only from 48rem.
- A translucent block over a line mixes its tint into the ground token. Do not
  reuse a `data-*` name that already carries a value elsewhere.
- **A `title` is not a tooltip.** Pointer labels go through
  `lib/pointer-label.svelte.js`: pointer events, pinned on touch, captured
  dismiss on tap elsewhere or scroll, clamped on screen by a CSS `translateX`.
  Test with dispatched `pointerType: 'touch'` events, not clicks.
- **Frame**: every page draws in `lib/Frame.svelte` (owns `--gutter`, capped at
  `max-w-frame`). Each half centres one column (`lib/<zone>/column.js`); pages
  carry no `max-w-*` of their own (`e2e/half-width.spec.js`). Wide boards and the calendar's Week are passed
  as `board` with `spread`; navigation drawn inside such a picture is lifted into
  the column (`CalendarStepper.svelte`).
- **Nothing a person steers with moves**: toolbars run stable → conditional;
  a control that appears with state keeps its place (invisible when idle); only a
  press-opened confirmation may take room. A `<select>` among pills is a toolbar
  bolted on — use pills.
- **Landing cards** are `<section>`s with two actions in a stretched 2-column
  grid, `mt-auto`, no minimum height. The time card's second action is Record,
  the todo card's Calendar; both keep `data-go="patterns"`. All eight hrefs are
  asserted.
- **Copy**: a sentence earns its place by stating a fact the screen does not
  otherwise show (a consequence, a scope, where something went); empty states
  are one line. Quote a row's title inside its `aria-label`. Live elapsed time
  is `formatRunning` (`0h 00m 02s`). Native date/time fields restate their value
  through `dayLabel`. Dates outside this year show the year (`weekLabel` does not
  yet). Icons are chosen from `lib/wellbeing/icons.js`, never typed. Svelte drops
  the space beside an `{#if}`, so a sentence with a condition inside it is built
  as one string. `time/ProjectCard.svelte` still splits a running time into two
  boxes — the one place left to converge.

## Time

- **An answer** carries a client-local `day` and `local_hour` (read as the day's
  minimum). **A session** carries UTC instants and the `utc_offset` at check-in;
  durations come from instants.
- A session's own offset picks its day; a **day** takes its clock from the
  session that opened it; a session spilling into a day on a different clock is
  kept whole. A fixed offset is not a timezone — deliberately.
- **Overlapping sessions on one project are kept and counted once.**
  `covered_seconds` / `coveredSeconds` combine spans by real instants, and every
  total uses them: `summarise` on both sides, Record's day total and merged row,
  the timeline lane. Across projects time adds. A day whose rows exceed its
  total says *N counted once*. Two things still merge: two running sessions on
  one project, and a session sent with `merge: true` (the import's *Merge*).
- **Merge sessions** on Record draws one row per project per day: first start to
  last end, with the duration that was tracked. Where the sessions left a gap,
  the row also gives `equivalentBounds` in brackets — first start plus the
  duration, last end minus it — so each pair of times spans the duration
  (`09:00 – (14:00) / (10:00) – 15:00`); back to back, the times stand alone.
  A row with no buttons lets its text fill the line, or its times outgrow a
  phone and push the duration below.
- **Allocation** (`/time/allocation`, from *Allocate* on a week's heading on
  Record) rearranges one week of a tag so its rule deducts the least, and
  stores nothing. Additions move whole; tracked time moves in transfers of
  any amount in whole steps (minute, quarter hour or hour, an `allocation`
  preference); only tracked days that are over take part, none is emptied.
  The order is: least deducted, fewest transfers, least time moved, fewest
  additions moved, time kept earliest. `lib/time/allocate.js` is an **exact**
  search, held to brute force on the whole order and to a time budget; it
  needs a cap, so a rule without one shows *Allocate* disabled with its reason
  in a pointer label. It uses `deductionFor`, so a day filled to its cap still
  owes its break.
- `TimeField` with a `day`: stepping or arrow-rolling past midnight carries the
  day; a typed time never does; the add panel (no `day`) clamps.
- **What a page draws or derives from today reads `$currentDay`**
  (`lib/day.js`), a store that moves at local midnight and when the page comes
  back into view. `today()` is for the moment of an action. A `today()` in markup
  or a `$derived`, or a `const` captured at mount, goes stale on a page left open
  overnight — two blocks headed *Today*.
- Leap years and DST need no special handling (`Date.UTC`, `date`/`timedelta`);
  the corpus pins spring-forward, autumn-back and leap-day sessions.
- A tag with a deduction rule shows reported time; tags overlap.
- **A rule's breaks come off before its cap.** Of the bands that deduct, the
  highest reached applies; a cap limits what is left after it (the lower of
  two caps binds), so a ten-hour cap behind a 45-minute break bites past
  10h45. `deductionParts` says what each band took — Patterns' band pie and
  the budget split a capped day between its break and its cap.
- **An archived project stays stored and leaves every figure**: Record's list
  and its totals, Patterns, the budget and the allocation. Its sessions remain
  on the server and in the export's sessions sheet, and come back on
  restoring. A running timer on one still shows on the landing page, since it
  is live state rather than a record. Seed scripts never write to one.
- **Record writes durations in the account's style** (Settings → Time:
  `4h 15m` or `4.25h`), from `lib/duration-style.js`, kept in a `record`
  preferences section of its own — never in `time`, which Patterns replaces
  whole on every save. Every duration on Record goes through one `format`,
  handed to `BudgetView` and to `breakdownLines`; decimal hours are built from
  the same whole minutes, so the two spellings never disagree. Display only:
  nothing stored changes, and Patterns keeps hours and minutes.
- **An hour budget is a walk over days, derived on read.** A tag's contract is
  periods from a `starts_on` — an average `daily_minutes`, a `workdays` bitmask
  (Monday is bit 0), a German `state` — and `budget_days` / `budgetDays` walk
  each day from the first period to today. Stored is only what a person enters:
  periods, days off, resets.
  - A day is, tested in this order, a public holiday, a rest day, a day off or a
    workday, so a day off on a weekend changes nothing. Only a workday expects
    hours — and a day off of kind `balance` (*Day off*, beside *Vacation* on an
    untracked row), which is taken from the balance: it costs its hours as an
    untracked workday does, reads as a day off rather than a gap, and is
    *Taken off* in Patterns' expected-hours pie. Time on any day counts in
    full.
  - Counted is the tag's rule **restricted to the parts switched on**
    (`add_in_budget`, each band's `in_budget`; NULL is on). A band switched off
    is the rule without it, so a lower band can apply. All on is reported time;
    the switches never touch tag totals.
  - Today is open and counts once it is over. A reset fixes the balance at the
    start of its day; one before the first period is ignored. Archived projects
    do not count (`trackedFor`), so archiving one changes the balance of every
    week it was tracked in — decided over keeping a balance steady.
  - Budget mode lists every day, unlike the record: there an empty workday
    carries a cost and an action (*Not tracked*, *Mark day off*). Days off after
    today wait in one collapsed line above today, which stays the top record.
  - A row shows its counted total and its change; what the count is made of
    and what the day expected is the total's pointer label, `breakdownLines`,
    which Patterns' Day card reads too. A week holding a reset counts from the
    reset, and the reset says the balance it replaced — nothing on the budget's
    first day, which replaced none.
  - **Patterns' Budget mode** draws from `budgetWindow`, the one computation
    behind its heading, line, pies and table. The line starts from the balance
    carried into the window. Day filters and smoothing do not apply (the panel
    is hidden, `span` is tied to the slider being drawn), and `budget` never
    reaches the server: the summary is asked for `grouping`, and a stored
    *Budget* with no contract reads by project. The expected-hours pie counts a
    holiday or day off at the hours the contract would have expected
    (`nominalFor`), so a holiday on a Sunday covers nothing.
- **Public holidays are described, not imported**: `services/holidays.py` and
  `lib/time/holidays.js` hold Easter offsets, fixed dates with their states and
  first year, and one-offs. The `holidays` package is dev-only — the reference
  `test_holidays.py` holds the Python to for every state, 2015–2035 — and the
  corpus holds the port to the Python. Anything below state level is a day
  marked by hand.
- **Days off and resets are `dayoff.put` and `budget.put`, keyed on tag and
  day**, last write wins. A clear is the same intent with a null value and keeps
  its row, so a stale mark arriving late cannot revive it. Contracts ride on the
  tag rule, online-only; a rule saved **without** a `contracts` key keeps the
  stored ones, so a client that has never heard of contracts cannot wipe them.

## Focus

- A pomodoro's state is derived (`ended_at ?? started_at + focus + break`);
  only phase lengths are stored. `done` is a phase.
- A countdown times itself from `started_at`; the shared tick is not a
  stopwatch, and the effect writing the aligned clock depends on nothing derived
  from it.
- `unlockAudio()` runs on Start (an `AudioContext` needs a gesture).
- Sound is measured in `sounds.test.js`: brown noise is a real integral with
  roll-offs fitted to the reference recording, levels by RMS per kind, the loop
  closed by subtracting its end-to-end line (no crossfade).
  `e2e/ambience.spec.js` counts buffers built.
- **Push**: the announcer runs only when VAPID keys are set;
  `pomodoros.notified_at` is both the record and the claim
  (`UPDATE … WHERE notified_at IS NULL`); one minute of grace; abandoned
  pomodoros are never announced; the payload is append-only and the handler
  always shows something; sign-out purges the subscription (server first, then
  browser); subscriptions key on endpoint alone, never sent back out; clients
  re-register on launch.

## Wellbeing

- **Habits** are enum questions with `habit_period` (also the flag),
  `habit_target`, `habit_direction`, `icon`, and `question_options.counts`.
  Verdicts: `unrecorded` first, then met / missed / open; a period counts days,
  not rows. Under `at_least` a met period is final at once; under `at_most` a
  period inside its budget stays open until it ends, and one over budget is
  final immediately. Daily tracking is described (`DAILY_TRACKING`) and counts a day on any
  answer. The streak walk is bounded by the earliest recorded period. Habit
  definitions live only in the catalogue payload.
- **Options freeze once answered** (`add_option`/`delete_option` → 409), but
  counts, target, direction and icon stay editable. Clearing an icon needs
  `model_fields_set`.
- `/answer` opens on the first unanswered question, revised while the first read
  is outstanding and fixed once the reader steers.
- Saving a question is a sequence (question, then one PUT per changed option);
  the editor is online-only, and tests wait for *Question saved*.
- **Auto-tracked variables** are described (`SYSTEM_QUESTION_SPECS`,
  `SYSTEM_SPECS`) and computed on the client; an enum's option id is its
  position. They are filters, not record columns — except the hour.
- **Correlations**: Spearman within each pair's overlap; enums partition (as
  filters) rather than rank; a score is never paired with its components
  (`component_ids`); ten shared days to rank, thinner pairs dimmed. A budget test
  in `series.test.js`.

## Ownership

- Every row has an owner; **another account's anything answers 404**. The only
  permission is `is_admin`, for managing accounts. Scope the
  resolvers (`_get_catalogue`, `_get_question`, `_get_score`), not the handlers.
  A bare id becomes an authorization hole the moment its row has an owner.
- Shared lists are scoped by membership: `own_list` for owner-only acts,
  `member_list` / `visible_list_ids` for reads and task intents. Task
  `client_id` is unique database-wide; a task id the caller cannot see is
  refused per intent (`identity_is_taken`).

## Todos

- **Dates**: `planned_on` (`DATE`, mandatory) and `planned_at` (`TIME`) are
  local; `done_at`, `archived_at`, `active_since` are UTC. `archived_at` is the
  server's to write. A new task's `planned_on` defaults to today in
  `newTaskFields`.
- **Order**: ranks match `^[a-z]+$` (`RANK_PATTERN`); `between()` is total and
  never ends in `a`, so the inbox keeps `a`. A drop whose key grows silly
  re-ranks its column. A grouping's `drop` returns `{}` for the current column;
  `place(task, column, index)` is the only way a card moves.
- **Steps** are their own table and intent and name their parent by `client_id`.
  A task delete records a tombstone in `todosWroteDuringRead`. A remembered id
  needs a fallback the moment its thing is deletable.
- **The archive** is paged, never in the snapshot, unknown until read
  (`archiveRead`); *Show older* only while `archiveNext` has a cursor.
- **The board** shows a set of selected lists (`selectedLists`, applied on every
  read, falls back when a list disappears; the archive is exclusive; the
  quick-add takes the first selected; the `list` grouping ignores the set).
  Columns fit at ≥160px or become a pager (measured from the frame, not a
  breakpoint); below 48rem a column layout is a pager of equal-cell tabs, and a
  single column is never paged. The pager opens on the first column with tasks,
  and a tab choice holds only within its grouping.
- **Groupings**: *Past*, not overdue — `isOverdue(task, today)` means *due*
  before today and is the only rule. Kanban's Done holds every done task (the
  set cleanup archives). A batch move writes the target column's own `drop`.
  Size drops go to the bucket centre. The landing card falls through overdue →
  due today → planned today → in the past.
- **Plain** (the default view): open then done in list order, quiet cards, a
  ticked card settles to the done end after `SETTLE_MS` (1.5s); a drop never
  crosses between open and done (`dropNeighbours`).
- **Dragging**: the carried card is the real card, `position: fixed`,
  `pointer-events: none`, `transition-none`, its slot held at its height, the
  grip taken at the lift; the pager keeps its column mounted. The release aims
  again (pointer moves are coalesced). A column that scrolls holds the card's
  height open at its end while carrying. The settle is a FLIP measured with the
  transition off; reduced motion needs no branch. `columnGeometry` sums the
  `offsetParent` chain. Auto-scroll stops on the room left, read at the start of
  a tick, against the visible part of the box. Card text is unselectable, with
  no long-press callout.
- **Ticks** animate only when this device made the gesture (a stamp within
  2.5s); reduced motion cuts durations, not delays, so sequences live inside one
  keyframe; the strike is a background line with `box-decoration-break: clone`.
- **Editing**: titles are growing textareas (Enter adds no line); typed fields
  save on a debounce, picked fields on `change`. Read a `$derived` into a local
  before clearing what it reads. Two `{#each}` items under one key silently stop
  the block updating.
- **Pomodoro link**: a typed task becomes a real task; a pomodoro names it by
  `todo_client_id`. `settleActive` banks an activated task to the block's derived
  end. Start never waits for the lists read.
- **Calendar**: a drop is `(day, time)` snapped to 15 minutes; a resize snaps to
  30 (`RESIZE_SNAP_MINUTES`) and never moves the start; a no-op drop or resize
  writes nothing; a block spans its column unless it overlaps another *as
  drawn*; a carried block lands where its top is drawn; the untimed row's height
  derives from counts (`+N more`, never `+1 more`); the title wins over the time
  in a crowded block; a phone's Week is an agenda; Day steps a day. Due marks
  belong to the layer of the task they describe. Every gesture stamps the
  afterglow that stops a release reading as a click.
- **Colour and menu**: a task's colour is a 3px bar plus a 12% tint mixed into
  `ink-soft`; `taskColour` holds the precedence. A long press (600ms, aborted past
  6px) opens the menu and cancels the carry; the `justOpened` afterglow runs from
  the release. `lib/dismiss.svelte.js` owns the global dismiss listeners and
  ignores a scroll within 150ms of opening. Menu rows are `min-h-11`.
- **Shared lists**: an intent filing a task where this account cannot read it
  carries `away: true` (decided when built); members see no owner-only controls;
  a list missing from a read takes its tasks off the device; refusals about
  another's list are reworded and re-read at once.
- A gesture that moves a row out of view toasts where it went. A control that
  removes several rows asks first, as removing one does. A control may not claim
  what its zone cannot see.

## Testing

**The suite passes every run** — no retries, no accepted flake rate. A test that
fails once in N is a defect: reproduce it deterministically (order the requests;
`holdOutbox`) and fix the cause. Load, not `--repeat-each`, usually reveals
them; read the first failure in a worker, not the crop after it.

- **Rebuild before e2e** — Playwright serves `backend/static`. `git stash` or a
  restored source does not rebuild either.
- A test that has never failed tests nothing: break the fix, watch it fail.
- **Positive claims poll; negative claims sample repeatedly and assert the
  worst.** Read both halves of a claim from one sample. `expect.poll` gives up on
  a throwing callback — return `null` instead.
- **`data-pending` proves nothing until something store-driven on screen has
  changed** (a write reaches the outbox before the store). `data-sync` is
  debounced. Wait for quiet, not for one response (`savesView`).
- Matchers: `getByLabel(…, { exact: true })`; `toHaveText`, not
  `toContainText`, for plurals; `hasText` cannot see input values; count every
  column, not the first match; visibility means `elementFromPoint` returns the
  element (in view, pointer events on); hit areas are tested by position.
- **Timing**: the clock is set, not frozen (`setSystemTime`, `fastForward`).
  Reduced motion gives every element a 0.01ms transition: positions need two
  equal frames, baselines are taken at rest (`atRest`), colour tokens resolve
  through fresh elements (`resolveColours`). Test motion-sensitive layout in both
  motion states, asserting `matchMedia` first. `reducedMotion` is set through
  `contextOptions`.
- **Network**: `context.setOffline(false)` fires no `online` event — dispatch
  one. Hold `/api/sync` with a flagged route; `unroute` settles held routes.
  Never hold a `route.fetch()` response across a wait. Prove "does not wait on
  the server" with the connection held open, not cut. Before going offline, wait
  for the reads the offline path needs (`waitForResponse` by path): a visible
  page has not necessarily read anything, and under load the switch overtook a
  tag rule's read.
- **Fixtures**: seeds write what the app would; `makeTodos` names tasks with
  `crypto.randomUUID()`; `openTasks` stores the grouping before navigating; switch
  groupings by clicking pills on one page, and wait for the grouping pill, not
  tabs; warm a snapshot on its last load. A touch press lifts on a timer — wait
  for `[data-carrying]` before moving. Scroll a target into the middle of a
  sticky scroll box before tapping it (`intoView`). On macOS, place a textarea
  caret with `setSelectionRange`, not End. Screenshots
  come from `app/e2e/shots.mjs` against a copy of the database.
- **Harness**: one backend per worker (`WORKERS`); `RUN_DIR` is per checkout;
  `-g` matches titles joined with spaces; spec arguments are regexes (read
  `Running N tests`); `pkill -f "[p]attern"`; vitest pins `TZ` to
  `Europe/Berlin` like the browser.
- **Probes**: refuse to run on an already-mutated file (use a marker the original
  cannot contain); read vitest's verdict from its exit code (its output is
  coloured, so a line never starts with `FAIL`); name files explicitly (zsh does not word-split); keep escaped
  literals in quoted heredocs; rebuild in a `finally`; break every path when a
  behaviour is enforced twice. A probe that hangs is a finding. A dead-code scan
  counts AST `Name` nodes in Load context and exempts decorated functions.
- An unreproducible report gets the real database: copy it, reset the password
  on the copy, serve it on another port, delete the copy after.

## Migrations

- `env.py` uses `render_as_batch=True` and turns foreign keys off through a raw
  DBAPI `connect` listener (a rebuild's `DROP` would otherwise cascade).
  `tests/test_migrations.py` walks the chain and fails on lost rows.
- Only a **nullable column with no server default** is added in place;
  anything else rebuilds the table. Measure with `sqlite_master.rootpage` either
  side of the upgrade, using `downgrade` as the positive control.
- Data migrations: repoint every id that names a moved row; delete explicitly,
  deepest first; count references and raise before anything destructive; swap
  constraints before data that violates them; drop an unnamed `UNIQUE` with
  `copy_from=`.
- Before deploying a migration, rehearse on a copy of production: upgrade, row
  counts, `PRAGMA foreign_key_check` and `integrity_check`, boot the ORM. Delete
  the copy. The container migrates on start — deploying *is* migrating.

## Versioning and deploy

- `backend/pyproject.toml` and `app/package.json` carry one version, bumped
  together with `uv run python scripts/bump_version.py X.Y.Z`
  (`tests/test_version.py` enforces it). On 0.x a feature is minor, a fix a
  patch. Images are tagged by version; Settings → About shows the running one.
- Steps are in `deploy/README.md` and `DEPLOYMENT_PLAN.md`. Before each deploy,
  a fresh `happiness-dump` to `backup/pre-X.Y.Z.sqlite` on the server.
- **Build with `docker buildx build --pull --platform linux/amd64`.** The builder
  and runtime `latest` tags move independently; the Dockerfile's final stage
  imports the server's dependencies so a mismatch fails the build. A new Python
  under `latest` gets the backend suite on that version and a side-by-side run of
  old and new images against a production copy.

## Settled decisions

Do not reopen without being asked.

| | |
| --- | --- |
| Secrets | `JWT_SECRET`, `TOTP_ENCRYPTION_KEY`, `ADMIN_PASSWORD` have no defaults; the server refuses to start without them. The two keys stay separate |
| VAPID keys | Optional, all three or none; absent means push is off. Rotating them silently re-enrols every device. Never in the database |
| Second factor | TOTP, opt-in, at login only. No recovery codes: an admin clears a user, `scripts/clear_totp.py` clears an admin. Clearing bumps `token_version` |
| Login attempts | 5 failures per submitted username per 15 minutes, in memory; never keyed on IP. Locked usernames answer 429 whether or not they exist |
| Schema | The server never creates tables |
| Deployment | A VM behind nginx (TLS, second auth layer). The domain is an environment variable, never in the repo |
| Production dependencies | Only what the server imports: plain `fastapi` and `uvicorn`, never `fastapi[standard]`. `httpx`, `beartype` and `holidays` (the public-holiday reference) are dev-only. `.dockerignore` keeps tests, seeds and generators out; `clear_totp.py` ships |
| TypeScript | Held at 6 for `openapi-ts` until it supports 7 |
| Answers | Never deleted; re-answering overwrites (last write wins on the device clock) |
| Scores | Over scaled questions only |
| Projects, tags, catalogues | Per user. A new account gets its own catalogue from code templates (`templates.py`); deleting the last one is allowed |
| Deduction rules | On a tag; a ruled tag shows reported time (Patterns keeps both). Each part carries an *in budget* switch that only the hour budget reads |
| Hour budget | Per tag: contract periods of whole days, an average per workday, a German state for public holidays. Days off are per tag (two contracted tags mark a vacation twice), whole days, vacation, sick or other — which excuse the day — or a day off taken from the balance, which costs it; no allowance. Today counts once it is over |
| Parallel timers | Several projects at once, adding up. The same project over the same minutes is kept and counted once; two running sessions on one project are joined |
| Long sessions | Never auto-closed, no warning |
| Pomodoros | Complete at their planned end; `ended_at` only from an explicit stop |
| Breaks | Count as worked time; no abort button |
| Taint | A label, never a deduction |
| Pomodoro → Time | A copy made on request (one session of the day's total), never a link; `transferred_at` stops repeats; a copied pomodoro stays editable |
| Copying twice | Offer the whole day; a second copy is refused by the transfer's overlap check (`check_no_overlap`, used only there) |
| Deleting a session | Takes the tapped day only, splitting a session where a middle day goes. A running session losing its current day stops at that midnight |
| A running pomodoro | Climbs the totals; no edit or delete; excluded from the transfer, and says so |
| Focus sounds | Synthesised; "None" stays a choice |
| Habits | No tap-to-answer on the landing chip. Periods: day, week, month. Icons on every question |
| Inbox and Archive | Rows per account, renameable, never deletable, matched on `kind` |
| A planned date | Mandatory |
| Archive order | By `archived_at` |
| Todo → Pomodoro | Linked by `todo_client_id`; `task` text is the fallback |
| Shared lists | One owner, members by username; members edit tasks and may move a task to their own list; only the owner manages the list. Done tasks archive to the owner's archive. Inbox and Archive are never shared |
| Past, not overdue | A planned date is never red; a due date before today is |
| Kanban Done | Every done task in the selected lists |
| Streak view | Ignores day filters; spans 12 or 26 periods, stepped by window |
| Navigation | Only the landing page links halves; the one cross-half navigation is starting a pomodoro from a task |
| Ruff | Backend only, via pre-commit |

## Types

- **Type the shape, not the container**: `Literal["day", "week", "month"]`, not
  `str` — it reaches `types.gen.ts` as a union. SQLAlchemy still needs the column
  type spelled out (`mapped_column(String(8))`). A genuinely open value stays
  `str` with a pattern (colours, icons).
- In JavaScript, use the generated types
  (`@param {import('../generated/types.gen').PomodoroOut}`), never `{object}`.
  Regenerate with `pnpm api:generate`.

## Docstrings

Python only: every class, method, property and function outside tests has a
numpy-style docstring — imperative one-line summary, then `Parameters`,
`Returns`/`Yields`, `Raises` as they apply. No `self`/`cls`, no class-level
`Attributes`: document each attribute in a docstring on the line below it. Test
functions get descriptive names instead.

```python
class User(Base):
    """A person who records happiness entries."""

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""


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
    """
```

JavaScript, Svelte and CSS: comment what is not obvious (a workaround, a
non-local invariant, a slow way taken on purpose). Core logic such as the store
is documented throughout.
