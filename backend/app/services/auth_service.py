from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.exceptions import AuthenticationError
from app.core.security import (
    create_access_token,
    hash_refresh_token,
    new_csrf_token,
    new_refresh_token,
    verify_password,
)
from app.models import RefreshToken, User


@dataclass
class IssuedSession:
    user: User
    access_token: str
    access_expires_at: datetime
    refresh_token: str
    refresh_expires_at: datetime
    csrf_token: str


def authenticate(db: Session, email: str, password: str) -> User:
    user = db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
    valid = verify_password(password, user.password_hash if user else None)
    if not valid or user is None:
        raise AuthenticationError("Incorrect e-mail or password.", "INVALID_CREDENTIALS")
    if not user.is_active:
        raise AuthenticationError("This account is not active.", "ACCOUNT_INACTIVE")
    return user


def issue_session(db: Session, settings: Settings, user: User) -> IssuedSession:
    csrf = new_csrf_token()
    access, access_exp = create_access_token(
        settings, user_id=user.id, business_id=user.business_id, role=user.role, csrf=csrf
    )
    refresh = new_refresh_token()
    refresh_exp = datetime.now(UTC) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    db.add(RefreshToken(user_id=user.id, token_hash=hash_refresh_token(refresh), expires_at=refresh_exp))
    db.flush()
    return IssuedSession(user, access, access_exp, refresh, refresh_exp, csrf)


def rotate_refresh(db: Session, settings: Settings, refresh_token: str | None) -> IssuedSession:
    """Exchange a valid refresh token for a new session; the old token is revoked.

    Re-use of an already-revoked token revokes every session of that user (theft signal)."""
    if not refresh_token:
        raise AuthenticationError("Your session has expired. Please sign in again.", "SESSION_EXPIRED")
    record = db.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
        .with_for_update()
    )
    now = datetime.now(UTC)
    if record is None:
        raise AuthenticationError("Your session has expired. Please sign in again.", "SESSION_EXPIRED")
    if record.revoked_at is not None:
        revoke_all_for_user(db, record.user_id)
        db.commit()
        raise AuthenticationError("Your session has expired. Please sign in again.", "SESSION_EXPIRED")
    if record.expires_at <= now:
        raise AuthenticationError("Your session has expired. Please sign in again.", "SESSION_EXPIRED")
    user = db.get(User, record.user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("This account is not active.", "ACCOUNT_INACTIVE")
    record.revoked_at = now
    return issue_session(db, settings, user)


def revoke(db: Session, refresh_token: str | None) -> None:
    if not refresh_token:
        return
    db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == hash_refresh_token(refresh_token),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )


def revoke_all_for_user(db: Session, user_id: uuid.UUID) -> None:
    db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
