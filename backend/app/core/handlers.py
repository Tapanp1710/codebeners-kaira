import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.exceptions import AppError, RateLimitedError
from app.schemas.common import error_response

logger = logging.getLogger(__name__)


# Maps each error type to the standard envelope. Called once from main.create_app. Starlette
# picks the handler whose class is the closest match in the exception's MRO, so subclass
# handlers take precedence over the generic Exception handler.
def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> Any:
        headers = None
        if isinstance(exc, RateLimitedError):
            headers = {"Retry-After": str(exc.retry_after)}
        return error_response(exc.code, exc.message, exc.status_code, exc.details, headers)

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

    # Logs only the driver's exception class name, not its message, so SQL parameters and row
    # values are not written to the logs.
    @app.exception_handler(IntegrityError)
    async def _integrity_error(_: Request, exc: IntegrityError) -> Any:
        logger.warning("Integrity error: %s", type(exc.orig).__name__)
        return error_response("CONFLICT", "The request conflicts with existing data. Please retry.", 409)

    # Returned as 503 so clients retry. The raw database error text is never sent to the client.
    @app.exception_handler(OperationalError)
    async def _db_unavailable(_: Request, exc: OperationalError) -> Any:
        logger.error("Database operational error: %s", type(exc.orig).__name__)
        return error_response("DATABASE_UNAVAILABLE", "The database is temporarily unavailable.", 503)

    # Framework 404/405 get stable codes. Other HTTP errors use HTTP_ERROR, and the detail text is
    # used only when it is a string.
    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> Any:
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        code = codes.get(exc.status_code, "HTTP_ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return error_response(code, message, exc.status_code)

    # Catch-all. logger.exception records the traceback server-side; the client sees only a
    # generic message.
    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> Any:
        logger.exception("Unhandled exception")
        return error_response("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", 500)
