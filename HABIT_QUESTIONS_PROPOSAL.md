# Habit questions — second draft

*Your answers folded in. **Changed** marks where an answer moved the design
rather than confirming it. Five new open questions at the bottom; the first one
is the only one I would not build without an answer, because it changes a number
already on your screen.*

A habit is an **enum question with three extra facts**: which of its options
count, how many you meant to manage in a period, and whether the target is a
floor or a ceiling. It is not a new kind of question, not a new table, and not a
second thing to answer.

| | |
| --- | --- |
| A habit **is** | an enum question. Same table, same answers, same freeze rules |
| A habit **adds** | a target (`3 × per week`, `at most 2 × per week`), a mark on the options that count, and an emoji |
| A streak **is** | consecutive **periods** that met their target — not consecutive days |
| Where it shows | the landing page (one chip per habit) and Patterns → Streaks |
| What it costs | five columns, one endpoint, two table rebuilds, and **no new request anywhere** |

### What changed since the first draft

| | |
| --- | --- |
| `succeeds` → **`counts`** | Two directions make "succeeds" read backwards — see below |
| **`habit_direction`** | New column. `at_least` and `at_most`, per your answer to 6 |
| **CHECK constraints are in** | So the migration rebuilds `questions` and `question_options` |
| **`icon`** | New column, an emoji, per your answer to 1 |
| **Daily tracking means a *finished* questionnaire** | Per your answer — and it **moves the number on your landing page today.** New open question 1 |
| **A best-ever run** beside the current one | From the screenshot's ⚡/🔥 pair |
| `Literal` rather than `str` | Verified against SQLAlchemy; also buys a free 422 |

### Settled, and not revisited below

Day / week / month only, no quarter. Unrecorded periods end a run. `lib/habits.js`
in the shared zone, with a later restructure left open. The streak view ignores
the day filters and carries its own span control. I pick the colours — `sage` for
met, `alarm` for missed, both already declared in `@theme static` as "Status, not
decoration … so a tick means the same green wherever it is drawn."

---

## What already works and needs nothing

Most of the feature, and the payoff for not inventing a new entity:

- **Filters.** A habit is an enum question, so `answerFacet` already offers it as
  chips on both patterns pages. Zero lines.
- **The questionnaire**, including offline answering and the projection over the
  outbox.
- **The record table, the CSV export, Totals, and the correlation ranking.**
  Unchanged.
- **Offline reading.** `catalogueDetails` and `answers` are both in `PERSISTED`,
  so a device that has seen the catalogue once computes every streak from its own
  snapshot with no connection at all.

---

## The database

### `question_options.counts` — **renamed**

```python
counts: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")
"""Whether choosing this option counts towards the habit's target.

Not `succeeds`, which is what the first draft called it. With two directions the
counted option is not always the happy one: a smoking habit counts *Yes*, and
marking "Yes, I smoked" as succeeding reads backwards. `counts` is neutral about
which side of the target you are aiming for, which is the only word that stays
true for both.
"""
```

### `questions.habit_period`, `habit_target`, `habit_direction`

```python
HabitPeriod = Literal["day", "week", "month"]
HabitDirection = Literal["at_least", "at_most"]

habit_period: Mapped[HabitPeriod | None] = mapped_column(String(8), nullable=True)
"""The period a target is measured over, or NULL for a question that is not a habit.

One nullable column doubling as the flag, the same shape as
``pomodoros.notified_at``: there is no ``is_habit`` to disagree with it.
"""

habit_target: Mapped[int | None] = mapped_column(Integer, nullable=True)
"""How many days in a period must carry a counted answer.

Zero is meaningful, and only under ``at_most``: "no more than nothing" is how a
habit you are trying to stop is written.
"""

habit_direction: Mapped[HabitDirection | None] = mapped_column(String(8), nullable=True)
"""Whether `habit_target` is a floor or a ceiling."""
```

`Literal` rather than `str`, as you asked. I checked it against SQLAlchemy rather
than assuming — `Mapped[HabitPeriod | None]` with an explicit
`mapped_column(String(8))` produces `VARCHAR(8) NULL` and round-trips a value, so
the annotation is documentation and tooling only, with no runtime cost. The place
it becomes *enforcement* is the Pydantic schema: `habit_period: HabitPeriod | None`
on `QuestionCreate` rejects `"fortnight"` with a 422 and a field-accurate message,
for free and before any handler runs.

### `questions.icon` — new

```python
icon: Mapped[str | None] = mapped_column(String(16), nullable=True)
"""A short emoji shown where the question has to be compact.

Today that is the habit chips, which is what it was added for — but nothing here
ties it to habits, so a future compact rendering of an ordinary question needs no
second column. Emoji rather than an icon set: no asset pipeline, no build step, it
renders on every device, and you can pick any of them.
"""
```

Not part of the habit constraint below. Tying it to habits would be a constraint
to relax the first time an ordinary question wants one.

`String(16)` is about four simple emoji or one many-codepoint one. Not validated
as *being* an emoji — that is a grapheme-cluster rabbit hole, this is your own
field, and the editor offers a dozen suggestions beside a text input that a
phone keyboard fills from the emoji key.

### The constraints — **changed**

You would rather have them in the schema, so they are in the schema:

```python
CheckConstraint(
    "(habit_period is null) = (habit_target is null)"
    " and (habit_period is null) = (habit_direction is null)",
    name="ck_question_habit_triple",
),
CheckConstraint(
    "habit_period is null or kind = 'enum'",
    name="ck_question_habit_enum",
),
CheckConstraint(
    "habit_period is null or habit_period in ('day', 'week', 'month')",
    name="ck_question_habit_period",
),
CheckConstraint(
    "habit_direction is null or habit_direction in ('at_least', 'at_most')",
    name="ck_question_habit_direction",
),
CheckConstraint(
    "habit_target is null or habit_target >= 0",
    name="ck_question_habit_target",
),
```

The same rules also live in `services/wellbeing.py`, because a constraint
violation is a 500 and a service check is a 422 that says which field. The schema
is the floor under a bad `UPDATE`, not the thing users meet.

**The price is two table rebuilds.** A changed constraint sends batch mode down
the copy-`DROP`-rename path, and so does `counts` being `NOT NULL`. So this
migration rebuilds `questions` and `question_options` — which is the operation
that once emptied every answer in this database, and is also the operation the
last migration performed successfully on `questions` under the procedure that
exists for it:

- `env.py` disables foreign keys for the migration connection, so the `DROP` does
  not cascade;
- `tests/test_migrations.py` seeds at the first revision and walks the whole
  chain, failing if any revision loses a row;
- rehearsed against a fresh copy of production before it goes near the real one —
  row counts per table, `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, then
  booting the ORM against the migrated copy, then deleting the copy, because it
  holds password hashes and encrypted TOTP secrets;
- `SELECT name, rootpage FROM sqlite_master` either side, to confirm **which**
  tables moved. `answers` is the control: it must be untouched, and if it is not,
  the migration is wrong in a way no row count would catch.

`icon` on its own would have been an in-place add. It comes along for free now.

### Nothing derived is stored

No `streak` column, no per-period `met` rows. The streak is read out of the
answers every time, which is what makes a changed target retroactive: flip a
habit from `at_least 1` to `at_most 2` and the whole history re-reads correctly,
exactly as editing a score's components fixes last month. `answers` holds what
happened; a streak is a view.

---

## Two directions, four states, one rule

Adding `at_most` is a bigger change than it looks, because it inverts what an
empty period means. The whole of it fits in one function:

```js
/**
 * What a period is worth, in the only place that decides it.
 *
 * `recorded` is deliberately checked before either direction. Under `at_most` a
 * week with no answers has a count of zero and would otherwise read as met — the
 * app awarding itself a smoke-free week for a week nobody described. A period
 * the person never spoke about is `unrecorded` whichever way the target points.
 */
function verdict({ recorded, count, target, direction, isCurrent }) {
  if (!recorded) return 'unrecorded'
  if (direction === 'at_least') {
    return count >= target ? 'met' : isCurrent ? 'open' : 'missed'
  }
  return count > target ? 'missed' : isCurrent ? 'open' : 'met'
}
```

| State | Means | Drawn |
| --- | --- | --- |
| **met** | the target was honoured, and the verdict is final | `sage` |
| **missed** | it was not, and the verdict is final | `alarm` |
| **unrecorded** | no answer to this question in the period at all | outline only |
| **open** | the current period, verdict not yet final | outline, part-filled |

**Missed is not unrecorded.** A week you never answered is not a week you did not
go to the gym, and colouring it red is the app inventing data.

**Open is the grace rule made visible.** The current period cannot count against
you until its verdict is final — the same reasoning already written into
`streak()`'s docstring about unanswered todays. And "final" is where the two
directions genuinely differ, which is worth stating because it looks like an
inconsistency until you see why:

- Under **at_least**, a met current period is final — you went to the gym on
  Monday and nothing later can un-go. It counts immediately.
- Under **at_most**, an *under-budget* current period is never final — Thursday
  can still spend it. It never counts until the period closes.
- Under **at_most**, an *over-budget* current period **is** final, and is drawn
  red straight away. It does not count against the streak either, because the
  streak simply starts from the period before it — so the red cell sits visibly
  outside the run rather than contradicting it.

That last point is the "two numbers on one screen" rule doing its job: the run is
drawn as the trailing sequence of green cells, so the number and the picture
cannot disagree.

### `at_most` and the cost of proving a negative

One consequence worth your eyes. Under `at_most`, a period counts as recorded
if it has **at least one** answer to that question — not if every day in it does.
So one "No" on Monday is enough for a clean week.

That is the same standard `at_least` already uses (one gym visit proves the
week), and the alternative — every day in the period answered — makes a
stopping-habit far more demanding than a starting one, for a streak you are
trying to protect. But it does mean a week with one honest "No" and six silent
days reads green. New open question 2.

---

## The streak, generalised

```js
/**
 * How many periods in a row, up to the current one, met their target.
 *
 * The current period is skipped rather than counted against you when its verdict
 * is not yet final: a weekly habit would otherwise read zero every Monday, which
 * is the same reasoning that already lets an unanswered today leave a daily run
 * standing. Two unmet periods in a row is what ends it.
 */
export function habitStreak(habit, verdicts, from = today()) {
  const { period: unit } = habit
  const met = (key) => verdicts[key] === 'met'
  let cursor = periodKey(unit, from)
  if (!met(cursor)) cursor = previousKey(unit, cursor)
  let run = 0
  while (met(cursor)) {
    run += 1
    cursor = previousKey(unit, cursor)
  }
  return run
}
```

`periodKey(unit, day)` is `period(unit, day).start` — canonical, and already
computed by `lib/period.js`. For `unit === 'day'` that is the day key itself, so
**the existing `streak()` is this function with `unit: 'day'`, `target: 1`,
`at_least`**, and `day.test.js`'s eight cases become the proof that the
generalisation is one rather than being rewritten. That includes the leap-day and
century cases, which `period.js` already handles by going through `Date.UTC`.

A period's count is the number of **days** in it carrying a counted answer. Days
rather than answers, and they are the same number for free: `uq_answer_per_day`
allows one answer per question per day. Worth stating because it is what would
silently change if that constraint ever moved.

**The best-ever run** comes from the same walk over every period the account has
answers for, so it costs one pass and no request. Over all of history, not over
the window on screen — a window that cuts through your best month would otherwise
report a personal best that shrinks when you scroll.

---

## "Daily tracking" — **changed, and it moves a number**

You said the synthetic habit should advance when *all* the catalogue's questions
are answered. That is a real change of meaning, and I want it on the record
before it is built, because `streak()`'s docstring currently argues the opposite
in so many words:

> A day counts once however many questions it holds: this is about turning up,
> not about finishing, and a day left half-answered still happened.

Under the new rule a half-answered day is a **missed** day. So:

- **The number on your landing page will change the day this ships**, downwards,
  by however many half-answered days sit inside your current run. My v1
  acceptance test — "same account, same day, same integer" — is void, and is
  replaced by one asserting the new definition.
- A half-answered day is now `missed` (red) rather than `unrecorded` (blank),
  which is a distinction daily tracking did not previously have and is arguably
  the best thing about the change: the grid shows you the difference between a
  day you skipped and a day you abandoned halfway.

And one consequence I do not think is obvious, which is new open question 1:
**"all the questions" means all the questions as they stand now.** Add a question
today and every past day becomes incomplete, so the entire historical streak
collapses to zero. Deactivate one and days that skipped it turn green. There is
no record of which questions were active on a past day, so this cannot be fixed
by being cleverer — only by choosing which behaviour you want.

```js
export const DAILY_TRACKING = {
  key: 'tracking',
  label: 'Daily tracking',
  icon: '✅',
  period: 'day',
  target: 1,
  direction: 'at_least',
}
```

Its counted days are the days that answered every **active, asked** question in
the default catalogue — scores are computed, so they are not owed an answer.
Described rather than stored, exactly as `SYSTEM_SPECS` are: no migration, no row
in anybody's catalogue, and no question of what happens when you delete the
catalogue it lived in.

`[assumed: still exactly one synthetic habit, and it counts answers only — not
tracked time or pomodoros]`, since a wellbeing streak fed by the time half would
be the first place the three halves linked.

---

## Where the code goes

`app/src/lib/habits.js`, in the **shared zone** — the landing page is shared and
must not point outward at a wellbeing module, which is the argument that moved
`systemValues` into `lib/day.js`. You noted a later restructure could let habits
live in the wellbeing world; nothing here forecloses it, since the module holds no
question-editing logic and has exactly two callers.

Exports: `DAILY_TRACKING`, `habitsIn(catalogue)`, `hitsByPeriod`, `verdictFor`,
`habitStreak`, `bestRun`, `periodStates`.

CLAUDE.md's Lib table gains `habits.js` in the Shared column.

---

## The API

```
POST   /api/catalogues/{id}/questions      + habit_period, habit_target,
                                             habit_direction, icon
                                           + counts on each option
PUT    /api/questions/{id}                 + the same four
PUT    /api/questions/{id}/options/{oid}   NEW — label and counts
GET    /api/catalogues/{id}                QuestionOut gains the four;
                                             OptionOut gains counts
```

Nothing is added to `/api/stats/variables`. A habit definition lives in exactly
one payload — the catalogue — because two copies of a definition is how the
transfer button ended up disagreeing with the totals above it. The Patterns page
calls the existing `ensureAllCatalogues()` instead. That also settles a case the
variables endpoint gets wrong here: it returns only questions the account has
**answered**, so a habit defined yesterday would have no streak rather than a
streak of zero.

### The freeze rule must not apply to `counts`

`add_option` and `delete_option` both answer `409` once a question has been
answered, and rightly: adding a choice retroactively changes what the recorded
ones meant. **Marking an existing option as counted is the opposite kind of
change** — a definition over answers that are already correct, and definitions
are retroactive here by design. Adding and removing options stays frozen;
`counts`, `label`, the target, the direction and the icon are editable whenever,
and a test says so by name.

### Ownership

The new endpoint resolves a bare option id, which CLAUDE.md flags as an
authorization hole the moment the row has an owner. It scopes through
`_get_question(db, question_id, user.id)` and then checks
`option.question_id == question.id`, which is what `delete_option` already does —
the resolver is scoped, not the handler. Another account's option answers `404`,
and `test_permissions.py` gains a case.

### `OptionUpdate` already exists and nothing uses it

`schemas.py:404` declares it with a `label` field, referenced nowhere — a rename
endpoint designed and never built. This wires it up and adds `counts`.

---

## What it looks like

Your screenshot's two ideas are both worth taking: **an emoji carries a habit in
almost no space**, which is what makes a row of them fit under three cards, and
**two numbers per habit** — the run you are on and the best you have managed —
say more together than either does alone.

### The landing page

```
  ┌─ Wellbeing ───────┐ ┌─ Time ────────────┐ ┌─ Focus ───────────┐
  │  2 of 7 left      │ │  Nothing running  │ │  3 pomodoros      │
  │  Answer today  →  │ │  Check in      →  │ │  Back to it    →  │
  └───────────────────┘ └───────────────────┘ └───────────────────┘

  HABITS
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │ 🏃  Gym          │ │ 📖  Read         │ │ 🚭  Smoke        │
  │ 🔥 5 weeks       │ │ 🔥 3 weeks       │ │ 🔥 11 weeks      │
  │ ⚡ best 11       │ │ ⚡ best 7        │ │ ⚡ best 11       │
  └──────────────────┘ └──────────────────┘ └──────────────────┘
  ┌──────────────────┐
  │ ✅  Tracking     │
  │ 🔥 14 days       │
  │ ⚡ best 62       │
  └──────────────────┘
```

A strip **below** the three cards, never inside the wellbeing one: CLAUDE.md
records that the streak rides on the section label precisely because a fourth
line pushed the button off the fold on a phone, and four habits would be four
more lines. Daily tracking becomes the last chip and leaves the card's label, so
the same number is not in two places.

A habit whose run is zero still shows a chip, reading `🔥 —  ·  2 of 3 this week`.
Hiding it at zero is right for the single streak on a card, where zero is only
ever an accusation, and wrong for a list you deliberately opened.

`Streak · 1 week` and not `1 weeks`. Your screenshot has `0 Day`, `1 Day` and
`13 Days` on one screen, which is exactly the trap `toContainText` cannot see.

### Patterns → Streaks

```
   ← 26 weeks                                              12  26  52

   🏃 Gym              at least 1 × / week    🔥 5 weeks   ⚡ best 11
      Mar      Apr       May       Jun       Jul       Aug
      ■ ■ □ ■  ■ ■ ■ ■   · · ■ ■   ■ □ ■ ■   ■ ■ ■ ■   ■ ■ ■ ▪

   📖 Read              at least 3 × / week   🔥 3 weeks   ⚡ best 7
      ■ □ □ ■  ■ □ ■ ■   · · ■ □   ■ ■ □ ■   ■ □ ■ ■   ■ ■ ■ ▪

   🚭 Smoke             at most 0 × / week    🔥 11 weeks  ⚡ best 11
      □ □ ■ ■  ■ ■ ■ ■   ■ ■ ■ ■   ■ ■ ■ ■   ■ ■ ■ ■   ■ ■ ■ ▪

   ✅ Daily tracking    at least 1 × / day    🔥 14 days   ⚡ best 62
      ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪

   ■ met      □ missed      · nothing recorded      ▪ still open
```

One row per habit, one cell per period, every row spanning the same calendar
window — so a weekly row has fewer, wider cells than a daily one, which is the
truthful drawing: the rows cover the same time. The header restates the rule in
words (`at most 0 × / week`) because a grid of colours cannot say which direction
it is scoring, and a `🚭` row of solid green would otherwise be ambiguous.

**Plain DOM, not ECharts.** It is a row of coloured cells; a chart library adds
nothing to the drawing and a great deal to the testing — CLAUDE.md's e2e lessons
about `getOption()` polling and the `[0, 0, 0]` race are all about asserting on a
canvas. `<div data-state="met" data-period="2026-06-08" title="2 of 3">` is read
directly, and the tests assert the attribute rather than a computed colour, which
is also the standing advice about styles sampled mid-transition.

Two things this view does differently from its neighbours, both as agreed in v1:
it **ignores the day filters** — a streak over "only Saturdays" is not a streak,
since the target says *per week* — and it carries **its own span control in
periods** (12 / 26 / 52) rather than the shared `windowDays`, because a weekly
habit inside 30 days is four cells, and because a control belongs where its
effect is.

### The catalogue editor

```
  Options
  [ Long        ]  [x] counts        ← editable even when frozen
  [ Short       ]  [x] counts
  [ No          ]  [ ] counts

  [x] Track as a habit      icon [ 🏃 ]   🏃 📖 🧘 💧 🥗 😴 🚭 💊 ✍️ 🎸 🧹 💸

      [ at least ▾ ]  [ 1 ]  × per  [ week ▾ ]
      ─────────────────────────────────────────────
      Long and Short count. At least 1 day a week
      must count, or the streak breaks.
```

A sentence under the controls saying what the settings mean in words, because
`at_most 0` is the setting most likely to be read backwards, and because it is
cheap to be sure. The `counts` checkboxes stay enabled on a frozen question — the
freeze argument made visible — while the option *text* fields keep their existing
locks, so the frozen banner needs a sentence saying which is which.

---

## The sync gap, explained properly

You said question 5 did not make sense. That is my fault — it was written as a
choice before it was written as a problem. Here it is as a problem.

**The symptom.** You have the app open on your laptop. On your phone you change
the gym target from once a week to twice. Your laptop goes on showing *once a
week*, and therefore a different streak, until you force-reload it.

**Why.** Every thirty seconds — and on navigation, focus, and reconnect — the app
asks `GET /api/changes`, "has anything moved?" The server answers with a row
count and a last-modified time per collection. For anything to do with questions
it reports the **catalogue** table, and editing a question does not touch its
catalogue's row, so the honest answer is "nothing moved". I measured it rather
than reasoning about it:

```
BEFORE               : {'n': 2, 'at': '2026-08-30T13:38:37'}
AFTER ADD QUESTION   : {'n': 2, 'at': '2026-08-30T13:38:37'}
AFTER EDIT QUESTION  : {'n': 2, 'at': '2026-08-30T13:38:37'}

ADD  seen by the digest? False
EDIT seen by the digest? False
```

**This is true today**, for ordinary question edits — add a question on your
phone and your laptop will not see it either. Habits do not cause it. What habits
do is make it visible, because a habit's definition changes a *number* on the
landing page rather than only the wording of a question you would notice was
missing.

**The fix is four lines**: when a question, option or score is written, touch its
owning catalogue's `updated_at`. The existing `catalogues` fingerprint then
carries the whole subtree, `applyChanges` already re-reads every catalogue detail
it holds when that fingerprint moves, and no schema changes.

**The question was only about scope**, and I will make the call unless you say
otherwise: `[assumed: folded into this work]`. Habits are not trustworthy across
two devices without it, it is small, and it comes with one test that fails today.

--> agree, in scope.
---

## Habits are not in any starter template

`templates.py` only knows how to seed scaled questions — `ScaledQuestion` is the
only shape a `Template` holds. `[assumed: out of scope]`: the templates are
validated instruments, "Went to gym?" is not part of the WHO-5, and a new
template is a product decision rather than a piece of this one.

---

## What I intend to test

Written before the code, and each probed by breaking the thing it covers and
confirming **that named test** fails.

### Backend

| | |
| --- | --- |
| `counts`, target, direction and icon round-trip through create and update | |
| **`counts` may be changed on an answered question** | The freeze argument. Load-bearing |
| adding or removing an option is *still* frozen once answered | Proves the exemption is narrow |
| a habit target on a non-enum question is refused | 422 from the service layer |
| any one of the three habit columns without the others is refused | Both layers: 422 from the service, and the CHECK holds against raw SQL |
| `habit_period: "fortnight"` and `habit_direction: "roughly"` are refused | 422 from the Pydantic `Literal`, before a handler runs |
| `at_most` with a target of 0 is accepted; a negative target is not | Zero is the whole point of `at_most` |
| another account's option answers **404** on the new endpoint | The ownership sweep |
| the migration keeps every row across the whole chain | `test_migrations.py` |
| `rootpage` moves for `questions` and `question_options` and **not for `answers`** | The control that makes the measurement mean anything |
| a question edit moves the `catalogues` fingerprint | The gap above — currently fails |

### Frontend units (`habits.test.js`)

| | |
| --- | --- |
| `day.test.js`'s eight existing cases pass through `habitStreak` at `day`/1/`at_least` | Proves the generalisation is one |
| weekly `at_least` targets of 1, 2 and 3, each met and each missed by one | |
| `at_most 0`: a period with one counted answer is missed; with none *and* an answer, met | |
| **`at_most`: a period with no answers at all is `unrecorded`, not `met`** | The invented smoke-free week. The one I would most expect to regress |
| the current period, verdict not final, does not end the run; the one before it does | The grace rule, both directions |
| `at_most` over budget today is drawn `missed` and the run reads from last period | The red cell sits outside the run rather than contradicting it |
| an unrecorded period ends the run | |
| the week containing 1 January belongs to the ISO year of its Thursday | `period.js` knows; this asserts habits use it |
| daily tracking counts a day only when every active asked question is answered | The changed definition |
| a half-answered day is `missed`; an untouched day is `unrecorded` | What the change buys |
| `bestRun` reads all of history, not the window | |
| a habit with no option marked `counts` has a run of zero, not a crash | The state right after ticking "Track as a habit" |

### End to end

| | |
| --- | --- |
| the landing strip shows one chip per habit plus daily tracking | |
| answering a habit **offline** moves its streak with no reload | The projection over the outbox |
| a habit answered on the questionnaire updates the strip on the way back | Store-read, not loader-snapshot |
| the grid marks met / missed / unrecorded / open by `data-state` | Never by colour |
| a habit is still offered as a filter chip on both patterns pages | The "it is still an enum question" claim |
| the streak view survives `expectSettled()` | No refetch loop, page still answering |
| `🔥 1 week` is not `1 weeks` | With `toHaveText` |

---

## What I would build, in order

1. The five columns, the constraints and the migration — with the rootpage
   measurement, the control, and the rehearsal against a copy of production that
   is deleted afterwards.
2. `services/wellbeing.py` validation, the schema `Literal`s, the new endpoint and
   the freeze exemption, backend tests first.
3. `lib/habits.js` and its units; `day.test.js` redirected through it. Nothing on
   screen yet, so the streak logic is proven before anything depends on it.
4. The catalogue editor, so a habit can be defined at all.
5. The landing strip.
6. The Patterns streak view.
7. The `catalogues` watermark fix.
8. CLAUDE.md: `habits.js` in the shared Lib row, the freeze exemption beside the
   Answers row, the four states and the `at_most` empty-period guard under the
   "never invents data" principle, and the daily-tracking redefinition.

Steps 1–3 hold the arguments; 4–6 are drawing.

---

## Open questions

Answers inline again, please.

1. **Adding a question resets your daily-tracking streak to zero.** "Every
   question answered" is evaluated against the catalogue as it stands, and
   nothing records which questions were active on a past day, so this is a choice
   rather than a bug to fix. Three ways out, and I would take (a):

   **(a)** Accept it. Adding a question genuinely changes what a complete day
   means, and the streak is honest about it.
   **(b)** Keep "any answer" for daily tracking after all, and let the *grid*
   show completeness — a full cell for a finished day, a part cell for a
   half-answered one. The number stays generous, the picture stays honest, and
   nothing about your current streak moves.
   **(c)** Count a day as complete if it answered every question that had already
   been answered at least once before that day. Retroactivity-proof, and
   impossible to explain on a screen.

   I can also **measure this before we commit** — run both definitions over a
   copy of production and tell you what your streak actually becomes. Worth doing
   if you are torn.

--> I like B.

2. **Under `at_most`, does one answer make a period recorded?** One "No" on
   Monday earns a clean week, six silent days notwithstanding.
   `[assumed: yes]`, because the alternative — every day answered — makes a
   habit you are trying to break far more demanding than one you are trying to
   build, and demands the most answering exactly where the reward is a streak you
   are protecting. The alternative is defensible; it is just a different app.

--> Yes.

3. **Should a habit chip on the landing page be tappable to answer today?** Your
   screenshot's cards each carry a check button, and it is the best idea in it:
   `saveAnswer` already works offline, and one tap for "went to the gym" is a
   real improvement over opening the questionnaire. What it costs is a second
   place to answer a question — fine for two options, awkward for three, since
   "Long / Short / No" is a menu rather than a tick. **Out of scope as written**;
   say the word and it becomes step 5b.

   --> No, the landing page links to the questions card and the habits are normal questions then.

4. **`⚡ best` is the longest run ever.** The other reading of your screenshot is
   total days done — `⚡ 187 days` beside `🔥 82 days` for Eat Veggies. Longest
   run pairs better with the current one (same units, directly comparable, and it
   tells you what you are chasing), but total is the one that says how much of
   the thing you have actually done. One line either way; I picked the first.

   --> Longest run + current run seems best.

5. **Is `icon` on every question, or only on habits?** I put it on `questions`
   with no constraint tying it to habits, so an ordinary question can have one
   later without a migration — but only habits render it today. The alternative
   is `habit_icon` and a constraint, which is tidier now and a relaxation later.

  --> icon on all questions (optional) seems sensible, might also make the display of the normal questions nicer

