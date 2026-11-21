from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Any = None


def success_response(data: Any = None, status_code: int = 200) -> JSONResponse:
    body = {"success": True, "data": jsonable_encoder(data), "error": None}
    return JSONResponse(status_code=status_code, content=body)


def error_response(code: str, message: str, status_code: int, details: Any = None) -> JSONResponse:
    error = ErrorDetail(code=code, message=message, details=jsonable_encoder(details))
    body = {"success": False, "data": None, "error": error.model_dump()}
    return JSONResponse(status_code=status_code, content=body)
