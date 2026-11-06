#!/usr/bin/env python3
"""Estimate each room's size from the classes scheduled in it, for the site's "est. capacity" label.

Real seat counts are not published, so the estimate is the largest number of students timetabled into the
room at once this term: enrolment caps (from the Schedule of Classes pages in data/raw/<term>/under_*.html)
joined by class number to rooms and times (data/schedule_<term>.json, the file the site is built from). Sections that meet in the same room at the
same time (cross-listed courses) are added together. Courses numbered below 100 (non-credit seminars, co-op
and study-abroad placeholders) and caps of 900+ are placeholders, not real class sizes, and are ignored. Only lectures and seminars
count: a lab or tutorial cap often covers a whole cohort that rotates through the room in smaller groups.
It is a lower bound on seats, not an official capacity.

Usage: python3 -I scripts/build_room_sizes.py [--term 1269]   -> web/data/room_sizes.json
"""
import argparse
import html
import json
import re
from collections import defaultdict
from pathlib import Path

import sys  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import NO_BUILDING, NO_ROOM, clean  # noqa: E402  same building/room cleaning as the site

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data" / "room_sizes.json"

COURSE = re.compile(
    r'<TR><TD ALIGN="center">([A-Z0-9 ]+?)\s*</TD>\s*<TD ALIGN="center">([0-9A-Z]+)</TD>\s*'
    r'<TD ALIGN="center">[^<]*</TD>\s*<TD ALIGN="center">.*?</TD>\s*</TR>(.*?)'
    r'(?=<TR><TD COLSPAN = 4></TD></TR>|</TABLE>\s*</BODY|$)', re.S | re.I)


def cells(row):
    return [html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).replace("\xa0", " ").strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S | re.I)]


def parse_caps(page):
    """{class_nbr: enrolment cap} from one Schedule of Classes results page."""
    caps = {}
    for m in COURSE.finditer(page):
        for row in re.findall(r"<TR>(.*?)</TR>", m.group(3), re.S | re.I):
            c = cells(row)
            if len(c) >= 9 and c[0].isdigit() and re.match(r"[A-Z]{3} \d{3}", c[1]):
                try:
                    caps[c[0]] = int(c[6])
                except ValueError:
                    pass
    return caps


PLACEHOLDER_CAP = 900
SEATED_TYPES = {"LEC", "SEM"}  # whole section is in the room at once


def real_course(catalog):
    digits = re.match(r"\d+", str(catalog or ""))
    return bool(digits) and int(digits.group()) >= 100


def room_sizes(meetings, caps, code_of=None):
    """{room id: estimate}. meetings: schedule records with class_nbr, catalog, building, room, days, start, end,
    start_date. code_of maps raw building names/aliases to the site's building codes (identity if None)."""
    together = defaultdict(int)  # (room, days, start, end, start_date) -> students timetabled at once
    for m in meetings:
        cap = caps.get(m.get("class_nbr"))
        if not cap or cap >= PLACEHOLDER_CAP or not real_course(m.get("catalog")):
            continue
        if m.get("type") not in SEATED_TYPES:  # lab/tutorial caps often cover a whole cohort rotating in groups
            continue
        bldg, room = clean(m.get("building")).upper(), clean(m.get("room"))
        if bldg in NO_BUILDING or room.upper() in NO_ROOM:
            continue
        code = code_of.get(bldg) if code_of is not None else bldg
        if not code:
            continue
        rid = f"{code} {room}"
        key = (rid, tuple(m.get("days") or ()), m.get("start"), m.get("end"), m.get("start_date"))
        together[key] += cap
    out = {}
    for (rid, *_), n in together.items():
        out[rid] = max(out.get(rid, 0), n)
    return dict(sorted(out.items()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", default="1269")
    a = ap.parse_args()
    caps = {}
    for f in sorted((ROOT / "data" / "raw" / a.term).glob("under_*.html")):
        caps.update(parse_caps(f.read_text("utf-8", "replace")))
    meetings = json.loads((ROOT / "data" / f"schedule_{a.term}.json").read_text())
    code_of = {}
    buildings = json.loads((ROOT / "data" / "buildings.json").read_text())
    for b in buildings:
        code_of[b["code"].upper()] = b["code"]
    for b in buildings:  # aliases never override real codes, as in build_site_data.py
        for alias in b.get("aliases") or []:
            code_of.setdefault(clean(alias).upper(), b["code"])
    sizes = room_sizes(meetings, caps, code_of)
    site_rooms = {r["id"] for r in json.loads((ROOT / "web" / "data" / "rooms.json").read_text())["rooms"]}
    sizes = {k: v for k, v in sizes.items() if k in site_rooms}
    OUT.write_text(json.dumps({"term": a.term, "method": "largest number of students timetabled in the room at once",
                               "rooms": sizes}, indent=1))
    print(f"{len(caps)} section caps, {len(sizes)} of {len(site_rooms)} site rooms estimated -> {OUT}")


if __name__ == "__main__":
    main()
