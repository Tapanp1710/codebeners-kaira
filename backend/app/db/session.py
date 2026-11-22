"""Engine and session factory (synchronous SQLAlchemy 2.x over psycopg 3)."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings


# Pool sizing comes from settings. pool_pre_ping checks each connection before use, so
# connections broken by a database restart get replaced.
def build_engine(settings: Settings) -> Engine:
    return create_engine(
        settings.DATABASE_URL,
        pool_size=settings.DATABASE_POOL_SIZE,
        max_overflow=settings.DATABASE_MAX_OVERFLOW,
        pool_timeout=settings.DATABASE_POOL_TIMEOUT,
        pool_pre_ping=True,
        # Forces the session timezone to UTC on connect; connection attempts time out after 10 s.
        connect_args={"options": "-c timezone=UTC", "connect_timeout": 10},
    )


# expire_on_commit=False keeps loaded attributes readable after commit. autoflush=False means
# queries do not implicitly flush pending changes.
def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


# Generator that closes the session. It does not commit or roll back; the caller does that.
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        yield session
    finally:
        session.close()


# Catches every exception and returns False. Used by the cli wait-db command to poll.
def database_is_reachable(engine: Engine) -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
