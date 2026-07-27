"""
Converts an architectural floor-plan image (PNG/JPG/PDF) into the same 1/0/2 text grid
format that BlueprintReader.java already reads. See the plan for the full pipeline
rationale; summary of stages:

  load -> downscale to a working width -> grayscale -> Otsu binarize ->
  OPENING by stroke thickness (deletes swing arcs, furniture, text, mullions; keeps
  walls) -> auto-crop to ink -> downsample to grid by ink-FRACTION per cell ->
  detect openings (gaps in wall lines) and split them into windows vs doorways ->
  morphological close / blob cleanup on a re-sealed mask -> carve doorways (now only
  a fallback) -> seal border -> auto-place spawn (largest floor region, cell furthest
  from any wall) -> write <name>.txt + <name>.overlay.png

Grid characters: 1 wall, 0 floor, 2 spawn, 3 doorway, 4 window (solid but transparent).

The opening stage is the one that makes doorways land where the drawing puts them.
Walls are drawn as thick filled bars and everything else -- swing arcs, door leaves,
furniture, fixtures, labels, dimension lines, window mullions -- as thin strokes, so
deleting thin strokes leaves real openings as literal holes in the wall lines. Before
it existed, a door's swing arc sealed its own doorway shut and carve_doorways punched
replacement holes wherever it could find a thin wall.

The overlay PNG (walls red, doorways blue, windows yellow, spawn green) is the main
tuning tool: run this, look at the overlay, adjust --stroke or --fill, re-run.
"""
import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# Calibrated against three real conversions (see convert()'s sanity check): a simple
# 3-room apartment plan needed 3 doorway openings / 1.6% of its interior; a genuinely
# complex real unit (3 bed/2 bath plus walk-in closets, laundry, balcony -- more small
# rooms means more doors relative to a smaller interior even when fully legitimate)
# needed 7 openings / 6%; a section/elevation view mistakenly uploaded in its place
# needed 11 openings / 10.2%. These sit with margin above the legitimate cases and
# below the bad one.
MAX_DOORWAY_OPENINGS = 9
MAX_DOOR_CELL_FRACTION = 0.08

# Everything on an architectural plan except the walls -- door swing arcs, door leaves,
# furniture, plumbing fixtures, room labels, dimension lines, window mullions, closet
# shelving -- is drawn as a THIN stroke. Walls are drawn as thick filled bars. That
# thickness difference is the only reliable way to tell a wall from a symbol, and
# separating them (see opening()) is what makes doorways land where the drawing puts
# them instead of wherever carve_doorways could find a thin spot.
#
# Below this stroke thickness the two are no longer separable: on a ~220px-wide plan a
# wall is 1-2px, thinner than a swing arc on a good scan, so no amount of processing
# recovers the geometry. Refuse rather than build a plausible-looking wrong apartment.
MIN_WALL_STROKE_PX = 4

# Longest protruding wall spur treated as leftover ink rather than architecture. A real
# partition runs between two things; a stub that dead-ends after 20cm is a counter edge or
# a fitting, and once extruded it is a pillar standing in the room for no reason.
STUB_METRES = 0.5

# Processing above this width buys nothing -- walls are already tens of pixels thick --
# and every stage downstream is O(pixels). Also stabilises the stroke estimate, which
# would otherwise report wildly different numbers for the same plan at two scan DPIs.
MAX_WORK_WIDTH = 2000


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
    """Crops to the building, returning (ink, image, bbox). The bbox is returned so the
    caller can crop other full-resolution masks (see convert()'s opened copy) to exactly
    the same window -- both must land on the same grid for their cells to be comparable.

    This must be measured on the UN-opened ink: it locates the building as the largest
    connected ink blob, and opening_by_reconstruction deliberately severs the wall
    network at every door and window, so on the opened mask the largest blob is one
    wall fragment rather than the building.
    """
    y0, y1, x0, x1 = find_main_component_bbox(ink)

    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(ink.shape[1], x1 + pad)
    y1 = min(ink.shape[0], y1 + pad)

    ink_cropped = ink[y0:y1, x0:x1]
    img_cropped = img.crop((x0, y0, x1, y1))
    return ink_cropped, img_cropped, (y0, y1, x0, x1)


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
# Stage 4b: separate walls from symbols by stroke thickness.
#
# This is the stage that fixes doorways. Previously a door's swing arc -- ink
# sitting INSIDE the door opening -- thresholded the same as the wall beside it,
# morphological_close fused the two, and the doorway sealed shut. Every room then
# came out disconnected, and carve_doorways punched replacement openings wherever
# it could find a thin wall, which is how a hole ended up between two bedrooms that
# share no door in the drawing. (blueprints/apartment_demo.txt was hand-patched to
# work around exactly this.) Deleting thin strokes first means the real openings
# survive downsampling on their own and carve_doorways has nothing left to invent.
# ---------------------------------------------------------------------------

def estimate_stroke_px(ink: np.ndarray) -> int:
    """The thickness, in pixels, that walls are drawn at.

    Taken as the 75th percentile of horizontal ink run-lengths. Walls are the longest
    features on the page, so a large share of all scanlines cross one, which puts wall
    thickness in the upper quartile; annotation strokes are short-lived and fill the
    lower one. Runs of 1px are dropped as anti-aliasing fringe and long runs are
    dropped as horizontal walls measured end-on instead of across.

    Measured on the two real sample plans: this returns 12px and 10px, against true
    wall strokes of ~12 and ~10. The MODE is not usable here -- it returns 2px on a
    photographed plan, because JPEG fringing and hatching generate far more 2px runs
    than there are walls, even though the walls dominate total ink.
    """
    limit = max(4, ink.shape[1] // 20)
    lengths = []
    for row in ink:
        padded = np.concatenate(([0], row.astype(np.int8), [0]))
        deltas = np.diff(padded)
        starts = np.flatnonzero(deltas == 1)
        run = np.flatnonzero(deltas == -1) - starts
        run = run[(run >= 2) & (run <= limit)]
        if run.size:
            lengths.append(run)
    return int(np.percentile(np.concatenate(lengths), 75)) if lengths else 0


def opening_by_reconstruction(mask: np.ndarray, radius: int) -> np.ndarray:
    """Deletes every shape thinner than 2*radius+1 px and restores the survivors to
    their ORIGINAL thickness. Reuses the 3x3 dilate/erode above, applied radius times --
    an N-iteration 3x3 pass is an N-radius structuring element.

    The regrow step is constrained to the input mask (geodesic reconstruction) rather
    than being a plain dilation, and that distinction is the whole ballgame. A plain
    erode-then-dilate returns walls at roughly their eroded width, which at grid
    resolution drops whole wall segments below the ink-fraction threshold: measured on
    the Unit C1 plan, that punched the building envelope full of holes and left 75% of
    the grid flooded as 'outside' with no interior floor at all. Regrowing into the
    original ink instead brings every wall back to full width while the symbols -- which
    lost their core entirely and have nothing to regrow from -- stay deleted.

    Symbols that physically touch a wall (a door's swing arc meets the wall at its hinge)
    do creep back radius+2 px from the contact point. That is a few pixels against a
    doorway a hundred wide, so it never re-seals the opening.
    """
    core = mask
    for _ in range(radius):
        core = erode(core)
    out = core
    for _ in range(radius + 2):
        out = dilate(out) & mask
    return out


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
# neighbour. Confirmed blocking real movement when one such tip landed right at
# a doorway corner (see conversation) -- player collision uses the actual grid
# cells, not just doorway "width on paper".
#
# A degree-1 tip alone isn't enough to call it noise, though: at this source
# resolution a long, perfectly real wall commonly lands in a column 1 cell over
# partway down (a "jog") purely from rasterizing a nearly-straight line -- the
# cell right at that jog is ALSO degree-1 in 4-connectivity, but it's not noise,
# it's the wall continuing. Confirmed via a live stuck-position log: pruning
# one of these punched an unintended 1-cell hole into what should have stayed a
# solid wall, combining with the jog's own natural notch into a pinch point a
# player could partially wedge into but not pass through. Distinguish the two:
# a jog has a diagonal wall neighbour continuing roughly opposite the one
# 4-connected neighbour (the wall picking back up one column over); true noise
# doesn't. Only prune when there's no such continuation.
# ---------------------------------------------------------------------------

def prune_wall_tips(wall_mask: np.ndarray) -> np.ndarray:
    rows, cols = wall_mask.shape
    pruned = wall_mask.copy()

    def in_bounds_wall(r, c):
        return 0 <= r < rows and 0 <= c < cols and wall_mask[r, c]

    for r in range(rows):
        for c in range(cols):
            if not wall_mask[r, c]:
                continue
            wall_neighbors = [(dr, dc) for dr, dc in _NEIGHBORS_4 if in_bounds_wall(r + dr, c + dc)]
            if len(wall_neighbors) > 1:
                continue
            if len(wall_neighbors) == 0:
                pruned[r, c] = False
                continue
            ndr, ndc = wall_neighbors[0]
            diag_checks = [(-ndr, -1), (-ndr, 1)] if ndr != 0 else [(-1, -ndc), (1, -ndc)]
            continues_as_jog = any(in_bounds_wall(r + dr, c + dc) for dr, dc in diag_checks)
            if not continues_as_jog:
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
# Stage 7b2: find the openings the drawing actually contains.
#
# The wall mask is built from the raw ink, exactly as it always was, so the building
# envelope stays as solid as it has always been -- that path is load-bearing and every
# attempt to build the envelope from the OPENED ink instead punched it full of holes
# (measured on the Unit C1 plan: 75% of the grid flooded as 'outside', no interior
# floor at all). Opening is used only as a CLASSIFIER: a wall cell that survives
# opening is real wall, and one that doesn't is symbol ink -- a swing arc, a door
# leaf, a window mullion -- that happened to threshold as wall.
#
# A door therefore reads, scanning ALONG its wall, as: real wall, a short stretch of
# symbol ink, real wall. That signature is what this looks for. Scanning ACROSS the
# same wall the run is only a wall thickness and is flanked by floor rather than wall,
# so it does not match -- which is exactly what keeps a swing arc curving out into the
# middle of a room from being mistaken for a doorway.
# ---------------------------------------------------------------------------

def _axis_wall_gaps(wall_mask: np.ndarray, symbol: np.ndarray,
                     min_gap_cells: int, max_gap_cells: int) -> np.ndarray:
    """Row-wise: inside each maximal run of wall cells, mark sub-runs made entirely of
    symbol ink that have real wall on BOTH sides and whose length falls between
    min_gap_cells and max_gap_cells."""
    out = np.zeros_like(wall_mask)
    rows, cols = wall_mask.shape
    for r in range(rows):
        c = 0
        while c < cols:
            if not wall_mask[r, c]:
                c += 1
                continue
            run_start = c
            while c < cols and wall_mask[r, c]:
                c += 1
            run_end = c
            k = run_start
            while k < run_end:
                if not symbol[r, k]:
                    k += 1
                    continue
                gap_start = k
                while k < run_end and symbol[r, k]:
                    k += 1
                # gap_start > run_start and k < run_end mean real wall on either side,
                # within this same wall run -- i.e. a hole punched through a wall line.
                width = k - gap_start
                if (gap_start > run_start and k < run_end
                        and min_gap_cells <= width <= max_gap_cells):
                    out[r, gap_start:k] = True
    return out


def find_wall_gaps(wall_mask: np.ndarray, symbol: np.ndarray,
                    min_gap_cells: int, max_gap_cells: int) -> np.ndarray:
    """Boolean mask of cells where symbol ink is plugging a hole through a wall line.

    min_gap_cells is what keeps the classifier's own noise out of the level. Opening does
    not agree with the raw ink cell-for-cell along a wall's edge, so isolated one- and
    two-cell disagreements appear inside otherwise solid walls; without a floor on the
    width, those became 0.15m 'doorways' complete with lintels. Nothing narrower than a
    person is a door or a window on any real plan.
    """
    return (_axis_wall_gaps(wall_mask, symbol, min_gap_cells, max_gap_cells)
            | _axis_wall_gaps(wall_mask.T, symbol.T, min_gap_cells, max_gap_cells).T)


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

    # A carve is unsafe if it comes within max_thickness of the outside -- a
    # single 1-cell dilation isn't enough of a buffer: a candidate can tunnel
    # up to max_thickness cells deep, so its far end can land at or past the
    # true exterior line while still never touching a 1-cell-wide guard zone.
    # Confirmed on a dense real floor plan (many small rooms packed near the
    # perimeter, max_thickness=4): a 1-cell guard let carving breach the
    # exterior, merging outside_mask with the entire interior afterward.
    # Dilating by max_thickness instead guarantees no candidate's full depth
    # can ever reach true outside.
    unsafe = outside
    for _ in range(max_thickness):
        unsafe = dilate(unsafe)

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
    baseline_outside_count = int(outside.sum())
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

        # The static unsafe buffer above rejects candidates whose OWN footprint
        # comes near the exterior, but not indirect breaches: removing this
        # footprint's wall cells can occasionally open a path to the true
        # outside through geometry the footprint itself never touches (a
        # region that was already just barely short of connecting to outside
        # through a separate, pre-existing thin gap). Confirmed on a dense
        # real floor plan: a static buffer alone still let outside_mask
        # swallow the entire interior after carving. Verify directly instead
        # of guessing at buffer sizes -- tentatively carve, recompute
        # outside_mask, and revert if it grew at all.
        new_cells = [cell for cell in footprint if cell not in door_cells_set]
        for fr, fc in new_cells:
            wall_mask[fr, fc] = False
        if int(outside_mask(wall_mask).sum()) > baseline_outside_count:
            for fr, fc in new_cells:
                wall_mask[fr, fc] = True
            continue

        parent[root_a] = root_b
        door_cells_set.update(new_cells)

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
        # Verify per-cell, not as one all-or-nothing box: rejecting the WHOLE
        # box because one corner of it is risky throws away the many cells
        # that were perfectly safe to fill, which is exactly what leaves a
        # doorway's edge notched/irregular -- confirmed causing a real stuck
        # collision at one such notch (a wall corner right at a doorway
        # threshold). Fill whatever subset is actually safe.
        for r, c in box_cells:
            if wall_mask[r, c] and (r, c) not in door_cells_set and not unsafe[r, c]:
                wall_mask[r, c] = False
                if int(outside_mask(wall_mask).sum()) > baseline_outside_count:
                    wall_mask[r, c] = True
                else:
                    door_cells_set.add((r, c))

    # Absorb 1-2 cell jogs in the walls immediately flanking a doorway -- at this
    # source resolution (a couple px/cell) the same physical wall can land in a
    # different column a few rows apart purely from rasterization noise, not a
    # real architectural step. A carved opening that's wide by design can still
    # end at a threshold where the ORIGINAL, never-carved wall on either side
    # is offset, leaving a pinch point exactly at the transition (confirmed via
    # a live stuck-position log: the doorway itself was clear, but the pre-
    # existing wall one row past its edge sat a couple cells over from where the
    # carve ended). Dilate the final opening by one more cell so it swallows any
    # jog sitting right at its boundary, without touching the exterior guard.
    #
    # Runs a small, FIXED number of passes (2), not to a fixed point: a single
    # dilation only ever looks one cell out from the door cells that existed
    # BEFORE this step started, so a jog that's 2 cells deep (confirmed on a
    # real floor plan -- a doorway threshold where the flanking wall staggered
    # by 2 columns, not just 1) only had its first cell absorbed, leaving the
    # second still pinching. Running to an actual fixed point (loop until
    # nothing new gets absorbed) was tried and rejected: with no depth limit,
    # each newly-absorbed cell creates fresh dilation neighbours to consider
    # next pass, and as long as a cell never touches the true exterior it
    # keeps passing the safety check -- confirmed it will tunnel arbitrarily
    # far through legitimate interior walls between unrelated rooms (7 real
    # doors collapsed into 2 sprawling ones, 87s runtime). Two passes absorbs
    # jogs up to 2 cells deep (everything seen in practice) without that
    # runaway.
    for _ in range(2):
        door_mask = np.zeros_like(wall_mask)
        for r, c in door_cells_set:
            door_mask[r, c] = True
        for r, c in zip(*np.where(dilate(door_mask))):
            if not wall_mask[r, c] or unsafe[r, c]:
                continue
            wall_mask[r, c] = False
            if int(outside_mask(wall_mask).sum()) > baseline_outside_count:
                wall_mask[r, c] = True
                continue
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

def write_grid(wall_mask: np.ndarray, spawn_rc, door_cells: set, window_cells: set,
                void_cells: set, out_path: Path, header_lines):
    rows, cols = wall_mask.shape
    lines = list(header_lines)
    for r in range(rows):
        chars = []
        for c in range(cols):
            # Windows and void are both checked before the wall test because both ARE
            # wall in wall_mask: glass is solid but not opaque, and the void beyond the
            # building is solid but not drawn.
            if (r, c) == spawn_rc:
                chars.append("2")
            elif (r, c) in door_cells:
                chars.append("3")
            elif (r, c) in window_cells:
                chars.append("4")
            elif (r, c) in void_cells:
                chars.append("5")
            elif wall_mask[r, c]:
                chars.append("1")
            else:
                chars.append("0")
        lines.append("".join(chars))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_overlay(wall_mask: np.ndarray, spawn_rc, door_cells: set, window_cells: set,
                   cropped_img: Image.Image, row_edges: np.ndarray, col_edges: np.ndarray,
                   out_path: Path):
    rows, cols = wall_mask.shape
    base = cropped_img.convert("RGBA")
    tint = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(tint)

    def fill_cell(r, c, color):
        draw.rectangle(
            [col_edges[c], row_edges[r], col_edges[c + 1] - 1, row_edges[r + 1] - 1], fill=color)

    for r in range(rows):
        for c in range(cols):
            if wall_mask[r, c]:
                fill_cell(r, c, (255, 0, 0, 110))

    for r, c in door_cells:
        fill_cell(r, c, (0, 120, 255, 150))

    # Yellow, so a misdetected window is obvious against the blue doorways -- the two
    # failure modes look identical in the grid text but completely different in 3D.
    for r, c in window_cells:
        fill_cell(r, c, (255, 220, 0, 170))

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
            do_seal: bool, keep_largest_only: bool, stroke=None):
    img = load_image(image_path, dpi)
    if img.width > MAX_WORK_WIDTH:
        img = img.resize((MAX_WORK_WIDTH, round(img.height * MAX_WORK_WIDTH / img.width)),
                          Image.LANCZOS)

    ink_raw = binarize(img, invert)

    stroke_px = stroke if stroke is not None else estimate_stroke_px(ink_raw)
    if stroke_px < MIN_WALL_STROKE_PX:
        raise ValueError(
            f"This image is too low-resolution to convert accurately: its walls are drawn "
            f"only ~{stroke_px}px thick, which is too thin to tell apart from door swing "
            "arcs and furniture symbols. Upload a floor plan at least ~1000px wide -- the "
            "original PDF, or a full-size screenshot rather than a thumbnail.")

    # Opening deletes anything thinner than 2*radius+1, so radius has to clear half the
    # thickest symbol stroke while staying under half a wall's. A third of the wall
    # thickness sits comfortably between the two on every plan measured here (walls
    # ~10px, arcs ~3px). Capped so a very large scan doesn't erode genuine thin
    # partitions, and floored at 1 so this stage always does something.
    radius = int(np.clip(round(stroke_px / 3), 1, 8))
    ink_solid = opening_by_reconstruction(ink_raw, radius)
    if not ink_solid.any():
        raise ValueError(
            f"Stripping symbol strokes (estimated wall thickness {stroke_px}px) erased the "
            "whole drawing, meaning no wall was drawn thicker than the annotations. Pass "
            "--stroke to override the estimate, or upload a higher-resolution plan.")

    ink_cropped, img_cropped, bbox = autocrop(ink_raw, img)
    y0, y1, x0, x1 = bbox
    solid_cropped = ink_solid[y0:y1, x0:x1]

    # Auto-select grid resolution from the source image's cropped width when the
    # caller doesn't pin one: too few columns on a high-res plan wastes real detail,
    # too many on a thumbnail just upsamples noise. 96-160 is the range measured to
    # actually work (see plan) -- below 96 loses doorway/wall detail even on a tiny source.
    cropped_width_px = ink_cropped.shape[1]
    if cols is None:
        cols = int(np.clip(round(cropped_width_px / 8), 96, 160))

    wall_mask, row_edges, col_edges = downsample_to_grid(ink_cropped, cols, fill)
    wall_solid, _, _ = downsample_to_grid(solid_cropped, cols, fill)
    raw_mask = wall_mask.copy()  # before closing/pruning, to tell real ink from invented cells
    rows_actual, cols_actual = wall_mask.shape
    cell_size = width_metres / cols_actual

    # Closing is always on now: measured on the real test image, closing+carving
    # reaches 100% reachability at every resolution while closing-off is worse at
    # every resolution -- there's no longer a real case for disabling it.
    wall_mask = morphological_close(wall_mask)
    wall_mask = remove_small_blobs(wall_mask, min_region)

    if keep_largest_only:
        wall_mask = keep_largest_wall_component(wall_mask)

    wall_mask = prune_wall_tips(wall_mask)

    # Wall cells with no counterpart in the opened mask are symbol ink, not wall.
    symbol = wall_mask & ~wall_solid
    # Narrowest credible opening is roughly a slim internal door; widest is a patio slider.
    min_gap_cells = max(3, round(0.55 / cell_size))
    max_gap_cells = max(min_gap_cells + 1, round(2.6 / cell_size))
    openings = find_wall_gaps(wall_mask, symbol, min_gap_cells, max_gap_cells)

    # Symbol ink that isn't plugging a doorway is furniture, a fixture, a fitting -- drawn
    # ON the floor, not built on it. Left standing it extrudes to full height, so a kitchen
    # counter run and its hob become 2.5m walls and the flat reads as a maze of slabs.
    #
    # Deleting all of it at once does not work: reachability fell 100% -> 65.7%, because the
    # envelope is deliberately built from RAW ink (opening severs the wall network, see
    # opening_by_reconstruction) and some of what the opening rejected is load-bearing here.
    # So delete it the way this file already decides everything else about the envelope --
    # tentatively, one blob at a time, keeping any blob the outdoors comes through.
    clutter = wall_mask & ~wall_solid & ~openings & raw_mask
    clutter_labels, clutter_sizes = connected_components(clutter, connectivity=8)
    outside_now = int(outside_mask(wall_mask).sum())
    removed_clutter = 0
    for label_id in range(len(clutter_sizes)):
        component = clutter_labels == label_id
        wall_mask[component] = False
        grown = int(outside_mask(wall_mask).sum())
        if grown > outside_now:
            wall_mask[component] = True  # structural after all -- the outdoors got in
        else:
            outside_now = grown
            removed_clutter += int(clutter_sizes[label_id])

    # Whatever survived as a protruding spur is debris too -- a counter edge drawn thick
    # enough to pass for wall, a fitting, a stub of hatching. Extruded to full height it
    # stands in the room as a pillar with no plan behind it, which reads worse than the
    # furniture it came from. prune_wall_tips only ever peels ONE cell, so a 3-cell spur
    # survived every pass; run it repeatedly instead.
    #
    # A spur is a dead end, so removing it cannot open the envelope -- it encloses nothing.
    # Bounded rather than run to convergence, because convergence would happily eat a
    # genuinely dangling wall cell by cell all the way back to its root.
    # Never prune a doorway's jamb. The pier between two openings is short and dead-ends
    # by nature, so it looks exactly like debris -- but pruning it leaves the door leaf
    # hinged on nothing, hanging in the room next to the hole it was supposed to fill.
    jambs = dilate(openings) & wall_mask
    stub_passes = max(1, round(STUB_METRES / cell_size))
    for _ in range(stub_passes):
        pruned = prune_wall_tips(wall_mask) | jambs
        if np.array_equal(pruned, wall_mask):
            break
        removed_clutter += int(wall_mask.sum() - pruned.sum())
        wall_mask = pruned

    # Classify each opening by asking the question directly rather than by measuring a
    # distance to the exterior: tentatively cut it, and see whether the outdoors gets in.
    # If it does, this opening is in the building envelope -- a window, or a balcony
    # slider, which is glass too -- so put it back and record it as glass. If it doesn't,
    # it is an interior doorway and stays open. Same tentative-then-verify pattern
    # carve_doorways already uses, and for the same reason: a distance heuristic gets the
    # envelope wrong somewhere on every real plan, and one wrong call floods the outdoors
    # through the whole interior and leaves the level with no floor at all.
    #
    # Windows staying solid is deliberate: glass blocks the player, it just isn't opaque.
    baseline_outside = int(outside_mask(wall_mask).sum())
    window_cells, detected_door_cells = set(), set()
    opening_labels, opening_sizes = connected_components(openings, connectivity=8)
    for label_id in range(len(opening_sizes)):
        component = opening_labels == label_id
        cells = set(zip(*(axis.tolist() for axis in np.where(component))))
        wall_mask[component] = False
        if int(outside_mask(wall_mask).sum()) > baseline_outside:
            wall_mask[component] = True
            window_cells |= cells
        else:
            detected_door_cells |= cells
    # Earlier this was blown out to 1.725m ("go wide enough that no plausible
    # remaining subtlety can matter") while chasing doorway-stuck reports that
    # turned out to be collision bugs in main.js's collides() (asymmetric
    # rounding, exact-boundary epsilon, wall-jog holes) -- all now fixed. door_cells
    # also sets carve_doorways' perpendicular widening (half = door_cells // 2), so
    # an oversized metres value doesn't just make a wide door: on a wall shared by
    # two rooms it sweeps that width along the wall itself, carving a many-cell-long
    # slot instead of a door (confirmed on a real upload at cell_size=0.075m: a
    # 23-cell request produced a 25-row-tall carved strip). Back to a real single-door
    # width, still with margin over the player.
    player_radius = min(0.25, cell_size * 1.5)
    door_metres = max(0.9, player_radius * 2 + 0.4)
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
    wall_mask, carved_cells = carve_doorways(wall_mask, min_room, max_thickness, door_cells_wide)
    door_cells = detected_door_cells | carved_cells
    window_cells -= carved_cells  # a carve through glass makes it a doorway, not a window

    # Sanity check, now measured on what carve_doorways had to INVENT rather than on
    # every doorway in the level. Openings detected from the drawing are legitimate and
    # a real plan has a dozen or more of them, so counting those here would fail every
    # honest apartment. Carving, though, only happens when detection missed something:
    # near zero means the drawing was read correctly, and a large number means the input
    # almost certainly isn't a clean top-down plan -- most likely a section/elevation
    # view, where thick hatching for floors/roof/foundation reads as wall almost
    # everywhere and shatters the interior into dozens of disconnected pixels (measured
    # on a real section image: 11 openings, 10.2%). Fail loudly rather than silently
    # building a level nobody can meaningfully walk.
    carved_mask = np.zeros_like(wall_mask)
    for r, c in carved_cells:
        carved_mask[r, c] = True
    _, carved_opening_sizes = connected_components(carved_mask, connectivity=8)
    interior_cell_count = int((~wall_mask & ~outside_mask(wall_mask)).sum())
    carved_fraction = len(carved_cells) / max(interior_cell_count, 1)
    if len(carved_opening_sizes) > MAX_DOORWAY_OPENINGS or carved_fraction > MAX_DOOR_CELL_FRACTION:
        raise ValueError(
            f"This doesn't look like a clean top-down floor plan: after reading the "
            f"drawing's own doors, the converter still had to carve "
            f"{len(carved_opening_sizes)} extra openings ({carved_fraction * 100:.0f}% of "
            "the interior) to reconnect regions that came out disconnected -- a real floor "
            "plan needs none, or a handful at most. This usually means the image is a "
            "section/elevation view, a very noisy scan, or otherwise not a clean top-down "
            "plan. Upload a top-down floor plan instead.")

    # The region seal_border is about to fill is the void beyond the building, not
    # architecture. It has to stay SOLID so the player can never walk out into nothing,
    # but drawing it means every window looks onto a blank wall standing centimetres
    # away -- which defeats the entire point of detecting windows. Record it as '5':
    # solid to collision, invisible to the renderer, so a window shows sky.
    void_cells = set()
    if do_seal:
        void_cells = set(zip(*(axis.tolist() for axis in np.where(outside_mask(wall_mask)))))
        wall_mask = seal_border(wall_mask)

    spawn_rc, reachable_fraction = place_spawn(wall_mask)

    blueprints_dir = Path("blueprints")
    out_txt = blueprints_dir / f"{out_name}.txt"
    out_overlay = blueprints_dir / f"{out_name}.overlay.png"

    header = [
        f"# generated by blueprint_to_grid.py from {image_path.name}",
        f"# cols={cols_actual} rows={rows_actual} fill={fill} cellSize={cell_size:.4f} wallHeight={wall_height}",
    ]
    write_grid(wall_mask, spawn_rc, door_cells, window_cells, void_cells, out_txt, header)
    write_overlay(wall_mask, spawn_rc, door_cells, window_cells, img_cropped,
                   row_edges, col_edges, out_overlay)

    wall_count = int(wall_mask.sum())
    print(f"Grid: {cols_actual}x{rows_actual}  walls={wall_count}  "
          f"doors={len(door_cells)} (carved {len(carved_cells)})  windows={len(window_cells)}  "
          f"furniture dropped={removed_clutter}  spawn=row{spawn_rc[0]},col{spawn_rc[1]}")
    print(f"Wall stroke measured at {stroke_px}px -> opening radius {radius}")
    print(f"cellSize = {width_metres} / {cols_actual} = {cell_size:.4f} m/cell")
    # The single most common way to get a bizarre-looking walkthrough is an honest typo
    # here: architectural drawings are dimensioned in millimetres, and every room, doorway
    # and ceiling scales off this one number. Printing the resulting footprint lets it be
    # checked against the dimensions printed on the plan in about two seconds.
    print(f"Footprint: {cols_actual * cell_size:.1f} x {rows_actual * cell_size:.1f} m -- "
          "compare against the plan's printed dimensions; re-run with a corrected "
          "--width-metres if this is off.")
    print(f"Reachable interior floor from spawn: {reachable_fraction * 100:.1f}%")
    if reachable_fraction < 0.999:
        print("WARNING: not all interior floor is reachable from the spawn point -- "
              f"a room is still isolated. Check {out_overlay}")
    print(f"Wrote {out_txt}")
    print(f"Wrote {out_overlay}  (walls red, doorways blue, windows yellow, "
          "spawn green -- inspect this)")

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
    parser.add_argument("--stroke", type=int, default=None,
                         help="Wall stroke thickness in pixels, overriding the automatic "
                              "estimate. Raise it if symbols (swing arcs, furniture) are "
                              "surviving as walls; lower it if real walls are vanishing. "
                              "Check the overlay PNG after changing this.")
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
            args.do_seal, args.keep_largest_only, args.stroke)


if __name__ == "__main__":
    main()
