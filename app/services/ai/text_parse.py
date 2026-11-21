"""Deterministic parsing of amounts and dates in English business speech.

Conventions (documented in docs/AI_ARCHITECTURE.md):
- "next Monday" / "Monday" / "coming Monday" = the next Monday strictly after today.
- "this Monday" = today if today is Monday, otherwise the next Monday.
- In past-tense contexts (a payment that happened) a bare weekday means the most recent
  such day on or before today.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

AMOUNT_RE = (
    r"(?:₹\s?|rs\.?\s?|inr\s?|rupees\s)?"
    r"(?P<amt>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
    r"(?:\s?(?P<mult>k\b|thousand|lakhs?|lacs?|crores?|cr\b))?"
    r"(?:\s?(?:rupees|rs\.?|inr|/-))?"
)
_MULT = {
    "k": 1000,
    "thousand": 1000,
    "lakh": 100000,
    "lakhs": 100000,
    "lac": 100000,
    "lacs": 100000,
    "crore": 10000000,
    "crores": 10000000,
    "cr": 10000000,
}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
MONTHS.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})
MONTHS["sept"] = 9


def parse_amount(amt: str, mult: str | None) -> Decimal | None:
    try:
        value = Decimal(amt.replace(",", ""))
    except InvalidOperation:
        return None
    if mult:
        value *= _MULT.get(mult.lower().rstrip("."), 1)
    if value <= 0:
        return None
    return value.quantize(Decimal("0.01"))


def _next_weekday(today: date, weekday: int, *, allow_today: bool) -> date:
    delta = (weekday - today.weekday()) % 7
    if delta == 0 and not allow_today:
        delta = 7
    return today + timedelta(days=delta)


def _last_weekday(today: date, weekday: int) -> date:
    return today - timedelta(days=(today.weekday() - weekday) % 7)


_WD = "|".join(WEEKDAYS)
_MON = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_PATTERNS: list[tuple[str, str]] = [
    ("iso", r"\b(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})\b"),
    ("dmy", r"\b(?P<d>\d{1,2})[/.-](?P<m>\d{1,2})[/.-](?P<y>\d{2,4})\b"),
    ("day_after_tomorrow", r"\bday after tomorrow\b"),
    ("day_before_yesterday", r"\bday before yesterday\b"),
    ("today", r"\b(?:today|tonight|right now|just now|this morning|this evening)\b"),
    ("yesterday", r"\byesterday\b"),
    ("tomorrow", r"\btomorrow\b"),
    ("in_days", r"\b(?:in|after|within)\s+(?P<n>\d{1,3})\s+days?\b"),
    ("next_week", r"\bnext week\b"),
    ("end_of_month", r"\b(?:end of (?:the |this )?month|month end)\b"),
    ("weekday", rf"\b(?P<rel>next|this|coming|last|on|by)?\s*(?P<wd>{_WD})\b"),
    (
        "day_month",
        rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<mon>{_MON})\b\.?(?:,?\s*(?P<y>\d{{4}}))?",
    ),
    ("month_day", rf"\b(?P<mon>{_MON})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s*(?P<y>\d{{4}}))?"),
    ("ordinal", r"\b(?:on|by|before)\s+(?:the\s+)?(?P<d>\d{1,2})(?:st|nd|rd|th)\b"),
]
_COMPILED = [(name, re.compile(p, re.IGNORECASE)) for name, p in DATE_PATTERNS]


def find_date(text: str, today: date, *, prefer: str = "future") -> tuple[date, str] | None:
    """Return (date, verbatim fragment) for the first date expression found."""
    best: tuple[int, date, str] | None = None
    for name, rx in _COMPILED:
        for m in rx.finditer(text):
            d = _resolve(name, m, today, prefer)
            if d is None:
                continue
            if best is None or m.start() < best[0]:
                best = (m.start(), d, m.group(0).strip())
            break
    return (best[1], best[2]) if best else None


def _resolve(name: str, m: re.Match, today: date, prefer: str) -> date | None:
    try:
        if name == "iso":
            return date(int(m["y"]), int(m["m"]), int(m["d"]))
        if name == "dmy":
            y = int(m["y"])
            y = y + 2000 if y < 100 else y
            return date(y, int(m["m"]), int(m["d"]))
        if name == "today":
            return today
        if name == "yesterday":
            return today - timedelta(days=1)
        if name == "day_before_yesterday":
            return today - timedelta(days=2)
        if name == "tomorrow":
            return today + timedelta(days=1)
        if name == "day_after_tomorrow":
            return today + timedelta(days=2)
        if name == "in_days":
            return today + timedelta(days=int(m["n"]))
        if name == "next_week":
            return today + timedelta(days=7)
        if name == "end_of_month":
            return date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
        if name == "weekday":
            wd = WEEKDAYS.index(m["wd"].lower())
            rel = (m["rel"] or "").lower()
            if rel == "last" or (prefer == "past" and rel in ("", "on")):
                d = _last_weekday(today, wd)
                return d - timedelta(days=7) if rel == "last" and d == today else d
            return _next_weekday(today, wd, allow_today=rel == "this")
        if name in ("day_month", "month_day"):
            month = MONTHS[m["mon"].lower().rstrip(".")]
            day = int(m["d"])
            year = int(m["y"]) if m["y"] else today.year
            d = date(year, month, day)
            if not m["y"]:
                if prefer == "future" and d < today - timedelta(days=60):
                    d = date(year + 1, month, day)
                elif prefer == "past" and d > today:
                    d = date(year - 1, month, day)
            return d
        if name == "ordinal":
            day = int(m["d"])
            d = date(today.year, today.month, day)
            if d < today and prefer == "future":
                nm = today.month % 12 + 1
                ny = today.year + (1 if today.month == 12 else 0)
                d = date(ny, nm, day)
            return d
    except (ValueError, KeyError):
        return None
    return None


METHODS = [
    ("upi", r"\b(?:upi|gpay|google pay|phonepe|phone pe|paytm|bhim)\b"),
    (
        "bank_transfer",
        r"\b(?:bank transfer|neft|imps|rtgs|net ?banking|transferred to (?:my|the) (?:bank|account))\b",
    ),
    ("cheque", r"\b(?:cheque|check)\b"),
    ("card", r"\b(?:card|debit card|credit card)\b"),
    ("cash", r"\b(?:in cash|cash)\b"),
]


def find_method(text: str) -> tuple[str, str] | None:
    for method, pattern in METHODS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            return method, m.group(0)
    return None


INVOICE_REF_RE = re.compile(
    r"\b(?:inv(?:oice)?)\s*(?:no\.?|number|#)?\s*[-#]?\s*(?P<num>\d{1,6})\b", re.IGNORECASE
)


def find_invoice_reference(text: str) -> tuple[str, str] | None:
    m = INVOICE_REF_RE.search(text)
    if not m:
        return None
    return normalise_invoice_number(m["num"]), m.group(0)


def normalise_invoice_number(ref: str) -> str:
    digits = re.sub(r"\D", "", ref)
    return f"INV-{int(digits):04d}" if digits else ref.strip().upper()


def normalise_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()
