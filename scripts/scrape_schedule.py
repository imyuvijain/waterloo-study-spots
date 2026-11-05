#!/usr/bin/env python3
"""Scrape University of Waterloo class meetings for one term -> data/schedule_<term>.json

Pure standard library (urllib + html.parser); no pip installs needed.

Two sources (see data/SOURCES.md):

  --source html  (default, keyless)
      Public Schedule of Classes at classes.uwaterloo.ca (salook.pl).
      Gives days / times / date ranges / section / type, BUT as of 2026 the site
      says "Building, room and instructor information is no longer housed here",
      so building/room/instructor are empty for (almost) every row.

  --source api
      UW Open Data API v3 (needs a free key in env UW_API_KEY, sent as the
      X-API-KEY header). This is the only known source that still exposes room
      ("locationName", e.g. "MC 2065"). UNTESTED here (no key was available) -
      field names are from the v3 docs and may need small tweaks; raw responses
      are cached so you can inspect them.

Usage:
  python3 scripts/scrape_schedule.py                 # current term (auto), html
  python3 scripts/scrape_schedule.py --term 1271
  UW_API_KEY=... python3 scripts/scrape_schedule.py --source api

Raw responses are cached in data/raw/<term>/ ; re-runs reuse the cache unless
--refresh is given. Requests are rate limited (--delay, default 1.5 s).
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BASE = "https://classes.uwaterloo.ca"
SALOOK = BASE + "/cgi-bin/cgiwrap/infocour/salook.pl"
UA = "campus-lecture-halls-scraper/1.0 (student project; polite, cached, 1 req/1.5s)"
API_BASE = "https://openapi.data.uwaterloo.ca/v3"
LEVELS = ("under", "grad")
DAY_RE = re.compile(r"Th|M|T|W|F|S|U")  # Th before T; U = Sunday


# ---------------------------------------------------------------- helpers
def current_term(today=None):
    """UW term code = 1 + 2-digit year + month digit (1=Winter, 5=Spring, 9=Fall)."""
    today = today or dt.date.today()
    m = 1 if today.month <= 4 else 5 if today.month <= 8 else 9
    return int("1%02d%d" % (today.year % 100, m))


def term_year(term):
    return 2000 + int(str(term)[1:3])


def _ssl_ctx():
    """Verified TLS. python.org builds on macOS ship without usable CAs, so prefer system bundles."""
    for cafile in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


CTX = _ssl_ctx()


def curl(url, data, hdr):
    """Fallback transport. classes.uwaterloo.ca serves an incomplete/mismatched TLS chain
    (missing the GlobalSign GCC R46 intermediate); python's ssl rejects it, but system
    curl (macOS SecureTransport fetches the intermediate via AIA) verifies it fine."""
    cmd = ["curl", "-sS", "--fail", "-m", "60"]
    for k, v in hdr.items():
        cmd += ["-H", "%s: %s" % (k, v)]
    if data:
        cmd += ["--data", urllib.parse.urlencode(data)]
    return subprocess.run(cmd + [url], check=True, capture_output=True).stdout.decode("utf-8", "replace")


def http(url, data=None, headers=None, retries=3):
    hdr = {"User-Agent": UA}
    hdr.update(headers or {})
    body = urllib.parse.urlencode(data).encode() if data else None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=hdr)
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError) as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
                return curl(url, data, hdr)
            if isinstance(e, urllib.error.HTTPError) and e.code in (401, 403, 404):
                raise
            print("  retry %d for %s: %s" % (i + 1, url, e), file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise RuntimeError("giving up on " + url)


class Fetcher:
    def __init__(self, term, delay, refresh):
        self.dir = os.path.join(DATA, "raw", str(term))
        os.makedirs(self.dir, exist_ok=True)
        self.delay, self.refresh, self.last = delay, refresh, 0.0

    def get(self, name, fn):
        path = os.path.join(self.dir, name)
        if os.path.exists(path) and not self.refresh:
            return open(path, encoding="utf-8").read()
        wait = self.delay - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        text = fn()
        self.last = time.time()
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return text


# ---------------------------------------------------------------- HTML parsing
class TableRows(HTMLParser):
    """Flatten nested tables into [(depth, [cell_text_with_newlines...]), ...]."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.stack = [], []  # stack: per-table dict(row=list|None, cell=list|None)

    def handle_starttag(self, tag, attrs):
        s = self.stack
        if tag == "table":
            s.append({"row": None, "cell": None})
        elif tag == "tr" and s:
            s[-1]["row"], s[-1]["cell"] = [], None
        elif tag in ("td", "th") and s and s[-1]["row"] is not None:
            self._close_cell()
            s[-1]["cell"] = []
        elif tag == "br" and s and s[-1]["cell"] is not None:
            s[-1]["cell"].append("\n")

    def handle_endtag(self, tag):
        s = self.stack
        if tag in ("td", "th") and s:
            self._close_cell()
        elif tag == "tr" and s and s[-1]["row"] is not None:
            self._close_cell()
            self.rows.append((len(s), s[-1]["row"]))
            s[-1]["row"] = None
        elif tag == "table" and s:
            s.pop()

    def _close_cell(self):
        t = self.stack[-1]
        if t["cell"] is not None and t["row"] is not None:
            txt = "".join(t["cell"]).replace("\xa0", " ")
            t["row"].append(txt)
        t["cell"] = None

    def handle_data(self, data):
        if self.stack and self.stack[-1]["cell"] is not None:
            self.stack[-1]["cell"].append(data)


def norm(s):
    return re.sub(r"[ \t\r]+", " ", s.replace("\xa0", " ")).strip()


def lines(s):
    return [norm(x) for x in s.split("\n") if norm(x)]


def to24(t, ampm_hint=None):
    h, m = map(int, t.split(":"))
    if ampm_hint == "p" and h < 12:
        h += 12
    elif ampm_hint == "a" and h == 12:
        h = 0
    return h, m


def parse_times(rng):
    """'08:30-10:20' (no am/pm on the site) or '8:30AM-10:20AM' -> ('08:30','10:20').

    The public site omits AM/PM. UW classes start no earlier than ~08:00 and end
    by ~22:00, so hours 1-7 are PM; 12 is noon. End is bumped by 12h if it would
    otherwise be <= start.
    """
    m = re.match(r"(\d{1,2}:\d{2})\s*([AaPp])?[Mm]?\s*-\s*(\d{1,2}:\d{2})\s*([AaPp])?[Mm]?$", rng)
    if not m:
        return None
    s, sa, e, ea = m.groups()
    sh, sm = to24(s, sa.lower() if sa else None)
    eh, em = to24(e, ea.lower() if ea else None)
    if not sa and sh < 8:
        sh += 12
    if not ea and eh < 8:
        eh += 12
    if (eh, em) <= (sh, sm) and not ea and eh < 12:
        eh += 12
    return "%02d:%02d" % (sh, sm), "%02d:%02d" % (eh, em)


def parse_dates(s, year):
    """'09/08-10/17' or '09/08' -> ISO dates in the term's year."""
    m = re.match(r"(\d{1,2})/(\d{1,2})(?:\s*-\s*(\d{1,2})/(\d{1,2}))?$", s)
    if not m:
        return None
    a, b, c, d = m.groups()
    start = dt.date(year, int(a), int(b))
    end = dt.date(year, int(c), int(d)) if c else start
    if end < start:  # range wrapping a year boundary (Dec -> Jan)
        end = dt.date(year + 1, end.month, end.day)
    return start.isoformat(), end.isoformat()


TIME_LINE = re.compile(r"^(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?)\s*([A-Za-z]*)\s*(.*)$")
ROOM_RE = re.compile(r"^([A-Z0-9]{1,6})\s+([A-Za-z0-9][A-Za-z0-9./-]*)$")


def split_room(txt):
    """'MC 2065' -> ('MC','2065'); 'ONLN ONLINE'/'TBA' -> (None,None)."""
    txt = norm(txt)
    if not txt or txt.upper() in ("TBA", "ONLINE", "ONLN ONLINE", "ONLN", "N/A"):
        return None, None
    m = ROOM_RE.match(txt)
    if m:
        return m.group(1), m.group(2)
    return None, txt  # odd format: keep raw in room, flagged later


def parse_page(text, term, level, stats):
    p = TableRows()
    p.feed(text)
    year = term_year(term)
    out = []
    subject = catalog = title = None
    last = None  # last section dict (for continuation rows)
    for depth, cells in p.rows:
        cells = [c for c in cells]
        if depth == 1 and len(cells) == 4 and norm(cells[0]) != "Subject":
            subject, catalog, title = norm(cells[0]), norm(cells[1]), norm(cells[3])
            last = None
            continue
        if depth < 2 or not cells:
            continue
        c0 = norm(cells[0])
        # Section row: class number + "LEC 001"
        if re.fullmatch(r"\d{3,5}", c0) and len(cells) >= 11 and re.match(r"^[A-Z]{2,4}\s+\d{3}", norm(cells[1])):
            typ, sec = norm(cells[1]).split()[:2]
            camp = norm(cells[2])
            sec_rec = {"class_nbr": c0, "type": typ, "section": sec, "campus": camp,
                       "time_lines": lines(cells[10]),
                       "room_lines": lines(cells[11]) if len(cells) > 11 else [],
                       "instr_lines": lines(cells[12]) if len(cells) > 12 else [],
                       "cancelled": False, "closed": False, "notes": []}
            sec_rec.update(subject=subject, catalog=catalog, title=title)
            out.append(sec_rec)
            last = sec_rec
            continue
        joined = norm(" ".join(cells))
        if last is None or not joined:
            continue
        # Continuation row: extra meeting(s) of the same section (the site wraps
        # to a new row for each additional date range / pattern). Some also carry
        # a "Reserve: ..." label, so locate the time cell by content, not index.
        ti = next((i for i, c in enumerate(cells) if re.search(r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}", c)), None)
        if ti is not None:
            last["time_lines"] += lines(cells[ti])
            last["room_lines"] += lines(cells[ti + 1]) if ti + 1 < len(cells) else []
            last["instr_lines"] += lines(cells[ti + 2]) if ti + 2 < len(cells) else []
            m = re.match(r"(Reserve:.*?)(?=\s{2,}|$)", norm(cells[0]))
            if m:
                last["notes"].append(m.group(1))
        elif "Cancelled Section" in joined:
            last["cancelled"] = True
        elif "Closed Section" in joined:
            last["closed"] = True
        else:
            last["notes"].append(joined)  # Reserve:, Held with:, topic, etc.
    meetings = []
    for s in out:
        stats["sections"] += 1
        if s["cancelled"]:
            stats["cancelled_sections"] += 1
            continue
        if s["type"] in ("EXM", "FIN", "MID"):
            stats["exam_rows_skipped"] += 1
            continue
        held = [n for n in s["notes"] if n.lower().startswith("held with")]
        got_any = False
        # time_lines = flat list of "HH:MM-HH:MMdays" lines, each optionally followed
        # by a "MM/DD-MM/DD" date line. Pair them up.
        items, k = [], 0
        tl = s["time_lines"]
        while k < len(tl):
            if re.match(r"^\d{1,2}/\d{1,2}", tl[k]):  # date range only = async/online, no meeting time
                stats["date_only_async"] += 1
                k += 1
                continue
            date_line = None
            if k + 1 < len(tl) and re.match(r"^\d{1,2}/\d{1,2}", tl[k + 1]):
                date_line = tl[k + 1]
            items.append((tl[k], date_line))
            k += 2 if date_line else 1
        for i, (tline, date_line) in enumerate(items):
            m = TIME_LINE.match(tline)
            times = parse_times(m.group(1)) if m else None
            if not times:
                stats["unparsed_time_lines"].append(tline)
                continue
            dpart = m.group(2)
            if m.group(3) and not date_line:
                date_line = m.group(3)
            days = DAY_RE.findall(dpart)
            if "".join(days) != dpart:
                stats["odd_day_strings"].append(tline)
            if not days:
                stats["no_days"] += 1
                continue
            dates = parse_dates(date_line, year) if date_line else None
            if date_line and not dates:
                stats["odd_date_strings"].append(date_line)
            rl = s["room_lines"]
            room_txt = rl[i] if i < len(rl) else (rl[-1] if len(rl) == 1 else "")
            bldg, room = split_room(room_txt)
            il = s["instr_lines"]
            inst = il[i] if i < len(il) else (il[-1] if len(il) == 1 else None)
            meetings.append({
                "term": term, "subject": s["subject"], "catalog": s["catalog"],
                "section": s["section"], "type": s["type"], "class_nbr": s["class_nbr"],
                "building": bldg, "room": room,
                "days": ["Su" if d == "U" else d for d in days],
                "start": times[0], "end": times[1],
                "start_date": dates[0] if dates else None,
                "end_date": dates[1] if dates else None,
                "campus": s["campus"], "level": level,
                "instructor": inst, "title": s["title"],
                "held_with": held[0] if held else None,
            })
            got_any = True
        if not got_any:
            stats["sections_without_meeting_times"] += 1  # TBA / online async / no schedule
    return meetings


def new_stats():
    return {"sections": 0, "cancelled_sections": 0, "exam_rows_skipped": 0,
            "sections_without_meeting_times": 0, "no_days": 0, "date_only_async": 0,
            "unparsed_time_lines": [], "odd_day_strings": [], "odd_date_strings": []}


# ---------------------------------------------------------------- HTML source
def subjects_for(fetch, level):
    page = fetch.get("index_%s.html" % level, lambda: http("%s/%s.html" % (BASE, level)))
    return re.findall(r'<OPTION VALUE="([A-Z0-9]+)"', page.split('NAME="subject"')[1].split("</SELECT>")[0], re.I)


def scrape_html(term, fetch, subjects=None):
    stats, meetings = new_stats(), []
    for level in LEVELS:
        subs = subjects_for(fetch, level)
        if subjects:
            subs = [s for s in subs if s in subjects]
        print("[%s] %d subjects" % (level, len(subs)), file=sys.stderr)
        for n, sub in enumerate(subs, 1):
            page = fetch.get("%s_%s.html" % (level, sub), lambda: http(
                SALOOK, data={"level": level, "sess": str(term), "subject": sub, "cournum": ""}))
            ms = parse_page(page, term, level, stats)
            meetings.extend(ms)
            print("  %s %s (%d/%d): %d meetings" % (level, sub, n, len(subs), len(ms)), file=sys.stderr)
    return meetings, stats


# ---------------------------------------------------------------- API source
def scrape_api(term, fetch, subjects=None):
    """UW Open Data v3. Endpoint/field names per the v3 docs; unverified without a key."""
    key = os.environ.get("UW_API_KEY")
    if not key:
        sys.exit("UW_API_KEY not set. Get a free key via POST/GET /v3/account (see data/SOURCES.md).")
    hdr = {"X-API-KEY": key, "Accept": "application/json"}
    stats, meetings = new_stats(), []
    courses = json.loads(fetch.get("api_courses.json", lambda: http("%s/Courses/%s" % (API_BASE, term), headers=hdr)))
    for c in courses:
        sub = c.get("subjectCode") or c.get("subject")
        cat = c.get("catalogNumber")
        if subjects and sub not in subjects:
            continue
        cid = c.get("courseId")
        raw = fetch.get("api_cs_%s_%s.json" % (sub, cat), lambda: http(
            "%s/ClassSchedules/%s/%s" % (API_BASE, term, cid), headers=hdr))
        for row in json.loads(raw):
            stats["sections"] += 1
            days = DAY_RE.findall(row.get("classMeetingDayPatternCode") or "")
            if not days:
                continue
            loc = row.get("locationName") or ""
            bldg, room = split_room(loc)
            st, en = (row.get("classMeetingStartTime") or "")[-8:-3], (row.get("classMeetingEndTime") or "")[-8:-3]
            if not st or not en:
                continue
            meetings.append({
                "term": term, "subject": sub, "catalog": cat,
                "section": row.get("classSection"), "type": (row.get("classSection") or "")[:3],
                "building": bldg, "room": room, "days": days, "start": st, "end": en,
                "start_date": (row.get("scheduleStartDate") or "")[:10] or None,
                "end_date": (row.get("scheduleEndDate") or "")[:10] or None,
                "instructor": " ".join(x for x in (row.get("instructorFirstName"), row.get("instructorLastName")) if x) or None,
            })
    return meetings, stats


# ---------------------------------------------------------------- dedupe + main
def dedupe(meetings):
    """Drop exact duplicates (same course/section/slot/room), keeping first.

    Cross-listed courses (e.g. CS 600 / SE 600) appear once per subject with
    different class_nbr but the SAME physical meeting; for room-occupancy
    purposes we also collapse meetings that share (room, days, start, end,
    dates) into one record with an 'also' list of the other course codes.
    Meetings without a room are never collapsed.
    """
    seen, out = {}, []
    for m in meetings:
        k = (m["subject"], m["catalog"], m["section"], tuple(m["days"]), m["start"], m["end"],
             m["start_date"], m["end_date"], m["building"], m["room"])
        if k in seen:
            continue
        seen[k] = m
        if m["room"]:
            rk = (m["building"], m["room"], tuple(m["days"]), m["start"], m["end"], m["start_date"], m["end_date"])
            first = seen.get(("R",) + rk)
            if first is not None:
                first.setdefault("also", []).append("%s %s %s %s" % (m["subject"], m["catalog"], m["type"], m["section"]))
                continue
            seen[("R",) + rk] = m
        out.append(m)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", type=int, default=current_term())
    ap.add_argument("--source", choices=("html", "api"), default="html")
    ap.add_argument("--subjects", help="comma list, for testing (e.g. MATH,CS)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between network requests")
    ap.add_argument("--refresh", action="store_true", help="ignore raw cache")
    a = ap.parse_args()
    subs = set(a.subjects.split(",")) if a.subjects else None
    fetch = Fetcher(a.term, a.delay, a.refresh)
    fn = scrape_html if a.source == "html" else scrape_api
    meetings, stats = fn(a.term, fetch, subs)
    raw_n = len(meetings)
    meetings = dedupe(meetings)
    meetings.sort(key=lambda m: (m["subject"], m["catalog"], m["section"], m["start"]))
    out = os.path.join(DATA, "schedule_%s.json" % a.term)
    with open(out, "w") as f:
        json.dump(meetings, f, indent=1)
    rooms = {(m["building"], m["room"]) for m in meetings if m["room"]}
    print(json.dumps({
        "term": a.term, "source": a.source, "meetings_raw": raw_n, "meetings": len(meetings),
        "meetings_with_room": sum(1 for m in meetings if m["room"]), "distinct_rooms": len(rooms),
        "sections": stats["sections"], "cancelled_sections": stats["cancelled_sections"],
        "exam_rows_skipped": stats["exam_rows_skipped"],
        "sections_without_meeting_times": stats["sections_without_meeting_times"],
        "date_only_async_lines": stats["date_only_async"],
        "unparsed_time_lines": stats["unparsed_time_lines"][:10],
        "odd_day_strings": sorted(set(stats["odd_day_strings"]))[:10],
        "odd_date_strings": sorted(set(stats["odd_date_strings"]))[:10],
        "output": out}, indent=1))


if __name__ == "__main__":
    main()
