# Architecture

A [LikeC4](https://likec4.dev) model of the Daily Tracker. Four `.c4` files, one
model, eight views.

## Looking at it

```sh
pnpm dlx likec4 start docs/architecture      # browse at http://localhost:5173
pnpm dlx likec4 validate docs/architecture   # what CI would check
pnpm dlx likec4 build -o dist docs/architecture
```

Nothing is added to `app/package.json` for this — the frontend package stays a
frontend package, and `dlx` fetches the tool when it is wanted.

The four flows are **dynamic views**: open one and use the `Diagram` /
`Sequence` toggle in the toolbar. `Sequence` gives the lifelines; `Diagram`
gives the same numbered steps laid out as a graph.

## The views

| View | What it answers |
| --- | --- |
| `index` | The whole thing on one page: one person, one process, one file |
| `answering` | Answering a question — browser to store to router to row |
| `wellbeingStatsFlow` | Viewing the stats, and where each number is computed |
| `timeTracking` | Checking in, and then reading a week back out |
| `authentication` | Signing in, and what is asserted on every request after |
| `backendZones` | `backend/` as wellbeing, time and shared |
| `frontendZones` | `app/src/` as the same three |
| `zonesAcross` | The split running the full depth of the stack |

## What the model is trying to say

Three things, all of which are decisions rather than accidents, and all of which
a diagram makes checkable:

**Imports point inward.** Wellbeing and time never reference each other, in
either half of the codebase. Anything both need moves to the shared zone, and
the move is the signal it was shared all along. In `backendZones` and
`frontendZones` this is visible as an absence: no edge runs from a green box to
an amber one. One appearing is a bug, not a diagram to update.

**The store is read, not refetched.** Every flow crosses the network on its
first pass and stops at `Store` on the second. The cache holds entries by the
*range* they were loaded for and summaries by `(range, grouping)`; a write
updates it in place. `expectSettled()` in `app/e2e/fixtures.js` asserts it from
outside.

**Derived values are computed on read.** Scores, deduction bands, the midnight
split, the grouping by tag — none are stored, and all are computed by the server
so the screen and the `.xlsx` cannot drift apart. `deductions.js` on the client
is the single deliberate exception, and only to preview a rule that has not been
saved yet.

The deployment's reverse proxy — SSL termination and a second authentication
layer — is deliberately absent from `authentication`. That view is what the
application asserts on its own, which is the part that stays true if the proxy
is ever misconfigured.

## Keeping it true

The nesting mirrors the file tree: a `zone` here is a directory there, and each
component names the file or files it stands for in its `technology` line. A
component that no longer matches a path is the same event as a file moving, and
should be noticed in the same review.

`docs/architecture` holds the model only. Screenshots of the running app live in
`docs/screenshots`.
