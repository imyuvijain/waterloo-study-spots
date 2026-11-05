// Optional map layers: Libraries (open/closed, live or estimated busyness) and Study spots.
// Both are off by default. Nothing is fetched until a layer is switched on (or, for study spots,
// until someone opens a building). The only third-party request is the Waitz feed, and only while
// the Libraries layer is on, the tab is visible, and the selected time is "Now".
import { torontoParts, formatMinutes } from './availability.js';
import {
  openStatus, weekRows, resolveBusyness, busynessText, REASON_TEXT, TIER_WORD,
} from './libraries.js';
import { fetchWaitz, nextPollDelay } from './waitz.js';
import {
  TAG_FILTERS, FALLBACK_BUILDING_NAMES, cleanSpots, filterSpots, tagCounts, groupByBuilding,
  displayTag, sourceHost, CONFIDENCE,
} from './studyspots.js';

const BOOK_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M2 2.5h4.3c.9 0 1.7.4 1.7 1.2V13c0-.7-.8-1.1-1.7-1.1H2zM14 2.5H9.7C8.8 2.5 8 2.9 8 3.7V13c0-.7.8-1.1 1.7-1.1H14z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const TIER_SHORT = { quiet: 'quiet', moderate: 'moderate', busy: 'busy' };
const STATUS_GLYPH = { open: '✓', closed: '–', unknown: '?' };
const WAITZ_PAGE = 'https://waitz.io/waterloo';

export function initLayers(ctx) {
  const { h, $ } = ctx;
  const on = { libs: false, spots: false };
  let libData = null, libPromise = null;
  let spotData = null, spotPromise = null;
  let selectedLib = null;
  let forceOpenBuilding = null;
  const openGroups = new Set(); // <details> the person opened, so a re-render keeps them open
  const activeTags = new Set();

  // live feed state
  let feed = null, feedStatus = 'idle', fails = 0, lastAttemptAt = null, timer = null, inflight = false, feedSig = '';

  const libGroup = L.layerGroup();
  const spotGroup = L.layerGroup();
  const libMarkers = new Map(); // id -> {lib, marker}
  const spotMarkers = new Map(); // building code -> {code, marker}

  /* ---------- small helpers ---------- */
  const setStatus = (msg) => { $('layer-status').textContent = msg || ''; };
  const link = (text, href, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls },
    text, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));
  const buildingName = (code) => ctx.state.data.buildings?.[code]?.name || FALLBACK_BUILDING_NAMES[code] || code;
  const parts = () => torontoParts(ctx.currentDate());

  function term() {
    const t = ctx.classRange();
    return { classStart: t?.[0] || null, classEnd: t?.[1] || null, termEnd: ctx.state.data.term_end || null };
  }

  function libInfo(lib) {
    const p = parts();
    const status = openStatus(lib, p);
    const busy = resolveBusyness({
      lib, est: libData.typical_busyness_estimate, parts: p, isNow: ctx.state.live, feed, feedStatus, term: term(),
    });
    return { status, busy, parts: p };
  }

  async function ensureLibs() {
    if (libData) return libData;
    libPromise ??= ctx.loadJson('data/libraries.json').then((d) => {
      if (!Array.isArray(d?.libraries)) throw new Error('libraries.json has no libraries');
      libData = d;
      return d;
    });
    try { return await libPromise; } catch (e) { libPromise = null; throw e; }
  }

  async function ensureSpots() {
    if (spotData) return spotData;
    spotPromise ??= ctx.loadJson('data/study_spots.json').then((d) => {
      spotData = cleanSpots(d);
      return spotData;
    });
    try { return await spotPromise; } catch (e) { spotPromise = null; throw e; }
  }

  // Which of the three stacked elements a building has: label+polygon, label+dot, or no label at all.
  function posClass(code) {
    const l = ctx.bLayers.get(code);
    return !l ? 'pos-none' : l.hasPoly ? 'pos-poly' : 'pos-pt';
  }
  function coords(code, fallback) {
    const b = ctx.state.data.buildings?.[code];
    return b && b.lat != null ? [b.lat, b.lng] : fallback;
  }
  function activate(el, fn) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  }

  /* ---------- toggles ---------- */
  function initToggles() {
    $('layer-libs').addEventListener('change', (e) => toggleLibs(e.target.checked));
    $('layer-spots').addEventListener('change', (e) => toggleSpots(e.target.checked));
    const fs = $('spot-tags');
    for (const f of TAG_FILTERS) {
      const input = h('input', { type: 'checkbox', value: f.key, 'aria-describedby': `tf-${f.key}` });
      const count = h('span', { class: 'tf-n', id: `tf-${f.key}` });
      input.addEventListener('change', () => {
        if (input.checked) activeTags.add(f.key); else activeTags.delete(f.key);
        ctx.render();
      });
      fs.append(h('label', { title: f.hint }, input, h('span', null, f.label, ' ', count)));
    }
    document.addEventListener('visibilitychange', syncPoller);
  }

  async function toggleLibs(want) {
    if (!want) {
      on.libs = false;
      libGroup.clearLayers();
      libGroup.remove();
      libMarkers.clear();
      selectedLib = null;
      setStatus('');
      syncPoller();
      ctx.render();
      return;
    }
    try {
      await ensureLibs();
    } catch (e) {
      $('layer-libs').checked = false;
      setStatus(`Could not load the library data (${e.message}).`);
      return;
    }
    if (!$('layer-libs').checked || on.libs) return; // switched off while loading
    setStatus('');
    libGroup.addTo(ctx.getMap());
    buildLibMarkers();
    on.libs = true;
    syncPoller();
    ctx.render();
  }

  async function toggleSpots(want) {
    if (!want) {
      on.spots = false;
      $('spot-tags').hidden = true;
      spotGroup.clearLayers();
      spotGroup.remove();
      spotMarkers.clear();
      setStatus('');
      ctx.render();
      return;
    }
    try {
      await ensureSpots();
    } catch (e) {
      $('layer-spots').checked = false;
      setStatus(`Could not load the study spots (${e.message}).`);
      return;
    }
    if (!$('layer-spots').checked || on.spots) return;
    setStatus('');
    $('spot-tags').hidden = false;
    spotGroup.addTo(ctx.getMap());
    on.spots = true;
    ctx.render();
  }

  /* ---------- live feed polling ---------- */
  const shouldPoll = () => on.libs && document.visibilityState === 'visible' && ctx.state.live;

  function syncPoller() {
    if (!shouldPoll()) {
      if (timer) { clearTimeout(timer); timer = null; }
      return;
    }
    if (timer || inflight) return;
    timer = setTimeout(poll, nextPollDelay({ lastAttemptAt, fails, now: Date.now() }));
  }

  async function poll() {
    timer = null;
    if (!shouldPoll() || inflight) return;
    inflight = true;
    lastAttemptAt = Date.now();
    if (!feed) feedStatus = 'loading';
    try {
      feed = await fetchWaitz();
      feedStatus = 'ok';
      fails = 0;
    } catch (e) {
      fails++;
      feedStatus = 'error'; // an older reading is kept but stops counting as live once it is 5 minutes old
    } finally {
      inflight = false;
    }
    const sig = signature();
    if (sig !== feedSig) { feedSig = sig; ctx.render({ keepFocus: true }); }
    syncPoller();
  }

  const signature = () => `${feedStatus}|${feed ? [...feed.byId.values()].map((v) => `${v.id}:${v.pct}:${v.zones.map((z) => z.pct)}`).join(',') : ''}`;

  /* ---------- map markers: libraries ---------- */
  function buildLibMarkers() {
    if (libMarkers.size) return;
    for (const lib of libData.libraries) {
      const marker = L.marker(coords(lib.building, [lib.lat, lib.lng]), {
        keyboard: true, riseOnHover: true, zIndexOffset: 700,
        icon: L.divIcon({ className: `lm-wrap ${posClass(lib.building)}`, html: '', iconSize: [0, 0] }),
      });
      const go = () => selectLibrary(lib.id, { pan: false });
      marker.on('click', go);
      marker.addTo(libGroup);
      if (marker.getElement()) activate(marker.getElement(), go);
      libMarkers.set(lib.id, { lib, marker });
    }
  }

  function libLabel(lib, info) {
    const bits = [lib.name, info.status.text, busynessText(info.busy)];
    return bits.join('. ');
  }

  function paintLibMarkers() {
    for (const { lib, marker } of libMarkers.values()) {
      const el = marker.getElement();
      if (!el) continue;
      const info = libInfo(lib);
      const label = libLabel(lib, info);
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', label);
      el.setAttribute('title', label);
      el.classList.toggle('sel', selectedLib === lib.id);
      const word = info.status.state === 'open' ? 'Open' : info.status.state === 'closed' ? 'Closed' : 'Hours?';
      let busy = null;
      if (info.busy.kind === 'live') {
        busy = h('span', { class: 'lm-b is-live' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), `${Math.round(info.busy.pct)}% live`);
      } else if (info.busy.kind === 'estimate') {
        busy = h('span', { class: 'lm-b is-est' }, `Est. ${TIER_SHORT[info.busy.tier]}`);
      }
      const pill = h('span', { class: `lm lm-${info.status.state}` },
        h('span', { class: 'lm-ico', 'aria-hidden': 'true' }), h('b', null, word), busy);
      pill.querySelector('.lm-ico').innerHTML = BOOK_SVG;
      el.replaceChildren(pill);
    }
  }

  /* ---------- map markers: study spots (one per building) ---------- */
  function visibleSpots() { return filterSpots(spotData || [], activeTags); }

  function paintSpotMarkers() {
    const groups = groupByBuilding(visibleSpots());
    for (const [code, entry] of spotMarkers) {
      if (!groups.has(code)) { spotGroup.removeLayer(entry.marker); }
    }
    for (const [code, list] of groups) {
      let entry = spotMarkers.get(code);
      if (!entry) {
        const marker = L.marker(coords(code, [list[0].lat, list[0].lng]), {
          keyboard: true, riseOnHover: true, zIndexOffset: 400,
          icon: L.divIcon({ className: `sm-wrap ${posClass(code)}`, html: '', iconSize: [0, 0] }),
        });
        const go = () => ctx.selectBuilding(code, { pan: false, openSpots: true });
        marker.on('click', go);
        entry = { code, marker, go, keys: false };
        spotMarkers.set(code, entry);
      }
      if (!spotGroup.hasLayer(entry.marker)) {
        spotGroup.addLayer(entry.marker);
        if (entry.marker.getElement()) activate(entry.marker.getElement(), entry.go);
      }
      const el = entry.marker.getElement();
      if (!el) continue;
      const label = `${buildingName(code)}: ${list.length} study spot${list.length === 1 ? '' : 's'}`;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', label);
      el.setAttribute('title', label);
      el.replaceChildren(h('span', { class: 'sm' }, h('b', null, String(list.length)), h('span', { class: 'sm-t' }, list.length === 1 ? ' spot' : ' spots')));
    }
  }

  function updateTagChips() {
    if (!spotData) return;
    const counts = tagCounts(spotData);
    for (const f of TAG_FILTERS) {
      const n = $(`tf-${f.key}`);
      if (n) n.textContent = `(${counts[f.key]})`;
    }
  }

  /** Called from the app's render(): repaint whatever markers exist. */
  function update() {
    if (on.libs && libData) paintLibMarkers();
    if (on.spots && spotData) { updateTagChips(); paintSpotMarkers(); }
    syncPoller();
  }

  /* ---------- selection ---------- */
  function selectLibrary(id, opts = {}) {
    selectedLib = id;
    ctx.state.selected = null;
    ctx.state.highlightRoom = null;
    if (ctx.state.view !== 'map') ctx.setView('map', { keepSelection: true });
    const entry = libMarkers.get(id);
    if (opts.pan && entry) ctx.panTo(entry.marker.getLatLng(), ctx.isOffCampus(entry.lib.building));
    ctx.render();
    $('panel').scrollTop = 0;
    if (window.matchMedia('(max-width: 819px)').matches) {
      $('panel').scrollIntoView({ block: 'start', behavior: ctx.reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  /* ---------- panel pieces ---------- */
  function statusPill(status) {
    return h('span', { class: `pill pill-${status.state}` }, h('span', { 'aria-hidden': 'true' }, STATUS_GLYPH[status.state]), ' ', status.text);
  }

  function meter(pct, kind, label) {
    const m = h('div', { class: `meter ${kind}`, role: 'img', 'aria-label': label }, h('i'));
    m.firstChild.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    return m;
  }

  function busyBlock(lib, info, { compact = false } = {}) {
    const b = info.busy;
    if (b.kind === 'live') {
      return h('div', { class: 'busy is-live' },
        h('p', { class: 'busy-main' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), busynessText(b)),
        compact ? null : meter(b.pct, 'live', `${Math.round(b.pct)} percent busy, live`),
        compact || b.people == null || b.capacity == null ? null
          : h('p', { class: 'busy-sub' }, `About ${b.people} of ${b.capacity} seats counted by Waitz sensors. Updated ${formatMinutes(torontoParts(new Date(b.at)).minutes)} Toronto time.`));
    }
    if (b.kind === 'estimate') {
      return h('div', { class: 'busy is-est' },
        h('p', { class: 'busy-main' }, busynessText(b)),
        compact ? null : meter(b.value * 100, 'est', `Estimate, not live: typically ${TIER_WORD[b.tier]}`),
        compact ? null : h('p', { class: 'busy-sub' }, REASON_TEXT[b.reason], ' This is a hand-built pattern by hour and week of term, not measured, and can be well off.'));
    }
    return h('div', { class: 'busy is-none' }, h('p', { class: 'busy-main' }, busynessText(b)));
  }

  function zoneList(lib, info) {
    if (info.busy.kind !== 'live' || !info.busy.zones?.length) return null;
    const order = new Map((lib.live_zones || []).map((z, i) => [z.waitz_id, i]));
    const zones = info.busy.zones.slice().sort((a, c) => (order.get(a.id) ?? 99) - (order.get(c.id) ?? 99));
    return h('section', { class: 'zones', 'aria-label': 'Busyness by floor, live' },
      h('h3', null, 'By floor, live'),
      h('ul', null, zones.map((z) => h('li', null,
        h('span', { class: 'z-name' }, z.name),
        z.isOpen
          ? h('span', { class: 'z-pct' }, `${Math.round(z.pct)}% busy`)
          : h('span', { class: 'z-pct' }, 'Closed'),
        z.isOpen ? meter(z.pct, 'live', `${z.name}: ${Math.round(z.pct)} percent busy, live`) : null))));
  }

  function liveCredit(lib) {
    if (!lib.live_occupancy) return null;
    return h('p', { class: 'credit' }, 'Live numbers come from ', link('Waitz', WAITZ_PAGE),
      ' (people-counting sensors by Occuspace), an unofficial feed that is not run by the University and can change or stop.');
  }

  function hoursBlock(lib, info) {
    const out = [];
    if (info.status.state === 'unknown') {
      out.push(h('p', { class: 'hours-warn' }, 'Hours unverified. We could not confirm when this library is open.'),
        h('p', null, link('Check the official source', lib.source_url, 'strong-link')));
      return out;
    }
    out.push(h('p', { class: 'hours-note' }, 'Regular term hours as seen on the Library’s hours page. Exam periods, holidays and reading weeks can differ. ',
      link('Official hours', lib.source_url, 'strong-link')));
    const rows = weekRows(lib);
    const key = `hours:${lib.id}`;
    out.push(h('details', {
      class: 'more-info', open: openGroups.has(key), ontoggle: (e) => { if (e.target.open) openGroups.add(key); else openGroups.delete(key); },
    },
    h('summary', null, 'Weekly hours and exceptions'),
    h('table', { class: 'hours-table' }, h('tbody', null, rows.map((r) => h('tr', { class: r.weekday === info.parts.weekday ? 'today' : null },
      h('th', { scope: 'row' }, r.day), h('td', null, r.text))))),
    lib.hours_exceptions?.length ? h('ul', { class: 'exc' }, lib.hours_exceptions.map((t) => h('li', null, t))) : null));
    return out;
  }

  function libraryView() {
    const lib = libData.libraries.find((l) => l.id === selectedLib);
    if (!lib) return overviewLibs();
    const info = libInfo(lib);
    const conflict = info.busy.kind === 'live' && info.status.state === 'closed';
    return [
      h('button', { type: 'button', class: 'back', onclick: () => { selectedLib = null; ctx.render(); } }, '← All buildings'),
      h('h2', { class: 'panel-title' }, lib.name),
      h('p', { class: 'panel-sub' }, statusPill(info.status), ctx.state.live ? ' now' : ` at ${formatMinutes(info.parts.minutes)}`),
      conflict ? h('p', { class: 'far-note' }, 'Waitz reports this library as open, but the regular hours say closed. Extended hours may be in effect; check the official hours.') : null,
      h('section', { class: 'lib-sec', 'aria-label': 'Busyness' }, h('h3', null, 'How busy'), busyBlock(lib, info), liveCredit(lib)),
      zoneList(lib, info),
      h('section', { class: 'lib-sec', 'aria-label': 'Opening hours' }, h('h3', null, 'Opening hours'), ...hoursBlock(lib, info)),
      ctx.state.data.buildings?.[lib.building] && ctx.state.data.rooms.some((r) => r.building === lib.building)
        ? h('button', { type: 'button', class: 'linkish', onclick: () => ctx.selectBuilding(lib.building, { pan: false }) }, `Rooms in ${lib.building}`) : null,
      spotsHere(lib.building),
    ];
  }

  function overviewLibs() {
    const items = libData.libraries.map((lib) => {
      const info = libInfo(lib);
      return h('li', null, h('button', { type: 'button', class: 'lib-btn', onclick: () => selectLibrary(lib.id, { pan: true }) },
        h('b', null, lib.name),
        h('span', { class: 'lib-line' }, statusPill(info.status)),
        h('span', { class: 'lib-line' }, busyBlock(lib, info, { compact: true }))));
    });
    const live = feedStatus === 'ok' && feed;
    return h('section', { class: 'layer-sec', 'aria-label': 'Libraries' },
      h('h3', null, 'Libraries'),
      h('p', { class: 'layer-note' },
        ctx.state.live
          ? (live ? 'Live busyness where the Waitz sensors cover a library; estimates elsewhere.' : 'Busyness shows as an estimate unless a live reading loads.')
          : 'You picked a time other than now, so busyness is an estimate for that time, not live.'),
      h('ul', { class: 'lib-list' }, items),
      h('p', { class: 'credit' }, 'Live data: ', link('Waitz', WAITZ_PAGE), ', unofficial.'));
  }

  /* ---------- study spot rows ---------- */
  function spotRow(s) {
    const conf = CONFIDENCE[s.confidence] || CONFIDENCE.anecdotal;
    const official = s.confidence === 'official';
    return h('li', { class: `spot ${official ? 'is-official' : 'is-anecdotal'}` },
      h('div', { class: 'spot-head' },
        h('p', { class: 'spot-name' }, s.name),
        h('span', { class: `conf ${official ? 'conf-official' : 'conf-anecdotal'}`, title: conf.help },
          h('span', { 'aria-hidden': 'true' }, official ? '✓' : '?'), ' ', conf.label)),
      s.floor_area ? h('p', { class: 'spot-where' }, s.floor_area) : null,
      s.tags.length ? h('ul', { class: 'tags', 'aria-label': 'Tags' }, s.tags.map((t) => h('li', null, displayTag(t)))) : null,
      s.hours_note ? h('p', { class: 'spot-note' }, s.hours_note) : null,
      official ? null : h('p', { class: 'spot-note' }, conf.help + '.'),
      h('p', { class: 'spot-src' }, link(`Source: ${sourceHost(s.source_url) || 'link'}`, s.source_url),
        s.source_note ? h('span', { class: 'spot-sn' }, ` ${s.source_note}`) : null));
  }

  function overviewSpots() {
    const all = spotData;
    const shown = visibleSpots();
    const groups = groupByBuilding(shown);
    const filtering = activeTags.size > 0;
    const out = [h('h3', null, 'Study spots'),
      h('p', { class: 'layer-note' }, filtering
        ? `${shown.length} of ${all.length} spots match every tag you picked (${groups.size} building${groups.size === 1 ? '' : 's'}).`
        : `${all.length} spots in ${groups.size} buildings. Use the tag chips above the map to narrow them.`)];
    if (!shown.length) {
      out.push(h('p', { class: 'empty' }, 'No spot has all of those tags. Turn a tag off to see more.'),
        h('button', { type: 'button', class: 'linkish', onclick: () => { activeTags.clear(); document.querySelectorAll('#spot-tags input').forEach((i) => { i.checked = false; }); ctx.render(); } }, 'Clear tag filters'));
    }
    for (const [code, list] of groups) {
      const key = `g:${code}`;
      out.push(h('details', {
        class: 'sgroup', open: openGroups.has(key) || filtering, 'data-code': code,
        ontoggle: (e) => { if (e.target.open) openGroups.add(key); else openGroups.delete(key); },
      },
      h('summary', null, h('span', { class: 'sg-name' }, buildingName(code)), h('span', { class: 'sg-n' }, `${code}, ${list.length}`)),
      h('ul', { class: 'spots' }, list.map(spotRow)),
      h('button', { type: 'button', class: 'linkish', onclick: () => ctx.selectBuilding(code, { pan: true, openSpots: true }) }, 'Show on the map')));
    }
    return h('section', { class: 'layer-sec', 'aria-label': 'Study spots' }, ...out);
  }

  /** Overview sections for whichever layers are on. */
  function overviewSections() {
    const out = [];
    if (on.libs && libData) out.push(overviewLibs());
    if (on.spots && spotData) out.push(overviewSpots());
    return out;
  }

  /** "Study spots in this building" for the building panel; null if there are none (or data not loaded yet). */
  function spotsHere(code) {
    if (!spotData) return null;
    const list = spotData.filter((s) => s.building === code);
    if (!list.length) return null;
    const key = `b:${code}`;
    const wantOpen = forceOpenBuilding === code || openGroups.has(key);
    const el = h('details', {
      class: 'sgroup bspots', open: wantOpen,
      ontoggle: (e) => { if (e.target.open) openGroups.add(key); else openGroups.delete(key); },
    },
    h('summary', null, h('span', { class: 'sg-name' }, 'Study spots in this building'), h('span', { class: 'sg-n' }, String(list.length))),
    h('ul', { class: 'spots' }, list.map(spotRow)));
    return el;
  }

  function buildingSpots(code) {
    const el = spotsHere(code);
    if (forceOpenBuilding === code) { openGroups.add(`b:${code}`); forceOpenBuilding = null; }
    return el;
  }

  function wantSpotsOpen(code) { forceOpenBuilding = code; }

  initToggles();

  return {
    update,
    overviewSections,
    libraryView,
    buildingSpots,
    wantSpotsOpen,
    ensureSpots: () => ensureSpots().then(() => true, () => false),
    spotsLoaded: () => !!spotData,
    selectedLibrary: () => selectedLib,
    clearLibrary: () => { selectedLib = null; },
    spotLatLng: (code) => spotMarkers.get(code)?.marker.getLatLng() || null,
    spotCoords: (code) => { const s = spotData?.find((x) => x.building === code); return s ? [s.lat, s.lng] : null; },
    isOn: () => ({ ...on }),
  };
}
