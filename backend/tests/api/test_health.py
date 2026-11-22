def test_health_returns_ok_envelope(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"success": True, "data": {"status": "ok", "service": "KAIRA"}, "error": None}
    assert r.headers.get("x-request-id")


def test_ready_checks_database_and_migrations(client) -> None:
    r = client.get("/ready")
    body = r.json()
    assert r.status_code == 200, body
    assert body["data"]["status"] == "ready"
    checks = body["data"]["checks"]
    assert checks["database"] == "ok"
    assert checks["migrations"] == "current"
    assert checks["voice_provider"] == "not_configured"


def test_versioned_health_and_ready_available(client) -> None:
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/ready").status_code == 200


def test_client_request_id_is_echoed(client) -> None:
    r = client.get("/health", headers={"X-Request-ID": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"


def test_unknown_route_returns_error_envelope(client) -> None:
    r = client.get("/does-not-exist")
    body = r.json()
    assert r.status_code == 404
    assert body["success"] is False
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["data"] is None


def test_method_not_allowed_returns_error_envelope(client) -> None:
    r = client.post("/health")
    assert r.status_code == 405
    assert r.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_cors_allows_frontend_origin_with_credentials(client) -> None:
    r = client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-csrf-token",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert r.headers.get("access-control-allow-credentials") == "true"
    assert "x-csrf-token" in r.headers.get("access-control-allow-headers", "").lower()


def test_cors_rejects_unknown_origin(client) -> None:
    r = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_oversized_body_rejected(client) -> None:
    r = client.post(
        "/api/v1/auth/login", content=b"x" * 1_100_000, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_openapi_lists_required_endpoints(client) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    required = [
        "/api/v1/auth/login",
        "/api/v1/auth/me",
        "/api/v1/business/settings",
        "/api/v1/dashboard",
        "/api/v1/customers",
        "/api/v1/customers/{customer_id}",
        "/api/v1/customers/{customer_id}/invoices",
        "/api/v1/customers/{customer_id}/payments",
        "/api/v1/invoices",
        "/api/v1/invoices/{invoice_id}",
        "/api/v1/invoices/{invoice_id}/payments",
        "/api/v1/payments",
        "/api/v1/receivables",
        "/api/v1/receivables/summary",
        "/api/v1/bills",
        "/api/v1/bills/{bill_id}",
        "/api/v1/bills/{bill_id}/payments",
        "/api/v1/payment-commitments",
        "/api/v1/payment-commitments/{commitment_id}",
        "/api/v1/cashflow/forecast",
        "/api/v1/cashflow/simulate",
        "/api/v1/voice/transcribe",
        "/api/v1/voice/speak",
        "/api/v1/assistant/extract",
        "/api/v1/assistant/query",
        "/api/v1/assistant/reminder",
        "/api/v1/actions",
        "/api/v1/actions/{action_id}",
        "/api/v1/actions/{action_id}/approve",
        "/api/v1/actions/{action_id}/reject",
        "/api/v1/insights",
        "/api/v1/audit-logs",
        "/health",
        "/ready",
    ]
    missing = [p for p in required if p not in paths]
    assert not missing
