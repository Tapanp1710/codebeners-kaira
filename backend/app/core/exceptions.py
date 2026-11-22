from typing import Any


# Base for all domain errors. handlers.py turns any AppError into the {success, data, error}
# envelope using code, message, status_code and details.
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


# 401. Default code is UNAUTHENTICATED; dependencies.py passes SESSION_EXPIRED and
# ACCOUNT_INACTIVE explicitly.
class AuthenticationError(AppError):
    def __init__(self, message: str = "Authentication is required.", code: str = "UNAUTHENTICATED"):
        super().__init__(code, message, 401)


class PermissionDeniedError(AppError):
    def __init__(self, message: str = "You do not have permission to perform this action."):
        super().__init__("FORBIDDEN", message, 403)


# 403, raised by get_auth_context when a cookie-authenticated unsafe request lacks a matching
# X-CSRF-Token header.
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


# retry_after is kept as an attribute and also placed in details. handlers.py sets the
# Retry-After response header from it.
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


# Raised before any provider call when SARVAM_API_KEY is empty. The message tells the owner
# that typed input still works.
class ProviderNotConfiguredError(ServiceUnavailableError):
    def __init__(self, feature: str) -> None:
        super().__init__(
            f"{feature} is unavailable because SARVAM_API_KEY is not configured. "
            "Typed input continues to work. Add SARVAM_API_KEY to the backend .env and restart.",
            {"missing_setting": "SARVAM_API_KEY"},
            code="PROVIDER_NOT_CONFIGURED",
        )


# Upstream provider failure, 502 by default. It is an AppError subclass, so the generic
# AppError handler in handlers.py serves it.
class ProviderError(AppError):
    def __init__(self, message: str, details: Any = None, status_code: int = 502) -> None:
        super().__init__("PROVIDER_ERROR", message, status_code, details)
