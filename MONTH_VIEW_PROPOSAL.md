# A month view on Record — proposal

Open questions are numbered at the end; each carries the default I would build
with, marked `[assumed: …]`. Answer inline, as before.

## What you asked for

- A month view of the time record: seven columns, four to six rows, one cell
  per day.
- Normally, each cell shows the hours clocked that day.
- In Budget mode, each cell shows the balance after that day.

## Where it lives

- **A *List · Month* toggle on Record**, pinned to the right end of the
  existing row (*By project · By tag · Budget · Merge sessions*). The pills say
  what a figure stands for; the toggle says how the days are drawn, so it is a
  separate group. It is pinned right so *Merge sessions* coming and going never
  moves it, which is the toolbar rule.
- **Opens on the current month.** Above the grid sits a stepper: ← *October
  2026* → and *This month*, which stays in place, invisible, while you are on
  this month.
- **Monday first.** A month takes four rows (February 2027), five, or six
  (August 2027). Days outside the month are blank. `[assumed: Q7]`
- `[assumed: Q5]` **Not remembered.** The pills are local state today, so
  Record opens on *List*. Remembering it in preferences is cheap if you want it.

## What a cell shows

Every cell has its date; today is ringed. Days after today show nothing except
a planned day off — a calendar is where the future belongs, unlike the list,
where today stays the top record.

- **By project**: the day's total, the same number the list's day heading
  prints (each project's covered time, summed across projects). That
  computation moves out of `Record.svelte` into `lib/time/` so the list and the
  grid read one function: two numbers on one screen, one source.
- **By tag**: a sum across tags means nothing, since tags overlap. So the grid
  takes the tag chips Budget mode already draws, and each cell shows that tag's
  time — reported time where the tag has a rule, as everywhere else.
  `[assumed: Q2]`
- **Budget**: the balance at the end of each day, from the same `budgetForTag`
  rows the list draws.
  - A workday nobody tracked has the alarm tint, as in the list.
  - Weekends, holidays and days off are muted; their balance only carries
    forward, so it is printed muted too. `[assumed: Q3]`
  - Today shows what is tracked so far, styled as open, and no balance: it
    counts once it is over.
  - A reset is marked on its day.
- **The heading above the grid**:
  - By project: *October 2026 · 143h 20m tracked*.
  - By tag: that tag's total for the month.
  - Budget: the month's change and the balance it closes on.

## Tapping a day

`[assumed: Q4]` A tapped cell draws that day's rows under the grid. They are
the rows the list draws, with the same *Edit*, *Delete* and *Mark day off*, so
the grid needs no actions of its own. Tapping the day again closes it, and the
add panel's day defaults to the selected one.

Hovering, or a tap on a phone, shows a pointer label with the full figure and,
in Budget mode, the holiday's name or the kind of day off. It is the same
`lib/pointer-label.svelte.js` the streak grid uses, pinned on touch.

## The phone, measured

Widths at 320px, measured in the running app's own CSS. `.numeral` is Inter,
which is not bundled, so a phone draws it in its own system font. That is why
the house's 15% headroom applies to figures as well as labels.

The column is 296px. Seven cells with hairline gaps leave about 41px each:
**37px for text** after padding, **32px with the headroom**.

| Spelling | 12px | 14px |
| --- | --- | --- |
| `7h 45m` | 43.3 | 49.6 |
| `10h 05m` | 50.9 | 58.3 |
| `7h` over `45m` | 14.8 / 26.1 | 17.0 / 30.0 |
| `7:45` | 26.6 | 30.5 |
| `10:05` | 34.3 | 39.2 |
| `+43h 10m` | 58.5 | 67.0 |
| `+43h` | 30.0 | 34.4 |
| `−143h` | 37.7 | 43.2 |
| `−143:10` | 49.5 | 56.7 |

- **The app's own spelling does not fit a phone cell at any size.** The clock
  form fits until a day reaches ten hours.
- **Split in two at the space, the app's own units fit**: every day total and
  every balance under 100h.
- **A three-digit balance fits nowhere at 12px.** `−143h` alone is 37.7px, and
  four digits are wider still. This is not an edge case: before today's seed,
  your own *Work deducted* budget read **−1516h**, a contract from January over
  sessions that start in August.

That is question 1.

## Data

No schema change and no API change. The grid reads the store:

- The month's sessions come through `ensureTimeEntries({ start, end })`, in a
  `resource()` keyed on the month; rules and budget records load as now. So it
  paints from the store, and stepping back into a month already seen paints at
  once.
- **The stepper.** `CalendarStepper.svelte` belongs to the todo calendar (day
  and week, with `weekLabel` from `lib/todos/`), so Time may not import it. The
  arrows, the label and *Today* move into a shared `lib/Stepper.svelte`; the
  todo calendar's stepper becomes a thin caller of it, and the month view is
  another. That is the move-it-to-shared rule rather than a second copy.

## Tests I intend to write first

Unit:

- `monthGrid(month)`:
  - starts each row on a Monday;
  - gives four rows for February 2027, six for August 2027, five for October
    2026, and handles February 2028 (a leap year);
  - leaves days outside the month empty.
- The shared day-total function reproduces the list's current numbers,
  overlapping sessions on one project counted once.

End to end:

- *Month* opens on the current month: seven columns, the right number of rows,
  today ringed.
- By project, a cell equals the list's total for the same day.
- By tag, a cell shows the tag's reported time, and picking another tag changes
  the cells.
- Budget:
  - each cell equals the list's balance for that day;
  - an untracked workday is tinted;
  - a holiday and a day off are muted;
  - today shows no balance;
  - a planned day off shows ahead.
- Stepping to last month and back paints at once, with the read held open.
- A tapped day shows its rows under the grid, and *Mark day off* works from
  there.
- At 320px there is no sideways scroll, and every figure fits its cell with 15%
  to spare, measured.

Each fix gets a mutation probe that a named test fails.

## Open questions

1. **Figures on a phone.** At 320px a cell has about 37px for text.
   `[assumed: (a)]`
   - (a) Two lines in the app's own units: `7h` over `45m`, and `+43h` over
     `10m`. Every day total fits with room to spare. A balance of 100h to 999h
     keeps only its hours, at 11px. Scaled from the 12px measurement that is
     34.6px, so it fits, but with 7% headroom rather than 15%: a phone with a
     wider system font could clip it. Four digits fit at no size, so such a
     cell draws its tint and no figure — never a clipped one, and never a new
     spelling like `−1.5k` — and the figure appears under the grid. From 640px
     up, one line.
   - (b) Whole hours in every phone cell (`8h`, `+43h`), with the exact figure
     in the pointer label and under the grid. This hits the same `−143h`
     problem, and it rounds.
   - (c) No figure in a phone cell, only the tint: tracked or not, and the
     balance's sign. The figure appears in the label and under the grid. It
     always fits, and the month reads as a pattern rather than as numbers.
2. **By tag in the month view**: tag chips, and each cell that tag's time.
   `[assumed]` The alternative is to hide *By tag* while *Month* is on.
3. **Budget cells on days that cannot move the balance** (weekends, holidays,
   days off): the carried balance, muted. `[assumed]` The alternative is to
   leave them blank, so a figure appears only where the balance moved: fewer
   numbers, and the weekends read as gaps.
4. **Tapping a day**: its rows under the grid. `[assumed]` The alternative is
   switching to *List* scrolled to that day.
5. **Remember *List* or *Month*** across visits? `[assumed: no, like the pills]`
6. **Week totals**: no eighth column. `[assumed]` A phone has no room for one,
   and the heading carries the month's total. The alternative is a week column
   from 640px up.
7. **Days outside the month**: blank. `[assumed]` The alternative is the
   neighbouring months' dates, dimmed, with no figures.
