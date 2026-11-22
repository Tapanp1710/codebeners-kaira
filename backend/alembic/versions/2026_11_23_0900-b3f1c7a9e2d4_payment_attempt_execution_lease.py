"""payment attempt execution lease

Adds execution-lease and reconciliation metadata to payment_attempts: execution_started_at,
execution_started_by, lease_owner (opaque random token, never a secret), lease_expires_at and
last_reconciled_at, three CHECK constraints on the lease, and a partial index for the reconciler's scan of
pending attempts. Purely additive: existing rows get NULLs, which satisfy every new constraint, and no
existing column, constraint or index changes.

Reimplements the unfinished de704a3 (feat/payment-attempt-reconciliation) on the current chain.

Revision ID: b3f1c7a9e2d4
Revises: 87111e6fffeb
Create Date: 2026-11-23 09:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3f1c7a9e2d4"
down_revision: str | Sequence[str] | None = "87111e6fffeb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "payment_attempts", sa.Column("execution_started_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("payment_attempts", sa.Column("execution_started_by", sa.Uuid(), nullable=True))
    op.add_column("payment_attempts", sa.Column("lease_owner", sa.String(length=64), nullable=True))
    op.add_column(
        "payment_attempts", sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "payment_attempts", sa.Column("last_reconciled_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_payment_attempts_execution_started_by_users"),
        "payment_attempts",
        "users",
        ["execution_started_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_payment_attempts_lease_complete"),
        "payment_attempts",
        "(lease_owner IS NULL) = (lease_expires_at IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_payment_attempts_lease_after_start"),
        "payment_attempts",
        "lease_expires_at IS NULL OR "
        "(execution_started_at IS NOT NULL AND lease_expires_at > execution_started_at)",
    )
    op.create_check_constraint(
        op.f("ck_payment_attempts_lease_only_pending"),
        "payment_attempts",
        "status = 'pending' OR lease_owner IS NULL",
    )
    op.create_index(
        "ix_payment_attempts_pending_created",
        "payment_attempts",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    """Downgrade schema (reverse order: index, constraints, foreign key, columns)."""
    op.drop_index(
        "ix_payment_attempts_pending_created",
        table_name="payment_attempts",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_constraint(op.f("ck_payment_attempts_lease_only_pending"), "payment_attempts", type_="check")
    op.drop_constraint(op.f("ck_payment_attempts_lease_after_start"), "payment_attempts", type_="check")
    op.drop_constraint(op.f("ck_payment_attempts_lease_complete"), "payment_attempts", type_="check")
    op.drop_constraint(
        op.f("fk_payment_attempts_execution_started_by_users"), "payment_attempts", type_="foreignkey"
    )
    op.drop_column("payment_attempts", "last_reconciled_at")
    op.drop_column("payment_attempts", "lease_expires_at")
    op.drop_column("payment_attempts", "lease_owner")
    op.drop_column("payment_attempts", "execution_started_by")
    op.drop_column("payment_attempts", "execution_started_at")
