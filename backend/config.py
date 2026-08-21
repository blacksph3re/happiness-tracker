from datetime import timedelta
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


def _parse_duration(raw: str) -> timedelta:
    """Parse a duration written as a number plus a unit suffix.

    Accepts ``s``, ``m``, ``h`` and ``d`` suffixes, as well as a bare number of
    seconds.

    Parameters
    ----------
    raw : str
        Duration such as ``"30d"``, ``"1h"`` or ``"3600"``.

    Returns
    -------
    datetime.timedelta
        The parsed duration.

    Raises
    ------
    ValueError
        If `raw` is not a positive number with an optional known suffix.
    """
    text = raw.strip().lower()
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    multiplier = 1
    if text and text[-1] in units:
        multiplier = units[text[-1]]
        text = text[:-1]
    try:
        amount = float(text)
    except ValueError as exc:
        raise ValueError(f"invalid duration: {raw!r}") from exc
    if amount <= 0:
        raise ValueError(f"duration must be positive: {raw!r}")
    return timedelta(seconds=amount * multiplier)


class Settings(BaseSettings):
    """Runtime configuration, read from the environment.

    Every field maps to the environment variable of the same name in upper case,
    as documented in the project README.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 8000
    """TCP port the server binds to."""

    db_storage: str = "database.db"
    """Path to the SQLite database file."""

    admin_user: str = "admin"
    """Username of the account created on first startup."""

    admin_password: str = ""
    """Password for that account. Applied only when the account does not exist.

    Deliberately without a default: a deployment that forgets it should fail
    loudly on first start rather than come up with a guessable administrator.
    """

    bootstrap_question_catalogue: bool = True
    """Whether to seed the default catalogue with the three starter questions."""

    docs_enabled: bool = False
    """Whether to serve `/docs`, `/redoc` and the OpenAPI schema.

    Off unless asked for, so a deployment does not publish its entire API
    surface to anyone who asks. Code generation is unaffected either way:
    `scripts/dump_openapi.py` reads the document through `app.openapi()`
    rather than over HTTP.
    """

    jwt_secret: str = ""
    """Signing key for both token types. Required; startup fails without it."""

    totp_encryption_key: str = ""
    """Fernet key protecting stored TOTP secrets. Required; startup fails without it.

    Deliberately not derived from `jwt_secret`. Rotating the signing key is a
    routine act that signs everyone out; if the two were one key it would also
    destroy every enrolment on the system, which is a poor surprise to leave
    lying about for the sake of one line in `.env`.
    """

    vapid_private_key: str = ""
    """Signing key for web push, in PEM or base64url form. Optional.

    **The one secret here that does not stop the server.** The other two guard
    something — a token nobody may forge, a stored TOTP secret nobody may read —
    so a deployment missing them is unsafe and should fail loudly. This one
    switches a feature on. Absent, `/api/push/*` reports that push is not
    configured and the client never offers it, which is a working server with
    one less thing on it rather than a broken one.
    """

    vapid_public_key: str = ""
    """The half handed to the browser, base64url, uncompressed P-256 point."""

    vapid_subject: str = ""
    """Contact for the push service, as `mailto:someone@example.com`.

    From the environment rather than the repository, like the domain: the other
    form the spec accepts is a full HTTPS URL, which would be the deployment's
    own and is exactly what must not be committed.
    """

    jwt_algorithm: str = "HS256"
    """Algorithm used to sign and verify tokens."""

    access_token_ttl: str = "1h"
    """Lifetime of the bearer token presented on each request."""

    refresh_token_ttl: str = "30d"
    """Lifetime of the token that mints new access tokens."""

    password_min_length: int = 8
    """Minimum accepted password length. The only password rule."""

    login_max_attempts: int = 5
    """Failed logins allowed for one username within `login_lockout_window`
    before the next attempt is refused with 429 - regardless of whether that
    username names a real account, so the lockout cannot be used to tell
    which usernames exist."""

    login_lockout_window: str = "15m"
    """How long a failed login counts against a username, as a duration
    string in the same format `access_token_ttl` accepts."""

    @property
    def database_url(self) -> str:
        """Return the SQLAlchemy URL for the configured SQLite file.

        Returns
        -------
        str
            A ``sqlite:///`` URL, or the value of `db_storage` verbatim when it
            already looks like a URL.
        """
        if "://" in self.db_storage:
            return self.db_storage
        return f"sqlite:///{self.db_storage}"

    @property
    def access_ttl(self) -> timedelta:
        """Return `access_token_ttl` as a timedelta.

        Returns
        -------
        datetime.timedelta
            Parsed access token lifetime.
        """
        return _parse_duration(self.access_token_ttl)

    @property
    def refresh_ttl(self) -> timedelta:
        """Return `refresh_token_ttl` as a timedelta.

        Returns
        -------
        datetime.timedelta
            Parsed refresh token lifetime.
        """
        return _parse_duration(self.refresh_token_ttl)

    @property
    def login_lockout_window_delta(self) -> timedelta:
        """Return `login_lockout_window` as a timedelta.

        Returns
        -------
        datetime.timedelta
            Parsed lockout window.
        """
        return _parse_duration(self.login_lockout_window)

    @property
    def push_configured(self) -> bool:
        """Report whether web push has everything it needs.

        All three or none: a key pair with no subject is refused by the push
        services, and a subject with no keys signs nothing. Reporting the group
        as one avoids a half-configured deployment that accepts subscriptions
        and can never send to them.

        Returns
        -------
        bool
            True when the private key, the public key and the subject are set.
        """
        return bool(
            self.vapid_private_key and self.vapid_public_key and self.vapid_subject
        )

    @property
    def signing_key(self) -> str:
        """Return the key used to sign tokens.

        Returns
        -------
        str
            The configured `jwt_secret`.

        Raises
        ------
        RuntimeError
            If `JWT_SECRET` is unset. Generating one instead would sign every
            user out on each restart, and would give each worker of a
            multi-worker deployment a different key.
        """
        if not self.jwt_secret:
            raise RuntimeError(
                "JWT_SECRET is not set. Generate one with "
                "`python -c 'import secrets; print(secrets.token_urlsafe(48))'` "
                "and pass it to the server."
            )
        return self.jwt_secret

    @property
    def totp_key(self) -> str:
        """Return the key protecting stored TOTP secrets.

        Returns
        -------
        str
            The configured `totp_encryption_key`.

        Raises
        ------
        RuntimeError
            If `TOTP_ENCRYPTION_KEY` is unset. Demanded at startup rather than
            at first enrolment: a loud failure at boot is worth more than a
            quiet one at the moment somebody is trying to secure their account.
        """
        if not self.totp_encryption_key:
            raise RuntimeError(
                "TOTP_ENCRYPTION_KEY is not set. Generate one with "
                "`python -c 'from cryptography.fernet import Fernet; "
                "print(Fernet.generate_key().decode())'` "
                "and pass it to the server."
            )
        return self.totp_encryption_key


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide settings instance.

    Returns
    -------
    Settings
        Cached settings, so a generated `jwt_secret` stays stable for the
        lifetime of the process.
    """
    return Settings()
