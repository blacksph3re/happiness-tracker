# Todos — a fourth area

*Third draft, and **nothing in it is open**. Every question from both rounds is
answered and folded in; where an answer changed the design rather than confirming
it, the section says so. Nothing is built. `[verify]` marks the two things I
could not settle from the repository — both are checks to make while building,
not decisions to make before it.*

*The second round moved two things. The archive is ordered by **when a task
arrived in it**, which puts back a column the second draft had removed — as a
timestamp now, never as the state. And a drop places a task **exactly where it
was dropped**, in every grouping, which deleted a special case rather than adding
one and brought a live insertion gap with it.*

**The three claims the plan rests on.** One of the first draft's three is gone:
*inbox and archive are described, not stored* was answered the other way, and
what replaced it came out of the subtask answer.

| | |
| --- | --- |
| **Six of the seven views are one board** | List, side-by-side, kanban, Eisenhower, size and move-between-lists differ in exactly two functions: which columns tasks fall into, and what dropping into a column does. One component, six grouping modules, three layouts. The calendar is the only genuinely different picture |
| **A subtask is not a task** | Your answer, and it is worth more than it looks. Steps get their own table, so `todos` never needs a `parent_id IS NULL` filter that somebody will one day forget, and *one level deep* stops being a rule nothing can enforce and becomes a fact about the schema |
| **A drag writes exactly one row, and can never fail to find a place** | Fractional string ranks, `between()` total by construction, and the drag that would make a key unwieldy rebalances its own column in the same gesture. Question 16 asked for this to be solved properly rather than bounded; it is, and the reasoning is in *Ordering* |

---

## Settled by your answers

Restated as one table so none of it is re-derived later. **Bold** marks the six
that changed what I had proposed.

| | |
| --- | --- |
| Views | Two pages and a grouping selector — Tasks and Calendar — plus Lists |
| Calendar due-date toggle | A hollow block at the due date, joined to the planned block by a thin line; tasks with no due date untouched |
| Planned date | Mandatory, *for now* — the cost of changing that later is named below |
| Won't do | Move to the archive list, unticked. So won't-do is *in archive ∧ not done*, and cleaned-up is *in archive ∧ done* |
| Size drops | The bucket's **centre**. This view is a stated exception to the smallest-distance rule |
| Subtasks | Title, tick, icon, order. **And they are not tasks** — see the claim above |
| Roll-up | No automatic parent tick. A `2/3` counter on the card and in the modal |
| **Inbox and archive** | **Real rows, created with the account.** Neither can be deleted. The archive has no cleanup button |
| **Deleting a list** | **Cannot take archived work with it** — an archived task is in the archive list, not in the one being deleted |
| Cleanup | The list you are looking at, every done task in it, whatever its planned date. Not offered on the archive |
| Dates | Day-first. `2026-06-14` always works |
| **The parser** | **Colours the text in place as you type**, and clicking a coloured run turns it back into plain text. Not chips |
| Pomodoro with no text | Stays an unnamed pomodoro; no todo created |
| Ranks | Strings |
| Active time | Two columns, to start with |
| **Rank exhaustion** | **Structurally impossible** rather than bounded and hoped about |
| Settings | The preferences document, section `todos` |
| `pomodoros.todo_id` | A real foreign key |
| **Markdown** | **`marked`**, plus `DOMPurify` — measured at +4% of the gzipped bundle |
| **The archive** | **One request, newest first, capped at 500 with a cursor.** Not by year, and never in the device snapshot. The arithmetic is below |
| Steps | Their own table |
| The two system lists | Renameable and recolourable; never deletable |
| **Archive order** | **By when a task arrived in the archive**, and no dragging within it |
| **Where a dropped task lands** | **Exactly where it was dropped**, in every grouping — with the cards below it opening a gap as the pointer moves |
| A retitled task | The focus history follows it, which is what *ownership transferred* means |

---

## Where it goes

A fourth zone, and the table in `CLAUDE.md` gains a column:

| | Wellbeing | Time | Focus | **Todos** | Shared |
| --- | --- | --- | --- | --- | --- |
| Routers | `catalogues.py`, `answers.py`, `stats.py` | `projects.py`, `time.py` | `pomodoro.py` | **`todos.py`** | `auth.py`, `users.py`, `admin.py`, `changes.py`, `sync.py` |
| Services | `wellbeing.py` | `timetrack.py` | `pomodoro.py` | **`todos.py`** | `clock.py` |
| Routes | `routes/wellbeing/` | `routes/time/` | `routes/pomodoro/` | **`routes/todos/`** | `routes/` |
| Lib | `lib/wellbeing/` | `lib/time/` | `lib/pomodoro/` | **`lib/todos/`** | `lib/store.js`, `api.js`, `day.js`, … |

### Two files move to the shared zone on the way in

Both are the familiar signal — a second caller appears and the import would
point *across* — and both are cheap moves made now rather than late:

| Moves | Why |
| --- | --- |
| `lib/time/palette.js` → `lib/palette.js` | A list has a colour, and it should be the same six tokens a project uses. `PROJECT_COLOURS` becomes `CHIP_COLOURS`; the constraint it documents (never a token a section rebinds) now has four sections to hold against |
| `lib/wellbeing/icons.js` → `lib/icons.js` | A task and a step carry an icon that replaces the tickbox, and it must be *chosen, never typed* — the whole point of that module. `ICON_MAX_LENGTH` is already at module level in `models.py`, so the server side needs nothing |

Nothing else crosses. The todo zone reads `day.js`, `period.js`, `clock.js`,
`resource.svelte.js`, `pointer-label.svelte.js` and `store.js`, all already
shared. **The one place a cross-zone import would be tempting is the pomodoro
handover**, and it is handled the way Focus already reaches Time: the shared
store exports `saveTodo` and `todos`, so Focus imports *inward* and `lib/todos/`
is never named from `lib/pomodoro/`.

### A fourth accent

`.section-todo` rebinds the same four variables the other two do. The palette
needs a family that is none of the three sections and none of the six chip
colours — so not teal, not the purple, not the orange, and not `sage`:

```css
--color-fern: #3f7d4e;
--color-fern-deep: #2c5a38;
--color-fern-lift: #5aa869;
--color-lime: #9fc94a;   /* the section's `ember` */
```

`[verify]` Judged from hex values, not on a screen. `sage` (`#6f9e8b`) is the one
to check it against: a list coloured sage inside the todo section must not read
as the section's own accent.

---

## The data model

Three tables. The shape follows the *answer* side of the days-and-instants rule
rather than the session side, and that is deliberate: **a plan is a local date,
not an instant.** "Feed the cat tomorrow at nine" means nine o'clock wherever you
are, so `planned_on` is a `DATE` and `planned_at` a `TIME`, with no `utc_offset`
beside them — exactly as an answer carries a client-local `day`. Only the columns
recording *something that happened* — done, activated — are UTC instants.

```python
TodoPriority = Literal["very_high", "high", "medium", "low", "very_low"]
"""How a task ranks against the others. Ordered highest first, and the order is
the metric: `PRIORITIES.index` is what "one step less important" means."""

PRIORITIES: tuple[TodoPriority, ...] = (
    "very_high", "high", "medium", "low", "very_low",
)

ListKind = Literal["ordinary", "inbox", "archive"]
"""Which of the three a list is.

A `Literal` rather than two booleans, and never matched on the *name*: the two
special lists are ordinary rows that can be renamed, so any code reading
`name == "Archive"` is a bug waiting for somebody to rename it."""
```

### `todo_lists`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `user_id` | FK users CASCADE, indexed | Everything belongs to somebody |
| `name` | `String(60)` | Not unique — two lists called *Home* is the owner's business |
| `kind` | `String(8)` | A `ListKind`. What the code branches on, always |
| `colour` | `String(16)` | A `CHIP_COLOURS` token, same pattern a project uses |
| `rank` | `String(255)` | Column order in the move-between-lists view |
| `created_at`, `updated_at` | | `updated_at` feeds the digest |

```python
# At most one inbox and one archive per account, and no ceiling on ordinary
# lists. This is also what makes the provisioning helper below idempotent
# rather than merely careful.
Index("uq_list_kind", "user_id", "kind", unique=True,
      sqlite_where=text("kind != 'ordinary'"))
```

### `todos`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `user_id` | FK users CASCADE, indexed | |
| `list_id` | FK todo_lists CASCADE, **NOT NULL** | Every task is in a real list, the inbox included |
| `client_id` | `String(36)` | The device's identity, partial-unique per user, as `TimeEntry` and `Pomodoro` |
| `title` | `String(200)` | The one mandatory field besides the date |
| `description` | `Text` nullable | Markdown |
| `planned_on` | `Date` **NOT NULL** | |
| `planned_at` | `Time` nullable | Wall clock. NULL puts it in the calendar's *anytime* row |
| `due_on` | `Date` nullable | Feeds Eisenhower's urgent axis and nothing else |
| `priority` | `String(9)` nullable | A `TodoPriority`. NULL is *not important* by definition |
| `duration_minutes` | `Integer` nullable | An estimate, not a measurement |
| `icon` | `String(16)` nullable | Replaces the tickbox when set |
| `rank` | `String(255)` | Order within its column |
| `done_at` | `DateTime` nullable | UTC. The tick |
| `archived_at` | `DateTime` nullable | UTC. **When** the task last entered the archive — never *whether* it is in one |
| `active_since` | `DateTime` nullable | UTC. Non-NULL **is** the active state |
| `active_seconds` | `Integer` default 0 | Time banked from earlier activations |
| `client_updated_at`, `server_received_at` | | As every queued row carries |
| `created_at`, `updated_at` | | |

### `todo_steps`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `todo_id` | FK todos CASCADE, indexed, NOT NULL | Ownership is reached through the task, as a `DeductionBand`'s is through its tag |
| `client_id` | `String(36)` | Its own identity, so ticking a step is one intent rather than a rewrite of its parent |
| `title` | `String(200)` | |
| `icon` | `String(16)` nullable | |
| `rank` | `String(255)` | |
| `done_at` | `DateTime` nullable | |
| `client_updated_at`, `server_received_at`, `created_at`, `updated_at` | | |

**This table is what your answer to question 6 bought.** With subtasks as rows in
`todos` — which is what the first draft proposed — *every* query in the feature
carries `parent_id IS NULL`, the depth rule is a service check I had to admit
SQLite could not enforce, and a subtask has five columns that must never be set.
As its own table there is no filter to forget, no depth to check, and no column
that means nothing. A step has four fields because a step is four fields.

**The wire carries the parent's `client_id`; the database stores the real key.**
A step created in the modal of a task that is itself still in the outbox has no
`todo_id` to point at, so `step.upsert` names its parent by `client_id` and
`apply_step` resolves it. Intents replay in order, so the parent is already
applied — and where it was refused, the step is refused with *that task no longer
exists*, which is exactly what `apply_answer` already says about a missing
question.

### What is deliberately not here

| Not a column | Because |
| --- | --- |
| `is_done` | `done_at IS NOT NULL`. One fact, one place |
| `wont_do` | Won't-do is *in the archive list ∧ `done_at IS NULL`*. Both routes into the archive are already recorded |
| `archived_at` as a *state* | Being archived is `list_id == archive`. The column is back since the second draft, but it records **when** a task arrived and never **whether** it is there — see below |
| `is_active` | `active_since IS NOT NULL` |
| `is_inbox` | `kind == 'inbox'` on the list |
| `parent_id`, `depth`, `has_children` | There is no self-reference to describe |
| A `todo_activations` table | Your answer: columns to start with |
| A rank rule for changing list | Deleted by your answer. A drop places a task where it was dropped, so there is no *lands at the top* to write down |

**Active time is two columns rather than a table, and it is the one place this
design steps away from "derived on read".** The pure version is an activations
table shaped like `TimeEntry`, summed on read, with retrospective correction
free. You chose the simpler start, so `active_seconds` is the primary record of
past activations rather than a derivation of one — the way `pomodoros.focus_seconds`
already is. The upgrade path is clean if it is ever wanted: the table is additive
and `active_seconds` becomes its opening balance.

**`archived_at` is a timestamp, not a flag, and the distinction is the whole
reason it is safe to have.** The second draft removed it because a column saying
*this is archived* can disagree with the list the row is actually in. Ordering
the archive by arrival needs a date that nothing else supplies — `updated_at`
reorders the archive whenever an archived task is edited, and `done_at` is absent
on everything marked *won't do* — so the column comes back with a narrower job:
set when a task enters the archive, cleared when it leaves, and **read only for
rows already known to be in it**. There is no state for it to contradict, because
it is never asked about state.

---

## Inbox and archive are provisioned, not described

The first draft had them as `list_id IS NULL` and an `archived_at` flag, which
cost nothing to create. As rows they cost three things, and all three are small:

| | |
| --- | --- |
| A helper | `services/todos.py::ensure_system_lists(db, user_id)`, insert-if-absent for both kinds. **One definition of what the two lists are** |
| Two call sites | `routers/users.py::create_user`, beside `build_from_template`; and `bootstrap()`, which is already idempotent and runs at every startup |
| A migration | Two inserts per existing account. Insert-only — no repointing, no deletion — which is the safest kind there is, and `tests/test_migrations.py` walks the chain and fails on a lost row |

The partial unique index above is what makes the helper safe to call from
anywhere as often as anything likes: a second attempt cannot produce a second
inbox. That is worth more than the care in the helper, because it holds even
when somebody adds a third call site without reading this.

What the rows buy, and what the flags could not: the two lists have a **name and
a colour** like any other, they are **columns in the move-between-lists view**
rather than pseudo-columns synthesised beside it, and dragging a task *out* of
the archive names the destination explicitly — so restoring something needs no
memory of where it came from.

Both refuse deletion with `409`, and cleanup is not offered on the archive.
Renaming and recolouring are allowed; the code never reads the name.

---

## Ordering, and why a place to drop can never run out

Question 16 asked for this to be solved cleanly and robustly rather than bounded
and hoped about. Here is the whole of it.

**`between(before, after)` is total.** Between any two distinct strings there is
always another — append a mid-alphabet character and you have one — so there is
no pair of neighbours the function can be handed and fail on. The first draft's
64-character bound was the only thing that could have made it fail, and it is
gone: the column is `String(255)` and the function never consults a limit. Two
equal keys, which two devices inserting offline into the same slot can produce,
are handled by the same rule that sorts them: the order is `(rank, client_id)`,
and `between` on a tie extends the first.

So the bad outcome is not failure. It is keys that keep getting longer, and the
pattern that causes it is real and ordinary: **always adding at the top of a
list.** Each prepend can cost a character, and after a few hundred the keys are
silly even though nothing is broken.

**The fix is that the drag which would make a key unwieldy rebalances its own
column, in the same gesture.** Above a soft threshold of 16 characters, instead
of one upsert the drop emits one `enqueueAll` re-ranking that column with short,
evenly spread keys and the task in its new place. No background job, no periodic
scan, no device-wide sweep — the operation that would have degraded is exactly
the operation that repairs it, and the person is standing in front of it.

Three things make that safe here that would not have made it safe elsewhere:

- **There is no ordering hazard inside the batch.** The rule `replaceEntry` has
  to respect exists because two writes to overlapping sessions on one project are
  merged by the server if they arrive the wrong way round. Todos have no overlap
  rule and no `merged` outcome, so a rebalance is a set of independent row
  writes and their order is immaterial.
- **Two devices rebalancing the same column offline is survivable.** Last change
  wins per row, so the result is one device's ordering, or an interleaving of
  two. An interleaving is still a total order with nothing lost, and the next
  drag corrects it. That is the same class of outcome as any two concurrent
  edits to one task, not a new failure.
- **The 500-intent cap is already handled**, by the chunking described under
  *Cleanup* below. Without it a 600-task column could not be rebalanced.

The frequency is worth stating, because it decides whether any of this matters:
starting from one character, a rebalance is due after roughly fifteen
consecutive inserts into the *same* gap, and it resets the column to one
character again. Fifteen drags into one spot between two tidy-ups is not a
pattern anyone will notice paying for.

Steps use the same helper. A task has few of them and integers would do, but two
ordering implementations is one more than this feature needs.

---

## The API surface

**There is no `POST /api/todos`.** Writes to tasks and steps go through
`/api/sync` and nowhere else, exactly as sessions and pomodoros already do —
which is what makes the offline path the only path, so it cannot rot from disuse.

```
GET    /api/todos                      everything outside the archive, with steps
GET    /api/todos/archive?limit=&before= newest first
GET    /api/todos/lists
POST   /api/todos/lists
PUT    /api/todos/lists/{id}           name and colour; 409 on a system list's kind
DELETE /api/todos/lists/{id}           409 when kind != 'ordinary'
```

Lists are online-only CRUD, like projects and tags and for the same reason: a
container is not something you make on a train. The consequence to name is that
a task created offline needs its list's id from the snapshot, so a device that
has never once synced cannot create one — the same limitation as checking in to a
project it has never heard of.

Steps come back **nested inside their task** and eagerly loaded, or it is an N+1
of exactly the kind `Variable.component_ids` already had to be warned about.

Four new sync intent kinds:

| Kind | Names its subject by | Notes |
| --- | --- | --- |
| `todo.upsert` | `client_id` | Create and correct alike, as `entry.upsert` is — a correction to a task another device deleted re-creates it, which falls out rather than being special-cased |
| `todo.delete` | `client_id` | Cascades to its steps in the database |
| `step.upsert` | its own `client_id`, parent by `todo_client_id` in the payload | |
| `step.delete` | `client_id` | |

`services/sync.py` gains `apply_todo`, `delete_todo`, `apply_step`, `delete_step`,
written against the three rules the module already states: latest change wins by
the device's clock, a delete never beats an edit, ties go to what is stored.
**Nothing merges.** A task has no extent, so there is no overlap rule and no
`merged` outcome — the one thing that makes sessions complicated does not arise.

### Cleanup is the first gesture in this app that can wedge the outbox

Worth finding now rather than in use. `SyncRequest.intents` is capped at **500**,
and `drain()` sends the whole queue in one request with no chunking — so a
cleanup archiving six hundred done tasks builds a body the server answers 422 to.
That path in `drain` falls into `if (error || !data)`, which sets the connection
back to `online` and **returns without retiring anything**, and `CLAUDE.md`
already records that nothing retries a rejected drain. The queue is then stuck
for ever, and not only for todos: every answer and session behind it is stuck
too, behind a badge saying some writes are waiting.

Nothing here is new — the cap and the dead end both exist today. What is new is a
single button that reaches them, and now a rebalance that can too. So `flush`
chunks at the cap, rather than cleanup doing it: the next feature with a bulk
gesture would otherwise have to remember this one.

`/api/changes` gains `todos`, `todo_steps` and `todo_lists`: eleven aggregates
instead of eight. The count-and-timestamp pair earns its keep in both directions
here — a tick is an edit a count cannot see, and moving a task to the archive is
an update the timestamp catches while the count does not move at all.

---

## The store

```js
export const todos = writable([])        // everything outside the archive, steps nested
export const todoLists = writable(null)
export const archive = writable([])      // newest first, loaded only when looked at
```

`ensureTodos()`, `ensureTodoLists()`, `ensureArchive({ before })`, `saveTodo`,
`saveTodos` (one `enqueueAll` — cleanup, and a rebalance), `saveStep`,
`removeTodo`, `removeStep`, `rememberTodo`, `forgetTodo`; `overlayTodos(rows,
queue)` in `projection.js`, keyed on `client_id` like `overlayEntries` and
folding step intents into the nested arrays; `todos` and `todoLists` join
`PERSISTED`, and **`archive` deliberately does not**.

**There is no range.** Sessions and pomodoros cache by the window asked for
because history is unbounded and irrelevant; an open task from March is neither.
`ensureTodos()` loads everything outside the archive once and the cache key is a
boolean, not an interval — simpler than `ensureTimeEntries`, and worth saying out
loud so nobody copies the range machinery in by reflex.

### How big the archive actually gets

Question 20 asked for the arithmetic rather than a guess. A task serialises to
roughly **400 bytes** of JSON — the timestamps and the two uuids are most of it.

| Tasks finished per day | Per year | After ten years |
| --- | --- | --- |
| 3 | ~1,100 rows, 0.4 MB | 4.4 MB |
| 10 | ~3,650 rows, 1.5 MB | 15 MB |

So *not at all* is right for years and wrong eventually, and a year-based pager
is more UI than the problem deserves. `GET /api/todos/archive` returns the newest
**500 by `archived_at`** with a cursor — about six months at three a day, 200 KB — and the view
grows a *Show older* control only once there is a cursor to follow. The archive
never enters the device snapshot, which is what keeps the offline footprint
bounded no matter how long the account lives.

Its order is arrival, newest first, and **nothing can be dragged within it**: a
task reaches the archive by being finished or abandoned, never by being placed,
so a rank there would be a number with no meaning and a gesture with no effect.
Dragging a task *out* of the archive is the ordinary positional drop, and lands
where it is dropped like every other.

**The one collection here with no ceiling is `todos` itself**, because done tasks
stay in the list until cleanup and cleanup is a button nobody has to press. That
is the brief's rule and it is the right one; the mitigation is to make the
pressure visible rather than to change the rule, so the cleanup button carries
its count — *Clean up 37 done* — and says what it will do before it does it.

Every view takes the shape the `loading` rule demands, with no local `$state`
holding fetched data:

```js
const loaded = resource(() => key, () => Promise.all([ensureTodos(), ensureTodoLists()]),
                        { name: 'todos' })
const tasks = $derived(($todos ?? []).filter(...))
const loading = $derived(loaded.loading && tasks.length === 0)
```

---

## The views

### The decomposition

| The brief's view | Grouping | Layout |
| --- | --- | --- |
| Task-list | `date` — overdue / today / tomorrow / later | stacked |
| Side-by-side | `date` | columns (≥ 48rem only) |
| Kanban | `board` — done / active / planned / backlog | columns |
| Eisenhower | `matrix` — important × urgent | quadrants |
| Size | `size` — five duration buckets | stacked or columns |
| Move-between-lists | `list` — one column per list, the inbox and archive among them | columns |
| Calendar | — | its own component |

So the app gains **two pages and a selector**: a board page whose grouping and
layout are chosen by a control and remembered per account, and a calendar. Five
of the seven are the same screen, and as seven pages they would have been five
places to fix the same drag bug.

A grouping is one object, pure, in `lib/todos/groupings.js`:

```js
{
  id: 'date',
  label: 'Date',
  layouts: ['stacked', 'columns'],
  columns(tasks, today, settings),      // [{ id, label, hint, tasks }]
  drop(task, columnId, today, settings) // a FIELD patch, or {} for no change
  preset(columnId, today, settings)     // what the column's quick-add fills in
}
```

**A grouping decides the fields; the drop point decides the rank.** They are
computed separately and neither knows about the other — `drop` never returns a
`rank`, and `between()` never asks which column it is in. That separation is what
made your answer to N4 a deletion rather than an addition: *place it where it was
dropped* is already what the ranking half does, in every grouping, so the
"changing list sends a task to the top" rule the second draft proposed simply
went away.

**`drop` returning `{}` is what makes an in-group drag a pure reorder.** The
brief asks for that behaviour explicitly; expressed this way it is not a special
case in the drag handler but a property of every grouping, and one assertion
covers all five.

### The board

`lib/todos/Board.svelte` — columns of `TaskCard`s, a quick-add at the foot of
each, drag between and within. Three CSS arrangements of the same markup:
stacked, columns (a horizontal row, suppressed below 48rem via the existing
`wide` store — *the side-by-side view does not exist on mobile* becomes one rule
rather than one view), and quadrants for Eisenhower.

A card shows the tickbox — or the icon in its place — the title, and a quiet row
of whatever is set: time, duration, priority, due date, **the step counter `2/3`
when there are steps**, the list's colour dot when the column is not already a
list. Tapping the tickbox ticks. Tapping the title opens the modal. Everything
else is inert, because a card with two actions is already the most this codebase
allows in one tile.

**Adding: `+` focuses an inline quick-add in that column, with the column's
preset applied.** The brief asks for an inline box in the list view and a modal
in the Eisenhower view; one behaviour is better than two, and inline is the one
that works with a thumb. The modal is one tap further on, from the card just
created.

The `list` grouping earns a note of its own now that the archive is a real
column: **dragging a task out of the archive restores it, and the destination is
the column you dropped it on.** Nothing has to remember where it came from, which
is the second thing the rows bought over the flag.

### Drag and drop is pointer events, not the HTML5 drag API

Not a preference. `dragstart`/`dataTransfer` does not fire from touch at all, so
the HTML5 API cannot implement this feature on the device most of it will be used
on; and it is close to unautomatable in Playwright, so the tests that matter most
here could not be written. `lib/todos/drag.svelte.js` follows
`pointer-label.svelte.js` and `swipe.js`: `pointerdown` with a small movement
threshold before the lift, `setPointerCapture`, a captured `pointerup`, and a
drop target resolved by `elementFromPoint`. It stays in the zone until a second
caller wants it.

A keyboard path comes with it and is not optional: a card is focusable, and
`↑`/`↓` move within a column while `←`/`→` move between them, applying the same
`drop` patch. The pointer version is then an enhancement over something that
works, which is the arrangement `swipe.js` documents. It is also the one context
that cannot name a drop point precisely, so a sideways move lands at the same
index in the next column, clamped to its length.

### The gap opens as the pointer moves

The drop index is computed **continuously during the drag**, not on release, and
the cards from that index down shift out of the way to leave a space the size of
the card being carried. That is what makes *place it where I dropped it* legible:
without the gap, precise placement is a promise the screen does not show you
keeping until it is too late to aim.

The shifting is a transform on the cards below the index, transitioned, with the
list itself never reflowing — the same FLIP arrangement any sorted list uses, and
cheap because only one number changes as the pointer moves. Three rules around it:

- **`prefers-reduced-motion` removes the transition, not the gap.** The space
  still opens, instantly. The gap is information; the movement is manners.
- **The drop index is state, and the transform is a picture of it.** Tests assert
  the index, never a transform — a computed style sampled mid-transition is an
  interpolated value, which is a thing this codebase has already been caught
  believing.
- **It degrades to nothing.** A drop with no gap drawn still lands where the
  pointer was, so the animation can be built after the drag works and can fail
  without taking placement with it.

### The modal

`lib/todos/TaskModal.svelte`, opened from the title in every view including the
calendar. Title, markdown description, planned date, planned time, due date,
priority, duration, icon (chosen from the shared picker, never typed), list,
active toggle with its running total, the step list with its `2/3` counter, and
three verbs: **tick**, **won't do**, **start a pomodoro**.

*Won't do* moves the task to the archive list and leaves it unticked, which is
the whole of what it means.

### The calendar

`lib/todos/Calendar.svelte`, day and week. Hour rows with an *anytime* row above
them for tasks planned on a day with no time. A block is heading plus start time
only; tapping it opens the modal. `+` on a day, or a tap on empty space, opens
the modal with that day — and that hour, where the tap landed in the grid rather
than in the anytime row — already filled in.

A task whose planned time plus duration crosses midnight is drawn **whole, on the
day it started**, and is not split. That is the brief's rule and it agrees with
what this codebase already decided for a session on a different clock: the two
midnights are not the same instant, and splitting invents an hour.

The due-date toggle draws, for every task that has both dates, **a hollow block
at the due date joined to the planned block by a thin line**. Tasks with no due
date are untouched, so switching it on adds marks rather than changing the ones
already there.

### Navigation and the landing page

`App.svelte` gains `/todos`, `/todos/calendar`, `/todos/lists`, a `todos` section
and its accent class. The section nav reads **Tasks · Calendar · Lists**.

The landing page gains a fourth card, and it is the only bridge as it has always
been — the todo half links to nothing outside itself, including to Focus, even
though a pomodoro can be started from a task. Two consequences worth naming
before a test run finds them: the card grid is `md:grid-cols-2 lg:grid-cols-3`,
so a fourth card leaves an orphan row at large widths and wants
`sm:grid-cols-2 xl:grid-cols-4`; and `every landing card routes to its own half,
both ways in` asserts six `href`s, which becomes eight.

The card reads *N due today*, or *N overdue* when there are any, because overdue
is the number that changes what you do next.

---

## The principle of smallest distance, stated precisely

> A drop names a **set** of legal values for one field. Move that field to the
> member of the set nearest the value the task already holds — and if the value
> is already in the set, **do not move it at all**.

The second half is the load-bearing one. It is what makes dragging inside a group
a pure reorder, what makes a drop idempotent, and what stops a task dropped back
where it came from losing the exact date it had.

Every drop in the app, with `T` for today:

| Grouping | Column | Legal set | Patch |
| --- | --- | --- | --- |
| date | past | `planned < T` | `planned = T − 1` |
| date | today | `{T}` | `planned = T` |
| date | tomorrow | `{T + 1}` | `planned = T + 1` |
| date | later | `planned > T + 1` | `planned = T + 2` |
| board | done | done, any planned day | `done_at = now`, bank the clock; `planned` untouched |
| board | active | ¬done ∧ active, any planned day | untick, `active_since = now`; a past `planned` moves to `T` |
| board | planned | ¬done ∧ ¬active ∧ `planned = T` | untick, bank and clear `active_since`, `planned = T` |
| board | backlog | ¬done ∧ ¬active ∧ `planned ≠ T` | untick, bank; `planned = T + 1` when it was `T` |
| matrix | important | `priority ∈ important` | the *least* important priority still inside the split |
| matrix | ¬important | `priority ∉ important` | the *most* important priority outside it |
| matrix | urgent | `due ≤ T + window` | `due = T + window` |
| matrix | ¬urgent | `due > T + window` or none | `due = T + window + 1` |
| **size** | a bucket | — | **the bucket's centre, always** |
| list | a list | `list_id = L` | `list_id = L` |

Three notes where the rule needed a decision rather than an application:

- **Size is a stated exception, by your answer.** A 45-minute task dropped into
  *large* becomes 120, not 60. The buckets are coarse guesses rather than
  measurements, so the centre is the more useful number and the more predictable
  behaviour; it is written into `groupings.js` as an exception with this
  sentence beside it, so nobody later "fixes" it into consistency.
- **Backlog is where the brief breaks a tie the principle cannot.** `T − 1` and
  `T + 1` are equally near; the brief says tomorrow, and tomorrow is right —
  pushing a task backwards into overdue is not what dragging it out of today
  means.
- **Dropping into *urgent* with no due date invents one.** A deliberate exception
  to the never-invent-data rule, and safe for the reason that rule allows: it is
  not the app deciding, it is a person dragging a card into a box labelled
  urgent. The nearest legal value from *no opinion* is the far edge of the window.

---

## Natural language, and colouring it in place

One function, `parse(text, { today, lists, dismissed })` in `lib/todos/parse.js`,
returning `{ title, patch, tokens }` — pure. `tokens` is what the highlighter
draws: each is `{ field, start, end, text, value }`.

Four rules before the vocabulary, because they matter more than it does:

1. **English phrases are consumed only from the ends of the string**, working
   inwards. `Go to gym tomorrow` loses its last word; `Read the today paper`
   keeps every one of its own.
2. **Sigils are consumed anywhere**, because `!2` and `#errands` and `~45m` are
   not English and cannot appear in a sentence by accident.
3. **First match wins per field.** A second date phrase stays in the title rather
   than overwriting the first.
4. **Nothing is applied invisibly.** See the highlighter below.

| Written | Sets |
| --- | --- |
| `today` | planned = today |
| `tomorrow`, `tmrw`, `tmr` | planned = tomorrow |
| `yesterday` | planned = yesterday |
| `monday` … `sunday`, `mon` … `sun` | planned = the next such weekday, today counting |
| `next week`, `next month` | planned = +7 days, +1 month |
| `in 3 days`, `in 2 weeks` | planned = today + n |
| `on 14.6.`, `on 14 jun`, `on 2026-06-14` | planned = that date |
| `at 9`, `at 9pm`, `at 09:30` | planned time |
| `by friday`, `by 14.6.`, `due friday` | due date — the same date grammar as planned |
| `for 30m`, `for 2h`, `for 1h30`, `~45m` | duration |
| `!1` … `!5`, or `!!` / `!!!` | priority, `!1` most important |
| `#errands` | list, matched case-insensitively against **existing** names; no match leaves the text alone |

Dates are **day-first**: `14.6.` is June. `2026-06-14` always works. Deliberately
absent is **recurrence** — `every monday` is a different feature with a storage
model of its own and no home in this schema, and a parser that half-recognises it
would be worse than one that does not.

### The highlighter

Your answer asked for the recognised text to be coloured *in the box*, and for a
click on it to turn it back into plain text. That is a better interface than
chips and a harder one, and the difficulty is worth stating up front: **an
`<input>` cannot colour parts of its own value.** There are two ways round it and
only one of them is safe.

`contenteditable` gives full control and is a minefield — IME composition, paste,
mobile keyboards, and caret restoration on every re-render. The alternative is the
one that keeps the browser's own text field and everything that comes with it:

| Layer | What it is |
| --- | --- |
| Behind | A `<div>` rendering the same string as spans, one per token, coloured by field |
| In front | The real `<input>`, with `color: transparent`, a transparent background, and `caret-color` set to the ink |

You type into a real input and see the layer behind it through it. The caret is
the browser's, the selection is the browser's — `::selection` translucent, so the
colours show through — and IME, autocorrect and paste all behave because nothing
about them was replaced.

**The un-recognise gesture needs no hit-testing.** The overlay is behind the
input, so it can never receive a click; instead the click lands on the input, and
`selectionStart` says which token it fell inside. That is the whole mechanism:
click inside a coloured run and its field is dismissed. The overlay keeps
`pointer-events: none` and stays a picture.

A dismissal is remembered as the pair `(field, matched text)`, and the parser
skips a match it is told to skip. So dismissing *tomorrow* leaves the word as
plain text; typing `friday` afterwards is recognised, because it is a different
match; typing `tomorrow` back is not, because it is the same one. Predictable in
both directions, and it survives editing elsewhere in the string, which an
offset-based dismissal would not.

Two failure modes to design against, both classic:

- **The layers must share their metrics exactly** — font, size, weight,
  letter-spacing, padding, border width. A single pixel of disagreement and the
  colouring drifts from the text by the end of a long line. They are set once in
  one class applied to both, never separately.
- **Single line only.** Wrapping makes the alignment far harder and buys nothing:
  the quick-add is one line by design, and the modal's title field does not parse
  at all — editing a field explicitly is not the same gesture as typing a task.

Colours come from `@theme static` tokens, and none of them may be one the todo
section rebinds: date `iris`, time `sage`, due `rose`, priority `amber`,
duration `haze`, list — the list's own colour. `[verify]` Six hues against a
fern-green section is a judgement to make on a screen, not in a table.

The tests assert `data-token="due"` on the spans rather than their computed
colour. A colour test would be restating the stylesheet, and `CLAUDE.md` already
records what sampling one during a transition costs.

---

## Settings

Three things the owner configures, none of which changes a stored value: the
priority split for *important* (default: very high and high), the urgency window
in days (default: 3), and the five size buckets with their ranges and centres.

They live in the preferences document under a `todos` section — opaque to the
backend, which is right because the backend never does this grouping. Two things
follow:

- **`persistPreferences` already guards the failure that matters.** A device that
  could not read preferences must not write its defaults over the account's own;
  the `unread` flag does that, and these settings inherit it for free.
- **This is exactly the trap `CLAUDE.md` records about the smoothing slider** — a
  control that is not on screen still applies. The mitigation is to label the
  groups with what they mean: *Important · very high, high* and *Large · 1–4h →
  2h*, so a number that surprises you explains itself where it is drawn.

---

## The pomodoro handover

Three things, and only one of them is awkward.

**Typing a task in the focus view creates a real todo**, in the inbox, planned
today, with the pomodoro linked to it. `Focus.svelte` imports `saveTodo` from the
shared store, pointing inward exactly as its `saveEntry` import already does.
Leaving the box empty still gives an unnamed pomodoro and creates nothing.

**Starting a pomodoro from the modal** is the same call in the other direction
and needs nothing new.

**A running pomodoro sets its task active**, which requires the pomodoro to name
a task:

| | |
| --- | --- |
| Add | `pomodoros.todo_id`, nullable FK, `ondelete="SET NULL"` |
| Keep | `pomodoros.task` exactly as it is |
| Read | the linked todo's title when there is a link, the stored text when there is not |
| Migrate | **nothing.** One nullable column with no server default is added in place — the cheap path — and not one historical row is touched |

Keeping the text column is the part worth defending. Converting years of `task`
strings into todo rows is a data migration whose only purpose is to make the
focus history read as it already does, and the rules for writing one here are
three paragraphs of *this loses history silently*. The column costs nothing and
is read only when there is no link. The price is a name in two places — the shape
of a bug this codebase has met — mitigated because exactly one of the two is ever
read for a given row, never both on one screen.

**The FK crosses zones, and `models.py` currently documents that none does.**
That comment is amended rather than worked around, with the reason this one
exists written beside it.

The active-state rule then falls out on the client: a pomodoro whose `todo_id` is
set activates that task when it starts and banks its seconds when it ends. No
server rule, no scheduler, nothing new in the announcer.

---

## Tests I intend

**vitest**, for everything pure — and almost all of the interesting behaviour
here is pure, which is the return on putting the rules in their own modules:

| File | What it holds |
| --- | --- |
| `rank.test.js` | A key always exists strictly between two neighbours, including between two *equal* ones; both ends; **1,000 consecutive prepends never fail**, which is the claim question 16 asked for; the rebalance threshold fires when it should and produces one-character keys; two devices computing the same key sort identically once `client_id` breaks the tie |
| `parse.test.js` | Every phrase in the table; `Go to gym tomorrow` splits; **`Read the today paper` keeps its word**; a phrase mid-sentence is not consumed; a second date phrase stays text; a `#list` matching nothing is left alone; a dismissed `(field, text)` pair is skipped and a *different* match for the same field is not |
| `groupings.test.js` | For all five groupings: dropping a task into the column it is already in returns `{}`; a drop is idempotent; and the round trip — `columns(apply(drop(task, c)))` puts the task in `c` — which is the one assertion that catches a smallest-distance rule that overshoots. `size` is exempted by name, with the reason in the test |
| `todos.test.js` | Active seconds while running; won't-do against cleaned-up; the step counter; the archive filter; **the archive orders by `archived_at`, and editing an archived task does not move it** |
| `dropindex.test.js` | The index a pointer position resolves to, over a column of known card geometry: above the first card, between two, below the last, and on an empty column. Pure arithmetic, and the half of *place it where it was dropped* that a browser test would only sample |

**Playwright**:

| File | What it holds |
| --- | --- |
| `todos.spec.js` | Quick-add with a phrase, tick, modal edit, steps, won't-do, cleanup, and that cleanup is **not offered** on the archive |
| `todos-board.spec.js` | A pointer drag between columns changes the field named and nothing else; **a drag inside a column changes the order and no field at all**, asserted against the API rather than the screen; **a task dropped third from the top arrives third**, which is the claim, and it is read from the stored order rather than from any transform; dragging out of the archive restores to the column dropped on; the keyboard path does the same things |
| `todos-parse.spec.js` | Typing `Go to gym tomorrow` colours the last word as a date token; clicking inside it clears the token and the planned date returns to the preset; the overlay and the input stay aligned at 320px |
| `todos-offline.spec.js` | All of the above with the server held open, then a reload, then a reconnect — the walkthrough the other halves already have |
| `sync.spec.js` | Extended: each new view paints from the store with every request held at 3s, and `expectSettled()` on all of them |
| `mobile.spec.js` | The columns layout is absent below 48rem; card and control heights measured at **320**, not 390 |

**Mutation probes to run before believing any of it**, one per load-bearing
behaviour: make `drop` always return its patch and watch the in-column drag test
fail; break the `client_id` tie-break and watch the rank test fail; remove the
rebalance and watch the prepend test fail; remove the ends-only rule from the
parser and watch `Read the today paper` fail; drop the system-list guard and
watch the delete test fail; make every drop append instead of placing and watch
the third-from-the-top test fail. Each has to fail **by name**, and a probe that passes
means the test is decoration.

---

## Build order

| | |
| --- | --- |
| **1** | Schema, migration, `ensure_system_lists`, `services/todos.py`, the four sync kinds, the digest keys, the read endpoints, lists CRUD. Backend tests only — no UI, verifiable on its own |
| **2** | `flush` chunking, in `lib/sync.js`, with its own test. Small, and everything after it depends on it |
| **3** | Store, projection, snapshot, `applyChanges`; `rank.js` and `groupings.js` with their unit tests; the board with the `date` grouping, stacked, and the quick-add — **including positional drops, since they are the ranking half rather than an addition to it**. The whole feature for one view, and the phase that proves the offline story |
| **3a** | The insertion gap and its transition. Separated only because it degrades to nothing: the drop already lands where it was dropped without it, so it can slip without blocking anything |
| **4** | The modal, steps, the parser and the highlighter, icons, and the shared-zone moves |
| **5** | The remaining four groupings and the columns and quadrant layouts — small, because the work is `groupings.js` rather than the component |
| **6** | The calendar |
| **7** | The pomodoro handover, the fourth landing card, the nav and the accent |

Phases 1 to 3 are the risk. Everything after them is addition.

---

## What this costs elsewhere

An honest list, because none of it is in the todo zone:

- **`lib/sync.js` gains chunking in `flush`** — a change to the one file every
  write in this app passes through, and the single riskiest line item here.
- **A data migration**, which the first draft did not need. Two inserts per
  existing account, insert-only, guarded by a unique index.
- `/api/changes` goes from eight aggregates to eleven.
- Two dependencies: `marked` and `DOMPurify`. The bundle today is **1,568 KB raw
  / 498 KB gzipped**, measured; the two together are `[verify]` about 60 KB raw
  and so roughly **+4% gzipped**, which is worth confirming after the install
  rather than trusting here. `DOMPurify` is not optional: `marked` has not
  sanitised its own output since 2019, and the description goes through
  `{@html}`.
- `App.svelte`, `app.css` and the landing page each gain a fourth of something;
  `every landing card routes to its own half` goes from six `href`s to eight.
- `lib/time/palette.js` and `lib/wellbeing/icons.js` move, so every import of
  them changes — about a dozen files, mechanical.
- `models.py`'s "nothing here references a project or a question" comment stops
  being true and is amended.
- `bootstrap.py` and `routers/users.py` each gain one call.

---

## The second round, answered

Kept as a record rather than as questions — **all five are settled and folded in
above.** Three confirmed what I proposed; two changed it, and both changes are
marked in the sections they touch.

| | |
| --- | --- |
| N1 Steps as their own table | Confirmed |
| N2 Renaming the system lists | Confirmed |
| **N3 Archive order** | **Changed** — by arrival, which reinstates `archived_at` as a timestamp |
| **N4 Where a dropped task lands** | **Changed** — exactly where dropped, everywhere, plus a live gap. This *deleted* the rule I had proposed |
| N5 A retitled task | Confirmed |

**Nothing in this plan is open.** The two `[verify]` marks are checks to make
while building — the fern accent against `sage` on a screen, and the two
dependencies' real gzipped weight after the install — not decisions to make
before starting.

**N1. Steps as their own table — confirm?**
*Subtasks are not tasks* is what made me move them out of `todos`, and it removes
a filter from every query, a constraint SQLite cannot express, and five columns
that would have to stay null. The cost is two more sync intent kinds and one more
overlay in the projection. `[assumed: their own table, todo_steps]`

--> Agree

**N2. Can Inbox and Archive be renamed and recoloured?**
They are ordinary rows now, so it is free to allow. The code keys on `kind` and
never on the name, so nothing breaks if you call the archive *Done with*.
`[assumed: yes, renameable and recolourable, never deletable]`

--> Yes why not

**N3. Does the archive have an order of its own?**
Ranks are meaningless there — a task arrives by being finished or abandoned, not
by being placed. `[assumed: newest first, by when the row last changed, and no
dragging within the archive column]`

--> Archive should be ordered by when tasks arrived in it, agree.

**N4. What happens to a task's rank when it moves lists?**
It lands at the top of its new list, or at the bottom. Top is what most tools do
and makes an arriving task visible; bottom respects whatever order the
destination already had. `[assumed: top]`

--> If the drag+drop context allows precise placement, e.g. in the web version of the move between lists view where the lists are columns next to each other, then just place it precisely where the user drops it. Maybe even add a small animation that pushes existing tasks back before drop.

**N5. Does the pomodoro that created a task keep pointing at it if you retitle
the task?**
Yes, because the link is by id and the title is read through it — which is the
whole meaning of *ownership transferred*. Worth confirming only because it means
the focus history changes retrospectively when you rename a task, which is a
visible consequence of a decision that otherwise looks internal. `[assumed: yes —
the focus view shows the task's current title]`

-- yes

---

## Fourth draft — decisions made while building

*Added 2026-09-11 by the build run. The owner delegated UX judgement for this
run; everything here is a decision, not a question, and each names its reason
so it can be reversed on purpose rather than by accident.*

### Mobile: a column is a page, not a squeeze

The brief leaves the phone flow open. The rule adopted, one for every
column-heavy picture:

**Below 48rem, a grouping laid out in columns becomes a pager.** A tab strip
across the top names every column with its count; exactly one column is on
screen; a swipe (through the shared `swipe.js`) or a tap on a tab moves to the
next. The column itself is the same markup as on a wide screen, so there is one
card, one quick-add and one drop handler, not two. Quadrants are four tabs.
Stacked layouts (`date`, `size`) are unchanged, since a stack already fits a
phone.

Moving a card between columns on a phone: lift it (a short press, the same
threshold as on a desktop pointer), carry it to the **left or right edge** of
the screen, and after a short dwell the pager turns to the neighbouring column
with the card still in hand; drop it where it should go. The tab strip is also a
drop target, so a card can be dropped on a tab to land at the end of that
column. That is TickTick's model — swipe between columns, drop on a named
target — and it keeps positional placement on the device where a two-column
picture cannot fit. The modal remains the fallback that can change every field
without a drag.

**The calendar week is a strip and a day.** The seven-day strip — a chip per
day with the count of tasks planned on it — is the header at every width. Wide,
the body below it is seven hour-columns; narrow, it is the one day that is
selected in the strip, and swiping the body moves the selection. Day view is
the same component with a one-day body at every width. So the week header is
identical on both, the body differs, and nothing on a phone is a column too
narrow to read.

### UX adopted beyond the brief

| | Why |
| --- | --- |
| **Quick-add keeps focus after Enter** and clears itself | Typing five tasks in a row is the ordinary case; a box that blurs after one makes it five taps |
| **Enter with the parser's preset visible** | The quick-add shows, beneath the box, what the coloured tokens will set — *tomorrow · 9:00 · !high* — so what Enter does is never a surprise |
| **Done tasks keep their place**, struck through and dimmed | The order is the person's; a tick is reversible and must not shuffle the list under the thumb |
| **Overdue is red on the card**, in the date chip | The one number that changes what you do next, the plan says; it should be the one thing that stands out |
| **Delete in the modal**, behind a confirmation | `todo.delete` exists for a reason; a mistyped task should not have to be archived to disappear. Answers are never deleted; a task is not an answer |
| **The toolbar is one row**: list chips, grouping, layout, cleanup with its count | Every control that changes what the board means is in one place, above it, which is the smoothing-slider lesson applied before it bites |
| **Inbox is the default list**, and the selected list is remembered per account | The place a parsed task without `#list` lands should be the place you look first |
| **Tab and column headers carry counts** | A count is what tells you a column off screen has something in it |
| **`Escape` clears the quick-add**, `Escape` closes the modal without saving fields not yet blurred | One key means "never mind" everywhere |

### The card's chips are also filters of attention, not controls

A card shows only what is set. Nothing on it but the tickbox and the title is
interactive — the plan's rule — so every chip is a `<span>`, never a button, and
the e2e mobile test measures that the two hit targets do not shrink below 44px at
320px width.

### Phase 2 as built — four things that were not in the plan

*Added by the phase-2 run. Each was found by a test rather than reasoned about,
and the first three are not about todos at all — they belong in `CLAUDE.md` when
this document is deleted.*

- **A browser coalesces pointer moves onto animation frames, so a drop has to
  re-aim at the release point.** The last `pointermove` of a quick gesture can
  still be undelivered when `pointerup` arrives, and the drop is then placed
  where the card was a frame ago. Measured: *a task dropped third from the top*
  landed fourth every run, and passed with a 200ms pause before letting go —
  which is the shape of a test that would have hidden it. `onUp` calls `aim`
  before reading the index.
- **Two `{#each}` items under one key silently kill the whole block.** The
  insertion marker was pushed twice — the carried card does not advance the
  index, so two rows in a row matched it — and Svelte's duplicate-key error left
  that one column never updating again while every other column carried on.
  It read as "the drag state is not reactive", which is the wrong diagnosis
  entirely.
- **`data-pending` reads `0` before a write is queued.** Waiting on it is only
  sound *after* something on screen has been asserted to have changed: writes
  queue before they reach the store, so the card appearing is the proof the
  outbox is not empty. Two tests here passed against the bugs they were written
  for until a UI assertion was put in front of the badge — one of them being the
  501-intent chunking test, which passed against **no requests at all**.
- **The insertion marker is an outline, not a border.** A 2px border takes 2px,
  which moves the very cards the drop index is measured against, and the index
  then flips between two values under a still pointer. An outline is painted
  outside the box and costs no layout; with the flex gap cancelled the marker
  takes exactly none, which `the marker says where the card will land, and costs
  no layout` measures.

Two smaller decisions, both reversible on purpose:

| | |
| --- | --- |
| The archive is drawn from **two** sources | `ensureArchive`'s page plus any row in `todos` already carrying the archive's `list_id`, deduplicated on `client_id`. A cleanup made with no connection can then be looked at, and only the server knows `archived_at` |
| A rebalance produces keys of **one width with a gap between every pair** | `spread(n)` picks the narrowest width that leaves room for another key of the same width between any two, because a column re-ranked with no gaps is one insert away from growing a character again |

### Phase 3 as built — what a later phase needs to know

*Added by the phase-3 run (modal, steps, parser and highlighter, icon picker,
the two shared-zone moves). Each was found by a test rather than reasoned about,
and the first three are not about todos at all — they belong in `CLAUDE.md` when
this document is deleted.*

- **A `$derived` read after its dependency is cleared is the parse of nothing.**
  The quick-add's Enter handler cleared the box and *then* read `parsed.patch`;
  `$derived` is lazy, so every recognised field was silently dropped and the task
  was created with the column's preset alone. Read the derived into a local
  before mutating what it reads. Caught by `#errands names a list that exists`,
  which is the one assertion that could see the difference — the preset line and
  the colouring were both already correct.
- **`change` does not fire on a typed field until the focus leaves it.** A
  Playwright `fill` sends `input`; the `change` this app was saving on arrived
  only when the *next* field was touched, so an estimate typed as the last thing
  before closing was never saved. The rule adopted: **anything typed goes
  through the debounce** (title, notes, the estimate, a step's title) and
  anything *picked* saves on `change` (date, time, selects), because a picker
  commits a whole value at once. The debounce is also what makes the flush on
  close cover it.
- **The `/api/changes` digest cannot see two changes in one second.** It
  fingerprints a collection as a count and `max(updated_at)`, and SQLite's own
  `CURRENT_TIMESTAMP` is whole seconds — so an edit made in the same second as
  the row's last change moves neither number. `a change made on another device
  shows in the open modal` therefore sends the edit *with a new step*, because a
  row that did not exist moves a count. Worth knowing before writing another
  cross-device test, and worth weighing if anything ever needs sub-second
  freshness.
- **`hasText` cannot see an input's value.** A step's title is an `<input>`, so
  filtering step rows on their text matches nothing however right the row is.
  The step controls carry their titles in their accessible names — `Tick Buy
  food`, `Move Wash the bowl up` — which is what the tests locate them by.
- **`columnDate` is keyed on the grouping, in `fields.js`, and phase 4 should
  probably move it.** A card does not draw a date its column heading already
  says, which needs to know whether a column *is* one day; only the `date`
  grouping's `today` and `tomorrow` are. That is arguably a property of a column
  and would sit better as a `date` on what `columns()` returns — the route
  decorates each column with it today, along with the column's own `preset`,
  which is the shape the board and the quick-add read.

Two smaller ones, both about the modal:

| | |
| --- | --- |
| **44px of hit target for 32px of drawing** | The tickbox is a `size-11` button with `-m-1.5` around a `size-8` box, so the hit area is 44px and the *layout* is unchanged — the extra reaches into the card's own padding and the gap before the title. Measured at 320px in `mobile.spec.js`, because the drawing says nothing about the hit area |
| **Closing commits, and two things make it true** | Escape, the backdrop and the button all flush the debounce; leaving a field also commits it on `blur`, which fires as the dialog closes under a focused input. Either alone passes the test and deleting both fails it. What may *not* be the thing that saves a keystroke is a pending timer: with both deleted the test still passed, because an orphaned `setTimeout` was writing from a destroyed component's closure. They are cleared on teardown now |

### Phase 4 as built — what a later phase needs to know

*Added by the phase-4 run (the remaining four groupings, the three layouts and
the phone pager, the insertion gap, the keyboard path, the Lists page, the
settings UI, one parser refinement and one modal tweak). Each was found by a
test rather than reasoned about, and the first four are not about todos at all
— they belong in `CLAUDE.md` when this document is deleted.*

- **An effect that carries a preference section through is an effect that reads
  what it writes.** `persistPreferences` replaces the named section, so the
  board has to carry its `settings` through when it saves `list`, `grouping` and
  `layout`. Read from `$preferences` *tracked*, that is the forbidden shape
  exactly: the write lands after an await, so Svelte's depth counter has reset
  by the time it arrives and the effect loops for ever **with no error at all**.
  It cost every board test at once — thirty-eight failures, cards on screen and
  a tickbox that did nothing, which reads as "the store is broken" and is really
  a tab that has stopped painting. `untrack(() => …)` around the read is the
  fix, and the shape to look for is a `$effect` that merges anything *back into*
  the thing it is saving.
- **A transformed ancestor becomes the `offsetParent` in Blink.** The insertion
  gap displaces cards with a `transform`, and the drop index is measured from
  layout precisely so that the picture of the index cannot move the index. But
  `card.offsetTop` read in one go is *also* relative to the transformed wrapper,
  so it came back as `0` the moment a card was displaced: the index froze under
  a moving pointer and a card aimed at the second slot went to the third.
  `columnGeometry` sums the `offsetParent` chain up to the list instead — each
  step is still pure layout, so the sum is too — and `[data-cards]` carries
  `position: relative` to be where the walk stops. A test measuring the same
  thing has the same trap: read the row the transform is *on*, whose own
  transform does not move its own `offsetTop`.
- **A remembered id needs a fallback the moment the thing is deletable.** The
  board remembers which list it was on, lists are deletable, and a second device
  can delete one — so it arrived pointed at a list nothing matched, drawing four
  empty columns and a chip row that did not include it. Caught by deleting a
  list on the Lists page and walking back to the board. The same shape as
  `groupingFor` falling back for a grouping that no longer exists, one level of
  data along.
- **`data-pending` reads `0` before a write is queued** — `CLAUDE.md` already
  says so, and phase 4 walked into it twice anyway, in a shape worth naming: a
  test that presses Enter and then waits on the badge is waiting on a queue that
  does not exist yet. It failed once per full suite run and passed alone. The
  fix is a UI assertion in front of it — the card appearing *is* the proof the
  intent is on disk — except for the one quick-add case where the task **leaves
  the screen** as it is created: `#errands` moves it out of the list being
  looked at, so there is no card to assert on and the right tool is polling the
  server for the thing the test came to see.
- **A live region only speaks when its text changes.** Two cards moved into the
  same position produce the same sentence, so a reader hears the first and not
  the second. The announcement carries an alternating zero-width space; it draws
  nothing, reads as nothing, and makes the string different. `toHaveText`
  normalises that character away, so the test compares `textContent`.

What phase 5 and 6 should know about the shapes that are now in place:

| | |
| --- | --- |
| **`Column.svelte` is the unit, `Board.svelte` is the arrangement** | One column, four arrangements — stacked, a row, a 2×2 grid, and the pager. The calendar is the seventh view and genuinely different, but anything else column-shaped should be a grouping plus a layout rather than a component |
| **A column carries its own `date`** | `columnDate(groupingId, …)` in `fields.js` is **gone**, as phase 3 predicted. `columns()` returns `date` on every column and the card reads it; the route no longer decorates anything but `preset` |
| **`place(task, column, index)` is the only way a card moves** | A pointer drop, an arrow key and a drop on a pager tab all go through it, so "the keyboard does the same thing as a drag" is a fact about the code rather than two implementations that have to keep agreeing. Anything new that moves a card should go through it too |
| **A read-only column refuses a reorder, never an arrival** | Dropping *onto* the archive is what *won't do* means, so `place` refuses only when the task is already in that column. `column.readonly` is now per column rather than per board, which is what let the archive be an ordinary column of the `list` grouping |
| **A pager tab is a drop target that means *the end*** | `data-drop-end` on an element makes `aim` resolve it to a column with no place inside it; the caller clamps. That is the only honest answer a *name* can give, and it is the mechanism any later "drop it over there" target should use |
| **`drag.onEdge` is settable, not an argument** | The thing that knows there is a neighbouring page is the board's layout; the thing that owns the drag is the route above it. A plain closure variable, so the effect that assigns it is not an effect that re-runs |
| **`drag.justDropped` is how a swipe tells itself from a drop** | `pointerup` arrives before `touchend`, so carrying a card to the right-hand edge satisfies every condition a swipe has. Without it every drop near an edge also turned the page |
| **The `todos` preference section holds `list`, `grouping`, `layout` and `settings`** (`list` became `lists` in the fifth draft below) | Two pages write it — the board writes the first three, Settings writes the last — and each carries the other's half through. There is a test for exactly that, because `persistPreferences` replaces the section it is given |
| **`bucketHint` lives in `settings.js`** | It moved out of `groupings.js` when the settings page wanted the same sentence beside the fields that set it. Two spellings of *1h–4h → 2h* is how two numbers on one screen come to disagree, and this one is on two screens |
| **`cleanSplit` and `cleanBuckets` are exported so an editor can *refuse*** | Every reader of these settings falls back to the defaults for a value it cannot use, which is right for a reader and wrong for a writer: a set saved in that state reads back as the default, and the control has silently done the opposite of what it was told. One definition of *usable*, read two ways |
| **`IconPicker` takes `collapsed`** | The task modal folds the grid away; the catalogue's question form keeps it open, because that page is about one question and nothing is competing with it. A prop at the call site rather than a new behaviour everywhere |

Three smaller decisions, all reversible on purpose:

| | |
| --- | --- |
| A bucket's **upper** edge is the editable one | It moves the next bucket's floor with it, so a boundary is one number drawn twice and `from` is read-only. Two independently edited numbers that have to be equal is a rule nobody can satisfy one keystroke at a time |
| The pager's visible column is **not** remembered | Which page you were looking at is a fact about one glance, not a preference. The grouping and the layout *are* remembered, because those are choices |
| Cleanup is **per column** under the `list` grouping only | One button above the board could only be about one list, and that grouping draws them all. Everywhere else it stays where it was, on the selected list |

---

### Phase 5 as built — what a later phase needs to know

*Added by the phase-5 run (the calendar's arithmetic and its two views, then a
browser run over both). Each of the first three is not about todos at all and
belongs in `CLAUDE.md` when this document is deleted.*

- **An unlayered rule beats every layered one, so `.meta text-alarm` was dead
  CSS.** `.meta` in `app.css` set `color` outside any layer; Tailwind's
  utilities are all in `@layer utilities`, and layer order beats specificity
  outright — so the class was emitted, matched, and lost. The overdue date chip
  on a task card never turned red, `an overdue task says since when, in red`
  passed anyway because it asserted `toHaveClass(/text-alarm/)`, and **forty-five
  `text-*` utilities across the app sat beside a `.meta` with every one of them
  losing**. Only the `color` declaration moved into `@layer base`; the font, the
  case, the tracking and the size stay unlayered, so `text-sm` beside a `.meta`
  still loses and the type treatment is not half-undoable by a utility. Twenty-
  four of the forty-five named `haze` and changed nothing; the other twenty-one
  are nine dead `hover:text-paper`, ten `text-paper` and two `text-ember`, all
  now doing what they were written to do. The test that holds it reads the
  chip's *computed* colour against the computed value of `--color-alarm`, and
  asserts a future date chip is haze in the same read — a test naming `#d4574e`
  would be restating the stylesheet.
- **A preference section is replaced, so every page that writes one must carry
  the whole of it through.** Phase 4 already knew this and carried `settings`
  **by name**; the calendar then put `calendar_mode` and `calendar_due` in the
  same section, and a walk from a day-mode calendar to the board and back
  arrived on Week. Both pages now spread the section they read untracked —
  `{ ...stored, ...view }` — because a list of keys to keep is a list somebody
  has to extend and nobody did. The calendar also *read* it at write time rather
  than snapshotting it at restore, which is the other half: a snapshot cannot
  see a key the board wrote afterwards, and these two pages outlive each other.
- **`toHaveText` cannot see a clipped line.** A block draws a title and a start
  time and nothing else, and at `DEFAULT_MINUTES` — half an hour, which is most
  blocks — the 24px box cut the time through the middle. The text was there, so
  the assertion that the block reads `Groceries 17:00` passed against it; it was
  found by *screenshot*. The fix is a `compact` flag out of `placeBlocks` — the
  two lines go side by side below `STACKED_HEIGHT` — and not a taller floor,
  because drawing a half-hour task as though it took longer is the app inventing
  data to make its own layout work. The test measures the time span's box
  against the block's.

What the calendar is, for whatever touches it next:

| | |
| --- | --- |
| **The strip *is* the week body's header row** | Wide and on Week it sits inside the grid, one chip per column offset by the hour gutter, each carrying weekday, day number, count and the `+`; the grid's own `MON, JUN 15 +` row is gone, because that was the same day named twice one row below itself. In day mode and on a phone the strip goes back to a standalone row and the single day keeps its own header with the only `+` there is. `striped` is the one flag that switches it, and it is `!single` named for what it decides |
| **The count is a badge, not a third number** | `MON 15 5` reads as a day number nobody has. The wide header is what made it obvious — stacked, the count was already on its own line |
| **The body is its own scroll box** | `max(24rem, 70vh)` with the header sticky at `top: 0` and the anytime row sticky at `top: HEAD`, so the gutter and the columns scroll together and a plan with no time stays on screen. `HEAD` is a **constant** rather than a measurement precisely because the anytime row's sticky offset has to be a number before layout, and it is also what makes the `+` a 44px target at 320 rather than the drawing deciding |
| **It opens where the day is** | The now line a third of the way down when one of the days on screen is today, `OPENING_HOUR` flush under the sticky rows when none is. The effect depends on `scroller` and on **that boolean alone**: `minute` is read untracked, or the view would be dragged back under a reader once a minute. Stepping off today re-opens it, which is the only reason the second branch is reachable at all — and a test for it would otherwise be untestable through the page |
| **`data-body-day`, not `data-day`** | The strip chip is `[data-day]` and the body column is `[data-body-day]`. They were both `data-day` in 5a, which is one attribute meaning two things and a locator that matches twice |
| **A block is `z-10`, the anytime row `z-20`, the header `z-30`** | All three are in one positioned column so that one coordinate space holds the blocks, the due marks and the connectors. Once two of them are sticky the order has to be stated, and the sticky ones need an opaque `bg-ink` or the hours show through them |
| **Every geometric test measures against the picture's own rows** | A block's `top` is asserted against the `[data-hour]` row's `top`, a clipped block's foot against the column's foot, a shared width against the column's width. A test naming 476px would be restating `ANYTIME + 9 * HOUR` back at the implementation |
| **A drop is a day and a snapped minute** | Added by the drag run. `slotFromPointer` rounds to 15 minutes and clamps to `[0, 23:45]` — 24:00 would be `00:00` on the day after the one dropped on. The three targets are `[data-body-day]` (day and time), `[data-anytime-row]` (day, no time) and `[data-drop-day]` on a strip chip (day, time kept), and `[data-shadow]` with `data-shadow-time` is the promise in words, which is what a test can read: a transform sampled mid-drag is a number nobody claimed |
| **Scroll it into the middle before tapping it** | `intoView` in `todos-calendar.spec.js`. The browser's own scroll-into-view knows nothing about a sticky overlay, so an hour row parked under the 96px of sticky rows counts as visible and the click lands on the header — which Playwright then retries there until it times out. Anything that taps inside a scrolling body with sticky rows needs this |

---

## Fifth draft — owner feedback

*Added by the feedback run. Three items came back from use; each is a decision
already taken, and what is still true afterwards is in `CLAUDE.md` rather than
here.*

### The Eisenhower quadrants could not create a task at all

Reported as *adding in the matrix does not work — "planned_on field required"*,
and the report understated it. `matrix` presets a priority and a due date,
`size` a duration, `list` a list, and none of the three presets a **day** — so
the intent was refused per-intent as a conflict, which retires from the queue,
which loses the projection, which takes the card off the screen. Except that the
card never drew: `dayLabel(undefined)` throws inside `TaskCard`'s render, so what
the owner actually saw was Enter clearing the box and *nothing else happening*,
with a small ember `1` beside the cloud.

Four changes, and the second and third are the ones worth keeping:

- **`newTaskFields` in `fields.js` is the one place a new task is composed**, and
  the one place `planned_on` falls back to today. Not in each grouping's
  `preset`, because a preset says what its column *means* and a quadrant means
  nothing about when a task is planned — leaving it there is a rule every
  grouping added later has to remember.
- **The quick-add hands the composed object to the write.** The preset line
  under the box and the task that is created are now one object rather than two
  spellings of it, which is the same lesson as the transfer button: two numbers
  on one screen must come from one place. The line reads `today · high · due
  thu, jun 18` in a quadrant now, which is the default made visible.
- **A refusal is a toast, one per drain.** The badge panel is where a person
  goes looking *afterwards*; it is not what tells them the thing they just did
  did not happen. Per drain rather than per intent because a cleanup can carry
  six hundred of them.
- A card also draws no planned date when it holds none, rather than throwing.
  It cannot hold none any more — but a render error takes the whole board blank,
  and that is not the failure mode a missing field deserves.

### The list chips select several lists

`lists: [ids]` in the `todos` preference section, replacing `list`, with the old
key migrated on read and written back as `undefined` so it cannot linger and
start answering. `storedLists` reads and migrates; `selectedLists` validates
against the account's lists on **every read**, which is where the archive's
exclusivity and the at-least-one rule live. The split is not tidiness: the board
restores its view before the lists have necessarily arrived, and one function
doing both would drop a stored selection to a race.

| | |
| --- | --- |
| The **archive stays exclusive** | Selecting it shows the archive alone; selecting anything else lets it go. It is the read-only column and the paged one, so a mixed board could be neither added to nor dragged within |
| **At least one list** | Tapping the last selected chip does nothing. The fallback to the inbox would hide that — which is why the test takes the board down to *Errands* first: what the guard alone decides is *which* list is left |
| ***All*** | Every ordinary list, never the archive, and drawn only where there is more than one to gather |
| The **quick-add** takes the first selected list in list order | It has to name one, and the first in that order is the inbox whenever the inbox is among them. Said under the box as `#Inbox` whenever there is more than one selected, on the same condition a card grows its list's colour dot |
| **Cleanup** follows the selection | `tasks` is already the selection, so both the count and what it takes did — a button whose number disagreed with the cards under it is the defect this codebase has a rule about |
| The **`list` grouping** still ignores the chips | Every list is a column there; the chips are not drawn at all |

### The carried card follows the pointer

The gap is unchanged — it is still the picture of the drop index, and still a
transform so that layout cannot move under the measurement. What moved is the
card: it is drawn `position: fixed` at the grip it was picked up by, its slot
holds its exact height, and on release it FLIPs from the release point into
wherever the store has just put it.

The parts that were not obvious:

- **The carried card is the *real* card, not a copy.** A copy would be a second
  `data-client-id` for one task and a second place for a tap to stop working on
  a phone. Keeping the original means keeping the element the press is attached
  to — `setPointerCapture` and the non-passive `touchmove` guard both live on
  it, and unmounting it mid-gesture takes them down.
- **Which is why the pager stows a column instead of unmounting it.** The
  carried card's column stays in the same keyed `{#each}` as the column on
  screen, off to the side with `pointer-events: none`: Svelte moves an element
  whose key it still sees and destroys one it does not. That is the whole of how
  the card keeps following while the page turns under it.
- **`transition-none` while carried.** A card's ordinary `transition` includes
  `transform`; without this the card eases toward the pointer 150ms behind the
  finger, which reads as lag rather than as a transition.
- **`prefers-reduced-motion` needs no branch.** `app.css` already cuts every
  transition duration to 0.01ms, so a settle that borrows the card's own
  transition is a snap under it — one code path, and the suite (which runs
  reduced) is therefore *not* the thing that tests the animation. One test runs
  at `no-preference` and asserts a `transitionstart` on the card's own
  `transform`: an event, because a geometry sample mid-flight is the
  interpolated-value trap in its plainest form.
- **The landing is stamped, not cleared.** A card that changed column is a new
  element, so the settle starts from its mount; a reader that cleared the
  landing would be an effect writing what it reads, and one mounting a minute
  later for another reason must not slide in from wherever a pointer was.

---

### Build order as executed

| | |
| --- | --- |
| 1 | Backend: schema, migration, provisioning, sync kinds, digest, read endpoints, lists CRUD, `pomodoros.todo_id` |
| 2 | `flush` chunking; store, projection, snapshot, `applyChanges`; `rank.js`, `groupings.js` (date); routes, nav, accent; Board with `date` grouping stacked, quick-add, positional drag |
| 3 | Modal, steps, parser and highlighter, icon picker; the two shared-zone moves |
| 4 | Remaining groupings, columns and quadrant layouts, the mobile pager, insertion gap, keyboard path, Lists page, settings |
| 5 | Calendar, day and week, strip-and-day on a phone |
| 6 | Pomodoro handover, landing card, polish |

---

## The brief, as given
I would like you to make a plan for a fourth area in the app:

Todos. I would like to be able to organize my todos and view the todos from different aspects. Fundamentally, a todo is basically a headline, usually something like "feed the cat", a list assignment and a planned date. Each todo item can be ticked. Furthermore, a todo item may have subtasks, but subtasks may not have subtasks themselves.

If I click on a task tickbox in whichever view, it shall be ticked as done. If I click on the headline in whichever view, an edit modal shall open where I can add a markdown description, due date, planned date, planned time, priority (very high, high, med, low, very low), duration, active state, time in active and a custom icon which replaces the tickbox with the icon. All fields except for the heading and planned date are optional. In the modal, I shall also be able to tick the task or mark it as won't do, which will move it to a special "archive" list and remove it from the current list.

There are two special lists in the system: "inbox" and "archive". Inbox serves as a landing point for todos where the user did not specify a list, and archive is the list for "won't do" tasks.

Dragging between different categories/areas may require changing a field of the todo in a not precisely defined way. E.g. if I drag something to "overdue", the app can not know how much overdue the task is. In such cases, the principle of the smallest distance shall be applied. E.g. in this case, the smallest distance means that it is only overdue since yesterday.

Usual non-functional requirements such as offline app usage and no backend awaits on navigation also apply.

When entering a task, a language detection shall be available. E.g. if I write "Go to gym tomorrow" then it automatically sets the planned date to tomorrow and uses "Go to gym" as the headline. Propose a list of sensible language detection phrases and their associated behaviour.

Views that I would like to have are:

### Task-list view

In a task list view for a specific list, I can just see the list of tasks ordered by a list-specific order. Tasks shall be in exactly one list at every time, but there should be ways how to move them between them (e.g. in the modal). A list may also come with a colour.

In the list view, the tasks are grouped into 4 groups based on their planned date: overdue, today, tomorrow, later. When dragging+dropping a task between the groups, the planned date should change accordingly. E.g. if I move a todo from today to overdue, the planned date is set to yesterday. If dragging+dropping happens within the group, only the list position shall change.

If a tasks starting date + duration span a day change, it should be shown in the starting day.

Adding a task in the list view should be possible through a textbox where I can just type away and upon press of enter, the task is created.

By default, done tasks should stay in the list. It should be possible to clear done tasks into the archive list through a "cleanup" button.

### Task side-by-side view

Similar to the task-list view, only that the groups are side-by-side, not vertically scrollable. On mobile, this view does not exist. Dragging+dropping shall similarly be available.

### Kanban view

A kanban view shows 4 columns, 3 only holding tasks for today:
- Done: All tasks ticked and planned for today. Moving a task here ticks it, moving it out unticks it.
- Active: Everything the user is working on. If a task is here, it is set to active and the active time is automatically ticking up.
- Planned: All tasks that are planned today but are not active or ticked.
- Backlog: All other tasks in the list that are not ticked. Moving a task here modifies the planned date to tomorrow.

Adding tasks should be possible through a + symbol or a click into empty space in the kanban categories.

### Calendar view columns

Here, tasks are shown in a calendar view as known in most calendar apps. A daily and a weekly view shall be available. In addition to the normal hours of the day, there is a special "anytime" hour row on top of each calendar view day where tasks that have a planned date but no planned time are put. The calendar is the only exception to the "task is tickable in every view" - To save space, only the heading and the starting time are shown. However, upon click the usual modal opens where I can edit every aspect of a task.

If I toggle a tickbox, I will also be shown the due date of my tasks. Each task that has a due date and a planned date.

Adding tasks shall be possible through a + symbol behind every day or clicking a void space, which opens the modal.

### Eisenhower view

This is an autogenerated view where tasks from a list are sorted into the categories urgent / important. Important is derived off the priorities, but the user may choose how to split based on the 5 available priorities in settings (default: "very high" and "high" count as important). A task without a priority is automatically "not important". Urgent is based on the due date of the task. The user can choose how many days in the future means urgent in settings (default: 3 days).

Dragging and dropping tasks within the areas applies the principle of smallest distance shall apply within the priorities/due dates.

Adding tasks shall be possible through a + symbol on every category or clicking on an empty space, which opens the modal with preset values for priority and due date.

### Size view

In this view, tasks from a list are grouped into 5 sizes based on their duration. Each size group has a range and a center. Per default, the following are present:
- no duration
- small (0-10 min, 5 min center)
- medium (10-60 min, 30 min center)
- large (60-240 min, 120 center)
- very large (240+, 1 day center)

The groupings may be edited in settings.
When dragging between the groups, the center of each group is applied as a duration. A + on each group adds new tasks with the given duration preset.

### Handover to pomodoro view

It shall be possible to start a pomodoro for a task from the modal.
Currently, the pomodoro view also owns an optional "todo" field on a pomodoro. This ownership shall be transferred to the todo area, i.e. if a user enters a todo text on the pomodoro module, it ends up in the inbox list for the user as a task planned for today.

If a pomodoro is active for a task, it is automatically set to active and the time-in-active counts up.

### Move-between-lists view

As tasks are always in one list only, it is up to the user to arrange them in between lists. A similar drag+drop mechanic shall be available to move tasks between the lists. Also an option to add a new list or delete a list including all tasks in it (requires confirmation) shall be available.
