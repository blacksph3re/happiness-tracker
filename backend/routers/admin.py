import shutil
import time
from pathlib import Path

from fastapi import APIRouter

from config import get_settings
from deps import AdminUser
from schemas import DiskUsage, MemoryUsage, ServerMetrics
from version import app_version

router = APIRouter(prefix="/admin", tags=["Users"])

STARTED_AT = time.monotonic()
"""When this process began serving, as a monotonic reading.

Monotonic rather than wall-clock: uptime is a duration, and a duration measured
against a clock that can be stepped by NTP is a duration that can go backwards.
"""

CGROUP = Path("/sys/fs/cgroup")
"""Where a containerised process reads its own limits. Absent off a container."""


def _memory() -> MemoryUsage | None:
    """Return the container's memory usage, or None where it cannot be read.

    Reads cgroup v2 directly because the runtime image is distroless: there is
    no shell and nothing to shell out to, and the interpreter reading two small
    files is the whole of what is available.

    Returns
    -------
    MemoryUsage or None
        None on a machine with no cgroup — a development box, typically — where
        an invented number would be worse than an admitted gap.
    """
    try:
        used = int((CGROUP / "memory.current").read_text())
    except OSError, ValueError:
        return None
    try:
        raw = (CGROUP / "memory.max").read_text().strip()
        # "max" is the cgroup saying there is no ceiling, which is not a number
        # and must not be reported as one.
        limit = None if raw == "max" else int(raw)
    except OSError, ValueError:
        limit = None
    return MemoryUsage(used_bytes=used, limit_bytes=limit)


def _database_path() -> Path:
    """Return the SQLite file the application is writing to.

    Returns
    -------
    pathlib.Path
        The configured path, which is a file under the mounted volume in a
        deployment and a local file in development.
    """
    return Path(get_settings().db_storage)


@router.get(
    "/metrics",
    response_model=ServerMetrics,
    operation_id="getServerMetrics",
    summary="A glance at the running server",
    description=(
        "The running version, how long this process has been serving, and how "
        "much room is left on the volume holding the database. Requires the "
        "user-management permission."
    ),
)
def get_metrics(admin: AdminUser) -> ServerMetrics:
    """Report a few cheap facts about the running server.

    Read-only, and cheap enough to need no caching: one ``statvfs``, one
    ``stat``, and two small reads from the cgroup.

    Parameters
    ----------
    admin : User
        The authenticated administrator.

    Returns
    -------
    ServerMetrics
        The version, uptime, database size, disk and memory.
    """
    database = _database_path()
    # The directory rather than the file: the file may not exist yet on a very
    # first boot, and it is the volume's free space that is being asked about.
    usage = shutil.disk_usage(database.parent if database.parent.parts else Path())
    return ServerMetrics(
        version=app_version(),
        uptime_seconds=int(time.monotonic() - STARTED_AT),
        database_bytes=database.stat().st_size if database.is_file() else 0,
        disk=DiskUsage(
            total_bytes=usage.total, used_bytes=usage.used, free_bytes=usage.free
        ),
        memory=_memory(),
    )
