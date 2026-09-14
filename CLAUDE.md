# Daily Tracker

Backend lives in `backend/` — FastAPI, managed with `uv`, SQLAlchemy ORM over SQLite,
Alembic for migrations. Run commands from `backend/` via `uv run ...`.

Frontend lives in `app/` — Svelte 5 SPA on Vite, managed with `pnpm` (there is no `npm`
on this machine). `pnpm build` emits into `backend/static`, which FastAPI mounts and
serves with an `index.html` fallback, so the whole thing ships as one server process.
API routes must be registered before that mount and should live under `/api`.

## Working here

The owner reviews by reading, then by using. Both are served by the same habits:

- **A sensible refactor does not need permission.** Technical debt a prompt
  turned up is worth paying off *then*, not later: more time cleaning up now
  beats arriving somewhere messy. So when the shape of a fix is clear, take it —
  including the tidying around it — rather than stopping to ask.

  A proposal is for **architectural trade-offs and changes a user would notice**:
  a schema, an API surface, which of two defensible behaviours a screen has.
  "This view holds its data in local state and should read the store" is not one
  of those, however many files it touches. Asked as a question it costs a round
  trip and returns the answer that was already obvious.
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
- **Committing is the owner's job.** Stage nothing, commit nothing, push
  nothing unless asked for that in so many words. Leave the work in the tree
  and say what is in it; which changes belong together in one commit, and what
  the message claims about them, is a judgement about the project's history
  rather than a step in the task. "Deploy it" is **not** that permission — it
  reads like it, because an image ought to be reproducible from a tagged state,
  and 0.5.0 was committed on exactly that reasoning. Build and ship from the
  working tree, then hand the commit back.

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

  **The shape that breaks it is `let loading = $state(true)` cleared in a
  `finally`.** Reported from use: on a slow connection the homescreen painted at
  once and tapping into Track then sat on "Loading your projects…" for seconds.
  Measured at **3388ms against 68ms** once fixed, with every request held to 3s.
  The snapshot restores `projects` before either read is sent, so the cards were
  there the whole time and the flag was reporting the *request*. `Track` and
  `time/Projects` both had it; `Record`, `Patterns`, both wellbeing views,
  `Users` and `Landing` all already wrote the derived form, which is the one to
  copy — `loaded.loading && nothing.length === 0`. Going through `resource()`
  fixes the other half at the same time, since `$effect(() => load())` where
  `load` assigns `loading` is the forbidden shape two sections down.

  A view holding its data in local `$state` assigned from a loader cannot take
  that form at all — there is nothing to count until the await returns. That was
  `wellbeing/Questionnaire`, and it is why the rule and *"read from the store"*
  above are one rule rather than two. Its rewrite turned up two things worth
  keeping:

  - **Placing the cursor is not a one-shot on the day.** `/answer` opens on the
    first unanswered question, and with `answers` derived that calculation is one
    careless `$derived` away from re-running on every tap and walking the reader
    to the next *gap*. But a day guard alone is also wrong: a cold load renders
    the questions when the *catalogue* lands, a round trip before the answers do,
    so it latched on question one however much of the day was filled — which the
    offline walkthrough caught, deterministically, three runs in three. It is
    revised while the first read is outstanding and stops the moment the reader
    steers.
  - **A read can lose a write it outran.** `ensureAnswers` replaces its baseline
    with a reply describing the server as it was when the request was *sent*, so
    an answer typed in between is absent from it — and once the queue drains it
    is absent from the projection too. The answer is safely stored and vanishes
    off the screen. Pre-existing; the questionnaire's private copy of `answers`
    had been hiding it. Writes made during a read are now merged back over the
    reply, and **the projection is rebuilt from that merge rather than from the
    reply** — getting that second half wrong is what the test caught first.

  `lib/revalidate.js` now asks `GET /api/changes` what moved and re-reads only
  that. The digest fingerprints each collection as a row **count and**
  `max(updated_at)`, because neither alone sees every change: a timestamp cannot
  see a deletion, since the deleted row takes its own with it, and a count cannot
  see an edit. It runs on navigation, visibility, focus, reconnect and a 30s tick
  that shares `PROBE_EVERY` with the offline probe — exactly one of the two
  applies at a time. A floor of 10s between checks, measured from when a check
  *finished*, is what stops a slow connection stacking them.

  **The digest cannot see two changes in one second.** `max(updated_at)` is
  SQLite's own `CURRENT_TIMESTAMP`, which is whole seconds, so an edit landing in
  the same second as that row's previous one moves neither half of the pair. It
  has never mattered in use — two edits a second apart are two gestures — but it
  decides how a cross-device test must be written: make the second change one
  that moves a **count**, such as adding a row, rather than a second edit to the
  same one.

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

The app is four trackers sharing a login, and the code says so. Five zones, and
**imports only ever point inward at the shared one — never across**:

| | Wellbeing | Time | Focus | Todos | Shared |
| --- | --- | --- | --- | --- | --- |
| Routers | `catalogues.py`, `answers.py`, `stats.py` | `projects.py`, `time.py` | `pomodoro.py` | `todos.py` | `auth.py`, `users.py`, `admin.py`, `changes.py`, `sync.py` |
| Services | `services/wellbeing.py` | `services/timetrack.py` | `services/pomodoro.py` | `services/todos.py` | `services/clock.py`; `services/__init__.py` re-exports all |
| Routes | `routes/wellbeing/` | `routes/time/` | `routes/pomodoro/` | `routes/todos/` | `routes/` — Landing, Login, Settings, Users |
| Lib | `lib/wellbeing/` | `lib/time/` | `lib/pomodoro/` | `lib/todos/` | `lib/store.js`, `api.js`, `router.js`, `clock.js`, `day.js`, `period.js`, `habits.js`, `Swimlanes.svelte`, `facets.js`, `series.js`, `format.js`, `resource.svelte.js`, `palette.js`, `icons.js`, `IconPicker.svelte`, `focus-mode.js`, `todo-settings.js` |

Focus shows the rule working: it needs `saveEntry` and `projects`, both already
exported from the shared `store.js`, so importing *those* points inward rather
than across and the time zone is never touched. **Todos is reached from Focus
the same way** — `saveTodo` and `startPomodoro`, both on `store.js` — and a
typed task therefore becomes a real task without either zone importing the
other. `local_day` moved to `services/clock.py` the moment a pomodoro also had
to decide which local day a UTC instant lands in.

The frontend has made the same move three times, and each was overdue rather
than new. **`lib/clock.js`** holds the generic half of what was `lib/time/duration.js`
— formatting a duration, reading a wall clock out of an instant and an offset,
`fromLocal`, `nowUtc`. `store.js`, the landing page and every pomodoro view were
reaching *across* for those, which is the tell. What stayed in
`lib/time/duration.js` is genuinely about sessions: `elapsed`, `startingDay`,
`dayOffsets`, `slices`. **`lib/Swimlanes.svelte`** is the other: one lane per
project, one lane per day and the focus strip are all the same component now.
What they share is not the drawing — that part is easy — but the axis thinning
and the pointer label, which is a pin/dismiss machine with three global
listeners and a phone caveat behind each one. **`lib/period.js`** followed for
the same reason: named windows are calendar work, not session work. And
**`systemValues` with `SYSTEM_SPECS`** left `lib/wellbeing/derive.js` for
`lib/day.js` when the auto-tracked variables stopped being answers: a weekday is
a fact about a date, both halves filter on one, and `facets.js` — which is
shared — was about to import from a zone, which points *outward* and is worse
than pointing across.

**`lib/pointer-label.svelte.js`** and **`PointerLabel.svelte`** are the newest,
and they came out of `Swimlanes.svelte` the moment the streak grid wanted the
same behaviour over a completely different picture. That component's docstring
had already said the shared part was "not the drawing — that is easy — but the
pointer/pin/dismiss machine with three global listeners and a phone caveat behind
every one of them"; the extraction is that sentence taken at its word. Two copies
would be two places for a tap to stop working on a phone and nowhere else.

**`lib/habits.js`** is the fourth, and it went straight there rather than
arriving late. A habit is a wellbeing idea, but its two readers are the wellbeing
patterns page and the *landing page*, which is shared — and shared importing from
a zone points **outward**, which is worse than pointing across. It is built on
`period.js` and `day.js`, both already shared, and knows nothing about editing a
question.

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
both arrived that way; so did `lib/focus-mode.js`, which was
`lib/pomodoro/mode.js` while the shared Settings page was already importing it
across — and so, for the same reason and on the same page, did
**`lib/todo-settings.js`**. The board's three settings are *edited* on Settings,
which is shared, and *read* by the board, which is not; left in `lib/todos/` the
shared page imported into a zone, which points outward and is worse than
pointing across. The priority scale went with them, because `importantSplit` is
defined over it and the settings page draws it, and `estimateLabel` went to
`lib/clock.js` beside the `formatDuration` its own docstring contrasts it with,
because the size-bucket hints render one. Nothing about a *task* left the zone,
which is the test of whether a move like this is the rule working or the rule
being used to hollow a zone out. `models.py` stays one file because SQLAlchemy wants one registry, but
keeps the groups visibly sectioned.

**`store.js` is the one thing that reaches outward, and each reach is named.**
It imports `time/duration.js`, `time/summary.js`, `pomodoro/derive.js` and
`todos/active.js` — because the store is where a *write* is composed, and
composing one means knowing the rule it obeys. One copy of "which pomodoro is
running" or "where a focus ended" there beats a second spelling of either in
the shared zone, and it is what lets the todo half start a pomodoro while
importing nothing from `lib/pomodoro/`. A zone still may not reach sideways for
any of it.

**One foreign key crosses a section, and it is `pomodoros.todo_id`.** The
comment above the Focus section of `models.py` used to say that nothing
referenced a pomodoro and a pomodoro referenced nothing; it now says which one
reference exists and why — a running pomodoro sets its task active, and the
focus history reads the task's *current* title through the link. `ondelete="SET
NULL"`, because deleting a task must not delete the hours spent on it.

The four halves also do not link to each other in the UI. The landing page is
the only bridge, which is what keeps "Record" and "Patterns" unambiguous inside
each — and it is the rule that gets tested first by anything new. Focus writes a
session into Time and still may not link there. **Starting a pomodoro from a
task is the one exception, at the owner's request**: the gesture takes you into
the focus view, because the only thing anybody does after starting a timer is
look at it. It is a navigation made by an action, never a link — nothing in the
todo half is an `<a>` into another half, and nothing else crosses.

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

Four more v4 behaviours worth knowing, each of which cost a debugging session:

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
- **A padding utility on a `select` takes back the room its chevron needs.**
  Flowbite paints the arrow as a background image at `right 0.75rem` and pairs
  it with `padding-right: 2.5rem`; `px-4` sets padding-right and wins, so the
  text ran under the arrow in all fourteen selects here. `app.css` sets
  `padding-inline-end` on `select:not([size])` — unlayered, so it outranks the
  utility. `px-*` decides a select's leading edge and the chevron owns the
  trailing one. The test reads the arrow's own computed geometry rather than the
  number the fix chose, or it would only be restating the stylesheet.

**Equal padding does not make equal buttons.** Four controls in a question card
all carried `py-2` and came out three different heights, because their contents
did not: an arrow glyph, a 20px icon and `.meta` text have different line boxes.
The row is `items-stretch`, which is what makes the padding decide. `e2e/mobile.spec.js`
asserts the heights are one value, at phone width, by measurement.

**And one `flex-wrap` does not make a row of groups.** The streak band held a
span label, two span buttons, a caption and two step buttons under a single
wrapping row, so it broke wherever it ran out of room: one span button alone on
a line, "Up to today" split in half, and the arrow of "Next →" under its own
word. Each group is its own flex container now — a caption may move to its own
line while the buttons it labels stay side by side — and the buttons carry
`whitespace-nowrap` and `flex-1` so a cramped row comes out one width rather
than two.

**320, not 390, is where a row actually runs out of room.** The band above
already looked tidy at the suite's phone width; measured at 320 the two step
buttons were 51px against the others' 35, which is a label on two lines. A
layout test at one width would have passed against the thing it was written for.

**The meta font is whatever monospace the device has**, because `--font-meta` is
a system stack. A label that fits on this machine can split on a phone: TOMORROW
measured 60.0px in a 61.0px cell here and broke as "TOMORRO / W" on the review's.
A test asserts that words fit with headroom — 15% to spare — rather than that they
fit today, and a label never carries `break-words`, which is what let a word
break inside itself instead of the cell growing honestly.

**A 44px target in a dense row comes from a negative margin, never from
padding.** `-m-1.5 size-11` around a 32px box occupies its old 32px of layout
and reaches six pixels past it; padding the same buttons to 44px took the step
row's title field from 60px to **18px** at 320, which is a field nobody can
read. The reach is larger than the gaps, so neighbours' hit areas overlap by a
few pixels — accepted deliberately, because five 44px targets beside a readable
title do not fit on a 320px row and the forgiveness lands in the space between
drawn boxes rather than on another control's glyph. The *card* then needs
padding equal to the reach, or `scrollWidth` exceeds `clientWidth` by exactly
it.

**A symmetric negative margin centres nothing; the row's alignment does.** The
card's tickbox reaches its 44px through `-m-1.5` on every side, which moves the
drawn box nowhere — so in an `items-start` row a 32px box sat at the top of any
card taller than itself, 4px high beside a chip row and 54px high beside a
seven-line title at 320. `items-center` on the row is the fix, and it keeps the
hit area exactly as it was.

**iOS Safari zooms into any form control under 16px when it takes focus.** An
unlayered `@media (pointer: coarse)` rule gives text inputs, textareas and selects
16px — coarse pointer rather than a width, because the zoom follows the finger: an
iPad zooms and a narrow desktop window does not. It names `[data-quick-add-overlay]`
as well, because the quick-add colours its words with a layer drawn behind the
input and the two must share every metric. Never `maximum-scale` or
`user-scalable=no` in the viewport tag: that also takes pinch zoom away from
people who need it. A touch-only rule can only be probed by a test that emulates
touch; the alignment test runs without it and passed with the overlay left out.

**Where 44px reaches overlap, a disabled button wins the shared pixels.** Its
opacity lifts it into a layer of its own, so it paints over the enabled neighbour
and takes that neighbour's taps in the overlap. Gaps between reaches should meet,
not overlap.

**One checkbox and one slider for the whole app**, both as unlayered shape rules in
`app.css`: a 16px box with a 4px radius, and one track with a paper thumb whose
track takes the section's accent. They reach controls in files nobody else may
edit, which is the point of putting them there.

**Toasts sit at the top, under the header.** The bottom of a phone is where the
quick-add and the on-screen keyboard are, and a toast there covered the field a
person was typing into for five seconds.

**Do not add a bare `data-*` attribute whose name is already in use with a
value.** `data-kind="archive"` is how three specs find the list chips, so a
valueless `data-kind` on a modal header gave one name two meanings; renaming the
newcomer to `data-task-kind` beat loosening the locators that were already
right. The same lesson as a new `aria-label` making an old `getByLabel`
ambiguous, one attribute along.

Hover has one answer per kind of control, listed at the top of `app.css`: outlined
→ `border-white/40`, destructive → `border-ember`, filled → `bg-dusk-lift`, card →
`border-white/30` with `bg-dusk/10`, tinted band → `brightness-125`. Do not reach for
a `brightness` filter on anything else: it is active under the cursor at the moment of
a click, so it fights the state change it is supposed to accompany.

## A `title` is not a tooltip

Three failures, and the third is the one that gets reported: a browser waits
about a second, puts it where it likes, and on a touch device never shows it at
all. Both the swimlanes and the streak grid answer a **pointer** instead —
`pointerdown`, `enter`, `move`, `leave` — through `lib/pointer-label.svelte.js`.

`position: fixed` is what stops a *row* clipping the label — both the swimlanes
and a streak row hide their own overflow, and the edges are where a label is
most often wanted. Nothing in it stops the label leaving the **screen**, which
is a different edge: the rightmost cell of a streak row drew it 47px off a 390px
one.

How far right it may start depends on how wide the text made it, so the clamp is
a `translateX` the **browser** evaluates — a percentage inside a transform
resolves against the element's own box, so `clamp(…, calc(room - 100%), 0px)` is
negative by exactly the overflow and zero when there is none. Measuring the width
into state works too and was written first; it puts the label at an unclamped
position for the one frame before the measurement lands, which is a transient a
test can read and be right about the wrong thing. Vertically there is nothing to
guard at all — it sits above the pointer by its own height, and every page here
has a header deeper than that.

"It never leaves the screen" is a **negative** claim, so the test samples the box
repeatedly and asserts on the worst value, rather than polling until one sample
is happy.

A finger has no hover: it arrives, and then it is gone. So a non-mouse pointer
**pins** the label, and it stays until something else is tapped, the page is
scrolled, or the label itself is tapped. Without the pin it flashes for exactly
as long as the finger is down, which is what "hovering does not work on mobile"
looks like from the outside.

The dismiss listener is **captured**, so it runs before a target's own handler
can re-pin: a tap landing on another cell should move the label rather than close
it. Scrolling counts as moving on, because a pinned label is positioned against
the viewport and would otherwise ride down the page over things it no longer
describes.

Testing it needs a *pointer* event with `pointerType: 'touch'`, dispatched
directly. A `click` passes against the broken version, which is the whole point.

## A card with two actions is not a link

Every landing card carries a way in and a way to the patterns behind it, which
makes the card itself a `<section>`: an anchor inside an anchor is not something
HTML has an answer for, and the whole-card tap target went with it. The two
actions are a `grid-cols-2` with `items-stretch`, because equal padding does not
make equal buttons — "Check out" and "Patterns" are different lengths, and
`self-start` left them different widths. `e2e/mobile.spec.js` measures width,
height and top edge at phone width.

Eight links across four sections is exactly the shape a copy-paste gets subtly
wrong, so `every landing card routes to its own half, both ways in` asserts all
eight `href`s and counts them, because a missing card is a missing *pair*. A
Patterns button pointing at the wrong half would look right. The todo card's
second action is the **calendar**, there being no patterns page in that half,
and it keeps the `data-go="patterns"` name rather than earning a special case.

Four cards want a four-column row at the widest — a fourth on a three-column
grid leaves one alone on a line — and the container widened with them: four
cards inside the width three had would each be narrower than any card here has
ever been, and a card's width is what decides whether its two actions sit side
by side. The habits strip below reads the same grid string, or it would line up
with nothing.

The landing page is still the only bridge. It knows all four halves because it
is the chooser; nothing else may.

## An icon is chosen, never typed

The habit icon field was a text input that doubled as its own preview, so
whatever was typed *was* the icon — a habit could be labelled `AAAA` and the chip
rendered letters where an icon belongs. There is one such row in the development
database, which is how it was reported.

`lib/wellbeing/icons.js` holds a curated set with search terms, and the form has
a *search* box beside a *preview*: the box takes words, the row takes the choice.
That is the validation. There is no free-text path to the stored value, so
nothing has to be rejected afterwards and no server rule has to be kept in step
with a client list — `max_length` remains the only bound the API enforces, since
an icon from a later set must not start answering 422.

Terms rather than names, and matched on the **start of a word**: the word somebody
reaches for is rarely the emoji's own name — a run is found by "run", "jog" and
"exercise" — while a substring match anywhere offers everything containing "at".

**Taking one off needs `model_fields_set`.** `icon: null` on `QuestionUpdate`
means "no icon", where null on every field beside it means "leave alone". Read
from the value rather than from what was *sent*, a chosen icon could never be
cleared — which is the same distinction the three habit fields need, one field
along.

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

## Push notifications

Built, except the device check. `PUSH_NOTIFICATIONS_PROPOSAL.md` holds the
reasoning; what is load-bearing:

- **The announcer is the only thing this app runs on its own.** Everything else
  happens because a request arrived. It starts from the lifespan **only when
  VAPID keys are configured**, so a deployment without them is exactly the
  server it was before, with no background task at all.
- **There is no `scheduled_pushes` table**, though the proposal called for one.
  A pomodoro already records when it started and how long its focus runs, so
  *when to send* is derivable and only *whether it was sent* has to be stored —
  which is `pomodoros.notified_at`, one nullable column.
- **That column is also the claim.** `UPDATE ... WHERE notified_at IS NULL`, send
  only if it touched a row. The worst a crash mid-send can do is lose one
  notification, never repeat one, and losing one is already what the grace
  period accepts. It needs its own test: the query that finds due pomodoros
  already excludes announced ones, so a second pass proves nothing about the
  race the claim exists for.
- **One minute of grace**, which is also what makes it safe to switch on: every
  pomodoro already in the database is far outside the window, so the first pass
  announces nothing.
- **Abandoned pomodoros are never announced.** Abandoning is a decision, and
  whoever made it was looking at the screen.
- **The payload is append-only.** `registerType: 'prompt'` means a worker waits
  until somebody accepts an update, so the handler receiving a push may be an
  older release than the server that sent it. Fields may be added; none is
  renamed or removed, and the handler always shows *something* — a `push`
  handler that shows nothing gets the browser's own "This site has been updated
  in the background" shown for it, which is a message the app did not write
  about something that did not happen.
- **A subscription outlives a token**, so signing out purges it and so does
  signing in as somebody else. The server is told first, while there is still a
  token to tell it with; then the browser unsubscribes, which is the half that
  actually stops delivery and happens whether or not the server was reachable.
- **A subscription is keyed on its endpoint alone**, never on `(user, endpoint)`.
  The endpoint belongs to a *browser*, so a second account on one device moves
  it rather than adding a row — two rows would put one person's notifications on
  another person's screen. The endpoint is never sent back out: it is a
  capability URL.
- **Pruning cannot be trusted to the push service.** `410` and `404` mean gone,
  but Apple has been seen answering `201` for an endpoint it had already
  replaced — so the client re-registers on every launch, and `updated_at` is
  what says a device still exists.

## Two writes in one gesture go in one queue entry

`enqueue` starts a `flush`, and a `flush` already in flight **read the queue
before your second intent was on it** — `settle()`'s docstring has said so for a
while, but the consequence is easy to miss from the calling side.

Anything that means *one* user action uses `enqueueAll` — `saveEntries`,
`saveTodos`, `startPomodoro`, `replaceEntry`. Starting a pomodoro during a break
is exactly this shape: it ends one and begins another, and queued separately the
second silently did not reach the server. It passed alone and failed under a full
parallel run, which is the only reason it was found.

**Order inside the batch is a rule of its own, and it is the half a test can
still catch.** `replaceEntry` splits a session by shortening the original and
adding the part after the gap, and it must queue them **in that order**: sent
the other way the two overlap on one project until the first lands, and
`apply_entry` merges an overlap into its union rather than refusing it — so the
split is silently undone by the server. Reversing the batch fails *deleting the
middle day of a session splits it in two* by name.

`startPomodoro` is the other one, and there the order is enforced by the server
rather than merely mattering: one batch holds the **task**, then the block being
ended, then the new block — and `apply_pomodoro` answers `conflict` for a
`todo_client_id` it has never seen, so a pomodoro sent before the task it names
is refused outright and the timer never reaches the server at all. Reversing the
batch fails *a task typed into the timer becomes a task in the inbox* by name. A
batch may hold more than one kind of intent; that is what lets one gesture
create a task and start a timer for it.

Be honest about which half a probe reaches. Breaking `replaceEntry` into two
separate `enqueue` calls **does not** fail anything here, and that is not a gap
in the test: the trailing pass below now brings a stranded write back on its
own, so for a two-write gesture with nothing racing it the batch buys ordering
and one reprojection rather than a write that never arrives.

That is still the rule, but it was never the whole of the problem, and this
passage used to say the stranded write "sits in the outbox until the next wake
event, up to `PROBE_EVERY` later". **It did not come back at all.** While the
connection is good, nothing flushes on a timer: `watch`'s interval calls
`onReachable` and `wake` returns early, so both go to `revalidate`, which reads.
The only things that flush are a new write, the cloud in `SyncBadge`, startup
and `settle`. A write stranded behind a slow request therefore waited for the
person to happen to write again, behind a badge that said one change was
waiting.

`flush` now takes a **trailing pass**: asking for one while a drain is running
sets a flag, and the drain starts a fresh one when it finishes. A request buys
exactly one more pass, so it is not a retry loop — a queue that will not empty
still stops. `e2e/outbox.spec.js` holds the first `/api/sync` open, makes a
second write in a second gesture, and requires the outbox to empty with no
navigation, no tap on the cloud and no thirty-second tick.

What is **not** fixed, and is a judgement call rather than an oversight: a drain
that gets a response the server rejects — a 500, or a 422 on an intent it will
never accept — leaves everything queued and nothing retries it either. Retrying
would loop for ever on the intent that cannot be accepted, which is why the
current answer is to stop.

## The write side of the offline path has no generated type

`SyncIntent.payload` is `{[key: string]: unknown}` in the OpenAPI document, so
**`SyncTodoPayload`, `SyncEntryPayload`, `SyncPomodoroPayload` and `AnswerIn`
reach the client as nothing at all.** They are validated inside the handler and
appear in `components.schemas` nowhere, which has two consequences worth knowing
before they waste an afternoon:

- **Adding a field to a sync payload changes nothing in `types.gen.ts`.** Only
  the matching `*Out` field shows up. Anybody told to "check the new field
  appears in the generated types" will find half of it and read the other half's
  absence as a mistake. `TodoOut.colour` arrived; the payload half could not.
- **It is the `{object}` trap one layer out.** Precision on the server
  propagates outward for free everywhere else here; this one surface is where it
  stops, and closing it would mean typing `payload` as a discriminated union on
  `kind` — an API-surface change rather than a tidy-up.

**An upsert is the whole row**, and that settles one hazard while creating
another. There is no absent-versus-null distinction to get wrong, so clearing
any optional field is simply sending null — the `model_fields_set` care a
question's icon needs is not needed here, and `SyncTodoPayload`'s own docstring
says why: the newest version of a task simply *is* the task. The price is that
**an upsert which omits a field clears it**, so an older client that has never
heard of a field wipes it on every write, and a partial payload built by a
careless write path does the same. That cost is paid identically by `icon`,
`priority`, `colour` and everything added after them, which is the real rule: a
field whose loss would matter cannot live on this payload.

**Every datetime arriving in a sync payload is normalised to naive UTC in the
schema**, through the `UtcInstant` type in `schemas.py`, for entries, pomodoros,
todos, steps, the transfer and `client_updated_at`. The app strips offsets before
sending, so only another client could send one — and when one did, a `Z` made
`check_no_overlap` compare an aware time with a naive one and answer 500, failing
every intent in the batch, while a `+02:00` pomodoro was quietly stored two hours
out. A validator is the one place both cannot recur.

## An online-only page disables itself in one place

Settings said *Changes here need a connection* while two dozen of its controls
stayed live offline: a priority unticked offline looked applied, said nothing, and
came back ticked after the next reload. Every control that needs the server now
sits inside one `<fieldset disabled={offline}>`, so a control added later cannot
forget to disable itself, and only what works offline stays outside it.

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

- **A fifth was the sound being the wrong sound.** "Harsh" was reported, and no
  level or filter tweak by ear would have found it, because two separate things
  were wrong and both are arithmetic. `(last + 0.02 * white) / 1.02` is not an
  integrator — it is a one-pole low-pass at **151 Hz**, so what shipped as brown
  noise was *flat* across everything below that and the deep half of the sound
  did not exist. And brown falls 6 dB per octave where the reference recording
  falls 10.4, because that recording is brown noise that has then been
  low-passed. A genuine integral (pole at 3 Hz), the roll-off moved from 60 Hz
  down to 12, and one pole at 220 Hz on top: **0.7 dB RMS error against the
  reference from 20 Hz to 12 kHz, against 23.3 dB before.**

  Two things that came out of fitting it against a real recording rather than
  against an idea of one:

  - **The reference is the arbiter of what is a defect.** True brown noise
    wanders in level, and `holds a steady level overall` failed at 9.2 dB where
    it had allowed 5. The recording the owner likes spans **16.7 dB** over the
    same windows — it is *less* steady than what this now generates. The
    threshold was calibrated against noise that was never brown, so the
    threshold moved, and the measurement is written beside it.
  - **A test can be structurally unable to fail.** The loop seam is closed by
    subtracting the line between the buffer's two ends, which makes the endpoints
    equal *by construction* — so the seam step is always exactly zero and
    `joins itself with no step worse than the ones already in it` cannot see a
    filter that fails to settle. It still catches the drift removal itself
    (a 3.8e-2 step when deleted). The second lap of `lowPass` is kept for the
    same reason `highPass` has one and is honestly not isolated by any test here.

  Levels are per kind now, and had to be: a real integral has a crest factor near
  3.9, so at white's 0.25 RMS brown peaked at exactly 1.0 and the clamp began to
  engage — on *some* seeds, which is why the headroom test runs six of them
  rather than trusting the one every other test measures.

**A fourth was not in the samples at all**, and no measurement of the buffer
could have found it. "Pulsating with small gaps" came back a second time, and
this time the noise was perfect: the *page* was rebuilding it once a second.
Twelve fresh seconds of brown noise generated, the old source stopped — the
gap — and the new one started from sample zero, so the same first second played
over and over, which is a one-hertz pulse. Counted from inside the page: six
buffers in five seconds. `e2e/ambience.spec.js` counts them now.

The lesson is not about audio. **An effect must read something whose value holds
still**, and `progress()` returns a fresh object on every tick, so an effect
reading `bar?.phase` re-ran once a second. A `$derived` string in between fixes
it because `$derived` is lazy: it recomputes each tick, returns the same string,
and an unchanged primitive marks nothing downstream dirty. Reading `bar?.phase`
*inside that derived* is therefore still fine — both were tried, and only the
effect reading `bar` itself is caught by the test.

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

## A control that is not on screen still applies

The smoothing slider on the time patterns page is drawn beside the *line*, and
only there. `smoothing` is a saved preference, so on a short window it came back
at whatever the last month had been left at — and `seriesInput` fed both charts.
"Hours per day" was therefore a moving average with no control anywhere on the
page to say so, and no way to turn it off: a week whose only business trip was
Friday drew that Friday's ten hours across four days it did not happen on,
because `movingAverage` skips the days a group has nothing on, so a window whose
single reading is Friday averages to exactly Friday.

The tell was on the screen the whole time. The donut, the table and the
`47h 15m tracked` caption all read raw totals, so the bars disagreed with three
things beside them — which is the rule above, arrived at from the other
direction. The fix is one derived value, `span = asLine ? smoothing : 1`, and
what makes it the right shape is that it names the coupling: the span exists
where its slider does.

Worth checking whenever state outlives the control that sets it. Everything in
`snapshot()` on both patterns pages is restored regardless of which window is
in force.

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


## Correlations rank every pair; they never ask you for two

The Correlation view was two selects and one scatter, which made finding
anything a walk through *n(n−1)/2* pairs by hand. It now ranks them all and
draws nothing until a row is tapped. Four rules decide what is in that list:

- **Spearman, not Pearson.** A 1-5 answer is ordinal — the step from 2 to 3 is
  not the same quantity as the step from 4 to 5 — so ranks are what the scale
  supports, and a real but curved relationship still reads as one. Ranked
  *within each pair's overlap*, not once globally, which costs 190 sorts on a
  year and buys the exact answer where two variables have different coverage.
  The test that holds the line is the monotone-but-not-linear one: `y = x³`
  scores 1 under Spearman and about 0.92 under Pearson.
- **Enum variables are not ranked, they partition.** `axisValues` maps an enum
  answer to its option's *position in the list*, which is a display order
  somebody dragged into place: a coefficient against it changes when the options
  are reordered. As a filter the same variable is worth more, because the
  ranking reads the facet-filtered `days` — so "how do these correlations look
  on weekends" is a question the page answers by narrowing rather than by
  plotting a category against a scale.
- **A score is never paired with its own component.** That correlation is
  guaranteed by the definition, so it is not a finding, and left in those pairs
  take the top of the list. `question_ids` cannot see it — that says what a
  variable *is* — so `Variable` carries `component_ids` for what it is *made
  of*. Eagerly loaded on both queries in `stats.py`, or it is an N+1.
- **Ten shared days to be ranked; thinner pairs are dimmed, not dropped.** The
  floor was briefly going to be half the window, which sounds proportional and
  is not: on a year it demands 183 days, so a question added two months ago
  ranks against nothing and vanishes with nothing saying why. A pair below the
  floor keeps its row, its count and its scatter — the house rule about
  labelling a number rather than quietly changing it.

Cost is 12-17ms for 190 pairs over 365 days, on a user action rather than per
frame. `series.test.js` holds a budget so a regression surfaces there rather
than as a frozen tab.

## Everything belongs to somebody

Answers, projects, tags, deduction bands, preferences, catalogues and their
questions: every row in this database has an owner, and **another account's
anything answers 404** — not 403, because whether it exists is not that caller's
business either.

**A shared list is the one exception, and it is scoped by membership, not by
owner.** `own_list` still means *owned by this caller* and guards what only an
owner may do; `member_list` and `visible_list_ids` mean *owned by or shared
with*, and every read and every task intent resolves through them — so the
resolver rule below holds, one level along. Task identity is unique across the
whole database for the same reason: two members must resolve one task to one
row. A caller who can see neither the list nor the task still gets 404, and one
who names a task id they cannot see is refused *per intent* — before
`identity_is_taken` existed, that case inserted a colliding row and the
integrity error failed the whole `/api/sync` request instead of one write.

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
grouping, a day's clock, **the auto-tracked variables** — none of these are
written to the database. The reason is the same every time: a stored derivation
can disagree with the definition it came from, and a definition change should be
retroactive. Editing a score's components fixes last month; so does editing a
lunch-break band.

The auto-tracked ones were the last holdout and the clearest case. Weekday, month,
year and day-of-year were **stored answer rows** — 36% of that table, each one a
stored `date.isoweekday()` — written per catalogue, which is why one weekday
variable spanned several question rows and `Variable.question_ids` had to be a
list. Deleting them removed all of it: the cross-catalogue merge, the
`(catalogue_id, system_key)` unique, `sync_system_answers` and its arbitrary
choice of which catalogue a day's values went into, the 38 option rows, and
`scripts/restore_system_options.py`, whose entire job was repairing data that
need not have existed.

Three things make that work, and each is load-bearing:

- **They are described, not stored.** `SYSTEM_QUESTION_SPECS` on the server and
  `SYSTEM_SPECS` in `lib/day.js` say what the five are; `system_values(day, hour)`
  and its port `systemValues` say what they equal. No question row, so
  `Variable.question_ids` is `[]` for them and at most one element for everything
  else — and an enum's option id is its **position**, which is also the number
  the client derives, so a filter chip and a day compare without a lookup.
- **The client computes them, not the server.** The exception to "the server
  computes it once", and deliberately: `/api/stats/variables` answers nothing at
  all for an account with no answers, and the *time* half still has weekdays. A
  facet built from that endpoint silently lost the weekday filter for a
  time-only account — caught by `weekdays narrow the hours of an account that
  has never answered anything`. `lib/facets.js` reads the calendar instead, which
  is what it always did for its own weekday facet: **the calendar always knows.**
- **They are filters, not columns.** The record table dropped weekday,
  day-of-year, month and year on request: it is days across and questions down,
  so a Weekday row reading Mon under a header reading 2026-06-15 restates its
  own heading, and so do the other three. They keep their place in *filters*,
  where "only Saturdays" is worth something. The hour stays as a column, being
  the one auto-tracked value the date does not already say — and the export
  follows the columns, so it lost the same four.
- **The hour is real data and moved to a column.** `Answer.local_hour`, read as
  `min(local_hour)` over the day. The stored version kept whichever write
  *arrived* first, so a phone answering at 08:00 offline and syncing after a
  laptop that answered at 14:00 recorded 14. A minimum cannot depend on arrival
  order. On rows backfilled by the migration the column means "the day's first
  hour" rather than "this row's", which is invisible to a reader taking the
  minimum.

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

## A habit is an enum question, and that is the whole design

"Went to gym? Long / Short / No" with three extra facts on it: which options
`count`, how many days in a period must count, and whether the target is a floor
(`at_least`) or a ceiling (`at_most`). Not a new kind of question and not a new
table, which is why filtering, answering, the record, the export, Totals and the
correlation ranking all took **zero lines** — a habit already *was* an enum
question to every one of them.

Five columns: `questions.habit_period`, `habit_target`, `habit_direction`,
`icon`, and `question_options.counts`. `habit_period` doubles as the flag, so
there is no `is_habit` that could disagree with it.

- **`counts`, never `succeeds`.** With two directions the counted option is not
  the happy one: a smoking habit counts *Yes*, and marking "Yes, I smoked" as
  succeeding reads backwards. `counts` is the only word neutral about which side
  of the target you are aiming for.
- **Four states, and `unrecorded` is checked first.** met / missed / unrecorded /
  open. Under `at_most` a period with no answers has a count of zero and would
  otherwise read as *met* — the app awarding itself a clean week for a week
  nobody described, which is the never-invent-data rule in its sharpest form.
- **`open` is the grace rule made visible**, and it is where the two directions
  genuinely differ. Under `at_least` a met period is final — you went, and
  nothing later can un-go — so it counts at once. Under `at_most` a period still
  inside its budget is never final, because tomorrow can spend it; one already
  over budget is final immediately and is drawn red. The run is the trailing
  sequence of green cells, so the number and the picture cannot disagree.
- **A period counts days, not answer rows.** They are the same number only
  because `uq_answer_per_day` allows one answer per question per day, and a
  projection over the outbox can briefly hold two rows for one day.
- **Daily tracking is described, not stored** — `DAILY_TRACKING` in
  `lib/habits.js`, the same shape as `SYSTEM_SPECS`. A day counts on **any**
  answer, deliberately not on a finished questionnaire: "every question
  answered" is evaluated against the catalogue as it stands, so adding a question
  would collapse the whole historical streak, and nothing records which
  questions were active on a past day. Completeness is drawn as how full the cell
  is instead. The streak on the landing page is therefore the same integer it was
  before habits existed, which is the acceptance test.
- **The streak walk is bounded by the earliest recorded period**, and that is not
  tidiness. `verdict` returning `unrecorded` for an empty period is what would
  otherwise terminate it, so the moment that guard is wrong an `at_most` habit
  walks back through all of time. A mutation probe on the guard **hung vitest for
  two minutes rather than failing** — which is a frozen tab, not a wrong number.
  Bounded, the same mistake is something a test can see.

Habit definitions live in exactly one payload, the catalogue. `/api/stats/variables`
was the obvious second home and is wrong for it twice over: two copies of a
definition is how the transfer button came to disagree with the totals above it,
and that endpoint only returns questions the account has *answered*, so a habit
defined yesterday would have no streak at all rather than a streak of zero.

### The freeze does not cover a definition

`add_option` and `delete_option` answer `409` once a question has been answered,
because adding a choice retroactively changes what the recorded ones meant.
**Marking an existing option as counted is the opposite kind of change** — a
definition over answers that are already correct — so `PUT
/questions/{id}/options/{oid}` deliberately does not consult
`question_is_answered`, and neither do the target, the direction or the icon.
Editing a score's components fixes last month; so does this.

The narrowness is the part worth testing. There is a test for the exemption and a
test that adding and removing options is *still* frozen, and breaking either one
alone leaves the other passing.

### A question edit never reached another device

Measured before it was fixed, not reasoned about:

```
BEFORE               : {'n': 2, 'at': '2026-08-30T13:38:37'}
AFTER ADD QUESTION   : {'n': 2, 'at': '2026-08-30T13:38:37'}
AFTER EDIT QUESTION  : {'n': 2, 'at': '2026-08-30T13:38:37'}
```

`/api/changes` fingerprints questions, options and scores through their
catalogue, and SQLAlchemy's `onupdate` fires on the row being written — which is
never the catalogue. So adding *or* editing a question moved nothing the digest
could see, and a second device kept the old wording, the old options and the old
habit target until somebody reloaded the page. Habits made it visible rather than
causing it: a stale target shows a *number* that quietly disagrees.

`_touch_catalogue` in `routers/catalogues.py` is called by every write under a
catalogue. It uses **`flag_modified`**, not a re-assignment: SQLAlchemy skips a
set whose value has not changed, so `catalogue.name = catalogue.name` emits no
UPDATE at all and `onupdate` never fires. The first attempt did exactly that and
the test caught it.

### Saving an edited question is a sequence, not a request

The question, then one `PUT` per option box that moved. Navigating away
mid-sequence takes the tail down with the page, so the counted flag silently does
not save. The editor is online-only and shows a *Question saved* toast when the
whole run has landed, which is what a test must wait for — waiting for the click
fails deterministically, and looked like flakiness for exactly one run.

## Todos

A fourth tracker: lists of tasks, five groupings over three layouts, and a
calendar. The design was written in `TODO_PLAN.md`, which is a working document
and goes when the work has landed — so what is load-bearing and still true is
here:

- **A plan is a local date, not an instant.** `planned_on` is a `DATE` and
  `planned_at` a `TIME` with no offset beside them, exactly as an answer carries
  a client-local `day` — "feed the cat tomorrow at nine" means nine o'clock
  wherever you are. Only the columns recording something that *happened* —
  `done_at`, `archived_at`, `active_since` — are UTC instants.
- **Order is a fractional rank string, and `between()` is total.** It always
  returns a key strictly between its two neighbours, including between two equal
  ones, and it **never ends in `a`** — which is what lets the inbox hold the
  literal rank `a` and stay leftmost for ever without a special case. A drop
  whose key has grown silly re-ranks its own column in one batch, so the
  operation that would degrade is the one that repairs it.
- **A grouping's `drop` returns `{}` for the column the task is already in**,
  and the rank is decided separately by the index. Two halves that do not know
  about each other is what makes *place it where it was dropped* one behaviour
  in every grouping rather than a special case per view — and it is why
  `place(task, column, index)` is the only way a card moves, whether a pointer,
  an arrow key or a drop on a pager tab moved it.
- **Below 48rem a column layout becomes a pager**, not a squeeze: a tab strip
  with counts, one column on screen, swipe or tap to move. The column is the
  same markup at both widths, so there is one card and one drop handler rather
  than two. A tab is itself a drop target meaning *the end of that column*,
  which is the only honest answer a name can give.
- **Steps are their own table and their own intent.** Ticking one is one write
  rather than a rewrite of its parent, so a `todo.upsert` payload carries no
  steps at all and the projection keeps whatever steps a task already had. A
  step names its parent by `client_id`, because a step added in the modal of a
  task still sitting in the outbox has no key to point at.
- **A read can lose a *delete*, not only a write.** `todosWroteDuringRead`
  carries what outran `GET /api/todos`, and `forgetTodo` used to `delete` the
  task's key from it — which says *no write is waiting under this name*, the
  opposite of *the row is gone*. The reply still holds the task and the delete
  has drained by the time it lands, so the card came back on screen while being
  deleted on the server, and stayed until the next read. A delete records a
  **tombstone** instead — a `null` under its own key, in the same map, because
  being in that map is what makes it cleared with it; a set beside it would be a
  second thing to clear, which is the mistake itself one level up. A step needs
  none: what survives a read is a whole task row, so the parent *minus the step*
  already says it. `mergeDuringRead` folds both back in, for the answers too.

- **`archived_at` is the server's to write.** Being archived *is* being in the
  archive list, and a client-supplied timestamp could disagree with the list it
  is in. The archive is therefore ordered by something only the server knows,
  which is why a locally archived task is drawn from `todos` alongside the page
  `ensureArchive` read, deduplicated on `client_id`.
- **The archive is never in the snapshot.** It is paged, it is read when it is
  looked at, and it is the one collection the queue is not laid over — a task
  *entering* it is an ordinary upsert with the archive's `list_id`. The foot of
  the column grows *Show older* only while `archiveNext` holds a cursor, so the
  end is said by the **absence of a marker** rather than by a page coming back
  short — and a paged read is a *distinct* read from the first, which is why
  `ensureArchive` appends for a `before` and marks the collection `fetched`
  only without one. The control belongs to the **column** (`paged` on the
  column contract) and not to the archive's own view: two screens draw the
  archive, and one of them draws it beside every other list.
- **The flush chunks at 500**, which is the server's cap on `intents`. Cleanup
  can archive six hundred tasks as one gesture, so the chunking lives in `flush`
  rather than in the gestures that can reach it, and a later chunk may never
  overtake an earlier one.
- **A task activated by a pomodoro banks to the block's derived end, never to
  now.** `settleActive` in `lib/todos/active.js`: a focus block ends without
  anybody pressing anything, so a phone closed at nine and opened at six must
  bank twenty-five minutes and not nine hours. Abandoning banks to `ended_at`,
  which is where the focus really stopped. A task activated *by hand* has no
  linked pomodoro and is untouched — matched on the focus window containing
  `active_since`, so a hand restart in the afternoon is not banked at half past
  nine. The sweep runs on the phase leaving `focus` and on the load of the focus
  page and both todo pages, and writes **only when something needs settling**,
  or every visit would queue an intent per task.
- **A typed task needs the account's lists, and Start does not wait for them.**
  A task is created in the *inbox*, whose id a device knows from the snapshot or
  from one request — and inside that one-request window on a first-ever visit,
  Start puts the text on the pomodoro alone. That is the documented fallback
  rather than a bug: awaiting the read would be a Start button that does nothing
  while the network thinks about it, which is the defect this file opens with.
  It cost a test one full parallel run before the test was made to open past the
  window rather than the app made to wait.
- **A choice made while the preferences read is outstanding is a real choice.**
  Both todo pages restore their view after an await, and both used to assign
  over whatever the reader had touched in between — a due-date toggle checked on
  arrival was quietly unchecked again. Guarded per control, not per page, or
  choosing a grouping would also cost the remembered list. It surfaced as a
  flake in one calendar test, and delaying `GET /api/me/preferences` makes it
  fail every run.
- **An effect that carries a preference section through is an effect that reads
  what it writes.** `persistPreferences` replaces the section it is given, so
  every page writing one has to spread the whole of it — `{ ...stored, ...view }`
  — and read it under `untrack`. Read tracked, it is the forbidden shape
  exactly: the write lands after an await, so Svelte's depth counter has reset
  and the effect loops for ever **with no error at all**. Measured as
  thirty-eight board tests failing at once, with cards on screen and a tickbox
  that did nothing.
- **A transformed ancestor becomes the `offsetParent` in Blink.** The insertion
  gap displaces cards with a `transform`, and `card.offsetTop` read in one go is
  relative to *that* wrapper — so it came back `0` the moment a card moved and a
  card aimed at the second slot went to the third. `columnGeometry` sums the
  `offsetParent` chain up to the list instead, and `[data-cards]` carries
  `position: relative` to be where the walk stops. A test measuring the same
  thing has the same trap.
- **`.meta` set `color` outside any layer, so `.meta text-alarm` was dead CSS.**
  Layer order beats specificity outright, and Tailwind's utilities are all in
  `@layer utilities` — the overdue chip never turned red and forty-five `text-*`
  utilities across the app were losing silently. Only the `color` declaration
  moved into `@layer base`; the font, the case, the tracking and the size stay
  unlayered, so `text-sm` beside a `.meta` still loses. **Every `normal-case`
  class sitting beside a `.meta` does nothing** for the same
  reason — seventy-five of them, counted — and that is left alone on purpose:
  undoing the case is a typographic decision, and which of them meant it is the
  owner's call rather than a sweep's.
- **A browser coalesces pointer moves onto animation frames**, so the last move
  of a quick gesture can still be undelivered when the release arrives and the
  drop is placed where the card was a frame ago. `onUp` aims again at the
  release point. Measured: a drag to the third slot landed fourth every time,
  and passed with a 200ms pause before letting go — which is the shape of a test
  that would have hidden it.
- **Two `{#each}` items under one key silently stop that block updating.** The
  insertion marker was spliced in twice, because the carried card does not
  advance the count, and Svelte's duplicate-key error left one column never
  re-rendering while every other column carried on. It reads as "the drag state
  is not reactive", which is the wrong diagnosis entirely. The gap is built as
  one pass over the cards now, so there is nothing to splice.
- **Typed saves on a debounce; picked saves on `change`.** `change` does not
  fire on a text field until the focus leaves it, so an estimate typed as the
  last thing before closing was never saved. Title, notes, estimate and a step's
  title all go through the debounce — which is also what the flush on close
  covers — while a date, a time or a select commits a whole value at once and
  stays on `change`.
- **A `$derived` read after its dependency is cleared is the parse of nothing.**
  The quick-add's Enter cleared the box and *then* read `parsed.patch`;
  `$derived` is lazy, so every recognised field was silently dropped and the task
  was created with the column's preset alone. Read the derived into a local
  before mutating what it reads.
- **A remembered id needs a fallback the moment the thing is deletable.** The
  board remembers its lists, lists are deletable, and a *second device* can
  delete one — so it arrived pointed at nothing, drawing empty columns beside a
  chip row that did not include it. The same shape as `groupingFor` falling back
  for a grouping that no longer exists, one level of data along. `selectedLists`
  is that rule for a set, applied on **every read** rather than at the restore:
  the ids are stored unvalidated, because the view is restored before the lists
  have necessarily arrived and checking them against a list that is not there
  yet would drop a real choice.
- **The board shows a *set* of lists, under `lists`.** A tap toggles one in and
  out, a small *All* gathers every ordinary one, and at least one stays selected
  — tapping the last is the one press that does nothing. Four consequences worth
  keeping straight:
  - **The archive stays exclusive, in both directions.** It is the read-only
    collection and the paged one, so a board holding it beside an ordinary list
    could neither be added to nor dragged within. A stored set holding both is
    read as the ordinary ones.
  - **A quick-add still needs one list**, so it takes the **first selected in
    list order** — the inbox whenever the inbox is among them — and says so
    under the box (`#Inbox`) whenever there is more than one to be wrong about.
    A card grows its list's colour dot on the same condition.
  - **The `list` grouping ignores all of it**, as it always has: there every
    list is a column.
  - **`storedLists` migrates the old single `list`**, and the save writes that
    key back as `undefined` so `JSON.stringify` drops it. Two spellings of which
    lists are showing is how a stale one comes to answer — the same reason the
    transfer button was deleted rather than reconciled.
- **The carried card travels with the pointer, and its slot holds its place.**
  A dimmed card sitting in its own slot while a gap moved elsewhere is a drag
  with nothing in your hand. The card is the **real** card — one element, one
  set of handlers — drawn `position: fixed` at the grip it was picked up by, and
  five details are load-bearing:
  - **`pointer-events: none`**, or `elementFromPoint` finds the card rather than
    the column beneath it and every drop lands where it started.
  - **`transition-none` while carried.** A card's ordinary `transition` includes
    `transform`, so without it the card eases toward the pointer 150ms behind
    the finger.
  - **The slot keeps the card's exact height.** The card is out of flow, so
    without it the column closes up under the pointer and every card below moves
    for a reason `columnGeometry` knows nothing about — which is the drop index
    breaking, not just the picture.
  - **The grip is taken at the lift, not at the press.** A mouse travels six
    pixels first, and a grip measured from the press puts the card six pixels
    off the finger for the rest of the gesture.
  - **The pager keeps the carried card's column mounted**, stowed off-screen
    with `pointer-events: none` and inside the *same* keyed `{#each}` as the
    column on screen. Svelte moves an element whose key it still sees and
    destroys one it does not, so the card is never re-created: a second copy
    would be two `data-client-id`s for one task, and unmounting it mid-gesture
    would take the pointer capture and the `touchmove` guard down with the node
    they are attached to.
- **The settle is a FLIP, and `prefers-reduced-motion` needs no branch.** On
  release the drag records where the pointer let go; the card is measured in its
  new place *after* the store has moved it, put back at the release point with
  no transition, and let go of — the transition it already carries does the
  animation, and `app.css` cutting every duration to 0.01ms under reduced motion
  is what makes it a snap with no second code path to be wrong. The landing is
  stamped with the clock and never cleared: a card that changed column is a new
  element, and one mounting a minute later for any other reason must not slide
  in from wherever a pointer happened to be.
- **A new task's `planned_on` defaults to today, in one place.** `newTaskFields`
  composes the column's preset, the parsed text and that default, and the
  quick-add hands the *same object* to the write that it drew the preset line
  from. Three of the five groupings preset no day at all — a quadrant means
  nothing about when a task is planned — so the intent was refused with
  *planned_on field required*, and it is not each `preset`'s job to remember a
  column it has no opinion about.
- **A refused intent says so out loud.** A conflict retires from the queue, so
  the projection loses the write and whatever it drew simply goes; the count
  beside the cloud was the only thing left saying so, behind a tap. That is how
  *adding in the Eisenhower matrix does not work* was reported as **nothing
  happening at all** — the card never even drew, because `dayLabel(undefined)`
  threw inside the render and took the column with it. One toast per drain
  rather than per intent: a gesture can carry six hundred refusals, and the
  panel still lists every one.
- **A live region only speaks when its text *changes*.** Two cards moved into
  the same position produce the same sentence, so a reader hears the first and
  not the second. The keyboard's announcement carries an alternating zero-width
  space: it draws nothing, reads as nothing, and makes the string different.
- **A calendar drop is `(day, time)`, and the time is snapped to a quarter
  hour.** Three targets say the whole of what one can mean — an hour column
  gives a day and a snapped minute, the anytime row gives a day and *no* time,
  and a strip chip gives the day alone and keeps the time the task had, which is
  the honest answer a name can give about a clock. All three go through one
  `onmove` on the route, which owns the comparison that makes a drop back onto
  its own slot write nothing. `calendar-drag.svelte.js` is the board's gesture
  over a time grid rather than a list and keeps its conventions — threshold,
  short press, `setPointerCapture`, captured `pointerup`, Escape — and adds the
  two a scrolling box needs: the drop is re-read from the column's rect on every
  move, and holding a block near the top or bottom **scrolls** it, clamped to
  the *visible* part of the box because a `70vh` box of 1,200px of hours has its
  own bottom edge below the fold. **A block is the button that opens its own
  modal**, so a captured pointer reports the release as a click on it however
  far it was carried: the same `justDropped` afterglow that stops the swipe from
  reading a drop as a page turn is what stops the drop from opening the task it
  just moved.

- **Overdue means due before today, on a task not done — and nothing else.**
  `isOverdue(task, today)` in `fields.js` is the one rule, and the card's alarm
  chip and the landing card's count both call it. A task planned in the past sits
  in **Past** and is never drawn red; a task due today is due, not overdue. The
  word used to mean *planned* before today in three places with three copies of
  the rule — the column, the card chip and the landing count — which is how a
  renamed column could have gone on sitting over a red chip that contradicted it.
- **The landing card says *Nothing planned* only when that is true.** Its one
  reading falls through overdue, due today, planned today and, last, *in the
  past*. Once Overdue became Past, a board holding three open tasks planned for
  days that had gone read *Nothing planned* — the card claiming an empty board,
  which is the app inventing data by leaving a number out.
- **Kanban's Done holds every done task, on any day, and the four columns split
  every task exactly once**: done, then active, then planned for today, then the
  rest. It used to hold only tasks done *and* planned for today, a rule from the
  original brief, so a task finished yesterday was in no column at all while
  *Clean up 7 done* sat above a Done column showing three. Done is now exactly
  the set cleanup archives, so the column and the button show one number. A drop
  into Done ticks and banks the clock but never moves `planned_on`, because any
  day is already a legal value there; and Done names no single day, so its cards
  keep their date chip, which is what tells last week's from today's.
- **A batch move writes the target column's own `drop`.** Past declares only
  `sweep: 'later'`; the route takes the date from the same patch it writes, so
  the confirmation ("planned for Tue, Jun 17") and the write cannot disagree —
  and that date is today plus two, which skips tomorrow, which is exactly why the
  question names it. Open tasks only, since a done task's plan is history; they
  land at the end of the target in their old order, as one `saveTodos`.

### Plain is the first view

A list's tasks in their own order, open first and done at the end, with nothing
but the tickbox and the title on a card — the owner's request, and the default
where no view is remembered.

- **One column, and a single column is never paged.** Below 48rem a board of one
  column is drawn stacked whatever layout is remembered, which is also why the
  archive no longer shows a one-cell switcher.
- **A drop never crosses between open and done, and clamping the slot is not
  enough.** The section comes from whether a task is done, so `place` takes both
  the slot *and* the neighbouring ranks from `dropNeighbours`: each section is
  sorted separately, so at the boundary the two neighbours' ranks can sort either
  way, and a key taken between them lands one slot out.
- **A ticked card waits 1.5s before joining the done end** (`SETTLE_MS` in
  `tick.js`), long enough to see it struck through in place and untick a mis-tap;
  unticking is immediate. The `settling` set is a `$derived` over the clock read,
  gated by a counter that only the tick and a timeout scheduled off the stored
  tick times ever bump — never an effect, which would be an effect reading what it
  writes.
- **A quiet card hides its whole chip row** — planned date, time, due, estimate,
  priority, steps, notes and owner — but keeps the task's own colour, and a bare
  list dot replaces the named list chip when several lists are selected. The cost
  is named rather than hidden: an overdue task shows no red in Plain.
- **A quiet column draws no heading that repeats the page's.** `Frame.svelte` owns
  the eyebrow, the title and the one margin below them, and a page passes the
  cleanup control through its `aside`.
- **Restoring a remembered view applies the snapshot's copy first**, after
  `ready()`, and then the confirmed read. Restoring from `ensurePreferences` alone
  waited on the network on every reload, so a remembered Date grouping painted as
  Plain until the preferences request came back.
- **On a phone the grouping pills and the list chips wrap into equal cells** rather
  than scroll, so every view and every list is on screen. That costs 85px of phone
  before the first card, which is a density trade the owner decides.
- **A test states the grouping it depends on through `openTasks`**, which stores it
  through the preferences API before navigating — not a pill click, whose debounced
  save a reload would lose.

### The last slot of a column is reachable

- **A column that scrolls its own cards holds the carried card's height open at
  its end while a card is over it.** The insertion gap is a transform, and
  transforms count toward scrollable overflow, so without that space the
  column's maximum moved with the gap — 824 with the gap above the last card, 766
  with it below — and the end slot could be neither shown nor dropped into: a
  card held at the foot landed one short of last. The space is in the flow, so a
  pushed-down last card ends exactly where it does, and the maximum no longer
  depends on where the gap is.
- **The spacer is not a slot.** It carries no `data-client-id`, so
  `columnGeometry` never counts it. It exists only in the column the pointer is
  over, and only when that column scrolls its own cards — in the stacked layout
  and on the pager it would be a page jump with nothing to fix — and it needs
  `shrink-0`, or a height-capped column squeezes it to nothing. The visible cost
  is one card of empty space: entering a short column moves its quick-add down by
  that much, and the drop fills exactly that space, so nothing jumps on release.
- **A gap that reads the end is not proof of where the card lands.** The release
  aims again, and under reduced motion the gap once showed the end slot while the
  drop went one above it. The claim is the stored order, read through the API.

### A tick is drawn only where it was made

- **The animation belongs to the gesture, never to the card mounting.** A tick
  draws in 180ms and then strikes the title through from the left, but only when
  the card renders its done state within 2.5s of a stamp the gesture wrote —
  clicking or pressing Space on a card, or ticking a step. A board opened on forty
  finished tasks draws them finished; a card that remounts in another column
  inside the window still draws; a tick arriving from another device does not,
  because nobody made the gesture here. Unticking clears both marks at once. The
  same shape as the settle's landing stamp, for the same reason.
- **Reduced motion cuts durations, not delays.** `app.css` shortens every
  duration under `prefers-reduced-motion` and leaves `animation-delay` alone, so a
  strike sequenced with a delay sits invisible for the delay and then snaps. The
  order of a sequence lives inside one keyframe instead, which is why the strike
  holds for its first 35% rather than starting late.
- **The strike is a growing background line with `box-decoration-break: clone`**,
  not `line-through` and not one scaled line: a single line crosses the middle of
  a wrapped title rather than each of its lines. A step's title is an `<input>`,
  which cannot carry it, so a step keeps an instant `line-through`.
- **A `$derived` over a non-reactive clock read is safe when a reactive value
  gates it.** `done && justTicked(id)` recomputes only when `done` changes, so the
  clock is read once per tick. The same read as a getter in markup would re-render
  for ever.
- **One place starts a pomodoro and goes to it**: `lib/todos/start-focus.js`
  calls `startPomodoro` and then `navigate('/focus')`, after the write reaches the
  device and never after the server, and imports nothing from `lib/pomodoro/`. A
  failed local save stays put rather than open a timer with nothing running.

### A shared list on the client

- **A write that files a task where this account cannot read it is decided when
  the write is built, and stored on the intent.** A member's cleanup sends tasks
  into the *owner's* archive, which the member cannot see, so the task has to
  leave this device rather than sit in the member's own archive until a read
  contradicts it. The store decides that once, as `away: true` on the queued
  intent — a field the server never receives — and the projection treats a
  marked intent as a delete without asking again. It *cannot* ask again: after
  an offline reload the snapshot no longer holds the task's old list, so there
  is nothing left to evaluate. The test cleans up offline and reloads offline
  for exactly that reason.
- **Leaving says that it is final from the member's side.** The confirmation
  reads *Leave Groceries? Its tasks leave your board, and only alice can share it
  with you again.* A confirmation that leaves out the one consequence the member
  cannot undo is asking a smaller question than the press answers. It is built as
  one string, so the owner's name cannot lose the space beside it.
- **`members: null` means the list is somebody else's, so the controls the
  server would refuse are hidden, not disabled.** Nothing a member can do makes
  rename, recolour, reorder, share or delete available, and a disabled control
  advertises a state that does not exist.
- **A list missing from a lists read takes its tasks off the device.** One rule
  covers leaving, being removed by the owner, and the owner deleting the list on
  another device.
- **A refusal about a list somebody else owns is reworded and re-read at once.**
  *That list no longer exists* becomes *Groceries is no longer shared with you*,
  and lists and tasks are read immediately rather than at the next
  revalidation, so the screen does not contradict the toast for ten seconds.
  Every other refusal keeps the server's own sentence. The server gives one
  sentence for a deleted list and a removed membership, so a member whose shared
  list was deleted reads the same words — a known imprecision, not a guess.
- **Leftovers of a list the board no longer knows are tested on a view that
  counts every list.** With no chip or column left to draw them in, a test
  looking at the board passes against a store that forgot nothing — the leave
  test did exactly that until it read the landing card's count with
  `/api/changes` blocked, so no revalidation could tidy up for it.

### A read can lose a write it outran, and a range cache does not change that

`ensureTimeEntries` and `ensurePomodoros` had no merge map at all, so a session
checked into or a pomodoro started while a read was in the air was dropped the
moment the queue drained: `overlayEntries` lays the *queue* over the reply, and
a drained queue has nothing left to lay. Both go through the same
`mergeDuringRead(loaded, mine, keyOf)` the answers and the tasks use, with
`null` tombstones for the two deletes — `forgetPomodoro`, and `replaceEntry`
handed no spans. Four collections, one mechanism.

The map is **global and keyed on `client_id` alone**, though both collections
are cached by range, and that is the part worth knowing: the store has no
ranges. It is one flat array, `loadedRange` is a claim about which days it is
*complete* for rather than a filter, `rememberEntry` has always added a row
without consulting either, and every view that draws a window clips for itself.
So a write whose day falls outside the reply is kept — which is exactly what the
local write already did; the merge only stops the read from undoing it. Keying
on the range would need somewhere to hold a write that falls outside it, and a
write may never be dropped: that somewhere is a second container, which is the
defect being fixed one level up.

`replaceEntry` is the sharp one. The shortened original and the part after the
gap are recorded in the order they were written and never further than `stored`,
from the same two values the store update uses, so the merge cannot reorder or
half-apply the pair. Recording only the identity the reply already held leaves
the deleted day gone and the hours after it quietly missing — which fails *a
session split while the sessions are being read is not put back together by the
reply* on the **total** rather than on the day.

**The two clears are only observable together.** Removing either one alone
passes the whole of `sync.spec.js`, because these reads share a single `once`
key: one is ever in flight, and whichever clear runs first empties the map
before any reply consults it. Removing both fails *a pomodoro re-created after
the read it was deleted during is read back*, which is the test that keeps the
pair honest. The clear where a read *begins* is the load-bearing half, since
without it the map would lay every local write over every later reply for ever —
and another device's edit arrives precisely *by* a read replacing this one.

One premise to keep in view if the range machinery is ever repaired: `wanted.start`
is set only when `loadedRange?.start` and `start` are both truthy, and the first
read stores both as `undefined`, so every later read is unbounded and shares one
key. A genuinely bounded read would put two reads of one collection in flight,
and then a read *starting* would clear a map holding writes the other still needs.

### Every calendar block spans its day

- **A block spans its whole day column unless it overlaps another as drawn.**
  Untimed tasks were content-width pills — a task called `Gym` measured 40px of
  a 150px column — which is what "short headlines make very small boxes" was. A
  timed block that overlaps another *as drawn* shares the width in lanes,
  because at full width one would cover the other and the calendar would be
  hiding a task. "As drawn" is the part that matters: a five-minute task is
  drawn half an hour tall, so it shares with one starting ten minutes later.
- **The untimed row's height is derived from the counts, not fixed.** Three
  tasks and then `+N more`, never `+1 more` — four are simply drawn, since that
  row would take the same room — and in week view it takes the tallest day's, so
  the columns stay aligned. Every grid coordinate is that height plus a top, and
  the drag reads it through a function at each aim: a drag still reading the old
  44px passed every existing test, which is why a drop onto a grown row has one
  of its own now. Shown in full, the row stops sticking, or a list taller than
  the scroll box would cover the hours for good.
- **When a crowded block cannot hold both its title and its time, the title
  wins.** The time is drawn on one line only if the title keeps at least 48px,
  and on two only if the 28px time fits. The column's width is the one value
  read back from layout here, and it decides only *which* text is drawn, never
  where anything goes. Three blocks at 07:00 used to read `07:00 07:00 07:00`,
  which is a picture of nothing.
- **Day mode names a day and steps a day.** The label and the arrows follow the
  mode, never the screen width, so a phone in week mode still steps a week.

- **A mark belongs to the layer of the thing it describes.** An untimed task's
  due mark is drawn in the sticky untimed row on its due day, because that row is
  opaque and sticky: drawn in the hour grid, it sat underneath the row at the top
  of the scroll and scrolled out of sight everywhere else, so switching on due
  dates showed nothing for most tasks. Its line runs in a sticky layer at the
  rows' own level, later in the page, joining slot centres, so it may run
  diagonally; a line is drawn only when both of its ends are on screen.
- **A due mark takes a slot after the day's tasks, and the cap counts it.**
  `+N more` counts tasks and marks together and names neither, which is true
  either way, while its accessible name spells out each kind. A task due on the
  day it is planned outlines its own slot instead of taking a second one, and no
  line is ever drawn to a mark hidden behind the count.

### A block's height is its estimate, and its bottom edge is the control

The resize grid is **30 minutes and deliberately not the move's 15**:
`SNAP_MINUTES` and `RESIZE_SNAP_MINUTES` are two names because a drop says
*where* a task starts and a resize says *how long* it is, so unifying them
silently changes one of the two gestures. A resize is not a move — dragging
above the block's own top cannot say anything about its start, so the size
clamps at the 30-minute floor and `planned_at` is untouched. A drag back to the
size it already had writes **nothing**, and the guard compares the *drawn* size
rather than the stored one, or a block with no estimate released where it
started would store a half hour nobody asked for. The live `1h 30m` label
exists because a box growing under a finger does not say what it will store,
and the live region says "resized to 1h" rather than a time, so a reader can
tell the two gestures apart.

**A control with one meaning lifts at once.** The movement threshold and the
touch short press exist to tell a tap, a scroll and a carry apart on a *block*;
a press on the resize handle can be nothing else, so it lifts immediately. The
corollary is that the afterglow which stops a release being read as a click has
to be stamped for **every** gesture rather than only the carry, because the
handle sits inside the button that opens the task.

### A colour on a task, and a menu on a press

**A tint percentage is a contrast measurement, not a taste.** A task's own
colour is a 3px edge bar at full strength plus a 12% tint mixed *into*
`ink-soft` — into the card's surface rather than over transparency, because the
card-against-page difference is what makes it read as a card. 12% and 16% were
indistinguishable on screen, so the numbers decided: the due chip's
`text-alarm` measures 3.18:1 against the card at 12% and 2.95:1 at 16%, worst
case amber. **A card paints only a colour chosen for the task** and deliberately
does not fall back to its list's, or every existing card would arrive tinted in
a colour nobody picked; a calendar block does fall back, because it has always
drawn the list's colour. `taskColour` holds that precedence once.

**An upsert is the whole row, so `todoPayload` names `colour`** beside every
other optional column — a payload that omits a field clears it, which is why a
drag, a tick, a cleanup, a calendar move and a resize all have to carry it. Four
tests fail when it is dropped, and none of them is about colour.

The menu is where the interesting rules are:

- **A long press for a menu must be longer than the lift *and* must not have
  moved.** 600ms against the drag's 150ms, aborted past the same 6px threshold:
  under the lift that distance is a scroll, over it a carry, and neither is a
  request for a menu. Opening the menu **cancels the carry**, so the card
  settles back exactly as Escape leaves it. A two-finger tap was the
  alternative and is worse — nothing else here asks for two fingers and the
  phone's own pinch claims the second.
- **The release that ends a long press is reported as a click on what was
  pressed**, so the menu carries a `justOpened` afterglow its readers consult,
  exactly as they consult `drag.justDropped`. That afterglow runs from the **release**, not
  from the opening: the click a browser reports on lift arrives however long the
  finger was held, so a 400ms window counted from the menu opening let any hold
  past a second open the task on top of its own menu. Any new press resets it, so
  a lift that never arrives cannot swallow later taps.
- **`lib/dismiss.svelte.js` owns the three global listeners now**, extracted
  from `pointer-label.svelte.js` rather than copied: the label's hover half is
  not what a menu wants, but the dismiss half is precisely what it wants. Two
  things that only surfaced once it was shared: the captured `pointerdown` is
  **observable only through a control that calls `stopPropagation`** — a card's
  tickbox — so that is the test that keeps the capture honest, and the
  pointer-label tests stay green without it; and **the scroll that opened an
  overlay is not the scroll that closes it**, because the browser scrolls a
  right-clicked control into view and delivers that event about 10ms later with
  the page already moved, so a scroll within 150ms of opening is ignored.
- **An auto-scroll stops on the room that is left, never on "the last step
  moved nothing".** The insertion gap displaces cards with a transform,
  transformed boxes count toward scrollable overflow, so a column's own maximum
  *grows* with the gap and shrinks again when the gap reaches the last slot — a
  clamp against a height a pending render is about to change satisfies the
  weaker condition and the scroll stalls, 40px short, with the pointer held
  still and nothing left to re-arm it. It reproduced two runs in five, which is
  what a measured regression looks like before it is a flake. And the room is read at the **start** of a tick,
  from the box as the previous render left it, never in the tick that re-aimed.
  Before the column held
  the carried card's height open at its end, the foot of a column running below
  the fold had no stable point: re-aiming moved the gap between the last two
  slots and the maximum with it, so a check made after re-aiming read no room in
  a box the next render was about to grow, and stopped one card short — under
  reduced motion only, where the gap does not ease in. Reading at the start of a
  tick stays, but it is the stable maximum that makes the stop correct now.
- **Hit testing respects `border-radius`.** A right-click two pixels inside a
  rounded card's corner lands on the wrapper behind it.
- A menu row is `min-h-11`, not padding arithmetic — `py-3` measured 42px. And
  `data-task-colour` on the card rather than `data-colour`, which the picker's
  swatches already use: one name, one meaning.

### The todo half has one frame, and content anchors left inside it

`Frame.svelte` is fixed by the window, never by the view: full width less the
gutter, capped at `max-w-todo-frame` (125rem — what Size in five columns
measured as needing, with the densest card's detail row on one line), and
centred. It owns the gutter, 12px on a phone and 20px from `sm`, as `--gutter`,
so rows that bleed to the screen edge use the same number and no page picks its
own. A column or quadrant board fills the frame; a stack keeps its 1112px
reading width and starts at the frame's left edge. *Centred* is what moved the
heading on every change of view — by 192px at 1280 and 512px at 1920 — not
*wide*, and a heading still lines up with the first column of a wide board.

- **A toolbar runs from stable to conditional.** Grouping pills first, then the
  list selector — whose place is kept under the Lists grouping, reading *Every
  list is a column*, and under the archive, where the pills keep their box — then
  the layout toggle pinned to the right edge. A control that can disappear sits
  to the right of everything that cannot, so its absence moves nothing that stays.
- **A control that appears because of task state keeps its place, or sits in a
  row that exists anyway.** *Clean up N done* lives beside the heading; *Move N
  to Later* and a Lists column's cleanup are drawn invisible, with no `data-`
  hook, when there is nothing to do. Only a confirmation opened by a press may
  take room. The first tick used to push a phone's whole board down 46.5px.
- **Below 48rem the category switcher is equal cells, never a scrolling strip**:
  Eisenhower is a 2×2 grid mirroring the matrix, Kanban and Date one row of four,
  Size three over two, Lists wrapping — each measured at 320. A column is never
  its own scroll box on a phone, nor on any window under 30rem tall: a phone held
  sideways at 844×390 counts as wide, and its capped columns hid cards behind a
  fade.
- **An empty-row reserve belongs to the grouping, not to the app.** On the phone
  pager every column's heading row is one height per grouping — a button's height
  if any column of that grouping draws a heading button, one text line otherwise —
  or stepping from Later to Past moved the first card 34.5px. Reserving a
  button's height everywhere cost 10px of the phone budget in Kanban, where no
  column has a button at all.
- **`scrollbar-gutter: stable` is reserved from 48rem, not below.** Headless
  Chromium reserves the room even while it hides the scrollbar, and
  `clientWidth` does not show it, so at phone widths it cost every layout 15px
  for a scrollbar that a real phone overlays anyway.
- **"Nothing moves" is tested by sampling every view and asserting the worst
  spread** — after `resizeTo`, which waits for the page to report its new size,
  never on the first frame after the test's own resize, where a gutter and a
  label were both still at their old widths.
- **A card's text is unselectable and a long press shows no callout**, on task
  cards and calendar blocks alike, or a long press on a chip selects text instead
  of lifting the card. Editing fields stay selectable. Chromium draws neither the
  iOS callout nor a long-press selection, so the computed `user-select` is what a
  test can assert.

Four more that came out of using the board rather than reading it:

- **Restoring focus after a write means awaiting the write.** `await tick()`
  finds the element still in its old column, does nothing because focus is
  already there, and loses it a microtask later when the projection lands — so
  a keyboard move worked exactly once and then went silent. `place` returns its
  write for that one caller.
- **An auto-scroll zone is measured against the visible part of the box**, on
  the board as in the calendar — and the *test* needs a window short enough that
  the box runs past the fold by more than the zone, or the probe on the clamp
  comes back green against a real bug.
- **A control that takes several rows away asks the same question one does.**
  Cleanup archived six on a single press while Delete asked about one.
- **Below 48rem a control group is one scrolling row, not a wrapping block —
  and fixing one group hands the saving straight to the next.** Fixing the list
  chips alone bought 8 pixels of 46, because five grouping pills then wrapped
  into the space it freed. A switcher cell and its column heading are **one name**:
  the count lives on the tab, and the hint, which a tab has no room for, stays
  on the column.

**A `<select>` in a row of pills is the tell that a toolbar was bolted on.** The
grouping control was the only one in four toolbars, where the time patterns page
switches five windows with five pills.

And a third instance of *rebuild before running the e2e suite*: **restoring
source without rebuilding is the same mistake wearing different clothes.** A
probe runner restored a tarball and skipped the build, so a whole mobile spec
"failed" against a bundle that still carried the mutation, and the page snapshot
naming a `combobox` was the only thing that said so.

### A seeded identity belongs to the test that seeded it

A task's `client_id` is unique across the whole database now that a list can be
shared — two members must resolve one task to one row, so the index cannot be
scoped per account. A worker's database outlives the accounts inside it, and a
module-level counter restarts with the worker *process*: so one real failure,
which makes Playwright replace that worker, restarts the counter against rows
that are still there and **every later seed in that worker is refused**. One
failure becomes a crop of them, which looks exactly like flakiness. Two rules
follow, and the second is about reading a run rather than writing one:

- `makeTodos` names an unseeded task with `crypto.randomUUID()` — what a real
  client sends, and exactly the 36 characters `SyncIntent.client_id` allows, so
  no prefix fits and none is wanted. A test passing a *literal* identity is
  fine only where the collection is still scoped per account, which today means
  steps (unique per task) and pomodoros.
- **Read the first failure in a worker, not the crop.** The rest may be its
  wreckage rather than four more defects.

And one small trap: **a test that reads "the block's last `<span>`" breaks the
day the block grows a control.** The half-hour clipping test read `.at(-1)` and
found the resize handle; it excludes `[data-resize]` now.

### What a control may say, and how a row is named

Five rules that came out of reviewing the task modal by using it:

- **A live second count has one spelling** — `formatRunning` in `lib/clock.js`,
  `0h 00m 02s`. Not the countdown's `M:SS`: that counts *down* to a boundary,
  where a clock face is right, while this reports an elapsed duration that grows
  past an hour. The modal shipped `0h 00m:02`, which is the colon of one form
  with the units of the other. `time/ProjectCard.svelte` still writes the two
  halves into two boxes with a gap and is the one place left to converge.
- **A native date or time input renders in the browser's UI language**, which
  nobody in this app chose — `09/12/2026` and `05:00 PM` beside cards reading
  `SAT, SEP 12` and `17:00`. It is still the right control on a phone, so the
  answer is never to replace it: each field restates its own value beneath
  itself through `dayLabel`, *the function the cards use*, so one value has two
  readings from one source.
- **Quote a row's own title inside its `aria-label`.** `Step ${title}` read
  "Step Step 1: chop onions" and `Move ${title} up` read "Move Step 10: wash up
  up". The quotes also stop one label being a prefix of another's — `Delete
  wash` names two buttons where `Delete “wash”` names one, which is the
  `getByLabel` substring trap one row deeper.
- **A gesture that moves a row out of the list you are looking at owes a toast
  naming where it went.** Won't-do had none, where starting a pomodoro — before it took you to the
  timer it starts — had one. Named from the list row and never
  from the word "Archive", because both system lists are renameable.
- **A control may not claim what its zone cannot see.** The modal's pomodoro
  button says what the press *does* — "Starting one ends a pomodoro already
  running" — unconditionally, rather than hiding or disabling itself, because
  which pomodoro is running is `lib/pomodoro/derive.js`'s rule and the todo zone
  may neither import it nor re-spell it. Said rather than prevented, like the
  note under the List select.

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

Measure what that costs before widening it, because it is narrower than it
sounds: **no duration and no day total is wrong**. Durations come from the
instants, and the slices still sum to them — a session from 23:00 CET to 10:00
CEST is ten hours, one on the day it started and nine on the next, on both
sides. What moves is only where the far end is *drawn*: it is shown ending at
09:00 rather than 10:00. `derivations.json` pins all of that — the corpus holds
a spring-forward session, an autumn-back one and one crossing the midnight that
ends a leap day, so a change to either implementation shows up as a difference
between them.

Leap years need no special handling anywhere and have none: every calendar step
goes through `Date.UTC` on the client and `date`/`timedelta` on the server, both
of which normalise. `day_of_year` is bounded at 366 rather than 365 for the same
reason. `lib/period.test.js` is where that is asserted — including the century
rule, since "every fourth year" gets 2100 wrong.

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

**The cheapest control is the migration's own `downgrade`.** A table you know
was only added to proves the check does not fire spuriously; the opposite
control — a table you know was *rebuilt* — proves it can fire at all, and a
revision that adds a column already ships one, because `drop_column` takes the
rebuild path. One extra `alembic downgrade -1` against the copy moved `todos`
from rootpage 23 to 112 where the upgrade had left it at 23 either side. That is
what makes "unmoved" a result rather than a check that cannot fail.

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

**The suite passes every run.** Not most runs — every run. There is no accepted
background rate of failure here, no `retries`, and no such thing as a test that
"sometimes goes red". A test that fails once in ten full runs is a defect that
has been found ten times more cheaply than it would have been in use, and the
only correct response is to reproduce it deterministically and fix the cause.
Every one investigated so far has been a real defect in either the app or the
test — none has been a timing artefact.

`--repeat-each` does not reproduce these; the whole suite does, because load is
usually the ingredient. Run it several times, read the *assertion* rather than
the test name, and do not move on until you can make it fail on demand.

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
- **Pin the timezone for the unit tests too, not only the browser.**
  `playwright.config.js` pins `Europe/Berlin`; vitest had no equivalent, so
  anything reading the *device's* clock was really testing where the person
  running it happened to be. `crossesClockChange` asks whether a range spans a
  daylight-saving change, and on a machine set to UTC — where there is none —
  its test failed with `expected false to be true`, which names neither the zone
  nor the reason. `vite.config.js` now sets `test.env.TZ` to the same zone, and
  the test asserts the zone it assumes so an unpinned run says so directly.
- **The e2e clock is set, not frozen.** Freezing stops anything animating from a
  time delta, and a canvas chart then draws its axes and no data at all. Use
  `page.clock.setSystemTime` and `fastForward`.
- **A poll is right for a positive claim and wrong for a negative one.** The
  same tool, opposite verdicts. Waiting for a chart to hold the counts it was
  given is a positive claim, and the first sample that satisfies it is a true
  one — so poll. "This page does not scroll sideways" is a negative one, and
  the first sample satisfies it before anything has rendered. A chart is
  *visible* before the data it draws has arrived, which is how an
  `expect(...).toBeVisible()` followed by a one-shot read of its options
  produced `[0, 0, 0]` about once per full suite run.
- **"More than four" is a floor with no margin.** The chevron test counted every
  `select` across three pages and required more than four; a healthy run saw
  exactly five, so losing one to a slow load failed it — about once per full
  suite run, passing alone. The read was one shot after `expect(main)
  .toBeVisible()`, which is the trap two entries below in its plainest form: a
  1500ms delay on `/api/catalogues` drops `/questions` from two selects to none
  and reproduces it every time. It waits for a **per-page** count now, which is
  a positive claim and so the right thing to poll, and the guard is the exact
  total rather than a floor. `/time/record` was contributing **zero** — its
  selects all sit inside panels — so the test opens the add panel, which is how
  a page named in the comment as where the bug was found came to be examined at
  all.
- **A poll cannot prove a negative.** `expect.poll` succeeds the moment *any*
  sample satisfies it, so polling for "this page does not scroll sideways"
  passes on the first frame — before the thing that overflows has rendered. It
  passed against the very toolbar it was written for. Sample repeatedly and
  assert on the **worst** value seen, and prove the test by reverting the fix.
- **Waiting for *a* request is not waiting for *your* request.** `savesView`
  waited for any `PUT /api/me/preferences`, and the save is debounced by 600ms —
  so a click made *before* the call could still be inside its window, and the
  request it eventually sent satisfied a waiter registered after it. The caller
  then reloaded believing its own change was safe and took the real save down
  with the page. One run in three, and only under a full parallel load. It waits
  for the page to stop saving now. Where a helper waits on traffic it did not
  cause, wait for **quiet**, not for one response.
- **A "flaky" test is a defect until measured otherwise.** Two tests failed
  about once per full suite run and passed alone. Neither was a timing artefact.
  One was a **read that failed and was cached as an answer**: `ensureTagRules`
  read `quietly`'s `null` as "this tag has no rule", wrote the blank into the
  cache and called the load complete — so the record reported *tracked* time
  where reported time belongs, and nothing ever asked again. That is the app
  inventing data, and the flake was the only thing saying so. `ensurePreferences`
  had the same shape with a worse ending: the page mirrors its state into
  preferences on the first frame, so a dropped `GET /api/me/preferences` saved
  the page's **defaults over the account's own** — a stored `week` measured
  becoming `month` on the server. Every `ensure*` that ends in `fetched.add`
  needs the guard: mark it fetched only on a confirmed read.
  - The guard on the *write* has to be narrow. Blocking saves whenever the copy
    was unconfirmed broke `an edit survives the settings load that was still in
    flight when it was made`, six runs out of six — an edit made while the read
    is outstanding is a real edit. Blocked only after a read has come back
    empty-handed. The probe that matters is the one that **widens** the guard
    and watches the in-flight test fail.
- **Poll both halves of a claim in one read.** The other flake was mine: I
  polled one series to `10.75`, then took a fresh `getOption()` and asserted on
  a different series, which read `0`. Two polls, or a poll and a later read, can
  each be satisfied by a *different* render. Read every positive claim out of
  one option object and poll that.
- **Two runs of the suite from two checkouts killed each other.** `global-setup.js`
  kept its worker databases and its registry of backends in
  `os.tmpdir()/happiness-e2e` — one fixed name, whatever directory the repo was
  checked out in. It opens by deleting that directory and by SIGTERMing every
  pid the registry names, so a second run started from a copy of the repository
  wiped the first run's databases and killed its live servers. In the *other*
  run that reads as a crop of `login as … failed`, or as a 30s timeout in
  whatever test was mid-flight — which is to say it reads exactly like an app
  flake, and two were written off as load before the cause was found. A
  different `BASE_PORT` does not help: the collision is the directory, not the
  port. `RUN_DIR` is now exported from `playwright.config.js` and keyed on the
  hash of that file's own directory, so every checkout gets its own and setup
  and teardown still agree on one answer from one place. `TMPDIR=<somewhere
  private>` is the same fix from outside, and is what to reach for against a
  checkout that predates this.
- **`context.setOffline(false)` does not fire the page's `online` event.** The
  app treats that event as the hint to go and look — `wake` probes, and a probe
  with writes waiting is a `flush` — so a test that only lifts the offline flag
  leaves the page waiting for the 30s `PROBE_EVERY` tick, which is the fallback
  for reconnects no event reports. Six specs dispatch `new Event('online')` by
  hand straight after it, and that is the convention. A hands-on review measured
  the badge staying *offline* for 25 to 35 seconds after reconnecting and
  reported it as a defect; it was the script missing that one line, which is
  exactly the caveat the review raised about itself.
- **A one-request test proves one queue entry only against sequential writes.**
  `Promise.all(moved.map(saveTodo))` still arrives as a single `/api/sync`
  request, because saves made in the same tick merge into one drain — so the test
  counting requests passes against the very mistake it exists to catch. The
  honest probe awaits each save in turn, and that one fails by name. The same
  trap `replaceEntry`'s probe met, one gesture along.
- **Text beside an `{#if}` in markup loses its whitespace.** Svelte trims the
  space at a block boundary, so a confirmation read "Later?They will be…" and
  three tests caught it. A sentence with a condition inside it is built as one
  string.
- **A mutation probe must refuse to start on a file that already carries one of
  its mutations.** Two probe runs over one checkout — or one script reached
  under two names — can back up a file the other run has already mutated and
  restore *that* as the original, which saves a probe as the fix:
  `if (false && cluster.length …)` turned up in `calendar.js` exactly that way,
  midway through a run. Give a probe script and its log a name nothing else will
  reuse, check for the mutation strings before taking any backup, and read the
  final diff for them afterwards.
- **A box on the page is not proof that anyone can see it.** The calendar's
  due-mark tests measured each mark's position and size, and passed while every
  mark for an untimed task was drawn underneath the sticky untimed row — an
  opaque layer two z-indexes above it — so switching on due dates showed nothing
  for most tasks. A claim that something is *visible* asks what is on top:
  `document.elementFromPoint` at the element's centre must return the element or
  something inside it. It cannot be answered off screen, where it returns `null`,
  so bring the element into the viewport first: the first measurement here,
  taken with the calendar opened at the current hour, found nothing at all,
  because the mark was 211px above the top.
- **A lookup that stops at the first match cannot see a thing drawn twice.** A
  `columnOf`-style helper returns the first column holding a task, so a done task
  drawn in Backlog *as well as* Done passed every existing test. A claim that each
  task sits in exactly one column has to count every column.
- **Prove a press does not wait on the server with the connection held open, not
  cut.** Offline a flush fails at once, so an offline test passes against a
  version that awaits the flush before navigating. Holding `/api/sync` open while
  online is the case that fails by name.
- **`page.unroute` settles the routes it was holding**, so a later
  `route.continue()` throws *already handled*. Release a held route with a flag
  the handler checks.
- **A task title is capped at 200 characters**, so a test that needs a title to
  wrap at 1280 has about 160 to work with.
- **`elementFromPoint` never returns a `pointer-events: none` element, and it
  hit-tests an SVG stroke dash by dash.** A "what is on top" test switches pointer
  events on and the dash pattern off for its one read. Without that, a correctly
  layered dashed line reads as covered, because its midpoint landed in a gap —
  which is exactly what it did, 4.4px in.
- **The config's `reducedMotion` never reached a page, so every run until it
  moved had motion on.** In Playwright 1.62.1, `use: { reducedMotion: 'reduce' }`
  resolves to `'reduce'` and is not applied: `matchMedia('(prefers-reduced-motion:
  reduce)')` read false in the built-in page fixture, and `test.use({
  reducedMotion })` failed the same way, while `browser.newContext({
  reducedMotion })`, `page.emulateMedia` and `contextOptions: { reducedMotion }`
  all read true. The config passes it through `contextOptions` now. A tick
  animation test is what noticed, by running its full 180ms under a config that
  promised otherwise, and the check that settled it carried a positive control,
  because a probe that can only read false proves nothing. A test that needs
  motion calls `page.emulateMedia` and asserts `matchMedia` before relying on it.
- **`expect.poll` gives up on a callback that throws.** It retries a *value*
  that does not match, not an error: a callback throwing *not yet* on its first
  call ended the poll on that very call. A helper that may run before the page
  has drawn returns `null` rather than throwing, so the poll can try again.
- **The reduced-motion reset gives every element a transition, including the
  ones that had none.** `app.css` sets `transition-duration: 0.01ms !important`
  on `*` under `prefers-reduced-motion`, and `transition-property` defaults to
  `all` — so under reduced motion every property change on every element runs
  through a real, if invisible, transition, and a synchronous `getComputedStyle`
  straight after a change returns the value from *before* it. A test that
  resolved four colour tokens through one reused probe element read every token
  after the first as the *first* colour, and passed until now only because the
  config's reduced motion had never been applied. Resolve a token through a
  **fresh** element, which has no previous value to transition from:
  `resolveColours` in `fixtures.js` does exactly that, and throws on an undefined
  token rather than quietly returning the inherited colour.
- **Test a behaviour that reads layout mid-render in both motion states, and
  prove the second one earns its place.** Reduced motion is a separate code path
  for anything that measures while something eases. The busy-column test runs
  once under the config's reduced motion and once after
  `page.emulateMedia({ reducedMotion: 'no-preference' })`, asserting `matchMedia`
  first; restoring the old stop rule fails only the reduced-motion case, which is
  the evidence that a single-state test passed against the defect.
- **A negative stability check samples the state that can cycle, not a value
  still easing.** The drop index is read ten times at the foot of the column and
  must be one value; `scrollTop` would not do, because with motion on it is still
  settling by a pixel or two when the index already agrees.
- **A probe that restores a layout must restore its children's classes too.**
  Putting back only the row's classes let the buttons keep their new sizing, so
  the row shrank instead of overflowing and the probe passed against the defect it
  was built to reintroduce.
- **A probe runner rebuilds in a `finally`.** A probe refused because its search
  string no longer matched skipped the clean rebuild after it, and the next test
  ran against a bundle still carrying the previous mutation.
- **Chromium does not return a slider thumb's computed style**: asked for the
  thumb, `getComputedStyle` answers for the whole input. Compare what is painted,
  decoded from a screenshot, instead.
- **A confirm step makes "the button is gone" prove nothing.** The first click
  already removes the button, before anything is deleted, so a test waits for what
  the delete itself changes before it reads `data-pending`.
- **One backend per worker.** `--workers=8` on a suite whose `global-setup.js`
  started seven sends the extra worker at a port with nothing on it, and every
  test there fails with `login as … failed`. That is the harness, not the app —
  reproduce load with the configured `WORKERS` (or `PW_WORKERS`), and read a
  sudden crop of login failures as having over-parallelised.
- **A screenshot inherits every saved preference.** Each capture must *set* the
  state it depends on, not assume it: a Patterns shot came out on the Day window
  with nothing tracked on it, because a shot earlier in the same script had left
  Day stored and the next run picked it up. It looked like the wrong page and was
  really the right page on the wrong window — the same trap as a smoothing slider
  that applies where its control is not drawn.
- **Screenshots need a producer, or they go stale.** `docs/screenshots` was
  hand-made, so nothing recorded how to remake one and a changed page meant a
  changed picture nobody knew to retake. `app/e2e/shots.mjs` takes them all
  against a running dev server. Not a Playwright *test*: it asserts nothing, and
  a run that cannot reach the server should say so rather than fail a suite.
  Screenshot from a **copy** when the development data has something in it you
  would not publish — and delete the copy, it holds a password hash.
- **Rebuild before running the e2e suite.** Playwright serves the *built* app
  out of `backend/static`, so a fix in `app/src` that has not been through
  `pnpm build` is not under test — the old bundle is. An afternoon went into
  "the fix does not work" that was really "the fix is not there", and the tell
  was a request the new code would have made appearing nowhere in the log.
  It cuts the other way too: `git stash` does not rebuild, so a baseline
  measured without one is the new bundle running the old tests.
- **A guard on a read has to cover the reads it is built on.** `ensureTagRules`
  marked itself complete when every tag's rule answered — over the tag list
  `ensureTags` handed back, which on an unconfirmed read is **empty**. Every rule
  over no tags answers trivially, so one failed `GET /api/tags` cached "no tag
  has a rule" for the life of the tab and the record reported *tracked* time
  where reported time belongs. The same defect as the one the guard was written
  for, arrived at one level down: `let complete = fetched.has('tags')`, not
  `true`. Reproduced by aborting the tag list once, which fails deterministically
  and prints the exact `" Errands  0h 30m  "` the suite had been flaking on.
- **Never hold a `route.fetch()` response across a wait.** An `APIResponse`
  belongs to the page and is disposed when it navigates, so a handler that
  fetches, awaits a release, and then fulfils dies with *Fetch response has been
  disposed* — under load only, which is what made a harness bug read as an app
  flake. Read what is needed into plain values first, or better, do not proxy at
  all: fetch the body through the account's own API context up front and fulfil
  from that. It is also a truer statement of the intent — what the server held
  *before* the edit.
- **A panel that opens before its data arrives must not be overwritten by it.**
  `openBands` showed the rule editor at once and then assigned the fetched rule
  over whatever was on screen, so a band added and a threshold typed inside that
  window were both wiped — on a tag with no rule, by an empty array. It is a
  slow, hand-edited form, so beating a round trip is ordinary. Two guards, and
  they cover different mistakes: a **token** drops an answer for a panel that is
  no longer the one open, and a **touched** flag drops one the person has already
  overtaken. Same rule `ensurePreferences` follows — an edit made while the read
  is outstanding is a real edit.
- **`data-sync` is debounced; `data-pending` is not.** The badge's state waits a
  second before saying "unsynced", so an ordinary tap does not flicker it — which
  means it still reads `synced` for the whole second after a write is queued. A
  test helper that waited on it therefore read the server *before the write was
  sent*. `data-pending` carries the raw count, set the moment the intent is on
  disk, and is what "the queue is empty" should be read from. **It reads `0`
  before the write is queued, too**, so waiting on it is only sound *after*
  something on screen has been asserted to have changed: a write reaches the
  outbox before it reaches the store, which makes the card, the tick or the
  count the proof that there is a queue at all. Two todo tests passed against
  the defects they were written for until a UI assertion was put in front of the
  badge — one of them by observing **no requests whatsoever**.
- **A count cannot see an edit.** The same helper polled until the server held
  one pomodoro with an id — which was already true before the edit under test,
  so tainting one was satisfied by the untainted row. A poll has to assert the
  thing the caller came to see, not a proxy for it.
- **Warm a snapshot on the last thing to arrive, not the first.** The landing
  page's catalogue comes from a *chained* pair — `ensureMe()` then
  `ensureCatalogue(...)` — so it lands after the four parallel loads. A test that
  warmed up by waiting for the time card and then reloaded restored a snapshot
  with no questions in it, and read "No questions yet" where "5 of 5 left"
  belongs.
- **A mutation probe that *hangs* is a finding, not a slow test.** Breaking the
  `unrecorded` guard in `verdictFor` did not fail the habit suite — it ran vitest
  out to a two-minute timeout, because that guard is also what terminates the
  streak walk. Twice I assumed a harness problem and raised the budget. The right
  reading is that the mutation turned a wrong answer into a frozen tab, which is
  a bug worth fixing in the code rather than routing around in the probe.
- **A dead-code scan is wrong three ways before it is right.** Sweeping for
  unused names here took three attempts, and each wrong one was confidently
  wrong: `git grep -h ''` does not dump file contents, so everything looked
  unreferenced including all 48 route handlers; counting raw text kept
  `TimeEntryCreate` alive on the strength of being **named in another schema's
  docstring**, which is a mention and not a use; and counting every `ast.Name`
  hid `ORIGINS`, because an assignment *target* is a `Name` too. The version
  that works parses each file and counts only `Name` nodes in **Load** context,
  and exempts anything with a decorator — a route handler has no call site and
  is still live. A scan reporting sixty dead names in a working application is
  the scan being wrong.
- **Check the harness before believing "vacuous".** A batch probe of three
  fixes reported all three untested; the probe was grepping `tail -3`, which by
  then held Playwright's trace hint rather than the summary line. Two of the
  three were fine. A tool that reports everything as broken is usually the
  broken thing.
- **A behaviour enforced twice cannot be probed by breaking one half.** The
  correlation ranking reads the filtered day set through *both* `seriesFor`'s
  default window and the `days` it is passed, and either alone produces the
  right answer — so two separate mutations each left the test passing and it
  looked vacuous. It was not: breaking both together failed it by name.
  Redundancy is a property of the implementation, not a weakness of the test,
  and the way to tell them apart is to break every path at once before
  concluding anything.
- **`toContainText` cannot see a plural go wrong.** "Streak · 1 days" contains
  "Streak · 1 day", so the assertion written to pin the singular passed against
  the bug it was written for — the same substring trap as `getByLabel`, one
  matcher along. `toHaveText` compares the whole (whitespace-normalised) string
  and catches it in both directions.
- **`hasText` cannot see an input's value.** A step's title is an `<input>`, so
  filtering rows on their text matches nothing however right the row is. Locate
  by the accessible names of the controls beside it — `Tick Buy food` — which is
  the one place the title is really text.
- **Scroll it into the middle before tapping inside a sticky scroll box.** The
  browser's own scroll-into-view knows nothing about a sticky overlay, so a row
  parked under 96px of sticky header counts as visible, the click lands on the
  header, and Playwright retries there until it times out. `intoView` in
  `todos-calendar.spec.js`.
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
| VAPID keys | `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are the one **optional** secret, all three or none. The others guard something, so missing them is unsafe and must fail loudly; these switch a feature on, so missing them means `/api/push/*` reports `configured: false` and the client never offers it. **Rotating them re-enrols every device** — silently, because nothing tells them. They live in the environment and never in the database, which `happiness-dump` copies |
| Second factor | TOTP, opt-in per account, asked for at login and nowhere else. **No recovery codes** — an admin clears a locked-out user, and `scripts/clear_totp.py` clears an admin. Wrong codes share the password's per-username budget. Turning one off, by anybody, bumps `token_version` so it cannot be done to somebody silently |
| Login attempts | 5 failures per username per 15 minutes, counted in process memory and cleared by a restart. Keyed on the **submitted username**, never the client IP — the app sits behind nginx and does not trust proxy headers, so every request would otherwise share one key. A locked username answers `429` whether or not the account exists |
| Schema | The server never creates tables. An unmigrated database fails with `no such table` |
| Deployment | A VM behind nginx doing SSL and a second auth layer. **The domain is an environment variable, never in the repo** |
| Answers | **Never deleted** — there is no delete endpoint, and none should be added. Re-answering a day *does* overwrite, last-write-wins on the device's own clock (`test_repeated_answers_upsert_rather_than_duplicate`); this row used to read "never rewritten", which the upsert has contradicted for some time. A session, by contrast, is corrected and deleted freely. The rule protects what a **person** recorded: a migration deleted 635 server-written auto-tracked rows on request, every value of which was recomputable, and that is the only kind of answer that may go |
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
| Deleting a session | Takes **the day whose row was tapped**, never the whole session. A session drawn across several days is drawn as one row per day, clipped to it, so Delete there shortens the session — or splits it in two where a middle day goes. A row marked *kept whole* is one row and one session and goes entirely, and the button names the day it takes so the label cannot promise something else again |
| A running session losing a day | Keeps running when it loses a **past** day, and **stops** at that midnight when it loses the day it is running in. One left open would re-accumulate the day just deleted and be back on the screen a second later — which is also why deleting a single-day running session removes it outright |
| A running pomodoro | Is in the day's list and climbs the totals from the moment it starts. It carries no edit or delete control — an end time still moving is not something to correct — and it is **excluded from the transfer**, which needs a duration that is final. The card says so rather than quietly offering less |
| Focus sounds | Synthesised, not shipped. **"None" stays a valid choice**, which is why audio cannot be relied on to keep a backgrounded tab alive — and so why a pomodoro finishing while the app is closed is reported late. See `PUSH_NOTIFICATIONS_PROPOSAL.md` |
| Habits | An enum question with a target, in both directions. **No tap-to-answer on the landing chip** — a habit is answered in the questionnaire like the ordinary question it is, and a tick could not offer a three-way choice anyway |
| Habit periods | `day`, `week`, `month`. No quarter or year: nothing anybody keeps four times a year needs an app, and each one is another grid that would draw two cells |
| Habit icons | An emoji on `questions.icon`, on **every** question rather than only habits, and outside the habit constraints. Only habits render it today; tying it to them would be a constraint to relax the first time an ordinary question wants one |
| Inbox and Archive | Ordinary **rows**, provisioned per account, renameable and recolourable, never deletable. Matched on `kind` and never on the name, or a rename is a bug |
| A planned date | **Mandatory.** A task with no date is a task nothing can draw, and *someday* is a list rather than a missing column |
| The archive's order | By arrival, `archived_at`, which the server writes. Editing an archived task does not move it |
| Size drops | To the bucket's **centre**, always — a stated exception to the smallest-distance rule, because the buckets are coarse guesses and the centre is the more useful number |
| Todo → Pomodoro | **Named by the link, never by a copy.** A typed line becomes a real task and the pomodoro carries `todo_client_id`; retitling the task retitles the hours, and a linked block's task box is read-only here. `task` stays beside it as the fallback for a block whose task this device does not hold |
| Shared lists | One **owner** and any number of **members**, invited by username. Members see and edit every task; only the owner renames, recolours, reorders, shares or deletes. Inbox and Archive are never shared. A shared list's done tasks clean up into the **owner's** archive, decided by the server from the task's list, and a task has **one** active clock across everyone. A member may also **move** a task out of a shared list into one of their own, taking it off everyone else's board: deleting it is already theirs to do, and a move is less than a delete — the owner's three answers |
| Past, not overdue | The date grouping's first column is **Past**: a task planned before today is not overdue unless it is *due* before today. A planned date is never drawn red; a due date is red once it has passed, so a task due today is due rather than overdue — the owner's call |
| Kanban Done | **Every done task** in the selected lists, whatever its planned date — the same set cleanup archives, so the column and the button show one number. A drop into it ticks and never moves the date. The owner's call, replacing the brief's *ticked and planned for today* |
| The streak view | Ignores the day filters, and carries its own span in periods — **12 or 26, never 52**: a year of weekly cells gave every lane its own sideways scroll, which is a control that makes the page worse at the width most of it is read at. Reaching further back is Previous and Next, stepped a whole window at a time, which costs no width. A streak over "only Saturdays" is not a streak — the target says *per week*, and narrowing the days silently changes what that means |
| Navigation | The landing page is the only bridge between the halves; none of the four *links* to another, not even where one writes into the next. **One gesture navigates across, at the owner's request**: starting a pomodoro from a task opens the focus view. A navigation made by an action, not a link, and the only one |
| Beartype | Test-time only. The image is built `--no-dev` and a running server never imports it |
| Ruff | Backend only, via pre-commit. Lint rules, plus the numpy docstrings below |

## Type the shape, not the container

`str` is not a type for a value with three legal spellings; it is the absence of
one. Write the shape out — `Literal["day", "week", "month"]` — and the reader,
the checker and the generated client all learn the same thing at once.

The habit columns are where this was settled. `habit_period` was going to be
`Mapped[str]` with the three values named in a docstring, which is how `kind`,
`origin` and `aggregate` were already written. `Literal` was asked for instead,
and it turned out to be the more telling type in four separate places:

- **The API surface says it.** `@hey-api/openapi-ts` reads the OpenAPI schema
  into `app/src/lib/generated/types.gen.ts`, and the two styles land in *the same
  file* looking like this:

  ```ts
  habit_period?: 'day' | 'week' | 'month' | null;   // from Literal
  kind: string;                                     // from str
  origin: string;                                   // from str
  aggregate: string | null;                          // from str
  ```

  A `Literal` crosses the wire and keeps its meaning. A `str` arrives as
  `string`, and every caller is back to reading a docstring — or guessing.
- **`Literal` is a closed set, so a checker can see an unhandled case.** A match
  over `HabitDirection` is exhaustive or it is an error; a match over `str` is
  never either.
- **It reads as the definition.** `HabitPeriod = Literal[...]` with a docstring
  saying *why* there is no quarter is the one place that question is answered.
- **The constraint follows from it**, rather than being a second, parallel list
  that can drift. `HABIT_PERIODS` exists only because a `CheckConstraint` needs
  the values as data.

**SQLAlchemy needs the column type spelled out anyway.** It infers `String` from
`Mapped[str]` but infers nothing from `Mapped[Literal[...]]`, so the annotation
and `mapped_column(String(8))` are both required — measured as `VARCHAR(8) NULL`
in the built schema rather than assumed. That is not a cost: the length was
always a decision worth making explicitly.

Where the value is genuinely open, say so and keep the pattern. A project's
`colour` stays `str` with `COLOUR_PATTERN`, for the reason the icon field is
bounded only by `max_length`: the palette gains tokens, and a value from a later
one must not start answering 422.

**`{object}` is the JavaScript spelling of the same mistake.** `@param {object}
pomodoro` type-checks as "a value with no properties", so every field read off it
is an error the moment anything looks. The precise type is *already generated* —
`PomodoroOut`, `TimeEntryOut`, `AnswerOut` and the rest are in `types.gen.ts`, and
`@param {import('../generated/types.gen').PomodoroOut}` costs one line and ties
the function to the contract the server actually publishes. Regenerate with
`pnpm api:generate`.

This is the payoff worth keeping in view: precision on the server propagates
outward for free, and imprecision is lost at the boundary and cannot be recovered
on the other side.

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
