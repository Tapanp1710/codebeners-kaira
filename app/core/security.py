"""Password hashing, access tokens, refresh tokens and CSRF tokens.

Session architecture (documented in docs/SECURITY.md):
- Access token: short-lived JWT (HS256) in the HttpOnly cookie ``kaira_access``.
  It carries a ``csrf`` claim.
- Refresh token: opaque random string in the HttpOnly cookie ``kaira_refresh``
  (path-scoped to the auth endpoints), stored server-side only as a SHA-256 hash so it can
  be rotated on every use and revoked on logout.
- CSRF: cookie-authenticated unsafe requests must send ``X-CSRF-Token`` equal to the
  access token's ``csrf`` claim. The browser receives this value in the JSON body of
  login/refresh/me responses (works cross-origin, unlike reading a cookie).
- ``Authorization: Bearer <access token>`` is also accepted (non-browser clients); bearer
  requests are not CSRF-prone because the browser never attaches them automatically.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import Settings

ACCESS_COOKIE = "kaira_access"
REFRESH_COOKIE = "kaira_refresh"
CSRF_HEADER = "X-CSRF-Token"
JWT_ALGORITHM = "HS256"
JWT_AUDIENCE = "kaira-api"

# argon2id with library defaults. Each stored hash embeds its own parameters, so later changes
# to the defaults do not invalidate existing hashes.
_hasher = PasswordHasher()
# Used to equalise timing when the e-mail address does not exist.
_DUMMY_HASH = _hasher.hash("kaira-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


# Always runs one argon2 verify, even for unknown users (against the dummy hash), so response
# time does not reveal which e-mail addresses exist. Returns False when password_hash is None.
def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


# Decoded access-token claims. decode_access_token returns None rather than raising, so callers
# check for None.
@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    business_id: uuid.UUID
    role: str
    csrf: str
    expires_at: datetime


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


# jti is random per token. No revocation list exists, so a token stays valid until exp.
def create_access_token(
    settings: Settings, *, user_id: uuid.UUID, business_id: uuid.UUID, role: str, csrf: str
) -> tuple[str, datetime]:
    now = datetime.now(UTC)
    expires = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": str(user_id),
        "bid": str(business_id),
        "role": role,
        "csrf": csrf,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "aud": JWT_AUDIENCE,
        "typ": "access",
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=JWT_ALGORITHM), expires


# Requires exp, sub, bid, role, csrf and the audience. The typ == "access" check rejects other
# JWTs signed with the same key.
def decode_access_token(settings: Settings, token: str) -> AccessClaims | None:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[JWT_ALGORITHM],
            audience=JWT_AUDIENCE,
            options={"require": ["exp", "sub", "bid", "role", "csrf"]},
        )
        if payload.get("typ") != "access":
            return None
        return AccessClaims(
            user_id=uuid.UUID(payload["sub"]),
            business_id=uuid.UUID(payload["bid"]),
            role=str(payload["role"]),
            csrf=str(payload["csrf"]),
            expires_at=datetime.fromtimestamp(payload["exp"], UTC),
        )
    # Any decoding or claim error collapses to None, so callers cannot tell expired from tampered.
    except (jwt.PyJWTError, ValueError, KeyError):
        return None


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


# Refresh tokens are stored only as SHA-256 hex digests. No salt is needed: the token carries
# 384 bits of randomness (48 bytes).
def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# Used for the CSRF comparison. An empty or None value on either side returns False, so a
# missing header never matches.
def constant_time_equals(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
