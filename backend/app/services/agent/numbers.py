"""Parse an amount the user actually said: digits ("5,000", "5k", "5 हज़ार") or number words in English, Hindi
and Telugu ("five thousand", "पाँच हज़ार", "ఐదు వేల"). Used to check that a model-supplied amount equals what
was spoken. Returns None when the phrase cannot be parsed - callers then ask for confirmation instead of executing.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

UNITS = {
    # English
    "zero": 0,
    "one": 1,
    "a": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
    "half": Decimal("0.5"),
    # Hindi
    "एक": 1,
    "दो": 2,
    "तीन": 3,
    "चार": 4,
    "पाँच": 5,
    "पांच": 5,
    "छह": 6,
    "छः": 6,
    "छे": 6,
    "सात": 7,
    "आठ": 8,
    "नौ": 9,
    "दस": 10,
    "ग्यारह": 11,
    "बारह": 12,
    "तेरह": 13,
    "चौदह": 14,
    "पंद्रह": 15,
    "पन्द्रह": 15,
    "सोलह": 16,
    "सत्रह": 17,
    "अठारह": 18,
    "उन्नीस": 19,
    "बीस": 20,
    "पच्चीस": 25,
    "तीस": 30,
    "पैंतीस": 35,
    "चालीस": 40,
    "पैंतालीस": 45,
    "पचास": 50,
    "साठ": 60,
    "सत्तर": 70,
    "अस्सी": 80,
    "नब्बे": 90,
    "डेढ़": Decimal("1.5"),
    "ढाई": Decimal("2.5"),
    # Telugu
    "ఒక": 1,
    "ఒకటి": 1,
    "రెండు": 2,
    "మూడు": 3,
    "నాలుగు": 4,
    "ఐదు": 5,
    "అయిదు": 5,
    "ఆరు": 6,
    "ఏడు": 7,
    "ఎనిమిది": 8,
    "తొమ్మిది": 9,
    "పది": 10,
    "పదకొండు": 11,
    "పన్నెండు": 12,
    "పదిహేను": 15,
    "ఇరవై": 20,
    "ఇరవై ఐదు": 25,
    "ముప్పై": 30,
    "నలభై": 40,
    "యాభై": 50,
    "అరవై": 60,
    "డెబ్బై": 70,
    "ఎనభై": 80,
    "తొంభై": 90,
    "అర": Decimal("0.5"),
}
HUNDRED = {"hundred", "सौ", "వంద", "వందల", "వందలు", "వందా"}
SCALES = {
    "thousand": 1000,
    "k": 1000,
    "हज़ार": 1000,
    "हजार": 1000,
    "వెయ్యి": 1000,
    "వేల": 1000,
    "వేలు": 1000,
    "lakh": 100000,
    "lakhs": 100000,
    "lac": 100000,
    "लाख": 100000,
    "లక్ష": 100000,
    "లక్షల": 100000,
    "లక్షలు": 100000,
    "crore": 10_000_000,
    "crores": 10_000_000,
    "करोड़": 10_000_000,
    "కోటి": 10_000_000,
}
IGNORE = {"and", "rupees", "rupee", "rs", "inr", "only", "रुपये", "रुपए", "रूपये", "రూపాయలు", "రూపాయి", "రూపాయల"}
_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?|[^\s\d,.₹/-]+")


def spoken_amount(fragment: str) -> Decimal | None:
    text = (fragment or "").strip().lower().replace("₹", " ")
    if not text:
        return None
    total = Decimal(0)
    current: Decimal | None = None
    seen_number = False
    for tok in _TOKEN.findall(text):
        if tok in IGNORE:
            continue
        if tok[0].isdigit():
            try:
                value = Decimal(tok.replace(",", ""))
            except InvalidOperation:
                return None
            current = (current or Decimal(0)) + value
            seen_number = True
        elif tok in UNITS:
            current = (current or Decimal(0)) + Decimal(str(UNITS[tok]))
            seen_number = True
        elif tok in HUNDRED:
            current = (current if current is not None else Decimal(1)) * 100
            seen_number = True
        elif tok in SCALES:
            total += (current if current is not None else Decimal(1)) * SCALES[tok]
            current = None
            seen_number = True
        else:
            return None  # an unknown word: do not guess
    if not seen_number:
        return None
    value = total + (current or Decimal(0))
    return value.quantize(Decimal("0.01")) if value > 0 else None
