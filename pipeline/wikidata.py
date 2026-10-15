"""build data/events-wikidata.json from the wikidata query service.

usage: python3 pipeline/wikidata.py [--refresh]
raw query results are cached in .cache/wikidata/; --refresh refetches them.

each category below is one sparql query: instances of a class (or its
subclasses) with a date, a place and at least `min` wikipedia sitelinks.
sitelinks (how many language editions cover the event) is the ranking signal:
it sets `importance` and decides which pins win when the map is crowded.

fewer languages write about the ancient world, so older events need fewer
sitelinks to make the cut (ERA). works of art are placed where they were made
or found, never where they're kept now: a museum isn't where art history happened.
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "events-wikidata.json"
CACHE = ROOT / ".cache" / "wikidata"
ENDPOINT = "https://query.wikidata.org/sparql"
AGENT = "world-timeline/0.2 (https://github.com/wi11s/timeline)"
MIN_YEAR, MAX_YEAR = -123000, 2026

# where an event happened, most specific first. each is a path to a place with coordinates
PLACES = ("wdt:P625", "wdt:P276/wdt:P625", "wdt:P36/wdt:P625", "wdt:P17/wdt:P625")
# art that stays where it was made (murals, frescoes, mosaics, most sculpture): where it was
# made or found, then where it is
IN_SITU = ("wdt:P1071/wdt:P625", "wdt:P189/wdt:P625", "wdt:P625", "wdt:P276/wdt:P625")
# paintings move, so never where they are now: where made or found, else where the painter
# worked, if that was only one place (ARTIST, below); otherwise the painting is left out
PAINTING = ("wdt:P1071/wdt:P625", "wdt:P189/wdt:P625", "wdt:P170/wdt:P937/wdt:P625", "wdt:P1071/wdt:P625")
ARTIST = 2  # PAINTING's "where the painter worked" level

# the share of a category's minimum sitelinks an event needs, by when it began
ERA = ((500, 0.35), (1500, 0.65))
era = lambda year: next((f for until, f in ERA if year < until), 1)

# name, wikidata class, kind, min sitelinks, date properties, title template[, places]
CATEGORIES = [
    ("battles", "Q178561", "battle", 14, ("P585", "P580"), "{}"),
    ("sieges", "Q188055", "battle", 12, ("P585", "P580"), "{}"),
    ("wars", "Q198", "war", 12, ("P580", "P585"), "{}"),
    ("rebellions", "Q124734", "war", 12, ("P580", "P585"), "{}"),
    ("massacres", "Q3199915", "war", 18, ("P585", "P580"), "{}"),
    ("revolutions", "Q10931", "political", 10, ("P580", "P585"), "{}"),
    ("coups", "Q45382", "political", 14, ("P585", "P580"), "{}"),
    ("treaties", "Q131569", "political", 14, ("P585", "P580", "P571"), "{}"),
    ("assassinations", "Q3882219", "political", 14, ("P585",), "{}"),
    ("states", "Q3024240", "political", 40, ("P571",), "{} founded"),
    ("earthquakes", "Q7944", "disaster", 14, ("P585",), "{}"),
    ("eruptions", "Q7692360", "disaster", 10, ("P585", "P580"), "{}"),
    ("disasters", "Q3839081", "disaster", 20, ("P585", "P580"), "{}"),
    ("epidemics", "Q44512", "disaster", 20, ("P580", "P585"), "{}"),
    ("expeditions", "Q2401485", "exploration", 12, ("P580", "P585"), "{}"),
    ("universities", "Q3918", "culture", 70, ("P571",), "{} founded"),
    ("expos", "Q172754", "culture", 20, ("P580", "P585"), "{}"),
    ("ancient-cities", "Q15661340", "political", 12, ("P571",), "{} founded"),
    ("frescoes", "Q134194", "art", 14, ("P571",), "{}", IN_SITU),
    ("murals", "Q219423", "art", 14, ("P571",), "{}", IN_SITU),
    ("mosaics", "Q133067", "art", 12, ("P571",), "{}", IN_SITU),
    ("sculptures", "Q860861", "art", 22, ("P571",), "{}", IN_SITU),
    ("paintings", "Q3305213", "art", 40, ("P571",), "{}", PAINTING),
]

# everything over the minimum, plus older events over the lowest era threshold
LIST = """
SELECT DISTINCT ?item ?sl WHERE {
  ?item wdt:P31/wdt:P279* wd:%(cls)s ; wikibase:sitelinks ?sl .
  FILTER(?sl >= %(low)d)
  OPTIONAL { ?item %(dates)s ?d }
  FILTER(?sl >= %(min)d || (BOUND(?d) && YEAR(?d) < %(until)d))
}
"""

DETAILS = """
SELECT ?item ?label ?article ?prop ?date ?prec ?end ?c0 ?c1 ?c2 ?c3 WHERE {
  VALUES ?item { %(items)s }
  VALUES ?prop { %(props)s }
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")
  ?item ?p ?st . ?prop wikibase:claim ?p ; wikibase:statementValue ?psv .
  ?st ?psv [ wikibase:timeValue ?date ; wikibase:timePrecision ?prec ] .
  OPTIONAL { ?item wdt:P582 ?end }
  OPTIONAL { ?item %(p0)s ?c0 }
  OPTIONAL { ?item %(p1)s ?c1 }
  OPTIONAL { ?item %(p2)s ?c2 }
  OPTIONAL { ?item %(p3)s ?c3 }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
"""
BATCH = 250


def sparql(name, query, refresh):
    path = CACHE / f"{name}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    body = urllib.parse.urlencode({"query": query}).encode()
    req = urllib.request.Request(ENDPOINT, body, {
        "Accept": "application/sparql-results+json", "User-Agent": AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                rows = json.load(r)["results"]["bindings"]
            break
        except Exception as e:  # rate limits and the 60s server timeout both land here
            if attempt == 3:
                raise
            print(f"  {name}: {e}, retrying", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    time.sleep(1)  # be polite to the endpoint
    return rows


def year_of(value):
    """xsd dateTime -> our year. rdf dates are astronomical (0000 is 1 bce).
    "unknown value" comes through as a blank node, which gives None."""
    m = re.match(r"(-?)(\d+)-", value)
    if not m:
        return None
    y = int(m[2]) * (-1 if m[1] else 1)
    return y if y > 0 else y - 1


def point(wkt):
    """'Point(lon lat)' on earth -> (lat, lon). coordinates on other globes start with a uri."""
    m = re.fullmatch(r"Point\((-?[\d.]+) (-?[\d.]+)\)", wkt or "")
    return m and (round(float(m[2]), 2), round(float(m[1]), 2))


def medoid(points):
    """the place closest to all the others: a war fought on many fronts lands
    where most of its fronts are, not at an average somewhere in between."""
    def d(a, b):
        (la1, lo1), (la2, lo2) = map(lambda p: (math.radians(p[0]), math.radians(p[1])), (a, b))
        h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
        return math.asin(min(1, math.sqrt(h)))
    return min(points, key=lambda p: sum(d(p, q) for q in points))


def events_for(name, cls, kind, min_sl, props, title, places, refresh):
    low = max(4, int(min_sl * ERA[0][1]))
    dates = "|".join(f"wdt:{p}" for p in props)
    tag = {IN_SITU: "-situ", PAINTING: "-painting"}.get(places, "")
    key = f"{name}-{min_sl}-{low}{tag}"  # thresholds and places in the cache name, so changing them refetches
    listed = sparql(f"{key}-list", LIST % {"cls": cls, "min": min_sl, "low": low, "dates": dates, "until": ERA[-1][0]}, refresh)
    sitelinks = {r["item"]["value"].rsplit("/", 1)[1]: int(r["sl"]["value"]) for r in listed}
    qids = sorted(sitelinks)
    rows = []
    for i in range(0, len(qids), BATCH):
        rows += sparql(f"{key}-{i // BATCH}", DETAILS % {
            "items": " ".join(f"wd:{q}" for q in qids[i:i + BATCH]),
            "props": " ".join(f"wd:{p}" for p in props),
            **{f"p{k}": path for k, path in enumerate(places)},
        }, refresh)

    items = {}
    for r in rows:
        v = lambda k: r.get(k, {}).get("value")
        qid = v("item").rsplit("/", 1)[1]
        it = items.setdefault(qid, {"qid": qid, "label": v("label"), "sl": sitelinks[qid],
                                    "dates": {}, "ends": set(), "coords": {}, "wiki": None})
        rank = props.index(v("prop").rsplit("/", 1)[1])  # earlier date properties win
        prec = int(v("prec"))
        if prec >= 6 and year_of(v("date")) is not None:  # millennium or finer
            it["dates"].setdefault(rank, set()).add((year_of(v("date")), prec))
        if v("end") and year_of(v("end")) is not None:
            it["ends"].add(year_of(v("end")))
        for i, k in enumerate(("c0", "c1", "c2", "c3")):  # most specific place wins
            if point(v(k)):
                it["coords"].setdefault(i, set()).add(point(v(k)))
        if v("article"):
            it["wiki"] = urllib.parse.unquote(v("article"))

    out = []
    for it in items.values():
        if not it["dates"] or not it["coords"]:
            continue
        start, prec = min(it["dates"][min(it["dates"])])
        if prec < 9:  # decade, century or millennium: say 600 bce, not 601 bce
            step = 10 ** (9 - prec)
            start = round(start / step) * step or -1
        end = max(it["ends"]) if it["ends"] else None
        level = min(it["coords"])
        if places is PAINTING and level == ARTIST and len(it["coords"][level]) > 1:
            continue  # the painter worked in several places: we don't know which
        lat, lon = medoid(sorted(it["coords"][level]))
        label = it["label"]
        if not (MIN_YEAR <= start <= MAX_YEAR) or re.fullmatch(r"Q\d+", label):
            continue
        if it["sl"] < min_sl * era(start):
            continue
        e = {
            "id": it["qid"].lower(),
            "title": title.format(label[0].upper() + label[1:]),
            "kind": kind,
            "start": start,
        }
        if end is not None and start < end <= MAX_YEAR and kind not in ("political", "culture", "art"):
            e["end"] = end
        if prec < 9:
            e["approx"] = True
        weight = it["sl"] / era(start)  # importance is relative to its era
        e.update(lat=lat, lon=lon, importance=1 if weight >= 100 else 2 if weight >= 45 else 3)
        if it["wiki"]:
            e["wiki"] = it["wiki"]
        e.update(qid=it["qid"], sitelinks=it["sl"])
        out.append(e)
    return out


def main():
    refresh = "--refresh" in sys.argv
    events = {}
    for name, cls, kind, min_sl, props, title, *places in CATEGORIES:
        found = events_for(name, cls, kind, min_sl, props, title, places[0] if places else PLACES, refresh)
        new = [e for e in found if e["id"] not in events]  # first category wins
        events.update((e["id"], e) for e in new)
        print(f"{name:>14}  {len(new):>5}")
    out = sorted(events.values(), key=lambda e: (e["start"], -e["sitelinks"]))
    OUT.write_text("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in out) + "\n]\n")
    print(f"{'total':>14}  {len(out):>5}  -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
