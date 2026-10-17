"""validate data/events.json, data/events-wikidata.json and data/quiz.json against the schema in README.md."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

KINDS = {"war", "battle", "political", "culture", "science", "exploration", "disaster", "art", "music"}
REQUIRED = {"id": str, "title": str, "kind": str, "start": int, "lat": (int, float), "lon": (int, float), "importance": int}
OPTIONAL = {"end": int, "approx": bool, "wiki": str, "qid": str, "sitelinks": int}


def errors(events):
    seen = set()
    for e in events:
        who = e.get("id", "?")
        for k, t in REQUIRED.items():
            if not isinstance(e.get(k), t) or isinstance(e.get(k), bool):
                yield f"{who}: missing or bad '{k}'"
        for k, v in e.items():
            if k not in REQUIRED and k not in OPTIONAL:
                yield f"{who}: unknown field '{k}'"
            elif k in OPTIONAL and not isinstance(v, OPTIONAL[k]):
                yield f"{who}: bad '{k}'"
        if who in seen:
            yield f"{who}: duplicate id"
        seen.add(who)
        if e.get("kind") not in KINDS:
            yield f"{who}: kind must be one of {sorted(KINDS)}"
        if 0 in (e.get("start"), e.get("end")):
            yield f"{who}: there is no year 0"
        if "end" in e and e["end"] < e.get("start", 0):
            yield f"{who}: end before start"
        if not -90 <= e.get("lat", 0) <= 90 or not -180 <= e.get("lon", 0) <= 180:
            yield f"{who}: lat/lon out of range"
        if e.get("importance") not in (1, 2, 3):
            yield f"{who}: importance must be 1, 2 or 3"


QUIZ_FIELDS = {"id": str, "event": str, "level": int, "ask": str, "title": str}
QUIZ_LATEST = 2018  # nothing more recent: too fresh to feel like history


def merged(curated, wikidata):
    """the events the map shows: wikidata's, less those a curated event overrides (mergeEvents in app.js)"""
    article = lambda url: url and unquote(url).lower()
    overridden = {article(e.get("wiki")) for e in curated if e.get("wiki")}
    return {e["id"]: e for e in curated + [e for e in wikidata if not e.get("wiki") or article(e["wiki"]) not in overridden]}


def quiz_errors(questions, events):
    seen = set()
    for q in questions:
        who = q.get("id", "?")
        for k, v in q.items():
            if k not in QUIZ_FIELDS:
                yield f"{who}: unknown field '{k}'"
            elif not isinstance(v, QUIZ_FIELDS[k]) or isinstance(v, bool):
                yield f"{who}: bad '{k}'"
        if who in seen:
            yield f"{who}: duplicate id"
        seen.add(who)
        e = events.get(who)
        if not e:
            yield f"{who}: no such event (or a curated event overrides it: use the curated id)"
            continue
        if q.get("event") != e["title"]:
            yield f"{who}: 'event' should be the event's title, {e['title']!r}"
        if q.get("level") not in (1, 2, 3):
            yield f"{who}: level must be 1, 2 or 3"
        if q.get("ask", "start") not in ("start", "end", "both"):
            yield f"{who}: ask must be start, end or both"
        if e.get("approx"):
            yield f"{who}: its date is approximate"
        ask = q.get("ask", "start")
        if ask != "start" and "end" not in e:
            yield f"{who}: it has no end to ask about"
            continue
        title = q.get("title", e["title"])
        for year in [e["start"]] * (ask != "end") + [e.get("end")] * (ask != "start"):
            if not -3000 <= year <= QUIZ_LATEST:
                yield f"{who}: {year} is outside -3000..{QUIZ_LATEST}"
            if re.search(r"\d{3,}", title) or re.search(rf"\b{abs(year)}\b", title):
                yield f"{who}: the title gives the year away"


if __name__ == "__main__":
    data = Path(__file__).resolve().parent.parent / "data"
    errs = []
    loaded = {name: json.loads((data / name).read_text()) for name in ("events.json", "events-wikidata.json", "quiz.json")}
    for name in ("events.json", "events-wikidata.json"):
        errs += [f"{name}: {e}" for e in errors(loaded[name])]
    events = merged(loaded["events.json"], loaded["events-wikidata.json"])
    errs += [f"quiz.json: {e}" for e in quiz_errors(loaded["quiz.json"], events)]
    print("\n".join(errs) or "ok")
    sys.exit(bool(errs))
