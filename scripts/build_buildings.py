#!/usr/bin/env python3
"""Build data/buildings.json -- UW building geometry (code -> name, lat/lng, footprint).

Sources (raw responses cached under data/raw/, re-download with --refresh):
  1. BuildingsV3        UW ArcGIS Online feature layer behind the UW Open Data API v3
                        /Buildings endpoint (buildingCode == codes used in class
                        schedules, e.g. E7, STP). Official names, parents, points.
  2. BuildingsView      Layer shown on the official campus map (uwaterloo.ca/map).
                        Newer naming (PSE, UTD, M4...), more accurate points.
  3. UW_Buildings       Building footprint polygons (UW ArcGIS, jmccarth). Matched by
                        SHORTNAME, else by point-in-polygon with the official point.
  4. OpenStreetMap      (optional, Overpass) fills missing polygons. Overpass is flaky;
                        the script just skips OSM if it can't be reached.

The Open Data API itself (openapi.data.uwaterloo.ca/v3/Buildings) needs a key; the
ArcGIS layers above are the public mirror of the same data.

Usage: python3 scripts/build_buildings.py [--refresh] [--osm]
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "buildings.json"
UA = "uw-room-map/0.1 (aarogyasutras@gmail.com)"

SV5 = "https://services5.arcgis.com/z87D0RdgTttiUQbV/arcgis/rest/services"
SOURCES = {
    "uw_buildingsv3_arcgis.geojson": f"{SV5}/BuildingsV3/FeatureServer/0",
    "uw_buildings_arcgis.geojson": f"{SV5}/BuildingsView/FeatureServer/0",
    "uw_building_footprints_arcgis.geojson":
        "https://services1.arcgis.com/DwLTn0u9VBSZvUPe/arcgis/rest/services/UW_Buildings/FeatureServer/0",
}
OSM_FILE = "osm_buildings_overpass.json"
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"]
OSM_QUERY = '[out:json][timeout:90];(way["building"](43.440,-80.575,43.490,-80.495);' \
            'relation["building"](43.440,-80.575,43.490,-80.495););out tags geom;'

# Main-campus sanity box (task spec) and the box used for map view.
MAIN_BOX = dict(lat=(43.465, 43.485), lng=(-80.56, -80.52))

# --------------------------------------------------------------------------
# Curation
# --------------------------------------------------------------------------
# Codes believed to host scheduled classes (task list + official academic bldgs).
ACADEMIC = set("""AL ARC B1 B2 BMH BRH C2 CGR CIF CLV CMH COG CPH DC DWE E2 E3 E5 E6 E7
EC5 ECH EIT ERC ESC EV1 EV2 EV3 GH GSC GSK HH HS LHI LIB M3 MC MKV ML NH OPT PAC PAS PHR
PHY QNC RA2 RAC RCH REN REV SCH SLC STC STJ STP TC TJB UWP IHB DMS DMS2 UC FED CSB
SJ1 SJ2 LH SH""".split())
# Which backend-layer codes are really the same building as the schedule code.
# schedule/v3 code -> campus-map code(s)
ALIASES = {"E7": ["PSE"], "STP": ["UTD", "STP-ADMIN"], "REV": ["REC"]}
ALIAS_NAMES = {"STP-ADMIN"}
# Child (sub-)buildings kept as their own entries (they are real class locations).
KEEP_CHILDREN = {"SJ1": "STJ-CB", "SJ2": "STJ-AC", "LH": "STJ-LH", "SH": "STJ-SW",
                 "FR": "STJ-FR", "RC": "STJ-RC", "EXP": None, "LHI": None,
                 "STP-EW": None, "STP-NW": None, "STP-WW": None, "STP-GRAD": None}
# Parents whose children are residence blocks / house wings: drop them.
DROP_PARENTS = {"CLN", "CLV", "V1", "REV", "MKV", "UWP"}
# Entries that are not buildings (names containing these are dropped).
DROP_NAME_WORDS = ("Grounds", "Tunnel", "Vault", "Kiosk", "Overpass", "Under Construction",
                   "Maryland", "Dubai")
COLLEGE = {"CGR": "Conrad Grebel University College", "REN": "Renison University College",
           "STJ": "St. Jerome's University", "STP": "St. Paul's University College",
           "UWP": "UW Place"}
CODE_COLLEGE = {}
for _c, _col in [("CGR", "Conrad Grebel"), ("AD", "Conrad Grebel"), ("APT", "Conrad Grebel"),
                 ("REN", "Renison"), ("REN-OB", "Renison"),
                 ("STJ", "St. Jerome's"), ("SJ1", "St. Jerome's"), ("SJ2", "St. Jerome's"),
                 ("LH", "St. Jerome's"), ("SH", "St. Jerome's"), ("FR", "St. Jerome's"),
                 ("RC", "St. Jerome's"),
                 ("STP", "St. Paul's"), ("STP-EW", "St. Paul's"), ("STP-NW", "St. Paul's"),
                 ("STP-WW", "St. Paul's"), ("STP-GRAD", "St. Paul's"),
                 ("UWP", "UWP")]:
    CODE_COLLEGE[_c] = _col
NAME_OVERRIDE = {"E7": "Engineering 7 (Pearl Sullivan Engineering Building)",
                 "STP": "St. Paul's University College (formerly United College)"}


# --------------------------------------------------------------------------
def http(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_arcgis(fname, layer_url, refresh):
    p = RAW / fname
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    q = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "outSR": 4326,
                                "f": "geojson", "resultRecordCount": 2000})
    body = http(f"{layer_url}/query?{q}")
    p.write_bytes(body)
    return json.loads(body)


def fetch_osm(refresh):
    p = RAW / OSM_FILE
    if p.exists() and not refresh:
        return json.loads(p.read_text())
    data = urllib.parse.urlencode({"data": OSM_QUERY}).encode()
    for url in OVERPASS:
        for attempt in range(2):
            try:
                body = http(url, data=data, timeout=100)
                j = json.loads(body)
                if "elements" in j:
                    p.write_bytes(body)
                    return j
            except Exception as e:  # noqa: BLE001
                print(f"  overpass {url} failed: {e}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    return None


# --------------------------------------------------------------------------
def ring_area_m2(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(a) / 2


def pip(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def outer_ring(geom):
    if geom["type"] == "Polygon":
        r = geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        r = max((poly[0] for poly in geom["coordinates"]), key=ring_area_m2)
    else:
        return None
    r = [[round(x, 6), round(y, 6)] for x, y in r]
    if r[0] == r[-1]:
        r = r[:-1]
    return r + [r[0]]


def norm(s):
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def which_campus(lat, lng):
    if MAIN_BOX["lat"][0] <= lat <= MAIN_BOX["lat"][1] and MAIN_BOX["lng"][0] <= lng <= MAIN_BOX["lng"][1]:
        return "waterloo"
    if 43.43 < lat < 43.47 and -80.52 < lng < -80.48:
        return "kitchener"
    if 43.47 < lat < 43.49 and -80.58 < lng < -80.52:
        return "waterloo"  # slightly outside the validation box (north/west campus)
    if 43.35 < lat < 43.38 and -80.99 < lng < -80.97:
        return "stratford"
    if 43.35 < lat < 43.37 and -80.33 < lng < -80.30:
        return "cambridge"
    if 43.6 < lat < 43.7 and -79.45 < lng < -79.3:
        return "toronto"
    return "other"


# --------------------------------------------------------------------------
def main():
    refresh = "--refresh" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    layers = {f: fetch_arcgis(f, u, refresh) for f, u in SOURCES.items()}
    v3 = layers["uw_buildingsv3_arcgis.geojson"]["features"]
    view = layers["uw_buildings_arcgis.geojson"]["features"]
    foot = layers["uw_building_footprints_arcgis.geojson"]["features"]
    osm = fetch_osm(refresh) if "--osm" in sys.argv or (RAW / OSM_FILE).exists() else None

    # ---- index sources ----------------------------------------------------
    v3_by = {f["properties"]["buildingCode"]: f["properties"] for f in v3}
    view_by = {}
    for f in view:
        p = f["properties"]
        if not p["buildingCode"] or not f["geometry"]:
            continue
        x, y = f["geometry"]["coordinates"]
        p = dict(p, lng=x, lat=y)
        # several features can share a code (S/L/M label scales): keep the main 'M'
        # label scale, else first seen.
        old = view_by.get(p["buildingCode"])
        rank = {"M": 0, "L": 1, "S": 2, "U": 3}
        if old is None or rank.get(p["Identifier"], 9) < rank.get(old["Identifier"], 9):
            view_by[p["buildingCode"]] = p
    footprints = []
    for f in foot:
        r = outer_ring(f["geometry"])
        if not r:
            continue
        sn = (f["properties"]["SHORTNAME"] or "").strip()
        footprints.append({"short": sn, "ring": r, "area": ring_area_m2(r),
                           "name": (f["properties"]["LONGNAME"] or "").strip()})
    osm_polys = []
    if osm:
        for el in osm["elements"]:
            if el["type"] == "way" and "geometry" in el:
                r = [[round(g["lon"], 6), round(g["lat"], 6)] for g in el["geometry"]]
                if len(r) >= 4 and r[0] == r[-1]:
                    t = el.get("tags", {})
                    osm_polys.append({"ring": r, "area": ring_area_m2(r[:-1]),
                                      "name": t.get("name", ""), "id": f"way/{el['id']}",
                                      "keys": {norm(t.get(k)) for k in ("ref", "short_name", "name", "alt_name") if t.get(k)}})

    # ---- candidate list -----------------------------------------------------
    # Canonical code: v3 (schedule) code; fall back to campus-map code.
    cands = {}

    def add(code, name, lat, lng, parent, src, approx=False, aliases=()):
        cands[code] = dict(code=code, name=name, lat=lat, lng=lng, parent=parent,
                           src=src, approx=approx, aliases=list(aliases))

    for code, p in v3_by.items():
        name = p["buildingName"] or code
        if any(w in name for w in DROP_NAME_WORDS):
            continue
        if p["parentBuildingCode"] in DROP_PARENTS or code in ("AB", "AH"):
            continue
        add(code, name, p["latitude"], p["longitude"], p["parentBuildingCode"], "v3")
    for code, p in view_by.items():
        name = p["buildingName"]
        if not name or any(w in name for w in DROP_NAME_WORDS):
            continue
        if p["parentBuildingCode"] in DROP_PARENTS and code not in ACADEMIC:
            continue
        # merge by alias
        canon = next((k for k, v in ALIASES.items() if code in v), None)
        if canon and canon in cands:
            cands[canon]["aliases"].append(code)
            cands[canon]["_view"] = p
            continue
        if code in cands:
            cands[code]["_view"] = p
            continue
        # view-only building: keep only if academic / child kept
        if code in ACADEMIC or code in KEEP_CHILDREN:
            add(code, name, p["lat"], p["lng"], p["parentBuildingCode"], "view")
            cands[code]["_view"] = p
    # v3 children of St. Jerome's -> map to view short codes (SJ1 etc.)
    for short, v3code in KEEP_CHILDREN.items():
        if v3code and v3code in cands and short in cands:
            cands[short]["aliases"].append(v3code)
            del cands[v3code]
    for code in [c for c in cands if c.startswith("STJ-") or c == "STP-ADMIN"]:
        # leftovers (e.g. STJ-SWA, STJ-RC if view lacks it): keep as aliases of parent
        par = cands[code]["parent"] or "STJ"
        if par in cands:
            cands[par]["aliases"].append(code)
        del cands[code]
    for canon, al in ALIASES.items():
        if canon in cands:
            cands[canon]["aliases"] = sorted(set(cands[canon]["aliases"] + al))
    if "STP-EW" in cands:  # keep STP wings from v3
        pass

    # ---- finalize: coordinates, polygons ------------------------------------
    out = []
    unlocated = []
    for code, c in sorted(cands.items()):
        view_p = c.get("_view") or view_by.get(code)
        if view_p is None:
            for a in c["aliases"]:
                if a in view_by:
                    view_p = view_by[a]
                    break
        lat, lng, approx, src = c["lat"], c["lng"], c["approx"], c["src"]
        if code in NAME_OVERRIDE:
            c["name"] = NAME_OVERRIDE[code]
        elif view_p is not None and view_p.get("buildingName"):
            c["name"] = view_p["buildingName"]
        if view_p is not None:  # campus map point preferred (more precise)
            lat, lng, src = view_p["lat"], view_p["lng"], "uw_campus_map"
        elif lat is not None:
            src = "uw_opendata_v3"
        # inherit from parent / alias target when no point
        if lat is None and c["parent"]:
            par = view_by.get(c["parent"]) or v3_by.get(c["parent"])
            if par and par.get("lat", par.get("latitude")) is not None:
                lat = par.get("lat", par.get("latitude"))
                lng = par.get("lng", par.get("longitude"))
                approx, src = True, f"parent:{c['parent']}"
        if lat is None:
            for a in c["aliases"]:
                if a in view_by:
                    lat, lng, src = view_by[a]["lat"], view_by[a]["lng"], f"alias:{a}"
                    break
        if lat is None:
            unlocated.append(code)
            continue
        # children that only share their parent's point are approximate
        if src == "uw_opendata_v3" and c["parent"] and \
                v3_by.get(c["parent"], {}).get("latitude") == lat:
            approx = True

        # polygon
        poly, poly_src = None, None
        keys = {code} | set(c["aliases"])
        cand_fp = [f for f in footprints if f["short"] in keys]
        if not cand_fp:
            inside = [f for f in footprints if f["area"] < 60000 and pip((lng, lat), f["ring"][:-1])]
            cand_fp = sorted(inside, key=lambda f: f["area"])[:1]
        if cand_fp:
            best = max(cand_fp, key=lambda f: f["area"])
            poly, poly_src = best["ring"], "uw_footprint"
        elif osm_polys:
            nk = {norm(code)} | {norm(a) for a in c["aliases"]} | {norm(c["name"])}
            hit = [o for o in osm_polys if o["keys"] & nk]
            if not hit:
                hit = sorted((o for o in osm_polys if o["area"] < 60000 and pip((lng, lat), o["ring"][:-1])),
                             key=lambda o: o["area"])[:1]
            if hit:
                poly, poly_src = hit[0]["ring"], f"osm:{hit[0]['id']}"
        campus = which_campus(lat, lng)
        college = CODE_COLLEGE.get(code) or CODE_COLLEGE.get(c["parent"] or "") or None
        rec = {
            "code": code,
            "name": c["name"],
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "campus": campus,
            "aliases": sorted(set(c["aliases"])),
            "affiliated_college": college,
            "parent": c["parent"],
            "hosts_classes": code in ACADEMIC,
            "coord_source": src,
            "polygon_source": poly_src,
            "polygon": poly,
        }
        if approx:
            rec["approx"] = True
        out.append(rec)

    # Only keep academic buildings + any other located building at the main campus
    # (non-academic ones stay flagged hosts_classes=false so the front end can ignore them).
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")

    # ---- validation / report ------------------------------------------------
    bad = [r["code"] for r in out if r["campus"] == "waterloo" and not
           (MAIN_BOX["lat"][0] <= r["lat"] <= MAIN_BOX["lat"][1] and MAIN_BOX["lng"][0] <= r["lng"] <= MAIN_BOX["lng"][1])]
    assert all(-80.57 <= r["lng"] <= -80.52 for r in out if r["campus"] == "waterloo"), "waterloo point out of range"
    main = [r for r in out if r["campus"] == "waterloo" and r["hosts_classes"]]
    lats = [r["lat"] for r in main]
    lngs = [r["lng"] for r in main]
    print(f"wrote {OUT} ({len(out)} buildings, {sum(r['hosts_classes'] for r in out)} flagged hosts_classes)")
    print("with polygon:", sum(1 for r in out if r["polygon"]), " hosts_classes w/ polygon:",
          sum(1 for r in out if r["polygon"] and r["hosts_classes"]))
    print("waterloo-campus academic bbox: lat %.5f..%.5f lng %.5f..%.5f center %.5f,%.5f" % (
        min(lats), max(lats), min(lngs), max(lngs), (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2))
    print("slightly outside main validation box (waterloo campus):", bad)
    print("no coordinates:", unlocated)
    print("academic codes missing from output:", sorted(ACADEMIC - {r["code"] for r in out}))
    print("non-main-campus:", [(r["code"], r["campus"]) for r in out if r["campus"] not in ("waterloo",)])


if __name__ == "__main__":
    main()
