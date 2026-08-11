"""weekday and month become enums

Converts the two categorical auto-tracked questions from discrete scales into
enums, and rewrites the answers already recorded against them so that no
history is lost. The numeric value stored so far is the ordinal itself
(weekday 1-7, month 1-12), which maps onto the new options by position.

Revision ID: 98c9a74fa88c
Revises: 4d54057d862a
Create Date: 2026-08-11 09:14:08.044294

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '98c9a74fa88c'
down_revision: Union[str, Sequence[str], None] = '4d54057d862a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

WEEKDAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTH_LABELS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)
CONVERTED = {"weekday": WEEKDAY_LABELS, "month": MONTH_LABELS}

BOUNDS = {
    "weekday": (1.0, 7.0, "Monday", "Sunday"),
    "month": (1.0, 12.0, "January", "December"),
}


def upgrade() -> None:
    """Turn weekday and month into enums, carrying their answers across."""
    connection = op.get_bind()
    for system_key, labels in CONVERTED.items():
        questions = connection.execute(
            sa.text("SELECT id FROM questions WHERE system_key = :key"),
            {"key": system_key},
        ).fetchall()
        for (question_id,) in questions:
            option_ids = []
            for position, label in enumerate(labels):
                connection.execute(
                    sa.text(
                        "INSERT INTO question_options (question_id, label, position)"
                        " VALUES (:question_id, :label, :position)"
                    ),
                    {"question_id": question_id, "label": label, "position": position},
                )
                option_ids.append(
                    connection.execute(sa.text("SELECT last_insert_rowid()")).scalar()
                )

            # Stored values are 1-based ordinals; options are 0-based positions.
            for ordinal, option_id in enumerate(option_ids, start=1):
                connection.execute(
                    sa.text(
                        "UPDATE answers SET option_id = :option_id, value = NULL"
                        " WHERE question_id = :question_id AND value = :ordinal"
                    ),
                    {
                        "option_id": option_id,
                        "question_id": question_id,
                        "ordinal": float(ordinal),
                    },
                )

            connection.execute(
                sa.text(
                    "UPDATE questions SET kind = 'enum', min_value = NULL,"
                    " max_value = NULL, min_label = NULL, max_label = NULL"
                    " WHERE id = :question_id"
                ),
                {"question_id": question_id},
            )


def downgrade() -> None:
    """Turn weekday and month back into discrete scales."""
    connection = op.get_bind()
    for system_key, labels in CONVERTED.items():
        low, high, low_label, high_label = BOUNDS[system_key]
        questions = connection.execute(
            sa.text("SELECT id FROM questions WHERE system_key = :key"),
            {"key": system_key},
        ).fetchall()
        for (question_id,) in questions:
            options = connection.execute(
                sa.text(
                    "SELECT id, position FROM question_options"
                    " WHERE question_id = :question_id"
                ),
                {"question_id": question_id},
            ).fetchall()
            for option_id, position in options:
                connection.execute(
                    sa.text(
                        "UPDATE answers SET value = :value, option_id = NULL"
                        " WHERE question_id = :question_id AND option_id = :option_id"
                    ),
                    {
                        "value": float(position + 1),
                        "question_id": question_id,
                        "option_id": option_id,
                    },
                )
            connection.execute(
                sa.text(
                    "DELETE FROM question_options WHERE question_id = :question_id"
                ),
                {"question_id": question_id},
            )
            connection.execute(
                sa.text(
                    "UPDATE questions SET kind = 'discrete', min_value = :low,"
                    " max_value = :high, min_label = :low_label,"
                    " max_label = :high_label WHERE id = :question_id"
                ),
                {
                    "low": low,
                    "high": high,
                    "low_label": low_label,
                    "high_label": high_label,
                    "question_id": question_id,
                },
            )
