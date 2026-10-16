"""validate data/events.json and data/events-wikidata.json against the schema in README.md."""
import json
import sys
from pathlib import Path

KINDS = {"war", "battle", "political", "culture", "science", "exploration", "disaster", "art", "music"}
REQUIRED = {"id": str, "title": str, "kind": str, "start": int, "lat": (int, float), "lon": (int, float), "importance": int}
OPTIONAL = {"end": int, "approx": bool, "wiki": str, "qid": str, "sitelinks": int, "finale": bool}


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
    if sum(bool(e.get("finale")) for e in events) > 1:
        yield "only one event can be the finale"


if __name__ == "__main__":
    data = Path(__file__).resolve().parent.parent / "data"
    errs = []
    for name in ("events.json", "events-wikidata.json"):
        errs += [f"{name}: {e}" for e in errors(json.loads((data / name).read_text()))]
    print("\n".join(errs) or "ok")
    sys.exit(bool(errs))
