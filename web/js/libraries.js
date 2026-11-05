// Pure logic for the Libraries layer: opening hours, busyness estimate, and choosing between a live
// reading and the estimate. No DOM, no network; runs in node and browsers.
//
// Data shape: data/libraries.json (copied to web/data/libraries.json by scripts/build_layer_data.py).
// Weekly hours: { mon: ["08:00","21:00"], ... } keyed sun..sat, "24:00" = midnight, or null = unverified.
// Weekdays here follow availability.js: 1=Mon .. 7=Sun. `parts` is the result of torontoParts().

import { parseHHMM, formatMinutes } from './availability.js';

const DAY_KEYS = [null, 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SHORT = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Clock text for minutes since midnight; 1440 reads as "midnight". */
export function clock(min) {
  const m = min % 1440;
  if (min === 1440 || (min > 0 && m === 0)) return 'midnight';
  return formatMinutes(m);
}

// [openMin, closeMin] for a weekday, or null if closed that day / not listed. A close at or before the
// open means the library closes after midnight, so close is moved to the next day (e.g. 18:00-02:00).
export function hoursFor(lib, weekday) {
  const pair = lib?.weekly_hours?.[DAY_KEYS[weekday]];
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const open = parseHHMM(pair[0]);
  let close = parseHHMM(pair[1]);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
  if (close <= open) close = close === 0 && open > 0 ? 1440 : close + 1440;
  return [open, close];
}

/**
 * Open/closed at a Toronto wall-clock time.
 * Returns {state: 'open'|'closed'|'unknown', text, closesAt?, opensAt?}.
 * 'unknown' means weekly_hours is null: we have no verified hours, so we do not guess.
 */
export function openStatus(lib, parts) {
  if (!lib?.weekly_hours) return { state: 'unknown', text: 'Hours unverified' };

  const today = hoursFor(lib, parts.weekday);
  if (today && today[0] <= parts.minutes && parts.minutes < today[1]) {
    return { state: 'open', closesAt: today[1], text: `Open until ${clock(today[1])}` };
  }
  // Late-night spill from yesterday's hours (close past midnight).
  const yWeekday = parts.weekday === 1 ? 7 : parts.weekday - 1;
  const yest = hoursFor(lib, yWeekday);
  if (yest && yest[1] > 1440 && parts.minutes < yest[1] - 1440) {
    return { state: 'open', closesAt: yest[1] - 1440, text: `Open until ${clock(yest[1] - 1440)}` };
  }

  if (today && parts.minutes < today[0]) {
    return { state: 'closed', opensAt: today[0], text: `Closed, opens today ${clock(today[0])}` };
  }
  for (let d = 1; d <= 7; d++) {
    const wd = ((parts.weekday - 1 + d) % 7) + 1;
    const h = hoursFor(lib, wd);
    if (h) {
      const when = d === 1 ? 'tomorrow' : DAY_SHORT[wd];
      return { state: 'closed', opensAt: h[0], text: `Closed, opens ${when} ${clock(h[0])}` };
    }
  }
  return { state: 'closed', text: 'Closed' };
}

/** Hours for each weekday as display rows, Mon..Sun. */
export function weekRows(lib) {
  if (!lib?.weekly_hours) return [];
  const rows = [];
  for (let wd = 1; wd <= 7; wd++) {
    const h = hoursFor(lib, wd);
    rows.push({ weekday: wd, day: DAY_SHORT[wd], text: h ? `${clock(h[0])} to ${clock(h[1])}` : 'Closed' });
  }
  return rows;
}

/* ---------- busyness tiers ---------- */

/** value 0..1 -> 'quiet' (<0.35) | 'moderate' (<0.7) | 'busy'. */
export function tierOf(value) {
  if (value < 0.35) return 'quiet';
  if (value < 0.7) return 'moderate';
  return 'busy';
}

export const TIER_WORD = { quiet: 'quiet', moderate: 'moderately busy', busy: 'busy' };

/* ---------- estimate ---------- */

const dayNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/**
 * Term-week multiplier from libraries.json (typical_busyness_estimate.term_week_multiplier.weeks).
 * term = { classStart, classEnd, termEnd } as "YYYY-MM-DD". Week 1 is the Monday-to-Sunday week that
 * contains classStart. After classEnd up to termEnd counts as the exam period; any other date outside
 * classes is "break_or_between_terms". Without term info the multiplier is 1.
 */
export function termMultiplier(weeks, dateStr, term) {
  if (!weeks) return { key: 'unknown', mult: 1 };
  if (!term?.classStart) return { key: 'unknown', mult: 1 };
  const get = (k) => (Number.isFinite(weeks[k]) ? weeks[k] : 1);
  if (dateStr < term.classStart) return { key: 'break_or_between_terms', mult: get('break_or_between_terms') };
  if (!term.classEnd || dateStr <= term.classEnd) {
    const startDn = dayNum(term.classStart);
    const startMon = startDn - ((new Date(startDn * 86400000).getUTCDay() + 6) % 7);
    const week = Math.min(13, Math.floor((dayNum(dateStr) - startMon) / 7) + 1);
    return { key: String(week), mult: get(String(week)), week };
  }
  if (term.termEnd && dateStr <= term.termEnd) return { key: 'exam', mult: get('exam') };
  return { key: 'break_or_between_terms', mult: get('break_or_between_terms') };
}

/**
 * Hand-built typical busyness for a library at a Toronto time, or null if it cannot be estimated
 * (unverified hours, or closed at that time). Returns {value: 0..1, tier}.
 * `est` is libraries.json's typical_busyness_estimate.
 */
export function estimateBusyness(est, lib, parts, term) {
  if (!est?.hour_by_weekday) return null;
  const status = openStatus(lib, parts);
  if (status.state !== 'open') return null;
  const curve = est.hour_by_weekday[DAY_KEYS[parts.weekday]];
  if (!Array.isArray(curve)) return null;
  const base = curve[Math.floor(parts.minutes / 60)];
  if (!Number.isFinite(base)) return null;
  const { mult } = termMultiplier(est.term_week_multiplier?.weeks, parts.dateStr, term);
  const value = Math.min(1, Math.max(0, base * mult));
  return { value, tier: tierOf(value) };
}

/* ---------- live vs estimate ---------- */

export const LIVE_MAX_AGE_MS = 5 * 60 * 1000; // older than this and we stop calling it "live"

/** The live reading for a library from a parsed feed, or null if there is no usable fresh one. */
export function liveFor(lib, feed, now = Date.now(), maxAgeMs = LIVE_MAX_AGE_MS) {
  const id = lib?.live_occupancy?.waitz_location_id;
  if (id == null || !feed?.byId) return null;
  if (!Number.isFinite(feed.at) || now - feed.at > maxAgeMs || feed.at - now > 60000) return null;
  return feed.byId.get(id) || null;
}

/**
 * Decide what to show for busyness.
 *   { kind: 'live', pct, tier, people, capacity, zones, at }
 *   { kind: 'estimate', value, tier, reason }   reason: not-now | loading | feed-unavailable | waitz-closed | no-live-source
 *   { kind: 'none', reason }                    reason: hours-unknown | closed
 * A live value is used only when `isNow` is true and the feed is fresh and says the library is open.
 * Anything else falls back to the estimate, which is always returned as kind 'estimate' (never 'live').
 */
export function resolveBusyness({ lib, est, parts, isNow, feed, feedStatus = 'idle', now = Date.now(), term }) {
  const hasSource = !!lib?.live_occupancy;
  let reason = 'no-live-source';
  if (hasSource) {
    if (!isNow) {
      reason = 'not-now';
    } else {
      const live = liveFor(lib, feed, now);
      if (live && live.isOpen) {
        return {
          kind: 'live', pct: live.pct, tier: tierOf(live.pct / 100), people: live.people,
          capacity: live.capacity, zones: live.zones, at: feed.at,
        };
      }
      if (live && !live.isOpen) reason = 'waitz-closed';
      else reason = feedStatus === 'loading' || feedStatus === 'idle' ? 'loading' : 'feed-unavailable';
    }
  }
  const status = openStatus(lib, parts);
  if (status.state === 'unknown') return { kind: 'none', reason: 'hours-unknown' };
  const e = estimateBusyness(est, lib, parts, term);
  if (!e) return { kind: 'none', reason: 'closed' };
  return { kind: 'estimate', value: e.value, tier: e.tier, reason };
}

/** Plain-language lines. Estimates always carry the words "Estimate, not live". */
export function busynessText(b) {
  if (b.kind === 'live') return `Live: ${Math.round(b.pct)}% busy (Waitz)`;
  if (b.kind === 'estimate') return `Estimate, not live: typically ${TIER_WORD[b.tier]}`;
  if (b.reason === 'hours-unknown') return 'Busyness unavailable: hours unverified';
  return 'Closed: no busyness estimate';
}

export const REASON_TEXT = {
  'not-now': 'Live numbers are only shown for the current time.',
  loading: 'Live data is loading, so this is the estimate for now.',
  'feed-unavailable': 'The live feed from Waitz is unavailable right now.',
  'waitz-closed': 'Waitz reports this library as closed, so there is no live reading.',
  'no-live-source': 'This library has no live occupancy sensor.',
};
