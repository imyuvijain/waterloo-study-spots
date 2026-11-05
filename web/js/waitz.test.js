import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaitz, fetchWaitz, nextPollDelay, POLL_MS } from './waitz.js';

const sample = {
  data: [
    { id: 215, name: 'Dana Porter Library', busyness: 70, people: 671, capacity: 959, isOpen: true,
      subLocs: [{ id: 656, name: 'Floor 10 - Group Study', busyness: 74, people: 125, capacity: 170, isOpen: true }, { id: 'bad' }] },
    { id: 217, name: 'Musagetes', busyness: 140, isOpen: false },
    { id: 999, busyness: 'x' },
    null,
  ],
};

test('parseWaitz keeps valid items, clamps, drops junk', () => {
  const m = parseWaitz(sample);
  assert.deepEqual([...m.keys()], [215, 217]);
  assert.equal(m.get(215).pct, 70);
  assert.equal(m.get(215).zones.length, 1);
  assert.equal(m.get(215).zones[0].name, 'Floor 10 - Group Study');
  assert.equal(m.get(217).pct, 100);
  assert.equal(m.get(217).isOpen, false);
  assert.equal(parseWaitz({}).size, 0);
  assert.equal(parseWaitz(null).size, 0);
  assert.equal(parseWaitz({ data: 'nope' }).size, 0);
});

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('fetchWaitz returns parsed feed with a timestamp', async () => {
  const r = await fetchWaitz({ fetchFn: ok(sample), now: () => 123 });
  assert.equal(r.at, 123);
  assert.equal(r.byId.get(215).people, 671);
});

test('fetchWaitz rejects on HTTP error, bad JSON, empty data, network error', async () => {
  await assert.rejects(fetchWaitz({ fetchFn: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(fetchWaitz({ fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }) }));
  await assert.rejects(fetchWaitz({ fetchFn: ok({ data: [] }) }), /no usable/);
  await assert.rejects(fetchWaitz({ fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), /Failed to fetch/);
});

test('fetchWaitz times out', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(fetchWaitz({ fetchFn: hang, timeoutMs: 20 }), /timed out/);
});

test('nextPollDelay: 2 minute floor, backs off after repeated failures', () => {
  assert.equal(nextPollDelay({ lastAttemptAt: null, now: 1000 }), 0);
  assert.equal(nextPollDelay({ lastAttemptAt: 1000, now: 1000 }), POLL_MS);
  assert.equal(nextPollDelay({ lastAttemptAt: 1000, now: 1000 + POLL_MS + 5 }), 0);
  assert.equal(nextPollDelay({ lastAttemptAt: 0, fails: 2, now: 0 }), POLL_MS);
  assert.equal(nextPollDelay({ lastAttemptAt: 0, fails: 3, now: 0 }), 2 * POLL_MS);
  assert.equal(nextPollDelay({ lastAttemptAt: 0, fails: 30, now: 0 }), 10 * 60 * 1000);
});
