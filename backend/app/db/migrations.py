"""Programmatic Alembic helpers (startup checks, scripts and tests)."""

from __future__ import annotations

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine

from alembic import command
from app.core.config import BACKEND_ROOT


# Paths are anchored to BACKEND_ROOT, so these helpers work from any current working directory.
def alembic_config(url: str | None = None) -> Config:
    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    # These attributes only take effect if alembic/env.py reads them. configure_logger=False is
    # meant to keep Alembic from overriding app.core.logging.
    cfg.attributes["configure_logger"] = False
    if url:
        cfg.attributes["connection_url"] = url
    return cfg


# Reads the head revision from the migration scripts on disk. Does not touch the database.
def head_revision() -> str | None:
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


# Returns "unknown" on any connection or Alembic error, so callers never see the exception.
# "outdated" means the database is at a revision other than head.
def migration_status(engine: Engine) -> str:
    try:
        with engine.connect() as conn:
            current = MigrationContext.configure(conn).get_current_revision()
    except Exception:
        return "unknown"
    if current is None:
        return "not_applied"
    return "current" if current == head_revision() else "outdated"


# Synchronous and blocking. Called by the FastAPI lifespan (if enabled) and the migrate CLI.
def upgrade_to_head(url: str) -> None:
    command.upgrade(alembic_config(url), "head")
