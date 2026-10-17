// world timeline: equal earth map + log-scale timeline. no dependencies.

const MIN_YEAR = -3000, MAX_YEAR = 2026, PRESENT = 2050;
const PACE = 0.055;          // playback, in log-years per second at 1× (see the time scale)
const SPEEDS = [0.5, 1, 2, 4];
const LINGER = 0.16;         // how long a pin stays (fading) after its event ends, in log-years
const NOTE_MS = 7000, FEATURE_MS = 9000; // how long a note stays (playback time)
const READ_MS = 1700;        // a story is up at least this long before the next takes its place (at 1×)
const FEATURE_WEIGHT = 150;  // sitelinks that make an event a guided stop (or importance 1)
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
// a custom event for vercel web analytics: what people do, never who they are or what they
// typed. at most two properties (the pro plan's limit); off vercel, or on a plan without
// custom events, they go nowhere. the snippet in index.html queues them until its script loads
const trackEvent = (name, data) => { try { window.va?.("event", data ? { name, data } : { name }); } catch {} };

const state = {
  year: 1453,
  pos: 0,               // timeline position 0..1; the year is derived from it
  snapshots: [],        // available border years
  borders: new Map(),   // year -> promise of prepared features
  wanted: null,         // snapshot year we're loading / showing
  shown: null,          // features currently drawn
  plain: false,         // just land and water, no territories (a quiz question is up)
  events: [],           // heaviest first
  pins: [],             // pins drawn last frame, for hit testing
  hoverEvent: null,
  playing: false,
  speed: 1,
  story: null,          // the reel's event being told in the card
  cardAt: -1e9,         // when the card last appeared or changed
  queue: [],            // events waiting for their turn
  ease: 1,              // playback slows while there's something to read, and hurries through quiet stretches
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
const fmt = (y) => (y < 0 ? `${(-y).toLocaleString()} BCE` : `${y} CE`);

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

// [west, south, east, north], until when, share of the sitelinks an event there needs
const REGIONS = [
  [[-170, -56, -30, 72], 1500, 0.5], // the americas before columbus
  [[-20, -36, 42, 21], 1880, 0.5],   // sub-saharan africa, before the scramble
  [[42, -36, 52, 11.5], 1880, 0.5],  // the horn, without yemen
];
const regionShare = (e) => REGIONS.find(([[w, s, east, n], until]) =>
  e.lon >= w && e.lon <= east && e.lat >= s && e.lat <= n && e.start < until)?.[2] ?? 1;

// curated events win over their wikidata twins, but borrow their sitelinks as weight
const article = (url) => url && decodeURIComponent(url).toLowerCase();
function mergeEvents(curated, wikidata) {
  const twins = new Map(wikidata.filter((e) => e.wiki).map((e) => [article(e.wiki), e]));
  for (const e of curated) {
    e.curated = true;
    const twin = twins.get(article(e.wiki));
    if (twin) { e.sitelinks ??= twin.sitelinks; twin.dup = true; }
  }
  const events = [...curated, ...wikidata.filter((e) => !e.dup)];
  for (const e of events) {
    // fewer languages write about the ancient world, so sitelinks count for more the older
    // the event (the same scale as ERA in pipeline/wikidata.py), and in the parts of the
    // world wikipedia covers thinly (REGIONS there)
    e.weight = e.sitelinks ? e.sitelinks / (e.start < 500 ? 0.35 : e.start < 1500 ? 0.65 : 1) / regionShare(e) : { 1: 150, 2: 70, 3: 30 }[e.importance];
    e.endLg = lg(e.end ?? e.start);
  }
  return events.sort((a, b) => b.weight - a.weight);
}

// --- view: smooth zoom, inertial pan, pinch ------------------------------------

let dpr = 1, base = { s: 1, x: 0, y: 0 }, minZoom = 1;
const dockSpace = () => (innerWidth < 600 ? 136 : 92); // the timeline dock along the bottom

// the map's part of the screen, so a story never covers the map it's about: above the
// dock and, on a wide screen, right of the story column (the card, on the dock at the
// bottom left); on a phone, between the top buttons and the (compact) story card, which
// sits just above the dock there (or the quiz, a little taller), and the focus being
// played, under the top buttons
const CARD_COLUMN = 377, CARD_STRIP = 128;
function mapArea() {
  if (innerWidth < 600) {
    const dock = document.querySelector("footer").getBoundingClientRect().top || innerHeight - dockSpace();
    const strip = state.quiz ? QUIZ_STRIP : CARD_STRIP, chip = $("focus-chip");
    const top = chip.hidden ? 58 : 58 + chip.offsetHeight + 8, h = Math.max(160, dock - 10 - strip - 8 - top);
    return { cx: innerWidth / 2, cy: top + h / 2, w: innerWidth, h };
  }
  const side = innerWidth >= 1000 ? CARD_COLUMN : 0, h = innerHeight - dockSpace();
  return { cx: side + (innerWidth - side) / 2, cy: h / 2 + 8, w: innerWidth - side, h };
}
let goal = null;   // view we're easing toward (wheel / double-click zoom)
let fling = null;  // pan velocity after a drag, px/s

function resize() {
  dpr = devicePixelRatio || 1;
  // the canvases' pixels follow their box on screen, not innerWidth/innerHeight: with a
  // phone's keyboard up those can disagree, and the map and globe would be drawn stretched
  canvas.width = Math.round((canvas.clientWidth || innerWidth) * dpr);
  canvas.height = Math.round((canvas.clientHeight || innerHeight) * dpr);
  const { cx, cy, w, h } = mapArea(), pad = 16;
  const fitW = (w - pad * 2) / (HALF_W * 2), fitH = (h - pad * 2) / (BOTTOM - TOP);
  // a phone held upright would show a thin strip of world: start zoomed in on the
  // old world instead, filling more of the height, and let it zoom out to fit
  const s = fitW < fitH * 0.75 ? fitH * 0.75 : Math.min(fitW, fitH);
  minZoom = Math.min(1, fitW / s);
  base = { s, x: cx, y: cy - (s * (TOP + BOTTOM)) / 2 };
  if (minZoom < 1 && view.k === 1 && view.x === 0) view.x = -project(20, 0)[0] * s; // centre on europe/africa
  clampView(view);
  layerDirty = true;
  coastAt = null;
  density.bins = null;
  drawDensity();
  if (eraShown) placeEraTag(state.year);
  viewChanged();
}

// keep the point under the middle of the map's area on the map
function clampView(v) {
  const { cx: mx, cy: my } = mapArea(), s = base.s * v.k, cx = mx - base.x, cy = my - base.y;
  v.x = clamp(v.x, cx - HALF_W * s, cx + HALF_W * s);
  v.y = clamp(v.y, cy - BOTTOM * s, cy - TOP * s);
  return v;
}

function viewChanged() {
  state.transition = null; // transitions are rasterised in screen space
  lastMove = performance.now();
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
  if (revealing) { // after a plain map, the year's own borders come straight in (the globe fades them)
    revealing = false;
    state.plain = false;
    state.transition = null;
    state.shown = feats;
    return restyle();
  }
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

// while a quiz question is up the map is just land and water: territories would hint at
// the year, and loading and repainting them as the guess moves is what makes it slow.
// turned off, it stays plain until the year's own borders are in, then shows them
let revealing = false;
function restyle() {
  layerDirty = true;
  globeStale(true);
  invalidate();
}
function setPlain(on) {
  if (on) {
    revealing = false;
    if (!state.plain) { Object.assign(state, { plain: true, transition: null, hoverRealm: null, hoverLabel: null }); restyle(); }
  } else if (state.plain && !revealing) {
    if (snapshotFor(state.year) === state.wanted && state.shown) { state.plain = false; restyle(); }
    else { revealing = true; syncBorders(state.year); }
  }
}

// --- rendering -----------------------------------------------------------------

const dark = matchMedia("(prefers-color-scheme: dark)");
let colors = {};
function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const k of ["bg", "land", "line", "ink", "muted", "accent", "coast", "river", "halo", "badge", "serif"]) colors[k] = css.getPropertyValue(`--${k}`).trim();
  colors.realms = Array.from({ length: REALMS }, (_, i) => css.getPropertyValue(`--realm-${i}`).trim());
  colors.space = css.getPropertyValue("--space").trim();
  colors.kinds = Object.fromEntries(Object.keys(KIND_ICONS).map((k) => [k, css.getPropertyValue(`--k-${k}`).trim()]));
  colors.eras = ERAS.map((_, i) => css.getPropertyValue(`--era-${i}`).trim());

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
  busy = pumpStories() || busy;
  if (state.transition && progress(state.transition) >= 1) state.transition = null;
  busy ||= !!state.transition || now - state.cardAt < TETHER_MS; // the card's line drawing in
  draw();
  if (busy || (globe.on && globeBusy())) invalidate(); // after drawing: that's where the globe starts a fade
}

function visibleEvents() {
  if (state.quiz?.asking) return []; // the pins would give the answer away (the quiz's own is state.selected)
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
  if (state.plain) {
    c.fillStyle = colors.land;
    for (const f of feats) c.fill(f[key]);
    return;
  }
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
  if (state.plain) return;
  c.globalAlpha = alpha;
  c.lineWidth = 0.7 / (base.s * view.k);
  c.strokeStyle = colors.line;
  for (const f of feats) if (!f.rough && onScreen(f)) c.stroke(f.path); // approximate ones have no line to draw
  c.globalAlpha = 1;
}

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
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
  if (!feats || alpha <= 0 || state.plain) return placed;
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
// the kinds' glyphs: lucide icons (isc licence), written by pipeline/icons.py
const KIND_ICONS = {
  battle: "M14.5 17.5L3 6L3 3L6 3L17.5 14.5M13 19L19 13M16 16L20 20M19 21L21 19M14.5 6.5L18 3L21 3L21 6L17.5 9.5M5 14L9 18M7 17L4 20M3 19L5 21", // swords
  war: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22L4 15", // flag
  political: "M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294zM5 21h14", // crown
  culture: "M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z", // book-open
  science: "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2M8.5 2h7M7 16h10", // flask-conical
  exploration: "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6M12 10v4M12 2v3", // ship
  disaster: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z", // flame
  art: "M13 6.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M17 10.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M8 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M6 12.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z", // palette
  music: "M9 18V5l12-2v13M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", // music
};
const kindPaths = Object.fromEntries(Object.entries(KIND_ICONS).map(([k, d]) => [k, new Path2D(d)]));
const kindSvg = (kind) => `<svg class="kind k-${kind}" viewBox="0 0 24 24" aria-hidden="true"><path d="${KIND_ICONS[kind] ?? ""}"/></svg>`;

// heaviest events first; lighter ones only where there's room. each is a small
// badge with its kind's glyph; the smallest are plain dots until you zoom in
function drawPins() {
  const size = clamp(Math.sqrt(pixelsPerUnit() / 300), 0.75, 1.1); // smaller pins on a small map
  const gap = 19 * size, cap = Math.round(45 * Math.sqrt(globe.on ? globe.k : view.k));
  const noted = new Set([state.selected].filter(Boolean));
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
    state.pins.push({ e, x, y, r, alpha: age > 0 && !noted.has(e) ? 1 - age * 0.65 : 1 });
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
      const k = (p.r * 1.25) / 24; // lucide's 24-unit grid
      ctx.save();
      ctx.translate(p.x - 12 * k, p.y - 12 * k);
      ctx.scale(k, k);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = colors.badge;
      ctx.stroke(icon);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  const sel = state.pins.find((p) => p.e === state.selected);
  if (sel) {
    ctx.strokeStyle = colors.kinds?.[sel.e.kind] ?? colors.accent;
    ctx.lineWidth = 2;
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
  drawTether();
  drawPins();
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

// the events chosen to play (the reel, story.js) queue up as the timeline crosses
// them, and each in turn opens in the card, joined to its pin by a line. one story
// shows at a time: the next takes its place once it's been up long enough to read,
// and one that's waited too long is dropped. wikipedia summaries for the next few are
// fetched ahead, so stories appear on time. a card the reader opened themselves (or
// touched) stays until they close it, and the reel lets it be
function notify(prev, year) {
  if (state.quiz) return; // the quiz moves the timeline to guess, and to answer
  if (state.story && state.story.e.start > year) closeCard();
  if (year <= prev || lg(prev) - lg(year) > 0.4) { state.queue = []; return; } // backwards, or a jump
  const reel = currentReel(), crossed = reel.order.filter((e) => e.start > prev && e.start <= year);
  for (const e of crossed) enqueue(e, reel.score.get(e));
  const stop = crossed.find((e) => reel.stops.has(e));
  if (stop && !readersCard()) guide(stop);
  for (const e of reel.order.filter((e) => e.start > year).slice(0, 4)) {
    if (e.wiki) summary(e.wiki).then((s) => { const src = cardImage(s); if (src) new Image().src = src; });
  }
}

const readersCard = () => !$("card").hidden && !state.story;

function enqueue(e, score) {
  if (state.story?.e === e || state.queue.some((q) => q.e === e)) return;
  const q = { e, score, since: performance.now(), ready: !e.wiki };
  if (e.wiki) summary(e.wiki).then(() => { q.ready = true; invalidate(); });
  state.queue.push(q);
  state.queue.sort((a, b) => b.score - a.score);
  state.queue.length = Math.min(state.queue.length, 3);
}

// how long the story has been up, in its own (playback) time, and whether it's been
// read. faster playback reads faster, though not in proportion
const shownFor = (st) => st.total - (st.paused ? st.left : st.due - performance.now());
const wasRead = (st) => shownFor(st) >= READ_MS / Math.sqrt(state.speed);

// a story still being read holds playback back from the next pick: busy stretches of
// history slow down so every story gets its turn, and quiet ones fly by
function holding(rate) {
  const st = state.story;
  if (!st?.fromPlay || wasRead(st)) return false;
  if (state.queue.length) return true; // another is already waiting its turn (the same year, say)
  const next = currentReel().order.find((e) => e.start > state.year);
  return !!next && lg(state.year) - lg(next.start) < 0.35 * rate * state.speed;
}

// every frame: tell the best queued story once the one up has been read
function pumpStories() {
  // an event can wait about as long as 4 seconds of playback for its turn, whatever the speed
  const now = lg(state.year), t = performance.now();
  const wait = Math.max(0.004, 4 * (state.focus ? state.focus.rate : PACE) * state.speed);
  state.queue = readersCard() ? [] : state.queue.filter((q) => q.e.start <= state.year && lg(q.e.start) - now < wait);
  const k = state.queue.findIndex((q) => q.ready || t - q.since > 1500);
  if (k >= 0 && (!state.story || wasRead(state.story))) tell(state.queue.splice(k, 1)[0].e);
  return t - (state.story?.born ?? -1e9) < PING_MS;
}

function tell(e) {
  endStory();
  openCard(e, true);
  drift(e);
  const st = { e, fromPlay: state.playing, born: performance.now(), left: currentReel().stops.has(e) ? FEATURE_MS : NOTE_MS };
  st.total = st.left;
  state.story = st;
  runStory(st);
}

// stories that open during playback live on playback time: pausing freezes them
function runStory(st) {
  st.paused = false;
  st.due = performance.now() + st.left;
  st.timer = setTimeout(() => state.story === st && closeCard(), st.left);
}
function freezeStory(st) {
  clearTimeout(st.timer);
  st.left = Math.max(0, st.due - performance.now());
  st.paused = true;
}
function endStory() {
  if (state.story) clearTimeout(state.story.timer);
  state.story = null;
}

// the line from the card to its event's pin, drawn under the pins and the card:
// an s-curve leaving the pin sideways (upwards on a phone, where the card is below).
// it meets the card where the card rests (not where its entrance animation has it), at
// a point that doesn't move as the card's picture and text load in (the card stands on
// the dock, so that's measured from its foot), and it draws itself
// from the pin to the card as the card appears
const PING_MS = 2200, TETHER_MS = 380;
function drawTether() {
  const e = state.selected, card = state.quiz ? $("quiz") : $("card");
  if (!e || card.hidden) return;
  const at = screenAt(e.lon, e.lat, 0.12);
  if (!at) return;
  const [x, y] = at, phone = innerWidth < 600;
  const r = { left: card.offsetLeft, top: card.offsetTop, right: card.offsetLeft + card.offsetWidth, bottom: card.offsetTop + card.offsetHeight };
  if (x > r.left - 12 && x < r.right + 12 && y > r.top - 12 && y < r.bottom + 12) return; // under the card
  const ax = phone ? clamp(x, r.left + 28, r.right - 28) : x < r.left ? r.left : r.right;
  const ay = phone ? (y < r.top ? r.top : r.bottom) : clamp(y, Math.max(r.top + 30, r.bottom - 150), r.bottom - 40);
  const c1 = phone ? [x, (y + ay) / 2] : [(x + ax) / 2, y], c2 = phone ? [ax, (y + ay) / 2] : [(x + ax) / 2, ay];
  const grow = ease(clamp((performance.now() - state.cardAt) / TETHER_MS, 0, 1));
  let length = 0; // of the curve, for drawing part of it
  for (let i = 1, px = x, py = y; i <= 16; i++) {
    const t = i / 16, u = 1 - t;
    const qx = u * u * u * x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * ax;
    const qy = u * u * u * y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * ay;
    length += Math.hypot(qx - px, qy - py);
    px = qx; py = qy;
  }
  const color = colors.kinds?.[e.kind] ?? colors.accent;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = 0.8;
  if (grow < 1) ctx.setLineDash([length * grow, length + 1]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], ax, ay);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = clamp((grow - 0.8) / 0.2, 0, 1);
  ctx.beginPath();
  ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
  ctx.fill();
  // a new story rings out from its pin
  const age = (performance.now() - (state.story?.e === e ? state.story.born : -1e9)) / PING_MS;
  for (const lag of [0, 0.3]) {
    const t = age - lag;
    if (t <= 0 || t >= 0.7) continue;
    ctx.globalAlpha = 1 - t / 0.7;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 10 + 46 * (t / 0.7), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// --- timeline & playback ---------------------------------------------------------------

// the eras of world history, at their conventional dates (where one really ended and the
// next began varies from place to place). each has a colour, --era-0 … in style.css: the
// timeline's bars take their era's colour, and the era is named over the handle
const ERAS = [
  { from: MIN_YEAR, name: "Bronze Age" },
  { from: -1200, name: "Iron Age" },
  { from: -500, name: "Classical antiquity" },
  { from: 500, name: "Post-classical era" },
  { from: 1500, name: "Early modern era" },
  { from: 1800, name: "Modern era" },
  { from: 1945, name: "Contemporary era" },
];
const eraOf = (y) => ERAS.findLast((e) => y >= e.from) ?? ERAS[0];

function buildTicks() {
  for (const y of [-3000, -2000, -1000, 1, 500, 1000, 1500, 2000]) {
    const s = document.createElement("span");
    s.className = [-2000, 500, 1500].includes(y) ? "era minor" : "era";
    s.style.left = `${toPos(y) * 100}%`;
    s.textContent = y === 1 ? "1 ce" : y < 0 ? `${-y} bce` : y;
    if (y === MIN_YEAR) s.classList.add("start");
    $("ticks").append(s);
  }
}

// along the track, how much happened when: a bar for every few pixels, as tall as the
// (log of the) weight of the events in it, and only what's in focus during a focus.
// each bar is in its era's colour, strong where it's been played
const density = { bins: null };
function drawDensity() {
  $("track").classList.toggle("ruler", rulerOn()); // the quiz on a phone draws the timeline its own way
  if (rulerOn()) return drawRuler();
  const cv = $("density"), w = cv.clientWidth, h = cv.clientHeight, r = devicePixelRatio || 1;
  if (!w || !state.events.length) return;
  if (!density.bins || density.w !== w || density.focus !== state.focus) {
    const n = Math.floor(w / 3), bins = new Float32Array(n);
    for (const e of state.events) {
      if (e.start < MIN_YEAR || e.start > MAX_YEAR || !inFocus(e)) continue;
      bins[Math.min(n - 1, Math.floor(toPos(e.start) * n))] += Math.min(e.weight, 400);
    }
    const top = Math.log1p(Math.max(...bins) / 20);
    Object.assign(density, { bins: bins.map((v) => (v ? Math.max(0.06, Math.log1p(v / 20) / top) : 0)), w, focus: state.focus });
    fitCanvas(cv, Math.round(w * r), Math.round(h * r));
  }
  const c = cv.getContext("2d"), { bins } = density, bw = w / bins.length, played = state.pos * bins.length;
  c.setTransform(r, 0, 0, r, 0, 0);
  c.clearRect(0, 0, w, h);
  for (let i = 0; i < bins.length; i++) {
    if (!bins[i]) continue;
    c.fillStyle = colors.eras[ERAS.indexOf(eraOf(toYear((i + 0.5) / bins.length)))] || colors.accent;
    c.globalAlpha = i < played ? 0.85 : 0.3;
    const bh = Math.max(1.5, bins[i] * h);
    c.fillRect(i * bw, h - bh, bw - 1, bh);
  }
  c.globalAlpha = 1;
}

// hovering the track marks the spot under the pointer
$("track").addEventListener("pointermove", (ev) => {
  if (ev.pointerType !== "mouse") return;
  const peek = $("peek");
  peek.style.left = `${trackPos(ev) * 100}%`;
  peek.hidden = false;
});
$("track").addEventListener("pointerleave", () => ($("peek").hidden = true));

// the era's name rides over the handle, kept inside the track (on a phone it sits in the
// row above instead, beside the year); it pulses on entering a new era
let eraShown = null;
function placeEraTag(y) {
  const tag = $("era-tag"), era = eraOf(y), w = $("track").clientWidth;
  if (era !== eraShown) {
    tag.querySelector("span").textContent = era.name;
    tag.style.setProperty("--era", `var(--era-${ERAS.indexOf(era)})`);
    if (eraShown) tag.animate([{ scale: 1.12 }, { scale: 1 }], { duration: 450, easing: "ease-out" });
    eraShown = era;
  }
  if (innerWidth < 600) return tag.style.removeProperty("left");
  const half = tag.offsetWidth / 2;
  tag.style.left = `${clamp(state.pos * w, half, w - half)}px`;
}

// the year in the dock: big numerals, the era small
function showYear(y) {
  const out = $("year");
  out.textContent = y < 0 ? (-y).toLocaleString() : y;
  out.append(Object.assign(document.createElement("small"), { textContent: y < 0 ? "bce" : "ce" }));
}

let hashTimer = 0;
function applyYear(year) {
  const prev = state.year;
  state.year = year;
  $("handle").style.left = `${state.pos * 100}%`;
  placeEraTag(year);
  if (state.quiz) syncGuess(year); // quiz.js: while asking, the timeline is the guess
  drawDensity();
  invalidate();
  if (year === prev && state.wanted !== null) return;

  showYear(year);
  $("track").setAttribute("aria-valuetext", fmt(year));
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => { try { history.replaceState(null, "", `#${state.year}`); } catch {} }, 250);
  if (state.wanted !== null) notify(prev, year);
  if (!state.plain || revealing) syncBorders(year);
}

function syncBorders(year) {
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
  if (state.quiz) on = false;
  if (on && state.focus && state.year >= state.focus.to) setYear(state.focus.from); // replay the focus
  else if (on && state.pos >= 1) setYear(MIN_YEAR); // replay from the start
  if (on !== state.playing) {
    const st = state.story;
    if (st?.fromPlay) on ? runStory(st) : freezeStory(st);
  }
  state.playing = on;
  $("play").setAttribute("aria-pressed", on);
  $("play").setAttribute("aria-label", on ? "pause" : "play");
  invalidate();
}

// a quiet stretch, with no story due for a while (before much was written down, say),
// plays faster once the story up has been read: up to QUIET_MAX× as fast, easing back
// to normal as the next story nears, so a long gap takes seconds rather than minutes
const QUIET_S = 1.2, QUIET_MAX = 10;
function quietness(rate) {
  const st = state.story;
  if (st?.fromPlay && !wasRead(st)) return 1;
  const end = state.focus ? Math.min(state.focus.to, MAX_YEAR) : MAX_YEAR;
  const next = Math.min(currentReel().order.find((e) => e.start > state.year)?.start ?? end, end);
  const ahead = (lg(state.year) - lg(next)) / (rate * state.speed); // seconds till the next story, as things stand
  return clamp(ahead / QUIET_S, 1, QUIET_MAX);
}

// playback slows while a fresh note is being read, nearly stops at a guided stop, and
// hurries through quiet stretches
function stepPlay(dt) {
  if (!state.playing) return false;
  const t = performance.now(), fresh = !!state.story?.fromPlay && t - state.story.born < 1200;
  const rate = state.focus ? state.focus.rate : PACE;
  const target = state.stop || holding(rate) ? 0.04 : fresh ? 0.5 : quietness(rate);
  state.ease += (target - state.ease) * (1 - Math.exp(-dt * (target < state.ease ? 6 : 4)));
  setPos(toPos(lgShift(toYear(state.pos), dt * rate * state.speed * state.ease)));
  stepStop(dt);
  if (state.pos >= 1 || (state.focus && state.year >= state.focus.to)) setPlaying(false);
  return state.playing;
}

// play or pause, as asked for (the button or space): playback starting is counted
function togglePlay() {
  if (!state.playing && !state.quiz) trackEvent("Play", { era: eraOf(state.year).name });
  setPlaying(!state.playing);
}
$("play").onclick = togglePlay;
$("contribute").addEventListener("click", () => trackEvent("Contribute"));
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
  if (rulerOn()) return rulerDown(ev);
  setPos(trackPos(ev));
  const move = (e) => setPos(trackPos(e));
  $("track").addEventListener("pointermove", move);
  $("track").addEventListener("pointerup", () => $("track").removeEventListener("pointermove", move), { once: true });
});

// the quiz on a phone: a stretch of the timeline that swipes under a fixed handle in the
// middle, so a thumb can set the year exactly. it's on the log scale playback uses, with
// as many pixels for a year now as for a few decades in antiquity, the way the quiz scores
const RULER_SPAN = 0.7; // log-years across the track: 35 years around 2000, a century around 1900, millennia in the bronze age
const RULER_STEPS = [1, 5, 10, 50, 100, 500, 1000];
const rulerOn = () => !!state.quiz && innerWidth < 600;

function drawRuler() {
  const cv = $("ruler"), w = cv.clientWidth, h = cv.clientHeight, r = devicePixelRatio || 1;
  if (!w) return;
  fitCanvas(cv, Math.round(w * r), Math.round(h * r));
  const c = cv.getContext("2d"), k = w / RULER_SPAN, at = lg(toYear(state.pos)), line = 30;
  const x = (y) => w / 2 + (at - lg(y)) * k;
  const yearAt = (px) => PRESENT - Math.exp(at - (px - w / 2) / k);
  const from = Math.max(MIN_YEAR, yearAt(0)), to = Math.min(MAX_YEAR, yearAt(w));
  c.setTransform(r, 0, 0, r, 0, 0);
  c.clearRect(0, 0, w, h);
  c.lineWidth = 3; // the baseline, in each era's colour
  ERAS.forEach((era, i) => {
    const a = Math.max(from, era.from), b = Math.min(to, ERAS[i + 1]?.from ?? MAX_YEAR);
    if (a >= b) return;
    c.strokeStyle = colors.eras[i];
    c.beginPath(); c.moveTo(x(a), line); c.lineTo(x(b), line); c.stroke();
  });
  // a tick wherever there's room (8px), and a year on one every 64px
  const step = (y, px) => RULER_STEPS.find((s) => (s * k) / (PRESENT - y) >= px) ?? RULER_STEPS.at(-1);
  const inc = step(to, 8); // the finest step, at the right-hand (most recent) end
  c.font = `italic 13px ${colors.serif}`;
  c.textAlign = "center";
  for (let y = Math.ceil(from / inc) * inc; y <= to; y += inc) {
    if (y % step(y, 8)) continue;
    const major = y % step(y, 64) === 0, px = x(y || 1); // there's no year 0: 1 ce
    c.fillStyle = colors.ink;
    c.globalAlpha = major ? 0.55 : 0.3;
    c.fillRect(Math.round(px) - 0.5, line - (major ? 11 : 6), 1, major ? 11 : 6);
    c.globalAlpha = 1;
    if (major) {
      c.fillStyle = colors.muted;
      c.fillText(y === 0 ? "1 ce" : y < 0 ? `${-y} bce` : y, px, line + 17);
    }
  }
  if (state.quiz?.phase === "answer") { // the guess, left behind as the answer comes to the middle
    const gx = x(state.quiz.round.guess);
    c.strokeStyle = colors.ink;
    c.globalAlpha = 0.55;
    c.lineWidth = 2;
    c.setLineDash([2, 2]);
    c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, line); c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
    c.fillStyle = colors.badge;
    c.beginPath(); c.arc(gx, line, 5, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 0.55; c.stroke(); c.globalAlpha = 1;
  }
  c.fillStyle = colors.accent; // the handle, and its knob on the baseline
  c.fillRect(w / 2 - 1, 0, 2, line);
  c.beginPath(); c.arc(w / 2, line, 6.5, 0, Math.PI * 2); c.fill();
  c.strokeStyle = colors.badge;
  c.lineWidth = 2;
  c.stroke();
}

// the timeline goes to a log-year set on the ruler. false at either end
function rulerSet(g) {
  const y = clamp(PRESENT - Math.exp(g), MIN_YEAR, MAX_YEAR);
  state.pos = toPos(y);
  applyYear(roundYear(y));
  return y > MIN_YEAR && y < MAX_YEAR;
}

// runs step(ms since the last frame) every frame until it returns false, then settles the
// ruler on the year in the middle. a new round, answer or touch cancels it
let rulerFrame = 0;
function rulerGlide(step) {
  cancelAnimationFrame(rulerFrame);
  const { round, phase } = state.quiz;
  let t = performance.now();
  const frame = (now) => {
    const dt = now - t;
    t = now;
    if (!rulerOn() || state.quiz.round !== round || state.quiz.phase !== phase) return;
    if (step(dt)) rulerFrame = requestAnimationFrame(frame);
    else setYear(state.year);
  };
  rulerFrame = requestAnimationFrame(frame);
}

// the year follows the finger and, let go, keeps going and slows; a tap brings the year
// tapped to the middle
function rulerDown(ev) {
  cancelAnimationFrame(rulerFrame);
  const track = $("track"), k = track.clientWidth / RULER_SPAN, g0 = lg(toYear(state.pos)), x0 = ev.clientX, t0 = ev.timeStamp;
  let lastX = x0, lastT = t0, v = 0, pending = 0; // px per ms
  const move = (e) => {
    const dt = e.timeStamp - lastT;
    if (dt > 0) v = 0.8 * ((e.clientX - lastX) / dt) + 0.2 * v;
    lastX = e.clientX;
    lastT = e.timeStamp;
    pending ||= requestAnimationFrame(() => { pending = 0; rulerSet(g0 + (lastX - x0) / k); }); // a touch can move faster than frames
  };
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", (e) => {
    track.removeEventListener("pointermove", move);
    cancelAnimationFrame(pending);
    if (Math.abs(e.clientX - x0) < 6 && e.timeStamp - t0 < 300) {
      const r = track.getBoundingClientRect(), to = g0 - (e.clientX - r.left - r.width / 2) / k;
      let t = 0;
      return rulerGlide((dt) => { t = Math.min(1, t + dt / 350); rulerSet(g0 + (to - g0) * ease(t)); return t < 1; });
    }
    if (e.timeStamp - lastT > 80) v = 0; // held still before letting go
    let g = lg(toYear(state.pos));
    rulerGlide((dt) => { g += (v * dt) / k; v *= Math.exp(-dt / 325); return rulerSet(g) && Math.abs(v) > 0.02; });
  }, { once: true });
}

// scrolling over the timeline scrubs through time
document.querySelector("footer").addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  setPos(toPos(lgShift(toYear(state.pos), d * (ev.deltaMode === 1 ? 16 : 1) * 0.0008)));
}, { passive: false });

addEventListener("keydown", (ev) => {
  if (ev.key === " " && !(ev.target instanceof HTMLButtonElement)) {
    ev.preventDefault();
    return togglePlay();
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
  if (state.plain) return null;
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
    const { cx, cy } = globe.on ? globeArea() : mapArea(), z = b.dataset.zoom;
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

function fillCard({ meta, title, related = [], kind }) {
  const card = $("card"), img = card.querySelector("img"), desc = card.querySelector(".desc"), m = card.querySelector(".meta");
  m.textContent = meta;
  if (kind) { // an event: its kind, in its colour, then when
    m.innerHTML = `${kindSvg(kind)}<span class="kind-name"></span><span class="when"></span>`;
    m.querySelector(".kind-name").textContent = kind;
    m.querySelector(".when").textContent = meta;
  }
  card.style.setProperty("--kind", kind ? `var(--k-${kind})` : "var(--accent)");
  card.querySelector("h2").textContent = title;
  card.querySelector(".wiki").hidden = true;
  img.onload = img.onerror = null; // the last card's picture may still be loading
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
  if (card.hidden || card.dataset.title !== title) {
    card.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: "ease-out" });
    state.cardAt = performance.now(); // its line draws in with it (drawTether)
  }
  card.dataset.title = title;
  card.hidden = false;
  card.scrollTop = 0;
  invalidate();
}

// the card's picture: 500px wide where the original is big enough
const cardImage = (s) => s?.thumbnail && ((s.originalimage?.width ?? 0) >= 500 ? s.thumbnail.source.replace(/\/\d+px-/, "/500px-") : s.thumbnail.source);

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
    const big = cardImage(s) === s.thumbnail.source ? null : cardImage(s);
    img.onerror = () => { if (big && img.src !== s.thumbnail.source) img.src = s.thumbnail.source; else img.hidden = true; };
    img.onload = () => { img.hidden = false; invalidate(); }; // the tether follows the card's size
    img.src = big ?? s.thumbnail.source;
  }
}

// an event's card: told by the reel (story), or opened by the reader, which ends any story
async function openCard(e, story = false) {
  if (state.quiz) return; // it would tell the date
  if (!story) endStory();
  $("card").classList.toggle("compact", story);
  const when = e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
  fillCard({ meta: `${e.approx ? "c. " : ""}${when}`, title: e.title, kind: e.kind });
  state.selected = e;
  state.selectedRealm = null;
  if (!e.wiki) return fillSummary(null);
  const s = await summary(e.wiki);
  if (state.selected === e) fillSummary(s, e.wiki); // unless another card was opened meanwhile
}

// a territory: what it was, who it answered to, and the biggest events inside it
// while these borders stood
async function openRealm(f) {
  if (state.quiz) return;
  const i = state.snapshots.indexOf(state.wanted), from = state.wanted, until = state.snapshots[i + 1] ?? MAX_YEAR;
  wctx.setTransform(1, 0, 0, 1, 0, 0); // the paths are in projected units
  const inside = state.events
    .filter((e) => e.start >= from && e.start < until)
    .filter((e) => { const [x, y] = project(e.lon, e.lat); return wctx.isPointInPath(f.path, x, y); })
    .slice(0, 6) // heaviest first already
    .sort((a, b) => a.start - b.start);
  const under = (f.subject && f.subject !== f.name ? ` · under ${f.subject}` : "") + (f.rough ? " · borders approximate" : "");
  endStory();
  $("card").classList.remove("compact");
  fillCard({ meta: `${fmt(from)} – ${fmt(until)}${under}`, title: f.name, related: inside });
  state.selected = null;
  state.selectedRealm = f;
  // a name that came from cliopatria brings its wikipedia article with it
  const s = f.wiki ? await summaryOf(f.wiki) : await realmArticle(f.name, from);
  if (state.selectedRealm === f) fillSummary(s);
}

function closeCard() {
  endStory();
  $("card").hidden = true;
  state.selectedRealm = null;
  if (!state.quiz) state.selected = null; // the quiz's event stays pinned
  invalidate();
}
$("close").onclick = closeCard;
// touching a story keeps it: it becomes the reader's card, in full
$("card").addEventListener("pointerdown", () => {
  endStory();
  $("card").classList.remove("compact");
  invalidate();
});
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
  document.fonts.addEventListener("loadingdone", () => { layerDirty = true; placeEraTag(state.year); invalidate(); });
  readColors();
  buildTicks();
  // resized, rotated, or a phone's keyboard coming and going (which may not resize the
  // window, but leaves the page scrolled): once a frame at most
  let resizing = false;
  const queueResize = () => {
    if (resizing) return;
    resizing = true;
    requestAnimationFrame(() => {
      resizing = false;
      if ((scrollX || scrollY) && (!visualViewport || visualViewport.height >= innerHeight - 1)) scrollTo(0, 0);
      resize();
    });
  };
  addEventListener("resize", queueResize);
  window.visualViewport?.addEventListener("resize", queueResize);
  new ResizeObserver(queueResize).observe(canvas);
  dark.addEventListener("change", () => { readColors(); drawDensity(); viewChanged(); });
  resize();
  const fromHash = () => {
    const y = parseInt(location.hash.slice(1), 10);
    setYear(Number.isFinite(y) && y !== 0 ? y : state.year);
  };
  addEventListener("hashchange", fromHash);
  fromHash();
  restoreGlobe();
  (window.requestIdleCallback ?? setTimeout)(() => currentReel()); // chosen ahead of the first play
})();
