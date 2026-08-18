from tests.conftest import make_user

"""What the server will say about itself, and to whom.

Read-only and administrator-only. The numbers are cheap — one `statvfs`, one
`stat`, two small reads from the cgroup — so there is no rate limit and no
caching; what there is, is a permission, because how full a disk is says
something about the host rather than about anybody's answers.
"""


def metrics(client, headers):
    """Read the server metrics."""
    response = client.get("/api/admin/metrics", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_only_an_administrator_may_read_them(client, admin_headers):
    _, ordinary = make_user(client, admin_headers, "ordinary")

    assert client.get("/api/admin/metrics", headers=ordinary).status_code == 403


def test_metrics_need_a_token(client):
    assert client.get("/api/admin/metrics").status_code == 401


def test_the_version_is_reported(client, admin_headers):
    from version import app_version

    assert metrics(client, admin_headers)["version"] == app_version()


def test_uptime_is_reported_and_grows(client, admin_headers):
    first = metrics(client, admin_headers)

    assert first["uptime_seconds"] >= 0
    assert metrics(client, admin_headers)["uptime_seconds"] >= first["uptime_seconds"]


def test_the_database_size_is_reported(client, admin_headers):
    # The bootstrap wrote an account and a catalogue, so there is a file with
    # something in it.
    assert metrics(client, admin_headers)["database_bytes"] > 0


def test_the_disk_the_database_sits_on_is_reported(client, admin_headers):
    disk = metrics(client, admin_headers)["disk"]

    assert disk["total_bytes"] > 0
    assert disk["free_bytes"] > 0
    assert disk["used_bytes"] + disk["free_bytes"] <= disk["total_bytes"]


def test_memory_is_reported_or_honestly_absent(client, admin_headers):
    # Read from the cgroup, which exists in the container and generally not on a
    # development machine. Absent is a real answer; a made-up number is not.
    memory = metrics(client, admin_headers)["memory"]

    assert memory is None or memory["used_bytes"] > 0
