# world timeline

an interactive map of human history: borders, wars and major events, scrubbed through time. no dependencies or build step.

```
python3 -m http.server     # then open http://localhost:8000
```

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/wi11s/timeline)

## deploy

it's a static site, so any static host works. on vercel: import the repo (or run `npx vercel` here) and accept the defaults. `vercel.json` turns off the build step and sets cache headers, and `.vercelignore` leaves the offline pipeline out of the upload. event descriptions and photos are fetched from wikipedia's page summary api in the browser, so there is nothing to run server-side.

press play (or space) to watch history unfold; the button next to it sets the speed (0.5×–4×). drag or scroll over the timeline to scrub, or use ←/→ (shift jumps between border snapshots). on the map, scroll or pinch to zoom, double-click to zoom in (shift: out), drag to pan (it coasts when you let go). click a pin or a notification for details: a summary and photo from wikipedia. the url hash holds the year: `/#1453`, `/#-500`.

when the border snapshot changes, territory doesn't pop: changed areas are taken over by an advancing front that starts from the new owner's old land, and renamed realms cross-fade in place. big events (80+ wikipedia language editions) pop a notification on the map as the timeline passes them. when the map gets crowded, the most widely covered events win the space.

## layout

```
index.html app.js style.css   viewer (canvas, equal earth projection, log time scale)
vercel.json .vercelignore     static hosting config
data/events.json              hand-curated events
data/events-wikidata.json     ~5,000 events pulled from wikidata
data/borders/<year>.json      simplified border snapshots (geojson)
pipeline/borders.py           builds data/borders/ from historical-basemaps
pipeline/wikidata.py          builds data/events-wikidata.json
pipeline/validate.py          checks both event files
```

## data

**years** are integers. negative means bce and there is no year 0 (`-1` is 1 bce, `1` is 1 ce).

**events** (`data/events.json`, `data/events-wikidata.json`), arrays of:

| field        | type    | notes                                                        |
|--------------|---------|--------------------------------------------------------------|
| `id`         | string  | unique slug                                                  |
| `title`      | string  |                                                              |
| `kind`       | string  | `war` `battle` `political` `culture` `science` `exploration` `disaster` |
| `start`      | int     | year                                                         |
| `end`        | int?    | omit for single-year events                                  |
| `approx`     | bool?   | date is approximate                                          |
| `lat`, `lon` | number  | where it happened (for wars, where it started)               |
| `importance` | 1–3     | 1 = world-changing, 3 = notable                              |
| `wiki`       | string? | wikipedia url                                                |
| `qid`        | string? | wikidata item                                                |
| `sitelinks`  | int?    | how many wikipedia language editions cover it; ranks events  |

an event shows on the map from its start until its end, then lingers (fading) for a short stretch of timeline. curated events override their wikidata twins (matched by wikipedia url) but borrow their `sitelinks`.

**borders** (`data/borders/<year>.json`) are geojson feature collections with `name`, `subject` (overlord, if any) and `precision` (1 = approximate … 3 = exact) on each feature. `index.json` lists the available years. the map shows the latest snapshot at or before the selected year.

## pipeline

```
python3 pipeline/borders.py   # clones the source into .cache/, writes data/borders/
python3 pipeline/wikidata.py  # queries wikidata (cached in .cache/wikidata/; --refresh refetches)
python3 pipeline/validate.py  # run after editing events
```

## license

border data comes from [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), so this project is GPL-3.0 too. event data in `events-wikidata.json` comes from [wikidata](https://www.wikidata.org) (CC0).
