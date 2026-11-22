from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.core.config import Settings
from app.core.security import ACCESS_COOKIE, REFRESH_COOKIE
from app.db.dependencies import Auth, DbSession, SettingsDep
from app.schemas.common import Envelope, ok
from app.schemas.core import BusinessOut, LoginRequest, SessionOut, UserOut
from app.services import audit_service, auth_service
from app.services.auth_service import IssuedSession

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_cookies(response: Response, settings: Settings, issued: IssuedSession) -> None:
    common = {
        "httponly": True,
        "secure": settings.COOKIE_SECURE,
        "samesite": settings.COOKIE_SAMESITE,
        "domain": settings.COOKIE_DOMAIN,
    }
    response.set_cookie(
        ACCESS_COOKIE,
        issued.access_token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
        **common,
    )
    response.set_cookie(
        REFRESH_COOKIE,
        issued.refresh_token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path=f"{settings.API_V1_PREFIX}/auth",
        **common,
    )


def _clear_cookies(response: Response, settings: Settings) -> None:
    common = {
        "httponly": True,
        "secure": settings.COOKIE_SECURE,
        "samesite": settings.COOKIE_SAMESITE,
        "domain": settings.COOKIE_DOMAIN,
    }
    response.delete_cookie(ACCESS_COOKIE, path="/", **common)
    response.delete_cookie(REFRESH_COOKIE, path=f"{settings.API_V1_PREFIX}/auth", **common)


def _session_out(db, issued: IssuedSession) -> SessionOut:
    from app.models import Business

    business = db.get(Business, issued.user.business_id)
    return SessionOut(
        user=UserOut.model_validate(issued.user),
        business=BusinessOut.model_validate(business),
        csrf_token=issued.csrf_token,
        access_token_expires_at=issued.access_expires_at,
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=Envelope[SessionOut], summary="Sign in (sets HttpOnly cookies)")
def login(body: LoginRequest, request: Request, response: Response, db: DbSession, settings: SettingsDep):
    limiter = request.app.state.rate_limiter
    limiter.check(f"login:ip:{_client_ip(request)}", settings.RATE_LIMIT_LOGIN_PER_MINUTE)
    limiter.check(f"login:email:{body.email.lower()}", settings.RATE_LIMIT_LOGIN_PER_MINUTE)
    user = auth_service.authenticate(db, body.email, body.password)
    issued = auth_service.issue_session(db, settings, user)
    audit_service.record(
        db,
        business_id=user.business_id,
        user_id=user.id,
        action_type="auth.login",
        entity_type="user",
        entity_id=user.id,
    )
    db.commit()
    _set_cookies(response, settings, issued)
    return ok(_session_out(db, issued))


@router.post(
    "/refresh",
    response_model=Envelope[SessionOut],
    summary="Rotate the refresh cookie and issue a new access cookie + CSRF token",
)
def refresh(request: Request, response: Response, db: DbSession, settings: SettingsDep):
    issued = auth_service.rotate_refresh(db, settings, request.cookies.get(REFRESH_COOKIE))
    db.commit()
    _set_cookies(response, settings, issued)
    return ok(_session_out(db, issued))


@router.post("/logout", response_model=Envelope[dict], summary="Revoke the session and clear cookies")
def logout(request: Request, response: Response, db: DbSession, settings: SettingsDep):
    auth_service.revoke(db, request.cookies.get(REFRESH_COOKIE))
    db.commit()
    _clear_cookies(response, settings)
    return ok({"logged_out": True})


@router.get("/me", response_model=Envelope[SessionOut], summary="Current user, business and CSRF token")
def me(ctx: Auth, db: DbSession, settings: SettingsDep, request: Request):
    from app.core.security import decode_access_token

    token = request.headers.get("authorization", "")[7:].strip() or request.cookies.get(ACCESS_COOKIE)
    claims = decode_access_token(settings, token)
    return ok(
        SessionOut(
            user=UserOut.model_validate(ctx.user),
            business=BusinessOut.model_validate(ctx.business),
            csrf_token=ctx.csrf,
            access_token_expires_at=claims.expires_at,
        )
    )
