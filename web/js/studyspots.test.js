import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TAG_FILTERS, cleanSpots, filterSpots, tagCounts, groupByBuilding, displayTag, sourceHost, spotMatches,
} from './studyspots.js';

const spots = cleanSpots(JSON.parse(readFileSync(new URL('../../data/study_spots.json', import.meta.url))));

test('all 44 real spots are well formed', () => {
  assert.equal(spots.length, 44);
  assert.equal(new Set(spots.map((s) => s.id)).size, 44);
  for (const s of spots) assert.ok(['official', 'anecdotal'].includes(s.confidence), s.id);
});

test('cleanSpots drops malformed entries', () => {
  assert.equal(cleanSpots([{ id: 'a', name: 'A', building: 'X', lat: 1, lng: 2 }, { id: 'b' }, null, { id: 'c', name: 'C', building: 'X', lat: NaN, lng: 1 }]).length, 1);
  assert.deepEqual(cleanSpots('x'), []);
});

test('filters narrow with AND; quiet includes silent', () => {
  const quiet = filterSpots(spots, new Set(['quiet']));
  assert.ok(quiet.some((s) => s.tags.includes('silent')));
  assert.ok(quiet.every((s) => s.tags.includes('quiet') || s.tags.includes('silent')));
  const both = filterSpots(spots, new Set(['quiet', 'bookable']));
  assert.ok(both.length > 0 && both.length < quiet.length);
  assert.ok(both.every((s) => spotMatches(s, new Set(['quiet', 'bookable']))));
  assert.equal(filterSpots(spots, new Set()).length, 44);
  assert.equal(filterSpots(spots, new Set(['outlets'])).length, 1);
});

test('tagCounts covers every chip', () => {
  const c = tagCounts(spots);
  for (const f of TAG_FILTERS) assert.ok(c[f.key] >= 1, f.key);
  assert.equal(c['24h'], 4);
});

test('spots in one building group together', () => {
  const g = groupByBuilding(spots);
  assert.equal(g.get('LIB').length, 7);
  assert.equal(g.get('DC').length, 7);
  assert.equal(g.size, 20);
});

test('display helpers', () => {
  assert.equal(displayTag('24h access'), '24 h access');
  assert.equal(displayTag('food nearby'), 'Food nearby');
  assert.equal(sourceHost('https://www.sju.ca/studyrooms'), 'sju.ca');
  assert.equal(sourceHost('nonsense'), '');
});
