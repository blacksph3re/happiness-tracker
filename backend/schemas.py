from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.fields import FieldInfo

from config import get_settings
from models import (
    ICON_MAX_LENGTH,
    LIST_NAME_MAX_LENGTH,
    PROMPT_MAX_LENGTH,
    RANK_MAX_LENGTH,
    TODO_TITLE_MAX_LENGTH,
    TRACK_NAME_MAX_LENGTH,
    EntrySource,
    HabitDirection,
    HabitPeriod,
    ListKind,
    PomodoroState,
    QuestionKind,
    QuestionOrigin,
    ScoreAggregate,
    SystemKey,
    TodoPriority,
)
from templates import DEFAULT_TEMPLATE


class Version(BaseModel):
    """Build information served by the public version endpoint."""

    version: str
    """Application version string."""


class DiskUsage(BaseModel):
    """How full the volume holding the database is."""

    total_bytes: int
    """Size of the filesystem the database sits on."""

    used_bytes: int
    """How much of it is in use, by anything, not only by this app."""

    free_bytes: int
    """How much is available to this process.

    Not simply `total - used`: a filesystem reserves blocks for root, so the
    space a writer can actually have is the smaller number and the one worth
    showing.
    """


class MemoryUsage(BaseModel):
    """What the container's cgroup says about memory."""

    used_bytes: int
    """Current usage, as the cgroup accounts it."""

    limit_bytes: int | None
    """The ceiling, or None where the cgroup reports no limit."""


class ServerMetrics(BaseModel):
    """A glance at the running server, for an administrator.

    Deliberately small and cheap: a version, how long the process has been up,
    and how much room is left. Anything needing history belongs in a monitoring
    system rather than in a settings page.
    """

    version: str
    """The running application's version."""

    uptime_seconds: int
    """How long this process has been serving.

    The process, not the host. A container is restarted by a deploy, so this is
    "how long since the last deploy or crash", which is the question somebody
    looking at a settings page is actually asking.
    """

    database_bytes: int
    """Size of the SQLite file on disk."""

    disk: DiskUsage
    """The volume the database sits on."""

    memory: MemoryUsage | None
    """Container memory, or None when there is no cgroup to read.

    Absent rather than zero on a development machine: a number nobody measured
    is worse than an honest gap.
    """


class Fingerprint(BaseModel):
    """How much of one collection there is, and when it last moved.

    Both halves are needed, because neither alone sees every kind of change: a
    timestamp watermark cannot see a deletion, since the deleted row takes its
    own timestamp with it, and a count cannot see an edit.
    """

    n: int
    """How many rows the signed-in account has in this collection."""

    at: datetime | None
    """The newest ``updated_at`` among them.

    ``None`` where the table does not carry the column, in which case the
    collection is compared on ``n`` alone and an edit in place goes unnoticed
    until the row count changes.
    """


class Changes(BaseModel):
    """A fingerprint per collection, for a client deciding what to re-read.

    Deliberately one small response rather than an endpoint per collection: the
    common answer is "nothing moved", and that should cost one request.
    """

    answers: Fingerprint
    """Recorded answers, including edits to them."""

    time_entries: Fingerprint
    """Tracked sessions, which are corrected and deleted freely."""

    projects: Fingerprint
    """Projects owned by the account."""

    tags: Fingerprint
    """Tags owned by the account."""

    rules: Fingerprint
    """Deduction bands, which change what reported time means."""

    pomodoros: Fingerprint
    """Every pomodoro of the signed-in account."""

    catalogues: Fingerprint
    """Question catalogues, which belong to the account like everything else."""

    todos: Fingerprint
    """Tasks, which are ticked, corrected, archived and deleted freely.

    The pair earns its keep in both directions here: a tick is an edit no count
    can see, and moving a task to the archive is an update that moves no count
    at all.
    """

    todo_steps: Fingerprint
    """Subtasks, counted through the task they sit on."""

    todo_lists: Fingerprint
    """The account's lists, the two system ones included."""

    me: Fingerprint
    """The account row itself, whose default catalogue decides what is asked."""


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


class LoginResult(BaseModel):
    """What a username and password bought: either tokens, or a challenge.

    One model with a ``status`` discriminator rather than a union of two: the
    TypeScript client is generated from this schema, and a union survives
    codegen far less cleanly than a field the caller switches on.
    """

    status: str
    """``complete`` when the tokens are here, ``totp_required`` when they are not."""

    access_token: str | None = None
    """Bearer token presented on subsequent requests. Null while a factor is due."""

    refresh_token: str | None = None
    """Token accepted only by the refresh endpoint. Null while a factor is due."""

    token_type: str | None = None
    """Always ``bearer`` when tokens are present."""

    expires_in: int | None = None
    """Seconds until `access_token` expires."""

    totp_token: str | None = None
    """Short-lived proof that the password step was passed.

    Authorises exactly one thing: presenting a second factor. Worthless as a
    bearer credential, and worthless at all after five minutes."""


class TotpChallenge(BaseModel):
    """The second step of a login."""

    totp_token: str
    """The token handed out by the password step."""

    code: str = Field(min_length=1, max_length=16)
    """The digits from the authenticator app."""


class TotpEnrolment(BaseModel):
    """What an authenticator app needs to start holding an account."""

    secret: str
    """The base32 shared secret, for typing in where a camera is not available."""

    otpauth_uri: str
    """The `otpauth://` URI, rendered as a QR code by the browser.

    Rendered client-side on purpose: an image built by the server is an image
    of the secret, and one the browser may keep."""


class TotpCode(BaseModel):
    """A code proving possession of the enrolled device."""

    code: str = Field(min_length=1, max_length=16)
    """The digits from the authenticator app."""


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

    default_catalogue_id: int | None
    """Catalogue presented to this user when answering."""


class MeOut(UserOut):
    """The signed-in account, plus the rules its own forms have to obey.

    Kept separate from `UserOut` so that a password policy does not appear on
    every row of the user listing, where it would read as a per-user setting.
    """

    password_min_length: int
    """Shortest password the server will accept, so forms can say so up front."""

    totp_enabled: bool
    """Whether a confirmed second factor is in force on this account.

    Enrolment begun and abandoned reads as False, which is the same thing login
    believes — one answer about a half-finished enrolment, not two."""


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

    template: str = DEFAULT_TEMPLATE
    """Starter set the account's first catalogue is built from.

    A key rather than a catalogue id, because there is no catalogue to point at
    yet: every account owns its own, and this says what to fill the first one
    with.
    """


class UserUpdate(BaseModel):
    """Payload for changing another user's flags or default catalogue."""

    is_admin: bool | None = None
    """New value for the user-management flag, when given."""

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
    def _within_size_limit(self) -> Preferences:
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

    counts: bool
    """Whether this choice counts towards the owning habit's target."""


class OptionCreate(BaseModel):
    """Payload for adding a choice to an enum question."""

    label: str = Field(min_length=1, max_length=255)
    """Text shown on the choice."""

    position: int = 0
    """Sort order within the question."""

    counts: bool = False
    """Whether this choice counts towards the owning habit's target."""


class OptionUpdate(BaseModel):
    """Payload for editing an existing enum choice.

    Both fields are optional and either may be sent alone, because the two are
    edited from different places: the label from the question form, and `counts`
    from the habit checkbox beside it.

    Neither is frozen by an answer. Renaming a choice describes the same recorded
    answers, and marking one as counted says what those answers *mean* for a
    streak — a definition, and definitions are retroactive here. Adding and
    removing choices stays frozen, which is the part that would reinterpret them.
    """

    label: str | None = Field(default=None, min_length=1, max_length=255)
    """Replacement text for the choice, or None to leave it alone."""

    counts: bool | None = None
    """Whether this choice counts towards the target, or None to leave it alone."""


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

    aggregate: ScoreAggregate
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

    aggregate: ScoreAggregate | None = None
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

    kind: QuestionKind
    """What the answers to this question are shaped like."""

    prompt: str
    """Question text shown to the user."""

    position: int
    """Sort order within the catalogue."""

    active: bool
    """Whether the question still appears in the questionnaire."""

    origin: QuestionOrigin
    """Where this question's answers come from."""

    aggregate: ScoreAggregate | None
    """How the components combine, for scores."""

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

    icon: str | None
    """A short emoji shown where the question has to be compact."""

    habit_period: HabitPeriod | None
    """The period this habit's target is measured over, or None for a plain question."""

    habit_target: int | None
    """How many days in a period must carry a counted answer."""

    habit_direction: HabitDirection | None
    """Whether the target is a floor to reach or a ceiling to stay under."""

    options: list[OptionOut] = []
    """Choices, for enum questions."""


class QuestionCreate(BaseModel):
    """Payload for adding a question to a catalogue."""

    kind: QuestionKind
    """What the answers to this question are shaped like."""

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

    icon: str | None = Field(default=None, max_length=ICON_MAX_LENGTH)
    """A short emoji shown where the question has to be compact."""

    habit_period: HabitPeriod | None = None
    """The period a habit target is measured over.

    Set with the other two, or not at all.
    """

    habit_target: int | None = None
    """How many days in a period must count. Zero is allowed only as a ceiling."""

    habit_direction: HabitDirection | None = None
    """Whether the target is a floor or a ceiling."""

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

    icon: str | None = Field(default=None, max_length=ICON_MAX_LENGTH)
    """New icon, or an explicit null to take the current one off.

    Read from what was *sent* rather than from the value, so that null means
    "no icon" here while it means "leave alone" on the fields above.
    """

    habit_period: HabitPeriod | None = None
    """New period, or an explicit null to stop this question being a habit."""

    habit_target: int | None = None
    """New target, or an explicit null to stop this question being a habit."""

    habit_direction: HabitDirection | None = None
    """New direction, or an explicit null to stop this question being a habit."""


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

    template: str | None = None
    """Key of a starter set to fill the new catalogue with, or None for empty.

    Ignored when renaming: a catalogue is built from a template once, and
    changing its name later has nothing to do with where its questions came
    from.
    """


class TemplateOut(BaseModel):
    """A starter question set on offer."""

    key: str
    """Identifier the API accepts when building a catalogue from this."""

    name: str
    """What the catalogue is called when it is created."""

    description: str
    """One line describing what the set contains."""


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

    local_hour: int | None
    """Client-local hour the answer was given at, 0-23.

    What `first_answer_hour` is derived from: the reader takes the minimum over
    a day. Null on rows written before the column existed.
    """


class Variable(BaseModel):
    """A plottable variable on the stats page.

    Auto-tracked variables have no question behind them at all: weekday, month,
    year and day-of-year are functions of the calendar day, and the hour is a
    column on the answer. They are described here and computed by the reader.
    """

    key: str
    """Stable identifier: ``q<id>`` for questions, the system key otherwise."""

    label: str
    """Human-readable name."""

    kind: QuestionKind
    """What this variable's values are shaped like."""

    system_key: SystemKey | None
    """Set when the variable is auto-tracked."""

    origin: QuestionOrigin
    """Where its values come from."""

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
    """The question this variable reads, as a list of at most one.

    What the variable *is*. It held several while auto-tracked variables were
    merged across catalogues by their system key; now that those are computed
    from the day, a variable is one question or — for the auto-tracked ones —
    none at all. Still a list, so a reader that already handles the empty case
    needs no other shape.
    """

    component_ids: list[int] = []
    """The questions a computed variable is defined over, empty for the rest.

    What the variable is *made of*, which `question_ids` cannot say. A score
    correlates with each of its own components by construction, so the stats
    page needs to recognise that pair and decline to rank it.
    """

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

    source: EntrySource | None
    """Where the session came from, when it was not tracked directly.

    `pomodoro` for one written by the focus half's transfer, null otherwise.
    """


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

    added: int = 0
    """Seconds the group's rule adds to this day, on any day it tracked
    anything. Always zero when grouping by project: a rule belongs to a tag."""

    deduction: int = 0
    """Seconds the group's rule removes from this day, measured against the
    total *after* `added`. Always zero when grouping by project."""

    reported: int = 0
    """What the day reports: ``seconds + added - deduction``.

    All four are sent so the number explains itself. With only three, a rule
    that adds an hour would leave an hour nobody could account for."""


class DeductionBandIn(BaseModel):
    """One step of a tag's tracked-to-reported rule."""

    from_minutes: int = Field(ge=0, le=24 * 60)
    """Tracked minutes at which this band starts applying."""

    deduct_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    """Minutes it removes from the day, or null to cap the day at the threshold."""


class DeductionBandOut(DeductionBandIn):
    """A band as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)


class TagRuleIn(BaseModel):
    """A tag's whole rule: what it adds to a day, and what it takes away.

    One payload rather than two endpoints, because the two halves are one rule:
    the addition lands first and the bands are tested against the increased
    total, so saving them separately would leave a moment where the stored rule
    means something nobody asked for.
    """

    add_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    """Minutes added to every day this tag tracked anything, or null for none.

    Zero is stored as null, so a rule that adds nothing has one spelling.
    """

    bands: list[DeductionBandIn] = []
    """The deduction bands, in any order."""


class TagRuleOut(BaseModel):
    """A tag's rule as exposed by the API."""

    add_minutes: int | None
    """Minutes added to every tracked day, or null for none."""

    bands: list[DeductionBandOut] = []
    """The deduction bands, lowest threshold first."""


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

    kind: Literal[
        "answer.put",
        "entry.upsert",
        "entry.delete",
        "pomodoro.upsert",
        "pomodoro.delete",
        "todo.upsert",
        "todo.delete",
        "step.upsert",
        "step.delete",
    ]
    """What the intent does.

    `entry.upsert` covers creating and correcting alike, deliberately: a
    correction to a session another device deleted re-creates it, and a single
    kind is what makes that fall out rather than being special-cased.
    `todo.upsert` and `step.upsert` are the same shape for the same reason.
    """

    client_updated_at: datetime
    """The device's clock at the moment of the tap. What decides who wins."""

    client_id: str | None = Field(default=None, max_length=36)
    """The device's identity for a session or pomodoro.

    Required for every kind but `answer.put`, which is keyed by question and day
    instead.
    """

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

    pomodoro: PomodoroOut | None = None
    """The pomodoro as it now stands, for the device to fold back in.

    A separate field rather than a shared one: the two carry different columns,
    and a client folding a response into the wrong cache is a bug that would
    only show up offline.
    """


class SyncResponse(BaseModel):
    """The outcome of a whole queue."""

    results: list[SyncResult]
    """One per intent, in the order they were sent."""

    server_time: datetime
    """The server's clock, so a device can notice its own is wrong."""


class PomodoroOut(BaseModel):
    """One pomodoro as exposed by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    task: str | None
    """What the focus was for, or null if nothing was typed."""

    started_at: datetime
    """When the focus began, in UTC."""

    ended_at: datetime | None
    """When something stopped it early, or null if nothing did.

    Null is not "still running": a pomodoro left alone ends where it said it
    would. `state` is the field to read for that.
    """

    utc_offset: int
    """Minutes east of UTC when it started."""

    focus_seconds: int
    """Length of the focus phase as configured at the time."""

    break_seconds: int
    """Length of the break phase as configured at the time."""

    tainted: bool
    """Whether the focus was marked unsuccessful."""

    transferred_at: datetime | None
    """When this pomodoro's time was copied to a project, or null if never."""

    client_id: str | None
    """The identity the recording device gave it. See `TimeEntryOut`."""

    todo_id: int | None
    """The task this focus was for, or null when the timer was never linked.

    Read the task's *current* title through this where it is set, and the
    stored `task` text where it is not. Exactly one of the two is ever right
    for a given row, which is what makes keeping both safe.
    """

    todo_client_id: str | None
    """That task's own device identity, or null.

    Sent beside the server id because the client keys its tasks by this: a
    device folding a pomodoro into its cache would otherwise need a second
    lookup to say which of its own rows the link names.
    """

    state: PomodoroState
    """Which of the three outcomes it is in, computed on read.

    Sent rather than left to the client because the server is the authority on
    it, and because the client would otherwise need the same three-way
    comparison to draw a list it did not create.
    """

    elapsed_seconds: int
    """How long it lasted in total, capped at its planned end."""

    focus_elapsed_seconds: int
    """How much of that was focus."""

    break_elapsed_seconds: int
    """How much of that was break. Zero for an abandoned pomodoro."""


class TransferRequest(BaseModel):
    """Payload for copying a day's pomodoro time onto a project."""

    day: date
    """The local day to copy."""

    project_id: int
    """Where the session should land."""

    started_at: datetime | None = None
    """Override for where the session begins, in UTC.

    Offered because the natural placement can collide: a project tracked by
    hand this morning *and* worked on in pomodoros leaves no room for a block
    starting at the first one. Null takes the earliest untransferred pomodoro.
    """


class TransferResult(BaseModel):
    """What one transfer wrote, as the button reads it back.

    The endpoint used to answer a bare ``dict``, which reaches the client as
    ``{ [key: string]: unknown }`` — the wire version of a `{object}` docstring,
    and the same loss of meaning. The keys are unchanged; only what the schema
    says about them is new.
    """

    entry_id: int
    """The session that was written."""

    started_at: datetime
    """Where it begins, in UTC."""

    ended_at: datetime
    """Where it ends, in UTC. Never null: a copy needs a finished duration."""

    seconds: int
    """How long it is, focus and break together."""

    pomodoros: int
    """How many pomodoros were stamped as copied."""


class SyncPomodoroPayload(BaseModel):
    """A pomodoro as a device queues it.

    `ended_at` may be null, and usually is: it is written only by an explicit
    stop, so a pomodoro that ran as declared queues with nothing there.
    """

    task: str | None = Field(default=None, max_length=500)
    """Optional description."""

    started_at: datetime
    """When the focus began, in UTC."""

    ended_at: datetime | None = None
    """When something stopped it early, in UTC, or null if nothing did."""

    utc_offset: int = Field(ge=-720, le=840)
    """Minutes east of UTC where the client was."""

    focus_seconds: int = Field(gt=0, le=86_400)
    """Length of the focus phase as configured at the time."""

    break_seconds: int = Field(ge=0, le=86_400)
    """Length of the break phase as configured at the time."""

    tainted: bool = False
    """Whether the focus was marked unsuccessful."""

    todo_client_id: str | None = Field(default=None, max_length=36)
    """The task this focus is for, named by the identity its device gave it.

    The client's own id and **not** `todo_id`, because a pomodoro started from
    a task created in the same gesture names a task the server has never seen:
    its primary key does not exist yet. The server resolves the identity the
    way `step.upsert` resolves its parent, and refuses the intent when it names
    a task belonging to somebody else.
    """


SyncResult.model_rebuild()


# ---------------------------------------------------------------------------
# Todos. Tasks and steps are written only through `/api/sync`, so there is no
# create or update payload for either — the offline path is the only path,
# which is what stops it rotting from disuse. Lists are ordinary CRUD, like
# projects and tags and for the same reason: a container is not something you
# make on a train.
# ---------------------------------------------------------------------------


class TodoStepOut(BaseModel):
    """One subtask as exposed by the API, nested inside its task."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    client_id: str | None
    """The identity the recording device gave it, which is what a later tick
    or deletion names it by."""

    title: str
    """What the step is."""

    icon: str | None
    """An emoji drawn in place of the tickbox, or null for the tickbox."""

    rank: str
    """Order within its task."""

    done_at: datetime | None
    """When it was ticked, in UTC, or null while it is not."""


class TodoOut(BaseModel):
    """One task as exposed by the API, with its steps nested."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    client_id: str | None
    """The identity the recording device gave it. See `TimeEntryOut`."""

    list_id: int
    """Which list it is in. Being archived *is* this pointing at the archive."""

    title: str
    """What to do."""

    description: str | None
    """Longer notes, in Markdown."""

    planned_on: date
    """The local day it is planned for."""

    planned_at: time | None
    """Wall clock time on that day, or null for the calendar's *anytime* row."""

    due_on: date | None
    """When it has to be done by, or null."""

    priority: TodoPriority | None
    """How it ranks against the others. Null is *not important* by definition."""

    duration_minutes: int | None
    """How long it is expected to take. An estimate, never a measurement."""

    icon: str | None
    """An emoji drawn in place of the tickbox, or null for the tickbox."""

    colour: str | None
    """A palette token painting the card, or null to take the list's colour."""

    rank: str
    """Order within its column."""

    done_at: datetime | None
    """When it was ticked, in UTC, or null. There is no `is_done`."""

    archived_at: datetime | None
    """When it last entered the archive, in UTC, or null.

    **When**, never *whether*: read it only for a task already known to be in
    the archive. The server fills and clears it from the list the task is in,
    so it cannot disagree with that.
    """

    active_since: datetime | None
    """When the current activation began, in UTC, or null when not active."""

    active_seconds: int
    """Seconds banked from activations that have already ended."""

    steps: list[TodoStepOut] = []
    """The subtasks, in order. Always nested rather than fetched per task."""


class TodoPage(BaseModel):
    """One page of the archive, with the marker for the page after it."""

    items: list[TodoOut]
    """The tasks, newest arrival first."""

    next: str | None
    """An opaque marker to send back as ``before``, or null at the end.

    Opaque because it encodes a *pair* — when the last task on the page was
    archived and which task it was. A cursor naming only the timestamp would
    repeat or skip tasks archived in the same instant, which is what a cleanup
    of a whole list produces.
    """


class TodoListOut(BaseModel):
    """A list of tasks as exposed by the API, with who else can see it.

    Built by hand rather than read off the row, because the last field depends
    on **who is asking**: a roster is the owner's to see.
    """

    id: int
    """Surrogate primary key."""

    name: str
    """Display name. Never what the code branches on; `kind` is."""

    kind: ListKind
    """Which of the three this is."""

    colour: str
    """A chip palette token.

    One colour per list rather than one per member: two people looking at one
    list should see one thing, so a shared list carries the owner's choice.
    """

    rank: str
    """Column order in the move-between-lists view.

    A shared list carries the rank its **owner** gave it, which this caller
    never chose. The reply is ordered with the caller's own inbox first and
    their own archive last regardless, so a rank from another account cannot
    push a system list out of its place.
    """

    owner: str
    """The username of the account the list belongs to.

    Always present, and equal to the caller's own name for a list they own.
    What draws *Shared by alice* under somebody else's list.
    """

    shared: bool
    """Whether anybody besides the owner can see this list."""

    members: list[str] | None
    """The other usernames that can see it, or null when the caller is not the
    owner.

    Empty rather than null for an owned list nobody else holds: the absence of
    members is a fact about it, where null says *not your roster to read*.
    """


class TodoListMemberOut(BaseModel):
    """One account a list has been shared with."""

    user_id: int
    """The member's account, which is what a removal names them by."""

    username: str
    """Their name, which is what the owner sees and shares by."""

    added_by: str | None
    """Who shared the list, or null once that account is gone.

    Never the member themselves: sharing is the owner's act, and a member
    cannot hand a list on.
    """

    created_at: datetime
    """When the list was shared with them."""


class TodoListMemberCreate(BaseModel):
    """Payload for sharing a list with somebody.

    By **username**, which tells the owner whether a username exists — a small
    leak the app otherwise makes only to an admin, and the price of the simplest
    interface. An unknown name answers 404, so it reads exactly as an unowned
    list does.
    """

    username: str = Field(min_length=1, max_length=255)
    """Who to share it with. Not the caller: a list is never shared with its
    own owner, which answers 409."""


class TodoListCreate(BaseModel):
    """Payload for making a list."""

    name: str = Field(min_length=1, max_length=LIST_NAME_MAX_LENGTH)
    """Display name. Not unique: two lists called *Home* are the owner's
    business."""

    colour: str = Field(default="tide", pattern=COLOUR_PATTERN)
    """A chip palette token."""

    rank: str | None = Field(default=None, max_length=RANK_MAX_LENGTH)
    """Where it sorts, or null to append after the last list before the archive."""


class TodoListUpdate(BaseModel):
    """Payload for editing a list. Omitted fields are left alone."""

    name: str | None = Field(
        default=None, min_length=1, max_length=LIST_NAME_MAX_LENGTH
    )
    """New display name. Allowed on the two system lists like any other."""

    colour: str | None = Field(default=None, pattern=COLOUR_PATTERN)
    """New chip palette token."""

    rank: str | None = Field(default=None, max_length=RANK_MAX_LENGTH)
    """New column order."""

    kind: ListKind | None = None
    """Accepted only where it matches what is stored, and refused otherwise.

    Present so that a client sending a whole list back does not have to strip
    the field, and so that an attempt to *change* it is a named 409 rather than
    a silently ignored key. Turning an ordinary list into a second archive is
    the kind of thing the partial unique index would report as a 500.
    """


class SyncTodoPayload(BaseModel):
    """A task as a device queues it.

    Every field of the row, because a task has no extent and nothing merges:
    the newest version of a task simply is the task. The list is named by its
    **server** id, which the device always has — lists are online-only CRUD, so
    a list it could name at all is one it has already read.
    """

    list_id: int
    """Which list the task is in."""

    title: str = Field(min_length=1, max_length=TODO_TITLE_MAX_LENGTH)
    """What to do."""

    description: str | None = Field(default=None, max_length=20_000)
    """Longer notes, in Markdown."""

    planned_on: date
    """The local day it is planned for. Mandatory, as the title is."""

    planned_at: time | None = None
    """Wall clock time on that day, or null for no particular time."""

    due_on: date | None = None
    """When it has to be done by, or null."""

    priority: TodoPriority | None = None
    """How it ranks against the others, or null for *not important*."""

    duration_minutes: int | None = Field(default=None, ge=0, le=100_000)
    """How long it is expected to take, in minutes."""

    icon: str | None = Field(default=None, max_length=ICON_MAX_LENGTH)
    """An emoji drawn in place of the tickbox.

    Bounded by length alone, as a question's icon is: an icon from a later
    curated set must not start answering 422.
    """

    colour: str | None = Field(default=None, pattern=COLOUR_PATTERN)
    """A palette token painting the card, or null to take the list's colour.

    Bounded by shape and not by membership, exactly as a project's and a
    list's colour are: the palette gains tokens, and a colour chosen in a
    later release of the app must not start answering 422 against a server
    that has not been redeployed yet. The client draws an unrecognised token
    through `chipColour`'s fallback, so the only thing a membership rule could
    buy here is a guarantee nothing needs.

    Null is a value rather than an omission — see the class docstring: a
    `todo.upsert` carries every field of the row, so sending null is the whole
    of taking a colour off and none of `model_fields_set` is involved.
    """

    rank: str | None = Field(default=None, max_length=RANK_MAX_LENGTH)
    """Order within its column, or null to append at the end of the list.

    The client computes this, because only the client knows where the card was
    dropped. Null is for the writes that name no position at all — the
    pomodoro handover creating a task in the inbox, say.
    """

    done_at: datetime | None = None
    """When it was ticked, in UTC, or null."""

    archived_at: datetime | None = None
    """When it entered the archive, in UTC, or null.

    A field like any other on the wire, but the server has the last word: a
    task in the archive list gets a timestamp whether or not one arrived, and a
    task outside it has this cleared. That keeps the column honest whatever
    version of the client sent the row.
    """

    active_since: datetime | None = None
    """When the current activation began, in UTC, or null when not active."""

    active_seconds: int = Field(default=0, ge=0)
    """Seconds banked from activations that have already ended."""


class SyncStepPayload(BaseModel):
    """A subtask as a device queues it, naming its parent by client identity.

    **The wire carries the parent's `client_id`; the database stores the real
    key.** A step created in the modal of a task that is itself still in the
    outbox has no `todo_id` to point at. Intents replay in order, so the parent
    is already applied — and where it was refused, the step is refused with
    *that task no longer exists*, which is what `apply_answer` already says
    about a missing question.
    """

    todo_client_id: str = Field(min_length=1, max_length=36)
    """The identity its device gave the task this step sits on."""

    title: str = Field(min_length=1, max_length=TODO_TITLE_MAX_LENGTH)
    """What the step is."""

    icon: str | None = Field(default=None, max_length=ICON_MAX_LENGTH)
    """An emoji drawn in place of the tickbox."""

    rank: str | None = Field(default=None, max_length=RANK_MAX_LENGTH)
    """Order within its task, or null to append after the last step."""

    done_at: datetime | None = None
    """When the step was ticked, in UTC, or null. Ticking every step does not
    tick the task: there is no roll-up, only a counter on the card."""


class PushKey(BaseModel):
    """Whether this server can send push notifications, and the key to use."""

    configured: bool
    """False when the deployment has no VAPID keys.

    Reported rather than raised: a server without them is a working server with
    one less feature, and the client has to be able to tell without guessing
    from an error.
    """

    public_key: str | None
    """The VAPID public key, base64url, or null when unconfigured."""


class PushSubscriptionIn(BaseModel):
    """A browser registering itself, as `PushSubscription.toJSON()` gives it."""

    endpoint: str = Field(max_length=2000)
    """Where the push service takes messages for this browser."""

    p256dh: str = Field(max_length=255)
    """The browser's public key, base64url."""

    auth: str = Field(max_length=255)
    """The browser's auth secret, base64url."""

    label: str | None = Field(default=None, max_length=80)
    """What to call this device in a list."""


class PushSubscriptionOut(BaseModel):
    """One registered device, as a list of them shows it.

    **No endpoint.** It is a capability URL: anything holding one can send a
    notification to that browser, and there is no reason for it to travel back
    out of the server that stored it.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    """Surrogate primary key."""

    label: str | None
    """What to call this device."""

    created_at: datetime
    """When the browser first registered."""

    updated_at: datetime
    """When it last re-registered, which it does on every launch."""


class PushEndpoint(BaseModel):
    """The one field needed to forget a device."""

    endpoint: str = Field(max_length=2000)
    """The endpoint to remove, if this account still holds it."""
