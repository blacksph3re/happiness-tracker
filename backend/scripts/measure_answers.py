r"""Measure the answer endpoints against a long history.

Seeds one account with several years of daily answers and times the reads the
frontend actually makes, so a decision about pagination rests on numbers rather
than on a feeling about how big "multiple years" is.

Run from `backend/`::

    DB_STORAGE=/tmp/perf.db JWT_SECRET=x ADMIN_PASSWORD=y \\
        uv run python scripts/measure_answers.py --years 5
"""

import argparse
import statistics
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

import main  # noqa: E402
from database import SessionLocal  # noqa: E402
from models import Answer, Question, User  # noqa: E402
from services import _system_values  # noqa: E402


def seed(years: int) -> tuple[int, int]:
    """Insert `years` of daily answers for the bootstrapped administrator.

    Written straight through the ORM in bulk rather than over HTTP: the point is
    to measure reading, and seeding through the API would dominate the runtime.

    Parameters
    ----------
    years : int
        How many years of history to create, ending today.

    Returns
    -------
    tuple of (int, int)
        The number of rows inserted and the number of days covered.
    """
    with SessionLocal() as db:
        user = db.execute(select(User).order_by(User.id)).scalars().first()
        catalogue_id = user.default_catalogue_id
        questions = (
            db.execute(select(Question).where(Question.catalogue_id == catalogue_id))
            .scalars()
            .all()
        )
        real = [q for q in questions if q.system_key is None]
        system = [q for q in questions if q.system_key is not None]

        days = years * 365
        start = date.today() - timedelta(days=days - 1)
        rows = []
        for offset in range(days):
            day = start + timedelta(days=offset)
            for index, question in enumerate(real):
                low = question.min_value or 0
                high = question.max_value or 5
                value = low + ((offset + index) % int(high - low + 1))
                rows.append(
                    Answer(
                        user_id=user.id,
                        question_id=question.id,
                        day=day,
                        value=float(value),
                    )
                )
            values = _system_values(day, 9)
            for question in system:
                if question.kind == "enum":
                    position = int(values[question.system_key])
                    option = next(
                        (o for o in question.options if o.position == position), None
                    )
                    if option is None:
                        continue
                    rows.append(
                        Answer(
                            user_id=user.id,
                            question_id=question.id,
                            day=day,
                            option_id=option.id,
                        )
                    )
                else:
                    rows.append(
                        Answer(
                            user_id=user.id,
                            question_id=question.id,
                            day=day,
                            value=values[question.system_key],
                        )
                    )

        db.bulk_save_objects(rows)
        db.commit()
        return len(rows), days


def time_call(client, label: str, path: str, headers: dict, repeats: int = 5) -> None:
    """Time one endpoint and print the median, best and payload size.

    Parameters
    ----------
    client : fastapi.testclient.TestClient
        Client bound to the running application.
    label : str
        Human-readable name for the measurement.
    path : str
        Path to request.
    headers : dict
        Authorization headers.
    repeats : int, optional
        How many times to call it, by default 5.
    """
    timings = []
    size = 0
    for _ in range(repeats):
        started = time.perf_counter()
        response = client.get(path, headers=headers)
        timings.append((time.perf_counter() - started) * 1000)
        response.raise_for_status()
        size = len(response.content)
    print(
        f"{label:<34} median {statistics.median(timings):7.1f} ms"
        f"   best {min(timings):7.1f} ms   {size / 1_000_000:5.2f} MB"
    )


def main_() -> None:
    """Seed the history and report timings for the reads the frontend makes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--years", type=int, default=5)
    args = parser.parse_args()

    with TestClient(main.app) as client:
        password = __import__("config").get_settings().admin_password
        username = __import__("config").get_settings().admin_user
        tokens = client.post(
            "/api/login", json={"username": username, "password": password}
        ).json()
        headers = {"Authorization": f"Bearer {tokens['access_token']}"}

        started = time.perf_counter()
        rows, days = seed(args.years)
        print(
            f"seeded {rows:,} answers across {days:,} days "
            f"in {time.perf_counter() - started:.1f}s\n"
        )

        time_call(client, "GET /api/answers (everything)", "/api/answers", headers)
        time_call(
            client,
            "GET /api/answers (last 30 days)",
            f"/api/answers?from={date.today() - timedelta(days=30)}",
            headers,
        )
        time_call(client, "GET /api/stats/variables", "/api/stats/variables", headers)
        time_call(
            client, "GET /api/answers/export.xlsx", "/api/answers/export.xlsx", headers
        )


if __name__ == "__main__":
    main_()
