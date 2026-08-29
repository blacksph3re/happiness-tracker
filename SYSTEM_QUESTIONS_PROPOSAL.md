# Auto-tracked questions: compute them, stop storing them

This started as "should `question_ids` always be a one-element list?" I argued
against removing the cross-catalogue merge, because the merge is not the
problem — it is the read side repairing a split the *write* side already makes.
Your follow-up is a better idea than either of ours, and it dissolves the
original complaint instead of working around it:

> consider just storing a `created_at` field in every question and computing the
> system answers on-the-fly instead of persisting them at all

Answers inline; I will fold them in and re-issue before writing code.

---

## What is actually stored

Measured on the local `backend/database.db`, 127 answered days:

| | rows | |
| --- | ---: | --- |
| Answers, all | 1397 | |
| — recorded by a person | 762 | 55% |
| — auto-tracked | 635 | 45% |
| ‣ pure functions of the day key | 508 | **36% of the whole table** |
| ‣ genuinely recorded | 127 | `first_answer_hour` only |

Plus 10 system questions across 2 catalogues, and 38 system option rows.

`_system_values` is the whole of it ([wellbeing.py:430](backend/services/wellbeing.py#L430)):

```python
"weekday":           float(day.isoweekday() - 1),
"day_of_year":       float(day.timetuple().tm_yday),
"month":             float(day.month - 1),
"year":              float(day.year),
"first_answer_hour": float(local_hour),
```

Four of the five take nothing but `day`. They are the purest derivation in this
codebase, and the house rule is unambiguous: **derived values are computed on
read, never stored.** A stored weekday is a stored `date.isoweekday()`.

## The app already decided this once

`lib/facets.js:18` — the time half computes weekday from the date and says why:

> Not read from the questionnaire's auto-tracked weekday, even though one
> exists: that is recorded only on days that were *answered*, so a day with
> tracked hours and no answers would silently drop out of a weekday filter.
> **The calendar always knows.**

So today one half of the app derives weekday from the day key while the other
half stores it as answer rows — and the stored one is *strictly worse*, because
it only exists on answered days. This proposal extends the decision already
taken rather than making a new one.

## What falls out

Not a tidy-up. Removing the stored rows removes a whole apparatus:

- `question_ids` becomes a one-element list for every remaining variable — the
  original complaint, gone, with no migration of anything a person recorded.
- The merge block in `stats.py` goes, and with it `by_system_key`.
- `sync_system_answers` goes entirely, including its arbitrary choice of which
  catalogue to write a day's values into.
- `UniqueConstraint("catalogue_id", "system_key")` goes.
- The 38 system option rows go, and with them the repointing hazard that made
  a per-user hoist look expensive in the first place.
- `scripts/restore_system_options.py` becomes dead. It exists *only* because a
  migration once cascaded those option rows away and the API cannot recreate
  them — a script whose entire job is repairing data that need not exist.
- The `Question.system_key.is_(None)` filter in the catalogue delete guard goes.
- 36% of the answers table goes.

---

## The one that is not derivable

`first_answer_hour` is real recorded data. `Answer` has **no `local_hour`
column** — the hour arrives on the sync intent and is persisted only as this
one system answer's value. Delete the row and the fact is gone.

### Where should the hour live?

`[assumed: A]`

| | |
| --- | --- |
| **A** *(recommended)* | Add `local_hour` to `Answer`; derive the variable as `min(local_hour)` over the day |
| **B** | Keep `first_answer_hour` as the last surviving system question |
| **C** | A `day_meta` table keyed on `(user, day)` |

**A** puts the fact on the row that knows it, and it is *more* correct than what
ships today. `sync_system_answers` writes the hour once and never revises it —
"Existing rows are left untouched, so `first_answer_hour` keeps recording the
first submission rather than the most recent one". That is right when writes
arrive in order. It is wrong across two devices: a phone that answered at 09:00
while offline and syncs after a laptop that answered at 14:00 records **14**.
`min()` is order-independent and cannot get it wrong.

**B** keeps most of the mess — a catalogue-scoped question, the merge, the
option-free but still per-catalogue duplication — for a fifth of the data.

### The backfill wrinkle, stated plainly

Historical answers have no per-row hour; the old data holds one hour per *day*.
Backfilling gives every answer on a day that day's hour, so `min(local_hour)`
reproduces the old value **exactly** — but for historical rows the column means
"the day's first hour", not "this row's hour". Going forward it means the row's.

I would rather write that down than let it be discovered. It is invisible to the
only consumer, which takes the minimum either way.

---

## Where `created_at` fits, and where it does not

It is **not** needed to decide which days get system values. That set is
`SELECT DISTINCT day FROM answers WHERE user_id = ?` on the server, and on the
client it is the days already loaded. Weekday needs the date and nothing else.

But I would take it in the same change, for a reason that landed this week: the
correlations list is getting an overlap floor of half the window. A question
added two months ago cannot reach half a year's overlap, and **today the page
cannot tell "this question did not exist yet" from "you skipped it"** — so it
would silently drop out of the ranking and look broken. `created_at` lets the
list say which, rather than omitting the row.

`Question` carries `updated_at` and no `created_at`, so this is a genuine
addition: nullable, no server default, which is the shape that adds in place
without rebuilding the table.

`[assumed: added in the same change, and used by the correlations list to
explain an absence rather than hide it]`

---

## The migration, which is the dangerous half

It **deletes answers**, and "Answers — never deleted" is a settled decision in
`CLAUDE.md`. I think this is outside what that rule protects — these rows were
written by the server, not by a person, and every value except the hour is
recomputable exactly — but it is your call and I will not assume it.

`[assumed: acceptable for auto-tracked rows; the settled-decisions row gets
amended to say so]`

Order matters, and phase 2 is load-bearing:

1. Add `Answer.local_hour` and `Question.created_at`, both **nullable with no
   server default**, so both add in place rather than rebuilding.
2. **Backfill `local_hour` from the `first_answer_hour` answers, before
   anything is deleted.** This is the only step that cannot be redone.
3. Guard: count auto-tracked answers whose day has no `local_hour` on any row.
   Raise if it is not zero. A migration that refuses to run beats one that
   half-succeeds.
4. Delete auto-tracked answers, then their options, then the questions —
   deepest first, because foreign keys are off for the migration connection and
   cascades do not fire.
5. Drop `uq_question_system_key` via `copy_from=` omitting it.

Verification, per house practice:

- `sqlite_master.rootpage` either side of the upgrade, with a control on a table
  known to rebuild, to confirm steps 1 add in place.
- Rehearse against a fresh copy of production: row counts per table,
  `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, then boot the ORM
  against the migrated copy. Delete the copy — it holds password hashes and
  encrypted TOTP secrets.

### One thing the existing test will not catch

`test_migrating_a_populated_database_keeps_its_rows` seeds a question with a
**null** `system_key`, so a migration deleting only auto-tracked rows passes it
untouched. That is correct behaviour and also means the walk test is blind here.
This migration needs its own, in the shape of
`test_shared_catalogues_become_one_per_user_without_losing_answers`: seed both a
real question and a full system set, migrate, and assert the real answers all
survive, the hour reached `local_hour`, and no system rows remain.

---

## Open questions

1. **The hour**: A, B or C above. --> A.
2. **Deleting auto-tracked answers** — acceptable against the "never deleted"
   rule? `[assumed: yes]` --> Yes, delete.
3. **The CSV export.** System answers presumably appear in `/api/answers` and
   the export today. After this they would be computed rather than stored —
   should the export still carry weekday and month columns, computed?
   `[assumed: yes, computed, so the file does not change shape]` --> Yes, computed.
4. **Ordering against correlations.** This touches `Stats.svelte`, `facets.js`
   and the variables endpoint, all of which the correlations rework also
   touches. Doing this **first** means correlations is built once, against the
   simpler shape, and gets `created_at` for free — but it delays the feature
   behind a migration. `[assumed: correlations first, this second, because the
   feature is what you actually asked for and this is cleanup that will keep]`
   --> Exactly, I already sent you working on the correlations feature.

## What I am not proposing

- **No change to how a day is decided.** The client still sends `day` and the
  server still stores what it is told.
- **No removal of the variables endpoint.** It keeps returning weekday, month
  and the rest — they simply stop having answer rows behind them, exactly as
  computed scores already do.
- **No per-user system questions.** That was the expensive option from the last
  thread, and this makes it unnecessary rather than cheaper.
