# A tag rule that adds time — proposal

*Second draft. All six questions are answered and folded in — every one confirmed
the assumption, so the design is unchanged. What did change is the level of
detail: re-reading this against the code turned up **five things this document
left unclear or got wrong**, all mechanical rather than product decisions, and
all now settled below. ★ marks them.*

*The corrections, in one place: the endpoint rename is also a **body shape**
change; `deductions.js` does **not** disappear; the preview shows **nothing at
all** for a tag with an addition and no bands; the offline cache and
`summaryRows` both change shape; and `add_minutes` needed bounds.*

A tag's rule can currently only take time away. The requirement is the opposite
direction: **every day this tag tracked anything gets an hour added**, and the
deductions already in place apply *after* that.

## What you asked for, as arithmetic

Your example, worked through the machinery that exists:

| | |
| --- | --- |
| Tracked | `3:00` |
| Addition | `+1:00` → `4:00` |
| Band `from 3:30, deduct 20` | `4:00` reaches `3:30`, so it applies → `3:40` |
| **Reports** | **`3:40`** |

The load-bearing detail is in the third row: the band's threshold is tested
against the **increased** total, not the tracked one. A day of `3:00` does not
reach a `3:30` threshold; a day of `3:00 + 1:00` does. Same rule, opposite
answers — so "deductions apply after the increase" has to mean *after* in both
senses, the subtraction and the test that decides whether to subtract.

## Where it goes

**One nullable column on the tag**, not a new kind of band:

| | |
| --- | --- |
| `tags.add_minutes` | Minutes added to any day this tag tracked anything. NULL means no addition |

★ **Minutes**, as you asked — the same unit the bands use, so the whole rule is
expressed one way and the editor has one kind of field. Bounded `0 ≤ n ≤ 1440`,
matching `DeductionBandIn`'s own `Field(ge=0, le=24 * 60)`; negative is what the
bands are for.

★ **`0` is normalised to NULL on write.** Otherwise the same rule has two
spellings, and a tag would round-trip as `0` or `null` depending on how it was
last saved — which the change digest would then report as an edit.

Three reasons it belongs on the tag rather than in `deduction_bands`:

- **The bands genuinely are deductions.** Every one of them subtracts; a
  `CheckConstraint` says so
  ([`models.py`](backend/models.py), `ck_band_deduction_positive`). Expressing an
  addition as a negative deduction would need that constraint relaxed, and would
  make the column's name a lie.
- **Bands replace each other; this does not.** The highest threshold a day
  reaches is the only one that applies
  ([`timetrack.py:261`](backend/services/timetrack.py#L261)). An addition that
  competed in that contest could be cancelled by a deduction band sorting above
  it, which is not what "add an hour to every day" means.
- **Ordering has to be expressible.** Add-then-deduct is a sequence of two
  different things. Two entries in one list have no order but their thresholds.

**Nullable, with no server default**, so the migration is an in-place
`ADD COLUMN` rather than a rebuild of `tags` — the rule now recorded under
[Which changes rebuild the table](CLAUDE.md). NULL and `0` mean the same thing to
the reader, which costs nothing and keeps the migration to its safest shape.

## The rule, restated

`reported = clamp(tracked + addition) − deduction(tracked + addition)`

with two conditions carried over from the existing rule, both of which already
have a reason on record:

- **A day that tracked nothing gets nothing.** `deduction_for` returns zero for
  an untracked day — *"a day off owes no lunch break"* — and the mirror image
  holds: a day off earns no bonus. Without this, every untracked day in a range
  would sprout an hour, and the weekday averages would be measuring the rule
  rather than the work.
- **The result never goes below zero**, and the deduction is still capped at the
  total it is taken from — now the increased total rather than the tracked one.

A **cap** band interacts the obvious way and is worth stating because it is the
one case where the addition can vanish: a ten-hour cap against `9:30` tracked
plus an hour reports `10:00`, not `10:30`. The cap is a statement about the day
as reported, and the addition is part of what is being reported.

A project carrying **two tags** counts fully toward both, as it already does, so
each tag adds its own hour to its own total. By-tag numbers were never a
partition and this does not make them one.

## The three implementations

This is the part worth knowing before agreeing to anything, because the rule does
not live in one place:

| | |
| --- | --- |
| [`services/timetrack.py`](backend/services/timetrack.py) | `deduction_for` / `reported`, in **seconds**. The authority |
| [`lib/time/summary.js`](app/src/lib/time/summary.js) | `deductionFor` / `reportedFor`, in **seconds**. The offline mirror, so a device with no connection still reports honestly |
| [`lib/time/deductions.js`](app/src/lib/time/deductions.js) | `deductionFor`, in **minutes**. The rule editor's preview, because a rule being edited has not been saved and cannot be asked about |

`scripts/dump_derivations.py` dumps a corpus of server-computed answers to
`derivations.json`, and `conformance.test.js` holds the *offline mirror* to it.

**The preview is not covered.** `conformance.test.js` imports only from
`summary.js`, so `deductions.js` is a third implementation that nothing checks
against the server. It has been correct so far; adding a rule to it is adding a
rule to the one copy that would not tell us if it drifted.

### The cut worth making first

The two client copies are the same algorithm in different units. The preview can
call the seconds version with `minutes * 60`, which removes an implementation
instead of adding a third case to it — and brings the preview under the
conformance corpus for free.

★ **`deductions.js` does not disappear**, which the first draft implied. It
exports two things, and only one is a duplicate: `deductionFor` goes, and
`previewPoints` stays, because choosing which day lengths to illustrate has no
server counterpart to conform to. The file shrinks to that one function.

I would do that **before** the feature, as its own change, so that the diff which
adds the addition is a change to two implementations rather than three, and so
that the preview is provably in step before anyone relies on it to read a number
they are about to save — confirmed as step 1, [#5](#settled-this-round).

## What the API says

`/api/time/summary` returns a row per day per group. Today it carries `seconds`,
`deduction` and `reported`. A reader can currently explain the number: reported
is tracked minus deduction. With an addition in play they no longer can — the
same three fields would leave an unexplained hour.

So the row gains `added`, and the four fields are self-explaining:

```
reported = seconds + added − deduction
```

That is the *"where a number needs explaining, label it"* rule, and it is also
what keeps the Patterns group table honest: it already shows tracked beside
reported, and the gap between them is about to have two causes.

★ **The rename is also a change of shape**, which this document previously left
implicit. `PUT /tags/{id}/deductions` takes a **bare list** of bands today
([`time.py:366`](backend/routers/time.py#L366)). One endpoint carrying the whole
rule cannot, because it has to carry the addition beside them:

```jsonc
// PUT /api/tags/{id}/rule        — GET returns the same shape
{
  "add_minutes": 60,              // null for none
  "bands": [{ "from_minutes": 210, "deduct_minutes": 20 }]
}
```

`listDeductions` / `setDeductions` become `getTagRule` / `setTagRule` in the
generated client. Nothing outside this app consumes the API, so the break costs a
regeneration and the call sites in `Projects.svelte` and `store.js`.

## What the user sees

The editor on the Projects page already calls the whole thing a **rule** — *"No
rule: this tag reports exactly what it tracked"*, *"Saved the rule for X"* — so
the umbrella noun does not need inventing. What changes inside it:

- One field above the bands: **Add to every tracked day (minutes)**.
- The preview table grows a column, and its header stops being a subtraction:

  | A day of | Gains | Loses | Reports |
  | --- | --- | --- | --- |
  | 3:00 | +1:00 | −0:20 | 3:40 |

- ★ **`previewPoints` has a hole the addition opens up.** It derives its rows
  from the band thresholds and returns **nothing at all** when there are none
  ([`deductions.js:47`](app/src/lib/time/deductions.js#L47)) — which is right
  today, because a tag with no bands has no rule to preview. A tag with an
  addition and no bands has a rule and would show an empty table. It needs the
  addition as an argument, and two changes with it:

  | | |
  | --- | --- |
  | Rows come from `threshold − addition` | The day that *demonstrates* the rule is the one just below a threshold it now reaches — your example exactly, and what a preview built on raw thresholds would miss |
  | An untracked day is always shown when there is an addition | `0:00 → gains nothing → reports nothing` is the surprising row, and the one place the "a day off earns no bonus" rule is visible |

  With an addition and no bands there are no thresholds to derive from and
  nothing to miss, so plain day lengths are fine there.

Nothing else moves on screen: the record, the charts and the CSV all read
`reported`, which is still one number meaning the same thing.

### What moves underneath

The offline path computes `reported` for itself, so it needs the addition too,
and two shapes change to carry it:

| | |
| --- | --- |
| `deductionRules` in `store.js` | `{tagId: [bands]}` becomes `{tagId: {add_minutes, bands}}` — it is a rule per tag now, not a band list per tag, and the store name should follow |
| `summaryRows` / `exportTables` | `bandsOf` becomes `rulesOf`, same call sites ([`summary.js:115`](app/src/lib/time/summary.js#L115), [`:165`](app/src/lib/time/summary.js#L165)) |

The conformance corpus follows: entries under `corpus.deductions` gain
`add_minutes` and `added`, and the key is worth renaming to `rules` while it is
being regenerated — it stopped being only about deductions.

## Tests

Failing-first, and each broken again to watch it fail.

**Backend** (`tests/test_timetrack.py`), the rules at the unit level:

| | |
| --- | --- |
| Addition, no bands | `3:00` + 60 reports `4:00` |
| **Your example** | `3:00` tracked, `+60`, band `from 3:30 deduct 20` → `3:40`. Named for the case, because it is the one that proves the threshold sees the increased total |
| The same day without the addition | reports `3:00` — the band is not reached, which is what makes the test above mean something |
| A day that tracked nothing | reports `0`, not the addition |
| Addition against a cap | `9:30` + 60 under a ten-hour cap reports `10:00` |
| Deduction larger than the total | never below zero, measured against the increased total |
| A tag with no addition | byte-for-byte what it reports today |
| `add_minutes: 0` | stored as NULL, and reads back as NULL rather than 0 |

**Frontend** (`deductions.test.js`), for the preview, which the corpus cannot
cover because choosing rows is not a server behaviour:

| | |
| --- | --- |
| An addition with no bands | produces rows, where today it produces none |
| An addition with bands | includes the day just below `threshold − addition`, the row that shows the rule changing hands |
| Any addition | includes the untracked day, which earns nothing |

**Conformance**: the corpus gains addition cases, and the preview comes under
it once step 1 has removed its private copy of the rule.

**API**: the addition round-trips, rejects negatives, and appears in
`/api/time/summary` as `added` with `reported` equal to `seconds + added −
deduction` on every row.

**End to end**: set an hour on a tag, and the day that read `3:00` on the record
reads `3:40` with the existing band in place — through the UI, not the API, since
the point is that every screen reading `reported` picks it up without knowing why.

## Sequence

| Step | | Shippable? |
| --- | --- | --- |
| 1 | Drop `deductionFor` from `deductions.js` for the seconds version; bring the preview under the corpus. `previewPoints` stays | Yes — no behaviour change, one fewer implementation |
| 2 | `tags.add_minutes` + migration (in-place add) | Yes — dead column, nothing reads it |
| 3 | The rule in `timetrack.py` and its mirror; corpus regenerated | Yes — no tag has an addition yet, so every number is unchanged |
| 4 | `added` on the summary row; `/tags/{id}/rule` replacing `/deductions`, client regenerated; the store and `summaryRows` renamed to carry a rule rather than bands | Yes |
| 5 | The editor field and the preview column | Yes — this is the feature |

Step 3 is safe to ship on its own precisely because the column is empty: an
addition of NULL is an addition of nothing, and the whole change is inert until
somebody types a number into step 5.

## Settled this round

Every question came back confirming the assumption, so the design above is the
design proposed. Recorded with what each decided:

| | |
| --- | --- |
| **1. Shape** | One fixed amount per tag, **in minutes**, matching the bands so the rule has one unit |
| **2. Minimum** | None. One tracked minute earns the whole addition |
| **3. Endpoint** | One endpoint, renamed `/tags/{id}/rule`, carrying the addition and the bands together — which makes it a body-shape change, not only a rename |
| **4. CSV** | `reported` alone. The file people may have spreadsheets pointed at does not change |
| **5. The mirrors** | Collapse first, as step 1: *"keeping the logic in one place makes it less prone to fail"* |
| **6. Naming** | "Add to every tracked day", and **Gains** beside **Loses** in the preview |

Nothing is open. The five items marked ★ above were unclear in the first draft
and are decided rather than asked, because each is a mechanical consequence of
answers already given.

## Answered in the first round

1. **A fixed amount, or graduated like the bands?** You asked for "one hour on
   every day", which is one number. Bands with thresholds would allow "an hour on
   short days, nothing on long ones" — more machinery than the requirement, and
   harder to explain beside the deduction bands it would sit next to.
   **[assumed: one fixed amount per tag]** -- correct, maybe count it in minutes conformant to the current bands logic.

2. **Does a day have to reach some minimum to earn it?** As proposed, one tracked
   minute earns the full hour. That is the literal reading of "every day that was
   tracked", and it is also the shape most likely to surprise: a day you checked
   into for two minutes by accident reports `1:02`.
   **[assumed: any tracked time at all earns it, no minimum]**. -- no minimum

3. **Does the addition ride on the tag endpoints or the rule endpoint?** It is a
   column on `tags`, so `PUT /api/tags/{id}` is the natural home — but then
   saving "the rule" is two requests that can half-fail, and the editor saves
   both at once. Folding it into `GET/PUT /tags/{id}/deductions` keeps one rule
   in one round trip at the cost of an endpoint whose name no longer covers what
   it carries.
   **[assumed: the rule endpoint, renamed to `/tags/{id}/rule`]** -- rename + one endpoint

4. **Should `added` appear in the CSV export?** The export writes one `reported`
   number per day per tag. Adding columns changes a file you may have
   spreadsheets pointed at.
   **[assumed: no — the export keeps reporting `reported` alone]** -- reported alone.

5. **Collapse the two client mirrors first?** Recommended above, and the only
   item here that is about the code rather than the product. It is a small change
   that removes an implementation and closes a conformance gap; the alternative
   is three copies of a rule that just got more interesting.
   **[assumed: yes, as step 1]** -- Yes, that sounds like a sensible refacor. Keeping the logic in one place makes it less prone to fail.

6. **What is this called in the editor?** "Add to every tracked day" is what it
   does; naming is yours. The preview column reads "Gains" above, against
   "Loses", which is the pairing I would choose — but it is a product-naming
   decision and this document is the place to disagree with it.
   **[assumed: "Add to every tracked day", column "Gains"]** - yes
