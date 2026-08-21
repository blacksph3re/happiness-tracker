from tests.conftest import make_user

# Mirrors what the `push_client` fixture configures. Not real keys: nothing here
# signs anything, and phase one does not send.
PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkTtGxhY0eSl5m0nP2b8YtQ0Xk"

SUBSCRIPTION = {
    "endpoint": "https://push.example.com/send/abc123",
    "p256dh": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkTtGxhY0eSl5m0nP2b8",
    "auth": "kZ3Yh1L2m3N4o5P6q7R8s9",
    "label": "Phone",
}


def test_push_reports_itself_unconfigured_without_keys(client, admin_headers):
    response = client.get("/api/push/key", headers=admin_headers)

    # Not an error: a server without VAPID keys is a working server with one
    # less feature, and the client has to be able to tell without guessing.
    assert response.status_code == 200
    assert response.json() == {"configured": False, "public_key": None}


def test_subscribing_is_refused_when_push_is_not_configured(client, admin_headers):
    response = client.post(
        "/api/push/subscriptions", headers=admin_headers, json=SUBSCRIPTION
    )

    # Accepting one would be storing an address nothing can ever send to.
    assert response.status_code == 503


def test_the_public_key_is_offered_when_configured(push_client, push_headers):
    response = push_client.get("/api/push/key", headers=push_headers)

    assert response.status_code == 200
    assert response.json() == {
        "configured": True,
        "public_key": PUBLIC_KEY,
    }


def test_a_browser_can_register_and_is_listed(push_client, push_headers):
    created = push_client.post(
        "/api/push/subscriptions", headers=push_headers, json=SUBSCRIPTION
    )
    assert created.status_code == 201, created.text

    listed = push_client.get("/api/push/subscriptions", headers=push_headers).json()
    assert len(listed) == 1
    assert listed[0]["label"] == "Phone"
    # The endpoint is never sent back: it is a capability URL, and anything
    # holding it can push to that browser.
    assert "endpoint" not in listed[0]


def test_registering_twice_keeps_one_row(push_client, push_headers):
    push_client.post("/api/push/subscriptions", headers=push_headers, json=SUBSCRIPTION)
    again = push_client.post(
        "/api/push/subscriptions",
        headers=push_headers,
        json={**SUBSCRIPTION, "label": "Phone, renamed"},
    )

    # The client re-registers on every launch by design, so this is the common
    # path rather than an edge case.
    assert again.status_code == 201
    listed = push_client.get("/api/push/subscriptions", headers=push_headers).json()
    assert len(listed) == 1
    assert listed[0]["label"] == "Phone, renamed"


def test_a_browser_can_unregister(push_client, push_headers):
    push_client.post("/api/push/subscriptions", headers=push_headers, json=SUBSCRIPTION)

    removed = push_client.request(
        "DELETE",
        "/api/push/subscriptions",
        headers=push_headers,
        json={"endpoint": SUBSCRIPTION["endpoint"]},
    )

    assert removed.status_code == 204
    assert push_client.get("/api/push/subscriptions", headers=push_headers).json() == []


def test_unregistering_something_absent_is_not_an_error(push_client, push_headers):
    # A browser that revoked permission tells the server on its next launch,
    # which may be after the row was already pruned.
    removed = push_client.request(
        "DELETE",
        "/api/push/subscriptions",
        headers=push_headers,
        json={"endpoint": "https://push.example.com/send/never-existed"},
    )

    assert removed.status_code == 204


def test_one_account_never_sees_another_device(
    push_client, push_headers, admin_headers
):
    push_client.post("/api/push/subscriptions", headers=push_headers, json=SUBSCRIPTION)
    _, other = make_user(push_client, push_headers, "mallory")

    assert push_client.get("/api/push/subscriptions", headers=other).json() == []


def test_claiming_another_accounts_endpoint_takes_it_over(push_client, push_headers):
    push_client.post("/api/push/subscriptions", headers=push_headers, json=SUBSCRIPTION)
    _, other = make_user(push_client, push_headers, "mallory")

    taken = push_client.post(
        "/api/push/subscriptions", headers=other, json=SUBSCRIPTION
    )

    # One browser, one endpoint. Signing in as somebody else on the same device
    # moves the subscription rather than duplicating it — the alternative is
    # sending one person's notifications to the other's screen.
    assert taken.status_code == 201
    assert push_client.get("/api/push/subscriptions", headers=push_headers).json() == []
    assert len(push_client.get("/api/push/subscriptions", headers=other).json()) == 1
