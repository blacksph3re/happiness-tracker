"""Auto-tracked values are computed, not stored

Revision ID: c3e81f47a9d2
Revises: f6c04b8a7612
Create Date: 2026-08-29

Weekday, day-of-year, month and year are functions of the calendar day, and this
database stored one answer row per day per value — 508 of them here, 36% of the
answers table, each one a stored ``date.isoweekday()``. The house rule is that a
derived value is computed on read, and the time half of the app had already
decided this for weekday: `lib/facets.js` reads the calendar and says why.

The fifth, ``first_answer_hour``, is real recorded data with nowhere else to
live, so it moves to a column on the answer that carries it.

Six phases, in one revision because a half-migrated database is not a state
worth being able to stop in.

1. Add ``answers.local_hour``. **Nullable with no server default**, which is the
   one shape SQLite adds in place instead of rebuilding the table.
2. Backfill it from the ``first_answer_hour`` answers, **before anything is
   deleted**. The only step that cannot be redone.
3. Guard: refuse to go on if any day would lose its hour.
4. Strip ``weekday`` and ``month`` from stored preference filters. Their choice
   ids were option row ids and become positions, so a filter left behind would
   match nothing while still looking active — the fix is to leave it empty
   rather than wrong. The three scaled keys are unaffected: their choice ids are
   the values themselves, which do not change.
5. Delete the auto-tracked answers, then their options, then the questions —
   **deepest first**, because `env.py` disables foreign keys for the migration
   connection and cascades do not fire.
6. Rebuild ``questions`` without ``system_key`` or its unique constraint.

The backfill gives every answer on a day that day's single recorded hour, so
``min(local_hour)`` reproduces the old value exactly. For historical rows the
column therefore means "the day's first hour" rather than "this row's hour",
which is invisible to the only reader.
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c3e81f47a9d2"
down_revision: str | Sequence[str] | None = "f6c04b8a7612"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SYSTEM_KEYS = ("weekday", "day_of_year", "month", "year", "first_answer_hour")
"""Every auto-tracked key, in the order the questions were created."""

ENUM_KEYS = ("weekday", "month")
"""The two whose filter choices were option row ids and become positions."""

WEEKDAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
"""Weekday option labels, index 0 being Monday. Needed only by the downgrade."""

MONTH_LABELS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
"""Month option labels, index 0 being January. Needed only by the downgrade."""

SPECS = {
    "weekday": ("Weekday", "enum", None, None, None, None, WEEKDAY_LABELS),
    "day_of_year": ("Day of the year", "discrete", 1.0, 366.0, "Jan 1", "Dec 31", ()),
    "month": ("Month", "enum", None, None, None, None, MONTH_LABELS),
    "year": ("Year", "discrete", 2000.0, 2100.0, "2000", "2100", ()),
    "first_answer_hour": (
        "Hour of first answer",
        "discrete",
        0.0,
        23.0,
        "Midnight",
        "23:00",
        (),
    ),
}
"""How each auto-tracked question was defined, for rebuilding it on downgrade."""


def _strip_filter_keys(document: str | None, keys: Sequence[str]) -> str | None:
    """Remove named entries from every ``filters`` object in a preferences blob.

    The document is opaque to the backend and its shape has changed twice, so
    this walks it rather than reaching for known paths.

    Parameters
    ----------
    document : str or None
        The stored JSON, or None when the account has never saved any.
    keys : sequence of str
        Filter keys to remove wherever they appear.

    Returns
    -------
    str or None
        The rewritten document, or the original when nothing changed or it
        could not be parsed.
    """
    if not document:
        return document
    try:
        loaded = json.loads(document)
    except ValueError, TypeError:
        return document

    changed = False

    def walk(node):
        nonlocal changed
        if not isinstance(node, dict):
            return
        filters = node.get("filters")
        if isinstance(filters, dict):
            for key in keys:
                if key in filters:
                    del filters[key]
                    changed = True
        for value in node.values():
            walk(value)

    walk(loaded)
    return json.dumps(loaded) if changed else document


def upgrade() -> None:
    """Move the hour onto the answer and delete everything else auto-tracked."""
    connection = op.get_bind()

    # 1. Nullable, no server default: added in place, table not rebuilt.
    op.add_column("answers", sa.Column("local_hour", sa.Integer(), nullable=True))

    # 2. The backfill, before anything is deleted.
    connection.execute(
        sa.text(
            """
            UPDATE answers SET local_hour = (
                SELECT CAST(hour.value AS INTEGER)
                FROM answers AS hour
                JOIN questions AS q ON q.id = hour.question_id
                WHERE q.system_key = 'first_answer_hour'
                  AND hour.user_id = answers.user_id
                  AND hour.day = answers.day
                LIMIT 1
            )
            """
        )
    )

    # 3. Every day that recorded an hour must still have somewhere to keep it.
    stranded = connection.execute(
        sa.text(
            """
            SELECT COUNT(*) FROM (
                SELECT hour.user_id, hour.day
                FROM answers AS hour
                JOIN questions AS q ON q.id = hour.question_id
                WHERE q.system_key = 'first_answer_hour'
                EXCEPT
                SELECT kept.user_id, kept.day
                FROM answers AS kept
                JOIN questions AS k ON k.id = kept.question_id
                WHERE k.system_key IS NULL AND kept.local_hour IS NOT NULL
            )
            """
        )
    ).scalar_one()
    if stranded:
        raise RuntimeError(
            f"{stranded} day(s) would lose their first-answer hour: every day "
            "with a recorded hour must keep at least one answer carrying it. "
            "Refusing to delete anything."
        )

    # 4. A filter on an id that is about to change meaning.
    for user_id, document in connection.execute(
        sa.text("SELECT id, preferences FROM users")
    ).all():
        rewritten = _strip_filter_keys(document, ENUM_KEYS)
        if rewritten != document:
            connection.execute(
                sa.text("UPDATE users SET preferences = :p WHERE id = :i"),
                {"p": rewritten, "i": user_id},
            )

    # 5. Deepest first: foreign keys are off, so nothing cascades for us.
    connection.execute(
        sa.text(
            "DELETE FROM answers WHERE question_id IN "
            "(SELECT id FROM questions WHERE system_key IS NOT NULL)"
        )
    )
    connection.execute(
        sa.text(
            "DELETE FROM question_options WHERE question_id IN "
            "(SELECT id FROM questions WHERE system_key IS NOT NULL)"
        )
    )
    connection.execute(sa.text("DELETE FROM questions WHERE system_key IS NOT NULL"))

    # 6. The column and its unique constraint both go, in one rebuild.
    with op.batch_alter_table("questions", schema=None) as batch:
        batch.drop_constraint("uq_question_system_key", type_="unique")
        batch.drop_column("system_key")


def downgrade() -> None:
    """Rebuild the auto-tracked questions and re-materialise their answers.

    Everything deleted above is derivable — four values from the calendar day
    and the fifth from ``local_hour`` — so this restores the rows rather than
    admitting defeat. The filter preferences stripped in phase 4 are not
    restored: they were dropped precisely because their ids no longer mean
    anything, and re-adding them would put back the wrong state.
    """
    connection = op.get_bind()

    with op.batch_alter_table("questions", schema=None) as batch:
        batch.add_column(sa.Column("system_key", sa.String(length=32), nullable=True))
        batch.create_unique_constraint(
            "uq_question_system_key", ["catalogue_id", "system_key"]
        )

    catalogues = [
        row[0] for row in connection.execute(sa.text("SELECT id FROM catalogues")).all()
    ]
    for catalogue_id in catalogues:
        for offset, key in enumerate(SYSTEM_KEYS):
            prompt, kind, low, high, low_label, high_label, labels = SPECS[key]
            connection.execute(
                sa.text(
                    "INSERT INTO questions (catalogue_id, kind, prompt, position, "
                    "active, origin, system_key, min_value, max_value, min_label, "
                    "max_label, require_all) VALUES (:c, :k, :p, :pos, 1, 'auto', "
                    ":sk, :lo, :hi, :ll, :hl, 1)"
                ),
                {
                    "c": catalogue_id,
                    "k": kind,
                    "p": prompt,
                    "pos": 1000 + offset,
                    "sk": key,
                    "lo": low,
                    "hi": high,
                    "ll": low_label,
                    "hl": high_label,
                },
            )
            question_id = connection.execute(
                sa.text("SELECT last_insert_rowid()")
            ).scalar_one()
            for position, label in enumerate(labels):
                connection.execute(
                    sa.text(
                        "INSERT INTO question_options (question_id, label, position) "
                        "VALUES (:q, :l, :p)"
                    ),
                    {"q": question_id, "l": label, "p": position},
                )

    # One set per (user, day), written into whichever catalogue that day was
    # answered in first — which is exactly the arbitrary choice the upgrade
    # removed, and the reason this direction cannot be exact.
    days = connection.execute(
        sa.text(
            "SELECT a.user_id, a.day, MIN(a.local_hour), MIN(q.catalogue_id) "
            "FROM answers AS a JOIN questions AS q ON q.id = a.question_id "
            "GROUP BY a.user_id, a.day"
        )
    ).all()
    for user_id, day, hour, catalogue_id in days:
        parsed = day if hasattr(day, "isoweekday") else _parse_day(day)
        values = {
            "weekday": float(parsed.isoweekday() - 1),
            "day_of_year": float(parsed.timetuple().tm_yday),
            "month": float(parsed.month - 1),
            "year": float(parsed.year),
            "first_answer_hour": float(hour if hour is not None else 0),
        }
        for key, value in values.items():
            question_id = connection.execute(
                sa.text(
                    "SELECT id FROM questions WHERE catalogue_id = :c "
                    "AND system_key = :k"
                ),
                {"c": catalogue_id, "k": key},
            ).scalar_one_or_none()
            if question_id is None:
                continue
            if key in ENUM_KEYS:
                option_id = connection.execute(
                    sa.text(
                        "SELECT id FROM question_options WHERE question_id = :q "
                        "AND position = :p"
                    ),
                    {"q": question_id, "p": int(value)},
                ).scalar_one_or_none()
                if option_id is None:
                    continue
                connection.execute(
                    sa.text(
                        "INSERT INTO answers (user_id, question_id, day, option_id) "
                        "VALUES (:u, :q, :d, :o)"
                    ),
                    {"u": user_id, "q": question_id, "d": day, "o": option_id},
                )
                continue
            connection.execute(
                sa.text(
                    "INSERT INTO answers (user_id, question_id, day, value) "
                    "VALUES (:u, :q, :d, :v)"
                ),
                {"u": user_id, "q": question_id, "d": day, "v": value},
            )

    with op.batch_alter_table("answers", schema=None) as batch:
        batch.drop_column("local_hour")


def _parse_day(value: str):
    """Read a ``YYYY-MM-DD`` string into a date.

    SQLite hands dates back as text through a raw connection, so the downgrade
    cannot assume the driver has parsed one.

    Parameters
    ----------
    value : str
        The stored day.

    Returns
    -------
    datetime.date
        The parsed day.
    """
    from datetime import date

    year, month, day = (int(part) for part in str(value).split("-"))
    return date(year, month, day)
