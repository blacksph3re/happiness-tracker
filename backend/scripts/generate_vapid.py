"""Print a VAPID key pair for `.env`.

Web push signs every message with a key pair the deployment owns, so the push
service can tell one sender from another. Both halves go in `.env`; neither
belongs in the repository, and neither goes in the database — a database backup
already carries password hashes and encrypted TOTP secrets without also
carrying the keys that unlock things.

**Rotating these re-enrols every device, silently**, because nothing tells the
browsers. Generate once and keep them.

Run from `backend/`::

    uv run python scripts/generate_vapid.py
"""

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402


def urlsafe(raw: bytes) -> str:
    """Encode bytes the way both the browser and the push service expect.

    Parameters
    ----------
    raw : bytes
        The value to encode.

    Returns
    -------
    str
        Base64url without padding.
    """
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def main_() -> None:
    """Print a fresh P-256 pair in the form the settings read."""
    private = ec.generate_private_key(ec.SECP256R1())
    # The raw scalar rather than a PEM: it is one line, which is what `.env`
    # wants, and `py_vapid` reads it directly.
    secret = private.private_numbers().private_value.to_bytes(32, "big")
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    print(f"VAPID_PRIVATE_KEY={urlsafe(secret)}")
    print(f"VAPID_PUBLIC_KEY={urlsafe(public)}")
    print("VAPID_SUBJECT=mailto:you@example.com")


if __name__ == "__main__":
    main_()
