from tests.conftest import TEST_PASSWORD, Api, add_user, make_business


def test_login_sets_httponly_cookies_and_returns_csrf(client, db):
    _, user = make_business(db)
    r = client.post("/api/v1/auth/login", json={"email": user.email, "password": TEST_PASSWORD})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["user"]["email"] == user.email
    assert data["user"]["role"] == "owner"
    assert data["csrf_token"]
    assert "password_hash" not in str(data)
    cookies = r.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith("kaira_access="))
    refresh = next(c for c in cookies if c.startswith("kaira_refresh="))
    assert "HttpOnly" in access and "HttpOnly" in refresh
    assert "Path=/api/v1/auth" in refresh
    assert "samesite=lax" in access.lower()


def test_login_rejects_wrong_password_without_revealing_which_field(client, db):
    _, user = make_business(db)
    r1 = client.post("/api/v1/auth/login", json={"email": user.email, "password": "nope"})
    r2 = client.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "nope"})
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["error"] == r2.json()["error"]


def test_inactive_user_cannot_log_in(client, db):
    _, user = make_business(db)
    user.is_active = False
    db.commit()
    r = client.post("/api/v1/auth/login", json={"email": user.email, "password": TEST_PASSWORD})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "ACCOUNT_INACTIVE"


def test_me_requires_authentication(client):
    r = client.get("/api/v1/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"


def test_me_returns_identity_and_business(owner):
    data = owner.data(owner.get("/auth/me"))
    assert data["user"]["id"] == str(owner.user.id)
    assert data["business"]["currency"] == "INR"
    assert data["csrf_token"] == owner.csrf


def test_cookie_session_requires_csrf_on_unsafe_methods(owner):
    r = owner.client.post("/api/v1/customers", json={"name": "No CSRF"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "CSRF_FAILED"
    r = owner.client.post("/api/v1/customers", json={"name": "Bad"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403
    assert owner.post("/customers", {"name": "With CSRF"}).status_code == 201


def test_bearer_token_works_without_csrf(app, db):
    from fastapi.testclient import TestClient

    from app.core.security import create_access_token

    business, user = make_business(db)
    token, _ = create_access_token(
        app.state.settings, user_id=user.id, business_id=business.id, role="owner", csrf="x"
    )
    with TestClient(app) as fresh:
        r = fresh.post(
            "/api/v1/customers", json={"name": "Bearer"}, headers={"Authorization": f"Bearer {token}"}
        )
    assert r.status_code == 201


def test_tampered_token_rejected(client):
    r = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer abc.def.ghi"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "SESSION_EXPIRED"


def test_refresh_rotates_and_detects_reuse(client, db):
    _, user = make_business(db)
    api = Api(client, user.email)
    old_refresh = client.cookies.get("kaira_refresh")
    r = client.post("/api/v1/auth/refresh")
    assert r.status_code == 200
    new_csrf = r.json()["data"]["csrf_token"]
    assert new_csrf != api.csrf
    assert client.cookies.get("kaira_refresh") != old_refresh
    # Re-using the old (revoked) refresh token revokes the whole family.
    client.cookies.set("kaira_refresh", old_refresh, path="/api/v1/auth")
    r = client.post("/api/v1/auth/refresh")
    assert r.status_code == 401


def test_logout_revokes_refresh_token(client, db):
    _, user = make_business(db)
    api = Api(client, user.email)
    refresh = client.cookies.get("kaira_refresh")
    assert api.post("/auth/logout").status_code == 200
    client.cookies.set("kaira_refresh", refresh, path="/api/v1/auth")
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_login_rate_limited(app, db):
    from fastapi.testclient import TestClient

    app.state.settings.RATE_LIMIT_LOGIN_PER_MINUTE = 3
    _, user = make_business(db)
    with TestClient(app) as c:
        codes = [
            c.post("/api/v1/auth/login", json={"email": user.email, "password": "x"}).status_code
            for _ in range(4)
        ]
    assert codes[:3] == [401, 401, 401]
    assert codes[3] == 429


def test_staff_cannot_change_settings_or_approve(client, db):
    business, _ = make_business(db)
    staff = add_user(db, business, "staff")
    api = Api(client, staff.email)
    r = api.patch("/business/settings", {"name": "Hacked"})
    assert r.status_code == 403
    r = api.post("/actions/00000000-0000-0000-0000-000000000000/approve")
    assert r.status_code == 403


def test_owner_updates_settings_with_audit(owner):
    data = owner.data(
        owner.patch("/business/settings", {"opening_cash_balance": "75000", "low_cash_threshold": "5000"})
    )
    assert data["opening_cash_balance"] == "75000.00"
    logs = owner.data(owner.get("/audit-logs", params={"entity_type": "business"}))
    assert logs["items"][0]["action_type"] == "business.settings_updated"
