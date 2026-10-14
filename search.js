// world timeline: search. type part of an event's name, or a year ("1066", "44 bce");
// choosing a result jumps to its year, flies to it and opens its card. "/" (or ⌘K) focuses the box from anywhere.

const RESULTS = 8;
const searchBox = $("search"), searchInput = searchBox.querySelector("input"), resultList = $("results");

// lower case, accents off: "Mohács" is found by "mohacs". one unit per
// code point of the title, so a match in the key is the same span of the title
const fold = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const keyOf = (title) => [...title].map((c) => { const f = fold(c); return f.length === 1 ? f : c.length === 1 ? c : "\0"; }).join("");
const WORD = /[\p{L}\p{N}]/u;

// where a token matches: the first place it starts a word, else the first place at all
function matchAt(key, t) {
  const first = key.indexOf(t);
  for (let i = first; i >= 0; i = key.indexOf(t, i + 1)) if (i === 0 || !WORD.test(key[i - 1])) return { i, word: true };
  return { i: first, word: false };
}

// every word of the query must match. famous events first, then matches that start
// words, then the title starting with the query; an exact title beats everything.
// a year finds what happened that year
function search(query) {
  const q = fold(query).trim().replace(/\s+/g, " ");
  if (!q) return [];
  const tokens = q.split(" "), hits = [], y = q.match(/^(\d{1,4}) ?(bce?|ce|ad)?$/);
  const year = y && (y[2]?.startsWith("bc") ? -y[1] : +y[1]);
  for (const e of state.events) {
    if (e.start < MIN_YEAR || e.start > MAX_YEAR) continue; // before the map begins
    if (e.start === year) { hits.push({ e, score: Math.log(e.weight + 1) + 3, tokens: [] }); continue; }
    const key = (e.key ??= keyOf(e.title));
    let score = Math.log(e.weight + 1);
    for (const t of tokens) {
      const m = matchAt(key, t);
      if (m.i < 0 || (!m.word && t.length < 3)) { score = null; break; }
      if (m.word) score += 1;
    }
    if (score === null) continue;
    if (key === q) score += 4;
    else if (key.startsWith(q)) score += 1.5;
    hits.push({ e, score, tokens });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, RESULTS);
}

// the title, with the matched words marked
function marked(title, key, tokens) {
  const chars = [...title], on = new Array(chars.length).fill(false);
  for (const t of tokens) {
    const { i } = matchAt(key, t);
    for (let j = i; j < i + t.length; j++) on[j] = true;
  }
  const out = [];
  for (let j = 0; j < chars.length;) {
    let k = j;
    while (k < chars.length && on[k] === on[j]) k++;
    const text = chars.slice(j, k).join("");
    if (on[j]) { const m = document.createElement("mark"); m.textContent = text; out.push(m); }
    else out.push(text);
    j = k;
  }
  return out;
}

let found = [], chosen = 0;

function showResults() {
  found = search(searchInput.value);
  chosen = 0;
  if (!searchInput.value.trim()) return closeResults();
  resultList.replaceChildren(...(found.length ? found.map(({ e, tokens }, i) => {
    const li = document.createElement("li"), when = e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
    li.id = `result-${i}`;
    li.setAttribute("role", "option");
    li.innerHTML = `${kindSvg(e.kind)}<span><b></b><small></small></span>`;
    li.querySelector("b").append(...marked(e.title, e.key, tokens));
    li.querySelector("small").textContent = `${e.approx ? "c. " : ""}${when} · ${e.kind}`;
    li.onclick = () => goToEvent(e);
    li.onpointermove = () => activate(i);
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "none", textContent: "no events match" })]));
  activate(0);
  // under the box, as wide as it needs to be, kept on screen
  const r = searchBox.getBoundingClientRect(), w = Math.min(innerWidth - 24, Math.max(r.width, 380));
  Object.assign(resultList.style, { top: `${r.bottom + 6}px`, left: `${clamp(r.left, 12, innerWidth - 12 - w)}px`, width: `${w}px` });
  resultList.hidden = false;
  searchInput.setAttribute("aria-expanded", true);
}

function activate(i) {
  if (!found.length) return searchInput.removeAttribute("aria-activedescendant");
  chosen = (i + found.length) % found.length;
  for (const [j, li] of [...resultList.children].entries()) li.setAttribute("aria-selected", j === chosen);
  searchInput.setAttribute("aria-activedescendant", `result-${chosen}`);
  resultList.children[chosen].scrollIntoView({ block: "nearest" });
}

function closeResults() {
  resultList.hidden = true;
  searchInput.setAttribute("aria-expanded", false);
  searchInput.removeAttribute("aria-activedescendant");
}

// leave whatever was playing, go to the year, fly there and open the card
function goToEvent(e) {
  searchInput.value = "";
  closeResults();
  searchInput.blur();
  closeExplore();
  if (state.focus) endFocus();
  setPlaying(false);
  state.stop = null;
  state.queue = [];
  setYear(e.start);
  openCard(e);
  flyTo(e.lon, e.lat, Math.max(cameraNow().k, zoomFor()));
}

searchInput.addEventListener("input", showResults);
searchInput.addEventListener("focus", () => { closeExplore(); if (searchInput.value.trim()) showResults(); });
searchInput.addEventListener("keydown", (ev) => {
  ev.stopPropagation(); // typing isn't play/pause, scrubbing or the globe key
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (resultList.hidden) showResults();
    else activate(chosen + (ev.key === "ArrowDown" ? 1 : -1));
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    if (found[chosen]) goToEvent(found[chosen].e);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    if (searchInput.value) { searchInput.value = ""; closeResults(); }
    else searchInput.blur();
  }
});
// keep the focus in the box while a result is clicked; close when tabbing away or
// pressing anywhere else (a tap on a result blurs the box first on phones, so not on blur)
resultList.addEventListener("mousedown", (ev) => ev.preventDefault());
searchInput.addEventListener("focusout", (ev) => ev.relatedTarget && !resultList.contains(ev.relatedTarget) && closeResults());
addEventListener("pointerdown", (ev) => !searchBox.contains(ev.target) && !resultList.contains(ev.target) && closeResults());
addEventListener("resize", () => !resultList.hidden && showResults());

addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.key === "/" || (ev.key === "k" && (ev.metaKey || ev.ctrlKey))) {
    ev.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
