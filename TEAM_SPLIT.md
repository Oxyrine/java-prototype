# Team split — 3 people, by pipeline stage

The project is already three languages doing three sequential jobs:

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

Splitting along those seams means each person's files barely overlap, so there's almost
nothing to merge-conflict over. The two formats that cross a seam — the text grid and
`level01.json` — are already fixed and documented in [ARCHITECTURE.md](ARCHITECTURE.md);
treat them as a contract, not something to redesign mid-project (see "Ground rules" below).

## Lane A — Java: grid → level geometry

**Owns:** `src/main/java/com/blueprint/**`, `pom.xml`

**Reads:** the text grid format — one char per cell (`0` floor, `1` wall, `2` spawn, `3`
doorway, `4` window, `5` void outside the building), optional `# cellSize=... wallHeight=...`
header. Defined in [ARCHITECTURE.md](ARCHITECTURE.md#stage-2--grid-to-level-json-java-maven-project-comblueprint).

**Produces:** `web/level01.json` — `LevelData` (name, width, height, cellSize, wallHeight,
spawn, grid, walls, windows). Field names and shapes are load-bearing for Lane C; don't
rename or restructure without telling them first.

**CLI contract Lane B depends on:**
`java -cp <classpath> com.blueprint.Main --blueprint=<path> --output=<path> --cellSize=<f> --wallHeight=<f>`
(invoked by `tools/build_level.py`'s `run_java()`, never `mvn exec:java` — see that file's
comment on why).

**Can be developed and tested with zero Python or JS running** — feed it any of the
existing sample grids directly:
```bash
py tools/build_level.py blueprints/house.txt --out house --width-metres 12
# or run the Java CLI directly against blueprints/level01.txt / apartment_demo.txt
```
Sanity-check output by eye (JSON) or by loading it in the browser once Lane C's frontend is
up — you don't need Lane B's converter to have run recently.

**Real backlog to pick from** (from ARCHITECTURE.md, nothing invented):
- Room-label plumbing exists (`data.roomLabels = [{name, row, col}]`) but nothing produces
  it yet — needs an OCR pass, which is explicitly *not* Lane A's job (that's image
  processing, Lane B's territory) but consuming/matching labels once emitted is.
- Anything in `computeRooms`-adjacent Java-side logic you want to hand richer data to Lane C
  through the JSON (e.g. per-room metadata) goes here — extend the schema, tell Lane C.

## Lane B — Python: image → grid, plus the server

**Owns:** `tools/blueprint_to_grid.py`, `tools/build_level.py`, `tools/make_sample_blueprint.py`,
`tools/test_convert.py`, `server.py`, `requirements.txt`

**Reads:** an uploaded PNG/JPG/PDF floor plan.

**Produces:** the same text grid format Lane A reads (must stay in sync — see contract
above), and the HTTP API Lane C's frontend calls:
- `POST /api/convert` — image in, runs the whole pipeline, returns wall count / reachable
  fraction / warning
- `GET /api/levels`, `POST /api/load-level` — saved-grid picker
- `GET /`, `GET /<file>` — static file serving for `web/`

**Three-way contract to keep in sync** (already called out in ARCHITECTURE.md — it's not
new, just don't let it drift): accepted file types (`.png/.jpg/.jpeg/.pdf`) are stated in
`ALLOWED_SUFFIXES` in `server.py`, the `accept` attribute + hint text in `web/index.html`,
and the docstring in `blueprint_to_grid.py`. If Lane B changes what's accepted, Lane C's
upload form text has to change too — flag it, don't just push it.

**Can be developed and tested independently:** `py tools/test_convert.py` self-checks the
converter against a fixture image with no Java or JS involved. `blueprint_to_grid.convert()`
can be called standalone to produce a `.txt` + `.overlay.png` for visual inspection.

**Real backlog to pick from:**
- Deployment: ARCHITECTURE.md has a whole "not yet done" list under Deployment — a
  `Dockerfile` (JDK 17 + Maven + Python), a `.dockerignore`, testing the Render build. This
  is squarely Lane B's (it's server/environment, not rendering or level geometry).
  server.py already binds `0.0.0.0` + `$PORT` for this.
- OCR for room labels (feeds Lane A's `roomLabels` field, see above) if the group wants
  that feature — entirely new territory, doesn't touch anyone else's files.

## Lane C — Three.js: rendering, movement, UI

**Owns:** `web/main.js`, `web/style.css`, `web/index.html`

**Reads:** `web/level01.json` (Lane A's output) directly via `fetch()`; calls Lane B's
`/api/*` endpoints for the upload panel and saved-level picker.

**Can be developed independently:** `web/level01.json` is already checked out on disk and
regenerable from any sample grid via `py tools/build_level.py` without touching the
converter or the server — Lane C doesn't need Lane A or B running to iterate on rendering,
movement, doors, HUD, or the minimap against a fixed level. Only the upload flow itself
needs Flask up.

**Real backlog to pick from:** whatever's next on rendering/UX/gameplay feel — this is the
lane most people picture when they think "the game," so it's reasonable for it to carry the
most visible feature work (HUD, minimap, doors, materials, atmosphere are all already here
and can keep growing).

## Ground rules for staying out of each other's way

1. **The two cross-lane formats (text grid, `level01.json`) are frozen.** If a lane needs to
   change one — new grid character, new JSON field — say so before writing code, not after.
   Everyone else only has to react to a documented format change, never guess at one.
2. **File ownership avoids merge conflicts almost entirely**, but `README.md` and
   `ARCHITECTURE.md` are shared — whoever touches a stage updates that stage's section, and
   whoever's change is smaller yields on conflicts.
3. **Integration checkpoint before merging to `main`**: run
   `py tools/test_convert.py` (Lane B's self-check) and then actually load the page and walk
   around (`py server.py`, http://localhost:8000) before merging. A lane can be individually
   "done" and still break the walkthrough if a contract slipped — this catches that instead
   of finding out at demo time.
4. **Commit under your own name.** This repo currently has one git author. Once three
   people push to it, each person needs their own commits under their own GitHub identity
   (their own local `git config user.name/email`, not this session's) — that's what makes
   individual contribution visible for grading, and it's also just correct attribution.
5. Short-lived branches per person, merged often, beat one long-running branch per lane —
   less to reconcile at the end, and the file-ownership split means fast-forward merges are
   the common case, not the exception.
