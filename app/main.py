from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.endpoints import health
from app.api.v1.router import api_router
from app.core.config import Settings, get_settings
from app.core.handlers import register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import BodySizeLimitMiddleware, RequestContextMiddleware
from app.core.rate_limit import PostgresRateLimiter, RateLimiter
from app.core.security import CSRF_HEADER
from app.db.session import build_engine, build_session_factory
from app.integrations.sarvam import SarvamClient

logger = logging.getLogger("kaira")

API_VERSION = "1.0.0"


# Application factory. Wires shared state (settings, engine, session factory, rate limiter,
# Sarvam client) onto app.state and registers exception handlers and middleware.
# The module-level `app = create_app()` at the bottom is the ASGI entry point; cli.py calls
# create_app again for export-openapi.
def create_app(settings: Settings | None = None) -> FastAPI:
    # An explicit Settings (e.g. from cli.py) is used as-is; otherwise the cached
    # get_settings() reads .env and the process environment.
    settings = settings or get_settings()
    # Runs before any logging call. configure_logging removes only handlers it created earlier
    # (marked _kaira), so calling create_app more than once does not duplicate output.
    configure_logging(settings.LOG_LEVEL, settings.LOG_FORMAT)
    # Lazy: no connection is opened until first use. Shared via app.state, disposed on shutdown.
    engine = build_engine(settings)

    # Startup/shutdown hook. Migrations (if enabled) run synchronously during startup and block
    # the event loop until finished; app.state.ready is set only after they succeed.
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.RUN_MIGRATIONS_ON_START:
            from app.db.migrations import upgrade_to_head

            logger.info("Applying database migrations")
            upgrade_to_head(settings.DATABASE_URL)
        app.state.ready = True
        logger.info(
            "KAIRA API started",
            extra={"path": settings.API_V1_PREFIX},
        )
        yield
        app.state.ready = False
        # Shutdown: clear readiness first, then release pooled database connections.
        engine.dispose()
        logger.info("KAIRA API stopped")

    app = FastAPI(
        title=f"{settings.APP_NAME} API",
        version=API_VERSION,
        description=(
            "KAIRA - voice-first business operations backend. All endpoints return the "
            "envelope {success, data, error}. Money is a decimal string, dates are ISO 8601. "
            "Browser clients authenticate with HttpOnly cookies and must send X-CSRF-Token on "
            "unsafe methods; see docs/API_CONTRACT.md."
        ),
        debug=settings.DEBUG,
        docs_url="/docs",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = build_session_factory(engine)
    # Shared across workers and containers by default (PostgreSQL); "memory" is single-process only.
    app.state.rate_limiter = (
        PostgresRateLimiter(engine) if settings.RATE_LIMIT_BACKEND == "postgres" else RateLimiter()
    )
    # Construction does no network I/O. A missing SARVAM_API_KEY surfaces per call, not at startup.
    app.state.sarvam = SarvamClient(settings)
    app.state.ready = False

    # Exception handlers are registered first. Middleware is added below; Starlette wraps the
    # most recently added middleware outermost, so RequestContextMiddleware runs first.
    register_exception_handlers(app)
    app.add_middleware(
        BodySizeLimitMiddleware,
        default_limit=settings.MAX_REQUEST_BYTES,
        upload_limit=settings.MAX_AUDIO_UPLOAD_BYTES,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", CSRF_HEADER, "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Retry-After"],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware)
    # Health routes are mounted at the root, outside API_V1_PREFIX and the versioned router.
    app.include_router(health.router)
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
    return app


app = create_app()
