from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Body, Query

from app.db.dependencies import Auth, DbSession, OwnerAuth
from app.schemas.ai import ActionUpdate, ApprovalOut, ProposedActionOut
from app.schemas.common import Envelope, Page, ok
from app.services.ai import action_service

router = APIRouter(prefix="/actions", tags=["actions"])


@router.get("", response_model=Envelope[Page[ProposedActionOut]])
def list_actions(
    ctx: Auth,
    db: DbSession,
    status: Literal["pending", "executed", "rejected", "failed"] | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    rows, total = action_service.list_actions(
        db, ctx.business_id, status=status, page=page, page_size=page_size
    )
    return ok(
        Page(items=[action_service.present(a) for a in rows], total=total, page=page, page_size=page_size)
    )


@router.get("/{action_id}", response_model=Envelope[ProposedActionOut])
def get_action(action_id: uuid.UUID, ctx: Auth, db: DbSession):
    return ok(action_service.present(action_service.get_action(db, ctx.business_id, action_id)))


@router.patch(
    "/{action_id}",
    response_model=Envelope[ProposedActionOut],
    summary="Edit a pending proposal's operations (re-validated and re-resolved)",
)
def edit_action(action_id: uuid.UUID, body: ActionUpdate, ctx: Auth, db: DbSession):
    action = action_service.edit(db, ctx, action_id, body.operations)
    db.commit()
    return ok(action_service.present(action))


@router.post(
    "/{action_id}/approve",
    response_model=Envelope[ApprovalOut],
    summary="Owner approval: execute the proposal transactionally (idempotent)",
)
def approve_action(action_id: uuid.UUID, ctx: OwnerAuth, db: DbSession):
    try:
        action, replayed = action_service.approve(db, ctx, action_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return ok(ApprovalOut(action=action_service.present(action), replayed=replayed))


@router.post(
    "/{action_id}/reject",
    response_model=Envelope[ApprovalOut],
    summary="Owner rejection: no financial records are changed",
)
def reject_action(
    action_id: uuid.UUID,
    ctx: OwnerAuth,
    db: DbSession,
    reason: str | None = Body(default=None, embed=True, max_length=500),
):
    action, replayed = action_service.reject(db, ctx, action_id, reason)
    db.commit()
    return ok(ApprovalOut(action=action_service.present(action), replayed=replayed))
