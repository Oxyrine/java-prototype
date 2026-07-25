"""
Local dev server: serves web/ as static files AND provides POST /api/convert,
which accepts an uploaded blueprint image from the browser's upload menu, runs
it through the same blueprint_to_grid + Java pipeline as tools/build_level.py,
and reports back success/failure so the page can reload the new level.

Replaces `py -m http.server` as the launch command -- see .claude/launch.json.
Run from anywhere; it chdirs to the project root itself so the conversion
tools' relative paths (blueprints/, web/) are always correct.
"""
import os
import re
import sys
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

PROJECT_ROOT = Path(__file__).parent.resolve()
WEB_DIR = PROJECT_ROOT / "web"
BLUEPRINTS_DIR = PROJECT_ROOT / "blueprints"

os.chdir(PROJECT_ROOT)
sys.path.insert(0, str(PROJECT_ROOT / "tools"))
import blueprint_to_grid  # noqa: E402
import build_level  # noqa: E402  (reuses run_java, which knows how to find Maven)

app = Flask(__name__, static_folder=None)

ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf"}


@app.after_request
def disable_caching(response):
    # This is a local dev server whose files (especially level01.json, rewritten by every
    # upload) change constantly. Browsers share their HTTP cache across tabs and can honor a
    # stale 304 based on a file's Last-Modified/ETag even seconds after it changed --
    # actively wrong for this project. Just never cache, full stop.
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(WEB_DIR, filename)


@app.route("/api/convert", methods=["POST"])
def convert():
    if "image" not in request.files:
        return jsonify(success=False, error="No image file in the upload."), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify(success=False, error="No file selected."), 400

    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        return jsonify(success=False,
                        error=f"Unsupported file type '{suffix}'. Use PNG, JPG, or PDF."), 400

    try:
        width_metres = float(request.form.get("widthMetres", 12.0))
        if width_metres <= 0:
            raise ValueError
    except ValueError:
        return jsonify(success=False, error="Building width must be a positive number."), 400

    # Architectural drawings are dimensioned in millimetres, so it is very easy to read
    # "12123" off the plan and type it into a field labelled metres -- which silently
    # builds a 12 km world (every metre-based constant in main.js, fog/eye height/move
    # speed, is then meaningless). No single-floor dwelling is 200 m across, so reject
    # rather than auto-divide: an explicit error teaches the units, an auto-divide would
    # be wrong on a genuinely large building.
    if width_metres > 200:
        message = f"Building width {width_metres:g} m is implausible for a floor plan."
        # Only suggest the millimetre reading when it actually lands on a plausible
        # building; at, say, 201 "enter 0.201 instead" would be worse than no advice.
        if width_metres >= 1000:
            message += (" Architectural drawings are dimensioned in millimetres -- if you "
                        f"read this off the drawing, enter {width_metres / 1000:g} instead.")
        else:
            message += " Enter the width in metres (a house is typically 8-20)."
        return jsonify(success=False, error=message), 400

    BLUEPRINTS_DIR.mkdir(parents=True, exist_ok=True)
    upload_path = BLUEPRINTS_DIR / f"uploaded{suffix}"
    file.save(upload_path)

    try:
        out_txt, cell_size, wall_height, reachable_fraction, wall_count = blueprint_to_grid.convert(
            image_path=upload_path, out_name="uploaded", cols=None, fill=0.12,
            width_metres=width_metres, wall_height=2.5, dpi=200, invert=False,
            min_region=6, do_seal=True, keep_largest_only=True)
    except Exception as e:
        return jsonify(success=False, error=f"Image conversion failed: {e}"), 400

    output_json = WEB_DIR / "level01.json"
    try:
        build_level.run_java(out_txt, output_json, cell_size, wall_height)
    except SystemExit as e:
        return jsonify(success=False, error=f"Level build failed: {e}"), 500

    warning = None
    if reachable_fraction < 0.999:
        warning = (f"Only {reachable_fraction * 100:.0f}% of the interior floor is reachable from "
                    "spawn -- a room is still isolated even after automatic doorway carving. Check "
                    f"blueprints/uploaded.overlay.png to see exactly which walls were detected.")

    return jsonify(success=True, wallCount=wall_count,
                    reachableFraction=round(reachable_fraction, 3), warning=warning)


# "uploaded.txt" is excluded from the picker below on purpose: every re-upload of the same
# image through /api/convert overwrites it silently, so a hand-edited fix saved under a
# different name (e.g. apartment_demo.txt) is the only way to keep a corrected grid around --
# this endpoint pair is exactly what lets you get back to that saved fix with one click instead
# of re-running the CLI, which is what kept happening here.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


@app.route("/api/levels")
def list_levels():
    names = sorted(
        p.stem for p in BLUEPRINTS_DIR.glob("*.txt")
        if p.stem != "uploaded" and NAME_PATTERN.match(p.stem)
    )
    return jsonify(levels=names)


@app.route("/api/load-level", methods=["POST"])
def load_level():
    name = (request.get_json(silent=True) or {}).get("name", "")
    if not NAME_PATTERN.match(name):
        return jsonify(success=False, error="Invalid level name."), 400

    grid_path = BLUEPRINTS_DIR / f"{name}.txt"
    if not grid_path.is_file():
        return jsonify(success=False, error=f"No saved level named '{name}'."), 404

    header = grid_path.read_text(encoding="utf-8").splitlines()[:3]
    cell_size = wall_height = None
    for line in header:
        m = re.search(r"cellSize=([\d.]+)", line)
        if m:
            cell_size = float(m.group(1))
        m = re.search(r"wallHeight=([\d.]+)", line)
        if m:
            wall_height = float(m.group(1))

    if cell_size is None or wall_height is None:
        # Hand-written grids (e.g. level01.txt, house.txt from build_level.py's CLI runs
        # before this endpoint existed) may not carry the header this endpoint parses --
        # 1.0/3.0 match Phase 1's original constants, a reasonable default rather than a guess.
        cell_size = cell_size if cell_size is not None else 1.0
        wall_height = wall_height if wall_height is not None else 3.0

    output_json = WEB_DIR / "level01.json"
    try:
        build_level.run_java(grid_path, output_json, cell_size, wall_height)
    except SystemExit as e:
        return jsonify(success=False, error=f"Level build failed: {e}"), 500

    return jsonify(success=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=False)
