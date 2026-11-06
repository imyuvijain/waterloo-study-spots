import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanManifest, photosFor, stepIndex } from './photos.js';

const raw = {
  rooms: {
    'STC 1012': {
      front: 'images/rooms/STC-1012/front.jpg', back: 'images/rooms/STC-1012/back.jpg',
      podium: 'images/rooms/STC-1012/podium.jpg', thumb: 'images/rooms/STC-1012/thumb.jpg',
    },
    'MC 2065': { back: 'images/rooms/MC-2065/back.jpg' },
    'AL 105': {},
  },
};

test('cleanManifest keeps rooms with photos, in front/back/podium order, with labels', () => {
  const m = cleanManifest(raw);
  assert.deepEqual([...m.keys()], ['STC 1012', 'MC 2065']);
  assert.deepEqual(m.get('STC 1012').views.map((v) => v.kind), ['front', 'back', 'podium']);
  assert.equal(m.get('STC 1012').views[0].label, 'Front of room');
  assert.equal(m.get('STC 1012').thumb, 'images/rooms/STC-1012/thumb.jpg');
});

test('thumb falls back to the first available photo', () => {
  assert.equal(cleanManifest(raw).get('MC 2065').thumb, 'images/rooms/MC-2065/back.jpg');
});

test('unsafe or odd paths are dropped, never loaded', () => {
  const m = cleanManifest({
    rooms: {
      A: { front: 'https://evil.example/x.jpg' },
      B: { front: '/etc/passwd.jpg' },
      C: { front: 'images/rooms/../../secret.jpg' },
      D: { front: 'javascript:alert(1).jpg' },
      E: { front: 'images/rooms/E/front.png' },
      F: { front: 42 },
      G: { front: 'images/rooms/G/front.jpg', back: 'http://x/y.jpg' },
    },
  });
  assert.deepEqual([...m.keys()], ['G']);
  assert.deepEqual(m.get('G').views.map((v) => v.kind), ['front']);
});

test('bad manifests give an empty map, not an error', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { rooms: null }, { rooms: 'x' }, { rooms: { A: null } }]) {
    assert.equal(cleanManifest(bad).size, 0);
  }
});

test('photosFor looks up by exact room id', () => {
  const m = cleanManifest(raw);
  assert.ok(photosFor(m, 'STC 1012'));
  assert.equal(photosFor(m, 'STC 1013'), null);
  assert.equal(photosFor(null, 'STC 1012'), null);
});

test('stepIndex wraps both ways', () => {
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), 0);
  assert.equal(stepIndex(0, 3, -1), 2);
  assert.equal(stepIndex(0, 0, 1), 0);
});
