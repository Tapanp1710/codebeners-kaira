def test_health_returns_ok_envelope(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "success": True,
        "data": {"status": "ok", "service": "KAIRA"},
        "error": None,
    }


def test_ready_reports_application_ready_and_database_not_implemented(client) -> None:
    r = client.get("/ready")
    body = r.json()
    assert r.status_code == 200
    assert body["success"] is True
    assert body["data"]["status"] == "ready"
    assert body["data"]["checks"] == {"application": "ok", "database": "not_implemented"}


def test_versioned_health_available(client) -> None:
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "ok"


def test_versioned_ready_available(client) -> None:
    assert client.get("/api/v1/ready").status_code == 200


def test_unknown_route_returns_error_envelope(client) -> None:
    r = client.get("/does-not-exist")
    body = r.json()
    assert r.status_code == 404
    assert body["success"] is False
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["data"] is None


def test_method_not_allowed_returns_error_envelope(client) -> None:
    r = client.post("/health")
    body = r.json()
    assert r.status_code == 405
    assert body["success"] is False
    assert body["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_cors_allows_frontend_origin(client) -> None:
    r = client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_cors_rejects_unknown_origin(client) -> None:
    r = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers
