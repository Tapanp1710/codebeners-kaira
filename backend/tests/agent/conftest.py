"""Shared fixtures for the live voice agent tests.

Every provider is MOCKED: the orchestrator gets ``FakeSarvam`` whose ``chat_tools()`` returns scripted assistant
messages, and the WebSocket tests replace the realtime STT/TTS adapters with in-process fakes. No network."""

from __future__ import annotations

import copy
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select

from app.models import (
    AgentMessage,
    AgentToolExecution,
    AuditLog,
    Business,
    CashTransaction,
    Customer,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentCommitment,
    ProposedAction,
    User,
)
from app.seed import seed_demo
from app.services.agent import orchestrator
from tests.conftest import TEST_PASSWORD, Api, add_user

DEMO_EMAIL = "demo@kaira.local"

Script = dict[str, Any] | Callable[[list[dict[str, Any]]], dict[str, Any]]


def tool_call(name: str, args: dict[str, Any] | None = None, call_id: str | None = None) -> dict[str, Any]:
    """An assistant message asking for one tool call (OpenAI/Sarvam shape)."""
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": call_id or f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args or {}, ensure_ascii=False)},
            }
        ],
    }


def say(text: str) -> dict[str, Any]:
    return {"role": "assistant", "content": text}


class FakeSarvam:
    """MOCKED LLM: returns scripted assistant messages in order. A script item may be a callable that receives
    the messages sent so far (to read ids out of earlier tool results)."""

    def __init__(self, *script: Script) -> None:
        self.script: list[Script] = list(script)
        self.calls: list[list[dict[str, Any]]] = []

    def push(self, *script: Script) -> None:
        self.script.extend(script)

    def chat_tools(self, messages, tools, max_tokens=None):
        self.calls.append(copy.deepcopy(messages))
        if not self.script:
            raise AssertionError("FakeSarvam: chat_tools called more times than scripted")
        item = self.script.pop(0)
        msg = item(messages) if callable(item) else item
        if isinstance(msg, Exception):
            raise msg
        return copy.deepcopy(msg), {"total_tokens": 1}


def last_tool_result(messages: list[dict[str, Any]]) -> dict[str, Any]:
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    assert tool_msgs, "no tool result in the conversation yet"
    return json.loads(tool_msgs[-1]["content"])


@dataclass
class Demo:
    app: Any
    client: Any
    business: Business
    owner: User
    ramesh: Customer
    lakshmi: Customer
    major: Customer
    anjali: Customer
    inv_ramesh: Invoice

    @property
    def factory(self):
        return self.app.state.session_factory

    @property
    def settings(self):
        return self.app.state.settings

    def api(self) -> Api:
        return Api(self.client, self.owner.email)

    def staff(self, db) -> User:
        return add_user(db, self.business, "staff")

    def turn(
        self,
        fake: FakeSarvam,
        text: str,
        *,
        turn_id: str | None = None,
        user: User | None = None,
        language: str | None = None,
        session_id=None,
        input_mode: str = "text",
    ):
        events: list[dict[str, Any]] = []
        result = orchestrator.run_turn(
            self.factory,
            self.settings,
            fake,
            user_id=(user or self.owner).id,
            business_id=self.business.id,
            session_id=session_id,
            turn_id=turn_id or uuid.uuid4().hex,
            text=text,
            language_hint=language,
            input_mode=input_mode,
            emit=events.append,
        )
        return result, events

    def tool(
        self,
        name: str,
        args: dict[str, Any],
        transcript: str = "",
        *,
        user: User | None = None,
        turn_id: str | None = None,
        language: str = "en-IN",
    ) -> dict[str, Any]:
        """Run one tool exactly as the orchestrator does (own transaction, execution record)."""
        return orchestrator._exec_tool(
            self.factory,
            self.settings,
            None,
            (user or self.owner).id,
            self.business.id,
            turn_id or uuid.uuid4().hex,
            name,
            args,
            transcript,
            language,
        )


@pytest.fixture
def demo(app, client, db) -> Demo:
    seed_demo(db, owner_email=DEMO_EMAIL, owner_password=TEST_PASSWORD)
    db.commit()
    owner = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    business = db.get(Business, owner.business_id)

    def cust(name: str) -> Customer:
        return db.scalar(select(Customer).where(Customer.business_id == business.id, Customer.name == name))

    ramesh = cust("Ramesh Kumar")
    inv = db.scalar(
        select(Invoice).where(Invoice.business_id == business.id, Invoice.customer_id == ramesh.id)
    )
    return Demo(
        app,
        client,
        business,
        owner,
        ramesh,
        cust("Lakshmi Stores"),
        cust("Sri Venkateswara Enterprises"),
        cust("Anjali Textiles"),
        inv,
    )


COUNTED = (
    Payment,
    CashTransaction,
    PaymentCommitment,
    Invoice,
    Customer,
    ProposedAction,
    AuditLog,
)


def counts(db) -> dict[str, int]:
    db.expire_all()
    return {m.__name__: db.scalar(select(func.count()).select_from(m)) for m in COUNTED}


def financial_counts(db) -> dict[str, int]:
    c = counts(db)
    return {k: c[k] for k in ("Payment", "CashTransaction", "PaymentCommitment", "Invoice", "Customer")}


def outstanding(db, invoice_id) -> Decimal:
    """Invoice outstanding computed straight from SQL (total - payments), independent of the ledger."""
    db.expire_all()
    total = db.scalar(
        select(func.coalesce(func.sum(InvoiceItem.line_total), 0)).where(InvoiceItem.invoice_id == invoice_id)
    )
    paid = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.invoice_id == invoice_id)
    )
    return Decimal(total) - Decimal(paid)


def payments_of(db, invoice_id) -> list[Payment]:
    db.expire_all()
    return list(
        db.scalars(select(Payment).where(Payment.invoice_id == invoice_id).order_by(Payment.created_at))
    )


def tool_executions(db, turn_id: str) -> list[AgentToolExecution]:
    db.expire_all()
    return list(
        db.scalars(
            select(AgentToolExecution)
            .where(AgentToolExecution.turn_id == turn_id)
            .order_by(AgentToolExecution.created_at)
        )
    )


def messages_of(db, user_id) -> list[AgentMessage]:
    db.expire_all()
    return list(
        db.scalars(
            select(AgentMessage).where(AgentMessage.user_id == user_id).order_by(AgentMessage.created_at)
        )
    )
