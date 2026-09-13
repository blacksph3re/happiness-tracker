"""Write the ordering corpus the JavaScript port of `between` is held against.

The client computes the key a drop lands on, because only the client knows
where the card was released — so `services/todos.py::between` exists twice, in
Python here and in `app/src/lib/todos/rank.js` there. This is what keeps the two
honest, the same arrangement `dump_derivations.py` already makes for the
totals and the scores: every case carries the answer Python gave, and
`rank.test.js` feeds the same inputs to the JavaScript and fails on any
difference.

The patterns are chosen for the ones that actually go wrong. A thousand
consecutive prepends is the claim the design rests on — a place to drop can
never run out — and it is also the walk that exercises the descend-a-character
branch of `_before` over and over. A thousand appends does the same for the
carry in `_after`. The midpoint chains insert into one gap repeatedly from both
sides, which is what makes keys grow and so what a rebalance exists for.

Run it from `backend/` after touching anything in `services/todos.py`:

    uv run python scripts/dump_rank_cases.py
"""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.todos import RANK_DIGITS, TodoRuleError, between  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[2]
    / "app"
    / "src"
    / "lib"
    / "todos"
    / "rank-cases.json"
)
"""Where the corpus lands, beside the port it holds to account."""

WALK = 1000
"""How many consecutive prepends and appends to record.

The number question 16 asked about, so it is the number generated rather than a
round figure that merely sounds like enough.
"""

CHAIN = 500
"""How many inserts into one gap to record, per direction."""

RANDOM_PAIRS = 400
"""How many arbitrary pairs to record, including ties and reversed ones."""


def case(label: str, before: str | None, after: str | None) -> dict:
    """Record what `between` answers for one pair.

    Parameters
    ----------
    label : str
        Which pattern this case belongs to, so a failure says what broke.
    before : str or None
        The lower bound, or None for the start of the list.
    after : str or None
        The upper bound, or None for the end of it.

    Returns
    -------
    dict
        The inputs and the key Python produced.
    """
    return {
        "label": label,
        "before": before,
        "after": after,
        "expected": between(before, after),
    }


def ends() -> list[dict]:
    """Return the cases with no neighbour on one side or on either.

    Returns
    -------
    list of dict
        The empty list, one-sided inserts, and the ends of the alphabet.
    """
    out = [case("empty", None, None)]
    for key in ("b", "n", "z", "an", "ana", "azz", "nnn", "zzz", "bn", "zn"):
        out.append(case("append", key, None))
        out.append(case("prepend", None, key))
    return out


def walk(label: str, forward: bool) -> dict:
    """Return `WALK` inserts, each at the same end of a growing list.

    Stored as the sequence of keys rather than as one case per insert, because
    each insert's bound *is* the previous answer: written out in full the
    corpus carries every key twice and is half a megabyte for no more
    information. The test replays the walk, which is a stronger reading of it —
    a port that diverged at step three cannot get step four right by accident.

    Parameters
    ----------
    label : str
        Name for the pattern.
    forward : bool
        True to append past the last key, False to prepend before the first.

    Returns
    -------
    dict
        The pattern, the side new keys go on, and the keys in order.
    """
    keys = []
    cursor: str | None = None
    for _ in range(WALK):
        cursor = between(cursor, None) if forward else between(None, cursor)
        keys.append(cursor)
    return {"label": label, "side": "after" if forward else "before", "keys": keys}


def chain(label: str, from_below: bool) -> dict:
    """Return `CHAIN` inserts into one gap, closing it from one side.

    Recorded as a replayable sequence for the reason `walk` is.

    Parameters
    ----------
    label : str
        Name for the pattern.
    from_below : bool
        True to keep inserting just above the lower bound, False to keep
        inserting just below the upper one.

    Returns
    -------
    dict
        The opening pair, which side is moved, and the keys in order.
    """
    low = between(None, None)
    high = between(low, None)
    opening = (low, high)
    keys = []
    for _ in range(CHAIN):
        key = between(low, high)
        keys.append(key)
        if from_below:
            low = key
        else:
            high = key
    return {
        "label": label,
        "low": opening[0],
        "high": opening[1],
        "moves": "low" if from_below else "high",
        "keys": keys,
    }


def arbitrary() -> list[dict]:
    """Return pairs of keys drawn at random, ties and inversions included.

    Two devices inserting offline into the same gap can produce the same key
    twice, and a client that has not re-read a column can ask for a key between
    two that are the wrong way round. Neither may fail, and both have to fail
    the *same* way in both implementations, so they are in the corpus rather
    than left to a comment.

    Returns
    -------
    list of dict
        The cases.
    """
    dice = random.Random(20260911)
    keys = []
    while len(keys) < 60:
        width = dice.randint(1, 6)
        key = "".join(dice.choice(RANK_DIGITS) for _ in range(width))
        # `between` refuses to prepend before this encoding's zero, and that
        # refusal is checked by name in `rank.test.js` rather than here, where
        # every case has to have an answer.
        if key.strip("a"):
            keys.append(key)

    out = []
    for _ in range(RANDOM_PAIRS):
        low = dice.choice(keys)
        high = dice.choice(keys)
        out.append(case("arbitrary", low, high))
    # Ties explicitly, rather than hoping the draw produced one.
    for key in keys[:20]:
        out.append(case("tie", key, key))
    return out


def refusals() -> list[dict]:
    """Return the pairs `between` will not answer, and what it says about them.

    Returns
    -------
    list of dict
        Inputs and the message Python raised, for the port to match by kind.
    """
    out = []
    for before, after in ((None, "a"), (None, "aa"), (None, "aaa")):
        try:
            between(before, after)
        except TodoRuleError as refused:
            out.append({"before": before, "after": after, "detail": str(refused)})
        else:  # pragma: no cover - the guard is what is being recorded
            raise AssertionError(
                f"between({before!r}, {after!r}) was expected to refuse"
            )
    return out


def main() -> None:
    """Write the corpus."""
    corpus = {
        "pairs": [*ends(), *arbitrary()],
        "walks": [
            walk("prepends", forward=False),
            walk("appends", forward=True),
        ],
        "chains": [
            chain("midpoint from below", from_below=True),
            chain("midpoint from above", from_below=False),
        ],
        "refusals": refusals(),
    }
    OUT.write_text(json.dumps(corpus, indent=1) + "\n")
    replayed = sum(len(one["keys"]) for one in corpus["walks"] + corpus["chains"])
    print(
        f"{len(corpus['pairs'])} pairs, {replayed} replayed inserts and "
        f"{len(corpus['refusals'])} refusals -> {OUT}"
    )


if __name__ == "__main__":
    main()
