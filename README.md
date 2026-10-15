# world timeline

an interactive map of human history: borders, wars and major events, scrubbed through time. ~7,000 events (including some 480 works of art) and border snapshots from 3000 bce to today, no dependencies and no build step.

it's open source and contributions are very welcome, whether that's fixing a date, adding an event, or working on the map itself. you don't need to know javascript to help.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/wi11s/timeline)

## run it

```
git clone https://github.com/wi11s/timeline.git
cd timeline
python3 -m http.server     # then open http://localhost:8000
```

any static file server works (`npx serve` too). there's nothing to install: the viewer is plain html, css and javascript, and the python scripts only use the standard library.

**using it:** press play (or space) to watch history unfold, one story at a time: each opens in the card on the right, joined by a line to its place on the map; the button at the end of the timeline sets the speed. the timeline shows how much happened when, and hovering it shows the year under the pointer. the camera follows the stories, turning (or panning) and zooming a little with each, and flies in to the biggest moments, holding there a moment before pulling back out (it leaves the camera alone for a few seconds whenever you move the map yourself). **explore** offers stories (the roman empire, the mongols, the world wars…) and regions: each flies to the right part of the world and plays its own stretch of time, slower, with smaller events too. drag or scroll over the timeline to scrub, or use ←/→ (shift jumps between border snapshots). pinch or use a mouse wheel to zoom the map, double-click to zoom in, and drag (or two-finger scroll on a trackpad) to pan. it opens on a 3d globe; the flat map button (or `g`) switches to the flat map and back, keeping the same place in view. click a pin for a summary and photo from wikipedia, or click a territory to see what it was and the biggest events inside its borders. **search** (or `/`) finds events by name or by year (`1066`, `44 bce`): pick one and the map jumps to that year, flies there and opens it. the url holds the year, so you can link to a moment: `/#1453`, `/#-500`.

## ways to help

### add or fix an event (no code)

hand-picked events live in [`data/events.json`](data/events.json), one per line. add one by copying a line like this one and changing it (the `id` must be new):

```json
{"id": "magna-carta", "title": "Magna Carta", "kind": "political", "start": 1215, "lat": 51.44, "lon": -0.56, "importance": 2, "wiki": "https://en.wikipedia.org/wiki/Magna_Carta"}
```

then check it:

```
python3 pipeline/validate.py
```

the fields are described under [events](#events) below. a few tips:

- get coordinates by right-clicking a spot in google maps or openstreetmap. for wars, use where it started.
- `importance` 1 is reserved for world-changing events; most things are 2 or 3.
- if an event already comes from wikidata with a wrong title, date or place, adding it here with the same `wiki` url overrides it.

### add a story or a region

focuses live in [`data/focuses.json`](data/focuses.json): a title, a one-line blurb, the years (`from`, `to`), where to look (`lon`, `lat`, and `zoom`, where 1 is the whole world), and optionally a `box` of `[west, south, east, north]` to limit the events to. `group` is `stories` or `regions`, `seconds` sets how long it plays at 1× (90 by default), and `kinds` (optional) limits it to some kinds of event, like `["art"]`. a focus picks its own reel of stories in advance from just its events (see stories below), so something is always happening, and its strongest picks become guided stops.

### fix the data at the source

most events come from [wikidata](https://www.wikidata.org), and the borders come from [historical-basemaps](https://github.com/aourednik/historical-basemaps). if something is wrong there (a battle with no coordinates, a misdated treaty, a border in the wrong place), fixing it upstream helps everyone who uses that data. it reaches this map the next time the pipeline runs (see [pipeline](#pipeline)). mention the fix in an issue or pr so we know to refresh.

### work on the map

the viewer is three files: `index.html`, `style.css` and `app.js`. see [how it works](#how-it-works) for a tour. ideas that would make a real difference:

- **coverage:** curated events outside europe, and science and culture milestones (wikidata rarely gives these a location, so the pipeline misses them)
- **borders after 2010:** the newest snapshot is 2010, so south sudan and others are missing
- **accessibility:** keyboard navigation between pins, screen reader text for the map
- **performance on low-end phones**

### report a problem

open an [issue](https://github.com/wi11s/timeline/issues) with the year (the url hash), your browser and device, and a screenshot if it's visual. wrong facts count too.

## making a pull request

1. fork the repo and create a branch (`git checkout -b fix-battle-of-hastings`)
2. make your change and run it locally
3. if you touched an event file, run `python3 pipeline/validate.py`
4. if you touched the viewer, check:
   - light and dark mode (follows your system setting)
   - a narrow window or your phone
   - playing through a busy stretch, like 1900–1950
5. open a pull request saying what changed and why. add a screenshot or a link like `/#1453` for anything visual

small, focused prs are easiest to review. one event or one fix per pr is great.

## how it works

```
index.html style.css app.js   the viewer
globe.js                      the 3d globe (webgl2, no library)
story.js                      camera flights, guided stops, focuses
search.js                     the search box: matching events by name or year
data/focuses.json             the stories and regions in "explore"
data/events.json              hand-curated events (edit these)
data/events-wikidata.json     events generated from wikidata (don't edit, regenerate)
data/borders/<year>.json      border snapshots, generated from historical-basemaps
data/borders/index.json       the list of snapshot years
data/physical/                shaded relief, rivers, lakes, mountain and desert names (natural earth)
pipeline/wikidata.py          builds data/events-wikidata.json
pipeline/borders.py           builds data/borders/
pipeline/cliopatria.py        names unnamed territories and adds missing land, from cliopatria
pipeline/corrections.py       fixes to the border source, applied by borders.py
pipeline/physical.py          builds data/physical/
pipeline/validate.py          checks both event files
pipeline/icons.py             fetches the lucide icons (event kinds and buttons) into app.js and index.html
vercel.json .vercelignore     static hosting config
robots.txt sitemap.xml        for search engines, along with the meta tags in index.html
og-image.jpg favicon.svg      the link-preview image and icons. regenerate og-image.jpg
apple-touch-icon.png          if the map's look changes a lot
```

`app.js` is organised in sections, top to bottom:

- **projection and time scale.** the map uses the equal earth projection. the timeline is linear from 3000 bce, but playback speed, how long pins linger and scrolling to scrub all run on a log scale of years before present, so playback sweeps through antiquity and slows down for the densely recorded modern era.
- **data.** loads border snapshots on demand and merges the two event files, ranking events by how many wikipedia language editions cover them.
- **view.** smooth zoom, pinch, panning with momentum. only realms on screen are drawn, and the water lines (the slowest part) wait until the map stops moving.
- **border transitions.** when the snapshot changes, both maps are rasterised and each changed pixel flips once the new owner's "front" reaches it, so empires visibly grow and shrink instead of popping.
- **rendering.** an old-atlas style: realm tints, water lines along coasts, ocean names, labels sized to their realm. everything except the pins is cached between frames.
- **physical geography.** shaded relief blended into the realm tints (soft-light, so flat land is untouched), rivers and lakes that fill in as you zoom, and mountain ranges and deserts lettered along their length. it loads after the map and works the same in every year.
- **stories: the reel.** one story is told at a time, in the card, so what plays is chosen in advance (`buildReel` in `story.js`): greedily, the most interesting event that still fits, at least `REEL_S` seconds of playback from every other pick. interest is how many wikipedias cover the event (scaled up for older eras), with routine "x founded" entries marked down and the hand-picked turning points in `events.json` always near the top; a pick that would repeat the kind or the part of the world of the picks either side of it counts for less, so the reel keeps moving around the world. the event marked `finale` is always the last story, with nothing picked after it. the strongest picks, `STOP_S` apart, are guided stops, which the camera flies to (and which stay up longer). playback eases while a story is fresh and holds back from the next pick until the current one has been read (`holding()` in `app.js`), so busy stretches of history slow down and quiet ones fly by. summaries for the next few picks are fetched ahead. a line (`drawTether`) joins the card to the event's pin. a card the reader opens, or touches, stays until they close it, and the reel lets it be.
- **territories.** hovering outlines a territory and clicking opens its card. realm names come from the border data, so the wikipedia article is found by title, then by a cautious search. when it picks wrong or finds nothing, add the name to `REALM_ARTICLES` in `app.js`.
- **timeline and playback.**
- **map interaction and the event card.** descriptions and photos come from wikipedia's page summary api, fetched in the browser.

`globe.js` is the 3d view. there's no 3d library: a webgl2 fragment shader works out which longitude and latitude each pixel of the disc is looking at, and samples a plain longitude/latitude picture of the map, painted in the same atlas style whenever the borders change (old and new cross-fade). labels, pins and the card's line are still drawn by `app.js` on the 2d canvas on top, placed with `globeScreen()` instead of the flat projection, so everything else works the same in both views.

colours, the realm palette and typography are css variables at the top of `style.css`.

## conventions

- **no dependencies, no build step.** if something seems to need a library, open an issue first.
- match the surrounding code: plain modern javascript, small functions, comments that explain *why*.
- generated files (`events-wikidata.json`, `data/borders/`) are only changed by running the pipeline, never by hand.

## data

**years** are integers. negative means bce and there is no year 0 (`-1` is 1 bce, `1` is 1 ce).

### events

`data/events.json` and `data/events-wikidata.json` are arrays of:

| field        | type    | notes                                                        |
|--------------|---------|--------------------------------------------------------------|
| `id`         | string  | unique slug                                                  |
| `title`      | string  |                                                              |
| `kind`       | string  | `war` `battle` `political` `culture` `science` `exploration` `disaster` `art` (each has its own pin glyph and colour) |
| `start`      | int     | year                                                         |
| `end`        | int?    | omit for single-year events                                  |
| `approx`     | bool?   | date is approximate                                          |
| `lat`, `lon` | number  | where it happened (for wars, where it started)               |
| `importance` | 1–3     | 1 = world-changing, 3 = notable                              |
| `wiki`       | string? | english wikipedia url; powers the description and photo      |
| `qid`        | string? | wikidata item (generated events)                             |
| `sitelinks`  | int?    | how many wikipedia language editions cover it; ranks events  |
| `finale`     | bool?   | the last story playback tells (one event, in `events.json`)  |

an event shows on the map from its start until its end, then lingers (fading) for a short stretch of timeline. the most interesting of them play as stories (see the reel, above). curated events override their wikidata twins (matched by wikipedia url) but borrow their `sitelinks`.

### borders

`data/borders/<year>.json` are geojson feature collections with `name`, `subject` (overlord, if any) and `precision` (1 = approximate … 3 = exact) on each feature. the map shows the latest snapshot at or before the selected year.

historical-basemaps leaves many territories unnamed (switzerland from 1994 on, many islands) and some land out altogether (bornholm, the bahamas, most small islands of indonesia). `pipeline/cliopatria.py` fills these gaps from [cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria), the seshat databank's map of 1,600+ polities, without guessing: an unnamed territory is named only if one cliopatria polity of that year holds at least 60% of it (taking the source's own name for that polity where it has one, so a danish island is "denmark"), and a cliopatria shape is added only where the source has no land at all. borders and coastlines that the source does have are never redrawn. territories it couldn't name stay unlabelled: in early periods most land has no known polity in either dataset.

each territory's `precision` decides how it's drawn. approximate ones (1: nearly everything before 1800, and peoples rather than states) meet in a soft wash of colour about 2° wide, with no border line, the way old maps showed uncertain extents; exact ones (2 and 3) get crisp edges and a border. coasts are always crisp. shapes added from cliopatria count as 2.

where the source data is wrong, `pipeline/corrections.py` patches it after every build, and documents each change. at the moment that's palestine: the source shows israel before 1948 and draws the west bank and gaza as israel afterwards. the corrections show mandatory palestine until 1948, jordanian and egyptian rule until 1967, the occupied palestinian territories until 1988, and the state of palestine from its declaration of independence on. new corrections are welcome. please cite sources in the pr.

## pipeline

regenerates the data files. you only need this when refreshing from the sources or changing how data is pulled.

```
python3 pipeline/wikidata.py  # queries wikidata, cached in .cache/wikidata/ (--refresh refetches)
python3 pipeline/borders.py   # clones historical-basemaps into .cache/, writes data/borders/
python3 pipeline/physical.py  # downloads natural earth into .cache/, writes data/physical/ (relief for both views)
python3 pipeline/validate.py  # checks both event files
```

which wikidata classes are pulled, and how many wikipedia editions an event needs to be included, is set in `CATEGORIES` at the top of `pipeline/wikidata.py`. fewer languages write about the ancient world, so older events need fewer (`ERA`: about a third before 500 ce), and the app weighs events against their own era the same way. works of art are placed where they were made or found, never where they're kept now: murals, frescoes, mosaics and sculpture by their own location if needed, paintings by their painter's workplace only when that was a single place, and otherwise left out. the wikidata query service rate-limits, so a full refresh takes a few minutes.

## deploy

it's a static site, so any static host works. on vercel, import the repo and accept the defaults (or run `npx vercel`). `vercel.json` sets cache headers, and `.vercelignore` leaves the pipeline out of the upload. page views are counted with [vercel web analytics](https://vercel.com/docs/analytics) (cookieless, no personal data), turned on under the project's analytics tab; running locally or on another host, the script just isn't there.

## license

[GPL-3.0](LICENSE), because the border data from [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) is GPL-3.0. territory names and some shapes come from [cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria) by the seshat global history databank ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); simplified, and used only to fill gaps as described under borders). by contributing you agree your contribution is released under the same license. event data from [wikidata](https://www.wikidata.org) is CC0, and relief, rivers, lakes and region names come from [natural earth](https://www.naturalearthdata.com) (public domain); descriptions and photos are loaded live from wikipedia and wikimedia commons under their own licenses. icons are from [lucide](https://lucide.dev) ([ISC](https://lucide.dev/license)); to change one, edit the name in `pipeline/icons.py` (event kinds) or a button's `data-icon` in `index.html`, then run `python3 pipeline/icons.py`.
