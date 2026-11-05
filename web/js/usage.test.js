import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weekDates, busyMinutesOn, weeklyUsage, topAndBottom } from './usage.js';

const room = (id, busy) => ({ id, building: id.split(' ')[0], room: id.split(' ')[1], busy });

test('weekDates gives Mon-Fri of the containing week; weekends belong to the week just ended', () => {
  const want = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  assert.deepEqual(weekDates('2026-11-04'), want); // Wed
  assert.deepEqual(weekDates('2026-11-02'), want); // Mon
  assert.deepEqual(weekDates('2026-11-06'), want); // Fri
  assert.deepEqual(weekDates('2026-11-07'), want); // Sat
  assert.deepEqual(weekDates('2026-11-08'), want); // Sun
  assert.deepEqual(weekDates('2026-11-09')[0], '2026-11-09');
});

test('weekDates crosses month and year boundaries', () => {
  assert.deepEqual(weekDates('2026-12-31'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
});

test('busyMinutesOn merges overlaps and clips to the 08:00-22:00 window', () => {
  const r = room('A 1', { 3: [[420, 540, null, null], [500, 600, null, null], [1300, 1400, null, null], [700, 760, null, null]] });
  // 07:00-09:00 clipped to 08:00-09:00 (60) + 08:20-10:00 merged => 08:00-10:00 (120); 21:40-23:20 clipped to 21:40-22:00 (20); 11:40-12:40 (60)
  assert.equal(busyMinutesOn(r, '2026-11-04'), 120 + 20 + 60);
});

test('busyMinutesOn respects weekday and inclusive date ranges', () => {
  const r = room('A 1', { 3: [[600, 660, '2026-11-04', '2026-11-04']] });
  assert.equal(busyMinutesOn(r, '2026-11-04'), 60); // first and last day inclusive
  assert.equal(busyMinutesOn(r, '2026-11-03'), 0); // Tue
  assert.equal(busyMinutesOn(r, '2026-11-11'), 0); // next Wed, outside range
  assert.equal(busyMinutesOn(room('B 2', {}), '2026-11-04'), 0);
  assert.equal(busyMinutesOn({ id: 'C 3' }, '2026-11-04'), 0);
});

test('weeklyUsage sums the week and sorts busiest first with stable id ties', () => {
  const a = room('A 1', { 1: [[480, 600, null, null]], 5: [[480, 540, null, null]] }); // 120+60
  const b = room('B 2', { 2: [[480, 780, null, null]] }); // 300
  const c = room('C 10', {});
  const d = room('C 9', {});
  const { rows, availableMinutes, dates } = weeklyUsage([c, a, d, b], '2026-11-04');
  assert.equal(availableMinutes, 5 * 840);
  assert.equal(dates.length, 5);
  assert.deepEqual(rows.map((r) => r.room.id), ['B 2', 'A 1', 'C 9', 'C 10']);
  assert.equal(rows[0].hours, 5);
  assert.equal(rows[1].hours, 3);
  assert.equal(rows[0].percent, Math.round((1000 * 300) / 4200) / 10);
});

test('topAndBottom returns n of each and counts idle rooms', () => {
  const rooms = Array.from({ length: 30 }, (_, i) => room(`R ${i}`, i < 25 ? { 1: [[480, 480 + (i + 1) * 10, null, null]] } : {}));
  const { rows } = weeklyUsage(rooms, '2026-11-02');
  const t = topAndBottom(rows, 10);
  assert.equal(t.busiest.length, 10);
  assert.equal(t.freest.length, 10);
  assert.equal(t.idle, 5);
  assert.equal(t.busiest[0].room.id, 'R 24');
  assert.ok(t.freest.slice(0, 5).every((r) => r.busyMinutes === 0));
  assert.ok(t.freest[0].busyMinutes <= t.freest[9].busyMinutes);
});

test('real data for the week of Nov 2, 2026 matches the published ranking', () => {
  const data = JSON.parse(readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));
  const { rows } = weeklyUsage(data.rooms, '2026-11-04');
  assert.equal(rows.length, 358);
  assert.equal(rows[0].room.id, 'E7 4417');
  assert.equal(rows[0].hours, 46.2);
  assert.equal(rows.filter((r) => r.busyMinutes === 0).length, 7);
});
