"""Response envelope, pagination and shared field types.

Money is always transported as a decimal string with two places (e.g. "5000.00"),
dates as ISO 8601 (YYYY-MM-DD) and timestamps as ISO 8601 UTC."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any, Generic, TypeVar

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

T = TypeVar("T")


def _money_str(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.01")), "f")


# Output money: serialised as "1234.50".
MoneyOut = Annotated[Decimal, PlainSerializer(_money_str, return_type=str, when_used="json")]
# Input money: positive, at most 2 decimal places. Accepts "5000", "5000.50" or 5000.
MoneyIn = Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=2)]
MoneyInNonNeg = Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Any = None


class Envelope(BaseModel, Generic[T]):
    success: bool = True
    data: T | None = None
    error: ErrorDetail | None = None


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


def ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


def success_response(data: Any = None, status_code: int = 200) -> JSONResponse:
    body = {"success": True, "data": jsonable_encoder(data), "error": None}
    return JSONResponse(status_code=status_code, content=body)


def error_response(
    code: str,
    message: str,
    status_code: int,
    details: Any = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    error = ErrorDetail(code=code, message=message, details=jsonable_encoder(details))
    body = {"success": False, "data": None, "error": error.model_dump()}
    return JSONResponse(status_code=status_code, content=body, headers=headers)
