import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { torontoParts } from './availability.js';
import {
  clock, hoursFor, openStatus, weekRows, tierOf, termMultiplier, estimateBusyness, liveFor,
  resolveBusyness, busynessText, LIVE_MAX_AGE_MS,
} from './libraries.js';

const data = JSON.parse(readFileSync(new URL('../../data/libraries.json', import.meta.url)));
const byId = Object.fromEntries(data.libraries.map((l) => [l.id, l]));
const EST = data.typical_busyness_estimate;
const TERM = { classStart: '2026-09-09', classEnd: '2026-12-08', termEnd: '2026-12-11' };
// Toronto wall-clock helper: EDT (-04:00) until 2026-11-01.
const at = (d, t) => new Date(`${d}T${t}:00-04:00`);
const P = (d, t) => torontoParts(at(d, t));
// 2026-10-29 is a Thursday.

test('clock shows midnight for 24:00', () => {
  assert.equal(clock(1440), 'midnight');
  assert.equal(clock(480), '08:00');
  assert.equal(clock(0), '00:00');
});

test('hoursFor parses 24:00 and overnight closes', () => {
  assert.deepEqual(hoursFor(byId.dc, 4), [480, 1440]);
  const night = { weekly_hours: { mon: ['18:00', '02:00'] } };
  assert.deepEqual(hoursFor(night, 1), [1080, 1560]);
  assert.equal(hoursFor(night, 2), null);
  assert.equal(hoursFor(byId.cgr, 1), null);
});

test('open / closed from weekly_hours at a Toronto time', () => {
  assert.deepEqual(openStatus(byId.dp, P('2026-10-29', '14:20')), { state: 'open', closesAt: 1260, text: 'Open until 21:00' });
  assert.equal(openStatus(byId.dp, P('2026-10-29', '21:00')).state, 'closed'); // close is exclusive
  assert.equal(openStatus(byId.dp, P('2026-10-29', '07:59')).text, 'Closed, opens today 08:00');
  assert.equal(openStatus(byId.dp, P('2026-10-29', '22:00')).text, 'Closed, opens tomorrow 08:00');
  // Saturday opens at 11:00
  assert.equal(openStatus(byId.dp, P('2026-10-31', '09:00')).text, 'Closed, opens today 11:00');
  assert.equal(openStatus(byId.dp, P('2026-10-30', '21:30')).text, 'Closed, opens tomorrow 11:00');
  // Davis closes at midnight
  assert.equal(openStatus(byId.dc, P('2026-10-29', '23:30')).text, 'Open until midnight');
});

test('uses Toronto time, not the machine zone (UTC instant 02:00Z Fri = 22:00 Thu EDT)', () => {
  const p = torontoParts(new Date('2026-10-30T02:00:00Z'));
  assert.equal(p.weekday, 4);
  assert.equal(openStatus(byId.dp, p).state, 'closed');
  assert.equal(openStatus(byId.dc, p).state, 'open');
});

test('overnight hours: yesterday late-night spill counts as open', () => {
  const night = { weekly_hours: { mon: ['18:00', '02:00'], tue: null } };
  assert.equal(openStatus(night, { weekday: 2, minutes: 60, dateStr: '2026-10-27' }).state, 'open');
  assert.equal(openStatus(night, { weekday: 2, minutes: 150, dateStr: '2026-10-27' }).state, 'closed');
});

test('null weekly_hours is unknown, never open or closed', () => {
  for (const id of ['cgr', 'ren', 'sju']) {
    const s = openStatus(byId[id], P('2026-10-29', '12:00'));
    assert.equal(s.state, 'unknown');
    assert.match(s.text, /unverified/i);
    assert.equal(estimateBusyness(EST, byId[id], P('2026-10-29', '12:00'), TERM), null);
  }
  assert.deepEqual(weekRows(byId.cgr), []);
  assert.equal(weekRows(byId.dp).length, 7);
});

test('tierOf thresholds', () => {
  assert.equal(tierOf(0.34), 'quiet');
  assert.equal(tierOf(0.35), 'moderate');
  assert.equal(tierOf(0.69), 'moderate');
  assert.equal(tierOf(0.7), 'busy');
});

test('termMultiplier: weeks, exam, break', () => {
  const w = EST.term_week_multiplier.weeks;
  assert.equal(termMultiplier(w, '2026-10-29', TERM).week, 8); // matches the calibration note
  assert.equal(termMultiplier(w, '2026-10-29', TERM).mult, 0.95);
  assert.equal(termMultiplier(w, '2026-09-09', TERM).week, 1);
  assert.equal(termMultiplier(w, '2026-09-06', TERM).key, 'break_or_between_terms');
  assert.equal(termMultiplier(w, '2026-12-10', TERM).key, 'exam');
  assert.equal(termMultiplier(w, '2026-12-20', TERM).key, 'break_or_between_terms');
  assert.equal(termMultiplier(w, '2026-10-29', null).mult, 1);
});

test('estimate = hour curve x term multiplier, only while open', () => {
  const e = estimateBusyness(EST, byId.dp, P('2026-10-29', '14:20'), TERM); // thu 14h 0.9 * 0.95
  assert.ok(Math.abs(e.value - 0.855) < 1e-9);
  assert.equal(e.tier, 'busy');
  assert.equal(estimateBusyness(EST, byId.dp, P('2026-10-29', '22:00'), TERM), null);
  const cap = estimateBusyness(EST, byId.dp, P('2026-12-10', '15:00'), TERM); // exam 1.15 capped
  assert.ok(cap.value <= 1);
});

const feedOf = (entries, at = Date.now()) => ({ at, byId: new Map(entries.map((e) => [e.id, e])) });
const liveItem = (id, pct, extra = {}) => ({ id, pct, people: 10, capacity: 100, isOpen: true, zones: [], ...extra });

test('live is used only for "Now" with a fresh feed', () => {
  const now = Date.now();
  const feed = feedOf([liveItem(215, 68)], now);
  const parts = P('2026-10-29', '14:20');
  const live = resolveBusyness({ lib: byId.dp, est: EST, parts, isNow: true, feed, now, term: TERM });
  assert.equal(live.kind, 'live');
  assert.equal(busynessText(live), 'Live: 68% busy (Waitz)');
  // Not "Now" -> estimate even though a fresh feed exists
  const later = resolveBusyness({ lib: byId.dp, est: EST, parts, isNow: false, feed, now, term: TERM });
  assert.equal(later.kind, 'estimate');
  assert.equal(later.reason, 'not-now');
  assert.match(busynessText(later), /^Estimate, not live: typically /);
});

test('any feed problem falls back to a labelled estimate', () => {
  const now = Date.now();
  const parts = P('2026-10-29', '14:20');
  const run = (feed, feedStatus) => resolveBusyness({ lib: byId.dc, est: EST, parts, isNow: true, feed, feedStatus, now, term: TERM });
  for (const [feed, status, reason] of [
    [null, 'error', 'feed-unavailable'],
    [null, 'loading', 'loading'],
    [feedOf([], now), 'ok', 'feed-unavailable'],                       // library missing from feed
    [feedOf([liveItem(216, 50)], now - LIVE_MAX_AGE_MS - 1), 'ok', 'feed-unavailable'], // stale
    [feedOf([liveItem(216, 50, { isOpen: false })], now), 'ok', 'waitz-closed'],
  ]) {
    const r = run(feed, status);
    assert.equal(r.kind, 'estimate', reason);
    assert.equal(r.reason, reason);
    assert.match(busynessText(r), /^Estimate, not live/);
  }
});

test('libraries without a sensor never show live', () => {
  const now = Date.now();
  const feed = feedOf([liveItem(215, 68)], now);
  assert.equal(liveFor(byId.cgr, feed, now), null);
  const r = resolveBusyness({ lib: byId.cgr, est: EST, parts: P('2026-10-29', '12:00'), isNow: true, feed, now, term: TERM });
  assert.equal(r.kind, 'none');
  assert.equal(r.reason, 'hours-unknown');
});

test('closed library with no live reading has no estimate', () => {
  const r = resolveBusyness({ lib: byId.dp, est: EST, parts: P('2026-10-29', '23:00'), isNow: true, feed: null, feedStatus: 'error', term: TERM });
  assert.deepEqual([r.kind, r.reason], ['none', 'closed']);
});
