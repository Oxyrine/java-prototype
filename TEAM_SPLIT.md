# Team split — 3 people, zero cross-dependency

The project is three languages doing three sequential jobs:

```
floor plan image
      |  tools/blueprint_to_grid.py        <- Lane B (Python)
      v
text grid (blueprints/*.txt)
      |  src/main/java/com/blueprint/*     <- Lane A (Java)
      v
web/level01.json
      |  web/main.js                       <- Lane C (JS/Three.js)
      v
browser
```

Splitting along those seams keeps each person's *files* from overlapping. That alone isn't
enough to make the work independent, though — as originally written, Lane A needed nothing
from anyone, but Lane C needed a `web/level01.json` that only exists after Lane A's code
*runs*, and that file is gitignored (it's a build artifact, regenerated on every
conversion), so a fresh clone doesn't have one. That's a real dependency: Lane C blocked on
someone else's toolchain being installed and working before touching a single line of
`main.js`.

**Fixed below**: every lane now has a committed, tracked fixture to build against on day
one — nobody runs anyone else's code just to get started. The two formats that cross a
seam (the text grid, `level01.json`) are documented in [ARCHITECTURE.md](ARCHITECTURE.md)
and frozen — see "Ground rules."

## Day-1 setup — no waiting on anyone

| Lane | Fixture | Command |
|---|---|---|
| A (Java) | `blueprints/house.txt`, `level01.txt`, `apartment_demo.txt`, `wikicommons_demo.txt` — four tracked sample grids | none, already in the repo |
| B (Python) | any real floor-plan image, saved locally as `blueprints/uploaded.jpg` (gitignored — everyone keeps their own, nobody shares/commits one) | — |
| C (JS/Three.js) | `web/level01.sample.json` — a tracked, pre-built level matching the real schema | `cp web/level01.sample.json web/level01.json` |

Each of these works with **only that lane's own tools installed**. Lane C in particular
needs no JDK, no Maven, no Python — copy the sample JSON and open `web/index.html` (or
`py server.py` if you want the upload panel too) and you're rendering a real level.

## Lane A — Java: grid → level geometry

**Owns:** `src/main/java/com/blueprint/**`, `pom.xml`

**Reads:** the text grid format — one char per cell (`0` floor, `1` wall, `2` spawn, `3`
doorway, `4` window, `5` void outside the building), optional `# cellSize=... wallHeight=...`
header. Defined in [ARCHITECTURE.md](ARCHITECTURE.md#stage-2--grid-to-level-json-java-maven-project-comblueprint).

**Produces:** `web/level01.json` — `LevelData` (name, width, height, cellSize, wallHeight,
spawn, grid, walls, windows). Field names and shapes are load-bearing for Lane C; don't
rename or restructure without telling them first.

**Dependency on anyone else: none.** Four sample grids are already tracked in git —
develop and test against them directly:
```bash
py -c "import sys; sys.path.insert(0,'tools'); import build_level; from pathlib import Path; \
  build_level.run_java(Path('blueprints/house.txt'), Path('web/level01.json'), 0.125, 2.5)"
```
(cellSize/wallHeight for each fixture are in its own `#` header line — read it, don't guess.)
No Python conversion step involved, no server, no browser needed to sanity-check the JSON
by eye.

**Real backlog to pick from** (from ARCHITECTURE.md, nothing invented):
- Room-label plumbing exists (`data.roomLabels = [{name, row, col}]`) but nothing produces
  it yet — needs an OCR pass, which is Lane B's territory, but consuming/matching labels
  once emitted is Lane A's.
- Anything that hands Lane C richer per-room data through the JSON goes here — extend the
  schema, then tell Lane C (see Ground rules).

## Lane B — Python: image → grid, plus the server

**Owns:** `tools/blueprint_to_grid.py`, `tools/build_level.py`, `tools/make_sample_blueprint.py`,
`tools/test_convert.py`, `server.py`, `requirements.txt`

**Reads:** a floor-plan image (PNG/JPG/PDF).

**Produces:** the same text grid format Lane A reads (must stay in sync — see contract
above), and the HTTP API Lane C's frontend calls (`POST /api/convert`, `GET /api/levels`,
`POST /api/load-level`, static file serving for `web/`).

**Three-way contract to keep in sync** (already true today, just don't let it drift):
accepted file types (`.png/.jpg/.jpeg/.pdf`) are stated in `ALLOWED_SUFFIXES` in
`server.py`, the `accept` attribute + hint text in `web/index.html`, and the docstring in
`blueprint_to_grid.py`. Change what's accepted, flag it to Lane C — their upload-form copy
has to match.

**Dependency on anyone else: none, but you need your own test image.**
`tools/test_convert.py` is hardcoded to `blueprints/uploaded.jpg`, which is gitignored (a
real plan can be private, so it's never committed) — meaning **everyone needs their own
copy**, not a shared one. Grab any real floor plan photo/scan/export, save it as
`blueprints/uploaded.jpg` locally, then:
```bash
py tools/test_convert.py
```
runs entirely inside Lane B's own files — no Java, no server, no browser. If you'd rather
not hunt down a real plan, `py tools/make_sample_blueprint.py` generates a synthetic one at
`blueprints/sample_plan.png`, but it has no window symbols, so the full `demo()` assertions
(which require `window_count > 0`) won't pass against it as-is — fine for poking at
`blueprint_to_grid.convert()` directly, not a substitute for the real self-check.

**Real backlog to pick from:**
- Deployment: ARCHITECTURE.md's "not yet done" list under Deployment — a `Dockerfile`
  (JDK 17 + Maven + Python), a `.dockerignore`, a test Render build. `server.py` already
  binds `0.0.0.0` + `$PORT` for this.
- OCR for room labels (feeds Lane A's `roomLabels` field above), if the group wants it —
  new territory, touches nobody else's files to build.

## Lane C — Three.js: rendering, movement, UI

**Owns:** `web/main.js`, `web/style.css`, `web/index.html`

**Reads:** `web/level01.json` via `fetch()`; calls Lane B's `/api/*` endpoints only for the
upload panel and saved-level picker — everything else (rendering, movement, collision,
doors, HUD, minimap) runs against whatever's in `level01.json`, full stop.

**Dependency on anyone else: none.** `web/level01.sample.json` is a tracked fixture (a real
generated level, not hand-faked — same schema Lane A actually emits):
```bash
cp web/level01.sample.json web/level01.json
py -m http.server 8000 --directory web   # or: py server.py, for the upload panel too
```
No JDK, no Maven, no Python conversion needed to work on anything client-side. Only the
upload-and-convert flow itself needs Flask (`py server.py`) running.

**Real backlog to pick from:** whatever's next on rendering/UX/gameplay feel — HUD,
minimap, doors, materials, atmosphere are all already in and can keep growing.

## Ground rules for staying independent

1. **The two cross-lane formats (text grid, `level01.json`) are frozen.** New grid
   character, new JSON field — say so before writing the code that produces it, not after.
   Everyone else only has to react to a documented, announced format change, never guess at
   one or wait on it.
2. **Fixtures are committed, not personal.** `blueprints/{house,level01,apartment_demo,
   wikicommons_demo}.txt` and `web/level01.sample.json` are checked into git specifically so
   nobody needs another lane's toolchain running to develop against real-shaped data. If you
   add a new fixture, commit it the same way.
3. `README.md` / `ARCHITECTURE.md` are the one shared surface — whoever touches a stage
   updates that stage's section; smaller diff yields on conflicts.
4. **Integration checkpoint before merging to `main`**: run `py tools/test_convert.py`
   (Lane B), then actually load the page against a real end-to-end conversion and walk
   around. A lane can be individually "done" against its fixtures and still break the real
   walkthrough if a contract slipped silently — this is what catches that before demo day.
5. **Commit under your own identity.** Each person's own local `git config
   user.name`/`user.email` (not this session's) — that's what makes individual contribution
   visible for grading.
6. Short-lived branches per person, merged often. The fixture-based independence above means
   fast-forward merges should be the common case, not three-way conflicts.
