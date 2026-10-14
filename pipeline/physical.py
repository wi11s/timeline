"""build data/physical/ from natural earth (public domain): shaded relief, rivers,
lakes, and the names of mountain ranges, deserts and plateaus.

usage: python3 pipeline/physical.py
downloads the sources into .cache/natural-earth/ the first time.

relief.png is the land's shading in the map's own projection (equal earth),
cropped to the same latitudes as the map; relief-globe.png is the same in plain
longitude and latitude, for the globe. it's a soft-light layer: 128 is
neutral, lighter lightens and darker darkens. natural earth's grey relief
brightens with altitude as well as shading the slopes; only the shading is
kept (each pixel minus a blur of its neighbourhood), with a little darkening
for high ground, so mountains read as engraved texture rather than going pale.
"""
import json
import math
import struct
import urllib.request
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "physical"
CACHE = ROOT / ".cache" / "natural-earth"
RELIEF_URL = "https://naciscdn.org/naturalearth/50m/raster/GRAY_50M_SR.zip"
VECTOR_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson"

WIDTH = 3000          # relief.png width; the height follows from the projection
GLOBE_W, GLOBE_H = 2048, 1024  # relief-globe.png, equirectangular
NORTH, SOUTH = 84, -57  # the map's extent (app.js: TOP, BOTTOM)
BLUR = 12             # neighbourhood for separating shading from altitude, in tenths of a degree
GAIN, TONE = 2.2, 0.3  # strength of the shading, and of the darkening of high ground
TOLERANCE = 0.03      # degrees, douglas-peucker for rivers and lakes

# --- projection (equal earth, as in app.js) ---------------------------------------

A1, A2, A3, A4, M = 1.340264, -0.081106, 0.000893, 0.003796, math.sqrt(3) / 2


def project(lon, lat):
    t = math.asin(M * math.sin(math.radians(lat)))
    t2 = t * t
    t6 = t2 * t2 * t2
    return (math.radians(lon) * math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
            -t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)))


def unproject_row(y):
    """latitude parameter t for a projected y, and the x-scale at that latitude."""
    t = -y / A1
    for _ in range(20):  # newton
        t2 = t * t
        t6 = t2 * t2 * t2
        f = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) + y
        t -= f / (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))
    t2 = t * t
    t6 = t2 * t2 * t2
    lat = math.degrees(math.asin(max(-1.0, min(1.0, math.sin(t) / M))))
    return lat, math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))


# --- sources ------------------------------------------------------------------------

def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {path.name}")
        urllib.request.urlretrieve(url, path)
    return path


def vector(name):
    return json.loads(fetch(VECTOR_URL.format(name), CACHE / "vectors" / f"{name}.geojson").read_text())


def read_tiff(data):
    """an uncompressed 8-bit greyscale tiff with one strip per row, as natural earth ships it."""
    order = "<" if data[:2] == b"II" else ">"
    ifd = struct.unpack(order + "I", data[4:8])[0]
    tags = {}
    for i in range(struct.unpack(order + "H", data[ifd:ifd + 2])[0]):
        tag, kind, count, value = struct.unpack(order + "HHII", data[ifd + 2 + 12 * i:ifd + 14 + 12 * i])
        if count == 1:
            tags[tag] = value if kind == 4 else value & 0xFFFF if order == "<" else value >> 16
        elif tag in (273, 279):
            tags[tag] = struct.unpack(order + f"{count}I", data[value:value + 4 * count])
    width, height = tags[256], tags[257]
    assert tags[258] == 8 and tags[259] == 1 and len(tags[273]) == height, "unexpected tiff layout"
    return width, height, [data[o:o + width] for o in tags[273]]


# --- relief -----------------------------------------------------------------------------

def box_blur(rows, r):
    """separable box blur of a list of lists, edges clamped."""
    h, w = len(rows), len(rows[0])
    out = []
    for row in rows:
        acc = row[0] * (r + 1) + sum(row[1:r + 1])
        line = []
        for x in range(w):
            line.append(acc / (2 * r + 1))
            acc += row[min(w - 1, x + r + 1)] - row[max(0, x - r)]
        out.append(line)
    cols = [out[0][x] * (r + 1) + sum(out[y][x] for y in range(1, r + 1)) for x in range(w)]
    res = []
    for y in range(h):
        res.append([c / (2 * r + 1) for c in cols])
        add, sub = out[min(h - 1, y + r + 1)], out[max(0, y - r)]
        cols = [c + a - s for c, a, s in zip(cols, add, sub)]
    return res


def relief():
    zipped = fetch(RELIEF_URL, CACHE / "relief" / "GRAY_50M_SR.zip")
    with zipfile.ZipFile(zipped) as z:
        width, height, rows = read_tiff(z.read("GRAY_50M_SR.tif"))
    # average 3x3 blocks: 30 pixels per degree is more than the output needs
    small = []
    for y in range(0, height - 2, 3):
        a, b, c = rows[y], rows[y + 1], rows[y + 2]
        parts = [r[i::3] for r in (a, b, c) for i in range(3)]
        small.append([sum(p) / 9 for p in zip(*parts)])
    per_degree = width / 3 / 360
    blurred = box_blur(box_blur(small, BLUR // 2), BLUR // 2)  # twice, for a softer falloff
    sh, sw = len(small), len(small[0])

    half_w = project(180, 0)[0]
    top, bottom = project(0, NORTH)[1], project(0, SOUTH)[1]
    out_h = round(WIDTH * (bottom - top) / (2 * half_w))
    lines = []
    for j in range(out_h):
        y = top + (j + 0.5) / out_h * (bottom - top)
        lat, scale = unproject_row(y)
        sy = min(sh - 1, int((90 - lat) * per_degree))
        src, blur = small[sy], blurred[sy]
        line = bytearray(WIDTH)
        for i in range(WIDTH):
            lon = math.degrees((-half_w + (i + 0.5) / WIDTH * 2 * half_w) / scale)
            if -180 <= lon < 180:
                sx = int((lon + 180) * per_degree)
                v, m = src[sx], blur[sx]
                line[i] = max(0, min(255, round(128 + (v - m) * GAIN - (m - 150) * TONE)))
            else:
                line[i] = 128
        lines.append(line)
    write_png(OUT / "relief.png", WIDTH, out_h, lines)

    # the same shading in plain longitude and latitude, for the globe's texture.
    # south of 60°s (antarctica, which isn't drawn) stays neutral
    globe = []
    for j in range(GLOBE_H):
        lat = 90 - (j + 0.5) * 180 / GLOBE_H
        sy = min(sh - 1, int((90 - lat) * per_degree))
        src, blur = small[sy], blurred[sy]
        line = bytearray(GLOBE_W)
        for i in range(GLOBE_W):
            if lat < -60:
                line[i] = 128
                continue
            sx = min(sw - 1, int((i + 0.5) * 360 / GLOBE_W * per_degree))
            v, m = src[sx], blur[sx]
            line[i] = max(0, min(255, round(128 + (v - m) * GAIN - (m - 150) * TONE)))
        globe.append(line)
    write_png(OUT / "relief-globe.png", GLOBE_W, GLOBE_H, globe)
    return WIDTH, out_h


def write_png(path, w, h, lines):
    raw = bytearray()
    for line in lines:  # filter type 1 (sub): smooth images compress far better
        raw.append(1)
        raw.append(line[0])
        raw.extend((line[i] - line[i - 1]) & 0xFF for i in range(1, w))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# --- vectors ------------------------------------------------------------------------------

def simplify(pts, tol):
    """douglas-peucker, iterative."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = 0.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def flat(pts):
    out = []
    for x, y in simplify([p[:2] for p in pts], TOLERANCE):
        out += [round(x, 2), round(y, 2)]
    return out


def lines_of(geom):
    return [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]


def polys_of(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def rivers():
    """[rank, name, [lon, lat, lon, lat, ...]]. no canals: suez and panama would be anachronistic."""
    out = []
    for f in vector("ne_50m_rivers_lake_centerlines_scale_rank")["features"]:
        p = f["properties"]
        if p.get("featurecla") != "River" or not f["geometry"] or p["scalerank"] > 6:
            continue
        for line in lines_of(f["geometry"]):
            pts = flat(line)
            if len(pts) >= 4:
                out.append([p["scalerank"], p.get("name") or "", pts])
    return sorted(out, key=lambda r: r[0])


def lakes():
    """[rank, [lon, lat, ...]] outer rings. no reservoirs, for the same reason as canals."""
    out = []
    for f in vector("ne_50m_lakes")["features"]:
        p = f["properties"]
        if p.get("featurecla") == "Reservoir" or not f["geometry"]:
            continue
        for poly in polys_of(f["geometry"]):
            pts = flat(poly[0])
            if len(pts) >= 8:
                out.append([p["scalerank"], pts])
    return out


SKIP_REGIONS = {"PENÍNSULA IBÉRICA", "WESTERN PLATEAU", "PUNJAB", "CAATINGAS"}


def regions():
    """[kind, name, min label level, [lon, lat] x 2]. the two points span the region's
    long axis, so the name can be lettered along it."""
    out = []
    for f in vector("ne_50m_geography_regions_polys")["features"]:
        p = f["properties"]
        kind = {"Range/mtn": "range", "Desert": "desert", "Plateau": "plateau"}.get(p["FEATURECLA"])
        if not kind or p["NAME"] in SKIP_REGIONS or (kind == "plateau" and p["SCALERANK"] > 2):
            continue
        pts = [pt[:2] for poly in polys_of(f["geometry"]) for pt in poly[0]]
        cx, cy = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)
        if cy < -60:
            continue  # antarctica isn't on the map
        # principal axis of the outline, in degrees scaled for latitude
        k = math.cos(math.radians(cy))
        sxx = sum(((x - cx) * k) ** 2 for x, _ in pts)
        syy = sum((y - cy) ** 2 for _, y in pts)
        sxy = sum((x - cx) * k * (y - cy) for x, y in pts)
        angle = 0.5 * math.atan2(2 * sxy, sxx - syy)
        ux, uy = math.cos(angle), math.sin(angle)
        along = [((x - cx) * k * ux + (y - cy) * uy) for x, y in pts]
        lo, hi = min(along), max(along)
        name = p.get("NAME_EN") or p["NAME"]
        if len(name) < len(p["NAME"]) and p["NAME"].upper().startswith(name.upper()):
            name = p["NAME"]  # some english names are cut short ("Ahag" for the ahaggar mountains)
        for short, full in (("Mts.", "Mountains"), ("Ra.", "Range"), ("Cord.", "Cordillera"), ("Plat.", "Plateau")):
            name = name.title().replace(short, full)
        ends = [[round(cx + t * ux / k, 2), round(cy + t * uy, 2)] for t in (lo * 0.8, hi * 0.8)]
        out.append([kind, name, p["MIN_LABEL"], ends])
    return sorted(out, key=lambda r: r[2])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    w, h = relief()
    print(f"  relief.png   {w}x{h}, relief-globe.png {GLOBE_W}x{GLOBE_H}")
    for name, data in (("rivers", rivers()), ("lakes", lakes()), ("regions", regions())):
        (OUT / f"{name}.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        print(f"  {name + '.json':<12} {len(data)}")


if __name__ == "__main__":
    main()
