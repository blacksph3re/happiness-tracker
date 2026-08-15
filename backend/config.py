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

    jwt_secret: str = ""
    """Signing key for both token types. Required; startup fails without it."""

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
