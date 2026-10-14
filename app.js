// world timeline: equal earth map + log-scale timeline. no dependencies.

const MIN_YEAR = -123000, MAX_YEAR = 2010, PRESENT = 2050;
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

const state = {
  year: 1453,
  snapshots: [],        // available border years
  borders: new Map(),   // year -> prepared features
  shown: null,          // features currently drawn
  shownYear: null,
  events: [],
  view: { k: 1, x: 0, y: 0 },
  hoverEvent: null,
};

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
const sphere = (() => {
  const p = new Path2D();
  for (let lat = -90; lat <= 90; lat += 2) p.lineTo(...project(180, lat));
  for (let lat = 90; lat >= -90; lat -= 2) p.lineTo(...project(-180, lat));
  p.closePath();
  return p;
})();

// --- time scale: log of years-before-PRESENT --------------------------------

const lg = (y) => Math.log(PRESENT - y);
const toPos = (y) => (lg(MIN_YEAR) - lg(y)) / (lg(MIN_YEAR) - lg(MAX_YEAR));
const toYear = (p) => PRESENT - Math.exp(lg(MIN_YEAR) - p * (lg(MIN_YEAR) - lg(MAX_YEAR)));

function roundYear(y) {
  const step = y < -10000 ? 1000 : y < -3000 ? 100 : y < 0 ? 10 : 1;
  const r = Math.round(y / step) * step;
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, r === 0 ? 1 : r));
}
const fmt = (y) => (y < 0 ? `${(-y).toLocaleString()} BCE` : y < 1000 ? `${y} CE` : `${y}`);

// --- data --------------------------------------------------------------------

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function prepare(geojson) {
  return geojson.features.map(({ properties: p, geometry }) => {
    const path = new Path2D();
    let best = { area: 0 };
    for (const poly of geometry.coordinates) {
      poly.forEach((ring, i) => {
        let area = 0, cx = 0, cy = 0, prev = null;
        for (const [lon, lat] of ring) {
          const pt = project(lon, lat);
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
    return { name: p.name, path, label: best, hue: p.name ? hue(p.name) : null };
  });
}

async function loadBorders(year) {
  if (!state.borders.has(year)) {
    state.borders.set(year, fetch(`data/borders/${year}.json`).then((r) => r.json()).then(prepare));
  }
  return state.borders.get(year);
}

const snapshotFor = (y) => state.snapshots.filter((s) => s <= y).at(-1) ?? state.snapshots[0];

// --- rendering -----------------------------------------------------------------

const dark = matchMedia("(prefers-color-scheme: dark)");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let dpr = 1, base = { s: 1, x: 0, y: 0 };

function resize() {
  dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const h = innerHeight - 90, pad = 16;
  const s = Math.min((innerWidth - pad * 2) / 5.43, (h - pad * 2) / 2.64);
  base = { s, x: innerWidth / 2, y: h / 2 + 8 };
  draw();
}

function transform() {
  const { k, x, y } = state.view, s = base.s * k;
  return [s * dpr, 0, 0, s * dpr, (base.x + x) * dpr, (base.y + y) * dpr];
}
const toScreen = ([px, py]) => {
  const { k, x, y } = state.view;
  return [base.x + x + px * base.s * k, base.y + y + py * base.s * k];
};

function visibleEvents() {
  const from = snapshotFor(state.year);
  return state.events.filter((e) => e.start <= state.year && (e.end ?? e.start) >= Math.min(from, state.year));
}

function draw() {
  const t = transform(), scale = base.s * state.view.k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(...t);

  ctx.fillStyle = css("--sea");
  ctx.fill(sphere);

  const light = !dark.matches;
  ctx.lineWidth = 0.6 / scale;
  ctx.strokeStyle = css("--line");
  for (const f of state.shown ?? []) {
    ctx.fillStyle = f.hue === null ? css("--land")
      : light ? `hsl(${f.hue} 32% 80%)` : `hsl(${f.hue} 22% 30%)`;
    ctx.fill(f.path);
    ctx.stroke(f.path);
  }
  ctx.stroke(sphere);

  // labels for polities big enough on screen
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css("--ink");
  ctx.globalAlpha = 0.55;
  ctx.textAlign = "center";
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  const placed = [];
  const big = (state.shown ?? []).filter((f) => f.name && f.label.area * scale * scale > 2500);
  for (const f of big.sort((a, b) => b.label.area - a.label.area)) {
    const [x, y] = toScreen([f.label.x, f.label.y]);
    const w = ctx.measureText(f.name).width / 2 + 4, box = [x - w, y - 12, x + w, y + 4];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    ctx.fillText(f.name, x, y);
  }
  ctx.globalAlpha = 1;

  // event pins: recent ones solid, older ones within the era faded
  for (const e of visibleEvents()) {
    const [x, y] = toScreen(project(e.lon, e.lat));
    const age = (state.year - (e.end ?? e.start)) / Math.max(1, state.year - snapshotFor(state.year));
    ctx.globalAlpha = Math.max(0.35, 1 - Math.max(0, age) * 0.65);
    ctx.beginPath();
    ctx.arc(x, y, e === state.hoverEvent ? 8 : 7 - e.importance, 0, Math.PI * 2);
    ctx.fillStyle = css("--accent");
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = css("--bg");
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// --- timeline ------------------------------------------------------------------

function buildTicks() {
  const ticks = $("ticks");
  for (const e of state.events) {
    const s = document.createElement("span");
    s.className = `i${e.importance}`;
    s.style.left = `${toPos(e.start) * 100}%`;
    s.title = `${e.title}, ${fmt(e.start)}`;
    ticks.append(s);
  }
  for (const y of [-100000, -10000, -3000, -1000, 1, 1000, 1500, 1800, 1900, 2000]) {
    const s = document.createElement("span");
    s.className = [-10000, 1, 1500, 2000].includes(y) ? "era" : "era minor";
    s.style.left = `${toPos(y) * 100}%`;
    s.textContent = y === 1 ? "0" : y < 0 ? `${-y / 1000}k bce` : y;
    ticks.append(s);
  }
}

async function setYear(y) {
  state.year = roundYear(y);
  $("year").textContent = fmt(state.year);
  $("handle").style.left = `${toPos(state.year) * 100}%`;
  $("track").setAttribute("aria-valuetext", fmt(state.year));
  try { history.replaceState(null, "", `#${state.year}`); } catch {}

  const snap = snapshotFor(state.year);
  if (snap !== state.shownYear) {
    const feats = await loadBorders(snap);
    if (snapshotFor(state.year) !== snap) return; // slider moved on while loading
    state.shown = feats;
    state.shownYear = snap;
    const i = state.snapshots.indexOf(snap); // prefetch neighbours
    [state.snapshots[i - 1], state.snapshots[i + 1]].forEach((s) => s && loadBorders(s));
  }
  draw();
}

function trackYear(ev) {
  const r = $("track").getBoundingClientRect();
  return toYear(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)));
}

$("track").addEventListener("pointerdown", (ev) => {
  $("track").setPointerCapture(ev.pointerId);
  setYear(trackYear(ev));
  const move = (e) => setYear(trackYear(e));
  $("track").addEventListener("pointermove", move);
  $("track").addEventListener("pointerup", () => $("track").removeEventListener("pointermove", move), { once: true });
});

addEventListener("keydown", (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  const dir = ev.key === "ArrowRight" ? 1 : -1;
  if (ev.shiftKey) { // jump between border snapshots
    const i = state.snapshots.indexOf(snapshotFor(state.year));
    const next = state.snapshots[Math.min(state.snapshots.length - 1, Math.max(0, i + dir))];
    return setYear(next);
  }
  const step = state.year < -10000 ? 1000 : state.year < -3000 ? 100 : state.year < 0 ? 10 : 1;
  let y = state.year + dir * step;
  if (y === 0) y = dir;
  setYear(y);
});

// --- map interaction -------------------------------------------------------------

function eventAt(x, y) {
  return visibleEvents().find((e) => {
    const [ex, ey] = toScreen(project(e.lon, e.lat));
    return Math.hypot(ex - x, ey - y) < 10;
  });
}

function polityAt(x, y) {
  ctx.setTransform(...transform());
  const hit = [...(state.shown ?? [])].reverse().find((f) => ctx.isPointInPath(f.path, x * dpr, y * dpr));
  return hit?.name;
}

let drag = null;
canvas.addEventListener("pointerdown", (ev) => {
  drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener("pointermove", (ev) => {
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) {
      canvas.classList.add("dragging");
      state.view.x = drag.vx + dx;
      state.view.y = drag.vy + dy;
      draw();
    }
    return;
  }
  const e = eventAt(ev.clientX, ev.clientY);
  if (e !== state.hoverEvent) { state.hoverEvent = e; draw(); }
  canvas.style.cursor = e ? "pointer" : "";
  $("hover").textContent = e ? e.title : polityAt(ev.clientX, ev.clientY) ?? "";
});
canvas.addEventListener("pointerup", (ev) => {
  canvas.classList.remove("dragging");
  if (drag && !drag.moved) {
    const e = eventAt(ev.clientX, ev.clientY);
    e ? openCard(e) : ($("card").hidden = true);
  }
  drag = null;
});
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const k = Math.min(40, Math.max(1, state.view.k * Math.exp(-ev.deltaY * 0.0015)));
  const f = k / state.view.k, ox = ev.clientX - base.x, oy = ev.clientY - base.y;
  state.view.x = ox - (ox - state.view.x) * f;
  state.view.y = oy - (oy - state.view.y) * f;
  state.view.k = k;
  draw();
}, { passive: false });

function openCard(e) {
  const card = $("card");
  const when = e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
  card.querySelector(".meta").textContent = `${e.approx ? "c. " : ""}${when} · ${e.kind}`;
  card.querySelector("h2").textContent = e.title;
  const a = card.querySelector("a");
  a.href = e.wiki ?? "";
  a.hidden = !e.wiki;
  card.hidden = false;
}
$("close").onclick = () => ($("card").hidden = true);

// --- boot --------------------------------------------------------------------------

(async () => {
  [state.snapshots, state.events] = await Promise.all([
    fetch("data/borders/index.json").then((r) => r.json()),
    fetch("data/events.json").then((r) => r.json()),
  ]);
  buildTicks();
  addEventListener("resize", resize);
  dark.addEventListener("change", draw);
  resize();
  const fromHash = () => {
    const y = parseInt(location.hash.slice(1), 10);
    setYear(Number.isFinite(y) && y !== 0 ? y : state.year);
  };
  addEventListener("hashchange", fromHash);
  fromHash();
})();
