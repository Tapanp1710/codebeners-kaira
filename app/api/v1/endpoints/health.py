from fastapi import APIRouter, Request

from app.db.session import database_is_reachable
from app.schemas.common import error_response, success_response

router = APIRouter(tags=["operational"])


@router.get("/health", summary="Liveness: the process is running")
def health(request: Request):
    return success_response({"status": "ok", "service": request.app.state.settings.APP_NAME})


@router.get("/ready", summary="Readiness: the database is reachable and migrations are current")
def ready(request: Request):
    state = request.app.state
    settings = state.settings
    db_ok = database_is_reachable(state.engine)
    migrations = "unknown"
    if db_ok:
        from app.db.migrations import migration_status

        migrations = migration_status(state.engine)
    checks = {
        "application": "ok" if getattr(state, "ready", False) else "starting",
        "database": "ok" if db_ok else "unreachable",
        "migrations": migrations,
        "voice_provider": "configured" if settings.sarvam_configured else "not_configured",
        "extraction_provider": settings.extraction_provider,
    }
    if checks["application"] == "ok" and db_ok and migrations == "current":
        return success_response({"status": "ready", "checks": checks})
    return error_response("NOT_READY", "The application is not ready.", 503, {"checks": checks})
