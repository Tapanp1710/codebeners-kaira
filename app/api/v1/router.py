from fastapi import APIRouter

from app.api.v1.endpoints import (
    actions,
    assistant,
    auth,
    bills,
    business,
    commitments,
    customers,
    finance,
    health,
    invoices,
    voice,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(business.router)
api_router.include_router(customers.router)
api_router.include_router(invoices.router)
api_router.include_router(bills.router)
api_router.include_router(commitments.router)
api_router.include_router(finance.router)
api_router.include_router(voice.router)
api_router.include_router(assistant.router)
api_router.include_router(actions.router)
