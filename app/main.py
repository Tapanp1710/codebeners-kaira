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
from app.core.rate_limit import RateLimiter
from app.core.security import CSRF_HEADER
from app.db.session import build_engine, build_session_factory
from app.integrations.sarvam import SarvamClient

logger = logging.getLogger("kaira")

API_VERSION = "1.0.0"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.LOG_LEVEL, settings.LOG_FORMAT)
    engine = build_engine(settings)

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
    app.state.rate_limiter = RateLimiter()
    app.state.sarvam = SarvamClient(settings)
    app.state.ready = False

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
    app.include_router(health.router)
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
    return app


app = create_app()
