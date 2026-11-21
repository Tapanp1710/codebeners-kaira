"""Declarative base and shared column helpers."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import DateTime, MetaData, Numeric, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Fixed constraint-name templates, so Alembic autogenerate and migrations produce stable names.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# Money: up to 999,999,999,999.99 - stored exactly, never as float.
Money = Numeric(14, 2)


def utcnow() -> datetime:
    return datetime.now(UTC)


# Shared metadata for all models. type_annotation_map maps Python Decimal to Numeric(14, 2) and
# datetime to a timezone-aware column.
class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {Decimal: Money, datetime: DateTime(timezone=True)}


# Primary keys are generated in Python (default=uuid4), not by the database.
class UUIDPrimaryKey:
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)


# server_default=func.now() fills created_at for rows inserted outside the ORM. default=utcnow
# covers ORM inserts.
class CreatedAt:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False
    )


# onupdate applies only to ORM UPDATEs. Raw SQL updates leave updated_at unchanged.
class Timestamps(CreatedAt):
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
        nullable=False,
    )
