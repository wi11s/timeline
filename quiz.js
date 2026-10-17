// world timeline: the quiz. ten events, one at a time: set the timeline to the year you
// think each happened (or type it) and guess. the closer, the more points, up to 1,000 a
// round; the map shows where each happened, and the answer jumps the timeline there.
// the best score is kept in this browser (localStorage)

const QUIZ_ROUNDS = 10, QUIZ_MAX = 1000;
const QUIZ_UNTIL = 2018;    // nothing asked of later years
const QUIZ_STRIP = 262;     // the panel's greatest height on a phone, which the map makes room for (mapArea)
const BEST_KEY = "quiz-best";

const quizPanel = $("quiz"), quizScreen = quizPanel.querySelector(".screen");
const thousands = (n) => n.toLocaleString("en");

// the questions, picked by hand in data/quiz.json: an event, how well known (level 1, 2 or 3),
// whether to ask when it began (the default), when it ended, or both, and a title of its own
// where the event's isn't clear enough. loaded when the quiz first opens
let quizList = null;
const loadQuizList = () => (quizList ??= fetch("data/quiz.json").then((r) => r.json())
  .catch((err) => { quizList = null; throw err; })); // tried again next time

// things that lasted, though only their start is known ("Russian Revolution"): their year is when they began
const lasted = (e) => e.end || /\b(culture|civili[sz]ation|period|age|revolution|renaissance|reformation|movement|war)$/i.test(e.title);

// ten of them, mixed: no more than three of a kind, or of an era, and never both ends of one
// event. each round's level is drawn by chance, the best known likelier early on: 60% level 1,
// 35% level 2 and 5% level 3 in the first round, shifting evenly to 20%, 40% and 40% in the last
function pickRounds(list) {
  const events = new Map(state.events.map((e) => [e.id, e]));
  const pool = list.flatMap(({ id, level, ask = "start", title }) => {
    const e = events.get(id);
    if (!e) return [];
    title ??= e.title;
    const began = { e, level, title, year: e.start }, ended = { e, level, title, year: e.end, end: true };
    return (ask === "both" ? [began, ended] : ask === "end" ? [ended] : [began]).filter((r) => r.year <= QUIZ_UNTIL);
  });
  for (let i = pool.length - 1; i > 0; i--) { // shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = [];
  const fresh = (r) => !picks.some((p) => p.e === r.e);
  const room = (r) => picks.filter((p) => p.e.kind === r.e.kind).length < 3 && picks.filter((p) => eraOf(p.year) === eraOf(r.year)).length < 3;
  for (let i = 0; i < QUIZ_ROUNDS; i++) {
    const t = i / (QUIZ_ROUNDS - 1), u = Math.random();
    const level = u < 0.6 - 0.4 * t ? 1 : u < 0.95 - 0.35 * t ? 2 : 3;
    const r = pool.find((r) => r.level === level && fresh(r) && room(r)) ?? pool.find((r) => fresh(r) && room(r)) ?? pool.find(fresh);
    if (r) picks.push(r);
  }
  return picks;
}

// how close, on the timeline's own scale (lg, in app.js): the more recent the event, the
// nearer you need to be, so a year or two off costs about as much for the iphone as a
// century for the pyramids. and the older the date, the wider the margin on top, growing
// smoothly towards half as wide again: few people know the middle ages to the decade. but
// centuries off cost plenty however old the date: the years off count too, barely within a
// few decades, and taking most of the points at a few hundred, a little more the older the
// date (about 210 years for the 1800s, 285 for classical greece, 355 for the pyramids)
const points = (guess, year) => {
  const age = PRESENT - year, margin = 0.15 * (1 + 0.5 * age / (age + 600));
  const off = (guess - year) / (200 + age / 30);
  return Math.round(QUIZ_MAX * Math.exp(-Math.abs(lg(guess) - lg(year)) / margin - off * off));
};
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

// games started this visit, which says whether people play again
let games = 0;

async function start() {
  const list = await loadQuizList();
  if (!state.quiz) return; // closed while it loaded
  games++;
  trackEvent("Quiz started", { game: games < 5 ? String(games) : "5+", returning: readBest() > 0 }); // returning: has finished one before
  state.quiz.rounds = pickRounds(list);
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
  quizScreen.querySelector("h2").textContent = r.title;
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
    <p class="hint">${r.end ? "When did it end?" : lasted(r.e) ? "When did it begin?" : "What year was it?"}</p>
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
  const q = state.quiz, r = q.round, { e, year } = r;
  r.points = points(r.guess, year);
  trackEvent("Quiz answer", { question: r.title, verdict: verdict(r.points) }); // which questions are too hard, or too easy
  q.phase = "answer";
  q.asking = false;
  const off = Math.abs(r.guess - year) - (r.guess < 0 !== year < 0 ? 1 : 0); // there's no year 0
  const last = q.i === q.rounds.length - 1;
  render(`${header(r, q.i, true)}
    <div class="result">
      <p class="points"><b>+${thousands(r.points)}</b> <span>${verdict(r.points)}</span>
        <button class="primary" data-act="${last ? "done" : "next"}">${last ? "Your score" : "Next"}</button></p>
      <div class="meter"><i style="width:${(r.points / QUIZ_MAX) * 100}%"></i></div>
      <p>${r.end ? `It ended in <b>${fmt(e.end)}</b>, having begun in ${fmt(e.start)}` : e.end ? `It began in <b>${fmt(e.start)}</b>, and ended in ${fmt(e.end)}` : `It was <b>${fmt(e.start)}</b>`}.
      ${off ? `You said ${fmt(r.guess)}, ${thousands(off)} year${off === 1 ? "" : "s"} ${r.guess < year ? "early" : "late"}.` : "You got the year exactly."}</p>
    </div>
    <p class="desc"></p>
    <a class="wiki" target="_blank" rel="noopener" href="">read on wikipedia ↗</a>
  </div>`);
  fillHeader(r);
  quizScreen.querySelector(".wiki").href = e.wiki;
  quizScreen.querySelector(".wiki").onclick = () => trackEvent("Quiz read more", { via: "wikipedia" });
  summary(e.wiki).then((s) => {
    if (state.quiz?.round === r && s?.type === "standard") quizScreen.querySelector(".desc").textContent = s.extract;
  });
  // your guess stays marked on the timeline, which sweeps to the answer
  const mark = $("guess-mark");
  mark.style.left = `${toPos(r.guess) * 100}%`;
  mark.hidden = false;
  sweep(r.guess, year);
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
  const band = Math.min(Math.floor(score / 1000), 9) * 1000;
  trackEvent("Quiz finished", { score: `${thousands(band)}–${thousands(band + 999)}`, best: record });
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
    b.querySelector("b").textContent = r.title;
    b.querySelector("small").textContent = `${r.end ? "ended " : ""}${fmt(r.year)} · you said ${fmt(r.guess)}`;
    b.title = "show it on the map";
    b.onclick = () => { trackEvent("Quiz read more", { via: "map" }); endQuiz(); goToEvent(r.e); };
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
  trackEvent("Quiz opened");
  showIntro();
  loadQuizList().catch(() => {}); // ahead of start
}

function endQuiz() {
  if (!state.quiz) return;
  const { phase, i } = state.quiz;
  if (phase === "ask" || phase === "answer") trackEvent("Quiz left", { round: i + 1, phase }); // where people give up
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
