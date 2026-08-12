# Computed scores — proposal

WHO-5 defines a raw sum over its five items, and a percentage score of four times
that. Other instruments will want a mean, a weighted sum, or a total over some of
their questions and not others. This proposes how to add that with the least new
machinery.

## The shape of the answer

**A score is a question the server owns and the user never answers.**

That sentence is the whole design, and the reason it costs so little: the codebase
already has such a thing. The five auto-tracked variables — weekday, month, year,
day-of-year, hour — are `Question` rows carrying a `system_key`, replicated into
every catalogue, written by the server, and skipped by the questionnaire. Everything
downstream already copes with them: they appear in the record table, in the `.xlsx`
export, and in `/api/stats/variables` with their own roles.

A score fits that same slot. Model it as a question and it inherits all of it, with
no change to the record table, the export, the store, or the stats page.

The one difference is that a score is **computed when read, never stored**.

## Why not stored

Storing a score as answer rows — the way the auto-tracked values are stored — is the
obvious symmetry, and it is the wrong one:

- Correcting one answer would have to rewrite the score for that day, and changing a
  definition would have to rewrite every score for every user, for all history.
- It would make the README's promise false. "All changes to the question catalogue
  will never modify previous answers" holds today because an answer is a record of
  what someone said. A score is a *view* of those records, and a view that changes
  when its definition changes is correct, not a violation — but only while it is not
  masquerading as a recorded answer.
- It doubles storage for something derivable in one pass.

Computing on read makes a definition change retroactive by construction, which is
what you want from a formula, and keeps "answers are never rewritten" literally true.

The cost is a pass over the day-grouped answers on each read. Against the measured
baseline — 297 ms and 1.21 MB for five years of answers, 65 KB gzipped — one extra
aggregation per day is not the thing that will hurt.

## Why not stored and recomputed on edit

Recomputing on edit is entirely feasible, and it is worth being precise about what it
would cost rather than waving it away:

- **The write path grows.** Every answer submitted would also have to update that
  day's score rows. Today a write is one upsert plus, on a day's first answer, the
  auto-tracked rows. Answering is the hot path and the one place the app promises not
  to make the user wait.
- **A definition edit becomes a job, not a request.** It touches every user and every
  day that score has ever covered. That is a background task, with progress, failure
  handling, and a window during which the stored values disagree with the definition.
- **Drift becomes possible, and undetectable.** A stored score and its definition are
  two sources of truth. A missed hook, a crash halfway through a recompute, a weight
  changed while a recompute was already running — any of these leave numbers that are
  simply wrong, with nothing to notice it. Computed on read, that class of bug cannot
  exist.
- **It puts derived values in the table the app promises never to rewrite.**

Against that, the saving is one aggregation per day at read time. The measured
baseline is 297 ms for five years of answers, and a score adds a pass over data
already in memory and grouped by day.

So: read-time, unless one of two things changes. If the answer history ever gets large
enough that reads hurt, or if a score needs to be *queried* server-side — filtered,
sorted or paginated in SQL, which plotting does not require — then storing it earns
its keep, and a recompute job is the price. Neither is true today.

## Why not a formula language

The tempting version is a string: `"q1 + q2 + q3"`, or something with a parser
behind it. It should be resisted:

- It needs a grammar, a validator, error reporting, and a sandbox.
- It references questions by name or index, so renaming or deactivating a question
  breaks the formula silently, at read time, for everyone.
- It cannot be checked when saved, only when evaluated.

Everything asked for — sum, mean, weighted sum, exclusion — is one primitive:

**a weighted aggregate over chosen questions, either summed or averaged.**

| Wanted | `aggregate` | `components` |
| --- | --- | --- |
| A total | `sum` | the questions that count, weight 1 |
| An average | `mean` | the questions that count, weight 1 |
| Weighted sum | `sum` | the questions, each with its weight |
| Weighted average | `mean` | the questions, each with its weight |
| Subset only | either | list only the questions that count |

`sum` is `Σ(value × weight)`; `mean` is that divided by `Σweight`. Two aggregates and
a weight per component, and nothing else.

There is deliberately **no scaling factor**. An earlier draft had one, purely so that
WHO-5's "raw × 4 = percentage" could be expressed — which is exactly the kind of field
that exists to serve one instrument and then has to be explained forever. WHO-5 is an
example catalogue, not a feature. Anyone who wants a percentage can define a `mean`
and read it as "out of 5", or the factor can be added later if a second instrument
actually needs one.

No parser, no expression, and the components are foreign keys — so a question cannot
be renamed out from under a score, and the database can refuse to leave a definition
pointing at nothing.

## Data model

Two additions.

**`questions.origin`** — an explicit enum replacing the current "is `system_key` set?"
test: `asked`, `auto`, `computed`. Fifteen places in the backend and four in the
frontend currently branch on `system_key`; they become a check against `origin`, and
the third kind costs nothing at each of them. This is the one refactor worth doing
first — adding `computed` alongside `system_key` would leave two parallel notions of
"the user does not answer this", which is exactly the debt to avoid.

`system_key` stays, as what it actually is: which auto-tracked variable this is.

**`score_components`** — one row per question that feeds a score.

| Column | |
| --- | --- |
| `score_question_id` | the computed question |
| `source_question_id` | a question that contributes |
| `weight` | float, default 1.0 |

Plus, on the computed question itself: `aggregate` (`sum` or `mean`) and `require_all`
(bool, default true — a total over three of five answers is not that total; without
this the score silently understates on partial days).

**Components are scaled questions only** — discrete and continuous. An enum has no
numeric value to contribute: its options are a set, and treating their positions as
numbers would let a score average things that have no order. That is the same reason
the stats page already refuses an enum as a plot axis and offers it as a filter
instead, so the rule is one the app already keeps elsewhere.

Enforced where the other question rules live, in `services`, alongside
`check_question_shape` — a domain rule that raises, translated to a 422 by the router.
Not a database constraint: the components table cannot see the kind of the question it
points at without a trigger, and this is a rule about meaning rather than integrity.

If a later instrument genuinely needs a scored yes/no, the way in is to let that
question be `discrete` with bounds 0-1 and labels, which the model already supports —
not to make enums arithmetic.

Bounds come out of the components rather than being configured: minimum
`Σ(min × weight)`, maximum `Σ(max × weight)`, divided by `Σweight` for a mean. That
gives the stats axis a truthful scale and removes a field that could contradict the
thing it describes.

## Where it is computed

One function, in `services`, alongside the existing system-answer logic:

```python
def score_for_day(score, answers_by_question) -> float | None
```

Called from exactly two places, both of which already assemble a day's answers:

- `GET /api/answers` — appends computed rows, so the store, the record table and the
  stats page all receive them as ordinary answers.
- `GET /api/answers/export.xlsx` — the same rows, so the spreadsheet agrees with the
  screen.

`/api/stats/variables` reports computed questions with `["axis", "radar"]`, which is
what a numeric variable already gets. Nothing else changes.

Computing in the frontend instead would mean writing the formula twice — once in
JavaScript for the charts, once in Python for the export — and they would drift.

## What has to change in the frontend

Almost nothing, which is the point.

- The questionnaire filters on `origin === 'asked'` instead of `!system_key` — one
  predicate, in the place that already excludes the auto-tracked questions.
- The record table and stats already treat "not an asked question" as muted styling;
  same predicate.
- The catalogue editor gains a way to define a score: pick the questions that count,
  set weights, choose sum or mean. This is the only genuinely new UI. It offers only
  scaled questions as components, so the rule shows up as an absence rather than as an
  error after the fact.

## Sequence

| Step | |
| --- | --- |
| 1 | `questions.origin`, migrated from `system_key`; replace the fifteen backend and four frontend checks |
| 2 | `score_components` table, the score fields, and `score_for_day` with unit tests |
| 3 | Inject computed rows into `/api/answers` and the export; expose in `/api/stats/variables` |
| 4 | Seed a `sum` score for the bootstrapped catalogue — as catalogue *data*, exactly as its five questions already are. No code anywhere knows what WHO-5 is |
| 5 | Editor UI for defining a score |

Steps 1–4 make the bootstrapped catalogue's total work end to end without any new UI;
step 5 is what makes it configurable for the next questionnaire.

## Resolved

| | | |
| --- | --- | --- |
| Partial days | No score at all for a day missing an item | `require_all` defaults true |
| Enum components | Out of scope | Scaled questions only; a scored yes/no is a `discrete` 0-1 question, not an enum |
| Across catalogues | Within one catalogue | Components are all in the score's own catalogue |
| Aggregates | `sum` and `mean`, weights per component | No scaling factor; nothing knows what WHO-5 is |
| Filterable | Plottable only | No range facets needed |
| Editing a definition | Retroactive, by construction | Computed on read, so there is nothing to recompute — see above for what storing would have cost |

## Still open

1. **Where a score sits in the question order.** The auto-tracked variables sort after
   everything with `position = 1000 + n`. A score is derived from the questions above
   it, so after them reads naturally — but before or after the auto-tracked block?
   [assumed: between them, so the record table reads questions, scores, then weekday
   and friends] - between them
2. **Whether a score may feed another score.** Cheap to allow, and a cycle is cheap to
   reject, but it is a whole extra thing to explain and nothing needs it yet.
   [assumed: no, components are asked questions only] - not needed
3. **Deactivated components.** A score whose component is later deactivated keeps
   working for historical days, which is right. Should it keep appearing for *new*
   days, scoring the components that remain — or should deactivating a component be
   refused while a score depends on it? [assumed: keep working, since `require_all`
   already means a day without that answer scores nothing] - yes, dependent on require_all
