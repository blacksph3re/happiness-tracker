# Allocation views: merged times, and an allocated budget

Two follow-ups to the week allocation. Neither stores anything new on the
server: both are views, computed on the device like the allocation itself.
Answer inline next to any `[assumed: …]`; I'll fold the answers in and re-issue
before writing code.

## 1. Merged times on the allocation page

Today a day's span is its first start to its last end. Friday's split session
reads `06:32 – 17:22` beside `9h 18m`, so the span and the duration disagree by
the gap.

A switch on the page, three pills: **Natural · Start adjusted · End adjusted**.
The two adjusted modes are the two pairs Record's *Merge sessions* already
writes (`equivalentBounds`):

| Mode | As tracked | Allocated |
| --- | --- | --- |
| Natural | first start – last end | first start – last end, moved by what the day gained or gave |
| End adjusted | first start – (first start + duration) | first start – (first start + allocated duration) |
| Start adjusted | (last end − duration) – last end | (last end − allocated duration) – last end |

So Friday reads `06:32 – (15:50)` in *End adjusted* and `(08:04) – 17:22` in
*Start adjusted*.

- Which pill is which. *End adjusted* keeps the first start and moves the end,
  like Record's first pair `09:00 – (14:00)`. *Start adjusted* keeps the last
  end and moves the start. `[assumed: named for the time that moves]`
  --> Agree
- Additions on the clock. Today the **allocated** side puts additions on the
  clock and the **tracked** side doesn't. That is why an unchanged Tuesday reads
  `08:30 – 18:00` beside `08:30 – 19:00`. I'd take them off the allocated side's
  clock too: spans come from tracked time on both sides, and additions stay in
  the amounts line. `[assumed: tracked time only, on both sides]`
  --> No, include additions on both sides
- An adjusted time is in brackets on both sides, as on Record. A day with no gap
  reads the same in all three modes. `[assumed]`
  --> Agree
- The choice is kept per account, in the `allocation` preferences section
  beside the step: `{ step, bounds: 'natural' | 'start' | 'end' }`.
  `[assumed: Natural by default]`
  --> Agree

Tests: a split Friday in each mode, on both sides. An unchanged gapless day reads
the same in every mode, and the same on both sides. The choice survives a
reload. The pills fit on one line each at 320px, with 15% to spare.

## 2. Patterns' budget, allocated

Budget mode gains a selection: **As tracked · Minute · Quarter · Half · Hour**.
Any choice but *As tracked* allocates each week of the window with that step, and
its allowance, the same `allocateWeek` the allocation page uses. Then the budget
counts the allocated days. The heading, the line, the pies and the table all
follow, from the one `budgetWindow`.

- **What moves.** An allocated day holds its allocated tracked time and as many
  additions as the allocation gave it (0, 1, 2 …). Today one day holds one
  addition. So `budgetDays` learns to take a day's additions from the
  allocation. This is client-only, like the allocation; the server's budget and
  the conformance corpus are unchanged.
- **Which rule.** The allocation minimises the deduction the tag *reports*, as
  the allocation page does. The budget then counts the result with its *in
  budget* switches. With every switch on, as on your *Clocked* tag, the two are
  the same. `[assumed]`
  --> Agree, though here I am wondering if we even still need the in budget switch. After using the feature for a while I have realized I would only ever set them all to true. If it makes implementation easier, then remove the in-budget switches and just assume that if a contract is set that all deductions and additions are in budget.
- **The balance carried in.** Only the window's weeks are allocated; the balance
  carried into the window is the recorded one. The line then shows what
  allocating *these* weeks would have changed, and it can build from the start of
  the window. The alternative is to allocate every week since the last reset.
  That makes the opening balance allocated too, but the line can only start once
  those weeks are done (about 11 weeks since 1 August).
  `[assumed: the window's weeks only]`
  --> Only the window.
- **Weeks cut by the window.** A week is allocated whole (Monday to Sunday),
  even where the window starts or ends inside it; only the window's days are
  drawn. The current week allocates the days that are over, as the allocation
  page does. `[assumed]`
  ---> Agree
- **The build.** The allocation runs one week at a time, letting the page draw
  between weeks. The line grows from the window's start, week by week, while a
  line under the heading reads *Allocating … week 4 of 13*. The heading figures,
  pies and table stay empty until every week is done, since a figure drawn
  beside a loading state is empty while it loads. Finished weeks are kept per
  tag, week, step and rule for as long as the tab is open: switching back is
  instant, and a session edited in a week drops that week. `[assumed]` --> Agree
- **No cap.** Without a cap there is nothing to allocate, so the pills other than
  *As tracked* are disabled. A pointer label gives the reason, as *Allocate*
  does on Record. --> Agree
- **Labelling.** While allocated, the heading says so: *Allocated by the quarter
  hour — not what was tracked*. Record, the export and every other figure keep
  the recorded budget. `[assumed]`
- **Kept** in the `time` preferences section, which Patterns owns:
  `time.allocate: 'none' | 'minute' | 'quarter' | 'half' | 'hour'`.
  `[assumed: As tracked by default]`
- **Speed.** A week takes about 5–30ms, and a pathological 7-day week about
  200ms in minutes without the allowance. A 91-day window is 13–14 weeks, so
  well under a second in all. A year's window is 52 weeks and takes seconds;
  that is what the progressive line is for.

Tests:
- **Unit:** an allocated window's sums are the per-week allocations' sums, and a
  week cut by the window is allocated whole. The opening balance is the recorded
  one. Additions moved by the allocation are counted where they land.
- **Unit:** finished weeks are reused, and an edit drops only its own week.
- **e2e:** switching to *Quarter* moves the heading's change by the allocation's
  saving, and back to *As tracked* restores it. The line has fewer points while
  it allocates than when it's done. This is held deterministic by allocating
  behind a hook the test releases week by week.
- **e2e:** a rule without a cap shows the steps disabled, with the reason in a
  pointer label.

## Built already, outside this proposal

- **The breakpoint.** The allocation's rows lay out by the page's width
  (`@container`), not the window's. The sides pair up from a 38rem page, about a
  648px window, with the date above each card. The date takes its own column
  from 46rem. Half a 13–14" MacBook screen (about 720–750px) now draws side by
  side.
- **Half hours,** as a fourth step: *Minute · Quarter · Half · Hour*, two by two on
  a phone.
- **The allowance** in minutes and quarter hours: less than 15 minutes over the
  least deduction ties with it, and fewer moves decide. When that costs
  something, the page says *Least possible: 2h 32m, by moving more.* Half and
  whole hours have none. `[assumed: none for half hours either — you named
  minutes and quarters]`
