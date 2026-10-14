"""build data/borders/ from aourednik/historical-basemaps (GPL-3.0).

usage: python3 pipeline/borders.py [path-to-historical-basemaps]
clones the source into .cache/ if no path is given.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "borders"
SRC_URL = "https://github.com/aourednik/historical-basemaps.git"
TOLERANCE = 0.05  # degrees (~5km), douglas-peucker
DECIMALS = 2


def source_dir():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    cache = ROOT / ".cache" / "historical-basemaps"
    if not cache.exists():
        subprocess.run(["git", "clone", "-q", "--depth", "1", SRC_URL, str(cache)], check=True)
    return cache


def year_of(name):
    m = re.fullmatch(r"world_(bc)?(\d+)\.geojson", name)
    return m and (-int(m[2]) if m[1] else int(m[2]))


def simplify(pts, tol):
    """iterative douglas-peucker."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = 0.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def ring(r):
    out = []
    for x, y in simplify([p[:2] for p in r], TOLERANCE):
        p = [round(x, DECIMALS), round(y, DECIMALS)]
        if not out or out[-1] != p:
            out.append(p)
    return out if len(out) >= 4 else None


def polygons(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    out = []
    for poly in polys:
        outer = ring(poly[0])
        if outer:  # drop the polygon if its outer ring collapses
            out.append([outer] + [r for r in map(ring, poly[1:]) if r])
    return out


def build(src):
    OUT.mkdir(parents=True, exist_ok=True)
    years = []
    for f in sorted((src / "geojson").glob("world_*.geojson")):
        year = year_of(f.name)
        if year is None:
            continue
        feats = []
        for feat in json.loads(f.read_text())["features"]:
            p, g = feat["properties"], feat["geometry"]
            if not g:
                continue
            polys = polygons(g)
            if not polys:
                continue
            feats.append({
                "type": "Feature",
                "properties": {
                    "name": p.get("NAME"),
                    "subject": p.get("SUBJECTO"),
                    "precision": p.get("BORDERPRECISION"),
                },
                "geometry": {"type": "MultiPolygon", "coordinates": polys},
            })
        (OUT / f"{year}.json").write_text(json.dumps(
            {"type": "FeatureCollection", "year": year, "features": feats},
            separators=(",", ":"), ensure_ascii=False))
        years.append(year)
        print(f"{year:>8}  {len(feats):>4} polities")
    (OUT / "index.json").write_text(json.dumps(sorted(years)))


if __name__ == "__main__":
    build(source_dir())
