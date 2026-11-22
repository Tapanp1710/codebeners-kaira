"""FastAPI dependencies: database session, authenticated context, roles and CSRF."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.exceptions import AuthenticationError, CsrfError, PermissionDeniedError
from app.core.security import (
    ACCESS_COOKIE,
    CSRF_HEADER,
    constant_time_equals,
    decode_access_token,
)
from app.models import Business, User

# Methods exempt from the CSRF check. Only cookie-authenticated requests are checked; bearer
# requests skip CSRF entirely.
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


# One session per request. No commit happens here; the generator only closes the session when
# the request finishes.
def get_db(request: Request) -> Iterator[Session]:
    session: Session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


DbSession = Annotated[Session, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]


@dataclass(frozen=True)
class AuthContext:
    """The authenticated principal. Every business-owned query is scoped by business_id."""

    user_id: uuid.UUID
    business_id: uuid.UUID
    role: str
    csrf: str
    user: User
    business: Business

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


def get_auth_context(request: Request, db: DbSession, settings: SettingsDep) -> AuthContext:
    token: str | None = None
    via_cookie = False
    # A bearer header takes precedence over the cookie. A bearer request with an invalid token
    # does not fall back to the cookie.
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
    else:
        token = request.cookies.get(ACCESS_COOKIE)
        via_cookie = token is not None
    if not token:
        raise AuthenticationError()
    claims = decode_access_token(settings, token)
    if claims is None:
        raise AuthenticationError("Your session has expired or is invalid.", "SESSION_EXPIRED")

    # CSRF is enforced only for cookie auth on unsafe methods. The header must equal the csrf
    # claim inside the access token.
    if via_cookie and request.method not in SAFE_METHODS:
        if not constant_time_equals(request.headers.get(CSRF_HEADER), claims.csrf):
            raise CsrfError()

    # Re-checked against the database on every request. A deactivated user, or one whose business
    # no longer matches the token, is rejected even when the token itself is valid.
    user = db.get(User, claims.user_id)
    if user is None or not user.is_active or user.business_id != claims.business_id:
        raise AuthenticationError("This account is not active.", "ACCOUNT_INACTIVE")
    business = db.get(Business, user.business_id)
    if business is None:
        raise AuthenticationError("This account is not active.", "ACCOUNT_INACTIVE")
    return AuthContext(
        user_id=user.id,
        business_id=user.business_id,
        role=user.role,
        csrf=claims.csrf,
        user=user,
        business=business,
    )


# Route parameter alias: declaring "ctx: Auth" runs the full authentication chain above.
Auth = Annotated[AuthContext, Depends(get_auth_context)]


# Role check only; no database query. Depends on Auth, so authentication runs first.
def require_owner(ctx: Auth) -> AuthContext:
    if not ctx.is_owner:
        raise PermissionDeniedError("Only the business owner can perform this action.")
    return ctx


OwnerAuth = Annotated[AuthContext, Depends(require_owner)]
