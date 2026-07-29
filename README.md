# Blueprint Explorer

Upload a 2D floor plan (PNG, JPG, or PDF) and walk through it in 3D, first-person, right in
your browser. No CAD file, no manual modeling — just a photo or scan of the plan.

## What it does

- Reads an ordinary floor plan image and automatically detects walls, doors, windows, and rooms.
- Builds a full 3D model from that layout — walls, doorframes, glazed windows, floor, ceiling.
- Opens the result as a live, walkable space: WASD to move, mouse to look, click a door to open it.
- Labels rooms on a minimap (kitchen, bedroom, etc. when the plan names them; numbered otherwise).
- Lets you correct the building's real-world width and rebuild instantly if the scale looks off.

## Quick start

```
py -m pip install -r requirements.txt
py server.py
```

Then open http://localhost:8000, upload a floor plan in the side panel, and walk in.

Needs a JDK 17 + Maven on `PATH` (the Java side compiles the grid into level geometry).

## Other ways to run it

CLI, no browser:
```
py tools/build_level.py blueprints/my_house.png --width-metres 10.5
```

Self-check that the pipeline still works end to end:
```
py tools/test_convert.py
```

## How it works, in short

```
floor plan image
      |  Python: detects walls/doors/windows, writes a text grid
      v
text grid (1 wall / 0 floor / 3 doorway / 4 window / ...)
      |  Java: turns the grid into 3D wall/door/window geometry
      v
level JSON
      |  Three.js: renders it and lets you walk around
      v
browser
```

For the full pipeline internals — why walls and symbols are told apart by stroke thickness,
how rooms are segmented, collision, minimap labeling, and the non-obvious bugs each piece
fixes — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Tech stack

- **Python** (Pillow, NumPy, pypdfium2, Flask) — image processing and the dev server
- **Java 17 / Maven** (Gson) — grid → level geometry
- **Three.js** (r185, via CDN) — rendering and the walkthrough, no bundler

## Project layout

| Path | What's there |
|---|---|
| `server.py` | Flask dev server: serves the page, runs the upload → convert → build pipeline |
| `tools/blueprint_to_grid.py` | Image → text grid (the image-processing stage) |
| `tools/build_level.py` | CLI entry point; also finds/invokes Maven |
| `src/main/java/com/blueprint/` | Grid → 3D level geometry (Java) |
| `web/` | The browser app (`index.html`, `main.js`, `style.css`) |
| `blueprints/` | Sample and saved floor plans (text grids + source images) |
