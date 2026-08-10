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

    prompt: Mapped[str] = mapped_column(String(500), nullable=False)
    """Question text shown to the user."""

    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Sort order within the catalogue."""

    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    """Whether the question still appears in the questionnaire."""

    system_key: Mapped[str | None] = mapped_column(String(32), nullable=True)
    """Identifier of an auto-tracked question, or null for an ordinary one."""

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

    @property
    def is_system(self) -> bool:
        """Report whether this question is one of the auto-tracked ones.

        Returns
        -------
        bool
            True when `system_key` is set.
        """
        return self.system_key is not None


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
