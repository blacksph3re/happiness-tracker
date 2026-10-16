"""A day off can be taken from the hour balance.

Revision ID: 5c1e9a7b3d24
Revises: 744d2a58c91e
Create Date: 2026-10-16

A fourth kind of day off, ``balance``: a day off that costs its hours rather
than excusing them. The kind is guarded by a check constraint, and SQLite cannot
change one in place, so ``tag_days_off`` is **rebuilt** — copied, dropped and
renamed by the batch context. Nothing refers to the table, so the rebuild has
nothing to cascade into, and its unique key and index are carried across;
``tests/test_migrations.py`` holds both, and every row.

The downgrade refuses while any such day exists. The old constraint has no word
for one, and calling it ``other`` would quietly give back the hours it cost.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "5c1e9a7b3d24"
down_revision: str | Sequence[str] | None = "744d2a58c91e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_KINDS = ("vacation", "sick", "other")
"""The kinds before this revision, spelled here: a migration is frozen."""

NEW_KINDS = (*OLD_KINDS, "balance")
"""The kinds after it."""


def _check(kinds: tuple[str, ...]) -> str:
    """Spell the kind constraint for a set of kinds.

    Parameters
    ----------
    kinds : tuple of str
        The kinds a day off may have.

    Returns
    -------
    str
        The constraint's SQL expression.
    """
    return "kind is null or kind in (" + ", ".join(f"'{kind}'" for kind in kinds) + ")"


def upgrade() -> None:
    """Rebuild the days off with ``balance`` among the kinds."""
    with op.batch_alter_table("tag_days_off", recreate="always") as batch:
        batch.drop_constraint("ck_day_off_kind", type_="check")
        batch.create_check_constraint("ck_day_off_kind", _check(NEW_KINDS))


def downgrade() -> None:
    """Rebuild the days off without ``balance``, refusing while one exists.

    Raises
    ------
    RuntimeError
        If any day off is taken from the balance.
    """
    taken = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM tag_days_off WHERE kind = 'balance'"))
        .scalar_one()
    )
    if taken:
        raise RuntimeError(
            f"{taken} days off are taken from the balance; the earlier schema "
            "cannot hold them, so clear them before downgrading"
        )
    with op.batch_alter_table("tag_days_off", recreate="always") as batch:
        batch.drop_constraint("ck_day_off_kind", type_="check")
        batch.create_check_constraint("ck_day_off_kind", _check(OLD_KINDS))
