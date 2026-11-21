from typing import Any


class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


class NotFoundError(AppError):
    def __init__(
        self,
        message: str = "The requested resource was not found.",
        details: Any = None,
    ) -> None:
        super().__init__("NOT_FOUND", message, 404, details)


class ConflictError(AppError):
    def __init__(
        self,
        message: str = "The request conflicts with the current state.",
        details: Any = None,
    ) -> None:
        super().__init__("CONFLICT", message, 409, details)


class ServiceUnavailableError(AppError):
    def __init__(
        self,
        message: str = "A required service is unavailable.",
        details: Any = None,
    ) -> None:
        super().__init__("SERVICE_UNAVAILABLE", message, 503, details)
