// Pure logic for the Study spots layer: tag filters and grouping by building. No DOM.
// Data shape: data/study_spots.json (copied to web/data/study_spots.json by scripts/build_layer_data.py).

/** Filter chips. A spot matches a chip if it has any of `tags`. Several chips narrow the list (AND). */
export const TAG_FILTERS = [
  { key: 'quiet', label: 'Quiet', tags: ['quiet', 'silent'], hint: 'Quiet or silent zones' },
  { key: 'group', label: 'Group', tags: ['group'], hint: 'Good for working together' },
  { key: '24h', label: '24 h', tags: ['24h access'], hint: 'Reported open around the clock' },
  { key: 'outlets', label: 'Outlets', tags: ['outlets'], hint: 'Power outlets mentioned' },
  { key: 'food', label: 'Food nearby', tags: ['food nearby'], hint: 'Food or coffee close by' },
  { key: 'bookable', label: 'Bookable', tags: ['bookable'], hint: 'Rooms can be booked' },
];

// Buildings that host study spots but have no classroom entry in buildings.json.
export const FALLBACK_BUILDING_NAMES = {
  LIB: 'Dana Porter Library',
  SLC: 'Student Life Centre',
  NH: 'Needles Hall',
  TC: 'Tatham Centre',
};

/** Keep only well-formed spots (finite coordinates, an id, a building, a tag array). */
export function cleanSpots(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string'
    && typeof s.building === 'string' && Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({ ...s, tags: Array.isArray(s.tags) ? s.tags : [] }));
}

export function spotMatches(spot, activeKeys) {
  for (const key of activeKeys) {
    const f = TAG_FILTERS.find((x) => x.key === key);
    if (f && !f.tags.some((t) => spot.tags.includes(t))) return false;
  }
  return true;
}

export function filterSpots(spots, activeKeys) {
  return activeKeys.size === 0 ? spots.slice() : spots.filter((s) => spotMatches(s, activeKeys));
}

/** How many spots carry each chip's tags (over the unfiltered list). */
export function tagCounts(spots) {
  const out = {};
  for (const f of TAG_FILTERS) out[f.key] = spots.filter((s) => f.tags.some((t) => s.tags.includes(t))).length;
  return out;
}

/** Map(buildingCode -> spots[]) in first-seen order. Spots in one building share one map marker. */
export function groupByBuilding(spots) {
  const out = new Map();
  for (const s of spots) {
    if (!out.has(s.building)) out.set(s.building, []);
    out.get(s.building).push(s);
  }
  return out;
}

export function displayTag(tag) {
  if (tag === '24h access') return '24 h access';
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function sourceHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

export const CONFIDENCE = {
  official: { label: 'Official', help: 'Listed on a University of Waterloo page' },
  anecdotal: { label: 'Anecdotal', help: 'Student reports or a dated blog post; not confirmed by the University' },
};
