"""editorial corrections on top of the historical-basemaps border snapshots.

borders.py runs this after every build. on its own it patches data/borders/ in
place, once: python3 pipeline/corrections.py

palestine: the source draws "israel" before 1948 and draws the west bank and
gaza as israel ever after. this corrects that period by period:

  1938, 1945   mandatory palestine (the 1938 snapshot also has a stray israel on top)
  1948         israel within the armistice lines; west bank held by jordan, gaza
               strip by egypt (new snapshot)
  1960         the same
  1967         occupied palestinian territories            (new snapshot)
  1988         palestine, after the declaration of independence (new snapshot)
  1994-        palestine

the west bank and gaza are cut out of israel's polygon along the 1949 armistice
lines, simplified to the same few-km accuracy as the rest of the data.
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "borders"

MANDATE = {"name": "Mandatory Palestine (GB)", "subject": "United Kingdom of Great Britain and Ireland", "precision": 3}

# the green line, from where it leaves the jordan river in the north, round the
# west bank (east jerusalem included) to where it meets the dead sea. [lon, lat]
GREEN_LINE = [
    [35.63, 32.40], [35.50, 32.45], [35.40, 32.50], [35.30, 32.55], [35.20, 32.53], [35.10, 32.47],
    [35.05, 32.40], [35.04, 32.32], [34.98, 32.25], [34.96, 32.17], [34.99, 32.08], [35.01, 31.99],
    [34.98, 31.88], [35.05, 31.82], [35.13, 31.81], [35.21, 31.79], [35.15, 31.74], [35.06, 31.72],
    [34.99, 31.66], [34.94, 31.56], [34.90, 31.47], [34.92, 31.38], [35.05, 31.35], [35.22, 31.37],
    [35.35, 31.42], [35.45, 31.47], [35.56, 31.47],
]
# the gaza strip's land boundary, from the coast north of beit hanoun to the egyptian border
GAZA_LINE = [[34.43, 31.59], [34.56, 31.55], [34.50, 31.45], [34.40, 31.33], [34.32, 31.26], [34.24, 31.17]]
RAMALLAH, GAZA_CITY = (35.20, 31.90), (34.44, 31.50)


def inside(pt, ring):
    x, y = pt
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def split(ring, cut, keep):
    """split a closed ring along a cut line whose two ends lie on (or near) the ring.
    returns (the piece containing `keep`, the rest), both closed."""
    pts = ring[:-1]

    def landing(p):  # the nearest point on the ring: (distance, edge index, position along it, point)
        best = None
        for i, a in enumerate(pts):
            b = pts[(i + 1) % len(pts)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
            q = [round(a[0] + t * dx, 2), round(a[1] + t * dy, 2)]
            d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
            if best is None or d < best[0]:
                best = (d, i, t, q)
        return best

    _, ia, ta, qa = landing(cut[0])
    _, ib, tb, qb = landing(cut[-1])
    # walk the ring once, dropping both landing points onto their edges
    walk = []
    for i, p in enumerate(pts):
        walk.append(p)
        for j, t, q in sorted([(ia, ta, qa), (ib, tb, qb)], key=lambda e: e[1]):
            if j == i:
                walk.append(q)
    a, b = walk.index(qa), walk.index(qb)
    forward = lambda s, e: walk[s:e + 1] if s <= e else walk[s:] + walk[:e + 1]
    inner = cut[1:-1]
    one = forward(a, b) + inner[::-1]
    two = forward(b, a) + inner
    one, two = one + one[:1], two + two[:1]
    return (one, two) if inside(keep, one) else (two, one)


def feature(name, subject, polys):
    return {"type": "Feature", "properties": {"name": name, "subject": subject, "precision": 2},
            "geometry": {"type": "MultiPolygon", "coordinates": [[p] for p in polys]}}


def named(fc, name):
    return next(f for f in fc["features"] if f["properties"]["name"] == name)


def carve(fc):
    """cut the west bank and gaza out of israel; returns their rings."""
    israel = named(fc, "Israel")["geometry"]["coordinates"]
    k = next(i for i, poly in enumerate(israel) if inside(RAMALLAH, poly[0]))
    west_bank, rest = split(israel[k][0], GREEN_LINE, RAMALLAH)
    gaza, rest = split(rest, GAZA_LINE, GAZA_CITY)
    israel[k][0] = rest
    return west_bank, gaza


def armistice(fc):
    """1948-67: israel within the 1949 lines, the west bank in jordan, gaza under egypt."""
    west_bank, gaza = carve(fc)
    named(fc, "Jordan")["geometry"]["coordinates"].append([west_bank])
    fc["features"].append(feature("Gaza Strip (Egypt)", "Egypt", [gaza]))
    return fc


def apply(out=OUT):
    years = json.loads((out / "index.json").read_text())
    if 1967 in years:
        sys.exit("corrections are already applied")
    load = lambda y: json.loads((out / f"{y}.json").read_text())
    def save(y, fc):
        fc["year"] = y
        (out / f"{y}.json").write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False))

    fc = load(1938)
    fc["features"] = [f for f in fc["features"] if f["properties"]["name"] != "Israel"]
    save(1938, fc)
    fc = load(1945)
    save(1948, armistice(fc))  # the 1945 world, with the new lines
    fc = load(1945)
    named(fc, "Israel")["properties"] = dict(MANDATE)
    save(1945, fc)

    # 1967 and 1988 start from the 1960 map, which is what those years showed until now
    for year, name, subject in [(1967, "Occupied Palestinian Territories", "Israel"), (1988, "Palestine", "Palestine")]:
        fc = load(1960)
        fc["features"].append(feature(name, subject, carve(fc)))
        save(year, fc)
    save(1960, armistice(load(1960)))
    for year in (y for y in years if y >= 1994):
        fc = load(year)
        fc["features"].append(feature("Palestine", "Palestine", carve(fc)))
        save(year, fc)

    (out / "index.json").write_text(json.dumps(sorted(years + [1948, 1967, 1988])))
    print("corrections applied: palestine")


if __name__ == "__main__":
    apply()
