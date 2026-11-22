"""Deterministic resolution of spoken date phrases (English, Hindi, Telugu) in the business timezone.

The model may propose a date, but the server decides what the user's own words mean. Conventions (shared with
app/services/ai/text_parse.py and stated in the agent's system prompt):

* "today" / "aaj" / "आज" / "ఈరోజు" / "ఇవాళ" = the business-local date (business.timezone, normally Asia/Kolkata),
  never the server's UTC date.
* "tomorrow" / "రేపు" = +1, "yesterday" / "నిన్న" = -1, "day after tomorrow" / "ఎల్లుండి" = +2,
  "day before yesterday" / "మొన్న" = -2.
* Hindi "कल" (kal) means yesterday OR tomorrow and "परसों" (parson) means -2 OR +2. They are resolved by the tense
  of the verb that goes with them ("कल देगा" -> tomorrow, "कल दिए" -> yesterday). With no clear tense the
  mention is ambiguous and the caller must ask, never guess.
* "next Monday" / "अगले सोमवार" / "వచ్చే సోమవారం" = the first Monday strictly after today (on a Sunday that is
  tomorrow). "this Monday" = today if today is Monday, else the next Monday. "last Monday" = the most recent
  Monday before today. A bare weekday follows the caller's preference: future for promises and due dates, past
  for payments that already happened.
* "end of month" / "महीने के अंत" / "నెలాఖరు" = the last day of the current month.
* "in N days" / "N दिन में" / "N రోజుల్లో" = today + N.
* Explicit dates: "2026-11-25", "25/11/2026", "25/11" (day/month, Indian order), "25th November",
  "November 25", "25 नवंबर", "25 నవంబర్", "25 तारीख" / "25వ తేదీ" (that day of this month, or of next month
  when it has passed and the preference is future). A year that is not said is inferred from the preference.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.services.agent.numbers import spoken_amount
from app.services.ai import text_parse
from app.utils.dates import business_today

__all__ = [
    "DateMention",
    "business_today",
    "describe",
    "find_dates",
    "mentions_in_fragment",
]

PAST, FUTURE = "past", "future"


@dataclass(frozen=True)
class DateMention:
    phrase: str  # verbatim text that was matched
    start: int
    end: int
    date: date | None  # None when the phrase is ambiguous
    kind: str
    candidates: tuple[date, ...] = field(default=())
    reason: str | None = None

    @property
    def ambiguous(self) -> bool:
        return self.date is None


def describe(d: date) -> str:
    """'Monday 23 November 2026 (2026-11-23)': unambiguous in speech and in logs."""
    return f"{d.strftime('%A')} {d.day} {d.strftime('%B %Y')} ({d.isoformat()})"


# ------------------------------------------------------------------ vocabulary
_IND = "ऀ-ॿఀ-౿‌‍"
_B = rf"(?<![\w{_IND}])"  # start of word (Indic vowel signs are not \w, so \b is unreliable)
_E = rf"(?![\w{_IND}])"  # end of word
_TE_SUFFIX = r"[ఀ-౿‌]*"  # Telugu case suffixes: సోమవారానికి, నెలాఖరులోగా, రేపటికి

WEEKDAYS_HI = {
    "सोमवार": 0,
    "मंगलवार": 1,
    "बुधवार": 2,
    "गुरुवार": 3,
    "बृहस्पतिवार": 3,
    "वीरवार": 3,
    "शुक्रवार": 4,
    "शनिवार": 5,
    "रविवार": 6,
    "इतवार": 6,
}
WEEKDAYS_HI_LATIN = {
    "somvar": 0,
    "somvaar": 0,
    "mangalvar": 1,
    "mangalvaar": 1,
    "budhvar": 2,
    "budhvaar": 2,
    "guruvar": 3,
    "guruvaar": 3,
    "shukravar": 4,
    "shukravaar": 4,
    "shanivar": 5,
    "shanivaar": 5,
    "ravivar": 6,
    "ravivaar": 6,
    "itvar": 6,
    "itvaar": 6,
}
WEEKDAYS_TE = {  # stems; the word continues with ం / ము / ానికి / ం నాడు ...
    "సోమవార": 0,
    "మంగళవార": 1,
    "బుధవార": 2,
    "గురువార": 3,
    "శుక్రవార": 4,
    "శనివార": 5,
    "ఆదివార": 6,
}
MONTHS_HI = {
    "जनवरी": 1,
    "फरवरी": 2,
    "फ़रवरी": 2,
    "मार्च": 3,
    "अप्रैल": 4,
    "मई": 5,
    "जून": 6,
    "जुलाई": 7,
    "अगस्त": 8,
    "सितंबर": 9,
    "सितम्बर": 9,
    "अक्टूबर": 10,
    "अक्तूबर": 10,
    "नवंबर": 11,
    "नवम्बर": 11,
    "दिसंबर": 12,
    "दिसम्बर": 12,
}
MONTHS_TE = {
    "జనవరి": 1,
    "ఫిబ్రవరి": 2,
    "మార్చి": 3,
    "మార్చ్": 3,
    "ఏప్రిల్": 4,
    "మే": 5,
    "జూన్": 6,
    "జూలై": 7,
    "జులై": 7,
    "ఆగస్టు": 8,
    "ఆగస్ట్": 8,
    "సెప్టెంబర్": 9,
    "సెప్టెంబరు": 9,
    "అక్టోబర్": 10,
    "అక్టోబరు": 10,
    "నవంబర్": 11,
    "నవంబరు": 11,
    "డిసెంబర్": 12,
    "డిసెంబరు": 12,
}
INDIC_MONTHS = {**MONTHS_HI, **MONTHS_TE}


def _alt(words) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


# Hindi tense markers used to read "कल" / "परसों". A token is future if it ends like देगा/करेंगे/दूँगी, or is
# an obligation (देना है); past if it is a past participle/auxiliary (दिया, दिए, था, चुका...).
_FUTURE_HI = re.compile(r"^[ऀ-ॿ]+(?:गा|गी|गे|गीं|गें)$")
_FUTURE_HI_EXCEPT = {"आगे", "लगा", "लगी", "लगे", "मांगा", "माँगा", "मांगी", "माँगी", "मांगे", "माँगे", "भागा", "सगा"}
_FUTURE_WORDS = {
    "वाला",
    "वाले",
    "वाली",
    "देना",
    "चुकाना",
    "भरना",
    "लौटाना",
    "will",
    "shall",
    "gonna",
    "wala",
    "wale",
    "wali",
    "dena",
}
_FUTURE_LATIN = re.compile(r"^[a-z]+(?:ega|egi|enge|engi|unga|ungi|oonga|oongi)$")
_PAST_WORDS = {
    "दिया",
    "दिए",
    "दिये",
    "दी",
    "दीं",
    "किया",
    "किए",
    "किये",
    "लिया",
    "भरा",
    "भरे",
    "भरी",
    "चुकाया",
    "चुकाए",
    "चुकाई",
    "लौटाया",
    "लौटाए",
    "भेजा",
    "भेजे",
    "भेजी",
    "आया",
    "आए",
    "आई",
    "गया",
    "गए",
    "गई",
    "था",
    "थे",
    "थी",
    "थीं",
    "चुका",
    "चुके",
    "चुकी",
    "मिला",
    "मिले",
    "मिली",
    "diya",
    "diye",
    "kiya",
    "kiye",
    "liya",
    "tha",
    "thi",
    "gaya",
    "gaye",
    "aaya",
    "aya",
    "chukaya",
    "bhara",
    "mila",
    "mile",
    "paid",
    "gave",
    "was",
    "were",
}
_CLAUSE_END = re.compile(r"[।.!?;,\n]")
_TOKEN = re.compile(rf"[\w{_IND}]+")


def hindi_tense(text: str, start: int, end: int) -> str | None:
    """Tense of the verb that goes with the word at text[start:end]: the first tense-marked word after it in the
    same clause (Hindi is verb-final), else the nearest one before it. None when nothing marks the tense."""

    def classify(tok: str) -> str | None:
        t = tok.casefold()
        if t in _PAST_WORDS:
            return PAST
        if t in _FUTURE_WORDS or (_FUTURE_LATIN.match(t) and len(t) >= 4):
            return FUTURE
        if _FUTURE_HI.match(t) and len(t) >= 3 and t not in _FUTURE_HI_EXCEPT:
            return FUTURE
        return None

    after_end = _CLAUSE_END.search(text, end)
    after = _TOKEN.findall(text[end : after_end.start() if after_end else len(text)])
    for i, tok in enumerate(after):
        tense = classify(tok)
        if tense:
            # a verb group is read as a whole: "चुका देगा" / "दिया जाएगा" are future
            if i + 1 < len(after) and classify(after[i + 1]) == FUTURE:
                return FUTURE
            return tense
    before_start = max((m.end() for m in _CLAUSE_END.finditer(text, 0, start)), default=0)
    for tok in reversed(_TOKEN.findall(text[before_start:start])):
        tense = classify(tok)
        if tense:
            return tense
    return None


# ------------------------------------------------------------------ helpers
def _next_weekday(today: date, wd: int, *, allow_today: bool) -> date:
    delta = (wd - today.weekday()) % 7
    if delta == 0 and not allow_today:
        delta = 7
    return today + timedelta(days=delta)


def _last_weekday(today: date, wd: int, *, allow_today: bool) -> date:
    delta = (today.weekday() - wd) % 7
    if delta == 0 and not allow_today:
        delta = 7
    return today - timedelta(days=delta)


def _weekday(today: date, wd: int, rel: str, prefer: str) -> date:
    """rel: next | this | last | '' (bare)."""
    if rel == "next":
        return _next_weekday(today, wd, allow_today=False)
    if rel == "this":
        return _next_weekday(today, wd, allow_today=True)
    if rel == "last":
        return _last_weekday(today, wd, allow_today=False)
    if prefer == PAST:
        return _last_weekday(today, wd, allow_today=True)
    return _next_weekday(today, wd, allow_today=False)


def _end_of_month(today: date) -> date:
    return date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])


def _day_month(today: date, day: int, month: int, year: int | None, prefer: str) -> date | None:
    try:
        d = date(year or today.year, month, day)
    except ValueError:
        return None
    if year is None:
        if prefer == FUTURE and d < today - timedelta(days=60):
            d = date(d.year + 1, month, day)
        elif prefer == PAST and d > today:
            d = date(d.year - 1, month, day)
    return d


def _day_of_month(today: date, day: int, prefer: str) -> date | None:
    try:
        d = date(today.year, today.month, day)
    except ValueError:
        return None
    if prefer == FUTURE and d < today:
        ny, nm = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
        try:
            return date(ny, nm, day)
        except ValueError:
            return None
    if prefer == PAST and d > today:
        py, pm = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
        try:
            return date(py, pm, day)
        except ValueError:
            return None
    return d


def _small_int(word: str, lo: int, hi: int) -> int | None:
    if word.isdigit():
        n = int(word)
    else:
        v = spoken_amount(word)
        if v is None or v != v.to_integral_value():
            return None
        n = int(v)
    return n if lo <= n <= hi else None


# ------------------------------------------------------------------ patterns
_REL_HI_NEXT = r"अगले|अगला|अगली|आने\s+वाले|आने\s+वाला|आने\s+वाली|agle|agla|agli"
_REL_HI_THIS = r"इस|इसी|is|isi"
_REL_HI_LAST = r"पिछले|पिछला|पिछली|बीते|गए|pichhle|pichle"
_REL_TE_NEXT = r"వచ్చే|రాబోయే|వచ్చేటి"
_REL_TE_THIS = r"ఈ"
_REL_TE_LAST = r"పోయిన|గత|క్రితం|మొన్నటి"
_HI_WD = _alt(WEEKDAYS_HI)
_HI_WD_LAT = _alt(WEEKDAYS_HI_LATIN)
_TE_WD = _alt(WEEKDAYS_TE)
_HI_MON = _alt(MONTHS_HI)
_TE_MON = _alt(MONTHS_TE)
_EN_MON = "|".join(sorted(text_parse.MONTHS, key=len, reverse=True))
_NUMWORD = r"\d{1,3}|[a-z]+|[ऀ-ॿఀ-౿]+"
_YEAR = r"(?:\s*,?\s*(?P<y>\d{4}))?"

INDIC_PATTERNS: list[tuple[str, str]] = [
    # --- relative days
    ("today", rf"{_B}(?:आज|ఈ\s?రోజు|ఇవాళ|ఇవ్వాళ|ఈవేళ|నేడు)(?:{_TE_SUFFIX}){_E}"),
    ("today", rf"{_B}(?:अभी|ఇప్పుడే|aaj|abhi)(?!\s*(?:तक|tak)){_E}"),
    ("tomorrow", rf"{_B}(?:आने\s+वाले|आने\s+वाला)\s+कल{_E}"),
    ("yesterday", rf"{_B}(?:बीते|बीता|गुज़रे|गुजरे|गुज़रा|गुजरा)\s+कल{_E}"),
    ("tomorrow", rf"{_B}(?:రేపు|రేపటి{_TE_SUFFIX}){_E}"),
    ("yesterday", rf"{_B}(?:నిన్న{_TE_SUFFIX}){_E}"),
    ("day_after_tomorrow", rf"{_B}(?:ఎల్లుండి{_TE_SUFFIX}){_E}"),
    ("day_before_yesterday", rf"{_B}(?:మొన్న|మొన్నటి{_TE_SUFFIX}){_E}"),
    ("hi_kal", rf"{_B}(?:कल|kal){_E}"),
    ("hi_parson", rf"{_B}(?:परसों|परसो|parson|parso|parsoon){_E}"),
    # --- weekdays
    (
        "weekday_hi",
        rf"{_B}(?:(?P<rel>{_REL_HI_NEXT}|{_REL_HI_THIS}|{_REL_HI_LAST})\s+)?(?P<wd>{_HI_WD}|{_HI_WD_LAT}){_E}",
    ),
    (
        "weekday_te",
        rf"{_B}(?:(?P<rel>{_REL_TE_NEXT}|{_REL_TE_THIS}|{_REL_TE_LAST})\s*)?(?P<wd>{_TE_WD}){_TE_SUFFIX}",
    ),
    # --- weeks and month end
    ("next_week", rf"{_B}(?:अगले|अगला|agle)\s+(?:हफ्ते|हफ़्ते|हफ्ता|हफ़्ता|सप्ताह|hafte){_E}"),
    ("next_week", rf"{_B}(?:వచ్చే|రాబోయే)\s*వారం{_TE_SUFFIX}"),
    ("end_of_month", rf"{_B}(?:इस\s+)?महीने\s+के\s+(?:अंत|आखिर|आख़िर|आखिरी|आख़िरी|आखरी){_E}"),
    ("end_of_month", rf"{_B}(?:ఈ\s*)?(?:నెలాఖరు|నెలాఖర|నెల\s*చివర|నెల\s*ఆఖరు){_TE_SUFFIX}"),
    ("end_of_month", r"\bmonth[- ]end\b|\bend of (?:the |this )?month\b"),
    # --- in N days
    ("in_days", rf"{_B}(?P<n>{_NUMWORD})\s+(?:दिन|दिनों)\s+(?:में|बाद|के\s+अंदर|के\s+भीतर){_E}"),
    (
        "in_days",
        rf"{_B}(?P<n>{_NUMWORD})\s+(?:రోజుల్లో|రోజులలో|రోజుల\s+లో|రోజుల\s+తర్వాత|రోజుల\s+తరువాత|రోజుల్లోపు){_TE_SUFFIX}",
    ),
    ("in_days", r"\b(?:in|after|within)\s+(?P<n>[a-z]+)\s+days?\b"),
    # --- explicit dates
    ("dm", r"(?<![\d/.-])(?P<d>\d{1,2})/(?P<m>\d{1,2})(?![\d/])"),
    (
        "day_month_indic",
        rf"{_B}(?P<d>{_NUMWORD})(?:\s*వ)?(?:\s*(?:తేదీ|तारीख़?|तारीख))?\s*(?P<mon>{_HI_MON}|{_TE_MON}){_TE_SUFFIX}{_YEAR}",
    ),
    (
        "month_day_indic",
        rf"{_B}(?P<mon>{_HI_MON}|{_TE_MON})\s+(?P<d>\d{{1,2}})(?:\s*(?:వ|వ\s*తేదీ|తేదీ|तारीख़?))?{_YEAR}",
    ),
    (
        "day_of_month",
        rf"{_B}(?P<d>\d{{1,2}})\s*(?:వ\s*తేదీ|వ\s*తారీఖు|\s*తేదీ|\s*తారీఖు|\s*तारीख़?|\s*तारीख){_TE_SUFFIX}",
    ),
    ("day_of_month", r"\b(?:the\s+)?(?P<d>\d{1,2})(?:st|nd|rd|th)\b"),
]
_INDIC_COMPILED = [(k, re.compile(p, re.IGNORECASE)) for k, p in INDIC_PATTERNS]
_EN_MONTH_WORD = re.compile(rf"^\s+(?:of\s+)?(?:{_EN_MON})\b", re.IGNORECASE)


def _resolve(kind: str, m: re.Match, text: str, today: date, prefer: str) -> DateMention | None:
    g = m.groupdict()
    phrase, start, end = m.group(0).strip(), m.start(), m.start() + len(m.group(0).rstrip())

    def mk(d: date | None, cands: tuple[date, ...] = (), reason: str | None = None) -> DateMention | None:
        if d is None and not cands:
            return None
        return DateMention(phrase, start, end, d, kind, cands, reason)

    if kind == "today":
        return mk(today)
    if kind == "tomorrow":
        return mk(today + timedelta(days=1))
    if kind == "yesterday":
        return mk(today - timedelta(days=1))
    if kind == "day_after_tomorrow":
        return mk(today + timedelta(days=2))
    if kind == "day_before_yesterday":
        return mk(today - timedelta(days=2))
    if kind in ("hi_kal", "hi_parson"):
        n = 1 if kind == "hi_kal" else 2
        past, future = today - timedelta(days=n), today + timedelta(days=n)
        tense = hindi_tense(text, start, end)
        if tense == PAST:
            return mk(past)
        if tense == FUTURE:
            return mk(future)
        return mk(
            None,
            (past, future),
            f"'{phrase}' can mean {describe(past)} or {describe(future)}",
        )
    if kind in ("weekday_hi", "weekday_te"):
        word = g["wd"]
        wd = WEEKDAYS_HI.get(word) if kind == "weekday_hi" else WEEKDAYS_TE.get(word)
        if wd is None:
            wd = WEEKDAYS_HI_LATIN.get(word.casefold())
        rel_word = re.sub(r"\s+", " ", (g.get("rel") or "").casefold())
        rel = ""
        if rel_word:
            if re.fullmatch(_REL_HI_NEXT + "|" + _REL_TE_NEXT, rel_word):
                rel = "next"
            elif re.fullmatch(_REL_HI_THIS + "|" + _REL_TE_THIS, rel_word):
                rel = "this"
            else:
                rel = "last"
        return mk(_weekday(today, wd, rel, prefer)) if wd is not None else None
    if kind == "next_week":
        return mk(today + timedelta(days=7))
    if kind == "end_of_month":
        return mk(_end_of_month(today))
    if kind == "in_days":
        n = _small_int(g["n"], 0, 366)
        return mk(today + timedelta(days=n)) if n is not None else None
    if kind == "dm":
        return mk(_day_month(today, int(g["d"]), int(g["m"]), None, prefer))
    if kind in ("day_month_indic", "month_day_indic"):
        day = _small_int(g["d"], 1, 31)
        mon = INDIC_MONTHS.get(g["mon"])
        if day is None or mon is None:
            return None
        return mk(_day_month(today, day, mon, int(g["y"]) if g.get("y") else None, prefer))
    if kind == "day_of_month":
        if _EN_MONTH_WORD.match(text[end:]):
            return None  # "25th November" is handled (with its month) by the English day_month pattern
        return mk(_day_of_month(today, int(g["d"]), prefer))
    return None


def find_dates(text: str, today: date, *, prefer: str = FUTURE) -> list[DateMention]:
    """Every date phrase in the text, longest match first on overlaps, in order of appearance."""
    found: list[DateMention] = []
    for start, end, d, frag, name in text_parse.iter_dates(text, today, prefer=prefer):
        if name == "ordinal":  # "by the 25th": same rule as day_of_month, kept for the English phrasing
            d = _day_of_month(today, d.day, prefer) or d
        found.append(DateMention(frag, start, end, d, f"en_{name}"))
    for kind, rx in _INDIC_COMPILED:
        for m in rx.finditer(text):
            mention = _resolve(kind, m, text, today, prefer)
            if mention is not None:
                found.append(mention)
    found.sort(key=lambda x: (-(x.end - x.start), x.start))
    chosen: list[DateMention] = []
    for mention in found:
        if all(mention.end <= c.start or mention.start >= c.end for c in chosen):
            chosen.append(mention)
    return sorted(chosen, key=lambda x: x.start)


def _locate(fragment: str, context: str) -> tuple[int, int] | None:
    tokens = fragment.split()
    if not tokens:
        return None
    rx = re.compile(r"\s+".join(re.escape(t) for t in tokens), re.IGNORECASE)
    last = None
    for m in rx.finditer(context):
        last = m
    return (last.start(), last.end()) if last else None


def mentions_in_fragment(fragment: str, context: str, today: date, *, prefer: str) -> list[DateMention]:
    """Date mentions inside an evidence fragment, read in the context it was spoken in (so the tense of Hindi
    "कल" is taken from the whole clause, not just the word). The most recent occurrence of the fragment wins."""
    span = _locate(fragment, context) if context else None
    if span is None:
        return find_dates(fragment, today, prefer=prefer)
    s, e = span
    line_start = context.rfind("\n", 0, s) + 1
    line_end = context.find("\n", e)
    line = context[line_start : line_end if line_end >= 0 else len(context)]
    return [
        m
        for m in find_dates(line, today, prefer=prefer)
        if m.start < e - line_start and m.end > s - line_start
    ]


# ------------------------------------------------------------------ business clock
def local_today(timezone: str, now: datetime | None = None) -> date:
    """The calendar date in the business timezone at `now` (default: the current instant)."""
    instant = now or datetime.now(UTC)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    return instant.astimezone(ZoneInfo(timezone)).date()


def cheat_sheet(today: date) -> str:
    """Resolved dates for the common phrases, for the model's prompt (the server re-checks every write)."""
    tmr, yday = today + timedelta(days=1), today - timedelta(days=1)
    nxt = ", ".join(
        f"next {calendar.day_name[w]} = {_next_weekday(today, w, allow_today=False).isoformat()}"
        for w in range(7)
    )
    return (
        f"today = {today.isoformat()} ({today.strftime('%A')}); tomorrow = {tmr.isoformat()}; "
        f"yesterday = {yday.isoformat()}; day after tomorrow = {(today + timedelta(days=2)).isoformat()}; "
        f"{nxt}; end of this month = {_end_of_month(today).isoformat()}"
    )


# ------------------------------------------------------------------ dates spoken in a reply
_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯", "01234567890123456789")
_EN_MON_RX = rf"(?:{_EN_MON})\.?"
_REPLY_PATTERNS = [
    ("iso", re.compile(r"(?<!\d)(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})(?!\d)")),
    ("dmy", re.compile(r"(?<![\d/.-])(?P<d>\d{1,2})[/.-](?P<m>\d{1,2})[/.-](?P<y>\d{4})(?!\d)")),
    (
        "en_dm",
        re.compile(
            rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<mon>{_EN_MON_RX})(?![a-z])(?:,?\s*(?P<y>\d{{4}}))?",
            re.IGNORECASE,
        ),
    ),
    (
        "en_md",
        re.compile(
            rf"\b(?P<mon>{_EN_MON_RX})\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?!\d)(?:,?\s*(?P<y>\d{{4}}))?",
            re.IGNORECASE,
        ),
    ),
    (
        "in_dm",
        re.compile(
            rf"(?<!\d)(?P<d>\d{{1,2}})(?:\s*వ)?(?:\s*(?:తేదీ|तारीख़?))?\s*(?P<mon>{_HI_MON}|{_TE_MON})(?:{_TE_SUFFIX})?(?:,?\s*(?P<y>\d{{4}}))?"
        ),
    ),
    ("in_md", re.compile(rf"(?P<mon>{_HI_MON}|{_TE_MON})\s+(?P<d>\d{{1,2}})(?!\d)(?:,?\s*(?P<y>\d{{4}}))?")),
]


def reply_dates(text: str) -> list[tuple[int | None, int, int, str]]:
    """Calendar dates written in a reply as (year or None, month, day, matched text). Relative words are not
    returned: only explicit dates can contradict a stored one."""
    text = (text or "").translate(_DIGITS)
    spans: list[tuple[int, int]] = []
    out: list[tuple[int | None, int, int, str]] = []
    for kind, rx in _REPLY_PATTERNS:
        for m in rx.finditer(text):
            if any(m.start() < e and m.end() > s for s, e in spans):
                continue
            g = m.groupdict()
            if kind in ("iso", "dmy"):
                month = int(g["m"])
            elif kind.startswith("en"):
                month = text_parse.MONTHS.get(g["mon"].lower().rstrip("."), 0)
            else:
                month = INDIC_MONTHS.get(g["mon"], 0)
            day = int(g["d"])
            if not (1 <= month <= 12 and 1 <= day <= 31):
                continue
            spans.append((m.start(), m.end()))
            out.append((int(g["y"]) if g.get("y") else None, month, day, m.group(0)))
    return out


def unsupported_reply_dates(reply: str, allowed: set[date]) -> list[str]:
    """Explicit dates in the reply that match none of the allowed dates (tool results, the user's words)."""
    bad = []
    month_days = {(d.month, d.day) for d in allowed}
    for y, mo, d, txt in reply_dates(reply):
        if y is not None:
            try:
                ok = date(y, mo, d) in allowed
            except ValueError:
                ok = False
        else:
            ok = (mo, d) in month_days
        if not ok:
            bad.append(txt)
    return bad


ISO_RX = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")


def iso_dates_in(text: str) -> set[date]:
    out = set()
    for y, mo, d in ISO_RX.findall(text or ""):
        try:
            out.add(date(int(y), int(mo), int(d)))
        except ValueError:
            continue
    return out
