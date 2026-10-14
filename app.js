// world timeline: equal earth map + log-scale timeline. no dependencies.

const MIN_YEAR = -5000, MAX_YEAR = 2025, PRESENT = 2050;
const PACE = 0.055;          // playback, in log-years per second at 1× (see the time scale)
const SPEEDS = [0.5, 1, 2, 4];
const LINGER = 0.16;         // how long a pin stays (fading) after its event ends, in log-years
const NOTIFY_WEIGHT = 80;    // sitelinks an event needs to pop a notification
const NOTE_MS = 7000, FEATURE_MS = 9000; // how long a note stays (playback time)
const FEATURE_WEIGHT = 150;  // sitelinks that make an event a guided stop (or importance 1)
const BEAT_S = 4.5;          // a focus picks one note for about every this many seconds
const TRANSITION_MS = 900, FEATHER = 6;
const MAX_ZOOM = 60;
const REALMS = 10;           // realm tints, --realm-0 … --realm-9 in style.css
const SERIF = '"EB Garamond", "Iowan Old Style", Georgia, serif';

// oceans and seas, lettered like an atlas: [name, lon, lat, zoom they appear at]
const WATERS = [
  ["Pacific Ocean", -135, 8, 0.8], ["Pacific Ocean", 168, 20, 0.8], ["Atlantic Ocean", -38, 27, 0.8],
  ["Atlantic Ocean", -16, -24, 1.6], ["Indian Ocean", 78, -22, 0.8],
  ["Mediterranean Sea", 18, 34.2, 2.2], ["Caribbean Sea", -76, 14.5, 2.2], ["Arabian Sea", 63, 14.5, 2.2],
  ["Gulf of Mexico", -90, 25, 2.6], ["Bay of Bengal", 88.5, 14.5, 2.6], ["South China Sea", 114, 13, 2.6],
  ["Hudson Bay", -86, 59.5, 3], ["Bering Sea", -177, 58, 3], ["Philippine Sea", 133, 20, 3],
  ["Coral Sea", 155, -17, 3], ["Tasman Sea", 161, -40, 3], ["Gulf of Guinea", 3, 1.5, 3.5],
  ["Sea of Japan", 134.5, 40.5, 3.5], ["North Sea", 3.5, 56, 4], ["Black Sea", 34.5, 43.3, 4],
  ["Baltic Sea", 19.5, 57.5, 5], ["Caspian Sea", 50.5, 42, 5], ["Red Sea", 38.5, 20.5, 6],
];

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  year: 1453,
  pos: 0,               // timeline position 0..1; the year is derived from it
  snapshots: [],        // available border years
  borders: new Map(),   // year -> promise of prepared features
  wanted: null,         // snapshot year we're loading / showing
  shown: null,          // features currently drawn
  events: [],           // heaviest first
  pins: [],             // pins drawn last frame, for hit testing
  hoverEvent: null,
  playing: false,
  speed: 1,
  notes: [],
  queue: [],            // events waiting for a free note
  ghosts: [],           // notes fading out: they keep their space until gone
  ease: 1,              // playback slows while there's something to read
  guided: true,         // guided playback: fly to the biggest moments (story.js)
  stop: null,           // the guided stop in progress
  focus: null,          // the focus being played (story.js)
  flight: null,         // a camera flight (story.js)
  userAt: -1e9,         // when the user last moved the map
  selected: null,       // event shown in the card
  selectedRealm: null,  // or territory
  hoverRealm: null,
  hoverLabel: null,
  labelHits: [],        // realm names drawn last render: { box, f }
  transition: null,
};
const view = { k: 1, x: 0, y: 0 };
// the 3d globe (globe.js): centre longitude and latitude in degrees, and zoom
const globe = { on: false, lon: 10, lat: 25, k: 1, goalK: null };

// --- projection (equal earth, šavrič et al. 2018) ---------------------------

const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
function project(lon, lat) {
  const l = (lon * Math.PI) / 180, t = Math.asin(M * Math.sin((lat * Math.PI) / 180));
  const t2 = t * t, t6 = t2 * t2 * t2;
  return [
    (l * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
    -t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
  ];
}
// the map's extent: full width, and from northern greenland down to tierra del fuego
// (antarctica isn't drawn)
const HALF_W = project(180, 0)[0], TOP = project(0, 84)[1], BOTTOM = project(0, -57)[1];

// --- time scale -------------------------------------------------------------
// the timeline is linear. everything that should feel the same in any era (playback
// speed, how long pins linger, scrolling to scrub) runs in "log-years" instead: the
// log of years before PRESENT, in which a century of antiquity and a decade of the
// 20th century are about the same size, matching how densely history is recorded

const lg = (y) => Math.log(PRESENT - y);
const toPos = (y) => (y - MIN_YEAR) / (MAX_YEAR - MIN_YEAR);
const toYear = (p) => MIN_YEAR + p * (MAX_YEAR - MIN_YEAR);
const lgShift = (y, d) => PRESENT - (PRESENT - y) * Math.exp(-d); // d log-years later
const stepAt = (y) => (y < 0 ? 10 : 1);

function roundYear(y) {
  const step = stepAt(y), r = Math.round(y / step) * step;
  return clamp(r === 0 ? 1 : r, MIN_YEAR, MAX_YEAR);
}
const fmt = (y) => (y < 0 ? `${(-y).toLocaleString()} BCE` : y < 1000 ? `${y} CE` : `${y}`);

// --- data --------------------------------------------------------------------

function hash(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function prepare(geojson) {
  const feats = geojson.features.map(({ properties: p, geometry }) => {
    const path = new Path2D(), box = [Infinity, Infinity, -Infinity, -Infinity];
    const geo = new Path2D(), geoBox = [Infinity, Infinity, -Infinity, -Infinity], rings = []; // for the globe
    let best = { area: 0 };
    for (const poly of geometry.coordinates) {
      poly.forEach((ring, i) => {
        let area = 0, cx = 0, cy = 0, prev = null, glon = 0, glat = 0;
        const flat = new Float32Array(ring.length * 2);
        ring.forEach(([lon, lat], j) => {
          flat[2 * j] = lon;
          flat[2 * j + 1] = lat;
          j ? geo.lineTo(lon, -lat) : geo.moveTo(lon, -lat);
          geoBox[0] = Math.min(geoBox[0], lon); geoBox[1] = Math.min(geoBox[1], -lat);
          geoBox[2] = Math.max(geoBox[2], lon); geoBox[3] = Math.max(geoBox[3], -lat);
          glon += lon;
          glat += lat;
        });
        geo.closePath();
        rings.push(flat);
        for (const [lon, lat] of ring) {
          const pt = project(lon, lat);
          box[0] = Math.min(box[0], pt[0]); box[1] = Math.min(box[1], pt[1]);
          box[2] = Math.max(box[2], pt[0]); box[3] = Math.max(box[3], pt[1]);
          if (prev) {
            const cross = prev[0] * pt[1] - pt[0] * prev[1];
            area += cross; cx += (prev[0] + pt[0]) * cross; cy += (prev[1] + pt[1]) * cross;
            path.lineTo(...pt);
          } else path.moveTo(...pt);
          prev = pt;
        }
        path.closePath();
        if (i === 0 && Math.abs(area) > best.area) {
          best = { area: Math.abs(area) / 2, x: cx / (3 * area), y: cy / (3 * area), geo: [glon / ring.length, glat / ring.length] };
        }
      });
    }
    return { name: p.name, subject: p.subject, wiki: p.wiki, rough: p.precision === 1, path, box, geo, geoBox, rings, label: best, realm: p.name ? hash(p.name) % REALMS : null };
  });
  feats.coast = new Path2D(); // every outline at once, for the water lines
  feats.geoCoast = new Path2D();
  for (const f of feats) {
    feats.coast.addPath(f.path);
    feats.geoCoast.addPath(f.geo);
  }
  return feats;
}

async function loadBorders(year) {
  if (!state.borders.has(year)) {
    state.borders.set(year, fetch(`data/borders/${year}.json`).then((r) => r.json()).then(prepare));
  }
  return state.borders.get(year);
}

const snapshotFor = (y) => state.snapshots.filter((s) => s <= y).at(-1) ?? state.snapshots[0];

// curated events win over their wikidata twins, but borrow their sitelinks as weight
const article = (url) => url && decodeURIComponent(url).toLowerCase();
function mergeEvents(curated, wikidata) {
  const twins = new Map(wikidata.filter((e) => e.wiki).map((e) => [article(e.wiki), e]));
  for (const e of curated) {
    const twin = twins.get(article(e.wiki));
    if (twin) { e.sitelinks ??= twin.sitelinks; twin.dup = true; }
  }
  const events = [...curated, ...wikidata.filter((e) => !e.dup)];
  for (const e of events) {
    // fewer languages write about the ancient world, so sitelinks count for more the older
    // the event (the same scale as ERA in pipeline/wikidata.py)
    e.weight = e.sitelinks ? e.sitelinks / (e.start < 500 ? 0.35 : e.start < 1500 ? 0.65 : 1) : { 1: 150, 2: 70, 3: 30 }[e.importance];
    e.endLg = lg(e.end ?? e.start);
  }
  return events.sort((a, b) => b.weight - a.weight);
}

// --- view: smooth zoom, inertial pan, pinch ------------------------------------

let dpr = 1, base = { s: 1, x: 0, y: 0 }, minZoom = 1;
let goal = null;   // view we're easing toward (wheel / double-click zoom)
let fling = null;  // pan velocity after a drag, px/s

function resize() {
  dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const h = innerHeight - (innerWidth < 600 ? 110 : 90), pad = 16;
  const fitW = (innerWidth - pad * 2) / (HALF_W * 2), fitH = (h - pad * 2) / (BOTTOM - TOP);
  // a phone held upright would show a thin strip of world: start zoomed in on the
  // old world instead, filling more of the height, and let it zoom out to fit
  const s = fitW < fitH * 0.75 ? fitH * 0.75 : Math.min(fitW, fitH);
  minZoom = Math.min(1, fitW / s);
  base = { s, x: innerWidth / 2, y: h / 2 + 8 - (s * (TOP + BOTTOM)) / 2 };
  if (minZoom < 1 && view.k === 1 && view.x === 0) view.x = -project(20, 0)[0] * s; // centre on europe/africa
  clampView(view);
  layerDirty = true;
  coastAt = null;
  viewChanged();
}

// keep the point under the middle of the screen on the map
function clampView(v) {
  const s = base.s * v.k, cx = innerWidth / 2 - base.x, cy = innerHeight / 2 - base.y;
  v.x = clamp(v.x, cx - HALF_W * s, cx + HALF_W * s);
  v.y = clamp(v.y, cy - BOTTOM * s, cy - TOP * s);
  return v;
}

function viewChanged() {
  state.transition = null; // transitions are rasterised in screen space
  lastMove = performance.now();
  if (state.ghosts.length) { // fading notes can't follow the map
    for (const el of document.querySelectorAll(".note.out")) el.remove();
    state.ghosts = [];
  }
  invalidate();
}

function zoomAt(sx, sy, factor, animate = true) {
  if (globe.on) {
    const k = clamp((globe.goalK ?? globe.k) * factor, 0.6, MAX_ZOOM);
    fling = null;
    if (animate) globe.goalK = k;
    else { globe.k = k; globe.goalK = null; }
    return viewChanged();
  }
  const g = { ...(goal ?? view) };
  const k = clamp(g.k * factor, minZoom, MAX_ZOOM), f = k / g.k;
  const ox = sx - base.x, oy = sy - base.y;
  g.x = ox - (ox - g.x) * f;
  g.y = oy - (oy - g.y) * f;
  g.k = k;
  if (k === minZoom) g.x = g.y = 0; // fully zoomed out: recenter
  clampView(g);
  fling = null;
  if (animate) goal = g;
  else { Object.assign(view, g); goal = null; }
  viewChanged();
}

function panBy(dx, dy) {
  if (globe.on) { // drag the surface: a pixel at the centre is 1/radius radians
    const r = globeRadius(), lat0 = globe.lat;
    globe.lon = ((globe.lon - (dx / r) * (180 / Math.PI) + 540) % 360) - 180;
    globe.lat = clamp(globe.lat + (dy / r) * (180 / Math.PI), -80, 80);
    return viewChanged();
  }
  view.x += dx;
  view.y += dy;
  clampView(view);
  viewChanged();
}

function stepView(dt) {
  if (globe.on && globe.goalK) {
    globe.k = Math.exp(Math.log(globe.k) + (Math.log(globe.goalK) - Math.log(globe.k)) * (1 - Math.exp(-dt * 14)));
    if (Math.abs(globe.goalK / globe.k - 1) < 1e-3) { globe.k = globe.goalK; globe.goalK = null; }
    viewChanged();
  }
  if (goal) {
    const a = 1 - Math.exp(-dt * 14);
    view.k = Math.exp(Math.log(view.k) + (Math.log(goal.k) - Math.log(view.k)) * a);
    view.x += (goal.x - view.x) * a;
    view.y += (goal.y - view.y) * a;
    if (Math.abs(goal.k / view.k - 1) < 1e-3 && Math.hypot(goal.x - view.x, goal.y - view.y) < 0.3) {
      Object.assign(view, goal);
      goal = null;
    }
    viewChanged();
  }
  if (fling) {
    const { x, y } = view;
    panBy(fling.vx * dt, fling.vy * dt);
    const decay = Math.exp(-dt * 4);
    fling.vx *= decay;
    fling.vy *= decay;
    const stuck = !globe.on && view.x === x && view.y === y;
    if (stuck || Math.hypot(fling.vx, fling.vy) < 15) fling = null;
  }
  return !!(goal || fling || globe.goalK);
}

function transform() {
  const s = base.s * view.k;
  return [s * dpr, 0, 0, s * dpr, (base.x + view.x) * dpr, (base.y + view.y) * dpr];
}
// where a place is on screen, or null where the globe's far side hides it
const screenAt = (lon, lat, edge) => (globe.on ? globeScreen(lon, lat, edge) : toScreen(project(lon, lat)));
const pixelsPerUnit = () => (globe.on ? globeRadius() : base.s * view.k); // per projected unit near the centre
const toScreen = ([px, py]) => {
  const s = base.s * view.k;
  return [base.x + view.x + px * s, base.y + view.y + py * s];
};

// --- border transitions ------------------------------------------------------------
// when the snapshot changes, territory doesn't pop. both maps are rasterised and
// every pixel that changes colour flips once the "front" of its new owner reaches
// it. fronts start from the owner's old territory and advance at one speed, so
// growing empires spread outward and shrinking ones get eaten from the edges.
// renamed realms cross-fade in place (see startTransition).

// land only, on a cpu canvas we read back. the sea stays transparent: the cached
// water lines go underneath, since wide strokes are slow to raster
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

function paintFills(feats) {
  const s = base.s * view.k;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, work.width, work.height);
  wctx.setTransform(s, 0, 0, s, base.x + view.x, base.y + view.y);
  paintLand(wctx, feats, false);
  return wctx.getImageData(0, 0, work.width, work.height).data;
}



function startTransition(from, to) {
  const prev = state.transition;
  const W = innerWidth, H = innerHeight, n = W * H;
  if (!prev || work.width !== W || work.height !== H) { work.width = W; work.height = H; }
  // mid-flight: continue from whatever is on screen right now
  const a = prev ? prev.out.data.slice() : paintFills(from);
  const b = paintFills(to);
  const A = new Uint32Array(a.buffer), B = new Uint32Array(b.buffer);

  // polities get renamed between snapshots (mongol empire -> great khanate), so
  // each new colour's predecessor is the old colour it mostly sits on. where a
  // pixel goes from predecessor to successor it's the same realm: cross-fade it,
  // and let the realm's growth spread out from there
  const overlap = new Map();
  for (let y = 1; y < H; y += 3) {
    for (let i = y * W + 1, end = i + W - 1; i < end; i += 3) {
      let m = overlap.get(B[i]);
      if (!m) overlap.set(B[i], (m = new Map()));
      m.set(A[i], (m.get(A[i]) ?? 0) + 1);
    }
  }
  const pred = new Map();
  for (const [c, m] of overlap) pred.set(c, [...m].reduce((a, b) => (b[1] > a[1] ? b : a))[0]);

  // dist: 0 unchanged, -2 same realm (fades), -1 changing hands (waits for a front)
  const dist = new Int32Array(n), queue = new Int32Array(n), seeded = new Uint8Array(n);
  const changed = [];
  for (let i = 0; i < n; i++) {
    if (A[i] !== B[i]) { dist[i] = pred.get(B[i]) === A[i] ? -2 : -1; changed.push(i); }
  }
  if (!changed.length) { state.transition = null; return; }

  const nb = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  let qt = 0;
  for (const i of changed) {
    if (dist[i] !== -1) continue;
    for (const o of nb) {
      const j = i + o;
      if (j >= 0 && j < n && dist[j] !== -1 && !seeded[j]) { seeded[j] = 1; queue[qt++] = j; }
    }
  }
  // breadth-first from settled pixels, only into pixels that become their colour
  let maxD = 0;
  const flood = (qh, same) => {
    for (; qh < qt; qh++) {
      const i = queue[qh], c = B[i], d = Math.max(0, dist[i]) + 1, x = i % W;
      for (const o of nb) {
        const j = i + o;
        if (j < 0 || j >= n || dist[j] !== -1 || (same && B[j] !== c)) continue;
        const jx = j % W;
        if (jx - x > 1 || x - jx > 1) continue; // wrapped round a row edge
        dist[j] = d;
        queue[qt++] = j;
        if (d > maxD) maxD = d;
      }
    }
  };
  flood(0, true);
  // whatever's left was taken by an outsider: sweep it in from neighbouring land.
  // only realms appearing from nothing (or across the sea) still fade in
  const sweep = qt;
  for (const i of changed) {
    if (dist[i] !== -1) continue;
    for (const o of nb) {
      const j = i + o;
      if (j < 0 || j >= n || dist[j] === -1 || seeded[j] === 2 || B[j] === 0) continue; // 0: open sea
      seeded[j] = 2;
      queue[qt++] = j;
    }
  }
  flood(sweep, false);

  const fast = state.playing ? 1 / Math.sqrt(state.speed) : 1;
  if (!coastAt || coastAt.view.k !== view.k || !coastCovers()) renderCoast(from); // the water lines underneath
  state.transition = {
    a, b, dist, changed: Int32Array.from(changed), maxD,
    out: new ImageData(b.slice(), W, H),
    from: prev?.to ?? from, to,
    start: performance.now(), dur: TRANSITION_MS * fast,
  };
}

function composite(tr, t) {
  const { a, b, dist, changed } = tr, O = tr.out.data, front = t * (tr.maxD + FEATHER);
  for (let n = 0; n < changed.length; n++) {
    const i = changed[n], d = dist[i], o = i * 4;
    const m = d < 0 ? t : clamp((front - d) / FEATHER, 0, 1);
    O[o] = a[o] + (b[o] - a[o]) * m;
    O[o + 1] = a[o + 1] + (b[o + 1] - a[o + 1]) * m;
    O[o + 2] = a[o + 2] + (b[o + 2] - a[o + 2]) * m;
    O[o + 3] = a[o + 3] + (b[o + 3] - a[o + 3]) * m;
  }
  wctx.putImageData(tr.out, 0, 0);
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const progress = (tr) => ease(Math.min(1, (performance.now() - tr.start) / tr.dur));

function showBorders(feats) {
  const tr = state.transition;
  // scrubbing fast through many snapshots: just swap, each transition costs a few frames
  if (globe.on) state.transition = null;
  else if (tr && performance.now() - tr.start < 120) state.transition = null;
  else if (state.shown && state.shown !== feats) startTransition(state.shown, feats);
  state.shown = feats;
  state.hoverRealm = state.hoverLabel = null;
  if (state.selectedRealm) state.selectedRealm = feats.find((f) => f.name === state.selectedRealm.name) ?? null;
  layerDirty = true;
  globeStale();
  invalidate();
}

// --- rendering -----------------------------------------------------------------

const dark = matchMedia("(prefers-color-scheme: dark)");
let colors = {};
function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const k of ["bg", "land", "line", "ink", "accent", "coast", "river", "halo", "badge"]) colors[k] = css.getPropertyValue(`--${k}`).trim();
  colors.realms = Array.from({ length: REALMS }, (_, i) => css.getPropertyValue(`--realm-${i}`).trim());
  colors.space = css.getPropertyValue("--space").trim();
  colors.kinds = Object.fromEntries(Object.keys(KIND_ICONS).map((k) => [k, css.getPropertyValue(`--k-${k}`).trim()]));
  layerDirty = true;
  if (typeof globeStale === "function") globeStale(true);
  coastAt = null;
}

let frame = 0, last = 0;
function invalidate() {
  if (!frame) frame = requestAnimationFrame(tick);
}
function tick(now) {
  frame = 0;
  const dt = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;
  let busy = stepPlay(dt);
  busy = stepFlight() || busy;
  busy = stepView(dt) || busy;
  busy = pumpNotes() || busy;
  if (state.transition && progress(state.transition) >= 1) state.transition = null;
  busy ||= !!state.transition || (globe.on && globeBusy());
  draw();
  if (busy) invalidate();
}

function visibleEvents() {
  const now = lg(state.year);
  return state.events.filter((e) => e.start <= state.year && e.start >= MIN_YEAR && e.endLg - now <= LINGER && inFocus(e));
}

const fillOf = (f) => (f.realm === null ? colors.land : colors.realms[f.realm]);

// --- physical geography ---------------------------------------------------------------
// shaded relief, rivers, lakes and the names of mountain ranges and deserts, from
// natural earth (see pipeline/physical.py). they load after the map and appear when ready

const physical = { relief: null, reliefGlobe: null, rivers: [], lakes: [], regions: [] };
const zoomLevel = () => pixelsPerUnit() / 260; // 1 = the whole world on a laptop screen

function boxOf(flat) {
  const box = [Infinity, Infinity, -Infinity, -Infinity], path = new Path2D(), geo = new Path2D();
  for (let i = 0; i < flat.length; i += 2) {
    const [x, y] = project(flat[i], flat[i + 1]);
    i ? path.lineTo(x, y) : path.moveTo(x, y);
    i ? geo.lineTo(flat[i], -flat[i + 1]) : geo.moveTo(flat[i], -flat[i + 1]);
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  return { path, box, geo };
}

async function loadPhysical() {
  const json = (name) => fetch(`data/physical/${name}.json`).then((r) => r.json());
  const [rivers, lakes, regions] = await Promise.all([json("rivers"), json("lakes"), json("regions")]);
  physical.rivers = rivers.map(([rank, name, pts]) => ({ rank, name, ...boxOf(pts) }));
  physical.lakes = lakes.map(([rank, pts]) => {
    const l = { rank, ...boxOf(pts) };
    l.path.closePath();
    l.geo.closePath();
    return l;
  });
  // natural earth's label levels, roughly: 2 shows the whole world, 5 a single country
  physical.regions = regions.map(([kind, name, level, [a, b]]) => ({ kind, name, zoom: 2 ** (level - 2.6), ga: a, gb: b }));
  layerDirty = true;
  invalidate();
  const img = new Image();
  img.src = "data/physical/relief.png";
  await img.decode();
  physical.relief = img;
  layerDirty = true;
  coastAt = null;
  invalidate();
  const flat = new Image(); // the same, in plain longitude and latitude, for the globe
  flat.src = "data/physical/relief-globe.png";
  await flat.decode();
  physical.reliefGlobe = flat;
  globeStale();
}

// the relief is a soft-light layer, neutral grey where flat, so it shades the
// realm tints without tinting them. expects the map transform
function paintRelief(c) {
  if (!physical.relief) return;
  c.save();
  c.globalCompositeOperation = "soft-light";
  c.globalAlpha = dark.matches ? 0.9 : 0.75;
  c.drawImage(physical.relief, -HALF_W, TOP, HALF_W * 2, BOTTOM - TOP);
  c.restore();
}

// lakes in the sea's colour and rivers in the water lines' ink. small rivers
// and lakes join in as you zoom. expects the map transform
function paintRivers(c) {
  const s = base.s * view.k, z = zoomLevel();
  const ranks = clamp(Math.floor(2.5 + 1.6 * Math.log2(Math.max(z, 0.5))), 1, 6);
  c.lineJoin = c.lineCap = "round";
  c.fillStyle = colors.bg;
  c.strokeStyle = colors.coast;
  c.lineWidth = 0.7 / s;
  for (const l of physical.lakes) {
    if (l.rank > ranks + 1 || !onScreen(l)) continue;
    c.fill(l.path);
    c.stroke(l.path);
  }
  c.strokeStyle = colors.river;
  for (const r of physical.rivers) {
    if (r.rank > ranks || !onScreen(r)) continue;
    c.lineWidth = clamp(1.7 - r.rank * 0.2, 0.6, 1.7) * Math.min(1, 0.6 + z * 0.4) / s;
    c.stroke(r.path);
  }
}

// ranges, deserts and plateaus, lettered along their length in spaced, faded ink,
// most important first and clear of the realm names (`placed`). an angled name is
// checked as a chain of small boxes along its baseline. expects a css-pixel transform
function drawRegions(c, placed) {
  const z = zoomLevel();
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = colors.ink;
  c.strokeStyle = colors.halo;
  c.lineWidth = 2.5;
  c.lineJoin = "round";
  for (const r of physical.regions) {
    if (z < r.zoom) continue;
    const a = screenAt(...r.ga, 0.25), b = screenAt(...r.gb, 0.25);
    if (!a || !b) continue;
    const [ax, ay] = a, [bx, by] = b;
    const mx = (ax + bx) / 2, my = (ay + by) / 2, len = Math.hypot(bx - ax, by - ay);
    if (mx < -200 || mx > innerWidth + 200 || my < -50 || my > innerHeight + 50) continue;
    const size = clamp(10.5 + Math.log2(z), 10.5, 14), text = r.kind === "desert" ? r.name : r.name.toUpperCase();
    c.font = `${r.kind === "range" ? "500" : "italic 400"} ${size}px ${SERIF}`;
    spaced(c, 0);
    const bare = c.measureText(text).width;
    if (len < bare * 0.7) continue; // the region is too small on screen for its name
    const gap = clamp((len * 0.85 - bare) / Math.max(1, text.length - 1), size * 0.12, size * 0.9);
    spaced(c, gap);
    let angle = Math.atan2(by - ay, bx - ax);
    if (angle > Math.PI / 2) angle -= Math.PI; // keep the lettering upright
    if (angle < -Math.PI / 2) angle += Math.PI;
    angle = clamp(angle, -1.1, 1.1);
    const width = bare + gap * (text.length - 1), steps = Math.ceil(width / size), h = size * 0.6;
    const chain = [];
    for (let i = 0; i <= steps; i++) {
      const d = (i / steps - 0.5) * width, x = mx + Math.cos(angle) * d, y = my + Math.sin(angle) * d;
      chain.push([x - h, y - h, x + h, y + h]);
    }
    if (chain.some((b) => placed.some((p) => overlaps(b, p)))) continue;
    placed.push(...chain);
    c.save();
    c.translate(mx, my);
    c.rotate(angle);
    c.globalAlpha = 0.5;
    c.strokeText(text, 0, 0);
    c.globalAlpha = 0.55;
    c.fillText(text, 0, 0);
    c.restore();
  }
  spaced(c, 0);
}

// water lines: thin rings following every coast, as on an engraved map. each
// ring is a wide stroke in ink with a stroke 1px narrower in sea colour on top;
// then a little shading along the shore. expects the map transform to be set
// zoomed in, most of the world is off screen: skip it. `pad` covers the water lines
function onScreen(f, pad = 24) {
  const s = base.s * view.k, x = base.x + view.x, y = base.y + view.y, b = f.box;
  return x + b[2] * s > -pad && x + b[0] * s < innerWidth + pad && y + b[3] * s > -pad && y + b[1] * s < innerHeight + pad;
}

function paintCoast(c, feats, pad = 24) {
  if (!feats.coast) return;
  const s = base.s * view.k, spread = clamp(Math.sqrt(s / 260), 0.4, 1); // tighter on a small map
  const shown = feats.filter((f) => onScreen(f, pad));
  let path = feats.coast;
  if (shown.length < feats.length) {
    path = new Path2D();
    for (const f of shown) path.addPath(f.path);
  }
  const strokes = [];
  for (const r of [18, 10.5]) strokes.push([r * spread, colors.coast, 1], [r * spread - 1, colors.bg, 1]);
  strokes.push([5 * spread, colors.coast, 0.35]);
  c.lineJoin = "round";
  for (const [w, color, a] of strokes) {
    c.globalAlpha = a;
    c.strokeStyle = color;
    c.lineWidth = w / s;
    c.stroke(path);
  }
  c.globalAlpha = 1;
}

function paintLand(c, feats, coast = true) {
  if (coast) paintCoast(c, feats);
  paintTerritories(c, feats.filter((f) => onScreen(f)), ROUGH_REACH);
}

// approximate territories (the source's precision 1: nearly every border before 1800)
// meet in a soft wash of colour, as uncertain extents were shown on old maps, with no
// border line. the softness is a fixed distance on the ground, so it widens as you
// zoom in; coasts stay crisp. exact territories are drawn crisp on top. `reach` is
// that distance in the paths' units, `key` which path to fill (flat, or geo for the globe)
const ROUGH_DEG = 2, ROUGH_REACH = (ROUGH_DEG * Math.PI) / 180; // equal earth units are about radians
const rough1 = document.createElement("canvas"), rough2 = document.createElement("canvas"), rough3 = document.createElement("canvas");
const fitCanvas = (cv, w, h) => { if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } };

function paintTerritories(c, feats, reach, key = "path") {
  const rough = feats.filter((f) => f.rough), exact = feats.filter((f) => !f.rough);
  for (const f of rough) { // crisp underneath: shows through where the blur thins at the coast
    c.fillStyle = fillOf(f);
    c.fill(f[key]);
  }
  const m = c.getTransform(), blur = Math.min(80, reach * m.a);
  if (rough.length && blur >= 1.5 && "filter" in c) softEdges(c, rough, blur, key, m);
  for (const f of exact) {
    c.fillStyle = fillOf(f);
    c.fill(f[key]);
  }
}

// blur at a quarter of the resolution (the blur hides it, and it's 16 times cheaper),
// scale back up, and keep only what falls on the approximate territories' land
function softEdges(c, rough, blur, key, m) {
  const W = c.canvas.width, H = c.canvas.height, q = 0.25, w = Math.ceil(W * q), h = Math.ceil(H * q);
  fitCanvas(rough1, w, h);
  fitCanvas(rough2, w, h);
  fitCanvas(rough3, W, H);
  const a = rough1.getContext("2d"), b = rough2.getContext("2d"), full = rough3.getContext("2d");
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.clearRect(0, 0, w, h);
  a.setTransform(m.a * q, m.b * q, m.c * q, m.d * q, m.e * q, m.f * q);
  for (const f of rough) {
    a.fillStyle = fillOf(f);
    a.fill(f[key]);
  }
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, w, h);
  b.filter = `blur(${blur * q}px)`;
  b.drawImage(rough1, 0, 0);
  b.filter = "none";
  full.setTransform(1, 0, 0, 1, 0, 0);
  full.globalCompositeOperation = "copy";
  full.drawImage(rough2, 0, 0, W, H);
  // one fill of all of them: with destination-in, each separate fill would erase the rest
  const all = new Path2D();
  for (const f of rough) all.addPath(f[key]);
  full.globalCompositeOperation = "destination-in";
  full.setTransform(m);
  full.fillStyle = "#000";
  full.fill(all);
  full.globalCompositeOperation = "source-over";
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(rough3, 0, 0);
  c.restore();
}

function strokeBorders(c, feats, alpha) {
  c.globalAlpha = alpha;
  c.lineWidth = 0.7 / (base.s * view.k);
  c.strokeStyle = colors.line;
  for (const f of feats) if (!f.rough && onScreen(f)) c.stroke(f.path); // approximate ones have no line to draw
  c.globalAlpha = 1;
}

const spaced = (c, px) => { if ("letterSpacing" in c) c.letterSpacing = `${px}px`; };

// italic, widely spaced, in the blue of the water lines. expects a css-pixel transform
function drawWaters(c, placed = []) {
  const z = (base.s * view.k) / 260; // 1 = the whole world on a laptop screen
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = colors.accent;
  c.globalAlpha = 0.5;
  for (const [name, lon, lat, min] of WATERS) {
    if (z < min) continue;
    const ocean = name.endsWith("Ocean"), size = ocean ? Math.min(22, 15 + 2 * Math.log2(z)) : 13.5;
    c.font = `italic ${size}px ${SERIF}`;
    spaced(c, size * (ocean ? 0.35 : 0.15));
    const at = screenAt(lon, lat, 0.3);
    if (!at) continue;
    const w = c.measureText(name).width / 2, box = [at[0] - w, at[1] - size / 2, at[0] + w, at[1] + size / 2];
    if (box[0] < 4 || box[2] > innerWidth - 4 || placed.some((p) => overlaps(box, p))) continue;
    placed.push(box);
    c.fillText(name, ...at);
  }
  spaced(c, 0);
  c.globalAlpha = 1;
}

// realm names: big realms in spaced capitals sized to the realm, small ones in italics
function drawLabels(c, feats, alpha, hits) {
  const placed = [];
  if (!feats || alpha <= 0) return placed;
  const scale = pixelsPerUnit();
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  const big = feats.filter((f) => f.name && f.label.area * scale * scale > 1600 && (globe.on || onScreen(f, 0)));
  for (const f of big.sort((a, b) => b.label.area - a.label.area)) {
    const at = globe.on ? globeScreen(...f.label.geo, 0.3) : toScreen([f.label.x, f.label.y]);
    if (!at) continue;
    const [x, y] = at, room = Math.sqrt(f.label.area) * scale * 1.8;
    let size = clamp(Math.sqrt(f.label.area) * scale / 12, 11, 19), caps = size >= 13, text, w;
    const measure = () => {
      text = caps ? f.name.toUpperCase() : f.name;
      c.font = `${caps ? "500" : "italic 400"} ${size}px ${SERIF}`;
      spaced(c, caps ? size * 0.16 : 0);
      w = c.measureText(text).width;
    };
    measure();
    if (caps && w > room) { // squeeze a long name, or give up on capitals if that's too small
      size *= room / w;
      if (size < 12) { caps = false; size = 12; }
      measure();
    }
    const box = [x - w / 2 - 3, y - size / 2 - 2, x + w / 2 + 3, y + size / 2 + 2];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    hits?.push({ box, f });
    c.globalAlpha = alpha;
    c.strokeStyle = colors.halo;
    c.lineWidth = 3;
    c.strokeText(text, x, y);
    c.globalAlpha = 0.8 * alpha;
    c.fillStyle = colors.ink;
    c.fillText(text, x, y);
  }
  spaced(c, 0);
  c.globalAlpha = 1;
  return placed;
}

// the map without pins is cached between frames, so playback only redraws pins.
// the water lines are slow to draw, so they live in their own buffer that reaches
// past the edges of the screen: panning slides it along and zooming stretches it,
// and it's redrawn only when a pan outruns it or a zoom settles. transitions draw
// the land over it
const layer = document.createElement("canvas"), lctx = layer.getContext("2d");
const coast = document.createElement("canvas"), cctx = coast.getContext("2d");
let layerDirty = true, layerView = null;
let coastAt = null; // what the buffer holds: { view, feats, margin (css px), scale (buffer px per css px) }
let lastMove = 0, settleTimer = 0;
const SETTLE_MS = 160, COAST_PIXELS = 16e6; // keeps big screens and phones within canvas limits
const sameView = (a, b) => !!a && a.k === b.k && a.x === b.x && a.y === b.y;

function fit(c) {
  if (c.width !== canvas.width || c.height !== canvas.height) {
    c.width = canvas.width;
    c.height = canvas.height;
  }
}

function renderCoast(feats) {
  const m = Math.round(Math.max(innerWidth, innerHeight) * 0.2), w = innerWidth + 2 * m, h = innerHeight + 2 * m;
  const scale = Math.min(dpr, Math.sqrt(COAST_PIXELS / (w * h))), s = base.s * view.k;
  if (coast.width !== Math.round(w * scale) || coast.height !== Math.round(h * scale)) {
    coast.width = Math.round(w * scale);
    coast.height = Math.round(h * scale);
  }
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.fillStyle = colors.bg;
  cctx.fillRect(0, 0, coast.width, coast.height);
  cctx.setTransform(s * scale, 0, 0, s * scale, (base.x + view.x + m) * scale, (base.y + view.y + m) * scale);
  paintCoast(cctx, feats, m + 24);
  coastAt = { view: { ...view }, feats, margin: m, scale };
}

// does the buffer still cover the whole screen?
function coastCovers() {
  const { view: v, margin: m } = coastAt, f = view.k / v.k;
  const u = (x) => (x - base.x - view.x) / f + base.x + v.x + m, w = (y) => (y - base.y - view.y) / f + base.y + v.y + m;
  return u(0) >= 0 && u(innerWidth) <= innerWidth + 2 * m && w(0) >= 0 && w(innerHeight) <= innerHeight + 2 * m;
}

function ensureCoast(feats) {
  const a = coastAt, zooming = a && a.view.k !== view.k, settled = performance.now() - lastMove > SETTLE_MS;
  if (!a || a.feats !== feats || (zooming ? settled : !coastCovers())) renderCoast(feats);
}

// the sea and water lines, shifted and scaled from the buffer to the current view
function drawCoast(c) {
  const { view: v, margin: m, scale } = coastAt, f = view.k / v.k, k = (f * dpr) / scale;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = colors.bg; // the ocean goes on past the edge of the screen
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  c.setTransform(k, 0, 0, k, dpr * (base.x + view.x - (m + base.x + v.x) * f), dpr * (base.y + view.y - (m + base.y + v.y) * f));
  c.drawImage(coast, 0, 0);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

function renderLayer() {
  ensureCoast(state.shown ?? []);
  fit(layer);
  drawCoast(lctx);
  lctx.setTransform(...transform());
  paintLand(lctx, state.shown ?? [], false);
  paintRelief(lctx);
  paintRivers(lctx);
  strokeBorders(lctx, state.shown ?? [], 1);
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.labelHits = [];
  const placed = drawLabels(lctx, state.shown, 1, state.labelHits); // names first; seas and ranges fit around them
  drawWaters(lctx, placed);
  drawRegions(lctx, placed);
  layerView = { ...view };
  layerDirty = false;
}

function drawMap() {
  const stretched = coastAt && coastAt.view.k !== view.k;
  if (layerDirty || !sameView(layerView, view) || (stretched && performance.now() - lastMove > SETTLE_MS)) renderLayer();
  ctx.drawImage(layer, 0, 0);
  if (coastAt && coastAt.view.k !== view.k) { // come back to sharpen the water lines
    clearTimeout(settleTimer);
    settleTimer = setTimeout(invalidate, SETTLE_MS + 20);
  }
}

// the territory under the pointer gets a faint outline, the one in the card a firm one,
// and a hovered name an underline
function drawRealmHighlight() {
  if (globe.on) globeHighlight();
  else drawFlatHighlight();
  const hit = state.hoverLabel && state.labelHits.find((h) => h.f === state.hoverLabel);
  if (hit) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(hit.box[0] + 4, hit.box[3] + 0.5);
    ctx.lineTo(hit.box[2] - 4, hit.box[3] + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawFlatHighlight() {
  const s = base.s * view.k;
  ctx.setTransform(...transform());
  ctx.lineJoin = "round";
  ctx.strokeStyle = colors.accent;
  for (const [f, w, a] of [[state.hoverRealm, 1.3, 0.45], [state.selectedRealm, 2, 0.85]]) {
    if (!f || !state.shown?.includes(f)) continue;
    ctx.globalAlpha = a;
    ctx.lineWidth = w / s;
    ctx.setLineDash(f.rough ? [5 / s, 4 / s] : []); // an approximate border, outlined as one
    ctx.stroke(f.path);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// a glyph for each kind of event, as svg path data on a 16-unit grid, drawn as lines
const KIND_ICONS = {
  battle: "M3 3l10 10M13 3L3 13M2 10l4 4M10 14l4-4",
  war: "M4 14V2M4 3h8l-2 3 2 3H4",
  political: "M2.5 12.5h11M2.5 12.5 3 5l3 3.5L8 4l2 4.5L13 5l.5 7.5",
  culture: "M2 13.5h12M3 6h10M8 2 2.5 6M8 2l5.5 4M4.5 6v7.5M8 6v7.5M11.5 6v7.5",
  science: "M6 2h4M7 2v4.5L3 13.5h10L9 6.5V2",
  exploration: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M10.5 5.5 9 9l-3.5 1.5L7 7z",
  disaster: "M9 1.5 4 9h4l-1 5.5L12 7H8z",
  art: "M2.5 3h11v10h-11zM4.5 11l3-4 2 2.5 1.5-1.5 2 3",
};
const kindPaths = Object.fromEntries(Object.entries(KIND_ICONS).map(([k, d]) => [k, new Path2D(d)]));
const kindSvg = (kind) => `<svg class="kind k-${kind}" viewBox="0 0 16 16" aria-hidden="true"><path d="${KIND_ICONS[kind] ?? ""}"/></svg>`;

// heaviest events first; lighter ones only where there's room. each is a small
// badge with its kind's glyph; the smallest are plain dots until you zoom in
function drawPins() {
  const size = clamp(Math.sqrt(pixelsPerUnit() / 300), 0.75, 1.1); // smaller pins on a small map
  const gap = 19 * size, cap = Math.round(45 * Math.sqrt(globe.on ? globe.k : view.k));
  const noted = new Set([state.selected, ...state.notes.map((n) => n.e)].filter(Boolean));
  const candidates = [...noted, ...visibleEvents().filter((e) => !noted.has(e))];
  state.pins = [];
  for (const e of candidates) {
    if (state.pins.length >= cap) break;
    const at = screenAt(e.lon, e.lat, 0.12); // not right on the globe's rim
    if (!at) continue;
    const [x, y] = at;
    if (x < -10 || y < -10 || x > innerWidth + 10 || y > innerHeight + 10) continue;
    if (!noted.has(e) && state.pins.some((p) => Math.abs(p.x - x) < gap && Math.abs(p.y - y) < gap)) continue;
    const age = (e.endLg - lg(state.year)) / LINGER;
    const r = (e === state.hoverEvent ? 2 : 0) + size * (e.importance === 1 ? 11 : e.importance === 2 ? 10 : 9);
    state.pins.push({ e, x, y, r, alpha: age > 0 ? 1 - age * 0.65 : 1 });
  }
  ctx.lineCap = ctx.lineJoin = "round";
  for (const p of [...state.pins].reverse()) { // heaviest on top
    ctx.globalAlpha = p.alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = colors.kinds?.[p.e.kind] ?? colors.accent;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.bg;
    ctx.stroke();
    const icon = kindPaths[p.e.kind];
    if (icon && p.r >= 5) {
      const k = (p.r * 1.3) / 16;
      ctx.save();
      ctx.translate(p.x - 8 * k, p.y - 8 * k);
      ctx.scale(k, k);
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = colors.badge;
      ctx.stroke(icon);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  const sel = state.pins.find((p) => p.e === state.selected);
  if (sel) {
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(sel.x, sel.y, sel.r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function draw() {
  const tr = state.transition, t = tr ? progress(tr) : 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (globe.on) {
    ctx.clearRect(0, 0, canvas.width, canvas.height); // the globe is drawn underneath, by webgl
    globeRender();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.labelHits = [];
    const placed = drawLabels(ctx, state.shown, 1, state.labelHits);
    drawWaters(ctx, placed);
    drawRegions(ctx, placed);
  } else if (tr) {
    composite(tr, t);
    drawCoast(ctx);
    ctx.drawImage(work, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(...transform());
    paintRelief(ctx);
    paintRivers(ctx);
    strokeBorders(ctx, tr.from, 1 - t);
    strokeBorders(ctx, state.shown, t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const placed = [...drawLabels(ctx, tr.from, 1 - t), ...drawLabels(ctx, state.shown, t)];
    drawWaters(ctx, placed);
    drawRegions(ctx, placed);
  } else drawMap();
  drawRealmHighlight();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPins();
  placeNotes();
}

// --- notifications -------------------------------------------------------------------
// big events pop a note on the map as the timeline moves forward past them

// the biggest moments: the hand-picked world-changing events, and anything nearly
// every wikipedia covers (bar the "x founded" entries, which are too routine)
const featured = (e) => (e.curated ? e.importance === 1 : e.weight >= FEATURE_WEIGHT && !e.title.endsWith(" founded"));
const inFocus = (e) => {
  const f = state.focus;
  if (!f) return true;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  const b = f.box;
  return !b || (e.lon >= b[0] && e.lon <= b[2] && e.lat >= b[1] && e.lat <= b[3]);
};

// events crossed by the timeline queue up for a note. they never push each other
// off: a note appears when there's a free slot, and an event that's waited too long
// is dropped. the wikipedia summary is fetched while it waits
function notify(prev, year) {
  for (const n of state.notes) if (n.e.start > year) dismiss(n, true);
  if (year <= prev || lg(prev) - lg(year) > 0.4) { state.queue = []; return; } // backwards, or a jump
  // a focus has picked its notes in advance (story.js); otherwise the big events get one
  const picked = state.focus?.picks;
  const crossed = state.events.filter((e) => e.start > prev && e.start <= year &&
    (picked ? picked.has(e) : e.weight >= NOTIFY_WEIGHT));
  for (const e of crossed.slice(0, 3)) enqueue(e); // already heaviest first
  const big = crossed.find((e) => (state.focus ? state.focus.stops.has(e) : featured(e)));
  if (big) guide(big);
}

function enqueue(e) {
  if (state.notes.some((n) => n.e === e) || state.queue.some((q) => q.e === e)) return;
  const q = { e, since: performance.now(), summary: e.wiki ? undefined : null };
  if (e.wiki) summary(e.wiki).then((s) => { q.summary = s ?? null; invalidate(); });
  state.queue.push(q);
  state.queue.sort((a, b) => featured(b.e) - featured(a.e) || b.e.weight - a.e.weight);
  state.queue.length = Math.min(state.queue.length, 8);
}

// every frame: show queued notes while there's room
function pumpNotes() {
  // an event can wait about as long as 1.5 seconds of playback, whatever the speed
  const now = lg(state.year), t = performance.now();
  const wait = Math.max(0.004, 1.5 * (state.focus ? state.focus.rate : PACE) * state.speed);
  state.queue = state.queue.filter((q) => q.e.start <= state.year && lg(q.e.start) - now < wait);
  const room = (innerWidth < 600 ? 2 : 3) - state.notes.length;
  for (let i = 0; i < room; i++) {
    const k = state.queue.findIndex((q) => q.summary !== undefined || t - q.since > 1500);
    if (k < 0) break;
    const [q] = state.queue.splice(k, 1);
    addNote(q.e, q.summary);
  }
  state.ghosts = state.ghosts.filter((g) => g.until > t);
  return state.ghosts.length > 0;
}

const firstSentence = (text, max) => {
  const first = text.match(/^.{20,}?[.!?](?=\s+[A-Z]|$)/)?.[0] ?? text;
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : first;
};

function addNote(e, s) {
  if (state.notes.some((n) => n.e === e)) return;
  const feature = featured(e), el = document.createElement("div");
  el.className = feature ? "note feature" : "note";
  el.style.setProperty("--kind", `var(--k-${e.kind}, var(--accent))`);
  el.innerHTML = `<span class="leader" hidden></span><span class="ping"></span><button class="bubble"><img alt="" hidden><span class="text"><small></small><b></b><span class="line"></span></span></button>`;
  el.querySelector("small").innerHTML = kindSvg(e.kind);
  el.querySelector("small").append(`${e.approx ? "c. " : ""}${fmt(e.start)} · ${e.kind}`);
  el.querySelector("b").textContent = e.title;
  if (s?.type === "standard") el.querySelector(".line").textContent = firstSentence(s.extract, feature ? 230 : 130);
  const img = el.querySelector("img");
  if (s?.thumbnail) { // the image box has a fixed size, so loading it doesn't move anything
    img.src = s.thumbnail.source;
    img.hidden = false;
    img.onerror = () => { img.remove(); note.w = bubble.offsetWidth; note.h = bubble.offsetHeight; invalidate(); };
  }
  el.querySelector("button").onclick = () => openCard(e);
  $("notes").append(el);
  const bubble = el.querySelector("button");
  // notes that pop up during playback live on playback time: pausing freezes them
  const note = {
    e, el, bubble, leader: el.querySelector(".leader"), w: bubble.offsetWidth, h: bubble.offsetHeight,
    spot: 0, fromPlay: state.playing, left: feature ? FEATURE_MS : NOTE_MS, born: performance.now(),
  };
  runNote(note);
  state.notes.push(note);
  placeNotes();
  invalidate();
}

function runNote(note) {
  note.due = performance.now() + note.left;
  note.timer = setTimeout(() => dismiss(note), note.left);
  note.el.classList.remove("paused");
}
function freezeNote(note) {
  clearTimeout(note.timer);
  note.left = Math.max(0, note.due - performance.now());
  note.el.classList.add("paused");
}

function dismiss(note, now = false) {
  clearTimeout(note.timer);
  state.notes = state.notes.filter((n) => n !== note);
  // a fading note can't follow the map, so it goes at once while the camera moves
  if (now || state.flight || goal || fling || drag?.moved || pinch) note.el.remove();
  else {
    if (!note.el.hidden && !note.bubble.hidden) state.ghosts.push({ box: rectOf(note.bubble), until: performance.now() + 300 });
    note.el.classList.add("out");
    setTimeout(() => note.el.remove(), 250);
  }
  invalidate();
}

// where a bubble may sit, relative to its pin: above, below, beside and on the
// diagonals, close in first and then further out (with a leader line back)
function spots(w, h) {
  const out = [];
  for (const d of [14, 42, 84, 140, 200]) {
    const q = d * 0.7;
    out.push([-w / 2, -d - h], [-w / 2, d], [d, -h / 2], [-d - w, -h / 2],
      [q, -q - h], [-q - w, -q - h], [q, q], [-q - w, q]);
  }
  return out;
}

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };

// does the line from (x0, y0) to (x1, y1) pass through any of the boxes?
function crosses(x0, y0, x1, y1, boxes) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6);
  for (let i = 1; i < steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
    if (boxes.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3])) return true;
  }
  return false;
}

// lay out the notes. notes whose places nearly coincide on screen share one stack
// of bubbles. each stack, oldest first, takes the first spot that's on screen and
// clear of the other bubbles, every ping and the controls, without its leader line
// cutting through another bubble. a stack keeps its spot while it's still free, so
// bubbles don't hop around; with nowhere to go only the pings show. a note whose
// place is off screen waits hidden until it comes into view
function placeNotes() {
  const W = innerWidth, H = innerHeight, pad = 8, gap = 8; // gap: between bubbles, stacked or not
  const blocked = [rectOf($("top")), rectOf(document.querySelector("footer"))];
  if (!$("card").hidden) blocked.push(rectOf($("card")));
  for (const g of state.ghosts) blocked.push(g.box);
  if (!$("explore").hidden) blocked.push(rectOf($("explore")));
  const at = state.notes.map((n) => screenAt(n.e.lon, n.e.lat) ?? [-1e4, -1e4]); // behind the globe: off screen
  const pings = at.map(([x, y]) => [x - 11, y - 11, x + 11, y + 11]);
  const stacks = [];
  state.notes.forEach((n, i) => {
    const [x, y] = at[i];
    n.el.hidden = x < 0 || x > W || y < 0 || y > H;
    if (n.el.hidden) return;
    n.el.style.transform = `translate(${x}px, ${y}px)`;
    n.leader.hidden = true;
    const near = stacks.find((st) => Math.hypot(at[st[0]][0] - x, at[st[0]][1] - y) < 34);
    near ? near.push(i) : stacks.push([i]);
  });

  const placed = [];
  for (const st of stacks) {
    const host = state.notes[st[0]], [x, y] = at[st[0]];
    const w = Math.max(...st.map((i) => state.notes[i].w));
    const h = st.reduce((sum, i) => sum + state.notes[i].h, 0) + gap * (st.length - 1);
    const all = spots(w, h);
    let found = null;
    for (const k of [host.spot, ...all.keys()]) {
      const left = clamp(x + all[k][0], pad, W - w - pad), top = clamp(y + all[k][1], pad, H - h - pad);
      const box = [left, top, left + w, top + h], clear = [left - gap, top - gap, left + w + gap, top + h + gap];
      if ([...blocked, ...pings].some((b) => overlaps(box, b)) || placed.some((b) => overlaps(clear, b))) continue;
      const ex = clamp(x, left, left + w), ey = clamp(y, top, top + h);
      if (crosses(x, y, ex, ey, placed)) continue;
      found = { k, box, ex, ey };
      break;
    }
    for (const i of st) state.notes[i].bubble.hidden = !found;
    if (!found) continue;
    host.spot = found.k;
    placed.push(found.box);
    let top = found.box[1];
    for (const i of st) { // stacked bubbles share the stack's width
      const n = state.notes[i];
      n.bubble.style.width = st.length > 1 ? `${w}px` : "";
      n.bubble.style.left = `${found.box[0] - at[i][0]}px`;
      n.bubble.style.top = `${top - at[i][1]}px`;
      top += n.h + gap;
    }
    // a leader line from the ping to the nearest edge of a stack that's wandered off
    const dx = found.ex - x, dy = found.ey - y, len = Math.hypot(dx, dy);
    if (len > 22) {
      host.leader.hidden = false;
      host.leader.style.width = `${len - 7}px`;
      host.leader.style.transform = `rotate(${Math.atan2(dy, dx)}rad) translateX(7px)`;
    }
  }
}

// --- timeline & playback ---------------------------------------------------------------

function buildTicks() {
  for (const y of [-5000, -4000, -3000, -2000, -1000, 1, 500, 1000, 1500, 2000]) {
    const s = document.createElement("span");
    s.className = [-5000, -3000, -1000, 1000, 2000].includes(y) ? "era" : "era minor";
    s.style.left = `${toPos(y) * 100}%`;
    s.textContent = y === 1 ? "0" : y < 0 ? `${-y} bce` : y;
    if (y === MIN_YEAR) s.classList.add("start");
    $("ticks").append(s);
  }
}

let hashTimer = 0;
function applyYear(year) {
  const prev = state.year;
  state.year = year;
  $("handle").style.left = `${state.pos * 100}%`;
  invalidate();
  if (year === prev && state.wanted !== null) return;

  $("year").textContent = fmt(year);
  $("track").setAttribute("aria-valuetext", fmt(year));
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => { try { history.replaceState(null, "", `#${state.year}`); } catch {} }, 250);
  if (state.wanted !== null) notify(prev, year);

  const snap = snapshotFor(year);
  if (snap === state.wanted) return;
  state.wanted = snap;
  loadBorders(snap).then((feats) => {
    if (state.wanted !== snap) return; // timeline moved on while loading
    showBorders(feats);
    const i = state.snapshots.indexOf(snap); // prefetch neighbours
    [state.snapshots[i - 1], state.snapshots[i + 1]].forEach((s) => s !== undefined && loadBorders(s));
  });
}

function setPos(p) {
  state.pos = clamp(p, 0, 1);
  applyYear(roundYear(toYear(state.pos)));
}
function setYear(y) {
  y = roundYear(y);
  state.pos = toPos(y);
  applyYear(y);
}

function setPlaying(on) {
  if (on && state.focus && state.year >= state.focus.to) setYear(state.focus.from); // replay the focus
  else if (on && state.pos >= 1) setYear(MIN_YEAR); // replay from the start
  if (on !== state.playing) {
    for (const n of state.notes) if (n.fromPlay) on ? runNote(n) : freezeNote(n);
  }
  state.playing = on;
  $("play").setAttribute("aria-pressed", on);
  $("play").setAttribute("aria-label", on ? "pause" : "play");
  invalidate();
}

// playback slows while a fresh note is being read, and nearly stops at a guided stop
function stepPlay(dt) {
  if (!state.playing) return false;
  const t = performance.now(), fresh = state.notes.some((n) => n.fromPlay && t - n.born < 3000);
  const target = state.stop ? 0.04 : fresh ? 0.35 : 1;
  state.ease += (target - state.ease) * (1 - Math.exp(-dt * (target < state.ease ? 6 : 1.5)));
  const rate = state.focus ? state.focus.rate : PACE;
  setPos(toPos(lgShift(toYear(state.pos), dt * rate * state.speed * state.ease)));
  stepStop(dt);
  if (state.pos >= 1 || (state.focus && state.year >= state.focus.to)) setPlaying(false);
  return state.playing;
}

$("play").onclick = () => setPlaying(!state.playing);
$("speed").onclick = () => {
  state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
  $("speed").textContent = `${state.speed}×`;
};

function trackPos(ev) {
  const r = $("track").getBoundingClientRect();
  return clamp((ev.clientX - r.left) / r.width, 0, 1);
}

$("track").addEventListener("pointerdown", (ev) => {
  $("track").setPointerCapture(ev.pointerId);
  setPos(trackPos(ev));
  const move = (e) => setPos(trackPos(e));
  $("track").addEventListener("pointermove", move);
  $("track").addEventListener("pointerup", () => $("track").removeEventListener("pointermove", move), { once: true });
});

// scrolling over the timeline scrubs through time
document.querySelector("footer").addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  setPos(toPos(lgShift(toYear(state.pos), d * (ev.deltaMode === 1 ? 16 : 1) * 0.0008)));
}, { passive: false });

addEventListener("keydown", (ev) => {
  if (ev.key === " " && !(ev.target instanceof HTMLButtonElement)) {
    ev.preventDefault();
    return setPlaying(!state.playing);
  }
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  const dir = ev.key === "ArrowRight" ? 1 : -1;
  if (ev.shiftKey) { // jump between border snapshots
    const i = state.snapshots.indexOf(snapshotFor(state.year));
    return setYear(state.snapshots[clamp(i + dir, 0, state.snapshots.length - 1)]);
  }
  let y = state.year + dir * stepAt(state.year);
  if (y === 0) y = dir;
  setYear(y);
});

// --- map interaction -------------------------------------------------------------

function eventAt(x, y, touch = false) {
  let best = null, bestD = touch ? 18 : 6;
  for (const p of state.pins) {
    const d = Math.hypot(p.x - x, p.y - y) - p.r;
    if (d < bestD) { best = p.e; bestD = d; }
  }
  return best;
}

function realmAt(x, y) {
  if (globe.on) {
    const g = globeGeo(x, y);
    if (!g) return null;
    const [lon, lat] = g;
    wctx.setTransform(1, 0, 0, 1, 0, 0); // geographic paths: x is longitude, y is minus latitude
    const hit = [...(state.shown ?? [])].reverse().find((f) =>
      lon >= f.geoBox[0] && lon <= f.geoBox[2] && -lat >= f.geoBox[1] && -lat <= f.geoBox[3] && wctx.isPointInPath(f.geo, lon, -lat));
    return hit?.name ? hit : null;
  }
  const s = base.s * view.k, wx = (x - base.x - view.x) / s, wy = (y - base.y - view.y) / s;
  ctx.setTransform(...transform());
  const hit = [...(state.shown ?? [])].reverse().find((f) =>
    wx >= f.box[0] && wx <= f.box[2] && wy >= f.box[1] && wy <= f.box[3] && ctx.isPointInPath(f.path, x * dpr, y * dpr));
  return hit?.name ? hit : null;
}
const labelAt = (x, y) => state.labelHits.find(({ box: b }) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])?.f ?? null;

const pointers = new Map();
let drag = null, pinch = null;

function startDrag(ev) {
  drag = { x: ev.clientX, y: ev.clientY, moved: false, trail: [[ev.clientX, ev.clientY, ev.timeStamp]] };
}
function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  userSteers();
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  goal = fling = null;
  if (pointers.size === 2) { drag = null; pinch = pinchInfo(); }
  else if (pointers.size === 1) startDrag(ev);
});

canvas.addEventListener("pointermove", (ev) => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && pointers.size === 2) {
    const now = pinchInfo();
    panBy(now.x - pinch.x, now.y - pinch.y);
    zoomAt(now.x, now.y, now.d / pinch.d, false);
    pinch = now;
    return;
  }
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) {
      canvas.classList.add("dragging");
      panBy(dx, dy);
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      drag.trail = [...drag.trail, [ev.clientX, ev.clientY, ev.timeStamp]].filter((p) => ev.timeStamp - p[2] < 100);
    }
    return;
  }
  const e = eventAt(ev.clientX, ev.clientY);
  const label = e ? null : labelAt(ev.clientX, ev.clientY), realm = e ? null : label ?? realmAt(ev.clientX, ev.clientY);
  if (e !== state.hoverEvent || realm !== state.hoverRealm || label !== state.hoverLabel) {
    Object.assign(state, { hoverEvent: e, hoverRealm: realm, hoverLabel: label });
    invalidate();
  }
  canvas.style.cursor = e || label ? "pointer" : "";
  $("hover").textContent = e ? e.title : realm?.name ?? "";
});
canvas.addEventListener("pointerleave", () => {
  Object.assign(state, { hoverEvent: null, hoverRealm: null, hoverLabel: null });
  $("hover").textContent = "";
  invalidate();
});

function endPointer(ev) {
  pointers.delete(ev.pointerId);
  canvas.classList.remove("dragging");
  if (pinch) {
    pinch = null;
    const rest = [...pointers.values()][0];
    if (rest) drag = { x: rest.x, y: rest.y, moved: true, trail: [] };
    return;
  }
  if (!drag) return;
  if (!drag.moved && ev.type === "pointerup") {
    const e = eventAt(ev.clientX, ev.clientY, ev.pointerType === "touch");
    const realm = e ? null : labelAt(ev.clientX, ev.clientY) ?? realmAt(ev.clientX, ev.clientY);
    e ? openCard(e) : realm ? openRealm(realm) : closeCard();
  } else if (drag.trail.length > 1) { // let it coast
    const [x0, y0, t0] = drag.trail[0], [x1, y1, t1] = drag.trail.at(-1);
    const dt = Math.max(16, t1 - t0) / 1000;
    if (ev.timeStamp - t1 < 60) { fling = { vx: (x1 - x0) / dt, vy: (y1 - y0) / dt }; invalidate(); }
  }
  drag = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

// a mouse wheel zooms. trackpads give themselves away by scrolling sideways (a
// wheel only scrolls up and down), and from then on two-finger scrolling pans.
// pinches arrive as ctrl+wheel on both, and are already smooth
let trackpad = false;
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  userSteers();
  const unit = ev.deltaMode === 1 ? 16 : 1, dx = ev.deltaX * unit, dy = ev.deltaY * unit;
  if (ev.ctrlKey) return zoomAt(ev.clientX, ev.clientY, Math.exp(-dy * 0.01), false);
  if (dx !== 0 && !ev.shiftKey && ev.deltaMode === 0) trackpad = true;
  if (trackpad) {
    goal = fling = null;
    panBy(-dx, -dy);
  } else zoomAt(ev.clientX, ev.clientY, Math.exp(-dy * 0.002));
}, { passive: false });

// the zoom buttons zoom about the middle of the map
for (const b of document.querySelectorAll("#zoom button")) {
  b.onclick = () => {
    userSteers();
    const { cx, cy } = globeArea(), z = b.dataset.zoom;
    if (z === "fit") {
      if (globe.on) { globe.goalK = 1; viewChanged(); }
      else zoomAt(cx, cy, minZoom / (goal ?? view).k);
    } else zoomAt(cx, cy, z === "in" ? 1.8 : 1 / 1.8);
  };
}

canvas.addEventListener("dblclick", (ev) => zoomAt(ev.clientX, ev.clientY, ev.shiftKey ? 0.4 : 2.5));

// descriptions and photos come from wikipedia's page summary api, fetched on demand
const summaries = new Map();
function summaryOf(title) {
  if (!summaries.has(title)) {
    summaries.set(title, fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return summaries.get(title);
}
function summary(wiki) {
  let title = wiki.split("/wiki/")[1];
  try { title = decodeURIComponent(title); } catch {} // curated urls are escaped, wikidata ones aren't
  return summaryOf(title);
}

// realm names come from the border data, not wikipedia ("Tsardom of Muscovy",
// "Mandatory Palestine (GB)"), so: the exact title first (wikipedia follows its
// redirects), then a search, trusting a result only if it carries every word of the
// name, or all but one and its description dates it to this period. a wrong article
// is worse than none
const STOP = new Set(["of", "the", "and", "de", "du", "la", "le", "al", "el", "von", "van", "der", "des", "di", "da",
  "empire", "kingdom", "dynasty"]); // too generic to tell articles apart
// names the lookup gets wrong or can't find, mapped by hand. add to this freely
const REALM_ARTICLES = {
  "Ming Chinese Empire": "Ming dynasty",
  "Manchu Empire": "Qing dynasty",
  "Quazaq Khanate": "Kazakh Khanate",
};
// an article that came by redirect or search must describe a place or a polity
const PLACE = /\b(state|empire|kingdom|dynasty|country|region|people|khanate|sultanate|caliphate|polity|confederation|confederacy|city|republic|emirate|territor|colon|province|island|duchy|principality|tribe|ethnic|culture|civili[sz]ation|realm|nation|monarchy|chiefdom|federation|union|protectorate|mandate|area|homeland|horde|shogunate)/i;
const isPlace = (s) => PLACE.test(s?.description ?? "");
const sameTitle = (s, name) => s?.title?.toLowerCase().replace(/_/g, " ") === name.toLowerCase();
const realmArticles = new Map();
function realmArticle(name, year) {
  const clean = REALM_ARTICLES[name] ?? name.replace(/\s*\([^)]*\)/g, "").trim();
  if (!realmArticles.has(clean)) {
    realmArticles.set(clean, (async () => {
      const direct = await summaryOf(clean);
      if (direct?.type === "standard" && (sameTitle(direct, clean) || isPlace(direct))) return direct;
      const words = clean.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2 && !STOP.has(w))
        .map((w) => (w.length > 4 ? w.replace(/(es|s)$/, "") : w));
      const found = await fetch(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(clean)}&limit=5`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const stems = (text) => text.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
      const extra = (p) => stems(p.title).filter((w) => !words.some((q) => w.startsWith(q))).length;
      const fits = (found?.pages ?? []).filter((p) => {
        const about = `${p.title} ${p.description ?? ""}`.toLowerCase();
        const missing = words.filter((w) => !about.includes(w)).length;
        const years = (p.description ?? "").match(/\d{3,4}/g)?.map(Number) ?? [];
        const bc = /\bBC/.test(p.description ?? "") ? -1 : 1;
        const dated = years.length > 1 && Math.min(...years) * bc <= year && year <= Math.max(...years) * bc;
        // an article about something else that mentions the name ("Sermon of al-Gharra")
        // adds words to it; only trust that when its dates put it in this period
        return dated ? missing <= (words.length > 2 ? 1 : 0) : missing === 0 && extra(p) <= 1 && !/^(sermon|battle|siege|treaty|list|history) /i.test(p.title);
      });
      // of the articles that fit, the one whose title adds least: "Ming dynasty", not "Transition from Ming to Qing"
      for (const p of fits.sort((a, b) => extra(a) - extra(b))) {
        const s = await summaryOf(p.key);
        if (s?.type === "standard" && isPlace(s)) return s;
      }
      return null;
    })());
  }
  return realmArticles.get(clean);
}

function fillCard({ meta, title, related = [] }) {
  const card = $("card"), img = card.querySelector("img"), desc = card.querySelector(".desc");
  card.querySelector(".meta").textContent = meta;
  card.querySelector("h2").textContent = title;
  card.querySelector(".wiki").hidden = true;
  img.hidden = true;
  img.removeAttribute("src");
  desc.textContent = "loading…";
  desc.classList.add("loading");
  const list = card.querySelector(".related");
  list.replaceChildren(...related.map((e) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.innerHTML = "<small></small> ";
    b.querySelector("small").textContent = fmt(e.start);
    b.append(e.title);
    b.onclick = () => openCard(e);
    li.append(b);
    return li;
  }));
  card.querySelector(".related-wrap").hidden = !related.length;
  card.hidden = false;
  card.scrollTop = 0;
  invalidate();
}

function fillSummary(s, url) {
  const card = $("card"), img = card.querySelector("img"), desc = card.querySelector(".desc"), a = card.querySelector(".wiki");
  desc.classList.remove("loading");
  desc.textContent = s?.type === "standard" ? s.extract : "";
  // check the string, not a.href: an empty href reads back as this page's own url
  const link = url ?? s?.content_urls?.desktop?.page;
  if (link) a.href = link;
  else a.removeAttribute("href");
  a.hidden = !link;
  if (s?.thumbnail) {
    const big = (s.originalimage?.width ?? 0) >= 500 ? s.thumbnail.source.replace(/\/\d+px-/, "/500px-") : null;
    img.onerror = () => { if (big && img.src !== s.thumbnail.source) img.src = s.thumbnail.source; else img.hidden = true; };
    img.onload = () => (img.hidden = false);
    img.src = big ?? s.thumbnail.source;
  }
}

async function openCard(e) {
  const when = e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
  fillCard({ meta: `${e.approx ? "c. " : ""}${when} · ${e.kind}`, title: e.title });
  state.selected = e;
  state.selectedRealm = null;
  if (!e.wiki) return fillSummary(null);
  const s = await summary(e.wiki);
  if (state.selected === e) fillSummary(s, e.wiki); // unless another card was opened meanwhile
}

// a territory: what it was, who it answered to, and the biggest events inside it
// while these borders stood
async function openRealm(f) {
  const i = state.snapshots.indexOf(state.wanted), from = state.wanted, until = state.snapshots[i + 1] ?? MAX_YEAR;
  wctx.setTransform(1, 0, 0, 1, 0, 0); // the paths are in projected units
  const inside = state.events
    .filter((e) => e.start >= from && e.start < until)
    .filter((e) => { const [x, y] = project(e.lon, e.lat); return wctx.isPointInPath(f.path, x, y); })
    .slice(0, 6) // heaviest first already
    .sort((a, b) => a.start - b.start);
  const under = (f.subject && f.subject !== f.name ? ` · under ${f.subject}` : "") + (f.rough ? " · borders approximate" : "");
  fillCard({ meta: `${fmt(from)} – ${fmt(until)}${under}`, title: f.name, related: inside });
  state.selected = null;
  state.selectedRealm = f;
  // a name that came from cliopatria brings its wikipedia article with it
  const s = f.wiki ? await summaryOf(f.wiki) : await realmArticle(f.name, from);
  if (state.selectedRealm === f) fillSummary(s);
}

function closeCard() {
  $("card").hidden = true;
  state.selected = state.selectedRealm = null;
  invalidate();
}
$("close").onclick = closeCard;
addEventListener("keydown", (ev) => ev.key === "Escape" && closeCard());

// --- boot --------------------------------------------------------------------------

(async () => {
  let curated, wikidata;
  [state.snapshots, curated, wikidata] = await Promise.all([
    fetch("data/borders/index.json").then((r) => r.json()),
    fetch("data/events.json").then((r) => r.json()),
    fetch("data/events-wikidata.json").then((r) => r.json()).catch(() => []),
  ]);
  state.events = mergeEvents(curated, wikidata);
  loadPhysical().catch(() => {}); // the map works without it
  const fonts = ["400", "500", "italic 400"].map((w) => document.fonts.load(`${w} 16px "EB Garamond"`));
  await Promise.race([Promise.all(fonts), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  document.fonts.addEventListener("loadingdone", () => { layerDirty = true; invalidate(); });
  readColors();
  buildTicks();
  addEventListener("resize", resize);
  dark.addEventListener("change", () => { readColors(); viewChanged(); });
  resize();
  const fromHash = () => {
    const y = parseInt(location.hash.slice(1), 10);
    setYear(Number.isFinite(y) && y !== 0 ? y : state.year);
  };
  addEventListener("hashchange", fromHash);
  fromHash();
  restoreGlobe();
})();
