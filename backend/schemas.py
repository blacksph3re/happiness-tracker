from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from config import get_settings


class Version(BaseModel):
    """Build information served by the public version endpoint."""

    version: str
    """Application version string."""


class LoginRequest(BaseModel):
    """Credentials submitted to the login endpoint."""

    username: str = Field(min_length=1, max_length=255)
    """The account name."""

    password: str = Field(min_length=1)
    """The plaintext password. Excluded from logs and never echoed back."""


class RefreshRequest(BaseModel):
    """A refresh token exchanged for a new access token."""

    refresh_token: str
    """The token issued alongside the access token at login."""


class TokenPair(BaseModel):
    """Tokens handed out on a successful login."""

    access_token: str
    """Bearer token presented on subsequent requests."""

    refresh_token: str
    """Token accepted only by the refresh endpoint."""

    token_type: str
    """Always ``bearer``."""

    expires_in: int
    """Seconds until `access_token` expires."""


class AccessToken(BaseModel):
    """A newly minted access token returned by the refresh endpoint."""

    access_token: str
    """Bearer token presented on subsequent requests."""

    token_type: str
    """Always ``bearer``."""

    expires_in: int
    """Seconds until `access_token` expires."""


class UserOut(BaseModel):
    """A user account as exposed by the API. Carries no password material."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    username: str
    """The account name."""

    is_admin: bool
    """Whether the user may manage other users."""

    is_editor: bool
    """Whether the user may edit catalogues and questions."""

    default_catalogue_id: int | None
    """Catalogue presented to this user when answering."""


class MeOut(UserOut):
    """The signed-in account, plus the rules its own forms have to obey.

    Kept separate from `UserOut` so that a password policy does not appear on
    every row of the user listing, where it would read as a per-user setting.
    """

    password_min_length: int
    """Shortest password the server will accept, so forms can say so up front."""


def _password_field() -> Field:
    """Build the shared password field with the configured minimum length.

    Returns
    -------
    pydantic.fields.FieldInfo
        A constrained string field honouring ``PASSWORD_MIN_LENGTH``.
    """
    return Field(min_length=get_settings().password_min_length, max_length=1024)


class UserCreate(BaseModel):
    """Payload for creating a user, admin only."""

    username: str = Field(min_length=1, max_length=255)
    """The account name. Must be unique."""

    password: str = _password_field()
    """Initial plaintext password."""

    is_admin: bool = False
    """Whether the new user may manage other users."""

    is_editor: bool = False
    """Whether the new user may edit catalogues and questions."""

    default_catalogue_id: int | None = None
    """Catalogue the new user answers by default."""


class UserUpdate(BaseModel):
    """Payload for changing another user's flags or default catalogue."""

    is_admin: bool | None = None
    """New value for the user-management flag, when given."""

    is_editor: bool | None = None
    """New value for the catalogue-editing flag, when given."""

    default_catalogue_id: int | None = None
    """New default catalogue, when given."""


class PasswordReset(BaseModel):
    """Payload for an administrative password reset."""

    new_password: str = _password_field()
    """The replacement plaintext password."""


class PasswordChange(BaseModel):
    """Payload for a user changing their own password."""

    current_password: str
    """The existing password, required even for admins."""

    new_password: str = _password_field()
    """The replacement plaintext password."""


class DefaultCatalogueChange(BaseModel):
    """Payload for a user choosing their own default catalogue."""

    catalogue_id: int
    """Identifier of the catalogue to answer by default."""


class Preferences(BaseModel):
    """Opaque UI state belonging to one user.

    The backend stores and returns the document unchanged; only the frontend
    interprets it.
    """

    model_config = ConfigDict(extra="allow")


class OptionOut(BaseModel):
    """One selectable choice of an enum question."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    label: str
    """Text shown on the choice."""

    position: int
    """Sort order within the question."""


class OptionCreate(BaseModel):
    """Payload for adding a choice to an enum question."""

    label: str = Field(min_length=1, max_length=255)
    """Text shown on the choice."""

    position: int = 0
    """Sort order within the question."""


class OptionUpdate(BaseModel):
    """Payload for renaming an existing enum choice."""

    label: str = Field(min_length=1, max_length=255)
    """Replacement text for the choice."""


class QuestionOut(BaseModel):
    """A question as exposed by the API, including its bounds and choices."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    catalogue_id: int
    """Owning catalogue."""

    kind: str
    """One of ``enum``, ``discrete`` or ``continuous``."""

    prompt: str
    """Question text shown to the user."""

    position: int
    """Sort order within the catalogue."""

    active: bool
    """Whether the question still appears in the questionnaire."""

    system_key: str | None
    """Identifier of an auto-tracked question, or null for an ordinary one."""

    min_value: float | None
    """Lower bound for discrete and continuous questions."""

    max_value: float | None
    """Upper bound for discrete and continuous questions."""

    min_label: str | None
    """Description of the lower bound."""

    max_label: str | None
    """Description of the upper bound."""

    options: list[OptionOut] = []
    """Choices, for enum questions."""


class QuestionCreate(BaseModel):
    """Payload for adding a question to a catalogue."""

    kind: str = Field(pattern="^(enum|discrete|continuous)$")
    """One of ``enum``, ``discrete`` or ``continuous``."""

    prompt: str = Field(min_length=1, max_length=500)
    """Question text shown to the user."""

    position: int = 0
    """Sort order within the catalogue."""

    min_value: float | None = None
    """Lower bound. Required for discrete and continuous questions."""

    max_value: float | None = None
    """Upper bound. Required for discrete and continuous questions."""

    min_label: str | None = Field(default=None, max_length=255)
    """Description of the lower bound."""

    max_label: str | None = Field(default=None, max_length=255)
    """Description of the upper bound."""

    options: list[OptionCreate] = []
    """Choices, for enum questions. At least two are required."""


class QuestionUpdate(BaseModel):
    """Payload for editing a question.

    Only the numeric bounds are frozen once the question has been answered.
    Wording — the prompt and the bound descriptions — stays editable, since it
    renames what was recorded rather than rescaling it.
    """

    prompt: str | None = Field(default=None, min_length=1, max_length=500)
    """New question text."""

    position: int | None = None
    """New sort order."""

    active: bool | None = None
    """Whether the question appears in the questionnaire."""

    min_value: float | None = None
    """New lower bound. Frozen once the question has been answered."""

    max_value: float | None = None
    """New upper bound. Frozen once the question has been answered."""

    min_label: str | None = Field(default=None, max_length=255)
    """New lower bound description. Wording, so editable at any time."""

    max_label: str | None = Field(default=None, max_length=255)
    """New upper bound description. Wording, so editable at any time."""


class CatalogueOut(BaseModel):
    """A catalogue without its questions, for listing."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    name: str
    """Unique display name."""


class CatalogueDetail(CatalogueOut):
    """A catalogue with every question it contains.

    This is the single payload the questionnaire loads at startup.
    """

    questions: list[QuestionOut] = []
    """Questions in display order, auto-tracked ones included."""


class CatalogueCreate(BaseModel):
    """Payload for creating or renaming a catalogue."""

    name: str = Field(min_length=1, max_length=255)
    """Unique display name."""


class AnswerIn(BaseModel):
    """A single answer submitted by the questionnaire."""

    day: date
    """Client-local calendar day the answer belongs to."""

    local_hour: int = Field(ge=0, le=23)
    """Client-local hour of submission, used for the auto-tracked hour."""

    question_id: int
    """The question being answered."""

    value: float | None = None
    """Numeric response, for discrete and continuous questions."""

    option_id: int | None = None
    """Chosen option, for enum questions."""


class AnswerDelete(BaseModel):
    """Identifies a single answer to clear."""

    day: date
    """Calendar day of the answer."""

    question_id: int
    """The question whose answer is cleared."""


class AnswerOut(BaseModel):
    """An answer as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)

    question_id: int
    """The question answered."""

    day: date
    """Calendar day the answer belongs to."""

    value: float | None
    """Numeric response, for discrete and continuous questions."""

    option_id: int | None
    """Chosen option, for enum questions."""


class Variable(BaseModel):
    """A plottable variable on the stats page.

    Auto-tracked variables are merged across catalogues by their system key, so
    a user who switches catalogue still sees one continuous series.
    """

    key: str
    """Stable identifier: ``q<id>`` for questions, the system key otherwise."""

    label: str
    """Human-readable name."""

    kind: str
    """One of ``enum``, ``discrete`` or ``continuous``."""

    system_key: str | None
    """Set when the variable is auto-tracked."""

    min_value: float | None
    """Lower bound, for numeric variables."""

    max_value: float | None
    """Upper bound, for numeric variables."""

    min_label: str | None
    """Description of the lower bound."""

    max_label: str | None
    """Description of the upper bound."""

    options: list[OptionOut] = []
    """Choices, for enum variables."""

    question_ids: list[int] = []
    """Every question id contributing to this variable."""

    roles: list[str] = []
    """Which plot roles the variable supports: ``axis``, ``group``, ``radar``."""
