# Time tracking — plan

*Fifth iteration. Multi-tag and reporting-only are settled, and your three UX comments
are folded in: the two halves become genuinely separate sections bridged only by the
landing page, and the time section gets its own accent colours over the shared type and
layout system. The fifth-round changes are the navigation split, the appearance
section, and the closing rows of Resolved; ★ marks everything newer than the second
draft.*

A second thing to track daily: which project the day's hours went to. Check in to a
project, check out when you stop, and read back where the week went. Several timers may
run at once — a "work" timer with a "meeting" inside it — which is the decision that
shapes most of what follows.

## Why this is not a question

The tempting move is to make a project a `Question` and a session an `Answer`. The
scores work has just shown how much comes free once something is a question — the
record table, the export, the stats page, the whole store. It should still be resisted,
and concurrency makes the case stronger than it was:

- **An answer is one value per question per day.** `answers` is unique on
  `(user_id, question_id, day)`. A day has several sessions per project, and they may
  overlap each other.
- **An answer records a moment's judgement; a session records an interval** — one that
  can outlive the day it began in.
- **An answer is never rewritten. A session is corrected**: you forget to check out, you
  check in to the wrong project, you reconstruct yesterday afternoon by hand.

Two tables that mean different things. What they share is the user, the local-day
convention, and the visual language — and that sharing is where the work is, not in a
common schema.

## Data model

★ Four tables now, all new, so the migration stays a pure `create_table` and cannot
rebuild an existing one — which is what the migration guard checks for.

**`projects`** — what the iOS app calls a timeline. **Owned by one user.**

| Column | |
| --- | --- |
| `id` | |
| `user_id` | FK users, cascade — a project belongs to whoever tracks it |
| `name` | 80 chars, unique **per user**, not globally |
| `colour` | palette token, stored, so a project keeps its colour across every chart |
| `position` | display order |
| `active` | archived projects stop being offered but keep their history |
| `created_at` | |

Per-user ownership has three consequences worth stating, because they are easy to miss:
`is_editor` plays no part — every signed-in user manages their own projects; another
user's project id must answer **404**, the way answers already behave; and a brand new
account has *no* projects, so `/time` needs a real empty state that creates the first
one inline rather than pointing at an admin page.

★ **`tags`** — a label over projects, so stats can group "Backend", "Reviews" and
"Standup" into one "Work" number.

| Column | |
| --- | --- |
| `id` | |
| `user_id` | FK users, cascade — per user, like projects |
| `name` | 80 chars, unique per user |
| `colour` | palette token, stored, same reasoning as projects |
| `position` | display order in the tag view |

★ **`project_tags`** — which projects a tag covers.

| Column | |
| --- | --- |
| `project_id` | FK projects, cascade |
| `tag_id` | FK tags, cascade |
| | unique on the pair |

Two deliberate asymmetries against projects. **Tags may be deleted**, not just
deactivated: entries reference projects, never tags, so deleting one destroys no
history — it only unlabels. And tagging is **many-to-many**: "Standup" can be both
*Work* and *Meetings*. What that costs is that by-tag numbers stop being a partition —
see [Grouping by tag](#-grouping-by-tag) below.

**`time_entries`** — one check-in and the check-out that ends it.

| Column | |
| --- | --- |
| `id` | |
| `user_id` | FK users, cascade |
| `project_id` | FK projects, **restrict** |
| `started_at` | UTC instant |
| `ended_at` | UTC instant, **null while running** |
| `utc_offset` | minutes east of UTC at check-in — what makes local midnight knowable |
| `note` | optional, short |

There is **no `day` column**. With sessions split at midnight, no single day owns a
session, so storing one would be a field that contradicts what the reports say. Day
attribution is derived on read — the same call that was made for scores, for the same
reason: a derived number stored is a number that can disagree with its own definition.

`project_id` does not cascade: deleting a project that has entries would silently delete
the hours. Projects are deactivated, not deleted — the rule questions already follow.
Entries also never reference tags: a session belongs to a project, and the tag view is
a regrouping of project numbers, so re-tagging a project retroactively re-groups its
whole history. That is the correct behaviour for a label, and it is the score-definition
argument again — a grouping stored per entry would be a grouping that can disagree with
the labels.

**Deactivating a project with a running timer is refused** (409, "check out first").
The alternative — letting the timer run on a project the UI no longer offers — creates a
session that can only be ended through the API.

### One invariant, not three

The first draft had three. Concurrency removed two of them: entries **may** overlap, and
a user **may** have several running at once, so neither is a rule to enforce. What
survives is narrower and still worth the database's help:

**At most one *running* entry per project per user.** Checking into a project you are
already checked into is meaningless, and without this it silently produces two entries
that no UI can tell apart. A partial unique index says so:

```python
Index("uq_open_entry_per_project", "user_id", "project_id",
      unique=True, sqlite_where=text("ended_at IS NULL"))
```

Verified against the versions in this repo. It renders
`CREATE UNIQUE INDEX ... ON time_entries (user_id, project_id) WHERE ended_at IS NULL`;
it admits two projects running at once for one user, the same project running for two
users, and any amount of closed history; and it refuses a second open entry on one
project with an `IntegrityError`. Autogenerate will probably not reproduce the `WHERE`
clause, so that line gets written by hand and asserted in a test.

`ended_at > started_at` stays as a `CheckConstraint` — a fact about the row.

### Instants, offsets, and local midnight

`started_at` and `ended_at` are UTC instants, and `utc_offset` is the client's offset in
minutes at check-in. Local time is `instant + offset`, which is what makes "when was
local midnight" answerable on the server.

Storing bare local datetimes instead would be simpler and matches how answers store a
bare local `day` — but a duration is not a day. Across a daylight-saving change, local
arithmetic reports an eight-hour day as seven or nine. From UTC instants the duration is
exact, always, and the offset is only used to decide which day a slice falls in.

The honest caveat: a session that spans a DST change carries one offset, so its *local*
rendering can be an hour out on the far side of the change. Twice a year, and the
duration stays correct.

### Splitting at midnight

A session from 22:00 to 02:00 gives two hours to each day. Done as a service function
over the interval, not as stored rows:

```python
def daily_slices(entry, as_of) -> list[tuple[date, int]]
```

One session stays one row, so correcting a check-out time is still a single-row edit,
and the slices always sum to `ended_at - started_at` exactly. `as_of` is what a
*running* entry is measured up to — supplied by the client with the request, so the
server does not have to guess the user's clock and the screen and the export agree.

### ★ What the numbers mean

Simplified from the last round, because dropping "covered" (your answer to question 1)
resolves most of it. Every reported number is **tracked time: the sum of per-project
durations**. With parallel timers, a day's total can exceed 24 hours — 8h of work with
1h of meetings inside it reads **9h** — and that is correct, not a bug to smooth over:
it is what "sum over projects" means. The record view, where sessions are visibly
parallel bars on a day, is what keeps that intuition honest.

One consequence survives for the charts: with overlap possible, a stacked column's
height is the tracked sum, **not** wall-clock time, and nothing in the UI should caption
it as "hours of the day".

### ★ Grouping by tag

The patterns view gets one toggle: **by project / by tag**. Grouping happens on the
server, in the same place the midnight split happens, so the screen and the export
cannot drift:

- A tag's number for a day is the sum over the projects it covers.
- A project with two tags counts fully toward **both** — by-tag numbers overlap
  exactly like parallel timers do, and for the same reason: tags are views, not
  partitions. The UI states this once, in the tag view's caption.
- Projects with no tag are grouped under **Untagged**, so the tag view always accounts
  for every tracked minute rather than silently hiding unlabelled work.

If you want by-tag numbers that *do* partition — every project in exactly one group —
that is a discipline in how you tag, not a different feature; question 1 below asks
whether the UI should enforce it.

## API

Projects and tags, scoped to the signed-in user — no editor flag anywhere:

```
GET    /api/projects                    the user's own, active first, tags included
POST   /api/projects                    {name, colour, tag_ids}
PUT    /api/projects/{id}               rename, recolour, reorder, deactivate, re-tag
DELETE /api/projects/{id}               only while it has no entries
GET    /api/tags                        ★
POST   /api/tags                        ★ {name, colour}
PUT    /api/tags/{id}                   ★ rename, recolour, reorder
DELETE /api/tags/{id}                   ★ allowed always — unlabels, destroys nothing
```

Time, all naming the project, because with concurrency "check out" alone is ambiguous:

```
POST   /api/projects/{id}/check-in      {at, utc_offset}     -> 201 the new entry
POST   /api/projects/{id}/check-out     {at}                 -> 200 the closed entry
GET    /api/time/entries?start&end      sessions overlapping the range, running included
POST   /api/time/entries                {project_id, started_at, ended_at, utc_offset}
PUT    /api/time/entries/{id}           correct either end, the project, or the note
DELETE /api/time/entries/{id}
GET    /api/time/summary?start&end&as_of&by=project|tag   ★ per day, already split and grouped
GET    /api/time/export.xlsx?start&end     one row per session; totals sheets per project and per tag ★
```

Six notes:

- **`DELETE` exists here**, where it was dropped for answers. A check-in to the wrong
  project is not a correction of a record, it is a row that should never have existed —
  and while it exists, it counts.
- **`POST /api/time/entries` is in v1**, per your answer: reconstructing a session you
  never started live is as common as forgetting to stop one.
- **Check-in never closes anything.** Two timers running is a supported state, not an
  accident to be tidied up.
- **`/summary` is server-side**, now including the tag grouping. The midnight split and
  the regrouping have to happen exactly once, or the export and the screen will disagree
  the first time either rule changes.
- **Range reads from the start.** `?start&end` returns every session *overlapping* the
  window, not only those beginning inside it, or the session running across the boundary
  disappears.
- **The export** carries sessions on one sheet and the daily totals on two more — per
  project and per tag — from the same `daily_slices`, so the spreadsheet matches the
  screen by construction.

## What the user sees

### The landing page

`/` becomes the chooser and the questionnaire moves to `/answer`. That is the one change
here that touches existing code broadly: the nav, the record table's "Answer" buttons,
and 35 `page.goto('/')` calls across six e2e specs.

The page is not a menu — both cards say something before you touch them:

```
  ┌──────────────────────────────┐  ┌──────────────────────────────┐
  │ WELLBEING                    │  │ TIME                         │
  │ 6 questions, none answered    │  │ ● The rewrite      2h 14m    │
  │ today                        │  │ ● Standup          0h 12m    │
  │                              │  │                              │
  │ [ Answer today ]             │  │ [ Check in ▾ ]               │
  └──────────────────────────────┘  └──────────────────────────────┘
```

Every running timer is listed, each with its own stop control. With nothing running, the
card offers the projects to start.

★ **The landing page is the only bridge between the halves.** Per your comment, there
is no cross-navigation — inside wellbeing the nav reads *Answer · Record · Patterns*
(plus Questions and People where the flags allow), inside time it reads *Track · Record
· Patterns · Projects*, and neither lists the other's pages. The logo is the way home
from both. That dissolves the two-Records-two-Patterns naming problem from the last
round without a grouped menu: within a section the short labels are unambiguous again.
Account-level pages — Settings, People, Sign out — stay reachable from both sections,
since "change my password" should not require remembering which half owns it.

### ★ A section that looks related, not identical

Your comment asked for a different appearance — other colours, same fonts — without
losing the family resemblance. The palette mechanism the app already uses makes this
nearly free, and it was verified against the built stylesheet before being written
down: Tailwind v4 compiles `bg-dusk` to `background-color: var(--color-dusk)`, so the
time section's root element can **remap the accent variables in one scoped rule** —

```css
.section-time {
  --color-dusk: /* the time accent */;
  --color-dusk-lift: …;
  --color-ember: …;
}
```

— and every button, ring and highlight inside recolours itself, with no second set of
component classes and no `bg-time-*` utilities to forget (the silent-missing-token trap
in CLAUDE.md cannot occur, because no new class names are minted). Ink, paper, haze,
the type treatment, `.meta`, `.numeral`, spacing and radii are untouched — the two
sections share everything except temperature. The wellbeing accents stay the purple
dusk / ember pair; time gets its own pair, proposed as a **teal/cyan family** (working
name `tide`), which sits far enough from dusk to read as a place, not a theme bug.
Chart series keep the shared `PALETTE`, so a colour in a chart means the same thing on
both sides; project and tag colours come from their stored tokens either way.

**The check-in control borrows the answer card**, per your comment. Answering's one
good interaction — a full-width card, one obvious tap, immediate visual confirmation —
is exactly a check-in: each project is a band-style card with its colour as the leading
edge, tapping it starts the timer and the card "lights" the way a chosen answer band
does, with the elapsed time where the scale would be. Stop is a tap on the lit card's
control, not a hunt for a small button. The same card grammar carries to the landing
page's time card, so the app has one tactile language for "record something now".

### Time

`/time` — the projects as answer-style cards, each a start/stop toggle, several
possibly lit at once. Elapsed time ticks in the browser from `started_at`; no polling.
The empty state creates the first project inline; everything beyond creation lives on
`/time/projects` (your answer to question 3).

**While anything runs, the browser tab says so**: `▶ 2:14 · The rewrite — Daily
tracker` via `document.title`. Toggl's single best small feature — a still-running
timer is noticed at a glance instead of after three accidental hours. One line of code,
reverted on check-out.

★ `/time/projects` — the admin section: reorder, recolour, archive, and **tags** — both
the tag list itself and each project's tag chips. One page for both keeps the
tag-a-project loop in one place; a tag with no projects left is visibly idle there
rather than silently lingering.

`/time/record` — **also the editor**. Sessions by day, each with its start and end
editable in place, a delete, and an "add a session" row for one that was never tracked
live. A session crossing midnight appears on **both days**, clipped, marked as
continuing (your answer to question 2). The same left/right day navigation and
one-day-at-a-time mobile treatment the answer record already has.

Each past session also gets a **restart** control: one tap opens a new session on the
same project now. Timery is built almost entirely around this idea — yesterday is
usually the best prediction of today.

`/time/patterns` — bars per project per day or week, a share-of-total donut, and a
weekday breakdown, ★ with the **project / tag toggle** switching what the series are.
Reuses `chart-options.js` and the palette, so the two halves look like one app.

**No forgotten-check-out warning and no auto-close**, per your answer. A session running
for three days shows up as exactly that in the record, where it can be edited; the app
does not invent an end time it cannot know.

### Naming

★ The grouped nav from the last round is gone — section-local navs made it unnecessary,
since "Record" is unambiguous once you are inside a section. The product keeps its name
for now; renaming to **Daily tracker** is a separate pass over the header, the README,
the page title and the Docker labels.

## What other trackers do

A look through [Timelines](https://timelines.app/) (the app being replaced),
[Toggl Track](https://toggl.com/), Timery and [Clockify](https://clockify.me/), sorted
by verdict rather than by app.

**Adopted into v1** — cheap now, expensive to retrofit:

| Idea | Seen in | Where it landed above |
| --- | --- | --- |
| Concurrent timers | Timelines — its reviews call this the standout | Already the core of the model |
| ★ Tags with grouped reporting | Toggl, Clockify | Your request; the `tags` table and the patterns toggle |
| Restart a past session | Timery's saved timers, Toggl's "continue" | The record view |
| Running timer in the tab title | Toggl | `/time` |
| Notes on a session | all of them | The `note` column |
| Export | Toggl, Clockify | `/api/time/export.xlsx` |

**Worth doing, not v1** — each needs the model to not rule it out, and none does:

- **Targets with feedback.** Timelines lets you set daily/weekly hours per category and
  celebrates hitting them. Ruled out of v1 by your answer to question 5; it fits later
  as a nullable `weekly_target_minutes` — ★ now more naturally on `tags` than on
  `projects`, since "8h of Work a week" is a statement about a group.
- **A vertical day timeline.** Timelines' signature view — the day as a column, sessions
  as blocks, overlaps side by side. Genuinely better than bars for *seeing* a nested
  meeting inside a work block. The record's bar view ships first because it reuses the
  answer record's layout; this is the natural second view of the same data.
- **Reminders** ("you usually track by 9:30, nothing is running"). Needs notifications,
  which means the shelved PWA plan; pointless before it.
- **Calendar export** (ICS feed of sessions). Small, self-contained, pairs well with the
  vertical day view.

**Looked at and rejected** — so the next reading of this plan does not re-litigate them:

- **Idle detection and auto-tracking** (Toggl, Clockify, Timing). Requires an agent
  watching input or window focus; a self-hosted web app cannot see either, and the
  entire appeal of this tracker is that it records what you *say*, not what it
  surveils.
- **Pomodoro modes.** A different product wearing the same timer.
- **Billing, rates, invoices, clients, teams.** ★ Tags now carry the "group my
  projects" need; a client/project *hierarchy* stays rejected — one flat list of
  projects, one flat list of labels over them.

## ★ Non-functional requirements

Two, both structural, both cheaper to honour from the first commit than to retrofit.

**Everything reads from the store after the initial load.** The wellbeing half already
works this way — `store.js` loads answers, catalogues and preferences once, deduplicates
in-flight requests, and moving between pages refires nothing. The time half is held to
the same standard from the start:

- `projects`, `tags` and `timeEntries` live in the shared store with `ensure*` loaders;
  opening `/time/patterns` after `/time/record` costs **zero** requests.
- Mutations update the store in place, the way `rememberAnswer` does — a check-in
  appends the entry locally from the response, it does not refetch the list. The ticking
  timer is derived in the browser from cached `started_at`; it never touches the
  network.
- Entries are cached **with the range they were loaded for**: a request for a wider
  window fetches only what extends it, and a request inside an already-loaded range is
  answered from memory. The store remembers the covered range, not just the rows.
- The one deliberate exception: `/summary` totals are recomputed server-side and are
  therefore fetched per grouping — but they are small, and they are cached per
  `(range, by)` until a mutation touches an entry inside the range.

**The codebase separates into three zones** — wellbeing-specific, time-specific, and
overarching — and imports only ever point *inward* to the shared zone, never across:

| | Wellbeing | Time | Overarching |
| --- | --- | --- | --- |
| Backend routers | `routers/catalogues.py`, `answers.py`, `stats.py` | ★ `routers/time.py` (projects, tags, entries, summary) | `auth.py`, `users.py` |
| Backend services | `services/wellbeing.py` — question, score and system-answer rules | ★ `services/timetrack.py` — `daily_slices`, duration rules | `services/__init__.py` re-exports both, so existing imports survive |
| Frontend routes | `routes/wellbeing/` — Questionnaire, Table, Stats, Catalogue | ★ `routes/time/` — Track, Record, Patterns, Projects | `routes/` — Landing, Login, Settings, Users |
| Frontend lib | `lib/scale.js`, `lib/series.js` | ★ `lib/duration.js` (format `2h 14m`, slice client-side mirrors nothing — display only) | `lib/store.js`, `api.js`, `router.js`, `chart-options.js`, `day.js`, the palette |

The rule that keeps it honest: **time code never imports from wellbeing code or vice
versa** — if both need something, it moves to the shared zone and the move is the
signal it was overarching all along. `models.py` stays one file (SQLAlchemy metadata
wants one registry) but keeps the three groups visibly sectioned. Turning `services.py`
into a package is the one refactor of existing code this requires; it is mechanical,
`CHECKED_MODULES` already covers it by the `services` name, and it is **step 0** in the
sequence below so the new code lands sorted rather than being sorted afterwards.

## Plumbing

The unglamorous list, so the estimate is honest — each of these bit a previous feature
that forgot it:

- `pnpm api:generate` after the endpoints exist; the generated client is committed.
- `store.js` grows the `projects` / `tags` / `timeEntries` stores with the caching
  behaviour the NFR section pins down — range-aware, mutations in place.
- The guard-matrix test walks `app.openapi()` — the new routes are auth-checked
  automatically, but its allowlist of public paths must *not* grow.
- New backend modules go into `CHECKED_MODULES` in `tests/conftest.py` only if they are
  new top-level names; `routers/time.py` is already covered by the `routers` package.
- `scripts/seed_answers.py` gets a sibling `seed_time.py` — a few projects ★ under two
  tags with one project in both, sessions with a lunch gap, an overnight one, and an
  overlap, so `/time/patterns` has something to show in both toggle positions. The e2e
  fixtures want the same shapes.
- Ruff and the docstring rules apply as everywhere; the pre-commit hook already covers
  new files.
- README: routes, the two-section nav, the export, and a screenshot per new view.

## Tests

**Backend** (`tests/test_time.py`) — the things that are easy to get wrong:

| | |
| --- | --- |
| Two projects running at once | both are open, both are counted |
| The same project checked into twice | refused by the *database*, not only the service |
| Two users may run the same-named project | the index and the name uniqueness are per user |
| Check-out on a project with nothing running | 409, not a silent no-op |
| `ended_at <= started_at` | 422 |
| 22:00 → 02:00 | 2h to each day, and the slices sum to the exact duration |
| A session spanning three days | a slice for each, including the full middle day |
| A running entry | counted up to `as_of`, and not beyond |
| Overlapping entries | explicitly **allowed** — this was forbidden in the first draft |
| Parallel timers in the totals | 8h work with a 1h meeting inside reads 9h — documented, asserted |
| ★ Tag grouping | equals the sum of its projects' totals for the same range |
| ★ A project with two tags | counts fully in both tag groups |
| ★ Untagged projects | appear under Untagged, so the tag view misses nothing |
| ★ Deleting a tag | entries and totals by project are untouched; the tag view regroups |
| ★ Re-tagging a project | changes historical tag totals — a label is a view, not a record |
| ★ Another user's tag | 404, like projects and entries |
| `?start&end` | returns a session that merely overlaps the window |
| Another user's project or entry | 404 |
| Deleting a project that has entries | refused; deactivating is the way |
| Deactivating a project with a running timer | 409 until checked out |
| The export | totals sheets equal `/summary` by project and by tag for the same range |
| Manual creation and editing both ends | round-trips, and re-splits correctly |

**End to end** (`app/e2e/time.spec.js`):

- Check in to two projects → both timers show → reload → both still counting from the
  same instants → stop one → the other keeps running.
- A session added by hand from the record table appears in the totals.
- Correcting a check-out time updates the day's total.
- The landing page reports both running timers and routes into both halves.
- Restarting yesterday's session starts a new timer on the same project.
- ★ Tag two projects on `/time/projects`, flip the patterns toggle, and the grouped
  number equals the two projects' sum.
- Moving `/time/record` → `/time/patterns` → back fires no further entry requests —
  the same store test the stats page already has ("revisiting makes no requests").
- ★ Inside `/time` the nav offers no wellbeing pages and vice versa; the logo lands on
  the chooser from both.

One warning from these fixtures: the suite **sets** the clock rather than freezing it,
because a frozen clock stops anything animating from a time delta — a canvas chart once
drew its axes and no data at all when time stopped. A counting timer is exactly that.
Use `page.clock.setSystemTime`, and `page.clock.fastForward` to assert elapsed time
instead of waiting in real time.

## Sequence

| Step | | Shippable? |
| --- | --- | --- |
| 0 | ★ `services.py` becomes the `services/` package with a `wellbeing` module; `routes/` gains the `wellbeing/` folder — pure moves, both suites stay green | yes — a refactor, nothing user-visible |
| 1 | All four tables, the migration with the hand-written partial index, `daily_slices` and the duration rules in `services/timetrack.py`, with unit tests | no |
| 2 | Project, ★ tag, and check-in/check-out endpoints, scoped per user | no |
| 3 | `/time` — projects, concurrent timers, tab title, the inline empty state | **yes** — the daily loop works |
| 4 | The landing page and the questionnaire's move to `/answer` | yes |
| 5 | `/time/record` — the day view, editing both ends, delete, manual entry, restart — and ★ `/time/projects` with tag management | yes |
| 6 | `/summary` with both groupings, `/time/patterns` with the toggle, and the export | yes |

Step 3 is the first point where the feature does anything; everything after reads back
what it records. Stopping after 4 leaves a working tracker with no reporting. ★ Tags
sit in the schema from step 1 but do nothing visible until 5 — deliberately, so the
migration never needs a second pass.

## Later

Not v1, listed so the model above does not rule them out. The first four are argued in
[What other trackers do](#what-other-trackers-do):

- **Targets per tag**, with progress on `/time/patterns`.
- **A vertical day timeline** as a second view of the record.
- **Reminders**, once the PWA plan is revived.
- **Calendar export** (ICS).
- **Shared projects.** `projects.user_id` becomes nullable, or a join table appears.
  Nothing should assume a project has exactly one owner forever — in particular, `name`
  unique per user would have to become unique per *sharing scope*, ★ and tags would
  need an answer to "whose labels apply to a shared project".
- **Hours as a variable on the patterns page.** A project's — ★ or a tag's — daily
  total is exactly the shape of a computed question: a number per day nobody answers.
  Through `/api/stats/variables` it would let the existing scatter view plot hours
  against mood with no new charting code. Keep `time_entries` readable from the stats
  side.
- **Offline check-in.** One small write with a client timestamp — the easiest thing in
  this app to make offline-first, easier than answering.
- **Renaming to Daily tracker.**

## Resolved

| | |
| --- | --- |
| Project ownership | Per user. Sharing is a later feature, not the MVP |
| Midnight | Sessions are split; the split is derived on read. In the record view a crossing session shows on **both days**, clipped |
| Concurrency | Several timers may run at once; overlap is normal, and check-in never closes anything |
| Manual entry | In v1, alongside editing both ends, and it lives in the record table |
| Landing | `/` is the chooser; the questionnaire moves to `/answer` |
| Naming | Keep the name for now; group the nav. "Daily tracker" is a later pass |
| Precision | Seconds stored, `2h 14m` displayed, seconds never shown |
| Long sessions | Never auto-closed, no warning — a multi-day session is a hand-editing job |
| ★ "Covered" | Not computed, not shown. Every number is tracked time, and a >24h day under parallel timers is correct |
| ★ Project management | Creation inline on `/time`; everything else on `/time/projects` |
| ★ Colours | Stored on the row, for projects and tags both |
| Targets | Not in v1 |
| Tags | In v1: per-user, many-to-many over projects, deletable, grouped server-side, Untagged bucket |
| ★ Multi-tag | Yes — a project may carry several tags, and by-tag numbers may overlap |
| ★ Tags in the UI | Patterns and the export only; the record and landing speak projects |
| ★ Cross-navigation | None — each section has its own nav, and the landing page is the only bridge |
| ★ Appearance | Time gets its own accent pair via a scoped CSS-variable remap; type, spacing, ground colours and chart palette stay shared |
| ★ Check-in control | Styled after the answer card: full-width band, one tap, lights while running |

## Still open

1. ★ **Which accent for the time section?** The mechanism is settled; the hue is taste.
   A teal/cyan `tide` family is proposed — cool against dusk's purple, distinct at a
   glance in a screenshot — but this is a pick-from-a-swatch decision best made against
   the running app in step 3. [assumed: teal, adjusted on sight]

2. ★ **Do Settings and People appear inside both section navs, or only on the landing
   page?** Both-navs keeps "change my password" one tap away anywhere; landing-only
   keeps the section navs strictly about their section. [assumed: in both navs, at the
   end, where Settings already sits today] 
