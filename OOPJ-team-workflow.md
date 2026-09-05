# Workflow — 2D Blueprint to 3D Model conversion (OOPJ project)

For the actual group repo: https://github.com/310625104052-tech/OOPJ-Project---2D-Blueprint-to-3D-Model-conversion

## What's actually in the repo right now

One commit, five real files, no Java yet despite the project name:

| File | What it is |
|---|---|
| `Data Extraction and Multileaders Sample Coordinates.xlsx` / `.csv` | A table of extracted CAD annotation ("multileader") data: `Position X/Y/Z`, `Scale X/Y/Z`, one row per element on the blueprint |
| `Displaying data in Position, Scale.py` | Loads the Excel, prints the Position/Scale columns, re-saves as CSV |
| `Scatterplot of X,Y,Z coordinates.py` | Plots the Position columns as a 3D matplotlib scatter (Z is 0 for everything — it's a flat 2D plan) |
| `3DmodelTrial.blend` | A Blender scene — looks like a manual, by-hand placement trial, not generated from the CSV by any script in the repo |

So the pipeline that exists **in evidence**, with the gap that matters most called out:

```
2D CAD blueprint (multileader-annotated)
      |  extraction (currently manual/ad hoc -> the sample CSV)
      v
Position X/Y/Z + Scale X/Y/Z table            <-- NO element type/category column.
      |                                            Nothing downstream can tell a wall
      |  <MISSING: an OOP model layer>             from a chair from these rows alone.
      v                                            This is the first thing to fix.
typed blueprint elements (walls, doors, furniture, ...)
      |  <MISSING: automated 3D generation>
      v
3D model (currently: 3DmodelTrial.blend, built by hand)
```

Two real gaps, and they're exactly the seams to split the work on:
1. **The extracted data has no type column.** `Position X/Y/Z, Scale X/Y/Z` alone can't
   distinguish a wall from a door from a piece of furniture. Whoever owns extraction needs
   to add this before anyone can build real OOP classes on top of it.
2. **Nothing turns the table into a 3D model automatically.** The `.blend` file is a
   manual proof that *a* result is plausible, not a pipeline. That's the whole point of
   the OOP layer in the middle and the generation step after it.

## The 3 lanes

### Lane 1 — Data extraction (2D blueprint → typed coordinate table)

**Owns:** the extraction script(s), `Data Extraction and Multileaders Sample Coordinates.*`

**Job:** turn a real 2D CAD blueprint (DWG/DXF) into a table with one row per element —
not just position/scale, but **what the element is**. The current sample has no such
column; this is the first thing to add. A hand-typed Excel sheet doesn't scale past one
sample drawing, so this lane's real deliverable is an actual extraction script (e.g. a DXF
library such as `ezdxf` in Python, or a CAD-side export script) that reads a blueprint file
and emits the table — not more manual transcription.

**Produces (the contract Lane 2 depends on):** a CSV/JSON with, at minimum:
`type, Position X, Position Y, Position Z, Scale X, Scale Y, Scale Z` — and probably
`Rotation` too, since nothing in the current sample captures orientation and most real
floor plans have non-axis-aligned walls. **Nail down the exact column names, units (the
sample numbers look like millimetres, e.g. `33607.32`), and the full set of `type` values
as a team decision before Lane 2 writes a parser against it** — that decision is the actual
interface between these two lanes, treat it like an API contract.

### Lane 2 — Java OOP model (the actual "Java" in OOPJ)

**Owns:** a new Java (Maven/Gradle) project — none exists yet.

**Job:** the class hierarchy the whole project is graded on. Something like an abstract
`BlueprintElement` (position, scale, rotation) with subclasses (`Wall`, `Door`, `Window`,
`Furniture`, ...) driven by Lane 1's `type` column, a reader that parses Lane 1's CSV/JSON
into a `List<BlueprintElement>`, and any validation/geometry logic worth doing in Java
(units conversion, snapping, bounding-box checks). Exports the resulting object graph to a
JSON file — the artifact Lane 3 actually renders.

**Dependency on Lane 1: the *schema*, not the code.** Lane 1's extractor doesn't need to be
finished or even running for Lane 2 to work — the existing sample CSV, plus an agreed `type`
column, is enough to develop and test the whole Java side against.

### Lane 3 — 3D generation

**Owns:** turning Lane 2's exported JSON into an actual 3D scene, automatically —
replacing the manual `3DmodelTrial.blend` with something a script produces. Two real
options, and this is a decision the three of you should make explicitly rather than default
into:
- **Blender Python (`bpy`) script** reading Lane 2's JSON and placing/scaling real objects
  per element type. Keeps the existing `.blend` file relevant, but needs Blender installed
  to run/demo.
- **A lightweight 3D web viewer** (e.g. Three.js) reading the same JSON — no Blender needed
  to view or demo, easier to show on any machine, but is a second codebase to write instead
  of scripting an existing tool.

Also owns `Scatterplot of X,Y,Z coordinates.py` as a cheap sanity-check tool during
development (does this row's position look right at all) — keep it, it costs nothing.

**Dependency on Lane 2: the JSON export schema, not the Java code running.** Once Lane 2
publishes even a first-draft version of that schema (can be from hardcoded test data before
the CSV parser is done), Lane 3 can build against a fixture file in that shape without
waiting on Lane 2's actual implementation to finish.

## Staying independent day-to-day

1. **Two schemas, two contracts — write them down before writing code against them:**
   Lane 1 → Lane 2 (the coordinate table's columns/units/type values) and Lane 2 → Lane 3
   (the exported JSON model). Right now *neither exists yet*, unlike a project further
   along — so the very first task, before any lane goes off alone, is a short joint session
   nailing both down. After that, changes to either get announced, not discovered.
2. **Commit a fixture the moment a schema is agreed**, even before the real
   extractor/parser is finished — a sample CSV with a `type` column, then a sample export
   JSON. That's what lets Lane 2 and Lane 3 start immediately instead of waiting on each
   other's implementation, the same way the existing sample CSV already lets Lane 2 start
   today.
3. **File ownership stays clean by construction**: Lane 1 touches extraction scripts and
   sample data, Lane 2 touches the new Java project, Lane 3 touches the generation
   script(s) — no shared files to conflict over once the two schemas above are settled.
4. **Integration checkpoint**: periodically run the whole chain — a real (or sample)
   blueprint through Lane 1 → Lane 2 → Lane 3 → an actual 3D result — before assuming
   things still fit together. Each lane can look individually done against its own fixture
   and still be silently broken against what the others actually shipped.
5. **Commit under your own GitHub identity**, not a shared account, so individual
   contribution is visible for grading.
