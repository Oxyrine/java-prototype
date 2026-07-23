"""
Converts an architectural floor-plan image (PNG/JPG/PDF) into the same 1/0/2 text grid
format that BlueprintReader.java already reads. See the plan for the full pipeline
rationale; summary of stages:

  load -> grayscale -> Otsu binarize -> auto-crop to ink -> downsample to grid by
  ink-FRACTION per cell -> morphological close (seals double-line walls) ->
  remove small blobs (kills label text / dimension noise) -> seal border ->
  auto-place spawn (largest floor region, cell furthest from any wall) ->
  write <name>.txt + <name>.overlay.png

The overlay PNG (walls tinted red, spawn marked green) is the main tuning tool:
run this, look at the overlay, adjust --fill, re-run.
"""
import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


# ---------------------------------------------------------------------------
# Stage 1: load
# ---------------------------------------------------------------------------

def load_image(path: Path, dpi: int) -> Image.Image:
    if path.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(str(path))
        page = pdf.get_page(0)
        scale = dpi / 72.0  # PDF units are 1/72 inch
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        page.close()
        pdf.close()
        return pil_image.convert("RGB")
    return Image.open(path).convert("RGB")


# ---------------------------------------------------------------------------
# Stage 2: grayscale + Otsu binarize
# ---------------------------------------------------------------------------

def otsu_threshold(gray: np.ndarray) -> int:
    """Textbook Otsu's method: pick the threshold maximizing between-class variance."""
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size
    sum_total = float(np.dot(np.arange(256), hist))

    sum_b = 0.0
    weight_b = 0.0
    best_variance = -1.0
    best_threshold = 128

    for t in range(256):
        weight_b += hist[t]
        if weight_b == 0:
            continue
        weight_f = total - weight_b
        if weight_f == 0:
            break
        sum_b += t * hist[t]
        mean_b = sum_b / weight_b
        mean_f = (sum_total - sum_b) / weight_f
        variance_between = weight_b * weight_f * (mean_b - mean_f) ** 2
        if variance_between > best_variance:
            best_variance = variance_between
            best_threshold = t

    return best_threshold


def binarize(img: Image.Image, invert: bool) -> np.ndarray:
    """Returns a boolean array, True = ink (wall/text/line), same shape as the image."""
    gray = np.array(img.convert("L"), dtype=np.uint8)
    if invert:
        gray = 255 - gray
    threshold = otsu_threshold(gray)
    return gray < threshold


# ---------------------------------------------------------------------------
# Stage 3: auto-crop to the LARGEST CONNECTED ink component's bounding box.
#
# Cropping to the bbox of *all* ink is wrong: a dimension line + measurement
# text sitting below the building is disconnected from it by a real gap of
# white space, but is still "ink somewhere in the image" and would stretch the
# crop (and therefore the whole grid) down to include it. The building itself
# is one connected blob (the exterior wall touches every interior wall), so
# finding the largest connected component and cropping to its bbox correctly
# keeps the building and drops disconnected annotations outside it.
# ---------------------------------------------------------------------------

def find_main_component_bbox(ink: np.ndarray, preview_cols: int = 150):
    """Cheap low-res pass (reusing downsample_to_grid) just to locate the
    largest connected ink blob, then maps its bbox back to pixel coordinates."""
    preview, row_edges, col_edges = downsample_to_grid(ink, preview_cols, fill_threshold=0.02)
    labels, sizes = connected_components(preview, connectivity=8)
    if not sizes:
        raise ValueError(
            "No ink detected at all -- the image came out entirely blank after "
            "binarizing. Check --invert (maybe the plan is light lines on a dark "
            "background) or verify the input file isn't corrupt/blank.")

    largest_label = int(np.argmax(sizes))
    rs, cs = np.where(labels == largest_label)
    r0, r1 = int(rs.min()), int(rs.max()) + 1
    c0, c1 = int(cs.min()), int(cs.max()) + 1
    return int(row_edges[r0]), int(row_edges[r1]), int(col_edges[c0]), int(col_edges[c1])


def autocrop(ink: np.ndarray, img: Image.Image, pad: int = 15):
    y0, y1, x0, x1 = find_main_component_bbox(ink)

    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(ink.shape[1], x1 + pad)
    y1 = min(ink.shape[0], y1 + pad)

    ink_cropped = ink[y0:y1, x0:x1]
    img_cropped = img.crop((x0, y0, x1, y1))
    return ink_cropped, img_cropped


# ---------------------------------------------------------------------------
# Stage 4: downsample to grid by ink FRACTION per cell (not average brightness --
# a thin black wall line in a mostly-white cell has a bright average and would
# vanish under a brightness test)
# ---------------------------------------------------------------------------

def downsample_to_grid(ink_cropped: np.ndarray, cols: int, fill_threshold: float):
    height, width = ink_cropped.shape
    rows = max(1, round(cols * height / width))

    col_edges = np.linspace(0, width, cols + 1).round().astype(int)
    row_edges = np.linspace(0, height, rows + 1).round().astype(int)

    wall = np.zeros((rows, cols), dtype=bool)
    for r in range(rows):
        r0, r1 = row_edges[r], row_edges[r + 1]
        for c in range(cols):
            c0, c1 = col_edges[c], col_edges[c + 1]
            cell = ink_cropped[r0:r1, c0:c1]
            if cell.size == 0:
                continue
            wall[r, c] = cell.mean() >= fill_threshold

    return wall, row_edges, col_edges


# ---------------------------------------------------------------------------
# Stage 5: morphological close (dilate then erode, 8-connected 3x3) -- seals the
# hollow center between the two parallel lines real plans draw walls as
# ---------------------------------------------------------------------------

def dilate(mask: np.ndarray) -> np.ndarray:
    rows, cols = mask.shape
    padded = np.pad(mask, 1, mode="constant", constant_values=False)
    out = np.zeros_like(mask)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out |= padded[1 + dy:1 + dy + rows, 1 + dx:1 + dx + cols]
    return out


def erode(mask: np.ndarray) -> np.ndarray:
    # Erosion is the dual of dilation: erode(A) = ~dilate(~A) for a symmetric structuring element.
    return ~dilate(~mask)


def morphological_close(mask: np.ndarray) -> np.ndarray:
    return erode(dilate(mask))


# ---------------------------------------------------------------------------
# Connected components (shared by blob removal and spawn placement)
# ---------------------------------------------------------------------------

_NEIGHBORS_8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
_NEIGHBORS_4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def connected_components(mask: np.ndarray, connectivity: int = 8):
    """Labels connected True regions. Returns (labels array, list of sizes by label id)."""
    rows, cols = mask.shape
    neighbors = _NEIGHBORS_8 if connectivity == 8 else _NEIGHBORS_4
    labels = np.full((rows, cols), -1, dtype=int)
    sizes = []
    next_label = 0

    for r in range(rows):
        for c in range(cols):
            if not mask[r, c] or labels[r, c] != -1:
                continue
            queue = deque([(r, c)])
            labels[r, c] = next_label
            size = 0
            while queue:
                cr, cc = queue.popleft()
                size += 1
                for dr, dc in neighbors:
                    nr, nc = cr + dr, cc + dc
                    if 0 <= nr < rows and 0 <= nc < cols and mask[nr, nc] and labels[nr, nc] == -1:
                        labels[nr, nc] = next_label
                        queue.append((nr, nc))
            sizes.append(size)
            next_label += 1

    return labels, sizes


# ---------------------------------------------------------------------------
# Stage 6: remove small wall blobs -- kills room-label text and dimension numbers
# ---------------------------------------------------------------------------

def remove_small_blobs(wall_mask: np.ndarray, min_region: int) -> np.ndarray:
    labels, sizes = connected_components(wall_mask, connectivity=8)
    keep = wall_mask.copy()
    for label_id, size in enumerate(sizes):
        if size < min_region:
            keep[labels == label_id] = False
    return keep


# ---------------------------------------------------------------------------
# Stage 6b: keep only the largest connected wall component.
#
# min_region alone isn't enough: once a whole word like "BEDROOM" is downsampled
# to grid resolution, its letters merge into ONE connected blob well above any
# reasonable min_region -- it's not small, it's just not a wall. The reliable
# distinguishing feature is structural: real architectural walls form a single
# connected network (every interior partition touches the exterior wall or
# another partition), while room labels and furniture icons are drawn floating,
# not touching anything. So the exterior+interior wall system is essentially
# always the single largest connected wall blob; keep only that one.
#
# This must run BEFORE seal_border (which would make everything touch the
# border and defeat the point) and can be disabled with --keep-all-components
# for buildings with genuinely disconnected wall structures (e.g. a detached
# garage) -- at the cost of any text/furniture noise coming back.
# ---------------------------------------------------------------------------

def keep_largest_wall_component(wall_mask: np.ndarray) -> np.ndarray:
    labels, sizes = connected_components(wall_mask, connectivity=8)
    if not sizes:
        return wall_mask
    largest_label = int(np.argmax(sizes))
    return labels == largest_label


# ---------------------------------------------------------------------------
# Stage 7: seal the border so the player can't walk out into the void
# ---------------------------------------------------------------------------

def seal_border(mask: np.ndarray) -> np.ndarray:
    sealed = mask.copy()
    sealed[0, :] = True
    sealed[-1, :] = True
    sealed[:, 0] = True
    sealed[:, -1] = True
    return sealed


# ---------------------------------------------------------------------------
# Stage 8: auto-place spawn -- largest connected floor region, cell furthest
# from any wall (multi-source BFS distance transform)
# ---------------------------------------------------------------------------

def distance_from_walls(wall_mask: np.ndarray) -> np.ndarray:
    rows, cols = wall_mask.shape
    dist = np.full((rows, cols), -1, dtype=int)
    queue = deque()

    wall_rs, wall_cs = np.where(wall_mask)
    for r, c in zip(wall_rs, wall_cs):
        dist[r, c] = 0
        queue.append((r, c))

    while queue:
        r, c = queue.popleft()
        for dr, dc in _NEIGHBORS_4:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and dist[nr, nc] == -1:
                dist[nr, nc] = dist[r, c] + 1
                queue.append((nr, nc))

    return dist


def place_spawn(wall_mask: np.ndarray):
    """Returns ((spawn_row, spawn_col), reachable_fraction)."""
    floor_mask = ~wall_mask
    labels, sizes = connected_components(floor_mask, connectivity=4)

    if not sizes:
        raise ValueError(
            "No floor cells at all -- the entire grid came out solid. The image is "
            "probably too dark/noisy for the current --fill threshold; try raising "
            "--fill or check --invert.")

    largest_label = int(np.argmax(sizes))
    largest_size = sizes[largest_label]
    total_floor = int(floor_mask.sum())

    dist = distance_from_walls(wall_mask)
    candidate_mask = labels == largest_label
    dist_masked = np.where(candidate_mask, dist, -1)
    spawn_rc = np.unravel_index(np.argmax(dist_masked), dist_masked.shape)

    reachable_fraction = largest_size / total_floor
    return (int(spawn_rc[0]), int(spawn_rc[1])), reachable_fraction


# ---------------------------------------------------------------------------
# Stage 9: write grid text + overlay PNG
# ---------------------------------------------------------------------------

def write_grid(wall_mask: np.ndarray, spawn_rc, out_path: Path, header_lines):
    rows, cols = wall_mask.shape
    lines = list(header_lines)
    for r in range(rows):
        chars = []
        for c in range(cols):
            if (r, c) == spawn_rc:
                chars.append("2")
            elif wall_mask[r, c]:
                chars.append("1")
            else:
                chars.append("0")
        lines.append("".join(chars))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_overlay(wall_mask: np.ndarray, spawn_rc, cropped_img: Image.Image,
                   row_edges: np.ndarray, col_edges: np.ndarray, out_path: Path):
    rows, cols = wall_mask.shape
    base = cropped_img.convert("RGBA")
    tint = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(tint)

    for r in range(rows):
        for c in range(cols):
            if wall_mask[r, c]:
                draw.rectangle(
                    [col_edges[c], row_edges[r], col_edges[c + 1] - 1, row_edges[r + 1] - 1],
                    fill=(255, 0, 0, 110))

    sr, sc = spawn_rc
    cx = (col_edges[sc] + col_edges[sc + 1]) // 2
    cy = (row_edges[sr] + row_edges[sr + 1]) // 2
    radius = max(4, (col_edges[sc + 1] - col_edges[sc]) // 2)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(0, 200, 0, 220))

    composed = Image.alpha_composite(base, tint).convert("RGB")
    composed.save(out_path)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def convert(image_path: Path, out_name: str, cols: int, fill: float, width_metres: float,
            wall_height: float, dpi: int, invert: bool, do_close: bool, min_region: int,
            do_seal: bool, keep_largest_only: bool):
    img = load_image(image_path, dpi)
    ink = binarize(img, invert)
    ink_cropped, img_cropped = autocrop(ink, img)

    wall_mask, row_edges, col_edges = downsample_to_grid(ink_cropped, cols, fill)
    rows_actual, cols_actual = wall_mask.shape

    if do_close:
        wall_mask = morphological_close(wall_mask)

    wall_mask = remove_small_blobs(wall_mask, min_region)

    if keep_largest_only:
        wall_mask = keep_largest_wall_component(wall_mask)

    if do_seal:
        wall_mask = seal_border(wall_mask)

    spawn_rc, reachable_fraction = place_spawn(wall_mask)
    cell_size = width_metres / cols_actual

    blueprints_dir = Path("blueprints")
    out_txt = blueprints_dir / f"{out_name}.txt"
    out_overlay = blueprints_dir / f"{out_name}.overlay.png"

    header = [
        f"# generated by blueprint_to_grid.py from {image_path.name}",
        f"# cols={cols_actual} rows={rows_actual} fill={fill} cellSize={cell_size:.4f} wallHeight={wall_height}",
    ]
    write_grid(wall_mask, spawn_rc, out_txt, header)
    write_overlay(wall_mask, spawn_rc, img_cropped, row_edges, col_edges, out_overlay)

    wall_count = int(wall_mask.sum())
    print(f"Grid: {cols_actual}x{rows_actual}  walls={wall_count}  spawn=row{spawn_rc[0]},col{spawn_rc[1]}")
    print(f"cellSize = {width_metres} / {cols_actual} = {cell_size:.4f} m/cell")
    print(f"Reachable floor from spawn: {reachable_fraction * 100:.1f}%")
    if reachable_fraction < 0.8:
        print("WARNING: less than 80% of floor is reachable from the spawn point -- "
              "a doorway may have been sealed by --fill or the morphological close. "
              f"Check {out_overlay}")
    print(f"Wrote {out_txt}")
    print(f"Wrote {out_overlay}  (walls tinted red, spawn marked green -- inspect this)")

    return out_txt, cell_size, wall_height, reachable_fraction, wall_count


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="Input blueprint image (PNG/JPG/PDF)")
    parser.add_argument("--out", default="house", help="Output base name (default: house)")
    parser.add_argument("--cols", type=int, default=96, help="Grid columns (default: 96)")
    parser.add_argument("--fill", type=float, default=0.12,
                         help="Ink-fraction threshold per cell to count as a wall (default: 0.12)")
    parser.add_argument("--width-metres", type=float, default=12.0,
                         help="Real-world building width in metres (default: 12.0)")
    parser.add_argument("--wall-height", type=float, default=2.5,
                         help="Wall height in metres, passed through for Java (default: 2.5)")
    parser.add_argument("--dpi", type=int, default=200, help="PDF render DPI (default: 200)")
    parser.add_argument("--invert", action="store_true",
                         help="Set if the plan is light lines on a dark background")
    parser.add_argument("--no-close", dest="do_close", action="store_false",
                         help="Disable morphological closing of double-line walls")
    parser.add_argument("--min-region", type=int, default=6,
                         help="Minimum connected wall-cell count to keep (default: 6)")
    parser.add_argument("--no-seal", dest="do_seal", action="store_false",
                         help="Disable sealing the outer border as a wall")
    parser.add_argument("--keep-all-components", dest="keep_largest_only", action="store_false",
                         help="Keep every wall blob instead of only the single largest "
                              "connected one. The default (largest-only) is what removes "
                              "room-label text/furniture icons, but also drops any "
                              "genuinely disconnected wall structure (e.g. a detached "
                              "garage) -- use this flag if your building has that.")
    args = parser.parse_args()

    convert(args.image, args.out, args.cols, args.fill, args.width_metres,
            args.wall_height, args.dpi, args.invert, args.do_close, args.min_region,
            args.do_seal, args.keep_largest_only)


if __name__ == "__main__":
    main()
