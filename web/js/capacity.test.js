import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanSizes, capacityLabel, CAPACITY_NOTE } from './capacity.js';

test('cleanSizes keeps positive whole numbers only', () => {
  const m = cleanSizes({ rooms: { 'MC 2065': 180, A: 0, B: -3, C: 12.5, D: '90', E: null, F: 99999 } });
  assert.deepEqual([...m], [['MC 2065', 180]]);
});

test('bad files give an empty map', () => {
  for (const bad of [null, undefined, 'x', {}, { rooms: null }, { rooms: 'x' }]) assert.equal(cleanSizes(bad).size, 0);
});

test('label always says it is an estimate and never names a course', () => {
  const m = cleanSizes({ rooms: { 'STC 1012': 446 } });
  assert.equal(capacityLabel(m, 'STC 1012'), '~446 seats (est.)');
  assert.equal(capacityLabel(m, 'STC 1013'), null);
  assert.equal(capacityLabel(null, 'STC 1012'), null);
  assert.match(CAPACITY_NOTE, /Estimated/);
  assert.doesNotMatch(CAPACITY_NOTE, /[A-Z]{2,} \d{3}/);
});

test('real data: every site room estimate is sane', () => {
  const m = cleanSizes(JSON.parse(readFileSync(new URL('../data/room_sizes.json', import.meta.url), 'utf8')));
  assert.ok(m.size > 150);
  assert.equal(m.get('STC 1012'), 446);
  for (const n of m.values()) assert.ok(n >= 1 && n < 900);
});
