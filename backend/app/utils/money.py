"""Exact decimal money helpers. Floats are never used for money."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

ZERO = Decimal("0.00")
CENT = Decimal("0.01")


def q2(value: Decimal | int | str) -> Decimal:
    """Quantise to 2 decimal places using commercial (half-up) rounding."""
    if isinstance(value, float):  # defensive: refuse silent float imprecision
        raise TypeError("Money must not be a float")
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def money_str(value: Decimal) -> str:
    return format(q2(value), "f")
