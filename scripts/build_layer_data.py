#!/usr/bin/env python3
"""Copy the bonus-layer data into the static site.

    python3 scripts/build_layer_data.py

Reads  data/libraries.json, data/study_spots.json   (research output, source of truth)
Writes web/data/libraries.json, web/data/study_spots.json   (compact copies the browser loads)

The site only fetches these two files when a person switches the Libraries or Study spots layer on
(or opens a building, for its study spots). Re-run this after editing anything in data/.
The script checks the files are the shape the UI expects and exits non-zero if not.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def load(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


def check_libraries(doc):
    errs = []
    libs = doc.get("libraries")
    est = doc.get("typical_busyness_estimate", {})
    if not isinstance(libs, list) or not libs:
        return ["libraries: missing list"]
    for lib in libs:
        lid = lib.get("id", "?")
        for k in ("id", "name", "building", "lat", "lng", "source_url"):
            if lib.get(k) in (None, ""):
                errs.append(f"{lid}: missing {k}")
        wh = lib.get("weekly_hours")
        if wh is not None and sorted(wh) != sorted(DAYS):
            errs.append(f"{lid}: weekly_hours must list all seven days or be null")
        lo = lib.get("live_occupancy")
        if lo is not None and not isinstance(lo.get("waitz_location_id"), int):
            errs.append(f"{lid}: live_occupancy needs an integer waitz_location_id")
    for d in DAYS:
        curve = est.get("hour_by_weekday", {}).get(d)
        if not (isinstance(curve, list) and len(curve) == 24):
            errs.append(f"estimate: hour_by_weekday.{d} must have 24 values")
    if not est.get("term_week_multiplier", {}).get("weeks"):
        errs.append("estimate: term_week_multiplier.weeks missing")
    return errs


def check_spots(spots):
    errs, seen = [], set()
    if not isinstance(spots, list) or not spots:
        return ["study_spots: missing list"]
    for s in spots:
        sid = s.get("id", "?")
        if sid in seen:
            errs.append(f"{sid}: duplicate id")
        seen.add(sid)
        for k in ("id", "name", "building", "lat", "lng", "tags", "source_url", "confidence"):
            if s.get(k) in (None, ""):
                errs.append(f"{sid}: missing {k}")
        if s.get("confidence") not in ("official", "anecdotal"):
            errs.append(f"{sid}: confidence must be official or anecdotal")
    return errs


def write_compact(name, doc):
    out = ROOT / "web" / "data" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")


def main():
    libs, spots = load("libraries.json"), load("study_spots.json")
    errs = check_libraries(libs) + check_spots(spots)
    if errs:
        print("\n".join(f"error: {e}" for e in errs), file=sys.stderr)
        return 1
    write_compact("libraries.json", libs)
    write_compact("study_spots.json", spots)
    return 0


if __name__ == "__main__":
    sys.exit(main())
