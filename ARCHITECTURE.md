# Blueprint Explorer — architecture reference

For a future session that needs to work in this repo without re-reading everything.
Read this first, then jump to the specific file(s) below.

## What this is

Turns a 2D architectural floor-plan image (PNG/JPG/PDF) into a walkable 3D level you
explore in a browser, first-person, Three.js. Three pieces, three languages, one pipeline:

```
floor plan image
      |  tools/blueprint_to_grid.py  (Python: image processing)
      v
text grid (blueprints/*.txt, chars: 1 wall / 0 floor / 2 spawn / 3 doorway)
      |  src/main/java/com/blueprint/*  (Java/Maven: grid -> level geometry)
      v
web/level01.json  (walls merged into rectangles, spawn point, room grid)
      |  web/main.js  (Three.js: renders + lets you walk around)
      v
browser
```

`server.py` (Flask) is the glue that runs this whole pipeline on demand from the browser's
upload form, and also serves `web/` as static files.

## Run it

```
py -m pip install -r requirements.txt   # once
py server.py
```
Then open http://localhost:8000. (`.claude/launch.json` runs the same command as the
`blueprint-web` preview config.) Uploading an image in the page's side panel re-runs the
whole pipeline and reloads the level; there's also a dropdown to reload any saved
`blueprints/*.txt` without re-converting.

CLI alternative to the browser upload flow: `py tools/build_level.py blueprints/x.png --width-metres 10.5`.

Self-check: `py tools/test_convert.py` (asserts the real test image converts to a fully
reachable, valid grid — see "Testing" below).

## Stage 1 — image to grid (Python, `tools/blueprint_to_grid.py`)

Pipeline inside `convert()`: reject if source width `< MIN_PLAN_WIDTH_PX` → downscale to
`MAX_WORK_WIDTH` → grayscale → Otsu binarize → **opening by reconstruction** (the key
stage, below) → auto-crop to the largest connected ink blob (drops disconnected dimension
text) → downsample *both* the raw and opened ink to the same grid → morphological close →
remove small blobs → keep only the largest connected wall component → prune 1-cell noise
tips → **detect openings and split them into windows vs doorways** → `carve_doorways` (now
only a fallback) → `brick_up_cupboards` → `seal_blind_doorways` → `fill_impassable_gaps` →
seal the outer border → auto-place spawn → reject if reachable fraction `< MIN_REACHABLE_
FRACTION` → write `<name>.txt` + `<name>.overlay.png`.

**The central idea: walls are drawn thick, everything else is drawn thin.** Swing arcs,
door leaves, furniture, fixtures, room labels, dimension lines, window mullions and closet
shelving are all thin strokes; walls are thick filled bars. `opening_by_reconstruction()`
erodes to find wall cores then regrows them *constrained to the original ink*, so walls
return at full thickness while anything that lost its core stays deleted. The regrow
constraint is load-bearing — a plain erode/dilate returns walls too thin, whole segments
drop below the ink-fraction threshold, and the building envelope ends up full of holes.

The envelope is still built from the **raw** ink, exactly as before. Opening is used only
as a *classifier*: a wall cell that survives it is real wall, one that doesn't is symbol
ink. A door then reads, scanning along its wall, as `real wall / short run of symbol /
real wall` — which is what `find_wall_gaps()` looks for. Each opening found is classified
by tentatively cutting it and checking whether `outside_mask` grew: if the outdoors gets
in it is in the envelope (a window, or a balcony slider), otherwise it is an interior
doorway.

Symbol ink that turns out **not** to be plugging a doorway is furniture — a counter run, a
hob, a wardrobe outline. Left standing it extrudes to full wall height, so the kitchen came
out as a maze of 2.5 m slabs. It is deleted one connected blob at a time, each blob put back
if `outside_mask` grew, for the same reason as above. Deleting it all in one pass does
**not** work — reachability fell 100% → 65.7%, because the envelope is built from raw ink
and some of what the opening rejected is genuinely load-bearing. On the Unit C1 plan this
drops ~170 cells and takes `carve_doorways` from 67 invented cells to **0**.

Anything still standing as a **protruding spur** goes too — a counter edge drawn thick
enough to pass the opening filter, a fitting, a stub of hatching. Extruded to full height
it is a pillar in the middle of a room with nothing in the plan behind it. `prune_wall_tips`
only ever peels one cell, so a 3-cell spur survived every pass; it now runs repeatedly, up
to `STUB_METRES / cell_size` times. A spur is a dead end and encloses nothing, so this
cannot open the envelope — but it is **bounded, never run to convergence**, because
convergence eats a genuinely dangling wall cell by cell back to its root.

Before this existed, a door's swing arc sealed its own doorway shut, every room came out
disconnected, and `carve_doorways` punched replacement holes wherever it found a thin wall
— including between two bedrooms that share no door. `carve_doorways` remains as a safety
net, and its sanity check now measures only what it had to *invent*: near zero means the
drawing was read correctly, and a large number means the input isn't a clean top-down plan
(a section/elevation view) and the upload is rejected with `ValueError`.

After doorway detection, three more passes clean up what detection alone leaves standing —
each one only removed if the connectivity guard (tentative cut, check whether
`connected_components` grew a new region, undo if so) says nothing gets stranded:

- **`brick_up_cupboards`** blocks every doorway and re-checks the interior's connected
  components; anything under `MIN_ROOM_AREA_M2` is a cupboard/duct/void, not a room, and
  gets filled solid. Runs *before* the doorway seal below, on purpose: a cupboard's own
  door is real and forcibly kept alive by the "did sealing it strand something" guard right
  up until the cupboard behind it goes solid — only then does the door have nothing left to
  serve and get taken on the next pass. Without this stage a door onto a bricked opening
  reads exactly like a door onto a wall — "this door just opens and nothing is here" — which
  is indistinguishable from a genuine bug to whoever is walking it.
- **`seal_blind_doorways`** removes whole doorway openings (never part of one — trimming
  cell-by-cell was tried and it narrowed *every* real door in the flat, because a door's own
  edge cells fail the same straight-line "floor on both sides" test as a truly blind
  opening) where no cell in the opening has floor on both sides along either axis. Caught: a
  1.27 m "doorway" that was actually a 1-cell-wide slot rasterized *inside* a wall block, and
  an opening onto the void outside the building envelope.
- **`fill_impassable_gaps`** fills any open cell whose tightest squeeze — the shorter of its
  horizontal and vertical unbroken open run — is narrower than the player, except doorway
  cells (a doorway is narrow along its crossing axis *by definition*, so the same test would
  brick every door in the flat). Catches rasterization rubble: a wall that thinned to a
  1-2 cell gap mid-run, a one-cell alcove, a dead-end nick — none of it is a space anyone can
  occupy, but all of it reads as mysterious slits in an otherwise solid wall.

Two guardrails worth knowing:
- **Low-resolution inputs are refused, on two independent measures.**
  `estimate_stroke_px()` measures wall thickness as the 75th percentile of horizontal ink
  run-lengths (the *mode* returns 2px on a photographed plan — JPEG fringing generates far
  more short runs than there are walls); below `MIN_WALL_STROKE_PX` walls can't be told from
  symbols. Separately, source width `< MIN_PLAN_WIDTH_PX` (1000px) is refused outright, even
  if the stroke estimate alone would have passed — a 723px shrink of a real plan measured
  6px walls (over `MIN_WALL_STROKE_PX`) and still converted into an apartment with **zero
  doorways**, because wall ink survives being shrunk but a door *gap* only has to close by a
  couple of pixels to stop reading as a gap at all. `--stroke` overrides the stroke estimate;
  there is no override for the width floor.
- **A level nobody can walk is refused, not warned about.** `place_spawn()`'s reachable
  fraction is checked against `MIN_REACHABLE_FRACTION` (0.9) at the very end of `convert()`
  and raises `ValueError` below it — this used to be a warning attached to a successful
  response, which is how the 723px case above shipped as "success" with 55% of the floor
  sealed off from spawn. Sealed into one room is not a walkthrough with a caveat.
- The convert summary prints the resulting **footprint in metres**. Architectural drawings
  are dimensioned in millimetres, and mistyping `--width-metres` silently rescales every
  room, doorway and ceiling.

`tools/test_convert.py`'s fixture is `blueprints/uploaded.jpg` — whatever was last uploaded
through the web panel. It's gitignored (may be a real private plan), which makes it
destructible: one low-res upload replaces the full-size plan every assertion is calibrated
against. `demo()` checks the fixture's width against `MIN_PLAN_WIDTH_PX` first and raises a
clear "re-upload the plan at full size" message instead of failing deep inside the
converter.

`<name>.overlay.png` (walls red, doorways blue, windows yellow, spawn green, over the
source image) is the tuning tool — look at it when a conversion looks wrong.

Grid text format (also validated by `BlueprintReader.java`):
- `0` floor · `1` wall · `2` spawn (exactly one) · `3` doorway · `4` window · `5` void
- `4` and `5` are both **solid to the player** but not ordinary wall: `4` renders as glass,
  `5` is the region outside the building and renders as *nothing at all*, so a window looks
  out onto sky instead of onto the sealed border a few centimetres away.
- Header comment lines (`# cellSize=... wallHeight=...`) are written by the converter and
  parsed back by `server.py`'s `/api/load-level`; hand-written grids without a header
  fall back to `cellSize=1.0, wallHeight=3.0`.

## Stage 2 — grid to level JSON (Java, Maven project `com.blueprint`)

Entry point [Main.java](src/main/java/com/blueprint/Main.java) — CLI args
`--blueprint --output --cellSize --wallHeight`, defaults to
`blueprints/level01.txt` → `web/level01.json`.

- [BlueprintReader.java](src/main/java/com/blueprint/BlueprintReader.java) — reads the
  text grid, validates rectangular shape and allowed characters.
- [LevelBuilder.java](src/main/java/com/blueprint/LevelBuilder.java) — the core
  transform. Coordinate mapping: `col -> x` unchanged, `row -> z` **flipped**
  (`z = (rows-1-row)*cellSize`, so row 0 in the file is the far edge in 3D). Merges
  adjacent `1` cells into maximal axis-aligned rectangles (greedy: extend right, then
  extend down) instead of one box per cell — a real floor plan has 1000+ wall cells, and
  one cube each means constant z-fighting. `3` cells get a second pass producing a
  *lintel* box spanning from `DOOR_HEIGHT` (2.0m) up to the ceiling, so a doorway renders
  as an actual doorframe. `4` cells produce **three** boxes — opaque spandrel below the
  sill, opaque header above, and a glass pane between, emitted into `LevelData.windows`
  so the renderer doesn't have to guess which walls are windows. `5` cells produce **no
  geometry at all**.
- **Angled walls**: a run of small stepped rectangles is recognised as a rasterised
  diagonal and replaced by one box with a `rotationY`, instead of a row of fins. The box is
  thinner than the staircase it replaces, so `openUncovered()` then rewrites the grid,
  flipping every staircase cell the box does not stand on back to `0`. **The grid is
  serialised after `buildWalls`, not before** — collision, the minimap and room
  segmentation all read that grid, and all three would otherwise place a wall where nothing
  is drawn. Cells on the outside face become an unreachable pocket, never a way out: the
  box spans the run unbroken. `checkSolidCellsAreDrawn()` in `main.js` warns if any solid
  cell ever loses its geometry again.
- [LevelExporter.java](src/main/java/com/blueprint/LevelExporter.java) — Gson
  pretty-printed JSON.
- `model/` — `LevelData` (name, width, height, cellSize, wallHeight, spawn, grid strings,
  walls), `WallData` (position, size, source row/col), `Vec3`.

`tools/build_level.py`'s `run_java()` is how everything actually invokes this (never
`mvn exec:java` — this project's own path contains spaces, which breaks exec-plugin's
whitespace-tokenized arg string). It compiles with Maven, builds a classpath, then calls
`java -cp ... com.blueprint.Main` directly with a real argv list.

## Stage 3 — rendering + gameplay (Three.js, `web/main.js`)

Single file, no bundler — loaded via an import map in `index.html` pointing at a CDN
build of Three.js r185. Fetches `web/level01.json` on load. Highlights:

- **Collision** is a grid lookup (`collides()`), not raycasting or physics — inverts the
  Java coordinate mapping back to row/col and tests every cell the player's square
  footprint overlaps (not just corners, which missed thin walls on fine grids). Uses a
  small epsilon to dodge floating-point edge cases at exact cell boundaries — this took
  multiple rounds of live-diagnosed "stuck" bugs to get right (see comments around
  `overlapRange`/`COLLISION_EPSILON`/`logStuckDiagnostic` in main.js). It blocks on `1`,
  `4` **and** `5` — anything checking walkability must know all three, or it will route
  the player straight out through a window.
- **Materials read as a finished vacant home**, not a colour-coded map: one oak floor
  (the old 14-hue per-room palette is gone), warm off-white walls, white trim lintels,
  a white ceiling, daylight sky. Rooms are still identified — the HUD label and minimap
  highlight both read `roomIdOf` — just not by painting each floor a different colour.
  The ceiling is **emissive**: a down-facing surface catches no sun and no sky term, and
  raising global ambient to compensate flattens every wall at once.
- **Doors** are visual-only and never affect collision — deliberately, so as not to
  duplicate the hard-won grid collision system with a second "is the player's box
  overlapping this swept door volume" system. Doorways are always walkable; the door
  leaf is a hinged mesh you aim at (screen-centre raycast, since pointer lock pins the
  cursor there) and click to toggle open/closed. Each door has a **lever handle** on both
  faces (a plain board didn't read as a door — indistinguishable from a wall behind it) and
  a per-door **swing limit** (`swingLimit()`/`leafClearAt()`): the leaf is sampled at build
  time, both swing directions, against the grid, and opens toward whichever side actually
  has room. A door boxed in on both sides ends up near 0° and effectively stays shut, which
  is honest — something really is in the way — rather than clipping through a wall at a
  fixed 90°.
- **Walls/floor** render as `InstancedMesh` grouped by material/color (one draw call per
  group), not one Mesh per cell — a real floor plan can have hundreds of wall pieces.
- **Rooms** (`computeRooms`): a watershed on wall clearance, not a flood fill. It measures
  each floor cell's Chebyshev distance to the nearest non-floor cell (doorways count as
  non-floor, so doored rooms separate for free), seeds a room at every blob with clearance
  above `ROOM_CORE_FRACTION` × the plan's deepest clearance, then lets those cores claim
  the remaining floor by simultaneous BFS. Spaces too narrow to seed anything (a 1.5 m
  bathroom, a balcony strip) become rooms in a leftover pass.

  This replaced a flood fill that assumed every room boundary was a wall with a door in
  it. **Open plans break that outright** — on the Unit C1 plan living + kitchen + dining +
  hall came out as one 330 m² region, so all of them reported `ROOM 01`. `roomIdOf` still
  returns the same ids to the same three callers (floor tiling, HUD label, minimap
  highlight); `rooms[id]` carries `{ name, short, area, anchor, parent }` alongside.
- **Sub-rooms**: a room is nested under its biggest neighbour when it is *both* under
  `SUBROOM_AREA_RATIO` of that neighbour **and** below the median room area. Both
  conditions are needed — in an open plan every bedroom's biggest neighbour is the huge
  living area, so the ratio alone demotes ordinary bedrooms. Named `ROOM 05a`, `ROOM 05b`.
- `ROOM_CORE_FRACTION` is a **fitted constant**, and every threshold in `computeRooms` is
  a ratio rather than a length, because the metre scale is the user's to type — the same
  plan entered as 16 m and as 32 m wide must segment identically. `checkRoomSegmentation()`
  warns if one region ever covers >75% of the floor again.
- **Room names from the drawing** are plumbed but not produced: `computeRooms` will use
  `data.roomLabels = [{ name, row, col }]` if the level JSON carries it, matching each
  label to whichever room contains its cell. Emitting that array needs OCR, which the
  converter deliberately does not do — no OCR dependency has been added, so rooms are
  auto-numbered by size. The matching is positional, so nothing in `main.js` would need
  to change if an OCR pass were added later.
- **Minimap**: baked once to an offscreen canvas from the grid text, blitted scaled-up
  each frame with player position/facing drawn on top; per-room highlight overlays are
  cached lazily per room. Room numbers are a **second** baked layer at the canvas' own
  resolution — the base map is one pixel per cell, far too coarse to draw text into.
- **Dust motes**: one `Points` cloud, positions wrapped modulo a box centered on the
  camera (no spawn/despawn bookkeeping).
- Conversion progress (upload panel) is honest about being indeterminate — `/api/convert`
  is a single blocking POST with no streaming, so it shows an elapsed clock and a looping
  stage indicator instead of a fake progress percentage.

## `server.py` (Flask dev server)

- `GET /`, `GET /<file>` — serves `web/` statically, `Cache-Control: no-store` always
  (this project's files change constantly across conversions; stale 304s were a real bug).
- `POST /api/convert` — accepts an uploaded image, validates `widthMetres` (rejects
  implausible values >200m with a hint about mm-vs-m mistakes), saves to
  `blueprints/uploaded.<ext>`, runs `blueprint_to_grid.convert()` then
  `build_level.run_java()`, returns wall count / reachable fraction / warning.
- `GET /api/levels` — lists saved `blueprints/*.txt` (excludes `uploaded.txt`, which every
  re-upload overwrites — save a hand-fixed grid under a different name to keep it).
- `POST /api/load-level` — rebuilds `web/level01.json` from an existing saved `.txt`
  without re-running the image converter.
- `POST /api/screenshot?name=…` — **dev only.** Saves a PNG the page rendered into
  `.preview/` (gitignored). Every other stage can be inspected from a terminal (the grid
  is text, the overlay a PNG, the level JSON), but the walkthrough exists only as pixels
  in a canvas, so without this, changing a material or a light is a blind edit. Pair it
  with the `window.__preview` hook at the bottom of `main.js`: `requestAnimationFrame` is
  suspended while a page is hidden, so an automated check has no frames to capture and
  must drive `renderer.render(...)` itself, then call `toDataURL()` on the very next
  statement (the drawing buffer isn't preserved).

## Deployment (in progress — Render)

GitHub Pages was considered and rejected: it's static-file-only and can't run the Python
converter or shell out to Maven/Java, both of which `POST /api/convert` needs at request
time. Decision made with the user: keep the full upload-and-convert app working, host it
somewhere that runs a real process (Render, chosen for its plain-Dockerfile support and
free tier with no CLI needed) rather than publish a Pages-only static demo.

Done so far: `server.py`'s entry point now binds `0.0.0.0` + `$PORT` (env, falling back to
8000 for local use) instead of `127.0.0.1:8000`, and passes `threaded=True` so a slow
`/api/convert` (it shells out to Maven) doesn't block ordinary static-file requests from
other tabs meanwhile. Render/Fly/Railway all inject `PORT`; a loopback-only bind would have
refused every request from their proxy.

**Not yet done — pick this up next:**
- A `Dockerfile` at repo root: needs a JDK 17 + Maven base (`run_java()` shells out to
  `mvn compile` / `mvn dependency:build-classpath` at *request* time, not a prebuilt jar —
  see `tools/build_level.py`) plus Python 3 on top for `blueprint_to_grid.py`. Plan was
  `FROM maven:3.9-eclipse-temurin-17`, `apt-get install python3 python3-venv` (a venv sidesteps
  Debian's PEP 668 externally-managed-environment pip restriction), `pip install -r
  requirements.txt`, warm the Maven dependency cache in its own layer (`mvn dependency:
  go-offline` + `mvn compile`) before `COPY . .` so an unrelated source edit doesn't force
  Maven back online on every rebuild.
- A `.dockerignore` excluding `.git`, `.idea`, `target/`, `__pycache__`, `.preview/`,
  `blueprints/uploaded.*`, `blueprints/*.overlay.png`, `web/level01.json` — mirrors
  `.gitignore`, and matters more here since a private uploaded plan must never end up
  baked into an image.
- No Docker locally to test-build against (`docker --version` fails — not installed on this
  machine and the user chose not to install it preemptively). First real build will happen
  on Render during deploy; debug from Render's build logs, or install Docker then if it's
  needed for faster iteration.
- Known caveat to flag to the user once live: Render's free tier has an ephemeral
  filesystem (uploads and any hand-saved `blueprints/*.txt` don't survive a redeploy/restart)
  and spins down after ~15 min idle (first request after that is slow — cold start pays for
  Maven's classpath resolution too).
- GitHub Pages itself is out of scope per the decision above — if a landing page is wanted
  later it would link out to the Render URL, not host the app.

## Key files

| File | Role |
|---|---|
| [server.py](server.py) | Flask dev server + `/api/*` endpoints |
| [tools/blueprint_to_grid.py](tools/blueprint_to_grid.py) | image → text grid |
| [tools/build_level.py](tools/build_level.py) | CLI: runs both pipeline stages, finds Maven |
| [tools/test_convert.py](tools/test_convert.py) | self-check against `blueprints/uploaded.jpg` |
| [tools/make_sample_blueprint.py](tools/make_sample_blueprint.py) | generates a synthetic test blueprint |
| [src/main/java/com/blueprint/Main.java](src/main/java/com/blueprint/Main.java) | Java CLI entry point |
| [src/main/java/com/blueprint/LevelBuilder.java](src/main/java/com/blueprint/LevelBuilder.java) | grid → level geometry (the coordinate mapping lives here) |
| [web/main.js](web/main.js) | everything client-side: render, movement, collision, doors, HUD, minimap |
| [web/index.html](web/index.html) | page shell, upload form, HUD markup |
| [pom.xml](pom.xml) | Maven config — Java 17, only dependency is Gson |
| [requirements.txt](requirements.txt) | Python deps: pillow, numpy, pypdfium2, flask |
| [.claude/launch.json](.claude/launch.json) | preview config: `py server.py` on port 8000 |

## Non-obvious things worth knowing before touching this

- **Never make doors solid.** It's a deliberate simplification — see "Doors" above. Fix
  walkability bugs in `collides()`/the grid, not by giving doors their own collision.
- **Don't rebuild the envelope from the opened ink.** It is tempting, and it fails: the
  opened mask deliberately severs the wall network at every door and window, so the
  largest connected blob is one wall fragment rather than the building. Measured on the
  Unit C1 plan that cropped a landscape plan to a tall strip and produced a 95%-solid
  grid; a later attempt flooded 75% of the grid as "outside" with no interior floor at
  all. Raw ink builds the envelope; opened ink only classifies.
- **`keep_largest_wall_component` is unsafe on a mask with openings cut into it** — it
  will happily delete a partition that its own doorway just disconnected. It runs before
  openings are applied, and must stay there.
- **The row→z flip is load-bearing** and appears identically in `LevelBuilder.java` and
  every coordinate-inverting function in `main.js` (`cellAt`, `playerCell`, `collides`,
  door hinge placement). If you change one, change all of them together.
- **`cellSize` is derived from real-world building width ÷ grid columns**, not a fixed
  constant — a fine grid (small `cellSize`) shrinks `PLAYER_RADIUS` and door width
  calculations proportionally so doorways stay passable regardless of resolution.
- **The accepted file types are stated in three places that must stay in step**:
  `ALLOWED_SUFFIXES` in `server.py`, the `accept` attribute + hint text on the upload panel
  in `web/index.html`, and the module docstring at the top of `blueprint_to_grid.py`. All
  three list the same thing (`.png/.jpg/.jpeg/.pdf`, top-down only, `~1000px` minimum, PDFs
  read from page 1 at 200dpi) so the panel's copy and the server's actual 400 never disagree.
- Most of the gnarlier logic (collision epsilon, doorway-jog absorption, wall-tip
  pruning) exists because of specific bugs found by walking real converted floor plans —
  the comments at each site explain the failure mode that motivated it. Read the comment
  before "simplifying" the code near it.
