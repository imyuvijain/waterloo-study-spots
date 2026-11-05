import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  torontoParts, isFree, busyNow, freeUntil, freeForMinutes, nextBusy,
  roomsFreeAt, buildingSummary, summarizeByBuilding, parseHHMM, formatMinutes,
} from './availability.js';

const m = (hhmm) => parseHHMM(hhmm);
// Build a Date from Toronto wall-clock "YYYY-MM-DD HH:MM" using an explicit offset
// (EDT = -04:00 until 2026-11-01, EST = -05:00 after).
const edt = (d, t) => new Date(`${d}T${t}:00-04:00`);
const est = (d, t) => new Date(`${d}T${t}:00-05:00`);

// 2026-10-27 is a Tuesday (weekday 2). 2026-10-26 Mon, 10-31 Sat, 11-01 Sun.
const SD = '2026-09-08', ED = '2026-12-11';
const iv = (s, e, sd = SD, ed = ED, label = 'X 100 LEC 001') => [m(s), m(e), sd, ed, label];

const room = (busy, id = 'MC 2065') => ({ id, building: id.split(' ')[0], room: id.split(' ')[1], busy });

test('parseHHMM / formatMinutes', () => {
  assert.equal(m('00:00'), 0);
  assert.equal(m('10:20'), 620);
  assert.equal(m('23:59'), 1439);
  assert.equal(formatMinutes(620), '10:20');
  assert.equal(formatMinutes(0), '00:00');
});

test('torontoParts reads wall-clock in America/Toronto', () => {
  const p = torontoParts(new Date('2026-10-27T14:30:00Z')); // 10:30 EDT
  assert.deepEqual(p, { dateStr: '2026-10-27', weekday: 2, minutes: 630 });
});

test('torontoParts is independent of machine zone: UTC next day is still previous Toronto day', () => {
  // 2026-11-02T04:59Z is 23:59 EST on Sunday 2026-11-01
  const p = torontoParts(new Date('2026-11-02T04:59:00Z'));
  assert.deepEqual(p, { dateStr: '2026-11-01', weekday: 7, minutes: 23 * 60 + 59 });
});

test('torontoParts handles DST change (fall back 2026-11-01)', () => {
  assert.equal(torontoParts(new Date('2026-11-01T05:30:00Z')).minutes, 90); // 01:30 EDT
  assert.equal(torontoParts(new Date('2026-11-01T11:00:00Z')).minutes, 6 * 60); // 06:00 EST
  // midnight must be 0, not 24
  assert.equal(torontoParts(new Date('2026-10-27T04:00:00Z')).minutes, 0);
});

test('weekday numbering 1=Mon..7=Sun', () => {
  assert.equal(torontoParts(edt('2026-10-26', '12:00')).weekday, 1);
  assert.equal(torontoParts(edt('2026-10-31', '12:00')).weekday, 6);
  assert.equal(torontoParts(edt('2026-10-27', '12:00')).weekday, 2);
});

test('start inclusive, end exclusive', () => {
  const r = room({ 2: [iv('10:30', '11:20')] });
  assert.equal(isFree(r, edt('2026-10-27', '10:29')), true);
  assert.equal(isFree(r, edt('2026-10-27', '10:30')), false); // start inclusive
  assert.equal(isFree(r, edt('2026-10-27', '11:19')), false);
  assert.equal(isFree(r, edt('2026-10-27', '11:20')), true); // end exclusive
});

test('class ending at 10:20 does not block a 10:20 query', () => {
  const r = room({ 2: [iv('09:00', '10:20')] });
  assert.equal(isFree(r, edt('2026-10-27', '10:20')), true);
  assert.equal(busyNow(r, edt('2026-10-27', '10:20')), null);
  assert.equal(isFree(r, edt('2026-10-27', '10:19')), false);
});

test('seconds within the minute do not shift boundaries', () => {
  const r = room({ 2: [iv('09:00', '10:20')] });
  assert.equal(isFree(r, new Date(edt('2026-10-27', '10:19').getTime() + 59000)), false);
});

test('respects weekday', () => {
  const r = room({ 2: [iv('10:30', '11:20')] }); // Tuesday only
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), false); // Tue
  assert.equal(isFree(r, edt('2026-10-28', '10:45')), true); // Wed
  assert.equal(isFree(r, edt('2026-10-26', '10:45')), true); // Mon
});

test('weekends are free when no weekend busy entries (including missing keys)', () => {
  const r = room({ 1: [iv('08:30', '17:20')], 2: [iv('08:30', '17:20')] });
  assert.equal(isFree(r, edt('2026-10-31', '12:00')), true); // Sat
  assert.equal(isFree(r, edt('2026-11-01', '12:00')), true); // Sun (EDT until 2am)
  assert.equal(freeUntil(r, edt('2026-10-31', '12:00')), null);
  assert.equal(isFree(room({}), edt('2026-10-27', '12:00')), true);
});

test('weekend class on key 6/7 blocks', () => {
  const r = room({ 6: [iv('10:00', '12:00')] });
  assert.equal(isFree(r, edt('2026-10-31', '11:00')), false);
  assert.equal(isFree(r, edt('2026-10-24', '11:00')), false);
});

test('date range edges are inclusive of both start_date and end_date', () => {
  const r = room({ 2: [iv('10:30', '11:20', '2026-10-13', '2026-10-27')] });
  assert.equal(isFree(r, edt('2026-10-06', '10:45')), true); // before range
  assert.equal(isFree(r, edt('2026-10-13', '10:45')), false); // first day
  assert.equal(isFree(r, edt('2026-10-20', '10:45')), false);
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), false); // last day
  assert.equal(isFree(r, edt('2026-11-03', '10:45')), true); // after range
});

test('a class that ended before the date does not block', () => {
  const r = room({ 2: [iv('10:30', '11:20', '2026-09-08', '2026-10-20')] });
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), true);
  assert.equal(freeUntil(r, edt('2026-10-27', '08:00')), null);
});

test('a class starting after the date does not block nor appear in freeUntil', () => {
  const r = room({ 2: [iv('10:30', '11:20', '2026-11-03', '2026-12-01')] });
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), true);
  assert.equal(freeUntil(r, edt('2026-10-27', '08:00')), null);
});

test('date range uses Toronto date, not UTC date', () => {
  // Sunday-night class ending Nov 1; query 23:30 EST Nov 1 = Nov 2 04:30Z
  const r = room({ 7: [iv('23:00', '23:59', '2026-11-01', '2026-11-01')] });
  assert.equal(isFree(r, new Date('2026-11-02T04:30:00Z')), false);
});

test('null/missing dates mean unbounded', () => {
  const r = room({ 2: [[m('10:30'), m('11:20'), null, null, 'A']] });
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), false);
  assert.equal(isFree(r, est('2027-03-02', '10:45')), false);
  const r2 = room({ 2: [[m('10:30'), m('11:20')]] });
  assert.equal(isFree(r2, edt('2026-10-27', '10:45')), false);
});

test('busyNow returns the blocking class details', () => {
  const r = room({ 2: [iv('10:30', '11:20', SD, ED, 'CS 135 LEC 001')] });
  const b = busyNow(r, edt('2026-10-27', '11:00'));
  assert.equal(b.label, 'CS 135 LEC 001');
  assert.equal(b.start, m('10:30'));
  assert.equal(b.end, m('11:20'));
  assert.equal(b.startDate, SD);
  assert.equal(b.endDate, ED);
});

test('overlapping meetings: busy while any covers; busyNow picks the one ending latest', () => {
  const r = room({ 2: [iv('10:30', '11:20', SD, ED, 'A'), iv('11:00', '12:20', SD, ED, 'B')] });
  assert.equal(isFree(r, edt('2026-10-27', '11:10')), false);
  assert.equal(isFree(r, edt('2026-10-27', '11:20')), false); // B still running
  assert.equal(isFree(r, edt('2026-10-27', '12:20')), true);
  assert.equal(busyNow(r, edt('2026-10-27', '11:10')).label, 'B');
});

test('overlap with differing date ranges: only the in-range one blocks', () => {
  const r = room({ 2: [iv('10:30', '12:20', '2026-09-08', '2026-10-20', 'old'), iv('11:00', '11:50', '2026-10-27', '2026-12-01', 'new')] });
  assert.equal(isFree(r, edt('2026-10-27', '10:45')), true);
  assert.equal(busyNow(r, edt('2026-10-27', '11:10')).label, 'new');
});

test('freeUntil: free now -> Date of next class start', () => {
  const r = room({ 2: [iv('10:30', '11:20'), iv('14:30', '15:20')] });
  const q = edt('2026-10-27', '09:00');
  assert.equal(freeUntil(r, q).getTime(), edt('2026-10-27', '10:30').getTime());
  assert.equal(freeForMinutes(r, q), 90);
});

test('freeUntil across a gap: free in the gap, until the next class', () => {
  const r = room({ 2: [iv('10:30', '11:20'), iv('14:30', '15:20')] });
  const q = edt('2026-10-27', '11:20'); // exactly at end of first -> free
  assert.equal(freeForMinutes(r, q), 190);
  assert.equal(freeUntil(r, q).getTime(), edt('2026-10-27', '14:30').getTime());
});

test('freeUntil: after the last class of the day -> null', () => {
  const r = room({ 2: [iv('10:30', '11:20')] });
  assert.equal(freeUntil(r, edt('2026-10-27', '11:20')), null);
  assert.equal(freeForMinutes(r, edt('2026-10-27', '11:20')), null);
});

test('freeUntil back-to-back classes: busy now -> zero free minutes', () => {
  const r = room({ 2: [iv('10:30', '11:20'), iv('11:20', '12:20')] });
  assert.equal(isFree(r, edt('2026-10-27', '11:20')), false); // second class starts
  assert.equal(freeForMinutes(r, edt('2026-10-27', '11:00')), 0);
  assert.equal(freeUntil(r, edt('2026-10-27', '11:00')).getTime(), edt('2026-10-27', '11:00').getTime());
});

test('freeUntil ignores classes on other weekdays and unsorted input', () => {
  const r = room({ 2: [iv('15:30', '16:20'), iv('12:30', '13:20')], 3: [iv('08:30', '09:20')] });
  assert.equal(freeForMinutes(r, edt('2026-10-27', '08:00')), 270); // to 12:30
});

test('freeUntil works in EST after fall-back (Toronto wall clock)', () => {
  const r = room({ 2: [iv('10:30', '11:20')] }); // Tue 2026-11-03
  assert.equal(freeForMinutes(r, est('2026-11-03', '09:00')), 90);
  assert.equal(freeUntil(r, est('2026-11-03', '09:00')).getTime(), est('2026-11-03', '10:30').getTime());
});

test('nextBusy returns next interval strictly after now, null if none', () => {
  const r = room({ 2: [iv('10:30', '11:20', SD, ED, 'A'), iv('14:30', '15:20', SD, ED, 'B')] });
  assert.equal(nextBusy(r, edt('2026-10-27', '09:00')).label, 'A');
  assert.equal(nextBusy(r, edt('2026-10-27', '10:45')).label, 'B'); // A running; next is B
  assert.equal(nextBusy(r, edt('2026-10-27', '15:00')), null);
});

test('roomsFreeAt filters, and buildingSummary counts', () => {
  const a = room({ 2: [iv('10:30', '11:20')] }, 'MC 2065');
  const b = room({}, 'MC 2066');
  const c = room({ 2: [iv('10:00', '12:00')] }, 'DC 1350');
  const rooms = [a, b, c];
  const q = edt('2026-10-27', '10:45');
  assert.deepEqual(roomsFreeAt(rooms, q).map((r) => r.id), ['MC 2066']);
  assert.deepEqual(buildingSummary([a, b], q), { free: 1, total: 2 });
  assert.deepEqual(buildingSummary([], q), { free: 0, total: 0 });
  assert.deepEqual(summarizeByBuilding(rooms, q), { MC: { free: 1, total: 2 }, DC: { free: 0, total: 1 } });
});

test('tolerates invalid room/date input', () => {
  assert.throws(() => isFree(room({}), new Date('nope')), /invalid date/i);
  assert.equal(isFree({ id: 'X 1' }, edt('2026-10-27', '10:45')), true); // no busy field
});
