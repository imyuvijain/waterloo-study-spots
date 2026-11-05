# Bonus data sources: study spots and library busyness

Researched 2026-10-29. Files: `data/study_spots.json`, `data/libraries.json`.

## Live occupancy: one source exists

- UW Library's home page (https://lib.uwaterloo.ca/web) links "Real-time occupancy" to https://waitz.io/waterloo (Waitz, run by Occuspace, people-counting sensors).
- The page loads data from a public JSON endpoint, `https://waitz.io/live/waterloo`. It needs no login, sends `Access-Control-Allow-Origin: *`, and returned data on 2026-10-29.
- Covered: Dana Porter (id 215, capacity 959), Davis Centre (216, capacity 673), Musagetes Architecture (217, capacity 66). Each has `busyness` (0-100), `people`, `capacity`, `isOpen`, and `subLocs` for per-floor zones (zone ids are listed in `libraries.json` under `live_zones`).
- `https://waitz.io/compare/waterloo` returns trend text (peak hours, best floor right now).
- Caveats:
  - The JSON endpoint is undocumented and not an official UW API. It may change, be rate limited, or be withdrawn.
  - Poll gently (every 2-5 minutes), fall back to the estimate on any error, and credit Waitz/Occuspace.
  - I could not find a UW-run API for seat availability, and I did not log in to anything.
- Not covered by Waitz: the college libraries (Grebel, Renison, St. Jerome's), the Pharmacy library, and non-library study spaces. Only the three libraries above have live data.

## Estimate model: a heuristic, not measured

`typical_busyness_estimate` in `libraries.json` is a hand-built curve (hour by weekday, 0-1, times a term-week multiplier). It is not fitted to data and no measured history was found. The only calibration is one live Waitz reading (Thu 2026-10-29 about 14:20: Dana Porter 71%, Davis Centre 92%, Musagetes 27%), which suggests the curve is rough. The UI must label it "estimate, not live" and prefer the Waitz feed when it loads.

## Library hours

- https://libcal.uwaterloo.ca/hours (official). Observed week Sun 25 Oct to Sat 31 Oct 2026:
  - Dana Porter: Mon-Fri 08:00-21:00, Sat and Sun 11:00-21:00.
  - Davis Centre: Mon-Fri 08:00-00:00, Sat and Sun 11:00-00:00.
  - Musagetes: daily 08:00-22:30.
  - Help desks and others also listed on that page (Geospatial Centre, Special Collections, Witer Learning Resource Centre; the last is not mapped because I could not verify its building).
- These are regular term hours for one week. A query for a December date still returned the October week, so I could not read exam-week hours.
- Exam extensions: no Fall 2026 notice was found. Older notices (2014-2017) had Davis Centre 24 hours except Sunday 02:00-08:00 and Dana Porter 08:00-02:00:
  - https://uwaterloo.ca/library/news/extended-hours-start-november-24 (could not be fetched, 403; seen only in search snippets)
  - https://uwaterloo.ca/library/news/exam-extended-hours (403; snippets only)
  - https://uwaterloo.ca/library/news/extended-hours-during-exams
  - Daily Bulletin, 8 April 2025 (https://uwaterloo.ca/daily-bulletin/2025-04-08): spring 2025 hours were reduced, and extended exam hours were to continue.
  - These are historical and unconfirmed for this term. They are listed as exceptions, not as hours.

## Study spots

- Official: https://uwaterloo.ca/lib/study ("Study spaces on campus"). Source of most entries (libraries, SLC, NH, Tatham Centre, E5, QNC, STC, EV1/EV3, Hagey Hall, ML, MC, CPH).
- Official: https://uwaterloo.ca/lib/services/study-zones-dana-porter-library. Dana Porter floors: 6 quiet, 7 silent, 8 silent, 9 quiet, 10 group.
- Official: https://uwaterloo.ca/current-graduate-students/incoming-students/self-guided-tour. Source for the 24/7 Math Comfy Lounge and for the SLC being open 24 hours.
- Official: https://uwaterloo.ca/future-students/missing-manual/student-life/where-study (mixed official text and student quotes). Source for SLC, QNC window tables, whiteboards in the library rooms.
- Anecdotal: https://uwaterloo.ca/writing-and-communication-centre/blog/best-places-study-campus (student blog, 6 Aug 2018, likely dated). Entries sourced only from here are marked `anecdotal`.
- Davis Centre zone names (Silent Study Room, Quiet Study Corner, pods, etc.) come from the Waitz zone list; the library links Waitz, but Waitz is a third party. These entries say so in `source_note`.
- Group room booking: https://libcal.uwaterloo.ca/seats?lid=2604&gid=5325&c=-1 (Dana Porter), https://libcal.uwaterloo.ca/seats?lid=1736&gid=5324&c=-1 (Davis Centre), https://libcal.uwaterloo.ca/seats?lid=2606 (Elder Lodge).
- Tatham Centre room rules: https://uwaterloo.ca/co-operative-education/contact-us/tc-room-use-principles#tc-rooms
- College study rooms: https://uwaterloo.ca/grebel/milton-good-library/study-rooms, https://uwaterloo.ca/renison/book-library-study-room-form, https://www.sju.ca/studyrooms

## Building codes and coordinates

All codes exist in `data/buildings.json`, and coordinates are taken from it.

- Dana Porter is `LIB` in `buildings.json` ("Dana Porter Arts Library"), not DP.
- `ARC` is the School of Architecture in Cambridge, about 20 km from main campus. The Musagetes library is placed there.
- St. Jerome's library uses `SJ1` (Classrooms and Library Building). I chose it as the best match; it is not confirmed from an official page.
- `PHR` (Pharmacy library) is in Kitchener and open 24/7 to School of Pharmacy members only, so it is not included.

## Gaps and things not verified

- No official floor-level source for E7, EIT, M3, PAS open areas, or "DC 1350". They are not included, except PAS classrooms (anecdotal).
- Outlets are mentioned only anecdotally (Hagey Hall mezzanine, EV1 courtyard), and per-spot hours are mostly not listed.
- Grebel, Renison and St. Jerome's library hours were not verified, so `weekly_hours` is null for them.
- The Math Comfy Lounge room number is not stated on the official page. The 24/7 claim comes from a grad-student orientation page and is not independently confirmed.
- The SLC third-floor quiet room is partly closed for construction per the UW page, and one SLC group room is closed.
