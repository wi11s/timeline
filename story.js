// world timeline: telling the story. camera flights, guided stops at the biggest
// moments, and focuses: a region or a topic with its own stretch of time, framed
// on the map and played at its own pace. focuses live in data/focuses.json.

const STOP_MS = 4000;   // how long a guided stop holds (playback time)
const FOCUS_S = 90;     // how long a focus plays at 1×, unless it says otherwise

// --- camera ----------------------------------------------------------------------------
// the camera is a centre (longitude, latitude) and a zoom, in either view

function cameraNow() {
  if (globe.on) return { lon: globe.lon, lat: globe.lat, k: globe.k };
  const s = base.s * view.k, { cx, cy } = mapArea();
  const [lon, lat] = unproject((cx - base.x - view.x) / s, (cy - base.y - view.y) / s);
  return { lon, lat, k: view.k };
}

function setCamera(lon, lat, k) {
  lon = ((lon + 540) % 360) - 180;
  if (globe.on) Object.assign(globe, { lon, lat: clamp(lat, -80, 80), k: clamp(k, 0.6, MAX_ZOOM), goalK: null });
  else {
    k = clamp(k, minZoom, MAX_ZOOM);
    const s = base.s * k, [px, py] = project(lon, lat), { cx, cy } = mapArea();
    Object.assign(view, { k, x: cx - base.x - px * s, y: cy - base.y - py * s });
    clampView(view);
  }
  viewChanged();
}

// glide there, pulling back a little on long hops so you see where you're going
function flyTo(lon, lat, k, dur = 1700, pull = 0.9) {
  goal = fling = null;
  state.flight = { from: cameraNow(), to: { lon, lat, k }, start: performance.now(), dur, pull };
  invalidate();
}

function stepFlight() {
  const f = state.flight;
  if (!f) return false;
  const t = ease(Math.min(1, (performance.now() - f.start) / f.dur)), { from: a, to: b } = f;
  const dlon = ((b.lon - a.lon + 540) % 360) - 180, hop = Math.min(1, Math.hypot(dlon, b.lat - a.lat) / 100);
  const lk = Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t - f.pull * hop * Math.sin(Math.PI * t);
  setCamera(a.lon + dlon * t, a.lat + (b.lat - a.lat) * t, Math.exp(lk));
  if (t >= 1) state.flight = null;
  return true;
}

// the user took the controls: stop flying, and don't fly anywhere for a while
function userSteers() {
  state.flight = null;
  state.userAt = performance.now();
  if (state.stop) state.stop.home = null; // stay where they put us
}

// --- guided stops ------------------------------------------------------------------------
// playing (the timeline or a focus), the biggest moments get a stop: the camera flies in, playback
// all but halts while the note is read, then the camera returns and playback goes on

const zoomFor = () => (globe.on ? 2.6 : 3.4);

function guide(e) {
  if (!state.playing || state.stop) return;
  if (performance.now() - state.userAt < 8000) return; // they're steering
  state.stop = { e, home: cameraNow(), left: STOP_MS };
  flyTo(e.lon, e.lat, Math.max(cameraNow().k, zoomFor()));
}

function stepStop(dt) {
  const st = state.stop;
  if (!st) return;
  st.left -= dt * 1000;
  if (st.left > 0) return;
  state.stop = null;
  if (st.home) flyTo(st.home.lon, st.home.lat, st.home.k, 1400);
}

// each new story nudges the camera: the globe turns enough to bring its event well onto
// the near side and a little further, the flat map pans it well into view, and both
// zoom a touch: in for a story close to where the camera is, out for one far away (a
// focus keeps its own zoom). it waits while the reader steers. the big moments get a fly-in (guide)
function drift(e) {
  if (!state.playing || state.stop || state.flight) return;
  if (performance.now() - state.userAt < 8000) return; // they're steering
  const c = cameraNow(), rad = Math.PI / 180, dlon = ((e.lon - c.lon + 540) % 360) - 180;
  const d = Math.acos(clamp(Math.sin(c.lat * rad) * Math.sin(e.lat * rad) +
    Math.cos(c.lat * rad) * Math.cos(e.lat * rad) * Math.cos(dlon * rad), -1, 1)) / rad; // degrees away
  const k = state.focus ? c.k + (state.focus.zoom - c.k) * 0.3 :
    globe.on ? clamp(1.5 - d / 150, 1.05, innerWidth < 600 ? 1.15 : 1.45) : clamp(2 - d / 110, 1.2, innerWidth < 600 ? 1.5 : 1.9);
  if (globe.on) {
    const f = Math.min(1, Math.max(0, (d - 40) / d) + 0.25);
    return flyTo(c.lon + dlon * f, c.lat + (e.lat - c.lat) * f, k, 1400, 0.25);
  }
  const at = screenAt(e.lon, e.lat), { cx, cy, w, h } = mapArea();
  const ix = clamp(at[0], cx - w * 0.3, cx + w * 0.3), iy = clamp(at[1], cy - h * 0.3, cy + h * 0.3);
  const sx = cx + (at[0] - ix) + (ix - cx) * 0.25, sy = cy + (at[1] - iy) + (iy - cy) * 0.25, s = base.s * view.k;
  const [lon, lat] = unproject((sx - base.x - view.x) / s, (sy - base.y - view.y) / s);
  flyTo(lon, lat, k, 1400, 0.25);
}

try { localStorage.removeItem("guided"); } catch {} // the old guided toggle's setting

// --- focuses -----------------------------------------------------------------------------

let focuses = [];
fetch("data/focuses.json").then((r) => r.json()).then((list) => {
  focuses = list;
  for (const group of ["stories", "regions"]) {
    const ul = $("explore").querySelector(`[data-group="${group}"]`);
    ul.replaceChildren(...list.filter((f) => f.group === group).map((f) => {
      const li = document.createElement("li"), b = document.createElement("button");
      b.innerHTML = "<b></b><small></small><span></span>";
      b.querySelector("b").textContent = f.title;
      b.querySelector("small").textContent = `${fmt(f.from)} – ${f.to >= MAX_YEAR ? "today" : fmt(f.to)}`;
      b.querySelector("span").textContent = f.blurb;
      b.onclick = () => startFocus(f);
      li.append(b);
      return li;
    }));
  }
}).catch(() => { $("explore-toggle").hidden = true; });

function startFocus(f) {
  closeExplore();
  closeCard();
  state.queue = [];
  state.stop = null;
  // a focus plays its whole stretch in about FOCUS_S seconds, in log-years like everything else
  const seconds = f.seconds ?? FOCUS_S, to = Math.min(f.to, MAX_YEAR);
  state.focus = { ...f, rate: (lg(f.from) - lg(to)) / seconds };
  state.focus.reel = buildReel({ from: f.from, to, rate: state.focus.rate, keep: inFocus, stops: () => true, fits: seconds / 2.5 });
  const chip = $("focus-chip");
  chip.querySelector("b").textContent = f.title;
  chip.querySelector("small").textContent = `${fmt(f.from)} – ${f.to >= MAX_YEAR ? "today" : fmt(f.to)}`;
  chip.hidden = false;
  const band = $("band");
  band.style.left = `${toPos(f.from) * 100}%`;
  band.style.width = `${(toPos(Math.min(f.to, MAX_YEAR)) - toPos(f.from)) * 100}%`;
  band.hidden = false;
  setYear(f.from);
  drawDensity();
  layerDirty = true;
  flyTo(f.lon, f.lat, globe.on ? f.zoom * 0.8 + 0.2 : f.zoom, 1900);
  state.userAt = -1e9;
  setTimeout(() => state.focus?.id === f.id && setPlaying(true), 1200);
}

// --- the reel ------------------------------------------------------------------------------
// stories are told one at a time, so what plays is chosen ahead: the most interesting events,
// at least REEL_S seconds of playback apart (playback then waits while each is read,
// see holding() in app.js). a pick that would
// repeat a neighbour (the same kind of event, or the same part of the world) counts for
// less, so it keeps moving. the strongest few, STOP_S apart, are guided stops. normal
// playback has one reel for all of history; each focus makes its own

const REEL_S = 0.9, STOP_S = 15;
const REEL_WEIGHT = 50; // what an event needs to play outside a focus

// on its own: how widely it's written about, less for the routine "x founded". the
// hand-picked turning points (data/events.json) are always among the strongest
const CURATED = { 1: 300, 2: 160, 3: 60 };
const interest = (e) => (e.curated ? Math.max(e.weight, CURATED[e.importance]) + e.weight * 0.2 : e.weight) *
  (e.title.endsWith(" founded") ? 0.3 : 1);
// the hand-picked turning points may sit closer together than other picks: playback
// waits for each to be read anyway
const turning = (e) => e.curated && e.importance === 1;
const nearby = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat) < 15;

// `fits`: how many stories there's time for. a focus with no more events than that plays
// every one of them, however close together (playback waits for each to be read)
function buildReel({ from, to, rate, minWeight = 0, keep = () => true, stops = featured, fits = 0 }) {
  const pool = [];
  for (const e of state.events) {
    if (e.start >= from && e.start <= to && (e.weight >= minWeight || e.curated) && keep(e)) pool.push({ e, t: lg(e.start), s: interest(e) });
  }
  const gap = pool.length <= fits ? 0 : REEL_S * rate;
  // the finale (data/events.json) is the last story: picked first, with nothing after it
  const finale = pool.find((c) => c.e.finale);
  if (finale) for (const c of pool) if (c !== finale && c.e.start >= finale.e.start) c.out = true;
  // greedy: take the best that still fits, again and again, judging each against the
  // picks either side of it. whatever's too close to a pick stays out
  const picks = finale ? [Object.assign(finale, { out: true })] : [];
  for (;;) {
    let best = null, bestS = 0;
    for (const c of pool) {
      if (c.out) continue;
      let before = null, after = null;
      for (const p of picks) {
        if (Math.abs(p.t - c.t) < gap * (turning(p.e) && turning(c.e) ? 0.4 : 1)) { c.out = true; break; }
        if (p.t > c.t ? !before || p.t < before.t : !after || p.t > after.t) p.t > c.t ? (before = p) : (after = p);
      }
      if (c.out) continue;
      let s = c.s;
      if (!turning(c.e)) for (const p of [before, after]) { // turning points are never repeats
        if (p && Math.abs(p.t - c.t) < gap * 3) s *= (p.e.kind === c.e.kind ? 0.7 : 1) * (nearby(p.e, c.e) ? 0.7 : 1);
      }
      if (s > bestS) { best = c; bestS = s; }
    }
    if (!best) break;
    best.out = true;
    best.s = bestS;
    picks.push(best);
  }
  const chosen = [];
  for (const p of picks) { // strongest first
    if (stops(p.e) && chosen.every((q) => Math.abs(q.t - p.t) >= STOP_S * rate)) chosen.push(p);
  }
  return {
    order: picks.map((p) => p.e).sort((a, b) => a.start - b.start),
    score: new Map(picks.map((p) => [p.e, p.s])),
    stops: new Set(chosen.map((p) => p.e)),
  };
}

let mainReel = null;
const currentReel = () => state.focus?.reel ??
  (mainReel ??= buildReel({ from: MIN_YEAR, to: MAX_YEAR, rate: PACE, minWeight: REEL_WEIGHT }));

function endFocus() {
  state.focus = null;
  state.queue = [];
  $("focus-chip").hidden = true;
  $("band").hidden = true;
  drawDensity();
  layerDirty = true;
  invalidate();
}
$("focus-chip").querySelector("button").onclick = endFocus;

// --- the explore panel ---------------------------------------------------------------------

// a key to the pins' glyphs
$("explore").querySelector(".key").innerHTML = Object.keys(KIND_ICONS)
  .map((k) => `<span>${kindSvg(k)}${k}</span>`).join("");

function openExplore() {
  closeCard();
  $("explore").hidden = false;
  $("explore-toggle").setAttribute("aria-expanded", true);
  $("explore").querySelector("button")?.focus({ preventScroll: true });
  invalidate();
}
function closeExplore() {
  $("explore").hidden = true;
  $("explore-toggle").setAttribute("aria-expanded", false);
  invalidate();
}
$("explore-toggle").onclick = () => ($("explore").hidden ? openExplore() : closeExplore());
$("explore").querySelector(".close").onclick = closeExplore;
addEventListener("keydown", (ev) => ev.key === "Escape" && closeExplore());
canvas.addEventListener("pointerdown", () => !$("explore").hidden && closeExplore());
