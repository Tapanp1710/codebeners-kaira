"""payment request fingerprint

Adds `request_fingerprint` (SHA-256 of the canonical payment request) to payments and bill_payments.
Existing rows keep NULL: whether their original request carried a payment date cannot be reconstructed,
so they are compared column-by-column instead (app/services/idempotency.py). No data is modified.

Revision ID: 6b1d2e8f4a10
Revises: 428ea041155a
Create Date: 2026-11-22 09:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "6b1d2e8f4a10"
down_revision: str | Sequence[str] | None = "428ea041155a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("request_fingerprint", sa.String(length=64), nullable=True))
    op.add_column("bill_payments", sa.Column("request_fingerprint", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("bill_payments", "request_fingerprint")
    op.drop_column("payments", "request_fingerprint")
