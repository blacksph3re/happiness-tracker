# Importing sessions from a CSV — proposal

A button per project on **Projects**, opening a dialogue that takes a file, maps its
columns onto a session's start and end, asks for the timezone the times are written in
where the file does not say, and shows what it would do — including which rows would
overlap something already recorded — before anything is written.

*Revised: every question is answered, and the answers are folded in above them. One
changed the design — an import is not idempotent, so re-importing the same file is caught
by the overlap rules rather than prevented. Nothing is left assumed.*

**Built.** `lib/csv.js` reads the file, `lib/time/import.js` turns rows into sessions and
says what would happen to each, and `lib/time/ImportSessions.svelte` is the four steps.
Two departures from the text above, both noted where they matter: the dialogue is a panel
that opens inside the project's row, the way Edit and Rule already do on that page, and
overlapping rows are compared by a sweep in start order rather than every pair, so a large
file does not stall the preview. `csv.test.js`, `time/import.test.js` and
`e2e/import.spec.js` cover the list under Testing.

## Where it goes, and why per project

Per project, as asked, and it makes the rest simpler: the project is chosen before the
file is, so the file never has to name one. That rules out the import that would be
hardest to get right — a file whose rows land in *several* projects, matched by a name
column that may or may not correspond to anything. If that is wanted later it is a
different button, not a checkbox on this one.

The dialogue lives on Projects rather than on Record because it is administration: it
edits the account's data wholesale rather than recording what someone just did. That also
settles its offline behaviour — **online only**, like everything else on that page, with
the button disabled and saying why.

## The four steps

**1. The file.** A file input, `.csv` only. Parsed in the browser: the file never leaves
the device until the sessions themselves do, and the mapping cannot be offered until its
columns are known. Delimiter sniffed from the header line (`,` or `;` — a German Excel
writes the second), quoted fields honoured, byte-order mark stripped.

**2. The mapping.** One `<select>` per field the import needs, listing the file's column
names, with a preview of the first three rows underneath so a wrong guess is visible
immediately. Columns are guessed by name — `start`, `started`, `begin`, `from`, `von`;
`end`, `stop`, `to`, `bis` — and the guess is only ever a default.

| Field | Required | Notes |
| --- | --- | --- |
| Start | Yes | Date and time, in one column or two |
| End | Yes, unless a duration is mapped | |
| Duration | Alternative to End | Common in exports from other trackers |
| Note | No | Free text onto the session |

**3. The clock.** Sessions are stored as UTC instants plus the offset in force, so a file
of local wall-clock times cannot be imported without knowing which clock they are on.
Three cases, in the order the dialogue tries them:

- The value carries an offset (`2026-08-16T09:00:00+02:00`) — used as it stands, and the
  control is shown as already answered rather than hidden, so it is clear which rule
  applied.
- The value carries a `Z` — UTC.
- Neither, which is the common case for a spreadsheet — the dialogue asks. Default: **the
  browser's current offset**, named in full ("UTC+02:00, this device's clock") rather
  than left implicit.

A single offset for the whole file, not per row. A file spanning a daylight-saving change
is imported an hour out on one side of it, and the dialogue says so where the range
crosses one, rather than pretending otherwise. (`TIMEZONE_PROPOSAL.md`'s IANA zone would
fix this properly and is out of scope here.)

**4. The preview, and what it warns about.** Nothing is written before this screen. It
reports, per row:

| | |
| --- | --- |
| **Ready** | Parses, ends after it starts, overlaps nothing |
| **Overlaps** | Covers minutes this project already has, from an earlier import or from tracking. Listed with the session it collides with |
| **Overlaps within the file** | Two rows of the same file cover the same minutes |
| **Unreadable** | A date that does not parse, an end before its start, an empty required cell |

Overlaps are the interesting case, and the reason for the warning you asked for: one
project cannot run twice over the same minutes, because the hour would be counted twice
under the same name. The dialogue offers the same two answers the app already has for
this, per import rather than per row — **skip the overlapping rows**, or **merge them into
what is there** (earliest start to latest end, which invents nothing because overlapping
sessions have no gap between them). Unreadable rows are always skipped, listed with their
line numbers.

## What it writes

Through the sync queue, as one batch of `entry.upsert` intents — the app's only write path
since the per-resource endpoints were removed. Three things follow for free:

- Every imported session gets a fresh `client_id`. An import is **not** idempotent: the
  same file imported twice produces the same sessions twice, and what catches that is the
  overlap rule rather than anything remembered about the file. That is the decision in
  §Q1, and it has a consequence worth stating — the second import is not silent. Every row
  collides with the one it duplicates, so the preview reports the whole file as
  overlapping, and the answer to that is `Skip`. Re-importing a *corrected* file behaves
  the same way: the corrected rows overlap the originals, and merging them widens the
  session rather than replacing it.
- The overlap rule that already runs on the server runs here too, so a race between the
  import and a timer running on a phone cannot double-count.
- No new endpoint. `POST /api/sync` takes a queue, and a hundred rows is a queue.

An import of a thousand rows is sent in chunks so that one refusal reports one row, and so
the progress shown is real.

## Testing

- **Parsing**: a comma file, a semicolon file, a BOM, quoted fields containing commas and
  newlines, `dd.mm.yyyy` and ISO dates, a duration column in `1:30` and `1.5` and `90`.
- **The clock**: a file with offsets, a file in UTC, a file with neither; and the case that
  matters, a range crossing a daylight-saving change, which must warn.
- **Overlaps**: against existing sessions, within the file itself, and the two answers to
  each. A merged import must not invent the gap between two rows that do *not* overlap.
- **Refusals**: an unreadable row is skipped and reported by line number, and does not
  stop the rest — the same rule the sync queue already follows.
- **A second import**: the same file twice reports every row as an overlap and, on
  `Skip`, writes nothing — the answer to "what stops me duplicating my history" now that
  nothing remembers the file.
- **The dialogue**: a wrong mapping is visible in the preview before anything is written;
  cancelling writes nothing; the button is disabled with no connection.

## Decisions

1. **An import is not idempotent.** Every row becomes a new session with a fresh
   `client_id`, and a second import of the same file is caught by the overlap rules
   rather than prevented. Simpler, and it keeps one rule doing the work instead of two —
   but it means the preview of a repeated import is a wall of overlaps, which is the
   honest picture of what a second import would do.
2. **Duration is supported** as an alternative to an end time.
3. **Dates**: ISO, plus `dd.mm.yyyy` and `dd/mm/yyyy` read day-first, with the
   interpretation shown in the preview so a mis-read date is visible before it is written.
4. **Sessions only.** The import never creates a tag or changes a project's.
5. **Overlaps across projects are not flagged.** Parallel timers are a normal working day.
6. **No hard limit** on file size. Large files are sent in chunks with real progress.
7. **No undo.** The preview is the safeguard. A "delete every session on this project"
   button was raised as a possible future answer and is deliberately not part of this.

Everything above is written to match. This is what gets built.

## What is deliberately not here

- **A project column.** One import, one project, chosen before the file.
- **Working offline.** It is administration, like the page it sits on.
- **An undo, or a record of which import a session came from.** Nothing in the schema
  remembers a batch, and adding that is the price of undo — worth paying only if the
  preview turns out not to be enough.
