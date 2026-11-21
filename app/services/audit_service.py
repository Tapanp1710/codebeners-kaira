from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.utils.serialize import json_safe


def record(
    db: Session,
    *,
    business_id: uuid.UUID,
    user_id: uuid.UUID | None,
    action_type: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    source_action_id: uuid.UUID | None = None,
) -> AuditLog:
    entry = AuditLog(
        business_id=business_id,
        user_id=user_id,
        action_type=action_type,
        entity_type=entity_type,
        entity_id=entity_id,
        before_data=json_safe(before) if before is not None else None,
        after_data=json_safe(after) if after is not None else None,
        source_action_id=source_action_id,
    )
    db.add(entry)
    db.flush()
    return entry


def list_logs(
    db: Session,
    business_id: uuid.UUID,
    *,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    source_action_id: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[AuditLog], int]:
    q = select(AuditLog).where(AuditLog.business_id == business_id)
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    if entity_id:
        q = q.where(AuditLog.entity_id == entity_id)
    if source_action_id:
        q = q.where(AuditLog.source_action_id == source_action_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(
        q.order_by(AuditLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return list(rows), total
