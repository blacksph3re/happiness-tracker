from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.fields import FieldInfo

from config import get_settings
from models import PROMPT_MAX_LENGTH, TRACK_NAME_MAX_LENGTH


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


def _password_field() -> FieldInfo:
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


PREFERENCES_MAX_BYTES = 8192
"""Ceiling on a stored preferences document, in bytes of serialised JSON.

Generous for view state - the current frontend stores a few hundred bytes - and
small enough that the endpoint cannot be used to fill the disk.
"""


class Preferences(BaseModel):
    """Opaque UI state belonging to one user.

    The backend stores and returns the document unchanged; only the frontend
    interprets it. It is bounded but not inspected.
    """

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="after")
    def _within_size_limit(self) -> "Preferences":
        """Reject a document too large to be view state.

        Returns
        -------
        Preferences
            The unchanged document.

        Raises
        ------
        ValueError
            If the serialised document exceeds `PREFERENCES_MAX_BYTES`.
        """
        size = len(self.model_dump_json().encode())
        if size > PREFERENCES_MAX_BYTES:
            raise ValueError(
                f"preferences must serialise to at most {PREFERENCES_MAX_BYTES} "
                f"bytes, got {size}"
            )
        return self


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


class ScoreComponentOut(BaseModel):
    """One question feeding a score."""

    model_config = ConfigDict(from_attributes=True)

    source_question_id: int
    """The question whose answer is taken."""

    weight: float
    """Multiplier applied before combining."""


class ScoreComponentIn(BaseModel):
    """One question to feed a score."""

    source_question_id: int
    """The question whose answer is taken."""

    weight: float = 1.0
    """Multiplier applied before combining."""


class ScoreCreate(BaseModel):
    """Payload for defining a score over other questions."""

    prompt: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH)
    """What the score is called."""

    aggregate: str = Field(pattern="^(sum|mean)$")
    """How the components combine."""

    components: list[ScoreComponentIn] = Field(min_length=1)
    """The questions that feed it, with their weights."""

    require_all: bool = True
    """Whether every component must be answered before the day has a score."""

    position: int = 0
    """Sort order within the catalogue."""


class ScoreUpdate(BaseModel):
    """Payload for changing a score. Omitted fields are left alone."""

    prompt: str | None = Field(default=None, min_length=1, max_length=PROMPT_MAX_LENGTH)
    """New name for the score."""

    aggregate: str | None = Field(default=None, pattern="^(sum|mean)$")
    """New way of combining the components."""

    components: list[ScoreComponentIn] | None = Field(default=None, min_length=1)
    """Replacement set of components, when given."""

    require_all: bool | None = None
    """New completeness rule."""

    position: int | None = None
    """New sort order."""

    active: bool | None = None
    """Whether the score is still reported."""


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

    origin: str
    """``asked``, ``auto`` or ``computed``: where this question's answers come from."""

    system_key: str | None
    """Which auto-tracked variable this is, for questions of origin ``auto``."""

    aggregate: str | None
    """``sum`` or ``mean``, for scores."""

    require_all: bool
    """Whether a score needs every component answered."""

    components: list[ScoreComponentOut] = []
    """The questions feeding a score, with their weights."""

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

    prompt: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH)
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

    prompt: str | None = Field(default=None, min_length=1, max_length=PROMPT_MAX_LENGTH)
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

    origin: str
    """``asked``, ``auto`` or ``computed``: where its values come from."""

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


# ---------------------------------------------------------------------------
# Time tracking
# ---------------------------------------------------------------------------

COLOUR_PATTERN = "^[a-z][a-z0-9-]{0,15}$"
"""Shape of a palette token. A name, not a hex value, so the two halves of the
app cannot drift apart on what "the fourth colour" is."""


class TagOut(BaseModel):
    """A label over projects, as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    name: str
    """Display name."""

    colour: str
    """Palette token."""

    position: int
    """Sort order."""


class TagCreate(BaseModel):
    """Payload for defining a tag."""

    name: str = Field(min_length=1, max_length=TRACK_NAME_MAX_LENGTH)
    """Display name, unique among the user's tags."""

    colour: str = Field(default="tide", pattern=COLOUR_PATTERN)
    """Palette token."""

    position: int = 0
    """Sort order."""


class TagUpdate(BaseModel):
    """Payload for editing a tag. Omitted fields are left alone."""

    name: str | None = Field(
        default=None, min_length=1, max_length=TRACK_NAME_MAX_LENGTH
    )
    """New display name."""

    colour: str | None = Field(default=None, pattern=COLOUR_PATTERN)
    """New palette token."""

    position: int | None = None
    """New sort order."""


class ProjectOut(BaseModel):
    """A project as exposed by the API, with the tags covering it."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    name: str
    """Display name."""

    colour: str
    """Palette token."""

    position: int
    """Sort order."""

    active: bool
    """Whether the project is still offered for check-in."""

    tags: list[TagOut] = []
    """Labels covering this project."""


class ProjectCreate(BaseModel):
    """Payload for creating a project."""

    name: str = Field(min_length=1, max_length=TRACK_NAME_MAX_LENGTH)
    """Display name, unique among the user's projects."""

    colour: str = Field(default="tide", pattern=COLOUR_PATTERN)
    """Palette token."""

    position: int = 0
    """Sort order."""

    tag_ids: list[int] = []
    """Tags to apply."""


class ProjectUpdate(BaseModel):
    """Payload for editing a project. Omitted fields are left alone."""

    name: str | None = Field(
        default=None, min_length=1, max_length=TRACK_NAME_MAX_LENGTH
    )
    """New display name."""

    colour: str | None = Field(default=None, pattern=COLOUR_PATTERN)
    """New palette token."""

    position: int | None = None
    """New sort order."""

    active: bool | None = None
    """Whether the project is offered for check-in."""

    tag_ids: list[int] | None = None
    """Replacement set of tags, when given."""


class TimeEntryOut(BaseModel):
    """One session as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    project_id: int
    """The project this session counts towards."""

    started_at: datetime
    """When it began, in UTC."""

    ended_at: datetime | None
    """When it ended, in UTC. Null while it is still running."""

    utc_offset: int
    """Minutes east of UTC at check-in."""

    client_id: str | None
    """The identity the recording device gave this session.

    Sent to the client because it is what a later correction or deletion refers
    to — including one made with no connection, where the row's own id is not
    yet known to anybody.
    """

    note: str | None
    """Optional free text."""


class CheckIn(BaseModel):
    """Payload for starting a timer."""

    at: datetime
    """The instant of the check-in, in UTC, as the client reports it."""

    utc_offset: int = Field(ge=-720, le=840)
    """Minutes east of UTC where the client is."""

    note: str | None = Field(default=None, max_length=500)
    """Optional free text."""


class CheckOut(BaseModel):
    """Payload for stopping a timer."""

    at: datetime
    """The instant of the check-out, in UTC, as the client reports it."""


class TimeEntryCreate(BaseModel):
    """Payload for recording a session that was never tracked live."""

    merge_overlapping: bool = False
    """Absorb any session on the same project this one collides with.

    Off by default: an overlap is refused, and the caller decides whether it
    meant to extend what is already there. Merging keeps the earliest start and
    the latest end, and removes the sessions it swallowed."""

    project_id: int
    """The project it counts towards."""

    started_at: datetime
    """When it began, in UTC."""

    ended_at: datetime
    """When it ended, in UTC. A session added by hand is always finished."""

    utc_offset: int = Field(ge=-720, le=840)
    """Minutes east of UTC the session happened in."""

    note: str | None = Field(default=None, max_length=500)
    """Optional free text."""


class TimeEntryUpdate(BaseModel):
    """Payload for correcting a session. Omitted fields are left alone."""

    merge_overlapping: bool = False
    """Absorb any session on the same project this edit collides with."""

    project_id: int | None = None
    """Move the session to another project."""

    started_at: datetime | None = None
    """Corrected start, in UTC."""

    ended_at: datetime | None = None
    """Corrected end, in UTC."""

    note: str | None = Field(default=None, max_length=500)
    """Replacement free text."""


class SummaryRow(BaseModel):
    """How long one project or tag ran on one day."""

    day: date
    """Local calendar day."""

    key: int | None
    """The project id, or the tag id when grouping by tag. ``None`` is the
    untagged bucket, which only appears when grouping by tag."""

    seconds: int
    """Tracked seconds. Parallel sessions are added, so a day's rows can sum to
    more than 24 hours."""

    deduction: int = 0
    """Seconds the group's rule removes from this day. Always zero when
    grouping by project: a deduction belongs to a tag, not to a project."""

    reported: int = 0
    """Tracked seconds less the deduction."""


class DeductionBandIn(BaseModel):
    """One step of a tag's tracked-to-reported rule."""

    from_minutes: int = Field(ge=0, le=24 * 60)
    """Tracked minutes at which this band starts applying."""

    deduct_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    """Minutes it removes from the day, or null to cap the day at the threshold."""


class DeductionBandOut(DeductionBandIn):
    """A band as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)


class TrackedRange(BaseModel):
    """The first and last local day a user has any session on."""

    first: date | None
    """Earliest tracked day, or None when nothing has been tracked."""

    last: date | None
    """Latest tracked day, or None when nothing has been tracked."""


# ---------------------------------------------------------------------------
# Sync. One endpoint replays what a device recorded with no connection, and
# answers per intent rather than per request: a session the server refuses must
# not wedge the fortnight of answers queued behind it.
# ---------------------------------------------------------------------------


class SyncIntent(BaseModel):
    """One write a device made locally, waiting to be replayed."""

    seq: int
    """The device's own ordering. Echoed back so it can retire the right entry."""

    kind: Literal["answer.put", "entry.upsert", "entry.delete"]
    """What the intent does.

    `entry.upsert` covers creating and correcting alike, deliberately: a
    correction to a session another device deleted re-creates it, and a single
    kind is what makes that fall out rather than being special-cased.
    """

    client_updated_at: datetime
    """The device's clock at the moment of the tap. What decides who wins."""

    client_id: str | None = Field(default=None, max_length=36)
    """The device's identity for a session. Required for the entry kinds."""

    payload: dict = Field(default_factory=dict)
    """The write itself, in the shape the matching endpoint takes."""


class SyncEntryPayload(BaseModel):
    """A session as a device queues it.

    Distinct from `TimeEntryCreate` in one respect that matters: `ended_at` may
    be null, because checking in with no connection queues a session that is
    still running.
    """

    project_id: int
    """The project worked on."""

    started_at: datetime
    """When the session began, in UTC."""

    ended_at: datetime | None = None
    """When it ended, in UTC, or null while the timer is still running."""

    utc_offset: int = Field(ge=-720, le=840)
    """Minutes east of UTC at check-in."""

    note: str | None = Field(default=None, max_length=500)
    """Optional free text about the session."""


class SyncRequest(BaseModel):
    """A device's queue, oldest first."""

    intents: list[SyncIntent] = Field(default_factory=list, max_length=500)
    """The intents to replay, in the order they were made."""


class SyncResult(BaseModel):
    """What became of one intent."""

    seq: int
    """The intent this answers."""

    outcome: Literal["applied", "superseded", "merged", "dropped", "conflict"]
    """What happened.

    `superseded` and `dropped` are both "the server kept what it had" — the
    first for a write, the second for a deletion — and neither is an error: the
    device should retire the intent either way. `conflict` is the one that needs
    a person.
    """

    detail: str | None = None
    """Why, when the outcome is not `applied`. Shown in the sync panel."""

    entry: TimeEntryOut | None = None
    """The session as it now stands, for the device to fold back in."""


class SyncResponse(BaseModel):
    """The outcome of a whole queue."""

    results: list[SyncResult]
    """One per intent, in the order they were sent."""

    server_time: datetime
    """The server's clock, so a device can notice its own is wrong."""
