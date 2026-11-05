#!/usr/bin/env python3
"""Generate SYNTHETIC demo data: web/data/rooms.demo.json (same format as build_site_data.py).

Every room number, course and busy interval here is made up (seeded random). The output carries
"demo": true so the UI shows a permanent DEMO DATA banner. Not real availability.

Usage: python3 scripts/make_demo_rooms.py [--seed 1269] [--out PATH]
"""
import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TERM_START, TERM_END = "2026-09-08", "2026-12-11"

# UW slot patterns (minutes since midnight). 50-min MWF slots start at :30 or :00 and end :20 / :50;
# 80-min Tu/Th slots; 170-min evening blocks.
H = 60
MWF = [(h * H + 30, h * H + 80) for h in range(8, 20)] + [(h * H, h * H + 50) for h in range(9, 19)]
TTH = [(8 * H + 30, 9 * H + 50), (10 * H, 11 * H + 20), (11 * H + 30, 12 * H + 50), (13 * H, 14 * H + 20),
       (14 * H + 30, 15 * H + 50), (16 * H, 17 * H + 20), (17 * H + 30, 18 * H + 50),
       (10 * H + 30, 11 * H + 50), (13 * H + 30, 14 * H + 50)]
EVE = [(18 * H + 30, 21 * H + 20), (19 * H, 21 * H + 50)]
SUBJECTS = ["CS", "MATH", "STAT", "PHYS", "CHEM", "ECE", "ENGL", "PSYCH", "ECON", "BIOL", "SOC", "PMATH",
            "AFM", "SCI", "CIVE", "ME", "HIST", "PHIL"]
LEVEL_FLOORS = {1: 1, 2: 2, 3: 3}


def fake_room_numbers(rng, code, n):
    """Plausible room numbers: floor digit + 3-digit number, e.g. 2065; some buildings use 'NNN'."""
    floors = rng.sample([0, 1, 2, 3, 4, 5], k=min(4, 6))
    out = set()
    tries = 0
    while len(out) < n and tries < 500:
        tries += 1
        f = rng.choice(floors)
        out.add(f"{f}{rng.randint(1, 99):03d}" if len(code) <= 3 and rng.random() < 0.5
                else f"{f}{rng.randint(1, 99):02d}")
    return sorted(out)


def gen_busy(rng, load):
    """load in 0..1 = approx fraction of weekday slots used. Returns busy dict with no overlaps."""
    busy = {}
    patterns = [("MWF", [1, 3, 5], MWF), ("TTH", [2, 4], TTH)]
    taken = {d: [] for d in range(1, 8)}

    def free(d, s, e):
        return all(e <= a or s >= b for a, b in taken[d])

    for name, days, slots in patterns:
        for s, e in slots:
            if rng.random() < load and all(free(d, s, e) for d in days):
                subj = rng.choice(SUBJECTS)
                label = f"{subj} {rng.choice([100, 135, 200, 240, 245, 300, 341, 370, 400])} LEC 00{rng.randint(1, 4)}"
                sd, ed = None, None
                if rng.random() < 0.08:  # a partial-term meeting
                    sd, ed = rng.choice([(TERM_START, "2026-10-16"), ("2026-10-19", TERM_END)])
                for d in days:
                    taken[d].append((s, e))
                    busy.setdefault(str(d), []).append([s, e, sd or TERM_START, ed or TERM_END, label])
    # a few evening blocks and a Wednesday/Friday single-day tutorial
    for d in (1, 2, 3, 4):
        if rng.random() < load * 0.35:
            s, e = rng.choice(EVE)
            if free(d, s, e):
                taken[d].append((s, e))
                busy.setdefault(str(d), []).append(
                    [s, e, TERM_START, TERM_END, f"{rng.choice(SUBJECTS)} {rng.choice([101, 280, 330])} LEC 081"])
    for d in (3, 5):
        for s, e in rng.sample(MWF, 3):
            if rng.random() < load * 0.5 and free(d, s, e):
                taken[d].append((s, e))
                busy.setdefault(str(d), []).append(
                    [s, e, TERM_START, TERM_END, f"{rng.choice(SUBJECTS)} {rng.choice([135, 200, 250])} TUT 10{rng.randint(1, 5)}"])
    for d in busy:
        busy[d].sort(key=lambda x: (x[0], x[1]))
    return busy


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=1269)
    ap.add_argument("--buildings", default=str(ROOT / "data" / "buildings.json"))
    ap.add_argument("--out", default=str(ROOT / "web" / "data" / "rooms.demo.json"))
    a = ap.parse_args(argv)
    rng = random.Random(a.seed)
    blds = [b for b in json.loads(Path(a.buildings).read_text())
            if b.get("hosts_classes") and b.get("campus") == "waterloo"]
    rooms, out_b = [], {}
    for b in sorted(blds, key=lambda x: x["code"]):
        n = rng.choice([4, 6, 8, 10, 12, 16, 22]) if b.get("polygon") else rng.choice([3, 5, 8])
        base = rng.uniform(0.15, 0.7)
        for rn in fake_room_numbers(rng, b["code"], n):
            load = min(0.9, max(0.03, rng.gauss(base, 0.18)))
            rooms.append({"id": f"{b['code']} {rn}", "building": b["code"], "room": rn,
                          "busy": gen_busy(rng, load)})
        entry = {"name": b.get("name"), "lat": b.get("lat"), "lng": b.get("lng")}
        if b.get("polygon"):
            entry["polygon"] = b["polygon"]
        out_b[b["code"]] = entry
    data = {"demo": True, "generated": "demo (synthetic, seed %d)" % a.seed, "term": 1269,
            "term_start": TERM_START, "term_end": TERM_END, "buildings": out_b, "rooms": rooms}
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out}: {len(out_b)} buildings, {len(rooms)} rooms (SYNTHETIC)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
