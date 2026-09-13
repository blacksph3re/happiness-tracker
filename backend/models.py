from datetime import date, datetime, time
from typing import Literal
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base

PROMPT_MAX_LENGTH = 80
"""Longest a question may be.

Chosen from the layout rather than from a round number: at the narrowest
desktop width the questionnaire gives a prompt three lines, and 80 characters
fills them. Above 1024px the same text takes two. The heading reserves that
space, so no question makes the answer scale jump down the page.
"""

QuestionKind = Literal["enum", "discrete", "continuous"]
"""What a question's answers are shaped like.

An enum is a choice between options with no order between them; the other two
are points on a scale, whole steps or anywhere along it. The distinction decides
what may be scored, what may be a habit and what an answer row stores.
"""

QuestionOrigin = Literal["asked", "auto", "computed"]
"""Where a question's answers come from.

Replaces asking "is `system_key` set?" to mean "the user does not answer this".
That test had only two outcomes, so a third kind of question would have needed a
second, parallel notion of the same thing.
"""

ORIGIN_ASKED: QuestionOrigin = "asked"
"""A question the user answers."""

ORIGIN_AUTO: QuestionOrigin = "auto"
"""An auto-tracked question the server records for them."""

ORIGIN_COMPUTED: QuestionOrigin = "computed"
"""A score derived from other questions, computed when read and never stored."""

ScoreAggregate = Literal["sum", "mean"]
"""How a score combines the questions that feed it."""

AGGREGATES: tuple[ScoreAggregate, ...] = ("sum", "mean")
"""`ScoreAggregate` as data, for the check constraint and the service rules."""

SystemKey = Literal["weekday", "day_of_year", "month", "year", "first_answer_hour"]
"""Stable identifier of one of the five auto-tracked variables.

Described rather than stored: no question row carries these, so the key is the
only name they have. `services/clock.py` and `lib/day.js` both compute against
it, which is why the spelling is a type rather than a convention.
"""

SYSTEM_KEYS: tuple[SystemKey, ...] = (
    "weekday",
    "day_of_year",
    "month",
    "year",
    "first_answer_hour",
)
"""The five, in display order."""

HabitPeriod = Literal["day", "week", "month"]
"""The period a habit's target is measured over.

No quarter and no year: a habit nobody keeps more often than four times a year
is not one an app helps with, and every extra period is another column in the
streak grid that would draw two cells.
"""

HABIT_PERIODS: tuple[HabitPeriod, ...] = ("day", "week", "month")
"""`HabitPeriod` as data, for the check constraint and the service rules."""

HabitDirection = Literal["at_least", "at_most"]
"""Whether a habit's target is a floor to reach or a ceiling to stay under."""

HABIT_DIRECTIONS: tuple[HabitDirection, ...] = ("at_least", "at_most")
"""`HabitDirection` as data, for the check constraint and the service rules."""

ICON_MAX_LENGTH = 16
"""Longest an icon may be, in characters.

About four simple emoji or one many-codepoint one — a family or a profession is
a run of code points joined by zero-width joiners, and clipping one mid-sequence
would render as several unrelated people.
"""


class User(Base):
    """A person who records happiness entries."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    username: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    """Unique, indexed name the user logs in with."""

    password_hash: Mapped[str] = mapped_column(String(255))
    """Argon2 hash of the password. The plaintext is never stored or logged."""

    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Bumped whenever every outstanding token for this account must stop working.

    Tokens carry the value they were minted under, so changing a password
    immediately invalidates sessions elsewhere without a server-side session
    table to maintain.
    """

    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    """Whether the user may manage other users. Grants nothing else."""

    default_catalogue_id: Mapped[int | None] = mapped_column(
        ForeignKey("catalogues.id", ondelete="SET NULL"), nullable=True
    )
    """Catalogue presented to this user when answering."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    preferences: Mapped[str | None] = mapped_column(Text, nullable=True)
    """UI state as a JSON document, written and read only by the frontend.

    Deliberately opaque to the backend: the stats page owns its own shape, so
    adding a control there does not require a migration here.
    """

    totp_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    """Encrypted base32 shared secret, or None when enrolment has never begun.

    Encrypted rather than hashed, unlike a password: the server has to recover
    the plaintext to compute the code it expects. Long enough for a Fernet
    token, which is substantially larger than the secret it wraps.
    """

    totp_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When enrolment was completed by proving a code.

    Separate from `totp_secret` on purpose, and load-bearing: the secret is
    written the moment enrolment *starts*. If its presence gated login, someone
    who generated a QR code and closed the tab would be locked out of their own
    account. NULL means the secret exists but must not be demanded.
    """

    totp_last_step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """Highest time-step already spent, so a code cannot be replayed.

    A 30-second code stays valid for 30 seconds, and anyone who observes one
    can present it again inside that window. Recording the step it belongs to
    makes each code strictly single-use. State rather than a derivation, so the
    rule about computing on read does not apply.
    """

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """

    default_catalogue: Mapped[Catalogue | None] = relationship(
        foreign_keys=[default_catalogue_id]
    )
    """The catalogue referenced by `default_catalogue_id`.

    The foreign key is named explicitly because there are now two between these
    tables — this one, and `catalogues.user_id` pointing back — and SQLAlchemy
    cannot pick between them on its own.
    """

    answers: Mapped[list[Answer]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
    """Every answer this user has recorded. Deleted along with the user."""


class Catalogue(Base):
    """A named group of questions, belonging to the person who answers them."""

    __tablename__ = "catalogues"

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_catalogue_name_per_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Whose catalogue this is.

    Deliberately no ORM relationship in either direction. `users` and
    `catalogues` reference each other — this column one way,
    `users.default_catalogue_id` the other — and a pair of plain relationships
    over two foreign key paths is ambiguous to SQLAlchemy. The cascade is the
    database's job here, which it does without one.
    """

    name: Mapped[str] = mapped_column(String(255))
    """Display name, unique among that user's catalogues."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """

    questions: Mapped[list[Question]] = relationship(
        back_populates="catalogue",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Question.position, Question.id",
    )
    """Questions belonging to this catalogue, in display order.

    Ties on `position` fall back to insertion order, so a catalogue whose
    positions collide still renders the same way on every request.
    """


class Question(Base):
    """A single prompt answered on a scale, a range, or a set of options."""

    __tablename__ = "questions"
    __table_args__ = (
        CheckConstraint(
            "kind in ('enum', 'discrete', 'continuous')", name="ck_question_kind"
        ),
        CheckConstraint(
            "(kind = 'enum' and min_value is null and max_value is null)"
            " or (kind != 'enum' and min_value is not null and max_value is not null"
            "     and min_value < max_value)",
            name="ck_question_bounds",
        ),
        # The three habit columns describe one setting, so a row carrying some of
        # them describes half a habit — which reads as "not a habit" to
        # `is_habit` and as "a habit" to anything checking the target. The
        # service layer refuses the same shapes with a 422 naming the field; this
        # is the floor under a hand-written UPDATE.
        CheckConstraint(
            "(habit_period is null) = (habit_target is null)"
            " and (habit_period is null) = (habit_direction is null)",
            name="ck_question_habit_triple",
        ),
        CheckConstraint(
            "habit_period is null or kind = 'enum'",
            name="ck_question_habit_enum",
        ),
        CheckConstraint(
            "habit_period is null or habit_period in ('day', 'week', 'month')",
            name="ck_question_habit_period",
        ),
        CheckConstraint(
            "habit_direction is null or habit_direction in ('at_least', 'at_most')",
            name="ck_question_habit_direction",
        ),
        # Zero is meaningful and only under `at_most`: "no more than nothing" is
        # how a habit you are trying to stop is written.
        CheckConstraint(
            "habit_target is null or habit_target >= 0",
            name="ck_question_habit_target",
        ),
        Index("ix_questions_catalogue_active", "catalogue_id", "active"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    catalogue_id: Mapped[int] = mapped_column(
        ForeignKey("catalogues.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Owning catalogue. Never null, including for auto-tracked questions."""

    kind: Mapped[QuestionKind] = mapped_column(String(16), nullable=False)
    """What the answers to this question are shaped like."""

    prompt: Mapped[str] = mapped_column(String(PROMPT_MAX_LENGTH), nullable=False)
    """Question text shown to the user."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order within the catalogue."""

    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    """Whether the question still appears in the questionnaire."""

    origin: Mapped[QuestionOrigin] = mapped_column(
        String(16), default=ORIGIN_ASKED, server_default=ORIGIN_ASKED, nullable=False
    )
    """Where this question's answers come from."""

    aggregate: Mapped[ScoreAggregate | None] = mapped_column(String(8), nullable=True)
    """How the components combine, for questions of origin ``computed``."""

    require_all: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="1", nullable=False
    )
    """Whether a score needs every component answered before it has a value.

    A total over three of five answers is not that total, so by default a day
    missing any component scores nothing rather than understating.
    """

    min_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    """Lower bound for discrete and continuous questions."""

    max_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    """Upper bound for discrete and continuous questions."""

    min_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    """Description of the lower bound, such as ``"Low"``."""

    max_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    """Description of the upper bound, such as ``"High"``."""

    icon: Mapped[str | None] = mapped_column(String(ICON_MAX_LENGTH), nullable=True)
    """A short emoji shown where the question has to be compact.

    On every question rather than only on habits, and deliberately outside the
    habit constraints above: an icon is decoration, and tying it to habits would
    be a constraint to relax the first time an ordinary question wants one.

    Emoji rather than an icon set — no asset pipeline, no build step, it renders
    on every device, and any of them may be picked. Not validated as *being* an
    emoji: that is a grapheme-cluster problem with no good answer, and the field
    belongs to the person who typed it.
    """

    habit_period: Mapped[HabitPeriod | None] = mapped_column(String(8), nullable=True)
    """The period this habit's target is measured over, or NULL for a plain question.

    One nullable column doubling as the flag, the same shape as
    ``pomodoros.notified_at``: there is no ``is_habit`` that could disagree
    with it.
    """

    habit_target: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """How many days in a period must carry a counted answer.

    Zero is meaningful, and only under ``at_most``: "no more than nothing" is
    how a habit you are trying to stop is written.
    """

    habit_direction: Mapped[HabitDirection | None] = mapped_column(
        String(8), nullable=True
    )
    """Whether `habit_target` is a floor to reach or a ceiling to stay under."""

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """

    catalogue: Mapped[Catalogue] = relationship(back_populates="questions")
    """The catalogue this question belongs to."""

    options: Mapped[list[QuestionOption]] = relationship(
        back_populates="question",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="QuestionOption.position",
    )
    """Choices for an enum question, in display order."""

    components: Mapped[list[ScoreComponent]] = relationship(
        back_populates="score",
        foreign_keys="ScoreComponent.score_question_id",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """The questions feeding this score, for questions of origin ``computed``."""

    @property
    def is_system(self) -> bool:
        """Report whether the server records this question's answers.

        Returns
        -------
        bool
            True for the auto-tracked questions.
        """
        return self.origin == ORIGIN_AUTO

    @property
    def is_computed(self) -> bool:
        """Report whether this question is a score derived from others.

        Returns
        -------
        bool
            True for scores.
        """
        return self.origin == ORIGIN_COMPUTED

    @property
    def is_asked(self) -> bool:
        """Report whether the user answers this question themselves.

        Returns
        -------
        bool
            True for ordinary questions, and only those.
        """
        return self.origin == ORIGIN_ASKED

    @property
    def is_habit(self) -> bool:
        """Report whether this question carries a habit target.

        Returns
        -------
        bool
            True when `habit_period` is set, which the check constraint keeps in
            step with `habit_target` and `habit_direction`.
        """
        return self.habit_period is not None


class QuestionOption(Base):
    """One selectable choice of an enum question."""

    __tablename__ = "question_options"

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    question_id: Mapped[int] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Owning question."""

    label: Mapped[str] = mapped_column(String(255), nullable=False)
    """Text shown on the choice."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order within the question."""

    counts: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )
    """Whether choosing this option counts towards the owning habit's target.

    Not ``succeeds``, which is what this was nearly called. A habit runs in
    either direction, and the counted option is not always the happy one: a
    smoking habit counts *Yes*, and marking "Yes, I smoked" as succeeding reads
    backwards. ``counts`` is neutral about which side of the target the person
    is aiming for, which is the only word that stays true for both.

    Meaningless on a question that is not a habit, and left alone rather than
    cleared when one stops being one — unticking every box to turn a habit off
    and back on again would lose the answer to a question nobody asked.
    """

    question: Mapped[Question] = relationship(back_populates="options")
    """The question this option belongs to."""


class ScoreComponent(Base):
    """One question feeding one score, with the weight it carries."""

    __tablename__ = "score_components"
    __table_args__ = (
        UniqueConstraint(
            "score_question_id", "source_question_id", name="uq_score_component"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    score_question_id: Mapped[int] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The computed question this contributes to."""

    source_question_id: Mapped[int] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), nullable=False
    )
    """The question whose answer is taken."""

    weight: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    """Multiplier applied to the answer before combining."""

    score: Mapped[Question] = relationship(
        back_populates="components", foreign_keys=[score_question_id]
    )
    """The score this component belongs to."""

    source: Mapped[Question] = relationship(foreign_keys=[source_question_id])
    """The question this component reads."""


class Answer(Base):
    """One user's response to one question on one day."""

    __tablename__ = "answers"
    __table_args__ = (
        UniqueConstraint("user_id", "question_id", "day", name="uq_answer_per_day"),
        CheckConstraint(
            "(value is null) != (option_id is null)", name="ck_answer_one_value"
        ),
        Index("ix_answers_user_day", "user_id", "day"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    """The answering user."""

    question_id: Mapped[int] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The question answered."""

    day: Mapped[date] = mapped_column(Date, nullable=False)
    """Client-local calendar day the answer belongs to."""

    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    """Numeric response for discrete and continuous questions."""

    option_id: Mapped[int | None] = mapped_column(
        ForeignKey("question_options.id", ondelete="CASCADE"), nullable=True
    )
    """Chosen option for enum questions."""

    local_hour: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """Client-local hour at which this answer was given, 0-23.

    The whole of what `first_answer_hour` needs, and it belongs here rather than
    in an answer row of its own: the variable is `min(local_hour)` over the day,
    which is order-independent. The stored version took whichever write landed
    first, so a phone answering at 08:00 offline and syncing after a laptop that
    answered at 14:00 recorded 14.

    Null for rows written before the column existed, and for the backfilled ones
    it means the *day's* first hour rather than this row's. Invisible to the
    only reader, which takes the minimum either way.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    client_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the device recording this answer says it was given.

    Stamped at the moment of the tap rather than at the moment it reached the
    server, which is what lets a queued offline answer be ordered against one
    made later on another device. Null for rows written before offline support,
    and for any client that does not send one.
    """

    server_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the server accepted the write that last set this row.

    Kept beside `client_updated_at` so a device with a wrong clock leaves
    something reconstructable behind: the ordering used a claimed time, and this
    is the time it actually arrived.
    """

    user: Mapped[User] = relationship(back_populates="answers")
    """The user who gave this answer."""

    question: Mapped[Question] = relationship()
    """The question this answer responds to."""

    option: Mapped[QuestionOption | None] = relationship()
    """The option chosen, for enum questions."""


# ---------------------------------------------------------------------------
# Time tracking. Projects and sessions are independent of the questionnaire
# above: nothing here references a question, and nothing above references a
# project. They share only the user and the local-day convention.
# ---------------------------------------------------------------------------

TRACK_NAME_MAX_LENGTH = 80
"""Longest a project or tag name may be, matching the question prompt cap."""

EntrySource = Literal["pomodoro"]
"""Where a session came from, when it was not tracked directly.

One member today, and written as a set anyway: the point of the column is that
there could be another, and a reader wanting to know what may appear in it
should not have to grep for every write.
"""


class Project(Base):
    """Something a user tracks time against. A "timeline" in the iOS app."""

    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_project_name_per_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The owner. Projects are personal; sharing is not modelled yet."""

    name: Mapped[str] = mapped_column(String(TRACK_NAME_MAX_LENGTH), nullable=False)
    """Display name, unique among that user's projects."""

    colour: Mapped[str] = mapped_column(String(16), nullable=False)
    """Palette token, stored rather than assigned, so reordering projects does
    not shift what colour a project has had throughout its history."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order in the track view."""

    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    """Whether the project is still offered for check-in. An archived project
    keeps every session it already holds."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """

    user: Mapped[User] = relationship()
    """The owner."""

    tags: Mapped[list[Tag]] = relationship(
        secondary="project_tags", back_populates="projects"
    )
    """Labels covering this project. Several are allowed."""


class Tag(Base):
    """A label over projects, so totals can be read by group."""

    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_tag_name_per_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The owner, as for projects."""

    name: Mapped[str] = mapped_column(String(TRACK_NAME_MAX_LENGTH), nullable=False)
    """Display name, unique among that user's tags."""

    colour: Mapped[str] = mapped_column(String(16), nullable=False)
    """Palette token, as for projects."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order in the tag grouping."""

    add_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """Minutes added to every day this tag tracked anything, or None for no addition.

    The other half of the tag's rule, and deliberately not a `DeductionBand`:
    bands only ever subtract, they *replace* each other rather than stacking, and
    the addition has to land before them — none of which a row in that table can
    express.

    Nullable with no default so the migration adding it is an in-place
    ``ADD COLUMN``. Zero is normalised to NULL on write, so a rule that adds
    nothing has one spelling rather than two.
    """

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """

    projects: Mapped[list[Project]] = relationship(
        secondary="project_tags", back_populates="tags"
    )
    """Projects this tag covers."""

    bands: Mapped[list[DeductionBand]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True
    )
    """The rule turning this tag's tracked time into reported time."""


class ProjectTag(Base):
    """Which projects a tag covers.

    A plain join table: no session ever references a tag, so re-tagging a
    project regroups its whole history. That is what makes a tag a view of the
    time rather than a second record of it.
    """

    __tablename__ = "project_tags"
    __table_args__ = (UniqueConstraint("project_id", "tag_id", name="uq_project_tag"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The tagged project."""

    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The tag applied."""


class DeductionBand(Base):
    """One step of a tag's rule for turning tracked time into reported time.

    The rule lives on a tag rather than on the account: "work days lose a lunch
    break" is a statement about work, and a day of reading owes nobody one.
    """

    __tablename__ = "deduction_bands"
    __table_args__ = (
        UniqueConstraint("tag_id", "from_minutes", name="uq_band_threshold"),
        CheckConstraint("from_minutes >= 0", name="ck_band_threshold_positive"),
        CheckConstraint(
            "deduct_minutes is null or deduct_minutes >= 0",
            name="ck_band_deduction_positive",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The tag this band belongs to. Deleting the tag deletes its rule."""

    from_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    """Tracked minutes at which this band starts applying."""

    deduct_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """Minutes it removes from the day, or None to cap the day at the threshold.

    A cap is the open-ended case of a deduction: it takes off however much the
    day ran past `from_minutes`, so the day reports the threshold and no more.
    """

    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )
    """When this row was last written, or NULL if not since it was added.

    Carried so that `/api/changes` can tell an edit in place from no change at
    all: a row count sees rows arriving and leaving, and nothing else.

    Nullable, and with no ``server_default``, entirely so that adding it is a
    migration SQLite can do **in place**. A ``NOT NULL DEFAULT
    (CURRENT_TIMESTAMP)`` cannot be added to an existing table — SQLite requires
    a constant default — so Alembic falls back to rebuilding the table: copy,
    ``DROP``, rename, which is the operation that has emptied tables in this
    database before. Rows written before the column existed simply read NULL,
    which the digest already treats as "compare on the count alone", and the
    first edit to any of them fills it in.
    """


class TimeEntry(Base):
    """One check-in and the check-out that ended it."""

    __tablename__ = "time_entries"
    __table_args__ = (
        CheckConstraint(
            "ended_at is null or ended_at > started_at",
            name="ck_entry_ends_after_start",
        ),
        # At most one *running* session per project. Several projects may run at
        # once - that is the point - but checking into one twice would produce
        # two rows no interface could tell apart. Partial indexes are the one
        # way to say "unique among the open ones", and SQLite supports them.
        Index(
            "uq_open_entry_per_project",
            "user_id",
            "project_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
        ),
        Index("ix_time_entries_user_started", "user_id", "started_at"),
        # A device's own id for a session is unique to that device's owner, so
        # replaying the same intent twice updates one row instead of making two.
        Index(
            "uq_entry_client_id",
            "user_id",
            "client_id",
            unique=True,
            sqlite_where=text("client_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    """Whose session this is."""

    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    """What was being worked on. Restricted rather than cascading: deleting a
    project must not silently delete the hours spent on it."""

    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    """When the session began, in UTC."""

    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When it ended, in UTC. Null while the timer is still running."""

    utc_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    """Minutes east of UTC at check-in.

    What makes local midnight knowable on the server, and so what lets a
    session be divided across the days it touches. Kept beside the instants
    rather than replacing them, because a duration computed from local wall
    times is wrong by an hour across a daylight-saving change.
    """

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Optional free text about the session."""

    source: Mapped[EntrySource | None] = mapped_column(String(16), nullable=True)
    """Where this session came from, when it was not tracked directly.

    Only `pomodoro` so far, set by the focus half's transfer. A plain column
    rather than a foreign key: "this arrived from somewhere else" is a fact
    about the session, and a real reference would point the time half at the
    focus half — and would then have to survive the pomodoro being deleted,
    which it is free to be.

    Nullable with no server default, so the migration adding it is one SQLite
    performs in place. See `Project.updated_at` for why that matters.
    """

    client_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, default=lambda: str(uuid4())
    )
    """The identity a device gives a session before the server has one.

    Defaulted rather than required, so a session created through any other
    endpoint gets one too: the client keys its rows by this, and a session it
    could not name would be one it could never correct offline.

    A session recorded with no connection has no primary key until it syncs, and
    it may be corrected or deleted several times before it ever does. This is
    what those later intents refer to, what makes replaying one twice a no-op,
    and what lets an edit re-create a row deleted on another device — the
    identity outlives the row.
    """

    client_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the device says this session was last changed. See `Answer`."""

    server_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the server accepted the write that last set this row."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    project: Mapped[Project] = relationship()
    """The project this session counts towards."""


# ---------------------------------------------------------------------------
# Focus. A pomodoro references neither a project nor a question, and neither of
# those halves references a pomodoro. Time reaches the tracker only as a copy,
# when somebody presses the transfer button, which is why there is no foreign
# key in either direction.
#
# There is exactly **one** reference out of this section, and it points at the
# todos below: `pomodoros.todo_id`. It exists because a running pomodoro sets
# its task active, which requires the pomodoro to name a task — and because the
# focus history then reads the *current* title through the link, so renaming a
# task retitles the hours spent on it. That is the whole meaning of the todo
# field's ownership moving to the todo half. `task` stays beside it for the
# years of pomodoros that have no link, and exactly one of the two is ever read
# for a given row.
# ---------------------------------------------------------------------------


PomodoroState = Literal["running", "abandoned", "complete"]
"""Which of the three outcomes a pomodoro is in.

Derived on read from `ended_at`, the planned end and the two phase lengths, and
deliberately not a column: a stored outcome is one an edit could contradict.
Named here rather than beside the rules in `services/pomodoro.py` because
`schemas.py` sends it to the client and `services` imports `schemas`, so the
other direction would be a cycle.
"""


class Pomodoro(Base):
    """One focus block and the break that follows it."""

    __tablename__ = "pomodoros"
    __table_args__ = (
        CheckConstraint(
            "ended_at is null or ended_at > started_at",
            name="ck_pomodoro_ends_after_start",
        ),
        CheckConstraint("focus_seconds > 0", name="ck_pomodoro_has_focus"),
        CheckConstraint("break_seconds >= 0", name="ck_pomodoro_break_not_negative"),
        Index("ix_pomodoros_user_started", "user_id", "started_at"),
        # As for sessions: a device's own id is unique to its owner, so
        # replaying the same intent twice updates one row instead of making two.
        Index(
            "uq_pomodoro_client_id",
            "user_id",
            "client_id",
            unique=True,
            sqlite_where=text("client_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Whose pomodoro this is."""

    task: Mapped[str | None] = mapped_column(Text, nullable=True)
    """What the focus was for, if anything was typed.

    Optional on purpose: an unnamed pomodoro is a real pomodoro, and requiring a
    description would turn a timer into a form. Editable afterwards, because
    discovering a minute in that you are really doing something else is the
    ordinary case rather than the exception.
    """

    todo_id: Mapped[int | None] = mapped_column(
        ForeignKey("todos.id", ondelete="SET NULL"), nullable=True, index=True
    )
    """The task this focus was for, or NULL when the timer was never linked.

    The one reference that leaves this section; the comment above it says why
    it exists. ``SET NULL`` rather than a cascade: deleting a task must not
    delete the hours spent on it, and a pomodoro that has lost its task falls
    back to `task`, which is the other half of why that column stays.

    Nullable with no server default, so the migration adding it is one SQLite
    performs **in place**. See `Project.updated_at` for why that matters.
    """

    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    """When the focus began, in UTC."""

    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When something stopped it early, in UTC, or NULL if nothing did.

    **Not** "null while running". A pomodoro declares its own end when it
    starts, so one that ran as declared needs nothing written to finish it: the
    end is `started_at` plus both phases, computed on read. This column is
    written only by an explicit stop — abandoning during the focus, or the next
    pomodoro beginning during the break.

    That is what lets a pomodoro complete while the app was closed, with no
    timer and no background task, and it is why there is no stored outcome
    beside it that an edit could leave disagreeing.
    """

    utc_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    """Minutes east of UTC when it started, as a session records."""

    focus_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    """Length of the focus phase, as configured at the time."""

    break_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    """Length of the break phase, as configured at the time.

    Stored rather than read back from the account's current setting, and the one
    deliberate exception here to computing on read: changing the mode from 25/5
    to 50/10 is not a claim about yesterday.
    """

    tainted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    """Whether the focus was marked unsuccessful.

    Stored rather than derived, because it is a judgement: nothing in the
    timestamps knows the time went on social media. It changes no total — time
    spent is time spent — and exists only to be shown.
    """

    notified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the end of this pomodoro's focus was announced, or NULL if never.

    The whole of the scheduler's state. A generic `scheduled_pushes` table was
    the obvious design and is one table too many: a pomodoro already records
    when it starts and how long its focus runs, so *when to send* is derivable
    and only *whether it was sent* has to be written down.

    It is also the claim. Marking the row `WHERE notified_at IS NULL` and
    sending only when that update touched something is what stops two workers,
    or a restart mid-send, announcing one boundary twice.
    """

    transferred_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When this pomodoro's time was copied to a project, or NULL if never.

    What stops the transfer button offering the same hour twice. The session it
    produced is a copy and not a link: editing this row afterwards does not
    reach it, which is the whole of why there is no synchronisation to keep.
    """

    client_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, default=lambda: str(uuid4())
    )
    """The identity a device gives a pomodoro before the server has one.

    See `TimeEntry.client_id`: the identity outlives the row, which is what lets
    an edit made offline find what it meant.
    """

    client_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the device says this pomodoro was last changed. See `Answer`."""

    server_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the server accepted the write that last set this row."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    todo: Mapped[Todo | None] = relationship(lazy="selectin")
    """The task this focus was for, loaded with the pomodoro.

    ``selectin`` rather than lazy, because every pomodoro read reports the
    task's client identity beside the server id: lazy loading would be one
    query per pomodoro in a list of a hundred.
    """


# ---------------------------------------------------------------------------
# Todos. Four tables, and the shape follows the *answer* side of the
# days-and-instants rule rather than the session side: a plan is a local date,
# not an instant. "Feed the cat tomorrow at nine" means nine o'clock wherever
# you are, so `planned_on` is a DATE and `planned_at` a TIME with no
# `utc_offset` beside them, exactly as an answer carries a client-local `day`.
# Only the columns recording something that *happened* — done, archived,
# activated — are UTC instants.
#
# Nothing here references a project or a question either. The one link between
# this section and another is `pomodoros.todo_id`, declared above and explained
# there.
#
# This is also the one section where a row is not reached through its
# `user_id`. A list has an owner and any number of **members**, so a task
# belongs to the list it is in rather than to whoever typed it: every read and
# every intent resolves through `visible_list_ids`, and `todos.user_id` records
# only who created the row. `todo_list_members` is what that set is built from.
# ---------------------------------------------------------------------------

TodoPriority = Literal["very_high", "high", "medium", "low", "very_low"]
"""How a task ranks against the others.

Ordered highest first, and the order is the metric: ``PRIORITIES.index`` is
what "one step less important" means, which is what the Eisenhower drop needs
to move a task to the nearest legal value rather than to a fixed one.
"""

PRIORITIES: tuple[TodoPriority, ...] = (
    "very_high",
    "high",
    "medium",
    "low",
    "very_low",
)
"""`TodoPriority` as data, for the check constraint and the service rules."""

ListKind = Literal["ordinary", "inbox", "archive"]
"""Which of the three a list is.

A `Literal` rather than two booleans, and never matched on the *name*: the two
special lists are ordinary rows that can be renamed, so any code reading
``name == "Archive"`` is a bug waiting for somebody to rename it.
"""

LIST_KINDS: tuple[ListKind, ...] = ("ordinary", "inbox", "archive")
"""`ListKind` as data, for the check constraint and the service rules."""

LIST_NAME_MAX_LENGTH = 60
"""Longest a list name may be. Shorter than a project's, because a list name is
drawn as a column heading rather than as a row."""

TODO_TITLE_MAX_LENGTH = 200
"""Longest a task or step title may be.

Longer than a question prompt, which is capped by the layout it has to fit:
a task title wraps onto as many lines as it needs on a card.
"""

RANK_MAX_LENGTH = 255
"""Longest an ordering key may be.

Generous on purpose. `between` is total — there is always another key between
two neighbours — so the only bad outcome is keys that keep getting longer, and
the answer to that is the rebalance a drag performs on its own column rather
than a limit the function has to consult.
"""


class TodoList(Base):
    """A column of tasks: one of the two system lists, or one the owner made."""

    __tablename__ = "todo_lists"
    __table_args__ = (
        CheckConstraint(
            "kind in ('ordinary', 'inbox', 'archive')", name="ck_list_kind"
        ),
        # At most one inbox and one archive per account, and no ceiling on
        # ordinary lists. This is also what makes `ensure_system_lists`
        # idempotent rather than merely careful: a second attempt cannot
        # produce a second inbox, which holds even for a call site added later
        # by somebody who never read the helper.
        Index(
            "uq_list_kind",
            "user_id",
            "kind",
            unique=True,
            sqlite_where=text("kind != 'ordinary'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The owner. Everything in this database belongs to somebody.

    The owner alone renames, recolours, shares and deletes the list, and is
    **never** a `TodoListMember` row — so "owner or member" is one ``OR`` and
    there is no row saying somebody shares a list with themselves.
    """

    name: Mapped[str] = mapped_column(String(LIST_NAME_MAX_LENGTH), nullable=False)
    """Display name, deliberately **not** unique: two lists called *Home* are
    the owner's business, and the code never looks a list up by name."""

    kind: Mapped[ListKind] = mapped_column(String(8), nullable=False)
    """Which of the three this is. What the code branches on, always.

    The annotation is a `Literal` and the column type is spelled out beside it,
    because SQLAlchemy infers ``String`` from ``Mapped[str]`` and infers nothing
    at all from ``Mapped[Literal[...]]``.
    """

    colour: Mapped[str] = mapped_column(String(16), nullable=False)
    """A chip palette token, stored rather than assigned — as a project's is, and
    for the same reason: reordering must not change what colour a list has."""

    rank: Mapped[str] = mapped_column(String(RANK_MAX_LENGTH), nullable=False)
    """Column order in the move-between-lists view. See `RANK_MAX_LENGTH`."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update.

    What lets a list renamed on one device reach another: a rename moves no
    count, so the digest would otherwise not see it at all.
    """

    todos: Mapped[list[Todo]] = relationship(
        back_populates="todo_list", cascade="all, delete-orphan"
    )
    """The tasks in this list. Deleting a list takes them, and their steps.

    Lazy on purpose: the read endpoints go the other way, from tasks to their
    list, and the only caller that wants this collection is the delete.
    """

    owner: Mapped[User] = relationship(foreign_keys=[user_id])
    """The account the list belongs to, for the *shared by* line.

    Lazy, and eager-loaded by the one read that wants it — `lists_for` asks for
    it explicitly, because the authorization resolvers load a list per intent
    and have no use for the username.
    """

    members: Mapped[list[TodoListMember]] = relationship(
        back_populates="todo_list",
        cascade="all, delete-orphan",
        order_by="TodoListMember.id",
    )
    """Who else can see this list. Deleting the list takes the rows with it.

    Lazy for the same reason `owner` is. `lists_for` loads it with one extra
    statement for all the lists at once rather than one per list.
    """


class Todo(Base):
    """One task: a title, a list and a planned date, with the rest optional."""

    __tablename__ = "todos"
    __table_args__ = (
        CheckConstraint(
            "priority is null or priority in"
            " ('very_high', 'high', 'medium', 'low', 'very_low')",
            name="ck_todo_priority",
        ),
        CheckConstraint(
            "duration_minutes is null or duration_minutes >= 0",
            name="ck_todo_duration_not_negative",
        ),
        CheckConstraint("active_seconds >= 0", name="ck_todo_active_not_negative"),
        # Unique on `client_id` **alone**, not per user as a session's and a
        # pomodoro's are. A task in a shared list is edited by every member, and
        # keyed per user each of them would look it up under their own id, find
        # nothing, and insert a second row — two cards for one task on
        # everybody's board. The ids are UUIDs, so a global unique costs
        # existing rows nothing.
        #
        # `todo_steps.client_id` stays unique per `todo_id` and needs no such
        # change: a step's scope is its parent, every member resolves the same
        # parent row, and the wire names the parent anyway.
        Index(
            "uq_todo_client_id",
            "client_id",
            unique=True,
            sqlite_where=text("client_id IS NOT NULL"),
        ),
        Index("ix_todos_user_planned", "user_id", "planned_on"),
        # The archive is read newest-arrival-first within one list, which is the
        # one query here with an order the caller cannot narrow.
        Index("ix_todos_list_archived", "list_id", "archived_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Who **created** the task, which is not who it belongs to.

    A task belongs to the list it is in: every member of a shared list may edit
    it, tick it, move it and delete it, so authorization is
    ``list_id in visible_list_ids(caller)`` and never a comparison against this
    column. It is kept because *who typed this* is a fact worth having — and
    because a member's cleanup writes rows into the owner's archive, where the
    creator is the one piece of provenance left.

    The column keeps its name: renaming one is a table rebuild for the sake of
    a word.
    """

    list_id: Mapped[int] = mapped_column(
        ForeignKey("todo_lists.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Which list the task is in. Never null: every task is in a real list, the
    inbox included, which is what makes *archived* a list rather than a flag."""

    client_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, default=lambda: str(uuid4())
    )
    """The identity a device gives a task before the server has one.

    See `TimeEntry.client_id`: the identity outlives the row, which is what
    lets an edit made offline find what it meant — and what a step names its
    parent by, since a task created in the modal may have no server id yet.
    """

    title: Mapped[str] = mapped_column(String(TODO_TITLE_MAX_LENGTH), nullable=False)
    """What to do. One of the two mandatory fields."""

    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Longer notes, in Markdown. Rendered through a sanitiser on the client."""

    planned_on: Mapped[date] = mapped_column(Date, nullable=False)
    """The local day the task is planned for. The other mandatory field.

    A date rather than an instant, and with no offset beside it: a plan means
    that day wherever you are, exactly as an answer's `day` does.
    """

    planned_at: Mapped[time | None] = mapped_column(Time, nullable=True)
    """Wall clock time on that day, or NULL for no particular time.

    NULL is what puts a task in the calendar's *anytime* row, so it is a
    meaningful value rather than missing data.
    """

    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    """When it has to be done by. Feeds the Eisenhower urgency axis and nothing
    else, which is why it is optional where `planned_on` is not."""

    priority: Mapped[TodoPriority | None] = mapped_column(String(9), nullable=True)
    """How it ranks against the others, or NULL.

    NULL is *not important* by definition rather than by omission: the
    Eisenhower split reads it that way, so there is no third state.
    """

    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """How long it is expected to take. An estimate, never a measurement — the
    measurement is `active_seconds` below, and the two are different facts."""

    icon: Mapped[str | None] = mapped_column(String(ICON_MAX_LENGTH), nullable=True)
    """An emoji drawn in place of the tickbox, or NULL for the tickbox.

    Bounded by length alone, as a question's icon is: an icon from a later
    curated set must not start answering 422.
    """

    colour: Mapped[str | None] = mapped_column(String(16), nullable=True)
    """A chip palette token painting the card's background, or NULL.

    NULL means *take the list's colour*, which is what the client already
    draws for every task today — so the column is an override rather than the
    first answer, and there is no default for a migration to invent.

    Bounded by `schemas.COLOUR_PATTERN` rather than by the six tokens the
    picker offers, as a project's and a list's colour are, and for the same
    reason: the palette gains tokens, and one chosen in a later release must
    not start answering 422 against a server that has not been redeployed.
    """

    rank: Mapped[str] = mapped_column(String(RANK_MAX_LENGTH), nullable=False)
    """Order within its column, in whichever grouping is in force.

    One key rather than one per grouping, deliberately: a drag places a task
    where it was dropped, and a task has one position that every view reads.
    """

    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When it was ticked, in UTC, or NULL while it is not.

    There is no `is_done`: one fact, one place. A task in the archive with this
    null is *won't do*; with it set, it is cleaned up.
    """

    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """**When** the task last entered the archive, in UTC.

    Never *whether* it is archived — that is ``list_id == the archive list``,
    and a column saying otherwise could disagree with the list the row is
    actually in. This one has a narrower job: it is set when a task enters the
    archive, cleared when it leaves, and read only for rows already known to be
    in one, because the archive is ordered by arrival and nothing else supplies
    that date. `updated_at` would reorder the archive whenever an archived task
    was edited, and `done_at` is absent on everything marked *won't do*.

    The server fills it and clears it rather than trusting what arrives, so the
    timestamp stays honest whatever version of the client sent the row.
    """

    active_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the current activation began, in UTC, or NULL when not active.

    Non-NULL **is** the active state; there is no `is_active`.
    """

    active_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Time banked from activations that have ended.

    The one place this design steps away from computing on read, and knowingly:
    the pure version is an activations table shaped like `TimeEntry`, summed on
    read. Two columns were chosen to start with, so this is the primary record
    of past activations rather than a derivation of one — the way
    `Pomodoro.focus_seconds` already is. The upgrade path stays clean, because
    a table would be additive and this becomes its opening balance.
    """

    client_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the device says this task was last changed. See `Answer`."""

    server_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the server accepted the write that last set this row."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    steps: Mapped[list[TodoStep]] = relationship(
        back_populates="todo",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="[TodoStep.rank, TodoStep.client_id]",
    )
    """The subtasks, in order.

    ``selectin`` rather than lazy, because steps come back nested inside their
    task in every read: loading them per task is an N+1 of exactly the kind
    `Variable.component_ids` already had to be warned about. Ordered by
    ``(rank, client_id)``, which is also how `between` breaks a tie — two
    devices inserting offline into the same gap can produce one key twice, and
    the identity is what settles it.
    """

    todo_list: Mapped[TodoList] = relationship(back_populates="todos")
    """The list the task is in. Named `todo_list` because `list` is a builtin."""


class TodoStep(Base):
    """One subtask: a title, a tick, an icon and a position, and nothing else.

    Its own table rather than a self-reference on `Todo`, and that is the whole
    design: *one level deep* stops being a rule nothing can enforce and becomes
    a fact about the schema, no query in the feature carries
    ``parent_id IS NULL``, and a step has no column that means nothing. A step
    is four fields because a step is four fields.
    """

    __tablename__ = "todo_steps"
    __table_args__ = (
        # Unique per **parent**, not per user. Ownership here is reached through
        # the task, as a `DeductionBand`'s is through its tag, and there is no
        # `user_id` to scope against without denormalising one. The wire names a
        # step's parent anyway — `step.upsert` carries `todo_client_id` — so the
        # pair is what an upsert resolves against, and a `step.delete` naming
        # only its own id finds the row by joining its parent's visibility.
        #
        # Sharing left this alone, deliberately, where `todos.client_id` had to
        # become globally unique: the parent **is** the scope, and two members
        # editing one step both resolve the same `todo_id`. Nothing here was
        # ever keyed on who was looking.
        Index(
            "uq_step_client_id",
            "todo_id",
            "client_id",
            unique=True,
            sqlite_where=text("client_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    todo_id: Mapped[int] = mapped_column(
        ForeignKey("todos.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The task this step belongs to, which is also how its owner is reached."""

    client_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, default=lambda: str(uuid4())
    )
    """The step's own identity, so ticking one is a single intent rather than a
    rewrite of its parent."""

    title: Mapped[str] = mapped_column(String(TODO_TITLE_MAX_LENGTH), nullable=False)
    """What the step is."""

    icon: Mapped[str | None] = mapped_column(String(ICON_MAX_LENGTH), nullable=True)
    """An emoji drawn in place of the tickbox, as on a task."""

    rank: Mapped[str] = mapped_column(String(RANK_MAX_LENGTH), nullable=False)
    """Order within its task. The same helper a task's rank comes from: a task
    has few steps and integers would do, but two ordering implementations is
    one more than this feature needs."""

    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the step was ticked, in UTC, or NULL while it is not.

    Ticking every step does **not** tick the task: there is no roll-up, only a
    counter on the card.
    """

    client_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the device says this step was last changed. See `Answer`."""

    server_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    """When the server accepted the write that last set this row."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    todo: Mapped[Todo] = relationship(back_populates="steps")
    """The task this step sits on."""


class TodoListMember(Base):
    """One account a list has been shared with.

    A member sees the list and every task in it, and can add, edit, tick, drag
    and delete tasks, and leave. The owner alone renames, recolours, shares and
    deletes the list — and the owner is `TodoList.user_id` rather than a row
    here, so "owner or member" is one ``OR``.

    Only ordinary lists are shareable. The partial unique on
    ``(user_id, kind)`` already says every account has exactly one inbox, and
    sharing one would make a member's parsed ``#inbox`` ambiguous.
    """

    __tablename__ = "todo_list_members"
    __table_args__ = (
        # One row per person per list. The idempotent POST reads through this
        # rather than merely trusting its own lookup: sharing twice is a thing
        # two devices can do at once.
        UniqueConstraint("list_id", "user_id", name="uq_list_member"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    list_id: Mapped[int] = mapped_column(
        ForeignKey("todo_lists.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """The list being shared. Deleting the list takes this row with it."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    """Who it is shared with. Never the list's own owner."""

    added_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    """Who shared it, for the *shared by* line, or NULL once that account is gone.

    ``SET NULL`` rather than a cascade, because losing the person who shared a
    list must not silently revoke everybody's access to it. Today that is
    belt-and-braces and honestly unreachable: only an owner can share, so this
    is always `TodoList.user_id`, and deleting that account takes the list and
    every membership of it with them. It is a cascade waiting to be wrong the
    first time somebody may hand a list on — which is when this column stops
    restating the owner and starts saying something.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    user: Mapped[User] = relationship(foreign_keys=[user_id])
    """The member's account, read for their username."""

    sharer: Mapped[User | None] = relationship(foreign_keys=[added_by])
    """The account that shared the list, or None once it is gone."""

    todo_list: Mapped[TodoList] = relationship(back_populates="members")
    """The list this membership is of. Named as `Todo.todo_list` is."""


class PushSubscription(Base):
    """One browser's standing permission to be sent a notification."""

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        # The endpoint *is* the identity: the push service mints one per
        # browser per registration, and re-subscribing the same browser returns
        # the same URL. Unique globally rather than per user, because two
        # accounts claiming one endpoint would mean one of them is stale and
        # sending to it would deliver somebody else's notification.
        UniqueConstraint("endpoint", name="uq_push_endpoint"),
        Index("ix_push_subscriptions_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    """Whose device this is. Deleted with the account."""

    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    """Where the push service takes messages for this browser.

    A URL and nothing more — which is what makes the whole thing testable
    without an account anywhere: point it at a local mock and the encryption and
    signing happen exactly as they would against Apple or Google.
    """

    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    """The browser's public key, base64url. Half of what encrypts a payload."""

    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    """The browser's auth secret, base64url. The other half."""

    label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    """What to call this device in a list. Best-effort, from the user agent."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Refreshed every time the browser re-registers.

    Load-bearing rather than bookkeeping. A subscription is supposed to be
    pruned when the push service answers `410 Gone`, but Apple has been
    reported to answer `201` for one it has already replaced — so dead
    endpoints accumulate looking healthy. The client re-registers on every
    launch, which moves this; anything that has not moved in months is a device
    that is not coming back.
    """
