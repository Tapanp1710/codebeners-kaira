from __future__ import annotations

from fastapi import APIRouter

from app.db.dependencies import Auth, DbSession, OwnerAuth
from app.schemas.common import Envelope, ok
from app.schemas.core import BusinessOut, BusinessSettingsUpdate
from app.services import audit_service
from app.utils.money import q2
from app.utils.serialize import snapshot

router = APIRouter(prefix="/business", tags=["business"])


@router.get("/settings", response_model=Envelope[BusinessOut])
def get_settings(ctx: Auth):
    return ok(BusinessOut.model_validate(ctx.business))


@router.patch("/settings", response_model=Envelope[BusinessOut], summary="Owner only")
def update_settings(body: BusinessSettingsUpdate, ctx: OwnerAuth, db: DbSession):
    business = ctx.business
    before = snapshot(business)
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is None:
            continue
        if key in ("opening_cash_balance", "low_cash_threshold"):
            value = q2(value)
        setattr(business, key, value)
    db.flush()
    audit_service.record(
        db,
        business_id=business.id,
        user_id=ctx.user_id,
        action_type="business.settings_updated",
        entity_type="business",
        entity_id=business.id,
        before=before,
        after=snapshot(business),
    )
    db.commit()
    return ok(BusinessOut.model_validate(business))
