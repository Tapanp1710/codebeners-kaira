import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.exceptions import AppError
from app.schemas.common import error_response

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> Any:
        return error_response(exc.code, exc.message, exc.status_code, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> Any:
        errors = [
            {
                "loc": list(err.get("loc", ())),
                "msg": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ]
        return error_response(
            "VALIDATION_ERROR",
            "The supplied data is invalid.",
            422,
            {"errors": errors},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> Any:
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        code = codes.get(exc.status_code, "HTTP_ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return error_response(code, message, exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> Any:
        logger.exception("Unhandled exception")
        return error_response("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", 500)
