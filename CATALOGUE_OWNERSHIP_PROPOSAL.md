# Catalogues become per-user — proposal

*Built. All five questions are answered and folded in, and the change is
implemented, migrated and tested. This document is now the record of why it looks
the way it does. ★ marks where the build departed from the plan.*

*Your answers, and what each decided:*

| | |
| --- | --- |
| **1. Which catalogues are cloned** | All of them, for every user — one rule instead of two |
| **2. `is_editor`** | Dropped, column and all |
| **3. Deleting your last catalogue** | ★ Allowed. "He might want to start on a blank page" — so the questionnaire gained a real empty state offering to build one |
| **4. Building from a template later** | Offered on the Questions page, not only at account creation |
| **5. The admin's lost capability** | Intended. Nobody edits anybody else's questions, the admin included |

*★ Two departures, both from measuring rather than assuming. The constraint swap
had to move **before** the cloning, not after — the first clone carries its
original's name and the old global unique refuses it. And the ownership sweep
turned out to be twelve endpoints, not eleven: `/api/me/default-catalogue` let an
account point itself at somebody else's questions.*

## The part that is not about ownership

The schema change is small. **The authorization work is the change**, and it is
easy to miss, because none of it is a bug today.

Catalogues being global is currently load-bearing: no endpoint that takes a
catalogue or a question id checks who owns it, because there was nothing to
check. Three examples, all correct as written and all holes the moment a
catalogue has an owner:

| | |
| --- | --- |
| `GET /api/catalogues/{id}` | `read_catalogue` resolves through `_get_catalogue(db, catalogue_id)` ([`catalogues.py:191`](backend/routers/catalogues.py#L191)) and never looks at `user`. It would serve another account's questions |
| `answer.put` | `apply_answer` does `db.get(Question, payload.question_id)` ([`services/sync.py:101`](backend/services/sync.py#L101)) and validates the *shape* of the answer, never the ownership of the question. It would let one account write an answer against another's question |
| Every write under `/questions/{id}` and `/scores/{id}` | Gated on `is_editor` alone. Remove that gate without adding an ownership check and every signed-in account can rename anybody's questions |

So the sweep is **twelve** endpoints, and it is the part worth reviewing hardest:

```
GET    /catalogues/{id}              PUT    /questions/{id}
PUT    /catalogues/{id}              POST   /questions/{id}/options
DELETE /catalogues/{id}              DELETE /questions/{id}/options/{option_id}
POST   /catalogues/{id}/questions    POST   /catalogues/{id}/scores
PUT    /scores/{id}                  DELETE /scores/{id}
       sync: answer.put              ★ PUT /me/default-catalogue
```

★ The last one was missed when this was drafted and found while implementing. It
is self-service rather than administration, which is exactly why it did not look
like part of the sweep — and it would have let an account point its own
questionnaire at another person's questions.

Most of it lands in three resolvers rather than twelve handlers: `_get_catalogue`,
`_get_question` and `_get_score` each take the owner and filter on it, so the
endpoints inherit the check by construction instead of each remembering it.

`GET /catalogues` already scopes correctly by accident — it lists everything, and
after this it lists everything *you own*, which is the same query with a `where`.

## Data model

One column and one constraint swap.

**`catalogues`**

| | |
| --- | --- |
| `user_id` | FK users, **cascade** — a deleted account takes its questions with it, as it already takes its answers |
| `name` | unique **per user**, not globally |

`UniqueConstraint("user_id", "name")` is exactly what `Project` already does
([`models.py:513`](backend/models.py#L513)), so this is the established shape
rather than a new idea.

Nothing else moves. `questions.catalogue_id` already reaches the owner in one
hop, and `answers.user_id` is unchanged — an answer's owner and its question's
owner will simply always agree, which is the invariant the sweep above enforces.

**`users.is_editor` goes.** It exists only to gate catalogue editing, and after
this there is nothing global left to gate. See [Still open #2](#still-open) about
whether the column is dropped or merely stops being consulted.

## Templates, which replace the permission

A new account still has to open on something, and "currently only offer WHO-5"
is the requirement. The question is where a template lives.

**In code, not in the database.** `bootstrap.py` already defines WHO-5 as
constants — `STARTER_QUESTIONS`, `STARTER_BOUNDS`, `STARTER_SCORE`
([`bootstrap.py:12`](backend/bootstrap.py#L12)) — and that is the right home. A
template as a database row would be a catalogue with no owner, which is the exact
thing this proposal is removing, and it would need an editor permission to
maintain, which is the exact thing it is dropping.

So: a new `backend/templates.py` holding a registry, with the WHO-5 constants
moved into it rather than copied.

```python
CATALOGUE_TEMPLATES = {
    "who-5": Template(
        name="WHO-5",
        description="The five-item WHO-5 Well-Being Index, with a raw score over them.",
        questions=(...),      # today's STARTER_QUESTIONS and STARTER_BOUNDS
        score=STARTER_SCORE,  # today's seeded total
    ),
}
```

| | |
| --- | --- |
| `GET /api/catalogue-templates` | `[{key, name, description}]`, so the People form can offer them. Authenticated; no permission |
| `POST /api/users` | takes `template: str` in place of `default_catalogue_id`, builds that account its own catalogue, and sets it as the default |
| `bootstrap()` | builds the admin's catalogue from the same registry, so there is one definition of WHO-5 in the codebase rather than two |

`create_catalogue` ([`services/wellbeing.py:65`](backend/services/wellbeing.py#L65))
already attaches the five auto-tracked questions to every catalogue it makes, and
keeps doing exactly that — it gains a `user_id` argument and nothing else.

## The migration

Sized against the real database rather than guessed. Read from the most recent
nightly dump:

| | |
| --- | --- |
| users | 1 |
| catalogues | 1 |
| questions | 12 |
| answers | 22, all against that one catalogue |
| accounts holding `is_editor` | 1 |

So in this deployment the data step clones one catalogue and repoints
twenty-two answers. That is small enough to verify by reading it afterwards,
which is worth doing whatever the tests say.

### What it has to do

Cloning is the easy half. **Repointing is the half that can silently lose
history**, because an answer names a question by id and every id changes:

1. Add `catalogues.user_id`, nullable.
2. For each user, for each catalogue they need
   ([#1](#still-open) decides which): clone the catalogue, its questions, each
   question's options, and the score components between them — building an
   id map at every level.
3. Repoint that user's `answers.question_id` **and** `answers.option_id` through
   the map. Both, or an enum answer keeps pointing at the original option and
   the row fails its own `ck_answer_one_value` reasoning.
4. Repoint `users.default_catalogue_id` to the clone.
5. Delete the original catalogues, which nothing references any more.
6. Make `user_id` NOT NULL; drop the global unique on `name`; add the per-user one.

Auto-tracked questions are cloned like any other — they are per-catalogue rows
([`services/wellbeing.py:87`](backend/services/wellbeing.py#L87)), and a user's
weekday and month answers are among the twenty-two.

### Step 6 is the dangerous one

Steps 1–5 are safe: a nullable column with no default is added **in place**, and
the rest is `UPDATE` and `DELETE`. Step 6 is not. Changing nullability and
swapping a unique constraint cannot be done in place, so Alembic rebuilds the
table — copy, **`DROP`**, rename — and `catalogues` is a table two foreign keys
point at (`questions.catalogue_id`, `users.default_catalogue_id`).

This is the same hazard `CLAUDE.md` records, and the last migration taught the
precise rule, which is worth restating because it is *not* "adding columns is
safe":

> A **nullable column with no server default** is added in place. Anything else —
> `NOT NULL`, a non-constant default, a changed constraint — sends the batch
> context down the rebuild path.

Measured, not assumed: SQLite leaves a table's `sqlite_master.rootpage` alone for
an in-place add and moves it for a rebuild, which is a one-line check either side
of the migration and settles the question. The last migration was rewritten on
the strength of it.

`env.py` disabling foreign keys is what stops that `DROP` cascading, and
`tests/test_migrations.py` walks the chain. Both already exist; neither is a
reason to be casual about a rebuild of a referenced table.

### One revision or three

`alembic` reports *"Will assume non-transactional DDL"* on SQLite, so splitting
this into three revisions does not buy atomicity — a failure between them leaves
a half-migrated database either way. What splitting buys is reviewability, and
what one revision buys is a single entry in the chain to reason about.

**[assumed: one revision, three clearly separated phases]**, with the data step
written by hand. Autogenerate cannot express any of steps 2 through 5, and it
does not see data.

## What the user sees

- **Questions** appears in the wellbeing nav for everyone. Today it is behind
  `$me?.is_editor` ([`App.svelte:93`](app/src/App.svelte#L93)); that condition goes.
- **People** loses "Grant questions" / "Revoke questions" and the `is_editor`
  checkbox on the create form, and gains a **starter questions** select listing
  the templates. One option today, and it should still be a select rather than
  a hidden default — it is the one decision made when an account is created that
  cannot be undone without deleting answers.
- **Settings** still offers "Default catalogue"; the list is now your own.
- Nothing else changes, and for the single existing account nothing changes at
  all: same questions, same ids as far as any screen can tell, same history.

## Tests

Failing-first, and each broken again to watch it fail.

**Backend** — the sweep is the point, so it is tested as a sweep:

| | |
| --- | --- |
| Every endpoint in the table above, against another user's id | **404**, the way projects and entries already answer |
| `answer.put` naming another user's question | refused as a conflict, not stored |
| Two users may hold catalogues of the same name | the old global unique would have refused the second |
| Creating a user from `who-5` | gets their own catalogue, its questions, and it as their default |
| Creating a user from a template that does not exist | 422, and no user created |
| A template listing | is readable by any signed-in account and needs no permission |
| Deleting a user | takes their catalogue and questions with it |
| `is_editor` gone | the flag no longer appears in `UserOut`, and setting it is refused |

**The migration**, in `test_migrations.py`'s own style — seed at the revision
before, walk forward, assert nothing was lost:

- Two users answering the *same* global catalogue end up with **two independent
  catalogues**, each holding every answer that user had, none holding the other's.
- An enum answer still resolves to an option with the same *label* afterwards —
  the assertion that catches a repointed `question_id` with a stale `option_id`.
- A user's `default_catalogue_id` points at a catalogue they own.
- No original catalogue survives.
- Row counts for `answers` are unchanged. This is the one that matters.

**End to end**: a second account created from the template sees its own
questions, answers one, and the first account's record is untouched.

## Sequence

| Step | | Shippable? |
| --- | --- | --- |
| 1 | `templates.py`; `bootstrap` builds from it; `GET /api/catalogue-templates` | Yes — no behaviour change, one definition of WHO-5 instead of two |
| 2 | The ownership sweep: `user_id` on the model, a scoped `_get_catalogue`, and the eleven checks — **still gated on `is_editor`** | Yes, and deliberately inert: the checks are correct before anything relies on them |
| 3 | The migration | Yes — this is the cutover |
| 4 | Drop the gate: `EditorUser` goes, the nav opens, `POST /users` takes a template | Yes — the feature |
| 5 | Remove `is_editor` from schemas, UI and (per [#2](#still-open)) the database | Yes |

Step 2 before step 3 is the ordering that matters. Adding ownership checks while
catalogues are still global is a no-op that cannot break anything, and it means
the migration lands on a server that is already refusing cross-account access
rather than one that starts refusing it in the same breath.

## Resolved

| | |
| --- | --- |
| Ownership | A catalogue belongs to one user, cascade on delete. Sharing is a later feature, as it is for projects and tags |
| The permission | `is_editor` goes. It existed only because questions were global |
| Templates | Defined in code, not rows. A row with no owner is the thing being removed |
| Name uniqueness | Per user, matching `Project` |
| Auto-tracked questions | Cloned per catalogue, as they already are |
| Answers | Repointed, never rewritten in meaning and never deleted |

## What shipped

| | |
| --- | --- |
| `backend/templates.py` | The starter sets, in code. One definition of WHO-5 where `bootstrap.py` had a second |
| `GET /api/catalogue-templates` | What the People form and the Questions page offer |
| `catalogues.user_id` | FK users, cascade, unique on `(user_id, name)` like `Project` |
| The sweep | Twelve endpoints, via three owner-scoped resolvers |
| `3f1a7c4e9b20` | One revision, four phases, with a guard that refuses to delete anything still referenced |
| `is_editor` | Gone from the model, the schemas, the deps, the API description, the nav and the People page |
| Questionnaire | A real empty state, since an account may now have no catalogue |

**Verified:** 234 backend tests, 164 frontend unit, 201 e2e. Every mechanism was
broken deliberately and watched to fail — option repointing, per-user cloning,
`_get_catalogue`'s ownership check, and `apply_answer`'s.

The migration was run against a seeded two-user database and the result read back
by hand: two catalogues of the same name, four answers preserved, each pointing
at its own owner's questions, enum answers still resolving to the labels they
were given (`alice → Mon`, `bob → Tue`), each default owned, score components
cloned, no originals left, `PRAGMA foreign_key_check` clean.

## Still open

Nothing. One thing deliberately not done: the frontend keeps `DEFAULT_CATALOGUE`
in `playwright.config.js` beside the new `TEMPLATE`, because a few specs still
assert the catalogue's *name*. Harmless, and worth a tidy if it ever drifts.
