#!/usr/bin/env python3
"""Download classroom photos from UW ITMS "Podium Instructions" (public pages, no login).

  https://itms-pdupdate.uwaterloo.ca/instructions/index.php        building list (POST clicked=<CODE> -> rooms)
  https://itms-pdupdate.uwaterloo.ca/instructions/podiumInstructions.php?roomCode=STC-1012
  https://itms-pdupdate.uwaterloo.ca/images/STC-1012/{frontOfRoom,backOfRoom,podium}.jpg

Only rooms ITMS manages are listed (UW says to ask the owning faculty for other rooms), and a room page
shows 'imageNotAvailable.jpg' for photos it lacks; those are skipped, never saved.

Usage (run from anywhere):
  python3 -I scripts/scrape_room_photos.py discover            # buildings -> rooms, cached in data/raw/itms/
  python3 -I scripts/scrape_room_photos.py fetch [--delay 1]   # room pages + original photos -> data/raw/itms/photos/
  python3 -I scripts/scrape_room_photos.py build               # resize originals -> web/images/rooms/ (macOS sips)
  python3 -I scripts/scrape_room_photos.py manifest            # write web/data/room_photos.json

Existing files are never re-downloaded (delete one to refresh). Be polite: one request at a time, --delay seconds apart.
"""
import argparse
import html
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://itms-pdupdate.uwaterloo.ca"
RAW = ROOT / "data" / "raw" / "itms"
ORIG = RAW / "photos"  # full-size originals (gitignored)
OUT = ROOT / "web" / "images" / "rooms"  # resized copies the site serves
FULL_PX, THUMB_PX = 1200, 360
MAGIC = {b"\xff\xd8": "jpg", b"\x89PNG": "png"}  # ITMS sometimes serves a PNG under a .jpg name


def find_original(room_dir, kind):
    return next((p for ext in ("jpg", "png") if (p := room_dir / f"{kind}.{ext}").exists()), None)
MANIFEST = ROOT / "web" / "data" / "room_photos.json"
UA = "campus-lecture-halls-hobby-project (personal, non-commercial; polite 1 req/s)"
KINDS = {"front": "frontOfRoom", "back": "backOfRoom"}  # our key -> ITMS file stem
THUMB_IDS = {"front": "FrontOfRoom", "back": "BackOfRoom"}  # podium photos are deliberately skipped


def request(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers.get("Content-Type", "")


def post_building(code):
    body, _ = request(f"{BASE}/instructions/index.php", urllib.parse.urlencode({"clicked": code}).encode())
    return body.decode("utf-8", "replace")


def parse_buildings(page):
    # <a name='STC'> ... <h3>Science Teaching Complex</h3> ... value='STC'
    out = {}
    for m in re.finditer(r"<a name='([A-Za-z0-9]+)'>\s*<form[^>]*>\s*<li[^>]*>\s*<h3>(.*?)</h3>", page, re.S):
        out[m.group(1)] = html.unescape(m.group(2)).strip()
    return out


def parse_rooms(page, code):
    start = page.find(f"<a name='{code}'>")
    if start < 0:
        return []
    block = page[start:]
    ul = block.find("<ul class='expandableRooms'>")
    nxt = block.find("<a name='", 10)
    if ul < 0 or (0 <= nxt < ul):
        return []
    end = block.find("</ul>", ul)
    return re.findall(r"name='roomCode' value='([^']+)'", block[ul:end])


def cmd_discover(_args):
    RAW.mkdir(parents=True, exist_ok=True)
    body, _ = request(f"{BASE}/instructions/index.php")
    index = body.decode("utf-8", "replace")
    buildings = parse_buildings(index)
    if not buildings:
        sys.exit("No buildings found on the instructions page; has the site changed?")
    rooms = {}
    for i, (code, name) in enumerate(buildings.items()):
        if i:
            time.sleep(ARGS.delay)
        page = post_building(code)
        found = parse_rooms(page, code)
        rooms[code] = {"name": name, "rooms": found}
        print(f"{code:5} {name[:44]:44} {len(found)} rooms")
    (RAW / "rooms.json").write_text(json.dumps(rooms, indent=1))
    print(f"{sum(len(v['rooms']) for v in rooms.values())} rooms in {len(rooms)} buildings -> {RAW / 'rooms.json'}")


def room_images(page):
    """{kind: relative-src} for the photos a room page really has (placeholders skipped)."""
    found = {}
    for kind, ident in THUMB_IDS.items():
        m = re.search(r"<img[^>]*src=\s*'([^']*)'[^>]*id='heroImageModalThumbnail%s'" % ident, page)
        if m and "imageNotAvailable" not in m.group(1):
            found[kind] = m.group(1).strip()
    return found


def cmd_fetch(args):
    index = json.loads((RAW / "rooms.json").read_text())
    codes = [r for b in index.values() for r in b["rooms"]]
    (RAW / "pages").mkdir(parents=True, exist_ok=True)
    got = skipped = missing = 0
    first = True
    for n, code in enumerate(codes, 1):
        cache = RAW / "pages" / f"{code}.html"
        if not cache.exists():
            if not first:
                time.sleep(args.delay)
            first = False
            body, _ = request(f"{BASE}/instructions/podiumInstructions.php?roomCode={urllib.parse.quote(code)}")
            cache.write_bytes(body)
        page = cache.read_text("utf-8", "replace")
        imgs = room_images(page)
        if not imgs:
            missing += 1
            print(f"[{n}/{len(codes)}] {code}: no photos")
            continue
        for kind, rel in imgs.items():
            dest = ORIG / code / f"{kind}.jpg"
            if find_original(ORIG / code, kind):
                skipped += 1
                continue
            url = urllib.parse.urljoin(f"{BASE}/instructions/podiumInstructions.php", rel)
            time.sleep(args.delay)
            try:
                body, ctype = request(urllib.parse.quote(url, safe=":/%?=&"))
            except urllib.error.HTTPError as e:
                print(f"[{n}/{len(codes)}] {code} {kind}: HTTP {e.code}")
                continue
            ext = next((e for m, e in MAGIC.items() if body.startswith(m)), None)
            if not ext:  # e.g. an HTML error page
                print(f"[{n}/{len(codes)}] {code} {kind}: not an image ({ctype}), skipped")
                continue
            dest = dest.with_suffix(f".{ext}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            got += 1
        print(f"[{n}/{len(codes)}] {code}: {', '.join(imgs)}")
    print(f"done: {got} downloaded, {skipped} already present, {missing} rooms without photos")


def sips(src, dest, px, quality):
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["sips", "-Z", str(px), "-s", "format", "jpeg", "-s", "formatOptions", str(quality),
                        str(src), "--out", str(dest)], capture_output=True, text=True)
    if r.returncode or not dest.exists():
        sys.exit(f"sips failed on {src}: {r.stderr.strip()[:200]} (this step needs macOS)")


def cmd_build(_args):
    """Resize every original to at most FULL_PX on the long edge, plus one thumbnail per room."""
    made = 0
    for room_dir in sorted(ORIG.glob("*")):
        first = None
        for kind in KINDS:
            src = find_original(room_dir, kind)
            if not src:
                continue
            dest = OUT / room_dir.name / f"{kind}.jpg"
            if not dest.exists():
                sips(src, dest, FULL_PX, 72)
                made += 1
            first = first or src
        if first:
            thumb = OUT / room_dir.name / "thumb.jpg"
            if not thumb.exists():
                sips(first, thumb, THUMB_PX, 68)
                made += 1
    print(f"{made} files written under {OUT}")


def cmd_manifest(_args):
    index = json.loads((RAW / "rooms.json").read_text())
    names = {c: b["name"] for c, b in index.items()}
    photos = {}
    for room_dir in sorted(OUT.glob("*")):
        files = {k: f"images/rooms/{room_dir.name}/{k}.jpg" for k in KINDS if (room_dir / f"{k}.jpg").exists()}
        if files and (room_dir / "thumb.jpg").exists():
            files["thumb"] = f"images/rooms/{room_dir.name}/thumb.jpg"
        if any(k in files for k in KINDS):
            photos[room_dir.name.replace("-", " ", 1)] = files  # STC-1012 -> "STC 1012", same ids as rooms.json
    MANIFEST.write_text(json.dumps({"source": f"{BASE}/instructions/index.php", "rooms": photos,
                                    "buildings": names}, indent=1))
    print(f"{len(photos)} rooms with photos -> {MANIFEST}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["discover", "fetch", "build", "manifest"])
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests (default 1)")
    ARGS = ap.parse_args()
    {"discover": cmd_discover, "fetch": cmd_fetch, "build": cmd_build, "manifest": cmd_manifest}[ARGS.cmd](ARGS)
