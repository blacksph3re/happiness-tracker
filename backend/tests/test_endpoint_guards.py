"""Every endpoint is authenticated unless it is on the list that may not be.

An audit that runs. The alternative is reading `routers/` and hoping, which is
the same bet the ownership sweep lost twice: nothing about a new endpoint looks
wrong while it is the only one missing its guard.
"""

from deps import get_current_user, require_admin
from main import app

PUBLIC = {
    ("GET", "/api/version"),
    ("POST", "/api/login"),
    ("POST", "/api/login/totp"),
    ("POST", "/api/refresh"),
}
"""The only endpoints that may be reached without a token.

`/api/refresh` carries its own credential in the body and mints nothing without
a valid refresh token; the other three are the front door and the version the
About screen reads back.
"""

ADMIN = {
    ("DELETE", "/api/users/{user_id}"),
    ("DELETE", "/api/users/{user_id}/totp"),
    ("GET", "/api/admin/metrics"),
    ("GET", "/api/users"),
    ("POST", "/api/users"),
    ("PUT", "/api/users/{user_id}"),
    ("PUT", "/api/users/{user_id}/password"),
}
"""Everything behind `is_admin`, which is only ever about managing accounts."""


def _endpoints():
    """Yield ``(method, path, guards)`` for every API route the app serves."""

    def walk(routes):
        for route in routes:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                yield from walk(inner.routes)
            elif hasattr(route, "dependant"):
                yield route

    for route in walk(app.routes):
        path = route.path if route.path.startswith("/api") else f"/api{route.path}"
        names, stack, seen = set(), [route.dependant], set()
        while stack:
            dependency = stack.pop()
            if id(dependency) in seen:
                continue
            seen.add(id(dependency))
            if dependency.call is not None:
                names.add(dependency.call)
            stack.extend(dependency.dependencies)
        for method in (route.methods or set()) - {"HEAD", "OPTIONS"}:
            yield method, path, names


def test_no_endpoint_is_reachable_without_a_token_unless_listed():
    open_to_all = {
        (method, path)
        for method, path, guards in _endpoints()
        if get_current_user not in guards and require_admin not in guards
    }
    assert open_to_all == PUBLIC


def test_the_admin_only_endpoints_are_exactly_the_account_management_ones():
    behind_admin = {
        (method, path)
        for method, path, guards in _endpoints()
        if require_admin in guards
    }
    assert behind_admin == ADMIN


def test_every_other_endpoint_resolves_the_caller():
    unguarded = [
        (method, path)
        for method, path, guards in _endpoints()
        if (method, path) not in PUBLIC and get_current_user not in guards
    ]
    assert unguarded == []
