#!/usr/bin/env python3
"""Scrape room/day/time data for one term from Quest's Class Search via the user's own, already
signed-in Safari tab (read-only: only the Class Search form is used).

Requirements: macOS Safari with Develop > "Allow JavaScript from Apple Events", a tab open on
https://quest.pecs.uwaterloo.ca/ ... CLASS_SEARCH.GBL (Student Center -> UW Class Search), signed in.
Never touches credentials; if a login/Duo/timeout page shows up the script stops (exit 2).

Usage:
  python3 -I scripts/scrape_quest.py fetch [--term 1269] [--subjects ECE,MATH] [--delay 4]
  python3 -I scripts/scrape_quest.py parse [--term 1269]      # raw -> data/quest_<term>.json
  python3 -I scripts/scrape_quest.py merge [--term 1269]      # join into data/schedule_<term>.json

Raw results (class-search result content only) are cached in data/raw/quest/<SUBJECT>_<UG|GRD>[_<n>].json;
existing files are never re-fetched (delete one to refresh). Big subjects (>= 300 sections, Quest's cap)
are split by course-number ranges automatically.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "quest"

FIND_TAB = '''
tell application "Safari"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      try
        if URL of t contains "quest.pecs.uwaterloo.ca" and URL of t contains "CLASS_SEARCH" then return ((id of w) as text) & ":" & i
      end try
    end repeat
  end repeat
  return ""
end tell
'''


class Stop(Exception):
    pass


def osa(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise Stop("osascript failed: " + r.stderr.strip()[:300])
    return r.stdout.strip()


def find_tab():
    r = subprocess.run(["osascript"], input=FIND_TAB, capture_output=True, text=True, timeout=60)
    loc = r.stdout.strip()
    if not loc:
        raise Stop("No Quest Class Search tab found in Safari (open Student Center -> UW Class Search).")
    w, t = loc.split(":")
    return int(w), int(t)


def js(code):
    """Run JS in the Quest tab; returns the (string) result."""
    w, t = find_tab()
    esc = code.replace("\\", "\\\\").replace('"', '\\"')
    return osa(f'tell application "Safari" to do JavaScript "{esc}" in tab {t} of window id {w}')


# ---- JS snippets (run inside the Class Search iframe frames[0]) -----------------------------
J_STATE = r"""(function(){var s={top:document.title,url:location.pathname};
try{var d=frames[0].document;s.hasForm=!!d.getElementById('SSR_CLSRCH_WRK_SUBJECT$0');
s.hasResults=!!d.getElementById('MTG_CLASS_NBR$0');
var ok=d.getElementById('#ICSave');s.warn=ok?d.body.innerText.replace(/\s+/g,' ').slice(0,300):'';
var m=d.getElementById('DERIVED_CLSMSG_ERROR_TEXT');s.msg=m?m.innerText.replace(/\s+/g,' ').slice(0,300):'';
var n=d.body.innerText.match(/(\d+) class section\(s\) found/);s.found=n?parseInt(n[1]):null;
s.bodyHead=(d.body.innerText.match(/(Search Results|Enter Search Criteria|[^\n]*(error|Error|no matching)[^\n]*)/)||[''])[0].slice(0,120);
}catch(e){s.err=String(e)}
return JSON.stringify(s)})()"""

J_OK = "(function(){frames[0].document.getElementById('#ICSave').click();return 'ok'})()"
J_MODIFY = ("(function(){var d=frames[0].document;var b=d.getElementById('CLASS_SRCH_WRK2_SSR_PB_MODIFY')"
            "||d.getElementById('CLASS_SRCH_WRK2_SSR_PB_NEW_SEARCH');if(!b)return 'nobtn';b.click();return 'ok'})()")

J_SEARCH = r"""(function(){var d=frames[0].document;var g=function(n){return d.getElementById(n)};
g('SSR_CLSRCH_WRK_SUBJECT$0').value=%(subject)s;
var op=g('SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$1');op.value=%(op)s;
g('SSR_CLSRCH_WRK_CATALOG_NBR$1').value=%(cat)s;
g('SSR_CLSRCH_WRK_ACAD_CAREER$2').value=%(career)s;
var o=g('SSR_CLSRCH_WRK_SSR_OPEN_ONLY$3');if(o.checked)o.click();
var t=g('CLASS_SRCH_WRK2_STRM$35$');if(t.value!==%(term)s){t.value=%(term)s;}
g('CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH').click();return 'ok'})()"""

J_EXTRACT = r"""(function(){var d=frames[0].document;var out=[],hdr='';
var nodes=d.querySelectorAll('[id^="win0divSSR_CLSRSLT_WRK_GROUPBOX2GP$"],a[id^="MTG_CLASS_NBR$"]');
var L=function(id){var e=d.getElementById(id);return e?e.innerText.split('\n').map(function(x){return x.trim()}):[]};
[].forEach.call(nodes,function(n){
 if(n.tagName==='A'){var i=n.id.split('$')[1];
  out.push({course:hdr,nbr:n.innerText.trim(),cls:L('MTG_CLASSNAME$'+i).join('|'),campus:L('UW_DERIVED_CLSR_CAMPUS$'+i).join(''),
   dt:L('MTG_DAYTIME$'+i),room:L('MTG_ROOM$'+i),instr:L('MTG_INSTR$'+i),dates:L('MTG_TOPIC$'+i)});}
 else{hdr=n.innerText.split('\n')[0].trim();}});
return JSON.stringify(out)})()"""


def jstr(s):
    return json.dumps(s)


def state():
    out = js(J_STATE)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise Stop("Could not read Quest page state: " + out[:200])


def check_session(s):
    blob = json.dumps(s).lower()
    if s.get("err") or any(k in blob for k in ("duo", "sign in", "log in", "login", "session has timed out",
                                                "timed out", "signon", "access denied", "locked", "blocked")):
        raise Stop("Quest looks signed out / blocked / errored: " + json.dumps(s)[:400])


def wait_for(pred, timeout=60, interval=1.5):
    t0 = time.time()
    s = None
    while time.time() - t0 < timeout:
        s = state()
        check_session(s)
        if pred(s):
            return s
        time.sleep(interval)
    return s


FORM_URL = "https://quest.pecs.uwaterloo.ca/psp/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.CLASS_SEARCH.GBL"


def reload_form():
    """Reload the Class Search page (same signed-in Quest session); used to reset a jammed form after an
    empty result. Stops if the session turned into a login page."""
    js(f"location.href='{FORM_URL}';'ok'")
    t0 = time.time()
    while time.time() - t0 < 60:
        time.sleep(2.5)
        try:
            s = state()
        except Stop:
            continue
        if s.get("hasForm"):
            return
    check_session(state())
    raise Stop("Class Search form did not load after reload")


def to_form():
    s = state()
    check_session(s)
    if s.get("hasForm"):
        return
    if s.get("hasResults") or s.get("found") is not None:
        if js(J_MODIFY) != "ok":
            raise Stop("Cannot find Modify Search button")
        s = wait_for(lambda s: s.get("hasForm"), 30)
        if not s or not s.get("hasForm"):
            raise Stop("Search form did not come back: " + json.dumps(s)[:300])
        return
    raise Stop("Unexpected page state: " + json.dumps(s)[:400])


def run_search(term, subject, career, op="E", cat=""):
    """Returns (found_count, sections, message). sections=[] when none."""
    to_form()
    code = J_SEARCH % {"subject": jstr(subject), "op": jstr(op), "cat": jstr(cat), "career": jstr(career),
                       "term": jstr(term)}
    if js(code) != "ok":
        raise Stop("search submit failed")
    t_submit = time.time()
    warned = 0
    s = None
    while True:
        time.sleep(1.5)
        s = state()
        check_session(s)
        if s.get("warn"):  # ">100 classes, continue?" dialog
            if "continue" not in s["warn"].lower() or warned > 3:
                raise Stop("Unknown dialog: " + s["warn"])
            warned += 1
            time.sleep(1)
            js(J_OK)
            t_submit = time.time()
            continue
        if s.get("hasResults") or s.get("found") is not None:
            time.sleep(1.5)
            break
        if s.get("hasForm") and s.get("msg"):
            break
        # empty results re-show the form without any text: give it 15 s, then call it empty
        if s.get("hasForm") and time.time() - t_submit > 15:
            break
        if time.time() - t_submit > 120:
            raise Stop("search timed out: " + json.dumps({k: v for k, v in s.items() if k != "bodyHead"}))
    if s.get("hasResults"):
        secs = json.loads(js(J_EXTRACT))
        return s.get("found"), secs, ""
    msg = s.get("msg") or s.get("bodyHead", "")
    if msg in ("Enter Search Criteria", ""):
        # Quest re-shows the empty form (no text) when a subject/career has no classes
        reload_form()
        return 0, [], "NO_MESSAGE_EMPTY_RESULT"
    return 0, [], msg


def raw_path(subject, career, tag=""):
    return RAW / f"{subject}_{career}{tag}.json"


def save_raw(path, subject, career, term, found, secs, msg, extra=None):
    RAW.mkdir(parents=True, exist_ok=True)
    rec = {"term": term, "subject": subject, "career": career, "found": found, "msg": msg,
           "fetched": datetime.now().isoformat(timespec="seconds"), "sections": secs}
    if extra:
        rec.update(extra)
    path.write_text(json.dumps(rec, indent=0))


NO_RESULT_PAT = re.compile(r"no (matching|classes|results)|did not (return|find)|not found|returned no", re.I)
CAP_PAT = re.compile(r"more than|exceed|too many|limit|narrow|refine", re.I)


def fetch_one(term, subject, career, delay, log):
    path = raw_path(subject, career)
    if path.exists() or list(RAW.glob(f"{subject}_{career}_*.json")):
        return "cached"
    found, secs, msg = run_search(term, subject, career)
    time.sleep(delay)
    if secs:
        if found and len(secs) != found:
            log(f"  WARN {subject} {career}: found {found} but extracted {len(secs)}")
        save_raw(path, subject, career, term, found, secs, msg)
        return f"{len(secs)} sections"
    if msg == "NO_MESSAGE_EMPTY_RESULT":
        found, secs, msg = run_search(term, subject, career)  # retry once to rule out a transient failure
        time.sleep(delay)
        if secs:
            save_raw(path, subject, career, term, found, secs, "")
            return f"{len(secs)} sections (retry)"
        save_raw(path, subject, career, term, 0, [], "no results (form re-shown, no message)")
        return "none"
    if NO_RESULT_PAT.search(msg or ""):
        save_raw(path, subject, career, term, 0, [], msg)
        return "none"
    if CAP_PAT.search(msg or ""):
        # split by catalog number: <=199, 200-299 ..., using ">=" for each hundred and filter client-side
        log(f"  cap hit for {subject} {career}: {msg[:120]!r}; splitting by course number prefix")
        allsecs = {}
        for n in range(1, 10):
            cat = str(n * 100)
            f2, s2, m2 = run_search(term, subject, career, op="C", cat=str(n))
            time.sleep(delay)
            if m2 and not s2 and not NO_RESULT_PAT.search(m2):
                raise Stop(f"cap split failed for {subject} {career} cat~{n}: {m2[:200]}")
            for s in s2:
                allsecs[(s["course"], s["nbr"])] = s
        save_raw(path, subject, career, term, len(allsecs), list(allsecs.values()), msg, {"split": True})
        return f"{len(allsecs)} sections (split)"
    raise Stop(f"Unrecognised message for {subject} {career}: {msg[:300]!r}")


def subjects_from_schedule(term):
    d = json.loads((ROOT / "data" / f"schedule_{term}.json").read_text())
    subs = {}
    for m in d:
        subs.setdefault(m["subject"], set()).add(m.get("level"))
    return subs


def cmd_fetch(a):
    subs = subjects_from_schedule(a.term)
    if a.subjects:
        want = a.subjects.split(",")
        subs = {s: subs.get(s, {"under", "grad"}) for s in want}
    # Query both careers for every subject (cheap, avoids relying on public-schedule levels)
    jobs = [(s, c) for s in sorted(subs) for c in ("UG", "GRD")]
    # skip careers the public schedule says do not exist (by level); still try when unknown
    jobs = [(s, c) for s, c in jobs if not (subs[s] and None not in subs[s] and
                                           ("under" if c == "UG" else "grad") not in subs[s])]
    RAW.mkdir(parents=True, exist_ok=True)
    logf = open(RAW / "_fetch.log", "a")

    def log(m):
        print(m, flush=True)
        logf.write(m + "\n")
        logf.flush()

    todo = [(s, c) for s, c in jobs if not raw_path(s, c).exists() and not list(RAW.glob(f"{s}_{c}_*.json"))]
    log(f"{datetime.now():%F %T} {len(jobs)} subject/career jobs, {len(todo)} to fetch")
    errors = 0
    for i, (s, c) in enumerate(todo, 1):
        try:
            r = fetch_one(a.term, s, c, a.delay, log)
            errors = 0
            log(f"[{i}/{len(todo)}] {s} {c}: {r}")
        except Stop as e:
            log(f"STOP at {s} {c}: {e}")
            return 2
        except Exception as e:  # noqa
            errors += 1
            log(f"ERROR {s} {c}: {e!r}")
            if errors >= 3:
                log("3 consecutive errors, aborting")
                return 3
            time.sleep(10)
    log("fetch done")
    return 0


# ---- parsing ---------------------------------------------------------------------------------
DAY_RE = re.compile(r"(Mo|Tu|We|Th|Fr|Sa|Su)")
DAY_MAP = {"Mo": "M", "Tu": "T", "We": "W", "Th": "Th", "Fr": "F", "Sa": "S", "Su": "Su"}
DT_RE = re.compile(r"^((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)$")
DATES_RE = re.compile(r"^(\d\d)/(\d\d)/(\d{4})\s*-\s*(\d\d)/(\d\d)/(\d{4})$")
COURSE_RE = re.compile(r"^\s*(\S+)\s+(\S+)\s+-\s+(.*)$")


def hhmm(s):
    t = datetime.strptime(s, "%I:%M%p")
    return t.strftime("%H:%M")


def parse_room(s):
    s = (s or "").strip()
    if not s or re.match(r"to be announced|tba", s, re.I):
        return None, None, s
    m = re.match(r"^(\S+)\s+(.+)$", s)
    if not m:
        return s, None, s
    return m.group(1).upper(), m.group(2).strip(), s


def parse_section(sec, subject_hint=None):
    out, problems = [], []
    m = COURSE_RE.match(sec["course"])
    subject, catalog = (m.group(1), m.group(2)) if m else (subject_hint, None)
    title = m.group(3).strip() if m else None
    cm = re.match(r"^([^|\s-]+)-([^|\s]+)", sec["cls"])
    section, typ = (cm.group(1), cm.group(2)) if cm else (None, None)
    n = len(sec["dt"])
    lens = (len(sec["room"]), len(sec["dates"]))
    if any(l != n for l in lens):
        problems.append(f"{sec['nbr']}: ragged meeting columns dt={n} room/dates={lens}")
    names = []
    for line in sec["instr"]:
        for nm in line.split(","):
            nm = nm.strip()
            if nm and not re.match(r"to be announced|staff$", nm, re.I) and nm not in names:
                names.append(nm)
    instructor = ", ".join(names) or None
    for j in range(n):
        g = lambda k: sec[k][j] if j < len(sec[k]) else ""
        dtm = DT_RE.match(g("dt"))
        if not dtm:
            continue  # TBA / no meeting time
        days = [DAY_MAP[d] for d in DAY_RE.findall(dtm.group(1))]
        b, r, rawroom = parse_room(g("room"))
        dm = DATES_RE.match(g("dates"))
        sd = ed = None
        if dm:
            sd = f"{dm.group(3)}-{dm.group(1)}-{dm.group(2)}"
            ed = f"{dm.group(6)}-{dm.group(4)}-{dm.group(5)}"
        out.append({"class_nbr": sec["nbr"], "subject": subject, "catalog": catalog, "section": section,
                    "type": typ, "building": b, "room": r, "room_raw": rawroom, "days": days,
                    "start": hhmm(dtm.group(2)), "end": hhmm(dtm.group(3)), "start_date": sd, "end_date": ed,
                    "instructor": instructor,
                    "campus": sec.get("campus"), "title": title})
    return out, problems


def cmd_parse(a):
    recs, problems, nsec = [], [], 0
    for f in sorted(RAW.glob("*_*.json")):
        if f.name.startswith("_"):
            continue
        d = json.loads(f.read_text())
        for sec in d["sections"]:
            nsec += 1
            r, p = parse_section(sec, d["subject"])
            recs += r
            problems += p
    out = ROOT / "data" / f"quest_{a.term}.json"
    out.write_text(json.dumps(recs, separators=(",", ":")))
    withroom = sum(1 for r in recs if r["building"] and r["room"])
    print(f"{nsec} sections -> {len(recs)} timed meetings ({withroom} with building+room); wrote {out}")
    if problems:
        print(f"{len(problems)} ragged sections, e.g.", problems[:3])
    return 0


def cmd_merge(a):
    """Quest rows are authoritative for room, time and dates (they carry holiday-split date ranges and
    correct AM/PM). Output = one meeting per distinct Quest row, enriched with level/title/held_with/etc. from
    the public schedule (joined on class_nbr). Public-schedule meetings whose class_nbr does not appear in
    Quest at all are kept unchanged (room null). Coverage is reported against the public schedule."""
    sched_path = ROOT / "data" / f"schedule_{a.term}.json"
    backup = ROOT / "data" / f"schedule_{a.term}.norooms.json"
    if not backup.exists():
        backup.write_text(sched_path.read_text())
    sched = json.loads(backup.read_text())  # always merge onto the room-less original
    quest = json.loads((ROOT / "data" / f"quest_{a.term}.json").read_text())
    by_nbr = {}
    for q in quest:
        by_nbr.setdefault(q["class_nbr"], []).append(q)
    meta = {}
    for m in sched:
        meta.setdefault(str(m.get("class_nbr")), m)

    qkey = lambda q: (tuple(q["days"]), q["start"], q["end"])
    key_match = nbr_only = nbr_missing = 0
    for m in sched:
        qs = by_nbr.get(str(m.get("class_nbr")))
        if not qs:
            nbr_missing += 1
        elif any(qkey(q) == (tuple(m["days"]), m["start"], m["end"]) for q in qs):
            key_match += 1
        else:
            nbr_only += 1
    out, seen = [], set()
    for q in quest:
        sig = (q["class_nbr"], tuple(q["days"]), q["start"], q["end"], q["building"], q["room"],
               q["start_date"], q["end_date"])
        if sig in seen:
            continue
        seen.add(sig)
        base = meta.get(q["class_nbr"], {})
        n = {"term": int(a.term), "subject": q["subject"], "catalog": q["catalog"], "section": q["section"],
             "type": q["type"], "class_nbr": q["class_nbr"], "building": q["building"], "room": q["room"],
             "days": q["days"], "start": q["start"], "end": q["end"],
             "start_date": q["start_date"], "end_date": q["end_date"],
             "campus": q["campus"] or base.get("campus"), "level": base.get("level"),
             "instructor": q["instructor"], "title": base.get("title") or q["title"],
             "held_with": base.get("held_with")}
        out.append(n)
    kept = 0
    for m in sched:
        if str(m.get("class_nbr")) not in by_nbr:
            out.append(dict(m))
            kept += 1
    withroom = sum(1 for m in out if m.get("building") and m.get("room"))
    sched_path.write_text(json.dumps(out, separators=(",", ":")))
    N = len(sched)
    print(f"public-schedule meetings: {N}; same class_nbr+days+time in Quest: {key_match} ({100*key_match/N:.1f}%); "
          f"class_nbr in Quest but time differs (Quest time used, e.g. PM misparse): {nbr_only}; "
          f"class_nbr absent from Quest (kept, no room): {nbr_missing}")
    print(f"output meetings: {len(out)} (Quest rows {len(out)-kept}, kept schedule-only {kept}); "
          f"with building+room: {withroom} ({100*withroom/len(out):.1f}%)")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "parse", "merge"])
    ap.add_argument("--term", default="1269")
    ap.add_argument("--subjects")
    ap.add_argument("--delay", type=float, default=4.0)
    a = ap.parse_args()
    try:
        return {"fetch": cmd_fetch, "parse": cmd_parse, "merge": cmd_merge}[a.cmd](a)
    except Stop as e:
        print("STOP:", e)
        return 2


if __name__ == "__main__":
    sys.exit(main())
