"""name the unnamed territories in data/borders/ from cliopatria (CC BY 4.0).

historical-basemaps leaves many territories without a name: open land where no
polity is known, but also real states (switzerland is unnamed from 1994 on). for
each unnamed territory, points are sampled across it and checked against the
cliopatria polities of that year. if one polity covers most of the territory
(SHARE of the samples), the territory takes its name and wikipedia article;
otherwise it stays unnamed. borders are never changed and nothing is guessed.

land missing from the source altogether (funen, lolland and bornholm are absent
from the modern maps) is filled the same way: a cliopatria shape that lies almost
entirely outside the source's land (MISSING) is added, under the source's own name
for that polity where it has one. shapes that overlap the source's land are left
alone, so the source's borders and coastlines are never redrawn.

borders.py runs this before corrections.py. on its own: python3 pipeline/cliopatria.py
cliopatria: Seshat Global History Databank, https://github.com/Seshat-Global-History-Databank/cliopatria
"""
import json
import math
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "borders"
CACHE = ROOT / ".cache" / "cliopatria" / "cliopatria.geojson.zip"
URL = "https://github.com/Seshat-Global-History-Databank/cliopatria/raw/main/cliopatria.geojson.zip"
SHARE = 0.6     # of a territory's samples one polity must hold to name it
MISSING = 0.15  # a cliopatria shape this little covered by the source's land is missing from it
MIN_AREA = 0.02 # square degrees: smaller missing shapes (rocks, sandbars) aren't worth adding
SAMPLES = 9     # per side of the sampling grid


def polities():
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        print("  downloading cliopatria")
        urllib.request.urlretrieve(URL, CACHE)
    with zipfile.ZipFile(CACHE) as z:
        feats = json.loads(z.read(z.infolist()[0].filename))["features"]
    out = []
    for f in feats:
        p, g = f["properties"], f["geometry"]
        # names in parentheses are umbrella entities overlapping their members; relations are alliances
        if p["Type"] != "POLITY" or p["Name"].startswith("(") or not g:
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out.append({"name": p["Name"], "from": p["FromYear"], "to": p["ToYear"], "wiki": p.get("Wikipedia") or None,
                    "polys": polys, "box": bbox(polys)})
    return out


def bbox(polys):
    xs = [x for poly in polys for x, _ in poly[0]]
    ys = [y for poly in polys for _, y in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def in_ring(x, y, ring):
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def in_polys(x, y, polys):
    return any(in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:]) for poly in polys)


def samples(polys):
    x0, y0, x1, y1 = bbox(polys)
    pts = [(x0 + (i + 0.5) * (x1 - x0) / SAMPLES, y0 + (j + 0.5) * (y1 - y0) / SAMPLES)
           for i in range(SAMPLES) for j in range(SAMPLES)]
    pts = [p for p in pts if in_polys(*p, polys)]
    if not pts:  # too thin for the grid: use its vertices' average
        ring = max((poly[0] for poly in polys), key=len)
        pts = [(sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring))]
    return pts


def area(polys):
    """roughly, in square degrees at the equator"""
    total = 0.0
    for poly in polys:
        ring = poly[0]
        k = math.cos(math.radians(sum(y for _, y in ring) / len(ring)))
        total += abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2 * k
    return total


def holder(polys, alive):
    """the polity holding most of a territory (SHARE of its samples), or None. a sample
    inside two overlapping polities (an occupation, say) counts for neither"""
    pts = samples(polys)
    votes = {}
    for x, y in pts:
        hits = [p for p in alive if p["box"][0] <= x <= p["box"][2] and p["box"][1] <= y <= p["box"][3]
                and in_polys(x, y, p["polys"])]
        if len(hits) == 1:
            votes[hits[0]["name"]] = votes.get(hits[0]["name"], 0) + 1
    if not votes:
        return None, 0
    name, n = max(votes.items(), key=lambda v: v[1])
    return (next(p for p in alive if p["name"] == name) if n >= SHARE * len(pts) else None), len(pts)


def nearest(lenders, polys, polity):
    """of a polity's named territories, the nearest one bigger than these polygons
    (an enclave shouldn't lend its name to an island)"""
    x0, y0, x1, y1 = bbox(polys)
    cx, cy, size = (x0 + x1) / 2, (y0 + y1) / 2, area(polys)
    def gap(b):
        return math.hypot(max(b[0] - cx, 0, cx - b[2]), max(b[1] - cy, 0, cy - b[3]))
    bigger = [l for l in lenders if l[3] > size]
    # the territory under the polity's own name wins: the faroes are "denmark", not "greenland"
    same = [l for l in bigger if l[0].lower() == polity.lower()]
    return min(same or bigger, key=lambda l: (gap(l[2]), -l[3])) if bigger else None


def add_missing(fc, alive, own):
    """cliopatria shapes (single polygons) that the source has no land for at all"""
    from borders import ring as tidy  # simplified and rounded like the rest
    land = [(f["geometry"]["coordinates"], bbox(f["geometry"]["coordinates"])) for f in fc["features"]]
    added = 0
    for p in alive:
        for poly in p["polys"]:
            if area([poly]) < MIN_AREA:
                continue
            pts = samples([poly])
            covered = sum(any(b[0] <= x <= b[2] and b[1] <= y <= b[3] and in_polys(x, y, polys) for polys, b in land)
                          for x, y in pts)
            if covered > MISSING * len(pts):
                continue
            outer = tidy(poly[0])
            if not outer:
                continue
            props = {"name": p["name"], "subject": None, "precision": 2, "source": "cliopatria-shape"}
            lender = nearest(own.get(p["name"], []), [[outer]], p["name"])
            if lender:
                props.update(name=lender[0], subject=lender[1])
            elif p["wiki"]:
                props["wiki"] = p["wiki"]
            fc["features"].append({"type": "Feature", "properties": props,
                                   "geometry": {"type": "MultiPolygon", "coordinates": [[outer]]}})
            land.append(([[outer]], bbox([[outer]])))
            added += 1
    return added


def fill(out=OUT, verbose=True):
    known = polities()
    total = 0
    for path in sorted(out.glob("*.json"), key=lambda p: (p.stem != "index", p.stem)):
        if path.name == "index.json":
            continue
        fc = json.loads(path.read_text())
        year = fc["year"]
        alive = [p for p in known if p["from"] <= year <= p["to"]]
        # the source's own names for each polity: the named territories it holds. an unnamed
        # island takes the name (and colour) of the nearest of them, so a danish island is
        # "denmark", not "greenland"
        own = {}
        for f in fc["features"]:
            if f["properties"].get("name"):
                p, _ = holder(f["geometry"]["coordinates"], alive)
                if p:
                    polys = f["geometry"]["coordinates"]
                    own.setdefault(p["name"], []).append((f["properties"]["name"], f["properties"].get("subject"), bbox(polys), area(polys)))
        named = 0
        for f in fc["features"]:
            if f["properties"].get("name"):
                continue
            if f["properties"].get("source") == "cliopatria-shape":
                continue
            p, _ = holder(f["geometry"]["coordinates"], alive)
            if not p:
                continue
            lender = nearest(own.get(p["name"], []), f["geometry"]["coordinates"], p["name"])
            if lender:
                f["properties"].update(name=lender[0], subject=lender[1])
            else:
                f["properties"].update(name=p["name"], source="cliopatria")
                if p["wiki"]:
                    f["properties"]["wiki"] = p["wiki"]
            named += 1
        added = add_missing(fc, alive, own)
        if named or added:
            path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False))
        total += named + added
        if verbose:
            unnamed = sum(not f["properties"].get("name") for f in fc["features"])
            print(f"{year:>8}  named {named:>3}, added {added:>3} missing shapes, still unnamed {unnamed:>3}")
    return total


if __name__ == "__main__":
    print(f"named {fill()} territories from cliopatria")
