from fastapi import APIRouter, Request

from app.core.config import get_settings
from app.schemas.common import error_response, success_response

router = APIRouter()


@router.get("/health")
async def health():
    return success_response({"status": "ok", "service": get_settings().APP_NAME})


@router.get("/ready")
async def ready(request: Request):
    if getattr(request.app.state, "ready", False) is True:
        return success_response(
            {"status": "ready", "checks": {"application": "ok", "database": "not_implemented"}}
        )
    return error_response("NOT_READY", "The application is not ready.", 503)
