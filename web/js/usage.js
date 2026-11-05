// Weekly room usage: how many hours each room is in scheduled class across a Mon-Fri week.
// Pure ES module (no DOM). Same room shape and semantics as availability.js:
// intervals are [startMin, endMin, startDate, endDate, label), weekdays 1=Mon..7=Sun, date ranges inclusive.
// Overlapping meetings in one room count once (union), and only minutes inside the window count.

export const WINDOW_START = 8 * 60; // 08:00
export const WINDOW_END = 22 * 60; // 22:00
export const WEEKDAYS = 5; // Mon-Fri

const DAY_MS = 86400000;

function toUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Mon..Fri dates ("YYYY-MM-DD") of the week containing dateStr. Sat/Sun belong to the week just ended. */
export function weekDates(dateStr) {
  const t = toUtc(dateStr);
  const sinceMonday = (new Date(t).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = t - sinceMonday * DAY_MS;
  return Array.from({ length: WEEKDAYS }, (_, i) => fromUtc(monday + i * DAY_MS));
}

/** Minutes the room is in class on one date, clipped to [start, end) and with overlaps merged. */
export function busyMinutesOn(room, dateStr, start = WINDOW_START, end = WINDOW_END) {
  const weekday = ((new Date(toUtc(dateStr)).getUTCDay() + 6) % 7) + 1;
  const spans = [];
  for (const iv of room.busy?.[weekday] || []) {
    if (iv[2] && iv[2] > dateStr) continue;
    if (iv[3] && iv[3] < dateStr) continue;
    const a = Math.max(iv[0], start), b = Math.min(iv[1], end);
    if (b > a) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0, curStart = null, curEnd = null;
  for (const [a, b] of spans) {
    if (curEnd !== null && a <= curEnd) {
      curEnd = Math.max(curEnd, b);
    } else {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

/**
 * Every room with its weekly busy minutes for the Mon-Fri week containing dateStr.
 * Returns { dates, availableMinutes, rows } where rows are sorted busiest first (ties by room id).
 * row = { room, busyMinutes, hours, percent }.
 */
export function weeklyUsage(rooms, dateStr, start = WINDOW_START, end = WINDOW_END) {
  const dates = weekDates(dateStr);
  const availableMinutes = dates.length * (end - start);
  const rows = rooms.map((room) => {
    let busyMinutes = 0;
    for (const d of dates) busyMinutes += busyMinutesOn(room, d, start, end);
    return {
      room,
      busyMinutes,
      hours: Math.round(busyMinutes / 6) / 10, // one decimal
      percent: Math.round((1000 * busyMinutes) / availableMinutes) / 10,
    };
  });
  const byId = (a, b) => a.room.id.localeCompare(b.room.id, 'en', { numeric: true });
  rows.sort((a, b) => b.busyMinutes - a.busyMinutes || byId(a, b));
  return { dates, availableMinutes, rows };
}

/** Top-n busiest (most class time) and freest (least class time). Freest is ordered least busy first. */
export function topAndBottom(rows, n = 10) {
  const byId = (a, b) => a.room.id.localeCompare(b.room.id, 'en', { numeric: true });
  const freest = rows.slice().sort((a, b) => a.busyMinutes - b.busyMinutes || byId(a, b)).slice(0, n);
  return { busiest: rows.slice(0, n), freest, idle: rows.filter((r) => r.busyMinutes === 0).length };
}
