# world timeline

an interactive map of human history: borders, wars and major events, scrubbed through time. no dependencies or build step.

```
python3 -m http.server     # then open http://localhost:8000
```

drag the timeline or use ←/→ (shift jumps between border snapshots). scroll to zoom, drag to pan, click a pin for details. the url hash holds the year: `/#1453`, `/#-500`.

## layout

```
index.html app.js style.css   viewer (canvas, equal earth projection, log time scale)
data/events.json              hand-curated events
data/borders/<year>.json      simplified border snapshots (geojson)
pipeline/borders.py           builds data/borders/ from historical-basemaps
pipeline/validate.py          checks data/events.json
```

## data

**years** are integers. negative means bce and there is no year 0 (`-1` is 1 bce, `1` is 1 ce).

**events** (`data/events.json`), an array of:

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

an event shows on the map from its start until its end, and stays (faded) until the next border snapshot.

**borders** (`data/borders/<year>.json`) are geojson feature collections with `name`, `subject` (overlord, if any) and `precision` (1 = approximate … 3 = exact) on each feature. `index.json` lists the available years. the map shows the latest snapshot at or before the selected year.

## pipeline

```
python3 pipeline/borders.py   # clones the source into .cache/, writes data/borders/
python3 pipeline/validate.py  # run after editing events.json
```

## license

border data comes from [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), so this project is GPL-3.0 too.
