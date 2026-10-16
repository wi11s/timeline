// world timeline: the quiz. ten events, one at a time: set the timeline to the year you
// think each happened (or type it) and guess. the closer, the more points, up to 1,000 a
// round; the map shows where each happened, and the answer jumps the timeline there.
// the best score is kept in this browser (localStorage)

const QUIZ_ROUNDS = 10, QUIZ_MAX = 1000;
const QUIZ_WEIGHT = 100;    // what an event needs to be asked about (the hand-picked ones always can)
const QUIZ_HORIZON = 2150;  // closeness is measured in log-years before this (see points)
const QUIZ_STRIP = 262;     // the panel's greatest height on a phone, which the map makes room for (mapArea)
const BEST_KEY = "quiz-best";

const quizPanel = $("quiz"), quizScreen = quizPanel.querySelector(".screen");
const thousands = (n) => n.toLocaleString("en");

// a title that names a year ("Revolutions of 1848") or any long number gives it away
const givesAway = (e) => /\d{3,}/.test(e.title) || new RegExp(`\\b${Math.abs(e.start)}\\b`).test(e.title);

// well-known events with an exact year, mixed: no more than three of a kind, or of an era
function pickRounds() {
  const pool = state.events.filter((e) => e.start >= MIN_YEAR && e.start <= MAX_YEAR && !e.approx && e.wiki &&
    (e.curated || e.weight >= QUIZ_WEIGHT) && !e.title.endsWith(" founded") && !givesAway(e));
  for (let i = pool.length - 1; i > 0; i--) { // shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = [];
  const room = (e) => picks.filter((p) => p.kind === e.kind).length < 3 && picks.filter((p) => eraOf(p.start) === eraOf(e.start)).length < 3;
  for (const e of pool) if (picks.length < QUIZ_ROUNDS && room(e)) picks.push(e);
  for (const e of pool) if (picks.length < QUIZ_ROUNDS && !picks.includes(e)) picks.push(e);
  return picks;
}

// how close, in log-years before QUIZ_HORIZON: being a few years off costs about as much
// for the iphone as a few decades for the pyramids
const points = (guess, year) => Math.round(QUIZ_MAX * Math.exp(-Math.abs(Math.log(QUIZ_HORIZON - guess) - Math.log(QUIZ_HORIZON - year)) / 0.15));
const verdict = (p) => (p >= 950 ? "Spot on" : p >= 750 ? "Very close" : p >= 450 ? "Close" : p >= 150 ? "Not far" : "Way off");

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function saveBest(score) {
  try { localStorage.setItem(BEST_KEY, String(score)); } catch {}
}

// --- screens -------------------------------------------------------------------------

function render(html) {
  quizScreen.innerHTML = html;
  quizPanel.scrollTop = 0;
}
const total = () => state.quiz.rounds.reduce((s, r) => s + (r.points ?? 0), 0);

function showIntro() {
  const best = readBest();
  state.quiz.phase = "intro";
  render(`<div class="body">
    <p class="eyebrow">Quiz</p>
    <h2>When did it happen?</h2>
    <p>Ten events from history. For each, move the timeline to the year you think it happened, or type it, then guess.
    The closer you are, the more points: up to ${thousands(QUIZ_MAX)} a round.</p>
    ${best ? `<p class="best">Your best: <b>${thousands(best)}</b></p>` : ""}
    <button class="primary" data-act="start">Start</button>
  </div>`);
  focusAction();
}

function start() {
  state.quiz.rounds = pickRounds().map((e) => ({ e }));
  for (const { e } of state.quiz.rounds) summary(e.wiki); // the answers' summaries and pictures, ahead
  ask(0);
}

// the event's title and kind; where it happened is on the map. its picture only comes
// with the answer: a map or a painting often has the date on it
function header(r, i, picture = false) {
  return `${picture ? `<img alt="" hidden>` : ""}
  <div class="body">
    <p class="progress"><span>Round ${i + 1} of ${state.quiz.rounds.length}</span><span>${thousands(total())} points</span></p>
    <p class="meta">${kindSvg(r.e.kind)}<span class="kind-name">${r.e.kind}</span></p>
    <h2></h2>`;
}
function fillHeader(r) {
  quizScreen.querySelector("h2").textContent = r.e.title;
  quizPanel.style.setProperty("--kind", `var(--k-${r.e.kind})`);
  const img = quizScreen.querySelector("img");
  if (!img) return;
  summary(r.e.wiki).then((s) => {
    if (state.quiz?.round !== r || !s?.thumbnail) return;
    const big = cardImage(s);
    img.onerror = () => { if (img.src !== s.thumbnail.source) img.src = s.thumbnail.source; else img.hidden = true; };
    img.onload = () => { img.hidden = false; invalidate(); };
    img.src = big;
  });
}

function ask(i) {
  const q = state.quiz, r = q.rounds[i];
  Object.assign(q, { i, round: r, phase: "ask", asking: true });
  setPlain(true); // no territories while guessing (app.js): they'd hint at the year
  setGuess(1); // each round starts from 1 CE, not wherever the last answer left the timeline
  $("guess-mark").hidden = true;
  render(`${header(r, i)}
    <p class="hint">${r.e.end ? "When did it begin?" : "What year was it?"}</p>
    <form class="guess" autocomplete="off">
      <input type="text" enterkeyhint="go" aria-label="your guess, a year (negative for BCE)" maxlength="6">
      <button class="primary" type="submit">Guess</button>
    </form>
    <p class="tip">negative years are BCE, or ${innerWidth < 600 ? "swipe" : "drag"} the timeline</p>
  </div>`);
  fillHeader(r);
  showGuess(r.guess);
  const form = quizScreen.querySelector("form"), input = form.querySelector("input");
  // while it shows the timeline's year, a tap selects it, so typing replaces it rather than adding to it
  const pick = () => input.dataset.shown && setTimeout(() => input.select());
  input.addEventListener("focus", pick);
  input.addEventListener("click", pick);
  input.addEventListener("input", () => { delete input.dataset.shown; typed(); });
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // typing isn't play/pause or scrubbing
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      let y = r.guess + (ev.key === "ArrowUp" ? 1 : -1);
      if (y === 0) y = ev.key === "ArrowUp" ? 1 : -1;
      setGuess(y);
      showGuess(r.guess, true);
    }
  });
  input.addEventListener("blur", () => showGuess(r.guess, true));
  form.onsubmit = (ev) => { ev.preventDefault(); answer(); };
  // the camera goes to where it happened, and the pin there joins the panel
  state.selected = r.e;
  state.cardAt = performance.now();
  const phone = innerWidth < 600;
  flyTo(r.e.lon, r.e.lat, globe.on ? (phone ? 1.1 : 1.35) : (phone ? 1.6 : 2), 1400, 0.4);
  if (matchMedia("(pointer: fine)").matches) input.focus({ preventScroll: true });
  invalidate();
}

// the guess is the timeline's year while asking: dragging the timeline changes it, and
// typing a year moves the timeline (which shows bce years to the nearest ten, so the
// typed year is kept as it is). bce years are typed as negatives
let typing = false;
function setGuess(y) {
  const r = state.quiz.round;
  r.guess = clamp(y, MIN_YEAR, MAX_YEAR);
  typing = true;
  state.pos = toPos(r.guess);
  applyYear(r.guess);
  typing = false;
}
function typed() {
  const input = quizScreen.querySelector(".guess input");
  const n = parseInt(input.value.replace(/[−–]/g, "-").replace(/[^\d-]/g, ""), 10); // a typographic minus counts too
  if (n) setGuess(n); // not yet a number ("-"), or 0, which isn't a year
}
function showGuess(y, force = false) {
  const input = quizScreen.querySelector(".guess input");
  if (!input) return;
  if (force || document.activeElement !== input || !input.value) { // not under their fingers
    input.value = y;
    input.dataset.shown = "1";
  }
}
// called by applyYear (app.js) whenever the timeline moves
function syncGuess(year) {
  if (!state.quiz?.asking || typing) return;
  state.quiz.round.guess = year;
  showGuess(year);
}

function answer() {
  const q = state.quiz, r = q.round, { e } = r;
  r.points = points(r.guess, e.start);
  q.phase = "answer";
  q.asking = false;
  const off = Math.abs(r.guess - e.start) - (r.guess < 0 !== e.start < 0 ? 1 : 0); // there's no year 0
  const last = q.i === q.rounds.length - 1;
  render(`${header(r, q.i, true)}
    <div class="result">
      <p class="points"><b>+${thousands(r.points)}</b> <span>${verdict(r.points)}</span>
        <button class="primary" data-act="${last ? "done" : "next"}">${last ? "Your score" : "Next"}</button></p>
      <div class="meter"><i style="width:${(r.points / QUIZ_MAX) * 100}%"></i></div>
      <p>It was <b>${e.approx ? "c. " : ""}${fmt(e.start)}</b>${e.end ? `, until ${fmt(e.end)}` : ""}.
      ${off ? `You said ${fmt(r.guess)}, ${thousands(off)} year${off === 1 ? "" : "s"} ${r.guess < e.start ? "early" : "late"}.` : "You got the year exactly."}</p>
    </div>
    <p class="desc"></p>
    <a class="wiki" target="_blank" rel="noopener" href="">read on wikipedia ↗</a>
  </div>`);
  fillHeader(r);
  quizScreen.querySelector(".wiki").href = e.wiki;
  summary(e.wiki).then((s) => {
    if (state.quiz?.round === r && s?.type === "standard") quizScreen.querySelector(".desc").textContent = s.extract;
  });
  // your guess stays marked on the timeline, which sweeps to the answer
  const mark = $("guess-mark");
  mark.style.left = `${toPos(r.guess) * 100}%`;
  mark.hidden = false;
  sweep(r.guess, e.start);
  focusAction();
}

function sweep(from, to, ms = 900) {
  const t0 = performance.now(), round = state.quiz.round;
  const step = (now) => {
    if (state.quiz?.round !== round || state.quiz.phase !== "answer") return;
    const t = ease(Math.min(1, (now - t0) / ms));
    state.pos = toPos(from) + (toPos(to) - toPos(from)) * t;
    applyYear(t < 1 ? roundYear(toYear(state.pos)) : to);
    if (t < 1) requestAnimationFrame(step);
    else setPlain(false); // and there, the world as it was that year
  };
  requestAnimationFrame(step);
}

function finish() {
  const q = state.quiz, score = total(), best = readBest(), record = score > best;
  if (record) saveBest(score);
  q.phase = "done";
  state.selected = null;
  setPlain(false);
  $("guess-mark").hidden = true;
  render(`<div class="body">
    <p class="eyebrow">Quiz · final score</p>
    <div class="final">
      <h2 class="score">${thousands(score)} <small>/ ${thousands(q.rounds.length * QUIZ_MAX)}</small></h2>
      <button class="primary" data-act="again">Play again</button>
    </div>
    <p class="best">${record ? (best ? `A new best! Your last best was ${thousands(best)}.` : "Your first score, and your best so far.") : `Your best: <b>${thousands(best)}</b>`}</p>
    <ol class="rounds"></ol>
  </div>`);
  if (record) quizScreen.querySelector(".score").animate([{ scale: 1.15 }, { scale: 1 }], { duration: 500, easing: "ease-out" });
  quizScreen.querySelector(".rounds").replaceChildren(...q.rounds.map((r) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.innerHTML = `${kindSvg(r.e.kind)}<span><b></b><small></small></span><em>+${thousands(r.points)}</em>`;
    b.querySelector("b").textContent = r.e.title;
    b.querySelector("small").textContent = `${fmt(r.e.start)} · you said ${fmt(r.guess)}`;
    b.title = "show it on the map";
    b.onclick = () => { endQuiz(); goToEvent(r.e); };
    li.append(b);
    return li;
  }));
  focusAction();
  invalidate();
}

function focusAction() {
  if (matchMedia("(pointer: fine)").matches) quizScreen.querySelector(".primary")?.focus({ preventScroll: true });
}

quizScreen.addEventListener("click", (ev) => {
  const act = ev.target.closest("[data-act]")?.dataset.act;
  if (act === "start" || act === "again") start();
  else if (act === "next") ask(state.quiz.i + 1);
  else if (act === "done") finish();
});

// --- in and out ------------------------------------------------------------------------

function openQuiz() {
  closeExplore();
  closeCard();
  if (state.focus) endFocus();
  setPlaying(false);
  state.queue = [];
  state.stop = null;
  state.quiz = { phase: "intro", rounds: [] };
  document.body.classList.add("quizzing");
  $("quiz-toggle").setAttribute("aria-pressed", true);
  quizPanel.hidden = false;
  quizPanel.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: "ease-out" });
  resize(); // a phone makes room for the panel
  showIntro();
}

function endQuiz() {
  if (!state.quiz) return;
  state.quiz = null;
  state.selected = null;
  setPlain(false);
  document.body.classList.remove("quizzing");
  $("quiz-toggle").setAttribute("aria-pressed", false);
  $("guess-mark").hidden = true;
  quizPanel.hidden = true;
  resize();
  invalidate();
}

$("quiz-toggle").onclick = () => (state.quiz ? endQuiz() : openQuiz());
quizPanel.querySelector(".close").onclick = endQuiz;
