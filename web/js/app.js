import {
  torontoParts, busyNow, nextBusy, freeForMinutes, formatMinutes, summarizeByBuilding,
} from './availability.js';
import { initLayers } from './layers.js';
import { weeklyUsage, topAndBottom } from './usage.js';
import { cleanManifest, photosFor, stepIndex } from './photos.js';
import { cleanSizes, capacityLabel, CAPACITY_NOTE } from './capacity.js';
import { FALLBACK_BUILDING_NAMES } from './studyspots.js';

/* ---------- constants ---------- */
const MAP_CENTER = [43.4729, -80.5489]; // only used if no building has coordinates
const MAP_ZOOM = 16;
const CAMPUS_RADIUS_KM = 3; // buildings farther than this from the median building are "away from campus"
const CORE_RADIUS_KM = 1; // the initial view fits buildings within this distance of the median building
const STRIP_START = 7 * 60, STRIP_END = 22 * 60;
const LIST_CAP = 150;
const USAGE_TOP = 10;
const COLOR_NONE = [236, 239, 241], COLOR_ALL = [8, 100, 86];
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- state ---------- */
const state = {
  data: null,
  rooms: [],
  roomsByBuilding: new Map(),
  live: true,
  dateStr: null,
  minutes: 0,
  minFree: 'all', // 'all' | 0 | 30 | 60 | 120
  view: 'map',
  selected: null, // building code
  highlightRoom: null,
  listShown: LIST_CAP,
  photos: new Map(), // room id -> { views, thumb }, from data/room_photos.json (optional)
  sizes: new Map(), // room id -> estimated seats, from data/room_sizes.json (optional)
};

const $ = (id) => document.getElementById(id);

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ---------- time ---------- */
function torontoToDate(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d) + minutes * 60000;
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = torontoParts(new Date(t));
    const [py, pm, pd] = p.dateStr.split('-').map(Number);
    t += want - (Date.UTC(py, pm - 1, pd) + p.minutes * 60000);
  }
  return new Date(t);
}

function currentDate() {
  return state.live ? new Date() : torontoToDate(state.dateStr, state.minutes);
}

function syncFromNow() {
  const p = torontoParts(new Date());
  state.dateStr = p.dateStr;
  state.minutes = p.minutes;
}

function prettyDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = DAY_NAMES[((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1];
  return `${wd} ${MONTHS[m - 1]} ${d}`;
}

/* ---------- schedule helpers (date-range aware, mirrors availability.js semantics) ---------- */
function activeIntervals(room, dateStr, weekday) {
  const list = room.busy?.[weekday] || [];
  return list.filter((iv) => (!iv[2] || iv[2] <= dateStr) && (!iv[3] || dateStr <= iv[3]));
}

function roomStatus(room, date) {
  const busy = busyNow(room, date);
  if (busy) return { free: false, busy, minsFree: 0, until: busy.end };
  const mins = freeForMinutes(room, date);
  const nx = nextBusy(room, date);
  return { free: true, busy: null, minsFree: mins, until: nx ? nx.start : null, next: nx };
}

function passes(status) {
  if (state.minFree === 'all') return true;
  if (!status.free) return false;
  return status.minsFree === null || status.minsFree >= state.minFree;
}

function fmtDuration(mins) {
  if (mins < 60) return `${mins} min`;
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

/* ---------- data loading ---------- */
async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  let real = null, realErr = null;
  try {
    real = await loadJson('data/rooms.json');
  } catch (e) {
    realErr = e;
  }
  if (real && Array.isArray(real.rooms) && real.rooms.length > 0) return real;
  console.info('rooms.json has no rooms (%s); falling back to rooms.demo.json', realErr ? realErr.message : 'empty');
  const demo = await loadJson('data/rooms.demo.json');
  demo.demo = true;
  return demo;
}

/* ---------- map ---------- */
let map, bLayers = new Map(); // code -> {shape, label, hasPoly}
let layers = null; // optional map layers (libraries, study spots), see layers.js
let campusBounds = null, campusCenter = null, mapMoved = false;
const offCampus = new Map(); // code -> km from campus centre

function kmBetween(a, b) {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

// Work out which class-hosting buildings form the main campus (everything within CAMPUS_RADIUS_KM of
// the median building) and which are satellites (Cambridge, Stratford, Kitchener...).
function computeCampus() {
  const pts = Object.entries(state.data.buildings || {})
    .filter(([code, b]) => b.lat != null && b.lng != null && state.roomsByBuilding.has(code));
  if (!pts.length) return;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const mid = [med(pts.map(([, b]) => b.lat)), med(pts.map(([, b]) => b.lng))];
  const within = (km) => pts.filter(([, b]) => kmBetween(mid, [b.lat, b.lng]) <= km);
  let core = within(CORE_RADIUS_KM);
  if (core.length < 3) core = within(CAMPUS_RADIUS_KM);
  const pad = (b) => (b.polygon && b.polygon.length ? b.polygon.map(([lng, lat]) => [lat, lng]) : [[b.lat, b.lng]]);
  campusBounds = L.latLngBounds(core.flatMap(([, b]) => pad(b)));
  campusCenter = campusBounds.getCenter();
  for (const [code, b] of pts) {
    const km = kmBetween(mid, [b.lat, b.lng]);
    if (km > CAMPUS_RADIUS_KM) offCampus.set(code, km);
  }
}

function fitCampus({ animate = false } = {}) {
  if (!campusBounds) { map.setView(MAP_CENTER, MAP_ZOOM); return; }
  map.fitBounds(campusBounds, { padding: [16, 16], maxZoom: 17, animate });
  mapMoved = false;
}

function lerpColor(r) {
  const c = COLOR_NONE.map((a, i) => Math.round(a + (COLOR_ALL[i] - a) * r));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function polygonCenter(coords) {
  let la = 0, lo = 0;
  for (const [lng, lat] of coords) { la += lat; lo += lng; }
  return [la / coords.length, lo / coords.length];
}

function initMap() {
  computeCampus();
  map = L.map('map', { center: campusCenter || MAP_CENTER, zoom: MAP_ZOOM, zoomControl: true, maxZoom: 19, zoomSnap: 0.25 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  for (const [code, b] of Object.entries(state.data.buildings || {})) {
    if (b.lat == null || b.lng == null) continue;
    let shape, center = [b.lat, b.lng];
    const hasPoly = Array.isArray(b.polygon) && b.polygon.length >= 3;
    if (hasPoly) {
      shape = L.polygon(b.polygon.map(([lng, lat]) => [lat, lng]), { weight: 1.5, color: '#14212b', fillOpacity: 0.8 });
    } else {
      shape = L.circleMarker(center, { radius: 11, weight: 1.5, color: '#14212b', fillOpacity: 0.85 });
    }
    shape.on('click', () => selectBuilding(code, { pan: false }));
    shape.addTo(map);

    const label = L.marker(center, {
      keyboard: true,
      riseOnHover: true,
      icon: L.divIcon({ className: hasPoly ? 'bl-wrap' : 'bl-wrap pt', html: '', iconSize: [0, 0] }),
    });
    label.on('click', () => selectBuilding(code, { pan: false }));
    label.addTo(map);
    // Leaflet's own Enter-to-click on markers did not fire reliably in Chromium, so handle keys here.
    label.getElement()?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBuilding(code, { pan: false }); }
    });
    bLayers.set(code, { shape, label, hasPoly });
  }

  fitCampus();
  const sync = () => {
    $('map').classList.toggle('zoom-far', map.getZoom() < 15);
    $('map').classList.toggle('zoom-near', map.getZoom() >= 17);
  };
  map.on('zoomend', sync);
  sync();
  // fitCampus() resets this flag after its own (synchronous) zoom, so only later moves count.
  map.on('dragstart zoomstart', () => { mapMoved = true; });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { map.invalidateSize(); if (!mapMoved) fitCampus(); }, 150);
  });
}

function updateMap() {
  const date = currentDate();
  for (const [code, l] of bLayers) {
    const rooms = state.roomsByBuilding.get(code) || [];
    let match = 0;
    for (const r of rooms) { const s = roomStatus(r, date); if (s.free && passes(s)) match++; }
    const total = rooms.length;
    const ratio = total ? match / total : 0;
    const sel = state.selected === code;
    l.shape.setStyle({
      fillColor: lerpColor(ratio),
      color: sel ? '#d6246e' : '#14212b',
      weight: sel ? 4 : 1.5,
      dashArray: match === 0 ? '4 4' : null,
      fillOpacity: match === 0 ? 0.5 : 0.82,
    });
    if (sel) l.shape.bringToFront();
    const name = state.data.buildings[code].name || code;
    const txt = `${code}: ${match} of ${total} rooms free`;
    l.shape.unbindTooltip();
    l.shape.bindTooltip(`${name} - ${match} of ${total} free`, { sticky: true });
    const el = l.label.getElement();
    if (el) {
      el.setAttribute('title', txt);
      el.setAttribute('aria-label', txt);
      el.setAttribute('role', 'button');
      el.classList.toggle('sel', sel);
      el.classList.toggle('none', match === 0);
      el.replaceChildren(h('span', { class: 'bl' }, h('b', null, code), h('span', { class: 'bl-n' }, `${match}/${total}`)));
    }
  }
}

/* ---------- strip (day timeline for one room) ---------- */
function strip(room, dateStr, weekday, minutes) {
  const span = STRIP_END - STRIP_START;
  const pct = (m) => `${(Math.min(Math.max(m, STRIP_START), STRIP_END) - STRIP_START) / span * 100}%`;
  const el = h('div', { class: 'strip', 'aria-hidden': 'true' });
  for (const iv of activeIntervals(room, dateStr, weekday)) {
    const [s, e] = iv;
    if (e <= STRIP_START || s >= STRIP_END) continue;
    const a = Math.max(s, STRIP_START), b = Math.min(e, STRIP_END);
    const seg = h('i', { class: 'seg', title: `${formatMinutes(s)}-${formatMinutes(e)} ${iv[4] || ''}`.trim() });
    seg.style.left = pct(a);
    seg.style.width = `${(b - a) / span * 100}%`;
    el.append(seg);
  }
  if (minutes >= STRIP_START && minutes <= STRIP_END) {
    const t = h('b', { class: 'tick' });
    t.style.left = pct(minutes);
    el.append(t);
  }
  return el;
}

/* ---------- estimated capacity ---------- */
function capacityTag(room) {
  const label = capacityLabel(state.sizes, room.id);
  return label ? h('span', { class: 'cap-est', title: CAPACITY_NOTE }, label) : null;
}

/* ---------- room photos ---------- */
function photoButton(room) {
  const p = photosFor(state.photos, room.id);
  if (!p) return null;
  const btn = h('button', {
    type: 'button', class: 'room-photo', 'aria-label': `View photos of ${room.id}`,
    onclick: (e) => { e.stopPropagation(); openPhotos(room, btn); },
    onkeydown: (e) => e.stopPropagation(), // keep Enter/Space on the button from triggering the row
  }, h('img', { src: p.thumb, alt: '', loading: 'lazy', decoding: 'async' }),
  p.views.length > 1 ? h('span', { class: 'room-photo-n', 'aria-hidden': 'true' }, String(p.views.length)) : null);
  return btn;
}

function openPhotos(room, opener) {
  const p = photosFor(state.photos, room.id);
  if (!p) return;
  const bName = state.data.buildings[room.building]?.name || room.building;
  let idx = 0;
  const dlg = h('dialog', { class: 'photo-dialog', 'aria-label': `Photos of ${room.id}` });
  const img = h('img', { class: 'photo-big', alt: '' });
  const cap = h('p', { class: 'photo-cap' });
  const tabs = h('div', { class: 'photo-tabs', role: 'group', 'aria-label': 'Photo view' });
  const show = (i) => {
    idx = stepIndex(i, p.views.length, 0);
    const v = p.views[idx];
    img.src = v.src;
    img.alt = `${v.label}, ${room.id}`;
    cap.textContent = `${v.label}${p.views.length > 1 ? ` (${idx + 1} of ${p.views.length})` : ''}`;
    [...tabs.children].forEach((b, j) => b.setAttribute('aria-pressed', String(j === idx)));
  };
  p.views.forEach((v, i) => tabs.append(h('button', { type: 'button', class: 'photo-tab', onclick: () => show(i) }, v.label)));
  dlg.append(
    h('div', { class: 'photo-head' },
      h('div', null, h('h2', null, room.id), h('p', { class: 'room-bldg' }, bName, capacityLabel(state.sizes, room.id) ? ` · ${capacityLabel(state.sizes, room.id)}` : '')),
      h('button', { type: 'button', class: 'photo-close', 'aria-label': 'Close photos', onclick: () => dlg.close() }, '\u00d7')),
    h('div', { class: 'photo-stage' }, img),
    cap, p.views.length > 1 ? tabs : null,
    h('p', { class: 'photo-src' }, 'Photos: UW Instructional Technologies and Media Services.'));
  dlg.addEventListener('keydown', (e) => {
    if (p.views.length < 2) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(stepIndex(idx, p.views.length, 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(stepIndex(idx, p.views.length, -1)); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop
  dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  document.body.append(dlg);
  show(0);
  dlg.showModal();
}

/* ---------- room row ---------- */
function roomRow(room, status, ctx, { showBuilding = false } = {}) {
  const free = status.free;
  let detail;
  if (free) {
    detail = status.until == null ? 'Free for the rest of the day'
      : `Free until ${formatMinutes(status.until)} (${fmtDuration(status.minsFree)})`;
  } else {
    detail = `Busy until ${formatMinutes(status.until)}`;
  }
  const li = h('li', { class: `room ${free ? 'is-free' : 'is-busy'}`, 'data-room': room.id },
    h('div', { class: 'room-head' },
      h('span', { class: 'room-id' }, showBuilding ? room.id : room.room, capacityTag(room)),
      h('span', { class: 'badge' }, h('span', { class: 'badge-ico', 'aria-hidden': 'true' }, free ? '✓' : '■'), free ? 'Free' : 'Busy'),
    ),
    h('p', { class: 'room-detail' }, detail),
    !free && status.busy?.label ? h('p', { class: 'room-class' }, `In class: ${status.busy.label}`) : null,
    free && status.next?.label ? h('p', { class: 'room-class' }, `Next: ${status.next.label} at ${formatMinutes(status.next.start)}`) : null,
    strip(room, ctx.dateStr, ctx.weekday, ctx.minutes),
  );
  if (showBuilding) {
    const b = state.data.buildings[room.building];
    li.insertBefore(h('p', { class: 'room-bldg' }, b?.name || room.building), li.children[1]);
  }
  const photo = photoButton(room);
  if (photo) { li.classList.add('has-photo'); li.append(photo); }
  return li;
}

function axis() {
  const hours = [8, 12, 16, 20];
  const span = STRIP_END - STRIP_START;
  const el = h('div', { class: 'axis', 'aria-hidden': 'true' });
  for (const hr of hours) {
    const s = h('span', null, String(hr));
    s.style.left = `${(hr * 60 - STRIP_START) / span * 100}%`;
    el.append(s);
  }
  return el;
}

/* ---------- panel ---------- */
function renderPanel() {
  const panel = $('panel');
  const date = currentDate();
  const parts = torontoParts(date);
  const ctx = { dateStr: parts.dateStr, weekday: parts.weekday, minutes: parts.minutes };
  const kids = [];

  if (state.view === 'list') {
    kids.push(...listView(date, ctx));
  } else if (state.view === 'usage') {
    kids.push(...usageView(ctx));
  } else if (layers?.selectedLibrary()) {
    kids.push(...layers.libraryView());
  } else if (state.selected) {
    kids.push(...buildingView(date, ctx));
  } else {
    kids.push(...overviewView(date), ...(layers?.overviewSections() || []));
  }
  panel.replaceChildren(...kids.filter(Boolean));

  if (state.highlightRoom) {
    const row = [...panel.querySelectorAll('.room')].find((n) => n.dataset.room === state.highlightRoom);
    if (row) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    state.highlightRoom = null;
  }
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function overviewView(date) {
  const sum = summarizeByBuilding(state.rooms, date);
  let free = 0, total = 0;
  for (const s of Object.values(sum)) { free += s.free; total += s.total; }
  return [
    h('h2', { class: 'panel-title' }, `${free} of ${total} rooms free`),
    h('p', { class: 'panel-sub' }, 'Select a building on the map, or use search. Darker green means more of its rooms are free.'),
    legend(),
    h('button', { type: 'button', class: 'linkish', onclick: () => setView('list') }, 'See the list of free rooms'),
    offCampusList(sum),
  ];
}

function offCampusList(sum) {
  if (!offCampus.size) return null;
  const items = [...offCampus].sort((a, b) => a[1] - b[1]).map(([code, km]) => {
    const b = state.data.buildings[code], s = sum[code] || { free: 0, total: 0 };
    return h('li', null, h('button', {
      type: 'button', class: 'off-btn', onclick: () => selectBuilding(code, { pan: true }),
    }, h('b', null, code), ` ${b.name || ''}`, h('span', { class: 'off-n' }, `${s.free}/${s.total} free, ${Math.round(km)} km away`)));
  });
  return h('section', { class: 'offcampus', 'aria-label': 'Buildings away from the main campus' },
    h('h3', null, 'Away from the main campus'),
    h('p', null, 'These are not on the map view above; pick one to jump there.'),
    h('ul', null, items));
}

function legend() {
  const g = h('div', { class: 'legend' },
    h('div', { class: 'legend-bar', 'aria-hidden': 'true' }),
    h('div', { class: 'legend-lbl' }, h('span', null, 'None free (dashed outline)'), h('span', null, 'All free')),
    h('p', { class: 'legend-note' }, 'Each building also shows its count, free rooms over total rooms. Rooms with no scheduled classes at all are not listed.'),
  );
  g.querySelector('.legend-bar').style.background = `linear-gradient(90deg, ${lerpColor(0)}, ${lerpColor(1)})`;
  return g;
}

function buildingView(date, ctx) {
  const code = state.selected;
  const b = state.data.buildings[code] || {};
  const bName = b.name || FALLBACK_BUILDING_NAMES[code];
  const rooms = (state.roomsByBuilding.get(code) || []).slice()
    .sort((a, c) => a.room.localeCompare(c.room, 'en', { numeric: true }));
  const rows = rooms.map((r) => ({ r, s: roomStatus(r, date) }));
  const freeCount = rows.filter((x) => x.s.free).length;
  const shown = rows.filter((x) => passes(x.s));
  const out = [
    h('button', { type: 'button', class: 'back', onclick: () => selectBuilding(null) }, '← All buildings'),
    h('h2', { class: 'panel-title' }, h('span', { class: 'code' }, code), bName && bName !== code ? ` ${bName}` : ''),
    h('p', { class: 'panel-sub' }, rows.length
      ? `${freeCount} of ${rows.length} rooms free${state.minFree !== 'all' && state.minFree > 0 ? `; ${shown.length} free for ${fmtDuration(state.minFree)}+` : ''}`
      : 'No timetabled classrooms are listed for this building.'),
    layers?.buildingSpots(code),
  ];
  if (offCampus.has(code)) {
    out.push(h('p', { class: 'far-note' }, `About ${Math.round(offCampus.get(code))} km from the main Waterloo campus.`));
  }
  if (!rows.length) {
    // nothing to list: the study spots above are the useful part
  } else if (!shown.length) {
    out.push(h('p', { class: 'empty' }, 'No rooms match this filter at this time. Try "All rooms" or a different time.'));
  } else {
    out.push(axis(), h('ul', { class: 'rooms' }, shown.map(({ r, s }) => roomRow(r, s, ctx))));
  }
  return out;
}

function listView(date, ctx) {
  const rows = [];
  for (const r of state.rooms) {
    const s = roomStatus(r, date);
    if (!s.free) continue;
    if (state.minFree !== 'all' && state.minFree > 0 && !passes(s)) continue;
    rows.push({ r, s });
  }
  rows.sort((a, b) => {
    const am = a.s.minsFree === null ? Infinity : a.s.minsFree;
    const bm = b.s.minsFree === null ? Infinity : b.s.minsFree;
    return bm - am || a.r.id.localeCompare(b.r.id, 'en', { numeric: true });
  });
  const title = state.live ? 'Free rooms now' : `Free rooms at ${prettyDay(ctx.dateStr)}, ${formatMinutes(ctx.minutes)}`;
  const out = [
    h('h2', { class: 'panel-title' }, title),
    h('p', { class: 'panel-sub' }, `${rows.length} rooms, longest free stretch first.`),
  ];
  if (!rows.length) {
    out.push(h('p', { class: 'empty' }, 'No free rooms match. Try a shorter minimum or another time.'));
    return out;
  }
  const part = rows.slice(0, state.listShown);
  out.push(axis(), h('ul', { class: 'rooms' }, part.map(({ r, s }) => {
    const li = roomRow(r, s, ctx, { showBuilding: true });
    li.classList.add('clickable');
    li.tabIndex = 0;
    const go = () => { setView('map'); selectBuilding(r.building, { pan: true, room: r.id }); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    if (!li.classList.contains('has-photo')) li.setAttribute('role', 'button'); // a photo button inside a role=button row would nest controls
    return li;
  })));
  if (rows.length > part.length) {
    out.push(h('button', { type: 'button', class: 'more', onclick: () => { state.listShown += LIST_CAP; renderPanel(); } },
      `Show ${Math.min(LIST_CAP, rows.length - part.length)} more (${rows.length - part.length} left)`));
  }
  return out;
}

/* ---------- busiest and freest rooms (weekly) ---------- */
function usageSection(title, sub, entries, availableMinutes) {
  const items = entries.map(({ room, hours, percent }, i) => {
    const b = state.data.buildings[room.building];
    const li = h('li', { class: 'usage-row clickable', tabindex: '0' },
      h('div', { class: 'usage-head' },
        h('span', { class: 'usage-rank', 'aria-hidden': 'true' }, String(i + 1)),
        h('span', { class: 'room-id' }, room.id, capacityTag(room)),
        h('span', { class: 'usage-hours' }, `${hours} h`)),
      h('p', { class: 'room-bldg' }, b?.name || room.building),
      h('div', { class: 'usage-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${percent}%` })),
      h('p', { class: 'usage-pct' }, `${percent}% of ${availableMinutes / 60} h in class`));
    const photo = photoButton(room);
    if (photo) { li.classList.add('has-photo'); li.append(photo); }
    const go = () => { setView('map'); selectBuilding(room.building, { pan: true, room: room.id }); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    if (!li.classList.contains('has-photo')) li.setAttribute('role', 'button');
    return li;
  });
  return h('section', { class: 'usage-sec', 'aria-label': title },
    h('h3', null, title), h('p', { class: 'layer-note' }, sub), h('ol', { class: 'usage-list' }, items));
}

function usageView(ctx) {
  const { dates, availableMinutes, rows } = weeklyUsage(state.rooms, ctx.dateStr);
  const { busiest, freest, idle } = topAndBottom(rows, USAGE_TOP);
  const span = `${prettyDay(dates[0])} to ${prettyDay(dates[dates.length - 1])}`;
  const out = [
    h('h2', { class: 'panel-title' }, 'Busiest and freest rooms'),
    h('p', { class: 'panel-sub' }, `Hours in scheduled class, ${span}, 08:00-22:00 (${availableMinutes / 60} h). Follows the day picked above.`),
    usageSection(`Top ${USAGE_TOP} busiest`, 'Most scheduled class time this week.', busiest, availableMinutes),
    usageSection(`Top ${USAGE_TOP} freest`, 'Least scheduled class time this week.', freest, availableMinutes),
  ];
  const notes = [];
  if (idle > 0) notes.push(`${idle} room${idle === 1 ? ' has' : 's have'} no scheduled class at all this week${idle > USAGE_TOP ? `, so the freest list is a tie; it shows the first ${USAGE_TOP} by room number` : ''}.`);
  notes.push('Every timetabled room counts, including small seminar rooms and labs; room size is not in the data. Ad-hoc bookings and exams are not included.');
  out.push(h('p', { class: 'usage-note' }, notes.join(' ')));
  return out;
}

/* ---------- selection + view ---------- */
function panTo(latlng, far) {
  if (far) map.setView(latlng, 17, { animate: false });
  else map.flyTo(latlng, Math.max(map.getZoom(), 17), { animate: !reducedMotion(), duration: 0.6 });
}

function selectBuilding(code, opts = {}) {
  state.selected = code;
  state.highlightRoom = opts.room || null;
  layers?.clearLibrary();
  if (code) {
    if (opts.openSpots) layers?.wantSpotsOpen(code);
    // Study spots load the first time a building is opened (a same-site file, not the live feed).
    if (layers && !layers.spotsLoaded()) layers.ensureSpots().then((ok) => { if (ok && state.selected === code) render({ keepFocus: true }); });
  }
  if (code && state.view !== 'map') setView('map', { keepSelection: true });
  if (code && opts.pan) {
    const l = bLayers.get(code);
    const ll = l ? l.label.getLatLng() : (layers?.spotCoords(code) ? L.latLng(layers.spotCoords(code)) : null);
    if (ll) panTo(ll, offCampus.has(code));
  }
  if (!code && campusBounds && !map.getBounds().intersects(campusBounds)) fitCampus();
  render();
  if (opts.openSpots) $('panel').scrollTop = 0;
  if (code && window.matchMedia('(max-width: 819px)').matches) {
    $('panel').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
}

function setView(view, opts = {}) {
  state.view = view;
  state.listShown = LIST_CAP;
  document.body.dataset.view = view;
  document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (view === 'map') setTimeout(() => { if (!map) return; map.invalidateSize(); if (!mapMoved) fitCampus(); }, 0);
  if (!opts.keepSelection && view === 'list') { /* selection kept but hidden */ }
  render();
}

/* ---------- search ---------- */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function searchResults(q) {
  const nq = norm(q);
  if (!nq) return [];
  const out = [];
  for (const [code, b] of Object.entries(state.data.buildings || {})) {
    const c = norm(code), n = norm(b.name || '');
    const score = c === nq ? 0 : c.startsWith(nq) ? 1 : n.startsWith(nq) ? 2 : n.includes(nq) ? 3 : -1;
    if (score >= 0) out.push({ kind: 'building', code, text: `${code}  ${b.name || ''}`, score });
  }
  for (const r of state.rooms) {
    const id = norm(r.id);
    if (id === nq) out.push({ kind: 'room', room: r, text: r.id, score: 0 });
    else if (id.startsWith(nq)) out.push({ kind: 'room', room: r, text: r.id, score: 4 });
    else if (norm(r.room).startsWith(nq) || (nq.length >= 3 && id.includes(nq))) out.push({ kind: 'room', room: r, text: r.id, score: 5 });
  }
  out.sort((a, b) => a.score - b.score || a.text.localeCompare(b.text, 'en', { numeric: true }));
  return out.slice(0, 8);
}

function initSearch() {
  const q = $('q'), list = $('q-results');
  let items = [], active = -1;
  const close = () => { list.hidden = true; q.setAttribute('aria-expanded', 'false'); active = -1; q.removeAttribute('aria-activedescendant'); };
  const choose = (it) => {
    close();
    if (it.kind === 'building') { q.value = it.code; selectBuilding(it.code, { pan: true }); }
    else { q.value = it.room.id; selectBuilding(it.room.building, { pan: true, room: it.room.id }); }
  };
  const paint = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = h('li', { role: 'option', id: `qr-${i}`, 'aria-selected': String(i === active), class: i === active ? 'active' : '' },
        h('span', { class: 'r-kind' }, it.kind === 'building' ? 'Building' : 'Room'), ` ${it.text}`);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
      return li;
    }));
    if (!items.length) list.replaceChildren(h('li', { class: 'none', role: 'option', 'aria-disabled': 'true' }, 'No matching building or room'));
    list.hidden = false;
    q.setAttribute('aria-expanded', 'true');
    if (active >= 0) q.setAttribute('aria-activedescendant', `qr-${active}`); else q.removeAttribute('aria-activedescendant');
  };
  q.addEventListener('input', () => {
    if (!q.value.trim()) return close();
    items = searchResults(q.value); active = -1; paint();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter') { const it = items[active >= 0 ? active : 0]; if (it && !list.hidden) { e.preventDefault(); choose(it); } }
    else if (e.key === 'Escape') close();
  });
  q.addEventListener('blur', close);
}

/* ---------- time controls ---------- */
function initControls() {
  const dateIn = $('date-in'), timeIn = $('time-in'), slider = $('slider'), nowBtn = $('now-btn');
  const toCustom = () => { state.live = false; };
  dateIn.addEventListener('change', () => { if (!dateIn.value) return; toCustom(); state.dateStr = dateIn.value; render(); });
  timeIn.addEventListener('change', () => {
    if (!timeIn.value) return;
    toCustom();
    const [hh, mm] = timeIn.value.split(':').map(Number);
    state.minutes = hh * 60 + mm;
    render();
  });
  slider.addEventListener('input', () => { toCustom(); state.minutes = Number(slider.value); render(); });
  const tt = $('time-toggle');
  tt.addEventListener('click', () => {
    const open = document.querySelector('.when').classList.toggle('open');
    tt.setAttribute('aria-expanded', String(open));
  });
  nowBtn.addEventListener('click', () => { state.live = true; syncFromNow(); render(); });
  document.querySelectorAll('input[name="minfree"]').forEach((r) => r.addEventListener('change', () => {
    state.minFree = r.value === 'all' ? 'all' : Number(r.value);
    state.listShown = LIST_CAP;
    render();
  }));
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
}

// The regular class period: the most common start and end dates in the data (a few special sections
// start earlier or finish later). Falls back to the stated term dates.
let _classRange;
function classRange() {
  if (_classRange !== undefined) return _classRange;
  const starts = new Map(), ends = new Map();
  for (const r of state.rooms) {
    for (const list of Object.values(r.busy || {})) {
      for (const iv of list) {
        if (iv[2]) starts.set(iv[2], (starts.get(iv[2]) || 0) + 1);
        if (iv[3]) ends.set(iv[3], (ends.get(iv[3]) || 0) + 1);
      }
    }
  }
  const mode = (m) => [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
  const d = state.data;
  const lo = mode(starts) || d.term_start, hi = mode(ends) || d.term_end;
  _classRange = lo && hi ? [lo, hi] : null;
  return _classRange;
}

function renderControls() {
  if (state.live) syncFromNow();
  const dateIn = $('date-in'), timeIn = $('time-in'), slider = $('slider');
  if (document.activeElement !== dateIn) dateIn.value = state.dateStr;
  if (document.activeElement !== timeIn) timeIn.value = formatMinutes(state.minutes);
  if (document.activeElement !== slider) slider.value = String(Math.min(Math.max(state.minutes, +slider.min), +slider.max));
  $('now-btn').setAttribute('aria-pressed', String(state.live));
  $('when-label').textContent = `${prettyDay(state.dateStr)}, ${formatMinutes(state.minutes)}`;
  $('when-sub').textContent = state.live ? 'Now, Toronto time' : 'Chosen time, Toronto time';
  $('view-list').textContent = state.live ? 'Free rooms now' : 'Free rooms then';

  const notes = [];
  const d = state.data;
  const rng = classRange();
  if (rng && (state.dateStr < rng[0] || state.dateStr > rng[1])) {
    notes.push(`This day is outside the regular class period (${prettyDay(rng[0])} to ${prettyDay(rng[1])}), so few or no classes are scheduled and most rooms show as free.`);
  }
  if (state.minutes < 7 * 60 || state.minutes >= 22 * 60) notes.push('Outside usual class hours; buildings may be locked.');
  const note = $('when-note');
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');
}

/* ---------- render loop ---------- */
const focusables = (root) => [...root.querySelectorAll('button, a[href], summary, input, [tabindex="0"]')];

// keepFocus is for renders nobody asked for (clock tick, live data arriving): keep keyboard focus on
// the same control instead of letting it fall back to the page.
function render({ keepFocus = false } = {}) {
  const panel = $('panel');
  const idx = keepFocus && panel.contains(document.activeElement) ? focusables(panel).indexOf(document.activeElement) : -1;
  renderControls();
  updateMap();
  layers?.update();
  renderPanel();
  if (idx >= 0) focusables(panel)[idx]?.focus({ preventScroll: true });
}

/* ---------- boot ---------- */
async function boot() {
  try {
    state.data = await loadData();
  } catch (e) {
    $('panel').replaceChildren(h('h2', { class: 'panel-title' }, 'Could not load room data'),
      h('p', { class: 'empty' }, `${e.message}. Run scripts/build_site_data.py or scripts/make_demo_rooms.py, then reload.`));
    return;
  }
  state.rooms = state.data.rooms;
  try { state.photos = cleanManifest(await loadJson('data/room_photos.json')); } catch { /* photos are optional */ }
  try { state.sizes = cleanSizes(await loadJson('data/room_sizes.json')); } catch { /* estimates are optional */ }
  for (const r of state.rooms) {
    if (!state.roomsByBuilding.has(r.building)) state.roomsByBuilding.set(r.building, []);
    state.roomsByBuilding.get(r.building).push(r);
  }
  $('demo-banner').hidden = !state.data.demo;
  document.body.classList.toggle('is-demo', !!state.data.demo);
  syncFromNow();
  initControls();
  initSearch();
  initMap();
  layers = initLayers({
    h, $, state, bLayers,
    getMap: () => map,
    currentDate,
    classRange,
    loadJson,
    render,
    setView,
    selectBuilding,
    panTo,
    isOffCampus: (code) => offCampus.has(code),
    reducedMotion,
  });
  render();
  // Markers' DOM elements exist after first add; paint labels again once Leaflet has laid them out.
  requestAnimationFrame(updateMap);

  let lastKey = '';
  setInterval(() => {
    if (!state.live) return;
    const p = torontoParts(new Date());
    const key = `${p.dateStr} ${p.minutes}`;
    if (key !== lastKey) { lastKey = key; render({ keepFocus: true }); }
  }, 15000);
}

boot();
