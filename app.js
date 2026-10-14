// world timeline: equal earth map + log-scale timeline. no dependencies.

const MIN_YEAR = -123000, MAX_YEAR = 2025, PRESENT = 2050;
const PLAY_RATE = 1 / 150;   // timeline fraction per second at 1×
const SPEEDS = [0.5, 1, 2, 4];
const LINGER = 0.02;         // timeline fraction a pin stays (fading) after its event ends
const NOTIFY_WEIGHT = 80;    // sitelinks an event needs to pop a notification
const NOTE_MS = 4500;
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
  selected: null,       // event shown in the card
  transition: null,
};
const view = { k: 1, x: 0, y: 0 };

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

// --- time scale: log of years-before-PRESENT --------------------------------

const lg = (y) => Math.log(PRESENT - y);
const toPos = (y) => (lg(MIN_YEAR) - lg(y)) / (lg(MIN_YEAR) - lg(MAX_YEAR));
const toYear = (p) => PRESENT - Math.exp(lg(MIN_YEAR) - p * (lg(MIN_YEAR) - lg(MAX_YEAR)));
const stepAt = (y) => (y < -10000 ? 1000 : y < -3000 ? 100 : y < 0 ? 10 : 1);

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
    let best = { area: 0 };
    for (const poly of geometry.coordinates) {
      poly.forEach((ring, i) => {
        let area = 0, cx = 0, cy = 0, prev = null;
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
          best = { area: Math.abs(area) / 2, x: cx / (3 * area), y: cy / (3 * area) };
        }
      });
    }
    return { name: p.name, path, box, label: best, realm: p.name ? hash(p.name) % REALMS : null };
  });
  feats.coast = new Path2D(); // every outline at once, for the water lines
  for (const f of feats) feats.coast.addPath(f.path);
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
    e.weight = e.sitelinks ?? { 1: 150, 2: 70, 3: 30 }[e.importance];
    e.endPos = toPos(e.end ?? e.start);
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
  invalidate();
}

function zoomAt(sx, sy, factor, animate = true) {
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
  view.x += dx;
  view.y += dy;
  clampView(view);
  viewChanged();
}

function stepView(dt) {
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
    const stuck = view.x === x && view.y === y;
    if (stuck || Math.hypot(fling.vx, fling.vy) < 15) fling = null;
  }
  return !!(goal || fling);
}

function transform() {
  const s = base.s * view.k;
  return [s * dpr, 0, 0, s * dpr, (base.x + view.x) * dpr, (base.y + view.y) * dpr];
}
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
  if (!sameView(coastView, view) || !coastLines) renderCoast(from); // the water lines underneath
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
  if (tr && performance.now() - tr.start < 120) state.transition = null;
  else if (state.shown && state.shown !== feats) startTransition(state.shown, feats);
  state.shown = feats;
  layerDirty = true;
  invalidate();
}

// --- rendering -----------------------------------------------------------------

const dark = matchMedia("(prefers-color-scheme: dark)");
let colors = {};
function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const k of ["bg", "land", "line", "ink", "accent", "coast", "halo"]) colors[k] = css.getPropertyValue(`--${k}`).trim();
  colors.realms = Array.from({ length: REALMS }, (_, i) => css.getPropertyValue(`--realm-${i}`).trim());
  layerDirty = true;
  coastView = null;
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
  busy = stepView(dt) || busy;
  if (state.transition && progress(state.transition) >= 1) state.transition = null;
  busy ||= !!state.transition;
  draw();
  if (busy) invalidate();
}

function visibleEvents() {
  const { year, pos } = state;
  return state.events.filter((e) => e.start <= year && e.endPos >= pos - LINGER);
}

const fillOf = (f) => (f.realm === null ? colors.land : colors.realms[f.realm]);

// water lines: thin rings following every coast, as on an engraved map. each
// ring is a wide stroke in ink with a stroke 1px narrower in sea colour on top;
// then a little shading along the shore. expects the map transform to be set
// zoomed in, most of the world is off screen: skip it. `pad` covers the water lines
function onScreen(f, pad = 24) {
  const s = base.s * view.k, x = base.x + view.x, y = base.y + view.y, b = f.box;
  return x + b[2] * s > -pad && x + b[0] * s < innerWidth + pad && y + b[3] * s > -pad && y + b[1] * s < innerHeight + pad;
}

function paintCoast(c, feats) {
  if (!feats.coast) return;
  const s = base.s * view.k, spread = clamp(Math.sqrt(s / 260), 0.4, 1); // tighter on a small map
  const shown = feats.filter((f) => onScreen(f));
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
  for (const f of feats) {
    if (!onScreen(f)) continue;
    c.fillStyle = fillOf(f);
    c.fill(f.path);
  }
}

function strokeBorders(c, feats, alpha) {
  c.globalAlpha = alpha;
  c.lineWidth = 0.7 / (base.s * view.k);
  c.strokeStyle = colors.line;
  for (const f of feats) if (onScreen(f)) c.stroke(f.path);
  c.globalAlpha = 1;
}

const spaced = (c, px) => { if ("letterSpacing" in c) c.letterSpacing = `${px}px`; };

// italic, widely spaced, in the blue of the water lines. expects a css-pixel transform
function drawWaters(c) {
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
    c.fillText(name, ...toScreen(project(lon, lat)));
  }
  spaced(c, 0);
  c.globalAlpha = 1;
}

// realm names: big realms in spaced capitals sized to the realm, small ones in italics
function drawLabels(c, feats, alpha) {
  if (!feats || alpha <= 0) return;
  const scale = base.s * view.k, placed = [];
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  const big = feats.filter((f) => f.name && f.label.area * scale * scale > 1600 && onScreen(f, 0));
  for (const f of big.sort((a, b) => b.label.area - a.label.area)) {
    const [x, y] = toScreen([f.label.x, f.label.y]), room = Math.sqrt(f.label.area) * scale * 1.8;
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
}

// the map without pins is cached between frames, so playback only redraws pins.
// `coast` holds the sea and water lines alone; transitions draw land over it.
// the water lines are the slow part, so a map that's being panned or zoomed is
// drawn without them, and they come back once it settles
const layer = document.createElement("canvas"), lctx = layer.getContext("2d");
const coast = document.createElement("canvas"), cctx = coast.getContext("2d");
let layerDirty = true, layerView = null, layerLines = false, coastView = null, coastLines = false;
let lastMove = 0, settleTimer = 0;
const SETTLE_MS = 160;
const sameView = (a, b) => !!a && a.k === b.k && a.x === b.x && a.y === b.y;

function fit(c) {
  if (c.width !== canvas.width || c.height !== canvas.height) {
    c.width = canvas.width;
    c.height = canvas.height;
  }
}

function renderCoast(feats, lines = true) {
  fit(coast);
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.fillStyle = colors.bg; // the ocean goes on past the edge of the screen
  cctx.fillRect(0, 0, coast.width, coast.height);
  cctx.setTransform(...transform());
  if (lines) paintCoast(cctx, feats);
  coastView = { ...view };
  coastLines = lines;
}

function renderLayer(lines) {
  renderCoast(state.shown ?? [], lines);
  fit(layer);
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.drawImage(coast, 0, 0);
  lctx.setTransform(...transform());
  paintLand(lctx, state.shown ?? [], false);
  strokeBorders(lctx, state.shown ?? [], 1);
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWaters(lctx);
  drawLabels(lctx, state.shown, 1);
  layerView = { ...view };
  layerLines = lines;
  layerDirty = false;
}

function drawMap() {
  const moving = performance.now() - lastMove < SETTLE_MS;
  if (layerDirty || !sameView(layerView, view) || (!moving && !layerLines)) renderLayer(!moving);
  ctx.drawImage(layer, 0, 0);
  if (!layerLines) { // come back for the water lines
    clearTimeout(settleTimer);
    settleTimer = setTimeout(invalidate, SETTLE_MS + 20);
  }
}

// heaviest events first; lighter ones only where there's room
function drawPins() {
  const gap = 11, cap = Math.round(45 * Math.sqrt(view.k));
  const size = clamp(Math.sqrt((base.s * view.k) / 300), 0.55, 1); // smaller pins on a small map
  const noted = new Set([state.selected, ...state.notes.map((n) => n.e)].filter(Boolean));
  const candidates = [...noted, ...visibleEvents().filter((e) => !noted.has(e))];
  state.pins = [];
  for (const e of candidates) {
    if (state.pins.length >= cap) break;
    const [x, y] = toScreen(project(e.lon, e.lat));
    if (x < -10 || y < -10 || x > innerWidth + 10 || y > innerHeight + 10) continue;
    if (!noted.has(e) && state.pins.some((p) => Math.abs(p.x - x) < gap && Math.abs(p.y - y) < gap)) continue;
    const age = (state.pos - e.endPos) / LINGER;
    const r = (e === state.hoverEvent ? 2 : 0) + size * (e.importance === 1 ? 5.5 : e.importance === 2 ? 4.5 : 3.5);
    state.pins.push({ e, x, y, r, alpha: age > 0 ? 1 - age * 0.65 : 1 });
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.bg;
  ctx.fillStyle = colors.accent;
  for (const p of [...state.pins].reverse()) { // heaviest on top
    ctx.globalAlpha = p.alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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
  if (tr) {
    composite(tr, t);
    ctx.drawImage(coast, 0, 0);
    ctx.drawImage(work, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(...transform());
    strokeBorders(ctx, tr.from, 1 - t);
    strokeBorders(ctx, state.shown, t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWaters(ctx);
    drawLabels(ctx, tr.from, 1 - t);
    drawLabels(ctx, state.shown, t);
  } else drawMap();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPins();
  placeNotes();
}

// --- notifications -------------------------------------------------------------------
// big events pop a note on the map as the timeline moves forward past them

function notify(prev, year) {
  for (const n of state.notes) if (n.e.start > year) dismiss(n, true);
  if (year <= prev || toPos(year) - toPos(prev) > 0.05) return; // backwards, or a jump
  const crossed = state.events.filter((e) => e.weight >= NOTIFY_WEIGHT && e.start > prev && e.start <= year);
  for (const e of crossed.slice(0, 2)) addNote(e); // already heaviest first
}

function addNote(e) {
  if (state.notes.some((n) => n.e === e)) return;
  const el = document.createElement("div");
  el.className = "note";
  el.innerHTML = `<span class="leader" hidden></span><span class="ping"></span><button class="bubble"><small></small><b></b></button>`;
  el.querySelector("small").textContent = `${e.approx ? "c. " : ""}${fmt(e.start)} · ${e.kind}`;
  el.querySelector("b").textContent = e.title;
  el.querySelector("button").onclick = () => openCard(e);
  $("notes").append(el);
  const bubble = el.querySelector("button");
  // notes that pop up during playback live on playback time: pausing freezes them
  const note = {
    e, el, bubble, leader: el.querySelector(".leader"), w: bubble.offsetWidth, h: bubble.offsetHeight,
    spot: 0, fromPlay: state.playing, left: NOTE_MS,
  };
  runNote(note);
  state.notes.push(note);
  if (state.notes.length > (innerWidth < 600 ? 2 : 3)) dismiss(state.notes[0], true);
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
  if (now) note.el.remove();
  else {
    note.el.classList.add("out");
    setTimeout(() => note.el.remove(), 400);
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
  const W = innerWidth, H = innerHeight, pad = 8, gap = 4;
  const blocked = [rectOf($("contribute")), rectOf(document.querySelector("footer"))];
  if (!$("card").hidden) blocked.push(rectOf($("card")));
  const at = state.notes.map((n) => toScreen(project(n.e.lon, n.e.lat)));
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
      const box = [left, top, left + w, top + h];
      if ([...blocked, ...pings, ...placed].some((b) => overlaps(box, b))) continue;
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
  for (const y of [-100000, -10000, -3000, -1000, 1, 1000, 1500, 1800, 1900, 2000]) {
    const s = document.createElement("span");
    s.className = [-10000, 1, 1500, 2000].includes(y) ? "era" : "era minor";
    s.style.left = `${toPos(y) * 100}%`;
    s.textContent = y === 1 ? "0" : y < 0 ? `${-y / 1000}k bce` : y;
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
  if (on && state.pos >= 1) setYear(-10000); // replay from the neolithic
  if (on !== state.playing) {
    for (const n of state.notes) if (n.fromPlay) on ? runNote(n) : freezeNote(n);
  }
  state.playing = on;
  $("play").setAttribute("aria-pressed", on);
  $("play").setAttribute("aria-label", on ? "pause" : "play");
  invalidate();
}

function stepPlay(dt) {
  if (!state.playing) return false;
  setPos(state.pos + dt * PLAY_RATE * state.speed);
  if (state.pos >= 1) setPlaying(false);
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
  setPos(state.pos + d * (ev.deltaMode === 1 ? 16 : 1) * 0.0001);
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
  let best = null, bestD = touch ? 22 : 10;
  for (const p of state.pins) {
    const d = Math.hypot(p.x - x, p.y - y) - p.r;
    if (d < bestD) { best = p.e; bestD = d; }
  }
  return best;
}

function polityAt(x, y) {
  const s = base.s * view.k, wx = (x - base.x - view.x) / s, wy = (y - base.y - view.y) / s;
  ctx.setTransform(...transform());
  const hit = [...(state.shown ?? [])].reverse().find((f) =>
    wx >= f.box[0] && wx <= f.box[2] && wy >= f.box[1] && wy <= f.box[3] && ctx.isPointInPath(f.path, x * dpr, y * dpr));
  return hit?.name;
}

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
  if (e !== state.hoverEvent) { state.hoverEvent = e; invalidate(); }
  canvas.style.cursor = e ? "pointer" : "";
  $("hover").textContent = e ? e.title : polityAt(ev.clientX, ev.clientY) ?? "";
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
    e ? openCard(e) : closeCard();
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
  const unit = ev.deltaMode === 1 ? 16 : 1, dx = ev.deltaX * unit, dy = ev.deltaY * unit;
  if (ev.ctrlKey) return zoomAt(ev.clientX, ev.clientY, Math.exp(-dy * 0.01), false);
  if (dx !== 0 && !ev.shiftKey && ev.deltaMode === 0) trackpad = true;
  if (trackpad) {
    goal = fling = null;
    panBy(-dx, -dy);
  } else zoomAt(ev.clientX, ev.clientY, Math.exp(-dy * 0.002));
}, { passive: false });

canvas.addEventListener("dblclick", (ev) => zoomAt(ev.clientX, ev.clientY, ev.shiftKey ? 0.4 : 2.5));

// description and photo come from wikipedia's page summary api, fetched on demand
const summaries = new Map();
function summary(wiki) {
  let title = wiki.split("/wiki/")[1];
  try { title = decodeURIComponent(title); } catch {} // curated urls are escaped, wikidata ones aren't
  if (!summaries.has(title)) {
    summaries.set(title, fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return summaries.get(title);
}

async function openCard(e) {
  const card = $("card"), img = card.querySelector("img"), desc = card.querySelector(".desc");
  const when = e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
  card.querySelector(".meta").textContent = `${e.approx ? "c. " : ""}${when} · ${e.kind}`;
  card.querySelector("h2").textContent = e.title;
  const a = card.querySelector(".wiki");
  a.href = e.wiki ?? "";
  a.hidden = !e.wiki;
  img.hidden = true;
  img.removeAttribute("src");
  desc.textContent = e.wiki ? "loading…" : "";
  desc.classList.toggle("loading", !!e.wiki);
  card.hidden = false;
  card.scrollTop = 0;
  state.selected = e;
  invalidate();
  if (!e.wiki) return;

  const s = await summary(e.wiki);
  if (state.selected !== e) return; // another event was opened meanwhile
  desc.classList.remove("loading");
  desc.textContent = s?.type === "standard" ? s.extract : "";
  if (s?.thumbnail) {
    const big = (s.originalimage?.width ?? 0) >= 500 ? s.thumbnail.source.replace(/\/\d+px-/, "/500px-") : null;
    img.onerror = () => { if (big && img.src !== s.thumbnail.source) img.src = s.thumbnail.source; else img.hidden = true; };
    img.onload = () => (img.hidden = false);
    img.src = big ?? s.thumbnail.source;
  }
}
function closeCard() {
  $("card").hidden = true;
  state.selected = null;
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
})();
