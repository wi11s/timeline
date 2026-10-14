// world timeline: the 3d globe. no 3d library: a webgl2 fragment shader works out,
// for each pixel of the disc, which longitude and latitude it looks at (an
// orthographic globe, as a camera far away sees it) and samples a plain
// longitude/latitude picture of the map. app.js draws the labels, pins and notes
// on top, placing them with globeScreen(). the picture is redrawn when the borders
// change, and the old one cross-fades into the new.

const TEX_W = 4096, TEX_H = 2048, GLOBE_FADE_MS = 700;
const gcanvas = document.getElementById("globe");
const tex2d = document.createElement("canvas"), tctx = tex2d.getContext("2d");
tex2d.width = TEX_W;
tex2d.height = TEX_H;
const G = { gl: null, uniforms: {}, textures: [], cur: 0, painted: null, fade: null, restyle: false };

// --- geometry ------------------------------------------------------------------------

function globeArea() {
  const h = innerHeight - (innerWidth < 600 ? 110 : 90);
  return { cx: innerWidth / 2, cy: h / 2 + 8, r: Math.min(innerWidth, h) * 0.44 };
}
const globeRadius = () => globeArea().r * globe.k;

// the rotation taking the viewer's line of sight (0, 0, 1) to the globe's centre:
// tilt to the centre's latitude, then turn to its longitude. world axes: x through
// 90°e, y through the north pole, z through 0°, 0°
let matrixFor = null, matrix = null;
function globeMatrix() {
  if (matrixFor !== `${globe.lon},${globe.lat}`) {
    const a = (globe.lat * Math.PI) / 180, b = (globe.lon * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    matrix = [cb, -sb * sa, sb * ca, 0, ca, sa, -sb, -cb * sa, cb * ca]; // rows
    matrixFor = `${globe.lon},${globe.lat}`;
  }
  return matrix;
}

// longitude/latitude -> screen, or null on the far side. `edge` keeps things away
// from the rim, where they'd be foreshortened to nothing
function globeScreen(lon, lat, edge = 0.02) {
  const m = globeMatrix(), la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const wx = Math.cos(la) * Math.sin(lo), wy = Math.sin(la), wz = Math.cos(la) * Math.cos(lo);
  const z = m[2] * wx + m[5] * wy + m[8] * wz;
  if (z < edge) return null;
  const { cx, cy } = globeArea(), r = globeRadius();
  return [cx + r * (m[0] * wx + m[3] * wy + m[6] * wz), cy - r * (m[1] * wx + m[4] * wy + m[7] * wz)];
}

// screen -> [longitude, latitude], or null off the globe
function globeGeo(x, y) {
  const { cx, cy } = globeArea(), r = globeRadius(), m = globeMatrix();
  const px = (x - cx) / r, py = (cy - y) / r, d2 = px * px + py * py;
  if (d2 > 1) return null;
  const pz = Math.sqrt(1 - d2);
  const wx = m[0] * px + m[1] * py + m[2] * pz, wy = m[3] * px + m[4] * py + m[5] * pz, wz = m[6] * px + m[7] * py + m[8] * pz;
  return [(Math.atan2(wx, wz) * 180) / Math.PI, (Math.asin(clamp(wy, -1, 1)) * 180) / Math.PI];
}

// equal earth, backwards: for keeping the same place in view when switching
function unproject(x, y) {
  let t = -y / A1;
  for (let i = 0; i < 12; i++) {
    const t2 = t * t, t6 = t2 * t2 * t2;
    t -= (t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) + y) / (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2));
  }
  const t2 = t * t, t6 = t2 * t2 * t2;
  const lon = (x * M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))) / Math.cos(t);
  return [clamp((lon * 180) / Math.PI, -180, 180), (Math.asin(clamp(Math.sin(t) / M, -1, 1)) * 180) / Math.PI];
}

// --- the picture -------------------------------------------------------------------------
// the flat map's atlas style, drawn in plain longitude/latitude (x is longitude,
// y is minus latitude) at a fixed size. line widths are in texture pixels

function paintTexture(feats) {
  const c = tctx, k = TEX_W / 360;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = colors.bg;
  c.fillRect(0, 0, TEX_W, TEX_H);
  c.setTransform(k, 0, 0, k, TEX_W / 2, TEX_H / 2);
  c.lineJoin = c.lineCap = "round";
  const strokes = [[30, colors.coast, 1], [28, colors.bg, 1], [17, colors.coast, 1], [15, colors.bg, 1], [8, colors.coast, 0.35]];
  for (const [w, color, a] of strokes) { // the water lines
    c.globalAlpha = a;
    c.strokeStyle = color;
    c.lineWidth = w / k;
    c.stroke(feats.geoCoast);
  }
  c.globalAlpha = 1;
  paintTerritories(c, feats, ROUGH_DEG, "geo");
  if (physical.reliefGlobe) {
    c.save();
    c.globalCompositeOperation = "soft-light";
    c.globalAlpha = dark.matches ? 0.9 : 0.75;
    c.drawImage(physical.reliefGlobe, -180, -90, 360, 180);
    c.restore();
  }
  c.fillStyle = colors.bg;
  c.strokeStyle = colors.coast;
  c.lineWidth = 1.2 / k;
  for (const l of physical.lakes) {
    if (l.rank > 6) continue;
    c.fill(l.geo);
    c.stroke(l.geo);
  }
  c.strokeStyle = colors.river;
  for (const r of physical.rivers) {
    if (r.rank > 5) continue;
    c.lineWidth = (clamp(1.7 - r.rank * 0.2, 0.6, 1.7) * 1.8) / k;
    c.stroke(r.geo);
  }
  c.strokeStyle = colors.line;
  c.lineWidth = 1.4 / k;
  for (const f of feats) if (!f.rough) c.stroke(f.geo);
}

function upload(slot) {
  const gl = G.gl;
  gl.bindTexture(gl.TEXTURE_2D, G.textures[slot]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex2d);
  gl.generateMipmap(gl.TEXTURE_2D);
}

// the borders changed (or, with `restyle`, the colours or relief did)
function globeStale(restyle = false) {
  if (restyle) G.restyle = true;
  invalidate();
}

// --- webgl -----------------------------------------------------------------------------

const VERTEX = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D before, after;
uniform float fade, radius;
uniform vec2 centre;
uniform mat3 turn;
uniform vec3 space, glow;
out vec4 color;
const float PI = 3.14159265;
void main() {
  vec2 p = (gl_FragCoord.xy - centre) / radius;
  float d = length(p), px = 1.0 / radius;
  vec3 v = vec3(p, sqrt(max(0.0, 1.0 - d * d)));        // the point on the globe facing us
  vec3 w = turn * v;                                     // ... and where that is on earth
  vec2 uv = vec2(atan(w.x, w.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(w.y, -1.0, 1.0)) / PI);
  // the texture wraps at 180°: take derivatives from a copy that wraps at 0° instead
  // where that's smoother, or the mipmapping draws a seam
  vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
  if (abs(dx2.x) < abs(dx.x)) dx = dx2;
  if (abs(dy2.x) < abs(dy.x)) dy = dy2;
  vec3 land = mix(textureGrad(before, uv, dx, dy).rgb, textureGrad(after, uv, dx, dy).rgb, fade);
  float light = 0.8 + 0.2 * v.z + 0.07 * dot(v, normalize(vec3(-0.5, 0.6, 0.6)));
  float halo = d > 1.0 ? exp(-(d - 1.0) * 24.0) : 0.0;  // a thin haze of atmosphere
  vec3 outside = mix(space, glow, 0.55 * halo);
  color = vec4(mix(outside, land * light, smoothstep(1.0 + px, 1.0 - px, d)), 1.0);
}`;

function rgb(css) {
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  c.fillStyle = css;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

function initGl() {
  const gl = gcanvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return false;
  const shader = (kind, src) => {
    const s = gl.createShader(kind);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covers the screen
  const corner = gl.getAttribLocation(prog, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  for (const name of ["before", "after", "fade", "radius", "centre", "turn", "space", "glow"]) G.uniforms[name] = gl.getUniformLocation(prog, name);
  G.textures = [0, 1].map((unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  });
  const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
  if (anisotropy) for (const t of G.textures) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 8); // crisp towards the rim
  }
  G.gl = gl;
  return true;
}

const globeBusy = () => !!G.fade;

function globeRender() {
  const gl = G.gl;
  if (!gl || !state.shown) return;
  if (gcanvas.width !== canvas.width || gcanvas.height !== canvas.height) {
    gcanvas.width = canvas.width;
    gcanvas.height = canvas.height;
  }
  // a new map: paint it into the other texture and fade across. a restyle repaints in place
  if (G.painted !== state.shown) {
    if (G.fade) G.cur = G.fade.to;
    paintTexture(state.shown);
    const to = G.painted ? 1 - G.cur : G.cur;
    gl.activeTexture(gl.TEXTURE0 + to);
    upload(to);
    G.fade = G.painted ? { to, start: performance.now() } : null;
    G.painted = state.shown;
    G.restyle = false;
  } else if (G.restyle) {
    paintTexture(state.shown);
    const slot = G.fade ? G.fade.to : G.cur;
    gl.activeTexture(gl.TEXTURE0 + slot);
    upload(slot);
    G.restyle = false;
  }
  let t = 1, from = G.cur, to = G.cur;
  if (G.fade) {
    t = ease(Math.min(1, (performance.now() - G.fade.start) / GLOBE_FADE_MS));
    to = G.fade.to;
    if (t >= 1) { G.cur = to; from = to; G.fade = null; }
  }
  const { cx, cy } = globeArea(), m = globeMatrix(), u = G.uniforms;
  gl.viewport(0, 0, gcanvas.width, gcanvas.height);
  gl.uniform1i(u.before, from);
  gl.uniform1i(u.after, to);
  gl.uniform1f(u.fade, t);
  gl.uniform1f(u.radius, globeRadius() * dpr);
  gl.uniform2f(u.centre, cx * dpr, gcanvas.height - cy * dpr);
  gl.uniformMatrix3fv(u.turn, true, m); // rows in, so transpose
  gl.uniform3fv(u.space, rgb(colors.space));
  gl.uniform3fv(u.glow, rgb(colors.accent));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// the hovered and selected territory, outlined on the near side only
function globeHighlight() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.strokeStyle = colors.accent;
  for (const [f, w, a] of [[state.hoverRealm, 1.3, 0.45], [state.selectedRealm, 2, 0.85]]) {
    if (!f || !state.shown?.includes(f)) continue;
    ctx.globalAlpha = a;
    ctx.lineWidth = w;
    ctx.setLineDash(f.rough ? [5, 4] : []);
    ctx.beginPath();
    for (const ring of f.rings) {
      let pen = false;
      for (let i = 0; i < ring.length; i += 2) {
        const p = globeScreen(ring[i], ring[i + 1]);
        if (!p) { pen = false; continue; }
        pen ? ctx.lineTo(...p) : ctx.moveTo(...p);
        pen = true;
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// --- switching -------------------------------------------------------------------------

const globeToggle = $("globe-toggle");
if (!window.WebGL2RenderingContext) globeToggle.hidden = true;

// keep the same place in the middle of the screen, at the same zoom level: the
// whole flat world becomes the whole globe
function setGlobe(on) {
  if (on === globe.on) return;
  if (on && !G.gl && !initGl()) { globeToggle.hidden = true; return; }
  const { cx, cy } = globeArea();
  if (on) {
    const s = base.s * view.k;
    const [lon, lat] = unproject((cx - base.x - view.x) / s, (cy - base.y - view.y) / s);
    Object.assign(globe, { lon, lat: clamp(lat, -60, 70), k: clamp(view.k, 0.6, MAX_ZOOM), goalK: null });
    G.painted = null; // repaint: the borders may have changed while it was hidden
  } else {
    const k = clamp(globe.k, minZoom, MAX_ZOOM), s = base.s * k, [px, py] = project(globe.lon, globe.lat);
    Object.assign(view, { k, x: cx - base.x - px * s, y: cy - base.y - py * s });
    clampView(view);
    layerDirty = true;
    coastAt = null;
  }
  globe.on = on;
  goal = fling = null;
  state.transition = null;
  state.labelHits = [];
  document.body.classList.toggle("globe", on);
  globeToggle.setAttribute("aria-pressed", on);
  globeToggle.querySelector("span").textContent = on ? "flat map" : "globe";
  try { localStorage.setItem("view", on ? "globe" : "flat"); } catch {}
  viewChanged();
}

globeToggle.onclick = () => setGlobe(!globe.on);
addEventListener("keydown", (ev) => {
  if (ev.key === "g" && !ev.metaKey && !ev.ctrlKey && !(ev.target instanceof HTMLInputElement)) setGlobe(!globe.on);
});

// called by app.js once the map is set up
function restoreGlobe() {
  try { if (localStorage.getItem("view") === "globe") setGlobe(true); } catch {}
}
