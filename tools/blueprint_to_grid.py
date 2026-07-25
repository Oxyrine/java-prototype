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

# Calibrated against two real conversions (see convert()'s sanity check): a real
# apartment plan needed 3 doorway openings / 1.6% of its interior; a section/elevation
# view mistakenly uploaded in its place needed 11 openings / 10.2%. These sit well
# above the real case and well below the bad one.
MAX_DOORWAY_OPENINGS = 8
MAX_DOOR_CELL_FRACTION = 0.05


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
# Stage 6c: prune isolated wall-cell tips -- 1-pixel rasterization noise near a
# wall's corner (a slightly non-straight edge in the source image) that survives
# keep_largest_wall_component because it's 8-connected to the real wall, even
# though structurally it's not part of it. A tip has at most one 4-connected wall
# neighbour; a real wall segment's interior cells always have two (one on each
# side along the wall), so this can only ever trim the last cell off a genuine
# wall's end, never break a wall in the middle. Confirmed blocking real movement
# when one such tip landed right at a doorway corner (see conversation) --
# player collision uses the actual grid cells, not just doorway "width on paper".
# ---------------------------------------------------------------------------

def prune_wall_tips(wall_mask: np.ndarray) -> np.ndarray:
    rows, cols = wall_mask.shape
    pruned = wall_mask.copy()
    for r in range(rows):
        for c in range(cols):
            if not wall_mask[r, c]:
                continue
            degree = sum(
                1 for dr, dc in _NEIGHBORS_4
                if 0 <= r + dr < rows and 0 <= c + dc < cols and wall_mask[r + dr, c + dc]
            )
            if degree <= 1:
                pruned[r, c] = False
    return pruned


# ---------------------------------------------------------------------------
# Stage 7: seal the border so the player can't walk out into the void.
#
# Fills every floor cell OUTSIDE the building -- the whole margin between the
# exterior wall and the grid edge, not just the outermost ring -- as wall.
# Walling only the outer ring leaves that margin as walkable floor, and once
# the border itself is wall, outside_mask can no longer tell that margin apart
# from a real room (its BFS seeds from border floor, and there isn't any left):
# it would get counted as a genuine disconnected "room" and wrongly fail
# reachability. Filling the whole region removes it instead of just fencing it,
# so there is nothing left for that ambiguity to happen to.
# ---------------------------------------------------------------------------

def seal_border(mask: np.ndarray) -> np.ndarray:
    return mask | outside_mask(mask)


# ---------------------------------------------------------------------------
# Stage 7b: separate "outside the building" from "interior room" floor cells.
#
# A sealed border (Stage 7) makes the whole grid one rectangle, but the ring of
# floor between the building's exterior wall and that border is still FLOOR --
# and on a real plan it is very often the single largest connected floor region,
# larger than any room. Anything downstream that just picks "largest floor
# region" (spawn placement, reachability) silently picks that outside ring
# instead of a room. Flood-fill floor cells inward from the grid border to find
# it; everything else floor-shaped is genuine interior.
# ---------------------------------------------------------------------------

def outside_mask(wall_mask: np.ndarray) -> np.ndarray:
    rows, cols = wall_mask.shape
    outside = np.zeros_like(wall_mask)
    queue = deque()
    for r in range(rows):
        for c in (0, cols - 1):
            if not wall_mask[r, c] and not outside[r, c]:
                outside[r, c] = True
                queue.append((r, c))
    for c in range(cols):
        for r in (0, rows - 1):
            if not wall_mask[r, c] and not outside[r, c]:
                outside[r, c] = True
                queue.append((r, c))

    while queue:
        r, c = queue.popleft()
        for dr, dc in _NEIGHBORS_4:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and not wall_mask[nr, nc] and not outside[nr, nc]:
                outside[nr, nc] = True
                queue.append((nr, nc))

    return outside


# ---------------------------------------------------------------------------
# Stage 7c: carve doorways until every interior room connects.
#
# At real-photo resolution (a few px/cell), door swing-arc ink and wall ink
# threshold identically -- door GAPS don't survive downsampling, so trying to
# preserve them is a losing game. Instead: every room in a dwelling has a door,
# so if the interior comes out split into disconnected regions, a door was
# there and got lost. Detect the split and carve a doorway back in, rather than
# requiring someone to find and hand-patch the gap (which is what kept
# happening before this fix).
#
# Runs on wall_mask BEFORE seal_border, using outside_mask/interior computed
# fresh (seal_border would make the whole grid touch the border and defeat the
# outside/interior distinction this depends on).
# ---------------------------------------------------------------------------

def carve_doorways(wall_mask: np.ndarray, min_room: int, max_thickness: int, door_cells: int):
    """Returns (new_wall_mask, door_cell_set) where door_cell_set is the set of
    (r, c) cells carved open -- Java uses these to place doorway lintels."""
    wall_mask = wall_mask.copy()
    outside = outside_mask(wall_mask)

    # Regions too small to be a room are hollow wall interiors / noise pockets --
    # fill them back in as wall so they don't get treated as rooms to connect.
    interior = ~wall_mask & ~outside
    labels, sizes = connected_components(interior, connectivity=4)
    for label_id, size in enumerate(sizes):
        if size < min_room:
            wall_mask[labels == label_id] = True

    outside = outside_mask(wall_mask)
    interior = ~wall_mask & ~outside
    labels, sizes = connected_components(interior, connectivity=4)
    num_regions = len(sizes)
    if num_regions <= 1:
        return wall_mask, set()

    # A carve is unsafe if it (or its 8-neighbourhood) touches the outside --
    # that would punch a hole straight through the exterior wall instead of
    # connecting two interior rooms.
    unsafe = dilate(outside)

    rows, cols = wall_mask.shape
    candidates = []  # (thickness, region_a, region_b, r, c, dr, dc)
    for r in range(rows):
        for c in range(cols):
            if labels[r, c] < 0:
                continue
            for dr, dc in _NEIGHBORS_4:
                for t in range(1, max_thickness + 1):
                    nr, nc = r + dr * t, c + dc * t
                    if not (0 <= nr < rows and 0 <= nc < cols):
                        break
                    if wall_mask[nr, nc]:
                        continue
                    if labels[nr, nc] >= 0 and labels[nr, nc] != labels[r, c]:
                        candidates.append((t, labels[r, c], labels[nr, nc], r, c, dr, dc))
                    break
    candidates.sort(key=lambda cand: cand[0])

    parent = list(range(num_regions))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    door_cells_set = set()
    half = door_cells // 2
    for thickness, region_a, region_b, r, c, dr, dc in candidates:
        root_a, root_b = find(region_a), find(region_b)
        if root_a == root_b:
            continue
        # Perpendicular direction to widen the doorway across.
        pr, pc = dc, dr
        footprint = [
            (r + dr * t + pr * k, c + dc * t + pc * k)
            for k in range(-half, half + 1)
            for t in range(0, thickness + 1)
        ]
        if any(not (0 <= fr < rows and 0 <= fc < cols) or unsafe[fr, fc] for fr, fc in footprint):
            continue
        parent[root_a] = root_b
        for fr, fc in footprint:
            wall_mask[fr, fc] = False
            door_cells_set.add((fr, fc))

    # Regularize into clean rectangles. When a too-small doorway remnant gets filled
    # back in as noise (the min_room step above) and carve_doorways has to invent a
    # fresh opening right next to it, the result is two adjacent carves of different
    # sizes -- fine for connectivity, but it renders as a lumpy, stepped opening/lintel
    # instead of a clean doorframe. Snap each carved patch to its own bounding box,
    # but ONLY when that box's shorter side still fits within a real doorway's depth
    # (max_thickness+1): a shorter side bigger than that means this component is
    # actually a fusion of two carves from unrelated crossings (not stepped pieces of
    # the same doorway), and boxing it would inflate a shallow opening into a deep,
    # unrealistic tunnel -- worse than just leaving the original stepped shape.
    door_mask = np.zeros_like(wall_mask)
    for r, c in door_cells_set:
        door_mask[r, c] = True
    door_labels, door_sizes = connected_components(door_mask, connectivity=8)
    for label_id in range(len(door_sizes)):
        rs, cs = np.where(door_labels == label_id)
        r0, r1, c0, c1 = int(rs.min()), int(rs.max()), int(cs.min()), int(cs.max())
        if min(r1 - r0 + 1, c1 - c0 + 1) > max_thickness + 1:
            continue
        box_cells = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
        if any(unsafe[r, c] for r, c in box_cells):
            continue
        for r, c in box_cells:
            wall_mask[r, c] = False
            door_cells_set.add((r, c))

    return wall_mask, door_cells_set


# ---------------------------------------------------------------------------
# Stage 8: auto-place spawn -- largest connected INTERIOR region, cell furthest
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
    """Returns ((spawn_row, spawn_col), reachable_fraction). Candidates are
    restricted to INTERIOR floor (excludes the outside ring between the
    building and the sealed border) -- otherwise the largest floor region is
    often that outside ring, not a room, and spawn lands outside the building."""
    outside = outside_mask(wall_mask)
    interior = ~wall_mask & ~outside
    labels, sizes = connected_components(interior, connectivity=4)

    if not sizes:
        raise ValueError(
            "No interior floor cells at all -- the entire grid came out solid or is "
            "all 'outside'. The image is probably too dark/noisy for the current "
            "--fill threshold; try raising --fill or check --invert.")

    largest_label = int(np.argmax(sizes))
    largest_size = sizes[largest_label]
    total_interior = int(interior.sum())

    dist = distance_from_walls(wall_mask)
    candidate_mask = labels == largest_label
    dist_masked = np.where(candidate_mask, dist, -1)
    spawn_rc = np.unravel_index(np.argmax(dist_masked), dist_masked.shape)

    reachable_fraction = largest_size / total_interior
    return (int(spawn_rc[0]), int(spawn_rc[1])), reachable_fraction


# ---------------------------------------------------------------------------
# Stage 9: write grid text + overlay PNG
# ---------------------------------------------------------------------------

def write_grid(wall_mask: np.ndarray, spawn_rc, door_cells: set, out_path: Path, header_lines):
    rows, cols = wall_mask.shape
    lines = list(header_lines)
    for r in range(rows):
        chars = []
        for c in range(cols):
            if (r, c) == spawn_rc:
                chars.append("2")
            elif (r, c) in door_cells:
                chars.append("3")
            elif wall_mask[r, c]:
                chars.append("1")
            else:
                chars.append("0")
        lines.append("".join(chars))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_overlay(wall_mask: np.ndarray, spawn_rc, door_cells: set, cropped_img: Image.Image,
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

    for r, c in door_cells:
        draw.rectangle(
            [col_edges[c], row_edges[r], col_edges[c + 1] - 1, row_edges[r + 1] - 1],
            fill=(0, 120, 255, 150))

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

def convert(image_path: Path, out_name: str, cols, fill: float, width_metres: float,
            wall_height: float, dpi: int, invert: bool, min_region: int,
            do_seal: bool, keep_largest_only: bool):
    img = load_image(image_path, dpi)
    ink = binarize(img, invert)
    ink_cropped, img_cropped = autocrop(ink, img)

    # Auto-select grid resolution from the source image's cropped width when the
    # caller doesn't pin one: too few columns on a high-res plan wastes real detail,
    # too many on a thumbnail just upsamples noise. 96-160 is the range measured to
    # actually work (see plan) -- below 96 loses doorway/wall detail even on a tiny source.
    cropped_width_px = ink_cropped.shape[1]
    if cols is None:
        cols = int(np.clip(round(cropped_width_px / 8), 96, 160))
    px_per_cell = cropped_width_px / cols
    if px_per_cell < 4:
        print(f"WARNING: source image is only {cropped_width_px}px wide after cropping "
              f"({px_per_cell:.1f}px/cell at {cols} columns) -- fine detail like thin "
              "walls and doorways may not resolve cleanly. A higher-resolution source "
              "image will convert more accurately.")

    wall_mask, row_edges, col_edges = downsample_to_grid(ink_cropped, cols, fill)
    rows_actual, cols_actual = wall_mask.shape

    # Closing is always on now: measured on the real test image, closing+carving
    # reaches 100% reachability at every resolution while closing-off is worse at
    # every resolution -- there's no longer a real case for disabling it.
    wall_mask = morphological_close(wall_mask)
    wall_mask = remove_small_blobs(wall_mask, min_region)

    if keep_largest_only:
        wall_mask = keep_largest_wall_component(wall_mask)

    wall_mask = prune_wall_tips(wall_mask)

    cell_size = width_metres / cols_actual
    # A nominal "0.9m door" isn't enough clearance in practice: main.js's collides()
    # rounds each cell test rather than doing continuous overlap, and carve_doorways'
    # own safety guards (exterior guard, regularization skip) can shrink the actually-
    # achieved opening below what was requested. Measured (see conversation): a 7-cell
    # (0.875m) door left a truly-clear center path barely wider than the player's own
    # collision box -- confirmed causing real stuck-at-the-doorway collisions, not
    # just a cosmetic tight squeeze. Size the door around the player's own radius
    # (mirrors PLAYER_RADIUS in web/main.js) plus a full metre of margin, rather than
    # a bare real-world minimum that assumes perfect, lossless carving.
    # The +1.0m version above still measured as "stuck" in direct hands-on testing
    # despite passing every simulation (BFS reachability, per-frame movement at a
    # range of approach angles) -- the discrepancy wasn't pinned down, so rather
    # than keep tuning a narrow margin against a mismatch between simulation and
    # the real browser, go wide enough that no plausible remaining subtlety
    # (rounding, approach angle, corner deadlock) can matter.
    player_radius = min(0.25, cell_size * 1.5)
    door_metres = max(1.2, player_radius * 2 + 1.5)
    door_cells_wide = max(3, round(door_metres / cell_size))
    # Real interior walls run ~0.1-0.3m thick. This bounds how deep a "doorway" is
    # allowed to tunnel: cols_actual // 12 (the old value) scaled up to 8+ cells / 1m+
    # on a 96-col grid, letting the carver burrow through an entire solid block (a
    # stairwell, a merged furniture blob) and call it a doorway -- exactly the deep,
    # narrow tunnel reported when walking through one. Measured: capping to a real
    # wall's thickness still reaches 100% reachability on the test image, so that
    # extra depth was never actually needed for connectivity.
    max_thickness = max(2, round(0.3 / cell_size))
    min_room = max(8, cols_actual // 4)
    wall_mask, door_cells = carve_doorways(wall_mask, min_room, max_thickness, door_cells_wide)

    # Sanity check: carve_doorways exists to bridge the handful of real doorways a
    # dwelling has (measured: a real apartment plan needs ~3 openings, ~1.6% of the
    # interior). If it had to carve far more than that, the input almost certainly
    # isn't a clean top-down plan -- most likely a section/elevation view, where thick
    # hatching for floors/roof/foundation reads as wall almost everywhere and shatters
    # the interior into dozens of disconnected pixels (measured on a real section
    # image: 11 openings, 10.2%). Fail loudly here instead of silently building a level
    # nobody can meaningfully walk.
    door_mask = np.zeros_like(wall_mask)
    for r, c in door_cells:
        door_mask[r, c] = True
    _, door_opening_sizes = connected_components(door_mask, connectivity=8)
    interior_cell_count = int((~wall_mask & ~outside_mask(wall_mask)).sum())
    door_fraction = len(door_cells) / max(interior_cell_count, 1)
    if len(door_opening_sizes) > MAX_DOORWAY_OPENINGS or door_fraction > MAX_DOOR_CELL_FRACTION:
        raise ValueError(
            f"This doesn't look like a clean top-down floor plan: the converter needed "
            f"to carve {len(door_opening_sizes)} separate doorway openings "
            f"({door_fraction * 100:.0f}% of the interior) to reconnect regions that came "
            "out disconnected -- a real floor plan needs a handful, not this many. This "
            "usually means the image is a section/elevation view, a very noisy scan, or "
            "otherwise not a clean top-down plan. Upload a top-down floor plan instead.")

    if do_seal:
        wall_mask = seal_border(wall_mask)

    spawn_rc, reachable_fraction = place_spawn(wall_mask)

    blueprints_dir = Path("blueprints")
    out_txt = blueprints_dir / f"{out_name}.txt"
    out_overlay = blueprints_dir / f"{out_name}.overlay.png"

    header = [
        f"# generated by blueprint_to_grid.py from {image_path.name}",
        f"# cols={cols_actual} rows={rows_actual} fill={fill} cellSize={cell_size:.4f} wallHeight={wall_height}",
    ]
    write_grid(wall_mask, spawn_rc, door_cells, out_txt, header)
    write_overlay(wall_mask, spawn_rc, door_cells, img_cropped, row_edges, col_edges, out_overlay)

    wall_count = int(wall_mask.sum())
    print(f"Grid: {cols_actual}x{rows_actual}  walls={wall_count}  doors={len(door_cells)}  "
          f"spawn=row{spawn_rc[0]},col{spawn_rc[1]}")
    print(f"cellSize = {width_metres} / {cols_actual} = {cell_size:.4f} m/cell")
    print(f"Reachable interior floor from spawn: {reachable_fraction * 100:.1f}%")
    if reachable_fraction < 0.999:
        print("WARNING: not all interior floor is reachable from the spawn point -- "
              f"a room is still isolated. Check {out_overlay}")
    print(f"Wrote {out_txt}")
    print(f"Wrote {out_overlay}  (walls red, carved doorways blue, spawn green -- inspect this)")

    return out_txt, cell_size, wall_height, reachable_fraction, wall_count


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="Input blueprint image (PNG/JPG/PDF)")
    parser.add_argument("--out", default="house", help="Output base name (default: house)")
    parser.add_argument("--cols", type=int, default=None,
                         help="Grid columns (default: auto-selected from source image "
                              "resolution, clamped to 96-160)")
    parser.add_argument("--fill", type=float, default=0.12,
                         help="Ink-fraction threshold per cell to count as a wall (default: 0.12)")
    parser.add_argument("--width-metres", type=float, default=12.0,
                         help="Real-world building width in metres (default: 12.0)")
    parser.add_argument("--wall-height", type=float, default=2.5,
                         help="Wall height in metres, passed through for Java (default: 2.5)")
    parser.add_argument("--dpi", type=int, default=200, help="PDF render DPI (default: 200)")
    parser.add_argument("--invert", action="store_true",
                         help="Set if the plan is light lines on a dark background")
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
            args.wall_height, args.dpi, args.invert, args.min_region,
            args.do_seal, args.keep_largest_only)


if __name__ == "__main__":
    main()
