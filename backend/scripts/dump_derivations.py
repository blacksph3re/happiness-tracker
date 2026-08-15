"""Write the conformance corpus the JavaScript ports are held against.

The offline app computes totals, deductions and scores for itself, because with
no connection there is nothing to ask. That means two implementations of rules
this codebase otherwise insists on having once — and the only thing keeping them
honest is this file and the tests that read it.

Each case is inputs plus what the Python produced. `app/src/lib/**/*.test.js`
feeds the same inputs to the JavaScript and fails on any difference, so a change
to one side that is not made to the other is a failing test rather than a
number that quietly differs on a train.

Run it from `backend/` after touching anything in `services/`:

    uv run python scripts/dump_derivations.py
"""

import json
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.timetrack import (  # noqa: E402
    day_offsets,
    deduction_for,
    group_by_tag,
    reported,
    summarise,
)
from services.wellbeing import _system_values, score_for_day  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "derivations.json"
"""Where the corpus lands, beside the code it holds to account."""


@dataclass
class Entry:
    """A session, in the shape the service functions read."""

    project_id: int
    started_at: datetime
    ended_at: datetime | None
    utc_offset: int


@dataclass
class Band:
    """One band of a deduction rule."""

    from_minutes: int
    deduct_minutes: int | None


@dataclass
class Component:
    """One question feeding a computed score."""

    source_question_id: int
    weight: float


@dataclass
class Score:
    """A computed score, as `score_for_day` reads one."""

    aggregate: str
    require_all: bool
    components: list[Component]


def _entry(project_id, started, ended, offset=0):
    """Build one session from ISO strings."""
    return Entry(
        project_id=project_id,
        started_at=datetime.fromisoformat(started),
        ended_at=datetime.fromisoformat(ended) if ended else None,
        utc_offset=offset,
    )


def _wire(entry: Entry) -> dict:
    """Render a session the way the API sends it to the client."""
    return {
        "project_id": entry.project_id,
        "started_at": entry.started_at.isoformat(),
        "ended_at": entry.ended_at.isoformat() if entry.ended_at else None,
        "utc_offset": entry.utc_offset,
    }


AS_OF = datetime(2026, 6, 15, 12, 0, 0)
"""The instant a running session is measured to, fixed so the corpus is stable."""


SESSION_CASES = [
    (
        "one session inside a day",
        [_entry(1, "2026-06-10T09:00:00", "2026-06-10T12:00:00")],
    ),
    (
        "a session across midnight",
        [_entry(1, "2026-06-10T22:00:00", "2026-06-11T02:00:00")],
    ),
    (
        "two projects at once, so the day sums past its own length",
        [
            _entry(1, "2026-06-10T09:00:00", "2026-06-10T17:00:00"),
            _entry(2, "2026-06-10T10:00:00", "2026-06-10T18:00:00"),
        ],
    ),
    (
        "a session still running",
        [_entry(1, "2026-06-15T09:00:00", None)],
    ),
    (
        "days on two different clocks after a flight",
        [
            _entry(1, "2026-06-10T08:00:00", "2026-06-10T16:00:00", offset=120),
            _entry(1, "2026-06-11T20:00:00", "2026-06-12T04:00:00", offset=-300),
        ],
    ),
    (
        "a session ending exactly at midnight",
        [_entry(1, "2026-06-10T20:00:00", "2026-06-11T00:00:00")],
    ),
    (
        "several short sessions on one project",
        [
            _entry(1, "2026-06-10T09:00:00", "2026-06-10T09:15:00"),
            _entry(1, "2026-06-10T11:00:00", "2026-06-10T11:20:00"),
            _entry(1, "2026-06-10T14:00:00", "2026-06-10T14:05:00"),
        ],
    ),
]

TAGS_OF = {1: [10, 20], 2: [10], 3: []}
"""Project 1 under two tags, project 2 under one, project 3 under none."""

BAND_CASES = [
    ("no rule", []),
    ("a lunch deduction", [Band(360, 45)]),
    ("two bands, the higher one reached", [Band(240, 15), Band(360, 45)]),
    ("a cap", [Band(600, None)]),
    ("a deduction larger than the day", [Band(1, 600)]),
]

SCORE_CASES = [
    (
        "sum of three, all answered",
        Score("sum", False, [Component(1, 1.0), Component(2, 1.0), Component(3, 1.0)]),
        {1: 4.0, 2: 3.0, 3: 5.0},
    ),
    (
        "mean, weighted",
        Score("mean", False, [Component(1, 2.0), Component(2, 1.0)]),
        {1: 4.0, 2: 1.0},
    ),
    (
        "a component missing, require_all off",
        Score("sum", False, [Component(1, 1.0), Component(2, 1.0)]),
        {1: 4.0},
    ),
    (
        "a component missing, require_all on",
        Score("sum", True, [Component(1, 1.0), Component(2, 1.0)]),
        {1: 4.0},
    ),
    ("nothing answered", Score("sum", False, [Component(1, 1.0)]), {}),
    (
        "weights summing to zero",
        Score("mean", False, [Component(1, 1.0), Component(2, -1.0)]),
        {1: 4.0, 2: 2.0},
    ),
]

DAY_CASES = [
    ("2026-01-01", 9),
    ("2026-06-15", 0),
    ("2026-12-31", 23),
    ("2024-02-29", 12),
    ("2026-03-01", 7),
]


def main_() -> None:
    """Write every case and its Python answer to the corpus file."""
    corpus: dict[str, list] = {
        "summaries": [],
        "deductions": [],
        "scores": [],
        "days": [],
    }

    for name, entries in SESSION_CASES:
        totals = summarise(entries, AS_OF)
        by_tag = group_by_tag(totals, TAGS_OF)
        corpus["summaries"].append(
            {
                "name": name,
                "entries": [_wire(entry) for entry in entries],
                "as_of": AS_OF.isoformat(),
                "offsets": {
                    day.isoformat(): offset
                    for day, offset in day_offsets(entries).items()
                },
                "by_project": {
                    day.isoformat(): {str(k): v for k, v in row.items()}
                    for day, row in totals.items()
                },
                "by_tag": {
                    day.isoformat(): {
                        ("null" if k is None else str(k)): v for k, v in row.items()
                    }
                    for day, row in by_tag.items()
                },
            }
        )

    for name, bands in BAND_CASES:
        for tracked in (0, 60, 3600, 21_600, 28_800, 36_000, 43_200):
            corpus["deductions"].append(
                {
                    "name": f"{name}, {tracked}s tracked",
                    "tracked": tracked,
                    "bands": [
                        {
                            "from_minutes": band.from_minutes,
                            "deduct_minutes": band.deduct_minutes,
                        }
                        for band in bands
                    ],
                    "deduction": deduction_for(tracked, bands),
                    "reported": reported(tracked, bands),
                }
            )

    for name, score, values in SCORE_CASES:
        corpus["scores"].append(
            {
                "name": name,
                "score": {
                    "aggregate": score.aggregate,
                    "require_all": score.require_all,
                    "components": [
                        {"source_question_id": c.source_question_id, "weight": c.weight}
                        for c in score.components
                    ],
                },
                "values": {str(k): v for k, v in values.items()},
                "result": score_for_day(score, values),
            }
        )

    for day, hour in DAY_CASES:
        corpus["days"].append(
            {
                "name": f"{day} at {hour}",
                "day": day,
                "local_hour": hour,
                "values": _system_values(date.fromisoformat(day), hour),
            }
        )

    OUT.write_text(json.dumps(corpus, indent=2, sort_keys=True) + "\n")
    counts = {section: len(rows) for section, rows in corpus.items()}
    print(f"wrote {OUT} — {counts}")


if __name__ == "__main__":
    main_()
