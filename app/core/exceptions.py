from typing import Any


class AppError(Exception):
    def __init__(self, code: str, message: str, status_code: int, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


class ValidationAppError(AppError):
    def __init__(self, message: str = "The supplied data is invalid.", details: Any = None):
        super().__init__("VALIDATION_ERROR", message, 422, details)


class BusinessRuleError(AppError):
    """A well-formed request that violates a financial or business rule."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(code, message, 422, details)


class AuthenticationError(AppError):
    def __init__(self, message: str = "Authentication is required.", code: str = "UNAUTHENTICATED"):
        super().__init__(code, message, 401)


class PermissionDeniedError(AppError):
    def __init__(self, message: str = "You do not have permission to perform this action."):
        super().__init__("FORBIDDEN", message, 403)


class CsrfError(AppError):
    def __init__(self) -> None:
        super().__init__("CSRF_FAILED", "Missing or invalid X-CSRF-Token header for a cookie session.", 403)


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
        code: str = "CONFLICT",
    ) -> None:
        super().__init__(code, message, 409, details)


class RateLimitedError(AppError):
    def __init__(self, retry_after: int) -> None:
        super().__init__(
            "RATE_LIMITED",
            "Too many requests. Please wait and try again.",
            429,
            {"retry_after_seconds": retry_after},
        )
        self.retry_after = retry_after


class ServiceUnavailableError(AppError):
    def __init__(
        self,
        message: str = "A required service is unavailable.",
        details: Any = None,
        code: str = "SERVICE_UNAVAILABLE",
    ) -> None:
        super().__init__(code, message, 503, details)


class ProviderNotConfiguredError(ServiceUnavailableError):
    def __init__(self, feature: str) -> None:
        super().__init__(
            f"{feature} is unavailable because SARVAM_API_KEY is not configured. "
            "Typed input continues to work. Add SARVAM_API_KEY to the backend .env and restart.",
            {"missing_setting": "SARVAM_API_KEY"},
            code="PROVIDER_NOT_CONFIGURED",
        )


class ProviderError(AppError):
    def __init__(self, message: str, details: Any = None, status_code: int = 502) -> None:
        super().__init__("PROVIDER_ERROR", message, status_code, details)
