from datetime import date, datetime
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

ORIGIN_ASKED = "asked"
"""A question the user answers."""

ORIGIN_AUTO = "auto"
"""An auto-tracked question the server records for them."""

ORIGIN_COMPUTED = "computed"
"""A score derived from other questions, computed when read and never stored."""

ORIGINS = (ORIGIN_ASKED, ORIGIN_AUTO, ORIGIN_COMPUTED)
"""Where a question's answers come from.

Replaces asking "is `system_key` set?" to mean "the user does not answer this".
That test had only two outcomes, so a third kind of question would have needed a
second, parallel notion of the same thing.
"""

AGGREGATES = ("sum", "mean")
"""How a score combines the questions that feed it."""

SYSTEM_KEYS = ("weekday", "day_of_year", "month", "year", "first_answer_hour")
"""Stable identifiers of the five auto-tracked questions, in display order."""

HabitPeriod = Literal["day", "week", "month"]
"""The period a habit's target is measured over.

No quarter and no year: a habit nobody keeps more often than four times a year
is not one an app helps with, and every extra period is another column in the
streak grid that would draw two cells.
"""

HABIT_PERIODS: tuple[str, ...] = ("day", "week", "month")
"""`HabitPeriod` as data, for the check constraint and the service rules."""

HabitDirection = Literal["at_least", "at_most"]
"""Whether a habit's target is a floor to reach or a ceiling to stay under."""

HABIT_DIRECTIONS: tuple[str, ...] = ("at_least", "at_most")
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

    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    """One of ``enum``, ``discrete`` or ``continuous``."""

    prompt: Mapped[str] = mapped_column(String(PROMPT_MAX_LENGTH), nullable=False)
    """Question text shown to the user."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order within the catalogue."""

    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    """Whether the question still appears in the questionnaire."""

    origin: Mapped[str] = mapped_column(
        String(16), default=ORIGIN_ASKED, server_default=ORIGIN_ASKED, nullable=False
    )
    """One of ``asked``, ``auto`` or ``computed``."""

    aggregate: Mapped[str | None] = mapped_column(String(8), nullable=True)
    """``sum`` or ``mean``, for questions of origin ``computed``."""

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

    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
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
# Focus. Pomodoros are independent of both halves above: nothing here
# references a project or a question, and nothing above references a pomodoro.
# Time reaches the tracker only as a copy, when somebody presses the transfer
# button, which is why there is no foreign key in either direction.
# ---------------------------------------------------------------------------


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
