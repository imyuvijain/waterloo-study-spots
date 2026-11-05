# UW Empty Lecture Halls — Plan

## Goal
Show which University of Waterloo rooms are free at any chosen time, on an interactive campus map.
"Free" = no scheduled class meeting overlaps that time. Ad-hoc bookings and exams are NOT in the data; the UI must say so.

## Stack (my call, not yet confirmed by the user)
- Static site: vanilla JS (ES modules) + Leaflet + OpenStreetMap tiles. No backend, no build step.
- Python scripts produce JSON into `data/`; the site reads it. Deployable to any static host.

## Data contract
- `data/schedule_<term>.json`: flat list of meetings
  `{term, subject, catalog, section, type, building, room, days[], start "HH:MM", end "HH:MM", start_date, end_date}`
- `data/buildings.json`: `{code, name, lat, lng, polygon?, aliases[], approx?}`
- `web/data/rooms.json` (derived, built by `scripts/build_site_data.py`): per room, per weekday, the list of busy intervals plus date ranges, so the browser can answer "free now / free at T / free until when".

## Phases
1. **Data (parallel research agents)**: schedule scraper; building geometry.
2. **Core logic**: `web/js/availability.js` with unit tests: `isFree(room, datetime)`, `freeUntil`, `nextBusy`, handling of date ranges and weekdays. Test-driven.
3. **UI**: map with building markers/polygons coloured by number of free rooms; side panel listing rooms in a building with free-until times; time picker ("now" default) and filters (min capacity if available, building search).
4. **Bonus (after core works)**: study spots layer (curated list), library busyness (estimate only; no live source assumed).
5. **Verification**: run the site, check against known timetable entries, mobile layout.

## Non-goals
Live occupancy sensing, exam-period rooms, room booking.

## Bonus layers (built)
Two optional map layers, off by default: **Libraries** (open/closed from `weekly_hours` at the chosen Toronto time; busyness) and **Study spots** (44 curated spots, tag chips, official/anecdotal badge, source link).
- Data: `python3 scripts/build_layer_data.py` validates `data/libraries.json` + `data/study_spots.json` and writes compact copies to `web/data/`. Re-run after editing `data/`.
- Code: `web/js/libraries.js` (hours, estimate, live-vs-estimate choice), `waitz.js` (feed fetch/parse/poll timing), `studyspots.js` (tags, grouping), `layers.js` (DOM). Tests: `node --test`.
- Network: nothing extra on load. `libraries.json` is fetched when Libraries is switched on; `study_spots.json` when Study spots is switched on or a building is opened. The Waitz feed (`https://waitz.io/live/waterloo`, unofficial) is polled at most every 2 min, only while Libraries is on, the tab is visible and the time is "Now". Any failure, a reading older than 5 min, or a chosen time other than Now shows the hand-built estimate, labelled "Estimate, not live".

