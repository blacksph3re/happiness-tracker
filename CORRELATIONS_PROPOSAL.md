# Correlations: rank the pairs instead of asking for two — v2

Second issue, with your answers folded in. Everything under **Decided** is
settled and I will build it. Two things came *out* of your answers that need one
more round; they are at the bottom under **Still open**, and they are small.

---

## Decided

| | |
| --- | --- |
| **Coefficient** | Spearman (rank correlation) |
| **Enum variables** | Not ranked. They stay filters — see below, this turns out to be a feature |
| **Score vs its own component** | Excluded. Needs `component_ids` on `/api/stats/variables` |
| **Overlap floor** | Half the window. Below it, the pair is excluded |
| **Ordering** | By \|ρ\| descending, sign shown |
| **Opening a pair** | Row expands in place, chart underneath, click again to collapse |
| **The two selects** | Removed |
| **Strength wording** | None. The number alone |

### Enums as filters is better than enums as axes

Your point — *"you can always filter by enums and thus get them into the game in
a way that makes more sense (i.e. how the correlations change on workdays vs
weekends)"* — is the right shape and I had missed it.

It works by construction: the ranking is derived off `days`, which is already
the facet-filtered window. Narrow to weekends and every coefficient recomputes
over weekends. So an enum does not need to be an axis to be in the analysis — it
partitions the analysis, which is the more honest thing to do with a category.

This gets its own e2e test, because it is now a headline behaviour rather than a
side effect: **the same pair reports a different ρ under a filter than without
one.** That is not free — it depends on the ranking reading the *filtered* day
set rather than the raw window, which is exactly the mistake `weekdayInput` made
on the time page and had to be fixed for.

### Pairs are unordered, so the duplicate you were worried about cannot occur

> that might result in sleep/irritability being followed directly by
> irritability/sleep

It cannot: `rankPairs` walks `i < j`, so each unordered pair is produced once.
There is no direction to correlation — ρ(a,b) and ρ(b,a) are the same number —
so a row is a pair, not an arrow.

What *can* sit adjacent under \|ρ\| ordering is a +0.71 and a −0.71 belonging to
**different** pairs. That is intended: they are equally strong findings. The sign
is on the row, and switching to signed ordering later is a one-line change to the
comparator if it does annoy you.

---

## Still open — both fallouts of the overlap floor

### 1. Half the window is harsh on a new question, and I think you will hit it

The floor scales with the window, so it is not one number:

| Window | Floor | A question you started answering 8 weeks ago |
| --- | ---: | --- |
| Week | 4 days | ranks fine |
| Month | 15 days | ranks fine |
| Quarter | 45 days | ranks (56 days) |
| Year | 183 days | **never ranks, against anything** |

The failure mode is the bad one: a question you added recently is simply absent
from the list on a long window, with nothing on screen saying why. It reads as
the feature being broken rather than as the rule working.

Three ways out — a letter is enough:

| | |
| --- | --- |
| **A** | Floor is `min(half the window, 60 days)` — proportional where it is cheap, capped where it starts hiding real data |
| **B** *(recommended)* | Keep half the window, and show excluded pairs greyed with "answered on 56 of 183 days" instead of dropping them |
| **C** | Keep half the window exactly as answered, absences unexplained |

**B** is the one in keeping with the house rule about labelling a number rather
than quietly changing it, and it is what `SYSTEM_QUESTIONS_PROPOSAL.md` wants
`Question.created_at` for — with a creation date the row can say *"added 8 weeks
ago"* rather than *"answered on few days"*, which is a different and much less
alarming sentence.

`[assumed: B]`

--> Thank you for that elaboration, I agree that a fixed window is actually better than my proposal. Then let's go back to 10 days, excluded pair greyed out at the bottom of the list.

### 2. With the selects gone, an excluded pair is unreachable

You said yes to both "exclude below the floor" and "remove the two selects". The
consequence is that a sub-floor pair can no longer be looked at at all — where
today you can pick any two variables and see the cloud, however thin.

I flagged the selects as safe to remove *because* decision 3 kept sub-floor pairs
on the page; that reasoning does not survive "excluded". Not a blocker — one of
the two should give. **B** above is the cheapest fix: the pair stays on the page,
greyed, and clicking it still opens the scatter.

`[assumed: resolved by taking B in question 1]`

---

## Benchmark plan

You asked for numbers in the PR rather than a promise, which is right. What I
will measure and report:

- **Shape**: 365 days × 20 axis variables → 190 pairs, the realistic worst case
  for a full year with a large catalogue.
- **Where the cost is**: Spearman needs ranks, and ranks must be computed on
  each pair's *overlapping* days. Ranking every variable once up front and
  reusing it is faster, but gives a subtly different number whenever two
  variables have different coverage — so I am doing it exactly, per pair. That
  is 190 sorts of ≤365 elements plus 190 dot products: roughly 5×10⁵ operations.
  My expectation is single-digit milliseconds, well inside a frame.
- **Reported as**: a committed benchmark in `lib/series.test.js` that fails if
  the full ranking exceeds a budget, so it cannot silently regress — plus the
  measured wall time in the PR text.
- **If it does not hold**: the escape is not `async` for its own sake but
  memoising ranks per variable and reporting that the number is then an
  approximation where coverage differs. I will bring numbers before reaching for
  that.

---

## Implementation

Frontend, plus one additive field on an existing endpoint. No schema change, no
migration.

1. `correlate(xs, ys, days)` in `lib/series.js` — Spearman ρ over the days both
   variables answered, plus that count. `null` where either side is constant.
2. `rankPairs(variables, valuesFor, days, options)` — every unordered pair,
   scored, floored, sorted. Pure; takes a lookup function so it never touches
   component state.
3. `component_ids: list[int] = []` on the `Variable` schema, filled in
   `routers/stats.py`, which already loads `Question.components`.
4. `Stats.svelte`: selects out, ranked list in, row expands to the scatter it
   already knows how to draw.

## Tests

**`correlate`**

- perfect monotone-but-not-linear data scores 1.0 — **the test that distinguishes
  Spearman from Pearson**, and the one that fails if the implementation drifts
- perfect positive, perfect negative, no relationship
- ties, against a hand-computed value (1–5 answers are mostly ties)
- a constant series returns `null`, not `NaN`
- overlap counts only days *both* variables were answered on

**`rankPairs`**

- never pairs a variable with itself
- `(a, b)` and `(b, a)` appear once
- a pair below the floor is flagged rather than ranked
- a score is not paired with its own component
- ordered by \|ρ\|, so −0.9 outranks +0.4
- the budget benchmark above

**e2e**

- the first row names the pair that actually moves together
- clicking a row opens a scatter, and it is that row's pair
- coefficient and day count are on the row
- **a filter changes the coefficients** — the enum-as-partition behaviour
- a pair below the floor is not ranked above one with full coverage

Each gets the mutation treatment: break it, confirm a *named* test fails, put it
back. The Spearman test, the filter test and the floor are the three I expect to
catch something real.

## Not proposing

- **No stored coefficients** — derived on read like everything else here.
- **No p-values.** With 190 pairs it invites reading the top of the list as a
  result, and multiple-comparison correction is a conversation, not a feature.
- **No lag correlation** ("today's sleep against tomorrow's mood"), though the
  pairing code would barely change. Say if you want it in scope.
