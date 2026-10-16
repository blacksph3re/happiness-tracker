# Contractual hours, an hour budget, and days off — proposal

> **Built, 2026-10-16, and not committed.** What is still true now lives in
> `CLAUDE.md` (*Time*, and the *Hour budget* and *Deduction rules* rows), so
> this file can go once you have read it. Where the build departed from the
> text below:
>
> - **Two intents, not four**: `dayoff.put` and `budget.put`. A clear is the
>   same intent with `kind` or `balance_minutes` null, and the row is kept, so a
>   stale mark arriving late cannot revive a cleared day.
> - **One read**, `GET /api/time/budget-records`, for every tag, rather than
>   one per tag. Cleared rows are left out of it.
> - **`contracts` is a digest collection of its own**, re-reading the rules. So
>   does `tags`: the addition and its switch live on the tag row, which had been
>   a gap before this work too — an addition edited on another device never
>   reached this one. Tested now.
> - **A band switched off is the rule without that band**, so a lower band can
>   take its place, rather than its deduction added back.
> - **A rule saved without a `contracts` key keeps the stored contracts**, so a
>   client that has never heard of them cannot wipe them.
> - **A reset before the first contract period is ignored**: the walk starts at
>   the period.
> - **`daily_minutes` is capped at 1440.**
> - **The pill is *Set hour budget***, because *Set budget* is the form's own
>   button.
> - **`budget.csv` is one file for every contracted tag**, with a *Tag* column,
>   and is only in the bundle when a tag has a contract.
> - An untracked row reads *Thu, Oct 15 · Not tracked* with *−8h 00m* and
>   *Mark day off* on the right, so the words sit where a holiday's name does.

*Re-issued with your answers folded in. Four small questions remain at the end;
every other `[assumed: …]` is now your answer. ★ marks what changed because of
an answer.*

| | Your answer |
| --- | --- |
| **1. What the toggles switch** | (a): each part of a tag's rule — the addition and each band — has its own *in budget* switch |
| **2. Hours per week or per day** | ★ An average per day. An uneven week (8h Mon–Thu, 4h Fri) balances by the end of the week, which is fine |
| **3. Contracts over time** | Periods from a start date, whole days only |
| **4. Where the rules live** | ★ Under the tag: workdays, days off and public holidays all belong to a tag's contract (question A below confirms one consequence) |
| **5. Half days** | Whole days only |
| **6. Kinds and allowance** | ★ No vacation allowance. Public holidays are **calculated per federal state** — researched below, it is easy — so they are told apart from days off marked by hand |
| **7. Offline** | Days off and resets through the sync queue; contracts online with the tag's rule |
| **8. Today** | Counts only once it is over |
| **9. Export** | A `budget.csv` in the bundle |
| **10. Where a budget starts** | At the first contract period, unless a reset says otherwise |
| **11. Future days** | ★ Can be marked ahead; today stays the top record — see *Planned days off* below |

## What you asked for

1. A tag can carry **contractual hours**, and the hours tracked under it
   accumulate into a running **hour budget**.
2. The budget can switch each **addition** — each part of the tag's rule — on or
   off on its own.
3. A **"Set hour budget"** record on the Record page fixes the balance at a date.
4. **Days off**: non-workdays (weekends) are free by rule, public holidays are
   free by calendar, and other days off are marked by hand. A workday with
   nothing tracked and no day off counts **minus** the day's hours.
5. A **budget mode** on the Record page: the balance, and an obvious mark on
   every workday that was neither tracked nor a day off.

## The rule

For one contracted tag, each local day `d` from the contract's start up to and
including yesterday:

```
expected(d) = 0                 if d is not a workday, a public holiday,
                                a day off, or before the contract
            = the daily hours   of the contract period in force on d
counted(d)  = what the tag tracked on d, plus or minus the parts of its rule
              switched on for the budget
balance(d)  = balance(d-1) + counted(d) − expected(d)
            = the reset value + counted(d) − expected(d)   on a day with a reset
```

- **Derived, never stored.** Edit a contract, mark a day off last March, or
  switch an addition off, and the history recomputes. Stored is only what you
  enter: contract periods, days off, resets.
- **A contract changes from a date** (★ whole days): periods, each in force from
  its `starts_on` until the next one's.
- **An untracked workday is labelled, not invented**: *not tracked · −8h 00m*,
  with one tap to mark it a day off.
- **Archived projects still count**, unlike in the tag totals, or archiving last
  year's project would change this year's balance.
- **Time on a non-workday, holiday or day off counts in full**, since nothing was
  expected.
- Days follow the existing rules; days off, resets and contract starts are local
  `DATE`s like `planned_on`.

## Public holidays (★ researched)

German public holidays are rules, not a list: fixed dates, dates relative to
Easter, and a table of which of the sixteen states keeps which, plus the odd
one-off (the nationwide Reformation Day in 2017, Berlin's 8 May in 2020 and
2025). So they are **described and calculated, never imported or stored** — the
same shape as the auto-tracked variables:

- `services/holidays.py` and its port `lib/time/holidays.js`: the Easter
  calculation, the state table with the year each rule began (Berlin's Women's
  Day from 2019, Mecklenburg-Vorpommern's from 2023, Thuringia's Children's Day
  from 2019), and the one-offs. A few dozen lines each, no network, works
  offline.
- **Held to an outside reference**: the [`holidays`](https://pypi.org/project/holidays/)
  package (0.106, maintained, all sixteen states, checked against it here) joins
  the dev dependencies, and `dump_derivations.py` writes every state × every
  year 2015–2035 into the corpus. Both implementations must match it, so a rule
  I get wrong fails a test rather than a payslip. It never reaches the image.
- **Rejected**: `holidays` as a runtime dependency (the budget is computed on
  the device, so the server copy would have no reader); the npm `date-holidays`
  (11 MB unpacked, with lodash and a YAML parser, for one country); an online
  calendar such as `date.nager.at` (the budget must work offline, and the app
  would depend on a third party being up).
- A contract period names its **state** (or none). Holidays observed only in
  some municipalities — Assumption Day in Catholic Bavaria, Corpus Christi in
  parts of Saxony and Thuringia, Augsburg's Peace Festival — follow the
  reference library's state-level answer; anything more local is a day off
  marked by hand. `[assumed: question C]`

## Data model

Three new tables and two columns; all are new tables or nullable columns with no
default, so nothing is rebuilt (measured with `rootpage`).

**`tag_contracts`** — one row per period

| Column | |
| --- | --- |
| `tag_id` | FK tags, cascade |
| `starts_on` | `DATE`, unique per tag |
| `daily_minutes` | ★ `INTEGER ≥ 0` — the average per workday; 0 ends the contract from that date |
| `workdays` | `INTEGER` bitmask, Monday = 1 … Sunday = 64; Mon–Fri (31) by default |
| `state` | ★ `Literal` of the sixteen state codes (`"NW"`, `"BY"`, …), or NULL for no public holidays |
| `updated_at` | for the digest |

**`tag_days_off`** — ★ a day off marked by hand, per tag

| Column | |
| --- | --- |
| `tag_id` | FK tags, cascade |
| `day` | `DATE`, unique per tag |
| `kind` | ★ `Literal["vacation", "sick", "other"]` — public holidays are calculated, not marked |
| `note` | optional, ≤ 200 |
| `client_updated_at`, `updated_at` | last write wins; the digest |

**`budget_resets`** — "Set hour budget"

| Column | |
| --- | --- |
| `tag_id` | FK tags, cascade |
| `day` | `DATE`, unique per tag |
| `balance_minutes` | `INTEGER`, may be negative — the balance at the **start** of that day |
| `client_updated_at`, `updated_at` | |

**Toggles**: `tags.add_in_budget` and `deduction_bands.in_budget`, both
`BOOLEAN NULL` read as true. All on, the budget counts the tag's reported time.

## API

- **Contracts and toggles** ride on the tag's rule (online, on Projects):
  `TagRuleIn`/`TagRuleOut` gain `add_in_budget`, `in_budget` per band, and
  `contracts: [{starts_on, daily_minutes, workdays, state}]`.
- **Days off and resets** are four sync intents — `dayoff.put`, `dayoff.clear`,
  `budget.set`, `budget.clear` — each keyed on tag and day, last write wins on
  the device clock, refused per intent for a tag the caller does not own.
- **Reads**: `GET /api/tags/{id}/budget-records` returns the tag's days off and
  resets. `/api/changes` gains `days_off` and `budget_resets`; contracts move
  `rules`.
- **The budget is computed on the device**, as tag totals are.
  `budget_days` in `services/timetrack.py` is the reference, held to
  `lib/time/budget.js` by the corpus. The export bundle gains `budget.csv`
  (day, kind, expected, counted, change, balance).

## Client

- **Budget mode** on the Record page: a third pill beside *By project* and
  *By tag*, shown only when a tag has a contract (with a picker when several
  do).
  - The heading carries the **current balance**; week dividers carry the week's
    change.
  - **Every day** from the budget's start is listed, newest first:
    - **tracked workday** — counted, expected and the day's ±, one line;
    - **untracked workday** — in the alarm colour, *not tracked · −8h 00m*, with
      **Mark day off** beside it;
    - **non-workday, public holiday, day off** — one muted line each
      (*Saturday*, *Christmas Day*, *Vacation*), never alarming;
    - **reset** — its own row, *Budget set to +0h 00m*; the balance restarts.
  - **Today** is the top record, showing progress against the day's hours, and
    counts once it is over.
- **★ Planned days off** stay out of the list, so today remains the top record.
  One compact line sits above it — *3 days off planned · from Mon, Dec 22* — and
  opens in place to list them, each removable. Days off appear in the list only
  once they arrive. `[assumed: question D]`
- **The add panel gains a kind**: *Session · Day off · Set budget*. A day off may
  span a range, marking each workday in it that is not already a holiday.
- **The tag rule editor** on Projects gains the contract periods (start, hours
  per day, workdays, state) and the *in budget* switches.
- Days off and resets live in the store and the snapshot, revalidated through
  the digest, so budget mode paints offline.

## What else this touches

- `CLAUDE.md`: the *Deduction rules* row grows the toggles; a new
  settled-decisions row for contracts, days off and public holidays.
- Budget mode lists days with nothing tracked, unlike the record — deliberate:
  there such a day carries a cost and an action.
- `holidays` joins the dev dependencies only; the production image is unchanged.
- No settled decision is reversed.

## Tests I intend to write first

Server:

- Expected hours: 8h a day on workdays, 0 otherwise; a period from a date changes
  only days from that date; nothing before the first period.
- A public holiday zeroes a workday for a contract in that state and not for one
  in another; a day off zeroes a workday; neither changes a non-workday.
- Time on a non-workday, holiday or day off counts in full; an untracked workday
  costs its hours; today counts nothing until it is over.
- A reset fixes the balance at the start of its day; the latest one before a day
  wins.
- Each toggle — the addition off, a band off, both — and all on equals reported
  time.
- An archived project's time still counts.
- Ownership: another account's tag answers 404, and its days off and resets are
  refused per intent.
- The digest moves on a day off, a reset and a contract change.

Device and corpus:

- `lib/time/holidays.js` and `services/holidays.py` both match the `holidays`
  reference for every state and every year 2015–2035, one-offs included.
- `lib/time/budget.js` and `budget_days` agree on contract changes mid-month, a
  week off, a reset, a DST week and a leap day.

End to end:

- Budget mode shows the balance and flags an untracked workday; **Mark day off**
  clears it and the balance moves by the day's hours.
- A public holiday in the contract's state reads as such and costs nothing.
- A *Set budget* record restarts the balance and survives a reload.
- A day off marked offline shows at once and reaches the server on reconnect.
- A planned day off appears in the line above today, not in the list, and joins
  the list on its day.
- Switching an addition off changes the balance and leaves *By tag* alone.
- At 320px every row fits, and an untracked day says so in words as well as
  colour.

Each fix gets a mutation probe naming the test that fails.

## Still open

A. **Days off per tag** (your answer to 4) means that with two contracted tags,
   a vacation day is marked on each separately. `[assumed: fine — you have one
   contract]`
   --> Fine.
B. **Naming**: *Day off* for what you mark, *Public holiday* for what is
   calculated, *Set hour budget* for the reset. `[assumed: these]`
C. **Local holidays** below state level follow the reference library's state
   default, which leaves them out: Assumption Day is *not* a Bavarian holiday
   there, nor Corpus Christi a Saxon one, so somebody in a municipality that
   keeps them marks the day by hand, once a year. `[assumed]`
   --> agree
D. **Planned days off** as one collapsed line above today, opening in place.
   `[assumed]` The alternative is a small *Planned* section at the foot of
   budget mode.
--> Collapsed line sounds best.