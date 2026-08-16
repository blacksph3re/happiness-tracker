r"""Strip a second factor from an account, from the server itself.

The break-glass for the one lockout the API cannot answer: an administrator who
loses the device holding their own second factor. An ordinary user is cleared by
an administrator through ``DELETE /api/users/{id}/totp``; the administrator has
nobody above them, so this is the whole of their recovery.

It grants nothing new. Anyone able to run it already has the database file, and
with it every answer in the account. What it saves is doing surgery on that file
by hand and getting a column wrong.

The account is signed out everywhere as a side effect, in exactly the way the
API path does it — so this cannot be used on somebody else quietly.

Run from `backend/`, on the machine holding the database::

    DB_STORAGE=/srv/database.db uv run python scripts/clear_totp.py <username>

or, against the deployed container, whose entrypoint is overridden to the
interpreter because the runtime image has no shell::

    docker compose run --rm --entrypoint /srv/.venv/bin/python \\
        app scripts/clear_totp.py <username>

`JWT_SECRET` and `TOTP_ENCRYPTION_KEY` are not read: nothing here signs or
decrypts anything, it only clears columns. That is deliberate — a lockout is a
poor moment to discover that a variable is missing.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from database import SessionLocal  # noqa: E402
from models import User  # noqa: E402
from security import clear_totp  # noqa: E402


def main() -> int:
    """Clear one account's second factor.

    Returns
    -------
    int
        Process exit status: 0 when the account was cleared, 1 when no account
        by that name exists.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("username", help="The account to clear.")
    args = parser.parse_args()

    with SessionLocal() as db:
        user = db.execute(
            select(User).where(User.username == args.username)
        ).scalar_one_or_none()
        if user is None:
            print(f"No account named {args.username!r}.", file=sys.stderr)
            return 1

        had_one = user.totp_confirmed_at is not None
        clear_totp(user)
        db.commit()

    # Said plainly either way. "Nothing was enrolled" is the answer to a
    # different question from "it is gone now", and somebody locked out at the
    # time of running this needs to know which one they got.
    if had_one:
        print(f"Cleared the second factor on {args.username!r}.")
    else:
        print(f"{args.username!r} had no confirmed second factor; nothing to clear.")
    print("Every session on that account is signed out. Log in with the password.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
