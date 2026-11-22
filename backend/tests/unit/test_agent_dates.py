"""Deterministic date resolution (pure unit tests: no database, no provider)."""

from datetime import UTC, date, datetime

import pytest

from app.services.agent import dates as D
from app.services.agent.orchestrator import verify_reply_dates

SUN = date(2026, 11, 22)  # a Sunday
MON = date(2026, 11, 23)


def one(text: str, today: date = SUN, prefer: str = D.FUTURE) -> D.DateMention:
    found = D.find_dates(text, today, prefer=prefer)
    assert len(found) == 1, (text, found)
    return found[0]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # English
        ("today", SUN),
        ("tomorrow", MON),
        ("yesterday", date(2026, 11, 21)),
        ("day after tomorrow", date(2026, 11, 24)),
        ("next Monday", MON),  # Sunday edge: the first Monday strictly after today is tomorrow
        ("this Monday", MON),
        ("next Sunday", date(2026, 11, 29)),
        ("end of month", date(2026, 11, 30)),
        ("by the end of the month", date(2026, 11, 30)),
        ("in 3 days", date(2026, 11, 25)),
        ("in three days", date(2026, 11, 25)),
        ("25th November", date(2026, 11, 25)),
        ("on 5th December", date(2026, 12, 5)),
        ("November 25", date(2026, 11, 25)),
        ("25th November 2027", date(2027, 11, 25)),
        ("25/11", date(2026, 11, 25)),
        ("25/11/2026", date(2026, 11, 25)),
        ("2026-11-25", date(2026, 11, 25)),
        ("on the 25th", date(2026, 11, 25)),
        # Hindi
        ("आज", SUN),
        ("अगले सोमवार को", MON),
        ("इस शुक्रवार", date(2026, 11, 27)),
        ("पिछले शुक्रवार", date(2026, 11, 20)),
        ("महीने के अंत तक", date(2026, 11, 30)),
        ("5 दिन में", date(2026, 11, 27)),
        ("25 नवंबर", date(2026, 11, 25)),
        ("25 तारीख को", date(2026, 11, 25)),
        ("आने वाले कल", MON),
        # Telugu
        ("ఈరోజు", SUN),
        ("ఇవాళ", SUN),
        ("రేపు", MON),
        ("నిన్న", date(2026, 11, 21)),
        ("ఎల్లుండి", date(2026, 11, 24)),
        ("వచ్చే సోమవారం", MON),
        ("సోమవారానికి", MON),
        ("ఈ శుక్రవారం", date(2026, 11, 27)),
        ("నెలాఖరులోగా", date(2026, 11, 30)),
        ("మూడు రోజుల్లో", date(2026, 11, 25)),
        ("25 నవంబర్ నాటికి", date(2026, 11, 25)),
        ("డిసెంబర్ 5", date(2026, 12, 5)),
        ("25వ తేదీ", date(2026, 11, 25)),
    ],
)
def test_phrases_resolve_deterministically(text, expected):
    m = one(text)
    assert m.date == expected
    assert m.phrase in text


def test_monday_edge_next_versus_this():
    assert one("next Monday", MON).date == date(2026, 11, 30)
    assert one("this Monday", MON).date == MON
    assert one("వచ్చే సోమవారం", MON).date == date(2026, 11, 30)
    assert one("अगले सोमवार", MON).date == date(2026, 11, 30)
    # a bare weekday of a payment that already happened is the most recent one (today counts)
    assert one("Monday", MON, D.PAST).date == MON
    assert one("Monday", SUN, D.PAST).date == date(2026, 11, 16)
    assert one("last Monday", MON).date == date(2026, 11, 16)


def test_month_and_year_ends():
    nov30 = date(2026, 11, 30)
    assert one("end of month", nov30).date == nov30
    assert one("tomorrow", nov30).date == date(2026, 12, 1)
    assert one("నెలాఖరు", nov30).date == nov30
    assert one("on the 25th", nov30).date == date(2026, 12, 25)  # this month's 25th has passed
    assert one("on the 25th", nov30, D.PAST).date == date(2026, 11, 25)
    dec31 = date(2026, 12, 31)
    assert one("tomorrow", dec31).date == date(2027, 1, 1)
    assert one("in 3 days", dec31).date == date(2027, 1, 3)
    assert one("5th January", dec31).date == date(2027, 1, 5)  # yearless date in the past -> next year
    assert one("end of month", date(2027, 2, 10)).date == date(2027, 2, 28)
    assert D.find_dates("on the 30th", date(2027, 1, 31)) == []  # 30 February does not exist: never guessed


def test_combined_statement_has_two_dates_in_order():
    for text in (
        "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.",
        "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు. మిగిలిన మొత్తం వచ్చే సోమవారం ఇస్తాడు.",
        "रमेश ने आज पाँच हज़ार रुपये दिए, बाकी अगले सोमवार को देगा।",
    ):
        assert [m.date for m in D.find_dates(text, SUN)] == [SUN, MON], text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("रमेश ने कल 5000 दिए", date(2026, 11, 21)),
        ("रमेश ने कल पैसे दिए थे", date(2026, 11, 21)),
        ("रमेश कल 5000 देगा", MON),
        ("बाकी कल चुका देगा", MON),  # 'चुका देगा' is a future verb group, not the past auxiliary
        ("Ramesh kal dega", MON),
        ("kal diya tha", date(2026, 11, 21)),
        ("परसों देंगे", date(2026, 11, 24)),
        ("परसों दिए थे", date(2026, 11, 20)),
    ],
)
def test_hindi_kal_follows_the_tense(text, expected):
    assert one(text).date == expected


@pytest.mark.parametrize("text", ["रमेश कल", "कल के बारे में", "परसों"])
def test_hindi_kal_without_tense_is_ambiguous(text):
    m = one(text)
    assert m.ambiguous and m.date is None
    assert len(m.candidates) == 2 and m.reason


def test_fragment_is_read_in_its_sentence():
    said = "रमेश ने आज 5000 दिए, बाकी कल देगा"
    (m,) = D.mentions_in_fragment("कल", said, SUN, prefer=D.FUTURE)
    assert m.date == MON
    (m,) = D.mentions_in_fragment("आज", said, SUN, prefer=D.PAST)
    assert m.date == SUN
    # the latest line of a multi-line window wins
    window = "रमेश ने कल 5000 दिए\nबाकी कल देगा"
    (m,) = D.mentions_in_fragment("कल", window, SUN, prefer=D.FUTURE)
    assert m.date == MON


def test_business_timezone_decides_today():
    late_evening_utc = datetime(2026, 11, 22, 20, 0, tzinfo=UTC)  # 01:30 on Monday in India
    assert D.local_today("Asia/Kolkata", late_evening_utc) == MON
    assert D.local_today("UTC", late_evening_utc) == SUN
    assert D.local_today("America/New_York", late_evening_utc) == SUN
    ist_today = D.local_today("Asia/Kolkata", late_evening_utc)
    assert one("next Monday", ist_today).date == date(2026, 11, 30)
    assert one("tomorrow", ist_today).date == date(2026, 11, 24)


def test_cheat_sheet_lists_resolved_dates():
    s = D.cheat_sheet(SUN)
    assert "today = 2026-11-22 (Sunday)" in s
    assert "next Monday = 2026-11-23" in s
    assert "end of this month = 2026-11-30" in s


def test_reply_dates_are_found_in_three_languages():
    found = {(y, m, d) for y, m, d, _ in D.reply_dates("Paid on 2026-11-22; due 25th November 2026 or 5 Dec.")}
    assert found == {(2026, 11, 22), (2026, 11, 25), (None, 12, 5)}
    assert [(m, d) for _y, m, d, _ in D.reply_dates("बाकी 23 नवंबर को")] == [(11, 23)]
    assert [(m, d) for _y, m, d, _ in D.reply_dates("మిగిలినది 23 నవంబర్‌న")] == [(11, 23)]
    assert [(m, d) for _y, m, d, _ in D.reply_dates("२३ नवंबर")] == [(11, 23)]
    assert D.reply_dates("He owes ₹7,000 and will pay next Monday.") == []


def test_reply_dates_must_match_tool_results_or_user_words():
    allowed = '{"expected_payment_date": "2026-11-23", "payment_date": "2026-11-22"}'
    said = "Ramesh paid 5,000 today, the rest next Monday"
    assert verify_reply_dates("Ramesh will pay the rest on 23 November.", allowed, said, SUN)
    assert verify_reply_dates("రమేష్ మిగిలినది 23 నవంబర్ న ఇస్తారు.", allowed, said, SUN)
    assert verify_reply_dates("Recorded on 2026-11-22.", allowed, said, SUN)
    assert not verify_reply_dates("Ramesh will pay the rest on 30 November.", allowed, said, SUN)
    assert not verify_reply_dates("रमेश 30 नवंबर को बाकी देंगे।", allowed, said, SUN)
    assert not verify_reply_dates("Expected on 2026-11-30.", allowed, said, SUN)
    # a date the user explicitly said is allowed even before any tool ran
    assert verify_reply_dates("You said 5 December.", "", "Ramesh will pay 3000 on 5th December", SUN)
