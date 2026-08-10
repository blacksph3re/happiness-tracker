import secrets
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

    admin_password: str = "admin"
    """Password for that account. Applied only when the account does not exist."""

    bootstrap_question_catalogue: bool = True
    """Whether to seed the default catalogue with the three starter questions."""

    jwt_secret: str = ""
    """Signing key for both token types. A random key is generated when unset."""

    jwt_algorithm: str = "HS256"
    """Algorithm used to sign and verify tokens."""

    access_token_ttl: str = "1h"
    """Lifetime of the bearer token presented on each request."""

    refresh_token_ttl: str = "30d"
    """Lifetime of the token that mints new access tokens."""

    password_min_length: int = 8
    """Minimum accepted password length. The only password rule."""

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
    def signing_key(self) -> str:
        """Return the key used to sign tokens.

        Returns
        -------
        str
            `jwt_secret` when set, otherwise a key generated once per process.
        """
        if not self.jwt_secret:
            self.jwt_secret = secrets.token_urlsafe(48)
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
