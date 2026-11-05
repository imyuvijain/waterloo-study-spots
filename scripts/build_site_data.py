#!/usr/bin/env python3
"""Build web/data/rooms.json from data/schedule_<term>.json + data/buildings.json.

Usage: python3 scripts/build_site_data.py [--term 1269] [--schedule PATH]
       [--buildings PATH] [--out PATH] [--term-start YYYY-MM-DD --term-end YYYY-MM-DD]

Output busy intervals: rooms[].busy["1".."7"] = [[startMin, endMin, start_date, end_date, label], ...]
(1=Mon..7=Sun, minutes since midnight, end exclusive, dates inclusive).
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DAY_TOKENS = {
    "M": 1, "MON": 1, "MO": 1,
    "T": 2, "TU": 2, "TUE": 2, "TUES": 2,
    "W": 3, "WED": 3,
    "TH": 4, "R": 4, "THU": 4, "THUR": 4, "THURS": 4,
    "F": 5, "FRI": 5,
    "S": 6, "SA": 6, "SAT": 6,
    "SU": 7, "SUN": 7, "U": 7,
}
NO_ROOM = {"", "TBA", "TBD", "ONLINE", "ONLN", "ONLINE ONLY", "N/A", "NA", "NONE", "-"}
NO_BUILDING = {"", "TBA", "TBD", "ONLINE", "ONLN", "N/A", "NA", "NONE", "-"}


def parse_hhmm(s):
    m = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", s or "")
    if not m:
        raise ValueError(f"bad time {s!r}")
    return int(m.group(1)) * 60 + int(m.group(2))


def normalise_days(days):
    out = set()
    for d in days or []:
        tok = str(d).strip().upper().rstrip(".")
        if tok not in DAY_TOKENS:
            raise ValueError(f"unknown day token {d!r}")
        out.add(DAY_TOKENS[tok])
    return sorted(out)


def clean(s):
    return re.sub(r"\s+", " ", str(s)).strip() if s is not None else ""


def label_of(m):
    return " ".join(x for x in (clean(m.get("subject")), clean(m.get("catalog")),
                                clean(m.get("type")), clean(m.get("section"))) if x)


def merge_intervals(items):
    """items: [(start, end, sd, ed, labels:list)] -> merged where date ranges are identical."""
    by_range = defaultdict(list)
    for s, e, sd, ed, labels in items:
        by_range[(sd, ed)].append((s, e, list(labels)))
    out = []
    for (sd, ed), lst in by_range.items():
        lst.sort(key=lambda x: (x[0], x[1]))
        cur = None
        for s, e, labels in lst:
            if cur and s <= cur[1]:  # overlapping or touching
                cur[1] = max(cur[1], e)
                for l in labels:
                    if l not in cur[2]:
                        cur[2].append(l)
            else:
                if cur:
                    out.append((cur[0], cur[1], sd, ed, cur[2]))
                cur = [s, e, labels]
        if cur:
            out.append((cur[0], cur[1], sd, ed, cur[2]))
    out.sort(key=lambda x: (x[0], x[1], x[2] or "", x[3] or ""))
    return [[s, e, sd, ed, " / ".join(labels)] for s, e, sd, ed, labels in out]


def build(meetings, buildings, term=None, term_start=None, term_end=None, generated=None):
    """Return (rooms_json_dict, report_dict)."""
    code_of = {}
    for b in buildings:
        code_of[b["code"].upper()] = b["code"]
    for b in buildings:  # aliases never override real codes
        for a in b.get("aliases") or []:
            code_of.setdefault(clean(a).upper(), b["code"])
    by_code = {b["code"]: b for b in buildings}

    dates = [m["start_date"] for m in meetings if m.get("start_date")]
    edates = [m["end_date"] for m in meetings if m.get("end_date")]
    term_start = term_start or (min(dates) if dates else None)
    term_end = term_end or (max(edates) if edates else None)

    report = {"dropped_no_room": 0, "dropped_no_time_or_days": 0, "unknown_buildings": defaultdict(set),
              "deduped": 0}
    # (building, room) -> {(weekday, start, end, sd, ed): [labels]}
    slots = defaultdict(dict)
    for m in meetings:
        bldg_raw, room_raw = clean(m.get("building")).upper(), clean(m.get("room"))
        if bldg_raw in NO_BUILDING or room_raw.upper() in NO_ROOM:
            report["dropped_no_room"] += 1
            continue
        try:
            days = normalise_days(m.get("days"))
            start, end = parse_hhmm(m.get("start")), parse_hhmm(m.get("end"))
        except (ValueError, TypeError):
            days, start, end = [], 0, 0
        if not days or end <= start:
            report["dropped_no_time_or_days"] += 1
            continue
        code = code_of.get(bldg_raw)
        if code is None:
            report["unknown_buildings"][bldg_raw].add(room_raw)
            continue
        sd = m.get("start_date") or term_start
        ed = m.get("end_date") or term_end
        label = label_of(m)
        for d in days:
            lab = slots[(code, room_raw)].setdefault((d, start, end, sd, ed), [])
            if label in lab:
                report["deduped"] += 1  # same course repeated verbatim
            else:
                lab.append(label)
                if len(lab) > 1:
                    report["deduped"] += 1  # cross-listed identical meeting

    rooms = []
    for (code, room), sl in sorted(slots.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        per_day = defaultdict(list)
        for (d, s, e, sd, ed), labels in sl.items():
            per_day[d].append((s, e, sd, ed, labels))
        busy = {str(d): merge_intervals(per_day[d]) for d in sorted(per_day)}
        rooms.append({"id": f"{code} {room}", "building": code, "room": room, "busy": busy})

    used = {r["building"] for r in rooms}
    out_buildings = {}
    for code in sorted(used):
        b = by_code[code]
        entry = {"name": b.get("name"), "lat": b.get("lat"), "lng": b.get("lng")}
        if b.get("polygon"):
            entry["polygon"] = b["polygon"]
        out_buildings[code] = entry

    data = {
        "generated": generated or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "term": term,
        "term_start": term_start,
        "term_end": term_end,
        "buildings": out_buildings,
        "rooms": rooms,
    }
    report["unknown_buildings"] = {k: sorted(v) for k, v in sorted(report["unknown_buildings"].items())}
    return data, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", default="1269")
    ap.add_argument("--schedule")
    ap.add_argument("--buildings", default=str(ROOT / "data" / "buildings.json"))
    ap.add_argument("--out", default=str(ROOT / "web" / "data" / "rooms.json"))
    ap.add_argument("--term-start")
    ap.add_argument("--term-end")
    a = ap.parse_args(argv)
    schedule_path = Path(a.schedule or ROOT / "data" / f"schedule_{a.term}.json")
    meetings = json.loads(schedule_path.read_text())
    buildings = json.loads(Path(a.buildings).read_text())
    data, rep = build(meetings, buildings, term=int(a.term) if str(a.term).isdigit() else a.term,
                      term_start=a.term_start, term_end=a.term_end)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    n_iv = sum(len(v) for r in data["rooms"] for v in r["busy"].values())
    print(f"meetings in: {len(meetings)}; rooms: {len(data['rooms'])}; buildings: {len(data['buildings'])}; "
          f"busy intervals: {n_iv}")
    print(f"dropped (no room/TBA/online): {rep['dropped_no_room']}; "
          f"dropped (bad time/days): {rep['dropped_no_time_or_days']}; deduped: {rep['deduped']}")
    if rep["unknown_buildings"]:
        print("buildings not in buildings.json (skipped):")
        for b, rooms in rep["unknown_buildings"].items():
            print(f"  {b}: {', '.join(rooms[:8])}{' ...' if len(rooms) > 8 else ''}")
    print(f"wrote {out} (term {data['term_start']}..{data['term_end']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
