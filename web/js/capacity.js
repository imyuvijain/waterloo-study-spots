// Estimated room capacity, from web/data/room_sizes.json (scripts/build_room_sizes.py).
// The number is the largest class timetabled in the room this term, a lower bound on seats, so the UI
// always labels it as an estimate. Pure ES module (no DOM).

export const CAPACITY_NOTE =
  'Estimated from the largest class scheduled in this room this term. Official seat counts are not published.';

/** Map of room id -> positive whole number; anything else in the file is ignored. */
export function cleanSizes(raw) {
  const out = new Map();
  const rooms = raw && typeof raw === 'object' ? raw.rooms : null;
  if (!rooms || typeof rooms !== 'object') return out;
  for (const [id, n] of Object.entries(rooms)) {
    if (Number.isInteger(n) && n > 0 && n < 5000) out.set(id, n);
  }
  return out;
}

/** "~120 seats (est.)" or null when there is no estimate for the room. */
export function capacityLabel(sizes, roomId) {
  const n = sizes?.get(roomId);
  return n ? `~${n} seats (est.)` : null;
}
