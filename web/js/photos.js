// Classroom photos: parse the manifest written by scripts/scrape_room_photos.py and look photos up by room id.
// Pure ES module (no DOM). Manifest shape:
//   { source, rooms: { "STC 1012": { front, back, thumb }, ... }, buildings: { STC: "Science Teaching Complex" } }
// Paths are relative to the site root. Anything that is not a plain relative path is dropped, so a bad
// manifest can never make the page load an image from somewhere else.

export const KIND_ORDER = ['front', 'back'];
export const KIND_LABELS = { front: 'Front of room', back: 'Back of room' };

const SAFE_PATH = /^images\/rooms\/[A-Za-z0-9._\-/]+\.jpe?g$/i;

function safe(path) {
  return typeof path === 'string' && SAFE_PATH.test(path) && !path.includes('..') ? path : null;
}

/** Map of room id -> { views: [{kind, label, src}], thumb } for rooms that have at least one valid photo. */
export function cleanManifest(raw) {
  const out = new Map();
  const rooms = raw && typeof raw === 'object' ? raw.rooms : null;
  if (!rooms || typeof rooms !== 'object') return out;
  for (const [id, entry] of Object.entries(rooms)) {
    if (!entry || typeof entry !== 'object') continue;
    const views = KIND_ORDER
      .map((kind) => ({ kind, label: KIND_LABELS[kind], src: safe(entry[kind]) }))
      .filter((v) => v.src);
    if (!views.length) continue;
    out.set(id, { views, thumb: safe(entry.thumb) || views[0].src });
  }
  return out;
}

/** Photos for one room, or null when we have none. */
export function photosFor(map, roomId) {
  return map?.get(roomId) || null;
}

/** Index of the next/previous view, wrapping around. */
export function stepIndex(current, count, delta) {
  return count > 0 ? (((current + delta) % count) + count) % count : 0;
}
