# Data sources for UW class meetings

Verified 2026-10-27.

## Bottom line
- **No keyless public source currently exposes room/building.** The public Schedule of Classes
  still has the columns but they are empty; its banner says *"Building, room and instructor
  information is no longer housed here. Students can access this information in Quest...
  Employees ... Registrar Resources website."* (Quest and Registrar Resources need a UW login.)
- The only programmatic source with rooms is the **UW Open Data API v3**, which needs a free API key
  (not obtained during this work: registration emails a confirmation code, so it needs a human).
- `scripts/scrape_schedule.py` therefore has two modes: `html` (keyless; times only, room = null)
  and `api` (needs key; has rooms; field mapping written from the v3 docs but UNTESTED).

## 1. Public Schedule of Classes (keyless) - `--source html`
- Index pages: `https://classes.uwaterloo.ca/under.html` and `/grad.html` (list terms + subjects).
- Query: `POST https://classes.uwaterloo.ca/cgi-bin/cgiwrap/infocour/salook.pl`
  form fields `level=under|grad`, `sess=<term>`, `subject=<SUBJ>`, `cournum=` (empty = whole subject).
- robots.txt: `/robots.txt` returns 404 (no restrictions). Page says data refreshes every 30 min, 8am-8pm.
  Scraper uses 1.5 s delay, identifying User-Agent, and caches every response in `data/raw/<term>/`.
- TLS quirk: server sends a mismatched intermediate cert; Python's ssl rejects it, so the script
  falls back to system `curl` (verification stays on).
- Format: one HTML table per course; nested table of sections with columns
  Class#, Comp Sec ("LEC 001"), Camp Loc, Assoc Class, Rel 1/2, Enrl Cap/Tot, Wait Cap/Tot,
  "Time Days/Date", "Bldg Room", Instructor.
  - Time cell: `02:30-04:20Th` with **no AM/PM** (script: hours 1-7 => PM; a class that genuinely
    starts at 8:xx PM would be misread as AM - none seen). A second line `MM/DD-MM/DD` gives the
    date range when the meeting is not the whole term (no year; taken from term code).
  - Extra meetings of a section (other date ranges / patterns) come as **continuation rows** with
    empty leading cells (sometimes carrying a "Reserve:" label).
  - A cell containing only a date range = async online (no meeting time) -> skipped.
  - `Cancelled Section` / `Closed Section` appear as a trailing row; cancelled sections are dropped.
  - `Reserve:`, `Topic:`, `Held with:` rows are notes.
  - Day codes: M T W Th F S U(=Sunday -> "Su").
  - Campus codes: `UW U`, `ONLN ONLINE`, `WLU L` (Laurier-taught), `OFF ABROAD`, affiliates, etc.
    Online/WLU/off-campus rows are retained (see `campus`); filter on campus when building the site.
- Final exams are not in this feed. In-term tests (type `TST`) are, and are kept.

## 2. UW Open Data API v3 (needs key) - `--source api`
- Base `https://openapi.data.uwaterloo.ca/v3`; keyless request returns 401
  ("There does not appear to be an X-API-KEY header").
- Get a key: `GET/POST /v3/account` with your email -> emailed key + confirmation code
  (https://github.com/uWaterloo/OpenData/wiki/Home---Getting-Started). Swagger: `/api-docs/`.
- Used: `GET /Courses/{term}` -> subjectCode/catalogNumber/courseId; `GET /ClassSchedules/{term}/{courseId}`
  -> classSection, scheduleStartDate/EndDate, classMeetingStartTime/EndTime (24h),
  classMeetingDayPatternCode, **locationName** (e.g. "MC 2065"), instructor names.
  Verify the field names against the real response (cached in `data/raw/<term>/api_*.json`) on first run.
  Check rate limits in the key's terms (be gentle; ~1 req/1.5 s default).

## 3. Others checked
- `uwaterloo.ca/registrar-resources` -> redirects to login. `uwaterloo.ca/robots.txt` 404.
- No public classroom booking / room schedule page found.

## Term codes
`1` + two-digit year + month digit of term start: 1 = Winter (Jan), 5 = Spring (May), 9 = Fall (Sep).
1261 = Winter 2026, 1265 = Spring 2026, **1269 = Fall 2026**, 1271 = Winter 2027 (preliminary).

## Output: `data/schedule_<term>.json`
Flat list; per meeting: term, subject, catalog, section, type, class_nbr, building, room, days[], start,
end ("HH:MM" 24h), start_date/end_date (ISO; **null = whole term**), campus, level, instructor, title,
held_with, optional `also` (other course codes sharing the same room+slot, i.e. cross-listings).
Meetings with no room are never merged across courses.

## Refresh
```
python3 scripts/scrape_schedule.py --refresh            # current term, re-download (340 requests, ~25 min at observed latency)
python3 scripts/scrape_schedule.py --term 1271          # another term
python3 scripts/scrape_schedule.py                      # re-parse from cache only
UW_API_KEY=... python3 scripts/scrape_schedule.py --source api
```
No pip installs needed (stdlib only; `curl` must be on PATH for the TLS fallback).
Schedule changes up to 30 min old; refresh a few times a day at most.

## Caveats
- "Empty" = "no scheduled class". Ad-hoc bookings, club events, exams, labs not in the registrar feed are invisible.
- Without the API key there is no room data at all.

## Result of the 2026-10-27 run (term 1269, html source)
6,515 meetings (after parsing 4,949 sections / 1,820 courses; 96 cancelled sections dropped; 819 sections have
no meeting time = TBA/async). **0 rows have a building or room, 0 instructors** - confirmed across all 340 subject pages.
