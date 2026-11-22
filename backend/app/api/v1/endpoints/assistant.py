from __future__ import annotations

from fastapi import APIRouter, Request

from app.db.dependencies import Auth, DbSession, SettingsDep
from app.schemas.ai import (
    QUERY_INTENTS,
    AnswerOut,
    ExtractRequest,
    ExtractResponse,
    QueryRequest,
    ReminderOut,
    ReminderRequest,
)
from app.schemas.common import Envelope, ok
from app.services.ai import assistant_service
from app.utils.dates import business_today

router = APIRouter(prefix="/assistant", tags=["assistant"])


@router.post(
    "/extract",
    response_model=Envelope[ExtractResponse],
    summary="Understand a typed or transcribed request. Write intents become PENDING proposals; "
    "questions are answered from backend data. Nothing is executed without owner approval.",
)
def extract(body: ExtractRequest, request: Request, ctx: Auth, db: DbSession, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    result = assistant_service.extract(db, ctx, settings, request.app.state.sarvam, body)
    db.commit()
    return ok(result)


@router.post("/query", response_model=Envelope[AnswerOut], summary="Answer a business question (read-only)")
def query(body: QueryRequest, request: Request, ctx: Auth, db: DbSession, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    client = request.app.state.sarvam
    extractor = assistant_service.get_extractor(settings, client, ctx.business.timezone)
    output = extractor.extract(body.question, business_today(ctx.business.timezone), body.language)
    language = body.language or output.language or "en-IN"
    op = next((o for o in output.operations if o.type in QUERY_INTENTS), None)
    if op is None:
        db.rollback()
        return ok(
            AnswerOut(
                intent="unknown",
                language=language,
                answer="That doesn't look like a question about your business data. To record something, "
                "use the assistant input so you can review and approve it.",
                answer_language="en-IN",
                data={"detected_intents": [o.type for o in output.operations]},
            )
        )
    result = assistant_service.answer(db, ctx, settings, client, op, body.question, language)
    db.rollback()  # read-only endpoint
    return ok(result)


@router.post(
    "/reminder",
    response_model=Envelope[ReminderOut],
    summary="Draft an editable payment reminder from real outstanding figures (never sent)",
)
def reminder(body: ReminderRequest, request: Request, ctx: Auth, db: DbSession, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    result = assistant_service.draft_reminder(
        db,
        ctx,
        settings,
        request.app.state.sarvam,
        body.customer_id,
        body.invoice_id,
        body.language,
        body.tone,
    )
    db.rollback()
    return ok(result)
