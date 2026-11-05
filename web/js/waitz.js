// Waitz live occupancy feed (https://waitz.io/live/waterloo). Public, CORS-enabled, undocumented and
// not run by the University: everything here is defensive. Any problem -> throw, and the caller falls
// back to the estimate. No DOM; fetch is injectable so this runs under node:test.

export const WAITZ_URL = 'https://waitz.io/live/waterloo';
export const POLL_MS = 2 * 60 * 1000; // never poll more often than this
export const TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseZone(z) {
  const pct = num(z?.busyness);
  if (!z || num(z.id) === null || pct === null) return null;
  return {
    id: z.id,
    name: typeof z.name === 'string' ? z.name : `Zone ${z.id}`,
    pct: Math.min(100, Math.max(0, pct)),
    people: num(z.people),
    capacity: num(z.capacity),
    isOpen: z.isOpen !== false,
  };
}

/** Waitz JSON -> Map(locationId -> {id, name, pct 0..100, people, capacity, isOpen, zones[]}). Bad items are skipped. */
export function parseWaitz(json) {
  const out = new Map();
  if (!json || !Array.isArray(json.data)) return out;
  for (const item of json.data) {
    const pct = num(item?.busyness);
    if (!item || num(item.id) === null || pct === null) continue;
    out.set(item.id, {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : `Location ${item.id}`,
      pct: Math.min(100, Math.max(0, pct)),
      people: num(item.people),
      capacity: num(item.capacity),
      isOpen: item.isOpen !== false,
      zones: Array.isArray(item.subLocs) ? item.subLocs.map(parseZone).filter(Boolean) : [],
    });
  }
  return out;
}

/** Fetch and parse the feed. Rejects on network error, timeout, HTTP error, bad JSON or no usable data. */
export async function fetchWaitz({ fetchFn = globalThis.fetch, url = WAITZ_URL, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`Waitz HTTP ${res.status}`);
    const byId = parseWaitz(await res.json());
    if (!byId.size) throw new Error('Waitz returned no usable locations');
    return { at: now(), byId };
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('Waitz request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Milliseconds to wait before the next request. Never less than POLL_MS after the previous attempt
 * (success or failure); after 3 failures in a row it backs off to double that, then more, up to 10 min.
 */
export function nextPollDelay({ lastAttemptAt, fails = 0, now }) {
  const interval = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.max(0, fails - 2));
  if (lastAttemptAt == null) return 0;
  return Math.max(0, lastAttemptAt + interval - now);
}
