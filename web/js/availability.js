// Core availability logic. Pure ES module, no DOM, runs in node and browsers.
//
// Room shape (as produced by scripts/build_site_data.py):
//   { id: "MC 2065", building: "MC", room: "2065",
//     busy: { "1": [[startMin, endMin, startDate, endDate, label], ...], ..., "7": [...] } }
// Weekdays: 1=Mon .. 7=Sun. Minutes are since local (Toronto) midnight.
// A meeting occupies [start, end): start inclusive, end exclusive.
// startDate/endDate are inclusive "YYYY-MM-DD" strings (null/missing = unbounded).
// All wall-clock interpretation happens in America/Toronto, independent of the host zone.

export const TIMEZONE = 'America/Toronto';

const WEEKDAY_FROM_NAME = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short',
  hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});

export function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function formatMinutes(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Toronto wall-clock parts of an instant: {dateStr: "YYYY-MM-DD", weekday: 1..7, minutes}. */
export function torontoParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('invalid date');
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some engines emit 24 at midnight
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAY_FROM_NAME[p.weekday],
    minutes: hour * 60 + Number(p.minute),
  };
}

function toInterval([start, end, startDate = null, endDate = null, label = '']) {
  return { start, end, startDate, endDate, label };
}

function inDateRange(iv, dateStr) {
  return (!iv[2] || iv[2] <= dateStr) && (!iv[3] || dateStr <= iv[3]);
}

// Intervals of the room that apply on the given Toronto day (right weekday and date range).
function activeToday(room, parts) {
  const list = room.busy?.[parts.weekday];
  return list ? list.filter((iv) => inDateRange(iv, parts.dateStr)) : [];
}

function blocking(room, parts) {
  let best = null;
  for (const iv of activeToday(room, parts)) {
    if (iv[0] <= parts.minutes && parts.minutes < iv[1] && (!best || iv[1] > best[1])) best = iv;
  }
  return best;
}

function nextStart(room, parts) {
  let best = null;
  for (const iv of activeToday(room, parts)) {
    if (iv[0] > parts.minutes && (!best || iv[0] < best[0])) best = iv;
  }
  return best;
}

/** The class blocking the room at `date` (the one ending latest if several overlap), or null. */
export function busyNow(room, date) {
  const iv = blocking(room, torontoParts(date));
  return iv ? toInterval(iv) : null;
}

export function isFree(room, date) {
  return blocking(room, torontoParts(date)) === null;
}

/** The next class starting strictly after `date` today, or null. */
export function nextBusy(room, date) {
  const iv = nextStart(room, torontoParts(date));
  return iv ? toInterval(iv) : null;
}

/** Whole minutes the room stays free from `date`: 0 if busy now, null if free for the rest of the day. */
export function freeForMinutes(room, date) {
  const parts = torontoParts(date);
  if (blocking(room, parts)) return 0;
  const next = nextStart(room, parts);
  return next ? next[0] - parts.minutes : null;
}

/**
 * Instant (Date) at which the next class begins, or null if free for the rest of the day.
 * If the room is busy at `date`, returns a copy of `date` (it is free for zero more minutes).
 */
export function freeUntil(room, date) {
  const mins = freeForMinutes(room, date);
  if (mins === null) return null;
  // Align to the start of the current wall-clock minute, then add whole minutes.
  const subMinute = date.getTime() % 60000;
  const base = date.getTime() - ((subMinute + 60000) % 60000);
  return new Date(mins === 0 ? date.getTime() : base + mins * 60000);
}

export function roomsFreeAt(rooms, date) {
  const parts = torontoParts(date);
  return rooms.filter((r) => blocking(r, parts) === null);
}

/** {free, total} for the given rooms (typically all rooms of one building). */
export function buildingSummary(rooms, date) {
  const parts = torontoParts(date);
  let free = 0;
  for (const r of rooms) if (blocking(r, parts) === null) free++;
  return { free, total: rooms.length };
}

/** {BUILDING: {free, total}} across a mixed list of rooms. */
export function summarizeByBuilding(rooms, date) {
  const parts = torontoParts(date);
  const out = {};
  for (const r of rooms) {
    const s = (out[r.building] ??= { free: 0, total: 0 });
    s.total++;
    if (blocking(r, parts) === null) s.free++;
  }
  return out;
}
