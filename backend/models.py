from datetime import date, datetime

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

    is_editor: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    """Whether the user may edit catalogues and questions. Grants nothing else."""

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

    default_catalogue: Mapped["Catalogue | None"] = relationship()
    """The catalogue referenced by `default_catalogue_id`."""

    answers: Mapped[list["Answer"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
    """Every answer this user has recorded. Deleted along with the user."""


class Catalogue(Base):
    """A named group of questions that users answer together."""

    __tablename__ = "catalogues"

    id: Mapped[int] = mapped_column(primary_key=True)
    """Surrogate primary key."""

    name: Mapped[str] = mapped_column(String(255), unique=True)
    """Unique display name."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    questions: Mapped[list["Question"]] = relationship(
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
        UniqueConstraint("catalogue_id", "system_key", name="uq_question_system_key"),
        CheckConstraint(
            "kind in ('enum', 'discrete', 'continuous')", name="ck_question_kind"
        ),
        CheckConstraint(
            "(kind = 'enum' and min_value is null and max_value is null)"
            " or (kind != 'enum' and min_value is not null and max_value is not null"
            "     and min_value < max_value)",
            name="ck_question_bounds",
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

    system_key: Mapped[str | None] = mapped_column(String(32), nullable=True)
    """Which auto-tracked variable this is, for questions of origin ``auto``."""

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

    catalogue: Mapped["Catalogue"] = relationship(back_populates="questions")
    """The catalogue this question belongs to."""

    options: Mapped[list["QuestionOption"]] = relationship(
        back_populates="question",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="QuestionOption.position",
    )
    """Choices for an enum question, in display order."""

    components: Mapped[list["ScoreComponent"]] = relationship(
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

    question: Mapped["Question"] = relationship(back_populates="options")
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

    score: Mapped["Question"] = relationship(
        back_populates="components", foreign_keys=[score_question_id]
    )
    """The score this component belongs to."""

    source: Mapped["Question"] = relationship(foreign_keys=[source_question_id])
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

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    """Timestamp set by the database when the row is inserted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    """Timestamp set on insert and refreshed on every update."""

    user: Mapped["User"] = relationship(back_populates="answers")
    """The user who gave this answer."""

    question: Mapped["Question"] = relationship()
    """The question this answer responds to."""

    option: Mapped["QuestionOption | None"] = relationship()
    """The option chosen, for enum questions."""
