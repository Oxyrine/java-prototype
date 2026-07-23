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

    BLUEPRINTS_DIR.mkdir(parents=True, exist_ok=True)
    upload_path = BLUEPRINTS_DIR / f"uploaded{suffix}"
    file.save(upload_path)

    try:
        out_txt, cell_size, wall_height = blueprint_to_grid.convert(
            image_path=upload_path, out_name="uploaded", cols=96, fill=0.12,
            width_metres=width_metres, wall_height=2.5, dpi=200, invert=False,
            do_close=True, min_region=6, do_seal=True, keep_largest_only=True)
    except Exception as e:
        return jsonify(success=False, error=f"Image conversion failed: {e}"), 400

    output_json = WEB_DIR / "level01.json"
    try:
        build_level.run_java(out_txt, output_json, cell_size, wall_height)
    except SystemExit as e:
        return jsonify(success=False, error=f"Level build failed: {e}"), 500

    return jsonify(success=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=False)
