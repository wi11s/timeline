// world timeline: telling the story. camera flights, guided stops at the biggest
// moments, and focuses: a region or a topic with its own stretch of time, framed
// on the map and played at its own pace. focuses live in data/focuses.json.

const STOP_MS = 6000;   // how long a guided stop holds (playback time)
const FOCUS_S = 90;     // how long a focus plays at 1×, unless it says otherwise

// --- camera ----------------------------------------------------------------------------
// the camera is a centre (longitude, latitude) and a zoom, in either view

function cameraNow() {
  if (globe.on) return { lon: globe.lon, lat: globe.lat, k: globe.k };
  const s = base.s * view.k, { cx, cy } = globeArea();
  const [lon, lat] = unproject((cx - base.x - view.x) / s, (cy - base.y - view.y) / s);
  return { lon, lat, k: view.k };
}

function setCamera(lon, lat, k) {
  lon = ((lon + 540) % 360) - 180;
  if (globe.on) Object.assign(globe, { lon, lat: clamp(lat, -80, 80), k: clamp(k, 0.6, MAX_ZOOM), goalK: null });
  else {
    k = clamp(k, minZoom, MAX_ZOOM);
    const s = base.s * k, [px, py] = project(lon, lat), { cx, cy } = globeArea();
    Object.assign(view, { k, x: cx - base.x - px * s, y: cy - base.y - py * s });
    clampView(view);
  }
  viewChanged();
}

// glide there, pulling back a little on long hops so you see where you're going
function flyTo(lon, lat, k, dur = 1700) {
  goal = fling = null;
  state.flight = { from: cameraNow(), to: { lon, lat, k }, start: performance.now(), dur };
  invalidate();
}

function stepFlight() {
  const f = state.flight;
  if (!f) return false;
  const t = ease(Math.min(1, (performance.now() - f.start) / f.dur)), { from: a, to: b } = f;
  const dlon = ((b.lon - a.lon + 540) % 360) - 180, hop = Math.min(1, Math.hypot(dlon, b.lat - a.lat) / 100);
  const lk = Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t - 0.9 * hop * Math.sin(Math.PI * t);
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
// playing in guided mode, the biggest moments get a stop: the camera flies in, playback
// all but halts while the note is read, then the camera returns and playback goes on

const zoomFor = () => (globe.on ? 2.6 : 3.4);

function guide(e) {
  if (!state.guided || !state.playing || state.stop) return;
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

function setGuided(on) {
  state.guided = on;
  $("guided").setAttribute("aria-pressed", on);
  if (!on && state.stop) state.stop.left = 0;
  try { localStorage.setItem("guided", on ? "on" : "off"); } catch {}
}
$("guided").onclick = () => setGuided(!state.guided);
try { if (localStorage.getItem("guided") === "off") setGuided(false); } catch {}

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
  for (const n of [...state.notes]) dismiss(n, true);
  state.queue = [];
  state.stop = null;
  // a focus plays its whole stretch in about FOCUS_S seconds, in log-years like everything else
  const seconds = f.seconds ?? FOCUS_S, to = Math.min(f.to, MAX_YEAR);
  state.focus = { ...f, rate: (lg(f.from) - lg(to)) / seconds };
  pickNotes(state.focus, seconds, to);
  const chip = $("focus-chip");
  chip.querySelector("b").textContent = f.title;
  chip.querySelector("small").textContent = `${fmt(f.from)} – ${f.to >= MAX_YEAR ? "today" : fmt(f.to)}`;
  chip.hidden = false;
  const band = $("band");
  band.style.left = `${toPos(f.from) * 100}%`;
  band.style.width = `${(toPos(Math.min(f.to, MAX_YEAR)) - toPos(f.from)) * 100}%`;
  band.hidden = false;
  setYear(f.from);
  layerDirty = true;
  flyTo(f.lon, f.lat, globe.on ? f.zoom * 0.8 + 0.2 : f.zoom, 1900);
  state.userAt = -1e9;
  setTimeout(() => state.focus?.id === f.id && setPlaying(true), 1200);
}

// a focus chooses its notes in advance, so they come at a steady pace: playback is cut
// into beats (by log-years, as it plays), each beat gets its most important event, and
// beats with nothing are made up from the strongest left over. the biggest few become
// guided stops
function pickNotes(f, seconds, to) {
  const span = lg(f.from) - lg(to), beats = Math.max(4, Math.round(seconds / BEAT_S));
  const pool = state.events.filter((e) => e.start >= f.from && e.start <= to && inFocus(e)); // heaviest first
  const picks = new Set(), taken = new Set();
  for (const e of pool) {
    const beat = Math.min(beats - 1, Math.floor(((lg(f.from) - lg(e.start)) / span) * beats));
    if (!taken.has(beat)) { taken.add(beat); picks.add(e); }
  }
  for (const e of pool) {
    if (picks.size >= beats) break;
    picks.add(e);
  }
  f.picks = picks;
  f.stops = new Set([...picks].slice(0, 4)); // pool order: the heaviest picks
}

function endFocus() {
  state.focus = null;
  state.queue = [];
  $("focus-chip").hidden = true;
  $("band").hidden = true;
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
