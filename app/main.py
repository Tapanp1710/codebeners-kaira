from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.endpoints import health
from app.api.v1.router import api_router
from app.core.config import Settings, get_settings
from app.core.handlers import register_exception_handlers
from app.core.logging import configure_logging


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging()
    app = FastAPI(
        title=f"{settings.APP_NAME} API",
        version="0.1.0",
        debug=settings.DEBUG,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
    app.state.ready = True
    return app


app = create_app()
