"""fetch lucide icons (https://lucide.dev, isc licence) and write them into the app.

the map's pins are drawn on a canvas, which takes one path per icon, so every icon is
flattened into a single svg path: circles, ellipses, lines, rects, polylines and
polygons become path commands. the event kinds are listed below (KINDS); the buttons
in index.html name theirs with data-icon="…". change a name, then run:

  python3 pipeline/icons.py               # update app.js and index.html
  python3 pipeline/icons.py ship anchor   # just print these icons' paths

browse the icons at https://lucide.dev/icons
"""
import re
import sys
import urllib.request
from pathlib import Path

VERSION = "0.460.0"
URL = f"https://cdn.jsdelivr.net/npm/lucide-static@{VERSION}/icons/{{}}.svg"
ROOT = Path(__file__).resolve().parent.parent

# the glyph for each kind of event: pins, cards, search results, the explore key
KINDS = {
    "battle": "swords",
    "war": "flag",
    "political": "crown",
    "culture": "book-open",
    "science": "flask-conical",
    "exploration": "ship",
    "disaster": "flame",
    "art": "palette",
    "music": "music",
}


def num(v):
    return f"{float(v):g}"


NUMBER = r"-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?"


def absolute_start(d):
    """a path's opening "m" is absolute on its own, but relative once paths are joined,
    so spell it "M" (and the pairs that follow it, which are relative lines, "l")"""
    m = re.match(rf"\s*m\s*({NUMBER})[\s,]*({NUMBER})(.*)", d, re.S)
    if not m:
        return d
    rest = m.group(3).lstrip(" ,")
    return f"M{m.group(1)} {m.group(2)}" + ("l" + rest if re.match(NUMBER, rest) else rest)


def flatten(svg):
    """one path for everything drawn in a lucide svg"""
    out = []
    for tag, attrs in re.findall(r"<(path|circle|ellipse|line|rect|polyline|polygon)\b([^>]*?)/?>", svg):
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs))
        g = lambda k, d=0: float(a.get(k, d))
        if tag == "path":
            out.append(absolute_start(a["d"]))
        elif tag in ("circle", "ellipse"):
            rx = g("r") if tag == "circle" else g("rx")
            ry = g("r") if tag == "circle" else g("ry")
            cx, cy = g("cx"), g("cy")
            out.append(f"M{num(cx - rx)} {num(cy)}a{num(rx)} {num(ry)} 0 1 0 {num(2 * rx)} 0a{num(rx)} {num(ry)} 0 1 0 {num(-2 * rx)} 0")
        elif tag == "line":
            out.append(f"M{num(g('x1'))} {num(g('y1'))}L{num(g('x2'))} {num(g('y2'))}")
        elif tag == "rect":
            x, y, w, h = g("x"), g("y"), g("width"), g("height")
            rx = min(g("rx", a.get("ry", 0)), w / 2)
            ry = min(g("ry", rx), h / 2)
            if not rx:
                out.append(f"M{num(x)} {num(y)}h{num(w)}v{num(h)}h{num(-w)}z")
            else:
                arc = lambda dx, dy: f"a{num(rx)} {num(ry)} 0 0 1 {num(dx)} {num(dy)}"
                out.append(f"M{num(x + rx)} {num(y)}h{num(w - 2 * rx)}{arc(rx, ry)}v{num(h - 2 * ry)}{arc(-rx, ry)}"
                           f"h{num(2 * rx - w)}{arc(-rx, -ry)}v{num(2 * ry - h)}{arc(rx, -ry)}z")
        else:  # polyline, polygon
            pts = re.findall(r"-?[\d.]+", a["points"])
            pairs = [f"{num(pts[i])} {num(pts[i + 1])}" for i in range(0, len(pts) - 1, 2)]
            out.append("M" + "L".join(pairs) + ("z" if tag == "polygon" else ""))
    return "".join(out)


def fetch(name):
    with urllib.request.urlopen(URL.format(name), timeout=20) as r:
        return flatten(r.read().decode())


def update():
    paths = {}
    get = lambda name: paths.setdefault(name, fetch(name))

    js = ROOT / "app.js"
    text = js.read_text()
    block = "const KIND_ICONS = {\n" + "".join(f'  {k}: "{get(v)}", // {v}\n' for k, v in KINDS.items()) + "};"
    text, n = re.subn(r"const KIND_ICONS = \{.*?\n\};", lambda _: block, text, flags=re.S)
    assert n == 1, "KIND_ICONS not found in app.js"
    js.write_text(text)

    html = ROOT / "index.html"
    text = html.read_text()
    fill = lambda m: f'{m.group(1)}<path d="{get(m.group(2))}"/></svg>'
    text = re.sub(r'(<svg [^>]*data-icon="([\w-]+)"[^>]*>).*?</svg>', fill, text, flags=re.S)
    html.write_text(text)
    print(f"lucide {VERSION}: {len(paths)} icons -> app.js, index.html")


if __name__ == "__main__":
    if sys.argv[1:]:
        for name in sys.argv[1:]:
            print(f"{name}: {fetch(name)}")
    else:
        update()
